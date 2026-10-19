import * as fs from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { canonical, digest, invariant } from "./trust.mjs";
import { atomicJson, secureDirectory } from "./io.mjs";
import { readSupervisorFact } from "./supervisor-control.mjs";
const HASH = /^sha256:[a-f0-9]{64}$/,
  CID = /^[a-f0-9]{64}$/;
const ROLES = ["api", "coordinator", "web", "installer"];
const physical = (p) => ({
  containerId: p.containerId,
  startIdentity: p.startIdentity,
  hostPid: p.hostPid,
  startedAt: p.startedAt,
  birthTicks: p.birthTicks,
  cgroupDigest: p.cgroupDigest,
  role: p.role,
  running: p.running,
  paused: p.paused,
  restartCount: p.restartCount,
  restartPolicy: p.restartPolicy,
});
const safeOrigin = (value) => {
  const u = new URL(value);
  invariant(
    u.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) &&
      u.pathname === "/" &&
      !u.search &&
      !u.hash &&
      !u.username &&
      !u.password,
    "INITIAL_ROLE_ORIGIN_UNKNOWN",
  );
  return u.origin;
};
function validRole(row) {
  return (
    row &&
    ROLES.includes(row.kind) &&
    CID.test(row.containerId) &&
    typeof row.startIdentity === "string" &&
    row.startIdentity.length >= 16 &&
    Number.isSafeInteger(row.hostPid) &&
    row.hostPid > 1 &&
    Number.isFinite(Date.parse(row.startedAt)) &&
    /^\d+$/.test(row.birthTicks) &&
    HASH.test(row.cgroupDigest) &&
    HASH.test(row.artifactDigest) &&
    HASH.test(row.inputFingerprint) &&
    row.attemptId === null &&
    row.retirementScope === "bootstrap-activation" &&
    isAbsolute(row.artifactRoot)
  );
}
function check(value, instanceId) {
  const { inventoryDigest, ...facts } = value ?? {};
  invariant(
    value?.schemaVersion === 1 &&
      value.kind === "initial-role-inventory" &&
      value.instanceId === instanceId &&
      HASH.test(inventoryDigest) &&
      digest(facts) === inventoryDigest &&
      value.activation?.activationGeneration === 1 &&
      typeof value.activation.releaseId === "string" &&
      Number.isFinite(Date.parse(value.activation.activatedAt)) &&
      HASH.test(value.activation.activationDigest) &&
      Array.isArray(value.roles) &&
      [3, 4].includes(value.roles.length) &&
      ["api", "coordinator", "web"].every((kind) =>
        value.roles.some((row) => row.kind === kind),
      ) &&
      new Set(value.roles.map((r) => r.containerId)).size ===
        value.roles.length &&
      value.roles.every((r) => safeOrigin(r.origin) === r.origin) &&
      new Set(value.roles.map((r) => r.kind)).size === value.roles.length &&
      value.roles.every(validRole) &&
      value.roles.every(
        (r) =>
          r.instanceId === instanceId &&
          r.sourceActivationDigest === value.activation.activationDigest,
      ),
    "INITIAL_ROLE_INVENTORY_UNKNOWN",
  );
  return value;
}
/** Bootstrap is the sole writer. Its already-verified release must be the
 * actual successful bootstrap response, never an invented upgrade attempt. */
