import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { digest } from '../upgrade/trust.mjs';
import { treeManifest } from '../upgrade/io.mjs';
import { seedQualificationHistory, readQualificationHistoryCoverage, validateQualificationHistoryScale } from '../../e2e-contract/server/qualification-history-seed.mjs';

const apiRequire = createRequire(new URL('../../api/package.json', import.meta.url));
const modules = { Database: apiRequire('better-sqlite3'), drizzle: apiRequire('drizzle-orm/better-sqlite3').drizzle,
  migrate: apiRequire('drizzle-orm/better-sqlite3/migrator').migrate };
const profile = { schemaVersion: 1, kind: 'synthetic-probe-history', probeRows: 277135,
  expectedHandoffEvidenceMinimumBytes: 4053536 };
async function fixture(t, schema = 29) {
  const directory = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'qualification-history-'))), root = join(directory, 'installation'), source = join(directory, 'source');
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.mkdir(join(root, 'business'), { recursive: true, mode: 0o700 });
  await fs.mkdir(join(source, 'api'), { recursive: true, mode: 0o700 });
  await fs.cp(resolve('api/drizzle'), join(source, 'api/drizzle'), { recursive: true });
  const journalPath = join(source, 'api/drizzle/meta/_journal.json'), journal = JSON.parse(await fs.readFile(journalPath));
  journal.entries = journal.entries.slice(0, schema); await fs.writeFile(journalPath, JSON.stringify(journal));
  await fs.writeFile(join(source, 'api/package.json'), JSON.stringify({ name: 'synthetic-source-closure', type: 'commonjs' }));
  const components = { api: { artifactDigest: digest('synthetic-api'), inputFingerprint: digest('synthetic-input') } },
    files = await treeManifest(source), treeDigest = digest(files), releaseId = 'v0.0.1-qualification';
  await fs.writeFile(join(source, 'upgrade-artifact.json'), JSON.stringify({ schemaVersion: 1, releaseId, components, files, treeDigest }));
  const config = { isolated: true, instanceId: 'upgrade-acceptance-history-' + randomUUID(), root, initialRoot: source,
    initialRelease: { schema, releaseId, components }, initialTreeDigest: treeDigest, historyScale: profile };
  return { directory, root, source, config, dbPath: join(root, 'business/platform.sqlite'),
    loadDependencies: actual => { assert.equal(actual, source); return modules; } };
}
async function exists(path) { return Boolean(await fs.lstat(path).catch(e => { if (e.code === 'ENOENT') return null; throw e; })); }

test('no explicit profile preserves the old path without isolation, files or dependency loads', async () => {
  assert.equal(await seedQualificationHistory({}, { assertIsolation() { throw Error('unexpected isolation'); }, loadDependencies() { throw Error('unexpected dependency'); } }), null);
  assert.equal(readQualificationHistoryCoverage({}), null);
});

test('the profile is fixed and cannot select arbitrary counts, sources or write paths', () => {
  assert.deepEqual(validateQualificationHistoryScale(profile), profile);
  for (const value of [{ ...profile, probeRows: 1 }, { ...profile, databasePath: '/data/platform.db' },
    { ...profile, expectedHandoffEvidenceMinimumBytes: 0 }, { ...profile, kind: 'production-history' }, null])
    assert.throws(() => validateQualificationHistoryScale(value), /EXACT_PROFILE_REQUIRED/);
});

test('isolation failure precedes source access, intent, SQLite and dependency loading', async t => {
  const f = await fixture(t); let loaded = false;
  await assert.rejects(seedQualificationHistory(f.config, { assertIsolation() { throw Object.assign(Error('isolated gate denied'), { code: 'ISOLATION_DENIED' }); },
    loadDependencies() { loaded = true; return modules; } }), /isolated gate denied/);
  assert.equal(loaded, false); assert.equal(await exists(f.dbPath), false);
  assert.equal(await exists(join(f.root, 'qualification-history-seed.intent.json')), false);
});

