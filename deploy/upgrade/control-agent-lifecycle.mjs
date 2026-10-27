import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { createProductionRoleAdapter, execute } from './production-role-adapter.mjs';
import { createPrivateControlRpc } from './control-rpc.mjs';
import { atomicJson, readJson, secureDirectory, treeManifest } from './io.mjs';
import { canonical, digest, invariant, DIGEST } from './trust.mjs';
import { verifyInstalledControlPackage } from './control-package.mjs';
import { readSupervisorFact } from './supervisor-control.mjs';

const ID = /^[a-zA-Z0-9._:-]{1,180}$/, CID = /^[a-f0-9]{64}$/;
const birthKeys = ['containerId', 'startIdentity', 'startedAt', 'artifactDigest', 'role'];
const same = (expected, actual) => birthKeys.every(key => expected[key] === actual[key]) &&
  (!actual.running || ['hostPid', 'birthTicks', 'cgroupDigest'].every(key => expected[key] === actual[key]));

/** This port is assembled only inside the independently keyed maintenance
 * endpoint. Ordinary Supervisor commands never receive it. The public request
 * cannot select a container role, executable, configuration or package. */
export async function createControlAgentLifecycle({ config: c, packages, adapter, run = execute, clock = Date.now }) {
  invariant(c.stableControl && packages?.old && packages.new, 'CONTROL_AGENT_LIFECYCLE_CONFIG_REQUIRED');
  const docker = args => run(c.docker.cli || 'docker', [...c.docker.args, ...args]);
  const root = await secureDirectory(join(c.controlFoundationRoot, 'control-agent-lifecycle'));
  const ports = new Map();
  const scope = request => {
    invariant(request.instanceId === c.instanceId && ID.test(request.maintenanceId) && ID.test(request.commandId) && DIGEST.test(request.specDigest) &&
      request.commandId.startsWith(request.maintenanceId + ':'), 'CONTROL_AGENT_MAINTENANCE_SCOPE_INVALID');
    return { instanceId: c.instanceId, maintenanceId: request.maintenanceId, commandId: request.commandId, specDigest: request.specDigest };
  };
  const stopPath = request => join(root, digest(scope(request)).slice(7) + '.json');
  const terminated = (target, actual, signal = null) => {
    invariant(same(target, actual) && actual.running === false && actual.hostPid === 0 && actual.paused === false &&
      actual.restartCount === 0 && actual.restartPolicy === 'no' && typeof actual.oomKilled === 'boolean' && Number.isInteger(actual.exitCode) && actual.exitCode >= 0 && actual.exitCode <= 255 &&
      Number.isFinite(Date.parse(actual.finishedAt)) && Date.parse(actual.finishedAt) >= Date.parse(actual.startedAt), 'CONTROL_AGENT_STOP_OUTCOME_UNKNOWN');
    const normalExit = signal === 'SIGTERM' && !actual.oomKilled && [0, 143].includes(actual.exitCode);
    return { ...actual, terminationObserved: true, normalExit, forced: false, removed: false, signal: normalExit ? 'SIGTERM' : null };
  };
  async function inspect(id) {
    invariant(CID.test(id), 'CONTROL_AGENT_EXACT_CONTAINER_REQUIRED');
    const value = await adapter.inspect(id);
    invariant(value.role === 'control-agent' && value.paused === false && value.restartCount === 0 && value.restartPolicy === 'no', 'CONTROL_AGENT_PHYSICAL_SCOPE_CHANGED');
    return value;
  }
  async function inventory() {
    const ids = (await docker(['ps', '--all', '--no-trunc', '--filter', 'label=agent-platform.instance=' + c.instanceId,
      '--filter', 'label=agent-platform.role=control-agent', '--format', '{{.ID}}'])).trim().split(/\s+/).filter(Boolean);
    invariant(ids.length <= 64 && new Set(ids).size === ids.length && ids.every(id => CID.test(id)), 'CONTROL_AGENT_INVENTORY_UNKNOWN');
    const agents = [];
    for (const id of ids) {
      const first = await inspect(id), second = await inspect(id);
      invariant(same(first, second) && first.running === second.running && first.hostPid === second.hostPid && first.restartCount === second.restartCount, 'CONTROL_AGENT_INVENTORY_CHANGED');
      agents.push(second);
    }
    return { instanceId: c.instanceId, complete: true, agents, observedAt: new Date(clock()).toISOString() };
  }
  async function fixedPackage(request) {
    scope(request);
    const fixed = Object.values(packages).find(value => value.artifactRoot === request.artifactRoot && value.configPath === request.configPath &&
      value.packageDigest === request.packageDigest && value.configDigest === request.configDigest);
    invariant(fixed, 'CONTROL_AGENT_UNREGISTERED_PACKAGE');
    const files = await treeManifest(fixed.artifactRoot), artifactDigest = digest(files.filter(file => file.path.startsWith('installer/')));
    const verified = await verifyInstalledControlPackage({ ...fixed, engineIdentity: { artifactDigest }, clock });
    const fact = await readSupervisorFact(fixed.configPath, 65536), stat = await fs.lstat(fixed.configPath), config = fact.value;
    invariant(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0 &&
      fact.digest === fixed.configDigest && verified.packageDigest === fixed.packageDigest && config.instanceId === c.instanceId &&
      config.startIdentity === request.startIdentity && config.controlArtifactRoot === fixed.artifactRoot && config.controlManifestPath === fixed.manifestPath &&
      join(config.controlLedgerRoot, 'control.db') === c.stableControl.controlDbPath, 'CONTROL_AGENT_FIXED_CONFIG_CHANGED');
    const key = digest({ artifactRoot: fixed.artifactRoot, configPath: fixed.configPath, startIdentity: config.startIdentity });
    if (!ports.has(key)) ports.set(key, await createProductionRoleAdapter({ ...c, controlAgentArtifactRoot: fixed.artifactRoot, controlAgentStartIdentity: config.startIdentity }, { run }));
    const record = { kind: 'control-agent', instanceId: c.instanceId, operationId: request.maintenanceId, commandId: request.commandId,
      specDigest: request.specDigest, startIdentity: request.startIdentity, artifactDigest, attemptId: request.maintenanceId };
    return { fixed, config, record, port: ports.get(key) };
  }
  async function start(request) {
    invariant(request.kind === 'start-control-agent' && typeof request.assertBeforeDispatch === 'function', 'CONTROL_AGENT_START_FORBIDDEN');
    const { fixed, record, port } = await fixedPackage(request);
    const actual = await port.launchControlAgent({ entry: join(fixed.artifactRoot, 'installer/control-main.mjs'),
      args: [join(fixed.artifactRoot, 'installer/control-main.mjs'), fixed.configPath], cwd: fixed.artifactRoot, artifactRoot: fixed.artifactRoot,
      env: { PLATFORM_PROCESS_ROLE: 'upgrade-control', NODE_ENV: 'production' }, record, resources: request.resources, assertBeforeDispatch: request.assertBeforeDispatch });
    return { ...actual, ...scope(request) };
  }
  async function stop(request) {
    invariant(request.kind === 'stop-control-agent' && request.signal === 'SIGTERM' && request.target?.role === 'control-agent' &&
      typeof request.assertBeforeDispatch === 'function', 'CONTROL_AGENT_STOP_FORBIDDEN');
    const path = stopPath(request), input = { ...scope(request), target: request.target };
    const before = await inspect(request.target.containerId);
    invariant(same(request.target, before), 'CONTROL_AGENT_STOP_BIRTH_CHANGED');
    const handle = await fs.open(path, 'wx', 0o600);
    try { await handle.writeFile(canonical({ input, state: 'executing', at: clock() }) + '\n'); await handle.sync(); } finally { await handle.close(); }
    await request.assertBeforeDispatch();
    const fresh = await inspect(request.target.containerId);
    invariant(same(request.target, fresh) && request.deadline > clock(), 'CONTROL_AGENT_STOP_BIRTH_CHANGED');
    if (!fresh.running) {
      const second = await inspect(request.target.containerId);
      invariant(same(fresh, second) && second.running === false && second.finishedAt === fresh.finishedAt, 'CONTROL_AGENT_STOP_BIRTH_CHANGED');
      const result = { ...terminated(request.target, second), ...scope(request) };
      await atomicJson(path, { input, state: 'applied', result, at: clock() }); return result;
    }
    await docker(['kill', '--signal', 'SIGTERM', request.target.containerId]);
    const deadline = Math.min(request.deadline, clock() + 5000);
    while (clock() < deadline) {
      const actual = await inspect(request.target.containerId);
      if (!actual.running) {
        const result = { ...terminated(request.target, actual, 'SIGTERM'), ...scope(request) };
        await atomicJson(path, { input, state: 'applied', result, at: clock() }); return result;
      }
      invariant(same(request.target, actual), 'CONTROL_AGENT_STOP_BIRTH_CHANGED');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    invariant(false, 'CONTROL_AGENT_STOP_OUTCOME_UNKNOWN');
  }
  async function lookup(request) {
    const resultScope = scope(request);
    if (request.kind === 'start-control-agent') {
      const { record, port } = await fixedPackage(request), value = await port.lookupStart(record);
      return { ...resultScope, state: value.state, ...(value.state === 'applied' ? { result: { ...value.result, ...resultScope } } : {}) };
    }
    invariant(request.kind === 'stop-control-agent', 'CONTROL_AGENT_LOOKUP_FORBIDDEN');
    const receipt = await readJson(stopPath(request), null);
    if (!receipt) return { ...resultScope, state: 'definitely-not-applied' };
    invariant(canonical(receipt.input) === canonical({ ...resultScope, target: request.target }), 'CONTROL_AGENT_STOP_COMMAND_CHANGED');
    try {
      const first = await inspect(request.target.containerId), second = await inspect(request.target.containerId);
      invariant(same(first, second) && first.finishedAt === second.finishedAt, 'CONTROL_AGENT_STOP_BIRTH_CHANGED');
      return { ...resultScope, state: 'applied', result: { ...terminated(request.target, second, receipt.state === 'applied' ? receipt.result.signal : null), ...resultScope } };
    }
    catch { return { ...resultScope, state: 'unknown' }; }
  }
  async function health(target) {
    const before = await inspect(target.containerId); invariant(before.running && same(target, before), 'CONTROL_AGENT_HEALTH_BIRTH_CHANGED');
    const rpc = createPrivateControlRpc({ origin: c.stableControl.origin, instanceId: c.instanceId, key: c.stableControl.key });
    const metadata = await rpc('/metadata');
    const after = await inspect(target.containerId); invariant(after.running && same(before, after), 'CONTROL_AGENT_HEALTH_BIRTH_CHANGED');
    return metadata;
  }
  return { inspect, inventory, start, stop, lookup, health };
}
