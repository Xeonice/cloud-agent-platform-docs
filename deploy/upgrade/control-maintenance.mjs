import * as fs from 'node:fs/promises';
import { dirname, join, isAbsolute } from 'node:path';
import { createRequire } from 'node:module';
import { invariant, canonical, digest, DIGEST } from './trust.mjs';
import { treeManifest } from './io.mjs';
import { readSupervisorFact } from './supervisor-control.mjs';
import { verifyInstalledControlPackage } from './control-package.mjs';
import { knownControlAgentTermination } from './control-capacity-collector.mjs';

const ID = /^[a-zA-Z0-9._:-]{1,180}$/, CID = /^[a-f0-9]{64}$/;
const ACTIVE = "('accepted','downloading','package-verified','migrating','prepared','candidate-ready','routing-switched','observing','api-activated')";
const TERMINAL = new Set(['completed', 'rolled-back']);
const agentKeys = ['containerId', 'startIdentity', 'hostPid', 'birthTicks', 'cgroupDigest', 'startedAt', 'artifactDigest', 'role'];
const identity = agent => Object.fromEntries(agentKeys.map(key => [key, agent[key]]));
const equalAgent = (expected, actual) => agentKeys.every(key => key === 'hostPid' || key === 'birthTicks' || key === 'cgroupDigest' ? !actual.running || expected[key] === actual[key] : expected[key] === actual[key]);
const validAgent = agent => agent && CID.test(agent.containerId) && ID.test(agent.startIdentity) && DIGEST.test(agent.artifactDigest) && agent.role === 'control-agent' && Number.isFinite(Date.parse(agent.startedAt)) &&
  ((agent.running === false && agent.hostPid === 0) || (agent.running === true && Number.isSafeInteger(agent.hostPid) && agent.hostPid > 1 && /^\d+$/.test(agent.birthTicks) && DIGEST.test(agent.cgroupDigest))) && agent.paused === false && agent.restartCount === 0;
const failure = error => /^[A-Z0-9_]{1,100}$/.test(error?.code || '') ? error.code : 'CONTROL_MAINTENANCE_OUTCOME_UNKNOWN';

/** Supervisor-owned, fixed-role maintenance. No caller supplies an executable,
 * URL, SQL, package path or arbitrary target. Packages/configs are fixed at
 * assembly and reverified against their pinned signature/tree/config bytes. */
