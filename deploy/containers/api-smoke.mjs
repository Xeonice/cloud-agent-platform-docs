import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const BASE = "http://127.0.0.1:3191";
const REPORT = "/data/proof/api-smoke.json";
const WS_HASH = "sb-terminal-v4";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const require = createRequire("/app/package.json");
const PLATFORM_DB = "/data/platform.db";
const BOXLITE_DB = "/data/boxlite/db/boxlite.db";
const BOXES = "/data/boxlite/boxes";
const BOXLITE_LOGS = "/data/boxlite/logs";
const CGROUP = "/sys/fs/cgroup";
// Same derivation as the release probe in api-container.mjs: the canonical
// helper name is a deployment contract, not an API implementation detail.
export const HELPER_NAME =
  "platform-boxlite-" +
  createHash("sha256").update(PLATFORM_DB).digest("hex").slice(0, 16) +
  "-auth-helper";

function assert(condition, code) {
  if (!condition) throw new Error(code);
}

// No configurable URL or data path: this driver cannot address native production.
function assertIsolation() {
  assert(
    process.platform === "linux" &&
      process.arch === "arm64" &&
      process.versions.node.split(".")[0] === "22" &&
      process.env.API_SMOKE_ISOLATED === "1" &&
      process.env.PORT === "3191" &&
      process.env.HOST === "127.0.0.1" &&
      process.env.DATA_ROOT === "/data" &&
      process.env.DATABASE_URL === "/data/platform.db" &&
      process.env.BOXLITE_HOME === "/data/boxlite" &&
      process.env.SANDBOX_DEFAULT_PROVIDER === "boxlite" &&
      process.env.SCHEDULER_CPU_OVERCOMMIT === "1" &&
      process.env.ACCESS_PASSCODE_ALLOW_LOOPBACK !== "true" &&
      typeof process.env.ACCESS_PASSCODE === "string" &&
      process.env.ACCESS_PASSCODE.length >= 16,
    "ISOLATED_CONTAINER_REQUIRED",
  );
}

async function request(
  path,
  { method = "GET", body, authorized = true, expected = 200 } = {},
) {
  const response = await fetch(BASE + path, {
    method,
    headers: {
      ...(authorized
        ? { authorization: "Bearer " + process.env.ACCESS_PASSCODE }
        : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(method === "GET" ? 10000 : 60000),
    redirect: "error",
  });
  assert(
    response.status === expected,
    "HTTP_" + method + "_" + response.status,
  );
  if (response.status === 204 || response.status === 401) return null;
  return response.json();
}

async function waitFor(
  read,
  accepts,
  { timeout = 900000, interval = 1000, code = "POLL_TIMEOUT" } = {},
) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await read();
    if (accepts(value)) return value;
    await sleep(interval);
  }
  throw new Error(code);
}

async function waitRunning(id, states) {
  return waitFor(
    async () => {
      const value = await request("/api/sandboxes/" + id);
      if (states.at(-1) !== value.status) {
        states.push(value.status);
        console.log(JSON.stringify({ stage: "sandbox", status: value.status }));
      }
      if (["failed", "destroyed"].includes(value.status))
        throw new Error(
          /^\w+$/.test(value.failureCode ?? "")
            ? value.failureCode
            : "SANDBOX_FAILED",
        );
      return value;
    },
    (value) => value.status === "running",
  );
}

async function terminalProof(id) {
  const marker = "API_PTY_" + randomUUID().replaceAll("-", "");
  const midpoint = Math.floor(marker.length / 2);
  const socket = new WebSocket(
    BASE.replace("http:", "ws:") +
      "/socket.io/?EIO=4&transport=websocket&sandboxId=" +
      encodeURIComponent(id) +
      "&kind=shell&cols=80&rows=24",
  );
  let session = false;
  let output = "";
  let settled = false;
  try {
    return await new Promise((resolve, reject) => {
      const fail = (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(code));
      };
      const timer = setTimeout(() => fail("TERMINAL_TIMEOUT"), 60000);
      socket.addEventListener("error", () => fail("TERMINAL_TRANSPORT_FAILED"));
      socket.addEventListener("close", () => fail("TERMINAL_CLOSED_EARLY"));
      socket.addEventListener("message", (event) => {
        try {
          const packet = String(event.data);
          if (packet.startsWith("0")) {
            socket.send(
              "40/terminal," +
                JSON.stringify({
                  passcode: process.env.ACCESS_PASSCODE,
                  xSchemaHash: WS_HASH,
                }),
            );
          } else if (packet === "2") socket.send("3");
          else if (packet.startsWith("44/terminal,"))
            fail("TERMINAL_HANDSHAKE_REJECTED");
          else if (packet.startsWith("42/terminal,")) {
            const [name, frame] = JSON.parse(
              packet.slice("42/terminal,".length),
            );
            if (name !== "frame") return;
            if (frame.type === "session") {
              assert(
                typeof frame.socketSessionKey === "string" &&
                  typeof frame.shellId === "string" &&
                  frame.shellId.length > 0,
                "TERMINAL_SESSION_INVALID",
              );
              session = true;
              // Echoed shell input cannot satisfy the check: the two halves are
              // separate literals, while successful PTY output joins them.
              const command =
                "test -t 1 && printf '%s%s\\n' '" +
                marker.slice(0, midpoint) +
                "' '" +
                marker.slice(midpoint) +
                "'\n";
              socket.send(
                "42/terminal," +
                  JSON.stringify(["frame", { type: "input", data: command }]),
              );
            } else if (frame.type === "data") {
              assert(typeof frame.data === "string", "TERMINAL_DATA_INVALID");
              output += frame.data;
              assert(output.length <= 65536, "TERMINAL_OUTPUT_LIMIT");
              if (session && output.includes(marker)) {
                settled = true;
                clearTimeout(timer);
                resolve({
                  websocket: true,
                  sessionFrame: true,
                  actualPty: true,
                  roundTrip: true,
                });
              }
            } else if (frame.type === "exit") fail("TERMINAL_ATTACH_EXITED");
          }
        } catch {
          fail("TERMINAL_PROTOCOL_FAILED");
        }
      });
    });
  } finally {
    socket.close();
  }
}

