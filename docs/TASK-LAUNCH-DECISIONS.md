# Task 发起链路决策存档（S5 开工前的 6 条设计裁决）

> 定位：S5（Task 发起 → 装 CLI → 注入凭证 → agent 真跑）的**技术验证**已定稿并回写到 04/05/03/13（"运行时执行"那一半）；本文补的是 **Task 本身那一半**——6 个不裁决就会让 S5 开工即卡住或做错的缺口。
> **与技术文档冲突时以本文为准**（同 [AUDIT-DECISIONS](./AUDIT-DECISIONS.md) / [SANDBOX-RUNTIME-DECISIONS](./SANDBOX-RUNTIME-DECISIONS.md) 的效力）；但本文只写**结论 + 理由 + 落点**，细节一律落在各自的主文档里，本文不做第二份权威副本。
> **前置且不推翻**：[23 §14](./backend/23-领域模型与聚合设计.md) **D-1「Task 不建独立聚合」**——`Sandbox` 聚合 + `sandboxes` 表就是 Task（前端叫 task、后端叫 sandbox）。下面 6 条全部在这个前提内。
> 建模侧的摘要行见 23 §14 的 **D-14 ~ D-19**（与本文一一对应）。

## 0. 一页总览

| # | 缺口 | 裁决 | 主要落点 |
|---|---|---|---|
| **T-1** | `initialPrompt` 有入参、有消费点、**中间没有存储** | 落 `sandboxes` 两列 + 聚合值对象 `InitialTask`；**`SandboxDto` 不回显** | 13 §2.1.1 · 23 §5.1/§5.3 · 10 §7.3 |
| **T-2** | "启动时即执行"被绑在用户点开终端 | provision workflow 在 `starting` 内加 `bootstrapAgentSession`；**终端网关一律 attach** | 03 §4.3 · 24 §1 · 26 §1/§8 · 06 §3/§6 |
| **T-3** | 装 CLI 这一步在时序/调用图里根本不存在；13 又要求初值在创建校验阶段落定 | `ensureRuntimeInstalled` 三步进 provision workflow；**写入不进 T1**；进度走新 WS 事件 | 13 §2.3.2 · 03 §4.3 · 23 §12 · 10 §3.1 |
| **T-4** | 无头 Task 全链路悬空（无 handler、输出无传输、日志只有 automation 口径） | **不进 S5**，归后续切片；S5 live 验证证的是**机制**不是产品化 | 27 §2 · 02 §5.2 · 03 §8.3/§8.6 · 04 §3 |
| **T-5** | "占位版 auth.json"无人构造；注入与刷新共用同一个带真 refresh_token 的对象 | **类型分家**（注入路径拿不到 `authFile`）+ 脱敏形态在**凭证出生时**由 adapter 产出 + 占位串进 shared-kernel + testkit 硬断言 | 05 §4.3 · 04 §3/§10.3 · 23 §8.2 |
| **T-6** | `prepareRuntimeCredential(runtimeId)` 不知道要注入哪个沙箱，却要给出绝对 `containerPath` | `containerPath` 改为 **`~/` 相对**；`$HOME` 展开**只发生在 `injectCredential` 内部**（那里才有 `exec` 可探测） | 05 §4.3 · 04 §3/§10.3 |

**三条贯穿全文的共性**（先说，免得后面重复）：

1. **凡是需要 `exec` 的步骤，都必须排在 `provider.start()` + 沙箱内 agent 就绪探测之后**——`exec` 由 `spawn({tty:false})` 派生（04 §2.3），实例没跑起来就没有 `exec`。T-2/T-3/T-5/T-6 全落在 `starting` 段，顺序被这条钉死（顺带修掉 24 §1 / 26 §1 里"先注入凭证再 `provider.start`"的既有错序）。
2. **凡是"沙箱内的运行时事实"（`$HOME`、CLI 在不在、tmux 有没有），一律经 `provider.spawn()` 实测，不由镜像声明或硬编码推断**——这是 04 §2.1★ 已经确立的方法论，T-2/T-3/T-6 只是把它用到三个新地方。
3. **凡是跨 T1 → provision 边界的用户输入，都必须有存储**——provision workflow 只拿得到 `sandboxId`（26 §1），别的什么都没有。T-1 是这条的直接推论。

