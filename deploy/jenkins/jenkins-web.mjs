import * as fs from "node:fs/promises";
import { constants, createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { userInfo, tmpdir } from "node:os";
import {
  dirname,
  join,
  relative,
  resolve,
  isAbsolute,
  basename,
} from "node:path";
import { parseEnv } from "node:util";
import { pathToFileURL } from "node:url";
import {
  assertBuildSystem,
  buildSystem,
  ciContext,
  ciChildEnvironment,
  browserVerificationScript,
} from "./ci-platform.mjs";
import {
  deploymentContext,
  assertDeploymentLayout,
  deploymentEnvironment,
} from "./deployment-platform.mjs";

// Installed, owner-controlled code. A repository checkout is data to these tools,
// never the source of a trusted deployment command or its configuration.
export const WEB = Object.freeze({
  repository: "https://github.com/Xeonice/agent-platform-web.git",
  ref: "refs/heads/main",
  projectId: "prj_XYIzK6r7LgRrV5NHCwWff489J73r",
  orgId: "team_jHE2oyEyN6YIl1u1OPhZAQof",
  scope: "xeonices-projects",
  domain: "agent.douglasdong.com",
  api: "https://agent-api.douglasdong.com",
});
const HISTORICAL_PRODUCTION_REF = "refs/heads/feat/design-v2-migration";
export const SHA = /^[a-f0-9]{40}$/;
export function releaseKey(rootSha, apiSha, webSha) {
  if (![rootSha, apiSha, webSha].every((sha) => SHA.test(sha ?? "")))
    throw new Error("Full project commits required");
  return createHash("sha256")
    .update([rootSha, apiSha, webSha].join("\n"))
    .digest("hex");
}
export const GATES = Object.freeze([
  "install",
  "typecheck",
  "lint",
  "format",
  "stories",
  "mock-contracts",
  "no-emoji",
  "openapi",
  "acceptance",
  "storybook",
  "storybook-build",
  "build",
]);
export const PUBLIC_ENV = Object.freeze({
  NEXT_PUBLIC_API_BASE_URL: WEB.api,
  NEXT_PUBLIC_WS_BASE_URL: WEB.api,
  NEXT_PUBLIC_API_MOCK: "0",
  API_ORIGIN: WEB.api,
  ENABLE_EXPERIMENTAL_COREPACK: "1",
});
const ARCHIVES = ["source.tar.gz", "prebuilt.tar.gz", "storybook.tar.gz"];
const TRUSTED = new Set(["prepare-env", "adopt", "upload", "promote"]);
// The approved Vercel project is agent-platform; agent-platform-web is its
// GitHub repository. Project identity is verified separately from the generated
// hostname before publication or receipt reuse.
const DEPLOYMENT_URL =
  /^https:\/\/agent-platform-[a-z0-9]+-xeonices-projects\.vercel\.app$/;
const MACHO = new Set([
  "feedface",
  "cefaedfe",
  "feedfacf",
  "cffaedfe",
  "cafebabe",
  "bebafeca",
]);
export function validRef(ref) {
  return (
    typeof ref === "string" &&
    /^refs\/(?:heads\/[A-Za-z0-9][A-Za-z0-9._/-]*|pull\/[1-9][0-9]*\/head)$/.test(
      ref,
    ) &&
    !ref.includes("..") &&
    !ref.includes("//") &&
    !ref.endsWith("/") &&
    !ref.endsWith(".lock")
  );
}
function inside(root, path) {
  const part = relative(root, path);
  return (
    part === "" ||
    (part !== ".." && !part.startsWith("../") && !isAbsolute(part))
  );
}
export function childEnvironment(node, home, temporary) {
  return {
    ...deploymentEnvironment(node, home),
    TMPDIR: temporary,
    COPYFILE_DISABLE: "1",
    npm_config_store_dir: join(home, "pnpm-store"),
  };
}
export function safeProject(value) {
  const s = value?.settings;
  if (
    value?.projectId !== WEB.projectId ||
    value?.orgId !== WEB.orgId ||
    s?.framework !== "nextjs" ||
    s?.nodeVersion !== "22.x" ||
    ![null, undefined, "./", ""].includes(s?.rootDirectory) ||
    s?.buildCommand !== "pnpm build" ||
    s?.installCommand !== "pnpm install --frozen-lockfile"
  )
    throw new Error(
      "Vercel project settings do not match the approved project",
    );
  return {
    projectId: WEB.projectId,
    orgId: WEB.orgId,
    projectName: "agent-platform-web",
    settings: {
      framework: "nextjs",
      nodeVersion: "22.x",
      buildCommand: s.buildCommand,
      installCommand: s.installCommand,
      outputDirectory: null,
      rootDirectory: null,
    },
  };
}
export function publicEnvironment(text) {
  const parsed = parseEnv(text);
  for (const [key, value] of Object.entries(PUBLIC_ENV))
    if (parsed[key] !== value)
      throw new Error(
        `Approved public build setting missing or changed: ${key}`,
      );
  // Other values, including OIDC and private project variables, never cross to CI.
  return (
    Object.entries(PUBLIC_ENV)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join("\n") + "\n"
  );
}
async function regular(path, privateOnly = false, maxBytes = 2_000_000) {
  const file = await fs.open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const s = await file.stat();
    if (
      !s.isFile() ||
      s.size > maxBytes ||
      (privateOnly && (s.uid !== process.getuid() || s.mode & 0o077))
    )
      throw new Error("Unsafe input file");
    return await file.readFile();
  } finally {
    await file.close();
  }
}
async function json(path, privateOnly = false) {
  return JSON.parse((await regular(path, privateOnly)).toString());
}
// Vitest's browser reporter includes browser/source metadata and can exceed the
// configuration limit. Keep its allowance separate and validate actual results.
export async function readExecutedTestReport(path) {
  return testReport(
    JSON.parse((await regular(path, false, 64 * 1024 * 1024)).toString()),
  );
}
async function writeJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  await fs.rename(temporary, path);
}
async function directory(path) {
  const s = await fs.lstat(path);
  if (
    !s.isDirectory() ||
    s.isSymbolicLink() ||
    (await fs.realpath(path)) !== resolve(path)
  )
    throw new Error("Unsafe directory");
}
async function digestFile(path) {
  const s = await fs.lstat(path);
  if (!s.isFile() || s.isSymbolicLink())
    throw new Error("Artifact must be an ordinary file");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { sha256: hash.digest("hex"), bytes: s.size };
}

