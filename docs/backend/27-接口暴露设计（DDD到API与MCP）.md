# 27 - 接口暴露设计（DDD → API / MCP 能力目录）

> 状态：✅ 可评审（2026-08，含架构审计后的全部修订）
> **这是前端的主用文档**：回答「我要做某个功能，该调什么接口、传什么、拿到什么、可能报什么错、要订阅哪些事件」。
> 关联：[02 双协议接入机制](./02-MCP与OpenAPI双协议.md) · [10 契约清单与线格式](../shared/10-接口契约与类型共享.md) · [23 领域模型](./23-领域模型与聚合设计.md) · [24 链路时序](./24-产品子链路后端设计.md) · [25 测试](./25-后端测试体系.md) · [26 调用图](./26-调用图与文件级设计.md)

## 0. 本文与三份既有文档的边界（先读，避免找错地方）

| 问题 | 答在哪 |
|---|---|
| REST controller 与 MCP tool 怎么共包同一个 application service、zod 单源怎么产出三处 | **02**（接入**机制**） |
| 某个字段叫什么、什么类型、错误响应长什么样、WS 帧的形状 | **10**（**线格式**，唯一权威） |
| 这个操作动了哪个聚合、有哪些不变量、发了哪些领域事件 | **23**（领域内部） |
| 一次调用在后端经过哪些文件、事务在哪开关、失败怎么补偿 | **24 / 26** |
| **每个上下文对外暴露哪些能力、一个能力对应哪个端点 + 哪个 tool + 哪个应用服务方法 + 可能的错误与事件** | **本文** |

**本文不重列线格式**——请求/响应的精确形状一律链到 10；本文给的是**能力目录与导航**。三份文档若不一致，**以 10（线格式）与 23（领域语义）为准**，本文修正。

**全局纪律锚点**（细节各指其处，此处只给"必须记住的四条"）：

1. **对外一律 camelCase**（`?projectId=`、`{ isActive, imageConfig }`、`?socketSessionKey=`）；DB 是 snake_case，映射在 repository / gateway 层（02 §5.1）。
2. **非 2xx 一律是统一错误 envelope**：`{ code, message, retryable, traceId, details? }`（10 §6.8）。**`retryable` 是一等字段**，前端据它决定渲不渲染 [重试]，不要从 HTTP 状态码猜。
3. **访问口令 Guard 在 MVP 即生效**（11 §3.1）：REST/MCP-HTTP/WS 三面都要带凭据；唯一豁免是 `GET /api/health`；MCP 走 STDIO 传输时豁免。
4. **未映射的错误码有兜底**：任何 code 都不会缺省（最差是 `INTERNAL`），前端按「操作失败（错误码 XXX）」展示即可（02 §6.2）。

---

## 1. 暴露总则

### 1.1 一个能力 = 一层 REST 壳 + 一层 MCP 壳

应用服务是协议无关的门面，REST controller 与 MCP tool 只是两层薄壳，注入同一个实例（02 §1）。**因此同一能力在两个协议面的行为必须一致**——差异只允许出现在"参数默认值"这一层，且必须在本文写明（如 `destroy_sandbox` 的 `keepVolume` 默认值，§2）。

### 1.2 哪些能力上哪个协议面：三条判据

| 判据 | 结论 | 例 |
|---|---|---|
| **上层 agent 要不要程序化地用它？** | 要 → 上 MCP | `create_sandbox` / `run_agent_task` / `list_projects` |
| **它是不是管理员的一次性配置动作？** | 是 → **只 REST** | 镜像注册与运行参数、凭证配置与吊销、自动化规则、系统初始化与访问口令 |
| **它是不是长连接/流式交互？** | 是 → **只 WS 或只 SSE**，不进 MCP | 终端 PTY（WS `/terminal`）、诊断（SSE） |

**"不进 MCP"的两个理由**（02 §5.2 已定）：① 交给 LLM 调用方没有价值；② 扩大攻击面——凭证类接口尤其不能进（一个被诱导的上层 agent 不该能吊销你的凭证）。

### 1.3 当前暴露面总量

| 面 | 数量 | 权威清单 |
|---|---|---|
| REST 端点 | **63**（+1：`GET /api/providers` 能力发现；+2 实现期补录：`POST /api/projects/:id/cancel-clone`、`POST /api/access/unlock`；+4 S6 无头 Task：`GET /api/sandboxes/:id/tasks`、`GET …/tasks/:taskId`、`GET …/tasks/:taskId/artifacts/:name`、`POST …/tasks/:taskId/cancel`；**+2 分支与基线同步：`GET /api/projects/:id/branches`、`POST /api/projects/:id/sync`**；另 2 个 v1.5 占位：`/api/system/backup`、`/api/system/version`） | 10 §6.1–6.6 |
| MCP tools | **14 设计 / 10 已注册**（⏳ 4 个设计中未注册：`start_sandbox` · `stop_sandbox` · `get_sandbox` · `exec_in_sandbox`。S6 新增并注册了无头 Task 的发起与终止两个 tool，见 §2） | 02 §5.2 |
| WS 通道 | **3**（`/events`、`/terminal`、`/tasks`） | 10 §6.7 |
| WS 事件类型 | **7**（S5 新增 `runtime.install_progress`） | 10 §3 |
| SSE 端点 | **1**（`POST /api/system/diagnose`） | 02 §5.3 |

### 1.4 能力表的读法（§2–§9 通用）

- **能力**：application service 的方法名（26 §0.2 的命名约定），它是"这件事"的唯一真名。
- **请求/响应**：只给关键字段与去处；**精确形状看 10**。
- **command/query**：对应 23 的领域用例与 26 的 handler 文件。
- **不变量**：该能力会强制的 `I-*`（23 定义），前端据此预判"什么输入会被拒"。
- **错误码**：**除表列之外**，任何端点都可能返回 `INTERNAL`（500）与鉴权类错误（口令未通过 401 / 锁定 429）——不重复列。
- **WS 事件**：调用成功后前端**会收到**的事件，用于决定是等推送还是靠响应。

---

## 2. sandbox 上下文（Task）

> 领域模型 23 §5 · 时序 24 §1/§5 · 调用图 26 §1/§5。**产品叫 Task，接口叫 sandbox**（23 §3 统一语言）。

