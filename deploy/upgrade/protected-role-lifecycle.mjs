import * as fs from "node:fs/promises";
import { join } from "node:path";
import { invariant, canonical, digest } from "./trust.mjs";
import { readJson, atomicJson } from "./io.mjs";
const ID = /^[a-zA-Z0-9._:-]{1,200}$/;
export const fixedRoleName = (instanceId, record) =>
  "upg-" +
  digest(
    record.commandId
      ? {
          instance: instanceId,
          operationId: record.operationId,
          commandId: record.commandId,
          kind: record.kind,
        }
      : {
          instance: instanceId,
          start: record.startIdentity,
          kind: record.kind,
        },
  ).slice(7, 35);
const same = (a, b) =>
  [
    "containerId",
    "startIdentity",
    "hostPid",
    "startedAt",
    "artifactDigest",
    "attemptId",
  ].every((k) => a[k] === b[k]) && b.role === a.role;
const targetProof = (target, physical) =>
  same(target, physical) &&
  physical.running === true &&
  physical.paused === false &&
  physical.restartPolicy === "no" &&
  physical.restartCount === 0;
export function createProtectedRoleLifecycle({
  instanceId,
  registryRoot,
  inspect,
  signalTerm,
  findByName,
  clock = Date.now,
}) {
  const intentPath = (kind, r) => {
    invariant(
      ID.test(r.operationId) && ID.test(r.commandId),
      "FIXED_ROLE_COMMAND_REQUIRED",
    );
    return join(
      registryRoot,
      kind + "-" + r.operationId + "-" + r.commandId + ".json",
    );
  };
  async function prepareStart(record) {
    if (!record.commandId) return;
    const path = intentPath("start", record);
    const handle = await fs.open(path, "wx", 0o600);
    try {
      await handle.writeFile(
        JSON.stringify({ state: "executing", record, at: clock() }) + "\n",
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  async function completeStart(record, physical) {
    if (record.commandId)
      await atomicJson(intentPath("start", record), {
        state: "applied",
        record: { ...record, ...physical },
        at: clock(),
      });
  }
  async function lookupStart(record) {
    const intent = await readJson(intentPath("start", record), null);
    if (!intent)
      return { state: "definitely-not-applied", result: { dispatched: false } };
    invariant(
      intent.record.commandId === record.commandId &&
        intent.record.specDigest === record.specDigest &&
        intent.record.startIdentity === record.startIdentity,
      "ROLE_START_INTENT_CHANGED",
    );
    const id =
      intent.record.containerId ||
      (await findByName(fixedRoleName(instanceId, record)));
    if (!id)
      return {
        state: "unknown",
        result: { code: "ROLE_START_OUTCOME_UNKNOWN" },
      };
    const p = await inspect(id);
    invariant(
      p.running &&
        p.startIdentity === record.startIdentity &&
        p.artifactDigest === record.artifactDigest &&
        p.attemptId === record.attemptId &&
        p.commandId === record.commandId &&
        p.operationId === record.operationId &&
        p.role === record.kind,
      "ROLE_START_PHYSICAL_IDENTITY_UNKNOWN",
    );
    return { state: "applied", result: { ...record, ...p, state: "started" } };
  }
  function response(r, extra) {
    return {
      instanceId,
      operationId: r.operationId,
      commandId: r.commandId,
      specDigest: r.specDigest,
      target: r.target,
      ...extra,
    };
  }
  function normalExit(r, p) {
    invariant(
      p.containerId === r.target.containerId &&
        p.startIdentity === r.target.startIdentity &&
        p.startedAt === r.target.startedAt &&
        p.artifactDigest === r.target.artifactDigest &&
        p.attemptId === r.target.attemptId &&
        p.role === r.target.role &&
        !p.running &&
        p.hostPid === 0 &&
        p.oomKilled === false &&
        [0, 143].includes(p.exitCode),
      "ROLE_RETIREMENT_EXIT_UNKNOWN",
    );
    return response(r, {
      state: "applied",
      signal: "SIGTERM",
      forced: false,
      removed: false,
      volumesRemoved: false,
      normalExit: true,
      exit: {
        running: false,
        hostPid: 0,
        oomKilled: false,
        exitCode: p.exitCode,
      },
    });
  }
  async function retireCandidate(r) {
    invariant(
      r.instanceId === instanceId &&
        ["api", "coordinator", "web", "installer"].includes(r.target?.role) &&
        r.signal === "SIGTERM" &&
        typeof r.assertBeforeDispatch === "function",
      "ROLE_RETIREMENT_SCOPE_FORBIDDEN",
    );
    const before = await inspect(r.target.containerId);
    invariant(
      targetProof(r.target, before),
      "ROLE_RETIREMENT_PHYSICAL_CAS_CHANGED",
    );
    const path = intentPath("retire", r),
      input = { ...r };
    delete input.assertBeforeDispatch;
    delete input.abortSignal;
    const handle = await fs.open(path, "wx", 0o600);
    try {
      await handle.writeFile(
        JSON.stringify({ state: "executing", input, at: clock() }) + "\n",
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
    await r.assertBeforeDispatch();
    const fresh = await inspect(r.target.containerId);
    invariant(
      targetProof(r.target, fresh),
      "ROLE_RETIREMENT_PHYSICAL_CAS_CHANGED",
    );
    r.abortSignal?.throwIfAborted();
    const after = await signalTerm(r.target.containerId, "SIGTERM");
    const result = normalExit(r, after);
    await atomicJson(path, { state: "applied", input, result, at: clock() });
    return result;
  }
  async function lookupRetirement(r) {
    const intent = await readJson(intentPath("retire", r), null);
    if (!intent)
      return response(r, {
        state: "definitely-not-applied",
        definitelyNotApplied: true,
      });
    invariant(
      intent.input.specDigest === r.specDigest &&
        canonical(intent.input.target) === canonical(r.target),
      "ROLE_RETIREMENT_INTENT_CHANGED",
    );
    try {
      return normalExit(r, await inspect(r.target.containerId));
    } catch {
      return response(r, { state: "unknown" });
    }
  }
  return {
    prepareStart,
    completeStart,
    lookupStart,
    retireCandidate,
    lookupRetirement,
  };
}