// Opt-in stages; leaving both variables unset runs exactly the original chain.
//   API_SMOKE_STAGES=listeners,helper,cgroup (any subset)
//     listeners  no wildcard LISTEN socket owned by a BoxLite VM and no
//                published box port in the BoxLite logs
//     helper     diagnosis auth-helper=ok; one canonical helper whose bwrap root
//                holds the only VM and every BoxLite process (the release
//                probe's rule), outside sandboxes and the reservation ledger,
//                with its reservation in the capacity basis; after cleanup only
//                its box directory and process tree remain
//     cgroup     API and docker exec in the delegated /api leaf; per-box BoxLite
//                cgroups with pids.max; no "Cgroup setup failed"
//   API_SMOKE_HELPER_CHAOS=1 kills the helper VM, but only when PID 1 is the
//     isolated API on 3191. The release probe must stop accepting the helper at
//     once; the diagnosis is only recorded (see helperChaos). Its heal trigger
//     begins a claude-code setup-token login and cancels it at once, then a new
//     canonical helper must replace the dead one. API_SMOKE_HELPER_CHAOS_LOGIN=0
//     skips that call, and then nothing rebuilds the helper within this run.
const OPTIONAL_STAGES = ["listeners", "helper", "cgroup"];
export function smokeStages(env = process.env) {
  const names = (env.API_SMOKE_STAGES ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  assert(
    names.every((name) => OPTIONAL_STAGES.includes(name)),
    "UNKNOWN_SMOKE_STAGE",
  );
  const chaos = env.API_SMOKE_HELPER_CHAOS === "1";
  return {
    listeners: names.includes("listeners"),
    helper: names.includes("helper"),
    cgroup: names.includes("cgroup"),
    chaos,
    chaosLogin: chaos && env.API_SMOKE_HELPER_CHAOS_LOGIN !== "0",
    names: [...new Set(names), ...(chaos ? ["helper-chaos"] : [])],
  };
}

const words = (text) => text.split(/\s+/).filter(Boolean);
// A process that exits during a /proc scan reads as ENOENT or ESRCH.
const gone = (error) => error.code === "ENOENT" || error.code === "ESRCH";

export function parseProcStat(text) {
  const match = /^(\d+) \((.*)\) (\S) (\d+) /.exec(text);
  return match && { comm: match[2], state: match[3], parent: Number(match[4]) };
}

function processTable() {
  const table = new Map(),
    pids = readdirSync("/proc").filter((name) => /^[1-9]\d*$/.test(name));
  for (const id of pids) {
    let stat,
      exe = null;
    try {
      stat = parseProcStat(readFileSync("/proc/" + id + "/stat", "utf8"));
      try {
        exe = readlinkSync("/proc/" + id + "/exe");
      } catch (error) {
        // Zombies and kernel threads have no executable.
        if (!gone(error)) throw error;
      }
    } catch (error) {
      if (gone(error)) continue;
      throw error;
    }
    if (stat) table.set(Number(id), { ...stat, exe });
  }
  return table;
}

const liveVms = (processes) =>
  [...processes].filter(([, p]) => p.comm === "libkrun VM" && p.state !== "Z");

function readonlyRows(path, sql, ...params) {
  const Database = require("better-sqlite3");
  const database = new Database(path, { readonly: true, fileMustExist: true });
  try {
    database.pragma("query_only = ON");
    return database.prepare(sql).all(...params);
  } finally {
    database.close();
  }
}

const helperRows = () =>
  existsSync(BOXLITE_DB)
    ? readonlyRows(
        BOXLITE_DB,
        "select c.id, c.name, s.status, s.pid from box_config c left join box_state s on s.id = c.id where c.name = ? order by c.id",
        HELPER_NAME,
      )
    : [];

const boxRootPid = (id) =>
  readonlyRows(BOXLITE_DB, "select pid from box_state where id = ?", id)[0]
    ?.pid;

/** The release probe's idle helper: one running canonical box whose bwrap root holds exactly one live VM of that box. */
export function canonicalHelper(rows, processes, boxes = BOXES) {
  assert(rows.length <= 1, "DUPLICATE_CANONICAL_HELPER");
  const [row] = rows;
  if (
    row?.status !== "running" ||
    !Number.isSafeInteger(row.pid) ||
    row.pid < 1
  )
    return null;
  const root = processes.get(row.pid),
    vms = liveVms(processes).filter(
      ([, p]) => p.exe === boxes + "/" + row.id + "/bin/boxlite-shim",
    );
  if (root?.comm !== "bwrap" || root.state === "Z" || vms.length !== 1)
    return null;
  for (
    let pid = vms[0][0], hops = 0;
    pid && hops < 64;
    pid = processes.get(pid)?.parent, hops++
  )
    if (pid === row.pid) return { id: row.id, pid: row.pid, vmPid: vms[0][0] };
  return null;
}

const BOXLITE_COMM = /^(?:bwrap|boxlite-shim|libkrun VM)$/,
  BOXLITE_EXE = /(?:^|\/)(?:bwrap|boxlite-shim)(?: \(deleted\))?$/,
  RUNNABLE = ["R", "S", "D", "I"];

/**
 * The release probe's process rule over the boxes expected to run: every live
 * bwrap, shim or VM descends from one of their bwrap roots, and each root holds
 * exactly one VM of its own box. Anything left by a removed box fails.
 */
export function vmTreeMatches(processes, roots, boxes = BOXES) {
  const owners = new Map(roots.map(({ id, pid }) => [pid, id])),
    vms = new Map(roots.map(({ pid }) => [pid, 0]));
  for (const { pid } of roots) {
    const root = processes.get(pid);
    if (
      root?.comm !== "bwrap" ||
      root.exe !== "/opt/boxlite-runtime/bwrap" ||
      !RUNNABLE.includes(root.state)
    )
      return false;
  }
  for (const [pid, p] of processes) {
    if (!BOXLITE_COMM.test(p.comm) && !BOXLITE_EXE.test(p.exe ?? "")) continue;
    // An exited, unreaped wrapper holds no VM or disk.
    if (p.state === "Z" && p.exe === null) continue;
    if (!RUNNABLE.includes(p.state)) return false;
    let root = pid;
    for (let hops = 0; !owners.has(root); hops++) {
      if (hops >= 64 || !processes.has(root)) return false;
      root = processes.get(root).parent;
    }
    if (p.comm === "libkrun VM") {
      if (p.exe !== boxes + "/" + owners.get(root) + "/bin/boxlite-shim")
        return false;
      vms.set(root, vms.get(root) + 1);
    }
  }
  return [...vms.values()].every((count) => count === 1);
}

function waitCanonicalHelper(code, { timeout = 900000, replacing } = {}) {
  return waitFor(
    async () => canonicalHelper(helperRows(), processTable()),
    (helper) => helper !== null && helper.id !== replacing,
    { timeout, interval: 1000, code },
  );
}

// Same identity as the API's AUTH_HELPER_SANDBOX_ID; never a sandbox or a reservation.
function helperOutsideLedger(boxId) {
  const [row] = readonlyRows(
    PLATFORM_DB,
    "select (select count(*) from sandboxes where id = 'auth-helper' or provider_handle = ?) as sandboxes, (select count(*) from resource_allocations where sandbox_id = 'auth-helper') as allocations",
    boxId,
  );
  return row.sandboxes === 0 && row.allocations === 0;
}

/** POST /api/system/diagnose streams SSE frames; returns the auth-helper status. */
async function diagnoseHelper() {
  const response = await fetch(BASE + "/api/system/diagnose", {
    method: "POST",
    headers: { authorization: "Bearer " + process.env.ACCESS_PASSCODE },
    signal: AbortSignal.timeout(120000),
    redirect: "error",
  });
  assert(response.status === 200, "HTTP_POST_" + response.status);
  const frames = (await response.text())
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice("data: ".length)));
  const check = frames.find(
    (frame) => frame.event === "check" && frame.id === "auth-helper",
  );
  assert(
    check && frames.some((frame) => frame.event === "done"),
    "HELPER_DIAGNOSIS_MISSING",
  );
  return check.status;
}

