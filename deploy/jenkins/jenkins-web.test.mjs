import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { join, dirname, resolve, basename } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { LINUX_CI, browserVerificationScript } from "./ci-platform.mjs";
import { assertDeploymentLayout } from "./deployment-platform.mjs";
import {
  WEB,
  GATES,
  PUBLIC_ENV,
  childEnvironment,
  publicEnvironment,
  safeProject,
  validRef,
  roleFor,
  treeEvidence,
  validateManifest,
  validateHistoricalManifest,
  testReport,
  readExecutedTestReport,
  archivePaths,
  deploymentResult,
  releaseKey,
  runWebPhase,
  normalizeOutput,
} from "./jenkins-web.mjs";

const execute = promisify(execFile);
const WEB_SHA = "a".repeat(40),
  ROOT_SHA = "b".repeat(40),
  API_SHA = "c".repeat(40);
// Safe public fields from the first actual Jenkins prebuilt deployment GET.
// Vercel's generated hostname and project name differ.
const actualStagedDeployment = Object.freeze({
  id: "dpl_6GuJF2oG3PZCFWerbJJ58itbuCf9",
  url: "agent-platform-5ut6423ar-xeonices-projects.vercel.app",
  projectId: "prj_XYIzK6r7LgRrV5NHCwWff489J73r",
  readyState: "READY",
  readySubstate: "STAGED",
  target: "production",
  source: "cli",
  prebuilt: true,
  meta: {
    jenkinsRootSha: "0b2bb9bd1c2dfd7d8f815c47bf1cbdb30886fa90",
    jenkinsApiSha: "1e628c9ad6ad141288f892f0e1873fe5c97a8d0a",
    jenkinsWebSha: "0a7794b34fef53b564bc7216fd29ef03b0d360da",
    jenkinsBuildNumber: "7",
  },
});
// Pipeline fixtures drive the fixed Linux agents with real filesystem and tar
// boundaries. Their directories are redirected into a temporary tree and the
// private-volume check is injected, so no agent container or Mac service is used.
const agentSystem = {
  platform: "linux",
  arch: "arm64",
  nodeMajor: 22,
  node: LINUX_CI.node,
};
// CI and deployment agents share this account; the deployment role is proven
// only by its private volumes (see the layout guard below).
const agentIdentity = {
  username: "jenkins",
  uid: 1000,
  gid: 1000,
  homedir: LINUX_CI.home,
};
const native = {
  concurrency: false,
};
const project = () => ({
  projectId: WEB.projectId,
  orgId: WEB.orgId,
  settings: {
    framework: "nextjs",
    nodeVersion: "22.x",
    buildCommand: "pnpm build",
    installCommand: "pnpm install --frozen-lockfile",
    rootDirectory: null,
    futurePrivateSetting: "private-setting-never-forwarded",
  },
});
const passed = () => ({
  success: true,
  numTotalTests: 2,
  numPassedTests: 2,
  numFailedTests: 0,
  numPendingTests: 0,
  testResults: [
    {
      status: "passed",
      assertionResults: [{ status: "passed" }, { status: "passed" }],
    },
  ],
});
async function put(path, value) {
  await fs.writeFile(
    path,
    typeof value === "string" ? value : JSON.stringify(value),
    { mode: 0o600 },
  );
}
async function read(path) {
  return JSON.parse(await fs.readFile(path, "utf8"));
}

