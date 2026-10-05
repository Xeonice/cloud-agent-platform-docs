import * as fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  join,
  relative,
  resolve,
  isAbsolute,
} from "node:path";
import { pathToFileURL } from "node:url";
import { buildEnvironment, readyManifest, SHA } from "../macmini/lib.mjs";

const ROOT_NAME = "agent-platform-api";
const COREPACK = resolve(
  dirname(process.execPath),
  "../lib/node_modules/corepack/dist/corepack.js",
);
const SAMPLE_ENV = `HOST=127.0.0.1
PORT=3101
DATA_ROOT=/absolute/path/to/new-agent-platform-data
DATABASE_URL=/absolute/path/to/new-agent-platform-data/platform.db
BOXLITE_HOME=/absolute/path/to/new-agent-platform-data/boxlite
API_ALLOWED_ORIGINS=http://localhost:3000
PASSCODE_COOKIE_SECURE=false
ACCESS_PASSCODE=
PASSCODE_COOKIE_SECRET=
ACCESS_PASSCODE_AUTO_GENERATE=false
ACCESS_PASSCODE_ALLOW_LOOPBACK=false
SANDBOX_DEFAULT_IMAGE=
`;
const START_SCRIPT = `import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
if (process.platform !== 'darwin' || process.arch !== 'arm64' || process.versions.node.split('.')[0] !== '22') throw new Error('Use native macOS ARM64 Node 22');
const release = JSON.parse(readFileSync(resolve(root, 'release.json'), 'utf8'));
process.env.NODE_ENV = 'production';
process.env.MIGRATIONS_DIR = resolve(root, 'drizzle');
process.env.APP_COMMIT = release.sha;
process.env.APP_VERSION = release.sha.slice(0, 12);
process.env.APP_BUILT_AT = release.builtAt;
process.chdir(root);
createRequire(import.meta.url)(resolve(root, 'application/dist/main.js'));
`;
const README = `# Agent Platform API — macOS ARM64

This archive includes the compiled API, production dependencies and database migrations. Install native macOS ARM64 Node 22; no pnpm install or build is needed after extraction. The host must support BoxLite virtualization to run tasks. Loading its SDK during packaging does not verify a virtual machine launch.

1. Copy .env.example to .env and set new absolute DATA_ROOT, DATABASE_URL and BOXLITE_HOME paths. Keep them outside this extracted release.
2. Set your own ACCESS_PASSCODE and PASSCODE_COOKIE_SECRET. Neither a production secret nor a user database is included.
3. Set API_ALLOWED_ORIGINS to your frontend origin and use PASSCODE_COOKIE_SECURE=true for HTTPS access. The sample is for local HTTP only.
4. From this directory run: node --env-file=.env bin/start.mjs

The first startup creates and migrates a fresh SQLite database. Startup applies the bundled migrations; do not point a new release at an existing installation until its schema changes and backup/recovery plan have been reviewed. This archive does not authorize a production data migration or restore a previous database.

The two built-in sandbox images are provider-specific; leave SANDBOX_DEFAULT_IMAGE empty to select the host default. Git credentials and AI credentials must be configured on the new installation. Preserve the external data directory when changing release directories.

release.json identifies the source commit, build platform, migration fingerprint and BoxLite SDK version. The package was extracted into a different directory and its SQLite native addon and BoxLite SDK were loaded there; this check does not start the API or a task.
`;

function inside(root, path) {
  const rel = relative(root, path);
  return (
    rel === "" ||
    (!rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
      rel !== ".." &&
      !isAbsolute(rel))
  );
}

async function command(executable, args, options = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(executable, args, {
      ...options,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolveResult(output)
        : reject(new Error(`${basename(executable)} exited ${code}`)),
    );
  });
}

async function copyTree(source, target) {
  const stat = await fs.lstat(source);
  if (stat.isSymbolicLink())
    throw new Error(`Build input must not be a symlink: ${source}`);
  if (stat.isDirectory()) {
    await fs.mkdir(target, { recursive: true });
    for (const entry of await fs.readdir(source))
      await copyTree(join(source, entry), join(target, entry));
  } else if (stat.isFile()) await fs.copyFile(source, target);
  else throw new Error(`Unsupported build input: ${source}`);
}

