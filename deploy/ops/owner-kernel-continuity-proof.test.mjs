import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digest } from "../upgrade/trust.mjs";
import {
  OWNER_PROC_COLLECTOR,
  OWNER_PROC_ARGV,
  collectOwnerKernelContinuityProof,
  compareOwnerKernelContinuityProof,
  parseOwnerProcSnapshot,
  validateOwnerKernelContinuityProof,
} from "./owner-kernel-continuity-proof.mjs";

const run = promisify(execFile);
const instanceId = "test-instance";
const instanceRoot = "/var/lib/instances/test-instance";
const boot = "b6ac8ffb-f862-460b-a96d-2579d684c279";
const sha = (c) => "sha256:" + c.repeat(64);
const clone = (v) => structuredClone(v);
const processes = () => [
  { pid: 1, ppid: 0, startTicks: "100", comm: "node", livenessClass: "live" },
  { pid: 10, ppid: 1, startTicks: "123", comm: "bwrap", livenessClass: "live" },
  {
    pid: 11,
    ppid: 10,
    startTicks: "125",
    comm: "libkrun (vmm)",
    livenessClass: "live",
  },
  { pid: 999, ppid: 0, startTicks: "900", comm: "sh", livenessClass: "live" },
  {
    pid: 1000,
    ppid: 999,
    startTicks: "901",
    comm: "read-helper",
    livenessClass: "live",
  },
];
function procText(change = () => {}) {
  let out = "";
  for (let round = 1; round <= 2; round++) {
    const rows = processes();
    change(rows, round);
    out += `H\t${round}\t${boot}\t999\n`;
    for (const p of rows)
      out += `P\t${round}\t${p.pid}\t${p.ppid}\t${p.startTicks}\t${p.comm}\t${p.livenessClass}\n`;
    out += `E\t${round}\t${rows.length}\n`;
  }
  return out;
}
const owner = (n = 1) => ({
  ownerId: `owner-${n}`,
  ownerHome: `${instanceRoot}/owner-${n}`,
  containerId: n.toString(16).padStart(64, "0"),
  artifactDigest: sha("a"),
  inputFingerprint: sha("b"),
  startIdentity: `owner-start-${n}`,
});
const inspection = (row) => ({
  containerId: row.containerId,
  image: sha("c"),
  instanceId,
  role: "runtime-owner",
  startIdentity: row.startIdentity,
  state: {
    status: "running",
    running: true,
    pid: 400 + Number.parseInt(row.containerId, 16),
    startedAt: "2026-11-07T14:00:00.000Z",
    restartCount: 0,
    oomKilled: false,
    dead: false,
    restarting: false,
  },
  mounts: [
    {
      type: "bind",
      source: row.ownerHome,
      destination: row.ownerHome,
      rw: true,
    },
  ],
});
const assignments = () => [
  {
    sandboxId: "historical-orphan",
    provider: "boxlite",
    providerSandboxId: "private-box-id-must-never-escape",
    state: "owned",
  },
];
function fixture({ count = 1, onInspect, onAssignments, onProc } = {}) {
  const ownerRows = Array.from({ length: count }, (_, i) => owner(i + 1));
  const calls = [],
    inspectCounts = new Map(),
    assignmentCounts = new Map();
  let active = 0,
    maxActive = 0;
  const call = async (kind, id, work) => {
    calls.push([kind, id]);
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setImmediate(resolve));
    try {
      return work();
    } finally {
      active--;
    }
  };
  const transport = {
    inspectOwner: (id, options) =>
      call("inspect", id, () => {
        assert.equal(options.timeoutMs, 5000);
        assert.ok(options.signal instanceof AbortSignal);
        const row = ownerRows.find((r) => r.containerId === id),
          value = inspection(row);
        const n = (inspectCounts.get(id) ?? 0) + 1;
        inspectCounts.set(id, n);
        onInspect?.(value, n);
        return value;
      }),
    readAssignments: (row) =>
      call("assignments", row.containerId, () => {
        const value = assignments(),
          n = (assignmentCounts.get(row.ownerId) ?? 0) + 1;
        assignmentCounts.set(row.ownerId, n);
        onAssignments?.(value, n);
        return value;
      }),
    readOwnerProc: (id, options) =>
      call("proc", id, () => {
        assert.equal(options.script, OWNER_PROC_COLLECTOR);
        assert.equal(options.argv, OWNER_PROC_ARGV);
        assert.equal(options.maxBytes, 1024 * 1024);
        const value = { exitCode: 0, stdout: procText() };
        onProc?.(value);
        return value;
      }),
  };
  return { ownerRows, transport, calls, maxActive: () => maxActive };
}
const collect = (f, rest = {}) =>
  collectOwnerKernelContinuityProof({
    instanceId,
    instanceRoot,
    ownerRows: f.ownerRows,
    transport: f.transport,
    ...rest,
  });

