# 02 - MCP 与 OpenAPI 双协议接入层

> 状态：✅ 可评审（基于 2026-08 调研结论；§5 端点面与 §6.1 错误映射按产品定稿 P20 §9 / P22 §1 补齐）
> 关联文档：[01 后端目录结构](./01-后端目录结构与DDD分层.md) · [10 接口契约](../shared/10-接口契约与类型共享.md) · [03 调度中心](./03-Sandbox调度中心.md) · [05 鉴权流转](./05-Runtime鉴权流转.md)

## 1. 核心原则

**Application Service 是协议无关的纯业务门面**。REST Controller 与 MCP Tool 只是两层"协议适配壳"，注入同一个 Nest Provider（同一 DI 容器单例）。新增业务能力只写一次 application service，两个协议面自动获得。

```
REST Controller ─┐
                 ├──▶ SandboxApplicationService（协议无关）──▶ domain
MCP Tool ────────┘
```

## 2. 选型

| 组件 | 选型 | 现状（2026-08） |
|---|---|---|
| MCP server | **@rekog/mcp-nest** | npm 2026-03 有更新，GitHub（rekog-labs/MCP-Nest）活跃；支持 HTTP+SSE / Streamable HTTP / STDIO 多传输、DI 集成、Guard 鉴权 |
| MCP 兜底 | @modelcontextprotocol/sdk（官方 TS SDK） | 持续维护；mcp-nest 若停更，自行包薄适配器对接官方 SDK |
| OpenAPI | @nestjs/swagger 11.4.x | 官方模块，装饰器反射生成 |
| Schema 单一来源 | zod + nestjs-zod（`createZodDto()`） | 一份 zod schema 同时产出三处消费 |

## 3. Schema 单一来源（防两套协议 DTO 漂移）

```
dto/create-sandbox.schema.ts (zod)
        │
        ├─▶ createZodDto() → class DTO（class-validator 兼容）→ @nestjs/swagger 反射 → OpenAPI json
        │
        └─▶ 直接作为 @Tool({ parameters }) 的 inputSchema → MCP tool schema
```

## 4. 代码形态

```typescript
// application/sandbox-application.service.ts —— 协议无关
@Injectable()
export class SandboxApplicationService {
  constructor(
    private readonly repo: SandboxRepository,            // 端口
    private readonly scheduler: SchedulingDomainService,
    @Inject(SANDBOX_PROVIDER_REGISTRY)
    private readonly providers: ProviderRegistry<SandboxProvider>,
  ) {}
  async createSandbox(cmd: CreateSandboxCommand): Promise<SandboxDto> { /* ... */ }
}

// interface/http/sandbox.controller.ts —— REST 壳
@ApiTags('sandbox')
@Controller('sandboxes')
export class SandboxController {
  constructor(private readonly app: SandboxApplicationService) {}
  @Post()
  @ApiOperation({ summary: 'create sandbox' })
  create(@Body() dto: CreateSandboxDto) { return this.app.createSandbox(dto); }
}

// interface/mcp/sandbox.mcp-tools.ts —— MCP 壳
@Injectable()
export class SandboxMcpTools {
  constructor(private readonly app: SandboxApplicationService) {}

  @Tool({
    name: 'create_sandbox',
    description: 'Create a new agent sandbox',
    parameters: CreateSandboxZodSchema,     // 与 REST DTO 同源
  })
  async createSandbox(params: z.infer<typeof CreateSandboxZodSchema>) {
    const dto = await this.app.createSandbox(params);
    return { content: [{ type: 'text', text: JSON.stringify(dto) }] };
  }
}
```

## 5. 协议面设计

> 端点清单的**全量权威副本**在 [10 §6](../shared/10-接口契约与类型共享.md)（前后端共享）；本节给后端侧的分组与设计要点。鉴权端点族的定义处仍是 [05 §3](./05-Runtime鉴权流转.md)。

### 5.1 REST 端点面

所有路径含全局前缀 `/api`（§8）。

