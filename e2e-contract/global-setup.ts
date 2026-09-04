import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 这一层唯一的一条**机器门禁**：⛔ `specs/` 与 `fixtures/` 里不许出现任何前端替身。
 *
 * ── 为什么值得一道机器门禁 ─────────────────────────────────────────────────
 * 29 §3.1.1 的第一条红线是「前端不挂任何 `page.route`」，理由是挂了就退化成第二套
 * web e2e —— 而这**不是一个会当场报错的错误**：挂上 `page.route` 之后用例照样绿，
 * 只是它验的东西悄悄从「两边对得上」变成了「前端跟它自己的替身对得上」。
 * 一个**静默失效**的门，正是 29 §3.2 那条「人工信号也要有机器兜底」说的形状。
 *
 * 放在 `globalSetup` 而不是写成一条用例：它该在**任何浏览器起来之前**就把整轮拦下，
 * 而不是在报告里多一条绿/红。
 */
const HERE = dirname(fileURLToPath(import.meta.url));

/** ⛔ 出现即失败。`routeWebSocket` 与 `route` 同罪（WS 替身也是替身）。 */
const FORBIDDEN = [/\.route\s*\(/, /\.routeWebSocket\s*\(/, /\.routeFromHAR\s*\(/];

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return walk(full);
    return e.name.endsWith('.ts') ? [full] : [];
  });
}

export default function globalSetup(): void {
  const offenders: string[] = [];
  for (const file of [...walk(join(HERE, 'specs')), ...walk(join(HERE, 'fixtures'))]) {
    const source = readFileSync(file, 'utf8');
    source.split('\n').forEach((line, i) => {
      // 注释行不算 —— 本层好几个文件的头注释里就写着 `page.route` 这四个字。
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      if (FORBIDDEN.some((re) => re.test(line))) {
        offenders.push(`${file}:${String(i + 1)}: ${line.trim()}`);
      }
    });
  }
  if (offenders.length > 0) {
    throw new Error(
      '⛔ 契约 e2e 里出现了前端替身（29 §3.1.1 第一条红线）。挂了替身，这一层验的就不再是\n' +
        '「两边对得上」，而是「前端跟它自己的替身对得上」—— 那是 web/e2e 已经在做的事。\n' +
        offenders.join('\n'),
    );
  }
}
