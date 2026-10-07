import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { userInfo } from "node:os";
import { apiCiContext, REPOSITORY, SHA, validRef } from "./jenkins-ci.mjs";
import { buildSystem, ciChildEnvironment } from "./ci-platform.mjs";

export const MUTATION_BRANCH = "refs/heads/main";

export function mutableFiles(files) {
  return [...new Set(files)]
    .filter(
      (file) =>
        /^(?:packages\/.+\/src\/.+\.ts|apps\/api\/src\/.+\.ts)$/.test(file) &&
        !/(?:\.module\.ts|\.d\.ts|\/src\/index\.ts)$/.test(file) &&
        file !== "apps/api/src/main.ts" &&
        !file.includes("/drizzle/") &&
        !/[\n\r,]/.test(file) &&
        !file.split("/").some((part) => part === ".." || part === "."),
    )
    .sort();
}

export function mutationRequest(sha, ref, mode, baseSha = "", baseRef = "") {
  if (
    !SHA.test(sha ?? "") ||
    !validRef(ref) ||
    !["full", "changed"].includes(mode)
  )
    throw new Error("Invalid pinned mutation request");
  if (
    mode === "changed" &&
    (!SHA.test(baseSha) ||
      !validRef(baseRef) ||
      !baseRef.startsWith("refs/heads/"))
  )
    throw new Error(
      "Changed mutation needs the discovered base commit and branch",
    );
  return { sha, ref, mode, baseSha, baseRef };
}

async function execute(
  command,
  args,
  { cwd, env, timeout = 120 * 60_000, log } = {},
) {
  const handle = log ? await fs.open(log, "a", 0o600) : null;
  let writes = Promise.resolve();
  let writeError;
  try {
    return await new Promise((accept, reject) => {
      const child = spawn(command, args, {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
      let output = "";
      let failure = "failed";
      let lastOutput = "";
      let cancelled = false;
      let killTimer;
      const capture = (chunk) => {
        if (output.length < 4_000_000) output += chunk;
        lastOutput = (lastOutput + String(chunk)).slice(-1000);
        if (lastOutput.includes("No tests were executed"))
          failure = "no-unit-tests";
        if (handle) {
          writes = writes
            .then(() => handle.write(chunk))
            .catch((error) => {
              writeError ??= error;
            });
          process.stderr.write(chunk);
        }
      };
      child.stdout.on("data", capture);
      child.stderr.on("data", capture);
      const terminate = () => {
        cancelled = true;
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          /* Already stopped. */
        }
        killTimer ??= setTimeout(() => {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            /* Already stopped. */
          }
        }, 10_000);
      };
      const timer = setTimeout(terminate, timeout);
      process.once("SIGTERM", terminate);
      process.once("SIGINT", terminate);
      const cleanup = () => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        process.removeListener("SIGTERM", terminate);
        process.removeListener("SIGINT", terminate);
      };
      child.once("error", (error) => {
        cleanup();
        reject(error);
      });
      child.once("close", (code, signal) => {
        cleanup();
        if (code === 0 && !cancelled) accept(output.trim());
        else
          reject(
            Object.assign(
              new Error(
                `${command.split("/").at(-1)} failed (${signal ?? code})`,
              ),
              { classification: cancelled ? "cancelled" : failure },
            ),
          );
      });
    });
  } finally {
    try {
      await writes;
      if (writeError) throw writeError;
    } finally {
      await handle?.close();
    }
  }
}

export function mutationEnvironment(
  identity = userInfo(),
  system = buildSystem(),
) {
  const context = apiCiContext(identity, system);
  return {
    home: context.home,
    env: ciChildEnvironment(context.node, context),
  };
}

export async function mutationHead(ref = MUTATION_BRANCH, run = execute) {
  if (ref !== MUTATION_BRANCH)
    throw new Error(
      "Nightly mutation resolves only the fixed production branch",
    );
  const { home, env } = mutationEnvironment();
  const output = await run(
    "/usr/bin/git",
    ["ls-remote", "--exit-code", REPOSITORY, ref],
    { cwd: home, env, timeout: 60_000 },
  );
  const rows = output.split("\n").map((line) => line.split("\t"));
  if (rows.length !== 1 || !SHA.test(rows[0][0]) || rows[0][1] !== ref)
    throw new Error("Remote mutation head was not an exact commit");
  return { sha: rows[0][0], ref, repository: REPOSITORY };
}

