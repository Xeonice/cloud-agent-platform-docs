import { test, expect } from "@playwright/test";
import { API_ORIGIN, WEB_ORIGIN } from "../playwright.config";

// The ordinary fixture intentionally has no installed release or signed catalog.
// This scenario verifies access -> real status -> real UI, without inventing an
// installable release or exercising the external sandbox/model fixture.
test("instance access alone permits upgrades and reload never asks for another credential", async ({
  page,
  request,
  browser,
}) => {
  const original = await request.get(`${API_ORIGIN}/api/system/settings`);
  expect(original.status()).toBe(200);
  expect((await original.json()).accessPasscodeEnabled).toBe(false);
  const init = await request.get(`${API_ORIGIN}/api/system/init-status`);
  expect(init.status()).toBe(200);
  if (!(await init.json()).initialized) {
    expect(
      (
        await request.post(`${API_ORIGIN}/api/system/init`, { data: {} })
      ).status(),
    ).toBe(201);
  }

  const pageErrors: string[] = [];
  const requestFailures: string[] = [];
  const cancelledNavigations: string[] = [];
  const unexpectedResponses: string[] = [];
  const observedApiOrigins = new Set<string>();
  const upgradeMutations: string[] = [];
  let phase: "locked" | "authenticated" | "expired" = "locked";
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("requestfailed", (failed) => {
    const path = new URL(failed.url()).pathname;
    const observation = `${failed.method()} ${path}`;
    if (failed.failure()?.errorText === "net::ERR_ABORTED")
      cancelledNavigations.push(observation);
    else requestFailures.push(observation);
  });
  page.on("request", (observed) => {
    const url = new URL(observed.url());
    if (!url.pathname.startsWith("/api/")) return;
    observedApiOrigins.add(url.origin);
    if (
      url.pathname.startsWith("/api/system/upgrade/") &&
      observed.method() !== "GET"
    )
      upgradeMutations.push(`${observed.method()} ${url.pathname}`);
  });
  page.on("response", (response) => {
    const path = new URL(response.url()).pathname;
    if (!path.startsWith("/api/") || response.status() < 400) return;
    if (response.status() === 401 && phase !== "authenticated") return;
    unexpectedResponses.push(`${response.status()} ${path}`);
  });

  let enabled = false;
  let cleanupPasscode = "";
  try {
    const enable = await request.put(
      `${API_ORIGIN}/api/system/access-passcode`,
      { data: { action: "enable" } },
    );
    expect(enable.status()).toBe(200);
    enabled = true;
    const configured = await enable.json();
    if (typeof configured.passcode !== "string")
      throw new Error("The test instance did not issue its access passcode");
    cleanupPasscode = configured.passcode;
    expect(
      (
        await request.post(`${API_ORIGIN}/api/access/unlock`, {
          data: { passcode: cleanupPasscode },
        })
      ).status(),
    ).toBe(200);

    const anonymous = await browser.newContext();
    try {
      const denied = await anonymous.request.get(
        `${WEB_ORIGIN}/api/system/upgrade/status`,
      );
      expect(denied.status()).toBe(401);
      expect((await denied.json()).code).toBe("PASSCODE_REQUIRED");
    } finally {
      await anonymous.close();
    }

    await page.goto("/settings/system");
    const gate = page.getByRole("dialog", { name: "访问口令", exact: true });
    await expect(gate).toBeVisible();
    await gate.getByLabel("访问口令", { exact: true }).fill(cleanupPasscode);
    const unlocked = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/access/unlock" &&
        response.request().method() === "POST",
    );
    await gate.getByRole("button", { name: "解锁", exact: true }).click();
    expect((await unlocked).status()).toBe(200);
    await expect(gate).toHaveCount(0);
    phase = "authenticated";

    const version = page.locator("#version");
    await expect(
      version.getByRole("heading", { name: "版本与更新", exact: true }),
    ).toBeVisible();
    const status = await page.request.get("/api/system/upgrade/status");
    expect(status.status()).toBe(200);
    const snapshot = await status.json();
    expect(snapshot.capabilities).toMatchObject({
      canUpgradeInstance: true,
      canAuthenticate: false,
    });
    expect(snapshot.attempt).toBeNull();
    expect(snapshot.catalog.availableRelease).toBeNull();
    await expect(page.getByRole("button", { name: "授权升级" })).toHaveCount(0);
    await expect(page.getByText("授权本实例升级", { exact: true })).toHaveCount(
      0,
    );
    await expect(page.getByLabel("实例升级授权密钥")).toHaveCount(0);
    await expect(page.locator('input[type="password"]')).toHaveCount(0);
    // No catalog means no install command: the capability alone cannot invent a target.
    await expect(page.getByRole("button", { name: "立即升级" })).toHaveCount(0);
    const cookies = await page.context().cookies();
    expect(cookies.some((cookie) => cookie.name === "ap_session")).toBe(true);
    expect(cookies.some((cookie) => cookie.name === "ap_upgrade_grant")).toBe(
      false,
    );
    await page.screenshot({
      path: test.info().outputPath("instance-access-version-card.png"),
    });

    // This fixture has no installed release identity: the existing unknown-state
    // UI offers a read-only status check, rather than claiming an update target.
    const [checked] = await Promise.all([
      page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/api/system/upgrade/status",
        { timeout: 5_000 },
      ),
      version
        .getByRole("button", { name: "检查状态", exact: true })
        .click({ timeout: 5_000 }),
    ]);
    expect(checked.status()).toBe(200);
    await page.reload();
    await expect(
      version.getByRole("heading", { name: "版本与更新", exact: true }),
    ).toBeVisible();
    await expect(gate).toHaveCount(0);
    await expect(page.locator('input[type="password"]')).toHaveCount(0);
    const afterReload = await page.request.get("/api/system/upgrade/status");
    expect(afterReload.status()).toBe(200);
    const reloaded = await afterReload.json();
    expect(reloaded.capabilities).toMatchObject({
      canUpgradeInstance: true,
      canAuthenticate: false,
    });
    expect(reloaded.instanceId).toBe(snapshot.instanceId);
    expect(reloaded.userScope).toBe(snapshot.userScope);
    expect(reloaded.attempt).toBeNull();
    expect(upgradeMutations).toEqual([]);
    expect([...observedApiOrigins]).toEqual([WEB_ORIGIN]);

    // Rotate via the existing API administrator session; only that caller gets
    // a fresh cookie. The browser's old ordinary session must become invalid.
    phase = "expired";
    const rotation = await request.put(
      `${API_ORIGIN}/api/system/access-passcode`,
      { data: { action: "regenerate", invalidateSessions: true } },
    );
    expect(rotation.status()).toBe(200);
    const rotated = await rotation.json();
    if (typeof rotated.passcode !== "string")
      throw new Error("The test instance did not rotate its access passcode");
    cleanupPasscode = rotated.passcode;
    const expiredStatus = await page.request.get("/api/system/upgrade/status");
    expect(expiredStatus.status()).toBe(401);
    expect((await expiredStatus.json()).code).toBe("PASSCODE_REQUIRED");
    await page.reload();
    await expect(gate).toBeVisible();
    await expect(page.getByRole("button", { name: "授权升级" })).toHaveCount(0);
    expect(upgradeMutations).toEqual([]);
    expect(pageErrors).toEqual([]);
    expect(requestFailures).toEqual([]);
    expect(unexpectedResponses).toEqual([]);
    await test.info().attach("upgrade-access-browser-evidence", {
      contentType: "application/json",
      body: JSON.stringify({
        result: "passed",
        boundaries: ["Chromium", "Next same-origin proxy", "Nest", "SQLite"],
        capabilities: reloaded.capabilities,
        anonymousStatus: 401,
        expiredSessionStatus: expiredStatus.status(),
        additionalUpgradeCredentialPrompts: 0,
        upgradeMutations,
        pageErrors,
        requestFailures,
        cancelledNavigations,
        unexpectedResponses,
        limitation:
          "The fixture has no signed installable release; no installation or sandbox/model continuity is claimed.",
      }),
    });
  } finally {
    if (enabled) {
      // Only this scenario creates the stored passcode. Restore the fixture's
      // original disabled policy even if an assertion or browser navigation fails.
      const restored = await request.put(
        `${API_ORIGIN}/api/system/access-passcode`,
        {
          headers: { "X-Access-Passcode": cleanupPasscode },
          data: { action: "disable" },
        },
      );
      expect(restored.status()).toBe(200);
      expect((await restored.json()).enabled).toBe(false);
    }
  }
});
