import { defineConfig } from "@playwright/test";
import base from "./upgrade.playwright.config";

export default defineConfig({
  ...base,
  testMatch: "independent-control-native.spec.mjs",
  reporter: [
    ["list"],
    [
      "json",
      {
        outputFile:
          process.env.INDEPENDENT_UPGRADE_PLAYWRIGHT_REPORT ??
          "artifacts/independent-upgrade/browser-results.json",
      },
    ],
  ],
});
