import * as fs from 'node:fs/promises';
import { join, resolve, isAbsolute } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { canonical, digest, invariant, DIGEST } from './trust.mjs';

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const TERMINAL = new Set(['activation-confirmed', 'failed', 'deferred', 'candidate-rejected', 'reverted']);
const PROJECT = '208342ea994555c12c3ba42ce3b6aabd0afe9df1';
const API = '17e2ad52bfacea49ec9834d4f98693e3e66fbd79';
const MAX_ROWS = 10000, MAX_JSON = 4 * 1024 * 1024;
const TABLES = {
  instances: 'SELECT instance_id,activation_generation,confirmed_release,service_state,ready FROM upgrade_instances',
  attempts: 'SELECT attempt_id,instance_id,actor_id,request_id,target_digest,manifest,plan,state,stage,sequence,generation FROM upgrade_attempts',
  steps: 'SELECT attempt_id,step_id,applied,receipt_digest,evidence,completed_work,applied_at FROM upgrade_steps',
  events: 'SELECT event_id,attempt_id,event_digest,generation,sequence,fence,kind,payload FROM upgrade_events',
  recoveries: 'SELECT recovery_attempt_id,triggering_attempt_id,instance_id,state,plan,plan_digest FROM upgrade_recoveries',
  handoffs: 'SELECT attempt_id,operation_id,plan_digest,candidate,stage,evidence FROM coordinator_handoffs',
  roleHandoffs: 'SELECT attempt_id,kind,operation_id,plan_digest,candidate,stage,evidence FROM upgrade_role_handoffs',
  coordinatorRecoveries: 'SELECT recovery_attempt_id,triggering_attempt_id,operation_id,plan_digest,candidate,stage,evidence FROM coordinator_recoveries',
  contracts: "SELECT operation_id,instance_id,actor_id,fence,request_digest,state,result FROM platform_operations WHERE role='project-name-contract'",
  migrations: 'SELECT attempt_id,plan_digest,stage,degraded,read_epoch FROM upgrade_online_migrations',
};
const identityKeys = ['containerId', 'startIdentity', 'artifactDigest'];
const parsed = value => typeof value === 'string' ? JSON.parse(value) : value;
const collectedObservations = new WeakSet();
function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

