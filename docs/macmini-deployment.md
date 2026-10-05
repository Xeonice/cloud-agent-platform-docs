# Mac mini 后端持续部署

本次部署将 Vercel 前端与 Mac mini 原生 API 分开运行。Mac 上使用固定的 launchd 轮询服务，只发布指定仓库和分支上已经通过 GitHub CI 的 commit。生产实例使用独立的 `3101` 端口、数据库、工作区和 BoxLite home；现有 `3100` 预览实例及其中的用户任务继续运行。

本文记录已核实的部署边界与本轮实施方案。服务是否已经安装、当前发布 SHA 和外部域名是否可访问，应以部署脚本的实际状态及执行记录为准；本文不把待配置的 Tunnel 或凭证视为已经完成。

## 已核实的仓库与宿主

2026 年 10 月 6 日通过 GitHub API 只读核对：`Xeonice/agent-platform-api` 是公开的个人仓库，默认分支为 `main`。当前开发与本次发布来源为 `feat/design-v2-migration`；该分支未受保护，只有具备 push 权限的可信维护者应向其提交发布代码。`main` 已要求 `build-test` 检查且管理员同样受约束，但这不自动保护另一个分支。

API 的 [CI workflow](../api/.github/workflows/ci.yml) 名为 `CI`，触发事件是 `push` 与 `pull_request`，job/check 名为 `build-test`，运行在 `ubuntu-latest`。它已验证静态检查、fresh acceptance、构建和 OpenAPI 漂移，但没有生成可直接发布到 Darwin ARM64 的应用产物。Web 与根仓跨仓 workflow 也运行在 GitHub 托管 runner；它们的测试报告不等于 Mac 原生发布包。