| 能力 | REST | MCP | 请求要点 | 响应 | command/query | 强制不变量 | 可能错误码 | WS 事件 |
|---|---|---|---|---|---|---|---|---|
| `listSandboxes` | `GET /api/sandboxes?projectId=&status=` | `list_sandboxes` | 按项目过滤是主链路默认形态 | `SandboxDto[]`，含派生 `waitingInput` | `list-sandboxes` query | — | — | — |
| `getSandbox` | `GET /api/sandboxes/:id` | `get_sandbox` | | `SandboxDto` + 资源占用；**`status='failed'` 时带 `failureCode` / `failureMessage`**（10 §7.3——异步失败没有同步响应可承载错误码，这是刷新后仍能解释失败的唯一出口） | `get-sandbox` query | — | `NOT_FOUND` | — |
| `createSandbox` | `POST /api/sandboxes` → **202** | `create_sandbox` | `{ projectId, runtime, image?, provider?, initialPrompt?, quota?, headless?, timeoutMinutes?, require? }`；**`headless=true` 未传 `timeoutMinutes` → 补 120；`headless=false` 传了 → 400**；**`require`** = `{ spawnTty?, volumeMount?, updateResources?, pauseResume?, snapshot? }` 能力前置条件（**刻意无 `watchEvents`**，理由见下方第 4 条） | `SandboxDto`（`status:'pending'`） | `create-sandbox` command | I-SBX-1/3/5、I-PRJ-5（archived 项目拒绝）、I-IMG-2（invalid 镜像拒绝） | **`UNSUPPORTED_CAPABILITY`(409)**、`RESOURCE_EXHAUSTED`(429)、`DISK_INSUFFICIENT`(507)、`IMAGE_PULL_FAILED`(502)、`WORKSPACE_PREPARE_FAILED`(500)、**`INSTALL_FAILED`**(500，装 CLI 失败，04 §4 / 03 §4.3 ③)、`INVALID_ARGUMENT`(400) | `sandbox.created` → 5 条 `sandbox.status_changed`（+ `starting` 期间 0..n 条 **`runtime.install_progress`**） |
| `startSandbox` | `POST /api/sandboxes/:id/start` | `start_sandbox` | | `SandboxDto` | `start-sandbox` command | I-SBX-1/9（重启**不经** preparing-workspace） | `INVALID_STATE`(409)、`RESOURCE_EXHAUSTED`(429) | `sandbox.status_changed` |
| `stopSandbox` | `POST /api/sandboxes/:id/stop` | `stop_sandbox` | | `SandboxDto` | `stop-sandbox` command | I-SBX-1 | `INVALID_STATE`(409) | `sandbox.status_changed` |
| `destroySandbox` | `DELETE /api/sandboxes/:id` | `destroy_sandbox` | **`{ keepVolume?: boolean }`**（body 或 `?keepVolume=`，query 优先）。**默认值两面不同**：REST 由前端表单传（UI 默认勾选保留）；**MCP 默认 `false`** | 204 | `destroy-sandbox` command | I-SBX-4、I-RV-1/3 | `INVALID_STATE`(409) | `sandbox.status_changed` → `sandbox.removed` |
| `execInSandbox` | `POST /api/sandboxes/:id/exec` | `exec_in_sandbox` | 非交互命令；**交互式 TTY 走 WS，不走这里** | `{ stdout, stderr, exitCode }` | — | I-SBX-3 | `INVALID_STATE`(409)、`TIMEOUT`(504) | — |
| `runAgentTask` | `POST /api/sandboxes/:id/runtimes/:rt/tasks` → **202** | `run_agent_task` | `RunAgentTaskSchema`：`prompt`(≤8000) · `timeoutMinutes`(30/60/120/240) · `resumeFrom?` · `extraArgs?`（**白名单枚举，不是自由数组**） | **202** + `AgentTaskDto`（含 `id`；流式输出走 WS `/tasks`） | `run-agent-task` command | I-SBX-5、**provider 必须 `headlessTask`** | `UNSUPPORTED_CAPABILITY`(409)、`INVALID_STATE`(409)、`NOT_FOUND`(404) | `/tasks` 的 socket.io 事件名恒为 **`frame`**，判别靠帧内 `type`：`event` · `caught_up` · `exit`（见下方 `/tasks` 引注第 1 条） |
| `listAgentTasks` | `GET /api/sandboxes/:id/tasks` | **不进 MCP**（列表是 UI 恢复用途，agent 自己持有 taskId） | — | `AgentTaskDto[]`，按 `startedAt` 倒序 | `list-agent-tasks` query | — | `NOT_FOUND`(404) | — |
| `getAgentTask` | `GET /api/sandboxes/:id/tasks/:taskId` | **不进 MCP**（同上） | — | `AgentTaskDto` | `get-agent-task` query | — | `NOT_FOUND`(404) | — |
| `downloadTaskArtifact` | `GET /api/sandboxes/:id/tasks/:taskId/artifacts/:name` | **不进 MCP**（二进制流不适合 tool 返回） | `:name` 是**产物目录内的相对路径**（含 `/` 时 percent-encode）；绝对路径与 `..` 段一律拒 | `application/octet-stream` 流 | —（经 `SandboxFiles.openFileStream` 直读） | 产物名必须在 `artifacts` 清单内 | `INVALID_ARTIFACT_NAME`(400)、`NOT_FOUND`(404) | — |
| `cancelAgentTask` | `POST /api/sandboxes/:id/tasks/:taskId/cancel` → **202** | `cancel_agent_task` | — | **202** + `AgentTaskDto`（终态随流到达，不在响应里） | `cancel-agent-task` command | 两阶段 SIGTERM→5s→SIGKILL（03 §8.3）；**不立即 `releaseJob`** | `INVALID_STATE`(409)、`NOT_FOUND`(404) | `frame` / `type:'exit'`（`status:'killed'`） |
| `listProviders`（能力发现） | `GET /api/providers` → **200** | **不进 MCP**（理由见下方引注） | — | `ProviderDto[]`（**扁平数组**）：`{ name, capabilities(7 位全量), isDefault }` | —（`SandboxApplicationService.listProviders()` 直读 provider registry，无 command/query handler、无持久化） | — | —（只读；registry 为空时返回 `[]` 而非 404） | — |

**前端要知道的八件事**：

