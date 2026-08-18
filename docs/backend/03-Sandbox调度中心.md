# 03 - Sandbox 调度中心设计

> 状态：✅ 可评审（基于 2026-08 调研结论；§4.0–4.2 / §7 / §8 按产品定稿 P20·P22·P21-6·P21-7 补充）
> 关联文档：[01 后端目录结构](./01-后端目录结构与DDD分层.md) · [04 Contract 体系](./04-Contract与Registry扩展体系.md) · [11 部署与扩展预留](../shared/11-部署与扩展预留.md)
> 产品依据：[P20 §9](../product/20-核心使用链路.md) · [P22 §1/§4](../product/22-异常场景与产品补充要求.md) · [P21-6 项目](../product/pages/21-6-项目管理.md) · [P21-7 自动化](../product/pages/21-7-自动化.md)

## 1. 资源模型

```typescript
interface ResourceQuota {
  cores: number;      // 可小数，如 0.5
  ramMb: number;
  diskMb?: number;
}

interface ResourcePoolSnapshot {
  totalCores: number;
  totalRamMb: number;
  totalDiskMb: number;     // ← 磁盘进调度（审计 P1-9）：它才是本平台的真实瓶颈
  usedCores: number;
  usedRamMb: number;
  usedDiskMb: number;
}
```

- **quota 值的来源（产品决策：用户不暴露配额概念）**：创建 sandbox 时用户**不输入**任何资源参数——平台自动决定：以镜像的 `resource_defaults`（04 §7 / 13 §2）为基础，后端策略可按 runtime/当前负载调整；REST/MCP API 保留**可选** quota 参数供程序化消费方（如上层 agent）使用，缺省即自动。调度、配额登记、对账等内部机制不变。
- 启动时探测宿主机资源：`os.cpus().length` / `os.totalmem()`。
- **安全余量**：默认保留 15% 给宿主 OS 与平台自身进程（可配置）。
- **超配策略**：CPU 允许超配（`overcommit.cpuRatio`，如 1.5——AI CLI 多为突发负载）；**内存不超配**（防 OOM）；**磁盘不超配**（超配等于必然写满）。
- **磁盘参与调度（审计 P1-9）**：工作区是宿主目录（§7.1），一个 Task 副本 ≈ 仓库体积；十几个 Task 就能写满盘，而 CPU/内存往往还很闲——**磁盘才是本平台的真实瓶颈**，必须进调度而不是只在准备阶段做一次预检。
  - 登记：创建时在**互斥区内**按 `projects.baseline_size_bytes × 1.2`（空项目取配置下限，默认 512MB）登记 `resource_allocations.disk_mb_reserved`；**消除 TOCTOU**——原先"准备阶段才预检"的写法在并发下会让 N 个 Task 同时通过预检然后一起写满盘。
  - 释放：与 CPU/内存同时释放；但**保留目录（§7.7）占用的磁盘不进资源池**（它已脱离 sandbox 生命周期），改为治理视角展示（P21-5 水位 + 保留卷占用横幅）。
  - 探测：`statfs(DATA_ROOT)` 取总量与已用；同样留 15% 安全余量。

## 2. 调度策略（可切换）

```typescript
interface SchedulingStrategy {
  trySchedule(request: ResourceQuota, pool: ResourcePoolSnapshot): SchedulingDecision;
  // SchedulingDecision = { ok: true } | { ok: false; reason: string }
}
```

| 策略 | 状态 | 适用 |
|---|---|---|
| **First-Fit（默认）** | 首期实现 | 单机场景足够，实现简单、延迟低 |
| Best-Fit | 接口预留 | sandbox 数量多、资源碎片化明显时切换 |
| NodeSelector + 节点内 first-fit | 多节点预留 | 先选节点再节点内调度，核心算法不变（见文档 11） |

调度策略是 `domain/services/scheduling.domain-service.ts` 内的纯函数逻辑，无 IO，可单测穷举。

## 3. 并发控制（防超分配）

- 资源池"读-改-写"（校验剩余容量 → 登记占用）必须在**临界区**内完成：`async-mutex` 或 Promise 链式队列，只把「配额登记/释放」这一小段串行化。
- 慢 IO（拉镜像、起容器）在临界区**外**并行执行；失败时回滚已登记配额。
- 所有创建/销毁请求先进 `SchedulerQueue`（FIFO），保证公平性与可预测性。

```
请求 → SchedulerQueue(FIFO) → [互斥区: 校验+登记配额] → 并行: 拉镜像/create/start
                                       │ 失败
                                       ▼
                                  回滚配额登记 → 状态 failed
```

## 4. 生命周期状态机

```
pending → scheduling → preparing-workspace → creating → starting → running ⇄ idle → stopping → stopped
               ↘              ↘                 ↘          ↘         ↘
                failed（可重试回 scheduling，或转 destroying）
stopped → starting          （重新拉起，复用已有工作区目录）
stopped/failed → destroying → destroyed（终态）
```

> **顺序定案（审计 P0-1 连带项）**：`preparing-workspace` 在 **`creating` 之前**。工作区是宿主目录（§7.1），必须在 `provider.create()` 之前就绪——否则创建实例时挂载源还不存在，04 §2.4 的 `volumes` 语义无法自洽。原先"先建实例再准备工作区"的顺序是 named volume 时代的遗留。

实现要点：

- 领域层**显式转移表 + guard** 实现（不引入 XState 这类较重依赖，接口设计不排斥未来替换为 XState v5）。
- **镜像拉取的职责归属（审计 P2-10）**：`creating` 阶段的"拉镜像"由 **`provider.create()` 内部负责**（04 testkit SP-03 要求镜像不存在时抛 `IMAGE_PULL_FAILED`），平台**不单独调用任何拉取接口**；`ImageSpecProvider.resolve()`（IS-01）只做**元数据解析与 digest 获取**，不拉层数据。两者职责不重叠：一个负责"这个 ref 长什么样、合不合规"，一个负责"把它变成能跑的实体"。
- **provider 拉镜像的两档差异 + agent 就绪门（权威见 [SANDBOX-RUNTIME-DECISIONS](../SANDBOX-RUNTIME-DECISIONS.md)）**：aio 走 Docker（socket-proxy）；**boxlite 走 BoxLite 自己的 OCI store（独立于 Docker、层下载不断点续传），落地须经本地 registry（`localhost:5001`）预置目标镜像**——自定义 `imageRegistries` 会替换默认表，必须显式保留 `docker.io`。此外，`starting → running` 前须**探测沙箱内 agent（`:8080`）就绪**——终端/exec 数据面依赖它，agent 未就绪即转 `running` 会让首个终端连接失败；agent 端口**仅内网可达、不 publish 到宿主外部**。
- 每次转移落库并发 `SandboxStateChanged` 领域事件 → WS 事件通道推送前端 + terminal 上下文级联处理。
- **idle 回收**：可配置 `idleTimeoutSec`，后台 `SandboxReaper` 定时扫描，无活动则 running→idle→stopped，**释放配额但保留数据卷**，可快速重新拉起。判定口径见 §4.2。
- 非法转移抛领域错误，interface 层翻译为 409。
- **对账特权转移**：对账（文档 13 §4）判定 orphaned 时，允许从**任意非终态**直接转 `failed`——reconcile 属于特权路径，不受常规转移表约束，但同样落库转移历史（`triggered_by: 'health-check'`）。

