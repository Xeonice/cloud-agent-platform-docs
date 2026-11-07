import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProductionRoleAdapter } from './production-role-adapter.mjs';
import { digest } from './trust.mjs';

// Real production assembly plus an explicit Docker transport fixture. This
// verifies argv/authority scope; the separate Linux probe proves native reads.
test('only the sampling Supervisor uses host cgroup namespace; all roles keep private PID and dropped capabilities', async t => {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'role-cgroup-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const resources = { memoryBytes: 128 * 1048576, cpuMilliCores: 100, ioBytesPerSecond: 1048576, disks: { data: 0 }, pidsLimit: 512 };
  const c = { root, instanceId: 'namespace-fixture', runtimeImage: 'sha256:' + 'f'.repeat(64), uid: 0, gid: 0, docker: { cli: 'docker', args: [] },
    businessHostPath: join(root, 'business'), controlArtifactRoot: join(root, 'control-code'), controlPrivateRoot: join(root, 'private'), controlLedgerRoot: join(root, 'ledger'),
    controlFoundationRoot: join(root, 'foundation'), controlEntryRoot: join(root, 'entry'), controlEntryWebRoots: [join(root, 'web-code')], controlFutureOwnerRoot: join(root, 'new-owners'),
    existingRuntimeRoots: [join(root, 'original-owner')], capacityStateRoot: join(root, 'capacity'), catalogFile: join(root, 'catalog.json'), trustRootPath: join(root, 'trust.json'),
    procRoot: join(root, 'absent-host-proc'), cgroupRoot: '/host/cgroup', capacityIoDevices: [{ id: 'data', path: '/dev/vdb', majorMinor: '253:16' }],
    stableControl: { controlDbPath: join(root, 'ledger/control.db') }, rolePidsLimits: { api: 512 }, controlFoundationEntries: {
      supervisor: { configPath: join(root, 'foundation/supervisor.json'), startIdentity: 'start-supervisor', resources },
      entry: { configPath: join(root, 'foundation/entry.json'), startIdentity: 'start-entry', resources } } };
  // Production mount assembly requires the literal bounded host proc mount.
  c.procRoot = '/host/proc';
  const launches = []; let current;
  const run = async (_cli, args) => {
    if (args[0] === 'image') return JSON.stringify([{ Id: c.runtimeImage, Os: 'linux', Architecture: 'arm64', Config: { Env: [] } }]);
    if (args[0] === 'run') { current = args; launches.push(args); return 'a'.repeat(64); }
    assert.equal(args[0], 'inspect');
    const labels = Object.fromEntries(current.flatMap((v, i) => v === '--label' ? [current[i + 1].split(/=(.*)/s).slice(0, 2)] : []));
    return JSON.stringify([{ Id: 'a'.repeat(64), Image: c.runtimeImage, Config: { Labels: labels, Env: [], Entrypoint: ['/usr/local/bin/node'], Cmd: [], WorkingDir: root },
      State: { Running: true, Pid: 1234567, StartedAt: '2026-10-21T00:00:00Z', FinishedAt: '0001-01-01T00:00:00Z', Paused: false, OOMKilled: false, ExitCode: 0 },
      RestartCount: 0, HostConfig: { PidMode: '', NetworkMode: 'host', Privileged: false, RestartPolicy: { Name: 'no' } }, Mounts: [] }]);
  };
  const adapter = await createProductionRoleAdapter(c, { run });
  for (const kind of ['control-supervisor', 'control-entry', 'api']) {
    const mode = kind.replace('control-', ''), artifactRoot = kind === 'api' ? join(root, 'business-code') : c.controlArtifactRoot;
    const entry = join(artifactRoot, kind === 'api' ? 'api/main.js' : 'installer/control-foundation.mjs');
    const spec = { artifactRoot, entry, args: kind === 'api' ? [entry] : [entry, c.controlFoundationEntries[mode].configPath], cwd: artifactRoot,
      record: { kind, startIdentity: kind === 'api' ? 'start-api' : c.controlFoundationEntries[mode].startIdentity, artifactDigest: digest(kind), operationId: 'original-operation', commandId: 'start-' + kind, specDigest: digest('command-' + kind) },
      env: { PLATFORM_PROCESS_ROLE: kind === 'api' ? 'control' : 'control-foundation' }, resources, assertBeforeDispatch() {} };
    if (kind === 'api') await adapter.launch({ ...spec, kind });
    else await adapter.launchIndependentFoundation({ ...spec, mode });
  }
  assert.equal(launches.length, 3);
  for (const [i, argv] of launches.entries()) {
    assert.equal(argv.includes('--cgroupns'), i === 0);
    if (i === 0) assert.equal(argv[argv.indexOf('--cgroupns') + 1], 'host');
    assert.equal(argv.includes('--pid'), false);
    assert.equal(argv.includes('--privileged'), false);
    assert.equal(argv.includes('--cap-add'), false);
    assert.equal(argv[argv.indexOf('--cap-drop') + 1], 'ALL');
    assert.equal(argv[argv.indexOf('--security-opt') + 1], 'no-new-privileges');
    assert.equal(argv[argv.indexOf('--memory') + 1], String(resources.memoryBytes));
    assert.equal(argv[argv.indexOf('--cpus') + 1], '0.1');
  }
});