export function createControlMaintenance({ sqlite, controlSqlite, controlDbPath, instanceId, executorId, packages, capacityAllocation, lifecycle, clock = Date.now }) {
  invariant(sqlite && controlSqlite && sqlite !== controlSqlite && sqlite.name !== controlSqlite.name && ID.test(instanceId) && ID.test(executorId) && isAbsolute(controlDbPath) &&
    packages?.old && packages.new && ID.test(capacityAllocation?.id) && capacityAllocation.resources && Object.keys(capacityAllocation.resources).sort().join() === 'cpuMilliCores,disks,ioBytesPerSecond,memoryBytes' &&
    Number.isSafeInteger(capacityAllocation.resources.memoryBytes) && capacityAllocation.resources.memoryBytes > 0 && Number.isSafeInteger(capacityAllocation.resources.cpuMilliCores) && capacityAllocation.resources.cpuMilliCores > 0 &&
    Number.isSafeInteger(capacityAllocation.resources.ioBytesPerSecond) && capacityAllocation.resources.ioBytesPerSecond >= 0 &&
    ['inspect', 'inventory', 'start', 'stop', 'lookup', 'health', 'capacity'].every(name => typeof lifecycle?.[name] === 'function'), 'CONTROL_MAINTENANCE_CONFIG_REQUIRED');
  sqlite.pragma('busy_timeout=50'); controlSqlite.pragma('busy_timeout=50');
  sqlite.exec(`CREATE TABLE IF NOT EXISTS supervisor_control_maintenance(
    maintenance_id TEXT PRIMARY KEY,instance_id TEXT NOT NULL,spec TEXT NOT NULL,spec_digest TEXT NOT NULL,phase TEXT NOT NULL,resume_phase TEXT,
    sequence INTEGER NOT NULL,epoch INTEGER,new_agent TEXT,restored_agent TEXT,reason TEXT,result TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS supervisor_one_control_maintenance ON supervisor_control_maintenance(instance_id) WHERE phase NOT IN ('completed','rolled-back');
    CREATE TABLE IF NOT EXISTS supervisor_control_maintenance_actions(instance_id TEXT NOT NULL,maintenance_id TEXT NOT NULL,command_id TEXT NOT NULL,spec TEXT NOT NULL,spec_digest TEXT NOT NULL,state TEXT NOT NULL,result TEXT,updated_at INTEGER NOT NULL,PRIMARY KEY(instance_id,maintenance_id,command_id));`);
  const live = new Map();
  let expectedDbIdentity;
  async function ledgerIdentity() {
    invariant(controlSqlite.name === controlDbPath && await fs.realpath(controlDbPath) === controlDbPath, 'CONTROL_MAINTENANCE_LEDGER_CHANGED');
    const stat = await fs.lstat(controlDbPath);
    invariant(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0, 'CONTROL_MAINTENANCE_LEDGER_INSECURE');
    const value = { dev: String(stat.dev), ino: String(stat.ino) };
    invariant(!expectedDbIdentity || canonical(value) === canonical(expectedDbIdentity), 'CONTROL_MAINTENANCE_LEDGER_CHANGED');
    expectedDbIdentity = value; return value;
  }
  function read(id) {
    invariant(ID.test(id), 'CONTROL_MAINTENANCE_ID_INVALID');
    const row = sqlite.prepare('SELECT * FROM supervisor_control_maintenance WHERE maintenance_id=? AND instance_id=?').get(id, instanceId);
    if (!row) return null;
    const spec = JSON.parse(row.spec); invariant(digest(spec) === row.spec_digest, 'CONTROL_MAINTENANCE_JOURNAL_CORRUPT');
    return { maintenanceId: id, instanceId, spec, specDigest: row.spec_digest, phase: row.phase, resumePhase: row.resume_phase, sequence: row.sequence,
      epoch: row.epoch, newAgent: row.new_agent ? JSON.parse(row.new_agent) : null, restoredAgent: row.restored_agent ? JSON.parse(row.restored_agent) : null,
      reason: row.reason, result: row.result ? JSON.parse(row.result) : null };
  }
  function save(row, phase, patch = {}) {
    sqlite.prepare('UPDATE supervisor_control_maintenance SET phase=?,resume_phase=?,sequence=sequence+1,epoch=?,new_agent=?,restored_agent=?,reason=?,result=?,updated_at=? WHERE maintenance_id=? AND instance_id=? AND sequence=?')
      .run(phase, patch.resumePhase ?? null, patch.epoch ?? row.epoch, JSON.stringify(patch.newAgent ?? row.newAgent), JSON.stringify(patch.restoredAgent ?? row.restoredAgent), patch.reason ?? null,
        patch.result ? canonical(patch.result) : null, clock(), row.maintenanceId, instanceId, row.sequence);
    const next = read(row.maintenanceId); invariant(next.sequence === row.sequence + 1, 'CONTROL_MAINTENANCE_CAS_CHANGED'); return next;
  }
  function block(row, error) { return save(row, 'blocked', { resumePhase: row.phase === 'blocked' ? row.resumePhase : row.phase, reason: failure(error) }); }
  async function packageProof(which) {
    const fixed = packages[which]; invariant(['artifactRoot', 'manifestPath', 'trustRootPath', 'configPath'].every(key => isAbsolute(fixed[key])) && DIGEST.test(fixed.packageDigest) && DIGEST.test(fixed.configDigest), 'CONTROL_MAINTENANCE_FIXED_PACKAGE_REQUIRED');
    const files = await treeManifest(fixed.artifactRoot), engine = digest(files.filter(file => file.path.startsWith('installer/')));
    const verified = await verifyInstalledControlPackage({ ...fixed, engineIdentity: { artifactDigest: engine }, clock });
    invariant(verified.packageDigest === fixed.packageDigest && verified.protocolVersion === 1, 'CONTROL_MAINTENANCE_PACKAGE_CHANGED');
    const schema = createRequire(join(verified.apiRoot, 'apps/api/package.json'))(join(verified.apiRoot, 'apps/api/dist/platform/upgrade/control-store-schema.js'));
    invariant(schema.UPGRADE_CONTROL_SCHEMA_VERSION === 1, 'CONTROL_MAINTENANCE_SCHEMA_INCOMPATIBLE');
    const config = await readSupervisorFact(fixed.configPath, 65536);
    invariant(config.digest === fixed.configDigest && ((await fs.stat(fixed.configPath)).mode & 0o077) === 0 && config.value.instanceId === instanceId && config.value.controlArtifactRoot === fixed.artifactRoot &&
      config.value.controlManifestPath === fixed.manifestPath && config.value.trustRootPath === fixed.trustRootPath && join(config.value.controlLedgerRoot, 'control.db') === controlDbPath && ID.test(config.value.startIdentity), 'CONTROL_MAINTENANCE_CONFIG_CHANGED');
    const { startIdentity, controllerId: _controller, controlArtifactRoot: _root, controlManifestPath: _manifest, ...stable } = config.value;
    return { public: { ...fixed, version: verified.version, executionEngineDigest: engine, startIdentity, compatibleSchema: 1 }, stable };
  }
  function authority() {
    const metadata = controlSqlite.prepare('SELECT instance_id,schema_version FROM control_store_metadata WHERE singleton=1').get();
    const row = controlSqlite.prepare('SELECT * FROM control_authority WHERE instance_id=?').get(instanceId);
    invariant(metadata?.instance_id === instanceId && metadata.schema_version === 1 && row && ['active', 'passive'].includes(row.mode), 'CONTROL_MAINTENANCE_LEDGER_SCOPE_INVALID'); return row;
  }
  function idle() {
    const queries = [
      ['upgrade_attempts', `SELECT 1 FROM upgrade_attempts WHERE instance_id=? AND state IN ${ACTIVE} LIMIT 1`],
      ['platform_operations', "SELECT 1 FROM platform_operations WHERE instance_id=? AND ((role='upgrade-plan' AND state IN ('accepted','preparing','running')) OR (role='project-name-contract' AND state IN ('accepted','retiring-readers','authority-active','clearing'))) LIMIT 1"],
      ['upgrade_recoveries', "SELECT 1 FROM upgrade_recoveries WHERE instance_id=? AND state='recovering' LIMIT 1"],
      ['control_recovery_intents', "SELECT 1 FROM control_recovery_intents WHERE instance_id=? AND phase IN ('created','reconciling','restoring','verifying') LIMIT 1"],
      ['control_commands', "SELECT 1 FROM control_commands WHERE instance_id=? AND state IN ('planned','executing','unknown','blocked') LIMIT 1"],
    ];
    for (const [table, sql] of queries) {
      invariant(controlSqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table), 'CONTROL_MAINTENANCE_LEDGER_INCOMPLETE');
      invariant(!controlSqlite.prepare(sql).get(instanceId), 'CONTROL_MAINTENANCE_BUSINESS_NOT_QUIESCENT');
    }
    if (sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='supervisor_side_effect'").get()) invariant(!sqlite.prepare('SELECT 1 FROM supervisor_side_effect LIMIT 1').get(), 'CONTROL_MAINTENANCE_SUPERVISOR_BUSY');
    if (sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='control_commands'").get()) invariant(!sqlite.prepare("SELECT 1 FROM control_commands WHERE instance_id=? AND state IN ('planned','executing','unknown','blocked') LIMIT 1").get(instanceId), 'CONTROL_MAINTENANCE_SUPERVISOR_BUSY');
  }
  function barrier(row) {
    const current = authority(); invariant(current.mode === 'passive' && current.kind === 'maintenance' && current.operation_id === row.maintenanceId && current.holder_id === executorId && current.epoch === row.spec.expectedControlEpoch + 1, 'CONTROL_MAINTENANCE_BARRIER_CHANGED'); return current;
  }
  async function inventory(expectedLive) {
    const value = await lifecycle.inventory();
    invariant(value?.instanceId === instanceId && value.complete === true && Array.isArray(value.agents) && value.agents.every(validAgent) && clock() >= Date.parse(value.observedAt) && clock() - Date.parse(value.observedAt) <= 5000, 'CONTROL_MAINTENANCE_INVENTORY_UNKNOWN');
    const actual = value.agents.filter(agent => agent.running);
    invariant(actual.length === expectedLive.length && expectedLive.every(expected => actual.some(agent => equalAgent(expected, agent))), 'CONTROL_MAINTENANCE_SECOND_AGENT_UNKNOWN');
  }
  async function submit({ maintenanceId, expectedControlEpoch, sourceAgent, deadline, rollbackDeadline, initialPassive = false }) {
    invariant(ID.test(maintenanceId) && Number.isSafeInteger(expectedControlEpoch) && expectedControlEpoch >= 0 && expectedControlEpoch < Number.MAX_SAFE_INTEGER && validAgent(sourceAgent) && sourceAgent.running && Number.isSafeInteger(deadline) && deadline > clock() &&
      deadline <= clock() + 120000 && Number.isSafeInteger(rollbackDeadline) && rollbackDeadline >= deadline && rollbackDeadline <= clock() + 240000, 'CONTROL_MAINTENANCE_PLAN_INVALID');
    const dbIdentity = await ledgerIdentity(), old = await packageProof('old'), next = await packageProof('new');
    invariant(canonical(old.stable) === canonical(next.stable) && sourceAgent.artifactDigest === old.public.executionEngineDigest && sourceAgent.startIdentity === old.public.startIdentity, 'CONTROL_MAINTENANCE_FOUNDATION_CHANGE_FORBIDDEN');
    const spec = { schemaVersion: 1, instanceId, maintenanceId, expectedControlEpoch, sourceAgent: { ...identity(sourceAgent), running: true, paused: false, restartCount: 0 }, deadline, rollbackDeadline, initialPassive, dbIdentity, packages: { old: old.public, new: next.public }, capacityAllocation: structuredClone(capacityAllocation) };
    const previous = read(maintenanceId); if (previous) { invariant(previous.specDigest === digest(spec), 'CONTROL_MAINTENANCE_SPEC_CONFLICT'); return previous; }
    const actual = await lifecycle.inspect(sourceAgent.containerId);
    invariant(validAgent(actual) && equalAgent(sourceAgent, actual) && (actual.running || knownControlAgentTermination(actual, false)), 'CONTROL_MAINTENANCE_SOURCE_CHANGED'); await inventory(actual.running ? [sourceAgent] : []);
    return sqlite.transaction(() => {
      invariant(!sqlite.prepare("SELECT 1 FROM supervisor_control_maintenance WHERE instance_id=? AND phase NOT IN ('completed','rolled-back')").get(instanceId), 'CONTROL_MAINTENANCE_ALREADY_ACTIVE');
      sqlite.prepare('INSERT INTO supervisor_control_maintenance VALUES(?,?,?,?,\'accepted\',NULL,1,NULL,NULL,NULL,NULL,NULL,?,?)').run(maintenanceId, instanceId, canonical(spec), digest(spec), clock(), clock()); return read(maintenanceId);
    }).immediate();
  }
  function reserve(row) {
    const current = authority();
    if (current.mode === 'passive' && current.kind === 'maintenance' && current.operation_id === row.maintenanceId) { barrier(row); return save(row, 'barrier-held', { epoch: current.epoch }); }
    const epoch = controlSqlite.transaction(() => {
      const current = authority(); idle();
      invariant(current.epoch === row.spec.expectedControlEpoch && (current.holder_id === null || current.lease_expires_at <= clock()) && (current.mode === 'active' || row.spec.initialPassive && current.mode === 'passive' && current.holder_id === null && current.operation_id === null && current.kind === null), 'CONTROL_MAINTENANCE_AUTHORITY_BUSY');
      controlSqlite.prepare("UPDATE control_authority SET epoch=epoch+1,operation_id=?,kind='maintenance',holder_id=?,lease_expires_at=0,mode='passive',revision=revision+1,updated_at=? WHERE instance_id=? AND epoch=?")
        .run(row.maintenanceId, executorId, clock(), instanceId, row.spec.expectedControlEpoch); return authority().epoch;
    }).immediate(); return save(row, 'barrier-held', { epoch });
  }
  async function action(row, step, input, dispatch) {
    const commandId = row.maintenanceId + ':' + step, spec = { schemaVersion: 1, instanceId, maintenanceId: row.maintenanceId, commandId, step, deadline: step.includes('rollback') ? row.spec.rollbackDeadline : row.spec.deadline, ...input }, specDigest = digest(spec);
    let old = sqlite.prepare('SELECT * FROM supervisor_control_maintenance_actions WHERE instance_id=? AND maintenance_id=? AND command_id=?').get(instanceId, row.maintenanceId, commandId);
    if (old) {
      invariant(old.spec_digest === specDigest, 'CONTROL_MAINTENANCE_COMMAND_CHANGED');
      if (old.state === 'applied') return JSON.parse(old.result);
      if (live.has(commandId)) return null;
      if (['executing', 'unknown'].includes(old.state)) {
        const result = await lifecycle.lookup({ ...spec, specDigest });
        invariant(result?.instanceId === instanceId && result.maintenanceId === row.maintenanceId && result.commandId === commandId && result.specDigest === specDigest && ['applied', 'unknown', 'definitely-not-applied'].includes(result.state), 'CONTROL_MAINTENANCE_LOOKUP_INVALID');
        if (result.state === 'unknown') return null;
        sqlite.prepare('UPDATE supervisor_control_maintenance_actions SET state=?,result=?,updated_at=? WHERE instance_id=? AND maintenance_id=? AND command_id=?').run(result.state, result.state === 'applied' ? canonical(result.result) : null, clock(), instanceId, row.maintenanceId, commandId);
        if (result.state === 'applied') return result.result;
        return null; // A later step may retry only this exact known-undispatched command.
      }
    } else {
      sqlite.prepare("INSERT INTO supervisor_control_maintenance_actions VALUES(?,?,?,?,?,'planned',NULL,?)").run(instanceId, row.maintenanceId, commandId, canonical(spec), specDigest, clock());
    }
    invariant(spec.deadline > clock(), 'CONTROL_MAINTENANCE_DEADLINE_EXPIRED'); barrier(row);
    sqlite.prepare("UPDATE supervisor_control_maintenance_actions SET state='executing',updated_at=? WHERE instance_id=? AND maintenance_id=? AND command_id=?").run(clock(), instanceId, row.maintenanceId, commandId);
    const task = Promise.resolve().then(() => dispatch({ ...spec, specDigest, assertBeforeDispatch: () => { barrier(row); invariant(spec.deadline > clock(), 'CONTROL_MAINTENANCE_DEADLINE_EXPIRED'); } })); live.set(commandId, task);
    try {
      const result = await task; invariant(result?.instanceId === instanceId && result.maintenanceId === row.maintenanceId && result.commandId === commandId && result.specDigest === specDigest && Buffer.byteLength(canonical(result)) <= 65536, 'CONTROL_MAINTENANCE_RESULT_INVALID');
      sqlite.prepare("UPDATE supervisor_control_maintenance_actions SET state='applied',result=?,updated_at=? WHERE instance_id=? AND maintenance_id=? AND command_id=?").run(canonical(result), clock(), instanceId, row.maintenanceId, commandId); return result;
    } catch (error) {
      sqlite.prepare("UPDATE supervisor_control_maintenance_actions SET state='unknown',updated_at=? WHERE instance_id=? AND maintenance_id=? AND command_id=?").run(clock(), instanceId, row.maintenanceId, commandId); throw error;
    } finally { if (live.get(commandId) === task) live.delete(commandId); }
  }
  function stopped(target, value) {
    invariant(validAgent(value) && knownControlAgentTermination(value) && equalAgent(target, value), 'CONTROL_MAINTENANCE_STOP_UNKNOWN'); return value;
  }
  function actionRecord(row, step) {
    const value = sqlite.prepare('SELECT * FROM supervisor_control_maintenance_actions WHERE instance_id=? AND maintenance_id=? AND command_id=?').get(instanceId, row.maintenanceId, row.maintenanceId + ':' + step);
    invariant(value && digest(JSON.parse(value.spec)) === value.spec_digest, 'CONTROL_MAINTENANCE_COMMAND_UNKNOWN');
    return { instanceId, maintenanceId: row.maintenanceId, commandId: value.command_id, spec: JSON.parse(value.spec), specDigest: value.spec_digest, state: value.state, result: value.result ? JSON.parse(value.result) : null };
  }
  async function capacity(row, step, action, target = null, request = null) {
    const record = actionRecord(row, step), input = { instanceId, maintenanceId: row.maintenanceId, commandId: record.commandId, specDigest: record.specDigest,
      action, allocationId: row.spec.capacityAllocation.id, resources: row.spec.capacityAllocation.resources, record, ...(target ? { target: identity(target) } : {}) };
    const result = await lifecycle.capacity(input);
    invariant(result?.instanceId === instanceId && result.maintenanceId === row.maintenanceId && result.commandId === record.commandId && result.specDigest === record.specDigest && result.action === action && result.requestDigest === digest(input) &&
      DIGEST.test(result.planDigest) && DIGEST.test(result.configDigest), 'CONTROL_MAINTENANCE_CAPACITY_UNKNOWN');
    if (action === 'admit-start') invariant(result.qualified === true && result.state === 'admitted' && DIGEST.test(result.observationDigest) && Number.isSafeInteger(result.revision) && result.revision >= 0 &&
      Number.isFinite(Date.parse(result.observedAt)) && clock() >= Date.parse(result.observedAt) && clock() - Date.parse(result.observedAt) <= 5000 && result.resourcesDigest === digest(row.spec.capacityAllocation.resources), 'CONTROL_MAINTENANCE_CAPACITY_UNKNOWN');
    request?.assertBeforeDispatch(); return result;
  }
  async function stop(row, step, target) {
    const result = await action(row, step, { kind: 'stop-control-agent', target: identity(target), signal: 'SIGTERM', capacityAllocationId: row.spec.capacityAllocation.id, resources: row.spec.capacityAllocation.resources }, async request => {
      const actual = await lifecycle.inspect(target.containerId);
      invariant(validAgent(actual) && equalAgent(target, actual), 'CONTROL_MAINTENANCE_STOP_TARGET_CHANGED');
      await inventory(actual.running ? [target] : []); request.assertBeforeDispatch();
      return lifecycle.stop(request);
    });
    if (!result) return null;
    const value = stopped(target, result); await capacity(row, step, 'release-stopped', target); return value;
  }
  async function start(row, which, step) {
    const proof = await packageProof(which); invariant(canonical(proof.public) === canonical(row.spec.packages[which]), 'CONTROL_MAINTENANCE_PACKAGE_CHANGED');
    const fixed = row.spec.packages[which], result = await action(row, step, { kind: 'start-control-agent', packageDigest: fixed.packageDigest, artifactRoot: fixed.artifactRoot, configPath: fixed.configPath, configDigest: fixed.configDigest, startIdentity: fixed.startIdentity,
      capacityAllocationId: row.spec.capacityAllocation.id, resources: row.spec.capacityAllocation.resources }, async request => { await inventory([]); request.assertBeforeDispatch(); const capacityReceipt = await capacity(row, step, 'admit-start', null, request); return lifecycle.start({ ...request, capacityReceipt }); });
    if (!result) return null;
    invariant(validAgent(result) && result.startIdentity === fixed.startIdentity && result.artifactDigest === fixed.executionEngineDigest, 'CONTROL_MAINTENANCE_START_UNKNOWN'); await inventory(result.running ? [result] : []);
    if (result.running) await capacity(row, step, 'bind-started', result); return result;
  }
  async function health(row, which, target) {
    const actual = await lifecycle.inspect(target.containerId); invariant(validAgent(actual) && equalAgent(target, actual), 'CONTROL_MAINTENANCE_TARGET_CHANGED');
    if (!actual.running) return { failed: true, physical: actual };
    await inventory([target]); const value = await lifecycle.health(target), fixed = row.spec.packages[which];
    invariant(value?.instanceId === instanceId && value.role === 'installer' && Number.isInteger(value.pid) && value.pid > 0 && value.startIdentity === fixed.startIdentity && value.artifactDigest === fixed.executionEngineDigest && value.controlSystem?.packageDigest === fixed.packageDigest && value.controlSystem.version === fixed.version && value.controlSystem.protocolVersion === 1 &&
      Number.isFinite(Date.parse(value.observedAt)) && clock() >= Date.parse(value.observedAt) && clock() - Date.parse(value.observedAt) <= 5000, 'CONTROL_MAINTENANCE_STARTUP_UNKNOWN');
    return { failed: false, metadata: value, physical: actual };
  }
  function completion(row) {
    if (!controlSqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='control_maintenance_completions'").get()) return null;
    const saved = controlSqlite.prepare('SELECT * FROM control_maintenance_completions WHERE maintenance_id=? AND instance_id=?').get(row.maintenanceId, instanceId);
    if (!saved) return null;
    const result = JSON.parse(saved.receipt); invariant(saved.spec_digest === row.specDigest && digest(result) === saved.receipt_digest && result.epoch === row.epoch, 'CONTROL_MAINTENANCE_COMPLETION_CORRUPT'); return result;
  }
  function confirm(row, outcome, proof) {
    const previous = completion(row); if (previous) return save(row, previous.outcome, { result: previous });
    const receipt = controlSqlite.transaction(() => {
      barrier(row); idle();
      controlSqlite.exec('CREATE TABLE IF NOT EXISTS control_maintenance_completions(maintenance_id TEXT PRIMARY KEY,instance_id TEXT NOT NULL,spec_digest TEXT NOT NULL,receipt_digest TEXT NOT NULL,receipt TEXT NOT NULL,completed_at INTEGER NOT NULL)');
      const result = { instanceId, maintenanceId: row.maintenanceId, outcome, epoch: row.epoch, specDigest: row.specDigest, controlDbIdentity: row.spec.dbIdentity, proof, confirmedAt: clock() };
      invariant(Buffer.byteLength(canonical(result)) <= 65536, 'CONTROL_MAINTENANCE_RESULT_TOO_LARGE');
      controlSqlite.prepare('INSERT INTO control_maintenance_completions VALUES(?,?,?,?,?,?)').run(row.maintenanceId, instanceId, row.specDigest, digest(result), canonical(result), result.confirmedAt);
      controlSqlite.prepare("UPDATE control_authority SET mode='active',holder_id=NULL,lease_expires_at=0,revision=revision+1,updated_at=? WHERE instance_id=?").run(result.confirmedAt, instanceId);
      return result;
    }).immediate(); return save(row, outcome, { result: receipt });
  }
  async function advance(id) {
    let row = read(id); invariant(row, 'CONTROL_MAINTENANCE_NOT_FOUND'); if (TERMINAL.has(row.phase)) return row;
    invariant(!live.has(id), 'CONTROL_MAINTENANCE_BUSY'); const token = {}; live.set(id, token);
    try {
      await ledgerIdentity(); invariant(canonical(expectedDbIdentity) === canonical(row.spec.dbIdentity), 'CONTROL_MAINTENANCE_LEDGER_CHANGED');
      const known = completion(row); if (known) return save(row, known.outcome, { result: known });
      const phase = row.phase === 'blocked' ? row.resumePhase : row.phase;
      if (phase === 'accepted') return reserve(row);
      barrier(row);
      if (phase === 'barrier-held') {
        const stopped = await stop(row, 'stop-old', row.spec.sourceAgent);
        return stopped ? save(row, 'old-stopped') : block(row, Error('UNKNOWN'));
      }
      if (phase === 'old-stopped') {
        const value = await start(row, 'new', 'start-new'); return value ? save(row, 'new-started', { newAgent: value }) : block(row, Error('UNKNOWN'));
      }
      if (phase === 'new-started') {
        const proof = await health(row, 'new', row.newAgent); return proof.failed ? save(row, 'rollback-stop-new') : confirm(row, 'completed', proof);
      }
      if (phase === 'rollback-stop-new') {
        const value = await stop(row, 'rollback-stop-new', row.newAgent); return value ? save(row, 'rollback-old-ready') : block(row, Error('UNKNOWN'));
      }
      if (phase === 'rollback-old-ready') {
        const value = await start(row, 'old', 'rollback-start-old'); return value ? save(row, 'rollback-old-started', { restoredAgent: value }) : block(row, Error('UNKNOWN'));
      }
      if (phase === 'rollback-old-started') {
        const proof = await health(row, 'old', row.restoredAgent); invariant(!proof.failed, 'CONTROL_MAINTENANCE_ROLLBACK_FAILED'); return confirm(row, 'rolled-back', proof);
      }
      throw Object.assign(Error('Unknown phase'), { code: 'CONTROL_MAINTENANCE_PHASE_UNKNOWN' });
    } catch (error) { return block(read(id), error); }
    finally { if (live.get(id) === token) live.delete(id); }
  }
  return { submit, read, advance,
    readAction(id, commandId) {
      const row = read(id); invariant(row && typeof commandId === 'string' && commandId.startsWith(id + ':'), 'CONTROL_MAINTENANCE_COMMAND_UNKNOWN');
      return { ...actionRecord(row, commandId.slice(id.length + 1)), operationId: id };
    } };
}
