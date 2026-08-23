# 06 - TTY 终端链路设计（后端半段）

> 状态：✅ 可评审（基于 2026-08 调研结论；§8 按产品定稿 P20 §9.8 补充 waiting-input 检测）
> **⚠️ S5 裁决改写（[TASK-LAUNCH-DECISIONS](../TASK-LAUNCH-DECISIONS.md) T-2 / 裁决 D-15）**：**agent 会话不再由终端网关创建**——它在 provision workflow 的 `starting` 段由 `bootstrapAgentSession` 起好（03 §4.3 ⑤），网关**一律 attach**。改写落点：§3（初始任务指令）· §6（两档方案从「断线重连方案」升格为「会话持有方式」）· §9。
> **⚠️ 2026-08 再次改写（用户裁决：tmux 升 MUST）**：**B 档（无 tmux ⇒ 网关自持 pty + ring buffer）整体取消**，§6 只剩 tmux 一档；ring buffer 随之退役（判断依据见 §6.3）。轨迹与取代理由见 04 §7 ★ 与 TASK-LAUNCH-DECISIONS T-2。
> 关联文档：[08 前端 xterm 集成](../frontend/08-前端xterm集成.md) · [04 Contract 体系](./04-Contract与Registry扩展体系.md) · [10 WS 协议类型](../shared/10-接口契约与类型共享.md) · [03 §4.1/§4.2 判定口径定案](./03-Sandbox调度中心.md)

## 1. 链路总览

```
前端 xterm ◀─WS /terminal─▶ TerminalGateway ◀─ProcessStream─▶ provider.spawn({tty:true}) ─▶ sandbox 实例
                                (socket.io)      (04 §2.4)        aio / boxlite                  │
                                                                                       tmux session（唯一形态）
                                                                                              └─ codex/claude CLI
                                                                （会话由 provision 的 bootstrapAgentSession 起，03 §4.3 ⑤；
                                                                 tmux 是镜像必须项，无 tmux 的镜像不合格 —— 04 §7 / §6）
```

## 2. 网关选型

- `@nestjs/websockets` + `@nestjs/platform-socket.io`，namespace `/terminal`。
- 选 socket.io 理由：房间、重连、多路复用原语开箱即用，工程成本低；对延迟极敏感时备选纯 `ws`（协议开销更小），网关抽象保证可替换。
- **鉴权（S1 审查 P1-1 修复项，不得留 no-op）**：终端 WS 握手**必须**校验访问口令/会话。`PasscodeGuard`（`APP_GUARD`）对非 http 上下文自豁免，故网关须在 `handleConnection` 里显式校验 `handshake.auth`/cookie（复用 `PasscodeService.verifySessionToken`）。理由：给 root shell 的这条链路是访问口令唯一能被绕开的入口。安全姿态权威见 [SANDBOX-RUNTIME-DECISIONS](../SANDBOX-RUNTIME-DECISIONS.md)。

## 3. PTY 获取：`provider.spawn({ tty: true })`

终端会话即 `SandboxProvider.spawn({ tty: true, cols, rows, reuse? })` 返回的 **`ProcessStream`**（定义见文档 04 §2.4，本文不重复声明）：

- `ref` 落库 `terminal_sessions.exec_id`；`reuse` 传同一 ref 复用既有会话（断线重连，§6）。
- **初始任务指令：⚠️ 已挪出网关（S5 裁决 D-15，[TASK-LAUNCH-DECISIONS](../TASK-LAUNCH-DECISIONS.md) T-2）**。此前本条写的是「首个会话的 `cmd` 由 adapter 按 `RuntimeTaskSpec.prompt` 组装为带指令启动 CLI」——**该逻辑现在属于 provision workflow 的 `bootstrapAgentSession`**（03 §4.3 ⑤）：agent 会话在 `starting` 段就已经起好并开始执行，与用户有没有点开终端无关。
  - **网关侧的新规则：一律 attach 已存在的 agent 会话**（`tmux attach -t platform-agent`，§6），**不判断「首次」、不调 `buildStartCommand`**。
  - **为什么必须挪**：绑在 `openSession` 上时，① 用户创建完关掉浏览器 ⇒ 指令永不执行；② **MCP `create_sandbox` 根本没有终端 ⇒ 必不执行**，与 02 §5.2 的说明正面矛盾；③ P20 §0「启动时即执行」是产品承诺。
  - **兜底**：会话意外不存在时（tmux server 被沙箱内进程杀掉、session 名被误删等；**「无 tmux 镜像下平台重启」这条原因已随 B 档取消而消失**，§6），网关按 `buildAttachCommand()` 起一个干净会话并记 warning——**不重放 `initialPrompt`**（消费标记见 23 I-SBX-10）。
