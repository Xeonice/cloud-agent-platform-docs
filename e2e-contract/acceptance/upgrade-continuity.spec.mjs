import { test, expect } from "@playwright/test";
import { readFile, lstat, readdir, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { randomUUID, createHash } from "node:crypto";
import { createRequire } from "node:module";
import { startUpgradeHarness } from "../server/start-upgrade.mjs";
import { createUpgradeFixture } from "../server/upgrade-fixture.mjs";
import {
  startQualificationModel,
  qualificationPrompt,
  configureQualificationImage,
} from "../server/qualification-model.mjs";

const digest = (value) =>
  "sha256:" + createHash("sha256").update(JSON.stringify(value)).digest("hex");
async function configuration() {
  const path = process.env.UPGRADE_ACCEPTANCE_CONFIG;
  if (!path)
    throw new Error(
      "UPGRADE_ACCEPTANCE_CONFIG_REQUIRED: supply frozen real A/B installation inputs",
    );
  const stat = await lstat(path);
  expect(
    stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0,
  ).toBe(true);
  const config = JSON.parse(await readFile(path, "utf8"));
  expect(config.isolated).toBe(true);
  expect(config.root).toBe(resolve(config.root));
  return config;
}
async function json(
  request,
  origin,
  path,
  method = "GET",
  data,
  expected = 200,
) {
  const response = await request.fetch(origin + path, {
    method,
    data,
    headers: { Origin: origin, "X-Operation-Id": randomUUID() },
    timeout: 120000,
  });
  expect(response.status(), `${method} ${path}`).toBe(expected);
  return response.status() === 204 ? undefined : response.json();
}
async function files(path) {
  return readdir(path).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
}
function transportEvidence(page) {
  const ready = [],
    traffic = [],
    mutations = [],
    output = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith("/api/")) return;
    traffic.push({
      path: url.pathname,
      method: request.method(),
      at: performance.now(),
    });
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method()))
      mutations.push(traffic.at(-1));
  });
  page.on("websocket", (socket) => {
    socket.on("framereceived", (event) => {
      const text = String(event.payload),
        prefix = "42/terminal,";
      if (!text.startsWith(prefix)) return;
      const decoded = JSON.parse(text.slice(prefix.length));
      if (decoded[0] !== "frame") return;
      const frame = decoded[1];
      if (frame.type === "data") {
        output.push(String(frame.data));
        if (output.length > 2000) output.splice(0, 1000);
      }
      if (frame.type === "ready")
        ready.push({
          sandboxId: frame.sandboxId,
          terminalIdentity: frame.terminalIdentity,
          runtimeIdentity: frame.runtimeIdentity,
          existingSession: frame.existingSession,
          at: performance.now(),
        });
      // No cookie, socketSessionKey, private shellId, input or output is persisted.
    });
  });
  return { ready, traffic, mutations, output };
}
async function shell(page, name) {
  const button = page.getByTestId("terminal-tab-new");
  await expect(button).toBeVisible();
  const hasMenu = (await button.getAttribute("aria-haspopup")) === "menu";
  await button.click();
  if (hasMenu) {
    const menu = page.getByTestId("terminal-launch-shell");
    await expect(menu).toBeVisible();
    await menu.click();
  }
  await expect(page.getByRole("tab", { name, exact: true })).toBeVisible();
  await page.getByRole("tab", { name, exact: true }).click();
}
async function input(page, command) {
  const terminal = page.locator(".xterm-helper-textarea:visible");
  await expect(terminal).toHaveCount(1);
  await terminal.focus();
  await page.keyboard.insertText(command);
  await page.keyboard.press("Enter");
}
async function guestSnapshot(request, origin, sandboxId) {
  const result = await json(
    request,
    origin,
    `/api/sandboxes/${sandboxId}/exec`,
    "POST",
    {
      command:
        "printf 'PID '; cat /workspace/.upg-proof/pid; printf 'BIRTH '; cat /workspace/.upg-proof/birth; printf 'SEQ\\n'; cat /workspace/.upg-proof/counter; printf 'TMUX\\n'; tmux list-sessions -F '#{session_id}:#{session_created}:#{session_name}'",
    },
  );
  expect(result.exitCode).toBe(0);
  const output = result.stdout;
  const match = /^PID (\d+)\s+BIRTH (\d+)\s+SEQ\n([\d\n]+)TMUX\n([\s\S]*)/.exec(
    output,
  );
  expect(
    match,
    "actual guest PID/birth, sequence file and tmux inventory",
  ).not.toBeNull();
  return {
    pid: Number(match[1]),
    birth: match[2],
    seq: match[3].trim().split("\n").map(Number),
    tmuxDigest: digest(match[4].trim().split("\n").sort()),
  };
}

