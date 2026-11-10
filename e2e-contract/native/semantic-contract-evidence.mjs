/** A plan is qualified only by an executed assertion for its exact frozen input. */
export function semanticContractGate(plans, assertions, inputFingerprint) {
  const results = plans.map((plan) => {
    const matches = assertions.filter(
      (assertion) =>
        assertion.id === "semantic-contract" &&
        assertion.actualEvidence?.actual?.contractPlanDigest ===
          plan.planDigest,
    );
    const proof = matches[0];
    const passed =
      matches.length === 1 &&
      proof.result === "passed" &&
      proof.testStatus === "passed" &&
      Boolean(proof.expectLocation) &&
      Boolean(proof.actualEvidence?.path) &&
      /^sha256:[a-f0-9]{64}$/.test(proof.actualEvidence?.digest ?? "") &&
      proof.actualEvidence.actual.inputFingerprint === inputFingerprint &&
      plan.artifactInputFingerprint === inputFingerprint;
    return {
      contractPlanDigest: plan.planDigest,
      inputFingerprint,
      result: passed ? "passed" : "not-run",
      assertions: passed ? matches : [],
      ...(passed
        ? {}
        : { reason: "No unique passed execution for this plan and input." }),
    };
  });
  return {
    result: results.every((plan) => plan.result === "passed")
      ? "passed"
      : "partial",
    plans: results,
  };
}
