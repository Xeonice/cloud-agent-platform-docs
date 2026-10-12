import { test, expect } from "@playwright/test";
import * as fs from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { createRequire } from "node:module";
import { randomUUID, generateKeyPairSync, sign } from "node:crypto";
import { performance } from "node:perf_hooks";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { startUpgradeHarness } from "../server/start-upgrade.mjs";
import { createUpgradeFixture } from "../server/upgrade-fixture.mjs";
import { closeQualifiedInstallation } from "../native/close-qualified-installation.mjs";
import {
  populateQualifiedMaximum,
  maximumMigrationReceipt,
} from "../native/qualification-load.mjs";
import {
  startQualificationModel,
  qualificationPrompt,
  qualificationExitPrompt,
  configureQualificationImage,
} from "../server/qualification-model.mjs";
import { createDockerRoleAdapter } from "../../deploy/upgrade/docker-role-adapter.mjs";
import { inspectObservation } from "../../deploy/upgrade/circuit-breaker.mjs";
import { qualificationBusinessDatabasePath } from "../server/installer-filesystem.mjs";
import {
  command as actualCommand,
  unpackVerified,
} from "../../deploy/upgrade/artifacts.mjs";
import { readJson, atomicJson, fileDigest } from "../../deploy/upgrade/io.mjs";
import {
  digest,
  canonical,
  invariant,
  runInputFingerprint,
} from "../../deploy/upgrade/trust.mjs";

