import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  HELPER_NAME,
  boundToThisApi,
  canonicalHelper,
  countCgroupSetupFailures,
  parsePortMappings,
  parseProcStat,
  parseWildcardListeners,
  smokeStages,
  vmTreeMatches,
} from "./api-smoke.mjs";
import { STOPPED_RESERVATIONS_PROBE } from "./api-container.mjs";

test("without stage variables the smoke runs only the original chain; stages are opt-in and typos are refused", () => {
  assert.deepEqual(smokeStages({}), {
    listeners: false,
    helper: false,
    cgroup: false,
    chaos: false,
    chaosLogin: false,
    names: [],
  });
  assert.deepEqual(
    smokeStages({ API_SMOKE_STAGES: " listeners,helper ,cgroup,helper" }),
    {
      listeners: true,
      helper: true,
      cgroup: true,
      chaos: false,
      chaosLogin: false,
      names: ["listeners", "helper", "cgroup"],
    },
  );
  for (const API_SMOKE_STAGES of ["helper-chaos", "listener", "all"])
    assert.throws(
      () => smokeStages({ API_SMOKE_STAGES }),
      /^Error: UNKNOWN_SMOKE_STAGE$/,
    );
  // Killing the helper VM needs its own switch; the login trigger can be disabled.
  assert.equal(smokeStages({ API_SMOKE_HELPER_CHAOS: "true" }).chaos, false);
  assert.deepEqual(
    smokeStages({ API_SMOKE_HELPER_CHAOS: "1", API_SMOKE_STAGES: "helper" }),
    {
      listeners: false,
      helper: true,
      cgroup: false,
      chaos: true,
      chaosLogin: true,
      names: ["helper", "helper-chaos"],
    },
  );
  assert.equal(
    smokeStages({
      API_SMOKE_HELPER_CHAOS: "1",
      API_SMOKE_HELPER_CHAOS_LOGIN: "0",
    }).chaosLogin,
    false,
  );
});

test("the canonical helper name uses the release probe's derivation", () => {
  assert.equal(
    HELPER_NAME,
    "platform-boxlite-" +
      createHash("sha256")
        .update("/data/platform.db")
        .digest("hex")
        .slice(0, 16) +
      "-auth-helper",
  );
  for (const literal of [
    '"platform-boxlite-"',
    '"/data/platform.db"',
    '"auth-helper"',
  ])
    assert.ok(STOPPED_RESERVATIONS_PROBE.includes(literal), literal);
});

const BOXES = "/data/boxlite/boxes";
const helperTree = () =>
  new Map([
    [1, { comm: "node", state: "S", parent: 0, exe: "/usr/local/bin/node" }],
    [
      30,
      {
        comm: "bwrap",
        state: "S",
        parent: 1,
        exe: "/opt/boxlite-runtime/bwrap",
      },
    ],
    [
      31,
      {
        comm: "bwrap",
        state: "S",
        parent: 30,
        exe: "/opt/boxlite-runtime/bwrap",
      },
    ],
    [
      32,
      {
        comm: "libkrun VM",
        state: "S",
        parent: 31,
        exe: BOXES + "/H1/bin/boxlite-shim",
      },
    ],
  ]);
const running = [{ id: "H1", name: HELPER_NAME, status: "running", pid: 30 }];

test("only a running canonical helper whose bwrap root holds exactly one live VM of that box counts", () => {
  assert.deepEqual(canonicalHelper(running, helperTree()), {
    id: "H1",
    pid: 30,
    vmPid: 32,
  });
  for (const [label, change] of [
    ["VM killed", (p) => p.delete(32)],
    ["VM zombie", (p) => (p.get(32).state = "Z")],
    [
      "root reused",
      (p) =>
        p.set(30, { comm: "git", state: "S", parent: 1, exe: "/usr/bin/git" }),
    ],
    ["root zombie", (p) => (p.get(30).state = "Z")],
    [
      "VM of the old box",
      (p) => (p.get(32).exe = BOXES + "/H0/bin/boxlite-shim"),
    ],
    ["VM outside the root", (p) => (p.get(32).parent = 1)],
    ["second VM", (p) => p.set(33, { ...p.get(32), parent: 31 })],
  ]) {
    const processes = helperTree();
    change(processes);
    assert.equal(canonicalHelper(running, processes), null, label);
  }
  assert.equal(canonicalHelper([], helperTree()), null);
  for (const row of [
    { ...running[0], status: "stopped" },
    { ...running[0], pid: null },
  ])
    assert.equal(canonicalHelper([row], helperTree()), null);
  assert.throws(
    () =>
      canonicalHelper(
        [...running, { ...running[0], id: "H0", status: "stopped" }],
        helperTree(),
      ),
    /DUPLICATE_CANONICAL_HELPER/,
  );
});

