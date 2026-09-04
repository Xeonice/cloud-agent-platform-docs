import { test, expect } from '@playwright/test';
import { createEmptyProject, createGitProject, ensureInitialized } from '../fixtures/seed';

/**
 * **守漂移 #6（`ProjectResponseDto.updatedAt` 必填但 fixture 缺）与 #7（health 替身回
 * `{status:'ok'}` 而契约无 body）**（29 §3.1.1 那张验收表）。
 *
 * ── 为什么这两条要合成一条用例 ─────────────────────────────────────────────
 * 它们守的是**同一次页面加载**上的两个字段面：首屏一次 `goto('/')` 会依次打
 * `GET /api/system/init-status` → `GET /api/health` → `GET /api/projects`。
 * 拆成两条用例只是让同一段 30 秒的首屏跑两遍（§3.1.1 的硬约束：这是最慢的一层）。
 *
 * ── ⚠️ 这条用例的分辨力**弱于**另外五条，而且弱在哪是可以说清楚的 ─────────
 * `GET /api/projects` 在前端**没有任何 zod**（`types/project.ts` 只是生成类型的别名，
 * `project.service.ts` 拿到 `data` 直接返回）。⇒ 后端少给一个 `updatedAt` **不会报错**，
 * 只会静默降级。所以这里能钉住的只有「那个字段真的被读到了、而且是个能被
 * `toLocaleString` 解析的时间」——**时间格式**这一格（§3.1.1 只断言契约面的四类之一）。
 * 真正的必填性锁在 §3.2 的 `satisfies` 与 docs:check 的 B3 上，不在这一层。
 *
 * ⚠️ 项目必须是 **git** 的：`ProjectInfoBar` 对 `empty` 项目读的是 `createdAt`，
 * `updatedAt` 压根不上屏（见 `fixtures/seed.ts#createGitProject` 的注释）。
 */
test.describe('首屏：真后端驱动的 health + 项目列表', () => {
  test('health 标签读到真后端的 200；git 项目的 updatedAt 被渲染成可解析的时刻', async ({
    page,
  }) => {
    await ensureInitialized();
    const empty = await createEmptyProject();
    const git = await createGitProject();

    await page.goto('/');

    // ── 漂移 #7：契约说 `GET /api/health` 没有 body，替身却回了 `{status:'ok'}` ──
    // 前端只读 `response.ok` / `response.status`（`health.service.ts`）。真后端**确实**
    // 回了一段 body（`{status,uptimeSec}`），两边仍然对得上 —— 这正是这一格要证明的：
    // 前端没有偷偷依赖那段 body。⛔ 不断言文案里的中文，只断言它带上了真实状态码。
    await expect(page.getByTestId('health-label')).toHaveText(/HTTP 200/);

    // ── 分页信封形状：`GET /api/projects` 是**裸数组**（10 §7.2：只有 automation runs
    //    用信封）。回成 `{items:[…]}` 的话，下面这两行一条都渲染不出来。 ──
    const headers = page.getByTestId('project-group-header');
    await expect(headers.filter({ hasText: empty.name })).toHaveCount(1);
    await expect(headers.filter({ hasText: git.name })).toHaveCount(1);

    // ── 漂移 #6：选中 git 项目，`updatedAt` 才真的被读 ──────────────────────
    await page.getByRole('button', { name: new RegExp(git.name) }).click();
    const infoBar = page.getByTestId('project-info-bar');
    await expect(infoBar).toBeVisible();
    // `formatTime` 解析失败时**原样回吐**输入串。⇒ 断言「屏幕上没有 ISO 的那个 `T`
    // 和 `Z`」等价于断言「后端给的确实是一个 `Date` 能解析的 ISO 8601」。
    await expect(infoBar).toContainText('最后同步');
    await expect(infoBar).not.toContainText(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });
});
