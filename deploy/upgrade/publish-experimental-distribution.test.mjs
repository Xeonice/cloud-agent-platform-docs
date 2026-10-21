import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildQualificationDistribution } from "./build-distribution.mjs";
import { publishExperimentalDistribution } from "./publish-experimental-distribution.mjs";
import { publishDistribution } from "./publish-distribution.mjs";
import { atomicJson, readJson, fileDigest } from "./io.mjs";
import { canonical, digest } from "./trust.mjs";

const REPOSITORY = "Xeonice/cloud-agent-platform-docs";
const H = "sha256:" + "a".repeat(64);
async function fixture(
  t,
  {
    channel = "experiment-online-20261014",
    releaseId = "v0.3.9-experiment.20261014.1",
  } = {},
) {
  const root = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), "experimental-publication-")),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const name = "agent-platform-" + releaseId + "-linux-arm64.tgz";
  await fs.writeFile(join(root, name), "actual experimental test bytes", {
    mode: 0o600,
  });
  const component = {
    artifactDigest: H,
    inputFingerprint: H,
    sourceRevision: "a".repeat(40),
    protocol: { min: 1, max: 1 },
  };
  const manifest = {
    schemaVersion: 2,
    releaseId,
    channel,
    publishedAt: new Date().toISOString(),
    commits: {
      project: "a".repeat(40),
      api: "b".repeat(40),
      web: "c".repeat(40),
    },
    components: {
      api: component,
      coordinator: component,
      installer: component,
      web: { ...component, webRevision: "d".repeat(40) },
    },
    packages: [
      {
        platform: "linux",
        arch: "arm64",
        name,
        url: `https://github.com/${REPOSITORY}/releases/download/${releaseId}/${name}`,
        ...(await fileDigest(join(root, name))),
        format: "native-tar",
      },
    ],
    upgradePaths: [
      {
        fromRelease: "v0.3.8",
        minSchema: 28,
        maxSchema: 28,
        targetSchema: 28,
        bridgeReleases: [],
        migrationPlanDigest: null,
      },
    ],
    policy: {
      id: "experimental-policy",
      weights: [1, 5, 25, 100],
      stageDurationMs: 60000,
      minRequests: 100,
      observationFreshnessMs: 5000,
      probeHz: 10,
      requestDeadlineMs: 2000,
      attachDeadlineMs: 5000,
      softErrorDelta: 0.01,
      p95Ratio: 2,
      p95FloorMs: 1000,
      evaluationIntervalMs: 10000,
      consecutiveEvaluations: 2,
      retentionMs: 60000,
      migrationBatchMs: 500,
      maxWalBytes: 100000000,
      minFreeBytes: 1000000000,
      fallbacks: [
        { releaseId: "v0.3.8", apiDigest: H, webDigest: H, rehearsed: false },
      ],
      stopUserResources: false,
      restoreLiveVolume: false,
      contractInUpgrade: false,
    },
  };
  const instanceId = "upgrade-acceptance-online-copy-20261014";
  const qualified = await buildQualificationDistribution({
    manifest,
    outputRoot: root,
    instanceId,
    runId: "experimental-publication-test",
  });
  return {
    root,
    instanceId,
    manifest,
    qualified,
    trustRootPath: join(root, "qualification-trust-root.json"),
    token: "test-secret-must-not-leave-fixed-github-hosts",
  };
}
function github(
  f,
  {
    published = false,
    conflict = false,
    foreignUpload = false,
    badUploadDigest = false,
    badTag = false,
  } = {},
) {
  const calls = [],
    assets = [];
  let release = published
    ? {
        id: 12,
        tag_name: f.manifest.releaseId,
        target_commitish: f.manifest.commits.project,
        draft: false,
        prerelease: true,
        upload_url: `https://uploads.github.com/repos/${REPOSITORY}/releases/12/assets{?name,label}`,
        published_at: "2026-10-14T00:00:00Z",
      }
    : null;
  let tag = published || badTag;
  const result = (value, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => structuredClone(value),
  });
  return {
    calls,
    assets,
    get release() {
      return release;
    },
    fetcher: async (url, options) => {
      const u = new URL(url);
      assert.ok(["api.github.com", "uploads.github.com"].includes(u.hostname));
      assert.equal(options.headers.authorization, "Bearer " + f.token);
      const body =
        options.body && !Buffer.isBuffer(options.body)
          ? JSON.parse(options.body)
          : null;
      calls.push({ url, method: options.method, body });
      if (u.pathname.includes("/git/ref/tags/"))
        return tag
          ? result({
              object: {
                type: "commit",
                sha: badTag ? "f".repeat(40) : f.manifest.commits.project,
              },
            })
          : result(null, 404);
      if (u.pathname.includes("/releases/tags/"))
        return release ? result(release) : result(null, 404);
      if (u.pathname.endsWith("/releases") && options.method === "POST") {
        release = {
          ...body,
          id: 12,
          upload_url: foreignUpload
            ? "https://untrusted.invalid/upload{?name,label}"
            : `https://uploads.github.com/repos/${REPOSITORY}/releases/12/assets{?name,label}`,
        };
        return result(release, 201);
      }
      if (u.hostname === "uploads.github.com") {
        const asset = {
          name: u.searchParams.get("name"),
          size: options.body.length,
          digest: badUploadDigest ? H : digest(options.body),
        };
        assets.push(asset);
        return result(asset, 201);
      }
      if (u.pathname.endsWith("/assets"))
        return result(
          conflict
            ? [{ name: "qualification-catalog.json", size: 1, digest: H }]
            : assets,
        );
      if (options.method === "PATCH") {
        release = { ...release, ...body, published_at: "2026-10-14T00:00:00Z" };
        tag = true;
        return result(release);
      }
      throw Error("Unexpected mocked route");
    },
  };
}

