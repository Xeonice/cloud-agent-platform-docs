---
id: PRD-AUTH
title: Agent 登录面板 · 产品需求
type: prd
status: draft
owner: 产品 owner（仓库唯一人类 owner）
domains: [AUTH]
flows: [F-AUTH-PANEL]
applies_to: ">= v0.2.4"
last_verified:
  docs: fd2e1ee
  api: a453bb7
  web: 93f03c5
  date: 2026-10-04
covers:
  - web/src/containers/credential/{AuthGateContainer,CredentialsContainer}.tsx
  - web/src/views/wizard/auth/{AuthGatePanel,DeviceCodeAuth,SetupTokenAuth,ApiKeyAuth}.view.tsx
  - web/src/hooks/credential/{useRuntimeAuthFlow,useRuntimeAuthPanel,useRuntimeAuthMutations,useRuntimeAuthSync,useOpenAuthPage,useCredentials}.ts
  - web/src/lib/credential/{authFlow,runtimeCredential}.ts
  - web/src/containers/sandbox/SandboxTerminalContainer.tsx（新建任务里的凭证闸门）
  - web/src/containers/init/{AppBootGate,InitWizardContainer}.tsx（口令门与初始化判定、向导第 4 步宿主）
  - api/packages/modules/runtime/src/application/runtime-application.service.ts、api/packages/modules/runtime/src/interface/http/runtime.controller.ts
  - api/packages/modules/runtime/src/infrastructure/adapters/{codex,claude-code}/*.adapter.ts、api/packages/modules/runtime/src/domain/services/token-format.validator.ts
  - api/packages/modules/credential/src/application/runtime-credential.service.ts
  - api/packages/modules/sandbox/src/application/event-handlers/credential-revoked.handler.ts
supersedes:
  - docs/product/20-核心使用链路.md §5.1–§5.4（L178-315）
  - docs/product/pages/21-2-发起任务向导.md 形态 B（L69-83）、状态表 L184-189
  - docs/product/pages/21-3-凭证管理.md §3 示意、§5 状态与状态图、§6 L114-118、§9 L133-136（Agent 凭证部分；Git 与删除凭证归 crd-b）
  - docs/product/pages/21-8-部署与初始化.md §2.1（L80-136）、§3（L342-358）
  - docs/product/22-异常场景与产品补充要求.md L15、L18-19、鉴权阶段 L117-129
drafts:
  - gap/drafts/f-auth-panel-01…09.html、f-crd-mode-01.html、f-acc-unlock-01…03.html（说明 gap/drafts/notes/crd-a.md）
merged_from:
  - gap/product/_parts/crd-a.md
merged_at: 2026-10-04
review_minutes: 30
---

# Agent 登录面板 · 产品需求

<!-- 本文件只写「做什么 / 为什么 / 怎样算做对」。布局与视觉在稿件（gap/drafts/f-*），实现方法在技术设计。由 gap/product/_build/merge.py 从 _parts 合并生成；改片段后重新运行。「现状」列暂留文件:行出处，入库时按 01 §4.2 换成证据 ID。 -->

## 一屏摘要

- **这一域回答什么**：Agent 登录面板——新建任务的凭证闸门、凭证页卡片、初始化向导三处共用的同一套面板，从空闲到「已连上」的每一态（Codex 设备码、Claude Code 授权码、API Key、重新登录、会话回收、错误），REQ-AUTH-001–011。
- **五条要守的规则**：
  1. 登录只在用户点 [开始帐号登录] 之后才开始；面板出现、切标签、选 Agent 都**不得**起登录进程（REQ-AUTH-003，FE1）。
  2. 一套面板三处共用，在当前容器里就地展开，不叠弹层、不跳页（REQ-AUTH-001）。
  3. 成功先在原位说「已连上」并停留到看得见，轻提示只作补充（REQ-AUTH-008）。
  4. 凭证明文只在本地输入框里、提交即清空；错误按码给人话，**不得**上屏后端原句（REQ-AUTH-006、007、011）。
  5. 重新登录在同一面板里无缝替换，**不**连带销毁在跑的任务（REQ-AUTH-009）。
- **现状**：11 条需求里 `已实现` 2 · `部分实现` 2 · `未实现` 1 · `偏离` 6。面板一挂上就开始登录（偏离 FE1）；成功提示一闪即逝、闸门闪回（DR-21）；被拒句直接显示后端原句（DR-33）；授权码被拒一次后会话即被销毁；生效方式不可用时在闸门里配好另一种方式，生效方式不跟着变（与 CRD 共有，Q-CRD-01）。登录会话的上限与回收未实现（REQ-AUTH-010）。
- **待定**：Q-AUTH-01…03（[open-questions.md](./open-questions.md)）；都按默认走即可。

**状态词表**：`已实现`（行为与本文一致）· `部分实现` · `未实现` · `偏离`（实现与本文不同）· `实现先行`（代码已有、原产品文档没写，待确认）· `未核实` · `计划中`（目标版本未到，或待某条待定问题选定后才生效）。「层级」= 最低验证层（单元 / 组件 / 集成 / API / e2e；`文档` = 文档一致性检查，`视觉` = 截图比对）。

## 需求索引

**共 11 条需求、47 条验收标准**：`已实现` 2 · `部分实现` 2 · `未实现` 1 · `偏离` 6。

| 编号 | 需求 | 状态 | 版本 | AC | 稿件 | 待定问题 |
|---|---|---|---|---:|---|---|
| [REQ-AUTH-001](#REQ-AUTH-001) | 一套登录面板，三处共用，在当前容器里就地展开 | `部分实现` | MVP | 4 | f-auth-panel-01、f-auth-panel-02、f-auth-panel-08、f-auth-panel-09 | — |
| [REQ-AUTH-002](#REQ-AUTH-002) | 新建任务的凭证闸门：只拦未配置 / 已过期，先折叠、点了才展开 | `部分实现` | MVP | 4 | f-auth-panel-01 | — |
| [REQ-AUTH-003](#REQ-AUTH-003) | 先停在空闲态，点 [开始帐号登录] 才开始；收起、切走、关掉即取消 | `偏离` | MVP | 5 | f-auth-panel-02 | — |
| [REQ-AUTH-004](#REQ-AUTH-004) | Codex 帐号登录（设备码）：打开授权页、设备码、倒计时、等待授权 | `偏离` | MVP | 6 | f-auth-panel-03、f-auth-panel-08 | — |
| [REQ-AUTH-005](#REQ-AUTH-005) | 设备码停下来的两种原因分开说，都给 [换一串重来] | `已实现` | MVP | 3 | f-auth-panel-04 | — |
| [REQ-AUTH-006](#REQ-AUTH-006) | Claude Code 帐号登录（授权链接 + 授权码） | `偏离` | MVP | 5 | f-auth-panel-05 | — |
| [REQ-AUTH-007](#REQ-AUTH-007) | API Key：前缀提示不拦提交、服务端拒绝给原因、提交即清空 | `偏离` | MVP | 6 | f-auth-panel-06、f-auth-panel-09 | — |
| [REQ-AUTH-008](#REQ-AUTH-008) | 登录成功：「已连上」停留到看得见，身份句与发起立刻更新 | `偏离` | MVP | 5 | f-auth-panel-07 | — |
| [REQ-AUTH-009](#REQ-AUTH-009) | 重新登录：同一面板、无缝替换、不连带销毁在跑的任务 | `已实现` | MVP | 3 | f-auth-panel-08 | — |
| [REQ-AUTH-010](#REQ-AUTH-010) | 登录会话有上限、会回收 | `未实现` | MVP | 4 | — | — |
| [REQ-AUTH-011](#REQ-AUTH-011) | 面板里的错误按码说人话 | `偏离` | MVP | 2 | — | — |

「待定问题」一列链到 [open-questions.md](./open-questions.md)，不回复时按那里写的默认走。

## 与旧文档的对照

由各条「改写了哪条旧文」汇总；旧文档代号见 [README](./README.md#旧文档代号)。逐条的旧文与新口径见每条需求，以及文末附录 A。

| 旧文档 | 被改写的位置 → 本文 | 其中作废 / 删去的 |
|---|---|---|
| P20 核心使用链路 | L227、L107 → REQ-AUTH-001；L107、L214、L186-188 → REQ-AUTH-002；§5.4 L258-262 → REQ-AUTH-003；L238 → REQ-AUTH-004；L307、L239 → REQ-AUTH-006；L297 → REQ-AUTH-008；L188 → REQ-AUTH-009 | L238（REQ-AUTH-004） |
| P22 异常场景与产品补充要求 | L18 → REQ-AUTH-005；L123 → REQ-AUTH-006；L19 → REQ-AUTH-007；L15、L19 → REQ-AUTH-011 | — |
| P21-2 发起任务向导 | L71、L83、L69 → REQ-AUTH-001；L77 → REQ-AUTH-004；L77 / L187 → REQ-AUTH-005；L79 → REQ-AUTH-006；L81 → REQ-AUTH-007；L188、L77 → REQ-AUTH-008 | L77（REQ-AUTH-004） |
| P21-3 凭证管理 | L30 → REQ-AUTH-001；L115 → REQ-AUTH-009 | — |
| P21-8 部署与初始化 | L127-129 → REQ-AUTH-003 | L127-129（REQ-AUTH-003） |
| 技术 05 | §4 → REQ-AUTH-009 | — |

只改写实现现状、试点或稿件口径（不涉及上表旧文档）的需求：REQ-AUTH-010。

---

## AUTH · Agent 登录面板（F-AUTH-PANEL）

### REQ-AUTH-001 · 一套登录面板，三处共用，在当前容器里就地展开 {#REQ-AUTH-001}

> 状态 `部分实现` · 版本 MVP · 来源 P20 §3.2 L96、L107，§5.1 L197-199，L438；P21-2 形态 B L69-83；P21-3 L46、L58、L115、L118；P21-8 L57、L135-136；01 §3.2 FE1 与 L312（三处共用一份实现）；DR-40；实现 AuthGateContainer.tsx、AuthGatePanel.view.tsx:27-90，三处宿主 SandboxTerminalContainer.tsx:256-305、CredentialsContainer.tsx:16-41、InitWizardContainer.tsx:198-215，展开态 useRuntimeAuthPanel.ts · 关联 U-32、U-82、U-92 · 稿件 f-auth-panel-01、02、08、09

登录面板只有一套（同一组件、同一套状态与文案），出现在三处：新建任务弹层的凭证闸门（REQ-AUTH-002）、凭证页每张 Agent 卡里（卡片最后一行）、初始化向导第 4 步。三处都**必须**在当前容器里就地展开：**不得**叠第二层弹层，**不得**跳页。面板结构固定：标题「配置 <Agent> 凭证」→ 一次性说明「只用配一次，之后所有任务（别的项目也算）都会用它。」（只在新建任务闸门、且这个 Agent 从未配置时）→ 方式标签页「帐号登录 / API Key」（可用方式由 Agent 声明，`RuntimeDto.authMethods`）→ 取舍说明「帐号登录走你的订阅额度；API Key 按用量计费、配起来最快。两样可以同时留着，切换只改现在用哪个。」→ 当前方式的内容 → 页脚 [管理所有凭证]（只在新建任务闸门）；面板下方 [收起]。

面板展不展开只由用户决定（[配置凭证] / [重新授权] / [登录帐号] / [重新登录] / [添加 API Key] / [更换] / 点未配置方式的单选），**不得**由服务端状态自动展开。展开时**必须**滚进视野（弹层正文可滚时，至少让标签页与主动作可见）；触发按钮显示打开态。初始标签：新建任务与向导按 Agent 整体展开，停在第一个标签（帐号登录）；凭证页按行展开，停在那一行对应的标签。[管理所有凭证] 去凭证页（路由跳转、浏览器后退能回来；P20 L438 说的「替换为路由页面」就是它），等于关掉新建任务弹层：已填的任务指令不保留（指令只在弹层开着时存在，15 §3.5 安全红线的延伸）。

**改写了哪条旧文**：P21-3 L30「[帐号授权]（经发起向导）」与同页 L118「页内直接展开」自相矛盾 → 页内展开（实现）；P21-2 L71 标题「首次使用 Codex：完成一次全局登录」→「配置 <Agent> 凭证」（实现 AuthGatePanel.view.tsx:47，v1 g3-04）；P20 L227、P21-2 L83「[管理所有凭证] → 凭证管理页（面板数据保留）」→ 弹层与已填指令不保留（实现 SandboxTerminalContainer.tsx:367-371）；P20 L107、P21-2 L69「仅从未配置时插入」→ 已过期也走同一面板（REQ-AUTH-002）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-AUTH-001.1 | 组件 | 三处宿主任一 | 打开面板 | 同一组件、同一标题、标签页与取舍说明；一次性说明与 [管理所有凭证] 只在新建任务闸门出现，凭证页与向导没有 | 已实现：AuthGatePanel.view.tsx:41-90；CredentialsContainer.tsx:24-32 不传 showOneTimeNotice / onOpenCredentials；SandboxTerminalContainer.tsx:288-291（稿件 f-auth-panel-02、08） |
| AC-AUTH-001.2 | e2e | 新建任务弹层里选了未配置的 Agent，已填任务指令 | 点 [配置凭证]；再点 [管理所有凭证] | 面板在 Agent 一组里就地展开（没有新弹层、不跳页）；点 [管理所有凭证] 跳到 /settings/credentials，浏览器后退回工作台，指令不保留 | 已实现：SandboxTerminalContainer.tsx:256-305、:288-291（router.push）、:367-371（稿件 f-auth-panel-01 → 02） |
| AC-AUTH-001.3 | e2e | 凭证页 Codex 卡 | 点 [登录帐号] / [添加 API Key] | 面板在这张卡的最后一行展开，停在对应标签；触发按钮显示打开态（aria-expanded="true"、aria-controls 指向面板） | 部分实现：展开与标签已实现（useCredentials.ts:180-191、CredentialsContainer.tsx:30）；触发按钮没有打开态与 aria-expanded（稿件 f-auth-panel-08、09） |
| AC-AUTH-001.4 | 组件 | 新建任务弹层正文比可视区高 | 面板展开 | 面板滚进视野（block: nearest），弹层头与页脚条固定，[发起任务并打开终端] 始终可见 | 未实现：没有滚动处理；现状弹层没有固定页脚，面板展开后主按钮被挤出可视区（DR-40）（稿件 f-auth-panel-03…07） |

### REQ-AUTH-002 · 新建任务的凭证闸门：只拦未配置 / 已过期，先折叠、点了才展开 {#REQ-AUTH-002}

> 状态 `部分实现` · 版本 MVP · 来源 P20 §5.1 L178-203、L107；P21-2 L69-71；原型评审 F3（不可发起的按钮仍可聚焦并说出原因）；实现 SandboxTerminalContainer.tsx:216-305、:463-468，NewSandboxPanel.view.tsx:284-293、:459-462、:482 · 关联 U-32 · 稿件 f-auth-panel-01

新建任务弹层按选中 Agent 的 `credentialStatus` 判：`active` → 不出闸门，Agent 一组下写「将以 <打码身份> 身份运行」；`expiring` → 同上，句尾加「（凭证即将到期，建议尽快重新授权）」，不拦；`none` → 折叠闸门：一句「<Agent> 还没有配置凭证，配置好才能发起任务。」+ [配置凭证]；`expired` →「<Agent> 的凭证已过期，重新授权后才能发起任务。」+ [重新授权]，展开后没有一次性说明。闸门在场时 [发起任务并打开终端] **必须**发不出去，但仍可聚焦并说出原因（对话框底部一句「先完成上面的 <Agent> 登录，才能发起任务。」，按钮 aria-describedby 指向闸门句与这句）。选中单选这一下**不得**起任何登录（REQ-AUTH-003）；换 Agent 时已展开的面板收起。

**改写了哪条旧文**：P20 L107、L214「② 无生效凭证 → 弹窗内就地展开拦截面板」→ 先折叠成一句 + 按钮，点了才展开（实现 SandboxTerminalContainer.tsx:234-247 记录的 2026-09-24 真机事故：只是在单选间点了三下，helper 里就堆出 3 个登录会话、内存 94MB → 479MB；与 FE1 一致）；P20 L186-188 分支③保留，按钮名按实现「重新授权」。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-AUTH-002.1 | 组件 | 选中的 Agent `credentialStatus = none` | 渲染 | 折叠句 + [配置凭证]；不挂登录面板；begin 0 次 | 已实现：SandboxTerminalContainer.tsx:258-276（稿件 f-auth-panel-01） |
| AC-AUTH-002.2 | 组件 | `credentialStatus = expired` | 渲染并点 [重新授权] | 「…的凭证已过期，重新授权后才能发起任务。」；展开后没有一次性说明 | 已实现：:262-264、:274、:288 |
| AC-AUTH-002.3 | 组件 | `credentialStatus = active / expiring` | 渲染 | 无闸门；「将以 a***@example.com 身份运行」，expiring 句尾加建议 | 已实现：:463-468 |
| AC-AUTH-002.4 | 组件 | 闸门在场 | 键盘聚焦 / 按下 [发起任务并打开终端] | 按钮可聚焦，读屏读出两句原因；不发请求 | 部分实现：不发请求已实现（:308-313 兜底）；按钮是原生 disabled、键盘到不了（NewSandboxPanel.view.tsx:482） |

### REQ-AUTH-003 · 先停在空闲态，点 [开始帐号登录] 才开始；收起、切走、关掉即取消 {#REQ-AUTH-003}

> 状态 `偏离` · 版本 MVP · 来源 01 §3.2 FE1（L177）、TC-AUTH-002；DR-32（空闲态推荐词）；P21-8 L127-129（被改写）；v1 g3-04、g4-03；实现 AuthGateContainer.tsx:105-113（key=method，切标签即重挂）、:136-141（挂载即 begin）、:203、:254（准备中句），SandboxTerminalContainer.tsx:367-371（关弹层不收面板）、:440-444（换 Agent 收起），runtime.controller.ts:48-91（没有取消接口），runtime.schema.ts:156（`cancel` 字段被丢弃）· 关联 TC-AUTH-002 · 稿件 f-auth-panel-02

帐号登录标签打开时**必须**停在空闲态：只给 [开始帐号登录]（整宽主按钮）+ 一句说明。说明按登录方式分两种（DR-32）：设备码（Codex）「点了才开始：平台这时才向 OpenAI 申请一串设备码，再带你去授权页。」；授权链接（Claude Code）「点了才开始：平台这时才去准备 Claude Code 的登录链接。」；第二句三处共用「登录开始后，切到 API Key、点「收起」或关掉弹层，这次登录都会取消。」（向导里没有弹层，去掉「或关掉弹层」）。点了之后先显示准备中（Codex「正在准备登录…」、Claude Code「正在准备登录链接…」），拿到挑战后进 REQ-AUTH-004 / REQ-AUTH-006。面板出现、切标签、选单选、React StrictMode 的双重调用都**不得**发起登录；一次点击恰好发起一次。登录开始后，收起面板、切到 API Key、关掉弹层、换 Agent、离开页面**必须**取消这次登录：前端停止轮询，并通知后端回收会话（REQ-AUTH-010）。API Key 标签没有空闲态。

[打开授权页] 仍然只做同步的 `window.open`：码在点 [开始帐号登录] 之后就已经在页面上，所以「点了才开始」不会让新标签页被浏览器拦掉。

**改写了哪条旧文**：P21-8 L127-129「面板展开时就 begin（码与倒计时随之出现），[打开授权页] 只做一件事：同步 window.open」→ 前半句作废（FE1）：begin 移到 [开始帐号登录] 的点击里；后半句保留。P20 §5.4 L258-262 的时序（点「登录 Codex」才 POST /auth/begin）与本条一致，不改。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-AUTH-003.1 | 组件（StrictMode） | 三处任一，帐号登录标签 | 面板出现后 2 秒不操作 | begin 0 次；只见 [开始帐号登录] 与说明句 | 偏离：挂载即 begin（AuthGateContainer.tsx:136-141）（稿件 f-auth-panel-02） |
| AC-AUTH-003.2 | 组件 | 空闲态 | 在两个标签间来回切 3 次 | begin 0 次 | 偏离：key=currentMethod 重挂，回到帐号登录标签又 begin 一次（:105-113） |
| AC-AUTH-003.3 | 组件 | 空闲态 | 点 [开始帐号登录] | begin 恰好 1 次；按钮换成准备中句（按 Agent 两种） | 部分实现：准备中句已有（:203、:254），没有空闲态与按钮 |
| AC-AUTH-003.4 | 集成 | 登录已开始（设备码轮询中） | 收起 / 切到 API Key / 关弹层 / 换 Agent | 停止轮询；向后端发取消，会话在回收期限内清掉（REQ-AUTH-010） | 部分实现：卸载即停轮询（useRuntimeAuthFlow.ts:246-250）；没有取消接口，后端会话只能等过期；关弹层不收面板，重开弹层会自动再 begin（SandboxTerminalContainer.tsx:367-371） |
| AC-AUTH-003.5 | 组件 | 初始化向导第 4 步 | 渲染空闲态 | 第二句不含「或关掉弹层」 | 未实现（同 AC-AUTH-003.1） |

### REQ-AUTH-004 · Codex 帐号登录（设备码）：打开授权页、设备码、倒计时、等待授权 {#REQ-AUTH-004}

> 状态 `偏离` · 版本 MVP（v1.2 起「开新标签页」）· 来源 P21-8 §2.1 L80-136；P20 L238、L291；P22 L129；P21-2 L77（被改写）；实现 DeviceCodeAuth.view.tsx:50-167、AuthGateContainer.tsx:206-249、useOpenAuthPage.ts、useRuntimeAuthFlow.ts:21-22、:190-251、:253-281；api runtime-application.service.ts:51、:187-207、codex.adapter.ts:229-231 · 关联 U-38、U-82、U-92 · PARAM.AUTH_POLL_INTERVAL_S · PARAM.DEVICE_CODE_WARN_S · 稿件 f-auth-panel-03、08

拿到设备码后，面板**必须**按顺序给三步：① [打开授权页]（整宽主按钮，外链图标；点击即同步新开标签页，同时把设备码复制进剪贴板）+ 附注「会打开一个新标签页；本页留在这里等结果，授权完成后会自己变。」；浏览器拦了弹窗时**必须**显形：「浏览器拦了弹窗 —— 点这里手动打开」（可点链接，新标签）。② 「在新标签页粘贴这串设备码：」（复制成功后加「（已复制到剪贴板）」）+ 设备码（等宽、一次可全选）+ [复制]。③ 倒计时（后端给了到期时间才画；剩 ≤ `PARAM.DEVICE_CODE_WARN_S` 秒转警示色，到期转错误色）+「等待授权中…」（role=status）。前端每 `PARAM.AUTH_POLL_INTERVAL_S` 秒查一次结果；查询请求本身失败（网络）不消耗倒计时、不停止轮询，连续 3 次失败才把「等待授权中…」换成「网络异常，正在重试…」+ [重试]，[重试] 立即再查一次（不换码），查通后自动恢复。后端轮询终态是 error（对方拒绝或本机登录程序出错）→「登录没能完成：对方拒绝了这次登录，或者本机的登录程序出了问题。请再登录一次。」+ [重试]（重新开始登录）。后端漏发设备码或链接 →「登录信息没拿全（设备码或登录链接是空的），请重试。」+ [重试]。不做二维码，不做 [后台继续]。

**改写了哪条旧文**：P21-2 L77「大字号设备码 + [复制] + 二维码 + [打开验证链接] + 倒计时 + [后台继续]」、P20 L238「大字号设备码 + 链接 + 二维码 + 15 分钟倒计时」→ 按 P21-8 §2.1：[打开授权页] 在前、码在后，不做二维码与 [后台继续]（现状也没有）；倒计时不写死「15:00 起」，以后端给的到期时间为准（`runtime-application.service.ts:51`，15 分钟）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-AUTH-004.1 | 组件 | 拿到设备码与到期时间 | 渲染 | 三步按顺序；码等宽、可全选；倒计时 tabular；剩 300 秒转警示色 | 已实现：DeviceCodeAuth.view.tsx:50、:72-76、:80-133（稿件 f-auth-panel-03、08） |
| AC-AUTH-004.2 | 组件 | 等待授权中 | 点 [打开授权页] | 同步 window.open；码进剪贴板，标签句加「（已复制到剪贴板）」 | 已实现：useOpenAuthPage.ts、AuthGateContainer.tsx:240-244、DeviceCodeAuth.view.tsx:108 |
| AC-AUTH-004.3 | 组件 | 浏览器拦弹窗 | 点 [打开授权页] | 第一步下出现「浏览器拦了弹窗 —— 点这里手动打开」（role=alert，可点链接） | 已实现：DeviceCodeAuth.view.tsx:92-104 |
| AC-AUTH-004.4 | 组件 | 后端没给 expiresAt | 渲染 | 不画倒计时（不画 00:00）；10 分钟兜底见 REQ-AUTH-005 | 已实现：DeviceCodeAuth.view.tsx:127-133、useRuntimeAuthFlow.ts:272-275 |
| AC-AUTH-004.5 | 集成 | 轮询中查询请求网络失败 | 连续失败 1 次 / 3 次；点 [重试] | 1 次：界面不变、照常再查；3 次：换成「网络异常，正在重试…」+ [重试]；[重试] 立即再查、不换码、倒计时不重置 | 偏离：第 1 次失败就提示（useRuntimeAuthFlow.ts:233-237）；[重试] 调的是重新申请设备码（DeviceCodeAuth.view.tsx:154 → AuthGateContainer.tsx:235-239），用户在授权页里输到一半的码随之作废 |
| AC-AUTH-004.6 | 组件 | 后端轮询终态 error；或 begin 返回的码 / 链接为空 | 渲染 | 对应的一句 + [重试]（重新开始登录） | 已实现：useRuntimeAuthFlow.ts:220-228、AuthGateContainer.tsx:209-222、:250-252 |

### REQ-AUTH-005 · 设备码停下来的两种原因分开说，都给 [换一串重来] {#REQ-AUTH-005}

> 状态 `已实现` · 版本 MVP · 来源 P22 L18、L121；P20 L221；P21-2 L77、L187；实现 DeviceCodeAuth.view.tsx:135-148、useRuntimeAuthFlow.ts:24-29、:241-245、:277-281、AuthGateContainer.tsx:235-239；api runtime-application.service.ts:191-197、:362-366 · 关联 PARAM.AUTH_POLL_MAX_MIN · 稿件 f-auth-panel-04

两种停下来**必须**分开说：① 码到期（倒计时归零，或后端轮询返回 expired / `AUTH_CHALLENGE_EXPIRED`）：倒计时 00:00 错误色 +「这串设备码已经到期了。」；② 前端等满 `PARAM.AUTH_POLL_MAX_MIN` 分钟仍没有结果（码可能还有效）：「等了 10 分钟还没等到授权结果，这边先停下了 —— 这串码可能还有效，如果你刚在浏览器里点完，可以先换一串重来。」（警示，不是错误）。两种都给 [换一串重来]：重新申请一串码（重走 begin），并清掉上一次「浏览器拦了弹窗」的结论。停下来之后不再轮询；[打开授权页] 与码仍在原处。

**改写了哪条旧文**：P21-2 L77 / L187「[重新获取]」、P22 L18「[重新发起授权]」、L121「[重新获取授权码]」→ 统一叫「换一串重来」（实现 DeviceCodeAuth.view.tsx:145）；新增「前端等满 10 分钟」这一种（旧文没有，实现为防后端漏发到期时间时无限轮询而加）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-AUTH-005.1 | 组件 | 等待授权中 | 倒计时归零 | 00:00 错误色；「这串设备码已经到期了。」（role=alert）+ [换一串重来]；不再轮询 | 已实现：useRuntimeAuthFlow.ts:277-281、DeviceCodeAuth.view.tsx:135-148（稿件 f-auth-panel-04） |
| AC-AUTH-005.2 | 组件 | 码还没到期 | 前端等满 10 分钟 | 警示色长句 + [换一串重来] | 已实现：useRuntimeAuthFlow.ts:241-245、DeviceCodeAuth.view.tsx:137-141 |
| AC-AUTH-005.3 | 集成 | 已停下，之前浏览器拦过弹窗 | 点 [换一串重来] | begin 1 次，新码与新倒计时；「浏览器拦了弹窗」那句消失 | 已实现：AuthGateContainer.tsx:235-239 |

### REQ-AUTH-006 · Claude Code 帐号登录（授权链接 + 授权码） {#REQ-AUTH-006}

> 状态 `偏离` · 版本 MVP · 来源 P20 §5.2 L239、§5.4 L299-307；P21-2 L79；P22 L123；UX-DS-402、DR-33、DR-26；实现 SetupTokenAuth.view.tsx:29-102、AuthGateContainer.tsx:176-204、useRuntimeAuthFlow.ts:136-153、:181-251（setup-token 也轮询，只认成功）；api claude-code.adapter.ts:211-213、:240-255、runtime-application.service.ts:165-177（同机自动送回）、:211-250、:269-289 · 关联 U-39 · 稿件 f-auth-panel-05

拿到授权链接后，面板依次给：后端下发的说明句（逐字、纯文本）→ [打开授权链接]（新标签）→ 等待句「正在等浏览器把授权送回 —— 通常不需要你做别的，完成后这里会自己变。」→ 粘贴框（标签「页面显示了授权码时才需要粘贴（浏览器与平台不在同一台机器时才会这样）」，占位「页面没给码就不用填」，遮罩，[展开查看] / [隐藏]）→ [提交]（空时禁用；提交中「提交中…」、粘贴框禁用）。同机部署时浏览器授权后会自动送回，平台在后台等，用户什么都不用做；两条完成路径谁先到算谁，只落库一次。提交即清空粘贴框。被拒（`AUTH_REJECTED` / `AUTH_CHALLENGE_EXPIRED`）**必须**显示固定前端句「这串授权码不对或已经失效，请重新取一次再粘贴。」（role=alert），**不得**上屏后端原句；被拒后用户可以直接再取一次授权码粘贴提交，不需要收起再展开（底层会话已失效时，平台自己重新准备登录链接）。后端漏发链接 →「登录信息没拿全（登录链接是空的），请重试。」+ [重试]。

**改写了哪条旧文**：P20 L307、P22 L123「授权码不正确（输入框清空重试）」→ 固定句「这串授权码不对或已经失效，请重新取一次再粘贴。」（实现兜底句 useRuntimeAuthFlow.ts:148，UX-DS-402）；P20 L239「把 code 贴回输入框」→ 同机部署不需要粘贴，授权自动送回（实现 claude-code.adapter.ts:240-255、runtime-application.service.ts:165-177，2026-09-07 真机）；P21-2 L79「授权链接 + [打开链接]」→「打开授权链接」文字链。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-AUTH-006.1 | 组件 | 拿到授权链接 | 渲染 | 说明句（无 Markdown 符号）→ [打开授权链接] → 等待句 → 粘贴框（遮罩）+ [展开查看] → [提交]（空时禁用） | 部分实现：结构已实现（SetupTokenAuth.view.tsx:38-102）；等待句前是「⏳」字符，应换图标（DR-26）（稿件 f-auth-panel-05） |
| AC-AUTH-006.2 | 集成 | 同机部署 | 用户在浏览器完成授权、没有粘贴 | 面板自己变成「已连上」（REQ-AUTH-008） | 已实现：runtime-application.service.ts:165-177、useRuntimeAuthFlow.ts:190-216 |
| AC-AUTH-006.3 | 组件 | 粘了授权码 | 点 [提交] | 粘贴框立即清空；「提交中…」、粘贴框禁用 | 已实现：AuthGateContainer.tsx:193-196、SetupTokenAuth.view.tsx:65-77、:100 |
| AC-AUTH-006.4 | 集成 | 后端拒绝（401 / 404） | 渲染 | 只显示固定句，不出现后端原句 | 偏离：优先显示后端 message，没有时才用这句（useRuntimeAuthFlow.ts:88-92、:146-149） |
| AC-AUTH-006.5 | 集成 | 第一次提交被拒 | 再取一次授权码粘贴提交 | 能完成登录，不需要收起再展开 | 偏离（按代码推断，未实跑）：任何提交错误后后端都销毁该会话（runtime-application.service.ts:243-249），第二次提交必然 404，且 404 的英文原句「challenge … expired or unknown」（:218）会原样上屏 |

### REQ-AUTH-007 · API Key：前缀提示不拦提交、服务端拒绝给原因、提交即清空 {#REQ-AUTH-007}

> 状态 `偏离` · 版本 MVP · 来源 P21-2 L81、L189；P21-3 L116；P20 L240、L309-312；P22 L19；UX-DS-402、DR-33；I-RTS-3；实现 ApiKeyAuth.view.tsx:48-105、AuthGateContainer.tsx:158-174、useRuntimeAuthFlow.ts:74-92、:155-175、authFlow.ts:248-260；api runtime-application.service.ts:395-447、token-format.validator.ts:60-95、codex.adapter.ts:191、claude-code.adapter.ts:206 · 关联 U-40、U-93 · 稿件 f-auth-panel-06、09

API Key 标签是一张表单：标签「API Key（保存后仅展示尾号）」+ 遮罩输入框（等宽；占位按 Agent 声明的前缀，如「sk-…」）+ 去处句（知道厂商时「在 <厂商> 的控制台创建一个 API Key，粘到这里；按用量计费。」，不知道时「API Key 在签发它的厂商控制台里创建；按用量计费。」）+ [保存并继续]（空时禁用；提交中「校验中…」、输入框禁用）。前缀（`RuntimeDto.apiKeyPrefix`：Codex `sk-`、Claude Code `sk-ant-`）只是提示：输入不以它开头时输入框标错误态 +「这串 key 一般以 <前缀> 开头 —— 确认没拿错的话，也可以直接提交，由服务端判定。」，**不得**拦提交；空输入不提示。提交即清空输入框（不论成败）。服务端拒绝（401 `AUTH_REJECTED`）**必须**就地显示：标题用前端句「这串 API Key 格式不对，没有保存。」（DR-33，暂行），下面逐条列出后端给的原因（`details[].message`）；后端没给原因时只出标题，**不得**编造原因。被拒后不弹层、面板不收起。配好之后成不成为生效方式见 REQ-CRD-011。

**改写了哪条旧文**：P21-2 L81「失败就地红字 + 可能原因列表（格式错误/无权限/额度不足）」、L189「API Key 无效或无权限 [重新输入]」、P22 L19「❌ API Key 无效或无权限」→ 标题「这串 API Key 格式不对，没有保存。」，原因只列后端给的（后端对 API Key 只做格式检查，runtime-application.service.ts:405-441；「无权限 / 额度不足」说过头了）；P21-2 L81「成功即清空本地值并进确认步」→ 单弹窗没有确认步，成功按 REQ-AUTH-008；「loading 最长约 2s」→ 不承诺时长。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-AUTH-007.1 | 组件 | Claude Code 的 API Key 标签 | 输入不以 sk-ant- 开头的值 | 输入框错误态 + 前缀提示句；[保存并继续] 仍可点 | 已实现：ApiKeyAuth.view.tsx:64、:78-82（稿件 f-auth-panel-06） |
| AC-AUTH-007.2 | 组件 | 输入框为空 | 渲染 | 不提示前缀；[保存并继续] 禁用 | 已实现：authFlow.ts:257-260、ApiKeyAuth.view.tsx:48 |
| AC-AUTH-007.3 | 集成 | 输入了 key | 点 [保存并继续] | 输入框立即清空；「校验中…」、输入框禁用 | 已实现：AuthGateContainer.tsx:168-171、ApiKeyAuth.view.tsx:105 |
| AC-AUTH-007.4 | 集成 | 后端 401，details 有 1 条原因 | 渲染 | 标题「这串 API Key 格式不对，没有保存。」+ 1 条原因（如「比正常的 key 短，可能只复制到了一部分。」）；面板不收起 | 偏离：标题显示后端原句「这串 API Key 没有通过格式检查，没有保存。」（useRuntimeAuthFlow.ts:88-92、runtime-application.service.ts:432）（稿件 f-auth-panel-06、09） |
| AC-AUTH-007.5 | 集成 | 后端拒绝但没给 details | 渲染 | 只出标题 | 偏离：兜底一条「可能是格式不对、这个 key 没有权限，或者额度用完了。」（useRuntimeAuthFlow.ts:85） |
| AC-AUTH-007.6 | 组件 | 凭证页 Codex 卡 / 新建任务闸门 | 渲染去处句 | 两处都点名厂商（「在 OpenAI 的控制台…」） | 部分实现：凭证页点名（CredentialsContainer.tsx:27、ApiKeyAuth.view.tsx:84-87）；新建任务闸门没把 vendor 传给面板，用兜底句（SandboxTerminalContainer.tsx:280-295）——稿件 f-auth-panel-06 照现状画兜底句 |

### REQ-AUTH-008 · 登录成功：「已连上」停留到看得见，身份句与发起立刻更新 {#REQ-AUTH-008}

> 状态 `偏离` · 版本 MVP · 来源 DR-21；UX-DS-508；P21-2 L188；P20 L107、L207、L297；P21-2 L73；P21-3 L59；TC-AUTH-004（界面给出结果）；实现 AuthGateContainer.tsx:149-156、useRuntimeAuthPanel.ts:72-76、useRuntimeAuthMutations.ts:36-42、useRuntimeAuthSync.ts、SandboxTerminalContainer.tsx:256-281、:463-468 · 关联 U-82、U-92 · PARAM.AUTH_SUCCESS_HOLD_MS · 稿件 f-auth-panel-07（凭证页同理，见 f-auth-panel-08 头注释第 7 条）

三种方式任一成功后：面板内容**必须**换成「已连上」（成功图标 + 一句，role=status），停留到用户看得见再收起——至少 `PARAM.AUTH_SUCCESS_HOLD_MS`，并且 runtimes 重新拉取完成；期间闸门**不得**闪回「还没有配置凭证」。身份与可用状态按成功结果立刻更新：新建任务里 Agent 一组出现「将以 <打码身份> 身份运行」、[发起任务并打开终端] 可用、已填的任务指令保留；凭证页卡片刷新（状态徽标、那一行的打码身份与有效期）；向导里那一行变成已配置。原位的「已连上」是主反馈，轻提示「凭证已更新」只作补充（UX-DS-508）。其他页面（任务树的凭证标记、横幅）经 /events `runtime-auth.status_changed` 同步。在新建任务闸门与初始化向导里配好的方式即成为这个 Agent 的生效方式（规则见 REQ-CRD-011 第 2 条）。

**改写了哪条旧文**：P21-2 L188「"✅ 配置完成"，2s 后自动进确认步」→ 单弹窗没有确认步：「已连上」停留后面板收起，留在同一弹层（P20 §3.2）；P20 L297「success + 掩码帐号 → 2s 面板就地收起」保留并补「且 runtimes 重取完成」；P21-2 L77「toast「Codex 授权完成，凭证已保存」（1s 自动消失）」→「凭证已更新」，按轻提示统一规则（gap-shared §1：4 秒、悬停暂停）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-AUTH-008.1 | 组件 | 任一方式成功 | — | 面板显示「已连上」（role=status），≥ 2 秒且 runtimes 重取完成后才收起 | 偏离：成功回调与收起同批（useRuntimeAuthPanel.ts:72-76），「已连上」（AuthGateContainer.tsx:149-156）在新建任务与凭证页里根本画不出来（稿件 f-auth-panel-07） |
| AC-AUTH-008.2 | 组件 | 新建任务闸门里成功，runtimes 尚未重取完 | 渲染 | 闸门不闪回；身份句已出现；发起可用；任务指令仍在 | 偏离：重取完成前 credentialStatus 仍是旧值，闸门短暂退回折叠句（SandboxTerminalContainer.tsx:256-276，DR-21） |
| AC-AUTH-008.3 | 组件 | 任一宿主成功 | — | 轻提示「凭证已更新」（role=status），跟随主题 | 部分实现：已有（useRuntimeAuthMutations.ts:41）；sonner 恒为亮色（DR-29） |
| AC-AUTH-008.4 | 集成 | Codex 的帐号登录已删除或已过期、API Key 未配置 | 在新建任务闸门里保存 API Key 成功 | Codex 改用 API Key；闸门消失，可发起 | 偏离（按代码推断，未实跑）：见 AC-CRD-011.3——生效方式仍指向帐号登录，credentialStatus 仍按帐号登录算（runtime-application.service.ts:79-82），面板说「已连上」而闸门不消失 |
| AC-AUTH-008.5 | 集成 | 工作台开在另一个标签 | 凭证页里登录成功 | 工作台那边的凭证状态在 /events 推送后刷新 | 已实现：useRuntimeAuthSync.ts（凭证页本身不收推送，靠 invalidate 与 60 秒 staleTime，同文件注释） |

### REQ-AUTH-009 · 重新登录：同一面板、无缝替换、不连带销毁在跑的任务 {#REQ-AUTH-009}

> 状态 `已实现` · 版本 MVP · 来源 P21-3 L22-23、L57-59、L95、L115、L133；P20 L186-188；P22 L124、L128；plan.md「待核实」第 1 条（已核实，结论见本条）；实现 useCredentials.ts:180-185（[重新登录] → 同一面板）、runtime-credential.service.ts:120-166（同方式旧凭证 revokeAndEraseSync，不调 `revoke()`、不发 `CredentialRevoked`）、:294-307（只有删除凭证发 `CredentialRevoked`）、credential-revoked.handler.ts:65-81（销毁只由 `CredentialRevoked` 触发）、audit.projector.ts:329-345 · 关联 U-38 · 稿件 f-auth-panel-08（头注释第 8 条）

凭证页 [重新登录]（帐号登录行，已过期或想提前换）、新建任务闸门 [重新授权]（已过期）、全局横幅的 [重新登录] 都打开同一块面板（REQ-AUTH-001），走同一套空闲 → 登录 → 成功。成功 = 无缝替换：同一 Agent、同一方式的旧凭证被擦除（密文清空、记录保留供审计），新凭证立即成为这个方式的凭证；生效方式不变；**不**触发删除凭证的连带后果——正在跑的任务继续用启动时注入的那份直到结束，之后新开的（含重新启动的）任务用新的。替换无需额外确认。

**改写了哪条旧文**：P21-3 L115「成功后旧凭证按吊销语义处理（技术 05 §4）」、L133「旧凭证按吊销语义处理、无需额外确认」、L95「旧记录按吊销语义」、P20 L188「成功后旧记录标记吊销」→「旧的那份被擦除，但不走删除凭证的连带销毁」。原因：「吊销语义」在今天的实现里等于「销毁绑定这份凭证的在跑任务」（credential-revoked.handler.ts:73-80），照字面读会以为重新登录会杀掉在跑任务，而实现并非如此，P22 L124「运行中 Task 下次启动生效」才是实际行为。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-AUTH-009.1 | e2e | Codex 帐号登录已过期 | 凭证页点 [重新登录]，登录成功 | 卡内展开同一面板；成功后该行显示新的打码帐号与有效期，「当前使用」不动 | 已实现：useCredentials.ts:180-185、runtime-credential.service.ts:151-159；web/e2e/runtimeCredentials.spec.ts:67 |
| AC-AUTH-009.2 | 集成 | Codex 帐号登录有 2 个在跑任务（有注入绑定） | 重新登录成功 | 2 个任务照常运行、不进删除中；旧凭证行 revoked_at 有值、密文为空；审计里只有新凭证的保存记录，没有删除记录 | 已实现（按代码核实，未实跑）：runtime-credential.service.ts:143-161 直接 revokeAndEraseSync、只发新凭证的 CredentialStored；CredentialRevoked 只在 revoke() 里发（:294-307），销毁只由它触发（credential-revoked.handler.ts:65-81） |
| AC-AUTH-009.3 | e2e | 新建任务选了凭证已过期的 Agent | 点 [重新授权] → 登录成功 | 闸门消失，可发起 | 已实现：SandboxTerminalContainer.tsx:262-275 |

### REQ-AUTH-010 · 登录会话有上限、会回收 {#REQ-AUTH-010}

> 状态 `未实现` · 版本 MVP（P0 BE4）· 来源 01 §3.2 BE4（L195）；02 R-10；TC-AUTH-001；实现 runtime-application.service.ts:109-183（每次 begin 都 `ids.next()` + `helper.openSession`，不去重）、:269-289（授权链接会话等不到自动完成时只记 debug、不回收）、runtime.controller.ts:66-75 与 runtime.schema.ts:156（`cancel` 字段被丢弃）；SandboxTerminalContainer.tsx:234-247（2026-09-24 真机：3 个会话、2 个并存的 `claude setup-token`、helper 内存 94MB → 479MB / 512MB）· 关联 PARAM.AUTH_SESSION_MAX · PARAM.DEVICE_CODE_TTL_MS

同一 Agent + 同一登录方式，后端同一时刻最多一个进行中的登录会话：重复或并发的开始请求复用同一个（单飞），不再拉起新的登录进程；全机进行中的会话不超过 `PARAM.AUTH_SESSION_MAX`，超出时明确拒绝（可区分的错误码，面板按码说人话，REQ-AUTH-011）。会话在三种情况下**必须**回收（结束登录进程、删除临时目录）：成功落库、用户取消（REQ-AUTH-003）、超过有效期（设备码 `PARAM.DEVICE_CODE_TTL_MS`；授权链接会话同样有上限）。

**改写了哪条旧文**：无（旧产品文档没有这一条）。它是 2026-09-24 真机事故后的 P0 技术要求；记进产品说明是因为后果用户看得见——helper 内存耗尽时，凭证刷新与另一个 Agent 的登录会一起失败。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-AUTH-010.1 | 集成 | claude-code | 连续 5 次、再并发 5 次开始登录 | 进行中会话 ≤ 1，登录进程 ≤ 1，并发不出 500 | 未实现（TC-AUTH-001 基线红） |
| AC-AUTH-010.2 | 集成 | 上限配为 1，codex 正在登录 | claude-code 开始登录 | 被拒，可区分的错误码；不拉起进程 | 未实现 |
| AC-AUTH-010.3 | 集成 | 一个进行中的会话 | 前端取消 | 会话与进程在回收期限内清掉 | 未实现：没有取消接口 |
| AC-AUTH-010.4 | 集成 | 一个无人理会的授权链接会话 | 超过有效期 + 一个清扫周期 | 会话数为 0，进程已回收 | 未实现：只清墓碑（sweepOutcomes），进行中的授权链接会话不回收 |

### REQ-AUTH-011 · 面板里的错误按码说人话 {#REQ-AUTH-011}

> 状态 `偏离` · 版本 MVP · 来源 P22 §1 L15、L18-20，鉴权阶段 L121-129；UX-DS-402；DR-33；实现 useRuntimeAuthFlow.ts:88-92、:118-131、:146-149、:166-171、:220-228；api runtime-application.service.ts:131-143（503 带人话 message）、:218、:242（404 英文原句）、:544-562（adapter 错误原样透传） · 关联 REQ-DIA-019（诊断第 ⑨ 项「帐号登录环境」）

面板里的错误一律按错误码给前端句，**不得**直接上屏后端原句或错误码原文：

| 码 / 情形 | 何时 | 面板里怎么说 | 出路 |
|---|---|---|---|
| `PROVIDER_UNAVAILABLE`（503） | 开始登录时本机登录程序起不来 | 「本机的登录程序没能启动，暂时没法开始登录。」 | [重试]；再失败去系统状态跑诊断（第 ⑨ 项帐号登录环境） |
| `AUTH_CHALLENGE_EXPIRED`（404） | 码 / 链接过期 | 设备码见 REQ-AUTH-005；授权码见 REQ-AUTH-006 的固定句 | [换一串重来] / 再取一次 |
| `AUTH_REJECTED`（401） | 授权码或 API Key 被拒 | 见 REQ-AUTH-006 / REQ-AUTH-007 | — |
| 轮询终态 error | 对方拒绝或登录程序出错 | 「登录没能完成：对方拒绝了这次登录，或者本机的登录程序出了问题。请再登录一次。」 | [重试] |
| 开始登录的请求本身失败 | 网络 | 「没能开始登录，请重试。」 | [重试] |
| `UNSUPPORTED_METHOD`（400） | 不应触达用户 | 「这个 Agent 不支持这种登录方式。」 | 上报 |

**改写了哪条旧文**：P22 L15「🔴 运行时无响应（容器服务未启动？）」→ 帐号登录场景专用句（登录程序跑在平台的 helper 里，与容器服务无关）；P22 L19 帐号授权「❌ 授权被拒绝或取消」→ 轮询终态 error 的那句（实现 useRuntimeAuthFlow.ts:226-227）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-AUTH-011.1 | 集成 | helper 起不来 | 点 [开始帐号登录] | 503 那句 + [重试] + 去系统状态诊断的入口 | 部分实现：句子来自后端信封（runtime-application.service.ts:138 → useRuntimeAuthFlow.ts:126-129），只有 [重试]（AuthGateContainer.tsx:257-272） |
| AC-AUTH-011.2 | 组件 | 任一错误 | 渲染 | 面板里不出现英文原句与错误码原文 | 偏离：前端优先显示后端 message（useRuntimeAuthFlow.ts:88-92），adapter 的原句与 404「challenge … expired or unknown」会原样上屏（runtime-application.service.ts:218、:242、:544-562） |

---

## 附录 A · 改写对照（逐条，来自各片段）

### 改写对照（旧文 → 本片）（crd-a）

| 旧文 | 位置 | 改写为 | 依据 |
|---|---|---|---|
| P21-8 L127-129「面板展开时就 begin」 | REQ-AUTH-003 | 点 [开始帐号登录] 才 begin；[打开授权页] 仍只做同步 window.open | FE1（01 L177）、TC-AUTH-002、DR-32 |
| P20 L107、L214「无生效凭证 → 弹窗内就地展开拦截面板」 | REQ-AUTH-002 | 先折叠成一句 + [配置凭证]，点了才展开 | 实现 SandboxTerminalContainer.tsx:234-247（2026-09-24 真机事故）、FE1 |
| P21-3 L30「[帐号授权]（经发起向导）」 | REQ-AUTH-001 | 页内展开（与同页 L118 一致） | 实现 CredentialsContainer.tsx:16-41 |
| P21-2 L71 面板标题「首次使用 Codex：完成一次全局登录」 | REQ-AUTH-001 | 「配置 <Agent> 凭证」 | 实现 AuthGatePanel.view.tsx:47、v1 g3-04 |
| P20 L227、P21-2 L83「[管理所有凭证]（面板数据保留）」 | REQ-AUTH-001 | 跳凭证页即关弹层，已填指令不保留 | 实现 SandboxTerminalContainer.tsx:367-371、15 §3.5 |
| P21-2 L77、P20 L238「大字号设备码 + 二维码 + [打开验证链接] + [后台继续]」 | REQ-AUTH-004 | [打开授权页] 在前、码在后；不做二维码与后台继续 | P21-8 §2.1、实现 DeviceCodeAuth.view.tsx |
| P21-2 L77 / L187「[重新获取]」、P22 L18「[重新发起授权]」、L121「[重新获取授权码]」 | REQ-AUTH-005 | 「换一串重来」；新增「前端等满 10 分钟」 | 实现 DeviceCodeAuth.view.tsx:135-148 |
| P22 L129「连续 3 次网络错误转「网络异常 [重试]」，[重试] 恢复轮询」 | REQ-AUTH-004 | 保留（实现第 1 次就提示、[重试] 换码，记偏离） | P22 |
| P20 L307、P22 L123「授权码不正确（输入框清空重试）」 | REQ-AUTH-006 | 固定句「这串授权码不对或已经失效，请重新取一次再粘贴。」 | UX-DS-402、实现兜底句 |
| P20 L239「把 code 贴回输入框」 | REQ-AUTH-006 | 同机部署自动送回，粘贴只是远端部署的退路 | 实现 claude-code.adapter.ts:240-255 |
| P21-2 L81「可能原因列表（格式错误/无权限/额度不足）」、L189 / P22 L19「API Key 无效或无权限」 | REQ-AUTH-007 | 标题「这串 API Key 格式不对，没有保存。」+ 后端给的原因，不编造 | DR-33、runtime-application.service.ts:405-441 |
| P21-2 L188「✅ 配置完成，2s 后自动进确认步」 | REQ-AUTH-008 | 「已连上」停留 ≥ 2 秒且 runtimes 重取完成后收起，留在同一弹层 | DR-21、P20 §3.2 |
| P21-2 L77「toast「Codex 授权完成，凭证已保存」（1s）」 | REQ-AUTH-008 | 「凭证已更新」，作补充 | UX-DS-508、gap-shared §1 |
| P21-3 L95、L115、L133、P20 L188「旧凭证按吊销语义处理 / 标记吊销」 | REQ-AUTH-009 | 旧的被擦除，但不走删除凭证的连带销毁 | 核实：runtime-credential.service.ts:143-161、credential-revoked.handler.ts:65-81 |
| P22 L15「运行时无响应（容器服务未启动？）」 | REQ-AUTH-011 | 帐号登录专用句（登录程序起不来） | runtime-application.service.ts:138 |
| P21-3 L114 确认文案「切换后新任务将使用 API Key…」、「[生效中]」 | REQ-CRD-010 | 实现口语句；「当前使用」；标题加空格、加副标题 | runtimeCredential.ts:135-149、DR-35 ⑩ |
| P21-3 L114「未配置 → 配置完成即自动切换」、P20 L207 / P21-2 L73「闸门里配好的即成为生效模式」 | REQ-CRD-011 | 三条规则（从单选来 / 当前无可用方式 / 其余不切） | P22 L126、I-RTS-3、U-40 |
| P21-8 L346-353「默认启用 vs 出厂关闭，待裁决」 | REQ-ACC-001 | 默认启用，首次启动在服务日志里给一次 | D3（未回复按推荐）、DR-13 |
| P21-8 L356「首次启用自动生成 + [复制] / [重新生成]」 | REQ-ACC-001、REQ-ACC-002 | 日志给一次；换口令走环境变量或接口，界面区块延后 | D9 Q-SYS-07②、REQ-SYS-050 |
| P21-8 L354「启用后首次访问弹口令输入」 | REQ-ACC-003 | 全屏口令门，底下不挂工作台 | DR-28 |
| 后端信封原句「此环境已启用访问口令…」「访问口令不正确」「…请 N 秒后重试」 | REQ-ACC-004、REQ-ACC-005 | 前端句；锁定按分钟说 | DR-33 |
| P21-8 L354「连续 5 次错误锁定 5 分钟」 | REQ-ACC-005 | 只数提交口令的失败 | 本片核实（passcode.guard.ts:68） |
| P21-8 L354「7 天滑动」、L355「重新生成后既有 session 立即失效」 | REQ-ACC-006、007 | 固定 7 天；换口令默认不踢人，可选「同时让已登录的浏览器失效」 | Q-ACC-01 C（用户拍板 2026-10-04）；技术 11 §3.1、实现 |

## 附录 B · 片段里的默认决定与待确认（原文）

> 下面是各片段的原文，编号仍是片段里的本地编号；统一编号与完整的选项、推荐、默认在 [open-questions.md](./open-questions.md)，对照见其 §7。

### 待裁决（crd-a）

#### Q-ACC-01 · 口令会话要不要顺延、换口令要不要踢掉已解锁的浏览器

- **为什么要问**：P21-8 L354-355 写「7 天滑动窗口、每次请求自动刷新」「[重新生成] 后所有既有 session 立即失效」；技术 11 §3.1 与实现是「固定 7 天、不顺延」「已通过的会话不受口令重新生成影响」（passcode.service.ts:111-118 的注释说明了理由：否则每次换口令都是全员下线）。产品文档与技术文档互相冲突，属安全方向。
- **A（按现状，本片默认）**：固定 7 天；换口令不踢人。想立刻让所有浏览器失效，靠换签名密钥（`PASSCODE_COOKIE_SECRET` 或清掉库里的会话密钥）——这条要写进 README。
- **B（按 P21-8）**：滑动 7 天（每个请求续签 cookie）；regenerate 同时轮换会话签名密钥。代价：改守卫与 regenerate；换口令即全员下线。
- **C**：固定 7 天，但 regenerate 时可选「同时让已登录的浏览器失效」（接口加一个参数，界面区块做时再露出）。
- **不回复时默认**：A。REQ-ACC-006 与 AC-ACC-006.2 按 A 写；选 B / C 时改这两处与 REQ-ACC-002 的「已解锁的会话仍有效」。
- **已拍板 · 2026-10-04 · 用户原话「补全 10 条按推荐」· 选 C**：固定 7 天不顺延；换口令时可选「同时让已登录的浏览器失效」（默认不选）。已改 REQ-ACC-001 / 002 / 006，新增 REQ-ACC-007（接口参数、`PASSCODE_COOKIE_SECRET` 固定时整个拒绝、环境变量那条路、写进 README 与口令横幅）。

### 本片的默认决定与待确认（crd-a）

1. **编号与 plan 草拟的对应**：plan.json F-AUTH-PANEL 的简报按 001–008 草拟（003 设备码、007 重新登录…），稿件出稿时已按本片编号写进头注释（001 共用面板、002 闸门、003 空闲态、004 设备码、005 到期、006 授权码、007 API Key、008 成功、009 重新登录），以本片为准；plan.md「待核实」里说的「REQ-AUTH-007 先写待核实」即本片 REQ-AUTH-009，已核实。
2. **网络错误的 [重试]**（AC-AUTH-004.5）：按 P22 L129 写「立即再查一次、不换码」，实现是「换一串码」。若认为现状更好（简单），把那条 AC 的 Then 改成「重新申请设备码」即可，稿件不受影响（f-auth-panel-03 只在注释里提到这个变体）。
3. **授权码被拒后能否直接再粘**（AC-AUTH-006.5）：本片要求「能」，平台在底层会话已失效时自己重新准备链接；要不要后端保留会话由实现定。按代码推断后端会销毁会话，需在真实 helper 上跑一次确认 claude CLI 被拒后还能不能接收第二个码。
4. **「配好即生效」的第 2 条**（REQ-CRD-011）：把旧文「从未配置」扩到「生效的那份已删除或已过期」。不扩的话，删掉在用的那份又只配了另一种的人会卡在闸门里（AC-AUTH-008.4、AC-CRD-011.3）。实现可在前端成功回调里补一次 PUT auth-mode，或后端在「生效方式没有可用凭证」时也写生效方式（I-RTS-3 的例外要写进不变量）。
5. **锁定到期后再错一次即再锁**（AC-ACC-005.4）：按现状写成实现先行；若想「到期后重新数 5 次」，limiter 在锁定到期时清零计数即可。
6. **新建任务闸门点名厂商**（AC-AUTH-007.6）：产品口径是「知道厂商就点名」，闸门现状不传 vendor；稿件 f-auth-panel-06 照现状画兜底句，实现补一行 `vendor={selectedRuntimeDto.vendor}` 后稿件的去处句随之改成点名写法。
7. D3（口令默认开启）、DR-21 / DR-28 / DR-32 / DR-33 / DR-20 / DR-35 ⑩ 都按「按默认推进」写；D3 若改为「维持出厂关闭」，REQ-ACC-001 改为「部署方显式开启时才生成并打印口令」，其余 ACC 条目不变。

## 附录 C · 参数（待登记 params.yaml）

### 新增参数（待并入 params.yaml）（crd-a）

| id | 值 | 单位 | kind | 含义 | used_by | 代码落点（pattern） |
|---|---:|---|---|---|---|---|
| PARAM.AUTH_POLL_INTERVAL_S | 3 | 秒 | product | 设备码登录查结果的间隔 | REQ-AUTH-004 | web/src/hooks/credential/useRuntimeAuthFlow.ts `POLL_INTERVAL_MS = ([\d_]+)`（scale 0.001） |
| PARAM.AUTH_POLL_MAX_MIN | 10 | 分钟 | product | 前端最多等多久就先停下（与码有效期无关的兜底） | REQ-AUTH-005 | 同文件 `MAX_POLL_DURATION_MS = (\d+) \* 60` |
| PARAM.DEVICE_CODE_TTL_MS | 900000 | 毫秒 | tech | 平台给设备码登录会话的有效期（TC-AUTH-001 已用此名） | REQ-AUTH-004、REQ-AUTH-010 | api/packages/modules/runtime/src/application/runtime-application.service.ts `DEVICE_CODE_TTL_MS = (\d+) \* 60_000`（scale 60000） |
| PARAM.DEVICE_CODE_WARN_S | 300 | 秒 | product | 倒计时转警示色的剩余时间 | REQ-AUTH-004 | web/src/views/wizard/auth/DeviceCodeAuth.view.tsx `WARN_THRESHOLD_SEC = (\d+) \* 60`（scale 60） |
| PARAM.AUTH_SUCCESS_HOLD_MS | 2000 | 毫秒 | product | 「已连上」最短停留时间（DR-21） | REQ-AUTH-008 | 待实现 |
| PARAM.AUTH_SESSION_MAX | 2 | 个 | tech | 全机同时进行中的登录会话上限（TC-AUTH-001 已用此名） | REQ-AUTH-010 | 待实现（BE4） |
| PARAM.PASSCODE_MAX_FAILURES | 5 | 次 | product | 连续提交错误口令多少次后锁定 | REQ-ACC-005 | api/apps/api/src/platform/access-passcode/passcode-attempt-limiter.ts `MAX_FAILURES = (\d+)` |
| PARAM.PASSCODE_LOCK_MIN | 5 | 分钟 | product | 锁定时长 | REQ-ACC-005 | 同文件 `LOCK_MS = (\d+) \* 60` |
| PARAM.PASSCODE_SESSION_DAYS | 7 | 天 | product | 解锁后会话有效期 | REQ-ACC-006 | passcode.service.ts `COOKIE_TTL_MS = (\d+) \* 24`；session-cookie.ts `COOKIE_MAX_AGE_SEC = (\d+) \* 24`（两处落点，标 duplicated） |

## 附录 D · 边界、覆盖对照、待核实与连带更正

### 测试用例关联更正（04-示例用例.md 里的拟定编号）（crd-a）

| 用例 | 原关联 | 改为 | 说明 |
|---|---|---|---|
| TC-AUTH-001 | REQ-AUTH-010（拟） | REQ-AUTH-010 | 编号沿用，内容即本片 REQ-AUTH-010 |
| TC-AUTH-002 | REQ-AUTH-020（拟） | REQ-AUTH-003 | 020 超出 F-AUTH-PANEL 的编号段（001–019） |
| TC-AUTH-004 | — | REQ-AUTH-008（界面给出结果） | 「登录完成回放」的界面部分 |
| TC-ACC-001 | REQ-DEP-0xx（拟：访问保护） | REQ-ACC-001、REQ-ACC-002、REQ-ACC-006 | 访问保护单独成域 ACC |
| TC-ACC-002 | REQ-DEP-0xx（拟） | 不在本片（来源校验属 NFR-SEC） | 口令不能替代 Host / Origin 校验 |
