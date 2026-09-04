/**
 * 真链路契约 e2e 的**后端进程**（29 §3.1.1「目录与进程形态」）。
 *
 * ── 它与 `api/apps/api/test/e2e/*` 的唯一区别 ────────────────────────────────
 * 那 220 条 e2e 用 `app.listen(0)`（随机端口），因为它们自己拿着 `app` 对象、用
 * supertest 打进去，端口号从来不需要被别人知道。这一层不行：**浏览器**要通过 Next 的
 * `API_ORIGIN` rewrite 打过来，而 `API_ORIGIN` 是 `next build` 之前就要定下的字符串。
 * ⇒ 端口必须**固定**，于是有了这个独立进程。
 *
 * ── 为什么是 `Test.createTestingModule` 而不是 `apps/api/dist/main.js` ────────
 * `main.js` 装配的是**真** provider（docker / boxlite / 真 registry）。CI 里没有 docker
 * 守护进程，本机跑也会去抢 BoxLite 的 home 锁（`~/.boxlite`，一次只允许一个 runtime）。
 * ⇒ 复用 `api/apps/api/test/e2e/_fakes.ts` **那一份**假 provider（29 §3.1.1 明确要求
 * 不另写一份：另写一份就等于又多了一套会漂的替身）。
 *
 * ── ⛔ 为什么这里能有一个 `/__contract__/*` 控制面，而它不算作弊 ─────────────
 * 29 §3.1.1 的红线是「**种子数据**走真 API，不直接写 sqlite」—— 理由是绕过业务逻辑造
 * 出来的状态可能真实系统永远不会产生。控制面**一行数据都不写**，它只做两件事：
 *   ① 改 `process.env`（容量探针每次都重读，见 `host-capacity.probe.ts` 的注释）；
 *   ② 把时钟往前拨 + 手动敲一轮 `AutomationScheduler.runOnce()`。
 * 这两件事之后，run 行仍然是**真的调度器按真的决策表**写出来的 —— 决策表一行都没被
 * 跳过。⛔ 没有它就只剩两条路：真等 24 分钟 × 5（不可能），或者直接 INSERT 一行
 * `error_code='RESOURCE_EXHAUSTED'`（那正是被禁的那件事）。
 *
 * 控制面挂在 `app.use()` 上（Nest 路由之前），所以它**不经过 setGlobalPrefix('api')**，
 * 也就不可能与任何真实端点撞路径；它只监听 `/__contract__/` 前缀。
 */
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = resolve(fileURLToPath(import.meta.url), '..');
const API_ROOT = resolve(HERE, '..', '..', 'api');

/**
 * ⚠️ **所有 api 侧的模块都必须从 `api/` 解析，不能从本目录解析。**
 * Node 按**文件所在目录**往上找 `node_modules`，而本文件住在文档主仓里 —— 主仓没有
 * `@nestjs/*`，也没有 `@platform/*` 的 workspace 链接。`createRequire` 把解析基准点
 * 挪到 `api/apps/api/package.json`（**不是 `api/package.json`** —— pnpm workspace 把
 * `@platform/*` 的链接放在 `apps/api/node_modules/` 下，仓根那一层没有），于是拿到的
 * 是 api 自己那一份（版本也必然一致）。
 */
const apiRequire = createRequire(join(API_ROOT, 'apps', 'api', 'package.json'));
const API_DIST = join(API_ROOT, 'apps', 'api', 'dist');

const PORT = Number(process.env.CONTRACT_API_PORT ?? '3110');

/**
 * 「一份配额都发不出」的宿主核数。
 *
 * ⛔ **不能写 `'1'`，那是一条会随执行顺序变绿变红的种子。** 实测（2026-09-04）：
 * 假镜像声明 1 核（`_fakes.ts#makeFakeImageSpecRegistry` 的 `resourceDefaults`），
 * 而准入判据是 `usedCores + request.cores > totalCores`
 * （`resource-pool.domain-service.ts#trySchedule`），其中
 * `totalCores = host.cores × (1 - safetyMargin) × cpuOvercommitRatio`
 * —— 本文件把后两个旋钮设成了 0 与 1，于是 `SCHEDULER_HOST_CORES=1` ⇒ `totalCores = 1`，
 * 判据变成 `0 + 1 > 1` = **false ⇒ 放行**。一核的宿主装得下一个一核的沙箱。
 *
 * 那为什么它曾经「跑通过」？因为 `reuseExistingServer` 复用的那个后端进程里**躺着前几轮
 * 留下的、还没释放登记的沙箱**，`usedCores` 已经 ≥ 1 ⇒ `1 + 1 > 1` 才成立。
 * ⇒ 这一格的前置条件当时是**靠残留数据凑出来的**：干净进程里第一条就红，跑第二遍反而绿。
 * 正是 §3.1.1 要求区分开的「红在环境上、不红在契约上」的镜像版本。
 *
 * `0.5` 让 `totalCores = 0.5 < 1`，于是 `usedCores + 1 > 0.5` **恒成立**，与库里有没有
 * 残留无关。⚠️ 小数不是取巧：`SCHEDULER_HOST_CORES` 的口径就是「cgroup 给这个容器的
 * 限额」（见 `host-capacity.probe.ts` 头注释），而 `docker --cpus=0.5` 正是它的日常取值；
 * `positive()` 收的也是任意正数，不是整数。
 */
