import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createControlAuthority } from './control-authority.mjs';
import { createControlRecoveryStore } from './control-recovery-store.mjs';
import { createControlCommandJournal } from './control-command-journal.mjs';
import { createControlBusinessCommands } from './control-business-commands.mjs';

const require = createRequire(new URL('../../api/package.json', import.meta.url));
const Database = require('better-sqlite3');
const { withBusinessAction, readBusinessActionStatus } = require('./apps/api/dist/platform/upgrade/upgrade-business-action.js');
const { UpgradeError } = require('./apps/api/dist/platform/upgrade/upgrade-trust.js');
const deferred = () => { let resolve; const promise = new Promise(ok => { resolve = ok; }); return { promise, resolve }; };

test('actual API participant facts and Root command ledger agree across a running mutation, epoch revocation and lost acknowledgement', async t => {
  // API's production fact writer/reader and Root's production journal/wrapper
  // cross this boundary. The execution/UpgradeStore permission ports are explicit
  // fixtures; this is not Native process or original sandbox qualification.
  const directory = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'control-business-wire-')));
  await fs.chmod(directory, 0o700);
  const sqlite = new Database(join(directory, 'control.db'));
  const instanceId = 'business-wire-test', attemptId = '22222222-2222-4222-8222-222222222222', recoveryId = '11111111-1111-4111-8111-111111111111';
  const identity = { startIdentity: 'actual-participant-fixture', artifactDigest: 'sha256:' + 'a'.repeat(64) };
  const originalEnv = Object.fromEntries(['PLATFORM_COORDINATOR_BINDING_PATH', 'PLATFORM_PROCESS_START_IDENTITY', 'PLATFORM_ARTIFACT_DIGEST'].map(name => [name, process.env[name]]));
  process.env.PLATFORM_COORDINATOR_BINDING_PATH = join(directory, 'coordinator-binding.json');
  process.env.PLATFORM_PROCESS_START_IDENTITY = identity.startIdentity;
  process.env.PLATFORM_ARTIFACT_DIGEST = identity.artifactDigest;
  const release = deferred(), entered = deferred(); let pending;
  t.after(async () => {
    release.resolve(); await pending?.catch(() => {});
    for (const [name, value] of Object.entries(originalEnv)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    sqlite.close(); await fs.rm(directory, { recursive: true, force: true });
  });
  const clock = () => 1000, apiClock = { now: () => new Date(clock()) };
  const recoveryStore = createControlRecoveryStore({ sqlite, instanceId, clock });
  const authority = createControlAuthority({ sqlite, instanceId, clock, validateRecovery: input => {
    assert.equal(recoveryStore.read(input.operationId).triggeringAttemptId, input.supersedes);
  } });
  authority.activate({ expectedRevision: 1, sourceBindingDigest: 'sha256:' + 'b'.repeat(64) });
  authority.grant({ operationId: attemptId, epoch: 7, executorId: 'upgrade-seven', leaseMs: 120000 });
  const journal = createControlCommandJournal({ sqlite, instanceId, clock, assertAuthority: value => authority.assert(value) });
  const store = { instanceId, ledgerReadonly: true, ledgerSqlite: sqlite, sqlite,
    assertControllerFence: (id, fence) => {
      try { authority.assert({ operationId: id, epoch: fence, kind: 'upgrade' }); }
      catch { throw new UpgradeError('CONTROL_AUTHORITY_EXPIRED_OR_SUPERSEDED'); }
    } };
  const context = new AsyncLocalStorage(), result = { commitKnown: true, stage: 'quiesced', quiescedAt: 1000 };
  let effects = 0, semanticLookups = 0;
  const business = {
    coordinatorHandoff: (id, body) => {
      const command = context.getStore();
      return withBusinessAction(store, apiClock, { 'x-platform-control-command-id': command.commandId, 'x-platform-control-spec-digest': command.specDigest }, id, 'coordinatorHandoff', body, async () => {
        effects++; entered.resolve(); await release.promise; return result;
      }).then(() => { throw Object.assign(new Error('original ACK lost after the real fact fsync'), { code: 'ACK_LOST' }); });
    },
  };
  const commands = createControlBusinessCommands({ journal, authority, recoveryStore, business, clock,
    participantIdentity: () => identity, withCommandContext: (value, work) => context.run(value, work),
    inspector: { participantCommandStatus: ({ attemptId: id, commandId }) => readBusinessActionStatus(store, apiClock, id, commandId),
      commandStatus: () => { semanticLookups++; throw Error('completed original receipt must be used directly'); } } });
  pending = commands.executeCommand({ method: 'coordinatorHandoff', args: [attemptId,
    { action: 'quiesce', operationId: 'original-quiesce-operation', fence: 7, planDigest: 'sha256:' + 'c'.repeat(64), candidate: { ...identity } }] });
  const settled = pending.then(() => ({ code: 'unexpected-success' }), error => ({ code: error.code }));
  await entered.promise;
  let intent = recoveryStore.create({ recoveryId, triggeringAttemptId: attemptId, authorizationPlan: { componentScope: ['coordinator'] }, reason: 'ACK_TIMEOUT', deadline: 200000 });
  intent = recoveryStore.claim({ recoveryId, epoch: 8 });
  authority.grant({ operationId: recoveryId, epoch: 8, executorId: 'recovery-eight', kind: 'recovery', supersedes: attemptId, leaseMs: 120000 });
  const recovery = { intent, authorization: { operationId: recoveryId, epoch: 8, executorId: 'recovery-eight', kind: 'recovery', expiresAt: 121000 } };
  const held = await commands.reconcilePending(recovery);
  assert.equal(held.known, false); assert.equal(held.pendingCommands, 1); assert.equal(held.inFlightMutations, 1);
  assert.equal(effects, 1);
  release.resolve();
  assert.deepEqual(await settled, { code: 'ACK_LOST' });
  assert.equal(journal.pending()[0].state, 'executing', 'fenced old caller cannot overwrite its pending result');
  const actual = readBusinessActionStatus(store, apiClock, attemptId, 'original-quiesce-operation:quiesce');
  assert.equal(actual.state, 'settled'); assert.equal(actual.actualRunning, false); assert.equal(actual.admissionClosed, true);
  assert.deepEqual(actual.receipt.result, result);
  assert.deepEqual(await commands.reconcilePending(recovery), { known: true, pendingCommands: 0, inFlightMutations: 0, closedUnknownCommands: [] });
  const row = journal.lookup({ operationId: attemptId, commandId: 'original-quiesce-operation:quiesce' });
  assert.equal(row.state, 'applied'); assert.equal(row.epoch, 8); assert.deepEqual(row.result, result);
  assert.equal(effects, 1); assert.equal(semanticLookups, 0);
});
