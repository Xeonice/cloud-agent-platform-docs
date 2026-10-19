import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, dirname, join } from "node:path";
import { createRequire } from "node:module";
import { invariant, canonical, digest } from "./trust.mjs";
import { secureDirectory } from "./io.mjs";
import { createControlCommandJournal } from "./control-command-journal.mjs";
import { evaluateCapacityAdmission } from "./capacity-admission.mjs";
const ID = /^[a-zA-Z0-9._:-]{1,200}$/,
  HASH = /^sha256:[a-f0-9]{64}$/;
const keys = (v, required, optional = []) =>
  v &&
  Object.getPrototypeOf(v) === Object.prototype &&
  required.every((k) => Object.hasOwn(v, k)) &&
  Object.keys(v).every((k) => [...required, ...optional].includes(k));
const identity = (s) => ({
  dev: String(s.dev),
  ino: String(s.ino),
  size: s.size,
  mtimeMs: s.mtimeMs,
  ctimeMs: s.ctimeMs,
});
const loopbackOrigin = (value) => {
  const u = new URL(value);
  invariant(
    u.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) &&
      u.pathname === "/" &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash,
    "SUPERVISOR_CONTROL_ORIGIN_INVALID",
  );
  return u.origin;
};
const code = (e) =>
  /^[A-Z0-9_]{1,100}$/.test(e?.code || "")
    ? e.code
    : "SUPERVISOR_COMMAND_OUTCOME_UNKNOWN";
