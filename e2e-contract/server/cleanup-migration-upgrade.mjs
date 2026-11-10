import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { digest, invariant } from "../../deploy/upgrade/trust.mjs";
import { atomicJson } from "../../deploy/upgrade/io.mjs";

/** Test-only explicit cleanup after all original tasks were cancelled and their
 * sandbox deleted through the product API. No force, removal, pruning or SDK
 * traversal is permitted. Failed scenarios keep every original resource. */
export async function cleanupMigrationUpgrade(input, h, prepared) {
  const Database = createRequire(
      join(input.target.artifactRoot, "api/apps/api/package.json"),
    )("better-sqlite3"),
    business = new Database(h.businessDatabasePath, {
      readonly: true,
      fileMustExist: true,
    });
  try {
    invariant(
      business.prepare("SELECT count(*) n FROM sandboxes").get().n === 0,
      "MIGRATION_NATIVE_CLEANUP_USER_RESOURCES_REMAIN",
    );
  } finally {
    business.close();
  }
  const migration = new Database(join(prepared.paths.journal, "migration.db"), {
    readonly: true,
    fileMustExist: true,
  });
  let data;
  try {
    data = JSON.parse(
      migration
        .prepare("SELECT data FROM control_migration_run WHERE singleton=1")
        .get().data,
    );
  } finally {
    migration.close();
  }
  const records = new Map(),
    add = (r) => {
      if (!r?.containerId) return;
      const id = r.containerId,
        prior = records.get(id);
      invariant(
        /^[a-f0-9]{64}$/.test(id) &&
          r.startIdentity &&
          r.artifactDigest &&
          r.startedAt,
        "MIGRATION_NATIVE_CLEANUP_RECORD_UNKNOWN",
      );
      if (prior)
        invariant(
          ["startIdentity", "artifactDigest", "startedAt"].every(
            (k) => prior[k] === r[k],
          ),
          "MIGRATION_NATIVE_CLEANUP_RECORD_CONFLICT",
        );
      records.set(id, r);
    };
  Object.values(h.roles).forEach(add);
  for (const name of [
    "agent",
    "api",
    "coordinator",
    "entryProcess",
    "supervisorProcess",
  ])
    add(data[name]);
  const files = await fs.readdir(join(h.paths.installer, "processes"), {
    withFileTypes: true,
  });
  invariant(files.length <= 4096, "MIGRATION_NATIVE_CLEANUP_RECORD_LIMIT");
  for (const file of files.filter((f) =>
    /-(api|web|coordinator|owner|installer)\.json$/.test(f.name),
  )) {
    invariant(
      file.isFile() && !file.isSymbolicLink(),
      "MIGRATION_NATIVE_CLEANUP_RECORD_UNKNOWN",
    );
    const r = JSON.parse(
      await fs.readFile(
        join(h.paths.installer, "processes", file.name),
        "utf8",
      ),
    );
    invariant(
      r.instanceId === input.instanceId,
      "MIGRATION_NATIVE_CLEANUP_FOREIGN_RECORD",
    );
    add(r);
  }
  const stopped = [];
  for (const r of [...records.values()].sort(
    (a, b) =>
      Number((a.role ?? a.kind) === "owner") -
      Number((b.role ?? b.kind) === "owner"),
  )) {
    const read = async () =>
        JSON.parse(await h.docker(["inspect", r.containerId]))[0],
      before = await read(),
      valid = (p) =>
        p.Id === r.containerId &&
        p.Config.Labels["agent-platform.instance"] === input.instanceId &&
        p.Config.Labels["agent-platform.installation"] === digest(input.root) &&
        p.Config.Labels["agent-platform.start"] === r.startIdentity &&
        p.Config.Labels["agent-platform.artifact"] === r.artifactDigest &&
        p.State.StartedAt === r.startedAt &&
        p.State.Paused === false &&
        p.HostConfig.RestartPolicy.Name === "no" &&
        p.RestartCount === 0;
    invariant(valid(before), "MIGRATION_NATIVE_CLEANUP_PHYSICAL_CHANGED");
    if (before.State.Running)
      await h.docker(["kill", "--signal", "SIGTERM", r.containerId]);
    const deadline = Date.now() + 5000;
    let after = await read();
    while (after.State.Running && Date.now() < deadline) {
      await new Promise((ok) => setTimeout(ok, 50));
      after = await read();
    }
    invariant(
      valid(after) &&
        after.State.Running === false &&
        after.State.Pid === 0 &&
        after.State.OOMKilled === false &&
        [0, 143].includes(after.State.ExitCode),
      "MIGRATION_NATIVE_CLEANUP_NORMAL_EXIT_UNKNOWN",
    );
    stopped.push({
      containerId: r.containerId,
      startIdentity: r.startIdentity,
      artifactDigest: r.artifactDigest,
      startedAt: r.startedAt,
      finishedAt: after.State.FinishedAt,
      exitCode: after.State.ExitCode,
      signal: before.State.Running ? "SIGTERM" : null,
      forced: false,
      removed: false,
    });
  }
  const facts = {
    schemaVersion: 1,
    instanceId: input.instanceId,
    kind: "migration-native-cleanup",
    stopped,
    volumesRemoved: false,
  };
  await atomicJson(join(input.root, "migration-native-cleanup.json"), {
    ...facts,
    receiptDigest: digest(facts),
  });
  return { stopped: stopped.length, removed: false };
}
