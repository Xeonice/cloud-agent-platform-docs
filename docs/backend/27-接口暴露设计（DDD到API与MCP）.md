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
| REST 端点 | **54**（另 2 个 v1.5 占位：`/api/system/backup`、`/api/system/version`） | 10 §6.1–6.6 |
| MCP tools | **10** | 02 §5.2 |
| WS 通道 | **2**（`/events`、`/terminal`） | 10 §6.7 |
| WS 事件类型 | **6** | 10 §3 |
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
| `getSandbox` | `GET /api/sandboxes/:id` | `get_sandbox` | | `SandboxDto` + 资源占用 | `get-sandbox` query | — | `NOT_FOUND` | — |
| `createSandbox` | `POST /api/sandboxes` → **202** | `create_sandbox` | `{ projectId, runtime, image?, provider?, initialPrompt?, quota?, headless?, timeoutMinutes? }`；**`headless=true` 未传 `timeoutMinutes` → 补 120；`headless=false` 传了 → 400** | `SandboxDto`（`status:'pending'`） | `create-sandbox` command | I-SBX-1/3/5、I-PRJ-5（archived 项目拒绝）、I-IMG-2（invalid 镜像拒绝） | `RESOURCE_EXHAUSTED`(429)、`DISK_INSUFFICIENT`(507)、`IMAGE_PULL_FAILED`(502)、`WORKSPACE_PREPARE_FAILED`(500)、`INVALID_ARGUMENT`(400) | `sandbox.created` → 5 条 `sandbox.status_changed` |
| `startSandbox` | `POST /api/sandboxes/:id/start` | `start_sandbox` | | `SandboxDto` | `start-sandbox` command | I-SBX-1/9（重启**不经** preparing-workspace） | `INVALID_STATE`(409)、`RESOURCE_EXHAUSTED`(429) | `sandbox.status_changed` |
| `stopSandbox` | `POST /api/sandboxes/:id/stop` | `stop_sandbox` | | `SandboxDto` | `stop-sandbox` command | I-SBX-1 | `INVALID_STATE`(409) | `sandbox.status_changed` |
| `destroySandbox` | `DELETE /api/sandboxes/:id` | `destroy_sandbox` | **`{ keepVolume?: boolean }`**（body 或 `?keepVolume=`，query 优先）。**默认值两面不同**：REST 由前端表单传（UI 默认勾选保留）；**MCP 默认 `false`** | 204 | `destroy-sandbox` command | I-SBX-4、I-RV-1/3 | `INVALID_STATE`(409) | `sandbox.status_changed` → `sandbox.removed` |
| `execInSandbox` | `POST /api/sandboxes/:id/exec` | `exec_in_sandbox` | 非交互命令；**交互式 TTY 走 WS，不走这里** | `{ stdout, stderr, exitCode }` | — | I-SBX-3 | `INVALID_STATE`(409)、`TIMEOUT`(504) | — |
| `runAgentTask` | `POST /api/sandboxes/:id/runtimes/:rt/tasks` | `run_agent_task` | `RuntimeTaskSpec`（04 §3） | 流式 `RuntimeEvent` 或结果 | — | I-SBX-5 | `INVALID_STATE`(409)、`AUTH_REJECTED` | — |

**前端要知道的三件事**：

1. **创建是异步的**：`POST` 返回 202 与一条 `pending` 记录，**真正的进度全在 WS**。技术状态序列是 `pending→scheduling→preparing-workspace→creating→starting→running`，而产品进度卡是四格「初始化 / 拉取镜像 / 准备工作区 / 启动实例」——**两者顺序不同是刻意的**，映射关系：`preparing-workspace`→「准备工作区」、`creating`→「拉取镜像」（03 §4.0）。
2. **`waitingInput` 是派生字段**：来自网关内存态（经 terminal 的只读查询端口，06 §8.2），**只驱动展示、不改主状态**；网关重启后会短暂回落 `false`，这是可接受的（03 §4.1 红线）。
3. **资源/配额对用户完全不可见**（P22 §4.6）：`quota` 只为程序化消费方保留，UI 不要暴露。

---

## 3. project 上下文

> 领域模型 23 §6 · 时序 24 §3 · 调用图 26 §3。

