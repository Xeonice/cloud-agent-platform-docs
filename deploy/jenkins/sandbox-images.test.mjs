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
} from "./sandbox-images.mjs";
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
    if (command === process.execPath) {
      assert.deepEqual(args, ["scripts/check-default-image-consistency.mjs"]);
      return "";
    }
    assert.equal(command, DOCKER);
    assert.equal(options.env.DOCKER_HOST, DOCKER_HOST);
    if (args[0] === "context") {
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
    identity: { uid: 501, platform: "darwin", arch: "arm64", node: 22 },
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
  const env = imageEnvironment(
    process.execPath,
    "/temporary/private",
    "/temporary",
  );
  assert.equal(env.ACCESS_PASSCODE, undefined);
  assert.equal(env.GH_TOKEN, undefined);
});
