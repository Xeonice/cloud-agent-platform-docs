import * as fs from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { atomicJson, secureDirectory } from './io.mjs';
import { canonical, digest, invariant, verifySignedManifest } from './trust.mjs';
import { createPrivateControlRpc, privateLoopbackOrigin } from './control-rpc.mjs';
import { createControlAdoptionReservation, validateControlAdoptionAttachSpec } from './control-adoption-reservation.mjs';

const BASE = '/internal/upgrade-control-attachment';
const copy = value => JSON.parse(canonical(value));
const exact = (v, keys) => v && Object.getPrototypeOf(v) === Object.prototype && Object.keys(v).sort().join(',') === [...keys].sort().join(',');
const positive = v => Number.isSafeInteger(v) && v > 0;
const code = e => /^[A-Z][A-Z0-9_]{0,100}$/.test(e?.code ?? '') ? e.code : 'CONTROL_ADOPTION_UNCONFIRMED';
async function databaseFactory() {
  // Installer packages live beside api/. The second location is only the
  // development checkout layout. An existing invalid package never falls back.
  for (const relative of ['../api/package.json', '../../api/package.json']) {
    const path = fileURLToPath(new URL(relative, import.meta.url)); let stat;
    try { stat = await fs.lstat(path); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    invariant(stat.isFile() && !stat.isSymbolicLink() && await fs.realpath(path) === path, 'CONTROL_ADOPTION_API_PACKAGE_INVALID');
    return createRequire(path)('better-sqlite3');
  }
  invariant(false, 'CONTROL_ADOPTION_API_PACKAGE_REQUIRED');
}

/** Fixed maintenance attachment only. Startup configuration is written by the
 * trusted deployment before the API reads it; this factory cannot write startup
 * specs, execute a command, change Entry, or activate ordinary Control authority.
 * exportPassive is an external, actual live-export boundary. settlementObserver
 * must observe all original legacy callers/dispatches, not infer them from idle
 * SQLite. Neither boundary has a successful default.
 *
 * A private fsynced state file records dispatch BEFORE HTTP. After any unknown
 * POST, including a known rejection, another run/session may only GET that
 * command. A missing GET receipt never authorizes a second POST. A crash leaving
 * the exclusive lock also requires manual custody review; it is not auto-broken.
 */
export function createControlAdoptionAttachment({ coordinatorOrigin, internalKey, instanceId,
  freezeConfiguration, trustRoot, statePath, exportPassive, settlementObserver,
  clock = Date.now, fetcher = fetch, rpcTimeoutMs = 2000 }) {
  const origin = privateLoopbackOrigin(coordinatorOrigin), fixed = copy(freezeConfiguration), roots = copy(trustRoot);
  const plan = fixed.spec, freezeDigest = digest(plan);
  invariant(exact(plan, ['schemaVersion', 'kind', 'instanceId', 'operationId', 'commandId', 'deadline', 'source', 'target']) &&
    plan.schemaVersion === 1 && plan.kind === 'legacy-control-admission-freeze' && plan.instanceId === instanceId &&
    positive(plan.deadline) && typeof exportPassive === 'function' && typeof settlementObserver === 'function' &&
    typeof statePath === 'string' && isAbsolute(statePath) && resolve(statePath) === statePath,
  'CONTROL_ADOPTION_ATTACHMENT_CONFIG_REQUIRED');
  // Reuse the API-compatible attach schema for all common strict scope fields.
  validateControlAdoptionAttachSpec({ ...plan, kind: 'legacy-control-ledger-attach', epoch: 1, executorId: 'validation-only',
    freezeReceiptDigest: digest('validation-only'), controlDatabase: { path: '/validation-only', dev: '0', ino: '0' },
    settlement: { operationId: plan.operationId, commandId: plan.commandId === 'validation-settlement' ? 'validation-other' : 'validation-settlement' } });
  invariant(Number.isFinite(rpcTimeoutMs) && rpcTimeoutMs > 0 && rpcTimeoutMs <= 120000, 'CONTROL_ADOPTION_RPC_BUDGET_INVALID');
  const statusRpc = createPrivateControlRpc({ origin, instanceId, key: internalKey, fetcher, timeoutMs: rpcTimeoutMs });
  let inFlight;
  const live = deadline => invariant(deadline > clock(), 'CONTROL_ADOPTION_ORIGINAL_DEADLINE_EXPIRED');
  function target(configuration) {
    const trusted = verifySignedManifest(configuration.signedManifest, roots, clock()), m = trusted.manifest;
    invariant((trusted.purpose !== 'qualification' || (roots.qualificationInstanceId === instanceId && m.qualification.instanceId === instanceId)) &&
      trusted.manifestDigest === plan.target.signedManifestDigest &&
      m.components.api.artifactDigest === plan.target.apiArtifactDigest &&
      m.components.coordinator.artifactDigest === plan.target.coordinatorArtifactDigest && m.commits.project === plan.target.projectRevision &&
      m.controlPackage?.manifestDigest === plan.target.controlPackageDigest, 'CONTROL_ADOPTION_SIGNED_TARGET_CHANGED');
  }
  function frozen(value) {
    const fields = ['schemaVersion', 'kind', 'instanceId', 'operationId', 'commandId', 'specDigest', 'sourceConfirmedDigest',
      'admissionRevision', 'legacyLedgerEpoch', 'frozenAt', 'businessWriterGeneration', 'businessWriterFence'];
    const facts = Object.fromEntries(fields.map(k => [k, value?.[k]]));
    invariant(value && value.schemaVersion === 1 && value.kind === 'legacy-control-admission-frozen' &&
      value.instanceId === instanceId && value.operationId === plan.operationId && value.commandId === plan.commandId &&
      value.specDigest === freezeDigest && value.sourceConfirmedDigest === plan.source.confirmedDigest &&
      value.businessWriterGeneration === plan.source.businessWriterGeneration && value.businessWriterFence === plan.source.businessWriterFence &&
      value.admissionRevision === 1 && positive(value.legacyLedgerEpoch) && Number.isSafeInteger(value.frozenAt) && value.frozenAt <= clock() &&
      digest(facts) === value.receiptDigest, 'CONTROL_ADOPTION_FREEZE_RECEIPT_INVALID');
    return { ...facts, receiptDigest: value.receiptDigest };
  }
  function statusSource(status, receipt) {
    invariant(status?.admissionClosed === true && status.active === 0 &&
      canonical(frozen(status.freeze)) === canonical(receipt) &&
      status.businessWriter?.generation === plan.source.businessWriterGeneration && status.businessWriter?.fence === plan.source.businessWriterFence,
    'CONTROL_ADOPTION_ACTUAL_SOURCE_UNCONFIRMED');
  }
  function attachedResult(actual, spec, receipt, settlementResultDigest) {
    const attached = actual.attachment, result = attached?.attachedReceipt;
    invariant(actual.readonly === true && attached.phase === 'attached' && attached.attachSpecDigest === digest(spec) &&
      exact(result, ['schemaVersion', 'kind', 'instanceId', 'operationId', 'commandId', 'specDigest', 'freezeReceiptDigest',
        'settlementResultDigest', 'readonly', 'businessWriter', 'controlActivated', 'authorizesEntryMutation']) &&
      attached.resultDigest === digest(result) && result.schemaVersion === 1 && result.kind === 'legacy-control-ledger-attached' &&
      result.instanceId === instanceId && result.operationId === spec.operationId && result.commandId === spec.commandId &&
      result.specDigest === digest(spec) && result.freezeReceiptDigest === receipt.receiptDigest && result.settlementResultDigest === settlementResultDigest &&
      result.readonly === true && result.controlActivated === false && result.authorizesEntryMutation === false &&
      exact(result.businessWriter, ['generation', 'fence']) && canonical(result.businessWriter) === canonical(actual.businessWriter),
    'CONTROL_ADOPTION_ATTACH_ACK_UNKNOWN');
    return result;
  }
  async function owned(path, missing = false) {
    try {
      const s = await fs.lstat(path);
      invariant(s.isFile() && !s.isSymbolicLink() && s.nlink === 1 && (s.mode & 0o077) === 0 &&
        (!process.getuid || s.uid === process.getuid()) && await fs.realpath(path) === path, 'CONTROL_ADOPTION_STATE_CUSTODY_INVALID');
    } catch (e) { if (!(missing && e.code === 'ENOENT')) throw e; }
  }
  async function until(deadline, work) {
    live(deadline);
    const controller = new AbortController(); let timer;
    try {
      return await Promise.race([Promise.resolve().then(() => work(controller.signal)), new Promise((_, reject) => {
        timer = setTimeout(() => { const e = Object.assign(Error('Original deadline expired'), { code: 'CONTROL_ADOPTION_ORIGINAL_DEADLINE_EXPIRED' }); controller.abort(e); reject(e); }, deadline - clock());
      })]);
    } finally { clearTimeout(timer); }
  }
  async function execute() {
    await secureDirectory(dirname(statePath));
    const parent = await fs.lstat(dirname(statePath));
    invariant((parent.mode & 0o077) === 0 && (!process.getuid || parent.uid === process.getuid()), 'CONTROL_ADOPTION_STATE_CUSTODY_INVALID');
    await owned(statePath, true);
    let lock;
    try { lock = await fs.open(statePath + '.lock', 'wx', 0o600); }
    catch (e) { if (e.code === 'EEXIST') return { state: 'manual-review', reason: 'CONTROL_ADOPTION_STATE_LOCKED', operationId: plan.operationId }; throw e; }
    let state = { schemaVersion: 1, operationId: plan.operationId, freezeSpecDigest: freezeDigest, coordinatorOrigin: origin, phase: 'new' };
    let sqlite, opened = false, stateAccepted = false;
    async function save(patch) {
      state = { ...state, ...patch }; await owned(statePath, true); await atomicJson(statePath, state);
    }
    const manual = reason => ({ state: 'manual-review', reason, operationId: plan.operationId, phase: state.phase,
      freezeSent: state.freezeSent === true, attachSent: state.attachSent === true, controlActivated: false, authorizesEntryMutation: false });
    try {
      await lock.writeFile(canonical({ operationId: plan.operationId, freezeSpecDigest: freezeDigest })); await lock.sync();
      try { state = JSON.parse(await fs.readFile(statePath, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      invariant(state.schemaVersion === 1 && state.operationId === plan.operationId && state.freezeSpecDigest === freezeDigest && state.coordinatorOrigin === origin,
        'CONTROL_ADOPTION_ORIGINAL_STATE_CONFLICT');
      stateAccepted = true;
      let actual = await statusRpc(BASE); // GET remains legal after the original deadline.
      if (state.phase === 'completed') {
        const spec = validateControlAdoptionAttachSpec(state.attachConfiguration.spec), receipt = frozen(state.freezeReceipt);
        invariant(spec.instanceId === instanceId && spec.operationId === plan.operationId && spec.deadline <= plan.deadline &&
          spec.freezeReceiptDigest === receipt.receiptDigest && canonical(spec.source) === canonical(plan.source) && canonical(spec.target) === canonical(plan.target),
        'CONTROL_ADOPTION_EXPORTED_SCOPE_CHANGED');
        statusSource(actual, receipt);
        const result = attachedResult(actual, spec, receipt, state.attachedReceipt?.settlementResultDigest), completed = state.completion;
        invariant(exact(completed, ['schemaVersion', 'kind', 'instanceId', 'operationId', 'specDigest', 'attachedReceiptDigest', 'settlementResultDigest',
          'controlMode', 'businessWriterPreserved', 'completedAt', 'receiptDigest']) && canonical(state.attachedReceipt) === canonical(result),
        'CONTROL_ADOPTION_COMPLETION_UNCONFIRMED');
        const { receiptDigest, ...facts } = completed;
        invariant(digest(facts) === receiptDigest && completed.schemaVersion === 1 && completed.kind === 'legacy-control-adoption-reservation-completed' &&
          completed.instanceId === instanceId && completed.operationId === spec.operationId && completed.specDigest === digest(spec) &&
          completed.attachedReceiptDigest === digest(result) && completed.settlementResultDigest === result.settlementResultDigest &&
          completed.controlMode === 'passive' && completed.businessWriterPreserved === true && Number.isSafeInteger(completed.completedAt) &&
          completed.completedAt >= receipt.frozenAt && completed.completedAt <= clock(), 'CONTROL_ADOPTION_COMPLETION_UNCONFIRMED');
        return { state: 'completed', receipt: completed, controlActivated: false, authorizesEntryMutation: false };
      }
      live(plan.deadline); target(fixed);
      if (!state.freezeReceipt) {
        if (state.freezeSent) return manual('CONTROL_ADOPTION_FREEZE_ACK_UNKNOWN');
        invariant(!actual.freeze && actual.readonly === false, 'CONTROL_ADOPTION_UNOWNED_FREEZE');
        await save({ phase: 'freeze-sent', freezeSent: true }); live(plan.deadline);
        const ack = await createPrivateControlRpc({ origin, instanceId, key: internalKey, fetcher,
          timeoutMs: Math.min(rpcTimeoutMs, plan.deadline - clock()) })(BASE + '/freeze',
          { operationId: plan.operationId, commandId: plan.commandId, specDigest: freezeDigest });
        const receipt = frozen(ack);
        invariant(ack.localLegacyWorkSettled === true && ack.authorizesEntryMutation === false && ack.controlActivated === false,
          'CONTROL_ADOPTION_FREEZE_ACK_UNCONFIRMED');
        await save({ phase: 'frozen', freezeReceipt: receipt });
        actual = await statusRpc(BASE);
      }
      const receipt = frozen(state.freezeReceipt); statusSource(actual, receipt); live(plan.deadline);
      if (!state.attachConfiguration) {
        if (state.exportStarted) return manual('CONTROL_ADOPTION_EXPORT_RESULT_UNKNOWN');
        await save({ phase: 'export-started', exportStarted: true }); live(plan.deadline);
        const exported = await until(plan.deadline, signal => exportPassive({ freezeReceipt: copy(receipt), freezeConfiguration: copy(fixed), deadline: plan.deadline, signal }));
        sqlite = exported?.sqlite;
        invariant(sqlite && sqlite.readonly === false && typeof sqlite.prepare === 'function', 'CONTROL_ADOPTION_ACTUAL_EXPORT_REQUIRED');
        const configuration = copy(exported.attachConfiguration), spec = validateControlAdoptionAttachSpec(configuration.spec);
        invariant(spec.instanceId === instanceId && spec.operationId === plan.operationId && spec.deadline <= plan.deadline && spec.freezeReceiptDigest === receipt.receiptDigest &&
          canonical(spec.source) === canonical(plan.source) && canonical(spec.target) === canonical(plan.target), 'CONTROL_ADOPTION_EXPORTED_SCOPE_CHANGED');
        target(configuration); live(plan.deadline); live(spec.deadline);
        await save({ phase: 'exported', attachConfiguration: configuration });
      }
      const configuration = state.attachConfiguration, spec = validateControlAdoptionAttachSpec(configuration.spec);
      invariant(spec.instanceId === instanceId && spec.operationId === plan.operationId && spec.deadline <= plan.deadline && spec.freezeReceiptDigest === receipt.receiptDigest &&
        canonical(spec.source) === canonical(plan.source) && canonical(spec.target) === canonical(plan.target), 'CONTROL_ADOPTION_EXPORTED_SCOPE_CHANGED');
      live(spec.deadline); target(configuration);
      if (!sqlite) {
        const s = await fs.lstat(spec.controlDatabase.path, { bigint: true });
        invariant(s.isFile() && !s.isSymbolicLink() && (Number(s.mode) & 0o077) === 0 && (!process.getuid || s.uid === BigInt(process.getuid())) &&
          await fs.realpath(spec.controlDatabase.path) === spec.controlDatabase.path && String(s.dev) === spec.controlDatabase.dev && String(s.ino) === spec.controlDatabase.ino,
        'CONTROL_ADOPTION_LEDGER_IDENTITY_CHANGED');
        const Database = await databaseFactory(); sqlite = new Database(spec.controlDatabase.path, { fileMustExist: true }); opened = true;
      }
      let observation;
      const reservation = createControlAdoptionReservation({ sqlite, instanceId, epochFloor: 0, clock,
        validateIntent(input) {
          target(configuration); statusSource(actual, receipt);
          invariant(canonical(input) === canonical(spec), 'CONTROL_ADOPTION_EXPORTED_SCOPE_CHANGED');
          return { instanceId, operationId: spec.operationId, specDigest: digest(spec), freezeReceiptDigest: receipt.receiptDigest };
        }, validateAttached: () => observation });
      reservation.reserve(spec);
      const auth = () => { live(plan.deadline); live(spec.deadline); return reservation.authorization(spec.operationId); };
      const common = commandId => ({ operationId: spec.operationId, commandId, authorization: auth() });
      const settlement = reservation.settlementSpec(spec.operationId);
      function validateSettlement(proof) {
        invariant(exact(proof, ['schemaVersion', 'kind', 'instanceId', 'operationId', 'freezeReceiptDigest', 'sourceConfirmedDigest',
          'localAdmissionClosed', 'legacyCallersClosed', 'originalDispatchesSettled', 'qualified', 'observedAt', 'receiptDigest']), 'CONTROL_ADOPTION_ACTUAL_SETTLEMENT_REQUIRED');
        const { receiptDigest, ...facts } = proof;
        invariant(proof.schemaVersion === 1 && proof.kind === 'legacy-control-settlement' && proof.instanceId === instanceId && proof.operationId === spec.operationId &&
          proof.freezeReceiptDigest === receipt.receiptDigest && proof.sourceConfirmedDigest === plan.source.confirmedDigest && proof.localAdmissionClosed === true &&
          proof.legacyCallersClosed === true && proof.originalDispatchesSettled === true && proof.qualified === true && Number.isSafeInteger(proof.observedAt) &&
          proof.observedAt >= receipt.frozenAt && proof.observedAt <= clock() && digest(facts) === receiptDigest, 'CONTROL_ADOPTION_ACTUAL_SETTLEMENT_REQUIRED');
      }
      let settled = reservation.journal.lookup(settlement);
      if (settled?.state !== 'applied') {
        if (settled && settled.state !== 'planned') return manual('CONTROL_ADOPTION_SETTLEMENT_UNCONFIRMED');
        reservation.journal.prepare({ ...common(settlement.commandId), stepId: 'legacy-control-settlement', spec: settlement });
        reservation.journal.begin(common(settlement.commandId));
        const proof = await until(Math.min(plan.deadline, spec.deadline), signal => settlementObserver({ spec: copy(spec), freezeReceipt: copy(receipt), status: copy(actual), deadline: spec.deadline, signal }));
        auth();
        validateSettlement(proof);
        settled = reservation.journal.record({ ...common(settlement.commandId), state: 'applied', result: proof });
      }
      validateSettlement(settled.result);
      const input = { operationId: spec.operationId, commandId: spec.commandId, specDigest: digest(spec), settlementResultDigest: digest(settled.result) };
      let command = reservation.journal.lookup(spec);
      if (!state.attachSent && command.state === 'planned') {
        reservation.journal.begin(common(spec.commandId));
        await save({ phase: 'attach-sent', attachSent: true }); auth();
        // An unknown response is left executing; no path below ever sends again.
        await createPrivateControlRpc({ origin, instanceId, key: internalKey, fetcher,
          timeoutMs: Math.min(rpcTimeoutMs, plan.deadline - clock(), spec.deadline - clock()) })(BASE + '/attach', input);
      }
      actual = await statusRpc(BASE); statusSource(actual, receipt);
      const result = attachedResult(actual, spec, receipt, input.settlementResultDigest);
      if (reservation.read(spec.operationId).state === 'attached')
        invariant(command.state === 'applied' && canonical(command.result) === canonical(result), 'CONTROL_ADOPTION_ATTACHED_RECEIPT_CHANGED');
      else { auth(); command = reservation.journal.record({ ...common(spec.commandId), state: 'applied', result }); }
      observation = { instanceId, operationId: spec.operationId, specDigest: digest(spec), attachedReceiptDigest: digest(command.result),
        readonly: true, businessWriter: actual.businessWriter, observedAt: clock() };
      const completion = reservation.complete(spec.operationId);
      await save({ phase: 'completed', completion, attachedReceipt: result });
      return { state: 'completed', receipt: completion, controlActivated: false, authorizesEntryMutation: false };
    } catch (e) {
      // Preserve every dispatch marker; no reverse rollback or lease refresh.
      if (stateAccepted) await save({ lastError: code(e) }); return manual(code(e));
    } finally {
      if (opened) sqlite?.close(); await lock.close(); await fs.unlink(statePath + '.lock');
    }
  }
  return { observe: () => statusRpc(BASE), run: () => inFlight ??= execute().finally(() => { inFlight = undefined; }) };
}