test("fixed shell collector parses actual stat syntax and excludes only its own process tree", async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), "owner-proc-proof-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(join(root, "sys/kernel/random"), { recursive: true });
  await fs.writeFile(join(root, "sys/kernel/random/boot_id"), boot + "\n");
  for (const p of processes()) {
    await fs.mkdir(join(root, String(p.pid)));
    const tail = ["S", p.ppid, ...Array(17).fill(0), p.startTicks].join(" ");
    await fs.writeFile(
      join(root, String(p.pid), "stat"),
      `${p.pid} (${p.comm}) ${tail}\n`,
    );
  }
  // Only the test fixture changes the fixed /proc root and its synthetic self PID.
  // The production API has no path/script override.
  const script = OWNER_PROC_COLLECTOR.replaceAll(
    "/proc/",
    root + "/",
  ).replaceAll('"$$"', '"999"');
  const { stdout } = await run("/bin/sh", ["-c", script], { timeout: 5000 });
  assert.deepEqual(parseOwnerProcSnapshot(stdout), {
    bootId: boot,
    processes: processes().slice(0, 3),
  });
});

test("eight Owners include the historical orphan and VMM births without exposing provider IDs", async () => {
  const f = fixture({ count: 8 });
  const before = await collect(f),
    after = await collect(f);
  assert.equal(f.maxActive(), 2);
  assert.equal(before.rows.length, 8);
  assert.equal(f.calls.filter(([kind]) => kind === "proc").length, 16);
  for (const row of before.rows) {
    assert.equal(row.assignmentsCount, 1);
    assert.deepEqual(row.processes, processes().slice(0, 3));
  }
  assert.equal(
    JSON.stringify(before).includes("private-box-id-must-never-escape"),
    false,
  );
  assert.equal(before.stableDigest, digest(before.rows));
  assert.deepEqual(compareOwnerKernelContinuityProof(before, after), {
    proofMode: "owner-kernel-process-continuity",
    ownerKernelContinuityQualified: true,
    preservedOwners: 8,
    stableDigest: before.stableDigest,
    guestProcessContinuityQualified: false,
    businessQualityQualified: false,
    sdkCalls: 0,
    guestExecCalls: 0,
  });
});

for (const [name, mutate] of [
  [
    "container replacement",
    (v) => {
      v.containerId = "f".repeat(64);
    },
  ],
  [
    "wrong instance",
    (v) => {
      v.instanceId = "other";
    },
  ],
  [
    "wrong role",
    (v) => {
      v.role = "api";
    },
  ],
  [
    "stopped Owner",
    (v) => {
      v.state.running = false;
    },
  ],
  [
    "OOM",
    (v) => {
      v.state.oomKilled = true;
    },
  ],
  [
    "Owner host PID reused",
    (v) => {
      v.state.pid++;
    },
  ],
  [
    "restart",
    (v) => {
      v.state.restartCount++;
    },
  ],
  [
    "mount mutation",
    (v) => {
      v.mounts[0].rw = false;
    },
  ],
])
  test(`collection holds on ${name} between the two inspections`, async () => {
    const f = fixture({
      onInspect: (v, n) => {
        if (n === 2) mutate(v);
      },
    });
    await assert.rejects(collect(f), /OWNER_/);
  });