async function fixture(t) {
  const path = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), "jenkins-web-test-")),
  );
  t.after(() => fs.rm(path, { recursive: true, force: true }));
  const paths = {
    root: join(path, "production"),
    ciHome: join(path, "ci"),
    ownerHome: join(path, "owner"),
    auth: join(path, "auth.json"),
  };
  const workspace = join(path, "workspace");
  for (const dir of [workspace, paths.root, paths.ciHome, paths.ownerHome])
    await fs.mkdir(dir, { mode: 0o700 });
  await put(paths.auth, {
    token: "fake-private-vercel-token-not-a-real-credential",
  });
  await put(join(paths.root, "jenkins-web-pin.json"), {
    repository: "Xeonice/cloud-agent-platform-docs",
    approved: true,
    rootSha: ROOT_SHA,
    apiSha: API_SHA,
    webSha: WEB_SHA,
  });
  await put(
    join(paths.root, "runtime.env"),
    "HOST=127.0.0.1\nPORT=3101\nACCESS_PASSCODE=fake-private-runtime-value\n",
  );
  const state = {
    sha: WEB_SHA,
    calls: [],
    ref: WEB.ref,
    fail: null,
    mach: false,
    uploads: 0,
    promotes: 0,
    readiness: true,
    apiSha: API_SHA,
    layoutChecks: 0,
  };
  // Trusted phases resolve the fixed deployment volumes; paths.* redirects them
  // into this fixture, and tests may swap in the real volume check.
  state.layoutGuard = async (layout) => {
    state.layoutChecks++;
    assert.equal(layout.root, "/srv/agent-platform/deploy");
    assert.equal(layout.tools, "/run/agent-platform/jenkins-tools");
    assert.equal(
      layout.auth,
      "/run/agent-platform/jenkins-tools/vercel/auth.json",
    );
  };
  const old = {
    JOB_NAME: process.env.JOB_NAME,
    BUILD_NUMBER: process.env.BUILD_NUMBER,
  };
  process.env.JOB_NAME = "agent-platform-web";
  process.env.BUILD_NUMBER = "123";
  t.after(() => {
    for (const [key, value] of Object.entries(old))
      value === undefined
        ? delete process.env[key]
        : (process.env[key] = value);
  });
  const fakeExecute = async (command, args, cwd, env, capture) => {
    state.calls.push({ command, args, cwd, env, capture });
    if (command === LINUX_CI.node && args[0] === "--input-type=module") {
      assert.deepEqual(args, [
        "--input-type=module",
        "-e",
        browserVerificationScript(),
      ]);
      if (state.fail === "browser-verification")
        throw new Error("Preinstalled browser revision is missing");
      return "";
    }
    if (command === "/usr/bin/tar")
      return (await execute(command, args, { cwd, env })).stdout.trim();
    if (command === "/usr/bin/git") {
      if (args[0] === "rev-parse") return state.sha;
      if (args[0] === "ls-remote") return `${state.sha}\t${WEB.ref}`;
      if (args[0] === "diff" && state.dirty)
        throw new Error("Tracked source changed");
      if (args[0] === "ls-files" && args.includes("--others"))
        return state.untracked ?? "";
      if (args[0] === "ls-files")
        return "package.json\0src/page.tsx\0.env.example\0";
      if (args[0] === "checkout") {
        await put(join(cwd, "package.json"), { packageManager: "pnpm@9.15.0" });
        return "";
      }
      if (args[0] === "archive") {
        const source = join(path, "source-export");
        await fs.mkdir(join(source, "agent-platform-web"), { recursive: true });
        await put(join(source, "agent-platform-web/package.json"), {
          name: "agent-platform-web",
        });
        await execute(
          "/usr/bin/tar",
          [
            "-czf",
            args.find((arg) => arg.startsWith("--output=")).slice(9),
            "-C",
            source,
            "agent-platform-web",
          ],
          { env },
        );
        return "";
      }
      return "";
    }
    if (args[0] === LINUX_CI.cli) {
      const action = args[1];
      if (action === "pull") {
        const cache = join(args[2], ".vercel");
        await put(join(cache, "project.json"), project());
        await put(
          join(cache, ".env.production.local"),
          Object.entries(PUBLIC_ENV)
            .map(([key, value]) => `${key}=${value}`)
            .join("\n") +
            "\nVERCEL_OIDC_TOKEN=private-oidc\nDATABASE_URL=private-database\n",
        );
      } else if (action === "build") {
        const output = join(cwd, ".vercel/output");
        await fs.mkdir(join(output, "functions/index.func"), {
          recursive: true,
        });
        await put(join(output, "config.json"), { version: 3 });
        await put(
          join(output, "functions/index.func/index.js"),
          "export default function handler() {}",
        );
        await put(join(output, "functions/index.func/.vc-config.json"), {
          runtime: "nodejs22.x",
          handler: "index.js",
          ...(state.functionArchitecture
            ? { architecture: state.functionArchitecture }
            : {}),
        });
        if (state.elfMachine) {
          const elf = Buffer.alloc(64);
          elf.write("ELF", 1);
          elf[0] = 0x7f;
          elf[4] = 2;
          elf[5] = 1;
          elf.writeUInt16LE(state.elfMachine, 18);
          await fs.writeFile(
            join(output, "functions/index.func/sharp.node"),
            elf,
          );
        }
        if (state.mach)
          await fs.writeFile(
            join(output, "functions/index.func/sharp.node"),
            Buffer.from("cffaedfe00000000", "hex"),
          );
      } else if (action === "deploy") {
        state.uploads++;
        if (state.fail === "upload") throw new Error("Upload failed");
        return JSON.stringify({
          status: "ok",
          deployment: {
            id: actualStagedDeployment.id,
            url: `https://${actualStagedDeployment.url}`,
            readyState: actualStagedDeployment.readyState,
            target: actualStagedDeployment.target,
          },
        });
      } else if (action === "api") {
        if (args[2].startsWith("/v4/aliases/"))
          return JSON.stringify({
            alias: WEB.domain,
            projectId: WEB.projectId,
            deploymentId: state.aliasDeploymentId ?? actualStagedDeployment.id,
            ...state.aliasPatch,
          });
        return JSON.stringify({
          ...actualStagedDeployment,
          projectId: state.projectId ?? WEB.projectId,
          readyState: "READY",
          target: "production",
          readySubstate: state.remoteState ?? "STAGED",
          meta: {
            jenkinsWebSha: state.metaSha ?? WEB_SHA,
            jenkinsRootSha: ROOT_SHA,
            jenkinsApiSha: API_SHA,
            jenkinsBuildNumber: "123",
          },
          ...state.remoteDeploymentPatch,
        });
      } else if (action === "promote") {
        state.promotes++;
        if (state.fail === "promote") throw new Error("Promote failed");
        state.remoteState = "PROMOTED";
      }
      return "";
    }
    if (args.includes("pnpm")) {
      const index = args.indexOf("pnpm") + 1;
      const script = args[index] === "run" ? args[index + 1] : args[index];
      if (state.fail === script) throw new Error("CI gate failed");
      if (script === "test" || script === "test:storybook") {
        const jsonPath = args
          .find((arg) => arg.startsWith("--outputFile.json="))
          .slice(18);
        const xmlPath = args
          .find((arg) => arg.startsWith("--outputFile.junit="))
          .slice(19);
        await put(jsonPath, state.testResult ?? passed());
        await put(xmlPath, '<testsuites tests="2" failures="0"/>');
      }
      if (script === "build-storybook") {
        await fs.mkdir(join(cwd, "storybook-static"), { recursive: true });
        await put(
          join(cwd, "storybook-static/index.html"),
          "<!doctype html><title>Storybook</title>",
        );
      }
      return "";
    }
    throw new Error("Unexpected command");
  };
  const overrides = {
    system: agentSystem,
    cliVersion: "62.2.0",
    paths,
    execute: fakeExecute,
    fetch: async (url, options) => {
      state.calls.push({ url, options });
      const body = url.endsWith("/health")
        ? { status: "ok" }
        : url.endsWith("/version")
          ? { commit: state.apiSha }
          : { ready: state.readiness };
      return new Response(JSON.stringify(body));
    },
  };
  const invoke = (
    phase,
    ref = state.ref,
    sha = WEB_SHA,
    root = ROOT_SHA,
    api = API_SHA,
  ) =>
    runWebPhase(phase, sha, ref, workspace, root, api, {
      ...overrides,
      ...(state.system ? { system: state.system } : {}),
      identity: agentIdentity,
      assertLayout: state.layoutGuard,
    });
  const release = join(
    paths.root,
    "web-releases",
    releaseKey(ROOT_SHA, API_SHA, WEB_SHA),
  );
  return { path, paths, workspace, state, invoke, release };
}
async function build(f) {
  await f.invoke("prepare-env");
  await f.invoke("checkout");
  for (const gate of GATES) await f.invoke(gate);
  await f.invoke("package");
}