**两条全局约定（审计 P1-5 / P1-4）**：
1. **对外一律 camelCase**——query（`?projectId=`）、body（`{ isActive, imageConfig }`）、响应字段全部 camelCase；DB 保持 snake_case，**映射在 repository 层完成**（26 §0.2）。此前 `?project_id=` 与 `{is_active}` 是 snake，与其余 camel 字段混用，前端得记两套规则。
2. **非 2xx 一律遵守统一错误 envelope**（10 §6.8）：`{ code, message, retryable, traceId, details? }`。

**sandbox（Task）**

| 端点 | 说明 |
|---|---|
| `GET /api/sandboxes?projectId=&status=` | 列表；**按项目过滤**是产品主链路的默认形态（P20 §2.2）；响应含派生字段 `waitingInput`（取数经 terminal 的只读查询端口，审计 P1-12 / 06 §8.2） |
| `GET /api/sandboxes/:id` | 详情 + 资源占用 + `waitingInput` |
| `POST /api/sandboxes` | 创建，**202 + pending 记录**；body `{ projectId, runtime, image?, provider?, initialPrompt?, quota?, headless?, timeoutMinutes?, require? }`；进度经 WS `sandbox.status_changed` 推送。**`timeoutMinutes` 缺省规则（审计 P1-13）**：`headless=true` 且未传 → 服务端补 **120**；`headless=false` 且传了 → **400 `INVALID_ARGUMENT`**（交互式 Task 的兜底是 idle + 24h，不接受硬超时）。不这样定的话请求会一路撞到 DB 的 CHECK 上抛 500（13 §2.1 I-SBX-5）。**`require: { spawnTty?, volumeMount?, updateResources?, pauseResume?, snapshot? }`** 是能力前置条件（**刻意无 `watchEvents`**，04 §5）：要求的位而所选 provider 声明 `false` → **409 `UNSUPPORTED_CAPABILITY`**，校验在**解析项目/落库/进调度之前**（03 §3.1） |
| **`GET /api/providers`** | **能力发现**：`ProviderDto[]`（扁平数组）`{ name, capabilities(6 位全量), isDefault }`。**registry 驱动**——第三方经 04 §8 注册后自动出现，本 controller 不改一行。前端据此渲染 provider 选项与按能力显隐控件。**不进 MCP**（§5.2 末段 / 27 §11.3） |
| `POST /api/sandboxes/:id/{start,stop}` | 生命周期 |
| **`DELETE /api/sandboxes/:id { keepVolume?: boolean }`** | 销毁；`keepVolume=true` 保留工作区卷并登记 `retained_volumes`（03 §7.7 / P20 §6）。**DELETE 带 body 不是所有客户端都友好**，因此同时接受 query 形式 `?keepVolume=true`，两者等价、query 优先 |
| `POST /api/sandboxes/:id/exec` | 非交互命令执行（交互式 TTY 走 WS `/terminal`） |
| `POST /api/sandboxes/:id/runtimes/:rt/tasks` | 无头任务（`RuntimeTaskSpec`，04 §3） |

**project**（P20 §9.4 缺口）

| 端点 | 说明 |
|---|---|
| `GET /api/projects` | 列表 + **各项目 Task 数聚合**（P21-6 §7）+ `cloneStatus` |
| `POST /api/projects` | 创建；`{ name, sourceType:'git'\|'empty', repoUrl?, repoBranch? }`；git **立即返回 202**（`cloneStatus:'cloning'`），后台异步克隆，进度经 WS `project.clone_progress` 推送（03 §7.2） |
| `GET /api/projects/:id` | 详情（含 clone 失败的 `errorCode`/`errorMessage`） |
| **`POST /api/projects/:id/retry-clone`** | **重试克隆**：把 `cloneStatus` 从 `failed` 显式重置为 `cloning` 并重新入队（03 §7.2 / 23 I-PRJ-6 不允许隐式回退）。产品闭环：权限类失败 → [配置 Git 凭证] → 配完 [重试克隆]（P22 §2）。**此前 03/24/26 有 `RetryCloneCommand` 却没有端点——本次补齐**。非 `failed` 态调用 → 409。用 POST 动作子路径而非 PATCH：它触发外部副作用（重跑 clone），判据同下 |
| **`POST /api/projects/:id/convert-to-empty`** | **改为空项目**：对 `cloneStatus='failed'` 的项目放弃克隆、转为空项目继续用（产品 P21-6 §5/§9）。做四件事：① `sourceType` 改 `empty`、`repoUrl` 丢弃置 null；② **删除半成品基线目录**（`rm -rf ${DATA_ROOT}/baselines/<projectId>`，复用 03 §7.2 的清理路径）；③ `cloneStatus` 转 **`ready`**；④ **项目 id / 名称 / 已关联 Task 全部保留不变**——这正是选它而不是「删除+新建」的理由。仅 `failed` 态可调，非该态 → **409**（判据同 retry-clone）|
| `DELETE /api/projects/:id` | 级联销毁其下 Task 与卷（**保留卷除外**）；cloning 态时等价于"取消克隆"（03 §7.2） |
| `GET /api/retained-volumes?projectId=` | 「已保留卷」列表（P21-6 §3.3）；`DELETE /api/retained-volumes/:id` 手动清理。**统一在一个资源前缀下**（审计 P2-5：原先 `GET /api/projects/:id/volumes` 与 `DELETE /api/volumes/:id` 一个嵌套一个平铺，同一资源两种形态） |

