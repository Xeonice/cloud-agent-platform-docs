import { userInfo } from "node:os";
import { dirname, join } from "node:path";

export const LINUX_CI = Object.freeze({
  username: "jenkins",
  uid: 1000,
  gid: 1000,
  home: "/home/jenkins",
  node: "/usr/local/bin/node",
  tools: "/opt/agent-platform/tools",
  cli: "/opt/agent-platform/vercel/node_modules/vercel/dist/index.js",
  browsers: "/opt/agent-platform/playwright",
  corepack: "/opt/agent-platform/corepack",
});

export function buildSystem() {
  return {
    platform: process.platform,
    arch: process.arch,
    nodeMajor: Number(process.versions.node.split(".")[0]),
    node: process.execPath,
  };
}

// Pipelines run only in the fixed Linux agent images; the native Mac agents
// they replaced are retired, so no Mac account, home or path is accepted here.
export function assertBuildSystem(system = buildSystem()) {
  if (
    system.nodeMajor !== 22 ||
    system.platform !== "linux" ||
    !["arm64", "x64"].includes(system.arch) ||
    system.node !== LINUX_CI.node
  )
    throw new Error("CI requires the fixed Node 22 Linux build environment");
  return system;
}

export function ciContext(identity = userInfo(), system = buildSystem()) {
  assertBuildSystem(system);
  if (
    identity.username !== LINUX_CI.username ||
    identity.uid !== LINUX_CI.uid ||
    identity.gid !== LINUX_CI.gid ||
    identity.homedir !== LINUX_CI.home
  )
    throw new Error("Isolated CI account and fixed home required");
  const home = LINUX_CI.home;
  return {
    ...system,
    home,
    temporary: join(home, "tmp"),
    store: join(home, "pnpm-store"),
    cli: LINUX_CI.cli,
    browsers: LINUX_CI.browsers,
    corepack: LINUX_CI.corepack,
  };
}

export function ciChildEnvironment(node, context) {
  return {
    PATH: dirname(node) + ":/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: context.home,
    TMPDIR: context.temporary,
    CI: "true",
    HUSKY: "0",
    LANG: "C.UTF-8",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    VERCEL_TELEMETRY_DISABLED: "1",
    NEXT_TELEMETRY_DISABLED: "1",
    COPYFILE_DISABLE: "1",
    npm_config_store_dir: context.store,
    ...(context.browsers ? { PLAYWRIGHT_BROWSERS_PATH: context.browsers } : {}),
    ...(context.corepack
      ? { COREPACK_HOME: context.corepack, COREPACK_DEFAULT_TO_LATEST: "0" }
      : {}),
  };
}

// The image owns this cache. Playwright's install command always writes a lock
// and .links metadata, even when its browser revision is already installed.
export function browserVerificationScript(cache = LINUX_CI.browsers) {
  return `
import { createRequire } from 'node:module';
import { lstat, realpath, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { sep } from 'node:path';
const require=createRequire(process.cwd()+'/__browser_verification.cjs');
let module='@playwright/test';
try { require.resolve(module+'/package.json'); }
catch(error) { if(error.code!=='MODULE_NOT_FOUND') throw error; module='playwright'; }
const version=require(module+'/package.json').version;
if(version!=='1.62.1') throw new Error('Project Playwright must match the pinned CI image');
const executable=require(module).chromium.executablePath();
const cache=await realpath(${JSON.stringify(cache)});
const resolved=await realpath(executable);
if(!resolved.startsWith(cache+sep)||(await lstat(executable)).isFile()!==true)
  throw new Error('Project Chromium revision must be a regular executable in the fixed image cache');
await access(executable,constants.X_OK);
console.log(JSON.stringify({playwright:version,preinstalledChromium:resolved}));
`;
}