### 4.0 `preparing-workspace` 细分态：**加**（产品 P20 §9.6 待评估项的技术定案）

**结论：作为正式状态值加入状态机与 `sandboxes.status` 枚举**（13 §2 同步），位于 **`scheduling` 与 `creating` 之间**（审计 P0-1 修订——工作区必须先于实例存在）。

理由（三条，缺一条都不足以升格为状态）：

1. **产品进度卡的四个阶段是定稿契约**（P20 §3.3：初始化 → 拉取镜像 → 准备工作区 → 启动实例）。若不加状态，前端只能靠事件里的自定义 phase 字段推断阶段，UI 阶段与状态机两套真值必然漂移；加了状态，`sandbox.status_changed` 一条通道同时喂状态与进度。
2. **它是可失败、可耗时、可取消的独立阶段**：Task 级工作区副本准备（§7.6）要复制整个仓库，几十秒到数分钟；失败有专属错误码 `WORKSPACE_PREPARE_FAILED` / `DISK_INSUFFICIENT`（P22 §1），与拉镜像失败必须能被用户区分。
3. **它有专属的失败清理动作**：半成品**目录**必须删除（§7.6 `rm -rf`），而 `creating` 失败清理的是实例。清理动作不同 = 状态不同。

代价与边界：`sandboxes.status` 枚举加一个值（drizzle 双方言 CHECK 同步改，13 §5）、转移表加两条边（`scheduling→preparing-workspace`、`preparing-workspace→creating|failed`）。`stopped → starting` 的重新拉起**不再经过**该状态（工作区目录已存在，无需重复准备）。

> 产品侧的四阶段进度卡（P20 §3.3「初始化 → 拉取镜像 → 准备工作区 → 启动实例」）**展示顺序与技术顺序不同**：技术上先备工作区再拉镜像/建实例。进度卡是**面向用户的叙述**，不是状态机的镜像——前端按 `sandbox.status_changed` 映射到四个格子即可（`preparing-workspace` → 「准备工作区」，`creating` → 「拉取镜像」）。这条差异必须写在前端状态映射表里，否则会有人以为状态机顺序错了。

### 4.1 `waiting-input` 子态（产品 P20 §9.8 / P21 §2.1 的技术定案）

**它不是状态机的第 12 个状态，而是 `running` 的运行时子态。**

| 方面 | 定案 |
|---|---|
| 归属 | `running` 之下的布尔子态，**不写 `sandboxes.status`、不进 `sandbox_state_transitions`**——它每次输入输出都可能翻转，落库会造成写放大与转移历史噪音（一个 10 分钟会话可能翻转上百次） |
| 检测位置 | **TerminalGateway（网关侧）**——它是唯一持有已解复用 pty 字节流的地方（06 §8）；provider / adapter 不介入，避免每个实现各写一份启发式 |
| 判定 | pty 输出**静默 > N 秒**（`terminal.waitingInputSilenceSec`，**默认 10s**，可配）**且**该会话最后一个非空行匹配提示符启发式正则集 |
| 恢复条件 | **任意 pty 输出**或**任意用户输入帧**立即回 `running` 并推送——两者都是"不在等待"的确证，不设去抖延迟 |
| 适用范围 | 仅对**存在 attached tty 会话**的 sandbox 检测；无头 Task（`headless: true`）不参与，其"卡住"由硬超时兜底（§8.3）。sandbox 有多个终端会话时，**全部会话都判定为等待**才上报子态（任一会话在刷输出即说明 agent 在干活） |
| 上报 | WS `sandbox.waiting_input { sandboxId, waiting: boolean, sessionId? }`（10 §3）；REST `GET /api/sandboxes` / `GET /api/sandboxes/:id` 响应带派生字段 `waitingInput: boolean`（由网关内存态提供，供前端刷新后恢复展示） |
| 与 idle 的关系 | 两者互不抑制：waiting-input 期间 `last_active_at` **照常不更新**，idle 计时正常推进——"等待用户输入"本身就是空闲，静默 30min 依然应被回收（P22 §2 的 idle 文案与此一致） |

**误报容忍度（必须写进实现注释与测试用例）**：提示符启发式是**不可能做准的**——agent CLI 的输出里出现形似提示符的文本、或 agent 长时间思考不输出，都会误报；反之 agent 用带动画的 spinner 持续刷新会漏报。因此定死一条红线：

> **`waiting-input` 只驱动展示，不驱动任何自动化决策。** 它不触发 idle 回收、不参与调度、不改变 `sandboxes.status`、不影响自动化调度器的 `PREVIOUS_RUNNING` 判定、不进入任何 SLA 统计。误报的最坏后果是列表上一个图标短暂显示错误，用户点进终端一眼即知。

调参方向据此确定：**宁可漏报不可误报**——阈值宁大勿小（10s 是折中；实测误报多则调到 15–20s），正则集宁窄勿宽。

提示符启发式正则集（可配置扩展，`terminal.promptPatterns`）：

```
/[>$#❯➜»]\s*$/          // 通用 shell / REPL 提示符
/\?\s*$/                 // 疑问句结尾（"Do you want to continue?"）
/\[[yYnN]\/[yYnN]\]\s*$/ // [y/N] 确认
/:\s*$/                  // "Enter your choice:" 类
```

判定前先剥离 ANSI 转义序列与光标控制码，再取最后一个非空行。

### 4.2 idle 判定口径（产品 P22 §2 的技术定案）

- **idle = 终端无输入输出**，**不是**进程 CPU 占用。理由：agent CLI 等待用户输入时进程照样有心跳/轮询开销，按 CPU 判定会把"人已经走了"的会话永远判成活跃；反过来 agent 跑长任务时输出不断，终端流量天然覆盖。
- `sandboxes.last_active_at` 的唯一写入方是 TerminalGateway：每收到 pty `data` 帧或客户端 `input` 帧即刷新，**落库节流 ≥10s 一次**（内存里实时、DB 里粗粒度，Reaper 的分钟级扫描不需要秒级精度）。
- **无终端会话的 sandbox**：无头 Task 不走 idle 回收（无终端可言），只受硬超时约束（§8.3）；交互式 Task 的终端全部关闭后 `last_active_at` 停止更新，idle 计时正常推进。
- **重启语义**：`stopped → starting` 开的是**新的 agent 会话**——tmux 现场恢复（06 §6）**只适用于 WS 断线重连**，不适用于 idle 回收后重启。stop 时 tmux server 随实例一起停止，重启后是全新 session；工作区文件在卷上保留。前端文案不得暗示"恢复现场"（P22 §2 已定文案）。

