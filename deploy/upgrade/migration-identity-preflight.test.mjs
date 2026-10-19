import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertMigrationRunnerIdentity } from './migration-identity-preflight.mjs';
import { runControlMigrationCommand } from './control-migration-main.mjs';

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'migration-identity-')));
  await fs.chmod(root, 0o700);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, input: { apiRoot: join(root, 'missing-api'), businessPath: join(root, 'business.db'),
    controlPath: join(root, 'ledger/control.db'), accessPath: join(root, 'private/access.db'), exportPath: join(root, 'exports/source.db'),
    instanceId: 'instance', migrationId: 'migration', epochFloor: 1, limits: {},
    runtime: { adapter: { uid: process.getuid(), gid: process.getgid() }, journalRoot: join(root, 'journal') } } };
}

test('matching real runner identity checks private targets without creating them', async t => {
  const { root, input } = await fixture(t);
  const before = await fs.readdir(root);
  assert.deepEqual(await assertMigrationRunnerIdentity(input), { checked: true, uid: process.getuid(), gid: process.getgid() });
  assert.deepEqual(await fs.readdir(root), before);
});

test('production CLI rejects a different frozen role uid before loading API, SQLite or creating output', async t => {
  const { root, input } = await fixture(t);
  input.runtime.adapter.uid++;
  const configPath = join(root, 'migration.json');
  await fs.writeFile(configPath, JSON.stringify(input), { mode: 0o600 });
  await assert.rejects(runControlMigrationCommand('prepare', configPath), { message: 'CONTROL_MIGRATION_RUNNER_IDENTITY_MISMATCH' });
  assert.deepEqual(await fs.readdir(root), ['migration.json']);
});

test('mismatched gid never inherits permission from supplementary groups', async t => {
  const { root, input } = await fixture(t);
  input.runtime.adapter.gid++;
  await assert.rejects(assertMigrationRunnerIdentity(input), { message: 'CONTROL_MIGRATION_RUNNER_IDENTITY_MISMATCH' });
  assert.deepEqual(await fs.readdir(root), []);
});

test('existing SQLite sidecars must have the same private ownership and mode', async t => {
  const { root, input } = await fixture(t);
  await fs.mkdir(join(root, 'ledger'), { mode: 0o700 });
  await fs.writeFile(input.controlPath, '', { mode: 0o600 });
  await fs.writeFile(input.controlPath + '-wal', '', { mode: 0o644 });
  await fs.chmod(input.controlPath + '-wal', 0o644);
  await assert.rejects(assertMigrationRunnerIdentity(input), { message: 'CONTROL_MIGRATION_PRIVATE_MODE_REQUIRED' });
  assert.equal((await fs.stat(input.controlPath + '-wal')).mode & 0o777, 0o644);
  assert.equal(await fs.lstat(input.runtime.journalRoot).catch(e => e.code), 'ENOENT');
});

test('symlinked private ancestors are refused instead of preparing an alternate ledger', async t => {
  const { root, input } = await fixture(t);
  await fs.mkdir(join(root, 'actual'), { mode: 0o700 });
  await fs.symlink(join(root, 'actual'), join(root, 'ledger'));
  await assert.rejects(assertMigrationRunnerIdentity(input), { message: 'CONTROL_MIGRATION_PRIVATE_OWNER_MISMATCH' });
  assert.deepEqual(await fs.readdir(join(root, 'actual')), []);
});

test('existing migration journal and its sidecars are checked before a privileged runner can open or chmod them', async t => {
  const { input } = await fixture(t);
  await fs.mkdir(input.runtime.journalRoot, { mode: 0o700 });
  const journal = join(input.runtime.journalRoot, 'migration.db');
  await fs.writeFile(journal, '', { mode: 0o600 });
  await fs.writeFile(journal + '-shm', '', { mode: 0o644 });
  await fs.chmod(journal + '-shm', 0o644);
  await assert.rejects(assertMigrationRunnerIdentity(input), { message: 'CONTROL_MIGRATION_PRIVATE_MODE_REQUIRED' });
  assert.equal((await fs.stat(journal + '-shm')).mode & 0o777, 0o644);
  await fs.unlink(journal + '-shm');
  await fs.chmod(journal, 0o644);
  await assert.rejects(assertMigrationRunnerIdentity(input), { message: 'CONTROL_MIGRATION_PRIVATE_MODE_REQUIRED' });
  assert.equal((await fs.stat(journal)).mode & 0o777, 0o644);
});
