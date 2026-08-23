#!/usr/bin/env node
//
// docs:check —— 文档一致性门禁（权威定义见 docs/shared/09-工程化规范.md §2.4）
//
// 纯静态、零依赖（只用 Node 内置模块），秒级返回；干净环境下 `node scripts/docs-check.mjs`
// 即可运行，不需要 npm install。
//
// 检查分两类：
//   A 类 —— 文档内部检查，只读 docs/**，始终跑。
//   B 类 —— 依赖 api submodule 的检查（B1 读 api/openapi.json，B2 扫 api 源码里的
//           @Tool 注册）；submodule 未 checkout 时 **大声 skip 而不失败**，
//           让 A 类照常把关。
//
// 用法：
//   node scripts/docs-check.mjs             # 跑全部检查
//   node scripts/docs-check.mjs --verbose   # 额外打印解析出的端点集合 / MCP tool 集合（排查用）
//
// 退出码：有问题 1，全过 0。
//
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = path.join(ROOT, 'docs');
const OPENAPI = path.join(ROOT, 'api', 'openapi.json');

const DOC_09 = 'docs/shared/09-工程化规范.md';
const DOC_10 = 'docs/shared/10-接口契约与类型共享.md';
const DOC_02 = 'docs/backend/02-MCP与OpenAPI双协议.md';
const DOC_27 = 'docs/backend/27-接口暴露设计（DDD到API与MCP）.md';

// B2 扫描 MCP tool 注册用的代码根目录（api submodule 内的源码，非生成物）
const API_ROOT = path.join(ROOT, 'api');
const WEB_ROOT = path.join(ROOT, 'web');
const WEB_OPENAPI = path.join(WEB_ROOT, 'openapi.json');
const API_WS_PROTOCOL = path.join(API_ROOT, 'packages', 'contracts', 'src', 'ws-protocol.ts');
const WEB_WS_PROTOCOL = path.join(WEB_ROOT, 'src', 'types', 'ws-protocol.ts');
const API_SRC_ROOTS = ['apps', 'packages'].map((d) => path.join(API_ROOT, d));

const VERBOSE = process.argv.includes('--verbose');

// ---------------------------------------------------------------------------
// MCP 传输层端点排除清单（**只作用于 B1**，显式、带理由、可审计）
//
// 这三条不是"前端消费的 REST 业务端点"，因此**刻意不进 10 §6**（10 §6 的定位是
// "前后端唯一权威副本"——前端写 service、后端建 controller、Playwright 建 mock 都
// 以它对表）。它们由 `McpModule.forRoot({ transport: [SSE, STREAMABLE_HTTP, STDIO] })`
// 自动挂载（02 §6 Bootstrap），属于 MCP 协议面的传输管道，权威清单是 02 §5.2 的
// tool 列表而不是 REST 端点表；前端源码零引用（只出现在生成物 openapi.d.ts 里）。
//
// 维护纪律：往这里加一条 = 声明"这个 path 永远不该进 10 §6"，必须写清理由。
// 业务端点一律走"补进 10 §6 + 补进 27 §2–§9"，不许用排除清单绕过。
// ---------------------------------------------------------------------------
const TRANSPORT_ONLY_PATHS = new Map([
  ['/api/mcp', 'MCP Streamable HTTP 传输端点，@rekog/mcp-nest 自动挂载（02 §6）'],
  ['/api/sse', 'MCP HTTP+SSE 传输端点（旧传输的事件流），同上'],
  ['/api/messages', 'MCP HTTP+SSE 传输端点（旧传输的回帖通道），同上'],
]);

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
const rel = (p) => path.relative(ROOT, p);
const results = [];
const record = (cls, id, name, status, summary, details = []) =>
  results.push({ cls, id, name, status, summary, details });

