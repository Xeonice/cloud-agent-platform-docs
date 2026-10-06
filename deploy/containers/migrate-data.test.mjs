import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { spawn, spawnSync } from "node:child_process";
import { parseEnv } from "node:util";
import {
  prepareData,
  verifyDataStage,
  remapDatabase,
  remapDataPath,
  containerEnvironment,
  importArguments,
  validateDataVolume,
  RUNTIME_HOST,
  EMPTY_DATA_GUARD,
  pipeArchive,
} from "./migrate-data.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), "platform-data-migration-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceRoot = join(root, "native"),
    stagingRoot = join(root, "staging"),
    runtimeEnv = join(root, "runtime.env");
  await fs.mkdir(sourceRoot, { mode: 0o700 });
  await fs.mkdir(stagingRoot, { mode: 0o700 });
  await fs.mkdir(join(sourceRoot, "baselines"), { mode: 0o700 });
  await fs.mkdir(join(sourceRoot, "baselines", "project"), { mode: 0o700 });
  await fs.writeFile(
    join(sourceRoot, "baselines", "project", "README.md"),
    "project baseline\n",
    { mode: 0o644 },
  );
  await fs.writeFile(
    join(sourceRoot, "baselines", "project", "run.sh"),
    "#!/bin/sh\necho baseline\n",
    { mode: 0o755 },
  );
  await fs.mkdir(join(sourceRoot, "workspaces"), { mode: 0o700 });
  await fs.writeFile(
    runtimeEnv,
    `DATA_ROOT=${sourceRoot}\nDATABASE_URL=${sourceRoot}/platform.db\nBOXLITE_HOME=${sourceRoot}/boxlite\nACCESS_PASSCODE=private-fixture-only\nPORT=3101\n`,
    { mode: 0o600 },
  );
  const writer = new DatabaseSync(join(sourceRoot, "platform.db"));
  writer.exec(
    "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE projects(id TEXT PRIMARY KEY, baseline_path TEXT); CREATE TABLE credentials(id TEXT PRIMARY KEY, encrypted_blob TEXT); CREATE TABLE agent_tasks(id TEXT PRIMARY KEY, log_path TEXT); CREATE TABLE audit_events(id INTEGER PRIMARY KEY, summary TEXT); CREATE TABLE image_manifests(id TEXT PRIMARY KEY, image_config TEXT)",
  );
  writer
    .prepare("INSERT INTO projects VALUES(?,?)")
    .run("p1", join(sourceRoot, "baselines", "project"));
  writer
    .prepare("INSERT INTO audit_events(summary) VALUES(?)")
    .run("committed-only-in-WAL");
  await fs.chmod(join(sourceRoot, "platform.db"), 0o600);
  t.after(() => writer.close());
  return { sourceRoot, stagingRoot, runtimeEnv, writer };
}
test("online readonly backup includes committed WAL and preserves native files while only the copy paths change", async (t) => {
  const f = await fixture(t);
  const mainBefore = hash(await fs.readFile(join(f.sourceRoot, "platform.db")));
  const walBefore = hash(
    await fs.readFile(join(f.sourceRoot, "platform.db-wal")),
  );
  const result = await prepareData(f);
  const copy = new DatabaseSync(join(result.stage, "data", "platform.db"), {
    readOnly: true,
  });
  assert.equal(
    copy.prepare("SELECT summary FROM audit_events").get().summary,
    "committed-only-in-WAL",
  );
  assert.equal(
    copy.prepare("SELECT baseline_path FROM projects").get().baseline_path,
    "/data/baselines/project",
  );
  assert.equal(
    copy.prepare("PRAGMA integrity_check").get().integrity_check,
    "ok",
  );
  copy.close();
  assert.equal(
    f.writer.prepare("SELECT baseline_path FROM projects").get().baseline_path,
    join(f.sourceRoot, "baselines", "project"),
  );
  assert.equal(
    hash(await fs.readFile(join(f.sourceRoot, "platform.db"))),
    mainBefore,
  );
  assert.equal(
    hash(await fs.readFile(join(f.sourceRoot, "platform.db-wal"))),
    walBefore,
  );
  assert.deepEqual(
    result.manifest.backupCounts,
    result.manifest.migratedCounts,
  );
  assert.equal(result.manifest.boxliteHomeCopied, false);
  assert.equal(
    await fs.readFile(
      join(result.stage, "data/baselines/project/README.md"),
      "utf8",
    ),
    "project baseline\n",
  );
  assert.equal(
    (await fs.stat(join(result.stage, "data/baselines/project/run.sh"))).mode &
      0o777,
    0o700,
  );
  assert.equal(
    (await fs.stat(join(result.stage, "data/baselines/project/README.md")))
      .mode & 0o777,
    0o600,
  );
  await verifyDataStage(result.stage, result.manifestSha256);
});
test("file master key and private runtime secrets retain exact bytes without entering evidence", async (t) => {
  const f = await fixture(t);
  const key = Buffer.alloc(32, 0xab);
  await fs.writeFile(join(f.sourceRoot, ".master.key"), key, { mode: 0o600 });
  f.writer
    .prepare("INSERT INTO credentials VALUES(?,?)")
    .run("c1", "ciphertext-only-fixture");
  const result = await prepareData(f);
  assert.deepEqual(
    await fs.readFile(join(result.stage, "data/.master.key")),
    key,
  );
  assert.equal(
    (await fs.stat(join(result.stage, "data/.master.key"))).mode & 0o777,
    0o600,
  );
  const environment = await fs.readFile(
    join(result.stage, "runtime.env"),
    "utf8",
  );
  assert.ok(environment.includes("ACCESS_PASSCODE=private-fixture-only"));
  assert.ok(environment.includes("BOXLITE_HOME=/data/boxlite"));
  assert.equal(
    JSON.stringify(result.manifest).includes("private-fixture-only"),
    false,
  );
  assert.equal(
    JSON.stringify(result.manifest).includes(key.toString("base64")),
    false,
  );
  assert.equal(result.manifest.masterKey, "file-preserved");
});
test("environment master key is preserved, and missing key refuses encrypted records", async (t) => {
  const f = await fixture(t);
  f.writer
    .prepare("INSERT INTO credentials VALUES(?,?)")
    .run("c1", "ciphertext-only-fixture");
  await assert.rejects(prepareData(f), /without their master key/);
  const key = Buffer.alloc(32, 0x42).toString("base64");
  await fs.appendFile(f.runtimeEnv, `PLATFORM_MASTER_KEY=${key}\n`);
  const result = await prepareData(f);
  assert.equal(result.manifest.masterKey, "environment-preserved");
  assert.ok(
    (await fs.readFile(join(result.stage, "runtime.env"), "utf8")).includes(
      key,
    ),
  );
  assert.equal(JSON.stringify(result.manifest).includes(key), false);
});
test("encrypted image settings require the same master key even with an empty credential vault", async (t) => {
  const f = await fixture(t);
  f.writer.prepare("INSERT INTO image_manifests VALUES(?,?)").run(
    "img",
    JSON.stringify({
      env: [{ key: "EXAMPLE", secret: true, value: "ciphertext" }],
    }),
  );
  await assert.rejects(prepareData(f), /without their master key/);
});
test("path migration rolls back every earlier update on an outside or noncanonical stored path", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE projects(baseline_path TEXT); CREATE TABLE agent_tasks(log_path TEXT)",
  );
  db.prepare("INSERT INTO projects VALUES(?)").run("/native/baselines/project");
  db.prepare("INSERT INTO agent_tasks VALUES(?)").run("/elsewhere/log.txt");
  assert.throws(() => remapDatabase(db, "/native"), /outside/);
  assert.equal(
    db.prepare("SELECT baseline_path FROM projects").get().baseline_path,
    "/native/baselines/project",
  );
  assert.throws(
    () => remapDataPath("/native/a/../secret", "/native"),
    /canonical/,
  );
  assert.throws(
    () => remapDataPath("/native-other/file", "/native"),
    /outside/,
  );
  db.close();
});
test("referenced immutable task logs are copied and remapped without copying the active runtime log", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(join(f.sourceRoot, "logs"), { mode: 0o700 });
  await fs.writeFile(
    join(f.sourceRoot, "logs/task.log"),
    "completed output\n",
    { mode: 0o600 },
  );
  await fs.writeFile(
    join(f.sourceRoot, "logs/runtime.log"),
    "active runtime\n",
    { mode: 0o600 },
  );
  f.writer
    .prepare("INSERT INTO agent_tasks VALUES(?,?)")
    .run("t1", join(f.sourceRoot, "logs/task.log"));
  const result = await prepareData(f);
  assert.equal(
    await fs.readFile(join(result.stage, "data/logs/task.log"), "utf8"),
    "completed output\n",
  );
  await assert.rejects(fs.stat(join(result.stage, "data/logs/runtime.log")), {
    code: "ENOENT",
  });
});
test("baseline symlinks and hardlinks refuse staging rather than copy data outside its owner tree", async (t) => {
  const f = await fixture(t);
  const link = join(f.sourceRoot, "baselines/project/external");
  await fs.symlink(f.runtimeEnv, link);
  await assert.rejects(prepareData(f), /symbolic link/);
  await fs.unlink(link);
  await fs.link(f.runtimeEnv, link);
  await assert.rejects(prepareData(f), /links/);
});
test("log parent symlinks cannot bypass the source data-root boundary", async (t) => {
  const f = await fixture(t);
  await fs.symlink(f.stagingRoot, join(f.sourceRoot, "logs"));
  await fs.writeFile(join(f.stagingRoot, "task.log"), "outside\n", {
    mode: 0o600,
  });
  f.writer
    .prepare("INSERT INTO agent_tasks VALUES(?,?)")
    .run("t1", join(f.sourceRoot, "logs/task.log"));
  await assert.rejects(prepareData(f), /directory ownership or type/);
});
test("a project baseline missing from the copied tree cannot become a ready migration stage", async (t) => {
  const f = await fixture(t);
  f.writer
    .prepare("UPDATE projects SET baseline_path=?")
    .run(join(f.sourceRoot, "baselines", "missing"));
  await assert.rejects(prepareData(f), { code: "ENOENT" });
});
test("manifest, copied baseline, secret or extra-file tampering is refused before named-volume import", async (t) => {
  const f = await fixture(t);
  const a = await prepareData(f);
  await fs.appendFile(
    join(a.stage, "data/baselines/project/README.md"),
    "tampered",
  );
  await assert.rejects(
    verifyDataStage(a.stage, a.manifestSha256),
    /staging files/,
  );
  const b = await prepareData(f);
  await fs.appendFile(join(b.stage, "runtime.env"), "EXTRA=changed\n");
  await assert.rejects(
    verifyDataStage(b.stage, b.manifestSha256),
    /environment digest/,
  );
  const c = await prepareData(f);
  await fs.writeFile(join(c.stage, "data/extra"), "extra");
  await assert.rejects(
    verifyDataStage(c.stage, c.manifestSha256),
    /staging files/,
  );
  await assert.rejects(
    verifyDataStage(c.stage, "f".repeat(64)),
    /manifest digest/,
  );
});
test("private source/environment permissions and incorrect native environment roots fail closed", async (t) => {
  const f = await fixture(t);
  await fs.chmod(f.runtimeEnv, 0o644);
  await assert.rejects(prepareData(f), /private permissions/);
  await fs.chmod(f.runtimeEnv, 0o600);
  assert.throws(
    () => containerEnvironment("DATA_ROOT=/other", f.sourceRoot),
    /configuration differs/,
  );
  await fs.chmod(f.stagingRoot, 0o777);
  await assert.rejects(prepareData(f), /directory ownership/);
});
test("container environment maps the native maintenance path, drops Mac capacity overrides, and preserves auth and explicit scheduler policy", async (t) => {
  const f = await fixture(t);
  const additions =
    "export DEPLOYMENT_DRAIN_FILE=/Users/operator/private/maintenance\nSCHEDULER_HOST_CORES=8\nSCHEDULER_HOST_RAM_MB=32768\nSCHEDULER_HOST_DISK_MB=131072\nSCHEDULER_CPU_OVERCOMMIT=1\nSANDBOX_RECONCILE_ON_BOOT=true\nPASSCODE_COOKIE_SECRET='fixture cookie secret'\nPLATFORM_MASTER_KEY='" +
    Buffer.alloc(32, 0x42).toString("base64") +
    "'\n";
  await fs.appendFile(f.runtimeEnv, additions);
  const source = await fs.readFile(f.runtimeEnv, "utf8"),
    before = parseEnv(source),
    result = await prepareData(f);
  const derived = await fs.readFile(join(result.stage, "runtime.env"), "utf8"),
    after = parseEnv(derived);
  assert.equal(after.DEPLOYMENT_DRAIN_FILE, "/data/deployment-drain");
  for (const key of [
    "SCHEDULER_HOST_CORES",
    "SCHEDULER_HOST_RAM_MB",
    "SCHEDULER_HOST_DISK_MB",
  ])
    assert.equal(Object.hasOwn(after, key), false, key);
  for (const key of [
    "ACCESS_PASSCODE",
    "PASSCODE_COOKIE_SECRET",
    "PLATFORM_MASTER_KEY",
    "SANDBOX_RECONCILE_ON_BOOT",
    "SCHEDULER_CPU_OVERCOMMIT",
  ])
    assert.equal(after[key] === before[key], true, key);
  assert.equal((await fs.readFile(f.runtimeEnv, "utf8")) === source, true);
  assert.equal(result.manifest.runtimeEnvironment.schemaVersion, 2);
  assert.equal(derived.includes("/Users/operator/private/maintenance"), false);
  await verifyDataStage(result.stage, result.manifestSha256);
});
test("multiline quoted credentials keep literal assignment-like lines rather than being interpreted as migration keys", async (t) => {
  const f = await fixture(t);
  const source =
    (await fs.readFile(f.runtimeEnv, "utf8")) +
    "PASSCODE_COOKIE_SECRET='fixture first line\nDEPLOYMENT_DRAIN_FILE=inside-a-secret\nSCHEDULER_HOST_CORES=also-inside-secret\nlast line'\nDEPLOYMENT_DRAIN_FILE=/native/maintenance\n";
  const before = parseEnv(source),
    after = parseEnv(containerEnvironment(source, f.sourceRoot));
  assert.equal(
    after.PASSCODE_COOKIE_SECRET === before.PASSCODE_COOKIE_SECRET,
    true,
  );
  assert.equal(after.DEPLOYMENT_DRAIN_FILE, "/data/deployment-drain");
  assert.equal(Object.hasOwn(after, "SCHEDULER_HOST_CORES"), false);
});
test("import is an immutable image, fixed daemon, empty-volume tar helper with no host/data/socket binds", () => {
  const args = importArguments(
    "sha256:" + "a".repeat(64),
    "migration-test-12345678",
  );
  assert.equal(args[args.indexOf("--host") + 1], RUNTIME_HOST);
  assert.equal(args[args.indexOf("--network") + 1], "none");
  assert.equal(args[args.indexOf("--user") + 1], "0:0");
  assert.equal(
    args[args.indexOf("--mount") + 1],
    "type=volume,src=migration-test-12345678,dst=/data",
  );
  assert.ok(args.at(-1).includes(EMPTY_DATA_GUARD));
  assert.equal(
    args.some(
      (value) => value.includes("type=bind") || value.includes("docker.sock,"),
    ),
    false,
  );
  assert.throws(() => importArguments("image:latest"), /immutable/);
  assert.throws(
    () =>
      importArguments(
        "sha256:" + "a".repeat(64),
        "agent-platform-jenkins-home",
      ),
    /Unexpected/,
  );
});
test("the real shell empty-volume guard requires no find/ls and refuses visible, hidden and dangling-link entries", async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), "migration-empty-volume-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const check = () =>
    spawnSync(
      "/bin/sh",
      ["-ec", 'data_root="$1"; ' + EMPTY_DATA_GUARD, "migration-guard", root],
      {
        env: { PATH: "/nonexistent" },
        encoding: "utf8",
      },
    );
  assert.equal(check().status, 0);
  for (const name of ["platform.db", ".master.key"]) {
    await fs.writeFile(join(root, name), "fixture");
    assert.equal(check().status, 41);
    await fs.unlink(join(root, name));
  }
  await fs.symlink("missing-file", join(root, "dangling"));
  assert.equal(check().status, 41);
});
test("volume inspection refuses host-backed drivers/options and unrelated/shared names", () => {
  const name = "migration-test-12345678";
  const valid = {
    Name: name,
    Driver: "local",
    Scope: "local",
    Options: null,
    Mountpoint: `/var/lib/docker/volumes/${name}/_data`,
  };
  validateDataVolume(valid, name);
  for (const change of [
    { Driver: "nfs" },
    { Options: { type: "none", device: "/Users/douglasdong", o: "bind" } },
    { Name: "agent-platform-jenkins-home" },
    { Mountpoint: "/host/private" },
  ])
    assert.throws(
      () => validateDataVolume({ ...valid, ...change }, name),
      /host-backed/,
    );
});
test("a rejecting import consumer drains the real producer pipe so a nonempty-volume refusal cannot hang", async (t) => {
  const producer = spawn(
    process.execPath,
    ["-e", "process.stdout.write(Buffer.alloc(4*1024*1024,1))"],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  const consumer = spawn(process.execPath, ["-e", "process.exit(41)"], {
    stdio: ["pipe", "ignore", "ignore"],
  });
  t.after(() => {
    if (producer.exitCode === null) producer.kill("SIGTERM");
    if (consumer.exitCode === null) consumer.kill("SIGTERM");
  });
  pipeArchive(producer, consumer);
  const finished = (child) =>
    new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
  let timer;
  try {
    const result = await Promise.race([
      Promise.all([finished(producer), finished(consumer)]),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Import refusal blocked its producer")),
          3000,
        );
      }),
    ]);
    assert.deepEqual(result, [0, 41]);
  } finally {
    clearTimeout(timer);
  }
});
