# 2026-10-14 iflytek-mac 原生更新与终端验收

## 范围与当前状态

根据管理员指令，主 Linux 实例完成实验升级后，更新 `iflytek-mac`（`100.73.71.22`）的现有服务。入口为 `http://100.73.71.22:3000`，API 监听 `127.0.0.1:3001`，HTTP／WebSocket 经同一 Next 入口代理。没有更新 `100.97.190.45`，也没有重启主 Linux 实例。Native 更新后的独立只读检查显示，主 Linux 仍为 `v0.3.11-experiment.20261014.1`、generation=3、confirmed／ready=1，ready-revoked 仍仅有原 B 的 1 条。

本机为 macOS arm64，原服务是 v0.3.7 的 mono／launchd 架构。本轮构建并安装真正的 Darwin 原生包，进行空闲维护切换；没有把 Linux Docker 安装包套用到 macOS。当前运行 `v0.3.11-native.20261014.2`。该包为 `qualification`／`native-maintenance` 本地安装产物，未作为签名的正式 GitHub Release 发布；收据中的 release 下载 URL 不是已上传资产的证明。

Darwin mono 的升级状态仍为 `serviceState=unknown`、generation=0、confirmedServiceRelease=null、availableWeb=null。此次维护更新不代表 macOS 在线无感升级已经启用，也不证明旧版活跃任务接管。

## 冻结代码与真实构建

| 项目 | 初次原生包 .1 | 终端修复包 .2 |
| --- | --- | --- |
| 版本 | `v0.3.11-native.20261014.1` | `v0.3.11-native.20261014.2` |
| Root | `a177f0be97bd1f03790b4afb3f1ce2f14b50277d` | `1276d152570c04568db66e1a47f6ecd9b61654ce` |
| API | `08d4ab15bc63e51b8c3b27d505641d39146642e2` | `17e2ad52bfacea49ec9834d4f98693e3e66fbd79` |
| Web | `11ca18c9b14a12f99087a462661be3749f8f1d2f` | 同 .1 |
| 包 SHA256 | `17adccf382b1cd07179dee4840a350677c41a0db7fcc7261094259c55aac3c59` | `6b5b274d2abb41a89f9c208272d32a9a4e5c7b267eac10c4358ea738f8ca04c4` |
| 压缩字节数 | 75,669,895 | 75,669,364 |

两包都在目标 macOS 上使用 Node 22.23.3，从精确 Git 对象重新构建 API／Web，未复用 Linux 产物或上一包组件。生产依赖闭包、原生 SQLite 内存数据库、BoxLite 原生绑定加载探针通过；构建探针未打开原 SDK home／业务库。Web build 实际写入各自 Native releaseId，Web revision 为 `9667c4c36aba4aacbfda350de3d7d0669598eec4`。安装时验证包摘要及组件完整树。

API 修复的 13 个相关测试文件、129 项测试通过，包含真实 Darwin 子进程及退出／birth 不匹配、provider→stream 身份、unknown 不发送 ready／不接受 input。完整 typecheck／build 通过。API 远端分支 `codex/darwin-terminal-identity-20261014` 的正常 pre-push（format／lint／typecheck／build／OpenAPI）通过；后续 `31ef62b053b2f99b20cf332d780026423f63e749` 仅修正 6 个历史格式问题，源码及编译后 JS AST 相同。冻结包及 Root gitlink 保持其父提交 API `17e2ad52`。

## 数据、备份与服务切换

保留并继续使用原绝对路径：

- 数据目录：`/Users/KYQXJL754N/agent-platform/instances/v0.3.7/data`
- SDK home：上述目录下 `boxlite`
- 原 v0.3.7 代码／配置／launchd plist 和 .1 构建保留。
- .2 安装目录：`/Users/KYQXJL754N/agent-platform/instances/v0.3.11-native.20261014.2`
- 当前 launchd：`com.agent-platform.iflytek.v0311r2.api`／`.web`，切换回执 PID 46326／46330。原 v0.3.7 与 .1 标签均已退出。

维护前实际 ready／idle 为 true，七类业务 blockers、activeWS、inFlightHTTP、credentialAuth 均为 0。持 SQLite `BEGIN IMMEDIATE` 写锁再次检查没有存活用户沙箱及运行 AgentTask，然后先停旧 Web／API并等待其物理 PID 退出。才释放数据库锁、验证备份／数据并启动新版本；禁止两个 API 同时打开原 SDK home。`SANDBOX_RECONCILE_ON_BOOT=false` 避免启动时自行清理旧资源。此约束仅支持本次空闲实例维护，不能代替在线升级 admission／Owner 接管协议。

首次原生迁移前的完整私有 COW 备份位于远端 `/private/tmp/upg-iflytek-update-20261014-r1/frozen-backup-data-r3`。实际 32,317 个持久文件、7,405,030,805 逻辑字节、1,519 个 symlink；跳过 4 个临时 Unix socket，重建 2 个已核对的零字节 OCI whiteout，仅在私有备份中恢复文件组／SUID／SGID 元数据。检查文件类型／尺寸／权限／symlink target，并核对数据库及 master key；不是每个文件均执行 SHA256。真实 fixture 与完整备份 fixture 通过。部分诊断副本及失败回执保留。

