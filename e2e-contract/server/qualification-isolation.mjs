import * as fs from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { command } from '../../deploy/upgrade/artifacts.mjs';
import { canonical, digest, DIGEST, invariant, loadTrustRoot, runInputFingerprint, verifySignedManifest } from '../../deploy/upgrade/trust.mjs';

const INSTANCE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,180}$/;
const SYNTHETIC = /^upgrade-acceptance-[a-zA-Z0-9._-]+$/;
const HOST = 'unix:///run/qualification-docker/docker.sock';
const DATA = '/var/lib/qualification-docker';
const parent = root => /^\/var\/lib\/agent-independent-control-qa-[0-9]+\/instances\/[^/]+$/.test(root ?? '')
  ? dirname(dirname(root)) : null;
const under = (root, path) => typeof path === 'string' && isAbsolute(path) && resolve(path) === path && path.startsWith(root + '/');

export function qualificationInstanceAllowed(input) {
  return SYNTHETIC.test(input.instanceId ?? '') || Boolean(input.sameInstanceQa && INSTANCE.test(input.instanceId ?? '') &&
    parent(input.root) && input.root === join(parent(input.root), 'instances', input.instanceId));
}

/** The alternate identity is permitted only inside the existing private QA
 * daemon. It never changes the signed body, trust domain or production ID. */
export function validateSameInstanceQualification(input, { trustRoot, catalog, daemonInfo, containers }) {
  const fixed = input.sameInstanceQa, base = parent(input.root);
  invariant(input.isolated === true && input.docker?.dedicated === true && base && INSTANCE.test(input.instanceId ?? '') &&
    input.root === join(base, 'instances', input.instanceId), 'SAME_INSTANCE_QA_ROOT_REQUIRED');
  invariant(fixed && Object.keys(fixed).sort().join(',') === 'daemonId,kind,manifestDigest,schemaVersion' &&
    fixed.schemaVersion === 1 && fixed.kind === 'same-signed-instance-isolated-qualification' && DIGEST.test(fixed.manifestDigest) &&
    typeof fixed.daemonId === 'string' && /^[a-zA-Z0-9:_-]{8,128}$/.test(fixed.daemonId), 'SAME_INSTANCE_QA_DESCRIPTOR_REQUIRED');
  invariant(Array.isArray(input.docker.args) && canonical(input.docker.args) === canonical(['--host', HOST]) && daemonInfo?.ID === fixed.daemonId &&
    daemonInfo.DockerRootDir === DATA && daemonInfo.OSType === 'linux', 'SAME_INSTANCE_QA_DAEMON_REQUIRED');
  for (const key of ['initialRoot', 'trustRootPath', 'catalogFile'])
    invariant(under(base, input[key]), 'SAME_INSTANCE_QA_INPUT_SCOPE_REQUIRED');
  for (const key of ['archiveRoot', 'targetRoot', 'controlArtifactRoot', 'controlManifestPath', 'initialManifestPath', 'targetManifestPath', 'qualificationInstallationPath'])
    if (input[key] !== undefined) invariant(under(base, input[key]), 'SAME_INSTANCE_QA_INPUT_SCOPE_REQUIRED');
  invariant(trustRoot?.purpose === 'qualification' && trustRoot.qualificationInstanceId === input.instanceId &&
    catalog?.schemaVersion === 1 && Array.isArray(catalog.releases) && catalog.releases.length > 0 &&
    catalog.releases.length <= 64 && catalog.channel === trustRoot.channel, 'SAME_INSTANCE_QA_TRUST_REQUIRED');
  const matches = [];
  for (const row of catalog.releases) {
    const verified = verifySignedManifest(row.envelope, trustRoot), manifest = verified.manifest;
    invariant(row.releaseId === manifest.releaseId && row.manifestDigest === verified.manifestDigest &&
      manifest.qualification.instanceId === input.instanceId &&
      manifest.qualification.inputFingerprint === runInputFingerprint(manifest), 'SAME_INSTANCE_QA_CATALOG_REQUIRED');
    if (verified.manifestDigest === fixed.manifestDigest) matches.push(manifest);
  }
  invariant(matches.length === 1 && (input.targetManifest === undefined || canonical(input.targetManifest) === canonical(matches[0])),
    'SAME_INSTANCE_QA_SIGNED_TARGET_REQUIRED');
  invariant(Array.isArray(containers) && containers.length <= 256 && new Set(containers.map(row => row.Id)).size === containers.length,
    'SAME_INSTANCE_QA_CONTAINER_CENSUS_REQUIRED');
  for (const row of containers) {
    invariant(/^[a-f0-9]{64}$/.test(row.Id ?? '') && typeof row.Labels?.['agent-platform.instance'] === 'string' &&
      typeof row.Labels?.['agent-platform.installation'] === 'string' && Array.isArray(row.Mounts), 'SAME_INSTANCE_QA_FOREIGN_CONTAINER');
    for (const mount of row.Mounts) invariant(under(base, mount.Source) ||
      mount.Source === '/run/qualification-docker/docker.sock' && mount.Destination === '/var/run/docker.sock',
      'SAME_INSTANCE_QA_FOREIGN_MOUNT');
  }
  return { schemaVersion: 1, kind: 'same-signed-instance-isolated-qualification', instanceId: input.instanceId,
    manifestDigest: fixed.manifestDigest, inputFingerprint: runInputFingerprint(matches[0]), trustRootDigest: digest(trustRoot),
    daemonId: fixed.daemonId, dockerRootDir: DATA, root: input.root, sameSignedBody: true, adoptionAuthorized: false };
}

