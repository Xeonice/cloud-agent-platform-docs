import { test, expect, type APIRequestContext } from "@playwright/test";
import { API_ORIGIN, WEB_ORIGIN } from "../playwright.config";

const REGISTRY = `http://127.0.0.1:${process.env.CONTRACT_REGISTRY_PORT ?? 3311}`;
const IMAGE_HOST = new URL(REGISTRY).host;

async function initializeIfNeeded(request: APIRequestContext) {
  const status = await request.get(`${API_ORIGIN}/api/system/init-status`);
  expect(status.status()).toBe(200);
  if (!(await status.json()).initialized) {
    expect(
      (
        await request.post(`${API_ORIGIN}/api/system/init`, { data: {} })
      ).status(),
    ).toBe(201);
  }
}

test("OCI CLI build declarations survive SQLite, digest drift, history and task image search", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  const apiOrigins = new Set<string>();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/"))
      apiOrigins.add(new URL(request.url()).origin);
  });
  await initializeIfNeeded(request);
  expect(
    (await request.put(`${REGISTRY}/fixtures/active?version=v1`)).status(),
  ).toBe(200);
  expect(
    (
      await request.post(
        `${API_ORIGIN}/api/runtimes/codex/credentials/secret`,
        {
          data: { method: "api-key", secret: `sk-${"c".repeat(48)}` },
        },
      )
    ).status(),
  ).toBe(200);

  const imageRef = `${IMAGE_HOST}/cli-agent:latest`;
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/settings/images");
  await page
    .getByRole("button", { name: "+ 注册新镜像", exact: true })
    .first()
    .click();
  const register = page.getByRole("dialog", {
    name: "注册新镜像",
    exact: true,
  });
  await register.getByLabel("镜像 URI", { exact: true }).fill(imageRef);
  await register
    .getByLabel("别名（可选）", { exact: true })
    .fill("CLI 版本验收");
  await register.getByRole("button", { name: "验证", exact: true }).click();
  await expect(register.getByTestId("validation-runtime-versions")).toHaveText(
    "镜像声明：Codex 0.150.1 · Claude Code 2.1.251",
  );
  const registeredResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/images") &&
      response.request().method() === "POST",
  );
  await register.getByRole("button", { name: "保存", exact: true }).click();
  const initialResponse = await registeredResponse;
  expect(initialResponse.status()).toBe(201);
  const initial = (await initialResponse.json()).manifest;
  expect(initial.runtimeVersions).toEqual({
    codex: "0.150.1",
    "claude-code": "2.1.251",
  });
  const card = page.getByTestId("image-card").filter({ hasText: imageRef });
  await expect(card.getByTestId("image-runtime-versions")).toHaveText(
    "镜像声明：Codex 0.150.1 · Claude Code 2.1.251",
  );
  for (const [repository, versions] of [
    ["cli-unknown", {}],
    ["cli-partial", { codex: "0.151.0" }],
    ["cli-unsafe", {}],
  ] as const) {
    const response = await request.post(`${API_ORIGIN}/api/images`, {
      data: { ref: `${IMAGE_HOST}/${repository}:latest` },
    });
    expect(response.status()).toBe(201);
    expect((await response.json()).manifest.runtimeVersions).toEqual(versions);
  }
  await page.reload();
  await expect(card.getByTestId("image-runtime-versions")).toContainText(
    "Codex 0.150.1",
  );
  await expect(
    page
      .getByTestId("image-card")
      .filter({ hasText: `${IMAGE_HOST}/cli-unknown:latest` })
      .getByTestId("image-runtime-versions"),
  ).toHaveText("镜像声明：Codex 未报告 · Claude Code 未报告");
  const unsafe = page
    .getByTestId("image-card")
    .filter({ hasText: `${IMAGE_HOST}/cli-unsafe:latest` });
  await expect(unsafe.getByTestId("image-runtime-versions")).toHaveText(
    "镜像声明：Codex 未报告 · Claude Code 未报告",
  );
  expect(await unsafe.innerHTML()).not.toContain("onerror");
  await expect(
    page
      .getByTestId("image-card")
      .filter({ hasText: `${IMAGE_HOST}/cli-partial:latest` })
      .getByTestId("image-runtime-versions"),
  ).toHaveText("镜像声明：Codex 0.151.0 · Claude Code 未报告");

  const rowsBefore = await (
    await request.get(`${API_ORIGIN}/api/images`)
  ).json();
  expect(
    (await request.put(`${REGISTRY}/fixtures/active?version=v2`)).status(),
  ).toBe(200);
  await card.getByRole("button", { name: "检查更新", exact: true }).click();
  const compare = page.getByRole("dialog", { name: /的上游更新/ });
  await expect(compare.getByTestId("current-runtime-versions")).toContainText(
    "Codex 0.150.1 · Claude Code 2.1.251",
  );
  await expect(compare.getByTestId("upstream-runtime-versions")).toContainText(
    "Codex 0.160.0 · Claude Code 2.1.260",
  );
  await page.screenshot({
    path: test.info().outputPath("image-cli-versions-compare-1440.png"),
  });
  await compare.getByRole("button", { name: "暂不更新", exact: true }).click();
  expect(await (await request.get(`${API_ORIGIN}/api/images`)).json()).toEqual(
    rowsBefore,
  );
  const revalidation = await request.post(
    `${API_ORIGIN}/api/images/${initial.id}/validate`,
  );
  expect(revalidation.status()).toBe(200);
  expect(await revalidation.json()).toMatchObject({
    currentDigest: initial.digest,
    digestChanged: true,
    runtimeVersions: { codex: "0.160.0", "claude-code": "2.1.260" },
  });
  const pinned = (
    await (await request.get(`${API_ORIGIN}/api/images`)).json()
  ).find((row: { id: string }) => row.id === initial.id);
  expect(pinned.runtimeVersions).toEqual(initial.runtimeVersions);
  expect(pinned.digest).toBe(initial.digest);

  await card.getByRole("button", { name: "检查更新", exact: true }).click();
  await compare
    .getByRole("button", { name: "更新到新版本", exact: true })
    .click();
  await expect(compare).not.toBeVisible();
  await expect(card.getByTestId("image-runtime-versions")).toHaveText(
    "镜像声明：Codex 0.160.0 · Claude Code 2.1.260",
  );
  const history = page
    .getByTestId("image-version-row")
    .filter({ hasText: initial.digest.slice(0, 12) });
  await expect(
    history.getByTestId("image-version-runtime-versions"),
  ).toHaveText("Codex 0.150.1 · Claude Code 2.1.251");
  await page.reload();
  await expect(card.getByTestId("image-runtime-versions")).toContainText(
    "Codex 0.160.0",
  );
  const active = (
    await (await request.get(`${API_ORIGIN}/api/images`)).json()
  ).find(
    (row: { imageId: string; isActive: boolean }) =>
      row.imageId === initial.imageId && row.isActive,
  );
  expect(active.digest).not.toBe(initial.digest);
  expect(active.runtimeVersions).toEqual({
    codex: "0.160.0",
    "claude-code": "2.1.260",
  });
  await page
    .getByRole("searchbox", { name: "搜索镜像", exact: true })
    .fill("0.160.0");
  await expect(page.getByTestId("image-card")).toHaveCount(1);
  await page.screenshot({
    path: test.info().outputPath("image-cli-versions-current-history-1440.png"),
  });

  const projectResponse = await request.post(`${API_ORIGIN}/api/projects`, {
    data: { name: "CLI version image task", sourceType: "empty" },
  });
  expect(projectResponse.status()).toBe(202);
  const project = await projectResponse.json();
  let taskId: string | undefined;
  try {
    await page.goto("/");
    await page.getByRole("button", { name: "新任务", exact: true }).click();
    const launch = page.getByTestId("modal-new-task");
    await page.locator("#sandbox-project").click();
    await page
      .getByRole("combobox", { name: "搜索项目", exact: true })
      .fill(project.name);
    await page
      .getByRole("option", { name: new RegExp(`^${project.name}(?:\\s|$)`) })
      .click();
    await launch.getByRole("radio", { name: /Codex/ }).check();
    await page.setViewportSize({ width: 360, height: 800 });
    await page.locator("#sandbox-image").click();
    const search = page.getByRole("combobox", {
      name: "搜索镜像",
      exact: true,
    });
    await search.fill("0.160.0");
    const option = page.getByRole("option", { name: /CLI 版本验收/ });
    await expect(option).toContainText(imageRef);
    await expect(option).toContainText(
      "镜像声明：Codex 0.160.0 · Claude Code 2.1.260",
    );
    await expect(option).toHaveAttribute(
      "data-value",
      `option:${initial.imageId}`,
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: test.info().outputPath("task-image-cli-versions-search-360.png"),
    });
    await option.click();
    await expect(launch.getByTestId("selected-image-detail")).toHaveText(
      "镜像声明：Codex 0.160.0 · Claude Code 2.1.260",
    );
    await expect(launch.getByTestId("selected-image-reference")).toHaveText(
      imageRef,
    );
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
      image: imageRef,
    });
    const task = await response.json();
    taskId = task.id;
    expect(task).toMatchObject({
      image: imageRef,
      imageId: active.id,
      imageDigest: active.digest,
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
    expect(errors).toEqual([]);
    expect([...apiOrigins]).toEqual([WEB_ORIGIN]);
  } finally {
    if (taskId !== undefined) {
      expect(
        (
          await request.delete(`${API_ORIGIN}/api/sandboxes/${taskId}`, {
            data: {},
          })
        ).status(),
      ).toBe(204);
      await expect
        .poll(async () =>
          (await request.get(`${API_ORIGIN}/api/sandboxes/${taskId}`)).status(),
        )
        .toBe(404);
    }
    expect(
      (
        await request.delete(`${API_ORIGIN}/api/projects/${project.id}`, {
          data: {},
        })
      ).status(),
    ).toBe(204);
  }
});
