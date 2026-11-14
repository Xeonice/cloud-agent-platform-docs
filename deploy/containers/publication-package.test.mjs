import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { prepareDeployContext } from "./prepare-deploy-context.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const read = (name) => fs.readFile(join(directory, name), "utf8");

test("the native package worker uses its own deployment-libc image without Docker or instance authority", async () => {
  const compose = JSON.parse(await read("compose.publication.json"));
  const worker = compose.services["instance-package"];
  assert.match(worker.image, /\$\{PUBLICATION_PACKAGE_IMAGE:\?/);
  assert.notEqual(worker.image, compose.services.publisher.image);
  assert.notEqual(worker.image, compose.services["api-build"].image);
  assert.equal(worker.platform, "linux/arm64");
  assert.equal(worker.user, "1000:1000");
  assert.equal(worker.environment.JENKINS_AGENT_NAME, "linux-arm64-package");
  assert.equal(worker.environment.DOCKER_HOST, undefined);
  assert.equal(worker.privileged, undefined);
  assert.deepEqual(worker.cap_drop, ["ALL"]);
  assert.deepEqual(worker.security_opt, ["no-new-privileges:true"]);
  assert.equal(
    worker.volumes.some((volume) =>
      /docker|runtime|boxlite|api_secrets|\/data/.test(
        volume.source + volume.target,
      ),
    ),
    false,
  );
  assert.equal(
    worker.volumes
      .filter((volume) => /credentials/.test(volume.source))
      .every((volume) => volume.read_only === true),
    true,
  );
});

test("the package image pins Node and Rocky bytes and executes the unchanged native build gate before use", async () => {
  const docker = await read("publication-package.Dockerfile");
  const runtime = await read("Dockerfile.api");
  const rocky = /FROM (rockylinux:8@sha256:[a-f0-9]{64})/.exec(runtime)[1];
  assert.ok(docker.includes("FROM " + rocky));
  assert.doesNotMatch(docker, /CI_BASE_IMAGE|FROM \$\{|apt-get/);
  assert.match(docker, /jenkins\/inbound-agent:[^\s]+@sha256:[a-f0-9]{64}/);
  assert.match(docker, /NODE_VERSION=22\.23\.3/);
  assert.match(
    docker,
    /a44aeb94849a299b22df10b9e622ec2f605c2183501bc40590705131de7c740f \| sha256sum -c -/,
  );
  assert.match(docker, /test "\$TARGETARCH" = arm64/);
  assert.match(docker, /gcc-toolset-12-gcc-c\+\+/);
  assert.match(docker, /PYTHON=\/usr\/bin\/python3\.11/);
  assert.match(docker, /npm_config_build_from_source=true/);
  assert.match(docker, /nativeBuildEnvironment\(\)/);
  assert.match(docker, /actual\.nodeABI !== '127'/);
  assert.match(docker, /\/opt\/java\/openjdk\/bin\/java -version/);
  assert.match(docker, /USER 1000:1000/);
  assert.doesNotMatch(
    docker,
    /COPY\s+\.|runtime\.env|admin-api\.json|docker\.sock/,
  );
});

test("the assembled public build context carries the package image and its exact runtime entry dependencies", async (t) => {
  const temporary = await fs.mkdtemp(
    join(tmpdir(), "publication-package-context-"),
  );
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const prepared = await prepareDeployContext(
    join(directory, "../.."),
    temporary,
  );
  assert.equal(
    await fs.readFile(
      join(prepared.context, "publication-package.Dockerfile"),
      "utf8",
    ),
    await read("publication-package.Dockerfile"),
  );
  for (const name of [
    "tools/deploy/containers/publication-entrypoint.mjs",
    "tools/deploy/jenkins/ci-agent-entrypoint.mjs",
    "tools/deploy/jenkins/instance-package.mjs",
    "tools/deploy/upgrade/native-build-environment.mjs",
  ])
    assert.equal(
      (await fs.lstat(join(prepared.context, name))).isFile(),
      true,
      name,
    );
  assert.equal(
    prepared.manifest.files.some((file) =>
      /\.env$|admin-api|node_modules|private|credentials/.test(file.source),
    ),
    false,
  );
});
