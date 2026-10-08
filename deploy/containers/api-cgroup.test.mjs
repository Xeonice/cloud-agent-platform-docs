import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  CGROUP_LEAF,
  delegateCgroupControllers,
  reportCgroupDelegation,
} from "./api-cgroup.mjs";

const ROOT = "/sys/fs/cgroup",
  SELF = "/proc/self/cgroup",
  ALL = "cpuset cpu io memory hugetlb pids rdma misc";
const errno = (code) => Object.assign(Error(code + " (fixture)"), { code });

/**
 * The container cgroup namespace root as Docker leaves it: every controller
 * available, none delegated, PID 1 and BoxLite's bwrap/shim inside the root.
 * Writes follow the kernel rules the delegation depends on: a namespace root
 * holding processes cannot enable controllers (EBUSY), unavailable controllers
 * are ENOENT, and moving a PID that already exited is ESRCH. Only the real
 * root lacks cgroup.type (type: null).
 */
function cgroupfs({
  controllers = ALL,
  subtree = "",
  root = ["1", "31", "32", "33"],
  leaf = null,
  self = "0::/",
  type = "domain",
  exited = [],
  joins = [],
  faults = {},
} = {}) {
  const groups = new Map([["", new Set(root)]]);
  if (leaf) groups.set(CGROUP_LEAF, new Set(leaf));
  const enabled = new Set(subtree.split(" ").filter(Boolean)),
    calls = [];
  const fault = (operation, path) => {
    const code = faults[operation + " " + path];
    if (code) throw errno(code);
  };
  const procsOf = (path) => {
    const group = groups.get(
      path.slice(ROOT.length + 1).replace(/\/?cgroup\.procs$/, ""),
    );
    if (!group) throw errno("ENOENT");
    return group;
  };
  const files = {
    readFileSync(path) {
      calls.push(["read", path]);
      fault("read", path);
      if (path === SELF) return self + "\n";
      if (path === ROOT + "/cgroup.controllers") {
        if (controllers === null) throw errno("ENOENT");
        return controllers + "\n";
      }
      if (path === ROOT + "/cgroup.subtree_control")
        return [...enabled].join(" ") + "\n";
      if (path === ROOT + "/cgroup.type") {
        if (type === null) throw errno("ENOENT");
        return type + "\n";
      }
      if (path.endsWith("cgroup.procs"))
        return [...procsOf(path)].map((pid) => pid + "\n").join("");
      throw errno("ENOENT");
    },
    mkdirSync(path, options) {
      calls.push(["mkdir", path]);
      fault("mkdir", path);
      const name = path.slice(ROOT.length + 1);
      if (groups.has(name)) {
        if (!options?.recursive) throw errno("EEXIST");
        return;
      }
      groups.set(name, new Set());
    },
    writeFileSync(path, data) {
      calls.push(["write", path, String(data)]);
      fault("write", path);
      if (path === ROOT + "/cgroup.subtree_control") {
        // docker exec may join the root right before this write.
        for (const pid of joins.shift() ?? []) groups.get("").add(pid);
        const names = String(data)
          .split(" ")
          .map((token) => token.slice(1));
        if (names.some((name) => !controllers.split(" ").includes(name)))
          throw errno("ENOENT");
        if (groups.get("").size) throw errno("EBUSY");
        for (const name of names) enabled.add(name);
        return;
      }
      const target = procsOf(path),
        pid = String(data);
      const source = [...groups.values()].find((group) => group.has(pid));
      // Listed while alive, gone by the time of the move.
      if (exited.includes(pid)) source?.delete(pid);
      if (!source || exited.includes(pid)) throw errno("ESRCH");
      source.delete(pid);
      target.add(pid);
    },
  };
  return {
    files,
    calls,
    enabled,
    procs: (name) => [...(groups.get(name) ?? [])].sort(),
    mutations: () => calls.filter(([operation]) => operation !== "read"),
  };
}

// The operator switch is read from the environment; keep the caller's out.
const delegate = (options) =>
  delegateCgroupControllers({ env: {}, ...options });

