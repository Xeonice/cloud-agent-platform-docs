import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { canonical, digest, DIGEST, invariant } from './trust.mjs';
import { createControlAuthority } from './control-authority.mjs';
import { createControlCommandJournal } from './control-command-journal.mjs';

const ID = /^[a-zA-Z0-9._:-]{1,200}$/;
const INSTANCE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const exact = (value, fields) => value && Object.getPrototypeOf(value) === Object.prototype &&
  Object.keys(value).sort().join(',') === [...fields].sort().join(',');
const positive = value => Number.isSafeInteger(value) && value > 0;
const scopeFields = ['schemaVersion', 'kind', 'instanceId', 'operationId', 'commandId', 'epoch', 'executorId',
  'deadline', 'source', 'target', 'controlDatabase', 'settlement', 'freezeReceiptDigest'];

/** The original attach spec is separate from the earlier freeze plan: its file
 * identity and actual freeze receipt exist only after the live export. */
export function validateControlAdoptionAttachSpec(spec) {
  invariant(exact(spec, scopeFields) && spec.schemaVersion === 1 && spec.kind === 'legacy-control-ledger-attach' &&
    INSTANCE.test(spec.instanceId ?? '') && UUID.test(spec.operationId ?? '') &&
    ['commandId', 'executorId'].every(k => typeof spec[k] === 'string' && ID.test(spec[k])) &&
    positive(spec.epoch) && positive(spec.deadline) && DIGEST.test(spec.freezeReceiptDigest ?? ''), 'CONTROL_ADOPTION_ATTACH_SPEC_INVALID');
  invariant(exact(spec.source, ['activationGeneration', 'confirmedDigest', 'businessWriterGeneration', 'businessWriterFence', 'schema']) &&
    ['activationGeneration', 'businessWriterGeneration', 'businessWriterFence'].every(k => positive(spec.source[k])) &&
    Number.isSafeInteger(spec.source.schema) && spec.source.schema >= 0 &&
    DIGEST.test(spec.source.confirmedDigest ?? ''), 'CONTROL_ADOPTION_SOURCE_INVALID');
  invariant(exact(spec.target, ['signedManifestDigest', 'apiArtifactDigest', 'coordinatorArtifactDigest', 'projectRevision', 'controlPackageDigest']) &&
    ['signedManifestDigest', 'apiArtifactDigest', 'coordinatorArtifactDigest', 'controlPackageDigest'].every(k => DIGEST.test(spec.target[k] ?? '')) &&
    /^[a-f0-9]{40}$/.test(spec.target.projectRevision ?? ''), 'CONTROL_ADOPTION_TARGET_INVALID');
  invariant(exact(spec.controlDatabase, ['path', 'dev', 'ino']) && typeof spec.controlDatabase.path === 'string' &&
    isAbsolute(spec.controlDatabase.path) && resolve(spec.controlDatabase.path) === spec.controlDatabase.path &&
    ['dev', 'ino'].every(k => typeof spec.controlDatabase[k] === 'string' && /^\d+$/.test(spec.controlDatabase[k])), 'CONTROL_ADOPTION_DATABASE_IDENTITY_INVALID');
  invariant(exact(spec.settlement, ['operationId', 'commandId']) && spec.settlement.operationId === spec.operationId &&
    ID.test(spec.settlement.commandId ?? '') && spec.settlement.commandId !== spec.commandId, 'CONTROL_ADOPTION_SETTLEMENT_SCOPE_INVALID');
  invariant(Buffer.byteLength(canonical(spec)) <= 16384, 'CONTROL_ADOPTION_ATTACH_SPEC_TOO_LARGE');
  return spec;
}

/** A one-operation maintenance reservation in the PASSIVE, already exported
 * Control ledger. It never activates ordinary upgrades, changes the business
 * writer or fabricates an upgrade attempt. validateIntent is a required trusted
 * boundary that checks the actual signed target and original freeze receipt.
 * This local journal primitive alone does not qualify or execute adoption. */