async function workspace(source, target) {
  await fs.mkdir(target, { recursive: true });
  for (const file of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"])
    await fs.copyFile(join(source, file), join(target, file));
  const folders = ["apps/api", "packages/contracts", "packages/shared-kernel"];
  for (const entry of await fs.readdir(join(source, "packages/modules"), {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory())
      throw new Error("Workspace modules must be ordinary directories");
    folders.push(`packages/modules/${entry.name}`);
  }
  for (const folder of folders) {
    const manifest = JSON.parse(
      await fs.readFile(join(source, folder, "package.json"), "utf8"),
    );
    const destination = join(target, folder);
    await fs.mkdir(destination, { recursive: true });
    await fs.writeFile(
      join(destination, "package.json"),
      `${JSON.stringify({ ...manifest, files: ["dist"], scripts: {} }, null, 2)}\n`,
    );
    await copyTree(join(source, folder, "dist"), join(destination, "dist"));
  }
  // The dependency graph and overrides stay lockfile-defined; source lifecycle hooks never run.
  const rootManifest = JSON.parse(
    await fs.readFile(join(target, "package.json"), "utf8"),
  );
  await fs.writeFile(
    join(target, "package.json"),
    `${JSON.stringify({ ...rootManifest, scripts: {} }, null, 2)}\n`,
  );
}

export async function inspectArchiveTree(root) {
  root = await fs.realpath(root);
  const natives = [];
  let files = 0;
  async function walk(folder) {
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (
        [
          ".git",
          ".env",
          ".npmrc",
          "runtime.env",
          "maintenance",
          "cloudflared.token",
          "jenkins-agent.secret",
        ].includes(entry.name) ||
        /\.(?:db|sqlite|sqlite3)(?:-wal|-shm)?$/.test(entry.name)
      )
        throw new Error(
          `Private state must not enter the archive: ${relative(root, path)}`,
        );
      const stat = await fs.lstat(path);
      if (stat.isSymbolicLink()) {
        const link = await fs.readlink(path);
        if (
          isAbsolute(link) ||
          !inside(root, resolve(dirname(path), link)) ||
          !inside(root, await fs.realpath(path))
        )
          throw new Error(
            `Archive symlink escapes its root: ${relative(root, path)}`,
          );
      } else if (stat.isDirectory()) await walk(path);
      else if (stat.isFile()) {
        files++;
        if (/\.(?:node|dylib)$/.test(entry.name)) natives.push(path);
      } else
        throw new Error(`Unsupported archive entry: ${relative(root, path)}`);
    }
  }
  await walk(root);
  return { files, natives };
}

// pnpm 9's hoisted self-reference points at the temporary workspace, while the
// selected package itself lives at application/. Rebind only that exact target.
export async function relocateSelfReferences(
  application,
  workspaceApplication,
) {
  const original = await fs.realpath(workspaceApplication);
  async function walk(folder) {
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isSymbolicLink()) {
        if ((await fs.realpath(path)) === original) {
          await fs.unlink(path);
          await fs.symlink(relative(dirname(path), application), path);
        }
      } else if (entry.isDirectory()) await walk(path);
    }
  }
  await walk(join(application, "node_modules"));
}

async function probeNative(application, run, env) {
  await run(
    process.execPath,
    [
      "-e",
      `const {createRequire}=require('node:module');const {pathToFileURL}=require('node:url');const r=createRequire(process.cwd()+'/package.json');const DB=r('better-sqlite3');const db=new DB(':memory:');db.prepare('select 1').get();db.close();const s=createRequire(r.resolve('@platform/sandbox'));import(pathToFileURL(s.resolve('@boxlite-ai/boxlite')).href).then(sdk=>{if(typeof sdk.JsBoxlite!=='function')throw new Error('BoxLite SDK unavailable');console.log('native-ok')})`,
    ],
    { cwd: application, env },
  );
}

