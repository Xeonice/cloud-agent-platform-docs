# 运维与发布入口

- **读者**：第一次接触本项目部署、发版或运维的开发者、发版人、运维人员与 AI agent。
- **用途与边界**：给出红线、按任务找文档的路由、三种部署形态的分流和术语表；不含操作步骤，也不含端口、卷、凭据等具体数值。
- **权威范围**：红线清单、部署形态对照与术语定义只在本文写全；事实数值以 [参考表](./参考表.md) 为准。
- **适用基线**：v0.3.6（主仓 `7eb7176`）起；带日期的状态与待办只记在 [运维记录](./运维记录.md)。

## 1. 先读这六条

主仓与 `api`、`web` 两个子仓都是公开仓库，文档与提交里不能出现任何秘密值。下面六条中任何一条被违反，都会直接影响生产。

| #   | 红线                                                                                                          | 原因                                                                                    | 详见                              |
| --- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------- |
| 1   | 合并任一仓的 `main`，2 分钟内就会自动排队生产发布；合并主仓（包括纯文档）一定会替换一次 API                     | 发布单位是三仓 `main` 的 SHA 组合；API 镜像身份含主仓 SHA，替换要等生产空闲，中断约 1.5 分钟 | [发版手册](./发版手册.md) §1–§3   |
| 2   | Mac 上裸 `docker` 连的是 OrbStack（开发用），不是生产；操作生产一律用 `dk <profile>`                            | 默认 docker context 是 `orbstack`；三台 VM 各有独立 socket                               | [参考表](./参考表.md) §0          |
| 3   | 生产 API 不归 compose 管：禁止对 `agent-platform-runtime` 项目不带服务名执行 `up`，也禁止 `up api`              | API 由发布工具带维护屏障、备份与回滚替换；compose 起的容器没有版本标签，之后的发布会失败 | [参考表](./参考表.md) §4          |
| 4   | 禁止在任何 VM 上执行 prune 类命令（清构建缓存的 `builder prune` 除外），尤其 `docker volume prune -a`、`docker image prune` 与 `docker system prune` | `volume prune -a` 删掉平时没有挂载的备份卷；另两条删掉回退要用的无标签旧 deploy 镜像，加 `-a` 还会删掉发布缓存引用的 API 镜像 | [运维手册](./运维手册.md) §5      |
| 5   | quietDown 之前，先停用 `agent-platform-release`、`agent-platform-ci-discovery` 与 `agent-platform-service-monitor`，并等全部作业空闲 | 父作业等待子作业完成；quietDown 期间子作业不会启动，父作业会挂到超时（release 为 4 小时） | [运维手册](./运维手册.md) §0      |
| 6   | `sync-pipelines`、`refresh` 与 compose 只在干净的 `main` 克隆里执行                                            | `sync-pipelines` 把当前目录的模板直接写进生产 Jenkins；`refresh` 会重新启用全部作业      | [发版手册](./发版手册.md) §4–§5   |

## 2. 我要做什么 → 看哪里

