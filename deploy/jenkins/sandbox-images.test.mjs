import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import {
  imageRequest,
  imageConfiguration,
  imagePlan,
  imageEnvironment,
  anonymousImage,
  createImagePublisher,
  IMAGE_BRANCH,
  IMAGE_REPOSITORY,
  DOCKER,
  BUILDER,
  DOCKER_HOST,
  DOCKER_PLUGINS,
  TOOLS,
  WORKSPACES,
  tokenValue,
} from "./sandbox-images.mjs";
const identity = {
  username: "jenkins",
  uid: 1000,
  gid: 1000,
  homedir: "/home/jenkins",
};
const system = {
  platform: "linux",
  arch: "arm64",
  nodeMajor: 22,
  node: "/usr/local/bin/node",
};
const sha = "a".repeat(40);
const config = {
  version: 1,
  registry: "ghcr.io",
  owner: "xeonice",
  platforms: ["linux/amd64", "linux/arm64"],
  defaultTag: "latest",
  tagPrefix: "sandbox-image-",
  images: [
    {
      tier: "aio",
      context: "images/platform-sandbox",
      image: "agent-platform-sandbox",
    },
    {
      tier: "boxlite",
      context: "images/platform-boxlite",
      image: "agent-platform-boxlite",
    },
  ],
};
const hash = (text) =>
  "sha256:" + createHash("sha256").update(text).digest("hex");
async function fixture(t) {
  const root = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), "sandbox-publish-test-")),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const work = join(root, "workspace");
  await fs.mkdir(work);
  const original = join(root, "fixture");
  await fs.mkdir(join(original, "config"), { recursive: true });
  await fs.writeFile(
    join(original, "config/sandbox-publish.json"),
    JSON.stringify(config),
  );
  for (const image of config.images) {
    await fs.mkdir(join(original, image.context), { recursive: true });
    await fs.writeFile(
      join(original, image.context, "Dockerfile"),
      "FROM node:22-bookworm-slim\nARG CLAUDE_CODE_VERSION=2.1.251\nARG CODEX_VERSION=0.150.1\n",
    );
  }
  return { root, work, original };
}
function registryModel(revision = sha, arches = ["amd64", "arm64"]) {
  const data = new Map();
  const manifests = [];
  for (const arch of arches) {
    const body = JSON.stringify({
      os: "linux",
      architecture: arch,
      config: { Labels: { "org.opencontainers.image.revision": revision } },
    });
    const configDigest = hash(body);
    data.set("/blobs/" + configDigest, body);
    const manifest = JSON.stringify({
      schemaVersion: 2,
      config: { digest: configDigest },
      layers: [],
    });
    const digest = hash(manifest);
    data.set("/manifests/" + digest, manifest);
    manifests.push({ digest, platform: { os: "linux", architecture: arch } });
  }
  const index = JSON.stringify({ schemaVersion: 2, manifests });
  return { data, index, digest: hash(index) };
}
function registryFetcher(
  model,
  exists = () => true,
  scopes = "repo, write:packages",
) {
  return async (url, options) => {
    const parsed = new URL(url);
    if (parsed.origin === "https://api.github.com")
      return Response.json(
        { login: "Xeonice" },
        { headers: { "x-oauth-scopes": scopes } },
      );
    if (parsed.pathname === "/token") {
      assert.equal(options.headers.authorization, undefined);
      return Response.json({ token: "anonymous-only" });
    }
    assert.equal(options.headers.authorization, "Bearer anonymous-only");
    assert.match(options.headers.accept, /application\/vnd\.oci\.image\.index/);
    const suffix = parsed.pathname.replace(
      /^\/v2\/xeonice\/agent-platform-(?:sandbox|boxlite)/,
      "",
    );
    if (["/manifests/v1.2.3", "/manifests/latest"].includes(suffix))
      return exists(parsed.pathname)
        ? new Response(model.index, {
            headers: { "docker-content-digest": model.digest },
          })
        : new Response("", { status: 404 });
    if (suffix.startsWith("/blobs/")) assert.equal(options.redirect, "follow");
    if (!model.data.has(suffix)) return new Response("", { status: 404 });
    return new Response(model.data.get(suffix));
  };
}

