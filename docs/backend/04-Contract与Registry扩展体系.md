# 04 - Contract 与 Registry 扩展体系（细化版）

> 状态：✅ 可评审（第三轮：收敛暴露面为 6 个必须方法、补齐每个方法的用途说明、明确 `aio`/`boxlite` 两个内建方案、契约抽 npm 子包、testkit 补规范条款）
> 关联文档：[01 后端目录结构](./01-后端目录结构与DDD分层.md) · [03 调度中心](./03-Sandbox调度中心.md) · [05 鉴权流转](./05-Runtime鉴权流转.md) · [13 数据库设计](./13-后端数据库设计.md)

## 1. 设计目标

sandbox、runtime、镜像三层都可由用户注册自己的实现；平台在 `packages/contracts/` 集中维护一套**框架无关**的 contract（纯 TS，不依赖 NestJS）。

三条贯穿全文的取舍（细则见 §2.0）：

1. **暴露面尽可能小**——第三方要实现的东西越少，实现之间就越难跑偏；能派生的平台自己派生。
2. **契约与具体 sandbox 实现无关**——同一份 contract 必须能被容器与 micro-VM 两种形态同时满足（§2.1 的 `aio` / `boxlite` 就是这条的活体检验）。
3. **版本管理不自研**——契约抽成独立 npm 子包，semver / 兼容范围解析 / 升级提示全交给包管理器（§9）。

```
packages/contracts/                 # → 发布为 @platform/sandbox-contracts
├── src/
│   ├── sandbox-provider.contract.ts
│   ├── runtime-adapter.contract.ts
│   ├── image-spec.contract.ts
│   ├── errors.ts                  # 统一错误模型（§4）
│   └── registry.tokens.ts
├── testkit/                       # 契约一致性套件（§10），子路径导出 /testkit
├── CHANGELOG.md                   # changesets 生成
└── package.json                   # version 即契约版本
```

## 2. SandboxProvider contract

### 2.0 三条硬约束（决定这份 contract 长什么样）

1. **最小暴露面**：第三方只需实现 **6 个必须方法**。凡是"平台没有一条分支逻辑依赖它"的东西，一律不进 contract；能由已有原语派生的，平台自己派生，不让每个实现重写一遍。
2. **实现无关**：contract 里不出现任何具体运行时的词汇（container / micro-VM / docker exec / 8 字节流头 / Pod）。解复用、句柄格式、会话保活方式等全部由实现内部消化，对平台只暴露语义。
3. **双实现验证**：任何新增方法或字段，必须能被 `aio` 与 `boxlite` 两个内建实现**同时**自然满足；只有一方能满足的，就是实现细节而不是契约，应该退回 capabilities 或实现内部。

### 2.1 内建 sandbox 方案（registry key）

平台内建两个 SandboxProvider 实现，覆盖"够用"与"隔离强"两端：

