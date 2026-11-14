/** Presence is a minimum execution boundary, not physical qualification itself. */
export function checkedPassed(assertion) {
  return Boolean(
    assertion?.result === "passed" &&
    assertion.testStatus === "passed" &&
    typeof assertion.expectLocation === "string" &&
    assertion.expectLocation.trim().length > 0 &&
    assertion.actualEvidence !== null &&
    typeof assertion.actualEvidence === "object",
  );
}

/** Never select an arbitrary first result or invent a browser/runtime state. */
export function uniqueAssertion(assertions, id) {
  const matches = assertions.filter((assertion) => assertion.id === id);
  if (matches.length === 1) return matches[0];
  const reason =
    matches.length === 0
      ? "MISSING_EXECUTED_ASSERTION"
      : "AMBIGUOUS_EXECUTED_ASSERTION";
  return {
    id,
    result: matches.length === 0 ? "not-run" : "failed",
    reason,
    actualEvidence: { reason, matchingExecutions: matches.length },
    // No testStatus, expectLocation, timestamps, or observed service facts are
    // synthesized: there is no unique executed record to supply those values.
  };
}
