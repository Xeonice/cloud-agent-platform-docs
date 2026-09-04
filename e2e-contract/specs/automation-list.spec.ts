import { test, expect } from '@playwright/test';
import { createAutomation, createEmptyProject, ensureInitialized } from '../fixtures/seed';
import { openAutomationsPanel } from './_ui';

/**
 * **守漂移 #3（e2e fixture 缺 `triggerOn` / `createdAt` / `updatedAt` 三个契约必填字段
 * ⇒ zod 挡下 ⇒ 列表一项都不渲染）**。
 *
 * ── 为什么真链路能抓到，而 44 条 web e2e 抓不到 ─────────────────────────────
 * 那 44 条里的 `RULE` 是**手写字面量**；写漏一个必填字段，`AutomationDtoSchema` 当场
 * 挡下、列表空掉，5 条用例连锁红 —— 但红的原因是「fixture 写错了」，改 fixture 就绿，
 * **没有任何一处在问「真后端到底给不给这三个字段」**。这一层里**根本不存在 fixture**：
 * 列表里那一行是 `POST /api/projects/:id/automations` 真的写进库、再由
 * `GET /api/projects/:id/automations` 真的读回来的。后端哪天漏发 `triggerOn`，
 * zod 立刻炸在这里。
 *
 * ── 断言面（⛔ 只有契约面）─────────────────────────────────────────────────
 * ① 列表**渲染出了**那一行 ⇒ `AutomationDtoSchema` 的全部必填字段真后端都给了；
 * ② `automation-load-error` **不存在** ⇒ 排除「解析炸了但恰好也没行可显示」这种同形绿；
 * ③ `automation-timezone` 显示的是**规则创建时快照的那个时区**（I-AUT-9），
 *    不是跑测试那台机器的时区 —— 一个只有真后端才回答得了的字段。
 * ⛔ 不断言任何文案、不断言排版。
 */
test.describe('自动化规则列表：真后端的 AutomationDto 必填字段面', () => {
  test('真 API 建的规则被列表渲染出来，zod 一处没炸', async ({ page }) => {
    await ensureInitialized();
    const project = await createEmptyProject();
    // 刻意用一个**不可能等于跑测试那台机器**的时区：它若被前端/后端任何一方顺手
    // 改写成本机时区，下面那条断言就有分辨力。
    const rule = await createAutomation(project.id, { timezone: 'Pacific/Chatham' });

    await page.goto('/');
    await openAutomationsPanel(page, project.name);

    // ⚠️ 先等外壳挂上、再等查询**落定** —— 两步堵的是同一条否定性断言的两个空过窗口
    //    （`automation-load-error` 在**组件未挂载**时与 **loading 态**下都是 0 个）。
    //    `automation-list` 是 `AutomationListView` 无条件渲染的外壳。
    //    少了这两行，下面那条否定性断言会在真出错的那一轮里空过（本层在
    //    `automation-runs.spec.ts` 上撞过现行，注释记在那里）。
    await expect(page.getByTestId('automation-list')).toBeVisible();
    await expect(page.getByTestId('automation-loading')).toHaveCount(0);

    // ② 再看「有没有炸」。⚠️ 顺序不能与③反：解析失败时列表也是 0 行，
    //    先断言行数会得到一条**说不清失败原因**的红。
    await expect(page.getByTestId('automation-load-error')).toHaveCount(0);

    // ① 那一行真的在
    const item = page.getByTestId('automation-list-item').filter({ hasText: rule.name });
    await expect(item).toHaveCount(1);

    // ③ 时区快照来自真后端
    await expect(item.getByTestId('automation-timezone')).toContainText('Pacific/Chatham');

    // 分页信封形状：这个端点回**裸数组**（10 §7.2）。回成 `{items:[…]}` 时
    // zod 的 `AutomationListSchema`（`z.array(...)`）当场挡下 ⇒ 上面②会红。
  });
});