export async function assertQualificationIsolation(input, { run = command } = {}) {
  invariant(input.isolated === true && qualificationInstanceAllowed(input), 'ISOLATED_INSTANCE_REQUIRED');
  if (input.sameInstanceQa === undefined) return { kind: 'synthetic-qualification-instance', instanceId: input.instanceId };
  invariant(process.platform === 'linux' && process.arch === 'arm64' && Number(process.versions.node.split('.')[0]) === 22,
    'SAME_INSTANCE_QA_NATIVE_REQUIRED');
  // All reads precede any startup intent, role launch, DB or SDK creation.
  const base = parent(input.root);
  invariant(base, 'SAME_INSTANCE_QA_ROOT_REQUIRED');
  for (const path of [base, join(base, 'instances'), ...['initialRoot', 'trustRootPath', 'catalogFile',
    'qualificationInstallationPath', 'archiveRoot', 'targetRoot', 'controlArtifactRoot', 'controlManifestPath', 'initialManifestPath', 'targetManifestPath']
    .flatMap(key => input[key] === undefined ? [] : [input[key]])]) {
    invariant(under(base, path) || path === base, 'SAME_INSTANCE_QA_INPUT_SCOPE_REQUIRED');
    const stat = await fs.lstat(path);
    invariant(!stat.isSymbolicLink() && await fs.realpath(path) === path && (stat.mode & 0o022) === 0 &&
      (!process.getuid || stat.uid === 0 || stat.uid === process.getuid()), 'SAME_INSTANCE_QA_CANONICAL_INPUT_REQUIRED');
  }
  const socket = await fs.lstat('/run/qualification-docker/docker.sock');
  invariant(socket.isSocket() && socket.uid === 0 && await fs.realpath('/run/qualification-docker/docker.sock') === '/run/qualification-docker/docker.sock',
    'SAME_INSTANCE_QA_DAEMON_REQUIRED');
  invariant(input.docker?.dedicated === true && Array.isArray(input.docker.args) && canonical(input.docker.args) === canonical(['--host', HOST]),
    'SAME_INSTANCE_QA_DAEMON_REQUIRED');
  const docker = args => run(input.docker.cli || 'docker', [...input.docker.args, ...args]);
  const daemonInfo = JSON.parse(await docker(['info', '--format', '{"ID":{{json .ID}},"DockerRootDir":{{json .DockerRootDir}},"OSType":{{json .OSType}}}']));
  const ids = (await docker(['ps', '--all', '--quiet', '--no-trunc'])).trim().split('\n').filter(Boolean);
  invariant(ids.length <= 256 && ids.every(id => /^[a-f0-9]{64}$/.test(id)), 'SAME_INSTANCE_QA_CONTAINER_CENSUS_REQUIRED');
  const format = '{"Id":{{json .Id}},"Labels":{"agent-platform.instance":{{json (index .Config.Labels "agent-platform.instance")}},"agent-platform.installation":{{json (index .Config.Labels "agent-platform.installation")}}},"Mounts":{{json .Mounts}}}';
  const containers = ids.length ? (await docker(['inspect', '--format', format, ...ids])).trim().split('\n').map(JSON.parse) : [];
  invariant(canonical(containers.map(row => row.Id).sort()) === canonical([...ids].sort()), 'SAME_INSTANCE_QA_CONTAINER_CENSUS_REQUIRED');
  const proof = validateSameInstanceQualification(input, { trustRoot: await loadTrustRoot(input.trustRootPath),
    catalog: JSON.parse(await fs.readFile(input.catalogFile, 'utf8')), daemonInfo, containers });
  for (const row of containers) for (const mount of row.Mounts)
    invariant(await fs.realpath(mount.Source) === mount.Source, 'SAME_INSTANCE_QA_CANONICAL_MOUNT_REQUIRED');
  return proof;
}
