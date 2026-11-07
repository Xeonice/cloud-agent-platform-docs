import test from "node:test";
import assert from "node:assert/strict";
import { checkedPassed, uniqueAssertion } from "./execution-assertions.mjs";

const execution = (overrides = {}) => ({
  id: "X04",
  result: "passed",
  testStatus: "passed",
  expectLocation: "acceptance/upgrade-faults.spec.mjs:1",
  actualEvidence: { actual: { scope: "report-predicate-unit-fixture-only" } },
  ...overrides,
});

test("only an actually passed execution with a location and evidence meets the shared boundary", () => {
  assert.equal(checkedPassed(execution()), true);
  for (const invalid of [
    undefined,
    null,
    execution({ result: "failed" }),
    execution({ result: "partial" }),
    execution({ result: "not-run" }),
    execution({ testStatus: "failed" }),
    execution({ testStatus: "timedOut" }),
    execution({ testStatus: "interrupted" }),
    execution({ testStatus: "skipped" }),
    execution({ testStatus: undefined }),
    execution({ expectLocation: undefined }),
    execution({ expectLocation: "   " }),
    execution({ expectLocation: true }),
    execution({ actualEvidence: undefined }),
    execution({ actualEvidence: null }),
    execution({ actualEvidence: false }),
  ])
    assert.equal(checkedPassed(invalid), false);
});

test("a successful attachment cannot qualify a failed enclosing test", () => {
  const capturedBeforeCleanup = execution({ testStatus: "failed" });
  assert.equal(capturedBeforeCleanup.result, "passed");
  assert.equal(
    checkedPassed(uniqueAssertion([capturedBeforeCleanup], "X04")),
    false,
  );
});

test("the exact unique record is preserved without overriding its execution status or observed evidence", () => {
  const actual = execution({ testStatus: "skipped" });
  const result = uniqueAssertion([execution({ id: "X01" }), actual], "X04");
  assert.equal(result, actual);
  assert.equal(result.testStatus, "skipped");
  assert.equal(checkedPassed(result), false);
  const success = execution();
  assert.equal(uniqueAssertion([success], "X04"), success);
  assert.equal(checkedPassed(uniqueAssertion([success], "X04")), true);
});

test("even identical duplicate successes cannot qualify an ambiguous execution", () => {
  const actual = execution();
  const ambiguous = uniqueAssertion([actual, { ...actual }], "X04");
  assert.equal(ambiguous.result, "failed");
  assert.equal(ambiguous.reason, "AMBIGUOUS_EXECUTED_ASSERTION");
  assert.equal(ambiguous.actualEvidence.matchingExecutions, 2);
  assert.equal(checkedPassed(ambiguous), false);
});

test("a later failure or retry cannot be hidden by selecting the first successful record", () => {
  const success = execution(),
    failure = execution({ result: "failed", testStatus: "failed" });
  for (const records of [
    [success, failure],
    [failure, success],
  ]) {
    const selected = uniqueAssertion(records, "X04");
    assert.equal(selected.result, "failed");
    assert.equal(selected.reason, "AMBIGUOUS_EXECUTED_ASSERTION");
    assert.equal(checkedPassed(selected), false);
  }
});

test("missing execution stays not-run and does not synthesize a test status, location or service state", () => {
  const missing = uniqueAssertion([execution({ id: "X01" })], "X04");
  assert.equal(missing.result, "not-run");
  assert.equal(missing.reason, "MISSING_EXECUTED_ASSERTION");
  assert.deepEqual(missing.actualEvidence, {
    reason: "MISSING_EXECUTED_ASSERTION",
    matchingExecutions: 0,
  });
  assert.equal("testStatus" in missing, false);
  assert.equal("expectLocation" in missing, false);
  assert.equal("serviceState" in missing, false);
  assert.equal(checkedPassed(missing), false);
});