1. **创建是异步的**：`POST` 返回 202 与一条 `pending` 记录，**真正的进度全在 WS**。技术状态序列是 `pending→scheduling→preparing-workspace→creating→starting→running`，而产品进度卡是四格「初始化 / 拉取镜像 / 准备工作区 / 启动实例」——**两者顺序不同是刻意的**，映射关系：`preparing-workspace`→「准备工作区」、`creating`→「拉取镜像」（03 §4.0）。
2. **`waitingInput` 是派生字段**：来自网关内存态（经 terminal 的只读查询端口，06 §8.2），**只驱动展示、不改主状态**；网关重启后会短暂回落 `false`，这是可接受的（03 §4.1 红线）。
3. **资源/配额对用户完全不可见**（P22 §4.6）：`quota` 只为程序化消费方保留，UI 不要暴露。
4. **provider 选项与默认档一律来自 `GET /api/providers`，前端不得枚举闭集**：响应是扁平数组，默认档是数组里 `isDefault` 为 true 的那一项（**没有顶层 default 字段**）。第三方 provider 经 04 §8 注册后自动出现在该端点、进而自动出现在 UI，**前端零改动**。`capabilities` 7 位全量下发（S6 新增 `headlessTask`），用于按能力显隐控件（无 `pauseResume` 就不渲染「暂停」）。前端消费形态（query key / staleTime / 加载失败空三态）见前端 15 §2.1–§2.2 与 F21-2 §4.1。
5. **异步失败的错误码走 DTO + WS 两条出口，不是二选一**（S5 前端反馈）：`POST /api/sandboxes` 返回 202，此后的任何失败都**没有同步响应可承载错误码**（02 §6.1 / 04 §4）。因此 ① WS `sandbox.status_changed` 在 `status:'failed'` 时带 `errorCode`（即时呈现），② `SandboxDto.failureCode` / `failureMessage` 持久回显（刷新后恢复——WS 事件错过即丢）。**`runtime.install_progress` 不是兜底**：它只覆盖装 CLI 那一段，`IMAGE_CONTRACT_VIOLATION` 完全不经过它。两处给的都是**码**（04 §4 闭集，兜底 `INTERNAL`），人话由前端按 P22 §1 查表出；`failureMessage` 只是排障细节，不是 UI 文案。
6. **`initialPrompt` 后端落库、但不回显**（S5 裁决 D-14，[TASK-LAUNCH-DECISIONS](../TASK-LAUNCH-DECISIONS.md) T-1）：它落 `sandboxes.initial_prompt`（13 §2.1.1，跨 T1 → provision 边界必须有存储），但**不进 `SandboxDto`**（10 §7.3 已写明理由——主要是 MCP 面的暴露）。**前端需要的默认任务名由后端算好放在 `SandboxDto.name` 里**（P21-1 §9 规则），前端刷新后不必自己重算，也不需要留着 prompt。前端"任务指令不落 persist"的红线（15 §3.5）不受影响。
7. **「启动时即执行」已由后端保证，不再依赖前端点开终端**（裁决 D-15，03 §4.3 ⑤）：agent 会话在 `starting` 段就起好并开始跑；前端打开终端时**看到的是已在执行中的会话**（可能已经刷了一屏输出）。**MCP `create_sandbox` 同理**——它没有终端，但指令照样执行。相应地，`starting` 状态的停留时间可能很长（装 CLI 实测可达 12.5 分钟），前端应消费 `runtime.install_progress`（§10.8）给出子文案，而不是把长时间的 `starting` 当成卡死。
8. **`require` 的失败是 409 而非创建失败**：能力不匹配在 **application 层最前面**就被拒（早于项目解析、早于落库、早于进调度队列，03 §3），因此**拿不到 sandbox id、列表里不会留下 `failed` 记录**，前端应就地提示改选 provider，而不是走"创建失败重试"那条路。另有一条**无条件**规则不由 `require` 表达：所选 provider `spawnTty=false` 一律拒绝——本平台每个 agent runtime 都要 TTY（04 §2.5）。`watchEvents` **刻意不可 require**：push/poll 对调用方完全封装，要求它没有可观测意义（04 §5）。

> **无头 Task 已在 S6 落地（T-4 的 ⏳ 到此结清）**：上一版这里写的是"整块不进 S5"，理由是缺 command handler、输出传输未定案、日志存储只有 automation 口径。三条都已解决：`RunAgentTaskWorkflow` 是那个 handler；输出走**新增的第三个 WS 命名空间 `/tasks`**（不是第八条 `/events` 事件——任务输出是高频字节流，压进走 Outbox 的投影通道只会把整个 UI 依赖的通道淹掉）；日志存储从 automation 口径**上提为 Task 口径**（新表 `agent_tasks` + `data/logs/agent-tasks/<taskId>/`，13 §2.1.4 / 03 §8.6）。
>
> **三条前端必须知道的语义**（它们不可猜，猜错的表现是"面板空白"而不是报错）：
> 1. **`/tasks` 上没有 `tasks:event` / `tasks:caught_up` / `tasks:exit` 这些事件名**——本文档上一版凭空写过这三个，照着写的客户端一条都收不到。**两侧的 socket.io 事件名一律是 `frame`**（客户端 `socket.emit('frame', …)` 发订阅，服务端 `client.emit('frame', …)` 推流），**判别键在帧内的 `type` 字段**上：`event` / `caught_up` / `exit` / `error` / `pong`。权威定义是 `ws-protocol.ts` 的 `TaskServerFrame` 与 `WS_PROTOCOL_CANONICAL`，握手另带 `X-Schema-Hash: sb-tasks-v1`（**必须带,不带会被拒绝连接**）。
> 2. **`subscribe.fromSeq` 是排他的**——"我已经有到 N 为止的了，给我 N **之后**的"。因此 **`AgentTaskDto.lastSeq` 不是恢复点**，它是**体检上界**：拿它当 `fromSeq` 会一条都回放不到。
> 3. **`caught_up` 带 `firstSeq`**——本次回放实际发出的第一条的 seq（回放为空时是 `seq+1`）。前端拿它与 `fromSeq+1` 比，才能发现**开头被截断**；只看 seq 跳号只能发现中间的洞。
>
> **另有一条产品完整性裁决**：既然对外开放了"发起执行"，就必须同时给"终止"——否则一个 4 小时档位的任务发出去就只能干等硬超时。所以 `cancelAgentTask` 与 `run_agent_task` **同切片落地**，REST 与 MCP 两面都有。
>
> **⚠️ 准入分支与两个面必须同切片**（04 §2.6）：`headless:true` 遇到 provider `headlessTask=false` 返回 409 这条分支，只有在作业面/文件面都实现之后才能加——先加会把今天能成功的 `headless:true` 创建立刻变成 409。

> **`GET /api/providers` 为什么不进 MCP**（判据见 §1.2）：**能力发现是 UI 管道**——它的读者是"要渲染一个 provider 单选框"的前端。agent 调用方拿到这张表**没有可做的决策**：`create_sandbox` 的 `provider` 缺省即用默认档，能力不匹配后端会以 409 明确拒绝（上一条），所以 agent 既不需要先查一遍再挑，也不需要靠它自检。为一个无决策的只读列表多开一个 tool，只是徒增 MCP 面。**注意 §9 平台面另有一个同名能力 `listProviders`（`GET /api/system/providers`，运维看板，尚未落地）——两者不是一回事**，本行是 sandbox 上下文的 `SandboxApplicationService.listProviders()`。

---

## 3. project 上下文

> 领域模型 23 §6 · 时序 24 §3 · 调用图 26 §3。

