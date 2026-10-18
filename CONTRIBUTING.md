# 参与开发

> **读者**：要在本地开发、向三个仓库提交改动的开发者与 AI agent。
> **用途与边界**：本地环境、本地启动、三仓与子模块协作、PR 与 CI、合并的后果、权限、文档放置；不含生产运维（见 [运维入口](docs/ops/README.md)）和实例部署（见 [统一部署形态](docs/shared/11-部署与扩展预留.md)）。
> **权威范围**：本地开发步骤与端口约定、各仓 CI 门禁的本地复现、合并与发版权限、文档放置规则。
> **适用基线**：v0.3.6 / `7eb7176` 起。

## 1. 准备 Node 22 与依赖

| 项       | 要求                                                                                                     |
| -------- | -------------------------------------------------------------------------------------------------------- |
| Node     | 22，建议 22.23.3（与 CI 和生产镜像一致）。根目录 `.nvmrc` 为 `22`，`package.json` 的 `engines` 为 `22.x` |
| pnpm     | 由 corepack 按各仓 `packageManager` 自动选择：api 为 9.12.0，主仓、web、e2e-contract 为 9.15.0           |
| 执行目录 | pnpm 命令在各仓目录内执行。在根目录用 `pnpm --dir api` 会用成主仓的 9.15.0                               |

不支持的 Node 版本：

- **Node 20**：`pnpm deploy:test` 的部署测试导入 `node:sqlite`，Node 20 没有这个内置模块。
- **Node 24**：CI 与生产只在 22 上验证。本机曾在 Node 24 下记录到 API 运行中崩溃（exit 134，原生模块断言失败），最小用例未能复现；遇到无故 exit 134 先查 Node 版本。

```sh
# 本地，任意目录
git clone --recurse-submodules https://github.com/Xeonice/cloud-agent-platform-docs.git
cd cloud-agent-platform-docs
fnm use                # 或 nvm use，读取 .nvmrc；之后 node --version 应为 v22.x
corepack enable        # 不想写系统目录时：corepack enable --install-directory ~/.local/bin
(cd api && pnpm install --frozen-lockfile)
(cd web && pnpm install --frozen-lockfile)
```

切换过 Node 版本后，原生模块（better-sqlite3、BoxLite 绑定等）要重装，否则启动报 `was compiled against a different Node.js version using NODE_MODULE_VERSION ...`：

```sh
# 本地，仓库根目录，已切到 Node 22
rm -rf api/node_modules web/node_modules e2e-contract/node_modules
(cd api && pnpm install --frozen-lockfile) && (cd web && pnpm install --frozen-lockfile)
```

## 2. 在本地启动前后端

### 2.1 端口约定

| 服务              | 端口                    | 默认端口被占用时                          | 在哪里改                         |
| ----------------- | ----------------------- | ----------------------------------------- | -------------------------------- |
| API               | 3001                    | 3100                                      | `api/.env` 的 `PORT`             |
| Web（`pnpm dev`） | 3000                    | 3200                                      | `pnpm dev -p <端口>`             |
| Web 转发目标      | `http://127.0.0.1:3001` | 与 API 端口保持一致                       | `web/.env.local` 的 `API_ORIGIN` |
| e2e-contract      | 3110 / 3210             | `CONTRACT_API_PORT` / `CONTRACT_WEB_PORT` | 运行时环境变量                   |
| Storybook         | 6006                    | —                                         | `web/package.json`               |

API 代码与 `api/.env.example` 的默认端口都是 3000，会和 `next dev` 的 3000 冲突；而 Web 默认把 `/api` 转发到 3001。所以本地在 `api/.env` 写 `PORT=3001`，Web 不用改。生产、smoke、Jenkins 等其他端口见 [参考表](docs/ops/参考表.md)。

### 2.2 最小配置与启动

`api/.env` 由 node 的 `--env-file` 读取，不展开 `$HOME` 等变量，所以用下面的命令写入绝对路径：

```sh
# 本地，仓库根目录；已有 api/.env、web/.env.local 时不覆盖，按下面几项手工核对
mkdir -p "$HOME/agent-platform/dev-data"
test -e api/.env || cat > api/.env <<EOF
HOST=127.0.0.1
PORT=3001
DATA_ROOT=$HOME/agent-platform/dev-data
BOXLITE_HOME=$HOME/agent-platform/dev-data/boxlite
EOF
cp -n web/.env.example web/.env.local
```

```sh
# 终端 1：本地，api 目录（首次会先编译）
pnpm start:dev
# 终端 2：本地，web 目录
pnpm dev -H 127.0.0.1
```

