import * as fs from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { spawn } from "node:child_process";
import { userInfo } from "node:os";
import { pathToFileURL } from "node:url";
import { SHA } from "./jenkins-ci.mjs";
import {
  buildSystem,
  ciContext,
  ciChildEnvironment,
  browserVerificationScript,
} from "./ci-platform.mjs";

const repositories = {
  project: "https://github.com/Xeonice/cloud-agent-platform-docs.git",
  api: "https://github.com/Xeonice/agent-platform-api.git",
  web: "https://github.com/Xeonice/agent-platform-web.git",
};
export function projectCiContext(
  phase,
  identity = userInfo(),
  system = buildSystem(),
) {
  const context = ciContext(identity, system);
  return context;
}

export async function projectCI(phase, rootSha, apiSha, webSha, options = {}) {
  if (
    phase !== "head" &&
    ![rootSha, apiSha, webSha].every((sha) => SHA.test(sha ?? ""))
  )
    throw new Error("Every repository must be pinned to a full commit");
  const context = projectCiContext(
    phase,
    options.identity ?? userInfo(),
    options.system ?? buildSystem(),
  );
  const workspace = resolve(options.workspace ?? process.cwd());
  const source = join(workspace, "source");
  const home = options.home ?? context.home;
  const temporary = join(home, "tmp");
  await fs.mkdir(temporary, { recursive: true, mode: 0o700 });
  const env = ciChildEnvironment(context.node, {
    ...context,
    home,
    temporary,
    store: join(home, "pnpm-store"),
  });
  async function run(command, args, cwd = source, capture = false) {
    if (options.execute)
      return options.execute(command, args, cwd, env, capture);
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
    dirname(context.node),
    "../lib/node_modules/corepack/dist/corepack.js",
  );
  const pnpm = (directory, args) =>
    run(context.node, [corepack, "pnpm", ...args], join(source, directory));
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
    await run(context.node, ["scripts/docs-check.mjs"]);
    return;
  }
  if (phase === "deployment-tests") {
    const tests = [];
    for (const directory of [
      "deploy/macmini",
      "deploy/jenkins",
      "deploy/containers",
    ]) {
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
    if (!tests.length)
      throw new Error("Deployment regression sources are missing");
    await run(context.node, ["--test", ...tests.sort()]);
    return;
  }
  if (phase === "install") {
    for (const directory of ["api", "web", "e2e-contract"])
      await pnpm(directory, [
        "install",
        "--frozen-lockfile",
        "--store-dir",
        join(home, "pnpm-store"),
      ]);
    if (context.platform === "linux")
      await run(
        context.node,
        [
          "--input-type=module",
          "-e",
          browserVerificationScript(context.browsers),
        ],
        join(source, "e2e-contract"),
      );
    else
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
