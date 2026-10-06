# Mac mini Docker 与 Jenkins 构建发布

Mac mini 负责三个仓库的发现、测试、构建、打包和上传。前端在 Linux AMD64 构建为 Vercel production prebuilt，再由 Jenkins 上传并提升至 `agent.douglasdong.com`。API 与 BoxLite 使用 Linux ARM64 镜像，Cloudflare Tunnel 将 `agent-api.douglasdong.com` 转发到同一 Linux VM 内的 API。Jenkins 保存阶段日志、测试报告、镜像标识、校验和、备份与 GitHub Release 记录。

## 运行结构

| 专属 Colima profile | Docker 服务 | 职责 |
| --- | --- | --- |
| `agent-platform-jenkins` | Jenkins controller | 持久 Home、70 个锁定插件、零内置 executor、本机 `8080` 管理入口 |
| `agent-platform-build` | Linux ARM64 CI、Linux AMD64 Web CI | 无生产凭据和 Docker socket；AMD64 使用 Rosetta；执行后端、文档、跨仓浏览器和前端门禁 |
| `agent-platform-runtime` | API/BoxLite、cloudflared、CoreDNS、可信 Linux deploy agent | VZ ARM64 nested virtualization，6 CPU/16 GiB；独立生产数据、私有发布凭据、Docker 管理与发布 |

三个 profile 都不挂载 Mac 用户目录、不转发 SSH agent，也不改变用户默认 Docker context。API 内嵌 BoxLite SDK `0.9.7`，任务继续运行在微虚拟机里。API 容器不挂载 Docker socket；可信 deploy agent 可以管理这一个专属 runtime daemon。普通 CI 的 daemon、卷和凭据与它分离。

API 与 Tunnel 使用 runtime VM 的 host network，API 仍只监听该 VM 的 `127.0.0.1:3101`。这保留 `API_TRUST_PROXY=cloudflare-loopback` 的真实 loopback peer 约束、精确 HTTPS Origin、访问口令与 Secure cookie。这里的 host network 指 Linux VM；不是 Mac 的网络 namespace。Tunnel token 通过私有文件卷传入，不出现在命令参数、日志或镜像内。

