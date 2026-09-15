# 设计说明 —— 云 Agent 管理平台 · Vercel/Geist 风格原型

配套文件：`design/prototype.html`（可直接双击 / 拖进浏览器打开，无需构建）。

本说明覆盖：术语表、设计决策、可直接落地的 token 清单（含 WCAG 对比度实测）、shadcn/ui 接入方案、落地顺序。

**v2 变更**（本轮复核后的修订，覆盖 v1）：修了色板在暗色下看不见 / 三列卡片强制等高空出一大截 / 向导外壳比内容宽一倍 / 系统状态左列大片空白 四个布局问题；换用定稿术语表；把「发起新任务」弹层补进原型（对照真实 `NewSandboxPanel.view.tsx`）；终端多标签标注为待实现；向导壳体与任务弹层的组件选型改为**都用 shadcn `Dialog`**（不是各写一套）；8 种状态色逐一跑过 WCAG AA 对比度并调整了不达标的亮色数值；终端仪表壳改为**跟随主题**（暗色维持原样，亮色调浅）。

**v3 变更**（2026-09-15，覆盖 v2 中与此冲突的部分）：**补上缺的两页原型**（凭证管理 / 镜像管理 —— 此前原型只有向导 / 工作台 / 系统状态三页，那两页的实现是直接照产品文档做的，于是长成了另一套视觉语言）；**把「出网代理」卡补进系统状态页**（实现先做出来了，原型里一直没有，于是"它该放哪一列"无从对照）；**系统状态页两栏重排：诊断改成整行**（理由见 §1 问题 6）。

---

## 0. 术语表（定稿口径，原型与本文档已按此替换）

| 曾用 | 定稿 | 备注 |
|---|---|---|
| runtime | **Agent** | 面向用户的是「Agent」；`runtime` 作为内部字段名可以留在代码/契约里（真实代码 `NewSandboxPanel.view.tsx` 就是这么做的：`<legend>Agent（runtime）· 必选</legend>`） |
| provider / 运行档位 / 档 | **这台机器的沙箱环境** | 这个词本身已从界面退休——不要再造一个叫「Provider」或「档位」的控件或标题；系统状态页原「Provider 状态」卡改名**沙箱环境状态** |
| 订阅配置 | **模型帐号** | 向导 Step 4 标题、步骤条标签同步改 |
| DATA_ROOT | **数据目录** | 折叠/展开层可以保留一次「（DATA_ROOT）」做桥接，其余地方不再出现这个变量名 |
| 出网检测 / 出网可达性 | **联网检查** | 向导 Step 1、诊断第 ⑤ 项统一 |
| 资源池 | **本机资源** | 系统状态页「资源池水位」卡改名**本机资源水位** |
| 预算 / 未在预算内应答 | **超时时限 / 超时未响应** | 状态文案 `STATUS_TEXT.timeout` 由「超时未得出结论」改为「超时未响应」 |
| registry / 镜像仓库 | **镜像下载源** | |
| 血统 | **来源** | 镜像检查第 3 项标签 |
| staged / 铺开 | **下载到本机** | 镜像检查第 5 项标签与其完成态文案 |
| 后端健康（HTTP 200）| **正常时整行不渲染** | 这行字对用户没有可操作性；只有异常时才出现，见下文「问题 5」 |
| 检查链 | **镜像检查（共 5 项）** | 「第 N 步」相应改为「第 N 项」 |

⚠️ 诊断第 ⑤ 项的超时时限后端已从 5s 改成 10s，原型不再写死具体秒数为字面量之外的地方，统一取 10。

一个不改的地方：`容器运行时`（诊断第①项）、`运行时 rootfs 缓存`（Step 5 磁盘构成说明）里的「运行时」，指的是 Docker/微 VM 这一层**执行环境**的技术含义（container runtime），不是「Agent（runtime）」这个产品概念——两个「runtime」字面相同但所指不同，术语表只管后者，前者维持原文，硬替换成「Agent」反而是错的。

---

## 1. 设计决策

### 大方向

现状（`web/src/app/globals.css`）只有 7 个变量、只有一套暗色，`components/ui/button.tsx` 是唯一的手写组件，Tailwind 配置里颜色/字体 token 极少。这解释了"过于朴素"的根因：不是缺组件，是**缺一套能撑住"诊断项、连通性结果、审计事件"这类高密度结构化信息的视觉系统**。原型按 Vercel / Geist 的语言重建了这套系统：中性灰阶为主、强调色只有一处（焦点环/链接用的 accent 蓝）、语义色（success/warning/error/info/timeout）各自独立、边框 1px 代替阴影、圆角统一到 4 档。

### 问题 1：信息密度高 —— "一行文字 + 一段说明"平铺成日志

**解法：默认收起，只展开需要处理的。** 诊断卡的 8 项、连通性检测的 3 行、审计事件的 detail，全部用同一个 `.disclosure` 折叠行组件：头部只留"图标 + 状态 + 一句结论 + 耗时"，点开才看 `summary`/`hint`/命令。诊断卡额外做了一步——**status 为 `ok`/`info` 的项默认收起，`warn`/`fail`/`timeout` 默认展开**（`renderDiagnostics()` 里 `const open = ['warn','fail','timeout'].includes(d.status)`）。这样系统状态页打开的第一眼，用户看到的是"8 项里哪几项需要我看"，而不是 8 行等长的文字墙。卡片顶部再加一条聚合结论（"4 项正常 · 1 项提示 · 2 项警告 · 1 项超时未响应"），把"要不要点进去看"这个判断提前到打开页面的第一秒。

这个模式复用到三处：`DiagnosticsCard`（8 项诊断）、`ConnectivityCheck`（3 行联网检查，默认展开因为向导里数量少不需要折叠，但保留同一套视觉语言）、`AuditEventRow`（每条审计事件的 detail JSON）。