async function agentCounter(request, origin, sandboxId, marker) {
  const folder = "/workspace/.upg-agent-proof/" + marker;
  const result = await json(
    request,
    origin,
    `/api/sandboxes/${sandboxId}/exec`,
    "POST",
    {
      command: `printf 'PID '; cat ${folder}/pid; printf 'BIRTH '; cat ${folder}/birth; printf 'LAUNCHES\\n'; cat ${folder}/launches; printf 'SEQ\\n'; cat ${folder}/counter`,
    },
  );
  expect(result.exitCode).toBe(0);
  const match =
    /^PID (\d+)\s+BIRTH (\d+)\s+LAUNCHES\n([\d\n]+)SEQ\n([\d\n]+)$/.exec(
      result.stdout,
    );
  expect(match, "Actual Agent CLI Bash task counter").not.toBeNull();
  return {
    pid: Number(match[1]),
    birth: match[2],
    launches: match[3].trim().split("\n").map(Number),
    seq: match[4].trim().split("\n").map(Number),
  };
}
function sampling(request, origin, automationId) {
  const samples = [],
    ids = new Set(),
    pending = new Set();
  let running = true,
    sequence = 0;
  const started = performance.now();
  const launch = () => {
    if (!running) return;
    const operationId = randomUUID(),
      tick = ++sequence;
    const path = origin + "/api/automations/" + automationId,
      update = { name: `UPG probe ${tick}` };
    ids.add(operationId);
    const work = (async () => {
      for (const kind of ["read", "write"]) {
        const begin = performance.now();
        try {
          const response = await request.fetch(path, {
            method: kind === "read" ? "GET" : "PUT",
            ...(kind === "write"
              ? {
                  data: update,
                }
              : {}),
            headers: { Origin: origin, "X-Operation-Id": operationId },
            timeout: 2000,
          });
          const body = await response.json();
          samples.push({
            kind,
            status: response.status(),
            latencyMs: performance.now() - begin,
            tick,
            operationDigest: digest(operationId),
            resultId: kind === "write" ? body.id : undefined,
            correctWrite:
              kind === "write"
                ? body.id === automationId && body.name === update.name
                : undefined,
          });
          if (kind === "write" && response.status() === 200) {
            const dedupStart = performance.now();
            const duplicate = await request.put(path, {
              data: update,
              headers: { Origin: origin, "X-Operation-Id": operationId },
              timeout: 2000,
            });
            const original = await duplicate.json();
            samples.push({
              kind: "dedup",
              status: duplicate.status(),
              latencyMs: performance.now() - dedupStart,
              tick,
              sameId: original.id === body.id,
              sameResult: digest(original) === digest(body),
            });
          }
        } catch {
          samples.push({
            kind,
            status: 0,
            latencyMs: performance.now() - begin,
            tick,
          });
        }
      }
    })().finally(() => pending.delete(work));
    pending.add(work);
  };
  launch();
  const timer = setInterval(launch, 100);
  return {
    samples,
    async stop() {
      running = false;
      clearInterval(timer);
      const seconds = (performance.now() - started) / 1000,
        drainStart = performance.now();
      await Promise.all(pending);
      return {
        samples,
        seconds,
        drainMs: performance.now() - drainStart,
        operations: ids.size,
      };
    },
  };
}