| 任务                                 | 先看                                                     | 再看                                            |
| ------------------------------------ | -------------------------------------------------------- | ----------------------------------------------- |
| 本地起服务、配端口和 Node 版本       | [CONTRIBUTING](../../CONTRIBUTING.md) §1–§2              | 本文 §4                                         |
| 提 PR、看 CI 结果和日志              | [CONTRIBUTING](../../CONTRIBUTING.md) §4                 | [参考表](./参考表.md) §1–§2                     |
| 合并后确认上线                       | [发版手册](./发版手册.md) §1、§6                         | [参考表](./参考表.md) §10                       |
| 跨仓改动（API、Web、主仓一起）       | [发版手册](./发版手册.md) §3                             | [CONTRIBUTING](../../CONTRIBUTING.md) §3        |
| 改了 `deploy/` 下的文件              | [发版手册](./发版手册.md) §2                             | [发版手册](./发版手册.md) §4                    |
| 只改 Jenkins 模板（`*.groovy`）      | [发版手册](./发版手册.md) §5                             | [参考表](./参考表.md) §1                        |
| 发布卡住（`waiting-idle` 等）        | [发版手册](./发版手册.md) §7                             | [参考表](./参考表.md) §10                       |
| 含数据库迁移的发版                   | [发版手册](./发版手册.md) §8                             | [运维记录](./运维记录.md) §3                    |
| 回滚到上一个版本                     | [发版手册](./发版手册.md) §9                             | [灾备与重建](./灾备与重建.md) §3                |
| 发布新的沙箱镜像                     | [发版手册](./发版手册.md) §10                            | [参考表](./参考表.md) §2                        |
| 高风险改动的隔离回归（BoxLite、helper、容器参数） | [发版手册](./发版手册.md) §12               | [BoxLite 验证工具](../../deploy/containers/boxlite-proof/README.md) |
| 进入或退出维护（quietDown）          | [运维手册](./运维手册.md) §0                             | [参考表](./参考表.md) §0                        |
| 版本号、GitHub Release、CHANGELOG    | [发版手册](./发版手册.md) §11                            | [CHANGELOG](../../CHANGELOG.md)                 |
| 服务不可用                           | [运维手册](./运维手册.md) §8                             | [参考表](./参考表.md) §3                        |
| 重启或停机一台 VM                    | [运维手册](./运维手册.md) §3                             | [生产架构](./生产架构.md) §7                    |
| 修改 Lima override                   | [运维手册](./运维手册.md) §4                             | [参考表](./参考表.md) §8                        |
| 磁盘快满、清理空间                   | [运维手册](./运维手册.md) §5                             | [参考表](./参考表.md) §5                        |
| 内存紧张、修改 VM 规格               | [运维手册](./运维手册.md) §6                             | [参考表](./参考表.md) §8                        |
| 轮换凭据                             | [运维手册](./运维手册.md) §7                             | [参考表](./参考表.md) §6                        |
| 只读诊断（helper、受保护接口）       | [运维手册](./运维手册.md) §9                             | [参考表](./参考表.md) §10                       |
| 备份与恢复                           | [灾备与重建](./灾备与重建.md) §2–§4                      | [参考表](./参考表.md) §5                        |
| 新机器从零重建                       | [灾备与重建](./灾备与重建.md) §5–§6                      | [参考表](./参考表.md) §7–§8                     |
| 换运维账号、宿主自检（doctor）、宿主路径从哪来 | [参考表](./参考表.md) §12                        | [运维手册](./运维手册.md) §0                    |
| 查端口、卷、作业参数或错误原文       | [参考表](./参考表.md)                                    | —                                               |
| 查历史状态、待办与演练结果           | [运维记录](./运维记录.md)                                | —                                               |

## 3. 第一次接手的阅读路径

按下面顺序读，约 40 分钟。读完应能回答：合并后会发生什么、怎么连到三台 VM、发布卡住先看哪里。

1. 本文 §1 与 §6（红线和术语，5 分钟）。
2. [生产架构](./生产架构.md) §1–§2：拓扑与组件（10 分钟）。
3. [参考表](./参考表.md) §0–§4：命令模板、作业、发现规则、端口与容器栈（10 分钟）。
4. [运维手册](./运维手册.md) §0：操作前提（5 分钟）。
5. [发版手册](./发版手册.md) §1–§3：发布怎么触发、改动怎么生效、跨仓发版（10 分钟）。
6. [运维记录](./运维记录.md) §3：当前未关闭的待办与风险。

## 4. 三种部署形态

本仓库描述三种形态，它们的配置互不通用。照着一种形态的文档去配另一种，是新人最常见的错误。

| 维度         | 本地开发                                              | 自托管 compose                                          | 本项目生产（Mac mini）                                      |
| ------------ | ----------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------- |
| 用途         | 改代码、调试                                          | 产品的单机私有化部署形态                                | 本项目的线上服务                                            |
| 权威文档     | [CONTRIBUTING](../../CONTRIBUTING.md)                 | [11 部署形态与扩展预留](../shared/11-部署与扩展预留.md) | 本目录                                                      |
| 启动方式     | 在 `api`、`web` 目录分别用 pnpm 启动                  | 根目录 `docker-compose.yml`（包含 `api/docker-compose.yml`） | 合并 `main` 后由 Jenkins 统一发布到三台 Colima VM       |
| API 镜像     | 不用镜像                                              | `api/Dockerfile`（`node:22-bookworm-slim`）             | `deploy/containers/Dockerfile.api`（Rocky Linux 8）         |
| 沙箱 provider | 留空自动选择：Mac 为 `boxlite`，Linux 为 `aio`       | `aio`（经 docker-socket-proxy）                         | `boxlite`（已写进镜像）                                     |
| 默认沙箱镜像 | 留空，平台按 provider 选内置镜像                       | 留空，同左                                              | 镜像内设为 `ghcr.io/xeonice/agent-platform-boxlite:latest`  |
| 端口         | API 3001，Web 3000                                    | Web `127.0.0.1:3000`；API 不对外发布                    | API 只在 runtime VM 的 `127.0.0.1:3101`，公网经 Tunnel      |
| 前端到 API   | 同源 rewrites，目标为 Next 启动时读入的 `API_ORIGIN`  | 同源 rewrites，`API_ORIGIN` 在构建时读入                | Vercel 前端直连 `agent-api`，API 按 Origin 白名单放行       |
| 数据位置     | `DATA_ROOT`；BoxLite 数据在 `BOXLITE_HOME`            | `${DATA_ROOT:-/srv/agent-platform/data}`，宿主同名挂载  | 卷 `agent-platform-production-data`，挂到 `/data`          |
| 访问口令     | `ACCESS_PASSCODE` 留空时首次启动自动生成，只打印一次  | 同左                                                    | `runtime.env` 显式设置                                      |

