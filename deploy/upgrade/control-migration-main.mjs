import {
  createControlMigrationRuntime,
  controlMigrationRuntimeStatus,
} from "./control-migration-runtime.mjs";
import { createRequire } from "node:module";
import * as fs from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { invariant, DIGEST } from "./trust.mjs";
import { secureDirectory } from "./io.mjs";
import { createPrivateControlRpc } from "./control-rpc.mjs";
import {
  planControlMigration,
  prepareControlMigration,
  controlMigrationStatus,
} from "./control-migration.mjs";
import { assertMigrationRunnerIdentity } from "./migration-identity-preflight.mjs";

async function privateJson(path) {
  const s = await fs.lstat(path);
  invariant(
    s.isFile() &&
      !s.isSymbolicLink() &&
      (s.mode & 0o077) === 0 &&
      s.size <= 262144,
    "CONTROL_MIGRATION_PRIVATE_INPUT_REQUIRED",
  );
  return JSON.parse(await fs.readFile(path, "utf8"));
}
export async function runControlMigrationCommand(command, configPath) {
  invariant(
    ["plan", "prepare", "status", "apply", "resume", "rollback"].includes(
      command,
    ),
    "CONTROL_MIGRATION_COMMAND_INVALID",
  );
  const c = await privateJson(resolve(configPath));
  const required = [
    "apiRoot",
    "businessPath",
    "exportPath",
    "controlPath",
    "accessPath",
    "instanceId",
    "migrationId",
    "epochFloor",
    "limits",
  ];
  const optional = [
    "sourceCoordinator",
    "sourceInstallationKeysPath",
    "sourceEnvironmentPath",
    "sourceEnvironmentMember",
    "sourceUpgradeSecretPath",
    "runtime",
  ];
  invariant(
    required.every((k) => Object.hasOwn(c, k)) &&
      Object.keys(c).every((k) => required.includes(k) || optional.includes(k)),
    "CONTROL_MIGRATION_CONFIG_INVALID",
  );
  if (c.runtime && !["plan", "status"].includes(command))
    await assertMigrationRunnerIdentity(c, { configPath: resolve(configPath) });
  const require = createRequire(join(c.apiRoot, "apps/api/package.json")),
    Database = require("better-sqlite3");
  if (command === "status")
    return c.runtime
      ? controlMigrationRuntimeStatus({ ...c, Database })
      : controlMigrationStatus({ ...c, Database });
  if (["apply", "resume", "rollback"].includes(command))
    invariant(c.runtime, "CONTROL_MIGRATION_RUNTIME_CONFIG_REQUIRED");
  if (command === "plan")
    return { ...planControlMigration({ ...c, Database }), runtimeImplemented: Boolean(c.runtime) };
  // Recovery uses the already durable original runtime/config identity. A stopped
  // WAL-mode business DB on a read-only mount cannot recreate its SHM sidecar.
  if (!(c.runtime && ["resume", "rollback"].includes(command)))
    planControlMigration({ ...c, Database });
  for (const path of [c.exportPath, c.controlPath, c.accessPath])
    await secureDirectory(dirname(path));
  const expected = c.sourceCoordinator;
  invariant(
    expected &&
      Object.keys(expected).sort().join(",") ===
        "artifactDigest,generation,metadataPath,origin,startIdentity" &&
      DIGEST.test(expected.artifactDigest) &&
      typeof expected.startIdentity === "string" &&
      expected.startIdentity.length >= 16 &&
      Number.isSafeInteger(expected.generation) &&
      expected.generation > 0 &&
      [
        "/internal/application/identity",
        "/internal/coordinator/identity",
      ].includes(expected.metadataPath),
    "CONTROL_MIGRATION_SOURCE_COORDINATOR_REQUIRED",
  );
  const readSourceCoordinator = async () => {
    const keys = await privateJson(c.sourceInstallationKeysPath),
      management = expected.metadataPath === "/internal/coordinator/identity";
    const rpc = createPrivateControlRpc({
      origin: expected.origin,
      instanceId: c.instanceId,
      // Source qualification uses only the legacy business identity capability.
      // keys.upgradeControl is reserved for the new independent Agent.
      key: management ? keys.controller : keys.control,
      maxBytes: 16384,
      timeoutMs: 2000,
    });
    const observedAt = new Date().toISOString(),
      actual = await rpc(expected.metadataPath);
    const generation = management
      ? actual.generation
      : actual.coordinatorGeneration;
    invariant(
      actual.instanceId === c.instanceId &&
        actual.role === "coordinator" &&
        actual.startIdentity === expected.startIdentity &&
        actual.artifactDigest === expected.artifactDigest &&
        generation === expected.generation &&
        actual.writerFenceValid === true,
      "CONTROL_MIGRATION_SOURCE_COORDINATOR_CHANGED",
    );
    return {
      instanceId: c.instanceId,
      artifactDigest: actual.artifactDigest,
      startIdentity: actual.startIdentity,
      generation,
      writerFenceValid: true,
      observedAt,
    };
  };
  const readAccessEnvironment = async () => {
    let env = c.sourceEnvironmentPath
      ? await privateJson(c.sourceEnvironmentPath)
      : {};
    if (c.sourceEnvironmentMember) {
      invariant(
        ["coordinatorEnv", "controlEnv"].includes(c.sourceEnvironmentMember),
        "CONTROL_MIGRATION_SOURCE_ENV_SCOPE_INVALID",
      );
      env = env[c.sourceEnvironmentMember];
    }
    invariant(
      env && typeof env === "object",
      "CONTROL_MIGRATION_AUTH_ENV_UNKNOWN",
    );
    let upgradeSecret = env.UPGRADE_SESSION_SECRET;
    if (!upgradeSecret) {
      const s = await fs.lstat(c.sourceUpgradeSecretPath);
      invariant(
        s.isFile() &&
          !s.isSymbolicLink() &&
          (s.mode & 0o077) === 0 &&
          s.size >= 32 &&
          s.size <= 4096,
        "CONTROL_MIGRATION_ORIGINAL_UPGRADE_SECRET_REQUIRED",
      );
      upgradeSecret = await fs.readFile(c.sourceUpgradeSecretPath);
    }
    const result = {
      UPGRADE_SESSION_SECRET_BASE64:
        Buffer.from(upgradeSecret).toString("base64"),
    };
    for (const k of [
      "ACCESS_PASSCODE",
      "PASSCODE_COOKIE_SECRET",
      "UPGRADE_LEGACY_AUTH_CONTINUITY_KEY",
      "UPGRADE_ADMIN_KEY",
    ])
      if (env[k] !== undefined) result[k] = env[k];
    return result;
  };
  if (c.runtime) {
    const runtime = await createControlMigrationRuntime(
      { ...c, readSourceCoordinator, readAccessEnvironment },
      { Database },
    );
    try {
      return await runtime[command]();
    } finally {
      try {
        runtime.close();
      } catch (error) {
        if (error.code === "CONTROL_MIGRATION_ACTION_STILL_RUNNING")
          runtime.closeWhenIdle().catch(() => {});
        else throw error;
      }
    }
  }
  return prepareControlMigration({
    ...c,
    Database,
    readSourceCoordinator,
    readAccessEnvironment,
  });
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  runControlMigrationCommand(process.argv[2], process.argv[3])
    .then((result) => process.stdout.write(JSON.stringify(result) + "\n"))
    .catch((error) => {
      // SQLite/HTTP messages may contain source values. Emit only a bounded code.
      const code =
        typeof error.code === "string" &&
        /^[A-Z][A-Z0-9_]{0,127}$/.test(error.code)
          ? error.code
          : "CONTROL_MIGRATION_FAILED";
      process.stderr.write(JSON.stringify({ error: { code } }) + "\n");
      process.exitCode = 1;
    });
}
