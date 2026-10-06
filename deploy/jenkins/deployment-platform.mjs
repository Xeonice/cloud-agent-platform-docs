import * as fs from "node:fs/promises";
import { userInfo } from "node:os";
import { resolve, dirname } from "node:path";
import { assertBuildSystem, buildSystem } from "./ci-platform.mjs";

export const LINUX_DEPLOY = Object.freeze({
  home: "/home/jenkins",
  uid: 1000,
  root: "/srv/agent-platform/deploy",
  tools: "/run/agent-platform/jenkins-tools",
  publicTools: "/opt/agent-platform/tools",
  cli: "/opt/agent-platform/vercel/node_modules/vercel/dist/index.js",
  auth: "/run/agent-platform/jenkins-tools/vercel/auth.json",
  jenkins: "http://host.lima.internal:8080/",
});
export const MAC_DEPLOY = Object.freeze({
  home: "/Users/douglasdong",
  uid: 501,
  root: "/Users/douglasdong/.local/share/agent-platform-deploy",
  tools: "/Users/douglasdong/.local/share/agent-platform-jenkins-tools",
  publicTools: "/Library/Application Support/AgentPlatform/jenkins-tools",
  cli: "/Library/Application Support/AgentPlatform/vercel/node_modules/vercel/dist/index.js",
  auth: "/Users/douglasdong/Library/Application Support/com.vercel.cli/auth.json",
  jenkins: "http://127.0.0.1:8080/",
});
export const DEPLOYMENT =
  process.platform === "linux" ? LINUX_DEPLOY : MAC_DEPLOY;
const CANONICAL_JENKINS = "http://127.0.0.1:8080/";

export function deploymentContext(
  identity = userInfo(),
  system = buildSystem(),
) {
  assertBuildSystem(system);
  const linux = system.platform === "linux";
  if (
    system.arch !== "arm64" ||
    (linux
      ? identity.username !== "jenkins" ||
        identity.uid !== 1000 ||
        identity.gid !== 1000 ||
        identity.homedir !== LINUX_DEPLOY.home
      : identity.username !== "douglasdong" ||
        identity.uid !== 501 ||
        identity.homedir !== MAC_DEPLOY.home)
  )
    throw new Error("Trusted deployment account and fixed Node 22 required");
  return { ...system, ...(linux ? LINUX_DEPLOY : MAC_DEPLOY) };
}

async function checkedDirectory(path, uid, privateOnly) {
  const stat = await fs.lstat(path);
  if (
    !stat.isDirectory() ||
    stat.uid !== uid ||
    (privateOnly
      ? (stat.mode & 0o777) !== 0o700
      : Boolean(stat.mode & 0o022)) ||
    (await fs.realpath(path)) !== resolve(path)
  )
    throw new Error(
      "Trusted deployment directory ownership or permissions invalid",
    );
}

// Identity alone cannot distinguish Linux build and deployment agents: both
// use UID 1000. Only the deployment container mounts these owner-only volumes;
// an ordinary CI user cannot create them beneath root-owned /run and /srv.
export async function assertDeploymentLayout(context) {
  await checkedDirectory(context.root, context.uid, true);
  await checkedDirectory(context.tools, context.uid, true);
  if (context.platform === "linux")
    await checkedDirectory(context.publicTools, 0, false);
}

export function deploymentEnvironment(node, home, platform = process.platform) {
  return {
    PATH:
      dirname(node) +
      ":" +
      (platform === "linux" ? "/usr/local/bin" : "/opt/homebrew/bin") +
      ":/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: home,
    CI: "true",
    HUSKY: "0",
    LANG: platform === "linux" ? "C.UTF-8" : "en_US.UTF-8",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    VERCEL_TELEMETRY_DISABLED: "1",
    NEXT_TELEMETRY_DISABLED: "1",
  };
}

export function jenkinsTransport(url, context = DEPLOYMENT) {
  const parsed = new URL(url);
  if (
    parsed.origin !== new URL(CANONICAL_JENKINS).origin ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  )
    throw new Error("Jenkins transport must retain canonical local provenance");
  if (![LINUX_DEPLOY.jenkins, MAC_DEPLOY.jenkins].includes(context.jenkins))
    throw new Error("Unknown Jenkins transport endpoint");
  return new URL(parsed.pathname + parsed.search, context.jenkins).href;
}

export function canonicalJenkinsLocation(url, context = DEPLOYMENT) {
  jenkinsTransport(CANONICAL_JENKINS, context);
  const parsed = new URL(url);
  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    ![
      new URL(CANONICAL_JENKINS).origin,
      new URL(context.jenkins).origin,
    ].includes(parsed.origin) ||
    !/^(?:\/queue\/item\/[1-9][0-9]*\/|\/job\/[A-Za-z0-9-]+\/[1-9][0-9]*\/)$/.test(
      parsed.pathname,
    )
  )
    throw new Error("Untrusted Jenkins response location");
  return new URL(parsed.pathname, CANONICAL_JENKINS).href;
}
