import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { join } from "node:path";
import type {
  ImageSpecProvider,
  ImageSpecRegistry,
} from "../../api/packages/contracts/src/image-spec.contract";

/** A small external OCI registry, not a platform API replacement. Config/manifest
 * bytes and digests are real; production OCI parsing, Nest and SQLite stay intact. */
export async function startRuntimeImageRegistry(
  base: ImageSpecRegistry,
  apiRoot: string,
) {
  const port = Number(process.env.CONTRACT_REGISTRY_PORT ?? 3311);
  const host = `127.0.0.1:${port}`;
  const sha = (bytes: Buffer) =>
    `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const blobs = new Map<string, Buffer>();
  const manifests = new Map<string, Buffer>();
  const versions = new Map<string, string>();
  for (const [name, declaration] of [
    ["v1", { codex: "0.150.1", "claude-code": "2.1.251" }],
    ["v2", { codex: "0.160.0", "claude-code": "2.1.260" }],
    ["unknown", undefined],
    ["partial", { codex: "0.151.0", "claude-code": "v2.1.251" }],
    [
      "unsafe",
      { codex: "<img src=x onerror=alert(1)>", "claude-code": "latest" },
    ],
  ] as const) {
    const config = Buffer.from(
      JSON.stringify({
        architecture: "arm64",
        os: "linux",
        rootfs: {
          type: "layers",
          diff_ids: [`sha256:${"b".repeat(64)}`, sha(Buffer.from(name))],
        },
        config: {
          WorkingDir: "/workspace",
          Entrypoint: ["/bin/sh"],
          Labels: {
            "platform.tmux": "true",
            "platform.supportedRuntimes": "codex,claude-code",
            "platform.resourceDefaults": JSON.stringify({
              cores: 1,
              ramMb: 512,
              diskMb: 512,
            }),
            ...(declaration === undefined
              ? {}
              : { "platform.runtimeVersions": JSON.stringify(declaration) }),
          },
        },
      }),
    );
    const configDigest = sha(config);
    blobs.set(configDigest, config);
    const manifest = Buffer.from(
      JSON.stringify({
        schemaVersion: 2,
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        config: {
          mediaType: "application/vnd.oci.image.config.v1+json",
          digest: configDigest,
          size: config.length,
        },
        layers: [],
      }),
    );
    const digest = sha(manifest);
    manifests.set(digest, manifest);
    versions.set(name, digest);
  }
  let active = "v1";
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${host}`);
    if (url.pathname === "/fixtures/active" && request.method === "PUT") {
      const version = url.searchParams.get("version");
      if (version !== "v1" && version !== "v2") {
        response.writeHead(400).end();
        return;
      }
      active = version;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ active, digest: versions.get(active) }));
      return;
    }
    const match =
      /^\/v2\/(cli-agent|cli-unknown|cli-partial|cli-unsafe)\/(manifests|blobs)\/(.+)$/.exec(
        url.pathname,
      );
    if (request.method !== "GET" || match === null) {
      response.writeHead(404).end();
      return;
    }
    const [, repository, kind, reference] = match;
    if (reference === undefined) {
      response.writeHead(404).end();
      return;
    }
    const version =
      repository === "cli-agent" ? active : repository?.slice("cli-".length);
    const digest =
      kind === "manifests" && reference === "latest"
        ? versions.get(version ?? "")
        : reference;
    const bytes =
      digest === undefined
        ? undefined
        : (kind === "manifests" ? manifests : blobs).get(digest);
    if (bytes === undefined) {
      response.writeHead(404).end();
      return;
    }
    response.setHeader(
      "content-type",
      kind === "manifests"
        ? "application/vnd.oci.image.manifest.v1+json"
        : "application/vnd.oci.image.config.v1+json",
    );
    response.setHeader("docker-content-digest", sha(bytes));
    response.end(bytes);
  });
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", done);
  });
  const apiRequire = createRequire(join(apiRoot, "apps/api/package.json"));
  const { OciImageSpecProvider } = apiRequire(
    join(
      apiRoot,
      "packages/modules/image/dist/infrastructure/spec/oci-image-spec.provider.js",
    ),
  ) as {
    OciImageSpecProvider: new (
      clock: { now(): Date },
      runtimes: { list(): { id: string }[] },
    ) => ImageSpecProvider;
  };
  const oci = new OciImageSpecProvider(
    { now: () => new Date() },
    { list: () => [{ id: "codex" }, { id: "claude-code" }] },
  );
  const fallback = base.get(base.defaultProvider);
  const provider: ImageSpecProvider = {
    name: fallback.name,
    resolve: (ref) =>
      ref.startsWith(`${host}/`) ? oci.resolve(ref) : fallback.resolve(ref),
    validate: (manifest) =>
      manifest.name.startsWith(`${host}/`)
        ? oci.validate(manifest)
        : fallback.validate(manifest),
  };
  return {
    registry: {
      ...base,
      get: () => provider,
      list: () => [provider],
    } satisfies ImageSpecRegistry,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}