test("moves every root process into the API leaf, then delegates exactly cpu, memory and pids", async () => {
  const fake = cgroupfs();
  const result = await delegate({
    files: fake.files,
    pause: () => assert.fail("no retry expected"),
  });
  assert.deepEqual(result, { status: "enabled", leaf: "/api", attempts: 1 });
  assert.deepEqual(fake.procs(""), []);
  assert.deepEqual(fake.procs(CGROUP_LEAF), ["1", "31", "32", "33"]);
  assert.deepEqual([...fake.enabled], ["cpu", "memory", "pids"]);
  assert.deepEqual(
    fake
      .mutations()
      .filter(([, path]) => path === ROOT + "/cgroup.subtree_control"),
    [["write", ROOT + "/cgroup.subtree_control", "+cpu +memory +pids"]],
  );
  // Every PID is its own write: cgroup.procs accepts one PID per write(2).
  assert.equal(
    fake.mutations().filter(([, path]) => path === ROOT + "/api/cgroup.procs")
      .length,
    4,
  );
});

test("without cgroup v2 or with a missing controller nothing is touched and the reason is kept", async () => {
  const none = cgroupfs({ controllers: null });
  assert.deepEqual(await delegate({ files: none.files }), {
    status: "skipped",
    reason: "no-cgroup-v2",
  });
  assert.deepEqual(none.mutations(), []);
  for (const controllers of ["cpuset cpu io memory", "cpu io pids", ""]) {
    const partial = cgroupfs({ controllers });
    assert.deepEqual(
      await delegate({ files: partial.files }),
      {
        status: "skipped",
        reason: "controllers-unavailable",
        available: controllers.split(" ").filter(Boolean),
      },
      controllers,
    );
    assert.deepEqual(partial.mutations(), []);
    assert.deepEqual(partial.procs(""), ["1", "31", "32", "33"]);
  }
});

test("a process joining the root between the move and the write is moved again before delegation", async () => {
  let pauses = 0;
  const fake = cgroupfs({ joins: [["41"]] });
  const result = await delegate({
    files: fake.files,
    pause: async () => pauses++,
  });
  assert.deepEqual(result, { status: "enabled", leaf: "/api", attempts: 2 });
  assert.equal(pauses, 1);
  assert.deepEqual(fake.procs(""), []);
  assert.deepEqual(fake.procs(CGROUP_LEAF), ["1", "31", "32", "33", "41"]);
});

test("a listed process that exits before its move is ignored", async () => {
  const fake = cgroupfs({ root: ["1", "77", "31"], exited: ["77"] });
  assert.deepEqual(await delegate({ files: fake.files }), {
    status: "enabled",
    leaf: "/api",
    attempts: 1,
  });
  assert.deepEqual(fake.procs(CGROUP_LEAF), ["1", "31"]);
});

test("delegation is idempotent and finishes an interrupted attempt from the leaf", async () => {
  const done = cgroupfs({
    root: [],
    leaf: ["1", "31"],
    self: "0::/api",
    subtree: "cpu memory pids",
  });
  assert.deepEqual(await delegate({ files: done.files }), {
    status: "already",
  });
  assert.deepEqual(done.mutations(), []);
  // Moved earlier, but the controllers were never enabled: an exec'd process
  // that joined the root since then is moved and the write completes.
  const interrupted = cgroupfs({ root: ["52"], leaf: ["1"], self: "0::/api" });
  assert.deepEqual(await delegate({ files: interrupted.files }), {
    status: "enabled",
    leaf: "/api",
    attempts: 1,
  });
  assert.deepEqual(interrupted.procs(CGROUP_LEAF), ["1", "52"]);
  assert.deepEqual([...interrupted.enabled], ["cpu", "memory", "pids"]);
});

test("a host cgroup namespace is never reorganised", async () => {
  for (const [self, cgroup] of [
    ["0::/system.slice/docker-abc.scope", "/system.slice/docker-abc.scope"],
    ["0::/docker/abc", "/docker/abc"],
    ["0::/api/nested", "/api/nested"],
    ["12:cpu,cpuacct:/docker/abc", "none"],
  ]) {
    const fake = cgroupfs({ self });
    assert.deepEqual(
      await delegate({ files: fake.files }),
      { status: "skipped", reason: "foreign-cgroup", cgroup },
      self,
    );
    assert.deepEqual(fake.mutations(), [], self);
  }
});

test("the real cgroup root is never reorganised: only a namespace root has cgroup.type", async () => {
  const fake = cgroupfs({ type: null, root: ["1", "2", "88"] });
  assert.deepEqual(await delegate({ files: fake.files }), {
    status: "skipped",
    reason: "real-root",
  });
  assert.deepEqual(fake.mutations(), []);
  assert.deepEqual(fake.procs(""), ["1", "2", "88"]);
});

