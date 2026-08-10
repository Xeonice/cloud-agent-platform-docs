# 08 - 前端终端子系统详细设计（xterm.js）

> 状态：✅ 可评审（2026-08 调研 + 产品定稿复核 + 审计裁决同步）
> 关联文档：[06 TTY 终端链路（后端半段）](../backend/06-TTY终端链路.md) · [07 前端目录结构](./07-前端目录结构与视图逻辑分离.md) · [15 状态管理](./15-前端状态管理.md) · [12 测试体系](./12-前端测试体系.md)
> 产品权威：[P21-1 工作台](../product/pages/21-1-工作台.md) · [P22 §2 终端使用阶段](../product/22-异常场景与产品补充要求.md) · 页面落点见 [F21-1](./pages/21-1-工作台.md)
>
> **阅读导航**：§1 选型论证 · §2 包设计与加载 · §3 协议层 · §4 resize · §5 实例管理与 LRU · §6 性能 · §7 分层落地/生命周期/配置 · §8 会话语义边界 · §9 复核结论 · §10 风险 · **§11 逻辑调用设计（文件级调用树，实现时按这一节写）**

## 1. 选型（引擎 · 渲染器 · addon 逐个定论）

### 1.1 引擎与版本锁定

| 项 | 结论 |
|---|---|
| 包名 | **`@xterm/xterm`**。**旧包名 `xterm` 已停止发布**，官方已把全部包迁到 `@xterm` npm org——**禁止使用旧包**，也禁止新旧混装（两套包会各带一份 CSS 与类型，实例互不识别） |
| 版本 | **锁 5.x 线的最后一个稳定小版本（`@xterm/xterm@5.5.x`）**，`package.json` 写精确版本 + lockfile 提交 |
| 为什么锁 5.x 而不是追最新 | ① **addon 生态与 5.x 一一对齐**——本项目要装 4–5 个 addon，主版本领先于 addon 会出现"引擎升了、addon 没跟"的空窗；② 5.x 是社区案例与踩坑记录最厚的一条线（本文引用的 WebGL 上下文、resize 花屏等坑均基于此）；③ 终端渲染引擎属于"稳定压倒新特性"的依赖，没有非升不可的功能诉求 |
| 何时评估升级 | 出现下列任一：需要仅新版提供的能力、安全公告、或**全部在用 addon 都已发布对应新版**。升级走独立 PR + 长稳测试（§9/文档 16 §5），不夹带业务改动 |
| CSS | `@xterm/xterm/css/xterm.css` 必须显式 import（否则光标/选区/滚动条全错位）；import 位置见 §2.3 |

> ⚠️ 本节相对早期版本有**实质变更**：早期文档写的是"6.0.0 稳定 / 求稳可锁 5.x"，现按审计后的稳定性优先原则**明确锁定 5.x**。具体 patch 号以安装时 lockfile 为准，不在文档里追写。

### 1.2 渲染器决策：默认 WebGL，可降级 Canvas，不用 DOM

xterm 的渲染层是可替换的，三条路各有硬性代价：

| 渲染器 | 吞吐（agent 刷日志场景） | 资源约束 | 字体/清晰度 | 结论 |
|---|---|---|---|---|
| **WebGL**（`addon-webgl`） | **最高**，GPU 合成，滚动与大段输出不掉帧 | **每实例占用一个 WebGL 上下文**；浏览器对同源页面并发上下文有硬上限（Chrome/Safari 量级 **8–16**），**接近上限时最早的上下文被静默回收**（表现为旧终端黑屏/花屏且**无任何报错**） | 好 | ✅ **默认** |
| **Canvas**（`addon-canvas`） | 中高，够用 | **无上下文约束**，可开更多实例 | 好 | ✅ **降级路径**（WebGL 不可用 / 上下文预算吃紧） |
| **DOM**（xterm 内置默认） | 最低，大段输出明显卡顿 | 无 | 一般 | ❌ 仅作最后兜底（两个 addon 都加载失败时 xterm 自然回落，不主动选择） |

**决策**：默认加载 `addon-webgl`；**加载后立刻监听其 `onContextLoss`**，一旦上下文丢失就 `dispose()` 该 addon 并**热切到 canvas**（不重建 Terminal、不清屏）。初始化时若 `WebGL2RenderingContext` 不可用则直接走 canvas。

这条与 §5 的 LRU 上限是**同一个约束的两面**：上下文是全局稀缺资源，所以既要**限实例数**（LRU 4–6），也要**有丢失后的活路**（热切 canvas）。只做其中一条都会在"用户开了很多终端"时翻车。

### 1.3 addon 逐个定论

| addon | 结论 | 理由 |
|---|---|---|
| `@xterm/addon-fit` | ✅ **KEEP（必选）** | 容器尺寸 → `cols/rows` 的唯一换算来源；resize 全链路（§4）的起点。自己算字符宽高等于重写它 |
| `@xterm/addon-webgl` | ✅ **KEEP（默认渲染器）** | §1.2；配套 `onContextLoss` 处理 |
| `@xterm/addon-canvas` | ✅ **KEEP（降级路径）** | §1.2；**按需动态 import**，只在需要降级时才进包 |
| `@xterm/addon-unicode11` | ✅ **KEEP** | agent 输出大量 emoji / box-drawing / CJK。**宽字符测量错会导致光标位置与实际不符**（用户看到的光标在字符中间、退格删错位置）——这是终端类应用最难排查的一类 bug，装一个 addon 就能规避。需同时开 `allowProposedApi: true` 并设 `unicode.activeVersion = '11'` |
| `@xterm/addon-web-links` | ✅ **KEEP** | agent 输出常含 URL（文档链接、PR 链接）；不可点击时用户要手动选中复制，体感差距明显。**限制协议白名单为 http/https**，避免 `javascript:` 类伪协议 |
| `@xterm/addon-search` | 🕐 **DEFER（v1.1）** | 长会话里查关键字确实是刚需，但需要配套搜索框 UI + 快捷键，属完整功能而非"装上就有"。MVP 先靠浏览器原生查找 + 后端日志导出兜底 |
| `@xterm/addon-serialize` | 🕐 **DEFER（v1.1，仅当要做淘汰占位快照）** | 唯一用途是 §5 提到的"LRU 淘汰前存最后一屏快照"作重开时的占位。但 **scrollback 权威在后端**（§5），快照只是视觉过渡；MVP 先接受"淘汰后重开短暂空白 + tmux 重绘" |
| `@xterm/addon-attach` | ❌ **DROP** | 见 §3——它只做最朴素的双向直连，缺重连/resize/心跳/多路事件 |
| `@xterm/addon-ligatures` | ❌ **DROP** | 连字对终端可读性收益存疑（`->` 变箭头反而影响列对齐判断），且带字体分析开销 |
| `@xterm/addon-image` | ❌ **DROP** | sixel/iTerm 图像协议，本项目 agent CLI 无此场景 |
| `@xterm/addon-clipboard` | ❌ **DROP** | OSC52 远程剪贴板：**让容器内进程能写用户剪贴板**，在"跑不受信任 agent"的语境下是净风险面；复制走 §7.4 的原生选区复制即可 |

