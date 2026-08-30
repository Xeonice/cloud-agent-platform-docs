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
| `POST /api/sandboxes` | 创建，**202 + pending 记录**；body `{ projectId, runtime, image?, provider?, initialPrompt?, quota?, headless?, timeoutMinutes?, require? }`；进度经 WS `sandbox.status_changed` 推送。**`timeoutMinutes` 缺省规则（审计 P1-13）**：`headless=true` 且未传 → 服务端补 **120**；`headless=false` 且传了 → **400 `INVALID_ARGUMENT`**（交互式 Task 的兜底是 idle + 24h，不接受硬超时）。不这样定的话请求会一路撞到 DB 的 CHECK 上抛 500（13 §2.1 I-SBX-5）。**`require: { spawnTty?, volumeMount?, updateResources?, pauseResume?, snapshot? }`** 是能力前置条件（**刻意无 `watchEvents`**，04 §5）：要求的位而所选 provider 声明 `false` → **409 `UNSUPPORTED_CAPABILITY`**，校验在**解析项目/落库/进调度之前**（03 §3.1）。**`initialPrompt` 的处置（S5 裁决 D-14，[TASK-LAUNCH-DECISIONS](../TASK-LAUNCH-DECISIONS.md) T-1）**：① **落库** `sandboxes.initial_prompt`（13 §2.1.1）——它的消费点在 202 之后的 provision workflow，跨了请求边界就必须有存储；② T1 内同时按 P21-1 §9 从它**派生默认任务名**写入 `sandboxes.name`；③ **不进任何响应 DTO**（10 §7.3）。**它由 provision 的 `bootstrapAgentSession` 执行（03 §4.3 ⑤），不再依赖用户点开终端** |
| **`GET /api/providers`** | **能力发现**：`ProviderDto[]`（扁平数组）`{ name, capabilities(7 位全量), isDefault }`。**registry 驱动**——第三方经 04 §8 注册后自动出现，本 controller 不改一行。前端据此渲染 provider 选项与按能力显隐控件。**不进 MCP**（§5.2 末段 / 27 §11.3） |
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
| **`POST /api/system/init`** | `{ proxyConfig?: { httpProxy?, httpsProxy?, noProxy? }, acknowledgeOffline?: boolean }` → 写 `system_settings.initialized=true`（13 §2）。**已初始化时返回 409 `ALREADY_INITIALIZED`**——注意这是**「一次性操作，重复调用即冲突」**而不是幂等（审计 P2-4：原文写「幂等：…返回 409」是措辞矛盾，幂等应当重复调用同样成功）；前端遇它直接跳过向导。⚠️ **这条端点还有第二种 409：`OFFLINE_NOT_ACKNOWLEDGED`**（模型 API 全部不可达且未带 `acknowledgeOffline`）——**两个码，处置相反**，那一种平台一个字都没写，前端必须留在向导里（10 §6.8）。⛔ 别写成「遇 409 就跳过向导」：那会把一台根本没初始化的机器放进工作台。出网检测本身走 `POST /api/system/diagnose`（同一套检查项，单项超时 5s，§5.3），初始化向导直接复用，不另开探测端点 | MVP |
| `GET / PUT /api/system/settings` | 运行期读改代理配置等；**永不回显** `accessPasscodeHash` | MVP |
| **`PUT /api/system/access-passcode`** | `{ action: 'enable' \| 'regenerate' \| 'disable' }` → 启用/重新生成时**响应体一次性返回 16 位明文**（此后任何接口都不再回显，只存 hash，11 §3.1）；`disable` 清空 hash。**重新生成不影响已通过的 session**（P21-8 §3） | **MVP**（审计 P0-3 从 v1.1 提前） |
| `POST /api/system/backup` · `GET /api/system/version` | 备份导出（凭证密文默认不入包）· 版本检查（静默失败） | **v1.5，仅列名占位** |

### 5.2 MCP Tool 面

