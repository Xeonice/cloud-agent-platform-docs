import { test, expect } from "@playwright/test";
import { readFile, lstat, readdir, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { randomUUID, createHash } from "node:crypto";
import { startUpgradeHarness } from "../server/start-upgrade.mjs";
import { createUpgradeFixture } from "../server/upgrade-fixture.mjs";

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
  await page.getByTestId("terminal-tab-new").click();
  const menu = page.getByTestId("terminal-launch-shell");
  if (await menu.isVisible()) await menu.click();
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
function sampling(request, origin, projectId) {
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
    ids.add(operationId);
    const work = (async () => {
      for (const kind of ["read", "write"]) {
        const begin = performance.now();
        try {
          const response = await request.fetch(
            origin + (kind === "read" ? "/api/projects" : "/api/projects"),
            {
              method: kind === "read" ? "GET" : "POST",
              ...(kind === "write"
                ? {
                    data: {
                      name: `UPG probe ${projectId.slice(0, 8)} ${tick}`,
                      sourceType: "empty",
                    },
                  }
                : {}),
              headers: { Origin: origin, "X-Operation-Id": operationId },
              timeout: 2000,
            },
          );
          const body = await response.json();
          samples.push({
            kind,
            status: response.status(),
            latencyMs: performance.now() - begin,
            tick,
            operationDigest: digest(operationId),
            resultId: kind === "write" ? body.id : undefined,
          });
          if (kind === "write" && response.status() === 202) {
            const duplicate = await request.post(origin + "/api/projects", {
              data: {
                name: `UPG probe ${projectId.slice(0, 8)} ${tick}`,
                sourceType: "empty",
              },
              headers: { Origin: origin, "X-Operation-Id": operationId },
              timeout: 2000,
            });
            const original = await duplicate.json();
            samples.push({
              kind: "dedup",
              status: duplicate.status(),
              latencyMs: performance.now() - begin,
              tick,
              sameId: original.id === body.id,
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
      await Promise.all(pending);
      return {
        samples,
        seconds: (performance.now() - started) / 1000,
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
    fixture = await createUpgradeFixture(source);
    harness = await startUpgradeHarness(fixture.config);
    void harness.runController();
    const origin = harness.entryOrigin,
      request = context.request;
    await page.goto(origin);
    if (await page.getByLabel("访问口令", { exact: true }).isVisible()) {
      await page
        .getByLabel("访问口令", { exact: true })
        .fill(fixture.config.authEnv.ACCESS_PASSCODE);
      await page.getByRole("button", { name: "解锁", exact: true }).click();
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
    const initStatus = await json(request, origin, "/api/system/init-status");
    if (!initStatus.initialized)
      await json(request, origin, "/api/system/init", "POST", {}, 201);
    expect(
      source.runtimeCredential,
      "A dedicated, nonproduction credential/endpoint is required for the actual guest CLI",
    ).toBeDefined();
    await json(
      request,
      origin,
      "/api/runtimes/codex/credentials/secret",
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
      .getByRole("radio", { name: /Codex/ })
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
        runtime: "codex",
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
      `/api/sandboxes/${headless.id}/runtimes/codex/tasks`,
      "POST",
      { prompt: source.headlessPrompt, timeoutMinutes: 30 },
      202,
    );
    expect(run.status).toBe("running");
    // Schedule a real occurrence across the measured upgrade window.
    expect(
      source.automationInput,
      "The native load includes an actual due automation",
    ).toBeDefined();
    const automation = await json(
      request,
      origin,
      "/api/automations",
      "POST",
      { ...source.automationInput, projectId: project.id },
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
    const mutationStart = evidence.mutations.length;
    probe = sampling(request, origin, project.id);
    const acceptedResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/system/upgrade/requests" &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "版本与更新", exact: true }).click();
    await page.getByRole("button", { name: "立即升级", exact: true }).click();
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
                row.status >= 200 && row.status < 300 && row.latencyMs <= 2000,
            ),
        ).toBe(true);
        expect(
          probeResult.samples
            .filter((row) => row.kind === "dedup")
            .every((row) => row.status === 202 && row.sameId),
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
  }
});
