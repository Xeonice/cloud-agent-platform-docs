import * as fs from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { invariant } from './trust.mjs';

/** A privileged qualification runner must not silently create the files that
 * a differently-owned production role will later need to reopen. This gate is
 * read-only and runs before directories, SQLite files or Docker adapters exist.
 * No chown, chmod, supplementary-group inference, or fallback identity is used. */
export async function assertMigrationRunnerIdentity(input, { configPath } = {}) {
  const adapter = input?.runtime?.adapter;
  invariant(adapter && ['uid', 'gid'].every(k => Number.isSafeInteger(adapter[k]) && adapter[k] >= 0) &&
    typeof process.getuid === 'function' && typeof process.getgid === 'function' &&
    process.getuid() === adapter.uid && process.getgid() === adapter.gid,
  'CONTROL_MIGRATION_RUNNER_IDENTITY_MISMATCH');
  const uid = adapter.uid, gid = adapter.gid;
  const existing = async path => {
    const stat = await fs.lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!stat) return null;
    invariant(!stat.isSymbolicLink() && await fs.realpath(path) === path && stat.uid === uid && stat.gid === gid,
      'CONTROL_MIGRATION_PRIVATE_OWNER_MISMATCH');
    return stat;
  };
  async function privatePath(path, directory = false) {
    invariant(typeof path === 'string' && isAbsolute(path), 'CONTROL_MIGRATION_PRIVATE_PATH_REQUIRED');
    const stat = await existing(path);
    if (stat) invariant((directory ? stat.isDirectory() : stat.isFile()) && (stat.mode & 0o077) === 0,
      'CONTROL_MIGRATION_PRIVATE_MODE_REQUIRED');
    let parent = directory && stat ? path : dirname(path), found = null;
    while (!found) {
      found = await existing(parent);
      if (!found) { const next = dirname(parent); invariant(next !== parent, 'CONTROL_MIGRATION_PRIVATE_PARENT_REQUIRED'); parent = next; }
    }
    invariant(found.isDirectory() && (found.mode & 0o077) === 0, 'CONTROL_MIGRATION_PRIVATE_PARENT_REQUIRED');
    return stat;
  }
  if (configPath) await privatePath(configPath);
  for (const path of [input.controlPath, input.accessPath, input.exportPath, join(input.runtime.journalRoot, 'migration.db')]) {
    await privatePath(path);
    for (const suffix of ['-wal', '-shm', '-journal']) {
      const stat = await existing(path + suffix);
      if (stat) invariant(stat.isFile() && (stat.mode & 0o077) === 0, 'CONTROL_MIGRATION_PRIVATE_MODE_REQUIRED');
    }
  }
  await privatePath(input.runtime.journalRoot, true);
  return { uid, gid, checked: true };
}