## 5. CPU 限额的两种模式（按 sandbox tier 提供）

平台只在 quota 上表达 tier 语义（hard / burst），具体施加方式是 provider 实现内部的事（04 §2.4：quota 由调度器登记，实现负责落到运行时）：

| 模式 | 语义 | 实现落点（参考） | 适用 |
|---|---|---|---|
| 硬 cap | 严格按 cores 上限 | aio：cgroup CPU 配额；boxlite：micro-VM vCPU 配置 | 强隔离场景，严格公平 |
| 软 cap + burst | 允许临时借用空闲算力 | aio：CPU shares + 软限制；boxlite：视版本支持 | 追求响应速度；建议默认留 20–30% burst 余量 |

内存统一硬限制（不超配）。

## 6. 与其他模块的边界

- 调度器只产出「决策 + 配额登记」；实际实例操作走 `SandboxProvider` contract（文档 04），调度器不依赖任何具体实现细节。
- 配额登记表持久化（重启后恢复资源池视图：扫描存活容器 + 落库配额对账）。

## 7. 工作区编排：项目 clone 与 Task 独立副本

> 产品依据：P20 §9.5/§9.6、P21-6 §3.2/§6/§9、P21-3 §10、P22 §2/§4.13/§4.16。

### 7.1 两级工作区模型：**宿主 bind mount 目录**（审计 P0-1 方案 A）

```
DATA_ROOT/                              ← compose 用同一绝对路径挂进 api 容器（宿主/容器路径一致）
├── baselines/<projectId>/              ← 项目基线：clone 的落点，只读语义，不挂进任何 sandbox
└── workspaces/<sandboxId>/             ← Task 专属副本，bind mount 到实例内 /workspace（rw）
```

| 环节 | 实现 |
|---|---|
| 创建项目 | 平台进程内 `simple-git` 直接 clone 到 `DATA_ROOT/baselines/<projectId>`（§7.2） |
| Task 准备 | `cp -a` 复制到 `DATA_ROOT/workspaces/<sandboxId>`；**同文件系统时用 `cp --reflink=auto` 拿写时复制**（btrfs/xfs 上近乎零拷贝、零额外占用，见 11 §1） |
| 挂载 | `VolumeMount{ source: '<DATA_ROOT>/workspaces/<sandboxId>', target: '/workspace', mode: 'rw', kind: 'host-path' }`（04 §2.4） |
| 半成品清理 | `rm -rf` 目录；识别靠目录内的标记文件 `.platform-workspace-state`（值 `preparing` / `ready` / `kept`） |
| 回收与对账 | `VolumeReaper` 与启动对账**退化为目录扫描**——`readdir(workspaces/)` 与 DB 记录比对，无需 provider API |

**为什么是宿主目录而不是 named volume**（审计 P0-1 裁决理由）：

1. **DooD 下 named volume 的复制无解**——平台进程在容器里，要把基线复制进 named volume 得再起一个挂载两卷的临时容器，一次 Task 创建多一次容器生命周期；宿主目录只是一次 `cp -a`。
2. **CoW 只有文件系统给得了**：`--reflink=auto` 在 btrfs/xfs 上让"每 Task 独立副本"的磁盘成本从 N×仓库体积降到接近 1×，这是本方案最大的收益（磁盘是真实瓶颈，§1）。
3. **可观测**：出问题时运维能直接 `ls` / `du` 看工作区，不必 `docker volume inspect`。
4. **代价与边界**：① 宿主路径与容器路径必须一致（compose 用绝对路径挂载，11 §1）；② 文件属主/权限要与容器内运行用户对齐（准备阶段 `chown` 一次）；③ 跨文件系统时 `--reflink` 静默退化为全量拷贝，**必须在启动诊断里报出 DATA_ROOT 的文件系统类型**，否则用户会在 ext4 上疑惑磁盘为什么涨得快。

空项目（`source_type='empty'`）没有基线目录，Task 级直接 `mkdir` 空目录。
`projects.workspace_mode='shared'`（v1.1 协作共享卷）时跳过复制，直接把 `baselines/<projectId>` 以 rw 挂载——本文档只留分支位，v1.1 再细化并发写保护。

### 7.2 项目 clone 的异步编排

| 环节 | 设计 |
|---|---|
| 入口 | `POST /api/projects` **立即返回 202** + project 记录（`clone_status='cloning'`），不阻塞请求 |
| 执行 | 后台 job（与 SchedulerQueue 分离的独立队列——clone 不占 CPU/内存配额，只占磁盘与带宽；同一时刻并发 clone 数上限 `project.maxConcurrentClones`，默认 2）。**平台进程内直接跑 `simple-git`**，落点 `DATA_ROOT/baselines/<projectId>`——不再需要任何容器参与 |
| 进度 | `git clone --progress` stderr 解析（`Receiving objects: NN% (x/y), N.NN MiB`）→ 节流 1s → WS `project.clone_progress { projectId, phase, receivedBytes?, totalBytes?, percent? }`（10 §3） |
| 慢仓库提示 | 超过 **10min** 仍未完成：推一条 `phase:'slow'` 事件，前端出"⚠️ 仓库较大或网络缓慢 [继续等待]/[取消]"（P21-6 §6），**不终止** |
| 硬超时 | **30min** 强制终止子进程 → `clone_status='failed'` + `error_code='TIMEOUT'`；半成品目录 `rm -rf` |
| 重试 | `POST /api/projects/:id/retry-clone`（仅 `failed` 态，02 §5.1）→ 显式重置 `clone_status='cloning'` 重新入队；**不允许隐式回退**（23 I-PRJ-6） |
| **改为空项目** | `POST /api/projects/:id/convert-to-empty`（仅 `failed` 态）→ 放弃克隆转空项目：`source_type='empty'` + `repo_url/baseline_path/baseline_size_bytes` 全部置 null + **`rm -rf` 半成品基线目录**（复用本表「取消」的清理路径）+ `clone_status='ready'`；**项目 id / 名称 / 已关联 Task 保持不变**。产品语义见 P21-6 §5/§9 |
| 取消 | `DELETE /api/projects/:id`（cloning 态）或前端 [取消] → SIGTERM 子进程 → `rm -rf` 半成品目录 → 删项目记录 |
| 幂等 | 进程重启后扫描 `clone_status='cloning'` 的项目：无对应子进程即判定中断 → 置 `failed`（`error_code='INTERRUPTED'`）+ `rm -rf` 目录，让用户显式重试（与自动化的 "missed 不补跑" 同一哲学：不擅自续跑用户看不见的长操作） |
| 深度 | MVP 用 `--depth=1`（后续 Task 只需工作副本，不需要历史）；`git push` 汇回（v1.5）落地前再评估是否改全量克隆 |

