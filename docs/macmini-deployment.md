# Mac mini Docker 与 Jenkins 构建发布

Mac mini 负责三个仓库的发现、测试、构建、打包和上传。生产来源固定为三个仓库各自的 `main`；前端在 Linux AMD64 构建为 Vercel production prebuilt，再由 Jenkins 上传并提升至 `agent.douglasdong.com`。API 与 BoxLite 使用 Linux ARM64 镜像，Cloudflare Tunnel 将 `agent-api.douglasdong.com` 转发到同一 Linux VM 内的 API。Jenkins 保存阶段日志、测试报告、镜像标识、校验和、备份与 GitHub Release 记录。

## 运行结构

| 专属 Colima profile      | Docker 服务                                                | 职责                                                                                        |
| ------------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `agent-platform-jenkins` | Jenkins controller                                         | 持久 Home、73 个锁定插件、零内置 executor、本机 `8080` 管理入口                             |
| `agent-platform-build`   | Linux ARM64 CI、Linux AMD64 Web CI                         | 无生产凭据和 Docker socket；AMD64 使用 Rosetta；执行后端、文档、跨仓浏览器和前端门禁        |
| `agent-platform-runtime` | API/BoxLite、cloudflared、CoreDNS、可信 Linux deploy agent | VZ ARM64 nested virtualization，6 CPU/16 GiB；独立生产数据、私有发布凭据、Docker 管理与发布 |

三个 profile 都不挂载 Mac 用户目录、不转发 SSH agent，也不改变用户默认 Docker context。API 内嵌 BoxLite SDK `0.9.7`，任务继续运行在微虚拟机里。API 容器不挂载 Docker socket；可信 deploy agent 可以管理这一个专属 runtime daemon。普通 CI 的 daemon、卷和凭据与它分离。

API 与 Tunnel 使用 runtime VM 的 host network，API 仍只监听该 VM 的 `127.0.0.1:3101`。这保留 `API_TRUST_PROXY=cloudflare-loopback` 的真实 loopback peer 约束、精确 HTTPS Origin、访问口令与 Secure cookie。这里的 host network 指 Linux VM；不是 Mac 的网络 namespace。Tunnel token 通过私有文件卷传入，不出现在命令参数、日志或镜像内。

