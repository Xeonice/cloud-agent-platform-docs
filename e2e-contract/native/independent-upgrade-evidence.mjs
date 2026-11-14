import * as fs from 'node:fs/promises';
import { basename, isAbsolute, resolve } from 'node:path';
import { digest, DIGEST, invariant } from '../../deploy/upgrade/trust.mjs';
import { inside } from '../../deploy/upgrade/io.mjs';

const FIRST = 'migration-control-native.spec.mjs';
const INDEPENDENT = 'independent-control-native.spec.mjs';
const SCENARIOS = ['normal', 'agent-restart', 'business-fault', 'unknown-ack'];
const MAX_BYTES = 1048576;

function executions(suite) {
  return [
    ...(suite.specs ?? []).flatMap(spec => (spec.tests ?? []).map(test => ({ spec, test }))),
    ...(suite.suites ?? []).flatMap(executions),
  ];
}

async function attachmentBody(attachment, outputRoot) {
  invariant(attachment.contentType === 'application/json', 'INDEPENDENT_EVIDENCE_CONTENT_TYPE');
  let bytes;
  if (attachment.path) {
    invariant(isAbsolute(attachment.path) && inside(resolve(outputRoot), attachment.path),
      'INDEPENDENT_EVIDENCE_PATH_UNTRUSTED');
    const before = await fs.lstat(attachment.path);
    invariant(before.isFile() && !before.isSymbolicLink() && before.size <= MAX_BYTES &&
      inside(await fs.realpath(outputRoot), await fs.realpath(attachment.path)),
    'INDEPENDENT_EVIDENCE_FILE_UNTRUSTED');
    bytes = await fs.readFile(attachment.path);
    const after = await fs.lstat(attachment.path);
    invariant(['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every(key => before[key] === after[key]),
      'INDEPENDENT_EVIDENCE_FILE_CHANGED');
  } else {
    invariant(typeof attachment.body === 'string' && attachment.body.length <= Math.ceil(MAX_BYTES / 3) * 4,
      'INDEPENDENT_EVIDENCE_BODY_REQUIRED');
    bytes = Buffer.from(attachment.body, 'base64');
    invariant(bytes.toString('base64') === attachment.body, 'INDEPENDENT_EVIDENCE_BODY_INVALID');
  }
  invariant(bytes.length > 0 && bytes.length <= MAX_BYTES, 'INDEPENDENT_EVIDENCE_SIZE_INVALID');
  return JSON.parse(bytes.toString('utf8'));
}

/** Source-pinned Playwright execution and its actual attachments must both pass.
 * A label on the ordinary suite, missing test, skipped result, recovered service
 * or an attachment captured before a failing cleanup cannot qualify this gate.
 */
export async function collectIndependentUpgradeEvidence(browser, {
  outputRoot, controlPackageDigest, executionEngineDigest, businessTargetDigests, businessTargetReleaseId,
}) {
  invariant(typeof outputRoot === 'string' && DIGEST.test(controlPackageDigest ?? '') &&
    DIGEST.test(executionEngineDigest ?? ''), 'INDEPENDENT_EVIDENCE_SCOPE_REQUIRED');
  const allScenarios = ['legacy-to-independent-and-business-upgrade', ...SCENARIOS];
  invariant(typeof businessTargetReleaseId === 'string' && businessTargetReleaseId.length > 0 &&
    businessTargetDigests && Object.keys(businessTargetDigests).length === allScenarios.length &&
    allScenarios.every(value => DIGEST.test(businessTargetDigests[value] ?? '')),
  'INDEPENDENT_BUSINESS_PACKAGE_SCOPE_REQUIRED');
  const selected = (browser.suites ?? []).flatMap(executions)
    .filter(({ spec }) => [FIRST, INDEPENDENT].includes(basename(spec.file ?? '')));
  invariant(selected.length === 5, 'INDEPENDENT_MANDATORY_EXECUTIONS_MISSING');
  const assertions = [], seen = new Set();
  for (const { spec, test } of selected) {
    invariant(test.expectedStatus === 'passed' && test.results?.length === 1 &&
      test.results[0].status === 'passed' && !test.results[0].error,
    'INDEPENDENT_MANDATORY_EXECUTION_FAILED');
    const first = basename(spec.file) === FIRST;
    const attachmentName = first ? 'migration-native-evidence' : 'independent-native-evidence';
    const attachments = (test.results[0].attachments ?? []).filter(value => value.name === attachmentName);
    invariant(attachments.length === 1, 'INDEPENDENT_ACTUAL_ATTACHMENT_REQUIRED');
    const evidence = await attachmentBody(attachments[0], outputRoot);
    const scenario = first ? 'legacy-to-independent-and-business-upgrade' : evidence.scenario;
    invariant((first || SCENARIOS.includes(scenario)) && !seen.has(scenario),
      'INDEPENDENT_SCENARIO_MISSING_OR_DUPLICATE');
    seen.add(scenario);
    invariant(evidence.schemaVersion === 1 && evidence.scenario === scenario &&
      evidence.result === 'passed' && evidence.nativeQualified === true &&
      evidence.controlPackageDigest === controlPackageDigest &&
      evidence.executionEngineDigest === executionEngineDigest && evidence.closeError == null,
    'INDEPENDENT_ACTUAL_PACKAGE_OR_RESULT_CHANGED');
    invariant(evidence.businessTargetDigest === businessTargetDigests[scenario] &&
      evidence.businessTargetReleaseId === businessTargetReleaseId,
    'INDEPENDENT_ACTUAL_BUSINESS_TARGET_CHANGED');
    if (first) {
      invariant(evidence.ordinaryUpgradePostCount === 1 && DIGEST.test(evidence.migrationConfigDigest ?? '') &&
        DIGEST.test(evidence.sourceArchiveDigest ?? '') && DIGEST.test(evidence.cookieDigest ?? '') &&
        Number.isSafeInteger(evidence.counter?.pid) && evidence.counter.pid > 0 &&
        typeof evidence.counter.birth === 'string' && evidence.counter.birth.length > 0 &&
        evidence.counter.launches?.length === 1 && evidence.counter.launches[0] === 1 &&
        Number.isSafeInteger(evidence.counter.beforeSamples) && evidence.counter.beforeSamples > 0 &&
        Number.isSafeInteger(evidence.counter.afterSamples) &&
        evidence.counter.afterSamples > evidence.counter.beforeSamples,
      'MIGRATION_ACTUAL_CONTINUITY_REQUIRED');
    } else {
      const { before, after } = evidence.cli ?? {};
      invariant(Number.isSafeInteger(before?.pid) && before.pid > 0 && after?.pid === before.pid &&
        typeof before.birth === 'string' && before.birth.length > 0 && after.birth === before.birth &&
        before.launches?.length === 1 && before.launches[0] === 1 &&
        after.launches?.length === 1 && after.launches[0] === 1 &&
        Number.isSafeInteger(before.sequenceCount) && before.sequenceCount > 0 &&
        Number.isSafeInteger(after.sequenceCount) && after.sequenceCount > before.sequenceCount,
      'INDEPENDENT_ACTUAL_CONTINUITY_REQUIRED');
      invariant(evidence.terminalOutcome?.state === (scenario === 'business-fault' ? 'recovered' : 'confirmed'),
        'INDEPENDENT_ACTUAL_OUTCOME_REQUIRED');
    }
    assertions.push({ id: first ? 'MIGRATION-FIRST' : 'INDEPENDENT-' + scenario,
      result: 'passed', testStatus: 'passed', expectLocation: `${spec.file}:${spec.line}`,
      actualEvidence: { scenario, attachmentDigest: digest(evidence), controlPackageDigest,
        executionEngineDigest, businessTargetDigest: businessTargetDigests[scenario],
        businessTargetReleaseId, nativeQualified: true } });
  }
  invariant(seen.has('legacy-to-independent-and-business-upgrade') && SCENARIOS.every(value => seen.has(value)),
    'INDEPENDENT_MANDATORY_SCENARIOS_MISSING');
  return { result: 'passed', controlPackageDigest, executionEngineDigest, assertions };
}