export function createControlAdoptionReservation({ sqlite, instanceId, epochFloor, validateIntent, validateAttached, clock = Date.now }) {
  invariant(sqlite && typeof instanceId === 'string' && INSTANCE.test(instanceId) && Number.isSafeInteger(epochFloor) && epochFloor >= 0 &&
    typeof validateIntent === 'function', 'CONTROL_ADOPTION_RESERVATION_CONFIG_REQUIRED');
  const metadata = sqlite.prepare('SELECT instance_id,schema_version FROM control_store_metadata WHERE singleton=1').get();
  invariant(metadata?.instance_id === instanceId && metadata.schema_version === 1, 'CONTROL_ADOPTION_CONTROL_SCHEMA_REQUIRED');
  const authority = createControlAuthority({ sqlite, instanceId, epochFloor, clock });
  sqlite.exec(`CREATE TABLE IF NOT EXISTS control_adoption_reservations(
    instance_id TEXT NOT NULL,operation_id TEXT NOT NULL,epoch INTEGER NOT NULL,executor_id TEXT NOT NULL,
    spec_digest TEXT NOT NULL,spec TEXT NOT NULL,state TEXT NOT NULL,deadline INTEGER NOT NULL,
    PRIMARY KEY(instance_id,operation_id));
    CREATE UNIQUE INDEX IF NOT EXISTS control_one_adoption_reservation ON control_adoption_reservations(instance_id) WHERE state='reserved';
    CREATE TABLE IF NOT EXISTS control_adoption_completions(instance_id TEXT NOT NULL,operation_id TEXT NOT NULL,
      receipt TEXT NOT NULL,receipt_digest TEXT NOT NULL,PRIMARY KEY(instance_id,operation_id));`);
  function read(operationId) {
    invariant(ID.test(operationId ?? ''), 'CONTROL_ADOPTION_OPERATION_INVALID');
    const row = sqlite.prepare('SELECT * FROM control_adoption_reservations WHERE instance_id=? AND operation_id=?').get(instanceId, operationId);
    if (!row) return null;
    const spec = validateControlAdoptionAttachSpec(JSON.parse(row.spec));
    invariant(row.spec_digest === digest(spec) && row.epoch === spec.epoch && row.executor_id === spec.executorId &&
      row.deadline === spec.deadline && spec.instanceId === instanceId && spec.operationId === operationId,
    'CONTROL_ADOPTION_RESERVATION_CORRUPT');
    return { instanceId, operationId, epoch: row.epoch, executorId: row.executor_id, specDigest: row.spec_digest, spec, state: row.state, deadline: row.deadline };
  }
  function assertReservation(input, command = null) {
    const row = read(input.operationId), current = authority.observe();
    invariant(row?.state === 'reserved' && current.mode === 'passive' && current.kind === 'maintenance' &&
      current.operationId === row.operationId && current.epoch === row.epoch && current.holderId === row.executorId &&
      current.leaseExpiresAt === row.deadline && current.leaseExpiresAt > clock() && input.epoch === row.epoch &&
      input.executorId === row.executorId && input.expiresAt <= row.deadline && input.expiresAt > clock(),
    'CONTROL_ADOPTION_RESERVATION_EXPIRED_OR_CHANGED');
    if (command) {
      invariant(command.operationId === row.operationId &&
        [row.spec.commandId, row.spec.settlement.commandId].includes(command.commandId), 'CONTROL_ADOPTION_COMMAND_OUTSIDE_RESERVATION');
      // Only original scope metadata can be journaled; the caller supplies no
      // executable, arbitrary URL or new deadline through this reservation.
      const spec = command.spec ?? journal.lookup(command)?.spec;
      invariant(spec && (command.commandId === row.spec.commandId ? digest(spec) === row.specDigest :
        exact(spec, ['schemaVersion', 'kind', 'instanceId', 'operationId', 'commandId', 'attachSpecDigest', 'freezeReceiptDigest', 'deadline']) &&
        spec.schemaVersion === 1 && spec.kind === 'legacy-control-settlement' && spec.instanceId === instanceId &&
        spec.operationId === row.operationId && spec.commandId === row.spec.settlement.commandId && spec.attachSpecDigest === row.specDigest &&
        spec.freezeReceiptDigest === row.spec.freezeReceiptDigest && spec.deadline === row.deadline), 'CONTROL_ADOPTION_COMMAND_SPEC_CHANGED');
    }
    return row;
  }
  const journal = createControlCommandJournal({ sqlite, instanceId, clock,
    assertAuthority: (input, command) => { assertReservation(input, command); } });
  function authorization(operationId) {
    const row = read(operationId);
    invariant(row, 'CONTROL_ADOPTION_RESERVATION_NOT_FOUND');
    const result = { operationId, epoch: row.epoch, executorId: row.executorId, expiresAt: row.deadline, kind: 'maintenance' };
    assertReservation(result); return result;
  }
  function reserve(raw) {
    // Copy before any callback/await so the caller cannot mutate the frozen
    // source or targets through a later reference.
    const spec = validateControlAdoptionAttachSpec(JSON.parse(canonical(raw))), specDigest = digest(spec);
    invariant(spec.instanceId === instanceId && spec.controlDatabase.path === sqlite.name && realpathSync(sqlite.name) === sqlite.name,
      'CONTROL_ADOPTION_LEDGER_PATH_CHANGED');
    const stat = lstatSync(sqlite.name, { bigint: true });
    invariant(stat.isFile() && !stat.isSymbolicLink() && (Number(stat.mode) & 0o077) === 0 &&
      String(stat.dev) === spec.controlDatabase.dev && String(stat.ino) === spec.controlDatabase.ino, 'CONTROL_ADOPTION_LEDGER_IDENTITY_CHANGED');
    return sqlite.transaction(() => {
      const prior = read(spec.operationId);
      if (prior) {
        invariant(prior.specDigest === specDigest, 'CONTROL_ADOPTION_RESERVATION_SPEC_CONFLICT');
        return prior; // Never refresh the lease or original deadline on replay.
      }
      const now = clock(), old = authority.observe();
      const originalFenceFloor = Math.max(
        sqlite.prepare('SELECT coalesce(max(fence),0) value FROM upgrade_attempts WHERE instance_id=?').get(instanceId).value,
        sqlite.prepare("SELECT coalesce(max(fence),0) value FROM platform_operations WHERE instance_id=? AND role IN ('upgrade-plan','project-name-contract','upgrade-observation','upgrade-stage-progress')").get(instanceId).value,
      );
      invariant(spec.deadline > now && spec.deadline <= now + 120000 && old.mode === 'passive' && old.holderId === null &&
        spec.epoch > old.epoch && spec.epoch > epochFloor && spec.epoch > originalFenceFloor &&
        !sqlite.prepare("SELECT 1 FROM control_adoption_reservations WHERE instance_id=? AND state IN ('reserved','attached')").get(instanceId),
      'CONTROL_ADOPTION_RESERVATION_NOT_AVAILABLE');
      invariant(journal.pending().length === 0, 'CONTROL_ADOPTION_ORIGINAL_COMMANDS_UNSETTLED');
      const source = sqlite.prepare('SELECT activation_generation,confirmed_release,service_state,ready FROM upgrade_instances WHERE instance_id=?').get(instanceId);
      invariant(source?.confirmed_release && source.ready === 1 && source.service_state === 'confirmed' &&
        source.activation_generation === spec.source.activationGeneration && digest(JSON.parse(source.confirmed_release)) === spec.source.confirmedDigest,
      'CONTROL_ADOPTION_CONFIRMED_SOURCE_CHANGED');
      const confirmed = JSON.parse(source.confirmed_release);
      invariant(confirmed.components.api.artifactDigest === spec.target.apiArtifactDigest &&
        confirmed.components.coordinator?.artifactDigest === spec.target.coordinatorArtifactDigest && confirmed.commits.project === spec.target.projectRevision &&
        confirmed.schema === spec.source.schema, 'CONTROL_ADOPTION_COMPATIBLE_BUSINESS_TARGET_REQUIRED');
      const proof = validateIntent(spec);
      invariant(proof && typeof proof.then !== 'function' && proof.instanceId === instanceId && proof.operationId === spec.operationId &&
        proof.specDigest === specDigest && proof.freezeReceiptDigest === spec.freezeReceiptDigest, 'CONTROL_ADOPTION_ACTUAL_INTENT_REQUIRED');
      sqlite.prepare('INSERT INTO control_adoption_reservations VALUES(?,?,?,?,?,?,?,?)')
        .run(instanceId, spec.operationId, spec.epoch, spec.executorId, specDigest, canonical(spec), 'reserved', spec.deadline);
      const changed = sqlite.prepare("UPDATE control_authority SET epoch=?,operation_id=?,kind='maintenance',holder_id=?,lease_expires_at=?,revision=revision+1,updated_at=? WHERE instance_id=? AND mode='passive' AND revision=? AND holder_id IS NULL")
        .run(spec.epoch, spec.operationId, spec.executorId, spec.deadline, now, instanceId, old.revision);
      invariant(changed.changes === 1, 'CONTROL_ADOPTION_PASSIVE_AUTHORITY_CHANGED');
      journal.prepare({ operationId: spec.operationId, commandId: spec.commandId, stepId: 'legacy-control-ledger-attach', spec,
        authorization: authorization(spec.operationId) });
      return read(spec.operationId);
    }).immediate();
  }
  function settlementSpec(operationId) {
    const row = read(operationId); invariant(row, 'CONTROL_ADOPTION_RESERVATION_NOT_FOUND');
    return { schemaVersion: 1, kind: 'legacy-control-settlement', instanceId, operationId,
      commandId: row.spec.settlement.commandId, attachSpecDigest: row.specDigest, freezeReceiptDigest: row.spec.freezeReceiptDigest, deadline: row.deadline };
  }
  function complete(operationId) {
    invariant(typeof validateAttached === 'function', 'CONTROL_ADOPTION_ATTACHED_OBSERVATION_REQUIRED');
    return sqlite.transaction(() => {
      const row = read(operationId); invariant(row, 'CONTROL_ADOPTION_RESERVATION_NOT_FOUND');
      const prior = sqlite.prepare('SELECT * FROM control_adoption_completions WHERE instance_id=? AND operation_id=?').get(instanceId, operationId);
      if (prior) {
        const receipt = JSON.parse(prior.receipt);
        invariant(row.state === 'attached' && digest(receipt) === prior.receipt_digest && receipt.specDigest === row.specDigest,
          'CONTROL_ADOPTION_COMPLETION_CORRUPT');
        return receipt;
      }
      assertReservation(authorization(operationId));
      const attach = journal.lookup({ operationId, commandId: row.spec.commandId });
      const settlement = journal.lookup({ operationId, commandId: row.spec.settlement.commandId });
      invariant(attach?.state === 'applied' && settlement?.state === 'applied' && journal.pending().length === 0,
        'CONTROL_ADOPTION_ORIGINAL_COMMANDS_UNSETTLED');
      const result = attach.result;
      invariant(exact(result, ['schemaVersion', 'kind', 'instanceId', 'operationId', 'commandId', 'specDigest', 'freezeReceiptDigest',
        'settlementResultDigest', 'readonly', 'businessWriter', 'controlActivated', 'authorizesEntryMutation']) &&
        result.schemaVersion === 1 && result.kind === 'legacy-control-ledger-attached' && result.instanceId === instanceId &&
        result.operationId === operationId && result.commandId === row.spec.commandId && result.specDigest === row.specDigest &&
        result.freezeReceiptDigest === row.spec.freezeReceiptDigest && result.settlementResultDigest === digest(settlement.result) &&
        result.readonly === true && result.controlActivated === false && result.authorizesEntryMutation === false &&
        exact(result.businessWriter, ['generation', 'fence']) && result.businessWriter.generation === row.spec.source.businessWriterGeneration &&
        result.businessWriter.fence === row.spec.source.businessWriterFence, 'CONTROL_ADOPTION_ATTACHED_RECEIPT_INVALID');
      // The required observer must check the actual authenticated Coordinator,
      // rather than merely repeat fields already present in this local journal.
      const observation = validateAttached(row, result);
      invariant(observation && typeof observation.then !== 'function' && observation.instanceId === instanceId &&
        observation.operationId === operationId && observation.specDigest === row.specDigest &&
        observation.attachedReceiptDigest === digest(result) && observation.readonly === true &&
        canonical(observation.businessWriter) === canonical(result.businessWriter) && Number.isSafeInteger(observation.observedAt) &&
        observation.observedAt <= clock() && observation.observedAt >= clock() - 5000, 'CONTROL_ADOPTION_ATTACHED_OBSERVATION_REQUIRED');
      const current = authority.observe();
      const facts = { schemaVersion: 1, kind: 'legacy-control-adoption-reservation-completed', instanceId, operationId,
        specDigest: row.specDigest, attachedReceiptDigest: digest(result), settlementResultDigest: digest(settlement.result),
        controlMode: 'passive', businessWriterPreserved: true, completedAt: clock() };
      const receipt = { ...facts, receiptDigest: digest(facts) };
      const changed = sqlite.prepare("UPDATE control_authority SET holder_id=NULL,operation_id=NULL,kind=NULL,lease_expires_at=0,revision=revision+1,updated_at=? WHERE instance_id=? AND mode='passive' AND revision=? AND holder_id=? AND operation_id=? AND epoch=?")
        .run(clock(), instanceId, current.revision, row.executorId, operationId, row.epoch);
      invariant(changed.changes === 1, 'CONTROL_ADOPTION_PASSIVE_AUTHORITY_CHANGED');
      sqlite.prepare("UPDATE control_adoption_reservations SET state='attached' WHERE instance_id=? AND operation_id=? AND state='reserved'").run(instanceId, operationId);
      sqlite.prepare('INSERT INTO control_adoption_completions VALUES(?,?,?,?)').run(instanceId, operationId, canonical(receipt), digest(receipt));
      return receipt; // Still passive. A separately checked activation is required.
    }).immediate();
  }
  return { reserve, read, authorization, assert: assertReservation, journal, settlementSpec, complete };
}
