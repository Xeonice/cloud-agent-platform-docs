# 05 - Runtime 鉴权流转设计（帐号授权 + API key 双模式）

> 状态：✅ 实施前定稿（S4 实现前回写：2026-08 **live 技术验证**——真订阅真授权真跑——已落回 §1★/§2/§3★/§5.1/§6；§7 划定"S4 增量 vs S3 已复用"边界。CLI 行为除官方文档外补充实测形态：codex `auth.json` 结构 + claude token 从 stdout 出/OSC 8/pty 折行）
> **⚠️ S5 技术验证修订（2026-08，真容器 + 真订阅凭证 + agent 真干活）**：**注入形态已被实测推翻并改写**——`--with-access-token`（stdin）档在真容器里失败，不再是默认；改为"注入 `refresh_token` 值被占位替换的 `0600` auth.json"。**P0-3 的安全裁决本身（真 refresh_token 永不进沙箱）不变，变的只是实现形态**。修订落点：§1★★（证据与裁决）· §2 决策 A（闭环背书）· §3 时序 · §4 物化行 · §6 · §7 #3。
> 关联文档：[04 Contract 体系](./04-Contract与Registry扩展体系.md) · [07 前端目录结构 §6 鉴权页](../frontend/07-前端目录结构与视图逻辑分离.md) · [03 §7.3 Git 凭证使用链路](./03-Sandbox调度中心.md) · [11 §1.1 auth helper 部署形态](../shared/11-部署与扩展预留.md)
> 产品依据：[P20 §5](../product/20-核心使用链路.md) · [P21-3 凭证管理](../product/pages/21-3-凭证管理.md) · [P21-4 §10 运行参数](../product/pages/21-4-镜像管理.md)

## 1. 已核实的 CLI 鉴权现状（2026-08）

| | Claude Code CLI | Codex CLI |
|---|---|---|
| 订阅登录方式 | `claude setup-token`：打印 OAuth URL → 用户浏览器完成 claude.ai 订阅授权 → **把 code 粘贴回终端** | 三种：本机浏览器 OAuth；**`codex login --device-auth`（标准 RFC 8628 device-code，专为无浏览器环境）**；API key |
| 凭证落盘 | `setup-token` **不落盘**——1 年期 token（`sk-ant-oat01-…`）直接**打印到 stdout**（区别于交互式 `claude login` 才写 `~/.claude/.credentials.json`）；捕获后即注入 env，见 ★1 | `~/.codex/auth.json`（明文，须按密码级保护），实测顶层键见 ★2 |
| 直接注入 | `CLAUDE_CODE_OAUTH_TOKEN` 环境变量 | `codex login --with-access-token` |
| device-code 支持 | ❌ 无（社区 issue 强烈诉求中） | ✅ 有，code 15 分钟过期 |
| **API key 支持** | ✅ `ANTHROPIC_API_KEY` 环境变量 | ✅ `OPENAI_API_KEY` 环境变量 / API key 登录 |

> **★ 技术验证补充（2026-08 live，真订阅真授权真跑；下列是凭证落盘/输出的精确形态，比抽象设计更值钱，是解析器与注入器的直接实现指导）**
>
> - **★1 Claude `setup-token`（输出形态）**：授权 URL **藏在 OSC 8 超链接转义序列里**（`ESC ] 8 ; id=… ; <完整URL> …`），**可见文本里的 URL 会被 pty 截断** → 捕获器**必须解析 OSC 8 原始序列取完整 URL，不能简单 grep `https://`**。产出的 1 年期 token（`sk-ant-oat01-…`）**打印到 stdout、不落 `.credentials.json`**，且被 pty **按行折成多段** → 捕获后须**拼接并去空白**还原完整 token。**捕获入口明文纪律（P1-4a）**：token 捕获后**立即包进 `SecretMaterial`（`Buffer` 承载）**，捕获入口**不产生裸 `string`**；用于折行拼接的 pty 原始 buffer 用完 `fill(0)`（与 23 §8.3 `SecretMaterial` 同纪律）。注入形态：`CLAUDE_CODE_OAUTH_TOKEN` env。
> - **★2 Codex `login --device-auth`（输出形态）**：输出是**纯文本** verification URL（`https://auth.openai.com/codex/device`）+ device-code（格式 `XXXX-XXXXX`，15 min 过期）→ **正则捕获稳**。凭证落 `~/.codex/auth.json`，实测顶层键：`auth_mode`、`tokens.{ id_token, access_token, refresh_token, account_id }`、`last_refresh`（chatgpt 订阅模式下 `OPENAI_API_KEY` 字段为 `null`）。**`auth.json` 含 `refresh_token` → 实证印证 §5.1 的刷新回写必要性**（access token 短期，须靠 refresh token 续期）。**注入形态（最小暴露优先，见 §4/§7 #3）**：落 `0600` 的 `~/.codex/auth.json`（随沙箱销毁）、其中 `refresh_token` 值替换为占位串；**绝不用 `CODEX_AUTH_JSON` env 注入整份 auth.json**（含 refresh_token，沙箱内 `echo $CODEX_AUTH_JSON` 即可盗走，见 §3/§7）。**⚠️ 本行原定"`codex login --with-access-token`（stdin，只喂短期 access token）为默认"，已被 S5 技术验证推翻**——该档降为可选/版本敏感档，证据与新优先级见下方 ★★。
> - **结论**：auth helper 的输出捕获器**必须 per-CLI 适配**（codex 抓纯文本 code + 读 auth.json 文件；claude 解析 OSC 8 URL + 从 stdout 拼 token），**不能用一套通用正则**——这是 §6「正则解析 stdout 脆弱」风险的具体化落地（§3 时序与 §6 缓解已据此细化）。

