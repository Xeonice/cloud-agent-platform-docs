import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyBootstrapMigrationProfile, LEGACY_CONTROL_BOOTSTRAP_SCHEMA_29 as profile } from '../upgrade/bootstrap-migration-profile.mjs';
import { packagePinnedInstance } from '../jenkins/instance-package.mjs';
import { digest } from '../upgrade/trust.mjs';

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'schema29-bootstrap-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const builtApiRoot = join(root, 'built'), previousApiRoot = join(root, 'previous');
  const source = new URL('../../api/drizzle/', import.meta.url);
  await fs.mkdir(join(builtApiRoot, 'drizzle/meta'), { recursive: true });
  await fs.mkdir(join(previousApiRoot, 'drizzle/meta'), { recursive: true });
  const journal = JSON.parse(await fs.readFile(new URL('meta/_journal.json', source)));
  for (const entry of journal.entries) {
    await fs.copyFile(new URL(entry.tag + '.sql', source), join(builtApiRoot, 'drizzle', entry.tag + '.sql'));
    if (entry.idx < 29) await fs.copyFile(new URL(entry.tag + '.sql', source), join(previousApiRoot, 'drizzle', entry.tag + '.sql'));
  }
  await fs.writeFile(join(builtApiRoot, 'drizzle/meta/_journal.json'), JSON.stringify(journal));
  await fs.writeFile(join(previousApiRoot, 'drizzle/meta/_journal.json'), JSON.stringify({ ...journal, entries: journal.entries.slice(0, 29) }));
  return { root, builtApiRoot, previousApiRoot, journal, purpose: 'qualification', profile };
}

test('the artifact delivers the actual original 29-SQL prefix and records the exact omitted fast-path migration', async t => {
  const f = await fixture(t), sourceBytes = await fs.readFile(join(f.previousApiRoot, 'drizzle/meta/_journal.json'));
  const receipt = await applyBootstrapMigrationProfile(f);
  assert.equal(receipt.artifactSchema, 29);assert.equal(receipt.enablesControlFastPath, false);
  assert.equal(receipt.deliveredJournalDigest, digest(sourceBytes));
  assert.deepEqual(await fs.readFile(join(f.builtApiRoot, 'drizzle/meta/_journal.json')), sourceBytes);
  await assert.rejects(fs.stat(join(f.builtApiRoot, 'drizzle/0029_upgrade_control_fast_path.sql')), { code: 'ENOENT' });
  assert.deepEqual(JSON.parse(await fs.readFile(join(f.builtApiRoot, 'upgrade-bootstrap-schema-profile.json'))), receipt);
  // The previous signed artifact is never transformed.
  assert.deepEqual(await fs.readFile(join(f.previousApiRoot, 'drizzle/meta/_journal.json')), sourceBytes);
});

test('changed historical SQL, journal prefix or the reviewed omitted SQL fail before artifact mutation', async t => {
  for (const tamper of ['sql', 'journal', 'tail']) {
    const f = await fixture(t), originalJournal = await fs.readFile(join(f.builtApiRoot, 'drizzle/meta/_journal.json'));
    if (tamper === 'sql') await fs.appendFile(join(f.previousApiRoot, 'drizzle', f.journal.entries[0].tag + '.sql'), '\n-- changed');
    if (tamper === 'journal') { f.journal.entries[0].when++;await fs.writeFile(join(f.builtApiRoot, 'drizzle/meta/_journal.json'), JSON.stringify(f.journal)); }
    if (tamper === 'tail') await fs.appendFile(join(f.builtApiRoot, 'drizzle/0029_upgrade_control_fast_path.sql'), '\n-- changed');
    const before = await fs.readFile(join(f.builtApiRoot, 'drizzle/meta/_journal.json'));
    await assert.rejects(applyBootstrapMigrationProfile(f), /BOOTSTRAP_/);
    assert.deepEqual(await fs.readFile(join(f.builtApiRoot, 'drizzle/meta/_journal.json')), before);
    await fs.stat(join(f.builtApiRoot, 'drizzle/0029_upgrade_control_fast_path.sql'));
    if (tamper !== 'journal') assert.deepEqual(before, originalJournal);
  }
});

