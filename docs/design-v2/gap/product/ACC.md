---
id: PRD-ACC
title: 访问口令 · 产品需求
type: prd
status: draft
owner: 产品 owner（仓库唯一人类 owner）
domains: [ACC]
flows: [F-ACC-UNLOCK]
applies_to: ">= v0.2.4"
last_verified:
  docs: fd2e1ee
  api: a453bb7
  web: 93f03c5
  date: 2026-10-04
covers:
  - web/src/containers/init/{AppBootGate,InitWizardContainer}.tsx（口令门与初始化判定、向导第 4 步宿主）
  - web/src/containers/access/AccessGateContainer.tsx、web/src/hooks/access/useAccessGate.ts、web/src/views/access/UnlockForm.view.tsx
  - api/apps/api/src/platform/access-passcode/**
supersedes:
  - docs/product/pages/21-8-部署与初始化.md §2.1（L80-136）、§3（L342-358）
drafts:
  - gap/drafts/f-auth-panel-01…09.html、f-crd-mode-01.html、f-acc-unlock-01…03.html（说明 gap/drafts/notes/crd-a.md）
merged_from:
  - gap/product/_parts/crd-a.md
merged_at: 2026-10-04
review_minutes: 30
---

# 访问口令 · 产品需求

<!-- 本文件只写「做什么 / 为什么 / 怎样算做对」。布局与视觉在稿件（gap/drafts/f-*），实现方法在技术设计。由 gap/product/_build/merge.py 从 _parts 合并生成；改片段后重新运行。「现状」列暂留文件:行出处，入库时按 01 §4.2 换成证据 ID。 -->

## 一屏摘要

- **这一域回答什么**：访问口令——口令从哪来、被拒时的全屏口令门、口令不对与连错锁定、会话与豁免面、换口令时能不能让已登录的浏览器失效（REQ-ACC-001–007）。界面里的口令管理区块本轮不做（D9 推荐 Q-SYS-07②，见 SYS.md REQ-SYS-050）。
- **五条要守的规则**：
  1. 口令默认开启：首次启动时生成，只在服务日志里给一次，不在界面里给（REQ-ACC-001，D3 推荐）。
  2. 被拒即全屏口令门，底下**不**挂工作台；解锁后重跑初始化判定（REQ-ACC-003）。
  3. 只有「提交口令」的失败才计入锁定，按分钟说剩多久（REQ-ACC-005）。
  4. 会话按浏览器、固定 7 天不顺延；换口令默认不踢人，可选「同时让已登录的浏览器失效」；口令不能替代 Host / Origin 校验（REQ-ACC-006、007，来源校验属 NFR-SEC）。
  5. 换口令、忘记口令走环境变量或接口；回环免口令要显式开启（REQ-ACC-002）。
- **现状**：7 条需求里 `已实现` 1 · `部分实现` 1 · `未实现` 1 · `偏离` 4。口令出厂关闭（待 D3）；口令门浮在工作台上（DR-28）；后端原句上屏（DR-33）；没带口令的普通请求也计入失败，首屏一轮并发拉取就可能把人锁 5 分钟（sev2，见 impl-gaps）；换口令时让已登录的浏览器失效的选项还没有（REQ-ACC-007，要后端轮换会话签名密钥）。
- **待定**：Q-ACC-01 已于 2026-10-04 拍板 C（固定 7 天；换口令时可选「同时让已登录的浏览器失效」，REQ-ACC-007 新增；口令管理区块仍按 D9 延后，落点是接口参数、口令横幅与 README）；Q-ACC-02 按默认（[open-questions.md](./open-questions.md)）。

**状态词表**：`已实现`（行为与本文一致）· `部分实现` · `未实现` · `偏离`（实现与本文不同）· `实现先行`（代码已有、原产品文档没写，待确认）· `未核实` · `计划中`（目标版本未到，或待某条待定问题选定后才生效）。「层级」= 最低验证层（单元 / 组件 / 集成 / API / e2e；`文档` = 文档一致性检查，`视觉` = 截图比对）。

## 需求索引

**共 7 条需求、28 条验收标准**：`已实现` 1 · `部分实现` 1 · `未实现` 1 · `偏离` 4。

| 编号 | 需求 | 状态 | 版本 | AC | 稿件 | 待定问题 |
|---|---|---|---|---:|---|---|
| [REQ-ACC-001](#REQ-ACC-001) | 口令默认开启：首次启动生成，只在服务日志里显示一次 | `偏离` | MVP | 3 | f-acc-unlock-01 | [Q-SYS-07②](./open-questions.md#Q-SYS-07) |
| [REQ-ACC-002](#REQ-ACC-002) | 换口令与忘记口令；回环免口令要显式开启 | `部分实现` | MVP | 4 | f-acc-unlock-01、f-acc-unlock-02 | [Q-ACC-01](./open-questions.md#Q-ACC-01) [Q-SYS-07②](./open-questions.md#Q-SYS-07) |
| [REQ-ACC-003](#REQ-ACC-003) | 被拒即全屏口令门，底下不挂工作台；解锁后重跑初始化判定 | `偏离` | MVP | 4 | f-acc-unlock-02 | — |
| [REQ-ACC-004](#REQ-ACC-004) | 口令卡：输入、解锁、验证中、口令不对、口令从哪来 | `偏离` | MVP | 4 | f-acc-unlock-02、f-acc-unlock-03 | — |
| [REQ-ACC-005](#REQ-ACC-005) | 连错锁定：只数提交口令的失败，按分钟说 | `偏离` | MVP | 5 | f-acc-unlock-03 | — |
| [REQ-ACC-006](#REQ-ACC-006) | 会话：7 天、按浏览器；豁免面 | `已实现` | MVP | 4 | — | [Q-ACC-01](./open-questions.md#Q-ACC-01) |
| [REQ-ACC-007](#REQ-ACC-007) | 换口令时可选「同时让已登录的浏览器失效」 | `未实现` | MVP | 4 | — | [Q-ACC-01](./open-questions.md#Q-ACC-01) [Q-SYS-07②](./open-questions.md#Q-SYS-07) |

「待定问题」一列链到 [open-questions.md](./open-questions.md)，不回复时按那里写的默认走。

## 与旧文档的对照

由各条「改写了哪条旧文」汇总；旧文档代号见 [README](./README.md#旧文档代号)。逐条的旧文与新口径见每条需求，以及文末附录 A。

| 旧文档 | 被改写的位置 → 本文 | 其中作废 / 删去的 |
|---|---|---|
| P21-8 部署与初始化 | L346-353、L356 → REQ-ACC-001；L356 → REQ-ACC-002；L354 → REQ-ACC-003；§3 → REQ-ACC-004；L354 → REQ-ACC-005；L354 → REQ-ACC-006；L355 → REQ-ACC-007 | — |
| 技术 11 | §3.1 → REQ-ACC-007 | — |

---

## ACC · 访问口令门（F-ACC-UNLOCK）

### REQ-ACC-001 · 口令默认开启：首次启动生成，只在服务日志里显示一次 {#REQ-ACC-001}

> 状态 `偏离` · 版本 MVP · 来源 D3（00-决策简报 L31、L88；未回复按推荐）；DR-13；01 §3.2「安全」行；P21-8 §3 L344-353、L356（被改写）；TC-ACC-001；实现 passcode.service.ts:12-14、:52-61、:68-75、:83-91，system.controller.ts:121-140（明文只在接口响应里出现一次），platform-logger.service.ts:20-23、:75-77（日志落盘 + stdout 并存，DR-13 核实） · 关联 D3 · TC-ACC-001 · 稿件 f-acc-unlock-01

全新数据目录、没有设 `ACCESS_PASSCODE` 时，平台首次启动**必须**生成一个访问口令（16 位，不含 0 O l 1 这类易混字符）并开启口令门；口令明文只在这一次启动的服务日志（stdout）里打一段醒目的横幅：口令；为什么现在就记下来（平台只存哈希，之后的日志、页面、接口都不再显示它）；之后打开平台都要先输入它（同一个浏览器 7 天内免输，REQ-ACC-006）；换口令的两种方式与忘了怎么办（REQ-ACC-002），以及换口令时怎样同时让已登录的浏览器失效（REQ-ACC-007）。之后的启动**不得**再打印口令，只打一行「access passcode ENABLED via <来源>」。口令横幅**不得**写进平台日志文件、**不得**进 [导出日志] 的包；README 写明 docker 的 json-file 日志驱动会保留 stdout（`docker logs` 仍能查到那一次输出）。

**改写了哪条旧文**：P21-8 L346-353「默认启用 vs 实现出厂关闭，待产品裁决」→ 按 D3 推荐：默认启用；P21-8 L356「首次启用自动生成口令（16 位随机串）+ [复制] / [重新生成]」→ 口令在首次启动的服务日志里给一次，不在界面里给（界面区块按 D9 Q-SYS-07② 延后，REQ-SYS-050）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-ACC-001.1 | 集成 | 全新 DATA_ROOT、未设 ACCESS_PASSCODE | 启动 | stdout 出现一次口令横幅；库里只有哈希；口令门开启 | 偏离：出厂不开口令（passcode.service.ts:68-75，source=none ⇒ enabled=false），全仓没有开机生成口令的代码（TC-ACC-001 基线红）（稿件 f-acc-unlock-01） |
| AC-ACC-001.2 | 集成 | 已生成过口令 | 再次启动 | 不再打印口令，只打「access passcode ENABLED via stored …」一行 | 部分实现：ENABLED 行已有（passcode.service.ts:55-60） |
| AC-ACC-001.3 | 集成 | 首次启动打印过口令 | 导出日志包；读平台日志文件 | 两处都没有口令明文 | 未实现（随 AC-ACC-001.1；DR-13 的单独 stdout 通道还没有） |

### REQ-ACC-002 · 换口令与忘记口令；回环免口令要显式开启 {#REQ-ACC-002}

> 状态 `部分实现` · 版本 MVP · 来源 D3（回环免口令需显式 opt-in）；TC-ACC-001 第 4 条；D9 Q-SYS-07②；P21-8 L356；Q-ACC-01 C（用户拍板 2026-10-04）；实现 passcode.service.ts:25-34、:72-75（环境变量优先）、access-passcode.service.ts:36-72（enable / regenerate / disable；ACCESS_PASSCODE 固定时 409 INVALID_STATE）、system.controller.ts:121-140、env.ts:14-15、:52-79（进程内看不到宿主端口发布） · 关联 REQ-SYS-050、REQ-ACC-007 · 稿件 f-acc-unlock-01（日志横幅里的说明）、f-acc-unlock-02（口令从哪来那句）

换口令有两种方式：① 部署配置里设 `ACCESS_PASSCODE=<新口令>`，重启生效；设了它就以它为准，接口改不动（409，说明口令由部署配置固定）；② 用当前口令解锁后调 `PUT /api/system/access-passcode {"action":"regenerate"}`，新口令只在那次响应里返回一次。忘了口令：用 ① 重设并重启。换口令默认不让已解锁的浏览器失效（REQ-ACC-006）；要同时让它们失效，换口令时选「同时让已登录的浏览器失效」（两条路各怎么做见 REQ-ACC-007，Q-ACC-01 C）。界面里的口令管理区块不在本轮（D9 Q-SYS-07②，REQ-SYS-050）。

回环免口令：默认不免——来自本机回环地址的访问同样要口令（进程内看不到宿主把端口发布在哪，平台不能自己判断「这是本机」）；只有部署方显式开启（变量名由实现定，写进 README）后，来自回环地址的请求才免口令，来自非回环地址的仍然要。

**改写了哪条旧文**：P21-8 L356「可在 21-5 系统状态中手动禁用 + [复制] / [重新生成]」→ 本轮只有环境变量与接口两条路（区块延后）；新增回环免口令的显式开关（D3）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-ACC-002.1 | 集成 | 设了 ACCESS_PASSCODE | 调 regenerate | 409，说明口令由部署配置固定；口令不变 | 已实现：access-passcode.service.ts:36-42 |
| AC-ACC-002.2 | 集成 | 口令来自库，不带「同时让已登录的浏览器失效」 | 调 regenerate | 200，响应里有新口令（只此一次）；旧口令立即失效；已解锁的会话仍有效 | 已实现：access-passcode.service.ts:63-72、passcode.service.ts:111-130 |
| AC-ACC-002.3 | 集成（L5） | 口令开启、未开回环免口令 | 从 127.0.0.1 访问受保护接口 | 要口令 | 已实现：守卫不看来源地址（passcode.guard.ts:26-70） |
| AC-ACC-002.4 | 集成（L5） | 开启回环免口令 | 分别从回环 / 非回环地址访问 | 回环免口令，非回环仍要 | 未实现：没有这个开关（TC-ACC-001 第 4 条） |

### REQ-ACC-003 · 被拒即全屏口令门，底下不挂工作台；解锁后重跑初始化判定 {#REQ-ACC-003}

> 状态 `偏离` · 版本 MVP · 来源 DR-28；UX-DS-320（全屏阻断：口令解锁页）；01 §3.2「安全」行（401 时只渲染口令门、解锁后重跑初始化判定）；P21-8 L354；实现 AppBootGate.tsx:20-23、:33-36、:54-58，AccessGateContainer.tsx:8-31，useAccessGate.ts:31-37、:67-96 · 稿件 f-acc-unlock-02

任何受保护请求被口令门拒绝（REST 401 `PASSCODE_REQUIRED` / `PASSCODE_INVALID`、429 `PASSCODE_LOCKED`，或终端 / 事件 WebSocket 握手未授权）→ 整个应用**必须**换成全屏口令门：不透明的中性底，正中是品牌行（与侧栏实例菜单同一个 Logo 与名称 +「本机」）和口令卡；口令门之下**不得**挂工作台或向导（不渲染、不发它们的请求）。口令卡本身是模态对话框（role=dialog、aria-modal、名称「访问口令」）。解锁成功后**必须**重新跑一次初始化判定，再决定进初始化向导还是工作台；之前被拒的查询自动重取，终端与事件连接在下一次重连时通过。判定依据是错误码，不是 HTTP 状态（429 也算）。

**改写了哪条旧文**：P21-8 L354「启用后首次访问弹口令输入」→ 全屏口令门、底下不挂工作台（DR-28）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-ACC-003.1 | e2e | 口令开启、浏览器没有会话 | 打开首页 | 只有全屏口令门（中性底 + 品牌行 + 口令卡）；DOM 里没有工作台与向导；不发项目 / 任务等请求 | 偏离：init-status 401 时放行 children，口令门浮在工作台上（bg-black/60 + 模糊），工作台照常挂载、发请求（AppBootGate.tsx:54-58、AccessGateContainer.tsx:14-28）（稿件 f-acc-unlock-02） |
| AC-ACC-003.2 | e2e | 口令门 | 解锁成功 | 重新判定：未初始化 → 向导；已初始化 → 工作台 | 部分实现：解锁后 invalidateQueries 重取 init-status（useAccessGate.ts:33-36），由 AppBootGate 换成向导；但解锁前工作台已经挂过 |
| AC-ACC-003.3 | 组件 | 已解锁使用中 | 会话到期，下一次请求 401 | 回到全屏口令门 | 部分实现：置锁已实现（useAccessGate.ts:80-89），外观同 AC-ACC-003.1 的偏离 |
| AC-ACC-003.4 | 组件 | 收到 429 `PASSCODE_LOCKED` | — | 也进口令门（锁定态见 REQ-ACC-005） | 已实现：useAccessGate.ts:67、:85 |

### REQ-ACC-004 · 口令卡：输入、解锁、验证中、口令不对、口令从哪来 {#REQ-ACC-004}

> 状态 `偏离` · 版本 MVP · 来源 DR-33（`PASSCODE_REQUIRED` / `PASSCODE_INVALID` 推荐词，暂行）；UX-DS-402、UX-DS-204；P21-8 L354；v1 g8-16、g8-17；实现 UnlockForm.view.tsx:17-70、useAccessGate.ts:46-52、:80-89；api passcode-errors.ts:25-49、access.controller.ts:51-83 · 稿件 f-acc-unlock-02、03

口令卡：标题「需要访问口令」；说明「这个平台设了访问口令，输入后才能继续。」（`PASSCODE_REQUIRED` 的前端句）；字段「访问口令」（遮罩、不自动填充、打开时焦点在这里）；[解锁]（整宽主按钮，没输入时禁用；回车提交；提交前去掉首尾空白）；表单说明「口令只在首次启动时输出在服务日志里，可以找部署这台平台的人要；忘了可以用环境变量 ACCESS_PASSCODE 重设。」。提交中：输入框禁用、按钮「验证中…」带转圈。口令不对（`PASSCODE_INVALID`）：输入框错误态 + 紧跟一句「口令不对，再试一次。」（role=alert；图标带错误色，句子正文色），保留刚才的输入，[解锁] 可再点。口令卡上**不得**出现后端原句或秒数。

**改写了哪条旧文**：现状说明句与错误句直接显示后端信封原句（「此环境已启用访问口令，请先解锁后再访问」「访问口令不正确」）→ 按码给前端句（DR-33）；P21-8 §3 没写口令从哪来 → 补表单说明（v1 g8-16）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-ACC-004.1 | 组件 | 口令门出现 | 渲染 | 标题、前端说明句、字段（焦点在此）、禁用的 [解锁]、口令从哪来那句 | 偏离：说明句取后端信封（UnlockForm.view.tsx:36-40、useAccessGate.ts:85-86）；没有口令从哪来那句（稿件 f-acc-unlock-02） |
| AC-ACC-004.2 | 组件 | 输入了口令 | 回车 / 点 [解锁] | 提交去掉首尾空白的口令；输入框禁用；按钮「验证中…」带转圈 | 部分实现：没有转圈（UnlockForm.view.tsx:24、:52、:66） |
| AC-ACC-004.3 | 集成 | 口令不对（第 1–4 次） | 提交 | 输入框错误态 +「口令不对，再试一次。」；输入保留；可再提交 | 偏离：显示后端原句「访问口令不正确」（passcode-errors.ts:43、useAccessGate.ts:50），输入框没有错误态（稿件 f-acc-unlock-03 ①） |
| AC-ACC-004.4 | 集成 | 口令正确 | 提交 | 设会话 cookie（REQ-ACC-006），离开口令门（AC-ACC-003.2） | 已实现：access.controller.ts:71-76 |

### REQ-ACC-005 · 连错锁定：只数提交口令的失败，按分钟说 {#REQ-ACC-005}

> 状态 `偏离` · 版本 MVP · 来源 P21-8 L354；NFR-10；TC-ACC-001 第 3 条；DR-33（`PASSCODE_LOCKED` 推荐词）；实现 passcode-attempt-limiter.ts:3-4、:30-54，passcode.guard.ts:37-69，access.controller.ts:31-40、:63-83，passcode-errors.ts:51-66，UnlockForm.view.tsx:65 · 关联 PARAM.PASSCODE_MAX_FAILURES · PARAM.PASSCODE_LOCK_MIN · 稿件 f-acc-unlock-03

同一来源（客户端 IP）连续提交错误口令 `PARAM.PASSCODE_MAX_FAILURES` 次，锁 `PARAM.PASSCODE_LOCK_MIN` 分钟：达到次数的那一次仍说「口令不对」，之后锁定期间的提交一律被拒（429 `PASSCODE_LOCKED`，带剩余秒数）。**只数在提交口令的请求**（解锁接口、带口令头的请求）；没带口令、只是还没解锁的普通请求（打开页面时的那一轮并发拉取）**不得**计入失败次数，否则用户还没输口令就被自己的页面锁住。带有效会话的请求不受锁定影响。锁定时口令卡显示「错得太多次，已暂时锁定，约 N 分钟后再试。」（剩余秒数向上取整成分钟；锁图标带错误色、句子正文色，role=alert），保留输入，锁定期间 [解锁] 置灰，到点自动恢复可点。解锁成功清零计数。

**改写了哪条旧文**：P21-8 L354「连续 5 次错误锁定 5 分钟」补两点：只数提交口令的失败；剩余时间按分钟说（现状「请 287 秒后重试」，DR-33）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-ACC-005.1 | 集成 | 同一 IP | 连续提交错口令 5 次、再提交 | 第 5 次回 401 `PASSCODE_INVALID`；第 6 次起 429 `PASSCODE_LOCKED`（带 retryAfterSec） | 已实现：access.controller.ts:63-82、passcode-attempt-limiter.ts:40-49 |
| AC-ACC-005.2 | 集成 | 口令开启、浏览器没有会话 | 首屏发出 ≥ 5 个没带口令的受保护请求（都 401）后，用户提交正确口令 | 解锁成功 | 偏离（按代码核实，未实跑）：守卫对每个既没有有效会话、也没带对口令的请求都记一次失败（passcode.guard.ts:68），与解锁接口共用同一把锁（access.controller.ts:31-40 的注释写明首屏并发拉取会「各撞一次」）；解锁接口先查锁（:65-69）⇒ 用户输对口令也被拒 5 分钟。D3 默认开启口令后每台新机器的首次打开都会撞上 |
| AC-ACC-005.3 | 组件 | 收到 `PASSCODE_LOCKED`，retryAfterSec=287 | 渲染 | 「错得太多次，已暂时锁定，约 5 分钟后再试。」；[解锁] 置灰；输入保留 | 偏离：显示后端原句「口令错误次数过多，已暂时锁定；请 287 秒后重试」（passcode-errors.ts:59），[解锁] 仍可点、提交照样被拒（稿件 f-acc-unlock-03 ③） |
| AC-ACC-005.4 | 集成 | 锁定到期，期间没有成功解锁 | 再错一次 | 立即再锁 5 分钟（连续失败计数到成功为止才清零） | 实现先行（待确认是否有意）：passcode-attempt-limiter.ts:40-43，计数只在成功时清零 |
| AC-ACC-005.5 | 集成 | 已解锁的浏览器 | 同一 IP 上有人连错 5 次 | 已解锁的浏览器照常使用 | 已实现：passcode.guard.ts:37-54（会话先放行） |

### REQ-ACC-006 · 会话：7 天、按浏览器；豁免面 {#REQ-ACC-006}

> 状态 `已实现`（Q-ACC-01 已拍板 C：固定 7 天不顺延；换口令时可选让已登录的浏览器失效，见 REQ-ACC-007）· 版本 MVP · 来源 P21-8 L354-355（被改写）；技术 11 §3.1（「已通过的会话不受口令重新生成影响」）；TC-ACC-001 第 2、3 条；实现 passcode.service.ts:12、:111-150、:156-182，session-cookie.ts:3-18，passcode.guard.ts:8-17、:26-33、:52-54、:72-77，passcode-terminal-authenticator.ts:25-36，access.controller.ts:22-28 · 关联 Q-ACC-01 · REQ-ACC-007 · PARAM.PASSCODE_SESSION_DAYS

解锁成功后发一个签名会话 cookie（HttpOnly、SameSite=Lax，TLS 下可加 Secure），有效期 `PARAM.PASSCODE_SESSION_DAYS` 天，从解锁那一刻算（不随使用顺延）；平台重启不影响会话。会话按浏览器：换浏览器或无痕窗口要重新输入。换口令（REQ-ACC-002）默认不使已解锁的会话失效；换口令时选了「同时让已登录的浏览器失效」，此前签发的会话一律作废（REQ-ACC-007）。口令门覆盖 REST、MCP over HTTP、终端与事件 WebSocket；豁免 `GET /api/health` 与解锁接口本身；本机 STDIO 的 MCP 天然不经过它。

**改写了哪条旧文**：P21-8 L354「有效期 7 天，滑动窗口——每次请求自动刷新倒计时」→ 固定 7 天、不顺延（实现：cookie 只在解锁时签发，passcode.service.ts:133-136、passcode.guard.ts:61-65）；L355「[重新生成] 口令后所有既有 session 立即失效」→ 默认不失效（技术 11 §3.1 与 passcode.service.ts:111-118 的取舍：换一次口令不该把所有人踢下线），换口令时可选「同时让已登录的浏览器失效」（REQ-ACC-007）。这两处原是产品文档与技术文档的冲突，2026-10-04 用户拍板 Q-ACC-01 → C（原话「补全 10 条按推荐」）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-ACC-006.1 | 集成 | 解锁成功 | 读响应头 | `ap_session`：HttpOnly、SameSite=Lax、Max-Age 7 天；PASSCODE_COOKIE_SECURE=true 时带 Secure | 已实现：session-cookie.ts:12-18 |
| AC-ACC-006.2 | 集成 | 解锁后每天都在用 | 第 8 天 | 会话过期，回口令门 | 已实现（不顺延；与 P21-8 L354 不同，Q-ACC-01 已拍板 C：固定 7 天） |
| AC-ACC-006.3 | 集成 | 已解锁 | 平台重启 | 会话仍有效 | 已实现：签名密钥持久化（passcode.service.ts:156-182） |
| AC-ACC-006.4 | 集成 | 口令开启、没有会话 | `GET /api/health`；`POST /api/access/unlock` | 都不被拦 | 已实现：passcode.guard.ts:72-77 |

### REQ-ACC-007 · 换口令时可选「同时让已登录的浏览器失效」 {#REQ-ACC-007}

> 状态 `未实现` · 版本 MVP · 来源 Q-ACC-01 C（用户拍板 2026-10-04，原话「补全 10 条按推荐」）；P21-8 L355（「[重新生成] 后所有既有 session 立即失效」→ 改为可选）；技术 11 §3.1（「已通过的会话不受口令重新生成影响」→ 保留为默认）；D9 Q-SYS-07②（口令管理区块延后，U-112）；实现 access-passcode.service.ts:30-75（regenerate 只换口令），passcode.service.ts:111-118（setStoredPasscode 刻意不动会话签名密钥）、:156-182（签名密钥：PASSCODE_COOKIE_SECRET 优先，否则库里那一份）、:52-61（开机日志只打 ENABLED 一行） · 关联 REQ-ACC-001、REQ-ACC-002、REQ-ACC-006、REQ-SYS-050 · 稿件 无（界面里没有口令管理区块；落点是接口参数、首次启动的口令横幅与 README）

换口令时**必须**能选「同时让已登录的浏览器失效」，默认**不选**：换一次口令不该把所有人踢下线（技术 11 §3.1 的取舍保留为默认），但口令外泄时要能一并止住已经解锁的浏览器（P21-8 L355 的本意）。

- **接口**：`PUT /api/system/access-passcode {"action":"regenerate"}` 加一个可选参数（例 `signOutAllSessions: true`，名字由实现定，写进 openapi）。选了它：换口令的同时轮换会话签名密钥——此前签发的会话一律作废，那些浏览器下一次请求就回到全屏口令门（REQ-ACC-003），要用新口令重新解锁；发起这次请求的会话（若是浏览器）随响应换发新 cookie，不被自己踢出。不选：与今天一样，已解锁的会话不受影响（REQ-ACC-006）。两种结果都记一条审计，并写明选了哪一种。
- **签名密钥由部署配置固定时**（设了 `PASSCODE_COOKIE_SECRET`）：平台改不动它，带这个参数的请求**整个**被拒（409，口令也不换，零副作用），原因写「会话签名密钥由部署配置 PASSCODE_COOKIE_SECRET 固定：要让已登录的浏览器失效，改这个变量后重启」——**不得**只换了口令、悄悄没让旧会话失效。
- **环境变量那条路**（改 `ACCESS_PASSCODE` 后重启，REQ-ACC-002 ①）：口令换了，已解锁的会话默认仍有效；要同时让它们失效，同时把 `PASSCODE_COOKIE_SECRET` 设成一个新值再重启。
- **说在哪**：界面里的口令管理区块本轮不做（D9 Q-SYS-07②，U-112 延后，REQ-SYS-050），**不得**为这一项另造管理页；上面两条路写进 README 的「换口令」一节，首次启动的口令横幅在「换口令的两种方式」后面接一句怎样同时让已登录的浏览器失效（REQ-ACC-001）。区块以后做的时候，[重新生成口令] 的确认里露出这个选项（默认不选）。

**改写了哪条旧文**：P21-8 L355「[重新生成] 口令后所有既有 session 立即失效」→ 默认不失效、换口令时可选「同时让已登录的浏览器失效」（Q-ACC-01 C，用户拍板 2026-10-04）；技术 11 §3.1「已通过的会话不受口令重新生成影响」→ 保留为不选时的行为。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-ACC-007.1 | 集成 | 口令来自库；浏览器 A、B 都已解锁 | A 调 regenerate 并选「同时让已登录的浏览器失效」 | 200，响应里有新口令（只此一次）；B 的下一次请求回到口令门；A 随响应拿到新会话、不被踢出；审计写明选了让已登录的浏览器失效 | 未实现：regenerate 只换口令、不动会话签名密钥（access-passcode.service.ts:63-72，passcode.service.ts:111-118）；契约里没有这个参数（请求体只有 action） |
| AC-ACC-007.2 | 集成 | 同上 | A 调 regenerate、不带这个参数 | 新口令生效、旧口令立即失效；A、B 的会话都仍有效 | 已实现：passcode.service.ts:111-130（会话签名密钥不随口令换） |
| AC-ACC-007.3 | 集成 | 部署配置设了 PASSCODE_COOKIE_SECRET | 调 regenerate 并选这个参数 | 409，原因说签名密钥由部署配置固定、要改变量后重启；口令不变（零副作用） | 未实现（随 AC-ACC-007.1；签名密钥取 PASSCODE_COOKIE_SECRET 优先，passcode.service.ts:156-182） |
| AC-ACC-007.4 | 文档 | — | 读 README「换口令」一节与首次启动的口令横幅 | 都写了怎样同时让已登录的浏览器失效（接口参数；改 PASSCODE_COOKIE_SECRET 后重启）；界面里没有为这一项新造的页面 | 未实现：开机口令横幅还没有（passcode.service.ts:52-61 只打 ENABLED 一行），README 没有这一句 |

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