**runtime / 凭证**（定义处 05 §3，此处只列归属）

| 端点 | 说明 |
|---|---|
| **`GET /api/runtimes`** | **runtime 列表 + 卡片元数据 + 各自凭证状态聚合**（P20 §9.1 / P22 §4.11 的缺口）：`[{ id, displayName, vendor, authMethods, credentialStatus: 'none'\|'active'\|'expiring'\|'expired', maskedIdentifier?, expiresAt?, activeAuthMethod? }]`。一次请求喂满向导 Step1 的全部卡片与凭证管理页（P21-3 §7），**前端不再 N+1 地按 runtime 查状态** |
| `GET /api/runtimes/:rt/credentials/status` | 单 runtime 凭证状态（P20 §2.2 的按需刷新用法；与 `GET /api/runtimes` 同源数据，永不回明文） |
| `POST /api/runtimes/:rt/auth/{begin,complete}` · `GET .../auth/status` | **无 sandbox 维度**（05 §2 决策 A） |
| `POST /api/runtimes/:rt/credentials/secret` · `PUT /api/runtimes/:rt/auth-mode` · `DELETE /api/runtimes/:rt/credentials/:id` | API key 直存 / 模式开关 / 吊销 |
| **Git 凭证族**（4 个，见下表） | 与 runtime 凭证是并列但独立的管道（05 §3.2） |

**Git 凭证端点族**（P22 §4.16 缺口的定案）：

| 端点 | 说明 |
|---|---|
| **`GET /api/credentials?kind=git`** | 掩码列表：`[{ id, kind:'git', type: 'ssh-key'\|'https-token', maskedIdentifier, platform?, allowedHosts, knownHosts?, lastUsedAt, createdAt }]`。`maskedIdentifier` 对 SSH 是**指纹**（`SHA256:…`）、对 token 是尾号；`allowedHosts` 是 **host 白名单数组（非敏感、明示，I2）**；**私钥与 token 永不回显**（05 §3.2 / I-CRD-2）。前端 P21-3 §10.1 的 Git 凭证卡片直接消费本端点 |
| **`POST /api/credentials/git`** | `{ type: 'ssh-key' \| 'https-token', secret, platform?: 'github'\|'gitlab'\|'gitee'\|'other', allowedHosts: string[] }` → 映射到 `credentials.kind='git'` + `obtained_via='git-ssh-key'\|'git-https-token'`（13 §2）。**`https-token` 必带 `allowedHosts`（≥1 host，白名单，C 裁决 / I-CRD-8）**——helper 按 host 绑定、clone/test 前置校验目标 host ∈ 白名单，防对任意 host 回吐 PAT。**同协议已有生效凭证时按"更换"语义处理**（旧的按吊销语义、与新增须同一 `UnitOfWork`，同 I-CRD-5 / I4）；SSH 私钥带 passphrase **保存被拒**（I-CRD-6 / 03 §7.3） |
| **`POST /api/credentials/git/test`** | 判别联合 body：`{source:'inline', type, secret, platform?, allowedHosts, repoUrl?}`（存前测，密钥未入库）或 `{source:'stored', credentialId, repoUrl?}`（卡片测）→ `git ls-remote`，**15s 超时**；只回 `{ ok, errorCode?, message }`，**不回任何 ref 名**（防泄露私有仓分支，03 §7.4） |
| **`DELETE /api/credentials/git/:id`** | 吊销（擦除密文、保留审计元数据）。**不做联动清除**——Git 凭证从不注入 sandbox（05 §3.2） |

