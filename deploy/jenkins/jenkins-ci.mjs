import * as fs from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

export const REPOSITORY = "https://github.com/Xeonice/agent-platform-api.git";
export const SHA = /^[a-f0-9]{40}$/;
export function validRef(ref) {
  return typeof ref === "string" &&
    /^refs\/(?:heads\/[A-Za-z0-9][A-Za-z0-9._/-]*|pull\/[1-9][0-9]*\/head)$/.test(ref) &&
    !ref.includes("..") && !ref.includes("//") && !ref.endsWith("/") && !ref.endsWith(".lock");
}

export function ciEnvironment(node, home, temporary) {
  return {
    PATH: `${dirname(node)}:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: home,
    TMPDIR: temporary,
    CI: "true", HUSKY: "0", LANG: "en_US.UTF-8", GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    npm_config_store_dir: join(home, "pnpm-store"),
  };
}

async function execute(command, args, cwd, env, capture = false) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: capture ? ["ignore", "pipe", "inherit"] : ["ignore", "inherit", "inherit"] });
    let output = "";
    child.stdout?.on("data", data => { if (output.length < 200_000) output += data; });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? accept(output.trim()) : reject(new Error(`${command.split("/").at(-1)} failed (${signal ?? code})`)));
  });
}

export async function runPhase(phase, sha, ref, workspace = process.cwd()) {
  if (process.platform !== "darwin" || process.arch !== "arm64" || process.versions.node.split(".")[0] !== "22") throw new Error("CI requires native macOS ARM64 and Node 22");
  if (!SHA.test(sha ?? "") || !validRef(ref)) throw new Error("Invalid pinned commit or ref");
  const home = process.env.HOME;
  if (home !== "/Users/Shared/agent-platform-ci") throw new Error("CI must use its isolated service account and home");
  const source = join(resolve(workspace), "source");
  const temporary = join(home, "tmp");
  await fs.mkdir(temporary, { recursive: true, mode: 0o700 });
  const env = ciEnvironment(process.execPath, home, temporary);
  const git = (args, cwd = source, capture = false) => execute("/usr/bin/git", args, cwd, env, capture);
  const corepack = resolve(dirname(process.execPath), "../lib/node_modules/corepack/dist/corepack.js");
  const pnpm = args => execute(process.execPath, [corepack, "pnpm", ...args], source, env);
  if (phase === "checkout") {
    // Only a fresh Jenkins workspace child is removed. Never accept a checkout path from a parameter.
    if ((await fs.lstat(source).catch(() => null))?.isSymbolicLink()) throw new Error("Refusing symlink workspace");
    await fs.rm(source, { recursive: true, force: true });
    await fs.mkdir(source, { mode: 0o700 });
    await git(["init"]);
    await git(["fetch", "--depth=1", REPOSITORY, ref]);
    if (await git(["rev-parse", "FETCH_HEAD"], source, true) !== sha) throw new Error("Ref moved before checkout; reschedule the new SHA");
    await git(["checkout", "--detach", sha]);
    await fs.writeFile(join(resolve(workspace), "commit.json"), JSON.stringify({ sha, ref, repository: REPOSITORY, nodeMajor: 22, platform: "darwin", arch: "arm64" }, null, 2) + "\n", { mode: 0o600 });
    return;
  }
  if (await git(["rev-parse", "HEAD"], source, true) !== sha) throw new Error("Checkout no longer matches pinned SHA");
  const commands = {
    install: ["install", "--frozen-lockfile", "--store-dir", join(home, "pnpm-store")],
    typecheck: ["typecheck"], lint: ["lint", "--max-warnings=0"], format: ["format:check"],
    "default-image": ["check:default-image"], acceptance: ["test:acceptance:report"], build: ["build"],
  };
  if (commands[phase]) return pnpm(commands[phase]);
  if (phase === "provider-caps") return execute(process.execPath, ["scripts/check-fake-provider-caps.mjs"], source, env);
  if (phase === "openapi") {
    await pnpm(["openapi:emit"]);
    await git(["diff", "--exit-code", "--", "openapi.json"]);
    return;
  }
  if (phase === "native") {
    await execute(process.execPath, ["-e", "const DB=require('better-sqlite3');const db=new DB(':memory:');db.prepare('select 1').get();db.close()"], source, env);
    await execute(process.execPath, ["-e", "import('@boxlite-ai/boxlite').then(s=>{if(typeof s.JsBoxlite!=='function')process.exit(1)})"], join(source, "packages/modules/sandbox"), env);
    return;
  }
  throw new Error("Unknown fixed CI phase");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runPhase(...process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