> **★★ S5 技术验证修订（2026-08，真容器 + 真订阅凭证 + agent 真干活）——推翻上方 ★2 的"stdin 档为默认"；P0-3 的安全裁决本身不变，只改实现形态**
>
> ★2 当初把 `codex login --with-access-token`（stdin）定为默认档，依据是"只喂短期 access token 暴露面最小"这条**推理**。S5 开工前把它放进**真 sandbox 容器**跑，三条实测把它推翻：
>
> | # | 实测形态 | 结果 |
> |---|---|---|
> | ① | 从 `auth.json` 取出 `tokens.access_token` 喂 `codex login --with-access-token`（stdin） | ❌ `Error logging in with access token: agent identity JWT payload is not valid JSON` |
> | ② | 注入 auth.json，但**直接删掉 `refresh_token` 字段** | ❌ `missing field 'refresh_token' at line 1 column 3835`（serde 反序列化要求该字段**存在**） |
> | ③ | 注入 `0600` auth.json，`refresh_token` **字段保留、值替换为占位串**（如 `REDACTED-NOT-A-REAL-REFRESH-TOKEN`） | ✅ **跑通**——agent 真鉴权、真干活，**21,192 tokens**（值取空串 `""` 同样 exit=0） |
>
> **① 不是传输问题、也不是 token 本身的问题**——三个假设已逐一排除，不是推断：**传输完整**（容器内收到 **1796 字节**，与宿主一致）；**token 合法**（3 段 RS256 JWT，payload 能正常 base64 解码出 ChatGPT account claims）；**真因是版本敏感**——宿主 codex **0.147.0** 产出的 token，被容器内 codex **0.139.0** 消费。⇒ 这条通道**对 CLI 版本漂移脆弱**（与 §6 首行"解析 CLI stdout 是脆弱集成"同一类风险，只是挪到了鉴权入口），**不能作为默认档**。
>
> **修订后的注入优先级**（§3 时序 / §4 物化行 / §7 #3 已同步改写）：
>
> **① 注入 `0600` auth.json，其中 `refresh_token` 值替换为占位串（真值绝不进沙箱）> ②（可选 / 版本敏感）`--with-access-token`（stdin），须与产出该 token 的 CLI 版本匹配 > ③（禁用）整份含真 `refresh_token` 的 auth.json —— 无论 env 还是文件**
>
> **为什么"占位串"可行、而"删字段"不行**：`auth.json` 的 schema **要求 `refresh_token` 字段存在**（②的报错原文即是证据），但 codex 在沙箱内**只用 `access_token` 鉴权**——刷新由平台侧统一做（§5.1 方案 A：在 auth helper 的临时 HOME 里、用平台自己那份含真 refresh_token 的副本触发刷新），**沙箱从来不需要 refresh 能力**。占位串因此同时满足"字段在"与"真值不出平台"两个约束。
>
> **P0-3 的安全裁决本身不变**：真 refresh_token 永不进沙箱——沙箱内 `cat ~/.codex/auth.json` 拿到的 `refresh_token` 是占位串，拿不到那个"可脱离平台无限续期、平台无法上游吊销"的凭据。**变的只是实现形态**（从"stdin 只喂 access token"变成"注入一份 refresh_token 被占位替换的 auth.json"），不是安全目标的让步。
>
> **凭证物化路径走运行时 `$HOME`，不硬编码**：实测 aio 的 `$HOME=/root`（uid=0），boxlite 的 `$HOME=/home/gem`（uid=1000）——**硬编码 `/root` 在 boxlite 上必错**。`credentialFiles[].containerPath` 里的 `~/.codex/auth.json` / `~/.claude/.credentials.json` 必须在注入时用**沙箱内实际的 `$HOME`** 展开：04 §7 的镜像约定只承诺"HOME 可写"，从未承诺 HOME 是哪个路径。provider 身份与能力差异全表见 04 §2.1★。

> **setup-token 路径 MVP 即做，不推迟**（审计 P2-13 重新评估）：原建议基于 MVP 瘦身，而瘦身已被全部否决。现状是这条路径的契约与实现面**已经完整**——04 §3 的 `getAuthMethods/beginAuth/completeAuth` 覆盖 `paste-prompt` 形态、05 §3 有完整时序、25 §4.2 有 golden fixture 用例、P20 §5 的产品链路把「帐号授权」定为三分支之一。推迟它反而要**回头砍产品定稿的入口**（Claude Code 只剩 API key，用户的 Claude 订阅额度用不上），代价高于实现成本。

两类模式走两条不同链路：
- **帐号授权（订阅）**：都是交互式 CLI 登录（setup-token 要粘贴回车，device-auth 要打开链接输码）→ 必须走「**pty 交互 + 前端在线中转**」（§3）。
- **API key**：无任何交互 → **不经 sandbox、不起 pty** 的短路直存路径（§3.1）。计费语义不同：帐号授权消耗订阅额度，API key 按量计费——注入时的优先级见 §4。

## 2. 核心设计决策

**决策 A：鉴权与任务 sandbox 彻底解耦（凭证注入架构）。** 两个 CLI 的凭证均官方确认**可搬运**：Claude `setup-token` 产出 1 年期 token（`CLAUDE_CODE_OAUTH_TOKEN` 注入任意环境）；Codex `auth.json` 不绑定主机（官方 CI/CD 文档提供 `CODEX_AUTH_JSON` 注入模式）。因此登录流**不依赖任何任务 sandbox**——跑在平台管理的 **auth helper 执行环境**里（**默认形态：复用 AIO 镜像的常驻轻量 helper 容器；备选：后端宿主机自带两个 CLI**——部署形态与取舍见 [11 §1.1](../shared/11-部署与扩展预留.md)；对上层与前端完全透明），产出凭证入 Vault 后注入后续任意 sandbox。产品收益：拦截面板/凭证页内**即时完成**帐号授权，任务创建流程中不存在"等待登录"环节（产品 P20 §5 与此对齐）。**本决策已 live 验证（2026-08 技术验证）**：真订阅 → 真授权 → 捕获凭证 → **搬运到完全独立的隔离环境**（全新 `CLAUDE_CONFIG_DIR` / `CODEX_HOME`，只含搬运来的凭证，与登录时的 HOME 无任何共享）→ agent **真鉴权通过并调用模型干活**（claude 侧实测 agent 真读文件真出活；codex 侧实测真实会话建立、请求真打到 OpenAI，仅因测试账号额度用尽未出最终结果——鉴权/搬运/注入链路全通）。"凭证与登录 sandbox 解耦、可搬运注入任意 sandbox"不再是纸面推断。

**S5 技术验证把这条闭环补到端到端（2026-08，真容器 + 真订阅凭证 + agent 真干活）**：真 ChatGPT 订阅授权 → 捕获凭证 → **注入真 sandbox 容器**（`refresh_token` 占位替换，§1★★）→ agent 在容器内**真鉴权、真读工作区、真改文件、真建文件** → **宿主侧可见且功能正确**。宿主实证不是日志断言而是文件事实：`add.js` 被改成 `return a + b`、`FIXED.md` 被新建、宿主 `node` 跑出 `add(2,3) = 5`；工作区 bind mount **双向可见、uid 映射正常**（印证 03 §7.1 的宿主目录两级工作区模型）。至此"登录一次 → 注入任意 sandbox → agent 真干活"三段全部有实测背书；§7.1 第 2 条列的"注入门面零真实调用方"由 S5 provision 接线消解（接线点见 03 §7.6）。

