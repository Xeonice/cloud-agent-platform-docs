import { test, expect } from "@playwright/test";
import { API_ORIGIN } from "../playwright.config";

test("browser actions use actual Nest and current SQLite through the same-origin proxy", async ({
  page,
  request,
}) => {
  const init = await request.post(`${API_ORIGIN}/api/system/init`, {
    data: {},
  });
  expect(init.status()).toBe(201);
  const credential = await request.post(
    `${API_ORIGIN}/api/runtimes/codex/credentials/secret`,
    {
      data: { method: "api-key", secret: `sk-${"a".repeat(48)}` },
    },
  );
  expect(credential.status()).toBe(200);
  const runtimes = await request.get(`${API_ORIGIN}/api/runtimes`);
  expect(
    (await runtimes.json()).find(
      (runtime: { id: string }) => runtime.id === "codex",
    ).credentialStatus,
  ).toBe("active");

  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "为你的代码建一个项目" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "开一个空项目", exact: true }).click();
  const projectDialog = page.getByRole("dialog");
  await projectDialog.getByLabel("项目名称").fill("browser actual project");
  const created = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/projects") &&
      response.request().method() === "POST",
  );
  await projectDialog
    .getByRole("button", { name: "创建项目", exact: true })
    .click();
  const projectResponse = await created;
  expect(projectResponse.status()).toBe(202);
  const project = await projectResponse.json();
  expect(project.cloneStatus).toBe("ready");
  await expect(
    page.getByTestId("project-group-header").filter({ hasText: project.name }),
  ).toBeVisible();
  await page.getByRole("button", { name: "新任务", exact: true }).click();
  const launch = page.getByTestId("modal-new-task");
  await expect(launch).toBeVisible();
  await launch.getByRole("radio", { name: /Codex/ }).check();
  const creation = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/sandboxes") &&
      response.request().method() === "POST",
  );
  await launch.getByTestId("launch-task-submit").click();
  const creationResponse = await creation;
  expect(creationResponse.status()).toBe(201);
  const task = await creationResponse.json();
  expect(task.projectId).toBe(project.id);
  expect(task.runtime).toBe("codex");
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
  const snapshot = await (
    await request.get(`${API_ORIGIN}/api/sandboxes/${task.id}`)
  ).json();
  expect(snapshot.hasRun).toBe(true);
  expect(snapshot.imageDigest).toMatch(/^sha256:[0-9a-f]{64}$/);

  await page
    .getByRole("button", { name: "任务菜单", exact: true })
    .last()
    .click();
  const stop = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/sandboxes/${task.id}/stop`) &&
      response.request().method() === "POST",
  );
  await page.getByRole("menuitem", { name: "停止", exact: true }).click();
  expect((await stop).status()).toBe(200);
  await expect(page.getByText("任务已停止", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "任务菜单", exact: true })
    .last()
    .click();
  const start = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/sandboxes/${task.id}/start`) &&
      response.request().method() === "POST",
  );
  await page.getByRole("menuitem", { name: "启动", exact: true }).click();
  expect((await start).status()).toBe(200);
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
  const restarted = await (
    await request.get(`${API_ORIGIN}/api/sandboxes/${task.id}`)
  ).json();
  expect(restarted.id).toBe(task.id);
  expect(restarted.imageDigest).toBe(snapshot.imageDigest);
  expect(restarted.imageId).toBe(snapshot.imageId);
  expect(restarted.createdAt).toBe(snapshot.createdAt);

  await page
    .getByRole("button", { name: "任务菜单", exact: true })
    .last()
    .click();
  await page.getByRole("menuitem", { name: "销毁任务…", exact: true }).click();
  const confirmation = page.getByTestId("task-destroy-confirm");
  await confirmation.getByRole("radio", { name: /一起删掉/ }).check();
  const removal = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/sandboxes/${task.id}`) &&
      response.request().method() === "DELETE",
  );
  await confirmation
    .getByRole("button", { name: "销毁任务", exact: true })
    .click();
  expect((await removal).status()).toBe(204);
  await expect
    .poll(async () =>
      (await request.get(`${API_ORIGIN}/api/sandboxes/${task.id}`)).status(),
    )
    .toBe(404);
  expect(
    await (
      await request.get(`${API_ORIGIN}/api/sandboxes?projectId=${project.id}`)
    ).json(),
  ).toEqual([]);
  await expect(page.locator(".xterm")).toHaveCount(0);
});