注：本地端口与 Node 版本以 CONTRIBUTING 为准；API 代码默认端口是 3000，本地要显式设 `PORT=3001`。端口全集见 [参考表](./参考表.md) §3。

## 5. 文档地图与边界

| 文档                               | 读者                   | 权威覆盖（只在这里写全）                                         | 不写什么                         |
| ---------------------------------- | ---------------------- | ---------------------------------------------------------------- | -------------------------------- |
| 本文                               | 所有人                 | 红线、任务路由、部署形态对照、术语                               | 步骤与数值                       |
| [生产架构](./生产架构.md)          | 运维、发版人、评审     | 组件清单、构建位置、信任边界、隔离与暴露面、自动启动链           | 操作步骤                         |
| [发版手册](./发版手册.md)          | 发版人、合并 PR 的人   | 合并即发布、改动生效对照、跨仓 SOP、agent 升级、卡住处置、回滚、版本规则 | 宿主维护                 |
| [运维手册](./运维手册.md)          | 负责 Mac mini 的运维   | 进入与退出维护、VM 操作、override 修改、容量清理、凭据轮换、排查树、只读诊断 | 发布流程             |
| [灾备与重建](./灾备与重建.md)      | 执行重建或灾备的管理员 | 备份清单、恢复步骤、重建顺序、外部服务核对、冷启动演练           | 日常发布                         |
| [参考表](./参考表.md)              | 所有人（查表）         | 作业、发现规则、端口、容器栈、卷、凭据、env 键、宿主与 VM、错误原文、遗留、宿主布局与 doctor | 原因解释与步骤 |
| [运维记录](./运维记录.md)          | 维护者                 | 运维决策、一次性上线、待办与风险、演练结果                       | 现行规则                         |

本目录之外的相关文档：

| 文档                                                                         | 分工                                                                  |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| [CONTRIBUTING](../../CONTRIBUTING.md)                                        | 本地开发、三仓与子模块、CI 门禁对照、合并的后果；本地开发的唯一权威 |
| [11 部署形态与扩展预留](../shared/11-部署与扩展预留.md)                      | 产品的自托管 compose 形态与鉴权、多节点等扩展预留；不覆盖本项目生产   |
| [09 工程化规范](../shared/09-工程化规范.md)                                  | lint、hooks 与 `docs:check` 的定义；CI 细节链接到本目录               |
| [10 §6.6.2 部署状态契约](../shared/10-接口契约与类型共享.md)                 | `/api/deployment/status` 的字段与阻塞项口径                          |
| [BoxLite 验证工具](../../deploy/containers/boxlite-proof/README.md)          | BoxLite smoke 与 API 隔离回归（api-smoke）的步骤                      |
| [LIVE-RUN-FINDINGS](../LIVE-RUN-FINDINGS.md)                                 | 仍能解释现行约束的踩坑史                                              |

<a id="术语表"></a>

## 6. 术语表

