import { createRequire } from 'node:module';
import { join } from 'node:path';
import { chmod } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { secureDirectory } from './io.mjs';
import { invariant, digest } from './trust.mjs';
import { createControlAuthority } from './control-authority.mjs';
import { createControlCommandJournal } from './control-command-journal.mjs';
import { createControlRecoveryStore } from './control-recovery-store.mjs';
import { createControlAccessAuthority } from './control-access-authority.mjs';
import { createControlSecurity } from './control-security.mjs';
import { createEntryContextVerifier } from './control-entry-context.mjs';
import { createCoordinatorClient } from './coordinator-client.mjs';
import { createControlInspectorClient } from './control-inspector-client.mjs';
import { createControlHttpServer } from './control-http.mjs';
import { createControlDiagnostics } from './control-diagnostics.mjs';

/** No AppModule, business connection, provider registry or SDK is constructed. */
export async function assembleControlRuntime({ config: c, verifiedPackage, engineIdentity, Database, participantsFactory, executionFactory, contractBusinessFactory, signal, onEvent }) {
  invariant(c?.instanceId && verifiedPackage?.artifactRoot && verifiedPackage.apiRoot && engineIdentity?.artifactDigest === verifiedPackage.executionEngineDigest && typeof participantsFactory === 'function' && typeof executionFactory === 'function', 'CONTROL_RUNTIME_CONFIG_REQUIRED');
  invariant(c.accessAuthorityKey?.length >= 32 && c.businessKey?.length >= 32 && c.accessAuthorityKey !== c.controllerKey && c.businessKey !== c.controllerKey, 'CONTROL_ACCESS_ROLE_KEY_MUST_BE_SEPARATE');
  invariant(process.env.PLATFORM_PROCESS_ROLE === 'upgrade-control', 'CONTROL_RUNTIME_PROCESS_ROLE_REQUIRED');
  invariant(!signal?.aborted, 'CONTROL_RUNTIME_STOPPED');
  const startupCleanup = [];
  try {
  const root = await secureDirectory(c.controlRoot), ledgerRoot = await secureDirectory(c.controlLedgerRoot), authRoot = await secureDirectory(join(root, 'auth'));
  invariant(ledgerRoot !== root && !ledgerRoot.startsWith(root + '/') && !root.startsWith(ledgerRoot + '/'), 'CONTROL_LEDGER_AND_PRIVATE_ROOT_MUST_BE_SEPARATE');
  const requireApi = createRequire(join(verifiedPackage.apiRoot, 'apps/api/package.json'));
  if (!Database) Database = requireApi('better-sqlite3');
  const sqlite = new Database(join(ledgerRoot, 'control.db'));
  startupCleanup.push(() => { if (sqlite.open) sqlite.close(); });
  const accessSqlite = new Database(join(authRoot, 'access.db'));
  startupCleanup.push(() => { if (accessSqlite.open) accessSqlite.close(); });
  await chmod(join(ledgerRoot, 'control.db'), 0o600); await chmod(join(authRoot, 'access.db'), 0o600);
  for (const db of [sqlite, accessSqlite]) { db.pragma('journal_mode = WAL'); db.pragma('busy_timeout = 50'); db.pragma('foreign_keys = ON'); }
  const clock = { now: () => new Date() }, ids = { next: () => randomUUID() };
  const { createUpgradeControlStores } = requireApi(join(verifiedPackage.apiRoot, 'apps/api/dist/platform/upgrade/control-store-factory.js'));
  const { UpgradeService } = requireApi(join(verifiedPackage.apiRoot, 'apps/api/dist/platform/upgrade/upgrade-service.js'));
  const { UpgradeCatalog } = requireApi(join(verifiedPackage.apiRoot, 'apps/api/dist/platform/upgrade/upgrade-catalog.js'));
  const { UpgradeProjection } = requireApi(join(verifiedPackage.apiRoot, 'apps/api/dist/platform/upgrade/upgrade-projection.js'));
  const { UpgradeContractService } = requireApi(join(verifiedPackage.apiRoot, 'apps/api/dist/platform/upgrade/upgrade-contract-service.js'));
  const schemas = requireApi('@platform/contracts');
  let journal, inspector, stores, participants, execution, listener, metadataTask = null, operationTask = null, stopped = false;
  const recoveryStore = createControlRecoveryStore({ sqlite, instanceId: c.instanceId });
  const authority = createControlAuthority({ sqlite, instanceId: c.instanceId, epochFloor: c.epochFloor ?? 0,
    validateRecovery(input) {
      const intent = recoveryStore.read(input.operationId);
      invariant(intent && !['blocked', 'recovered'].includes(intent.phase) && intent.deadline > Date.now() && intent.triggeringAttemptId === input.supersedes && intent.epoch === input.epoch, 'CONTROL_RECOVERY_INTENT_SCOPE_INVALID');
    } });
  journal = createControlCommandJournal({ sqlite, instanceId: c.instanceId, assertAuthority(a, command) {
    const current = authority.assert({ operationId: a.operationId ?? command.operationId, epoch: a.epoch, executorId: a.executorId });
    if (command.operationId !== current.operationId) {
      const intent = current.kind === 'recovery' ? recoveryStore.read(current.operationId) : null;
      invariant(['record', 'reconcile'].includes(command.journalAction) && intent?.triggeringAttemptId === command.operationId && intent.epoch === current.epoch && journal.lookup(command), 'CONTROL_OLD_COMMAND_RECONCILE_ONLY');
    }
  }, verifyRecoveryConfirmation(input) {
    const intent = recoveryStore.read(input.recoveryId);
    invariant(intent?.phase === 'recovered' && intent.confirmedAt !== null && intent.epoch === input.authorization.epoch && intent.triggeringAttemptId === input.command.operationId, 'CONTROL_RECOVERY_NOT_CONFIRMED');
    const row = sqlite.prepare('SELECT * FROM control_recovery_confirmations WHERE recovery_id=? AND instance_id=?').get(input.recoveryId, c.instanceId);
    invariant(row && row.epoch === intent.epoch && row.recovery_sequence === intent.sequence && row.receipt_digest === input.confirmationReceiptDigest && row.confirmed_at === intent.confirmedAt, 'CONTROL_RECOVERY_CONFIRMATION_NOT_PERSISTED');
    const proof = JSON.parse(row.receipt), { receiptDigest, ...facts } = proof;
    invariant(receiptDigest === row.receipt_digest && digest(facts) === receiptDigest && proof.planDigest === intent.planDigest, 'CONTROL_RECOVERY_CONFIRMATION_CORRUPT');
    return proof;
  } });
  const commandContext = new AsyncLocalStorage();
  const requestContext = () => commandContext.getStore();
  const withCommandContext = (context, work) => commandContext.run({ ...commandContext.getStore(), ...context }, work);
  const business = createCoordinatorClient({ origin: c.coordinatorOrigin, instanceId: c.instanceId, key: c.businessKey, bindingPath: c.coordinatorBindingPath, requestContext, independentControl:true });
  inspector = createControlInspectorClient({ client: business, instanceId: c.instanceId });
  stores = createUpgradeControlStores({ sqlite, instanceId: c.instanceId, clock, ids,
    claimGuard() {
      invariant(authority.observe().mode === 'active', 'CONTROL_PASSIVE_EXECUTION_FORBIDDEN');
      invariant(!recoveryStore.active(), 'CONTROL_RECOVERY_ALREADY_ACTIVE');
      return journal.pending().length ? { stage: 'original-command-reconciliation' } : null;
    },
    dataFormatGuard({ coordinatorDataFormats }) {
      invariant(!inspector.requiresProjectNameV2() || coordinatorDataFormats.includes('project-name-v2-authority'), 'TARGET_DATA_FORMAT_INCOMPATIBLE');
    } });
  // Private policy state is physically outside the directory mounted read-only
  // by business Coordinators. They receive neither signing secret nor hashes.
  const access = createControlAccessAuthority({ sqlite: accessSqlite, instanceId: c.instanceId, allowLoopback: c.accessAllowLoopback === true, cookieSecure: c.cookieSecure === true,
    envPasscode: process.env.ACCESS_PASSCODE, sessionSecretOverride: process.env.PASSCODE_COOKIE_SECRET, retainEnvironment: true });
  const security = createControlSecurity({ instanceId: c.instanceId, access, allowedOrigins: c.allowedOrigins ?? [] });
  const catalog = new UpgradeCatalog(stores.store, clock, inspector);
  const diagnostics = await createControlDiagnostics({ directory: join(root, 'diagnostics'), instanceId: c.instanceId,
    sampleProvider: async input => execution ? execution.sample(input) : [{ role: 'control', startIdentity: engineIdentity.startIdentity, state: 'alive', rssBytes: process.memoryUsage().rss }],
    isActive: () => Boolean(recoveryStore.active() || sqlite.prepare("SELECT 1 FROM upgrade_attempts WHERE instance_id=? AND state IN ('accepted','downloading','package-verified','migrating','prepared','candidate-ready','routing-switched','observing','api-activated') LIMIT 1").get(c.instanceId)), budgets: c.diagnosticBudgets });
  startupCleanup.push(() => diagnostics.close());
  participants = participantsFactory({ c, authority, business, sqlite, journal, stores });
  invariant(participants && typeof participants.admit === 'function', 'CONTROL_PARTICIPANT_ADMISSION_REQUIRED');
  let contracts;
  const projection = new UpgradeProjection(stores.store, catalog, inspector, clock);
  startupCleanup.push(() => projection.onModuleDestroy());
  function releaseTerminalAuthority() {
    const current = authority.observe();
    if (current.kind !== 'upgrade' || !current.holderId || current.leaseExpiresAt <= Date.now() || recoveryStore.active() || journal.pending().length) return;
    const attempt = stores.store.snapshot(current.operationId).attempt;
    if (['activation-confirmed', 'failed', 'deferred', 'candidate-rejected', 'reverted'].includes(attempt.state)) authority.release({ operationId: current.operationId, epoch: current.epoch, executorId: current.holderId });
  }
  class IndependentUpgradeService extends UpgradeService {
    request(req, res, command) {
      const principal = security.principal(req, res, c.instanceId);
      if (!stores.operations.replay(principal.actorId, command) && !stores.store.replay(principal.actorId, command)) {
        releaseTerminalAuthority(); stores.store.assertControlAdmissionAvailable();
      }
      return super.request(req, res, command);
    }
    async syncIntentBarrier(id) {
      const current = authority.observe();
      if (current.kind === 'upgrade' && current.operationId !== id && current.holderId && current.leaseExpiresAt > Date.now() && journal.pending().length === 0) {
        const old = stores.store.snapshot(current.operationId).attempt;
        if (['activation-confirmed', 'failed', 'deferred', 'candidate-rejected', 'reverted'].includes(old.state)) authority.release({ operationId: current.operationId, epoch: current.epoch, executorId: current.holderId });
      }
    }
    async claim(id, controllerId, leaseMs) {
      const claimed = sqlite.transaction(() => {
        const claimed = stores.store.claim(id, controllerId, leaseMs, authority.observe().epoch);
        authority.grant({ operationId: id, epoch: claimed.fence, executorId: controllerId, leaseMs, kind: 'upgrade' });
        return claimed;
      }).immediate();
      await participants.admit(authority.observe(), { attemptId: id, intentFence: claimed.fence });
      authority.assert({ operationId: id, epoch: claimed.fence, executorId: controllerId, kind: 'upgrade' });
      return claimed;
    }
    fallbackEligibility(id, fence) { return inspector.fallbackEligibility(id, fence); }
  }
  const service = new IndependentUpgradeService(stores.store, catalog, security, inspector, clock, undefined, stores.operations, projection);
  startupCleanup.push(() => service.onModuleDestroy());
  if (contractBusinessFactory) {
    const port = contractBusinessFactory({ c, sqlite, authority, journal, stores, participants, business, withCommandContext });
    class IndependentContractService extends UpgradeContractService {
      async performEntryFence(record) {
        invariant(execution && typeof execution.ensureContractAuthority === 'function', 'CONTROL_CONTRACT_EXECUTOR_NOT_READY');
        await execution.ensureContractAuthority(record);
        if (record.eligibility.entryFenceSynchronized === true) return record;
        return this.store.save(record, {}, { eligibility: { ...record.eligibility, entryFenceSynchronized: true } });
      }
      request(req, res, command) {
        const principal = security.principal(req, res, c.instanceId);
        if (!this.store.replay(principal.actorId, command)) { releaseTerminalAuthority(); stores.store.assertControlAdmissionAvailable(); }
        return super.request(req, res, command);
      }
    }
    contracts = new IndependentContractService(stores.contracts, port, inspector, security, clock);
    startupCleanup.push(() => contracts.onModuleDestroy());
    // Explicit injection avoids constructing the business contract service or SDK.
    Object.defineProperty(service, 'contracts', { value: contracts, enumerable: true });
    Object.defineProperty(projection, 'contracts', { value: contracts, enumerable: true });
  }
  const entryVerifier = createEntryContextVerifier({ instanceId: c.instanceId, key: c.privateEntryKey });
  const recoveryAuthority = ({ attemptId, recoveryId, epoch, fence }) => {
    const active = authority.assert({ operationId: recoveryId, epoch, kind: 'recovery' }), intent = recoveryStore.read(recoveryId);
    invariant(epoch === fence && intent?.triggeringAttemptId === attemptId && intent.epoch === epoch && !['blocked', 'recovered'].includes(intent.phase) && intent.deadline > Date.now(), 'CONTROL_RECOVERY_SCOPE_INVALID');
    const row = sqlite.prepare('SELECT target_digest,plan_digest,sequence,state,stage FROM upgrade_attempts WHERE attempt_id=? AND instance_id=?').get(attemptId, c.instanceId);
    invariant(row, 'CONTROL_RECOVERY_ATTEMPT_MISSING');
    return { instanceId: c.instanceId, attemptId, targetDigest: row.target_digest, planDigest: row.plan_digest,
      generation: epoch, sequence: row.sequence, state: row.state, stage: row.stage, fence: epoch, controllerId: active.holderId, leaseExpiresAt: active.leaseExpiresAt };
  };
  listener = await createControlHttpServer({ instanceId: c.instanceId, key: c.controllerKey, businessKey: c.businessKey, accessKey: c.accessAuthorityKey,
    access, service, store: stores.store, authority, schemas, verifyEntryRequest: req => entryVerifier.verify(req),
    claim: (...args) => service.claim(...args),
    renew(id, body) {
      return sqlite.transaction(() => {
        const current = authority.assert({ operationId: id, epoch: body.fence, executorId: body.controllerId, kind: 'upgrade' });
        const generation = body.generation ?? stores.store.authorityCheck(id, body.fence).generation;
        const receipt = stores.store.leaseRenew(id, body.fence, generation, body.controllerId);
        authority.renew({ operationId: id, epoch: body.fence, executorId: current.holderId, leaseMs: 30000 });
        return receipt;
      }).immediate();
    },
    criticalAuthority(id, body) {
      return sqlite.transaction(() => {
        const current = authority.assert({ operationId: id, epoch: body.fence, kind: 'upgrade' });
        stores.store.authorityCheck(id, body.fence, body.generation); stores.store.preserveCriticalAuthority(id, body.fence);
        const receipt = stores.store.authorityCheck(id, body.fence, body.generation);
        return { instanceId: c.instanceId, attemptId: id, ...body, leaseExpiresAt: Math.min(current.leaseExpiresAt, receipt.leaseExpiresAt) };
      }).immediate();
    },
    recoveryAuthority,
    metadata: () => ({ ...engineIdentity, observedAt: new Date().toISOString(), controlSystem: { version: verifiedPackage.version, protocolVersion: verifiedPackage.protocolVersion, packageDigest: verifiedPackage.packageDigest } }),
    contractAuthority(id, fence) {
      const current = authority.observe(), binding = sqlite.prepare('SELECT * FROM control_contract_authority WHERE contract_attempt_id=? AND instance_id=?').get(id, c.instanceId);
      invariant(current.kind === 'contract' && binding?.intent_fence === fence && binding.epoch === current.epoch && binding.executor_id === current.holderId, 'CONTROL_CONTRACT_AUTHORITY_SCOPE_INVALID');
      return authority.assert({ operationId: id, epoch: current.epoch, executorId: current.holderId, kind: 'contract' });
    },
    retireContractReader: body => execution.retireContractReader(body),
    recoveryStatus: () => recoveryStore.view(recoveryStore.active() ?? (stores.store.latest() ? recoveryStore.latest(stores.store.latest().attemptId) : null)),
    controlStatus: () => ({ version: verifiedPackage.version, protocolVersion: verifiedPackage.protocolVersion, state: authority.observe().mode === 'active' ? 'ready' : 'passive', observedAt: new Date().toISOString() }),
    diagnosticsStatus: () => execution?.diagnosticStatus?.() ?? null,
    onSpan: span => diagnostics.recordSpan(span), port: c.controlPort,
  });
  startupCleanup.push(() => listener.close());
  execution = await executionFactory({ c, verifiedPackage, engineIdentity, sqlite, stores, authority, recoveryStore, journal, inspector, business, requestContext, withCommandContext, service, participants, diagnostics, controlOrigin: listener.origin, signal, onEvent });
  invariant(execution && ['runOnce', 'sample', 'close'].every(name => typeof execution[name] === 'function'), 'CONTROL_EXECUTION_ASSEMBLY_REQUIRED');
  startupCleanup.push(() => execution.close());
  async function refreshMetadata() {
    if (metadataTask || stopped) return;
    metadataTask = inspector.refreshMetadata().then(() => { projection.schedule(); return catalog.refresh(); }).catch(() => {}).finally(() => { metadataTask = null; });
    return metadataTask;
  }
  async function tick() {
    if (operationTask || stopped || authority.observe().mode !== 'active') return;
    operationTask = Promise.resolve().then(async () => {
      await service.advanceOperation();
      if (contracts) await execution.tickContracts(contracts);
      return execution.runOnce();
    }).catch(error => { onEvent?.({ kind: 'control-error', code: /^[A-Z0-9_]{1,100}$/.test(error.code) ? error.code : 'CONTROL_UNKNOWN' }); }).finally(() => { operationTask = null; });
    return operationTask;
  }
  const metadataTimer = setInterval(() => { void refreshMetadata(); }, 1000), operationTimer = setInterval(() => { void tick(); }, 250);
  metadataTimer.unref(); operationTimer.unref(); diagnostics.startSampling(); void refreshMetadata(); void tick();
  startupCleanup.push(() => { stopped = true; clearInterval(metadataTimer); clearInterval(operationTimer); });
  let closing;
  async function close() {
    if (closing) return closing;
    stopped = true; clearInterval(metadataTimer); clearInterval(operationTimer); service.onModuleDestroy(); projection.onModuleDestroy(); contracts?.onModuleDestroy();
    closing = (async () => { await listener.close(); await execution.close(); await Promise.allSettled([metadataTask, operationTask]); await diagnostics.close(); accessSqlite.close(); sqlite.close(); })(); return closing;
  }
  signal?.addEventListener('abort', () => { void close(); }, { once: true });
  return { origin: listener.origin, store: stores.store, service, catalog, projection, authority, recoveryStore, journal, access, execution, close, tick, refreshMetadata,
    identity: { ...engineIdentity, controlSystem: { version: verifiedPackage.version, protocolVersion: verifiedPackage.protocolVersion, packageDigest: verifiedPackage.packageDigest } } };
  } catch (error) {
    for (const cleanup of startupCleanup.reverse()) { try { await cleanup(); } catch { /* preserve the startup error */ } }
    throw error;
  }
}