test("real user acceptance, durable installation and original VM/terminal continuity [I01] [I02] [N01]", async ({
  page,
  context,
}, info) => {
  const assertions = [],
    evidence = transportEvidence(page);
  let fixture,
    harness,
    probe,
    probeResult,
    model,
    modelImage,
    database,
    resourcesCleaned = false;
  const owned = [];
  const check = async (id, description, verify, actual) => {
    try {
      await verify();
      assertions.push({
        id,
        result: "passed",
        description,
        expectLocation: "acceptance/upgrade-continuity.spec.mjs",
        actualEvidence: actual,
      });
    } catch (error) {
      assertions.push({
        id,
        result: "failed",
        description,
        expectLocation: "acceptance/upgrade-continuity.spec.mjs",
        actualEvidence: actual,
      });
      throw error;
    }
  };
  try {
    const source = await configuration();
    if (source.modelMode === "local-protocol-test") {
      model = await startQualificationModel({
        isolated: source.isolated,
        instanceId: source.instanceId,
        host: source.localModel?.bindHost ?? "127.0.0.1",
        guestHost: source.localModel?.guestHost ?? "host.boxlite.internal",
      });
      source.runtimeId = model.runtimeId;
      source.runtimeCredential = model.runtimeCredential;
      source.headlessPrompt = qualificationPrompt(randomUUID());
      source.automationInput = {
        name: "UPG actual due automation",
        timeoutMinutes: 30,
        artifactRetentionDays: 7,
        triggerOn: "all",
        ...source.automationInput,
        runtime: model.runtimeId,
        prompt: qualificationPrompt(randomUUID()),
      };
    }
    const runtimeId = source.runtimeId ?? "codex";
    fixture = await createUpgradeFixture(source);
    harness = await startUpgradeHarness(fixture.config);
    // Load the native SQLite binding from the actual installed API closure. This
    // observer connection cannot write or construct another runtime SDK.
    const Database = createRequire(
      join(fixture.config.initialRoot, "api/package.json"),
    )("better-sqlite3");
    database = new Database(join(harness.root, "business/platform.sqlite"), {
      readonly: true,
      fileMustExist: true,
    });
    database.pragma("query_only=ON");
    database.pragma("busy_timeout=2000");
    void harness.runController();
    const origin = harness.entryOrigin,
      request = context.request;
    await page.goto(origin);
    // A fresh browser and the actual fixture's enabled passcode always require
    // this user flow. An immediate isVisible() before hydration can skip it while
    // AppBootGate is still checking init-status, leaving every later API at 401.
    if (fixture.config.authEnv.ACCESS_PASSCODE) {
      const gate = page.getByRole("dialog", { name: "访问口令", exact: true });
      await expect(gate).toBeVisible({ timeout: 30000 });
      await page
        .getByLabel("访问口令", { exact: true })
        .fill(fixture.config.authEnv.ACCESS_PASSCODE);
      const unlocked = page.waitForResponse(
        (response) =>
          new URL(response.url()).origin === origin &&
          new URL(response.url()).pathname === "/api/access/unlock" &&
          response.request().method() === "POST",
      );
      await page.getByRole("button", { name: "解锁", exact: true }).click();
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
    const initStatus = await json(request, origin, "/api/system/init-status");
    if (!initStatus.initialized) {
      await json(
        request,
        origin,
        "/api/system/init",
        "POST",
        { acknowledgeOffline: true },
        201,
      );
      await page.reload();
    }
    const initial = await json(request, origin, "/api/system/upgrade/status");
    await expect(page.getByTestId("upgrade-notice")).toBeVisible();
    await expect(
      page.getByRole("progressbar", { name: "本实例升级进度" }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "今天不再提醒", exact: true })
      .click();
    await page.reload();
    await expect(page.getByTestId("upgrade-notice")).toHaveCount(0);
    const beforeDownload = (await fixture.requestLog()).filter((item) =>
      /\.tgz$/.test(item.path),
    );
    await check(
      "I01",
      "Opening/checking/reloading/snoozing never accepts or downloads an installation",
      async () => {
        expect(initial.attempt).toBeNull();
        expect(initial.catalog.availableRelease).not.toBeNull();
        expect(initial.confirmedServiceRelease.releaseId).toBe(
          fixture.config.initialRelease.releaseId,
        );
        expect(beforeDownload).toHaveLength(0);
        expect(
          await files(join(harness.root, "installer", "journals")),
        ).toHaveLength(0);
        expect(
          evidence.mutations.filter(
            (item) => item.path === "/api/system/upgrade/requests",
          ),
        ).toHaveLength(0);
      },
      {
        initialRelease: initial.confirmedServiceRelease?.releaseId,
        target: initial.catalog.availableRelease?.releaseId,
        attempts: initial.attempt,
        downloads: beforeDownload.length,
      },
    );
    if (model)
      modelImage = await configureQualificationImage(request, origin, model);
    expect(
      source.runtimeCredential,
      "A dedicated external credential or explicit local protocol mode is required for the actual guest CLI",
    ).toBeDefined();
    await json(
      request,
      origin,
      `/api/runtimes/${runtimeId}/credentials/secret`,
      "POST",
      source.runtimeCredential,
    );
    // Create the original project and interactive agent using the actual UI.
    await page.goto(origin);
    await page
      .getByRole("button", { name: "开一个空项目", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByLabel("项目名称")
      .fill("UPG original continuity project");
    const projectResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/projects" &&
        response.request().method() === "POST",
    );
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "创建项目", exact: true })
      .click();
    const project = await (await projectResponse).json();
    await page.getByRole("button", { name: "新任务", exact: true }).click();
    await page
      .getByTestId("modal-new-task")
      .getByRole("radio", {
        name: runtimeId === "claude-code" ? /Claude Code/ : /Codex/,
      })
      .check();
    const launchResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/sandboxes" &&
        response.request().method() === "POST",
    );
    await page.getByTestId("launch-task-submit").click();
    const original = await (await launchResponse).json();
    owned.push(original.id);
    await expect
      .poll(
        async () =>
          (await json(request, origin, `/api/sandboxes/${original.id}`)).status,
        { timeout: 180000 },
      )
      .toBe("running");
    await expect
      .poll(
        () =>
          evidence.ready.some(
            (row) =>
              row.sandboxId === original.id && row.runtimeIdentity !== null,
          ),
        { timeout: 180000 },
      )
      .toBe(true);
    await shell(page, "终端 1");
    await input(
      page,
      "mkdir -p /workspace/.upg-proof; printf '%s\\n' $$ > /workspace/.upg-proof/pid; awk '{print $22}' /proc/$$/stat > /workspace/.upg-proof/birth; i=0; while :; do i=$((i+1)); printf '%s\\n' $i >> /workspace/.upg-proof/counter; sleep 1; done",
    );
    await shell(page, "终端 2");
    await expect
      .poll(
        () =>
          evidence.ready.filter(
            (row) =>
              row.sandboxId === original.id && row.runtimeIdentity !== null,
          ).length,
        { timeout: 30000 },
      )
      .toBeGreaterThanOrEqual(3);
    const snapshotA = await guestSnapshot(request, origin, original.id);
    const secondTerminal = evidence.ready.at(-1);
    expect(secondTerminal.terminalIdentity).toMatch(/^[a-f0-9-]{36}$/);
    const headless = await json(
      request,
      origin,
      "/api/sandboxes",
      "POST",
      {
        projectId: project.id,
        runtime: runtimeId,
        headless: true,
        timeoutMinutes: 30,
      },
      201,
    );
    owned.push(headless.id);
    await expect
      .poll(
        async () =>
          (await json(request, origin, `/api/sandboxes/${headless.id}`)).status,
        { timeout: 180000 },
      )
      .toBe("running");
    expect(
      source.headlessPrompt,
      "Real long-running guest AgentTask instruction is required",
    ).toBeTruthy();
    const run = await json(
      request,
      origin,
      `/api/sandboxes/${headless.id}/runtimes/${runtimeId}/tasks`,
      "POST",
      { prompt: source.headlessPrompt, timeoutMinutes: 30 },
      202,
    );
    expect(run.status).toBe("running");
    const readOriginalIdentities = () => {
      const task = database
        .prepare("SELECT sandbox_id,job_handle FROM agent_tasks WHERE id=?")
        .get(run.id);
      const sandboxes = [original.id, headless.id].map((id) => {
        const row = database
          .prepare(
            "SELECT provider,provider_handle,provider_state FROM sandboxes WHERE id=?",
          )
          .get(id);
        expect(
          Boolean(row?.provider_handle),
          "Original durable sandbox handle exists",
        ).toBe(true);
        return { id, ...row };
      });
      expect(
        task?.sandbox_id,
        "Original task belongs to the original Guest",
      ).toBe(headless.id);
      expect(
        Boolean(task?.job_handle),
        "Original durable job handle exists",
      ).toBe(true);
      return { task, sandboxes };
    };
    const persistedBefore = readOriginalIdentities();
    let agentA;
    const agentMarker = model
      ? /UPG_PROTOCOL_TASK:([a-f0-9-]{36})/.exec(source.headlessPrompt)[1]
      : null;
    const cli = await json(
      request,
      origin,
      `/api/sandboxes/${headless.id}/exec`,
      "POST",
      {
        command:
          runtimeId === "claude-code" ? "claude --version" : "codex --version",
      },
    );
    expect(cli.exitCode).toBe(0);
    expect(cli.stdout.trim()).toMatch(/\d+\.\d+\.\d+/);
    if (model) {
      await expect
        .poll(
          async () => {
            try {
              agentA = await agentCounter(
                request,
                origin,
                headless.id,
                agentMarker,
              );
              return agentA.seq.length;
            } catch {
              return 0;
            }
          },
          { timeout: 180000 },
        )
        .toBeGreaterThanOrEqual(2);
      expect(agentA.launches).toHaveLength(1);
      expect(
        model
          .evidence()
          .requests.some(
            (row) => row.taskId === agentMarker && row.phase === "tool-issued",
          ),
      ).toBe(true);
    }
    // Schedule a real occurrence across the measured upgrade window.
    expect(
      source.automationInput,
      "The native load includes an actual due automation",
    ).toBeDefined();
    if (model) {
      source.automationInput.scheduleKind = "hourly";
      source.automationInput.scheduleConfig = {
        minute: (new Date().getUTCMinutes() + 2) % 60,
      };
      source.automationInput.timezone = "UTC";
    }
    const automation = await json(
      request,
      origin,
      `/api/projects/${project.id}/automations`,
      "POST",
      source.automationInput,
      201,
    );
    const upgradeAuthPage = await context.newPage();
    await upgradeAuthPage.goto(origin + "/settings/system#version");
    await upgradeAuthPage
      .getByRole("button", { name: "授权升级", exact: true })
      .click();
    await upgradeAuthPage
      .getByLabel("实例升级授权密钥")
      .fill(fixture.config.keys.upgrade);
    await upgradeAuthPage
      .getByRole("dialog")
      .getByRole("button", { name: "授权升级", exact: true })
      .click();
    await expect(upgradeAuthPage.getByRole("dialog")).toHaveCount(0);
    const authorized = await json(
      request,
      origin,
      "/api/system/upgrade/status",
    );
    expect(authorized.capabilities.canUpgradeInstance).toBe(true);
    expect(authorized.attempt).toBeNull();
    await upgradeAuthPage.close();
    await page.reload();
    await expect(
      page.getByRole("tab", { name: "终端 2", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    const trafficRule = await json(
      request,
      origin,
      `/api/projects/${project.id}/automations`,
      "POST",
      {
        ...source.automationInput,
        name: "UPG disabled business traffic fixture",
        scheduleKind: "hourly",
        scheduleConfig: { minute: (new Date().getUTCMinutes() + 30) % 60 },
      },
      201,
    );
    const disabledRule = await json(
      request,
      origin,
      `/api/automations/${trafficRule.id}/disable`,
      "POST",
      {},
      200,
    );
    expect(disabledRule.enabled).toBe(false);
    const mutationStart = evidence.mutations.length;
    probe = sampling(request, origin, trafficRule.id);
    const acceptedResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/system/upgrade/requests" &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "版本与更新", exact: true }).click();
    await page
      .getByRole("dialog", { name: "版本与更新详情" })
      .getByRole("button", { name: "立即升级", exact: true })
      .click();
    const accepted = await (await acceptedResponse).json();
    expect(accepted.state).toBe("accepted");
    expect(accepted.percent).toBeLessThan(100);
    const frozenTarget = accepted.targetDigest;
    await expect
      .poll(
        async () =>
          (await json(request, origin, "/api/system/upgrade/status")).attempt
            ?.state,
        { timeout: 900000, intervals: [500, 1000] },
      )
      .toBe("activation-confirmed");
    const installed = await json(request, origin, "/api/system/upgrade/status");
    expect(installed.attempt.attemptId).toBe(accepted.attemptId);
    expect(installed.attempt.targetDigest).toBe(frozenTarget);
    expect(installed.attempt.percent).toBe(100);
    expect(installed.confirmedServiceRelease.releaseId).toBe(
      fixture.envelope.manifest.releaseId,
    );
    expect(installed.activationGeneration).toBeGreaterThan(
      initial.activationGeneration,
    );
    const beforeRefresh = evidence.ready.length,
      refreshStart = performance.now();
    const refreshButton = page.getByRole("button", {
      name: "刷新页面",
      exact: true,
    });
    if (
      installed.availableWeb.webRevision !==
      fixture.config.initialRelease.components.web.webRevision
    ) {
      await expect(refreshButton).toBeVisible();
      await refreshButton.click();
    } else {
      await expect(refreshButton).toHaveCount(0);
      await page.reload();
    }
    await expect(
      page.getByRole("tab", { name: "终端 2", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await expect
      .poll(
        () =>
          evidence.ready
            .slice(beforeRefresh)
            .some(
              (row) =>
                row.terminalIdentity === secondTerminal.terminalIdentity &&
                row.runtimeIdentity === secondTerminal.runtimeIdentity &&
                row.existingSession,
            ),
        { timeout: 5000, intervals: [25, 50, 100] },
      )
      .toBe(true);
    const attachMs = performance.now() - refreshStart;
    const marker = "UPG_INPUT_" + randomUUID().replaceAll("-", "");
    await input(
      page,
      `printf '%s%s\\n' '${marker.slice(0, 20)}' '${marker.slice(20)}'`,
    );
    await expect
      .poll(() => evidence.output.join("").includes(marker), {
        timeout: 5000,
        intervals: [25, 50, 100],
      })
      .toBe(true);
    const snapshotB = await guestSnapshot(request, origin, original.id);
    const originalAfter = await json(
      request,
      origin,
      `/api/sandboxes/${original.id}`,
    );
    const runAfter = await json(
      request,
      origin,
      `/api/sandboxes/${headless.id}/tasks/${run.id}`,
    );
    const persistedAfter = readOriginalIdentities();
    await expect
      .poll(
        async () =>
          (
            await json(
              request,
              origin,
              `/api/automations/${automation.id}/runs`,
            )
          ).items.filter((row) => row.status === "running").length,
        { timeout: 180000 },
      )
      .toBe(1);
    const automationAfter = await json(
      request,
      origin,
      `/api/automations/${automation.id}`,
    );
    const automationRuns = (
      await json(request, origin, `/api/automations/${automation.id}/runs`)
    ).items;
    expect(automationAfter.enabled).toBe(true);
    expect(automationRuns).toHaveLength(1);
    expect(automationRuns[0].sandboxId).toBeTruthy();
    const persistedRelease = JSON.parse(
        database
          .prepare(
            "SELECT confirmed_release FROM upgrade_instances WHERE instance_id=?",
          )
          .get(fixture.config.instanceId).confirmed_release,
      ),
      acceptedAtMs = Date.parse(accepted.acceptedAt),
      activatedAtMs = Date.parse(installed.confirmedServiceRelease.activatedAt),
      triggeredAtMs = Date.parse(automationRuns[0].triggeredAt);
    expect(persistedRelease.activatedAt).toBe(
      installed.confirmedServiceRelease.activatedAt,
    );
    expect(
      [acceptedAtMs, activatedAtMs, triggeredAtMs].every(Number.isFinite),
    ).toBe(true);
    owned.push(automationRuns[0].sandboxId);
    const agentB = model
      ? await agentCounter(request, origin, headless.id, agentMarker)
      : null;
    const automatedMarker = model
      ? /UPG_PROTOCOL_TASK:([a-f0-9-]{36})/.exec(
          source.automationInput.prompt,
        )[1]
      : null;
    let automatedCounter;
    if (model) {
      await expect
        .poll(
          async () => {
            try {
              automatedCounter = await agentCounter(
                request,
                origin,
                automationRuns[0].sandboxId,
                automatedMarker,
              );
              return automatedCounter.seq.length;
            } catch {
              return 0;
            }
          },
          { timeout: 180000 },
        )
        .toBeGreaterThanOrEqual(2);
      expect(automatedCounter.launches).toHaveLength(1);
    }
    probeResult = await probe.stop();
    probe = undefined;
    await check(
      "I02",
      "Actual accepted controller attempt reaches 100 and refresh attaches the same second terminal without replay",
      async () => {
        expect(originalAfter.id).toBe(original.id);
        expect(originalAfter.status).toBe("running");
        expect(snapshotB.pid).toBe(snapshotA.pid);
        expect(snapshotB.birth).toBe(snapshotA.birth);
        expect(snapshotB.tmuxDigest).toBe(snapshotA.tmuxDigest);
        expect(runAfter.id).toBe(run.id);
        expect(runAfter.status).toBe("running");
        expect(runAfter.lastSeq).toBeGreaterThanOrEqual(run.lastSeq ?? 0);
        // Compare private values only as booleans. Failed assertions and exported
        // attachments must never print raw job handles or provider state.
        expect(
          persistedAfter.task.job_handle === persistedBefore.task.job_handle,
          "Original job handle is byte-for-byte unchanged",
        ).toBe(true);
        expect(
          persistedAfter.sandboxes.every((row, i) => {
            const prior = persistedBefore.sandboxes[i];
            return (
              row.id === prior.id &&
              row.provider === prior.provider &&
              row.provider_handle === prior.provider_handle &&
              row.provider_state === prior.provider_state
            );
          }),
          "Original sandbox handles and private routing state are unchanged",
        ).toBe(true);
        expect(
          triggeredAtMs,
          "Automation triggers after the actual accepted upgrade",
        ).toBeGreaterThanOrEqual(acceptedAtMs);
        expect(
          triggeredAtMs,
          "Automation triggers before the actual instance activation is confirmed",
        ).toBeLessThanOrEqual(activatedAtMs);
        if (model) {
          expect(agentB.pid).toBe(agentA.pid);
          expect(agentB.birth).toBe(agentA.birth);
          expect(agentB.launches).toEqual(agentA.launches);
          expect(agentB.seq).toEqual(
            Array.from({ length: agentB.seq.length }, (_, i) => i + 1),
          );
          expect(agentB.seq.length).toBeGreaterThan(agentA.seq.length);
        }
        expect(attachMs).toBeLessThanOrEqual(5000);
        expect(
          evidence.mutations
            .slice(mutationStart)
            .filter((row) =>
              /\/sandboxes(?:$|\/.*\/(?:start|stop|runtimes\/.*\/tasks))/.test(
                row.path,
              ),
            ),
        ).toHaveLength(0);
        expect(snapshotB.seq).toEqual(
          Array.from({ length: snapshotB.seq.length }, (_, i) => i + 1),
        );
        expect(snapshotB.seq.length).toBeGreaterThan(snapshotA.seq.length);
      },
      {
        attemptId: accepted.attemptId,
        targetDigest: frozenTarget,
        activationGeneration: installed.activationGeneration,
        terminalIdentity: secondTerminal.terminalIdentity,
        attachMs,
        counter: snapshotB,
        headlessRunId: run.id,
        headlessJobHandleDigest: digest(persistedBefore.task.job_handle),
        originalSandboxIdentityDigests: persistedBefore.sandboxes.map(
          (row) => ({
            sandboxId: row.id,
            provider: row.provider,
            handleDigest: digest(row.provider_handle),
            privateRoutingStateDigest: digest(row.provider_state),
          }),
        ),
        serverUpgradeWindow: {
          acceptedAt: accepted.acceptedAt,
          activatedAt: installed.confirmedServiceRelease.activatedAt,
          automationTriggeredAt: automationRuns[0].triggeredAt,
        },
        headlessCounter: agentB,
        cliVersion: cli.stdout.trim(),
        modelMode: source.modelMode ?? "external-model",
        modelQualityQualified: false,
        modelImage,
        automationCounter: automatedCounter,
        automationRunId: automationRuns[0].id,
        automationId: automation.id,
      },
    );
    await check(
      "N01",
      "Native ARM64/KVM/BoxLite, separate role containers and 10Hz successful idempotent business traffic",
      async () => {
        expect(harness.native).toBe(true);
        expect(harness.isolation).toBe("containers");
        expect(
          probeResult.operations / probeResult.seconds,
        ).toBeGreaterThanOrEqual(9.5);
        expect(
          probeResult.samples
            .filter((row) => row.kind !== "dedup")
            .every(
              (row) =>
                row.status === 200 &&
                row.latencyMs <= 2000 &&
                (row.kind !== "write" || row.correctWrite),
            ),
        ).toBe(true);
        expect(
          probeResult.samples
            .filter((row) => row.kind === "dedup")
            .every(
              (row) =>
                row.status === 200 &&
                row.latencyMs <= 2000 &&
                row.sameId &&
                row.sameResult,
            ),
        ).toBe(true);
        expect(harness.roleContainers).toBeDefined();
        expect(
          new Set(
            Object.values(harness.roleContainers).map((row) => row.containerId),
          ).size,
        ).toBe(Object.keys(harness.roleContainers).length);
      },
      {
        native: harness.native,
        isolation: harness.isolation,
        roleContainers: harness.roleContainers,
        probeSummary: {
          seconds: probeResult.seconds,
          operations: probeResult.operations,
          failures: probeResult.samples.filter(
            (row) => row.status < 200 || row.status >= 300,
          ).length,
          maxLatencyMs: Math.max(
            ...probeResult.samples
              .filter((row) => row.kind !== "dedup")
              .map((row) => row.latencyMs),
          ),
        },
      },
    );
    // Explicit cleanup is outside the continuity window and independently audited.
    await json(
      request,
      origin,
      `/api/automations/${trafficRule.id}`,
      "DELETE",
      {},
      204,
    );
    await json(
      request,
      origin,
      `/api/automations/${automation.id}`,
      "DELETE",
      {},
      204,
    );
    await json(
      request,
      origin,
      `/api/sandboxes/${headless.id}/tasks/${run.id}/cancel`,
      "POST",
      {},
      202,
    );
    for (const id of owned)
      await json(
        request,
        origin,
        `/api/sandboxes/${id}`,
        "DELETE",
        { keepWorkspace: false },
        204,
      );
    resourcesCleaned = true;
  } finally {
    if (probe) probeResult = await probe.stop();
    database?.close();
    const output = info.outputPath("upg-assertions.json");
    await mkdir(resolve(output, ".."), { recursive: true, mode: 0o700 });
    await writeFile(
      output,
      JSON.stringify(
        {
          assertions,
          probes: probeResult,
          requests: evidence.traffic,
          cleanup: { resourcesCleaned },
          model: model?.evidence() ?? {
            modelMode: "external-model",
            modelQualityQualified: false,
          },
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );
    await info.attach("UPG assertions", {
      path: output,
      contentType: "application/json",
    });
    if (harness) await harness.close({ resourcesCleaned });
    if (fixture) await fixture.close();
    if (model) await model.close();
  }
});
