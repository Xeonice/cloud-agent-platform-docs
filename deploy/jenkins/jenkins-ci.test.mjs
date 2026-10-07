import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apiCiContext, REPOSITORY, runPhase } from "./jenkins-ci.mjs";

const sha = "a".repeat(40);
const ref = "refs/pull/19/head";
const system = {
  platform: "linux",
  arch: "arm64",
  nodeMajor: 22,
  node: "/usr/local/bin/node",
};
const identity = {
  username: "jenkins",
  uid: 1000,
  gid: 1000,
  homedir: "/home/jenkins",
};
const provenance = {
  sha,
  ref,
  repository: REPOSITORY,
  nodeMajor: 22,
  platform: "linux",
  arch: "arm64",
};

async function fixture(t) {
  const workspace = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), "api-linux-ci-")),
  );
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const source = join(workspace, "source");
  await fs.mkdir(join(source, "packages/modules/sandbox"), { recursive: true });
  await fs.writeFile(
    join(workspace, "commit.json"),
    JSON.stringify(provenance),
  );
  const calls = [];
  const options = {
    system,
    identity,
    home: join(workspace, "home"),
    execute: async (command, args, cwd, env, capture) => {
      calls.push({ command, args, cwd, env, capture });
      return command === "/usr/bin/git" && args[0] === "rev-parse" ? sha : "";
    },
  };
  const invoke = (phase, requestedSha = sha, requestedRef = ref) =>
    runPhase(phase, requestedSha, requestedRef, workspace, options);
  return { workspace, source, calls, options, invoke };
}

test("backend validation accepts the isolated ARM64 Linux account and rejects other execution identities", () => {
  assert.equal(
    apiCiContext(identity, system).corepack,
    "/opt/agent-platform/corepack",
  );
  for (const changed of [
    { username: "root", uid: 0 },
    { uid: 501 },
    { gid: 501 },
    { homedir: "/root" },
    { username: "douglasdong" },
  ])
    assert.throws(
      () => apiCiContext({ ...identity, ...changed }, system),
      /Isolated CI/,
    );
  for (const changed of [
    { arch: "x64" },
    { nodeMajor: 26 },
    { node: "/tmp/node" },
  ])
    assert.throws(() => apiCiContext(identity, { ...system, ...changed }));
  assert.equal(
    apiCiContext(
      {
        username: "_agentplatformci",
        homedir: "/Users/Shared/agent-platform-ci",
      },
      { ...system, platform: "darwin", node: process.execPath },
    ).platform,
    "darwin",
  );
});

test("checkout fetches only the fixed API repository and records exact PR provenance on Linux", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(join(f.workspace, "native-import.json"), "old success");
  await f.invoke("checkout");
  assert.deepEqual(
    f.calls.map(({ command, args }) => ({ command, args })),
    [
      { command: "/usr/bin/git", args: ["init"] },
      {
        command: "/usr/bin/git",
        args: ["fetch", "--depth=1", REPOSITORY, ref],
      },
      { command: "/usr/bin/git", args: ["rev-parse", "FETCH_HEAD"] },
      { command: "/usr/bin/git", args: ["checkout", "--detach", sha] },
    ],
  );
  assert.deepEqual(
    JSON.parse(await fs.readFile(join(f.workspace, "commit.json"), "utf8")),
    provenance,
  );
  assert.equal(
    (await fs.stat(join(f.workspace, "commit.json"))).mode & 0o777,
    0o600,
  );
  await assert.rejects(fs.stat(join(f.workspace, "native-import.json")), {
    code: "ENOENT",
  });
});

test("a moved branch refuses checkout and cannot retain stale success metadata", async (t) => {
  const f = await fixture(t);
  const original = f.options.execute;
  f.options.execute = async (...args) => {
    const output = await original(...args);
    return args[1][0] === "rev-parse" ? "b".repeat(40) : output;
  };
  await assert.rejects(f.invoke("checkout"), /Ref moved/);
  assert.equal(
    f.calls.some(({ args }) => args[0] === "checkout"),
    false,
  );
  await assert.rejects(fs.stat(join(f.workspace, "commit.json")), {
    code: "ENOENT",
  });
});