> **本表已按实际注册项对表（S5，2026-08）**：`落地` 列是**代码事实**（`@Tool()` 装饰器的实际注册），不是设计意图——此前本表与实际有双向漂移（表里有 5 个没注册的，实际注册的 3 个 project tool 表里没有）。**这条漂移现在由 `pnpm docs:check` 的 B2 机器把关**（09 §2.4）：api 源码里 `@Tool()` 实际注册的 tool 名集合必须**等于**本表「落地」列为 ✅ 的行集合，⏳ 行不参与相等判定；末尾「合计」句与 27 §1.3 / §12 的计数、名单也一并核对。改本表时请顺手重跑一次。

| Tool | 对应 REST | 落地 | 说明 |
|---|---|:--:|---|
| `list_sandboxes` | GET /sandboxes | ✅ | 状态过滤；支持 `projectId` |
| `create_sandbox` | POST /sandboxes | ✅ | image + runtime 参数；`initialPrompt` **可选**（交互式会话的初始任务指令，映射 RuntimeTaskSpec.prompt，04 §3——**agent CLI 启动即带指令开工，S5 起由 provision 的 `bootstrapAgentSession` 保证，03 §4.3 ⑤**）；`projectId` **可选**（缺省落到默认项目）；quota 为**可选**（缺省由平台自动分配——镜像 resource_defaults + 调度策略，03 §1；UI 不暴露此参数）；**`require` 可选**——与 REST 共用同一份 `CreateSandboxSchema`，因此该参数是**加字段即自动获得的，MCP 壳没写一行代码**（§3 zod 单源的直接结果；27 §11.1） |
| `destroy_sandbox` | DELETE /sandboxes/:id | ✅ | 带 `keepVolume?: boolean` 参数（默认 **false**——MCP 是程序化消费方，默认不留下需要人工清理的卷；UI 侧的默认勾选保留是产品层的表单默认值，两者不冲突） |
| `start_sandbox` / `stop_sandbox` | POST /sandboxes/:id/{start,stop} | ⏳ | 生命周期。⚠️ **REST 也没有**——本列此前写「REST 已有，MCP 壳待补」，2026-08-31 对 `openapi.json` 核实：这两个端点在代码里根本不存在，10 §6 与 27 §2 里那两行也一直没标 ⏳（已补）。所以这不是「补个 MCP 壳」，是端点本身要先做 |
| `get_sandbox` | GET /sandboxes/:id | ⏳ | 详情 + 资源占用 |
| `exec_in_sandbox` | POST /sandboxes/:id/exec | ⏳ | 非交互命令执行（交互式 TTY 走 WS，不进 MCP）。⚠️ 同上：**它依赖的 REST 端点也不存在** |
| `run_agent_task` | POST /sandboxes/:id/runtimes/:rt/tasks | ✅ | 无头模式跑 codex/claude code 任务，**202 返回 taskId**（一次运行最长 4 小时，把一个 tool 调用阻塞那么久不是选项）。S6 落地，[T-4](../TASK-LAUNCH-DECISIONS.md) 的三条阻塞已解决：handler = `RunAgentTaskWorkflow`；输出走新增的 WS `/tasks` 命名空间（**不是再多一条 `/events` 事件**——任务输出是高频字节流，压进走 Outbox 的投影通道只会淹掉整个 UI 依赖的通道）；日志从 automation 口径上提为 Task 口径（`agent_tasks` + `data/logs/agent-tasks/`，13 §2.1.4）。**`extraArgs` 是白名单枚举、不是自由数组**——它会被拼进 CLI 的 argv，放开等于把「在沙箱里执行任意命令」开放给任何能调它的人 |
| `cancel_agent_task` | POST /sandboxes/:id/tasks/:taskId/cancel | ✅ | 终止一个在跑的无头 Task（SIGTERM → 5s → SIGKILL，03 §8.3）。**与 `run_agent_task` 同切片是刻意的**：只给「发起」不给「终止」，上层 agent 发出一个 4 小时档位的任务后就只能干等硬超时——它连「关掉浏览器标签」这条退路都没有 |
| **`list_projects`** | GET /projects | ✅ | 上层 agent 先看有哪些工作区（P20 §9.4） |
| **`create_project`** | POST /projects | ✅ | 异步 clone：tool **立即返回** `{ projectId, cloneStatus:'cloning' }`，调用方轮询 `list_projects` 或 `get_project` 直到 `ready`——MCP 无推送通道，不能让 tool 调用挂 30 分钟 |
| **`get_project`** | GET /projects/:id | ✅ | **本表此前漏收**：`create_project` 之后轮询 `cloneStatus` 就靠它 |
| **`retry_clone`** | POST /projects/:id/retry-clone | ✅ | **本表此前漏收** |
| **`delete_project`** | DELETE /projects/:id | ✅ | **本表此前漏收** |