**扩展纪律**：新增 addon 必须在本表登记结论与理由。终端是长驻组件，每个 addon 都常驻内存并参与渲染热路径，"先装上以后再说"的代价是隐性的。

## 2. 包设计与加载策略

### 2.1 依赖清单

| 包 | 版本 | 依赖类型 | 在哪一层 import | 体积量级（min+gzip） | 加载时机 |
|---|---|---|---|---|---|
| `@xterm/xterm` | 5.5.x（精确锁） | `dependencies` | `hooks/useTerminalInstance.ts`（**唯一 import 点**） | 约 100–150 KB 量级 | 动态（§2.2） |
| `@xterm/xterm/css/xterm.css` | 同上 | — | 同上（随 hook 的动态 chunk 一起） | 数 KB | 动态 |
| `@xterm/addon-fit` | 与引擎配套 | `dependencies` | 同上 | < 5 KB | 与引擎同 chunk |
| `@xterm/addon-webgl` | 与引擎配套 | `dependencies` | 同上 | 约 20–30 KB 量级 | 与引擎同 chunk |
| `@xterm/addon-canvas` | 与引擎配套 | `dependencies` | 同上 | 约 20–30 KB 量级 | **按需**（仅降级时） |
| `@xterm/addon-unicode11` | 与引擎配套 | `dependencies` | 同上 | 约 10 KB 量级 | 与引擎同 chunk |
| `@xterm/addon-web-links` | 与引擎配套 | `dependencies` | 同上 | < 10 KB | 与引擎同 chunk |

体积一律写"量级"而非精确数字——精确值随版本浮动，写死会立刻过期；**真正的约束是"终端相关代码不进首屏 chunk"**（§2.2），而不是某个具体 KB 数。CI 侧用 bundle 体积预算门禁盯住回归（文档 09）。

**唯一 import 点纪律**：`@xterm/*` 只允许在 `hooks/useTerminalInstance.ts` 内 import。理由有二——① 分层铁律要求 view 不持副作用，xterm 实例化是重副作用；② 单一 import 点让"动态加载/降级/版本升级"只需改一个文件。ESLint 用 `no-restricted-imports` 把 `@xterm/*` 对其余目录设为禁止（07 §4）。

### 2.2 SSR 规避与动态加载（Next.js App Router）

`@xterm/xterm` 依赖 `window`/`document`，必须同时做到：

1. 实例化 xterm 的组件文件顶部 `'use client'`；
2. **仍需** `next/dynamic(() => import(...), { ssr: false })` 包一层——client component 在 App Router 下仍会经历构建期预渲染探测，直接 import xterm 可能因构建阶段访问 `self`/`navigator` 报错；
3. `ssr: false` 的 dynamic import 只能写在**调用方也是 client component** 的文件里（Server Component 中禁止）。

推荐结构：`TerminalPane.view.tsx`（纯展示，持 `<div ref>`）由 `containers/TerminalContainer.tsx`（'use client'）通过 `next/dynamic` 懒加载真正实例化 xterm 的子层，避免把整棵路由树标记 client-only。

**三级加载时序**（首屏不阻塞）：

```
① 首屏（app/page.tsx）           工作台骨架 + 左侧任务树         —— 不含任何 xterm 代码
② 选中第一个 Task                next/dynamic 拉 terminal chunk  —— 引擎 + fit/webgl/unicode11/web-links
③ WebGL 不可用 / 上下文丢失      await import('@xterm/addon-canvas') —— 仅此时才拉降级 chunk
```

- **无选中 Task 时终端 chunk 完全不加载**（空态只渲染引导文案）——这是"首屏不阻塞"的实质：绝大多数冷启动路径（初始化向导、建项目引导、设置页）根本不该付终端的包体成本。
- 加载中 `TerminalPane` 渲染骨架而非空白；加载失败给 [重试]，**不静默留白**。
- addon 的 `loadAddon()` 时机固定在 `terminal.open()` **之后**（fit/webgl 都需要已挂载的 DOM 与尺寸），顺序见 §7.2。

### 2.3 code-split 边界

| chunk | 内容 | 触发 |
|---|---|---|
| `main` | 工作台壳层、任务树、横幅、cmdk | 首屏 |
| `terminal`（独立） | `useTerminalInstance` + `@xterm/*` 引擎与常驻 addon + `xterm.css` | 首次选中 Task |
| `terminal-canvas`（独立） | `@xterm/addon-canvas` | 仅降级时 |
| `settings/*` | 三个设置子页 | 进入 `/settings/*`——**不含终端代码**（F21-3/4/5 无终端） |

CSS 随 `terminal` chunk 一起动态注入，**不放全局 layout**——否则设置页也会付这份样式成本，且全局样式表里的 `.xterm` 规则容易与页面样式互相干扰。

## 3. WebSocket 对接：手写协议层（不用 addon-attach）

`addon-attach` 只做"WS message ↔ terminal.write / onData"最简单直连，**缺失**：断线重连、resize 帧、心跳、多路事件（stdout / resize / exit-code）。

自定义 JSON 帧协议（与后端 PTY 网关对齐，类型定义见文档 10 的 `ws-protocol.ts`）：

```
浏览器 → 服务端
  { type: 'input',  payload: string }          # 用户键入
  { type: 'resize', cols: number, rows: number }
  { type: 'ping' }

服务端 → 浏览器
  { type: 'data',   payload: base64 }          # 终端输出
  { type: 'exit',   code: number }
  { type: 'pong' }
```

`services/ws/ptySocket.ts` 封装职责：

- **WebSocket 构造函数通过参数注入**（默认全局 `WebSocket`）——为 bun test 提供 mock 注入点，避免依赖 `mock.module`（其跨文件泄漏问题见文档 12 §3.1.1）
- 连接建立 / 关闭 / 错误分类
- **指数退避 + jitter 重连**（上限次数 + 最大间隔；xterm 官方无内置重连，应用层实现是业界共识）
- 断线时终端内 toast（sonner）提示"连接已断开，正在重连…"
- **`socketSessionKey` 的持有与回带**：连接 URL 为 `/terminal?socketSessionKey=`（对外 camelCase，审计 P1-5；DB 列名 `socket_session_key` 是后端内部形态）。该 key **由服务端生成**（128 bit 随机串，开会话时随首帧下发，审计 P2-9 / 技术 06 §6）——**前端绝不自造、不用 sandboxId 或任何可猜值代替**：本平台没有用户体系，它是终端会话归属的唯一凭据，前端自选等于谁猜到谁就能 attach 别人的终端。ptySocket 只负责"存下来、重连时带回"，且**不写入 persist**（会话级凭据，随页面生命周期即可）
- 重连成功后由后端恢复现场：**首选容器内 tmux re-attach 自动重绘**；镜像无 tmux 时降级为网关 ring buffer 重放最近 N KB（两方案对前端暴露同一协议语义，见文档 06 §6）
- 心跳保活