const SQUEEZED_CORES = '0.5';

/**
 * ⚠️ 只声明**这个脚本用得到的那几个方法**，⛔ 不 `import type` api 的类型。
 * 这里是文档主仓，`@nestjs/*` 的类型不在它的 `node_modules` 里；而更重要的是：
 * 这个文件是**启动器**，它不该成为第三处「跟着 api 一起漂」的类型出口。
 * 真正的类型锁在 api 自己的 `tsc -b` 与 `docs:check` 的 B3 上。
 */
interface NestTest {
  createTestingModule(meta: { imports: unknown[] }): TestingBuilder;
}
interface TestingBuilder {
  overrideProvider(token: unknown): { useValue(v: unknown): TestingBuilder };
  compile(): Promise<{ createNestApplication(): unknown }>;
}

interface Ctl {
  /** 时钟偏移（毫秒）。0 = 真实时间。 */
  offsetMs: number;
}

async function main(): Promise<void> {
  const dataRoot = mkdtempSync(join(tmpdir(), 'contract-e2e-data-'));

  /**
   * ⚠️ **cwd 必须是 `api/`。** 后端有若干处按 `process.cwd()` 取路径（迁移目录、
   * `DATA_ROOT` 的默认值…），而 `api/apps/api/test/e2e` 那 220 条是被 vitest 从 `api/`
   * 启起来的 —— 换个 cwd 就等于换了一套隐含配置。`MIGRATIONS_DIR` 仍然显式给出：
   * 这一处是**启动就炸**的（`Can't find meta/_journal.json`），显式比隐式便宜。
   */
  process.chdir(API_ROOT);
  process.env.MIGRATIONS_DIR = join(API_ROOT, 'drizzle');

  // ── 环境：与 `api/apps/api/test/e2e` 同款，外加固定端口需要的两条 ──────────
  process.env.DATABASE_URL = ':memory:';
  process.env.DATA_ROOT = dataRoot;
  // 定时器不该在 e2e 里自己跑（`automations.e2e-spec.ts` 同款）。这一层更需要它：
  // 调度由测试**显式**敲一轮，才谈得上「这条 run 是我这一步造出来的」。
  process.env.DISABLE_AUTOMATION_SCHEDULER = '1';
  process.env.DISABLE_VOLUME_REAPER = '1';
  // 一台「够大的」假宿主机（`_data-root.setup.ts` 的原话）；容量用例再自己压小。
  process.env.SCHEDULER_HOST_CORES ??= '4096';
  process.env.SCHEDULER_HOST_RAM_MB ??= '4194304';
  process.env.SCHEDULER_SAFETY_MARGIN ??= '0';
  process.env.SCHEDULER_CPU_OVERCOMMIT ??= '1';
  process.env.WORKSPACE_MIN_FREE_BYTES ??= '0';
  // ⛔ 口令必须关着：这一层验的是契约面，不是解锁门（那由 access-*.e2e-spec 管）。
  delete process.env.ACCESS_PASSCODE;

  const { Test } = apiRequire('@nestjs/testing') as { Test: NestTest };
  const { AppModule } = apiRequire(join(API_DIST, 'app.module.js')) as {
    AppModule: new () => unknown;
  };
  const { configurePlatformApp } = apiRequire(join(API_DIST, 'bootstrap', 'configure-app.js')) as {
    configurePlatformApp: (app: unknown) => void;
  };
  const contracts = apiRequire('@platform/contracts') as Record<string, symbol>;
  const kernel = apiRequire('@platform/shared-kernel') as Record<string, symbol>;
  // `_fakes.ts` 是 **TypeScript**，靠 tsx 的 require 钩子装载 —— 复用那一份是 §3.1.1
  // 的硬要求（"别另写"）。
  const fakes = apiRequire(join(API_ROOT, 'apps', 'api', 'test', 'e2e', '_fakes.ts')) as {
    makeFakeRegistry: (extra?: unknown[]) => unknown;
    FakeProvider: new (name: string) => unknown;
    fakeWorkspace: unknown;
    fakeProjectFacade: unknown;
    makeFakeImageSpecRegistry: () => unknown;
    registerDefaultImage: (app: unknown) => Promise<string>;
  };

  const ctl: Ctl = { offsetMs: 0 };
  /** 可拨的时钟。⚠️ 它**实现的是同一个 `Clock` 端口**，领域一行都不知道自己被拨过。 */
  const controllableClock = { now: (): Date => new Date(Date.now() + ctl.offsetMs) };

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(contracts['SANDBOX_PROVIDER_REGISTRY'])
    .useValue(fakes.makeFakeRegistry([new fakes.FakeProvider('aio')]))
    .overrideProvider(contracts['WORKSPACE_PREPARER'])
    .useValue(fakes.fakeWorkspace)
    .overrideProvider(contracts['PROJECT_FACADE'])
    .useValue(fakes.fakeProjectFacade)
    .overrideProvider(contracts['IMAGE_SPEC_REGISTRY'])
    .useValue(fakes.makeFakeImageSpecRegistry())
    .overrideProvider(kernel['CLOCK'])
    .useValue(controllableClock)
    .compile();

  const app = moduleRef.createNestApplication() as {
    use: (fn: unknown) => void;
    init: () => Promise<void>;
    listen: (port: number, host: string) => Promise<void>;
    close: () => Promise<void>;
    get: (token: unknown) => { runOnce: () => Promise<number> };
  };

  // ── 控制面（见文件头）。挂在 Nest 路由之前，只认 `/__contract__/` 前缀。 ────
  app.use(controlPlane(ctl, () => app));

  configurePlatformApp(app);
  await app.init();
  await app.listen(PORT, '127.0.0.1');
  // 创建门要求镜像**已登记**（04 §7 时刻③），否则连一次「容量不足」都撞不到。
  await fakes.registerDefaultImage(app);

  const shutdown = (): void => {
    void app.close().finally(() => {
      rmSync(dataRoot, { recursive: true, force: true });
      process.exit(0);
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // playwright 的 `webServer.url` 探的就是这一行之后才通的 `/api/health`。
  process.stdout.write(`contract-e2e api listening on http://127.0.0.1:${String(PORT)}\n`);
}

type Req = { url?: string; method?: string; on: (e: string, cb: (c?: unknown) => void) => void };
type Res = { statusCode: number; setHeader: (k: string, v: string) => void; end: (b: string) => void };

function controlPlane(
  ctl: Ctl,
  appOf: () => { get: (token: unknown) => { runOnce: () => Promise<number> } },
): (req: Req, res: Res, next: () => void) => void {
  const apiRequireLocal = apiRequire;
  return (req, res, next) => {
    const url = req.url ?? '';
    if (!url.startsWith('/__contract__/')) {
      next();
      return;
    }
    void readBody(req).then(async (raw) => {
      const body = raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>);
      const send = (code: number, payload: unknown): void => {
        res.statusCode = code;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(payload));
      };
      try {
        switch (url) {
          /** 把容量压到「一份配额都发不出」/ 放回去。⚠️ 探针每次都重读 env，不缓存。 */
          case '/__contract__/capacity': {
            const squeeze = body['squeeze'] === true;
            process.env.SCHEDULER_HOST_CORES = squeeze ? SQUEEZED_CORES : '4096';
            send(200, { cores: process.env.SCHEDULER_HOST_CORES });
            return;
          }
          /** 时钟前拨。⛔ 只前拨不回拨 —— 回拨会让已经写进库的时间戳出现在「未来」。 */
          case '/__contract__/advance-clock': {
            ctl.offsetMs += Number(body['ms'] ?? 0);
            send(200, { offsetMs: ctl.offsetMs });
            return;
          }
          /** 手敲一轮调度。走的是生产那一个 `runOnce()`，决策表一行没跳过。 */
          case '/__contract__/automation-sweep': {
            const { AutomationScheduler } = apiRequireLocal('@platform/automation') as {
              AutomationScheduler: unknown;
            };
            const touched = await appOf().get(AutomationScheduler).runOnce();
            send(200, { touched });
            return;
          }
          default:
            send(404, { code: 'NOT_FOUND', message: url });
        }
      } catch (e) {
        send(500, { message: (e as Error).message, stack: (e as Error).stack });
      }
    });
  };
}

function readBody(req: Req): Promise<string> {
  return new Promise((done) => {
    let raw = '';
    req.on('data', (c) => (raw += String(c)));
    req.on('end', () => done(raw));
  });
}

void main().catch((e: unknown) => {
  process.stderr.write(`contract-e2e api failed to start: ${String(e)}\n`);
  if (e instanceof Error && e.stack !== undefined) process.stderr.write(`${e.stack}\n`);
  process.exit(1);
});
