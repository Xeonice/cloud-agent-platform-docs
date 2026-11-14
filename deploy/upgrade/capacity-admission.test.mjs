import test from "node:test";
import assert from "node:assert/strict";
import { digest } from "./trust.mjs";
import {
  freezeCapacityBudget,
  evaluateCapacityAdmission,
} from "./capacity-admission.mjs";

const now = Date.parse("2026-10-20T10:00:00.000Z");
const vector = (
  memoryBytes,
  disks = {},
  cpuMilliCores = 100,
  ioBytesPerSecond = 100,
) => ({ memoryBytes, cpuMilliCores, ioBytesPerSecond, disks });

function fixture() {
  const item = (id, resident, memory, disks) => ({
    id,
    resident,
    identityDigest: digest(id),
    resources: vector(memory, disks),
  });
  const plan = freezeCapacityBudget({
    instanceId: "capacity-instance",
    sourceDigest: digest("actual-partial-source"),
    maxObservationAgeMs: 5000,
    limits: vector(
      1000,
      { data: 1000, artifacts: 1000, control: 500 },
      1000,
      1000,
    ),
    allocations: {
      source: [item("source-api-and-coordinator", true, 100, { data: 100 })],
      retainedOwners: [item("original-owner", true, 100, { data: 100 })],
      retainedGuests: [
        item("original-guest-exclusive-vmm", true, 100, { data: 100 }),
      ],
      existingCandidates: [
        item("failed-unrouted-candidate", true, 50, { artifacts: 100 }),
      ],
      candidate: [
        item("new-api-and-coordinator", false, 150, { artifacts: 500 }),
      ],
      verification: [
        item("full-tree-verification", false, 100, { artifacts: 100 }),
      ],
      control: [item("control-agent", true, 50, { control: 100 })],
      recovery: [item("recovery-reserve", false, 100, {})],
    },
  });
  const observation = {
    known: true,
    exclusiveAccounting: true,
    instanceId: plan.instanceId,
    sourceDigest: plan.sourceDigest,
    revision: 12,
    observedAt: new Date(now).toISOString(),
    limits: structuredClone(plan.limits),
    available: vector(
      600,
      { data: 700, artifacts: 900, control: 400 },
      500,
      500,
    ),
    residents: Object.values(plan.allocations)
      .flat()
      .filter((item) => item.resident)
      .map(({ id, identityDigest, resources }) => ({
        id,
        identityDigest,
        resources: structuredClone(resources),
      })),
  };
  return {
    plan,
    observation,
    run: (p = plan, o = observation) =>
      evaluateCapacityAdmission({ plan: p, observation: o, now }),
  };
}

test("freezes all retained and overlapping budgets without launching or mutating anything", () => {
  const f = fixture(),
    before = structuredClone({ plan: f.plan, observation: f.observation });
  const result = f.run();
  assert.equal(result.state, "admitted");
  assert.equal(result.requiredTotal.memoryBytes, 750);
  assert.equal(result.requiredAdditional.memoryBytes, 350);
  assert.equal(result.requiredTotal.disks.artifacts, 700);
  assert.equal(result.requiredAdditional.disks.artifacts, 600);
  assert.equal(result.revision, 12);
  assert.equal(result.observationDigest, digest(f.observation));
  assert.deepEqual(f.plan, before.plan);
  assert.deepEqual(f.observation, before.observation);
});

test("exact available boundary admits; a one-byte shortage defers before any candidate can launch", () => {
  const f = fixture();
  f.observation.available.memoryBytes = 350;
  assert.equal(f.run().qualified, true);
  f.observation.available.memoryBytes--;
  const result = f.run();
  assert.equal(result.qualified, false);
  assert.equal(result.state, "deferred");
  assert.deepEqual(result.shortages, [
    {
      boundary: "available",
      resource: "memoryBytes",
      required: 350,
      available: 349,
    },
  ]);
});

test("CPU, IO and the actual unpack filesystem each independently refuse an insufficient budget", async (t) => {
  for (const [name, change, resource] of [
    [
      "CPU",
      (state) => {
        state.available.cpuMilliCores = 299;
      },
      "cpuMilliCores",
    ],
    [
      "IO",
      (state) => {
        state.available.ioBytesPerSecond = 299;
      },
      "ioBytesPerSecond",
    ],
    [
      "artifact filesystem",
      (state) => {
        state.available.disks.artifacts = 599;
      },
      "disk:artifacts",
    ],
  ])
    await t.test(name, () => {
      const f = fixture();
      change(f.observation);
      const result = f.run();
      assert.equal(result.state, "deferred");
      assert.equal(result.shortages[0].resource, resource);
      assert.equal(result.shortages[0].boundary, "available");
    });
});

