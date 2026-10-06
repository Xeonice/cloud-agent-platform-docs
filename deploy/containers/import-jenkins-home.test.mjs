import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { archiveHome } from "./export-jenkins-home.mjs";
import { MIGRATION_EXCLUSIONS } from "./controller.mjs";
import {
  HOME_VOLUME,
  importVolume,
  inspectBuildRecord,
  inspectSecurityConfiguration,
  matchArchiveEntries,
  normalizeArchivePath,
  parseTarListing,
  stageRetainedHome,
  validateImportImage,
  verifyExport,
} from "./import-jenkins-home.mjs";

const uid = process.getuid();
const image = `sha256:${"a".repeat(64)}`;
const containerId = "b".repeat(64);
const secureConfig = `<hudson><useSecurity>true</useSecurity><securityRealm class="hudson.security.HudsonPrivateSecurityRealm"/><authorizationStrategy class="hudson.security.FullControlOnceLoggedInAuthorizationStrategy"><denyAnonymousReadAccess>true</denyAnonymousReadAccess></authorizationStrategy></hudson>`;
const completed = `<flow-build><completed>true</completed><result>FAILURE</result></flow-build>`;

async function fixture(
  t,
  { config = secureConfig, build = completed, hudsonKey = false } = {},
) {
  const root = await fs.mkdtemp(join(tmpdir(), "jenkins-import-test-"));
  const source = join(root, "home");
  const destination = join(root, "export");
  const stage = join(root, "stage");
  for (const path of [source, destination, stage])
    await fs.mkdir(path, { mode: 0o700 });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const contents = {
    "config.xml": config,
    "users/admin/config.xml": "<user><id>fixture-admin</id></user>",
    "secrets/master.key": "private-fixture-master-key",
    "jobs/example/config.xml": "<flow-definition/>",
    "jobs/example/builds/1/build.xml": build,
    "jobs/example/builds/1/log": "historical-build-output",
    "identity.key.enc": "private-fixture-identity",
    "plugins/obsolete.jpi": "must-use-locked-image-plugins",
    "init.groovy": "old-untrusted-bootstrap",
    "init.groovy.d/old.groovy": "old-untrusted-bootstrap",
    "workspace/old/file": "old-workspace",
    "caches/old": "old-cache",
    "logs/old": "old-log",
    "container-state/old": "old-container-state",
    "queue.xml": "old-queued-work",
    "queue.xml.bak": "old-queued-work-backup",
  };
  if (hudsonKey)
    contents["secrets/hudson.util.Secret"] = "private-fixture-encryption-key";
  for (const [path, content] of Object.entries(contents)) {
    await fs.mkdir(join(source, path, ".."), { recursive: true, mode: 0o700 });
    await fs.writeFile(join(source, path), content, { mode: 0o600 });
  }
  await fs.symlink(
    "builds/1",
    join(source, "jobs/example/lastSuccessfulBuild"),
  );
  const manifest = await archiveHome(source, destination);
  const manifestPath = join(destination, "manifest.json");
  const options = { sourceHome: source, sourceUid: uid };
  return {
    root,
    source,
    destination,
    stage,
    contents,
    manifest,
    manifestPath,
    options,
  };
}

async function replaceTar(f, extraArgs = []) {
  const archive = join(f.destination, "jenkins-home.tar");
  await fs.rm(archive);
  const result = spawnSync(
    "/usr/bin/tar",
    ["-cf", archive, ...extraArgs, "-C", f.source, "."],
    { env: { PATH: "/usr/bin:/bin", COPYFILE_DISABLE: "1" } },
  );
  assert.equal(result.status, 0);
  await fs.chmod(archive, 0o600);
  const bytes = await fs.readFile(archive);
  f.manifest.archive.sha256 = createHash("sha256").update(bytes).digest("hex");
  f.manifest.archive.sizeBytes = bytes.length;
  await fs.writeFile(f.manifestPath, JSON.stringify(f.manifest));
}

