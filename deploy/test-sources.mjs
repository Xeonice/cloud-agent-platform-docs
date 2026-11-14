import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { deploymentTestSources } from "./jenkins/deployment-test-sources.mjs";

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.slice(2).some((argument) => argument !== "--list"))
      throw new Error("Only --list is supported");
    const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const tests = await deploymentTestSources(source);
    if (process.argv.includes("--list")) process.stdout.write(JSON.stringify(tests) + "\n");
    else {
      const child = spawn(process.execPath, ["--test", ...tests], {
        cwd: source,
        stdio: "inherit",
        shell: false,
      });
      child.once("error", () => { process.exitCode = 1; });
      child.once("exit", (code) => { process.exitCode = code ?? 1; });
    }
  } catch (error) {
    process.stderr.write(error.message + "\n");
    process.exitCode = 1;
  }
}
