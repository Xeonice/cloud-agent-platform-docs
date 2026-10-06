import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  SOURCE_HOME,
  MIGRATION_ROOT,
  ARCHIVE_NAME,
  archiveHome,
  assertJenkinsStopped,
  createExportPlan,
  exportPlanDirectory,
  snapshotEntries,
  validateExportPlan,
  validateInternalLink,
  validateRelativeEntry,
  validateSourceIdentity,
} from "./export-jenkins-home.mjs";

const id = "a8d428d7-bf49-4442-af9c-5f6e24d3d5eb";
const sourceIdentity = { dev: 1, ino: 23, uid: 400, gid: 20, mode: 0o700 };
const uid = process.getuid();

async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), "jenkins-export-test-"));
  const source = join(root, "home");
  const destination = join(root, "export");
  await fs.mkdir(source, { mode: 0o700 });
  await fs.mkdir(destination, { mode: 0o700 });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, source, destination };
}

test("prepared export binds the fixed Home and inode rather than accepting an arbitrary privileged source", () => {
  const plan = createExportPlan(sourceIdentity, id);
  assert.equal(plan.source.fixedHome, SOURCE_HOME);
  assert.equal(plan.destination, join(MIGRATION_ROOT, id));
  const path = join(plan.destination, "plan.json");
  assert.equal(exportPlanDirectory(path), plan.destination);
  for (const path of [
    join(plan.destination, "extra/plan.json"),
    "/tmp/plan.json",
    join(plan.destination, "../plan.json"),
  ]) {
    assert.throws(() => exportPlanDirectory(path), /fixed migration plan/);
  }
  assert.deepEqual(validateExportPlan(plan, path, sourceIdentity), plan);
  for (const changed of [
    { ...plan, source: { ...plan.source, fixedHome: "/Users/other" } },
    { ...plan, destination: "/tmp/export" },
    { ...plan, destinationUid: 0 },
    { ...plan, archiveBasename: "../credentials" },
    { ...plan, arbitrary: true },
  ])
    assert.throws(
      () => validateExportPlan(changed, path, sourceIdentity),
      /plan paths or source identity/,
    );
  assert.throws(
    () => validateExportPlan(plan, path, { ...sourceIdentity, ino: 24 }),
    /identity changed/,
  );
});

test("source account identity is fixed and unsafe root identities fail closed", () => {
  for (const change of [
    { uid: 0 },
    { uid: 501 },
    { gid: 0 },
    { mode: 0o755 },
    { ino: -1 },
    { dev: NaN },
  ]) {
    assert.throws(
      () => validateSourceIdentity({ ...sourceIdentity, ...change }),
      /UID 400/,
    );
  }
});

test("archive entry names and internal build links remain confined to the Home", () => {
  assert.equal(
    validateRelativeEntry("jobs/中文/builds/1/build.xml"),
    "jobs/中文/builds/1/build.xml",
  );
  assert.equal(
    validateInternalLink("jobs/job/lastSuccessfulBuild", "builds/1"),
    "builds/1",
  );
  assert.equal(
    validateInternalLink("jobs/job/builds/latest", "../builds/1"),
    "../builds/1",
  );
  for (const path of [
    "/etc/passwd",
    "jobs/../secrets",
    "a//b",
    "a\\b",
    "x\0y",
    "",
  ])
    assert.throws(() => validateRelativeEntry(path), /Unsafe/);
  for (const link of [
    "/Users/other/key",
    "../../outside",
    "x\0y",
    "C:\\key",
    "",
  ])
    assert.throws(
      () => validateInternalLink("alias", link),
      /unsafe symbolic link/,
    );
});

