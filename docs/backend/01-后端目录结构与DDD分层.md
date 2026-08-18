# 01 - 后端仓库目录结构与 DDD 分层

> 状态：✅ 可评审（基于 2026-08 调研结论）
> 关联文档：[02 双协议](./02-MCP与OpenAPI双协议.md) · [04 Contract 体系](./04-Contract与Registry扩展体系.md) · [09 工程化](../shared/09-工程化规范.md)

## 1. 总体形态

**模块化单体（Modular Monolith）**：pnpm workspaces 组织，单一部署产物（`apps/api`），业务按限界上下文拆为 `packages/modules/*`，每个上下文内部走 DDD 四层。不引入 Nx（除非未来拆多部署产物）。

限界上下文划分：

| 上下文 | 职责 |
|---|---|
| `sandbox` | 生命周期 + 调度 + **工作区准备编排**（03 §7.6） |
| `project` | 工作区容器：git clone 编排、基线卷、保留卷账本（03 §7） |
| `runtime` | codex / claude-code 适配 |
| `image` | 镜像契约与校验 + 运行参数合并引擎（05 §4.1） |
| `credential` | OAuth / setup-token / API key 凭证保管库 + **Git 凭证**（kind='git'，05 §3.2） |
| `terminal` | PTY 网关（横切）+ waiting-input 检测与活跃度上报（06 §8） |
| `automation` | 定时规则、调度器、运行历史与 webhook（v1.1，03 §8） |

`project` 与 `automation` 是产品定稿后新增的两个上下文：前者承载 Task 的容器语义（P20 §0），后者是"定时的发起者"——**它调用 sandbox 的 application service 创建标准 Task，绝不复制一份调度/状态机逻辑**（P21-7 §9 的硬约束，也是 §5 上下文协作规则的直接应用）。

> **本文只管"代码放哪"。** 每个上下文里**有哪些聚合、聚合的不变量是什么、哪些概念是值对象、领域事件从哪来到哪去**，见 **[23 领域模型与聚合设计](./23-领域模型与聚合设计.md)**（含上下文地图、统一语言表、聚合↔表映射）；一条产品链路怎么落到这四层上见 [24](./24-产品子链路后端设计.md)；**哪个函数调哪个函数、命名怎么定**见 **[26 调用图与文件级设计](./26-调用图与文件级设计.md)**；怎么测见 [25](./25-后端测试体系.md)。

## 2. 目录结构树（文件级）

> 命名约定（后缀、函数名、每层放什么）在 **[26 §0.2](./26-调用图与文件级设计.md)** 定死；**哪个函数调哪个函数**见 26 的十二张调用图；本节只给"文件放在哪"。两份文档的文件清单必须一致——26 §13 是同一份清单的按上下文视图。