test("image requests/configuration bind both provider coordinates and reject PRs, tag drift, mutable version and missing architecture", async (t) => {
  assert.equal(IMAGE_BRANCH, "refs/heads/main");
  assert.equal(imageRequest(sha).ref, "refs/heads/main");
  assert.throws(
    () => imageRequest(sha, "refs/heads/feat/design-v2-migration"),
    /pinned/,
  );
  assert.equal(
    imageRequest(sha, "refs/tags/sandbox-image-v1.2.3", "", "publish").tag,
    "v1.2.3",
  );
  assert.throws(
    () => imageRequest(sha, "refs/pull/10/head", "v1.2.3", "publish"),
    /pinned/,
  );
  assert.throws(
    () => imageRequest(sha, "refs/tags/sandbox-image-v1.2.3", "v9", "publish"),
    /match/,
  );
  assert.throws(
    () => imageRequest(sha, IMAGE_BRANCH, "latest", "publish"),
    /immutable/,
  );
  for (const bad of [
    { ...config, owner: "cap" },
    { ...config, platforms: ["linux/arm64"] },
    {
      ...config,
      images: [
        config.images[0],
        { ...config.images[1], context: config.images[0].context },
      ],
    },
  ])
    assert.throws(() => imageConfiguration(bad));
  const f = await fixture(t);
  const plan = await imagePlan(f.original, imageRequest(sha, IMAGE_BRANCH));
  assert.equal(plan.images[0].tag, "cc2.1.251-cx0.150.1-gaaaaaaaaaaaa");
  await fs.symlink(
    "/tmp",
    join(f.original, config.images[0].context, "outside"),
  );
  await assert.rejects(
    imagePlan(f.original, imageRequest(sha, IMAGE_BRANCH)),
    /symlink/,
  );
});

test("anonymous OCI validation verifies both platform/config digests and source labels, including GHCR blob redirects", async () => {
  const model = registryModel();
  const verified = await anonymousImage(
    "ghcr.io/xeonice/agent-platform-boxlite",
    "v1.2.3",
    sha,
    registryFetcher(model),
  );
  assert.deepEqual(verified, {
    digest: model.digest,
    platforms: ["linux/amd64", "linux/arm64"],
    anonymous: true,
  });
  await assert.rejects(
    anonymousImage(
      "ghcr.io/xeonice/agent-platform-boxlite",
      "v1.2.3",
      "b".repeat(40),
      registryFetcher(model),
    ),
    /different source/,
  );
  await assert.rejects(
    anonymousImage(
      "ghcr.io/xeonice/agent-platform-boxlite",
      "v1.2.3",
      sha,
      registryFetcher(registryModel(sha, ["arm64"])),
    ),
    /linux\/amd64/,
  );
  const broken = registryModel();
  broken.data.set(
    [...broken.data.keys()].find((k) => k.startsWith("/blobs/")),
    "{}",
  );
  await assert.rejects(
    anonymousImage(
      "ghcr.io/xeonice/agent-platform-boxlite",
      "v1.2.3",
      sha,
      registryFetcher(broken),
    ),
    /bytes differ/,
  );
});

