import { test, expect } from '@playwright/test';
import { ensureInitialized, resetGitCredentials } from '../fixtures/seed';

/**
 * **守漂移 #4**（29 §3.1.1 验收表第 4 行）：git 凭证的**保存响应**替身比真响应
 * **多 5 个字段**。真响应只有 `{ id, maskedIdentifier }`（`StoreGitCredentialResultSchema`）。
 *
 * ── 多字段的替身为什么危险，而 §3.2 的 `satisfies` 又为什么接不住它 ─────────
 * 少字段会被 `satisfies` 在编译期挡下（TS1360），**多字段不会**：对象字面量多给几个
 * 键，超出的部分被 excess-property check 挡住的前提是它直接写在 `satisfies` 位置上，
 * 而经过工厂函数/展开之后就静默通过。⇒ 前端可以放心地去读一个**真后端从来不发**的
 * 字段，替身把它喂饱，测试全绿，真浏览器里拿到 `undefined`。
 * 唯一能问出这个问题的，是让真后端来回答这次保存。
 *
 * ── 断言面（⛔ 只有契约面）─────────────────────────────────────────────────
 * ① 保存成功 ⇒ `POST /api/credentials/git` **有 body 且能 JSON 解析**
 *    （`gitCredential.service.ts` 要求 `response.ok && data !== undefined`；
 *     后端若改成 204 无体，这一步当场炸）；
 * ② 卡片上的 `maskedIdentifier` 来自**刷新后的 `GET /api/credentials?kind=git`**，
 *    且它是**真后端算出来的掩码**（`…abcd` = 明文尾 4 位）—— 前端一个字都没编；
 * ③ ⛔ 明文 token 不出现在页面上（这一条不是契约面，但它是这条链路上唯一
 *    「一旦错就是安全事故」的性质，而只有真链路才验得了：替身里的掩码是写死的）。
 *
 * ⚠️ `src/views/settings/**` 里**一个 `data-testid` 都没有**（实测），所以这条用例
 * 只能按 role / placeholder 选元素 —— 与 `web/e2e/gitCredentials.spec.ts` 同一套选择器。
 */
const TOKEN = 'ghp_contracte2e0123456789abcd';
/** 真后端的掩码口径：明文的最后 4 位。 */
const MASK_TAIL = TOKEN.slice(-4);

test.describe('git 凭证：保存响应只有两个字段', () => {
  test('UI 登记一条 HTTPS Token，卡片显示真后端算出来的掩码', async ({ page }) => {
    await ensureInitialized();
    await resetGitCredentials();

    await page.goto('/settings/credentials');
    await page.getByRole('button', { name: '配置 HTTPS Token' }).click();
    await page.getByPlaceholder('ghp_…').fill(TOKEN);
    await page.getByRole('button', { name: '保存' }).click();

    // ①② 卡片出现，且掩码是真后端算的
    await expect(page.getByText(`Token 尾号：…${MASK_TAIL}`)).toBeVisible();
    // ③ 明文一个字都不上屏
    expect(await page.content()).not.toContain(TOKEN);
  });
});
