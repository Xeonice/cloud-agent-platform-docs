import * as fs from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
const digest = (bytes) =>
  "sha256:" + createHash("sha256").update(bytes).digest("hex");

// Tiny Docker-save archives with the actual Docker 29 OCI index/config split.
// These are schema fixtures, never runnable API images or deployment evidence.
export async function dockerSaveFixture(
  root,
  { oci = true, arch = "arm64", duplicateRuntime = false } = {},
) {
  const source = join(root, "docker-save-source");
  await fs.mkdir(join(source, "blobs/sha256"), { recursive: true });
  const put = async (object, mediaType) => {
    const bytes = JSON.stringify(object);
    const descriptor = {
      mediaType,
      digest: digest(bytes),
      size: Buffer.byteLength(bytes),
    };
    await fs.writeFile(
      join(source, "blobs/sha256", descriptor.digest.slice(7)),
      bytes,
    );
    return descriptor;
  };
  const config = await put(
    {
      architecture: arch,
      os: "linux",
      config: { Entrypoint: ["node", "app.js"] },
    },
    "application/vnd.oci.image.config.v1+json",
  );
  const layer = await put(
    { fixture: "opaque layer bytes" },
    "application/vnd.oci.image.layer.v1.tar",
  );
  const runtime = await put(
    {
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config,
      layers: [layer],
    },
    "application/vnd.oci.image.manifest.v1+json",
  );
  const selected = {
    ...runtime,
    platform: { architecture: arch, os: "linux" },
  };
  const index = await put(
    {
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.index.v1+json",
      manifests: duplicateRuntime ? [selected, selected] : [selected],
    },
    "application/vnd.oci.image.index.v1+json",
  );
  const configPath = oci
    ? "blobs/sha256/" + config.digest.slice(7)
    : config.digest.slice(7) + ".json";
  if (!oci)
    await fs.copyFile(
      join(source, "blobs/sha256", config.digest.slice(7)),
      join(source, configPath),
    );
  await fs.writeFile(
    join(source, "manifest.json"),
    JSON.stringify([
      {
        Config: configPath,
        RepoTags: ["agent-platform-api:fixture"],
        Layers: ["blobs/sha256/" + layer.digest.slice(7)],
      },
    ]),
  );
  if (oci) {
    await fs.writeFile(
      join(source, "oci-layout"),
      JSON.stringify({ imageLayoutVersion: "1.0.0" }),
    );
    await fs.writeFile(
      join(source, "index.json"),
      JSON.stringify({
        schemaVersion: 2,
        mediaType: "application/vnd.oci.image.index.v1+json",
        manifests: [index],
      }),
    );
  }
  const archive = join(root, "api-image.tar");
  const repack = async () => {
    await exec("/usr/bin/tar", [
      "-cf",
      archive,
      "-C",
      source,
      ...(await fs.readdir(source)),
    ]);
  };
  await repack();
  return {
    source,
    archive,
    repack,
    imageId: oci ? index.digest : config.digest,
    configDigest: config.digest,
    configPath,
    runtime,
    index,
    layer,
  };
}
