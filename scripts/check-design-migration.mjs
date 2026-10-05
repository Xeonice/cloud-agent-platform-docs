import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const json = (path) => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
const required = process.argv.includes('--require-complete');
const baseline = json('artifacts/migration-audit/baseline.json').all_acs;
assert.equal(baseline.length, 1016);
const ledgers = [
  'shell-project-current', 'deployment-current', 'credential-access-current',
  'image-system-current',
];
const rows = new Map();
const implementationStatuses = new Set(['closed', 'superseded', 'deferred']);
const repositoryEvidencePaths = (evidence) => {
  const value = typeof evidence === 'string' ? evidence : evidence.path ?? '';
  return [...value.matchAll(/(?:web|api|docs|artifacts|e2e-contract|scripts)\/[^\s（）：；、,;\]\)]+/g)]
    .map((match) => match[0].replace(/:\d+(?:-\d+)?$/, ''));
};
const missingLedgers = [];
for (const name of ledgers) {
  const path = `artifacts/migration-audit/${name}.json`;
  if (!existsSync(resolve(root, path))) { missingLedgers.push(path); continue; }
  const input = json(path);
  for (const row of Array.isArray(input) ? input : input.rows) {
    assert.ok(baseline.some((ac) => ac.id === row.id), `Unknown AC ${row.id}`);
    assert.ok(!rows.has(row.id), `Duplicate AC review ${row.id}`);
    assert.ok(row.reason && row.evidence?.length, `Review lacks evidence ${row.id}`);
    if (required) {
      const paths = row.evidence.flatMap(repositoryEvidencePaths);
      assert.ok(paths.length, `Review lacks repository evidence ${row.id}`);
      for (const path of paths)
        assert.ok(existsSync(resolve(root, path)), `Retired/missing evidence ${row.id}: ${path}`);
      if (['superseded', 'deferred'].includes(row.status))
        assert.ok(row.reason.length > 15, `Product decision needs concrete explanation ${row.id}`);
    }
    rows.set(row.id, row);
  }
}
const missingACs = baseline.filter((ac) => !rows.has(ac.id));
const openACs = [...rows.values()].filter((row) => !implementationStatuses.has(row.status));
const requirementIds = readdirSync(resolve(root, 'docs/design-v2/gap/product'))
  .filter((file) => file.endsWith('.md'))
  .flatMap((file) => [...readFileSync(resolve(root, 'docs/design-v2/gap/product', file), 'utf8')
    .matchAll(/^### (REQ-[A-Z]+-\d+)\s*·/gm)].map((match) => match[1]));
assert.equal(new Set(requirementIds).size, 247);
const requirementsWithAC = new Set(baseline.map((row) => row.requirement));
const supplementalRequirements = json('artifacts/migration-audit/requirements-without-ac.json');
assert.deepEqual(supplementalRequirements.map((row) => row.id).sort(),
  requirementIds.filter((id) => !requirementsWithAC.has(id)).sort());
for (const row of supplementalRequirements) {
  assert.ok(row.reason && row.evidence?.length, `Missing supplemental requirement review ${row.id}`);
  for (const path of row.evidence)
    assert.ok(existsSync(resolve(root, path)), `Missing requirement evidence ${row.id}: ${path}`);
  assert.ok(['closed', 'not-required-current-version', 'implementation-ahead'].includes(row.status),
    `Supplemental requirement remains open ${row.id}`);
}
const manifests = ['shell-project-design-manifest', 'credential-access-design-manifest', 'image-system-design-manifest'];
const frames = new Map();
for (const name of manifests) {
  for (const frame of json(`artifacts/migration-audit/${name}.json`).frames) {
    const id = frame.draftId ?? frame.id;
    assert.ok(!frames.has(id), `Duplicate draft ${id}`);
    assert.ok(existsSync(resolve(root, frame.source)), `Missing source ${id}: ${frame.source}`);
    assert.ok(frame.fixture && frame.route, `Missing reproducible scenario ${id}`);
    frames.set(id, frame);
  }
}
const draftIds = readdirSync(resolve(root, 'docs/design-v2/gap/drafts'))
  .filter((file) => /^f-.*\.html$/.test(file) && file !== 'f-shared-components.html').map((file) => file.replace(/\.html$/, ''));
assert.equal(draftIds.length, 172);
assert.deepEqual([...frames.keys()].sort(), draftIds.sort(), 'Every approved draft has one owner');
const unfinishedDrafts = [...frames.values()].filter((frame) =>
  !['browser-passed', 'passed', 'non-ui-verified', 'not-applicable-current-emission', 'superseded'].includes(frame.verificationStatus));
let browserCombinations = 0;
for (const frame of frames.values()) {
  if (required && ['browser-passed', 'passed'].includes(frame.verificationStatus)) {
    const evidence = frame.evidence ?? [];
    const combinations = new Set(evidence.filter((entry) => ['dark', 'light'].includes(entry.theme)
      && [1440, 1024, 390].includes(entry.width)).map((entry) => `${entry.theme}:${entry.width}`));
    assert.equal(combinations.size, 6, `Missing theme/viewport execution ${frame.id}`);
    for (const entry of evidence) {
      const screenshots = [entry.screenshot, ...(entry.variantScreenshots ?? [])
        .map((variant) => typeof variant === 'string' ? variant : variant.screenshot)].filter(Boolean);
      for (const path of screenshots)
        assert.ok(existsSync(resolve(root, path)), `Missing executed screenshot ${frame.id}: ${path}`);
    }
    browserCombinations += combinations.size;
  }
  if (['not-applicable-current-emission', 'superseded'].includes(frame.verificationStatus))
    assert.ok(frame.reason, `Omitted scenario needs concrete reason ${frame.id}`);
}
let sourceFiles = 0;
for (const file of json('docs/design-v2/source-manifest.json').files) {
  const path = resolve(root, 'docs/design-v2', file.path);
  assert.ok(existsSync(path), `Missing imported asset ${file.path}`);
  const sha = createHash('sha256').update(readFileSync(path)).digest('hex');
  assert.equal(sha, file.repositorySha256 ?? file.sourceSha256, `Imported source changed without record: ${file.path}`);
  sourceFiles++;
}
console.log(JSON.stringify({
  specificationRequirements: requirementIds.length,
  requirementsWithoutACReviewed: supplementalRequirements.length,
  specificationACs: baseline.length, reviewedACs: rows.size,
  missingACReviews: missingACs.length, openImplementationACs: openACs.length,
  approvedDrafts: draftIds.length, ownedDrafts: frames.size,
  unfinishedDraftScenarios: unfinishedDrafts.length, browserCombinationsVerified: browserCombinations,
  importedFilesVerified: sourceFiles,
  missingLedgers,
  note: 'Implementation review and actual test/visual execution are separate evidence categories.',
}, null, 2));
if (required) {
  assert.equal(missingACs.length, 0, 'Every AC needs current implementation review');
  assert.equal(openACs.length, 0, 'Implementation work remains');
  assert.equal(unfinishedDrafts.length, 0, 'Draft execution work remains');
}