/** LISTEN sockets in /proc/net/tcp or tcp6 text, keeping the kernel's hex address. */
export function parseListeners(text) {
  const sockets = [];
  for (const line of text.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    const [address = "", port = ""] = (fields[1] ?? "").split(":");
    if (fields[3] === "0A" && /^[1-9]\d*$/.test(fields[9] ?? ""))
      sockets.push({ address, port: parseInt(port, 16), inode: fields[9] });
  }
  return sockets;
}

/** Wildcard (0.0.0.0 or ::) LISTEN sockets in /proc/net/tcp and tcp6 text. */
export function parseWildcardListeners(tcp, tcp6) {
  return [
    [tcp, 4],
    [tcp6, 6],
  ].flatMap(([text, family]) =>
    parseListeners(text)
      .filter(({ address }) => /^0+$/.test(address))
      .map(({ port, inode }) => ({ family, port, inode })),
  );
}

/**
 * docker exec -e can fake every variable assertIsolation reads, while the
 * chaos stage kills a VM of this container. PID 1's environment cannot be
 * overridden that way, and the API answering on 127.0.0.1:3191 must be it.
 */
export function boundToThisApi(environ, tcp, pid1Sockets) {
  const env = environ.split("\0"),
    // 127.0.0.1:3191 as /proc/net/tcp prints it on little-endian ARM64.
    api = parseListeners(tcp).find(
      ({ address, port }) => address === "0100007F" && port === 3191,
    );
  return (
    env.includes("API_SMOKE_ISOLATED=1") &&
    env.includes("PORT=3191") &&
    api !== undefined &&
    pid1Sockets.includes(api.inode)
  );
}

