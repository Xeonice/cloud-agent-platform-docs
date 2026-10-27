import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runControlMigrationCommand } from "../upgrade/control-migration-main.mjs";
export { runControlMigrationCommand };
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  runControlMigrationCommand(process.argv[2], process.argv[3])
    .then((result) => process.stdout.write(JSON.stringify(result) + "\n"))
    .catch((error) => {
      const code =
        typeof error.code === "string" &&
        /^[A-Z][A-Z0-9_]{0,127}$/.test(error.code)
          ? error.code
          : "CONTROL_MIGRATION_FAILED";
      process.stderr.write(JSON.stringify({ error: { code } }) + "\n");
      process.exitCode = 1;
    });
}