**合计：设计 14 个，已注册 10 个**（`create_sandbox` · `list_sandboxes` · `destroy_sandbox` · `run_agent_task` · `cancel_agent_task` · `create_project` · `list_projects` · `get_project` · `retry_clone` · `delete_project`）。27 §1.3 / §12 的计数与本表同源。

镜像管理、凭证配置、自动化规则、系统初始化**不进 MCP 面**：它们是管理员的一次性配置动作，交给 LLM 调用方既无价值也扩大攻击面（凭证类接口尤甚）。**`GET /api/providers`（能力发现）同样不进 MCP，但理由是另一条**：它不涉及安全，而是**UI 管道**——读者是要渲染 provider 单选框的前端；agent 调用方拿到这张表没有可做的决策（不传 `provider` 即用默认档，能力不匹配后端以 409 明确拒绝），为一个无决策的只读列表多开 tool 只是徒增 MCP 面（27 §2 / §11.3）。**Git 凭证端点族（`GET /api/credentials?kind=git`、`POST /api/credentials/git`、`POST /api/credentials/git/test`、`DELETE /api/credentials/git/:id`）明确仅 REST、不进 MCP**（I5；27 §11.3 差异清单同源）。

### 5.3 诊断接口的传输方式定案：**SSE**

`POST /api/system/diagnose` 执行**八项**（P21-5 §6 的权威清单，固定顺序）：① 容器运行时连通性 ② `/dev/kvm` ③ 磁盘余量 ④ 端口占用 ⑤ 外网连通（镜像仓库/授权域名）⑥ WS 回环 ⑦ `DATA_ROOT` 文件系统 ⑧ **预制镜像就绪**（P21-5 §9A 的五步链）。**每项超时 5s**。

⚠️ **整轮耗时是并行的 ≈ 最慢那项，不是累加。** 本节原文写「整轮最坏接近 30s」，那是串行假设，与 P21-5 §6「**异步并行**但展示顺序固定」矛盾（2026-08-28 订正）。八项并行的最坏值仍接近单项超时 5s，串行才是 40s。

⚠️ 这不削弱流式的必要性（见下），但**理由要换对**：不是「省 30s 白屏」，而是「诊断的使用场景是『系统好像坏了』，此时**最可能发生的就是某一项 hang 满 5s**——逐项出结果让用户立刻看到其余七项是好的，而不是被一项卡着看不到任何东西」。

**选 SSE（`text/event-stream`），理由**：

1. **必须流式**：一次性 JSON 要等**最慢一项**跑完才有输出。诊断的使用场景恰恰是"系统好像坏了"，此时最可能发生的就是某一项 hang 满超时——那一项会把其余七项的结果一起扣住。逐项 ✅/❌ 边跑边出是产品要求（P22 §3 的"每项 ✅/❌ + 修复建议"）。
2. **不选 WS**：诊断是**单向、一次性、请求-响应**语义，WS 的双工与连接生命周期管理在这里全是负担；而且诊断要能在 WS 本身出问题时使用——用 WS 传诊断结果，等于用可能坏掉的东西去诊断它自己（回环测试项直接自相矛盾）。
3. **不选轮询**：需要服务端保存中间态与任务 id，为一个数秒的操作引入一套 job 管理，不划算。
4. **SSE 的代价可接受**：它跑在普通 HTTP 上，穿代理、走同一套 Guard/拦截器管线，浏览器端 `EventSource`（或 fetch + ReadableStream，以便带 POST body）即可。

帧格式（**✅ 2026-08-28 落地**，权威定义在两仓的 `sse-protocol.ts`，B5 跨仓对账 / 10 §6.7）：