// --standalone removes references to the CI workspace. It does not convert native
// binaries from macOS to Linux: reject those before upload rather than claim portability.
async function nativeFunctionArchitecture(root, path) {
  let parent = dirname(path);
  while (inside(root, parent)) {
    if (basename(parent).endsWith(".func")) {
      const config = await json(join(parent, ".vc-config.json"));
      const arch = config.architecture ?? "x86_64";
      if (!["x86_64", "arm64"].includes(arch))
        throw new Error("Unknown Vercel function target architecture");
      return arch;
    }
    if (parent === root) break;
    parent = dirname(parent);
  }
  throw new Error("Native executable is outside a configured Vercel function");
}

export async function treeEvidence(root, { linux = false } = {}) {
  await directory(root);
  const hash = createHash("sha256");
  let files = 0,
    bytes = 0;
  const nativeArchitectures = new Set();
  async function visit(path) {
    const stat = await fs.lstat(path);
    const name = relative(root, path).split("\\").join("/");
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()))
      throw new Error("Build contains a link or special file");
    if (
      name &&
      /(?:^|\/)(?:\.env(?:\.|$)|auth\.json$|runtime\.env$|\.git(?:\/|$))/.test(
        name,
      )
    )
      throw new Error("Private configuration in build output");
    if (stat.isDirectory()) {
      hash.update(`directory\0${name}\0`);
      for (const child of (await fs.readdir(path)).sort())
        await visit(join(path, child));
    } else {
      if (linux) {
        const f = await fs.open(path, "r");
        const header = Buffer.alloc(64);
        let length;
        try {
          ({ bytesRead: length } = await f.read(header, 0, 64, 0));
        } finally {
          await f.close();
        }
        const magic = header.subarray(0, 4).toString("hex");
        if (MACHO.has(magic) || name.endsWith(".dylib"))
          throw new Error(
            "macOS native binary cannot be uploaded to Vercel Linux functions",
          );
        if (magic === "7f454c46") {
          if (length < 20 || header[4] !== 2 || ![1, 2].includes(header[5]))
            throw new Error("Unsupported native ELF header");
          const machine =
            header[5] === 1 ? header.readUInt16LE(18) : header.readUInt16BE(18);
          const architecture =
            machine === 62 ? "x86_64" : machine === 183 ? "arm64" : null;
          if (!architecture)
            throw new Error("Unsupported native ELF architecture");
          if (architecture !== (await nativeFunctionArchitecture(root, path)))
            throw new Error(
              "Native ELF architecture does not match the Vercel function target",
            );
          nativeArchitectures.add(architecture);
        } else if (name.endsWith(".node") || /\.so(?:\.|$)/.test(name)) {
          throw new Error(
            "Native dependency is not a verified Linux ELF binary",
          );
        }
      }
      const evidence = await digestFile(path);
      hash.update(`file\0${name}\0${stat.mode & 0o111}\0${evidence.sha256}\0`);
      files += 1;
      bytes += evidence.bytes;
    }
  }
  await visit(root);
  return {
    sha256: hash.digest("hex"),
    files,
    bytes,
    nativeArchitectures: [...nativeArchitectures].sort(),
  };
}
export async function normalizeOutput(root) {
  await directory(root);
  const destination = `${root}.normalized-${randomUUID()}`;
  async function copy(source, target, ancestors = new Set()) {
    const actual = await fs.realpath(source);
    if (!inside(root, actual))
      throw new Error("Standalone output still references the CI workspace");
    const stat = await fs.stat(actual);
    if (stat.isDirectory()) {
      if (ancestors.has(actual)) throw new Error("Cyclic build output link");
      await fs.mkdir(target, { mode: stat.mode & 0o777 });
      for (const name of (await fs.readdir(actual)).sort())
        await copy(
          join(actual, name),
          join(target, name),
          new Set([...ancestors, actual]),
        );
    } else if (stat.isFile()) {
      // Next's trace can include the committed documentation sample. It is not
      // loaded by this application at runtime and does not belong in a function.
      // Actual env/auth files still fail the tree validator rather than vanish.
      if (basename(target) === ".env.example") return;
      await fs.copyFile(actual, target);
      await fs.chmod(target, stat.mode & 0o777);
    } else throw new Error("Build output contains a special file");
  }
  try {
    // Internal aliases are legitimate; flatten only links within the output.
    // Anything pointing to node_modules/source or the owner home is refused.
    await copy(root, destination);
    await treeEvidence(destination, { linux: true });
    await fs.rm(root, { recursive: true });
    await fs.rename(destination, root);
  } finally {
    await fs.rm(destination, { force: true, recursive: true });
  }
}

