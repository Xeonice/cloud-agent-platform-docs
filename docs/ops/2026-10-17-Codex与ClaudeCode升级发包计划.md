# Codex 和 Claude Code 版本升级与实验发包计划

本轮目标是发布新版沙箱镜像及平台实验包，并在用户明确授权后更新两台实例。升级前的沙箱继续运行原来的 CLI，升级后新建的沙箱使用新版 CLI。2026-10-17 用户已明确要求「发包，然后更新一下……线上的实例」，这次由运维使用实例已有访问权限提交升级请求；CD 仍只发布产物，不自动部署。本文记录实施方案，实际发布与安装结果以本轮验收收据为准。

本轮执行已完成：两台实例分别运行`v0.3.13-experiment.online.20261017.7`和`v0.3.13-experiment.iflytek.20261017.7`，均confirmed／ready1／schema29；新默认沙箱实测Codex0.163.0、Claude Code2.1.302，原沙箱身份保持。远端首次新沙箱准备约10分钟，原启动调用保持inflight后自然成功，未重复启动。实际结果、历史失败及正式五gate／真实模型任务的未覆盖范围见[完整验收记录](../testing/results/2026-10-17-CLI镜像与双实例更新验收.md)。

## 版本与验证实例

升级前两个沙箱 Dockerfile 固定 Codex `0.150.1`、Claude Code `2.1.251`；本轮源码已固定 Codex `0.163.0`、Claude Code `2.1.302`，并分别核对官方发布记录和 npm latest 元数据。实施时固定这些具体版本，构建期间不跟随 latest 变化；这是 CLI 升级，不主动修改用户显式模型／权限配置。未显式配置时，新 CLI 的默认模型及行为须单独核对。