export async function publishInitialRoleInventory({
  path,
  instanceId,
  activation,
  records,
  inspect,
  readIdentity,
}) {
  invariant(
    isAbsolute(path) &&
      activation?.activationGeneration === 1 &&
      Array.isArray(records) &&
      [3, 4].includes(records.length) &&
      typeof inspect === "function" &&
      typeof readIdentity === "function",
    "INITIAL_ROLE_REGISTRATION_REQUIRED",
  );
  const activationDigest = digest(activation),
    roles = [];
  for (const record of records) {
    invariant(
      ROLES.includes(record.kind) &&
        record.instanceId === instanceId &&
        CID.test(record.containerId) &&
        activation.components?.[record.kind]?.artifactDigest ===
          record.artifactDigest &&
        activation.components[record.kind].inputFingerprint ===
          record.inputFingerprint,
      "INITIAL_ROLE_ACTIVATION_MISMATCH",
    );
    const before = await inspect(record.containerId),
      actual = await readIdentity(record),
      after = await inspect(record.containerId);
    invariant(
      canonical(physical(before)) === canonical(physical(after)) &&
        before.containerId === record.containerId &&
        before.startIdentity === record.startIdentity &&
        before.artifactDigest === record.artifactDigest &&
        before.running === true &&
        before.paused === false &&
        before.role === record.kind &&
        before.restartPolicy === "no" &&
        Number.isSafeInteger(before.restartCount),
      "INITIAL_ROLE_PHYSICAL_CHANGED",
    );
    invariant(
      actual.instanceId === instanceId &&
        actual.startIdentity === record.startIdentity &&
        actual.artifactDigest === record.artifactDigest &&
        actual.pid === before.pid &&
        (record.kind === "web"
          ? actual.role === undefined
          : actual.role ===
            {
              api: "control",
              coordinator: "coordinator",
              installer: "installer",
            }[record.kind]),
      "INITIAL_ROLE_METADATA_CHANGED",
    );
    if (record.kind === "web")
      invariant(
        actual.webRevision === activation.components.web.webRevision,
        "INITIAL_ROLE_WEB_REVISION_CHANGED",
      );
    const row = {
      instanceId,
      kind: record.kind,
      containerId: before.containerId,
      startIdentity: before.startIdentity,
      hostPid: before.hostPid,
      startedAt: before.startedAt,
      birthTicks: before.birthTicks,
      cgroupDigest: before.cgroupDigest,
      artifactDigest: record.artifactDigest,
      inputFingerprint: record.inputFingerprint,
      artifactRoot: record.artifactRoot,
      origin: safeOrigin(record.origin),
      pid: before.pid,
      attemptId: null,
      retirementScope: "bootstrap-activation",
      sourceActivationDigest: activationDigest,
    };
    invariant(validRole(row), "INITIAL_ROLE_PHYSICAL_UNKNOWN");
    roles.push(row);
  }
  roles.sort((a, b) => a.kind.localeCompare(b.kind));
  const facts = {
    schemaVersion: 1,
    kind: "initial-role-inventory",
    instanceId,
    activation: {
      releaseId: activation.releaseId,
      activationGeneration: 1,
      activatedAt: activation.activatedAt,
      activationDigest,
    },
    roles,
  };
  const value = { ...facts, inventoryDigest: digest(facts) };
  check(value, instanceId);
  await secureDirectory(dirname(path));
  const previous = await readSupervisorFact(path, 65536).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (previous) {
    check(previous.value, instanceId);
    invariant(
      canonical(previous.value) === canonical(value),
      "INITIAL_ROLE_REGISTRATION_CONFLICT",
    );
    return previous.value;
  }
  await atomicJson(path, value);
  return value;
}
/** Fixed read-only metadata, with RAM-only installation keys. No Owner route,
 * public business API, redirects, tree scans, SDK or lifecycle operation. */
export function createInitialRoleIdentityReader({
  instanceId,
  controlKey,
  controllerKey,
  fetcher = fetch,
}) {
  return async (record) => {
    const paths = {
        api: "/internal/control/identity",
        coordinator: "/internal/application/identity",
        web: "/web-process",
        installer: "/metadata",
      },
      path = paths[record.kind];
    invariant(path, "INITIAL_ROLE_METADATA_SCOPE_UNKNOWN");
    const key = record.kind === "installer" ? controllerKey : controlKey;
    if (record.kind !== "web")
      invariant(
        typeof key === "string" && key.length >= 32,
        "INITIAL_ROLE_METADATA_KEY_REQUIRED",
      );
    const response = await fetcher(safeOrigin(record.origin) + path, {
      method: "GET",
      headers:
        record.kind === "web"
          ? {}
          : {
              "x-platform-internal-key": key,
              "x-platform-instance-id": instanceId,
            },
      signal: AbortSignal.timeout(2000),
      redirect: "error",
    });
    invariant(response.ok, "INITIAL_ROLE_METADATA_UNAVAILABLE");
    const reader = response.body?.getReader();
    invariant(reader, "INITIAL_ROLE_METADATA_UNKNOWN");
    const chunks = [];
    let bytes = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.length;
        invariant(bytes <= 16384, "INITIAL_ROLE_METADATA_LIMIT");
        chunks.push(next.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  };
}
export async function readInitialRoleInventory({ path, instanceId }) {
  return check((await readSupervisorFact(path, 65536)).value, instanceId);
}