/** Fixed private files only. A replaced inode, symlink, large input or mid-read edit is unknown. */
export async function readSupervisorFact(path, maxBytes = 262144) {
  invariant(isAbsolute(path), "SUPERVISOR_FACT_PATH_REQUIRED");
  const handle = await fs.open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat();
    invariant(
      before.isFile() && before.size <= maxBytes && (before.mode & 0o022) === 0,
      "SUPERVISOR_FACT_INSECURE",
    );
    const bytes = await handle.readFile();
    invariant(bytes.length <= maxBytes, "SUPERVISOR_FACT_TOO_LARGE");
    const after = await handle.stat(),
      current = await fs.lstat(path);
    invariant(
      canonical(identity(before)) === canonical(identity(after)) &&
        canonical(identity(after)) === canonical(identity(current)) &&
        !current.isSymbolicLink(),
      "SUPERVISOR_FACT_CHANGED",
    );
    return {
      value: JSON.parse(bytes.toString("utf8")),
      identity: identity(after),
      digest: digest(bytes.toString("utf8")),
    };
  } finally {
    await handle.close();
  }
}
/** Foundation-owned state only: no platform.db and no business Coordinator binding. */
export async function createSupervisorControl({
  instanceId,
  root,
  config,
  Database,
  sqlite,
  readers = {},
  clock = Date.now,
  fetcher = fetch,
}) {
  invariant(
    ID.test(instanceId) &&
      config &&
      keys(
        config,
        [
          "origin",
          "key",
          "accessKey",
          "statePath",
          "capacityPlanPath",
          "resourceObservationPath",
          "referenceStatePath",
          "controlDbPath",
        ],
        [
          "agentStartIdentity",
          "capacityCollectorConfigPath",
          "capacityTransitionRoot",
          "maintenanceKey",
          "maintenance",
          "capacityTemplates",
          "migratedArtifactPath",
        ],
      ) &&
      config.key?.length >= 32 &&
      typeof config.accessKey === "string" &&
      config.accessKey.length >= 32 &&
      config.accessKey !== config.key &&
      [
        "statePath",
        "capacityPlanPath",
        "resourceObservationPath",
        "referenceStatePath",
        "controlDbPath",
      ].every((k) => isAbsolute(config[k])) &&
      config.statePath !== config.controlDbPath &&
      (config.migratedArtifactPath === undefined ||
        config.migratedArtifactPath ===
          join(dirname(root), "bindings/migration-source.json")),
    "SUPERVISOR_STABLE_CONTROL_CONFIG_INVALID",
  );
  const origin = loopbackOrigin(config.origin);
  await secureDirectory(dirname(config.statePath));
  if (!sqlite) {
    if (!Database)
      Database = createRequire(
        new URL("../../api/package.json", import.meta.url),
      )("better-sqlite3");
    const prior = await fs.lstat(config.statePath).catch((e) => {
      if (e.code === "ENOENT") return null;
      throw e;
    });
    if (prior) {
      invariant(
        prior.isFile() &&
          !prior.isSymbolicLink() &&
          (prior.mode & 0o077) === 0 &&
          (await fs.realpath(config.statePath)) === config.statePath,
        "SUPERVISOR_STATE_DB_INSECURE",
      );
      const probe = new Database(config.statePath, {
        readonly: true,
        fileMustExist: true,
      });
      try {
        const tables = probe
          .prepare("SELECT name FROM sqlite_master WHERE type='table'")
          .all()
          .map((r) => r.name);
        invariant(
          tables.every((name) =>
            [
              "supervisor_control_admission",
              "supervisor_side_effect",
              "control_commands",
              "supervisor_control_maintenance",
              "supervisor_control_maintenance_actions",
              "supervisor_capacity_templates",
              "supervisor_capacity_reservations",
            ].includes(name),
          ),
          "SUPERVISOR_STATE_DB_WRONG_SCOPE",
        );
      } finally {
        probe.close();
      }
    }
    sqlite = new Database(config.statePath);
    await fs.chmod(config.statePath, 0o600);
  }
  sqlite.pragma("busy_timeout = 50");
  sqlite.exec(`CREATE TABLE IF NOT EXISTS supervisor_control_admission(singleton INTEGER PRIMARY KEY CHECK(singleton=1),instance_id TEXT NOT NULL,epoch INTEGER NOT NULL,operation_id TEXT NOT NULL,executor_id TEXT NOT NULL,kind TEXT NOT NULL,lease_expires_at INTEGER NOT NULL,reconcile_operation_id TEXT,revision INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS supervisor_side_effect(singleton INTEGER PRIMARY KEY CHECK(singleton=1),operation_id TEXT NOT NULL,command_id TEXT NOT NULL,spec_digest TEXT NOT NULL);`);
  let baseJournal,
    phase = "begin",
    live = null;
  const current = () => {
    const r = sqlite
      .prepare("SELECT * FROM supervisor_control_admission WHERE singleton=1")
      .get();
    invariant(r?.instance_id === instanceId, "SUPERVISOR_CONTROL_NOT_ADMITTED");
    return r;
  };
  function permit(a, input) {
    const c = current();
    invariant(
      c.kind !== "contract" ||
        (input.spec || baseJournal?.lookup(input)?.spec)?.kind ===
          "contract-retire-reader",
      "SUPERVISOR_CONTRACT_SIDE_EFFECT_FORBIDDEN",
    );
    invariant(
      a &&
        a.epoch === c.epoch &&
        a.executorId === c.executor_id &&
        Number.isFinite(a.expiresAt) &&
        a.expiresAt > clock() &&
        a.expiresAt <= c.lease_expires_at &&
        c.lease_expires_at > clock(),
      "SUPERVISOR_CONTROL_AUTHORITY_STALE",
    );
    if (input.operationId !== c.operation_id) {
      const old = baseJournal.lookup(input);
      invariant(
        phase === "record" &&
          c.kind === "recovery" &&
          input.operationId === c.reconcile_operation_id &&
          old &&
          ["executing", "unknown"].includes(old.state),
        "SUPERVISOR_RECONCILE_ONLY",
      );
    }
  }
  baseJournal = createControlCommandJournal({
    sqlite,
    instanceId,
    clock,
    assertAuthority: permit,
  });
  function inPhase(value, fn) {
    const old = phase;
    phase = value;
    try {
      return fn();
    } finally {
      phase = old;
    }
  }
  const journal = {
    ...baseJournal,
    prepare: (input) => inPhase("prepare", () => baseJournal.prepare(input)),
    begin: (input) =>
      sqlite
        .transaction(() =>
          inPhase("begin", () => {
            const barrier = sqlite
              .prepare("SELECT * FROM supervisor_side_effect WHERE singleton=1")
              .get();
            invariant(!barrier, "SUPERVISOR_SINGLE_FLIGHT_BLOCKED");
            const row = baseJournal.begin(input);
            sqlite
              .prepare("INSERT INTO supervisor_side_effect VALUES(1,?,?,?)")
              .run(input.operationId, input.commandId, row.specDigest);
            return row;
          }),
        )
        .immediate(),
    record: (input) =>
      sqlite
        .transaction(() =>
          inPhase("record", () => {
            const row = baseJournal.record(input);
            if (
              ["applied", "blocked", "definitely-not-applied"].includes(
                row.state,
              ) &&
              !(
                config.capacityCollectorConfigPath &&
                row.state === "applied" &&
                ["supervisor-start", "retire-candidate"].includes(row.spec.kind)
              )
            )
              sqlite
                .prepare(
                  "DELETE FROM supervisor_side_effect WHERE singleton=1 AND operation_id=? AND command_id=? AND spec_digest=?",
                )
                .run(input.operationId, input.commandId, row.specDigest);
            return row;
          }),
        )
        .immediate(),
  };
  async function verifyGrant(input) {
    invariant(
      keys(input, ["epoch", "operationId", "executorId"]) &&
        Number.isSafeInteger(input.epoch) &&
        input.epoch > 0 &&
        ID.test(input.operationId) &&
        ID.test(input.executorId),
      "SUPERVISOR_CONTROL_ADMISSION_INVALID",
    );
    if (readers.verifyAuthority) return readers.verifyAuthority(input);
    const response = await fetcher(
      origin + "/internal/control/authority/verify",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-platform-internal-key": config.key,
          "x-platform-instance-id": instanceId,
        },
        body: JSON.stringify(input),
        redirect: "error",
        signal: AbortSignal.timeout(2000),
      },
    );
    invariant(response.ok, "SUPERVISOR_GLOBAL_AUTHORITY_REJECTED");
    const bytes = [];
    let count = 0;
    invariant(response.body, "SUPERVISOR_GLOBAL_AUTHORITY_UNKNOWN");
    for await (const chunk of response.body) {
      count += chunk.length;
      invariant(count <= 16384, "SUPERVISOR_GLOBAL_AUTHORITY_TOO_LARGE");
      bytes.push(chunk);
    }
    return JSON.parse(Buffer.concat(bytes).toString("utf8"));
  }
  function checkGrant(g, input) {
    invariant(
      g &&
        g.instanceId === instanceId &&
        g.mode === "active" &&
        g.epoch === input.epoch &&
        g.operationId === input.operationId &&
        g.holderId === input.executorId &&
        ["upgrade", "recovery", "maintenance", "contract"].includes(g.kind) &&
        Number.isSafeInteger(g.leaseExpiresAt) &&
        g.leaseExpiresAt > clock(),
      "SUPERVISOR_GLOBAL_AUTHORITY_UNKNOWN",
    );
  }
  async function admit(input) {
    const grant = await verifyGrant(input);
    checkGrant(grant, input);
    return sqlite
      .transaction(() => {
        const old = sqlite
          .prepare(
            "SELECT * FROM supervisor_control_admission WHERE singleton=1",
          )
          .get();
        invariant(
          !old || input.epoch >= old.epoch,
          "SUPERVISOR_CONTROL_EPOCH_STALE",
        );
        if (old && input.epoch === old.epoch)
          invariant(
            old.operation_id === input.operationId &&
              old.executor_id === input.executorId &&
              old.kind === grant.kind,
            "SUPERVISOR_CONTROL_EPOCH_CONFLICT",
          );
        const pending = sqlite
          .prepare(
            "SELECT operation_id FROM supervisor_side_effect WHERE singleton=1",
          )
          .get();
        const reconcile =
          grant.kind === "recovery" &&
          pending &&
          pending.operation_id !== input.operationId
            ? pending.operation_id
            : null;
        sqlite
          .prepare(
            "INSERT INTO supervisor_control_admission VALUES(1,?,?,?,?,?,?,?,?) ON CONFLICT(singleton) DO UPDATE SET epoch=excluded.epoch,operation_id=excluded.operation_id,executor_id=excluded.executor_id,kind=excluded.kind,lease_expires_at=excluded.lease_expires_at,reconcile_operation_id=excluded.reconcile_operation_id,revision=supervisor_control_admission.revision+1",
          )
          .run(
            instanceId,
            input.epoch,
            input.operationId,
            input.executorId,
            grant.kind,
            grant.leaseExpiresAt,
            reconcile,
            (old?.revision || 0) + 1,
          );
        return {
          instanceId,
          epoch: input.epoch,
          operationId: input.operationId,
          executorId: input.executorId,
          leaseExpiresAt: grant.leaseExpiresAt,
          admitted: true,
        };
      })
      .immediate();
  }
  async function assertCurrent(command) {
    const c = current();
    permit(command.authorization, {
      operationId: c.operation_id,
      commandId: command.commandId,
      spec: command.spec,
    });
    const request = {
        epoch: c.epoch,
        operationId: c.operation_id,
        executorId: c.executor_id,
      },
      g = await verifyGrant(request);
    checkGrant(g, request);
    invariant(
      g.epoch === current().epoch && g.operationId === current().operation_id,
      "SUPERVISOR_CONTROL_CHANGED",
    );
    return g;
  }
  async function capacity(spec) {
    const plan = await readSupervisorFact(config.capacityPlanPath),
      observed = readers.capacity
        ? await readers.capacity()
        : await readSupervisorFact(config.resourceObservationPath);
    const observation = observed.value ?? observed;
    invariant(
      spec.capacityPlanDigest === plan.value.planDigest &&
        spec.sourceDigest === plan.value.sourceDigest,
      "SUPERVISOR_CAPACITY_PLAN_CHANGED",
    );
    if (spec.kind === "supervisor-start") {
      const matches = plan.value.allocations?.candidate?.filter(
        (item) => item.id === spec.capacityAllocationId,
      );
      invariant(
        matches?.length === 1 &&
          matches[0].resident === false &&
          canonical(matches[0].resources) === canonical(spec.resources),
        "SUPERVISOR_CAPACITY_ALLOCATION_CHANGED",
      );
    }
    const result = evaluateCapacityAdmission({
      plan: plan.value,
      observation,
      now: clock(),
    });
    invariant(result.qualified, result.reason || "SUPERVISOR_CAPACITY_UNKNOWN");
    return {
      result,
      plan: { identity: plan.identity, digest: plan.digest },
      observation: {
        identity: observed.identity ?? null,
        digest: observed.digest ?? digest(observation),
      },
    };
  }
  async function assertCapacity(spec, before) {
    const now = await capacity(spec);
    invariant(
      canonical(now.plan) === canonical(before.plan) &&
        canonical(now.observation) === canonical(before.observation),
      "SUPERVISOR_CAPACITY_CAS_CHANGED",
    );
    return now.result;
  }
  async function referenceState(target) {
    const fact = readers.references
      ? await readers.references(target)
      : await readSupervisorFact(config.referenceStatePath);
    const value = fact.value ?? fact;
    invariant(
      value?.instanceId === instanceId &&
        Array.isArray(value.candidates) &&
        value.candidates.length <= 128,
      "SUPERVISOR_REFERENCE_STATE_UNKNOWN",
    );
    const match = value.candidates.filter(
      (s) => canonical(s.target) === canonical(target),
    );
    invariant(match.length === 1, "SUPERVISOR_REFERENCE_TARGET_UNKNOWN");
    return match[0];
  }
  function request(command) {
    invariant(
      keys(command, [
        "operationId",
        "commandId",
        "stepId",
        "spec",
        "authorization",
      ]) &&
        ID.test(command.operationId) &&
        ID.test(command.commandId) &&
        ID.test(command.stepId) &&
        command.spec &&
        Number.isSafeInteger(command.spec.deadline) &&
        keys(command.spec.budget, ["maxDurationMs"]) &&
        Number.isSafeInteger(command.spec.budget.maxDurationMs) &&
        command.spec.budget.maxDurationMs > 0,
      "SUPERVISOR_FIXED_COMMAND_REQUIRED",
    );
    return command;
  }
  async function run(input, { execute, reconcile }) {
    const command = request(input),
      prior = journal.lookup(command);
    invariant(
      !prior ||
        (prior.specDigest === digest(command.spec) &&
          prior.stepId === command.stepId),
      "SUPERVISOR_COMMAND_SPEC_CHANGED",
    );
    await assertCurrent(command);
    if (prior?.state === "applied" || prior?.state === "blocked") return prior;
    invariant(!live, "SUPERVISOR_SINGLE_FLIGHT_BLOCKED");
    const token = {
      operationId: command.operationId,
      commandId: command.commandId,
    };
    live = token;
    let execution = null,
      settled = false;
    try {
      let row = prior;
      if (row && ["executing", "unknown"].includes(row.state)) {
        let proof;
        try {
          proof = await reconcile({ command, row });
        } catch (e) {
          proof = { state: "unknown", result: { code: code(e) } };
        }
        invariant(
          ["applied", "definitely-not-applied", "unknown"].includes(
            proof?.state,
          ),
          "SUPERVISOR_RECONCILE_RESULT_INVALID",
        );
        return journal.record({ ...command, ...proof });
      }
      row = journal.prepare(command);
      row = journal.begin(command);
      let timer;
      const remaining =
        Math.min(
          row.spec.deadline,
          row.createdAt + row.spec.budget.maxDurationMs,
        ) - clock();
      try {
        invariant(remaining > 0, "SUPERVISOR_COMMAND_BUDGET_EXPIRED");
        await assertCurrent(command);
        execution = Promise.resolve().then(() =>
          execute({
            command,
            row,
            assertCurrent: () => assertCurrent(command),
          }),
        );
        execution.then(
          () => {
            settled = true;
            if (live === token) live = null;
          },
          () => {
            settled = true;
            if (live === token) live = null;
          },
        );
        const value = await Promise.race([
          execution,
          new Promise((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  Object.assign(Error("Supervisor command timeout"), {
                    code: "SUPERVISOR_COMMAND_TIMEOUT",
                  }),
                ),
              remaining,
            );
          }),
        ]);
        return journal.record({ ...command, state: "applied", result: value });
      } catch (e) {
        return journal.record({
          ...command,
          state: "unknown",
          result: { code: code(e) },
        });
      } finally {
        clearTimeout(timer);
      }
    } finally {
      if ((!execution || settled) && live === token) live = null;
    }
  }
  const assertIdle = () => invariant(!live, "SUPERVISOR_SINGLE_FLIGHT_BLOCKED");
  function track(work) {
    assertIdle();
    const token = { adapter: true };
    live = token;
    const task = Promise.resolve().then(work);
    task.then(
      () => {
        if (live === token) live = null;
      },
      () => {
        if (live === token) live = null;
      },
    );
    return task;
  }
  const currentAuthorization = () => {
    const c = current();
    return {
      epoch: c.epoch,
      executorId: c.executor_id,
      expiresAt: c.lease_expires_at,
    };
  };
  return {
    admit,
    assertCurrent,
    currentAuthorization,
    assertIdle,
    track,
    capacity,
    assertCapacity,
    referenceState,
    run,
    journal,
    lookup: (input) => journal.lookup(input),
    pending: () => journal.pending(),
    close: () => sqlite.close(),
    statePath: config.statePath,
    // Private assembly only; never returned by an HTTP operation. Maintenance
    // owns its two fixed tables in this Supervisor database.
    assembly: { sqlite },
    completeCapacityStart(input) {
      return sqlite
        .transaction(() => {
          const row = journal.lookup(input);
          invariant(
            row?.state === "applied" &&
              ["supervisor-start", "retire-candidate"].includes(row.spec.kind) &&
              row.specDigest === input.specDigest,
            "SUPERVISOR_CAPACITY_RECEIPT_UNKNOWN",
          );
          // This private assembly callback is invoked only after the durable
          // resident publication. It cannot clear another command's barrier.
          sqlite
            .prepare(
              "DELETE FROM supervisor_side_effect WHERE singleton=1 AND operation_id=? AND command_id=? AND spec_digest=?",
            )
            .run(input.operationId, input.commandId, input.specDigest);
        })
        .immediate();
    },
  };
}