| key | 方案 | 形态 | 隔离强度 | 为什么选它 |
|---|---|---|---|---|
| **`aio`**（默认） | [AIO Sandbox](https://github.com/agent-infra/sandbox)（agent-infra） | 单个 OCI 容器镜像，内置 shell / 文件系统 / 浏览器 / VSCode Server / 预置 MCP server，统一端口暴露 HTTP API | 容器级（namespace + cgroup） | 开箱即用的 agent 工作环境，省掉自己拼镜像与装 CLI 依赖；自带 MCP 面，与本平台 02 的 MCP 协议面同构；社区维护，镜像随上游更新 |
| **`boxlite`** | [BoxLite](https://github.com/boxlite-ai/boxlite) micro-VM | Rust 库**进程内嵌**调用（无 daemon、无 root），OCI 兼容，可直接跑同一份 AIO 镜像 | micro-VM 级（每个 Box 独立 Linux 内核，硬件辅助隔离） | 隔离强度高于容器，跑不可信 agent 更稳；亚秒级启动；Box 是**有状态**工作区，天然支撑 03 §4 的"stopped → starting 复用已分配卷"；macOS / Linux(KVM) / WSL2 都能跑，本地开发与部署同构 |

**关键前提**：两个方案都以 **OCI 镜像**为交付单元，所以 §7 的 ImageSpec 契约在两侧完全一致——同一份 AIO 镜像既能被 `aio` 当容器起，也能被 `boxlite` 塞进 micro-VM 跑。这是这两个方案能共用一套 contract 的根本原因，也是新增第三个方案时的准入条件。

> 隔离强度的进一步演进（gVisor / Firecracker 等，见文档 11 §5）不需要改 contract：`boxlite` 已经把"contract 能不能容纳非容器实现"这件事验证过一遍了。

### 2.2 必须实现的 6 个方法（每个方法平台拿它干什么）

```typescript
interface SandboxProvider {
  readonly name: string;                       // registry key: 'aio' | 'boxlite' | <自定义>
  readonly capabilities: SandboxProviderCapabilities;   // §2.5

  create(ctx: SandboxProviderContext): Promise<SandboxHandle>;
  start(handle: SandboxHandle): Promise<void>;
  stop(handle: SandboxHandle, opts?: { timeoutSec?: number }): Promise<void>;
  destroy(handle: SandboxHandle): Promise<void>;
  inspect(handle: SandboxHandle): Promise<SandboxRuntimeStatus>;
  spawn(handle: SandboxHandle, spec: ProcessSpec): Promise<ProcessStream>;

  // 可选：capabilities 对应位为 true 时才必须实现（§5 列出平台如何降级）
  updateResources?(handle: SandboxHandle, quota: ResourceQuota): Promise<void>;
  watchEvents?(): AsyncIterable<ProviderEvent>;                  // §6
}
```

| 方法 | 平台拿它干什么（唯一用途，不做别的） | 谁在什么时候调 | 必须遵守的语义 |
|---|---|---|---|
| `create` | 把一次**已完成配额登记**的调度决策物化成实体，并换回平台后续只认的句柄 | `SandboxApplicationService` 创建流程，在互斥区**之外**（03 §3）；状态 `scheduling→creating` | 只创建不启动（平台要分两步落库）；失败必须抛 §4 的错误码，平台据此回滚配额登记 |
| `start` | 让实体进入"可接受 `spawn`"的状态 | `creating→starting`；以及 `stopped→starting` 重新拉起（03 §4） | 对已运行实体必须**幂等成功**，不得抛 `ALREADY_EXISTS` |
| `stop` | 释放算力但**保留工作区数据**，使后续 `start` 能复用 | Reaper idle 回收、用户手动 stop（03 §4） | 超过 `timeoutSec` 转强制终止；停止后工作区必须仍可见，否则 `volumeMount` 能力位必须声明 `false` |
| `destroy` | 终态清理，连数据一并回收 | `destroying→destroyed`；对账清理野实例（13 §4） | **幂等**：对已销毁或根本不存在的句柄调用必须静默成功 |
| `inspect` | 平台**唯一**的外部真相来源：状态机纠偏、启动/增量对账、健康判定全靠它 | 轮询模式 10s / 60s 分频（§5）、事件流重连补偿（§6）、`onApplicationBootstrap` 全量对账（13 §4） | 实体查无时返回 `lifecycleState: 'instance_missing'`，**不要抛 `NOT_FOUND`**——对账必须能区分"确认不存在"与"查不动"（后者才抛 `PROVIDER_UNAVAILABLE`） |
| `spawn` | **唯一**的"在 sandbox 里跑东西"原语：终端会话、runtime 安装与探测、凭证物化、鉴权登录，全部走它 | terminal 网关（06）、RuntimeAdapter 全部方法（§3）、`CredentialVault.materialize`（05 §4） | 交出的输出必须是**已解复用的干净字节流**；流头/多路复用/tty 合并 stderr 是实现内部的事，平台不做任何解码 |

**两个内建实现的映射**（第三方实现可对照）：

| 方法 | `aio` 实现 | `boxlite` 实现 |
|---|---|---|
| create / start / stop / destroy | OCI 容器 create/start/stop/rm（经 socket proxy，文档 11 §1） | BoxLite 库调用创建/启动/停止/销毁 Box |
| inspect | 容器 inspect + 健康探针 | Box 状态查询 |
| spawn(tty=false) | 经 in-sandbox agent `POST /v1/shell/exec`（收集输出到 EOF） | 同左（Box 内 `:8080`，端口转发） |
| spawn(tty=true) | 经 in-sandbox agent `ws /v1/shell/ws`，翻译成 `ProcessStream` | 同左（Box 内 `:8080`，端口转发） |
| watchEvents | ✅ 原生事件流 | ✅ 库回调包装成同一 `AsyncIterable` |

> **数据面 = 沙箱内 agent（权威：[SANDBOX-RUNTIME-DECISIONS](../SANDBOX-RUNTIME-DECISIONS.md)）**：aio/boxlite 的 `spawn` 由 **AIO Sandbox 自带的 in-sandbox API**（`:8080`——`/v1/shell/ws` 交互终端、`/v1/shell/exec` 命令）支撑，AIO 协议 ↔ 中立 `ProcessStream` 的翻译在 **provider 内**完成——**不是宿主 `docker exec`**（后者仅作无内置 agent 裸镜像的 `DockerExecAgentClient` fallback）。控制面：aio=dockerode、boxlite=BoxLite SDK。agent 端口**仅内网可达、就绪探测、不外泄**。该选型的两档实测验证与工程注记（含 BoxLite 本地 registry 预置镜像）见该 ADR。

### 2.3 为什么把 `exec` / `attachPty` / `healthCheck` 从必须方法里删掉

这三个是上一版的必须方法，本版移除——直接对应"暴露给用户定义的越少越好"：

- **`exec` = `spawn({ tty:false })` + 收集输出到 EOF**。平台在 contract 之上提供 `toExecFn(provider, handle): SandboxExecFn` 便利封装（即 §3 各方法收的那个 `SandboxExecFn`），实现方不用再写第二遍。
- **`attachPty` = `spawn({ tty:true })`**。两者只差一个 flag，拆成两个方法会让每个实现写两套几乎一样的进程创建代码，且极易出现"exec 支持 `env`/`cwd` 但 pty 不支持"这类实现间不一致——正是"无视各自实现保持统一"要防的。
- **`healthCheck` 与 `inspect().health` 完全重复**（上一版两者都返回 `HealthStatus`），两个入口迟早给出两种答案。删掉方法，健康状态作为 `inspect` 的可选字段返回，平台只在一个地方读。

结果：第三方需要实现的必须方法从 **9 个降到 6 个**，可选方法 2 个。

> 与文档 06 的衔接：06 §3 的 `PtyStream` 就是 `spawn({tty:true})` 返回的 `ProcessStream`，**不再单独定义**——以本节为准，06 只保留实现对照表。

### 2.4 支撑类型（附字段用途）

```typescript
/** 平台交给实现的全部输入；实现不得从别处读取平台状态 */
interface SandboxProviderContext {
  sandboxId: string;               // 平台 id。仅供实现打 label / 命名，不得当作句柄回传
  quota: ResourceQuota;            // 调度器已登记，实现只负责把限额施加到运行时
  image: ResolvedImageSpec;        // 已 resolve + validate 过（§7），实现不再重复校验
  env: Record<string, string>;
  volumes?: VolumeMount[];         // capabilities.volumeMount=false 时平台不会传。
                                   // 平台保证 create() 被调用时挂载源【已存在】（03 §4 状态序列：preparing-workspace 先于 creating）
  labels?: Record<string, string>; // 平台强制注入 platform.managed=true —— 对账靠它识别野实例（13 §4）
}

/** 不透明句柄：平台只做存取、落库（sandboxes.provider_handle）与相等比较，禁止解析内容 */
interface SandboxHandle {
  readonly provider: string;           // 必须等于 provider.name，registry 路由靠它
  readonly providerSandboxId: string;  // 容器 id / Box id / 任意实现自定义标识
}

/** 中立措辞：instance = 容器或 micro-VM。与平台状态机（03 §4）的 12 个状态是两套东西 */
type SandboxRuntimeLifecycleState =
  | 'instance_creating' | 'instance_running' | 'instance_paused'
  | 'instance_exited'   | 'instance_dead'    | 'instance_missing';

interface SandboxRuntimeStatus {
  lifecycleState: SandboxRuntimeLifecycleState;  // 状态机纠偏与对账的判定依据
  exitCode?: number;
  startedAt?: string;            // ISO
  finishedAt?: string;
  resourceUsage?: { cpuPercent: number; ramUsedMb: number };  // 拿得到就填，用于展示与容量校准
  health?: HealthStatus;         // 取代已删除的 healthCheck()
  raw?: unknown;                 // 实现原始输出。**仅允许打日志**，平台任何分支逻辑不得读取其字段
}

type HealthState = 'healthy' | 'unhealthy' | 'unknown' | 'starting';
interface HealthStatus {
  state: HealthState;
  lastCheckedAt: string;
  message?: string;
  consecutiveFailures: number;   // 平台据此决定"抖动"还是"真挂了"
}

/** 唯一的进程创建入参：一次性命令与交互式会话只差 tty 一个 flag */
interface ProcessSpec {
  cmd: string[];
  tty: boolean;                  // true=交互式（终端会话 / 鉴权登录）；false=一次性命令
  cols?: number; rows?: number;  // tty=true 时必填
  env?: Record<string, string>;
  cwd?: string;
  user?: string;
  timeoutMs?: number;            // 仅 tty=false 生效；超时由实现负责 kill
  reuse?: string;                // 传入已有会话标识则复用而非新建（断线重连，06 §6）
}

interface ProcessStream {
  readonly ref: string;          // 会话标识，落库 terminal_sessions.exec_id；reuse 传的就是它
  onData(cb: (chunk: Buffer) => void): void;        // 已解复用的干净字节流
  write(data: string | Buffer): void;               // tty=true 时即 stdin
  resize(cols: number, rows: number): void;         // tty=false 时为 no-op
  onExit(cb: (code: number | null) => void): void;  // null = 被信号终止 / 会话 detach
  kill(signal?: NodeJS.Signals): Promise<void>;
}

interface VolumeMount {
  source: string;                // 由平台决定的来源标识；host-path 时是宿主绝对路径（03 §7.1）
  target: string;                // 实体内挂载点
  mode: 'ro' | 'rw';
  kind: 'host-path' | 'persistent' | 'ephemeral';   // 中立措辞（审计 M-2）：不含具体运行时词汇
}
```

### 2.5 Capabilities（准入规则：一个能力位必须对应一条平台分支）

**加位规则**：只有当"平台存在一条明确的分支逻辑，会因为它 true/false 而走不同的路"时，才配拥有一个能力位。否则不加——想加时按 minor 版本追加即可（§9），漏加的代价远小于一堆没人读的布尔。据此把上一版的 10 位裁到 6 位。

```typescript
interface SandboxProviderCapabilities {
  spawnTty: boolean;         // spawn({tty:true}) 是否可用
  volumeMount: boolean;      // 是否支持持久工作区
  updateResources: boolean;  // 是否支持不重建改配额
  pauseResume: boolean;      // 是否支持暂停/恢复
  snapshot: boolean;         // 是否支持 checkpoint
  watchEvents: boolean;      // 是否支持事件订阅
}
```

| 能力位 | 平台对应的分支（§5 详列） | `aio` | `boxlite` |
|---|---|---|---|
| `spawnTty` | false → 终端页与 runtime 鉴权入口整体不可用，创建时即拒绝需要 TTY 的 runtime | ✅ | ✅ |
| `volumeMount` | false → `stopped → starting` 不承诺数据保留，Reaper 的 idle 回收降级为直接 destroy（03 §4） | ✅ | ✅（Box 有状态） |
| `updateResources` | false → 扩缩容转 "stop + 重建" | ✅ | 视版本 |
| `pauseResume` | false → 前端不显示"暂停"按钮（经 `GET /providers` 下发） | ✅ | 视版本 |
| `snapshot` | false → 显式要求 `requireSnapshot` 的创建请求直接拒绝，不进调度队列 | ❌ | ❌ |
| `watchEvents` | false → `SandboxStatusObserver` 退化为轮询 `inspect()` | ✅ | ✅ |

**已删除的 4 位及理由**：`exec` / `attachPty` → 合并为必须方法 `spawn` 与 `spawnTty` 一位；`metricsStream` → 直接体现为 `inspect().resourceUsage` 有没有值，不需要单独声明；`networkPolicy` / `gpuAllocation` → 平台当前没有任何一条分支读它们，属于"提前占坑"。

**能力位不是自我描述而是承诺**：声明 `true` 就必须通过 testkit 里对应的用例（§10 的 CAP-01 条款），声明与实际不符视为不合格实现。

## 3. RuntimeAdapter contract（完整定义）

RuntimeAdapter 封装的是"**某个 agent CLI 的怪癖**"——怎么装、怎么登录、怎么起任务。它**不碰任何 sandbox 实现细节**：拿到的是 §2 的中立原语（`SandboxExecFn` / `ProcessStream`），所以同一个 `ClaudeCodeAdapter` 在 `aio` 和 `boxlite` 下是同一份代码。

```typescript
interface RuntimeAdapter {
  readonly id: 'claude-code' | 'codex' | string;

  // 安装
  getInstallPlan(imageSpec: ResolvedImageSpec): RuntimeInstallPlan;
  isInstalled(exec: SandboxExecFn): Promise<boolean>;
  install(exec: SandboxExecFn): Promise<void>;

  // 鉴权（流转见文档 05）。注意收的是 ProcessStream 而非 SandboxExecFn：
  // 交互式登录命令永远不会退出，一次性 exec 既拿不到增量输出也写不了 stdin。
  getAuthMethods(): RuntimeAuthMethod[];
  beginAuth(method: RuntimeAuthMethod, pty: ProcessStream): Promise<AuthChallenge>;
  completeAuth(challenge: AuthChallenge, input: AuthCompletionInput,
               pty: ProcessStream): Promise<RuntimeCredential>;
  // 密钥直存模式（'api-key' / 'access-token-paste'）：不经 sandbox pty 的短路路径（05 §3.1），
  // 纯函数构造凭证形态（credentialFiles / env），无需任何宿主
  createCredentialFromSecret?(method: 'api-key' | 'access-token-paste',
                              secret: string): Promise<RuntimeCredential>;
  injectCredential(cred: RuntimeCredential, exec: SandboxExecFn): Promise<void>;

  // 运行
  buildStartCommand(task: RuntimeTaskSpec): SandboxCommand;
  buildAttachCommand(): SandboxCommand;
  parseOutput?(chunk: Buffer): RuntimeEvent[];
}
```

| 方法 | 平台拿它干什么 | 谁在什么时候调 | 要点 |
|---|---|---|---|
| `getInstallPlan` | 创建 sandbox 前预估"这个镜像要不要装、装多久"，用于决定 `runtime_installations.status` 初值与是否提示用户换镜像 | 创建流程校验阶段 | 纯函数，不产生副作用、不碰网络 |
| `isInstalled` | 幂等判断，避免每次启动都重装 | `install` 之前；健康检查时复查 | 洁净环境必须返回 false（testkit RA-01） |
| `install` | 按 plan 真正装 CLI | `isInstalled=false` 且策略为 `install-on-start` 时 | 必须可重入：中途失败后重调不能留半个环境 |
| `getAuthMethods` | 决定前端鉴权页给这个 provider 渲染哪种模式；Claude 官方支持 device-code 后**只改这里**（05 §6） | 鉴权页加载、`beginAuth` 前校验 | 返回顺序即推荐优先级 |
| `beginAuth` | 在容器内起交互式登录命令，从**增量 pty 输出**里正则捕获 URL / device-code，交前端展示 | `POST .../auth/begin`（05 §3） | 脆弱点：CLI 改输出格式即失效 → golden fixture 兜底（§10 RA-04） |
| `completeAuth` | 把用户贴回来的 code 写进 pty stdin（或持续读输出等登录完成），产出可入库的凭证 | `POST .../auth/complete` | 返回的 `credentialFiles.content` 是明文，**只在内存流转**，落库前必经 Vault 加密 |
| `createCredentialFromSecret`（可选） | 把用户直接提交的 API key / access token 构造成可入库凭证（注入形态由 adapter 决定：env 变量或 config 文件） | `POST /api/runtimes/:rt/credentials/secret`（05 §3.1） | **不需要 sandbox 宿主**；可含轻量格式校验；同样只在内存流转、Vault 加密落库 |
| `injectCredential` | 把 Vault 里已有的凭证物化进新 sandbox，实现"登录一次、后续复用" | 创建带 runtime 的 sandbox 时（05 §4 materialize） | 用一次性 exec 即可，无需 tty |
| `buildStartCommand` | 无头任务模式的命令拼装（MCP `run_agent_task`，02 §5） | 起任务时 | 纯函数 |
| `buildAttachCommand` | 终端会话默认跑什么（`ProcessSpec.cmd` 缺省值） | 终端网关建会话时（06） | 纯函数 |
| `parseOutput` | 可选：把 CLI 原始输出解析成结构化 `RuntimeEvent`，供任务进度展示 | 无头任务流式输出时 | 不实现则平台只透传原始字节 |

**支撑类型**：

```typescript
interface RuntimeInstallPlan {
  strategy: 'preinstalled' | 'install-on-start' | 'sidecar-inject';
  packageManagerCmds: string[];
  requiredBinaries: string[];
  envRequirements: string[];
  estimatedInstallSec?: number;
}

type RuntimeAuthMethod = 'oauth-device' | 'setup-token' | 'api-key' | 'access-token-paste';

interface AuthChallenge {
  method: RuntimeAuthMethod;
  kind: 'url' | 'device-code' | 'paste-prompt';
  verificationUrl?: string;
  userCode?: string;
  expiresAt?: string;
  instructions: string;          // 前端展示的人类可读引导文案
  challengeRef: string;          // 关联同一次登录会话（内部映射到 pty session）
}

interface AuthCompletionInput { pastedText?: string; cancel?: boolean; }

interface RuntimeCredential {
  runtimeId: string;
  obtainedVia: RuntimeAuthMethod;
  maskedIdentifier?: string;
  issuedAt: string;
  expiresAt?: string;
  credentialFiles: Array<{ containerPath: string; content: string; mode?: string }>;
  // content 明文只在内存流转，落库前必须经 CredentialVault 加密（文档 05/13）
}

interface RuntimeTaskSpec {
  prompt?: string;
  taskId?: string;
  headless: boolean;
  outputFormat?: 'text' | 'json-stream';
  extraArgs?: string[];
  workdir?: string;
}

interface SandboxCommand { cmd: string[]; env?: Record<string, string>; cwd?: string; }

type RuntimeEventType = 'stdout-chunk' | 'tool-call' | 'task-complete' | 'error' | 'auth-required';
interface RuntimeEvent { type: RuntimeEventType; timestamp: string; data: unknown; }

/**
 * 一次性命令执行。**不是 SandboxProvider 的方法**——由平台的 toExecFn(provider, handle)
 * 在 spawn({tty:false}) 之上派生（§2.3），Adapter 作者与 Provider 作者都不用实现它。
 */
type SandboxExecFn = (cmd: string[], opts?: Omit<ProcessSpec, 'cmd' | 'tty'>) =>
  Promise<{ stdout: string; stderr: string; exitCode: number }>;
```

## 4. 统一错误模型

```typescript
enum SandboxProviderErrorCode {
  IMAGE_PULL_FAILED      = 'IMAGE_PULL_FAILED',
  RESOURCE_EXHAUSTED     = 'RESOURCE_EXHAUSTED',
  NOT_FOUND              = 'NOT_FOUND',
  ALREADY_EXISTS         = 'ALREADY_EXISTS',
  TIMEOUT                = 'TIMEOUT',
  PERMISSION_DENIED      = 'PERMISSION_DENIED',
  INVALID_STATE          = 'INVALID_STATE',           // 对已销毁 sandbox 调 exec 等
  PROVIDER_UNAVAILABLE   = 'PROVIDER_UNAVAILABLE',    // docker daemon 不可达
  UNSUPPORTED_CAPABILITY = 'UNSUPPORTED_CAPABILITY',
  INTERNAL               = 'INTERNAL',
}

class SandboxProviderError extends Error {
  constructor(
    readonly code: SandboxProviderErrorCode,
    message: string,
    readonly cause?: unknown,
    readonly retryable: boolean = false,
  ) { super(message); }
}

// RuntimeAdapter 同构错误码：INSTALL_FAILED / AUTH_CHALLENGE_EXPIRED / AUTH_REJECTED
//   / BINARY_NOT_FOUND / UNSUPPORTED_METHOD / PARSE_ERROR
// ImageSpecProvider：REGISTRY_UNREACHABLE / REF_NOT_FOUND / MANIFEST_INVALID
```

**分层映射原则**：infrastructure 抛 contract 层错误，只在 infrastructure→application 边界短暂穿越；application 统一 `mapProviderErrorToDomain()` 转为 domain 错误再上抛——**domain 层永不依赖 contract 包的错误类**（保持文档 01 的依赖方向纯净）。

interface 层再映射：


| 错误码                                      | REST      | MCP                                                                                  |
| ---------------------------------------- | --------- | ------------------------------------------------------------------------------------ |
| IMAGE_PULL_FAILED / PROVIDER_UNAVAILABLE | 502 / 503 | tool 层错误（`isError:true` + 文本 + code 字段），**不用 JSON-RPC 传输级错误**——让 LLM 调用方读到具体原因判断是否重试 |
| RESOURCE_EXHAUSTED                       | 429       | 同上                                                                                   |
| NOT_FOUND                                | 404       | 同上                                                                                   |
| ALREADY_EXISTS / INVALID_STATE           | 409       | 同上                                                                                   |
| PERMISSION_DENIED                        | 403       | 同上                                                                                   |
| TIMEOUT                                  | 504       | 同上                                                                                   |
| INTERNAL                                 | 500       | 同上                                                                                   |


## 5. Capabilities 协商与降级规则


| 场景                      | 规则                                                                                                                    |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 创建前静态校验                 | 请求显式要求某能力（如 `requireSnapshot`）而 provider 为 false → application 层直接拒绝，不进调度队列                                           |
| `watchEvents=false`     | 平台 `SandboxStatusObserver` 自动切轮询 `inspect()`（running 每 10s，idle/stopped 降频 60s）；push/poll 差异对 domain/application 完全封装 |
| `updateResources=false` | 扩缩容请求转为 "stop + 重建" 组合；连无损重建都不支持（无持久卷）则拒绝并提示                                                                          |
| 能力发现                    | capabilities 随 provider 写入 registry，`GET /providers` 只读暴露 → 前端据此动态显隐按钮（无 pauseResume 就不显示"暂停"）                        |


## 6. 生命周期事件上报：事件订阅优先，轮询兜底

```typescript
interface ProviderEvent {
  handle: SandboxHandle;
  kind: 'state-changed' | 'oom' | 'health-changed' | 'died' | 'unknown';
  status: SandboxRuntimeStatus;
  occurredAt: string;
}
```

- `aio`：对接容器运行时的原生事件流（die / oom / health_status），一条长连接替代轮询。
- `boxlite`：库层 Box 生命周期回调包装成同一 `AsyncIterable<ProviderEvent>`——**同一形状**是这里的全部要求，事件怎么来是实现自己的事。
- 第三方（k8s Watch API、本地进程 child_process exit…）同理，只需产出同形状事件。
- 平台统一 `SandboxStatusObserver`：按 capabilities 选订阅或轮询，事件驱动状态机转移 + 写 `domain_events`。
- **事件流重连必做补偿**：断开自动重连 + 重连后立即全量 `inspect()` 对账（防断连期间漏事件）——与文档 13 §4 的启动对账共用同一套基础设施，触发场景一个是进程重启、一个是事件流重连。

## 7. ImageSpec contract 与镜像约定

```typescript
interface ImageSpecManifest {
  name: string;
  version: string;
  baseImage: string;
  entrypointContract: { workdir: string; entrypoint: string[]; healthcheckCmd?: string[] };
  supportedRuntimes: string[];
  resourceDefaults: ResourceQuota;
  labelsRequired?: string[];
}

interface ImageSpecProvider {
  readonly name: string;
  resolve(ref: string): Promise<ResolvedImageSpec>;
  validate(manifest: ImageSpecManifest): ValidationResult;
}

interface ResolvedImageSpec {
  ref: string;
  manifest: ImageSpecManifest;
  digest?: string;
  resolvedAt: string;
}

interface ValidationResult {
  valid: boolean;
  errors: Array<{ code: string; message: string; path?: string }>;
  warnings?: Array<{ code: string; message: string }>;
}
```

| 方法 | 平台拿它干什么 | 谁在什么时候调 | 要点 |
|---|---|---|---|
| `resolve` | 把用户写的 ref（tag / digest / 内部别名）钉成一个**不可变**的镜像坐标 + manifest | 创建 sandbox 的校验阶段，早于进调度队列 | 必须解出 `digest`，否则同一 tag 前后两次创建可能不是同一镜像 |
| `validate` | 判断这个镜像能不能被平台正常驱动（入口约定、支持的 runtime、资源默认值） | 镜像注册时；`resolve` 之后再校一次 | 只做**判断**不做修复；结果落 `image_manifests.validation_status`（13 §2） |

> 两个内建方案都以 **OCI 镜像**为交付单元（§2.1），所以下面这套约定在 `aio` 与 `boxlite` 下一字不差地成立——正是 §2.0 第 3 条"双实现验证"要保住的性质。

镜像约定（写入用户文档）：必须含 bash；**建议含 tmux**——缺失时 `validate()` 产出 **warning（非 error）** 并在 `ResolvedImageSpec` 标记 `supportsTmux: false`，终端网关据此在 tmux re-attach 与 ring buffer 两方案间自动选择（文档 06 §6），无 tmux 镜像仍可正常使用；runtime CLI 可预装或由 install plan 现装；HOME 可写（凭证物化需要）。

## 8. Registry 注册机制（双通道）

### 方式一（主）：DI Token + 动态模块

```typescript
export const SANDBOX_PROVIDER_REGISTRY = Symbol('SANDBOX_PROVIDER_REGISTRY');
export const RUNTIME_ADAPTER_REGISTRY  = Symbol('RUNTIME_ADAPTER_REGISTRY');
export const IMAGE_SPEC_REGISTRY       = Symbol('IMAGE_SPEC_REGISTRY');

interface ProviderRegistry<T> {
  register(impl: T, opts?: { default?: boolean }): void;
  get(key: string): T;              // 未注册抛领域错误
  getDefault(): T;
  list(): T[];
}
```

各实现经 `XxxModule.register()` 在 `onModuleInit` 注册；内建 **`AioSandboxProvider`（`aio`，default）**、**`BoxLiteSandboxProvider`（`boxlite`）**、`ClaudeCodeAdapter`、`CodexAdapter`；未指定实现回退 default 条目。注册校验：name/id 唯一（冲突启动即 fail-fast）+ capabilities 完整性。

### 方式二（补充）：插件目录扫描

`plugins/<type>/<name>/index.ts` 导出实现，其 `package.json` 用**标准 `peerDependencies`** 声明契约兼容范围（见 §9），不引入自定义字段；`PluginLoader` 启动扫描后注册进同一 registry。⚠️ 进程内加载需信任来源（长期可选 worker_threads 隔离壳）。

### 方式三（内建目录）：git 平台一等公民注册表

与方式一/二"用户运行时注册第三方 provider"不同，**git 托管平台的一等公民目录是平台内建的、代码级的单一数据源**——`shared-kernel` 的 `GIT_PLATFORM_REGISTRY`（`github`/`gitlab`/`gitee`/`gitea` → `label` + `defaultHost`）。不做成运行时插件，因为公网 git SaaS 就那么几个，且"一等公民"要配套 SSH host-key pin（host key 是随平台发布固化的安全数据，不该由第三方运行时注入）。落 `shared-kernel` 是因为 credential 的 domain 与 contracts 都要用它，而 boundaries 禁 `domain→contracts`——shared-kernel 是两端唯一共同可依赖点（与 `git-remote.ts` 同性质）。

- **单一源驱动、零 switch**：`GitPlatform` 类型、`GitPlatformSchema` zod 枚举、openapi 的 `platform` 枚举、`defaultHostFor()` host 推导，全部从这张 registry 派生（旧实现散在契约枚举 + 领域重复 type + `hostForPlatform` switch + 前端两处，已收敛）。
- **加一个公网 SaaS 一等公民 = registry 加一行**（自动驱动上述全部；前端一份 `Record<Exclude<GitPlatform,'other'>,meta>` map 靠 TS 强制跟随，漏跟即编译报错）+（可选）在后端 `known-hosts` 按其 `defaultHost` 加一条 SSH pin（不加则 `accept-new` TOFU）。**无任何 switch/case 要改**。
- **自建实例（Gitea / GitLab / GHE，任意内网 host）零代码改动**：认证/clone 逻辑按 **host + scheme + token/key** 驱动、**不认平台**（03 §7.3），自建走 `platform:'other'` + `allowed_hosts` + `accept-new` 即用。registry 只影响"公网 SaaS 的默认 host 推导 + 显示名 + SSH pin"这三件便利/加固事。

## 9. Contract 版本管理：抽成独立 npm 子包，版本交给 npm 管

`packages/contracts` **就是一个真正发布的 npm 包** `@platform/sandbox-contracts`（含 §10 的 testkit 作为 `@platform/sandbox-contracts/testkit` 子路径导出）。版本管理因此不需要任何自研机制——semver、兼容范围解析、冲突检测、升级提示全是包管理器的既有能力：

| 要解决的问题 | 自研方案（已废弃） | 现方案（npm 原生） |
|---|---|---|
| 契约版本号 | contract 内置 `CONTRACT_VERSION` 常量 | 包的 `version` 字段 |
| 插件声明兼容范围 | 自定义 `platformPlugin.contractVersion` 字段 | `peerDependencies: { "@platform/sandbox-contracts": "^2.0.0" }` |
| 兼容性校验 | 启动时 `semver.satisfies()` 自己算 | **安装期**由 pnpm 解析 peer range，不满足直接装不上 |
| 破坏性变更提示 | 自己维护 CHANGELOG + WARN | changesets 生成 CHANGELOG + release note，`npm outdated` / Renovate 自动开 PR |
| 废弃过渡 | 运行时探测 + `/providers` 展示"将在 vNext 移除" | `@deprecated` JSDoc（IDE 与 tsc 直接提示）+ 保留一个 major 周期 |

- **版本语义**（写进包的发布纪律）：**patch** = 实现无关的内部修复；**minor** = 新增可选方法/字段或新增能力位（旧插件不实现即该位 false，不破坏）；**major** = 必须方法签名变更 / 删字段。本文档这一版把 `exec`+`attachPty`→`spawn`、删 `healthCheck`、能力位 10→6，是一次 **major**。
- **发布纪律**：`packages/contracts` 用 changesets 管理，任何改动必须带 changeset，CI 校验缺失即 fail——这是"有版本的公共契约"唯一需要自己加的一道闸。
- **唯一保留的运行时校验**：仅"插件目录扫描"这条旁路（§8 方式二）绕过了包管理器，`PluginLoader` 对它保留一次 `semver.satisfies(installedContractVersion, pkg.peerDependencies['@platform/sandbox-contracts'])`，不满足拒绝注册。走 npm 安装的插件不需要这一步。

> 与文档 10「REST/WS 不发 npm 包」不冲突：那条结论针对的是**前后端接口类型**（REST 有 codegen、WS 有 hash 比对两条更优路径）。这里是**后端内部的插件 SPI**，消费方是第三方实现者、分发渠道本来就是 npm，发包是成本最低而非最高的选项。

## 10. Golden 契约测试套件（testkit）

**目的**：第三方实现跑通即视为合格插件，无需平台维护者逐个审查。**内建实现（`aio` / `boxlite` / ClaudeCode / Codex）在 CI 跑同一套 testkit——无双重标准**，也倒逼 testkit 覆盖全面。

**形态**：`@platform/sandbox-contracts/testkit` 子路径导出（随契约包同版本发布，§9），导出 `runSandboxProviderContractTests(factory, opts)` 系列，内部 describe/it，按 capabilities 自动跳过未声明能力的用例。

```typescript
import { runSandboxProviderContractTests } from '@platform/sandbox-contracts/testkit';
runSandboxProviderContractTests(async () => new MyCustomSandboxProvider(testConfig));
// 全部 MUST 条款通过 = 兼容平台契约
```

### 10.1 判定标准（先有要求，用例只是要求的可执行表达）

- **条款分级**：`MUST` = 平台有代码依赖这条行为，违反会导致平台逻辑出错；`SHOULD` = 违反不致命但会降级体验。
- **准入线**：**全部 MUST 条款 100% 通过**才算合格实现；SHOULD 未过输出 warning 并计入报告，不阻断。
- **能力位一致性**：声明为 `true` 的每个能力位，其挂靠条款自动**从跳过转为必跑**。声明 true 却跑不过 = 不合格（比不声明更严重，因为平台会据此走对应分支）。
- **报告产物**：testkit 输出 `contract-conformance.json`（条款 id → pass/fail/skipped + 实测值），插件仓库 CI 与平台 CI 都留档；`GET /providers` 诊断接口可回显最近一次结果。

### 10.2 SandboxProvider 条款

| id | 级别 | 要求（规范原文） | 怎么判定（用例断言） |
|---|:--:|---|---|
| SP-01 | MUST | `create()` 返回的句柄，其 `provider` 字段必须等于 `provider.name` | 断言 `handle.provider === provider.name`；否则 registry 路由会串到别的实现 |
| SP-02 | MUST | `create()` 只创建不启动 | `create()` 后立即 `inspect()`，`lifecycleState` 不得为 `instance_running` |
| SP-03 | MUST | 镜像不存在时必须抛 `IMAGE_PULL_FAILED`，不得抛裸 Error | 传入垃圾 ref，断言错误 `code`；平台靠 code 决定"回滚配额并置 failed"还是"重试" |
| SP-04 | MUST | `start()` 后 `inspect()` 必须在 N 秒内报告 `instance_running` | 轮询 `inspect()` 至超时，断言到达 running；N 默认 30s，可由 `opts.startTimeoutSec` 放宽 |
| SP-05 | MUST | `start()` 对已运行实体幂等成功 | 连调两次 `start()`，断言第二次不抛 |
| SP-06 | MUST | `destroy()` 幂等 | 连调两次，断言第二次静默成功；对账清理逻辑依赖这一点 |
| SP-07 | MUST | 对已销毁句柄调用 `start`/`stop`/`spawn` 必须抛 `INVALID_STATE`，**不得静默成功** | 销毁后逐个方法调用并断言 code；静默成功会让状态机以为操作生效 |
| SP-08 | MUST | 实体查无时 `inspect()` 返回 `instance_missing`，**不抛 `NOT_FOUND`**；仅在自身不可达时抛 `PROVIDER_UNAVAILABLE` | 销毁后 `inspect()` 断言返回值而非异常——对账要靠它区分"确认没了"和"我看不见" |
| SP-09 | MUST | `spawn({tty:false})` 的输出是**已解复用的干净字节流**，`exitCode` 如实反映退出码 | 跑 `echo`/`exit 3`，断言 stdout 无任何流头字节、exitCode===3 |
| SP-10 | MUST | 并发 `create()` 两个 sandbox 互不干扰 | 并发创建后交叉 `spawn` 写文件，断言彼此看不到对方的文件 |
| SP-11 | MUST | `inspect()` 返回结构满足 `SandboxRuntimeStatus`，`health` 若存在则字段齐全 | schema 校验（zod）而非 `typeof` 抽查 |
| SP-12 | SHOULD | `stop()` 在 `timeoutSec` 内返回；超时转强制终止 | 起一个忽略 SIGTERM 的进程，断言仍能在 timeout+buffer 内停掉 |
| **CAP-01** | MUST | **声明的每个能力位都必须与实际行为一致** | 对每个声明 `true` 的位跑其挂靠条款；对声明 `false` 的位，断言调用对应可选方法抛 `UNSUPPORTED_CAPABILITY` |
| SP-T1 | MUST（`spawnTty`） | `spawn({tty:true})` 能双向收发，`resize()` 生效 | 写入 `stty size` 并 resize，断言输出的行列数随之变化 |
| SP-T2 | **SHOULD**（`spawnTty`） | `ProcessStream.ref` 稳定可复用：用它作 `reuse` 重连回同一会话 | 建会话 → 写入标记 → 断开 → `spawn({reuse: ref})` → 断言能看到先前会话的现场。**降为 SHOULD（审计 P1-10）**：现场保活实际依赖镜像内的 tmux，而 §7 只把 tmux 定为 SHOULD——两者原先一个 MUST 一个 SHOULD 自相矛盾。不具备会话保活的实现**必须**降级为网关侧 ring buffer（06 §6），前端协议语义不变 |
| SP-V1 | MUST（`volumeMount`） | `stop()` → `start()` 后工作区数据仍在 | 停机前写文件，重启后读出同一内容 |
| SP-W1 | MUST（`watchEvents`） | 实体异常退出后 N 秒内产出 `kind:'died'` 事件 | 强杀实体，断言事件在窗口内到达且 `handle` 匹配 |
| SP-U1 | MUST（`updateResources`） | 改配额后 `inspect().resourceUsage` 或实体限额随之变化，且**不重建**（句柄不变） | 断言前后 `providerSandboxId` 相同 |
| SP-P1 | MUST（`pauseResume`） | pause 后 `inspect()` 为 `instance_paused`，resume 后回到 `instance_running` | 状态往返断言 |

### 10.3 RuntimeAdapter 条款

| id | 级别 | 要求 | 怎么判定 |
|---|:--:|---|---|
| RA-01 | MUST | 洁净环境 `isInstalled()` 返回 false；`install()` 之后返回 true | 在干净镜像里跑完整安装往返 |
| RA-02 | MUST | `install()` 可重入：中途失败后重跑能收敛到已安装 | 注入一次失败后重跑，断言最终 `isInstalled()` 为 true |
| RA-03 | MUST | `beginAuth()` 收到 `getAuthMethods()` 之外的 method 必须抛 `UNSUPPORTED_METHOD` | 传非法 method 断言 code |
| **RA-04** | MUST | `parseOutput()` / 鉴权解析器对**录制的真实 CLI 输出 fixture** 产出预期结果 | 回放各 CLI 版本的 golden fixture；这就是 05 §6"CLI 升级改输出格式导致静默失效"风险的落地防线——CLI 一改输出，此条第一时间红。**每支持一个新 CLI 版本必须新增一份 fixture** |
| RA-05 | MUST | `beginAuth()` 产出的 `AuthChallenge` 字段齐全（`instructions` / `challengeRef` 必填）且 `expiresAt` 是 ISO 绝对时间 | schema 校验；前端倒计时依赖 `expiresAt` 语义 |
| RA-06 | MUST | `completeAuth()` 返回的 `credentialFiles[].content` 非空且路径为绝对路径 | 结构断言（内容不入日志、不写快照） |
| RA-07 | MUST | `buildStartCommand()` / `buildAttachCommand()` 返回非空 `cmd`，且为纯函数（同输入同输出、无 IO） | 连调两次断言深相等 |

### 10.4 ImageSpecProvider 条款

| id | 级别 | 要求 | 怎么判定 |
|---|:--:|---|---|
| IS-01 | MUST | 合法 ref → 完整 manifest 且 `digest` 非空 | 断言 digest 存在——没有它就谈不上"不可变坐标" |
| IS-02 | MUST | 不存在的 ref → 抛 `REF_NOT_FOUND` | 断言 code |
| IS-03 | MUST | `validate()` 违反入口约定 → `valid:false` 且 `errors` 非空并带可定位的 `path` | 断言 errors 结构，不接受只给 `valid:false` |
| IS-04 | MUST | `validate()` 是纯判断，不修改入参、不产生副作用 | 深冻结入参后调用，断言不抛 |
| IS-05 | SHOULD | 缺 tmux 等非致命项走 `warnings` 而非 `errors`（§7） | 断言该镜像 `valid:true` 且 warnings 命中对应 code |

## 11. 风险与备选


| 风险 | 缓解 |
| --- | --- |
| 插件进程内加载信任问题 | 文档明示；长期 worker_threads / 子进程隔离壳 |
| contract 过早固化 | capabilities + 可选方法渐进扩展；minor 版本加能力 |
| 第三方实现质量参差 | §10 的 MUST 条款作准入线 + 内建实现同标准 |
| 事件流断连漏事件 | §6 重连补偿对账 |
| **`aio` 上游镜像变更**（agent-infra 改入口/端口/预置 CLI） | ImageSpec `validate()` 校验入口约定 + 锁 digest（§7 IS-01）；testkit 在 CI 定期对最新镜像回归 |
| **`boxlite` 相对年轻**，能力位可能随版本变动 | 能力位由实现在注册时**实测上报**而非硬编码；CAP-01 条款保证声明与行为一致，不一致启动即 fail-fast |
| 契约发包带来的版本碎片（多个插件锁不同 major） | peerDependencies 让冲突在**安装期**暴露而非运行期；平台同时只支持一个 major |