test("assignment drift is HOLD, including a retained resource absent from the business DB", async () => {
  const f = fixture({
    onAssignments: (v, n) => {
      if (n === 2) v[0].state = "destroyed";
    },
  });
  await assert.rejects(collect(f), /OWNER_ASSIGNMENTS_CHANGED_DURING_CAPTURE/);
});

test("unconfirmed or unknown assignment state never receives continuity qualification", async () => {
  for (const state of ["unconfirmed", "unknown"]) {
    await assert.rejects(
      collect(
        fixture({
          onAssignments: (rows) => {
            rows[0].state = state;
          },
        }),
      ),
      /OWNER_ASSIGNMENT_INVALID/,
    );
  }
});

test("an unrelated mount, RO home or nested overmount cannot prove the Owner home", async () => {
  for (const mutate of [
    (v) => {
      v.mounts[0].destination = "/unrelated";
    },
    (v) => {
      v.mounts[0].source = "/other-source";
    },
    (v) => {
      v.mounts[0].rw = false;
    },
    (v) => {
      v.mounts.push({
        type: "bind",
        source: "/other",
        destination: v.mounts[0].destination + "/boxlite",
        rw: true,
      });
    },
  ])
    await assert.rejects(
      collect(fixture({ onInspect: mutate })),
      /OWNER_HOME_BIND_UNPROVEN/,
    );
});

test("two proc scans reject PID reuse, disappeared VMMs and unrelated processes", () => {
  assert.throws(
    () =>
      parseOwnerProcSnapshot(
        procText((rows, round) => {
          if (round === 2) rows[2].startTicks = "999";
        }),
      ),
    /CHANGED_DURING_SCAN/,
  );
  assert.throws(
    () =>
      parseOwnerProcSnapshot(
        procText((rows, round) => {
          if (round === 2) rows.splice(2, 1);
        }),
      ),
    /CHANGED_DURING_SCAN/,
  );
  assert.throws(
    () =>
      parseOwnerProcSnapshot(
        procText((rows) => {
          rows[2].ppid = 0;
        }),
      ),
    /UNROOTED_PROCESS/,
  );
  assert.throws(
    () => parseOwnerProcSnapshot(procText().replace("E\t2\t5\n", "")),
    /SCAN_INCOMPLETE/,
  );
  assert.throws(
    () => parseOwnerProcSnapshot("x".repeat(1024 * 1024 + 1)),
    /OUTPUT_INVALID/,
  );
});

for (const [name, mutate] of [
  [
    "new Owner",
    (p) => {
      const row = clone(p.rows[0]);
      row.ownerId = "owner-2";
      row.containerId = "2".repeat(64);
      p.rows.push(row);
    },
  ],
  [
    "lost Owner",
    (p) => {
      p.rows.pop();
    },
  ],
  [
    "kernel reboot",
    (p) => {
      p.rows[0].bootId = "c6ac8ffb-f862-460b-a96d-2579d684c279";
    },
  ],
  [
    "VMM birth change",
    (p) => {
      p.rows[0].processes[2].startTicks = "126";
    },
  ],
  [
    "assignment digest change",
    (p) => {
      p.rows[0].assignmentsDigest = sha("d");
    },
  ],
  [
    "wrong scope",
    (p) => {
      p.instanceId = "other-instance";
    },
  ],
])
  test(`comparison cannot authorize ${name}`, async () => {
    const before = await collect(fixture()),
      after = clone(before);
    mutate(after);
    after.stableDigest = digest(after.rows);
    assert.throws(
      () => compareOwnerKernelContinuityProof(before, after),
      /OWNER_/,
    );
  });