---

## T-1 `initialPrompt` 的持久化落点

### 结论

1. **`sandboxes` 加两列**：`initial_prompt text NULL`（CHECK 长度 ≤ 8000，与 `automations.prompt` 同规格）+ `initial_prompt_consumed_at ts NULL`。
2. **聚合侧新建平行值对象 `InitialTask { prompt?, consumedAt? }`，不并进 `ExecutionPolicy`**。
3. **`SandboxDto` 不回显 `initialPrompt`**；展示需求由 `SandboxDto.name` 承接——默认任务名在 T1 内按 P21-1 §9 的规则从 prompt 派生并写入 `sandboxes.name`。

### 理由

- **必须有存储**：消费点（起 agent 会话）在 202 之后的异步编排里，跨越了请求边界；provision workflow 的入参只有 `sandboxId`（26 §1）。"不落库"的替代方案（把 prompt 塞进队列消息）在进程重启后即丢，而队列本身是内存 FIFO（`P/scheduler/scheduler-queue.ts`）——等于用一个更弱的存储替代 DB。
- **为什么不进 `ExecutionPolicy`**：`ExecutionPolicy` 是**创建期一次构造、此后不变**的策略值对象，且承载 I-SBX-5 这条 `headless ⟺ timeoutMinutes` 的交叉不变量。`consumedAt` 是**运行期会变**的一次性标记，塞进去会让 I-SBX-5 的构造期断言与一个可变字段共处一室，每次消费都要重建整个策略对象。**语义也不同**：`ExecutionPolicy` 回答"怎么跑"，`InitialTask` 回答"跑什么"。
- **`initial_prompt_consumed_at` 不因 T-2 而多余**：T-2 把"首次"从"终端第一次连上"挪到了"provision 第一次跑"，但 **`stopped → starting` 重启会再跑一次 provision**（23 I-SBX-9）。没有这一列，重启就会把同一条指令再执行一遍——而 agent 上一轮很可能已经改过文件，重放是破坏性的。P22 §2 的既有文案也明示重启是"开启新的 agent 会话、上下文不保留"，不是"重做这个任务"。
- **为什么 DTO 不回显**：① 展示侧没有消费方——列表要的是**默认任务名**（P21-1 §9：取首行前 20 字符），那是 `name` 列的事，后端在 T1 算好即可，顺带补掉"前端刷新后拿不到 prompt、算不出默认名"这个既有缺口；② **MCP 面是决定性理由**——`list_sandboxes` / `get_sandbox` 与 REST 共用同一个 `SandboxDto`，回显意味着一个被诱导的上层 agent 一次 `list_sandboxes` 就能读走全部历史任务指令（可能含仓库路径、内部系统名、业务上下文，正是前端红线要防的那类内容）；③ 前端红线的原文是"**不落前端持久化**"，与"后端能不能回显"是两件事——但既然没有消费方，就不开这个口子。将来真需要（如"重新发起相同任务"），加字段比删字段容易。

### 落点

| 文件 | 改动 |
|---|---|
| `13 §2.1.1` | 两列定义 + CHECK + 索引说明；`13 §2.1.4` ER 同步 |
| `23 §5.1/§5.2/§5.3/§5.8` | 聚合字段 `initialTask`、不变量 **I-SBX-10**、值对象 `InitialTask`、映射为列 |
| `10 §7.3` | `SandboxDto` 显式注明**不含** `initialPrompt` + `name` 的派生口径 |
| `02 §5.1` · `27 §2` | 创建端点说明：落库 + 默认名派生 + 不回显 |
| `24 §1.1/§1.3` · `26 §1` | T1 内随 `Sandbox.create` 一并写入 |
| `frontend/15 §3.5` | 红线措辞收紧为"前端不 persist"，明示后端落库不违反它 |
| `25 §5.1/§5.8` | 用例改写（见 T-2） |

---

## T-2 "启动时即执行"由谁触发

### 结论

**在 provision workflow 的 `starting` 段内新增一步 `bootstrapAgentSession`**（不新增状态机状态）：

