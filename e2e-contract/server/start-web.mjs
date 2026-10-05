import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync, spawn } from "node:child_process";
const web = resolve(import.meta.dirname, "../../web");
const configPath = resolve(web, ".tsconfig.acceptance.json");
const config = JSON.parse(readFileSync(resolve(web, "tsconfig.json"), "utf8"));
config.include = config.include.filter((entry) => !entry.startsWith(".next"));
config.include.push(".next-acceptance/types/**/*.ts");
config.compilerOptions.tsBuildInfoFile =
  ".next-acceptance/acceptance.tsbuildinfo";
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
const env = { ...process.env, NEXT_TSCONFIG_PATH: ".tsconfig.acceptance.json" };
const build = spawnSync("pnpm", ["build"], { cwd: web, env, stdio: "inherit" });
if (build.error) throw build.error;
if (build.status !== 0) {
  rmSync(configPath, { force: true });
  process.exit(build.status ?? 1);
}
const child = spawn(
  "pnpm",
  ["start", "-H", "127.0.0.1", "-p", process.argv[2] ?? "3210"],
  { cwd: web, env, stdio: "inherit" },
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill(signal));
child.once("exit", (code) => {
  rmSync(configPath, { force: true });
  process.exit(code ?? 1);
});
child.once("error", (error) => {
  rmSync(configPath, { force: true });
  throw error;
});