| 术语                    | 含义                                                                                                    | 详见                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 统一发布                | 作业 `agent-platform-release`：把一个三仓组合整体发布，依次完成 Web 构建、跨仓验收、API 替换、Vercel 上传与 GitHub Release。 | [生产架构](./生产架构.md) §4                |
| 三仓组合                | 主仓、API、Web 三个 `main` head 的 SHA 组合，是发布的单位；它的 sha256 即 `REQUEST_KEY`。                 | [参考表](./参考表.md) §2                                     |
| 发现作业                | 作业 `agent-platform-ci-discovery`：每 2 分钟读取三仓引用与 PR，排 CI、回写 GitHub 状态，组合变化时排统一发布。 | [参考表](./参考表.md) §2                            |
| 可信 deploy agent       | runtime VM 上的 Jenkins agent `linux-deploy`（容器 `agent-platform-linux-deploy`），持有发布凭据与 runtime 的 Docker socket。 | [生产架构](./生产架构.md) §5                  |
| CI agent                | build VM 上的 `linux-ci`（ARM64）与 `linux-web-amd64`（AMD64），没有生产凭据和 Docker socket。          | [生产架构](./生产架构.md) §2                                 |
| controller 模式         | controller 的 `AGENT_PLATFORM_CONTROLLER_MODE`：`lab` 为空 Home 试验，`migration` 每次启动停用全部作业，`active` 为生产。 | [参考表](./参考表.md) §7                          |
| executor                | Jenkins 的执行槽。controller 为 0 个，三个 agent 各 1 个。                                               | [参考表](./参考表.md) §1                                     |
| 停用作业                | `manage.mjs disable <作业>`，恢复用 `enable`；Jenkins 中文界面称“禁用”。停用 release 期间不发布，发现作业因 409 变红属预期。 | [参考表](./参考表.md) §0、[发版手册](./发版手册.md) §3 |
| quietDown               | Jenkins 的“准备关闭”状态：不再启动新构建（包括子作业），正在运行的继续。用 `manage.mjs quiet-down` 进入、`cancel-quiet-down` 解除。 | [运维手册](./运维手册.md) §0                   |
| 生产空闲                | 发布工具允许替换 API 的条件：API 就绪，七类阻塞计数、在途 HTTP 与授权会话都为 0。浏览器 WebSocket 不计；资源名额若全属经核验的已停止任务，可以豁免。 | [10 §6.6.2](../shared/10-接口契约与类型共享.md) |
| 维护屏障                | 替换 API 时在数据卷写入的 `/data/deployment-drain`；存在时 API 进入 draining，拒绝新的业务写入。          | [生产架构](./生产架构.md) §4                                 |
| 收据                    | API 构建通过后写在 deploy-state 卷 `jenkins-receipts/` 的不可变记录，绑定两个 SHA、构建号与镜像 ID。     | [参考表](./参考表.md) §5                                     |
| checkpoint              | 替换过程中写在 `deployment.lock/checkpoint.json` 的进度；失败到 `operator-recovery-required` 时与锁一起保留。 | [发版手册](./发版手册.md) §7                          |
| 发布状态                | 发布工具 `deploy` 的结果：`deployed`、`current`、`waiting-idle`、`waiting-migration-review`、`waiting-initial-adoption`、`superseded`、`rolled-back`。 | [参考表](./参考表.md) §10        |
| 停止名额                | 已停止的任务保留 VM 磁盘与资源名额；发布前的探针要证明它们确实已停止，否则判为忙。                     | [运维手册](./运维手册.md) §9                                 |
| auth helper             | 生产 API 常驻的一台 BoxLite 微虚拟机，负责账号登录与凭证刷新。名为 `platform-boxlite-<哈希>-auth-helper`，哈希取字符串 `/data/platform.db` 的 sha256 前 16 位。 | [11 §1.1](../shared/11-部署与扩展预留.md) |
| CONTAINER_INPUTS        | 构建 API 镜像时从钉住的主仓复制的 5 个文件清单（`deploy/containers/api-context.mjs`）；清单本身打在 deploy agent 镜像里。 | [发版手册](./发版手册.md) §2              |
| gitlink                 | 主仓记录的 `api`、`web` 子模块指针。发布和 PR 的 CI 都不读它，只有每天 03:00 的 contract 检查读取。     | [参考表](./参考表.md) §2                                     |
| 干净 main 克隆          | 与 `origin/main` 完全一致、没有未提交改动的独立克隆，文中记作 `$SRC`；约定为私有目录下的 `upgrade-src-<主仓 SHA 前 7 位>`，由维护者手动克隆，`main` 前进后重新准备。只用来执行，不在里面改文件或提交。 | [发版手册](./发版手册.md) §0                 |
| 工作克隆                | 日常开发用的主仓克隆（可以有功能分支与未提交改动）；改代码、更新子模块指针、开 PR 都在这里做，不用来执行 `sync-pipelines`、`refresh` 与升级脚本。 | [CONTRIBUTING](../../CONTRIBUTING.md) §3        |
| profile                 | 一台 Colima VM：`agent-platform-jenkins`、`agent-platform-build`、`agent-platform-runtime`。            | [参考表](./参考表.md) §8                                     |
| hostagent               | Lima 在 Mac 上为每台 VM 运行的进程，负责端口转发；只在 VM 启动时读取 Lima override。                    | [参考表](./参考表.md) §8                                     |
| Lima override           | `$HOME/.colima/_lima/_config/override.yaml`，对全部 Colima VM 生效的端口转发规则。                      | [生产架构](./生产架构.md) §6                                 |
| 伪回环                  | hostagent 为转发特权端口（如 53）而在 Mac 上监听 `*:53` 的转发器，局域网可达；已由 override 禁止。       | [生产架构](./生产架构.md) §6                                 |
| Access                  | Cloudflare Zero Trust Access，保护 `jenkins.douglasdong.com`，用邮箱一次性验证码登录。                  | [参考表](./参考表.md) §9                                     |
| Tunnel                  | 远程托管的 cloudflared 隧道，把 `agent-api` 与 `jenkins` 两个主机名接到 runtime VM；路由在 Cloudflare 控制台维护。 | [参考表](./参考表.md) §3                             |
| 运维账号                | 在 Mac 上执行运维工具的普通账号：系统账户库报告的运行账号（不是 root，UID ≥ 501，名称不以 `_` 开头），拥有私有目录与三个 Colima socket，LaunchDaemon 也以它运行。工具从它推导 HOME 与全部宿主路径，不读环境变量。 | [参考表](./参考表.md) §12 |
| 宿主布局                | `deploy/containers/host-layout.mjs` 由运维账号推导出的 Mac 宿主值：私有路径、socket、可执行文件位置、LaunchDaemon Label；`print` 查看，`doctor` 自检。 | [参考表](./参考表.md) §12 |
| 私有目录                | 运维账号 HOME 下的 `.local/share/agent-platform-jenkins-tools`（0700，文中写作 `$HOME/…` 或 `$P`），存放 Mac 侧凭据副本、compose env 文件与私有 Docker 配置。 | [参考表](./参考表.md) §6 |
| 私有卷                  | runtime VM 上只挂给 deploy agent 的 `agent-platform-linux-deploy-private` 与 `agent-platform-linux-deploy-state`。 | [参考表](./参考表.md) §5                           |
| 私有笔记                | 由维护者保存、不进仓库的运维信息：Cloudflare 团队 ID 与 AUD、Access 白名单成员、凭据实际类型与到期日、离机备份位置、宿主安全设置与其他服务清单。目前尚未整理成文（运维记录 T32），需要时向维护者索取。 | [运维记录](./运维记录.md) §3                        |
| 播种                    | API 启动时把内置沙箱镜像登记进数据库；按镜像名判重，所以新发布的 `:latest` 不会自动替换已登记的镜像。    | [发版手册](./发版手册.md) §10                                |
| `dk`、`$NODE22`         | 命令约定：`dk <profile>` 连接指定 VM 的 Docker，`$NODE22` 指向 Node 22（推荐 22.23.3）。                | [参考表](./参考表.md) §0                                     |

## 7. 维护约定

- 改完文档后，在仓库根目录运行 `"$NODE22" scripts/docs-check.mjs`，全部检查须通过；改了 `deploy/` 代码还要运行 `pnpm deploy:test`。
- 新的运维文档放在本目录，用中文文件名、不加编号，并在 §5 登记链接（`docs:check` 的 A3 要求）。
- 每条规则只在一处写全，其他地方写一句话加链接；数值只写在参考表。
- 带日期的状态、一次性上线计划和演练结果只写进运维记录；其他文档写自查命令。
- 凭据只写名称、路径、属主与权限、读取方和轮换入口。Cloudflare 团队 ID 与 AUD、Access 白名单成员、宿主安全设置现状、Mac 上其他服务、token 的实际类型都只放私有笔记。
- 合并主仓的任何 PR（包括纯文档）都会触发一次生产发布；文档 PR 按 [发版手册](./发版手册.md) §3 合并。
