import { test, expect } from '@playwright/test';
import {
  createAutomation,
  createEmptyProject,
  driveToResourceExhausted,
  ensureInitialized,
  ensureRuntimeApiKey,
} from '../fixtures/seed';
import { openAutomationsPanel } from './_ui';

/**
 * ⭐ **守漂移 #1** —— 三次事故里最贵的那一次（29 §1.2）：
 * `errorCode` 前端手抄成 2 个取值，契约有 3 个；少的那个 `RESOURCE_EXHAUSTED` 恰恰
 * 最常出现，于是 `AutomationRunPageSchema.parse` 当场抛，**整页运行历史变成一句错误
 * 消息、0 行**，连同页里另外 19 条正常记录一起消失。一次本该降级显示的事故被升级成
 * 了整页不可用。
 *
 * ── 为什么只有这一层抓得到 ─────────────────────────────────────────────────
 * 后端那 220 条 e2e 从不问「前端的 zod 认不认这个值」；前端那 1806 条全跑在手写替身
 * 上，而替身里当然只写了前端自己认识的那两个值 —— **两边各自自洽，合起来对不上**。
 * 唯一能问出这个问题的，是让真后端**真的产出**第 3 个取值，再让真前端去解析它。
 *
 * ── 这条 run 是怎么被真的造出来的（⛔ 没有一行 INSERT）─────────────────────
 * `SCHEDULER_HOST_CORES=1` 把宿主容量压到发不出一份配额 ⇒ 调度器走决策表**行 3**：
 * 排队重试 24min × 5 次，5 次仍无资源才转终态 `failed(errorCode='RESOURCE_EXHAUSTED')`。
 * 中间那 2 小时靠**拨时钟**跨过去（`fixtures/seed.ts#driveToResourceExhausted` 记了
 * 为什么必须拨，以及 §3.1.1 里「压容量就够了」那句为什么站不住）。
 * 决策表、重试上限、终态写入 —— 一行都没被跳过。
 *
 * ── 断言面（⛔ 只有契约面）─────────────────────────────────────────────────
 * ① 后端**真的**产出了 `errorCode='RESOURCE_EXHAUSTED'`（前置条件，不是结论）；
 * ② 前端解析它**没有炸**：`run-history-error` 不存在；
 * ③ 那一行真的渲染出来了，且被归到 `failure` 类。
 * ⛔ 不断言中文文案（那是 storybook 与 web e2e 的活）。
 */
test.describe('运行历史：真后端产出的 errorCode 第 3 个取值', () => {
  test('RESOURCE_EXHAUSTED 终态行能被前端 zod 接住，整页不塌', async ({ page }) => {
    test.slow(); // 7 轮 sweep + 一次首屏；本用例是这一层里最慢的一条
    await ensureInitialized();
    await ensureRuntimeApiKey('codex');
    const project = await createEmptyProject();
    const rule = await createAutomation(project.id);

    const runs = await driveToResourceExhausted(rule);

    // ── ① 先证明「世界真的被摆成了那个样子」──────────────────────────────
    // ⚠️ 少了这一句，一旦调度路径变了（比如 5 次上限被改成 3、或行 3 被重排到凭证
    //    检查之后），用例会因为「历史里根本没有那条 run」而**照样绿** —— 一条永远
    //    不会红的测试（29 §3.5.2b 那条从「已修好」名单里抓出来的假绿就是这个形状）。
    expect(runs.map((r) => r.errorCode)).toContain('RESOURCE_EXHAUSTED');

    await page.goto('/');
    await openAutomationsPanel(page, project.name);
    await page.getByTestId('automation-list-item').filter({ hasText: rule.name }).click();

    // ── ⚠️ 两步都不能省，它们堵的是同一条否定性断言的**两个**空过窗口 ────────
    // 窗口一 —— **组件还没挂上**：`run-history-error` 在详情视图渲染之前同样是 0 个。
    //   `run-history` 这个 `<section>` 是 `RunHistoryListView` **无条件**渲染的外壳
    //   （loading / error / 空态都有它），所以「它可见」= 详情视图真的挂上了。
    // 窗口二 —— **查询还在飞**：落到 loading 态时 `run-history-error` 还是 0 个。
    //   这一条是 M1 变异（把 `AUTOMATION_SKIP_REASONS` 改回 2 个取值）实测逼出来的：
    //   没有它时，zod 真的炸掉的那一轮里②照样绿，红的是后面数行数那句，错误信息里
    //   完全看不出「是解析炸了」。
    // ⛔ 不能用 `waitForTimeout` 代替这两步：那是把 flaky 换成**假绿**——机器一慢，
    //    固定等待跨不过 loading 态，②就又空过了，而且不会有任何东西提醒。
    // 29 §3.5.2 说的「否定性断言是假绿重灾区」，这里一条用例上就撞了两次。
    await expect(page.getByTestId('run-history')).toBeVisible();
    await expect(page.getByTestId('run-history-loading')).toHaveCount(0);

    // ── ② 解析没炸 —— 这一句就是漂移 #1 的直接判据 ───────────────────────
    await expect(page.getByTestId('run-history-error')).toHaveCount(0);

    // ── ③ 那一行真的在，且归到了 failure 类 ──────────────────────────────
    // ⚠️ ②③ 缺一不可：只写②的话，「一行都没有」也是绿的；只写③的话，拿不到
    //    「炸没炸」这个信息，红了也说不清原因。
    await expect(page.getByTestId('run-history-item')).toHaveCount(runs.length);
    await expect(
      page.locator('[data-testid="run-history-item"][data-category="failure"]'),
    ).toHaveCount(runs.filter((r) => r.status === 'failed' || r.status === 'timeout').length);
  });
});
