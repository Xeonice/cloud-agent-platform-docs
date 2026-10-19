import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createControlAuthority } from './control-authority.mjs';
const Database = createRequire(new URL('../../api/package.json', import.meta.url))('better-sqlite3');

test('a failed upgrade does not own the independent recovery authority', () => {
  let now = 1000;
  const db = new Database(':memory:');
  try {
    db.exec("CREATE TABLE legacy_attempts (id TEXT PRIMARY KEY,state TEXT,fence INTEGER,lease_expires_at INTEGER); INSERT INTO legacy_attempts VALUES('failed-upgrade','failed',22,0)");
    const intents = new Map([['recovery-1', 'failed-upgrade']]);
    const control = createControlAuthority({ sqlite: db, instanceId: 'instance-1', epochFloor: 22, clock: () => now,
      validateRecovery: ({ operationId, supersedes }) => assert.equal(intents.get(operationId), supersedes) });
    assert.throws(() => control.grant({ operationId: 'failed-upgrade', epoch: 23, executorId: 'old' }), /CONTROL_AUTHORITY_NOT_ACTIVE/);
    control.activate({ expectedRevision: 1, sourceBindingDigest: 'sha256:' + 'a'.repeat(64) });
    control.grant({ operationId: 'failed-upgrade', epoch: 23, executorId: 'old' });
    control.grant({ operationId: 'recovery-1', epoch: 24, executorId: 'new', kind: 'recovery', supersedes: 'failed-upgrade' });
    assert.throws(() => control.assert({ operationId: 'failed-upgrade', epoch: 23 }), /SUPERSEDED/);
    assert.equal(control.assert({ operationId: 'recovery-1', epoch: 24 }).kind, 'recovery');
    assert.deepEqual(db.prepare('SELECT * FROM legacy_attempts').get(), { id: 'failed-upgrade', state: 'failed', fence: 22, lease_expires_at: 0 });
    now += 16000;
    assert.throws(() => control.renew({ operationId: 'recovery-1', epoch: 24, executorId: 'new' }), /EXPIRED/);
    control.grant({ operationId: 'recovery-1', epoch: 25, executorId: 'new-incarnation', kind: 'recovery', supersedes: 'failed-upgrade' });
    assert.equal(control.observe().epoch, 25);
  } finally { db.close(); }
});

test('live authority cannot be stolen by an ordinary new operation or a lower epoch', () => {
  const db = new Database(':memory:');
  try {
    const control = createControlAuthority({ sqlite: db, instanceId: 'instance-1', clock: () => 1000 });
    control.activate({ expectedRevision: 1, sourceBindingDigest: 'sha256:' + 'a'.repeat(64) });
    control.grant({ operationId: 'upgrade-1', epoch: 1, executorId: 'one' });
    assert.throws(() => control.grant({ operationId: 'upgrade-2', epoch: 2, executorId: 'two' }), /CONTROL_AUTHORITY_BUSY/);
    assert.throws(() => control.grant({ operationId: 'upgrade-1', epoch: 1, executorId: 'two' }), /STALE_EPOCH/);
    assert.throws(() => control.grant({ operationId: 'recovery-1', epoch: 2, executorId: 'two', kind: 'recovery', supersedes: 'upgrade-1' }), /CONTROL_AUTHORITY_BUSY/);
    assert.equal(control.observe().epoch, 1);
  } finally { db.close(); }
});
