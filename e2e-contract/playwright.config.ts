import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * 跨仓**运行时**契约 e2e（29 §3.1.1）。
 *
 * ── 它与另外两层 e2e 的边界 ─────────────────────────────────────────────────
 * `api/apps/api/test/e2e`（220 条）验后端功能；`web/e2e`（44 条）验前端功能，
 * 后端由 `page.route` 冒充。这一层**只验两边对得上**：字段名、必填性、错误码取值、
 * 分页信封形状、时间格式。⛔ 不验文案、不验像素、不验交互细节。
 *
 * ⛔ **前端不挂任何 `page.route`。** 挂了就退化成第二套 web e2e，这一层就白做了。
 *
 * ── 为什么 `workers: 1` / `fullyParallel: false` ─────────────────────────────
 * 两个 webServer 是**一对**长活进程，后端那一份带着一个**共享的** in-memory 库；
 * 并行跑就会出现「A 的项目出现在 B 的列表里」这种与被测契约无关的红。用例之间靠
 * **各建各的项目**隔离，顺序上互不依赖，但仍然串行 —— 这一层本来就只有个位数条，
 * 并行省下的时间远小于它带来的不确定性（§3.1.1「最慢最脆的一层」）。
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

const API_PORT = process.env['CONTRACT_API_PORT'] ?? '3110';
const WEB_PORT = process.env['CONTRACT_WEB_PORT'] ?? '3210';
const API_ORIGIN = `http://127.0.0.1:${API_PORT}`;
const WEB_ORIGIN = `http://127.0.0.1:${WEB_PORT}`;

/**
 * ⚠️ **环境变量在这里显式注入，⛔ 不依赖 `web/.env.local`。**
 * CI 是干净 checkout，那个文件根本不存在；而它存在与否会让 `next build` 的产物不同
 * （11 §1.3 踩过）。Next 的规则是「已经在 `process.env` 里的键不被 `.env*` 覆盖」，
 * 所以这里显式给出的三个键在本机与 CI 上得到**同一份产物**——包括故意给空串的两个
 * （空 = 同源，走 `next.config.mjs` 的 rewrites）。
 */
const WEB_ENV = {
  API_ORIGIN,
  NEXT_PUBLIC_API_BASE_URL: '',
  NEXT_PUBLIC_WS_BASE_URL: '',
  PORT: WEB_PORT,
} as const;

export default defineConfig({
  testDir: './specs',
  // ⛔ 起浏览器之前先机械地确认「一处替身都没有」，见 `global-setup.ts`。
  globalSetup: './global-setup.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env['CI'],
  // ⚠️ 本机 0 次重试是刻意的：这一层要的是「它红过吗」，而重试会把 flaky 与真红
  //    混成同一种绿。CI 上给 1 次，只为吸收 build/启动那一侧的抖动。
  retries: process.env['CI'] ? 1 : 0,
  reporter: process.env['CI'] ? [['html', { open: 'never' }], ['list']] : 'list',
  timeout: 60_000,
  use: {
    baseURL: WEB_ORIGIN,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      // 真 AppModule + `_fakes.ts` 那一份假 provider，**固定端口**（§3.1.1）。
      command: `node_modules/.bin/tsx server/start-api.ts`,
      cwd: HERE,
      url: `${API_ORIGIN}/api/health`,
      reuseExistingServer: !process.env['CI'],
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { CONTRACT_API_PORT: API_PORT },
    },
    {
      command: `pnpm build && pnpm start -H 127.0.0.1 -p ${WEB_PORT}`,
      cwd: resolve(REPO, 'web'),
      url: WEB_ORIGIN,
      reuseExistingServer: !process.env['CI'],
      timeout: 300_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: WEB_ENV,
    },
  ],
});

export { API_ORIGIN, WEB_ORIGIN };