### 7.3 Git 凭证的使用链路（凭证 kind='git'，见 05 §3.2 / 23 §8）

**编排边界（A 裁决）**：clone 编排在 **project 上下文**，Git 凭证的解密与 materialize 在 **credential 上下文**。project 侧**不碰明文**——`RepoUrl.credentialKind()` + `RepoUrl.host()` + `RepoUrl.scheme()` 算出 `kind`、`host` 与 `scheme`（23 §6.3），经门面 `CREDENTIAL_FACADE.prepareGitAuth(kind, host, scheme)`（`@Inject(CREDENTIAL_FACADE)`，23 §8 / 27 §5）拿一个**不透明句柄** `GitAuthContext = { env, gitSshCommand?, dispose() }`。`GitCloner` 的 `CloneRequest` 因此扩展两字段承载已 materialize 的产物：

```ts
interface CloneRequest {
  url: string; targetDir: string; branch?: string;
  env?: Record<string, string>;   // 来自 GitAuthContext.env（token/helper 配置只在此）
  gitSshCommand?: string;         // 来自 GitAuthContext.gitSshCommand（SSH 场景）
}                                 // ❌ 绝不把 credentialId 传进 adapter——否则 infrastructure 回调 credential，层次颠倒
```

句柄的 `dispose()` 由 clone workflow 在 clone 的 **`try/finally`** 调用（删临时密钥目录、清 env 引用）。**选择规则（P21-3 §10.3 已定，后端按 URL 协议自动选，不给用户选择项）**：

| clone URL | 使用凭证 | 落地方式（**全部发生在 `credential/infrastructure` 内**，project 只拿句柄） |
|---|---|---|
| `git@host:...` / `ssh://...` | `obtained_via='git-ssh-key'` | 解密私钥 → `fs.mkdtemp()` 随机目录（平台用户属主 `0700`）内 keyfile 以 `wx`+`0600` **独占创建、不跟随符号链接**；`gitSshCommand = "ssh -F /dev/null -i <keyfile> -o IdentitiesOnly=yes -o GlobalKnownHostsFile=/dev/null -o UserKnownHostsFile=<平台私有> -o StrictHostKeyChecking=accept-new"`（两处 `/dev/null` 见 §7.3 known_hosts 段）。每次 clone **独立目录**，`dispose()` 整目录 `rm -rf`（防可预测文件名的 symlink 攻击） |
| `https://...` | `obtained_via='git-https-token'` | **credential helper 走内存 + 按 host 绑定**：对 `allowedHosts` 里**每个** host 各下发一条 **URL-scoped** 配置 `-c credential.https://<host>.helper='!f(){ echo username=x-access-token; echo password=$GIT_TOKEN; }; f'`（git 仅在请求该 host 时才调它）；token 仍只经 env `$GIT_TOKEN`、**绝不进 URL/argv**、不写任何文件（防落进 `git config`、reflog、进程 argv 与日志） |

**host 绑定与白名单（C 裁决——修一条能外泄 PAT 的 P0）**：

- **git-https-token 凭证携带 `allowed_hosts`（host 白名单，≥1 个；一条 token 可绑多个 host，13 §2.5.1 / 23 I-CRD-8）**。此前的 helper 对**任何** URL 无条件回吐 token → 用户配了 GitHub PAT 后，建一个 `https://evil.example.com/x.git`（公网、能过 SSRF 黑名单）的项目，clone 时 helper 就把 PAT 发给 evil；`/git/test { repoUrl }` 更是直接汲取面。
- **helper 按 host 绑定**（上表 C2）：URL-scoped 到白名单里每个 host，git 只在请求该 host 时才调对应 helper。
- **clone 与 `/git/test` 前置校验（C3，凭证去向的唯一授权边界）**：目标 URL 的 host ∈ 该凭证 `allowed_hosts`，否则**拒绝携带凭证**（clone 失败 / test 返回 `errorCode`），不给"对任意 host 吐 token"的机会。**`allowed_hosts` 是"token/私钥可以发给谁"的唯一控制**——用户把内网 host 填进白名单就是显式授权发内网，把公网 host 填进去就发公网。
- **口径是 authority（host + 非默认端口），不是裸 host（git ≥ 2.50 端口敏感）**：git 的凭证匹配按 authority——`credential.https://h.helper` **不**匹配 `https://h:8443/`。因此全链（`RepoUrl.host()` → 门面 → helper 键 `credential.<scheme>://<authority>.helper` → `allowed_hosts` 精确相等校验）统一用 **authority**：默认端口（https=443 / ssh=22）省略、非默认端口保留。企业自建 GitLab/Gitea 常跑 `:8443`/`:3000`，用户在 `allowed_hosts` 里填 `git.company.com:8443`；`github.com`（默认端口）即裸 host。只此一套规范化，不搞"端口无关"的第二套（避歧义）。
- **helper 键按 repoUrl 的实际 scheme 生成（http/https 都支持，git 凭证匹配是 scheme+authority 敏感）**：git 的凭证匹配同样对 scheme 敏感——`credential.https://h.helper` **不**匹配明文 `http://h/`。因此 helper 键的 scheme 段取自 repoUrl 的**实际** scheme（`RepoUrl.scheme()` → 门面 → materializer），http 远端下发 `credential.http://<authority>.helper`、https 远端下发 `credential.https://<authority>.helper`；否则内网明文 http git 远端即使 token 正确也匹配不上 helper、被静默丢弃（"权限失败"）。**`allowed_hosts` 保持 scheme 无关**（用户授权某 host 即授权其 http/https，scheme 跟随 repoUrl），只 helper **键**跟 scheme 走。**http 远端 token 是明文过线**（cleartext）——materializer 会打一条 warn 日志提示，但**不硬阻断**：内网明文自建 git 是用户自己的信任域（与 C4"不禁私网"同哲学），是否走 http 由用户的网络决定。
- **平台一等公民靠单一注册表驱动（横向扩展点）**：公网 git SaaS 的"默认 host 推导 + 显示名 + SSH host-key pin"由 `shared-kernel` 的 `GIT_PLATFORM_REGISTRY`（github/gitlab/gitee/gitea → label + defaultHost）**单一数据源**驱动——`GitPlatform` 类型、zod 枚举、openapi 枚举、`defaultHostFor()` 查表全部从它派生，**无 switch/case**。**加一个公网 SaaS 一等公民 = registry 加一行**（自动驱动上述全部；前端一份 `Record<平台id,meta>` map 靠 TS `Exclude<GitPlatform,'other'>` 强制跟随，漏跟即编译报错）+（可选）在 `known-hosts` 按其 defaultHost 加一条 SSH pin（不加则走 `accept-new` TOFU）。**认证/clone 逻辑本身按 host+scheme+token/key 驱动、不认平台**，因此**自建 GitLab/Gitea/GHE（任意内网 host）零代码改动**——走 `platform:'other'` + `allowed_hosts` + `accept-new` 即用。
- **rebinding/MITM 闭合（C4，修正版）**：**本产品是单机私有化部署，企业自建 git 常在内网（`10.x`/`172.16.x`/`192.168.x`），clone 内网私有仓是核心用例——因此"携凭证禁私网"是错的、已废弃**（会砸掉核心用例）。DNS rebinding / MITM 的**硬闭合**改为：
  - **HTTPS**：**TLS 证书校验**（保持默认 `sslVerify=on`，`GUARDED_ENV` 额外剥离 ambient `GIT_SSL_NO_VERIFY` 防静默关闭）。rebind 到内网 IP 的伪主机拿不出该域名的合法证书 → 发凭证前 TLS 握手即断。内网自建若用自签证书，那是**用户自己的网络信任域**（与网络隔离同一前提），需用户为其配 CA；平台不因此关校验。host-scoped credential.helper 只对原 host 发、git 默认不跨 host 重发凭证（即使重定向），是第二重。

