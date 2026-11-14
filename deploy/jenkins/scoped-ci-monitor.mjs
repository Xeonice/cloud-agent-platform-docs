import * as fs from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readScopedRequest } from "./scoped-ci-request.mjs";
import {
  scopedRequests,
  exactParametersMatch,
  isTrustedJenkinsLocation,
} from "./jenkins-discover.mjs";
import { canonicalJenkinsLocation } from "./deployment-platform.mjs";
import {
  capacityDecision,
  ownedStopEndpoint,
  ownedChildStopEndpoint,
  ownedChildQueueStopEndpoint,
} from "./scoped-ci-guard.mjs";
import { readCredential } from "./manage.mjs";

const exec = promisify(execFile);
const origin = "http://127.0.0.1:8080/";
const historyPath = (job) =>
  `job/${job}/api/json?tree=builds[number,url,queueId,building,result,actions[parameters[name,value],causes[_class,upstreamProject,upstreamBuild]]]`;

// Independent of the short-lived advance client and its lock. Only observations
// and already recorded dispatch intent are used; this path cannot enqueue CI.
export async function stopOwnedRuns(
  request,
  snapshot,
  client,
  sent = new Set(),
  record = async () => {},
) {
  const scope = scopedRequests(request),
    active = [],
    errors = [];
  if (snapshot.scopeKey !== scope.key)
    throw new Error("Wrong scoped guard snapshot");
  const dispatches = [...snapshot.pending];
  for (const item of scope.requests) {
    const intent = snapshot.record?.dispatchIntents?.[item.repo];
    if (
      intent?.state !== "dispatching" ||
      dispatches.some((entry) => entry.repo === item.repo)
    )
      continue;
    if (
      intent.job !== item.job ||
      JSON.stringify(intent.params) !== JSON.stringify(item.params) ||
      !Array.isArray(intent.knownQueueIds)
    )
      throw new Error(
        "Unknown dispatch intent differs from the frozen request",
      );
    const [queue, history] = await Promise.all([
      client.get("queue/api/json"),
      client.get(historyPath(item.job)),
    ]);
    const candidates = new Map();
    for (const queued of queue.items ?? [])
      if (
        queued.task?.name === item.job &&
        exactParametersMatch(queued, item.params) &&
        !intent.knownQueueIds.includes(queued.id)
      )
        candidates.set(queued.id, {
          queueId: queued.id,
          location: origin + `queue/item/${queued.id}/`,
        });
    for (const build of history.builds ?? [])
      if (
        exactParametersMatch(build, item.params) &&
        !intent.knownQueueIds.includes(build.queueId)
      )
        candidates.set(build.queueId, {
          queueId: build.queueId,
          location: canonicalJenkinsLocation(build.url),
          buildNumber: build.number,
          executableQueueId: build.queueId,
        });
    if (candidates.size !== 1) {
      errors.push("Unresolved dispatch intent; no redispatch or guessed stop");
      continue;
    }
    dispatches.push({
      ...item,
      ...[...candidates.values()][0],
      scopeKey: scope.key,
      dispatchedByScope: true,
    });
  }
  async function stop(endpoint) {
    active.push(endpoint.path);
    if (sent.has(endpoint.path)) return;
    sent.add(endpoint.path);
    await record({ state: "stop-requested", endpoint: endpoint.path });
    await client.post(endpoint.path);
    await record({ state: "stop-acknowledged", endpoint: endpoint.path });
  }
  for (const original of dispatches) {
    const item = structuredClone(original);
    try {
      const selected = scope.requests.find((entry) => entry.repo === item.repo);
      if (
        !selected ||
        item.scopeKey !== scope.key ||
        item.dispatchedByScope !== true ||
        item.job !== selected.job ||
        item.sha !== selected.sha ||
        item.ref !== selected.ref ||
        item.key !== selected.key ||
        JSON.stringify(item.params) !== JSON.stringify(selected.params) ||
        !Number.isSafeInteger(item.queueId) ||
        item.queueId < 1
      )
        throw new Error("Unowned dispatch tuple");
      if (!isTrustedJenkinsLocation(item.location, item.job))
        throw new Error("Untrusted owned location");
      item.location = canonicalJenkinsLocation(item.location);
      let actual = await client.get(
        new URL(item.location).pathname.slice(1) + "api/json",
      );
      if (item.location.includes("/queue/")) {
        if (
          actual.id !== item.queueId ||
          !exactParametersMatch(actual, item.params)
        )
          throw new Error("Owned queue changed");
        if (actual.cancelled && !actual.executable) continue;
        if (!actual.executable) {
          await stop(ownedStopEndpoint(request, item, actual));
          continue;
        }
        if (!isTrustedJenkinsLocation(actual.executable.url, item.job))
          throw new Error("Untrusted executable");
        item.location = canonicalJenkinsLocation(actual.executable.url);
        item.buildNumber = Number(
          new URL(item.location).pathname.split("/")[3],
        );
        item.executableQueueId = actual.id;
        actual = await client.get(
          new URL(item.location).pathname.slice(1) + "api/json",
        );
      }
      if (
        !exactParametersMatch(actual, item.params) ||
        actual.number !== item.buildNumber ||
        actual.queueId !== item.queueId ||
        canonicalJenkinsLocation(actual.url) !== item.location ||
        typeof actual.building !== "boolean"
      )
        throw new Error("Owned actual build changed");
      if (!actual.building) continue;
      if (item.repo === "web") {
        const child = scope.requests.find((entry) => entry.repo === "project");
        const upstream = (value) =>
          exactParametersMatch(value, child.params) &&
          (value.actions ?? [])
            .flatMap((action) => action.causes ?? [])
            .some(
              (cause) =>
                cause._class === "hudson.model.Cause$UpstreamCause" &&
                cause.upstreamProject === item.job &&
                cause.upstreamBuild === item.buildNumber,
            );
        const queue = await client.get("queue/api/json");
        for (const queued of queue.items ?? [])
          if (
            queued.task?.name === child.job &&
            upstream(queued) &&
            !queued.cancelled &&
            !queued.executable
          )
            await stop(
              ownedChildQueueStopEndpoint(request, item, actual, queued),
            );
        const history = await client.get(historyPath(child.job));
        for (const build of history.builds ?? []) {
          if (!upstream(build) || build.building !== true) continue;
          const fresh = await client.get(
            `job/${child.job}/${build.number}/api/json`,
          );
          if (fresh.building === false) continue;
          await stop(
            ownedChildStopEndpoint(
              request,
              item,
              actual,
              {
                scopeKey: scope.key,
                job: child.job,
                queueId: build.queueId,
                buildNumber: build.number,
                webBuildNumber: item.buildNumber,
              },
              fresh,
            ),
          );
        }
      }
      const fresh = await client.get(
        new URL(item.location).pathname.slice(1) + "api/json",
      );
      if (fresh.building !== false)
        await stop(ownedStopEndpoint(request, item, fresh));
    } catch (error) {
      errors.push(error.message);
    }
  }
  return {
    active,
    errors,
    terminal: active.length === 0 && errors.length === 0,
  };
}