test("actual standard tar is verified, staged and filtered while preserving authentication, keys and completed history bytes", async (t) => {
  const f = await fixture(t);
  const verified = await verifyExport(f.manifestPath, f.options);
  assert.equal(verified.security.resetAuthentication, false);
  assert.equal(verified.security.generatesKeys, false);
  assert.equal(verified.security.userRecords, 1);
  assert.deepEqual(verified.history, {
    records: 1,
    completedPipelineRuns: 1,
    results: { FAILURE: 1 },
  });
  const retained = await stageRetainedHome(verified, f.stage);
  for (const [path, contents] of Object.entries(f.contents)) {
    if (
      MIGRATION_EXCLUSIONS.some(
        (excluded) => path === excluded || path.startsWith(`${excluded}/`),
      )
    )
      await assert.rejects(fs.lstat(join(f.stage, path)), { code: "ENOENT" });
    else assert.equal(await fs.readFile(join(f.stage, path), "utf8"), contents);
  }
  assert.equal(
    await fs.readlink(join(f.stage, "jobs/example/lastSuccessfulBuild")),
    "builds/1",
  );
  await assert.rejects(fs.lstat(join(f.stage, "secrets/hudson.util.Secret")), {
    code: "ENOENT",
  });
  assert.ok(retained.some((entry) => entry.path === "secrets/master.key"));
  assert.equal(
    JSON.stringify(verified.manifest).includes("private-fixture-master-key"),
    false,
  );
  assert.equal(
    await fs.readFile(join(f.source, "plugins/obsolete.jpi"), "utf8"),
    f.contents["plugins/obsolete.jpi"],
  );
});

test("an existing lazily generated encryption key is preserved without requiring one to be manufactured", async (t) => {
  const f = await fixture(t, { hudsonKey: true });
  const v = await verifyExport(f.manifestPath, f.options);
  await stageRetainedHome(v, f.stage);
  assert.equal(
    await fs.readFile(join(f.stage, "secrets/hudson.util.Secret"), "utf8"),
    f.contents["secrets/hudson.util.Secret"],
  );
});

test("CLI source identity remains fixed even when a valid unrelated private export is presented", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    verifyExport(f.manifestPath),
    /reviewed Jenkins Home identity/,
  );
});

test("archive hash tampering is rejected before extracting any files", async (t) => {
  const f = await fixture(t);
  await fs.appendFile(join(f.destination, "jenkins-home.tar"), "altered");
  await assert.rejects(verifyExport(f.manifestPath, f.options), /hash or size/);
  assert.deepEqual(await fs.readdir(f.stage), []);
});

test("a recalculated digest cannot hide archive members omitted from manifest metadata", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(join(f.source, "unexpected"), "not-in-original-manifest", {
    mode: 0o600,
  });
  await replaceTar(f);
  await assert.rejects(
    verifyExport(f.manifestPath, f.options),
    /entries differ/,
  );
});

test("actual tar headers reject external symlinks even with an updated whole-archive digest", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(join(f.root, "outside"), "outside-never-extracted", {
    mode: 0o600,
  });
  await fs.symlink("../outside", join(f.source, "escape"));
  await replaceTar(f);
  await assert.rejects(
    verifyExport(f.manifestPath, f.options),
    /external or unsafe symbolic link/,
  );
  assert.deepEqual(await fs.readdir(f.stage), []);
});

test("actual hard-link tar members fail closed rather than restoring inode aliases", async (t) => {
  const f = await fixture(t);
  await fs.link(
    join(f.source, "secrets/master.key"),
    join(f.source, "key-alias"),
  );
  await replaceTar(f);
  await assert.rejects(
    verifyExport(f.manifestPath, f.options),
    /hard-linked|Hard-linked/,
  );
});