const box = (root, id) =>
  new Map([
    [
      root,
      {
        comm: "bwrap",
        state: "S",
        parent: 1,
        exe: "/opt/boxlite-runtime/bwrap",
      },
    ],
    [
      root + 1,
      {
        comm: "bwrap",
        state: "S",
        parent: root,
        exe: "/opt/boxlite-runtime/bwrap",
      },
    ],
    [
      root + 2,
      {
        comm: "libkrun VM",
        state: "S",
        parent: root + 1,
        exe: BOXES + "/" + id + "/bin/boxlite-shim",
      },
    ],
  ]);

test("the VM tree matches the release probe only when every BoxLite process sits under an expected root with exactly its own VM", () => {
  const helper = { id: "H1", pid: 30 },
    task = { id: "T1", pid: 50 };
  assert.equal(vmTreeMatches(helperTree(), [helper]), true);
  const both = new Map([...helperTree(), ...box(50, "T1")]);
  assert.equal(vmTreeMatches(both, [helper, task]), true);
  // The release probe would see the task's processes outside the helper root.
  assert.equal(vmTreeMatches(both, [helper]), false);
  // An exited, unreaped wrapper of the killed box is ignored, as the probe does.
  const reaped = helperTree();
  reaped.set(20, { comm: "bwrap", state: "Z", parent: 1, exe: null });
  assert.equal(vmTreeMatches(reaped, [helper]), true);
  const oldShim = BOXES + "/H0/bin/boxlite-shim";
  for (const [label, change] of [
    [
      "VM of the removed box left",
      (p) =>
        p.set(22, { comm: "libkrun VM", state: "S", parent: 1, exe: oldShim }),
    ],
    [
      "shim of the removed box left",
      (p) =>
        p.set(22, {
          comm: "boxlite-shim",
          state: "S",
          parent: 1,
          exe: oldShim,
        }),
    ],
    [
      "wrapper outside every root",
      (p) => p.set(20, { ...p.get(31), parent: 1 }),
    ],
    ["second VM under the root", (p) => p.set(33, { ...p.get(32) })],
    [
      "VM of another box under the root",
      (p) => (p.get(32).exe = BOXES + "/H0/bin/boxlite-shim"),
    ],
    ["VM killed", (p) => p.delete(32)],
    ["stopped VM", (p) => (p.get(32).state = "T")],
    [
      "root reused",
      (p) =>
        p.set(30, { comm: "git", state: "S", parent: 1, exe: "/usr/bin/git" }),
    ],
    [
      "zombie root",
      (p) => p.set(30, { comm: "bwrap", state: "Z", parent: 1, exe: null }),
    ],
    ["root not BoxLite's bwrap", (p) => (p.get(30).exe = "/usr/bin/bwrap")],
  ]) {
    const processes = helperTree();
    change(processes);
    assert.equal(vmTreeMatches(processes, [helper]), false, label);
  }
  // After a chaos run without its heal trigger no BoxLite process may live.
  assert.equal(vmTreeMatches(reaped, []), false);
  const none = new Map([
    [1, helperTree().get(1)],
    [20, reaped.get(20)],
  ]);
  assert.equal(vmTreeMatches(none, []), true);
});

test("the chaos stage is bound to this container's PID 1, which docker exec -e cannot fake", () => {
  const header =
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";
  const listen = (address, inode) =>
    `   0: ${address} 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 ${inode} 1 0000000000000000 100 0 0 10 0\n`;
  const tcp = header + listen("0100007F:0C77", "4242"),
    isolated = "PATH=/usr/bin\0PORT=3191\0API_SMOKE_ISOLATED=1\0";
  assert.equal(boundToThisApi(isolated, tcp, ["17", "4242"]), true);
  for (const [label, environ, text, sockets] of [
    ["production PID 1", "PORT=3101\0HOST=127.0.0.1\0", tcp, ["4242"]],
    ["no isolation flag", "PORT=3191\0", tcp, ["4242"]],
    ["similar port", "PORT=31910\0API_SMOKE_ISOLATED=1\0", tcp, ["4242"]],
    ["3191 served by another namespace", isolated, tcp, ["17"]],
    [
      "nothing on 3191",
      isolated,
      header + listen("0100007F:0C75", "4242"),
      ["4242"],
    ],
    [
      "3191 on another address",
      isolated,
      header + listen("00000000:0C77", "4242"),
      ["4242"],
    ],
  ])
    assert.equal(boundToThisApi(environ, text, sockets), false, label);
});

test("proc stat parsing keeps comm names with spaces and parentheses", () => {
  assert.deepEqual(
    parseProcStat(
      "32 (libkrun VM) S 31 32 1 0 -1 4194560 0 0 0 0 7 3 0 0 20 0 21 0 900 0",
    ),
    { comm: "libkrun VM", state: "S", parent: 31 },
  );
  assert.deepEqual(parseProcStat("7 (a) b) R 1 7 7 0"), {
    comm: "a) b",
    state: "R",
    parent: 1,
  });
  assert.equal(parseProcStat("garbage"), null);
});