打开 <http://127.0.0.1:3000>。API 启动时自动执行数据库迁移，不需要单独跑 `pnpm db:migrate`。

### 2.3 首次启动要知道的几件事

| 主题                   | 说明                                                                                                                             |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 访问口令               | 全新 `DATA_ROOT` 首次启动时自动生成 16 位口令，只在终端 1 打印一次。错过了就在 `api/.env` 加 `ACCESS_PASSCODE=<自定口令>` 后重启 |
| `ACCESS_PASSCODE` 留空 | 含义是"首次启动自动生成"，不是关闭口令门。换口令的完整说明见 [api/README.md](api/README.md)                                      |
| 浏览器 mock            | 默认关闭，`pnpm dev` 直连真后端。只有 `NEXT_PUBLIC_API_MOCK=1 pnpm dev` 才启用 MSW                                               |
| 沙箱镜像               | 日常不要设置 `SANDBOX_DEFAULT_IMAGE`：留空时平台按宿主档位从 GHCR 取内置镜像，填了会让自动选择失效。例外见下方                   |
| 沙箱档位               | Mac 默认用 BoxLite 微虚拟机（需要 Apple Silicon）；Linux 默认 aio 档，需要可用的 Docker                                          |
| `BOXLITE_HOME`         | 不设时为 `~/.boxlite`，不在 `DATA_ROOT` 里。同一目录只能被一个 API 进程持有，两个本地 API 要用不同目录                           |
| 重置本地数据           | 停掉 API，确认没有残留的 `boxlite-shim` 进程（`pgrep -fl boxlite-shim`），再删除 `DATA_ROOT`                                     |

例外：只有调试自制沙箱镜像时才设置 `SANDBOX_DEFAULT_IMAGE`，而且必须指向与本机档位一致的镜像。Mac 为 boxlite 档，BoxLite 从 `SANDBOX_BOXLITE_REGISTRY`（缺省 `localhost:5001`）指向的本地 registry 拉镜像；Linux 为 aio 档。本地 registry 的做法见 [api/images/README.md](api/images/README.md) 的「要不要 push」一节；那篇说“本地开发必须填”，只适用于这种调试场景，配置与当前 API 镜像文档不一致时，以实际 provider 和镜像登记为准。

### 2.4 前后端之间怎么连

- 本地开发：浏览器只访问 Web，`/api/*` 与 `/socket.io` 由 Next 转发到 `API_ORIGIN`；两个 `NEXT_PUBLIC_*_BASE_URL` 留空。
- 部署实例：浏览器访问本实例 StableEntry，同源进入固定版本 Web、API 与 WebSocket。具体入口及转发边界见[统一部署指南](docs/ops/统一虚拟化与实例部署.md)。
- `API_ORIGIN` 和 `NEXT_PUBLIC_*` 在 Next 启动或构建时读入：改了要重启 `pnpm dev`；生产构建要重新 `pnpm build`。

### 2.5 本地常见问题

| 现象                                                                                    | 原因                                                                       | 处理                                                  |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------- |
| 页面能开，`/api/*` 都返回 500，Web 终端打印 `Failed to proxy http://127.0.0.1:3001/...` | `API_ORIGIN` 指向的端口上没有 API                                          | 核对 API 端口与 `web/.env.local`，改后重启 `pnpm dev` |
| 启动报 `EADDRINUSE`                                                                     | 端口被其他进程占用                                                         | 换用 §2.1 的备选端口                                  |
| 启动报 `was compiled against a different Node.js version`                               | 切换过 Node 版本                                                           | 按 §1 重装依赖                                        |
| API 运行中 exit 134                                                                     | 可能在 Node 24 上运行                                                      | 切回 Node 22 并重装依赖                               |
| 建任务报 `IMAGE_PROVIDER_MISMATCH`                                                      | `SANDBOX_DEFAULT_IMAGE` 指向了与本机档位不符的镜像（如 Mac 上用了 aio 档） | 删掉这一行，或换成本机档位的镜像（§2.3），重启 API    |

## 3. 三个仓库、子模块与分支

| 仓库                                | 内容                                                                          | `main` 的必需检查    |
| ----------------------------------- | ----------------------------------------------------------------------------- | -------------------- |
| `cloud-agent-platform-docs`（主仓） | 文档、`deploy/`（Jenkins 与容器工具）、`e2e-contract`、`api`/`web` 子模块指针 | `jenkins/project-ci` |
| `agent-platform-api`                | 后端                                                                          | `jenkins/native-ci`  |
| `agent-platform-web`                | 前端                                                                          | `jenkins/web-ci`     |

### 3.1 各类检查用哪组提交

