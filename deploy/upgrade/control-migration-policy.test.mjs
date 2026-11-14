import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertControlMigrationCommand, controlMigrationExecutionPolicy } from './control-migration-policy.mjs';
import { runControlMigrationCommand } from './control-migration-main.mjs';

test('a production apply or resume is rejected before SQLite import or journal creation', async t => {
  const root = await fs.mkdtemp(join(tmpdir(), 'control-migration-policy-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const input = {
    apiRoot: join(root, 'missing-api'), businessPath: join(root, 'business.db'),
    exportPath: join(root, 'export.sqlite'), controlPath: join(root, 'control.db'),
    accessPath: join(root, 'access.db'), instanceId: 'policy-instance',
    migrationId: 'policy-migration', epochFloor: 1, limits: {},
    runtime: { journalRoot: join(root, 'journal'), allowDisruptiveFixture: true,
      onlineAdoptionSupported: true },
  };
  const configPath = join(root, 'input.json');
  await fs.writeFile(configPath, JSON.stringify(input), { mode: 0o600 });
  for (const command of ['apply', 'resume']) {
    await assert.rejects(runControlMigrationCommand(command, configPath),
      { code: 'CONTROL_MIGRATION_STOP_FIRST_DISABLED' });
    assert.deepEqual(await fs.readdir(root), ['input.json']);
  }
});

test('read-only planning and original recovery do not inherit the apply prohibition', () => {
  for (const command of ['plan', 'prepare', 'status', 'rollback']) {
    const policy = assertControlMigrationCommand(command);
    assert.equal(policy.state, 'available');
    assert.equal(policy.originalRecoveryAvailable, true);
    assert.equal(policy.authorizesSourceStop, false);
    assert.equal(policy.onlineAdoptionImplemented, false);
  }
  const blocked = controlMigrationExecutionPolicy('apply');
  assert.equal(blocked.state, 'blocked');
  assert.deepEqual(blocked.blockers, ['CONTROL_MIGRATION_STOP_FIRST_DISABLED']);
  assert.equal(Object.isFrozen(blocked), true);
  assert.equal(Object.isFrozen(blocked.blockers), true);
  assert.throws(() => assertControlMigrationCommand('retry-anyway'),
    { code: 'CONTROL_MIGRATION_COMMAND_INVALID' });
});