test("API_CGROUP_DELEGATION=off in the runtime environment skips before touching cgroupfs", async () => {
  const off = cgroupfs();
  assert.deepEqual(
    await delegateCgroupControllers({
      env: { API_CGROUP_DELEGATION: "off" },
      files: off.files,
    }),
    { status: "skipped", reason: "disabled" },
  );
  assert.deepEqual(off.calls, []);
  // Only the exact value disables; anything else keeps the default.
  for (const value of ["on", "", "OFF"]) {
    const fake = cgroupfs();
    assert.equal(
      (
        await delegateCgroupControllers({
          env: { API_CGROUP_DELEGATION: value },
          files: fake.files,
        })
      ).status,
      "enabled",
      value,
    );
  }
});

test("read-only or forbidden cgroupfs fails open with the failing step and errno", async () => {
  for (const [faults, expected] of [
    [
      { ["mkdir " + ROOT + "/api"]: "EROFS" },
      { reason: "EROFS", step: "leaf" },
    ],
    [
      { ["write " + ROOT + "/api/cgroup.procs"]: "EACCES" },
      { reason: "EACCES", step: "move" },
    ],
    [
      { ["write " + ROOT + "/cgroup.subtree_control"]: "EPERM" },
      { reason: "EPERM", step: "enable" },
    ],
    [
      { ["read " + ROOT + "/cgroup.controllers"]: "EACCES" },
      { reason: "EACCES", step: "controllers" },
    ],
    [{ ["read " + SELF]: "ENOENT" }, { reason: "ENOENT", step: "membership" }],
    [
      { ["read " + ROOT + "/cgroup.type"]: "EACCES" },
      { reason: "EACCES", step: "membership" },
    ],
  ]) {
    const fake = cgroupfs({ faults });
    assert.deepEqual(
      await delegate({ files: fake.files }),
      { status: "failed", ...expected },
      JSON.stringify(faults),
    );
    assert.deepEqual(fake.enabled.size, 0);
  }
  const broken = {
    readFileSync: () => {
      throw TypeError("not an errno");
    },
  };
  assert.deepEqual(await delegate({ files: broken }), {
    status: "failed",
    reason: "unexpected",
    step: "controllers",
  });
});

test("persistent EBUSY gives up after the bounded attempts instead of spinning", async () => {
  let pauses = 0;
  const fake = cgroupfs({ joins: [["41"], ["42"], ["43"], ["44"]] });
  assert.deepEqual(
    await delegate({
      files: fake.files,
      attempts: 3,
      pause: async () => pauses++,
    }),
    { status: "failed", reason: "EBUSY", step: "enable" },
  );
  assert.equal(pauses, 2);
  assert.equal(fake.enabled.size, 0);
});

test("one log line: delegated on stdout, skipped or failed on stderr with the reason", () => {
  const out = [],
    err = [];
  const log = {
    log: (line) => out.push(line),
    error: (line) => err.push(line),
  };
  for (const result of [
    { status: "enabled", leaf: "/api", attempts: 2 },
    { status: "already" },
    { status: "failed", reason: "EROFS", step: "leaf" },
    { status: "skipped", reason: "controllers-unavailable", available: [] },
    {
      status: "skipped",
      reason: "controllers-unavailable",
      available: ["cpu", "io"],
    },
  ])
    assert.equal(reportCgroupDelegation(result, log), result);
  assert.deepEqual(out, [
    "cgroup-delegation status=enabled leaf=/api attempts=2",
    "cgroup-delegation status=already",
  ]);
  assert.deepEqual(err, [
    "cgroup-delegation status=failed reason=EROFS step=leaf",
    "cgroup-delegation status=skipped reason=controllers-unavailable available=none",
    "cgroup-delegation status=skipped reason=controllers-unavailable available=cpu,io",
  ]);
});

test("the image entrypoint delegates after loading runtime.env and before it loads the API and its BoxLite runtime", async () => {
  const source = await readFile(
    new URL("./api-entrypoint.mjs", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /^import \{[^}]*\bdelegateCgroupControllers\b[^}]*\} from "\.\/api-cgroup\.mjs";$/m,
  );
  const runtimeEnv = source.indexOf(
      'process.loadEnvFile("/run/secrets/runtime.env")',
    ),
    delegation = source.indexOf(
      "reportCgroupDelegation(await delegateCgroupControllers())",
    ),
    api = source.indexOf('("/app/apps/api/dist/main.js")');
  // The off switch lives in runtime.env, so it must be loaded first.
  assert.ok(runtimeEnv > 0 && delegation > runtimeEnv && api > delegation);
});
