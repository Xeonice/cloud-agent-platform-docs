import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HOST_CHECKS,
  TOOL_SOURCES,
  assertPlanHost,
  failureReport,
  hostBindings,
} from "./upgrade-agents.mjs";
import {
  HostLayoutError,
  REQUIRES,
  layoutRecord,
  layoutSha256,
  resolveHostLayout,
} from "../containers/host-layout.mjs";

// upgrade-agents.mjs is the reviewed operator script. Its build/apply phases
// read private env files, Jenkins and three Docker daemons, so only the syntax
// check, the in-memory self-test and its pure helpers run here, with injected
// accounts instead of this machine's. Until the Jenkins contract scans
// deploy/ops (T30), upgrade-agents-entry.test.mjs in deploy/containers runs the
// script's entry points there.
const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "upgrade-agents.mjs");
const run = (args) =>
  spawnSync(process.execPath, args, {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin" },
    timeout: 30_000,
  });

const OPERATOR = Object.freeze({
  username: "operator",
  uid: 5101,
  gid: 20,
  home: "/Users/operator",
});
const NODE = "/opt/node-22/bin/node";
const layoutOf = (identity = OPERATOR, execPath = NODE, overrides = {}) =>
  resolveHostLayout({ identity, execPath, overrides });
const EXECUTABLES = Object.freeze({
  docker: {
    path: "/Users/operator/.orbstack/bin/docker",
    realpath: "/Applications/OrbStack.app/Contents/MacOS/xbin/docker-tools",
    sha256: "1".repeat(64),
  },
  "docker-compose": {
    path: "/Applications/OrbStack.app/Contents/MacOS/xbin/docker-compose",
    realpath: "/Applications/OrbStack.app/Contents/MacOS/xbin/docker-tools",
    sha256: "1".repeat(64),
  },
});
// The host part of a plan as build writes it, after a JSON round trip.
function planFor(layout, changes = {}) {
  return JSON.parse(
    JSON.stringify({
      schemaVersion: 2,
      state: "built-not-applied",
      root: "/Users/operator/.local/share/agent-platform-jenkins-tools/upgrade-src-x",
      rootSha: "a".repeat(40),
      hostLayout: layoutRecord(layout),
      hostLayoutSha256: layoutSha256(layout),
      hostExecutables: EXECUTABLES,
      env: {
        stack: { path: layout.stackEnv, sha256: "2".repeat(64) },
        runtime: { path: layout.runtimeEnv, sha256: "3".repeat(64) },
      },
      ...changes,
    }),
  );
}

test("the agent upgrade script parses under the running Node", () => {
  const result = run(["--check", script]);
  assert.equal(result.status, 0, result.stderr);
});

test("the agent upgrade self-test passes without Docker, Jenkins or private files", () => {
  const result = run([script, "self-test"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    state: "pure-self-tests-passed",
    cases: 19,
  });
});