- **hermetic 对无凭证/公开仓 clone 同样成立（凭证卫生红线）**：带凭证时 materializer 在 `GIT_CONFIG` index 0 下发空 `credential.helper=` 复位 helper 链（中和内置 osxkeychain 等 ambient helper）；**无凭证（公开仓 / 私有仓未配凭证）clone 路径必须同样注入这条复位**——否则 git 会去问 ambient/内置 helper（macOS Apple Git 编译内置的 osxkeychain 不是 env 变量、`GUARDED_ENV` 剥不掉），用宿主 keychain 里缓存的某条凭证完成一次平台本意匿名的 clone（对真实 GitLab 私有仓已实测复现：污染 keychain 后无凭证 clone 竟成功）。故 `git-cloner` 对**所有**平台 clone（credentialed 与否）**恒**注入 `credential.helper=` 复位 + 一条无 ambient identity 的 hermetic `GIT_SSH_COMMAND`（`-F /dev/null -o IdentitiesOnly=yes -o IdentityAgent=none`），确保任何平台 clone 都不使用 ambient 凭证/密钥。
  - **SSH**：**pinned known_hosts（公网 SaaS，见 H）**——rebind/MITM 到伪主机时 host key 不匹配、握手即断（私钥签名前）；自建未知 host 的首连由**网络隔离**承担（accept-new，H）。
  - **纵深（非硬闭合）**：`RepoUrl` VO 的字面 SSRF 黑名单仍拦 **loopback（`127/8`、`::1`）+ 链路本地/云 metadata（`169.254/16`、`fe80::/10`）+ 未指定地址（`0/8`）**——这些**永不是**合法 git host，免费纵深；**但私网段（`10/8`、`172.16/12`、`192.168/16`、`fc00::/7`）放行**。
- **SSH 侧（C5）**：SSH 凭证也记录 host（用于 known_hosts 指纹与展示）；SSH 私钥不会被对端服务器窃取（只交换签名挑战），rebinding/MITM 由 **pinned known_hosts（H）**闭合。

补充纪律：

- **凭证只在平台侧使用，绝不注入 sandbox**（P21-3 §10.3）——clone 与复制都发生在平台进程内，Task 容器里没有任何 git 凭证。
- `GIT_TERMINAL_PROMPT=0` + `GIT_ASKPASS=/bin/true`：禁止 git 在无人值守环境下卡在交互提示上（否则 30min 硬超时才能救回来）。
- **passphrase 私钥 MVP 不支持（F 裁决，检测须完备）**：保存时校验——私钥 PEM 含 `Proc-Type: 4,ENCRYPTED` / `DEK-Info:`（传统 PEM）、**`-----BEGIN ENCRYPTED PRIVATE KEY-----`（PKCS#8 加密私钥）**，或 **OpenSSH 新格式稳健解析出的 `ciphername ≠ none`** → 拒绝保存并返回人话提示（P21-3 §10.2）。**无法确证为"无口令"的格式默认拒绝**（而非默认放行）。理由：无人值守环境无处输入 passphrase，ssh-agent 常驻又把明文密钥留在内存里跨请求存活，MVP 不值得。

**SSH 临时文件落地加固（F 裁决）**：

- 临时私钥文件：`fs.mkdtemp()` 随机目录（平台用户属主 `0700`）+ keyfile `wx`+`0600` **独占创建、绝不跟随符号链接**；**每次 clone 独立目录**，用完整目录 `rm -rf`（防可预测文件名的 symlink 攻击）。目录**建议置于 tmpfs**；文档明示"明文私钥短暂落盘"为**接受风险**。
- **崩溃兜底**：`try/finally` 与 `process.on('exit')` 在 SIGKILL/OOM/断电下都不执行 → 改成**启动清扫**私有 keyfile 目录（与 §7.6 工作区 `.platform-workspace-state` 对账同思路），不依赖进程退出钩子作为唯一防线。
- **`GIT_SSH_COMMAND` 注入必须在 guard 之后**：git-cloner 的 `GUARDED_ENV` 会剥离 `GIT_SSH_COMMAND`/`GIT_SSH`（防环境透传）→ 平台自造的 `GIT_SSH_COMMAND` 必须在 **guard 之后合并**（是平台自造值、非透传）。自造值为 `ssh -F /dev/null -i <keyfile> -o IdentitiesOnly=yes -o GlobalKnownHostsFile=/dev/null -o UserKnownHostsFile=<pinned 或平台私有> -o StrictHostKeyChecking=<yes 或 accept-new>`（按 host 是否 pinned SaaS 二选一，见 H）。**两处 `/dev/null` 都是硬性要求(host-key 验证必须只认平台自己的 known_hosts 文件)**：① `-F /dev/null` 忽略 ambient `~/.ssh/config`，防其改写 host（如 `github.com`→`ssh.github.com:443` 会绕过 pin）、注入 `ProxyCommand` 或追加 ambient IdentityFile；② **`GlobalKnownHostsFile=/dev/null` 忽略宿主 `/etc/ssh/ssh_known_hosts`**——否则宿主全局 known_hosts 里若有 github 真 key,会在我们 pin 了别的 key 时**照样接受、静默绕过 pin**(CI runner 预置全局 known_hosts 的场景已实测复现)。**加断言**：带 SSH 凭证时子进程 env 里 `GIT_SSH_COMMAND` 存在且含 `-F /dev/null -o GlobalKnownHostsFile=/dev/null` 并指向本次 keyfile。

**日志脱敏（G 裁决）**：

