import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify, parseEnv } from "node:util";
import { pathToFileURL } from "node:url";
import { validateConfig, SHA } from "./lib.mjs";

// This trusted, read-only collector is installed separately from CI workspaces.
// Archive exactly these files, never its input directory or raw command output.
export const ARCHIVE_FILES = Object.freeze([
  "report.json",
  "report.html",
  "api.redacted.log",
  "tunnel.redacted.log",
  "cicd.redacted.log",
  "build.redacted.log",
]);
const LABELS = Object.freeze({
  api: "com.douglasdong.agent-platform.api",
  cicd: "com.douglasdong.agent-platform.cicd",
  tunnel: "com.douglasdong.agent-platform.tunnel",
});
const MAX_BYTES = 65_536;
const MAX_LINES = 200;
const CHILD_ENV = Object.freeze({
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  LANG: "C",
});
const execute = promisify(execFile);
const ISO = (value) =>
  typeof value === "string" && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : null;
const natural = (value) =>
  Number.isSafeInteger(value) && value >= 0 ? value : null;
const pid = (value) => (natural(value) > 0 ? value : null);

export function redactLog(input, secrets = [], publicShas = []) {
  let text = String(input)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
  const values = secrets
    .filter((value) => typeof value === "string" && value.length >= 4)
    .flatMap((value) => [
      value,
      JSON.stringify(value).slice(1, -1),
      encodeURIComponent(value),
      Buffer.from(value).toString("base64"),
    ])
    .sort((a, b) => b.length - a.length);
  for (const value of values) text = text.split(value).join("[REDACTED]");
  const safeShas = new Set(publicShas.filter((value) => SHA.test(value)));
  return text
    .split(/\r?\n/)
    .map((line) => {
      // Whole-line removal also handles JSON arrays, quoted headers and env dumps.
      if (
        /(?:authorization|proxy-authorization|cookie|bearer|passcode|password|passwd|secret|master.?key|private.?key|access.?key|api.?key|token|runtime\.env|cloudflared\.token)/i.test(
          line,
        ) ||
        /^\s*(?:export\s+)?[A-Z][A-Z0-9_]*\s*=/.test(line)
      )
        return "[REDACTED sensitive line]";
      return line
        .replace(/https?:\/\/\S+/gi, (raw) => {
          try {
            const url = new URL(raw);
            url.username = "";
            url.password = "";
            if (url.search) url.search = "?redacted";
            url.hash = "";
            return url.toString();
          } catch {
            return "[REDACTED URL]";
          }
        })
        .replace(
          /(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|eyJ[A-Za-z0-9_+\/-]{12,}={0,2}(?:\.[A-Za-z0-9_+\/-]+){0,2}|[A-Za-z0-9_+\/-]{32,}={0,2})/g,
          (value) => (safeShas.has(value) ? value : "[REDACTED opaque value]"),
        );
    })
    .join("\n");
}

async function readRegular(path, { privateOnly = false, tail = false } = {}) {
  const handle = await fs.open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      (privateOnly &&
        ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()))
    )
      throw new Error("unsafe-file");
    if (!tail && stat.size > MAX_BYTES) throw new Error("oversized-file");
    const offset = tail ? Math.max(0, stat.size - MAX_BYTES) : 0;
    const buffer = Buffer.alloc(Math.min(stat.size, MAX_BYTES));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    let text = buffer.subarray(0, bytesRead).toString("utf8");
    // Never retain an incomplete leading line, which could begin midway through a secret.
    if (offset > 0)
      text = text.slice(
        text.indexOf("\n") < 0 ? text.length : text.indexOf("\n") + 1,
      );
    if (tail && !text.endsWith("\n"))
      text = text.slice(0, Math.max(0, text.lastIndexOf("\n") + 1));
    return { text, truncated: offset > 0, sourceBytes: stat.size };
  } finally {
    await handle.close();
  }
}

async function jsonFile(path) {
  try {
    return { ok: true, value: JSON.parse((await readRegular(path)).text) };
  } catch (error) {
    return {
      ok: false,
      reason: error.code === "ENOENT" ? "missing" : "unavailable",
    };
  }
}

