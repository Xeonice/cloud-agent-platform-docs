import {
  sameJenkinsBuildUrl,
  publicJenkinsStatusUrl,
} from "./deployment-platform.mjs";
import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  APP_TOOLS,
  APP_CONTEXTS,
  APP_REPOSITORIES,
  appJwt,
  appDirectory,
  validateAppConfig,
  validateApp,
  validateInstallation,
  verifyAppGrant,
  githubAppRequest,
} from "./github-status-app.mjs";
import { validateManifest, WEB } from "./jenkins-web.mjs";
import { CONTROLLER_HOST } from "../containers/controller.mjs";

export const STATUS_APP_ID = 5204009;
export const STATUS_INSTALLATION_ID = 168317369;
const ACTIONS_APP_ID = 15368;
const JENKINS = "http://127.0.0.1:8080/";
const SHA = /^[a-f0-9]{40}$/;
const hash = (value) => createHash("sha256").update(value).digest("hex");
export const REPOS = Object.freeze({
  api: {
    name: APP_REPOSITORIES[0],
    job: "agent-platform-native-ci",
    refs: ["refs/heads/main", "refs/heads/feat/design-v2-migration"],
    old: ["build-test"],
    workflows: [
      { id: 332578365, path: ".github/workflows/ci.yml" },
      { id: 349938485, path: ".github/workflows/mutation.yml" },
      { id: 352113083, path: ".github/workflows/publish-sandbox-image.yml" },
    ],
  },
  web: {
    name: APP_REPOSITORIES[1],
    job: "agent-platform-web",
    refs: ["refs/heads/main", "refs/heads/feat/design-v2-migration"],
    old: [
      "static-checks (typecheck · lint · prettier · stories · mock-contracts · openapi-drift)",
      "unit-tests (vitest)",
      "storybook-tests (vitest browser)",
      "e2e-tests (playwright)",
      "build (next build)",
    ],
    workflows: [{ id: 332584234, path: ".github/workflows/ci.yml" }],
  },
  project: {
    name: APP_REPOSITORIES[2],
    job: "agent-platform-contract",
    refs: ["refs/heads/main", "refs/heads/Xeonice/初始化一下项目开发"],
    old: ["文档一致性门禁"],
    workflows: [
      { id: 350121053, path: ".github/workflows/contract-e2e.yml" },
      { id: 339182189, path: ".github/workflows/docs-check.yml" },
    ],
  },
});
const disabledJobs = [
  "agent-platform-ci-discovery",
  "agent-platform-api",
  "agent-platform-release",
  "agent-platform-mutation",
  "agent-platform-sandbox-images",
  "agent-platform-service-monitor",
];
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const same = (a, b) => canonical(a) === canonical(b);
function canonical(value) {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
        )
      : item,
  );
}
function requireGate(value, label) {
  if (!value) throw new Error(`CI cutover gate failed: ${label}`);
}
function keys(value, expected) {
  return (
    value &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join() === [...expected].sort().join()
  );
}
export function validateRequest(request) {
  requireGate(
    keys(request, ["version", "commits", "refs", "builds"]) &&
      request.version === 1 &&
      ["commits", "refs", "builds"].every((field) =>
        keys(request[field], Object.keys(REPOS)),
      ),
    "fixed request shape",
  );
  for (const kind of Object.keys(REPOS))
    requireGate(
      SHA.test(request.commits[kind] ?? "") &&
        (REPOS[kind].refs.includes(request.refs[kind]) ||
          /^refs\/pull\/[1-9][0-9]*\/head$/.test(request.refs[kind] ?? "")) &&
        positive(request.builds[kind]),
      "exact source commit, allowed ref and real build number",
    );
  return request;
}
export function buildUrl(kind, number) {
  return `${JENKINS}job/${REPOS[kind].job}/${number}/`;
}
export function buildParameters(kind, request) {
  if (kind === "api")
    return { SHA: request.commits.api, REF: request.refs.api };
  if (kind === "web")
    return {
      SHA: request.commits.web,
      REF: request.refs.web,
      ROOT_SHA: request.commits.project,
      API_SHA: request.commits.api,
    };
  return {
    ROOT_SHA: request.commits.project,
    API_SHA: request.commits.api,
    WEB_SHA: request.commits.web,
  };
}
export function validateSuccessfulBuild(kind, request, build) {
  const parameters = {};
  for (const entry of (build?.actions ?? []).flatMap(
    (action) => action.parameters ?? [],
  )) {
    requireGate(
      !Object.hasOwn(parameters, entry.name),
      "duplicate actual build parameters",
    );
    parameters[entry.name] = String(entry.value);
  }
  requireGate(
    build?.number === request.builds[kind] &&
      sameJenkinsBuildUrl(build.url, buildUrl(kind, request.builds[kind])) &&
      build.building === false &&
      build.result === "SUCCESS" &&
      same(parameters, buildParameters(kind, request)),
    "canonical completed SUCCESS with all exact source parameters",
  );
  return build;
}

