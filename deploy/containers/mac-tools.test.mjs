import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { prepareDeployContext } from "./prepare-deploy-context.mjs";
import { smokeImage } from "./ci-smoke.mjs";
import {
  createSetupServer,
  verifySetup,
} from "../jenkins/setup-github-app.mjs";

const source = dirname(fileURLToPath(import.meta.url));
const root = join(source, "../..");
// The Mac-only operator tools that take every host value from host-layout.mjs.
const TOOLS = [
  "deploy/jenkins/manage.mjs",
  "deploy/jenkins/setup-github-app.mjs",
  "deploy/jenkins/import-ghcr-token.mjs",
  "deploy/containers/bootstrap-host.mjs",
  "deploy/containers/controller.mjs",
  "deploy/containers/verify-controller.mjs",
  "deploy/containers/ci-smoke.mjs",
];
// Copied into the deploy image, which has no ../containers next to them.
const IMAGE_COPIES = [
  "manage.mjs",
  "setup-github-app.mjs",
  "import-ghcr-token.mjs",
];

test("no Mac operator tool names a host path, account, UID or binary location", async () => {
  for (const path of TOOLS) {
    const code = (await fs.readFile(join(root, path), "utf8")).replace(
      /^\s*\/\/.*$/gm,
      "",
    );
    for (const pattern of [
      /\/Users\//,
      /(^|[^0-9])501([^0-9]|$)/,
      /\/\.orbstack\//,
      /fnm\/node-versions/,
      /\/opt\/homebrew/,
      /\/\.colima\//,
      /agent-platform-jenkins-tools/,
      /homedir\(/,
      // controller.mjs reads the reviewed controller URL selection, not a path.
      /process\.env\.(HOME|USER|LOGNAME|XDG_|DOCKER_|AGENT_PLATFORM_(?!JENKINS_URL\b))/,
    ])
      assert.doesNotMatch(code, pattern, `${path}: ${pattern}`);
    // Domains stay; the lab controller's Jenkins user name is not a host account.
    const names = code
      .split("\n")
      .filter((line) => /douglasdong(?!\.com)/.test(line))
      .map((line) => line.trim());
    assert.deepEqual(
      names,
      path.endsWith("verify-controller.mjs")
        ? ['credential.username === "douglasdong" &&']
        : [],
      path,
    );
  }
});

test("the deploy image copies of the Mac-only CLIs import without the host layout and run nothing on import", async (t) => {
  // Real path: a CLI started through a symlinked path (/var on macOS) is not
  // recognised as the main module.
  const temporary = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), "mac-tools-image-")),
  );
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const { context, manifest } = await prepareDeployContext(root, temporary);
  const targets = manifest.files.map((file) => file.target);
  assert.ok(!targets.some((target) => target.includes("host-layout")));
  await assert.rejects(fs.lstat(join(context, "containers")), {
    code: "ENOENT",
  });
  const tools = join(context, "tools");
  for (const name of IMAGE_COPIES) {
    assert.ok(targets.includes(`tools/${name}`), name);
    const text = await fs.readFile(join(tools, name), "utf8");
    // Only a dynamic import on the CLI path, never a static one.
    assert.doesNotMatch(text, /^import[^;]*host-layout/m, name);
    assert.match(
      text,
      /await import\("\.\.\/containers\/host-layout\.mjs"\)/,
      name,
    );
  }
  const manage = await import(pathToFileURL(join(tools, "manage.mjs")).href);
  assert.equal(typeof manage.runManagement, "function");
  const setup = await import(
    pathToFileURL(join(tools, "setup-github-app.mjs")).href
  );
  assert.equal(typeof setup.verifySetup, "function");
  const token = await import(
    pathToFileURL(join(tools, "import-ghcr-token.mjs")).href
  );
  assert.deepEqual(Object.keys(token), []);
  // Run as a CLI inside the image, the copy stops at the missing module before
  // reading any credential or contacting Jenkins.
  const cli = spawnSync(
    process.execPath,
    [join(tools, "manage.mjs"), "status"],
    {
      cwd: "/",
      env: { PATH: "/usr/bin:/bin" },
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  assert.notEqual(cli.status, 0);
  assert.match(cli.stderr, /ERR_MODULE_NOT_FOUND/);
  assert.match(cli.stderr, /host-layout\.mjs/);
  assert.equal(cli.stdout, "");
});

test("GitHub App setup takes the private directory and owner UID from its caller", async () => {
  for (const options of [
    {},
    { tools: "/tmp/app" },
    { uid: 5101 },
    { tools: "", uid: 5101 },
    { tools: "/tmp/app", uid: -1 },
    { tools: "/tmp/app", uid: "5101" },
    { tools: "/tmp/app", uid: 5101.5 },
  ]) {
    await assert.rejects(
      createSetupServer(options),
      /explicit tools directory and owner UID/,
    );
    await assert.rejects(
      verifySetup(options),
      /explicit tools directory and owner UID/,
    );
  }
});

test("the GHCR token import does nothing when imported", async () => {
  const token = await import("../jenkins/import-ghcr-token.mjs");
  assert.deepEqual(Object.keys(token), []);
});

test("ci-smoke refuses an unknown architecture before deriving the host layout", async (t) => {
  const dir = await fs.mkdtemp(join(tmpdir(), "ci-smoke-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const architecture of ["sparc", "", undefined, "amd64"])
    await assert.rejects(
      smokeImage(architecture, join(dir, "report.json")),
      /Use arm64 or x64/,
    );
  assert.deepEqual(await fs.readdir(dir), []);
});

test("verify-controller accepts no overrides and stops before touching the host", () => {
  for (const args of [["--host", "unix:///var/run/docker.sock"], ["lab"]]) {
    const result = spawnSync(
      process.execPath,
      [join(source, "verify-controller.mjs"), ...args],
      {
        cwd: "/",
        env: { PATH: "/usr/bin:/bin" },
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /accepts no service, credential or host overrides/,
    );
    assert.equal(result.stdout, "");
  }
});
