import * as fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import {
  canonical,
  digest,
  invariant,
  DIGEST,
  loadTrustRoot,
  verifyManifest,
} from "./trust.mjs";
import {
  atomicJson,
  readJson,
  secureDirectory,
  fileDigest,
  treeManifest,
} from "./io.mjs";
import { createControlCommandJournal } from "./control-command-journal.mjs";
import { createControlAuthority } from "./control-authority.mjs";
import {
  createProductionRoleAdapter,
  execute,
  roleMounts,
} from "./production-role-adapter.mjs";
import { readControlConfig } from "./control-main.mjs";
import { actualInstallerIdentity } from "./installer-identity.mjs";
import { verifyInstalledControlPackage } from "./control-package.mjs";
import {
  createPrivateControlRpc,
  privateLoopbackOrigin,
} from "./control-rpc.mjs";
import {
  qualifyControlMigrationSource,
  prepareControlMigration,
  controlMigrationStatus,
} from "./control-migration.mjs";
import { readSupervisorFact } from "./supervisor-control.mjs";
import { evaluateCapacityAdmission } from "./capacity-admission.mjs";
import { createMigrationCapacity } from "./control-migration-capacity.mjs";
import { createMigrationCapacityHandoff, readMigrationDefaultOwner, verifyMigrationDefaultOwnerSource } from "./control-migration-handoff.mjs";
import { createContractRetirement } from "./contract-retirement.mjs";
import { captureProcessIdentity } from "./supervisor-sampler.mjs";
import { assertMigrationRunnerIdentity } from "./migration-identity-preflight.mjs";
import { createClosedBusinessReadView, probeClosedBusinessReadView } from "./closed-business-read-view.mjs";
import { validateCoordinatorExitReceipt } from "./coordinator-exit-receipt.mjs";
import { assertMigrationPreStopInventory } from "./migration-pre-stop-inventory.mjs";
import { assertControlMigrationCommand } from "./control-migration-policy.mjs";
const CID = /^[a-f0-9]{64}$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const brief = (p) => ({
  containerId: p.containerId,
  startIdentity: p.startIdentity,
  artifactDigest: p.artifactDigest,
  startedAt: p.startedAt,
  hostPid: p.hostPid,
  running: p.running,
  paused: p.paused,
  restartPolicy: p.restartPolicy,
  restartCount: p.restartCount,
  oomKilled: p.oomKilled,
  exitCode: p.exitCode,
  imageDigest: p.imageDigest,
  role: p.role,
  ...(p.failedStartInert === true ? { failedStartInert: true, normalExit: false,
    terminationDispatched: false, failedStartProof: p.failedStartProof } : {}),
});
const sameBirth = (a, b) =>
  [
    "containerId",
    "startIdentity",
    "artifactDigest",
    "startedAt",
    "imageDigest",
    "role",
  ].every((k) => a[k] === b[k]);

/** Publish the complete binding consumed by the API's coordinator resolver. */
export function migrationCoordinatorBinding({ instanceId, origin, artifactDigest, generation }) {
  return { instanceId, state: "ready", origin, artifactDigest, generation };
}

/** Capacity journals contain physical projections, not Foundation code proofs.
 * Add only the exact original Foundation's immutable proof; retain the observed birth. */
export function migrationCapacityInspectionTarget(record, sourceFoundation) {
  if (record?.role !== "foundation" || record.containerId !== sourceFoundation?.containerId) return record;
  return { ...record, ...Object.fromEntries(["codeFiles", "commandDigest", "mountDigest"].map(k => [k, sourceFoundation[k]])) };
}

export async function waitForMigrationLeaseRelease({ readLease, expected, instanceId, deadline, clock = Date.now, pause = sleep }) {
  while (true) {
    invariant(clock() <= deadline, "CONTROL_MIGRATION_WRITER_LEASE_NOT_RELEASED");
    const actual = await readLease();
    invariant(clock() <= deadline, "CONTROL_MIGRATION_WRITER_LEASE_NOT_RELEASED");
    invariant(actual?.instance_id === instanceId && (!expected || ["holder_id", "generation", "fence"].every(k => actual[k] === expected[k])) && Number.isFinite(actual.expires_at), "CONTROL_MIGRATION_WRITER_CHANGED");
    if (actual.expires_at <= clock()) return actual;
    invariant(clock() < deadline, "CONTROL_MIGRATION_WRITER_LEASE_NOT_RELEASED");
    await pause(Math.min(100, actual.expires_at - clock(), deadline - clock()));
  }
}

export function classifyMigrationCoordinatorExit(receipt, { instanceId, migrationId, expected, now = Date.now() }) {
  invariant(validateCoordinatorExitReceipt(receipt, { instanceId, target: receipt?.target, now }) &&
    /^[a-zA-Z0-9._:-]{1,200}$/.test(receipt.migrationId ?? "") &&
    ["stop-writer", "rollback-stop-coordinator"].some(id => receipt.originalCommandId === receipt.migrationId + ":" + id) &&
    ["containerId", "startIdentity", "artifactDigest", "restartCount"].every(k => receipt.target[k] === expected[k]), "CONTROL_MIGRATION_EXIT_RECEIPT_CONFLICT");
  if (receipt.migrationId === migrationId) {
    invariant(receipt.target.DockerStartedAt === expected.startedAt, "CONTROL_MIGRATION_EXIT_RECEIPT_CONFLICT");
    return "current";
  }
  invariant(receipt.target.DockerStartedAt !== expected.startedAt &&
    Date.parse(receipt.target.DockerStartedAt) < Date.parse(expected.startedAt) &&
    Date.parse(receipt.exitedAt) <= Date.parse(expected.startedAt), "CONTROL_MIGRATION_EXIT_RECEIPT_CONFLICT");
  return "historical";
}

/** Read-only signed package selection is exercised separately from physical
 * migration. Schema 2 stores packages[], not manifest.package. */
export async function readVerifiedMigrationBusiness(business, { clock = Date.now } = {}) {
  const envelope=(await readSupervisorFact(business.envelopePath,1048576)).value;
  const current=(await readSupervisorFact(business.currentSourcePath,1048576)).value;
  const signed=verifyManifest(envelope,await loadTrustRoot(business.trustRootPath),current,clock());
  return {envelope,signed,current};
}
function assertStopped(actual, expected) {
  invariant(
    sameBirth(actual, expected) &&
      actual.running === false &&
      actual.hostPid === 0 &&
      actual.paused === false &&
      actual.restartPolicy === "no" &&
      actual.restartCount === expected.restartCount &&
      actual.oomKilled === false &&
      [0, 143].includes(actual.exitCode),
    "CONTROL_MIGRATION_NORMAL_EXIT_UNPROVEN",
  );
}
function stoppedOutcome(actual, expected, allowFailedCandidateExit = false) {
  // A failed public API candidate is not a normal writer/source exit. Keep
  // its real exit code and provenance; never signal or relaunch a dead birth.
  if (allowFailedCandidateExit && expected.role === "api" && actual.exitCode === 1) {
    invariant(sameBirth(actual, expected) && actual.running === false && actual.hostPid === 0 &&
      actual.paused === false && actual.restartPolicy === "no" &&
      actual.restartCount === expected.restartCount && actual.oomKilled === false,
      "CONTROL_MIGRATION_FAILED_CANDIDATE_EXIT_UNPROVEN");
    return { ...brief(actual), exitDisposition: "failed-candidate" };
  }
  assertStopped(actual, expected);
  return brief(actual);
}
function assertRunning(actual, expected) {
  invariant(
    sameBirth(actual, expected) &&
      actual.running === true &&
      actual.hostPid === expected.hostPid &&
      actual.hostPid > 0 &&
      actual.paused === false &&
      actual.restartPolicy === "no" &&
      actual.restartCount === expected.restartCount,
    "CONTROL_MIGRATION_PHYSICAL_CHANGED",
  );
}

/** No arbitrary shell, pruning, removal or forced container termination exists here. */
export async function createMigrationDockerAdapter(
  c,
  { run = execute, adapterFactory = createProductionRoleAdapter, clock = Date.now, pause = sleep } = {},
) {
  const roles = await adapterFactory(c.adapter),
    docker = (args) =>
      run(c.adapter.docker.cli || "docker", [
        ...c.adapter.docker.args,
        ...args,
      ]);
  async function inspect(record) {
    invariant(
      CID.test(record.containerId),
      "CONTROL_MIGRATION_CONTAINER_ID_REQUIRED",
    );
    if (record.role !== "foundation") return roles.inspect(record.containerId);
    const row = JSON.parse(await docker(["inspect", record.containerId]))[0];
    invariant(
      row.Id === record.containerId &&
        row.Image === record.imageDigest &&
        (!row.Config.Labels?.["agent-platform.role"] ||
          row.Config.Labels["agent-platform.role"] === "foundation") &&
        row.HostConfig.PidMode !== "host" &&
        row.HostConfig.Privileged !== true &&
        !row.HostConfig.Devices?.some((d) => d.PathOnHost === "/dev/kvm") &&
        !(row.Mounts ?? []).some((m) =>
          c.protectedRuntimeRoots.some(
            (p) => m.Source === p || m.Source.startsWith(p + "/"),
          ),
        ),
      "CONTROL_MIGRATION_FOUNDATION_SCOPE_CHANGED",
    );
    invariant(
      Array.isArray(record.codeFiles) &&
        record.codeFiles.length > 0 &&
        record.codeFiles.length <= 128 &&
        record.codeFiles.reduce((n, f) => n + f.bytes, 0) <= 16 * 1024 * 1024,
      "CONTROL_MIGRATION_FOUNDATION_CODE_PROOF_REQUIRED",
    );
    for (const file of record.codeFiles) {
      const actual = await fileDigest(file.path);
      invariant(
        actual.digest === file.digest && actual.bytes === file.bytes,
        "CONTROL_MIGRATION_FOUNDATION_CODE_CHANGED",
      );
    }
    const commandDigest = digest({
        entrypoint: row.Config.Entrypoint,
        command: row.Config.Cmd,
        workingDirectory: row.Config.WorkingDir,
      }),
      mountDigest = digest(
        row.Mounts.map((m) => ({
          source: m.Source,
          destination: m.Destination,
          rw: m.RW,
        })).sort((a, b) => a.destination.localeCompare(b.destination)),
      );
    invariant(
      commandDigest === record.commandDigest &&
        mountDigest === record.mountDigest,
      "CONTROL_MIGRATION_FOUNDATION_PROCESS_CHANGED",
    );
    const startIdentity =
        row.Config.Labels?.["agent-platform.start"] ??
        digest({ containerId: row.Id, commandDigest }),
      artifactDigest =
        row.Config.Labels?.["agent-platform.artifact"] ??
        digest(record.codeFiles);
    invariant(
      startIdentity === record.startIdentity &&
        artifactDigest === record.artifactDigest,
      "CONTROL_MIGRATION_FOUNDATION_IDENTITY_CHANGED",
    );
    return {
      containerId: row.Id,
      startIdentity,
      artifactDigest,
      startedAt: row.State.StartedAt,
      hostPid: row.State.Pid,
      running: row.State.Running,
      paused: row.State.Paused,
      restartPolicy: row.HostConfig.RestartPolicy?.Name || "no",
      restartCount: row.RestartCount,
      oomKilled: row.State.OOMKilled,
      exitCode: row.State.ExitCode,
      imageDigest: row.Image,
      role: "foundation",
    };
  }
  async function terminate(record, { deadline = clock() + (c.actionBudgetMs ?? 120000) } = {}) {
    invariant(
      [
        "foundation",
        "installer",
        "coordinator",
        "api",
        "control-agent",
        "control-entry",
        "control-supervisor",
      ].includes(record.role),
      "CONTROL_MIGRATION_PROTECTED_STOP_FORBIDDEN",
    );
    const before = await inspect(record);
    assertRunning(before, record);
    invariant(Number.isFinite(deadline) && clock() < deadline,
      "CONTROL_MIGRATION_ACTION_BUDGET_EXCEEDED");
    await docker(["kill", "--signal", "SIGTERM", record.containerId]);
    while (clock() <= deadline) {
      const actual = await inspect(record);
      if (!actual.running) {
        assertStopped(actual, record);
        if (clock() <= deadline) return brief(actual);
      } else assertRunning(actual, record);
      if (clock() >= deadline) break;
      await pause(Math.min(100, deadline - clock()));
    }
    throw Object.assign(Error("Normal exit outcome is unknown"), {
      code: "CONTROL_MIGRATION_EXIT_UNKNOWN",
    });
  }
  async function restart(record) {
    invariant(
      ["foundation", "installer", "coordinator"].includes(record.role),
      "CONTROL_MIGRATION_RESTART_FORBIDDEN",
    );
    assertStopped(await inspect(record), record);
    await docker(["start", record.containerId]);
    const actual = await inspect(record);
    invariant(
      actual.running === true &&
        actual.hostPid > 0 &&
        actual.paused === false &&
        actual.startIdentity === record.startIdentity &&
        actual.artifactDigest === record.artifactDigest &&
        actual.startedAt !== record.startedAt,
      "CONTROL_MIGRATION_RESTART_UNKNOWN",
    );
    return brief(actual);
  }
  return {
    inspect,
    terminate,
    restart,
    launch: (spec) =>
      spec.kind === "control-agent"
        ? roles.launchControlAgent(spec)
        : ["control-entry", "control-supervisor"].includes(spec.kind)
          ? roles.launchIndependentFoundation(spec)
          : roles.launch(spec),
    lookupLaunch: (record) => roles.lookupStart(record),
    observeFailedSupervisorStart: (record, expected) => roles.observeFailedSupervisorStart(record, expected),
    preflightIndependentFoundation: (spec) => roles.preflightIndependentFoundation(spec),
  };
}

