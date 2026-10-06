import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const BASE = "http://127.0.0.1:3191";
const REPORT = "/data/proof/api-smoke.json";
const WS_HASH = "sb-terminal-v4";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const require = createRequire("/app/package.json");

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
  { timeout = 900000, interval = 1000 } = {},
) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await read();
    if (accepts(value)) return value;
    await sleep(interval);
  }
  throw new Error("POLL_TIMEOUT");
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
      proof.finalStatus = await waitFor(
        () => request("/api/deployment/status"),
        (value) => value.idle && value.ready,
        { timeout: 30000, interval: 500 },
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