**这条纪律顺带解决了另一件事**：诊断项里「一句人话」与「可复制命令」现在是分开渲染的两个节点（人话一行 + 独立等宽框里的命令 + [复制] 按钮），不是拼成一句话。这与你们同期在做的契约拆分（`hint` → `nextStep` + `command`）是同一个形状，原型先在展示层把它做出来了，后端契约定下来后直接对得上。

### 问题 2：状态种类多（ok/info/warn/fail/timeout/pending/skipped/unknown）—— 现在只靠 emoji 区分，且对比度不达标

**解法：图标 + 文字 + 颜色三重线索，八种状态八套配色，逐色跑过 WCAG AA 对比度。**

- `ok`（正常）绿 / `info`（提示）蓝 / `warn`（警告）琥珀 / `fail`（不可达·失败）红 —— 最常见的四态，颜色两两可区分，且**不是只靠颜色**：图标形状（check / info-i / triangle / x）与文字标签同时给出，色觉障碍不是这套体系的主要风险点。
- `timeout`（超时未响应）**单独给了紫色**，不与 `fail` 共用红色。这是产品文档里反复订正的一条纪律（P21-5 §9E："超时 ≠ 不可达"）——如果 UI 上长得一样，用户会把"网络抖了一下"和"这东西是坏的"当成同一件事去修，修法完全不同（前者重试，后者要么配代理要么换镜像下载源）。原型里 Step 1 联网检查的"部分异常"场景把这两种状态并排放在一起，专门验证过视觉区分度。
- `pending`（检查中）用灰底 + 旋转的 loader 图标，不与任何语义色抢注意力——它还没有结论。
- `skipped`（走过、未达成）用**虚线边框的琥珀色空心 pill**，区别于 `warn` 的实心填充：`warn` 是"这一项本身有问题"，`skipped` 是"这一步被跳过了，不是它坏了"。向导步骤指示条上的三态（✅ 达成 / ⚠️ 走过没达成 / 无标记还没走到）直接用这一套。
- `unknown`（无样本/未知）用**虚线边框的灰色空心 pill**，与 `skipped` 同一视觉语法（虚线 = "不是一个确定的坏结果"）但颜色不同（灰 vs 琥珀），呼应沙箱环境卡片里"无样本 ≠ 0%"的产品纪律。

**真正没做够的是对比度，这轮补上了**：逐色计算了文字/图标在亮、暗两套底色上的 WCAG 对比度（正文 4.5:1、图形/大字 3:1），亮色模式下 `success/warning/error/info/timeout` 原先的 L 值（36%/44%/50%/40%/58%）在浅色 pill 底与纯白页面底上的文字对比度只有 2.6–4.4:1，**全部够不到 4.5:1**；暗色模式基本达标（4.7–7.4:1），只有 `unknown` 用到的 `foreground-subtle` 差一点（3.94:1）。语义分配没有改（`timeout` 仍是独立色相，`skipped`/`unknown` 仍是虚线），只下调了亮色几个色相的明度、把两套主题的 `foreground-subtle` 也各调了 5 个百分点。实测值见第 2 节 token 表后的对比度表。

### 问题 3：等待场景多（镜像下载十几分钟）—— 现在只是一行小灰字

**解法：把"进度"做成一个有仪表感的独立区块，而不是文本的附属品。** 向导 Step 3 第 5 项（下载到本机）的进度区块：
- **等宽字体的字节分数**（`已下载 260 MB / 约 320 MB`）+ **大号百分比**并排放在进度条上方，数字本身就是视觉焦点；
- 进度条下面**单独一行已用时长**（`已用时 1 分 39 秒`），与百分比是两个独立的、都在跳动的数字——两个数同时在动，比一个数字更能说服人"这不是卡死"；
- 再加一句**显式声明**："期间数字没变不代表卡死，正在持续写入磁盘"；
- 原型里这段是真的在用 `setInterval` 跑（每秒推进字节数与计时），打开页面就能看到它在动，达到 100% 后自动切换成完成态（"已下载到本机，可以立即发起任务"），演示了完成时的收敛动效。

这套处理同样适用于诊断卡"诊断中不阻塞其它区域"的场景——`[重新诊断]` 按钮在运行时显示"诊断中…"但不锁死整张卡，其余按钮照常可点。

### 问题 4：终端区纯黑底是硬要求，但与周边 UI 的过渡很生硬

**解法：给终端一个"仪表壳"（`.terminal-shell` + `.terminal-canvas`）包住恒黑画布，仪表壳跟随主题。**

v1 曾经把仪表壳做成固定深色、不随主题变化，理由是"终端是独立于主题的设备"——**这个设定被推翻了**：亮色模式下一块恒定的深色壳会显得比周围浅色 UI 重、像贴上去的，与"看起来是页面的一部分"这个目标冲突。v2 的做法：
- **画布本身恒黑不变**（`--terminal-bg: #000000`，硬要求，两套主题都不能碰）；
- **仪表壳（相框 + 工具栏背景）跟随主题**：暗色下维持原状（`--terminal-chrome: #111214`），亮色下改成浅灰（`--terminal-chrome: #e7e7ea`，边框 `#d3d3d7`）——同一件"相框"，亮色下用浅色纸，暗色下用深色纸，包着的画心（黑色终端）不变；
- 内层黑色画布保留 `inset shadow` 的进深感，顶部工具栏（复制/清屏/字号/新标签）仍放在仪表壳内部而不是外部；
- 两套主题都截图复核过：亮色下终端区域现在读作"页面里的一个组件"，不再是一块违和的深色补丁；暗色下与 v1 效果一致（本来就是照这次的深色要求定的）。

### 问题 5（本轮新增）：「后端健康（HTTP 200）」常驻占位，但用户拿它做不了任何决定

