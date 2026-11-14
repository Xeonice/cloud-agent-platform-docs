const SCENARIOS = new Set([
  "normal",
  "agent-restart",
  "business-fault",
  "unknown-ack",
]);
const HASH = /^sha256:[a-f0-9]{64}$/;
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

/** Classifies an actual public UpgradeStatus payload after the caller validates
 * it with the deployed artifact's contract. This is a QA outcome gate, not
 * Native qualification: original Guest/CLI/process and durable recovery receipts
 * are still required by the scenario. Recovered service is not a B activation.
 */
export function independentNativeOutcome({ scenario, status, command }) {
  if (
    !SCENARIOS.has(scenario) ||
    !status ||
    !command ||
    !UUID.test(command.requestId) ||
    !HASH.test(command.targetDigest) ||
    typeof command.targetReleaseId !== "string"
  )
    throw Object.assign(new Error("Invalid qualification outcome scope"), {
      code: "INDEPENDENT_NATIVE_OUTCOME_SCOPE_INVALID",
    });
  const pending = { state: "pending" };
  const failed = (code) => ({ state: "failed", code });
  const attempt = status.attempt,
    recovery = status.recovery;
  if (recovery?.phase === "blocked")
    return failed("INDEPENDENT_NATIVE_RECOVERY_BLOCKED");
  if (recovery?.phase === "recovered" && scenario !== "business-fault")
    return failed("INDEPENDENT_NATIVE_TARGET_NOT_CONFIRMED");
  const scopeMatches =
    attempt?.requestId === command.requestId &&
    attempt.targetReleaseId === command.targetReleaseId &&
    attempt.targetDigest === command.targetDigest;
  if (
    (attempt?.state === "activation-confirmed" ||
      recovery?.phase === "recovered") &&
    !scopeMatches
  )
    return failed("INDEPENDENT_NATIVE_OUTCOME_SCOPE_CHANGED");
  if (
    status.serviceAvailability?.state !== "available" ||
    status.observation?.state !== "fresh" ||
    status.serviceState !== "confirmed"
  )
    return pending;
  if (attempt?.state === "activation-confirmed") {
    if (status.confirmedServiceRelease?.releaseId !== command.targetReleaseId)
      return failed("INDEPENDENT_NATIVE_TARGET_NOT_CONFIRMED");
    return { state: "confirmed", releaseId: command.targetReleaseId };
  }
  if (scenario === "business-fault" && recovery?.phase === "recovered") {
    if (
      recovery.state !== "recovery-confirmed" ||
      !recovery.confirmedAt ||
      recovery.triggeringAttemptId !== attempt?.attemptId
    )
      return failed("INDEPENDENT_NATIVE_RECOVERY_UNCONFIRMED");
    return { state: "recovered", recoveryId: recovery.recoveryAttemptId };
  }
  return pending;
}