export function projectController(value, secrets = []) {
  if (!value || typeof value !== "object") return { available: false };
  return {
    available: true,
    state:
      typeof value.state === "string" && /^[a-z][a-z-]{0,80}$/.test(value.state)
        ? value.state
        : "unknown",
    sha: SHA.test(value.sha) ? value.sha : null,
    runId: natural(value.runId),
    updatedAt: ISO(value.updatedAt),
    error:
      typeof value.error === "string"
        ? redactLog(value.error, secrets).slice(0, 400)
        : null,
  };
}

export function projectLaunchctl(output, domain, label) {
  const text = String(output);
  const field = (name) =>
    text.match(new RegExp(`^\\t${name} = ([^\\r\\n]+)$`, "m"))?.[1]?.trim();
  const state = field("state");
  return {
    domain,
    label,
    loaded: true,
    state: ["running", "waiting", "exited", "not running"].includes(state)
      ? state
      : "unknown",
    pid: pid(Number(field("pid"))),
    runs: natural(Number(field("runs"))),
    lastExitCode: /^-?\d+$/.test(field("last exit code") ?? "")
      ? Number(field("last exit code"))
      : null,
  };
}

export function elapsedSeconds(text) {
  const match = String(text)
    .trim()
    .match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!match) return null;
  return (
    Number(match[1] ?? 0) * 86400 +
    Number(match[2] ?? 0) * 3600 +
    Number(match[3]) * 60 +
    Number(match[4])
  );
}

function projectApi(kind, value) {
  if (!value || typeof value !== "object") throw new Error("invalid-response");
  if (kind === "health") {
    if (
      value.status !== "ok" ||
      !Number.isFinite(value.uptimeSec) ||
      value.uptimeSec < 0
    )
      throw new Error("invalid-response");
    return { status: "ok", uptimeSec: value.uptimeSec };
  }
  if (kind === "version")
    return {
      commit: SHA.test(value.commit) ? value.commit : null,
      version:
        typeof value.version === "string" &&
        /^[a-zA-Z0-9._-]{1,60}$/.test(value.version)
          ? value.version
          : null,
      builtAt: ISO(value.builtAt),
    };
  const result = {};
  for (const key of ["ready", "draining", "idle"]) {
    if (typeof value[key] !== "boolean") throw new Error("invalid-response");
    result[key] = value[key];
  }
  result.readiness = {};
  for (const key of ["database", "provider", "image"]) {
    if (typeof value.readiness?.[key] !== "boolean")
      throw new Error("invalid-response");
    result.readiness[key] = value.readiness[key];
  }
  for (const key of ["inFlightHTTP", "activeWS", "credentialAuth"]) {
    if (natural(value[key]) === null) throw new Error("invalid-response");
    result[key] = value[key];
  }
  result.blockers = {};
  for (const key of [
    "sandboxes",
    "agentTasks",
    "automationRuns",
    "enabledAutomations",
    "resourceAllocations",
    "cloningProjects",
    "projectCleanupJobs",
  ]) {
    if (natural(value.blockers?.[key]) === null)
      throw new Error("invalid-response");
    result.blockers[key] = value.blockers[key];
  }
  return result;
}

async function apiProbe(kind, path, bearer, fetchImpl) {
  const started = Date.now();
  try {
    const response = await fetchImpl(`http://127.0.0.1:3101${path}`, {
      method: "GET",
      redirect: "error",
      credentials: "omit",
      headers:
        kind === "health"
          ? { accept: "application/json" }
          : { accept: "application/json", authorization: `Bearer ${bearer}` },
      signal: AbortSignal.timeout(5000),
    });
    const meta = {
      httpStatus: response.status,
      durationMs: Date.now() - started,
    };
    if (!response.ok)
      return {
        ...meta,
        ok: false,
        reason:
          response.status === 401 || response.status === 403
            ? "unauthorized"
            : "http-error",
      };
    const reader = response.body?.getReader();
    if (!reader) throw new Error("invalid-response");
    const chunks = [];
    let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > MAX_BYTES) throw new Error("invalid-response");
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    const body = Buffer.concat(chunks).toString("utf8");
    return { ...meta, ok: true, ...projectApi(kind, JSON.parse(body)) };
  } catch (error) {
    return {
      ok: false,
      reason:
        error.name === "TimeoutError" || error.name === "AbortError"
          ? "timeout"
          : "unavailable",
      durationMs: Date.now() - started,
    };
  }
}