test("changed HEAD or REF provenance blocks repository code before execution", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.invoke("build", sha, "refs/heads/main"),
    /provenance changed/,
  );
  assert.equal(f.calls.length, 0);
  f.options.execute = async (command, args, cwd, env, capture) => {
    f.calls.push({ command, args, cwd, env, capture });
    return "b".repeat(40);
  };
  await assert.rejects(f.invoke("acceptance"), /Checkout no longer matches/);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].command, "/usr/bin/git");
});

test("a source symlink is refused before removal or command execution", async (t) => {
  const f = await fixture(t);
  const preserved = join(f.workspace, "preserved");
  await fs.mkdir(preserved);
  await fs.writeFile(join(preserved, "marker"), "keep");
  await fs.rm(f.source, { recursive: true });
  await fs.symlink(preserved, f.source);
  await assert.rejects(f.invoke("checkout"), /symlink workspace/);
  await assert.rejects(f.invoke("build"), /symlink workspace/);
  assert.equal(f.calls.length, 0);
  assert.equal(await fs.readFile(join(preserved, "marker"), "utf8"), "keep");
});

test("Linux runs every existing API gate through pinned Corepack without inheriting credentials", async (t) => {
  const f = await fixture(t);
  const secret = "fixture-not-a-real-secret";
  const previous = process.env.ACCESS_PASSCODE;
  process.env.ACCESS_PASSCODE = secret;
  t.after(() => {
    if (previous === undefined) delete process.env.ACCESS_PASSCODE;
    else process.env.ACCESS_PASSCODE = previous;
  });
  for (const phase of [
    "install",
    "typecheck",
    "lint",
    "format",
    "default-image",
    "acceptance",
    "build",
    "provider-caps",
    "openapi",
  ])
    await f.invoke(phase);
  const children = f.calls.filter(({ command }) => command !== "/usr/bin/git");
  assert.deepEqual(
    children.map(({ args }) => args.slice(2)),
    [
      [
        "install",
        "--frozen-lockfile",
        "--store-dir",
        join(f.options.home, "pnpm-store"),
      ],
      ["typecheck"],
      ["lint", "--max-warnings=0"],
      ["format:check"],
      ["check:default-image"],
      ["test:acceptance:report"],
      ["build"],
      [],
      ["openapi:emit"],
    ],
  );
  for (const child of children) {
    assert.equal(child.command, "/usr/local/bin/node");
    assert.equal(child.cwd, f.source);
    assert.equal(child.env.COREPACK_HOME, "/opt/agent-platform/corepack");
    assert.equal(child.env.COREPACK_DEFAULT_TO_LATEST, "0");
    assert.equal(child.env.PATH.includes("homebrew"), false);
    assert.equal(child.env.HOME, f.options.home);
    for (const name of [
      "ACCESS_PASSCODE",
      "VERCEL_TOKEN",
      "GH_TOKEN",
      "NODE_OPTIONS",
      "DYLD_INSERT_LIBRARIES",
    ])
      assert.equal(child.env[name], undefined);
    assert.equal(JSON.stringify(child.env).includes(secret), false);
    if (child.args[1] === "pnpm")
      assert.equal(
        child.args[0],
        "/usr/local/lib/node_modules/corepack/dist/corepack.js",
      );
  }
  assert.equal(
    children.find(
      ({ args }) => args[0] === "scripts/check-fake-provider-caps.mjs",
    ) !== undefined,
    true,
  );
  assert.deepEqual(f.calls.at(-1).args, [
    "diff",
    "--exit-code",
    "--",
    "openapi.json",
  ]);
});

