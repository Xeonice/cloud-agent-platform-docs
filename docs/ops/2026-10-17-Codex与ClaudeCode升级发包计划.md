# Codex 和 Claude Code 版本升级与实验发包计划

本轮先确定升级、发包和验收路径。实现目标是：发布新版沙箱镜像及平台实验包后，由管理员从页面决定何时升级；升级前的沙箱继续运行原来的 CLI，升级后新建的沙箱使用新版 CLI。本文是后续 CLI 升级的实施计划，尚未修改本轮 CLI 版本、构建新版 CLI 镜像或发布后续 CLI 升级包；与统一部署的基础包构建分别记录。

## 版本与验证实例

截至 2026-10-17，两个沙箱 Dockerfile 均固定 Codex `0.150.1`、Claude Code `2.1.251`。目标版本为 Codex `0.163.0`、Claude Code `2.1.302`，已分别核对官方发布记录和 npm latest 元数据。实施时固定这些具体版本，构建期间不跟随 latest 变化；这是 CLI 升级，不主动修改用户显式模型／权限配置。未显式配置时，新 CLI 的默认模型及行为须单独核对。

| CLI | 当前代码固定版本 | 本轮目标 | 官方来源 |
| --- | --- | --- | --- |
| Codex | 0.150.1 | 0.163.0 | [OpenAI Docs 的 2026-10-15 CLI 发布记录](https://learn.chatgpt.com/docs/changelog) |
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
| 前端 | 复用已有新版本提示、管理员升级授权、百分比进度与自主刷新／重连流程。无新增界面或设计稿改版；须验证镜像选择返回新默认，显式选择旧镜像仍有效。 |
| 发布 | 发布不可变 OCI 镜像及可下载、可校验的 Linux arm64 实验包与发现目录；CD 不发送实例升级命令，不刷新页面、不停止沙箱。 |

现网有一项需要在实现中明确处理：bootstrap `providerEnv.SANDBOX_DEFAULT_IMAGE` 显式为 `ghcr.io/xeonice/agent-platform-boxlite:latest`。新角色会继承它，所以只修改代码内置坐标仍无效。必须为本次受管官方默认设计**随目标版本生效、随回退恢复**的引用解析／配置绑定，并核对实际角色得到的引用；发布阶段不提前改活跃实例配置。自定义 tag／digest、provider 覆盖和用户选择不得被一概覆盖。此项与 Seeder 联动必须在发包前完成验证。

内置镜像登记还必须避开控制面交接窗口：当前 prepared Coordinator 在 adopt／listen 时才触发 Seeder，联网等待可达 10 秒，而交接控制暂停预算为不超过 2 秒。应在原 writer 仍服务的 prepare 阶段完成固定镜像元数据的获取、校验及可恢复准备，adopt 只使用已验证的本地结果完成有限切换。具体持久化／幂等实现需随代码补齐；registry 慢或离线且本地材料不足时，在交接前拒绝或延后，不能延长预算或先确认再补默认镜像。

现有镜像发布器也会更新 latest 别名；实施时将不可变版本发布与别名提升的时机明确分开，不能把 latest 漂移当作实例升级。已有任务已冻结的 manifest／digest 始终不改。

## 实施与发包顺序

1. 以已完成基础迁移的 `.3` 为来源，固定实际实例／渠道、基线提交及 CLI 版本，补齐安装回退、内置镜像版本登记、版本绑定默认引用的代码与必要回归；本轮预期不新增数据库 schema 迁移。
2. 通过现有 `deploy/jenkins/sandbox-images.mjs` 发布链构建两类、两架构镜像，验证实际版本、PATH、tmux、终端、登录／协议入口；验证匿名拉取与 digest 后，才能把坐标写入平台包。
3. 用冻结三仓提交构建候选 Linux arm64 包，在隔离且与线上同构的 KVM／BoxLite 环境验证真实角色更新、旧 Guest 连续性及失败恢复。不能直接把上一轮 Installer-only 的成功结果套用到本轮。
4. 检查版本标签未占用后，可使用 `v0.3.12-experiment.20261017.1`；使用已验收实例的专属实验渠道，升级路径明确从它实际确认的来源版本出发。按下节固定信任根与持久发布密钥签名，核对作用域、有效期和旧版本验证／恢复能力；不能为本次发包临时生成替代信任根。
5. 上传非 Latest prerelease 的安装包、摘要、签名、目录及发布说明，更新该实例的发现目录。确认页面能发现新版本且实例仍运行原确认版本，**到这里停止自动操作，等用户自己点击升级**。
6. 用户点击后按独立测试计划记录实际更新、刷新及新旧沙箱版本。失败时记录原始状态和回退结果，不通过改数据库 ready、重造 Guest 或删除历史事件完成验收。

普通正式发布器要求当前输入的正式资格通过。若仍沿用本次实验链路，就明确发布为实验包，不把历史 not-run 改为 passed；不重新启用旧的自动 deploy/promote 流程。

## 固定信任根与持续签名

远端基础实例已完成正式迁移、实际业务与来源封存退役；其初始实验信任材料在创建前准备为私有证据中的 `r2/signed-production-persistent`，在保留当时 `.2` 包与原 envelope 字节不变的前提下，追加持续发布公钥。固定信任根 digest 为 `sha256:6827a3be8d19449c8060d3035f5e319094e5fb84702b16df7ec33a75482ef6fe`；实例／渠道仍为 `agent-platform-iflytek-20261017-r1`／`experiment-iflytek-online-20261017-r1`。原信任材料归档，不能把准备新初始根描述为已变更某个活跃安装。当前迁移基础包已调整为 `.3`，由这份原字节固定根与本机持久 key 重新签名；r3 预演使用另外的独立根，不能混入正式目标。

后续候选 manifest 使用现有 `signQualificationManifest`，显式输入该固定信任根和本机持久发布私钥。不得调用 `buildQualificationDistribution` 为每次候选重新生成 key／trust root，再把新根覆盖到实例。包、manifest、catalog 的实例、渠道、purpose、来源／目标及镜像坐标必须相符；历史版本与 envelope 继续可按既有信任关系验证。所需信任材料不匹配或过期时停止发包，不能扩大作用域或用新根绕过校验。

发布私钥只保存在本机受控持久目录，父目录 0700、文件 0600；具体私有路径仅在操作收据中记录。私钥不传目标机器、不进 GitHub Release、安装包、仓库或日志。远端只接收公钥及签名元数据。本轮 40,960 字节公元数据归档已传到远端，不表示后续 CLI 版本或安装包已经发布。

真实 API 与 Installer 的未来候选签验、8 组负例检查已经通过，只证明这组固定信任材料具备持续签名和拒绝不合法材料的能力。它们没有触发实例升级，也不证明 Guest 业务、迁移、原任务连续性或 CLI 新版本发包通过。本轮 CLI 镜像、候选平台包及对外发布仍待实现和验收。

## 本次真实替换范围

现有打包器对 API、Coordinator、Owner 使用完整 API 文件树及同一输入指纹。Dockerfile／Seeder 改动也会进入指纹，因此本轮不能伪造指纹、删 Owner 字段或声称继续 Installer-only 复用。最终范围以构建收据及实际角色计划为准；Web 若完整输入／产物一致可按现有门禁复用。

当前源码的 Owner 升级是新旧并存：新 Owner 使用独立 SDK home；切换未来分配的 activeOwnerId，旧资源的 assignment／路由仍指向原 Owner，旧 Owner 不因升级被停止。新 Coordinator 恢复所有 Owner 路由。这条路径需要本轮先在隔离环境实测；也须核对线上常驻 Supervisor／adapter 与被测实现一致。回退不得停止仍有新任务的新 Owner，也不整卷回写业务数据。

## 用户验收时应看到的结果

升级前，保留一个真实沙箱中的 tmux 计数器或现有任务，并保存原终端书签。发布新包只出现新版本提示，不改变当前版本或沙箱。

点击升级后，页面展示真实进度。完成后用户主动刷新，原书签应在 5 秒内确认回同一 Guest／shell，计数前缀完整、进程及内核身份不变。原沙箱中的旧 CLI 继续运行；另建沙箱才应检测到 Codex `0.163.0`、Claude Code `2.1.302`，且默认镜像的真实 digest 与发布收据一致。

独立验收范围、前后端场景和证据要求见 [CLI 升级与用户触发更新测试计划](../testing/changes/2026-10-17-CLI版本升级与用户触发更新测试计划.md)。主线上历史基线见 [线上首次更新与实验发版](../testing/results/2026-10-14-线上首次更新与实验发版.md)；远端来源基线以本轮统一迁移的实际验收记录为准。
