// Shared real Native observations. This file contains no lifecycle mocks.
import { expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import * as fs from "node:fs/promises";
import { captureProcessIdentity } from "../../deploy/upgrade/supervisor-sampler.mjs";
import { execute } from "../../deploy/upgrade/production-role-adapter.mjs";
import { digest } from "../../deploy/upgrade/trust.mjs";

export async function api(
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
export async function browserStatus(page) {
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
export async function unlock(page, config, origin) {
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
export async function cliCounter(request, origin, sandboxId, marker) {
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
export function originalBusiness(db, sandboxId, taskId) {
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
export async function originalPhysical(harness, config, Database, sandboxId) {
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
export function continuous(before, after) {
  expect(after.pid).toBe(before.pid);
  expect(after.birth).toBe(before.birth);
  expect(after.launches).toEqual(before.launches);
  expect(after.launches).toHaveLength(1);
  expect(after.seq.slice(0, before.seq.length)).toEqual(before.seq);
  expect(after.seq.length).toBeGreaterThan(before.seq.length + 2);
  for (let i = 1; i < after.seq.length; i++)
    expect(after.seq[i]).toBe(after.seq[i - 1] + 1);
}
