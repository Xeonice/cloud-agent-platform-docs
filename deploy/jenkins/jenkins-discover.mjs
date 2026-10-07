import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { validRef, SHA } from "./jenkins-ci.mjs";
import { createStatusApp } from "./github-status-app.mjs";
import { userInfo } from "node:os";
import { buildSystem } from "./ci-platform.mjs";
import {
  deploymentContext,
  assertDeploymentLayout,
  jenkinsTransport,
  canonicalJenkinsLocation,
  publicJenkinsStatusUrl,
} from "./deployment-platform.mjs";
import {
  REPOSITORIES,
  ROOT as DEPLOY_ROOT,
  TOOLS,
  projectKey,
} from "./project-release.mjs";

const JENKINS = "http://127.0.0.1:8080/";
export const DISCOVERY_JOBS = Object.freeze({
  api: "agent-platform-native-ci",
  web: "agent-platform-web",
  project: "agent-platform-contract",
  release: "agent-platform-release",
  images: "agent-platform-sandbox-images",
});
export const STATUS_CONTEXTS = Object.freeze({
  api: "jenkins/native-ci",
  web: "jenkins/web-ci",
  project: "jenkins/project-ci",
});
export const IMAGE_TAG =
  /^refs\/tags\/sandbox-image-v[0-9]+(?:\.[0-9]+){0,2}(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/;
export const IMAGE_FILES = [
  "images/platform-sandbox/Dockerfile",
  "images/platform-boxlite/Dockerfile",
];
const stamp = () => new Date().toISOString();
export function validRequest(item) {
  const p = item?.params;
  if (!p || !item.key || !Object.values(DISCOVERY_JOBS).includes(item.job))
    return false;
  const keys = Object.keys(p).sort().join(",");
  if (item.job === DISCOVERY_JOBS.release)
    return (
      keys === "REQUEST_KEY,TAG" &&
      /^[a-f0-9]{64}$/.test(p.REQUEST_KEY) &&
      p.TAG === "" &&
      item.key === "release:" + p.REQUEST_KEY
    );
  if (item.job === DISCOVERY_JOBS.images)
    return (
      keys === "MODE,REF,SHA,TAG" &&
      SHA.test(p.SHA) &&
      ((p.MODE === "publish" &&
        IMAGE_TAG.test(p.REF) &&
        p.TAG === p.REF.slice("refs/tags/sandbox-image-".length)) ||
        (p.MODE === "check" &&
          p.REF === "refs/heads/" + REPOSITORIES.api.branch &&
          p.TAG === ""))
    );
  if (
    !REPOSITORIES[item.repo] ||
    item.job !== DISCOVERY_JOBS[item.repo] ||
    !SHA.test(item.sha) ||
    !(
      validRef(item.ref) ||
      item.ref === "refs/heads/" + REPOSITORIES[item.repo].branch
    )
  )
    return false;
  if (item.repo === "api")
    return keys === "REF,SHA" && p.SHA === item.sha && p.REF === item.ref;
  if (item.repo === "web")
    return (
      keys === "API_SHA,REF,ROOT_SHA,SHA" &&
      p.SHA === item.sha &&
      p.REF === item.ref &&
      SHA.test(p.API_SHA) &&
      SHA.test(p.ROOT_SHA)
    );
  return (
    keys === "API_SHA,ROOT_SHA,WEB_SHA" &&
    p.ROOT_SHA === item.sha &&
    SHA.test(p.API_SHA) &&
    SHA.test(p.WEB_SHA)
  );
}
export function isTrustedJenkinsLocation(location, job) {
  try {
    const url = new URL(canonicalJenkinsLocation(location));
    if (/^\/queue\/item\/[1-9][0-9]*\/$/.test(url.pathname)) return true;
    const match = /^\/job\/([A-Za-z0-9-]+)\/[1-9][0-9]*\/$/.exec(url.pathname);
    return (
      !!match &&
      Object.values(DISCOVERY_JOBS).includes(match[1]) &&
      (!job || match[1] === job)
    );
  } catch {
    return false;
  }
}
export function parametersMatch(value, expected) {
  const actual = {};
  for (const entry of (value?.actions ?? []).flatMap(
    (action) => action.parameters ?? [],
  )) {
    if (Object.hasOwn(actual, entry.name)) return false;
    actual[entry.name] = String(entry.value);
  }
  return Object.entries(expected).every(
    ([name, val]) => actual[name] === String(val),
  );
}
async function privateFile(path) {
  const handle = await fs.open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid() ||
      stat.mode & 0o077 ||
      stat.size > 5_000_000
    )
      throw new Error("Unsafe private discovery file");
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}
async function jsonFile(path) {
  const contents = await privateFile(path);
  try {
    return JSON.parse(contents);
  } catch {
    throw new Error("Discovery JSON invalid");
  }
}
async function atomic(path, value) {
  const next = path + "." + randomUUID();
  await fs.writeFile(next, JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  await fs.rename(next, path);
}
async function gitRefs(spec) {
  return new Promise((accept, reject) => {
    const child = spawn(
      "/usr/bin/git",
      [
        "ls-remote",
        "--heads",
        "--tags",
        "https://github.com/" + spec.name + ".git",
      ],
      {
        env: {
          PATH: "/usr/bin:/bin",
          GIT_TERMINAL_PROMPT: "0",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
        },
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    let output = "",
      overflow = false;
    const timer = setTimeout(() => child.kill(), 30_000);
    child.stdout.on("data", (chunk) => {
      if (output.length + chunk.length > 2_000_000) {
        overflow = true;
        child.kill();
      } else output += chunk;
    });
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("Source discovery could not start"));
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0 || overflow)
        return reject(new Error("Source discovery failed"));
      const lines = output
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [sha, ref] = line.split(/\s+/);
          return { sha, ref };
        });
      // A peeled annotated tag wins over the tag-object SHA.
      const refs = new Map();
      for (const item of lines)
        if (!item.ref.endsWith("^{}")) refs.set(item.ref, item.sha);
      for (const item of lines)
        if (item.ref.endsWith("^{}")) refs.set(item.ref.slice(0, -3), item.sha);
      accept([...refs].map(([ref, sha]) => ({ ref, sha })));
    });
  });
}
export function createDiscoverer(overrides = {}) {
  const context = deploymentContext(
    overrides.identity ?? userInfo(),
    overrides.system ?? buildSystem(),
  );
  const tools = resolve(overrides.tools ?? TOOLS),
    deployRoot = resolve(overrides.deployRoot ?? DEPLOY_ROOT);
  const statePath = join(tools, "discovery-state.json");
  const fetcher = overrides.fetch ?? globalThis.fetch;
  async function request(url, options) {
    const response = await fetcher(url, {
      ...options,
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok)
      throw Object.assign(new Error("Discovery HTTP " + response.status), {
        status: response.status,
      });
    return response;
  }
  async function github(repo, path, options = {}) {
    const token = (await privateFile(join(tools, "github-token"))).trim();
    return request(
      "https://api.github.com/repos/" + REPOSITORIES[repo].name + "/" + path,
      {
        ...options,
        headers: {
          Authorization: "Bearer " + token,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          ...options.headers,
        },
      },
    );
  }
  const refsFor = overrides.refs ?? gitRefs;
  const statusApp =
    overrides.statusApp ??
    createStatusApp({ tools, uid: context.uid, fetch: fetcher });
  const pullsFor =
    overrides.pulls ??
    (async (repo) => {
      const all = [];
      for (let page = 1; page <= 10; page++) {
        const values = await (
          await github(repo, "pulls?state=open&per_page=100&page=" + page)
        ).json();
        all.push(
          ...values.map((pull) => ({
            ref: "refs/pull/" + pull.number + "/head",
            sha: pull.head.sha,
          })),
        );
        if (values.length < 100) return all;
      }
      throw new Error("Open PR discovery exceeded bounded pagination");
    });
  const postStatus =
    overrides.status ??
    (async (item) => {
      const body = {
        state: item.state,
        context: item.context,
        description: item.description,
        target_url: publicJenkinsStatusUrl(
          item.targetUrl,
          DISCOVERY_JOBS[item.repo],
        ),
      };
      if ((await statusApp.source()).kind === "github-app")
        return statusApp.postStatus(
          REPOSITORIES[item.repo].name,
          item.sha,
          body,
        );
      await github(item.repo, "statuses/" + item.sha, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    });
  async function jenkinsRequest(path, options = {}) {
    if (
      !/^(?:queue\/api\/json|queue\/item\/[1-9][0-9]*\/api\/json|job\/[A-Za-z0-9-]+\/(?:api\/json(?:\?tree=[A-Za-z0-9_,[\]]+)?|buildWithParameters|[1-9][0-9]*\/api\/json))$/.test(
        path,
      )
    )
      throw new Error("Untrusted Jenkins discovery request");
    const match = /job\/([A-Za-z0-9-]+)\//.exec(path);
    if (match && !Object.values(DISCOVERY_JOBS).includes(match[1]))
      throw new Error("Untrusted discovery job");
    const auth = await jsonFile(join(tools, "admin-api.json"));
    return request(jenkinsTransport(JENKINS + path, context), {
      ...options,
      headers: {
        authorization:
          "Basic " +
          Buffer.from(auth.username + ":" + auth.token).toString("base64"),
        ...options.headers,
      },
    });
  }
  const jk = overrides.jenkins ?? {
    get: async (path) => (await jenkinsRequest(path)).json(),
    queue: async (job, params) => {
      const response = await jenkinsRequest(
        "job/" + job + "/buildWithParameters",
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams(params),
        },
      );
      return canonicalJenkinsLocation(
        response.headers.get("location"),
        context,
      );
    },
  };
  const changedImage =
    overrides.changedImage ??
    (async (before, after) => {
      if (!SHA.test(before)) return false;
      const result = await (
        await github("api", "compare/" + before + "..." + after)
      ).json();
      if (result.files?.length >= 300) return true; // Bounded API comparison cannot prove exclusion.
      return (result.files ?? []).some(
        (file) =>
          IMAGE_FILES.includes(file.filename) ||
          IMAGE_FILES.includes(file.previous_filename),
      );
    });
  return async function discover() {
    if (context.platform === "linux")
      await (overrides.assertLayout ?? assertDeploymentLayout)({
        ...context,
        root: deployRoot,
        tools,
      });
    let state = await jsonFile(statePath).catch((error) => {
      if (error.code === "ENOENT")
        return { schemaVersion: 2, refs: {}, pending: [], statuses: [] };
      throw error;
    });
    // Explicit old-state retirement: do not mistake an API-only ref baseline for
    // complete three-repository discovery. Preserve its pending native requests.
    if (!state.schemaVersion)
      state = {
        schemaVersion: 2,
        refs: Object.fromEntries(
          Object.entries(state.refs ?? {}).map(([ref, sha]) => [
            "api:" + ref,
            sha,
          ]),
        ),
        pending: (state.pending ?? []).map((item) => ({
          ...item,
          repo: "api",
          job: DISCOVERY_JOBS.api,
          params: { SHA: item.sha, REF: item.ref },
          key: "api:" + item.ref,
        })),
        statuses: [],
        initializedAt: state.initializedAt,
      };
    if (
      state.schemaVersion !== 2 ||
      !state.refs ||
      !Array.isArray(state.pending) ||
      !Array.isArray(state.statuses)
    )
      throw new Error("Invalid private discovery state");
    const first = !state.initializedAt,
      completed = [],
      queued = [],
      errors = [];
    async function save() {
      state.updatedAt = stamp();
      await atomic(statePath, state);
    }
    function status(item, result, targetUrl) {
      if (!STATUS_CONTEXTS[item.repo]) return;
      state.statuses = state.statuses.filter(
        (old) =>
          !(
            old.repo === item.repo &&
            old.sha === item.sha &&
            old.context === STATUS_CONTEXTS[item.repo]
          ),
      );
      state.statuses.push({
        repo: item.repo,
        sha: item.sha,
        context: STATUS_CONTEXTS[item.repo],
        state: result,
        targetUrl: publicJenkinsStatusUrl(targetUrl, item.job),
        description:
          result === "pending"
            ? "Native Jenkins verification queued"
            : result === "success"
              ? "All required Jenkins gates passed"
              : "Jenkins verification did not pass",
      });
    }
    async function actualRequest(job, params) {
      const queue = await jk.get("queue/api/json");
      for (const item of queue.items ?? [])
        if (item.task?.name === job && parametersMatch(item, params)) {
          const location = JENKINS + "queue/item/" + item.id + "/";
          if (!isTrustedJenkinsLocation(location, job))
            throw new Error("Invalid actual Jenkins queue identity");
          return { location };
        }
      const history = await jk.get(
        "job/" +
          job +
          "/api/json?tree=builds[number,url,building,result,actions[parameters[name,value]]]",
      );
      for (const item of history.builds ?? [])
        if (parametersMatch(item, params)) {
          if (!isTrustedJenkinsLocation(item.url, job))
            throw new Error("Untrusted actual Jenkins build");
          return { location: item.url, result: item };
        }
      return null;
    }
    for (const item of [...state.pending]) {
      if (
        !validRequest(item) ||
        !isTrustedJenkinsLocation(item.location, item.job)
      )
        throw new Error("Untrusted persisted Jenkins request");
      try {
        let value;
        try {
          value = await jk.get(
            new URL(item.location).pathname.slice(1) + "api/json",
          );
        } catch (error) {
          if (error.status !== 404) throw error;
          const found = await actualRequest(item.job, item.params);
          if (!found) {
            state.pending = state.pending.filter((old) => old !== item);
            delete state.refs[item.key];
            completed.push({ key: item.key, result: "LOST_QUEUE_RETRY" });
            status(item, "failure", JENKINS + "job/" + item.job + "/");
            await save();
            continue;
          }
          item.location = found.location;
          value =
            found.result ??
            (await jk.get(
              new URL(item.location).pathname.slice(1) + "api/json",
            ));
        }
        if (item.location.includes("/queue/")) {
          if (value.cancelled) {
            state.pending = state.pending.filter((old) => old !== item);
            delete state.refs[item.key];
            completed.push({ key: item.key, result: "ABORTED" });
            status(item, "failure", JENKINS + "job/" + item.job + "/");
          } else if (value.executable?.url) {
            if (!isTrustedJenkinsLocation(value.executable.url, item.job))
              throw new Error("Untrusted queue executable");
            item.location = value.executable.url;
          }
          await save();
          continue;
        }
        if (!parametersMatch(value, item.params))
          throw new Error("Jenkins execution used different source parameters");
        if (value.building || value.result == null) continue;
        state.pending = state.pending.filter((old) => old !== item);
        if (
          value.result !== "SUCCESS" &&
          [DISCOVERY_JOBS.release, DISCOVERY_JOBS.images].includes(item.job)
        )
          delete state.refs[item.key];
        status(
          item,
          value.result === "SUCCESS" ? "success" : "failure",
          item.location,
        );
        completed.push({
          key: item.key,
          result: value.result,
          buildUrl: item.location,
        });
        await save();
      } catch (error) {
        errors.push({ key: item.key, error: error.message });
      }
    }
    const discovered = {},
      commits = {};
    for (const [repo, spec] of Object.entries(REPOSITORIES)) {
      const refs = [...(await refsFor(spec, repo)), ...(await pullsFor(repo))];
      const unique = new Map();
      for (const entry of refs) {
        if (
          entry.ref.startsWith("refs/tags/") &&
          !(repo === "api" && IMAGE_TAG.test(entry.ref))
        )
          continue;
        if (
          !SHA.test(entry.sha) ||
          !(
            validRef(entry.ref) ||
            entry.ref === "refs/heads/" + spec.branch ||
            (repo === "api" && IMAGE_TAG.test(entry.ref))
          )
        )
          throw new Error("Invalid discovered repository ref");
        if (unique.has(entry.ref) && unique.get(entry.ref) !== entry.sha)
          throw new Error("Conflicting discovered source identities");
        unique.set(entry.ref, entry.sha);
      }
      discovered[repo] = [...unique].map(([ref, sha]) => ({ ref, sha }));
      commits[repo] = unique.get("refs/heads/" + spec.branch);
    }
    const key = projectKey(commits);
    async function enqueue(item) {
      if (!validRequest(item))
        throw new Error("Untrusted new Jenkins source request");
      if (
        state.pending.some(
          (old) =>
            old.job === item.job &&
            JSON.stringify(old.params) === JSON.stringify(item.params),
        )
      )
        return;
      let found = await actualRequest(item.job, item.params);
      // Successful independent CI may be reused. Failed attempts are deliberately
      // retried; published project state, not a historical SUCCESS, decides release.
      if (
        found?.result &&
        !found.result.building &&
        found.result.result !== null
      ) {
        if (
          found.result.result === "SUCCESS" &&
          item.job !== DISCOVERY_JOBS.release
        ) {
          state.refs[item.key] = item.sha;
          status(item, "success", found.location);
          await save();
          return;
        }
        found = null;
      }
      const location =
        found?.location ?? (await jk.queue(item.job, item.params));
      if (!isTrustedJenkinsLocation(location, item.job))
        throw new Error("Jenkins did not return a trusted queue URL");
      state.pending.push({ ...item, location, queuedAt: stamp() });
      if (item.sha) state.refs[item.key] = item.sha;
      status(item, "pending", JENKINS + "job/" + item.job + "/");
      // Persist before calling GitHub. A failed status update cannot enqueue twice.
      await save();
      queued.push({ key: item.key, job: item.job, queueUrl: location });
    }
    for (const [repo, refs] of Object.entries(discovered))
      for (const { ref, sha } of refs) {
        const sourceKey = repo + ":" + ref,
          before = state.refs[sourceKey];
        if (before === sha) continue;
        const production = ref === "refs/heads/" + REPOSITORIES[repo].branch;
        const pull = ref.startsWith("refs/pull/");
        const shouldBuild =
          repo === "api"
            ? !ref.startsWith("refs/tags/") &&
              (!first || ref === "refs/heads/main" || pull)
            : ref === "refs/heads/main" || pull;
        const params =
          repo === "api"
            ? { SHA: sha, REF: ref }
            : repo === "web"
              ? {
                  SHA: sha,
                  REF: ref,
                  ROOT_SHA: commits.project,
                  API_SHA: commits.api,
                }
              : { ROOT_SHA: sha, API_SHA: commits.api, WEB_SHA: commits.web };
        if (
          repo === "api" &&
          production &&
          !first &&
          before &&
          (await changedImage(before, sha))
        ) {
          try {
            await enqueue({
              sha,
              ref,
              key: "image-check:" + sha,
              job: DISCOVERY_JOBS.images,
              params: { SHA: sha, REF: ref, TAG: "", MODE: "check" },
            });
          } catch (error) {
            errors.push({ key: sourceKey, error: error.message });
            continue;
          }
        }
        if (shouldBuild) {
          try {
            await enqueue({
              repo,
              sha,
              ref,
              key: sourceKey,
              job: DISCOVERY_JOBS[repo],
              params,
            });
          } catch (error) {
            errors.push({ key: sourceKey, error: error.message });
            continue;
          }
        } else {
          if (repo === "api" && !first && IMAGE_TAG.test(ref)) {
            try {
              await enqueue({
                sha,
                ref,
                key: sourceKey,
                job: DISCOVERY_JOBS.images,
                params: {
                  SHA: sha,
                  REF: ref,
                  TAG: ref.slice("refs/tags/sandbox-image-".length),
                  MODE: "publish",
                },
              });
            } catch (error) {
              errors.push({ key: sourceKey, error: error.message });
              continue;
            }
          }
          state.refs[sourceKey] = sha;
          await save();
        }
      }
    const current = await jsonFile(
      join(deployRoot, "project-release-current.json"),
    ).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (
      current &&
      (current.state !== "published" ||
        current.key !== projectKey(current.commits))
    )
      throw new Error("Invalid current project publication evidence");
    if (current?.key !== key) {
      try {
        await enqueue({
          key: "release:" + key,
          job: DISCOVERY_JOBS.release,
          params: { TAG: "", REQUEST_KEY: key },
        });
      } catch (error) {
        errors.push({ key: "release:" + key, error: error.message });
      }
    }
    state.initializedAt ??= stamp();
    await save();
    // Each repository status failure is independent and its outbox survives.
    for (const item of [...state.statuses]) {
      if (
        !REPOSITORIES[item.repo] ||
        !SHA.test(item.sha) ||
        item.context !== STATUS_CONTEXTS[item.repo]
      )
        throw new Error("Invalid private GitHub status outbox");
      try {
        await postStatus(item);
        state.statuses = state.statuses.filter((old) => old !== item);
        await save();
      } catch (error) {
        errors.push({ key: item.repo + ":" + item.sha, error: error.message });
      }
    }
    let githubStatusSource;
    try {
      githubStatusSource = overrides.status
        ? { kind: "test-override" }
        : await statusApp.source();
    } catch (error) {
      githubStatusSource = {
        kind: "unavailable",
        reason: "invalid-github-app-configuration",
      };
      errors.push({ key: "github-status-source", error: error.message });
    }
    return {
      state: errors.length ? "observed-with-errors" : "observed",
      projectKey: key,
      queued,
      completed,
      pending: state.pending.length,
      pendingStatuses: state.statuses.length,
      githubStatusSource,
      errors,
      updatedAt: state.updatedAt,
    };
  };
}
export async function discover() {
  return createDiscoverer()();
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  discover()
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      if (result.errors.length) process.exitCode = 2;
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
