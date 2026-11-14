import { defineConfig } from "@playwright/test";
import base from "./upgrade.playwright.config";
export default defineConfig({
  ...base,
  testMatch: "migration-control-native.spec.mjs",
  reporter: [
    ["list"],
    [
      "json",
      {
        outputFile:
          process.env.MIGRATION_UPGRADE_PLAYWRIGHT_REPORT ??
          "artifacts/migration-upgrade/browser-results.json",
      },
    ],
  ],
});