test("proof validator rejects missing coverage, private fields and false Guest claims", async () => {
  const proof = await collect(fixture());
  for (const mutate of [
    (p) => {
      p.guestProcessContinuityQualified = true;
    },
    (p) => {
      p.sdkCalls = 1;
    },
    (p) => {
      p.rows[0].providerSandboxId = "private";
    },
    (p) => {
      p.rows[0].processes.shift();
    },
    (p) => {
      p.rows[0].processes[2].ppid = 11;
    },
    (p) => {
      p.stableDigest = sha("e");
    },
  ]) {
    const value = clone(proof);
    mutate(value);
    assert.throws(() => validateOwnerKernelContinuityProof(value), /OWNER_/);
  }
});

test("unknown transport failure and original timeout never replay a call", async () => {
  const f = fixture();
  let calls = 0,
    signal;
  f.transport.inspectOwner = async (_, options) => {
    calls++;
    signal = options.signal;
    return new Promise(() => {});
  };
  await assert.rejects(
    collect(f, { timeoutMs: 15 }),
    /OWNER_PROOF_CALL_TIMEOUT/,
  );
  assert.equal(calls, 1);
  assert.equal(signal.aborted, true);
  assert.equal(f.calls.length, 0);
  const unknown = fixture();
  let n = 0;
  unknown.transport.readOwnerProc = async () => {
    n++;
    throw new Error("transport result unknown");
  };
  await assert.rejects(collect(unknown), /transport result unknown/);
  assert.equal(n, 1);
});

test("one HOLD stops later dispatch and settles the other bounded read", async () => {
  const f = fixture({ count: 8 });
  let inspected = 0,
    active = 0;
  f.transport.inspectOwner = async () => {
    const n = ++inspected;
    active++;
    await new Promise((resolve) => setImmediate(resolve));
    active--;
    if (n === 1) throw new Error("first read unknown");
    return inspection(f.ownerRows[1]);
  };
  await assert.rejects(collect(f), /first read unknown/);
  assert.equal(inspected, 2);
  assert.equal(active, 0);
  assert.equal(f.calls.length, 0);
});

test("input scope, concurrency, metadata leakage and failed collector all hold", async () => {
  const f = fixture();
  f.ownerRows[0].ownerHome = "/other-owner";
  await assert.rejects(collect(f), /OWNER_INPUT_INVALID/);
  assert.equal(f.calls.length, 0);
  await assert.rejects(
    collect(fixture(), { concurrency: 3 }),
    /OPTIONS_INVALID/,
  );
  await assert.rejects(
    collect(
      fixture({
        onInspect: (v) => {
          v.Env = ["secret"];
        },
      }),
    ),
    /INSPECT_FIELDS/,
  );
  await assert.rejects(
    collect(
      fixture({
        onProc: (v) => {
          v.exitCode = 76;
        },
      }),
    ),
    /PROC_EXEC_FAILED/,
  );
});

test("historical zombie identity is retained in complete Owner proofs and compared exactly", async () => {
  const zombie = {
    pid: 78,
    ppid: 1,
    startTicks: "180",
    comm: "node",
    livenessClass: "zombie",
  };
  const f = fixture({
    onProc(v) {
      v.stdout = procText((rows) => rows.push({ ...zombie }));
    },
  });
  const before = await collect(f),
    after = await collect(f);
  assert.deepEqual(
    before.rows[0].processes.find((p) => p.pid === 78),
    zombie,
  );
  assert.equal(
    compareOwnerKernelContinuityProof(before, after)
      .ownerKernelContinuityQualified,
    true,
  );
  assert.equal(before.guestProcessContinuityQualified, false);
  const lost = clone(after);
  lost.rows[0].processes = lost.rows[0].processes.filter((p) => p.pid !== 78);
  lost.stableDigest = digest(lost.rows);
  assert.throws(
    () => compareOwnerKernelContinuityProof(before, lost),
    /OWNER_KERNEL_OR_ASSIGNMENTS_CHANGED/,
  );
  const reused = clone(after);
  reused.rows[0].processes.find((p) => p.pid === 78).startTicks = "181";
  reused.stableDigest = digest(reused.rows);
  assert.throws(
    () => compareOwnerKernelContinuityProof(before, reused),
    /OWNER_KERNEL_OR_ASSIGNMENTS_CHANGED/,
  );
});