export async function watchScopedCI({
  request,
  sample,
  snapshot,
  abort,
  stop,
  ready,
  log,
  interrupted = () => false,
  wait = (ms) => new Promise((done) => setTimeout(done, ms)),
  now = Date.now,
  maxMs = 3 * 60 * 60 * 1000,
  cleanupMs = 120_000,
}) {
  const scope = scopedRequests(request),
    baseline = await sample();
  const initial = capacityDecision(baseline, baseline, now());
  if (!initial.admitted)
    return { state: "held", reason: initial.reason, actions: 0 };
  const started = now();
  let failure,
    failedAt,
    aborted = false;
  await ready({ scopeKey: scope.key, baseline });
  for (;;) {
    const tick = now();
    try {
      const current = await sample(),
        decision = capacityDecision(baseline, current, now());
      await log({ kind: "capacity", ...current, decision });
      if (!decision.admitted) failure ??= decision.reason;
    } catch {
      failure ??= "capacity-observation-failed";
    }
    if (interrupted()) failure ??= "parent-interrupted";
    if (now() - started >= maxMs) failure ??= "monitor-deadline";
    let observed;
    try {
      observed = await snapshot();
    } catch {
      failure ??= "scoped-snapshot-failed";
    }
    if (observed && observed.scopeKey !== scope.key)
      throw new Error("Wrong native request scope");
    if (failure) {
      failedAt ??= now();
      if (!aborted) {
        try {
          await abort();
          aborted = true;
          await log({ kind: "guard-aborted", reason: failure });
        } catch {
          await log({ kind: "dispatch-abort-not-yet-observed" });
        }
      }
      let outcome;
      try {
        outcome = observed
          ? await stop(observed)
          : { terminal: false, errors: ["No current snapshot"] };
      } catch {
        outcome = {
          terminal: false,
          errors: ["Owned stop observation failed"],
        };
      }
      await log({ kind: "owned-stop-observation", ...outcome });
      if (aborted && outcome.terminal)
        return { state: "aborted-owned-runs-terminal", reason: failure };
      if (now() - failedAt >= cleanupMs)
        return {
          state: "held-owned-stop-not-terminal",
          reason: failure,
          outcome,
        };
    } else if (observed?.record) {
      const results = Object.values(observed.record.results ?? {});
      if (results.some((item) => item.result !== "SUCCESS"))
        return { state: "ci-failed" };
      if (
        results.length === 3 &&
        observed.pending.length === 0 &&
        observed.pendingStatuses === 0
      )
        return {
          state: "ci-passed-and-capacity-observed",
          scopeKey: scope.key,
        };
    }
    await wait(Math.max(1, 1000 - (now() - tick)));
  }
}

