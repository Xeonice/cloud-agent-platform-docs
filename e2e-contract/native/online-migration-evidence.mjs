const passed = (assertion) =>
  assertion?.result === "passed" &&
  assertion.testStatus === "passed" &&
  assertion.expectLocation &&
  assertion.actualEvidence;
export function onlineMigrationGate(assertions, inputFingerprint) {
  const selected = ["X11", "X12", "X13", "X14"].map((id) =>
    assertions.find((assertion) => assertion.id === id),
  );
  const facts = selected[2]?.actualEvidence?.actual,
    maximum = facts?.maxData,
    forward = facts?.forwardOnly,
    contract = assertions.find(
      (assertion) => assertion.id === "semantic-contract",
    );
  const maxDataTested = Boolean(
    passed(selected[2]) &&
    maximum?.inputFingerprint === inputFingerprint &&
    maximum.populatedViaPublicHttp === true &&
    maximum.declaredLimits?.projects === 50 &&
    maximum.declaredLimits.rulesPerProject === 20 &&
    maximum.measuredRows?.projects === 50 &&
    maximum.measuredRows.automations === 1000 &&
    maximum.measuredBytes?.database > 0 &&
    maximum.actualDrizzleCount === 28 &&
    maximum.phaseReceipts?.some(
      (receipt) =>
        receipt.stage === "complete" &&
        receipt.readEpoch >= 1 &&
        receipt.degraded === 0 &&
        ["projects", "automations"].every((source) =>
          receipt.projections?.some(
            (projection) =>
              projection.sourceTable === source &&
              projection.rows === maximum.measuredRows[source] &&
              projection.pendingChanges === 0 &&
              projection.missingRows === 0 &&
              projection.phantomRows === 0 &&
              projection.differences === 0,
          ),
        ),
    ),
  );
  const forwardOnlyTested = Boolean(
    passed(selected[2]) &&
    passed(contract) &&
    contract.actualEvidence.actual?.inputFingerprint === inputFingerprint &&
    contract.actualEvidence.actual?.authority === "new" &&
    contract.actualEvidence.actual?.oldControllerFenced === true &&
    forward?.inputFingerprint === inputFingerprint &&
    forward.declaredTargetSchema > forward.actualDrizzleCount &&
    forward.actualDrizzleCount === 28 &&
    forward.catalogReason === "GLOBAL_SCHEMA_MIGRATION_UNQUALIFIED" &&
    [400, 409, 412].includes(forward.acceptRejectedStatus) &&
    forward.zeroDdl === true &&
    forward.zeroAttempt === true &&
    forward.zeroDownload === true,
  );
  return {
    result:
      selected.every(passed) && maxDataTested && forwardOnlyTested
        ? "passed"
        : "partial",
    assertions: selected.filter(Boolean),
    maxDataTested,
    forwardOnlyTested,
    qualificationScope: "namespace-authority-and-deferred-global-ddl",
    globalDestructiveDdlQualified: false,
  };
}