| 能力 | REST | MCP | 请求要点 | 响应 | command/query | 强制不变量 | 可能错误码 | WS 事件 |
|---|---|---|---|---|---|---|---|---|
| `listProjects` | `GET /api/projects` | `list_projects` | | `ProjectDto[]`，含各项目 Task 数聚合 + `cloneStatus` | `list-projects` query | — | — | — |
| `getProject` | `GET /api/projects/:id` | — | | `ProjectDto`（失败时含 `errorCode`/`errorMessage`） | `get-project` query | — | `NOT_FOUND` | — |
| `createProject` | `POST /api/projects` → **202** | `create_project` | `{ name, sourceType:'git'\|'empty', repoUrl?, repoBranch? }` | `{ projectId, cloneStatus:'cloning'\|'ready' }` | `create-project` command | I-PRJ-1/2/4（名称 1–40、全局唯一、总数 ≤50） | `INVALID_ARGUMENT`(400)、`ALREADY_EXISTS`(409) | `project.clone_progress` ×N |
| `listBranches` | `GET /api/projects/:id/branches` | — | 读**本地**引用（`git branch -r`），不碰网络、不需要凭证 | `string[]` | 查询 | — | — | — |
| `syncBaseline` | `POST /api/projects/:id/sync` | — | 仅 `ready` 态；`git fetch --all` + 刷新体积与时间戳；**不动已有 Task 的工作区** | `ProjectDto` | `sync` command | 已有副本不可被改写 | `INVALID_STATE`(409) | — |
| `retryClone` | `POST /api/projects/:id/retry-clone` | — | 仅 `failed` 态可调；显式重置 `cloneStatus='cloning'` 重新入队 | `ProjectDto` | `retry-clone` command | I-PRJ-6（不允许隐式回退） | `INVALID_STATE`(409) | `project.clone_progress` ×N |
| `convertToEmpty` | `POST /api/projects/:id/convert-to-empty` | — | 仅 `failed` 态；放弃克隆转空项目：`sourceType='empty'` + 丢弃 `repoUrl` + 删半成品基线目录 + `cloneStatus='ready'`；**id / 名称 / 已关联 Task 全部保留** | `ProjectDto` | `convert-to-empty` command | I-PRJ-6/**7** | `INVALID_STATE`(409) | — |
| `cancelClone` | `POST /api/projects/:id/cancel-clone` | — | **只取消克隆、不删项目**：中止在跑的 clone（排队中的直接出队）；项目 id / 名称 / 已关联 Task 全部保留，之后仍可 `retryClone` 或 `convertToEmpty`。**非 cloning 态是 no-op**（回当前 `ProjectDto`，不报 409） | `ProjectDto`（`cloneStatus:'failed'`、`errorCode:'INTERRUPTED'`） | `cancel-clone` command | I-PRJ-6 | — | `project.clone_progress`（`phase:'failed'`） |
| `deleteProject` | `DELETE /api/projects/:id` | — | **cloning 态调用 = 先取消克隆再删**（要"取消但保留项目"用上一行的 `cancelClone`） | 204 | `delete-project` command | — | `INVALID_STATE`(409) | 其下 Task 的 `sandbox.removed` |
| `listRetainedVolumes` | `GET /api/retained-volumes?projectId=` | — | | `RetainedVolumeDto[]` | `list-retained-volumes` query | — | — | — |
| （手动清理保留卷） | `DELETE /api/retained-volumes/:id` | — | | 204 | — | I-RV-2 | `NOT_FOUND` | — |

**前端要知道的三件事**：

1. **clone 是异步且可能很久**：202 立即返回，进度经 `project.clone_progress`（节流 1s）。超 10min 会补发一条 `phase:'slow'`（此时出「仓库较大或网络缓慢」提示但**不要终止**），30min 硬超时后 `phase:'failed'` + `errorCode:'TIMEOUT'`。
2. **失败必须按 `errorCode` 分支引导**：`CLONE_FAILED_PERMISSION`(403) → [配置 Git 凭证]；`CLONE_FAILED_NETWORK`(502) → [重试] / [改为空项目]。这两个区分是后端刻意做的（03 §7.5），别合并成一句"克隆失败"。
3. **进度事件可丢失**：它不进 Outbox（10 §3.1）。丢了不影响最终结果——`GET /api/projects/:id` 的 `cloneStatus` 永远是权威。

---

## 4. runtime 上下文（含鉴权编排）

> 领域模型 23 §7 · 时序 24 §2 · 调用图 26 §2 · 端点定义处 05 §3。
> **全部端点无 sandbox 维度**（05 §2 决策 A）——历史路径 `POST /api/sandboxes/:id/runtimes/:rt/auth/*` 已废弃。

| 能力 | REST | MCP | 请求要点 | 响应 | command/query | 强制不变量 | 可能错误码 | WS 事件 |
|---|---|---|---|---|---|---|---|---|
| `listRuntimes` | `GET /api/runtimes` | — | | `[{ id, displayName, vendor, authMethods, credentialStatus:'none'\|'active'\|'expiring'\|'expired', maskedIdentifier?, expiresAt?, activeAuthMethod? }]` | `list-runtimes` query | — | — | — |
| `getCredentialStatus` | `GET /api/runtimes/:rt/credentials/status` | — | 单 runtime 按需刷新 | 同上单项 | `get-credential-status` query | I-CRD-2（永不回明文） | `NOT_FOUND` | — |
| `beginAuth` | `POST /api/runtimes/:rt/auth/begin` | — | `{ method }` | `AuthChallenge{ kind, verificationUrl?, userCode?, expiresAt, challengeRef, instructions }` | `begin-auth` command | testkit RA-03/RA-05 | `UNSUPPORTED_METHOD`(400)、`PROVIDER_UNAVAILABLE`(503，helper 不可用) | — |
| `pollAuthStatus` | `GET /api/runtimes/:rt/auth/status?challengeRef=` | — | 前端 3–5s 轮询 | `{ status:'pending'\|'success'\|'expired'\|'error', maskedIdentifier? }` | `poll-auth-status` query | — | `AUTH_CHALLENGE_EXPIRED`(410)、`AUTH_REJECTED`(401) | `runtime-auth.status_changed`（成功时） |
| `completeAuth` | `POST /api/runtimes/:rt/auth/complete` | — | `{ challengeRef, pastedText }` | `{ maskedIdentifier }` | `complete-auth` command | I-CRD-1/2 | `AUTH_REJECTED`(401)、`AUTH_CHALLENGE_EXPIRED`(410) | `runtime-auth.status_changed` |
| `submitSecret` | `POST /api/runtimes/:rt/credentials/secret` | — | `{ method:'api-key', secret }`；**不经 helper、不起 pty** | `{ maskedIdentifier }` | `submit-secret` command | I-CRD-1/5 | `AUTH_REJECTED`(401) | `runtime-auth.status_changed` |
| `setAuthMode` | `PUT /api/runtimes/:rt/auth-mode` | — | `{ method:'account'\|'api-key' }` | `RuntimeSettingsDto` | `set-auth-mode` command | **I-RTS-2（目标模式无凭证 → 409）** | 409 | `runtime-auth.status_changed` |
| `revokeCredential` | `DELETE /api/runtimes/:rt/credentials/:credentialId` | — | | 204 | `revoke-credential` command | I-CRD-3/4 | `NOT_FOUND` | `runtime-auth.status_changed` |

**前端要知道的四件事**：

1. **鉴权全程不需要任何 sandbox**（决策 A）——拦截面板与凭证页内即时完成，创建流程里**没有"等待登录"环节**。
2. **三分支**：`oauth-device`（begin → 展示 userCode + 倒计时 → 轮询 status）、`setup-token`（begin 拿 URL → 用户贴回 code → complete）、`api-key`（直接 submitSecret，**断言 0 次 spawn**）。
3. **`AuthChallenge.expiresAt` 是绝对 ISO 时间**（testkit RA-05），倒计时按它算；进程重启会让 challenge 失效并返回 `AUTH_CHALLENGE_EXPIRED`——此时引导 [重新获取授权码] 即可（23 D-6）。
4. **切模式的 409 不是错误而是分支**：目标模式没配凭证时后端返 409，前端应**就地展开该模式的配置面板**，配完自动切换（P21-3 §6）。

**跨上下文门面装配（runtime 出口，S4 新增，与 git 的 `prepareGitAuth` 平行但语义不同）**：sandbox 启动注入凭证时（`materialize`，05 §4）不由 credential 上下文反向持有 sandbox exec，而是经 `CREDENTIAL_FACADE` 的**新增** runtime 出口方法交出凭证：

- 契约：`CredentialFacade.prepareRuntimeCredential(runtimeId): Promise<RuntimeCredential>`（`packages/contracts/src/credential-facade.port.ts` 与 `prepareGitAuth` 并列）——内部 `forRuntime` 按 `runtime_settings.active_auth_method` 选生效凭证 → `credential/infrastructure` 解密产出 `RuntimeCredential`（**仍是受控明文包装 `SecretMaterial`，不是不透明句柄**）。
- **与 git 出口的本质差异**：git 的 `GitAuthContext` 是**不注入沙箱**的不透明句柄（clone 在平台侧）；runtime 出口**要注入沙箱**，故交出 `RuntimeCredential` 由 sandbox 编排侧持 exec、调 `adapter.injectCredential(cred, exec)` 一次性写入（04 §3）。**复用门面装配与 UoW，但出口语义不同、不平移句柄形态**。
- **方向纪律**：`credential` 不反向依赖 `sandbox` exec（避免 credential→sandbox 耦合）；明文以 `SecretMaterial` 短暂存在，经 runtime 注入路径一次性 exec 注入后 `zeroize()`（23 §8.2 放宽后的 I-CRD-2）。

---

## 5. credential 上下文（Git 凭证族）

> 领域模型 23 §8 · 时序 24 §6 · 边界表 05 §3.2。runtime 凭证的**读**归 §4，此处只有 Git 凭证这一支。

| 能力 | REST | MCP | 请求要点 | 响应 | command/query | 强制不变量 | 可能错误码 | WS 事件 |
|---|---|---|---|---|---|---|---|---|
| `listGitCredentials` | `GET /api/credentials?kind=git` | — | **`kind` 必填，MVP 只接受 `git`** | `[{ id, kind, type:'ssh-key'\|'https-token', maskedIdentifier, platform?, allowedHosts, knownHosts?, lastUsedAt, createdAt }]` | `list-git-credentials` query | I-CRD-2（SSH 只回指纹、token 只回尾号） | `INVALID_ARGUMENT`(400，kind 缺失或非 git) | — |
| `storeGitCredential` | `POST /api/credentials/git` | — | `{ type, secret, platform?, allowedHosts }`；`https-token` 必带 **host 白名单 ≥1**（C）；同协议已有 = **更换**语义（revoke-old + insert-new 同一 `UnitOfWork.run`，I4） | `{ id, maskedIdentifier }` | `store-git-credential` command | I-CRD-1/5/**6（passphrase 私钥拒绝）**/**8（host 白名单）** | `INVALID_ARGUMENT`(400) | — |
| `testGitCredential` | `POST /api/credentials/git/test` | — | `{ repoUrl? }`；**经 `prepareGitAuth` 组装**，`git ls-remote`，**15s 超时**；**目标 host 必须 ∈ allowedHosts 才携带凭证**（C3），走 resolve+pin（C4） | `{ ok, errorCode?, message }`——**绝不回 ref 名** | `test-git-credential` command | **I-CRD-8** | `TIMEOUT`(504)、`CLONE_FAILED_PERMISSION`、`CLONE_FAILED_NETWORK` | — |
| （吊销） | `DELETE /api/credentials/git/:id` | — | | 204 | `revoke-credential` command | I-CRD-3；**联动命中零 binding 属正常，不告警（I3）** | `NOT_FOUND` | — |