| 能力 | REST | MCP | 请求要点 | 响应 | command/query | 强制不变量 | 可能错误码 | WS 事件 |
|---|---|---|---|---|---|---|---|---|
| `listProjects` | `GET /api/projects` | `list_projects` | | `ProjectDto[]`，含各项目 Task 数聚合 + `cloneStatus` | `list-projects` query | — | — | — |
| `getProject` | `GET /api/projects/:id` | — | | `ProjectDto`（失败时含 `errorCode`/`errorMessage`） | `get-project` query | — | `NOT_FOUND` | — |
| `createProject` | `POST /api/projects` → **202** | `create_project` | `{ name, sourceType:'git'\|'empty', repoUrl?, repoBranch? }` | `{ projectId, cloneStatus:'cloning'\|'ready' }` | `create-project` command | I-PRJ-1/2/4（名称 1–40、全局唯一、总数 ≤50） | `INVALID_ARGUMENT`(400)、`ALREADY_EXISTS`(409) | `project.clone_progress` ×N |
| `retryClone` | `POST /api/projects/:id/retry-clone` | — | 仅 `failed` 态可调；显式重置 `cloneStatus='cloning'` 重新入队 | `ProjectDto` | `retry-clone` command | I-PRJ-6（不允许隐式回退） | `INVALID_STATE`(409) | `project.clone_progress` ×N |
| `convertToEmpty` | `POST /api/projects/:id/convert-to-empty` | — | 仅 `failed` 态；放弃克隆转空项目：`sourceType='empty'` + 丢弃 `repoUrl` + 删半成品基线目录 + `cloneStatus='ready'`；**id / 名称 / 已关联 Task 全部保留** | `ProjectDto` | `convert-to-empty` command | I-PRJ-6/**7** | `INVALID_STATE`(409) | — |
| `deleteProject` / `cancelClone` | `DELETE /api/projects/:id` | — | **cloning 态调用 = 取消克隆** | 204 | `delete-project` / `cancel-clone` | — | `INVALID_STATE`(409) | 其下 Task 的 `sandbox.removed` |
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

- 契约：`CredentialFacade.prepareGitAuth(kind: 'git-ssh-key'\|'git-https-token', host): Promise<GitAuthContext>`（`GitAuthContext = { env, gitSshCommand?, dispose() }`，23 §8）。
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
| 订阅全局事件 | `WS /events` | **不进 MCP** | — | `SandboxWsEvent`（6 种，10 §3） | — | — | 见 §10.3 |

**前端要知道的三件事**：

1. **`socketSessionKey` 是服务端生成的重连凭据**（P2-9），不要自己造；它是本平台唯一的会话归属凭据（没有用户体系）。
2. **断线恢复由后端负责**：重连带同一 key → 后端 tmux re-attach 或 ring buffer replay，**两种方案对前端是同一协议语义**（06 §6）。
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
| `listProviders` | `GET /api/system/providers` | | 已注册 provider/runtime/imageSpec + capabilities + 最近 testkit 结果 | — | 统一名（P1-6） |
| `health` | `GET /api/health` | | `{ ok: true }` | — | **唯一豁免访问口令的端点** |
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

### 10.8 WS 事件 → 前端动作对照（6 种，全量）

| 事件 | 前端动作 | 可丢失？ |
|---|---|---|
| `sandbox.created` | 列表插入（或对齐乐观项） | 否（进 Outbox） |
| `sandbox.status_changed` | patch 状态 + 驱动进度卡 | 否 |
| `sandbox.removed` | 移除列表项 | 否 |
| `sandbox.waiting_input` | 切 🔵 等待输入 图标；**只展示不改主状态** | **是**（有 REST `waitingInput` 兜底） |
| `project.clone_progress` | 创建弹层进度态 / slow 提示 / failed 分支 | **是**（`cloneStatus` 兜底） |
| `runtime-auth.status_changed` | invalidate `['runtime-auth']` + 过期横幅 | 否 |

---

## 11. REST / MCP 一致性保证

### 11.1 一致性从哪来

两个协议面注入**同一个 application service 实例**（02 §1），且 DTO 来自**同一份 zod schema**（02 §3）——因此一致性是结构性的，不是靠人对齐。

### 11.2 验证方式

25 §5 的 interface e2e 对**同一场景各跑一遍 REST 与 MCP**并断言结果等价（如 `E2E-1-mcp`：经 MCP `create_sandbox` 走一遍，结果与 REST 等价）。这是"两层壳同一门面"的唯一可执行证明。

### 11.3 MCP 与 REST 的能力差异清单（全量）

| REST 有、MCP 无 | 为什么 |
|---|---|
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
| `10 §6` 路径集合 ⊇ `openapi.json` paths | 09 §2.4 `docs:check` |
| 前端 codegen 漂移检测 | 10 §2.1 |
| WS 协议文件 hash 比对 | 10 §3 第 4 条 |
| REST/MCP 同场景等价用例 | 25 §5.1 `E2E-1-mcp` |

---

## 12. 覆盖对账

| 面 | 10/02 的总数 | 本文覆盖 | 差 |
|---|---|---|---|
| REST 端点（不含 v1.5 占位） | 54 | 54 | 0 |
| REST v1.5 占位 | 2 | 2（§9 标注） | 0 |
| MCP tools | 10 | 10 | 0 |
| WS 通道 | 2 | 2（§7） | 0 |
| WS 事件类型 | 6 | 6（§10.8 全量表） | 0 |
| SSE 端点 | 1 | 1（§9） | 0 |

**本文任何一行与 10 / 02 / 23 / 25 不一致时，以那四份为准**——本文是汇聚视图，不是新的权威。发现不一致请当作上游漂移上报。