async function publisherFixture(t, mode, scopes = "repo, write:packages") {
  const f = await fixture(t);
  const calls = [];
  const published = new Set();
  const model = registryModel();
  let reads = 0;
  const token = "test-private-value-do-not-project";
  const run = async (command, args, options) => {
    calls.push({ command, args, env: options.env, input: options.input });
    if (command === "/usr/bin/git") {
      if (args[0] === "fetch") {
        assert.equal(args[2], IMAGE_REPOSITORY);
        await fs.cp(f.original, options.cwd, { recursive: true });
      }
      if (args[0] === "rev-parse") return sha;
      return "";
    }
    if (command === system.node) {
      assert.deepEqual(args, ["scripts/check-default-image-consistency.mjs"]);
      return "";
    }
    assert.equal(command, DOCKER);
    assert.equal(options.env.DOCKER_HOST, DOCKER_HOST);
    if (args[0] === "context") {
      const privateConfig = JSON.parse(
        await fs.readFile(
          join(options.env.DOCKER_CONFIG, "config.json"),
          "utf8",
        ),
      );
      assert.deepEqual(privateConfig, {
        cliPluginsExtraDirs: [DOCKER_PLUGINS],
      });
      assert.equal(
        (await fs.stat(options.env.DOCKER_CONFIG)).mode & 0o777,
        0o700,
      );
      assert.deepEqual(args, [
        "context",
        "create",
        BUILDER,
        "--docker",
        "host=" + DOCKER_HOST,
      ]);
      return "";
    }
    if (args[0] === "version") return "29.0";
    if (args[0] === "login") {
      assert.deepEqual(args, [
        "login",
        "ghcr.io",
        "--username",
        "Xeonice",
        "--password-stdin",
      ]);
      assert.equal(options.input, token + "\n");
      await fs.writeFile(join(options.env.DOCKER_CONFIG, "config.json"), "{}");
      return "";
    }
    if (args[0] === "logout") return "";
    assert.equal(args[0], "buildx");
    if (args[1] === "inspect") {
      assert.equal(args[2], BUILDER);
      return "Platforms: linux/amd64, linux/arm64";
    }
    if (args[1] === "build") {
      assert.equal(
        args[args.indexOf("--platform") + 1],
        "linux/amd64,linux/arm64",
      );
      assert.equal(args[args.indexOf("--builder") + 1], BUILDER);
      assert.ok(args.includes("org.opencontainers.image.revision=" + sha));
      assert.equal(args.includes("--build-arg"), false);
      const coordinate = args[args.indexOf("--tag") + 1];
      published.add(coordinate.split(":")[0].slice("ghcr.io/".length));
      await fs.writeFile(
        args[args.indexOf("--metadata-file") + 1],
        JSON.stringify({ "containerimage.digest": model.digest }),
      );
      return "";
    }
    throw new Error("Unexpected image command");
  };
  const runner = createImagePublisher({
    workspaceRoot: f.root,
    identity,
    system,
    checkLayout: async (context) => {
      assert.equal(context.root, "/srv/agent-platform/deploy");
      assert.equal(context.tools, "/run/agent-platform/jenkins-tools");
      assert.equal(context.uid, 1000);
    },
    run,
    token: async () => {
      reads++;
      return token;
    },
    fetch: registryFetcher(
      model,
      (path) => [...published].some((name) => path.includes(name)),
      scopes,
    ),
  });
  const result = await runner.stage(sha, IMAGE_BRANCH, "v1.2.3", mode, f.work);
  return { ...f, calls, result, reads, token };
}

test("check mode binds checkout and builder without reading publication credentials or making a push", async (t) => {
  const f = await publisherFixture(t, "check");
  assert.equal(f.result.status, "checked");
  assert.equal(f.reads, 0);
  assert.equal(
    f.calls.some(
      (call) => call.args.includes("login") || call.args.includes("--push"),
    ),
    false,
  );
  assert.deepEqual(
    (await fs.readdir(f.work)).filter((name) => name.startsWith(".docker-")),
    [],
  );
  assert.equal(
    JSON.parse(
      await fs.readFile(join(f.work, "sandbox-images-result.json"), "utf8"),
    ).status,
    "checked",
  );
});

test("publish sends token only over login stdin/private Docker config, publishes two architectures/tier and anonymizes final provenance", async (t) => {
  const f = await publisherFixture(t, "publish");
  assert.equal(f.result.status, "published");
  assert.equal(f.result.images.length, 2);
  assert.equal(
    f.result.images.every(
      (image) => image.anonymous && image.status === "published",
    ),
    true,
  );
  assert.equal(
    f.calls.filter((call) => call.args.includes("--push")).length,
    2,
  );
  assert.equal(f.calls.filter((call) => call.args[0] === "logout").length, 1);
  for (const call of f.calls) {
    assert.equal(JSON.stringify(call.args).includes(f.token), false);
    assert.equal(JSON.stringify(call.env).includes(f.token), false);
  }
  assert.equal(JSON.stringify(f.result).includes(f.token), false);
  assert.equal(
    (await fs.stat(join(f.work, "sandbox-images-result.json"))).mode & 0o777,
    0o600,
  );
  assert.deepEqual(
    (await fs.readdir(f.work)).filter((name) => name.startsWith(".docker-")),
    [],
  );
});

test("missing write:packages fails before login/build and cannot be reported as publish success", async (t) => {
  const f = await publisherFixture(t, "publish", "repo, read:org");
  assert.equal(f.result.status, "failed");
  assert.match(f.result.error, /write:packages/);
  assert.equal(
    f.calls.some(
      (call) => call.args.includes("login") || call.args.includes("--push"),
    ),
    false,
  );
  assert.deepEqual(
    (await fs.readdir(f.work)).filter((name) => name.startsWith(".docker-")),
    [],
  );
  const env = imageEnvironment(system.node, "/temporary/private", "/temporary");
  assert.equal(env.ACCESS_PASSCODE, undefined);
  assert.equal(env.GH_TOKEN, undefined);
});