function metadata(input) {
  let buildUrl = null;
  try {
    const url = new URL(input.BUILD_URL);
    if (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password
    ) {
      url.search = "";
      url.hash = "";
      buildUrl = url.toString();
    }
  } catch {
    /* Optional Jenkins metadata. */
  }
  return {
    buildNumber: /^\d{1,12}$/.test(input.BUILD_NUMBER ?? "")
      ? Number(input.BUILD_NUMBER)
      : null,
    jobName: /^[\w ./-]{1,120}$/.test(input.JOB_NAME ?? "")
      ? input.JOB_NAME
      : null,
    buildUrl,
  };
}

export async function collectMonitor(configPath, operations = {}) {
  const start = new Date().toISOString();
  const config = validateConfig(
    JSON.parse(
      (await readRegular(resolve(configPath), { privateOnly: true })).text,
    ),
  );
  const root = resolve(config.root);
  if (
    dirname(resolve(configPath)) !== root ||
    !["config.json", "jenkins-staging-config.json"].includes(
      basename(configPath),
    ) ||
    config.runtimeEnvFile !== join(root, "runtime.env") ||
    config.uid !== process.getuid()
  )
    throw new Error("Invalid monitor configuration boundary");
  const rootStat = await fs.lstat(root);
  if (
    !rootStat.isDirectory() ||
    (rootStat.mode & 0o077) !== 0 ||
    rootStat.uid !== process.getuid() ||
    (await fs.realpath(root)) !== root
  )
    throw new Error("Invalid monitor root boundary");
  const runtime = parseEnv(
    (await readRegular(config.runtimeEnvFile, { privateOnly: true })).text,
  );
  if (
    runtime.HOST !== "127.0.0.1" ||
    runtime.PORT !== "3101" ||
    !runtime.ACCESS_PASSCODE
  )
    throw new Error(
      "Monitor only probes the approved production loopback endpoint",
    );
  const secrets = Object.entries(runtime)
    .filter(([key]) =>
      /passcode|secret|master.?key|token|password|api.?key/i.test(key),
    )
    .map(([, value]) => value);
  const run = operations.execute ?? execute;
  const now = operations.now ?? Date.now;
  const domain = config.launchdDomain;
  const [controllerFile, runtimeFile, ...services] = await Promise.all([
    jsonFile(join(root, "status.json")),
    jsonFile(join(root, "runtime-state.json")),
    ...Object.entries(LABELS).map(async ([kind, label]) => {
      const serviceDomain = kind === "cicd" ? `gui/${config.uid}` : domain;
      try {
        const result = await run(
          "/bin/launchctl",
          ["print", `${serviceDomain}/${label}`],
          { env: CHILD_ENV, timeout: 3000, maxBuffer: MAX_BYTES },
        );
        return {
          ...projectLaunchctl(result.stdout, serviceDomain, label),
          required: kind !== "cicd",
        };
      } catch {
        return {
          domain: serviceDomain,
          label,
          loaded: false,
          state: "unavailable",
          pid: null,
          required: kind !== "cicd",
        };
      }
    }),
  ]);
  const controller = controllerFile.ok
    ? projectController(controllerFile.value, secrets)
    : { available: false, reason: controllerFile.reason };
  const state = runtimeFile.ok ? runtimeFile.value : {};
  const runtimeStatus = {
    available: runtimeFile.ok,
    sha: SHA.test(state.sha) ? state.sha : null,
    pid: pid(state.pid),
    supervisorPid: pid(state.supervisorPid),
    startedAt: ISO(state.startedAt),
    processState: "unknown",
    uptimeSec: null,
  };
  if (runtimeStatus.pid) {
    try {
      (operations.kill ?? process.kill)(runtimeStatus.pid, 0);
      runtimeStatus.processState = "alive";
      const result = await run(
        "/bin/ps",
        ["-p", String(runtimeStatus.pid), "-o", "etime="],
        { env: CHILD_ENV, timeout: 3000, maxBuffer: 1024 },
      );
      runtimeStatus.uptimeSec = elapsedSeconds(result.stdout);
    } catch (error) {
      runtimeStatus.processState = error.code === "ESRCH" ? "dead" : "unknown";
    }
  }
  let release = { available: false };
  try {
    const current = await fs.realpath(join(root, "current"));
    const sha = current.split(sep).at(-1);
    if (!SHA.test(sha) || dirname(current) !== join(root, "releases"))
      throw new Error("invalid-release");
    const manifest = (await jsonFile(join(current, ".macmini-release.json")))
      .value;
    if (manifest?.sha !== sha) throw new Error("invalid-release");
    release = {
      available: true,
      sha,
      builtAt: ISO(manifest.builtAt),
      schemaHash: /^[a-f0-9]{64}$/.test(manifest.schemaHash)
        ? manifest.schemaHash
        : null,
      boxliteVersion: /^\d+\.\d+\.\d+$/.test(manifest.boxliteVersion)
        ? manifest.boxliteVersion
        : null,
    };
  } catch {
    /* Never copy release paths or the manifest's data/credential fields. */
  }
  const [health, version, deployment] = await Promise.all([
    apiProbe(
      "health",
      "/api/health",
      runtime.ACCESS_PASSCODE,
      operations.fetch ?? fetch,
    ),
    apiProbe(
      "version",
      "/api/system/version",
      runtime.ACCESS_PASSCODE,
      operations.fetch ?? fetch,
    ),
    apiProbe(
      "deployment",
      "/api/deployment/status",
      runtime.ACCESS_PASSCODE,
      operations.fetch ?? fetch,
    ),
  ]);
  const publicShas = [
    controller.sha,
    runtimeStatus.sha,
    release.sha,
    version.commit,
  ].filter(Boolean);
  const logs = {};
  let safeLogDirectory = false;
  try {
    const logDir = join(root, "logs");
    const stat = await fs.lstat(logDir);
    safeLogDirectory =
      stat.isDirectory() &&
      stat.uid === process.getuid() &&
      (stat.mode & 0o077) === 0 &&
      (await fs.realpath(logDir)) === logDir;
  } catch {
    /* Log access is optional and fails closed. */
  }
  for (const kind of ["api", "tunnel", "cicd", "build"]) {
    try {
      if (!safeLogDirectory) throw new Error("unsafe-log-directory");
      if (kind === "build" && !controller.sha)
        throw new Error("missing-build-sha");
      const source = await readRegular(
        join(
          root,
          "logs",
          kind === "build" ? `build-${controller.sha}.log` : `${kind}.log`,
        ),
        { tail: true },
      );
      const lines = source.text.split(/\r?\n/);
      const kept = lines.slice(-MAX_LINES);
      logs[kind] = {
        available: true,
        truncated: source.truncated || lines.length > MAX_LINES,
        sourceBytes: source.sourceBytes,
        content: `${redactLog(kept.join("\n"), secrets, publicShas)}\n`,
      };
    } catch {
      logs[kind] = {
        available: false,
        content: "Log unavailable; raw source was not archived.\n",
      };
    }
  }
  const problems = [];
  if (!health.ok) problems.push("api-health-unavailable");
  if (!deployment.ok || deployment.ready !== true)
    problems.push("api-readiness-unverified");
  if (
    !version.ok ||
    !release.available ||
    version.commit !== release.sha ||
    runtimeStatus.sha !== release.sha
  )
    problems.push("api-release-sha-unverified");
  if (runtimeStatus.processState !== "alive")
    problems.push("api-process-unverified");
  for (const [index, kind] of ["api", "cicd", "tunnel"].entries()) {
    if (!services[index].required) continue;
    if (!services[index].loaded) problems.push(`${kind}-launchd-unavailable`);
    else if (kind !== "cicd" && services[index].state !== "running")
      problems.push(`${kind}-launchd-not-running`);
  }
  const report = {
    schemaVersion: 1,
    collectedAt: start,
    finishedAt: new Date(now()).toISOString(),
    health: problems.length ? "unhealthy" : "healthy",
    problems,
    jenkins: metadata(operations.metadata ?? process.env),
    controller,
    runtime: runtimeStatus,
    release,
    services,
    api: { origin: "http://127.0.0.1:3101", health, version, deployment },
    logs: Object.fromEntries(
      Object.entries(logs).map(([key, { content: _content, ...meta }]) => [
        key,
        meta,
      ]),
    ),
    note: "Read-only observations collected over a time window; readiness is not a VM probe and idle is reported, never assumed.",
  };
  // Final exact-value filtering also covers malicious/accidental copies into metadata.
  return { report: redactKnownJson(report, secrets), logs };
}

