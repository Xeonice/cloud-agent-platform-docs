import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { ciContext, ciChildEnvironment, LINUX_CI } from "./ci-platform.mjs";

export const AGENT_SECRET_FILE = "/run/secrets/jenkins_agent_secret";
const JAVA = "/opt/java/openjdk/bin/java";
const JAR = "/usr/share/jenkins/agent.jar";
const NAMES = new Set(["linux-ci", "linux-web-amd64"]);

export function agentArguments(env) {
  const url = new URL(env.JENKINS_URL ?? "");
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !NAMES.has(env.JENKINS_AGENT_NAME) ||
    env.JENKINS_AGENT_SECRET_FILE !== AGENT_SECRET_FILE ||
    [
      "JENKINS_SECRET",
      "JENKINS_AGENT_SECRET",
      "JAVA_OPTS",
      "JAVA_TOOL_OPTIONS",
      "_JAVA_OPTIONS",
    ].some((key) => env[key] !== undefined)
  )
    throw new Error("Fixed CI agent connection configuration required");
  return [
    "-jar",
    JAR,
    "-url",
    url.href,
    "-name",
    env.JENKINS_AGENT_NAME,
    "-secret",
    "@" + AGENT_SECRET_FILE,
    "-webSocket",
    "-workDir",
    LINUX_CI.home + "/agent",
  ];
}

export async function validateSecretFile(path = AGENT_SECRET_FILE) {
  if (path !== AGENT_SECRET_FILE)
    throw new Error("Fixed agent secret file required");
  const handle = await fs.open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.mode & 0o022 ||
      ![0, 1000].includes(stat.uid) ||
      stat.size > 256
    )
      throw new Error("Agent secret must be a read-only regular file");
    const text = (await handle.readFile()).toString().trim();
    if (!/^[a-f0-9]{64}$/i.test(text))
      throw new Error("Agent secret file has an invalid format");
  } finally {
    await handle.close();
  }
}

async function main() {
  const context = ciContext();
  if (context.platform !== "linux")
    throw new Error("Container entrypoint requires the fixed Linux CI account");
  const args = agentArguments(process.env);
  await validateSecretFile();
  await fs.mkdir(context.home + "/agent", { recursive: true, mode: 0o700 });
  await fs.mkdir(context.temporary, { recursive: true, mode: 0o700 });
  const env = {
    ...ciChildEnvironment(process.execPath, context),
    USER: "jenkins",
    LOGNAME: "jenkins",
    JAVA_HOME: "/opt/java/openjdk",
  };
  const child = spawn(JAVA, args, { env, stdio: "inherit" });
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"])
    process.on(signal, () => child.kill(signal));
  child.once("error", () => {
    console.error("CI agent Java could not start");
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    process.exitCode = signal ? 1 : (code ?? 1);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => {
    // File/URL errors can quote inputs; never emit exception text or secret bytes.
    console.error(
      "CI agent startup refused; inspect the fixed connection metadata",
    );
    process.exitCode = 1;
  });