test("real standard tar preserves configuration, historical artifacts and master keys in a private archive", async (t) => {
  const { source, destination } = await fixture(t);
  for (const dir of [
    "secrets",
    "plugins",
    "jobs",
    "jobs/example",
    "jobs/example/builds",
    "jobs/example/builds/1",
  ])
    await fs.mkdir(join(source, dir), { mode: 0o700 });
  const values = {
    "config.xml": "<jenkins/>\n",
    "secrets/master.key": "fixture-secret-value-kept-private\n",
    "secrets/hudson.util.Secret": "fixture-encrypted-material\n",
    "plugins/example.jpi": "fixture-plugin-bits\n",
    "jobs/example/builds/1/build.xml": "<build number='1'/>\n",
  };
  for (const [path, content] of Object.entries(values))
    await fs.writeFile(join(source, path), content, { mode: 0o600 });
  await fs.symlink(
    "builds/1",
    join(source, "jobs/example/lastSuccessfulBuild"),
  );
  const before = await snapshotEntries(source, uid);
  const manifest = await archiveHome(source, destination);
  assert.equal(manifest.version, 1);
  assert.deepEqual(manifest.entries, before);
  assert.equal(manifest.archive.basename, ARCHIVE_NAME);
  const archive = await fs.readFile(join(destination, ARCHIVE_NAME));
  assert.equal(
    manifest.archive.sha256,
    createHash("sha256").update(archive).digest("hex"),
  );
  assert.equal(manifest.archive.sizeBytes, archive.length);
  for (const name of [ARCHIVE_NAME, "manifest.json"]) {
    const stat = await fs.lstat(join(destination, name));
    assert.equal(stat.uid, uid);
    assert.equal(stat.mode & 0o777, 0o600);
    assert.equal(stat.nlink, 1);
  }
  const list = spawnSync(
    "/usr/bin/tar",
    ["-tf", join(destination, ARCHIVE_NAME)],
    { encoding: "utf8" },
  );
  assert.equal(list.status, 0);
  assert.match(list.stdout, /\.\/secrets\/master\.key/);
  assert.match(list.stdout, /\.\/jobs\/example\/builds\/1\/build\.xml/);
  const contents = spawnSync(
    "/usr/bin/tar",
    ["-xOf", join(destination, ARCHIVE_NAME), "./secrets/master.key"],
    { encoding: "utf8" },
  );
  assert.equal(contents.status, 0);
  assert.equal(contents.stdout, values["secrets/master.key"]);
  assert.equal(
    JSON.stringify(manifest).includes("fixture-secret-value-kept-private"),
    false,
  );
  assert.deepEqual(await snapshotEntries(source, uid), before);
});

test("a symbolic link to another Home is rejected before tar runs and its destination is never archived", async (t) => {
  const { root, source, destination } = await fixture(t);
  await fs.writeFile(join(root, "outside-secret"), "must-not-be-read", {
    mode: 0o600,
  });
  await fs.symlink("../outside-secret", join(source, "escape"));
  let runs = 0;
  await assert.rejects(
    archiveHome(source, destination, {
      tar: async () => {
        runs++;
      },
    }),
    /unsafe symbolic link/,
  );
  assert.equal(runs, 0);
  assert.deepEqual(await fs.readdir(destination), []);
});

test("hard-linked files are rejected before export rather than importing an outside inode alias", async (t) => {
  const { root, source, destination } = await fixture(t);
  await fs.writeFile(join(root, "outside"), "fixture", { mode: 0o600 });
  await fs.link(join(root, "outside"), join(source, "hard-link"));
  await assert.rejects(archiveHome(source, destination), /hard link/);
  assert.deepEqual(await fs.readdir(destination), []);
});

test("source mutation during tar discards the partial archive and produces no completed manifest", async (t) => {
  const { source, destination } = await fixture(t);
  await fs.writeFile(join(source, "config.xml"), "before", { mode: 0o600 });
  await assert.rejects(
    archiveHome(source, destination, {
      tar: async (_path, fd) => {
        assert.equal(typeof fd, "number");
        await fs.writeFile(
          join(source, "config.xml"),
          "changed-size-after-snapshot",
          { mode: 0o600 },
        );
      },
    }),
    /changed during export/,
  );
  assert.deepEqual(await fs.readdir(destination), []);
});