test('actual source29 migrations seed exactly 277135 real SQLite rows before roles, without upgrade receipts', async t => {
  const f = await fixture(t), sourceBefore = await treeManifest(f.source);
  const receipt = await seedQualificationHistory(f.config, { loadDependencies: f.loadDependencies });
  assert.equal(receipt.probeRows, 277135); assert.equal(receipt.sourceSchema, 29);
  assert.equal(receipt.syntheticHistory, true); assert.equal(receipt.copiedProductionDatabase, false);
  assert.equal(receipt.roleLaunches, 0); assert.equal(receipt.SDKCalls, 0);
  assert.deepEqual(await treeManifest(f.source), sourceBefore);
  const db = new modules.Database(f.dbPath); t.after(() => db.close());
  assert.equal(db.prepare('SELECT count(*) n FROM __drizzle_migrations').get().n, 29);
  assert.equal(db.prepare('SELECT count(*) n FROM upgrade_probe_records').get().n, 277135);
  assert.equal(db.prepare('SELECT count(*) n FROM upgrade_attempts').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM upgrade_steps').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM sandboxes').get().n, 0);
  assert.equal(db.prepare('SELECT min(revision) lo,max(revision) hi,count(DISTINCT request_id) ids FROM upgrade_probe_records').get().ids, 277135);
  assert.deepEqual(db.prepare('SELECT min(revision) lo,max(revision) hi FROM upgrade_probe_records').get(), { lo: 1, hi: 277135 });
  assert.equal(db.prepare('SELECT count(*) n FROM upgrade_probe_records WHERE length(value)<>71 OR length(request_id)<>36').get().n, 0);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal((await fs.lstat(f.dbPath)).mode & 0o777, 0o600);
  assert.equal(receipt.databaseBytes > 55 * 1024 * 1024, true);
  await assert.rejects(seedQualificationHistory(f.config, { loadDependencies: f.loadDependencies }), /FRESH_DATABASE_REQUIRED/);

  // Local coverage fixture only: a real SQL row, not a Native/physical claim.
  const current = randomUUID(), at = Date.now();
  db.prepare('INSERT INTO upgrade_instances(instance_id,updated_at) VALUES(?,?)').run(f.config.instanceId, at);
  db.prepare('INSERT INTO upgrade_attempts(attempt_id,instance_id,actor_id,request_id,request_digest,target_release_id,target_digest,manifest,plan,source_activation,generation,accepted_at,observed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(current, f.config.instanceId, 'synthetic', randomUUID(), digest('request'), 'v0.0.2', digest('target'), '{}', '{}', '{}', 1, at, at);
  const evidence = JSON.stringify({ syntheticCoverageTestOnly: true, padding: 'x'.repeat(4053536) });
  db.prepare('INSERT INTO upgrade_steps(attempt_id,step_id,applied,receipt_digest,evidence,applied_at,completed_work) VALUES(?,?,?,?,?,?,?)')
    .run(current, 'coordinator-handoff', 1, digest(JSON.parse(evidence)), evidence, at, 1);
  const readonly = new modules.Database(f.dbPath, { readonly: true, fileMustExist: true }); t.after(() => readonly.close());
  readonly.pragma('query_only=ON');
  const coverage = readQualificationHistoryCoverage({ profile, seed: receipt, database: readonly, attemptId: current });
  assert.equal(coverage.handoff.evidenceBytes, Buffer.byteLength(evidence));
  assert.equal(coverage.handoff.evidenceSource, 'actual-current-attempt-upgrade-step');
  assert.equal(coverage.handoff.paddingAdded, false); assert.equal(coverage.handoffMinimumMet, true);
  assert.equal(coverage.seedRowCountPreserved, true); assert.equal(coverage.scaleCoverageSatisfied, true);
  assert.equal(coverage.qualificationEvidence, false); assert.equal(coverage.changesNativeAssertions, false);
  assert.equal(db.prepare('SELECT evidence FROM upgrade_steps WHERE attempt_id=?').get(current).evidence, evidence);
  const tooLargeExpectation = readQualificationHistoryCoverage({ profile: { ...profile, expectedHandoffEvidenceMinimumBytes: 8 * 1024 * 1024 }, seed: receipt, database: readonly, attemptId: current });
  assert.equal(tooLargeExpectation.handoffMinimumMet, false); assert.equal(tooLargeExpectation.scaleCoverageSatisfied, false);
  assert.equal(readQualificationHistoryCoverage({ profile, seed: receipt, database: readonly }).handoff, null);
  assert.throws(() => readQualificationHistoryCoverage({ profile, seed: receipt, database: db, attemptId: current }), /READONLY_COVERAGE_REQUIRED/);
  db.prepare('UPDATE upgrade_steps SET applied=0,evidence=NULL WHERE attempt_id=?').run(current);
  const pending = readQualificationHistoryCoverage({ profile, seed: receipt, database: readonly, attemptId: current });
  assert.equal(pending.handoff.evidenceBytes, 0); assert.equal(pending.handoffMinimumMet, false);
  // Metadata for a larger real value stays available without an unbounded blob
  // read. This is another local SQL fixture, never a Native receipt mutation.
  db.prepare('UPDATE upgrade_steps SET applied=1,evidence=? WHERE attempt_id=?').run('x'.repeat(8 * 1024 * 1024 + 1), current);
  const reads = [], bounded = new modules.Database(f.dbPath, { readonly: true, verbose: sql => reads.push(sql) });
  t.after(() => bounded.close()); bounded.pragma('query_only=ON');
  const large = readQualificationHistoryCoverage({ profile, seed: receipt, database: bounded, attemptId: current });
  assert.equal(large.handoff.evidenceBytes, 8 * 1024 * 1024 + 1);
  assert.equal(large.handoff.rawEvidenceHashOmittedForByteLimit, true);
  assert.equal(large.handoff.evidenceRawSHA256, null);
  assert.equal(reads.some(sql => sql.startsWith('SELECT evidence FROM')), false);
});