test(
  "trusted Linux adopts identical CI bits and authenticates only fixed Vercel commands after private volume validation",
  { concurrency: false },
  async (t) => {
    const f = await fixture(t);
    await build(f);
    // prepare-env is the only trusted phase of the CI build.
    assert.equal(f.state.layoutChecks, 1);
    await f.invoke("adopt");
    await f.invoke("upload");
    await f.invoke("promote");
    assert.equal(f.state.layoutChecks, 4);
    assert.equal(f.state.uploads, 1);
    assert.equal(f.state.promotes, 1);
    const cli = f.state.calls.filter(
      (call) => call.command === LINUX_CI.node && call.args[0] === LINUX_CI.cli,
    );
    // CI and deployment images install the same CLI path. The CI build runs
    // offline against an empty global config; every other call is trusted.
    const offline = cli.filter((call) => call.args[1] === "build");
    assert.deepEqual(
      offline.map((call) => call.args.slice(-2)),
      [["--global-config", join(f.workspace, "empty-vercel-global")]],
    );
    assert.equal(offline[0].args.includes("--scope"), false);
    const authenticated = cli.filter((call) => call.args[1] !== "build");
    assert.equal(authenticated.length > 0, true);
    for (const call of authenticated) {
      assert.equal(call.args.at(-1), f.path);
      assert.equal(call.args[call.args.indexOf("--scope") + 1], WEB.scope);
      assert.equal(
        call.env.PATH,
        "/usr/local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      );
      assert.equal(call.env.LANG, "C.UTF-8");
      for (const name of [
        "ACCESS_PASSCODE",
        "VERCEL_TOKEN",
        "GH_TOKEN",
        "NODE_OPTIONS",
        "DOCKER_HOST",
      ])
        assert.equal(call.env[name], undefined);
      assert.equal(JSON.stringify(call.args).includes("fake-private"), false);
    }
    assert.equal(
      f.state.calls
        .filter((call) => call.url)
        .every((call) => call.url.startsWith("http://127.0.0.1:3101/api/")),
      true,
    );
  },
);

test(
  "Linux CI identity without trusted private volumes cannot invoke credential-bearing web publication",
  { concurrency: false },
  async (t) => {
    const f = await fixture(t);
    f.state.layoutGuard = (layout) =>
      assertDeploymentLayout({
        ...layout,
        root: join(f.path, "missing-production-volume"),
        tools: join(f.path, "missing-credentials-volume"),
      });
    await assert.rejects(f.invoke("upload"));
    assert.equal(f.state.calls.length, 0);
    assert.equal(f.state.uploads, 0);
  },
);

async function publicFixture(f) {
  const cache = join(f.workspace, "public-vercel-cache");
  await fs.mkdir(cache);
  await put(join(cache, "project.json"), safeProject(project()));
  await put(
    join(cache, "production.env"),
    Object.entries(PUBLIC_ENV)
      .map(([key, value]) => key + "=" + value)
      .join("\n"),
  );
  await put(join(cache, "provenance.json"), {
    sha: WEB_SHA,
    rootSha: ROOT_SHA,
    apiSha: API_SHA,
    projectId: WEB.projectId,
  });
}

test(
  "Linux AMD64 production CI runs every local gate with no publication credentials and packages verified ELF targets",
  { concurrency: false },
  async (t) => {
    const f = await fixture(t);
    await publicFixture(f);
    f.state.system = {
      platform: "linux",
      arch: "x64",
      nodeMajor: 22,
      node: LINUX_CI.node,
    };
    f.state.elfMachine = 62;
    await f.invoke("checkout");
    for (const gate of GATES) await f.invoke(gate);
    await f.invoke("package");
    const manifest = await read(
      join(f.workspace, "web-artifacts/manifest.json"),
    );
    validateManifest(manifest, WEB_SHA, ROOT_SHA, true, API_SHA);
    assert.deepEqual(manifest.buildSystem, { platform: "linux", arch: "x64" });
    assert.deepEqual(manifest.trees.output.nativeArchitectures, ["x86_64"]);
    const ciCalls = f.state.calls.filter((c) => c.command === LINUX_CI.node);
    assert.equal(
      ciCalls.some((c) => c.args[0] === "--input-type=module"),
      true,
    );
    assert.equal(
      ciCalls.some(
        (c) =>
          c.args.slice(-4).join(" ") === "exec playwright install chromium",
      ),
      false,
    );
    const buildCall = ciCalls.find(
      (c) => c.args[0] === LINUX_CI.cli && c.args[1] === "build",
    );
    assert.equal(buildCall.args.includes("--standalone"), true);
    assert.equal(buildCall.env.PLAYWRIGHT_BROWSERS_PATH, LINUX_CI.browsers);
    for (const call of ciCalls) {
      assert.equal(Object.hasOwn(call.env, "VERCEL_TOKEN"), false);
      assert.equal(Object.hasOwn(call.env, "ACCESS_PASSCODE"), false);
      assert.equal(JSON.stringify(call.args).includes("fake-private"), false);
    }
    await assert.rejects(f.invoke("upload"), /Trusted deployment account/);
    assert.equal(f.state.uploads, 0);
  },
);

test(
  "Linux browser verification failure makes install fail and prevents packaging",
  { concurrency: false },
  async (t) => {
    const f = await fixture(t);
    f.state.system = {
      platform: "linux",
      arch: "x64",
      nodeMajor: 22,
      node: LINUX_CI.node,
    };
    f.state.fail = "browser-verification";
    await f.invoke("checkout");
    await assert.rejects(f.invoke("install"), /browser revision is missing/);
    const report = await read(join(f.workspace, "web-artifacts/web-ci.json"));
    assert.equal(report.state, "failed");
    assert.equal(report.gates.install.state, "failed");
    await assert.rejects(f.invoke("package"), /previous gate failed/);
    assert.equal(
      await fs
        .lstat(join(f.workspace, "web-artifacts/manifest.json"))
        .catch(() => null),
      null,
    );
  },
);

test(
  "Linux ARM64 output may be pure JS but cannot package ARM ELF for a default x86_64 function",
  { concurrency: false },
  async (t) => {
    const f = await fixture(t);
    await publicFixture(f);
    f.state.system = {
      platform: "linux",
      arch: "arm64",
      nodeMajor: 22,
      node: LINUX_CI.node,
    };
    await f.invoke("checkout");
    await f.invoke("build");
    assert.deepEqual(
      (await read(join(f.workspace, "web-artifacts/web-ci.json"))).gates.build
        .output.nativeArchitectures,
      [],
    );
    await fs.rm(join(f.workspace, "web-source/.vercel"), { recursive: true });
    await fs.rm(join(f.workspace, "empty-vercel-global"), { recursive: true });
    f.state.elfMachine = 183;
    await assert.rejects(f.invoke("build"), /ELF architecture does not match/);
    await assert.rejects(f.invoke("package"), /previous gate failed/);
    assert.equal(
      await fs
        .lstat(join(f.workspace, "web-artifacts/manifest.json"))
        .catch(() => null),
      null,
    );
  },
);

test("only valid fixed-repository ref syntax and isolated/trusted OS identities are accepted", () => {
  for (const ref of ["refs/heads/main", WEB.ref, "refs/pull/12/head"])
    assert.equal(validRef(ref), true);
  for (const ref of [
    "--upload-pack=evil",
    "refs/heads/a..b",
    "refs/heads/a//b",
    "refs/pull/0/head",
    "refs/heads/a.lock",
    "https://evil/repo",
  ])
    assert.equal(validRef(ref), false);
  assert.equal(roleFor("install", agentIdentity, agentSystem), "ci");
  assert.equal(
    roleFor("install", agentIdentity, { ...agentSystem, arch: "x64" }),
    "ci",
  );
  // The shared account reaches the trusted role only on the ARM64 deployment
  // image; its private volumes are checked separately before any credential.
  assert.equal(roleFor("promote", agentIdentity, agentSystem), "trusted");
  assert.throws(
    () => roleFor("promote", agentIdentity, { ...agentSystem, arch: "x64" }),
    /Trusted deployment account/,
  );
  for (const phase of ["install", "promote"]) {
    for (const identity of [
      { ...agentIdentity, uid: 5101 },
      { ...agentIdentity, homedir: "/tmp/ci-home" },
      { username: "operator", uid: 5101, gid: 20, homedir: "/Users/operator" },
    ])
      assert.throws(() => roleFor(phase, identity, agentSystem));
    // No macOS host remains a CI or deployment dispatcher.
    assert.throws(
      () =>
        roleFor(phase, agentIdentity, {
          ...agentSystem,
          platform: "darwin",
          node: "/opt/node-22/bin/node",
        }),
      /fixed Node 22 Linux/,
    );
  }
});

test("child environment is constructed without ambient deployment/runtime secrets", () => {
  const env = childEnvironment("/node/bin/node", "/ci/home", "/ci/tmp");
  assert.equal(
    env.PATH,
    "/node/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
  );
  assert.equal(env.LANG, "C.UTF-8");
  assert.equal(env.HOME, "/ci/home");
  assert.equal(env.GIT_CONFIG_GLOBAL, "/dev/null");
  for (const name of [
    "ACCESS_PASSCODE",
    "DATABASE_URL",
    "VERCEL_TOKEN",
    "GH_TOKEN",
    "NODE_OPTIONS",
    "DYLD_INSERT_LIBRARIES",
    "JENKINS_HOME",
  ])
    assert.equal(Object.hasOwn(env, name), false);
});

test("public cache drops unknown/private project env values and pins exact production origins", () => {
  const text = Object.entries(PUBLIC_ENV)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const actual = publicEnvironment(
    `${text}\nDATABASE_URL=private-value\nVERCEL_OIDC_TOKEN=private-token\n`,
  );
  assert.equal(actual.includes("private"), false);
  assert.equal(actual.includes("VERCEL_OIDC_TOKEN"), false);
  assert.throws(() =>
    publicEnvironment(text.replace(WEB.api, "https://evil.example")),
  );
  assert.throws(() => publicEnvironment("NEXT_PUBLIC_API_MOCK=1"));
  const safe = safeProject(project());
  assert.equal(JSON.stringify(safe).includes("futurePrivateSetting"), false);
  assert.throws(() => safeProject({ ...project(), projectId: "old-project" }));
  assert.throws(() =>
    safeProject({
      ...project(),
      settings: { ...project().settings, installCommand: "curl evil | sh" },
    }),
  );
});

test("browser report metadata above the configuration limit remains readable, while links and oversized reports fail", async (t) => {
  const directory = await fs.mkdtemp(join(tmpdir(), "web-browser-report-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const path = join(directory, "storybook.json");
  await put(path, { ...passed(), browserMetadata: "x".repeat(3_000_000) });
  assert.deepEqual(await readExecutedTestReport(path), testReport(passed()));
  const link = join(directory, "linked.json");
  await fs.symlink(path, link);
  await assert.rejects(readExecutedTestReport(link));
  await fs.truncate(path, 64 * 1024 * 1024 + 1);
  await assert.rejects(readExecutedTestReport(path), /Unsafe input file/);
});

test("real executed test reports reject missing counts, skips, contradictory suites and failures", () => {
  assert.deepEqual(testReport(passed()), {
    files: 1,
    passed: 2,
    failed: 0,
    skipped: 0,
  });
  for (const patch of [
    { numTotalTests: undefined, numPassedTests: undefined },
    { numPendingTests: 1 },
    { numFailedTests: 1 },
    { success: false },
    { testResults: [] },
    { numTotalTests: 3, numPassedTests: 3 },
  ])
    assert.throws(() => testReport({ ...passed(), ...patch }));
  assert.throws(() =>
    testReport({
      ...passed(),
      testResults: [
        {
          status: "passed",
          assertionResults: [{ status: "pending" }, { status: "passed" }],
        },
      ],
    }),
  );
});

test("archive extraction permits only a fixed relative output prefix", () => {
  assert.deepEqual(
    archivePaths(
      ".vercel/output/\n.vercel/output/config.json\n",
      ".vercel/output",
    ),
    [".vercel/output/", ".vercel/output/config.json"],
  );
  for (const list of [
    "",
    "/.vercel/output/x",
    ".vercel/output/../auth.json",
    ".vercel/output/./x",
    ".vercel/output\\x",
    "runtime.env",
    ".vercel/output-evil/x",
  ])
    assert.throws(() => archivePaths(list, ".vercel/output"));
});

test("deployment CLI JSON must attest a READY production upload and approved URL shape", () => {
  const good = {
    id: actualStagedDeployment.id,
    readyState: actualStagedDeployment.readyState,
    target: actualStagedDeployment.target,
    url: `https://${actualStagedDeployment.url}`,
  };
  assert.equal(
    deploymentResult(JSON.stringify({ status: "ok", deployment: good }))
      .deploymentId,
    actualStagedDeployment.id,
  );
  assert.equal(deploymentResult(JSON.stringify(good)).url, good.url);
  for (const patch of [
    { readyState: "ERROR" },
    { target: "preview" },
    { url: "https://evil.example/" },
    { url: "https://agent-platform-web-unit-test.vercel.app" },
    { url: "https://other-project-5ut6423ar-xeonices-projects.vercel.app" },
    { url: "https://agent-platform-5ut6423ar-other-team.vercel.app" },
    { url: `${good.url}/` },
    { url: `${good.url}?redirect=evil` },
    { url: good.url.replace("https:", "http:") },
    { id: undefined },
  ])
    assert.throws(() =>
      deploymentResult(JSON.stringify({ ...good, ...patch })),
    );
});

test("project cache key distinguishes docs/API releases even when web SHA is unchanged", () => {
  const first = releaseKey(ROOT_SHA, API_SHA, WEB_SHA);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.notEqual(first, releaseKey("d".repeat(40), API_SHA, WEB_SHA));
  assert.notEqual(first, releaseKey(ROOT_SHA, "d".repeat(40), WEB_SHA));
  assert.equal(first, releaseKey(ROOT_SHA, API_SHA, WEB_SHA));
});

test("build walker hashes real files and refuses Darwin binaries, symlinks and env leakage", async (t) => {
  const path = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), "web-tree-test-")),
  );
  t.after(() => fs.rm(path, { recursive: true, force: true }));
  await put(join(path, "index.js"), "one");
  const one = await treeEvidence(path, { linux: true });
  await put(join(path, "index.js"), "two");
  assert.notEqual((await treeEvidence(path)).sha256, one.sha256);
  await fs.writeFile(
    join(path, "sharp.node"),
    Buffer.from("cffaedfe00000000", "hex"),
  );
  await assert.rejects(
    treeEvidence(path, { linux: true }),
    /macOS native binary/,
  );
  await fs.rm(join(path, "sharp.node"));
  await fs.symlink(join(path, "index.js"), join(path, "alias.js"));
  await assert.rejects(treeEvidence(path), /link or special/);
  await fs.rm(join(path, "alias.js"));
  await put(join(path, ".env.production.local"), "private");
  await assert.rejects(treeEvidence(path), /Private configuration/);
});