**创建流程的阶段序列因此固定为**：初始化 → 拉镜像 → 准备工作区 → 启动实例（凭证注入发生在此，用户无感）→ 连接终端（P20 §3.3）。**没有"等待登录"阶段**——任何在创建链路里等待鉴权的实现都是对本决策的违反。

**决策 B：后端不代理 OAuth、不接触用户密码。** 帐号授权的登录命令跑在 auth helper 的 pty 里；后端只做三件事：
1. 从 pty 输出**捕获** AuthChallenge（URL / device-code）；
2. 转发给前端展示，用户在**自己的浏览器**完成真正授权（不经过我们的服务器）；
3. CLI 落盘凭证后**收编**进 CredentialVault，供后续 sandbox 复用。

以上仅适用**帐号授权**。API key 模式无 OAuth 环节，走 §3.1 的直存路径，安全边界同样成立（key 仅 HTTPS 一次性提交、内存流转、加密落库、永不回显）。

## 3. 统一鉴权流转时序

```
前端 ──POST /api/runtimes/:rt/auth/begin──▶ RuntimeApplicationService.beginAuth()
   │                                                        │
   │                                    在 auth helper 执行环境内（§2 决策 A）
   │                                    spawn({tty:true}) 起交互式登录子命令
   │                                    ——【硬约束】必须真 pty：setup-token 与 device-auth
   │                                       都检测 TTY，非 TTY 直接不启动/不输出（live 实测）
   │                                    ——不依赖、也不创建任何任务 sandbox
   │                                                        │
   │                          RuntimeAdapter 从 pty 输出流【per-CLI 适配】捕获（见下 ★）
   │                          AuthChallenge{ kind:'url'|'device-code'|'paste-prompt',
   │                            verificationUrl, userCode?, expiresAt, challengeRef, instructions }
   │                          （字段以文档 04 §3 为唯一定义处）
   │◀──────── 返回 URL / userCode，前端展示（链接/大字号代码/二维码）────────┘
   │
   │   用户在【自己的浏览器】打开链接完成 claude.ai / ChatGPT 授权
   │   （不经过平台后端 —— 安全边界清晰）
   │
   │──POST .../auth/complete { pastedText? }──▶
   │      · setup-token 场景：后端把粘贴内容 write 进 pty stdin
   │      · device-auth 场景：后端持续读 pty 输出直到 CLI 提示登录成功
   │                                                        │
   │                          CLI 落盘凭证（.credentials.json / auth.json）
   │                          RuntimeAdapter 收编（claude 从 stdout 拼 token / codex 读 auth.json）
   │                            → 【入库前校验，P1-4c】claude token 过前缀+长度+字符集校验
   │                               （与 §3.1 API key 路径对齐）+ 可选一次最廉价鉴权探测（whoami）
   │                               确认可用才判 login success；失败返回 AUTH_REJECTED，不静默存坏值
   │                               （防坏 token 多沙箱反复失败触发账号锁）
   │                            → CredentialVault 加密存储（AES-256-GCM）
   │◀──────── 返回 RuntimeCredential 元数据（掩码，不回传明文）────────────┘

注入：任何 sandbox 启动时，credential 上下文经门面交出 RuntimeCredential
      （CREDENTIAL_FACADE.prepareRuntimeCredential(runtimeId)，受控明文包装，
       非不透明句柄——因 runtime 要注入沙箱；credential 不反向持 sandbox exec，
       见 §4 与 27 §4）→ sandbox 编排侧以 adapter.injectCredential(cred, exec)
      【一次性 exec】按【最小暴露形态优先级】写入（§4/§7 #3；S5 实测修订见 §1★★）：
        ① 0600 auth.json —— refresh_token 值=占位串，真值绝不进沙箱
             （落点按沙箱内实际 $HOME 展开，不硬编码 /root）
        > ② (可选/版本敏感) --with-access-token（stdin）
             —— 须与产出该 token 的 CLI 版本匹配，版本漂移即失败
        > ③ (禁用) 整份含真 refresh_token 的 auth.json —— env 与文件同禁
      直到过期无需重复登录——登录一次，处处可用。
```

> **★ auth helper 的输出捕获是 per-CLI 适配的，不是一套通用正则**（2026-08 live 实测，§1 ★ 的落地）：
>
> | CLI | Challenge 捕获（begin） | 凭证收编（complete） |
> |---|---|---|
> | **Codex `--device-auth`** | 从 stdout **纯文本正则**抓 device-code（`XXXX-XXXXX`，15 min）与 verification URL（`https://auth.openai.com/codex/device`）——稳 | **读 `~/.codex/auth.json` 文件**（含 `refresh_token`，见 §5.1） |
> | **Claude `setup-token`** | **解析 OSC 8 转义序列**取完整授权 URL（可见文本 URL 会被截断，**不能 grep `https://`**） | 从 **stdout 拼 token**（`sk-ant-oat01-…` 被 pty 按行折成多段，去空白拼接还原；**不落 `.credentials.json`**） |
>
> 两条捕获路径都跑在 `spawn({tty:true})` 的**真 pty** 里——非 TTY 时两个 CLI 都不启动/不输出（上方时序图已标为硬约束）。解析器 per-CLI 分派 + golden fixture 覆盖两种输出形态，见 §6 与 25 §2.3。

**REST 端点约定**（含全局前缀 `/api`，是前端 service 命名与 mock 的唯一权威，文档 07 §6 / 12 §4.2 与此对齐）：

| 端点 | 用途 | 前端 service 方法 |
|---|---|---|
| `POST /api/runtimes/:rt/auth/begin` | 发起登录（在 auth helper 内，无 sandbox 维度——§2 决策 A），返回 `AuthChallenge{ verificationUrl, userCode, expiresAt, challengeRef, ... }`（文档 04 §3） | `beginAuth` |
| `GET /api/runtimes/:rt/auth/status?challengeRef=` | oauth-device 场景轮询登录进度（pending / success / expired / error） | `pollAuthStatus` |
| `POST /api/runtimes/:rt/auth/complete` | setup-token 场景提交粘贴内容（后端写入 helper pty stdin） | `completeAuth` |
| `POST /api/runtimes/:rt/credentials/secret` | **API key 直存**（`{ method: 'api-key', secret }`；无 sandbox 维度，见 §3.1） | `submitSecret` |
| `PUT /api/runtimes/:rt/auth-mode` | 切换该 runtime 的**生效模式**（`{ method: 'account' \| 'api-key' }`，二选一全局生效，见 §4）；目标模式无凭证 → 409 | `setAuthMode` |
| `DELETE /api/runtimes/:rt/credentials/:credentialId` | 吊销凭证；对**运行中沙箱**的唯一可靠手段是**强制重启/销毁所有 bound 活沙箱**（credential_sandbox_bindings 台账驱动，非删文件/改 env，见 §4 吊销行）；吊销延迟与"已泄漏 token 无法追回"语义见 §4 | `revokeCredential` |