test("an actual tar containing an absolute member is rejected even when its digest is correct", async (t) => {
  const f = await fixture(t);
  const archive = join(f.destination, "jenkins-home.tar");
  await fs.rm(archive);
  const result = spawnSync(
    "/usr/bin/tar",
    ["-Pcf", archive, join(f.source, "config.xml")],
    { env: { PATH: "/usr/bin:/bin", COPYFILE_DISABLE: "1" } },
  );
  assert.equal(result.status, 0);
  await fs.chmod(archive, 0o600);
  const bytes = await fs.readFile(archive);
  f.manifest.archive.sha256 = createHash("sha256").update(bytes).digest("hex");
  f.manifest.archive.sizeBytes = bytes.length;
  await fs.writeFile(f.manifestPath, JSON.stringify(f.manifest));
  await assert.rejects(
    verifyExport(f.manifestPath, f.options),
    /Unsafe Jenkins archive entry path/,
  );
  assert.deepEqual(await fs.readdir(f.stage), []);
});

test("unsafe absolute/traversal/header ambiguity and special permissions are rejected while normal GNU/BSD metadata parses", () => {
  assert.equal(
    normalizeArchivePath("./jobs/test/builds/1/"),
    "jobs/test/builds/1",
  );
  for (const path of [
    "/etc/passwd",
    "./../outside",
    "jobs/../secrets",
    "a//b",
    "a\\b",
    "x\ny",
    "x -> y",
  ])
    assert.throws(() => normalizeArchivePath(path), /Unsafe|unsafe/);
  const bsd = parseTarListing(
    "drwx------  0 400 20 0 Oct  6 09:22 ./\n-rw-------  0 400 20 4 Oct  6 09:22 ./config.xml\n",
  );
  const gnu = parseTarListing(
    "drwx------ 400/20 0 2026-10-06 09:22 ./\n-rw------- 400/20 4 2026-10-06 09:22 ./config.xml\n",
  );
  assert.deepEqual(bsd, gnu);
  for (const listing of [
    "-rw-------  0 400 20 4 Oct  6 09:22 /etc/passwd\n",
    "-rws------  0 400 20 4 Oct  6 09:22 ./config.xml\n",
    "prw-------  0 400 20 4 Oct  6 09:22 ./pipe\n",
  ])
    assert.throws(() => parseTarListing(listing), /Unsafe|permissions|header/);
});

test("manifest duplicate members or members beneath a symlink cannot influence extraction", () => {
  const file = {
    path: "config.xml",
    type: "file",
    mode: 0o600,
    sizeBytes: 1,
    uid,
    gid: process.getgid(),
  };
  assert.throws(
    () => matchArchiveEntries({ entries: [file, file] }, [file, file]),
    /duplicate/,
  );
  const link = {
    ...file,
    path: "jobs/alias",
    type: "symlink",
    mode: 0o777,
    linkTarget: "real",
  };
  const child = { ...file, path: "jobs/alias/build.xml" };
  assert.throws(
    () => matchArchiveEntries({ entries: [link, child] }, [link, child]),
    /descend through/,
  );
});

test("saved unfinished Pipeline records are refused despite a claimed successful result", async (t) => {
  for (const build of [
    "<flow-build><completed>false</completed><result>SUCCESS</result></flow-build>",
    "<flow-build><result>SUCCESS</result></flow-build>",
    "<flow-build><completed>true</completed><completed>false</completed></flow-build>",
  ]) {
    const f = await fixture(t, { build });
    await assert.rejects(
      verifyExport(f.manifestPath, f.options),
      /unfinished saved Pipeline/,
    );
    assert.deepEqual(await fs.readdir(f.stage), []);
  }
  assert.deepEqual(inspectBuildRecord(completed), {
    pipeline: true,
    completed: true,
    result: "FAILURE",
  });
});

test("staging independently reviews saved WorkflowRun completion rather than trusting caller-supplied history", async (t) => {
  const f = await fixture(t, {
    build:
      "<flow-build><completed>false</completed><result>SUCCESS</result></flow-build>",
  });
  const stat = await fs.stat(join(f.destination, "jenkins-home.tar"));
  const unchecked = {
    entries: f.manifest.entries,
    archivePath: join(f.destination, "jenkins-home.tar"),
    archiveIdentity: {
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
    },
    history: { completedPipelineRuns: 1 },
  };
  await assert.rejects(
    stageRetainedHome(unchecked, f.stage),
    /unfinished saved Pipeline/,
  );
  assert.equal(
    await fs.readFile(
      join(f.source, "jobs/example/builds/1/build.xml"),
      "utf8",
    ),
    "<flow-build><completed>false</completed><result>SUCCESS</result></flow-build>",
  );
});