同一 VM 的 CoreDNS 容器只在 `127.0.0.2:53`（避开 Colima 内置 DNS） 提供 DNS，使用 Cloudflare DoH（HTTPS 443、校验证书和 server name）；API、Tunnel 与可信 deploy agent 使用它解析外部域名。它不挂载 Mac 目录或生产凭据，配置烘焙在固定镜像中。这样避开宿主代理对普通 UDP/TCP DNS 的 fake-IP 回答，而无需改动 Mac 全局 DNS。Tunnel 使用标准 `auto` 传输；不固定 Cloudflare edge IP。CoreDNS 的真实 DNS 查询、健康检查、旋转日志和重启策略由 Docker 管理，Jenkins 归档状态。[CoreDNS DoH 配置](https://coredns.io/plugins/forward/)。

API 使用 `/data` 持久卷与只读 `/run/secrets/runtime.env`，限定 6 CPU/14 GiB、严格 CPU 登记、旋转日志和健康检查。Linux 容量探针会读取 cgroup v1/v2 的有效 CPU/RAM 上限。容器内必须显式 `SANDBOX_DEFAULT_PROVIDER=boxlite`；一般 Linux 裸运行仍保留 AIO 默认行为。

## BoxLite 镜像与验收

[Dockerfile.api](../deploy/containers/Dockerfile.api) 在 glibc 2.28 的 Rocky Linux 8 中编译 SQLite，使用 Node `22.23.3`。官方 BoxLite ARM64 companion runtime 的固件需要显式声明 `libc.so.6`；构建严格核对下载和修补前后 SHA256，并设置 `BOXLITE_RUNTIME_DIR`，避免 SDK 覆盖该运行时。证书路径按 BoxLite 的绑定规则处理。

已独立实际验证：KVM、两个 VM、PTY、共享文件、SDK 停止恢复、Docker 容器重建后的磁盘恢复。完整 API 验收还覆盖默认 BoxLite 任务启动、真实终端 WebSocket、独立 guest kernel、持久磁盘、配额不足时的 429 与零额外记录、任务与项目清理。可重跑的独立验证入口为 [BoxLite smoke](../deploy/containers/boxlite-proof/README.md) 与 [API smoke](../deploy/containers/api-smoke.mjs)；后者只允许使用隔离容器的 `3191` 端口和新数据卷。

当前实际通过的 BoxLite 容器策略为 `privileged` 加 `/dev/kvm`。降低权限的第一种尝试被 bwrap 的 proc mount 拒绝，尚未证明最小权限配置。因此生产 runtime 使用独立 VM，并保持无 Mac mount；不能把这次验收描述为最小权限审计。[BoxLite Docker 说明](https://github.com/boxlite-ai/boxlite/blob/main/docs/guides/deployment-patterns.md#docker-container-deployment)、[Colima nested virtualization](https://colima.run/docs/configuration/#nested-virtualization)。

## Jenkins 的完整 CI/CD

所有活动作业使用 Linux agent。管理模板来自固定安装的公开工具；仓库 checkout 作为已钉住的构建输入，不提供发布凭据给 PR 脚本。

| 作业                             | 功能                                                                                      |
| -------------------------------- | ----------------------------------------------------------------------------------------- |
| `agent-platform-native-ci`       | Linux ARM64 后端全部既有门禁、实际 SQLite SQL 与 BoxLite NAPI 加载                        |
| `agent-platform-web`             | 静态检查、验收、Storybook、Linux AMD64 production prebuilt、跨仓浏览器子作业              |
| `agent-platform-contract`        | 三仓精确 SHA、Linux 部署回归、文档与浏览器→Nest→SQLite 验收                               |
| `agent-platform-api`             | 完整后端 CI 子作业、构建 API/BoxLite 镜像、本机打包、空闲检查、备份、替换、恢复与运行报告 |
| `agent-platform-release`         | 三仓统一计划，复核子作业 SUCCESS，上传 Vercel，打包并上传 GitHub Release                  |
| `agent-platform-ci-discovery`    | 定时发现 `main`、同仓指向 `main` 的 PR 与镜像标签；GitHub App 写聚合状态；触发统一发布    |
| `agent-platform-service-monitor` | 每五分钟归档 Docker 状态、健康、镜像、重启次数和脱敏日志                                  |
| `agent-platform-mutation`        | Linux 隔离节点执行 nightly/full 或 PR changed 的非阻断 mutation                           |
| `agent-platform-sandbox-images`  | 本机专属 Docker 构建两档、两架构 guest image，并验证 GHCR 匿名 digest                     |

发现作业每两分钟读取三仓的分支、标签与 open PR，按下表处理。表外的分支和标签不论名称（含中文、`+` 或以 `_` 开头）都在校验前忽略：不触发构建、不写入发现状态，也不会让发现作业整轮失败。

| 来源                                   | 处理                                                        |
| -------------------------------------- | ----------------------------------------------------------- |
| 三仓 `main`                            | 构建并回写 `jenkins/*`；三仓组合变化时触发统一发布          |
| 同仓、base 为 `main` 的 PR（含 draft） | 构建并回写 `jenkins/*`                                      |
| API 仓 `sandbox-image-v*` 标签         | 首次发现只记录已有标签；之后新增或改指向的标签触发镜像发布  |
| fork PR                                | 不构建、不记录；先把改动推到同仓分支，再开指向 `main` 的 PR |
| 栈式 PR（base 不是 `main`）            | 不构建、不记录；改 base 到 `main` 后按新条目构建            |

API 仓与另外两仓相同：没有 PR 的分支不会触发 `agent-platform-native-ci`，也没有 `jenkins/native-ci` 状态；需要 CI 时开指向 `main` 的 PR（可为 draft）。未经 PR 构建的提交直接推送 `main`，会因缺少必需状态被拒。

不要创建名称以 `/refs/heads/main` 或 `/refs/tags/sandbox-image-v*` 结尾的分支（如 `x/refs/heads/main`）。发现作业会忽略它们，但发布、Web、镜像与 mutation 工具用 `git ls-remote` 按尾部匹配读取 `main` 或镜像标签，会多匹配到这类分支而拒绝执行。

后端镜像和收据绑定 `ROOT_SHA` 与 `API_SHA`；不可变目录为 `<ROOT_SHA>-<API_SHA>`。相同组合复用已验证的镜像与打包字节，不覆盖旧缓存。Docker 29 的 image ID 可能是 OCI index digest，包验证会核对 index→manifest→config 的实际链和 Linux ARM64，不能把 config digest 误当 image ID。

新发布会重新读取三仓 `main`，要求构建提交仍等于这些分支的真实 head。API/Web PR 合并后，主仓必须钉住各自合并后的提交再合并；不要在三仓来源尚未一致时启用新生产工具。历史已签收的分支收据与发布资产保留原字节，只读校验不将它们重新签为 `main`。

生产替换先严格检查任务、沙箱、自动化、资源、克隆、清理、授权与正在执行的 HTTP。维护屏障生效后复查，再停止 API、备份一致的持久卷并替换。纯浏览器连接可在重启后恢复；它不会让零任务的服务永远无法发布。数据库 schema fingerprint 改变时停止自动切换，返回迁移审阅状态。失败恢复保留明确 checkpoint；没有成功收据就不会继续前端与 GitHub 发布。

停止任务会保留 VM 磁盘、工作区和资源名额。只有这些保留登记全部 confirmed、对应沙箱及 BoxLite 实际状态都为 stopped，且只读 SQLite 与真实进程核验一致时，发布工具才将其视为可安全切换。运行、孤儿、未知或无法核验的实例仍阻止发布；持有维护屏障后持续复查，切换不删除登记或数据。新 API 的状态检查不会调用可能隐式启动非运行 VM 的执行指标。

维护屏障只在已知候选容器的 ID、镜像、挂载与版本标签保持一致，且 API readiness 和 Docker `healthy` 同时通过后解除。HTTP 已可用但 Docker 仍 `starting` 时继续等待；失败或超时走原恢复流程，不能把这种状态当作发布成功。

Jenkins 地址：<http://127.0.0.1:8080/>。每次发布作业的 `Service status and logs` 页面、Console Output、Artifacts 和 fingerprint 可追溯结果。`agent-platform-api` 只保留最近 10 次构建的 Artifacts（API 包与运行报告等），更早的会被删除且无法找回；需要留证的构建先设为永久保留（Keep this build forever）。Docker 的 restart policy 管理进程退出恢复；健康检查和监控记录失健康状态。容器日志为旋转的 `json-file`，报告按私有口令与 token 脱敏。

更新可信构建工具时，先等待 Jenkins 作业和 executor 空闲，再用 `prepare-context.mjs ci` 的公开输入重建 ARM64/AMD64 CI 镜像，用 `prepare-deploy-context.mjs` 重建可信 deploy 镜像。核对新镜像 ID 后只替换两个 CI agent 与 deploy agent，保留它们的 named volume；同步管理模板并验证三节点重新在线。该步骤不重启 API、Tunnel、DNS 或 controller；业务 API 的更新仍交由后续正式发布作业执行维护、备份与 readiness 流程。

## 公网 Jenkins 与 Cloudflare Zero Trust

公网管理入口为 <https://jenkins.douglasdong.com/>，通过已有 `agent-platform-api` Tunnel 转发到 `http://192.168.5.2:8080`。该地址是 runtime VM 访问 Mac 上 Jenkins loopback 转发的固定网关；runtime VM 自己的 `127.0.0.1:8080` 不是 Jenkins。原有 `agent-api.douglasdong.com` 路由与最终 `http_status:404` 保留。

整域由独立 Cloudflare Access 自托管应用保护，使用 `jenkins-owner-only` 精确邮箱白名单、One-time PIN 和六小时会话。先建立 Access 应用与策略，再发布 Tunnel 路由和 DNS；源站路由同时启用 `access.required`，绑定既有团队与该应用的 AUD，在转发前验证 Access JWT。管理员在 Cloudflare One 的 Access 应用和策略中维护邮箱白名单。通过 Access 后仍需 Jenkins 原有账号登录，Jenkins 的匿名限制与 CSRF 保持生效。[Access 配置](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)、[Tunnel JWT 校验](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/origin-parameters/)。

生产 controller 显式设置 `AGENT_PLATFORM_JENKINS_URL=https://jenkins.douglasdong.com/`，让页面、构建和新 GitHub 状态链接使用公网地址。它仍只发布 Mac loopback 8080。三个 Linux agent 的 `JENKINS_URL` 保持 `http://host.lima.internal:8080/`，内部认证、API 和产物下载继续走固定本地通道，不依赖浏览器 Access 会话。构建校验只接受固定公网地址和历史本地地址对应的同一作业、构建号与精确提交，历史收据保持可验证。lab 仍只使用本地 18080。

Jenkins 默认使用简体中文 `zh_CN`。镜像锁定 Locale、Chinese (Simplified) Localization 及 Localization Support 插件；启动配置保存 `systemLocale=zh_CN`、`ignoreAcceptLanguage=true` 和 `allowUserPreferences=false`，使浏览器语言、个人偏好和容器重建保持统一的中文界面。原有任务名称与构建输出保留原文。配置保存在持久 Home 的 `locale.xml`。[Locale 插件](https://plugins.jenkins.io/locale/)、[简体中文资源](https://plugins.jenkins.io/localization-zh-cn/)。

## 完全在本机打包并上传

统一发布使用三仓精确 SHA。API 下载包为 `agent-platform-api-linux-arm64.tgz`，包含 Docker-save 镜像、`release.json` 和说明；前端有 production prebuilt、源码和 Storybook；另有三仓源码包、发布清单与 `SHA256SUMS`。数据库、口令、私钥、token 和生产工作区不进入下载包。

Vercel 使用 `--prebuilt` 上传已验收字节，不再次远端构建。Jenkins 验证 production 环境、项目归属、部署 READY、别名指向以及公开 API origin。GitHub Release 先以 draft 上传所有固定资产并逐个校验 SHA256，再正式发布。不可替换既有版本标签或资产。[GitHub Releases](https://github.com/Xeonice/cloud-agent-platform-docs/releases)。

Vercel 项目名为 `agent-platform`，GitHub 前端仓库名为 `agent-platform-web`；生成的部署地址使用前者。校验同时绑定实际项目 ID、team、三仓 SHA、构建号与部署状态，域名提升复用同一已验收部署。

三个仓库的 CI 已由 Jenkins 执行。main 的必需状态检查绑定专属 Jenkins App `5204009`，管理员同样受保护；当前 strict 为 false，未要求 review 审批，必须解决会话。发布工具不修改这些保护规则。App 的安装只限三仓；不接受任意 App 来源。状态认证和本机配置见 [GitHub App 配置](../deploy/jenkins/github-status-app.md)。

## Mac 自动启动

三个标准系统 LaunchDaemon 已安装并实际核对 owner `root`、权限 `0644`、`RunAtLoad` 和固定参数，执行用户为 `douglasdong`。它们只启动专属 Colima Docker 引擎；Jenkins、构建节点、API 和 Tunnel 的生命周期都属于 Docker。原生 Java/Node 应用守护进程不再作为新服务的启动入口。

一次性管理员安装完成后，日常构建和发布无需在 Terminal 手工运行应用。系统启动项的源码入口为 [bootstrap-host.mjs](../deploy/containers/bootstrap-host.mjs)：使用 Node 22 执行 `prepare`，生成私有审阅目录、三个 profile 配置摘要和 plist；核对后，由管理员执行该目录中已审阅的脚本并传入 `apply-system`。它只管理三个固定引擎 label，拒绝变化的 profile 配置和已有不同内容的启动项，不安装原生 API、Tunnel 或 Java 服务。

该工具要求 Mac 账号 `douglasdong`、UID `501`，以及三个已配置好的专属 Colima profile。它不新建 profile，不导入生产数据，也不生成应用凭据。新机器应先准备 profile、固定镜像、external named volume 和私有凭据，再安装启动项；日常发布使用 Jenkins 作业。配置中的 `StartInterval` 会重试引擎启动，容器使用 `restart: unless-stopped`。

2026-10-06 已分别实际停止并验证三个 profile 由系统启动项自动拉起；Jenkins 历史、配置和三个 Linux 节点自动恢复，未手工运行 `colima start`、容器启动或初始化命令。测试期间生产域名继续由独立 runtime 服务提供。整机断电冷启动尚未执行。

## 备份、恢复与回滚

[api-container.mjs](../deploy/containers/api-container.mjs) 保留日常镜像构建、初次接管、部署和监控入口。生产数据只由一个 API 容器使用。替换前先关闭业务写入并等待服务空闲，再停止旧容器，对整个持久 `/data` 卷生成并验证备份；SQLite 的 `.db`、WAL 和相关工作区必须一起保留。私有 runtime 环境、Tunnel 凭据和发布凭据位于独立卷，不进入公开下载包。

候选服务的 Docker 健康、版本、数据库、默认 provider 和预制镜像 readiness 全部通过后，才解除维护屏障并写成功收据。失败时验证备份和旧容器身份，恢复数据并等待原版本健康；恢复无法确认时保留维护屏障与 checkpoint，交由管理员核查，不继续发布。不要删除备份、checkpoint、私有收据或生产 named volume 来绕过阻断。

Jenkins 的配置、用户、主密钥、插件配置与构建历史保存在独立 external Home 卷；controller 镜像替换会复用该卷。需要独立 Home 备份时，应在作业和队列空闲后停止 controller，再完整备份该卷，并将含密钥的归档保存在私有目录。恢复到空的独立卷后先核对原用户、密钥、历史与锁定插件；不要将 Home 挂载给多个同时运行的 controller，也不要把其中的秘密上传为公开构建产物。

回退发现作业前，先禁用 `agent-platform-ci-discovery` 与 `agent-platform-release`，并关闭 fork PR（改由同仓分支重开）：旧规则会自动构建全部 open PR。优先只撤销 PR 过滤、保留固定分支过滤；若整体回退到旧版（按 [`validRef`](../deploy/jenkins/jenkins-ci.mjs) 校验全部分支、构建 API 全部分支），还要先删除或改名三仓中不满足 `validRef` 的分支，否则旧版每轮都会整轮失败。在本仓根目录执行下面的检查，输出为空才能换回：

```sh
for repo in cloud-agent-platform-docs agent-platform-api agent-platform-web; do
  git ls-remote --heads "https://github.com/Xeonice/$repo.git" |
    node --input-type=module -e 'import { readFileSync } from "node:fs"; import { validRef } from "./deploy/jenkins/jenkins-ci.mjs"; for (const line of readFileSync(0, "utf8").split("\n")) { const ref = line.split("\t")[1]; if (ref && !validRef(ref)) console.log(process.argv[1], ref); }' "$repo"
done
```

换回后首轮会构建状态中没有记录或已变化的 API 分支与 PR；等这些构建结束再启用 release，避免发布排在它们之后等待子作业超时。不要删除 `discovery-state.json` 的 `initializedAt` 来跳过补跑，否则期间新推的镜像标签只会被记录、不会发布。

## 当前验证入口

部署源码回归位于 `deploy/jenkins/*.test.mjs` 与 `deploy/containers/*.test.mjs`，Jenkins 跨仓作业会执行同一套测试。跨仓浏览器报告归档自 `e2e-contract/artifacts/execution-report.json`。独立 smoke 与正式 Jenkins 构建分别记录；实际服务状态以 Jenkins 运行报告、Docker inspect 和最后一条发布收据为准。