- 网关拿到的是**已解复用的干净字节流**——流头、多路复用、tty 下 stderr 合并全部由 provider 内部消化（04 §2.2 的 spawn 语义），网关不做任何解码。

实现对照（04 §2.2）：

| 实现 | spawn(tty=true) 的内部形态 | 实现内部注意 |
|---|---|---|
| `aio` | 经 in-sandbox API `ws /v1/shell/ws` → 中立 `ProcessStream`（AIO 协议翻译在 provider 内，**非宿主 docker exec**） | tty 单一输出流、无需 demux；AIO ws 帧 ↔ ProcessStream 映射见 ADR |
| `boxlite` | 同上（同一 AIO 镜像跑进 BoxLite Box，经端口转发到 Box 内 `:8080`） | BoxLite 库进程内嵌，无 daemon |

> **网关设计不因此改变**：网关始终只跟中立 `ProcessStream` 打交道——`spawn` 内部走 in-sandbox API（`/v1/shell/ws`）还是 fallback `docker exec`，对网关透明。数据面选型（沙箱内 API，docker exec 仅 fallback）与 AIO↔ProcessStream 翻译的权威定义见 [SANDBOX-RUNTIME-DECISIONS](../SANDBOX-RUNTIME-DECISIONS.md)。

node-pty 仅在未来"本地进程 provider"场景才需要（node-gyp 原生编译坑随之而来）；当前两个内建实现都不依赖它。

## 4. resize 同步

前端 xterm `fit()` → WS `resize` 帧 `{cols, rows}` → 网关 → `stream.resize(cols, rows)`（ProcessStream 统一方法，落到何种底层调用是实现内部的事）。两端严格同步，否则内容错位（前端节流策略见文档 08 §4）。

## 5. 多路复用

- 一个 sandbox 允许多个终端会话（多 tab）：每个会话对应一次独立的 `spawn({tty:true})`。
- 网关维护 `Map<socketId, ProcessStream>` + `Map<sandboxId, Set<sessionId>>`。
- sandbox 销毁（`SandboxStateChanged` 事件）→ 级联关闭全部会话。

## 6. 断线重连与 scrollback（关键设计）

> **⚠️ 本节被改写过两次，按时间读**：
> ① **S5 裁决 D-15**：两档方案原先只服务「断线重连」，此后**同时是 agent 会话的持有方式**——会话由 `bootstrapAgentSession` 在 `starting` 段建立（03 §4.3 ⑤），先于任何 WS 连接存在。
> ② **2026-08 用户裁决（tmux 升 MUST，04 §7 ★）**：**B 档整体取消**，本节只剩一档。取代理由是 B 档的代价②「平台进程重启 ⇒ pty 归属者消失 ⇒ agent 会话中断」不可接受。被取代的 B 档形态存档在 03 §4.3 ⑤ 与 TASK-LAUNCH-DECISIONS T-2，**本节不再保留第二份副本**。

### 6.1 会话持有：tmux（唯一形态）

- sandbox 内 CLI 跑在 `tmux` session（`platform-agent`）中——**镜像约定要求必须含 tmux**（04 §7，2026-08 从「建议」升为「必须」）；会话由**沙箱内的 tmux server 持有**，平台侧不需要保持任何连接。
- 网关始终 attach 该 session。WS 断开 = detach；重连 = re-attach。**天然保活 + 恢复现场**，CLI 进程完全不受前端断连、也不受平台重启影响。
- **镜像撒谎的处置不在本节**：起会话前的 `command -v tmux` 实测未命中 ⇒ 实例 `starting → failed` + `IMAGE_CONTRACT_VIOLATION`（03 §4.3 ⑤），**网关这一侧不再有「无 tmux 怎么办」的分支**——能走到网关的 sandbox 一定已经有 tmux 会话。

### 6.2 断线重连机制（与档位无关，一直都在）