```
agent-platform-api/
├── apps/api/src/
│   ├── main.ts                              # 进程入口（26 §12）
│   ├── app.module.ts                        # 根模块：装配 7 个上下文 + platform
│   └── bootstrap/
│       ├── swagger.setup.ts                 # OpenAPI 挂载（jsonDocumentUrl:'openapi.json'，02 §8）
│       ├── mcp.setup.ts                     # MCP transport 挂载（SSE / STREAMABLE_HTTP / STDIO）
│       ├── websocket.setup.ts               # /terminal 与 /events 两个 namespace
│       └── guards.setup.ts                  # APP_GUARD：NoopAuthGuard（v1.1 换 PasscodeGuard，11 §3）
├── packages/
│   ├── contracts/src/                       # 框架无关公共契约（未来可独立发包）
│   │   ├── sandbox-provider.contract.ts
│   │   ├── runtime-adapter.contract.ts
│   │   ├── image-spec.contract.ts
│   │   ├── errors.ts                        # 统一错误模型（04 §4）
│   │   ├── credential-facade.port.ts        # CREDENTIAL_FACADE token + GitAuthContext（跨上下文门面，与 SANDBOX/PROJECT_FACADE 同构，A2）
│   │   ├── registry.tokens.ts
│   │   └── testkit/                         # golden 契约测试套件（04 §10）
│   ├── shared-kernel/src/
│   │   ├── domain/{aggregate-root,entity,value-object,domain-event}.ts
│   │   ├── application/{command,query,use-case,result}.ts
│   │   ├── ports/{clock,id-generator}.port.ts   # 禁止直接 new Date()/randomUUID（§3）
│   │   └── infrastructure/{event-bus,unit-of-work}.ts
│   └── modules/                             # 七个限界上下文，四层同构
│       ├── sandbox/
│       │   ├── interface/{http/sandbox.controller.ts, mcp/sandbox.mcp-tools.ts, sandbox.module.ts}
│       │   ├── application/
│       │   │   ├── sandbox-application.service.ts        # REST/MCP 共用门面
│       │   │   ├── commands/{create-sandbox,start-sandbox,stop-sandbox,destroy-sandbox,touch-activity}/
│       │   │   │        每个目录 = <动作>.command.ts + <动作>.handler.ts
│       │   │   ├── queries/{get-sandbox,list-sandboxes}/
│       │   │   ├── workflows/provision-sandbox.workflow.ts   # 202 之后的阶段编排与补偿（24 §1.3）
│       │   │   ├── event-handlers/{credential-revoked,project-deleted}.handler.ts
│       │   │   ├── ports/{sandbox-provider,workspace-preparer,job-queue}.port.ts
│       │   │   ├── ports/waiting-input-query.port.ts  # 由 terminal 实现（审计 P1-12），sandbox 经 DI 注入
│       │   │   └── dto/*.schema.ts                       # zod 单一来源（02 §3）
│       │   ├── domain/
│       │   │   ├── entities/{sandbox,state-transition,resource-allocation}.entity.ts
│       │   │   ├── value-objects/{sandbox-status,resource-quota,provider-handle,workspace-ref,execution-policy,labels}.vo.ts
│       │   │   ├── services/{scheduling,resource-pool}.domain-service.ts   # 纯函数
│       │   │   ├── services/{sandbox-transition,workspace-naming}.policy.ts
│       │   │   ├── events/{sandbox-created,sandbox-state-changed,sandbox-destroyed,sandbox-workspace-prepare-failed,sandbox-reconciled-as-orphan}.event.ts
│       │   │   ├── repositories/{sandbox,resource-allocation}.repository.ts   # 端口（接口）
│       │   │   └── errors/{invalid-transition,resource-exhausted,concurrency-conflict}.error.ts
│       │   └── infrastructure/
│       │       ├── persistence/sqlite/{sandbox,resource-allocation}.repository.impl.ts
│       │       ├── persistence/schema/*.{sqlite,pg}.ts   # 双方言（13 §5）
│       │       ├── providers/aio/aio-sandbox.provider.ts          # 默认（04 §2.1）
│       │       ├── providers/boxlite/boxlite-sandbox.provider.ts  # micro-VM
│       │       ├── workspace/workspace-preparer.ts       # preparing-workspace 阶段（03 §7.6）
│       │       ├── scheduler/{resource-pool.reader,first-fit-scheduler,sandbox.reaper}.ts   # reader 读库喂 domain 纯函数
│       │       ├── observers/sandbox-status.observer.ts  # watchEvents 或轮询（04 §5/§6）
│       │       └── reconciliation/allocation-reconciler.ts        # 配额对账（13 §4）
│       ├── project/                         # Task 的容器：clone + 基线卷 + 保留卷
│       │   ├── interface/{http/project.controller.ts, mcp/project.mcp-tools.ts, project.module.ts}
│       │   ├── application/
│       │   │   ├── project-application.service.ts
│       │   │   ├── commands/{create-project,retry-clone,convert-to-empty,cancel-clone,delete-project,register-retained-volume}/
│       │   │   ├── queries/{list-projects,get-project,list-retained-volumes}/
│       │   │   ├── workflows/clone-project.workflow.ts   # 异步 clone 全过程（03 §7.2）
│       │   │   └── ports/{git-cloner,volume-manager}.port.ts
│       │   ├── domain/
│       │   │   ├── entities/{project,retained-volume}.entity.ts
│       │   │   ├── value-objects/{repo-url,project-source,clone-state,clone-progress,baseline-volume,retention-period}.vo.ts
│       │   │   ├── events/*.event.ts
│       │   │   └── repositories/{project,retained-volume}.repository.ts
│       │   └── infrastructure/
│       │       ├── persistence/sqlite/{project,retained-volume}.repository.impl.ts
│       │       ├── git/{git-cloner,git-progress.parser,git-error.classifier}.ts   # simple-git，03 §7.2/§7.3/§7.5；clone 只消费 CREDENTIAL_FACADE 返回的 GitAuthContext 句柄，**不做 git 凭证 materialize、不持有明文**（A1/A2）
│       │       └── workspace/{baseline-dir.manager,workspace.reaper}.ts # 基线目录 / 保留目录回收（03 §7.7，审计 P0-1）
│       ├── runtime/                         # codex / claude-code 适配 + 鉴权编排
│       │   ├── interface/{http/runtime.controller.ts, runtime.module.ts}
│       │   ├── application/
│       │   │   ├── runtime-application.service.ts
│       │   │   ├── commands/{begin-auth,complete-auth,submit-secret,set-auth-mode}/
│       │   │   ├── queries/{list-runtimes,poll-auth-status,get-credential-status}/
│       │   │   ├── auth-session.store.ts     # 内存 challengeRef→ptyRef，≤15min（23 D-6）
│       │   │   └── ports/auth-helper.port.ts
│       │   ├── domain/
│       │   │   ├── entities/{runtime-settings,runtime-installation}.entity.ts
│       │   │   ├── value-objects/{runtime-id,auth-challenge,auth-method}.vo.ts
│       │   │   ├── services/auth-method.policy.ts
│       │   │   └── repositories/{runtime-settings,runtime-installation}.repository.ts
│       │   └── infrastructure/
│       │       ├── persistence/sqlite/{runtime-settings,runtime-installation}.repository.impl.ts
│       │       ├── adapters/claude-code/{claude-code.adapter,claude-code.output-parser}.ts
│       │       ├── adapters/codex/{codex.adapter,codex.output-parser}.ts   # 解析器独立成文件 → golden fixture 靶子
│       │       └── helper/{auth-helper.container,auth-helper.host}.ts      # 两种形态（11 §1.1）
│       ├── credential/                      # Vault；含 kind='git' 的 Git 凭证（05 §3.2）
│       │   ├── interface/{http/credential.controller.ts, credential.module.ts}
│       │   ├── application/
│       │   │   ├── credential-application.service.ts
│       │   │   ├── credential-vault.service.ts           # runtime 凭证 materialize 注入 sandbox 门面（05 §4）——不变
│       │   │   ├── credential-facade.adapter.ts          # 跨上下文门面 CREDENTIAL_FACADE.prepareGitAuth(kind, host)→GitAuthContext（A2，23 §8.5 / 27 §5）
│       │   │   ├── commands/{store-credential,revoke-credential,store-git-credential,test-git-credential}/
│       │   │   ├── queries/{list-git-credentials,get-credential-status}/
│       │   │   └── ports/crypto.port.ts
│       │   ├── domain/
│       │   │   ├── entities/{credential,credential-sandbox-binding}.entity.ts
│       │   │   ├── value-objects/{secret-material,encrypted-blob,masked-identifier,credential-metadata,expiry-state,obtained-via}.vo.ts
│       │   │   ├── services/{credential-selection,expiry-evaluator}.domain-service.ts
│       │   │   ├── services/ssh-key-inspector.ts         # passphrase 私钥检测（23 I-CRD-6）
│       │   │   └── repositories/{credential,credential-sandbox-binding}.repository.ts
│       │   └── infrastructure/
│       │       ├── persistence/sqlite/{credential,credential-sandbox-binding}.repository.impl.ts
│       │       ├── crypto/{aes-gcm.crypto,master-key.provider}.ts
│       │       ├── expiry/credential-expiry.scanner.ts   # 7 天预警扫描（05 §5）
│       │       ├── refresh/credential-refresh.scanner.ts  # access token 刷新回写（05 §5.1，审计 P1-7）
│       │       └── git/{git-auth.materializer,git-ls-remote.tester}.ts   # git-auth materializer：解密+写 0600 临时私钥+组 env/GIT_SSH_COMMAND，产出 GitAuthContext（A1，03 §7.3）；tester 测试连接 15s（03 §7.4）
│       ├── image/                           # manifest 校验 + 运行参数
│       │   ├── interface/{http/image.controller.ts, image.module.ts}
│       │   ├── application/
│       │   │   ├── image-application.service.ts
│       │   │   ├── commands/{register-image,validate-image,patch-image}/
│       │   │   └── queries/{list-images,list-selectable-images}/
│       │   ├── domain/
│       │   │   ├── entities/{image,image-manifest}.entity.ts
│       │   │   ├── value-objects/{image-ref,env-var,env-var-set,validation-outcome,resource-defaults,env-source}.vo.ts
│       │   │   ├── services/env-merge.domain-service.ts  # 三层合并纯函数（23 §9.5；**不做凭证覆盖**）
│       │   │   └── repositories/{image,image-manifest}.repository.ts
│       │   └── infrastructure/
│       │       ├── persistence/sqlite/{image,image-manifest}.repository.impl.ts
│       │       ├── spec/oci-image-spec.provider.ts       # ImageSpec contract 实现（04 §7）
│       │       └── crypto/env-secret.cipher.ts           # secret 字段级加密（13 §2.4.3）
│       ├── terminal/                        # PTY 网关（横切）
│       │   ├── interface/{gateway/terminal.gateway.ts, terminal.module.ts}   # WS 是三协议面之一 → interface
│       │   ├── application/
│       │   │   ├── terminal-session.service.ts
│       │   │   ├── commands/{open-session,close-session,resize-session}/
│       │   │   ├── event-handlers/sandbox-state-changed.handler.ts   # 级联关会话（06 §5）
│       │   │   ├── waiting-input-query.service.ts       # 实现 sandbox 侧的只读查询端口（审计 P1-12）
│       │   │   └── ports/pty.port.ts
│       │   ├── domain/
│       │   │   ├── entities/terminal-session.entity.ts
│       │   │   ├── value-objects/{terminal-size,socket-session-key,exec-ref,prompt-heuristic}.vo.ts
│       │   │   └── repositories/terminal-session.repository.ts
│       │   └── infrastructure/
│       │       ├── persistence/sqlite/terminal-session.repository.impl.ts
│       │       ├── detector/{waiting-input.detector,activity-tracker}.ts   # 静默计时 + 活跃度（06 §8）
│       │       └── session/{frame-batcher,ring-buffer}.ts  # 16ms 合并 / 无 tmux 降级（06 §6/§7）
│       └── automation/                      # v1.1：定时规则与调度
│           ├── interface/{http/automation.controller.ts, automation.module.ts}
│           ├── application/
│           │   ├── automation-application.service.ts
│           │   ├── commands/{create-automation,update-automation,enable-automation,disable-automation,delete-automation}/
│           │   ├── queries/{list-automations,list-runs,get-run,read-run-logs}/
│           │   ├── workflows/{scan-due,finalize-run}.workflow.ts
│           │   ├── event-handlers/{sandbox-state-changed,run-finished}.handler.ts
│           │   └── ports/{webhook-notifier,run-log-store}.port.ts
│           ├── domain/
│           │   ├── entities/{automation,automation-run}.entity.ts
│           │   ├── value-objects/{schedule,trigger-decision,webhook-target,timeout-policy,retry-policy,failure-policy}.vo.ts
│           │   ├── services/trigger-decision.domain-service.ts   # 决策表纯函数（23 §11.4）
│           │   └── repositories/{automation,automation-run}.repository.ts
│           └── infrastructure/
│               ├── persistence/sqlite/{automation,automation-run}.repository.impl.ts
│               ├── scheduler/{automation.scheduler,timeout.watchdog}.ts   # 每分钟扫描 / 硬超时（03 §8.1/§8.3）
│               ├── notifier/{webhook.notifier,ssrf-guard}.ts              # trigger_on + SSRF（03 §8.5）
│               └── logs/{run-log-store,log-rotator}.ts                    # 落盘 10MB×3 轮转（03 §8.6）
└── platform/
    ├── registry/{dynamic-module-registry,plugin-loader}.ts
    ├── registry/{provider,runtime,image-spec}.registry.ts      # 三个 DI token registry（04 §8）
    ├── config/{config.module,config.schema}.ts                 # @nestjs/config + zod 校验
    ├── persistence/{persistence.module,drizzle.connection,migrator,unit-of-work.impl}.ts
    ├── persistence/migrations/{sqlite,pg}/                     # 双方言各一套（13 §6）
    ├── outbox/{outbox.repository.impl,outbox.relay,ws-projector,outbox.archiver}.ts   # 13 §2.8.1 / 23 §12
    ├── ws/events.gateway.ts                                    # /events 通道（10 §3）
    ├── scheduler/{timers,mutex,scheduler-queue,clone-queue}.ts # 定时任务注册处 + 两个队列
    └── system/                                                 # 系统端点：不属任何上下文（23 D-11/D-12）
        ├── {system.module,system.controller,system-settings.service,initialization.service}.ts
        ├── diagnostics/{diagnostics.service,sse-writer}.ts + checks/*.check.ts   # SSE 诊断（02 §5.3）
        │      checks/ 含 data-root-fs.check.ts（DATA_ROOT 文件系统类型与 reflink 支持，审计 P0-1）
        └── access-passcode/{passcode.service,passcode.guard,failure-counter}.ts  # **MVP**（11 §3.1，审计 P0-3）
```