test("ordinary Linux CI identity cannot publish without both private deployment volumes; layout refusal precedes checkout/token/Docker", async () => {
  let calls = 0;
  let reads = 0;
  const runner = createImagePublisher({
    identity,
    system,
    checkLayout: async () => {
      throw new Error("Private deployment volumes absent");
    },
    run: async () => {
      calls++;
    },
    token: async () => {
      reads++;
    },
  });
  await assert.rejects(runner.head(), /Private deployment volumes absent/);
  await assert.rejects(
    runner.stage(sha, IMAGE_BRANCH),
    /Private deployment volumes absent/,
  );
  assert.equal(calls, 0);
  assert.equal(reads, 0);
});

test("publisher fixes Linux ARM64 identity, Docker socket/tools and workspace, rejecting root, wrong home and generic x64 builders", async () => {
  assert.equal(DOCKER, "/usr/local/bin/docker");
  assert.equal(DOCKER_HOST, "unix:///var/run/docker.sock");
  assert.equal(BUILDER, "agent-platform-runtime");
  assert.equal(TOOLS, "/run/agent-platform/jenkins-tools");
  assert.equal(WORKSPACES, "/home/jenkins/agent");
  for (const account of [
    { ...identity, uid: 0 },
    { ...identity, gid: 0 },
    { ...identity, homedir: "/srv/agent-platform/deploy" },
    { ...identity, username: "root" },
  ]) {
    await assert.rejects(
      createImagePublisher({ identity: account, system }).head(),
      /Trusted deployment/,
    );
  }
  for (const platform of [
    { ...system, arch: "x64" },
    { ...system, node: "/tmp/node" },
    { ...system, nodeMajor: 24 },
  ]) {
    await assert.rejects(
      createImagePublisher({ identity, system: platform }).head(),
      /Trusted deployment|fixed Node/,
    );
  }
});

test("GHCR service file refuses readable modes, hardlinks, symlinks and wrong ownership without exposing its contents", async (t) => {
  const f = await fixture(t);
  const file = join(f.root, "ghcr-token");
  const token = "isolated-test-credential";
  await fs.writeFile(file, token, { mode: 0o600 });
  assert.equal(await tokenValue(file, process.getuid()), token);
  await fs.chmod(file, 0o644);
  await assert.rejects(tokenValue(file, process.getuid()), /owner-only/);
  await fs.chmod(file, 0o600);
  await assert.rejects(tokenValue(file, process.getuid() + 1), /owner-only/);
  const hardlink = join(f.root, "hardlink");
  await fs.link(file, hardlink);
  await assert.rejects(tokenValue(file, process.getuid()), /owner-only/);
  await fs.unlink(hardlink);
  const symlink = join(f.root, "symlink");
  await fs.symlink(file, symlink);
  await assert.rejects(tokenValue(symlink, process.getuid()));
});

test("image child environment ignores inherited application secrets and redirects all Docker state into the private context", () => {
  const previous = { ...process.env };
  process.env.ACCESS_PASSCODE = "private-test-passcode";
  process.env.GH_TOKEN = "private-test-token";
  process.env.DOCKER_HOST = "tcp://untrusted.invalid:2375";
  process.env.DOCKER_CONFIG = "/untrusted/config";
  process.env.NODE_OPTIONS = "--require=/untrusted/code.js";
  try {
    const environment = imageEnvironment(
      system.node,
      "/private/docker",
      "/private/tmp",
    );
    assert.equal(environment.HOME, "/home/jenkins");
    assert.equal(environment.LANG, "C.UTF-8");
    assert.equal(environment.DOCKER_HOST, "unix:///var/run/docker.sock");
    assert.equal(environment.DOCKER_CONFIG, "/private/docker");
    for (const name of ["ACCESS_PASSCODE", "GH_TOKEN", "NODE_OPTIONS"])
      assert.equal(environment[name], undefined);
    assert.equal(environment.PATH.includes("/Users/"), false);
    assert.equal(environment.PATH.includes("/opt/homebrew/"), false);
  } finally {
    for (const key of Object.keys(process.env))
      if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
});