> **`kind` 是必填参数，且 MVP 只接受 `git`**（其他值 400）。这条约束是刻意的：runtime 凭证的读取已经归属 `GET /api/runtimes`（聚合状态）与 `GET /api/runtimes/:rt/credentials/status`，若 `GET /api/credentials` 允许省略 `kind` 或接受 `kind=runtime`，同一条 runtime 凭证就有了两条可达路径。**读走带 `kind` 的集合、写走 `/api/credentials/git` 子路径**是有意的分工：读端要为将来的第二种 kind 留位，写端的 body 结构因 kind 而异、天然应当分路径。

**image / automation / system**

| 端点 | 说明 |
|---|---|
| `GET / POST /api/images` | 列表 / 注册 |
| **`POST /api/images/validate`** | **注册前预检**：body `{ ref }`，**不落库**、不产生 manifest 记录，只回三级 `ValidationOutcome`——前端「提交 URI → 分级反馈」用的就是它（P21-4 §5，审计 P1-3） |
| **`POST /api/images/:id/validate`** | **已注册镜像的重新验证**：写回 `validation_status`/`validation_errors` |
| **`DELETE /api/images/:id`** | 硬删除（审计 P1-6 补齐）：仅当无 sandbox 引用（`image_ref RESTRICT`）且非预置镜像（`is_builtin=false`）时成功，否则 409 |
| **`PATCH /api/images/:id { isActive?, imageConfig? }`** | **一个部分更新端点覆盖两件事**（见下；字段名 camelCase，审计 P1-5） |
| `GET/POST /api/projects/:id/automations` · `GET/PUT/DELETE /api/automations/:id` · `POST .../{enable,disable}` | 规则 CRUD（P21-7 §8） |
| `GET /api/automations/:id/runs` · `GET /api/automations/runs/:runId` · `GET /api/automations/runs/:runId/logs` | 运行历史与原始日志（03 §8.6） |
| `POST /api/automations/webhook-test { url }` | 规则表单 [测试连接]（03 §8.5） |
| **系统族**（5 个，见下表） | 初始化、访问口令、诊断 |
| **`POST /api/system/diagnose`** | 一键自检，**SSE 流式**——见 §5.3。检查项含 **`DATA_ROOT` 文件系统类型与 reflink 支持**（审计 P0-1 / 11 §1.2） |
| **`GET /api/system/providers`** | 已注册 provider / runtime / imageSpec 及其 capabilities 与最近一次 testkit 结果（04 §10.1）。**统一用这个名字**（审计 P1-6：此前 04 写 `GET /providers`、11 与诊断各叫过别的） |
| **`GET /api/health`** | 存活探针；**唯一豁免访问口令的端点**（11 §3.1） |

**镜像运行参数**（P22 §4.17 缺口的定案）：`PATCH /api/images/:id` 是修改 manifest 可变字段的**唯一入口**，两个字段可单独或一起传（字段名 camelCase，审计 P1-5）：

| body 字段 | 语义 | 校验与错误 |
|---|---|---|
| `isActive: boolean` | 启用/禁用（软删除）；禁用后自动从向导下拉消失（P21-4 §9）。**用 PATCH 而非 POST /disable**——它是资源字段的部分更新，不是动作 | 预置镜像禁用可、删除不可（I-IMG-4） |
| `imageConfig: { env: [{ key, value?, secret }], cmdOverride? }` | 运行参数；存储形态见 13 §2，**env 校验规则的唯一权威是 05 §4.1** | 违规一律 **400** + `EnvValidationError`，body 带逐项 `path` 与具体码：`ENV_NAME_INVALID`（regex）/ `ENV_NAME_RESERVED`（黑名单，含 `CODEX_*`·`GIT_*` 前缀）/ `ENV_LIMIT_EXCEEDED`（>50 条 / 名 >64 / 值 >4096 字节）/ `ENV_DUPLICATE_KEY`。`secret: true` 的项**传空 `value` 表示"保持不变"**，不是清空（I-IMG-5 / P21-4 §10.2） |