test("existing exports and permissive output directories cannot be overwritten or used", async (t) => {
  const { source, destination } = await fixture(t);
  await fs.writeFile(join(destination, ARCHIVE_NAME), "existing-proof", {
    mode: 0o600,
  });
  await assert.rejects(archiveHome(source, destination), /never overwrite/);
  assert.equal(
    await fs.readFile(join(destination, ARCHIVE_NAME), "utf8"),
    "existing-proof",
  );
  await fs.rm(join(destination, ARCHIVE_NAME));
  await fs.chmod(destination, 0o755);
  await assert.rejects(
    archiveHome(source, destination),
    /owner-only directory/,
  );
});

test("standard tar failure removes the private partial output", async (t) => {
  const { source, destination } = await fixture(t);
  await assert.rejects(
    archiveHome(source, destination, {
      tar: async () => {
        throw new Error("fixture tar failure");
      },
    }),
    /fixture tar failure/,
  );
  assert.deepEqual(await fs.readdir(destination), []);
});

test("a competing final archive created during export is preserved, including symlink targets", async (t) => {
  const { root, source, destination } = await fixture(t);
  const outside = join(root, "unrelated-file");
  await fs.writeFile(outside, "must-remain-unchanged", { mode: 0o600 });
  await assert.rejects(
    archiveHome(source, destination, {
      tar: async () => {
        await fs.symlink(outside, join(destination, ARCHIVE_NAME));
      },
    }),
    (error) => error.code === "EEXIST",
  );
  assert.equal(await fs.readFile(outside, "utf8"), "must-remain-unchanged");
  assert.equal(await fs.readlink(join(destination, ARCHIVE_NAME)), outside);
  assert.deepEqual(await fs.readdir(destination), [ARCHIVE_NAME]);
});

test("wrong source ownership and writable files fail before archive creation", async (t) => {
  const { source, destination } = await fixture(t);
  await assert.rejects(
    archiveHome(source, destination, { sourceUid: uid + 1 }),
    /entry ownership/,
  );
  await fs.writeFile(join(source, "config.xml"), "fixture", { mode: 0o600 });
  await fs.chmod(join(source, "config.xml"), 0o666);
  await assert.rejects(
    archiveHome(source, destination),
    /writable permissions/,
  );
  assert.deepEqual(await fs.readdir(destination), []);
});

test("loaded Jenkins, account processes and unknown service observations prohibit export", () => {
  const observation =
    (launch, processes = { status: 0, stdout: "  501 123\n    0 1\n" }) =>
    (command) =>
      command === "/bin/ps" ? processes : launch;
  assert.doesNotThrow(() => assertJenkinsStopped(observation({ status: 113 })));
  assert.doesNotThrow(() =>
    assertJenkinsStopped(
      observation(
        { status: 113 },
        { status: 0, stdout: "-2 854\n-2 5510\n0 1\n501 123\n" },
      ),
    ),
  );
  for (const stdout of [
    "-2 unknown",
    "-2 -1",
    "501 0",
    "999999999999999999999 1",
  ]) {
    assert.throws(
      () =>
        assertJenkinsStopped(
          observation({ status: 113 }, { status: 0, stdout }),
        ),
      /account is idle/,
    );
  }
  for (const launch of [
    { status: 0 },
    { status: 1 },
    { status: null },
    { status: 113, error: new Error("fixture") },
    { status: 113, signal: "SIGTERM" },
  ]) {
    assert.throws(
      () => assertJenkinsStopped(observation(launch)),
      /Stop Jenkins|whether the Jenkins/,
    );
  }
  assert.throws(
    () =>
      assertJenkinsStopped(
        observation({ status: 113 }, { status: 0, stdout: "400 888\n" }),
      ),
    /dedicated Jenkins processes/,
  );
  assert.throws(
    () =>
      assertJenkinsStopped(
        observation({ status: 113 }, { status: 0, stdout: "unknown" }),
      ),
    /account is idle/,
  );
});
