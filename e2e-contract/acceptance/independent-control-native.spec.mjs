import { test, expect } from "@playwright/test";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import * as fs from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { startIndependentUpgradeHarness } from "../server/start-independent-upgrade.mjs";
import { independentNativeOutcome } from "../server/independent-native-outcome.mjs";
import {
  startQualificationModel,
  qualificationPrompt,
  configureQualificationImage,
} from "../server/qualification-model.mjs";
import { captureProcessIdentity } from "../../deploy/upgrade/supervisor-sampler.mjs";
import { execute } from "../../deploy/upgrade/production-role-adapter.mjs";
import { digest, invariant } from "../../deploy/upgrade/trust.mjs";
import { atomicJson } from "../../deploy/upgrade/io.mjs";

const scenarios = ["normal", "agent-restart", "business-fault", "unknown-ack"];
async function configuration(scenario) {
  const path = process.env.INDEPENDENT_UPGRADE_ACCEPTANCE_CONFIG;
  invariant(path, "INDEPENDENT_UPGRADE_ACCEPTANCE_CONFIG_REQUIRED");
  const stat = await fs.lstat(path);
  invariant(
    stat.isFile() &&
      !stat.isSymbolicLink() &&
      (stat.mode & 0o077) === 0 &&
      stat.size <= 262144,
    "INDEPENDENT_NATIVE_CONFIG_INSECURE",
  );
  const input = JSON.parse(await fs.readFile(path, "utf8"));
  const selected = input.scenarios?.[scenario];
  invariant(
    selected || input.scenario === scenario,
    "INDEPENDENT_NATIVE_SCENARIO_INPUT_REQUIRED",
  );
  const config = { ...input, ...selected };
  delete config.scenarios;
  invariant(
    config.isolated === true &&
      config.root === resolve(config.root) &&
      config.modelMode === "local-protocol-test",
    "INDEPENDENT_NATIVE_EXPLICIT_MODEL_SERVICE_REQUIRED",
  );
  return config;
}
async function api(
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
  return expected === 204 ? null : response.json();
}
async function browserStatus(page) {
  const result = await page.evaluate(async () => {
    const started = performance.now();
    const response = await fetch("/api/system/upgrade/status", {
      signal: AbortSignal.timeout(2000),
    });
    return {
      status: response.status,
      elapsedMs: performance.now() - started,
      value: await response.json(),
    };
  });
  expect(result.status).toBe(200);
  expect(result.elapsedMs).toBeLessThanOrEqual(2000);
  return result;
}
async function unlock(page, config, origin) {
  await page.goto(origin);
  const gate = page.getByRole("dialog", { name: "访问口令", exact: true });
  await expect(gate).toBeVisible({ timeout: 30000 });
  await gate
    .locator('input[name="passcode"]')
    .fill(config.authEnv.ACCESS_PASSCODE);
  const response = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === "/api/access/unlock" &&
      r.request().method() === "POST",
  );
  await gate.getByRole("button", { name: "解锁", exact: true }).click();
  expect((await response).ok()).toBe(true);
  await expect(gate).toHaveCount(0, { timeout: 30000 });
}
async function cliCounter(request, origin, sandboxId, marker) {
  const folder = "/workspace/.upg-agent-proof/" + marker;
  const result = await api(
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
  expect(match, "real CLI Bash tool process/counter").not.toBeNull();
  return {
    pid: Number(match[1]),
    birth: match[2],
    launches: match[3].trim().split("\n").map(Number),
    seq: match[4].trim().split("\n").map(Number),
  };
}
function originalBusiness(db, sandboxId, taskId) {
  const sandbox = db
      .prepare(
        "SELECT provider,provider_handle,provider_state,workspace_path FROM sandboxes WHERE id=?",
      )
      .get(sandboxId),
    task = db
      .prepare(
        "SELECT sandbox_id,job_handle,status FROM agent_tasks WHERE id=?",
      )
      .get(taskId);
  expect(sandbox?.provider).toBe("boxlite");
  expect(sandbox.provider_handle).toBeTruthy();
  expect(task?.sandbox_id).toBe(sandboxId);
  expect(task.job_handle).toBeTruthy();
  return {
    sandbox: {
      provider: sandbox.provider,
      handle: sandbox.provider_handle,
      stateDigest: digest(sandbox.provider_state),
      workspaceDigest: digest(sandbox.workspace_path),
    },
    task: {
      sandboxId: task.sandbox_id,
      handleDigest: digest(task.job_handle),
      status: task.status,
    },
  };
}
async function originalPhysical(harness, config, Database, sandboxId) {
  const business = new Database(harness.businessDatabasePath, {
      readonly: true,
      fileMustExist: true,
    }),
    sdk = new Database(join(harness.paths.owner, "boxlite/db/boxlite.db"), {
      readonly: true,
      fileMustExist: true,
    });
  let box;
  try {
    const row = business
      .prepare("SELECT provider_handle FROM sandboxes WHERE id=?")
      .get(sandboxId);
    box = sdk
      .prepare(
        "SELECT c.id,s.status,s.pid FROM box_config c LEFT JOIN box_state s ON s.id=c.id WHERE c.id=?",
      )
      .get(row.provider_handle);
    expect(box?.pid).toBeGreaterThan(0);
  } finally {
    business.close();
    sdk.close();
  }
  const owner = await harness.inspect("owner");
  expect(owner.running).toBe(true);
  const docker = (args) =>
    execute(config.docker.cli || "docker", [...config.docker.args, ...args]);
  const lines = (
    await docker(["top", owner.containerId, "-eo", "pid,ppid,comm"])
  )
    .trim()
    .split("\n")
    .slice(1)
    .map((line) => {
      const [pid, ppid, comm] = line.trim().split(/\s+/);
      return { hostPid: Number(pid), ppid: Number(ppid), comm };
    });
  const procRoot = config.hostProcRoot ?? "/host/proc";
  let shim;
  for (const row of lines) {
    const status = await fs.readFile(
      join(procRoot, String(row.hostPid), "status"),
      "utf8",
    );
    const ns = /^NSpid:\s+(.+)$/m
      .exec(status)?.[1]
      .trim()
      .split(/\s+/)
      .map(Number);
    if (ns?.at(-1) === box.pid) shim = row;
  }
  expect(shim, "real SDK-owned shim host incarnation").toBeDefined();
  const owned = new Set([shim.hostPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of lines)
      if (owned.has(row.ppid) && !owned.has(row.hostPid)) {
        owned.add(row.hostPid);
        changed = true;
      }
  }
  const vmm = [];
  for (const row of lines.filter((row) => owned.has(row.hostPid))) {
    const home = join(procRoot, String(row.hostPid)),
      birth = await captureProcessIdentity({
        hostPid: row.hostPid,
        containerId: owner.containerId,
        procRoot,
      });
    const descriptors = await fs.readdir(join(home, "fd"));
    const targets = await Promise.all(
      descriptors.map((name) =>
        fs.readlink(join(home, "fd", name)).catch(() => ""),
      ),
    );
    const kvm = targets.filter((value) => value.includes("kvm"));
    if (kvm.length)
      vmm.push({ hostPid: row.hostPid, ...birth, kvmDescriptors: kvm.sort() });
  }
  expect(
    vmm.length,
    "actual SDK shim/VMM must hold real KVM descriptors",
  ).toBeGreaterThan(0);
  return {
    owner: {
      containerId: owner.containerId,
      startIdentity: owner.startIdentity,
      startedAt: owner.startedAt,
      hostPid: owner.hostPid,
      ...(await captureProcessIdentity({
        hostPid: owner.hostPid,
        containerId: owner.containerId,
        procRoot,
      })),
    },
    sdk: { id: box.id, pid: box.pid, status: box.status },
    vmm,
  };
}
function continuous(before, after) {
  expect(after.pid).toBe(before.pid);
  expect(after.birth).toBe(before.birth);
  expect(after.launches).toEqual(before.launches);
  expect(after.launches).toHaveLength(1);
  expect(after.seq.slice(0, before.seq.length)).toEqual(before.seq);
  expect(after.seq.length).toBeGreaterThan(before.seq.length + 2);
  for (let i = 1; i < after.seq.length; i++)
    expect(after.seq[i]).toBe(after.seq[i - 1] + 1);
}

for (const scenario of scenarios)
  test(`independent-control-native ${scenario}: original Guest, SDK/VMM and real Claude CLI survive the production control flow`, async ({
    page,
    context,
  }, info) => {
    let harness,
      model,
      business,
      ledger,
      cdp,
      capacityError,
      config,
      passed = false,
      original,
      task,
      project;
    const evidence = {
      schemaVersion: 1,
      scenario,
      result: "not-run",
      nativeQualified: false,
      modelQualityQualified: false,
      assertions: [],
      statusReads: [],
      originalRequestId: null,
    };
    try {
      config = await configuration(scenario);
      model = await startQualificationModel({
        isolated: true,
        instanceId: config.instanceId,
        host: config.localModel?.bindHost ?? "127.0.0.1",
        guestHost: config.localModel?.guestHost ?? "host.boxlite.internal",
      });
      harness = await startIndependentUpgradeHarness(config);
      const requireApi = createRequire(
          join(config.initialRoot, "api/apps/api/package.json"),
        ),
        Database = requireApi("better-sqlite3"),
        { UpgradeStatusSchema } = requireApi("@platform/contracts");
      business = new Database(harness.businessDatabasePath, {
        readonly: true,
        fileMustExist: true,
      });
      business.pragma("query_only=ON");
      ledger = new Database(harness.controlDbPath, {
        readonly: true,
        fileMustExist: true,
      });
      ledger.pragma("query_only=ON");
      const origin = harness.entryOrigin,
        request = context.request;
      await unlock(page, config, origin);
      const init = await api(request, origin, "/api/system/init-status");
      if (!init.initialized) {
        await api(
          request,
          origin,
          "/api/system/init",
          "POST",
          { acknowledgeOffline: true },
          201,
        );
        await page.reload();
      }
      await configureQualificationImage(request, origin, model);
      await api(
        request,
        origin,
        `/api/runtimes/${model.runtimeId}/credentials/secret`,
        "POST",
        model.runtimeCredential,
      );
      project = await api(
        request,
        origin,
        "/api/projects",
        "POST",
        { name: "Independent control Native " + scenario, sourceType: "empty" },
        201,
      );
      original = await api(
        request,
        origin,
        "/api/sandboxes",
        "POST",
        {
          projectId: project.id,
          runtime: model.runtimeId,
          headless: true,
          timeoutMinutes: 30,
        },
        201,
      );
      await expect
        .poll(
          async () =>
            (await api(request, origin, `/api/sandboxes/${original.id}`))
              .status,
          { timeout: 180000 },
        )
        .toBe("running");
      const marker = randomUUID();
      task = await api(
        request,
        origin,
        `/api/sandboxes/${original.id}/runtimes/${model.runtimeId}/tasks`,
        "POST",
        { prompt: qualificationPrompt(marker), timeoutMinutes: 30 },
        202,
      );
      let before;
      await expect
        .poll(
          async () => {
            try {
              before = await cliCounter(request, origin, original.id, marker);
              return before.seq.length;
            } catch {
              return 0;
            }
          },
          { timeout: 180000 },
        )
        .toBeGreaterThanOrEqual(3);
      expect(before.launches).toHaveLength(1);
      const physicalBefore = await originalPhysical(
          harness,
          config,
          Database,
          original.id,
        ),
        businessBefore = originalBusiness(business, original.id, task.id);
      await page.goto(origin + "/?taskId=" + original.id);
      await expect(page.getByTestId("upgrade-notice")).toBeVisible({
        timeout: 30000,
      });
      await expect
        .poll(async () => (await browserStatus(page)).value.catalog.state, {
          timeout: 30000,
        })
        .toBe("verified");
      const initial = (await browserStatus(page)).value;
      expect(initial.controlSystem.state).toBe("ready");
      expect(initial.catalog.availableRelease).toBeTruthy();
      const command = {
        requestId: randomUUID(),
        targetReleaseId: initial.catalog.availableRelease.releaseId,
        targetDigest: initial.catalog.availableRelease.targetDigest,
        expectedActivationGeneration: initial.activationGeneration,
      };
      evidence.originalRequestId = command.requestId;
      let responseLost = false;
      if (scenario === "unknown-ack") {
        cdp = await context.newCDPSession(page);
        await cdp.send("Fetch.enable", {
          patterns: [
            {
              urlPattern: origin + "/api/system/upgrade/requests",
              requestStage: "Response",
            },
          ],
        });
        cdp.on("Fetch.requestPaused", (event) => {
          if (event.request.method === "POST" && !responseLost) {
            responseLost = true;
            void cdp.send("Fetch.failRequest", {
              requestId: event.requestId,
              errorReason: "Aborted",
            });
          } else
            void cdp.send("Fetch.continueRequest", {
              requestId: event.requestId,
            });
        });
      }
      const admission = await page.evaluate(
        async ({ command, csrf }) => {
          try {
            const response = await fetch("/api/system/upgrade/requests", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Upgrade-CSRF": csrf,
              },
              body: JSON.stringify(command),
              signal: AbortSignal.timeout(2000),
            });
            return { status: response.status, body: await response.json() };
          } catch {
            return { status: 0 };
          }
        },
        { command, csrf: initial.csrfToken },
      );
      if (scenario === "unknown-ack") {
        expect(responseLost).toBe(true);
        expect(admission.status).toBe(0);
        await cdp.send("Fetch.disable");
      } else expect(admission.status).toBe(202);
      await expect
        .poll(
          () =>
            ledger
              .prepare(
                "SELECT count(*) n FROM upgrade_attempts WHERE request_id=?",
              )
              .get(command.requestId).n,
          { timeout: 30000 },
        )
        .toBe(1);
      const attempt = ledger
        .prepare("SELECT attempt_id FROM upgrade_attempts WHERE request_id=?")
        .get(command.requestId);
      if (scenario === "agent-restart") {
        await expect
          .poll(
            () =>
              ledger
                .prepare(
                  "SELECT count(*) n FROM control_commands WHERE operation_id=? AND state='executing'",
                )
                .get(attempt.attempt_id).n,
            { timeout: 120000, intervals: [10, 20, 25] },
          )
          .toBeGreaterThan(0);
        evidence.agentBefore = await harness.inspect("control");
        evidence.agentFault = await harness.faultSignal("control", "SIGKILL");
        const stopped = await harness.inspect("control");
        expect(stopped.running).toBe(false);
        evidence.agentAfter = await harness.restartAgentForFault();
        expect(evidence.agentAfter.containerId).toBe(
          evidence.agentBefore.containerId,
        );
        expect(evidence.agentAfter.startedAt).not.toBe(
          evidence.agentBefore.startedAt,
        );
        // Explicit crash/restart fault injection is recorded as such. It is not a
        // claim that the Supervisor maintenance watchdog has been qualified.
        evidence.agentRestartMode = "explicit-owned-container-fault-injection";
      }
      if (scenario === "business-fault") {
        evidence.businessFault = await harness.faultSignal(
          "coordinator",
          "SIGSTOP",
        );
        try {
          evidence.statusReads.push(await browserStatus(page));
          const lookup = await page.evaluate(async (id) => {
            const started = performance.now();
            const response = await fetch("/api/system/upgrade/requests/" + id, {
              signal: AbortSignal.timeout(2000),
            });
            return {
              status: response.status,
              elapsedMs: performance.now() - started,
              value: await response.json(),
            };
          }, command.requestId);
          expect(lookup.status).toBe(200);
          expect(lookup.elapsedMs).toBeLessThanOrEqual(2000);
          expect(lookup.value.requestId).toBe(command.requestId);
          await delay(6000);
        } finally {
          await harness.faultSignal("coordinator", "SIGCONT");
        }
      }
      const deadline = Date.now() + 900000;
      let terminal, terminalOutcome;
      while (Date.now() < deadline) {
        const observed = await browserStatus(page);
        evidence.statusReads.push({
          status: observed.status,
          elapsedMs: observed.elapsedMs,
          attemptState: observed.value.attempt?.state,
          recoveryPhase: observed.value.recovery?.phase,
          controlState: observed.value.controlSystem?.state,
        });
        const status = UpgradeStatusSchema.parse(observed.value);
        const outcome = independentNativeOutcome({ scenario, status, command });
        if (outcome.state === "failed")
          throw Object.assign(
            Error(
              "Actual independent upgrade did not meet this scenario's target",
            ),
            { code: outcome.code },
          );
        if (outcome.state === "confirmed" || outcome.state === "recovered") {
          terminal = status;
          terminalOutcome = outcome;
          break;
        }
        await delay(500);
      }
      expect(
        terminal,
        "the scenario-specific confirmation must finish under the original bounded intent",
      ).toBeDefined();
      expect(terminalOutcome).toBeDefined();
      evidence.terminalOutcome = terminalOutcome;
      if (terminalOutcome.state === "recovered") {
        expect(scenario).toBe("business-fault");
        expect(terminal.recovery.phase).toBe("recovered");
        expect(terminal.recovery.confirmedAt).toBeTruthy();
        const proof = ledger
          .prepare(
            "SELECT receipt,receipt_digest FROM control_recovery_confirmations WHERE recovery_id=?",
          )
          .get(terminalOutcome.recoveryId);
        expect(proof).toBeDefined();
        const value = JSON.parse(proof.receipt),
          { receiptDigest, ...facts } = value;
        expect(digest(facts)).toBe(receiptDigest);
        expect(receiptDigest).toBe(proof.receipt_digest);
        expect(
          value.observation.recoveryProbes.windowMs,
        ).toBeGreaterThanOrEqual(60000);
        expect(value.observation.recoveryProbes.samples).toBeGreaterThanOrEqual(
          600,
        );
        evidence.recoveryConfirmationDigest = receiptDigest;
      } else {
        expect(terminalOutcome.state).toBe("confirmed");
        expect(terminal.attempt.state).toBe("activation-confirmed");
        expect(terminal.confirmedServiceRelease.releaseId).toBe(
          command.targetReleaseId,
        );
      }
      await page.reload();
      await expect
        .poll(
          async () =>
            (await browserStatus(page)).value.serviceAvailability?.state,
          { timeout: 30000 },
        )
        .toBe("available");
      const after = await cliCounter(request, origin, original.id, marker);
      continuous(before, after);
      expect(originalBusiness(business, original.id, task.id)).toEqual(
        businessBefore,
      );
      const physicalAfter = await originalPhysical(
        harness,
        config,
        Database,
        original.id,
      );
      expect(physicalAfter).toEqual(physicalBefore);
      expect(
        (
          await api(
            request,
            origin,
            `/api/sandboxes/${original.id}/tasks/${task.id}`,
          )
        ).status,
      ).toBe("running");
      expect(
        ledger
          .prepare("SELECT count(*) n FROM upgrade_attempts WHERE request_id=?")
          .get(command.requestId).n,
      ).toBe(1);
      expect(
        model
          .evidence()
          .requests.filter(
            (row) => row.taskId === marker && row.phase === "tool-issued",
          ),
      ).toHaveLength(1);
      const cliVersion = await api(
        request,
        origin,
        `/api/sandboxes/${original.id}/exec`,
        "POST",
        { command: "claude --version" },
      );
      expect(cliVersion.exitCode).toBe(0);
      expect(cliVersion.stdout).toMatch(/\d+\.\d+\.\d+/);
      evidence.result = "passed";
      evidence.nativeQualified = true;
      evidence.physical = physicalAfter;
      evidence.cli = {
        before: {
          pid: before.pid,
          birth: before.birth,
          launches: before.launches,
          sequenceCount: before.seq.length,
        },
        after: {
          pid: after.pid,
          birth: after.birth,
          launches: after.launches,
          sequenceCount: after.seq.length,
        },
        version: cliVersion.stdout.trim(),
      };
      evidence.business = businessBefore;
      evidence.controlPackageDigest = harness.controlPackageDigest;
      await api(
        request,
        origin,
        `/api/sandboxes/${original.id}/tasks/${task.id}/cancel`,
        "POST",
        undefined,
        202,
      );
      await api(
        request,
        origin,
        `/api/sandboxes/${original.id}`,
        "DELETE",
        undefined,
        204,
      );
      await api(
        request,
        origin,
        `/api/projects/${project.id}`,
        "DELETE",
        undefined,
        204,
      );
      await expect
        .poll(
          () => business.prepare("SELECT count(*) n FROM sandboxes").get().n,
          { timeout: 30000 },
        )
        .toBe(0);
      passed = true;
    } catch (error) {
      evidence.result = "failed";
      evidence.nativeQualified = false;
      evidence.code = error?.code ?? "INDEPENDENT_NATIVE_ASSERTION_FAILED";
      throw error;
    } finally {
      await cdp?.detach().catch(() => {});
      business?.close();
      ledger?.close();
      if (harness) {
        await atomicJson(
          join(harness.root, "independent-native-evidence.json"),
          { ...evidence, recordedAt: new Date().toISOString() },
        );
        await harness.close({ resourcesCleaned: passed }).catch((error) => {
          capacityError = error?.code ?? "INDEPENDENT_NATIVE_CLOSE_UNKNOWN";
        });
      }
      await model?.close();
      await info.attach("independent-native-evidence", {
        body: Buffer.from(
          JSON.stringify({ ...evidence, closeError: capacityError ?? null }),
        ),
        contentType: "application/json",
      });
      if (capacityError)
        throw Object.assign(Error("Owned installation close failed"), {
          code: capacityError,
        });
    }
  });
