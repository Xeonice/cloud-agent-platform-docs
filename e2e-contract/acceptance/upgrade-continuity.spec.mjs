import { test, expect } from "@playwright/test";
import { readFile, lstat, readdir, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID, createHash } from "node:crypto";
import { createRequire } from "node:module";
import { digest as upgradeDigest } from "../../deploy/upgrade/trust.mjs";
import { startUpgradeHarness } from "../server/start-upgrade.mjs";
import { createUpgradeFixture } from "../server/upgrade-fixture.mjs";
import { closeQualifiedInstallation } from "../native/close-qualified-installation.mjs";
import { qualificationBusinessDatabasePath } from "../server/installer-filesystem.mjs";
import {
  upgradePrefersAsync,
  readN01Admission,
  assertN01Lookup,
  resolveN01TechnicalAttempt,
  assertN01Pending,
  assertN01DurableAdmission,
  n01ObservedProgress,
  n01UpgradeConfirmed,
} from "../server/upgrade-admission-contract.mjs";
import {
  startQualificationModel,
  qualificationPrompt,
  configureQualificationImage,
} from "../server/qualification-model.mjs";
import { n01WebContinuity } from "../server/upgrade-web-continuity-contract.mjs";

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
  headers = {},
) {
  const response = await request.fetch(origin + path, {
    method,
    data,
    headers: { Origin: origin, "X-Operation-Id": randomUUID(), ...headers },
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
  const timer = setInterval(launch, 90);
  return {
    samples,
    async stop() {
      running = false;
      clearInterval(timer);
      const schedulingSeconds = (performance.now() - started) / 1000,
        drainStart = performance.now();
      await Promise.all(pending);
      const seconds = (performance.now() - started) / 1000;
      return {
        samples,
        seconds,
        schedulingSeconds,
        observedRateHz: ids.size / seconds,
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
    admissionCdp,
    admissionRecovery,
    admissionDiagnostics = null,
    ongoingProgress,
    nativePhase = "setup",
    bodyErrorSummary = null,
    businessCleanup = null,
    completedWebUi = null,
    upgradeObservation = null,
    lastKnownProgress = null,
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
        qualificationInput: source.sameInstanceQa === undefined ? undefined : source,
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
    database = new Database(qualificationBusinessDatabasePath(fixture.config), {
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
      const passcode = gate.locator('input[name="passcode"]');
      await expect(passcode).toHaveCount(1);
      await passcode.fill(fixture.config.authEnv.ACCESS_PASSCODE);
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
    const initialApiObservation = await json(
      request,
      origin,
      "/api/system/upgrade/status",
    );
    await expect(page.getByTestId("upgrade-notice")).toBeVisible();
    // The first APIRequestContext read may race the browser's initial viewer
    // cookie. Use the real UI's completed refresh as the page identity authority.
    await page.getByRole("button", { name: "版本与更新", exact: true }).click();
    const initialDetails = page.getByRole("dialog", {
      name: "版本与更新详情",
      exact: true,
    });
    const browserInitialResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).origin === origin &&
        new URL(response.url()).pathname === "/api/system/upgrade/status" &&
        response.request().method() === "GET" &&
        response.status() === 200,
    );
    await initialDetails
      .getByRole("button", { name: "检查更新", exact: true })
      .click();
    const initial = await (await browserInitialResponse).json();
    await expect(
      initialDetails.getByRole("button", { name: "检查更新", exact: true }),
    ).toBeEnabled();
    expect(initial.instanceId).toBe(fixture.config.instanceId);
    expect(typeof initial.userScope).toBe("string");
    expect(initial.userScope.length).toBeGreaterThan(0);
    await page.keyboard.press("Escape");
    await expect(initialDetails).toHaveCount(0);
    await expect(page.getByTestId("upgrade-notice")).toBeVisible();
    await expect(
      page.getByRole("progressbar", { name: "本实例升级进度" }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "今天不再提醒", exact: true })
      .click();
    await page.reload();
    await expect(page.getByTestId("upgrade-notice")).toHaveCount(0);
    // Only this administrator's browser Date changes; the instance and its
    // scheduler retain real time. Crossing local midnight is not a 24h timeout.
    const reminderDays = await page.evaluate(() => {
      const now = new Date();
      const date = (value) =>
        `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
      const midnightBefore = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
        23,
        59,
        30,
      );
      const midnightAfter = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() + 1,
        0,
        1,
        0,
      );
      return {
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        firstDate: date(midnightBefore),
        nextDate: date(midnightAfter),
        before: midnightBefore.getTime(),
        after: midnightAfter.getTime(),
      };
    });
    const reminderKey = `ap.upgrade-reminder.v1:${encodeURIComponent(initial.instanceId)}:${encodeURIComponent(initial.userScope)}`;
    await page.clock.setFixedTime(reminderDays.before);
    await page.reload();
    await expect(
      page.getByRole("button", { name: "版本与更新", exact: true }),
    ).toBeVisible();
    await expect(page.getByTestId("upgrade-notice")).toHaveCount(0);
    expect(
      await page.evaluate((key) => localStorage.getItem(key), reminderKey),
    ).toBe(
      JSON.stringify({
        version: 1,
        dismissedLocalDate: reminderDays.firstDate,
      }),
    );
    const nextDayStatus = page.waitForResponse(
      (response) =>
        new URL(response.url()).origin === origin &&
        new URL(response.url()).pathname === "/api/system/upgrade/status" &&
        response.request().method() === "GET" &&
        response.status() === 200,
    );
    await page.clock.setFixedTime(reminderDays.after);
    await page.reload();
    const nextDayObserved = await (await nextDayStatus).json();
    await expect(page.getByTestId("upgrade-notice")).toBeVisible();
    expect(nextDayObserved.instanceId).toBe(initial.instanceId);
    expect(nextDayObserved.userScope).toBe(initial.userScope);
    expect(nextDayObserved.attempt).toBeNull();
    expect(nextDayObserved.confirmedServiceRelease.releaseId).toBe(
      initial.confirmedServiceRelease.releaseId,
    );
    await page
      .getByRole("button", { name: "今天不再提醒", exact: true })
      .click();
    await page.reload();
    await expect(
      page.getByRole("button", { name: "版本与更新", exact: true }),
    ).toBeVisible();
    await expect(page.getByTestId("upgrade-notice")).toHaveCount(0);
    expect(
      await page.evaluate((key) => localStorage.getItem(key), reminderKey),
    ).toBe(
      JSON.stringify({ version: 1, dismissedLocalDate: reminderDays.nextDate }),
    );
    const beforeDownload = (await fixture.requestLog()).filter((item) =>
      fixture.downloadObservationSource === 'actual-installer-download-files' || /\.tgz$/.test(item.path),
    );
    await check(
      "I01",
      fixture.downloadObservationSource === 'actual-installer-download-files'
        ? 'Opening/checking/reloading/snoozing never accepts or leaves an installer download'
        : 'Opening/checking/reloading/snoozing never accepts or downloads an installation',
      async () => {
        expect(initial.attempt).toBeNull();
        expect(nextDayObserved.attempt).toBeNull();
        expect(reminderDays.after - reminderDays.before).toBe(90000);
        expect(
          database
            .prepare(
              "SELECT count(*) n FROM upgrade_attempts WHERE instance_id=?",
            )
            .get(fixture.config.instanceId).n,
        ).toBe(0);
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
        downloadObservationSource: fixture.downloadObservationSource ?? 'actual-local-HTTPS-requests',
        reminder: {
          browserTimezone: reminderDays.timezone,
          sameInstanceAndAdministrator: true,
          identitySource:
            "actual loaded browser UI status after explicit readonly check",
          initialApiContextScopeMatchedBrowser:
            initialApiObservation.userScope === initial.userScope,
          productionPreferenceFormat:
            "version1 scoped JSON, exact complete value verified",
          firstLocalDate: reminderDays.firstDate,
          nextLocalDate: reminderDays.nextDate,
          naturalMidnightAdvanceMs: reminderDays.after - reminderDays.before,
          actualReloadStatus: 200,
          sameDayReloadSuppressed: true,
          nextDayReloadReminded: true,
          nextDayDismissalRetained: true,
          upgradePosts: 0,
        },
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
    const upgradeStatusPage = await context.newPage();
    await upgradeStatusPage.goto(origin + "/settings/system#version");
    await expect(
      upgradeStatusPage.getByRole("button", { name: "授权升级", exact: true }),
    ).toHaveCount(0);
    await expect(upgradeStatusPage.getByLabel("实例升级授权密钥")).toHaveCount(
      0,
    );
    const authorized = await json(
      request,
      origin,
      "/api/system/upgrade/status",
    );
    expect(authorized.capabilities.canUpgradeInstance).toBe(true);
    expect(authorized.capabilities.canAuthenticate).toBe(false);
    expect(authorized.attempt).toBeNull();
    // Read the build identity rendered by this actual browser, not a release ID
    // or a configured assumption about which Web was loaded. API-only upgrades
    // preserve this Web and intentionally remove the completed header popover.
    const loadedWebBuild = upgradeStatusPage
      .locator("#version dt")
      .filter({ hasText: /^实际 Web 构建$/ })
      .locator("..")
      .locator("dd");
    await expect(loadedWebBuild).toHaveText(
      initial.confirmedServiceRelease.components.web.webRevision,
    );
    expect(initial.confirmedServiceRelease.components.web).toMatchObject({
      artifactDigest: fixture.config.initialRelease.components.web.artifactDigest,
      webRevision: fixture.config.initialRelease.components.web.webRevision,
    });
    const webContinuity = n01WebContinuity({
      sourceWeb: initial.confirmedServiceRelease.components.web,
      targetWeb: fixture.envelope.manifest.components.web,
      loadedWebRevision: (await loadedWebBuild.textContent()).trim(),
    });
    await upgradeStatusPage.close();
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
    nativePhase = "upgrade-admission";
    const mutationStart = evidence.mutations.length;
    probe = sampling(request, origin, trafficRule.id);
    nativePhase = "upgrade-admission:cdp-session";
    admissionCdp = await context.newCDPSession(page);
    admissionDiagnostics = {
      browserPosts: 0,
      actualPostResponseStatus: null,
      actual202ResponseLost: false,
      readonlyLookupResponsesLost: 0,
      readonlyStatusResponsesLost: 0,
      pendingOriginalIdSeen: false,
      pendingOriginalIdRetainedAfterReload: false,
      pendingClearedAfterReadonlyConfirmation: false,
    };
    let blockAdmissionReads = false,
      interceptionError = null;
    const admissionPosts = [],
      readonlyResponsesLost = [],
      uiLookups = [],
      interceptionTasks = new Set();
    const observeAdmission = (request) => {
      const url = new URL(request.url());
      if (url.origin !== origin) return;
      if (
        url.pathname === "/api/system/upgrade/requests" &&
        request.method() === "POST"
      ) {
        blockAdmissionReads = true;
        admissionPosts.push(request.postDataJSON());
        admissionDiagnostics.browserPosts = admissionPosts.length;
      }
    };
    page.on("request", observeAdmission);
    let resolveAdmission, rejectAdmission;
    const actualAdmission = new Promise((resolve, reject) => {
      resolveAdmission = resolve;
      rejectAdmission = reject;
    });
    // The response-stage interceptor loses actual bytes only after real server
    // acceptance. It never fulfills an API request or manufactures a result.
    actualAdmission.catch(() => {});
    admissionCdp.on("Fetch.requestPaused", (event) => {
      const work = (async () => {
        const url = new URL(event.request.url);
        if (
          event.request.method === "POST" &&
          url.pathname === "/api/system/upgrade/requests"
        ) {
          // Gate the recovery reads before the actual 202 is lost; this cannot
          // depend on ordering of the separate Playwright request event.
          blockAdmissionReads = true;
          admissionDiagnostics.actualPostResponseStatus =
            event.responseStatusCode ?? null;
          nativePhase = "upgrade-admission:actual-202-body";
          expect(event.responseStatusCode).toBe(202);
          const bytes = await admissionCdp.send("Fetch.getResponseBody", {
            requestId: event.requestId,
          });
          const body = JSON.parse(
            bytes.base64Encoded
              ? Buffer.from(bytes.body, "base64").toString("utf8")
              : bytes.body,
          );
          const command = JSON.parse(event.request.postData);
          const admission = readN01Admission(body, {
            command,
            instanceId: fixture.config.instanceId,
            headers: event.request.headers,
            targetReleaseId: fixture.envelope.manifest.releaseId,
            targetDigest: fixture.envelope.manifestDigest,
            activationGeneration: initial.activationGeneration,
          });
          admissionDiagnostics.responseKind = admission.kind;
          admissionDiagnostics.preferAsync = admission.preferAsync;
          nativePhase = "upgrade-admission:lose-actual-202";
          await admissionCdp.send("Fetch.failRequest", {
            requestId: event.requestId,
            errorReason: "ConnectionClosed",
          });
          admissionDiagnostics.actual202ResponseLost = true;
          resolveAdmission({ submittedCommand: command, admission });
          return;
        }
        if (blockAdmissionReads && event.request.method === "GET") {
          const row = {
            path: url.pathname,
            status: event.responseStatusCode ?? null,
            preferAsync: upgradePrefersAsync(event.request.headers),
          };
          readonlyResponsesLost.push(row);
          if (url.pathname.startsWith("/api/system/upgrade/requests/")) {
            uiLookups.push(row);
            admissionDiagnostics.readonlyLookupResponsesLost++;
          } else admissionDiagnostics.readonlyStatusResponsesLost++;
          await admissionCdp.send("Fetch.failRequest", {
            requestId: event.requestId,
            errorReason: "ConnectionClosed",
          });
          return;
        }
        await admissionCdp.send(
          event.responseStatusCode
            ? "Fetch.continueResponse"
            : "Fetch.continueRequest",
          { requestId: event.requestId },
        );
      })()
        .catch((error) => {
          interceptionError = error;
          rejectAdmission(error);
        })
        .finally(() => interceptionTasks.delete(work));
      interceptionTasks.add(work);
    });
    nativePhase = "upgrade-admission:enable-response-loss";
    await admissionCdp.send("Fetch.enable", {
      patterns: [
        {
          urlPattern: origin + "/api/system/upgrade/requests",
          requestStage: "Response",
        },
        {
          urlPattern: origin + "/api/system/upgrade/requests/*",
          requestStage: "Response",
        },
        {
          urlPattern: origin + "/api/system/upgrade/status",
          requestStage: "Response",
        },
      ],
    });
    await page.getByRole("button", { name: "版本与更新", exact: true }).click();
    const admissionDetails = page.getByRole("dialog", {
      name: "版本与更新详情",
      exact: true,
    });
    nativePhase = "upgrade-admission:browser-readonly-check";
    const browserAdmissionResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).origin === origin &&
        new URL(response.url()).pathname === "/api/system/upgrade/status" &&
        response.request().method() === "GET" &&
        response.status() === 200,
    );
    await admissionDetails
      .getByRole("button", { name: "检查更新", exact: true })
      .click();
    const browserAdmissionSnapshot = await (
      await browserAdmissionResponse
    ).json();
    await expect(
      admissionDetails.getByRole("button", { name: "检查更新", exact: true }),
    ).toBeEnabled();
    expect(browserAdmissionSnapshot.instanceId).toBe(fixture.config.instanceId);
    expect(browserAdmissionSnapshot.userScope).toBe(initial.userScope);
    expect(browserAdmissionSnapshot.capabilities.canUpgradeInstance).toBe(true);
    nativePhase = "upgrade-admission:single-user-post";
    await admissionDetails
      .getByRole("button", { name: "立即升级", exact: true })
      .click();
    const { submittedCommand, admission } = await Promise.race([
      actualAdmission,
      delay(30000).then(() => {
        throw new Error("N01_REAL_ADMISSION_RESPONSE_MISSING");
      }),
    ]);
    // Async acceptance persists the user operation first. Its technical attempt
    // and derived request ID come from a real readonly status, never from an
    // attempt-shaped copy of the 202 body.
    nativePhase = "upgrade-admission:readonly-technical-stage-binding";
    let technicalAttempt = null;
    await expect
      .poll(async () => {
        const status = await json(request, origin, "/api/system/upgrade/status");
        technicalAttempt = resolveN01TechnicalAttempt(admission, status);
        return technicalAttempt !== null;
      }, { timeout: 120000, intervals: [250, 500, 1000] })
      .toBe(true);
    const intent = database.prepare(
      "SELECT attempt_id,actor_id,request_id,request_digest,target_release_id,target_digest,plan,accepted_at FROM upgrade_attempts WHERE instance_id=? AND attempt_id=?",
    ).get(fixture.config.instanceId, technicalAttempt.attemptId);
    const operationRow = admission.kind === "operation" ? database.prepare(
      `SELECT operation_id,actor_id,request_digest,created_at,
        json_extract(result,'$.command') command,
        json_extract(result,'$.operation') operation,
        json_array_length(result,'$.chain') chain_length,
        json_extract(result,'$.chain[0].requestId') technical_request_id,
        json_extract(result,'$.chain[0].envelope.manifestDigest') technical_target_digest,
        json_extract(result,'$.chain[0].envelope.manifest.releaseId') technical_target_release_id
       FROM platform_operations WHERE instance_id=? AND operation_id=? AND role='upgrade-plan'`,
    ).get(fixture.config.instanceId, admission.response.operationId) : null;
    const acceptedPlan = assertN01DurableAdmission(admission, technicalAttempt, intent, operationRow);
    const assertSingleIntent = () => {
      expect(database.prepare("SELECT count(*) n FROM upgrade_attempts WHERE instance_id=?")
        .get(fixture.config.instanceId).n).toBe(1);
      expect(database.prepare("SELECT count(*) n FROM platform_operations WHERE instance_id=? AND role='upgrade-plan'")
        .get(fixture.config.instanceId).n).toBe(admission.kind === "operation" ? 1 : 0);
    };
    assertSingleIntent();
    const pendingRequestKey = `ap.upgrade-request.v1:${encodeURIComponent(browserAdmissionSnapshot.instanceId)}:${encodeURIComponent(browserAdmissionSnapshot.userScope)}`;
    const readPending = () =>
      page.evaluate((key) => localStorage.getItem(key), pendingRequestKey);
    nativePhase = "upgrade-admission:pending-original-id";
    await expect
      .poll(async () => JSON.parse(await readPending())?.requestId)
      .toBe(submittedCommand.requestId);
    admissionDiagnostics.pendingOriginalIdSeen = true;
    nativePhase = "upgrade-admission:ui-original-id-lookup";
    await expect
      .poll(() =>
        uiLookups.some(
          (row) =>
            row.path ===
            "/api/system/upgrade/requests/" + submittedCommand.requestId,
        ),
      )
      .toBe(true);
    const originalPending = await readPending();
    assertN01Pending(originalPending, admission);
    expect(uiLookups.filter(row => row.path === "/api/system/upgrade/requests/" + submittedCommand.requestId)
      .every(row => row.preferAsync === admission.preferAsync)).toBe(true);
    const originalTaskUrl = page.url();
    const terminalBookmarkKey = `ap.terminal-bookmark.v1:${encodeURIComponent(browserAdmissionSnapshot.instanceId)}:${encodeURIComponent(browserAdmissionSnapshot.userScope)}:${encodeURIComponent(original.id)}`;
    const readTerminalBookmark = () =>
      page.evaluate((key) => localStorage.getItem(key), terminalBookmarkKey);
    await expect
      .poll(async () => JSON.parse(await readTerminalBookmark()))
      .toEqual({
        version: 1,
        terminalIdentity: secondTerminal.terminalIdentity,
        kind: "shell",
        ordinal: 2,
      });
    const originalTerminalBookmark = await readTerminalBookmark();
    nativePhase = "upgrade-admission:unknown-result-reload";
    await page.reload({ waitUntil: "domcontentloaded" });
    expect(page.url()).toBe(originalTaskUrl);
    // Every real status response is deliberately lost, so this fresh page cannot
    // authenticate the bookmark's instance/viewer scope yet. The production gate
    // must hold restoration and avoid mounting a replacement terminal.
    await expect(
      page.getByText("正在确认原终端的恢复范围…", { exact: true }),
    ).toBeVisible();
    await expect(page.locator('[data-testid^="terminal-pane-"]')).toHaveCount(
      0,
    );
    await expect(
      page.getByRole("tab", { name: "终端 2", exact: true }),
    ).toHaveCount(0);
    expect(await readTerminalBookmark()).toBe(originalTerminalBookmark);
    const readyWhileScopeUnknown = evidence.ready.length;
    expect(await readPending()).toBe(originalPending);
    admissionDiagnostics.pendingOriginalIdRetainedAfterReload = true;
    nativePhase = "upgrade-admission:unknown-readonly-retry-window";
    // Let the actual UI's 2s retry interval run while the result stays unknown.
    await delay(2500);
    await expect(page.locator('[data-testid^="terminal-pane-"]')).toHaveCount(
      0,
    );
    expect(evidence.ready.length).toBe(readyWhileScopeUnknown);
    expect(await readTerminalBookmark()).toBe(originalTerminalBookmark);
    expect(await readPending()).toBe(originalPending);
    expect(admissionPosts).toHaveLength(1);
    assertSingleIntent();
    expect(interceptionError).toBeNull();
    nativePhase = "upgrade-admission:restore-readonly-responses";
    blockAdmissionReads = false;
    const originalLookup = await json(
      request,
      origin,
      "/api/system/upgrade/requests/" + submittedCommand.requestId,
      "GET", undefined, 200,
      admission.preferAsync ? { Prefer: "respond-async" } : {},
    );
    assertN01Lookup(admission, originalLookup);
    if (admission.kind === "operation")
      expect(originalLookup.stages[0].attemptId).toBe(technicalAttempt.attemptId);
    await expect
      .poll(
        async () => {
          const status = await json(request, origin, "/api/system/upgrade/status");
          resolveN01TechnicalAttempt(admission, status, technicalAttempt);
          return admission.kind === "operation" ? status.operation.requestId : status.attempt.requestId;
        },
      )
      .toBe(submittedCommand.requestId);
    nativePhase = "upgrade-admission:readonly-confirmed-reload";
    // A fresh real status may identify the same request directly; that is also
    // readonly reconciliation and must not create another installation command.
    const readonlyBrowserStatus = page.waitForResponse(
      (response) =>
        new URL(response.url()).origin === origin &&
        new URL(response.url()).pathname === "/api/system/upgrade/status" &&
        response.request().method() === "GET" &&
        response.status() === 200,
    );
    const beforeReadonlyRefresh = evidence.ready.length;
    const readonlyRefreshStart = performance.now();
    await page.reload();
    expect(page.url()).toBe(originalTaskUrl);
    const restoredBrowserScope = await (await readonlyBrowserStatus).json();
    expect(restoredBrowserScope.instanceId).toBe(
      browserAdmissionSnapshot.instanceId,
    );
    expect(restoredBrowserScope.userScope).toBe(
      browserAdmissionSnapshot.userScope,
    );
    resolveN01TechnicalAttempt(admission, restoredBrowserScope, technicalAttempt);
    expect(admission.kind === "operation" ? restoredBrowserScope.operation.requestId : restoredBrowserScope.attempt.requestId)
      .toBe(submittedCommand.requestId);
    nativePhase = "upgrade-admission:original-terminal-readonly-reconnect";
    await expect(
      page.getByRole("tab", { name: "终端 2", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await expect
      .poll(
        () =>
          evidence.ready
            .slice(beforeReadonlyRefresh)
            .some(
              (row) =>
                row.sandboxId === original.id &&
                row.terminalIdentity === secondTerminal.terminalIdentity &&
                row.runtimeIdentity === secondTerminal.runtimeIdentity &&
                row.existingSession,
            ),
        { timeout: 5000, intervals: [25, 50, 100] },
      )
      .toBe(true);
    const readonlyReconnectMs = performance.now() - readonlyRefreshStart;
    expect(readonlyReconnectMs).toBeLessThanOrEqual(5000);
    expect(await readTerminalBookmark()).toBe(originalTerminalBookmark);
    nativePhase = "upgrade-admission:clear-reconciled-original-id";
    await expect.poll(readPending).toBeNull();
    admissionDiagnostics.pendingClearedAfterReadonlyConfirmation = true;
    await Promise.all(interceptionTasks);
    expect(interceptionError).toBeNull();
    expect(admissionPosts).toHaveLength(1);
    assertSingleIntent();
    expect(uiLookups.every(row => row.preferAsync === admission.preferAsync)).toBe(true);
    admissionRecovery = {
      actualPostStatus: 202,
      responseLostAfterActualAcceptance: true,
      requestId: submittedCommand.requestId,
      admissionKind: admission.kind,
      operationId: admission.kind === "operation" ? admission.response.operationId : null,
      attemptId: technicalAttempt.attemptId,
      technicalRequestId: technicalAttempt.requestId,
      browserPosts: admissionPosts.length,
      actualUiOriginalIdLookups: uiLookups,
      readonlyResponsesLost,
      pendingReloadContainsOnlyOriginalRequestId: true,
      pendingIdentitySource:
        "actual loaded browser UI status after readonly check immediately before POST",
      productionPendingFormat: admission.preferAsync
        ? "exact version1/original requestId/preferAsync scoped JSON"
        : "version1/original requestId scoped JSON with optional false preferAsync",
      readonlyOriginalLookup: admission.kind === "operation" ? {
        requestId: originalLookup.requestId,
        operationId: originalLookup.operationId,
        finalTargetDigest: originalLookup.finalTargetDigest,
        technicalAttemptId: originalLookup.stages[0].attemptId,
      } : {
        requestId: originalLookup.requestId,
        attemptId: originalLookup.attemptId,
        targetDigest: originalLookup.targetDigest,
      },
      statusConfirmsOriginalRequest: true,
      unknownTerminalRestorationHeldWithoutReplacement: true,
      originalTerminalBookmarkPreservedWhileScopeUnknown: true,
      readonlyTerminalReconnection: {
        terminalIdentity: secondTerminal.terminalIdentity,
        runtimeIdentity: secondTerminal.runtimeIdentity,
        existingSession: true,
        sameTaskPage: true,
        sameBrowserScope: true,
        elapsedMs: readonlyReconnectMs,
      },
      pendingClearedAfterReadonlyConfirmation: true,
      extraPostsWhileUnknownAndReload: 0,
      durableIntents: 1,
      durableUserOperations: admission.kind === "operation" ? 1 : 0,
      durableTechnicalAttempts: 1,
    };
    nativePhase = "upgrade-admission:finish-loss-observation";
    await admissionCdp.send("Fetch.disable");
    await Promise.all(interceptionTasks);
    expect(interceptionError).toBeNull();
    await admissionCdp.detach();
    admissionCdp = null;
    page.off("request", observeAdmission);
    // The original operation and the real technical attempt have independent
    // acceptance timestamps and request digests. Neither is a replay of the other.
    expect(admission.response.state).toBe("accepted");
    expect(submittedCommand.expectedActivationGeneration).toBe(
      initial.activationGeneration,
    );
    const acceptedIntent = {
      actorDigest: upgradeDigest(intent.actor_id),
      kind: admission.kind,
      operationId: admission.kind === "operation" ? admission.response.operationId : null,
      requestId: submittedCommand.requestId,
      requestDigest: upgradeDigest(submittedCommand),
      targetReleaseId: submittedCommand.targetReleaseId,
      targetDigest: submittedCommand.targetDigest,
      expectedActivationGeneration:
        submittedCommand.expectedActivationGeneration,
      acceptedAt: admission.response.acceptedAt,
      technicalAttempt: {
        attemptId: technicalAttempt.attemptId,
        requestId: intent.request_id,
        requestDigest: intent.request_digest,
        planDigest: technicalAttempt.planDigest,
        acceptedAt: technicalAttempt.acceptedAt,
        sourceActivationGeneration: acceptedPlan.sourceActivationGeneration,
      },
      admittedThroughRealBrowserPost: true,
    };
    nativePhase = "upgrade-confirmation";
    await page.getByRole("button", { name: "版本与更新", exact: true }).click();
    const upgradeDetails = page.getByRole("dialog", {
      name: "版本与更新详情",
      exact: true,
    });
    const overallProgress = upgradeDetails.getByRole("progressbar", {
      name: "本实例升级进度",
      exact: true,
    });
    const actualProgress = admission.kind === "operation"
      ? upgradeDetails.locator('[role="progressbar"][aria-label]:not([aria-label="本实例升级进度"]):not([aria-label^="上次确认的"])')
      : overallProgress;
    let progressBrowserStatus = restoredBrowserScope,
      progressStatusError = null;
    const progressStatusTasks = new Set();
    const observeProgressStatus = (response) => {
      const url = new URL(response.url());
      if (url.origin !== origin || url.pathname !== "/api/system/upgrade/status" || response.status() !== 200) return;
      const work = (async () => {
        let status;
        try { status = await response.json(); } catch { return; }
        resolveN01TechnicalAttempt(admission, status, technicalAttempt);
        if (status.attempt.sequence >= progressBrowserStatus.attempt.sequence &&
          (admission.kind !== "operation" || status.operation.sequence >= progressBrowserStatus.operation.sequence))
          progressBrowserStatus = status;
      })().catch(error => { progressStatusError = error; })
        .finally(() => progressStatusTasks.delete(work));
      progressStatusTasks.add(work);
    };
    page.on("response", observeProgressStatus);
    try {
      await expect
      .poll(
        async () => {
          if (progressStatusError) throw progressStatusError;
          const observed = n01ObservedProgress(admission, progressBrowserStatus, technicalAttempt);
          // Capture the attributes together; never turn a missing value into zero.
          const sample = await actualProgress.evaluateAll((elements) =>
            elements.length === 1
              ? {
                  raw: elements[0].getAttribute("aria-valuenow"),
                  ariaText: elements[0].getAttribute("aria-valuetext"),
                }
              : null,
          );
          if (sample?.raw == null) return false;
          const percent = Number(sample.raw);
          if (!Number.isFinite(percent) || percent <= 0 || percent >= 100)
            return false;
          if (percent !== observed.percent) return false;
          if (admission.kind === "operation" &&
            await overallProgress.getAttribute("aria-valuenow") !== null) return false;
          ongoingProgress = {
            percent,
            rawAriaValue: sample.raw,
            ariaText: sample.ariaText,
            actualBrowserProgress: true,
            scope: observed.scope,
            stage: observed.stage,
            actualRequestId: admission.kind === "operation" ? progressBrowserStatus.operation.requestId : progressBrowserStatus.attempt.requestId,
            actualTargetDigest: admission.kind === "operation" ? progressBrowserStatus.operation.finalTargetDigest : progressBrowserStatus.attempt.targetDigest,
            technicalAttemptId: progressBrowserStatus.attempt.attemptId,
            technicalRequestId: progressBrowserStatus.attempt.requestId,
            browserStatusObservedAt: progressBrowserStatus.observedAt,
            overallPercent: admission.kind === "operation" ? progressBrowserStatus.operation.percent : percent,
            observedAtMonotonicMs: performance.now(),
          };
          return true;
        },
        { timeout: 120000, intervals: [250, 500, 1000] },
      )
      .toBe(true);
    } finally {
      page.off("response", observeProgressStatus);
      await Promise.all(progressStatusTasks);
    }
    if (progressStatusError) throw progressStatusError;
    expect(ongoingProgress.actualBrowserProgress).toBe(true);
    expect(Number.isFinite(ongoingProgress.percent)).toBe(true);
    expect(ongoingProgress.percent).toBeGreaterThan(0);
    expect(ongoingProgress.percent).toBeLessThan(100);
    expect(ongoingProgress.percent).toBe(Number(ongoingProgress.rawAriaValue));
    expect(ongoingProgress.actualRequestId).toBe(submittedCommand.requestId);
    expect(ongoingProgress.actualTargetDigest).toBe(submittedCommand.targetDigest);
    expect(ongoingProgress.technicalAttemptId).toBe(technicalAttempt.attemptId);
    expect(ongoingProgress.technicalRequestId).toBe(technicalAttempt.requestId);
    await expect(
      upgradeDetails.getByRole("button", { name: "刷新页面", exact: true }),
    ).toHaveCount(0);
    const frozenTarget = submittedCommand.targetDigest;
    const confirmationDeadline = performance.now() + 900000,
      failedStates = new Set([
        "failed",
        "reverted",
        "candidate-rejected",
        "deferred",
      ]);
    let confirmationPolls = 0;
    while (true) {
      const status = await json(request, origin, "/api/system/upgrade/status"),
        attempt = status.attempt;
      if (
        attempt?.attemptId === technicalAttempt.attemptId &&
        typeof attempt.percent === "number" &&
        Number.isFinite(attempt.percent)
      ) {
        lastKnownProgress = {
          percent: attempt.percent,
          stage: attempt.stage,
          sequence: attempt.sequence,
          observedAt: attempt.observedAt,
        };
      }
      // Persist only public upgrade facts, never csrfToken/cookies or role keys.
      upgradeObservation = {
        instanceId: status.instanceId,
        observedAt: status.observedAt,
        activationGeneration: status.activationGeneration,
        serviceState: status.serviceState,
        operation: status.operation ?? null,
        attempt,
        recovery: status.recovery,
        lastKnownProgress,
      };
      if (
        attempt?.attemptId === technicalAttempt.attemptId &&
        failedStates.has(attempt.state)
      ) {
        throw new Error(
          `N01_INSTANCE_UPGRADE_TERMINATED: ${JSON.stringify(upgradeObservation)}`,
        );
      }
      if (n01UpgradeConfirmed(admission, status, technicalAttempt)) break;
      if (performance.now() >= confirmationDeadline)
        throw new Error(
          `N01_INSTANCE_UPGRADE_CONFIRMATION_TIMEOUT: ${JSON.stringify(upgradeObservation)}`,
        );
      await delay(++confirmationPolls === 1 ? 500 : 1000);
    }
    const installed = await json(request, origin, "/api/system/upgrade/status");
    expect(n01UpgradeConfirmed(admission, installed, technicalAttempt)).toBe(true);
    assertSingleIntent();
    expect(admissionPosts).toHaveLength(1);
    expect(installed.attempt.attemptId).toBe(technicalAttempt.attemptId);
    expect(installed.attempt.targetDigest).toBe(frozenTarget);
    expect(installed.attempt.percent).toBe(100);
    expect(installed.confirmedServiceRelease.releaseId).toBe(
      fixture.envelope.manifest.releaseId,
    );
    expect(installed.activationGeneration).toBeGreaterThan(
      initial.activationGeneration,
    );
    expect(installed.confirmedServiceRelease.components.web.artifactDigest).toBe(
      webContinuity.target.artifactDigest,
    );
    expect(installed.confirmedServiceRelease.components.web.webRevision).toBe(
      webContinuity.target.webRevision,
    );
    if (webContinuity.sameWeb) {
      // Same-Web completion correctly removes the header popover. Observe the
      // existing system card in a separate actual page so the
      // original terminal selection remains untouched until the user reload.
      nativePhase = "upgrade-confirmation:same-web-system-card";
      const completionPage = await context.newPage();
      try {
        const browserCompletionResponse = completionPage.waitForResponse(
          (response) =>
            new URL(response.url()).origin === origin &&
            new URL(response.url()).pathname === "/api/system/upgrade/status" &&
            response.request().method() === "GET" &&
            response.status() === 200,
        );
        await completionPage.goto(origin + "/settings/system#version");
        const browserCompletion = await (await browserCompletionResponse).json();
        expect(
          n01UpgradeConfirmed(admission, browserCompletion, technicalAttempt),
        ).toBe(true);
        expect(browserCompletion.activationGeneration).toBe(
          installed.activationGeneration,
        );
        expect(browserCompletion.confirmedServiceRelease.components.web).toEqual(
          installed.confirmedServiceRelease.components.web,
        );
        const versionCard = completionPage.locator("#version");
        await expect(
          versionCard.getByText("本实例升级已确认，当前页面无需刷新", {
            exact: true,
          }),
        ).toBeVisible();
        await expect(
          versionCard.getByText("本次实例升级已完成 · 100%", { exact: true }),
        ).toBeVisible();
        await expect(
          versionCard.getByRole("button", { name: "刷新页面", exact: true }),
        ).toHaveCount(0);
        await expect(
          versionCard.locator("dt").filter({ hasText: /^当前服务版本$/ })
            .locator("..").locator("dd"),
        ).toHaveText(fixture.envelope.manifest.releaseId);
        await expect(
          versionCard.locator("dt").filter({ hasText: /^实际 Web 构建$/ })
            .locator("..").locator("dd"),
        ).toHaveText(webContinuity.loadedWebRevision);
        await expect(upgradeDetails).toHaveCount(0);
        await expect(
          page.getByRole("button", { name: "版本与更新", exact: true }),
        ).toHaveCount(0);
        completedWebUi = {
          ...webContinuity,
          surface: "actual-browser-system-version-card",
          browserObservedAt: browserCompletion.observedAt,
          operationState: browserCompletion.operation?.state ?? null,
          attemptState: browserCompletion.attempt.state,
          percent: browserCompletion.attempt.percent,
          activationGeneration: browserCompletion.activationGeneration,
          refreshOffered: false,
        };
      } finally {
        await completionPage.close();
      }
    } else {
      nativePhase = "upgrade-confirmation:changed-web-popover";
      await expect(
        page.getByRole("button", { name: "版本与更新", exact: true }),
      ).toBeVisible();
      if (!(await upgradeDetails.isVisible()))
        await page
          .getByRole("button", { name: "版本与更新", exact: true })
          .click();
      await expect(overallProgress).toHaveAttribute("aria-valuenow", "100");
      completedWebUi = {
        ...webContinuity,
        surface: "actual-browser-ready-popover",
        refreshOffered: true,
      };
    }
    nativePhase = "page-refresh-and-terminal-attach";
    const beforeRefresh = evidence.ready.length,
      refreshStart = performance.now();
    const refreshButton = upgradeDetails.getByRole("button", {
      name: "刷新页面",
      exact: true,
    });
    if (!webContinuity.sameWeb) {
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
    const restoredTerminalTabs = page
      .getByRole("tablist", { name: "终端标签", exact: true })
      .getByRole("tab");
    await expect(restoredTerminalTabs).toHaveText([
      "Agent",
      "终端 1",
      "终端 2",
    ]);
    const restoredTerminalLabels = await restoredTerminalTabs.allTextContents();
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
    nativePhase = "original-runtime-continuity";
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
      acceptedAtMs = Date.parse(admission.response.acceptedAt),
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
        expect(
          evidence.mutations.filter(
            (row) =>
              row.path === "/api/system/upgrade/requests" &&
              row.method === "POST",
          ),
        ).toHaveLength(1);
        assertSingleIntent();
        expect(admissionRecovery.browserPosts).toBe(1);
        expect(admissionRecovery.durableIntents).toBe(1);
        expect(admissionRecovery.extraPostsWhileUnknownAndReload).toBe(0);
        expect(ongoingProgress.percent).toBeGreaterThan(0);
        expect(ongoingProgress.percent).toBeLessThan(100);
        expect(ongoingProgress.scope).toBe(admission.kind === "operation" ? "current-technical-stage" : "technical-attempt");
        if (admission.kind === "operation") expect(ongoingProgress.overallPercent).toBeNull();
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
        attemptId: technicalAttempt.attemptId,
        acceptedIntent,
        admissionRecovery,
        ongoingProgress,
        completedWebUi,
        targetDigest: frozenTarget,
        activationGeneration: installed.activationGeneration,
        terminalIdentity: secondTerminal.terminalIdentity,
        attachMs,
        restoredTerminalLabels,
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
          acceptedAt: admission.response.acceptedAt,
          technicalAcceptedAt: technicalAttempt.acceptedAt,
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
        ).toBeGreaterThanOrEqual(10);
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
          observedRateHz: probeResult.observedRateHz,
          schedulingSeconds: probeResult.schedulingSeconds,
          drainMs: probeResult.drainMs,
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
    nativePhase = "explicit-resource-cleanup";
    const cleanupScope = await json(
        request,
        origin,
        "/api/system/upgrade/status",
      ),
      installationProof = JSON.parse(
        await readFile(fixture.installationProofPath, "utf8"),
      ),
      ownedIds = new Set(owned),
      projectRows = database.prepare("SELECT id FROM projects").all(),
      sandboxRows = database
        .prepare("SELECT id,project_id FROM sandboxes")
        .all(),
      ownRuleIds = new Set([trafficRule.id, automation.id]),
      ruleRows = database
        .prepare("SELECT id,project_id FROM automations")
        .all();
    expect(
      fixture.config.isolated === true &&
        fixture.config.docker?.dedicated === true &&
        harness.isolation === "containers" &&
        harness.instanceId === fixture.config.instanceId &&
        cleanupScope.instanceId === fixture.config.instanceId &&
        harness.root === fixture.config.root &&
        installationProof.purpose === "qualification" &&
        installationProof.instanceId === fixture.config.instanceId &&
        installationProof.isolatedRoot === fixture.config.root &&
        ownedIds.size === 3 &&
        owned.length === 3 &&
        projectRows.length === 1 &&
        projectRows[0].id === project.id &&
        sandboxRows.length === 3 &&
        sandboxRows.every(
          (row) => ownedIds.has(row.id) && row.project_id === project.id,
        ) &&
        ruleRows.length === ownRuleIds.size &&
        ruleRows.every(
          (row) => ownRuleIds.has(row.id) && row.project_id === project.id,
        ),
      "Cleanup is restricted to this fresh instance's exact project, three sandboxes and rules",
    ).toBe(true);
    const historySql =
        "SELECT task_id,sandbox_id,provider,payload,state,created_at FROM agent_task_start_intents ORDER BY task_id",
      historyBefore = database.prepare(historySql).all(),
      historyBeforeDigest = digest(historyBefore);
    expect(
      historyBefore.every(
        (row) => row.state === "complete" && ownedIds.has(row.sandbox_id),
      ),
      "All original task-start intents are complete and belong to the owned sandboxes",
    ).toBe(true);
    for (const ruleId of ownRuleIds) {
      const disabled = await json(
        request,
        origin,
        `/api/automations/${ruleId}/disable`,
        "POST",
        {},
      );
      expect(disabled.enabled).toBe(false);
    }
    for (const id of ownedIds) {
      const runningTasks = database
        .prepare(
          "SELECT id FROM agent_tasks WHERE sandbox_id=? AND status='running'",
        )
        .all(id);
      for (const active of runningTasks)
        await json(
          request,
          origin,
          `/api/sandboxes/${id}/tasks/${active.id}/cancel`,
          "POST",
          {},
          202,
        );
      await json(
        request,
        origin,
        `/api/sandboxes/${id}`,
        "DELETE",
        { keepVolume: false },
        204,
      );
    }
    for (const ruleId of ownRuleIds)
      await json(
        request,
        origin,
        `/api/automations/${ruleId}`,
        "DELETE",
        {},
        204,
      );
    const volumes = await json(
      request,
      origin,
      `/api/retained-volumes?projectId=${project.id}`,
    );
    expect(
      Array.isArray(volumes) &&
        volumes.every(
          (volume) =>
            volume.projectId === project.id &&
            /^[a-f0-9-]{36}$/.test(volume.id) &&
            (volume.sandboxId == null || ownedIds.has(volume.sandboxId)),
        ),
      "Every retained volume is scoped to this exact owned project and sandbox set",
    ).toBe(true);
    for (const volume of volumes)
      await json(
        request,
        origin,
        `/api/retained-volumes/${encodeURIComponent(volume.id)}`,
        "DELETE",
        {},
        204,
      );
    await json(
      request,
      origin,
      `/api/projects/${project.id}`,
      "DELETE",
      { keepBaseline: false },
      204,
    );
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
      if (performance.now() >= cleanupDeadline)
        throw new Error(
          `N01_OWNED_RESOURCE_CLEANUP_NOT_CONFIRMED: ${JSON.stringify(counts)}`,
        );
      await delay(250);
    }
    const historyAfter = database.prepare(historySql).all(),
      historyAfterDigest = digest(historyAfter);
    expect(
      historyAfter.every((row) => row.state === "complete") &&
        historyAfterDigest === historyBeforeDigest,
      "Six-field original completed task-start history is preserved byte-for-byte; no history SQL deletion",
    ).toBe(true);
    businessCleanup = {
      instanceId: fixture.config.instanceId,
      projectId: project.id,
      sandboxIds: [...ownedIds],
      ruleIds: [...ownRuleIds],
      retainedVolumesDeleted: volumes.length,
      liveTableCounts: counts,
      completedStartIntentHistory: {
        fields: [
          "task_id",
          "sandbox_id",
          "provider",
          "payload",
          "state",
          "created_at",
        ],
        before: historyBefore.length,
        after: historyAfter.length,
        beforeDigest: historyBeforeDigest,
        afterDigest: historyAfterDigest,
        preserved: true,
      },
      cleanedThroughPublicApi: true,
      observedAt: new Date().toISOString(),
    };
    resourcesCleaned = true;
  } catch (error) {
    // APIRequestContext errors can include authentication headers in their raw
    // message. Record only a known failure category, never that message/body.
    const category = [
      "N01_INSTANCE_UPGRADE_TERMINATED",
      "N01_INSTANCE_UPGRADE_CONFIRMATION_TIMEOUT",
      "N01_REAL_ADMISSION_RESPONSE_MISSING",
    ].find(
      (code) =>
        typeof error?.message === "string" &&
        (error.message === code || error.message.startsWith(code + ":")),
    );
    bodyErrorSummary = {
      category: category ?? "N01_BODY_FAILED",
      name: ["Error", "AssertionError", "TimeoutError"].includes(error?.name)
        ? error.name
        : "Error",
      matcherName:
        typeof error?.matcherResult?.name === "string" &&
        /^to[A-Z][A-Za-z]+$/.test(error.matcherResult.name)
          ? error.matcherResult.name
          : null,
      sourceLocations: [
        ...new Set(
          String(error?.stack ?? "").match(
            /(?:e2e-contract\/(?:acceptance|native|server)|deploy\/(?:upgrade|jenkins))\/[A-Za-z0-9_.-]+\.(?:mjs|ts):\d+:\d+/g,
          ) ?? [],
        ),
      ].slice(0, 12),
      rawMessageOmitted: true,
    };
    throw error;
  } finally {
    // Keep this diagnostic independent from mandatory UPG assertion IDs. Persist
    // it before any teardown await can hide a body failure behind an open SSE.
    const attempt = upgradeObservation?.attempt,
      recovery = upgradeObservation?.recovery,
      diagnostic = {
        schemaVersion: 1,
        kind: "native-upgrade-before-teardown-diagnostic",
        qualificationEvidence: false,
        bodyOutcome: bodyErrorSummary === null ? "completed" : "failed",
        phase: nativePhase,
        instanceId: fixture?.config?.instanceId ?? null,
        sourceInputFingerprint:
          fixture?.config?.qualification?.inputFingerprint ?? null,
        targetManifestDigest: fixture?.envelope?.manifestDigest ?? null,
        error: bodyErrorSummary,
        admissionDiagnostics,
        ongoingProgress,
        publicObservation:
          upgradeObservation === null
            ? null
            : {
                instanceId: upgradeObservation.instanceId,
                observedAt: upgradeObservation.observedAt,
                activationGeneration: upgradeObservation.activationGeneration,
                serviceState: upgradeObservation.serviceState,
                attempt:
                  attempt == null
                    ? null
                    : {
                        attemptId: attempt.attemptId,
                        targetReleaseId: attempt.targetReleaseId,
                        targetDigest: attempt.targetDigest,
                        generation: attempt.generation,
                        sequence: attempt.sequence,
                        state: attempt.state,
                        stage: attempt.stage,
                        percent: attempt.percent,
                        completedWork: attempt.completedWork,
                        totalWork: attempt.totalWork,
                        observedAt: attempt.observedAt,
                        reasonCode:
                          attempt.reason === "INTERNAL" ? "INTERNAL" : null,
                        reasonPresent: typeof attempt.reason === "string",
                      },
                recovery:
                  recovery == null
                    ? null
                    : {
                        recoveryAttemptId: recovery.recoveryAttemptId,
                        triggeringAttemptId: recovery.triggeringAttemptId,
                        generation: recovery.generation,
                        sequence: recovery.sequence,
                        state: recovery.state,
                        planDigest: recovery.planDigest,
                        observedAt: recovery.observedAt,
                      },
                lastKnownProgress,
              },
        observedAt: new Date().toISOString(),
      };
    try {
      const diagnosticPath = info.outputPath(
        "upg-diagnostic-before-teardown.json",
      );
      await mkdir(resolve(diagnosticPath, ".."), {
        recursive: true,
        mode: 0o700,
      });
      await writeFile(
        diagnosticPath,
        JSON.stringify(diagnostic, null, 2) + "\n",
        { mode: 0o600 },
      );
      await info.attach("UPG-before-teardown", {
        path: diagnosticPath,
        contentType: "application/json",
      });
    } catch {
      // A diagnostic write must not replace the original acceptance failure.
      console.error("N01_BEFORE_TEARDOWN_DIAGNOSTIC_UNAVAILABLE");
    }
    if (admissionCdp) {
      try {
        await admissionCdp.send("Fetch.disable");
        await admissionCdp.detach();
      } catch {
        /* The browser may already be closing. */
      }
    }
    if (probe) probeResult = await probe.stop();
    database?.close();
    let cleanup, cleanupError;
    try {
      cleanup = await closeQualifiedInstallation({
        harness,
        fixture,
        resourcesCleaned,
      });
    } catch (error) {
      cleanupError = error;
      cleanup = {
        resourcesCleaned,
        rolesStopped: false,
        reason: error.code ?? "CLEANUP_UNCONFIRMED",
      };
    }
    const output = info.outputPath("upg-assertions.json");
    await mkdir(resolve(output, ".."), { recursive: true, mode: 0o700 });
    await writeFile(
      output,
      JSON.stringify(
        {
          assertions,
          probes: probeResult,
          requests: evidence.traffic,
          upgradeObservation,
          businessCleanup,
          admissionRecovery,
          admissionDiagnostics,
          ongoingProgress,
          completedWebUi,
          cleanup,
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
    if (model) await model.close();
    // The original body exception stays authoritative. Preserve cleanup failure
    // separately in the attachment; only a successful body can fail on teardown.
    if (cleanupError && bodyErrorSummary === null) throw cleanupError;
  }
});