原数据库有 24 条 Drizzle 迁移。独立 clone 的真实 24→28 迁移、及冻结原库的实际迁移均核对 18 个旧表的原列行数／排序散列一致；images 仅新增 alias=null，原 24 条迁移记录保留，quick_check=ok、外键违规 0、master key 相同。后续 .1→.2 不执行新 DDL：停旧进程后、新进程启动前，43 张现有表全部原列快照一致，schema 仍 28，并单独备份 schema-28 数据库。正常启动／验收产生的 audit 等记录不属于这个冻结快照承诺。

更新后原 data／SDK 绝对路径、master key 已独立核对，platform.db、.master.key、.upgrade-session-secret 均 0600，SQLite quick_check=ok、外键违规 0。实际进程工作目录来自 .2 校验产物，launchd 保留原 RunAtLoad／KeepAlive 配置。

## 真实失败、回退与停机

首次切换经历三次失败：Mac copy 遇到临时 socket／不可读 whiteout、copy 剥离 SUID／SGID 及复制组差异、实际迁移后 Python `mode=ro` 读取空 WAL 失败。原始失败保留。前两次数据库仍为 schema 24；第三次已迁移到 28，回退保留 schema 28 和当前数据。旧编译迁移器在 clone-28 通过，旧 v0.3.7 在实际 schema-28 恢复后健康返回 200。

回退先停止本轮目标并等待其物理 PID 退出，再恢复旧 launchd；不整卷恢复数据、不重建 SDK、不篡改任务状态。之后用 query_only 的正常连接核对已有 WAL 状态、迁移散列及完整性，最终 .1 启动成功；真实终端验收暴露身份缺口后，再构建并安装 .2。

以下均为从 IP 入口每 500ms 采样观察到的首个 API 失败至恢复 200，时间为 UTC（本地同日 +8）：

| 阶段 | 首失败 → 恢复 | 观测失败到恢复 |
| --- | --- | --- |
| socket／whiteout 失败回退 | 02:08:21.248Z → 02:08:35.766Z | 14.518 秒 |
| copy 权限失败回退 | 02:12:49.056Z → 02:13:09.085Z | 20.029 秒 |
| 空 WAL 只读失败回退 | 02:22:16.835Z → 02:22:32.051Z | 15.216 秒 |
| .1 成功切换 | 02:28:23.482Z → 02:28:27.655Z | 4.173 秒 |
| .2 成功切换 | 03:04:59.222Z → 03:05:03.726Z | 4.504 秒 |

各组之间存在成功请求，不能合并成连续停机。独立生命周期回执的 .2 停旧 Web 至新版本 ready 为 03:04:59.386Z→03:05:03.967Z，约 4.58 秒。本轮存在维护停机，不能称无停机部署。

.2 的 2 秒跨机监测从 03:04:37.113Z 至 03:12:36.828Z 共 630 个样本，API 37 次失败（9 次属于实际切换、其余 28 次为切换外超时），Web 24 次失败。原始失败全部保留，不能报告公网采样全通过。同期远端本机 15 轮 × 4 路径（API／Web／代理 API／自身 IP）共 60 次均 200，最大 6.5ms；跨机 10 秒独立诊断共 20 请求均 200，最大 2148ms。ICMP 3/3 成功但 RTT 288.894～848.680ms，Tailscale 后续 5 次直接路径探测 31～58ms、无超时。03:15:50.698Z～03:18:50.224Z 另一个 3 分钟观察窗口共 316 样本，API／Web 各有 2 个 2 秒 Abort，其余返回 200，未把新窗口描述为完全无超时。这些证据支持服务健康且跨机连接延迟波动的判断，但没有证明全部超时的单一根因，不能删除失败或用宽超时覆盖它。

## 终端身份修复与真实业务验收

.1 的真实 Guest 虽能启动，但 mono ProcessStream 没有 runtimeIdentity，终端错误地先发送 null ready，再进入 unconfirmed，input 被拒绝。最初 Node 验收客户端另有 withCredentials 空 CookieJar 覆盖显式 Cookie 的问题，修正为真实 unlock Cookie 后才定位服务缺口；不能把这两种失败算为通过。

修复读取相同 SDK home／boxId 的 shim.pid：Darwin 第二行是 epoch 微秒，不能套用 Linux /proc start ticks。使用系统 Python/libproc 的真实 BSD process info 查询 PID／微秒 birth，并与 SDK 两行记录严格匹配、二次读取防替换；缺失、退出、错误 PID／birth、查询失败均返回 unknown，不合成身份。Mono provider 在 SDK exec 成功后把真实 shim 身份传给 Exec／PTY stream；Owner RPC 共用同一查询。Gateway 先验证非空身份并设置 confirmed，再发送 ready，unknown 不开放 input。独立只读源码审查通过。