test("only LISTEN sockets on 0.0.0.0 or :: are wildcard listeners", () => {
  const header =
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";
  const tcp =
    header +
    "   0: 0100007F:0C77 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1001 1 0000000000000000 100 0 0 10 0\n" +
    "   1: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1002 1 0000000000000000 100 0 0 10 0\n" +
    "   2: 00000000:AE7D 0100007F:0C77 01 00000000:00000000 00:00000000 00000000     0        0 1003 1 0000000000000000 20 4 30 10 -1\n";
  const tcp6 =
    header +
    "   0: 00000000000000000000000000000000:AE7D 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 2001 1 0000000000000000 100 0 0 10 0\n" +
    "   1: 00000000000000000000000001000000:1F90 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 2002 1 0000000000000000 100 0 0 10 0\n" +
    "   2: 00000000000000000000000000000000:0035 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 0 1 0000000000000000 100 0 0 10 0\n";
  assert.deepEqual(parseWildcardListeners(tcp, tcp6), [
    { family: 4, port: 22, inode: "1002" },
    { family: 6, port: 44669, inode: "2001" },
  ]);
  assert.deepEqual(parseWildcardListeners("", ""), []);
});

test("BoxLite port mappings are attributed to the box whose spawn follows them, per start", () => {
  const day1 = [
    "2026-10-06T04:33:28.056769Z  INFO boxlite::litebox::init::tasks::vmm_spawn: Port mappings: 1 (image: 0, user: 1, overridden: 0)",
    '2026-10-06T04:33:28.056830Z  INFO boxlite::vmm::controller::shim: Starting Box subprocess engine=Libkrun transport=Unix { socket_path: "/tmp/bl-0/3lB6k35tQjBE/box.sock" }',
    "2026-10-06T04:33:28.059820Z  WARN boxlite::jailer::sandbox::bwrap: Cgroup setup failed (continuing without cgroup limits) id=3lB6k35tQjBE error=cgroup: Failed to write",
    "2026-10-08T01:00:00.000000Z  INFO boxlite::litebox::init::tasks::vmm_spawn: Port mappings: 0 (image: 0, user: 0, overridden: 0)",
    "2026-10-08T01:00:00.000100Z  INFO boxlite::vmm::controller::shim: boxlite-shim subprocess spawned box_id=helperA pid=29 shim_spawn_duration_ms=28",
  ].join("\n");
  const day2 = [
    "2026-10-09T01:00:00.000000Z  INFO boxlite::litebox::init::tasks::vmm_spawn: Port mappings: 0 (image: 0, user: 0, overridden: 0)",
    '2026-10-09T01:00:00.000100Z  INFO boxlite::vmm::controller::shim: Starting Box subprocess engine=Libkrun transport=Unix { socket_path: "/tmp/bl-0/taskB/box.sock" }',
    "2026-10-09T01:05:00.000000Z  INFO boxlite::litebox::init::tasks::vmm_spawn: Port mappings: 2 (image: 2, user: 2, overridden: 2)",
    '2026-10-09T01:05:00.000100Z  INFO boxlite::vmm::controller::shim: Starting Box subprocess engine=Libkrun transport=Unix { socket_path: "/tmp/bl-0/taskB/box.sock" }',
  ].join("\n");
  const none = { total: 0, image: 0, user: 0, overridden: 0 };
  assert.deepEqual(
    parsePortMappings([day1, day2]),
    new Map([
      ["3lB6k35tQjBE", [{ total: 1, image: 0, user: 1, overridden: 0 }]],
      ["helperA", [none]],
      ["taskB", [none, { total: 2, image: 2, user: 2, overridden: 2 }]],
    ]),
  );
});

test("cgroup setup failures count only this run's lines, and untimed failure lines still count", () => {
  const since = Date.parse("2026-10-07T19:40:00.000Z");
  const failure = (at, id) =>
    `${at}  WARN boxlite::jailer::sandbox::bwrap: Cgroup setup failed (continuing without cgroup limits) id=${id}`;
  const older = [
    failure("2026-10-07T19:34:03.179540Z", "offRun"),
    "2026-10-07T19:41:54.508809Z  INFO boxlite::litebox::init::tasks::vmm_spawn: Port mappings: 0 (image: 0, user: 0, overridden: 0)",
  ].join("\n");
  assert.equal(countCgroupSetupFailures([older], since), 0);
  assert.equal(
    countCgroupSetupFailures(
      [older, failure("2026-10-07T19:41:54.511885Z", "thisRun")],
      since,
    ),
    1,
  );
  assert.equal(
    countCgroupSetupFailures(
      ["Cgroup setup failed without a timestamp"],
      since,
    ),
    1,
  );
});