/** Only the original source writer may declare a longer normal-stop grace. */
export function migrationActionBudgetMs(runtime, stepId) {
  const grace = runtime.sourceCoordinatorStopBudgetMs;
  invariant(Number.isSafeInteger(runtime.actionBudgetMs) && runtime.actionBudgetMs > 0 &&
    runtime.actionBudgetMs <= 120000 && (grace === undefined ||
      (Number.isSafeInteger(grace) && grace >= runtime.actionBudgetMs && grace <= 300000)),
  "CONTROL_MIGRATION_ACTION_BUDGET_INVALID");
  return stepId === "stop-writer" ? (grace ?? runtime.actionBudgetMs) : runtime.actionBudgetMs;
}

/** One durable migration run, separate from both business and live control stores. */
export async function createControlMigrationRuntime(
  input,
  { Database, adapter: provided, capacitySample, handoffRepairContext, handoffSupervisorReadiness,
    preStopInventory, allowDisruptiveFixture = false, clock = Date.now } = {},
) {
  const c = input.runtime;
  invariant(allowDisruptiveFixture === false || allowDisruptiveFixture === true && provided,
    'CONTROL_MIGRATION_FIXTURE_ADAPTER_REQUIRED');
  invariant(provided || !handoffRepairContext && !handoffSupervisorReadiness && !preStopInventory,
    'CONTROL_MIGRATION_TEST_PORT_FORBIDDEN');
  invariant(!provided || typeof preStopInventory === "function",
    "CONTROL_MIGRATION_PUBLIC_INVENTORY_PORT_REQUIRED");
  invariant(
    c?.targets &&
      c?.source &&
      c?.keys &&
      c?.capacity &&
      c?.bindings &&
      typeof c.journalRoot === "string",
    "CONTROL_MIGRATION_RUNTIME_CONFIG_REQUIRED",
  );
  if (!provided)
    invariant(
      process.platform === "linux" &&
        process.arch === "arm64" &&
        Number(process.versions.node.split(".")[0]) === 22,
      "CONTROL_MIGRATION_LINUX_ARM64_NODE22_REQUIRED",
    );
  invariant(
    c &&
      c.schemaVersion === 1 &&
      c.migrationId === input.migrationId &&
      c.instanceId === input.instanceId &&
      Number.isFinite(c.deadline) &&
      Number.isFinite(c.rollbackDeadline) &&
      c.rollbackDeadline > c.deadline &&
      Number.isSafeInteger(c.actionBudgetMs) &&
      c.actionBudgetMs > 0 &&
      c.actionBudgetMs <= 120000 &&
      Array.isArray(c.protectedRuntimeRoots) &&
      Array.isArray(c.protectedOwners) &&
      Array.isArray(c.protectedProcesses) &&
      c.protectedOwners.length > 0 &&
      c.protectedProcesses.length > 0,
    "CONTROL_MIGRATION_RUNTIME_CONFIG_REQUIRED",
  );
  migrationActionBudgetMs(c, "stop-writer");
  for (const role of ["foundation", "installer", "coordinator"])
    invariant(
      CID.test(c.source?.[role]?.containerId) && c.source[role].role === role,
      "CONTROL_MIGRATION_SOURCE_RECORD_REQUIRED",
    );
  if (!provided) await assertMigrationRunnerIdentity(input);
  const root = await secureDirectory(c.journalRoot),
    db = new Database(join(root, "migration.db"));
  await fs.chmod(join(root, "migration.db"), 0o600);
  db.pragma("busy_timeout=50");
  db.exec(
    "CREATE TABLE IF NOT EXISTS control_migration_run(singleton INTEGER PRIMARY KEY CHECK(singleton=1),migration_id TEXT NOT NULL,instance_id TEXT NOT NULL,config_digest TEXT NOT NULL,state TEXT NOT NULL,data TEXT NOT NULL)",
  );
  const configDigest = digest(JSON.parse(JSON.stringify(input)));
  const prior = db
    .prepare("SELECT * FROM control_migration_run WHERE singleton=1")
    .get();
  invariant(
    !prior ||
      (prior.migration_id === input.migrationId &&
        prior.instance_id === input.instanceId &&
        prior.config_digest === configDigest),
    "CONTROL_MIGRATION_FROZEN_CONFIG_CHANGED",
  );
  if (!prior)
    db.prepare(
      "INSERT INTO control_migration_run VALUES(1,?,?,?,'planned','{}')",
    ).run(input.migrationId, input.instanceId, configDigest);
  const adapter = provided ?? (await createMigrationDockerAdapter(c)),
    live = new Map();
  db.exec(
    "CREATE TABLE IF NOT EXISTS control_migration_actor(singleton INTEGER PRIMARY KEY CHECK(singleton=1),pid INTEGER NOT NULL,birth TEXT NOT NULL,token TEXT NOT NULL)",
  );
  async function ownActor() {
    try {
      const pid = Number(
          (await fs.realpath(join(c.runnerProcRoot || "/proc", "self")))
            .split("/")
            .at(-1),
        ),
        stat = await fs.readFile(
          join(c.runnerProcRoot || "/proc", String(pid), "stat"),
          "utf8",
        );
      return {
        pid,
        birth: stat
          .slice(stat.lastIndexOf(")") + 2)
          .trim()
          .split(/\s+/)[19],
      };
    } catch {
      invariant(
        process.platform !== "linux",
        "CONTROL_MIGRATION_RUNNER_IDENTITY_UNKNOWN",
      );
      return { pid: process.pid, birth: "conservative-live-pid" };
    }
  }
  async function actorAlive(row) {
    try {
      if (row.birth === "conservative-live-pid") {
        process.kill(row.pid, 0);
        return true;
      }
      const stat = await fs.readFile(
        join(c.runnerProcRoot || "/proc", String(row.pid), "stat"),
        "utf8",
      );
      return (
        stat
          .slice(stat.lastIndexOf(")") + 2)
          .trim()
          .split(/\s+/)[19] === row.birth
      );
    } catch (e) {
      if (e.code === "ENOENT" || e.code === "ESRCH") return false;
      throw Object.assign(Error("Unknown previous actor"), {
        code: "CONTROL_MIGRATION_ACTOR_UNKNOWN",
      });
    }
  }
  async function exclusive(work) {
    const owner = await ownActor(),
      token = randomUUID(),
      old = db
        .prepare("SELECT * FROM control_migration_actor WHERE singleton=1")
        .get();
    if (old)
      invariant(
        !(await actorAlive(old)),
        "CONTROL_MIGRATION_ACTOR_STILL_RUNNING",
      );
    db.transaction(() => {
      const current = db
        .prepare("SELECT * FROM control_migration_actor WHERE singleton=1")
        .get();
      invariant(
        (current?.token ?? null) === (old?.token ?? null),
        "CONTROL_MIGRATION_ACTOR_CAS_CHANGED",
      );
      db.prepare(
        "INSERT OR REPLACE INTO control_migration_actor VALUES(1,?,?,?)",
      ).run(owner.pid, owner.birth, token);
    }).immediate();
    const release = () =>
      db
        .prepare(
          "DELETE FROM control_migration_actor WHERE singleton=1 AND token=?",
        )
        .run(token);
    try {
      return await work();
    } finally {
      if (live.size === 0) release();
      else
        Promise.allSettled([...live.values()])
          .then(release)
          .catch(() => {});
    }
  }
  const journal = createControlCommandJournal({
    sqlite: db,
    instanceId: input.instanceId,
    clock,
    assertAuthority: (a, command) => {
      invariant(
        a.executorId === "migration:" + input.migrationId &&
          a.epoch === input.epochFloor + 1,
        "CONTROL_MIGRATION_LOCAL_AUTHORITY_INVALID",
      );
      if (["prepare", "begin"].includes(command.journalAction))
        invariant(
          clock() < (command.spec ?? journal.lookup(command)?.spec)?.deadline,
          "CONTROL_COMMAND_DEADLINE_EXPIRED",
        );
    },
  });
  invariant(
    provided || c.capacity.configPath,
    "CONTROL_MIGRATION_CAPACITY_CONFIG_REQUIRED",
  );
  const actions = [
    ...Object.entries(c.source).flatMap(([role, target]) => [
      {
        commandId:
          input.migrationId +
          ":" +
          (role === "coordinator" ? "stop-writer" : "stop-" + role),
        direction: "stop",
        role,
        target,
        targetDigest: digest(target),
        allocationId: target.capacityAllocationId,
        deadline: c.deadline,
      },
      {
        commandId: input.migrationId + ":rollback-" + role,
        direction: "start",
        restore: true,
        role,
        targetDigest: digest(target),
        allocationId: target.capacityAllocationId,
        deadline: c.rollbackDeadline,
      },
    ]),
    ...Object.entries(c.targets).flatMap(([role, target]) => [
      {
        commandId: input.migrationId + ":start-" + role,
        direction: "start",
        role,
        targetDigest: digest(target),
        allocationId: target.capacityAllocationId,
        deadline: c.deadline,
      },
      {
        commandId: input.migrationId + ":rollback-stop-" + role,
        direction: "stop",
        role,
        startCommandId: input.migrationId + ":start-" + role,
        allowFailedCandidateExit: role === "api",
        allocationId: target.capacityAllocationId,
        deadline: c.rollbackDeadline,
      },
    ]),
  ];
  const failedStart = { observe: async (expected) => {
    const id = input.migrationId + ":start-control-supervisor", row = journal.lookup({operationId:input.migrationId,commandId:id}),
      data = load(), target = c.targets["control-supervisor"], stopId = input.migrationId + ":rollback-stop-control-supervisor";
    invariant(data.qualification && !data.entryProcess && !data.activation && !data.preActivationControl &&
      row?.state === "applied" && !live.has(id) && row.specDigest === digest(row.spec) &&
      row.result?.migrationBudgetExceeded !== true &&
      row.spec.kind === "migration-start-control-supervisor" && row.spec.configDigest === configDigest &&
      row.spec.targetDigest === digest(target) && row.spec.deadline === c.deadline &&
      digest(row.result) === digest(expected) && (!data.supervisorProcess || digest(data.supervisorProcess) === digest(expected)) &&
      typeof adapter.observeFailedSupervisorStart === "function", "CONTROL_MIGRATION_FAILED_SUPERVISOR_UNPROVEN");
    for (const suffix of ["start-control-entry", "ready-control-supervisor", "ready-control-entry", "activate"])
      invariant(!journal.lookup({operationId:input.migrationId,commandId:input.migrationId+":"+suffix}), "CONTROL_MIGRATION_FAILED_SUPERVISOR_PHASE_CHANGED");
    invariant(!db.prepare("SELECT 1 FROM control_commands WHERE state IN ('planned','executing','unknown','blocked') AND NOT (operation_id=? AND command_id=?) LIMIT 1").get(input.migrationId,stopId),
      "CONTROL_MIGRATION_FAILED_START_FOREIGN_PENDING");
    const ledger = new Database(input.controlPath,{readonly:true,fileMustExist:true});
    let authority;
    try {
      ledger.pragma("query_only=ON");
      authority = ledger.prepare("SELECT * FROM control_authority WHERE instance_id=?").get(input.instanceId);
      invariant(authority?.mode === "passive" && authority.revision === 1 && authority.operation_id === null &&
        authority.kind === null && authority.holder_id === null && authority.lease_expires_at === 0 &&
        authority.source_binding_digest === null && !ledger.prepare("SELECT 1 FROM control_commands LIMIT 1").get(),
        "CONTROL_MIGRATION_FAILED_SUPERVISOR_AUTHORITY_CHANGED");
    } finally { ledger.close(); }
    const statePath = c.adapter?.stableControl?.statePath;
    invariant(typeof statePath === "string" && statePath !== input.controlPath, "CONTROL_MIGRATION_FAILED_SUPERVISOR_STATE_REQUIRED");
    const stat = await fs.lstat(statePath).catch(error => { if(error.code === "ENOENT") return null; throw error; });
    if (stat) {
      invariant(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0 && await fs.realpath(statePath) === statePath,
        "CONTROL_MIGRATION_FAILED_SUPERVISOR_STATE_REQUIRED");
      const state = new Database(statePath,{readonly:true,fileMustExist:true});
      try {
        state.pragma("query_only=ON");
        const tables = state.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
        const allowed = ["supervisor_control_admission","supervisor_side_effect","control_commands","supervisor_control_maintenance",
          "supervisor_control_maintenance_actions","supervisor_capacity_templates","supervisor_capacity_reservations"];
        invariant(tables.every(({name}) => allowed.includes(name) && !state.prepare('SELECT 1 FROM "'+name+'" LIMIT 1').get()),
          "CONTROL_MIGRATION_FAILED_SUPERVISOR_SIDE_EFFECT_PRESENT");
      } finally { state.close(); }
    }
    const record = {...target.record,kind:"control-supervisor",instanceId:input.instanceId,attemptId:input.migrationId,
      operationId:input.migrationId,commandId:id,specDigest:digest(target)}, observed = await adapter.observeFailedSupervisorStart(record,expected);
    invariant(observed.failedStartInert === true && observed.normalExit === false && observed.terminationDispatched === false,
      "CONTROL_MIGRATION_FAILED_SUPERVISOR_UNPROVEN");
    return {...observed,failedStartProof:{...observed.failedStartProof, passiveAuthorityDigest:digest(authority),
      originalPhaseDigest:digest({qualification:data.qualification.proofDigest,configDigest,startSpecDigest:row.specDigest})}};
  }};
  const capacityBookkeeper = c.capacity.configPath
    ? createMigrationCapacity({
        sqlite: db,
        journal,
        instanceId: input.instanceId,
        migrationId: input.migrationId,
        initialPlanDigest: c.capacity.planDigest,
        planPath: c.capacity.planPath,
        configPath: c.capacity.configPath,
        observationPath: c.capacity.observationPath,
        deadline: c.rollbackDeadline,
        actions,
        inspect: (r) => adapter.inspect(migrationCapacityInspectionTarget(r, c.source.foundation)),
        failedStart,
        ...(capacitySample ? { sample: capacitySample } : {}),
        clock,
      })
    : null;
  const stableCapacity=c.adapter?.stableControl;
  async function readNormalRepairContext(stage) {
    const {signed,current}=await readVerifiedMigrationBusiness(c.businessPackage,{clock}),
      entryConfig=(await readSupervisorFact(c.adapter.controlFoundationEntries.entry.configPath,1048576)).value,
      planned=entryConfig.context?.initialBinding?.web;
    invariant(entryConfig.c?.instanceId===input.instanceId && planned && current.components,
      'CONTROL_MIGRATION_NORMAL_REPAIR_CONTEXT_UNKNOWN');
    let web=planned;
    if(stage==='actual'){
      const rpc=createPrivateControlRpc({origin:c.entryControlOrigin,instanceId:input.instanceId,key:c.keys.entry}),binding=await rpc('/binding');
      invariant(binding.instanceId===input.instanceId && canonical(binding.web)===canonical(planned),
        'CONTROL_MIGRATION_NORMAL_WEB_CHANGED');web=binding.web;
    }
    const declared=[current.components.web,signed.manifest.components.web].find(part=>part?.artifactDigest===web.digest);
    invariant(declared && typeof web.root==='string' && typeof web.origin==='string',
      'CONTROL_MIGRATION_NORMAL_WEB_UNKNOWN');
    const actualWebFiles=(await treeManifest(web.root)).map(f=>({...f,path:'web/'+f.path}));
    invariant(digest(actualWebFiles)===declared.artifactDigest,'CONTROL_MIGRATION_NORMAL_WEB_TREE_CHANGED');
    const response=await fetch(privateLoopbackOrigin(web.origin)+'/web-build',{redirect:'error',signal:AbortSignal.timeout(2000)});
    invariant(response.ok,'CONTROL_MIGRATION_NORMAL_WEB_UNAVAILABLE');
    const build=await response.json();invariant(build.webRevision===declared.webRevision,
      'CONTROL_MIGRATION_NORMAL_WEB_IDENTITY_CHANGED');
    const {owner,bindingRawDigest,origin:ownerOrigin}=await readMigrationDefaultOwner({env:c.targets.coordinator.env,instanceId:input.instanceId});
    invariant(owner.instanceId===input.instanceId && typeof owner.ownerId==='string' && typeof owner.startIdentity==='string',
      'CONTROL_MIGRATION_NORMAL_OWNER_UNKNOWN');
    const identity=part=>({artifactDigest:part?.artifactDigest,inputFingerprint:part?.inputFingerprint});
    let ownerSource;
    if(![current.components.owner,signed.manifest.components.owner].some(p=>p &&
      p.artifactDigest===owner.artifactDigest && p.inputFingerprint===owner.inputFingerprint)){
      ownerSource=await verifyMigrationDefaultOwnerSource({reference:stableCapacity.capacityDefaultOwnerSource,
        trustRootPath:c.businessPackage.trustRootPath,installerRoot:dirname(c.adapter.controlDownloadRoot),
        instanceId:input.instanceId,owner,bindingRawDigest,origin:ownerOrigin,protectedOwners:c.protectedOwners,
        inspect:r=>adapter.inspect(r),clock});
      const after=await readMigrationDefaultOwner({env:c.targets.coordinator.env,instanceId:input.instanceId});
      invariant(after.bindingRawDigest===bindingRawDigest && after.origin===ownerOrigin &&
        after.owner.ownerId===owner.ownerId && after.owner.startIdentity===owner.startIdentity &&
        after.owner.artifactDigest===owner.artifactDigest && after.owner.inputFingerprint===owner.inputFingerprint,
      'CONTROL_MIGRATION_NORMAL_OWNER_CHANGED');
    }
    const installedComponents=Object.fromEntries(['api','coordinator','installer'].map(role=>[role,identity(signed.manifest.components[role])]));
    for(const [role,kind]of [['api','api'],['coordinator','coordinator'],['installer','control-agent']])
      invariant(c.targets[kind].record.inputFingerprint===installedComponents[role].inputFingerprint,
        'CONTROL_MIGRATION_NORMAL_TARGET_INPUT_CHANGED');
    if(stage==='actual'){
      for(const [role,kind,path,key]of [['api','api','/internal/control/identity',c.keys.control],
        ['coordinator','coordinator','/internal/application/identity',c.keys.control],
        ['installer','control-agent','/metadata',c.keys.upgradeControl]]){
        const target=c.targets[kind],rpc=createPrivateControlRpc({origin:target.origin,instanceId:input.instanceId,key}),actual=await rpc(path);
        invariant(actual.instanceId===input.instanceId && actual.startIdentity===target.record.startIdentity &&
          actual.artifactDigest===installedComponents[role].artifactDigest && actual.inputFingerprint===installedComponents[role].inputFingerprint,
        'CONTROL_MIGRATION_NORMAL_LIVE_COMPONENT_CHANGED');
        installedComponents[role]=identity(actual);
      }
    }
    return {instanceId:input.instanceId,manifestDigest:signed.manifestDigest,
      sourceComponents:Object.fromEntries(Object.entries(current.components).map(([k,v])=>[k,identity(v)])),
      targetComponents:Object.fromEntries(Object.entries(signed.manifest.components).map(([k,v])=>[k,identity(v)])),
      installedComponents,web:identity(declared),owner:identity(owner),...(ownerSource?{ownerSource}:{}),
      webBinding:{root:web.root,origin:web.origin,digest:web.digest,treeDigest:web.treeDigest,webRevision:build.webRevision},
      defaultOwner:{ownerId:owner.ownerId,startIdentity:owner.startIdentity,bindingRawDigest}};
  }
  let normalHandoff=null;
  function getNormalHandoff(){
    if(normalHandoff)return normalHandoff;
    if(!stableCapacity?.capacityTemplates || !capacityBookkeeper){
      invariant(provided,'CONTROL_MIGRATION_NORMAL_CAPACITY_CONFIG_REQUIRED');return null;
    }
    return normalHandoff=createMigrationCapacityHandoff({
    sqlite:db,Database,journal,instanceId:input.instanceId,migrationId:input.migrationId,configDigest,
    deadline:c.deadline,rollbackDeadline:c.rollbackDeadline,native:c.capacity,
    normal:{root:c.adapter.capacityStateRoot,planPath:stableCapacity.capacityPlanPath,
      configPath:stableCapacity.capacityCollectorConfigPath,observationPath:stableCapacity.resourceObservationPath,
      transitionRoot:stableCapacity.capacityTransitionRoot,templates:stableCapacity.capacityTemplates},
    source:c.source,targets:c.targets,protectedRoots:c.protectedRuntimeRoots,
    capacityStatus:()=>capacityBookkeeper.status(),readRepairContext:provided && handoffRepairContext || readNormalRepairContext,
    inspect:r=>adapter.inspect(migrationCapacityInspectionTarget(r,c.source.foundation)),
    ...(capacitySample?{sample:capacitySample}:{}),clock,
    });
  }
  async function registerCapacity(id) {
    if (capacityBookkeeper)
      return capacityBookkeeper.register({
        operationId: input.migrationId,
        commandId: input.migrationId + ":" + id,
      });
  }
  async function reconcileCapacity() {
    if (!capacityBookkeeper) return;
    const persisted = capacityBookkeeper.status();
    if (!persisted) {
      invariant(
        !actions.some((a) =>
          journal.lookup({
            operationId: input.migrationId,
            commandId: a.commandId,
          }),
        ),
        "CONTROL_MIGRATION_CAPACITY_INITIAL_SNAPSHOT_MISSING",
      );
      await capacityBookkeeper.initialize();
    }
    for (const action of actions) {
      const key = {
        operationId: input.migrationId,
        commandId: action.commandId,
      };
      let row = journal.lookup(key);
      if (!row || ["planned", "definitely-not-applied"].includes(row.state))
        continue;
      if (["executing", "unknown", "blocked"].includes(row.state)) {
        invariant(
          !live.has(action.commandId),
          "CONTROL_MIGRATION_COMMAND_UNKNOWN",
        );
        let result;
        if (action.direction === "stop") {
          const target =
            action.target ??
            journal.lookup({
              operationId: input.migrationId,
              commandId: action.startCommandId,
            })?.result;
          invariant(target, "CONTROL_MIGRATION_COMMAND_UNKNOWN");
          const actual = await adapter.inspect(target);
          result = stoppedOutcome(actual, target, action.allowFailedCandidateExit === true &&
            action.commandId === input.migrationId + ":rollback-stop-api");
        } else {
          const kind = action.role,
            spec = c.targets[kind];
          invariant(
            !action.restore && spec,
            "CONTROL_MIGRATION_COMMAND_UNKNOWN",
          );
          const record = {
              ...spec.record,
              kind,
              instanceId: input.instanceId,
              attemptId: input.migrationId,
              operationId: input.migrationId,
              commandId: action.commandId,
              specDigest: digest(spec),
            },
            found = await adapter.lookupLaunch(record);
          if (found?.state === "definitely-not-applied") {
            invariant(
              found.result?.dispatched === false,
              "CONTROL_MIGRATION_COMMAND_UNKNOWN",
            );
            invariant(clock() < c.rollbackDeadline, "CONTROL_MIGRATION_DEADLINE_EXPIRED");
            // Admission can fail before the adapter dispatches a start. Close
            // that original command without inventing a resident/receipt, and
            // retain the error that made its outcome unknown.
            journal.record({
              ...key,
              authorization: authorization(),
              state: "definitely-not-applied",
              result: {
                ...found.result,
                originalState: row.state,
                originalUnknownResult: row.result,
              },
            });
            continue;
          }
          invariant(
            found?.state === "applied",
            "CONTROL_MIGRATION_COMMAND_UNKNOWN",
          );
          result = { ...record, ...brief(found.result) };
        }
        journal.record({
          ...key,
          authorization: authorization(),
          state: "applied",
          result: {
            ...result,
            migrationBudgetExceeded:
              clock() >
              Math.min(row.spec.deadline, row.createdAt + row.spec.budget.maxDurationMs),
          },
        });
        row = journal.lookup(key);
      }
      if (row.state === "applied") await capacityBookkeeper.register(key);
    }
  }

  const load = () =>
    JSON.parse(
      db
        .prepare("SELECT data FROM control_migration_run WHERE singleton=1")
        .get().data,
    );
  const save = (patch, state) =>
    db
      .prepare(
        "UPDATE control_migration_run SET data=?,state=coalesce(?,state) WHERE singleton=1",
      )
      .run(canonical({ ...load(), ...patch }), state ?? null);
  const authorization = () => ({
    epoch: input.epochFloor + 1,
    executorId: "migration:" + input.migrationId,
    expiresAt: clock() + 5000,
  });
  async function step(id, target, work, lookup, { rollback = false } = {}) {
    const key = {
        operationId: input.migrationId,
        commandId: input.migrationId + ":" + id,
      },
      deadline = rollback ? c.rollbackDeadline : c.deadline;
    const spec = {
      kind: "migration-" + id,
      targetDigest: digest(target),
      deadline,
      budget: { maxDurationMs: migrationActionBudgetMs(c, id) },
      configDigest,
    };
    let row = journal.lookup(key);
    if (row)
      invariant(
        row.specDigest === digest(spec),
        "CONTROL_COMMAND_SPEC_CONFLICT",
      );
    if (row?.state === "applied") {
      invariant(
        row.result?.migrationBudgetExceeded !== true,
        "CONTROL_MIGRATION_ACTION_BUDGET_EXCEEDED",
      );
      return row.result;
    }
    if (live.has(key.commandId))
      throw Object.assign(Error("Original migration command still executing"), {
        code: "CONTROL_MIGRATION_COMMAND_UNKNOWN",
      });
    if (row && ["executing", "unknown", "blocked"].includes(row.state)) {
      const result = await lookup?.(row);
      if (result?.state === "definitely-not-applied") {
        journal.record({
          ...key,
          authorization: authorization(),
          state: "definitely-not-applied",
          result: result.result,
        });
        row = journal.lookup(key);
      } else {
        invariant(
          result?.state === "applied",
          "CONTROL_MIGRATION_COMMAND_UNKNOWN",
        );
        const completed = {
          ...result.result,
          migrationBudgetExceeded:
            clock() >
            Math.min(row.spec.deadline, row.createdAt + row.spec.budget.maxDurationMs),
        };
        journal.record({
          ...key,
          authorization: authorization(),
          state: "applied",
          result: completed,
        });
        invariant(
          !completed.migrationBudgetExceeded,
          "CONTROL_MIGRATION_ACTION_BUDGET_EXCEEDED",
        );
        return completed;
      }
    }
    invariant(clock() < deadline, "CONTROL_MIGRATION_DEADLINE_EXPIRED");
    row = journal.prepare({
      ...key,
      stepId: id,
      spec,
      authorization: authorization(),
    });
    invariant(
      clock() < Math.min(row.spec.deadline, row.createdAt + row.spec.budget.maxDurationMs),
      "CONTROL_MIGRATION_ACTION_BUDGET_EXCEEDED",
    );
    journal.begin({ ...key, authorization: authorization() });
    const task = Promise.resolve().then(work);
    live.set(key.commandId, task);
    task
      .finally(() => {
        if (live.get(key.commandId) === task) live.delete(key.commandId);
      })
      .catch(() => {});
    let timer;
    try {
      const result = await Promise.race([
        task,
        new Promise((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                Object.assign(
                  Error("Original migration action not yet known"),
                  { code: "CONTROL_MIGRATION_COMMAND_UNKNOWN" },
                ),
              ),
            Math.max(
              1,
              Math.min(row.createdAt + row.spec.budget.maxDurationMs, deadline) - clock(),
            ),
          );
        }),
      ]);
      const completed = {
        ...result,
        migrationBudgetExceeded:
          clock() >
          Math.min(row.spec.deadline, row.createdAt + row.spec.budget.maxDurationMs),
      };
      journal.record({
        ...key,
        authorization: authorization(),
        state: "applied",
        result: completed,
      });
      invariant(
        !completed.migrationBudgetExceeded,
        "CONTROL_MIGRATION_ACTION_BUDGET_EXCEEDED",
      );
      return completed;
    } catch (error) {
      if (journal.lookup(key)?.state !== "applied")
        journal.record({
          ...key,
          authorization: authorization(),
          state: "unknown",
          result: { code: error.code ?? "CONTROL_MIGRATION_ACTION_UNKNOWN" },
        });
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  async function protection() {
    const owners = [];
    for (const expected of c.protectedOwners) {
      invariant(
        expected.role === "owner",
        "CONTROL_MIGRATION_OWNER_PROOF_INVALID",
      );
      const actual = await adapter.inspect(expected);
      assertRunning(actual, expected);
      owners.push(brief(actual));
    }
    const processes = [];
    for (const expected of c.protectedProcesses) {
      const actual = await captureProcessIdentity({
        ...expected,
        procRoot: c.procRoot || "/proc",
      });
      invariant(
        actual.birthTicks === expected.birthTicks &&
          actual.cgroupDigest === expected.cgroupDigest,
        "CONTROL_MIGRATION_PROTECTED_PROCESS_CHANGED",
      );
      processes.push({
        hostPid: expected.hostPid,
        containerId: expected.containerId,
        ...actual,
      });
    }
    return { owners, processes, digest: digest({ owners, processes }) };
  }
  async function validateProductionInputs() {
    for (const origin of [
      c.source.coordinator.origin,
      c.supervisorOrigin,
      c.entryOrigin,
      c.entryControlOrigin,
      c.targets.api.origin,
      c.targets.coordinator.origin,
      c.targets["control-agent"].origin,
    ])
      privateLoopbackOrigin(origin);
    invariant(
      ["controller", "upgradeControl", "control", "supervisor", "entry"].every(
        (k) => typeof c.keys[k] === "string" && c.keys[k].length >= 32,
      ) && DIGEST.test(c.entryBindingDigest),
      "CONTROL_MIGRATION_ENDPOINT_CONFIG_REQUIRED",
    );
    invariant(
      c.keys.upgradeControl !== c.keys.controller &&
        c.keys.upgradeControl !== c.keys.control &&
        [c.keys.upgradeControl, c.keys.entry, c.keys.supervisor].every(
          (secret) =>
            secret !== c.keys.controller &&
            secret !== c.keys.control &&
            ["api", "coordinator"].every(
              (kind) => !Object.values(c.targets[kind].env).includes(secret),
            ),
        ),
      "CONTROL_MIGRATION_ROLE_KEYS_NOT_SEPARATE",
    );
    invariant(
      c.source.foundation.containerId !== c.source.coordinator.containerId &&
        c.source.foundation.containerId !== c.source.installer.containerId,
      "CONTROL_MIGRATION_SOURCE_SCOPE_OVERLAP",
    );
    for (const kind of [
      "control-agent",
      "coordinator",
      "api",
      "control-supervisor",
      "control-entry",
    ])
      invariant(
        c.targets[kind]?.kind === kind &&
          typeof c.targets[kind].record?.startIdentity === "string" &&
          DIGEST.test(c.targets[kind].record.artifactDigest),
        "CONTROL_MIGRATION_TARGET_SPEC_REQUIRED",
      );
    if (provided) return;
    invariant(c.adapter.trustedRuntimeDockerCli?.schemaVersion === 1,
      "CONTROL_RUNTIME_DOCKER_DEPENDENCY_UNPROVEN");
    const actor = await ownActor(),
      actorGroup = await fs.readFile(
        join(c.runnerProcRoot || "/proc", String(actor.pid), "cgroup"),
        "utf8",
      );
    invariant(
      ![...Object.values(c.source), ...c.protectedOwners].some((r) =>
        actorGroup.includes(r.containerId),
      ),
      "CONTROL_MIGRATION_RUNNER_SCOPE_FORBIDDEN",
    );
    const agent = c.targets["control-agent"],
      config = await readControlConfig(agent.args?.[1]);
    invariant(
      c.adapter.stableControl?.migratedArtifactPath === c.migrationSourcePath &&
        c.adapter.stableControl.key === c.keys.upgradeControl,
      "CONTROL_MIGRATION_PROVENANCE_PATH_REQUIRED",
    );
    invariant(
      agent.entry ===
        join(c.controlPackage.artifactRoot, "installer/control-main.mjs") &&
        agent.args.length === 2 &&
        agent.args[0] === agent.entry &&
        config.instanceId === input.instanceId &&
        config.startIdentity === agent.record.startIdentity &&
        config.controllerKey === c.keys.upgradeControl &&
        config.businessKey === c.keys.controller &&
        config.entryKey === c.keys.entry &&
        config.supervisorKey === c.keys.supervisor &&
        join(config.controlLedgerRoot, "control.db") === input.controlPath &&
        join(config.controlRoot, "auth/access.db") === input.accessPath,
      "CONTROL_MIGRATION_AGENT_CONFIG_CHANGED",
    );
    const agentResources = c.adapter.controlAgentResources;
    invariant(
      agentResources?.memoryBytes === agent.resources.memoryBytes &&
        agentResources?.cpuMilliCores === agent.resources.cpuMilliCores,
      "CONTROL_MIGRATION_AGENT_RESOURCE_MISMATCH",
    );
    invariant(
      c.legacyProcessRoot === join(c.adapter.root, "installer/processes") &&
        c.installedRolesRoot ===
          join(c.adapter.root, "supervisor-publication/installed-roles") &&
        c.retiredCoordinatorRoot ===
          join(c.adapter.root, "supervisor-publication/retired-coordinators"),
      "CONTROL_MIGRATION_REGISTRY_SCOPE_CHANGED",
    );
    for (const kind of ["control-entry", "control-supervisor"]) {
      const target = c.targets[kind],
        mode = kind === "control-entry" ? "entry" : "supervisor",
        entry = c.adapter.controlFoundationEntries?.[mode];
      const foundationStat = await fs.lstat(entry?.configPath),
        foundationConfig = (await readSupervisorFact(entry.configPath)).value;
      invariant(
        foundationStat.isFile() &&
          (foundationStat.mode & 0o077) === 0 &&
          foundationConfig.c?.instanceId === input.instanceId &&
          foundationConfig.c?.foundationMode === mode &&
          foundationConfig.c?.stableControl?.key === c.keys.upgradeControl &&
          foundationConfig.context?.keys?.controller === c.keys.controller &&
          foundationConfig.context?.keys?.upgradeControl ===
            c.keys.upgradeControl &&
          foundationConfig.c?.stableControl?.migratedArtifactPath ===
            c.migrationSourcePath && (mode !== "supervisor" ||
              (digest(foundationConfig.c.docker) === digest(c.adapter.docker) &&
               digest(foundationConfig.c.trustedRuntimeDockerCli) === digest(c.adapter.trustedRuntimeDockerCli))),
        "CONTROL_MIGRATION_FOUNDATION_CONFIG_CHANGED",
      );
      invariant(
        target.mode === mode &&
          target.args?.[0] ===
            join(
              c.controlPackage.artifactRoot,
              "installer/control-foundation.mjs",
            ) &&
          target.args.length === 2 &&
          target.args[1] === entry?.configPath &&
          target.record.startIdentity === entry.startIdentity &&
          target.resources.memoryBytes === entry.resources.memoryBytes &&
          target.resources.cpuMilliCores === entry.resources.cpuMilliCores,
        "CONTROL_MIGRATION_FOUNDATION_CONFIG_CHANGED",
      );
    }
    invariant(
      c.targets.coordinator.env.PLATFORM_CONTROLLER_RPC_KEY ===
        c.keys.controller &&
        c.targets.coordinator.env.PLATFORM_ENTRY_CONTROL_KEY ===
          c.keys.controller &&
        c.targets.coordinator.env.PLATFORM_INSTALLER_SUPERVISOR_KEY ===
          c.keys.controller,
      "CONTROL_MIGRATION_BUSINESS_KEY_MAPPING_CHANGED",
    );
    for (const kind of ["api", "coordinator"]) {
      const target = c.targets[kind],
        entry = join(
          c.businessPackage.artifactRoot,
          "api/apps/api/dist/roles",
          kind === "api" ? "control-api-main.js" : "coordinator-main.js",
        );
      invariant(
        target.entry === entry &&
          target.args?.length === 1 &&
          target.args[0] === entry &&
          Object.keys(target.env).every(
            (k) =>
              ![
                "NODE_OPTIONS",
                "NODE_PATH",
                "LD_PRELOAD",
                "LD_LIBRARY_PATH",
                "ACCESS_PASSCODE",
                "PASSCODE_COOKIE_SECRET",
                "UPGRADE_SESSION_SECRET",
                "UPGRADE_ADMIN_KEY",
                "UPGRADE_LEGACY_AUTH_CONTINUITY_KEY",
              ].includes(k),
          ),
        "CONTROL_MIGRATION_ROLE_ENTRY_CHANGED",
      );
    }
    for (const target of Object.values(c.targets))
      for (const mount of roleMounts(c.adapter, target))
        invariant(
          (await fs.lstat(mount.source)).isDirectory() ||
            (await fs.lstat(mount.source)).isFile(),
          "CONTROL_MIGRATION_MOUNT_NOT_PREPARED",
        );
  }
  async function verifyPackages() {
    if (provided)
      return { kind: "explicit-test-adapter", productionQualified: false };
    const control = c.controlPackage,
      business = c.businessPackage;
    invariant(
      control &&
        business &&
        c.targets["control-agent"].artifactRoot === control.artifactRoot &&
        c.targets.api.artifactRoot === business.artifactRoot &&
        c.targets.coordinator.artifactRoot === business.artifactRoot,
      "CONTROL_MIGRATION_SIGNED_PACKAGES_REQUIRED",
    );
    const engine = await actualInstallerIdentity({
        instanceId: input.instanceId,
        startIdentity: c.targets["control-agent"].record.startIdentity,
        root: join(control.artifactRoot, "installer"),
      }),
      verified = await verifyInstalledControlPackage({
        ...control,
        engineIdentity: engine,
        clock,
      });
    const { signed } = await readVerifiedMigrationBusiness(business,{clock});
    invariant(
      business.archivePath ===
        join(
          c.adapter.root,
          "installer/artifacts",
          signed.package.digest.slice(7) + ".tgz",
        ),
      "CONTROL_MIGRATION_ARCHIVE_SCOPE_CHANGED",
    );
    const archive = await fileDigest(business.archivePath);
    invariant(
      archive.digest === signed.package.digest &&
        archive.bytes === signed.package.bytes,
      "CONTROL_MIGRATION_ARCHIVE_CHANGED",
    );
    const bundle = await readJson(
        join(business.artifactRoot, "upgrade-artifact.json"),
      ),
      files = (await treeManifest(business.artifactRoot)).filter(
        (f) => !["installed.json", "upgrade-artifact.json"].includes(f.path),
      );
    invariant(
      canonical(files) === canonical(bundle.files) &&
        digest(files) === bundle.treeDigest &&
        canonical(bundle.components) ===
          canonical(signed.manifest.components) &&
        digest(files.filter((f) => f.path.startsWith("api/"))) ===
          signed.manifest.components.api.artifactDigest &&
        signed.manifest.components.api.artifactDigest ===
          signed.manifest.components.coordinator.artifactDigest &&
        c.targets.api.record.artifactDigest ===
          signed.manifest.components.api.artifactDigest &&
        c.targets.coordinator.record.artifactDigest ===
          signed.manifest.components.coordinator.artifactDigest &&
        verified.executionEngineDigest ===
          signed.manifest.components.installer.artifactDigest &&
        c.targets["control-agent"].record.artifactDigest ===
          engine.artifactDigest,
      "CONTROL_MIGRATION_TARGET_PACKAGE_CHANGED",
    );
    return {
      controlManifestDigest: verified.packageDigest,
      controlTreeDigest: verified.treeDigest,
      engineDigest: engine.artifactDigest,
      businessManifestDigest: signed.manifestDigest,
      businessTreeDigest: bundle.treeDigest,
      archiveDigest: archive.digest,
      archiveBytes: archive.bytes,
      sourceReadMinFreeBytes: signed.manifest.policy.minFreeBytes,
    };
  }
  async function publishSourceProvenance() {
    if (provided && !c.businessPackage) return;
    invariant(
      c.migrationSourcePath ===
        join(c.adapter.root, "bindings/migration-source.json") &&
        c.targets.coordinator.env.UPGRADE_MIGRATED_ARTIFACT_PATH ===
          c.migrationSourcePath,
      "CONTROL_MIGRATION_PROVENANCE_PATH_REQUIRED",
    );
    const {envelope,signed}=await readVerifiedMigrationBusiness(c.businessPackage,{clock});
    const receipt = {
      schemaVersion: 1,
      instanceId: input.instanceId,
      artifactRoot: c.businessPackage.artifactRoot,
      signedManifest: envelope,
      packageDigest: signed.package.digest,
      controlArtifactRoot: c.controlPackage.artifactRoot,
      archivePath: c.businessPackage.archivePath,
    };
    const prior = await readJson(c.migrationSourcePath, null);
    invariant(
      !prior || canonical(prior) === canonical(receipt),
      "CONTROL_MIGRATION_PROVENANCE_CHANGED",
    );
    if (!prior) await atomicJson(c.migrationSourcePath, receipt);
    return { receiptDigest: digest(receipt) };
  }
  async function capacity({ collect = false } = {}) {
    if (capacityBookkeeper) {
      await capacityBookkeeper.initialize();
      if (collect) await capacityBookkeeper.collect();
    }
    const planFile = await readSupervisorFact(c.capacity.planPath),
      factFile = await readSupervisorFact(c.capacity.observationPath),
      plan = planFile.value,
      fact = factFile.value;
    invariant(
      plan.planDigest ===
        (capacityBookkeeper?.status()?.planDigest ?? c.capacity.planDigest),
      "CONTROL_MIGRATION_CAPACITY_PLAN_CHANGED",
    );
    const ids = new Set();
    for (const [kind, target] of Object.entries(c.targets)) {
      const category = ["api", "coordinator"].includes(kind)
          ? "candidate"
          : "control",
        matches = plan.allocations?.[category]?.filter(
          (a) => a.id === target.capacityAllocationId,
        );
      invariant(
        matches?.length === 1 &&
          (!matches[0].resident || capacityBookkeeper) &&
          !ids.has(target.capacityAllocationId) &&
          canonical(matches[0].resources) === canonical(target.resources) &&
          ((matches[0].resident && capacityBookkeeper) ||
            matches[0].identityDigest ===
              digest({
                kind,
                startIdentity: target.record.startIdentity,
                artifactDigest: target.record.artifactDigest,
              })),
        "CONTROL_MIGRATION_CAPACITY_ALLOCATION_CHANGED",
      );
      ids.add(target.capacityAllocationId);
    }
    const result = evaluateCapacityAdmission({
      plan,
      observation: fact,
      now: clock(),
    });
    invariant(
      result.qualified === true,
      result.reason ?? "CONTROL_MIGRATION_CAPACITY_NOT_QUALIFIED",
    );
    return {
      planDigest: plan.planDigest,
      observationDigest: digest(fact),
      planFile: { identity: planFile.identity, digest: planFile.digest },
      factFile: { identity: factFile.identity, digest: factFile.digest },
    };
  }
  function businessLease(view) {
    const source = new Database(view?.path ?? input.businessPath, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      source.pragma("query_only=ON");
      return source
        .prepare(
          "SELECT instance_id,holder_id,generation,fence,expires_at FROM platform_role_leases WHERE role='state-coordinator'",
        )
        .get();
    } finally {
      source.close();
    }
  }
  function readViewScope(phase) {
    return { instanceId: input.instanceId, migrationId: input.migrationId, configDigest, phase,
      sourceBirths: Object.fromEntries(Object.entries(c.source).map(([role, record]) => [role, brief(record)])) };
  }
  async function assertClosedBusinessWriters(rollback = false) {
    for (const [role, expected] of Object.entries(c.source)) {
      const id = role === "coordinator" ? "stop-writer" : "stop-" + role,
        stopped = journal.lookup({ operationId: input.migrationId, commandId: input.migrationId + ":" + id });
      invariant(stopped?.state === "applied" && stopped.spec.targetDigest === digest(expected) && stopped.spec.configDigest === configDigest, "CONTROL_MIGRATION_SOURCE_VIEW_STOP_PROOF_REQUIRED");
      assertStopped(stopped.result, expected);
      assertStopped(await adapter.inspect(expected), expected);
    }
    const row = journal.lookup({ operationId: input.migrationId, commandId: input.migrationId + ":start-coordinator" });
    if (!row || ["planned", "definitely-not-applied"].includes(row.state)) return;
    invariant(rollback && row.state === "applied", "CONTROL_MIGRATION_SOURCE_VIEW_WRITER_UNKNOWN");
    assertStopped(await adapter.inspect(row.result), row.result);
  }
  async function closedReadView(phase = "final-source") {
    return createClosedBusinessReadView({ Database, businessPath: input.businessPath,
      directory: join(root, "closed-business-" + phase), scope: readViewScope(phase),
      assertClosed: () => assertClosedBusinessWriters(phase === "rollback-current"), clock });
  }
  async function rollbackBusinessLease() {
    try { return businessLease(); }
    catch (error) {
      if (error.code !== "SQLITE_CANTOPEN") throw error;
      return businessLease(await closedReadView("rollback-current"));
    }
  }
  async function waitReleased(expected, view) {
    const row = journal.lookup({ operationId: input.migrationId, commandId: input.migrationId + ":closed-source-view" });
    invariant(row?.state === "applied", "CONTROL_MIGRATION_READ_VIEW_RECEIPT_REQUIRED");
    return waitForMigrationLeaseRelease({ readLease: () => businessLease(view), expected, instanceId: input.instanceId,
      deadline: Math.min(c.deadline, row.createdAt + row.spec.budget.maxDurationMs), clock });
  }
  async function stop(id, expected, rollback = false, {deferCapacity=false} = {}) {
    const observeStopped = async () => {
      if(deferCapacity && rollback && id === "rollback-stop-control-supervisor") return failedStart.observe(expected);
      return stoppedOutcome(await adapter.inspect(expected), expected, rollback && id === "rollback-stop-api");
    };
    const result = await step(
      id,
      expected,
      async () => {
        await protection();
        const actual = await adapter.inspect(expected);
        if (!actual.running) {
          if(deferCapacity) return observeStopped();
          const failedCandidate = rollback && id === "rollback-stop-api";
          stoppedOutcome(actual, expected, failedCandidate);
          return stoppedOutcome(await adapter.inspect(expected), expected, failedCandidate);
        }
        const row = journal.lookup({ operationId: input.migrationId,
          commandId: input.migrationId + ":" + id });
        return adapter.terminate(expected, {
          deadline: Math.min(row.spec.deadline, row.createdAt + row.spec.budget.maxDurationMs),
        });
      },
      async () => ({ state: "applied", result: await observeStopped() }),
      { rollback },
    );
    if(!deferCapacity) await registerCapacity(id);
    return result;
  }
  async function publishExit(expected, actual, stopId = "stop-writer") {
    invariant(["stop-writer", "rollback-stop-coordinator"].includes(stopId) && expected.role === "coordinator",
      "CONTROL_MIGRATION_EXIT_STOP_PROOF_REQUIRED");
    assertStopped(actual, expected);
    const after = await adapter.inspect(expected);
    assertStopped(after, expected);
    const stopRow = journal.lookup({ operationId: input.migrationId, commandId: input.migrationId + ":" + stopId });
    invariant(stopRow?.state === "applied" && stopRow.spec.kind === "migration-" + stopId &&
      stopRow.spec.targetDigest === digest(expected) && stopRow.spec.configDigest === configDigest,
      "CONTROL_MIGRATION_EXIT_STOP_PROOF_REQUIRED");
    assertStopped(stopRow.result, expected);
    const exitedAt = stopId === "rollback-stop-coordinator" ? after.finishedAt : new Date(clock()).toISOString();
    invariant(Number.isFinite(Date.parse(exitedAt)) && Date.parse(exitedAt) >= Date.parse(expected.startedAt) &&
      Date.parse(exitedAt) <= clock(), "CONTROL_MIGRATION_EXIT_STOP_PROOF_REQUIRED");
    const facts = {
      schemaVersion: 1,
      kind: "coordinator-normal-exit",
      instanceId: input.instanceId,
      migrationId: input.migrationId,
      originalCommandId: input.migrationId + ":" + stopId,
      target: {
        containerId: expected.containerId,
        startIdentity: expected.startIdentity,
        DockerStartedAt: expected.startedAt,
        artifactDigest: expected.artifactDigest,
        restartCount: expected.restartCount,
      },
      after: {
        running: false,
        hostPid: 0,
        restartPolicy: "no",
        restartCount: actual.restartCount,
      },
      exitedAt,
    };
    const path = join(await secureDirectory(c.retiredCoordinatorRoot), expected.containerId + ".json"),
      prior = await priorExitReceipt(expected);
    if (prior) {
      const kind = classifyMigrationCoordinatorExit(prior.value, { instanceId: input.instanceId, migrationId: input.migrationId, expected, now: clock() });
      if (kind === "current") {
        invariant(prior.value.originalCommandId === facts.originalCommandId,
          "CONTROL_MIGRATION_EXIT_RECEIPT_CONFLICT");
        return prior.value;
      }
      const history = await secureDirectory(join(c.retiredCoordinatorRoot, "history", expected.containerId)),
        archive = join(history, encodeURIComponent(prior.value.migrationId) + ".json");
      let output;
      try {
        output = await fs.open(archive, "wx", 0o600);
        await output.writeFile(prior.bytes); await output.sync();
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        await readSupervisorFact(archive, 16384);
        invariant((await fs.readFile(archive)).equals(prior.bytes), "CONTROL_MIGRATION_EXIT_HISTORY_CHANGED");
      } finally { if (output) await output.close(); }
      for (const directory of [history, dirname(history), c.retiredCoordinatorRoot]) {
        const d = await fs.open(directory, "r"); try { await d.sync(); } finally { await d.close(); }
      }
      const current = await priorExitReceipt(expected);
      invariant(current && current.bytes.equals(prior.bytes), "CONTROL_MIGRATION_EXIT_PUBLICATION_CAS_CHANGED");
    }
    const receipt = { ...facts, receiptDigest: digest(facts) };
    await atomicJson(path, receipt);
    return receipt;
  }
  async function priorExitReceipt(expected) {
    const path = join(c.retiredCoordinatorRoot, expected.containerId + ".json");
    let fact;
    try { fact = await readSupervisorFact(path, 16384); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
    const bytes = await fs.readFile(path);
    invariant(digest(bytes.toString("utf8")) === fact.digest, "CONTROL_MIGRATION_EXIT_PUBLICATION_CAS_CHANGED");
    const kind = classifyMigrationCoordinatorExit(fact.value, { instanceId: input.instanceId, migrationId: input.migrationId, expected, now: clock() });
    if (kind === "historical") {
      const archive = join(c.retiredCoordinatorRoot, "history", expected.containerId, encodeURIComponent(fact.value.migrationId) + ".json");
      try {
        await readSupervisorFact(archive, 16384);
        invariant((await fs.readFile(archive)).equals(bytes), "CONTROL_MIGRATION_EXIT_HISTORY_CHANGED");
      } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    return { value: fact.value, bytes };
  }
  async function assertNoPending(view) {
    const source = new Database(view?.path ?? input.businessPath, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      source.pragma("query_only=ON");
      invariant(
        !source
          .prepare(
            "SELECT 1 FROM upgrade_attempts WHERE instance_id=? AND state IN ('accepted','downloading','package-verified','migrating','prepared','candidate-ready','routing-switched','observing','api-activated') LIMIT 1",
          )
          .get(input.instanceId),
        "CONTROL_MIGRATION_LEGACY_WORK_ACTIVE",
      );
      invariant(
        !source
          .prepare(
            "SELECT 1 FROM upgrade_recoveries WHERE instance_id=? AND state='recovering' LIMIT 1",
          )
          .get(input.instanceId),
        "CONTROL_MIGRATION_LEGACY_WORK_ACTIVE",
      );
      invariant(
        !source
          .prepare(
            "SELECT 1 FROM platform_operations WHERE instance_id=? AND role IN ('upgrade-plan','project-name-contract') AND state NOT IN ('completed','failed','deferred','cleared','cancelled') LIMIT 1",
          )
          .get(input.instanceId),
        "CONTROL_MIGRATION_LEGACY_WORK_ACTIVE",
      );
    } finally {
      source.close();
    }
    const entries = await fs.readdir(c.legacyProcessRoot, {
      withFileTypes: true,
    });
    invariant(entries.length <= 4096, "CONTROL_MIGRATION_LEGACY_RECORD_LIMIT");
    for (const name of entries.filter(
      (n) => /-[a-z]+\.json$/.test(n.name) && !n.name.endsWith("-config.json"),
    )) {
      const r = (
        await readSupervisorFact(join(c.legacyProcessRoot, name.name), 65536)
      ).value;
      if (!["api", "coordinator", "installer", "owner", "web"].includes(r.kind))
        continue;
      invariant(
        r.instanceId === input.instanceId &&
          r.state === "started" &&
          CID.test(r.containerId),
        "CONTROL_MIGRATION_LEGACY_DISPATCH_UNKNOWN",
      );
      const actual = await adapter.inspect({ ...r, role: r.kind });
      invariant(
        actual.startIdentity === r.startIdentity &&
          actual.artifactDigest === r.artifactDigest,
        "CONTROL_MIGRATION_LEGACY_DISPATCH_UNKNOWN",
      );
    }
    return {
      observedAt: new Date(clock()).toISOString(),
      activeAttempts: 0,
      activeRecoveries: 0,
      unresolvedLaunches: 0,
    };
  }
  async function launch(kind) {
    const source = c.targets[kind];
    invariant(
      source &&
        source.kind === kind &&
        source.record?.startIdentity &&
        DIGEST.test(source.record.artifactDigest),
      "CONTROL_MIGRATION_TARGET_SPEC_REQUIRED",
    );
    const record = {
      ...source.record,
      kind,
      instanceId: input.instanceId,
      attemptId: input.migrationId,
      operationId: input.migrationId,
      commandId: input.migrationId + ":start-" + kind,
      specDigest: digest(source),
    };
    const result = await step(
      "start-" + kind,
      source,
      async () => {
        await protection();
        const admitted = await capacity({ collect: true });
        if (kind === "coordinator")
          invariant(
            source.entry.endsWith("/roles/coordinator-main.js") &&
              source.env.SANDBOX_RECONCILE_ON_BOOT === "false" &&
              source.env.UPGRADE_CONTROL_DATABASE_PATH === input.controlPath,
            "CONTROL_MIGRATION_NORMAL_COORDINATOR_REQUIRED",
          );
        const env = { ...source.env };
        if (kind === "control-agent") {
          const original = await input.readAccessEnvironment();
          invariant(
            digest(original) === load().accessEnvironmentDigest,
            "CONTROL_MIGRATION_ORIGINAL_ENV_CHANGED",
          );
          for (const key of ["ACCESS_PASSCODE", "PASSCODE_COOKIE_SECRET"])
            if (original[key] !== undefined) env[key] = original[key];
        }
        const proof = await adapter.launch({
          ...source,
          env,
          record,
          stableBootstrap: true,
          assertBeforeDispatch: async () => {
            await protection();
            const current = await capacity();
            invariant(
              canonical(current) === canonical(admitted),
              "CONTROL_MIGRATION_CAPACITY_CAS_CHANGED",
            );
          },
        });
        invariant(
          proof.running === true &&
            proof.paused === false &&
            CID.test(proof.containerId) &&
            proof.hostPid > 0 &&
            proof.role === kind &&
            proof.startIdentity === record.startIdentity &&
            proof.artifactDigest === record.artifactDigest,
          "CONTROL_MIGRATION_TARGET_START_UNKNOWN",
        );
        return { ...record, ...brief(proof) };
      },
      async () => {
        const result = await adapter.lookupLaunch(record);
        if (result?.state === "definitely-not-applied") return result;
        invariant(
          result?.state === "applied" &&
            result.result.startIdentity === record.startIdentity &&
            result.result.artifactDigest === record.artifactDigest,
          "CONTROL_MIGRATION_TARGET_START_UNKNOWN",
        );
        return {
          state: "applied",
          result: { ...record, ...brief(result.result) },
        };
      },
    );
    await registerCapacity("start-" + kind);
    return result;
  }
  async function registerCoordinator(record) {
    const spec = c.targets.coordinator,
      path = join(c.legacyProcessRoot, input.migrationId + "-coordinator.json");
    const processRecord = {
      ...record,
      state: "started",
      kind: "coordinator",
      pid: 1,
      origin: spec.origin,
      applicationOrigin: spec.origin,
      metadataPath: "/internal/application/identity",
      artifactRoot: spec.artifactRoot,
      inputFingerprint: spec.record.inputFingerprint,
    };
    const prior = await readJson(path, null);
    if (prior)
      invariant(
        prior.containerId === record.containerId &&
          prior.startIdentity === record.startIdentity &&
          prior.artifactDigest === record.artifactDigest,
        "CONTROL_MIGRATION_COORDINATOR_RECORD_CONFLICT",
      );
    await atomicJson(path, processRecord);
    invariant(
      typeof c.installedRolesRoot === "string",
      "CONTROL_MIGRATION_REGISTRY_REQUIRED",
    );
    const retirement = await createContractRetirement({
      directory: c.installedRolesRoot,
      instanceId: input.instanceId,
      coordinator: null,
      launchAdapter: {
        inspect: (id) =>
          adapter.inspect({
            ...processRecord,
            containerId: id,
            role: "coordinator",
          }),
      },
      controlKey: c.keys.control,
      controllerKey: c.keys.controller,
      businessRoot: c.adapter?.businessRoot,
    });
    const registered = await retirement.register(processRecord);
    return {
      containerId: registered.containerId,
      startIdentity: registered.startIdentity,
      artifactDigest: registered.artifactDigest,
      readerId: registered.readerId,
    };
  }
  async function ready(kind, read) {
    const row = journal.lookup({
      operationId: input.migrationId,
      commandId: input.migrationId + ":start-" + kind,
    });
    invariant(
      row?.state === "applied",
      "CONTROL_MIGRATION_START_RECEIPT_REQUIRED",
    );
    const deadline = Math.min(
      row.spec.deadline,
      row.createdAt + row.spec.budget.maxDurationMs,
    );
    let lastError;
    const readinessExpired = () => Object.assign(
      Error("Original role readiness budget expired", { cause: lastError }),
      { code: "CONTROL_MIGRATION_READINESS_BUDGET_EXCEEDED" },
    );
    async function inspectStartedRole() {
      try {
        const expected = row.result, actual = await adapter.inspect(expected);
        invariant(sameBirth(actual, expected) && actual.paused === false && actual.restartPolicy === "no" &&
          actual.restartCount === expected.restartCount, "CONTROL_MIGRATION_PHYSICAL_CHANGED");
        if (actual.running === false && actual.hostPid === 0)
          throw Object.assign(Error("Original started role exited before readiness"), {
            code: "CONTROL_MIGRATION_ROLE_EXITED", role: kind, exitCode: actual.exitCode,
          });
        assertRunning(actual, expected);
      } catch (error) {
        if (lastError && error.cause === undefined) error.cause = lastError;
        throw error;
      }
    }
    while (true) {
      if (clock() >= deadline) throw readinessExpired();
      await inspectStartedRole();
      let value;
      try {
        value = await read();
      } catch (error) {
        lastError = error;
        await inspectStartedRole();
        if (clock() >= deadline) throw readinessExpired();
        await sleep(Math.min(100, deadline - clock()));
        continue;
      }
      await inspectStartedRole();
      if (clock() > deadline) throw readinessExpired();
      return value;
    }
  }
  async function verifyWriter(record) {
    const rpc = createPrivateControlRpc({
      origin: c.targets.coordinator.origin,
      instanceId: input.instanceId,
      key: c.keys.controller,
    });
    const response = await rpc("/internal/upgrades/inspection", {
        action: "writerIdentity",
      }),
      w = response.result,
      lease = businessLease();
    invariant(
      response.instanceId === input.instanceId &&
        response.action === "writerIdentity" &&
        w?.writerFenceValid === true &&
        w.startIdentity === record.startIdentity &&
        w.artifactDigest === record.artifactDigest &&
        w.generation > load().qualification.lease.generation &&
        lease?.instance_id === input.instanceId &&
        lease.generation === w.generation &&
        lease.holder_id === w.lease.holderId &&
        lease.fence === w.lease.fence &&
        lease.expires_at > clock() &&
        clock() - Date.parse(w.observedAt) >= 0 &&
        clock() - Date.parse(w.observedAt) <= 5000,
      "CONTROL_MIGRATION_NEW_WRITER_UNPROVEN",
    );
    return w;
  }
  async function setBinding(path, expectedDigest, value) {
    const prior = (await readSupervisorFact(path)).value;
    if (digest(prior) === digest(value))
      return { bindingDigest: digest(value) };
    invariant(
      digest(prior) === expectedDigest,
      "CONTROL_MIGRATION_BINDING_CAS_CHANGED",
    );
    await atomicJson(path, value);
    return { bindingDigest: digest(value) };
  }
  async function apply() {
    const state = db
      .prepare("SELECT state FROM control_migration_run WHERE singleton=1")
      .get().state;
    if (state === "migrated") return status();
    invariant(
      !state.startsWith("rollback") && state !== "rolled-back",
      "CONTROL_MIGRATION_ALREADY_ROLLING_BACK",
    );
    getNormalHandoff();
    await validateProductionInputs();
    if(adapter.preflightIndependentFoundation) {
      const runtimeDependencyProof=await adapter.preflightIndependentFoundation(c.targets["control-supervisor"]);
      if(load().runtimeDependencyProof) invariant(digest(runtimeDependencyProof) === digest(load().runtimeDependencyProof),
        "CONTROL_RUNTIME_DOCKER_DEPENDENCY_CHANGED");
      else save({runtimeDependencyProof});
    }
    await protection();
    await reconcileCapacity();
    await capacity({ collect: true });
    const packageProof = await verifyPackages();
    if (load().packageProof)
      invariant(
        canonical(load().packageProof) === canonical(packageProof),
        "CONTROL_MIGRATION_SIGNED_PACKAGE_CHANGED",
      );
    if(normalHandoff) await normalHandoff.preflight();
    await publishSourceProvenance();
    if (!load().qualification) {
      for (const expected of Object.values(c.source))
        assertRunning(await adapter.inspect(expected), expected);
      await assertNoPending();
      const physical = await adapter.inspect(c.source.coordinator),
        qualification = await qualifyControlMigrationSource({
          ...input,
          Database,
          sourcePhysical: physical,
        });
      if (!load().qualification)
        save(
          {
            qualification,
            packageProof,
            accessEnvironmentDigest: digest(
              await input.readAccessEnvironment(),
            ),
            protectedBefore: await protection(),
          },
          "applying",
        );
    }
    // Current consumers select <CID>.json by the exact observed birth. Reject a
    // corrupt/conflicting predecessor before stopping anything; valid old births
    // are archived only after the new original stop is durably proven.
    await priorExitReceipt(c.source.coordinator);
    // Probe and reserve the real source-sized working set before any stop.
    if (!load().readViewPreflight) {
      const probe = await probeClosedBusinessReadView({ Database, businessPath: input.businessPath,
        directory: root, scope: readViewScope("final-source"), minFreeBytes: packageProof.sourceReadMinFreeBytes ?? 0 });
      save({ readViewPreflight: probe });
    }
    const priorFirstStop = journal.lookup({ operationId: input.migrationId,
      commandId: input.migrationId + ":stop-foundation" });
    if (!priorFirstStop || ["planned", "definitely-not-applied"].includes(priorFirstStop.state)) {
      const proof = await (provided ? preStopInventory : assertMigrationPreStopInventory)({
        runtime: c, instanceId: input.instanceId, lease: load().qualification.lease,
        inspect: record => adapter.inspect(record), clock,
      });
      save({ preStopPublicInventory: proof });
    }
    await stop("stop-foundation", c.source.foundation);
    await stop("stop-installer", c.source.installer);
    const priorExport = journal.lookup({ operationId: input.migrationId, commandId: input.migrationId + ":final-export" });
    let businessReadView;
    // A completed export is immutable history. On resume a new writer may already
    // own the real DB; never re-run the old writer's lease check against it.
    if (priorExport?.state !== "applied") {
      const currentSource = await adapter.inspect(c.source.coordinator);
      if (currentSource.running) {
        await assertNoPending();
        const fresh = await qualifyControlMigrationSource({ ...input, Database, sourcePhysical: currentSource });
        invariant(canonical(fresh.binding) === canonical(load().qualification.binding) &&
          ["holder_id", "generation", "fence"].every(k => fresh.lease[k] === load().qualification.lease[k]),
          "CONTROL_MIGRATION_SOURCE_CHANGED");
        save({ lastLiveSourceWitness: fresh });
      }
      const stopped = await stop("stop-writer", c.source.coordinator);
      businessReadView = await step("closed-source-view", { scope: readViewScope("final-source") },
        () => closedReadView(), async () => {
          try { await fs.lstat(join(root, "closed-business-final-source", "receipt.json")); }
          catch (error) { if (error.code === "ENOENT") return null; throw error; }
          return { state: "applied", result: await closedReadView() };
        });
      save({ businessReadView });
      await assertNoPending(businessReadView);
      await waitReleased(load().qualification.lease, businessReadView);
      await publishExit(c.source.coordinator, stopped);
    }
    const metadata = await step(
      "final-export",
      {
        qualification: load().qualification.proofDigest,
        exportPath: input.exportPath,
        controlPath: input.controlPath,
      },
      () =>
        prepareControlMigration({
          ...input,
          Database,
          qualifiedSource: load().qualification,
          businessReadView,
          businessReadViewScope: readViewScope("final-source"),
          readStoppedWriter: () => adapter.inspect(c.source.coordinator),
          readAccessEnvironment: async () => {
            const env = await input.readAccessEnvironment();
            invariant(
              digest(env) === load().accessEnvironmentDigest,
              "CONTROL_MIGRATION_ORIGINAL_ENV_CHANGED",
            );
            return env;
          },
        }),
      () => {
        const s = controlMigrationStatus({ ...input, Database });
        return s.state === "prepared" ? { state: "applied", result: s } : null;
      },
    );
    save({ metadata });
    const agent = await launch("control-agent");
    save({ agent });
    await ready("control-agent", async () => {
      const rpc = createPrivateControlRpc({
          origin: c.targets["control-agent"].origin,
          instanceId: input.instanceId,
          key: c.keys.upgradeControl,
        }),
        m = await rpc("/metadata");
      invariant(
        m.instanceId === input.instanceId &&
          m.role === "installer" &&
          m.startIdentity === agent.startIdentity &&
          m.artifactDigest === agent.artifactDigest &&
          m.controlSystem &&
          clock() - Date.parse(m.observedAt) >= 0 &&
          clock() - Date.parse(m.observedAt) <= 5000,
        "CONTROL_MIGRATION_AGENT_IDENTITY_UNPROVEN",
      );
      return m;
    });
    const coordinator = await launch("coordinator");
    save({ coordinator });
    const writer = await ready("coordinator", () => verifyWriter(coordinator));
    save({ writer });
    await step(
      "register-coordinator",
      {
        containerId: coordinator.containerId,
        startIdentity: coordinator.startIdentity,
      },
      () => registerCoordinator(coordinator),
      async () => {
        const registered = await registerCoordinator(coordinator);
        return { state: "applied", result: registered };
      },
    );
    const binding = migrationCoordinatorBinding({
      instanceId: input.instanceId,
      origin: c.targets.coordinator.origin,
      artifactDigest: coordinator.artifactDigest,
      generation: writer.generation,
    });
    await step(
      "bind-coordinator",
      { path: c.bindings.coordinatorPath, value: binding },
      () =>
        setBinding(
          c.bindings.coordinatorPath,
          c.bindings.originalCoordinatorDigest,
          binding,
        ),
      async () => {
        const actual = (await readSupervisorFact(c.bindings.coordinatorPath))
          .value;
        return digest(actual) === digest(binding)
          ? { state: "applied", result: { bindingDigest: digest(binding) } }
          : null;
      },
    );
    const api = await launch("api");
    save({ api });
    const apiRpc = createPrivateControlRpc({
      origin: c.targets.api.origin,
      instanceId: input.instanceId,
      key: c.keys.control,
    });
    const actualApi = await ready("api", async () => {
      const m = await apiRpc("/internal/control/identity");
      invariant(
        m.instanceId === input.instanceId &&
          m.startIdentity === api.startIdentity &&
          m.artifactDigest === api.artifactDigest &&
          m.controlOnly === true &&
          m.noRuntimeSideEffects === true,
        "CONTROL_MIGRATION_API_UNPROVEN",
      );
      return m;
    });
    const supervisorProcess = await launch("control-supervisor");
    save({ supervisorProcess });
    const entryProcess = await launch("control-entry");
    save({ entryProcess });
    const supervisor = createPrivateControlRpc({
        origin: c.supervisorOrigin,
        instanceId: input.instanceId,
        key: c.keys.supervisor,
      }),
      inventory = await ready("control-supervisor", async () => {
        const inventory = await supervisor("/coordinator-inventory");
        invariant(
          Array.isArray(c.knownCoordinators) &&
            c.knownCoordinators.length > 0 &&
            inventory.complete === true &&
            inventory.instanceId === input.instanceId &&
            clock() - Date.parse(inventory.observedAt) >= 0 &&
            clock() - Date.parse(inventory.observedAt) <= 5000 &&
            Array.isArray(inventory.coordinators) &&
            canonical(
              inventory.coordinators.map((x) => x.containerId).sort(),
            ) ===
              canonical(
                [
                  ...c.knownCoordinators.map((x) => x.containerId),
                  coordinator.containerId,
                ].sort(),
              ) &&
            inventory.coordinators.every((x) => {
              const proof = x.actualIdentity ?? x.retiredPhysical;
              return (
                proof &&
                clock() - Date.parse(proof.observedAt) >= 0 &&
                clock() - Date.parse(proof.observedAt) <= 5000
              );
            }) &&
            inventory.coordinators.filter(
              (x) => x.actualIdentity?.writerFenceValid === true,
            ).length === 1 &&
            inventory.coordinators.some(
              (x) =>
                x.actualIdentity?.startIdentity === coordinator.startIdentity &&
                x.actualIdentity.writerFenceValid === true,
            ),
          "CONTROL_MIGRATION_SINGLE_WRITER_UNPROVEN",
        );
        return inventory;
      });
    const entryControl = createPrivateControlRpc({
        origin: c.entryControlOrigin,
        instanceId: input.instanceId,
        key: c.keys.entry,
      }),
      entryObserved = await ready("control-entry", () =>
        entryControl("/binding"),
      );
    const { inFlight, activeWS, httpByDigest, wsByDigest, ...entryBinding } =
        entryObserved,
      selected =
        entryBinding.weight === 100
          ? entryBinding.candidateApi
          : entryBinding.weight === 0
            ? entryBinding.oldApi
            : null;
    invariant(
      entryBinding.instanceId === input.instanceId &&
        digest(entryBinding) === c.entryBindingDigest &&
        selected?.origin === c.targets.api.origin &&
        selected.digest === api.artifactDigest,
      "CONTROL_MIGRATION_ENTRY_BINDING_UNPROVEN",
    );
    const health = await fetch(
      privateLoopbackOrigin(c.entryOrigin) + "/api/health",
      { redirect: "error", signal: AbortSignal.timeout(2000) },
    );
    invariant(health.status === 200, "CONTROL_MIGRATION_ENTRY_HEALTH_UNPROVEN");
    await health.body?.cancel();
    await protection();
    await verifyWriter(coordinator);
    if(normalHandoff){
      await normalHandoff.publish();
      save({normalCapacityReady:await normalHandoff.assertReady(provided && handoffSupervisorReadiness || (()=>supervisor('/capacity-readiness')))});
    }
    const sourceBindingDigest = digest({
      migrationId: input.migrationId,
      source: load().qualification.proofDigest,
      coordinator: brief(coordinator),
      foundation: {
        entry: brief(entryProcess),
        supervisor: brief(supervisorProcess),
      },
    });
    const activation = await step(
      "activate",
      { sourceBindingDigest },
      async () => {
        const ledger = new Database(input.controlPath);
        try {
          const authority = createControlAuthority({
            sqlite: ledger,
            instanceId: input.instanceId,
            epochFloor: input.epochFloor,
            clock,
          });
          return authority.activate({
            expectedRevision: authority.observe().revision,
            sourceBindingDigest,
          });
        } finally {
          ledger.close();
        }
      },
      async () => {
        const ledger = new Database(input.controlPath, { readonly: true });
        try {
          const a = ledger
            .prepare("SELECT * FROM control_authority WHERE instance_id=?")
            .get(input.instanceId);
          return a?.mode === "active" &&
            a.source_binding_digest === sourceBindingDigest
            ? {
                state: "applied",
                result: {
                  instanceId: input.instanceId,
                  mode: "active",
                  epoch: a.epoch,
                  sourceBindingDigest: a.source_binding_digest,
                },
              }
            : null;
        } finally {
          ledger.close();
        }
      },
    );
    const protectedAfter = await protection();
    invariant(
      protectedAfter.digest === load().protectedBefore.digest,
      "CONTROL_MIGRATION_PROTECTED_SCOPE_CHANGED",
    );
    save(
      {
        activation,
        protectedAfter,
        completedAt: new Date(clock()).toISOString(),
      },
      "migrated",
    );
    return status();
  }
  async function rollback() {
    const unregisteredSupervisor = await capacityBookkeeper?.hasUnregisteredFailedStart();
    if(!unregisteredSupervisor) await reconcileCapacity();
    invariant(load().qualification, "CONTROL_MIGRATION_NOT_STARTED");
    const names = {
      "control-agent": "agent",
      coordinator: "coordinator",
      api: "api",
      "control-supervisor": "supervisorProcess",
      "control-entry": "entryProcess",
    };
    // Every possibly-dispatched start is closed under its original ID first.
    for (const [kind, name] of Object.entries(names)) {
      const key = {
          operationId: input.migrationId,
          commandId: input.migrationId + ":start-" + kind,
        },
        row = journal.lookup(key);
      if (!row || ["planned", "definitely-not-applied"].includes(row.state))
        continue;
      invariant(!live.has(key.commandId), "CONTROL_MIGRATION_COMMAND_UNKNOWN");
      if (row.state === "applied") {
        save({ [name]: row.result });
        continue;
      }
      const spec = c.targets[kind],
        record = {
          ...spec.record,
          kind,
          instanceId: input.instanceId,
          attemptId: input.migrationId,
          operationId: input.migrationId,
          commandId: key.commandId,
          specDigest: digest(spec),
        };
      const actual = await adapter.lookupLaunch(record);
      invariant(
        ["applied", "definitely-not-applied"].includes(actual?.state),
        "CONTROL_MIGRATION_COMMAND_UNKNOWN",
      );
      if (actual.state === "applied") {
        invariant(
          actual.result.startIdentity === record.startIdentity &&
            actual.result.artifactDigest === record.artifactDigest,
          "CONTROL_MIGRATION_TARGET_START_UNKNOWN",
        );
        const result = { ...record, ...brief(actual.result) };
        journal.record({
          ...key,
          authorization: authorization(),
          state: "applied",
          result,
        });
        save({ [name]: result });
      } else
        journal.record({
          ...key,
          authorization: authorization(),
          state: "definitely-not-applied",
          result: actual.result,
        });
    }
    const before = load();
    if (before.agent) {
      const ledger = new Database(input.controlPath, {
        readonly: true,
        fileMustExist: true,
      });
      try {
        invariant(
          !ledger
            .prepare(
              "SELECT 1 FROM upgrade_attempts WHERE accepted_at>? LIMIT 1",
            )
            .get(Date.parse(before.qualification.observedAt)) &&
            !ledger
              .prepare(
                "SELECT 1 FROM platform_operations WHERE role IN ('upgrade-plan','project-name-contract') AND created_at>? LIMIT 1",
              )
              .get(Date.parse(before.qualification.observedAt)),
          "CONTROL_MIGRATION_POST_UPGRADE_ROLLBACK_FORBIDDEN",
        );
        invariant(
          !ledger
            .prepare(
              "SELECT 1 FROM control_commands WHERE state IN ('executing','unknown','blocked') LIMIT 1",
            )
            .get(),
          "CONTROL_MIGRATION_CONTROL_COMMAND_PENDING",
        );
      } finally {
        ledger.close();
      }
      // A changed password/revocation must not be silently lost on fallback.
      controlMigrationStatus({ ...input, Database });
    }
    save({}, "rollback-running");
    if(unregisteredSupervisor) {
      await stop("rollback-stop-control-supervisor", before.supervisorProcess, true, {deferCapacity:true});
      await capacityBookkeeper.closeUnregisteredFailedStart();
      await reconcileCapacity();
    }
    for (const [kind, name] of [
      ["control-entry", "entryProcess"],
      ["control-supervisor", "supervisorProcess"],
      ["api", "api"],
      ["control-agent", "agent"],
      ["coordinator", "coordinator"],
    ])
      if (before[name]) await stop("rollback-stop-" + kind, before[name], true);
    async function restore(role) {
      const expected = c.source[role],
        actual = await adapter.inspect(expected),
        stopRow = journal.lookup({
          operationId: input.migrationId,
          commandId:
            input.migrationId +
            ":" +
            (role === "coordinator" ? "stop-writer" : "stop-" + role),
        });
      if (actual.running) {
        const restored = journal.lookup({
          operationId: input.migrationId,
          commandId: input.migrationId + ":rollback-" + role,
        });
        if (restored?.state === "applied") {
          invariant(
            sameBirth(actual, restored.result) &&
              actual.hostPid === restored.result.hostPid,
            "CONTROL_MIGRATION_ROLLBACK_SOURCE_CHANGED",
          );
          return actual;
        }
        invariant(
          !stopRow ||
            stopRow.state === "planned" ||
            stopRow.state === "definitely-not-applied",
          "CONTROL_MIGRATION_EXIT_UNKNOWN",
        );
        assertRunning(actual, expected);
        return actual;
      }
      const restored = await step(
        "rollback-" + role,
        expected,
        () => adapter.restart(expected),
        async () => {
          const p = await adapter.inspect(expected);
          return p.running &&
            p.hostPid > 0 &&
            p.startIdentity === expected.startIdentity &&
            p.artifactDigest === expected.artifactDigest &&
            p.startedAt !== expected.startedAt
            ? { state: "applied", result: brief(p) }
            : null;
        },
        { rollback: true },
      );
      await registerCapacity("rollback-" + role);
      return restored;
    }
    const current = await adapter.inspect(c.source.coordinator);
    if (!current.running) {
      const started = load().rollbackLeaseWaitStartedAt ?? clock();
      if (load().rollbackLeaseWaitStartedAt === undefined) save({ rollbackLeaseWaitStartedAt: started });
      await waitForMigrationLeaseRelease({ readLease: rollbackBusinessLease, instanceId: input.instanceId,
        deadline: Math.min(c.rollbackDeadline, started + c.actionBudgetMs), clock });
    }
    const source = await restore("coordinator");
    const oldRpc = createPrivateControlRpc({
        origin: c.source.coordinator.origin,
        instanceId: input.instanceId,
        key: c.keys.control,
      }),
      identity = await oldRpc("/internal/application/identity"),
      lease = businessLease();
    invariant(
      identity.instanceId === input.instanceId &&
        identity.startIdentity === source.startIdentity &&
        identity.artifactDigest === source.artifactDigest &&
        identity.writerFenceValid === true &&
        identity.coordinatorGeneration === lease.generation &&
        lease.expires_at > clock(),
      "CONTROL_MIGRATION_ROLLBACK_WRITER_UNPROVEN",
    );
    const original = (
      await readSupervisorFact(c.bindings.originalCoordinatorSnapshotPath)
    ).value;
    invariant(
      digest(original) === c.bindings.originalCoordinatorDigest,
      "CONTROL_MIGRATION_ROLLBACK_SNAPSHOT_CHANGED",
    );
    await atomicJson(c.bindings.coordinatorPath, {
      ...original,
      generation: lease.generation,
    });
    for (const role of ["installer", "foundation"]) await restore(role);
    const protectedAfter = await protection();
    invariant(
      protectedAfter.digest === before.protectedBefore.digest,
      "CONTROL_MIGRATION_PROTECTED_SCOPE_CHANGED",
    );
    const coordinatorStop = journal.lookup({ operationId: input.migrationId,
      commandId: input.migrationId + ":rollback-stop-coordinator" });
    if (before.coordinator && coordinatorStop?.state === "applied" &&
        [0, 143].includes(coordinatorStop.result?.exitCode) &&
        coordinatorStop.result?.failedStartInert !== true && coordinatorStop.result?.normalExit !== false)
      await publishExit(before.coordinator, coordinatorStop.result, "rollback-stop-coordinator");
    save(
      {
        rollbackSource: brief(source),
        protectedAfter,
        rolledBackAt: new Date(clock()).toISOString(),
      },
      "rolled-back",
    );
    return status();
  }
  function status() {
    const r = db
        .prepare("SELECT state FROM control_migration_run WHERE singleton=1")
        .get(),
      data = load();
    return {
      state: r.state,
      instanceId: input.instanceId,
      migrationId: input.migrationId,
      configDigest,
      pending: journal.pending(),
      metadata: data.metadata ?? null,
      completedAt: data.completedAt ?? null,
      rolledBackAt: data.rolledBackAt ?? null,
    };
  }
  async function prepare() {
    getNormalHandoff();
    await validateProductionInputs();
    if (!load().qualification) {
      await protection();
      for (const expected of Object.values(c.source))
        assertRunning(await adapter.inspect(expected), expected);
      await assertNoPending();
      await capacity({ collect: true });
      const packageProof = await verifyPackages();
      if(normalHandoff) await normalHandoff.preflight();
      const physical = await adapter.inspect(c.source.coordinator),
        qualification = await qualifyControlMigrationSource({
          ...input,
          Database,
          sourcePhysical: physical,
        });
      if (!load().qualification)
        save(
          {
            qualification,
            packageProof,
            accessEnvironmentDigest: digest(
              await input.readAccessEnvironment(),
            ),
            protectedBefore: await protection(),
          },
          "prepared",
        );
    }
    return status();
  }
  return {
    prepare: () => exclusive(prepare),
    apply: () => {
      if (!allowDisruptiveFixture) assertControlMigrationCommand('apply');
      return exclusive(apply);
    },
    resume: () => {
      if (!allowDisruptiveFixture) assertControlMigrationCommand('resume');
      return exclusive(apply);
    },
    rollback: () => exclusive(rollback),
    status,
    closeWhenIdle: () =>
      Promise.allSettled([...live.values()]).then(() => db.close()),
    close: () => {
      invariant(live.size === 0, "CONTROL_MIGRATION_ACTION_STILL_RUNNING");
      db.close();
    },
  };
}

export function controlMigrationRuntimeStatus({
  Database,
  runtime,
  instanceId,
  migrationId,
}) {
  const db = new Database(join(runtime.journalRoot, "migration.db"), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    db.pragma("query_only=ON");
    const row = db
      .prepare("SELECT * FROM control_migration_run WHERE singleton=1")
      .get();
    invariant(
      row?.instance_id === instanceId && row.migration_id === migrationId,
      "CONTROL_MIGRATION_STATUS_SCOPE_INVALID",
    );
    const pending = db
      .prepare(
        "SELECT command_id AS commandId,step_id AS stepId,state FROM control_commands WHERE state IN ('executing','unknown','blocked')",
      )
      .all();
    return {
      state: row.state,
      instanceId,
      migrationId,
      configDigest: row.config_digest,
      pending,
      runtimeImplemented: true,
    };
  } finally {
    db.close();
  }
}
