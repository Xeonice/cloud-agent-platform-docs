import * as fs from 'node:fs/promises';
import { join, resolve, isAbsolute, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { command } from '../../deploy/upgrade/artifacts.mjs';
import { secureDirectory, atomicJson, readJson, inside } from '../../deploy/upgrade/io.mjs';
import { invariant, digest } from '../../deploy/upgrade/trust.mjs';

const IMAGE = /^sha256:[a-f0-9]{64}$/;
const LOOP = /^\/dev\/loop[0-9]+$/;
const MIN_BYTES = 1024 * 1024 * 1024;
const MAX_BYTES = 2 * MIN_BYTES;

/** A test administrator's private filesystem, never an application permission.
 * Docker roles see the Host mount; the runner sees the same owned loop device
 * in its own namespace. A runner-only mount cannot qualify a disk fault. */
export const createInstallerFilesystem = input => createDedicatedFilesystem(input, 'installer');
export const createBusinessDatabaseFilesystem = input => createDedicatedFilesystem(input, 'business-db');

/** The only optional database layout: an installation-owned DB leaf, not an arbitrary path. */
export function qualificationBusinessDatabasePath(input) {
  const ordinary = join(input.root, 'business/platform.sqlite');
  if (!input.businessDatabaseFilesystemEvidence) {
    invariant(input.businessDatabasePath === undefined || input.businessDatabasePath === ordinary, 'QUALIFICATION_DB_PATH_SCOPE_MISMATCH');
    return ordinary;
  }
  const proof = input.businessDatabaseFilesystemEvidence, directory = join(input.root, 'business/db');
  invariant(input.isolated === true && input.docker?.dedicated === true &&
    proof.instanceId === input.instanceId && proof.kind === 'independent-business-db-filesystem' && proof.qualified === true &&
    proof.mountpoint === directory && proof.filesystem?.type === 0xef53 &&
    Number.isSafeInteger(proof.filesystem.dev) && proof.filesystem.dev !== proof.sharedParentDev &&
    input.businessDatabasePath === join(directory, 'platform.sqlite'), 'QUALIFICATION_DB_PATH_SCOPE_MISMATCH');
  return input.businessDatabasePath;
}

export async function verifyQualificationBusinessDatabaseFilesystem(input) {
  const path = qualificationBusinessDatabasePath(input);
  if (!input.businessDatabaseFilesystemEvidence) return path;
  const directory = resolve(path, '..'), physical = await fs.lstat(directory), root = await fs.stat(input.root),
    actual = await fs.statfs(directory), proof = input.businessDatabaseFilesystemEvidence;
  invariant(physical.isDirectory() && !physical.isSymbolicLink() && await fs.realpath(directory) === directory &&
    physical.dev === proof.filesystem.dev && root.dev === proof.sharedParentDev && actual.type === 0xef53 &&
    actual.blocks * actual.bsize === proof.filesystem.totalBytes, 'QUALIFICATION_DB_FILESYSTEM_CHANGED');
  return path;
}

async function createDedicatedFilesystem(input, purpose) {
  const database = purpose === 'business-db';
  const spec = database ? input.businessDatabaseFilesystem : input.installerFilesystem;
  const label = database ? 'business-database' : 'installer';
  invariant(input.isolated === true && input.docker?.dedicated === true &&
    process.platform === 'linux' && process.arch === 'arm64' &&
    /^upgrade-acceptance-[a-zA-Z0-9._-]+$/.test(input.instanceId), 'ISOLATED_FILESYSTEM_ADMIN_REQUIRED');
  invariant(spec && Object.keys(spec).every(k => ['kind', 'bytes', 'managerImage'].includes(k)) &&
    spec.kind === 'loop-ext4' && Number.isSafeInteger(spec.bytes) &&
    spec.bytes >= MIN_BYTES && spec.bytes <= MAX_BYTES && IMAGE.test(spec.managerImage), 'FIXED_INSTALLER_FILESYSTEM_REQUIRED');
  invariant(isAbsolute(input.root) && resolve(input.root) === input.root && /^\/tmp\/upg-qa-[a-z0-9-]+-work\//.test(input.root) &&
    !input.root.includes(',') && Array.isArray(input.docker.args) &&
    input.docker.args.every(v => typeof v === 'string' && !/[\r\n]/.test(v)), 'DEDICATED_QA_FILESYSTEM_ROOT_REQUIRED');
  const root = await secureDirectory(input.root), mountpoint = await secureDirectory(join(root, database ? 'business/db' : 'installer'));
  invariant((await fs.readdir(mountpoint)).length === 0, 'FRESH_INSTALLER_FILESYSTEM_REQUIRED');
  const backing = join(root, label + '-filesystem.ext4'), journal = join(root, label + '-filesystem.json');
  invariant(!(await fs.lstat(backing).catch(() => null)) && !(await fs.lstat(journal).catch(() => null)), 'FILESYSTEM_ATTEMPT_ALREADY_CREATED');
  const before = await fs.statfs(root), parent = await fs.stat(root);
  invariant(before.bavail * before.bsize >= spec.bytes + MIN_BYTES, 'SHARED_HOST_DISK_RESERVE_REQUIRED');
  const docker = args => command(input.docker.cli || 'docker', [...input.docker.args, ...args]);
  const image = JSON.parse(await docker(['image', 'inspect', spec.managerImage]))[0];
  invariant(image.Id === spec.managerImage && image.Os === 'linux' && image.Architecture === 'arm64', 'FILESYSTEM_MANAGER_IMAGE_NOT_PINNED');
  // Only this privileged fixture administrator enters this dedicated VM's mount
  // namespace. Application/Controller/Owner containers keep their private PIDs.
  const host = args => docker(['run', '--rm', '--privileged', '--pid', 'host', '--network', 'none',
    '--label', 'agent-platform.qualification-filesystem=' + input.instanceId,
    '--entrypoint', '/usr/bin/nsenter', spec.managerImage,
    '--target', '1', '--mount', '--root', '--', ...args]);
  const handle = await fs.open(backing, 'wx', 0o600);
  try { await handle.truncate(spec.bytes); await handle.sync(); } finally { await handle.close(); }
  const backingIdentity = await fs.stat(backing);
  await atomicJson(journal, { schemaVersion: 1, instanceId: input.instanceId, state: 'creating', root, mountpoint, backing,
    backingIdentity: { dev: backingIdentity.dev, ino: backingIdentity.ino }, createdAt: new Date().toISOString() });
  await command('mkfs.ext4', ['-q', '-F', '-m', '0', backing]);
  await host(['/bin/mount', '-o', 'loop,nodev,nosuid', backing, mountpoint]);
  const hostMount = JSON.parse(await host(['/usr/bin/findmnt', '--json', '--target', mountpoint,
    '--output', 'SOURCE,TARGET,FSTYPE,OPTIONS'])).filesystems[0];
  invariant(hostMount?.target === mountpoint && hostMount.fstype === 'ext4' && LOOP.test(hostMount.source), 'EXACT_HOST_LOOP_FILESYSTEM_REQUIRED');
  const loop = JSON.parse(await host(['/usr/sbin/losetup', '--json', '--list', '--output', 'NAME,BACK-FILE', hostMount.source])).loopdevices[0];
  invariant(loop?.name === hostMount.source && loop['back-file'] === backing, 'EXACT_OWNED_LOOP_DEVICE_REQUIRED');
  let runnerMounted = false;
  if ((await fs.stat(mountpoint)).dev === parent.dev) {
    await command('mount', ['-o', 'nodev,nosuid', loop.name, mountpoint]);
    runnerMounted = true;
  }
  const actual = await fs.stat(mountpoint), space = await fs.statfs(mountpoint);
  invariant(actual.dev !== parent.dev && space.type === 0xef53, 'INDEPENDENT_RUNNER_FILESYSTEM_REQUIRED');
  const start = await docker(['run', '--detach', '--network', 'none', '--read-only',
    '--label', 'agent-platform.qualification-filesystem=' + input.instanceId,
    '--mount', 'type=bind,src=' + mountpoint + ',dst=' + mountpoint + ',readonly',
    '--entrypoint', '/usr/local/bin/node', spec.managerImage, '-e', 'setInterval(()=>{},1000)']);
  const containerId = start.trim();
  invariant(/^[a-f0-9]{64}$/.test(containerId), 'FILESYSTEM_PROBE_CONTAINER_UNKNOWN');
  let roleProof;
  try {
    const script = "const fs=require('fs');const p=" + JSON.stringify(mountpoint) +
      ";const s=fs.statSync(p),f=fs.statfsSync(p);process.stdout.write(JSON.stringify({dev:s.dev,type:f.type,availableBytes:f.bavail*f.bsize,totalBytes:f.blocks*f.bsize}));";
    const observed = JSON.parse(await docker(['exec', containerId, 'node', '-e', script]));
    const physical = JSON.parse(await docker(['inspect', containerId]))[0];
    invariant(physical.Id === containerId && physical.Image === spec.managerImage && physical.State.Running === true &&
      physical.HostConfig.PidMode !== 'host' && physical.Mounts.some(m => m.Source === mountpoint && m.Destination === mountpoint && m.RW === false) &&
      observed.dev === actual.dev && observed.type === 0xef53, 'HOST_ROLE_FILESYSTEM_DIFFERS');
    roleProof = { containerId, imageDigest: physical.Image, pidNamespace: physical.HostConfig.PidMode || 'private',
      hostPid: physical.State.Pid, startedAt: physical.State.StartedAt, observed };
  } finally { await docker(['stop', '--timeout', '2', containerId]); }
  const evidence = { schemaVersion: 1, kind: 'independent-' + purpose + '-filesystem', instanceId: input.instanceId,
    qualified: true, mountpoint, backing, loopDevice: loop.name, hostMount, runnerMounted,
    backingIdentity: { dev: backingIdentity.dev, ino: backingIdentity.ino }, sharedParentDev: parent.dev,
    filesystem: { dev: actual.dev, type: space.type, totalBytes: space.blocks * space.bsize, availableBytes: space.bavail * space.bsize },
    roleProof, observedAt: new Date().toISOString() };
  await atomicJson(journal, { ...evidence, state: 'mounted' });
  async function close({ resourcesCleaned = false, businessCleanupReceipt } = {}) {
    if (!resourcesCleaned) return { preserved: true, mounted: true, journal };
    const record = await readJson(journal);
    invariant(record.instanceId === input.instanceId && record.loopDevice === loop.name && record.mountpoint === mountpoint, 'FILESYSTEM_CLEANUP_SCOPE_MISMATCH');
    if (record.state === 'cleaned') return { cleaned: true, journal };
    if (database) {
      const receipt = await readJson(join(root, 'sdk-cache-cleanup.json'), null);
      invariant(receipt?.kind === 'dedicated-qualification-success-sdk-image-cache-cleanup' &&
        receipt.instanceId === input.instanceId && receipt.state === 'cleaned' && receipt.resourcesCleaned === true &&
        businessCleanupReceipt && digest(receipt) === digest(businessCleanupReceipt) &&
        Object.entries(receipt.businessCounts).every(([table, count]) => table === 'agent_task_start_intents' || count === 0) &&
        receipt.actualRoleStops.length > 0 && receipt.actualRoleStops.every(role => role.running === false && role.hostPid === 0),
        'BUSINESS_DATABASE_CLEANUP_PROOF_REQUIRED');
    }
    const identity = await fs.stat(backing);
    invariant(identity.dev === record.backingIdentity.dev && identity.ino === record.backingIdentity.ino &&
      (await fs.stat(mountpoint)).dev === evidence.filesystem.dev, 'FILESYSTEM_PHYSICAL_IDENTITY_CHANGED');
    const ids = (await docker(['ps', '-q'])).trim().split('\n').filter(Boolean);
    const running = ids.length ? JSON.parse(await docker(['inspect', ...ids])) : [];
    invariant(!running.some(c => c.Mounts.some(m => m.Source === mountpoint || inside(mountpoint, m.Source) || (c.Config.Labels?.['agent-platform.role'] && inside(m.Source, mountpoint)))), 'FILESYSTEM_STILL_BOUND_TO_RUNNING_ROLE');
    invariant(!running.some(c => c.Config.Labels?.['agent-platform.instance'] === input.instanceId), 'FILESYSTEM_INSTANCE_ROLE_STILL_RUNNING');
    // Administrator runner/manager parent mounts are not application roles;
    // all application ancestor binds are still blocked. Normal umount must
    // succeed (no lazy/force detach), preserving any unknown live reference.
    const evidenceRoot = await secureDirectory(join(root, label + '-filesystem-evidence'));
    const sealed = [];
    async function preserve(directory) {
      for (const name of (await fs.readdir(directory)).sort()) {
        const path = join(directory, name), stat = await fs.lstat(path), suffix = relative(mountpoint, path);
        if (stat.isDirectory()) {
          // Physical code remains in the externally verified input archive and
          // packageRoot. Keep its installed manifests/receipts, not another copy
          // of every module or temporary downloaded blob.
          if (!database && suffix === 'downloads') continue;
          if (!database && suffix === 'artifacts') {
            for (const artifact of await fs.readdir(path)) {
              const candidate = join(path, artifact);
              if ((await fs.lstat(candidate)).isDirectory()) {
                for (const manifest of ['installed.json', 'upgrade-artifact.json']) {
                  const file = join(candidate, manifest);
                  if ((await fs.lstat(file).catch(() => null))?.isFile()) await preserveFile(file);
                }
              } else if ((await fs.lstat(candidate)).isFile()) await preserveFile(candidate);
            }
            continue;
          }
          await preserve(path);
        } else if (stat.isFile()) await preserveFile(path);
        else invariant(false, 'UNSUPPORTED_INSTALLER_EVIDENCE_FILE');
      }
    }
    async function preserveFile(path) {
      const suffix = relative(mountpoint, path), target = join(evidenceRoot, suffix);
      invariant(inside(mountpoint, path) && inside(evidenceRoot, target), 'INSTALLER_EVIDENCE_PATH_ESCAPE');
      const bytes = await fs.readFile(path);await secureDirectory(resolve(target, '..'));
      const old = await fs.readFile(target).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
      invariant(old === null || old.equals(bytes), 'SEALED_INSTALLER_EVIDENCE_CHANGED');
      if (old === null) await fs.writeFile(target, bytes, { mode: 0o600, flag: 'wx' });
      const sealedFile = await fs.open(target, 'r');try { await sealedFile.sync(); } finally { await sealedFile.close(); }
      sealed.push({ path: suffix, bytes: bytes.length, digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex'), mode: 0o600 });
    }
    const databaseFiles = database ? await Promise.all(['platform.sqlite', 'platform.sqlite-wal', 'platform.sqlite-shm'].map(async name => {
      const file = join(mountpoint, name), stat = await fs.lstat(file).catch(error => {if(error.code === 'ENOENT')return null;throw error;});
      invariant(!stat || stat.isFile() && !stat.isSymbolicLink(), 'BUSINESS_DATABASE_EVIDENCE_UNCONFIRMED');
      return {path:name,present:stat !== null};
    })) : null;
    if(database)invariant(databaseFiles[0].present, 'BUSINESS_DATABASE_EVIDENCE_UNCONFIRMED');
    await preserve(mountpoint);
    await atomicJson(join(evidenceRoot, 'sealed-files.json'), { schemaVersion: 1, instanceId: input.instanceId, originalMountpoint: mountpoint,
      files: sealed, databaseFiles, ...(database?{businessCleanupReceiptDigest:digest(businessCleanupReceipt)}:{}), filesystemProof: evidence, resourcesCleaned: true, observedStoppedContainers: true, recordedAt: new Date().toISOString() });
    if (runnerMounted) await command('umount', [mountpoint]);
    const fresh = JSON.parse(await host(['/usr/bin/findmnt', '--json', '--target', mountpoint,
      '--output', 'SOURCE,TARGET,FSTYPE'])).filesystems[0];
    invariant(fresh?.source === loop.name && fresh.target === mountpoint && fresh.fstype === 'ext4', 'FILESYSTEM_HOST_BINDING_CHANGED');
    await host(['/bin/umount', mountpoint]);
    // mount -o loop uses AUTOCLEAR. A device still attached elsewhere is retained,
    // never detached by an unrelated filesystem cleanup operation.
    const attached = (await host(['/usr/sbin/losetup', '--associated', backing])).trim();
    invariant(attached === '', 'FILESYSTEM_LOOP_STILL_REFERENCED');
    await fs.unlink(backing);await atomicJson(journal, { ...record, state: 'cleaned', evidenceRoot, cleanedAt: new Date().toISOString() });
    return { cleaned: true, journal, evidenceRoot };
  }
  return { evidence, journal, close };
}