test("live to zombie transitions cannot pass a scan or a signed proof comparison", async () => {
  assert.throws(
    () =>
      parseOwnerProcSnapshot(
        procText((rows, round) => {
          if (round === 2)
            rows.push({
              pid: 78,
              ppid: 1,
              startTicks: "180",
              comm: "node",
              livenessClass: "zombie",
            });
          else
            rows.push({
              pid: 78,
              ppid: 1,
              startTicks: "180",
              comm: "node",
              livenessClass: "live",
            });
        }),
      ),
    /CHANGED_DURING_SCAN/,
  );
  const before = await collect(
    fixture({
      onProc(v) {
        v.stdout = procText((rows) =>
          rows.push({
            pid: 78,
            ppid: 1,
            startTicks: "180",
            comm: "node",
            livenessClass: "live",
          }),
        );
      },
    }),
  );
  const after = clone(before);
  after.rows[0].processes.find((p) => p.pid === 78).livenessClass = "zombie";
  after.stableDigest = digest(after.rows);
  assert.throws(
    () => compareOwnerKernelContinuityProof(before, after),
    /OWNER_KERNEL_OR_ASSIGNMENTS_CHANGED/,
  );
  for (const pid of [1, 10, 11]) {
    assert.throws(
      () =>
        parseOwnerProcSnapshot(
          procText((rows) => {
            rows.find((p) => p.pid === pid).livenessClass = "zombie";
          }),
        ),
      /OWNER_/,
    );
    const invalid = clone(before);
    invalid.rows[0].processes.find((p) => p.pid === pid).livenessClass =
      "zombie";
    invalid.stableDigest = digest(invalid.rows);
    assert.throws(() => validateOwnerKernelContinuityProof(invalid), /OWNER_/);
  }
});

test("real shell records stable historical Z, normalizes R/S to live, and rejects dead X", async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), "owner-proc-liveness-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(join(root, "sys/kernel/random"), { recursive: true });
  await fs.writeFile(join(root, "sys/kernel/random/boot_id"), boot + "\n");
  const rows = [
    ...processes(),
    {
      pid: 78,
      ppid: 1,
      startTicks: "180",
      comm: "node",
      livenessClass: "zombie",
    },
  ];
  async function writeState(p, state) {
    await fs.writeFile(
      join(root, String(p.pid), "stat"),
      `${p.pid} (${p.comm}) ${[state, p.ppid, ...Array(17).fill(0), p.startTicks].join(" ")}\n`,
    );
  }
  for (const p of rows) {
    await fs.mkdir(join(root, String(p.pid)));
    await writeState(p, p.livenessClass === "zombie" ? "Z" : "S");
  }
  const script = OWNER_PROC_COLLECTOR.replaceAll(
    "/proc/",
    root + "/",
  ).replaceAll('"$$"', '"999"');
  const a = parseOwnerProcSnapshot(
    (await run("/bin/sh", ["-c", script], { timeout: 5000 })).stdout,
  );
  assert.equal(a.processes.find((p) => p.pid === 78).livenessClass, "zombie");
  await writeState(rows[0], "R");
  const b = parseOwnerProcSnapshot(
    (await run("/bin/sh", ["-c", script], { timeout: 5000 })).stdout,
  );
  assert.deepEqual(a, b);
  await writeState(rows.at(-1), "X");
  await assert.rejects(
    run("/bin/sh", ["-c", script], { timeout: 5000 }),
    (e) => e.code === 76,
  );
});
