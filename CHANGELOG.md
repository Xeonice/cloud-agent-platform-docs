# CHANGELOG

本文件记录**平台整体**的版本。

三仓之中**只有主仓打 tag** —— 只有它能钉住一个完整、可复现的部署状态（两个 submodule 指针）。
⛔ 不给 `api` / `web` 各自打产品版本号：它们 `package.json` 里的 version 是**包版本**，
跟着产品号走会立刻与主仓 tag 漂移，而且改它们又会反过来动指针，绕成一个环。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循
[语义化版本](https://semver.org/lang/zh-CN/)。

---

## [0.2.0] - 2026-09-22

**这一版的主题是：让它在一台【别人的】机器上真的装得起来。**

v0.1.0 打出去之后做了一次换机部署审查,随后在一台真 mac（macOS 26.5.2 / arm64）上
从零走通 —— 从 `git clone` 一路到工作台、建项目、发起任务的对话框。
过程中撞出的每一条都记在下面,**包括三次「本地全绿、真机才炸」**。

### 换机部署：三条阻塞

v0.1.0 打出去之后做了一次「换一台新机器照现有内容能不能部署起来」的审查。
结论是**起得来一个后端 API，但（a）拿不到任何界面，（b）建不了 git 项目**。
两条都不是配置问题，是**产物缺东西**。

#### 🔴 R1 · api 运行镜像里没有 `git`，而 git 克隆跑在 api 进程里

`Dockerfile` 的 runtime 阶段是 `node:22-bookworm-slim`，全文件唯一一条 `apt-get`
在 **builder** 阶段。而 `simple-git` 是 `spawn('git', …)` 的封装，三处调用
（建项目克隆 / 列分支 / Git 凭证校验）**都跑在 api 容器里**，不是沙箱里。

⚠️ 症状很阴：compose 起得来、health 200、镜像播种成功、诊断可能全绿 —— 然后
「创建项目」失败。而那是冷启动引导的第一个动作。

⇒ runtime 阶段装 `git` + `openssh-client` + `ca-certificates`，每一个都在注释里
写明被哪条代码路径要求（将来想瘦身的人才知道删哪个会死）：
- `openssh-client` —— `git-env.ts` 的 `mergeAuthEnv()` **无条件**注入 `GIT_SSH_COMMAND`，
  SSH 形态的私有仓会在 spawn `ssh` 这一步失败。⚠️ 用 https 公开仓测「能建项目」**测不出**这条。
- `ca-certificates` —— git 走 libcurl/OpenSSL 读系统信任库（Node 的 `fetch` 自带证书链、
  不依赖它）。缺了它所有 https clone 报 `unable to get local issuer certificate`，
  ⚠️ 而这个报错和「网络不通」长得一样，容易被误判成防火墙。

**实测**：对真实产物镜像跑 `git clone --depth=1 https://github.com/octocat/Hello-World.git`
成功 —— 不是只查二进制存在。

#### 🔴 R2 · 交付形态写着 `docker compose up`，但全套产物里没有前端

逐条核过：compose 里只有 `api` / `docker-proxy` / `sandbox`；`web/` 仓没有 Dockerfile；
api 也不托管静态资源（`ServeStatic` / `useStaticAssets` 零命中）。
⇒ `docker compose up` 之后只有 Swagger 和 `/openapi.json`，**没有界面** ——
而初始化向导、镜像准备、订阅配置、工作台全在前端。

新增：
- `web/Dockerfile`（standalone 三段式，实测镜像 **457MB**）+ `.dockerignore`；
  `next.config.mjs` 补 `output: 'standalone'`
- **主仓根目录 `docker-compose.yml` 作为部署入口**

⚠️⚠️ **部署入口为什么必须在主仓、不能留在 `api/`**：`api/` 是独立仓库，它自己那份
compose 引用不到 `../web`（单独 clone api 的人那里没有那个目录）。只有主仓同时看得见
两侧，也只有它钉得住一份完整可复现的部署状态 —— 与「只有主仓打 tag」同一条理由。
用 `include:` 复用 api 那份，⛔ 不复制：那十几项配置每一项都是踩坑换来的，
复制 = 两个真相源，而其中一份还管着安全边界。

**拓扑收紧**：整套部署**只发布 web 一个端口**，`api` 与 `docker-proxy` 都不对外
（逐服务验过 `ports=0`）。浏览器的 HTTP 与 WebSocket 都经 web 同源转发。

#### 🔴 R3 · 主仓没有 README，全仓没有一句 clone 指令

新增根目录 `README.md`。⛔ `--recursive` 不能省 —— 漏了拿到两个空目录，
**而失败的样子像「仓库不全」不像「你少了个参数」**。

### 两个构建期/运行期的分界（这轮最容易做错的地方）

同一条判据、两个相反结论：**值是否依赖运行时宿主环境**。

| 变量 | 依赖宿主？ | 做法 |
|---|---|---|
| `API_ORIGIN` | ❌ 是 compose 内部 service DNS 名，每台机器都一样 | 构建期固化，**无害** |
| `NEXT_PUBLIC_WS_BASE_URL` | ✅ 取决于访问者浏览器用的 host | **留空走同源** |

⚠️ `rewrites()` 的 destination 在 `next build` 时被烤进 `routes-manifest.json`，
standalone 的 `server.js` 只读那份清单、**永不重跑** `next.config.mjs`。
**决定性实验**：用 `-e API_ORIGIN=http://this-host-does-not-exist:9999`（一个解析不出来的
主机名）起同一个镜像，转发目标**纹丝不动**，仍是烤进去的 `http://api:3000`。
⇒ ⛔ 别把它挪进 `environment:`，那会造出一个「看起来可配、实际无效」的开关。

⚠️ 连带的坑：`next.config.mjs` 那三条 rewrite 的兜底是 `http://127.0.0.1:3001` ——
**build 时不传 `API_ORIGIN` 就会把它固化进去**，在 web 容器里那指向它自己，
后端链路直接断，且运行期才暴露。已由 Dockerfile 的显式 `ARG` 默认值挡掉。

### 其它修正

- **`cp .env.example .env` 会让 compose 直接起不来** —— 模板里 `DATA_ROOT=./data`
  是给裸跑写的相对路径，compose 读它做插值后挂载点变相对路径，报
  `invalid mount path`。⇒ 改成注释状态，让两种形态各自的默认值都成立
  （实测两种情况展开结果一致）。⛔ 不是再加一段警告 —— 那段警告本来就在，
  而「复制模板」是所有人的第一反应。
- **`ACCESS_PASSCODE` 等三个变量 compose 没透传**，填了等于没填（`PasscodeGuard` 静默自禁用）。
  ⚠️ compose 的 `.env` 只做**变量插值、不注入容器**，这条写进注释免得下个人再漏。
- 三个服务补 `restart: unless-stopped` + `healthcheck`，`depends_on` 收紧到按健康等待。
  ⚠️ runtime 镜像没有 curl/wget，探针用 node 自己发请求。
- `git describe` 在 `api/` 里拿到的是 **api 仓自己的时间线**（实测 `sandbox-image-v2-20-g1427649`），
  不是主仓的 `v0.1.0`。⇒ 改用 `--show-superproject-working-tree` 定位主仓，
  ⛔ 不用 `git -C ..`（依赖"主仓一定是上一级目录"，目录一挪就碎）。
- `.env.example` 把 `SANDBOX_PRESET_IMAGE_SOURCE` 留空时的机制说成 `upstream-copy`，
  实际走的是 `provider-stage`。结论碰巧对、解释是错的 —— 而错的解释会让下个人按错误的模型去改。

### 🔴 容器形态下「帐号登录」必然失败 —— 落地 auth helper 容器

真机上点「帐号登录」得到：「`codex login --device-auth` 打印设备码与验证地址还没出结果，
命令就已经退出了。多半是这个 CLI 在这台机器上没能正常启动。」

**根因**：`runtime.module.ts` 把 `HostAuthHelper` 硬接上了 —— 那一档要求「后端进程所在
环境自带两个 CLI」。而出厂形态是 `docker compose up`，api 跑在 `node:22-bookworm-slim`
里，那张镜像**没有也不该有**这两个 CLI。实测容器内 `codex: not found` / 退出码 **127**。

⚠️ **那句报错本身也是误导的**：它走的是「进程在产出期望内容前就退出了」这个分支
（`CLI_EXITED_EARLY`），说的是「没能正常启动」—— 而真相是**它压根没装**。
两者的下一步动作完全不同。

⇒ 落地 11 §1.1 的默认形态：`ContainerAuthHelper` + `HelperContainerSession`，
登录 CLI 跑在平台自己那张预制镜像的常驻 helper 容器里（与任务沙箱用同一张 ⇒ **CLI 版本
必然一致**，这是 §1.1 列的第一条理由）。`AUTH_HELPER_MODE=container|host` 二选一，
默认 `container`；`host` 保留给裸机 systemd 部署。

#### ⚠️⚠️ 文档这一节有两处是错的，实现时撞出来后一并订正

**① 「compose 增加一个 `auth-helper` 服务」—— 做不到。**
平台在容器里跑进程**不走 `docker exec`**（`docker-container-runtime.ts` 里根本没有
exec 这个方法），走的是**镜像内的 HTTP agent**；而 agent 的 auth token 是
`aio-sandbox.provider.ts` 在 **`create()` 那一刻**生成并注入的。compose 建的容器没经过
这一步 ⇒ 平台不知道 token、容器也不认平台。⇒ **helper 必须由平台经 provider 创建**。

**② 「`command: sleep infinity`」—— 会亲手掐掉唯一的进入通道。**
AIO 镜像自带 entrypoint，而**那个 entrypoint 正是启动 agent 的东西**。覆盖它会得到一个
「running 但永远连不上」的容器 —— 这句警告 `docker-container-runtime.ts` 早就为沙箱写过。

⚠️ 两条都是「照着 `docker exec` 的模型写的设计」，而实现从一开始就不是那个模型。
compose 骨架里的 `auth-helper` 已整条移除，并写明「这里没有它是故意的」。

#### 实现上的几处讲究

- **种子文件走 stdin，⛔ 永不进 argv** —— 刷新扫描器 seed 进去的正是当前那份凭证明文
  （05 §5.1），拼进命令行等于挂到容器里任何进程都读得到的 `/proc/<pid>/cmdline` 上。
- **隔离 HOME 用容器内的 `mktemp -d`**，并**校验它是绝对路径**。⚠️ 宿主形态踩过一模一样
  的坑：相对路径时 codex 按新 cwd 再解析一遍然后退出，而 claude 不校验、照跑不误 ——
  **同一个 bug 只打挂一半 runtime**，看起来像「codex 坏了」。
- **建了 HOME 之后任何一步失败都要先清掉再抛** —— 否则就是 §1.1 诊断项专门在找的
  那种「`finally` 漏删的泄漏」。
- **预热在后台，⛔ 不挡 api 启动**：首次要拉约 4GB；只用 API Key 的部署、离线机器，
  都必须照样能把平台跑起来。没就绪时抛错、由上层包成 `PROVIDER_UNAVAILABLE`，
  ⛔ **不许降级到「在任务沙箱里登录」**（那会把决策 A 退回去）。
- **重启就重建而不是接回**：`agentAuthToken` 每次 create 新生成，旧容器认旧 token；
  要接回就得把一份凭证类的值落库。固定 sandboxId ⇒ 容器名确定 ⇒ 残留总找得到。

#### 新增第 ⑨ 项诊断：帐号登录环境

§1.1 运行纪律本来就要求「helper 里 CLI 缺失要在系统状态页显性报出，**而不是等用户
点登录才失败**」。⚠️ 报 `warn` 不报 `fail`：helper 不可用**只挡帐号登录这一条路**，
API Key 与已配好凭证的任务都照跑 —— 把一台完全可用的机器标红，就是本仓一直在删的
那种「恒响的告警」。⛔ 也不许报 `ok`，那等于把「点了登录才发现」原样留着。

⚠️ 这一项牵动跨仓契约：`DIAGNOSE_CHECK_IDS` 八项 → 九项、`SSE_PROTOCOL_CANONICAL`
821 → 833 字符、schema hash `sb-diagnose-v1` → `v2`，两仓逐字符同步。
**两侧共 7 条测试因此变红，那正是它们的用途**（都是手钉的字面量）；顺手把「项数」
类断言改成从 `DIAGNOSE_CHECK_IDS.length` 派生，下次增删不用再追着改一圈。

新增 9 条用例，**做过变异验证**：把种子内容拼进 argv / 去掉绝对路径校验 / 删掉失败
路径的清理，三次变异分别让 2、2、1 条立刻变红。

### 🔴 磁盘容量在每个 macOS 部署上虚报 256 倍（换机实跑撞出来的）

真机走完向导时，Step 5 报「可用 164.5 TB / 总 231.6 TB」，而那台机器是 926 GB。

**根因**：POSIX 规定 `f_blocks/f_bfree/f_bavail` 的单位是 **`f_frsize`**（片段大小），
不是 `f_bsize`（首选 I/O 块大小）。两者在 ext4/xfs/APFS 上**恰好相等**，所以拿 `bsize`
算了很久都是对的 —— ⚠️⚠️ 而 **Node 的 `fs.statfs` 根本不暴露 `f_frsize`**（v22 实测只有
七个字段）。容器里 bind 进来的宿主目录走 FUSE 系（virtiofs / gRPC-FUSE），把 `f_bsize`
报成传输尺寸 **1 MiB**，块计数却仍是 4 KiB 单位 ⇒ 虚报 **256 倍**。

⚠️ **不是某个运行时的怪癖：OrbStack 与 Docker Desktop 都复现**，而 `DATA_ROOT` 恰恰
就是那个 bind mount ⇒ **每一个 macOS 部署都中**。

⚠️⚠️ **真正严重的不是看板数字。** `availableBytesFor` 是这些地方的预检分母：
clone 前 · workspace 复制前 · tar 解包前 · **调度器容量探测**（决定能不能建新任务）·
审计导出 · 磁盘诊断。虚报 256 倍不会让任何东西报错，它只是**让所有磁盘门禁静默放行**，
然后在真写满时以 ENOSPC 收场 —— 而那正是这些预检存在的全部理由。
（讽刺的是这个文件的注释本来就在担心 `bfree/bavail` 那 5% 的虚账，而这里是 25600%。）

**修法**（`shared-kernel/src/fs/free-space.ts`）：
- `bsize ≤ 64 KiB` ⇒ 照旧直接用。**原生文件系统零额外开销、行为与历史完全一致**。
  这条线的依据是物理上限：ext4/xfs 最大块 64 KiB、APFS 4 KiB，**没有文件系统的分配
  单元是 1 MiB**，所以超过这条线只可能是「传输尺寸」那一种含义。
- 超过 ⇒ 问 `df -kP`。它就是 POSIX 里干这件事的工具，用的正是 Node 不给我们的 `f_frsize`。
  ⚠️ `-P` 保证每个文件系统一行；正则锚在 `<数字>%` 上而不按列切 —— 文件系统名可以含空格。
- ⛔ **两条都答不上来时回 `null`，不退回 `blocks × bsize`。** 那不是「精度差一点」，
  是已知虚报 256 倍，报出去等于把上述所有门禁打开。少报是降级，多报是撒谎。

`availableBytesFor` 改为直接委托 `filesystemStatsFor` —— 此前两者各写一遍祖先回溯 +
算术，正是「两份会分头漂移」的形状，而讲究已经从两个涨到三个。

**5 条新用例，且做过变异验证**：把实现退回 `blocks × bsize`，其中 3 条立刻红。
⚠️ 这套断言在开发机上是测不出来的 —— APFS 上 `bsize === frsize`，那条路径永远走不到。

### 门禁：补上「文档 ↔ 部署产物」这一层

⚠️⚠️ **这是上面一半问题的根因**：`docs:check` 12 项全绿，却**一眼都不看 compose**。
骨架里画着 `web:` 服务、写着一个早已被推翻的 `SANDBOX_DEFAULT_IMAGE` 坐标，
两条都一路活到了 v0.1.0。

新增 **C 类门 · `C1 compose 骨架对账`**，两条判据：
1. 服务集合相等，**⏳ 除外**（与 B6「未实现端点已标注」同款：文档先行是允许的，
   但必须显式声明"这条还没做"，而不是默默画上去）
2. `${VAR:-default}` 的默认值必须一致

⛔ **防假绿是写死的**：找不到 `services:` 块 / 解析不到服务 / 找不到骨架块，
**一律判 fail 并说明「是门坏了」** —— 不是安静放行。
本仓栽过两次同款（零尺寸 a11y 探针、装了但一条都不判的 addon）：
**一个什么都没找到的检查，看起来和一个全部通过的检查一模一样。**

另把 **A1 的扫描面扩到根目录** —— `README.md` 是新人打开仓库看的第一份东西，
此前它的链接一条都没人校验（570 → 576 条）。
⚠️ 它必须是独立的一份清单，**不能并进 `MD_FILES`**：那个数组同时是 A3 的清点面，
并进去 A3 会立刻要求把 README/CHANGELOG 收进设计文档索引（实测撞出来的连锁反应）。

### ⚠️ 待裁决（未改）

- **访问口令出厂是【关闭】的**，而 `21-8 §3` 写的是「默认启用状态」。
  实证：`passcode.service.ts:69` `enabled = source !== 'none'`，且全仓没有开机自动生成口令的代码。
  ⇒ 新机器起来后口令门是敞开的，只靠「默认只监听 127.0.0.1」这一道。
  ⛔ **刻意不把文档改成「默认关闭」去迁就实现** —— 那等于悄悄把一条安全要求降一档。
  两个方向都成立（实现补开机生成 / 产品确认「回环 + 手动开启」就够），但必须有人裁。

### 仍未解决

- **版本号界面上还看不见**：`GET /api/system/version` 有了，但 21-8 §4 那个区块整体属 v1.5。
- **`[检查更新]`** 缺的是裁决不是代码（没有更新源）。
- `POST /api/system/backup` —— v1.5 占位。

---

## [0.1.0] - 2026-09-16

首个打 tag 的版本。在此之前主仓 142 次、`api` 106 次、`web` 97 次提交（2026-08-08 起）
**没有任何发布记录**。

> ⚠️ **这个号与产品路线图里的 v1.0 / v1.1 不是一回事。**
> 19 §6 用「v1.0」指代 **MVP 验收线**，那是一条产品裁决 —— 本仓没有任何验收记录，
> 我不替你宣布它达成了。本 tag 只是工程侧的第一个发布标记，故从 `0.1.0` 起。
> 真要宣布 MVP 达成，另打 `v1.0.0`。

### 交付形态

`docker compose up` 单机私有化部署（权威是 `api/docker-compose.yml`，那份经实跑验证）。
数据 / 代码 / 凭证不出本机；⚠️ 但 Agent 需出网访问 OpenAI / Anthropic API ——
**不支持完全离线跑 Agent**，这是物理约束不是缺陷（21-8 §1）。

默认只监听 `127.0.0.1`（审计 P0-3），改 `0.0.0.0` 需显式配置且会告警。

### 已实现

**双协议面**
- REST / OpenAPI：**63** 条 path（含 3 条 MCP 传输层），业务端点 **60** 条
- MCP：**14** 个 tool 已注册，与 02 §5.2 的设计集合逐条相等（`docs:check` B2 守着）
- **86** 个错误码，源码与 10 §6.8 的表集合相等（`docs:check` A5 守着）

**运维可见性**
- `GET /api/system/version` —— 实例报得出自己是哪一版。⚠️ 版本在**构建期**注入
  （`Dockerfile` 三个 ARG）：平台版本是主仓 tag，而跑起来的是 api 容器，它读不到主仓。
  ⛔ 未注入时如实回 `null`，**不兜底成 `api/package.json` 的包版本** —— 那是个看起来
  像真的、但永远是错的版本号。

**沙箱与运行时**
- 两档隔离 provider：`aio`（默认）/ `boxlite`（微虚拟机，独立内核强隔离）
- 两个 runtime：`codex` / `claude-code`
- 非交互执行 `exec_in_sandbox`；无头任务 `run_agent_task`（202 返回 taskId，单次最长 4h）

**实时通道**（三个 WS 网关）
- `/events` —— sandbox.* 事件驱动的状态投影
- terminal —— 双向 PTY 转发 + tmux 断线恢复
- tasks —— 无头任务的高频输出流（⚠️ 刻意不走 `/events`，那条通道会被字节流淹掉）

**前端**（4 条路由）
- `/` 工作台：任务树 / 终端多标签（LRU 挂载）/ 发起任务向导
- `/settings/credentials` 凭证管理
- `/settings/images` 镜像管理
- `/settings/system` 系统状态与诊断

**项目与自动化**
- 项目 CRUD + 异步 clone（`cloning` → `ready` 轮询，MCP 无推送通道）
- 自动化规则：定时唤起无头 Task、运行历史、webhook 失败通知、硬超时默认 2h

**无障碍与主题**（本轮收口）
- `prefers-reduced-motion` 全局兜底；真实渲染整页跑 axe 的 e2e 门禁
- 三态主题（跟随系统 / 暗色 / 亮色），默认暗色（产品 P21），首屏无闪烁

### 门禁

- 主仓 `docs:check` **12** 项（A1–A5 / B1–B7），含三处跨仓逐字节对账（openapi / WS / SSE）
- `web`：typecheck · lint · format · stories · mock-contracts · unit **1678** · storybook **501** · e2e **60**
- `api`：build · 分层边界（`eslint-plugin-boundaries`）· 单元 / 集成 / 契约 / e2e · mutation

### 已知缺口

- `POST /api/system/backup` —— **v1.5 占位**，10 §6 已标 ⏳（59 条业务端点里现在只剩这一条）。
- ⏳ **「检查更新」没做**，而它缺的是**裁决不是代码**：21-8 §6 自己把「版本检查源与静默
  失败策略」列为技术缺口，且这是本项目的第一个 release —— **还没有可供比对的更新源**。
- ⏳ **版本号在界面上还看不见**：`GET /api/system/version` 这一版补上了产出方，但 21-8 §4
  那个「升级与备份」区块整体属 v1.5，UI 尚未落地。⇒ 现在能 `curl` 出来，页面上还不能。
- 本机跑起来才发现的若干项见 `docs/LIVE-RUN-FINDINGS.md`（其中浅仓迁移仍 ⏳）
- `smoke.spec.ts:110` 在本机红、CI 绿 —— 本机环境问题，非回归

[0.2.0]: https://github.com/Xeonice/cloud-agent-platform-docs/releases/tag/v0.2.0
[0.1.0]: https://github.com/Xeonice/cloud-agent-platform-docs/releases/tag/v0.1.0