| CLI | 升级前固定版本 | 本轮目标 | 官方来源 |
| --- | --- | --- | --- |
| Codex | 0.150.1 | 0.163.0 | [OpenAI Codex v0.163.0 官方发布记录](https://github.com/openai/codex/releases/tag/rust-v0.163.0) |
| Claude Code | 2.1.251 | 2.1.302 | [Anthropic 的 v2.1.302 发布记录](https://github.com/anthropics/claude-code/releases/tag/v2.1.302) |

Claude Code 当前 npm 包要求 Node ≥22；两类镜像现用 Node 22，但仍须在实际执行用户的 PATH 下验证。官方支持固定版本安装，并提供禁用后台更新的配置，见 [Claude Code 安装与更新](https://code.claude.com/docs/en/setup)。

管理员已确认：先将 `100.73.71.22` 统一为与本机一致的 **macOS 宿主 → Colima Linux arm64／VZ 嵌套虚拟化 → Docker 分离角色**，再开展本轮 CLI 发包和管理员现场升级。平台使用同一套常驻入口、ControlAPI、Coordinator、RuntimeOwner、Installer／Supervisor 链路，不为远端另建服务部署分支。

统一模式与操作边界见 [统一虚拟化与实例部署](./统一虚拟化与实例部署.md)。远端已完成 `.3` 基础迁移、真实浏览器／Guest／终端验收与来源封存退役；实际收据见 [迁移验收报告](../testing/results/2026-10-17-统一部署与在线升级验收.md)。后续 CLI 包从已确认的 `.3`、instanceId `agent-platform-iflytek-20261017-r1`、channel `experiment-iflytek-online-20261017-r1` 出发，不将基础迁移当作跨升级或模型连续性通过。

主线上 `agent.douglasdong.com`／`agent-api.douglasdong.com` 继续保留；2026-10-17 05:55:17Z 的只读快照为 `v0.3.11-experiment.20261014.1`、generation=3、confirmed／ready=1，历史 ready-revoked 为 B 的 1 条。这是该时点的基线，不是远端已迁移或当前包具备完整资格的证明。

## 必须一起交付的内容

CLI 实际在沙箱 OCI 镜像中，平台 tar 只携带 API、Web、Installer 等角色。仅发新平台包，或重推镜像 latest，都不能使现有实例的新任务得到新版 CLI。

| 范围 | 实施内容 |
| --- | --- |
| 镜像 | 更新 API 仓 `images/platform-boxlite/Dockerfile`、`images/platform-sandbox/Dockerfile`；保留 AIO 的 Node prefix／实际用户 PATH 处理。发布两类镜像各自的 linux/arm64、linux/amd64，记录不可变 tag、索引及平台 digest、实际 CLI 版本。 |
| 安装回退 | 两个 adapter 缺失 CLI 时的安装也固定到本轮版本；两份 Dockerfile 与回退版本有一致性检查。探测到已有可运行 CLI 的旧沙箱继续使用原版本，不在里面执行 npm upgrade。 |
| 内置镜像登记 | 修正 `ImageSeeder` 按 repository 已存在就跳过的行为。仅通过受控 builtin 路径补登记本次缺失的固定版本；普通用户注册不得获得 builtin 豁免。保留旧 manifest、digest、配置、别名、用户禁用状态和同 tag 的激活选择。 |
| 默认引用 | 平台包绑定本次已验证的镜像坐标；新 tag 首次登记可 active，旧 tag 继续 active。provider 默认按精确坐标选择，不跨 tag 停用旧版本。 |
| 前端 | 复用已有新版本提示、已有访问保护下直接升级、百分比进度与自主刷新／重连流程。无新增界面或设计稿改版；须验证镜像选择返回新默认，显式选择旧镜像仍有效。 |
| 发布 | 发布不可变 OCI 镜像及可下载、可校验的 Linux arm64 实验包与发现目录；CD 不发送实例升级命令，不刷新页面、不停止沙箱。 |

升级前 bootstrap `providerEnv.SANDBOX_DEFAULT_IMAGE` 显式为 `ghcr.io/xeonice/agent-platform-boxlite:latest`。本轮将这两类历史官方 latest 引用识别为受管默认，由目标平台包解析到固定版本；回退运行旧包时恢复旧规则。自定义 tag／digest、provider 覆盖和用户显式选择保持原优先级。受控 Seeder 仅补入 builtin repository 缺失的精确引用，保留旧 manifest、别名、禁用状态和任务快照；发布阶段不提前改活跃实例配置。

内置镜像登记已移出控制面交接窗口：prepared Coordinator 在原 writer 仍服务的 prepare 阶段获取、校验固定镜像元数据，以进程内不可伪造的 prepared handle 保存结果，此时不写业务库、不启动 worker。adopt／listen 只消费已验证本地结果完成幂等登记，不再触网；控制暂停预算仍不超过 2 秒。registry 慢或离线且本地材料不足时，在交接前拒绝或延后，不能延长预算或先确认再补默认镜像。

镜像发布器现已分成 check、publish、promote：publish 只发布不可变版本，promote 必须显式指定已存在且两架构校验通过的固定产物才提升 latest，不能顺带构建或把 latest 漂移当作实例升级。已有任务已冻结的 manifest／digest 始终不改。

## 实施与发包顺序

1. 升级前的物理来源分别固定为本机已确认 C 版（generation=3）和远端旧 `.3`（generation=1），各自冻结实例／渠道、角色与原始资源身份、基线提交及 CLI 版本；历史预演身份或通过结论不能代替本轮测量。CLI 更新本身不改表；同时交付的镜像 CLI 版本展示需要 `image_manifests.runtime_versions` 新列，实际路径因此是 **旧版 schema28 → 兼容桥接版 schema28 → 最终版 schema29**。不能把 29 伪报为 28 或让旧 Installer 执行未知迁移。
2. 通过 `deploy/jenkins/sandbox-images.mjs` 发布链构建两类、两架构镜像，验证实际版本、PATH、tmux、终端、登录／协议入口。可先固定不可变坐标并行构建平台包；向实例提供发现目录、激活实例前必须完成真实镜像、匿名拉取与 digest 校验。
3. 用冻结三仓提交构建候选 Linux arm64 包，在隔离且与线上同构的 KVM／BoxLite 环境验证真实角色更新、旧 Guest 连续性及失败恢复。不能直接把上一轮 Installer-only 的成功结果套用到本轮。
4. OCI 固定 tag 为 `v0.3.12-cli.20261017.1`，本轮实际候选为`.20261017.7`：本机桥接 `v0.3.12-experiment.online-bridge.20261017.7`、最终版 `v0.3.13-experiment.online.20261017.7`；远端桥接 `v0.3.12-experiment.iflytek-bridge.20261017.7`、最终版 `v0.3.13-experiment.iflytek.20261017.7`。桥接Root／API冻结为`ae17c1d5…`／`39cd9da0…`，最终版为`5c7db2f4…`／`da3f99f1…`，共同Web源码`30c58400…`。历史`.1`至`.6`的包、失败及签名记录均保留，下文按轮次记录；旧失败候选不得再安装，不能覆盖原资产。最终版提升patch以保证版本排序，仍使用实例限定渠道及原信任根。
5. 上传非 Latest prerelease 的安装包、摘要、签名、目录及发布说明。隔离演练通过后，按本轮用户的明确更新授权依次安装本机、远端；每个实例先桥接再最终版。没有用户升级授权的日常发布仍止于发现目录，不自动提交升级请求。
6. 实例收到已授权的升级请求后，按独立测试计划记录实际更新、刷新及新旧沙箱版本。失败时记录原始状态和回退结果，不通过改数据库 ready、重造 Guest 或删除历史事件完成验收。

普通正式发布器要求当前输入的正式资格通过。若仍沿用本次实验链路，就明确发布为实验包，不把历史 not-run 改为 passed；不重新启用旧的自动 deploy/promote 流程。

## 已发布 `.4` 平台包冻结输入（最终版已停用）

以下是平台运行包的实际三仓冻结提交；后续文档、CI 或独立运维工具提交不追认替换这些输入。CLI OCI 镜像的构建／发布 revision 另以镜像收据记录。

| 阶段 | Root | API | Web |
| --- | --- | --- | --- |
| schema28 桥接包 | `a2f4b527baabc7c76cdf1fd11d46e7eb504ff38f` | `32c245ac9be0eecefe99363e0fcfa07628a6f58f` | `fb51154caf57608440d2a2443b5e38a70a417cc5` |
| schema29 最终包 | `f21e90016c75f040c65b412e25e0e39bd3fbdf70` | `6157b5349d6cfd00552d6c78600fa6a374556eca` | `fb51154caf57608440d2a2443b5e38a70a417cc5` |

包名规则为 `agent-platform-<releaseId>-linux-arm64.tgz`。四份候选已完成原生构建、解包全树、依赖／ABI 探针、导出哈希和下节目录检查；这些检查不代表跨升级、业务连续性或正式资格通过。

| releaseId | 字节数 | 包 SHA-256 |
| --- | ---: | --- |
| `v0.3.12-experiment.online-bridge.20261017.4` | 94,269,300 | `4c05056ca2615ddca5898b53eacc51a614412479679ae0e327f65f2dde7a6153` |
| `v0.3.12-experiment.iflytek-bridge.20261017.4` | 94,270,111 | `1e3ee84fb99424e779adecf1f8b1d2719cd4e9f856df24cc04577b2909cfe70d` |
| `v0.3.13-experiment.online.20261017.4` | 94,296,552 | `ecc21b0b735959b8c18572ecc75a956d0f7d5637c9cc39923689f433a4654c1b` |
| `v0.3.13-experiment.iflytek.20261017.4` | 94,299,660 | `5efcbeea7da51b5c4270e11fc3886393241b9eada5b4cbfead36d36dc14356ae` |

`.4` 四包实际编译 2 次 API、0 次 Web：本机桥接／最终包各从冻结 API 提交编译一次，Web 分别从对应 `.3` 已签验包验证签名、整包摘要及全树后严格复用；远端桥接／最终包再分别从已签验的本机 `.4` 包严格复用完整 API／Coordinator／Owner／Web 元组和文件树。Installer 使用各阶段冻结 Root；同阶段本机／远端包的 Installer 元组相同，较各自 `.3` 来源实际变化。桥接两包的完整 tree digest 相同，最终两包也相同。这种构建复用不等于实际旧实例的角色复用：从旧 C／远端旧 `.3` 到桥接版，以及桥接版到最终版，仍以实际冻结 plan 判定 API／Coordinator／Owner 更新范围，保留旧 Owner 与 Guest。每包保留 `build-result.json`、命令日志、`host-copy-proof.json`、`cache-layout-proof.json`；四包汇总及独立签验收据由私有操作证据保存。

## 修正后的两个最终版 `.5`

本机bridge4实际成功后，独立核验发现：attempt generation5、成功activation generation4符合既有API的两个独立计数契约；失败尝试占前者，只有确认成功才增加后者。原operator错误等式及失败收据保留，另作只读对账，不能改数据库或重新提交已成功请求。`.4` Installer的链式来源检查也错误关联了这两个计数，因此两个final4禁止安装，另发两个不可变final5，已成功的bridge4保持。

最终版冻结Root `91848dfd5df3f226145c0e788cd27d8797ae2a07`／API `6157b5349d6cfd00552d6c78600fa6a374556eca`／Web `fb51154caf57608440d2a2443b5e38a70a417cc5`。仅Installer更新，API／Web从签验过的final4严格复用，本轮0次API／0次Web编译。新包为`v0.3.13-experiment.online.20261017.5`及`v0.3.13-experiment.iflytek.20261017.5`，原`.4`包、签名及失败证据均保留；固定迁移配方、schema29和CLI镜像坐标不变。

连续升级以prior真实source activation与其plan一致、成功确认加1等于当前source activation，且prior attempt编号小于新attempt编号作关联，继续核验完整fence／组件元组／候选回执／活进程／绑定竞争／新鲜度。真实Entry及原WebSocket回归增加失败占代正例与9个错配拒绝，相关升级测试213项全通过；不把快速测试当作真实升级资格通过。

## 来源状态与受理代次

本轮 `.4` 请求准备时，本机最后确认的基线为 C、activation generation=3；失败的 `.3` 桥接 attempt 已占 generation=4，不能把下一次受理当作 4。`.4` 修复桥接请求须从实际 `repairableCurrent`／`sourceActual` 冻结当前混合组件，保留基线 C 与原 Owner／Guest 身份；桥接预期accepted attempt generation=5、成功activation generation=4；确认后final5从activation4受理attempt6，成功activation generation=5。失败态路由恢复属于独立受限运维操作，不能改写原 failed 结论、sequence、ready 或 schema 来获得升级资格。

远端旧 `.3` 的已确认activation generation=1，bridge4／final5预期accepted attempt generation=2／3，成功activation generation也分别为2／3。以上是各阶段请求必须核对的代次，不是安装成功回执；分别以实际受理attempt generation、数据库attempt记录及confirmed activation generation交叉确认；只有后者从原activation加1，不能把两个计数当作同一序列或在未知提交后重新发送请求。原 `.3` 失败包、attempt 和测量继续保留，历史通过结论不继承到 `.4`。

## 兼容常驻 Foundation 的产物证据

Web staging 在打包前创建空 `web/.next/cache`，tar 必须包含该目录；Web 变化的桥接步骤由旧 Supervisor 复制并启动新 Web，沿用现有 bind 规则。最终版复用同一 Web 时不再次启动或绑定，仍核对包内空目录和复用身份。新 Supervisor 同时检查并创建缓存目录。空目录不进入文件 tree manifest；四包已实查 tar header 为目录、无子项，Web 文件清单与复用来源逐条一致。此次修复通过新包交付，不修改失败 attempt 已产生的 process-code，也不要求重启线上常驻 Foundation。

历史 bootstrap 的执行根位于独立 artifact volume，新 Coordinator 只能看到既有 `installer/artifacts` 只读挂载。准备阶段可在该目录建立原包的受控内容验证副本，并保留 `artifacts/.retained-packages/<原包摘要>.tgz`。API 仅在固定原根路径本身为 `ENOENT` 时允许这个 canonical 副本；原根可见却损坏、任意其他路径、假 installed 摘要、错组件元组、错原包哈希或坏文件树均拒绝。原包整流哈希、installed identity、完整历史组件元组和全文件树须同时一致；副本只用于内容验证，不替换真实执行根、角色启动身份、旧进程健康检查或 Owner 路由，不执行副本代码，也不伪造下载进度或升级收据。

已有签名来源先按原 envelope／固定信任关系验证。本机更早的初始 A 包若没有可用 envelope，仅使用已确认的物理基线 exactRoot／原包哈希／完整组件元组和全树核验作证据锚；不补造签名，不把它称作新签验通过。缓存准备不改变原包、配置、业务数据库或运行角色。新 Coordinator 无法读取初始 release 文件时，使用本实例已受理 attempt 中持久化的初始 `source_activation`；要求 generation=1 的完整锚一致，可见的原 receipt 若冲突仍拒绝。

失败后的混合安装检查可能读取旧 Web／Owner 组件，因此 Web fallback、完整 fallback 和 `sourceActual` 共用这套证据解析。一次 status 请求内复用同一次源测量及树校验，避免 catalog 与 repair 投影重复全树扫描；下一请求重新验证，不用长期缓存掩盖篡改。两份 API 的 19 项针对性检查已通过，覆盖上述拒绝路径、初始文件不可见及同请求复用／跨请求重验；真实升级与用户感知结果仍由独立验收报告记录。

## 最终激活的观测作用域

Web 绑定会递增 `routeGeneration`，即使 API 权重已经是 100%，此前 observe-100 的观测窗口也不能直接用于最终确认。新 Installer 保持实际入口绑定、100% 权重、controller fence、Coordinator generation 和 Observer epoch 不变，以约 1 秒间隔读取现有 Observer；真实请求仍由独立 10 Hz 探针采集。必须在该新作用域完成至少 60 秒及签名策略要求的窗口、样本和延迟门禁，不能复用旧代次的相同计数或重写路由来保留旧窗口。

旧 API 的启动身份从持久 observe-100 源收据锁定；该收据缺席时才使用已确认 handoff 的完整源锚。observe-100 存在时，Web 复用要求其路由代次与当前完全相同，Web 重新绑定要求恰好增加 1；意外跳代、错身份、无锚或冲突锚均拒绝。最终版复用 Web 时没有绑定操作，同一真实作用域内已有的完整合格窗口可以直接使用，不重启 Web 或重复角色动作。

精确的无样本状态保留未知值，只表示等待，不能制造零延迟或通过票数。等待仍持续检查实际 Web、Owner／writer、原资源连续性和硬故障；身份变化、fence 丢失或真实失败立即拒绝。软退化的连续票按签名 `evaluationIntervalMs` 计时，读取频率不能加速判定。一次总预算覆盖全部读取，超时后迟到的只读结果不再确认或重试；返回前再次核对观测及源证明的时间，后续检查耗时不能把过期证明重新盖成新时间。

[最终激活边界测试](../../deploy/upgrade/native-activation-window.test.mjs) 覆盖真实 HTTP 合约中的新窗口／Web 复用分支、错误作用域和源锚、空样本、故障／超时、软票间隔及慢尾部读取。`.4` 根仓升级模块 199 项全部通过；API 主分支升级回归 238 项、桥接分支相关回归 50 项全部通过。`.3` 的组合回归曾为 612 项（608 通过、4 项预期跳过），不作为 `.4` 的新组合回归计数。这些快速合约测试不冒充真实 60 秒流量或跨升级连续性验收，`.1`／`.2`／`.3` 的失败 attempt 和原始测量继续保留。

## 链式升级来源入场与实际探针

前一次确认后，Entry 可能仍保留 weight=100、candidateApi 为当前实际服务 API 的绑定。新 attempt 在 Owner 准备及候选评估前，必须将它规范为 weight=0、oldApi 指向同一个实际服务端点／摘要、candidateApi 清空，并使用新 attempt／fence 及 routeGeneration+1。先核对本次真实 sourceActivation／sourceActual、上次 activation-confirmed 的完整 API 元组、相同旧 fence、持久 candidate receipt 与实时 process incarnation；再次读取完整不可变绑定、验 fence 后通过 Entry 代次竞争检查写入并核对精确回执。HTTP 继续使用同一实际服务 API，原 WS、Web、retainedWeb 与 Owner 连接不重建。活跃灰度、同 attempt 的 weight100、错进程／元组、绑定竞争、失效 fence 或陈旧证明均拒绝；原 weight0 metadata admission 保持，候选／角色总启动预算不增加。

API 探针只投影当前 plan／manifest／source、实时 lease／fence 和已 applied 的 candidate receipt；不再为每条采样解码所有历史观测／连续性收据。`assertFence` 保留原最新 attempt、contract fence、generation 和 lease 校验，只避免间接读取历史大 steps。没有缓存动态控制权、放宽样本／窗口／失败门禁、降低实际探针门槛或制造通过采样。`.4` 的投影修复须由本轮真实窗口重新验证，不能以快速测试代替现场吞吐或声称 status 延迟门禁已通过。

[链式来源入场测试](../../deploy/upgrade/native-source-admission.test.mjs) 使用真实 StableEntry／HTTP／原 WS 合约，覆盖连续两次 API 更新、Owner 准备前入场、精确来源与进程证明、竞争／超时拒绝；[SQLite 探针投影测试](../../api/acceptance/upg/sqlite/upgrade-store.spec.ts) 覆盖多 MB 历史收据不被读取、实时 lease／fence、未 applied candidate 和最新 attempt 选择。它们属于上节 199／238／50 项回归范围，不另计现场连续性成功。

## 本轮有界加列与回退

桥接版保留真实的 28 条 migration，仅增加识别一份固定加列配方的能力。最终版携带真实第 29 条 migration：`ALTER TABLE image_manifests ADD runtime_versions text DEFAULT '{}' NOT NULL`。其配方固定来源／目标 journal、列摘要、SQL hash 和 migration 时间；不接受任意包中 SQL。

迁移由仍持有 writer／controller fence 的旧桥接 Coordinator 在 `BEGIN IMMEDIATE` 事务内完成：加列、写真实 Drizzle journal、记录 operation receipt；提交前再次验 fence，保留 WAL、锁等待、磁盘与时间预算。新 Coordinator 的联网镜像准备发生在原 writer 仍服务时，交接时消费已验证的本地结果。

提交前失败回滚事务；提交后若候选失败，保留新增列和原数据，回退到桥接版。桥接版只有在实际 journal、列结构和迁移 receipt 全部匹配时才接受 schema29，并支持冷启动；不删除列、不回写整库、不把未来未知 schema 当兼容。完整角色更新按原 Owner 资源归属路由，保留旧 Guest。

## 固定信任根与持续签名

远端基础实例已完成正式迁移、实际业务与来源封存退役；其初始实验信任材料在创建前准备为私有证据中的 `r2/signed-production-persistent`，在保留当时 `.2` 包与原 envelope 字节不变的前提下，追加持续发布公钥。固定信任根 digest 为 `sha256:6827a3be8d19449c8060d3035f5e319094e5fb84702b16df7ec33a75482ef6fe`；实例／渠道仍为 `agent-platform-iflytek-20261017-r1`／`experiment-iflytek-online-20261017-r1`。原信任材料归档，不能把准备新初始根描述为已变更某个活跃安装。当前迁移基础包已调整为 `.3`，由这份原字节固定根与本机持久 key 重新签名；r3 预演使用另外的独立根，不能混入正式目标。

本机 C 版原来的两个历史发布私钥已不可用。本轮保留这两个公钥、历史 envelope、实例／渠道／purpose 和下载域，仅追加持久发布公钥，并同步 installation proof 的 root 摘要。该操作保持现有只读绑定文件的 inode，采用原字节／版本 CAS，失败恢复原字节；不换实例、不改业务数据库、不停止角色。追加后 root 摘要为 `sha256:acc02c445600a3e665692dda7d90c3fcd57a7e11a73e65ce0f70e6d7c2baaa58`；是否已安装须以实际安装收据为准。远端保持既有 root 原字节。这里的发布签名属于产物完整性机制，不向用户增加升级密钥或授权步骤。

后续候选 manifest 使用现有 `signQualificationManifest`，显式输入该固定信任根和本机持久发布私钥。不得调用 `buildQualificationDistribution` 为每次候选重新生成 key／trust root，再把新根覆盖到实例。包、manifest、catalog 的实例、渠道、purpose、来源／目标及镜像坐标必须相符；历史版本与 envelope 继续可按既有信任关系验证。所需信任材料不匹配或过期时停止发包，不能扩大作用域或用新根绕过校验。

发布私钥只保存在本机受控持久目录，父目录 0700、文件 0600；具体私有路径仅在操作收据中记录。私钥不传目标机器、不进 GitHub Release、安装包、仓库或日志。远端只接收公钥及签名元数据。本轮 40,960 字节公元数据归档已传到远端，不表示后续 CLI 版本或安装包已经发布。

真实 API 与 Installer 的未来候选签验、8 组负例检查已经通过，只证明这组固定信任材料具备持续签名和拒绝不合法材料的能力。它们没有触发实例升级，也不证明 Guest 业务、迁移、原任务连续性或 CLI 新版本发包通过。本轮镜像与平台包的具体发布、安装及资格范围另记入本轮结果报告，不以信任关系检查代替业务验收。

## 本次真实替换范围

现有打包器对 API、Coordinator、Owner 使用完整 API 文件树及同一输入指纹。Dockerfile／Seeder 改动也会进入指纹，因此本轮不能伪造指纹、删 Owner 字段或声称继续 Installer-only 复用。最终范围以构建收据及实际角色计划为准；Web 若完整输入／产物一致可按现有门禁复用。

当前源码的 Owner 升级是新旧并存：新 Owner 使用独立 SDK home；切换未来分配的 activeOwnerId，旧资源的 assignment／路由仍指向原 Owner，旧 Owner 不因升级被停止。原始资源基线须同时冻结 Owner journal 和 SDK 的 running 集合及对应 Owner／SDK home，逐项核对保留；业务库沙箱或任务数为 0 不能作为资源为空、清理资源或停止旧 Owner 的依据。新 Coordinator 恢复所有 Owner 路由。这条路径需要本轮先在隔离环境实测；也须核对线上常驻 Supervisor／adapter 与被测实现一致。回退不得停止仍有新任务的新 Owner，也不整卷回写业务数据。

## 用户验收时应看到的结果

升级前，保留一个真实沙箱中的 tmux 计数器或现有任务，并保存原终端书签。发布新包只出现新版本提示，不改变当前版本或沙箱。

点击升级后，页面展示真实进度。完成后用户主动刷新，原书签应在 5 秒内确认回同一 Guest／shell，计数前缀完整、进程及内核身份不变。原沙箱中的旧 CLI 继续运行；另建沙箱才应检测到 Codex `0.163.0`、Claude Code `2.1.302`，且默认镜像的真实 digest 与发布收据一致。

独立验收范围、前后端场景和证据要求见 [CLI 升级与用户触发更新测试计划](../testing/changes/2026-10-17-CLI版本升级与用户触发更新测试计划.md)。主线上历史基线见 [线上首次更新与实验发版](../testing/results/2026-10-14-线上首次更新与实验发版.md)；远端来源基线以本轮统一迁移的实际验收记录为准。


## final5迁移保护后的后续版本

本机final5未成功：500ms批次预算保护使迁移事务完整回滚，schema仍28；原Guest24项对照保持，实际Installer已交接但API／Coordinator仍bridge4，后续必须以真实混合来源资格恢复。完整失败与只读扫描数据见验收报告。

历史已发布的`.6`同时更新桥接与最终API，因为首次28→29迁移由仍运行的旧桥接Coordinator执行，只改最终包不能修复这条路径。全库完整性及外键检查移出短写事务，在独立只读worker前后执行；仍保持500ms、atomic DDL／journal／receipt、image表事务内检查及await后fence复核。前端只扩大升级控制请求等待到240秒，Native prepare／status另有120秒控制预算，批次与健康／attach门禁保持。已实际完成两个API编译、一次新Web编译，后续包严格复用已签验同产物，未沿用`.5`冻结SHA。bridge Root／API为`c1f6f351…`／`759496fa…`，final为`456d7923…`／`a5fa8a6b…`，共同Web为`30c58400…`、实际Web revision为`071ee315…`；四包已签名发布且两台实际Installer完整下载验SHA通过。具体版本、字节和完整摘要见[本轮验收](../testing/results/2026-10-17-CLI镜像与双实例更新验收.md)，分发成功不等于线上安装完成。

R3使用100.73.71.22现有专用虚拟机里的全新隔离命名卷及私有端口，保留8GiB可用内存／20GiB可用磁盘准备门槛；通过只读预检、固定旧2cfa工具和新的独立签名材料后才创建，不能挂载生产业务／Owner卷或传生产口令／发布私钥。R3的`.7`真实约1GB数据库28→28→29、Native完整窗口、原书签续接、新CLI执行和普通API自有清理已通过；原桥接外层SSH采样6次catch仍保留为失败，不追认为通过。线上安装结果以[本轮验收](../testing/results/2026-10-17-CLI镜像与双实例更新验收.md)的实际记录为准。