对应 RuntimeAdapter contract 的 `beginAuth / completeAuth / injectCredential`（文档 04 §3）；前端鉴权 UI（oauth-device 轮询 / setup-token 粘贴 / api-key 直存）见文档 07 §6。

### 3.1 API key 模式（短路路径，不经 sandbox）

```
前端（凭证管理页或向导闸门）
   │  POST /api/runtimes/:rt/credentials/secret { method:'api-key', secret }
   ▼
RuntimeApplicationService
   │  adapter.createCredentialFromSecret('api-key', secret)   [04 §3，可选轻量格式校验]
   │    → RuntimeCredential{ credentialFiles: env 形态，如 OPENAI_API_KEY / ANTHROPIC_API_KEY }
   ▼
CredentialVault 加密落库（obtained_via='api-key'）──▶ 返回掩码元数据（sk-...ab12）
```

- **无 sandbox 前置**：不 spawn、不起 pty——这是与帐号授权链路的本质差异，前端闸门与凭证管理页可随时直接提交（07 §6 / P21-3）。
- 注入：materialize 时按 adapter 声明的形态注入（环境变量优先，或写 CLI config）。
- 可选**轻量校验**：格式前缀校验必做；真实有效性校验（打一次低成本 API）作为可配置项，失败返回 `AUTH_REJECTED`。
- **明文纪律（加固 P2-3）**：`SubmitSecretRequest.secret` 字段纳入**请求日志脱敏白名单**（HTTP 访问日志/错误日志一律打码，不落原文）；`class-validator` 的字段校验失败时**只回显字段路径与规则、绝不回显 value**（`ValidationPipe` 关闭 `value` 回带），避免坏 key 经错误响应外泄。

### 3.2 Git 凭证（`kind='git'`）：同一 Vault，不同管道

私有仓库克隆需要的 SSH 私钥 / HTTPS Token 复用 CredentialVault 与 credentials 表（13 §2），但**与 runtime 凭证是两条完全不同的管道**——这是 MVP 阶段最容易被实现者搞混的一处，明确边界：

| 维度 | runtime 凭证 | Git 凭证 |
|---|---|---|
| 用在哪 | **注入 sandbox**（materialize 写文件/env） | **只在平台进程内**——clone 与 `ls-remote` 都发生在平台侧，**绝不注入任何 sandbox**（P21-3 §10.3；Task 内 `git push` 是 v1.5 才引入的独立设计） |
| 生效规则 | `runtime_settings.active_auth_method` 二选一 | 无模式概念；**按仓库 URL 协议自动选**（`git@`/`ssh://`→SSH 私钥，`https://`→HTTPS Token），两者可同时配置 |
| 作用域 | 全局（跨项目） | 全局（跨项目，per-project 覆盖 v1.1 再评估） |
| 回显 | 掩码帐号 / `sk-...ab12` | **SSH 只回指纹**（`SHA256:...`，私钥永不回显）/ Token 只回尾号 |
| 过期 | 有 `expiresAt`，7 天预警 | 通常无（PAT 有效期用户自管）；仅在 clone 失败为权限类时提示 |
| 端点 | 读 `GET /api/runtimes`（聚合）· `/api/runtimes/:rt/credentials/*` | 读 `GET /api/credentials?kind=git`（`kind` 必填，MVP 只接受 `git`）· 写 `POST /api/credentials/git` · `POST /api/credentials/git/test` · `DELETE /api/credentials/git/:id`（端点族定案见 02 §5.1）——**runtime 凭证不经泛集合读取**，避免两条可达路径 |

**使用链路的具体落地形态（临时密钥文件 0600 + `GIT_SSH_COMMAND` vs HTTPS credential helper、host 白名单、resolve+pin、`known_hosts` 首连自动信任、passphrase 私钥不支持的校验）写在 03 §7.3**——那里是 clone 编排的所在地，此处不重复。本文档只负责一条纪律：**Git 凭证的解密（materialize）同样只在内存流转，且全部发生在 `credential/infrastructure` 内**——对外只经门面 `CREDENTIAL_FACADE.prepareGitAuth(kind, host, scheme)` 返回不透明句柄 `GitAuthContext`（23 §8 / 27 §5），**clone 编排（project 侧）只消费句柄、永不持有明文**；落到磁盘的只有生命周期不超过一次 clone 的 `0600` 临时密钥文件，句柄 `dispose()` 在 `try/finally` 必删。

## 4. CredentialVault（credential 限界上下文）

| 方面 | 设计 |
|---|---|
| 存储 | 凭证 blob AES-256-GCM 加密落库；密钥来自本地 master key（起步），可选系统 keychain（keytar）；生产建议 KMS |
| 物化 | `materialize(credentialRef, sandboxHandle)` 按 **最小暴露形态优先级**（§7 #3，adapter 契约固化）注入。**优先级已按 S5 技术验证修订（§1★★）**：**① `0600` 文件（`~/.codex/auth.json` / `~/.claude/.credentials.json`，随沙箱销毁）且 `refresh_token` 值替换为占位串——字段必须保留（删掉会报 `missing field 'refresh_token'`），真值绝不进沙箱 > ②（可选 / 版本敏感）access-token-only（stdin，codex `login --with-access-token`），只在注入端与产出端 CLI 版本匹配时可用——实测 0.147.0 产的 token 喂给 0.139.0 直接被拒 > ③（禁用）整份含真 refresh_token 的 auth.json，env 与文件同禁**——**绝不用 `CODEX_AUTH_JSON` env 注入整份 auth.json**（沙箱内 shell 一条 `echo` 即可盗走 → 脱离平台无限续期、平台无法上游吊销，P0-3）。刷新由平台侧统一做（§5.1），沙箱不需要 refresh 能力——这正是占位串成立的前提。**落点路径按沙箱内实际 `$HOME` 展开，不硬编码 `/root`**（实测 aio=`/root`、boxlite=`/home/gem`，04 §2.1★）。api-key 类凭证走 env（`OPENAI_API_KEY` / `ANTHROPIC_API_KEY`，本就非长期订阅身份）。**出口纪律见下方「runtime 出口通用明文纪律」** |
| **模式开关（二选一，全局生效）** | 同一 runtime 两类凭证**可留存**（credentials 表多行，切回无需重新登录），但**同一时刻只有一个模式生效**：`runtime_settings.active_auth_method`（13 §2）决定 materialize 取哪条凭证。切换经 `PUT /api/runtimes/:rt/auth-mode`，**立即全局生效**（已运行 sandbox 不受影响，下次启动/新建时按新模式注入）；切换到未配置凭证的模式时接口返回 409，前端引导先补配 |
| 回显 | REST/MCP 响应**永不回传明文**；只回显掩码标识（`sk-...ab12` / 邮箱）与过期时间 |
| 吊销 | 管理接口 **revoke**（非物理删除）：置 `revoked_at` + 物理擦除密文字段，元数据保留供审计（文档 13 §2 credentials）。**对运行中沙箱的联动（P0-4）**：env 形态（`CLAUDE_CODE_OAUTH_TOKEN` 及 codex 若走 env）注入进程后**外部无法 `unset`**——"联动清除 env"物理做不到，是假承诺。因此**唯一可靠手段是按 `credential_sandbox_bindings` 台账强制重启/销毁所有 bound 的活沙箱**；删文件/改 env 仅对"CLI 每次调用重读凭证"的文件形态有意义、**对已缓存进程无效**。**吊销延迟语义明示**（前端 21-3 吊销确认文案同源）："吊销会重启正在使用该凭证的运行实例；已泄漏到沙箱外的 token 无法追回。" **exec 清除失败兜底**（容器忙/不健康）：超时**升级为强制销毁**，不静默记 error |
| 日志脱敏 | pty 交互日志中 URL 的 state/token 参数不入常规日志。**per-CLI 分两套（P1-4b，见 §6）**：claude token 走**高熵密钥模式 + 折行片段拼接前预脱敏**（对 `sk-ant-oat01-` 前缀及后续折行分片先打码再拼接，防"分片各自不像密钥、拼起来才是"的漏网）；codex device-code 是给用户看的**非密钥、可显示**（`XXXX-XXXXX`）。**terminal transcript 落库前过同一脱敏器** |
| 多用户预留 | 记录含 `owner_ref` 字段（当前恒为空，与文档 13 credentials 表一致），未来加用户体系只迁移数据不改流程 |