**跨上下文门面装配（A2 裁决）**：Git 凭证的**使用**（clone / `ls-remote`）不走上表的 command/query，而是经**第三个跨上下文门面** `CREDENTIAL_FACADE`（`packages/contracts/src/credential-facade.port.ts`，与 `SANDBOX_FACADE` / `PROJECT_FACADE` 同构）暴露：

- 契约：`CredentialFacade.prepareGitAuth(kind: 'git-ssh-key'\|'git-https-token', host, scheme): Promise<GitAuthContext>`（`scheme: GitRemoteScheme = 'http'\|'https'\|'ssh'\|'git'`，令 HTTPS helper key scheme 感知，明文 http 内网仓也命中，03 §7.3 C4；`GitAuthContext = { env, gitSshCommand?, dispose() }`，23 §8）。
- 实现：`credential/application/credential-facade.adapter.ts`，内部 `forKind` 选凭证 → 校验 `host ∈ allowedHosts`（I-CRD-8）→ `credential/infrastructure` 解密 materialize 成句柄。
- 消费方：project 的 **clone workflow** `@Inject(CREDENTIAL_FACADE)`；`POST /api/credentials/git/test` **复用同一 `prepareGitAuth` 路径**。**明文（`SecretMaterial`）永不越 credential/infrastructure 边界，consumer 只拿不透明句柄**（A1 / 03 §7.3）。

**前端要知道的两件事**：

1. **Git 凭证与 runtime 凭证语义完全独立**：不参与"模式二选一"，作用域全局，**clone 时按仓库 URL 协议自动选**（`git@`/`ssh://`→SSH、`https://`→Token），用户不需要选。
2. **吊销 Git 凭证没有"受影响运行中 Task"**——它从不注入 sandbox，只在平台侧 clone 时用（05 §3.2）。确认弹层不要照抄 runtime 凭证那套文案。

---

## 6. image 上下文

> 领域模型 23 §9 · 时序 24 §7 · 校验规则权威 05 §4.1。

| 能力 | REST | MCP | 请求要点 | 响应 | command/query | 强制不变量 | 可能错误码 | WS 事件 |
|---|---|---|---|---|---|---|---|---|
| `listImages` | `GET /api/images` | — | 向导下拉用 `?runtimeId=` 过滤可选项 | `ImageManifestDto[]` | `list-images` / `list-selectable-images` | I-IMG-3（禁用的不出现在可选列表） | — | — |
| `registerImage` | `POST /api/images` | — | `{ ref }` | `ImageManifestDto` + `ValidationOutcome` | `register-image` command | I-IMG-6（digest 非空） | `REF_NOT_FOUND`(404)、`REGISTRY_UNREACHABLE`(502)、`MANIFEST_INVALID`(422) | — |
| `validateImage`（**预检**） | `POST /api/images/validate` | — | `{ ref }`；**不落库、不产生 manifest** | `ValidationOutcome{ status:'valid'\|'warning'\|'invalid', errors[], warnings[] }` | `validate-image` command | — | `REF_NOT_FOUND`(404)、`REGISTRY_UNREACHABLE`(502) | — |
| `revalidateImage` | `POST /api/images/:id/validate` | — | 已注册镜像重验证，写回 `validationStatus` | 同上 | `validate-image` command | — | `NOT_FOUND` | — |
| `patchImage` | `PATCH /api/images/:id` | — | `{ isActive?, imageConfig? }`——**改 manifest 可变字段的唯一入口** | `ImageManifestDto` | `patch-image` command | I-IMG-1（EnvVarSet 构造即校验）、I-IMG-4/5 | **400 + `details[].path`**：`ENV_NAME_INVALID` / `ENV_NAME_RESERVED` / `ENV_LIMIT_EXCEEDED` / `ENV_DUPLICATE_KEY` | — |
| `deleteImage` | `DELETE /api/images/:id` | — | 硬删除 | 204 | `delete-image` command | I-IMG-4（预置镜像不可删） | `409`（有 sandbox 引用或预置镜像） | — |

**前端要知道的三件事**：

