import { defineConfig, devices } from "@playwright/test";

// This suite starts only fresh production-role installations. It never reuses
// the generic contract fixture or intercepts application/network responses.
export default defineConfig({
  testDir: "./acceptance",
  testMatch: "upgrade-*.spec.mjs",
  globalSetup: "./global-setup.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 1_800_000,
  reporter: [
    ["list"],
    [
      "json",
      {
        outputFile:
          process.env.UPGRADE_PLAYWRIGHT_REPORT ??
          "artifacts/upgrade/browser-results.json",
      },
    ],
  ],
  // Authorization uses synthetic but still confidential installation material.
  // Full HAR/trace would persist it, so only selected redacted evidence is saved.
  use: { trace: "off", screenshot: "off", video: "off" },
  projects: [
    { name: "upgrade-chromium", use: { ...devices["Desktop Chrome"] } },
  ],
});