// All effects below target a fresh qualification instance. No route fulfillment,
// response substitution, mock provider, report import or external scenario driver.
// Missing immutable inputs/capabilities fail the corresponding test, never skip it.
const location = "acceptance/upgrade-faults.spec.mjs";
// A successful subcase cannot satisfy a broader mandatory row. Keep its native
// gate closed until every additional physical boundary has actually executed.
const additionalBoundaries = {};
const terminalStates = new Set([
  "failed",
  "reverted",
  "deferred",
  "candidate-rejected",
]);
const identifier = (value) => {
  invariant(
    /^[a-z][a-z0-9_]{0,80}$/.test(value),
    "FIXED_SQL_IDENTIFIER_REQUIRED",
  );
  return '"' + value + '"';
};
async function sourceFor(id) {
  invariant(
    process.platform === "linux" &&
      process.arch === "arm64" &&
      Number(process.versions.node.split(".")[0]) === 22,
    "LINUX_ARM64_NODE22_REQUIRED",
  );
  invariant(
    (await fs.stat("/dev/kvm")).isCharacterDevice(),
    "REAL_KVM_REQUIRED",
  );
  const path = process.env.UPGRADE_ACCEPTANCE_CONFIG;
  invariant(
    path && path === resolve(path),
    "FROZEN_NATIVE_CONFIGURATION_REQUIRED",
  );
  const stat = await fs.lstat(path);
  invariant(
    stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0,
    "PRIVATE_NATIVE_CONFIGURATION_REQUIRED",
  );
  const base = await readJson(path);
  invariant(
    base.isolated === true &&
      base.docker?.dedicated === true &&
      base.initialRoot &&
      base.archiveRoot,
    "REAL_ROLE_CONTAINER_INPUTS_REQUIRED",
  );
  const variant = base.matrixInputs?.[id];
  const input = { ...base, ...variant };
  if (id !== "X13") {
    delete input.installerFilesystem;
    delete input.businessDatabaseFilesystem;
  }
  input.modelMode ??= "external-model";
  invariant(
    ["external-model", "local-protocol-test"].includes(input.modelMode),
    "EXPLICIT_MODEL_MODE_REQUIRED",
  );
  // A data-only variant path must select its own immutable bytes rather than
  // accidentally inheriting the baseline inline manifest.
  if (variant?.targetManifestPath && variant.targetManifest === undefined)
    delete input.targetManifest;
  // Variant records contain data/immutable artifact paths only, never executable drivers.
  invariant(
    !input.driver && !input.scenarioModule && !input.fixtureProvider,
    "SCENARIO_DRIVER_FORBIDDEN",
  );
  input.root = join(
    base.root,
    "fault-matrix",
    id.replace(/[^a-zA-Z0-9-]/g, "-") + "-" + randomUUID(),
  );
  input.instanceId =
    "upgrade-acceptance-" +
    id.replace(/[^a-zA-Z0-9-]/g, "-").toLowerCase() +
    "-" +
    randomUUID().slice(0, 8);
  input.runId =
    "fault-" +
    id.replace(/[^a-zA-Z0-9-]/g, "-") +
    "-" +
    randomUUID().slice(0, 8);
  return input;
}
async function responseJson(
  request,
  origin,
  path,
  method = "GET",
  data,
  expected = 200,
  headers = {},
) {
  const response = await request.fetch(origin + path, {
    method,
    data,
    headers: { Origin: origin, "X-Operation-Id": randomUUID(), ...headers },
    timeout: 120000,
  });
  expect(response.status(), method + " " + path).toBe(expected);
  return expected === 204 ? null : response.json();
}
function observe(page) {
  const ready = [],
    traffic = [],
    output = [],
    connections = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/"))
      traffic.push({
        path: url.pathname,
        method: request.method(),
        at: performance.now(),
      });
  });
  page.on("websocket", (socket) =>
    socket.on("framereceived", (event) => {
      const text = String(event.payload);
      if (!text.startsWith("42/terminal,")) return;
      const decoded = JSON.parse(text.slice("42/terminal,".length));
      if (decoded[0] !== "frame") return;
      const frame = decoded[1];
      if (frame.type === "error")
        connections.push({
          type: "error",
          code: frame.code,
          at: performance.now(),
        });
      if (frame.type === "connection_state")
        connections.push({
          type: "connection_state",
          state: frame.state,
          at: performance.now(),
        });
      if (frame.type === "ready")
        ready.push({
          sandboxId: frame.sandboxId,
          terminalIdentity: frame.terminalIdentity,
          runtimeIdentity: frame.runtimeIdentity,
          existingSession: frame.existingSession,
          at: performance.now(),
        });
      if (frame.type === "data") {
        output.push(String(frame.data));
        if (output.length > 4000) output.splice(0, 1000);
      }
    }),
  );
  return { ready, traffic, output, connections };
}
async function typeInTerminal(page, text) {
  const input = page.locator(".xterm-helper-textarea:visible");
  await expect(input).toHaveCount(1);
  await input.focus();
  await page.keyboard.insertText(text);
  await page.keyboard.press("Enter");
}
async function actualGuest(request, origin, id) {
  const result = await responseJson(
    request,
    origin,
    `/api/sandboxes/${id}/exec`,
    "POST",
    {
      command:
        "printf 'PID '; cat /workspace/.upg-fault-proof/pid; printf 'BIRTH '; cat /workspace/.upg-fault-proof/birth; printf 'SEQ\\n'; cat /workspace/.upg-fault-proof/seq; printf 'TMUX\\n'; tmux list-sessions -F '#{pid}:#{session_id}:#{session_created}:#{session_name}'",
    },
  );
  expect(result.exitCode).toBe(0);
  const found = /^PID (\d+)\s+BIRTH (\d+)\s+SEQ\n([\d\n]+)TMUX\n([\s\S]*)/.exec(
    result.stdout,
  );
  expect(
    found,
    "actual guest /proc birth, durable seconds and tmux inventory",
  ).not.toBeNull();
  return {
    pid: Number(found[1]),
    birth: found[2],
    seq: found[3].trim().split("\n").map(Number),
    tmuxDigest: digest(found[4].trim().split("\n").sort()),
  };
}
async function actualHeadlessCounter(request, origin, sandboxId, proofId) {
  invariant(
    /^[a-f0-9-]{36}$/.test(proofId),
    "FIXED_HEADLESS_PROOF_ID_REQUIRED",
  );
  const folder = "/workspace/.upg-agent-proof/" + proofId;
  const result = await responseJson(
    request,
    origin,
    `/api/sandboxes/${sandboxId}/exec`,
    "POST",
    {
      command: `printf 'PID '; cat ${folder}/pid; printf 'BIRTH '; cat ${folder}/birth; printf 'LAUNCHES\\n'; cat ${folder}/launches; printf 'COUNTER\\n'; cat ${folder}/counter; printf 'LIVE '; p=$(cat ${folder}/pid); awk '{print $22}' /proc/$p/stat`,
    },
  );
  expect(result.exitCode).toBe(0);
  const actual =
    /^PID (\d+)\s+BIRTH (\d+)\s+LAUNCHES\n([\d\n]+)COUNTER\n([\d\n]+)LIVE (\d+)\s*$/.exec(
      result.stdout,
    );
  expect(
    actual,
    "Real CLI Bash-tool PID, live /proc birth and original durable seconds",
  ).not.toBeNull();
  const launches = actual[3].trim().split("\n").map(Number),
    counter = actual[4].trim().split("\n").map(Number);
  expect(launches).toEqual([Number(actual[1])]);
  expect(actual[5]).toBe(actual[2]);
  expect(counter).toEqual(
    Array.from({ length: counter.length }, (_, i) => i + 1),
  );
  return { pid: Number(actual[1]), birth: actual[2], launches, counter };
}
function probe(env) {
  const { request, origin, probeAutomation } = env;
  invariant(probeAutomation?.id, "REAL_DISABLED_PROBE_AUTOMATION_REQUIRED");
  const path = "/api/automations/" + probeAutomation.id;
  const samples = [],
    pending = new Set();
  let live = true,
    ticks = 0;
  const started = performance.now();
  const tick = () => {
    if (!live || pending.size >= 80) return;
    const n = ++ticks,
      operationId = randomUUID(),
      body = { name: "native-fault-probe-" + n };
    const work = (async () => {
      for (const kind of ["read", "write"]) {
        const at = performance.now();
        try {
          const response = await request.fetch(origin + path, {
            method: kind === "read" ? "GET" : "PUT",
            ...(kind === "write" ? { data: body } : {}),
            headers: { Origin: origin, "X-Operation-Id": operationId },
            timeout: 2000,
          });
          const result = await response.json();
          samples.push({
            kind,
            status: response.status(),
            latencyMs: performance.now() - at,
            at,
            tick: n,
            operationDigest: digest(operationId),
          });
          if (kind === "write" && response.status() === 200) {
            const duplicateAt = performance.now();
            const replay = await request.put(origin + path, {
              data: body,
              headers: { Origin: origin, "X-Operation-Id": operationId },
              timeout: 2000,
            });
            const duplicate = await replay.json();
            samples.push({
              kind: "dedup",
              status: replay.status(),
              sameId:
                duplicate.id === result.id && duplicate.name === result.name,
              at: duplicateAt,
              latencyMs: performance.now() - duplicateAt,
              tick: n,
            });
          }
        } catch {
          samples.push({
            kind,
            status: 0,
            latencyMs: performance.now() - at,
            at,
          });
        }
      }
    })().finally(() => pending.delete(work));
    pending.add(work);
  };
  tick();
  const timer = setInterval(tick, 50);
  return {
    samples,
    async stop() {
      live = false;
      clearInterval(timer);
      await Promise.all(pending);
      const seconds = (performance.now() - started) / 1000;
      return { samples, ticks, seconds, observedRateHz: ticks / seconds };
    },
  };
}
async function installation(id, page, context) {
  const input = await sourceFor(id);
  let model, fixture, harness;
  try {
    if (input.modelMode === "local-protocol-test") {
      model = await startQualificationModel({
        isolated: true,
        instanceId: input.instanceId,
        host: input.localModel?.bindHost ?? "127.0.0.1",
        guestHost: input.localModel?.guestHost ?? "host.boxlite.internal",
      });
      input.runtimeId = model.runtimeId;
      input.runtimeCredential = model.runtimeCredential;
      input.headlessProofId = randomUUID();
      input.headlessPrompt = qualificationPrompt(input.headlessProofId);
      if (input.automationInput)
        input.automationInput = {
          ...input.automationInput,
          runtime: model.runtimeId,
          prompt: qualificationPrompt(randomUUID()),
        };
      if (input.automationInput) delete input.automationInput.runtimeId;
    }
    fixture = await createUpgradeFixture(input);
    harness = await startUpgradeHarness(fixture.config);
  } catch (error) {
    await fixture?.close();
    await model?.close();
    throw error;
  }
  const config = fixture.config,
    origin = harness.entryOrigin,
    request = context.request,
    evidence = observe(page),
    owned = [];
  let database;
  try {
    expect(harness.native).toBe(true);
    expect(harness.isolation).toBe("containers");
    const require = createRequire(join(config.initialRoot, "api/package.json"));
    const Database = require("better-sqlite3");
    database = new Database(qualificationBusinessDatabasePath(config), {
      fileMustExist: true,
    });
    database.pragma("busy_timeout=2000");
    database.pragma("foreign_keys=ON");
    const adapter = await createDockerRoleAdapter({
      ...config.docker,
      instanceId: config.instanceId,
      installationRoot: config.root,
      installerRoot: join(config.root, "installer"),
      businessRoot: join(config.root, "business"),
      bindingRoot: join(config.root, "bindings"),
      trustRootPath: config.trustRootPath,
    });
    const state = () =>
      responseJson(request, origin, "/api/system/upgrade/status");
    const binding = () =>
      readJson(join(config.root, "entry/entry-binding.json"));
    const roleRecords = () => [
      ...Object.entries(harness.roleContainers).map(([name, record]) => ({
        ...record,
        name,
      })),
      ...harness.supervisor.ownedProcesses(),
    ];
    const role = (kind) => {
      const records = roleRecords().filter(
        (record) => record.kind === kind || record.name === kind,
      );
      invariant(records.length > 0, "ACTUAL_ROLE_RECORD_REQUIRED_" + kind);
      return records.at(-1);
    };
    const signal = async (record, how) => {
      invariant(record.containerId, "REAL_CONTAINER_RECORD_REQUIRED");
      const proof = await adapter.inspect(record.containerId);
      expect(proof.startIdentity).toBe(record.startIdentity);
      await adapter.signal(record.containerId, how);
    };
    const currentInstaller = async () => {
      const active = await readJson(
        join(config.root, "installer/controller-authority.json"),
        null,
      );
      return active
        ? roleRecords().find(
            (record) => record.startIdentity === active.startIdentity,
          )
        : harness.roleContainers.controller;
    };
    const stopController = async () => {
      const active = await currentInstaller();
      invariant(active, "ACTUAL_CONTROLLER_REQUIRED");
      await signal(active, "SIGKILL");
      await expect
        .poll(
          async () => !(await adapter.inspect(active.containerId)).running,
          {
            timeout: 5000,
          },
        )
        .toBe(true);
      return active;
    };
    const login = async () => {
      await page.goto(origin);
      // The dedicated fresh fixture enables a passcode. Wait for the hydrated
      // real gate and its successful browser response/cookie, never infer login
      // from a pre-hydration isVisible() snapshot or grant it through an API call.
      if (config.authEnv.ACCESS_PASSCODE) {
        const gate = page.getByRole("dialog", {
          name: "访问口令",
          exact: true,
        });
        await expect(gate).toBeVisible({ timeout: 30000 });
        const passcode = gate.locator('input[name="passcode"]');
        await expect(passcode).toHaveCount(1);
        await passcode.fill(config.authEnv.ACCESS_PASSCODE);
        const unlocked = page.waitForResponse(
          (response) =>
            new URL(response.url()).origin === origin &&
            new URL(response.url()).pathname === "/api/access/unlock" &&
            response.request().method() === "POST",
        );
        await gate.getByRole("button", { name: "解锁", exact: true }).click();
        const response = await unlocked;
        expect(response.ok(), "Actual browser passcode unlock succeeds").toBe(
          true,
        );
        await response.finished();
        await expect
          .poll(
            async () =>
              (await context.cookies(origin)).some(
                (cookie) => cookie.name === "ap_session" && cookie.httpOnly,
              ),
            { timeout: 10000 },
          )
          .toBe(true);
        await expect(gate).toHaveCount(0, { timeout: 30000 });
      }
      await expect
        .poll(async () => (await state()).instanceId)
        .toBe(config.instanceId);
    };
    await login();
    const init = await responseJson(request, origin, "/api/system/init-status");
    if (!init.initialized)
      await responseJson(
        request,
        origin,
        "/api/system/init",
        "POST",
        { acknowledgeOffline: true },
        201,
      );
    const imageProof = model
      ? await configureQualificationImage(request, origin, model)
      : null;
    const runtimeId = input.runtimeId ?? "codex";
    invariant(
      input.runtimeCredential && input.headlessPrompt,
      "DEDICATED_REAL_CLI_LOAD_INPUT_REQUIRED",
    );
    await responseJson(
      request,
      origin,
      `/api/runtimes/${runtimeId}/credentials/secret`,
      "POST",
      input.runtimeCredential,
    );
    const project = await responseJson(
      request,
      origin,
      "/api/projects",
      "POST",
      { name: "Native fault " + id, sourceType: "empty" },
      202,
    );
    const original = await responseJson(
      request,
      origin,
      "/api/sandboxes",
      "POST",
      {
        projectId: project.id,
        runtime: runtimeId,
        ...(imageProof ? { image: imageProof.imageManifestId } : {}),
      },
      201,
    );
    owned.push(original.id);
    await expect
      .poll(
        async () =>
          (await responseJson(request, origin, `/api/sandboxes/${original.id}`))
            .status,
        { timeout: 180000 },
      )
      .toBe("running");
    await page.goto(origin + "/?taskId=" + encodeURIComponent(original.id));
    await expect
      .poll(
        () =>
          evidence.ready.some(
            (row) => row.sandboxId === original.id && row.runtimeIdentity,
          ),
        { timeout: 10000 },
      )
      .toBe(true);
    const readyBeforeShell = evidence.ready.length;
    const newTerminalButton = page.getByTestId("terminal-tab-new");
    await expect(newTerminalButton).toBeVisible();
    const hasTerminalMenu =
      (await newTerminalButton.getAttribute("aria-haspopup")) === "menu";
    await newTerminalButton.click();
    if (hasTerminalMenu) {
      const shellOption = page.getByTestId("terminal-launch-shell");
      await expect(shellOption).toBeVisible();
      await shellOption.click();
    }
    await expect
      .poll(
        () =>
          evidence.ready
            .slice(readyBeforeShell)
            .find(
              (row) =>
                row.sandboxId === original.id &&
                row.existingSession !== undefined &&
                row.runtimeIdentity,
            )?.terminalIdentity,
        { timeout: 10000 },
      )
      .toBeTruthy();
    await typeInTerminal(
      page,
      "mkdir -p /workspace/.upg-fault-proof; printf '%s\\n' $$ > /workspace/.upg-fault-proof/pid; awk '{print $22}' /proc/$$/stat > /workspace/.upg-fault-proof/birth; i=0; while :; do i=$((i+1)); printf '%s\\n' $i >> /workspace/.upg-fault-proof/seq; printf 'UPG_SECONDS:%s\\n' $i; sleep 1; done",
    );
    await expect
      .poll(() => evidence.output.join("").includes("UPG_SECONDS:2"), {
        timeout: 10000,
      })
      .toBe(true);
    const before = await actualGuest(request, origin, original.id),
      terminal = evidence.ready.at(-1);
    const headless = await responseJson(
      request,
      origin,
      "/api/sandboxes",
      "POST",
      {
        projectId: project.id,
        runtime: runtimeId,
        headless: true,
        ...(imageProof ? { image: imageProof.imageManifestId } : {}),
      },
      201,
    );
    owned.push(headless.id);
    await expect
      .poll(
        async () =>
          (await responseJson(request, origin, `/api/sandboxes/${headless.id}`))
            .status,
        { timeout: 180000 },
      )
      .toBe("running");
    const task = await responseJson(
      request,
      origin,
      `/api/sandboxes/${headless.id}/runtimes/${runtimeId}/tasks`,
      "POST",
      { prompt: input.headlessPrompt, timeoutMinutes: 30 },
      202,
    );
    expect(task.status).toBe("running");
    let originalHeadless = null;
    if (model) {
      await expect
        .poll(
          () =>
            model
              .evidence()
              .requests.filter(
                (row) =>
                  row.taskId === input.headlessProofId &&
                  row.phase === "tool-issued",
              ).length,
          { timeout: 180000 },
        )
        .toBe(1);
      await expect
        .poll(
          async () => {
            originalHeadless = await actualHeadlessCounter(
              request,
              origin,
              headless.id,
              input.headlessProofId,
            );
            return originalHeadless.counter.length;
          },
          { timeout: 30000 },
        )
        .toBeGreaterThanOrEqual(2);
    }
    const originalJob = database
      .prepare("SELECT job_handle FROM agent_tasks WHERE id=?")
      .get(task.id)?.job_handle;
    expect(originalJob, "Actual original durable job handle").toBeTruthy();
    invariant(
      ["claude-code", "codex"].includes(runtimeId),
      "SUPPORTED_REAL_CLI_REQUIRED",
    );
    const cliProbe = await responseJson(
      request,
      origin,
      `/api/sandboxes/${headless.id}/exec`,
      "POST",
      {
        command:
          runtimeId === "claude-code" ? "claude --version" : "codex --version",
      },
    );
    expect(cliProbe.exitCode).toBe(0);
    expect(cliProbe.stdout.trim()).toMatch(/\d+\.\d+\.\d+/);
    const actualCliVersion = cliProbe.stdout.trim();
    const probeAutomation = await responseJson(
      request,
      origin,
      "/api/projects/" + project.id + "/automations",
      "POST",
      {
        name: "Native continuity probe",
        runtime: runtimeId,
        prompt:
          "Qualification probe remains disabled and must never launch a job.",
        scheduleKind: "hourly",
        scheduleConfig: { minute: (new Date().getUTCMinutes() + 30) % 60 },
        timezone: "UTC",
        timeoutMinutes: 30,
        artifactRetentionDays: 3,
      },
      201,
    );
    const disabledProbe = await responseJson(
      request,
      origin,
      "/api/automations/" + probeAutomation.id + "/disable",
      "POST",
      {},
    );
    expect(disabledProbe.enabled).toBe(false);
    const initial = await state();
    const authorize = async () => {
      const auth = await context.newPage();
      try {
        await auth.goto(origin + "/settings/system#version");
        await auth
          .getByRole("button", { name: "授权升级", exact: true })
          .click();
        await auth.getByLabel("实例升级授权密钥").fill(config.keys.upgrade);
        await auth
          .getByRole("dialog")
          .getByRole("button", { name: "授权升级", exact: true })
          .click();
        await expect(auth.getByRole("dialog")).toHaveCount(0);
      } finally {
        await auth.close();
      }
      expect((await state()).capabilities.canUpgradeInstance).toBe(true);
    };
    let acceptedIntent = null;
    const accept = async () => {
      await authorize();
      await page.reload();
      await page
        .getByRole("button", { name: "版本与更新", exact: true })
        .click();
      const accepted = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/api/system/upgrade/requests" &&
          response.request().method() === "POST",
      );
      await page
        .getByRole("dialog", { name: "版本与更新详情", exact: true })
        .getByRole("button", { name: "立即升级", exact: true })
        .click();
      const response = await accepted;
      expect(response.status()).toBe(202);
      const attempt = await response.json();
      expect(attempt.state).toBe("accepted");
      expect(attempt.instanceId).toBe(config.instanceId);
      const command = response.request().postDataJSON(),
        row = database
          .prepare(
            "SELECT actor_id,request_id,request_digest,target_release_id,target_digest,plan,accepted_at FROM upgrade_attempts WHERE instance_id=? AND attempt_id=?",
          )
          .get(config.instanceId, attempt.attemptId);
      expect(
        Boolean(row),
        "Real browser upgrade POST is durably accepted",
      ).toBe(true);
      expect(
        row.actor_id === "instance-administrator",
        "Actual instance upgrade permission owns the command",
      ).toBe(true);
      expect(row.request_id).toBe(command.requestId);
      expect(row.request_id).toBe(attempt.requestId);
      expect(row.target_release_id).toBe(command.targetReleaseId);
      expect(row.target_digest).toBe(command.targetDigest);
      expect(row.target_digest).toBe(attempt.targetDigest);
      expect(row.request_digest).toBe(digest(command));
      expect(JSON.parse(row.plan).sourceActivationGeneration).toBe(
        command.expectedActivationGeneration,
      );
      expect(row.accepted_at).toBe(Date.parse(attempt.acceptedAt));
      acceptedIntent = {
        actorDigest: digest(row.actor_id),
        requestId: row.request_id,
        requestDigest: row.request_digest,
        targetReleaseId: row.target_release_id,
        targetDigest: row.target_digest,
        expectedActivationGeneration: command.expectedActivationGeneration,
        acceptedAt: attempt.acceptedAt,
        admittedThroughRealBrowserPost: true,
      };
      return attempt;
    };
    const until = async (predicate) => {
      await expect
        .poll(async () => predicate(await state(), await binding()), {
          timeout: 900000,
          intervals: [10, 25, 100],
        })
        .toBe(true);
      return state();
    };
    const history = (id) =>
      database
        .prepare(
          "SELECT kind,payload,generation FROM upgrade_events WHERE attempt_id=? ORDER BY sequence",
        )
        .all(id);
    const continuity = async () => {
      const after = await actualGuest(request, origin, original.id);
      expect(after.pid).toBe(before.pid);
      expect(after.birth).toBe(before.birth);
      expect(after.tmuxDigest).toBe(before.tmuxDigest);
      expect(after.seq).toEqual(
        Array.from({ length: after.seq.length }, (_, i) => i + 1),
      );
      expect(after.seq.length).toBeGreaterThan(before.seq.length);
      const current = await responseJson(
        request,
        origin,
        `/api/sandboxes/${headless.id}/tasks/${task.id}`,
      );
      expect(current.id).toBe(task.id);
      expect(current.status).toBe("running");
      expect(current.lastSeq).toBeGreaterThanOrEqual(task.lastSeq ?? 0);
      expect(
        database
          .prepare("SELECT job_handle FROM agent_tasks WHERE id=?")
          .get(task.id)?.job_handle,
      ).toBe(originalJob);
      const headlessCounter = model
        ? await actualHeadlessCounter(
            request,
            origin,
            headless.id,
            input.headlessProofId,
          )
        : null;
      if (headlessCounter) {
        expect(headlessCounter.pid).toBe(originalHeadless.pid);
        expect(headlessCounter.birth).toBe(originalHeadless.birth);
        expect(
          headlessCounter.counter.slice(0, originalHeadless.counter.length),
        ).toEqual(originalHeadless.counter);
        expect(headlessCounter.counter.length).toBeGreaterThan(
          originalHeadless.counter.length,
        );
        expect(
          model
            .evidence()
            .requests.filter(
              (row) =>
                row.taskId === input.headlessProofId &&
                row.phase === "tool-issued",
            ),
        ).toHaveLength(1);
      }
      return {
        guest: after,
        taskId: task.id,
        lastSeq: current.lastSeq,
        jobIdentityDigest: digest(originalJob),
        headlessCounter,
        taskObservationWindow: observedTaskWindow({
          model,
          input,
          database,
          task,
        }),
      };
    };
    const resumeTerminal = async () => {
      const from = evidence.ready.length,
        start = performance.now();
      await page.reload();
      await expect
        .poll(
          () =>
            evidence.ready
              .slice(from)
              .some(
                (row) =>
                  row.terminalIdentity === terminal.terminalIdentity &&
                  row.runtimeIdentity === terminal.runtimeIdentity &&
                  row.existingSession,
              ),
          { timeout: 5000, intervals: [25, 50] },
        )
        .toBe(true);
      return performance.now() - start;
    };
    const clean = async ({ preserveResources = false } = {}) => {
      let cleaned = false,
        cleanup,
        businessCleanup = null;
      try {
        if (!preserveResources) {
          // Only this fresh qualification instance may be enumerated. Projects
          // include real CRUD/maximum-load additions, not just the original one.
          const scope = await state(),
            proof = await readJson(fixture.installationProofPath),
            started = await readJson(join(config.root, "startup-intent.json")),
            instances = database
              .prepare("SELECT instance_id FROM upgrade_instances")
              .all(),
            main = database
              .pragma("database_list")
              .find((row) => row.name === "main");
          invariant(
            config.isolated === true &&
              config.docker?.dedicated === true &&
              harness.isolation === "containers" &&
              harness.instanceId === config.instanceId &&
              scope.instanceId === config.instanceId &&
              config.root === input.root &&
              harness.root === resolve(config.root) &&
              proof.purpose === "qualification" &&
              proof.instanceId === config.instanceId &&
              proof.isolatedRoot === config.root &&
              started.instanceId === config.instanceId &&
              started.initialRoot === config.initialRoot &&
              instances.length === 1 &&
              instances[0].instance_id === config.instanceId &&
              main &&
              (await fs.realpath(main.file)) ===
                (await fs.realpath(qualificationBusinessDatabasePath(config))),
            "OWNED_QUALIFICATION_CLEANUP_SCOPE_UNCONFIRMED",
          );
          const projects = await responseJson(request, origin, "/api/projects");
          invariant(
            Array.isArray(projects) &&
              projects.every((row) => /^[a-f0-9-]{36}$/.test(row.id)),
            "OWNED_QUALIFICATION_PROJECT_LIST_UNCONFIRMED",
          );
          const projectIds = new Set(projects.map((row) => row.id)),
            persistedProjects = database
              .prepare("SELECT id FROM projects ORDER BY id")
              .all(),
            completedHistoryBefore = database
              .prepare(
                "SELECT task_id,sandbox_id,provider,payload,state,created_at FROM agent_task_start_intents WHERE state='complete' ORDER BY task_id",
              )
              .all();
          invariant(
            projectIds.size === projects.length &&
              persistedProjects.length === projects.length &&
              persistedProjects.every((row) => projectIds.has(row.id)),
            "OWNED_QUALIFICATION_PROJECT_SCOPE_CHANGED",
          );
          const rules = [];
          for (const projectId of projectIds) {
            const listed = await responseJson(
              request,
              origin,
              `/api/projects/${projectId}/automations`,
            );
            invariant(
              Array.isArray(listed) &&
                listed.every(
                  (rule) =>
                    rule.projectId === projectId &&
                    /^[a-f0-9-]{36}$/.test(rule.id),
                ),
              "OWNED_QUALIFICATION_RULE_SCOPE_CHANGED",
            );
            for (const rule of listed) {
              if (rule.enabled) {
                const disabled = await responseJson(
                  request,
                  origin,
                  `/api/automations/${rule.id}/disable`,
                  "POST",
                  {},
                );
                expect(disabled.enabled).toBe(false);
              }
              rules.push(rule.id);
            }
          }
          // Include a due automation's committed sandbox even if its original
          // admission acknowledgement was lost. Every ID stays in this scope.
          const resources = database
            .prepare("SELECT id,project_id,status FROM sandboxes")
            .all();
          invariant(
            resources.every(
              (row) =>
                /^[a-f0-9-]{36}$/.test(row.id) &&
                projectIds.has(row.project_id),
            ),
            "OWNED_QUALIFICATION_SANDBOX_SCOPE_CHANGED",
          );
          for (const resource of resources) {
            const tasks = database
              .prepare(
                "SELECT id FROM agent_tasks WHERE sandbox_id=? AND status='running'",
              )
              .all(resource.id);
            for (const active of tasks)
              await responseJson(
                request,
                origin,
                `/api/sandboxes/${resource.id}/tasks/${active.id}/cancel`,
                "POST",
                {},
                202,
              );
            if (resource.status !== "destroyed")
              await responseJson(
                request,
                origin,
                `/api/sandboxes/${resource.id}`,
                "DELETE",
                { keepVolume: false },
                204,
              );
          }
          for (const ruleId of rules)
            await responseJson(
              request,
              origin,
              `/api/automations/${ruleId}`,
              "DELETE",
              {},
              204,
            );
          let deletedVolumes = 0;
          for (const projectId of projectIds) {
            const volumes = await responseJson(
              request,
              origin,
              `/api/retained-volumes?projectId=${projectId}`,
            );
            invariant(
              Array.isArray(volumes) &&
                volumes.every(
                  (volume) =>
                    volume.projectId === projectId &&
                    /^[a-f0-9-]{36}$/.test(volume.id),
                ),
              "OWNED_QUALIFICATION_VOLUME_SCOPE_CHANGED",
            );
            for (const volume of volumes) {
              await responseJson(
                request,
                origin,
                `/api/retained-volumes/${volume.id}`,
                "DELETE",
                {},
                204,
              );
              deletedVolumes++;
            }
            await responseJson(
              request,
              origin,
              `/api/projects/${projectId}`,
              "DELETE",
              { keepBaseline: false },
              204,
            );
          }
          const liveTables = [
              "sandboxes",
              "projects",
              "agent_tasks",
              "automation_runs",
              "automation_launch_intents",
              "automations",
              "terminal_bookmarks",
              "retained_volumes",
              "sandbox_project_cleanup_jobs",
            ],
            cleanupDeadline = performance.now() + 120000;
          let counts;
          while (true) {
            counts = Object.fromEntries(
              liveTables.map((table) => [
                table,
                database.prepare("SELECT count(*) n FROM " + table).get().n,
              ]),
            );
            if (Object.values(counts).every((n) => n === 0)) break;
            invariant(
              performance.now() < cleanupDeadline,
              "OWNED_QUALIFICATION_CLEANUP_NOT_COMPLETE",
            );
            await delay(250);
          }
          const history = database
            .prepare(
              "SELECT task_id,sandbox_id,provider,payload,state,created_at FROM agent_task_start_intents ORDER BY task_id",
            )
            .all();
          invariant(
            history.every((row) => row.state === "complete") &&
              completedHistoryBefore.every((prior) =>
                history.some((row) => canonical(row) === canonical(prior)),
              ),
            "OWNED_QUALIFICATION_COMPLETED_HISTORY_CHANGED",
          );
          businessCleanup = {
            instanceId: config.instanceId,
            projectIds: [...projectIds],
            rulesDeleted: rules.length,
            sandboxesObserved: resources.length,
            retainedVolumesDeleted: deletedVolumes,
            liveTableCounts: counts,
            completedStartIntentHistory: {
              before: completedHistoryBefore.length,
              after: history.length,
              preserved: true,
              digest: digest(history),
            },
            cleanedThroughPublicApi: true,
            observedAt: new Date().toISOString(),
          };
          cleaned = true;
        }
      } finally {
        database.close();
        try {
          cleanup = await closeQualifiedInstallation({
            harness,
            fixture,
            resourcesCleaned: cleaned,
          });
        } finally {
          await model?.close();
        }
      }
      return { ...cleanup, businessCleanup };
    };
    return {
      input,
      fixture,
      config,
      harness,
      adapter,
      database,
      request,
      page,
      origin,
      evidence,
      original,
      owned,
      headless,
      model,
      imageProof,
      actualCliVersion,
      probeAutomation,
      task,
      project,
      before,
      terminal,
      initial,
      state,
      binding,
      role,
      roleRecords,
      signal,
      stopController,
      authorize,
      accept,
      get acceptedIntent() {
        return acceptedIntent;
      },
      until,
      history,
      continuity,
      resumeTerminal,
      clean,
    };
  } catch (error) {
    // A failed setup preserves every created Guest and durable task for diagnosis.
    // It never infers absence from a missing ACK or removes them in a catch path.
    database?.close();
    const modelEvidence = model?.evidence() ?? null;
    if (modelEvidence) error.qualificationModelEvidence = modelEvidence;
    try {
      await closeQualifiedInstallation({
        harness,
        fixture,
        resourcesCleaned: false,
      });
    } finally {
      await model?.close();
    }
    throw error;
  }
}
function observedTaskWindow(env) {
  const observedAt = new Date().toISOString(),
    issued = env.model
      ?.evidence()
      .requests.find(
        (row) =>
          row.taskId === env.input.headlessProofId &&
          row.phase === "tool-issued",
      );
  let timeoutMs = null;
  try {
    timeoutMs =
      env.database
        .prepare("SELECT timeout_ms FROM agent_tasks WHERE id=?")
        .get(env.task.id)?.timeout_ms ?? null;
  } catch {
    // A failed shared-DB observation stays unknown, including this diagnostic.
  }
  return {
    observedAt,
    originalTaskStartedAt: env.task.startedAt,
    platformTaskTimeoutMs: timeoutMs,
    declaredModelBashTimeoutMs: env.model ? 600000 : null,
    actualModelToolIssuedAt: issued?.at ?? null,
    observedModelToolAgeMs: issued
      ? Date.parse(observedAt) - Date.parse(issued.at)
      : null,
  };
}
async function recordCase(id, page, context, info, body) {
  let env,
    sampler,
    probeResult,
    cleaned = false,
    succeeded = false;
  const assertions = [],
    started = performance.now(),
    measurementWindow = { startedAt: new Date().toISOString() };
  let actual = { stage: "native-input-preflight", measurementWindow };
  try {
    env = await installation(id, page, context);
    measurementWindow.originalSetupCompletedAt = new Date().toISOString();
    sampler = probe(env);
    actual = {
      instanceId: env.config.instanceId,
      initialRelease: env.initial.confirmedServiceRelease?.releaseId,
      originalSandboxId: env.original.id,
      originalTaskId: env.task.id,
      roleContainers: env.harness.roleContainers,
      modelMode: env.input.modelMode,
      modelQualityQualified: false,
      imageProof: env.imageProof,
      runtimeId: env.input.runtimeId ?? "codex",
      actualCliVersion: env.actualCliVersion,
      measurementWindow,
    };
    const { afterContinuity, semanticContractEvidence, ...result } =
      await body(env);
    measurementWindow.faultBodyCompletedAt = new Date().toISOString();
    probeResult = await sampler.stop();
    sampler = null;
    const preserved = await env.continuity();
    measurementWindow.originalContinuityConfirmedAt = new Date().toISOString();
    const qualificationModel = env.model?.evidence() ?? null;
    let subsequent = {};
    if (afterContinuity) {
      // This callback is defined below in this source, never supplied by native
      // configuration. Finish measuring/cleaning the first real installation
      // before launching the independent second fault installation.
      cleaned = true;
      actual.initialCleanup = await env.clean();
      subsequent = await afterContinuity();
    }
    const missing = additionalBoundaries[id] ?? [];
    if (semanticContractEvidence) {
      assertions.push({
        id: "semantic-contract",
        result: "passed",
        description:
          "Exact signed semantic plan executed through authorized UI, retired real legacy readers and preserved original jobs and actual CRUD",
        expectLocation: location,
        actualEvidence: {
          ...semanticContractEvidence,
          preserved,
          probes: probeResult,
        },
      });
    }
    assertions.push({
      id,
      result: missing.length ? "partial" : "passed",
      description: "Actual native fault boundary and original task continuity",
      expectLocation: location,
      actualEvidence: {
        ...actual,
        ...result,
        ...subsequent,
        acceptedIntent: env.acceptedIntent,
        preserved,
        probes: probeResult,
        qualificationModel,
        missingBoundaries: missing,
      },
    });
    expect(
      missing,
      "Every physical boundary required by this matrix row must execute",
    ).toEqual([]);
    succeeded = true;
  } catch (error) {
    assertions.push({
      id,
      result: "failed",
      description: "Native scenario did not satisfy its actual assertions",
      expectLocation: location,
      actualEvidence: {
        ...actual,
        reason: error.code ?? "NATIVE_ASSERTION_FAILED",
        taskObservationWindow: env ? observedTaskWindow(env) : null,
        independentFailureWindow: error.qualificationWindow ?? null,
        qualificationModel:
          env?.model?.evidence() ?? error.qualificationModelEvidence ?? null,
      },
    });
    throw error;
  } finally {
    if (sampler) probeResult = await sampler.stop();
    measurementWindow.measurementCompletedAt = new Date().toISOString();
    measurementWindow.elapsedMs = performance.now() - started;
    let cleanup, cleanupError;
    if (env && !cleaned) {
      try {
        cleanup = await env.clean({ preserveResources: !succeeded });
      } catch (error) {
        cleanupError = error;
        cleanup = {
          rolesStopped: false,
          reason: error.code ?? "CLEANUP_UNCONFIRMED",
        };
      }
    } else cleanup = actual.initialCleanup ?? { preserved: true };
    const path = info.outputPath("upg-assertions.json");
    await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await fs.writeFile(
      path,
      JSON.stringify({ assertions, probes: probeResult, cleanup }, null, 2) +
        "\n",
      { mode: 0o600 },
    );
    await info.attach("UPG assertions", {
      path,
      contentType: "application/json",
    });
    if (cleanupError) throw cleanupError;
  }
}

