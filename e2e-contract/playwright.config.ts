import { defineConfig, devices } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const apiPort = process.env.CONTRACT_API_PORT ?? "3110";
const webPort = process.env.CONTRACT_WEB_PORT ?? "3210";
export const API_ORIGIN = `http://127.0.0.1:${apiPort}`;
export const WEB_ORIGIN = `http://127.0.0.1:${webPort}`;
export default defineConfig({
  testDir: "./acceptance",
  globalSetup: "./global-setup.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [
    ["list"],
    ["json", { outputFile: "artifacts/acceptance-results.json" }],
    ["./acceptance/execution-reporter.ts"],
  ],
  timeout: 90_000,
  use: { baseURL: WEB_ORIGIN, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "pnpm --dir ../api build && pnpm api",
      cwd: here,
      url: `${API_ORIGIN}/api/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "pipe",
      stderr: "pipe",
      env: { CONTRACT_API_PORT: apiPort },
    },
    {
      command: `node ../e2e-contract/server/start-web.mjs ${webPort}`,
      cwd: resolve(root, "web"),
      url: WEB_ORIGIN,
      reuseExistingServer: false,
      timeout: 300_000,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        API_ORIGIN,
        NEXT_PUBLIC_API_BASE_URL: "",
        NEXT_PUBLIC_WS_BASE_URL: "",
        NEXT_DIST_DIR: ".next-acceptance",
        PORT: webPort,
      },
    },
  ],
});
