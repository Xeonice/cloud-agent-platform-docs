import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

// Docker receives only these public build inputs, never the repository tree.
const INPUTS = Object.freeze({
  controller: [
    "deploy/containers/controller.Dockerfile",
    "deploy/containers/plugins.mjs",
    "deploy/containers/controller-entrypoint.sh",
    "deploy/containers/init.groovy.d/10-container-guard.groovy",
    "deploy/jenkins/plugins.lock.json",
  ].map((path) => [path, path]),
  ci: [
    ["deploy/containers/ci.Dockerfile", "ci.Dockerfile"],
    ["deploy/containers/ci-tools/package.json", "ci-tools/package.json"],
    [
      "deploy/containers/ci-tools/package-lock.json",
      "ci-tools/package-lock.json",
    ],
    ["deploy/jenkins/ci-agent-entrypoint.mjs", "tools/ci-agent-entrypoint.mjs"],
    ...[
      "jenkins-ci.mjs",
      "project-ci.mjs",
      "jenkins-web.mjs",
      "mutation.mjs",
      "ci-platform.mjs",
      "deployment-platform.mjs",
    ].map((name) => [`deploy/jenkins/${name}`, `tools/${name}`]),
  ],
});

export function contextInputs(component) {
  if (!Object.hasOwn(INPUTS, component))
    throw new Error("Use controller or ci");
  return INPUTS[component].map(([source, target]) => ({ source, target }));
}

async function publicInput(root, relative) {
  const segments = relative.split("/");
  let path = root;
  for (const [index, segment] of segments.entries()) {
    path = join(path, segment);
    const stat = await fs.lstat(path);
    if (
      stat.isSymbolicLink() ||
      (index < segments.length - 1 && !stat.isDirectory())
    )
      throw new Error(`Build input is not a regular source path: ${relative}`);
  }
  const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size > 16 * 1024 * 1024
    )
      throw new Error(`Build input is not a bounded regular file: ${relative}`);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error(`Build input changed while being copied: ${relative}`);
    return bytes;
  } finally {
    await handle.close();
  }
}

export async function prepareContext(
  component,
  sourceRoot,
  temporary = tmpdir(),
) {
  const inputs = contextInputs(component);
  const root = await fs.realpath(sourceRoot);
  // Read all fixed inputs first; an incomplete source never produces a context.
  const files = [];
  for (const input of inputs)
    files.push({ ...input, bytes: await publicInput(root, input.source) });
  const context = await fs.mkdtemp(
    join(temporary, `agent-platform-${component}-context-`),
  );
  await fs.chmod(context, 0o700);
  try {
    const manifest = { schemaVersion: 1, component, files: [] };
    for (const { source, target, bytes } of files) {
      const path = join(context, target);
      await fs.mkdir(dirname(path), { recursive: true, mode: 0o755 });
      await fs.writeFile(path, bytes, { flag: "wx", mode: 0o644 });
      manifest.files.push({
        source,
        target,
        sizeBytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
    await fs.writeFile(
      join(context, "context-manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    return { context, manifest };
  } catch (error) {
    // Only the directory created by this invocation is removed.
    await fs.rm(context, { recursive: true, force: true });
    throw error;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  prepareContext(process.argv[2], sourceRoot).then(
    ({ context, manifest }) =>
      console.log(
        JSON.stringify({
          context,
          component: manifest.component,
          files: manifest.files.length,
        }),
      ),
    (error) => {
      console.error(error.message);
      process.exitCode = 1;
    },
  );
}