async function signalOwnedNode(env, record, signal) {
  invariant(
    ["SIGSTOP", "SIGCONT"].includes(signal),
    "FIXED_NODE_FAULT_SIGNAL_REQUIRED",
  );
  const before = await env.adapter.inspect(record.containerId);
  expect(before.startIdentity).toBe(record.startIdentity);
  expect(before.running).toBe(true);
  expect(before.pidNamespace).toBe("private");
  expect(before.entrypoint).toHaveLength(1);
  expect(before.entrypoint[0]).toMatch(/^\/usr\/(?:local\/)?bin\/node$/);
  // Docker kill targets only the exact installation-owned container's Node PID1.
  // It does not freeze its cgroup, VM/shim, the daemon or the host PID namespace.
  await actualCommand(env.config.docker.cli || "docker", [
    ...env.config.docker.args,
    "kill",
    "--signal",
    signal,
    record.containerId,
  ]);
  const after = await env.adapter.inspect(record.containerId);
  expect(after.hostPid).toBe(before.hostPid);
  expect(after.startedAt).toBe(before.startedAt);
  expect(after.startIdentity).toBe(before.startIdentity);
  return {
    signal,
    role: before.role,
    containerId: before.containerId,
    startIdentity: before.startIdentity,
    hostPid: before.hostPid,
    startedAt: before.startedAt,
    imageDigest: before.imageDigest,
  };
}

async function absentGitRemote() {
  // A real local HTTP Git remote with no repository, reachable from the isolated
  // host-network Coordinator. Never bypass the production loopback-host policy.
  const address = Object.values(networkInterfaces())
    .flat()
    .find(
      (row) =>
        row &&
        !row.internal &&
        row.family === "IPv4" &&
        /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2[0-9]|3[01])\.)/.test(row.address),
    )?.address;
  invariant(address, "DEDICATED_PRIVATE_LAN_GIT_FIXTURE_REQUIRED");
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({
      method: req.method,
      pathDigest: digest(req.url),
      at: new Date().toISOString(),
    });
    res.writeHead(404, {
      "content-type": "text/plain",
      "cache-control": "no-store",
    });
    res.end("Repository is absent in this isolated qualification fixture.");
  });
  await new Promise((ok, fail) => {
    server.once("error", fail);
    server.listen(0, address, ok);
  });
  return {
    url: `http://${address}:${server.address().port}/absent.git`,
    requests,
    close: () => new Promise((ok) => server.close(ok)),
  };
}

async function readOwnerResources(env, sandboxIds) {
  const ownerHome = join(env.config.root, "original-owner"),
    path = join(ownerHome, "boxlite/db/boxlite.db");
  const stat = await fs.lstat(path);
  invariant(
    stat.isFile() &&
      !stat.isSymbolicLink() &&
      (await fs.realpath(path)) === path,
    "ORIGINAL_OWNER_SDK_DATABASE_UNKNOWN",
  );
  // This is the isolated installation supervisor's readonly SQLite observation.
  // No SDK module/factory is imported, no replacement Owner is opened and the
  // Controller never receives this home, DB mount or observation capability.
  const Database = createRequire(
      join(env.config.initialRoot, "api/package.json"),
    )("better-sqlite3"),
    sdk = new Database(path, { readonly: true, fileMustExist: true });
  try {
    sdk.pragma("query_only=ON");
    const boxes = sdk
      .prepare(
        "SELECT c.id,c.name,s.status,s.pid FROM box_config c LEFT JOIN box_state s ON s.id=c.id ORDER BY c.id",
      )
      .all();
    return sandboxIds.map((sandboxId) => {
      const business = env.database
          .prepare(
            "SELECT id,status,provider,provider_handle,workspace_path FROM sandboxes WHERE id=?",
          )
          .get(sandboxId),
        box = boxes.find((row) => row.id === business?.provider_handle);
      invariant(
        business?.provider === "boxlite" && box,
        "ORIGINAL_OWNER_SDK_IDENTITY_UNCONFIRMED",
      );
      return {
        sandboxId,
        businessStatus: business.status,
        runtimeIdentity: box.id,
        boxName: box.name,
        sdkStatus: box.status,
        shimPid: box.pid,
        workspacePath: business.workspace_path,
      };
    });
  } finally {
    sdk.close();
  }
}

async function hostCounter(env, sandboxId, headless = false) {
  const row = env.database
    .prepare("SELECT workspace_path FROM sandboxes WHERE id=?")
    .get(sandboxId);
  const expected = join(env.config.root, "business/workspaces", sandboxId);
  invariant(
    row?.workspace_path === expected &&
      (await fs.realpath(expected)) === expected,
    "ORIGINAL_WORKSPACE_IDENTITY_UNCONFIRMED",
  );
  const folder = headless
    ? join(expected, ".upg-agent-proof", env.input.headlessProofId)
    : join(expected, ".upg-fault-proof");
  invariant(
    (await fs.realpath(folder)) === folder,
    "ORIGINAL_COUNTER_PATH_UNCONFIRMED",
  );
  const values = (
    await fs.readFile(join(folder, headless ? "counter" : "seq"), "utf8")
  )
    .trim()
    .split("\n")
    .map(Number);
  expect(
    values.every((value) => Number.isSafeInteger(value) && value > 0),
  ).toBe(true);
  return values;
}

async function ownerAudit(env) {
  const response = await fetch(
    `http://127.0.0.1:${env.harness.ports.owner}/runtime/continuity`,
    {
      headers: {
        "x-platform-internal-key": env.config.keys.owner,
        "x-platform-instance-id": env.config.instanceId,
      },
      signal: AbortSignal.timeout(2000),
    },
  );
  expect(response.ok).toBe(true);
  const audit = await response.json();
  expect(audit.instanceId).toBe(env.config.instanceId);
  expect(audit.ownerId).toBe("original-owner");
  return audit;
}

async function secondRecoveryFailure(browser) {
  const context = await browser.newContext(),
    page = await context.newPage();
  let env,
    sampler,
    stoppedWeb = false,
    stoppedReader = false,
    succeeded = false,
    result;
  try {
    env = await installation("X09", page, context);
    sampler = probe(env);
    const installed = await env.accept();
    await env.until((s) => s.attempt?.state === "activation-confirmed");
    await env.stopController();
    let lease;
    await expect
      .poll(
        async () => {
          try {
            lease = await env.harness.coordinator.claim(installed.attemptId, {
              controllerId: "native-fixed-recovery-intent",
              leaseMs: 15000,
            });
            return true;
          } catch {
            return false;
          }
        },
        { timeout: 45000, intervals: [100, 250] },
      )
      .toBe(true);
    const snapshot = await env.harness.coordinator.snapshot(
      installed.attemptId,
    );
    expect(snapshot.plan.coordinatorReused).toBe(false);
    const successHistory = env
      .history(installed.attemptId)
      .filter((row) => row.kind === "activation-confirmed");
    expect(successHistory).toHaveLength(1);
    const retained = env.harness.roleContainers.coordinator,
      web = env.role("web"),
      writerBefore = await readJson(env.harness.bindingPath),
      namesBefore = env.database
        .prepare("SELECT id,name FROM projects ORDER BY id")
        .all();
    expect(writerBefore.artifactDigest).toBe(
      env.fixture.envelope.manifest.components.coordinator.artifactDigest,
    );
    const readerIdentity = await fetch(
      `http://127.0.0.1:${env.harness.ports.coordinator}/internal/application/identity`,
      {
        headers: {
          "x-platform-internal-key": env.config.keys.control,
          "x-platform-instance-id": env.config.instanceId,
        },
        signal: AbortSignal.timeout(2000),
      },
    );
    expect(readerIdentity.ok).toBe(true);
    const readerProof = await readerIdentity.json();
    expect(readerProof.role).toBe("coordinator");
    expect(readerProof.startIdentity).toBe(retained.startIdentity);
    expect(readerProof.writerFenceValid).toBe(false);
    expect(readerProof.activeMutations).toBe(0);
    const webFault = await signalOwnedNode(env, web, "SIGSTOP");
    stoppedWeb = true;
    await expect(
      fetch(web.origin + "/web-process", {
        signal: AbortSignal.timeout(1500),
      }),
    ).rejects.toThrow();
    const fault = {
      code: "NATIVE_WEB_PROCESS_UNREACHABLE",
      observedAt: new Date().toISOString(),
      physicalProcess: webFault,
      actual: await env.binding(),
    };
    const revoked = await env.harness.coordinator.commit(installed.attemptId, {
      fence: lease.fence,
      generation: snapshot.attempt.generation,
      expectedSequence: snapshot.attempt.sequence,
      eventId: randomUUID(),
      kind: "ready-revoked",
      payload: { reason: fault.code, evidence: fault },
    });
    const eligibility = await env.harness.coordinator.fallbackEligibility(
      installed.attemptId,
      {
        fence: lease.fence,
        fault,
        actual: await env.binding(),
      },
    );
    expect(eligibility.qualified).toBe(true);
    expect(eligibility.coordinator.startIdentity).toBe(retained.startIdentity);
    const recoveryPlan = {
      schemaVersion: 1,
      triggeringAttemptId: installed.attemptId,
      eligibilityDigest: digest(eligibility),
      api: eligibility.api || null,
      web: eligibility.web || null,
      coordinator: eligibility.coordinator || null,
      owner: eligibility.owner || null,
      componentScope: eligibility.componentScope,
      faultDigest: digest(fault),
    };
    recoveryPlan.planDigest = digest(recoveryPlan);
    const recoveryAttemptId = randomUUID();
    const acceptedRecovery = await env.harness.coordinator.commit(
      installed.attemptId,
      {
        fence: lease.fence,
        generation: snapshot.attempt.generation,
        expectedSequence: revoked.attempt.sequence,
        eventId: randomUUID(),
        kind: "recovery-started",
        payload: {
          recoveryAttemptId,
          recoveryPlan,
          eligibility,
          reason: fault.code,
        },
      },
    );
    expect(acceptedRecovery.recovery.recoveryAttemptId).toBe(recoveryAttemptId);
    expect(acceptedRecovery.recovery.state).toBe("recovering");
    const fixed = await env.harness.coordinator.snapshot(installed.attemptId);
    expect(fixed.recoveryPlan.planDigest).toBe(recoveryPlan.planDigest);
    // Only after the actual server has admitted a qualified fixed recovery plan
    // do we remove its pure old reader. B's writer and original RuntimeOwner stay live.
    const readerFault = await signalOwnedNode(env, retained, "SIGSTOP");
    stoppedReader = true;
    await signalOwnedNode(env, web, "SIGCONT");
    stoppedWeb = false;
    const restarted = await env.harness.restartController();
    expect(restarted.artifactDigest).toBe(
      env.fixture.envelope.manifest.components.installer.artifactDigest,
    );
    const failed = await env.until(
      (s) =>
        s.recovery?.recoveryAttemptId === recoveryAttemptId &&
        s.recovery.state === "unknown",
    );
    expect(failed.attempt.state).toBe("activation-confirmed");
    expect(failed.attempt.percent).toBe(100);
    expect(failed.availableWeb?.ready).not.toBe(true);
    const failedRecord = await env.harness.coordinator.snapshot(
      installed.attemptId,
    );
    expect(failedRecord.recoveryPlan).toEqual(fixed.recoveryPlan);
    expect(
      env
        .history(installed.attemptId)
        .filter((row) => row.kind === "activation-confirmed"),
    ).toEqual(successHistory);
    expect(
      env
        .history(installed.attemptId)
        .filter((row) => row.kind === "recovery-failed"),
    ).toHaveLength(1);
    expect(await readJson(env.harness.bindingPath)).toEqual(writerBefore);
    for (const prior of namesBefore)
      expect(
        env.database
          .prepare("SELECT id,name FROM projects WHERE id=?")
          .get(prior.id),
      ).toEqual(prior);
    expect(
      env.database
        .prepare("SELECT count(*) n FROM coordinator_recoveries")
        .get().n,
    ).toBe(0);
    await signalOwnedNode(env, retained, "SIGCONT");
    stoppedReader = false;
    // A new real process incarnation may observe the durable unknown outcome,
    // but it must not re-enter execute, invent a new attempt or retry recovery.
    await env.stopController();
    const secondIncarnation = await env.harness.restartController();
    expect(secondIncarnation.artifactDigest).toBe(restarted.artifactDigest);
    const settledAt = performance.now();
    await expect
      .poll(() => performance.now() - settledAt, { timeout: 10000 })
      .toBeGreaterThan(3000);
    const unchanged = await env.harness.coordinator.snapshot(
      installed.attemptId,
    );
    expect(unchanged.recovery).toEqual(failedRecord.recovery);
    expect(unchanged.recoveryPlan).toEqual(fixed.recoveryPlan);
    expect(
      env
        .history(installed.attemptId)
        .filter((row) => row.kind === "recovery-started"),
    ).toHaveLength(1);
    expect(
      env
        .history(installed.attemptId)
        .filter((row) => row.kind === "recovery-failed"),
    ).toHaveLength(1);
    expect(
      env.database.prepare("SELECT count(*) n FROM upgrade_attempts").get().n,
    ).toBe(1);
    expect(
      env.database.prepare("SELECT count(*) n FROM upgrade_recoveries").get().n,
    ).toBe(1);
    const preserved = await env.continuity(),
      probes = await sampler.stop();
    sampler = null;
    succeeded = true;
    result = {
      secondRecoveryFailure: {
        instanceId: env.config.instanceId,
        inputFingerprint: env.fixture.envelope.manifest.runInputFingerprint,
        attemptId: installed.attemptId,
        acceptedIntent: env.acceptedIntent,
        requestId: installed.requestId,
        recoveryAttemptId,
        recoveryPlanDigest: recoveryPlan.planDigest,
        controllerContainerId: restarted.containerId,
        controllerStartIdentity: restarted.startIdentity,
        controllerArtifactDigest: restarted.artifactDigest,
        readerFault,
        webFault,
        state: unchanged.recovery.state,
        reason: unchanged.recovery.reason,
        writerPreserved: writerBefore,
        historyDigest: digest(successHistory),
        dataDigest: digest(namesBefore),
        noAutomaticRetry: true,
        preserved,
        probes,
        qualificationModel: env.model?.evidence() ?? null,
      },
    };
    return result;
  } finally {
    if (sampler) await sampler.stop();
    if (env) {
      try {
        if (stoppedWeb) await signalOwnedNode(env, env.role("web"), "SIGCONT");
        if (stoppedReader)
          await signalOwnedNode(
            env,
            env.harness.roleContainers.coordinator,
            "SIGCONT",
          );
      } finally {
        const cleanup = await env.clean({ preserveResources: !succeeded });
        if (result) result.secondRecoveryFailure.cleanup = cleanup;
      }
    }
    await context.close();
  }
}

async function independentFailure(browser, id, body) {
  const context = await browser.newContext(),
    page = await context.newPage(),
    started = performance.now(),
    measurementWindow = { startedAt: new Date().toISOString() };
  let env,
    sampler,
    succeeded = false,
    result;
  try {
    env = await installation(id, page, context);
    measurementWindow.originalSetupCompletedAt = new Date().toISOString();
    sampler = probe(env);
    const actual = await body(env),
      probes = await sampler.stop();
    sampler = null;
    measurementWindow.faultBodyCompletedAt = new Date().toISOString();
    const preserved = await env.continuity();
    measurementWindow.originalContinuityConfirmedAt = new Date().toISOString();
    measurementWindow.elapsedMs = performance.now() - started;
    result = {
      ...actual,
      instanceId: env.config.instanceId,
      acceptedIntent: env.acceptedIntent,
      inputFingerprint: env.fixture.envelope.manifest.runInputFingerprint,
      preserved,
      measurementWindow,
      probes,
      qualificationModel: env.model?.evidence() ?? null,
    };
    succeeded = true;
    return result;
  } catch (error) {
    error.qualificationWindow = {
      ...measurementWindow,
      failedAt: new Date().toISOString(),
      elapsedMs: performance.now() - started,
      taskObservationWindow: env ? observedTaskWindow(env) : null,
    };
    throw error;
  } finally {
    try {
      if (sampler) await sampler.stop();
      if (env) {
        const cleanup = await env.clean({ preserveResources: !succeeded });
        if (result) result.cleanup = cleanup;
      }
    } finally {
      await context.close();
    }
  }
}

async function x02RemainingFailures(browser) {
  const migrationPreparation = await independentFailure(
    browser,
    "X02",
    async (env) => {
      const manifest = env.fixture.envelope.manifest,
        fixedPath = manifest.upgradePaths.find(
          (row) => row.migrationPlanDigest,
        ),
        pkg = manifest.packages.find(
          (row) => row.platform === "linux" && row.arch === "arm64",
        );
      invariant(fixedPath && pkg, "ACTUAL_X02_MIGRATION_PACKAGE_REQUIRED");
      const archive = join(env.input.archiveRoot, pkg.name),
        hash = await fileDigest(archive);
      expect(hash.digest).toBe(pkg.digest);
      expect(hash.bytes).toBe(pkg.bytes);
      const plan = JSON.parse(
        await actualCommand("tar", [
          "-xOf",
          archive,
          "./upgrade-migration.json",
        ]),
      );
      expect(digest(plan)).toBe(fixedPath.migrationPlanDigest);
      const target = plan.projections[0].targetTable;
      expect(target).toMatch(/^upg_shadow_[a-zA-Z0-9_]+$/);
      await env.stopController();
      const accepted = await env.accept(),
        before = await env.binding();
      expect(
        env.database
          .prepare("SELECT type FROM sqlite_master WHERE name=?")
          .get(target),
      ).toBeUndefined();
      // A genuine isolated SQLite namespace collision is a preparation fault.
      // It touches no authoritative rows, signed plan, verified code or source table.
      env.database.exec(
        "CREATE INDEX " + identifier(target) + " ON projects(id)",
      );
      try {
        await env.harness.restartController();
        const failed = await stoppedAttempt(env, accepted);
        expect(
          env
            .history(accepted.attemptId)
            .filter((row) => row.kind === "activation-confirmed"),
        ).toHaveLength(0);
        expect(
          env.database
            .prepare(
              "SELECT 1 FROM upgrade_online_migrations WHERE attempt_id=?",
            )
            .get(accepted.attemptId),
        ).toBeUndefined();
        expect(
          env.database
            .prepare("SELECT type FROM sqlite_master WHERE name=?")
            .get(target).type,
        ).toBe("index");
        const after = await env.binding();
        expect(after.web.digest).toBe(before.web.digest);
        expect(after.weight).toBe(0);
        const snapshot = await env.harness.coordinator.snapshot(
          accepted.attemptId,
        );
        expect(snapshot.plan.migrationPath.migrationPlanDigest).toBe(
          digest(plan),
        );
        expect(
          snapshot.appliedSteps.some((row) => row.stepId === "migration"),
        ).toBe(false);
        return {
          attemptId: accepted.attemptId,
          planDigest: digest(plan),
          namespaceCollision: target,
          sourceRowsPreserved: true,
          zeroMigrationPrepared: true,
          reason: failed.attempt.reason,
          actualBinding: after,
        };
      } finally {
        env.database.exec("DROP INDEX " + identifier(target));
      }
    },
  );
  const candidateBeforeReadiness = await independentFailure(
    browser,
    "X02",
    async (env) => {
      const accepted = await env.accept();
      await env.until(() =>
        Boolean(
          env.database
            .prepare(
              "SELECT 1 FROM upgrade_steps WHERE attempt_id=? AND step_id='package-verify' AND applied=1",
            )
            .get(accepted.attemptId),
        ),
      );
      await env.stopController();
      let lease;
      await expect
        .poll(
          async () => {
            try {
              lease = await env.harness.coordinator.claim(accepted.attemptId, {
                controllerId: "native-pre-ready-candidate-fault",
                leaseMs: 15000,
              });
              return true;
            } catch {
              return false;
            }
          },
          { timeout: 45000, intervals: [100, 250] },
        )
        .toBe(true);
      const snapshot = await env.harness.coordinator.snapshot(
          accepted.attemptId,
        ),
        before = await env.binding();
      expect(before.weight).toBe(0);
      expect(
        snapshot.appliedSteps.some((row) => row.stepId === "candidate"),
      ).toBe(false);
      // Start only this fixed signed package's actual ControlAPI through the real
      // fenced Supervisor. It remains outside production and has no SDK/DB mounts.
      // Kill it before the actual child Controller can grant release readiness.
      const response = await fetch(env.harness.supervisor.origin + "/start", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-platform-internal-key": env.config.keys.supervisor,
        },
        body: JSON.stringify({
          attemptId: accepted.attemptId,
          fence: lease.fence,
          kind: "api",
        }),
        signal: AbortSignal.timeout(120000),
      });
      expect(response.ok).toBe(true);
      const candidate = await response.json(),
        physical = await env.adapter.inspect(candidate.containerId);
      expect(candidate.artifactDigest).toBe(
        env.fixture.envelope.manifest.components.api.artifactDigest,
      );
      expect(physical.role).toBe("api");
      expect(physical.environmentNames).not.toContain("DATABASE_URL");
      expect(
        physical.mounts.some(
          (m) => resolve(m.source) === join(env.config.root, "business"),
        ),
      ).toBe(false);
      expect(
        physical.mounts.some(
          (m) => resolve(m.source) === join(env.config.root, "original-owner"),
        ),
      ).toBe(false);
      await env.signal(candidate, "SIGKILL");
      expect((await env.adapter.inspect(candidate.containerId)).running).toBe(
        false,
      );
      await env.harness.restartController();
      const failed = await stoppedAttempt(env, accepted),
        after = await env.binding();
      expect(after.weight).toBe(0);
      expect(after.web.digest).toBe(before.web.digest);
      expect(
        env
          .history(accepted.attemptId)
          .filter((row) => row.kind === "activation-confirmed"),
      ).toHaveLength(0);
      return {
        attemptId: accepted.attemptId,
        candidate: {
          containerId: candidate.containerId,
          startIdentity: candidate.startIdentity,
          artifactDigest: candidate.artifactDigest,
        },
        beforeProductionReadiness: true,
        actualBinding: after,
        reason: failed.attempt.reason,
      };
    },
  );
  return { migrationPreparation, candidateBeforeReadiness };
}