// The CLI wrapper supplies the isolated workspace and clean environment. Keep
// the checkout/reporting core testable without changing the service identity.
export async function mutationForCheckout(
  request,
  source,
  workspace,
  env,
  run = execute,
) {
  const { sha, ref, mode, baseSha, baseRef } = mutationRequest(
    request.sha,
    request.ref,
    request.mode,
    request.baseSha,
    request.baseRef,
  );
  const git = (args) => run("/usr/bin/git", args, { cwd: source, env });
  if ((await git(["rev-parse", "HEAD"])) !== sha)
    throw new Error("Mutation checkout differs from requested SHA");
  let changed = [];
  if (mode === "changed") {
    const shallow = await git(["rev-parse", "--is-shallow-repository"]);
    await git([
      "fetch",
      ...(shallow === "true" ? ["--unshallow"] : []),
      REPOSITORY,
      ref,
      baseRef,
    ]);
    const base = await git(["merge-base", baseSha, sha]);
    if (!SHA.test(base))
      throw new Error("Changed mutation merge base is not a commit");
    changed = mutableFiles(
      (
        await git([
          "diff",
          "--name-only",
          "--diff-filter=ACMR",
          "-z",
          base,
          sha,
        ])
      )
        .split("\0")
        .filter(Boolean),
    );
  }
  const reportFolder = join(source, "reports/mutation");
  await fs.mkdir(reportFolder, { recursive: true });
  const label =
    mode === "full"
      ? "full"
      : `changed-${createHash("sha1").update(changed.join("\n")).digest("hex").slice(0, 8)}`;
  const report = join(reportFolder, `${label}.json`);
  const log = join(reportFolder, "jenkins-mutation.log");
  await Promise.all([
    fs.rm(report, { force: true }),
    fs.rm(join(reportFolder, `${label}.html`), { force: true }),
    fs.rm(log, { force: true }),
  ]);
  const result = {
    version: 1,
    sha,
    ref,
    mode,
    baseSha: baseSha || null,
    nonblocking: true,
    changedFiles: changed,
    report: `source/reports/mutation/${label}.json`,
    status: "ok",
    completedAt: null,
  };
  if (mode === "changed" && changed.length === 0) {
    result.status = "no-source-changes";
    result.report = null;
  } else {
    const corepack = resolve(
      dirname(process.execPath),
      "../lib/node_modules/corepack/dist/corepack.js",
    );
    try {
      await run(
        process.execPath,
        [
          corepack,
          "pnpm",
          "test:mutation",
          "--reporters",
          "json,html,clear-text",
        ],
        {
          cwd: source,
          env: {
            ...env,
            STRYKER_CONCURRENCY: "2",
            ...(mode === "changed"
              ? { STRYKER_MUTATE_FILES: changed.join("\n") }
              : {}),
          },
          timeout: mode === "full" ? 120 * 60_000 : 45 * 60_000,
          log,
        },
      );
      const parsed = JSON.parse(await fs.readFile(report, "utf8"));
      if (
        !parsed.files ||
        typeof parsed.files !== "object" ||
        Array.isArray(parsed.files)
      )
        throw new Error("Missing mutation report files");
    } catch (error) {
      result.status =
        error.classification === "no-unit-tests" ? "no-unit-tests" : "failed";
      result.report = null;
    }
  }
  result.completedAt = new Date().toISOString();
  await fs.writeFile(
    join(workspace, "mutation-result.json"),
    `${JSON.stringify(result, null, 2)}\n`,
    { mode: 0o600 },
  );
  return result;
}

export async function mutationRun(
  sha,
  ref,
  mode,
  baseSha = "",
  baseRef = "",
  workspace = process.cwd(),
) {
  const request = mutationRequest(sha, ref, mode, baseSha, baseRef);
  const { home, env } = mutationEnvironment();
  const source = await fs.realpath(join(resolve(workspace), "source"));
  if (!source.startsWith(`${home}/`))
    throw new Error("Mutation workspace escaped its CI home");
  return mutationForCheckout(request, source, resolve(workspace), env);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const args = process.argv.slice(2);
  (args[0] === "head" ? mutationHead(args[1]) : mutationRun(...args))
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(
        JSON.stringify({
          status: "failed",
          error: error.message,
          nonblocking: true,
        }),
      );
      process.exitCode = 1;
    });
}