**解法：正常时整行不渲染。** 原型里 `#healthLabel` 默认是 `hidden` 的空 `<span>`，只有异常时才会被填字并显示（样式已经写好：`color:hsl(var(--error))`）。这是本轮术语表里唯一一条不是"换个说法"而是"整行拿掉"的规则——一句"一切正常"的常驻文字唯一的作用是占地方，异常时它反而会被淹没在一堆正常态的文字里。

### 问题 6（v3 新增）：系统状态两栏怎么分都平不了 —— 因为有一张卡的高度随状态跳变

实测（1440px 宽，原型 v2）：左列 499px、右列 1125px，**差 626px**。左列下方一大片空白，正是 v2 声称修过的「系统状态左列大片空白」。

⚠️ **根因不是"哪张卡放错了列"**，而是 `诊断` 这张卡的高度在两个状态之间跳：

| 诊断卡的状态 | 高度 |
|---|---|
| 尚未运行（进页面的默认态） | **98px** |
| 跑完八项、非 ok/info 默认展开 | **789px** |

把一张高度差 8 倍的卡固定指派给某一列，另一列必然**一会儿空一会儿挤** —— 按"跑完"的样子分，进页面时左边是空的；按"没跑"的样子分，跑完之后右边被顶出屏幕。这就是为什么这个问题反复出现又反复"修好"。

⇒ **v3 裁决：诊断移出两栏，与审计流一样占整行。**

- 两列于是只剩**高度稳定**的卡：左 [本机资源水位 303 + 连接状态 180] = 499，右 [沙箱环境状态 320 + 出网代理 363] = 698，**差 199**（实测）。
- 附带的好处：诊断项里那些可复制的命令（`lsof -i :3000 后 kill 对应进程` 一类）本来就最需要宽度，挤在半栏里要么换行要么截断。
- ⛔ **不要再把诊断塞回某一列去"配平"**。它下一次展开/收起就会把配平破坏掉，而看起来又像是"某人手滑改错了列"。

⚠️ 这一条同时修正一个**记录错误**：F21-5 文档曾被改成「左＝资源水位 + 诊断，右＝沙箱环境 + 连接状态」以匹配当时的实现。那个改动方向是反的 —— 文档原本描述的是**原型**（左＝资源 + 连接），偏离的是实现。v3 之后三者（原型 / 文档 / 实现）以本节为准。

### 终端多标签：标注为「目标态」而不是现状

~~`web/src` 里搜不到 `TerminalTabBar` / `useTerminalSessions`，产品文档要求的多标签在当前实现里是 0 个文件。~~ **（2026-09-11 已不成立：两者都已落地，见 06 §5 / 08 §5；下面那个「多标签 · 待实现」标记该撤掉了。）**原型的终端标签栏因此保留了 `Term-1` 单标签 + `[+ 新终端]`，但在旁边加了一个虚线灰的 `多标签 · 待实现` 标记（复用 `unknown` 状态的视觉），鼠标悬停会说明"TerminalTabBar / useTerminalSessions 在当前实现里是 0 个文件"。这样看原型的人不会把"画出来的目标态"误认成"已经能用的现状"。

### 新增：「发起新任务」弹层

之前两版原型都没有画这一块——工作台左下角 `[+ 新任务]` 按钮点了没反应。这轮按 P21-2（默认 modal，同时提供 `/new` 承接深链）与真实的 `web/src/views/sandbox/NewSandboxPanel.view.tsx` 补上，字段与真实组件一一对应：
- **Agent（runtime）· 必选**：单选，`codex — Codex（OpenAI）` / `claude-code — Claude Code（Anthropic）`，没有默认选中之外的花活（真实代码里平台没有"默认 Agent"概念）；
- 选中一个凭证已配置的 Agent → 显示"将以 a\*\*\*@gmail.com 身份运行"（`runtimeIdentityNotice`）；
- 选中一个凭证未配置的 Agent（原型里是 `claude-code`）→ 展开鉴权闸门面板，[发起任务并打开终端] 按钮**禁用**，底下配一句"先完成上面的 Claude Code 登录，才能发起任务"（对应真实代码 `authGateSlot` 在场时的处置）；
- **不再有"运行档位"单选**——这正是术语表里"provider 已退休"在这个面板上的落地：真实代码里这一块的注释写得很清楚："哪个跑得起来是宿主平台的事实，不是用户的偏好"；
- 分支（可选）：`跟随项目当前的分支（默认）` + 具体分支列表；
- 任务指令（可选）：`0/8000` 计数器，占位符文案照抄真实代码。

这个弹层是**常规可关闭弹层**：Esc、点遮罩、点右上角 `✕` 都能关——这是刻意与向导壳体做出的姿态区分，见下面「弹层组件选型」。

### 弹层组件选型：向导壳体与任务弹层都用 shadcn `Dialog`，靠 `preventDefault` 做区分，不是两套写法

v1 的判断是"向导不能用 Radix Dialog，因为默认的 Esc/遮罩关闭行为跟"不可取消"冲突"——这个判断**站不住**：Radix Dialog 官方支持在 `onEscapeKeyDown` 与 `onInteractOutside` 里 `event.preventDefault()` 来拦下关闭，这是文档里的标准用法，不是 hack。v2 改为：**向导壳体与任务弹层都用同一个 shadcn `Dialog`**，区别只在向导那份拦住了关闭事件：

```tsx
// InitWizardShell（向导）：拦住 Esc 与点遮罩，焦点陷阱/aria-modal/背景滚动锁定全部白拿
<Dialog.Root open modal>
  <Dialog.Portal>
    <Dialog.Overlay className="fixed inset-0 z-50 bg-background/80" />
    <Dialog.Content
      className="fixed inset-0 z-50 ..."
      onEscapeKeyDown={(e) => e.preventDefault()}
      onInteractOutside={(e) => e.preventDefault()}
      onPointerDownOutside={(e) => e.preventDefault()}
      // 没有 Dialog.Close，没有 [x]，onOpenChange 干脆不传
    >
      {/* 步骤条 + 内容插槽 + 底部导航，与现有 InitWizardShellView 的结构一致 */}
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

// NewSandboxPanel（任务弹层）：正常放行，Esc/点遮罩/[x] 都关
<Dialog.Root open={open} onOpenChange={onOpenChange}>
  <Dialog.Portal>
    <Dialog.Overlay className="fixed inset-0 z-50 bg-background/80" />
    <Dialog.Content className="...">
      <Dialog.Close aria-label="关闭"><XIcon /></Dialog.Close>
      <NewSandboxPanelView {...props} onCancel={() => onOpenChange(false)} />
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
```