> 合并 `PUT /api/images/:id/config` 到本端点：两者改的是同一个资源的不同字段，拆成两个端点只会让前端为「同时改启用状态与参数」发两次请求。
>
> **生命周期端点为什么仍用 POST 而不是 PATCH**（审计 P2-7）：`POST /api/sandboxes/:id/{start,stop}`、`POST /api/automations/:id/{enable,disable}` 是**动作**——它们触发状态机转移与外部副作用（起容器、改调度），不是资源字段的部分更新；而 `PATCH /api/images/:id` 改的纯粹是记录字段。判据：**会不会产生资源之外的副作用**——会则 POST 动作子路径，不会则 PATCH。

**系统端点族**（P22 §4.18 缺口的定案）：

| 端点 | 说明 | 版本 |
|---|---|---|
| **`GET /api/system/init-status`** | `{ initialized, checks?: [{ id, label, status, hint? }], resources?: { cores, ramMb, diskMb } }`——冷启动首屏据此决定是否进初始化向导（P21-8 §2）。`initialized=false` 时附带上一次出网检测结果，避免前端一进来就重跑一轮 | MVP |
| **`POST /api/system/init`** | `{ proxyConfig?: { httpProxy?, httpsProxy?, noProxy? }, acknowledgeOffline?: boolean }` → 写 `system_settings.initialized=true`（13 §2）。**已初始化时返回 409**——注意这是**「一次性操作，重复调用即冲突」**而不是幂等（审计 P2-4：原文写「幂等：…返回 409」是措辞矛盾，幂等应当重复调用同样成功）。前端遇 409 直接跳过向导即可。出网检测本身走 `POST /api/system/diagnose`（同一套检查项，单项超时 5s，§5.3），初始化向导直接复用，不另开探测端点 | MVP |
| `GET / PUT /api/system/settings` | 运行期读改代理配置等；**永不回显** `accessPasscodeHash` | MVP |
| **`PUT /api/system/access-passcode`** | `{ action: 'enable' \| 'regenerate' \| 'disable' }` → 启用/重新生成时**响应体一次性返回 16 位明文**（此后任何接口都不再回显，只存 hash，11 §3.1）；`disable` 清空 hash。**重新生成不影响已通过的 session**（P21-8 §3） | **MVP**（审计 P0-3 从 v1.1 提前） |
| `POST /api/system/backup` · `GET /api/system/version` | 备份导出（凭证密文默认不入包）· 版本检查（静默失败） | **v1.5，仅列名占位** |

### 5.2 MCP Tool 面

| Tool | 对应 REST | 说明 |
|---|---|---|
| `list_sandboxes` | GET /sandboxes | 状态过滤；支持 `projectId` |
| `create_sandbox` | POST /sandboxes | image + runtime 参数；`initialPrompt` **可选**（交互式会话的初始任务指令，映射 RuntimeTaskSpec.prompt，04 §3——agent CLI 启动即带指令开工）；`projectId` **可选**（缺省落到默认项目）；quota 为**可选**（缺省由平台自动分配——镜像 resource_defaults + 调度策略，03 §1；UI 不暴露此参数）；**`require` 可选**——与 REST 共用同一份 `CreateSandboxSchema`，因此该参数是**加字段即自动获得的，MCP 壳没写一行代码**（§3 zod 单源的直接结果；27 §11.1） |
| `start_sandbox` / `stop_sandbox` / `destroy_sandbox` | POST /sandboxes/:id/{start,stop} · DELETE | 生命周期；**`destroy_sandbox` 带 `keepVolume?: boolean` 参数**（默认 **false**——MCP 是程序化消费方，默认不留下需要人工清理的卷；UI 侧的默认勾选保留是产品层的表单默认值，两者不冲突） |
| `get_sandbox` | GET /sandboxes/:id | 详情 + 资源占用 |
| `exec_in_sandbox` | POST /sandboxes/:id/exec | 非交互命令执行（交互式 TTY 走 WS，不进 MCP） |
| `run_agent_task` | POST /sandboxes/:id/runtimes/:rt/tasks | 无头模式跑 codex/claude code 任务 |
| **`list_projects`** | GET /projects | 上层 agent 先看有哪些工作区（P20 §9.4） |
| **`create_project`** | POST /projects | 异步 clone：tool **立即返回** `{ projectId, cloneStatus:'cloning' }`，调用方轮询 `list_projects` 或 `get_project` 直到 `ready`——MCP 无推送通道，不能让 tool 调用挂 30 分钟 |

