import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createRequire } from 'node:module';
import { randomUUID, createHash } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { canonical, digest, DIGEST, invariant } from '../../deploy/upgrade/trust.mjs';
import { assertQualificationIsolation } from './qualification-isolation.mjs';
import { qualificationBusinessDatabasePath } from './installer-filesystem.mjs';

const PREFIX = 'QUALIFICATION_HISTORY_', ROWS = 277135, MAX_FILE = 64 * 1024 * 1024;
const rawHash = raw => createHash('sha256').update(raw).digest('hex');
const same = (a, b, code) => invariant(canonical(a) === canonical(b), PREFIX + code);

export function validateQualificationHistoryScale(value) {
  if (value === undefined) return null;
  invariant(value && Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).every(key => ['schemaVersion', 'kind', 'probeRows', 'expectedHandoffEvidenceMinimumBytes'].includes(key)) &&
    value.schemaVersion === 1 && value.kind === 'synthetic-probe-history' && value.probeRows === ROWS &&
    (value.expectedHandoffEvidenceMinimumBytes === undefined || Number.isSafeInteger(value.expectedHandoffEvidenceMinimumBytes) &&
      value.expectedHandoffEvidenceMinimumBytes > 0 && value.expectedHandoffEvidenceMinimumBytes <= MAX_FILE),
  PREFIX + 'EXACT_PROFILE_REQUIRED');
  return Object.freeze({ ...value });
}