好处不是"少写一个 div"，是把焦点陷阱、`aria-modal`、背景滚动锁定、关闭后焦点归位这几件手写容易漏的事交给 Radix，全站只维护一套弹层实现，向导与任务弹层的差异明确记在"要不要拦下关闭事件"这一行代码上，而不是两份完全独立、日后容易各自漂移的实现。原型本身是静态 HTML，没有真的引 Radix，但任务弹层的交互（Esc/遮罩/✕ 都关）已经按这个目标态实现；向导壳体在原型里维持内联展示（它不是一个真正盖住全页的浮层，见下方落地顺序 Phase 2 的说明），只在这里写清楚落地时的代码形状。

---

## 2. 设计 Token 清单（可直接搬进 `globals.css`）

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

/* 亮色为默认 :root，暗色覆盖在 [data-theme="dark"]（或按项目约定改回 class 策略） */
:root {
  --background: 0 0% 100%;
  --background-elevated: 0 0% 98%;
  --background-subtle: 0 0% 95%;
  --foreground: 0 0% 4%;
  --foreground-muted: 0 0% 32%;
  --foreground-subtle: 0 0% 40%;    /* v2：45%→40%，见下方对比度表 */
  --border: 0 0% 90%;
  --border-strong: 0 0% 83%;

  --primary: 0 0% 4%;
  --primary-foreground: 0 0% 100%;
  --accent: 212 100% 48%;     /* 焦点环 / 链接，唯一的中性强调色 */

  /* v2：L 值全部下调，逐色跑过 WCAG AA（见下方对比度表），语义分配不变 */
  --success: 142 76% 26%;
  --warning: 32 95% 30%;
  --error: 0 74% 44%;
  --info: 201 96% 32%;
  --timeout: 263 83% 56%;     /* 与 error 独立的色相：超时 ≠ 失败 */

  --radius-sm: 4px;   /* 徽标 / pill */
  --radius-md: 6px;   /* 按钮 / 输入框 */
  --radius-lg: 10px;  /* 卡片 */
  --radius-xl: 16px;  /* 大容器 / 向导壳 */

  --terminal-bg: #000000;             /* 画布恒黑，两套主题都不能碰 */
  --terminal-chrome: #e7e7ea;         /* v2：仪表壳跟随主题，这是亮色的值 */
  --terminal-chrome-border: #d3d3d7;
  --terminal-fg: #e4e4e7;
  --terminal-fg-dim: #8a8a90;

  --shadow-pop: 0 8px 24px rgba(0, 0, 0, 0.10);
}

[data-theme="dark"] {
  --background: 0 0% 4%;
  --background-elevated: 0 0% 7%;
  --background-subtle: 0 0% 11%;
  --foreground: 0 0% 93%;
  --foreground-muted: 0 0% 63%;
  --foreground-subtle: 0 0% 50%;    /* v2：45%→50% */
  --border: 0 0% 16%;
  --border-strong: 0 0% 24%;

  --primary: 0 0% 93%;
  --primary-foreground: 0 0% 4%;
  --accent: 217 91% 63%;

  --success: 142 71% 45%;
  --warning: 38 92% 55%;
  --error: 0 84% 63%;
  --info: 199 89% 62%;
  --timeout: 258 90% 71%;

  --shadow-pop: 0 8px 30px rgba(0, 0, 0, 0.45);

  /* 暗色下仪表壳维持原状——这套深色就是照这次的要求定的 */
  --terminal-chrome: #111214;
  --terminal-chrome-border: #2a2b2e;
  --terminal-fg-dim: #6b6b70;
}