export function validateWebEvidence(value, request) {
  const manifest = validateManifest(
    value,
    request.commits.web,
    request.commits.project,
    request.refs.web === WEB.ref,
    request.commits.api,
  );
  requireGate(
    manifest.ref === request.refs.web &&
      manifest.jenkins.buildNumber === request.builds.web &&
      !Object.hasOwn(manifest, "manualProof") &&
      !Object.hasOwn(manifest, "syntheticJenkinsIdentity") &&
      !Object.hasOwn(manifest, "notAdoptableOrPublishable"),
    "actual whole Web build provenance; manual proof is never formal CI",
  );
  requireGate(
    manifest.buildSystem?.platform === "linux" &&
      manifest.buildSystem.arch === "x64" &&
      manifest.nodeMajor === 22,
    "actual Linux AMD64 Web build system",
  );
  for (const gate of ["acceptance", "storybook"])
    requireGate(
      positive(manifest.gates[gate].files) &&
        positive(manifest.gates[gate].passed) &&
        manifest.gates[gate].failed === 0 &&
        manifest.gates[gate].skipped === 0,
      "actual nonempty Web acceptance and Storybook counts",
    );
  return manifest;
}
function unaffectedProtection(value) {
  const { required_status_checks: _checks, ...rest } = value;
  return rest;
}
export function statusPatch(snapshot, kind) {
  const checks = snapshot?.required_status_checks;
  requireGate(
    typeof checks?.strict === "boolean" &&
      checks.checks?.length === REPOS[kind].old.length &&
      checks.checks.every(
        (check) =>
          check.app_id === ACTIONS_APP_ID &&
          REPOS[kind].old.includes(check.context),
      ) &&
      new Set(checks.checks.map((check) => check.context)).size ===
        checks.checks.length,
    "exact old Actions required checks; unknown checks are never dropped",
  );
  return {
    strict: checks.strict,
    checks: [
      { context: APP_CONTEXTS[REPOS[kind].name], app_id: STATUS_APP_ID },
    ],
  };
}
export function protectionMatches(current, snapshot, patch) {
  return (
    same(unaffectedProtection(current), unaffectedProtection(snapshot)) &&
    current.required_status_checks?.strict === patch.strict &&
    same(current.required_status_checks.checks, patch.checks) &&
    same(
      current.required_status_checks.contexts,
      patch.checks.map((check) => check.context),
    )
  );
}
function validateWorkflow(kind, spec, value) {
  requireGate(
    value?.id === spec.id &&
      value.path === spec.path &&
      value.url ===
        `https://api.github.com/repos/${REPOS[kind].name}/actions/workflows/${spec.id}` &&
      ["active", "disabled_manually"].includes(value.state),
    "fixed old workflow identity and state",
  );
  return value;
}
function validateStatus(value, kind, request, config, id) {
  requireGate(
    positive(value?.id) &&
      (!id || value.id === id) &&
      value.state === "success" &&
      value.context === APP_CONTEXTS[REPOS[kind].name] &&
      sameJenkinsBuildUrl(
        value.target_url,
        buildUrl(kind, request.builds[kind]),
      ) &&
      value.creator?.type === "Bot" &&
      value.creator.login === `${config.slug}[bot]`,
    "actual App status ID, creator, context and formal build URL",
  );
  return value;
}
async function privateBytes(path, uid) {
  const file = await fs.open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await file.stat();
    requireGate(
      stat.isFile() &&
        stat.nlink === 1 &&
        stat.uid === uid &&
        (stat.mode & 0o777) === 0o600 &&
        stat.size <= 16 * 1024 * 1024,
      "owner-only regular evidence file",
    );
    return await file.readFile();
  } finally {
    await file.close();
  }
}
function parseJson(bytes) {
  try {
    return JSON.parse(bytes);
  } catch {
    throw new Error("Invalid private CI cutover JSON");
  }
}

