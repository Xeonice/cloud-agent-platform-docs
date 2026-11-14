import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest } from './trust.mjs';
import { createControlAuthority } from './control-authority.mjs';
import { createControlAdoptionReservation } from './control-adoption-reservation.mjs';
const require = createRequire(new URL('../../api/package.json', import.meta.url));
const Database = require('better-sqlite3');
const { createUpgradeControlStores } = require('./apps/api/dist/platform/upgrade/control-store-factory.js');

// Real independent store/bootstrap, file SQLite, passive authority and journal.
// Signed-target/freeze validation is an explicit trusted-port fixture here;
// no actual running source custody, full adoption or Native is claimed.
async function fixture(t) {
  const directory = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'adoption-reservation-')));
  const path = join(directory, 'control.db'), sqlite = new Database(path);
  t.after(async () => { sqlite.close(); await fs.rm(directory, { recursive: true, force: true }); });
  await fs.chmod(path, 0o600);
  let now = Date.now();
  const instanceId = 'adoption-reservation-local', component = {
    artifactDigest: digest('local-built-api-fixture'), inputFingerprint: digest('local-input-fixture'),
    sourceRevision: 'a'.repeat(40), protocol: { min: 1, max: 2 },
  };
  const stores = createUpgradeControlStores({ sqlite, instanceId, clock: { now: () => new Date(now) }, ids: { next: randomUUID } });
  const confirmed = { releaseId: 'v0.4.0-local.compatible', activationGeneration: 1, activatedAt: new Date(now).toISOString(),
    schema: 29, channel: 'local-only', productionWebBinding: 'http://127.0.0.1:31991',
    commits: { project: 'a'.repeat(40), api: 'a'.repeat(40), web: 'a'.repeat(40) },
    components: { api: component, coordinator: component, installer: component, web: { ...component, webRevision: 'a'.repeat(40) } } };
  stores.store.bootstrap(confirmed);
  const stat = await fs.lstat(path, { bigint: true });
  const spec = { schemaVersion: 1, kind: 'legacy-control-ledger-attach', instanceId,
    operationId: '11111111-1111-4111-8111-111111111111', commandId: 'original-attach', epoch: 42, executorId: 'original-executor', deadline: now + 30000,
    source: { activationGeneration: 1, confirmedDigest: digest(confirmed), businessWriterGeneration: 7, businessWriterFence: 7, schema: 29 },
    target: { signedManifestDigest: digest('local-signed-target-port'), apiArtifactDigest: component.artifactDigest,
      coordinatorArtifactDigest: component.artifactDigest, projectRevision: confirmed.commits.project, controlPackageDigest: digest('local-control-package-port') },
    controlDatabase: { path, dev: String(stat.dev), ino: String(stat.ino) },
    settlement: { operationId: '11111111-1111-4111-8111-111111111111', commandId: 'original-settlement' }, freezeReceiptDigest: digest('actual-freeze-receipt-port') };
  let proof = input => ({ instanceId, operationId: input.operationId, specDigest: digest(input), freezeReceiptDigest: input.freezeReceiptDigest });
  let attachedObserver = (row, result) => ({ instanceId, operationId: row.operationId, specDigest: row.specDigest, attachedReceiptDigest: digest(result), readonly: true, businessWriter: result.businessWriter, observedAt: now });
  const reservation = createControlAdoptionReservation({ sqlite, instanceId, epochFloor: 40, clock: () => now, validateIntent: input => proof(input), validateAttached: (row, result) => attachedObserver(row, result) });
  return { sqlite, path, spec, reservation, setProof: value => { proof = value; }, setAttachedObserver: value => { attachedObserver = value; }, advance: value => { now += value; }, clock: () => now };
}

