import { test, expect } from '@playwright/test';
import { ensureInitialized, ensureRuntimeApiKey, runtimeOf } from '../fixtures/seed';

/**
 * **守漂移 #5**（29 §3.1.1 验收表第 5 行）：runtime 凭证的响应替身**多一个
 * `activeAuthMethod`**。
 *
 * ── ⚠️ 这条用例守的是那个字段的**读取面**，不是 `PUT /auth-mode` 那个端点 ─────
 * 验收表把漂移 #5 挂在 `PUT /api/runtimes/{rt}/auth-mode` 上。实测下来，那个 **PUT
 * 在真链路里够不着**：`AuthMethodRadioRow#handleSelect` 只在「目标模式已配置且当前
 * 不生效」时才发 PUT，也就是要求**同一个 runtime 上同时配好两种模式**；而另一种模式
 * （`oauth-device` / `setup-token`）都要走真的厂商授权，e2e 里造不出来
 * （实测 `POST /api/runtimes/claude-code/auth/begin` 会去拉真 helper，直接挂住）。
 *
 * ⛔ 于是**没有假装覆盖它**。这条用例改为盯住 `activeAuthMethod` **唯一被前端读取的
 * 那一处**：`GET /api/runtimes` → `runtimeCredential.ts:44` 的
 * `const active = runtime.activeAuthMethod === mode`（grep 确认，`src/` 里只有这一处）。
 * 也就是说 —— 漂移 #5 真正会伤到的那条读路径被盖住了，发出 PUT 的那半段没有；
 * 后者由 `api` 侧的 e2e 单独保着，缺口如实记在 29 §3.1.1 的表里。
 *
 * ── 断言面（⛔ 只有契约面）─────────────────────────────────────────────────
 * ① 登记 api-key 之后，`GET /api/runtimes` 真的带上了 `activeAuthMethod`
 *    （前置条件，Node 侧直接查，不是结论）；
 * ② 浏览器里 **API Key 那一行的 radio 是选中的**、帐号授权那一行不是 ——
 *    这一位就是 `activeAuthMethod === mode` 的直接投影：后端不发这个字段、或者发的
 *    取值口径与前端的 `RuntimeAuthMode` 对不上，两行就会**都不选中**。
 * ③ 掩码来自真后端（`sk-…cdef`），前端一个字没编。
 *
 * ⚠️ `src/views/settings/**` 里一个 `data-testid` 都没有，只能按 role/text 选。
 */
const RUNTIME = 'claude-code';
const DISPLAY_NAME = 'Claude Code';
// ⚠️ 前缀不是装饰：后端对 `claude-code` 的 api-key 有真的格式校验
// （少了 `sk-ant-` 直接 401 `AUTH_REJECTED`）——「随便一串」在真链路上过不去。
const SECRET = 'sk-ant-contract-e2e-0123456789abcd';

test.describe('runtime 凭证：activeAuthMethod 的读取面', () => {
  test('真后端的 activeAuthMethod 让 API Key 那一行被选中', async ({ page }) => {
    await ensureInitialized();
    await ensureRuntimeApiKey(RUNTIME, SECRET);

    // ① 前置条件：真后端确实发了这个字段
    const runtime = await runtimeOf(RUNTIME);
    expect(runtime.activeAuthMethod).toBe('api-key');

    await page.goto('/settings/credentials');

    // 卡片按 displayName 定位（settings 视图里没有任何 testid）。
    // ⚠️ 两个 `filter` 缺一不可：只按标题过滤，`.last()` 命中的是标题自己那个
    // `<div class="flex flex-col">`（它不含 radio）；加上「必须含 radio」这一条，
    // 最内层同时满足两者的元素就唯一是卡片根。
    const card = page
      .locator('div')
      .filter({ has: page.getByRole('heading', { name: DISPLAY_NAME, exact: true }) })
      .filter({ has: page.getByRole('radio') })
      .last();

    // ② `activeAuthMethod === mode` 的直接投影
    await expect(card.getByRole('radio', { name: 'API Key' })).toBeChecked();
    await expect(card.getByRole('radio', { name: '帐号授权' })).not.toBeChecked();

    // ③ 掩码由真后端算出（明文尾 4 位），⛔ 明文不上屏
    await expect(card.getByText(`sk-…${SECRET.slice(-4)}`)).toBeVisible();
    expect(await page.content()).not.toContain(SECRET);
  });
});