export function createCutover(options = {}) {
  const tools = resolve(options.tools ?? APP_TOOLS),
    uid = options.uid ?? 501;
  const fetcher = options.fetch ?? fetch;
  const getJson = async (url, settings = {}) => {
    let response;
    try {
      response = await fetcher(url, {
        ...settings,
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new Error("CI cutover HTTP request failed");
    }
    requireGate(response.ok, "authenticated HTTP success");
    return response.status === 204 ? null : parseJson(await response.text());
  };
  const github =
    options.github ??
    (async (kind, path, settings = {}) => {
      requireGate(Object.hasOwn(REPOS, kind), "fixed repository");
      const token = (await privateBytes(join(tools, "github-token"), uid))
        .toString("utf8")
        .trim();
      return getJson(
        `https://api.github.com/repos/${REPOS[kind].name}/${path}`,
        {
          ...settings,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            ...(settings.body ? { "Content-Type": "application/json" } : {}),
          },
        },
      );
    });
  const jenkins =
    options.jenkins ??
    (async (path) => {
      requireGate(
        !path.includes("..") &&
          !path.startsWith("/") &&
          /^(?:api\/json\?|job\/(?:agent-platform-native-ci|agent-platform-web|agent-platform-contract)\/[1-9][0-9]*\/(?:api\/json\?|artifact\/))/.test(
            path,
          ),
        "fixed Jenkins evidence endpoint",
      );
      const auth = parseJson(
        await privateBytes(join(tools, "admin-api.json"), uid),
      );
      return getJson(JENKINS + path, {
        headers: {
          Authorization: `Basic ${Buffer.from(`${auth.username}:${auth.token}`).toString("base64")}`,
        },
      });
    });
  let appInputs;
  const app = options.app ?? {
    async verify() {
      const config = validateAppConfig(
        parseJson(
          await privateBytes(join(tools, "github-status-app.json"), uid),
        ),
      );
      requireGate(
        config.appId === STATUS_APP_ID &&
          config.installationId === STATUS_INSTALLATION_ID,
        "fixed verified App and installation",
      );
      const pem = (
          await privateBytes(join(tools, "github-status-app.pem"), uid)
        ).toString("utf8"),
        jwt = appJwt(pem, config.appId);
      validateApp(await githubAppRequest("/app", jwt, {}, fetcher), config);
      validateInstallation(
        await githubAppRequest(
          `/app/installations/${config.installationId}`,
          jwt,
          {},
          fetcher,
        ),
        config,
      );
      appInputs = { config, pem };
      return config;
    },
    async publish(kind, request) {
      requireGate(appInputs, "App has been remotely verified");
      const { token } = await verifyAppGrant(appInputs.config, appInputs.pem, {
        fetch: fetcher,
      });
      return githubAppRequest(
        `/repos/${REPOS[kind].name}/statuses/${request.commits[kind]}`,
        token,
        {
          method: "POST",
          body: JSON.stringify({
            state: "success",
            context: APP_CONTEXTS[REPOS[kind].name],
            description:
              "Formal Jenkins CI and pinned cross-repository gates passed",
            target_url: publicJenkinsStatusUrl(
              buildUrl(kind, request.builds[kind]),
              REPOS[kind].job,
            ),
          }),
        },
        fetcher,
      );
    },
  };
  const controllerMode =
    options.controllerMode ??
    (async () => {
      const config = join(tools, "container-docker-context"),
        directory = await fs.lstat(config);
      requireGate(
        directory.isDirectory() &&
          directory.uid === uid &&
          (directory.mode & 0o777) === 0o700,
        "dedicated private Docker configuration",
      );
      await privateBytes(join(config, "config.json"), uid);
      const value = spawnSync(
        "/Users/douglasdong/.orbstack/bin/docker",
        [
          "--config",
          config,
          "--host",
          CONTROLLER_HOST,
          "exec",
          "agent-platform-jenkins-controller-controller-1",
          "cat",
          "/var/jenkins_home/container-state/ready.json",
        ],
        {
          cwd: "/",
          env: { PATH: "/usr/bin:/bin", LANG: "C" },
          encoding: "utf8",
          timeout: 20_000,
          maxBuffer: 65536,
        },
      );
      requireGate(
        !value.error && !value.signal && value.status === 0,
        "readonly active guard query",
      );
      return parseJson(value.stdout).mode;
    });
  async function activeValidationOnly() {
    requireGate(
      (await controllerMode()) === "active",
      "controller must honor active startup guard",
    );
    const controller = await jenkins(
      "api/json?tree=numExecutors,jobs[name,buildable]",
    );
    requireGate(
      controller.numExecutors === 0 &&
        controller.jobs?.length === 9 &&
        Object.values(REPOS).every((repo) =>
          controller.jobs.some(
            (job) => job.name === repo.job && job.buildable === true,
          ),
        ) &&
        disabledJobs.every((name) =>
          controller.jobs.some(
            (job) => job.name === name && job.buildable === false,
          ),
        ),
      "only three validation jobs enabled; discovery and deploy remain disabled",
    );
  }
  async function evidence(request) {
    validateRequest(request);
    await activeValidationOnly();
    const config = await app.verify();
    requireGate(
      config.appId === STATUS_APP_ID &&
        config.installationId === STATUS_INSTALLATION_ID,
      "verified App source identity",
    );
    for (const [kind, spec] of Object.entries(REPOS)) {
      const ref = request.refs[kind];
      if (ref.startsWith("refs/heads/")) {
        const value = await github(kind, "git/ref/heads/" + ref.slice(11));
        requireGate(
          value.ref === ref &&
            value.object?.type === "commit" &&
            value.object.sha === request.commits[kind],
          "current exact branch source head",
        );
      } else {
        const value = await github(kind, "pulls/" + ref.split("/")[2]);
        requireGate(
          value.state === "open" &&
            value.head?.sha === request.commits[kind] &&
            value.base?.repo?.full_name === spec.name,
          "current exact open PR head",
        );
      }
      const build = await jenkins(
        `job/${spec.job}/${request.builds[kind]}/api/json?tree=number,result,building,url,actions[parameters[name,value]]`,
      );
      validateSuccessfulBuild(kind, request, build);
    }
    const native = await jenkins(
      `job/${REPOS.api.job}/${request.builds.api}/artifact/commit.json`,
    );
    requireGate(
      native.repository === `https://github.com/${REPOS.api.name}.git` &&
        native.sha === request.commits.api &&
        native.ref === request.refs.api &&
        native.nodeMajor === 22 &&
        native.platform === "linux" &&
        native.arch === "arm64",
      "actual native checkout artifact",
    );
    const manifest = validateWebEvidence(
      await jenkins(
        `job/${REPOS.web.job}/${request.builds.web}/artifact/web-artifacts/manifest.json`,
      ),
      request,
    );
    requireGate(
      manifest.ref === request.refs.web &&
        manifest.jenkins.buildNumber === request.builds.web,
      "actual whole Web build provenance",
    );
    const cross = await jenkins(
      `job/${REPOS.web.job}/${request.builds.web}/artifact/web-cross-repository/contract.json`,
    );
    requireGate(
      cross.schemaVersion === 1 &&
        cross.job === REPOS.web.job &&
        cross.buildNumber === request.builds.web &&
        cross.state === "passed" &&
        same(cross.commits, {
          root: request.commits.project,
          api: request.commits.api,
          web: request.commits.web,
        }) &&
        same(cross.parameters, buildParameters("project", request)) &&
        cross.child?.job === REPOS.project.job &&
        cross.child.number === request.builds.project &&
        cross.child.result === "SUCCESS" &&
        sameJenkinsBuildUrl(
          cross.child.url,
          buildUrl("project", request.builds.project),
        ),
      "Web child is the same actually successful contract build",
    );
    requireGate(
      same(
        await jenkins(
          `job/${REPOS.project.job}/${request.builds.project}/artifact/commits.json`,
        ),
        request.commits,
      ),
      "actual three-repository checkout artifact",
    );
    return config;
  }
  async function snapshot(request) {
    await evidence(request);
    const repositories = {};
    for (const [kind, spec] of Object.entries(REPOS)) {
      const protection = await github(kind, "branches/main/protection");
      const patch = statusPatch(protection, kind);
      const workflows = [];
      for (const workflow of spec.workflows)
        workflows.push(
          validateWorkflow(
            kind,
            workflow,
            await github(kind, `actions/workflows/${workflow.id}`),
          ),
        );
      repositories[kind] = { protection, patch, workflows };
    }
    return {
      version: 1,
      kind: "formal-jenkins-ci-cutover",
      request,
      repositories,
      statusAppId: STATUS_APP_ID,
      installationId: STATUS_INSTALLATION_ID,
      discoveryRemainsDisabled: true,
      createdAt: new Date().toISOString(),
    };
  }
  async function preview(requestPath) {
    await appDirectory(tools, uid);
    const plan = await snapshot(
      parseJson(await privateBytes(requestPath, uid)),
    );
    const parent = join(tools, "ci-cutover");
    await fs.mkdir(parent, { recursive: true, mode: 0o700 });
    await appDirectory(parent, uid);
    const directory = join(parent, randomUUID());
    await fs.mkdir(directory, { mode: 0o700 });
    const planPath = join(directory, "plan.json"),
      bytes = Buffer.from(JSON.stringify(plan, null, 2) + "\n");
    await fs.writeFile(planPath, bytes, { mode: 0o600, flag: "wx" });
    return {
      state: "previewed-no-remote-mutations",
      planPath,
      planSha256: hash(bytes),
      request: plan.request,
      patches: Object.fromEntries(
        Object.entries(plan.repositories).map(([kind, repo]) => [
          kind,
          repo.patch,
        ]),
      ),
      workflows: Object.values(REPOS).flatMap((repo) =>
        repo.workflows.map((workflow) => ({
          repository: repo.name,
          ...workflow,
        })),
      ),
      discoveryRemainsDisabled: true,
    };
  }
  async function apply(planPath, approvedHash) {
    const folder = resolve(planPath).slice(0, -"/plan.json".length);
    requireGate(
      resolve(planPath).startsWith(`${tools}/ci-cutover/`) &&
        resolve(planPath) === join(folder, "plan.json") &&
        /^ci-cutover\/[0-9a-f-]{36}\/plan\.json$/.test(
          resolve(planPath).slice(tools.length + 1),
        ) &&
        /^[a-f0-9]{64}$/.test(approvedHash),
      "fixed reviewed plan location and digest",
    );
    await appDirectory(tools, uid);
    await appDirectory(folder, uid);
    const bytes = await privateBytes(planPath, uid);
    requireGate(hash(bytes) === approvedHash, "reviewed plan bytes unchanged");
    const plan = parseJson(bytes);
    requireGate(
      plan.version === 1 &&
        plan.kind === "formal-jenkins-ci-cutover" &&
        plan.statusAppId === STATUS_APP_ID &&
        plan.installationId === STATUS_INSTALLATION_ID &&
        plan.discoveryRemainsDisabled === true &&
        keys(plan.repositories, Object.keys(REPOS)),
      "fixed reviewed plan identity",
    );
    const config = await evidence(plan.request);
    const statePath = join(folder, "checkpoint.json");
    const state = await privateBytes(statePath, uid)
      .then(parseJson)
      .catch((error) => {
        if (error.code !== "ENOENT") throw error;
        return {
          version: 1,
          planSha256: approvedHash,
          statuses: {},
          protections: {},
          workflows: {},
        };
      });
    requireGate(
      state.version === 1 &&
        state.planSha256 === approvedHash &&
        keys(state, [
          "version",
          "planSha256",
          "statuses",
          "protections",
          "workflows",
        ]),
      "checkpoint matches immutable reviewed plan",
    );
    const save = async () => {
      const path = `${statePath}.${randomUUID()}`;
      await fs.writeFile(path, JSON.stringify(state, null, 2) + "\n", {
        mode: 0o600,
        flag: "wx",
      });
      await fs.rename(path, statePath);
    };
    const currentProtection = async (kind) => {
      const approved = plan.repositories[kind];
      requireGate(
        same(statusPatch(approved.protection, kind), approved.patch),
        "proposal derived only from original required checks",
      );
      const actual = await github(kind, "branches/main/protection");
      requireGate(
        same(actual, approved.protection) ||
          protectionMatches(actual, approved.protection, approved.patch),
        "branch protection drift; other constraints must remain untouched",
      );
      return actual;
    };
    // Read every identity before the first status POST. Partial retries accept
    // only the same desired constraints; they never broaden the plan's scope.
    for (const [kind, spec] of Object.entries(REPOS)) {
      await currentProtection(kind);
      requireGate(
        plan.repositories[kind].workflows?.length === spec.workflows.length,
        "fixed workflow snapshot count",
      );
      for (const workflow of spec.workflows) {
        const old = plan.repositories[kind].workflows.find(
          (value) => value.id === workflow.id,
        );
        validateWorkflow(kind, workflow, old);
        const actual = validateWorkflow(
          kind,
          workflow,
          await github(kind, `actions/workflows/${workflow.id}`),
        );
        requireGate(
          actual.state === old.state || actual.state === "disabled_manually",
          "workflow state drift",
        );
      }
    }
    for (const kind of Object.keys(REPOS)) {
      const stored = state.statuses[kind];
      let status = stored;
      if (!stored) {
        status = validateStatus(
          await app.publish(kind, plan.request),
          kind,
          plan.request,
          config,
        );
        state.statuses[kind] = { id: status.id };
        await save();
      }
      const actual = await github(
        kind,
        `commits/${plan.request.commits[kind]}/statuses?per_page=100`,
      );
      const latest = actual.find(
        (value) => value.context === APP_CONTEXTS[REPOS[kind].name],
      );
      validateStatus(latest, kind, plan.request, config, status.id);
    }
    await evidence(plan.request);
    for (const kind of Object.keys(REPOS)) {
      const approved = plan.repositories[kind],
        actual = await currentProtection(kind);
      if (!protectionMatches(actual, approved.protection, approved.patch))
        await github(kind, "branches/main/protection/required_status_checks", {
          method: "PATCH",
          body: JSON.stringify(approved.patch),
        });
      requireGate(
        protectionMatches(
          await github(kind, "branches/main/protection"),
          approved.protection,
          approved.patch,
        ),
        "new required App source and all other protection preserved",
      );
      state.protections[kind] = true;
      await save();
    }
    // Disable the old publisher only after all three protections have been
    // verified against real statuses from this App and these formal CI builds.
    for (const kind of Object.keys(REPOS))
      requireGate(
        protectionMatches(
          await github(kind, "branches/main/protection"),
          plan.repositories[kind].protection,
          plan.repositories[kind].patch,
        ),
        "all three protections verified before workflow retirement",
      );
    for (const [kind, spec] of Object.entries(REPOS))
      for (const workflow of spec.workflows) {
        const actual = validateWorkflow(
          kind,
          workflow,
          await github(kind, `actions/workflows/${workflow.id}`),
        );
        if (actual.state !== "disabled_manually")
          await github(kind, `actions/workflows/${workflow.id}/disable`, {
            method: "PUT",
          });
        requireGate(
          validateWorkflow(
            kind,
            workflow,
            await github(kind, `actions/workflows/${workflow.id}`),
          ).state === "disabled_manually",
          "old workflow retirement confirmed",
        );
        state.workflows[`${kind}:${workflow.id}`] = true;
        await save();
      }
    return {
      state: "required-sources-migrated-and-six-workflows-disabled",
      planSha256: approvedHash,
      request: plan.request,
      statusAppId: STATUS_APP_ID,
      workflowCount: 6,
      discoveryRemainsDisabled: true,
      checkpointPath: statePath,
    };
  }
  return { preview, apply, evidence };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [action, first, second, ...extra] = process.argv.slice(2);
  requireGate(
    process.platform === "darwin" &&
      process.arch === "arm64" &&
      process.getuid() === 501 &&
      process.geteuid() === 501 &&
      process.versions.node.split(".")[0] === "22",
    "native trusted Node22 UID501 operator",
  );
  const tool = createCutover();
  const task =
    !extra.length && action === "preview" && first && !second
      ? tool.preview(first)
      : !extra.length && action === "apply" && first && second
        ? tool.apply(first, second)
        : Promise.reject(
            new Error(
              "Use preview <private-request.json> or apply <reviewed-plan.json> <approved-sha256>",
            ),
          );
  task
    .then((value) => console.log(JSON.stringify(value)))
    .catch(() => {
      console.error(
        "CI cutover failed; private credentials, HTTP bodies and raw errors withheld. Read the private checkpoint before retrying.",
      );
      process.exitCode = 1;
    });
}
