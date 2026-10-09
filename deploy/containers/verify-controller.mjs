import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { activationScript, reviewedPipeline } from "../jenkins/manage.mjs";
import { validateDockerHost } from "./controller.mjs";
import {
  JENKINS_PORTS,
  assertJenkinsListener,
  loadHostLayout,
} from "./host-layout.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const name = "agent-platform-jenkins-lab-controller-1";
const base = `http://127.0.0.1:${JENKINS_PORTS.lab}/`;
const probeImage =
  "node:22.23.3-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c";
const pipelines = [
  "api.groovy",
  "native-ci.groovy",
  "monitor.groovy",
  "discover.groovy",
  "release.groovy",
  "contract.groovy",
  "web.groovy",
  "mutation.groovy",
  "sandbox-images.groovy",
];

export function assertPrivateEquality(actual, expected, label) {
  // Never pass secret operands to an assertion that formats them on failure.
  assert.ok(actual === expected, `${label} changed`);
}

// Docker commands for the jenkins (controller) and build profiles of the host
// layout only; the default context and the runtime daemon are never reachable.
export function dockerProfiles(layout) {
  const profile = (kind, socket) => {
    const host = validateDockerHost(kind, socket, layout.profiles);
    return (args, input) => {
      const result = spawnSync(
        layout.dockerCli,
        ["--config", layout.dockerConfig, "--host", host, ...args],
        {
          encoding: "utf8",
          env: {
            PATH: "/usr/bin:/bin",
            LANG: "C",
            DOCKER_CONFIG: layout.dockerConfig,
          },
          cwd: "/",
          timeout: 120_000,
          maxBuffer: 16 * 1024 * 1024,
          input,
        },
      );
      if (result.error || result.signal || result.status !== 0)
        throw new Error(
          "Fixed lab Docker command failed; subprocess output is withheld",
        );
      return result.stdout;
    };
  };
  return Object.freeze({
    controller: profile("controller", layout.profiles.jenkins.socket),
    build: profile("build", layout.profiles.build.socket),
  });
}

async function probeBuildProfile(docker) {
  // This image has no production mounts, daemon socket, Jenkins credential or job execution.
  docker.build(["pull", probeImage]);
  const network = JSON.parse(
    docker.build([
      "run",
      "--rm",
      "--read-only",
      "--user",
      "1000:1000",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--memory",
      "128m",
      "--entrypoint",
      "/usr/local/bin/node",
      probeImage,
      "-e",
      "fetch('http://host.lima.internal:18080/login',{signal:AbortSignal.timeout(10000)}).then(r=>{console.log(JSON.stringify({status:r.status}));if(r.status!==200)process.exitCode=1}).catch(()=>process.exitCode=1)",
    ]),
  );
  assert.equal(network.status, 200);
  const volume = `agent-platform-lab-credential-probe-${randomUUID()}`;
  const label = randomUUID();
  docker.build([
    "volume",
    "create",
    "--label",
    "agent-platform-purpose=lab-credential-probe",
    "--label",
    `agent-platform-probe=${label}`,
    volume,
  ]);
  const dummy = randomBytes(48).toString("base64url");
  try {
    docker.build(
      [
        "run",
        "--rm",
        "-i",
        "--network",
        "none",
        "--read-only",
        "--user",
        "0:0",
        "--mount",
        `type=volume,source=${volume},target=/run/secrets`,
        "--entrypoint",
        "/usr/local/bin/node",
        probeImage,
        "-e",
        "const fs=require('node:fs');let b=[];process.stdin.on('data',x=>b.push(x));process.stdin.on('end',()=>{const p='/run/secrets/jenkins_agent_secret';fs.writeFileSync(p,Buffer.concat(b),{flag:'wx',mode:0o600});fs.chownSync(p,1000,1000);fs.chmodSync(p,0o600)})",
      ],
      dummy,
    );
    const file = JSON.parse(
      docker.build([
        "run",
        "--rm",
        "--network",
        "none",
        "--read-only",
        "--user",
        "1000:1000",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--mount",
        `type=volume,source=${volume},target=/run/secrets,readonly`,
        "--entrypoint",
        "/usr/local/bin/node",
        probeImage,
        "-e",
        "const fs=require('node:fs');const p='/run/secrets/jenkins_agent_secret',s=fs.lstatSync(p),b=fs.readFileSync(p);let readonly=false;try{fs.appendFileSync(p,'x')}catch(e){readonly=e.code==='EROFS'};console.log(JSON.stringify({uid:s.uid,gid:s.gid,mode:s.mode&0o777,size:b.length,regular:s.isFile(),nlink:s.nlink,readonly,sha256:require('node:crypto').createHash('sha256').update(b).digest('hex')}))",
      ]),
    );
    assert.equal(file.uid, 1000);
    assert.equal(file.gid, 1000);
    assert.equal(file.mode, 0o600);
    assert.equal(file.readonly, true);
    assert.equal(file.regular, true);
    assert.equal(file.nlink, 1);
    assertPrivateEquality(
      file.sha256,
      createHash("sha256").update(dummy).digest("hex"),
      "Dummy stdin handoff",
    );
    return {
      controllerUrl: "http://host.lima.internal:18080/login",
      containerHttpStatus: network.status,
      daemon: "agent-platform-build",
      credentialHandoff: {
        dummyOnly: true,
        transport: "stdin-to-dedicated-volume",
        uid: 1000,
        mode: "0600",
        readonlyMount: true,
        hostMounts: false,
        realCredentialsUsed: false,
      },
    };
  } finally {
    const inspection = JSON.parse(
      docker.build(["volume", "inspect", volume]),
    )[0];
    assert.equal(inspection.Labels["agent-platform-probe"], label);
    assert.equal(
      inspection.Labels["agent-platform-purpose"],
      "lab-credential-probe",
    );
    docker.build(["volume", "rm", volume]);
  }
}