async function x04WebOnlyRecovery(browser) {
  return {
    webOnlyRecovery: await independentFailure(browser, "X04", async (env) => {
      const accepted = await env.accept();
      await env.until((s) => s.attempt?.state === "activation-confirmed");
      await env.resumeTerminal();
      const timeOrigin = await env.page.evaluate(() => performance.timeOrigin),
        loadedBuild = await responseJson(env.request, env.origin, "/web-build"),
        before = await env.binding(),
        writerBefore = await readJson(env.harness.bindingPath),
        manifest = env.fixture.envelope.manifest,
        web = env.role("web"),
        success = env
          .history(accepted.attemptId)
          .filter((row) => row.kind === "activation-confirmed");
      expect(loadedBuild.webRevision).toBe(manifest.components.web.webRevision);
      expect(before.weight).toBe(100);
      expect(before.candidateApi.digest).toBe(
        manifest.components.api.artifactDigest,
      );
      let stopped = false;
      try {
        const fault = await signalOwnedNode(env, web, "SIGSTOP");
        stopped = true;
        // This case uses the actual Controller's measured Web failure domain and
        // automatic recovery, never caller-invented eligibility/commit evidence.
        const recovered = await env.until(
          (s, b) =>
            s.recovery?.state === "recovery-confirmed" &&
            b.web.digest ===
              env.initial.confirmedServiceRelease.components.web
                .artifactDigest &&
            b.weight === 100 &&
            b.candidateApi?.digest === manifest.components.api.artifactDigest,
        );
        const record = await env.harness.coordinator.snapshot(
          accepted.attemptId,
        );
        expect(record.recoveryPlan.componentScope).toEqual(["web"]);
        expect(record.recoveryPlan.api).toBeNull();
        expect(record.recoveryPlan.coordinator).toBeNull();
        expect(record.recoveryPlan.owner).toBeNull();
        expect(record.recoveryPlan.web.digest).toBe(
          env.initial.confirmedServiceRelease.components.web.artifactDigest,
        );
        expect(await readJson(env.harness.bindingPath)).toEqual(writerBefore);
        expect(
          env
            .history(accepted.attemptId)
            .filter((row) => row.kind === "activation-confirmed"),
        ).toEqual(success);
        expect(recovered.attempt.state).toBe("activation-confirmed");
        expect(recovered.attempt.percent).toBe(100);
        expect(recovered.confirmedServiceRelease).toBeNull();
        expect(recovered.lastConfirmedServiceRelease.releaseId).toBe(
          manifest.releaseId,
        );
        expect(recovered.serviceState).toBe("unknown");
        expect(recovered.availableWeb).toBeNull();
        expect(await env.page.evaluate(() => performance.timeOrigin)).toBe(
          timeOrigin,
        );
        const actual = await env.binding(),
          owners = await readJson(env.harness.ownerBindingPath),
          activeOwner = owners.owners.find(
            (row) => row.ownerId === owners.activeOwnerId,
          ),
          identity = await fetch(env.role("installer").origin + "/metadata", {
            headers: { "x-platform-internal-key": env.config.keys.controller },
            signal: AbortSignal.timeout(2000),
          });
        expect(identity.ok).toBe(true);
        const installer = await identity.json();
        const tuple = {
          apiDigest: actual.candidateApi.digest,
          webDigest: actual.web.digest,
          coordinatorDigest: writerBefore.artifactDigest,
          ownerDigest: activeOwner.artifactDigest,
          installerDigest: installer.artifactDigest,
        };
        expect(tuple).toEqual({
          apiDigest: manifest.components.api.artifactDigest,
          webDigest:
            env.initial.confirmedServiceRelease.components.web.artifactDigest,
          coordinatorDigest: manifest.components.coordinator.artifactDigest,
          ownerDigest: manifest.components.owner.artifactDigest,
          installerDigest: manifest.components.installer.artifactDigest,
        });
        const created = await responseJson(
          env.request,
          env.origin,
          "/api/projects",
          "POST",
          {
            name: "healthy B after Web-only recovery",
            sourceType: "empty",
          },
          202,
        );
        expect(
          (
            await responseJson(
              env.request,
              env.origin,
              "/api/projects/" + created.id,
            )
          ).name,
        ).toBe(created.name);
        await signalOwnedNode(env, web, "SIGCONT");
        stopped = false;
        const current = await env.state();
        expect(current.repairableCurrent?.baseConfirmedReleaseId).toBe(
          manifest.releaseId,
        );
        expect(current.catalog.availableRelease?.targetDigest).toBe(
          env.fixture.envelope.manifestDigest,
        );
        expect(current.catalog.availableRelease?.releaseId).toBe(
          manifest.releaseId,
        );
        return {
          attemptId: accepted.attemptId,
          fault,
          recoveryAttemptId: recovered.recovery.recoveryAttemptId,
          recoveryPlanDigest: record.recoveryPlan.planDigest,
          componentScope: record.recoveryPlan.componentScope,
          actualMixedTuple: tuple,
          fullReleaseUnconfirmed: true,
          originalBWriterPreserved: true,
          loadedWebRevision: loadedBuild.webRevision,
          browserTimeOrigin: timeOrigin,
          browserNotReloadedByRecovery: true,
          historyDigest: digest(success),
          sameReleaseExplicitRepairAvailable: true,
          actualBusinessProjectId: created.id,
        };
      } finally {
        if (stopped) await signalOwnedNode(env, web, "SIGCONT");
      }
    }),
  };
}

async function x13RemainingBudgetsAndMaximum(browser) {
  const diskAndSql = await independentFailure(browser, "X13", async (env) => {
    const databaseFile = await fs.realpath(
        env.database.pragma("database_list").find((row) => row.name === "main")
          .file,
      ),
      diskRoot = dirname(databaseFile),
      diskStat = await fs.stat(diskRoot),
      parentStat = await fs.stat(env.config.root),
      workspaceStat = await fs.stat(
        join(env.config.root, "business/workspaces"),
      ),
      mounts = await fs.readFile("/proc/self/mountinfo", "utf8");
    // Allocate only on the new, exact DB leaf. Original Guest workspaces and
    // every Owner home remain on the shared data filesystem with their reserve.
    invariant(
      databaseFile === qualificationBusinessDatabasePath(env.config) &&
        env.config.businessDatabaseFilesystemEvidence?.qualified === true &&
        diskStat.dev ===
          env.config.businessDatabaseFilesystemEvidence.filesystem.dev &&
        diskStat.dev !== parentStat.dev &&
        workspaceStat.dev === parentStat.dev &&
        mounts.split("\n").some((line) => {
          const [mount, filesystem] = line.split(" - ");
          const mountpoint = mount
            ?.split(" ")[4]
            ?.replace(/\\040/g, " ")
            .replace(/\\134/g, "\\");
          return (
            mountpoint === diskRoot && /^(ext4|xfs) /.test(filesystem ?? "")
          );
        }),
      "DEDICATED_BUSINESS_DB_FILESYSTEM_REQUIRED_FOR_DISK_PRESSURE",
    );
    const migration = await acquiredMigration(env),
      policy = migration.snapshot.plan.policy;
    const coordinator = env.role("coordinator");
    const observeDatabaseFilesystem = async () =>
      JSON.parse(
        await actualCommand(env.config.docker.cli || "docker", [
          ...env.config.docker.args,
          "exec",
          coordinator.containerId,
          "node",
          "-e",
          "const fs=require('fs'),path=require('path');const p=fs.realpathSync(process.env.DATABASE_URL),d=path.dirname(p),s=fs.statSync(d),f=fs.statfsSync(d);process.stdout.write(JSON.stringify({databasePath:p,directory:d,dev:s.dev,type:f.type,availableBytes:f.bavail*f.bsize,totalBytes:f.blocks*f.bsize}));",
        ]),
      );
    const physicalDatabase = await observeDatabaseFilesystem();
    expect(physicalDatabase.databasePath).toBe(databaseFile);
    expect(physicalDatabase.dev).toBe(diskStat.dev);
    expect(physicalDatabase.type).toBe(0xef53);
    expect(physicalDatabase.availableBytes).toBeGreaterThan(
      policy.minFreeBytes,
    );
    // The installer still independently rejects real unpack capacity pressure.
    // Its low space is not the migration budget's filesystem.
    const installerRoot = join(env.config.root, "installer"),
      installerStat = await fs.stat(installerRoot),
      installerProof = env.config.installerFilesystemEvidence,
      pkg = env.fixture.envelope.manifest.packages.find(
        (p) => p.platform === "linux" && p.arch === "arm64",
      );
    invariant(
      installerProof?.qualified === true &&
        installerProof.mountpoint === installerRoot &&
        installerStat.dev === installerProof.filesystem.dev &&
        installerStat.dev !== parentStat.dev &&
        installerStat.dev !== diskStat.dev &&
        Number.isSafeInteger(pkg?.unpackedBytes),
      "DEDICATED_INSTALLER_UNPACK_FILESYSTEM_REQUIRED",
    );
    const installerFree = await fs.statfs(installerRoot),
      installerFreeBefore = installerFree.bavail * installerFree.bsize,
      installerRemaining = Math.floor(
        Math.min(pkg.unpackedBytes, policy.minFreeBytes) / 2,
      ),
      installerAllocated = installerFreeBefore - installerRemaining,
      installerPressure = join(
        installerRoot,
        "qualification-unpack-pressure-" + randomUUID(),
      ),
      unpackRoot = join(installerRoot, "qualification-unpack-" + randomUUID());
    invariant(
      installerRemaining >= 32 * 1024 * 1024 && installerAllocated > 0,
      "SAFE_INSTALLER_UNPACK_PRESSURE_ROOM_REQUIRED",
    );
    await fs.writeFile(installerPressure, "", { mode: 0o600, flag: "wx" });
    await fs.mkdir(unpackRoot, { mode: 0o700 });
    let installerFreeDuring;
    try {
      await actualCommand("fallocate", [
        "-l",
        String(installerAllocated),
        installerPressure,
      ]);
      const low = await fs.statfs(unpackRoot);
      installerFreeDuring = low.bavail * low.bsize;
      expect(installerFreeDuring).toBeLessThan(pkg.unpackedBytes);
      expect(
        (await observeDatabaseFilesystem()).availableBytes,
      ).toBeGreaterThan(policy.minFreeBytes);
      await expect(
        unpackVerified(
          join(env.input.archiveRoot, pkg.name),
          pkg,
          unpackRoot,
          env.fixture.envelope.manifest.components,
        ),
      ).rejects.toThrow("INSUFFICIENT_UNPACK_CAPACITY");
    } finally {
      await fs.unlink(installerPressure);
      await fs.rmdir(unpackRoot);
    }
    const checkpoint = JSON.parse(migration.row().checkpoint),
      free = await fs.statfs(diskRoot),
      freeBefore = Number(free.bavail) * Number(free.bsize),
      remaining = Math.floor(policy.minFreeBytes / 2),
      allocatedBytes = freeBefore - remaining,
      path = join(diskRoot, "qualification-disk-pressure-" + randomUUID());
    invariant(
      remaining >= 32 * 1024 * 1024 && allocatedBytes > 0,
      "FROZEN_DISK_BUDGET_REQUIRES_SAFE_PHYSICAL_PRESSURE_ROOM",
    );
    const file = await fs.open(path, "wx", 0o600);
    await file.close();
    let freeDuring, coordinatorFreeDuring;
    try {
      await actualCommand("fallocate", ["-l", String(allocatedBytes), path]);
      const actual = await fs.statfs(diskRoot);
      freeDuring = Number(actual.bavail) * Number(actual.bsize);
      const observed = await observeDatabaseFilesystem();
      coordinatorFreeDuring = observed.availableBytes;
      expect(observed.dev).toBe(diskStat.dev);
      expect(coordinatorFreeDuring).toBeLessThan(policy.minFreeBytes);
      expect(freeDuring).toBeLessThan(policy.minFreeBytes);
      expect(freeDuring).toBeGreaterThanOrEqual(16 * 1024 * 1024);
      await expect(
        migration.call(randomUUID(), "batch", checkpoint),
      ).rejects.toThrow("MIGRATION_DISK_BUDGET");
      expect(migration.row().checkpoint).toBe(JSON.stringify(checkpoint));
    } finally {
      await fs.unlink(path);
    }
    // A real BEGIN IMMEDIATE lock wait counts in the production transaction
    // budget. The fault holder changes no business row or writer authority.
    const holdMs = policy.migrationBatchMs + 150;
    invariant(holdMs <= 1500, "REAL_SQL_WAIT_MUST_REMAIN_WITHIN_HTTP_DEADLINE");
    await env.harness.coordinator.renew(migration.accepted.attemptId, {
      controllerId: "native-fault-controller",
      fence: migration.lease.fence,
    });
    const before = migration.row(),
      began = performance.now();
    env.database.exec("BEGIN IMMEDIATE");
    let locked = true;
    const release = setTimeout(() => {
      if (locked) {
        env.database.exec("ROLLBACK");
        locked = false;
      }
    }, holdMs);
    let sqlRejection;
    try {
      await env.harness.coordinator.migration(migration.accepted.attemptId, {
        fence: migration.lease.fence,
        operationId: randomUUID(),
        action: "repair",
        planDigest: migration.planDigest,
        checkpoint: JSON.parse(before.checkpoint),
      });
      throw new Error(
        "A real over-budget transaction wait unexpectedly applied",
      );
    } catch (error) {
      expect(error.code).toBe("MIGRATION_BATCH_BUDGET_EXCEEDED");
      sqlRejection = error.code;
    } finally {
      clearTimeout(release);
      if (locked) {
        env.database.exec("ROLLBACK");
        locked = false;
      }
    }
    expect(performance.now() - began).toBeGreaterThan(policy.migrationBatchMs);
    expect(migration.row()).toEqual(before);
    await expect(
      env.harness.coordinator.migration(migration.accepted.attemptId, {
        fence: migration.lease.fence,
        operationId: randomUUID(),
        action: "contract",
        planDigest: migration.planDigest,
      }),
    ).rejects.toThrow("FIXED_MIGRATION_COMMAND_REQUIRED");
    await expect(
      env.harness.coordinator.migration(migration.accepted.attemptId, {
        fence: migration.lease.fence,
        operationId: randomUUID(),
        action: "sql",
        planDigest: migration.planDigest,
        sql: "DROP TABLE projects",
      }),
    ).rejects.toThrow("FIXED_MIGRATION_COMMAND_REQUIRED");
    expect(
      env.database
        .prepare("SELECT 1 FROM projects WHERE id=?")
        .get(env.project.id),
    ).toBeTruthy();
    return {
      attemptId: migration.accepted.attemptId,
      installerUnpackBudget: {
        filesystem: installerProof.filesystem,
        unpackedBytes: pkg.unpackedBytes,
        freeBefore: installerFreeBefore,
        freeDuring: installerFreeDuring,
        allocatedBytes: installerAllocated,
        rejectedCode: "INSUFFICIENT_UNPACK_CAPACITY",
        businessDatabaseBudgetUnaffected: true,
      },
      diskBudget: {
        filesystem: env.config.businessDatabaseFilesystemEvidence.filesystem,
        physicalDatabase,
        coordinatorFreeDuring,
        originalWorkspaceDev: workspaceStat.dev,
        declaredMinFreeBytes: policy.minFreeBytes,
        freeBefore,
        freeDuring,
        allocatedBytes,
        rejectedCode: "MIGRATION_DISK_BUDGET",
        originalVolumeNeverRestored: true,
      },
      longSqlWait: {
        declaredBudgetMs: policy.migrationBatchMs,
        physicalHoldMs: holdMs,
        rejectedCode: sqlRejection,
        originalCheckpointUnchanged: true,
        transactionRolledBack: true,
      },
      arbitrarySqlAndContractRejectedByValidFence: true,
    };
  });
  const maximumAndDeferredGlobal = await independentFailure(
    browser,
    "X13",
    async (env) => {
      const load = await populateQualifiedMaximum(env),
        accepted = await env.accept();
      await env.until((s) => s.attempt?.state === "activation-confirmed");
      const maxData = maximumMigrationReceipt(env, accepted.attemptId, load);
      await env.resumeTerminal();
      const mainFingerprint = env.fixture.envelope.manifest.runInputFingerprint,
        roots = await readJson(env.config.trustRootPath),
        catalog = await readJson(env.config.catalogFile),
        proof = await readJson(env.config.qualificationInstallationPath),
        current = await env.state(),
        originalSchema = env.database
          .prepare("SELECT count(*) n FROM __drizzle_migrations")
          .get().n,
        ddlBefore = env.database
          .prepare(
            "SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name",
          )
          .all(),
        attemptsBefore = env.database
          .prepare("SELECT count(*) n FROM upgrade_attempts")
          .get().n,
        downloadsBefore = env.fixture.requestLog().length,
        bindingBefore = await env.binding();
      expect(originalSchema).toBe(28);
      const variant = negativeQualificationEnvelope(
        env.fixture.envelope,
        roots,
        env.config.instanceId,
        "global-schema-unqualified",
        (manifest) => {
          const version = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(
            manifest.releaseId,
          );
          invariant(version, "ACTUAL_SEMVER_QUALIFICATION_RELEASE_REQUIRED");
          manifest.releaseId = `${version[1]}.${version[2]}.${Number(version[3]) + 1}-unqualified-global-ddl`;
          manifest.upgradePaths = [
            {
              fromRelease: current.lastConfirmedServiceRelease.releaseId,
              minSchema: originalSchema,
              maxSchema: originalSchema,
              targetSchema: originalSchema + 1,
              bridgeReleases: [],
              migrationPlanDigest:
                manifest.upgradePaths.find((path) => path.migrationPlanDigest)
                  ?.migrationPlanDigest ?? null,
            },
          ];
        },
      );
      let status, rejectedStatus;
      try {
        await overwriteMountedJson(env.config.trustRootPath, variant.roots);
        await overwriteMountedJson(env.config.qualificationInstallationPath, {
          ...proof,
          trustRootDigest: digest(variant.roots),
        });
        await overwriteMountedJson(env.config.catalogFile, variant.catalog);
        await expect
          .poll(
            async () => {
              status = await env.state();
              return status.catalog.reason;
            },
            { timeout: 30000 },
          )
          .toBe("GLOBAL_SCHEMA_MIGRATION_UNQUALIFIED");
        expect(status.catalog.availableRelease).toBeNull();
        const requestId = randomUUID(),
          response = await env.request.post(
            env.origin + "/api/system/upgrade/requests",
            {
              data: {
                requestId,
                targetReleaseId: variant.envelope.manifest.releaseId,
                targetDigest: variant.envelope.manifestDigest,
                expectedActivationGeneration: status.activationGeneration,
              },
              headers: {
                Origin: env.origin,
                "X-Upgrade-CSRF": status.csrfToken,
              },
            },
          );
        rejectedStatus = response.status();
        expect([400, 409, 412]).toContain(rejectedStatus);
        expect(
          (
            await env.request.get(
              env.origin + "/api/system/upgrade/requests/" + requestId,
            )
          ).status(),
        ).toBe(404);
        expect(
          env.database.prepare("SELECT count(*) n FROM upgrade_attempts").get()
            .n,
        ).toBe(attemptsBefore);
        expect(
          env.database
            .prepare(
              "SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name",
            )
            .all(),
        ).toEqual(ddlBefore);
        expect(
          env.database
            .prepare("SELECT count(*) n FROM __drizzle_migrations")
            .get().n,
        ).toBe(originalSchema);
        expect(env.fixture.requestLog()).toHaveLength(downloadsBefore);
        expect(await env.binding()).toEqual(bindingBefore);
      } finally {
        await overwriteMountedJson(env.config.trustRootPath, roots);
        await overwriteMountedJson(
          env.config.qualificationInstallationPath,
          proof,
        );
        await overwriteMountedJson(env.config.catalogFile, catalog);
      }
      return {
        attemptId: accepted.attemptId,
        maxData,
        forwardOnly: {
          inputFingerprint: mainFingerprint,
          variantInputFingerprint:
            variant.envelope.manifest.runInputFingerprint,
          declaredTargetSchema: originalSchema + 1,
          actualDrizzleCount: originalSchema,
          catalogReason: status.catalog.reason,
          acceptRejectedStatus: rejectedStatus,
          zeroDdl: true,
          zeroAttempt: true,
          zeroDownload: true,
          qualificationScope: "namespace-authority-and-deferred-global-ddl",
          globalDestructiveDdlQualified: false,
        },
      };
    },
  );
  return {
    diskAndSql,
    maxData: maximumAndDeferredGlobal.maxData,
    forwardOnly: maximumAndDeferredGlobal.forwardOnly,
    maximumAndDeferredGlobal,
  };
}
async function stoppedAttempt(env, attempt) {
  const current = await env.until(
    (status) =>
      status.attempt?.attemptId === attempt.attemptId &&
      terminalStates.has(status.attempt.state),
  );
  expect(current.attempt.targetDigest).toBe(attempt.targetDigest);
  expect(current.attempt.percent).not.toBe(100);
  return current;
}
async function acquiredMigration(
  env,
  sourceTable = "projects",
  existingAttempt,
) {
  const manifest = env.fixture.envelope.manifest;
  invariant(
    manifest.upgradePaths.some((path) => path.migrationPlanDigest),
    "REAL_FROZEN_MIGRATION_PACKAGE_REQUIRED",
  );
  const accepted = existingAttempt ?? (await env.accept());
  await env.until(() =>
    Boolean(
      env.database
        .prepare("SELECT 1 FROM upgrade_online_migrations WHERE attempt_id=?")
        .get(accepted.attemptId),
    ),
  );
  await env.stopController();
  let lease;
  await expect
    .poll(
      async () => {
        try {
          lease = await env.harness.coordinator.claim(accepted.attemptId, {
            controllerId: "native-fault-controller",
            leaseMs: 120000,
          });
          return true;
        } catch {
          return false;
        }
      },
      { timeout: 30000, intervals: [100, 250] },
    )
    .toBe(true);
  const snapshot = await env.harness.coordinator.snapshot(accepted.attemptId),
    planDigest = snapshot.plan.migrationPath.migrationPlanDigest;
  const row = () =>
    env.database
      .prepare("SELECT * FROM upgrade_online_migrations WHERE plan_digest=?")
      .get(planDigest);
  const plan = JSON.parse(row().plan);
  invariant(
    plan.projections.some(
      (p) => p.sourceTable === sourceTable && p.primaryKey === "id",
    ),
    "REAL_BUSINESS_MIGRATION_VARIANT_REQUIRED_" + sourceTable,
  );
  const call = async (operationId, action, checkpoint) => {
    await env.harness.coordinator.renew(accepted.attemptId, {
      fence: lease.fence,
      controllerId: "native-fault-controller",
    });
    return env.harness.coordinator.migration(accepted.attemptId, {
      fence: lease.fence,
      operationId,
      action,
      checkpoint,
      planDigest,
    });
  };
  return { accepted, lease, snapshot, planDigest, plan, row, call };
}
async function advanceMigration(migration) {
  for (let i = 0; i < 100000; i++) {
    const row = migration.row();
    if (row.stage === "complete") return row;
    await migration.call(randomUUID(), "batch", JSON.parse(row.checkpoint));
  }
  throw new Error("REAL_MIGRATION_DID_NOT_CONVERGE");
}
async function actualMcp(env, projectId) {
  const sdkRequire = createRequire(
    join(env.config.initialRoot, "api/apps/api/package.json"),
  );
  const { Client } = await import(
    pathToFileURL(
      sdkRequire.resolve("@modelcontextprotocol/sdk/client/index.js"),
    ).href
  );
  const { StreamableHTTPClientTransport } = await import(
    pathToFileURL(
      sdkRequire.resolve("@modelcontextprotocol/sdk/client/streamableHttp.js"),
    ).href
  );
  const cookies = await env.page.context().cookies(env.origin);
  const accessCookie = cookies
    .filter((cookie) => cookie.name === "ap_session")
    .map((cookie) => cookie.name + "=" + cookie.value)
    .join("; ");
  invariant(accessCookie, "ACTUAL_PUBLIC_MCP_ACCESS_SESSION_REQUIRED");
  const client = new Client({ name: "native-version-tuple", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(env.origin + "/mcp"),
    { requestInit: { headers: { Origin: env.origin, Cookie: accessCookie } } },
  );
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    expect(listed.tools.some((tool) => tool.name === "get_project")).toBe(true);
    const result = await client.callTool({
      name: "get_project",
      arguments: { id: projectId },
    });
    const text = result.content.find((block) => block.type === "text");
    expect(text, "Actual MCP JSON content").toBeTruthy();
    expect(JSON.parse(text.text).id).toBe(projectId);
    return { tool: "get_project", projectId, listedTools: listed.tools.length };
  } finally {
    await client.close();
  }
}