```
event: start
data: {"checks":[{"id":"container-runtime","label":"容器运行时可达"}, … 共 8 项],"timeoutMs":5000}

event: check
data: {"id":"container-runtime","label":"容器运行时可达","status":"ok","summary":"容器运行时可达（/var/run/docker.sock，7ms）","durationMs":8}

event: check
data: {"id":"port-conflict","label":"端口占用","status":"fail","summary":"端口 3000（平台 HTTP/WS 服务…）被 com.docke (pid 41235) 占用","hint":"先确认它是什么：lsof -nP -iTCP:3000 -sTCP:LISTEN；…","detail":{…},"durationMs":31}

event: check
data: {"id":"preset-image","label":"预制镜像就绪","status":"info","step":"staged","summary":"预制镜像已就绪，但尚未在本机铺开 —— 首个任务需要数分钟准备镜像","durationMs":12}

event: done
data: {"okCount":6,"infoCount":1,"warnCount":0,"failCount":1,"totalMs":312}
```

**三处与本节初稿不同，都是落地时定死的**：

1. **多了 `start` 首帧。** 它在任何一项跑完之前发出，页面据它画出八个 ⏳ 占位。没有它，
   前端要么自己硬抄一份八项清单（= 又一份手抄），要么「收到一项画一项」—— 而并行执行下
   最快的可能是第 ⑥ 项，页面会先画出一行孤零零的「WS 回环 ✅」，看起来像诊断只有一项。
2. **`status` 是五取值 `ok | info | warn | fail | timeout`，`info` 与 `warn` 必须分开。**
   第 ⑧ 项第 5 步（镜像未 staged）**只能是 `info`**：镜像是好的，只是这台机器还没把 rootfs
   铺开。渲染成 ⚠️ 会让用户去修一个不需要修的东西，而他能想到的「修法」是删了重推
   （P21-5 §9A 第 5 步）。
3. **`errorCode` 只在预制镜像链上出现**，取值是 10 §6.8 主表里那四个 `PRESET_IMAGE_*`
   （每步一个，「不许合成一条」的机器可判形式）。⚠️ 本节初稿示例里的 `"errorCode":"NETWORK"`
   **是示意不是契约** —— `NETWORK` 从来不在 §6.8 码表里，实现也不产出它。其余七项刻意不发码：
   它们的结论天然带着这一次实测出来的具体数字（哪个端口、被谁占、还剩多少 GB），
   按码查一句固定文案反而更差。
4. `check` 帧另有 **`summary`**（一行人话，直接上 UI）与 **`step`**（仅预制镜像链）。
   `id` 与展示顺序由契约常量 `DIAGNOSE_CHECK_IDS` 钉死，装配对不上时**开机即抛**
   —— 少发一帧的后果是前端那一格永远停在 ⏳，一个看起来像「还在跑」的永久状态。

- 单项超时 5s 由服务端保证，超时即发 `status:"timeout"` 帧继续下一项——**一项卡住不阻塞整轮**。
- 断连即中止剩余检查（无副作用，诊断是只读的）。
- OpenAPI 里以 `text/event-stream` 响应声明（`openapi-typescript` 只生成响应类型，流的消费由前端手写 —— 10 §6 已标注）。
  ⚠️ **只写 `@ApiProduces` 产不出那一节**：实测那样得到的是 `"200": {"description": ""}`，
  **连 content-type 都没有**。要显式 `@ApiResponse({ content: { 'text/event-stream': … } })`。
  schema 只能是 `string`：在这里编一个对象 schema 会对 codegen 撒谎，生成出「一次拿到一个
  DiagnoseFrame」的签名，而实际是一条流。
- **`POST` 而不是 `GET`**（尽管诊断只读）：`EventSource` 不支持带 body，而产品要的是
  「点一下按钮跑一轮」；前端用 `fetch` + `ReadableStream` 消费（F21-5 §7.1）。
  响应显式 `@HttpCode(200)` —— Nest 对 POST 默认 201，而 SSE 是一条持续的 200 流。
- 响应头带 `X-Schema-Hash: sb-diagnose-v1`（与 WS 那两个 hash 各自独立）。⚠️ **在 SSE 上它是
  「告知」不是「门」**：因版本不匹配中断一次只读诊断，等于在最需要它的时候把它关掉。
  另带 `X-Accel-Buffering: no` —— nginx 默认缓冲上游响应，少了它「逐项出结果」这个唯一的
  产品要求会当场失效，**而且只在生产上失效**。