- 断开时网关 `detach()`，**不销毁沙箱内的会话**；重连时前端带回 `socketSessionKey`，网关重新 attach 到同一个 tmux session（`spawn({reuse: ref})`，或直接再跑一次 `tmux attach`——两者等价，见 04 §10.2 SP-T2）。
- **`socketSessionKey` 由服务端生成（审计 P2-9）**：开会话时服务端产出 128 bit 随机串随首帧下发，前端只负责持久化并在重连时带回。**不能让前端自选**——它是重连凭据，前端自选意味着猜到或拿到别人的 key 就能 attach 到别人的终端（本平台没有用户体系，这是唯一的会话归属凭据）。同时校验：重连请求携带的 key 必须属于**未 closed** 的会话，且该 sandbox 未销毁。
- **命名边界（审计 P1-5 的延伸裁决）**：**DB 列是 `socket_session_key`（snake），对外的 URL query 参数与 TS 字段是 `socketSessionKey`（camel）**，映射在 gateway 层完成——与全局约定一致（对外一律 camelCase，DB 一律 snake_case，02 §5.1）。看到两种写法**不是漏改**：query 参数属对外契约、列名属存储。
- **scrollback 的权威是沙箱内的 tmux**：re-attach 默认只重绘**当前屏**，完整历史依赖 tmux `history-limit` + `capture-pane` replay（前端侧说明见 08 §5.2）。网关不再持有任何 scrollback 副本。

### 6.3 ring buffer 的处置：随 B 档一起退役（判断依据写在这里，别再照旧实现）

**判定：ring buffer 是 B 档的产物，没有独立于 tmux 的用途，因此不再需要。** 依据三条：

1. **原文归属**：ring buffer 整块挂在旧 §6「B 档：网关侧持有 pty + ring buffer」标题下；`01 §5` 的目录注释与 `26 §9` 的文件清单对 `ring-buffer.ts` 的职责描述都是**「无 tmux 镜像的降级缓冲」**——三处同源，指向同一个唯一用途。
2. **A 档下没有「输出到了却没人收」的窗口**：断线的处置是 `detach()`（26 §9 `#handleDisconnect` 明写「tmux 天然保活」），网关不留 pty，缓冲无对象可缓；断线期间的输出由沙箱内的 tmux 自己收着。
3. **它曾承担的两件事都已有 tmux 侧的承接者**：① 「首次 attach 前的输出留存」由 tmux 的 `history-limit` 承接（08 §5.2 本来就是这么写的）；② 「重连后的 replay」由 re-attach 重绘承接（08 §3/§8 第一类场景、24 §8 时序）。

**同时退役的 grace timer / 延迟销毁 pty**：它们从「保活必需」降为**可选的性能优化**——现在 kill 掉的只是网关侧的 `tmux attach` 进程，agent 会话不受影响，所以「超时未重连才真正 kill」不再有正确性含义，最多省掉一次 re-attach 的几百毫秒（08 §5.2 已明确接受这个代价）。**实现上按最简处理：断开即 detach，不留计时器。**

**没有退役、不要连坐删除的东西**：`socketSessionKey` 的生成/校验/命名边界（§6.2）是会话归属凭据，与档位无关；`frame-batcher.ts` 的 16ms 合并（§7）与 `WaitingInputDetector` 的 4KB `tailBuffer`（§8.1）都是各自独立的机制，跟 ring buffer 只是名字听起来像。

对前端的协议语义**没有变化**（重连 + 后端重绘），前端无需改动——原先那句「两方案对前端暴露同一协议语义」现在退化成「只剩一种方案，语义就是它」。

## 7. 输出流控

- 高频输出（agent 刷日志）时网关做**批量合并转发**（约 16ms 聚合一批），与前端写入节流（文档 08 §6）配合，避免 WS 小包风暴。
- 心跳 ping/pong 帧维持连接活性检测。

## 8. 活跃度与 `waiting-input` 检测（网关是唯一检测点）

网关是链路上**唯一持有已解复用 pty 字节流**的地方，因此两件事都落在这里：sandbox 的活跃度上报（喂 idle 回收）与 `waiting-input` 子态检测（喂列表 🔵 等待输入）。判定口径与误报纪律的定案在 **03 §4.1 / §4.2**，本节只写网关侧的实现形态。

### 8.1 会话级检测器

每个 tty 会话（`Map<sessionId, WaitingInputDetector>`）维护：

```ts
interface WaitingInputDetector {
  lastOutputAt: number;        // 最近一次 pty data 帧（毫秒）
  tailBuffer: string;          // 最近输出的尾部（上限 4KB，滚动截断）——只为取"最后一个非空行"
  waiting: boolean;            // 当前会话是否判定为等待输入
}
```

