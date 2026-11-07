import { basename, isAbsolute, relative, resolve } from "node:path";
import {
  canonical,
  digest,
  invariant,
  runInputFingerprint,
  verifySignedManifest,
} from "./trust.mjs";

const HASH = /^sha256:[a-f0-9]{64}$/;
const CID = /^[a-f0-9]{64}$/;
const exact = (value, fields) =>
  value &&
  Object.getPrototypeOf(value) === Object.prototype &&
  Object.keys(value).sort().join(",") === [...fields].sort().join(",");
const timestamp = (value) =>
  typeof value === "string" && Number.isFinite(Date.parse(value));
const canonicalPath = (value) =>
  typeof value === "string" &&
  !/[\0\r\n]/.test(value) &&
  isAbsolute(value) &&
  resolve(value) === value;
const contains = (root, value) => {
  const suffix = relative(root, value);
  return !isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith("../");
};
const targetFields = [
  "containerId",
  "startIdentity",
  "artifactDigest",
  "artifactRoot",
  "imageDigest",
  "startedAt",
  "finishedAt",
  "restartCount",
  "exitCode",
];
const proofFields = [
  "instanceId",
  "declaredEnvArtifactDigest",
  "environmentDigest",
  "commandDigest",
  "mountDigest",
  "dead",
  "restarting",
  "stateErrorEmpty",
];

/** Require the actual exact artifact bind. Matching read-only ancestor binds
 * may coexist, but no deeper overlay is accepted. The historical publisher
 * separately verifies the old tree and symlinks; no old code is read here. */
export function hasReadOnlyLegacyArtifactCoverage(mounts, artifactRoot) {
  if (!Array.isArray(mounts) || !canonicalPath(artifactRoot)) return false;
  let covered = false;
  for (const m of mounts) {
    if (!canonicalPath(m.destination)) return false;
    if (
      !contains(m.destination, artifactRoot) &&
      !contains(artifactRoot, m.destination)
    )
      continue;
    if (
      !canonicalPath(m.source) ||
      m.type !== "bind" ||
      m.rw !== false ||
      m.source !== m.destination
    )
      return false;
    if (m.destination === artifactRoot) covered = true;
    else if (contains(artifactRoot, m.destination)) return false;
  }
  return covered;
}

/** No raw environment values leave the adapter. This projection does not turn
 * an absent Docker artifact label into an authenticated artifact identity. */
export function projectLegacyCoordinatorInertHistory(row) {
  if (
    row?.Config?.Labels?.["agent-platform.role"] !== "coordinator" ||
    row.Config.Labels["agent-platform.artifact"] != null ||
    row.State?.Running !== false ||
    !Array.isArray(row.Config.Env) ||
    !Array.isArray(row.Mounts)
  )
    return null;
  const declared = row.Config.Env.filter(
    (v) => typeof v === "string" && v.startsWith("PLATFORM_ARTIFACT_DIGEST="),
  );
  if (declared.length !== 1) return null;
  return {
    instanceId: row.Config.Labels["agent-platform.instance"],
    declaredEnvArtifactDigest: declared[0].slice(
      "PLATFORM_ARTIFACT_DIGEST=".length,
    ),
    environmentDigest: digest(row.Config.Env),
    commandDigest: digest({
      entrypoint: row.Config.Entrypoint,
      command: row.Config.Cmd,
      cwd: row.Config.WorkingDir,
    }),
    mountDigest: digest(
      row.Mounts.map((m) => ({
        source: m.Source,
        destination: m.Destination,
        rw: m.RW,
      })).sort((a, b) => a.destination.localeCompare(b.destination)),
    ),
    dead: row.State.Dead,
    restarting: row.State.Restarting,
    stateErrorEmpty: row.State.Error === "",
  };
}

/** Explicit historical evidence, never a normal-stop receipt or permission to
 * start/stop a container. Only already-inert, artifact-unlabelled Coordinators
 * may use it. Every observation verifies the original envelope under the
 * installation's current trust root and rechecks the actual immutable tuple. */