```
starting:  provider.start()  →  沙箱内 agent 就绪探测（03 §4）
        →  ensureRuntimeInstalled（T-3）
        →  prepareRuntimeCredential → injectCredential → recordRuntimeInjection（T-5/T-6）
        →  bootstrapAgentSession       ← 本条新增
        →  running
```

- `bootstrapAgentSession` 起一个**平台持有的 agent 会话**：`initialPrompt` 非空 ⇒ `buildStartCommand({ prompt, headless:false })`，为空 ⇒ `buildAttachCommand()`；成功后置 `initial_prompt_consumed_at`。
- **终端网关一律 attach 已存在的会话，自己不再判断"首次"**（06 §3 / 26 §8 改写）。
- **只对 `headless=false` 执行**。`headless=true` 的 Task 其执行路径属 T-4 的后续切片，S5 内不起 agent（现状即如此，本条只是把它写明）。

### 理由

- 产品 P20 §0 与 02 §5.2 都承诺"agent 启动时即执行"，但既有设计把它绑在 `openSession` 的首个会话上，导致三个后果：① 用户创建完关掉浏览器 ⇒ 指令永不执行；② **MCP `create_sandbox` 根本没有终端 ⇒ 必不执行**，与 02 §5.2 的说明正面矛盾；③ S5 已 live 验证的"agent 真改文件"闭环，在设计上没有对应的触发路径。
- 挪到 provision 之后，三个后果同时消失，且 T-1 的"首次"判定从"网关要记住谁是第一个"退化成"provision 只跑一次 + 一列时间戳"。
- **不新增状态机状态**：它是 `starting` 内的一步，失败按 `starting` 失败处理（`provider.destroy` → 删工作区 → 回滚配额 → `failed`），没有专属的清理动作，不满足 03 §4.0 立状态的三条判据。

### 无 tmux 镜像怎么办（本条最需要交代的一半）

04 §7 明确 **tmux 是建议非必须**（缺失时 `validate()` 出 warning + `supportsTmux:false`，终端网关降级 ring buffer）。因此 `bootstrapAgentSession` 分两档，**且档位由沙箱内实测决定、不由镜像声明决定**：

| 档 | 判定 | 形态 | 代价 |
|---|---|---|---|
| **A（首选）** | 沙箱内 `command -v tmux` 命中 | `spawn({tty:true})` 跑 `tmux new-session -d -s platform-agent <cmd>`；会话由 **tmux server 持有**，平台侧不需要保持任何连接。终端网关此后一律 `tmux attach` | 无 |
| **B（降级）** | 沙箱内没有 tmux | `spawn({tty:true, cmd})` 由 **terminal 上下文（网关）持有 `ProcessStream`**，配 06 §6 既有的 ring buffer；**与断线重连的区别只有一个：没有 grace timer**——它不是"等前端回来"的临时保活，而是 sandbox 存续期内平台自持的会话 | ① 首次 attach 前的输出受 ring buffer 上限截断（超出部分不可回看）；② **平台进程重启 ⇒ pty 归属者消失 ⇒ agent 会话中断**（tmux 档不受影响）。两条都要在 04 §7 的镜像约定里写给镜像作者看 |

- **为什么用 `command -v tmux` 而不是 `ResolvedImageSpec.supportsTmux`**：与 04 §2.1★ 已确立的方法论一致——运行时事实一律实测。而且 `supportsTmux` 目前只在 04 §7 的散文里出现，`ResolvedImageSpec` 的类型声明里**并没有这个字段**（契约缺口，见"仍需处理"）；即使补上，它也只是注册期的静态声明，镜像换了 tag 就可能过期。`supportsTmux` 保留其原有职责：注册期给用户一条 warning。
- **被否掉的第三种方案**：无 tmux 时把 `initialPrompt` 当无头任务跑（`spawn({tty:false})` + 日志文件）。否掉的理由是它同时破坏"终端可观察"（用户点开终端看到的是一个和 agent 无关的干净 shell）并且**提前实现 T-4 里刚决定不做的那套东西**（输出传输 + 日志存储），两头不讨好。

### 落点