test("an unsecured realm, anonymous full control, missing preserved local user or XML entity is refused", () => {
  const entries = [{ path: "users/admin/config.xml", type: "file" }];
  for (const xml of [
    secureConfig.replace("<useSecurity>true", "<useSecurity>false"),
    secureConfig.replace(
      "true</denyAnonymousReadAccess>",
      "false</denyAnonymousReadAccess>",
    ),
    secureConfig.replace(
      "hudson.security.HudsonPrivateSecurityRealm",
      "hudson.security.SecurityRealm$None",
    ),
    `<!DOCTYPE x [<!ENTITY secret SYSTEM 'file:///outside'>]>${secureConfig}`,
  ])
    assert.throws(
      () => inspectSecurityConfiguration(xml, entries),
      /secured|anonymous/,
    );
  assert.throws(
    () => inspectSecurityConfiguration(secureConfig, []),
    /preserved user records/,
  );
});

test("nonempty staging and a replaced previously verified archive cannot be used", async (t) => {
  const f = await fixture(t);
  const v = await verifyExport(f.manifestPath, f.options);
  await fs.writeFile(join(f.stage, "existing"), "preserve-me", { mode: 0o600 });
  await assert.rejects(stageRetainedHome(v, f.stage), /new and empty/);
  await fs.rm(join(f.stage, "existing"));
  await fs.appendFile(v.archivePath, "changed-after-verification");
  await assert.rejects(
    stageRetainedHome(v, f.stage),
    /changed before extraction/,
  );
  assert.deepEqual(await fs.readdir(f.stage), []);
});

test("private manifest/archive aliases and permissive export directories are refused", async (t) => {
  const f = await fixture(t);
  await fs.chmod(f.destination, 0o755);
  await assert.rejects(verifyExport(f.manifestPath, f.options), /owner-only/);
  await fs.chmod(f.destination, 0o700);
  await fs.link(
    join(f.destination, "jenkins-home.tar"),
    join(f.destination, "archive-alias"),
  );
  await assert.rejects(
    verifyExport(f.manifestPath, f.options),
    /without aliases/,
  );
});

function dockerFixture({
  existing = false,
  architecture = "arm64",
  attached = false,
  importFailure = false,
} = {}) {
  const calls = [];
  let token;
  const docker = async (args, options) => {
    calls.push({ args, options });
    if (args[0] === "volume" && args[1] === "ls")
      return existing ? `${HOME_VOLUME}\n` : "";
    if (args[0] === "image" && args[1] === "inspect")
      return JSON.stringify([
        {
          Id: image,
          Os: "linux",
          Architecture: architecture,
          Config: { Env: ["JENKINS_VERSION=2.580.1"] },
        },
      ]);
    if (args[0] === "volume" && args[1] === "create") {
      token = args
        .find((value) => value.startsWith("agent-platform.home-import="))
        ?.split("=")[1];
      return HOME_VOLUME;
    }
    if (args[0] === "volume" && args[1] === "inspect")
      return JSON.stringify([
        {
          Name: HOME_VOLUME,
          Driver: "local",
          Options: {},
          Labels: { "agent-platform.home-import": token },
        },
      ]);
    if (args[0] === "ps") return attached ? "another-container" : "";
    if (args[0] === "create") return containerId;
    if (args[0] === "start") {
      if (importFailure) throw new Error("fixture-import-failed");
      return "jenkins-home-imported\n";
    }
    if (args[0] === "rm") return containerId;
    throw new Error("Unexpected Docker command in isolated fixture");
  };
  return { docker, calls };
}
const checked = {
  manifest: { archive: { sha256: "c".repeat(64) } },
  security: { resetAuthentication: false },
  history: { records: 6 },
};