test('ordinary artifacts keep the complete migration set and formal release cannot select this qualification-only profile', async t => {
  const f = await fixture(t), receipt = await applyBootstrapMigrationProfile({ ...f, profile: 'current' });
  assert.deepEqual(receipt, { profile: 'current', artifactSchema: 30 });
  await fs.stat(join(f.builtApiRoot, 'drizzle/0029_upgrade_control_fast_path.sql'));
  await assert.rejects(applyBootstrapMigrationProfile({ ...f, purpose: 'release' }), /QUALIFICATION_BOOTSTRAP_SOURCE_REQUIRED/);
  let calls = 0;
  await assert.rejects(packagePinnedInstance({ purpose: 'release', migrationProfile: profile,
    previousBundle: {}, run() { calls++; } }), /INVALID_BOOTSTRAP_MIGRATION_PROFILE/);
  assert.equal(calls, 0);
});

async function reusedFixture(t) {
  const f = await fixture(t);
  const receipt = await applyBootstrapMigrationProfile(f);
  await fs.rm(f.previousApiRoot, { recursive: true });
  await fs.cp(f.builtApiRoot, f.previousApiRoot, { recursive: true });
  return { ...f, receipt, reuseVerifiedPrevious: true };
}

test('a verified reused API retains the exact prior profile and all 29 migrations without rewriting them', async t => {
  const f = await reusedFixture(t);
  const paths = ['drizzle/meta/_journal.json', 'upgrade-bootstrap-schema-profile.json',
    ...f.journal.entries.slice(0, 29).map(entry => 'drizzle/' + entry.tag + '.sql')];
  const before = await Promise.all(paths.map(async path => ({ path,
    stat: await fs.stat(join(f.builtApiRoot, path)), bytes: await fs.readFile(join(f.builtApiRoot, path)) })));
  assert.deepEqual(await applyBootstrapMigrationProfile(f), f.receipt);
  for (const file of before) {
    const after = await fs.stat(join(f.builtApiRoot, file.path));
    assert.equal(after.ino, file.stat.ino);
    assert.equal(after.mtimeMs, file.stat.mtimeMs);
    assert.deepEqual(await fs.readFile(join(f.builtApiRoot, file.path)), file.bytes);
  }
  await assert.rejects(applyBootstrapMigrationProfile({ ...f, reuseVerifiedPrevious: false }), /BOOTSTRAP_SCHEMA_PREFIX_CHANGED/);
});

test('reused profile rejects changed SQL, forged/missing receipts, reintroduced tails and formal qualification reuse', async t => {
  for (const mutation of ['sql', 'receipt', 'missing', 'tail', 'journal', 'release']) {
    const f = await reusedFixture(t);
    const receiptPath = join(f.builtApiRoot, 'upgrade-bootstrap-schema-profile.json');
    if (mutation === 'sql') await fs.appendFile(join(f.builtApiRoot, 'drizzle', f.journal.entries[0].tag + '.sql'), '-- tampered');
    if (mutation === 'receipt') {
      const changed = { ...f.receipt, enablesControlFastPath: true };
      for (const root of [f.builtApiRoot, f.previousApiRoot])
        await fs.writeFile(join(root, 'upgrade-bootstrap-schema-profile.json'), JSON.stringify(changed));
    }
    if (mutation === 'missing') await fs.unlink(receiptPath);
    if (mutation === 'tail') await fs.writeFile(join(f.builtApiRoot, 'drizzle/0029_upgrade_control_fast_path.sql'), 'unexpected');
    if (mutation === 'journal') await fs.appendFile(join(f.builtApiRoot, 'drizzle/meta/_journal.json'), '\n');
    const before = await fs.readFile(join(f.builtApiRoot, 'drizzle/meta/_journal.json'));
    await assert.rejects(applyBootstrapMigrationProfile({ ...f, ...(mutation === 'release' ? { purpose: 'release' } : {}) }));
    assert.deepEqual(await fs.readFile(join(f.builtApiRoot, 'drizzle/meta/_journal.json')), before);
  }
});
