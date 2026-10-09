import * as fs from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { spawn } from "node:child_process";
import { userInfo } from "node:os";
import { pathToFileURL } from "node:url";
import {
  buildSystem,
  ciContext,
  ciChildEnvironment,
  LINUX_CI,
} from "./ci-platform.mjs";

export const REPOSITORY = "https://github.com/Xeonice/agent-platform-api.git";
export const SHA = /^[a-f0-9]{40}$/;
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

export function ciEnvironment(node, home, temporary) {
  return ciChildEnvironment(node, {
    home,
    temporary,
    store: join(home, "pnpm-store"),
    corepack: LINUX_CI.corepack,
  });
}

export function apiCiContext(identity = userInfo(), system = buildSystem()) {
  const context = ciContext(identity, system);
  if (context.arch !== "arm64")
    throw new Error("Backend validation requires the fixed ARM64 CI agent");
  return context;
}

async function execute(command, args, cwd, env, capture = false) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: capture
        ? ["ignore", "pipe", "inherit"]
        : ["ignore", "inherit", "inherit"],
    });
    let output = "";
    child.stdout?.on("data", (data) => {
      if (output.length < 200_000) output += data;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0
        ? accept(output.trim())
        : reject(
            new Error(
              `${command.split("/").at(-1)} failed (${signal ?? code})`,
            ),
          ),
    );
  });
}

const phases = new Set([
  "checkout",
  "install",
  "typecheck",
  "lint",
  "format",
  "default-image",
  "acceptance",
  "build",
  "provider-caps",
  "openapi",
  "native",
]);

export async function runPhase(
  phase,
  sha,
  ref,
  workspace = process.cwd(),
  options = {},
) {
  if (!phases.has(phase)) throw new Error("Unknown fixed CI phase");
  if (!SHA.test(sha ?? "") || !validRef(ref))
    throw new Error("Invalid pinned commit or ref");
  const context = apiCiContext(
    options.identity ?? userInfo(),
    options.system ?? buildSystem(),
  );
  const home = options.home ?? context.home;
  const source = join(resolve(workspace), "source");
  const temporary = join(home, "tmp");
  await fs.mkdir(temporary, { recursive: true, mode: 0o700 });
  const env = ciEnvironment(context.node, home, temporary);
  const run = (command, args, cwd = source, capture = false) =>
    (options.execute ?? execute)(command, args, cwd, env, capture);
  const git = (args, cwd = source, capture = false) =>
    run("/usr/bin/git", args, cwd, capture);
  const corepack = resolve(
    dirname(context.node),
    "../lib/node_modules/corepack/dist/corepack.js",
  );
  const pnpm = (args) => run(context.node, [corepack, "pnpm", ...args]);
  const provenance = {
    sha,
    ref,
    repository: REPOSITORY,
    nodeMajor: 22,
    platform: context.platform,
    arch: context.arch,
  };
  const commitFile = join(resolve(workspace), "commit.json");
  if ((await fs.lstat(source).catch(() => null))?.isSymbolicLink())
    throw new Error("Refusing symlink workspace");
  if (phase === "checkout") {
    // Only a fresh Jenkins workspace child is removed. Never accept a checkout path from a parameter.
    await fs.rm(commitFile, { force: true });
    await fs.rm(join(resolve(workspace), "native-import.json"), {
      force: true,
    });
    await fs.rm(source, { recursive: true, force: true });
    await fs.mkdir(source, { mode: 0o700 });
    await git(["init"]);
    await git(["fetch", "--depth=1", REPOSITORY, ref]);
    if ((await git(["rev-parse", "FETCH_HEAD"], source, true)) !== sha)
      throw new Error("Ref moved before checkout; reschedule the new SHA");
    await git(["checkout", "--detach", sha]);
    await fs.writeFile(commitFile, JSON.stringify(provenance, null, 2) + "\n", {
      mode: 0o600,
    });
    return;
  }
  if (!(await fs.lstat(commitFile)).isFile())
    throw new Error("Pinned checkout provenance must be a regular file");
  const recorded = JSON.parse(await fs.readFile(commitFile, "utf8"));
  if (
    Object.entries(provenance).some(([key, value]) => recorded[key] !== value)
  )
    throw new Error("Pinned checkout provenance changed");
  if ((await git(["rev-parse", "HEAD"], source, true)) !== sha)
    throw new Error("Checkout no longer matches pinned SHA");
  const commands = {
    install: [
      "install",
      "--frozen-lockfile",
      "--store-dir",
      join(home, "pnpm-store"),
    ],
    typecheck: ["typecheck"],
    lint: ["lint", "--max-warnings=0"],
    format: ["format:check"],
    "default-image": ["check:default-image"],
    acceptance: ["test:acceptance:report"],
    build: ["build"],
  };
  if (commands[phase]) return pnpm(commands[phase]);
  if (phase === "provider-caps")
    return run(context.node, ["scripts/check-fake-provider-caps.mjs"]);
  if (phase === "openapi") {
    await pnpm(["openapi:emit"]);
    await git(["diff", "--exit-code", "--", "openapi.json"]);
    return;
  }
  if (phase === "native") {
    const report = join(resolve(workspace), "native-import.json");
    await fs.rm(report, { force: true });
    // Actual NAPI loads in the checked-out platform's dependency tree. This
    // checks SQLite and the BoxLite binding without starting a VM or API.
    await run(context.node, [
      "-e",
      "const assert=require('node:assert/strict');const DB=require('better-sqlite3');const db=new DB(':memory:');try{assert.equal(db.prepare('select 1 as value').get().value,1)}finally{db.close()}",
    ]);
    await run(
      context.node,
      [
        "--input-type=module",
        "-e",
        "const sdk=await import('@boxlite-ai/boxlite');if(typeof sdk.JsBoxlite!=='function'||typeof sdk.getNativeModule().JsBoxlite!=='function')throw new Error('BoxLite native binding unavailable')",
      ],
      join(source, "packages/modules/sandbox"),
    );
    await fs.writeFile(
      report,
      JSON.stringify(
        {
          ...provenance,
          sqlite: "passed",
          boxlite: "passed",
          boxliteVmStarted: false,
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );
    return;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runPhase(...process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
