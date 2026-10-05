import * as fs from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { SHA, ciEnvironment } from "./jenkins-ci.mjs";

const repositories = {
  project: "https://github.com/Xeonice/cloud-agent-platform-docs.git",
  api: "https://github.com/Xeonice/agent-platform-api.git",
  web: "https://github.com/Xeonice/agent-platform-web.git",
};
export async function projectCI(phase, rootSha, apiSha, webSha) {
  if (
    phase !== "head" &&
    ![rootSha, apiSha, webSha].every((sha) => SHA.test(sha ?? ""))
  )
    throw new Error("Every repository must be pinned to a full commit");
  if (
    process.platform !== "darwin" ||
    process.arch !== "arm64" ||
    process.versions.node.split(".")[0] !== "22" ||
    process.env.HOME !== "/Users/Shared/agent-platform-ci"
  )
    throw new Error("Project CI requires the isolated native Mac CI account");
  const workspace = resolve(process.cwd());
  const source = join(workspace, "source");
  const temporary = "/Users/Shared/agent-platform-ci/tmp";
  await fs.mkdir(temporary, { recursive: true, mode: 0o700 });
  const env = ciEnvironment(process.execPath, process.env.HOME, temporary);
  async function run(command, args, cwd = source, capture = false) {
    return new Promise((accept, reject) => {
      const child = spawn(command, args, {
        cwd,
        env,
        stdio: capture
          ? ["ignore", "pipe", "inherit"]
          : ["ignore", "inherit", "inherit"],
      });
      let output = "";
      child.stdout?.on("data", (chunk) => (output += chunk));
      child.once("error", reject);
      child.once("exit", (code, signal) =>
        code === 0
          ? accept(output.trim())
          : reject(
              new Error(
                `${command.split("/").at(-1)} failed (${signal ?? code})`,
              ),
            ),
      );
    });
  }
  const corepack = resolve(
    dirname(process.execPath),
    "../lib/node_modules/corepack/dist/corepack.js",
  );
  const pnpm = (directory, args) =>
    run(process.execPath, [corepack, "pnpm", ...args], join(source, directory));
  if (phase === "head") {
    // The daily main contract check follows its exact submodule gitlinks.
    const heads = await fs.mkdtemp(join(temporary, "contract-heads-"));
    try {
      await run("/usr/bin/git", ["init", "--bare", heads], workspace);
      await run(
        "/usr/bin/git",
        ["fetch", "--depth=1", repositories.project, "refs/heads/main"],
        heads,
      );
      const project = await run(
        "/usr/bin/git",
        ["rev-parse", "FETCH_HEAD"],
        heads,
        true,
      );
      const links = await run(
        "/usr/bin/git",
        ["ls-tree", project, "api", "web"],
        heads,
        true,
      );
      const commits = { project };
      for (const line of links.split("\n")) {
        const match = /^160000 commit ([a-f0-9]{40})\t(api|web)$/.exec(line);
        if (!match)
          throw new Error(
            "Main gitlink is not an immutable application commit",
          );
        commits[match[2]] = match[1];
      }
      if (
        ![commits.project, commits.api, commits.web].every((sha) =>
          SHA.test(sha ?? ""),
        )
      )
        throw new Error("Incomplete main contract commit set");
      console.log(JSON.stringify(commits));
      return;
    } finally {
      await fs.rm(heads, { recursive: true, force: true });
    }
  }
  if (phase === "checkout") {
    if ((await fs.lstat(source).catch(() => null))?.isSymbolicLink())
      throw new Error("Refusing symlink workspace");
    await fs.rm(source, { force: true, recursive: true });
    await fs.mkdir(source, { mode: 0o700 });
    for (const [name, sha] of [
      ["project", rootSha],
      ["api", apiSha],
      ["web", webSha],
    ]) {
      const path = name === "project" ? source : join(source, name);
      await fs.mkdir(path, { recursive: true, mode: 0o700 });
      await run("/usr/bin/git", ["init"], path);
      await run(
        "/usr/bin/git",
        ["fetch", "--depth=1", repositories[name], sha],
        path,
      );
      if (
        (await run("/usr/bin/git", ["rev-parse", "FETCH_HEAD"], path, true)) !==
        sha
      )
        throw new Error("Fetched commit mismatch");
      await run("/usr/bin/git", ["checkout", "--detach", sha], path);
    }
    await fs.writeFile(
      join(workspace, "commits.json"),
      JSON.stringify({ project: rootSha, api: apiSha, web: webSha }, null, 2) +
        "\n",
      { mode: 0o600 },
    );
    return;
  }
  for (const [directory, sha] of [
    ["", rootSha],
    ["api", apiSha],
    ["web", webSha],
  ])
    if (
      (await run(
        "/usr/bin/git",
        ["rev-parse", "HEAD"],
        join(source, directory),
        true,
      )) !== sha
    )
      throw new Error("Pinned repository changed");
  if (phase === "docs") {
    // Missing submodules are an error above. The cross-repository doc gates may not silently skip.
    await run(process.execPath, ["scripts/docs-check.mjs"]);
    const tests = [];
    for (const directory of ["deploy/macmini", "deploy/jenkins"]) {
      const files = await fs
        .readdir(join(source, directory), { withFileTypes: true })
        .catch((error) => {
          if (error.code === "ENOENT") return [];
          throw error;
        });
      for (const file of files)
        if (file.isFile() && file.name.endsWith(".test.mjs"))
          tests.push(join(directory, file.name));
    }
    // Historical main commits predate Jenkins. Run their actual test files;
    // current release commits contain the complete deployment regression suite.
    if (tests.length) await run(process.execPath, ["--test", ...tests.sort()]);
    return;
  }
  if (phase === "install") {
    for (const directory of ["api", "web", "e2e-contract"])
      await pnpm(directory, [
        "install",
        "--frozen-lockfile",
        "--store-dir",
        "/Users/Shared/agent-platform-ci/pnpm-store",
      ]);
    await pnpm("e2e-contract", ["exec", "playwright", "install", "chromium"]);
    return;
  }
  if (phase === "contract") {
    await pnpm("e2e-contract", ["test"]);
    return;
  }
  throw new Error("Unknown project CI phase");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  projectCI(...process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