- **data 帧到达**（§7 的 16ms 批量合并**之后**，与转发前端同一批）：`lastOutputAt = now`；追加进 `tailBuffer`；若 `waiting` 为 true 则**立即**置 false 并上报。
- **client input 帧到达**：同样立即置 false 并上报（用户已经在输入，显然不在"等待"）。
- **定时器**：网关级单个 1s tick 扫描全部会话（不是每会话一个 timer——上百会话时 timer 风暴），对 `now - lastOutputAt > waitingInputSilenceSec`（默认 10s）的会话，剥离 ANSI 转义后取 `tailBuffer` 最后一个非空行，匹配 `terminal.promptPatterns` 正则集（03 §4.1 列出默认集）→ 命中则置 `waiting=true` 并上报。
- 已经 `waiting=true` 的会话不重复上报（只在**翻转**时推事件）。

### 8.2 sandbox 级聚合与上报

- sandbox 的子态 = **其全部 attached tty 会话都 waiting**（任一会话在刷输出即说明 agent 在干活，03 §4.1）；会话关闭时从集合移除并重算。
- 翻转时推 WS `sandbox.waiting_input { sandboxId, waiting, sessionId? }`（协议见 10 §7.4）。
- 状态只存网关内存，**不落库、不进状态机、不进 `sandbox_state_transitions`**（03 §4.1）。
- **`GET /api/sandboxes*` 的派生字段 `waitingInput` 怎么取（审计 P1-12 修正）**：terminal 的 **application 层**暴露只读查询端口 `WaitingInputQueryPort { isWaiting(id) / filterWaiting(ids) }`，sandbox 的查询处理器经 DI 注入它。**sandbox 不得直接读网关/检测器的内存态**——那是跨上下文摸对方内部实现，违反 01 §5；检测器本身仍留在 `terminal/infrastructure`（§8.1）。批量接口 `filterWaiting` 是必需的：列表一次几十个 sandbox，逐个调用会退化成 N 次跨层查询。网关重启后一律回落为 `false`，下一次静默满 10s 自然重新判定——这个"漂移"的最坏后果只是图标短暂缺失，符合 03 §4.1 的容忍度红线。

### 8.3 活跃度上报（idle 口径）

- 同一批 data 帧 / input 帧同时刷新 sandbox 的 `last_active_at`：**内存实时、落库节流 ≥10s 一次**（03 §4.2）。
- 全部终端会话关闭后停止刷新，`SandboxReaper` 的 idle 计时正常推进；**无终端会话的无头 Task 不参与 idle 回收**，其兜底是硬超时（03 §8.3）。
- `waiting-input` 期间**不**刷新 `last_active_at`——等待用户输入本身就是空闲（03 §4.2）。

## 9. 风险与备选

| 风险 | 缓解 |
|---|---|
| tty 模式误用 demux 导致输出乱码 | 已收敛为 provider 实现内部注意事项（§3）；testkit 的 spawn 条款覆盖 |
| tmux 依赖对镜像的侵入（**2026-08 已由裁决承担**） | tmux 升为镜像**必须**项：`validate()` 缺 tmux 即 `errors[]`/`valid:false`（04 §7 / testkit IS-05），注册期就挡住；运行期起会话前仍 `command -v tmux` 实测，未命中 ⇒ `starting → failed` + `IMAGE_CONTRACT_VIOLATION`（03 §4.3 ⑤）。**代价是自定义镜像的门槛提高了一点**——这是明知并接受的取舍（04 §7 ★） |
| ~~无 tmux 镜像下平台重启中断 agent 会话~~（S5 曾登记，**已消灭而非缓解**） | 该风险是 B 档独有的；B 档取消后不存在。**留这一行是为了不让它以「要不要加个 ring buffer 兜底」的形式重新长出来**——会话保活现在只有一条路：沙箱内的 tmux |
| node-pty 原生编译坑 | 两个内建实现不依赖 node-pty；仅未来本地进程 provider 需要 |
| WS 网关成为单点瓶颈 | 单机可接受；多节点时网关随 RemoteSandboxProvider 代理化（文档 11） |
| **提示符启发式误报/漏报**（§8） | 只驱动展示、不驱动任何决策（03 §4.1 红线）；阈值与正则集可配；`tailBuffer` 上限 4KB 防高频输出撑内存 |
| **网关重启丢失 waiting 内存态**（§8.2） | 一律回落 false，10s 后自然重判；不做持久化（写放大代价远大于收益） |