async function overwriteMountedJson(path, value) {
  const stat = await fs.lstat(path);
  invariant(
    stat.isFile() && !stat.isSymbolicLink(),
    "FIXED_QUALIFICATION_FILE_REQUIRED",
  );
  // Deliberate isolated-source mutation, preserving the inode of the actual
  // read-only container file mount. An atomic rename would leave it reading A.
  await fs.writeFile(path, JSON.stringify(value) + "\n", { mode: 0o600 });
}
function negativeQualificationEnvelope(
  original,
  originalRoots,
  instanceId,
  name,
  change,
) {
  const manifest = structuredClone(original.manifest);
  change(manifest);
  const inputFingerprint = runInputFingerprint(manifest);
  manifest.runInputFingerprint = inputFingerprint;
  manifest.qualification = { instanceId, inputFingerprint };
  manifest.evidence = manifest.evidence.map((evidence) => ({
    ...evidence,
    inputFingerprint,
  }));
  const keys = generateKeyPairSync("ed25519"),
    keyId = "negative-qualification-" + name;
  // Intentionally sign forbidden metadata (e.g. withdrawal) so the real server
  // exercises semantic rejection AFTER authenticating its qualification source.
  // The private key stays in memory and belongs only to this isolated test domain.
  const envelope = {
    manifest,
    manifestDigest: digest(manifest),
    signature: {
      algorithm: "Ed25519",
      keyId,
      value: sign(
        null,
        Buffer.from(canonical(manifest)),
        keys.privateKey,
      ).toString("base64"),
    },
  };
  const roots = {
    ...originalRoots,
    keys: [
      {
        id: keyId,
        publicKey: keys.publicKey.export({ format: "pem", type: "spki" }),
      },
    ],
  };
  return {
    roots,
    envelope,
    catalog: {
      schemaVersion: 1,
      channel: manifest.channel,
      releases: [
        {
          releaseId: manifest.releaseId,
          manifestDigest: envelope.manifestDigest,
          envelope,
        },
      ],
    },
  };
}
test("authenticated native signature/architecture/withdrawal/path/bridge preflight rejects before accepting or downloading [X01]", async ({
  page,
  context,
}, info) =>
  recordCase("X01", page, context, info, async (env) => {
    await env.authorize();
    const catalog = await readJson(env.config.catalogFile),
      roots = await readJson(env.config.trustRootPath),
      proof = await readJson(env.config.qualificationInstallationPath),
      originalBinding = await env.binding(),
      originalRelease = (await env.state()).confirmedServiceRelease,
      before = env.database
        .prepare("SELECT count(*) n FROM upgrade_attempts")
        .get().n;
    invariant(
      Array.isArray(catalog.releases) && catalog.releases.length === 1,
      "ONE_FIXED_QUALIFICATION_TARGET_REQUIRED",
    );
    const original = catalog.releases[0].envelope;
    const variants = [
      {
        name: "forged-signature",
        reason: "SIGNATURE_OR_MANIFEST_DIGEST_INVALID",
        change: () => {},
        forge: true,
      },
      {
        name: "wrong-architecture",
        reason: null,
        change: (m) => {
          m.packages = m.packages.map((p) => ({ ...p, arch: "x64" }));
        },
      },
      {
        name: "withdrawn",
        reason: "RELEASE_WITHDRAWN_OR_WRONG_CHANNEL",
        change: (m) => {
          m.withdrawn = true;
        },
      },
      {
        name: "missing-path",
        reason: "UPGRADE_PATH_NOT_SUPPORTED",
        change: (m) => {
          m.upgradePaths = m.upgradePaths.map((p) => ({
            ...p,
            fromRelease: "9999.0.0",
          }));
        },
      },
      {
        name: "missing-bridge",
        reason: "REQUIRED_BRIDGE_NOT_INSTALLED",
        change: (m) => {
          m.upgradePaths = m.upgradePaths.map((p) => ({
            ...p,
            bridgeReleases: ["9999.0.0"],
          }));
        },
      },
    ];
    const facts = [];
    try {
      for (const variant of variants) {
        const fixed = negativeQualificationEnvelope(
          original,
          roots,
          env.config.instanceId,
          variant.name,
          variant.change,
        );
        if (variant.forge) fixed.envelope.signature.value = "A".repeat(88);
        await overwriteMountedJson(env.config.trustRootPath, fixed.roots);
        await overwriteMountedJson(env.config.qualificationInstallationPath, {
          ...proof,
          trustRootDigest: digest(fixed.roots),
        });
        await overwriteMountedJson(env.config.catalogFile, fixed.catalog);
        let actual;
        await expect
          .poll(
            async () => {
              actual = await env.state();
              return (
                actual.catalog.availableRelease === null &&
                (variant.reason
                  ? actual.catalog.reason === variant.reason
                  : actual.catalog.state === "no-update")
              );
            },
            { timeout: 30000 },
          )
          .toBe(true);
        expect(actual.capabilities.canUpgradeInstance).toBe(true);
        expect(actual.attempt).toBeNull();
        const requestId = randomUUID();
        const response = await env.request.post(
          env.origin + "/api/system/upgrade/requests",
          {
            data: {
              requestId,
              targetReleaseId: fixed.envelope.manifest.releaseId,
              targetDigest: fixed.envelope.manifestDigest,
              expectedActivationGeneration: actual.activationGeneration,
            },
            headers: { Origin: env.origin, "X-Upgrade-CSRF": actual.csrfToken },
          },
        );
        expect(response.status()).toBe(409);
        expect(
          env.database.prepare("SELECT count(*) n FROM upgrade_attempts").get()
            .n,
        ).toBe(before);
        expect((await env.state()).confirmedServiceRelease).toEqual(
          originalRelease,
        );
        expect(await env.binding()).toEqual(originalBinding);
        expect(
          env.fixture.requestLog().filter((row) => row.path.endsWith(".tgz")),
        ).toHaveLength(0);
        const lookup = await env.request.get(
          env.origin + "/api/system/upgrade/requests/" + requestId,
        );
        expect(lookup.status()).toBe(404);
        facts.push({
          variant: variant.name,
          signedDigest: fixed.envelope.manifestDigest,
          catalogState: actual.catalog.state,
          reason: actual.catalog.reason,
          rejectedStatus: response.status(),
          noAcceptance: true,
          noDownload: true,
        });
      }
    } finally {
      await overwriteMountedJson(env.config.trustRootPath, roots);
      await overwriteMountedJson(
        env.config.qualificationInstallationPath,
        proof,
      );
      await overwriteMountedJson(env.config.catalogFile, catalog);
    }
    await expect
      .poll(
        async () => (await env.state()).catalog.availableRelease?.targetDigest,
        { timeout: 30000 },
      )
      .toBe(original.manifestDigest);
    return { variants: facts, noAcceptance: true, noDownload: true };
  }));

test("download failure after genuine UI acceptance keeps the old binding and original guests [X02]", async ({
  page,
  context,
}, info) =>
  recordCase("X02", page, context, info, async (env) => {
    await env.stopController();
    const accepted = await env.accept(),
      before = await env.binding();
    await env.fixture.close();
    await env.harness.restartController();
    const status = await stoppedAttempt(env, accepted),
      after = await env.binding();
    expect(after.web.digest).toBe(before.web.digest);
    expect(after.weight).toBe(0);
    expect(status.lastConfirmedServiceRelease.releaseId).toBe(
      env.initial.confirmedServiceRelease.releaseId,
    );
    return {
      attemptId: accepted.attemptId,
      reason: status.attempt.reason,
      binding: after,
      afterContinuity: () => x02RemainingFailures(context.browser()),
    };
  }));

test("candidate failure after real API routing freezes progress and uses only a qualified fallback [X03]", async ({
  page,
  context,
}, info) =>
  recordCase("X03", page, context, info, async (env) => {
    const accepted = await env.accept();
    await env.until((_s, b) => b.weight > 0 && b.weight < 100);
    const before = await env.binding();
    await env.signal(env.role("api"), "SIGKILL");
    const status = await stoppedAttempt(env, accepted),
      after = await env.binding();
    expect(after.web.digest).toBe(
      env.initial.confirmedServiceRelease.components.web.artifactDigest,
    );
    expect(status.confirmedServiceRelease?.releaseId).not.toBe(
      env.fixture.envelope.manifest.releaseId,
    );
    if (after.weight === 0)
      expect(status.recovery?.state).toBe("recovery-confirmed");
    else expect(after.candidateApi.digest).toBe(before.candidateApi.digest);
    return {
      attemptId: accepted.attemptId,
      actualBinding: after,
      recovery: status.recovery,
    };
  }));

test("Web switch before activation never pretends the whole instance is 100 [X04]", async ({
  page,
  context,
}, info) =>
  recordCase("X04", page, context, info, async (env) => {
    const accepted = await env.accept();
    await env.until(
      (_s, b) =>
        b.web.digest ===
        env.fixture.envelope.manifest.components.web.artifactDigest,
    );
    await env.stopController();
    const status = await env.state();
    expect(status.attempt.state).not.toBe("activation-confirmed");
    expect(status.attempt.percent).not.toBe(100);
    expect(status.serviceState).not.toBe("confirmed");
    expect(status.lastConfirmedServiceRelease.releaseId).toBe(
      env.initial.confirmedServiceRelease.releaseId,
    );
    await page.reload();
    expect((await env.binding()).web.digest).toBe(
      env.fixture.envelope.manifest.components.web.artifactDigest,
    );
    return {
      attemptId: accepted.attemptId,
      actualPartialStage: status.attempt.stage,
      lastConfirmed: status.lastConfirmedServiceRelease.releaseId,
      afterContinuity: () => x04WebOnlyRecovery(context.browser()),
    };
  }));

test("failure after activation preserves historical success and creates independent recovery [X05]", async ({
  page,
  context,
}, info) =>
  recordCase("X05", page, context, info, async (env) => {
    const accepted = await env.accept();
    await env.until((s) => s.attempt?.state === "activation-confirmed");
    const successful = env
      .history(accepted.attemptId)
      .filter((row) => row.kind === "activation-confirmed");
    expect(successful).toHaveLength(1);
    await env.signal(env.role("api"), "SIGKILL");
    const status = await env.until(
      (s) => s.availableWeb?.ready !== true && s.recovery !== null,
    );
    expect(status.attempt.state).toBe("activation-confirmed");
    expect(status.attempt.percent).toBe(100);
    expect(
      env
        .history(accepted.attemptId)
        .filter((row) => row.kind === "activation-confirmed"),
    ).toEqual(successful);
    expect(status.recovery.triggeringAttemptId).toBe(accepted.attemptId);
    expect(status.recovery.generation).toBeGreaterThan(
      status.attempt.generation,
    );
    expect(status.recovery.recoveryAttemptId).not.toBe(accepted.attemptId);
    const completed = env.database
      .prepare(
        "SELECT event_id,generation,sequence,fence,payload FROM upgrade_events WHERE attempt_id=? AND kind='activation-confirmed'",
      )
      .get(accepted.attemptId);
    let lateResponse = "idempotent-original-result";
    try {
      await env.harness.coordinator.commit(accepted.attemptId, {
        eventId: completed.event_id,
        generation: completed.generation,
        fence: completed.fence,
        expectedSequence: completed.sequence - 1,
        kind: "activation-confirmed",
        payload: JSON.parse(completed.payload),
      });
    } catch (error) {
      expect(error.code).toMatch(/FENCE|LEASE|AUTHORITY|CONTROLLER|SUPERSEDED/);
      lateResponse = error.code;
    }
    const afterLate = await env.state();
    expect(afterLate.attempt.state).toBe("activation-confirmed");
    expect(afterLate.attempt.percent).toBe(100);
    expect(
      env
        .history(accepted.attemptId)
        .filter((row) => row.kind === "activation-confirmed"),
    ).toEqual(successful);
    expect(afterLate.recovery.recoveryAttemptId).toBe(
      status.recovery.recoveryAttemptId,
    );
    expect(
      afterLate.availableWeb?.ready === true &&
        afterLate.availableWeb?.webRevision ===
          env.fixture.envelope.manifest.components.web.webRevision,
    ).toBe(false);
    return {
      attemptId: accepted.attemptId,
      recovery: status.recovery,
      historyDigest: digest(successful),
      lateOriginalCompletion: lateResponse,
    };
  }));