html, body { height: 100%; }
body {
  background: hsl(var(--background));
  color: hsl(var(--foreground));
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}
```

> 现有项目用 `darkMode: 'class'`（`tailwind.config.ts`）。如果保留这个策略，把上面的 `[data-theme="dark"]` 选择器换成 `.dark`，JS 侧切换 `document.documentElement.classList.toggle('dark')` 即可，其余变量不用改。原型里用 `data-theme` 属性只是为了在同一份静态文件里更直观地演示，不代表要求项目改用属性策略。

`tailwind.config.ts` 需要补的部分（在现有基础上新增，不用推翻）：

```ts
theme: {
  extend: {
    colors: {
      // 现有的 border/background/foreground/muted/muted-foreground/primary/primary-foreground/terminal 保留
      'background-elevated': 'hsl(var(--background-elevated))',
      'background-subtle': 'hsl(var(--background-subtle))',
      'foreground-subtle': 'hsl(var(--foreground-subtle))',
      'border-strong': 'hsl(var(--border-strong))',
      accent: 'hsl(var(--accent))',
      success: 'hsl(var(--success))',
      warning: 'hsl(var(--warning))',
      error: 'hsl(var(--error))',
      info: 'hsl(var(--info))',
      timeout: 'hsl(var(--timeout))',
    },
    borderRadius: {
      sm: 'var(--radius-sm)',
      md: 'var(--radius-md)',
      lg: 'var(--radius-lg)',
      xl: 'var(--radius-xl)',
    },
  },
},
```

### 状态 → 颜色 对照表（八态，实现时直接抄）

| status | 语义 | 颜色变量 | 图标（lucide） | 视觉手法 |
|---|---|---|---|---|
| `ok` | 正常/通过 | `--success` | `check` | 实心浅底 + 边框 |
| `info` | 提示，不需要修 | `--info` | `info` | 实心浅底 + 边框 |
| `warn` | 警告，建议处理 | `--warning` | `alert-triangle` | 实心浅底 + 边框 |
| `fail` | 确定坏了/不可达 | `--error` | `x` / `x-circle` | 实心浅底 + 边框 |
| `timeout` | 超时未响应（≠ fail）| `--timeout` | `clock` | 实心浅底 + 边框，独立色相 |
| `pending` | 检查中/进行中 | `--foreground-muted` | `loader`（旋转动画）| 灰底，无边框强调 |
| `skipped` | 走过、未达成（向导步骤）| `--warning` | `minus` | **透明底 + 虚线边框**，与 warn 的实心区分 |
| `unknown` | 无样本/未知（≠ 0，≠ 失败）| `--foreground-subtle` | `circle` | **透明底 + 虚线边框**，灰色 |

### WCAG AA 对比度实测（文字/图标色 vs 该状态实际所在的底色）

方法：pill 背景是语义色以低透明度（12%–14%，与 CSS 里的 `hsl(var(--x) / .12)` 一致）叠在卡片背景（`background-elevated`）上合成的颜色；「对页面底」额外核对了纯页面背景（不在卡片里时，比如色板本身）。达标线：正文 4.5:1，图形/大字 3:1（WCAG 2.1 AA）。数值用 sRGB 相对亮度公式实算，非目测估计。

| status | 对比度 · pill 底（亮色）| 对比度 · 页面底（亮色）| 对比度 · pill 底（暗色）| 达标 |
|---|---|---|---|---|
| `ok` | 4.71:1 | 5.83:1 | 6.83:1 | ✅ 两套主题均达标 |
| `warn` | 4.74:1 | 6.05:1 | 7.37:1 | ✅ |
| `fail` | 4.68:1 | 5.96:1 | 4.74:1 | ✅ |
| `info` | 4.78:1 | 5.94:1 | 7.29:1 | ✅ |
| `timeout` | 4.74:1 | 6.04:1 | 4.72:1 | ✅（暗色原值就已达标，亮色 L 值由 58%→56% 微调） |
| `pending`（`foreground-muted` 文字）| 7.53:1 | — | 7.23:1 | ✅ 本来就富余 |
| `skipped`（`warning` 文字，透明底）| 5.79:1 | — | 9.44:1 | ✅ |
| `unknown`（`foreground-subtle` 文字，透明底）| 5.50:1 | 5.74:1 | 4.72:1（暗色由 45%→50% 调整）| ✅ |

调整前（亮色，未下调 L 值）的对照，供存档：`ok` 2.81:1 / `warn` 2.61:1 / `fail` 3.84:1 / `info` 3.39:1 / `timeout` 4.43:1 —— 全部够不到 4.5:1，其中 `ok`/`warn` 连 3:1（大字/图形线）都不够。

顺带过了一遍非文字对比度（WCAG 1.4.11，UI 边界 3:1）：`unknown` 的虚线边框原来用的是 `--border-strong`（亮色下只有约 1.3:1，太浅），改成 `hsl(var(--foreground-subtle) / .65)`——这个 token 本身已经达标，加了透明度之后仍然清晰可辨；`skipped` 的虚线边框用的是 `warning` 本色，同样达标，不用改。

---

## 3. shadcn/ui 接入方案

### `components.json`

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "new-york",
  "rsc": true,
  "tsx": true,
  "tailwind": {
    "config": "tailwind.config.ts",
    "css": "src/app/globals.css",
    "baseColor": "neutral",
    "cssVariables": true,
    "prefix": ""
  },
  "aliases": {
    "components": "@/components",
    "utils": "@/lib/_shared/utils",
    "ui": "@/components/ui",
    "lib": "@/lib",
    "hooks": "@/hooks"
  }
}
```

- `baseColor: "neutral"`：Geist 用的是纯灰度（不偏冷不偏暖），shadcn 的 `slate`/`zinc` 都带一点点色偏，`neutral` 最贴近现在定的 token。
- `utils` 指到项目已有的 `@/lib/_shared/utils`（`cn()` 已经在用，不需要新建）。

### 需要 `npx shadcn add` 的组件（按三块页面 + 任务弹层的实际需要选，不是全装）

| 组件 | 用在哪 | 为什么要它 |
|---|---|---|
| `dialog` | **向导壳体 + 任务弹层，两处共用**（v2 变更，见上节） | 焦点陷阱/`aria-modal`/背景滚动锁定/关闭后焦点归位；向导那份用 `preventDefault` 拦关闭 |
| `badge` | 状态 pill 的底层实现 | 在它的 cva 基础上扩展出 `ok/info/warn/fail/timeout/pending/skipped/unknown` 八个 variant |
| `card` | 系统状态页四张卡、审计流卡 | 现有代码里卡片是手写 `<section className="rounded-lg border ...">`，收敛成 `Card` 减少重复 class |
| `progress` | 镜像下载进度、本机资源水位条 | Radix Progress 自带 `aria-valuenow` 语义，比手写 `role="progressbar"` div 更省心 |
| `accordion` | 诊断卡 8 项、连通性 3 行、审计 detail | 折叠行的语义组件，诊断卡应该是 `type="multiple"`——多项可以同时展开 |
| `radio-group` | 任务弹层的 Agent 单选 | 现在是原生 `<input type="radio">`，语义没问题，但项目里如果统一用 Radix 组件会更一致 |
| `select` | 任务弹层的分支下拉；审计流"类别"下拉 | 两处都可以继续用原生 `<select>`（无障碍、不需要 JS），不是必须换，看项目一致性要求 |
| `input` / `label` / `textarea` | 代理配置表单、任务弹层的指令输入框 | 现在是纯手写 `<input>`/`<textarea>`，接上统一的 focus ring token |
| `switch` | 审计流"仅告警"开关 | 现在是原生 checkbox，语义上是开关不是勾选框 |
| `tooltip` | 图标按钮（复制/刷新/设置）、"多标签 · 待实现" 标记的说明 | 图标/标记本身信息量不够时兜底 |
| `skeleton` | 审计流加载态、本机资源首次加载 | 现有代码已经手写了骨架屏（`animate-pulse`），换成组件统一动画曲线 |
| `separator` | 卡片内的分区线（如沙箱环境卡的 Agent 分组） | 比手写 `border-t` 更语义化，优先级低，可以最后再换 |
| `sonner`（toast）| 复制成功、发起任务成功等瞬时反馈 | 项目里已经在用 `sonner`（见 `WorkbenchShell` 注释），补上 shadcn 的样式包装即可 |