function assertChaosTarget() {
  const sockets = [];
  for (const fd of readdirSync("/proc/1/fd"))
    try {
      const inode = /^socket:\[(\d+)\]$/.exec(
        readlinkSync("/proc/1/fd/" + fd),
      )?.[1];
      if (inode) sockets.push(inode);
    } catch (error) {
      if (!gone(error)) throw error;
    }
  assert(
    boundToThisApi(
      readFileSync("/proc/1/environ", "utf8"),
      readFileSync("/proc/net/tcp", "utf8"),
      sockets,
    ),
    "CHAOS_TARGET_NOT_THIS_API",
  );
}

const vmProcess = (p) =>
  p.comm === "libkrun VM" ||
  p.comm === "boxlite-shim" ||
  /\/boxlite-shim(?: \(deleted\))?$/.test(p.exe ?? "");

function wildcardListeners() {
  const net = (name) => {
    try {
      return readFileSync("/proc/net/" + name, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return "";
      throw error;
    }
  };
  const sockets = new Map(
    parseWildcardListeners(net("tcp"), net("tcp6")).map((socket) => [
      socket.inode,
      { ...socket, owners: [] },
    ]),
  );
  for (const [pid, p] of processTable()) {
    let fds;
    try {
      fds = readdirSync("/proc/" + pid + "/fd");
    } catch (error) {
      if (gone(error)) continue;
      // A VM whose sockets cannot be read would make this check vacuous.
      assert(!vmProcess(p), "LISTENER_OWNER_UNREADABLE");
      continue;
    }
    for (const fd of fds) {
      let target = "";
      try {
        target = readlinkSync("/proc/" + pid + "/fd/" + fd);
      } catch (error) {
        if (!gone(error)) throw error;
      }
      const socket = sockets.get(/^socket:\[(\d+)\]$/.exec(target)?.[1]);
      if (socket) socket.owners.push({ pid, comm: p.comm, vm: vmProcess(p) });
    }
  }
  return [...sockets.values()];
}

/** BoxLite logs "Port mappings: N (image: a, user: b, overridden: c)" just before that box's socket path. */
export function parsePortMappings(texts) {
  const boxes = new Map();
  for (const text of texts) {
    let pending = null;
    for (const line of text.split("\n")) {
      const counts =
        /Port mappings: (\d+) \(image: (\d+), user: (\d+), overridden: (\d+)\)/.exec(
          line,
        );
      if (counts) {
        const [total, image, user, overridden] = counts.slice(1).map(Number);
        pending = { total, image, user, overridden };
        continue;
      }
      const box =
        /\/bl-\d+\/([A-Za-z0-9_-]+)\/box\.sock|\bbox_id=([A-Za-z0-9_-]+)/.exec(
          line,
        );
      if (pending && box) {
        const id = box[1] ?? box[2];
        boxes.set(id, [...(boxes.get(id) ?? []), pending]);
        pending = null;
      }
    }
  }
  return boxes;
}

const boxliteLogs = () =>
  readdirSync(BOXLITE_LOGS)
    .filter((name) => name.startsWith("boxlite.log"))
    .sort()
    .map((name) => readFileSync(BOXLITE_LOGS + "/" + name, "utf8"));

function listenerSample(at, boxIds) {
  const sockets = wildcardListeners();
  assert(
    sockets.every((socket) => socket.owners.every((owner) => !owner.vm)),
    "VM_WILDCARD_LISTENER",
  );
  const mappings = parsePortMappings(boxliteLogs());
  for (const id of boxIds) {
    assert(mappings.has(id), "PORT_MAPPINGS_NOT_LOGGED");
    // The platform image declares no port, so nothing may be published for it.
    assert(
      mappings.get(id).every((m) => m.total === 0 && m.user === 0),
      "BOX_PORT_PUBLISHED",
    );
  }
  return {
    at,
    wildcard: sockets.map(({ family, port, owners }) => ({
      family,
      port,
      owners: owners.map((owner) => owner.comm),
    })),
    portMappings: Object.fromEntries(
      boxIds.map((id) => [id, mappings.get(id)]),
    ),
  };
}

const unifiedCgroup = (path) =>
  /^0::(\/\S*)$/m.exec(readFileSync(path, "utf8"))?.[1] ?? null;

function delegatedCgroup() {
  const api = unifiedCgroup("/proc/1/cgroup"),
    exec = unifiedCgroup("/proc/self/cgroup"),
    subtree = words(readFileSync(CGROUP + "/cgroup.subtree_control", "utf8"));
  assert(api === "/api", "API_NOT_IN_DELEGATED_LEAF");
  // docker exec cannot join the delegated root; runc falls back to PID 1's cgroup.
  assert(exec === "/api", "EXEC_OUTSIDE_DELEGATED_LEAF");
  assert(
    ["cpu", "memory", "pids"].every((name) => subtree.includes(name)),
    "CGROUP_CONTROLLERS_NOT_DELEGATED",
  );
  assert(
    words(readFileSync(CGROUP + "/cgroup.procs", "utf8")).length === 0,
    "PROCESS_IN_DELEGATED_ROOT",
  );
  return { api, exec, subtreeControl: subtree };
}

function boxCgroup(id, rootPid) {
  const directory = CGROUP + "/boxlite/" + id;
  assert(existsSync(directory), "BOX_CGROUP_MISSING");
  // BoxLite 0.9.7's default per-box max_processes.
  assert(
    readFileSync(directory + "/pids.max", "utf8").trim() === "1024",
    "BOX_PIDS_LIMIT_MISSING",
  );
  assert(
    words(readFileSync(directory + "/cgroup.procs", "utf8")).includes(
      String(rootPid),
    ),
    "BOX_OUTSIDE_ITS_CGROUP",
  );
  return { box: id, pidsMax: 1024, rootPid };
}

// Count only lines logged since this run started: a reused volume can keep
// failures from an earlier container started with API_CGROUP_DELEGATION=off
// or an older image. A line without a leading timestamp still counts.
export function countCgroupSetupFailures(texts, since) {
  return texts
    .flatMap((text) => text.split("\n"))
    .filter((line) => line.includes("Cgroup setup failed"))
    .filter((line) => !(Date.parse(line.slice(0, line.indexOf(" "))) < since))
    .length;
}

const cgroupSetupFailures = (since) =>
  countCgroupSetupFailures(boxliteLogs(), since);

async function helperChaos(stages, task) {
  const before = await waitCanonicalHelper("HELPER_NOT_CANONICAL");
  // The VM is chosen from this container's /proc and /data.
  assertChaosTarget();
  process.kill(before.vmPid, "SIGKILL");
  await waitFor(
    async () => processTable().get(before.vmPid),
    (vm) => !vm || vm.state === "Z",
    { timeout: 30000, interval: 200, code: "HELPER_VM_SURVIVED_KILL" },
  );
  // Deterministic: without its VM the box is no longer the probe's idle helper.
  assert(
    canonicalHelper(helperRows(), processTable())?.id !== before.id,
    "DEAD_HELPER_STILL_ACCEPTED",
  );
  const result = {
    killedBox: before.id,
    deadHelperRejected: true,
    // Evidence, not a verdict. Without a health check BoxLite 0.9.7 keeps the
    // box "running" until an exec or metrics attach fails, and whether
    // inspect's metrics reuses the cached live state (answering ok) depends on
    // when the JS box handle is garbage collected.
    diagnosisAfterKill: await diagnoseHelper(),
    healTrigger: stages.chaosLogin ? "claude-code-setup-token-cancelled" : null,
  };
  // Diagnosis is read-only and there is no background healing.
  if (!stages.chaosLogin) return result;
  const challenge = await request("/api/runtimes/claude-code/auth/begin", {
    method: "POST",
    body: { method: "setup-token" },
  });
  assert(
    typeof challenge?.challengeRef === "string" && challenge.challengeRef,
    "HELPER_LOGIN_NOT_STARTED",
  );
  await request(
    "/api/runtimes/claude-code/auth/sessions/" +
      encodeURIComponent(challenge.challengeRef),
    { method: "DELETE", expected: 204 },
  );
  const healed = await waitCanonicalHelper("HELPER_NOT_HEALED", {
    timeout: 300000,
    replacing: before.id,
  });
  assert(!existsSync(BOXES + "/" + before.id), "DEAD_HELPER_LEFT_BEHIND");
  // With the task still running: no process of the dead box survives, and
  // each root holds exactly its own VM.
  await waitFor(
    async () => vmTreeMatches(processTable(), [healed, task]),
    Boolean,
    { timeout: 30000, interval: 500, code: "VM_TREE_UNEXPECTED" },
  );
  assert(helperOutsideLedger(healed.id), "HELPER_IN_LEDGER");
  await waitFor(diagnoseHelper, (status) => status === "ok", {
    timeout: 120000,
    interval: 3000,
    code: "HEALED_HELPER_DIAGNOSIS_NOT_OK",
  });
  await waitFor(
    () => request("/api/deployment/status"),
    (status) => status.credentialAuth === 0,
    { timeout: 30000, interval: 500, code: "LOGIN_SESSION_NOT_RECLAIMED" },
  );
  return { ...result, healedBox: healed.id };
}

export async function runSmoke() {
  assertIsolation();
  const proof = {
    kind: "actual-platform-api-boxlite-linux-arm64-container",
    startedAt: new Date().toISOString(),
    node: process.version,
    state: "failed",
    noModelRequest: true,
    scope: { port: 3191, freshData: true, credentials: "ephemeral-smoke-only" },
    checks: {},
    cleanup: {},
  };
  let stage = "boot";
  let stages = null;
  let projectId;
  let sandboxId;
  let ownedBoxId;
  const boxId = (id) => {
    const Database = require("better-sqlite3");
    const database = new Database("/data/platform.db", { readonly: true });
    try {
      return database
        .prepare("select provider_handle from sandboxes where id = ?")
        .get(id)?.provider_handle;
    } finally {
      database.close();
    }
  };
  await mkdir("/data/proof", { recursive: true, mode: 0o700 });
  try {
    stages = smokeStages();
    if (stages.names.length) proof.stages = stages.names;
    await waitFor(
      async () => {
        try {
          return await request("/api/health", { authorized: false });
        } catch {
          return null;
        }
      },
      (value) => value?.status === "ok",
      { timeout: 120000 },
    );
    // Refuse a destructive run up front instead of after the whole chain.
    if (stages.chaos) assertChaosTarget();
    await request("/api/projects", { authorized: false, expected: 401 });
    const version = await request("/api/system/version");
    assert(
      version.commit === process.env.APP_COMMIT && version.commit,
      "BUILD_COMMIT_MISMATCH",
    );
    proof.version = version;
    const status = await request("/api/deployment/status");
    assert(
      status.ready && status.idle && !status.draining,
      "FRESH_API_NOT_READY_IDLE",
    );
    assert(
      (await request("/api/projects")).length === 0,
      "PROJECT_DATA_NOT_EMPTY",
    );
    assert(
      (await request("/api/sandboxes")).length === 0,
      "SANDBOX_DATA_NOT_EMPTY",
    );
    const providers = await request("/api/providers");
    assert(
      providers.filter((item) => item.isDefault).length === 1 &&
        providers.find((item) => item.name === "boxlite")?.isDefault,
      "DEFAULT_PROVIDER_NOT_BOXLITE",
    );
    const sandboxRequire = createRequire(
      "/app/packages/modules/sandbox/package.json",
    );
    assert(
      sandboxRequire("@boxlite-ai/boxlite/package.json").version === "0.9.7",
      "SDK_PIN_CHANGED",
    );
    proof.checks.http = {
      liveness: true,
      anonymous401: true,
      authenticatedReadiness: true,
    };
    proof.checks.defaultProvider = "boxlite";
    proof.checks.sdkVersion = "0.9.7";

    let helper = null;
    if (stages.helper || stages.cgroup || stages.listeners) {
      stage = "helper";
      helper = await waitCanonicalHelper("HELPER_NOT_CANONICAL");
    }
    if (stages.helper) {
      const diagnosis = await waitFor(diagnoseHelper, (s) => s === "ok", {
        timeout: 120000,
        interval: 3000,
        code: "HELPER_DIAGNOSIS_NOT_OK",
      });
      assert(vmTreeMatches(processTable(), [helper]), "UNEXPECTED_VM");
      assert(helperOutsideLedger(helper.id), "HELPER_IN_LEDGER");
      proof.checks.helper = {
        box: helper.id,
        name: HELPER_NAME,
        diagnosis,
        onlyVm: true,
        outsideLedger: true,
      };
    }
    if (stages.cgroup) {
      stage = "cgroup";
      proof.checks.cgroup = {
        delegation: delegatedCgroup(),
        boxes: [boxCgroup(helper.id, helper.pid)],
      };
    }
    if (stages.listeners) {
      stage = "listeners";
      proof.checks.listeners = [listenerSample("helper", [helper.id])];
    }

    stage = "capacity";
    const {
      OsHostCapacityProbe,
    } = require("/app/packages/modules/sandbox/dist/infrastructure/scheduler/host-capacity.probe.js");
    const measured = await new OsHostCapacityProbe().capacity();
    const cgroup = {
      cpuMax: (await readFile("/sys/fs/cgroup/cpu.max", "utf8")).trim(),
      memoryMax: (await readFile("/sys/fs/cgroup/memory.max", "utf8")).trim(),
    };
    assert(
      measured.cores === 4 && measured.ramMb === 6144,
      "CONTAINER_CAPACITY_NOT_CLAMPED",
    );
    const initialCapacity = (await request("/api/system/resources")).capacity;
    const images = await request("/api/images?provider=boxlite");
    const image = images.find(
      (item) => item.isProviderDefault && item.isActive,
    );
    assert(
      image && image.isBuiltin && image.ref.includes("agent-platform-boxlite"),
      "DEFAULT_IMAGE_INVALID",
    );
    assert(
      initialCapacity?.registeredTasks === 0 &&
        initialCapacity.remainingTasks > 0 &&
        initialCapacity.maxTasks <=
          Math.floor(measured.cores / image.resourceDefaults.cores) &&
        initialCapacity.maxTasks <=
          Math.floor(measured.ramMb / image.resourceDefaults.ramMb),
      "HTTP_CAPACITY_EXCEEDS_CGROUP",
    );
    proof.checks.capacity = {
      cgroup,
      measured,
      initial: initialCapacity,
      imageQuota: image.resourceDefaults,
    };
    if (stages.helper) {
      // At 4 cores / 6 GiB the helper's 1-core / 512 MB reservation leaves
      // maxTasks unchanged (floor(3.4 / 2) = floor(2.4 / 2)); the basis is the
      // only HTTP evidence that the scheduling pool deducts it.
      assert(
        /帐号登录环境预留 1 核 CPU、512 MB 内存/.test(
          initialCapacity.basis ?? "",
        ),
        "HELPER_RESERVATION_MISSING",
      );
      proof.checks.helper.reservationInBasis = true;
    }

    stage = "project";
    const project = await request("/api/projects", {
      method: "POST",
      expected: 202,
      body: {
        name: "Docker API smoke " + randomUUID().slice(0, 8),
        sourceType: "empty",
      },
    });
    projectId = project.id;
    assert(
      project.cloneStatus === "ready" && project.sourceType === "empty",
      "EMPTY_PROJECT_NOT_READY",
    );
    proof.projectId = projectId;

    stage = "provision";
    const accepted = await request("/api/sandboxes", {
      method: "POST",
      expected: 201,
      body: { projectId, runtime: "codex", headless: true, timeoutMinutes: 30 },
    });
    sandboxId = accepted.id;
    proof.sandboxId = sandboxId;
    const states = [];
    const running = await waitRunning(sandboxId, states);
    ownedBoxId = boxId(sandboxId);
    assert(
      typeof ownedBoxId === "string" && /^[A-Za-z0-9_-]+$/.test(ownedBoxId),
      "BOX_HANDLE_INVALID",
    );
    proof.boxId = ownedBoxId;
    assert(
      running.provider === "boxlite" && running.headless && running.hasRun,
      "SANDBOX_RUNTIME_MISMATCH",
    );
    proof.checks.task = {
      states,
      provider: running.provider,
      image: running.image,
      imageDigest: running.imageDigest,
      hasRun: true,
    };
    const occupied = (await request("/api/system/resources")).capacity;
    assert(
      occupied.registeredTasks === 1 &&
        occupied.remainingTasks === initialCapacity.remainingTasks - 1,
      "ALLOCATION_NOT_REGISTERED",
    );
    if (occupied.remainingTasks === 0) {
      await request("/api/sandboxes", {
        method: "POST",
        expected: 429,
        body: { projectId, runtime: "codex", headless: true },
      });
      assert(
        (await request("/api/sandboxes")).length === 1,
        "REJECTED_TASK_LEFT_RECORD",
      );
      proof.checks.capacity.exhaustionRejectedWithoutRecord = true;
    }
    // The task box is created after boxlite/ exists: the branch that used to
    // fail with EACCES on pids.max.
    if (stages.cgroup) {
      stage = "cgroup";
      proof.checks.cgroup.boxes.push(
        boxCgroup(ownedBoxId, boxRootPid(ownedBoxId)),
      );
    }
    if (stages.listeners) {
      stage = "listeners";
      proof.checks.listeners.push(
        listenerSample("task", [helper.id, ownedBoxId]),
      );
    }

    stage = "guest-exec";
    const marker = randomUUID();
    const exec = await request("/api/sandboxes/" + sandboxId + "/exec", {
      method: "POST",
      body: {
        command:
          "uname -r && node --version && codex --version && tmux -V && printf '%s' '" +
          marker +
          "' > /root/api-smoke-marker && cat /root/api-smoke-marker",
      },
    });
    assert(
      exec.exitCode === 0 && exec.stdout.includes(marker),
      "GUEST_EXEC_FAILED",
    );
    const lines = exec.stdout.trim().split(/\r?\n/);
    assert(
      lines.length >= 5 &&
        lines[1].startsWith("v") &&
        lines[2].includes("codex") &&
        lines[3].includes("tmux"),
      "GUEST_TOOLS_NOT_VERIFIED",
    );
    const { release } = await import("node:os");
    assert(lines[0] !== release(), "GUEST_KERNEL_NOT_SEPARATE");
    proof.checks.guest = {
      ownKernel: true,
      guestKernel: lines[0],
      containerKernel: release(),
      node: lines[1],
      codex: lines[2],
      tmux: lines[3],
      fileReadWrite: true,
    };

    stage = "terminal";
    proof.checks.terminal = await terminalProof(sandboxId);
    stage = "stop-start";
    const stopped = await request("/api/sandboxes/" + sandboxId + "/stop", {
      method: "POST",
    });
    assert(stopped.status === "stopped", "STOP_NOT_CONFIRMED");
    assert(
      (await request("/api/system/resources")).capacity.registeredTasks === 1,
      "STOP_RELEASED_ALLOCATION",
    );
    await request("/api/sandboxes/" + sandboxId + "/start", { method: "POST" });
    await waitRunning(sandboxId, []);
    const persisted = await request("/api/sandboxes/" + sandboxId + "/exec", {
      method: "POST",
      body: { command: "cat /root/api-smoke-marker" },
    });
    assert(
      persisted.exitCode === 0 && persisted.stdout.trim() === marker,
      "STOP_START_LOST_DISK",
    );
    assert(boxId(sandboxId) === ownedBoxId, "STOP_START_CHANGED_VM_ID");
    proof.checks.stopStart = {
      sameSandboxId: true,
      diskPreserved: true,
      stoppedAllocationRetained: true,
    };
    if (stages.listeners) {
      stage = "listeners";
      proof.checks.listeners.push(
        listenerSample("restart", [helper.id, ownedBoxId]),
      );
    }
    if (stages.chaos) {
      stage = "helper-chaos";
      proof.checks.helperChaos = await helperChaos(stages, {
        id: ownedBoxId,
        pid: boxRootPid(ownedBoxId),
      });
      const healed = proof.checks.helperChaos.healedBox;
      if (healed && stages.cgroup)
        proof.checks.cgroup.boxes.push(boxCgroup(healed, boxRootPid(healed)));
      if (healed && stages.listeners)
        proof.checks.listeners.push(
          listenerSample("healed", [healed, ownedBoxId]),
        );
    }
    if (stages.cgroup) {
      stage = "cgroup";
      proof.checks.cgroup.setupFailures = cgroupSetupFailures(
        Date.parse(proof.startedAt),
      );
      assert(
        proof.checks.cgroup.setupFailures === 0,
        "BOX_CGROUP_SETUP_FAILED",
      );
    }
    proof.state = "passed";
  } catch (error) {
    proof.error = {
      stage,
      code: /^[A-Z0-9_]+$/.test(error.message)
        ? error.message
        : "SMOKE_STAGE_FAILED",
    };
  } finally {
    // Cleanup only IDs returned by this invocation, including failed provisioning.
    if (sandboxId) {
      try {
        await request("/api/sandboxes/" + sandboxId, {
          method: "DELETE",
          expected: 204,
          body: { keepVolume: false },
        });
        proof.cleanup.sandboxDestroyed = true;
      } catch {
        proof.cleanup.sandboxDestroyed = false;
      }
    }
    if (projectId) {
      try {
        await request("/api/projects/" + projectId, {
          method: "DELETE",
          expected: 204,
          body: { keepBaseline: false },
        });
        proof.cleanup.projectDeleted = true;
      } catch {
        proof.cleanup.projectDeleted = false;
      }
    }
    try {
      // Each diagnose run leaves an engine.io polling session that counts as
      // an active WebSocket until it expires (pingInterval 25s + pingTimeout
      // 20s), so idle can trail the last diagnose by about 45 seconds.
      proof.finalStatus = await waitFor(
        () => request("/api/deployment/status"),
        (value) => value.idle && value.ready,
        { timeout: 90000, interval: 500 },
      );
      proof.cleanup.finalProjectsEmpty =
        (await request("/api/projects")).length === 0;
      proof.cleanup.finalSandboxesEmpty =
        (await request("/api/sandboxes")).length === 0;
      const boxes = await readdir("/data/boxlite/boxes");
      proof.cleanup.ownedBoxRemoved =
        !ownedBoxId || !boxes.includes(ownedBoxId);
      // The API preheats its own auth helper. It is not a task allocation and
      // remains in this disposable container until its caller stops the container.
      proof.remainingNonTaskBoxDirectories = boxes.length;
    } catch {
      proof.cleanup.finalIdle = false;
    }
    if (stages?.helper || stages?.chaos) {
      try {
        // Only the canonical helper's box may outlive the smoke's own task.
        const boxes = await readdir(BOXES);
        const [helper, ...others] = helperRows();
        proof.cleanup.onlyHelperBoxLeft =
          boxes.length === 1 && others.length === 0 && boxes[0] === helper?.id;
      } catch {
        proof.cleanup.onlyHelperBoxLeft = false;
      }
      // The release probe's steady state: a live canonical helper whose root
      // holds the only VM and every BoxLite process. A completed chaos run
      // without its login trigger rebuilt nothing, so then none may live.
      const chaos = proof.checks.helperChaos,
        helperExpected = !chaos || Boolean(chaos.healedBox);
      try {
        await waitFor(
          async () => {
            const processes = processTable();
            if (!helperExpected) return vmTreeMatches(processes, []);
            const helper = canonicalHelper(helperRows(), processes);
            return helper !== null && vmTreeMatches(processes, [helper]);
          },
          Boolean,
          { timeout: 30000, interval: 500 },
        );
        proof.cleanup.vmTreeAsReleaseProbe = true;
      } catch {
        proof.cleanup.vmTreeAsReleaseProbe = false;
      }
    }
    if (
      !Object.values(proof.cleanup).every(Boolean) ||
      !proof.finalStatus?.idle
    )
      proof.state = "failed";
    proof.finishedAt = new Date().toISOString();
    await writeFile(REPORT, JSON.stringify(proof, null, 2) + "\n", {
      mode: 0o600,
    });
  }
  console.log(JSON.stringify(proof));
  return proof;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const proof = await runSmoke();
    if (proof.state !== "passed") process.exitCode = 1;
  } catch {
    console.error(
      "Isolated API smoke could not run; no credential details emitted",
    );
    process.exitCode = 1;
  }
}