镜像管理、凭证配置、自动化规则、系统初始化**不进 MCP 面**：它们是管理员的一次性配置动作，交给 LLM 调用方既无价值也扩大攻击面（凭证类接口尤甚）。**`GET /api/providers`（能力发现）同样不进 MCP，但理由是另一条**：它不涉及安全，而是**UI 管道**——读者是要渲染 provider 单选框的前端；agent 调用方拿到这张表没有可做的决策（不传 `provider` 即用默认档，能力不匹配后端以 409 明确拒绝），为一个无决策的只读列表多开 tool 只是徒增 MCP 面（27 §2 / §11.3）。**Git 凭证端点族（`GET /api/credentials?kind=git`、`POST /api/credentials/git`、`POST /api/credentials/git/test`、`DELETE /api/credentials/git/:id`）明确仅 REST、不进 MCP**（I5；27 §11.3 差异清单同源）。

### 5.3 诊断接口的传输方式定案：**SSE**

`POST /api/system/diagnose` 逐项执行容器运行时连通性、`/dev/kvm`、磁盘余量、端口占用、外网连通（镜像仓库/授权域名）、WS 回环（P22 §3），**每项超时 5s**，整轮最坏接近 30s。

**选 SSE（`text/event-stream`），理由**：

1. **必须流式**：一次性 JSON 要等最慢一项跑完才有输出，用户面对 30s 白屏——而诊断的使用场景恰恰是"系统好像坏了"，此时最不该让人干等。逐项 ✅/❌ 边跑边出是产品要求（P22 §3 的"每项 ✅/❌ + 修复建议"）。
2. **不选 WS**：诊断是**单向、一次性、请求-响应**语义，WS 的双工与连接生命周期管理在这里全是负担；而且诊断要能在 WS 本身出问题时使用——用 WS 传诊断结果，等于用可能坏掉的东西去诊断它自己（回环测试项直接自相矛盾）。
3. **不选轮询**：需要服务端保存中间态与任务 id，为一个 30s 的操作引入一套 job 管理，不划算。
4. **SSE 的代价可接受**：它跑在普通 HTTP 上，穿代理、走同一套 Guard/拦截器管线，浏览器端 `EventSource`（或 fetch + ReadableStream，以便带 POST body）即可。

帧格式（每项一帧，最后一帧汇总）：

```
event: check
data: {"id":"docker-runtime","label":"容器运行时连通性","status":"ok","durationMs":124}

event: check
data: {"id":"outbound-ghcr","label":"镜像仓库连通","status":"fail","errorCode":"NETWORK","hint":"配置 HTTP_PROXY 后重试","durationMs":5000}

event: done
data: {"okCount":5,"failCount":1,"totalMs":7310}
```

- 单项超时 5s 由服务端保证，超时即发 `status:"timeout"` 帧继续下一项——**一项卡住不阻塞整轮**。
- 断连即中止剩余检查（无副作用，诊断是只读的）。
- OpenAPI 里以 `text/event-stream` 响应声明（`openapi-typescript` 只生成响应类型，流的消费由前端手写 —— 10 §6 已标注）。
- 另提供 `./diagnose.sh` 覆盖"后端进程本身起不来"的场景（P22 §3），与本端点共用同一套检查项定义。

## 6. 横切面复用

