import { expect, type Page } from '@playwright/test';

/**
 * 几条被多个 spec 共用的点击序列。
 *
 * ⛔ **这个文件里不许出现 `page.route` / `page.routeWebSocket`。**
 * `playwright.config.ts` 的 globalSetup 会机械地检查整个 `specs/`（含本文件）——
 * 挂了替身，这一层就退化成第二套 web e2e（29 §3.1.1 的第一条红线）。
 */

/** 组头「⋯」→ [项目菜单…] → [⚙️ 自动化规则]（F21-6 §10.2 C 的那条路）。 */
export async function openAutomationsPanel(page: Page, projectName: string): Promise<void> {
  await page
    .getByTestId('project-group-header')
    .filter({ hasText: projectName })
    .getByTestId('project-group-menu-trigger')
    .click();
  await page.getByTestId('group-menu-open-panel').click();
  await page.getByTestId('open-automations').click();
  await expect(page.getByTestId('modal-automations')).toBeVisible();
}