test("unknown CPU or IO is unknown, never a guessed default or a memory-only admission", () => {
  for (const name of ["cpuMilliCores", "ioBytesPerSecond"]) {
    const f = fixture();
    f.observation.available[name] = null;
    assert.equal(f.run().state, "unknown");
    assert.equal(f.run().reason, "CAPACITY_RESOURCE_UNKNOWN");
  }
});

test("a retained candidate added or reincarnated after the frozen source requires fresh planning", () => {
  const f = fixture();
  f.observation.residents.push({
    id: "second-failed-candidate",
    identityDigest: digest("second"),
    resources: vector(50),
  });
  assert.equal(f.run().reason, "CAPACITY_RESIDENT_INVENTORY_CHANGED");
  f.observation.residents.pop();
  f.observation.residents.find(
    (item) => item.id === "failed-unrouted-candidate",
  ).identityDigest = digest("new-birth");
  assert.equal(f.run().reason, "CAPACITY_RESIDENT_INVENTORY_CHANGED");
});

test("resident growth and unused peak headroom are included instead of crediting the whole resident budget as free", () => {
  const f = fixture();
  f.observation.residents[0].resources.memoryBytes = 80;
  f.observation.available.memoryBytes = 369;
  assert.equal(f.run().requiredAdditional.memoryBytes, 370);
  assert.equal(f.run().state, "deferred");
  f.observation.residents[0].resources.memoryBytes = 101;
  assert.equal(f.run().reason, "CAPACITY_RESIDENT_BUDGET_EXCEEDED");
});

test("non-CPU resident overruns name only the allocation and exact numeric resource boundaries", async (t) => {
  for (const resource of ["memoryBytes", "ioBytesPerSecond", "disk:data"])
    await t.test(resource, () => {
      const f = fixture(), resident = f.observation.residents[0];
      assert.equal(f.run().qualified, true);
      const available = resource === "disk:data"
        ? resident.resources.disks.data++
        : resident.resources[resource]++;
      const before = structuredClone({ plan: f.plan, observation: f.observation });
      const result = f.run();
      assert.deepEqual(result, {
        qualified: false,
        state: "deferred",
        reason: "CAPACITY_RESIDENT_BUDGET_EXCEEDED",
        allocationId: resident.id,
        overruns: [{ resource, required: available + 1, available }],
      });
      assert.deepEqual({ plan: f.plan, observation: f.observation }, before);
    });
});

// Recorded F7 CPU reservations and the failed handoff's exclusive CPU readings.
// Other resource dimensions are zero here so these cases isolate CPU admission.
function f7CpuFixture(limit = 11750) {
  const item = (id, cpu, resident = false) => ({
    id,
    resident,
    identityDigest: digest(id),
    resources: vector(0, {}, cpu, 0),
  });
  const plan = freezeCapacityBudget({
    instanceId: "capacity-f7-cpu",
    sourceDigest: digest("recorded-f7-handoff-cpu"),
    maxObservationAgeMs: 5000,
    limits: vector(0, {}, limit, 0),
    allocations: {
      source: [
        item("legacy-coordinator", 500),
        item("legacy-controller", 250),
        item("source-other", 100, true),
      ],
      retainedOwners: [item("retained-owner-runtime", 1500, true)],
      retainedGuests: [],
      existingCandidates: [],
      candidate: [
        item("migration-api", 150, true),
        item("migration-coordinator", 350, true),
        item("future-owner-template", 2500),
        item("future-web-template", 150),
      ],
      verification: [],
      control: [
        item("host-overhead", 1900, true),
        item("migration-control-agent", 200, true),
        item("migration-control-entry", 50, true),
        item("migration-control-supervisor", 500, true),
      ],
      recovery: [
        item("recovery-reserve", 250),
        item("pending-original-guest-recovery", 2000),
      ],
    },
  });
  const measured = {
    "source-other": 0,
    "retained-owner-runtime": 1,
    "migration-api": 0,
    "migration-coordinator": 363,
    "host-overhead": 513,
    "migration-control-agent": 47,
    "migration-control-entry": 0,
    "migration-control-supervisor": 0,
  };
  const observation = {
    known: true,
    exclusiveAccounting: true,
    instanceId: plan.instanceId,
    sourceDigest: plan.sourceDigest,
    revision: 1,
    observedAt: new Date(now).toISOString(),
    limits: structuredClone(plan.limits),
    available: vector(0, {}, limit - 924, 0),
    residents: Object.values(plan.allocations)
      .flat()
      .filter((r) => r.resident)
      .map(({ id, identityDigest }) => ({
        id,
        identityDigest,
        resources: vector(0, {}, measured[id], 0),
      })),
  };
  return {
    plan,
    observation,
    run: () => evaluateCapacityAdmission({ plan, observation, now }),
  };
}