- **`GIT_TRACE` / `GIT_TRACE_CURL` / `GIT_CURL_VERBOSE` / `GIT_TRACE_PACKET` 整族加入 `GUARDED_ENV`**——否则宿主设了这些，clone 的 curl trace 会把 `Authorization: Basic base64(x-access-token:PAT)` 打进 stderr → `stderrTail`。
- `sanitizeCloneMessage` 现只匹配 `ghp_`/`github_pat_`/URL userinfo/query → **补 `Authorization:` 行整体打码**；过滤 URL 中的 userinfo 与任何 `password=` 片段（与 05 §4 同一纪律）。
- **加断言**：拼出的 git 参数数组**不含 token 明文**，`GIT_TOKEN` **只出现在 env**。

**known_hosts（H 裁决——SSH rebinding/MITM 的硬闭合）**：

- **公网 SaaS（`github.com` / `gitlab.com` / `gitee.com`）内置 pinned host 公钥**（ed25519 + rsa 两类，固化进代码 `credential/infrastructure/git/known-hosts.ts`；github/gitlab 已核对与各厂商官方公布的 SHA256 指纹一致，gitee 经 ssh-keyscan 采集）。这些 host 用 **`StrictHostKeyChecking=yes`** 指向**每次写入的** pinned `known_hosts` 文件（`0600`，每次覆写保证不可被前次写入污染）——rebind/MITM 到伪主机时 host key 不匹配 → **"Host key verification failed"，握手即断、私钥签名之前**。key 轮换需改代码 + 指纹（这正是 pin 生效：静默换 key 必须失败而非自动信任）。
- **仅"公司自建 Git（用户填的未知 host）"回落 `StrictHostKeyChecking=accept-new`**（首连 TOFU）——使用**平台私有** `UserKnownHostsFile`（不碰系统 `~/.ssh/known_hosts`），首连自动记录主机指纹，**之后主机密钥变更则 clone 失败**（accept-new 只信任新主机、不接受变更，这是与 `no` 的关键差别）。安全边界明示：自建场景首连 MITM 风险由网络隔离承担，无头容器内交互确认不可行（P21-3 §10.2 已定）。
- 两条都配 `-F /dev/null` + `-o GlobalKnownHostsFile=/dev/null` 使 ssh 只认平台自己的 `UserKnownHostsFile`：前者忽略 ambient `~/.ssh/config`（host 改写会绕过 pin），后者忽略宿主 `/etc/ssh/ssh_known_hosts`（全局 known_hosts 里的真 key 会静默绕过 pin，见上）。

### 7.4 测试连接端点

`POST /api/credentials/git/test` → 执行 `git ls-remote --exit-code <url>`，**15s 超时**（P21-3 §10.2），只回 `{ ok, errorCode?, message }`，不回任何 ref 列表（避免泄露私有仓分支名）。未传 `repoUrl` 时用凭证来源推断的默认探测地址（GitHub/GitLab/Gitee 的 `git@host` 回环测试）。

**body 是判别联合，两种来源（产品有"存前测"与"卡片测"两个入口，P21-3 §10.1/§10.2）**：

```ts
GitTestRequest =
  // ① 存前测（配置面板「粘贴→测试→保存」，密钥尚未入库）：用 inline 密钥瞬时组装凭证，绝不写库
  | { source: 'inline'; type: 'ssh-key' | 'https-token'; secret: string;
      platform?: 'github' | 'gitlab' | 'gitee' | 'other'; allowedHosts: string[]; repoUrl?: string }
  // ② 卡片测（已配置卡片的 [测试连接]）：用已存凭证从 Vault 解密
  | { source: 'stored'; credentialId: string; repoUrl?: string }
```

- `inline` → 用请求里的 `secret` 走 §7.3 同一 `git-auth.materializer` 做**瞬时 materialize**（产 `GitAuthContext`，**绝不入 `credentials` 表**），`host ∈ allowedHosts` 按**请求里的 `allowedHosts`** 校验；passphrase 私钥在此同样拒绝（F）。
- `stored` → 经 `CREDENTIAL_FACADE.prepareGitAuth`（A2）从 Vault 解密，`host` 按该凭证的 `allowedHosts` 校验。

**前置校验同 clone（C 裁决）**：目标 URL 的 host **必须 ∈ 该凭证 `allowed_hosts`**，否则**拒绝携带凭证**并直接返回 `errorCode`（不给"对任意 host 吐 token"的机会——`/git/test` 是最直接的汲取面）；rebinding/MITM 闭合同 clone（HTTPS 靠 TLS、SSH 靠 pinned known_hosts，**不禁私网**——内网自建仓的 test 是核心用例，C4 修正版）。`/git/test` 支持 `source: 'inline' | 'stored'` 判别联合（存前测/测已存卡片），inline 密钥瞬时 materialize、绝不入库。

### 7.5 clone 错误码（对应 P22 §1 新增项）

| 判定来源 | 错误码 | retryable |
|---|---|---|
| `Authentication failed` / `Permission denied (publickey)` / HTTP 401·403 / `could not read Username` | `CLONE_FAILED_PERMISSION` | ❌（要用户去配凭证） |
| DNS 解析失败 / `Could not resolve host` / 连接被拒 / TLS 失败 / HTTP 5xx / `Repository not found` 且无凭证 | `CLONE_FAILED_NETWORK` | ✅ |
| 目标卷所在盘剩余空间 < 需求（clone 前预检 + 写失败时 `ENOSPC`） | `DISK_INSUFFICIENT` | ❌（要用户清理） |
| 30min 硬超时 | `TIMEOUT` | ✅ |

**权限类与网络类必须区分**（P22 §2 的前端分支引导依赖它）：判定顺序是先匹配权限类关键字，再匹配网络类，都不匹配则归 `CLONE_FAILED_NETWORK`（更保守——引导用户重试比引导去配凭证的代价小）。`Repository not found` 在 GitHub 上对私有仓也是这个文案（防信息泄露），因此**已配置凭证时**把它归为 `CLONE_FAILED_PERMISSION`。

### 7.6 Task 级工作区准备（`preparing-workspace` 阶段）

```
scheduling 完成（配额已登记，含 disk_mb_reserved —— §1 已消除 TOCTOU）
   → preparing-workspace
       1. mkdir DATA_ROOT/workspaces/<sandboxId> + 写标记文件 .platform-workspace-state=preparing
       2. cp -a --reflink=auto  baselines/<projectId>/.  →  workspaces/<sandboxId>/
          （空项目：跳过复制，留空目录）
       3. chown 到容器内运行用户（HOME/工作区可写是镜像约定，04 §7）
       4. 标记文件改为 ready
   → creating（provider.create 时把该目录作为 host-path 挂载，源已存在）
   → starting（凭证 materialize + injectCredential，05 §4）
```

