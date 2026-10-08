import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

export const CONTAINER_INPUTS = Object.freeze([
  "Dockerfile.api",
  "api-entrypoint.mjs",
  "api-cgroup.mjs",
  "boxlite-proof/prepare-runtime.py",
  "boxlite-proof/materialize-certs.py",
]);
export async function command(program, args, options = {}) {
  return new Promise((accept, reject) => {
    const child = spawn(program, args, {
      ...options,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "",
      overflow = false;
    child.stdout.on("data", (chunk) => {
      out += chunk;
      if (out.length > 16_000_000) {
        overflow = true;
        child.kill();
      }
    });
    child.stderr.resume();
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 && !overflow
        ? accept(out)
        : reject(new Error("Public source command failed")),
    );
  });
}
export function sourceAllowed(path) {
  if (
    !path ||
    isAbsolute(path) ||
    path.includes("\\") ||
    path.split("/").some((p) => !p || p === "." || p === "..")
  )
    return false;
  if (
    path
      .split("/")
      .some((p) =>
        [
          ".git",
          "node_modules",
          "dist",
          "data",
          "test-results",
          "coverage",
        ].includes(p),
      )
  )
    return false;
  if (
    path
      .split("/")
      .some(
        (p) =>
          p === ".env" ||
          (p.startsWith(".env.") && p !== ".env.example") ||
          /\.(?:key|pem|p12)$/.test(p),
      )
  )
    return false;
  return true;
}
async function tracked(root, expectedSha, paths = []) {
  const stat = await fs.lstat(root);
  if (!stat.isDirectory() || (await fs.realpath(root)) !== root)
    throw Error("Checkout must be a real directory");
  if (
    expectedSha &&
    (await command("git", ["rev-parse", "HEAD"], { cwd: root })).trim() !==
      expectedSha
  )
    throw Error("Pinned checkout mismatch");
  await command("git", ["diff", "--quiet", "HEAD", "--", ...paths], {
    cwd: root,
  });
  return (
    await command("git", ["ls-files", "--stage", "-z", "--", ...paths], {
      cwd: root,
    })
  )
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const match = /^(100644|100755) [a-f0-9]{40} 0\t(.+)$/s.exec(entry);
      if (!match)
        throw Error(
          "Tracked links, submodules and conflicted inputs are forbidden",
        );
      return match[2];
    });
}
async function copyRegular(source, target, root) {
  const rel = relative(root, source);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith("../"))
    throw Error("Source outside checkout");
  let path = root;
  for (const part of rel.split("/")) {
    path = join(path, part);
    if ((await fs.lstat(path)).isSymbolicLink())
      throw Error("Build input symlink");
  }
  const handle = await fs.open(
    source,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > 16_000_000)
      throw Error("Build input is not a bounded regular file");
    const bytes = await handle.readFile();
    const after = await handle.stat(),
      named = await fs.lstat(source);
    if (
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      after.size !== before.size ||
      named.ino !== before.ino ||
      named.dev !== before.dev
    )
      throw Error("Build source changed");
    await fs.mkdir(dirname(target), { recursive: true, mode: 0o755 });
    await fs.writeFile(target, bytes, {
      flag: "wx",
      mode: before.mode & 0o111 ? 0o755 : 0o644,
    });
    return createHash("sha256").update(bytes).digest("hex");
  } finally {
    await handle.close();
  }
}
/** Only fixed public image inputs are copied from the pinned root checkout. No checkout JS runs. */
export async function prepareApiContext(
  apiRoot,
  rootCheckout,
  temporary = tmpdir(),
  expected = {},
) {
  apiRoot = resolve(apiRoot);
  rootCheckout = resolve(rootCheckout);
  const names = await tracked(apiRoot, expected.sha),
    rootNames = await tracked(
      rootCheckout,
      expected.rootSha,
      CONTAINER_INPUTS.map((name) => "deploy/containers/" + name),
    );
  if (
    !names.includes("pnpm-lock.yaml") ||
    !names.includes("apps/api/src/main.ts")
  )
    throw Error("Incomplete API checkout");
  for (const name of CONTAINER_INPUTS)
    if (!rootNames.includes("deploy/containers/" + name))
      throw Error("Pinned root image input missing");
  const context = await fs.mkdtemp(
    join(temporary, "agent-platform-api-context-"),
  );
  await fs.chmod(context, 0o700);
  const manifest = {
    schemaVersion: 2,
    sha: expected.sha ?? null,
    rootSha: expected.rootSha ?? null,
    files: [],
  };
  try {
    for (const name of names) {
      if (!sourceAllowed(name))
        throw Error(`Forbidden tracked build input: ${name}`);
      const hash = await copyRegular(
        join(apiRoot, name),
        join(context, "api", name),
        apiRoot,
      );
      manifest.files.push({ path: "api/" + name, sha256: hash });
      if (
        name === "pnpm-lock.yaml" ||
        name === "pnpm-workspace.yaml" ||
        name === "package.json" ||
        name.endsWith("/package.json")
      ) {
        await copyRegular(
          join(apiRoot, name),
          join(context, "manifests", name),
          apiRoot,
        );
        manifest.files.push({ path: "manifests/" + name, sha256: hash });
      }
    }
    for (const name of CONTAINER_INPUTS) {
      const hash = await copyRegular(
        join(rootCheckout, "deploy/containers", name),
        join(context, name),
        rootCheckout,
      );
      manifest.files.push({ path: name, sha256: hash });
    }
    const migrations = manifest.files.filter((file) =>
      file.path.startsWith("api/drizzle/"),
    );
    if (!migrations.some((file) => file.path.endsWith(".sql")))
      throw Error("Missing immutable database migration inputs");
    manifest.schemaFingerprint = createHash("sha256")
      .update(
        JSON.stringify(migrations.sort((a, b) => a.path.localeCompare(b.path))),
      )
      .digest("hex");
    await fs.writeFile(
      join(context, "context-manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    return { context, manifest };
  } catch (error) {
    await fs.rm(context, { recursive: true, force: true });
    throw error;
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  prepareApiContext(process.argv[2], process.argv[3]).then(
    (r) =>
      console.log(
        JSON.stringify({ context: r.context, files: r.manifest.files.length }),
      ),
    (e) => {
      console.error(e.message);
      process.exitCode = 1;
    },
  );
}