- **鉴权**：Guard 是普通 `CanActivate`，`@UseGuards()` 同时装饰 REST 方法与 MCP Tool 方法（mcp-nest 的 Tool provider 本质是 Nest Provider，走同一 DI/拦截器管线）。当前挂 `NoopAuthGuard`（见文档 11）。
- **Bootstrap**：`main.ts` 同时 `SwaggerModule.setup()` 与 `McpModule.forRoot({ transport: [SSE, STREAMABLE_HTTP, STDIO] })`，挂在同一 Nest 应用实例，共享单例 Provider 图。
- **错误映射**：domain error → interface 层各自翻译（REST: HTTP 状态码 + problem+json；MCP: tool error content），映射表集中在 interface 层共享工具内。基础错误码的映射表在 04 §4，本文档 §6.1 补齐产品链路新增的错误码。

### 6.1 新增错误码映射（对齐 P22 §1）

| 错误码 | 产生处 | REST | MCP | retryable | 用户语义（P22 §1，前端文案权威） |
|---|---|---|---|---|---|
| `CLONE_FAILED_NETWORK` | 项目 clone（03 §7.5） | **502** | tool 错误 + code | ✅ | "仓库不可访问：检查 URL 或网络" |
| `CLONE_FAILED_PERMISSION` | 项目 clone（03 §7.5） | **403** | tool 错误 + code | ❌ | "克隆失败：无权访问该仓库" → [配置 Git 凭证] |
| `DISK_INSUFFICIENT` | clone 前预检 / 工作区准备（03 §7.5–7.6） | **507**（Insufficient Storage） | tool 错误 + code | ❌ | "磁盘空间不足" → [运行诊断] |
| `WORKSPACE_PREPARE_FAILED` | `preparing-workspace` 阶段（03 §7.6） | **500** | tool 错误 + code | ✅ | "准备工作区失败" → [重试] |

映射纪律（三条，实现时按此写单测）：

1. **权限类与网络类必须分开**：`CLONE_FAILED_PERMISSION` 走 403 而非笼统 502——前端的分支引导（去配 Git 凭证 vs 重试）完全依赖这个区分（P22 §2）。
2. **`retryable` 是响应体的一等字段**（`SandboxProviderError.retryable`，04 §4），前端据此决定是否渲染 [重试] 按钮，而不是靠 HTTP 状态码猜。
3. **MCP 侧一律用 tool 层错误**（`isError: true` + 文本 + code 字段），不用 JSON-RPC 传输级错误——与 04 §4 的既有规则一致，让 LLM 调用方读得到具体原因。

### 6.2 未映射错误码的兜底

前后端各有一层兜底，缺一不可：

- **后端**：任何未被 `mapProviderErrorToDomain()` 命中的异常一律归 `INTERNAL` / HTTP 500，响应体**必须仍带 `code` 字段**（哪怕是 `INTERNAL`）与 `traceId`——裸 500 无 code 会让前端连"错误码 XXX"都显示不出来。
- **前端**：未进 P22 §1 映射表的 code 显示「操作失败（错误码 XXX）[重试] [运行诊断]」（P22 §2），**绝不裸抛**。
- 因此后端**新增错误码不需要前端同步发版**即可安全降级展示；但新增码**必须**同步进 P22 §1 表和本节表，否则用户永远只看得到兜底文案。这条同步责任写进 PR checklist（09 §1）。

## 7. 解耦兜底（关键风险对策）

@rekog/mcp-nest 是社区库而非官方。对策：**所有 mcp-nest 特定装饰器集中在 `interface/mcp/*` 一层**。一旦停更，仅重写这层薄壳直接对接官方 `@modelcontextprotocol/sdk` 的 `StreamableHTTPServerTransport`，Application/Domain 零改动。

## 8. OpenAPI 输出

- **全局路由前缀**：`app.setGlobalPrefix('api')`——REST 实际路径为 `/api/sandboxes/...`，openapi.json 的 paths 含该前缀，与前端生成类型、Playwright mock（文档 12 §4.2）、总体架构图（文档 00）一致。
- `/openapi.json` 作为前端 codegen 源（文档 10）；NestJS 默认暴露的是 `${path}-json` 形态，需 `SwaggerModule.setup(..., { jsonDocumentUrl: 'openapi.json' })` 显式指定，双仓脚本（文档 14 §2.1 watch、09 §1.3 漂移检测）统一按此路径。
- CI 校验：构建时生成 openapi.json 并 diff 入库版本，保证文档与代码同步（配合前端漂移检测双保险）。
