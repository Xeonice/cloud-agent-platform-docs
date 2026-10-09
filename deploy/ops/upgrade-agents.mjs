// Reviewed operator tool only. Writing this file does not run any phase.
// Node22 ...mjs build CLEAN_MAIN_CHECKOUT ROOT40 FRESH_OUTPUT
// Node22 ...mjs apply FRESH_OUTPUT/plan.json
// Node22 ...mjs self-test
// Host paths, the operator account and its UID come from
// ../containers/host-layout.mjs: the passwd account running this script, never
// HOME, USER or another environment variable.
import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { join, resolve, dirname, relative, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import {
  HostLayoutError,
  assertJenkinsListener,
  assertSameLayout,
  assertTrustedExecutable,
  childEnvironment,
  dockerHostArgs,
  layoutRecord,
  layoutSha256,
  loadHostLayout,
  moduleIdentity,
  resolveHostLayout,
  verifyHostLayout,
} from "../containers/host-layout.mjs";
// Host checks of each action. build uses only the build daemon and runs
// before admin-api.json is restored (disaster recovery 5.6); apply also needs
// the runtime and jenkins sockets and the Jenkins credential.
export const HOST_CHECKS = Object.freeze({
  build: "upgrade-build",
  apply: "upgrade-apply",
});
// build may run from any checkout (a same-SHA comparison before a merge) and
// records where these ran from; apply runs them only from the clean main
// checkout of the plan, byte-equal to `git show SHA:path`.
export const TOOL_SOURCES = Object.freeze({
  script: "deploy/ops/upgrade-agents.mjs",
  module: "deploy/containers/host-layout.mjs",
});
const PLAN_SCHEMA_VERSION = 2;
const JOBS = [
  "agent-platform-api",
  "agent-platform-ci-discovery",
  "agent-platform-contract",
  "agent-platform-mutation",
  "agent-platform-native-ci",
  "agent-platform-release",
  "agent-platform-sandbox-images",
  "agent-platform-service-monitor",
  "agent-platform-web",
];
const NODES = ["linux-ci", "linux-web-amd64", "linux-deploy"];
const SHA = /^[a-f0-9]{40}$/,
  IMAGE = /^sha256:[a-f0-9]{64}$/;
// Private paths, Docker CLI, child environment and UID of one host layout.
// main() binds them once the host checks of its action passed.
export function hostBindings(layout) {
  return Object.freeze({
    layout,
    uid: layout.operator.uid,
    docker: layout.dockerCli,
    stack: layout.stackEnv,
    runtime: layout.runtimeEnv,
    admin: layout.adminApi,
    env: Object.freeze({
      ...childEnvironment(layout),
      CI: "1",
      GIT_TERMINAL_PROMPT: "0",
      VERCEL_TELEMETRY_DISABLED: "1",
      NEXT_TELEMETRY_DISABLED: "1",
    }),
  });
}
let stage = "not-started",
  output,
  host,
  secrets = [];
const sha = (b) => createHash("sha256").update(b).digest("hex");
const canonical = (p) =>
  resolve(p)
    .replace(/^\/tmp(?=\/|$)/, "/private/tmp")
    .replace(/^\/var(?=\/|$)/, "/private/var");
// Refusals carry a fixed, reviewed message (reason code UA_REFUSED) and, for
// file checks, the path concerned.
const refusal = (message, path) =>
  Object.assign(Error(message), { code: "UA_REFUSED", ...(path && { path }) });
function check(ok, message, path) {
  if (!ok) throw refusal(message, path);
}
const scrub = (text) => {
  let s = String(text);
  for (const value of secrets) s = s.split(value).join("[REDACTED]");
  return s
    .replace(/(Bearer|Basic)\s+[^\s]+/gi, "$1 [REDACTED]")
    .replace(
      /((?:token|passcode|password|cookie_secret|master_key)\s*[=:]\s*)[^\s,;]+/gi,
      "$1[REDACTED]",
    );
};
async function noLinks(path) {
  let p = "/";
  for (const part of canonical(path).split("/").filter(Boolean)) {
    p = join(p, part);
    const s = await fs.lstat(p);
    check(!s.isSymbolicLink(), "Symlink in operator path", p);
  }
}
async function ownerFile(path) {
  await noLinks(path);
  const h = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = await h.stat();
    check(
      s.isFile() &&
        s.nlink === 1 &&
        s.uid === host.uid &&
        (s.mode & 0o777) === 0o600 &&
        s.size < 8_000_000,
      "Private file identity refused",
      path,
    );
    const bytes = await h.readFile(),
      after = await h.stat();
    check(
      s.size === after.size &&
        s.mtimeMs === after.mtimeMs &&
        s.ctimeMs === after.ctimeMs,
      "Private input changed during read",
      path,
    );
    return { bytes, dev: s.dev, ino: s.ino, hash: sha(bytes) };
  } finally {
    await h.close();
  }
}
async function publicFile(path) {
  await noLinks(path);
  const h = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = await h.stat();
    check(
      s.isFile() && s.nlink === 1 && s.size < 20_000_000,
      "Public input identity refused",
      path,
    );
    return await h.readFile();
  } finally {
    await h.close();
  }
}
function parseEnv(bytes) {
  const lines = bytes.toString("utf8").split(/\r?\n/),
    values = {},
    keys = [];
  for (const line of lines) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    check(
      m && !Object.hasOwn(values, m[1]),
      "Private env has unsupported or duplicate assignments",
    );
    values[m[1]] = m[2];
    keys.push(m[1]);
  }
  return { values, keys };
}
export function patchImages(bytes, updates) {
  const env = parseEnv(bytes);
  for (const [key, value] of Object.entries(updates)) {
    check(
      ["CI_IMAGE", "WEB_CI_IMAGE", "DEPLOY_IMAGE"].includes(key),
      "Only three agent image keys may be patched",
    );
    check(
      Object.hasOwn(env.values, key) &&
        IMAGE.test(env.values[key]) &&
        IMAGE.test(value),
      "Image assignment refused",
    );
  }
  const pieces = [];
  let start = 0;
  for (let end = 0; end <= bytes.length; end++) {
    if (end !== bytes.length && bytes[end] !== 10) continue;
    const line = bytes.subarray(start, end),
      cr = line.at(-1) === 13 ? 1 : 0,
      body = line.subarray(0, line.length - cr),
      eq = body.indexOf(61),
      key = eq >= 0 ? body.subarray(0, eq).toString() : null;
    pieces.push(
      Object.hasOwn(updates, key)
        ? Buffer.concat([
            body.subarray(0, eq + 1),
            Buffer.from(updates[key]),
            line.subarray(line.length - cr),
          ])
        : line,
    );
    if (end < bytes.length) pieces.push(Buffer.from("\n"));
    start = end + 1;
  }
  return Buffer.concat(pieces);
}
async function envSnapshot(path) {
  const f = await ownerFile(path),
    p = parseEnv(f.bytes);
  secrets.push(
    ...Object.entries(p.values)
      .filter(([k, v]) => !k.endsWith("_IMAGE") && v.length >= 4)
      .map(([, v]) => v),
  );
  return {
    ...f,
    path,
    keys: p.keys,
    images: Object.fromEntries(
      Object.entries(p.values).filter(([k]) =>
        ["CI_IMAGE", "WEB_CI_IMAGE", "DEPLOY_IMAGE"].includes(k),
      ),
    ),
  };
}
function envProof(f) {
  return {
    path: f.path,
    dev: f.dev,
    ino: f.ino,
    sha256: f.hash,
    keys: f.keys,
    images: f.images,
  };
}
async function jsonFile(path, value) {
  await fs.writeFile(path, JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
}
async function checkpoint(data) {
  if (!output) return;
  const p = join(output, "apply-checkpoint.json"),
    t = p + "." + randomUUID();
  await fs.writeFile(
    t,
    JSON.stringify({ stage, at: new Date().toISOString(), ...data }, null, 2) +
      "\n",
    { mode: 0o600, flag: "wx" },
  );
  await fs.rename(t, p);
}
async function command(cmd, args, { cwd, log, timeoutMs = 30 * 60_000 } = {}) {
  const h = log ? await fs.open(log, "wx", 0o600) : null;
  let capture = "",
    count = 0,
    writes = Promise.resolve(),
    overflow = false,
    timedOut = false;
  const child = spawn(cmd, args, {
    cwd,
    env: host.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 5000).unref();
  }, timeoutMs);
  timer.unref();
  function listen(stream) {
    let pending = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      pending += chunk;
      let i;
      while ((i = pending.indexOf("\n")) >= 0) {
        line(pending.slice(0, i + 1));
        pending = pending.slice(i + 1);
      }
      if (pending.length >= 8_000_000) {
        overflow = true;
        child.kill("SIGTERM");
        pending = "";
      }
    });
    stream.on("end", () => line(pending));
  }
  function line(text) {
    count += Buffer.byteLength(text);
    if (!h) {
      if (count >= 32_000_000) {
        overflow = true;
        child.kill("SIGTERM");
      } else capture += text;
    } else writes = writes.then(() => h.write(scrub(text)));
  }
  listen(child.stdout);
  listen(child.stderr);
  try {
    const r = await new Promise((yes, no) => {
      child.once("error", () =>
        no(refusal("Operator subprocess could not start")),
      );
      child.once("close", (code, signal) => yes({ code, signal }));
    });
    await writes;
    check(
      r.code === 0 && !r.signal && !overflow && !timedOut,
      "Operator subprocess failed; inspect redacted phase log",
    );
    return capture;
  } finally {
    clearTimeout(timer);
    if (h) await h.close();
  }
}
const docker = (profile, args, options) =>
  command(
    host.docker,
    [...dockerHostArgs(host.layout, profile), ...args],
    options,
  );