首次生产发布为 `134433f47912f7172faae50ea3285d010f6a3425`，其 [push CI run](https://github.com/Xeonice/agent-platform-api/actions/runs/37362932121) 为 `completed / success`。Mac mini controller 随后完成独立原生构建并在 2026-10-06 03:27（北京时间）激活生产 `3101`；原生 acceptance 通过 196 项。鉴权版本与 deployment readiness、HTTP Origin 和 WebSocket 握手已经在本机实际验证，现有 `3100` 预览任务仍运行。轮询服务每次重新核对当前分支 head，不将首次发布永久当作最新版本。

宿主是 macOS ARM64，Node `22.23.3` 可用；API 包管理器声明为 pnpm `9.12.0`。Docker CLI 已安装，但只读探测时 daemon 不可用，因此本方案选择原生 Node 和 BoxLite，不依赖启动 Docker。既有 API 与 BoxLite 实例的运行状态不属于新服务的接管范围。

## 持续部署服务

采用本地安装的可信 controller，而不是将生产 Mac 注册为公开仓库的通用 GitHub runner。GitHub 官方指出，公开仓库的 PR 可将不可信 workflow 送到 self-hosted runner；环境审批不能给同一宿主提供执行隔离。[GitHub runner 安全说明](https://docs.github.com/en/actions/reference/security/secure-use)

controller 只向 GitHub 发出查询，不需要公网 webhook、额外端口或 Cloudflare 路由。它固定以下白名单，不执行 GitHub 响应携带的 shell、PR 修改的 workflow 或任意仓库参数：

| 项目 | 固定值或条件 |
| --- | --- |
| 仓库 | `Xeonice/agent-platform-api` |
| 发布分支 | `feat/design-v2-migration` |
| workflow | `.github/workflows/ci.yml`，API 查询可使用文件名 `ci.yml` |
| 事件 | `push` |
| SHA | 当前远端分支 head，与 workflow 的 `head_sha` 完全一致 |
| CI 结果 | `status=completed` 且 `conclusion=success` |
| 本地命令 | 安装时固定的构建、测试、发布命令 |

controller 校验 workflow 整体成功；当前 workflow 只有 `build-test` 一个 job。前文的 check 名与产出 app 是本次 GitHub API 实查事实，不能解释为 controller 还执行了额外的 check-runs 校验。它另要求候选继承配置中的最小发布 commit，并且 CI run 创建时间不早于发布通道的启用时间，防止将未包含本轮维护门禁的历史版本直接启用。

GitHub 的 workflow runs 接口支持 `branch`、`event` 与 `head_sha` 过滤，公开资源允许匿名读取；使用独立的只读 token 时仅需相关仓库的 Actions read，并按分支查询需要提供 Contents read。只输出 run ID、SHA 和结果，不输出凭证或完整鉴权响应。[GitHub workflow runs API](https://docs.github.com/en/rest/actions/workflow-runs)

查询失败、分支 head 尚未通过 CI、本地构建失败或生产正在执行任务时，controller 保留现有版本并记录原因。一个发布锁覆盖查询后的构建和切换，避免自动轮询、手工重试与恢复同时操作生产实例。发布状态保存候选 SHA、CI run、构建结果和激活结果，已完成的 SHA 不重复构建。

## launchd 生命周期

controller 是一次查询并退出的进程，采用 `RunAtLoad` 配合 `StartInterval=180`；间隔触发不承诺精确到每个时点。API runtime 是长期进程，使用另一个 label 和 `KeepAlive=true`。两者都使用绝对可执行路径，不依赖终端 shell 的 fnm 初始化、当前目录或交互式 PATH。

| 服务 | launchd label |
| --- | --- |
| CI 轮询 | `com.douglasdong.agent-platform.cicd` |
| 生产 API | `com.douglasdong.agent-platform.api` |
| 专属 Tunnel | `com.douglasdong.agent-platform.tunnel` |

固定程序的仓库来源为 [controller.mjs](../deploy/macmini/controller.mjs)、[runtime.mjs](../deploy/macmini/runtime.mjs) 与 [lib.mjs](../deploy/macmini/lib.mjs)。安装时复制到服务目录，不在每次发布时从 API 候选源码替换 controller。配置文件与 `runtime.env` 使用 owner-only `0600` 文件。

本轮无需 sudo 的安装方式是用户级 LaunchAgent，plist 位于当前用户的 `~/Library/LaunchAgents/`。它随该用户登录加载，注销时会收到 SIGTERM；不能将它描述为冷启动后无人登录也持续工作的系统 daemon。需要无人登录运行时，可另行将已核对的同一套 wrapper 配置为 `/Library/LaunchDaemons/` 中的 LaunchDaemon，并指定服务用户；这一升级涉及系统安装，不是本轮用户级服务的隐含能力。[Apple launchd 说明](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html)

controller、API runtime 与 Tunnel 各自具有独立 label 和日志。暂停发布只停止 controller；停止生产 API 不停止 `3100` 预览进程，也不停止整个宿主上的 BoxLite 进程。运行服务时不将 token、访问口令或主密钥放在命令行参数或 plist 中。

## 安装与日常操作

使用已安装的 Node 22 执行 [install.mjs](../deploy/macmini/install.mjs)，并在仓库根目录运行以下首次安装命令。`init` 创建配置、受限 runtime 文件与两份 plist，但默认 `deployEnabled=false`；`start` 只加载 CI 轮询 LaunchAgent，不会直接启动 API 或激活旧候选。

```sh
node deploy/macmini/install.mjs init
node deploy/macmini/install.mjs start
node deploy/macmini/install.mjs status
```

这组 `node` 必须解析为 Node 22，安装脚本还会拒绝非 Darwin ARM64 宿主。初始化记录 `channelStartedAt`；它之后的新可信 push 必须包含本轮维护与 readiness 实现。初始化之前的旧成功 CI，包括重新执行旧 run，不能绕过该时间条件。当前历史 `7dc3ae7b` 成功记录只作为已有 CI 的事实，不是直接上线授权。

代码审查、本机检查与新 push CI 完成后，在本机使用已审查的完整 40 位 API commit 启用发布；尖括号是参数占位符，执行时替换为实际 SHA。

```sh
node deploy/macmini/install.mjs enable <full-api-commit-sha>
node deploy/macmini/install.mjs status
```

`enable` 写入最小发布 commit；候选必须等于它或是它的后代，仍需匹配远端分支 head 和成功 CI。`disable` 使轮询保持只构建模式，controller 在构建完成后及切换开始前重新读取配置；禁用、发布通道或 runtime 配置发生变化时，不激活该轮候选。切换已经开始后先等待其完成或恢复，不能用改配置中断备份与恢复事务。`stop` 卸载轮询服务而保留 API。更新本机 controller 时先停止轮询，再使用最新仓库中的安装工具复制已核实的新工具并重新加载。

```sh
node deploy/macmini/install.mjs disable
node deploy/macmini/install.mjs stop
node deploy/macmini/install.mjs update-tools
node deploy/macmini/install.mjs start
```

安装后日常 `start`、`stop`、`enable`、`disable` 与 `status` 也可使用 `/Users/douglasdong/.local/share/agent-platform-deploy/tools/install.mjs`，不需要保留当前 Orca 终端；`update-tools` 应执行新仓库版本的安装脚本，而非让已安装副本复制自身。`status` 只输出发布状态、SHA 与服务是否已加载；它不输出 `runtime.env`。`config.json`、`runtime.env` 和服务日志位于服务根目录，不能将文件完整内容复制到公开报告。

`stop` 保留 LaunchAgent 的 plist；下一次用户登录仍会加载轮询服务。长期暂停自动发布应先 `disable` 再 `stop`，而不是只停止一次进程。手工维护使用人工标记；controller 仅恢复自身拥有的自动发布标记，并且禁用发布时不自动解除维护。

如果状态为 `stale-lock-needs-recovery`，不要自动抢锁或直接删除目录。`controller.lock` 防止并行发布，`runtime.lock` 从 API 子进程启动前一直持有到其退出；wrapper 意外终止留下锁时，launchd 的重启不会再创建第二个 API。即使锁被意外删除，runtime 仍检查 `runtime-state.json` 中的旧 API PID，旧子进程存活就拒绝启动。

恢复时先 `stop` 轮询；API runtime 的人工恢复须先通过 `launchctl bootout gui/<当前UID>/com.douglasdong.agent-platform.api` 卸载其服务，再核对旧 wrapper、API 子进程和编译子进程是否已退出、候选是否已经激活。当前安装工具的 `stop` 仅停止轮询，不提供 API 停止命令。确认没有残留受管进程后，仅恢复此服务自己的锁；不操作 `3100` 或其他 BoxLite 进程。controller 仅识别自身生成的 JSON 维护标记；部署仍获批准、当前受管 SHA 与实际 API 版本一致且鉴权 readiness 通过后，才自动清除。人工、旧格式、被替换或改写的标记保留，交由运维恢复。

## 版本目录与持久数据

服务根目录为 `/Users/douglasdong/.local/share/agent-platform-deploy`，生产数据根目录为 `/Users/douglasdong/agent-platform/production`。版本和数据分开存放；以下逻辑布局中持久数据与 BoxLite home 由 `runtime.env` 的固定绝对路径连接，实际子目录以安装配置为准：

```text
service-root/
  tools/               固定的可信发布程序与安装工具
  config.json          固定通道与服务配置
  runtime.env          生产运行配置及秘密
  source.git/          API 仓库的本地 bare 源码缓存
  pnpm-store/          此宿主的依赖缓存
  releases/<sha>/      该 SHA 的源码、原生依赖、dist 与迁移文件
  current -> releases/<sha>
  controller.lock/     发布锁与 owner 记录
  runtime.lock/        API wrapper 与子进程的生命周期锁
  status.json          发布结果
  runtime-state.json   受管 API 的 PID 与 SHA
  maintenance          发布期间的维护门禁文件
  logs/                controller 与 API 日志
  backups/             发布前的数据库快照

/Users/douglasdong/agent-platform/production/
  platform.db          生产 SQLite 数据库
  baselines/           生产项目基线
  workspaces/          生产任务工作区与保留成果
  boxlite/             生产 BoxLite 私有目录
```

每个 release 先在单独目录完成构建与验收，再激活 `current`。激活后的目录不原地 `git pull` 或重建；保留上一版本的完整原生依赖，使应用代码回退不依赖再次下载。应用版本信息通过 `APP_VERSION`、`APP_COMMIT` 与 `APP_BUILT_AT` 注入，生产应记录完整 API SHA。

runtime 必须显式设置以下配置。口令及其他秘密保存在 release 目录之外，文件权限为 `0600`、父目录为 `0700`；日志含构建、测试和 API 输出，程序不得记录口令、token 或主密钥，运维也不应将完整日志复制到公开报告。

| 配置 | 本轮用途 |
| --- | --- |
| `HOST=127.0.0.1` | 只接收本机 Tunnel 或本机直接访问 |
| `PORT=3101` | 与现有预览 API `3100` 分开 |
| `DATA_ROOT` | 固定的生产数据绝对路径 |
| `DATABASE_URL` | 生产 `platform.db` 的固定绝对路径 |
| `BOXLITE_HOME` | 固定的生产 BoxLite 绝对路径 |
| `MIGRATIONS_DIR` | 当前 release 内的 `drizzle` 绝对路径 |
| `APP_COMMIT` | 当前完整发布 SHA |
| `SANDBOX_DEFAULT_IMAGE` | 保持出厂默认选择，不能固定为另一 provider 的镜像 |

首次生产启动使用空的新数据目录。不得复制现有预览数据库的活动任务记录，再让新实例的启动恢复逻辑接管它们。后端默认的数据与迁移目录都与 cwd 有关，未显式配置会使 symlink 切换产生另一份数据库或找错迁移目录；实际解析见 [env.ts](../api/apps/api/src/platform/config/env.ts) 和 [drizzle.connection.ts](../api/apps/api/src/platform/persistence/drizzle.connection.ts)。

BoxLite 对同一个 home 使用独占目录锁。本仓每个 API 进程共享一个 runtime，SDK 读取 `BOXLITE_HOME`。因此独立 home 是预览与生产并行的必要条件；两个实例仍共享宿主 CPU、RAM、磁盘和端口，资源上限需考虑两者总和。BoxLite 的自动端口发布由现有 provider 分配空闲宿主端口，不能把目录隔离当作端口或网络隔离。[本仓 BoxLite runtime](../api/packages/modules/sandbox/src/infrastructure/providers/boxlite/boxlite-runtime.ts) · [上游 runtime 架构](https://github.com/boxlite-ai/boxlite/blob/main/docs/architecture/README.md)

## 原生构建与缓存

在当前 Mac 的 Darwin ARM64 和 Node 22 环境中安装锁定依赖并构建，以便 `better-sqlite3` 和 BoxLite 原生包与 runtime 一致。Linux CI 的 `node_modules`、Docker 镜像或另一个架构的二进制不能直接成为此原生服务的运行依赖。

runtime 每次启动前都会核对 Node 22、Darwin ARM64、release manifest，以及 manifest 中 DATA、DB、BoxLite 三个固定路径与当前 runtime 配置一致；任一不符即拒绝启动 API，须先审查数据接管方案。这个检查同样约束 launchd 重启，不能仅依赖发布 controller 的切换前检查。

本地 pnpm store 可重复使用；缓存至少区分 lockfile、Darwin ARM64 与 Node 主版本。每个 release 使用自己的依赖目录与构建产物，不缓存数据库、主密钥、运行配置、项目工作区或 BoxLite home。固定的本地检查执行 API 当前静态门禁、fresh acceptance 与构建；不将 GitHub CI 成功理解为外部 provider 已在此宿主实际创建成功。

构建进程使用干净环境与独立临时数据路径，runtime 才读取生产口令和持久路径。本轮用户级安装若构建和 runtime 属于同一 macOS UID，这提供的是流程和目录分离，不能阻止恶意构建代码读取该用户可读的生产文件；因此只构建固定可信发布分支。需要执行不可信代码时，另设受限构建用户或干净 VM，不能扩展当前 controller 去接受 PR。

## 空闲门禁与切换

controller 通过 Bearer 鉴权查询本机 `GET /api/deployment/status`，要求生产后端 ready、idle，并在维护文件已建立之后再次确认 draining。[返回契约](shared/10-接口契约与类型共享.md#662-apideploymentstatus-的部署状态契约)由 API 结合活动 HTTP、WebSocket、授权会话与数据库计算；不能只检查 `agent_tasks`，交互式任务的生命周期记录在 `sandboxes`，并非每个交互式任务都对应 headless `agent_tasks` 行。持久化门禁对应以下只读计数，任一非零即暂缓切换：

```sql
SELECT 'sandboxes' AS kind, COUNT(*) AS count
FROM sandboxes WHERE status NOT IN ('stopped', 'failed', 'destroyed')
UNION ALL
SELECT 'agent_tasks', COUNT(*) FROM agent_tasks WHERE status = 'running'
UNION ALL
SELECT 'automation_runs', COUNT(*) FROM automation_runs
WHERE status IN ('pending', 'running')
UNION ALL
SELECT 'resource_allocations', COUNT(*) FROM resource_allocations
WHERE released_at IS NULL
UNION ALL
SELECT 'cloning_projects', COUNT(*) FROM projects WHERE clone_status = 'cloning'
UNION ALL
SELECT 'project_cleanup', COUNT(*) FROM sandbox_project_cleanup_jobs;
```

v1 还要求 `automations.enabled=1` 的规则数量为零，防止等待空闲时下一轮定时扫描创建新任务；它不会自动停用用户规则。活动连接或授权过程也会暂缓发布，不能将上述 SQL 当作完整的 API 门禁替代品。

`waiting_input` 是 `running/idle` 上的展示投影，不是持久化 sandbox status。资源占用是否结束由 `released_at` 判定，`reconciliation_status='confirmed'` 不表示空闲。状态端点通过 API 现有数据库连接执行只读查询，仅输出计数；已存在的数据库若缺表、读取失败或结果异常，不能当作零。全新生产库由首次启动迁移建立之后再使用这些查询。

一次零计数不足以消除新请求或自动化扫描的竞态。controller 创建服务根目录下的 `maintenance` 文件，由生产 API 的维护门禁停止接收新工作，再确认 draining 与 idle；等待 10 秒安静窗口并重新确认之后，才进行备份与单实例切换。维护文件由发布流程结束时清除，发现新 head 或未达到空闲时保留原服务。不得依靠强制停止用户任务来让计数归零。切换只操作受管的 `3101` 服务。

BoxLite sandbox 创建已设置 `detach: true` 与 `autoRemove: false`，headless Task 保存 job handle 与 cursor，并在启动时恢复；这些机制支持故障恢复，但不构成自动发布期间零中断的承诺。本轮保守策略仍等活动工作全部结束，且不接管现有预览任务。[BoxLite provider](../api/packages/modules/sandbox/src/infrastructure/providers/boxlite/boxlite-sandbox.provider.ts) · [Task 恢复流程](../api/packages/modules/sandbox/src/application/workflows/run-agent-task.workflow.ts)

`GET /api/health` 是免口令的 liveness 检查，只返回 `status` 与 uptime；它不证明 BoxLite 可创建任务，也不证明正在运行预期 SHA。controller 激活时同时验证该接口、鉴权 `GET /api/system/version` 的完整 commit 与部署 status 的 `ready=true`。部署 readiness 检查 SQLite quick/foreign-key check、默认 provider 和 BoxLite SDK 可载入，以及默认镜像已注册且有效；它不创建微 VM、不下载镜像，实际任务创建仍是外部验收的一部分。[health controller](../api/apps/api/src/platform/system/health.controller.ts) · [version service](../api/apps/api/src/platform/system/system-version.service.ts) · [部署状态](../api/apps/api/src/platform/deployment/deployment.controller.ts)

## 数据库迁移与回退

API 在首次打开数据库时自动执行当前 release 的迁移。不能在旧 API 正在服务时启动另一 candidate 指向同一个生产库，只为做健康检查；它可能提前改变旧进程使用的 schema。验证 candidate 时使用独立临时库与独立 BoxLite home。[启动持久化装配](../api/apps/api/src/platform/persistence/platform.module.ts)

生产切换前 controller 使用 SQLite backup API 取得包含 WAL 状态的一致快照，并保留固定数据目录中的主密钥；不能将运行中的主 `.db` 单文件复制当作完整备份。它比较完整迁移文件集合的 hash、BoxLite SDK 版本，以及 DATA、DB、BoxLite 三个绝对路径；任一变化都返回 `schema-or-data-change-needs-review`，不自动激活。

这三个路径、迁移 hash 与 SDK 版本一致时，candidate 启动失败才允许恢复旧应用 release。这个门禁识别已提交迁移文件与持久目录的变化，不证明任意业务代码的数据格式变化兼容。BoxLite 当前依赖锁定为 `0.9.7`，其 home 另有 SDK 私有持久格式；未来升级 SDK 时，需要审查该格式的兼容性。迁移已经改变生产 schema 时，只有经过兼容性检查才能只回退代码；无法证明兼容就保持停机并进入明确的恢复流程，不盲目自动恢复旧数据库抹掉新版本已写入的数据。

新版本尚未开放写入、数据库快照完整且活动门禁通过时，可按实际发布记录执行快照恢复。已接收新任务或新业务写入后，恢复发布前快照将丢失这些写入，不能作为无损回滚。BoxLite home 和项目工作区也不是数据库快照的一部分，恢复时需要核对它们与任务记录的对应关系。

### 需要人工审查的升级

`enable <sha>` 只批准发布通道，不放行 schema、BoxLite 或数据路径变更。`schema-or-data-change-needs-review` 的候选已经完成构建，但应由维护者确认迁移的前后兼容性、数据保留、BoxLite 格式以及恢复方案后，在维护窗口手工激活；当前工具没有“忽略差异并自动上线”的命令。

1. 先 `disable`、再 `stop` controller。核对 `controller.lock/owner.json` 对应进程及其构建子进程均已退出；若仍有锁或维护文件，先按发布记录恢复，不覆盖它们。人工维护文件可写入 `manual\n`，使用 `0600` 权限且只在文件不存在时创建；自动控制器不会接管这种标记。
2. 等待鉴权部署状态的 `ready=true`、`draining=true`、`idle=true`，持续观察安静窗口。保留当前 release SHA 和真实数据路径，使用当前 release 的 `better-sqlite3` backup API 生成包含 WAL 的备份。BoxLite home、主密钥和工作区需要各自的保留或快照方案。
3. 卸载生产 API，并核对 `runtime-state.json` 的旧 API PID 已退出，`runtime.lock` 已由 wrapper 正常释放。下面的命令只停止受管生产服务，不操作预览实例：

   ```sh
   launchctl bootout "gui/$(id -u)/com.douglasdong.agent-platform.api"
   ```

4. 将 `AGENT_PLATFORM_RELEASE_SHA` 设为已审查且构建完成的完整 commit；确认其 manifest、固定数据路径和原生环境正确后，以临时 symlink 原子切换版本，再加载生产 wrapper：

   ```sh
   node --input-type=module <<'NODE'
   import * as fs from 'node:fs/promises';
   import { homedir } from 'node:os';
   import { join } from 'node:path';
   const root = join(homedir(), '.local/share/agent-platform-deploy');
   const { readyManifest, assertNoLiveApi } = await import(join(root, 'tools/lib.mjs'));
   const sha = process.env.AGENT_PLATFORM_RELEASE_SHA;
   const release = join(root, 'releases', sha ?? '');
   await readyManifest(release, sha);
   assertNoLiveApi(JSON.parse(await fs.readFile(join(root, 'runtime-state.json'), 'utf8')));
   await fs.symlink(release, join(root, 'current.manual-next'));
   await fs.rename(join(root, 'current.manual-next'), join(root, 'current'));
   NODE
   launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.douglasdong.agent-platform.api.plist"
   ```

5. 保持人工维护屏障，确认健康、鉴权版本 SHA 和 readiness；核对实际数据迁移结果。失败时保持屏障并卸载候选 API，按已经审查的兼容回退或数据恢复方案处理，不直接启动旧 release。DATA、DB 或 BoxLite 路径变更还需要明确的数据接管；wrapper 会拒绝与 manifest 不一致的运行配置。
6. 验收通过后由维护者显式移除自己的人工维护标记，记录发布与备份路径，再 `enable <新sha>`、`start` controller。锁故障恢复同样在确认旧进程全部退出后，恢复自己的锁并使用上述 `bootstrap` 命令加载已经核实的 `current`；只有版本与 readiness 验证成功，才恢复外部写入。

## 前端域名与 Tunnel

前端已使用 `https://agent.douglasdong.com`，API 为同一站点下的 `https://agent-api.douglasdong.com`。现有 `ap_session` 是 API 域的 host-only、HttpOnly、SameSite=Lax cookie；同站点的两个 origin 仍需要精确 CORS。不能直接把任意 `vercel.app` 预览域当成同站点生产前端，也不能只改 WebSocket 地址而让解锁请求留在 Web 域。

前端通过 Vercel 的 Git integration 构建发布。项目的 production branch 为 `feat/design-v2-migration`，`web/vercel.json` 仅启用该分支自动构建；项目已开启生产 custom domain 自动分配，Preview 仍禁用。当前正式版本为 `1ab5b18c1e3d8c173ceef5728e690af8c605df88`，deployment 为 `dpl_5CTNChRCzUdoXM6p3dgmrjLgcmoX`，已确认域名 alias 指向该 deployment。

Vercel 使用锁定 pnpm 与平台构建缓存；Mac 原生发布复用独立 pnpm store，每个 SHA 的成功 release 只构建一次。CLI 上传另由 `.vercelignore` 排除本地 Next acceptance 输出，实测输入从 350.06 MiB 减至 3.07 MiB；这不等同于压缩 Git integration 的干净 checkout。两次 CLI 发布受 commit-author 权限校验阻止，未运行构建；最终正式构建和发布来自已配置且获授权的 Git integration。

Vercel 构建时将 `NEXT_PUBLIC_API_BASE_URL` 与 `NEXT_PUBLIC_WS_BASE_URL` 同时设为生产 API HTTPS origin，REST、SSE、解锁与 Socket.IO 都直连 API。API 设置实际 Web HTTPS origin 的 `API_ALLOWED_ORIGINS`、`API_TRUST_PROXY=cloudflare-loopback`、`PASSCODE_COOKIE_SECURE=true`，且不启用 `ACCESS_PASSCODE_ALLOW_LOOPBACK`。这些 public base 在 Web build 时固化，改环境值后需要新构建。[Web 配置](../web/next.config.mjs) · [API 网络校验](../api/apps/api/src/platform/config/public-network.ts)

创建独立的 remote-managed Tunnel，发布该 API hostname 到 `http://127.0.0.1:3101`，最后一条 ingress 为 `http_status:404`；对应 DNS 是同账号内 proxied CNAME 指向新 Tunnel UUID。既有 `cap-api` Tunnel 包含其他应用路由，本轮不复用或启动它。

API hostname 的 Cache Rule 使用 bypass，避免缓存 API、SSE 与 `/socket.io`。针对 `agent-api.douglasdong.com` 的规则 `f5f377259b1844f9be10bdec3d582e47` 已预先创建并启用，无需再创建或扩大 Cloudflare 写权限。API 路径不应加入浏览器交互式 challenge。Cloudflare 提供边缘 HTTPS，Tunnel 的本机 HTTP origin 无需公开 origin 证书。WebSocket 使用直接 origin；本机 HTTP origin 不需要 `http2Origin` 设置。[Tunnel 配置 API](https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/subresources/cloudflared/subresources/configurations/methods/update/) · [Tunnel origin 参数](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/origin-parameters/)

SSE 保持 `Content-Type: text/event-stream`，Cloudflare Tunnel 据此直接输出流，而非等完整响应后发送；不依赖旧的 Response Buffering Page Rule 开关。[Cloudflare Tunnel 流式响应说明](https://developers.cloudflare.com/tunnel/troubleshooting/)

独立 Tunnel 已经通过 Cloudflare 控制台创建：`agent-platform-api` / `b59b8cc0-571a-46ec-bf21-1a01b78670a4`。对应 proxied DNS 和公开路由已生效，Mac connector 以专属 LaunchAgent 运行，远端状态正常；真实 HTTPS API 验证通过。实际 ingress 与 [配置示例](../deploy/macmini/cloudflare-ingress.example.json) 一致，指向 `3101` 并以 404 收尾。只读 Wrangler OAuth 未扩权；Tunnel token 仅由专属 connector 使用受限文件读取，不进入源码、release manifest、shell 历史或命令行。[Tunnel token 管理](https://developers.cloudflare.com/tunnel/reference/tunnel-tokens/)

Cloudflare 配置完成后，将专属 Tunnel 的 token 安全保存到 `~/.local/share/agent-platform-deploy/cloudflared.token`，文件须由当前用户所有、权限为 `0600`。将 `AGENT_PLATFORM_TUNNEL_ID` 设为该新 Tunnel UUID，再从主仓使用 Node 22 执行：

```sh
node deploy/macmini/install-tunnel.mjs install "$AGENT_PLATFORM_TUNNEL_ID"
node deploy/macmini/install-tunnel.mjs status
```

[安装工具](../deploy/macmini/install-tunnel.mjs)校验 token 文件权限及所属账号、Tunnel UUID，使用 `--token-file` 启动用户级 LaunchAgent `com.douglasdong.agent-platform.tunnel`；它不创建远端 Tunnel、DNS 或 Cache Rule。`status` 只报告服务是否已加载、token 文件是否存在；加载成功仍需确认远端 connector 和真实 HTTPS 路由可达。需停止这个专属 connector 时执行 `node deploy/macmini/install-tunnel.mjs stop`，不会停止 API 服务；其登录依赖与其他用户级 LaunchAgent 相同。

## 验收范围

本轮 API acceptance 196 项、Web acceptance 102 项、Mac controller 47 项和主仓 13 项文档门禁均通过。公网协议 smoke 12 项通过，正式浏览器已完成口令解锁、初始化、重新进入后的受保护 REST 读取、101 WebSocket 握手和诊断 SSE；真实 `text/event-stream` 响应分五次接收，页面完成结果展示。实际解锁响应的 cookie 属性检查通过，但不记录 cookie 值。生产模型账号仍未配置，未调用真实 LLM。

真实 BoxLite 任务生命周期 15 项通过，包括原生 VM running、guest 工具执行、工作区读写与挂载、任务和项目清理；常驻 auth-helper 与原 `3100` 预览保留。首次 guest HTTPS 验证发生 TLS 中断；后续独立 VM 中 OpenAI、Anthropic、GHCR 和 example.com 四个 HTTPS 端点均完成证书验证，未改代理或宿主网络。首次错误未再复现，具体触发原因未确定；当前网络可达性通过，不将它解释为模型帐号或 LLM 调用已经验收。详细阶段记录以 [验证文件](../artifacts/deployment-preconfiguration/verification.json) 为准。

本地完成条件包括：固定 controller 可以识别成功 CI、失败 CI 与非白名单候选；同 SHA 不重复构建；原生构建和 fresh acceptance 通过；生产 `3101` 可达，预览 `3100` 及用户任务仍运行；发布锁和全部活动计数会暂缓切换；失败发布保留或恢复上一版本，并遵循数据库迁移边界。

外部完成条件包括：真实前端子域名、API DNS 与 Tunnel 已生效；在前端 origin 完成解锁 cookie、REST、SSE 和 Socket.IO 实际验证；实际 BoxLite 任务创建与收尾正常。用户级 launchd 的登录依赖和同 UID 构建边界保留为明确运行条件，不计作已实现的无人值守系统 daemon 或不可信构建隔离。