**三条从调用图倒推出来的结构决定**（详见 26）：

1. **`interface/gateway/terminal.gateway.ts` 在 interface 而非 infrastructure**——WS 是三协议面之一（17 §2），它是协议壳，与 controller / mcp-tools 同层。
2. **`application/workflows/*.workflow.ts` 是独立一类**——响应返回后的多步编排（provision / clone / scan-due / finalize-run）既不是命令处理器也不是基础设施，它是 application 层的编排单元。
3. **`env-merge` 在 `image/domain/services/` 而非 application**——它是零 IO 纯函数（23 §9.5），放 domain 才能零 mock 穷举测试（25 T-IMG-11..14）。

## 3. 分层依赖规则（eslint-plugin-boundaries 强制）

```
interface ──▶ application ──▶ domain
                  │              ▲
                  ▼              │（实现 repository 端口）
             contracts ◀── infrastructure ──▶ 三方库(provider SDK/socket.io/...)
```

| 层 | 允许依赖 | 明确禁止 |
|---|---|---|
| `domain` | domain、shared-kernel/domain | **任何三方 IO 库**（provider SDK/drizzle/socket.io）、NestJS 装饰器以外的框架代码 |
| `application` | domain、contracts（端口接口） | 直接 import infrastructure 具体实现（由 DI 运行时注入到接口 token） |
| `interface` | application 暴露的 DTO/Service | 触碰 domain 内部细节 |
| `infrastructure` | domain（实现端口）、contracts、三方库 | — |
| `contracts` | 仅 TypeScript 标准库类型 | 反向依赖任何 modules/* |

具体 ESLint 配置落在文档 09 §2。

**一条额外的全仓禁令**：禁止直接 `new Date()` / `Date.now()` / `crypto.randomUUID()`，统一走 shared-kernel 的 `Clock` / `IdGenerator` 端口（`no-restricted-syntax` 强制，端口实现处豁免）。理由：时间与 ID 是本项目最大的测试不确定性来源（idle 阈值、设备码 15min、重试 24min×5、调度器每分钟扫描），端口化之后这些逻辑才能被写成确定性用例（见 [25 §1.4](./25-后端测试体系.md)）。

## 4. 关键选型

| 领域 | 选型 | 版本/现状（2026-08） | 理由 |
|---|---|---|---|
| 框架 | NestJS 11.x + Node 22 LTS（前后端统一，.nvmrc 钉死） | — | DI + 模块化天然适配 DDD |
| Schema 单一来源 | zod + nestjs-zod | — | 一份 schema 产出 REST DTO + Swagger + MCP inputSchema（见文档 02） |
| sandbox 实现 | `aio`（AIO Sandbox 容器，默认）+ `boxlite`（BoxLite micro-VM，进程内嵌） | 见 04 §2.1 | 同一 OCI 镜像双实现通用；容器级与 micro-VM 级隔离两档 |
| PTY | —（`provider.spawn({tty:true})` 统一提供，04 §2.2） | — | node-pty 仅未来"本地进程 provider"场景需要 |
| WS | @nestjs/websockets + socket.io | 官方适配器 | room/重连/多路复用原语现成 |
| 持久化 | better-sqlite3 + Drizzle ORM | ~3M 周下载 | 单机零依赖；Drizzle 双方言，迁 Postgres 成本低 |
| 日志 | nestjs-pino | — | 结构化，带 sandboxId/traceId |
| 加密 | Node crypto AES-256-GCM | — | CredentialVault |

## 5. 领域事件与模块间通信

- 上下文之间**不直接调用对方 domain**，通过 application service 或领域事件（shared-kernel 的 EventBus，起步用进程内 EventEmitter 实现）交互。
- 例：`SandboxStateChanged` 事件 → terminal 上下文级联关闭会话、WS 事件通道推送前端。
- **`automation` → `sandbox` 只走 application service**：调度器调 `SandboxApplicationService.createSandbox()` 创建标准 Task，不得自行登记配额、不得直接改状态机、不得绕过工作区独立副本（P21-7 §9）。这条是本规则最容易被违反的一处——"定时任务想快点跑起来"的诱惑很大，但绕过一次就意味着两套生命周期逻辑。
- **`project` → `sandbox` 的级联删除**同理走 application service 编排（先按状态机销毁实例与卷、保留标记的成果卷，再删项目记录，13 §2）。

## 6. 风险与备选

| 风险 | 缓解 |
|---|---|
| DDD 四层对小团队初期显得重 | shared-kernel 基类把样板代码压到最低。**注意：commands/queries 一律按 26 §0.2 的形态展开，不提供"先合并为 use-cases 单目录"的选项**（审计 M-3：该选项与 26 的写死拆分冲突，且瘦身已否决，保留完整分层） |
| better-sqlite3 同步 API 阻塞事件循环 | 并发 sandbox > 50 或 QPS > 100 时迁 Postgres（Repository 接口已隔离，见文档 11） |