test('source schema28, changed migration bytes and incomplete source file proof fail before SQLite creation', async t => {
  for (const mode of ['schema28', 'migration', 'proof']) await t.test(mode, async t => {
    const f = await fixture(t, mode === 'schema28' ? 28 : 29); let loaded = false;
    if (mode === 'migration') await fs.appendFile(join(f.source, 'api/drizzle/0025_instance_upgrades.sql'), '\n-- changed fixture\n');
    if (mode === 'proof') { const p = join(f.source, 'upgrade-artifact.json'), b = JSON.parse(await fs.readFile(p)); b.treeDigest = digest('foreign'); await fs.writeFile(p, JSON.stringify(b)); }
    await assert.rejects(seedQualificationHistory(f.config, { loadDependencies() { loaded = true; return modules; } }), /QUALIFICATION_HISTORY_/);
    assert.equal(loaded, false); assert.equal(await exists(f.dbPath), false);
  });
});

test('an existing DB, sidecar, symlink, Owner home or binding is never overwritten or treated as a seed target', async t => {
  for (const mode of ['database', 'wal', 'symlink', 'owner', 'binding']) await t.test(mode, async t => {
    const f = await fixture(t);
    if (mode === 'database') await fs.writeFile(f.dbPath, 'original', { mode: 0o600 });
    if (mode === 'wal') await fs.writeFile(f.dbPath + '-wal', 'original', { mode: 0o600 });
    if (mode === 'symlink') { await fs.writeFile(join(f.directory, 'protected'), 'original'); await fs.symlink(join(f.directory, 'protected'), f.dbPath); }
    if (mode === 'owner') { await fs.mkdir(join(f.root, 'original-owner')); await fs.writeFile(join(f.root, 'original-owner/private'), 'protected'); }
    if (mode === 'binding') { await fs.mkdir(join(f.root, 'bindings')); await fs.writeFile(join(f.root, 'bindings/coordinator.json'), '{}'); }
    await assert.rejects(seedQualificationHistory(f.config, { loadDependencies() { throw Error('dependency must not load'); } }), /QUALIFICATION_HISTORY_/);
    assert.equal(await exists(join(f.root, 'qualification-history-seed.intent.json')), false);
  });
});

test('a missing actual source module never falls back to checkout dependencies', async t => {
  const f = await fixture(t);
  await assert.rejects(seedQualificationHistory(f.config), /Cannot find module|SOURCE_DEPENDENCY_OUTSIDE_ARTIFACT/);
  assert.equal(await exists(f.dbPath), false);
});