原 .1 失败 Guest 在实际 kernel 查询中证明 SDK PID 996／birth 1791945075334011 与 libproc 完全相同；随后仅通过普通 API 清理本轮自己的 Guest／empty 项目，未清理原 SDK／缓存或其他资源。

.2 真实 IP 浏览器登录与系统版本页通过，显示 Native2/API17，pageErrors=0、failedRequests=0。独立严格 cookie-only 见证使用全新 empty 项目和真实 headless BoxLite Guest，无模型调用、无 AgentTask；要求非空真实 runtimeIdentity、实际终端输入、实时 Guest PID／birth／boot／tmux、原 bookmark 重连及计数前缀。首次 .2 prepare 实际确认非空身份、输入成功并生成连续计数，但初始回显正则失败，原失败回执保留；不改写为 prepare passed。随后从真实 query-only 数据库读取本轮 shell 的公开 terminal_identity／runtime_identity（未读取私有 session/key），仅重新连接同一个已运行计数器，没有重播输入、创建新 shell 或替换 Guest。

严格恢复验收实际通过：原 bookmark `cefe42cd-6733-4f62-9ac9-d6cd733f3e51` 两次 cookie-only WebSocket ready 为 3634.66ms／1642.89ms，均 ≤5 秒，existingSession=true、protocolRevision=2、非空 runtimeIdentity 与持久化公开值完全相同。WebSocket 实际输出新增计数 739、740、741、742；实时 Guest PID=44、birth=2929、boot=`ff136a94-3a58-4cce-8717-7c61c328475f` 及 tmux digest 相同，完整计数前缀 738→746，无 AgentTask。

Root 另一次独立检查先因把原始终端画面重绘误当作计数回退而失败：单个真实 frame 包含 ANSI 清屏／定位及重复的 733～755 等屏幕行。保留该错误断言的脚本和原始失败，不据此改 Guest 或业务状态。改为以实时 Guest 文件验证完整递增前缀，并要求 WS 实际出现两个不同且晚于本次 live baseline 的计数值；允许终端正常重绘历史文本。重跑实际通过，连接 1256.59ms／1308.75ms、计数 855→862，Guest kernel／PID／birth／tmux／runtimeIdentity 不变，tasks=0，没有重播 input。

这些验收证明 .2 的真实终端输入／输出和同一运行 shell 重连，不证明跨维护升级的活跃任务连续性或模型 Agent 行为。初始 echo 检查并未补造成功，原始准备失败与两次后续真实业务验证分别记录。

验收后仅通过普通用户 API 停止／删除本轮 Guest 和 empty 项目，keepVolume=false／keepBaseline=false；项目 GET=404、其活跃沙箱列表为空，未直接清理原 SDK、镜像缓存或其他资源。03:24:06.867Z 最终 IP 检查：Web 200（68.94ms）、API health 200（455.73ms），Web releaseId／revision 精确匹配 .2；deployment ready／idle=true、draining=false，七类 blockers、inFlightHTTP、activeWS、credentialAuth 均为 0。Native mono 在线升级状态仍 unknown。清理回执 native-own-cleanup.json 和 native-post-cleanup-exact-public-proof.json 保留。

## 私有证据与后续范围

本机 `/tmp/upg-iflytek-update-20261014-r1` 和远端 `/private/tmp/upg-iflytek-update-20261014-r1` 为私有操作目录，敏感文件为 0600。主要回执：build-result-r2.json、switch-result-native-r2.json、post-native-r2-proof.json、public-ui-proof-r2.json、public-maintenance-samples-r4.json、native-health-diagnostic.json、direct-public-diagnostic.json、public-maintenance-samples-r5.json、existing-native-book-proof-r1-raw-repaint-order-refused.json、existing-native-book-proof-r2.json、api-pure-format-proof.json，以及保留的三次失败／实际迁移／备份 fixture 证明。凭据不进入 Git／安装包／报告。

远端 WorkProject 仓库 `/Users/KYQXJL754N/WorkProject/cloud-agent-platform-docs` 已在确认 Root／API／Web 均无本地改动后，更新到 .2 冻结 Root1276／API17／Web11，detached checkout 且工作区干净。本报告提交后可同步 Root 的文档提交，API／Web 保持包的固定提交，冻结服务安装包不受报告提交影响。

原始失败沙箱见证位于 `/tmp/upg-iflytek-validation-20261014-r1`；新严格业务见证位于 `/tmp/upg-iflytek-validation-20261014-r2`，实际成功回执 native-recovered-business-verification.json、两次 ready／raw data／live snapshots 均保留。原 Orca／Claude transcript 始终只读，未恢复／修改原 provider session。

后续仍需实现并验收 Darwin 的常驻入口／Owner／Installer 生命周期适配、管理员触发的在线升级、真实 API／Web 替换与活跃任务连续性、原生资格矩阵和故障回退。当前不启用 Linux 的旧自动 deploy/promote，也不将本次维护结果作为这些资格通过的证据。主 Linux 的历史结果见 [线上首次更新与实验发版](2026-10-14-线上首次更新与实验发版.md)。