test("real insufficient samples, lost observations and measured consecutive soft latency freeze advancement [X06]", async ({
  page,
  context,
}, info) =>
  recordCase("X06", page, context, info, async (env) => {
    const accepted = await env.accept();
    await env.until((_s, b) => b.weight > 0 && b.weight < 100);
    const earlySnapshot = await env.harness.coordinator.snapshot(
        accepted.attemptId,
      ),
      earlyBinding = await env.binding(),
      insufficient = await env.harness.coordinator.observation(
        accepted.attemptId,
        {
          fence: earlySnapshot.fence,
          weight: earlyBinding.weight,
        },
      );
    expect(insufficient.candidate.requests).toBeLessThan(
      earlySnapshot.plan.policy.minRequests,
    );
    expect(insufficient.windowMs).toBeLessThan(
      earlySnapshot.plan.policy.stageDurationMs,
    );
    const inspection = inspectObservation(
      insufficient,
      earlySnapshot.plan.policy,
    );
    expect(
      inspection.fault,
      "A real early canary must be pending from sample evidence, not already invalid from another invariant",
    ).toBeUndefined();
    expect(inspection.qualified).toBe(false);
    expect(inspection.pending).toBe(true);
    expect((await env.binding()).routeGeneration).toBe(
      earlyBinding.routeGeneration,
    );
    expect((await env.state()).attempt.percent).not.toBe(100);
    await env.stopController();
    const snapshot = await env.harness.coordinator.snapshot(accepted.attemptId),
      before = await env.binding();
    const observation = await env.harness.coordinator.observation(
      accepted.attemptId,
      { fence: snapshot.fence, weight: before.weight },
    );
    expect(observation.observedAt).toBeTruthy();
    const start = performance.now();
    await expect
      .poll(
        () =>
          performance.now() - start >
          snapshot.plan.policy.observationFreshnessMs + 1000,
        { timeout: 10000 },
      )
      .toBe(true);
    const after = await env.state();
    expect(after.attempt.percent).not.toBe(100);
    expect((await env.binding()).routeGeneration).toBe(before.routeGeneration);
    expect(after.attempt.attemptId).toBe(accepted.attemptId);
    await env.harness.restartController();
    await env.until(
      (s, b) =>
        s.attempt.attemptId === accepted.attemptId &&
        b.weight === 100 &&
        s.attempt.state !== "activation-confirmed",
    );
    const current = await env.harness.coordinator.snapshot(accepted.attemptId);
    expect(current.fence).toBeGreaterThan(snapshot.fence);
    const priorBaseline = insufficient.baseline.p95Ms;
    const pauseMs = Math.ceil(
      Math.max(
        current.plan.policy.p95FloorMs + 100,
        priorBaseline * current.plan.policy.p95Ratio + 100,
      ),
    );
    invariant(
      pauseMs <= 1500 && pauseMs < current.plan.policy.requestDeadlineMs,
      "MEASURED_SOFT_FAULT_DURATION_MUST_FIT_FROZEN_HTTP_BUDGET",
    );
    const candidate = env.role("api"),
      proof = await env.adapter.inspect(candidate.containerId);
    expect(proof.startIdentity).toBe(candidate.startIdentity);
    expect(proof.running).toBe(true);
    const docker = env.config.docker;
    const pulse = async (action) => {
      invariant(
        ["pause", "unpause"].includes(action),
        "FIXED_NATIVE_DELAY_ACTION_REQUIRED",
      );
      await actualCommand(docker.cli ?? "docker", [
        ...docker.args,
        action,
        candidate.containerId,
      ]);
    };
    let paused = false,
      pulses = 0,
      softStatus;
    const deadline = performance.now() + 60000;
    try {
      while (performance.now() < deadline) {
        // Pause ONLY this known isolated ControlAPI process. Its real HTTP
        // requests wait in the kernel; no response or timing measurement is substituted.
        await pulse("pause");
        paused = true;
        ++pulses;
        await delay(pauseMs);
        await pulse("unpause");
        paused = false;
        await delay(Math.max(10, 1500 - pauseMs));
        softStatus = await env.state();
        if (softStatus.attempt.reason !== null) break;
      }
    } finally {
      if (paused) await pulse("unpause");
    }
    expect(
      softStatus?.attempt.reason,
      "Actual controller must identify measured soft degradation, not an unrelated hard SLO or invariant fault",
    ).toBe("SOFT_TRAFFIC_DEGRADATION");
    const measured = env
      .history(accepted.attemptId)
      .flatMap((row) => {
        const payload = JSON.parse(row.payload);
        const measured =
          row.kind === "progress"
            ? payload.evidence
            : row.kind === "failed"
              ? payload.evidence?.evidence
              : null;
        return measured?.candidate && measured?.baseline ? [measured] : [];
      })
      .filter(
        (measured) =>
          measured.candidate.p95Ms >
            measured.baseline.p95Ms * current.plan.policy.p95Ratio &&
          measured.candidate.p95Ms > current.plan.policy.p95FloorMs,
      );
    const evaluations = [
      ...new Map(measured.map((value) => [value.observedAt, value])).values(),
    ];
    expect(evaluations.length).toBeGreaterThanOrEqual(
      current.plan.policy.consecutiveEvaluations,
    );
    for (const evaluated of evaluations.slice(
      -current.plan.policy.consecutiveEvaluations,
    )) {
      expect(evaluated.probes.failures).toBe(0);
      expect(evaluated.probes.maxLatencyMs).toBeLessThanOrEqual(
        current.plan.policy.requestDeadlineMs,
      );
      expect(evaluated.probes.hz).toBeGreaterThanOrEqual(
        current.plan.policy.probeHz,
      );
      expect(
        Object.values(evaluated.invariants).every((value) => value === 0),
      ).toBe(true);
    }
    expect(softStatus.attempt.percent).not.toBe(100);
    expect(
      env.database.prepare("SELECT count(*) n FROM upgrade_attempts").get().n,
    ).toBe(1);
    return {
      attemptId: accepted.attemptId,
      staleObservedAt: observation.observedAt,
      unchangedRouteGeneration: before.routeGeneration,
      insufficientActualObservation: {
        observedAt: insufficient.observedAt,
        probes: insufficient.probes,
        candidate: insufficient.candidate,
        baseline: insufficient.baseline,
        windowMs: insufficient.windowMs,
        invariants: insufficient.invariants,
        evidenceDigest: digest(insufficient),
      },
      actualPendingInspection: inspection,
      softFault: {
        pulses,
        pauseMs,
        actualInputFingerprint:
          env.fixture.envelope.manifest.runInputFingerprint,
        reason: softStatus.attempt.reason,
        evaluations: evaluations.map((value) => ({
          observedAt: value.observedAt,
          candidate: value.candidate,
          baseline: value.baseline,
          probes: value.probes,
          evidenceDigest: digest(value),
        })),
      },
    };
  }));

test("actual controller loss and competing lease recover one accepted attempt and fence late work [X07]", async ({
  page,
  context,
}, info) =>
  recordCase("X07", page, context, info, async (env) => {
    const accepted = await env.accept();
    await env.until((s) => s.attempt?.state === "observing");
    const snapshot = await env.harness.coordinator.snapshot(accepted.attemptId);
    await expect(
      env.harness.coordinator.claim(accepted.attemptId, {
        controllerId: "competing-native-controller",
        leaseMs: 15000,
      }),
    ).rejects.toThrow();
    await env.stopController();
    await env.harness.restartController();
    await env.until((s) => s.attempt?.state === "activation-confirmed");
    const current = await env.harness.coordinator.snapshot(accepted.attemptId);
    expect(current.attempt.attemptId).toBe(accepted.attemptId);
    expect(current.fence).toBeGreaterThan(snapshot.fence);
    await expect(
      env.harness.coordinator.assertFence(accepted.attemptId, snapshot.fence),
    ).rejects.toThrow();
    expect(
      env.database.prepare("SELECT count(*) n FROM upgrade_attempts").get().n,
    ).toBe(1);
    return {
      attemptId: accepted.attemptId,
      oldFence: snapshot.fence,
      currentFence: current.fence,
    };
  }));

test("no healthy fallback never clears the only actually healthy B route [X08]", async ({
  page,
  context,
}, info) =>
  recordCase("X08", page, context, info, async (env) => {
    const accepted = await env.accept();
    await env.until((_s, b) => b.weight === 100);
    await env.stopController();
    const before = await env.binding();
    await env.signal(env.harness.roleContainers.apiA, "SIGKILL");
    const snapshot = await env.harness.coordinator.snapshot(accepted.attemptId);
    const eligibility = await env.harness.coordinator.fallbackEligibility(
      accepted.attemptId,
      {
        fence: snapshot.fence,
        fault: { code: "NATIVE_FALLBACK_HEALTH_FAILURE" },
        actual: before,
      },
    );
    expect(eligibility.qualified).toBe(false);
    expect((await env.binding()).weight).toBe(100);
    expect((await env.binding()).candidateApi.digest).toBe(
      before.candidateApi.digest,
    );
    return {
      attemptId: accepted.attemptId,
      eligibility,
      actualBinding: await env.binding(),
    };
  }));

test("independent actual semantic contraction retires legacy readers, preserves names and permanently fences historical rollback [X09]", async ({
  page,
  context,
}, info) =>
  recordCase("X09", page, context, info, async (env) => {
    invariant(
      env.fixture.envelope.manifest.contractPlans?.some(
        (plan) => plan.kind === "project-name-contract",
      ),
      "ACTUAL_SIGNED_SEMANTIC_CONTRACT_PACKAGE_REQUIRED",
    );
    const installed = await env.accept();
    await env.until((s) => s.attempt?.state === "activation-confirmed");
    const installedSnapshot = await env.harness.coordinator.snapshot(
      installed.attemptId,
    );
    const journalCount = env.database
      .prepare("SELECT count(*) n FROM __drizzle_migrations")
      .get().n;
    const originalName = (
      await responseJson(
        env.request,
        env.origin,
        "/api/projects/" + env.project.id,
      )
    ).name;
    // Explicit browser reload loads the actual installed B code and reconnects
    // its original public terminal. This is not a contract-triggered refresh.
    await env.resumeTerminal();
    await env.until(
      (s) =>
        s.capabilities.canContract === true &&
        s.contract?.availablePlan?.eligible === true,
    );
    const verified = await env.state(),
      plan = verified.contract.availablePlan;
    const controlCount = env.database
      .prepare(
        "SELECT count(*) n FROM platform_operations WHERE role='project-name-contract'",
      )
      .get().n;
    await page.goto(env.origin + "/settings/system#version");
    await page
      .getByRole("button", { name: "清理旧数据格式", exact: true })
      .click();
    expect(
      env.database
        .prepare(
          "SELECT count(*) n FROM platform_operations WHERE role='project-name-contract'",
        )
        .get().n,
    ).toBe(controlCount);
    const responsePromise = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          "/api/system/upgrade/contracts/requests" &&
        response.request().method() === "POST",
    );
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "确认清理", exact: true })
      .click();
    const response = await responsePromise;
    expect(response.status()).toBe(202);
    const command = response.request().postDataJSON(),
      accepted = await response.json();
    expect(command).toMatchObject({
      targetPlanDigest: plan.planDigest,
      expectedActivationGeneration: verified.activationGeneration,
      acknowledgeRollbackClosure: true,
    });
    expect(accepted.requestId).toBe(command.requestId);
    expect(accepted.instanceId).toBe(env.config.instanceId);
    const completed = await env.until(
      (s) =>
        s.contract?.attempt?.contractAttemptId === accepted.contractAttemptId &&
        s.contract.attempt.state === "completed",
    );
    expect(completed.contract.authority).toBe("new");
    expect(completed.contract.attempt.completedRows).toBeGreaterThan(0);
    expect(completed.contract.attempt.completedRows).toBe(
      completed.contract.attempt.totalRows,
    );
    const retired = await env.harness.coordinator.contractSnapshot(
      accepted.contractAttemptId,
    );
    expect(retired.fence).toBeGreaterThan(installedSnapshot.fence);
    expect(Object.keys(retired.retirementReceipts).length).toBeGreaterThan(0);
    for (const receipt of Object.values(retired.retirementReceipts)) {
      expect(receipt.retired).toBe(true);
      expect(receipt.definitelyAbsent).toBe(true);
      expect(receipt.originalResourcesPreserved).toBe(true);
      expect(receipt.lifecycleActions).toEqual([]);
      expect(receipt.retiredRole).toBe("coordinator");
      expect(receipt.qualified).toBe(true);
      expect(receipt.ownerBefore.qualified).toBe(true);
      expect(receipt.ownerAfter.qualified).toBe(true);
      expect(receipt.ownerIsolationDigest).toBe(
        receipt.ownerAfter.evidenceDigest,
      );
      for (const owner of receipt.ownerAfter.owners) {
        expect(owner.noBusinessDatabaseAccess).toBe(true);
        expect(owner.qualified).toBe(true);
      }
      if (receipt.after.containerId)
        expect(
          (await env.adapter.inspect(receipt.after.containerId)).running,
        ).toBe(false);
    }
    const isolationResponse = await fetch(
      env.harness.supervisor.origin + "/owner-isolation",
      {
        headers: { "x-platform-internal-key": env.config.keys.supervisor },
        signal: AbortSignal.timeout(5000),
      },
    );
    expect(isolationResponse.ok).toBe(true);
    const ownerIsolation = await isolationResponse.json();
    expect(ownerIsolation.instanceId).toBe(env.config.instanceId);
    expect(ownerIsolation.qualified).toBe(true);
    expect(ownerIsolation.owners.length).toBeGreaterThan(0);
    for (const owner of ownerIsolation.owners) {
      expect(owner.qualified).toBe(true);
      expect(owner.noBusinessDatabaseAccess).toBe(true);
    }
    const authority = env.database
      .prepare(
        "SELECT checkpoint,read_epoch FROM upgrade_online_migrations WHERE plan_digest=?",
      )
      .get(plan.expandPlanDigest);
    expect(authority.read_epoch).toBe(2);
    const marker = JSON.parse(authority.checkpoint).authorityMarkerPrefix;
    expect(marker).toMatch(/^~r[a-f0-9]{8}v[0-9]{1,2}:$/);
    const slot = (id) => marker + digest({ projectId: id }).slice(7, 31);
    const originalSlot = env.database
      .prepare("SELECT name FROM projects WHERE id=?")
      .get(env.project.id).name;
    expect(originalSlot).toBe(slot(env.project.id));
    expect(originalSlot.length).toBeLessThanOrEqual(40);
    expect(originalSlot).not.toBe(originalName);
    expect(
      (
        await responseJson(
          env.request,
          env.origin,
          "/api/projects/" + env.project.id,
        )
      ).name,
    ).toBe(originalName);
    const newer = await responseJson(
      env.request,
      env.origin,
      "/api/projects",
      "POST",
      { name: "new authority write preserved", sourceType: "empty" },
      202,
    );
    expect(
      (await responseJson(env.request, env.origin, "/api/projects/" + newer.id))
        .name,
    ).toBe("new authority write preserved");
    expect(
      env.database.prepare("SELECT name FROM projects WHERE id=?").get(newer.id)
        .name,
    ).toBe(slot(newer.id));
    const duplicate = await env.request.post(env.origin + "/api/projects", {
      data: { name: "new authority write preserved", sourceType: "empty" },
      headers: { Origin: env.origin, "X-Operation-Id": randomUUID() },
    });
    expect(duplicate.status()).toBe(409);
    const remote = await absentGitRemote();
    let converted, failedGit, remoteEvidence, beforeVersion, afterVersion;
    try {
      const git = await responseJson(
        env.request,
        env.origin,
        "/api/projects",
        "POST",
        {
          name: "new authority git update",
          sourceType: "git",
          repoUrl: remote.url,
        },
        202,
      );
      await expect
        .poll(
          async () => {
            failedGit = await responseJson(
              env.request,
              env.origin,
              "/api/projects/" + git.id,
            );
            return failedGit.cloneStatus;
          },
          { timeout: 120000, intervals: [100, 250] },
        )
        .toBe("failed");
      expect(remote.requests.length).toBeGreaterThan(0);
      expect(failedGit.sourceType).toBe("git");
      expect(failedGit.name).toBe("new authority git update");
      beforeVersion = env.database
        .prepare("SELECT version FROM projects WHERE id=?")
        .get(git.id).version;
      converted = await responseJson(
        env.request,
        env.origin,
        "/api/projects/" + git.id + "/convert-to-empty",
        "POST",
        {},
      );
      expect(converted.sourceType).toBe("empty");
      expect(converted.cloneStatus).toBe("ready");
      expect(converted.name).toBe(failedGit.name);
      afterVersion = env.database
        .prepare("SELECT version FROM projects WHERE id=?")
        .get(git.id).version;
      expect(afterVersion).toBeGreaterThan(beforeVersion);
      expect(
        env.database.prepare("SELECT name FROM projects WHERE id=?").get(git.id)
          .name,
      ).toBe(slot(git.id));
      const projection = env.database
        .prepare(
          "SELECT " +
            identifier(retired.plan.nameColumn) +
            " name FROM " +
            identifier(retired.plan.targetTable) +
            " WHERE row_key=? AND tombstone=0",
        )
        .get(git.id);
      expect(projection.name).toBe(converted.name);
      remoteEvidence = { requests: remote.requests };
    } finally {
      await remote.close();
    }
    await responseJson(
      env.request,
      env.origin,
      "/api/projects/" + newer.id,
      "DELETE",
      undefined,
      204,
    );
    expect(
      (
        await env.request.get(env.origin + "/api/projects/" + newer.id)
      ).status(),
    ).toBe(404);
    expect(
      env.database
        .prepare("SELECT name FROM projects WHERE id=?")
        .get(newer.id),
    ).toBeUndefined();
    expect(
      env.database.prepare("SELECT count(*) n FROM __drizzle_migrations").get()
        .n,
    ).toBe(journalCount);
    let oldFenceRejection;
    try {
      await env.harness.coordinator.claim(installed.attemptId, {
        controllerId: "forbidden-retired-upgrade",
        leaseMs: 15000,
      });
      throw new Error(
        "Retired controller unexpectedly claimed business authority",
      );
    } catch (error) {
      expect(error.code).toMatch(/AUTHORITY|CONTRACT|FENCE/);
      oldFenceRejection = error.code;
    }
    const lookup = await responseJson(
      env.request,
      env.origin,
      "/api/system/upgrade/contracts/requests/" + command.requestId,
    );
    expect(lookup.contractAttemptId).toBe(accepted.contractAttemptId);
    expect(lookup.state).toBe("completed");
    expect(
      env.database
        .prepare(
          "SELECT count(*) n FROM platform_operations WHERE role='project-name-contract'",
        )
        .get().n,
    ).toBe(controlCount + 1);
    expect(
      env.database.prepare("SELECT count(*) n FROM upgrade_attempts").get().n,
    ).toBe(1);
    await page.goto(
      env.origin + "/?taskId=" + encodeURIComponent(env.original.id),
    );
    return {
      attemptId: installed.attemptId,
      contractAttemptId: accepted.contractAttemptId,
      contractPlanDigest: plan.planDigest,
      contractFence: retired.fence,
      authority: "new",
      globalSchemaUnchanged: journalCount,
      retirementReceiptDigests: Object.values(retired.retirementReceipts).map(
        (receipt) => digest(receipt),
      ),
      originalProjectNameDigest: digest(originalName),
      newWritesPreserved: true,
      oldControllerFenced: true,
      semanticContractEvidence: {
        instanceId: env.config.instanceId,
        contractPlanDigest: plan.planDigest,
        inputFingerprint: env.fixture.envelope.manifest.runInputFingerprint,
        artifactInputFingerprint:
          env.fixture.envelope.manifest.contractPlans.find(
            (item) => item.planDigest === plan.planDigest,
          ).artifactInputFingerprint,
        expandPlanDigest: plan.expandPlanDigest,
        contractAttemptId: accepted.contractAttemptId,
        requestId: command.requestId,
        activationGeneration: accepted.activationGeneration,
        contractFence: retired.fence,
        completedRows: completed.contract.attempt.completedRows,
        totalRows: completed.contract.attempt.totalRows,
        retainedReaderReceipts: retired.retirementReceipts,
        ownerIsolation,
        actualCrud: {
          originalProjectId: env.project.id,
          originalNameDigest: digest(originalName),
          originalInternalSlot: originalSlot,
          createdProjectId: newer.id,
          createdNameDigest: digest(newer.name),
          updatedProjectId: converted.id,
          preservedUpdatedNameDigest: digest(converted.name),
          updatePath: "/api/projects/:id/convert-to-empty",
          beforeVersion,
          afterVersion,
          sourceTypeBefore: failedGit.sourceType,
          sourceTypeAfter: converted.sourceType,
          gitFixture: remoteEvidence,
          deleted: true,
          duplicateNameRejected: true,
        },
        authority: "new",
        oldControllerFenced: true,
        globalSchemaUnchanged: journalCount,
        oldFenceRejection,
      },
      afterContinuity: () => secondRecoveryFailure(context.browser()),
    };
  }));