MVP 过渡策略：可先用 addon-attach 跑通链路，但 `ptySocket.ts` 从一开始就抽象为独立 service，后续替换为自定义协议成本可控。

### 3.1 ptySocket 的连接状态机与参数

```
[idle] ──connect()──▶ [connecting] ──open──▶ [open] ◀──────────────┐
                          │ error/close         │ close            │ open
                          ▼                     ▼                  │
                     [reconnecting] ◀───────────┘   ──退避 delay──▶─┘
                          │ 达最大次数 / 会话已终结
                          ▼
                       [closed]（"连接超时 [手动重连]"，P22 §2）
```

| 参数 | 取值 | 理由 |
|---|---|---|
| 重连退避 | 指数 + jitter：`min(30s, 500ms × 2^n) × (0.5~1.0)` | jitter 防"断网恢复瞬间全部终端同时重连"打爆网关 |
| 最大重连次数 | 8 次（约 2 分钟窗口） | 超过后转 `closed` + [手动重连]，不无限重试耗电 |
| 心跳 | 每 20s 发 `ping`；**45s 未收到任何帧**（含 `pong`）判定链路死 → 主动 `close` 触发重连 | 只靠 TCP 超时会挂很久，用户看着一个"活着但不动"的终端 |
| 帧解析 | 每帧 `zod safeParse`（文档 16 §3：**WS 是全链路唯一无编译期保障的契约**） | 开发环境 fail-fast 横幅，生产上报但**不阻断渲染**——协议小问题不该让终端白屏 |
| 背压 | 见 §6 的写入批处理；socket 层不缓冲业务数据，只做帧解码 | 缓冲职责单一化，避免两层各缓一份 |

**终止条件（与 §8 会话语义联动）**：重连循环只服务"同一会话的传输层中断"。当 Task 主状态转 `stopped/idle/failed`（来自 `sandbox.status_changed`）时，`useSandboxTerminalSocket` **必须显式停止重连**——否则会对一个已经不存在的 pty 无限重试，前端表现为永远的"正在重连…"黄条。

### 3.2 为什么不是 addon-attach：边界说清楚

`addon-attach` 的定位是"把一个已有 WebSocket 的字节流直接怼进终端"，它**假设链路永远在、且链路上只有终端字节**。本项目两条假设都不成立：

| 需求 | addon-attach | 自写 ptySocket |
|---|---|---|
| 断线重连 + 退避 | ❌ 无 | ✅ §3.1 |
| `resize` 帧 | ❌ 无（cols/rows 无法上报） | ✅ §4 |
| 心跳/死链检测 | ❌ 无 | ✅ §3.1 |
| 多路事件（data / exit / pong） | ❌ 只有一种字节流 | ✅ 判别式 union |
| 重连凭据 `socketSessionKey` | ❌ 无概念 | ✅ §3 |
| 运行时契约校验（zod） | ❌ 无 | ✅ §3.1 |
| 单测可注入 mock WebSocket | ❌ 依赖真实 WS | ✅ 构造函数注入 |

结论：attach 能省的只有"几十行编解码"，而缺的每一项都是必须补的。它唯一的价值是**MVP 早期跑通链路的临时替身**，且因为 `ptySocket.ts` 从一开始就是独立 service，替换成本被限制在一个文件内。

## 4. fit addon 与 resize 同步

- `ResizeObserver` 监听终端容器尺寸变化 → **必须节流**（150ms debounce 或 ResizeObserver + rAF 合并）。已知高频坑：无节流会在拖拽/CSS transition 期间高频触发 `fit()`，导致前端可视尺寸与后端 PTY 尺寸不一致、内容错位。
- `fitAddon.fit()` 算出新 `cols/rows` → WS 发送 `resize` 帧 → 后端调用 `pty.resize()`，两端严格同步。
- 触发时机：首次挂载、窗口 resize、**侧栏展开/收起**（改变终端容器宽度）、**任务树项目组折叠/展开**（`taskListFolds` 变化改变侧栏内容高度，若采用可伸缩侧栏则同样影响终端宽度）。

### 4.1 三条必须守住的 resize 纪律

1. **隐藏的终端不 fit**。`display:none` 的容器尺寸为 0，此时 `fit()` 会算出 `cols/rows` 接近 0 并上报，后端 pty 被 resize 成畸形尺寸，切回来满屏乱码。`useTerminalInstance` 在 fit 前必须判 `container.offsetParent !== null`（或 `clientWidth > 0`）。**切回可见时补一次 fit**（见 §11.5 切 tab 链路）。
2. **相同尺寸不发帧**。debounce 后与上次已上报的 `{cols, rows}` 比对，相等则跳过——拖拽结束时的最后一次触发经常与上一次同值，白发一帧。
3. **连接未 open 时只存不发**。resize 早于 WS 建连是常见时序（组件挂载即 fit），此时把目标尺寸暂存，`open` 后作为**首帧之一**补发；否则后端 pty 会一直用默认 80×24。

### 4.2 尺寸与字体的耦合点

`fit()` 的换算依赖当前字体度量，因此**改字号必须紧跟一次 fit**：`setFontSize() → terminal.options.fontSize = n → fitAddon.fit() → 上报 resize`。漏掉最后两步会出现"字变大了但列数没变，右侧内容被裁掉"。字号 persist 见 §7.3。

## 5. 多会话终端实例管理与 LRU

**推荐：已访问过的会话各保留独立 Terminal 实例 + LRU 上限**（拒绝"每次切换销毁重建"）。

### 5.1 registry 的键是 sessionId，不是 sandboxId

产品要求同一个 Task 可开**多个终端标签**（P21-1 §6：标签切换 / [×] / [新标签]，后端多路复用见 06 §5）。因此实例注册表必须**以会话为粒度**：