**runtime 出口通用明文纪律（P1-5，runtime 与 git 共守，与 23 §8.3 同源）**：runtime materializer **强制照搬 S3 git 侧的明文纪律**——`crypto.decrypt` → `secret.use(buf => …)` 内完成写 env/文件/喂 stdin → `finally secret.zeroize()`（`Buffer.fill(0)`）。**token / auth.json 只走 env / 文件 / stdin，永不进 `argv`**（防 `/proc/<pid>/cmdline`、`ps`、审计日志泄漏）；`DecryptionError` 走 §4.2「凭证以 `revoked` 呈现、引导重授权」而**非 500**。这几条是 credential 上下文的**通用出口纪律**，git 的 `prepareGitAuth` 与 runtime 的 materialize 都遵守（23 §8.3）。

### 4.1 镜像 env 与凭证管道的边界（安全红线，产品 P21-4 §10.3/§10.4）

镜像/项目/Task 三层的自定义环境变量与 Vault 凭证注入是**两条独立管道**。合并与校验全部在 **application 层**完成，provider 只收到一份最终的 `SandboxProviderContext.env`（04 §2.4）。

**三层合并引擎**（后者覆盖前者）：

```
① 镜像全局默认 image_manifests.image_config.env（13 §2）   来源标签 [来自镜像]
② 项目级覆盖（v1.1，UI 先隐藏；数据结构预留同形）           来源标签 [来自项目]
③ Task 级本次覆盖（向导确认步 › 高级选项）                  来源标签 [来自 Task]
        ↓ 逐 key 覆盖合并（大小写敏感）
   最终生效表（每项带来源，供前端"最终生效值"展开展示）
        ↓
④ Vault 凭证注入 ——【最后写入，同名时凭证永远赢】
        ↓
   SandboxProviderContext.env
```

**"凭证永远赢"是靠顺序保证的**：凭证在合并结果之上最后覆盖写入，而不是靠校验去拦截——即使黑名单被绕过（比如未来新增了某个凭证变量名而黑名单忘了同步），凭证依然覆盖用户值，安全性不依赖黑名单的完整性。黑名单是**用户体验层的前置提示**（保存时就告诉你"这个名字没用"），不是唯一防线。

**后端写入侧校验**（保存镜像/项目/Task 参数时同一套引擎，前端校验只是体验优化，后端必须重校）：

| 规则 | 内容 | 违反 |
|---|---|---|
| 命名正则 | `^[A-Za-z_][A-Za-z0-9_]*$` | `变量名不合法` |
| 保留名黑名单（精确匹配） | `ANTHROPIC_API_KEY` · `OPENAI_API_KEY` · `CLAUDE_CODE_OAUTH_TOKEN` · **`CLAUDE_CONFIG_DIR`**（P1-2：它重定向 claude 读凭证目录，能旁路注入/造成凭证混淆；`CODEX_HOME` 已被 `CODEX_*` 前缀覆盖）· `SSH_PRIVATE_KEY` · `KUBECONFIG` · `HOME` · `USER` · `PATH` · `PWD` · `DOCKER_HOST` · `DOCKER_CONFIG` | `该变量名为系统保留，请使用凭证管理配置` |
| 保留名黑名单（前缀整体拦截） | `CODEX_*` · `GIT_*` | 同上 |
| 数量与长度 | 每层 ≤ **50** 条、名 ≤ **64** 字符、值 ≤ **4 KB** | `超出上限` + 具体上限值 |
| 同层 key 唯一 | 大小写敏感 | 拒绝保存 |

黑名单以**常量表**形式与 RuntimeAdapter 声明的凭证变量名对账：新增 adapter 时若其 `RuntimeCredential` 用到新的 env 名，CI 断言该名已在黑名单内（防"新 runtime 上线后凭证名可被明文覆盖"）。**判据（P1-2 扩展）**：黑名单不止拦"凭证变量名"，而是**凡能改变凭证注入目标路径或 CLI 凭证查找位置的变量**（如 `CLAUDE_CONFIG_DIR`、`CODEX_HOME`、`HOME`）——它们不含凭证却能把 CLI 指向攻击者可控的凭证目录。CI 对账清单**显式列这一类**（重定向类），与凭证名类并列断言。

`secret: true` 的值字段级加密存储、响应永远掩码（13 §2 image_manifests），materialize 时才解密进合并引擎——**解密后的 secret 值与凭证一样只在内存流转，不写日志**。

### 4.2 Vault master key 的生成 / 存放 / 轮换 / 备份（审计 P1-11）

整套 AES-256-GCM 加密的根信任是 master key，此前只有"来自本地 master key"一句话——不定义它，加密等于没做。