function redactKnownJson(value, secrets) {
  if (typeof value === "string") {
    for (const secret of secrets.filter(
      (item) => typeof item === "string" && item.length >= 4,
    )) {
      for (const form of [
        secret,
        encodeURIComponent(secret),
        Buffer.from(secret).toString("base64"),
      ])
        value = value.split(form).join("[REDACTED]");
    }
    return value;
  }
  if (Array.isArray(value))
    return value.map((item) => redactKnownJson(item, secrets));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        redactKnownJson(item, secrets),
      ]),
    );
  return value;
}

export function renderHtml(report) {
  const escape = (value) =>
    String(value).replace(
      /[&<>"']/g,
      (char) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[char],
    );
  const table = (rows) =>
    `<table><tbody>${rows.map(([label, value]) => `<tr><th scope="row">${escape(label)}</th><td>${escape(value ?? "unverified")}</td></tr>`).join("")}</tbody></table>`;
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'none'; base-uri 'none'; form-action 'none'"><title>Agent platform runtime monitor</title><body><h1>Agent platform runtime monitor</h1><p>State: <strong>${escape(report.health)}</strong></p><p>Collected ${escape(report.collectedAt)}</p><h2>Checks</h2><ul>${report.problems.map((problem) => `<li>${escape(problem)}</li>`).join("") || "<li>All required checks verified.</li>"}</ul><h2>Runtime</h2>${table(
    [
      ["Deployment", report.controller.state],
      ["Current release", report.release.sha],
      ["API commit", report.api.version.commit],
      ["API PID", report.runtime.pid],
      ["API uptime (seconds)", report.api.health.uptimeSec],
      ["Ready", report.api.deployment.ready],
      ["Idle", report.api.deployment.idle],
      ["Draining", report.api.deployment.draining],
    ],
  )}<h2>Persistent services</h2>${table(report.services.map((service) => [service.label, `${service.domain} · ${service.state} · PID ${service.pid ?? "unverified"}`]))}<h2>Full snapshot</h2><pre>${escape(JSON.stringify(report, null, 2))}</pre><h2>Redacted log tails</h2><ul>${ARCHIVE_FILES.filter(
    (name) => name.endsWith(".log"),
  )
    .map((name) => `<li><a href="${name}">${name}</a></li>`)
    .join(
      "",
    )}</ul><p>Only the six allowlisted report and redacted log files are suitable for archiving.</p></body></html>\n`;
}

export async function writeMonitor(outputDir, snapshot, root) {
  const output = resolve(outputDir);
  const source = resolve(root);
  const managedWorkspace = join(source, "jenkins-agent", "workspace");
  const inManagedWorkspace = output.startsWith(`${managedWorkspace}${sep}`);
  if (
    output === source ||
    (output.startsWith(`${source}${sep}`) && !inManagedWorkspace) ||
    source.startsWith(`${output}${sep}`)
  )
    throw new Error("Report output must be separate from production files");
  if ((await fs.realpath(dirname(output))) !== dirname(output))
    throw new Error("Report parent must be a real directory");
  await fs.mkdir(output, { mode: 0o700 }); // Refuse existing directories, links and stale artifacts.
  const contents = {
    "report.json": `${JSON.stringify(snapshot.report, null, 2)}\n`,
    "report.html": renderHtml(snapshot.report),
    ...Object.fromEntries(
      Object.entries(snapshot.logs).map(([kind, log]) => [
        `${kind}.redacted.log`,
        log.content,
      ]),
    ),
  };
  for (const name of ARCHIVE_FILES) {
    if (typeof contents[name] !== "string")
      throw new Error("Incomplete monitor snapshot");
    await fs.writeFile(join(output, name), contents[name], {
      flag: "wx",
      mode: 0o600,
    });
  }
  return ARCHIVE_FILES;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    if (
      process.versions.node.split(".")[0] !== "22" ||
      process.platform !== "darwin" ||
      process.argv.length !== 4
    )
      throw new Error("Unsupported invocation");
    const snapshot = await collectMonitor(process.argv[2]);
    const root = dirname(resolve(process.argv[2]));
    await writeMonitor(process.argv[3], snapshot, root);
    console.log(
      JSON.stringify({
        reportCreated: true,
        health: snapshot.report.health,
        files: ARCHIVE_FILES,
      }),
    );
    process.exitCode = snapshot.report.health === "healthy" ? 0 : 2;
  } catch {
    // Do not print native errors: file/HTTP/process failures may contain private material.
    console.error(
      JSON.stringify({
        reportCreated: false,
        error: "monitor-collection-failed",
      }),
    );
    process.exitCode = 1;
  }
}