```typescript
// stores/createTerminalRegistrySlice.ts（结构，文档 15 §3.2）
interface TerminalEntry {
  sessionId: string;          // 前端会话标识（标签身份），本地生成
  sandboxId: string;          // 所属 Task
  socketSessionKey?: string;  // 后端下发的重连凭据（§3；不 persist）
  terminal: Terminal;         // 非可序列化，绝不进 Query cache / persist
  socket: PtySocket;
  container?: HTMLDivElement;
  renderer: 'webgl' | 'canvas' | 'dom';
  connState: 'connecting' | 'open' | 'reconnecting' | 'closed';
  lastActiveAt: number;
}
interface TerminalRegistrySlice {
  entries: Map<string /* sessionId */, TerminalEntry>;
  bySandbox: Map<string /* sandboxId */, string[] /* sessionId[]，标签顺序 */>;
  activeSessionOf: Map<string /* sandboxId */, string /* sessionId */>;
  // action 只做记账，不做业务判断（15 §3.2 "store 保持哑"）
  register(entry): void; dispose(sessionId): void; touch(sessionId): void;
}
```

**为什么不能用 `sandboxId` 当键**：一个 Task 两个标签就会互相覆盖——第二个标签建实例时挤掉第一个的 entry，第一个标签的 Terminal 变成没人持有的孤儿（既不渲染也不释放，内存泄漏 + WebGL 上下文泄漏）。**LRU 也必须按 session 计数**，因为 WebGL 上下文是按 Terminal 实例占用的，不是按 Task。

> 📌 一致性说明：文档 15 §3.2 与 07 §2 早期写的是 `Map<sandboxId, ...>`，那是"一个 Task 一个终端"假设下的简写。本节是终端子系统的权威定义，15/07 已同步为会话粒度。

### 5.2 切换与淘汰

- 切换会话：
  - 已有实例 → 用 **CSS `display:none` 隐藏未选中容器**而不销毁。不要反复 `open()`/`dispose()`——会丢 WebGL 渲染上下文且有性能开销；xterm 支持多个隐藏容器各持有自己的 Terminal 实例。
  - 未打开过 → 新建 Terminal + 新 WS 连接。
- **LRU 淘汰**：并发实例超上限（**默认 4–6 个**）时，对最久未激活者 `terminal.dispose()` + 关 WS；可保留"最后一屏文本快照"作再次打开时的占位，真实内容依赖后端 replay。
  - **为什么是 4–6 而不是 8–10**（审计 P2-11）：每个启用 WebGL renderer 的 Terminal 各占一个 **WebGL 上下文**，而浏览器对同源页面的并发上下文数有硬上限（Chrome/Safari 量级在 **8–16**），**接近上限时最早的上下文会被浏览器主动回收**——表现为"切回某个旧终端，画面是黑的/花的，但没有任何报错"。把默认压到 4–6 是给上下文预算留安全余量，代价只是多一次 tmux re-attach（几百毫秒，且用户无感——见 §8 第一类场景，静默重建不提示）。
  - 上限做成**可配常量**而非硬编码；WebGL 不可用而降级到 canvas renderer 时可放宽到 8–10（无上下文约束），由 `useTerminalInstance` 按实际 renderer 决定。
- **scrollback 权威在后端会话**（tmux session 首选 / 网关 ring buffer 降级，文档 06 §6）：前端实例保留只是渲染缓存。注意 tmux 路径下 re-attach 默认只重绘**当前屏**，完整历史依赖 tmux `history-limit` + `capture-pane` replay（后端实现细节）；用户刷新页面后能恢复多少历史由后端会话能力决定。

为什么不销毁重建：每次切换都会"清空→重连→重渲染 scrollback"闪烁 + 网络开销；后端若不支持 replay 则历史输出直接丢失。

### 5.3 淘汰策略的两条细则

- **活跃会话永不淘汰**：LRU 候选集排除当前可见的 session，否则在上限边缘会出现"刚切过去就被自己挤掉"。
- **淘汰顺序按 `lastActiveAt`，`touch()` 只在真正激活时调**——不要在每次 `write()` 时 touch，否则一个刷屏的后台会话会把自己顶成"最近使用"，挤掉用户真正在看的那个。

## 6. 性能

### 6.1 写入批处理（唯一必须做的性能优化）

agent 刷日志时后端可能每秒推送数百个小帧。逐帧 `terminal.write()` 会把渲染压垮（每次 write 都可能触发一次重排/重绘）。

```
data 帧 → lib/writeBatcher.ts#push(bytes)
            └─ 累积到 buffer，requestAnimationFrame（≈16ms）合并一次
                 └─ terminal.write(merged)
```

| 细则 | 取值/做法 | 理由 |
|---|---|---|
| 合并窗口 | rAF（≈16ms，跟随屏幕刷新） | 比固定 `setInterval(16)` 更省——页面不可见时 rAF 自动停，后台标签页不空转 |
| 单批上限 | 达到阈值（如 256 KB）立刻 flush，不等下一帧 | 防止一次巨量输出把单帧 write 拉成长任务 |
| 隐藏会话 | 仍然 write（保持内容连续），但**不 fit、不滚动到底** | 内容不能丢；但对不可见容器做布局计算是纯浪费（§4.1 纪律 1） |
| 卸载 | `dispose()` 前 flush 残留 buffer 并取消 rAF | 防止 dispose 后回调仍写入已销毁实例（xterm 会抛） |

### 6.2 其他

- 启用 `@xterm/addon-webgl` + fallback 检测（不支持 WebGL 自动降级 canvas，§1.2）。
- `scrollback` 有内存代价，取值与理由见 §7.3。
- **不要在 `onData` 里做任何同步重活**：它在键盘事件路径上，任何阻塞都直接体现为"打字卡顿"。ptySocket 的 `send` 必须是 fire-and-forget。

## 7. 分层落地、实例生命周期与配置

### 7.1 分层落地（对应文档 07 的铁律）

| 层 | 文件 | 职责 |
|---|---|---|
| view | `views/terminal/TerminalPane.view.tsx` | 只持有 `<div ref>` 容器 + toolbar 事件转发 |
| view | `views/terminal/TerminalTabBar.view.tsx` | 会话标签条：切换 / [×] / [新标签]（props 驱动） |
| view | `views/terminal/TerminalToolbar.view.tsx` | 复制 / 清屏 / 字号 |
| view | `views/terminal/ConnectionStatus.view.tsx` | 终端顶部内嵌条（重连黄条 / 连接超时） |
| container | `containers/TerminalContainer.tsx` | 'use client' + next/dynamic 装配；连接 hooks 与 view |
| hook | `hooks/useTerminalInstance.ts` | **唯一 import `@xterm/*` 的文件**：Terminal 创建/挂载/addon/配置/fit/写入批处理/dispose |
| hook | `hooks/useSandboxTerminalSocket.ts` | WS 生命周期/重连状态/终止条件/socketSessionKey 持有 |
| service | `services/ws/ptySocket.ts` | 唯一 WebSocket 触点，协议帧编解码 + zod 校验 |
| lib | `lib/writeBatcher.ts` | rAF 批量合并写入（纯函数式，可单测，§6.1） |
| lib | `lib/terminalTheme.ts` | 主题与字体栈常量（§7.3），无副作用 |
| store | `stores/createTerminalRegistrySlice.ts`（useAppStore） | 实例注册表（会话粒度）+ LRU 记账（文档 15 §3） |