test("ELF machine is verified against each function target, including shared libraries and explicit arm64", async (t) => {
  const root = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), "web-elf-target-")),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const fn = join(root, "functions/handler.func");
  await fs.mkdir(fn, { recursive: true });
  await put(join(fn, ".vc-config.json"), {
    runtime: "nodejs22.x",
    handler: "index.js",
  });
  const elf = Buffer.alloc(64);
  elf[0] = 0x7f;
  elf.write("ELF", 1);
  elf[4] = 2;
  elf[5] = 1;
  elf.writeUInt16LE(183, 18);
  await fs.writeFile(join(fn, "libvips.so.42"), elf);
  await assert.rejects(
    treeEvidence(root, { linux: true }),
    /ELF architecture does not match/,
  );
  await put(join(fn, ".vc-config.json"), {
    runtime: "nodejs22.x",
    handler: "index.js",
    architecture: "arm64",
  });
  assert.deepEqual(
    (await treeEvidence(root, { linux: true })).nativeArchitectures,
    ["arm64"],
  );
  elf.writeUInt16LE(62, 18);
  await fs.writeFile(join(fn, "libvips.so.42"), elf);
  await assert.rejects(
    treeEvidence(root, { linux: true }),
    /ELF architecture does not match/,
  );
  await put(join(fn, ".vc-config.json"), {
    runtime: "nodejs22.x",
    handler: "index.js",
  });
  assert.deepEqual(
    (await treeEvidence(root, { linux: true })).nativeArchitectures,
    ["x86_64"],
  );
  elf.writeUInt16LE(3, 18);
  await fs.writeFile(join(fn, "libvips.so.42"), elf);
  await assert.rejects(
    treeEvidence(root, { linux: true }),
    /Unsupported native ELF architecture/,
  );
});

