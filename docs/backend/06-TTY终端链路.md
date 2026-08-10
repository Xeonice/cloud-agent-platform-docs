# 06 - TTY 终端链路设计（后端半段）

> 状态：✅ 可评审（基于 2026-08 调研结论；§8 按产品定稿 P20 §9.8 补充 waiting-input 检测）
> 关联文档：[08 前端 xterm 集成](../frontend/08-前端xterm集成.md) · [04 Contract 体系](./04-Contract与Registry扩展体系.md) · [10 WS 协议类型](../shared/10-接口契约与类型共享.md) · [03 §4.1/§4.2 判定口径定案](./03-Sandbox调度中心.md)

## 1. 链路总览

```
前端 xterm ◀─WS /terminal─▶ TerminalGateway ◀─ProcessStream─▶ provider.spawn({tty:true}) ─▶ sandbox 实例
                                (socket.io)      (04 §2.4)        aio / boxlite                  │
                                                                                            tmux session
                                                                                              └─ codex/claude CLI
```

## 2. 网关选型

- `@nestjs/websockets` + `@nestjs/platform-socket.io`，namespace `/terminal`。
- 选 socket.io 理由：房间、重连、多路复用原语开箱即用，工程成本低；对延迟极敏感时备选纯 `ws`（协议开销更小），网关抽象保证可替换。
- 鉴权预留：`@UseGuards(WsAuthGuard)`，当前 no-op 实现（见文档 11）。

## 3. PTY 获取：`provider.spawn({ tty: true })`

终端会话即 `SandboxProvider.spawn({ tty: true, cols, rows, reuse? })` 返回的 **`ProcessStream`**（定义见文档 04 §2.4，本文不重复声明）：

- `ref` 落库 `terminal_sessions.exec_id`；`reuse` 传同一 ref 复用既有会话（断线重连，§6）。
- **初始任务指令**：Task 携带 `initialPrompt` 时（产品 P20 §3.2），首个会话的 `cmd` 由 adapter 按 `RuntimeTaskSpec.prompt` 组装为"带指令启动 CLI"（`buildStartCommand` 的交互式用法：headless=false）；未携带则用 `buildAttachCommand()` 纯净进入。
- 网关拿到的是**已解复用的干净字节流**——流头、多路复用、tty 下 stderr 合并全部由 provider 内部消化（04 §2.2 的 spawn 语义），网关不做任何解码。

实现对照（04 §2.2）：

| 实现 | spawn(tty=true) 的内部形态 | 实现内部注意 |
|---|---|---|
| `aio` | 容器内分配 TTY 的交互式会话 | 容器 runtime 的 tty 模式是单一输出流、**无需 demux 8 字节头**（demux 只在非 tty 时需要）——经典实现坑，收敛在 aio 内部 |
| `boxlite` | Box（micro-VM）内交互式会话 | 库层直接交出流，无 daemon 中转 |

node-pty 仅在未来"本地进程 provider"场景才需要（node-gyp 原生编译坑随之而来）；当前两个内建实现都不依赖它。

## 4. resize 同步

前端 xterm `fit()` → WS `resize` 帧 `{cols, rows}` → 网关 → `stream.resize(cols, rows)`（ProcessStream 统一方法，落到何种底层调用是实现内部的事）。两端严格同步，否则内容错位（前端节流策略见文档 08 §4）。

## 5. 多路复用

- 一个 sandbox 允许多个终端会话（多 tab）：每个会话对应一次独立的 `spawn({tty:true})`。
- 网关维护 `Map<socketId, ProcessStream>` + `Map<sandboxId, Set<sessionId>>`。
- sandbox 销毁（`SandboxStateChanged` 事件）→ 级联关闭全部会话。

## 6. 断线重连与 scrollback（关键设计）

**首选方案：tmux re-attach**

- sandbox 内 CLI 跑在 `tmux` session 中（镜像约定必须含 tmux，见文档 04 §7）；网关始终 attach 该 session。
- WS 断开 = detach；重连 = re-attach 同一 tmux session。**天然保活 + 恢复现场**，无需自建缓冲，CLI 进程完全不受前端断连影响。

**备选方案（镜像无 tmux 时降级）：网关侧 ring buffer**

- 网关维护最近 N KB 输出的 ring buffer + grace timer（如 60s）。
- 断线后延迟销毁 pty；前端凭 `socketSessionKey`（经 WS 连接 URL query 携带 `?socketSessionKey=`，不占用帧协议）在窗口期内重连 → 复用 pty + 补发缓冲（对应前端的 replay 请求，文档 08 §3）。
- **`socketSessionKey` 由服务端生成（审计 P2-9）**：开会话时服务端产出 128 bit 随机串随首帧下发，前端只负责持久化并在重连时带回。**不能让前端自选**——它是重连凭据，前端自选意味着猜到或拿到别人的 key 就能 attach 到别人的终端（本平台没有用户体系，这是唯一的会话归属凭据）。同时校验：重连请求携带的 key 必须属于**未 closed** 的会话，且该 sandbox 未销毁。
- **命名边界（审计 P1-5 的延伸裁决）**：**DB 列是 `socket_session_key`（snake），对外的 URL query 参数与 TS 字段是 `socketSessionKey`（camel）**，映射在 gateway 层完成——与全局约定一致（对外一律 camelCase，DB 一律 snake_case，02 §5.1）。看到两种写法**不是漏改**：query 参数属对外契约、列名属存储。
- 超时未重连才真正 kill。

两方案对前端暴露同一协议语义（重连 + replay），前端无感知差异。

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
- 翻转时推 WS `sandbox.waiting_input { sandboxId, waiting, sessionId? }`（协议见 10 §3）。
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
| tmux 依赖对镜像的侵入 | ImageSpec validate 产 warning + `supportsTmux` 标记（04 §7）；无 tmux 自动降级 ring buffer |
| node-pty 原生编译坑 | 两个内建实现不依赖 node-pty；仅未来本地进程 provider 需要 |
| WS 网关成为单点瓶颈 | 单机可接受；多节点时网关随 RemoteSandboxProvider 代理化（文档 11） |
| **提示符启发式误报/漏报**（§8） | 只驱动展示、不驱动任何决策（03 §4.1 红线）；阈值与正则集可配；`tailBuffer` 上限 4KB 防高频输出撑内存 |
| **网关重启丢失 waiting 内存态**（§8.2） | 一律回落 false，10s 后自然重判；不做持久化（写放大代价远大于收益） |