export async function runScopedMonitor(args = process.argv.slice(2)) {
  if (args[0] !== "--root-go") return { state: "held", actions: 0 };
  if (
    args.length !== 4 ||
    !/^\/run\/agent-platform\/jenkins-tools\/[A-Za-z0-9._-]+\.json$/.test(
      args[2],
    )
  )
    throw new Error(
      "Use --root-go MAC_REQUEST.json NATIVE_REQUEST.json NEW_OUTPUT_DIRECTORY",
    );
  const request = await readScopedRequest(resolve(args[1])),
    scope = scopedRequests(request);
  const { loadHostLayout, assertJenkinsListener } =
    await import("../containers/host-layout.mjs");
  const layout = await loadHostLayout({
    requires: [
      "identity",
      "privateDir",
      "adminApi",
      "colima",
      "socket:runtime",
      "socket:build",
    ],
  });
  const output = resolve(args[3]);
  await fs.mkdir(output, { mode: 0o700 });
  const lockPath = join(layout.privateDir, "scoped-ci-build.lock"),
    lock = await fs.open(lockPath, "wx", 0o600);
  let interrupted = false;
  const onSignal = () => {
    interrupted = true;
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  const logFile = await fs.open(
    join(output, "observations.jsonl"),
    "wx",
    0o600,
  );
  const log = async (value) => {
    await logFile.write(
      JSON.stringify({ observedAt: new Date().toISOString(), ...value }) + "\n",
    );
    await logFile.sync();
  };
  try {
    await lock.writeFile(
      JSON.stringify({ pid: process.pid, scopeKey: scope.key }) + "\n",
    );
    await lock.sync();
    const disks = [
      join(layout.colimaHome, "_lima", "colima-agent-platform-build", "disk"),
      join(
        layout.colimaHome,
        "_lima",
        "_disks",
        "colima-agent-platform-build",
        "datadisk",
      ),
    ];
    const diskIdentity = await Promise.all(
      disks.map(async (path) => {
        const stat = await fs.lstat(path);
        if (!stat.isFile() || (await fs.realpath(path)) !== path)
          throw new Error("Unexpected build VM disk path");
        return { dev: stat.dev, ino: stat.ino };
      }),
    );
    async function sample() {
      const observedAtMs = Date.now();
      const host = await fs.statfs(layout.operator.home);
      let allocated = 0;
      for (let index = 0; index < disks.length; index++) {
        const stat = await fs.lstat(disks[index]);
        if (
          !stat.isFile() ||
          stat.dev !== diskIdentity[index].dev ||
          stat.ino !== diskIdentity[index].ino
        )
          throw new Error("Build VM disk identity changed");
        allocated += stat.blocks * 512;
      }
      const result = await exec(
        layout.colima,
        [
          "ssh",
          "--profile",
          "agent-platform-build",
          "--",
          "python3",
          "-c",
          'import os,json; s=os.statvfs("/var/lib/docker"); print(json.dumps({"free":s.f_bavail*s.f_frsize}))',
        ],
        { timeout: 5000, maxBuffer: 16_384 },
      );
      return {
        hostFreeBytes: host.bavail * host.bsize,
        vmFreeBytes: JSON.parse(result.stdout).free,
        buildVmAllocatedBytes: allocated,
        observedAtMs,
      };
    }
    async function native(action) {
      const result = await exec(
        layout.colima,
        [
          "ssh",
          "--profile",
          "agent-platform-runtime",
          "--",
          "docker",
          "exec",
          "--user",
          "1000:1000",
          "agent-platform-linux-deploy",
          "/usr/local/bin/node",
          "/opt/agent-platform/tools/scoped-ci-request.mjs",
          "--root-go",
          args[2],
          action,
          "--expect-scope",
          scope.key,
        ],
        { timeout: 10_000, maxBuffer: 5_000_000 },
      );
      return JSON.parse(result.stdout);
    }
    const credential = await readCredential(layout.adminApi);
    const authorization =
      "Basic " +
      Buffer.from(credential.username + ":" + credential.token).toString(
        "base64",
      );
    async function http(path, method = "GET") {
      await assertJenkinsListener(8080, layout.operator);
      const response = await fetch(origin + path, {
        method,
        headers: { authorization },
        redirect: "manual",
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok && !(method === "POST" && response.status === 302))
        throw new Error("Guard Jenkins HTTP " + response.status);
      return response;
    }
    const client = {
      get: async (path) => (await http(path)).json(),
      post: async (path) => {
        await (await http(path, "POST")).body?.cancel();
      },
    };
    const controller = await client.get(
      "api/json?tree=numExecutors,quietingDown,jobs[name,disabled,builds[number,building]]",
    );
    const queued = await client.get("queue/api/json");
    if (
      controller.numExecutors !== 0 ||
      controller.quietingDown !== false ||
      !["agent-platform-ci-discovery", "agent-platform-release"].every((name) =>
        controller.jobs.some(
          (job) => job.name === name && job.disabled === true,
        ),
      ) ||
      queued.items?.length !== 0 ||
      controller.jobs.some(
        (job) =>
          job.name !== "agent-platform-service-monitor" &&
          job.builds?.some((build) => build.building),
      )
    )
      throw new Error(
        "Exclusive CI admission requires idle jobs/queue and disabled global discovery/release",
      );
    const sent = new Set();
    const result = await watchScopedCI({
      request,
      sample,
      snapshot: () => native("snapshot"),
      abort: () => native("abort"),
      stop: (snapshot) => stopOwnedRuns(request, snapshot, client, sent, log),
      log,
      interrupted: () => interrupted,
      ready: async (value) => {
        await fs.writeFile(
          join(output, "ready.json"),
          JSON.stringify(value, null, 2) + "\n",
          { mode: 0o600, flag: "wx" },
        );
      },
    });
    await fs.writeFile(
      join(output, "result.json"),
      JSON.stringify(result, null, 2) + "\n",
      { mode: 0o600, flag: "wx" },
    );
    return result;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await logFile.close();
    await lock.close();
    await fs.unlink(lockPath);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  runScopedMonitor()
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      if (!["held", "ci-passed-and-capacity-observed"].includes(result.state))
        process.exitCode = 2;
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