1. **两个 validate 端点用途不同**：注册前预检用 **`POST /api/images/validate`**（不落库，就是「提交 URI → 分级反馈」那一步）；已注册镜像的重新验证才用 `/:id/validate`。
2. **三级反馈，`warning` 仍可选**：向导下拉的过滤规则是 `isActive && (valid || warning) && supportedRuntimes 含所选 runtime`；warning 项要在选项旁就地显示后果说明（P21-4 §9）。
3. **secret 类 env 的编辑语义**：回传空串 = **保持不变**（不是清空）；原值永不出现在响应里，也不要写进 DOM（I-IMG-5）。

---

## 7. terminal 上下文（**只有 WS 面，不进 MCP**）

> 领域模型 23 §10 · 时序 24 §8 · 网关内部 26 §9。

| 能力 | 通道 | MCP | 请求要点 | 响应/帧 | 强制不变量 | 可能错误 | 相关事件 |
|---|---|---|---|---|---|---|---|
| 建立/恢复终端会话 | `WS /terminal?socketSessionKey=` | **不进 MCP** | `socketSessionKey` **由服务端生成**（首次连接后下发），前端只负责存回带 | `PtyServerFrame`：`data`(base64) / `exit` / `pong` | I-TRM-1/3 | 握手失败（口令未通过）；key 不属未 closed 会话 → 拒绝 | — |
| 输入 / resize / 心跳 | 同上 | — | `PtyClientFrame`：`input` / `resize{cols,rows}` / `ping` | — | I-TRM-2（cols/rows ≥ 1） | — | `sandbox.waiting_input`（翻转时） |
| 订阅全局事件 | `WS /events` | **不进 MCP** | — | `SandboxWsEvent`（**7** 种，10 §3） | — | — | 见 §10.3 |

**前端要知道的三件事**：

1. **`socketSessionKey` 是服务端生成的重连凭据**（P2-9），不要自己造；它是本平台唯一的会话归属凭据（没有用户体系）。
2. **断线恢复由后端负责**：重连带同一 key → 后端 tmux re-attach（tmux 是镜像必须项，04 §7；原先并列的 ring buffer replay 已随无 tmux 降级档取消，06 §6.3）。**对前端的协议语义没变**：重连 + 后端重绘。
3. **`stopped → start` 是新会话，不是恢复现场**：`execId` 会不同，对话上下文不保留、工作区文件保留——文案必须明示（P22 §2）。

---

## 8. automation 上下文（v1.1）

> 领域模型 23 §11 · 时序 24 §4 · 调度器 03 §8。**不进 MCP**（管理员配置动作）。

| 能力 | REST | 请求要点 | 响应 | command/query | 强制不变量 | 可能错误码 | WS 事件 |
|---|---|---|---|---|---|---|---|
| `listAutomations` | `GET /api/projects/:id/automations` | | `AutomationDto[]` | `list-automations` query | — | — | — |
| `createAutomation` | `POST /api/projects/:id/automations` | `{ name, runtimeId, prompt, schedule, **timezone**, timeoutMinutes, webhookUrl?, triggerOn?, artifactRetentionDays? }`——**`timezone` 由前端传当前浏览器时区，创建后快照不变** | `AutomationDto` | `create-automation` command | I-AUT-5、I-AUT-6、**I-AUT-7（每项目 ≤20）**、**I-AUT-9（IANA 非空、不可隐式改写）** | `INVALID_ARGUMENT`(400)、`409`（超上限） | — |
| `getAutomation` / `updateAutomation` / `deleteAutomation` | `GET / PUT / DELETE /api/automations/:id` | | `AutomationDto` / 204 | 同名 command | 同上 | `NOT_FOUND` | — |
| `enableAutomation` / `disableAutomation` | `POST /api/automations/:id/enable` · `/disable` | 动作而非字段更新（判据见 02 §5.1） | `AutomationDto` | 同名 command | **I-AUT-4（启用必须清零 `consecutiveFailures` 与 `degraded`）** | `NOT_FOUND` | — |
| `listRuns` | `GET /api/automations/:id/runs`（分页） | | `AutomationRunDto[]` | `list-runs` query | — | — | — |
| `getRun` | `GET /api/automations/runs/:runId` | | `AutomationRunDto` + `outputSummary`（末尾 1KB） | `get-run` query | — | `NOT_FOUND` | — |
| `readRunLogs` | `GET /api/automations/runs/:runId/logs?offset=&limit=` | 分页字节区间，默认回末尾 64KB | 原始 stdout/stderr | `read-run-logs` query | I-AUR-4（≤30MB） | `NOT_FOUND` | — |
| `webhookTest` | `POST /api/automations/webhook-test` | `{ url }` | `{ ok, errorCode?, message }` | — | I-AUT-6（http/https + SSRF 谓词） | `INVALID_ARGUMENT`(400) | — |

**前端要知道的四件事**：

0. **`timezone` 创建时传、之后别动**：它是快照（P21-7 §3.2）——编辑规则时若你把当前浏览器时区又传一遍，用户换台机器就会把凌晨任务挪走。**只在用户显式改时区时才传这个字段**。
1. **触发产生的是标准 Task**：它会出现在工作台列表里（`labels.automationId` 打 `[自动]` 标签），并**照常发 `sandbox.created` / `sandbox.status_changed`**。自动化本身**没有** WS 事件（23 D-10），运行历史靠 REST 拉。
2. **`resource-exhausted` 是过程态不是失败**：配合 `retryCount`/`retryAt` 渲染成「⚠️ 资源重试中（n/5）」；5 次后才转 `failed`。
3. **降频 ≠ 禁用**：连续失败 ≥3 → `degraded=true`（每日一次，规则仍启用）；降频后再 7 次 → `enabled=false`。两态在列表上要能区分（🟡 vs 🔴）。

---

## 9. 平台面（system，不属于任何限界上下文）

> 23 D-11/D-12：`system_settings` 是配置不是聚合，诊断无领域状态。

