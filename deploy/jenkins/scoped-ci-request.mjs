import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createDiscoverer, scopedRequests } from "./jenkins-discover.mjs";
import {
  deploymentContext,
  assertDeploymentLayout,
} from "./deployment-platform.mjs";

export async function readPrivateJSON(path, maximum = 16_384) {
  const handle = await fs.open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.nlink !== 1 ||
      stat.size < 1 ||
      stat.size > maximum
    )
      throw new Error(
        "Scoped request must be a private owner-only regular file",
      );
    return JSON.parse(await handle.readFile("utf8"));
  } finally {
    await handle.close();
  }
}
export async function readScopedRequest(path) {
  return scopedRequests(await readPrivateJSON(path)).request;
}

export async function runScopedRequest(
  args = process.argv.slice(2),
  overrides = {},
) {
  // No layout, credentials, request file or network is touched without this flag.
  if (args[0] !== "--root-go") return { state: "held", actions: 0 };
  if (
    ![3, 5].includes(args.length) ||
    !["advance", "reconcile", "snapshot", "abort"].includes(args[2]) ||
    (args.length === 5 &&
      (args[3] !== "--expect-scope" || !/^[a-f0-9]{64}$/.test(args[4])))
  )
    throw new Error(
      "Use --root-go REQUEST.json advance|reconcile|snapshot|abort [--expect-scope SHA256]",
    );
  const context = (overrides.context ?? deploymentContext)();
  await (overrides.assertLayout ?? assertDeploymentLayout)(context);
  const requests = await readScopedRequest(resolve(args[1]));
  const scope = scopedRequests(requests);
  if (args.length === 5 && args[4] !== scope.key)
    throw new Error("Native request differs from the Root-frozen request");
  const abortPath = join(
    context.tools,
    "scoped-ci-aborted-" + scope.key + ".json",
  );
  if (args[2] === "abort") {
    await fs
      .writeFile(
        abortPath,
        JSON.stringify({
          scopeKey: scope.key,
          abortedAt: new Date().toISOString(),
        }) + "\n",
        {
          flag: "wx",
          mode: 0o600,
        },
      )
      .catch((error) => {
        if (error.code !== "EEXIST") throw error;
      });
    return { state: "scoped-dispatch-aborted", scopeKey: scope.key };
  }
  if (args[2] === "snapshot") {
    const state = await readPrivateJSON(
      join(context.tools, "discovery-state.json"),
      5_000_000,
    ).catch((error) => {
      if (error.code === "ENOENT") return {};
      throw error;
    });
    return {
      state: "scoped-readonly-snapshot",
      scopeKey: scope.key,
      record: state.scopedRequests?.[scope.key] ?? null,
      pending: (state.pending ?? []).filter(
        (item) => item.scopeKey === scope.key,
      ),
      pendingStatuses: (state.statuses ?? []).filter(
        (item) => item.scopeKey === scope.key,
      ).length,
    };
  }
  const lockPath = join(context.tools, "scoped-ci-request.lock");
  // The disabled global scheduler remains disabled. All manual invocations use
  // this shared exclusive lock; a stale lock requires an operator investigation.
  const lock = await fs.open(lockPath, "wx", 0o600);
  try {
    await lock.writeFile(
      JSON.stringify({ pid: process.pid, requestId: requests.requestId }) +
        "\n",
    );
    await lock.sync();
    return await (overrides.createDiscoverer ?? createDiscoverer)({
      requests,
      action: args[2],
      beforeQueue: async () => {
        try {
          await fs.lstat(abortPath);
        } catch (error) {
          if (error.code === "ENOENT") return;
          throw error;
        }
        throw new Error(
          "Root resource guard permanently aborted this scoped request",
        );
      },
    })();
  } finally {
    await lock.close();
    await fs.unlink(lockPath);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  runScopedRequest()
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      if (result.errors?.length) process.exitCode = 2;
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