### 7.2 实例生命周期全图（每步落在哪一层）

```
                      ┌──────────────── React 树内 ────────────────┐
用户点任务/新标签 ──▶ │ TerminalContainer ──▶ TerminalPane.view     │
                      │        │                  │ <div ref>       │
                      └────────┼──────────────────┼─────────────────┘
                               │ (1) attach(sessionId, ref)
                               ▼
                    hooks/useTerminalInstance
                               │
   (2) registry.get(sessionId)?─┴─是─▶ 复用：只把 ref 换成新 container + 补一次 fit
                               │
                              否
                               ▼
   (3) await import('@xterm/xterm')            —— 动态 chunk（§2.2）
   (4) new Terminal(options)                   —— 配置见 §7.3
   (5) terminal.open(container)                —— 必须先 open 再 loadAddon
   (6) loadAddon(fit / unicode11 / web-links)
   (7) loadAddon(webgl) → 失败或 onContextLoss → loadAddon(canvas)   —— §1.2
   (8) terminal.onData(cb) 绑定输入            —— §11.2
   (9) fitAddon.fit() → 首次 resize 帧          —— §4
  (10) registry.register({sessionId, terminal, socket, ...})
                               │
                               ▼
        ┌──────────── 运行期（实例活在 React 树外）────────────┐
        │  WS data 帧 → writeBatcher → terminal.write()        │
        │  用户键入 → onData → ptySocket.send({type:'input'})   │
        │  容器尺寸变 → ResizeObserver → debounce → fit → 帧    │
        │  切走 → container.style.display='none'（**不 dispose**）│
        └──────────────────────────────────────────────────────┘
                               │
                (11) LRU 超限 / 关闭标签 / Task 销毁
                               ▼
   flush writeBatcher → socket.close() → terminal.dispose() → registry.dispose(sessionId)
```

**关键点**：第 (5)(6)(7) 步顺序不可换——`fit` 与 `webgl` 都需要已挂载且有尺寸的 DOM；在 `open()` 前 `loadAddon(fit)` 会得到 0×0 的测量结果。

### 7.3 Terminal 配置详情

| 选项 | 取值 | 理由 |
|---|---|---|
| `scrollback` | **5000 行** | 前端只是渲染缓存（权威在后端 tmux，§5.2）。5000 行足够回看一次构建输出；再大则每实例内存显著上升，而 LRU 只允许 4–6 个实例并存 |
| `theme` | 纯黑底（`background: #000`）+ 产品暗色主题的前景/选区色，常量放 `lib/terminalTheme.ts` | 产品规定"全局暗色，终端区纯黑底"（P21 §3）；集中成常量避免主题色散落 |
| `fontFamily` | `'JetBrains Mono', 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace` | 等宽栈逐级降级；**必须以 `monospace` 收尾**，否则某些系统回落到比例字体会导致列对不齐 |
| `fontSize` | 默认 14，**persist**（uiSlice `terminalFontSize`，15 §3.5） | 产品要求字号记忆（P21-1 §6）；改动后必须补 fit（§4.2） |
| `cursorBlink` | `true` | 让"终端还活着"有视觉信号；开销可忽略 |
| `allowProposedApi` | `true` | `addon-unicode11` 的前置条件（§1.3） |
| `convertEol` | `false` | pty 输出已含 `\r\n`；开启会造成重复换行 |
| `macOptionIsMeta` | `true` | macOS 下 Option 作 Meta，符合终端用户肌肉记忆 |
| `scrollOnUserInput` | `true` | 用户键入时自动回到底部，避免"在历史里打字看不到回显" |
| `windowsMode` | `false` | 后端 pty 是 Linux 容器，无需 Windows 换行兼容 |

### 7.4 ref 挂载与 React 解耦（为什么实例必须活在 React 树外）

`TerminalPane.view.tsx` **只做一件事**：渲染一个 `<div ref={containerRef}>` 并把 ref 交出去。xterm 实例本身存在 registry（Zustand，React 树外）。

**必须这样的三个理由**：

1. **实例寿命 > 组件寿命**。切到别的 Task、路由到设置页再回来，React 会卸载/重建组件树；若实例随组件走，每次切换都要重连 + 重绘，产品明确要求的"切回来还在"就没了。
2. **React 不该托管非可序列化的重对象**。Terminal 持有 DOM、WebGL 上下文、事件监听；放进 state 会引发无谓的重渲染比较，放进 Query cache 更是直接违反"缓存数据可序列化"的假设（15 §1）。
3. **StrictMode 双调用友好**。开发环境下 effect 会执行两次，若"挂载即 new Terminal"就会创建两个实例。registry 的 `getOrCreate(sessionId)` 语义天然幂等——第二次拿到同一个实例。

**切走不 dispose 的具体机制**：`display:none` 隐藏容器，Terminal 与 socket 继续存活；此时 `write` 照常（内容不丢），但**不 fit、不滚动**（§6.1）。切回时 `display:''` + 补一次 fit 即可，无重连、无闪烁。

**唯一的 ref 竞态**：容器 ref 在 React 重挂载后是**新的 DOM 节点**，而 Terminal 已 open 在旧节点上。处理办法是 `attach()` 检测到 `entry.container !== newContainer` 时，把 xterm 的根元素**移动**到新容器（`newContainer.appendChild(terminal.element)`）而不是重新 `open()`——`open()` 只能调一次，重复调用会留下孤儿 DOM。

## 8. 会话语义边界：断线重连 ≠ 回收后重启（前端不做 replay 期待）

产品把两件容易混为一谈的事明确区分了（P22 §2 / P21-1 §9），前端必须按不同语义处理：

| 场景 | 后端语义 | 前端行为 | 文案纪律 |
|---|---|---|---|
| **WS 断线重连**（网络抖动、切标签、LRU 淘汰后重新点开） | **同一个会话**：tmux re-attach 恢复现场（镜像无 tmux 时降级 ring buffer 重放，§3） | 指数退避重连 + 顶部黄条"正在重连…（第 n 次）"；重连成功后**期待后端重绘**，前端不清屏、不自造历史 | 可以说"恢复现场" |
| **idle 回收后重启**（30min 无终端活动 → Stop → 用户点 [重启]） | **新会话**：容器已停、pty 已销毁，重启后是全新的 agent 进程 | **必须新建 Terminal 实例 + 新 WS 连接**，不复用被回收 Task 的 registry entry；**前端不对新会话做任何 replay 期待**——空白终端是正确结果，不是 bug | 文案**不得暗示"恢复现场"**；产品定文为「重启会开启新的 agent 会话，之前的对话上下文不会保留；工作区文件已保留」，按钮文案 [重启并开新会话] |
| **agent CLI 进程退出**（exit 137 OOM 等） | 会话内进程结束，pty 可能仍在 | 展示 exit code + 人话解释，提供 [重开会话] | — |

