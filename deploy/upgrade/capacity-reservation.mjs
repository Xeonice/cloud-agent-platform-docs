import { digest, canonical, invariant, DIGEST } from "./trust.mjs";
import { readSupervisorFact } from "./supervisor-control.mjs";
import { atomicJson } from "./io.mjs";
import {
  freezeCapacityBudget,
  evaluateCapacityAdmission,
} from "./capacity-admission.mjs";
const ID = /^[a-zA-Z0-9._:-]{1,200}$/,
  ROLES = ["api", "coordinator", "owner", "web"];
const templateKeys = [
  "memoryBytes",
  "cpuMilliCores",
  "ioBytesPerSecond",
  "disks",
];
const TERMINAL = new Set([
  "activation-confirmed",
  "failed",
  "reverted",
  "deferred",
  "candidate-rejected",
]);
/** Read-only evidence. A newer live global authority and the Supervisor's
 * matching local admission revoke the terminal attempt; neither database is
 * used as an unfenced check-then-act permission to dispatch an old command. */
export function terminalCapacityReservationProof({
  controlSqlite,
  supervisorSqlite,
  instanceId,
  command,
  attemptId,
  role,
  allocationId,
  now,
}) {
  if (!controlSqlite || attemptId === command.operationId) return null;
  return controlSqlite.transaction(() => {
    const authority = controlSqlite
        .prepare("SELECT * FROM control_authority WHERE instance_id=?")
        .get(instanceId),
      attempt = controlSqlite
        .prepare(
          "SELECT attempt_id,instance_id,state,fence,sequence FROM upgrade_attempts WHERE instance_id=? AND attempt_id=?",
        )
        .get(instanceId, attemptId);
    if (
      !attempt ||
      !TERMINAL.has(attempt.state) ||
      authority?.mode !== "active" ||
      authority.kind !== "upgrade" ||
      authority.operation_id !== command.operationId ||
      authority.epoch !== command.authorization?.epoch ||
      authority.holder_id !== command.authorization?.executorId ||
      authority.lease_expires_at <= now ||
      authority.epoch <= attempt.fence
    )
      return null;
    const admission = supervisorSqlite
      .prepare(
        "SELECT instance_id,epoch,operation_id,executor_id,kind FROM supervisor_control_admission WHERE singleton=1",
      )
      .get();
    if (
      admission?.instance_id !== instanceId ||
      admission.epoch !== authority.epoch ||
      admission.operation_id !== authority.operation_id ||
      admission.executor_id !== authority.holder_id ||
      admission.kind !== "upgrade"
    )
      return null;
    const reads = (db) =>
        db
          .prepare(
            "SELECT command_id,spec_digest,spec,state,result FROM control_commands WHERE instance_id=? AND operation_id=? ORDER BY command_id LIMIT 129",
          )
          .all(instanceId, attemptId),
      root = reads(controlSqlite),
      local = reads(supervisorSqlite);
    if (root.length > 128 || local.length > 128) return null;
    for (const rows of [root, local])
      for (const row of rows) {
        let spec;
        try {
          spec = JSON.parse(row.spec);
        } catch {
          return null;
        }
        if (digest(spec) !== row.spec_digest) return null;
        if (spec.kind !== "supervisor-start") continue;
        if (
          !ROLES.includes(spec.request?.kind) ||
          spec.request.attemptId !== attemptId
        )
          return null;
        if (["executing", "unknown", "blocked"].includes(row.state))
          return null;
        if (
          spec.request.kind === role ||
          spec.capacityAllocationId === allocationId
        )
          if (!["planned", "definitely-not-applied"].includes(row.state))
            return null;
      }
    const facts = {
      instanceId,
      attempt,
      allocationId,
      role,
      revokingAuthority: {
        epoch: authority.epoch,
        operationId: authority.operation_id,
        holderId: authority.holder_id,
      },
      rootCommands: root.map(({ command_id, spec_digest, state }) => ({
        commandId: command_id,
        specDigest: spec_digest,
        state,
      })),
      supervisorCommands: local.map(({ command_id, spec_digest, state }) => ({
        commandId: command_id,
        specDigest: spec_digest,
        state,
      })),
    };
    return { ...facts, evidenceDigest: digest(facts) };
  })();
}
export function requiredCapacityRoles(plan) {
  const map = {
    candidate: "api",
    "coordinator-handoff": "coordinator",
    "owner-candidate": "owner",
    web: "web",
  };
  invariant(Array.isArray(plan?.steps), "CAPACITY_RESERVATION_STEPS_UNKNOWN");
  return [
    ...new Set(plan.steps.map((step) => map[step.kind]).filter(Boolean)),
  ].sort();
}
/** One Supervisor-owned command receipt, not an external reservation service.
 * Physical residents stay charged across attempts. Role resource ceilings are
 * installed once from explicit configuration and cannot be raised by a caller. */
