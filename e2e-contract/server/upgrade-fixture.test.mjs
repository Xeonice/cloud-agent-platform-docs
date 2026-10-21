import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import tls from "node:tls";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUpgradeFixture } from "./upgrade-fixture.mjs";
import { command, downloadVerified } from "../../deploy/upgrade/artifacts.mjs";
import {
  atomicJson,
  treeManifest,
  fileDigest,
} from "../../deploy/upgrade/io.mjs";
import { digest } from "../../deploy/upgrade/trust.mjs";
import { createCandidateSupervisor } from "../../deploy/upgrade/candidate-supervisor.mjs";

// Real signed qualification fixture, TLS socket and production downloader.
// Small transport-test payloads do not constitute Native qualification, start
// any application/SDK, or replace a browser/API response.
async function transportFixture(t) {
  const root = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), "upg-package-transport-")),
  );
  const oldCAs = tls.getCACertificates("default");
  let fixture;
  t.after(async () => {
    await fixture?.close();
    tls.setDefaultCACertificates(oldCAs);
    await fs.rm(root, { recursive: true, force: true });
  });
  const initialRoot = join(root, "initial"),
    archiveRoot = join(root, "archive");
  await fs.mkdir(initialRoot, { mode: 0o700 });
  await fs.mkdir(archiveRoot, { mode: 0o700 });
  for (const name of ["api", "web", "installer"]) {
    await fs.mkdir(join(initialRoot, name), { mode: 0o700 });
    await fs.writeFile(
      join(initialRoot, name, "transport-fixture.txt"),
      name + " immutable unit transport bytes",
      { mode: 0o600 },
    );
  }
  const files = await treeManifest(initialRoot),
    revision = "a".repeat(40);
  const component = (name) => ({
    artifactDigest: digest(files.filter((f) => f.path.startsWith(name + "/"))),
    inputFingerprint: digest(name),
    sourceRevision: revision,
    protocol: { min: 1, max: 1 },
  });
  const components = {
    api: component("api"),
    web: { ...component("web"), webRevision: revision },
    installer: component("installer"),
    coordinator: component("api"),
    owner: component("api"),
  };
  await atomicJson(join(initialRoot, "upgrade-artifact.json"), {
    schemaVersion: 1,
    releaseId: "v1.0.0",
    platform: process.platform,
    arch: process.arch,
    components,
    files,
    treeDigest: digest(files),
  });
  const name = "agent-platform-v1.0.1-transport.tgz";
  await command("tar", [
    "-czf",
    join(archiveRoot, name),
    "-C",
    initialRoot,
    ".",
  ]);
  const pkg = {
    name,
    platform: process.platform,
    arch: process.arch,
    format: "native-tar",
    url: "https://qualification.invalid/" + name,
    ...(await fileDigest(join(archiveRoot, name))),
  };
  const manifest = {
    schemaVersion: 2,
    releaseId: "v1.0.1",
    channel: "stable",
    publishedAt: new Date().toISOString(),
    commits: { project: revision, api: revision, web: revision },
    components,
    packages: [pkg],
    upgradePaths: [
      {
        fromRelease: "v1.0.0",
        minSchema: 28,
        maxSchema: 28,
        targetSchema: 28,
        bridgeReleases: [],
        migrationPlanDigest: null,
      },
    ],
    policy: {
      id: "transport-test",
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
      retentionMs: 600000,
      migrationBatchMs: 500,
      maxWalBytes: 100000000,
      minFreeBytes: 500000000,
      fallbacks: [
        {
          releaseId: "v1.0.0",
          apiDigest: components.api.artifactDigest,
          webDigest: components.web.artifactDigest,
          rehearsed: false,
        },
      ],
      stopUserResources: false,
      restoreLiveVolume: false,
      contractInUpgrade: false,
    },
    evidence: [],
  };
  fixture = await createUpgradeFixture({
    isolated: true,
    instanceId: "upgrade-acceptance-package-transport",
    root: join(root, "instance"),
    initialRoot,
    initialRelease: {
      releaseId: "v1.0.0",
      schema: 28,
      commits: manifest.commits,
    },
    archiveRoot,
    targetManifest: manifest,
  });
  return {
    fixture,
    root,
    pkg: fixture.envelope.manifest.packages[0],
    archiveRoot,
  };
}