export function validateManifest(
  value,
  sha,
  rootSha,
  production = true,
  apiSha = value?.apiSha,
) {
  return checkedManifest(value, sha, rootSha, production, apiSha, false);
}

// Read-only inspection of already retained evidence. Publication phases use
// validateManifest and still require the current main ref and fresh head checks.
export function validateHistoricalManifest(value, sha, rootSha, apiSha) {
  return checkedManifest(value, sha, rootSha, true, apiSha, true);
}

function checkedManifest(value, sha, rootSha, production, apiSha, historical) {
  if (
    value?.schemaVersion !== 1 ||
    value?.repository !== WEB.repository ||
    value?.sha !== sha ||
    value?.rootSha !== rootSha ||
    value?.apiSha !== apiSha ||
    !SHA.test(apiSha ?? "") ||
    (production &&
      value?.ref !== WEB.ref &&
      !(historical && value?.ref === HISTORICAL_PRODUCTION_REF)) ||
    value?.production !== production ||
    value?.nodeMajor !== 22 ||
    value?.vercelCli !== "62.2.0" ||
    value?.jenkins?.job !== "agent-platform-web" ||
    !Number.isSafeInteger(value?.jenkins?.buildNumber) ||
    value.jenkins.buildNumber < 1 ||
    value.jenkins.gateResult !== "SUCCESS" ||
    value?.state !== "packaged" ||
    !GATES.every((g) => value.gates?.[g]?.state === "passed")
  )
    throw new Error("Artifact provenance or required CI gates do not match");
  for (const name of production
    ? ARCHIVES
    : ["source.tar.gz", "storybook.tar.gz"]) {
    const entry = value.archives?.[name];
    if (
      !/^[a-f0-9]{64}$/.test(entry?.sha256 ?? "") ||
      !Number.isSafeInteger(entry?.bytes) ||
      entry.bytes <= 0
    )
      throw new Error("Artifact archive evidence missing");
  }
  return value;
}
export function deploymentResult(text) {
  const parsed = JSON.parse(text);
  const deployment = parsed.deployment ?? parsed;
  if (
    (parsed.status && parsed.status !== "ok") ||
    deployment.readyState !== "READY" ||
    deployment.target !== "production" ||
    !/^dpl_[A-Za-z0-9]+$/.test(deployment.id ?? "") ||
    !DEPLOYMENT_URL.test(deployment.url ?? "")
  )
    throw new Error(
      "Uploaded deployment did not become ready in the approved project",
    );
  return { url: deployment.url, deploymentId: deployment.id };
}
export function archivePaths(text, prefix) {
  const names = text.trim().split("\n").filter(Boolean);
  if (
    !names.length ||
    names.some(
      (name) =>
        name.includes("\\") ||
        name.startsWith("/") ||
        name.split("/").some((part) => part === ".." || part === ".") ||
        (![prefix, `${prefix}/`].includes(name) &&
          !name.startsWith(`${prefix}/`)),
    )
  )
    throw new Error("Archive contains an unsafe path");
  return names;
}

async function execute(command, args, cwd, env, capture = false) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: capture
        ? ["ignore", "pipe", "pipe"]
        : ["ignore", "inherit", "inherit"],
    });
    let output = "",
      overflow = false;
    child.stdout?.on("data", (chunk) => {
      if (output.length + chunk.length > 2_000_000) {
        overflow = true;
        child.kill();
      } else output += chunk;
    });
    // Captured Vercel commands may mention environment names or authentication;
    // never relay stderr or raw API response JSON to Jenkins logs.
    child.stderr?.resume();
    child.once("error", () =>
      reject(new Error(`${basename(command)} could not start`)),
    );
    child.once("exit", (code, signal) =>
      code === 0 && !overflow
        ? accept(output.trim())
        : reject(new Error(`${basename(command)} failed (${signal ?? code})`)),
    );
  });
}