落地要点：

1. `useSandboxTerminalSocket` 的重连状态机**只服务于"同一会话的传输层中断"**；Task 主状态从 `running` 转 `stopped/idle` 时应**终止重连循环**（否则会对一个已经不存在的会话无限重试），转由列表侧的 [重启] 动作驱动新建。
2. Task 重启成功（WS `sandbox.status_changed` 回到 running）后，registry 里该 sandboxId 的旧 entry 必须先 `dispose()` 再新建——**同一 sandboxId 前后是两个会话**，复用旧 Terminal 会把上一会话的残留画面误导为"恢复的现场"。
3. LRU 淘汰后重新点开属于第一类（同一会话），**静默重建、不提示**（P21-1 §9）。

## 9. 产品定稿复核结论（2026-08）

针对 P20/P21/P22 定稿逐条比对，**xterm 集成方案本身无需变更**：

| 复核项 | 结论 |
|---|---|
| 包选型（`@xterm/*` + fit/webgl/web-links，不用 attach） | 结论无变更；**§1 已扩写为完整选型论证**并把版本明确锁定到 5.x 线、补齐 addon 逐个定论与渲染器对比 |
| SSR 规避（`'use client'` + `next/dynamic({ssr:false})`） | 无变更；设置页三子页不含终端，不受影响 |
| 手写 JSON 帧协议、重连与心跳 | 无变更 |
| fit/resize 节流 | 仅**新增一个触发时机**（任务树折叠，§4） |
| 多实例 registry + LRU | **默认上限由 8–10 下调至 4–6**（审计 P2-11，理由见 §5）；分组树把"更多项目的 Task"暴露在同一侧栏，切换频率上升会更快触达上限，因此更需要余量。淘汰后的重建是静默的（§8 第一类场景），用户侧无感 |
| 终端多标签（同一 Task 多路会话） | 后端能力无变更（06 §5）；**前端 registry 键由 `sandboxId` 修正为 `sessionId`**（§5.1）——原写法在"一个 Task 开两个标签"时会互相覆盖 |
| 会话语义 | **新增澄清**（§8）：断线重连有现场恢复，idle 回收后重启没有 |

## 10. 风险与备选

| 风险 | 等级 | 缓解 |
|---|---|---|
| 手写协议层开发成本高于 addon-attach | 中 | MVP 先 addon-attach，service 抽象保证替换成本可控 |
| 引擎与 addon 版本错配（引擎升了 addon 没跟） | 中 | **锁定 5.x 线 + lockfile 提交**（§1.1）；升级走独立 PR，前置条件是"全部在用 addon 已发布对应新版"；核心 addon 均官方一方维护 |
| 多实例常驻内存增长 | 中 | LRU 上限；必要时降级"仅保留最近 3 个实例 + 后端 replay" |
| **WebGL 上下文数量上限**（审计 P2-11） | **中高** | 每个启用 webgl renderer 的 Terminal 各占一个 WebGL 上下文，浏览器对同源页面的并发上下文有硬上限（Chrome/Safari 量级 **8–16**），**接近上限时最早的上下文被静默回收**——旧终端切回来是黑屏/花屏且无报错，极难归因。缓解：**LRU 默认降到 4–6**（§5）留出余量；WebGL 不可用降级 canvas 时可放宽；长稳测试中采样上下文数（文档 16 §5） |
| resize 节流不当导致花屏/错位（社区高频坑） | 中 | 严格 §4 debounce；集成测试覆盖"拖拽 resize 期间断线重连"场景（见文档 12） |
| 隐藏容器被 fit 出 0×0 尺寸 | 中 | §4.1 纪律 1：fit 前判可见性；切回时补 fit |
| dispose 后仍有回调写入（rAF/socket in-flight） | 中 | §6.1：dispose 前 flush + 取消 rAF；socket 先 close 再 dispose terminal（§11.7 顺序） |

## 11. 逻辑调用设计（文件级调用树）

> 节点格式 `目录/文件#函数()`，路径基于 [07 §2](./07-前端目录结构与视图逻辑分离.md) 的目录树。缩进表示调用层级，`▲` 表示回调方向（下层回调上层）。实现时按本节写即可。

### 11.1 打开终端（首次选中 Task / 新建标签）

```
views/project-task-tree/TaskListItem.view#onClick()
└─ containers/ProjectTaskTreeContainer#handleSelectTask(sandboxId)
   ├─ stores/createUiSlice#setSelectedSandboxId(sandboxId)
   └─（渲染切换）containers/TerminalContainer#render()
      ├─ hooks/useTerminalSessions#listSessions(sandboxId)        // 该 Task 有哪些标签
      │  └─ stores/createTerminalRegistrySlice#bySandbox.get(sandboxId)
      ├─（无会话时）hooks/useTerminalSessions#createSession(sandboxId)
      │  └─ 生成本地 sessionId（仅标签身份，**不是** socketSessionKey）
      └─ views/terminal/TerminalPane.view（<div ref={containerRef}>）
         └─ hooks/useTerminalInstance#attach(sessionId, containerRef.current)
            ├─ stores/createTerminalRegistrySlice#entries.get(sessionId)
            │  └─ 命中 → §11.5 复用分支（移动 DOM + 补 fit），到此结束
            ├─ await import('@xterm/xterm')                        // §2.2 动态 chunk
            ├─ new Terminal(lib/terminalTheme#buildOptions(fontSize))  // §7.3
            ├─ terminal.open(container)
            ├─ terminal.loadAddon(new FitAddon())
            ├─ terminal.loadAddon(new Unicode11Addon()) + activeVersion='11'
            ├─ terminal.loadAddon(new WebLinksAddon(handler))       // 协议白名单
            ├─ hooks/useTerminalInstance#setupRenderer(terminal)
            │  ├─ 可用 → loadAddon(new WebglAddon()) + onContextLoss → §11.8
            │  └─ 不可用 → await import('@xterm/addon-canvas') → loadAddon
            ├─ terminal.onData(d => ptySocket.send({type:'input', payload:d}))   // §11.2
            ├─ hooks/useSandboxTerminalSocket#connect(sessionId, sandboxId)      // ↓ 展开
            │  ├─ services/ws/ptySocket#create({ WebSocketCtor, url, onFrame, onState })
            │  │  └─ new WebSocketCtor(`/terminal?sandboxId=..&socketSessionKey=..`)
            │  │      // 首次连接无 key；服务端随首帧下发后由 hook 存入 registry（§3）
            │  ├─ ▲ onState('open') → registry#patchConnState(sessionId,'open')
            │  └─ ▲ onFrame(frame)  → §11.3
            ├─ fitAddon.fit() → hooks/useTerminalInstance#reportResize()          // §11.4
            └─ stores/createTerminalRegistrySlice#register(entry) + #enforceLru() // §11.7
```