export function createAttemptCapacityReservations({
  sqlite,
  instanceId,
  templates,
  planPath,
  configPath,
  clock = Date.now,
  write = atomicJson,
  publicationLock,
  terminalProof,
}) {
  invariant(
    sqlite &&
      ID.test(instanceId) &&
      templates &&
      Object.keys(templates).length > 0 &&
      Object.keys(templates).every(
        (role) =>
          ROLES.includes(role) &&
          ID.test(templates[role].allocationId) &&
          templates[role].resources &&
          Object.keys(templates[role].resources).sort().join() ===
            templateKeys.sort().join(),
      ),
    "CAPACITY_TEMPLATES_REQUIRED",
  );
  const templateDigest = digest(templates);
  sqlite.exec(`CREATE TABLE IF NOT EXISTS supervisor_capacity_templates(instance_id TEXT PRIMARY KEY,templates TEXT NOT NULL,digest TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS supervisor_capacity_reservations(instance_id TEXT NOT NULL,attempt_id TEXT NOT NULL,operation_id TEXT NOT NULL,command_id TEXT NOT NULL,spec_digest TEXT NOT NULL,state TEXT NOT NULL,intent TEXT NOT NULL,receipt TEXT,PRIMARY KEY(instance_id,attempt_id));`);
  const old = sqlite
    .prepare("SELECT * FROM supervisor_capacity_templates WHERE instance_id=?")
    .get(instanceId);
  if (old)
    invariant(
      old.digest === templateDigest && old.templates === canonical(templates),
      "CAPACITY_TEMPLATES_CHANGED",
    );
  else
    sqlite
      .prepare("INSERT INTO supervisor_capacity_templates VALUES(?,?,?)")
      .run(instanceId, canonical(templates), templateDigest);
  function lookup(command) {
    const row = sqlite
      .prepare(
        "SELECT * FROM supervisor_capacity_reservations WHERE instance_id=? AND attempt_id=?",
      )
      .get(instanceId, command.operationId);
    if (!row) return null;
    invariant(
      row.operation_id === command.operationId &&
        row.command_id === command.commandId &&
        row.spec_digest === digest(command.spec),
      "CAPACITY_RESERVATION_COMMAND_CHANGED",
    );
    const intent = JSON.parse(row.intent);
    invariant(
      intent.intentDigest ===
        digest(
          Object.fromEntries(
            Object.entries(intent).filter(([key]) => key !== "intentDigest"),
          ),
        ),
      "CAPACITY_RESERVATION_CORRUPT",
    );
    return {
      row,
      intent,
      receipt: row.receipt ? JSON.parse(row.receipt) : null,
    };
  }
  async function publish(command, known) {
    const { intent } = known;
    if (known.row.state === "applied") return known.receipt;
    if (publicationLock) await publicationLock.acquire();
    try {
      for (const [path, oldDigest, next] of [
        [planPath, intent.oldPlanDigest, intent.nextPlan],
        [configPath, intent.oldConfigDigest, intent.nextConfig],
      ]) {
        const current = (await readSupervisorFact(path, 1048576)).value;
        invariant(
          [oldDigest, digest(next)].includes(digest(current)),
          "CAPACITY_RESERVATION_CAS_CHANGED",
        );
        if (digest(current) !== digest(next)) await write(path, next);
      }
      return intent.receipt;
    } finally {
      if (publicationLock) await publicationLock.release();
    }
  }
  async function prepare(command, snapshot, observation) {
    const prior = lookup(command);
    if (prior) return publish(command, prior);
    const spec = command.spec,
      request = spec.request;
    invariant(
      Object.keys(spec).sort().join() ===
        "budget,capacityPlanDigest,deadline,instanceId,kind,request,schemaVersion,sourceDigest" &&
        spec.schemaVersion === 1 &&
        request &&
        Object.keys(request).sort().join() ===
          "attemptId,packageDigest,planDigest,roles" &&
        ID.test(request.attemptId) &&
        DIGEST.test(request.planDigest) &&
        DIGEST.test(request.packageDigest) &&
        DIGEST.test(spec.capacityPlanDigest) &&
        DIGEST.test(spec.sourceDigest) &&
        Object.keys(spec.budget || {}).join() === "maxDurationMs" &&
        Number.isSafeInteger(spec.budget.maxDurationMs) &&
        spec.budget.maxDurationMs > 0 &&
        Number.isSafeInteger(spec.deadline),
      "CAPACITY_RESERVATION_SPEC_INVALID",
    );
    invariant(
      command.operationId === request.attemptId &&
        spec.kind === "capacity-reservation" &&
        spec.instanceId === instanceId &&
        spec.deadline > clock() &&
        snapshot?.attempt?.instanceId === instanceId &&
        snapshot.attempt.attemptId === request.attemptId &&
        snapshot.plan?.planDigest === request.planDigest &&
        snapshot.plan.package.digest === request.packageDigest &&
        canonical(request.roles) ===
          canonical(requiredCapacityRoles(snapshot.plan)),
      "CAPACITY_RESERVATION_SCOPE_CHANGED",
    );
    const [planFact, configFact] = await Promise.all([
        readSupervisorFact(planPath, 1048576),
        readSupervisorFact(configPath, 1048576),
      ]),
      plan = planFact.value,
      config = configFact.value;
    invariant(
      freezeCapacityBudget(plan).planDigest === spec.capacityPlanDigest &&
        plan.sourceDigest === spec.sourceDigest &&
        plan.instanceId === instanceId &&
        config.instanceId === instanceId &&
        config.sourceDigest === plan.sourceDigest,
      "CAPACITY_RESERVATION_BASE_CHANGED",
    );
    const next = structuredClone(plan),
      allocationIds = {},
      releasedReservations = [];
    // Templates remain frozen in the own database. Unassigned installation
    // placeholders do not reserve roles absent from this accepted package.
    for (const template of Object.values(templates)) {
      const original = next.allocations.candidate.find(
        (row) => row.id === template.allocationId,
      );
      if (original && !original.resident) {
        invariant(
          canonical(original.resources) === canonical(template.resources),
          "CAPACITY_TEMPLATE_CHANGED",
        );
        const assigned = sqlite
          .prepare(
            "SELECT 1 FROM control_commands WHERE instance_id=? AND json_extract(spec,'$.kind')='supervisor-start' AND json_extract(spec,'$.capacityAllocationId')=? LIMIT 1",
          )
          .get(instanceId, template.allocationId);
        if (!assigned)
          next.allocations.candidate = next.allocations.candidate.filter(
            (row) => row.id !== template.allocationId,
          );
      }
    }
    if (
      terminalProof &&
      observation?.known === true &&
      observation.exclusiveAccounting === true
    ) {
      const history = sqlite
        .prepare(
          "SELECT attempt_id,receipt FROM supervisor_capacity_reservations WHERE instance_id=? AND state='applied' AND attempt_id<>? ORDER BY rowid DESC LIMIT 128",
        )
        .all(instanceId, command.operationId);
      for (const old of history) {
        const receipt = JSON.parse(old.receipt);
        for (const [role, id] of Object.entries(receipt.allocationIds || {})) {
          const allocation = next.allocations.candidate.find(
            (row) => row.id === id,
          );
          if (!allocation || allocation.resident) continue;
          const proof = await terminalProof({
            command,
            attemptId: old.attempt_id,
            role,
            allocationId: id,
          });
          if (!proof) continue;
          invariant(
            proof.instanceId === instanceId &&
              proof.attempt.attempt_id === old.attempt_id &&
              proof.allocationId === id &&
              proof.role === role &&
              proof.evidenceDigest ===
                digest(
                  Object.fromEntries(
                    Object.entries(proof).filter(
                      ([key]) => key !== "evidenceDigest",
                    ),
                  ),
                ),
            "CAPACITY_RELEASE_PROOF_INVALID",
          );
          next.allocations.candidate = next.allocations.candidate.filter(
            (row) => row.id !== id,
          );
          releasedReservations.push(proof);
        }
      }
    }
    for (const role of request.roles) {
      const template = templates[role];
      invariant(template, "CAPACITY_ROLE_TEMPLATE_MISSING");
      const id =
        "attempt-" +
        digest({ instanceId, attemptId: request.attemptId, role }).slice(7);
      allocationIds[role] = id;
      invariant(
        !Object.values(next.allocations)
          .flat()
          .some((row) => row.id === id),
        "CAPACITY_RESERVATION_ID_CONFLICT",
      );
      next.allocations.candidate.push({
        id,
        resident: false,
        identityDigest: digest({
          instanceId,
          attemptId: request.attemptId,
          role,
          templateDigest,
        }),
        resources: structuredClone(template.resources),
      });
    }
    const nextPlan = freezeCapacityBudget(next),
      admission = evaluateCapacityAdmission({
        plan: nextPlan,
        observation,
        now: clock(),
      });
    if (!admission.qualified) {
      const receipt = {
        instanceId,
        attemptId: request.attemptId,
        operationId: command.operationId,
        commandId: command.commandId,
        specDigest: digest(spec),
        state: admission.state,
        qualified: false,
        reason: admission.reason,
        allocationIds: {},
        planDigest: plan.planDigest,
        sourceDigest: plan.sourceDigest,
        templateDigest,
        observationDigest: digest(observation),
        revision: observation?.revision,
        observedAt: observation?.observedAt,
      };
      const facts = {
          schemaVersion: 1,
          instanceId,
          attemptId: request.attemptId,
          oldPlanDigest: digest(plan),
          oldConfigDigest: digest(config),
          nextPlan: plan,
          nextConfig: config,
          receipt,
        },
        intent = { ...facts, intentDigest: digest(facts) };
      sqlite
        .prepare(
          "INSERT INTO supervisor_capacity_reservations VALUES(?,?,?,?,?,'applied',?,?)",
        )
        .run(
          instanceId,
          request.attemptId,
          command.operationId,
          command.commandId,
          digest(spec),
          canonical(intent),
          canonical(receipt),
        );
      return receipt;
    }
    const receipt = {
      instanceId,
      attemptId: request.attemptId,
      operationId: command.operationId,
      commandId: command.commandId,
      specDigest: digest(spec),
      allocationIds,
      planDigest: nextPlan.planDigest,
      sourceDigest: nextPlan.sourceDigest,
      templateDigest,
      state: "admitted",
      qualified: true,
    };
    const facts = {
        schemaVersion: 1,
        instanceId,
        attemptId: request.attemptId,
        oldPlanDigest: digest(plan),
        oldConfigDigest: digest(config),
        nextPlan,
        nextConfig: config,
        observationDigest: digest(observation),
        releasedReservations,
        receipt,
      },
      intent = { ...facts, intentDigest: digest(facts) };
    sqlite
      .prepare(
        "INSERT INTO supervisor_capacity_reservations VALUES(?,?,?,?,?,'pending',?,NULL)",
      )
      .run(
        instanceId,
        request.attemptId,
        command.operationId,
        command.commandId,
        digest(spec),
        canonical(intent),
      );
    return publish(command, lookup(command));
  }
  async function confirm(command, observation) {
    const known = lookup(command);
    invariant(known, "CAPACITY_RESERVATION_NOT_FOUND");
    if (known.row.state === "applied") return known.receipt;
    await publish(command, known);
    const plan = (await readSupervisorFact(planPath, 1048576)).value,
      config = (await readSupervisorFact(configPath, 1048576)).value;
    invariant(
      digest(plan) === digest(known.intent.nextPlan) &&
        digest(config) === digest(known.intent.nextConfig),
      "CAPACITY_RESERVATION_CAS_CHANGED",
    );
    const admitted = evaluateCapacityAdmission({
      plan,
      observation,
      now: clock(),
    });
    invariant(
      admitted.qualified,
      admitted.reason || "CAPACITY_RESERVATION_DEFERRED",
    );
    const receipt = {
      ...known.intent.receipt,
      observationDigest: digest(observation),
      revision: observation.revision,
      observedAt: observation.observedAt,
    };
    sqlite
      .prepare(
        "UPDATE supervisor_capacity_reservations SET state='applied',receipt=? WHERE instance_id=? AND attempt_id=? AND state='pending'",
      )
      .run(canonical(receipt), instanceId, command.operationId);
    return receipt;
  }
  return { lookup, prepare, confirm, publish, templateDigest };
}