| 文件 | 改动 |
|---|---|
| `03 §4.3`（新） | `starting` 段的五步顺序 + 两档 bootstrap + 失败归属 |
| `24 §1` 时序 · `24 §1.1/§1.2/§1.3` · `24 §8.1` | 时序图插步（并修正 `provider.start` 与 exec 类步骤的错序）、命令与服务表、事务表 |
| `26 §1` 调用图 · `26 §1.2` 文件清单 · `26 §8` | `bootstrap-agent-session` 端口/实现；`openSession` 分支改写为"一律 attach" |
| `06 §3` · `06 §6` | 初始指令不再由网关判定；B 档的"平台自持会话"语义 |
| `04 §7` | 镜像约定加严：无 tmux 的两条实际代价 |
| `02 §5.2` · `P20 §0` | `create_sandbox` 的"启动即开工"现在名副其实 |
| `25 §5.1/§5.8` | `E2E-8-initialPrompt` 改写 + 新增 bootstrap 用例 |

---

## T-3 install 编排落哪 + 事务归属

### 结论

1. **`ensureRuntimeInstalled` 三步（`getInstallPlan` → `isInstalled` → 必要时 `install`）落在 provision workflow 的 `starting` 段**，排在 `provider.start()` + agent 就绪探测之后、凭证注入之前。
2. **`runtime_installations` 的初值写入在 T1 之外**，由 provision workflow 用自己的短事务写。
3. **sandbox 状态机不加细分态**；安装进度改投影为 WS 事件 **`runtime.install_progress`**（源事件 `RuntimeInstallationStateChanged`，本就 ✅ Outbox）。
4. **install 失败 ⇒ `starting → failed` + `failure_reason`**；错误码 `INSTALL_FAILED` 补进 04 §4 映射表、02 §6.1 与 P22 §1。

### 理由

- **已知冲突的解法**：13 §2.3.2（S5 定稿）要求"初值由 `getInstallPlan(imageSpec)` 决定"，而 04 §3 把 `getInstallPlan` 的调用时机写成"创建流程校验阶段"——落到 T1 里就直接违反 23 §4.2「一次事务一个聚合」，因为 `RuntimeInstallation` 是独立聚合（D-5），且 §4.3 的两处例外都不适用（它不是"同一业务事实的两张投影表"）。
- **解法不是给 §4.3 开第三个例外，而是把两件事拆开**：`getInstallPlan` 是**纯函数**（04 §3 明确"不产生副作用、不碰网络"），在创建校验阶段调它没有任何问题——它的产物是给用户的**提示**（"这张镜像上 claude-code 要装 12.5 分钟，建议换镜像"）。**写库的是另一件事**，落在 provision。
- **更硬的一条**：初值里的 `installed` 分支必须经 `isInstalled()` 探测确认（13 §2.3.2 已定），而 `isInstalled(exec)` 要 `exec`，`exec` 要实例已经在跑。**所以初值在 T1 里物理上就无法落定**——这不是纪律问题，是时序问题。13 §2.3.2 里"创建流程校验阶段"的表述必须改。
- **为什么不加 sandbox 细分态**：理由同 D-5——安装有自己的状态机，塞进 sandbox 的 12 态里等于一个聚合两个状态机；而且第三方 runtime 一注册就可能带来新的安装语义，状态枚举不该随 registry 变。前端要的是"卡在哪"，一条 WS 事件就够，不必动状态机。
- **为什么新开一条 WS 事件而不是复用 `sandbox.status_changed`**：后者的语义是"**每一次**状态机转移"（10 §3.1），前端据此 patch 列表项状态并驱动进度卡。装 CLI 期间 `status` 恒为 `starting`，硬塞进去会推出一串"状态没变的状态变更事件"，破坏前端的 patch 语义。

### 落点

| 文件 | 改动 |
|---|---|
| `13 §2.3.2` | 初值写入落点改为 provision workflow（附"T1 里做不到"的时序理由） |
| `23 §4.3` · `23 §7.2` | 例外表加一句"不得为它开第三个例外"；D-5 补写入落点 |
| `23 §12` · `10 §3.1` · `10 §7.4` · `10 §7.6` | 新增 `runtime.install_progress` 投影与帧类型，WS 事件 6 → **7** |
| `27 §1.3` · `27 §7` · `27 §10.8` · `27 §12` | 四处计数同步 |
| `24 §1` · `26 §1` · `03 §4.3` | 时序/调用图插入 `ensureRuntimeInstalled` 三步 |
| `04 §4` · `02 §6.1` · `P22 §1` · `27 §2` | `INSTALL_FAILED` 的映射与人话 |