test("only a new explicitly named volume and owned ephemeral helper are used; no controller/API or host mounts start", async () => {
  const f = dockerFixture();
  const result = await importVolume(checked, image, {
    docker: f.docker,
    retainedArchive: "/isolated-fixture/retained.tar",
  });
  assert.equal(result.state, "imported-not-started");
  assert.equal(result.activated, false);
  assert.equal(result.apiTouched, false);
  assert.match(result.jobsPause, /guard-on-startup/);
  const create = f.calls.find(({ args }) => args[0] === "create").args;
  assert.ok(
    create.includes(
      "type=volume,source=agent-platform-jenkins-home,target=/import-home",
    ),
  );
  assert.equal(create[create.indexOf("--network") + 1], "none");
  assert.equal(create[create.indexOf("--user") + 1], "0:0");
  assert.equal(create.filter((value) => value === "--mount").length, 1);
  assert.equal(
    create.some(
      (value) =>
        value.includes("type=bind") ||
        value === "--publish" ||
        value === "--privileged",
    ),
    false,
  );
  assert.match(create.at(-1), /test -z.*find/);
  assert.match(create.at(-1), /chown -hR 1000:1000/);
  const start = f.calls.find(({ args }) => args[0] === "start");
  assert.deepEqual(start, {
    args: ["start", "-ai", containerId],
    options: { inputPath: "/isolated-fixture/retained.tar" },
  });
  assert.deepEqual(f.calls.at(-1).args, ["rm", "-f", containerId]);
  assert.equal(
    f.calls.some(
      ({ args }) =>
        args.includes("prune") ||
        args.includes("restart") ||
        (args[0] === "volume" && args[1] === "rm"),
    ),
    false,
  );
});

test("a preexisting target is never overwritten even if allegedly empty", async () => {
  const f = dockerFixture({ existing: true });
  await assert.rejects(
    importVolume(checked, image, { docker: f.docker }),
    /already exists/,
  );
  assert.equal(f.calls.length, 1);
});

test("mutable tags and mismatched CPU architecture fail before creating any Home volume", async () => {
  assert.throws(
    () => validateImportImage("agent-platform-jenkins-controller:latest"),
    /mutable tag/,
  );
  const f = dockerFixture({ architecture: "amd64" });
  await assert.rejects(
    importVolume(checked, image, { docker: f.docker }),
    /verified Linux ARM64 core/,
  );
  assert.equal(
    f.calls.some(({ args }) => args[0] === "volume" && args[1] === "create"),
    false,
  );
});

test("an unexpectedly attached new volume aborts without starting a helper or modifying another container", async () => {
  const f = dockerFixture({ attached: true });
  await assert.rejects(
    importVolume(checked, image, { docker: f.docker }),
    /already attached/,
  );
  assert.equal(
    f.calls.some(
      ({ args }) =>
        args[0] === "create" || args[0] === "start" || args[0] === "rm",
    ),
    false,
  );
});

test("a failed import removes only its known helper and leaves the new volume for review instead of pruning data", async () => {
  const f = dockerFixture({ importFailure: true });
  await assert.rejects(
    importVolume(checked, image, { docker: f.docker }),
    /fixture-import-failed/,
  );
  assert.deepEqual(f.calls.at(-1).args, ["rm", "-f", containerId]);
  assert.equal(
    f.calls.some(
      ({ args }) =>
        args.includes("prune") || (args[0] === "volume" && args[1] === "rm"),
    ),
    false,
  );
});

test("a replacement volume or unidentified helper is never mutated or removed", async () => {
  for (const boundary of ["volume", "helper"]) {
    const f = dockerFixture();
    const docker = async (args, options) => {
      const result = await f.docker(args, options);
      if (
        boundary === "volume" &&
        args[0] === "volume" &&
        args[1] === "inspect"
      ) {
        const value = JSON.parse(result);
        value[0].Labels["agent-platform.home-import"] = "another-owner";
        return JSON.stringify(value);
      }
      if (boundary === "helper" && args[0] === "create")
        return "unrecognized-container";
      return result;
    };
    await assert.rejects(
      importVolume(checked, image, { docker }),
      /ownership changed|Cannot identify/,
    );
    assert.equal(
      f.calls.some(({ args }) => args[0] === "start" || args[0] === "rm"),
      false,
    );
  }
});