**明确不引入的组件**：

- ❌ **`tabs`**：系统状态页是设置页的左侧菜单子页签，不是页面内 tab 切换；向导的步骤条也不是可自由跳转的 tab（有顺序依赖），两处都不适合用 `Tabs` 组件。
- ❌ **`dropdown-menu`**：`CurrentProjectIndicator` 明确是"只读指示器，点击只做树内定位，不是下拉"（`onLocateCurrentProject`），项目组头的「⋯」菜单虽然是下拉，但这是下一阶段的工作，本轮原型没有展开这部分。

### 引入的 Radix 包（新增依赖，现在是 0 个）

```
@radix-ui/react-dialog
@radix-ui/react-accordion
@radix-ui/react-progress
@radix-ui/react-tooltip
@radix-ui/react-switch
@radix-ui/react-label
@radix-ui/react-radio-group   /* 如果任务弹层的 Agent 单选也走 Radix */
```

`badge`/`card`/`input`/`separator` 是纯样式组件，不引入 Radix 包。`sonner` 不是 Radix 系（独立包 `sonner`），项目里似乎已经决定用它（见现有注释），补齐样式包装即可，不算新依赖。`select` 若维持原生 `<select>` 则不引入 `@radix-ui/react-select`。

### 与现有手写 `button.tsx` 的衔接

`components/ui/button.tsx` **不需要重写**，它已经是标准的 shadcn 结构（`cva` + `forwardRef` + `VariantProps`）。原型里实际用到的按钮只有 `primary`（对应现有 `default`）、`outline`、`ghost` 三种，**不需要新增 variant**，配色跟着新 token 走会自动更新（它引用的是 `bg-primary`/`border-border` 这些 Tailwind 语义类）。

---

## 4. 落地顺序

### Phase 0 · 一次性基建（先做，做一次）
1. 替换 `globals.css`：补齐本文档的完整 token（亮 + 暗两套，含 v2 的对比度修正值），`tailwind.config.ts` 加对应的 `extend.colors`/`borderRadius`。
2. `npx shadcn init` 生成 `components.json`，`npx shadcn add dialog badge card progress accordion radio-group input label switch tooltip skeleton separator sonner`。
3. 基于 `badge` 的 cva 扩展出 `StatusPill` 组件（八个 variant，对照表见上），放在 `components/ui/status-pill.tsx`。
4. 图标从内联 SVG 换成 `lucide-react`（已是依赖）。
5. 终端仪表壳（`.terminal-shell`/`.terminal-canvas`）做成 `TerminalFrame` 组件，两个 CSS 变量（`--terminal-chrome`/`--terminal-chrome-border`）随主题切换，替换 `TerminalPaneView` 外层的 `bg-terminal` 简单 div。
6. 基于 `dialog` 封装两个组件：`BlockingDialog`（向导用，内置 `preventDefault` 三连）与普通的 `Dialog` 直接用（任务弹层、以后的其它弹层）。

### Phase 1 · 系统状态页（优先，风险最低）
- `DiagnosticsCard` + `DiagnosticItem` 改用 `Accordion`（`type="multiple"`）+ `StatusPill`，接入"非 ok/info 默认展开"的规则；诊断第 ⑤ 项超时时限文案改为读配置（当前 10s），不再写死。
- `ResourcePoolCard` 改名 `本机资源水位`，三条水位改用 `Progress` 组件。
- `ProviderStatusCard` 改名**沙箱环境状态**（对应组件/文件名要不要跟着改，看团队是否接受"文件名与显示名不一致"——本文档建议至少把可见文案改掉，组件改名可以放到下一轮重构再做），`ConnectionStatusCard` 换 `StatusPill`。
- `AuditStreamCard`：加载态换 `Skeleton`，detail 展开可以换 `Accordion` 或保留现有行内展开。
- 这一页零阻塞流程、改错了也只影响只读展示，适合第一批验证新 token 与新组件。

### Phase 2 · 初始化向导（其次，要小心处理阻塞语义）
- `ConnectivityItem`/`PresetImageCheck`/`ResourceConfirm` 接入 `StatusPill`；步骤/字段术语按第 0 节术语表全部替换（联网检查、模型帐号、镜像下载源、来源、下载到本机、镜像检查共 5 项）。
- `InitWizardShell` 换成 `BlockingDialog`（Phase 0 封装好的、内置 `preventDefault` 的 Dialog），不是继续手写 `<div role="dialog">`，也不是随便拿一个普通 `Dialog` 就用。
- Step 3 第 5 项加真实的 `Progress` + 计时器组件（原型里的 `setInterval` 逻辑迁移到 `useEffect`，数据源换成真实的 provision 事件流）。