---

## T-4 无头 Task 不进 S5（范围裁决）

### 结论

**`run_agent_task` / 无头 Task 产品化不进 S5**，整块归后续切片。S5 的闭环边界是：**Task 发起 → 装 CLI → 注入凭证 → agent 在终端里真跑**。

### 理由（四条缺口，是一整块新设计而不是收尾）

| 缺口 | 现状 |
|---|---|
| **无 handler** | 27 §2 `runAgentTask` 行的 command/query 与 WS 事件列都是 `—`；26 里没有 `run-agent-task` handler |
| **输出传输未定案** | 全平台只有 1 个 SSE 端点（诊断），WS 事件里没有任务输出通道。要么开第 2 个 SSE，要么扩 WS 协议——都是需要单独裁决的事 |
| **日志存储只有 automation 口径** | `automation_runs.log_path`（03 §8.6）挂在 `automation_runs` 行上；**非自动化的无头 Task 没有 run 记录** ⇒ 没有 `logPath`、没有查询端点、没有 exit 落点。把它做对 = 把日志存储从 automation 口径**上提为 Task 口径**，是新的表/新的端点 |
| **MCP 未注册** | 实际注册 8 个 tool，`run_agent_task` 不在其中（02 §5.2 已按实际改写） |

而 S5 的核心闭环不依赖它：终端就是观察面，`buildStartCommand({headless:false})` 就是执行入口。

### 必须说清的一件事（否则会误导）

**S5 的 live 技术验证跑的正是无头路径**（`codex exec`）——它证明的是**机制成立**：CLI 装得上、凭证注得进、内层 bwrap 关得掉、agent 真能改文件、不收敛的进程杀得死。**这些结论已定、不需要重验**。但它们的**落点**分两处：

- 落在 **S5**：`buildStartCommand` 关内层沙箱（04 §3 ★2）、`isInstalled` 走 PATH（04 §3 ★1 / §2.1★）、注入形态（05 §1★★）、`$HOME` 实测（04 §2.1★）——这些交互式路径同样要用。
- 落在 **后续切片**：硬超时 + 两阶段强杀（04 §3 ★3 / 03 §8.3）、无头 stdout/stderr 捕获与轮转（03 §8.6）——**结论已定、落点在后续切片**，S5 内不实现。

> 交互式 Task 在 S5 内的兜底不受影响：它走 idle 回收（30min）+ 硬超时 24h（P20 §0），不依赖 03 §8.3 的无头硬超时。

### 落点

`27 §2`（`runAgentTask` 行标 ⏳ + 四条缺口）· `02 §5.2`（tool 表按实际改写 + 计数）· `10 §6.1`（端点标 ⏳）· `03 §8.3` / `03 §8.6` / `04 §3 ★3`（标注"结论已定、落点在后续切片"）· `27 §1.3`/`§12`（MCP tool 计数）。

---

## T-5 谁构造"占位版 auth.json"、在哪一步

### 结论（四条，其中第 2 条与提案不同）

1. **类型分家（把纪律换成类型系统保证）**：注入路径拿到的对象**结构上就没有 `authFile`**。
   - `prepareRuntimeCredential(runtimeId): Promise<InjectableRuntimeCredential>`——无 `authFile` 字段；
   - 刷新扫描器另走 `prepareForRefresh(credentialId): Promise<RefreshableRuntimeCredential>`（= injectable + `authFile`），**只有 05 §5.1 的 scanner 调它**；
   - `injectCredential(cred: InjectableRuntimeCredential, exec)`——**把"注入路径拿不到真 refresh_token"变成编译期事实**，而不是一句注释。