| 环节 | 定案 |
|---|---|
| **来源优先级** | ① 环境变量 `PLATFORM_MASTER_KEY`（base64，32 字节）——生产/编排环境优先；② 未设置则**首次启动自动生成** 32 字节随机 key。**随机源必须 `crypto.randomBytes(32)`（禁 `Math.random`）**；写盘用 `fs.open(path, 'wx', 0o600)` **独占创建**（`EEXIST` 则读现有）——防并发首启竞态与"先 `writeFile` 后 `chmod` 的 `0644` 可读窗口"；父目录先 `mkdir(0o700)`，写后 `fsync`，**key 落盘先于任何加密使用**。写 `${DATA_ROOT}/.master.key` 后在启动日志与系统状态页打一条**醒目提示**："已自动生成主密钥，请纳入你的备份策略" |
| **加载时机** | 启动装配阶段读入内存（`P/config`），**只在内存里存在**；日志与诊断接口永不回显 |
| **`encryption_key_id` 定义** | 定为 **key 的稳定指纹**（如 `sha256(key)` 截断）**而非逻辑标签**——否则 env 换了 key 但标签相同时，GCM `authTag` 会**静默校验失败**却查不出根因 |
| **缺失即失败** | 库里有凭证但 key **不可用**时**启动不静默通过**：凭证一律以 `revoked`（不可用）语义呈现，前端走"重新授权"引导——比"解密报错 500"和"静默当作没配置"都好。**"key 存在但不对"**（`authTag` 校验失败）**同样**按"凭证以 `revoked` 呈现、引导重授权"处理，**不 500** |
| **轮换** | **新 key 必须先 durable 落盘 + 确认**，再逐条 `decrypt(old) → encrypt(new)` 并更新 `credentials.encryption_key_id`（每行自带 `encryption_key_id` 供**中断恢复**：崩溃后按各行的 key_id 分辨已迁/未迁）；轮换期间新旧 key 同时在内存，全部记录迁完才丢弃旧 key。轮换是**在线**的，不需要停机 |
| **备份** | 备份导出（v1.5）**默认不含 master key，也不含凭证密文**（P22 §4.18）；文档明示"备份不含密钥，换机恢复后需重新授权"，不给用户"备份了就万事大吉"的错觉 |
| **多用户/KMS 演进** | `encryption_key_id` 已为多 key 共存留位；接 KMS 时只换 `CryptoPort` 实现，密文格式不变 |

## 5. 过期与续期

- Vault 记录 `expiresAt`（Claude token 约 1 年；Codex 按 OAuth 刷新语义）。
- 过期前经 WS 事件通道推 `runtime-auth.status_changed`（10 §3）：**剩余 < 7 天**转 `expiring`（前端黄色横幅 + 凭证卡黄字，P21-3 §5）、到期转 `expired`（红色横幅 + 相关 Task 标 ⚠️）；该 runtime 状态标记 `auth-expired`，前端引导重新走 §3 流程。
- 过期判定同时是**自动化调度器的跳过条件**（03 §8.2 决策 2：`skipped / AUTH_EXPIRED`，不排队等鉴权）。
### 5.1 凭证刷新回写（审计 P1-7 · 方案 A：平台侧统一刷新）

**问题**：Codex 的订阅登录是标准 OAuth，access token 是**短期**的（小时级），`auth.json` 里同时含 refresh token。若平台只在登录那一刻收编一次，几小时后注入新 sandbox 的就是**过期 token**——"登录一次、处处可用"当场击穿。此前文档只有一句"CLI 自身管理，容器内文件更新后定期回收"，既没有组件也没有时机，等于没定义。

**定案：方案 A（平台侧统一刷新），实现方式是"让 CLI 自己刷"而不是平台手拼 OAuth 请求。**

```
P/scheduler/timers.ts#every(15min)
└─ M/credential/infrastructure/refresh/credential-refresh.scanner.ts#runOnce()
   ├─ credential.repository.listRefreshDue(now)      ← expires_at - now < refreshLeadTime（默认 30min）
   └─ 逐条：
      ├─ auth helper 内用 `mkdtemp` 起**唯一** HOME/`CLAUDE_CONFIG_DIR`/`CODEX_HOME`（P1-3，照搬 git-auth.materializer 范式，与交互登录彼此隔离），materialize 当前凭证进去
      ├─ 让 CLI 执行一条**最廉价的、会触发刷新的命令**（如 `codex whoami` / 版本探测）
      ├─ CLI 自行用 refresh token 换新 token 并回写 auth.json
      ├─ 平台重新读取 auth.json → 新密文 + 新 expires_at 覆写同一条 credentials 记录
      └─ finally：`rm -rf` 该临时 HOME（必删，绝不复用容器默认 HOME）
```

**为什么不让平台自己拼 refresh 请求**：token 端点、client_id、scope 都是 CLI 的内部实现细节，不是公开契约；照抄一遍等于把 05 §6 那条"正则解析 stdout 是脆弱集成"的风险再复制到鉴权核心路径上。让 CLI 自己刷，平台只负责"给它一个 HOME、触发一下、把结果收回来"——与 §2 决策 A 的哲学完全一致（平台不代理 OAuth）。

**为什么不选方案 B（从 sandbox 回收）**：① 它要求每个跑着的 sandbox 都把容器内刷新后的 auth.json 回写平台，与决策 A 的"鉴权与任务 sandbox 解耦"直接冲突；② 多个 sandbox 并发刷新会产生 token 写回竞态（谁的最新？）；③ 没有运行中 sandbox 时凭证就永远不刷新——恰恰是"很久没用"的凭证最需要刷。

**配套纪律**：

- **平台副本是唯一权威**：任务 sandbox 内 CLI 自行刷新出的 token **不回收**（避免写回竞态）；容器销毁时随之丢弃。下次启动时平台注入的是自己刷新过的最新副本。
- 刷新失败（refresh token 也过期/被吊销）→ 凭证转 `expired` + 推 `runtime-auth.status_changed` + 前端走重新授权（§5 既有链路）；**不重试到底**，连续失败 3 次即停手并标记。
- Claude Code 的 setup-token 有效期约 1 年、无 refresh 语义，**不参与本流程**（其兜底是 7 天到期预警）。
- API key 类凭证无过期，同样不参与。
- **并发去重（加固 P2-1）**：刷新 scanner 加**进程内单例锁**（mutex），且**per-credential in-flight 去重**——手动触发（重授权/管理动作）与定时扫描**共用同一把锁与 in-flight 集合**，避免同一凭证被并发刷新产生 token 写回竞态（呼应 §5.1 方案 A 拒绝方案 B 的同一理由）。
- **每次隔离（P1-3）**：见上方流程——每个待刷凭证用 `mkdtemp` 独立 HOME，`finally` 必删；刷新 scanner 与交互登录用彼此隔离的临时根。
- 落点：01 目录树 `credential/infrastructure/refresh/`、26 §11 定时任务表、13 §2.5.1 `credentials.expires_at` 语义、25 §3.4 新增用例。