async function sourceCheck(root, expected) {
  check(SHA.test(expected), "Root SHA must be full forty hex characters");
  await noLinks(root);
  check(
    (
      await command("/usr/bin/git", ["rev-parse", "HEAD"], { cwd: root })
    ).trim() === expected,
    "Source HEAD differs from main approval",
  );
  check(
    !(
      await command(
        "/usr/bin/git",
        ["status", "--porcelain=v1", "--untracked-files=all"],
        { cwd: root },
      )
    ).trim(),
    "Source checkout is dirty",
  );
  const remote = (
    await command("/usr/bin/git", ["remote", "get-url", "origin"], {
      cwd: root,
    })
  ).trim();
  check(
    [
      "git@github.com:Xeonice/cloud-agent-platform-docs.git",
      "https://github.com/Xeonice/cloud-agent-platform-docs.git",
    ].includes(remote),
    "Source repository differs from approved root",
  );
  check(
    (
      await command(
        "/usr/bin/git",
        ["ls-remote", "--exit-code", "origin", "refs/heads/main"],
        { cwd: root },
      )
    ).trim() ===
      expected + "\trefs/heads/main",
    "Remote root main moved",
  );
}
// Where this script and the host-layout module were loaded from, their bytes,
// and whether both are the files of the clean checkout root at rev.
async function toolSources(root, rev) {
  const script = await fs.realpath(fileURLToPath(import.meta.url));
  const found = {
    script: { path: script, sha256: sha(await fs.readFile(script)) },
    module: { ...(await moduleIdentity()) },
  };
  for (const [key, source] of Object.entries(TOOL_SOURCES)) {
    const tracked =
      found[key].path === join(root, source)
        ? await command("/usr/bin/git", ["show", rev + ":" + source], {
            cwd: root,
          }).then(
            (text) => sha(Buffer.from(text)),
            () => null,
          )
        : null;
    found[key].pinned = found[key].sha256 === tracked;
  }
  return found;
}
// The Docker CLI and the Compose/Buildx plugins it loads reach the three
// sockets; the plan binds their real paths and bytes.
async function hostExecutables(layout) {
  const { results } = await verifyHostLayout(layout, ["dockerConfig"]);
  const found = {};
  for (const [name, path] of [
    ["docker", layout.dockerCli],
    ...Object.entries(results.dockerConfig.plugins).map(([plugin, entry]) => [
      plugin,
      entry.path,
    ]),
  ]) {
    const { realpath, sha256 } = await assertTrustedExecutable(
      path,
      layout.operator,
      { hash: true },
    );
    found[name] = { path, realpath, sha256 };
  }
  return found;
}
// A plan applies only on the host it was built on: the same layout (account,
// Node, overrides), private env paths and Docker executables.
export function assertPlanHost(p, layout, executables) {
  check(
    p?.schemaVersion === PLAN_SCHEMA_VERSION,
    "Build plan schema refused; a plan of the previous script applies only with that script",
  );
  check(
    p.state === "built-not-applied" &&
      SHA.test(p.rootSha) &&
      typeof p.root === "string" &&
      isAbsolute(p.root) &&
      p.hostLayout !== null &&
      typeof p.hostLayout === "object",
    "Build plan refused",
  );
  assertSameLayout(p.hostLayout, layout);
  check(
    p.hostLayoutSha256 === layoutSha256(layout),
    "Host layout record differs from the build plan",
  );
  check(
    p.env?.stack?.path === layout.stackEnv &&
      p.env?.runtime?.path === layout.runtimeEnv,
    "Private env paths differ from the host layout",
  );
  check(
    JSON.stringify(p.hostExecutables) === JSON.stringify(executables),
    "Docker CLI or plugins changed since the build plan",
  );
}
async function assertPinnedTools(p) {
  check(
    p.script?.pinned === true && p.hostLayoutModule?.pinned === true,
    "Build plan was not made by the scripts of its clean main checkout; build again from that checkout",
  );
  const tools = await toolSources(p.root, p.rootSha);
  check(
    tools.script.pinned && tools.module.pinned,
    "Run apply with the scripts of the clean main checkout of the plan",
  );
  check(
    tools.script.sha256 === p.script.sha256 &&
      tools.module.sha256 === p.hostLayoutModule.sha256,
    "Reviewed operator script changed",
  );
}
async function contextProof(context, root, expectedSha) {
  const mb = await publicFile(join(context, "context-manifest.json")),
    m = JSON.parse(mb),
    files = [];
  for (const f of m.files) {
    for (const p of [f.source, f.target])
      check(
        typeof p === "string" &&
          !isAbsolute(p) &&
          !p.split("/").some((x) => !x || x === "." || x === "..") &&
          !p.includes("\\"),
        "Context path refused",
      );
    const a = await publicFile(join(root, f.source)),
      b = await publicFile(join(context, f.target));
    check(
      sha(a) === f.sha256 && sha(b) === f.sha256 && b.length === f.sizeBytes,
      "Public context differs from pinned source",
    );
    const git = await command(
      "/usr/bin/git",
      ["show", expectedSha + ":" + f.source],
      { cwd: root },
    );
    check(
      sha(Buffer.from(git)) === f.sha256,
      "Context input is not pinned tracked source",
    );
    files.push({
      source: f.source,
      target: f.target,
      sizeBytes: f.sizeBytes,
      sha256: f.sha256,
    });
  }
  return { path: context, manifestSha256: sha(mb), files };
}
async function image(profile, id, expected = {}) {
  check(IMAGE.test(id), "Immutable image ID required");
  const [r] = JSON.parse(await docker(profile, ["image", "inspect", id]));
  check(
    r.Id === id &&
      r.Os === "linux" &&
      (!expected.arch || r.Architecture === expected.arch),
    "Docker image identity or architecture mismatch",
  );
  if (expected.rootSha)
    check(
      r.Config.Labels?.["com.agent-platform.root-sha"] === expected.rootSha,
      "Image root label differs",
    );
  if (expected.contextHash)
    check(
      r.Config.Labels?.["com.agent-platform.context-sha256"] ===
        expected.contextHash,
      "Image public context label differs",
    );
  return { id: r.Id, os: r.Os, arch: r.Architecture };
}
async function probeImage(profile, id, arch, context) {
  const files = Object.fromEntries(
    context.files
      .filter(
        (x) =>
          x.target.startsWith("tools/") ||
          x.target.startsWith("container-tools/"),
      )
      .map((x) => ["/opt/agent-platform/" + x.target, x.sha256]),
  );
  const program = `import fs from 'node:fs/promises';import{createHash}from'node:crypto';if(process.getuid()!==1000||process.platform!=='linux'||process.arch!==${JSON.stringify(arch === "amd64" ? "x64" : "arm64")}||process.versions.node!=='22.23.3')throw Error('Image execution identity differs');for(const[p,h]of Object.entries(${JSON.stringify(files)})){const s=await fs.lstat(p);if(!s.isFile()||s.uid!==0||(s.mode&18))throw Error('Public tools are writable');if(createHash('sha256').update(await fs.readFile(p)).digest('hex')!==h)throw Error('Image tools differ');}console.log(JSON.stringify({state:'public-tools-verified',files:${Object.keys(files).length},arch:process.arch}));`;
  await docker(
    profile,
    [
      "run",
      "--rm",
      "--network=none",
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--user",
      "1000:1000",
      "--entrypoint",
      "/usr/local/bin/node",
      id,
      "--input-type=module",
      "-e",
      program,
    ],
    { timeoutMs: 90_000 },
  );
}
async function build(root, expected, destination, executables) {
  stage = "not-started";
  output = canonical(destination);
  await noLinks(dirname(output));
  await fs.mkdir(output, { mode: 0o700 });
  root = await fs.realpath(root);
  stage = "source-check";
  await sourceCheck(root, expected);
  const stack = await envSnapshot(host.stack),
    runtime = await envSnapshot(host.runtime);
  const { prepareContext } = await import(
      pathToFileURL(join(root, "deploy/containers/prepare-context.mjs"))
    ),
    { prepareDeployContext } = await import(
      pathToFileURL(join(root, "deploy/containers/prepare-deploy-context.mjs"))
    );
  const ci = await prepareContext("ci", root, output),
    dep = await prepareDeployContext(root, output),
    cp = await contextProof(ci.context, root, expected),
    dp = await contextProof(dep.context, root, expected),
    images = {};
  for (const arch of ["arm64", "amd64"]) {
    stage = "build-ci-" + arch;
    const tag = "agent-platform-ci:main-" + expected.slice(0, 12) + "-" + arch,
      iid = join(output, "ci-" + arch + ".iid");
    await docker(
      "build",
      [
        "build",
        "--platform",
        "linux/" + arch,
        "--label",
        "com.agent-platform.root-sha=" + expected,
        "--label",
        "com.agent-platform.context-sha256=" + cp.manifestSha256,
        "--tag",
        tag,
        "--iidfile",
        iid,
        "--file",
        join(ci.context, "ci.Dockerfile"),
        ci.context,
      ],
      { log: join(output, "build-ci-" + arch + ".redacted.log") },
    );
    const id = (await fs.readFile(iid, "utf8")).trim();
    images[arch] = {
      ...(await image("build", id, {
        arch,
        rootSha: expected,
        contextHash: cp.manifestSha256,
      })),
      tag,
    };
    check(
      JSON.parse(await docker("build", ["image", "inspect", tag]))[0].Id === id,
      "CI tag and iidfile differ",
    );
    await probeImage("build", id, arch, cp);
  }
  stage = "build-deploy";
  const tag = "agent-platform-deploy:main-" + expected.slice(0, 12),
    iid = join(output, "deploy.iid");
  check(
    JSON.parse(await docker("build", ["image", "inspect", images.arm64.tag]))[0]
      .Id === images.arm64.id,
    "ARM base tag moved",
  );
  await docker(
    "build",
    [
      "build",
      "--platform",
      "linux/arm64",
      "--build-arg",
      "CI_BASE_IMAGE=" + images.arm64.tag,
      "--label",
      "com.agent-platform.root-sha=" + expected,
      "--label",
      "com.agent-platform.context-sha256=" + dp.manifestSha256,
      "--label",
      "com.agent-platform.ci-base-image=" + images.arm64.id,
      "--tag",
      tag,
      "--iidfile",
      iid,
      "--file",
      join(dep.context, "deploy.Dockerfile"),
      dep.context,
    ],
    { log: join(output, "build-deploy.redacted.log") },
  );
  const id = (await fs.readFile(iid, "utf8")).trim();
  images.deploy = {
    ...(await image("build", id, {
      arch: "arm64",
      rootSha: expected,
      contextHash: dp.manifestSha256,
    })),
    tag,
    baseImage: images.arm64.id,
  };
  check(
    JSON.parse(await docker("build", ["image", "inspect", tag]))[0].Id === id,
    "Deploy tag and iidfile differ",
  );
  check(
    JSON.parse(await docker("build", ["image", "inspect", id]))[0].Config
      .Labels["com.agent-platform.ci-base-image"] === images.arm64.id,
    "Deploy base label differs",
  );
  await probeImage("build", id, "arm64", dp);
  await sourceCheck(root, expected);
  const tools = await toolSources(root, expected);
  const plan = {
    schemaVersion: PLAN_SCHEMA_VERSION,
    state: "built-not-applied",
    root,
    rootSha: expected,
    output,
    scriptSha256: sha(await fs.readFile(process.argv[1])),
    script: tools.script,
    hostLayout: layoutRecord(host.layout),
    hostLayoutSha256: layoutSha256(host.layout),
    hostLayoutModule: tools.module,
    hostExecutables: executables,
    contexts: { ci: cp, deploy: dp },
    images,
    env: { stack: envProof(stack), runtime: envProof(runtime) },
    compose: {
      ci: {
        path: join(root, "deploy/containers/compose.ci.json"),
        sha256: sha(
          await publicFile(join(root, "deploy/containers/compose.ci.json")),
        ),
      },
      runtime: {
        path: join(root, "deploy/containers/compose.runtime.json"),
        sha256: sha(
          await publicFile(
            join(root, "deploy/containers/compose.runtime.json"),
          ),
        ),
      },
    },
  };
  await jsonFile(join(output, "plan.json"), plan);
  console.log(
    JSON.stringify({
      state: plan.state,
      rootSha: expected,
      plan: join(output, "plan.json"),
      // false: built by scripts outside the clean checkout; apply refuses it.
      pinned: tools.script.pinned && tools.module.pinned,
      images,
      envKeys: { stack: stack.keys, runtime: runtime.keys },
    }),
  );
}
async function jenkins(path) {
  const f = await ownerFile(host.admin),
    v = JSON.parse(f.bytes);
  check(
    typeof v.username === "string" && typeof v.token === "string",
    "Jenkins private API credential refused",
  );
  secrets.push(v.token);
  const url = new URL("http://127.0.0.1:8080/");
  url.pathname = "/" + path.split("?")[0];
  url.search = path.includes("?") ? path.slice(path.indexOf("?")) : "";
  check(url.origin === "http://127.0.0.1:8080", "Jenkins transport refused");
  // Loopback ports are first come, first served across accounts: the
  // credential goes only to a listener the operator holds.
  await assertJenkinsListener(Number(url.port), host.layout.operator);
  const r = await fetch(url, {
    headers: {
      Authorization:
        "Basic " + Buffer.from(v.username + ":" + v.token).toString("base64"),
    },
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  check(r.ok, "Jenkins read-only readiness request failed");
  return r.json();
}
async function idle(initial = false) {
  const [j, q, c, d, r] = await Promise.all([
    jenkins("api/json?tree=quietingDown,jobs[name,builds[number,building]]"),
    jenkins("queue/api/json?tree=items[id]"),
    jenkins(
      "computer/api/json?tree=computer[displayName,offline,temporarilyOffline,executors[idle,currentExecutable[url]],oneOffExecutors[idle,currentExecutable[url]]]",
    ),
    jenkins("job/agent-platform-ci-discovery/api/json?tree=disabled"),
    jenkins("job/agent-platform-release/api/json?tree=disabled"),
  ]);
  check(
    j.quietingDown === true && d.disabled === true && r.disabled === true,
    "Jenkins must remain quieting down with Discovery/Release disabled",
  );
  check(
    JSON.stringify(j.jobs.map((x) => x.name).sort()) ===
      JSON.stringify([...JOBS].sort()),
    "Jenkins canonical job inventory differs",
  );
  check(
    !j.jobs.some((x) => x.builds?.some((b) => b.building)),
    "A Jenkins job remains active",
  );
  check(
    !c.computer.some((x) =>
      [...(x.executors ?? []), ...(x.oneOffExecutors ?? [])].some(
        (e) => e.idle !== true || e.currentExecutable,
      ),
    ),
    "Jenkins executor is busy",
  );
  check(!initial || q.items.length === 0, "Initial Jenkins queue is not empty");
  return {
    quietingDown: true,
    queued: q.items.length,
    agents: c.computer
      .filter((x) => NODES.includes(x.displayName))
      .map((x) => ({
        name: x.displayName,
        online: !x.offline && !x.temporarilyOffline,
      })),
  };
}
async function containers(profile) {
  const ids = (await docker(profile, ["ps", "--all", "--quiet"]))
    .trim()
    .split("\n")
    .filter(Boolean);
  const list = [];
  for (const id of ids) {
    const [c] = JSON.parse(await docker(profile, ["inspect", id]));
    list.push({
      id: c.Id,
      name: c.Name.slice(1),
      image: c.Image,
      startedAt: c.State.StartedAt,
      status: c.State.Status,
      project: c.Config.Labels?.["com.docker.compose.project"],
      service: c.Config.Labels?.["com.docker.compose.service"],
    });
  }
  return list;
}
async function protectedSnapshot() {
  const records = [];
  for (const p of ["runtime", "jenkins"])
    for (const c of await containers(p))
      if (c.name !== "agent-platform-linux-deploy")
        records.push({ profile: p, ...c });
  return records.sort((a, b) => a.id.localeCompare(b.id));
}
async function streamTransfer(id) {
  const args = (p) => dockerHostArgs(host.layout, p),
    save = spawn(host.docker, [...args("build"), "save", id], {
      env: host.env,
      stdio: ["ignore", "pipe", "pipe"],
    }),
    load = spawn(host.docker, [...args("runtime"), "load", "--quiet"], {
      env: host.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
  const exits = (p) =>
    new Promise((yes, no) => {
      p.once("error", () =>
        no(refusal("Image transfer process failed to start")),
      );
      p.once("close", (code, signal) => yes({ code, signal }));
    });
  const sx = exits(save),
    lx = exits(load);
  save.stderr.resume();
  load.stderr.resume();
  load.stdout.resume();
  const timer = setTimeout(() => {
    save.kill("SIGTERM");
    load.kill("SIGTERM");
    setTimeout(() => {
      save.kill("SIGKILL");
      load.kill("SIGKILL");
    }, 5000).unref();
  }, 10 * 60_000);
  timer.unref();
  try {
    const results = await Promise.allSettled([
      pipeline(save.stdout, load.stdin),
      sx,
      lx,
    ]);
    check(
      results.every((x) => x.status === "fulfilled") &&
        results[1].value.code === 0 &&
        !results[1].value.signal &&
        results[2].value.code === 0 &&
        !results[2].value.signal,
      "Image stream transfer failed; both child statuses were checked",
    );
  } finally {
    clearTimeout(timer);
  }
  await image("runtime", id, { arch: "arm64" });
}
async function recheckEnv(path, proof) {
  const f = await ownerFile(path);
  check(
    f.dev === proof.dev && f.ino === proof.ino && f.hash === proof.sha256,
    "Private env changed since the build plan",
    path,
  );
  return f;
}
async function atomicEnv(path, proof, bytes) {
  await recheckEnv(path, proof);
  const tmp = path + ".agent-upgrade-" + randomUUID(),
    h = await fs.open(tmp, "wx", 0o600);
  try {
    await h.writeFile(bytes);
    await h.sync();
  } finally {
    await h.close();
  }
  await recheckEnv(path, proof);
  await fs.rename(tmp, path);
  const d = await fs.open(dirname(path), "r");
  try {
    await d.sync();
  } finally {
    await d.close();
  }
}
// Read-only: Compose interpolates the whole file, so a key the private env
// lacks fails here instead of after the env was rewritten. Not in build:
// disaster recovery builds before the image IDs are in the env files.
async function composeConfig(p) {
  for (const [kind, profile, project, env] of [
    ["ci", "build", "agent-platform-linux-ci", host.stack],
    ["runtime", "runtime", "agent-platform-runtime", host.runtime],
  ])
    await docker(
      profile,
      [
        "compose",
        "--project-name",
        project,
        "--env-file",
        env,
        "--file",
        p.compose[kind].path,
        "config",
        "--quiet",
      ],
      {
        // One log per attempt: apply-preflight may be rerun with this plan.
        log: join(
          output,
          `compose-config-${kind}-${randomUUID()}.redacted.log`,
        ),
        timeoutMs: 60_000,
      },
    ).catch(() =>
      check(
        false,
        `Compose interpolation preflight failed; inspect $OUT/compose-config-${kind}-*.redacted.log`,
      ),
    );
}
async function apply(planPath, executables) {
  const p = JSON.parse((await ownerFile(canonical(planPath))).bytes);
  assertPlanHost(p, host.layout, executables);
  await assertPinnedTools(p);
  stage = "not-started";
  output = canonical(p.output);
  await noLinks(output);
  check(
    dirname(canonical(planPath)) === output,
    "Plan output directory differs",
  );
  const st = await fs.stat(output);
  check(
    st.uid === host.uid && (st.mode & 0o777) === 0o700,
    "Operator output directory refused",
  );
  check(
    sha(await fs.readFile(process.argv[1])) === p.scriptSha256,
    "Reviewed operator script changed",
  );
  await fs.access(join(output, "applied.json")).then(
    () => {
      throw refusal("Upgrade already applied; do not rerun");
    },
    () => {},
  );
  stage = "apply-preflight";
  await sourceCheck(p.root, p.rootSha);
  for (const kind of ["ci", "deploy"]) {
    const proof = await contextProof(p.contexts[kind].path, p.root, p.rootSha);
    check(
      JSON.stringify(proof) === JSON.stringify(p.contexts[kind]),
      "Build context changed",
    );
  }
  for (const [kind, c] of Object.entries(p.compose)) {
    check(
      ["ci", "runtime"].includes(kind) &&
        c.path === join(p.root, "deploy/containers/compose." + kind + ".json"),
      "Compose path is not the fixed approved source",
    );
    check(sha(await publicFile(c.path)) === c.sha256, "Compose input changed");
  }
  check(
    Object.keys(p.compose).sort().join(",") === "ci,runtime",
    "Compose inventory differs",
  );
  for (const key of ["arm64", "amd64", "deploy"])
    await image("build", p.images[key].id, {
      arch: key === "amd64" ? "amd64" : "arm64",
      rootSha: p.rootSha,
      contextHash:
        p.contexts[key === "deploy" ? "deploy" : "ci"].manifestSha256,
    });
  const stack = await recheckEnv(host.stack, p.env.stack),
    runtime = await recheckEnv(host.runtime, p.env.runtime);
  for (const f of [stack, runtime])
    secrets.push(
      ...Object.values(parseEnv(f.bytes).values).filter(
        (x) => x.length >= 4 && !IMAGE.test(x),
      ),
    );
  await composeConfig(p);
  await idle(true);
  const before = await protectedSnapshot();
  const bc = await containers("build"),
    rc = await containers("runtime");
  for (const [service, imageKey] of [
    ["agent", "CI_IMAGE"],
    ["web", "WEB_CI_IMAGE"],
  ]) {
    const found = bc.filter(
      (x) => x.project === "agent-platform-linux-ci" && x.service === service,
    );
    check(
      found.length === 1 && found[0].image === p.env.stack.images[imageKey],
      "Existing CI Compose identity differs",
    );
  }
  const oldDeploy = rc.filter(
    (x) => x.project === "agent-platform-runtime" && x.service === "deploy",
  );
  check(
    oldDeploy.length === 1 &&
      oldDeploy[0].image === p.env.runtime.images.DEPLOY_IMAGE,
    "Existing deploy Compose identity differs",
  );
  stage = "transfer-deploy";
  await checkpoint({ rootSha: p.rootSha });
  await streamTransfer(p.images.deploy.id);
  await idle();
  await sourceCheck(p.root, p.rootSha);
  check(
    JSON.stringify(await protectedSnapshot()) === JSON.stringify(before),
    "A protected runtime/controller container changed",
  );
  const backup = join(output, "env-backup");
  await fs.mkdir(backup, { mode: 0o700 });
  await fs.writeFile(join(backup, "container-stack.env"), stack.bytes, {
    mode: 0o600,
    flag: "wx",
  });
  await fs.writeFile(join(backup, "container-runtime.env"), runtime.bytes, {
    mode: 0o600,
    flag: "wx",
  });
  stage = "commit-image-env";
  await checkpoint({ rootSha: p.rootSha, backup });
  await recheckEnv(host.stack, p.env.stack);
  await recheckEnv(host.runtime, p.env.runtime);
  await atomicEnv(
    host.stack,
    p.env.stack,
    patchImages(stack.bytes, {
      CI_IMAGE: p.images.arm64.id,
      WEB_CI_IMAGE: p.images.amd64.id,
    }),
  );
  await atomicEnv(
    host.runtime,
    p.env.runtime,
    patchImages(runtime.bytes, { DEPLOY_IMAGE: p.images.deploy.id }),
  );
  const stackNext = patchImages(stack.bytes, {
    CI_IMAGE: p.images.arm64.id,
    WEB_CI_IMAGE: p.images.amd64.id,
  });
  const runtimeNext = patchImages(runtime.bytes, {
    DEPLOY_IMAGE: p.images.deploy.id,
  });
  const expectedEnv = async () => {
    check(
      (await ownerFile(host.stack)).hash === sha(stackNext) &&
        (await ownerFile(host.runtime)).hash === sha(runtimeNext),
      "Updated private env bytes changed",
    );
  };
  await expectedEnv();
  stage = "env-updated-no-agents-yet";
  await checkpoint({ rootSha: p.rootSha, backup });
  await idle();
  await expectedEnv();
  stage = "recreate-ci-agents";
  await checkpoint({ rootSha: p.rootSha, backup });
  await docker(
    "build",
    [
      "compose",
      "--project-name",
      "agent-platform-linux-ci",
      "--env-file",
      host.stack,
      "--file",
      p.compose.ci.path,
      "up",
      "--detach",
      "--no-deps",
      "--force-recreate",
      "--pull",
      "never",
      "agent",
      "web",
    ],
    { log: join(output, "recreate-ci.redacted.log"), timeoutMs: 5 * 60_000 },
  );
  await idle();
  await expectedEnv();
  stage = "recreate-deploy-agent";
  await checkpoint({ rootSha: p.rootSha, backup });
  await docker(
    "runtime",
    [
      "compose",
      "--project-name",
      "agent-platform-runtime",
      "--env-file",
      host.runtime,
      "--file",
      p.compose.runtime.path,
      "up",
      "--detach",
      "--no-deps",
      "--force-recreate",
      "--pull",
      "never",
      "deploy",
    ],
    {
      log: join(output, "recreate-deploy.redacted.log"),
      timeoutMs: 5 * 60_000,
    },
  );
  stage = "verify-agents";
  let state;
  for (let i = 0; i < 60; i++) {
    state = await idle();
    if (state.agents.length === 3 && state.agents.every((a) => a.online)) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  check(
    state.agents.length === 3 && state.agents.every((a) => a.online),
    "Three Jenkins agents did not reconnect",
  );
  const afterBuild = await containers("build"),
    afterRuntime = await containers("runtime");
  for (const [profile, list, service, id] of [
    ["build", afterBuild, "agent", p.images.arm64.id],
    ["build", afterBuild, "web", p.images.amd64.id],
    ["runtime", afterRuntime, "deploy", p.images.deploy.id],
  ]) {
    const project =
        profile === "build"
          ? "agent-platform-linux-ci"
          : "agent-platform-runtime",
      found = list.filter(
        (x) => x.project === project && x.service === service,
      );
    check(
      found.length === 1 &&
        found[0].image === id &&
        found[0].status === "running",
      "Recreated agent image differs",
    );
  }
  check(
    JSON.stringify(await protectedSnapshot()) === JSON.stringify(before),
    "Protected API/Tunnel/DNS/controller identity changed",
  );
  await sourceCheck(p.root, p.rootSha);
  await idle();
  await expectedEnv();
  const result = {
    state: "three-agents-upgraded-jenkins-still-quiesced",
    rootSha: p.rootSha,
    images: p.images,
    agents: state.agents,
    queued: state.queued,
    protectedContainers: before,
    backup,
  };
  await jsonFile(join(output, "applied.json"), result);
  await checkpoint(result);
  console.log(
    JSON.stringify({
      state: result.state,
      rootSha: p.rootSha,
      images: p.images,
      agents: state.agents,
      queued: state.queued,
      proof: join(output, "applied.json"),
    }),
  );
}
// T14: why a run stopped, as a reason code and a redacted summary. JSON syntax
// errors quote their input (possibly a credential), so their text is withheld.
const PLAIN_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
export function failureReport(error) {
  const layoutError = error instanceof HostLayoutError,
    cause = error?.cause?.code;
  let reason = layoutError
    ? error.reason
    : error instanceof SyntaxError
      ? "SyntaxError (text withheld; it may quote private input)"
      : String(error?.message ?? error);
  if (!layoutError && typeof cause === "string" && PLAIN_CODE.test(cause))
    reason += " (" + cause + ")";
  return {
    code:
      typeof error?.code === "string" && PLAIN_CODE.test(error.code)
        ? error.code
        : "UA_UNEXPECTED",
    reason: scrub(reason).slice(0, 500),
    ...(typeof error?.path === "string" && error.path
      ? { path: scrub(error.path) }
      : {}),
    ...(layoutError && error.key ? { check: error.key } : {}),
  };
}
function selfTest() {
  const old = Buffer.from(
    "# retained\r\nCI_IMAGE=sha256:" +
      "a".repeat(64) +
      "\r\nTOKEN=keep $literal `bytes`\r\nWEB_CI_IMAGE=sha256:" +
      "b".repeat(64) +
      "\n",
  );
  const next = patchImages(old, {
    CI_IMAGE: "sha256:" + "c".repeat(64),
    WEB_CI_IMAGE: "sha256:" + "d".repeat(64),
  });
  assert.equal(
    next.toString(),
    old
      .toString()
      .replace("a".repeat(64), "c".repeat(64))
      .replace("b".repeat(64), "d".repeat(64)),
  );
  assert.throws(() =>
    patchImages(Buffer.from("CI_IMAGE=x\n"), {
      CI_IMAGE: "sha256:" + "c".repeat(64),
    }),
  );
  assert.throws(() =>
    patchImages(
      Buffer.from(
        "CI_IMAGE=sha256:" +
          "a".repeat(64) +
          "\nCI_IMAGE=sha256:" +
          "a".repeat(64),
      ),
      { CI_IMAGE: "sha256:" + "c".repeat(64) },
    ),
  );
  assert.equal(
    patchImages(Buffer.from("DEPLOY_IMAGE=sha256:" + "a".repeat(64)), {
      DEPLOY_IMAGE: "sha256:" + "c".repeat(64),
    }).toString(),
    "DEPLOY_IMAGE=sha256:" + "c".repeat(64),
  );
  assert.throws(() =>
    patchImages(Buffer.from("TOKEN=sha256:" + "a".repeat(64)), {
      TOKEN: "sha256:" + "c".repeat(64),
    }),
  );
  assert.throws(() =>
    patchImages(Buffer.from("OTHER=value"), {
      CI_IMAGE: "sha256:" + "c".repeat(64),
    }),
  );
  // Host layout of an injected account, not of this machine: the child
  // environment, private paths, Docker CLI and Docker argument prefix.
  const account = {
      username: "operator",
      uid: 5101,
      gid: 20,
      home: "/home/operator",
    },
    node = "/opt/node-22/bin/node",
    dockerCli = { dockerCli: "/opt/docker/bin/docker" };
  const derive = (identity, execPath, overrides) =>
    resolveHostLayout({ identity, execPath, overrides });
  const layout = derive(account, node, dockerCli),
    bound = hostBindings(layout);
  assert.deepEqual(Object.entries(bound.env), [
    ["PATH", "/opt/node-22/bin:/usr/local/bin:/usr/bin:/bin"],
    ["HOME", "/home/operator"],
    ["USER", "operator"],
    ["LOGNAME", "operator"],
    ["LANG", "en_US.UTF-8"],
    ["DOCKER_CONFIG", layout.privateDir + "/container-docker-context"],
    ["CI", "1"],
    ["GIT_TERMINAL_PROMPT", "0"],
    ["VERCEL_TELEMETRY_DISABLED", "1"],
    ["NEXT_TELEMETRY_DISABLED", "1"],
  ]);
  assert.deepEqual(
    [bound.uid, bound.docker, bound.stack, bound.runtime, bound.admin],
    [
      5101,
      "/opt/docker/bin/docker",
      ...["container-stack.env", "container-runtime.env", "admin-api.json"].map(
        (name) => layout.privateDir + "/" + name,
      ),
    ],
  );
  assert.deepEqual(
    ["build", "runtime", "jenkins"].map((p) => dockerHostArgs(layout, p)),
    ["build", "runtime", "jenkins"].map((p) => [
      "--config",
      layout.privateDir + "/container-docker-context",
      "--host",
      "unix:///home/operator/.colima/agent-platform-" + p + "/docker.sock",
    ]),
  );
  // A plan applies only on the host layout it was built on.
  const executables = {
    docker: {
      path: bound.docker,
      realpath: bound.docker,
      sha256: "e".repeat(64),
    },
  };
  const plan = JSON.parse(
    JSON.stringify({
      schemaVersion: 2,
      state: "built-not-applied",
      root: "/srv/upgrade-src",
      rootSha: "f".repeat(40),
      hostLayout: layoutRecord(layout),
      hostLayoutSha256: layoutSha256(layout),
      hostExecutables: executables,
      env: { stack: { path: bound.stack }, runtime: { path: bound.runtime } },
    }),
  );
  assertPlanHost(plan, layout, executables);
  for (const [code, changed, current, found] of [
    [
      "HL_LAYOUT_CHANGED",
      {},
      derive(account, "/opt/node-22.1/bin/node", dockerCli),
    ],
    [
      "HL_LAYOUT_CHANGED",
      {},
      derive({ ...account, uid: 5102, home: "/home/other" }, node, dockerCli),
    ],
    ["HL_LAYOUT_CHANGED", {}, derive(account, node, {})],
    ["UA_REFUSED", { schemaVersion: 1 }],
    [
      "UA_REFUSED",
      { env: { ...plan.env, runtime: { path: "/tmp/container-runtime.env" } } },
    ],
    [
      "UA_REFUSED",
      {},
      layout,
      { docker: { ...executables.docker, sha256: "0".repeat(64) } },
    ],
  ])
    assert.throws(
      () =>
        assertPlanHost(
          { ...plan, ...changed },
          current ?? layout,
          found ?? executables,
        ),
      { code },
    );
  // T14: a reason code and a redacted summary, never private input.
  secrets.push("self-test-private-value");
  try {
    assert.deepEqual(
      failureReport(refusal("Refused self-test-private-value")),
      {
        code: "UA_REFUSED",
        reason: "Refused [REDACTED]",
      },
    );
    assert.deepEqual(
      failureReport(
        new SyntaxError(
          `Unexpected token, "self-test-private" is not valid JSON`,
        ),
      ),
      {
        code: "UA_UNEXPECTED",
        reason: "SyntaxError (text withheld; it may quote private input)",
      },
    );
    assert.deepEqual(
      failureReport(
        new HostLayoutError("HL_SOCKET", "Docker socket refused", {
          path: "/home/operator/.colima/agent-platform-build/docker.sock",
          key: "socket:build",
        }),
      ),
      {
        code: "HL_SOCKET",
        reason: "Docker socket refused",
        path: "/home/operator/.colima/agent-platform-build/docker.sock",
        check: "socket:build",
      },
    );
  } finally {
    secrets.pop();
  }
  console.log(JSON.stringify({ state: "pure-self-tests-passed", cases: 19 }));
}
async function main() {
  const [action, ...args] = process.argv.slice(2);
  if (action === "self-test") {
    check(args.length === 0, "Self-test takes no paths");
    selfTest();
    return;
  }
  check(Object.hasOwn(HOST_CHECKS, action), "Use build, apply, or self-test");
  if (action === "build")
    check(args.length === 3, "Use build CLEAN_MAIN_ROOT ROOT_SHA FRESH_OUTPUT");
  else check(args.length === 1, "Use apply PLAN_JSON");
  // The operator policy (the passwd account, neither root nor a service
  // account; darwin/arm64, Node 22) and the host checks of this action.
  stage = "host-layout";
  host = hostBindings(await loadHostLayout({ requires: HOST_CHECKS[action] }));
  const executables = await hostExecutables(host.layout);
  if (action === "build") await build(...args, executables);
  else await apply(args[0], executables);
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(canonical(process.argv[1])).href
)
  main().catch(async (error) => {
    let failure;
    try {
      failure = failureReport(error);
    } catch {
      failure = { code: "UA_UNEXPECTED", reason: "Failure not reportable" };
    }
    await checkpoint({
      state: "stopped-for-operator-review",
      preserveBackups: true,
      ...failure,
    }).catch(() => {});
    console.error(
      JSON.stringify({
        state: "stopped-for-operator-review",
        stage,
        ...failure,
        message:
          "No automatic rollback or resume; inspect the private phase checkpoint and redacted logs",
      }),
    );
    process.exitCode = 1;
  });
