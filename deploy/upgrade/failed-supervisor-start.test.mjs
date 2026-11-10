import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observeFailedSupervisorStart } from "./failed-supervisor-start.mjs";
import { digest } from "./trust.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), "supervisor-inert-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const registryRoot = join(root, "records"),
    config = {
      instanceId: "instance",
      procRoot: join(root, "proc"),
      cgroupRoot: join(root, "cgroup"),
    };
  await Promise.all(
    [registryRoot, config.procRoot, config.cgroupRoot].map((p) =>
      fs.mkdir(p, { mode: 0o700 }),
    ),
  );
  const record = {
      kind: "control-supervisor",
      instanceId: "instance",
      operationId: "migration",
      attemptId: "migration",
      commandId: "migration:start-control-supervisor",
      specDigest: digest("spec"),
      startIdentity: "original-supervisor",
      artifactDigest: digest("artifact"),
    },
    expected = {
      ...record,
      role: record.kind,
      containerId: "a".repeat(64),
      imageDigest: digest("image"),
      hostPid: 123,
      running: true,
      paused: false,
      restartPolicy: "no",
      restartCount: 0,
      oomKilled: false,
      exitCode: 0,
      startedAt: new Date(Date.now() - 5000).toISOString(),
    },
    metadata = {
      ...expected,
      birthTicks: "12345",
      cgroupDigest: digest("cgroup"),
      cgroupPath: "/docker/" + expected.containerId,
    },
    intentPath = join(
      registryRoot,
      "start-migration-" + record.commandId + ".json",
    ),
    metadataPath = join(registryRoot, expected.containerId + ".json");
  const write = async () =>
    Promise.all(
      [
        [intentPath, { state: "applied", record: metadata }],
        [metadataPath, metadata],
      ].map(([p, v]) =>
        fs.writeFile(p, JSON.stringify(v) + "\n", { mode: 0o600 }),
      ),
    );
  await write();
  let terminal = {
    ...expected,
    running: false,
    hostPid: 0,
    exitCode: 1,
    finishedAt: new Date(Date.now() - 1000).toISOString(),
  };
  return {
    root,
    metadata,
    record,
    expected,
    config,
    intentPath,
    metadataPath,
    write,
    run: () =>
      observeFailedSupervisorStart({
        config,
        registryRoot,
        record,
        expected,
        inspect: async () => structuredClone(terminal),
      }),
    patch: (p) => {
      terminal = { ...terminal, ...p };
    },
  };
}
test("original private start intent plus exact terminated birth and absent kernel objects proves only inert failure", async (t) => {
  const f = await fixture(t),
    actual = await f.run();
  assert.equal(actual.failedStartInert, true);
  assert.equal(actual.normalExit, false);
  assert.equal(actual.terminationDispatched, false);
  assert.equal(
    actual.failedStartProof.originalResultDigest,
    digest(f.expected),
  );
  assert.equal(actual.failedStartProof.kernelInert, true);
  assert.deepEqual((await f.run()).failedStartProof, actual.failedStartProof);
});
test("Supervisor proof rejects changed durable original, unknown, restart, OOM and every other role", async (t) => {
  for (const kind of [
    "unknown",
    "oom",
    "restart",
    "birth",
    "intent",
    "metadata",
    "role",
    "path",
  ]) {
    const f = await fixture(t);
    if (kind === "unknown") f.patch({ running: true, hostPid: 123 });
    if (kind === "oom") f.patch({ oomKilled: true });
    if (kind === "restart") f.patch({ restartCount: 1 });
    if (kind === "birth") f.patch({ startedAt: new Date().toISOString() });
    if (kind === "intent")
      await fs.writeFile(
        f.intentPath,
        JSON.stringify({ state: "executing", record: f.metadata }),
      );
    if (kind === "metadata")
      await fs.writeFile(
        f.metadataPath,
        JSON.stringify({ ...f.metadata, birthTicks: "different" }),
      );
    if (kind === "role") f.record.kind = "control-entry";
    if (kind === "path") {
      delete f.metadata.cgroupPath;
      await f.write();
    }
    await assert.rejects(f.run(), {
      code: "CONTROL_MIGRATION_FAILED_SUPERVISOR_UNPROVEN",
    });
  }
});
test("an existing cgroup requires complete empty process/thread/populated evidence; live original PID cannot be ignored", async (t) => {
  for (const kind of ["empty", "populated", "missing-child", "pid"]) {
    const f = await fixture(t),
      group = join(f.config.cgroupRoot, f.metadata.cgroupPath);
    await fs.mkdir(group, { recursive: true });
    await fs.writeFile(join(group, "cgroup.procs"), "");
    await fs.writeFile(join(group, "cgroup.threads"), "");
    await fs.writeFile(
      join(group, "cgroup.events"),
      kind === "populated" ? "populated 1\n" : "populated 0\n",
    );
    if (kind === "missing-child")
      await fs.unlink(join(group, "cgroup.threads"));
    if (kind === "pid") {
      const p = join(f.config.procRoot, "123");
      await fs.mkdir(p);
      const fields = Array(25).fill("0");
      fields[19] = "12345";
      await fs.writeFile(
        join(p, "stat"),
        "123 (old process) " + fields.join(" "),
      );
      await fs.writeFile(
        join(p, "cgroup"),
        "0::" + f.metadata.cgroupPath + "\n",
      );
    }
    if (kind === "empty") assert.equal((await f.run()).failedStartInert, true);
    else await assert.rejects(f.run());
  }
});