test("recorded F7 CPU 363/350 consumes 13m of unallocated headroom without changing the frozen plan or readings", () => {
  const f = f7CpuFixture();
  const before = structuredClone({ plan: f.plan, observation: f.observation });
  const result = f.run();
  assert.equal(result.qualified, true);
  assert.equal(result.requiredTotal.cpuMilliCores, 10413);
  assert.equal(result.requiredAdditional.cpuMilliCores, 9489);
  assert.equal(result.observationDigest, digest(f.observation));
  assert.deepEqual(result.shortages, []);
  assert.equal(
    f.observation.residents.find((r) => r.id === "migration-coordinator")
      .resources.cpuMilliCores,
    363,
  );
  assert.deepEqual({ plan: f.plan, observation: f.observation }, before);
});

test("effective CPU total admits at the exact frozen boundary and refuses one millicore less", () => {
  const exact = f7CpuFixture(10413);
  assert.equal(exact.run().qualified, true);
  const result = f7CpuFixture(10412).run();
  assert.equal(result.reason, "CAPACITY_BUDGET_INSUFFICIENT");
  assert.deepEqual(result.shortages, [
    { resource: "cpuMilliCores", required: 10413, available: 10412, boundary: "total" },
    { resource: "cpuMilliCores", required: 9489, available: 9488, boundary: "available" },
  ]);
});

test("observed available CPU still limits admission independently of the frozen total", () => {
  const f = f7CpuFixture();
  f.observation.available.cpuMilliCores = 9489;
  assert.equal(f.run().qualified, true);
  f.observation.available.cpuMilliCores--;
  const result = f.run();
  assert.equal(result.reason, "CAPACITY_BUDGET_INSUFFICIENT");
  assert.deepEqual(result.shortages, [
    { resource: "cpuMilliCores", required: 9489, available: 9488, boundary: "available" },
  ]);
});

test("CPU growth cannot borrow a protected Owner's unused reservation", () => {
  const f = f7CpuFixture();
  f.observation.residents.find((r) => r.id === "retained-owner-runtime")
    .resources.cpuMilliCores = 0;
  f.observation.residents.find((r) => r.id === "migration-coordinator")
    .resources.cpuMilliCores = 1701;
  const measured = f.observation.residents.reduce(
    (sum, r) => sum + r.resources.cpuMilliCores, 0,
  );
  f.observation.available.cpuMilliCores = f.plan.limits.cpuMilliCores - measured;
  const result = f.run();
  assert.equal(result.reason, "CAPACITY_BUDGET_INSUFFICIENT");
  assert.equal(result.requiredTotal.cpuMilliCores, 11751);
  assert.ok(result.shortages.some((r) =>
    r.boundary === "total" && r.resource === "cpuMilliCores" && r.required === 11751));
  assert.equal(f.plan.allocations.retainedOwners[0].resources.cpuMilliCores, 1500);
  assert.equal(f.plan.allocations.candidate.find((r) => r.id === "future-owner-template")
    .resources.cpuMilliCores, 2500);
});

test("each resident CPU overage is counted, including API, Agent, Entry and Supervisor", () => {
  const f = f7CpuFixture();
  const allocations = Object.values(f.plan.allocations).flat();
  for (const resident of f.observation.residents) {
    const budget = allocations.find((r) => r.id === resident.id);
    resident.resources.cpuMilliCores = budget.resources.cpuMilliCores + 1;
  }
  const measured = f.observation.residents.reduce(
    (sum, r) => sum + r.resources.cpuMilliCores, 0,
  );
  f.observation.available.cpuMilliCores = f.plan.limits.cpuMilliCores - measured;
  const result = f.run();
  assert.equal(result.qualified, true);
  assert.equal(result.requiredTotal.cpuMilliCores, 10400 + f.observation.residents.length);
  assert.equal(result.requiredAdditional.cpuMilliCores, 5650);
});