test("experimental publication uploads actual signed qualification bytes as a non-latest prerelease and preserves not-run evidence", async (t) => {
  const f = await fixture(t),
    remote = github(f);
  const before = canonical(
    await readJson(join(f.root, "qualification-catalog.json")),
  );
  const proof = await publishExperimentalDistribution({
    ...f,
    fetcher: remote.fetcher,
  });
  assert.equal(proof.experimentPublished, true);
  assert.equal(proof.upgradeQualified, false);
  assert.equal(proof.instanceDeployment, false);
  assert.equal(proof.instanceId, f.instanceId);
  assert.equal(proof.purpose, "qualification");
  assert.equal(
    canonical(await readJson(join(f.root, "qualification-catalog.json"))),
    before,
  );
  assert.ok(
    (
      await readJson(join(f.root, "qualification-release.json"))
    ).manifest.evidence.every((row) => row.result === "not-run"),
  );
  assert.equal(remote.assets.length, 9);
  for (const request of remote.calls.filter(
    (row) => row.body && ["POST", "PATCH"].includes(row.method),
  )) {
    assert.equal(request.body.prerelease, true);
    assert.equal(request.body.make_latest, "false");
  }
  const again = await publishExperimentalDistribution({
    ...f,
    fetcher: remote.fetcher,
  });
  assert.deepEqual(again.assets, proof.assets);
  assert.equal(remote.calls.filter((row) => row.method === "PATCH").length, 1);
});

test("wrong trust purpose, stable channel, normal tag, wrong instance and other repository are refused before any remote request", async (t) => {
  for (const options of [{ channel: "stable" }, { releaseId: "v0.3.9" }]) {
    const f = await fixture(t, options);
    let requests = 0;
    await assert.rejects(
      publishExperimentalDistribution({
        ...f,
        fetcher: async () => {
          requests++;
        },
      }),
    );
    assert.equal(requests, 0);
  }
  const f = await fixture(t);
  let requests = 0;
  const fetcher = async () => {
    requests++;
  };
  await assert.rejects(
    publishExperimentalDistribution({
      ...f,
      instanceId: "some-other-instance",
      fetcher,
    }),
    { code: "EXPERIMENTAL_QUALIFICATION_TRUST_REQUIRED" },
  );
  await assert.rejects(
    publishExperimentalDistribution({
      ...f,
      repository: "someone/another",
      fetcher,
    }),
    { code: "EXPERIMENTAL_PUBLISHER_CREDENTIAL_REQUIRED" },
  );
  await atomicJson(f.trustRootPath, {
    ...f.qualified.trustRoot,
    purpose: "release",
  });
  await assert.rejects(publishExperimentalDistribution({ ...f, fetcher }), {
    code: "EXPERIMENTAL_QUALIFICATION_TRUST_REQUIRED",
  });
  assert.equal(requests, 0);
});