- 另提供 `./diagnose.sh` 覆盖"后端进程本身起不来"的场景（P22 §3），与本端点共用同一套检查项定义。

## 6. 横切面复用

- **鉴权**：Guard 是普通 `CanActivate`，`@UseGuards()` 同时装饰 REST 方法与 MCP Tool 方法（mcp-nest 的 Tool provider 本质是 Nest Provider，走同一 DI/拦截器管线）。当前挂 `NoopAuthGuard`（见文档 11）。
- **Bootstrap**：`main.ts` 同时 `SwaggerModule.setup()` 与 `McpModule.forRoot({ transport: [SSE, STREAMABLE_HTTP, STDIO] })`，挂在同一 Nest 应用实例，共享单例 Provider 图。
- **错误映射**：domain error → interface 层各自翻译（REST: HTTP 状态码 + problem+json；MCP: tool error content），映射表集中在 interface 层共享工具内。基础错误码的映射表在 04 §4，本文档 §6.1 补齐产品链路新增的错误码。

### 6.1 新增错误码映射（对齐 P22 §1）

> ⚠️ **「REST」这一列对异步码是「若出现在同步端点上则如此映射」，不是「创建请求会这样返回」**
> （2026-08 补注）。`POST /api/sandboxes` 返回 **202**，`WORKSPACE_PREPARE_FAILED` /
> `INSTALL_FAILED` / `IMAGE_CONTRACT_VIOLATION` / `DISK_INSUFFICIENT`（工作区那半）都产生在
> 202 **之后**的后台流水线里，实际投递路径是 WS `sandbox.status_changed.errorCode` 与
> `SandboxResponseDto.failureCode`。把这一列读成"创建接口会返回 500"会让人去写一个永远走不到
> 的 REST 错误分支。
>
> 全量码表与各码的实际传输面见 **10 §6.8**（那里同一批码的 HTTP 列标 `—`，并由 A5 门禁与源码对账）。

| 错误码 | 产生处 | REST | MCP | retryable | 用户语义（P22 §1，前端文案权威） |
|---|---|---|---|---|---|
| `CLONE_FAILED_NETWORK` | 项目 clone（03 §7.5） | **502** | tool 错误 + code | ✅ | "仓库不可访问：检查 URL 或网络" |
| `CLONE_FAILED_PERMISSION` | 项目 clone（03 §7.5） | **403** | tool 错误 + code | ❌ | "克隆失败：无权访问该仓库" → [配置 Git 凭证] |
| `DISK_INSUFFICIENT` | clone 前预检 / 工作区准备（03 §7.5–7.6） | **507**（Insufficient Storage） | tool 错误 + code | ❌ | "磁盘空间不足" → [运行诊断] |
| `WORKSPACE_PREPARE_FAILED` | `preparing-workspace` 阶段（03 §7.6） | **500** | tool 错误 + code | ✅ | "准备工作区失败" → [重试] |
| **`INSTALL_FAILED`** | `starting` 段装 runtime CLI（03 §4.3 ③） | **500** | tool 错误 + code | ✅ | "运行时 CLI 安装失败" → [重试] / [换一张预装该 CLI 的镜像]（04 §7） |
| **`IMAGE_CONTRACT_VIOLATION`** | `starting` 段起 agent 会话前的镜像自检（03 §4.3 ⑤） | **500** | tool 错误 + code | ❌ | "镜像不满足平台约定（缺少 tmux）" → [换一张含 tmux 的镜像] / [查看镜像要求] |
| **`UNKNOWN_PROVIDER`** | 建沙箱门口（04 §4.1 / §5） | **400** | tool 错误 + code | ❌ | "没有这个运行档位" → [改选运行档位]（**零副作用**：未创建任何任务） |
| **`UNKNOWN_RUNTIME`** | 建沙箱门口（04 §4.1 / 14 §10）；另见异步 resume / terminal attach | **400** | tool 错误 + code | ❌ | "没有这个 runtime" → [改选 runtime]（**零副作用**） |
| **`INVALID_IMAGE_REFERENCE`** | 建沙箱门口的镜像引用形状校验（04 §4.1） | **400** | tool 错误 + code | ❌ | "镜像地址非法（含空白或控制字符）" → [检查镜像地址]（**零副作用**） |
| **`VALIDATION_FAILED`** | **任何**端点的 DTO schema 校验（全局 zod 管道，跑在 controller 之前；04 §4.2） | **400** | tool 错误 + code | ❌ | 直接展示后端给的那句话（"请求参数 initialPrompt 长度超过上限 8000 字符"）→ [就地改请求]（**零副作用**）。**不需要前端逐字段建表**：字段与规则由后端在 `message` / `details[]` 里说清 |

