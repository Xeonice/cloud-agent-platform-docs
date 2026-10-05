# 新设计迁移状态

2026-10-05，继续原 Claude 会话的设计迁移。原会话止于认可设计稿，尚未修改实现。本次直接在当前 workspace 完成前后端、产品与工程文档、新验收体系迁移；历史会话仅作只读参考，没有修改或恢复原 provider 会话。

## 当前完成状态

已导入完整设计基线：247 条需求、1016 条 AC、172 张领域状态稿，以及共享组件稿、样式、字体和许可证。权威来源与 SHA 记录见 [设计索引](docs/design-v2/README.md) 和 [导入清单](docs/design-v2/source-manifest.json)。当前代码为核对依据。

工作台、任务发起/生命周期、项目、登录与凭证、口令、镜像、系统/诊断/审计、自动化、初始化，以及对应产品与工程文档均已迁移。严格完成门禁通过：247 条需求均有核对记录，1016 条 AC 无待实现项，172 张领域稿均有最终处置与证据，211 个导入文件来源校验通过。

AC 台账中 1011 条为当前实现已核对，3 条互斥分支由明确裁决替代，2 条按源规格延后：镜像下载使用代理、系统页访问保护设置区块。这两项属于源规格明确排除的当前版本范围，仍单列为 deferred。理由与原始 Given/When/Then 保留在 [完整 AC 台账](artifacts/migration-audit/current-ac-ledger.json) 和 [迁移裁决](artifacts/migration-audit/migration-decisions.md)。

## 已迁移的行为

- 全局 v2 token、本地 Geist 字体、共享侧栏与标题栏、命令面板、结构骨架、统一弹层和可访问焦点；设置与工作台保持一致。
- 项目创建、真实克隆错误与取消、恢复/转空项目、信息/删除预览；项目数据库级联使用事务，文件与任务资源清理在提交后执行并可恢复。
- 项目总览、资源容量、任务筛选、交互终端、等待输入与无头输出；断线重连重新查询，迟到 REST 不覆盖较新事件；停止/启动/销毁与准备取消协调。
- 发起任务表单、Agent/镜像选择、禁用原因、镜像锁定快照、诊断与镜像回程；任务删除、无头终止均保留真实处理中状态。
- 共享登录面板、设备码/Token/API Key、独立 Agent 生效方式与删除预览；同方式重新登录迁移真实绑定，撤销失败保留补偿记录，Git 凭证只用于平台 Git 操作。
- 访问口令门、错误与锁定状态、口令轮换的会话失效选择；普通匿名资源读取不计作错误猜测。
- 镜像登记/预览/验证、版本与运行参数继承、预制下载/禁用、真实引用删除限制；下载与诊断区分未知、超时、失败和完成。
- 系统资源、Provider 日志、共享代理、环境诊断、审计筛选/导出；导出包含最近实际诊断快照，日志截断来自真实读取结果。
- 自动化规则、调度与执行历史、关注提示、成果与残余资源恢复；初始化五步向导及失败/离线/跳过/回程行为。

产品页面、前端实现页与测试策略均已更新，过时 HTML 原型已退休；设计原稿保留来源与必要的历史引用规范化记录。OpenAPI、生成类型和跨仓契约随实现同步。

## Mac mini 部署进展（2026-10-06）

后端新增精确 HTTP/WS Origin 校验、可信本机代理处理及鉴权部署探针。Mac mini 已安装专属 launchd CI/CD controller，匹配指定发布分支的成功 push CI 后进行本机原生构建；首次生产版本 `134433f…` 已在独立的 `3101` 和生产数据目录运行，原 `3100` 预览任务保留。控制器只在生产空闲且持久格式兼容时自动切换。

Vercel 最新前端 `1ab5b18…` 已发布至 `agent.douglasdong.com`，生产 API 通过专属 Cloudflare Tunnel 接入 `agent-api.douglasdong.com`。正式浏览器解锁、受保护 REST、WebSocket、真实 VM 生命周期与后续 guest HTTPS 检查均通过；生产模型账号尚未配置，未调用真实 LLM。自动部署、缓存、人工维护与恢复命令见 [Mac mini 部署](docs/macmini-deployment.md)，实际状态与实跑记录见 [部署控制面](artifacts/deployment-preconfiguration/control-plane.json)和[部署验证](artifacts/deployment-preconfiguration/verification.json)。用户级 LaunchAgent 仍依赖该用户登录。

## 验收口径

代码逐项审查、组件/协议测试、浏览器状态检查是不同证据。AC 台账保留 Given/When/Then 和执行等级；不能把 1016 条代码审查写成 1016 条端到端测试。明确由已选产品裁决替代或延期的分支保留理由。

新版前端验收使用实际 container、Query、store 与 HTTP/WebSocket 边界；新版后端验收使用生产服务、SQLite、完整 Nest HTTP/MCP/WS、原生子进程与本地 Git 协议。真实跨仓浏览器验收通过独立 API、临时 DATA_ROOT 和新 SQLite 执行。外部 OAuth/云基础设施使用明确的外部替身，未把它们写成真实供应商验证。

旧测试已全部退休并有映射：前端 HEAD 141 套，后端 HEAD 241 个测试/夹具/辅助文件，跨仓原 6 套。新版从设计触发和结果重新编写，未把旧目录改名冒充新体系。

最终实跑结果均为零失败、零跳过：后端 41 文件 / 160 场，前端 17 文件 / 78 场，Storybook 97 文件 / 540 场；另有修复后相关 Storybook 的 11 场补验。真实跨仓链路 1 场通过，包含 31 个实际 Playwright expect 步骤，覆盖创建项目、创建任务、停止、再启动、锁定镜像、删除及清理终端。

设计 runner 使用生产构建、隔离 API/WS 和真实页面交互。170 张 UI 稿完成暗/亮主题 × 1440/1024/390 的 1020 组检查；另 1 张首次口令 CLI 稿完成非 UI 验证，1 张历史审计状态稿在当前事件产出模型下不适用，保留理由。该结果是状态、交互、焦点、布局及截图检查，不宣称逐像素一致，也不等同于全部 1016 条指定层级 AC 实跑。旧失败报告保留，最终稿件清单明确引用通过证据。

## 复跑与证据

本机使用 Node 22.23.3。主要命令：

- 主仓：`pnpm docs:check`；`pnpm migration:check:complete`。
- `api`：`pnpm test`、`pnpm typecheck`、`pnpm lint`、`pnpm build`；执行报告在 `acceptance/execution-report.json`。
- `web`：`pnpm test`、`pnpm test:storybook`、`pnpm typecheck`、`pnpm lint`、`pnpm build`。
- `e2e-contract`：`pnpm test`，独立真实 API/浏览器验收。
- `web/scripts/check-design-shell-project-v2.mjs`、`check-design-credential-v2.mjs`、`check-design-image-system-v2.mjs`：生产服务器上全稿状态检查。

当前逐项与逐稿证据位于 [迁移审计索引](artifacts/migration-audit/README.md)，完整汇总为 [current-summary.json](artifacts/migration-audit/current-summary.json)。旧 `summary.json`、初轮 `*-audit.json` 和中间阶段台账为历史审计，不能用作最新完成比例。迁移验收阶段未提交或发布。2026-10-05 用户随后授权提交、推送并启动本地服务；本页随三仓设计迁移代码提交，远端分支与本地启服结果另记在提交/预览记录中。