test("an OpenAPI drift failure propagates rather than recording successful validation", async (t) => {
  const f = await fixture(t);
  const original = f.options.execute;
  f.options.execute = async (...args) => {
    await original(...args);
    if (args[1][0] === "diff") throw new Error("fixture drift");
    return sha;
  };
  await assert.rejects(f.invoke("openapi"), /fixture drift/);
});

test("native phase loads SQLite and the actual BoxLite binding in the pinned Linux dependency tree", async (t) => {
  const f = await fixture(t);
  await f.invoke("native");
  const native = f.calls.filter(
    ({ command }) => command === "/usr/local/bin/node",
  );
  assert.equal(native.length, 2);
  assert.equal(native[0].cwd, f.source);
  assert.match(native[0].args.at(-1), /require\('better-sqlite3'\)/);
  assert.match(native[0].args.at(-1), /assert.equal/);
  assert.equal(native[1].cwd, join(f.source, "packages/modules/sandbox"));
  assert.match(native[1].args.at(-1), /await import\('@boxlite-ai\/boxlite'\)/);
  assert.match(native[1].args.at(-1), /sdk.getNativeModule\(\).JsBoxlite/);
  assert.doesNotMatch(
    native[1].args.at(-1),
    /new (?:sdk\.|JsBoxlite|SimpleBox)|\.create\(|\.start\(/,
  );
  assert.deepEqual(
    JSON.parse(
      await fs.readFile(join(f.workspace, "native-import.json"), "utf8"),
    ),
    {
      ...provenance,
      sqlite: "passed",
      boxlite: "passed",
      boxliteVmStarted: false,
    },
  );
});

test("either failed native load removes an old success report and fails the phase", async (t) => {
  for (const failAt of [1, 2]) {
    const f = await fixture(t);
    await fs.writeFile(join(f.workspace, "native-import.json"), "old success");
    const original = f.options.execute;
    let loads = 0;
    f.options.execute = async (...args) => {
      const result = await original(...args);
      if (args[0] === "/usr/local/bin/node" && ++loads === failAt)
        throw new Error("fixture NAPI load failed");
      return result;
    };
    await assert.rejects(f.invoke("native"), /NAPI load failed/);
    assert.equal(loads, failAt);
    await assert.rejects(fs.stat(join(f.workspace, "native-import.json")), {
      code: "ENOENT",
    });
  }
});

test("invalid phase or pinned input cannot run even the initial Git command", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.invoke("shell"), /Unknown fixed CI phase/);
  await assert.rejects(f.invoke("checkout", "main"), /Invalid pinned/);
  await assert.rejects(
    f.invoke("checkout", sha, "--upload-pack=sh"),
    /Invalid pinned/,
  );
  assert.equal(f.calls.length, 0);
});

test("managed backend pipeline targets only Linux validation and keeps all gates and archive provenance", async () => {
  const pipeline = await fs.readFile(
    new URL("./native-ci.groovy", import.meta.url),
    "utf8",
  );
  assert.match(pipeline, /agent \{ label 'agent-platform-linux-ci' \}/);
  assert.match(pipeline, /NODE22 = '\/usr\/local\/bin\/node'/);
  assert.match(
    pipeline,
    /CI_TOOL = '\/opt\/agent-platform\/tools\/jenkins-ci.mjs'/,
  );
  assert.deepEqual(
    [...pipeline.matchAll(/\$CI_TOOL" ([a-z-]+) "\$SHA" "\$REF"/g)].map(
      (match) => match[1],
    ),
    [
      "checkout",
      "install",
      "typecheck",
      "lint",
      "format",
      "default-image",
      "acceptance",
      "provider-caps",
      "build",
      "openapi",
      "native",
    ],
  );
  assert.match(pipeline, /commit.json,native-import.json/);
  assert.doesNotMatch(
    pipeline,
    /agent-platform-deploy|agent-platform-ci'|@NODE22@/,
  );
});