/** 递归收集 docs/ 下的 .md */
function walkMd(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkMd(p, out);
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

/**
 * 只给"链接检查"用的清洗：
 *   ① 围栏代码块（``` / ~~~）整行清空——mermaid 节点标签里的 [文字](括号) 不是链接；
 *   ② 行内代码 span 清空——正文里举例写的链接语法不该被当成真链接。
 */
function stripCode(text) {
  let inFence = false;
  return text.split('\n').map((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return '';
    }
    return inFence ? '' : line.replace(/(`+)(?:(?!\1)[\s\S])*\1/g, '');
  });
}

const MD_FILES = walkMd(DOCS);
const readCache = new Map();
const read = (f) => {
  if (!readCache.has(f)) readCache.set(f, fs.readFileSync(f, 'utf8'));
  return readCache.get(f);
};

// ---------------------------------------------------------------------------
// A1 相对链接可达
// ---------------------------------------------------------------------------
function checkLinks() {
  let total = 0;
  const broken = [];
  for (const f of MD_FILES) {
    stripCode(read(f)).forEach((line, i) => {
      for (const m of line.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
        const target = m[1];
        if (/^(https?:|mailto:|#|<)/.test(target)) continue; // 外链/锚点不校验
        total += 1;
        const filePart = decodeURIComponent(target.split('#')[0]);
        if (!filePart) continue; // 纯锚点
        const abs = path.resolve(path.dirname(f), filePart);
        if (!fs.existsSync(abs)) {
          broken.push({
            where: `${rel(f)}:${i + 1}`,
            what: target,
            fix: `目标 ${rel(abs)} 不存在——改链接或补文件`,
          });
        }
      }
    });
  }
  if (broken.length === 0) {
    record('A', 'A1', '相对链接可达', 'ok', `${total} 条站内链接全部命中`);
  } else {
    record('A', 'A1', '相对链接可达', 'fail', `${total} 条站内链接中 ${broken.length} 条死链`,
      broken.map((b) => `${b.where}  ${b.what}\n        → ${b.fix}`));
  }
}

// ---------------------------------------------------------------------------
// A2 章节引用存在（`10 §6.2` / `P21-3 §5` / `F21-2 §4.1` …）
//
// 降级说明（**刻意**，见 09 §2.4）：本项做**逐级下探**而不是"全深度必须是标题"。
// 本仓大量 `§x.y` 指的是章节**正文内的编号条目**（P20 §9.4、P22 §4.11、17 §5.1
// 都是表格行/列表项，不是标题）。全深度硬校验会产生 48/2163 的误报，全是噪音。
// 规则：从最高一级开始逐级下探，某一级在目标文档里**存在同级标题兄弟**时才要求命中；
// 该级根本没有标题细分（说明引用的是节内条目）就停止下探。实测误报 0。
// ---------------------------------------------------------------------------
function buildDocIndex() {
  const idx = new Map();
  const add = (k, f) => {
    if (!idx.has(k)) idx.set(k, []);
    idx.get(k).push(f);
  };
  for (const f of MD_FILES) {
    const base = path.basename(f);
    const relPath = path.relative(DOCS, f);
    const page = base.match(/^(21-\d)-/); // 逐页规格：21-1 … 21-8
    if (page) {
      add(page[1], f);
      if (relPath.startsWith('product/')) add(`P${page[1]}`, f); // P21-x = 产品页
      if (relPath.startsWith('frontend/')) add(`F${page[1]}`, f); // F21-x = 前端页
      continue;
    }
    const numbered = base.match(/^(\d{2})-/);
    if (numbered) {
      add(numbered[1], f);
      if (relPath.startsWith('product/')) add(`P${numbered[1]}`, f); // P19–P22
    }
  }
  return idx;
}

/** 标题编号索引：full = 出现过的编号（含祖先）；byParent = 父编号 → 子编号集合 */
function headingIndex(file) {
  const full = new Set();
  const byParent = new Map();
  for (const line of read(file).split('\n')) {
    const m = line.match(/^#{1,6}\s+\**(\d+(?:\.\d+)*)[.、]?(?:\s|\*|$)/);
    if (!m) continue;
    const parts = m[1].split('.');
    for (let i = 1; i <= parts.length; i += 1) {
      const num = parts.slice(0, i).join('.');
      full.add(num);
      if (i > 1) {
        const parent = parts.slice(0, i - 1).join('.');
        if (!byParent.has(parent)) byParent.set(parent, new Set());
        byParent.get(parent).add(num);
      }
    }
  }
  return { full, byParent };
}

function checkSectionRefs() {
  const docIndex = buildDocIndex();
  const hCache = new Map();
  const heads = (f) => {
    if (!hCache.has(f)) hCache.set(f, headingIndex(f));
    return hCache.get(f);
  };

  const RE = /(?<![\w.\-/])((?:[PF]?21-\d)|(?:P?\d{2}))\s*§\s*(\d+(?:\.\d+)*)/g;
  let total = 0;
  const bad = [];

  for (const f of MD_FILES) {
    read(f).split('\n').forEach((line, i) => {
      for (const m of line.matchAll(RE)) {
        const [raw, key, sec] = m;
        total += 1;
        let files = docIndex.get(key);
        if (!files && /^P\d{2}$/.test(key)) files = docIndex.get(key.slice(1));
        if (!files) {
          bad.push({ where: `${rel(f)}:${i + 1}`, raw, why: `docs/ 下没有编号 ${key} 的文档` });
          continue;
        }
        const parts = sec.split('.');
        let hit = false;
        let why = '';
        for (const target of files) {
          const { full, byParent } = heads(target);
          if (!full.has(parts[0])) {
            why = `${path.basename(target)} 没有 §${parts[0]}`;
            continue;
          }
          let good = true;
          for (let d = 1; d < parts.length; d += 1) {
            const parent = parts.slice(0, d).join('.');
            const child = parts.slice(0, d + 1).join('.');
            const sibs = byParent.get(parent);
            if (!sibs || sibs.size === 0) break; // 该级无标题细分 → 视为节内条目
            if (!sibs.has(child)) {
              good = false;
              why = `${path.basename(target)} 的 §${parent} 下没有 §${child}（现有 ${[...sibs].join('、')}）`;
              break;
            }
          }
          if (good) {
            hit = true;
            break;
          }
        }
        if (!hit) bad.push({ where: `${rel(f)}:${i + 1}`, raw, why });
      }
    });
  }

  if (bad.length === 0) {
    record('A', 'A2', '章节引用存在', 'ok', `${total} 条 §引用全部命中（逐级下探口径）`);
  } else {
    record('A', 'A2', '章节引用存在', 'fail', `${total} 条 §引用中 ${bad.length} 条悬空`,
      bad.map((b) => `${b.where}  「${b.raw}」\n        → ${b.why}；改引用编号，或到目标文档补该章节`));
  }
}

// ---------------------------------------------------------------------------
// A3 README 清单完整
//   ① docs/**/*.md（README 自身除外）都要被某份索引（README.md）链到
//   ② 子目录索引本身要被 docs/README.md 链到（否则整条支线在主索引里不可达）
//   ③ 索引里的死链由 A1 兜（这里不重复报）
// ---------------------------------------------------------------------------
function checkReadmeInventory() {
  const rootReadme = path.join(DOCS, 'README.md');
  if (!fs.existsSync(rootReadme)) {
    record('A', 'A3', 'README 清单完整', 'skip', 'docs/README.md 不存在，跳过');
    return;
  }
  const indexes = MD_FILES.filter((f) => path.basename(f) === 'README.md');

  const linksOf = (f) => {
    const set = new Set();
    for (const line of stripCode(read(f))) {
      for (const m of line.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
        const t = m[1];
        if (/^(https?:|mailto:|#|<)/.test(t)) continue;
        const filePart = decodeURIComponent(t.split('#')[0]);
        if (!filePart) continue;
        set.add(path.resolve(path.dirname(f), filePart));
      }
    }
    return set;
  };

  const covered = new Set();
  for (const f of indexes) for (const t of linksOf(f)) covered.add(t);
  const rootLinks = linksOf(rootReadme);

  const missing = MD_FILES.filter((f) => path.basename(f) !== 'README.md' && !covered.has(f));
  const orphanIndexes = indexes.filter((f) => f !== rootReadme && !rootLinks.has(f));

  const details = [
    ...missing.map((f) => `${rel(f)} 未被任何 README 收录\n        → 到 ${rel(rootReadme)} 的「文档清单」补一行（含相对链接）`),
    ...orphanIndexes.map((f) => `子索引 ${rel(f)} 未被主索引链到\n        → 到 ${rel(rootReadme)} 的目录树/清单里补它的链接`),
  ];

  const summary = `${MD_FILES.length} 篇文档 / ${indexes.length} 份索引`;
  if (details.length === 0) record('A', 'A3', 'README 清单完整', 'ok', `${summary}，双向一致`);
  else record('A', 'A3', 'README 清单完整', 'fail', `${summary}，${details.length} 项缺口`, details);
}

// ---------------------------------------------------------------------------
// 端点解析（A4 / B1 共用）
//
// 只取**表格行的前两格**里反引号包裹的 `/api/...`：
//   10 §6.x 的表是 `| 方法 | 路径 | 备注 | 定义处 |`；
//   27 §2–§9 的表是 `| 能力 | REST | MCP | … |`。
// 两份文档"是哪个端点"都落在第 2 格，后面的备注/请求要点格里**大量顺带提到**别的
// 端点（"…的读取归 `GET /api/runtimes`"、"与 §6.1 的 `GET /api/providers` 不是同
// 一个端点"）。把整行都扫进来会让声明与提及混为一谈——删掉一整行声明也照样"命中"，
// 门禁就此失效（这条是实测负样本逼出来的）。正文、blockquote、代码块同理不算。
//
// 归一化：去 query、把 `:id` / `{id}` 统一成 `{}`，好让 10（`:id` 风格）、
// 27（`:id` 风格）、openapi.json（`{id}` 风格）三方可比。
// ---------------------------------------------------------------------------
function normPath(p) {
  return p
    .trim()
    .split('?')[0]
    .replace(/[.,;、，。)）]+$/, '')
    .replace(/\/:[A-Za-z0-9_]+/g, '/{}')
    .replace(/\/\{[A-Za-z0-9_]+\}/g, '/{}')
    .replace(/\/+$/, '');
}

/** 拆表格行的单元格（`\|` 是转义竖线，不是分隔符） */
function tableCells(row) {
  const parts = row.split(/(?<!\\)\|/); // 负向后顾：`\|` 是转义竖线，不当分隔符
  if (parts.length && parts[0].trim() === '') parts.shift(); // 行首 |
  if (parts.length && parts[parts.length - 1].trim() === '') parts.pop(); // 行尾 |
  return parts.map((c) => c.trim());
}

/** 抽取若干行里表格行**前两格**中的 /api 路径 → Map<归一化, 原文> */
function extractEndpoints(lines) {
  const found = new Map();
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith('|') || /^\|[\s|:-]*$/.test(t)) continue; // 只认表格行，跳过分隔行
    const declCells = tableCells(t).slice(0, 2).join(' ');
    let lastRaw = null; // 上一条路径的**原文**形态，供相对续写拼接（保持 :id 风格好读）
    for (const [, span] of declCells.matchAll(/`([^`]+)`/g)) {
      const abs = [...span.matchAll(/\/api\/[A-Za-z0-9_\-/:{}]+/g)].map((m) => m[0]);
      if (abs.length) {
        for (const a of abs) {
          const key = normPath(a);
          if (!found.has(key)) found.set(key, a);
          lastRaw = a;
        }
        continue;
      }
      // 同一行里的相对续写：`POST /api/sandboxes/:id/start` · `/stop`
      const sibling = span.trim().match(/^(\/[A-Za-z0-9_-]+)$/);
      if (sibling && lastRaw) {
        const derived = `${lastRaw.replace(/\/[^/]+$/, '')}${sibling[1]}`;
        const key = normPath(derived);
        if (!found.has(key)) found.set(key, derived);
        lastRaw = derived;
      }
    }
  }
  return found;
}

/** 截取文档里满足条件的标题区间（含其下正文与子标题） */
function sliceSections(file, wanted) {
  const out = [];
  let on = false;
  for (const line of read(file).split('\n')) {
    const m = line.match(/^(#{1,6})\s+(.*)$/);
    if (m) {
      const decided = wanted(m[1].length, m[2]);
      if (decided !== undefined) on = decided;
    }
    if (on) out.push(line);
  }
  return out;
}

const endpoints10 = () =>
  extractEndpoints(sliceSections(path.join(ROOT, DOC_10), (lvl, txt) => {
    if (lvl <= 2) return false; // 出了 ## 6 就关
    if (lvl === 3) return /^6\.[1-6]\b/.test(txt); // 6.1–6.6 是 REST 表；6.7 是 WS、6.8 是 envelope
    return undefined;
  }));

const endpoints27 = () =>
  extractEndpoints(sliceSections(path.join(ROOT, DOC_27), (lvl, txt) => {
    if (lvl === 2) return /^[2-9]\.\s/.test(txt); // ## 2 … ## 9 的能力表
    return undefined;
  }));

// ---------------------------------------------------------------------------
// A4 能力目录对账：27 §2–§9 覆盖的端点集合 == 10 §6 的端点集合
// ---------------------------------------------------------------------------
function checkCapabilityCatalog() {
  const a = endpoints10();
  const b = endpoints27();
  const onlyIn10 = [...a.keys()].filter((k) => !b.has(k)).sort();
  const onlyIn27 = [...b.keys()].filter((k) => !a.has(k)).sort();

  if (VERBOSE) {
    console.log(`  [verbose] 10 §6 解析出 ${a.size} 个端点：`);
    [...a.values()].sort().forEach((v) => console.log(`            ${v}`));
    console.log(`  [verbose] 27 §2–§9 解析出 ${b.size} 个端点：`);
    [...b.values()].sort().forEach((v) => console.log(`            ${v}`));
  }

  const summary = `10 §6 = ${a.size} 个端点，27 §2–§9 = ${b.size} 个端点`;
  if (onlyIn10.length === 0 && onlyIn27.length === 0) {
    record('A', 'A4', '能力目录对账', 'ok', `${summary}，集合相等`);
    return;
  }
  const details = [
    ...onlyIn10.map((k) => `10 §6 有、27 §2–§9 无：${a.get(k)}\n        → 到 ${DOC_27} 对应上下文的能力表补一行（能力名 / REST / MCP / command·query / 不变量 / 错误码 / WS 事件）`),
    ...onlyIn27.map((k) => `27 §2–§9 有、10 §6 无：${b.get(k)}\n        → 到 ${DOC_10} §6 对应小节补一行（方法 / 路径 / 备注 / 定义处）`),
  ];
  record('A', 'A4', '能力目录对账', 'fail', `${summary}，差集 ${details.length} 条`, details);
}

// ---------------------------------------------------------------------------
// B1 端点集合覆盖：10 §6 的路径集合 ⊇ openapi.json 的 paths（审计 P1-6）
// ---------------------------------------------------------------------------
function checkOpenapiCoverage() {
  if (!fs.existsSync(OPENAPI)) {
    record('B', 'B1', '端点集合覆盖', 'skip', `SKIP —— 找不到 ${rel(OPENAPI)}`, [
      '──────────────────────────────────────────────────────────────',
      'api submodule 未 checkout —— 本轮「没有人」在把关',
      '「后端加了端点却没同步 10 §6」这条漂移（09 §2.4 · 审计 P1-6）。',
      '  本地：git submodule update --init api',
      '  CI  ：给仓库配 SUBMODULE_TOKEN secret（见 .github/workflows/docs-check.yml）',
      '──────────────────────────────────────────────────────────────',
    ]);
    return;
  }

  let spec;
  try {
    spec = JSON.parse(fs.readFileSync(OPENAPI, 'utf8'));
  } catch (e) {
    record('B', 'B1', '端点集合覆盖', 'fail', `api/openapi.json 解析失败：${e.message}`, [
      '重新生成：cd api && pnpm openapi:emit',
    ]);
    return;
  }

  const doc = endpoints10();
  const apiPaths = Object.keys(spec.paths ?? {}).sort();
  const excluded = [];
  const missing = [];
  for (const p of apiPaths) {
    if (TRANSPORT_ONLY_PATHS.has(p)) {
      excluded.push(p);
      continue;
    }
    if (!doc.has(normPath(p))) missing.push(p);
  }
  const staleExclusions = [...TRANSPORT_ONLY_PATHS.keys()].filter((p) => !apiPaths.includes(p));

  const summary =
    `openapi ${apiPaths.length} 条 paths，排除传输层 ${excluded.length} 条，` +
    `余 ${apiPaths.length - excluded.length} 条`;

  if (missing.length === 0) {
    const extra = staleExclusions.length
      ? [`ℹ 排除清单里 ${staleExclusions.map((p) => `\`${p}\``).join('、')} 已不在 openapi 中，可以从 scripts/docs-check.mjs 的 TRANSPORT_ONLY_PATHS 摘掉`]
      : [];
    record('B', 'B1', '端点集合覆盖', 'ok', `${summary}全部 ⊆ 10 §6`, extra);
    return;
  }

  record('B', 'B1', '端点集合覆盖', 'fail', `${summary}，其中 ${missing.length} 条不在 10 §6`,
    missing.map((p) => {
      const methods = Object.keys(spec.paths[p])
        .filter((m) => ['get', 'post', 'put', 'patch', 'delete'].includes(m))
        .map((m) => m.toUpperCase())
        .join(' / ');
      return (
        `${methods} ${p}\n` +
        `        → 若是业务端点：到 ${DOC_10} §6 补一行，「同时」到 ${DOC_27} §2–§9 补能力表（否则 A4 会红）\n` +
        `        → 若是传输层/不该进权威清单：到 scripts/docs-check.mjs 的 TRANSPORT_ONLY_PATHS 加一条「带理由」的排除，并在 ${DOC_09} §2.4 说明`
      );
    }));
}

// ---------------------------------------------------------------------------
// B2 MCP tool 面对账：代码里实际注册的 tool 名集合 == 02 §5.2 标「✅ 已落地」的行
//
// 为什么要有这条：02 §5.2 与代码曾出现**双向漂移**——表里有 5 个从没注册过的
// （`start_sandbox` / `stop_sandbox` / `get_sandbox` / `exec_in_sandbox` /
// `run_agent_task`），而实际注册的 3 个 project tool（`get_project` /
// `retry_clone` / `delete_project`）表里根本没有。27 §12 的对账靠人工，抓不住。
//
// 口径：
//   ① 代码侧 = api 源码里 `@Tool({ name: '…' })` 的实际注册（排除 node_modules /
//      dist / 测试文件——那些不是运行期被 Nest 发现的 provider）；顺带校验带 @Tool
//      的类确实出现在某个 *.module.ts 里，否则装饰器写了也不会被注册；
//   ② 文档侧 = 02 §5.2 表格里「落地」列为 ✅ 的行；⏳ 的行是**设计中未注册**，
//      按定义就不该出现在代码里，**不参与相等判定**（但会被反向校验：⏳ 的 tool
//      若在代码里出现，说明落地了却忘了改状态，同样报错）；
//   ③ 顺带核对三处计数与本表同源：02 §5.2 的「合计」句、27 §1.3、27 §12
//      （09 §2.4「暴露面计数核对」里 MCP tools 那一行由此落地）。
// ---------------------------------------------------------------------------

/** 递归收集 api 源码里的 .ts（跳过依赖、构建产物、测试） */
function walkApiTs(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (['node_modules', 'dist', 'build', 'coverage', '.git', '.turbo'].includes(e.name)) continue;
      if (e.name === 'test' || e.name === '__tests__') continue; // 测试里的 @Tool 不是运行期注册
      walkApiTs(p, out);
    } else if (e.name.endsWith('.ts') && !/\.(spec|test|d)\.ts$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

/**
 * 从 `@Tool(` 处按括号配对切出实参文本（跳过字符串字面量里的括号）。
 * 返回 null 表示括号没配平（文件被截断之类），交给调用方报"无法静态解析"。
 */
function sliceCallArgs(src, openParenIdx) {
  let depth = 0;
  let quote = null;
  for (let i = openParenIdx; i < src.length; i += 1) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return src.slice(openParenIdx + 1, i);
    }
  }
  return null;
}

/** 代码侧：Map<toolName, "file:line">，外加 unresolved（无法静态解析的 @Tool） */
function scanRegisteredTools() {
  const tools = new Map();
  const unresolved = [];
  const toolClasses = new Map(); // 类名 → 首次出现的 file:line
  const moduleFiles = [];
  const files = API_SRC_ROOTS.flatMap((r) => walkApiTs(r));

  for (const f of files) {
    const src = read(f);
    if (f.endsWith('.module.ts')) moduleFiles.push(f);
    if (!src.includes('@Tool')) continue;
    const lineAt = (idx) => src.slice(0, idx).split('\n').length;

    for (const m of src.matchAll(/@Tool\s*\(/g)) {
      const open = m.index + m[0].length - 1;
      const where = `${rel(f)}:${lineAt(m.index)}`;
      // 装饰器所属的类：往前找最近的 `class X`
      const before = src.slice(0, m.index);
      const cls = [...before.matchAll(/\bclass\s+([A-Za-z0-9_$]+)/g)].pop();
      const args = sliceCallArgs(src, open);
      if (args === null) {
        unresolved.push({ where, why: '`@Tool(` 括号未配平，无法切出实参' });
        continue;
      }
      // 形态一：@Tool('name', …) —— 位置参数
      const positional = args.match(/^\s*(['"`])([A-Za-z0-9_.\-]+)\1/);
      // 形态二：@Tool({ name: 'x', … }) —— 对象参数（本仓实际形态）
      const named = args.match(/[{,]\s*name\s*:\s*(['"`])([A-Za-z0-9_.\-]+)\1/);
      const name = named?.[2] ?? positional?.[2];
      if (!name) {
        const snippet = args.replace(/\s+/g, ' ').trim().slice(0, 90);
        unresolved.push({
          where,
          why: `取不到字面量 tool 名（可能用了常量/模板串/展开）：@Tool(${snippet}${args.length > 90 ? '…' : ''})`,
        });
        continue;
      }
      if (!tools.has(name)) tools.set(name, where);
      if (cls && !toolClasses.has(cls[1])) toolClasses.set(cls[1], where);
    }
  }

  // 带 @Tool 的类必须被某个 *.module.ts 收进 providers，否则 Nest 根本发现不了它
  const moduleSrc = moduleFiles.map((f) => read(f)).join('\n');
  const orphanClasses = [...toolClasses.entries()]
    .filter(([cls]) => !new RegExp(`\\b${cls}\\b`).test(moduleSrc))
    .map(([cls, where]) => ({ cls, where }));

  return { tools, unresolved, orphanClasses, scanned: files.length };
}

/** 文档侧：02 §5.2 的 tool 表 → { registered, pending, malformed } */
function parseToolTable() {
  const file = path.join(ROOT, DOC_02);
  const lines = sliceSections(file, (lvl, txt) => {
    if (lvl <= 3) return /^5\.2\b/.test(txt); // 进 ### 5.2 开，遇到下一个 ≤### 标题关
    return undefined;
  });

  const registered = new Map(); // name → 表内原文行
  const pending = new Map();
  const malformed = [];

  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith('|') || /^\|[\s|:-]*$/.test(t)) continue;
    const cells = tableCells(t);
    if (cells.length < 4) continue; // 只认 4 列的 tool 表（Tool | 对应 REST | 落地 | 说明）
    const decl = cells[0];
    if (/^\**Tool\**$/.test(decl)) continue; // 表头
    // **只扫第 1 格（声明列）**——说明列里大量顺带提到别的 tool 名
    //（"调用方轮询 `list_projects` 或 `get_project`"），扫进来就分不清声明与提及了。
    const names = [...decl.matchAll(/`([^`]+)`/g)]
      .map((m) => m[1].trim())
      .filter((n) => /^[a-z][a-z0-9_]*$/.test(n));
    if (names.length === 0) continue;
    const status = cells[2];
    const ok = status.includes('✅');
    const wip = status.includes('⏳');
    if (ok === wip) {
      malformed.push(
        `02 §5.2 行「${names.join(' / ')}」的「落地」列是「${status}」，既不是 ✅ 也不是 ⏳\n` +
          `        → 落地列只接受 ✅（已注册）或 ⏳（设计中未注册），改成其中之一`,
      );
      continue;
    }
    for (const n of names) (ok ? registered : pending).set(n, t);
  }
  return { registered, pending, malformed };
}

/** 抓 "N 设计 / M 已注册" 与 "⏳ K 个设计中未注册[：名单]" 的所有出处 */
function parseToolCounts(docRel) {
  const file = path.join(ROOT, docRel);
  const out = [];
  read(file).split('\n').forEach((line, i) => {
    const pair =
      line.match(/(\d+)\s*设计\s*\/\s*\*{0,2}\s*(\d+)\s*已注册/) ||
      line.match(/设计\s*(\d+)\s*个[，,]\s*\*{0,2}已注册\s*(\d+)\s*个/);
    if (!pair) return;
    const wip = line.match(/⏳\s*(\d+)\s*个设计中未注册/);
    const namesAfter = line.includes('未注册：')
      ? line.slice(line.indexOf('未注册：'))
      : line.slice(pair.index + pair[0].length);
    const names = [...namesAfter.matchAll(/`([^`]+)`/g)]
      .map((m) => m[1].trim())
      .filter((n) => /^[a-z][a-z0-9_]*$/.test(n));
    out.push({
      where: `${docRel}:${i + 1}`,
      design: Number(pair[1]),
      registered: Number(pair[2]),
      wip: wip ? Number(wip[1]) : null,
      names,
    });
  });
  return out;
}

function checkMcpToolParity() {
  const apiUsable = API_SRC_ROOTS.some((d) => fs.existsSync(d));
  if (!apiUsable) {
    record('B', 'B2', 'MCP tool 面对账', 'skip', `SKIP —— 找不到 ${rel(API_SRC_ROOTS[1])}`, [
      '──────────────────────────────────────────────────────────────',
      'api submodule 未 checkout —— 本轮「没有人」在把关',
      '「代码注册了 tool 却没同步 02 §5.2」/「表里挂着从没注册过的 tool」这类',
      '双向漂移（09 §2.4 · B2）。',
      '  本地：git submodule update --init api',
      '  CI  ：给仓库配 SUBMODULE_TOKEN secret（见 .github/workflows/docs-check.yml）',
      '──────────────────────────────────────────────────────────────',
    ]);
    return;
  }

  const code = scanRegisteredTools();
  const doc = parseToolTable();

  if (VERBOSE) {
    console.log(`  [verbose] api 源码扫了 ${code.scanned} 个 .ts，解析出 ${code.tools.size} 个已注册 tool：`);
    [...code.tools.entries()].sort().forEach(([n, w]) => console.log(`            ${n}  (${w})`));
    console.log(`  [verbose] 02 §5.2 ✅ ${doc.registered.size} 个 / ⏳ ${doc.pending.size} 个：`);
    console.log(`            ✅ ${[...doc.registered.keys()].sort().join('、') || '(空)'}`);
    console.log(`            ⏳ ${[...doc.pending.keys()].sort().join('、') || '(空)'}`);
  }

  const details = [...doc.malformed];

  for (const u of code.unresolved) {
    details.push(
      `无法静态解析的 @Tool：${u.where}\n` +
        `        → ${u.why}\n` +
        `        → 把 tool 名写成字面量（\`@Tool({ name: 'xxx' })\`），否则门禁看不见它`,
    );
  }
  for (const o of code.orphanClasses) {
    details.push(
      `${o.cls} 带 @Tool 但没出现在任何 *.module.ts（${o.where}）\n` +
        `        → 它不会被 Nest 发现，等于没注册；把它加进对应模块的 providers`,
    );
  }

  // ① 核心判据：代码集合 == 02 §5.2 的 ✅ 集合
  const onlyInCode = [...code.tools.keys()].filter((n) => !doc.registered.has(n)).sort();
  const onlyInDoc = [...doc.registered.keys()].filter((n) => !code.tools.has(n)).sort();

  for (const n of onlyInCode) {
    if (doc.pending.has(n)) {
      details.push(
        `\`${n}\` 代码里已注册（${code.tools.get(n)}），但 02 §5.2 仍标 ⏳ 设计中未注册\n` +
          `        → 到 ${DOC_02} §5.2 把该行「落地」列改成 ✅，并同步末尾「合计」句与 27 §1.3 / §12 的计数`,
      );
    } else {
      details.push(
        `\`${n}\` 代码里已注册（${code.tools.get(n)}），02 §5.2 表里没有这一行\n` +
          `        → 到 ${DOC_02} §5.2 补一行（Tool / 对应 REST / 落地=✅ / 说明），并同步「合计」句与 27 §1.3 / §12 的计数`,
      );
    }
  }
  for (const n of onlyInDoc) {
    details.push(
      `\`${n}\` 在 02 §5.2 标为 ✅ 已落地，但代码里没有对应的 \`@Tool({ name: '${n}' })\`\n` +
        `        → 要么到 api 的 \`*.mcp-tools.ts\` 里真的注册它，要么把该行「落地」列改回 ⏳（并同步各处计数）`,
    );
  }

  // ② 三处计数与本表同源（02 §5.2 合计句 / 27 §1.3 / 27 §12）
  const design = doc.registered.size + doc.pending.size;
  const counted = [...parseToolCounts(DOC_02), ...parseToolCounts(DOC_27)];
  if (counted.length === 0) {
    details.push(
      `没在 ${DOC_02} / ${DOC_27} 里找到任何「N 设计 / M 已注册」计数句\n` +
        `        → 计数句是 B2 顺带核对的对象，被删掉就没人盯计数漂移了；补回去`,
    );
  }
  for (const c of counted) {
    if (c.design !== design || c.registered !== doc.registered.size) {
      details.push(
        `${c.where} 的计数「${c.design} 设计 / ${c.registered} 已注册」与 02 §5.2 表实际（${design} 设计 / ${doc.registered.size} 已注册）不符\n` +
          `        → 02 §5.2 表是权威，改这一处的数字`,
      );
    }
    if (c.wip !== null && c.wip !== doc.pending.size) {
      details.push(
        `${c.where} 的「⏳ ${c.wip} 个设计中未注册」与 02 §5.2 表实际（${doc.pending.size} 个 ⏳）不符\n` +
          `        → 改这一处的数字`,
      );
    }
    // 计数句后面若列了名单，名单也要与表一致（列了就得对，没列不强求）
    if (c.names.length > 0) {
      const expect = c.registered === c.names.length ? doc.registered : doc.pending;
      const label = expect === doc.registered ? '✅ 已注册' : '⏳ 未注册';
      const extra = c.names.filter((n) => !expect.has(n)).sort();
      const miss = [...expect.keys()].filter((n) => !c.names.includes(n)).sort();
      if (extra.length || miss.length) {
        details.push(
          `${c.where} 列的 tool 名单与 02 §5.2 的「${label}」集合不一致` +
            `${extra.length ? `；名单多出 ${extra.map((n) => `\`${n}\``).join('、')}` : ''}` +
            `${miss.length ? `；名单漏了 ${miss.map((n) => `\`${n}\``).join('、')}` : ''}\n` +
            `        → 以 02 §5.2 表为准改这一处的名单`,
        );
      }
    }
  }

  const summary =
    `代码注册 ${code.tools.size} 个 tool，02 §5.2 = ${design} 设计 / ${doc.registered.size} 已注册`;
  if (details.length === 0) {
    record('B', 'B2', 'MCP tool 面对账', 'ok',
      `${summary}，集合相等（${doc.pending.size} 个 ⏳ 不参与判定），${counted.length} 处计数句同源`);
    return;
  }
  record('B', 'B2', 'MCP tool 面对账', 'fail', `${summary}，${details.length} 项不一致`, details);
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
console.log('▶ docs:check —— 文档一致性门禁（权威定义：docs/shared/09-工程化规范.md §2.4）');
console.log(`  仓库：${ROOT}`);
console.log('');

checkLinks();
checkSectionRefs();
checkReadmeInventory();
checkCapabilityCatalog();
checkOpenapiCoverage();
checkMcpToolParity();
checkOpenapiCrossRepo();
checkWsProtocolCrossRepo();

// ---------------------------------------------------------------------------
// B3 openapi 跨仓一致：api/openapi.json 与 web/openapi.json 必须逐字节相同
//
// 为什么需要它：两个仓各自都有「漂移门禁」，但各自只跟【自己那份】比 —— web CI 跑
// `generate:api && git diff src/types/generated/`（拿 web 自己的 openapi 重生成），
// api CI 只在 api 内部 emit 后比。**跨仓那一跳靠人手动拷贝**，谁都发现不了
// 「后端改了契约、没人把 openapi.json 同步过来」。S6 集成审查实测确认了这个空档。
// 主仓同时持有两个 submodule，所以这条检查在这里零成本。
// ---------------------------------------------------------------------------
function checkOpenapiCrossRepo() {
  const missing = [OPENAPI, WEB_OPENAPI].filter((f) => !fs.existsSync(f));
  if (missing.length > 0) {
    record('B', 'B3', 'openapi 跨仓一致', 'skip',
      `SKIP —— 找不到 ${missing.map(rel).join('、')}`,
      ['submodule 未 checkout ⇒ 本轮没有人在把关「后端改了契约但没同步到 web」这条漂移',
       '  本地：git submodule update --init api web']);
    return;
  }
  const a = fs.readFileSync(OPENAPI);
  const b = fs.readFileSync(WEB_OPENAPI);
  const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12);
  if (a.equals(b)) {
    record('B', 'B3', 'openapi 跨仓一致', 'ok', `两份 openapi.json 逐字节相同（sha256 ${sha(a)}…）`);
    return;
  }
  record('B', 'B3', 'openapi 跨仓一致', 'fail',
    `两份 openapi.json 不一致（api ${sha(a)}… / web ${sha(b)}…，${a.length} vs ${b.length} 字节）`,
    ['前端的生成类型是从 web/openapi.json 出的 ⇒ 不同步意味着前端在照一份【过期契约】编译，而且两边 CI 都是绿的。',
     '  修复：cd api && pnpm openapi:emit && cp openapi.json ../web/openapi.json && cd ../web && pnpm generate:api']);
}

// ---------------------------------------------------------------------------
// B4 WS 协议跨仓对账：两仓的 WS_PROTOCOL_CANONICAL 字面量必须相同
//
// 为什么需要它：REST 面有 openapi codegen 兜着，**WS 面是三份手抄**
// （10 §7.4 ↔ api contracts ↔ web types），零 codegen、零门禁。S6 增量的主体恰恰
// 是 WS，而原有六项检查一条都碰不到它。这条不比较结构（那会脆），只比较两仓各自
// 声明的 canonical 字面量 —— 改帧形状就必须两边同时改，与 WS_SCHEMA_HASH 的
// 「钉死字面量」纪律同款。
// ---------------------------------------------------------------------------
function checkWsProtocolCrossRepo() {
  const missing = [API_WS_PROTOCOL, WEB_WS_PROTOCOL].filter((f) => !fs.existsSync(f));
  if (missing.length > 0) {
    record('B', 'B4', 'WS 协议跨仓对账', 'skip',
      `SKIP —— 找不到 ${missing.map(rel).join('、')}`,
      ['submodule 未 checkout ⇒ 本轮没有人在把关 WS 帧形状的跨仓漂移']);
    return;
  }
  const pick = (f) => {
    const src = fs.readFileSync(f, 'utf8');
    const m = /WS_PROTOCOL_CANONICAL\s*[:=][^'"`]*((?:'[^']*'|`[^`]*`)(?:\s*\+\s*(?:'[^']*'|`[^`]*`))*)/.exec(src);
    if (!m) return null;
    return [...m[1].matchAll(/'([^']*)'|`([^`]*)`/g)].map((x) => x[1] ?? x[2]).join('');
  };
  const a = pick(API_WS_PROTOCOL);
  const b = pick(WEB_WS_PROTOCOL);
  if (a === null || b === null) {
    const who = [a === null && rel(API_WS_PROTOCOL), b === null && rel(WEB_WS_PROTOCOL)].filter(Boolean);
    record('B', 'B4', 'WS 协议跨仓对账', 'fail',
      `${who.join('、')} 里没有 WS_PROTOCOL_CANONICAL`,
      ['两仓都必须导出同一个 canonical 字面量，否则 WS 帧形状没有任何跨仓约束（S6 集成审查发现）。']);
    return;
  }
  if (a === b) {
    record('B', 'B4', 'WS 协议跨仓对账', 'ok', `两仓 canonical 一致（${a.length} 字符）`);
    return;
  }
  const at = a.split('|');
  const bt = b.split('|');
  const only = (xs, ys) => xs.filter((x) => !ys.includes(x));
  record('B', 'B4', 'WS 协议跨仓对账', 'fail', 'WS 帧形状在两仓之间漂移了',
    [...only(at, bt).map((x) => `仅 api 有：${x}`),
     ...only(bt, at).map((x) => `仅 web 有：${x}`),
     '改帧形状必须两仓同时改（10 §7.4 是权威定义）。这条漂移编译期发现不了，只会在运行时表现为「某种帧收不到」。']);
}

const ICON = { ok: '✔', fail: '✗', skip: '⚠' };

/** 终端显示宽度：CJK / 全角算 2 列，用于把检查名对齐成一栏 */
const width = (s) => [...s].reduce((n, ch) => n + (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/.test(ch) ? 2 : 1), 0);
const NAME_COL = Math.max(...results.map((r) => width(r.name)));
const padName = (s) => s + ' '.repeat(Math.max(0, NAME_COL - width(s)));

const GROUPS = [
  ['A', 'A. 文档内部检查（不依赖 submodule，始终跑）'],
  ['B', 'B. 依赖 api submodule 的检查（openapi.json / api 源码；缺失即 skip，不判失败）'],
];

for (const [cls, title] of GROUPS) {
  const items = results.filter((r) => r.cls === cls);
  if (items.length === 0) continue;
  console.log(title);
  for (const r of items) {
    console.log(`  ${ICON[r.status]} ${r.id} ${padName(r.name)}  ${r.summary}`);
    if (r.status === 'skip') {
      for (const d of r.details) console.log(`      ${d}`);
    } else if (r.status === 'fail') {
      for (const d of r.details) console.log(`      · ${d}`);
    } else {
      for (const d of r.details) console.log(`      ${d}`);
    }
  }
  console.log('');
}

const failed = results.filter((r) => r.status === 'fail');
const skipped = results.filter((r) => r.status === 'skip');

if (failed.length > 0) {
  console.log(`✗ docs:check 未通过：${failed.length}/${results.length} 项检查失败（${failed.map((r) => r.id).join('、')}）`);
  console.log('  按上面每条的「→」提示补文档；改完重跑 `node scripts/docs-check.mjs`。');
  process.exit(1);
}

if (skipped.length > 0) {
  console.log(`✔ docs:check 通过：${results.length - skipped.length} 项检查全绿，${skipped.length} 项 skip（${skipped.map((r) => r.id).join('、')}）`);
} else {
  console.log(`✔ docs:check 通过：${results.length} 项检查全绿。`);
}
process.exit(0);