**步骤讲解**：① 选中动作只改 UI 状态，终端的建立由渲染副作用触发——container 不直接命令式地"创建终端"，保持"状态驱动"；② `sessionId` 是**前端本地生成的标签身份**，与后端下发的 `socketSessionKey`（重连凭据）是两回事，混用会导致重连时把标签 id 当凭据发出去；③ addon 加载严格在 `open()` 之后（§7.2）；④ LRU 检查放在 `register` 之后，保证新实例不会把自己淘汰掉（§5.3）。

| 文件 | 层 | 职责 | 关联 |
|---|---|---|---|
| `views/terminal/TerminalPane.view.tsx` | view | 持 `<div ref>`，零副作用 | 07 §3 规则 1–2 |
| `containers/TerminalContainer.tsx` | container | dynamic 装配 + hooks↔view 粘合 | 07 §2 |
| `hooks/useTerminalSessions.ts` | hook | 标签集合的增删与激活（新增文件） | §5.1 |
| `hooks/useTerminalInstance.ts` | hook | 实例创建/挂载/addon/配置 | §7.1 |
| `hooks/useSandboxTerminalSocket.ts` | hook | WS 生命周期 | §3.1 |
| `services/ws/ptySocket.ts` | service | 唯一 WS 触点 | 07 §3 规则 5 |
| `stores/createTerminalRegistrySlice.ts` | store | 实例注册表 + LRU 记账 | 15 §3.2 |
| `lib/terminalTheme.ts` | lib | 配置常量 | §7.3 |

### 11.2 用户输入

```
（浏览器键盘事件，xterm 内部处理）
└─ ▲ terminal.onData(data: string)                     // 绑定于 §11.1 第 8 步
   └─ hooks/useTerminalInstance#handleData(sessionId, data)
      └─ stores/createTerminalRegistrySlice#entries.get(sessionId).socket
         └─ services/ws/ptySocket#send({ type:'input', payload: data })
            ├─ connState==='open' → ws.send(JSON.stringify(frame))
            └─ 否则 → **丢弃并返回 false**（不排队）
```

**为什么输入不排队**：断线期间攒下的键入在重连后一次性冲进 pty，会执行用户"以为没生效"的命令——终端语境下这是危险行为。正确表现是断线时黄条提示、键入无回显，与真实 SSH 断连体验一致。`send` 是 fire-and-forget，**不得在 onData 内做任何同步重活**（§6.2）。

| 文件 | 层 | 职责 |
|---|---|---|
| `hooks/useTerminalInstance.ts` | hook | onData 绑定与转发 |
| `services/ws/ptySocket.ts` | service | 帧编码 + 连接态判别 |

### 11.3 输出渲染（data 帧 → 屏幕）

```
（WebSocket message 事件）
└─ services/ws/ptySocket#handleMessage(raw)
   ├─ JSON.parse → types/ws-protocol#SandboxWsFrameSchema.safeParse()   // zod，16 §3
   │  └─ 失败 → dev: assertContract 横幅 / prod: 上报后 return（不阻断渲染）
   └─ ▲ onFrame(frame) → hooks/useSandboxTerminalSocket#handleFrame()
      ├─ frame.type==='data'
      │  └─ lib/writeBatcher#push(sessionId, decodeBase64(frame.payload))
      │     └─（rAF 到期）lib/writeBatcher#flush(sessionId)
      │        └─ registry.entries.get(sessionId).terminal.write(merged)   // §6.1
      ├─ frame.type==='exit'
      │  └─ hooks/useSandboxTerminalSocket#handleExit(code)
      │     └─ 展示 exit code + 人话解释（137=OOM），提供 [重开会话]（§8 第三类）
      └─ frame.type==='pong' → 重置心跳计时器（§3.1）
```

**步骤讲解**：① zod 校验在最外层，**未通过的帧不进入任何下游**；② 只有 `data` 走批处理，`exit`/`pong` 是控制帧需即时处理；③ `write()` 直接对 registry 里的实例调用，**不经 React state**——这是"每秒数百帧输出不触发一次重渲染"的关键。

| 文件 | 层 | 职责 |
|---|---|---|
| `services/ws/ptySocket.ts` | service | 帧解码 + zod 校验 |
| `types/ws-protocol.ts` | type | 帧 union 与 schema（10 §3 权威） |
| `lib/writeBatcher.ts` | lib | rAF 合并写入 |
| `hooks/useSandboxTerminalSocket.ts` | hook | 帧分派 + exit 处理 |

### 11.4 resize 全链路

```
（容器尺寸变化：窗口 resize / 侧栏折叠 / 任务树折叠 / 字号变更）
└─ hooks/useTerminalInstance#observeResize(container)
   └─ new ResizeObserver(entries => scheduleFit())
      └─ debounce 150ms → hooks/useTerminalInstance#doFit(sessionId)
         ├─ 可见性判定：container.clientWidth>0 ?  否 → return          // §4.1 纪律 1
         ├─ fitAddon.fit()                       → terminal.cols/rows
         ├─ 与 entry.lastReportedSize 比对：相同 → return                // §4.1 纪律 2
         └─ hooks/useTerminalInstance#reportResize(cols, rows)
            ├─ connState==='open' → ptySocket#send({type:'resize',cols,rows})
            └─ 否则 → entry.pendingSize = {cols,rows}                    // §4.1 纪律 3
                      （open 后由 useSandboxTerminalSocket#onOpen 补发）
```

| 文件 | 层 | 职责 |
|---|---|---|
| `hooks/useTerminalInstance.ts` | hook | ResizeObserver、debounce、fit、去重、暂存 |
| `services/ws/ptySocket.ts` | service | resize 帧发送 |

### 11.5 切换标签 / 切换 Task（命中已有实例）

```
views/terminal/TerminalTabBar.view#onSelect(sessionId)
└─ containers/TerminalContainer#handleSelectSession(sessionId)
   ├─ stores/createTerminalRegistrySlice#setActiveSession(sandboxId, sessionId)
   └─ hooks/useTerminalInstance#attach(sessionId, containerRef.current)
      ├─ registry.entries.get(sessionId) → 命中
      ├─ entry.container !== newContainer ?
      │   └─ 是 → newContainer.appendChild(entry.terminal.element)   // **移动 DOM，不重新 open()**
      ├─ 旧激活项 container.style.display = 'none'                    // 不 dispose
      ├─ 新激活项 container.style.display = ''
      ├─ hooks/useTerminalInstance#doFit(sessionId)                   // 从隐藏转可见必须补 fit
      └─ stores/createTerminalRegistrySlice#touch(sessionId)          // 仅此处 touch（§5.3）
```