- **失败即 `WORKSPACE_PREPARE_FAILED`**（磁盘写满时用更具体的 `DISK_INSUFFICIENT`）→ 状态转 `failed` + `rm -rf` 半成品目录 + 回滚配额登记（§3）。此时**尚未创建实例**，补偿动作比旧顺序更简单——这是把 `preparing-workspace` 前移的附带收益。
- **取消的清理**：用户在进度卡取消或进程重启后发现残留 → 扫 `workspaces/` 下标记文件为 `preparing` 的目录，一律 `rm -rf`（启动对账，13 §4）。半成品目录没有任何保留价值。
- **`ready` 孤儿目录清理**（交叉评审 P2-8）：销毁 keepVolume 流程中"`provider.destroy` 后、打 `kept` 标记/登记 `RetainedVolume` 前"崩溃，会留下标记仍为 `ready` 且 DB 无 `retained_volumes` 记录的孤儿目录。启动对账补一条判据：**sandbox 已 destroyed/failed 但目录标记仍 `ready` 且无 retained 记录 → `rm -rf`**（有 retained 记录的 `kept` 目录才保留）。
- 复制期间不占用 CPU/内存配额（配额已在 §3 互斥区登记，此处只是 IO），但**计入并发准备数上限**（`sandbox.maxConcurrentWorkspacePrepare`，默认 2）防止多个 Task 同时复制大仓库把磁盘 IO 打满。**在 CoW 文件系统上这个上限可以调高**（reflink 复制几乎不产生 IO）。

### 7.7 保留工作区（keepVolume）

产品语义见 P20 §6（销毁二次确认默认勾选保留）与 P21-6 §3.3（项目菜单「已保留卷」入口）。产品术语仍叫「卷」，技术上是**目录**。

- `DELETE /api/sandboxes/:id { keepVolume?: boolean }`（02 §5.1）：`keepVolume=true` 时销毁实例但**保留 `workspaces/<sandboxId>/` 目录**，标记文件改 `kept` 并写入 `retain_until`；缓存与临时目录**无论如何都删**（P22 §4.2）。
- 保留期：默认 **30 天**（P20 §6，支持 3/7/30 天可配）；自动化触发的 Task 用规则的 `artifact_retention_days`（13 §2 automations）。到期由 `VolumeReaper` 扫目录 + 查 `retained_volumes` 后 `rm -rf`。
- 保留记录落 `retained_volumes` 表（13 §2）供「已保留卷」列表查询——**目录是事实，表是索引与保留期账本**；两者不一致时以目录为准（对账时补记或标记 `deleted_at`）。
- 保留目录占用的磁盘**不回资源池**（§1）——它已脱离 sandbox 生命周期，改为治理视角展示（P21-5 水位 + 保留卷占用横幅）。
- sandbox 记录仍按终态保留（审计），目录与记录的生命周期解耦。

## 8. 自动化调度器（v1.1）

> 产品依据：P21-7 §4.5/§5/§7/§9、P20 §9.9、P22 §2「自动化触发阶段」。规则与运行历史表见 13 §2 automations / automation_runs。

### 8.1 扫描循环

- `AutomationScheduler` 定时任务，**每分钟**扫描 `WHERE enabled = true AND next_trigger_at <= now()`（走 `(enabled, next_trigger_at)` 索引，13 §2）。
- **单实例串行**：整个扫描批次在一个 `async-mutex` 内跑完，防止上一轮未结束时下一轮重入（单机单进程前提；多节点时改为 DB 行级锁 + `claimed_by`，见 11 §4 预留）。
- **outcome-pending 孤儿 run 补扫（交叉评审 P2-7）**：run 已 `finalize`（终态写入）但 `Automation.recordOutcome()`（增 `consecutive_failures` / 触发降频）尚未生效时崩溃——仅按 `next_trigger_at` 扫规则无法发现它，会**漏记一次失败计数**。故每轮额外扫 `automation_runs WHERE status IN (failed,timeout,success) AND outcome_applied = false`，对每条补调 `recordOutcome` 并置 `outcome_applied=true`（幂等，13 automation_runs 加 `outcome_applied` 列）。
- 触发即 `next_trigger_at` **先推进后执行**（按 `schedule_kind` + `schedule_config` + `timezone` 算下一次），保证任何执行异常都不会导致同一时刻被反复触发。
- **时区（快照语义，产品 P21-7 §3.2）**：计算下一次触发时间**只用规则自己的 `automations.timezone` 列**（13 §2.7.1），**绝不读服务器系统时区、也不读请求方时区**。该列在规则创建时快照（前端默认填当时的浏览器时区），此后**规则存续期内不变**——用户换个时区的机器再打开平台，既有规则的触发时刻不会漂移（"每天凌晨 3 点"不会变成中午 3 点）；只有**新建**规则才继承当时的用户时区。
  - 算法：在 `timezone` 下按**本地墙钟**语义求下一个满足 `schedule_config` 的时刻，再转 UTC 存 `next_trigger_at`。夏令时切换日照此自然处理——"每天 08:00"永远是当地 08:00，UTC 偏移随 DST 变化（25 T-AUT-4）。
  - 编辑规则时**不隐式改写 `timezone`**：用户要换时区必须显式改这个字段（否则"改了个 prompt 顺手把触发时刻挪了 8 小时"是最难排查的一类 bug）。

### 8.2 触发决策表（实现即 P21-7 §5 决策表，逐条对齐）

| 判定顺序 | 条件 | 动作 | `automation_runs.status` |
|---|---|---|---|
| 1 | 上次触发的 Task 仍在非终态 | 跳过（`concurrency_mode='skip'`，MVP 唯一值） | `skipped`，`error_code='PREVIOUS_RUNNING'` |
| 2 | 该 runtime 无生效凭证 / 已过期 / 已吊销（查 `runtime_settings.active_auth_method` + credentials，05 §4） | 跳过 + 横幅 + webhook | `skipped`，`error_code='AUTH_EXPIRED'` |
| 3 | 调度决策返回 `RESOURCE_EXHAUSTED`（§2） | 排队重试：**24min 间隔 × 最多 5 次**（≈2h 窗口），置 `retry_at`；5 次仍失败转终态 | 过程中 `resource-exhausted`；终态 `failed` |
| 4 | 以上皆否 | 创建**标准无头 Task**（同状态机、同配额登记、同独立副本——自动化层**不得**绕过任何一条，P21-7 §9） | `success` / `failed` |

- 重试不是新的 run 记录：同一 `automation_runs` 行更新 `retry_count` 与 `retry_at`，历史上显示"已排队 n/5"（P21-7 §3.3）。
- **宕机 missed**：扫描时发现 `next_trigger_at` 已过期**超过一个调度周期**（或超过 `missedThresholdMin`，默认 5min），判定为宕机错过 → 记 `missed`、**不补跑**、直接推进到下一个未来时刻（P21-7 §5；catchup v1.2）。
- 触发产生的 sandbox 打 `labels.automation_id`，前端据此渲染 `[自动]` 标签并溯源到规则。

