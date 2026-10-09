import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

const allowedJobs = new Set([
  "agent-platform-api",
  "agent-platform-native-ci",
  "agent-platform-service-monitor",
  "agent-platform-ci-discovery",
  "agent-platform-web",
  "agent-platform-release",
  "agent-platform-contract",
  "agent-platform-mutation",
  "agent-platform-sandbox-images",
]);
const releaseJob = "agent-platform-release";
const discoveryJob = "agent-platform-ci-discovery";
const actions = [
  "status",
  "sync-pipelines",
  "refresh",
  "enable",
  "disable",
  "build",
  "activate",
  "download-agent",
  "build-status",
  "pipeline-lint",
  "quiet-down",
  "cancel-quiet-down",
  "queue",
  "wait-idle",
];
const usage = `Use ${actions.join("|")}`;
const IDLE_POLL_MS = 10_000;
export const DEFAULT_IDLE_TIMEOUT_SECONDS = 1800;
// The release job's own timeout; waiting longer cannot help.
export const MAX_IDLE_TIMEOUT_SECONDS = 4 * 60 * 60;
const IDLE_TREES = {
  controller:
    "api/json?tree=quietingDown,jobs[name,disabled,builds[number,building]]",
  queue:
    "queue/api/json?tree=items[id,why,blocked,buildable,stuck,inQueueSince,task[name]]",
  computers:
    "computer/api/json?tree=computer[displayName,executors[idle,currentExecutable[fullDisplayName]],oneOffExecutors[idle,currentExecutable[fullDisplayName]]]",
};

export function parseWaitIdleArguments(args) {
  const invalid = () =>
    new Error(
      `Use wait-idle [--timeout <seconds>], 1-${MAX_IDLE_TIMEOUT_SECONDS} seconds`,
    );
  let value;
  if (args.length === 2 && args[0] === "--timeout") value = args[1];
  else if (args.length === 1 && args[0].startsWith("--timeout="))
    value = args[0].slice("--timeout=".length);
  else if (args.length !== 0) throw invalid();
  if (value === undefined)
    return { timeoutSeconds: DEFAULT_IDLE_TIMEOUT_SECONDS };
  if (!/^[1-9]\d*$/.test(value) || Number(value) > MAX_IDLE_TIMEOUT_SECONDS)
    throw invalid();
  return { timeoutSeconds: Number(value) };
}

export function queueItems(queue) {
  if (!Array.isArray(queue?.items))
    throw new Error("Unexpected Jenkins queue response");
  return queue.items.map((item) => ({
    id: item.id,
    job: item.task?.name ?? "unknown",
    why: item.why ?? null,
    blocked: item.blocked === true,
    buildable: item.buildable === true,
    stuck: item.stuck === true,
    inQueueSince: Number.isFinite(item.inQueueSince)
      ? new Date(item.inQueueSince).toISOString()
      : null,
  }));
}

/** Idle = no build running, no executor (regular or one-off) busy and an empty queue. */
export function idleReport({ controller, queue, computers }) {
  if (!Array.isArray(controller?.jobs) || !Array.isArray(computers?.computer))
    throw new Error("Unexpected Jenkins status response");
  const runningBuilds = [];
  for (const job of controller.jobs)
    for (const build of job.builds ?? [])
      if (build.building) runningBuilds.push(`${job.name} #${build.number}`);
  const busyExecutors = [];
  for (const computer of computers.computer)
    for (const executor of [
      ...(computer.executors ?? []),
      ...(computer.oneOffExecutors ?? []),
    ])
      if (executor.idle !== true || executor.currentExecutable)
        busyExecutors.push(
          `${computer.displayName}: ${executor.currentExecutable?.fullDisplayName ?? "busy"}`,
        );
  const queued = queueItems(queue);
  return {
    idle: !runningBuilds.length && !busyExecutors.length && !queued.length,
    quietingDown: controller.quietingDown === true,
    disabledJobs: controller.jobs
      .filter((job) => job.disabled === true)
      .map((job) => job.name)
      .sort(),
    runningBuilds,
    busyExecutors,
    queued: queued.map((item) => item.job),
  };
}

/** Names only: Jenkins job, build and node names, never URLs or credentials. */
export function describeBusy(report) {
  const parts = [];
  if (report.runningBuilds.length)
    parts.push(`running builds: ${report.runningBuilds.join(", ")}`);
  if (report.busyExecutors.length)
    parts.push(`busy executors: ${report.busyExecutors.join(", ")}`);
  if (report.queued.length)
    parts.push(
      `${report.quietingDown ? "queued until cancel-quiet-down" : "queued"}: ${report.queued.join(", ")}`,
    );
  return parts.join("; ") || "idle";
}