test("standalone normalization flattens internal aliases while refusing source links and cycles", async (t) => {
  const path = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), "web-normalize-test-")),
  );
  t.after(() => fs.rm(path, { recursive: true, force: true }));
  const output = join(path, "output");
  await fs.mkdir(join(output, "function.func"), { recursive: true });
  await put(join(output, "function.func/index.js"), "function output");
  await put(
    join(output, "function.func/.env.example"),
    "PUBLIC_API_ORIGIN=https://example.test",
  );
  await fs.symlink("function.func", join(output, "alias.func"));
  await normalizeOutput(output);
  assert.equal(
    (await fs.lstat(join(output, "alias.func"))).isSymbolicLink(),
    false,
  );
  assert.equal(
    await fs.readFile(join(output, "alias.func/index.js"), "utf8"),
    "function output",
  );
  assert.equal(
    await fs
      .lstat(join(output, "function.func/.env.example"))
      .catch(() => null),
    null,
  );
  await put(join(path, "outside.js"), "outside");
  await fs.symlink("../outside.js", join(output, "outside.js"));
  await assert.rejects(normalizeOutput(output), /references the CI workspace/);
  await fs.rm(join(output, "outside.js"));
  await fs.symlink(".", join(output, "cycle"));
  await assert.rejects(normalizeOutput(output), /Cyclic/);
});