### 8.3 无头 Task 硬超时

- **默认 2h**，规则可配 30min / 1h / 2h / 4h（`automations.timeout_minutes`，13 §2；P20 §0 决策 5 与 P21-7 §3.2 同源）。
- 计时起点是 Task 转 `running` 的时刻（不含排队与拉镜像——否则慢网络会吃掉用户的执行预算）。
- 超时动作：kill 进程 → sandbox 转 `failed`（`failure_reason='automation timeout'`）→ run 记 `status='timeout'`，**并计入 `consecutive_failures`**（P20 §9.9 明确要求）。
- 与 idle 回收的关系：无头 Task 没有终端，**不参与 idle 回收**（§4.2），硬超时是它唯一的兜底。
- 手动发起的交互式 Task 不受本条约束（其兜底是 idle 30min + 硬超时 24h，P20 §0）。

### 8.4 连续失败：先降频、再禁用

```
consecutive_failures：success 清零；failed / timeout 累加（skipped 与 missed 不计——不是规则的错）
  ≥3        → degraded = true：调度降频为【每日一次】+ 横幅 + webhook 通知
  降频后再连续失败 7 次（即 consecutive_failures ≥ 10）→ enabled = false（自动禁用 🔴）
  降频态下成功一次 → degraded = false + consecutive_failures = 0（恢复原调度）
  用户 [重新启用] → enabled = true, degraded = false, consecutive_failures = 0
```

`degraded=true` 时 `next_trigger_at` 按"每日一次"重算（沿用原规则的时刻，只把频率压到一天一次），规则原始的 `schedule_kind/schedule_config` **不改写**——恢复时直接按原配置重算即可。

### 8.5 Webhook 通知（v1.1）

| 方面 | 设计 |
|---|---|
| 配置 | `automations.webhook_url` + `trigger_on`（`failure`（默认）/ `success` / `all`；对应 P21-7 §3.2 的☐成功☐失败☐超时——`timeout` 归入 `failure` 语义）|
| 触发点 | run 进入终态时按 `trigger_on` 匹配；**降频与自动禁用**也各发一条（P21-7 §5 明确要求）|
| 载荷 | `POST` JSON：`{ event, automationId, automationName, projectId, projectName, runtimeId, triggeredAt, finishedAt?, status, errorCode?, errorMessage?, taskUrl }`——`taskUrl` 是「打开 Task」深链（`<publicBaseUrl>/?taskId=<sandboxId>`，P20 §8.3；`publicBaseUrl` 取系统配置，未配置时省略该字段而非拼出错误链接）|
| 投递纪律 | 10s 超时；失败重试 2 次（指数退避 5s/25s）后放弃并记入 run 的 `webhook_status`；**投递失败绝不影响 run 本身的状态**（通知是旁路）|
| 安全 | 仅允许 `http`/`https`；**SSRF 防护**：解析目标 IP，默认拒绝环回/链路本地/元数据地址（`127.0.0.0/8`、`::1`、`169.254.0.0/16`），私网段（`10/8`、`172.16/12`、`192.168/16`）**默认放行**——私有化部署里内网 webhook 是主要用法；开关 `automation.webhook.allowPrivateNetwork`（默认 true）。**放行有前提（审计 P2-12）**：未启用访问口令时（11 §3.1）私网放行**自动降级为拒绝**——否则「能建规则的人」= 「能让平台向内网任意地址发 POST 的人」；口令 MVP 即可用，正常部署不会触发该降级 |
| 测试 | 规则表单 [测试连接]（P21-7 §3.2）→ `POST /api/automations/webhook-test { url }` 发一条 `event:'test'` 的样例载荷，同上超时与 SSRF 规则 |

### 8.6 无头 Task 的 stdout/stderr 完整捕获（P21-7 §9 缺口②）

`RuntimeAdapter.parseOutput` 产出的是**结构化 `RuntimeEvent`**（04 §3），用于进度展示；原始字节另需一条独立链路：

- **捕获**：`spawn({ tty:false })` 的 stdout/stderr 原样写入 `data/logs/automation-runs/<runId>/output.log`（tty=false 时两路已由 provider 解复用，04 §2.2）。
- **轮转**：单文件上限 **10MB**、最多 **3 个** 分片（`output.log.1/.2`），超出即丢弃最旧分片并在文件头写一行截断标记——agent 刷屏能轻易写满磁盘，无上限的日志是运维事故。
- **保留**：与规则的 `artifact_retention_days` 同期（默认 7 天）过期清理；`automation_runs.output_summary` 仍存末尾 1KB 供列表快速预览（13 §2）。
- **查询**：`GET /api/automations/runs/:runId/logs?offset=&limit=`（分页字节区间，默认回末尾 64KB）；v1.2 再加 SSE 实时流（P21-7 §8 已标 v1.2）。
- 日志文件路径与体积记入 `automation_runs.log_path` / `log_bytes`（13 §2），清理任务据此删文件。

## 9. 风险与备选

| 风险 | 缓解 |
|---|---|
| 并发创建导致超分配 | §3 互斥登记；集成测试并发压测验证 |
| 平台重启后资源池视图漂移 | 启动对账：inspect 存活容器 vs 落库配额，差异以实际容器为准修正 |
| CPU 硬限流压制突发负载 | §5 双模式 + burst 余量 |
| **磁盘写满导致全平台不可用**（工作区是宿主目录） | §1 磁盘进调度 + 互斥区内登记消 TOCTOU；11 §1 推荐 btrfs/xfs 拿 CoW；诊断报出 DATA_ROOT 文件系统类型 |
| **非 CoW 文件系统上磁盘暴涨**（ext4 静默退化为全量拷贝） | 启动诊断显式报出 fs 类型与是否支持 reflink；文档明示推荐 btrfs/xfs（11 §1） |
| **提示符启发式误报**（§4.1） | 定死"只驱动展示、不驱动决策"红线；阈值与正则集可配；宁可漏报 |
| **半成品工作区目录残留占满磁盘**（§7.6） | 目录标记文件 `.platform-workspace-state=preparing` + 启动对账无条件 `rm -rf` |
| **clone 子进程僵死**（§7.2） | 30min 硬超时 + `GIT_TERMINAL_PROMPT=0` 禁交互 + 进程重启时按 `INTERRUPTED` 判死不续跑 |
| **自动化规则刷屏**（失败每分钟重试、webhook 轰炸） | §8.4 先降频再禁用；webhook 投递失败不重试到底（2 次即放弃） |
| **无头日志写满磁盘**（§8.6） | 10MB × 3 分片轮转 + 保留期清理 |
