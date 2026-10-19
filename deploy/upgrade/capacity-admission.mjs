import { canonical, digest } from "./trust.mjs";

const CATEGORIES = [
  "source",
  "retainedOwners",
  "retainedGuests",
  "existingCandidates",
  "candidate",
  "verification",
  "control",
  "recovery",
];
const SCALARS = ["memoryBytes", "cpuMilliCores", "ioBytesPerSecond"];
const ID = /^[a-zA-Z0-9._:-]{1,200}$/;
const HASH = /^sha256:[a-f0-9]{64}$/;
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const object = (value) =>
  value && Object.getPrototypeOf(value) === Object.prototype;
const sameKeys = (value, keys) =>
  object(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const clone = (value) => structuredClone(value);

function resources(value) {
  if (
    !sameKeys(value, [...SCALARS, "disks"]) ||
    !SCALARS.every((key) => integer(value[key])) ||
    !object(value.disks)
  )
    return false;
  return Object.entries(value.disks).every(
    ([id, bytes]) => ID.test(id) && integer(bytes),
  );
}

function validPlan(plan) {
  if (
    !sameKeys(plan, [
      "schemaVersion",
      "instanceId",
      "sourceDigest",
      "maxObservationAgeMs",
      "limits",
      "allocations",
      "planDigest",
    ])
  )
    return false;
  if (
    plan.schemaVersion !== 1 ||
    !ID.test(plan.instanceId) ||
    !HASH.test(plan.sourceDigest) ||
    !integer(plan.maxObservationAgeMs) ||
    plan.maxObservationAgeMs === 0 ||
    !resources(plan.limits) ||
    !sameKeys(plan.allocations, CATEGORIES)
  )
    return false;
  const ids = new Set();
  for (const category of CATEGORIES) {
    if (!Array.isArray(plan.allocations[category])) return false;
    for (const item of plan.allocations[category]) {
      if (
        !sameKeys(item, ["id", "identityDigest", "resident", "resources"]) ||
        !ID.test(item.id) ||
        ids.has(item.id) ||
        !HASH.test(item.identityDigest) ||
        typeof item.resident !== "boolean" ||
        !resources(item.resources)
      )
        return false;
      // Each resident must be a disjoint accounting unit. The collector must not
      // count a parent cgroup and its Guest/child memory as separate usage.
      if (
        ["retainedOwners", "retainedGuests", "existingCandidates"].includes(
          category,
        ) &&
        !item.resident
      )
        return false;
      ids.add(item.id);
    }
  }
  if (
    !["source", "control", "recovery"].every(
      (category) => plan.allocations[category].length > 0,
    )
  )
    return false;
  const { planDigest, ...facts } = plan;
  return HASH.test(planDigest) && digest(facts) === planDigest;
}

/** Freeze declared, explicit resource budgets; there are no inferred defaults. */
export function freezeCapacityBudget(input) {
  const facts = clone({ schemaVersion: 1, ...input });
  delete facts.planDigest;
  const plan = { ...facts, planDigest: digest(facts) };
  if (!validPlan(plan))
    throw Object.assign(new Error("CAPACITY_PLAN_INVALID"), {
      code: "CAPACITY_PLAN_INVALID",
    });
  return clone(plan);
}

function zero(disks) {
  return {
    memoryBytes: 0,
    cpuMilliCores: 0,
    ioBytesPerSecond: 0,
    disks: Object.fromEntries(Object.keys(disks).map((id) => [id, 0])),
  };
}

function entries(value) {
  return [
    ...SCALARS.map((key) => [key, value[key]]),
    ...Object.entries(value.disks).map(([id, bytes]) => ["disk:" + id, bytes]),
  ];
}

function accumulate(target, value, previous) {
  if (Object.keys(value.disks).some((id) => !Object.hasOwn(target.disks, id)))
    return false;
  for (const key of SCALARS) {
    target[key] += Math.max(0, value[key] - (previous?.[key] ?? 0));
    if (!integer(target[key])) return false;
  }
  for (const [id, bytes] of Object.entries(value.disks)) {
    target.disks[id] += Math.max(0, bytes - (previous?.disks[id] ?? 0));
    if (!integer(target.disks[id])) return false;
  }
  return true;
}

function exceeds(required, available) {
  const limits = new Map(entries(available));
  return entries(required)
    .filter(([key, amount]) => !limits.has(key) || amount > limits.get(key))
    .map(([resource, requiredValue]) => ({
      resource,
      required: requiredValue,
      available: limits.get(resource) ?? null,
    }));
}

/**
 * Pure admission. `limits` are the effective, frozen instance/VM/cgroup budget;
 * `available` is the concurrently observed free capacity in the same units and
 * filesystem identities. `residents.resources` is measured exclusive usage.
 * Unknown CPU/IO availability must stay unknown, not become a guessed constant.
 * The caller owns a reservation/CAS boundary before launching any role.
 */
export function evaluateCapacityAdmission({
  plan,
  observation,
  now = Date.now(),
}) {
  const result = (state, reason, details = {}) => ({
    qualified: state === "admitted",
    state,
    reason,
    ...details,
  });
  try {
    if (!validPlan(plan)) return result("unknown", "CAPACITY_PLAN_INVALID");
    if (
      !object(observation) ||
      observation.known !== true ||
      observation.exclusiveAccounting !== true ||
      observation.instanceId !== plan.instanceId ||
      observation.sourceDigest !== plan.sourceDigest ||
      !integer(observation.revision)
    )
      return result("unknown", "CAPACITY_OBSERVATION_UNKNOWN");
    const age = now - Date.parse(observation.observedAt);
    if (
      !Number.isFinite(now) ||
      !Number.isFinite(age) ||
      age < 0 ||
      age > plan.maxObservationAgeMs
    )
      return result("unknown", "CAPACITY_OBSERVATION_STALE");
    if (!resources(observation.limits) || !resources(observation.available))
      return result("unknown", "CAPACITY_RESOURCE_UNKNOWN");
    if (canonical(observation.limits) !== canonical(plan.limits))
      return result("deferred", "CAPACITY_LIMITS_CHANGED");
    if (
      exceeds(observation.available, observation.limits).length ||
      Object.keys(observation.available.disks).sort().join() !==
        Object.keys(plan.limits.disks).sort().join()
    )
      return result("unknown", "CAPACITY_RESOURCE_INCONSISTENT");
    const allocations = CATEGORIES.flatMap(
      (category) => plan.allocations[category],
    );
    const expected = allocations.filter((item) => item.resident);
    if (!Array.isArray(observation.residents))
      return result("unknown", "CAPACITY_RESIDENT_INVENTORY_UNKNOWN");
    const actual = new Map();
    for (const item of observation.residents) {
      if (
        !sameKeys(item, ["id", "identityDigest", "resources"]) ||
        !ID.test(item.id) ||
        !HASH.test(item.identityDigest) ||
        !resources(item.resources) ||
        actual.has(item.id)
      )
        return result("unknown", "CAPACITY_RESIDENT_INVENTORY_UNKNOWN");
      actual.set(item.id, item);
    }
    if (
      actual.size !== expected.length ||
      expected.some(
        (item) => actual.get(item.id)?.identityDigest !== item.identityDigest,
      )
    )
      return result("deferred", "CAPACITY_RESIDENT_INVENTORY_CHANGED");
    const total = zero(plan.limits.disks),
      additional = zero(plan.limits.disks),
      measured = zero(plan.limits.disks);
    for (const item of allocations) {
      const resident = actual.get(item.id);
      if (
        resident &&
        (exceeds(resident.resources, item.resources).length ||
          !accumulate(measured, resident.resources))
      )
        return result("deferred", "CAPACITY_RESIDENT_BUDGET_EXCEEDED", {
          allocationId: item.id,
        });
      if (
        !accumulate(total, item.resources) ||
        !accumulate(additional, item.resources, resident?.resources)
      )
        return result("unknown", "CAPACITY_ACCOUNTING_UNKNOWN");
    }
    const measuredWithFree = clone(measured);
    if (
      !accumulate(measuredWithFree, observation.available) ||
      exceeds(measuredWithFree, plan.limits).length
    )
      return result("unknown", "CAPACITY_RESOURCE_INCONSISTENT");
    const shortages = [
      ...exceeds(total, plan.limits).map((row) => ({
        ...row,
        boundary: "total",
      })),
      ...exceeds(additional, observation.available).map((row) => ({
        ...row,
        boundary: "available",
      })),
    ];
    const proof = {
      planDigest: plan.planDigest,
      sourceDigest: plan.sourceDigest,
      revision: observation.revision,
      observedAt: observation.observedAt,
      requiredTotal: total,
      requiredAdditional: additional,
      shortages,
    };
    if (shortages.length)
      return result("deferred", "CAPACITY_BUDGET_INSUFFICIENT", proof);
    return result("admitted", null, {
      ...proof,
      observationDigest: digest(observation),
    });
  } catch {
    return result("unknown", "CAPACITY_ACCOUNTING_UNKNOWN");
  }
}