export function roleFor(phase, identity = userInfo(), system = buildSystem()) {
  assertBuildSystem(system);
  const trusted = TRUSTED.has(phase);
  if (!trusted) {
    ciContext(identity, system);
    return "ci";
  }
  deploymentContext(identity, system);
  return "trusted";
}
async function authenticated(work, operations, action) {
  const layout = operations.deployment;
  await installedCLI(operations, layout.cli);
  const auth = operations.paths?.auth ?? layout.auth;
  const scratch = await fs.mkdtemp(join(tmpdir(), "agent-platform-vercel-"));
  await fs.chmod(scratch, 0o700);
  try {
    const global = dirname(auth);
    await directory(global);
    if (((await fs.lstat(global)).mode & 0o777) !== 0o700)
      throw new Error("Vercel global configuration directory must be private");
    if (((await fs.lstat(auth)).mode & 0o777) !== 0o600)
      throw new Error("Vercel authentication file must be private");
    await regular(auth, true, 65_536);
    // Keep OAuth refresh persistence in its original owner-only global config.
    // Only fixed CLI commands run here, with no repository scripts or token env.
    const env = childEnvironment(layout.node, scratch, scratch);
    const cli = (args) =>
      operations.execute(
        layout.node,
        [layout.cli, ...args, "--scope", WEB.scope, "--global-config", global],
        work,
        env,
        true,
      );
    return await action(cli, scratch);
  } finally {
    await fs.rm(scratch, { force: true, recursive: true });
  }
}
async function installedCLI(operations, cliPath) {
  const version =
    operations.cliVersion ??
    (await json(resolve(dirname(cliPath), "../package.json"))).version;
  if (version !== "62.2.0") throw new Error("Use the pinned Vercel CLI 62.2.0");
}
async function approvedPin(sha, rootSha, root, apiSha) {
  await directory(root);
  const value = await json(join(root, "jenkins-web-pin.json"), true);
  if (
    value?.rootSha !== rootSha ||
    value?.webSha !== sha ||
    !SHA.test(value?.apiSha ?? "") ||
    value?.repository !== "Xeonice/cloud-agent-platform-docs" ||
    value?.approved !== true ||
    (apiSha && value.apiSha !== apiSha)
  )
    throw new Error("Trusted umbrella project pin is missing or changed");
  return value;
}
async function recheckHead(operations, workspace, env, sha) {
  const output = await operations.execute(
    "/usr/bin/git",
    ["ls-remote", "--exit-code", WEB.repository, WEB.ref],
    workspace,
    env,
    true,
  );
  if (output.trim() !== `${sha}\t${WEB.ref}`)
    throw new Error("Production branch moved; publication cancelled");
}
async function publicationLock(release, action) {
  const path = join(release, ".publication.lock");
  let lock;
  try {
    lock = await fs.open(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
  } catch (error) {
    if (error.code === "EEXIST")
      throw new Error("Publication lock exists; operator recovery required");
    throw error;
  }
  try {
    await lock.writeFile(
      JSON.stringify({
        pid: process.pid,
        startedAt: new Date().toISOString(),
      }) + "\n",
    );
    await lock.sync();
    return await action();
  } finally {
    await lock.close();
    await fs.unlink(path);
  }
}
async function verifyArchives(folder, manifest) {
  for (const name of ARCHIVES) {
    const actual = await digestFile(join(folder, name));
    if (
      actual.sha256 !== manifest.archives[name].sha256 ||
      actual.bytes !== manifest.archives[name].bytes
    )
      throw new Error("Artifact archive changed after CI");
  }
}
async function unpack(archive, prefix, destination, operations, env) {
  const list = await operations.execute(
    "/usr/bin/tar",
    ["-tzf", archive],
    destination,
    env,
    true,
  );
  archivePaths(list, prefix);
  const verbose = await operations.execute(
    "/usr/bin/tar",
    ["-tvzf", archive],
    destination,
    env,
    true,
  );
  if (
    verbose
      .split("\n")
      .filter(Boolean)
      .some((line) => !/^[d-]/.test(line))
  )
    throw new Error("Archive contains a link or special entry");
  await operations.execute(
    "/usr/bin/tar",
    ["-xzf", archive, "--no-same-owner", "-C", destination],
    destination,
    env,
    true,
  );
}
export function testReport(value) {
  if (
    !Number.isSafeInteger(value?.numTotalTests) ||
    value.numTotalTests <= 0 ||
    value?.numFailedTests !== 0 ||
    value?.numPendingTests !== 0 ||
    value?.numPassedTests !== value?.numTotalTests ||
    value?.success !== true ||
    !Array.isArray(value.testResults) ||
    !value.testResults.length ||
    value.testResults.some(
      (suite) =>
        suite.status !== "passed" ||
        !Array.isArray(suite.assertionResults) ||
        suite.assertionResults.some((test) => test.status !== "passed"),
    ) ||
    value.testResults.flatMap((suite) => suite.assertionResults).length !==
      value.numTotalTests
  )
    throw new Error("Tests did not all execute and pass");
  return {
    files: value.testResults.length,
    passed: value.numPassedTests,
    failed: 0,
    skipped: 0,
  };
}
async function apiReady(pin, fetcher, root) {
  const env = parseEnv(
    (await regular(join(root, "runtime.env"), true, 65_536)).toString(),
  );
  if (env.HOST !== "127.0.0.1" || env.PORT !== "3101" || !env.ACCESS_PASSCODE)
    throw new Error("Production API probe configuration invalid");
  const snapshots = await Promise.all(
    ["health", "system/version", "deployment/status"].map(async (path) => {
      const response = await fetcher(`http://127.0.0.1:3101/api/${path}`, {
        headers:
          path === "health"
            ? {}
            : { Authorization: `Bearer ${env.ACCESS_PASSCODE}` },
        redirect: "error",
        credentials: "omit",
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok)
        throw new Error("Production API readiness request failed");
      const chunks = [];
      let bytes = 0;
      if (!response.body)
        throw new Error("Production API readiness response missing");
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.length;
          if (bytes > 65_536) {
            await reader.cancel();
            throw new Error("Production API readiness response oversized");
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      const text = Buffer.concat(chunks).toString();
      return JSON.parse(text);
    }),
  );
  if (
    snapshots[0]?.status !== "ok" ||
    snapshots[1]?.commit !== pin.apiSha ||
    snapshots[2]?.ready !== true
  )
    throw new Error(
      "API SHA or protected readiness does not match umbrella project",
    );
  return {
    apiSha: pin.apiSha,
    ready: true,
    checkedAt: new Date().toISOString(),
  };
}

export async function runWebPhase(
  phase,
  sha,
  ref,
  workspace = process.cwd(),
  rootSha,
  apiSha,
  overrides = {},
) {
  if (
    !SHA.test(sha ?? "") ||
    !SHA.test(rootSha ?? "") ||
    !SHA.test(apiSha ?? "") ||
    !validRef(ref)
  )
    throw new Error("Pinned web/root/API commit and valid ref required");
  const operations = { execute, fetch: globalThis.fetch, ...overrides };
  const system = assertBuildSystem(operations.system ?? buildSystem());
  const identity = operations.identity ?? userInfo();
  const role = roleFor(phase, identity, system);
  const layout =
    role === "ci"
      ? ciContext(identity, system)
      : deploymentContext(identity, system);
  if (role === "trusted") {
    await (operations.assertLayout ?? assertDeploymentLayout)(layout);
    operations.deployment = layout;
  }
  const node = system.node;
  const corepack = resolve(
    dirname(node),
    "../lib/node_modules/corepack/dist/corepack.js",
  );
  const cliPath = layout.cli;
  const work = resolve(workspace);
  await directory(work);
  const source = join(work, "web-source"),
    artifacts = join(work, "web-artifacts");
  const home =
    role === "ci"
      ? (operations.paths?.ciHome ?? layout.home)
      : (operations.paths?.ownerHome ?? layout.home);
  // Only the trusted deployment layout has a production root; CI never reads it.
  const deployRoot = operations.paths?.root ?? layout.root;
  const temporary = join(home, "tmp");
  await fs.mkdir(temporary, { recursive: true, mode: 0o700 });
  const env =
    role === "ci"
      ? ciChildEnvironment(node, {
          ...layout,
          home,
          temporary,
          store: join(home, "pnpm-store"),
        })
      : childEnvironment(node, home, temporary);
  const run = (cmd, args, cwd = source, capture = false) =>
    operations.execute(cmd, args, cwd, env, capture);
  const git = (args, cwd = source, capture = true) =>
    run("/usr/bin/git", args, cwd, capture);
  const cleanSource = async () => {
    await git(["diff", "--exit-code", "HEAD", "--"]);
    const untracked = (
      await git(["ls-files", "--others", "--exclude-standard", "-z"])
    )
      .split("\0")
      .filter(Boolean);
    if (untracked.some((name) => !name.startsWith(".vercel/")))
      throw new Error("Uncommitted source files cannot enter a release");
  };
  const pnpm = (args) => run(node, [corepack, "pnpm", ...args]);
  const production = ref === WEB.ref;
  if (role === "trusted" && !production)
    throw new Error("Only main builds can use production publication phases");

  if (phase === "prepare-env") {
    await recheckHead(operations, work, env, sha);
    const cache = join(work, "public-vercel-cache");
    if (await fs.lstat(cache).catch(() => null))
      throw new Error("Public build cache must be fresh");
    await authenticated(work, operations, async (cli, scratch) => {
      const project = join(scratch, ".vercel");
      await fs.mkdir(project, { mode: 0o700 });
      await writeJson(join(project, "project.json"), {
        projectId: WEB.projectId,
        orgId: WEB.orgId,
      });
      // Use a separate CLI cwd: no repository scripts run with Vercel credentials.
      await cli(["pull", scratch, "--yes", "--environment=production"]);
      const settings = safeProject(await json(join(project, "project.json")));
      const publicEnv = publicEnvironment(
        (await regular(join(project, ".env.production.local"))).toString(),
      );
      await recheckHead(operations, work, env, sha);
      await fs.mkdir(cache, { mode: 0o700 });
      await writeJson(join(cache, "project.json"), settings);
      await fs.writeFile(join(cache, "production.env"), publicEnv, {
        mode: 0o600,
        flag: "wx",
      });
      await writeJson(join(cache, "provenance.json"), {
        sha,
        rootSha,
        apiSha,
        projectId: WEB.projectId,
        production: true,
      });
    });
    return { phase, state: "passed", projectId: WEB.projectId };
  }
  if (role === "trusted") {
    const pin = await approvedPin(sha, rootSha, deployRoot, apiSha);
    if (pin.apiSha !== apiSha)
      throw new Error("API SHA differs from trusted project pin");
    await recheckHead(operations, work, env, sha);
    const release = join(
      deployRoot,
      "web-releases",
      releaseKey(rootSha, apiSha, sha),
    );
    if (phase === "adopt") {
      const manifest = validateManifest(
        await json(join(artifacts, "manifest.json")),
        sha,
        rootSha,
        true,
        apiSha,
      );
      await directory(artifacts);
      await verifyArchives(artifacts, manifest);
      await fs.mkdir(dirname(release), { recursive: true, mode: 0o700 });
      await directory(dirname(release));
      if (await fs.lstat(release).catch(() => null)) {
        const previous = validateManifest(
          await json(join(release, "manifest.json")),
          sha,
          rootSha,
          true,
          apiSha,
        );
        await verifyArchives(release, previous);
        if (
          (await treeEvidence(join(release, ".vercel/output"), { linux: true }))
            .sha256 !== previous.trees.output.sha256 ||
          (await treeEvidence(join(release, "storybook-static"))).sha256 !==
            previous.trees.storybook.sha256
        )
          throw new Error(
            "Existing immutable release is incomplete or changed",
          );
        // Reuse original bits and original Jenkins provenance. The orchestrator
        // must verify this original build's final SUCCESS; a newer build is not it.
        return {
          phase,
          state: "passed",
          release,
          reused: true,
          jenkins: previous.jenkins,
        };
      }
      const stage = await fs.mkdtemp(join(dirname(release), ".adopt-"));
      try {
        for (const name of ARCHIVES)
          await fs.copyFile(join(artifacts, name), join(stage, name));
        await verifyArchives(stage, manifest);
        await unpack(
          join(stage, "prebuilt.tar.gz"),
          ".vercel/output",
          stage,
          operations,
          env,
        );
        await unpack(
          join(stage, "storybook.tar.gz"),
          "storybook-static",
          stage,
          operations,
          env,
        );
        const output = await treeEvidence(join(stage, ".vercel/output"), {
          linux: true,
        });
        const storybook = await treeEvidence(join(stage, "storybook-static"));
        if (
          output.sha256 !== manifest.trees.output.sha256 ||
          storybook.sha256 !== manifest.trees.storybook.sha256
        )
          throw new Error("Extracted build does not match CI tree hash");
        await fs.mkdir(join(stage, ".vercel"), { recursive: true });
        await writeJson(join(stage, ".vercel/project.json"), {
          projectId: WEB.projectId,
          orgId: WEB.orgId,
        });
        await writeJson(join(stage, "manifest.json"), manifest);
        await approvedPin(sha, rootSha, deployRoot, apiSha);
        await recheckHead(operations, work, env, sha);
        await fs.rename(stage, release);
        return { phase, state: "passed", release };
      } finally {
        await fs.rm(stage, { force: true, recursive: true });
      }
    }
    const manifest = validateManifest(
      await json(join(release, "manifest.json")),
      sha,
      rootSha,
      true,
      apiSha,
    );
    await directory(release);
    await verifyArchives(release, manifest);
    const link = await json(join(release, ".vercel/project.json"));
    if (link.projectId !== WEB.projectId || link.orgId !== WEB.orgId)
      throw new Error("Adopted Vercel project link changed");
    if (
      (await treeEvidence(join(release, ".vercel/output"), { linux: true }))
        .sha256 !== manifest.trees.output.sha256
    )
      throw new Error("Adopted prebuilt output changed");
    const receiptPath = join(release, `publication-${rootSha}.json`);
    const matchingReceipt = (value) =>
      value?.sha === sha &&
      value?.rootSha === rootSha &&
      value?.apiSha === apiSha &&
      value?.projectId === WEB.projectId &&
      /^dpl_[A-Za-z0-9]+$/.test(value?.deploymentId ?? "") &&
      DEPLOYMENT_URL.test(value?.url ?? "");
    const remoteReceipt = async (cli, receipt, promoted = false) => {
      if (!matchingReceipt(receipt))
        throw new Error("Publication receipt does not match approved project");
      const deployment = JSON.parse(
        await cli(["api", `/v13/deployments/${receipt.deploymentId}`]),
      );
      if (
        deployment.id !== receipt.deploymentId ||
        deployment.url !== new URL(receipt.url).hostname ||
        deployment.projectId !== WEB.projectId ||
        deployment.readyState !== "READY" ||
        deployment.target !== "production" ||
        deployment.meta?.jenkinsWebSha !== sha ||
        deployment.meta?.jenkinsRootSha !== rootSha ||
        deployment.meta?.jenkinsApiSha !== apiSha ||
        deployment.meta?.jenkinsBuildNumber !==
          String(manifest.jenkins.buildNumber) ||
        deployment.readySubstate !== (promoted ? "PROMOTED" : "STAGED")
      )
        throw new Error(
          "Remote deployment is not the matching staged prebuilt output",
        );
      if (promoted) {
        const alias = JSON.parse(
          await cli([
            "api",
            `/v4/aliases/${WEB.domain}?projectId=${WEB.projectId}`,
          ]),
        );
        if (
          alias.alias !== WEB.domain ||
          alias.projectId !== WEB.projectId ||
          alias.deploymentId !== receipt.deploymentId ||
          alias.redirect
        )
          throw new Error(
            "Production domain does not point to this deployment",
          );
      }
    };
    return publicationLock(release, async () => {
      const prior = await json(receiptPath).catch((error) =>
        error.code === "ENOENT" ? null : Promise.reject(error),
      );
      if (prior?.state === "failed")
        throw new Error(
          "Previous publication failed; operator review required",
        );
      try {
        if (
          prior &&
          ((phase === "upload" &&
            ["staged", "promoted"].includes(prior.state)) ||
            (phase === "promote" && prior.state === "promoted"))
        ) {
          const readiness =
            prior.state === "promoted"
              ? await apiReady(pin, operations.fetch, deployRoot)
              : null;
          await authenticated(release, operations, (cli) =>
            remoteReceipt(cli, prior, prior.state === "promoted"),
          );
          await approvedPin(sha, rootSha, deployRoot, apiSha);
          await recheckHead(operations, work, env, sha);
          return {
            phase,
            ...prior,
            ...(readiness ? { readiness } : {}),
            reused: true,
          };
        }
        if (phase === "upload") {
          if (prior)
            throw new Error(
              "Publication already exists; refusing another upload",
            );
          // Exclusive, durable intent prevents a retry creating a second deployment
          // after a controller crash between remote upload and receipt persistence.
          await fs.writeFile(
            receiptPath,
            JSON.stringify({
              state: "uploading",
              sha,
              rootSha,
              apiSha: pin.apiSha,
              projectId: WEB.projectId,
              startedAt: new Date().toISOString(),
            }) + "\n",
            { mode: 0o600, flag: "wx" },
          );
          const deployment = deploymentResult(
            await authenticated(release, operations, (cli) =>
              cli([
                "deploy",
                "--prebuilt",
                "--prod",
                "--skip-domain",
                "--yes",
                "--archive=tgz",
                "--json",
                "--meta",
                `jenkinsWebSha=${sha}`,
                "--meta",
                `jenkinsRootSha=${rootSha}`,
                "--meta",
                `jenkinsApiSha=${apiSha}`,
                "--meta",
                `jenkinsBuildNumber=${manifest.jenkins.buildNumber}`,
              ]),
            ),
          );
          const receipt = {
            state: "staged",
            sha,
            rootSha,
            apiSha: pin.apiSha,
            ...deployment,
            projectId: WEB.projectId,
            uploadedAt: new Date().toISOString(),
          };
          await writeJson(receiptPath, receipt);
          return { phase, ...receipt };
        }
        if (
          phase !== "promote" ||
          prior?.state !== "staged" ||
          prior.sha !== sha ||
          prior.rootSha !== rootSha ||
          prior.projectId !== WEB.projectId
        )
          throw new Error("Matching staged upload required for promotion");
        const readiness = await apiReady(pin, operations.fetch, deployRoot);
        await approvedPin(sha, rootSha, deployRoot, apiSha);
        await recheckHead(operations, work, env, sha);
        await authenticated(release, operations, async (cli) => {
          await remoteReceipt(cli, prior);
          await approvedPin(sha, rootSha, deployRoot, apiSha);
          await recheckHead(operations, work, env, sha);
          await writeJson(receiptPath, {
            ...prior,
            state: "promoting",
            readiness,
            startedPromotionAt: new Date().toISOString(),
          });
          await cli(["promote", prior.url, "--yes"]);
          await remoteReceipt(cli, prior, true);
        });
        const receipt = {
          ...prior,
          state: "promoted",
          domain: WEB.domain,
          readiness,
          promotedAt: new Date().toISOString(),
        };
        await writeJson(receiptPath, receipt);
        return { phase, ...receipt };
      } catch (error) {
        if (!prior || (phase === "promote" && prior.state === "staged"))
          await writeJson(receiptPath, {
            ...(prior ?? { sha, rootSha, projectId: WEB.projectId }),
            state: "failed",
            failedPhase: phase,
            failedAt: new Date().toISOString(),
            error: "Publication did not complete; operator review required",
          });
        throw error;
      }
    });
  }

  if (phase === "checkout") {
    for (const path of [source, artifacts]) {
      if ((await fs.lstat(path).catch(() => null))?.isSymbolicLink())
        throw new Error("Refusing symlink workspace");
      await fs.rm(path, { force: true, recursive: true });
      await fs.mkdir(path, { mode: 0o700 });
    }
    await git(["init"]);
    await git(["fetch", "--depth=1", WEB.repository, ref]);
    if ((await git(["rev-parse", "FETCH_HEAD"])) !== sha)
      throw new Error("Ref moved before checkout; reschedule exact new SHA");
    await git(["checkout", "--detach", sha]);
    const buildNumber = Number(process.env.BUILD_NUMBER);
    if (
      process.env.JOB_NAME !== "agent-platform-web" ||
      !Number.isSafeInteger(buildNumber) ||
      buildNumber < 1
    )
      throw new Error("Fixed Jenkins job and build number required");
    await writeJson(join(artifacts, "web-ci.json"), {
      schemaVersion: 1,
      sha,
      rootSha,
      apiSha,
      ref,
      repository: WEB.repository,
      production,
      state: "checking",
      nodeMajor: 22,
      buildSystem: { platform: system.platform, arch: system.arch },
      vercelCli: "62.2.0",
      jenkins: { job: "agent-platform-web", buildNumber },
      gates: {},
      startedAt: new Date().toISOString(),
    });
    return { phase, state: "passed", sha, rootSha };
  }
  await directory(source);
  await directory(artifacts);
  if ((await git(["rev-parse", "HEAD"])) !== sha)
    throw new Error("Checkout no longer matches pinned SHA");
  const report = await json(join(artifacts, "web-ci.json"));
  if (
    report.sha !== sha ||
    report.rootSha !== rootSha ||
    report.apiSha !== apiSha ||
    report.ref !== ref ||
    report.state === "failed"
  )
    throw new Error("CI provenance changed or a previous gate failed");
  const startedAt = new Date().toISOString();
  try {
    const commands = {
      install: [
        "install",
        "--frozen-lockfile",
        "--store-dir",
        join(home, "pnpm-store"),
      ],
      typecheck: ["run", "typecheck"],
      lint: ["run", "lint"],
      format: ["run", "format:check"],
      stories: ["run", "check:stories"],
      "mock-contracts": ["run", "check:mock-contracts"],
      "no-emoji": ["run", "check:no-emoji"],
      openapi: ["run", "check:api-drift"],
      "storybook-build": ["run", "build-storybook"],
    };
    let details = {};
    if (commands[phase]) {
      await pnpm(commands[phase]);
      if (phase === "install")
        await run(node, [
          "--input-type=module",
          "-e",
          browserVerificationScript(layout.browsers),
        ]);
    } else if (["acceptance", "storybook"].includes(phase)) {
      const output = join(artifacts, `${phase}.json`),
        junit = join(artifacts, `${phase}.xml`);
      await pnpm([
        "run",
        phase === "acceptance" ? "test" : "test:storybook",
        "--reporter=default",
        "--reporter=json",
        "--reporter=junit",
        `--outputFile.json=${output}`,
        `--outputFile.junit=${junit}`,
      ]);
      details = await readExecutedTestReport(output);
    } else if (phase === "build") {
      await cleanSource();
      if (production) {
        const cache = join(work, "public-vercel-cache");
        await directory(cache);
        const provenance = await json(join(cache, "provenance.json"));
        if (
          provenance.sha !== sha ||
          provenance.rootSha !== rootSha ||
          provenance.apiSha !== apiSha ||
          provenance.projectId !== WEB.projectId
        )
          throw new Error("Prepared public settings do not match this build");
        const settings = safeProject(await json(join(cache, "project.json")));
        const vars = publicEnvironment(
          (await regular(join(cache, "production.env"))).toString(),
        );
        const project = join(source, ".vercel");
        if (await fs.lstat(project).catch(() => null))
          throw new Error("Repository must not contain a Vercel private cache");
        await fs.mkdir(project, { mode: 0o700 });
        await writeJson(join(project, "project.json"), settings);
        await fs.writeFile(join(project, ".env.production.local"), vars, {
          mode: 0o600,
          flag: "wx",
        });
        const offline = join(work, "empty-vercel-global");
        await fs.mkdir(offline, { mode: 0o700 });
        await installedCLI(operations, cliPath);
        await run(node, [
          cliPath,
          "build",
          "--prod",
          "--standalone",
          "--yes",
          "--global-config",
          offline,
        ]);
        await normalizeOutput(join(project, "output"));
        details = {
          output: await treeEvidence(join(project, "output"), { linux: true }),
          buildEnvironment: "production-public-only",
        };
      } else {
        await pnpm(["run", "build"]);
        details = { buildEnvironment: "isolated-ci" };
      }
    } else if (phase === "package") {
      await cleanSource();
      if (!GATES.every((g) => report.gates[g]?.state === "passed"))
        throw new Error("All local CI gates must pass before packaging");
      const sourceList = (await git(["ls-files", "-z"]))
        .split("\0")
        .filter(Boolean);
      if (
        sourceList.some(
          (name) =>
            /(?:^|\/)(?:\.env(?:\.|$)|runtime\.env$|auth\.json$|\.vercel(?:\/|$))/.test(
              name,
            ) && name !== ".env.example",
        )
      )
        throw new Error("Tracked private configuration cannot be packaged");
      await run("/usr/bin/git", [
        "archive",
        "--format=tar.gz",
        "--prefix=agent-platform-web/",
        `--output=${join(artifacts, "source.tar.gz")}`,
        sha,
      ]);
      const trees = {
        storybook: await treeEvidence(join(source, "storybook-static")),
      };
      await run("/usr/bin/tar", [
        "-czf",
        join(artifacts, "storybook.tar.gz"),
        "-C",
        source,
        "storybook-static",
      ]);
      if (production) {
        trees.output = await treeEvidence(join(source, ".vercel/output"), {
          linux: true,
        });
        await run("/usr/bin/tar", [
          "-czf",
          join(artifacts, "prebuilt.tar.gz"),
          "-C",
          source,
          ".vercel/output",
        ]);
      }
      const archives = {};
      for (const name of production
        ? ARCHIVES
        : ["source.tar.gz", "storybook.tar.gz"])
        archives[name] = await digestFile(join(artifacts, name));
      const manifest = {
        ...report,
        jenkins: { ...report.jenkins, gateResult: "SUCCESS" },
        state: "packaged",
        packagedAt: new Date().toISOString(),
        trees,
        archives,
        vercelProjectId: production ? WEB.projectId : null,
      };
      validateManifest(manifest, sha, rootSha, production, apiSha);
      await writeJson(join(artifacts, "manifest.json"), manifest);
      report.state = "packaged";
      report.packagedAt = manifest.packagedAt;
    } else throw new Error("Unknown fixed web pipeline phase");
    report.gates[phase] = {
      state: "passed",
      startedAt,
      finishedAt: new Date().toISOString(),
      ...details,
    };
    await writeJson(join(artifacts, "web-ci.json"), report);
    return { phase, state: "passed", sha, rootSha, ...details };
  } catch (error) {
    report.state = "failed";
    report.gates[phase] = {
      state: "failed",
      startedAt,
      finishedAt: new Date().toISOString(),
      error: "Local pipeline phase failed",
    };
    await writeJson(join(artifacts, "web-ci.json"), report);
    throw error;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (process.argv.length !== 8) {
    console.error(
      "Usage: jenkins-web.mjs PHASE WEB_SHA REF WORKSPACE ROOT_SHA API_SHA",
    );
    process.exit(1);
  }
  runWebPhase(...process.argv.slice(2))
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