test("shared DB and actual Owner Node loss retain original running jobs, stopped SDK resources and truthful unknown attachments [X10]", async ({
  page,
  context,
}, info) =>
  recordCase("X10", page, context, info, async (env) => {
    const stopped = await responseJson(
      env.request,
      env.origin,
      "/api/sandboxes",
      "POST",
      {
        projectId: env.project.id,
        runtime: env.input.runtimeId ?? "codex",
        ...(env.imageProof ? { image: env.imageProof.imageManifestId } : {}),
      },
      201,
    );
    env.owned.push(stopped.id);
    await expect
      .poll(
        async () =>
          (
            await responseJson(
              env.request,
              env.origin,
              "/api/sandboxes/" + stopped.id,
            )
          ).status,
        { timeout: 180000 },
      )
      .toBe("running");
    await responseJson(
      env.request,
      env.origin,
      "/api/sandboxes/" + stopped.id + "/stop",
      "POST",
      {},
    );
    await expect
      .poll(
        async () =>
          (
            await responseJson(
              env.request,
              env.origin,
              "/api/sandboxes/" + stopped.id,
            )
          ).status,
      )
      .toBe("stopped");
    const resourceIds = [env.original.id, env.headless.id, stopped.id],
      resourcesBefore = await readOwnerResources(env, resourceIds);
    expect(
      resourcesBefore.find((row) => row.sandboxId === stopped.id),
    ).toMatchObject({
      businessStatus: "stopped",
      sdkStatus: "stopped",
      shimPid: null,
    });
    const accepted = await env.accept();
    await env.until((_s, b) => b.weight > 0);
    await env.stopController();
    let lease;
    await expect
      .poll(
        async () => {
          try {
            lease = await env.harness.coordinator.claim(accepted.attemptId, {
              controllerId: "native-owner-observation-fault",
              leaseMs: 120000,
            });
            return true;
          } catch {
            return false;
          }
        },
        { timeout: 45000, intervals: [100, 250] },
      )
      .toBe(true);
    const snapshot = await env.harness.coordinator.snapshot(accepted.attemptId),
      before = await env.binding();
    env.database.exec(
      "ALTER TABLE agent_tasks RENAME TO native_fault_saved_tasks",
    );
    try {
      await expect(
        env.harness.coordinator.continuity(accepted.attemptId, {
          fence: snapshot.fence,
        }),
      ).rejects.toThrow();
      const after = await env.binding();
      expect(after.routeGeneration).toBe(before.routeGeneration);
      expect(after.weight).toBe(before.weight);
    } finally {
      env.database.exec(
        "ALTER TABLE native_fault_saved_tasks RENAME TO agent_tasks",
      );
    }
    const originalOwner = env.harness.roleContainers.owner,
      auditBefore = await ownerAudit(env),
      counterBefore = await hostCounter(env, env.original.id),
      headlessBefore = env.model
        ? await hostCounter(env, env.headless.id, true)
        : null,
      fromConnections = env.evidence.connections.length,
      fromReady = env.evidence.ready.length;
    let ownerStopped = false,
      ownerFault,
      ownerLossProof;
    try {
      const pausedAt = performance.now();
      ownerFault = await signalOwnedNode(env, originalOwner, "SIGSTOP");
      ownerStopped = true;
      // The Owner RPC is truly unreachable, rather than a substituted response.
      await expect(
        fetch(`http://127.0.0.1:${env.harness.ports.owner}/runtime/metadata`, {
          headers: {
            "x-platform-internal-key": env.config.keys.owner,
            "x-platform-instance-id": env.config.instanceId,
          },
          signal: AbortSignal.timeout(1500),
        }),
      ).rejects.toThrow();
      await page.reload();
      await expect
        .poll(
          () =>
            env.evidence.connections
              .slice(fromConnections)
              .some(
                (row) =>
                  row.code === "RUNTIME_UNKNOWN" ||
                  (row.type === "connection_state" &&
                    row.state === "unconfirmed"),
              ),
          { timeout: 7000, intervals: [50, 100] },
        )
        .toBe(true);
      expect(
        env.evidence.connections
          .slice(fromConnections)
          .some((row) =>
            ["TERMINAL_GONE", "AUTH_EXPIRED", "PROTOCOL_INCOMPATIBLE"].includes(
              row.code,
            ),
          ),
      ).toBe(false);
      expect(
        env.evidence.ready
          .slice(fromReady)
          .filter((row) => row.sandboxId === env.original.id),
      ).toHaveLength(0);
      await expect
        .poll(() => performance.now() - pausedAt, { timeout: 8000 })
        .toBeGreaterThan(6500);
      const during = await readOwnerResources(env, resourceIds),
        counterDuring = await hostCounter(env, env.original.id),
        headlessDuring = env.model
          ? await hostCounter(env, env.headless.id, true)
          : null,
        pausedMs = performance.now() - pausedAt;
      expect(during).toEqual(resourcesBefore);
      expect(
        env.database
          .prepare("SELECT status FROM agent_tasks WHERE id=?")
          .get(env.task.id).status,
      ).toBe("running");
      expect(counterDuring.slice(0, counterBefore.length)).toEqual(
        counterBefore,
      );
      expect(
        counterDuring.length - counterBefore.length,
      ).toBeGreaterThanOrEqual(Math.floor(pausedMs / 1000) - 1);
      if (headlessDuring) {
        expect(headlessDuring.slice(0, headlessBefore.length)).toEqual(
          headlessBefore,
        );
        expect(
          headlessDuring.length - headlessBefore.length,
        ).toBeGreaterThanOrEqual(Math.floor(pausedMs / 1000) - 1);
      }
      const shimProof = [];
      for (const resource of during.filter((row) => row.shimPid !== null)) {
        invariant(
          Number.isSafeInteger(resource.shimPid) && resource.shimPid > 1,
          "ORIGINAL_SHIM_PID_REQUIRED",
        );
        const stat = await actualCommand(env.config.docker.cli || "docker", [
          ...env.config.docker.args,
          "exec",
          originalOwner.containerId,
          "cat",
          "/proc/" + resource.shimPid + "/stat",
        ]);
        expect(Number(stat.slice(0, stat.indexOf(" ")))).toBe(resource.shimPid);
        const birth = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
        expect(birth).toMatch(/^\d+$/);
        shimProof.push({
          runtimeIdentity: resource.runtimeIdentity,
          shimPid: resource.shimPid,
          processBirth: birth,
        });
      }
      ownerLossProof = {
        pausedMs,
        resourcesDuring: during,
        shimProof,
        shellCounter: {
          before: counterBefore.length,
          during: counterDuring.length,
        },
        headlessCounter: headlessDuring
          ? { before: headlessBefore.length, during: headlessDuring.length }
          : null,
        observedConnections: env.evidence.connections.slice(fromConnections),
        newSdkHomesOpened: 0,
        controllerOwnerHomeAccess: false,
      };
    } finally {
      if (ownerStopped) await signalOwnedNode(env, originalOwner, "SIGCONT");
    }
    const auditAfter = await ownerAudit(env),
      resourcesAfter = await readOwnerResources(env, resourceIds);
    expect(resourcesAfter).toEqual(resourcesBefore);
    expect(auditAfter.assignments).toEqual(auditBefore.assignments);
    const oldOperations = new Set(auditBefore.operations.map((row) => row.id));
    expect(
      auditAfter.operations.filter(
        (row) =>
          !oldOperations.has(row.id) &&
          resourceIds.includes(row.sandboxId) &&
          [
            "create",
            "start",
            "stop",
            "destroy",
            "jobs.startJob",
            "jobs.killJob",
            "jobs.releaseJob",
          ].includes(row.method),
      ),
    ).toEqual([]);
    await expect
      .poll(
        () =>
          env.evidence.ready
            .slice(fromReady)
            .some(
              (row) =>
                row.sandboxId === env.original.id &&
                row.terminalIdentity === env.terminal.terminalIdentity &&
                row.runtimeIdentity === env.terminal.runtimeIdentity &&
                row.existingSession,
            ),
        { timeout: 15000, intervals: [50, 100] },
      )
      .toBe(true);
    expect(
      env.database.prepare("SELECT count(*) n FROM upgrade_attempts").get().n,
    ).toBe(1);
    expect(
      env.database.prepare("SELECT count(*) n FROM upgrade_recoveries").get().n,
    ).toBe(0);
    return {
      attemptId: accepted.attemptId,
      sharedDatabaseFault: true,
      routeUnchanged: true,
      ownerFault,
      ownerLossProof,
      resourcesBefore,
      resourcesAfter,
      stoppedResourceId: stopped.id,
      originalAssignmentDigest: digest(auditAfter.assignments),
    };
  }));

test("real online batches retain checkpoints and newer writes/deletions under lost acknowledgement [X11]", async ({
  page,
  context,
}, info) =>
  recordCase("X11", page, context, info, async (env) => {
    invariant(env.input.automationInput, "REAL_BUSINESS_UPDATE_INPUT_REQUIRED");
    const createDisabled = async (projectId, name) => {
      const rule = await responseJson(
        env.request,
        env.origin,
        `/api/projects/${projectId}/automations`,
        "POST",
        {
          ...env.input.automationInput,
          name,
          scheduleKind: "hourly",
          scheduleConfig: { minute: (new Date().getUTCMinutes() + 30) % 60 },
          timezone: "UTC",
        },
        201,
      );
      const disabled = await responseJson(
        env.request,
        env.origin,
        `/api/automations/${rule.id}/disable`,
        "POST",
        {},
      );
      expect(disabled.enabled).toBe(false);
      return disabled;
    };
    const cascadeProject = await responseJson(
      env.request,
      env.origin,
      "/api/projects",
      "POST",
      { name: "migration cascade source", sourceType: "empty" },
      202,
    );
    const racedRule = await createDisabled(
        cascadeProject.id,
        "before online backfill",
      ),
      cascadedRule = await createDisabled(
        cascadeProject.id,
        "cascaded child rule",
      );
    const m = await acquiredMigration(env, "automations"),
      operationId = randomUUID();
    // The actual bounded repair operation establishes a fresh reconciliation
    // epoch even if the small initial dataset already completed before the ACK.
    await m.call(randomUUID(), "repair", JSON.parse(m.row().checkpoint));
    const checkpoint = JSON.parse(m.row().checkpoint);
    const committed = await m.call(operationId, "batch", checkpoint),
      after = m.row();
    const replay = await m.call(operationId, "batch", checkpoint);
    expect(replay).toEqual(committed);
    expect(m.row().completed_work).toBe(after.completed_work);
    await expect(
      m.call(operationId, "batch", { phase: "different" }),
    ).rejects.toThrow();
    const projection = m.plan.projections.find(
        (p) => p.sourceTable === "automations",
      ),
      nameField = projection.fields.find((field) => field.source === "name");
    invariant(nameField, "AUTOMATION_NAME_PROJECTION_REQUIRED");
    const raceStartedAt = performance.now();
    const operations = Array.from({ length: 8 }, (_, n) => ({
      operationId: randomUUID(),
      name: `concurrent online update ${n}`,
    }));
    await Promise.all([
      m.call(randomUUID(), "batch", JSON.parse(m.row().checkpoint)),
      ...operations.map(async (update) => {
        const response = await env.request.put(
          env.origin + `/api/automations/${racedRule.id}`,
          {
            data: { name: update.name },
            headers: {
              Origin: env.origin,
              "X-Operation-Id": update.operationId,
            },
            timeout: 2000,
          },
        );
        expect(response.status()).toBe(200);
        expect((await response.json()).name).toBe(update.name);
      }),
    ]);
    const raceFinishedAt = performance.now();
    const latest = await responseJson(
      env.request,
      env.origin,
      `/api/automations/${racedRule.id}`,
    );
    expect(operations.map((update) => update.name)).toContain(latest.name);
    const latestRevision = env.database
      .prepare(
        "SELECT max(id) revision FROM upgrade_projection_changes WHERE plan_digest=? AND projection=? AND row_key=?",
      )
      .get(m.planDigest, projection.targetTable, racedRule.id).revision;
    await advanceMigration(m);
    const reconciled = env.database
      .prepare(
        "SELECT * FROM " +
          identifier(projection.targetTable) +
          " WHERE row_key=?",
      )
      .get(racedRule.id);
    expect(reconciled.tombstone).toBe(0);
    expect(reconciled[nameField.name]).toBe(latest.name);
    expect(reconciled.row_revision).toBeGreaterThanOrEqual(latestRevision);
    const newer = await responseJson(
      env.request,
      env.origin,
      `/api/projects/${env.project.id}/automations`,
      "POST",
      {
        ...env.input.automationInput,
        name: "newer migration write",
        scheduleKind: "hourly",
        scheduleConfig: { minute: (new Date().getUTCMinutes() + 30) % 60 },
        timezone: "UTC",
      },
      201,
    );
    await responseJson(
      env.request,
      env.origin,
      `/api/automations/${newer.id}`,
      "PUT",
      { name: "updated migration write" },
    );
    await responseJson(
      env.request,
      env.origin,
      `/api/automations/${newer.id}`,
      "DELETE",
      {},
      204,
    );
    await advanceMigration(m);
    const shadow = env.database
      .prepare(
        "SELECT * FROM " +
          identifier(projection.targetTable) +
          " WHERE row_key=?",
      )
      .get(newer.id);
    expect(shadow?.tombstone).toBe(1);
    expect(
      env.database
        .prepare("SELECT 1 FROM automations WHERE id=?")
        .get(newer.id),
    ).toBeUndefined();
    await responseJson(
      env.request,
      env.origin,
      `/api/projects/${cascadeProject.id}`,
      "DELETE",
      { keepBaseline: false },
      204,
    );
    await m.call(randomUUID(), "repair", JSON.parse(m.row().checkpoint));
    await advanceMigration(m);
    for (const child of [racedRule, cascadedRule]) {
      expect(
        env.database
          .prepare("SELECT 1 FROM automations WHERE id=?")
          .get(child.id),
      ).toBeUndefined();
      const deletedShadow = env.database
        .prepare(
          "SELECT tombstone,row_revision FROM " +
            identifier(projection.targetTable) +
            " WHERE row_key=?",
        )
        .get(child.id);
      expect(deletedShadow.tombstone).toBe(1);
      const deletion = env.database
        .prepare(
          "SELECT max(id) revision FROM upgrade_projection_changes WHERE plan_digest=? AND projection=? AND row_key=? AND tombstone=1 AND projected=1",
        )
        .get(m.planDigest, projection.targetTable, child.id);
      expect(deletion.revision).toBeGreaterThan(0);
      expect(deletedShadow.row_revision).toBeGreaterThanOrEqual(
        deletion.revision,
      );
    }
    expect(
      env.database
        .prepare("SELECT 1 FROM projects WHERE id=?")
        .get(cascadeProject.id),
    ).toBeUndefined();
    expect(env.database.pragma("foreign_key_check")).toEqual([]);
    expect(m.row().degraded).toBe(0);
    return {
      attemptId: m.accepted.attemptId,
      checkpoint: JSON.parse(m.row().checkpoint),
      completedWork: m.row().completed_work,
      deletedRowDigest: digest(newer.id),
      concurrentRevision: {
        count: operations.length,
        operationDigests: operations.map((update) =>
          digest(update.operationId),
        ),
        raceStartedAt,
        raceFinishedAt,
        latestRevision,
        shadowRevision: reconciled.row_revision,
        authoritativeNameDigest: digest(latest.name),
      },
      cascade: {
        projectDigest: digest(cascadeProject.id),
        childDigests: [racedRule, cascadedRule].map((rule) => digest(rule.id)),
        foreignKeysValid: true,
        tombstonesConfirmed: true,
      },
    };
  }));

test("isolated shadow loss preserves original write/outbox; actual outbox failure rolls back business [X12]", async ({
  page,
  context,
}, info) =>
  recordCase("X12", page, context, info, async (env) => {
    const m = await acquiredMigration(env),
      projection = m.plan.projections.find((p) => p.sourceTable === "projects");
    env.database.exec("DROP TABLE " + identifier(projection.targetTable));
    const original = await responseJson(
      env.request,
      env.origin,
      "/api/projects",
      "POST",
      { name: "old authority remains writable", sourceType: "empty" },
      202,
    );
    expect(
      env.database
        .prepare("SELECT 1 FROM projects WHERE id=?")
        .get(original.id),
    ).toBeTruthy();
    expect(
      env.database
        .prepare(
          "SELECT count(*) n FROM upgrade_projection_changes WHERE plan_digest=? AND row_key=?",
        )
        .get(m.planDigest, original.id).n,
    ).toBeGreaterThan(0);
    expect(m.row().read_epoch).toBe(0);
    await m.call(randomUUID(), "repair", JSON.parse(m.row().checkpoint));
    await advanceMigration(m);
    expect(
      env.database
        .prepare(
          "SELECT 1 FROM " +
            identifier(projection.targetTable) +
            " WHERE row_key=? AND tombstone=0",
        )
        .get(original.id),
    ).toBeTruthy();
    env.database.exec(
      "ALTER TABLE upgrade_projection_changes RENAME TO native_fault_saved_outbox",
    );
    const count = env.database
      .prepare("SELECT count(*) n FROM projects")
      .get().n;
    try {
      const failed = await env.request.post(env.origin + "/api/projects", {
        data: { name: "must not falsely commit", sourceType: "empty" },
        headers: { Origin: env.origin, "X-Operation-Id": randomUUID() },
      });
      expect(failed.status()).toBeGreaterThanOrEqual(400);
      expect(
        env.database.prepare("SELECT count(*) n FROM projects").get().n,
      ).toBe(count);
    } finally {
      env.database.exec(
        "ALTER TABLE native_fault_saved_outbox RENAME TO upgrade_projection_changes",
      );
    }
    return {
      attemptId: m.accepted.attemptId,
      isolatedShadowRecovered: true,
      outboxFailureBusinessRollback: true,
    };
  }));

test("actual pinned WAL, allocated disk, transaction waits and maximum public data qualify only namespace changes and defer global DDL [X13]", async ({
  page,
  context,
}, info) =>
  recordCase("X13", page, context, info, async (env) => {
    invariant(
      env.input.automationInput,
      "REAL_WAL_BUSINESS_LOAD_INPUT_REQUIRED",
    );
    const rules = [];
    for (let i = 0; i < 8; i++) {
      const rule = await responseJson(
        env.request,
        env.origin,
        `/api/projects/${env.project.id}/automations`,
        "POST",
        {
          ...env.input.automationInput,
          name: "WAL qualification writer " + i,
          scheduleKind: "hourly",
          scheduleConfig: { minute: (new Date().getUTCMinutes() + 30) % 60 },
          timezone: "UTC",
        },
        201,
      );
      await responseJson(
        env.request,
        env.origin,
        `/api/automations/${rule.id}/disable`,
        "POST",
        {},
      );
      rules.push(rule.id);
    }
    const migration = await acquiredMigration(env),
      policy = migration.snapshot.plan.policy,
      Database = createRequire(
        join(env.config.initialRoot, "api/package.json"),
      )("better-sqlite3"),
      reader = new Database(env.database.name, {
        readonly: true,
        fileMustExist: true,
      }),
      checkpointBefore = migration.row().checkpoint;
    reader.pragma("query_only=ON");
    reader.exec("BEGIN");
    reader.prepare("SELECT count(*) n FROM projects").get();
    let loading = true,
      count = 0,
      workerError,
      leaseError;
    const leaseTimer = setInterval(() => {
      env.harness.coordinator
        .renew(migration.accepted.attemptId, {
          controllerId: "native-fault-controller",
          fence: migration.lease.fence,
        })
        .catch((error) => {
          leaseError = error;
        });
    }, 1000);
    const workers = rules.map((ruleId, worker) =>
      (async () => {
        let n = 0;
        while (loading) {
          const response = await env.request.put(
            env.origin + "/api/automations/" + ruleId,
            {
              data: { name: "wal-pressure-" + worker + "-" + ++n },
              headers: { Origin: env.origin, "X-Operation-Id": randomUUID() },
              timeout: 2000,
            },
          );
          expect(response.status()).toBe(200);
          count++;
        }
      })().catch((error) => {
        workerError = error;
        loading = false;
      }),
    );
    let walBytes, observedBudget;
    try {
      await expect
        .poll(
          async () => {
            if (workerError) throw workerError;
            if (leaseError) throw leaseError;
            walBytes = (await fs.stat(env.database.name + "-wal")).size;
            return walBytes;
          },
          { timeout: 240000, intervals: [25, 50] },
        )
        .toBeGreaterThan(policy.maxWalBytes);
      loading = false;
      await Promise.all(workers);
      if (workerError) throw workerError;
      await expect(
        migration.call(randomUUID(), "batch", JSON.parse(checkpointBefore)),
      ).rejects.toThrow("MIGRATION_WAL_BUDGET");
      observedBudget = {
        declaredMaxWalBytes: policy.maxWalBytes,
        measuredWalBytes: walBytes,
        actualPublicWrites: count,
        realPinnedReadTransaction: true,
        rejectedCode: "MIGRATION_WAL_BUDGET",
      };
      expect(count).toBeGreaterThan(0);
      expect(migration.row().checkpoint).toBe(checkpointBefore);
    } finally {
      loading = false;
      await Promise.all(workers);
      clearInterval(leaseTimer);
      reader.exec("ROLLBACK");
      reader.close();
    }
    return {
      attemptId: migration.accepted.attemptId,
      walBudget: observedBudget,
      inputFingerprint: env.fixture.envelope.manifest.runInputFingerprint,
      afterContinuity: () => x13RemainingBudgetsAndMaximum(context.browser()),
    };
  }));