function verifyReceipt(receipt, { instanceId, record, roots, now }) {
  const fail = (value) =>
    invariant(value, "COORDINATOR_INERT_HISTORY_UNPROVEN");
  fail(
    exact(receipt, [
      "schemaVersion",
      "kind",
      "instanceId",
      "recordedAt",
      "target",
      "proof",
      "signedManifest",
      "manifestDigest",
      "packageDigest",
      "receiptDigest",
    ]),
  );
  const { receiptDigest, ...facts } = receipt;
  fail(
    receipt.schemaVersion === 1 &&
      receipt.kind === "legacy-coordinator-inert-history" &&
      receipt.instanceId === instanceId &&
      timestamp(receipt.recordedAt) &&
      Date.parse(receipt.recordedAt) <= now &&
      receiptDigest === digest(facts),
  );
  const target = receipt.target,
    proof = receipt.proof;
  fail(exact(target, targetFields) && exact(proof, proofFields));
  fail(
    CID.test(target.containerId) &&
      HASH.test(target.artifactDigest) &&
      HASH.test(target.imageDigest) &&
      typeof target.startIdentity === "string" &&
      target.startIdentity.length >= 16 &&
      timestamp(target.startedAt) &&
      timestamp(target.finishedAt) &&
      Date.parse(target.finishedAt) > Date.parse(target.startedAt) &&
      Date.parse(target.finishedAt) <= Date.parse(receipt.recordedAt) &&
      target.restartCount === 0 &&
      Number.isSafeInteger(target.exitCode) &&
      target.exitCode >= 0 &&
      target.exitCode <= 255 &&
      canonicalPath(target.artifactRoot) &&
      receipt.packageDigest === "sha256:" + basename(target.artifactRoot),
  );
  fail(
    record?.kind === "coordinator" &&
      record.instanceId === instanceId &&
      ["containerId", "startIdentity", "artifactDigest"].every(
        (k) => record[k] === target[k],
      ),
  );
  fail(
    proof.instanceId === instanceId &&
      proof.declaredEnvArtifactDigest === target.artifactDigest &&
      ["environmentDigest", "commandDigest", "mountDigest"].every((k) =>
        HASH.test(proof[k]),
      ) &&
      proof.dead === false &&
      proof.restarting === false &&
      proof.stateErrorEmpty === true,
  );
  const verified = verifySignedManifest(receipt.signedManifest, roots, now);
  fail(
    verified.manifestDigest === receipt.manifestDigest &&
      verified.manifest.components.coordinator.artifactDigest ===
        target.artifactDigest &&
      verified.manifest.packages.some(
        (p) =>
          p.digest === receipt.packageDigest &&
          p.platform === "linux" &&
          p.arch === "arm64",
      ),
  );
  if (verified.purpose === "qualification")
    fail(
      roots.qualificationInstanceId === instanceId &&
        verified.manifest.qualification.instanceId === instanceId &&
        verified.manifest.qualification.inputFingerprint ===
          runInputFingerprint(verified.manifest),
    );
  return receipt;
}

function verifyPhysical(receipt, physical) {
  const target = receipt.target;
  invariant(
    physical?.role === "coordinator" &&
      physical.artifactDigest === null &&
      physical.running === false &&
      physical.hostPid === 0 &&
      physical.paused === false &&
      physical.restartPolicy === "no" &&
      physical.restartCount === 0 &&
      physical.oomKilled === false &&
      [
        "containerId",
        "startIdentity",
        "imageDigest",
        "startedAt",
        "finishedAt",
        "exitCode",
      ].every((k) => physical[k] === target[k]) &&
      canonical(physical.legacyInertProof) === canonical(receipt.proof),
    "COORDINATOR_INERT_HISTORY_PHYSICAL_CHANGED",
  );
}

export function verifyLegacyCoordinatorInertHistory(
  receipt,
  { instanceId, record, physical, roots, now = Date.now() },
) {
  verifyReceipt(receipt, { instanceId, record, roots, now });
  verifyPhysical(receipt, physical);
  invariant(
    hasReadOnlyLegacyArtifactCoverage(
      physical.mounts,
      receipt.target.artifactRoot,
    ),
    "COORDINATOR_INERT_HISTORY_MOUNT_UNKNOWN",
  );
  return { ...receipt, observedAt: new Date(now).toISOString() };
}

/** Consumes only the authenticated private Supervisor's fresh inventory. It
 * verifies the original envelope again under the current root, never promotes
 * the null Docker label, and grants no lifecycle/normal-exit authority. */
export function verifyLegacyCoordinatorInertHistoryWire(
  record,
  { instanceId, roots, now = Date.now() },
) {
  const { observedAt, ...receipt } = record.retiredPhysical ?? {};
  invariant(
    timestamp(observedAt) &&
      now >= Date.parse(observedAt) &&
      now - Date.parse(observedAt) <= 5000,
    "COORDINATOR_INERT_HISTORY_WIRE_STALE",
  );
  verifyReceipt(receipt, {
    instanceId,
    record: {
      kind: "coordinator",
      instanceId,
      containerId: record.containerId,
      startIdentity: record.startIdentity,
      artifactDigest: record.artifactDigest,
    },
    roots,
    now,
  });
  verifyPhysical(receipt, record.physical);
  invariant(
    record.physical.declaredEnvArtifactDigest ===
      receipt.target.artifactDigest &&
      record.physical.DockerStartedAt === receipt.target.startedAt,
    "COORDINATOR_INERT_HISTORY_WIRE_CHANGED",
  );
  return { ...receipt, observedAt };
}
