# Mac mini Jenkins 构建发布与服务维护

Mac mini 负责三个仓库的服务发现、测试、原生构建、前端预构建、打包和上传。Jenkins 是 CI/CD 的调度入口；Vercel 托管 Mac 上传的前端产物，Cloudflare Tunnel 转发至 Mac 原生 API。生产使用 `3101` 和独立数据目录，`3100` 预览及既有任务保留。

本文描述仓库中实现的 Jenkins 方案。当前已完成临时 Jenkins 的原生 API 构建、日志验收和独立 GHCR 镜像凭证验证；系统 LaunchDaemon 切换与完整项目首次 Jenkins Release 仍在实施，不能仅凭脚本存在认定已经上线。实际完成状态以 Jenkins 构建、`system-services-state.json`、线上版本与 GitHub Release 的校验记录为准。

## 发布入口与流水线

管理入口为本机 [Jenkins](http://127.0.0.1:8080/)，仅监听 loopback，不增加公网管理域名。入口需要独立 Jenkins 管理员登录，与平台的访问口令不同。登录凭证保存在本机 `~/.local/share/agent-platform-jenkins-tools/admin-login.json`，管理员 API token 在同目录 `admin-api.json`；均为 `0600`，不要复制到仓库、构建参数或报告。

| Jenkins job | 职责与触发 |
| --- | --- |
| `agent-platform-ci-discovery` | 每两分钟发现三个固定仓库的分支和 PR；生产提交组合变化时触发统一发布 |
| `agent-platform-native-ci` | API 非生产分支和 PR 的原生静态、acceptance、构建及协议门禁 |
| `agent-platform-web` | 前端全部门禁、Storybook 交互、预构建和下载包；只生成产物 |
| `agent-platform-contract` | 文档及浏览器到 Nest、fresh SQLite 的跨仓验收；每天北京时间 03:00 重验 main 的精确 gitlinks |
| `agent-platform-api` | 固定可信生产分支原生 CI、空闲门禁、备份、切换和运行快照，由统一发布调用 |
| `agent-platform-release` | 固定三个 SHA，验证上述子构建，上传并启用 Vercel 前端，再上传并发布 GitHub Release |
| `agent-platform-service-monitor` | 每五分钟归档 API、Tunnel、发布状态与脱敏日志，并生成可读 HTML 报告 |
| `agent-platform-mutation` | 北京时间 02:00 全量趋势；PR changed 模式报告，不阻断发布 |
| `agent-platform-sandbox-images` | Dockerfile 变化检查；`sandbox-image-v*` 标签或手动参数发布两种 Linux 架构的 GHCR 镜像 |

源码入口为 [Jenkins pipelines](../deploy/jenkins/)。这些是维护者安装的固定流水线，不执行 PR 提供的 Jenkinsfile。Jenkins controller 的 executors 为零；`mac-ci` 与 `mac-deploy` 使用独立账户和工作目录。PR 只在无生产凭证的 CI 账户中执行；生产构建限于可信固定发布分支。

发布通道为 root 的 `Xeonice/初始化一下项目开发` 与 API/Web 的 `feat/design-v2-migration`。每次发布固定 root、API、Web 的完整 SHA，并生成组合校验 key。分支在构建期间变化会使当前候选失效；运行中的用户任务或连接会使 API 发布暂缓，由 Jenkins discovery 后续重试。已验证的前端及跨仓子构建可复用，保留原构建编号和 hash，不把缓存标成重新构建。

手动完整发布可在 `agent-platform-release` 中点击 Build with Parameters。`TAG` 为空时从 `v0.3.0` 起选择新的 patch 版本；也可指定尚未使用的不可变版本。`REQUEST_KEY` 为 discovery 的去重参数，手动运行保持为空。日常无需独立运行 API/Web 的发布命令。

## 本机产物与上传

API 用 Node 22、pnpm 锁文件和 Darwin ARM64 原生依赖构建，十二项门禁包括 fresh acceptance、provider fixtures、OpenAPI 漂移、SQLite 与 BoxLite 原生载入。激活目录与 CI 工作目录分开；每个成功原生 artifact 和 Jenkins receipt 都绑定 SHA、通道及门禁结果。

前端只在无 token 的 CI 账户中执行源码。可信部署账户先从固定 Vercel project 读取并筛选公开构建设置，CI 本地执行预构建。上传前校验三个 SHA、Jenkins 实际 SUCCESS、包大小/hash、项目身份和输出中的原生文件；包含不兼容的 Mach-O 服务端文件会阻止 Vercel 上传。Vercel 使用 `deploy --prebuilt --prod --skip-domain` 接收产物，API 的真实版本和 readiness 符合本轮固定 SHA 后才 promote 到域名。

统一发布在 Jenkins 中制作 API 原生包、前端 prebuilt、Storybook、完整项目源码、发布 manifest 和 `SHA256SUMS` 等下载资产，再直接调用 GitHub Release/asset API 上传。资产必须完整上传、大小和服务器 digest 与本机校验一致，才将 draft 变为正式 release；已发布版本不覆盖。可以在 [GitHub Releases](https://github.com/Xeonice/cloud-agent-platform-docs/releases) 查看最终可下载内容。

沙箱镜像另由本机专属 Colima/BuildKit 构建 `linux/amd64` 与 `linux/arm64`。GHCR 使用独立 classic PAT 的 `write:packages`，保存在私有 Jenkins tools 的 `ghcr-token`；Release 上传继续使用已有仓库写权限凭证。[GitHub GHCR 鉴权说明](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry#authenticating-to-the-container-registry)。`check` 不推送，报告不能表示发布成功；`publish` 必须验证 version/latest 两档匿名 OCI digest。默认镜像配置来自 [sandbox-publish.json](../api/config/sandbox-publish.json)。

API、Web 和 root 的旧 GitHub Actions workflow 在 Jenkins 对应任务实际验证后归档并远端 disable；Web 同时关闭 Vercel Git 自动构建，避免两个系统同时发布。迁移过程中原生产版本保持可用，实施记录必须区分源配置已准备和远端已经切换。

归档 `.github/workflows` 的 Git 推送需要现有 GitHub CLI OAuth 登录具备 `workflow` 权限。本机已补齐并推送 API/Web 迁移提交。专属 `Xeonice Agent Platform Jenkins` App（ID `5204009`，installation `168317369`）已实际验证，只允许三仓与 Contents read、Pull requests read、Commit statuses write，私钥保存在私有 tools 目录。

三个仓库的 main 当前仍要求检查来自固定的 GitHub Actions App `15368`；普通 OAuth 写入同名 commit status 无法替代该来源。保护迁移在真实 Jenkins 状态验证后，将必需检查绑定到新 App 的 ID，同时保留 strict、review 和管理员约束，不改成允许任意 App。配置与轮换说明见 [GitHub App 设置](../deploy/jenkins/github-status-app.md)。[GitHub 必需状态检查 API](https://docs.github.com/en/rest/branches/branch-protection#update-status-check-protection)

## Mac 常驻服务与首次切换

系统安装器 [install-system-services.mjs](../deploy/macmini/install-system-services.mjs) 将以下任务安装至 `/Library/LaunchDaemons/`，使用固定绝对程序路径和 KeepAlive，不依赖 Orca 终端或用户 shell 初始化。Jenkins 和 CI 是隐藏、禁用交互登录的专属账户；API、Tunnel、可信部署 agent 和构建 Docker 保留现有数据 owner `douglasdong`。

| launchd label 后缀（前缀 `com.douglasdong.agent-platform.`） | 运行账户与用途 |
| --- | --- |
| `jenkins` | `_agentplatformjenkins`；controller home `/Users/Shared/agent-platform-jenkins` |
| `jenkins-ci-agent` | `_agentplatformci`；无生产凭证，home `/Users/Shared/agent-platform-ci` |
| `jenkins-deploy-agent` | `douglasdong`；固定生产发布工具 |
| `api` | `douglasdong`；唯一生产 API，端口 `3101` |
| `tunnel` | `douglasdong`；现有专属 Cloudflare connector |
| `build-docker` | `douglasdong`；专属 `agent-platform-build` Colima profile，不切换用户默认 Docker context |

Node 固定为 `22.23.3`，Jenkins LTS 为 `2.580.1`，Java 为 OpenJDK 21。Node 22/bin 中安装 corepack 的 pnpm/pnpx 命令入口，使嵌套包脚本也使用正确工具链。公共 CI 工具、agent.jar 和固定 Vercel CLI `62.2.0` 安装到 root-owned `/Library/Application Support/AgentPlatform`；生产 secrets 与数据库不可被 CI 账户读取。插件版本记录见 [plugins.lock.json](../deploy/jenkins/plugins.lock.json)。

首次迁移先执行 `prepare.mjs` 生成禁用状态的固定 pipelines、私有 bootstrap 凭证与待审查 plist，再执行 system installer 的 `prepare <新目录> <system-extras.json>`。这一步只生成完整 hash review，不切换服务。维护者在本机 Terminal 用 Node 22 和 sudo 执行该 review 中的 `tools/install-system-services.mjs apply <同一review目录>`；密码仅在系统终端输入。

apply 先只读核对生产 readiness、HTTP、授权会话与全部数据库 blockers，实际工作未结束时拒绝且不修改配置。通过后永久退役旧 `cicd` 轮询器并建立自身维护屏障。仅此次人工系统迁移允许停止已核对 plist 和身份的原专属 GUI Tunnel，释放其残留 WebSocket；API 此时仍运行。所有计数归零并持续十秒安静后，才备份 SQLite、再次核对屏障及空闲，再停止原 API、安装系统服务并验证健康。日常自动发布仍要求连接也先归零，不采用此断开步骤。

生产可能短暂中断。安装器拒绝强停用户任务，拒绝两个 API 同时使用生产库；失败时按实际阶段保留 trace 或恢复原受管 API/Tunnel，旧轮询器不恢复。bootstrap 临时 Jenkins 必须先退出，避免与系统服务争用 8080。`preflight <review目录>` 可在安装前只读显示 blocker 和本次人工切换条件。可复制的首次安装与凭证命令见[本机命令文档](../artifacts/jenkins-setup-commands.md)。

`status` 和切换记录提供实际安装证据；冷启动后加载属于 LaunchDaemon 配置能力，本轮不会为验证重启整台 Mac 打断预览任务。Mac 的休眠、关机和 FileVault 启动解锁仍影响机器可用性，应与宿主已有无人值守策略一起维护。

## 状态、日志与日常维护

在 Jenkins 每个构建可查看 Console Output、阶段结果、完整 SHA、门禁报告和 artifacts。`Service status and logs` HTML 提供健康、真实版本、部署 blockers、PID、launchd 状态与日志链接。监控的五分钟快照保留十四天，报告仅包含每种日志末尾的有限行数和已脱敏字段；本机完整原始日志仍在私有服务目录中，不把快照称为完整日志。

| 内容 | 本机路径 |
| --- | --- |
| 原始 API、Tunnel、构建及部署 agent 日志 | `~/.local/share/agent-platform-deploy/logs/` |
| 当前受管 PID/SHA | 同目录根的 `runtime-state.json` |
| 最近发布结果 | 同目录根的 `status.json` |
| 系统切换步骤、备份及恢复记录 | 同目录根的 `system-services-state.json` 和 `backups/launchd-cutover-*` |
| Jenkins controller 日志、构建记录与 artifacts | `/Users/Shared/agent-platform-jenkins/`（controller 私有） |
| 隔离 CI agent 日志 | `/Users/Shared/agent-platform-ci/agent.log` |
| 统一发布资产和上传 receipt | 私有 deploy root 下的 `project-releases/`、`web-releases/`，实际路径以 manifest/receipt 为准 |

使用 Node 22 查看状态或暂停发现器，不停止生产服务：

```sh
TASK_NODE22=/Users/douglasdong/.local/share/fnm/node-versions/v22.23.3/installation/bin/node
"$TASK_NODE22" deploy/macmini/install-system-services.mjs status
"$TASK_NODE22" deploy/jenkins/manage.mjs status
"$TASK_NODE22" deploy/jenkins/manage.mjs disable agent-platform-ci-discovery
"$TASK_NODE22" deploy/jenkins/manage.mjs enable agent-platform-ci-discovery
```

暂停发现器不会取消已排队或运行中的 release；维护前在 Jenkins 查看并等待相关构建结束。更新 trusted scripts 时先暂停并确认发布锁已经释放，审查新源码，再更新私有 snapshot 与公共 CI 工具。`manage.mjs sync-pipelines` 通过已鉴权的 Jenkins 管理 API 同步固定模板，`refresh` 应用 bootstrap job 定义；它们不从 PR 读取 pipeline。全部工具和凭证准备完成、对应原生流水线验证通过后，`activate` 才启用自动发现与定时任务。

正式系统模式下，只允许固定 root-owned helper 操作生产 API/Tunnel，以下入口无需给 CI 用户一般 sudo 权限：

```sh
sudo /Library/PrivilegedHelperTools/com.douglasdong.agent-platform-service api status
sudo /Library/PrivilegedHelperTools/com.douglasdong.agent-platform-service tunnel status
```

日常应用发布由 Jenkins 完成。`api stop/restart` 会影响连接，只在已经持有维护屏障并完成空闲和备份核查的维护窗口使用。旧 `cicd` LaunchAgent 已退役，不重新启动旧轮询发布流程。

平台访问口令的维护入口是私有 `~/.local/share/agent-platform-deploy/runtime.env` 中的 `ACCESS_PASSCODE`；平台首页出现解锁界面时输入该口令。它与 Jenkins 管理员密码分开，不进入产物、GitHub 或 Vercel。改口令须在安全维护窗口重启 API，并核对 cookie 与已有会话行为；不要在构建参数中输入口令，也不要直接归档 runtime.env。

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

API 与前端依赖分别按 pnpm 锁文件安装，CI 账户的缓存与可信生产构建缓存分开。缓存仅包含依赖和不可变成功产物，不缓存数据库、运行配置、token、主密钥、工作区或 BoxLite home。每个候选先在独立目录完成真实检查；runtime 启动还会验证 Node 22、Darwin ARM64、release manifest 和固定数据路径。

production config 固定 `ciProvider=jenkins` 与 `jenkinsJob=agent-platform-api`。controller 不再读取 GitHub Actions 的绿色 run，而读取本机 owner-only、绑定 SHA/通道/检查结果的 Jenkins receipt；统一发布还核对 Jenkins 实际 SUCCESS 和完整三仓参数，不能仅凭包中的自述字段上线。

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

API 首次打开数据库时会执行该 release 的迁移。candidate 必须用独立临时数据完成验收，不能先指向生产库启动第二个 API。切换前用 SQLite backup API 得到包含 WAL 状态的一致快照；BoxLite home、主密钥和项目工作区另行保留。

controller 比较完整迁移文件 hash、BoxLite SDK 版本以及 DATA、DB、BoxLite 三个绝对路径。变化返回 `schema-or-data-change-needs-review`，不能用 enable 通道绕过。全部兼容且尚未开放 candidate 写入时，失败切换才能恢复原应用；未知兼容性或维护屏障所有权变化时，保持明确失败状态并人工恢复。已开始接收新业务写入后恢复旧数据库快照会丢失这些写入，不能作为无损回滚。

人工恢复先暂停 Jenkins discovery 并等待 release/发布锁释放，再建立人工维护标记、确认 draining/idle、备份，使用固定 helper 停止唯一生产 API。核对旧 PID 和 runtime.lock 真正释放后，才审查并切换不可变 release。保持维护屏障验证候选真实 SHA/readiness；代码、数据库及 BoxLite 格式不兼容时另做明确的数据恢复方案。不删除未知锁或别人持有的维护标记。

## 前端域名与 Tunnel

前端已使用 `https://agent.douglasdong.com`，API 为同一站点下的 `https://agent-api.douglasdong.com`。现有 `ap_session` 是 API 域的 host-only、HttpOnly、SameSite=Lax cookie；同站点的两个 origin 仍需要精确 CORS。不能直接把任意 `vercel.app` 预览域当成同站点生产前端，也不能只改 WebSocket 地址而让解锁请求留在 Web 域。

Jenkins 对固定 Vercel project `agent-platform-web` 进行 prebuilt 上传，team 为 `xeonices-projects`。正式 rollout 后关闭 Git 自动构建；每轮 Jenkins receipt 记录 deployment id、三仓 SHA 和 promote 结果，线上 alias 的实际指向以 Vercel API 核验为准。

本机复用受限 pnpm store、公开 Vercel cache 和已验证的不可变产物。Vercel OAuth 仅供可信 pull/upload/promote 使用，原私有 CLI 配置按正常流程刷新；CI 源码构建使用空 auth 配置和白名单环境。

Vercel 构建时将 `NEXT_PUBLIC_API_BASE_URL` 与 `NEXT_PUBLIC_WS_BASE_URL` 同时设为生产 API HTTPS origin，REST、SSE、解锁与 Socket.IO 都直连 API。API 设置实际 Web HTTPS origin 的 `API_ALLOWED_ORIGINS`、`API_TRUST_PROXY=cloudflare-loopback`、`PASSCODE_COOKIE_SECURE=true`，且不启用 `ACCESS_PASSCODE_ALLOW_LOOPBACK`。这些 public base 在 Web build 时固化，改环境值后需要新构建。[Web 配置](../web/next.config.mjs) · [API 网络校验](../api/apps/api/src/platform/config/public-network.ts)

创建独立的 remote-managed Tunnel，发布该 API hostname 到 `http://127.0.0.1:3101`，最后一条 ingress 为 `http_status:404`；对应 DNS 是同账号内 proxied CNAME 指向新 Tunnel UUID。既有 `cap-api` Tunnel 包含其他应用路由，本轮不复用或启动它。

API hostname 的 Cache Rule 使用 bypass，避免缓存 API、SSE 与 `/socket.io`。针对 `agent-api.douglasdong.com` 的规则 `f5f377259b1844f9be10bdec3d582e47` 已预先创建并启用，无需再创建或扩大 Cloudflare 写权限。API 路径不应加入浏览器交互式 challenge。Cloudflare 提供边缘 HTTPS，Tunnel 的本机 HTTP origin 无需公开 origin 证书。WebSocket 使用直接 origin；本机 HTTP origin 不需要 `http2Origin` 设置。[Tunnel 配置 API](https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/subresources/cloudflared/subresources/configurations/methods/update/) · [Tunnel origin 参数](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/origin-parameters/)

SSE 保持 `Content-Type: text/event-stream`，Cloudflare Tunnel 据此直接输出流，而非等完整响应后发送；不依赖旧的 Response Buffering Page Rule 开关。[Cloudflare Tunnel 流式响应说明](https://developers.cloudflare.com/tunnel/troubleshooting/)

独立 Tunnel 已经通过 Cloudflare 控制台创建：`agent-platform-api` / `b59b8cc0-571a-46ec-bf21-1a01b78670a4`。对应 proxied DNS 和公开路由已生效，当前 connector 仍是原 GUI LaunchAgent；首次失败安装已恢复原服务，正式切换后才由专属 LaunchDaemon 运行。真实 HTTPS API 验证通过。实际 ingress 与 [配置示例](../deploy/macmini/cloudflare-ingress.example.json) 一致，指向 `3101` 并以 404 收尾。只读 Wrangler OAuth 未扩权；Tunnel token 仅由专属 connector 使用受限文件读取，不进入源码、release manifest、shell 历史或命令行。[Tunnel token 管理](https://developers.cloudflare.com/tunnel/reference/tunnel-tokens/)

专属 token 保存在 `~/.local/share/agent-platform-deploy/cloudflared.token`，权限 `0600`。现有 Tunnel、DNS 和 Cache Rule 由本轮系统切换沿用，不重建远端资源；本机 helper 和 install-tunnel status 提供受管 connector 的入口，仍需用 HTTPS API 和流式/WebSocket 验证确认实际可达。

## 验证记录

历史生产部署已有 API acceptance 196 项、Web acceptance 102 项、跨仓协议、真实 BoxLite 生命周期及公网 cookie/REST/SSE/WebSocket 验证，详见 [历史部署验证](../artifacts/deployment-preconfiguration/verification.json)。这些结果不等于新 Jenkins 全量 Release 已完成。

本轮完整部署回归为 213 项，实际 Node 22/macOS ARM64 执行全部通过、没有跳过；覆盖 controller、系统迁移、monitor、公共工具、前端打包、API 可移植包、镜像、mutation、App 和 Release/discovery。文档 13 项门禁及九个 pipeline 的离线 Groovy 语法编译通过。API 可移植原生包已在不同目录解压并实际载入 SQLite 和 BoxLite SDK；临时 Jenkins 构建已通过原生门禁和脱敏运行报告。

第二次人工系统切换遇到旧 Tunnel 在三十秒退出截止处释放端口的竞态，已恢复原服务；退出等待已修正为同时验证原 PID 和监听释放，最多九十秒，不强杀进程。[实际退出诊断](../artifacts/jenkins-system-cutover-tunnel-exit-diagnosis.json)、[源实现验证](../artifacts/jenkins-system-cutover-source-verification.json)及 [实际只读 preflight](../artifacts/jenkins-system-cutover-live-preflight.json)记录了修正边界。正式系统服务状态、完整项目 Jenkins build、线上 SHA 和 Release digest 在切换后补充实际证据；源回归和离线编译不是正式发布成功。
