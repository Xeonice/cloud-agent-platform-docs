import { join } from "node:path";
import { canonical, digest, invariant } from "./trust.mjs";
import { secureDirectory, readJson, atomicJson } from "./io.mjs";

const ID = /^[a-zA-Z0-9._:-]{1,200}$/,
  HASH = /^sha256:[a-f0-9]{64}$/;
const time = (value) =>
  typeof value === "string" && Number.isFinite(Date.parse(value));
/** Pure shared interpretation of the two durable normal-exit receipt formats.
 * Legacy migration receipts retain their original bytes and timestamps. */
export function validateCoordinatorExitReceipt(
  receipt,
  { instanceId, target, now = Date.now() },
) {
  try {
    const { receiptDigest, ...facts } = receipt;
    if (
      receipt.schemaVersion !== 1 ||
      receipt.kind !== "coordinator-normal-exit" ||
      receipt.instanceId !== instanceId ||
      receiptDigest !== digest(facts) ||
      !ID.test(receipt.originalCommandId) ||
      !time(receipt.exitedAt) ||
      Date.parse(receipt.exitedAt) > now
    )
      return false;
    const t = receipt.target,
      a = receipt.after;
    if (
      !t ||
      !a ||
      !["containerId", "startIdentity", "artifactDigest"].every(
        (k) => t[k] === target[k],
      ) ||
      t.DockerStartedAt !== (target.DockerStartedAt ?? target.startedAt) ||
      !Number.isSafeInteger(t.restartCount) ||
      t.restartCount < 0 ||
      t.restartCount !== target.restartCount ||
      a.running !== false ||
      a.hostPid !== 0 ||
      a.restartPolicy !== "no" ||
      a.restartCount !== t.restartCount
    )
      return false;
    if (receipt.operationKind === undefined)
      return ID.test(receipt.migrationId) && receipt.operationId === undefined;
    return (
      receipt.operationKind === "candidate-retirement" &&
      ID.test(receipt.operationId) &&
      !Object.hasOwn(receipt, "migrationId") &&
      HASH.test(receipt.specDigest) &&
      t.restartCount === 0 &&
      a.paused === false &&
      a.oomKilled === false &&
      [0, 143].includes(a.exitCode) &&
      time(a.finishedAt) &&
      Date.parse(a.finishedAt) >= Date.parse(t.DockerStartedAt) &&
      receipt.exitedAt === a.finishedAt
    );
  } catch {
    return false;
  }
}

/** Called after the immutable Supervisor command became applied and before its
 * capacity/publication barrier is cleared. This never sends a signal. */
export async function publishCandidateCoordinatorExit({
  instanceId,
  row,
  retiredRoot,
  inspect,
  clock = Date.now,
}) {
  if (
    row?.state !== "applied" ||
    row.spec?.kind !== "retire-candidate" ||
    row.spec.target?.role !== "coordinator"
  )
    return null;
  const target = row.spec.target,
    result = row.result;
  invariant(
    row.spec.instanceId === instanceId &&
      row.specDigest === digest(row.spec) &&
      result?.instanceId === instanceId &&
      result.operationId === row.operationId &&
      result.commandId === row.commandId &&
      result.specDigest === row.specDigest &&
      canonical(result.target) === canonical(target) &&
      result.normalExit === true &&
      result.signal === "SIGTERM" &&
      result.forced === false &&
      result.removed === false &&
      result.volumesRemoved === false &&
      result.exit?.running === false &&
      result.exit.hostPid === 0 &&
      result.exit.oomKilled === false &&
      [0, 143].includes(result.exit.exitCode),
    "COORDINATOR_RETIREMENT_RECEIPT_UNKNOWN",
  );
  const valid = (p) =>
    p?.containerId === target.containerId &&
    p.startIdentity === target.startIdentity &&
    p.artifactDigest === target.artifactDigest &&
    p.startedAt === target.startedAt &&
    p.running === false &&
    p.hostPid === 0 &&
    p.paused === false &&
    p.restartPolicy === "no" &&
    p.restartCount === 0 &&
    p.oomKilled === false &&
    p.exitCode === result.exit.exitCode &&
    time(p.finishedAt) &&
    Date.parse(p.finishedAt) >= Date.parse(p.startedAt) &&
    Date.parse(p.finishedAt) <= clock();
  const before = await inspect(target.containerId);
  invariant(valid(before), "COORDINATOR_RETIREMENT_EXIT_UNKNOWN");
  const after = await inspect(target.containerId);
  invariant(
    valid(after) &&
      [
        "containerId",
        "startIdentity",
        "artifactDigest",
        "startedAt",
        "finishedAt",
        "restartCount",
        "exitCode",
      ].every((k) => before[k] === after[k]),
    "COORDINATOR_RETIREMENT_EXIT_CHANGED",
  );
  const receiptTarget = {
    containerId: target.containerId,
    startIdentity: target.startIdentity,
    DockerStartedAt: target.startedAt,
    artifactDigest: target.artifactDigest,
    restartCount: 0,
  };
  const facts = {
      schemaVersion: 1,
      kind: "coordinator-normal-exit",
      instanceId,
      operationKind: "candidate-retirement",
      operationId: row.operationId,
      originalCommandId: row.commandId,
      specDigest: row.specDigest,
      target: receiptTarget,
      after: {
        running: false,
        hostPid: 0,
        paused: false,
        restartPolicy: "no",
        restartCount: 0,
        oomKilled: false,
        exitCode: after.exitCode,
        finishedAt: after.finishedAt,
      },
      exitedAt: after.finishedAt,
    },
    receipt = { ...facts, receiptDigest: digest(facts) };
  invariant(
    validateCoordinatorExitReceipt(receipt, {
      instanceId,
      target: receiptTarget,
      now: clock(),
    }),
    "COORDINATOR_RETIREMENT_EXIT_UNKNOWN",
  );
  const path = join(
      await secureDirectory(retiredRoot),
      target.containerId + ".json",
    ),
    prior = await readJson(path, null);
  if (prior) {
    invariant(
      canonical(prior) === canonical(receipt),
      "COORDINATOR_RETIREMENT_PUBLICATION_CHANGED",
    );
    return prior;
  }
  await atomicJson(path, receipt);
  return receipt;
}