> **`VALIDATION_FAILED`（2026-08 新增）**：它与表里其他码有一处**不同**——其余码是「某个具体环节坏了」，各自对应一句固定文案；这一条是「请求本身不合 schema」，**具体是哪个字段、违反了哪条规则每次都不一样**，所以人话由后端逐次生成放进 `message`（`details[]` 给逐项 `{path, code, message}`），前端**直接展示**即可，不必也无法建一张逐字段的文案表。`sideEffectFree: true` 在这里是**构造上**成立的（管道跑在 controller 之前），详见 04 §4.2。⚠️ `details` **只放路径 + 规则 + 期望，不回显用户提交的值**——zod 的 issue 原样透出会带 `received`，而校验失败的字段最可能是指令正文或明文凭证。
>
> **`IMAGE_CONTRACT_VIOLATION`（2026-08 随「tmux 升 MUST」新增，TASK-LAUNCH-DECISIONS T-2 修订）**：镜像**注册期过了 `validate()`、运行期却被 `command -v tmux` 实测证伪**时抛它（03 §4.3 ⑤）。`retryable:false`——重试不会给镜像装上 tmux，正确动作是换镜像。露出面同 `INSTALL_FAILED`（异步，主路径是 `starting → failed` + WS）。**不复用 `MANIFEST_INVALID`** 的理由见 04 §4。
>
> **`INSTALL_FAILED` 的主要露出面不是 HTTP**（S5 补，TASK-LAUNCH-DECISIONS T-3）：装 CLI 发生在 202 之后的 provision workflow，用户早已拿到 202，**没有同步响应可承载它**。实际路径是 `starting → failed` + `failure_code` / `failure_reason` + WS `sandbox.status_changed`（该事件在 `status:'failed'` 时带 **`errorCode`**）；表里那行 500 是为将来的同步入口（如重试安装端点）与 §6.2 的兜底纪律留的。**异步失败的错误码有两条出口，两条都是必需的**（S5 前端反馈）：WS 的 `errorCode` 给**即时**呈现，`SandboxDto.failureCode` 给**刷新后恢复**（WS 事件错过即丢，刷新一次原因就没了）。`IMAGE_CONTRACT_VIOLATION` 尤其依赖这两条——它**不经过** `runtime.install_progress`，没有它们前端只能出兜底人话。两处给的都是**码**，人话由前端按 §6.1 / P22 §1 查表出。**装 CLI 期间的进度**走 WS `runtime.install_progress`（10 §3.1）——实测现装 claude-code 可达 12.5 分钟（04 §3 ★1），没有它前端只能干等。

映射纪律（四条，实现时按此写单测）：

1. **权限类与网络类必须分开**：`CLONE_FAILED_PERMISSION` 走 403 而非笼统 502——前端的分支引导（去配 Git 凭证 vs 重试）完全依赖这个区分（P22 §2）。
2. **`retryable` 是响应体的一等字段**（`SandboxProviderError.retryable`，04 §4），前端据此决定是否渲染 [重试] 按钮，而不是靠 HTTP 状态码猜。
3. **`sideEffectFree` 同理，且是同一条纪律的第二次应用**（04 §4.1 / shared/10 §6.8）：「请求在落库前就被拒」与「已受理后失败」是两种事件，前端曾用 `httpStatus === 409` 当代理去区分——而四条门口拒绝里它只覆盖到一条。**表里新增的三条门口码都是 `retryable:❌ + sideEffectFree:✅`**；缺席该字段一律按「可能有副作用」读。
4. **MCP 侧一律用 tool 层错误**（`isError: true` + 文本 + code 字段），不用 JSON-RPC 传输级错误——与 04 §4 的既有规则一致，让 LLM 调用方读得到具体原因。

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
