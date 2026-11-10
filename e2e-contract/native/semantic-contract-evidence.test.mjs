import { test } from "node:test";
import assert from "node:assert/strict";
import { semanticContractGate } from "./semantic-contract-evidence.mjs";

const fingerprint = "sha256:" + "a".repeat(64);
const plan = {
  planDigest: "sha256:" + "b".repeat(64),
  artifactInputFingerprint: fingerprint,
};
const proof = () => ({
  id: "semantic-contract",
  result: "passed",
  testStatus: "passed",
  expectLocation: "acceptance/upgrade-faults.spec.mjs:1",
  actualEvidence: {
    path: "native/assertions.json",
    digest: "sha256:" + "c".repeat(64),
    actual: {
      contractPlanDigest: plan.planDigest,
      inputFingerprint: fingerprint,
    },
  },
});
test("qualifies the exact executed plan without substituting the whole case label", () => {
  const gate = semanticContractGate([plan], [proof()], fingerprint);
  assert.equal(gate.result, "passed");
  assert.equal(gate.plans[0].assertions.length, 1);
  assert.equal(
    semanticContractGate([plan], [{ ...proof(), id: "X09" }], fingerprint)
      .result,
    "partial",
  );
});
test("rejects proof from another artifact input", () => {
  const wrong = proof();
  wrong.actualEvidence.actual.inputFingerprint = "sha256:" + "d".repeat(64);
  assert.equal(
    semanticContractGate([plan], [wrong], fingerprint).result,
    "partial",
  );
});
test("missing or ambiguous execution never supplies a passed plan", () => {
  for (const records of [[], [proof(), proof()]]) {
    const gate = semanticContractGate([plan], records, fingerprint);
    assert.equal(gate.result, "partial");
    assert.deepEqual(gate.plans[0].assertions, []);
  }
});
test("failed, partial and skipped executions cannot authorize publication", () => {
  for (const invalid of [
    { result: "partial" },
    { result: "failed" },
    { testStatus: "failed" },
    { testStatus: "skipped" },
    { expectLocation: null },
  ]) {
    assert.equal(
      semanticContractGate([plan], [{ ...proof(), ...invalid }], fingerprint)
        .result,
      "partial",
    );
  }
});
