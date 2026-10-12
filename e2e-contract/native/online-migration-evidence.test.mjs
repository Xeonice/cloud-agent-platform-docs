import test from "node:test";
import assert from "node:assert/strict";
import { onlineMigrationGate } from "./online-migration-evidence.mjs";
const input = "sha256:" + "a".repeat(64);
function evidence() {
  const records = ["X11", "X12", "X13", "X14", "semantic-contract"].map(
    (id) => ({
      id,
      result: "passed",
      testStatus: "passed",
      expectLocation: "upgrade-faults.spec.mjs:1",
      actualEvidence: { actual: {} },
    }),
  );
  records[2].actualEvidence.actual = {
    maxData: {
      inputFingerprint: input,
      populatedViaPublicHttp: true,
      declaredLimits: { projects: 50, rulesPerProject: 20 },
      measuredRows: { projects: 50, automations: 1000 },
      measuredBytes: { database: 4096 },
      actualDrizzleCount: 28,
      phaseReceipts: [
        {
          stage: "complete",
          readEpoch: 1,
          degraded: 0,
          projections: ["projects", "automations"].map((sourceTable) => ({
            sourceTable,
            rows: sourceTable === "projects" ? 50 : 1000,
            pendingChanges: 0,
            missingRows: 0,
            phantomRows: 0,
            differences: 0,
          })),
        },
      ],
    },
    forwardOnly: {
      inputFingerprint: input,
      declaredTargetSchema: 29,
      actualDrizzleCount: 28,
      catalogReason: "GLOBAL_SCHEMA_MIGRATION_UNQUALIFIED",
      acceptRejectedStatus: 409,
      zeroDdl: true,
      zeroAttempt: true,
      zeroDownload: true,
    },
  };
  records[4].actualEvidence.actual = {
    inputFingerprint: input,
    authority: "new",
    oldControllerFenced: true,
  };
  return records;
}
test("exact executed limits and independent irreversible authority supply scoped flags", () => {
  const gate = onlineMigrationGate(evidence(), input);
  assert.equal(gate.result, "passed");
  assert.equal(gate.maxDataTested, true);
  assert.equal(gate.forwardOnlyTested, true);
  assert.equal(gate.globalDestructiveDdlQualified, false);
});
test("missing maximum execution cannot be replaced by a passed case label", () => {
  const records = evidence();
  delete records[2].actualEvidence.actual.maxData;
  assert.equal(onlineMigrationGate(records, input).maxDataTested, false);
});
test("a refusal alone does not qualify the irreversible boundary", () => {
  assert.equal(
    onlineMigrationGate(evidence().slice(0, 4), input).forwardOnlyTested,
    false,
  );
});
test("stale inputs, inconsistent rows and failed native executions remain blocked", () => {
  for (const mutate of [
    (records) => {
      records[2].testStatus = "failed";
    },
    (records) => {
      records[2].actualEvidence.actual.maxData.inputFingerprint = "other";
    },
    (records) => {
      records[2].actualEvidence.actual.maxData.measuredRows.automations = 999;
    },
    (records) => {
      records[2].actualEvidence.actual.maxData.phaseReceipts[0].projections[0].differences = 1;
    },
    (records) => {
      records[2].actualEvidence.actual.maxData.phaseReceipts[0].projections[0].missingRows = 1;
    },
    (records) => {
      records[2].actualEvidence.actual.maxData.phaseReceipts[0].projections[0].phantomRows = 1;
    },
    (records) => {
      delete records[2].actualEvidence.actual.maxData.phaseReceipts[0]
        .projections[0].missingRows;
    },
    (records) => {
      records[2].actualEvidence.actual.forwardOnly.zeroDdl = false;
    },
  ]) {
    const records = evidence();
    mutate(records);
    assert.equal(onlineMigrationGate(records, input).result, "partial");
  }
});