test("a frozen total peak over the effective limit is reported in addition to free headroom shortages", () => {
  const f = fixture(),
    input = structuredClone(f.plan);
  input.limits.memoryBytes = 749;
  const plan = freezeCapacityBudget(input);
  f.observation.limits = structuredClone(plan.limits);
  f.observation.available.memoryBytes = 349;
  const result = f.run(plan);
  assert.equal(result.state, "deferred");
  assert.ok(
    result.shortages.some(
      (row) => row.boundary === "total" && row.resource === "memoryBytes",
    ),
  );
});

test("wrong source, stale or future observations, changed limits and overlapping accounting never admit", () => {
  for (const [change, reason] of [
    [
      (o) => {
        o.sourceDigest = digest("other-source");
      },
      "CAPACITY_OBSERVATION_UNKNOWN",
    ],
    [
      (o) => {
        o.observedAt = new Date(now - 5001).toISOString();
      },
      "CAPACITY_OBSERVATION_STALE",
    ],
    [
      (o) => {
        o.observedAt = new Date(now + 1).toISOString();
      },
      "CAPACITY_OBSERVATION_STALE",
    ],
    [
      (o) => {
        o.limits.memoryBytes++;
      },
      "CAPACITY_LIMITS_CHANGED",
    ],
    [
      (o) => {
        o.exclusiveAccounting = false;
      },
      "CAPACITY_OBSERVATION_UNKNOWN",
    ],
    [
      (o) => {
        o.available.memoryBytes = 601;
      },
      "CAPACITY_RESOURCE_INCONSISTENT",
    ],
  ]) {
    const f = fixture();
    change(f.observation);
    assert.equal(f.run().reason, reason);
    assert.equal(f.run().qualified, false);
  }
});

test("resource vectors cannot substitute another filesystem or silently omit a category", () => {
  const f = fixture(),
    input = structuredClone(f.plan);
  input.allocations.candidate[0].resources.disks = { unknownFilesystem: 500 };
  assert.equal(f.run(freezeCapacityBudget(input)).state, "unknown");
  delete input.allocations.recovery;
  assert.throws(() => freezeCapacityBudget(input), {
    code: "CAPACITY_PLAN_INVALID",
  });
});

test("tampered plans, malformed inventory and unsafe arithmetic are not admitted", () => {
  const f = fixture();
  const tampered = structuredClone(f.plan);
  tampered.allocations.recovery[0].resources.memoryBytes = 0;
  assert.equal(f.run(tampered).reason, "CAPACITY_PLAN_INVALID");
  f.observation.residents.push(structuredClone(f.observation.residents[0]));
  assert.equal(f.run().reason, "CAPACITY_RESIDENT_INVENTORY_UNKNOWN");
  const big = structuredClone(f.plan);
  big.allocations.candidate[0].resources.memoryBytes = Number.MAX_SAFE_INTEGER;
  big.allocations.recovery[0].resources.memoryBytes = Number.MAX_SAFE_INTEGER;
  f.observation.residents.pop();
  assert.equal(f.run(freezeCapacityBudget(big)).state, "unknown");
});

test("a proven stopped source keeps its full peak reservation as additional capacity; protected residents cannot be declared stopped", () => {
  const f = fixture(),
    input = structuredClone(f.plan);
  input.allocations.source[0].resident = false;
  const plan = freezeCapacityBudget(input);
  f.observation.residents = f.observation.residents.filter(
    (x) => x.id !== input.allocations.source[0].id,
  );
  const value = f.run(plan);
  assert.equal(value.requiredTotal.memoryBytes, 750);
  assert.equal(value.requiredAdditional.memoryBytes, 450);
  assert.equal(plan.sourceDigest, f.plan.sourceDigest);
  f.observation.available.memoryBytes = 449;
  assert.equal(f.run(plan).state, "deferred");
  for (const category of [
    "retainedOwners",
    "retainedGuests",
    "existingCandidates",
  ]) {
    const bad = structuredClone(f.plan);
    bad.allocations[category][0].resident = false;
    assert.throws(() => freezeCapacityBudget(bad), {
      code: "CAPACITY_PLAN_INVALID",
    });
  }
});