export async function verifyController() {
  // Derived when verification starts, not at import: tests import this module on Linux.
  const layout = await loadHostLayout({ requires: "verify-controller" });
  const docker = dockerProfiles(layout);
  const inspection = JSON.parse(docker.controller(["inspect", name]))[0];
  assert.equal(inspection.State.Status, "running");
  assert.equal(inspection.State.Health.Status, "healthy");
  assert.equal(inspection.Config.User, "1000:1000");
  assert.equal(inspection.HostConfig.ReadonlyRootfs, true);
  assert.equal(inspection.HostConfig.Privileged, false);
  assert.deepEqual(inspection.HostConfig.CapDrop, ["ALL"]);
  assert.equal(inspection.Mounts.length, 1);
  assert.equal(inspection.Mounts[0].Type, "volume");
  assert.equal(inspection.Mounts[0].Name, "agent-platform-jenkins-lab-home");
  assert.equal(
    inspection.HostConfig.PortBindings["8080/tcp"][0].HostIp,
    "127.0.0.1",
  );
  assert.equal(
    inspection.HostConfig.PortBindings["8080/tcp"][0].HostPort,
    "18080",
  );
  const ready = JSON.parse(
    docker.controller([
      "exec",
      name,
      "cat",
      "/var/jenkins_home/container-state/ready.json",
    ]),
  );
  const keyBefore = docker.controller([
    "exec",
    name,
    "cat",
    "/var/jenkins_home/secrets/master.key",
  ]);
  const credential = JSON.parse(
    docker.controller([
      "exec",
      name,
      "cat",
      "/var/jenkins_home/container-state/lab-admin.json",
    ]),
  );
  assert.ok(
    credential.username === "douglasdong" &&
      typeof credential.password === "string" &&
      credential.password.length >= 40,
    "Lab-only credential is required",
  );
  const anonymous = await fetch(`${base}api/json`, {
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(anonymous.status, 403);
  const authorization = `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString("base64")}`;
  let cookie;
  async function request(path, options = {}) {
    // The lab credential goes only to a loopback listener held by the operator.
    await assertJenkinsListener(JENKINS_PORTS.lab, layout.operator);
    const response = await fetch(`${base}${path}`, {
      ...options,
      redirect: "error",
      headers: {
        authorization,
        ...(cookie ? { cookie } : {}),
        ...options.headers,
      },
      signal: AbortSignal.timeout(30_000),
    });
    const session = response.headers
      .getSetCookie()
      .find((value) => value.startsWith("JSESSIONID"));
    if (session) cookie = session.split(";")[0];
    assert.equal(response.status, 200, "Lab HTTP request must succeed");
    if (path.includes("api/json"))
      assert.equal(response.headers.get("x-jenkins"), "2.580.1");
    return response;
  }
  const controller = await (
    await request("api/json?tree=numExecutors,useSecurity,jobs[name]")
  ).json();
  assert.equal(controller.numExecutors, 0);
  assert.equal(controller.useSecurity, true);
  assert.deepEqual(controller.jobs, []);
  const nodes = await (
    await request("computer/api/json?tree=computer[displayName,numExecutors]")
  ).json();
  assert.equal(nodes.computer.length, 1);
  assert.equal(nodes.computer[0].numExecutors, 0);
  const plugins = await (
    await request(
      "pluginManager/api/json?tree=plugins[shortName,version,active]",
    )
  ).json();
  const lock = JSON.parse(
    await fs.readFile(join(root, "deploy/jenkins/plugins.lock.json"), "utf8"),
  );
  assert.equal(plugins.plugins.length, lock.plugins.length);
  for (const item of lock.plugins) {
    const loaded = plugins.plugins.find(
      (plugin) => plugin.shortName === item.name,
    );
    assert.ok(
      loaded && loaded.version === item.version && loaded.active === true,
      "Reviewed plugin must be active at its pinned version",
    );
  }
  assert.ok(
    ready.jenkins === "2.580.1" &&
      ready.javaMajor === 21 &&
      ready.mode === "lab",
  );
  const crumb = await (await request("crumbIssuer/api/json")).json();
  const lint = [];
  for (const file of pipelines) {
    const raw = await fs.readFile(join(root, "deploy/jenkins", file), "utf8");
    // Validated exactly as manage.mjs sync-pipelines sends it.
    const rendered = reviewedPipeline(raw);
    const response = await request("pipeline-model-converter/validate", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        [crumb.crumbRequestField]: crumb.crumb,
      },
      body: new URLSearchParams({ jenkinsfile: rendered }),
    });
    const result = await response.text();
    assert.ok(
      result.includes("Jenkinsfile successfully validated."),
      `Declarative template validation failed: ${file}`,
    );
    lint.push({
      file: `deploy/jenkins/${file}`,
      sourceSha256: createHash("sha256").update(raw).digest("hex"),
      renderedSha256: createHash("sha256").update(rendered).digest("hex"),
      status: "passed",
    });
  }
  const rejectedActivation = await (
    await request("scriptText", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        [crumb.crumbRequestField]: crumb.crumb,
      },
      body: new URLSearchParams({ script: activationScript() }),
    })
  ).text();
  assert.ok(
    rejectedActivation.includes(
      "Switch the controller to active mode before activating",
    ),
    "Lab controller must refuse production activation before any state mutation",
  );
  const after = await (
    await request("api/json?tree=numExecutors,useSecurity,jobs[name]")
  ).json();
  assert.deepEqual(after, controller);
  const credentialAfter = docker.controller([
    "exec",
    name,
    "cat",
    "/var/jenkins_home/container-state/lab-admin.json",
  ]);
  assertPrivateEquality(
    JSON.stringify(JSON.parse(credentialAfter)),
    JSON.stringify(credential),
    "Lab credential",
  );
  assertPrivateEquality(
    docker.controller([
      "exec",
      name,
      "cat",
      "/var/jenkins_home/secrets/master.key",
    ]),
    keyBefore,
    "Lab master key",
  );
  const connectivity = await probeBuildProfile(docker);
  return {
    schemaVersion: 1,
    recordedAt: new Date().toISOString(),
    state: "verified-lab-not-production",
    containerId: inspection.Id,
    imageId: inspection.Image,
    health: "healthy",
    controller: {
      jenkins: ready.jenkins,
      javaMajor: ready.javaMajor,
      activeLockedPlugins: plugins.plugins.length,
      executors: 0,
      jobs: 0,
      nodes: 0,
      anonymousApiStatus: anonymous.status,
      authenticatedApiStatus: 200,
      labActivationRejectedWithoutMutation: true,
    },
    isolation: {
      uid: 1000,
      readOnlyRootfs: true,
      privileged: false,
      hostPort: "127.0.0.1:18080",
      namedVolume: inspection.Mounts[0].Name,
      hostOrDockerSocketMounts: false,
    },
    declarativeLinter: lint,
    connectivity,
    productionApiTouched: false,
    existingHomeImported: false,
    businessExecutionJobsCreated: false,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  if (process.argv.length !== 2)
    throw new Error(
      "verify-controller.mjs accepts no service, credential or host overrides",
    );
  const proof = await verifyController();
  await fs.writeFile(
    join(root, "artifacts/jenkins-controller-container-live-verification.json"),
    `${JSON.stringify(proof, null, 2)}\n`,
  );
  console.log(
    JSON.stringify({
      state: proof.state,
      linterTemplates: proof.declarativeLinter.length,
      buildProfileHttpStatus: proof.connectivity.containerHttpStatus,
      dummyVolumeHandoffVerified: true,
      artifact: "artifacts/jenkins-controller-container-live-verification.json",
      productionApiTouched: false,
    }),
  );
}