| 场景                                        | api                                                 | web             | 主仓             |
| ------------------------------------------- | --------------------------------------------------- | --------------- | ---------------- |
| api 的 PR 或 `main`（native-ci）            | 该提交                                              | —               | —                |
| web 的 PR 或 `main`（web-ci，含跨仓子作业） | api `main` head                                     | 该提交          | 主仓 `main` head |
| 主仓的 PR 或 `main`（project-ci）           | api `main` head                                     | web `main` head | 该提交           |
| 每天 03:00 的定时检查                       | 主仓 `main` 的 [gitlink](docs/ops/README.md#术语表) | 同左            | 主仓 `main` head |
| 既有组合构建模板                           | api `main` head                                     | web `main` head | 主仓 `main` head |
| 本地 `pnpm docs:check`、e2e                 | 工作区检出的子模块                                  | 同左            | 工作区           |

注：上表描述各 CI 模板的输入约定；是否启用及本次实际 SHA 以作业参数和构建收据为准，不能用历史定时状态替代当前检查。

由此得出三条规则：

- 依赖未合并 API 改动的 Web PR，CI 必然失败：它用的是 api `main`。先合 API。
- 主仓 PR 的 CI 与上述既有组合构建模板不读取 PR 内的子模块指针。仍须更新指针用于复现；安装包与实验构建以明确冻结的三仓输入和收据为准，不能从模板默认值推定实际发布来源。
- 遇到"本地绿、CI 红"，先看 CI 参数里的 `API_SHA`、`WEB_SHA`，再看本地 `git -C api log --oneline -1`。

### 3.2 分支与 PR

[发现作业](docs/ops/README.md#术语表)的完整规则只在 [参考表](docs/ops/参考表.md) §2 维护，开发者要记住的是：

- 除三仓 `main` 外，只有同仓、指向 `main` 的 PR（含 draft）会跑 CI。想先跑 CI 就开 draft PR；fork PR、栈式 PR 和没有 PR 的分支都不构建，fork 改动由维护者推到同仓分支再开 PR。
- CI 只在分支出现新提交时重跑。其他仓合并后 PR 上的旧状态不会自动更新，要推一个新提交（可以是 `git commit --allow-empty`）。
- 分支名不要以 `/refs/heads/main` 或 `/refs/tags/sandbox-image-v*` 结尾，原因见参考表 §2。

### 3.3 跨仓改动的合并顺序

1. 合 api 的 PR。
2. 合 web 的 PR（它的 CI 用 api `main`，所以排在 API 之后）。
3. 在主仓功能分支上用 `scripts/sync-submodules.sh` 把两个指针一起更新到各自 `main`，推送后开主仓 PR 并合并。改过接口时只更一个指针，会让 docs:check 的 B3（两仓 openapi 逐字节相同）变红。

```sh
# 本地，主仓根目录，在功能分支上（子模块里不要有未提交改动）
scripts/sync-submodules.sh --dry-run   # 只看会更新什么
scripts/sync-submodules.sh             # 快进 api、web 到各自 origin/main 并生成一条提交（不推送）
```

跨仓发布先固定经过验证的三仓输入，按 [发版手册](docs/ops/发版手册.md) 构建签名产物。Jenkins agent 维护与业务实例升级是独立操作，不能通过合并或恢复作业启用实例 deploy/promote。

## 4. CI 门禁与本地复现

| GitHub 状态          | Jenkins 作业               | 阶段                                                                                                                                                                                                   |
| -------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `jenkins/native-ci`  | `agent-platform-native-ci` | 检出、安装、类型检查、lint、格式、默认镜像一致性、验收、provider 能力夹具、构建、OpenAPI 漂移、原生模块加载，共 11 个                                                                                  |
| `jenkins/web-ci`     | `agent-platform-web`       | 安装（含 Chromium）、类型检查、lint、格式、story 覆盖、mock 契约锚定、无 emoji、OpenAPI 漂移、验收、Storybook 交互测试、Storybook 构建、生产构建、打包；通过后再跑跨仓子作业 `agent-platform-contract` |
| `jenkins/project-ci` | `agent-platform-contract`  | 部署回归测试、docs-check、三仓安装、浏览器→Nest→SQLite 跨仓验收                                                                                                                                        |

本地等价命令（Node 22）：

```sh
# 本地，api 目录。CI 在 Linux ARM64 上另做原生模块加载，本地无对应命令
pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint --max-warnings=0 && pnpm format:check
pnpm check:default-image && pnpm test:acceptance && node scripts/check-fake-provider-caps.mjs
pnpm check:openapi
```

```sh
# 本地，web 目录（Storybook 测试需要先 pnpm exec playwright install chromium）
pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm format:check
pnpm check:stories && pnpm check:mock-contracts && pnpm check:no-emoji && pnpm check:api-drift
pnpm test && pnpm test:storybook && pnpm build-storybook && pnpm build
```

```sh
# 本地，仓库根目录（e2e-contract 依赖 api、web 已安装依赖）
pnpm deploy:test && node scripts/docs-check.mjs --require-contracts
(cd e2e-contract && pnpm install --frozen-lockfile && pnpm exec playwright install chromium && pnpm test)
```

补充说明：

- api 与 web 的 pre-push 钩子已覆盖格式、lint、类型检查与 OpenAPI 漂移（api 会先 `build`）；web 还跑 story 覆盖与 mock 契约锚定。
- `pnpm deploy:test` 本地约 5 秒。在 Mac 上有 4 个用例显示 skip，属预期：它们只在 Linux CI 容器（`/home/jenkins/agent/workspace`、uid 1000）里执行。
- 本地与CI共用递归部署测试发现，覆盖`deploy/{containers,host,jenkins,ops,upgrade}`及新增测试目录；既有必需目录缺失或为空必须失败。环境不适用的skip仍明确保留，不冒充已通过。
- `pnpm docs:check`保留本地文档模式，依赖缺失逐项skip；完整本地复现与CI显式使用`--require-contracts`，`CI=true`同样要求必需输入完整。API的`check:openapi`自身先build再生成；两子仓均要求契约已跟踪、已在HEAD，生成后连同暂存差异一起与HEAD比较。
- api 的 `pnpm check:acceptance` 读取主仓的 `docs/product/requirements`，只能在主仓检出的 `api/` 里本地运行，不在 Jenkins 门禁内。
- `agent-platform-mutation` 当前未启用，不参与任何门禁。

### 4.1 怎么看 CI 日志

- GitHub 状态链接指向 `https://jenkins.douglasdong.com/job/<作业>/<编号>/`，要先过 Cloudflare Access 白名单，再用 Jenkins 账号登录；目前只有维护者能打开。
- 没有权限时，把 PR 链接和失败的状态名发给维护者，由维护者转交控制台输出或归档报告。
- 在 Mac mini 上可以只读查询（需要 Mac 上的 Jenkins API 凭据文件；凭据位置与 `$NODE22` 的取值见 [参考表](docs/ops/参考表.md)）：

```sh
# Mac mini，主仓根目录；只读
"$NODE22" deploy/jenkins/manage.mjs status
"$NODE22" deploy/jenkins/manage.mjs build-status agent-platform-contract <构建号>
```

### 4.2 部署工具里的宿主值

改 `deploy/` 下在 Mac 上运行的工具时，遵守下面几条；推导规则与检查集合的权威表在[参考表](docs/ops/参考表.md) §12。

- 宿主路径、账号与 UID 一律从 `deploy/containers/host-layout.mjs` 取。身份只取 `os.userInfo()`（系统账户库），不读 `HOME`、`USER`、`LOGNAME`、`XDG_*`、`AGENT_PLATFORM_*` 等环境变量，也不用 `os.homedir()`（它跟随 `$HOME`）。可覆盖的只有 `dockerCli`、`homebrewPrefix`、`launchdLabelPrefix` 三项，来源只有私有目录里的 `host-layout.json`，不接受环境变量或命令行参数覆盖。
- 每个工具按动作声明自己要的检查集合（`REQUIRES`），只检查本动作用得到的东西；止损用的 `manage.mjs` 只依赖运行账号、私有目录与 `admin-api.json`。
- 镜像内的模块不得导入 `host-layout.mjs`：`deploy/jenkins/*.mjs`、[`CONTAINER_INPUTS`](docs/ops/README.md#术语表)、CI 与 controller 镜像清单里的文件都算。`deploy/jenkins` 下的三个 Mac 专用 CLI（`manage.mjs`、`setup-github-app.mjs`、`import-ghcr-token.mjs`）只能在 CLI 分支里动态导入，库函数一律显式传参。
- 测试用注入的假布局（如用户名 `operator`、UID 5101、HOME `/Users/operator`），不写真实账号。
- 守卫测试 `deploy/containers/host-literals.test.mjs` 扫描 `deploy/`、`scripts/` 下非测试、非文档的文件，以及根目录的 `package.json` 与 `docker-compose.yml`，拦截 `/Users/<账号>`、`douglasdong`、独立的 `501`、`homedir(`、读取 `process.env.HOME|USER|LOGNAME|XDG_*|AGENT_PLATFORM_*|COLIMA_HOME`、`.orbstack/` 与 `fnm/node-versions`。部署域名 `*.douglasdong.com` 不受限；其余例外逐条写在测试的白名单里，注明理由，每条必须恰好命中一次。它还断言镜像里的文件都不静态导入 `host-layout.mjs`。
- 容器内的固定布局（`/home/jenkins`、uid 1000、`/srv/agent-platform/deploy` 等）是镜像契约，不受这条规则限制。

## 5. 合并、发包与实例升级

合并推进源码及 CI。CD 只构建、验证、签名和发布不可变产物；实例由管理员主动发起升级。纯文档提交不会因此替换服务，发布包也不改变尚未选择升级的实例页面。当前禁用的自动 deploy/promote 保持禁用，模板同步和维护退出都不能重新放行。

| 改动 | 合并与发包前要核对 |
| --- | --- |
| `deploy/` 工具、作业模板、Dockerfile | 区分 CI 基础设施变更与实例运行控制，验证工具的信任输入及实际副作用 |
| 运行镜像及输入清单 | 固定原生 ABI、源提交和完整摘要；需要更新构建工具时独立验证 |
| BoxLite SDK、provider、auth helper、Owner 参数 | 在隔离环境运行真实 KVM／Guest 验证，CI 静态或模拟结果不能替代实机 |
| 数据库迁移 | 核对唯一写者、兼容路径、fencing 和新写入后的恢复边界；不能因发布包直接迁移实例 |
| 不向后兼容的接口 | 验证新旧角色与页面兼容，在实例升级计划中明确顺序和失败恢复 |
| 沙箱镜像 | 发布不可变 digest，真实验证 CLI 版本；新镜像不改写已有 Guest |
| 跨仓改动 | 固定 Root／API／Web 精确提交，按 §3 完成契约与 CI 检查 |

运行镜像使用主仓部署工具定义的 Linux 原生边界，`api/Dockerfile` 与根 compose 文件仅保留作开发／构建工具输入，不是当前实例安装或升级入口。首次部署、管理员升级、CI 维护分别见 [发版手册](docs/ops/发版手册.md)和[统一部署指南](docs/ops/统一虚拟化与实例部署.md)。

CHANGELOG 记录已完成的代码与验收边界；提交或版本标签不表示实例已经激活该版本。

## 6. 权限与 AI agent 的边界

| 操作                                                        | 谁来做                                                  |
| ----------------------------------------------------------- | ------------------------------------------------------- |
| 推功能分支、开 PR（含 draft）、跑本地检查、只读查询 Jenkins | 所有协作者与 AI agent                                   |
| 合并三仓 `main`、打 tag、手动触发发版                       | 只由维护者执行                                          |
| 启停 Jenkins 作业、quietDown、对三台 VM 或生产容器的写操作  | 维护者；AI agent 只在维护者当次明确要求时按运维文档执行 |

- 三仓 `main` 受分支保护：必须通过对应的 `jenkins/*` 状态并解决全部会话，管理员同样受限。保护规则不要求 review，所以"谁能合并"靠上表约定。
- 三仓目前只允许协作者开 PR 和评论（GitHub interaction limits，到期日见参考表）；不是协作者请先联系维护者。
- Jenkins 目前只有一个管理员账号，不开放注册；CI 日志按 §4.1 由维护者转交。

## 7. 文档放哪里

| 内容               | 位置                                                                | 规则                                                         |
| ------------------ | ------------------------------------------------------------------- | ------------------------------------------------------------ |
| 产品需求与页面规格 | `docs/product/`                                                     | REQ/AC 保持稳定编号                                          |
| 实现设计与跨仓约定 | `docs/backend/`、`docs/frontend/`、`docs/shared/`                   | 编号已到 29，不再新增编号文档；新内容并入既有章节            |
| 运维与发布         | `docs/ops/`                                                         | 中文文件名、不加编号，由 [运维入口](docs/ops/README.md) 收录 |
| 本地开发与贡献流程 | 本文                                                                | —                                                            |
| 工具说明           | 工具旁的 `README.md`，如 `deploy/containers/boxlite-proof/`         | docs:check 不检查，改完手工点开链接                          |
| 历史与踩坑         | `CHANGELOG.md`、`docs/LIVE-RUN-FINDINGS.md`、`docs/ops/运维记录.md` | 带日期的状态只写在运维记录                                   |

改完文档跑 `pnpm docs:check`，13 项须全部通过；`docs/` 下新增的文档要被某份 `README.md` 索引链接（A3）。规则的完整定义见 [09 §2.4](docs/shared/09-工程化规范.md)。