async function json(path, optional = false) {
  let handle;
  try {
    handle = await fs.open(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const before = await handle.stat();
    invariant(before.isFile() && before.size <= MAX_JSON, 'LEGACY_SETTLEMENT_JSON_INVALID');
    const bytes = await handle.readFile(), after = await handle.stat();
    invariant(['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every(k => before[k] === after[k]), 'LEGACY_SETTLEMENT_FILE_CHANGED');
    const value = JSON.parse(bytes.toString('utf8'));
    return { path, rawDigest: digest(bytes), bytes: bytes.length, valueDigest: digest(value), value };
  } catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    throw error;
  } finally { await handle?.close(); }
}
async function directory(path) {
  const stat = await fs.lstat(path);
  invariant(stat.isDirectory() && !stat.isSymbolicLink() && await fs.realpath(path) === path, 'LEGACY_SETTLEMENT_DIRECTORY_REQUIRED');
  const names = (await fs.readdir(path)).sort();
  invariant(names.length <= MAX_ROWS, 'LEGACY_SETTLEMENT_INVENTORY_LIMIT');
  return names;
}
async function documents(path, select) {
  const result = [];
  for (const name of await directory(path)) if (select(name)) result.push(await json(join(path, name)));
  return result;
}

/** Read only the old schema and its original result files. This does not start a
 * Controller, invoke any legacy RPC, repair a journal, or manufacture receipts.
 * Process observations must come from the caller's existing read-only inspector;
 * absence of that evidence is reported as blocked, never inferred from exit0.
 */
export async function collectLegacySettlementInventory({ instanceId, databasePath, installerRoot, publicationRoot,
  installerIdentity, processObservationsPath, Database, sqlitePackageRoot, clock = Date.now }) {
  invariant(typeof instanceId === 'string' && instanceId.length > 0 &&
    [databasePath, installerRoot, publicationRoot].every(p => typeof p === 'string' && isAbsolute(p) && resolve(p) === p),
  'LEGACY_SETTLEMENT_INPUT_REQUIRED');
  await directory(installerRoot);await directory(publicationRoot);
  const before = await fs.lstat(databasePath);
  invariant(before.isFile() && !before.isSymbolicLink() && await fs.realpath(databasePath) === databasePath,
    'LEGACY_SETTLEMENT_DATABASE_REQUIRED');
  // A read-only WAL connection must not create a missing sidecar in the old
  // installation. The existing old process owns WAL/SHM creation.
  const wal = await fs.lstat(databasePath + '-wal').catch(e => { if (e.code === 'ENOENT') return null; throw e; });
  if (wal) invariant((await fs.lstat(databasePath + '-shm')).isFile(), 'LEGACY_SETTLEMENT_EXISTING_SHM_REQUIRED');
  if (!Database) {
    invariant(typeof sqlitePackageRoot === 'string' && isAbsolute(sqlitePackageRoot), 'LEGACY_SETTLEMENT_SQLITE_MODULE_REQUIRED');
    Database = createRequire(join(sqlitePackageRoot, 'package.json'))('better-sqlite3');
  }
  function readTables() {
    const database = new Database(databasePath, { readonly: true, fileMustExist: true });
    try {
      database.pragma('query_only = ON');
      invariant(database.readonly && database.pragma('query_only', { simple: true }) === 1, 'LEGACY_SETTLEMENT_READONLY_REQUIRED');
      return database.transaction(() => Object.fromEntries(Object.entries(TABLES).map(([name, sql]) => {
        const rows = database.prepare(sql + ' LIMIT ' + (MAX_ROWS + 1)).all();
        invariant(rows.length <= MAX_ROWS, 'LEGACY_SETTLEMENT_INVENTORY_LIMIT');return [name, rows];
      })))();
    } finally { database.close(); }
  }
  const tables = readTables();
  const after = await fs.lstat(databasePath);
  invariant(before.dev === after.dev && before.ino === after.ino, 'LEGACY_SETTLEMENT_DATABASE_CHANGED');
  const journalRoot = join(installerRoot, 'journals');
  const journalNames = await directory(journalRoot);
  for (const name of journalNames) invariant(!name.endsWith('.json') ||
    UUID.test(name.replace(/\.json$/, '')), 'LEGACY_SETTLEMENT_UNKNOWN_INSTALLER_JOURNAL');
  const journals = await documents(journalRoot, name => UUID.test(name.replace(/\.json$/, '')) && name.endsWith('.json'));
  const processNames = await directory(join(installerRoot, 'processes'));
  const processFiles = [];
  for (const name of processNames) {
    // Configs contain keys; they are inventoried by name but never opened.
    if (/^[a-f0-9-]{36}-(?:api|web|coordinator|owner|installer)\.json$/.test(name)) processFiles.push(await json(join(installerRoot, 'processes', name)));
    else invariant(!name.endsWith('.json') || /^[a-f0-9-]{36}-installer-config\.json$/.test(name), 'LEGACY_SETTLEMENT_UNKNOWN_PROCESS_RECORD');
  }
  const retirementRoot = join(publicationRoot, 'installed-roles', 'contract-retirements');
  const retirementFiles = await fs.lstat(retirementRoot).catch(e => { if (e.code === 'ENOENT') return null; throw e; })
    ? await documents(retirementRoot, name => name.endsWith('.json')) : [];
  const retirementNames = await fs.readdir(retirementRoot).then(names => names.sort()).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
  const authority = await json(join(installerRoot, 'controller-authority.json'), true);
  const observations = processObservationsPath ? await json(processObservationsPath) : null;
  // This detects a mixed inventory; stability is NOT used as dispatch-completion
  // evidence. Every original outcome must still pass the validator below.
  invariant(digest(readTables()) === digest(tables), 'LEGACY_SETTLEMENT_INVENTORY_CHANGED');
  for (const file of [...journals, ...processFiles, ...retirementFiles, ...(authority ? [authority] : []), ...(observations ? [observations] : [])])
    invariant((await json(file.path)).rawDigest === file.rawDigest, 'LEGACY_SETTLEMENT_FILE_CHANGED');
  invariant(canonical(await directory(join(installerRoot, 'processes'))) === canonical(processNames),
    'LEGACY_SETTLEMENT_FILE_CHANGED');
  invariant(canonical(await directory(journalRoot)) === canonical(journalNames) &&
    canonical(await fs.readdir(retirementRoot).then(names => names.sort()).catch(e => { if (e.code === 'ENOENT') return null; throw e; })) === canonical(retirementNames),
  'LEGACY_SETTLEMENT_FILE_CHANGED');
  const finalDatabase = await fs.lstat(databasePath);
  invariant(finalDatabase.isFile() && !finalDatabase.isSymbolicLink() && before.dev === finalDatabase.dev && before.ino === finalDatabase.ino,
    'LEGACY_SETTLEMENT_DATABASE_CHANGED');
  return { schemaVersion: 1, kind: 'legacy-upgrade-settlement-inventory', instanceId,
    schemaBasis: { projectRevision: PROJECT, apiRevision: API }, observedAt: new Date(clock()).toISOString(),
    database: { path: databasePath, dev: before.dev, ino: before.ino, readonly: true, queryOnly: true, rowsDigest: digest(tables),
      unchangedAcrossFileRead: true },
    installerIdentity: installerIdentity ?? null, tables, journals, processFiles, processNames, retirementFiles, authority, observations,
    lifecycleCalls: 0, legacyRpcCalls: 0, journalWrites: 0, databaseWrites: 0 };
}

/** Settlement is one adoption precondition, never authority to adopt or stop a
 * role. A late original result may resolve an unknown local ACK, but no status is
 * rewritten. No elapsed delay or repeated stable snapshot is a completion proof.
 */
export function validateLegacySettlement(inventory, { clock = Date.now } = {}) {
  const blockers = [], resolved = [];
  const block = (code, id = null) => blockers.push({ code, ...(id ? { originalId: id } : {}) });
  const check = (condition, code, id) => { if (!condition) block(code, id);return Boolean(condition); };
  try {
    invariant(inventory?.schemaVersion === 1 && inventory.kind === 'legacy-upgrade-settlement-inventory' &&
      inventory.database?.readonly === true && inventory.database.queryOnly === true &&
      inventory.schemaBasis?.projectRevision === PROJECT && inventory.schemaBasis.apiRevision === API &&
      ['lifecycleCalls', 'legacyRpcCalls', 'journalWrites', 'databaseWrites'].every(k => inventory[k] === 0), 'LEGACY_SETTLEMENT_INVENTORY_INVALID');
    check(Number.isFinite(Date.parse(inventory.observedAt)) && clock() - Date.parse(inventory.observedAt) >= 0 &&
      clock() - Date.parse(inventory.observedAt) <= 5000, 'LEGACY_SETTLEMENT_OBSERVATION_EXPIRED');
    const t = inventory.tables, id = inventory.instanceId;
    invariant(Object.keys(TABLES).every(k => Array.isArray(t[k])) && digest(t) === inventory.database.rowsDigest,
      'LEGACY_SETTLEMENT_INVENTORY_CHANGED');
    for (const file of [...inventory.journals, ...inventory.processFiles, ...inventory.retirementFiles,
      ...(inventory.authority ? [inventory.authority] : []), ...(inventory.observations ? [inventory.observations] : [])])
      invariant(DIGEST.test(file.rawDigest) && file.valueDigest === digest(file.value), 'LEGACY_SETTLEMENT_ORIGINAL_FILE_CHANGED');
    const instance = t.instances.filter(r => r.instance_id === id);
    check(instance.length === 1 && instance[0].confirmed_release && instance[0].service_state === 'confirmed' &&
      instance[0].ready === 1, 'LEGACY_SERVICE_NOT_CONFIRMED');
    const confirmed = instance[0]?.confirmed_release ? parsed(instance[0].confirmed_release) : null;
    check(confirmed?.activationGeneration === instance[0]?.activation_generation &&
      confirmed?.components?.installer?.artifactDigest === inventory.installerIdentity?.artifactDigest,
    'LEGACY_CONFIRMED_INSTALLER_CHANGED');
    const proof = inventory.observations?.value;
    check(proof?.schemaVersion === 1 && proof.kind === 'legacy-settlement-process-observations' && proof.instanceId === id &&
      Number.isFinite(Date.parse(proof.observedAt)) && clock() - Date.parse(proof.observedAt) >= 0 &&
      clock() - Date.parse(proof.observedAt) <= 5000, 'LEGACY_PROCESS_OBSERVATIONS_REQUIRED');
    const installer = proof?.installer;
    check(Array.isArray(proof?.processes) && new Set(proof.processes.map(p => p.containerId + ':' + p.startIdentity)).size === proof.processes.length &&
      proof.processes.every(p => inventory.processFiles.some(file => identityKeys.every(k => file.value[k] === p[k]))),
    'LEGACY_SUPERVISOR_OBSERVATION_SCOPE_CHANGED');
    check(inventory.installerIdentity?.instanceId === id && installer &&
      identityKeys.every(k => typeof installer[k] === 'string' && installer[k] && installer[k] === inventory.installerIdentity[k]) &&
      installer.running === false && installer.pid === 0 && installer.exitCode === 0 && installer.oomKilled === false &&
      installer.restartCount === 0 && Date.parse(installer.finishedAt) >= Date.parse(installer.startedAt) &&
      Date.parse(installer.finishedAt) <= Date.parse(proof.observedAt),
    'LEGACY_INSTALLER_NORMAL_EXIT_UNPROVEN');
    const attempts = t.attempts.filter(r => r.instance_id === id), attemptIds = new Set(attempts.map(r => r.attempt_id));
    check(t.instances.length === 1 && t.attempts.every(r => r.instance_id === id) &&
      t.contracts.every(r => r.instance_id === id) && t.recoveries.every(r => r.instance_id === id),
    'LEGACY_DATABASE_INSTANCE_SCOPE_CHANGED');
    const steps = new Map(t.steps.map(r => [r.attempt_id + ':' + r.step_id, r]));
    const journals = new Map(inventory.journals.map(file => [file.value.attemptId, file.value]));
    const events = new Map(t.events.map(r => [r.event_id, r]));
    for (const row of [...t.steps, ...t.events]) check(attemptIds.has(row.attempt_id),
      'LEGACY_ORPHAN_UPGRADE_RESULT', row.attempt_id);
    for (const file of inventory.journals) {
      check(file.rawDigest && file.value && attemptIds.has(file.value.attemptId) &&
        file.path.split('/').at(-1) === file.value.attemptId + '.json', 'LEGACY_ORPHAN_INSTALLER_JOURNAL', file.value?.attemptId);
    }
    for (const attempt of attempts) {
      const aid = attempt.attempt_id, plan = parsed(attempt.plan), { planDigest, ...facts } = plan,
        envelope = parsed(attempt.manifest);
      check(UUID.test(aid) && planDigest === digest(facts) && plan.manifestDigest === attempt.target_digest &&
        envelope.manifestDigest === attempt.target_digest && digest(envelope.manifest) === attempt.target_digest,
        'LEGACY_UPGRADE_PLAN_UNPROVEN', aid);
      check(TERMINAL.has(attempt.state), 'LEGACY_UPGRADE_NOT_TERMINAL', aid);
      const journal = journals.get(aid);
      if (!check(journal?.planDigest === planDigest && journal.steps && typeof journal.steps === 'object', 'LEGACY_INSTALLER_JOURNAL_REQUIRED', aid)) continue;
      for (const [stepId, local] of Object.entries(journal.steps)) {
        const stored = steps.get(aid + ':' + stepId), step = plan.steps.find(s => s.stepId === stepId);
        const receipt = stored?.evidence ? parsed(stored.evidence) : null;
        const applied = step && stored?.applied === 1 && receipt && stored.receipt_digest === digest(receipt) &&
          Number.isFinite(stored.applied_at) && stored.completed_work >= 0;
        if (!check(applied, 'LEGACY_STEP_ORIGINAL_RESULT_UNKNOWN', aid + ':' + stepId)) continue;
        if (local.state === 'applying') resolved.push({ originalId: aid + ':' + stepId, by: 'original-upgrade-step-receipt', receiptDigest: stored.receipt_digest });
        else check(local.state === 'applied' && local.receiptDigest === stored.receipt_digest &&
          digest(local.evidence) === stored.receipt_digest, 'LEGACY_STEP_RECEIPT_MISMATCH', aid + ':' + stepId);
      }
      for (const stored of t.steps.filter(s => s.attempt_id === aid && s.applied === 1)) {
        check(journal.steps[stored.step_id], 'LEGACY_STEP_LOCAL_DISPATCH_MISSING', aid + ':' + stored.step_id);
        const step = plan.steps.find(s => s.stepId === stored.step_id), kind = {
          candidate: 'api', web: 'web', 'coordinator-handoff': 'coordinator', 'owner-candidate': 'owner', 'installer-handoff': 'installer',
        }[step?.kind];
        if (kind) check(inventory.processFiles.some(file => file.value.attemptId === aid && file.value.kind === kind),
          'LEGACY_SUPERVISOR_ORIGINAL_RECORD_MISSING', aid + ':' + stored.step_id);
      }
      if (journal.faultCommit) {
        const event = events.get(journal.faultCommit.eventId), command = journal.faultCommit;
        check(event && event.attempt_id === aid && event.kind === command.kind && event.event_digest === digest(command) &&
          canonical(parsed(event.payload)) === canonical(command.payload), 'LEGACY_FAULT_COMMIT_UNKNOWN', aid);
      } else check(!journal.faultCommitApplied, 'LEGACY_FAULT_COMMIT_MISSING', aid);
      if (journal.circuitBroken) check(journal.faultCommit && journal.faultRecordingComplete === true,
        'LEGACY_MONITOR_FAULT_UNCLOSED', aid);
      if (journal.recovery) check(journal.recovery.state === 'confirmed', 'LEGACY_INSTALLER_RECOVERY_UNKNOWN', aid);
      check(!['recovery-unknown', 'recovery-unknown-outcome'].includes(journal.monitorStopped) &&
        !['recovery-unknown', 'frozen-after-unknown-outcome', 'fault-recorded-after-unknown'].includes(journal.recoveryResult),
      'LEGACY_MONITOR_ORIGINAL_RESULT_UNKNOWN', aid);
    }
    for (const recovery of t.recoveries.filter(r => r.instance_id === id)) {
      check(attemptIds.has(recovery.triggering_attempt_id) && recovery.state === 'recovery-confirmed',
        'LEGACY_RECOVERY_NOT_CONFIRMED', recovery.recovery_attempt_id);
      const plan = parsed(recovery.plan), { planDigest, ...facts } = plan;
      check(planDigest === recovery.plan_digest && digest(facts) === planDigest,
        'LEGACY_RECOVERY_PLAN_UNPROVEN', recovery.recovery_attempt_id);
    }
    for (const [name, rows] of [['coordinator-handoff', t.handoffs], ['role-handoff', t.roleHandoffs], ['coordinator-recovery', t.coordinatorRecoveries]]) {
      for (const row of rows) {
        const aid = row.attempt_id ?? row.triggering_attempt_id;
        const original = name === 'coordinator-recovery' ? t.recoveries.find(r => r.recovery_attempt_id === row.recovery_attempt_id)
          : attempts.find(a => a.attempt_id === aid), expectedPlan = original &&
            (name === 'coordinator-recovery' ? original.plan_digest : parsed(original.plan).planDigest);
        check(attemptIds.has(aid) && row.operation_id && row.plan_digest === expectedPlan && row.stage === 'adopted' && row.evidence,
          'LEGACY_' + name.toUpperCase().replaceAll('-', '_') + '_UNSETTLED', row.operation_id);
        if (row.stage === 'adopted' && row.evidence) {
          const result = parsed(row.evidence);
          check(result.qualified === true && (row.kind === 'installer' ? result.authorityTransferred === true :
            result.originalResourcesPreserved === true) && (name === 'role-handoff' || result.singleWriter === true),
            'LEGACY_HANDOFF_ORIGINAL_RESULT_UNQUALIFIED', row.operation_id);
        }
      }
    }
    for (const row of t.migrations) check(attemptIds.has(row.attempt_id) && row.stage === 'complete' && row.degraded === 0,
      'LEGACY_MIGRATION_UNSETTLED', row.plan_digest);
    const retirement = new Map(inventory.retirementFiles.map(file => [file.path.split('/').at(-1), file.value]));
    for (const row of t.contracts.filter(r => r.instance_id === id)) {
      const result = parsed(row.result), plan = result?.plan, command = result?.command;
      check(result?.attempt?.contractAttemptId === row.operation_id && result.attempt.instanceId === id &&
        result.fence === row.fence && digest(command) === row.request_digest && result.attempt.state === row.state,
      'LEGACY_CONTRACT_ORIGINAL_RESULT_UNPROVEN', row.operation_id);
      check(row.state === 'completed', 'LEGACY_CONTRACT_UNSETTLED', row.operation_id);
      if (plan) { const { planDigest, ...facts } = plan;check(planDigest === digest(facts), 'LEGACY_CONTRACT_PLAN_UNPROVEN', row.operation_id); }
      else block('LEGACY_CONTRACT_PLAN_UNPROVEN', row.operation_id);
      check(plan && result.attempt.targetPlanDigest === plan.planDigest && attemptIds.has(result.expandAttemptId) &&
        t.migrations.some(m => m.attempt_id === result.expandAttemptId && m.plan_digest === plan.expandPlanDigest &&
          m.stage === 'complete' && m.degraded === 0 && m.read_epoch >= 1),
      'LEGACY_CONTRACT_EXPAND_RESULT_REQUIRED', row.operation_id);
      for (const reader of result?.readers ?? []) {
        const receipt = result.retirementReceipts?.[reader.readerId], original = retirement.get(reader.readerId + '.retired.json');
        check(receipt && original && original.contractAttemptId === row.operation_id && original.readerId === reader.readerId &&
          original.startIdentity === reader.startIdentity && original.operationId === row.operation_id + ':retire:' + reader.readerId &&
          original.retired === true && original.originalResourcesPreserved === true &&
          receipt.lookup?.operationId === original.operationId && receipt.lookup?.contractAttemptId === row.operation_id &&
          receipt.startIdentity === original.startIdentity && receipt.retired === true,
        'LEGACY_RETIREMENT_ORIGINAL_RESULT_UNKNOWN', reader.readerId);
      }
    }
    for (const [name, original] of retirement) {
      check(t.contracts.some(row => row.operation_id === original.contractAttemptId),
        'LEGACY_RETIREMENT_ORIGINAL_CONTRACT_MISSING', original.operationId);
      if (name.endsWith('.intent.json'))
        check(retirement.has(name.replace(/\.intent\.json$/, '.retired.json')), 'LEGACY_RETIREMENT_INTENT_UNCLOSED', original.operationId);
      else check(name.endsWith('.retired.json'), 'LEGACY_RETIREMENT_RESULT_UNKNOWN', original.operationId);
    }
    for (const file of inventory.processFiles) {
      const record = file.value, processId = record.attemptId + ':' + record.kind;
      const attempt = attempts.find(a => a.attempt_id === record.attemptId), expectedComponent = attempt && parsed(attempt.manifest).manifest.components[record.kind];
      check(record.instanceId === id && attemptIds.has(record.attemptId) && record.state === 'started' &&
        file.path.split('/').at(-1) === record.attemptId + '-' + record.kind + '.json',
        'LEGACY_SUPERVISOR_START_UNKNOWN', processId);
      check(expectedComponent && record.artifactDigest === expectedComponent.artifactDigest &&
        record.inputFingerprint === expectedComponent.inputFingerprint, 'LEGACY_SUPERVISOR_TARGET_CHANGED', processId);
      const observed = proof?.processes?.find(p => p.containerId === record.containerId && p.startIdentity === record.startIdentity);
      check(observed && identityKeys.every(k => record[k] && record[k] === observed[k]) &&
        (observed.running === true && Number.isSafeInteger(observed.pid) && observed.pid > 0 ||
          observed.running === false && observed.pid === 0 && observed.exitCode === 0 && observed.oomKilled === false && observed.restartCount === 0),
      'LEGACY_SUPERVISOR_PROCESS_STATE_UNPROVEN', processId);
      const kind = { api: 'candidate', web: 'web', coordinator: 'coordinator-handoff', owner: 'owner-candidate', installer: 'installer-handoff' }[record.kind];
      const plan = attempts.find(a => a.attempt_id === record.attemptId);
      const expected = plan && parsed(plan.plan).steps.find(s => s.kind === kind);
      check(expected && steps.get(record.attemptId + ':' + expected.stepId)?.applied === 1,
        'LEGACY_SUPERVISOR_DISPATCH_RESULT_MISSING', processId);
    }
    const authority = inventory.authority?.value;
    if (authority?.attemptId) {
      const adopted = t.roleHandoffs.find(r => r.attempt_id === authority.attemptId && r.kind === 'installer' && r.stage === 'adopted');
      check(adopted && authority.instanceId === id && identityKeys.every(k => authority[k] === installer?.[k]) &&
        identityKeys.every(k => parsed(adopted.candidate)[k] === authority[k]), 'LEGACY_INSTALLER_AUTHORITY_UNSETTLED', authority.attemptId);
    } else if (authority) check(authority.instanceId === id && authority.startIdentity === installer?.startIdentity,
      'LEGACY_INSTALLER_AUTHORITY_CHANGED');
    for (const row of t.roleHandoffs.filter(r => r.kind === 'installer'))
      check(authority?.attemptId === row.attempt_id || t.roleHandoffs.some(later => later.kind === 'installer' &&
        later.stage === 'adopted' && authority?.attemptId === later.attempt_id &&
        attempts.find(a => a.attempt_id === later.attempt_id)?.generation > attempts.find(a => a.attempt_id === row.attempt_id)?.generation),
      'LEGACY_INSTALLER_ACTIVATION_RESULT_MISSING', row.operation_id);
    const bootstrap = attempts.length === 0 && t.contracts.length === 0 && t.recoveries.length === 0 && t.handoffs.length === 0 &&
      t.roleHandoffs.length === 0 && t.coordinatorRecoveries.length === 0 && t.migrations.length === 0 &&
      inventory.journals.length === 0 && inventory.processFiles.length === 0 && inventory.retirementFiles.length === 0 && !authority?.attemptId;
    return { schemaVersion: 1, kind: 'legacy-upgrade-settlement', instanceId: id,
      decision: blockers.length ? 'blocked' : 'settled', settled: blockers.length === 0,
      mode: bootstrap ? 'bootstrap-empty' : 'original-results', blockers, resolved,
      inventoryDigest: digest(inventory), observedAt: inventory.observedAt,
      adoptionAuthorized: false, requiresActualRuntimeClosureVerification: true,
      assumption: 'single-administrator-has-paused-new-upgrade-and-contract-intents',
      lifecycleCalls: 0, legacyRpcCalls: 0, databaseWrites: 0, journalWrites: 0 };
  } catch (error) {
    block(error.code || 'LEGACY_SETTLEMENT_EVIDENCE_INVALID');
    return { schemaVersion: 1, kind: 'legacy-upgrade-settlement', instanceId: inventory?.instanceId ?? null,
      decision: 'blocked', settled: false, mode: 'unknown', blockers, resolved: [], adoptionAuthorized: false,
      lifecycleCalls: 0, legacyRpcCalls: 0, databaseWrites: 0, journalWrites: 0 };
  }
}

/** Only this read path creates a preflight observation. The pure validator is
 * also exported for offline diagnosis, but arbitrary saved JSON is not an actual
 * observation of the current installation. Neither function grants admission.
 */
export async function observeLegacySettlement(config, ports = {}) {
  const inventory = await collectLegacySettlementInventory({ ...config, ...ports });
  const result = freeze({ schemaVersion: 1, kind: 'readonly-legacy-settlement-observation',
    instanceId: inventory.instanceId, inventory,
    settlement: validateLegacySettlement(inventory, { clock: ports.clock ?? config.clock ?? Date.now }) });
  collectedObservations.add(result);
  return result;
}

export function legacySettlementPrecondition(observation, { instanceId, clock = Date.now } = {}) {
  invariant(collectedObservations.has(observation) && observation.instanceId === instanceId,
    'CONTROL_ADOPTION_LEGACY_SETTLEMENT_OBSERVATION_REQUIRED');
  return freeze(validateLegacySettlement(observation.inventory, { clock }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const config = (await json(resolve(process.argv[2]))).value;
    const inventory = await collectLegacySettlementInventory(config);
    const result = validateLegacySettlement(inventory);
    process.stdout.write(canonical(result) + '\n');
    if (!result.settled) process.exitCode = 78;
  } catch (error) {
    process.stdout.write(canonical({ kind: 'legacy-upgrade-settlement', decision: 'blocked', settled: false,
      blockers: [{ code: error.code || 'LEGACY_SETTLEMENT_READ_UNAVAILABLE' }], adoptionAuthorized: false }) + '\n');
    process.exitCode = 78;
  }
}
