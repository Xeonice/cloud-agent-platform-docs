import * as fs from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { pathToFileURL, fileURLToPath } from "node:url";
export async function prepareDeployContext(root, temporary = tmpdir()) {
  root = await fs.realpath(root);
  const inputs = [["deploy/containers/deploy.Dockerfile", "deploy.Dockerfile"]];
  for (const name of (await fs.readdir(join(root, "deploy/jenkins"))).sort())
    if (name.endsWith(".mjs") && !name.endsWith(".test.mjs"))
      inputs.push(["deploy/jenkins/" + name, "tools/" + name]);
  for (const name of [
    "api-container.mjs",
    "api-context.mjs",
    "deploy-agent-entrypoint.mjs",
  ])
    inputs.push(["deploy/containers/" + name, "tools/" + name]);
  for (const name of [
    "Dockerfile.api",
    "api-entrypoint.mjs",
    "api-cgroup.mjs",
    "boxlite-proof/prepare-runtime.py",
    "boxlite-proof/materialize-certs.py",
  ])
    inputs.push(["deploy/containers/" + name, "container-tools/" + name]);
  const records = [];
  for (const [source, target] of inputs) {
    let file = root;
    for (const part of source.split("/")) {
      file = join(file, part);
      if ((await fs.lstat(file)).isSymbolicLink())
        throw Error("Build input symlink");
    }
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size > 2_000_000)
      throw Error("Invalid public deployment tool");
    const bytes = await fs.readFile(file);
    records.push({ source, target, bytes });
  }
  const context = await fs.mkdtemp(
    join(temporary, "agent-platform-deploy-context-"),
  );
  await fs.chmod(context, 0o700);
  const manifest = {
    schemaVersion: 1,
    component: "trusted-linux-deploy",
    files: [],
  };
  for (const { source, target, bytes } of records) {
    await fs.mkdir(dirname(join(context, target)), { recursive: true });
    await fs.writeFile(join(context, target), bytes, { mode: 0o644 });
    manifest.files.push({
      source,
      target,
      sizeBytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  await fs.writeFile(
    join(context, "context-manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    { mode: 0o600 },
  );
  return { context, manifest };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  prepareDeployContext(
    resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
  ).then(
    (r) =>
      console.log(
        JSON.stringify({ context: r.context, files: r.manifest.files.length }),
      ),
    (e) => {
      console.error(e.message);
      process.exitCode = 1;
    },
  );