test(
  "production local gates, reports and portable packages feed immutable adoption and STAGED upload",
  native,
  async (t) => {
    const f = await fixture(t);
    await build(f);
    const manifest = await read(
      join(f.workspace, "web-artifacts/manifest.json"),
    );
    validateManifest(manifest, WEB_SHA, ROOT_SHA, true, API_SHA);
    assert.equal(manifest.jenkins.buildNumber, 123);
    assert.equal(manifest.gates.acceptance.passed, 2);
    assert.deepEqual(Object.keys(manifest.archives).sort(), [
      "prebuilt.tar.gz",
      "source.tar.gz",
      "storybook.tar.gz",
    ]);
    assert.equal(
      (
        await fs.readFile(
          join(f.workspace, "public-vercel-cache/production.env"),
          "utf8",
        )
      ).includes("private"),
      false,
    );
    assert.equal(
      f.state.calls
        .find((c) => c.args?.[1] === "build" && c.args?.[0] === LINUX_CI.cli)
        .args.includes("--standalone"),
      true,
    );
    for (const call of f.state.calls.filter((c) => c.command)) {
      assert.equal(JSON.stringify(call.env).includes("fake-private"), false);
      assert.equal(JSON.stringify(call.args).includes("fake-private"), false);
    }
    await f.invoke("adopt");
    const immutable = await read(join(f.release, "manifest.json"));
    assert.deepEqual(immutable.archives, manifest.archives);
    const adopted = await f.invoke("adopt");
    assert.equal(adopted.reused, true);
    const staged = await f.invoke("upload");
    assert.equal(staged.state, "staged");
    assert.equal(f.state.promotes, 0);
    const upload = f.state.calls.find((c) => c.args?.[1] === "deploy");
    for (const flag of [
      "--prebuilt",
      "--prod",
      "--skip-domain",
      "--archive=tgz",
    ])
      assert.equal(upload.args.includes(flag), true);
    assert.equal(
      f.state.calls.some((c) => c.args?.includes("--token")),
      false,
    );
    assert.equal((await f.invoke("upload")).reused, true);
    assert.equal(f.state.uploads, 1);
    assert.equal(
      (await read(join(f.release, `publication-${ROOT_SHA}.json`))).state,
      "staged",
    );
  },
);

test(
  "PR CI never receives production settings or trusted upload and still executes all gates",
  native,
  async (t) => {
    const f = await fixture(t);
    f.state.ref = "refs/pull/9/head";
    await f.invoke("checkout");
    for (const gate of GATES) await f.invoke(gate);
    await f.invoke("package");
    const manifest = await read(
      join(f.workspace, "web-artifacts/manifest.json"),
    );
    validateManifest(manifest, WEB_SHA, ROOT_SHA, false, API_SHA);
    assert.equal(manifest.production, false);
    assert.equal(manifest.archives["prebuilt.tar.gz"], undefined);
    assert.equal(
      f.state.calls.some((c) => c.args?.[0] === LINUX_CI.cli),
      false,
    );
    await assert.rejects(f.invoke("upload"), /Only main/);
  },
);

test(
  "moved production ref cancels preparation before any credential-bearing command",
  native,
  async (t) => {
    const f = await fixture(t);
    f.state.sha = "d".repeat(40);
    await assert.rejects(f.invoke("prepare-env"), /branch moved/);
    assert.equal(
      f.state.calls.some((c) => c.args?.[0] === LINUX_CI.cli),
      false,
    );
    await assert.rejects(f.invoke("checkout"), /Ref moved/);
  },
);

test(
  "a failed or skipped gate prevents packaging and is not overwritten by a retry",
  native,
  async (t) => {
    const f = await fixture(t);
    await f.invoke("checkout");
    f.state.fail = "lint";
    await assert.rejects(f.invoke("lint"), /CI gate failed/);
    f.state.fail = null;
    await assert.rejects(f.invoke("lint"), /previous gate failed/);
    await assert.rejects(f.invoke("package"), /previous gate failed/);
    const report = await read(join(f.workspace, "web-artifacts/web-ci.json"));
    assert.equal(report.state, "failed");
    assert.equal(report.gates.lint.state, "failed");
    assert.equal(
      await fs
        .lstat(join(f.workspace, "web-artifacts/manifest.json"))
        .catch(() => null),
      null,
    );
  },
);

test(
  "tests with skip evidence fail their actual phase rather than become a green artifact",
  native,
  async (t) => {
    const f = await fixture(t);
    await f.invoke("checkout");
    f.state.testResult = { ...passed(), numPendingTests: 1 };
    await assert.rejects(f.invoke("acceptance"), /all execute and pass/);
    assert.equal(
      (await read(join(f.workspace, "web-artifacts/web-ci.json"))).gates
        .acceptance.state,
      "failed",
    );
  },
);

test(
  "Mac native dependency in the local Vercel output blocks build and packaging",
  native,
  async (t) => {
    const f = await fixture(t);
    await f.invoke("prepare-env");
    await f.invoke("checkout");
    f.state.mach = true;
    await assert.rejects(f.invoke("build"), /macOS native binary/);
    assert.equal(
      (await read(join(f.workspace, "web-artifacts/web-ci.json"))).gates.build
        .state,
      "failed",
    );
  },
);