**为什么不是 dispose+new**：那会丢 WebGL 上下文、清空 scrollback、并触发一次重连——用户看到闪烁与历史丢失。`open()` 全生命周期只调一次，跨容器改用 `appendChild` 移动（§7.4）。

| 文件 | 层 | 职责 |
|---|---|---|
| `views/terminal/TerminalTabBar.view.tsx` | view | 标签渲染与事件转发 |
| `containers/TerminalContainer.tsx` | container | 激活会话编排 |
| `hooks/useTerminalInstance.ts` | hook | DOM 移动、display 切换、补 fit |
| `stores/createTerminalRegistrySlice.ts` | store | activeSession 记账 + touch |

### 11.6 断线重连（同一会话，期待后端恢复现场）

```
（WebSocket close / error / 心跳超时）
└─ services/ws/ptySocket#handleClose(reason)
   └─ ▲ onState('reconnecting', attempt)
      └─ hooks/useSandboxTerminalSocket#handleDisconnect()
         ├─ registry#patchConnState(sessionId,'reconnecting')
         │  └─ views/terminal/ConnectionStatus.view 渲染黄条"正在重连…（第 n 次）"
         ├─ 终止判定：Task 主状态 ∈ {stopped, idle, failed} ?           // §3.1 / §8 要点 1
         │   └─ 是 → ptySocket#close() 并停止循环（转由 [重启] 驱动新会话）
         └─ 否 → services/ws/ptySocket#scheduleReconnect(attempt)
            ├─ delay = min(30s, 500ms×2^attempt) × jitter
            └─ 重连：new WebSocketCtor(`...&socketSessionKey=${entry.socketSessionKey}`)
               ├─ 成功 → ▲ onState('open')
               │   ├─ registry#patchConnState('open') → 黄条消失
               │   ├─ 补发 pendingSize 的 resize 帧（§11.4）
               │   └─ **前端不清屏、不请求 replay**——由后端 tmux re-attach 重绘（§8 第一类）
               └─ 达最大次数 → onState('closed') → "连接超时 [手动重连]"（P22 §2）
```

**最容易写错的两点**：① 重连必须带**上一次服务端下发的 `socketSessionKey`**，否则后端认不出是同一会话，会开一个新 pty（现场丢失）；② 重连成功后**不要主动 `terminal.clear()`**——后端重绘会自己覆盖，前端清屏反而制造"历史没了"的错觉。

| 文件 | 层 | 职责 |
|---|---|---|
| `services/ws/ptySocket.ts` | service | 退避调度、带 key 重连 |
| `hooks/useSandboxTerminalSocket.ts` | hook | 终止条件判定、连接态上报、pendingSize 补发 |
| `views/terminal/ConnectionStatus.view.tsx` | view | 黄条/超时态渲染 |
| `stores/createTerminalRegistrySlice.ts` | store | connState 记账 |

### 11.7 淘汰与销毁

```
触发源三选一：
  A. registry#enforceLru()（新实例注册后，§11.1 末步）
  B. views/terminal/TerminalTabBar.view#onClose(sessionId)（用户关标签）
  C. Task 被销毁/重启（WS sandbox.status_changed，§8 要点 2）
        │
        ▼
hooks/useTerminalInstance#destroy(sessionId)
├─ lib/writeBatcher#flushAndCancel(sessionId)      // 先 flush 残留 + 取消 rAF
├─ services/ws/ptySocket#close()                   // 先关连接
├─ entry.terminal.dispose()                        // 再销毁实例（顺序不可换）
└─ stores/createTerminalRegistrySlice#dispose(sessionId)
   └─ 同步清 entries / bySandbox / activeSessionOf 三处索引
```

- **顺序纪律**：flush → close → dispose。反过来（先 dispose）会让 in-flight 的 rAF 回调或 socket 帧写入已销毁实例，xterm 直接抛错。
- **LRU 候选集**排除当前激活会话（§5.3）。
- **场景 C 必须先 dispose 再新建**：同一 sandboxId 前后是两个会话，复用旧实例会把上一会话的残留画面误导为"恢复的现场"（§8 要点 2）。

| 文件 | 层 | 职责 |
|---|---|---|
| `hooks/useTerminalInstance.ts` | hook | 销毁编排与顺序 |
| `lib/writeBatcher.ts` | lib | flush + 取消 rAF |
| `services/ws/ptySocket.ts` | service | 关闭连接 |
| `stores/createTerminalRegistrySlice.ts` | store | 三处索引一致清理 |

### 11.8 渲染器降级（WebGL 上下文丢失）

```
▲ webglAddon.onContextLoss()
└─ hooks/useTerminalInstance#handleContextLoss(sessionId)
   ├─ webglAddon.dispose()                       // 释放该上下文
   ├─ await import('@xterm/addon-canvas')        // §2.3 独立 chunk
   ├─ terminal.loadAddon(new CanvasAddon())
   ├─ registry#patchRenderer(sessionId, 'canvas')
   └─ **不重建 Terminal、不清屏、不提示用户**——内容与滚动位置原样保留
```

降级是**静默**的：用户不需要知道渲染后端换了，页面上唯一可观察的变化是极短的一次重绘。`renderer` 字段留在 registry 供诊断页与长稳测试采样（§10 风险行）。

| 文件 | 层 | 职责 |
|---|---|---|
| `hooks/useTerminalInstance.ts` | hook | 上下文丢失监听与热切 |
| `stores/createTerminalRegistrySlice.ts` | store | renderer 记账 |

### 11.9 调用链路总览

| # | 链路 | 入口 | 终点 | 关键纪律 |
|---|---|---|---|---|
| 11.1 | 打开终端 | `TaskListItem#onClick` | `registry#register` | addon 在 `open()` 之后；sessionId ≠ socketSessionKey |
| 11.2 | 用户输入 | `terminal.onData` | `ptySocket#send` | 断线不排队；onData 内不做重活 |
| 11.3 | 输出渲染 | WS message | `terminal.write` | zod 先行；rAF 批处理；不经 React state |
| 11.4 | resize | `ResizeObserver` | `resize` 帧 | 隐藏不 fit / 同值不发 / 未连接暂存 |
| 11.5 | 切标签 | `TerminalTabBar#onSelect` | display 切换 | 移动 DOM 不重 `open()`；转可见补 fit |
| 11.6 | 断线重连 | WS close | tmux re-attach | 带回 `socketSessionKey`；不清屏；会话终结时停循环 |
| 11.7 | 淘汰销毁 | LRU / 关标签 / Task 销毁 | `registry#dispose` | flush → close → dispose |
| 11.8 | 渲染器降级 | `onContextLoss` | canvas addon | 静默、不重建、不清屏 |