## 6. 风险与备选

| 风险 | 等级 | 缓解 |
|---|---|---|
| **解析 CLI stdout 是脆弱集成**（CLI 升级改输出格式即静默失效） | 高 | **捕获器 per-CLI，非通用正则**（2026-08 live 实测，§1★/§3★ 落地）：codex 纯文本 device-code + 读 `auth.json` 文件（稳）；claude 须**解析 OSC 8 转义序列**取完整 URL + 从 stdout **拼接被折行的 token**——简单 grep `https://` 会拿到截断 URL。配套：每个 Adapter 加版本探测 + **golden-output 契约测试**（fixture **必须逐字节保真两种输出形态**：codex device-auth 纯文本 + claude setup-token 的 OSC 8 序列与折行 token，见 25 §2.3；**并覆盖"折行拼接错位"负例**，P1-4c），CI 定期回放验证解析器。**fixture 用合成但同结构 token（加固 P2-4）**：保留前缀/长度/OSC8/折行形态、正文占位；**CI 加 secret-scanner 断言 fixture 不含真前缀 + 真长度的高熵串**（25 §2.3） |
| Claude Code 无 device-code，粘贴流体验差 | 中 | 前端框架预留模式切换位；官方支持后仅改 Adapter 的 `getAuthMethods()` |
| 服务端长期持有用户 OAuth 凭证的合规考量 | **高**（审计 P0-3 上调：默认监听 127.0.0.1 之前，这是本平台最大的单点风险——一台被公网暴露的实例等于泄露用户的 ChatGPT/Claude 订阅身份） | 产品文档明示 + 吊销/清除入口 + AES-256-GCM 加密（master key 规格见 §4.2）+ **默认只监听 127.0.0.1**（11 §1）+ **访问口令 Guard MVP 即启用**（11 §3.1） |
| auth.json 明文落盘在容器内 | 中 | 容器单租户使用 + 卷权限 0600 + sandbox 销毁时清除 |
| **整份 auth.json（含真 refresh_token）进沙箱 → 沙箱内 `echo`/`cat` 即可盗走，脱离平台无限续期、平台无法上游吊销 → 永久订阅盗用** | **高（P0-3）** | **裁决不变、形态经 S5 实测修订（§1★★）**：注入 `0600` auth.json 且 **`refresh_token` 值替换为占位串**（字段必须保留——删字段会 `missing field 'refresh_token'`；codex 只用 `access_token` 鉴权，刷新由平台侧统一做，§5.1）；`--with-access-token`（stdin）降为**可选 / 版本敏感**档；**绝不用 `CODEX_AUTH_JSON` env 整份注入，也不落含真 refresh_token 的文件**（注入形态优先级见 §4/§7 #3，adapter 契约固化） |
| **`--with-access-token`（stdin）跨 CLI 版本失效**（把它当默认档会让整条注入链路随镜像里的 CLI 版本静默瘫痪） | 中（S5 新增） | **实测证据**：宿主 codex 0.147.0 产出的 access token 喂给容器内 0.139.0 → `agent identity JWT payload is not valid JSON`；传输完整（1796 字节一致）、token 合法（RS256 JWT payload 可解）均已排除，**真因就是版本漂移**。缓解：该档**降为可选**、默认走占位 auth.json（§1★★）；若确要启用，adapter 须校验注入端与沙箱内 CLI 版本一致，并按 04 §10.3 RA-04 的同一纪律为每个支持版本留 fixture |
| **凭证明文经日志/transcript 泄漏** | 中（P1-4b） | 日志脱敏 **per-CLI 分两套**：claude token 走高熵密钥模式 + **折行分片拼接前预脱敏**（对 `sk-ant-oat01-` 前缀及后续折行片段先打码再拼，防"分片各自不像、拼起来才是"）；codex device-code 是非密钥可显示；terminal transcript 落库前过同一脱敏器（§4） |
| auth helper 环境缺 CLI 或版本漂移 | 低 | helper 容器用平台默认镜像（AIO 自带两 CLI）；启动时版本探测并纳入诊断项（P21-5） |

## 7. 与 credential 上下文已实现部分的衔接（S4 增量边界）

**一句话定位**：S3（Git 私有仓凭证）已落地 credential 限界上下文的 **git 半边 + 全部公共基础设施**；**S4（本文档）= 补 credential 的 runtime 半边**，大量复用已建的东西，**不是从零起**。**`credentials` 表当初就按 `kind ∈ {runtime, git}` 的全列集 + 全 CHECK 建成**（migration 0004，含 runtime 列 `runtime_id`/`mode`/`refresh_failures`/`last_refreshed_at` + CHECK + partial 唯一索引，13 §2.5.1、23 §8），runtime 分支的列与约束**已在库里待命**——`credentials` 表本身 S4 **不动**。**但 `runtime_settings` 与 `credential_sandbox_bindings` 两张侧表目前只在文档、库里根本不存在（未落 Drizzle schema/迁移）**：**S4 待建**——要新增这两张 Drizzle 表定义 + 一条新迁移（`credential_sandbox_bindings` 对 `credentials` 的 FK `RESTRICT`、对 `sandboxes` 的 FK `CASCADE`，见 13 §2.5.2）。**一句话**：`credentials` 表已就绪；`runtime_settings` 与 `credential_sandbox_bindings` 两张侧表 S4 待建。

实现者据此一眼分清"要新建的"与"直接用的"：