test('real reservation creates only a passive scoped command and refuses ordinary upgrade authority', async t => {
  const f = await fixture(t), row = f.reservation.reserve(f.spec);
  assert.equal(row.state, 'reserved');
  const authority = createControlAuthority({ sqlite: f.sqlite, instanceId: f.spec.instanceId, epochFloor: 40, clock: f.clock });
  assert.equal(authority.observe().mode, 'passive');
  assert.equal(authority.observe().kind, 'maintenance');
  assert.throws(() => authority.grant({ operationId: 'unrelated-upgrade', epoch: 43, executorId: 'wrong-executor' }), { code: 'CONTROL_AUTHORITY_NOT_ACTIVE' });
  const original = f.reservation.journal.lookup(f.spec);
  assert.equal(original.state, 'planned');assert.equal(original.specDigest, digest(f.spec));
  const authorization = f.reservation.authorization(f.spec.operationId);
  f.reservation.journal.begin({ ...f.spec, authorization });
  assert.equal(f.reservation.journal.lookup(f.spec).state, 'executing');
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM upgrade_attempts').all(), []);
  assert.equal(f.sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name='platform_role_leases'").get(), undefined);
});

test('only the original settlement command can be prepared and its actual result remains in the original journal', async t => {
  const f = await fixture(t);f.reservation.reserve(f.spec);
  const authorization = f.reservation.authorization(f.spec.operationId), spec = f.reservation.settlementSpec(f.spec.operationId);
  const input = { operationId: spec.operationId, commandId: spec.commandId, stepId: 'legacy-control-settlement', spec, authorization };
  f.reservation.journal.prepare(input);f.reservation.journal.begin(input);
  const receipt = { freezeReceiptDigest: f.spec.freezeReceiptDigest, originalResults: ['fixture-port-only'] };
  f.reservation.journal.record({ ...input, state: 'applied', result: receipt });
  assert.deepEqual(f.reservation.journal.lookup(input).result, receipt);
  assert.throws(() => f.reservation.journal.prepare({ ...input, commandId: 'another-command' }), { code: 'CONTROL_ADOPTION_COMMAND_OUTSIDE_RESERVATION' });
  assert.throws(() => f.reservation.journal.prepare({ ...input, spec: { ...spec, deadline: spec.deadline + 1 } }), { code: 'CONTROL_ADOPTION_COMMAND_SPEC_CHANGED' });
});

test('replay keeps exact source/spec/deadline and cannot mint a replacement for an unresolved reservation', async t => {
  const f = await fixture(t), first = f.reservation.reserve(f.spec);
  f.advance(1000);assert.deepEqual(f.reservation.reserve(f.spec), first);
  assert.throws(() => f.reservation.reserve({ ...f.spec, deadline: f.spec.deadline + 1000 }), { code: 'CONTROL_ADOPTION_RESERVATION_SPEC_CONFLICT' });
  assert.throws(() => f.reservation.reserve({ ...f.spec, operationId: '22222222-2222-4222-8222-222222222222', settlement: { ...f.spec.settlement, operationId: '22222222-2222-4222-8222-222222222222' } }), { code: 'CONTROL_ADOPTION_RESERVATION_NOT_AVAILABLE' });
});

test('missing actual intent proof rolls back both reservation and authority claim', async t => {
  const f = await fixture(t);f.setProof(() => ({ qualified: true }));
  assert.throws(() => f.reservation.reserve(f.spec), { code: 'CONTROL_ADOPTION_ACTUAL_INTENT_REQUIRED' });
  assert.equal(f.reservation.read(f.spec.operationId), null);
  const row = f.sqlite.prepare('SELECT * FROM control_authority').get();
  assert.equal(row.mode, 'passive');assert.equal(row.holder_id, null);assert.equal(row.epoch, 40);
});

test('source/target and physical database identity mismatch fail before any scoped command exists', async t => {
  const f = await fixture(t);
  assert.throws(() => f.reservation.reserve({ ...f.spec, controlDatabase: { ...f.spec.controlDatabase, ino: '123' } }), { code: 'CONTROL_ADOPTION_LEDGER_IDENTITY_CHANGED' });
  assert.throws(() => f.reservation.reserve({ ...f.spec, target: { ...f.spec.target, apiArtifactDigest: digest('wrong-api') } }), { code: 'CONTROL_ADOPTION_COMPATIBLE_BUSINESS_TARGET_REQUIRED' });
  assert.throws(() => f.reservation.reserve({ ...f.spec, source: { ...f.spec.source, confirmedDigest: digest('wrong-confirmed') } }), { code: 'CONTROL_ADOPTION_CONFIRMED_SOURCE_CHANGED' });
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM control_commands').all(), []);
});

test('expired original scope cannot begin or record effects and replay does not renew it', async t => {
  const f = await fixture(t);f.reservation.reserve(f.spec);
  const authorization = f.reservation.authorization(f.spec.operationId);
  f.advance(30001);
  assert.throws(() => f.reservation.authorization(f.spec.operationId), { code: 'CONTROL_ADOPTION_RESERVATION_EXPIRED_OR_CHANGED' });
  assert.throws(() => f.reservation.journal.begin({ ...f.spec, authorization }), { code: 'CONTROL_COMMAND_AUTHORITY_EXPIRED' });
  assert.equal(f.reservation.reserve(f.spec).deadline, f.spec.deadline);
  assert.equal(f.reservation.journal.lookup(f.spec).state, 'planned');
});

test('caller mutation cannot change the persisted original source or deadline', async t => {
  const f = await fixture(t);f.reservation.reserve(f.spec);
  const original = f.reservation.read(f.spec.operationId);
  f.spec.source.confirmedDigest = digest('caller-later-write');f.spec.deadline += 1;
  assert.deepEqual(f.reservation.read(f.spec.operationId), original);
});

function recordOriginalAttachment(f) {
  const row = f.reservation.reserve(f.spec), authorization = f.reservation.authorization(f.spec.operationId);
  const spec = f.reservation.settlementSpec(row.operationId);
  const input = { operationId: row.operationId, commandId: spec.commandId, stepId: 'legacy-control-settlement', spec, authorization };
  f.reservation.journal.prepare(input);f.reservation.journal.begin(input);
  const settlement = { freezeReceiptDigest: f.spec.freezeReceiptDigest, originalResults: ['explicit-trusted-port-fixture'] };
  f.reservation.journal.record({ ...input, state: 'applied', result: settlement });
  f.reservation.journal.begin({ ...f.spec, authorization });
  const result = { schemaVersion: 1, kind: 'legacy-control-ledger-attached', instanceId: f.spec.instanceId,
    operationId: f.spec.operationId, commandId: f.spec.commandId, specDigest: row.specDigest, freezeReceiptDigest: f.spec.freezeReceiptDigest,
    settlementResultDigest: digest(settlement), readonly: true, businessWriter: { generation: 7, fence: 7 }, controlActivated: false, authorizesEntryMutation: false };
  f.reservation.journal.record({ ...f.spec, authorization, state: 'applied', result });
  return result;
}

test('a fresh trusted attached observation finalizes the passive holder without activating ordinary authority', async t => {
  const f = await fixture(t);recordOriginalAttachment(f);
  const result = f.reservation.complete(f.spec.operationId);
  assert.equal(result.controlMode, 'passive');assert.equal(result.businessWriterPreserved, true);
  const authority = createControlAuthority({ sqlite: f.sqlite, instanceId: f.spec.instanceId, epochFloor: 40, clock: f.clock });
  assert.equal(authority.observe().mode, 'passive');assert.equal(authority.observe().holderId, null);
  assert.equal(f.reservation.read(f.spec.operationId).state, 'attached');
  assert.deepEqual(f.reservation.complete(f.spec.operationId), result);
  assert.throws(() => authority.grant({ operationId: randomUUID(), epoch: 43, executorId: 'ordinary-upgrade' }), { code: 'CONTROL_AUTHORITY_NOT_ACTIVE' });
});

test('unsettled command or stale observation preserves the original passive reservation', async t => {
  const f = await fixture(t);f.reservation.reserve(f.spec);
  assert.throws(() => f.reservation.complete(f.spec.operationId), { code: 'CONTROL_ADOPTION_ORIGINAL_COMMANDS_UNSETTLED' });
  recordOriginalAttachment(f);f.setAttachedObserver(() => ({ qualified: true }));
  assert.throws(() => f.reservation.complete(f.spec.operationId), { code: 'CONTROL_ADOPTION_ATTACHED_OBSERVATION_REQUIRED' });
  assert.equal(f.reservation.read(f.spec.operationId).state, 'reserved');
  assert.equal(f.sqlite.prepare('SELECT holder_id FROM control_authority').get().holder_id, f.spec.executorId);
});