### Phase 3 · 工作台
- 终端仪表壳落地（`TerminalFrame`，跟随主题），建议单独拉一个 PR 配真机截图对比（亮暗各一份）。
- 左侧任务树的状态点、组头徽标（克隆失败等）接入 `StatusPill` 的极简变体（纯 dot，已在原型的 `.dot` 类里给出）。
- 全局横幅优先级（阻断 > 治理 > 提示）按原型的三色分层实现。
- 顶部健康提示改成"正常时不渲染"（见问题 5），异常时才挂载 `#healthLabel` 等价的组件。
- **新建「发起新任务」`NewSandboxContainer` + `Dialog`**：内容照抄真实的 `NewSandboxPanel.view.tsx`（本来就是齐的，不用重新设计字段），弹层外壳换成 Phase 0 封装的普通 `Dialog`；工作台 `[+ 新任务]` 与 `/new` 深链都打开同一个弹层。
- 终端标签栏右上角按钮从 `[+ 新建]` 改名 `[+ 新终端]`（已按此落地）；~~多标签（`TerminalTabBar`/`useTerminalSessions`）是独立的后续需求，不在这轮里实现~~ **（2026-09-11 已落地：第 1 个标签是 Agent 会话、无 [×]，第 N 个是独立 `platform-shell-<id>` tmux 会话。原型里那个「多标签 · 待实现」标记应撤。）**

### Phase 4 · 照原型收口（**原计划是「打磨」，2026-09-12 改了**）

⚠️ **为什么改**：Phase 0–3 做完后截图与原型比对，发现差距明显 —— 根因是上面每个 Phase
的「五条/六条」都只列了**卡片内部的组件替换**，凡是没被点名的东西（卡片标题 emoji、
资源卡状态标记、审计行标记、任务树的搜索/筛选/状态点、终端工具栏）就没人动。
结果是「换了几个组件」而不是「照原型实现」。

⇒ Phase 4 的验收标准从「清单里那几条做完了没」换成**截图与原型比对**。打磨项顺延到 Phase 5 ——
先让东西长得对，再打磨一个长得对的东西。

**已完成：**
- 系统状态页：五张卡标题去 emoji · 资源三档/沙箱环境/审计行全部换 `StatusPill`
  （`critical` → `fail`）· 进度条 6px + 灰底槽 + 语义 token · 诊断 ①–⑧ 序号圆标 + 汇总行 ·
  「仅告警」换 `Switch` · 磁盘行换行 bug（根因是把真实长路径拼进 `label`）
- 设置页壳体**内容区宽度分两档**：`wide`（看板）/ `form`（表单）。⚠️ `max-w-3xl` 会把两栏
  栅格压到每列 ~340px，pill 文字被截断；而表单页又不能拉满宽。⛔ 两者要的东西相反，别统一
- 工作台：任务树搜索（真过滤）· 筛选 chips · 项目行折叠箭头与右对齐计数 · **终端工具栏**
  （面包屑 + 复制/清屏/A-/A+，四个都接真实 xterm 操作）· 顶栏收成一个 `DropdownMenu`
- 筛选 chips 补到**七档**：`SandboxStatus` 六个值与六个具体档一一对应，`all` 之外不再有
  无家可归的状态。chips 横向滚动不换行
- 搜索 200ms 防抖（用例用假定时器证明 199ms 未生效、满 200ms 才生效，另有一条证明
  「防抖不是节流」）
- **tmux 自带状态栏关掉**（api 侧 `STATUS_OFF`）：一个标签 = 一个独立 session ⇒ 窗口列表
  恒为一项；它还在泄漏 `platform-shell-<32 位十六进制>` 这类内部标识符；而它想说的话已经
  由标签栏与面包屑用产品自己的 UI 语言说了
- **全仓 emoji → lucide**：`components.json` 早就配了 `"iconLibrary": "lucide"`（shadcn 的
  内置图标库），但全仓扫出 37 个文件、约 85 处渲染文本仍在用 emoji。
  ⚠️ 架构口径：**`lib/` 返回语义状态，view 负责渲染成图标**，⛔ `lib/` 不许返回图标组件
  （`StatusPill` 就是这个先例：收 `status`，组件内部查表决定图标与颜色）

### Phase 5 · 打磨（顺延）
- 动效审查：`transition`/`animation` 加 `prefers-reduced-motion` 兜底
- 可访问性复核：`focus-visible` 环、`aria-live`（诊断结果更新、连接状态变化处）；
  对比度已逐色算过，落地后用真实渲染跑一遍 axe 复验
- 亮色模式全页走查。⚠️ 目前 `<html className="dark">` 写死、**没有主题切换入口**，
  亮色 token 已备好但产品里触达不到 —— 要不要给切换入口是 Phase 5 的开放问题


---

### Phase 6 · 凭证 / 镜像两页照新原型收口（v3 新增，**2026-09-15 已落地**）

⚠️ **为什么这两页会长成另一套视觉语言**：原型 v1/v2 只画了向导 / 工作台 / 系统状态三页，凭证与镜像的实现是**直接照产品文档做的** —— 产品文档管的是"要有哪些信息、点了会怎样"，不管"状态用什么控件表达"。于是 Phase 4 那轮「全面换 StatusPill」只覆盖了有原型的那页，另外两页原地不动，至今一个 `StatusPill` 都没有。

实测（2026-09-15）：`StatusPill` 在系统状态页 **6 处**，凭证页 **0**，镜像页 **0**。同一个产品里，「未配置」在一页是 pill、在另一页是纯文字。

**照 v3 原型要做的三件事**：

| # | 做什么 | ⛔ 不要做成什么 |
|---|---|---|
| ① | 凭证 / 镜像两页的状态一律换 `StatusPill` | ⛔ 不要新造第三套写法（现在镜像页的「● 已启用」是小圆点 + 文字，既不是 pill 也不是 `StatusDot` 的既有用法） |
| ② | 「未配置」用 **`skipped`**（虚线框），不是 `fail` | ⛔ 它不是错误，是"这一路没走"。用红色会让一个只配了 API Key 的用户以为自己弄坏了什么 |
| ③ | 凭证卡内部用**分隔线**分「帐号登录 / API Key」两法 | ⛔ 现实现是 `card > bordered-row` 两层边框，"哪个是一张卡"变得含糊 |

