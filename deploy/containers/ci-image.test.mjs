import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";

const read = (name) => fs.readFile(new URL(name, import.meta.url), "utf8");

test("CI image locks both Linux architectures, Node bytes and browser/CLI dependency graph", async () => {
  const docker = await read("ci.Dockerfile");
  const pkg = JSON.parse(await read("ci-tools/package.json"));
  const lock = JSON.parse(await read("ci-tools/package-lock.json"));
  assert.match(
    docker,
    /FROM jenkins\/inbound-agent:[^\s]+@sha256:[a-f0-9]{64}/,
  );
  assert.match(docker, /NODE_VERSION=22\.23\.3/);
  assert.match(docker, /COREPACK_HOME=\/opt\/agent-platform\/corepack/);
  assert.match(docker, /COREPACK_DEFAULT_TO_LATEST=0/);
  assert.match(docker, /corepack prepare pnpm@9\.12\.0/);
  assert.match(
    docker,
    /arm64\).*node_sha=a44aeb94849a299b22df10b9e622ec2f605c2183501bc40590705131de7c740f/,
  );
  assert.match(
    docker,
    /amd64\).*node_sha=df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de/,
  );
  assert.equal(pkg.dependencies.playwright, "1.62.1");
  assert.equal(pkg.dependencies.vercel, "62.2.0");
  assert.deepEqual(lock.packages[""].dependencies, pkg.dependencies);
  assert.equal(lock.packages["node_modules/playwright"].version, "1.62.1");
  assert.equal(lock.packages["node_modules/vercel"].version, "62.2.0");
  for (const [name, value] of Object.entries(lock.packages)) {
    if (!name) continue;
    assert.match(value.resolved, /^https:\/\/registry\.npmjs\.org\//);
    assert.match(value.integrity, /^sha512-/);
  }
  assert.match(docker, /playwright\/cli\.js install --with-deps chromium/);
  assert.match(docker, /npm ci .*--ignore-scripts/);
});

test("image copies only fixed public tools as root and launches the isolated secret-file agent", async () => {
  const docker = await read("ci.Dockerfile");
  assert.equal(/COPY\s+(?:--[^\s]+\s+)*\.\s/.test(docker), false);
  assert.equal(docker.includes("COPY --chown"), false);
  for (const name of [
    "jenkins-ci",
    "project-ci",
    "jenkins-web",
    "mutation",
    "ci-platform",
    "ci-agent-entrypoint",
  ])
    assert.equal(docker.includes("tools/" + name + ".mjs"), true);
  assert.match(docker, /chmod -R go-w \/opt\/agent-platform/);
  assert.match(docker, /USER 1000:1000/);
  assert.match(
    docker,
    /JENKINS_AGENT_SECRET_FILE=\/run\/secrets\/jenkins_agent_secret/,
  );
  assert.match(docker, /ENTRYPOINT.*tini.*ci-agent-entrypoint\.mjs/);
  for (const name of [
    "runtime.env",
    "auth.json",
    "cloudflared.token",
    "/var/run/docker.sock",
  ])
    assert.equal(docker.includes(name), false);
});

test("Web releases their CI executor before contract waits, and contract runs deployment and acceptance on Linux", async () => {
  const web = await fs.readFile(
    new URL("../jenkins/web.groovy", import.meta.url),
    "utf8",
  );
  const contract = await fs.readFile(
    new URL("../jenkins/contract.groovy", import.meta.url),
    "utf8",
  );
  assert.match(web, /agent none/);
  assert.match(web, /label 'agent-platform-web-build'/);
  assert.match(web, /NODE22 = '\/usr\/local\/bin\/node'/);
  assert.match(
    web,
    /PUBLIC_WEB_TOOL = '\/opt\/agent-platform\/tools\/jenkins-web\.mjs'/,
  );
  assert.ok(
    web.indexOf("stage('Real cross repository browser acceptance')") >
      web.indexOf("Package and fingerprint artifacts"),
  );
  assert.match(
    web,
    /build job: 'agent-platform-contract'.*wait: true, propagate: false/,
  );
  assert.match(contract, /agent none/);
  assert.doesNotMatch(contract, /label 'agent-platform-ci'/);
  assert.match(contract, /deployment-tests/);
  assert.match(contract, /label 'agent-platform-linux-ci'/);
  assert.ok(
    contract.indexOf("Complete native deployment regression") <
      contract.indexOf(
        "Linux docs and real cross repository browser acceptance",
      ),
  );
  assert.match(
    contract,
    /deployment-tests "\$ROOT_SHA" "\$API_SHA" "\$WEB_SHA"/,
  );
  assert.equal(contract.includes("catchError"), false);
});