test("tampered signature, archive or original gate file cannot trigger even draft creation", async (t) => {
  for (const mutate of [
    async (f) => {
      const c = await readJson(join(f.root, "qualification-catalog.json"));
      c.releases[0].envelope.manifest.commits.project = "f".repeat(40);
      await atomicJson(join(f.root, "qualification-catalog.json"), c);
    },
    async (f) =>
      fs.writeFile(
        join(f.root, f.manifest.packages[0].name),
        "changed archive",
      ),
    async (f) => {
      const p = join(f.root, "qualification-native-continuity.json");
      const r = await readJson(p);
      await atomicJson(p, { ...r, result: "passed" });
    },
  ]) {
    const f = await fixture(t);
    await mutate(f);
    let requests = 0;
    await assert.rejects(
      publishExperimentalDistribution({
        ...f,
        fetcher: async () => {
          requests++;
        },
      }),
    );
    assert.equal(requests, 0);
  }
});

test("remote digest conflicts and existing published incomplete experiments never overwrite or upload assets", async (t) => {
  for (const [options, code] of [
    [{ conflict: true }, "IMMUTABLE_EXPERIMENTAL_ASSET_CONFLICT"],
    [{ published: true }, "PUBLISHED_EXPERIMENT_IS_IMMUTABLE"],
  ]) {
    const f = await fixture(t),
      remote = github(f, options);
    await assert.rejects(
      publishExperimentalDistribution({ ...f, fetcher: remote.fetcher }),
      { code },
    );
    assert.equal(remote.assets.length, 0);
    assert.equal(
      remote.calls.filter((row) => row.method === "PATCH").length,
      0,
    );
    assert.equal(
      remote.calls.some((row) => row.method === "DELETE"),
      false,
    );
  }
});

test("untrusted upload origin never receives the token; unconfirmed digest leaves a draft unpublished", async (t) => {
  for (const [options, code] of [
    [{ foreignUpload: true }, "EXPERIMENTAL_REMOTE_ORIGIN_INVALID"],
    [{ badUploadDigest: true }, "EXPERIMENTAL_REMOTE_DIGEST_UNCONFIRMED"],
  ]) {
    const f = await fixture(t),
      remote = github(f, options);
    await assert.rejects(
      publishExperimentalDistribution({ ...f, fetcher: remote.fetcher }),
      { code },
    );
    assert.equal(
      remote.calls.some((row) => row.method === "PATCH"),
      false,
    );
    assert.equal(remote.release.draft, true);
  }
});

test("an existing experiment tag at another commit is refused before release or asset mutations", async (t) => {
  const f = await fixture(t),
    remote = github(f, { badTag: true });
  await assert.rejects(
    publishExperimentalDistribution({ ...f, fetcher: remote.fetcher }),
    { code: "EXPERIMENTAL_REMOTE_TAG_CONFLICT" },
  );
  assert.ok(remote.calls.every((row) => row.method === "GET"));
});

test("the unchanged production publisher still rejects the same qualification trust root", async (t) => {
  const f = await fixture(t);
  let requests = 0;
  await assert.rejects(
    publishDistribution({
      ...f,
      fetcher: async () => {
        requests++;
      },
    }),
    { code: "PRODUCTION_PUBLICATION_TRUST_REQUIRED" },
  );
  assert.equal(requests, 0);
});
