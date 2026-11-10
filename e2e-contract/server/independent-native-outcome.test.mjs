import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { independentNativeOutcome } from "./independent-native-outcome.mjs";

// Real compiled public schema; synthetic status values test only the QA predicate.
// These tests do not start a VM, browser, model, application, or upgrade.
const { UpgradeStatusSchema } = createRequire(
  new URL("../../api/apps/api/package.json", import.meta.url),
)("@platform/contracts");
const at = "2026-10-20T00:00:00.000Z",
  hash = "sha256:" + "a".repeat(64);
const id = "11111111-1111-4111-8111-111111111111",
  recoveryId = "22222222-2222-4222-8222-222222222222";
const command = {
  requestId: id,
  targetReleaseId: "v0.3.22-experiment.1",
  targetDigest: hash,
};
function status({ recovered = false, ...patch } = {}) {
  const artifact = {
    artifactDigest: hash,
    inputFingerprint: hash,
    sourceRevision: "a".repeat(40),
    protocol: { min: 1, max: 1 },
  };
  const release = {
    releaseId: recovered ? "v0.3.21-experiment.1" : command.targetReleaseId,
    activationGeneration: 2,
    activatedAt: at,
    schema: 29,
    channel: "qualification-only",
    components: {
      api: artifact,
      coordinator: artifact,
      installer: artifact,
      owner: artifact,
      web: { ...artifact, webRevision: "a".repeat(40) },
    },
    commits: {
      project: "a".repeat(40),
      api: "a".repeat(40),
      web: "a".repeat(40),
    },
    productionWebBinding: "http://127.0.0.1:4000",
  };
  return UpgradeStatusSchema.parse({
    instanceId: "upgrade-acceptance-outcome-only",
    userScope: "fixture",
    activationGeneration: 2,
    confirmedServiceRelease: release,
    lastConfirmedServiceRelease: release,
    serviceState: "confirmed",
    catalog: {
      state: "no-update",
      observedAt: at,
      reason: null,
      availableRelease: null,
    },
    capabilities: { canUpgradeInstance: true, canAuthenticate: true },
    csrfToken: "",
    attempt: {
      instanceId: "upgrade-acceptance-outcome-only",
      attemptId: id,
      requestId: command.requestId,
      targetReleaseId: command.targetReleaseId,
      targetDigest: command.targetDigest,
      generation: 2,
      sequence: 1,
      state: recovered ? "failed" : "activation-confirmed",
      stage: "activation-confirm",
      percent: recovered ? null : 100,
      completedWork: 1,
      totalWork: 1,
      planDigest: hash,
      acceptedAt: at,
      observedAt: at,
      reason: null,
    },
    recovery: recovered
      ? {
          recoveryAttemptId: recoveryId,
          triggeringAttemptId: id,
          generation: 3,
          sequence: 1,
          state: "recovery-confirmed",
          phase: "recovered",
          confirmedAt: at,
          planDigest: hash,
          reason: "synthetic predicate fixture",
          observedAt: at,
        }
      : null,
    availableWeb: null,
    observedAt: at,
    serviceAvailability: { state: "available", observedAt: at, reason: null },
    observation: {
      state: "fresh",
      confirmedAt: at,
      checkedAt: at,
      reason: null,
    },
    ...patch,
  });
}
const outcome = (scenario, payload) =>
  independentNativeOutcome({
    scenario,
    status: UpgradeStatusSchema.parse(payload),
    command,
  });
test("normal, lost ACK and Agent restart require exact target activation, and recovered service is an immediate failure", () => {
  for (const scenario of ["normal", "unknown-ack", "agent-restart"]) {
    assert.deepEqual(outcome(scenario, status()), {
      state: "confirmed",
      releaseId: command.targetReleaseId,
    });
    assert.deepEqual(outcome(scenario, status({ recovered: true })), {
      state: "failed",
      code: "INDEPENDENT_NATIVE_TARGET_NOT_CONFIRMED",
    });
  }
});
test("business fault may confirm B or recover, but only with the real public recovery terminal shape", () => {
  assert.equal(outcome("business-fault", status()).state, "confirmed");
  assert.deepEqual(outcome("business-fault", status({ recovered: true })), {
    state: "recovered",
    recoveryId,
  });
  for (const patch of [
    { state: "unknown" },
    { confirmedAt: null },
    { triggeringAttemptId: recoveryId },
  ]) {
    const value = status({ recovered: true });
    value.recovery = { ...value.recovery, ...patch };
    assert.equal(outcome("business-fault", value).state, "failed");
  }
});
test("available alone, stale/checking observations, unknown service and in-progress attempts are never terminal success", () => {
  const cases = [
    status({
      observation: {
        state: "stale",
        confirmedAt: at,
        checkedAt: at,
        reason: "stale",
      },
    }),
    status({
      observation: {
        state: "checking",
        confirmedAt: at,
        checkedAt: at,
        reason: null,
      },
    }),
    status({
      serviceAvailability: { state: "unknown", observedAt: at, reason: null },
    }),
    status({ serviceState: "transitioning" }),
    status({ observation: undefined }),
  ];
  const progressing = status();
  progressing.attempt.state = "observing";
  cases.push(progressing);
  for (const value of cases)
    assert.equal(outcome("normal", value).state, "pending");
});
test("exact original request, target digest and confirmed release cannot be substituted", () => {
  for (const patch of [
    { requestId: recoveryId },
    { targetDigest: "sha256:" + "b".repeat(64) },
    { targetReleaseId: "v0.3.99" },
  ]) {
    const value = status();
    value.attempt = { ...value.attempt, ...patch };
    assert.equal(outcome("normal", value).state, "failed");
  }
  const wrong = status();
  wrong.confirmedServiceRelease.releaseId = "v0.3.21-experiment.1";
  assert.equal(outcome("normal", wrong).state, "failed");
  const blocked = status({ recovered: true });
  blocked.recovery.phase = "blocked";
  assert.equal(outcome("business-fault", blocked).state, "failed");
});
