import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { atomicJson } from './io.mjs';
import { canonical, digest, invariant } from './trust.mjs';

export const LEGACY_CONTROL_BOOTSTRAP_SCHEMA_29 = 'legacy-control-bootstrap-schema29';
const OMITTED = { tag: '0029_upgrade_control_fast_path',
  hash: 'sha256:6e284064142a808294b96e600f8e30812b62da6229e50fbac42f3760c1a882ce' };
const PROFILE_RECEIPT = 'upgrade-bootstrap-schema-profile.json';
async function regular(path) {
  const stat = await fs.lstat(path);
  invariant(stat.isFile() && !stat.isSymbolicLink() && await fs.realpath(path) === path && stat.size <= 1048576,
    'BOOTSTRAP_PROFILE_INPUT_INVALID');
  return fs.readFile(path);
}

/** One explicit bridge artifact for a legacy Installer that cannot admit a
 * schema-30 release. The caller has already verified the original signed bundle
 * and its complete tree. No checkout or live DB is modified; this only selects
 * the real schema-29 migration prefix in a new qualification artifact. */
export async function applyBootstrapMigrationProfile({ builtApiRoot, previousApiRoot, purpose, profile = 'current', reuseVerifiedPrevious = false }) {
  invariant(['current', LEGACY_CONTROL_BOOTSTRAP_SCHEMA_29].includes(profile), 'INVALID_BOOTSTRAP_MIGRATION_PROFILE');
  const journalPath = join(builtApiRoot, 'drizzle/meta/_journal.json');
  const fullBytes = await regular(journalPath), full = JSON.parse(fullBytes.toString('utf8'));
  if (profile === 'current') return { profile, artifactSchema: full.entries.length };
  invariant(purpose === 'qualification' && typeof previousApiRoot === 'string', 'QUALIFICATION_BOOTSTRAP_SOURCE_REQUIRED');
  const originalBytes = await regular(join(previousApiRoot, 'drizzle/meta/_journal.json'));
  const original = JSON.parse(originalBytes.toString('utf8'));
  if (reuseVerifiedPrevious) {
    // packagePinnedInstance has verified the prior signature and complete tree,
    // matched the source fingerprint, and copied that API without rebuilding.
    // Preserve its signed schema-29 selection instead of applying 30 -> 29 twice.
    invariant(full.entries?.length === 29 && original.entries?.length === 29 &&
      fullBytes.equals(originalBytes), 'BOOTSTRAP_REUSED_SCHEMA_CHANGED');
    const [copied, prior] = await Promise.all([
      regular(join(builtApiRoot, PROFILE_RECEIPT)), regular(join(previousApiRoot, PROFILE_RECEIPT)),
    ]);
    invariant(copied.equals(prior), 'BOOTSTRAP_REUSED_PROFILE_CHANGED');
    const receipt = JSON.parse(prior.toString('utf8'));
    invariant(canonical(Object.keys(receipt).sort()) === canonical([
      'artifactSchema', 'deliveredJournalDigest', 'enablesControlFastPath', 'kind',
      'modifiesLiveDatabase', 'omittedMigration', 'profile', 'schemaVersion', 'sourceJournalDigest',
    ]) && receipt.schemaVersion === 1 && receipt.kind === 'qualification-legacy-control-bootstrap' &&
      receipt.profile === profile && receipt.artifactSchema === 29 &&
      /^sha256:[a-f0-9]{64}$/.test(receipt.sourceJournalDigest) &&
      receipt.deliveredJournalDigest === digest(originalBytes) &&
      canonical(receipt.omittedMigration) === canonical(OMITTED) &&
      receipt.modifiesLiveDatabase === false && receipt.enablesControlFastPath === false,
    'BOOTSTRAP_REUSED_PROFILE_INVALID');
    for (const entry of original.entries) {
      invariant(/^\d{4}_[a-z0-9_]+$/.test(entry.tag), 'BOOTSTRAP_PROFILE_INPUT_INVALID');
      const [currentSql, priorSql] = await Promise.all([
        regular(join(builtApiRoot, 'drizzle', entry.tag + '.sql')),
        regular(join(previousApiRoot, 'drizzle', entry.tag + '.sql')),
      ]);
      invariant(currentSql.equals(priorSql), 'BOOTSTRAP_SCHEMA_PREFIX_CHANGED');
    }
    for (const root of [builtApiRoot, previousApiRoot]) {
      invariant(!(await fs.lstat(join(root, 'drizzle', OMITTED.tag + '.sql')).catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      })), 'BOOTSTRAP_REUSED_TAIL_PRESENT');
    }
    return receipt;
  }
  invariant(original.entries?.length === 29 && full.entries?.length === 30 && full.entries[29].tag === OMITTED.tag &&
    canonical({ ...full, entries: full.entries.slice(0, 29) }) === canonical(original), 'BOOTSTRAP_SCHEMA_PREFIX_CHANGED');
  // A matching journal alone cannot conceal edits to an old SQL migration.
  for (const entry of original.entries) {
    invariant(/^\d{4}_[a-z0-9_]+$/.test(entry.tag), 'BOOTSTRAP_PROFILE_INPUT_INVALID');
    const [currentSql, priorSql] = await Promise.all([regular(join(builtApiRoot, 'drizzle', entry.tag + '.sql')),
      regular(join(previousApiRoot, 'drizzle', entry.tag + '.sql'))]);
    invariant(currentSql.equals(priorSql), 'BOOTSTRAP_SCHEMA_PREFIX_CHANGED');
  }
  const omittedPath = join(builtApiRoot, 'drizzle', OMITTED.tag + '.sql');
  invariant(digest(await regular(omittedPath)) === OMITTED.hash, 'BOOTSTRAP_OMITTED_MIGRATION_CHANGED');
  const receiptPath = join(builtApiRoot, PROFILE_RECEIPT);
  invariant(!(await fs.lstat(receiptPath).catch(e => { if (e.code === 'ENOENT') return null; throw e; })), 'BOOTSTRAP_PROFILE_ALREADY_APPLIED');
  // All inputs are checked before the first artifact-only mutation.
  await fs.writeFile(journalPath, originalBytes);
  await fs.unlink(omittedPath);
  const receipt = { schemaVersion: 1, kind: 'qualification-legacy-control-bootstrap', profile, artifactSchema: 29,
    sourceJournalDigest: digest(fullBytes), deliveredJournalDigest: digest(originalBytes), omittedMigration: OMITTED,
    modifiesLiveDatabase: false, enablesControlFastPath: false };
  await atomicJson(receiptPath, receipt);
  return receipt;
}