test(
  "main is the only new production source; retained migration manifests stay read-only and cannot authorize trusted phases",
  native,
  async (t) => {
    const f = await fixture(t);
    assert.equal(WEB.ref, "refs/heads/main");
    await build(f);
    const manifest = await read(
      join(f.workspace, "web-artifacts/manifest.json"),
    );
    const historical = {
      ...manifest,
      ref: "refs/heads/feat/design-v2-migration",
    };
    const before = JSON.stringify(historical);
    assert.equal(
      validateHistoricalManifest(historical, WEB_SHA, ROOT_SHA, API_SHA),
      historical,
    );
    assert.equal(JSON.stringify(historical), before);
    assert.throws(
      () => validateManifest(historical, WEB_SHA, ROOT_SHA, true, API_SHA),
      /provenance/,
    );
    for (const ref of [
      historical.ref,
      "refs/heads/feature/unapproved",
      "refs/pull/9/head",
    ])
      for (const phase of ["prepare-env", "adopt", "upload", "promote"])
        await assert.rejects(f.invoke(phase, ref), /Only main/);
    assert.equal(f.state.uploads, 0);
    assert.equal(f.state.promotes, 0);
    assert.throws(
      () =>
        validateHistoricalManifest(
          { ...historical, ref: "refs/heads/feature/unapproved" },
          WEB_SHA,
          ROOT_SHA,
          API_SHA,
        ),
      /provenance/,
    );
    assert.throws(
      () =>
        validateHistoricalManifest(
          { ...historical, apiSha: "d".repeat(40) },
          WEB_SHA,
          ROOT_SHA,
          API_SHA,
        ),
      /provenance/,
    );
  },
);

test(
  "tracked or untracked source changes cannot be hidden behind a matching HEAD SHA",
  native,
  async (t) => {
    const f = await fixture(t);
    await f.invoke("checkout");
    f.state.dirty = true;
    await assert.rejects(f.invoke("build"), /Tracked source changed/);
    await f.invoke("checkout");
    f.state.dirty = false;
    f.state.untracked = "src/injected.tsx\0";
    await assert.rejects(f.invoke("build"), /Uncommitted source/);
  },
);

test(
  "tampered archives and SHA/gate provenance are refused without adopting",
  native,
  async (t) => {
    const f = await fixture(t);
    await build(f);
    const manifestPath = join(f.workspace, "web-artifacts/manifest.json"),
      manifest = await read(manifestPath);
    for (const patch of [
      { apiSha: "d".repeat(40) },
      { rootSha: "d".repeat(40) },
      { gates: { ...manifest.gates, acceptance: { state: "failed" } } },
      { jenkins: { ...manifest.jenkins, job: "malicious-pr-job" } },
    ])
      assert.throws(() =>
        validateManifest(
          { ...manifest, ...patch },
          WEB_SHA,
          ROOT_SHA,
          true,
          API_SHA,
        ),
      );
    await fs.appendFile(
      join(f.workspace, "web-artifacts/prebuilt.tar.gz"),
      "changed",
    );
    await assert.rejects(f.invoke("adopt"), /archive changed/);
    assert.equal(await fs.lstat(f.release).catch(() => null), null);
  },
);

test(
  "trusted pin or branch changes during/after CI refuse adoption and publication",
  native,
  async (t) => {
    const f = await fixture(t);
    await build(f);
    await f.invoke("adopt");
    await put(join(f.paths.root, "jenkins-web-pin.json"), {
      repository: "Xeonice/cloud-agent-platform-docs",
      approved: false,
      rootSha: ROOT_SHA,
      apiSha: API_SHA,
      webSha: WEB_SHA,
    });
    await assert.rejects(f.invoke("upload"), /pin is missing or changed/);
    assert.equal(f.state.uploads, 0);
  },
);

test(
  "promotion probes protected API exact SHA, validates remote staged metadata and promotes only uploaded URI",
  native,
  async (t) => {
    const f = await fixture(t);
    await build(f);
    await f.invoke("adopt");
    const staged = await f.invoke("upload");
    const receipt = await f.invoke("promote");
    assert.equal(receipt.state, "promoted");
    assert.equal(receipt.domain, WEB.domain);
    assert.equal(f.state.promotes, 1);
    const call = f.state.calls.find((c) => c.args?.[1] === "promote");
    assert.equal(call.args[2], staged.url);
    const probes = f.state.calls.filter((c) => c.url);
    assert.equal(probes.length, 3);
    assert.equal(
      probes.find((c) => c.url.endsWith("/health")).options.headers
        .Authorization,
      undefined,
    );
    assert.equal(
      probes.find((c) => c.url.endsWith("/version")).options.headers
        .Authorization,
      "Bearer fake-private-runtime-value",
    );
    assert.equal(JSON.stringify(receipt).includes("fake-private"), false);
  },
);

test(
  "unready or wrong API prevents promotion, preserves failure evidence and blocks automatic retry",
  native,
  async (t) => {
    const f = await fixture(t);
    await build(f);
    await f.invoke("adopt");
    await f.invoke("upload");
    f.state.apiSha = "d".repeat(40);
    await assert.rejects(f.invoke("promote"), /API SHA/);
    assert.equal(f.state.promotes, 0);
    const failed = await read(join(f.release, `publication-${ROOT_SHA}.json`));
    assert.equal(failed.state, "failed");
    f.state.apiSha = API_SHA;
    await assert.rejects(f.invoke("promote"), /operator review/);
    assert.deepEqual(
      await read(join(f.release, `publication-${ROOT_SHA}.json`)),
      failed,
    );
  },
);

test(
  "wrong project or mismatching staged deployment metadata cannot be promoted",
  native,
  async (t) => {
    const f = await fixture(t);
    await build(f);
    await f.invoke("adopt");
    await f.invoke("upload");
    f.state.projectId = "old-project";
    await assert.rejects(f.invoke("promote"), /matching staged prebuilt/);
    assert.equal(f.state.promotes, 0);
  },
);