async function canonicalPath(path, directory = false) {
  invariant(isAbsolute(path) && resolve(path) === path, PREFIX + 'CANONICAL_PATH_REQUIRED');
  for (let part = path; part !== dirname(part); part = dirname(part))
    invariant(!(await fs.lstat(part)).isSymbolicLink(), PREFIX + 'SYMLINK_REFUSED');
  const stat = await fs.lstat(path);
  invariant((directory ? stat.isDirectory() : stat.isFile()) && (stat.mode & 0o022) === 0 &&
    (!process.getuid || stat.uid === 0 || stat.uid === process.getuid()) && await fs.realpath(path) === path,
  PREFIX + 'PATH_CUSTODY_REQUIRED');
  return stat;
}
async function boundedFile(path, maximum = MAX_FILE) {
  await canonicalPath(path);
  const file = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    invariant(before.size > 0 && before.size <= maximum, PREFIX + 'FILE_LIMIT');
    const raw = await file.readFile(), after = await file.stat(), current = await fs.lstat(path);
    invariant(raw.length === before.size && ['dev', 'ino', 'mode', 'size', 'mtimeMs', 'ctimeMs'].every(key =>
      before[key] === after[key] && after[key] === current[key]), PREFIX + 'SOURCE_CHANGED');
    return raw;
  } finally { await file.close(); }
}
async function absent(path) {
  try { await fs.lstat(path); invariant(false, PREFIX + 'FRESH_DATABASE_REQUIRED'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
async function newJson(path, value) {
  const file = await fs.open(path, 'wx', 0o600);
  try { await file.writeFile(canonical(value) + '\n'); await file.sync(); }
  finally { await file.close(); }
  const directory = await fs.open(dirname(path), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

// The production Native caller cannot select a dependency path or a fallback.
// Only these three database/migration modules in the actual source package load.
function sourceDependencies(initialRoot) {
  const require = createRequire(join(initialRoot, 'api/package.json'));
  const names = ['better-sqlite3', 'drizzle-orm/better-sqlite3', 'drizzle-orm/better-sqlite3/migrator'];
  for (const name of names) invariant(require.resolve(name).startsWith(initialRoot + '/'), PREFIX + 'SOURCE_DEPENDENCY_OUTSIDE_ARTIFACT');
  return { Database: require(names[0]), drizzle: require(names[1]).drizzle, migrate: require(names[2]).migrate };
}

/** QA-only offline initialization. No role/app/SDK import, copied production DB,
 * historical upgrade attempt, fake step receipt or current-attempt mutation.
 * Test injection supplies real SQLite/Drizzle modules, never SQL/DTO doubles. */
export async function seedQualificationHistory(config, {
  assertIsolation = assertQualificationIsolation, loadDependencies = sourceDependencies,
} = {}) {
  if (config.historyScale === undefined) return null;
  await assertIsolation(config); // All isolation checks precede any DB creation.
  const profile = validateQualificationHistoryScale(config.historyScale);
  invariant(config.isolated === true && config.initialRelease?.schema === 29 &&
    typeof loadDependencies === 'function', PREFIX + 'SOURCE_SCHEMA29_REQUIRED');
  const root = config.root, source = config.initialRoot, databasePath = qualificationBusinessDatabasePath(config);
  await canonicalPath(root, true); await canonicalPath(source, true); await canonicalPath(dirname(databasePath), true);
  for (const name of ['harness.json', 'bindings/coordinator.json', 'bindings/owners.json']) await absent(join(root, name));
  for (const name of ['original-owner', 'future-owners']) {
    const directory = join(root, name), exists = await fs.lstat(directory).catch(error => {
      if (error.code === 'ENOENT') return null; throw error;
    });
    if (exists) { await canonicalPath(directory, true); invariant((await fs.readdir(directory)).length === 0, PREFIX + 'BEFORE_OWNER_START_REQUIRED'); }
  }
  for (const suffix of ['', '-wal', '-shm']) await absent(databasePath + suffix);
  const bundleRaw = await boundedFile(join(source, 'upgrade-artifact.json')),
    bundle = JSON.parse(bundleRaw), verified = new Map();
  invariant(bundle.schemaVersion === 1 && Array.isArray(bundle.files) && DIGEST.test(config.initialTreeDigest) &&
    bundle.treeDigest === config.initialTreeDigest && digest(bundle.files) === bundle.treeDigest &&
    bundle.releaseId === config.initialRelease.releaseId && canonical(bundle.components) === canonical(config.initialRelease.components),
  PREFIX + 'VERIFIED_SOURCE_ARTIFACT_REQUIRED');
  const records = new Map(bundle.files.map(row => [row.path, row]));
  invariant(records.size === bundle.files.length, PREFIX + 'DUPLICATE_SOURCE_FILE');
  async function sourceFile(relativePath) {
    const row = records.get(relativePath), raw = await boundedFile(join(source, relativePath));
    invariant(row && row.link === undefined && row.bytes === raw.length && row.digest === digest(raw), PREFIX + 'SOURCE_FILE_NOT_VERIFIED');
    verified.set(relativePath, raw); return raw;
  }
  await sourceFile('api/package.json');
  const journal = JSON.parse(await sourceFile('api/drizzle/meta/_journal.json'));
  invariant(Array.isArray(journal.entries) && journal.entries.length === 29 && journal.entries.every((row, index) =>
    row.idx === index && /^[a-zA-Z0-9_-]+$/.test(row.tag) && Number.isSafeInteger(row.when) && row.when > 0), PREFIX + 'SOURCE_MIGRATION_PREFIX_REQUIRED');
  const expectedJournal = [];
  for (const entry of journal.entries) {
    const raw = await sourceFile('api/drizzle/' + entry.tag + '.sql');
    expectedJournal.push({ hash: rawHash(raw), created_at: entry.when });
  }
  const modules = await loadDependencies(source);
  invariant(['Database', 'drizzle', 'migrate'].every(name => typeof modules[name] === 'function'), PREFIX + 'REAL_DATABASE_MODULES_REQUIRED');
  const seedId = randomUUID(), syntheticAttemptId = randomUUID(), intentPath = join(root, 'qualification-history-seed.intent.json');
  await newJson(intentPath, { schemaVersion: 1, kind: profile.kind, instanceId: config.instanceId, seedId,
    probeRows: ROWS, databasePath, initialTreeDigest: config.initialTreeDigest, roleLaunches: 0, SDKCalls: 0 });
  const file = await fs.open(databasePath, 'wx', 0o600); await file.sync(); await file.close();
  const parent = await fs.open(dirname(databasePath), 'r'); try { await parent.sync(); } finally { await parent.close(); }
  let db, migrationRows, bytes;
  try {
    db = new modules.Database(databasePath, { fileMustExist: true, timeout: 0 });
    db.pragma('foreign_keys=ON'); db.pragma('journal_mode=WAL');
    modules.migrate(modules.drizzle(db), { migrationsFolder: join(source, 'api/drizzle') });
    migrationRows = db.prepare('SELECT hash,created_at FROM __drizzle_migrations ORDER BY created_at,id').all();
    same(migrationRows, expectedJournal, 'SOURCE_MIGRATIONS_CHANGED');
    invariant(db.prepare('SELECT count(*) n FROM upgrade_probe_records').get().n === 0 &&
      db.prepare('SELECT count(*) n FROM upgrade_attempts').get().n === 0 &&
      db.prepare('SELECT count(*) n FROM upgrade_steps').get().n === 0, PREFIX + 'FRESH_HISTORY_TABLES_REQUIRED');
    const insert = db.prepare('INSERT INTO upgrade_probe_records(request_id,attempt_id,value,revision,committed_at) VALUES(?,?,?,?,?)'),
      value = digest({ synthetic: true, seedId }), at = Date.now();
    db.transaction(() => {
      for (let revision = 1; revision <= ROWS; revision++)
        insert.run(randomUUID(), syntheticAttemptId, value, revision, at);
    }).immediate();
    invariant(db.prepare('SELECT count(*) n FROM upgrade_probe_records').get().n === ROWS, PREFIX + 'SEED_ROW_COUNT_CHANGED');
    db.pragma('wal_checkpoint(TRUNCATE)');
  } finally { db?.close(); }
  for (const [relativePath, raw] of verified) invariant((await boundedFile(join(source, relativePath))).equals(raw), PREFIX + 'SOURCE_CHANGED');
  invariant((await boundedFile(join(source, 'upgrade-artifact.json'))).equals(bundleRaw), PREFIX + 'SOURCE_CHANGED');
  const databaseIdentity = await fs.lstat(databasePath); bytes = databaseIdentity.size;
  const receipt = { schemaVersion: 1, kind: profile.kind, instanceId: config.instanceId, seedId, syntheticAttemptId,
    probeRows: ROWS, sourceSchema: 29, sourceTreeDigest: config.initialTreeDigest, migrationJournalDigest: digest(migrationRows),
    databasePath, databaseDev: String(databaseIdentity.dev), databaseIno: String(databaseIdentity.ino), databaseBytes: bytes,
    expectedHandoffEvidenceMinimumBytes: profile.expectedHandoffEvidenceMinimumBytes ?? null,
    syntheticHistory: true, copiedProductionDatabase: false, seededUpgradeAttempts: 0, seededUpgradeSteps: 0,
    modifiedCurrentAttemptReceipt: false, sourceArtifactWrites: 0, roleLaunches: 0, SDKCalls: 0, observedAt: new Date().toISOString() };
  await newJson(join(root, 'qualification-history-seed.actual.json'), receipt); return Object.freeze(receipt);
}

/** Read-only coverage metadata, separate from the original I01/I02/N01 result.
 * A small real handoff is reported, never padded or promoted to scale coverage. */
export function readQualificationHistoryCoverage({ profile: input, seed, database, attemptId }) {
  const profile = validateQualificationHistoryScale(input);
  if (!profile) return null;
  invariant(seed?.syntheticHistory === true && seed.probeRows === ROWS && database?.readonly === true &&
    database.pragma('query_only', { simple: true }) === 1, PREFIX + 'READONLY_COVERAGE_REQUIRED');
  return database.transaction(() => {
    const retained = database.prepare('SELECT count(*) n FROM upgrade_probe_records WHERE attempt_id=?').get(seed.syntheticAttemptId).n,
      metadata = typeof attemptId === 'string' ? database.prepare('SELECT applied,receipt_digest,coalesce(octet_length(evidence),0) bytes FROM upgrade_steps WHERE attempt_id=? AND step_id=?').get(attemptId, 'coordinator-handoff') : null;
    let handoff = null;
    if (metadata) {
      invariant(Number.isSafeInteger(metadata.bytes) && metadata.bytes >= 0, PREFIX + 'HANDOFF_EVIDENCE_LIMIT');
      const omitted = metadata.bytes > 8 * 1024 * 1024,
        evidence = omitted ? null : database.prepare('SELECT evidence FROM upgrade_steps WHERE attempt_id=? AND step_id=?').get(attemptId, 'coordinator-handoff').evidence;
      invariant(omitted || Buffer.byteLength(evidence ?? '') === metadata.bytes, PREFIX + 'HANDOFF_EVIDENCE_CHANGED');
      handoff = { stepId: 'coordinator-handoff', applied: metadata.applied === 1, evidenceBytes: metadata.bytes,
        evidenceRawSHA256: typeof evidence === 'string' ? rawHash(evidence) : null, persistedReceiptDigest: metadata.receipt_digest,
        rawEvidenceHashOmittedForByteLimit: omitted, evidenceSource: 'actual-current-attempt-upgrade-step', paddingAdded: false };
    }
    const required = profile.expectedHandoffEvidenceMinimumBytes ?? null,
      minimumMet = required === null ? null : handoff?.applied === true && handoff.evidenceBytes >= required;
    return { schemaVersion: 1, kind: 'qualification-history-scale-coverage', syntheticHistory: true,
      configuredProbeRows: ROWS, retainedSeedRows: retained, seedRowCountPreserved: retained === ROWS,
      currentAttemptId: attemptId ?? null, handoff, expectedHandoffEvidenceMinimumBytes: required,
      handoffMinimumMet: minimumMet, scaleCoverageSatisfied: retained === ROWS && handoff?.applied === true && minimumMet === true,
      changesNativeAssertions: false, qualificationEvidence: false, SDKCalls: 0, databaseWrites: 0 };
  }).deferred();
}