| 能力 | REST | 请求要点 | 响应 | 可能错误码 | 备注 |
|---|---|---|---|---|---|
| `getInitStatus` | `GET /api/system/init-status` | 冷启动首屏第一个请求 | `{ initialized, checks?[], resources? }` | — | 附上次出网检测结果，避免一进来就重跑一轮 |
| `initialize` | `POST /api/system/init` | `{ proxyConfig?, acknowledgeOffline? }` | `{ initialized:true }` | **409（已初始化）** | **一次性操作**，重复调用即冲突（不是幂等）；前端遇 409 直接跳过向导 |
| `getSettings` / `updateSettings` | `GET / PUT /api/system/settings` | | `SystemSettingsDto` | — | **永不回显口令 hash** |
| `setAccessPasscode` | `PUT /api/system/access-passcode` | `{ action:'enable'\|'regenerate'\|'disable' }` | 启用/重生成时**一次性返回 16 位明文** | `INVALID_STATE`(409) | **MVP 即可用**；明文只此一次，之后任何接口都不再回显；重新生成**不影响已通过 session** |
| `diagnose` | `POST /api/system/diagnose` | — | **SSE `text/event-stream`**：逐项 `event: check` + 末尾 `event: done` | — | 单项超时 5s，一项卡住不阻塞整轮；检查项含 **`DATA_ROOT` 文件系统类型与 reflink 支持** |
| `getResources` | `GET /api/system/resources` | | CPU/内存/**磁盘水位** + 保留卷占用 | — | 磁盘是本平台真实瓶颈（03 §1），要显性展示 |
| `listProviders`（运维看板） | `GET /api/system/providers` | | 已注册 provider/runtime/imageSpec + capabilities + 健康/失败率 + 最近 testkit 结果 | — | 统一名（P1-6）。**⏳ 尚未落地**。**与 §2 的 `GET /api/providers` 是两个端点**：那个只列 sandbox provider 的 `name/capabilities/isDefault` 供创建链路选档（已落地），本条范围更宽（含 runtime/imageSpec 与健康），供 P21-5 系统状态页 |
| `unlock`（访问口令提交） | `POST /api/access/unlock` | `{ passcode }` | `{ unlocked: true }` + `Set-Cookie: ap_session`（签名 `HttpOnly`，7 天） | `PASSCODE_INVALID`(401)、`PASSCODE_LOCKED`(429，含 `retryAfterSec`) | **MVP**（审计 P0-3）。**不进 MCP**（§1.2 判据②：凭证提交面）。未启用口令时直接回 `{ unlocked:true }`；连续 5 次错锁 5 分钟，**与 Guard 共用同一把锁**（11 §3.1） |
| `health` | `GET /api/health` | | `{ ok: true }` | — | **豁免访问口令 Guard 的两个端点之一**（另一个是上一行的 `POST /api/access/unlock`——它就是提交点） |
| （v1.5 占位） | `POST /api/system/backup` · `GET /api/system/version` | | | | 备份不含 master key 与凭证密文（05 §4.2） |

**SSE 消费提示**：`openapi-typescript` 只能生成响应 content-type，**帧类型要手写**并与 WS 协议文件同放（10 §6.7）。用 `fetch` + `ReadableStream`（需要 POST body，`EventSource` 不支持）。

---

## 10. 前端消费视角速查（按页面/功能反查）

> 这一节是**从"我在做哪个页面"出发**的反向索引。每条给「调用序列 → 拿到什么 → 订阅什么」。页面规格见 product/pages/*。

### 10.1 冷启动与工作台（P21-1）

```
① GET /api/system/init-status        → initialized=false 则进初始化向导（§10.7）
② GET /api/projects                  → 空则进「建项目引导」
③ GET /api/sandboxes?projectId=<当前> → Task 列表（含 waitingInput）
④ GET /api/runtimes                  → 各 runtime 凭证徽标 + 过期预警横幅（一次请求喂满，不要 N+1）
⑤ 建立 WS /events                    → 订阅 sandbox.* 与 runtime-auth.status_changed
⑥ （有选中 Task 时）WS /terminal?socketSessionKey=… → 恢复终端
```
**要点**：④ 一个聚合端点就够，**不要按 runtime 逐个查 status**；⑤ 断线时降级 45s 轮询兜底并显示「数据可能非最新」角标。

### 10.2 发起任务向导（P21-2，两步）

```
Step1 选 Runtime：数据来自 ④ 已拿到的 GET /api/runtimes（无需再请求）
  └─ 该 runtime credentialStatus='none'|'expired' → 插入一次性鉴权拦截面板（§10.3）
Step2 确认：
  ├─ GET /api/images?runtimeId=<所选>   → 镜像下拉（isActive && valid|warning && 支持该 runtime）
  └─ POST /api/sandboxes { projectId, runtime, image?, initialPrompt? } → 202
     └─ 订阅 sandbox.status_changed 驱动四格进度卡
        preparing-workspace→「准备工作区」· creating→「拉取镜像」· starting→「启动实例」· running→完成
```
**要点**：进度卡的格子顺序与状态机顺序**不同**（§2 已说明）；失败时按 `errorCode` + `retryable` 决定是否给 [重试]。

### 10.3 鉴权拦截面板 / 凭证管理（P21-3）

| 分支 | 调用序列 |
|---|---|
| **oauth-device**（Codex） | `POST /api/runtimes/codex/auth/begin { method:'oauth-device' }` → 展示 `userCode` + 按 `expiresAt` 倒计时 → 每 3–5s `GET .../auth/status?challengeRef=` → `success` 后 2s 自动进确认步 |
| **setup-token**（Claude Code） | `POST .../auth/begin { method:'setup-token' }` → 展示 `verificationUrl` → 用户贴回 code → `POST .../auth/complete { challengeRef, pastedText }` |
| **api-key**（通用） | `POST /api/runtimes/:rt/credentials/secret { method:'api-key', secret }` —— **一步完成，无轮询** |
| 模式切换 | `PUT /api/runtimes/:rt/auth-mode` → **409 时就地展开目标模式的配置面板**（不是报错） |
| 吊销 | 先用已有的 `GET /api/sandboxes` 本地按 runtime 过滤出受影响运行中 Task（最多列 10 条）→ `DELETE /api/runtimes/:rt/credentials/:id` |
| Git 凭证 | `GET /api/credentials?kind=git` → 卡片；`POST /api/credentials/git` 保存；`POST /api/credentials/git/test` 测试连接（15s） |

**要点**：三个分支都**不需要任何 sandbox**；轮询遇连续 3 次网络错误转「网络异常 [重试]」且**不消耗设备码倒计时**（P22 §2）。

### 10.4 项目管理（P21-6）

```
创建：POST /api/projects → 202 { projectId, cloneStatus:'cloning' }
     └─ 订阅 project.clone_progress：
        receiving → 进度条（receivedBytes/totalBytes）
        slow      → 出「仓库较大或网络缓慢」提示，**不终止**
        failed    → 按 errorCode 分支：
                    PERMISSION→[配置 Git 凭证]（配完后 POST /api/projects/:id/retry-clone）
                    NETWORK   →[重试] POST /api/projects/:id/retry-clone
                              →[改为空项目] POST /api/projects/:id/convert-to-empty
                                 ← 保留项目 id/名称/已关联 Task，只是不再从 git 来；
                                   调完直接刷新项目详情即可，无 WS 事件
        done      → 自动选中新项目
删除：DELETE /api/projects/:id（二次确认列出级联 Task 数）
已保留卷：GET /api/retained-volumes?projectId= · DELETE /api/retained-volumes/:id
```

### 10.5 镜像管理（P21-4）

```
列表：GET /api/images
注册：POST /api/images/validate { ref }   ← **预检，不落库**，拿三级反馈
     → 用户确认后 POST /api/images { ref }
启用/禁用 + 运行参数：PATCH /api/images/:id { isActive?, imageConfig? }
     → 400 时读 details[].path 逐项标红（ENV_NAME_RESERVED 等四个码）
删除：DELETE /api/images/:id（409 = 有引用或预置镜像，前端应提前置灰）
```

### 10.6 自动化（P21-7，v1.1）

```
列表/详情：GET /api/projects/:id/automations · GET /api/automations/:id
保存：POST/PUT，webhook 先 POST /api/automations/webhook-test 验证
运行历史：GET /api/automations/:id/runs（分页 20）· GET /api/automations/runs/:runId
完整日志：GET /api/automations/runs/:runId/logs?offset=&limit=
```
**要点**：自动化**没有 WS 事件**，历史靠拉；但它产生的 Task 会走 `sandbox.*` 事件出现在工作台。

### 10.7 初始化向导与系统状态（P21-8 / P21-5）

```
向导：GET /api/system/init-status → POST /api/system/diagnose（SSE，逐项 ✅/❌）
     → POST /api/system/init { proxyConfig?, acknowledgeOffline? }（409 = 已初始化，跳过）
系统状态页：GET /api/system/resources（含磁盘水位）· GET /api/system/providers
          · POST /api/system/diagnose（同一个 SSE 端点，与向导复用）
访问口令：PUT /api/system/access-passcode { action } → 明文只回显一次，务必提示用户立即保存
```

### 10.8 WS 事件 → 前端动作对照（7 种，全量）

| 事件 | 前端动作 | 可丢失？ |
|---|---|---|
| `sandbox.created` | 列表插入（或对齐乐观项） | 否（进 Outbox） |
| `sandbox.status_changed` | patch 状态 + 驱动进度卡 | 否 |
| `sandbox.removed` | 移除列表项 | 否 |
| `sandbox.waiting_input` | 切 🔵 等待输入 图标；**只展示不改主状态** | **是**（有 REST `waitingInput` 兜底） |
| `project.clone_progress` | 创建弹层进度态 / slow 提示 / failed 分支 | **是**（`cloneStatus` 兜底） |
| `runtime-auth.status_changed` | invalidate `['runtime-auth']` + 过期横幅 | 否 |
| **`runtime.install_progress`** | 进度卡「启动实例」格子下补子文案（「正在安装 claude-code…」）；`failed` 不单独处置，紧随的 `sandbox.status_changed → failed` 才是权威 | 否（进 Outbox——漏一帧会让子文案永久停在旧值） |

---

## 11. REST / MCP 一致性保证

### 11.1 一致性从哪来

两个协议面注入**同一个 application service 实例**（02 §1），且 DTO 来自**同一份 zod schema**（02 §3）——因此一致性是结构性的，不是靠人对齐。

**最近一个实证**：`CreateSandboxSchema` 加 `require` 字段后，MCP tool `create_sandbox` **未写一行代码就获得了该参数**（`@Tool({parameters})` 用的就是同一个 schema），能力校验也在同一个 `SandboxApplicationService.create()` 里发生 → 两面同样返回 `UNSUPPORTED_CAPABILITY`。这正是"两层壳同一门面"想要的性质：**契约演进默认两面同步，不同步才需要专门写理由**（§11.4 那两条就是有理由的例外）。

### 11.2 验证方式

25 §5 的 interface e2e 对**同一场景各跑一遍 REST 与 MCP**并断言结果等价（如 `E2E-1-mcp`：经 MCP `create_sandbox` 走一遍，结果与 REST 等价）。这是"两层壳同一门面"的唯一可执行证明。

### 11.3 MCP 与 REST 的能力差异清单（全量）

| REST 有、MCP 无 | 为什么 |
|---|---|
| **`GET /api/providers`（能力发现）** | **它是 UI 管道**：读者是要渲染 provider 单选框的前端。agent 拿这张表无决策可做——不传 `provider` 即用默认档，能力不匹配后端以 409 `UNSUPPORTED_CAPABILITY` 明确拒绝（§2 第 5 条）。多开一个无决策的只读 tool 只是徒增 MCP 面 |
| project 的 `get` / `delete` / `retryClone`、保留卷两个端点 | 上层 agent 只需要"看有哪些工作区 / 建一个"，删除与重试是人的决策 |
| runtime 全部鉴权与凭证端点（8 个） | **安全**：一个被诱导的上层 agent 不该能吊销你的凭证或改生效模式 |
| credential Git 凭证族（4 个） | 同上 |
| image 全部（6 个） | 管理员一次性配置，交给 LLM 无价值 |
| automation 全部（11 个） | 同上 |
| system 全部（9 个 + 2 占位） | 同上；且初始化与口令属部署面 |
| WS `/terminal` 与 `/events` | 长连接/流式，MCP 无对应语义（**`exec_in_sandbox` 是非交互替代**） |
| SSE `POST /api/system/diagnose` | 同上 |

| MCP 有、REST 无 | 说明 |
|---|---|
| *（无）* | **MCP 是 REST 的真子集**——任何 tool 都能在 REST 面找到对应端点。这是刻意的：不给 MCP 开后门 |

### 11.4 两处刻意的行为差异（必须记住）

| 能力 | REST | MCP | 理由 |
|---|---|---|---|
| `destroy_sandbox` 的 `keepVolume` | 由前端表单传（UI 默认**勾选保留**） | 默认 **`false`** | 程序化消费方不该默认留下需人工清理的目录 |
| `create_project` 的返回时机 | 202 + WS 推进度 | **立即返回** `{ projectId, cloneStatus:'cloning' }`，调用方**轮询** `list_projects` | MCP 无推送通道，不能让一次 tool 调用挂 30 分钟 |

### 11.5 漂移防线

| 防线 | 位置 |
|---|---|
| openapi.json diff 入库版本 | 09 §2.3 第 4 道门 |
| `10 §6` 路径集合 ⊇ `openapi.json` paths | 09 §2.4 `docs:check` **B1**（已落地，`scripts/docs-check.mjs`） |
| 本文 §2–§9 端点集合 == `10 §6` 端点集合 | 09 §2.4 `docs:check` **A4**（已落地，下一节的对账表由它自动核对） |
| 前端 codegen 漂移检测 | 10 §2.1 |
| WS 协议文件 hash 比对 | 10 §3 第 4 条 |
| REST/MCP 同场景等价用例 | 25 §5.1 `E2E-1-mcp` |

---

## 12. 覆盖对账

| 面 | 10/02 的总数 | 本文覆盖 | 差 |
|---|---|---|---|
| REST 端点（不含 v1.5 占位） | 61 | 61 | 0 |
| REST v1.5 占位 | 2 | 2（§9 标注） | 0 |
| MCP tools | 14 设计 / **10 已注册** | 14 | 0（⏳ 4 个设计中未注册，§1.3 列名） |
| WS 通道 | 3 | 3（§7 + §2 的 `/tasks`） | 0 |
| WS 事件类型 | 7 | 7（§10.8 全量表） | 0 |
| SSE 端点 | 1 | 1（§9） | 0 |

**"REST 端点"这一行现在是机器核对的**：`pnpm docs:check` 的 **A4** 把本文 §2–§9 表格里的路径集合与 `10 §6` 的路径集合做全等比较，任一侧多出一条就红并列出差集（09 §2.4）。**"MCP tools"这一行也是机器核对的**：**B2** 把 api 源码里 `@Tool()` 实际注册的 tool 名集合与 `02 §5.2` 表中标 ✅ 的行做全等比较，并顺带核对本文 §1.3 / §12 的计数与名单跟那张表同源。**其余几行（WS 通道 / WS 事件 / SSE）仍是人工计数**（⏳，见 09 §2.4）。

**本文任何一行与 10 / 02 / 23 / 25 不一致时，以那四份为准**——本文是汇聚视图，不是新的权威。发现不一致请当作上游漂移上报。