同一 VM 的 CoreDNS 容器只在 `127.0.0.2:53`（避开 Colima 内置 DNS） 提供 DNS，使用 Cloudflare DoH（HTTPS 443、校验证书和 server name）；API、Tunnel 与可信 deploy agent 使用它解析外部域名。它不挂载 Mac 目录或生产凭据，配置烘焙在固定镜像中。这样避开宿主代理对普通 UDP/TCP DNS 的 fake-IP 回答，而无需改动 Mac 全局 DNS。Tunnel 使用标准 `auto` 传输；不固定 Cloudflare edge IP。CoreDNS 的真实 DNS 查询、健康检查、旋转日志和重启策略由 Docker 管理，Jenkins 归档状态。[CoreDNS DoH 配置](https://coredns.io/plugins/forward/)。

API 使用 `/data` 持久卷与只读 `/run/secrets/runtime.env`，限定 6 CPU/14 GiB、严格 CPU 登记、旋转日志和健康检查。Linux 容量探针会读取 cgroup v1/v2 的有效 CPU/RAM 上限。容器内必须显式 `SANDBOX_DEFAULT_PROVIDER=boxlite`；一般 Linux 裸运行仍保留 AIO 默认行为。

## BoxLite 镜像与验收

[Dockerfile.api](../deploy/containers/Dockerfile.api) 在 glibc 2.28 的 Rocky Linux 8 中编译 SQLite，使用 Node `22.23.3`。官方 BoxLite ARM64 companion runtime 的固件需要显式声明 `libc.so.6`；构建严格核对下载和修补前后 SHA256，并设置 `BOXLITE_RUNTIME_DIR`，避免 SDK 覆盖该运行时。证书路径按 BoxLite 的绑定规则处理。

已独立实际验证：KVM、两个 VM、PTY、共享文件、SDK 停止恢复、Docker 容器重建后的磁盘恢复。完整 API 验收还覆盖默认 BoxLite 任务启动、真实终端 WebSocket、独立 guest kernel、持久磁盘、配额不足时的 429 与零额外记录、任务与项目清理。证据：[基础兼容](../artifacts/boxlite-docker-compatibility-verification.json)、[完整 API](../artifacts/api-boxlite-container-acceptance.json)。

当前实际通过的 BoxLite 容器策略为 `privileged` 加 `/dev/kvm`。降低权限的第一种尝试被 bwrap 的 proc mount 拒绝，尚未证明最小权限配置。因此生产 runtime 使用独立 VM，并保持无 Mac mount；不能把这次验收描述为最小权限审计。[BoxLite Docker 说明](https://github.com/boxlite-ai/boxlite/blob/main/docs/guides/deployment-patterns.md#docker-container-deployment)、[Colima nested virtualization](https://colima.run/docs/configuration/#nested-virtualization)。

## Jenkins 的完整 CI/CD

所有活动作业使用 Linux agent。管理模板来自固定安装的公开工具；仓库 checkout 作为已钉住的构建输入，不提供发布凭据给 PR 脚本。

| 作业 | 功能 |
| --- | --- |
| `agent-platform-native-ci` | Linux ARM64 后端全部既有门禁、实际 SQLite SQL 与 BoxLite NAPI 加载 |
| `agent-platform-web` | 静态检查、验收、Storybook、Linux AMD64 production prebuilt、跨仓浏览器子作业 |
| `agent-platform-contract` | 三仓精确 SHA、Linux 部署回归、文档与浏览器→Nest→SQLite 验收 |
| `agent-platform-api` | 完整后端 CI 子作业、构建 API/BoxLite 镜像、本机打包、空闲检查、备份、替换、恢复与运行报告 |
| `agent-platform-release` | 三仓统一计划，复核子作业 SUCCESS，上传 Vercel，打包并上传 GitHub Release |
| `agent-platform-ci-discovery` | 定时发现主分支、PR 与发布版本；GitHub App 写聚合状态；触发统一发布 |
| `agent-platform-service-monitor` | 每五分钟归档 Docker 状态、健康、镜像、重启次数和脱敏日志 |
| `agent-platform-mutation` | Linux 隔离节点执行 nightly/full 或 PR changed 的非阻断 mutation |
| `agent-platform-sandbox-images` | 本机专属 Docker 构建两档、两架构 guest image，并验证 GHCR 匿名 digest |

后端镜像和收据绑定 `ROOT_SHA` 与 `API_SHA`；不可变目录为 `<ROOT_SHA>-<API_SHA>`。相同组合复用已验证的镜像与打包字节，不覆盖旧缓存。Docker 29 的 image ID 可能是 OCI index digest，包验证会核对 index→manifest→config 的实际链和 Linux ARM64，不能把 config digest 误当 image ID。

生产替换先严格检查任务、沙箱、自动化、资源、克隆、清理、授权与正在执行的 HTTP。维护屏障生效后复查，再停止 API、备份一致的持久卷并替换。纯浏览器连接可在重启后恢复；它不会让零任务的服务永远无法发布。数据库 schema fingerprint 改变时停止自动切换，返回迁移审阅状态。失败恢复保留明确 checkpoint；没有成功收据就不会继续前端与 GitHub 发布。

维护屏障只在已知候选容器的 ID、镜像、挂载与版本标签保持一致，且 API readiness 和 Docker `healthy` 同时通过后解除。HTTP 已可用但 Docker 仍 `starting` 时继续等待；失败或超时走原恢复流程，不能把这种状态当作发布成功。

Jenkins 地址：<http://127.0.0.1:8080/>。每次发布作业的 `Service status and logs` 页面、Console Output、Artifacts 和 fingerprint 可追溯结果。Docker 的 restart policy 管理进程退出恢复；健康检查和监控记录失健康状态。容器日志为旋转的 `json-file`，报告按私有口令与 token 脱敏。

## 公网 Jenkins 与 Cloudflare Zero Trust

公网管理入口为 <https://jenkins.douglasdong.com/>，通过已有 `agent-platform-api` Tunnel 转发到 `http://192.168.5.2:8080`。该地址是 runtime VM 访问 Mac 上 Jenkins loopback 转发的固定网关；runtime VM 自己的 `127.0.0.1:8080` 不是 Jenkins。原有 `agent-api.douglasdong.com` 路由与最终 `http_status:404` 保留。

整域由独立 Cloudflare Access 自托管应用保护，使用 `jenkins-owner-only` 精确邮箱白名单、One-time PIN 和六小时会话。先建立 Access 应用与策略，再发布 Tunnel 路由和 DNS；源站路由同时启用 `access.required`，绑定既有团队与该应用的 AUD，在转发前验证 Access JWT。管理员在 Cloudflare One 的 Access 应用和策略中维护邮箱白名单。通过 Access 后仍需 Jenkins 原有账号登录，Jenkins 的匿名限制与 CSRF 保持生效。[Access 配置](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)、[Tunnel JWT 校验](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/origin-parameters/)。

生产 controller 显式设置 `AGENT_PLATFORM_JENKINS_URL=https://jenkins.douglasdong.com/`，让页面、构建和新 GitHub 状态链接使用公网地址。它仍只发布 Mac loopback 8080。三个 Linux agent 的 `JENKINS_URL` 保持 `http://host.lima.internal:8080/`，内部认证、API 和产物下载继续走固定本地通道，不依赖浏览器 Access 会话。构建校验只接受固定公网地址和历史本地地址对应的同一作业、构建号与精确提交，历史收据保持可验证。lab 仍只使用本地 18080。

## 完全在本机打包并上传

统一发布使用三仓精确 SHA。API 下载包为 `agent-platform-api-linux-arm64.tgz`，包含 Docker-save 镜像、`release.json` 和说明；前端有 production prebuilt、源码和 Storybook；另有三仓源码包、发布清单与 `SHA256SUMS`。数据库、口令、私钥、token 和生产工作区不进入下载包。

Vercel 使用 `--prebuilt` 上传已验收字节，不再次远端构建。Jenkins 验证 production 环境、项目归属、部署 READY、别名指向以及公开 API origin。GitHub Release 先以 draft 上传所有固定资产并逐个校验 SHA256，再正式发布。不可替换既有版本标签或资产。[GitHub Releases](https://github.com/Xeonice/cloud-agent-platform-docs/releases)。

Vercel 项目名为 `agent-platform`，GitHub 前端仓库名为 `agent-platform-web`；生成的部署地址使用前者。校验同时绑定实际项目 ID、team、三仓 SHA、构建号与部署状态，域名提升复用同一已验收部署。

旧 GitHub Actions 的工作流只有在三个新的真实 Jenkins 聚合构建成功后才禁用。main 的必需状态检查绑定专属 Jenkins App `5204009`，保留 strict、reviews 和管理员规则。App 的安装只限三仓；不接受任意 App 来源。管理切换工具为 [ci-cutover.mjs](../deploy/jenkins/ci-cutover.mjs)。

## Mac 自动启动

三个标准系统 LaunchDaemon 已安装并实际核对 owner `root`、权限 `0644`、`RunAtLoad` 和固定参数，执行用户为 `douglasdong`。它们只启动专属 Colima Docker 引擎；Jenkins、构建节点、API 和 Tunnel 的生命周期都属于 Docker。原生 Java/Node 应用守护进程不再作为新服务的启动入口。

一次性管理员安装完成后，日常初始化、构建和发布无需在 Terminal 手工运行应用。命令和审阅校验见 [开机自启文档](../artifacts/container-boot-commands.md)，安装证据见 [系统启动项](../artifacts/container-system-boot-verification.json)。配置中的 `StartInterval` 会重试引擎启动，容器使用 `restart: unless-stopped`。整台 Mac 的断电冷启动与 profile 重启是不同验收，证据会分别标识。

2026-10-06 已分别实际停止并验证三个 profile 由系统启动项自动拉起；Jenkins 历史、配置和三个 Linux 节点自动恢复，未手工运行 `colima start`、容器启动或初始化命令。测试期间生产域名继续由独立 runtime 服务提供。整机断电冷启动尚未执行。

早期 `system-review-20261007*` 与四个宿主服务 review 已退休，不要再执行。旧 native 源码保留用于历史恢复；Linux 回归会明确列出仅支持实际 Darwin 原生包的退休测试，不伪造 OS 或 native 验收。

## 生产数据迁移

SQLite 使用 WAL；只复制 `.db` 会漏数据。[migrate-data.mjs](../deploy/containers/migrate-data.mjs) 使用 SQLite online backup，验证表行数、基线摘要、权限和路径映射，再向空 named volume 导入，重复或非空卷导入被拒绝。环境文件单独转到私有 secrets 卷，数据卷不含发布凭据。

原生 API 没有用户任务，但 BoxLite 内部有预热授权 helper。该 helper 不在任务表里，迁移会在原 API 退出后停止它并保留原 home；目标 Linux API 按需重建。不能把原 BoxLite home 的数据库和 macOS 绝对路径直接搬到 Linux。一般用户 VM 的跨平台磁盘应使用官方导出/导入；独立 Darwin ARM64→Linux ARM64 roundtrip 已验证 marker、PTY、停止恢复和第二个容器重建。证据：[平台数据恢复](../artifacts/native-linux-data-migration-rehearsal.json)、[BoxLite 跨平台恢复](../artifacts/boxlite-darwin-linux-portability-rehearsal.json)。

切换前生成最终备份、保持单一生产数据 owner，验证公开健康、原项目与终端。旧数据目录与原 native 发布均保留，不共享给第二个运行时，也不恢复已退休的旧轮询器。

初次接管已于 2026-10-06 完成：API 与专属 Tunnel 在 Docker 中运行，原项目及基线、口令与会话配置保留。已验证公开 HTTPS 健康、未登录 401、Secure/HttpOnly 会话 cookie、精确 Origin 和拒绝外来 Origin，以及生产 BoxLite 的真实 KVM 虚拟机。失败尝试的完整数据、锁、收据和日志均归档；原 native 启动项保持停用。

## 当前实施证据

[源码与迁移状态](../artifacts/jenkins-source-readiness.json) 记录各阶段实际结果。独立手工烟测与正式 Jenkins 构建是两类证据；手工测试不会被伪装成可发布的 Jenkins SUCCESS。实际服务状态以 Jenkins 运行报告、Docker inspect 和最后一条发布收据为准。