test("parallel real business/CAS/operation lookup and timer automation preserve one original occurrence [X14]", async ({
  page,
  context,
}, info) =>
  recordCase("X14", page, context, info, async (env) => {
    invariant(env.input.automationInput, "REAL_DUE_AUTOMATION_INPUT_REQUIRED");
    invariant(
      env.model && typeof env.model.finishTask === "function",
      "ACTUAL_CONTROLLED_MODEL_EXIT_CAPABILITY_REQUIRED",
    );
    // The real Tasks application admits any running sandbox with the delivered
    // runtime and jobs/files planes. Reuse the original interactive Guest while
    // its original tmux and seconds counter continue, rather than allocating a
    // fourth Guest beyond the qualification host's actual memory/CPU capacity.
    const exitProofId = randomUUID(),
      exitSandbox = env.original;
    const beforeTasks = await responseJson(
      env.request,
      env.origin,
      `/api/sandboxes/${exitSandbox.id}`,
    );
    expect(beforeTasks.status).toBe("running");
    const natural = await responseJson(
      env.request,
      env.origin,
      `/api/sandboxes/${exitSandbox.id}/runtimes/${env.model.runtimeId}/tasks`,
      "POST",
      { prompt: qualificationExitPrompt(exitProofId), timeoutMinutes: 30 },
      202,
    );
    await expect
      .poll(
        () =>
          env.model
            .evidence()
            .requests.filter(
              (row) =>
                row.taskId === exitProofId && row.phase === "tool-result-held",
            ).length,
        { timeout: 180000 },
      )
      .toBeGreaterThan(0);
    const naturalJob = JSON.parse(
      env.database
        .prepare("SELECT job_handle FROM agent_tasks WHERE id=?")
        .get(natural.id).job_handle,
    );
    expect(
      (
        await responseJson(
          env.request,
          env.origin,
          `/api/sandboxes/${exitSandbox.id}/tasks/${natural.id}`,
        )
      ).status,
    ).toBe("running");
    const finiteCounter = await responseJson(
      env.request,
      env.origin,
      `/api/sandboxes/${exitSandbox.id}/exec`,
      "POST",
      {
        command: "cat /workspace/.upg-agent-proof/" + exitProofId + "/counter",
      },
    );
    expect(finiteCounter.exitCode).toBe(0);
    expect(finiteCounter.stdout.trim().split("\n").map(Number)).toEqual([
      1, 2, 3,
    ]);
    const automationInput = env.model
      ? {
          ...env.input.automationInput,
          runtime: env.model.runtimeId,
          scheduleKind: "hourly",
          scheduleConfig: { minute: (new Date().getUTCMinutes() + 2) % 60 },
          timezone: "UTC",
        }
      : env.input.automationInput;
    const automation = await responseJson(
      env.request,
      env.origin,
      `/api/projects/${env.project.id}/automations`,
      "POST",
      automationInput,
      201,
    );
    const accepted = await env.accept(),
      operationId = randomUUID(),
      body = { name: "one accepted business operation", sourceType: "empty" };
    const [first, second] = await Promise.all([
      env.request.post(env.origin + "/api/projects", {
        data: body,
        headers: { Origin: env.origin, "X-Operation-Id": operationId },
      }),
      env.request.post(env.origin + "/api/projects", {
        data: body,
        headers: { Origin: env.origin, "X-Operation-Id": operationId },
      }),
    ]);
    expect(first.status()).toBe(202);
    expect(second.status()).toBe(202);
    const a = await first.json(),
      b = await second.json();
    expect(a.id).toBe(b.id);
    const read = await responseJson(
      env.request,
      env.origin,
      "/api/operations/" + operationId,
    );
    expect(read.state).toBe("complete");
    const migration = await acquiredMigration(env, "projects", accepted);
    const projection = migration.plan.projections.find(
      (row) => row.sourceTable === "projects",
    );
    // Recreate only this signed isolated shadow representation through the real
    // migration repair command. The original authoritative rows remain intact.
    // Keeping the actual repaired backfill pending provides a genuine ongoing
    // conversion/recovery window for the Guest CLI exit and explicit cancel.
    env.database.exec("DROP TABLE " + identifier(projection.targetTable));
    await migration.call(
      randomUUID(),
      "repair",
      JSON.parse(migration.row().checkpoint),
    );
    expect(migration.row().stage).not.toBe("complete");
    const migrationPhaseAtExit = migration.row().stage,
      released = env.model.finishTask(exitProofId);
    expect(released.finalResponseReleased).toBe(true);
    let naturalResult;
    await expect
      .poll(
        async () => {
          naturalResult = await responseJson(
            env.request,
            env.origin,
            `/api/sandboxes/${exitSandbox.id}/tasks/${natural.id}`,
          );
          return naturalResult.status;
        },
        { timeout: 30000 },
      )
      .toBe("succeeded");
    expect(migration.row().stage).not.toBe("complete");
    const completion = env.database
      .prepare("SELECT * FROM agent_task_job_completions WHERE task_id=?")
      .get(natural.id);
    expect(completion).toMatchObject({
      sandbox_id: exitSandbox.id,
      exit_kind: "natural",
      exit_code: 0,
      job_handle_digest: digest({
        provider: naturalJob.provider,
        jobId: naturalJob.jobId,
      }),
    });
    expect(completion.last_seq).toBe(naturalResult.lastSeq);
    const baseline = JSON.parse(
      env.database
        .prepare(
          "SELECT snapshot FROM upgrade_continuity_baselines WHERE attempt_id=?",
        )
        .get(accepted.attemptId).snapshot,
    );
    expect(baseline.tasks.some((row) => row.id === natural.id)).toBe(true);
    expect(completion.observed_at).toBeGreaterThanOrEqual(
      Date.parse(baseline.observedAt),
    );
    expect(
      env.model
        .evidence()
        .finalResponses.filter((row) => row.taskId === exitProofId),
    ).toHaveLength(1);
    expect(
      env.model
        .evidence()
        .requests.filter(
          (row) => row.taskId === exitProofId && row.phase === "tool-issued",
        ),
    ).toHaveLength(1);
    const cancelProofId = randomUUID(),
      cancelled = await responseJson(
        env.request,
        env.origin,
        `/api/sandboxes/${exitSandbox.id}/runtimes/${env.model.runtimeId}/tasks`,
        "POST",
        { prompt: qualificationPrompt(cancelProofId), timeoutMinutes: 30 },
        202,
      );
    await expect
      .poll(
        () =>
          env.model
            .evidence()
            .requests.filter(
              (row) =>
                row.taskId === cancelProofId && row.phase === "tool-issued",
            ).length,
        { timeout: 180000 },
      )
      .toBe(1);
    const cancelJob = JSON.parse(
      env.database
        .prepare("SELECT job_handle FROM agent_tasks WHERE id=?")
        .get(cancelled.id).job_handle,
    );
    await responseJson(
      env.request,
      env.origin,
      `/api/sandboxes/${exitSandbox.id}/tasks/${cancelled.id}/cancel`,
      "POST",
      {},
      202,
    );
    await expect
      .poll(
        async () =>
          (
            await responseJson(
              env.request,
              env.origin,
              `/api/sandboxes/${exitSandbox.id}/tasks/${cancelled.id}`,
            )
          ).status,
        { timeout: 30000 },
      )
      .toBe("killed");
    const cancelReceipt = env.database
      .prepare("SELECT * FROM agent_task_job_completions WHERE task_id=?")
      .get(cancelled.id);
    expect(cancelReceipt).toMatchObject({
      sandbox_id: exitSandbox.id,
      exit_kind: "cancelled",
      job_handle_digest: digest({
        provider: cancelJob.provider,
        jobId: cancelJob.jobId,
      }),
    });
    expect(
      env.database
        .prepare("SELECT cancel_requested_at FROM agent_tasks WHERE id=?")
        .get(cancelled.id).cancel_requested_at,
    ).toBeTruthy();
    await advanceMigration(migration);
    const classification = await env.harness.coordinator.continuity(
      accepted.attemptId,
      { fence: migration.lease.fence },
    );
    expect(classification.qualified).toBe(true);
    expect(classification.reasons).not.toContain(
      "NATURAL_JOB_EXIT_NEEDS_OWNER_RECEIPT",
    );
    await env.harness.restartController();
    await env.until((s) => s.attempt?.state === "activation-confirmed");
    await expect
      .poll(
        () =>
          env.database
            .prepare(
              "SELECT count(*) n FROM automation_cron_occurrences WHERE automation_id=?",
            )
            .get(automation.id).n,
        { timeout: 180000 },
      )
      .toBeGreaterThan(0);
    const occurrences = env.database
      .prepare(
        "SELECT run_id FROM automation_cron_occurrences WHERE automation_id=?",
      )
      .all(automation.id);
    env.owned.push(
      ...env.database
        .prepare("SELECT id FROM sandboxes WHERE source_automation_id=?")
        .all(automation.id)
        .map((row) => row.id),
    );
    for (const occurrence of occurrences) {
      const intent = env.database
        .prepare(
          "SELECT * FROM automation_launch_intents WHERE run_id=? AND retry_count=0",
        )
        .get(occurrence.run_id);
      expect(intent).toBeTruthy();
      expect(
        env.database
          .prepare("SELECT count(*) n FROM agent_tasks WHERE id=?")
          .get(intent.task_id).n,
      ).toBe(1);
    }
    await responseJson(
      env.request,
      env.origin,
      `/api/automations/${automation.id}`,
      "DELETE",
      {},
      204,
    );
    return {
      attemptId: accepted.attemptId,
      operationDigest: digest(operationId),
      occurrences: occurrences.map((row) => ({ runId: row.run_id })),
      naturalExit: {
        taskId: natural.id,
        sandboxId: exitSandbox.id,
        modelProofId: exitProofId,
        receipt: completion,
        migrationPhaseAtExit,
        modelFinalResponse: released,
        actualCliStatus: naturalResult.status,
        modelQualityQualified: false,
      },
      userCancel: {
        taskId: cancelled.id,
        sameSandboxId: exitSandbox.id,
        receipt: cancelReceipt,
      },
      exitClassification: classification,
    };
  }));

test("continuous original Guest and normal 10Hz business traffic remain valid under real online conversion [N03]", async ({
  page,
  context,
}, info) =>
  recordCase("N03", page, context, info, async (env) => {
    invariant(
      env.fixture.envelope.manifest.upgradePaths.some(
        (path) => path.migrationPlanDigest,
      ),
      "REAL_NATIVE_ONLINE_MIGRATION_INPUT_REQUIRED",
    );
    const measured = probe(env),
      accepted = await env.accept();
    let result;
    try {
      await env.until((s) => s.attempt?.state === "activation-confirmed");
      result = await measured.stop();
    } catch (error) {
      await measured.stop();
      throw error;
    }
    expect(result.ticks / result.seconds).toBeGreaterThanOrEqual(10);
    expect(
      result.samples
        .filter((row) => row.kind !== "dedup")
        .every(
          (row) =>
            row.status >= 200 && row.status < 300 && row.latencyMs <= 2000,
        ),
    ).toBe(true);
    expect(
      result.samples
        .filter((row) => row.kind === "dedup")
        .every((row) => row.status === 200 && row.sameId),
    ).toBe(true);
    const migration = env.database
      .prepare("SELECT * FROM upgrade_online_migrations WHERE attempt_id=?")
      .get(accepted.attemptId);
    expect(migration?.stage).toBe("complete");
    expect(migration?.degraded).toBe(0);
    expect(await env.resumeTerminal()).toBeLessThanOrEqual(5000);
    return {
      attemptId: accepted.attemptId,
      migrationCheckpoint: JSON.parse(migration.checkpoint),
      normalTraffic: result,
    };
  }));

for (const combination of ["WebA-APIA", "WebA-APIB", "WebB-APIB", "WebB-APIA"])
  test(
    "actual native supported version tuple " + combination,
    async ({ page, context }, info) =>
      recordCase(combination, page, context, info, async (env) => {
        const accepted = await env.accept();
        await env.until((s) => s.attempt?.state === "activation-confirmed");
        await env.stopController();
        const before = await env.binding(),
          snapshot = await env.harness.coordinator.snapshot(accepted.attemptId);
        const api = combination.endsWith("APIA")
          ? before.oldApi
          : before.candidateApi;
        const web = combination.startsWith("WebA")
          ? [before.web, ...before.retainedWeb].find(
              (row) =>
                row.digest ===
                env.initial.confirmedServiceRelease.components.web
                  .artifactDigest,
            )
          : before.web;
        invariant(api && web, "ACTUAL_FOUR_COMBINATION_ARTIFACTS_REQUIRED");
        const actualIdentity = await fetch(
          api.origin + "/internal/control/identity",
          {
            headers: {
              "x-platform-internal-key": env.config.keys.control,
              "x-platform-instance-id": env.config.instanceId,
            },
          },
        );
        expect(actualIdentity.status).toBe(200);
        expect((await actualIdentity.json()).artifactDigest).toBe(api.digest);
        const next = {
          ...before,
          attemptId: accepted.attemptId,
          fence: snapshot.fence,
          routeGeneration: before.routeGeneration + 1,
          oldApi: api,
          candidateApi: null,
          weight: 0,
          web,
          retainedWeb: [before.web, ...before.retainedWeb].filter(
            (item, i, rows) =>
              rows.findIndex((row) => row.digest === item.digest) === i,
          ),
        };
        const response = await fetch(
          env.harness.entry.controlOrigin + "/binding",
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-platform-internal-key": env.config.keys.entry,
            },
            body: canonical(next),
          },
        );
        expect(response.status).toBe(200);
        const build = await responseJson(env.request, env.origin, "/web-build");
        expect(build.webRevision).toBe(
          combination.startsWith("WebA")
            ? env.initial.confirmedServiceRelease.components.web.webRevision
            : env.fixture.envelope.manifest.components.web.webRevision,
        );
        const attachMs = await env.resumeTerminal();
        const marker = await responseJson(
          env.request,
          env.origin,
          "/api/projects",
          "POST",
          { name: "actual " + combination + " write", sourceType: "empty" },
          202,
        );
        expect(
          (
            await responseJson(
              env.request,
              env.origin,
              "/api/projects/" + marker.id,
            )
          ).id,
        ).toBe(marker.id);
        const mcp = await actualMcp(env, marker.id);
        return {
          attemptId: accepted.attemptId,
          apiDigest: api.digest,
          webRevision: build.webRevision,
          actualBinding: await env.binding(),
          attachMs,
          mcp,
        };
      }),
  );

test("real original v0.3.8 mono busy migration defers and preserves its original container/resources [N02]", async ({
  page,
  context,
}, info) => {
  const assertions = [];
  let actual = { stage: "legacy-input-preflight" };
  try {
    const input = await sourceFor("N02");
    invariant(
      input.legacyRoot && input.legacyImage && input.legacyInstallation,
      "REAL_V038_MONO_INSTALLATION_REQUIRED",
    );
    const artifact = await readJson(
      join(input.legacyRoot, "legacy-artifact.json"),
    );
    expect(artifact.commits.api).toBe(
      "7688294cefbecd261f9e82d6579dfe63e39c701b",
    );
    expect(artifact.commits.web).toBe(
      "c6b848ecaca755fbd8543656d4f0165984189cbb",
    );
    invariant(
      !(await fs
        .lstat(
          join(input.legacyRoot, "api/apps/api/dist/roles/control-api-main.js"),
        )
        .catch(() => null)),
      "NEW_ROLE_CANNOT_IMPERSONATE_LEGACY",
    );
    const path = resolve(
      import.meta.dirname,
      "../../deploy/upgrade/legacy-preflight.mjs",
    );
    invariant(
      (await fs.lstat(path).catch(() => null))?.isFile(),
      "REAL_READONLY_LEGACY_PREFLIGHT_ENTRY_REQUIRED",
    );
    const { preflightLegacyInstallation } = await import(path);
    invariant(
      typeof preflightLegacyInstallation === "function",
      "REAL_READONLY_LEGACY_PREFLIGHT_ENTRY_REQUIRED",
    );
    actual = await preflightLegacyInstallation({
      ...input.legacyInstallation,
      root: input.legacyRoot,
      image: input.legacyImage,
      instanceId: input.legacyInstallation.instanceId ?? input.instanceId,
      request: { ...input.legacyInstallation.request, requestId: randomUUID() },
    });
    expect(actual.busy).toBe(true);
    expect(actual.decision).toBe("deferred");
    expect(actual.originalContainerPreserved).toBe(true);
    expect(actual.accepted).toBe(false);
    expect(actual.reason).toBe("LEGACY_INSTANCE_BUSY");
    expect(actual.evidence.containerBefore).toEqual(
      actual.evidence.containerAfter,
    );
    expect(actual.evidence.artifactTreeDigest).toBe(artifact.treeDigest);
    expect(actual.originalResources.length).toBeGreaterThan(0);
    expect(actual.sdkHomesOpened).toBe(0);
    expect(actual.lifecycleActions).toEqual([]);
    expect(actual.evidence.newSdkModulesImported).toEqual([]);
    expect(
      actual.evidence.operations.every(
        (operation) =>
          operation.command === "inspect" ||
          operation.path === "/api/deployment/status" ||
          (operation.method === "POST" &&
            /^\/api\/sandboxes\/[^/]+\/exec$/.test(operation.path) &&
            operation.commandDigest === actual.evidence.guestCommandDigest),
      ),
    ).toBe(true);
    expect(actual.retainedStoppedResources.length).toBeGreaterThan(0);
    expect(
      actual.retainedStoppedResources.every(
        (resource) =>
          resource.status === "stopped" &&
          resource.box.status === "stopped" &&
          resource.box.pid === null &&
          resource.provider_handle === resource.box.id,
      ),
    ).toBe(true);
    expect(
      actual.originalResources.every(
        (row) =>
          row.containerId &&
          row.runtimeIdentity &&
          row.shimPid > 0 &&
          row.pid &&
          row.startTime &&
          row.counter.contiguous &&
          row.counter.after > row.counter.before,
      ),
    ).toBe(true);
    assertions.push({
      id: "N02",
      result: "passed",
      description:
        "Original deployed mono evidence and real read-only busy deferral",
      expectLocation: location,
      actualEvidence: actual,
    });
  } catch (error) {
    assertions.push({
      id: "N02",
      result: "failed",
      description:
        "Legacy physical prerequisites or assertions were not satisfied",
      expectLocation: location,
      actualEvidence: {
        ...actual,
        reason: error.code ?? "LEGACY_NATIVE_ASSERTION_FAILED",
      },
    });
    throw error;
  } finally {
    const path = info.outputPath("upg-assertions.json");
    await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await fs.writeFile(path, JSON.stringify({ assertions }, null, 2) + "\n", {
      mode: 0o600,
    });
    await info.attach("UPG assertions", {
      path,
      contentType: "application/json",
    });
  }
});