test(
  "the verified hostname still requires exact project, three commits, build and STAGED remote state on reuse",
  native,
  async (t) => {
    const f = await fixture(t);
    await build(f);
    await f.invoke("adopt");
    const staged = await f.invoke("upload");
    assert.equal(staged.deploymentId, actualStagedDeployment.id);
    assert.equal(staged.url, `https://${actualStagedDeployment.url}`);
    const validMeta = {
      jenkinsWebSha: WEB_SHA,
      jenkinsRootSha: ROOT_SHA,
      jenkinsApiSha: API_SHA,
      jenkinsBuildNumber: "123",
    };
    for (const patch of [
      { id: "dpl_Other123" },
      { projectId: "prj_other" },
      { url: "agent-platform-other-xeonices-projects.vercel.app" },
      { readyState: "ERROR" },
      { readySubstate: "PROMOTED" },
      { target: "preview" },
      ...Object.keys(validMeta).map((key) => ({
        meta: { ...validMeta, [key]: "wrong" },
      })),
    ]) {
      f.state.remoteDeploymentPatch = patch;
      await assert.rejects(f.invoke("upload"), /matching staged prebuilt/);
      assert.equal(f.state.uploads, 1);
      assert.equal(f.state.promotes, 0);
    }
    delete f.state.remoteDeploymentPatch;
    assert.equal((await f.invoke("upload")).reused, true);
    assert.equal(
      (await read(join(f.release, `publication-${ROOT_SHA}.json`))).state,
      "staged",
    );
  },
);

test(
  "failed upload records intent/failure and never creates another deployment on retry",
  native,
  async (t) => {
    const f = await fixture(t);
    await build(f);
    await f.invoke("adopt");
    f.state.fail = "upload";
    await assert.rejects(f.invoke("upload"), /Upload failed/);
    assert.equal(f.state.uploads, 1);
    f.state.fail = null;
    await assert.rejects(f.invoke("upload"), /operator review/);
    assert.equal(f.state.uploads, 1);
    assert.equal(
      (await read(join(f.release, `publication-${ROOT_SHA}.json`))).state,
      "failed",
    );
  },
);

test(
  "adopt needs only verified downloaded artifacts, never CI source checkout",
  native,
  async (t) => {
    const f = await fixture(t);
    await build(f);
    await fs.rm(join(f.workspace, "web-source"), { recursive: true });
    await f.invoke("adopt");
    assert.equal((await read(join(f.release, "manifest.json"))).sha, WEB_SHA);
  },
);

test(
  "a stale publication lock never gets stolen and incomplete upload intent cannot be retried",
  native,
  async (t) => {
    const f = await fixture(t);
    await build(f);
    await f.invoke("adopt");
    await put(join(f.release, ".publication.lock"), { pid: 99999999 });
    await assert.rejects(f.invoke("upload"), /operator recovery/);
    assert.equal(f.state.uploads, 0);
    assert.equal(
      (await read(join(f.release, ".publication.lock"))).pid,
      99999999,
    );
    await fs.rm(join(f.release, ".publication.lock"));
    await put(join(f.release, `publication-${ROOT_SHA}.json`), {
      state: "uploading",
      sha: WEB_SHA,
      rootSha: ROOT_SHA,
    });
    await assert.rejects(f.invoke("upload"), /already exists/);
    assert.equal(f.state.uploads, 0);
    assert.equal(
      (await read(join(f.release, `publication-${ROOT_SHA}.json`))).state,
      "uploading",
    );
  },
);

test(
  "immutable adoption reuses original package and original Jenkins build identity",
  native,
  async (t) => {
    const f = await fixture(t);
    await build(f);
    await f.invoke("adopt");
    const original = await read(join(f.release, "manifest.json"));
    const newManifest = await read(
      join(f.workspace, "web-artifacts/manifest.json"),
    );
    newManifest.jenkins.buildNumber = 456;
    await put(join(f.workspace, "web-artifacts/manifest.json"), newManifest);
    const result = await f.invoke("adopt");
    assert.equal(result.reused, true);
    assert.equal(result.jenkins.buildNumber, 123);
    assert.deepEqual(await read(join(f.release, "manifest.json")), original);
  },
);

test(
  "promoted retries verify the real custom-domain alias and refuse another deployment or promotion",
  native,
  async (t) => {
    const f = await fixture(t);
    await build(f);
    await f.invoke("adopt");
    await f.invoke("upload");
    await f.invoke("promote");
    assert.equal((await f.invoke("upload")).reused, true);
    assert.equal((await f.invoke("promote")).reused, true);
    assert.equal(f.state.uploads, 1);
    assert.equal(f.state.promotes, 1);
    for (const patch of [
      { deploymentId: "dpl_Other123" },
      { projectId: "prj_other" },
      { alias: "other.example.com" },
      { redirect: "https://evil.example.com" },
    ]) {
      f.state.aliasPatch = patch;
      await assert.rejects(
        f.invoke("promote"),
        /does not point to this deployment/,
      );
      assert.equal(f.state.uploads, 1);
      assert.equal(f.state.promotes, 1);
    }
    assert.equal(
      (await read(join(f.release, `publication-${ROOT_SHA}.json`))).state,
      "promoted",
    );
  },
);

test(
  "production public settings preparation is read-only and needs no publication approval pin",
  native,
  async (t) => {
    const f = await fixture(t);
    await fs.rm(join(f.paths.root, "jenkins-web-pin.json"));
    await f.invoke("prepare-env");
    const provenance = await read(
      join(f.workspace, "public-vercel-cache/provenance.json"),
    );
    assert.equal(provenance.apiSha, API_SHA);
    const call = f.state.calls.find((c) => c.args?.[1] === "pull");
    assert.equal(call.args.at(-1), f.path);
    assert.equal(resolve(dirname(call.env.HOME)), resolve(tmpdir()));
    assert.match(
      basename(call.env.HOME),
      /^agent-platform-vercel-[A-Za-z0-9]+$/,
    );
    // The CLI never sees the trusted account home, redirected or fixed.
    assert.notEqual(call.env.HOME, f.paths.ownerHome);
    assert.notEqual(call.env.HOME, LINUX_CI.home);
    await assert.rejects(f.invoke("adopt"), /ENOENT/);
  },
);

test(
  "an altered Vercel project link cannot upload to an unrelated project",
  native,
  async (t) => {
    const f = await fixture(t);
    await build(f);
    await f.invoke("adopt");
    await put(join(f.release, ".vercel/project.json"), {
      projectId: "old-project",
      orgId: WEB.orgId,
    });
    await assert.rejects(f.invoke("upload"), /project link changed/);
    assert.equal(f.state.uploads, 0);
  },
);
