import { spawn } from "node:child_process";
import { join } from "node:path";
import * as fs from "node:fs/promises";
import { invariant, digest } from "../../deploy/upgrade/trust.mjs";
import { atomicJson } from "../../deploy/upgrade/io.mjs";

/** Executes the immutable production CLI, never an injected lifecycle adapter.
 * A deadline/unknown does not kill it or issue another mutation. The original
 * runner/journal/physical records remain for status/resume under the same ID. */
export async function runMigrationNativeCommand({
  artifactRoot,
  configPath,
  command,
  evidenceRoot,
}) {
  invariant(
    ["plan", "prepare", "apply", "status", "resume"].includes(command),
    "MIGRATION_NATIVE_COMMAND_FORBIDDEN",
  );
  const entry = join(artifactRoot, "installer/control-migration-main.mjs");
  invariant(
    (await fs.lstat(entry)).isFile(),
    "MIGRATION_NATIVE_IMMUTABLE_CLI_REQUIRED",
  );
  const intent = {
      command,
      configPath,
      entry,
      startedAt: new Date().toISOString(),
    },
    receiptPath = join(evidenceRoot, "cli-" + command + ".json");
  await atomicJson(receiptPath, { ...intent, state: "started" });
  return new Promise((ok, fail) => {
    const child = spawn(process.execPath, [entry, command, configPath], {
      cwd: join(artifactRoot, "installer"),
      env: {
        NODE_ENV: "production",
        PATH: process.env.PATH,
        PLATFORM_PROCESS_ROLE: "installation-admin",
      },
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    let out = "",
      err = "",
      bytes = 0,
      overflow = false;
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes <= 4 * 1024 * 1024) out += chunk;
      else overflow = true;
    });
    child.stderr.on("data", (chunk) => {
      if (err.length < 4096) err += chunk;
    });
    child.once("error", () =>
      fail(
        Object.assign(Error("Immutable migration CLI could not start"), {
          code: "MIGRATION_NATIVE_CLI_START_UNKNOWN",
        }),
      ),
    );
    child.once("exit", async (code, signal) => {
      try {
        invariant(
          !overflow && code === 0 && signal === null,
          "MIGRATION_NATIVE_CLI_FAILED",
        );
        const result = JSON.parse(out);
        await atomicJson(receiptPath, {
          ...intent,
          state: "completed",
          pid: child.pid,
          exitCode: code,
          stdoutDigest: digest(out),
          result,
          completedAt: new Date().toISOString(),
        });
        ok(result);
      } catch (error) {
        let productCode;
        try {
          productCode = JSON.parse(err).error?.code;
        } catch {}
        await atomicJson(receiptPath, {
          ...intent,
          state: "failed",
          pid: child.pid,
          exitCode: code,
          signal,
          stdoutDigest: digest(out),
          code: /^[A-Z0-9_]{1,128}$/.test(productCode ?? "")
            ? productCode
            : (error.code ?? "MIGRATION_NATIVE_CLI_FAILED"),
        });
        fail(
          Object.assign(Error("Actual immutable migration command failed"), {
            code: productCode ?? error.code ?? "MIGRATION_NATIVE_CLI_FAILED",
          }),
        );
      }
    });
  });
}
