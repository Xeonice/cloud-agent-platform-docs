import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { networkInterfaces, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { API_ORIGIN, WEB_ORIGIN } from "../playwright.config";

async function initializeIfNeeded(request: APIRequestContext) {
  const status = await request.get(`${API_ORIGIN}/api/system/init-status`);
  expect(status.status()).toBe(200);
  if (!(await status.json()).initialized) {
    const init = await request.post(`${API_ORIGIN}/api/system/init`, {
      data: {},
    });
    expect(init.status()).toBe(201);
  }
}

/** Real Git HTTP bytes; clone, local refs and workspace checkout stay production. */
async function gitRemote() {
  const directory = await mkdtemp(join(tmpdir(), "contract-search-git-"));
  const working = join(directory, "working");
  const bare = join(directory, "repository.git");
  await mkdir(working);
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: working,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
      stdio: "pipe",
    });
  git("init", "-b", "main");
  await writeFile(join(working, "README.md"), "Searchable branch fixture\n");
  git("add", "README.md");
  git(
    "-c",
    "user.name=Contract fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-m",
    "initial",
  );
  git("branch", "feature/alias-search");
  git("branch", "feature/other-work");
  git("clone", "--bare", working, bare);
  git("--git-dir", bare, "update-server-info");

  // The production SSRF policy rejects loopback. Use the same LAN-only fixture
  // boundary as API PRJ protocol tests rather than weakening the clone policy.
  const address = Object.values(networkInterfaces())
    .flat()
    .find((entry) => entry?.family === "IPv4" && !entry.internal)?.address;
  if (address === undefined) {
    await rm(directory, { recursive: true, force: true });
    throw new Error(
      "A non-loopback IPv4 interface is required for the real Git fixture",
    );
  }
  const server = createServer((request, response) => {
    const pathname = decodeURIComponent(
      new URL(request.url ?? "/", "http://fixture").pathname,
    );
    const path = resolve(directory, `.${pathname}`);
    if (!path.startsWith(`${bare}${sep}`)) {
      response.writeHead(404).end();
      return;
    }
    void readFile(path).then(
      (contents) => {
        response.setHeader("Content-Type", "application/octet-stream");
        response.end(contents);
      },
      () => response.writeHead(404).end(),
    );
  });
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(0, address, done);
  });
  const bound = server.address();
  if (bound === null || typeof bound === "string")
    throw new Error("No Git fixture address");
  return {
    url: `http://${address}:${bound.port}/repository.git`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((done, reject) =>
        server.close((error) => (error ? reject(error) : done())),
      );
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function searchAndSelect(
  page: Page,
  label: "项目" | "分支" | "镜像",
  query: string,
  option: string,
) {
  const kind = { 项目: "project", 分支: "branch", 镜像: "image" }[label];
  if (kind === undefined) throw new Error(`Unknown search selector ${label}`);
  await page.locator(`#sandbox-${kind}`).click();
  const search = page.getByRole("combobox", {
    name: `搜索${label}`,
    exact: true,
  });
  await search.fill(query);
  const escaped = option.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  await page
    .getByRole("option", { name: new RegExp(`^${escaped}(?:\\s|$)`) })
    .click();
}

test("saved alias survives reload and searchable project, branch and image keep real task identities", async ({
  page,
  request,
}) => {
  const browserErrors: string[] = [];
  const apiRequests: string[] = [];
  const failedResponses: string[] = [];
  function observeBrowser(browserPage: Page) {
    browserPage.on("pageerror", (error) => browserErrors.push(error.message));
    browserPage.on("request", (request) => {
      if (new URL(request.url()).pathname.startsWith("/api/"))
        apiRequests.push(request.url());
    });
    browserPage.on("response", (response) => {
      if (
        new URL(response.url()).pathname.startsWith("/api/") &&
        response.status() >= 400
      )
        failedResponses.push(`${response.status()} ${response.url()}`);
    });
  }
  observeBrowser(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await initializeIfNeeded(request);
  expect(
    (
      await request.post(
        `${API_ORIGIN}/api/runtimes/codex/credentials/secret`,
        {
          data: { method: "api-key", secret: `sk-${"b".repeat(48)}` },
        },
      )
    ).status(),
  ).toBe(200);

  const imageRef = "ghcr.io/contract/search-agent:v1.0";
  const registration = await request.post(`${API_ORIGIN}/api/images`, {
    data: { ref: imageRef },
  });
  expect(registration.status()).toBe(201);
  const image = (await registration.json()).manifest;
  expect(image.imageAlias).toBeNull();
  const remote = await gitRemote();
  try {
    const decoy = await request.post(`${API_ORIGIN}/api/projects`, {
      data: { name: "contract unrelated project", sourceType: "empty" },
    });
    expect(decoy.status()).toBe(202);
    const unavailable = await request.post(`${API_ORIGIN}/api/projects`, {
      data: {
        name: "contract unavailable project",
        sourceType: "git",
        repoUrl: remote.url.replace("repository.git", "missing.git"),
      },
    });
    expect(unavailable.status()).toBe(202);
    const unavailableProject = await unavailable.json();
    await expect
      .poll(
        async () =>
          (
            await (
              await request.get(
                `${API_ORIGIN}/api/projects/${unavailableProject.id}`,
              )
            ).json()
          ).cloneStatus,
      )
      .toBe("failed");
    const created = await request.post(`${API_ORIGIN}/api/projects`, {
      data: {
        name: "contract searchable project",
        sourceType: "git",
        repoUrl: remote.url,
      },
    });
    expect(created.status()).toBe(202);
    const project = await created.json();
    await expect
      .poll(
        async () =>
          (
            await (
              await request.get(`${API_ORIGIN}/api/projects/${project.id}`)
            ).json()
          ).cloneStatus,
      )
      .toBe("ready");
    const branches = await request.get(
      `${API_ORIGIN}/api/projects/${project.id}/branches`,
    );
    expect(await branches.json()).toEqual([
      "feature/alias-search",
      "feature/other-work",
      "main",
    ]);

    await page.goto("/settings/images");
    const card = page.getByTestId("image-card").filter({ hasText: imageRef });
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: "编辑别名", exact: true }).click();
    await card.getByLabel("镜像别名", { exact: true }).fill("  研发 🚀  ");
    await page.screenshot({
      path: test.info().outputPath("image-alias-editor-1440-dark.png"),
    });
    const save = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/images/${image.id}`) &&
        response.request().method() === "PATCH",
    );
    await card.getByRole("button", { name: "保存别名", exact: true }).click();
    const saved = await save;
    expect(saved.status()).toBe(200);
    expect(saved.request().postDataJSON()).toEqual({ alias: "研发 🚀" });
    expect((await saved.json()).imageAlias).toBe("研发 🚀");
    await expect(card.getByRole("heading", { name: /研发 🚀/ })).toBeVisible();
    await expect(card).toContainText(imageRef);
    await page.reload();
    await expect(card.getByRole("heading", { name: /研发 🚀/ })).toBeVisible();
    const persisted = (
      await (await request.get(`${API_ORIGIN}/api/images`)).json()
    ).find((row: { id: string }) => row.id === image.id);
    expect(persisted).toMatchObject({
      imageAlias: "研发 🚀",
      ref: imageRef,
      digest: image.digest,
      imageId: image.imageId,
    });
    await page
      .getByRole("searchbox", { name: "搜索镜像", exact: true })
      .fill("研发");
    await expect(page.getByTestId("image-card")).toHaveCount(1);

    await page.goto("/");
    await page.getByRole("button", { name: "新任务", exact: true }).click();
    const launch = page.getByTestId("modal-new-task");
    await expect(launch).toBeVisible();
    const projectTrigger = page.locator("#sandbox-project");
    await projectTrigger.click();
    const projectSearch = page.getByRole("combobox", {
      name: "搜索项目",
      exact: true,
    });
    await projectSearch.fill("no-project-matches-this");
    await expect(
      page.getByText("没有匹配的项目", { exact: true }),
    ).toBeVisible();
    await projectSearch.press("Escape");
    await expect(launch).toBeVisible();
    await expect(projectTrigger).toBeFocused();
    await projectTrigger.click();
    await expect(projectSearch).toHaveValue("");
    await projectSearch.dispatchEvent("compositionstart");
    await projectSearch.fill("searchable");
    await projectSearch.dispatchEvent("keydown", {
      key: "Enter",
      code: "Enter",
      isComposing: true,
    });
    await expect(projectTrigger).toHaveAttribute("aria-expanded", "true");
    await expect(launch).toBeVisible();
    await projectSearch.dispatchEvent("compositionend");
    await page.screenshot({
      path: test.info().outputPath("task-project-search-1440-dark.png"),
    });
    await projectSearch.press("Tab");
    await expect(projectTrigger).toHaveAttribute("aria-expanded", "false");
    await expect(launch).toBeVisible();
    await expect(launch.getByRole("radio", { name: /Codex/ })).toBeFocused();
    await projectTrigger.click();
    await projectSearch.fill(" contract ");
    const decoyOption = page.getByRole("option", {
      name: "contract unrelated project",
      exact: true,
    });
    const unavailableOption = page.getByRole("option", {
      name: /contract unavailable project/,
    });
    const actualOption = page.getByRole("option", {
      name: project.name,
      exact: true,
    });
    await expect(unavailableOption).toHaveAttribute("aria-disabled", "true");
    await expect(decoyOption).toHaveAttribute("data-selected", "true");
    await projectSearch.press("ArrowDown");
    await expect(actualOption).toHaveAttribute("data-selected", "true");
    await expect(unavailableOption).toHaveAttribute("data-selected", "false");
    await projectSearch.press("Enter");
    await expect(projectTrigger).toHaveText(project.name);
    await expect(projectTrigger).toBeFocused();
    await expect(launch).toBeVisible();
    await launch.getByRole("radio", { name: /Codex/ }).check();
    await searchAndSelect(page, "分支", "ALIAS-SEARCH", "feature/alias-search");
    await page.setViewportSize({ width: 360, height: 800 });
    await page.locator("#sandbox-image").click();
    const imageSearch = page.getByRole("combobox", {
      name: "搜索镜像",
      exact: true,
    });
    await imageSearch.fill("研发");
    const bounds = await page
      .locator("[data-search-select-content]")
      .boundingBox();
    expect(bounds).not.toBeNull();
    if (bounds === null)
      throw new Error("No narrow image search popover bounds");
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(360);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(800);
    const footer = await launch
      .getByTestId("launch-task-submit")
      .locator("..")
      .boundingBox();
    expect(footer).not.toBeNull();
    if (footer === null) throw new Error("No fixed task footer bounds");
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(footer.y);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await expect(page.locator("html")).toHaveClass(/dark/);
    await page.screenshot({
      path: test.info().outputPath("task-image-search-360-dark.png"),
    });
    await imageSearch.press("Escape");
    const lightPage = await page.context().newPage();
    observeBrowser(lightPage);
    try {
      await lightPage.setViewportSize({ width: 360, height: 800 });
      await lightPage.goto("/");
      await lightPage
        .getByRole("button", { name: "外观", exact: true })
        .click();
      await lightPage
        .getByRole("menuitemradio", { name: "亮色", exact: true })
        .click();
      await expect(lightPage.locator("html")).not.toHaveClass(/dark/);
      await lightPage
        .getByRole("button", { name: "新任务", exact: true })
        .click();
      await searchAndSelect(lightPage, "项目", "searchable", project.name);
      const lightLaunch = lightPage.getByTestId("modal-new-task");
      await lightLaunch.getByRole("radio", { name: /Codex/ }).check();
      await lightPage.locator("#sandbox-image").click();
      await lightPage
        .getByRole("combobox", { name: "搜索镜像", exact: true })
        .fill("研发");
      const lightBounds = await lightPage
        .locator("[data-search-select-content]")
        .boundingBox();
      const lightFooter = await lightLaunch
        .getByTestId("launch-task-submit")
        .locator("..")
        .boundingBox();
      expect(lightBounds).not.toBeNull();
      expect(lightFooter).not.toBeNull();
      if (lightBounds === null || lightFooter === null)
        throw new Error("No light narrow search bounds");
      expect(lightBounds.x).toBeGreaterThanOrEqual(0);
      expect(lightBounds.x + lightBounds.width).toBeLessThanOrEqual(360);
      expect(lightBounds.y + lightBounds.height).toBeLessThanOrEqual(
        lightFooter.y,
      );
      expect(
        await lightPage.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await lightPage.screenshot({
        path: test.info().outputPath("task-image-search-360-light.png"),
      });
    } finally {
      await lightPage.close();
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await searchAndSelect(page, "镜像", "研发", "研发 🚀");
    const creation = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/sandboxes") &&
        response.request().method() === "POST",
    );
    await launch.getByTestId("launch-task-submit").click();
    const response = await creation;
    expect(response.status()).toBe(201);
    expect(response.request().postDataJSON()).toEqual({
      projectId: project.id,
      runtime: "codex",
      branch: "feature/alias-search",
      image: imageRef,
    });
    const task = await response.json();
    expect(task).toMatchObject({
      projectId: project.id,
      runtime: "codex",
      image: imageRef,
      imageId: image.id,
      imageDigest: image.digest,
    });
    await expect
      .poll(
        async () =>
          (
            await (
              await request.get(`${API_ORIGIN}/api/sandboxes/${task.id}`)
            ).json()
          ).status,
      )
      .toBe("running");
    await expect(page.locator(".xterm")).toBeVisible();
    expect(browserErrors).toEqual([]);
    expect(failedResponses).toEqual([]);
    expect(apiRequests.length).toBeGreaterThan(0);
    expect([...new Set(apiRequests.map((url) => new URL(url).origin))]).toEqual(
      [WEB_ORIGIN],
    );
    expect(
      (
        await request.delete(`${API_ORIGIN}/api/sandboxes/${task.id}`, {
          data: {},
        })
      ).status(),
    ).toBe(204);
    await expect
      .poll(async () =>
        (await request.get(`${API_ORIGIN}/api/sandboxes/${task.id}`)).status(),
      )
      .toBe(404);
  } finally {
    await remote.close();
  }
});

test("registering an existing image with a different alias is a field error with no writes", async ({
  request,
}) => {
  await initializeIfNeeded(request);
  const registration = await request.post(`${API_ORIGIN}/api/images`, {
    data: {
      ref: "ghcr.io/contract/registration-conflict:v1",
      alias: "固定别名",
    },
  });
  expect(registration.status()).toBe(201);
  const image = (await registration.json()).manifest;
  expect(image.imageAlias).toBe("固定别名");
  const before = await (await request.get(`${API_ORIGIN}/api/images`)).json();
  const rejected = await request.post(`${API_ORIGIN}/api/images`, {
    data: {
      ref: "ghcr.io/contract/registration-conflict:v2",
      alias: "未经确认的新别名",
    },
  });
  expect(rejected.status()).toBe(400);
  expect(await rejected.json()).toMatchObject({
    code: "VALIDATION_FAILED",
    sideEffectFree: true,
    details: [{ path: "alias" }],
  });
  expect(await (await request.get(`${API_ORIGIN}/api/images`)).json()).toEqual(
    before,
  );
});
