/**
 * 种子数据 —— ⛔ **一律走真 API，不写 sqlite**（29 §3.1.1）。
 *
 * 理由是那一节的原话：绕过业务逻辑造出来的状态，可能是真实系统**永远不会产生**的；
 * 拿它去验契约，等于验一个不存在的契约。所以这里没有一行 SQL，只有 `fetch`。
 *
 * ⚠️ 这些 `fetch` 是从 **Node 侧**（playwright 的 test 进程）直接打后端的，
 * **不经过浏览器**。它是「把世界摆成某个样子」的手段，不是被测链路本身 ——
 * 被测链路永远是「浏览器 → Next rewrites → 真后端」，而且⛔ 前端不挂任何 `page.route`。
 */
const API = `http://127.0.0.1:${process.env['CONTRACT_API_PORT'] ?? '3110'}`;

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${String(res.status)} ${raw}`);
  }
  return (raw === '' ? undefined : JSON.parse(raw)) as T;
}

/** 控制面（`server/start-api.ts` 文件头解释了它为什么不算作弊）。 */
async function ctl<T>(path: string, body: unknown = {}): Promise<T> {
  return call<T>('POST', `/__contract__/${path}`, body);
}

/** 每条用例各建各的项目 ⇒ 顺序无关。名字带随机后缀，避免与上一轮的残留撞名。 */
export function uniq(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 完成初始化。⚠️ **一次性**：已初始化再调是 409（`InitializationService` 明写不幂等），
 * 所以这里吞掉那一种 409、且**只吞那一种**——吞宽了就会把真失败当成「已经好了」。
 *
 * `acknowledgeOffline: true` 是为 CI 准备的：那里没有外网，模型 API 全挂会被
 * `OFFLINE_NOT_ACKNOWLEDGED` 挡下，而这一层不验「离线要不要拦」（那有它自己的 e2e）。
 */
export async function ensureInitialized(): Promise<void> {
  const res = await fetch(`${API}/api/system/init`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ acknowledgeOffline: true }),
  });
  if (res.ok) return;
  const body = (await res.json()) as { code?: string };
  if (res.status === 409 && body.code === 'ALREADY_INITIALIZED') return;
  throw new Error(`POST /api/system/init → ${String(res.status)} ${JSON.stringify(body)}`);
}

export interface SeededProject {
  id: string;
  name: string;
}

export async function createEmptyProject(name = uniq('contract')): Promise<SeededProject> {
  const p = await call<{ id: string }>('POST', '/api/projects', { name, sourceType: 'empty' });
  return { id: p.id, name };
}

/**
 * 一个 **git** 项目。
 *
 * ⚠️ 为什么非要 git 不可：`ProjectInfoBar` 对 `sourceType==='empty'` 的项目**读的是
 * `createdAt`**，`updatedAt` 根本不上屏（`isEmptyProject ? createdAt : updatedAt ?? createdAt`）。
 * 而漂移 6 恰恰是 `ProjectResponseDto.updatedAt`。⇒ 只有 git 项目才让那个字段
 * **真的被读**，用例才有分辨力。
 *
 * `invalid.invalid` 是 RFC 2606 保留的**永远解析不了**的 TLD：克隆必然快速失败
 * （实测 <3s），既不依赖外网可达性，也不会挂在超时上。克隆失败不影响本用例 ——
 * 它要的只是「库里有一行 git 项目，它带着 `updatedAt`」。
 */
export async function createGitProject(name = uniq('contract-git')): Promise<SeededProject> {
  const p = await call<{ id: string }>('POST', '/api/projects', {
    name,
    sourceType: 'git',
    repoUrl: 'https://invalid.invalid/contract/e2e.git',
  });
  return { id: p.id, name };
}

export interface SeededAutomation {
  id: string;
  name: string;
  nextTriggerAt: string;
  createdAt: string;
}

export async function createAutomation(
  projectId: string,
  overrides: Record<string, unknown> = {},
): Promise<SeededAutomation> {
  const name = uniq('rule');
  const a = await call<SeededAutomation>('POST', `/api/projects/${projectId}/automations`, {
    name,
    runtime: 'codex',
    prompt: 'summarise yesterday的错误日志',
    scheduleKind: 'daily',
    scheduleConfig: { time: '03:00' },
    timezone: 'UTC',
    timeoutMinutes: 120,
    artifactRetentionDays: 7,
    ...overrides,
  });
  return { ...a, name };
}

export interface RuntimeDto {
  id: string;
  credentialStatus: string;
  activeAuthMethod?: string;
  maskedIdentifier?: string;
}

export async function runtimeOf(runtime: string): Promise<RuntimeDto> {
  const all = await call<RuntimeDto[]>('GET', '/api/runtimes');
  const found = all.find((r) => r.id === runtime);
  if (found === undefined) throw new Error(`runtime '${runtime}' not in GET /api/runtimes`);
  return found;
}

/** runtime 凭证（决策表行 2 的前提：没有它，每一发都会被判成 `AUTH_EXPIRED`）。 */
export async function ensureRuntimeApiKey(
  runtime = 'codex',
  secret = 'sk-contract-e2e-0123456789abcdef',
): Promise<void> {
  const all = await call<RuntimeDto[]>('GET', '/api/runtimes');
  if (all.find((r) => r.id === runtime)?.credentialStatus === 'active') return;
  await call('POST', `/api/runtimes/${runtime}/credentials/secret`, { method: 'api-key', secret });
}

/**
 * 把 git 凭证清空 —— ⚠️ **不是洁癖，是这条用例的前置条件**：
 * 「配置 HTTPS Token」这个按钮只在**空态**下存在（有卡片时它变成 [更换]）。
 * 本机跑第二遍时 `reuseExistingServer` 会复用上一轮的进程，库里还留着上一轮那条，
 * 于是用例会红在「找不到按钮」上 —— 一条**红在环境上、不红在契约上**的用例，
 * 正是 §3.1.1 特意要区分开的那一种。
 */
export async function resetGitCredentials(): Promise<void> {
  const list = await call<{ id: string }[]>('GET', '/api/credentials?kind=git');
  for (const c of list) await call('DELETE', `/api/credentials/git/${c.id}`);
}

export interface RunDto {
  status: string;
  retryCount: number;
  errorCode?: string;
}

/**
 * 把一条规则推到「⑤ 次排队重试都没等到资源」的终态 —— 也就是**唯一**能产出
 * `errorCode: 'RESOURCE_EXHAUSTED'` 的路径（漂移 1 要的那个第 3 个取值）。
 *
 * ⚠️ **§3.1.1 里「`SCHEDULER_HOST_CORES=1` 就能造出 `RESOURCE_EXHAUSTED`」这句站不住**，
 * 实测：容量压到 1 核只会得到 `status:'resource-exhausted'` 的**排队**行，`errorCode`
 * 是**空的**。真正写下 `errorCode='RESOURCE_EXHAUSTED'` 的只有
 * `RetryPolicy.canRetry(5) === false` 那一支（`automation.scheduler.ts#queueOrGiveUp`），
 * 而 5 次重试之间隔 24 分钟 ⇒ **必须能拨时钟**，否则这一格只能靠直接 INSERT 伪造。
 *
 * 每一步都是真的：真的容量探针、真的决策表、真的 `AutomationScheduler.runOnce()`。
 * 被替换掉的只有「现在几点」。
 */
export async function driveToResourceExhausted(
  automation: SeededAutomation,
): Promise<RunDto[]> {
  await ctl('capacity', { squeeze: true });
  try {
    // 拨到 `nextTriggerAt` 之后 1 分钟。⛔ 不能多拨：迟到超过 5 分钟会被判成
    // 「宕机 missed」（`TriggerDecisionService` 判定顺序 0），那是另一格。
    const due = Date.parse(automation.nextTriggerAt);
    const from = Date.parse(automation.createdAt);
    await ctl('advance-clock', { ms: due - from + 60_000 });
    await ctl('automation-sweep');

    // 24min/次 × 5 次之后才转终态；多敲一轮兜住边界。
    for (let i = 0; i < 6; i += 1) {
      await ctl('advance-clock', { ms: 25 * 60_000 });
      await ctl('automation-sweep');
    }
    return await runsOf(automation.id);
  } finally {
    await ctl('capacity', { squeeze: false });
  }
}

export async function runsOf(automationId: string): Promise<RunDto[]> {
  const page = await call<{ items: RunDto[] }>('GET', `/api/automations/${automationId}/runs`);
  return page.items;
}