**镜像页的宽度档要从 `form` 改成 `wide`**：它是**列表看板不是表单页**（注册表单在弹层里，页面上一个内联表单行都没有）。现在按"表单页"给了 `max-w-3xl`，实测左右各空约 250px，而卡里的 sha256 摘要与运行参数反倒挤成三行。改满宽之后「适用 / 运行的版本 / 来源」三个 kv 一行放得下。
⚠️ 档位本身的定义（`SettingsLayout.view.tsx` 的 `wide` / `form`）不动，改的是**镜像页归哪一档**。

**原型里刻意放了非绿的样本**：镜像页三张卡分别是「有效」「有警告」「已禁用」。⛔ 三张都画成绿的等于没说"警告长什么样""禁用与无效怎么区分" —— 而这两件事恰恰是实现最容易糊弄过去的。

#### 落地记录（2026-09-15）

三件事都做了，`StatusPill` 从两页各 0 处变成凭证页 7 / 镜像页 5。宽度档按页改成穷举映射。
另有**两处交付时补的**，都不是清单里原本写着的：

**① 宽度档：⛔ 不许写成 `activeKey === 'x' ? a : b`**

三元有一个**静默的默认**，新增子页会不声不响地继承它 —— 而这两档差着 `max-w-3xl`(720px) 与满宽，
继承错了就是一页白白空掉一半、或一页表单拉到满屏。改成按 key 穷举的 `Record`：少写一个 key
tsc 当场就红，逼着加页的人做一次选择。
⚠️ 还有一层：`SettingsLayoutView` 自己的 prop 默认是 `'form'`，三元若默认 `'wide'` 就与组件默认打架。

**② 换 pill 之后，结论词要从句子里搬进 pill，⛔ 不能两边都念**

产品文档 P21-4 §5 的句式是「✅ 验证通过：镜像可用」—— 结论当时由 emoji **旁边的文字**承担。
而 `StatusPill` 自己就带文字（八态体系要求"图标 + 文字 + 颜色三重线索"，见 §1 问题 2），
句子若原样保留，屏幕上会变成：

```
⛔  [✓ 验证通过]  验证通过：镜像可用
✅  [✓ 验证通过]  镜像可用
```

**信息一个字没少**，只是结论从句子搬进了 pill。⚠️ 这是**截图才看出来的** —— 当时没有任何
断言锁这三句文案，改完还会退回去。已补一条「结论词全区块只出现一次」的 story 断言。

⚠️ ⚠️ 档的细节句写成「镜像**仍**可用」而不是「镜像可用」：⚠️ 的产品语义是**验证通过了**、
只是有注意事项（`lib/image/imageManifestCards.ts` 注释专门强调过）。pill 只说「有警告」，
不说还能不能用 —— 而那正是用户看到黄色时第一个要问的。

**仍未做（交付时明确留白，不是漏掉）**：

| 项 | 为什么没做 |
|---|---|
| `TestConnectionResult.view` 换 pill | 它被 `HttpsTokenForm` / `SshKeyForm` 共用，改它会牵动清单外的两个表单 |
| `GitCredentialCard` 已配置态加「已配置」pill | 现实现那一支**本来就没有任何状态标签**（不是纯文字，是彻底没有）。加一个此前不存在的可见标签属于**往页面加新信息**，超出「只换状态的表达方式」的授权 |
| 卡片分隔线通栏（贴卡片边缘） | 现在是内容区内的 `divide-y`，比原型稍窄。核心诉求「去掉卡中卡的双层边框」已满足 |

## 5. 仍然需要拍板的点

⚠️ **本节 v2 时列的三条已全部落定**（2026-09-12 复核），保留结论以免有人照着旧文再问一遍：

1. ~~`ProviderStatusCard` 要不要连代码命名一起改~~ → **已改**。前端内部符号改成 `sandboxEnv`
   （视图模型/组件名/testid/story title），⛔ **契约侧一个字没动**：`SandboxProvider` 插件契约、
   `/api/providers` 端点、`ProviderHealthDto`/`SystemProvidersDto`、`PROVIDER_UNAVAILABLE` 全部保留。
   缘由写进了 21-5 —— 前端叫 `sandboxEnv`、契约叫 `provider` **不是漂移，是两个概念**，
   ⛔ 看到两边不一致就「顺手统一」之前先分清改的是哪一侧。
2. ~~终端多标签的排期~~ → **已做完**，且比原型画的更远：多标签 + 刷新后恢复会话 +
   新标签可选启动什么（Codex / Claude Code / 纯终端）。
   ⚠️ 原型里那个「多标签 · 待实现」标记**已经过期**，别再照着它实现一遍。
3. ~~审计流 detail 的 JSON 保留原始字段名~~ → **维持原样**。裁决是契约本身不改名，
   所以这块 JSON 继续如实反映后端字段，不存在「要跟着动」的后续。

### 当前真正开放的

1. **主题切换入口**：亮色 token 已备好，但 `<html className="dark">` 写死、产品里没有切换路径。
   要不要给入口（Phase 5）。
2. **提示类（ℹ️）横幅没有生产方**：`BannerSeverity` 目前只有阻断/治理两档。⛔ 没有真实判定会
   产出提示级横幅之前不加第三档 —— 那会是个只在类型里存在的死值。
3. **`ModalShellView` 是否退场**：任务弹层已换 shadcn `Dialog`，但新建项目/项目菜单/已保留卷/
   自动化规则四个弹层仍用 `ModalShellView`，两套并存。建议单独排一轮收敛，⛔ 别塞进打磨里。
4. **后端文案里的 emoji**：前端已清，但 `src/mocks/**` 模拟的后端返回里仍有 —— 那是 api 侧的
   问题，要不要一并清需要单独定。