| # | S4 要新增（runtime 半边） | 对应的 S3 已建、直接复用（不重建） |
|---|---|---|
| 1 | **`Credential.createRuntime`** 工厂（`kind='runtime'`、`runtimeId` 非空、`mode='account'\|'api-key'`、`obtainedVia ∈ RuntimeAuthMethod`），并把实体现有的 git-only 收窄放宽——`credential.entity.ts` 现 `obtainedVia: GitObtainedVia`、`mode: null` 需拓成超集/可空二值 | `Credential` 聚合本体、`rehydrate`、`revoke()`/`Erased` 擦除、`assertUsable()`、`CredentialStored/CredentialRevoked` 事件（`createGit` 旁并列即可） |
| 2 | **`RuntimeAuthMethod` 枚举** 加进 `obtained-via.vo.ts`（`setup-token` / `oauth-device` / `api-key` / `access-token-paste`，与 DB CHECK 已枚举的四值对齐） | `GitObtainedVia` 及其 wire↔domain 转换的既有写法（同文件并列一个 union + 映射） |
| 3 | **runtime 凭证 materialize**：注入 sandbox 按**最小暴露形态优先级**（§4；**形态经 S5 技术验证修订，见 §1★★**）——codex 默认落 `0600` 的 `~/.codex/auth.json` 且 **`refresh_token` 值替换为占位串**（字段保留、真值不进沙箱），`login --with-access-token`（stdin）降为**可选 / 版本敏感**档；claude 走 `CLAUDE_CODE_OAUTH_TOKEN` env；**绝不注入含真 refresh_token 的整份 auth.json（env 与文件同禁）**（P0-3，adapter 契约固化）。落点路径按沙箱内实际 `$HOME` 展开，不硬编码 `/root` | `CREDENTIAL_FACADE` 门面装配与 UoW 复用；但 **runtime 出口是新增方法**（git 是**不注入沙箱**的不透明句柄 `GitAuthContext`、runtime 是**注入沙箱**的凭证交付 `RuntimeCredential` 受控明文包装）——**出口语义不同、不平移句柄形态**（P0-2，27 §4）；共守"明文不越界"的通用出口纪律（§4 / 23 §8.2） |
| 4 | **`credential_sandbox_bindings` 表本身 + 注入台账写入路径**：**该表未落库（只在文档），S4 新增 Drizzle 表定义 + 迁移**（对 `credentials` FK `RESTRICT`、对 `sandboxes` FK `CASCADE`，13 §2.5.2）；并启用记账写入路径（runtime 侧真正记账，支撑吊销联动——对运行中沙箱是**强制重启/销毁 bound 活沙箱**，§4 吊销行） | `CredentialSandboxBinding` 聚合建模、I-CSB-1/2 不变量、吊销联动机制的**设计**（13 §2.5.2、23 §8.4）——**设计已就绪，但表结构 S4 才落地** |
| 5 | **`runtime_settings` 表本身 + runtime 选择服务**：**该表未落库（只在文档），S4 新增 Drizzle 表定义 + 迁移**（`runtime_id` PK + `active_auth_method` CHECK，13 §2.3.1）；`CredentialSelectionService` 增 runtime 分支（输入 `runtimeId` + `runtime_settings.active_auth_method` → 选生效凭证），及 `PUT /auth-mode` 切换、目标模式无凭证 409（§4） | `forKind`（git 侧选择）的既有实现与 I-CRD-5 partial unique 索引（`uq_cred_runtime_active` 已随 `credentials` 表在库里）；`runtime_settings` 的**表设计**（13 §2.3.1，设计就绪但 S4 才落地） |
| 6 | **auth helper**：per-CLI 捕获器（codex 纯文本 + 读 auth.json；claude OSC 8 + stdout 拼 token）+ `spawn({tty:true})` 真 pty；REST `auth/begin·status·complete·secret·auth-mode`（§3） | —（runtime 侧新增；与 git 的 `git-auth.materializer`/`git-ls-remote.tester` 平行，不复用其内部逻辑） |
| 7 | **凭证刷新 scanner**（§5.1，仅 codex：`refresh_failures`/`last_refreshed_at` 列已在库） | AES-256-GCM crypto、master-key provider（§4.2）、`refresh_failures`/`last_refreshed_at`/`expires_at` 列（13 §2.5.1 已建） |
| — | （公共基础设施一律复用，S4 一行不重写） | `SecretMaterial`（Buffer 脱敏）、`EncryptedBlob`/`Erased`、`MaskedIdentifier`、`aes-gcm.crypto`、`master-key.provider`、credentials 全列表 + 全 CHECK（I-CRD-1/3/5/8 的 runtime 分支已写死在 CHECK 里） |

**边界纪律**：runtime 凭证 materialize **注入 sandbox**（写文件/env），git 凭证**只在平台进程内、绝不注入 sandbox**（§3.2）——两条管道共用 Vault/表/门面，但物化出口不同。这也是 `credential_sandbox_bindings` 只服务 runtime、对 git 写零行的原因（13 §2.5.2 I3）。

### 7.1 S4 交付边界 vs 后续 slice（验收者须知：以下三处是"设计就绪、非本 slice 可用"，勿当已上线功能）

本 slice（S4 runtime 鉴权）交付的是 **登录 → 收编凭证 → 存 Vault → 模式开关 → 吊销联动 → 刷新 scanner** 的闭环骨架。以下三块**代码/表结构已就位但尚未接线到真实运行时数据流**，验收时不应把它们当"端到端可用"：

1. **AUTH_HELPER 当前是 host（管道）形态，不是真 pty 容器形态**。auth helper 现以宿主进程管道启动 CLI（`ProcessStream` 抽象已就位），**真 pty 容器形态 `SandboxProvider.spawn({tty:true})` 是后续 slice**。后果：host 形态下真 CLI 登录检测**非 TTY 不输出**交互式提示，**账号授权的"真登录闭环"依赖真 pty helper**——技术验证已证机制成立（解析器 golden fixture 逐字节保真、live 手测见 §2），但生产级"点一下就登录进去"须等 pty helper 落地。api-key 短路路径（§3.1，不经 helper/pty）**不受此限，本 slice 即完整可用**。

2. **注入门面与 `credential_sandbox_bindings` 记账当前零真实调用方**。`CREDENTIAL_FACADE.prepareRuntimeCredential` / `injectCredential` / `recordRuntimeInjection` 三个方法 + `credential_sandbox_bindings` 表都已实现且单测覆盖，但**真正的 sandbox exec 注入接线属 S5 provision slice**（provision 起容器后 `prepare → inject → record` 三步接入）。本 slice 特意**留了干净接线点**（application 层 hook 注释已标，见 `sandbox-application.service` provision 路径与 `credential-revoked.handler`），**不是半接线的坏态**——`recordRuntimeInjection` 未被调用 ⇒ 台账当前为空 ⇒ 吊销联动当前遍历零 binding（符合预期，非 bug）。吊销联动逻辑本身（超时兜底 + 强制销毁 + 失败保留重试）已完整实现并单测，S5 接线后即自动生效。

3. **secret-redactor 与 reserved-env 黑名单"定义好但未接线"**。日志/transcript 脱敏器（§4 per-CLI 两套）与镜像 env 保留名黑名单（§4.1）的**常量定义与判定函数已就位**，但**接入点在 transcript 落库 / env-merge 切片**——那两条链路本 slice 未交付，故这两套定义**当前不在任何热路径上生效**。验收者勿据"黑名单已存在"推断"env 覆盖已被拦截"——本 slice 的安全性来自 §4.1"凭证最后写入永远赢"的**顺序保证**，黑名单是后续切片的体验层前置提示。