test("the script names no host: paths, account and UID come only from host-layout", () => {
  const source = readFileSync(script, "utf8");
  for (const literal of [
    /\/Users\//,
    /douglasdong/,
    /\.orbstack/,
    /fnm\/node-versions/,
    /\b501\b/,
    /process\.env/,
    /homedir\(/,
    /userInfo\(/,
  ])
    assert.doesNotMatch(source, literal);
  assert.equal(
    source.match(/from "[^"]*host-layout\.mjs"/g).join(),
    'from "../containers/host-layout.mjs"',
  );
  // apply pins exactly these two files to the clean main checkout.
  const root = join(here, "../..");
  assert.equal(join(root, TOOL_SOURCES.script), script);
  assert.equal(
    join(root, TOOL_SOURCES.module),
    join(here, "../containers/host-layout.mjs"),
  );
});

test("build checks only what exists before disaster recovery step 5.7; apply checks all it touches", () => {
  assert.deepEqual(HOST_CHECKS, {
    build: "upgrade-build",
    apply: "upgrade-apply",
  });
  const build = REQUIRES[HOST_CHECKS.build];
  const apply = REQUIRES[HOST_CHECKS.apply];
  for (const key of [
    "identity",
    "colimaEnv",
    "overrideFile",
    "privateDir",
    "dockerConfig",
    "stackEnv",
    "runtimeEnv",
    "dockerCli",
    "node",
    "socket:build",
  ]) {
    assert.ok(build.includes(key), key);
    assert.ok(apply.includes(key), key);
  }
  for (const key of ["adminApi", "socket:runtime", "socket:jenkins"]) {
    assert.ok(!build.includes(key), key);
    assert.ok(apply.includes(key), key);
  }
});

test("child environment, private paths and Docker CLI follow the passwd account and Node", () => {
  for (const [identity, node, overrides, docker] of [
    [OPERATOR, NODE, {}, "/Users/operator/.orbstack/bin/docker"],
    [
      { username: "ops.2", uid: 502, gid: 20, home: "/Volumes/Data/ops.2" },
      "/usr/local/node22/bin/node",
      { dockerCli: "/opt/homebrew/bin/docker" },
      "/opt/homebrew/bin/docker",
    ],
  ]) {
    const layout = layoutOf(identity, node, overrides);
    const bound = hostBindings(layout);
    const tools = `${identity.home}/.local/share/agent-platform-jenkins-tools`;
    // Same keys, order and fixed values as the child environment before the
    // host layout; only the account- and Node-dependent values vary.
    assert.deepEqual(Object.entries(bound.env), [
      ["PATH", `${dirname(node)}:/usr/local/bin:/usr/bin:/bin`],
      ["HOME", identity.home],
      ["USER", identity.username],
      ["LOGNAME", identity.username],
      ["LANG", "en_US.UTF-8"],
      ["DOCKER_CONFIG", `${tools}/container-docker-context`],
      ["CI", "1"],
      ["GIT_TERMINAL_PROMPT", "0"],
      ["VERCEL_TELEMETRY_DISABLED", "1"],
      ["NEXT_TELEMETRY_DISABLED", "1"],
    ]);
    assert.deepEqual(
      {
        uid: bound.uid,
        docker: bound.docker,
        stack: bound.stack,
        runtime: bound.runtime,
        admin: bound.admin,
      },
      {
        uid: identity.uid,
        docker,
        stack: `${tools}/container-stack.env`,
        runtime: `${tools}/container-runtime.env`,
        admin: `${tools}/admin-api.json`,
      },
    );
    assert.equal(bound.layout, layout);
    assert.ok(Object.isFrozen(bound) && Object.isFrozen(bound.env));
  }
});

test("apply accepts a plan only on the host layout and Docker executables it was built with", () => {
  const layout = layoutOf();
  assertPlanHost(planFor(layout), layout, EXECUTABLES);

  const refused = (plan, current, executables, code, message) =>
    assert.throws(
      () => assertPlanHost(plan, current, executables),
      (error) => {
        assert.equal(error.code, code, error.message);
        if (message) assert.match(error.message, message);
        return true;
      },
    );
  // Another Node, account, override file or Colima layout: re-derived layouts differ.
  for (const [current, field] of [
    [layoutOf(OPERATOR, "/opt/node-22.24/bin/node"), "node"],
    [layoutOf({ ...OPERATOR, uid: 5102 }), "operator.uid"],
    [
      layoutOf({ ...OPERATOR, username: "other", home: "/Users/other" }),
      "operator.username",
    ],
    [
      layoutOf(OPERATOR, NODE, { dockerCli: "/usr/local/bin/docker" }),
      "dockerCli",
    ],
    [
      layoutOf(OPERATOR, NODE, { homebrewPrefix: "/usr/local" }),
      "homebrewPrefix",
    ],
  ])
    assert.throws(
      () => assertPlanHost(planFor(layout), current, EXECUTABLES),
      (error) => {
        assert.ok(error instanceof HostLayoutError, error.message);
        assert.equal(error.code, "HL_LAYOUT_CHANGED");
        assert.equal(error.key, field);
        return true;
      },
    );
  // Plans of the previous script (schema 1) and malformed plans.
  for (const changes of [
    { schemaVersion: 1 },
    { schemaVersion: "2" },
    { hostLayout: undefined },
  ]) {
    const plan = planFor(layout, changes);
    if ("hostLayout" in changes) delete plan.hostLayout;
    refused(plan, layout, EXECUTABLES, "UA_REFUSED");
  }
  refused(
    planFor(layout, { schemaVersion: 1 }),
    layout,
    EXECUTABLES,
    "UA_REFUSED",
    /previous script/,
  );
  refused(null, layout, EXECUTABLES, "UA_REFUSED");
  for (const changes of [
    { state: "three-agents-upgraded-jenkins-still-quiesced" },
    { rootSha: "a".repeat(39) },
    { root: "upgrade-src-x" },
    { root: undefined },
    { hostLayout: null },
  ])
    refused(
      planFor(layout, changes),
      layout,
      EXECUTABLES,
      "UA_REFUSED",
      /^Build plan refused$/,
    );
  // A hand-edited layout record is caught field by field, and its digest too.
  refused(
    planFor(layout, {
      hostLayout: {
        ...layoutRecord(layout),
        stackEnv: "/Users/operator/stack.env",
      },
    }),
    layout,
    EXECUTABLES,
    "HL_LAYOUT_CHANGED",
  );
  refused(
    planFor(layout, { hostLayoutSha256: "0".repeat(64) }),
    layout,
    EXECUTABLES,
    "UA_REFUSED",
    /layout record/,
  );
  // env paths of the plan must be the layout's private env files.
  refused(
    planFor(layout, {
      env: {
        stack: { path: layout.stackEnv },
        runtime: { path: layout.privateDir + "/other.env" },
      },
    }),
    layout,
    EXECUTABLES,
    "UA_REFUSED",
    /Private env paths/,
  );
  refused(
    planFor(layout, { env: {} }),
    layout,
    EXECUTABLES,
    "UA_REFUSED",
    /Private env paths/,
  );
  // Another Docker CLI or plugin binary, a moved link or an added plugin.
  for (const executables of [
    {
      ...EXECUTABLES,
      docker: { ...EXECUTABLES.docker, sha256: "4".repeat(64) },
    },
    {
      ...EXECUTABLES,
      "docker-compose": {
        ...EXECUTABLES["docker-compose"],
        realpath: "/opt/homebrew/lib/docker/cli-plugins/docker-compose",
      },
    },
    {
      ...EXECUTABLES,
      "docker-buildx": { ...EXECUTABLES.docker },
    },
    { docker: EXECUTABLES.docker },
  ])
    refused(
      planFor(layout),
      layout,
      executables,
      "UA_REFUSED",
      /Docker CLI or plugins/,
    );
});

test("failure reports carry a reason code and a redacted summary, never private input", () => {
  assert.deepEqual(
    failureReport(
      new HostLayoutError("HL_PRIVATE_FILE", "Private file refused", {
        path: "/Users/operator/.local/share/agent-platform-jenkins-tools/container-stack.env",
        key: "stackEnv",
      }),
    ),
    {
      code: "HL_PRIVATE_FILE",
      reason: "Private file refused",
      path: "/Users/operator/.local/share/agent-platform-jenkins-tools/container-stack.env",
      check: "stackEnv",
    },
  );
  assert.deepEqual(
    failureReport(new HostLayoutError("HL_PLATFORM", "Not a Mac")),
    { code: "HL_PLATFORM", reason: "Not a Mac" },
  );
  assert.deepEqual(
    failureReport(
      Object.assign(new Error("Source checkout is dirty"), {
        code: "UA_REFUSED",
      }),
    ),
    { code: "UA_REFUSED", reason: "Source checkout is dirty" },
  );
  assert.deepEqual(
    failureReport(
      Object.assign(new Error("Private file identity refused"), {
        code: "UA_REFUSED",
        path: "/Users/operator/out/plan.json",
      }),
    ),
    {
      code: "UA_REFUSED",
      reason: "Private file identity refused",
      path: "/Users/operator/out/plan.json",
    },
  );
  // JSON.parse quotes its input, for example a damaged admin-api.json.
  let syntax;
  try {
    JSON.parse("s3cr3t-11a2b3c4d5e6");
  } catch (error) {
    syntax = error;
  }
  assert.match(syntax.message, /s3cr3t-11a2b3c4d5e6/);
  assert.deepEqual(failureReport(syntax), {
    code: "UA_UNEXPECTED",
    reason: "SyntaxError (text withheld; it may quote private input)",
  });
  // Credentials that reach a message by other ways are masked.
  assert.equal(
    failureReport(new Error("request with Basic dTpzZWNyZXQ= failed")).reason,
    "request with Basic [REDACTED] failed",
  );
  assert.equal(
    failureReport(new Error("password: hunter22, token=abc123")).reason,
    "password: [REDACTED], token=[REDACTED]",
  );
  // System and fetch errors keep their codes; other values are unexpected.
  assert.deepEqual(
    failureReport(
      Object.assign(
        new Error("EEXIST: file already exists, mkdir '/Users/operator/out'"),
        { code: "EEXIST", syscall: "mkdir", path: "/Users/operator/out" },
      ),
    ),
    {
      code: "EEXIST",
      reason: "EEXIST: file already exists, mkdir '/Users/operator/out'",
      path: "/Users/operator/out",
    },
  );
  assert.deepEqual(
    failureReport(
      new TypeError("fetch failed", {
        cause: Object.assign(new Error("connect"), { code: "ECONNREFUSED" }),
      }),
    ),
    { code: "UA_UNEXPECTED", reason: "fetch failed (ECONNREFUSED)" },
  );
  assert.deepEqual(
    failureReport(
      new DOMException(
        "The operation was aborted due to timeout",
        "TimeoutError",
      ),
    ),
    {
      code: "UA_UNEXPECTED",
      reason: "The operation was aborted due to timeout",
    },
  );
  for (const thrown of [undefined, "plain", 42, { code: "lower" }])
    assert.equal(failureReport(thrown).code, "UA_UNEXPECTED");
  assert.equal(failureReport(new Error("x".repeat(2000))).reason.length, 500);
});