2. **脱敏形态在"凭证出生时"由 adapter 产出并分字段存储，注入路径上不做任何转换**（⚠️ 与提案不同，理由见下）：
   - `completeAuth` / `createCredentialFromSecret` / `parseRefreshedAuth` 产出凭证时，**同时**给出 ① 脱敏后的 `credentialFiles[]`（`refresh_token` 值已替换为占位常量，**字段保留**）与 ② 平台专用的完整 `authFile`；
   - `RuntimeSecretPayload` 本来就有这两个独立字段，落库时各存各的；
   - credential 上下文只做**取舍**（注入给 ①、刷新给 ②）与出口纪律（`SecretMaterial` / `zeroize`），**不解析任何 provider 的 JSON**；
   - `injectCredential` 只负责"把这份 content 写到目标路径、`0600`"，**不 parse、不改字段**。
3. **占位串定为 shared-kernel 的一个常量**（如 `RUNTIME_REFRESH_TOKEN_PLACEHOLDER`）。理由：它同时要被 **domain**（断言）、**adapter/infrastructure**（构造）、**contracts 里的 testkit**（断言）三方引用，而 23 §4.5 禁止 domain import contracts ⇒ **shared-kernel 是唯一三方都够得着的位置**。
4. **testkit 加硬断言**（比任何论证都硬），进 04 §10.3 RuntimeAdapter 条款：
   - **RA-15**：用假 `SandboxExecFn` 捕获 `injectCredential` 交给 `exec` 的**全部字节**（argv + stdin + 写文件内容），断言**不含**该凭证的真 `refresh_token` 值；
   - **RA-16**：注入产物里 `tokens.refresh_token` **恰等于**占位常量（不是"缺失"，也不是"空串"——删字段会让 codex 报 `missing field 'refresh_token'`，05 §1★★）；
   - **RA-17**：走一条 `authFile` 非空的用例（即凭证确实带着完整 auth.json 存在库里）跑 RA-15/16，断言**仍不泄漏**——这一条专门盯"分支漏改"。

### 为什么第 2 条改了提案的写法

提案是"**脱敏后的 auth.json 由 credential 上下文构造**，adapter 只负责写文件"。它的目标（adapter 不该在注入路径上摸到真 refresh_token）是对的，但**把构造放进 credential 上下文会撞另一条更基本的边界**：

- **auth.json 的字段结构是"某个 agent CLI 的怪癖"**，而 04 §3 开篇就把这类知识划给 adapter。credential 上下文一旦要 parse codex 的 JSON，就必须 `if (runtimeId === 'codex')`——而 runtime 是 **registry 可扩展的开放 id**（10 §7.2），第三方注册一个凭证文件格式不同的 runtime，credential 上下文当场失效。
- **更好的做法是让真 refresh_token 根本不出现在注入路径上**：脱敏形态在凭证**出生时**就产好并单独存字段，注入时直接取现成的。这比"注入时现场脱敏"严格更强——现场脱敏至少要把真值传进来一次，而现在连传都不传。
- **一个必须承认的边界**：`completeAuth` / `parseRefreshedAuth` **本来就会看到真 refresh_token**（它们是从登录 pty / 刷新回写里把它捞出来的那一方，这无法避免）。所以可执行的红线不是"adapter 永不接触真 refresh_token"，而是——
  > **`injectCredential` 永远拿不到真 refresh_token**（由第 1 条的类型分家保证），采集侧的 `completeAuth` / `parseRefreshedAuth` 照 05 §4 / 23 §8.3 的通用出口纪律办（`Buffer` 承载、`use()` 借出、`finally zeroize()`、不进 argv/日志）。

  这条红线**可被 RA-15/16/17 机械验证**，而"adapter 不该看见"验证不了。

### 落点

`05 §4.3`（新，两条路径的结构性隔离 + 占位串 + 出生时脱敏）· `05 §4` 物化行 · `05 §7` #3 · `04 §3`（contract 草图与 `injectCredential` 行）· `04 §10.3`（RA-15/16/17；并修 RA-06，见 T-6）· `23 §8`/`§8.2`（门面签名、I-CRD-2 补充）· `25 §3.4`/`§4.3`。

> **本步只写文档裁决**：`packages/contracts` 的类型拆分（`InjectableRuntimeCredential` / `RefreshableRuntimeCredential`）、`CredentialFacade` 加 `prepareForRefresh`、shared-kernel 常量落地，全部属**下一步**的契约层改动。

---

## T-6 `$HOME` 何时展开

### 结论