export async function waitForIdle(
  read,
  { timeoutMs, intervalMs = IDLE_POLL_MS, sleep, now, onWaiting = () => {} },
) {
  const started = now();
  for (;;) {
    const report = await read();
    const elapsed = now() - started;
    if (report.idle)
      return { ...report, waitedSeconds: Math.round(elapsed / 1000) };
    if (elapsed >= timeoutMs)
      throw new Error(
        `Jenkins did not become idle within ${Math.round(timeoutMs / 1000)} seconds (${describeBusy(report)})`,
      );
    onWaiting(report, elapsed);
    await sleep(Math.min(intervalMs, timeoutMs - elapsed));
  }
}

export function activationScript() {
  return `def j=jenkins.model.Jenkins.get()
if (System.getenv('AGENT_PLATFORM_CONTROLLER_MODE') != 'active') throw new IllegalStateException('Switch the controller to active mode before activating managed jobs and agents')
if (j.numExecutors != 0 || j.slaveAgentPort != -1) throw new IllegalStateException('Controller execution isolation is required')
def specs = [
  [name:'linux-deploy', label:'agent-platform-linux-deploy'],
  [name:'linux-ci', label:'agent-platform-linux-ci'],
  [name:'linux-web-amd64', label:'agent-platform-web-build']
]
specs.each { spec ->
  def node=j.getNode(spec.name)
  if(node != null && (node.labelString != spec.label || node.numExecutors != 1 || node.mode != hudson.model.Node.Mode.EXCLUSIVE)) throw new IllegalStateException('A managed agent differs from its fixed policy')
}
def f=new File(j.rootDir,'bootstrap-settings.json')
def s=new groovy.json.JsonSlurper().parse(f)
s.enabled=true
f.text=groovy.json.JsonOutput.toJson(s)
def jobs=[]
${JSON.stringify([...allowedJobs])}.each { name -> def job=j.getItem(name); if(job != null){job.setDisabled(false);job.save();jobs.add(name)} }
def online=[]; def waiting=[]
specs.each { spec ->
  def computer=j.getNode(spec.name)?.toComputer()
  if(computer != null && computer.getChannel() != null){computer.setTemporarilyOffline(false,null);online.add(spec.name)}
  else waiting.add(spec.name)
}
println(groovy.json.JsonOutput.toJson([state:'activated',controllerMode:'active',jobsActivated:jobs,nodesOnline:online,nodesWaitingForConnection:waiting]))`;
}

// Pipeline templates are sent exactly as reviewed. Host values never enter
// them, so a leftover @KEY@ placeholder is refused rather than substituted.
export function reviewedPipeline(text) {
  if (/@[A-Z_0-9]+@/.test(text))
    throw new Error("Pipeline templates must not contain @KEY@ placeholders");
  return text;
}

// O_NOFOLLOW + fstat: the running account's single-link regular file, closed
// to group and others.
async function readCredential(path) {
  const unsafe = () => new Error("Unsafe private API credential");
  const before = await fs.lstat(path);
  if (!before.isFile()) throw unsafe();
  const handle = await fs
    .open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
    .catch(() => {
      throw unsafe();
    });
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.dev !== before.dev ||
      stat.ino !== before.ino ||
      stat.uid !== process.getuid() ||
      stat.mode & 0o077 ||
      stat.nlink !== 1
    )
      throw unsafe();
    return JSON.parse(await handle.readFile("utf8"));
  } finally {
    await handle.close();
  }
}

