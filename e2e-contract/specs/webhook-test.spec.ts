import { test, expect } from '@playwright/test';
import { createEmptyProject, ensureInitialized } from '../fixtures/seed';
import { openAutomationsPanel } from './_ui';

/**
 * **守漂移 #2** —— 事故表第二行（29 §1.2）：
 * webhook 测试的响应体前端**从没读过**，于是 `200 + {ok:false}` 被当成功 ⇒
 * 用户看到「测试通过」而 webhook 根本发不出去。
 *
 * ── 这一格的关键在于「200 不等于成功」 ─────────────────────────────────────
 * `POST /api/automations/webhook-test` 的 controller 挂着 `@HttpCode(200)`：投递失败
 * 是目标端的事，不该让 HTTP 层去解释。⇒ **成败在 body 的 `ok` 里**。
 * 替身当然回 `{ok:true}`（谁会写一个自己失败的替身），所以 44 条 web e2e 与 1362 条
 * 单测里，**没有一条见过 `ok:false`**。真后端见得到 —— 它有一条真的 SSRF 策略。
 *
 * ── 怎么让真后端真的回 `ok:false`（⛔ 不 mock、不改后端）─────────────────
 * §3.1.1 的原话：「webhook `ok:false` ⇒ 指向一个内网地址，让真的 SSRF 策略拒掉」。
 * 未启用访问口令时私网段一律 `deny-private`（11 §3.1 / 审计 P2-12），于是
 * `http://192.168.0.1/hook` 拿到的是 `200 + {ok:false, errorCode:'HOST_NOT_ALLOWED'}`。
 *
 * ⚠️ 用**私网 IP 字面量**而不是「一个连不上的公网地址」，是刻意的：策略在**发请求
 * 之前**就拒了（实测 8ms，零网络 IO），所以这条用例既不依赖 DNS、也不依赖任何超时 ——
 * 换成公网不可达地址会拿到 `UPSTREAM_UNAVAILABLE`，那条路要真的等一次 fetch 失败，
 * 是这一层最典型的 flaky 来源。
 *
 * ── 断言面（⛔ 只有契约面）─────────────────────────────────────────────────
 * ① `webhook-test-error` 出现 ⇒ 前端读了 `ok` 并把它当失败；
 * ② `webhook-test-ok` **不存在** ⇒ 排除「两个都显示」这种同形绿。
 * ⛔ 不断言那句中文错误文案本身（它是后端 `message` 的原样回显，属 web e2e 的活）。
 */
test.describe('webhook 测试：200 + ok:false 必须被当成失败', () => {
  test('真 SSRF 策略拒掉内网地址时，前端显示失败而不是「已送达」', async ({ page }) => {
    await ensureInitialized();
    const project = await createEmptyProject();

    await page.goto('/');
    await openAutomationsPanel(page, project.name);
    await page.getByTestId('automation-create').click();

    await page.getByTestId('webhook-enabled').check();
    // 私网 IP 字面量 ⇒ 真 SSRF 策略在发请求之前就拒（零网络 IO，见文件头）。
    await page.getByTestId('webhook-url').fill('http://192.168.0.1/hook');
    await page.getByTestId('webhook-test').click();

    // ① 前端真的读了 body 的 `ok`
    await expect(page.getByTestId('webhook-test-error')).toBeVisible();
    // ② ⛔ 不能同时出现「已送达」
    await expect(page.getByTestId('webhook-test-ok')).toHaveCount(0);
  });
});