export async function packageApi(
  sourcePath,
  outputPath,
  sha,
  { run = command } = {},
) {
  if (
    process.platform !== "darwin" ||
    process.arch !== "arm64" ||
    process.versions.node.split(".")[0] !== "22"
  )
    throw new Error("Package on native macOS ARM64 Node 22");
  if (!SHA.test(sha ?? "")) throw new Error("A full source SHA is required");
  const source = await fs.realpath(sourcePath);
  const output = resolve(outputPath);
  if ((await fs.lstat(sourcePath)).isSymbolicLink())
    throw new Error("Do not package current or another source symlink");
  const manifest = await readyManifest(source, sha);
  const deployRoot = dirname(dirname(source));
  const active = await fs
    .realpath(join(deployRoot, "current"))
    .catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
  if (active === source || inside(source, output))
    throw new Error(
      "Do not package an active release or write into its build tree",
    );
  for (const data of [
    manifest.dataRoot,
    dirname(manifest.databaseUrl),
    manifest.boxliteHome,
  ]) {
    if (
      !data ||
      !isAbsolute(data) ||
      inside(resolve(data), source) ||
      inside(resolve(data), output)
    )
      throw new Error("Package paths must be outside persistent data");
  }
  if (
    await fs.lstat(output).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    })
  )
    throw new Error("Refusing to overwrite an immutable package");
  const temporary = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), "agent-api-package-")),
  );
  const archive = join(temporary, "bundle", ROOT_NAME);
  const env = buildEnvironment(process.execPath);
  let pending;
  try {
    const pruned = join(temporary, "workspace");
    await workspace(source, pruned);
    const version = (
      await run(process.execPath, [COREPACK, "pnpm", "--version"], {
        cwd: pruned,
        env,
      })
    ).trim();
    if (version !== "9.12.0")
      throw new Error("Portable API packaging requires the pinned pnpm 9.12.0");
    await run(
      process.execPath,
      [
        COREPACK,
        "pnpm",
        "--filter",
        "@platform/api",
        "--prod",
        "--package-import-method=copy",
        "deploy",
        join(archive, "application"),
      ],
      { cwd: pruned, env },
    );
    await relocateSelfReferences(
      join(archive, "application"),
      join(pruned, "apps/api"),
    );
    await copyTree(join(source, "drizzle"), join(archive, "drizzle"));
    await fs.copyFile(
      join(source, "openapi.json"),
      join(archive, "openapi.json"),
    );
    const release = {
      version: 1,
      repository: "Xeonice/agent-platform-api",
      sha,
      builtAt: manifest.builtAt,
      packagedAt: new Date().toISOString(),
      platform: "darwin",
      arch: "arm64",
      nodeMajor: 22,
      schemaHash: manifest.schemaHash,
      boxliteVersion: manifest.boxliteVersion,
      runtime: "application/dist/main.js",
      migrations: "drizzle",
      dataPolicy:
        "External fresh data; existing databases require migration review",
    };
    await fs.writeFile(
      join(archive, "release.json"),
      `${JSON.stringify(release, null, 2)}\n`,
    );
    await fs.writeFile(join(archive, ".env.example"), SAMPLE_ENV);
    await fs.writeFile(join(archive, "README.md"), README);
    await fs.mkdir(join(archive, "bin"));
    await fs.writeFile(join(archive, "bin/start.mjs"), START_SCRIPT);
    const inspection = await inspectArchiveTree(archive);
    if (inspection.natives.length < 2)
      throw new Error(
        "Production native SQLite and BoxLite dependencies are missing",
      );
    for (const native of inspection.natives) {
      const type = await run("/usr/bin/file", ["-b", native], { env });
      if (!/Mach-O/.test(type) || !/arm64/.test(type))
        throw new Error(
          `Native dependency is not macOS ARM64: ${basename(native)}`,
        );
      const dependencies = await run("/usr/bin/otool", ["-L", native], { env });
      // A cdylib's LC_ID_DYLIB may retain an upstream build path. It names this
      // loaded object; only LC_LOAD_DYLIB references are external dependencies.
      const ownIds = (await run("/usr/bin/otool", ["-D", native], { env }))
        .split("\n")
        .slice(1)
        .map((line) => line.trim());
      for (const line of dependencies.split("\n").slice(1)) {
        const dependency = line.trim().split(" ")[0];
        if (
          dependency &&
          !ownIds.includes(dependency) &&
          !dependency.startsWith("@") &&
          !dependency.startsWith("/usr/lib/") &&
          !dependency.startsWith("/System/Library/")
        )
          throw new Error(
            `Native dependency is tied to a build-host library: ${basename(native)}`,
          );
      }
    }
    await fs.mkdir(dirname(output), { recursive: true });
    pending = `${output}.${randomUUID()}.partial`;
    await run(
      "/usr/bin/tar",
      ["-czf", pending, "-C", dirname(archive), ROOT_NAME],
      { env: { ...env, COPYFILE_DISABLE: "1" } },
    );
    const relocated = join(temporary, "relocated");
    await fs.mkdir(relocated);
    await run("/usr/bin/tar", ["-xzf", pending, "-C", relocated], { env });
    await inspectArchiveTree(join(relocated, ROOT_NAME));
    await probeNative(join(relocated, ROOT_NAME, "application"), run, env);
    await fs.link(pending, output);
    await fs.unlink(pending);
    pending = null;
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(output)) hash.update(chunk);
    return {
      state: "packaged",
      sha,
      artifact: output,
      sha256: hash.digest("hex"),
      sizeBytes: (await fs.stat(output)).size,
      files: inspection.files,
      nativeDependencies: inspection.natives.map((path) =>
        relative(archive, path),
      ),
      relocatedNativeProbe: "passed",
      boundary:
        "SQLite native addon and BoxLite SDK loaded; API and virtual machines were not started",
    };
  } finally {
    if (pending) await fs.rm(pending, { force: true });
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    console.log(
      JSON.stringify(
        await packageApi(process.argv[2], process.argv[3], process.argv[4]),
      ),
    );
  } catch (error) {
    console.error(JSON.stringify({ state: "error", error: error.message }));
    process.exitCode = 1;
  }
}