// The CLI at the end of this file derives tools, base and assertListener from
// the Mac host layout; tests pass fakes. Nothing here assumes an account.
export async function runManagement(
  args = process.argv.slice(2),
  {
    fetchImpl = fetch,
    tools: toolsDirectory,
    base: baseUrl,
    assertListener,
    sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
    now = Date.now,
  } = {},
) {
  const [action, name, file] = args;

  if (!actions.includes(action)) throw new Error(usage);
  // Argument errors surface before the private credential is read.
  if (["quiet-down", "cancel-quiet-down", "queue"].includes(action)) {
    if (args.length !== 1) throw new Error(`Use ${action} without arguments`);
  }
  const waitIdle =
    action === "wait-idle" ? parseWaitIdleArguments(args.slice(1)) : null;
  if (
    typeof toolsDirectory !== "string" ||
    typeof baseUrl !== "string" ||
    typeof assertListener !== "function"
  )
    throw new Error(
      "Jenkins management requires the private tools directory, the Jenkins URL and a listener check",
    );
  const credential = await readCredential(
    join(toolsDirectory, "admin-api.json"),
  );
  const authorization = `Basic ${Buffer.from(`${credential.username}:${credential.token}`).toString("base64")}`;
  // A loopback port is first come, first served across accounts: the listener
  // is confirmed before every credentialed request. Concurrent requests share
  // one check.
  let listener = null;
  async function request(path, options = {}) {
    listener ??= Promise.resolve()
      .then(() => assertListener())
      .finally(() => {
        listener = null;
      });
    await listener;
    const { acceptRedirect = false, ...init } = options;
    const response = await fetchImpl(`${baseUrl}${path}`, {
      ...init,
      headers: { authorization, ...init.headers },
      // quietDown/cancelQuietDown answer 302 (back to the dashboard) once applied.
      redirect: acceptRedirect ? "manual" : "error",
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok && !(acceptRedirect && response.status === 302))
      throw new Error(`Jenkins HTTP ${response.status}`);
    return response;
  }
  const json = async (path) => (await request(path)).json();
  async function readIdleState() {
    const [controller, queue, computers] = await Promise.all([
      json(IDLE_TREES.controller),
      json(IDLE_TREES.queue),
      json(IDLE_TREES.computers),
    ]);
    return idleReport({ controller, queue, computers });
  }
  async function controllerState() {
    const controller = await json(
      "api/json?tree=quietingDown,jobs[name,disabled]",
    );
    if (
      typeof controller?.quietingDown !== "boolean" ||
      !Array.isArray(controller.jobs)
    )
      throw new Error("Unexpected Jenkins status response");
    return {
      quietingDown: controller.quietingDown,
      disabledJobs: controller.jobs
        .filter((job) => job.disabled === true)
        .map((job) => job.name)
        .sort(),
    };
  }
  async function script(text) {
    const result = await (
      await request("scriptText", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ script: text }),
      })
    ).text();
    if (/Exception|ERROR|groovy\.lang\./.test(result))
      throw new Error(
        "Jenkins configuration failed; server script output is withheld",
      );
    return result.trim();
  }
  if (action === "status") {
    const controller = await (
      await request(
        "api/json?tree=numExecutors,quietingDown,jobs[name,color,buildable,lastBuild[number,result,url,building]]",
      )
    ).json();
    const computers = await (
      await request(
        "computer/api/json?tree=computer[displayName,offline,temporarilyOffline,numExecutors]",
      )
    ).json();
    console.log(JSON.stringify({ controller, computers }, null, 2));
  } else if (action === "sync-pipelines") {
    const directory = dirname(fileURLToPath(import.meta.url));
    const files = {};
    for (const name of [
      "api.groovy",
      "native-ci.groovy",
      "monitor.groovy",
      "discover.groovy",
      "release.groovy",
      "contract.groovy",
      "web.groovy",
      "mutation.groovy",
      "sandbox-images.groovy",
    ]) {
      const text = await fs.readFile(join(directory, name), "utf8");
      files[name] = Buffer.from(reviewedPipeline(text)).toString("base64");
    }
    const encoded = Buffer.from(JSON.stringify(files)).toString("base64");
    console.log(
      await script(
        `def j=jenkins.model.Jenkins.get(); def files=new groovy.json.JsonSlurper().parseText(new String('${encoded}'.decodeBase64(),'UTF-8')); files.each { name,value -> def f=new File(j.rootDir,'managed-pipelines/'+name); f.bytes=value.decodeBase64(); java.nio.file.Files.setPosixFilePermissions(f.toPath(),java.nio.file.attribute.PosixFilePermissions.fromString('rw-------')) }; println('Reviewed managed pipeline templates synchronized')`,
      ),
    );
  } else if (action === "refresh") {
    const code = await fs.readFile(
      join(dirname(fileURLToPath(import.meta.url)), "bootstrap.groovy"),
      "utf8",
    );
    console.log(await script(code));
  } else if (["enable", "disable", "build"].includes(action)) {
    if (!allowedJobs.has(name)) throw new Error("Unknown managed job");
    if (action === "build") {
      const params = file ? JSON.parse(await fs.readFile(file, "utf8")) : {};
      const response = await request(
        `job/${name}/${Object.keys(params).length ? "buildWithParameters" : "build"}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams(params),
        },
      );
      console.log(
        JSON.stringify({
          state: "queued",
          job: name,
          queue: response.headers.get("location"),
        }),
      );
    } else {
      console.log(
        await script(
          `def job=jenkins.model.Jenkins.get().getItem('${name}'); job.setDisabled(${action === "disable"}); job.save(); println('${action}: ${name}')`,
        ),
      );
    }
  } else if (action === "activate") {
    console.log(await script(activationScript()));
  } else if (action === "download-agent") {
    const bytes = new Uint8Array(
      await (await request("jnlpJars/agent.jar")).arrayBuffer(),
    );
    await fs.writeFile(join(toolsDirectory, "agent.jar"), bytes, {
      mode: 0o600,
    });
    await fs.writeFile(
      join(toolsDirectory, "agent.jar.sha256"),
      `${createHash("sha256").update(bytes).digest("hex")}  agent.jar\n`,
      { mode: 0o600 },
    );
    console.log(
      JSON.stringify({
        state: "downloaded",
        sha256: createHash("sha256").update(bytes).digest("hex"),
      }),
    );
  } else if (action === "build-status") {
    if (!allowedJobs.has(name) || !/^[1-9]\d*$/.test(file ?? ""))
      throw new Error("Invalid job/build");
    console.log(
      JSON.stringify(
        await (
          await request(
            `job/${name}/${file}/api/json?tree=number,result,building,url,duration,description,artifacts[fileName,relativePath]`,
          )
        ).json(),
        null,
        2,
      ),
    );
  } else if (action === "pipeline-lint") {
    const text = await fs.readFile(name, "utf8");
    console.log(
      await (
        await request("pipeline-model-converter/validate", {
          method: "POST",
          body: new URLSearchParams({ jenkinsfile: text }),
        })
      ).text(),
    );
  } else if (action === "queue") {
    const items = queueItems(await json(IDLE_TREES.queue));
    console.log(JSON.stringify({ count: items.length, items }, null, 2));
  } else if (action === "wait-idle") {
    const report = await waitForIdle(readIdleState, {
      timeoutMs: waitIdle.timeoutSeconds * 1000,
      sleep,
      now,
      onWaiting: (state, elapsed) =>
        console.error(
          JSON.stringify({
            state: "waiting",
            elapsedSeconds: Math.round(elapsed / 1000),
            quietingDown: state.quietingDown,
            runningBuilds: state.runningBuilds,
            busyExecutors: state.busyExecutors,
            queued: state.queued,
          }),
        ),
    });
    console.log(
      JSON.stringify({
        state: "idle",
        waitedSeconds: report.waitedSeconds,
        quietingDown: report.quietingDown,
        disabledJobs: report.disabledJobs,
      }),
    );
  } else if (action === "quiet-down") {
    // A running release/api/web build waits on a child build that quietDown keeps
    // queued until the parent times out, so quietDown is only sent to an idle
    // controller whose release and discovery jobs are already disabled.
    const before = await readIdleState();
    if (before.quietingDown) {
      console.log(
        JSON.stringify({
          state: "quieting-down",
          quietingDown: true,
          alreadyQuietingDown: true,
          disabledJobs: before.disabledJobs,
        }),
      );
      return;
    }
    const blockers = [releaseJob, discoveryJob]
      .filter((job) => !before.disabledJobs.includes(job))
      .map((job) => `${job} is not disabled`);
    if (!before.idle) blockers.push(describeBusy(before));
    if (blockers.length)
      throw new Error(
        `quietDown was not sent: ${blockers.join("; ")}. Disable ${releaseJob} and ${discoveryJob}, run wait-idle, then retry`,
      );
    const response = await request("quietDown", {
      method: "POST",
      acceptRedirect: true,
    });
    await response.body?.cancel();
    const after = await controllerState();
    if (!after.quietingDown)
      throw new Error("Jenkins does not report quietingDown after quietDown");
    console.log(
      JSON.stringify({
        state: "quieting-down",
        quietingDown: true,
        disabledJobs: after.disabledJobs,
      }),
    );
  } else if (action === "cancel-quiet-down") {
    const response = await request("cancelQuietDown", {
      method: "POST",
      acceptRedirect: true,
    });
    await response.body?.cancel();
    const after = await controllerState();
    if (after.quietingDown)
      throw new Error(
        "Jenkins still reports quietingDown after cancelQuietDown",
      );
    console.log(
      JSON.stringify({
        state: "quiet-down-cancelled",
        quietingDown: false,
        disabledJobs: after.disabledJobs,
      }),
    );
  } else throw new Error(usage);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  // Mac only, so imported here: the deploy image carries a copy of this file
  // without ../containers. As the stop-loss path it needs only the passwd
  // account, the private directory, admin-api.json and (before each request)
  // the operator's loopback listener; host-layout.json, COLIMA_HOME, sockets
  // and Docker are not consulted.
  const { loadHostLayout, assertJenkinsListener, JENKINS_PORTS } =
    await import("../containers/host-layout.mjs");
  const layout = await loadHostLayout({ requires: "manage" });
  const port = JENKINS_PORTS.production;
  await runManagement(process.argv.slice(2), {
    tools: layout.privateDir,
    base: `http://127.0.0.1:${port}/`,
    assertListener: () => assertJenkinsListener(port, layout.operator),
  });
}
