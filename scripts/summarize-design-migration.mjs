import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
const write = (path, value) => writeFileSync(resolve(root, path), `${JSON.stringify(value, null, 2)}\n`);
const baseline = read('artifacts/migration-audit/baseline.json').all_acs;
const names = ['shell-project-current', 'deployment-current', 'credential-access-current', 'image-system-current'];
const byId = new Map();
for (const name of names) {
  const input = read(`artifacts/migration-audit/${name}.json`);
  for (const row of Array.isArray(input) ? input : input.rows) {
    if (byId.has(row.id)) throw new Error(`Duplicate review ${row.id}`);
    byId.set(row.id, { ...row, ownerLedger: `artifacts/migration-audit/${name}.json` });
  }
}
const rows = baseline.map((source) => {
  const current = byId.get(source.id);
  if (!current) throw new Error(`Missing review ${source.id}`);
  return {
    ...current,
    requirement: source.requirement,
    source: current.source ?? `docs/design-v2/gap/product/${source.source_file}`,
    requiredLevel: source.level,
    specifiedLevelExecution: current.specifiedLevelExecution ??
      (current.specifiedLevelExecuted ? 'executed-owner-evidence' : 'not-claimed-by-this-ledger'),
    given: source.given,
    when: source.when,
    then: source.then,
  };
});
const count = (items, key) => Object.fromEntries([...new Set(items.map((row) => row[key]))]
  .sort().map((value) => [value, items.filter((row) => row[key] === value).length]));
const extra = read('artifacts/migration-audit/requirements-without-ac.json');
const requirements = readdirSync(resolve(root, 'docs/design-v2/gap/product'))
  .filter((file) => file.endsWith('.md')).flatMap((file) =>
    [...readFileSync(resolve(root, 'docs/design-v2/gap/product', file), 'utf8')
      .matchAll(/^### (REQ-[A-Z]+-\d+)\s*·\s*(.+)$/gm)]
      .map((match) => {
        const acRows = rows.filter((row) => row.requirement === match[1]);
        return {
          id: match[1], title: match[2].replace(/\s*\{#[^}]+\}$/, ''),
          source: `docs/design-v2/gap/product/${file}`,
          ...(acRows.length ? { review: 'covered-by-current-ac-review', acIds: acRows.map((row) => row.id),
            acStatuses: count(acRows, 'status') } : extra.find((row) => row.id === match[1])),
        };
      }));
const manifestNames = ['shell-project-design-manifest', 'credential-access-design-manifest', 'image-system-design-manifest'];
const frames = manifestNames.flatMap((name) => read(`artifacts/migration-audit/${name}.json`).frames);
const api = read('api/acceptance/execution-report.json');
const currentTestReport = (baselinePath, refinementPath) =>
  existsSync(resolve(root, refinementPath)) ? refinementPath : baselinePath;
const webPath = currentTestReport('artifacts/migration-audit/web-acceptance-execution.json',
  'artifacts/migration-audit/web-acceptance-execution-ui-refinement.json');
const storybookPath = currentTestReport('artifacts/migration-audit/web-storybook-execution.json',
  'artifacts/migration-audit/web-storybook-execution-ui-refinement.json');
const web = read(webPath);
const stories = read(storybookPath);
const crossPath = 'artifacts/migration-audit/cross-execution-report.json';
const openRows = rows.filter((row) => !['closed', 'superseded', 'deferred'].includes(row.status));
const unfinished = frames.filter((frame) => !['browser-passed', 'passed', 'non-ui-verified',
  'not-applicable-current-emission', 'superseded'].includes(frame.verificationStatus));
const summary = {
  generatedAt: new Date().toISOString(),
  scope: 'Approved current design migration; implementation reviews and executed tests are distinct.',
  requirements: requirements.length, acceptanceCriteria: rows.length,
  acStatuses: count(rows, 'status'), acVerification: count(rows, 'verification'),
  openImplementationACs: openRows.map((row) => row.id),
  domains: Object.fromEntries([...new Set(rows.map((row) => row.domain))].sort()
    .map((domain) => [domain, { total: rows.filter((row) => row.domain === domain).length,
      statuses: count(rows.filter((row) => row.domain === domain), 'status') }])),
  requirementsWithoutAC: extra.map(({ id, status }) => ({ id, status })),
  design: {
    approvedDomainDrafts: frames.length,
    statuses: count(frames, 'verificationStatus'),
    unfinishedScenarios: unfinished.map((frame) => frame.draftId ?? frame.id),
    browserCombinations: frames.filter((frame) => ['browser-passed', 'passed'].includes(frame.verificationStatus))
      .reduce((sum, frame) => sum + new Set((frame.evidence ?? []).filter((entry) =>
        ['dark', 'light'].includes(entry.theme) && [1440, 1024, 390].includes(entry.width))
        .map((entry) => `${entry.theme}:${entry.width}`)).size, 0),
    sharedComponents: 'f-shared-components.html is the imported component reference, not an additional route state.',
  },
  tests: {
    api: { files: api.files, passed: api.passed, failed: api.failed, skipped: api.skipped,
      runtimeMatcherEvaluations: api.runtimeMatcherEvaluations, source: 'api/acceptance/execution-report.json' },
    web: { files: web.testResults.length, passed: web.numPassedTests, failed: web.numFailedTests,
      skipped: web.numPendingTests, source: webPath },
    storybook: { files: stories.testResults.length, passed: stories.numPassedTests,
      failed: stories.numFailedTests, skipped: stories.numPendingTests,
      source: storybookPath },
    cross: existsSync(resolve(root, crossPath)) ? { source: crossPath, report: read(crossPath) } : { status: 'report-pending' },
  },
  decisions: rows.filter((row) => ['superseded', 'deferred'].includes(row.status))
    .map(({ id, status, reason }) => ({ id, status, reason })),
  evidenceMeaning: 'Closed = current implementation reviewed. This summary does not claim 1016 specified-level or external-provider executions.',
};
write('artifacts/migration-audit/current-ac-ledger.json', { scope: summary.scope, rows });
write('artifacts/migration-audit/current-requirement-ledger.json', { rows: requirements });
write('artifacts/migration-audit/current-summary.json', summary);
console.log(JSON.stringify({ requirements: requirements.length, acceptanceCriteria: rows.length,
  statuses: summary.acStatuses, openImplementationACs: openRows.length,
  unfinishedDrafts: unfinished.length, tests: summary.tests }, null, 2));
