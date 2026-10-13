import * as fs from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { atomicJson, fileDigest, readJson } from "./io.mjs";
import {
  canonical,
  digest,
  invariant,
  loadTrustRoot,
  runInputFingerprint,
  verifySignedManifest,
} from "./trust.mjs";

const REPOSITORY = "Xeonice/cloud-agent-platform-docs";
const EXPERIMENT_CHANNEL = /^experiment-[a-z0-9][a-z0-9._-]{0,150}$/;
const EXPERIMENT_TAG =
  /^v?\d+\.\d+\.\d+-experiment\.[a-z0-9][a-z0-9.-]{0,120}$/;
const INSTANCE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,180}$/;

// An explicit experimental publication domain. Production publishers and
// production trust roots continue to reject qualification artifacts.
export async function publishExperimentalDistribution({
  root,
  instanceId,
  token,
  repository = REPOSITORY,
  trustRootPath = join(resolve(root), "qualification-trust-root.json"),
  fetcher = fetch,
}) {
  invariant(
    repository === REPOSITORY && typeof token === "string" && token.length > 0,
    "EXPERIMENTAL_PUBLISHER_CREDENTIAL_REQUIRED",
  );
  invariant(INSTANCE.test(instanceId), "EXPERIMENTAL_INSTANCE_REQUIRED");
  root = resolve(root);
  const directory = await fs.lstat(root);
  invariant(
    directory.isDirectory() &&
      !directory.isSymbolicLink() &&
      (await fs.realpath(root)) === root &&
      !(directory.mode & 0o022),
    "INSECURE_EXPERIMENTAL_DIRECTORY",
  );
  const roots = await loadTrustRoot(trustRootPath);
  invariant(
    roots.purpose === "qualification" &&
      roots.qualificationInstanceId === instanceId,
    "EXPERIMENTAL_QUALIFICATION_TRUST_REQUIRED",
  );
  invariant(
    EXPERIMENT_CHANNEL.test(roots.channel),
    "EXPERIMENTAL_CHANNEL_REQUIRED",
  );
  const metadata = new Map();
  for (const name of [
    "qualification-catalog.json",
    "qualification-release.json",
    "qualification-trust-root.json",
  ]) {
    const bytes = await fs.readFile(join(root, name));
    metadata.set(name, {
      value: JSON.parse(bytes.toString()),
      claim: { digest: digest(bytes), bytes: bytes.length },
    });
  }
  const catalogue = metadata.get("qualification-catalog.json").value;
  invariant(
    catalogue.schemaVersion === 1 &&
      catalogue.channel === roots.channel &&
      catalogue.releases?.length === 1,
    "EXPERIMENTAL_CATALOG_REQUIRED",
  );
  const record = catalogue.releases[0];
  const { manifest, manifestDigest } = verifySignedManifest(
    record.envelope,
    roots,
  );
  invariant(
    manifest.purpose === "qualification" &&
      manifest.qualification.instanceId === instanceId &&
      manifest.qualification.inputFingerprint ===
        runInputFingerprint(manifest) &&
      manifest.runInputFingerprint === runInputFingerprint(manifest),
    "EXPERIMENTAL_INSTANCE_BINDING_INVALID",
  );
  invariant(
    EXPERIMENT_TAG.test(manifest.releaseId) &&
      record.releaseId === manifest.releaseId &&
      record.manifestDigest === manifestDigest,
    "EXPERIMENTAL_RELEASE_REQUIRED",
  );
  invariant(
    canonical(metadata.get("qualification-release.json").value) ===
      canonical(record.envelope),
    "EXPERIMENTAL_SIGNED_RELEASE_CHANGED",
  );
  invariant(
    canonical(metadata.get("qualification-trust-root.json").value) ===
      canonical(roots),
    "EXPERIMENTAL_TRUST_ROOT_CHANGED",
  );
  const expected = new Map(
    [...metadata].map(([name, value]) => [name, value.claim]),
  );
  for (const pkg of manifest.packages) {
    invariant(
      basename(pkg.name) === pkg.name && !expected.has(pkg.name),
      "INVALID_EXPERIMENTAL_ASSET_NAME",
    );
    const url = new URL(pkg.url);
    invariant(
      url.href ===
        `https://github.com/${REPOSITORY}/releases/download/${manifest.releaseId}/${pkg.name}`,
      "EXPERIMENTAL_PACKAGE_URL_REQUIRED",
    );
    expected.set(pkg.name, { digest: pkg.digest, bytes: pkg.bytes });
  }
  // Preserve original gate files and their honest result, including not-run.
  for (const evidence of manifest.evidence) {
    const name =
      evidence.kind === "semantic-contract"
        ? "qualification-semantic-contract-" +
          evidence.contractPlanDigest.slice(7) +
          ".json"
        : "qualification-" + evidence.kind + ".json";
    invariant(
      /^qualification-[a-z0-9-]+\.json$/.test(name) && !expected.has(name),
      "INVALID_EXPERIMENTAL_EVIDENCE_ASSET",
    );
    const report = await readJson(join(root, name));
    invariant(
      report.result === evidence.result &&
        report.kind === evidence.kind &&
        report.inputFingerprint === evidence.inputFingerprint &&
        report.runId === evidence.runId,
      "EXPERIMENTAL_EVIDENCE_CHANGED",
    );
    expected.set(name, { digest: evidence.reportDigest });
  }
  const local = {};
  for (const [name, claim] of expected) {
    const stat = await fs.lstat(join(root, name));
    invariant(
      stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1,
      "EXPERIMENTAL_ASSET_NOT_REGULAR",
    );
    const actual = await fileDigest(join(root, name));
    invariant(
      !claim ||
        (actual.digest === claim.digest &&
          (claim.bytes === undefined || actual.bytes === claim.bytes)),
      "EXPERIMENTAL_LOCAL_ASSET_CHANGED",
    );
    local[name] = actual;
  }
  async function api(path, { method = "GET", body, raw } = {}) {
    const url = path.startsWith("https://")
      ? path
      : `https://api.github.com/repos/${REPOSITORY}/${path}`;
    const parsed = new URL(url);
    invariant(
      !parsed.username &&
        !parsed.password &&
        !parsed.hash &&
        ((parsed.origin === "https://api.github.com" &&
          parsed.pathname.startsWith("/repos/" + REPOSITORY + "/")) ||
          (parsed.origin === "https://uploads.github.com" &&
            /^\/repos\/Xeonice\/cloud-agent-platform-docs\/releases\/\d+\/assets$/.test(
              parsed.pathname,
            ))),
      "EXPERIMENTAL_REMOTE_ORIGIN_INVALID",
    );
    const response = await fetcher(url, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: "Bearer " + token,
        "x-github-api-version": "2022-11-28",
        "content-type": raw ? "application/octet-stream" : "application/json",
      },
      body: raw ?? (body ? JSON.stringify(body) : undefined),
      signal: AbortSignal.timeout(120_000),
      redirect: "error",
    });
    if (response.status === 404 && method === "GET") return null;
    invariant(response.ok, "EXPERIMENTAL_PUBLICATION_FAILED");
    return response.status === 204 ? {} : response.json();
  }
  const releaseId = manifest.releaseId,
    projectRevision = manifest.commits.project;
  async function verifyTag({ required = false } = {}) {
    const reference = await api(
      "git/ref/tags/" + encodeURIComponent(releaseId),
    );
    if (!reference) {
      invariant(!required, "EXPERIMENTAL_REMOTE_TAG_UNCONFIRMED");
      return;
    }
    let object = reference.object;
    for (let depth = 0; object?.type === "tag" && depth < 4; depth++) {
      invariant(
        /^[a-f0-9]{40}$/.test(object.sha),
        "EXPERIMENTAL_REMOTE_TAG_CONFLICT",
      );
      object = (await api("git/tags/" + object.sha))?.object;
    }
    invariant(
      object?.type === "commit" && object.sha === projectRevision,
      "EXPERIMENTAL_REMOTE_TAG_CONFLICT",
    );
  }
  await verifyTag();
  let release = await api("releases/tags/" + encodeURIComponent(releaseId));
  if (!release)
    release = await api("releases", {
      method: "POST",
      body: {
        tag_name: releaseId,
        target_commitish: projectRevision,
        name: releaseId,
        draft: true,
        prerelease: true,
        make_latest: "false",
        body: `Experimental qualification artifacts for isolated instance ${instanceId}. Upgrade qualification is incomplete. Publication does not deploy or upgrade any instance.`,
      },
    });
  invariant(
    Number.isSafeInteger(release.id) &&
      release.id > 0 &&
      release.tag_name === releaseId &&
      release.target_commitish === projectRevision &&
      release.prerelease === true,
    "EXPERIMENTAL_REMOTE_RELEASE_CONFLICT",
  );
  const existing = await api("releases/" + release.id + "/assets?per_page=100");
  invariant(
    Array.isArray(existing) &&
      existing.length < 100 &&
      new Set(existing.map((asset) => asset.name)).size === existing.length &&
      existing.every((asset) => expected.has(asset.name)),
    "EXPERIMENTAL_REMOTE_ASSET_CONFLICT",
  );
  // Check every existing conflict before uploading any missing asset.
  for (const prior of existing)
    invariant(
      prior.size === local[prior.name].bytes &&
        prior.digest === local[prior.name].digest,
      "IMMUTABLE_EXPERIMENTAL_ASSET_CONFLICT",
    );
  for (const [name, actual] of Object.entries(local)) {
    const prior = existing.find((asset) => asset.name === name);
    if (prior) {
      invariant(
        prior.size === actual.bytes && prior.digest === actual.digest,
        "IMMUTABLE_EXPERIMENTAL_ASSET_CONFLICT",
      );
      continue;
    }
    invariant(release.draft === true, "PUBLISHED_EXPERIMENT_IS_IMMUTABLE");
    const bytes = await fs.readFile(join(root, name));
    invariant(
      bytes.length === actual.bytes && digest(bytes) === actual.digest,
      "EXPERIMENTAL_LOCAL_ASSET_CHANGED",
    );
    const uploaded = await api(
      release.upload_url.replace(/\{.*$/, "") +
        "?name=" +
        encodeURIComponent(name),
      { method: "POST", raw: bytes },
    );
    invariant(
      uploaded.name === name &&
        uploaded.size === actual.bytes &&
        uploaded.digest === actual.digest,
      "EXPERIMENTAL_REMOTE_DIGEST_UNCONFIRMED",
    );
  }
  for (const [name, actual] of Object.entries(local)) {
    const current = await fileDigest(join(root, name));
    invariant(
      current.digest === actual.digest && current.bytes === actual.bytes,
      "EXPERIMENTAL_LOCAL_ASSET_CHANGED",
    );
  }
  if (release.draft)
    release = await api("releases/" + release.id, {
      method: "PATCH",
      body: { draft: false, prerelease: true, make_latest: "false" },
    });
  invariant(
    release.draft === false &&
      release.prerelease === true &&
      release.tag_name === releaseId &&
      release.target_commitish === projectRevision,
    "EXPERIMENTAL_PUBLICATION_UNCONFIRMED",
  );
  await verifyTag({ required: true });
  const proof = {
    state: "experiment-published",
    purpose: "qualification",
    releaseId,
    releaseIdRemote: release.id,
    instanceId,
    channel: manifest.channel,
    manifestDigest,
    publishedAt: release.published_at,
    assets: local,
    upgradeQualified: false,
    experimentPublished: true,
    instanceDeployment: false,
  };
  await atomicJson(
    join(root, "experimental-distribution-published.json"),
    proof,
  );
  return proof;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  publishExperimentalDistribution({
    root: resolve(process.argv[2]),
    instanceId: process.argv[3],
    token: process.env.GITHUB_TOKEN,
  }).then(
    (proof) => process.stdout.write(JSON.stringify(proof) + "\n"),
    (error) => {
      process.stderr.write(
        (error.code || "EXPERIMENTAL_PUBLICATION_FAILED") + "\n",
      );
      process.exitCode = 1;
    },
  );
}