1. **`credentialFiles[].containerPath` 的语义改为 `~/` 相对路径**（如 `~/.codex/auth.json`）；不接受绝对路径。
2. **`$HOME` 展开只能发生在 `injectCredential(cred, exec)` 内部**——那里有 `exec` 可以真探测（一次 `printf '%s' "$HOME"` 或 `cd ~ && pwd`），且每个沙箱各探各的、结果不跨沙箱复用。
3. `RuntimeCredential.credentialFiles[].containerPath` 现有的 **"Absolute container paths" 类型注释必须改掉**（下一步的契约改动）。
4. **04 §10.3 的 RA-06 同步修订**：现文要求"路径为**绝对路径**"，与本条正面冲突 ⇒ 改为"必须是 `~/` 相对形态，断言**不以 `/` 开头**"。

### 理由

- `prepareRuntimeCredential(runtimeId)` 的签名里**只有 runtimeId**：构造 `RuntimeCredential` 的那一刻，credential 上下文根本不知道这份凭证要注进哪个沙箱，更无从知道那个沙箱的 `$HOME`。而**同一份凭证本来就要能注入不同沙箱**（"登录一次、处处可用"是 05 §2 决策 A 的全部意义），把展开提前到构造期等于给凭证绑定一个沙箱。
- **"碰巧一样"不构成硬编码的理由**：04 §2.1★ 实测两个 provider 经平台通道看到的 `$HOME` 同为 `/home/gem`，但 04 §7 已经明确"HOME 路径不属于镜像约定的一部分，约定只要求 HOME 可写"，并且专门写了一句"恰恰因为两侧碰巧一样更容易诱人硬编码，本条更要坚持"。第三方镜像、上游镜像升级、换 base image 都会打破它。
- 这与 T-3 的 `isInstalled` 走 `command -v`、T-2 的 tmux 走 `command -v` 是**同一条方法论**的三次应用：沙箱内的运行时事实一律实测。

### 落点

`05 §4` 物化行 · `05 §4.3` · `04 §3`（`RuntimeCredential` 注释与 `injectCredential` 行）· `04 §10.3` RA-06 · `04 §7`（HOME 约定加指针）。

---

## 1. 仍需人来拍板 / 下一步才能做的事

| # | 事项 | 现状 |
|---|---|---|
| 1 | **契约层类型改动**：`InjectableRuntimeCredential` / `RefreshableRuntimeCredential` 拆分、`CredentialFacade.prepareForRefresh`、`containerPath` 注释、shared-kernel 占位常量 | 本文只定裁决，改动属下一步（用户已明示） |
| 2 | **`ResolvedImageSpec` 没有 `supportsTmux` 字段** | 04 §7 的散文里说 `validate()` 会在 `ResolvedImageSpec` 上"标记 `supportsTmux:false`"，但 §7 的类型声明里没有这个字段。T-2 已把**运行期判定**改为沙箱内实测，所以它不阻塞 S5；但注册期 warning 要真能落地，仍需补这个字段（随镜像管理切片） |
| 3 | **无 tmux 镜像下"平台重启即中断 agent 会话"是否可接受** | T-2 的 B 档代价已写明并写进镜像约定。若判定不可接受，唯一的正解是把 tmux 从"建议"升为"必须"（改 04 §7 + IS-05 从 SHOULD 升 MUST）——那是产品/运维口径的决定，不是技术能单方面定的 |
| 4 | **`headless=true` 且带 `initialPrompt` 的创建请求**如何应答 | 当前接受但不起 agent（T-4 之前也是如此）。要不要在 S5 内改成 400 提示"无头 Task 暂未支持"，取决于自动化 v1.1 的排期——自动化创建的正是这种 Task，提前 400 会把 v1.1 的设计路径堵死。**当前裁决：不加 400，在 27 §2 写明边界** |
| 5 | **02 §5.2 的 MCP tool 表与实际注册项的既有漂移** | 本次按实际改写（8 个已注册，另 5 个设计中未注册）。漂移不止 `run_agent_task` 一条——文档里没有的 `get_project` / `retry_clone` / `delete_project` 三个其实已注册。**MCP tool 计数目前仍是人工核对**（27 §12 已标 ⏳），建议后续给 `docs:check` 加一条 B 类检查 |
