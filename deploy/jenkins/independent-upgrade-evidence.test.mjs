import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectIndependentUpgradeEvidence } from '../../e2e-contract/native/independent-upgrade-evidence.mjs';

// These synthetic reports exercise rejection rules only. They do not execute a
// migration, qualify a release, or constitute native continuity evidence.
const controlPackageDigest = 'sha256:' + '1'.repeat(64);
const executionEngineDigest = 'sha256:' + '2'.repeat(64);
const scenarios = ['legacy-to-independent-and-business-upgrade',
  'normal', 'agent-restart', 'business-fault', 'unknown-ack'];
const businessTargetReleaseId = 'synthetic-release-B';
const businessTargetDigests = Object.fromEntries(scenarios.map((scenario, index) =>
  [scenario, 'sha256:' + String(index + 3).repeat(64)]));
const scope = { outputRoot: tmpdir(), controlPackageDigest, executionEngineDigest,
  businessTargetReleaseId, businessTargetDigests };
function report() {
  return { suites: [{ suites: [{ specs: ['legacy-to-independent-and-business-upgrade',
    'normal', 'agent-restart', 'business-fault', 'unknown-ack'].map((scenario, index) => {
    const first = index === 0;
    const evidence = {
      schemaVersion: 1, scenario, result: 'passed', nativeQualified: true,
      controlPackageDigest, executionEngineDigest, closeError: null,
      businessTargetReleaseId, businessTargetDigest: businessTargetDigests[scenario],
      ...(first ? { ordinaryUpgradePostCount: 1, migrationConfigDigest: controlPackageDigest,
        sourceArchiveDigest: executionEngineDigest, cookieDigest: controlPackageDigest,
        counter: { pid: 1234, birth: 'synthetic-first-start', launches: [1], beforeSamples: 10, afterSamples: 30 } } : {
        cli: { before: { pid: 1234, birth: 'synthetic-test-start', launches: [1], sequenceCount: 10 },
          after: { pid: 1234, birth: 'synthetic-test-start', launches: [1], sequenceCount: 30 } },
        terminalOutcome: { state: scenario === 'business-fault' ? 'recovered' : 'confirmed' },
      }),
    };
    return { file: '/synthetic/acceptance/' + (first ? 'migration-control-native.spec.mjs' :
      'independent-control-native.spec.mjs'), line: index + 10,
    tests: [{ expectedStatus: 'passed', results: [{ status: 'passed', attachments: [{
      name: first ? 'migration-native-evidence' : 'independent-native-evidence',
      contentType: 'application/json', body: Buffer.from(JSON.stringify(evidence)).toString('base64'),
    }] }] }] };
  }) }] }] };
}
const specs = input => input.suites[0].suites[0].specs;
const result = (input, index = 1) => specs(input)[index].tests[0].results[0];
const attachment = (input, index = 1) => result(input, index).attachments[0];
function changeEvidence(input, fn, index = 1) {
  const part = attachment(input, index);
  const evidence = JSON.parse(Buffer.from(part.body, 'base64').toString());
  fn(evidence);
  part.body = Buffer.from(JSON.stringify(evidence)).toString('base64');
}
test('gate predicate accepts five distinct passed executions with same actual-package declarations', async () => {
  const gate = await collectIndependentUpgradeEvidence(report(), scope);
  assert.equal(gate.result, 'passed');
  assert.equal(gate.assertions.length, 5);
  assert.equal(new Set(gate.assertions.map(row => row.id)).size, 5);
});
test('a missing first migration, missing scenario or duplicate execution cannot qualify', async () => {
  for (const remove of [0, 2]) {
    const input = report();
    specs(input).splice(remove, 1);
    await assert.rejects(collectIndependentUpgradeEvidence(input, scope),
      { code: 'INDEPENDENT_MANDATORY_EXECUTIONS_MISSING' });
  }
  const duplicate = report();
  changeEvidence(duplicate, evidence => { evidence.scenario = 'normal'; }, 2);
  await assert.rejects(collectIndependentUpgradeEvidence(duplicate, scope),
    { code: 'INDEPENDENT_SCENARIO_MISSING_OR_DUPLICATE' });
});
test('a passed attachment cannot override a skipped, failed, flaky or cleanup-failed execution', async () => {
  const alterations = [
    input => { result(input).status = 'skipped'; },
    input => { result(input).status = 'failed'; },
    input => { result(input).error = { message: 'cleanup failed' }; },
    input => { specs(input)[1].tests[0].expectedStatus = 'failed'; },
    input => { specs(input)[1].tests[0].results.unshift({ status: 'failed' }); },
  ];
  for (const alter of alterations) {
    const input = report(); alter(input);
    await assert.rejects(collectIndependentUpgradeEvidence(input, scope),
      { code: 'INDEPENDENT_MANDATORY_EXECUTION_FAILED' });
  }
});
test('wrong package, engine, native result or cleanup error is rejected', async () => {
  for (const values of [{ controlPackageDigest: executionEngineDigest },
    { executionEngineDigest: controlPackageDigest }, { nativeQualified: false },
    { result: 'failed' }, { closeError: 'socket retained' }]) {
    const input = report(); changeEvidence(input, evidence => Object.assign(evidence, values));
    await assert.rejects(collectIndependentUpgradeEvidence(input, scope),
      { code: 'INDEPENDENT_ACTUAL_PACKAGE_OR_RESULT_CHANGED' });
  }
});
test('correct Control cannot qualify a different business version or another scenario target', async () => {
  for (const values of [{ businessTargetDigest: businessTargetDigests['agent-restart'] },
    { businessTargetReleaseId: 'synthetic-older-release' }]) {
    const input = report(); changeEvidence(input, evidence => Object.assign(evidence, values));
    await assert.rejects(collectIndependentUpgradeEvidence(input, scope),
      { code: 'INDEPENDENT_ACTUAL_BUSINESS_TARGET_CHANGED' });
  }
  await assert.rejects(collectIndependentUpgradeEvidence(report(), { ...scope, businessTargetDigests: {} }),
    { code: 'INDEPENDENT_BUSINESS_PACKAGE_SCOPE_REQUIRED' });
});
test('restarted CLI, no new samples and wrong recovery outcome fail continuity', async () => {
  for (const alter of [e => { e.cli.after.pid++; }, e => { e.cli.after.birth += '-new'; },
    e => { e.cli.after.launches.push(2); }, e => { e.cli.after.sequenceCount = e.cli.before.sequenceCount; },
    e => { e.cli.before.birth = ''; }]) {
    const input = report(); changeEvidence(input, alter);
    await assert.rejects(collectIndependentUpgradeEvidence(input, scope),
      { code: 'INDEPENDENT_ACTUAL_CONTINUITY_REQUIRED' });
  }
  const wrongOutcome = report();
  changeEvidence(wrongOutcome, e => { e.terminalOutcome.state = 'confirmed'; }, 3);
  await assert.rejects(collectIndependentUpgradeEvidence(wrongOutcome, scope),
    { code: 'INDEPENDENT_ACTUAL_OUTCOME_REQUIRED' });
  const noProgress = report();
  changeEvidence(noProgress, e => { e.counter.beforeSamples = 0; }, 0);
  await assert.rejects(collectIndependentUpgradeEvidence(noProgress, scope),
    { code: 'MIGRATION_ACTUAL_CONTINUITY_REQUIRED' });
});
test('attachment must be unique, bounded JSON with canonical base64', async () => {
  const duplicate = report(); result(duplicate).attachments.push(attachment(duplicate));
  await assert.rejects(collectIndependentUpgradeEvidence(duplicate, scope),
    { code: 'INDEPENDENT_ACTUAL_ATTACHMENT_REQUIRED' });
  for (const values of [{ contentType: 'text/plain' }, { body: 'not base64' }, { body: '' }]) {
    const input = report(); Object.assign(attachment(input), values);
    await assert.rejects(collectIndependentUpgradeEvidence(input, scope));
  }
});
test('real report attachments must stay within output root and cannot follow symlinks', async t => {
  const root = await fs.mkdtemp(join(tmpdir(), 'independent-evidence-unit-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const inside = join(root, 'report'); await fs.mkdir(inside);
  const actual = join(inside, 'evidence.json');
  const input = report(), part = attachment(input);
  await fs.writeFile(actual, Buffer.from(part.body, 'base64'));
  delete part.body; part.path = actual;
  assert.equal((await collectIndependentUpgradeEvidence(input, { ...scope, outputRoot: inside })).result, 'passed');
  part.path = join(root, 'outside.json');
  await fs.writeFile(part.path, '{}');
  await assert.rejects(collectIndependentUpgradeEvidence(input, { ...scope, outputRoot: inside }),
    { code: 'INDEPENDENT_EVIDENCE_PATH_UNTRUSTED' });
  const link = join(inside, 'link.json'); await fs.symlink(actual, link); part.path = link;
  await assert.rejects(collectIndependentUpgradeEvidence(input, { ...scope, outputRoot: inside }),
    { code: 'INDEPENDENT_EVIDENCE_FILE_UNTRUSTED' });
});