test("package-only HTTPS 503 preserves signed availability bytes and fails the real downloader without a stream", async (t) => {
  const { fixture, root, pkg, archiveRoot } = await transportFixture(t);
  assert.equal(
    "upgrade" in fixture.config.keys,
    false,
    "fresh instances need no upgrade access key",
  );
  const protectedPaths = [
    fixture.manifestPath,
    fixture.trustRootPath,
    fixture.config.catalogFile,
    fixture.installationProofPath,
    join(archiveRoot, pkg.name),
  ];
  const before = await Promise.all(protectedPaths.map(fileDigest));
  const fault = fixture.helpers.setPackageDownloadFault("http-503");
  await assert.rejects(
    downloadVerified(pkg, join(root, "downloader"), {
      assertFence: async () => {},
    }),
    { code: "PACKAGE_DOWNLOAD_FAILED" },
  );
  const requests = fixture.requestLog();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].status, 503);
  assert.equal(requests[0].bytesSent, 0);
  assert.equal(requests[0].completed, true);
  assert.ok(Date.parse(requests[0].startedAt) >= Date.parse(fault.armedAt));
  assert.deepEqual(await Promise.all(protectedPaths.map(fileDigest)), before);
  const unrelated = await fetch(new URL("/catalog-not-a-package", pkg.url));
  assert.equal(unrelated.status, 404);
  assert.equal(fixture.requestLog().length, 1);
});

test("ordinary real HTTPS package bytes remain verified and fault activation cannot occur after a download", async (t) => {
  const { fixture, root, pkg } = await transportFixture(t);
  assert.throws(() => fixture.helpers.setPackageDownloadFault("http-500"), {
    code: "EXPLICIT_QUALIFICATION_PACKAGE_DOWNLOAD_FAULT_REQUIRED",
  });
  const downloaded = await downloadVerified(pkg, join(root, "downloader"), {
    assertFence: async () => {},
  });
  assert.equal(downloaded.digest, pkg.digest);
  assert.equal(downloaded.bytes, pkg.bytes);
  assert.equal(fixture.requestLog()[0].status, 200);
  assert.throws(() => fixture.helpers.setPackageDownloadFault("http-503"), {
    code: "PACKAGE_DOWNLOAD_FAULT_MUST_PRECEDE_DOWNLOADS",
  });
});

test("both Native harness configs share the production downloader cache with the Supervisor's actual publication reader", async (t) => {
  const { fixture, root, pkg } = await transportFixture(t);
  for (const path of [
    "./start-independent-upgrade.mjs",
    "./prepare-migration-upgrade.mjs",
  ]) {
    const source = await fs.readFile(new URL(path, import.meta.url), "utf8");
    assert.match(source, /downloadRoot:\s*paths\.installer,/);
    assert.match(
      source,
      /controlDownloadRoot:\s*join\(paths\.installer, "downloads"\)/,
    );
  }
  const installerRoot = join(root, "shared-installer"),
    downloaded = await downloadVerified(pkg, installerRoot, {
      assertFence: async () => {},
    });
  assert.equal(
    downloaded.path,
    join(installerRoot, "downloads", pkg.digest.slice(7) + ".tgz"),
  );
  assert.equal(
    await fs
      .lstat(join(installerRoot, "downloads", "downloads"))
      .catch(() => null),
    null,
  );
  const beforeCacheRead = fixture.requestLog().length;
  assert.deepEqual(
    await downloadVerified(pkg, installerRoot, { assertFence: async () => {} }),
    downloaded,
  );
  assert.equal(
    fixture.requestLog().length,
    beforeCacheRead,
    "verified cache needs no extra request",
  );
  const instanceId = fixture.config.instanceId,
    key = "transport-supervisor".padEnd(40, "-"),
    attemptId = "transport-publication";
  const coordinator = {
    origin: "http://127.0.0.1:39999",
    assertFence: async (id, fence) => {
      assert.equal(id, attemptId);
      assert.equal(fence, 7);
    },
    snapshot: async () => ({
      attempt: {
        instanceId,
        actorId: "fixture-admin",
        requestId: "fixture-original-request",
      },
      plan: { package: pkg },
      manifest: fixture.envelope.manifest,
    }),
  };
  // The actual Supervisor copies, hashes and unpacks the same downloaded bytes.
  // Its authority source is a narrow transport fixture; no role launch/SDK/Guest.
  const supervisor = await createCandidateSupervisor({
    root: installerRoot,
    instanceId,
    key,
    coordinator,
    controlEnv: {
      PLATFORM_CONTROL_RPC_KEY: "transport-control".padEnd(40, "-"),
    },
  });
  t.after(() => supervisor.close());
  const response = await fetch(supervisor.origin + "/publish", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-platform-internal-key": key,
    },
    body: JSON.stringify({ attemptId, fence: 7, kind: "api" }),
  });
  const published = await response.json();
  assert.equal(response.status, 200, JSON.stringify(published));
  assert.equal(published.packageDigest, pkg.digest);
  assert.equal(
    published.root,
    join(installerRoot, "artifacts", pkg.digest.slice(7)),
  );
  assert.deepEqual(await fileDigest(downloaded.path), {
    digest: pkg.digest,
    bytes: pkg.bytes,
  });
  await fs.writeFile(downloaded.path, "corrupt preseed must never be trusted", {
    mode: 0o600,
  });
  await assert.rejects(
    downloadVerified(pkg, installerRoot, { assertFence: async () => {} }),
    { code: "CACHED_PACKAGE_CORRUPT" },
  );
});
