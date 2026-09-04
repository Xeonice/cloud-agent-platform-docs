#!/usr/bin/env node
/**
 * 跨仓**取值镜像**检查（29 §3.7）—— 层 3：契约管不住的那些值。
 *
 * ── 它守的是什么 ─────────────────────────────────────────────────────────────
 * `docs:check` 的 B3 守「两份 openapi 逐字节相同」（静态定义同源），`e2e-contract/`
 * 守「两边运行时对得上」（6 条真链路）。两者中间还剩一格：**契约表达不了取值域的字段**
 * —— 259 个 DTO 字段里 100 个是自由 `string`（`format`/`enum` 都收不住的那一类）。
 * 前端替身对这些字段可以写任何值，没有任何东西会红。
 *
 * ⚠️ **但不是这 100 个都值得管。** 实测（2026-09-04）：61 个长在响应侧，其中
 * **9 个前端根本没读**，约 47 个只是**原样渲染或当不透明 key**（值漂了没有可观测后果），
 * 真正**按值分支**的只有个位数。所以本检查⛔ **不做全字段比对** —— 那会得到一台误报机器
 * （实测把「录一份真响应 → 逐字段比形状」跑一遍是 69 行差异、其中 3 行值得看，噪声 96%）。
 *
 * 它只管一类东西，判据极窄：**替身里自称「抄自后端某处」的值，必须真的等于后端那一处**。
 * 这类值有一个共同特征 —— 依据写在**注释里**，而注释不会红。
 *
 * ── 为什么不用「录真后端响应」当判据 ─────────────────────────────────────────
 * ⛔ 实测过，不成立：`e2e-contract/server/start-api.ts` 为了能在无 docker 的 CI 里跑，
 * 必须把 provider registry 换成 `_fakes.ts#makeFakeRegistry`。于是
 * `GET /api/providers` 录到的能力位是 **`_fakes.ts#CAPS` 的值**，不是
 * `aio-sandbox.provider.ts` 的值 —— 两者今天恰好相等，纯属有人手工同步过。
 * 拿它当契约样本，等于**把第二层替身固化成第一层替身的判据**。
 * ⇒ 判据必须取**声明处的源码**，不是任何一次运行的输出。
 *
 * ── 判据（每条都点名 api 侧的唯一权威声明处）────────────────────────────────
 *  M1 provider 能力位 —— `api/…/providers/{aio,boxlite}/*-sandbox.provider.ts`
 *     的 `readonly capabilities` ⟷ `web/src/mocks/handlers.ts#PROVIDER_REGISTRY`
 *  M2 runtime 注册表身份 —— `api/…/adapters/{codex,claude-code}/*.adapter.ts`
 *     的 `readonly id/displayName/vendor` + `getAuthMethods()`
 *     ⟷ `web/src/mocks/handlers.ts#RUNTIME_REGISTRY`
 *
 * ⛔ **`web/e2e/**` 的 `providerCaps()` 刻意不在管辖内**：那个 helper 的注释明写
 * 「每条用例按自己要走的分支挑值」，它**不自称是镜像**。把它一并管起来会立刻误伤
 * 一批合法的场景取值 —— 那正是本文件开头拒绝的那种宽判据。
 *
 * ⚠️ **不是阻断门禁**（29 §3.3.4 / §3.1.1 同一条工程现实：新门禁第一周误伤就会被
 * `--no-verify` 绕过或关掉）。手动跑 `node scripts/check-fixture-values.mjs`，
 * 或挂在非 PR 的 workflow 上。exit code 有意义，方便将来升级。
 *
 * ⛔ 不用正则，走 TypeScript AST（与 `web/scripts/check-mock-contract-anchoring.ts` 同一条
 * 教训：正则扫 TS 的误报率 10–20%）。
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const API = join(REPO, 'api');
const WEB = join(REPO, 'web');

// ── TypeScript 从子仓借 ──────────────────────────────────────────────────────
// 主仓没有 node_modules（package.json 只有 docs:check 一条脚本）。三个候选按可用性挑，
// 都没有就**大声跳过**（⛔ 不静默返回 0：那会让「没跑」看起来像「跑绿了」）。
const TS_CANDIDATES = ['e2e-contract', 'web', 'api'].map((d) =>
  join(REPO, d, 'node_modules', 'typescript', 'package.json'),
);
const tsHost = TS_CANDIDATES.find((p) => existsSync(p));
if (tsHost === undefined) {
  console.error('✗ 找不到 typescript（试过 e2e-contract / web / api 的 node_modules）。');
  console.error('  先在其中任一处 pnpm install 再跑。⛔ 不当作通过。');
  process.exit(2);
}
const ts = createRequire(tsHost)('typescript');

function parse(file) {
  return ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
}

// ── 极小字面量求值器 ─────────────────────────────────────────────────────────
// 只认四种形态：字符串/布尔字面量、数组字面量、指向顶层 const 的标识符、
// 顶层 const 对象字面量的属性访问。其余一律 `undefined` ⇒ 由调用方报「读不出」，
// ⛔ 不猜。猜出来的值会让这份检查自己变成一个替身。
function topLevelConsts(sf) {
  const env = new Map();
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    for (const d of st.declarationList.declarations) {
      if (ts.isIdentifier(d.name) && d.initializer !== undefined) env.set(d.name.text, d.initializer);
    }
  }
  return env;
}

function evalNode(node, env, depth = 0) {
  if (node === undefined || depth > 6) return undefined;
  if (ts.isAsExpression(node) || ts.isParenthesizedExpression(node)) return evalNode(node.expression, env, depth + 1);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isArrayLiteralExpression(node)) {
    const out = [];
    for (const e of node.elements) {
      const v = evalNode(e, env, depth + 1);
      if (v === undefined) return undefined;
      out.push(v);
    }
    return out;
  }
  if (ts.isIdentifier(node)) return evalNode(env.get(node.text), env, depth + 1);
  if (ts.isPropertyAccessExpression(node)) {
    const obj = evalNode(node.expression, env, depth + 1);
    if (obj !== undefined && typeof obj === 'object' && !Array.isArray(obj)) return obj[node.name.text];
    return undefined;
  }
  if (ts.isObjectLiteralExpression(node)) {
    const out = {};
    for (const p of node.properties) {
      if (!ts.isPropertyAssignment(p)) continue;
      const key = ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : undefined;
      if (key === undefined) continue;
      const v = evalNode(p.initializer, env, depth + 1);
      if (v !== undefined) out[key] = v;
    }
    return out;
  }
  return undefined;
}

/** 找 class 里 `readonly <name> = <literal>` / `<name>: T = <literal>`。 */
function classProp(sf, name) {
  let found;
  const visit = (n) => {
    if (ts.isPropertyDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name) {
      found = evalNode(n.initializer, topLevelConsts(sf));
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(sf, visit);
  return found;
}

/** 找 class 里 `<name>(): T { return <literal>; }` 的那个 return。 */
function classMethodReturn(sf, name) {
  let found;
  const visit = (n) => {
    if (ts.isMethodDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name) {
      for (const st of n.body?.statements ?? []) {
        if (ts.isReturnStatement(st)) found = evalNode(st.expression, topLevelConsts(sf));
      }
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(sf, visit);
  return found;
}

const problems = [];
const checked = [];
function compare(mirror, key, expected, actual, sourceHint) {
  checked.push(`${mirror}.${key}`);
  const e = JSON.stringify(expected);
  const a = JSON.stringify(actual);
  if (a === undefined || actual === undefined) {
    problems.push({ mirror, key, kind: '读不出替身里的值', expected: e, actual: '(读不出)', sourceHint });
    return;
  }
  if (e !== a) problems.push({ mirror, key, kind: '与后端声明不一致', expected: e, actual: a, sourceHint });
}

// ── M1 · provider 能力位 ─────────────────────────────────────────────────────
const PROVIDER_SOURCES = {
  aio: join(API, 'packages/modules/sandbox/src/infrastructure/providers/aio/aio-sandbox.provider.ts'),
  boxlite: join(API, 'packages/modules/sandbox/src/infrastructure/providers/boxlite/boxlite-sandbox.provider.ts'),
};
const HANDLERS = join(WEB, 'src/mocks/handlers.ts');
for (const f of [...Object.values(PROVIDER_SOURCES), HANDLERS]) {
  if (!existsSync(f)) {
    console.error(`✗ 找不到 ${f} —— submodule 没拉？⛔ 不当作通过。`);
    process.exit(2);
  }
}

const handlersSf = parse(HANDLERS);
const handlersEnv = topLevelConsts(handlersSf);
const providerRegistry = evalNode(handlersEnv.get('PROVIDER_REGISTRY'), handlersEnv);
const runtimeRegistryNode = handlersEnv.get('RUNTIME_REGISTRY');

for (const [name, file] of Object.entries(PROVIDER_SOURCES)) {
  const declared = classProp(parse(file), 'capabilities');
  if (declared === undefined) {
    problems.push({ mirror: 'M1', key: name, kind: '读不出后端声明', expected: '(读不出)', actual: '-', sourceHint: file });
    continue;
  }
  const row = (providerRegistry ?? []).find((p) => p?.name === name);
  for (const bit of Object.keys(declared)) {
    compare('M1 provider 能力位', `${name}.${bit}`, declared[bit], row?.capabilities?.[bit], file);
  }
}

// ── M2 · runtime 注册表身份 ──────────────────────────────────────────────────
const ADAPTERS = {
  codex: join(API, 'packages/modules/runtime/src/infrastructure/adapters/codex/codex.adapter.ts'),
  'claude-code': join(API, 'packages/modules/runtime/src/infrastructure/adapters/claude-code/claude-code.adapter.ts'),
};

/**
 * `RUNTIME_REGISTRY` 的元素是 `runtimeDto({…})` 调用（工厂带默认值），不是裸对象字面量
 * ⇒ 取实参那个对象字面量来比。工厂补的默认值不在管辖内：本检查只管**替身显式写下的**
 * 那几个自称抄自后端的值。
 */
function runtimeMirrorRows() {
  const node = runtimeRegistryNode;
  if (node === undefined || !ts.isArrayLiteralExpression(node)) return [];
  const rows = [];
  for (const el of node.elements) {
    const call = ts.isAsExpression(el) ? el.expression : el;
    if (!ts.isCallExpression(call) || call.arguments.length === 0) continue;
    const v = evalNode(call.arguments[0], handlersEnv);
    if (v !== undefined) rows.push(v);
  }
  return rows;
}
const runtimeRows = runtimeMirrorRows();

for (const [id, file] of Object.entries(ADAPTERS)) {
  if (!existsSync(file)) {
    problems.push({ mirror: 'M2', key: id, kind: '找不到后端 adapter', expected: '-', actual: '-', sourceHint: file });
    continue;
  }
  const sf = parse(file);
  const declared = {
    id: classProp(sf, 'id'),
    displayName: classProp(sf, 'displayName'),
    vendor: classProp(sf, 'vendor'),
    authMethods: classMethodReturn(sf, 'getAuthMethods'),
  };
  const row = runtimeRows.find((r) => r?.id === id);
  if (row === undefined) {
    problems.push({ mirror: 'M2 runtime 身份', key: id, kind: '替身注册表里没有这个 runtime', expected: id, actual: '(缺席)', sourceHint: file });
    continue;
  }
  for (const k of Object.keys(declared)) {
    if (declared[k] === undefined) {
      problems.push({ mirror: 'M2 runtime 身份', key: `${id}.${k}`, kind: '读不出后端声明', expected: '(读不出)', actual: '-', sourceHint: file });
      continue;
    }
    compare('M2 runtime 身份', `${id}.${k}`, declared[k], row[k], file);
  }
}

// ── 报告 ─────────────────────────────────────────────────────────────────────
console.log(`跨仓取值镜像检查：比对 ${String(checked.length)} 个值（M1 provider 能力位 + M2 runtime 身份）`);
if (problems.length === 0) {
  console.log('✓ 全部与后端声明处一致。');
  process.exit(0);
}
console.log(`\n✗ ${String(problems.length)} 处对不上：\n`);
for (const p of problems) {
  console.log(`  · [${p.mirror}] ${p.key} —— ${p.kind}`);
  console.log(`      后端声明: ${p.expected}`);
  console.log(`      替身写的: ${p.actual}`);
  console.log(`      权威来源: ${p.sourceHint.replace(REPO + '/', '')}`);
}
console.log('\n⚠️ 替身的值以后端声明处为准。⛔ 不要反过来改后端来迁就替身。');
process.exit(1);
