---
id: PRD-DEP
title: 启动检查与初始化向导 · 产品需求
type: prd
status: draft
owner: 产品 owner（仓库唯一人类 owner）
domains: [DEP]
flows: [F-DEP-INIT]
applies_to: ">= v0.2.4"
last_verified:
  docs: fd2e1ee
  api: a453bb7
  web: 93f03c5
  date: 2026-10-04
covers:
  - web/src/containers/init/{AppBootGate,InitWizardContainer}.tsx
  - web/src/views/init/{InitWizardShell,ConnectivityCheck,ConnectivityItem,OfflineNotice,PresetImageCheck,SubscriptionSetup,ResourceConfirm,InitErrorPanel}.view.tsx
  - web/src/views/system/ProxyConfigForm.view.tsx（向导第 2 步与系统状态页共用）
  - web/src/hooks/system/{useInitGate,useInitWizard,usePresetImageProvision}.ts
  - web/src/lib/system/{initWizardModel,connectivityVerdict,presetImageChain,subscriptionReadiness,globalBanner}.ts
  - api/apps/api/src/platform/system/{initialization.service,system.controller,system-settings.service}.ts
  - api/apps/api/src/platform/system/diagnostics/{connectivity.probe,checks/outbound-network.check,checks/preset-image.check}.ts
  - api/apps/api/src/platform/system/preset-image/**
supersedes:
  - docs/product/pages/21-8-部署与初始化.md §2（L17-79）、交互链路图（L284-310）、§5 状态矩阵（L373-380）、§7 L402、L407
  - docs/frontend/pages/21-8-部署与初始化.md §2、§5、§6（其中属于产品口径的部分）
drafts:
  - gap/drafts/f-dep-init-01…14.html（说明 gap/drafts/notes/dep.md）
merged_from:
  - gap/product/_parts/dep.md
merged_at: 2026-10-04
review_minutes: 30
---

# 启动检查与初始化向导 · 产品需求

<!-- 本文件只写「做什么 / 为什么 / 怎样算做对」。布局与视觉在稿件（gap/drafts/f-*），实现方法在技术设计。由 gap/product/_build/merge.py 从 _parts 合并生成；改片段后重新运行。「现状」列暂留文件:行出处，入库时按 01 §4.2 换成证据 ID。 -->

## 一屏摘要

- **这一域回答什么**：打开平台之后先挂什么（启动检查、口令门、向导、工作台只挂一个），以及初始化向导的五步——联网检查、代理配置（按需）、沙箱镜像、模型帐号、本机资源——到 [确认，开始使用] 写入、落到欢迎态（REQ-DEP-001–016）。口令门归 ACC、登录面板归 AUTH、镜像下载块归 IMG，本域只写它们在向导里怎么用。
- **五条要守的规则**：
  1. 启动时只挂一个：判定没回来什么都不挂；只有读到「未初始化」才进向导；读不到就放行并明说「无法确认平台状态」（REQ-DEP-001、002）。
  2. 向导不可关闭、只出现一次；只有最后一步 [确认，开始使用] 写入「已初始化」，前面各步的保存都只是存配置（REQ-DEP-003、009、015）。
  3. 只有模型 API 全部「连不上」才算离线，并要用户显式确认；全部只是超时**不得**算离线（REQ-DEP-007、008；与离线横幅 REQ-WB-014 同一条判定）。
  4. 镜像没备齐、模型帐号没配都不拦初始化，但必须说清「在此之前无法发起任何任务」，一屏只说一次（REQ-DEP-012、013）。
  5. 平台自己搬得了的镜像进第 3 步就开始下载到本机；只报真实进度，失败说清停在哪一步、不自动重试（REQ-DEP-011）。
- **现状**：16 条需求里 `已实现` 2 · `部分实现` 2 · `偏离` 12。五步、按需进入的代理配置、自动准备镜像、两种 409 分流都已实现；偏离集中在：超时被当成「连不上」判成离线（前端结论与后端写入门都这样）、口令被拒时先挂工作台再浮口令门（DR-28）、登录面板一展开就开始登录（FE1）、同一句话一屏说两遍与反引号上屏（DR-25）、写入时才发现离线就把写给开发者的原句上屏（Q-DEP-01）。
- **待定**：Q-DEP-01、Q-DEP-02（[open-questions.md](./open-questions.md) §3）；出网代理对镜像下载是否生效见 Q-SYS-16（2026-10-04 已拍板 A：只承诺联网检查；合并时已按此改了第 2、3 步里承诺代理的两句）。

**状态词表**：`已实现`（行为与本文一致）· `部分实现` · `未实现` · `偏离`（实现与本文不同）· `实现先行`（代码已有、原产品文档没写，待确认）· `未核实` · `计划中`（目标版本未到，或待某条待定问题选定后才生效）。「层级」= 最低验证层（单元 / 组件 / 集成 / API / e2e；`文档` = 文档一致性检查，`视觉` = 截图比对）。

## 需求索引

**共 16 条需求、77 条验收标准**：`已实现` 2 · `部分实现` 2 · `偏离` 12。

| 编号 | 需求 | 状态 | 版本 | AC | 稿件 | 待定问题 |
|---|---|---|---|---:|---|---|
| [REQ-DEP-001](#REQ-DEP-001) | 启动检查中：整屏一句，工作台、向导、口令门都不挂 | `已实现` | MVP | 2 | f-dep-init-01 | — |
| [REQ-DEP-002](#REQ-DEP-002) | 判定之后只挂一个：口令门、向导、工作台，或放行并明说读不到 | `偏离` | MVP | 5 | f-dep-init-01、f-dep-init-02 | — |
| [REQ-DEP-003](#REQ-DEP-003) | 向导：外壳之外整屏阻断、不可关闭、只出现一次 | `偏离` | MVP | 5 | f-dep-init-02…14 | — |
| [REQ-DEP-004](#REQ-DEP-004) | 步骤流转：代理配置按需进入、[上一步] 永远回得去、步骤条如实标记 | `偏离` | MVP | 5 | f-dep-init-02、f-dep-init-03、f-dep-init-06、f-dep-init-07、f-dep-init-10 | — |
| [REQ-DEP-005](#REQ-DEP-005) | 联网检查：先显示上次结果（带时刻），没有才自动跑；[重新检测] 节流 | `已实现` | MVP | 5 | f-dep-init-02、f-dep-init-03 | — |
| [REQ-DEP-006](#REQ-DEP-006) | 逐目标结果：分两类、连得上带耗时、超时未响应不等于连不上、提示原文整段 | `部分实现` | MVP | 4 | f-dep-init-03、f-dep-init-04、f-dep-init-05 | — |
| [REQ-DEP-007](#REQ-DEP-007) | 结论与离线判定：只有模型 API 全部「连不上」才算离线 | `偏离` | MVP | 6 | f-dep-init-03、f-dep-init-04、f-dep-init-05 | — |
| [REQ-DEP-008](#REQ-DEP-008) | 离线确认：显式确认才能往下走，确认后留痕 | `部分实现` | MVP | 4 | f-dep-init-05 | — |
| [REQ-DEP-009](#REQ-DEP-009) | 代理配置：只存配置、存完立即重检；失败按码说人话 | `偏离` | MVP | 6 | f-dep-init-06 | [Q-SYS-16](./open-questions.md#Q-SYS-16) |
| [REQ-DEP-010](#REQ-DEP-010) | 沙箱镜像检查：五项各说各的，任一项未通过即止 | `偏离` | MVP | 6 | f-dep-init-07、f-dep-init-08 | — |
| [REQ-DEP-011](#REQ-DEP-011) | 自动准备镜像（下载到本机）：进这一步就开始、只报真实进度、失败说清停在哪一步 | `偏离` | MVP | 5 | f-dep-init-09、f-dep-init-10 | [Q-DEP-02](./open-questions.md#Q-DEP-02) [Q-SYS-16](./open-questions.md#Q-SYS-16) |
| [REQ-DEP-012](#REQ-DEP-012) | 镜像未就绪不拦：可以稍后配置，后果只说一处 | `偏离` | MVP | 2 | f-dep-init-08 | — |
| [REQ-DEP-013](#REQ-DEP-013) | 模型帐号：每个 Agent 一行，至少一个可用才算就绪；同一登录面板就地展开 | `偏离` | MVP | 6 | f-dep-init-11、f-dep-init-12 | — |
| [REQ-DEP-014](#REQ-DEP-014) | 本机资源：偏低不是门；磁盘说可用与总量、构成按档说 | `偏离` | MVP | 5 | f-dep-init-13、f-dep-init-14 | — |
| [REQ-DEP-015](#REQ-DEP-015) | [确认，开始使用]：唯一放行的动作；成功后向导卸载、落到欢迎态 | `偏离` | MVP | 5 | f-dep-init-13、f-dep-init-14 | [Q-DS-31](./open-questions.md#Q-DS-31) |
| [REQ-DEP-016](#REQ-DEP-016) | 写入失败：「初始化没有完成」+ 原因 + [重试]，不放行；两种 409 按码分流 | `偏离` | MVP | 6 | f-dep-init-14 | [Q-DEP-01](./open-questions.md#Q-DEP-01) |

「待定问题」一列链到 [open-questions.md](./open-questions.md)，不回复时按那里写的默认走。

## 与旧文档的对照

由各条「改写了哪条旧文」汇总；旧文档代号见 [README](./README.md#旧文档代号)。逐条的旧文与新口径见每条需求，以及文末附录 A。

| 旧文档 | 被改写的位置 → 本文 | 其中作废 / 删去的 |
|---|---|---|
| P20 核心使用链路 | §2.1 → REQ-DEP-015 | — |
| P21-5 系统状态 | §9 → REQ-DEP-006 | — |
| P21-8 部署与初始化 | L19 → REQ-DEP-001；L19 → REQ-DEP-002；L19 → REQ-DEP-003；L22、L288 → REQ-DEP-005；L22 → REQ-DEP-006；L23 → REQ-DEP-007；L23 → REQ-DEP-008；L26、L25 → REQ-DEP-009；L28 → REQ-DEP-010；L31 → REQ-DEP-011；L32 → REQ-DEP-012；L47、L127-129 → REQ-DEP-013；L68 → REQ-DEP-014；L78 → REQ-DEP-015 | L31（REQ-DEP-011） |
| F21-8 前端·部署与初始化 | §2 → REQ-DEP-003；§5 → REQ-DEP-015；§8 → REQ-DEP-016 | — |

只改写实现现状、试点或稿件口径（不涉及上表旧文档）的需求：REQ-DEP-004。

---

## DEP · 启动检查（F-DEP-INIT）

### REQ-DEP-001 · 启动检查中：整屏一句，工作台、向导、口令门都不挂 {#REQ-DEP-001}

> 状态 `已实现` · 版本 MVP · 来源 F21-8 §2「判定位置」、§5「首载判定：pending 期间渲染骨架而非工作台（防闪现）」；DR-28；实现 AppBootGate.tsx:38-49，useInitGate.ts:14-23 · 稿件 f-dep-init-01

打开平台（任何地址，含深链）后，在 `GET /api/system/init-status` 回来之前，整个应用**必须**只有一屏：画布底，正中一句「正在检查平台初始化状态…」（前缀转圈，role="status"）。此刻**不得**挂工作台、设置页、向导或口令门，也**不得**发它们的请求（项目列表、/events、终端）——先画出一个再换成另一个，用户第一次打开平台看到的就是「进去了又被踢出来」。这条请求**不得**自动重试：它失败只有两种原因（后端没起来、口令门拦下了），重试只会把这一屏多按住几秒。

**改写了哪条旧文**：P21-8 L19「工作台首屏显示向导」→ 先判定、只挂一个（不是在工作台首屏上叠一层向导）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-DEP-001.1 | e2e | init-status 延迟 2 秒才返回 | 打开首页 | 这 2 秒里只有「正在检查平台初始化状态…」（role=status）；DOM 里没有工作台、向导、口令门；没有发项目、任务、事件请求 | 已实现：AppBootGate.tsx:38-49（pending 时不挂 children）（稿件 f-dep-init-01） |
| AC-DEP-001.2 | 组件 | init-status 失败 | — | 只请求一次，不重试 | 已实现：useInitGate.ts:22（retry: false） |

### REQ-DEP-002 · 判定之后只挂一个：口令门、向导、工作台，或放行并明说读不到 {#REQ-DEP-002}

> 状态 `偏离` · 版本 MVP · 来源 DR-28；F21-8 §2「判定位置 / 路由拦截」；实现 AppBootGate.tsx:20-23、:33-36、:51-58，globalBanner.ts:62-77 · 关联 REQ-ACC-003、REQ-WB-003、REQ-WB-014 · 稿件 f-dep-init-01、02

init-status 回来之后，按下面的顺序**只挂一个**：

1. **被口令门拒绝**（REST 401 `PASSCODE_REQUIRED` / `PASSCODE_INVALID`、429 `PASSCODE_LOCKED`）→ 全屏口令门，底下什么都不挂；解锁后**必须**重新跑一次这条判定（REQ-ACC-003）。
2. **`initialized === false`** → 只挂初始化向导。地址原样保留（不 redirect）：完成后显示的就是地址指向的那一页；地址是首页且没有项目时就是欢迎态（REQ-WB-003）。
3. **`initialized === true`** → 工作台（或地址指向的设置页）。
4. **其余失败**（后端 5xx、连不上）→ 放行进工作台，同时出阻断横幅「无法确认平台状态」，说明带失败原因、**不得**说成离线（REQ-WB-014）；**不得**表现成向导——后端没起来时，向导里每个按钮都会失败。

只有明确读到 `initialized === false` 才进向导；读失败（没有数据）**不得**掉进向导。

**改写了哪条旧文**：P21-8 L19「检测 `initialized != true` → 工作台首屏显示向导」→ 只有读到 false 才进向导，读不到就放行并出横幅（实现 AppBootGate.tsx:51-53 的注释，与 globalBanner.ts:62-77 同口径）；口令被拒时「放行、口令门浮在工作台上」→ 只挂口令门（DR-28）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-DEP-002.1 | e2e | initialized=false | 直接打开 /settings/images | 只有向导，地址仍是 /settings/images；完成后显示的是该页，不跳回首页 | 已实现：AppBootGate.tsx:54-58（不 redirect，完成后按当前地址挂 children） |
| AC-DEP-002.2 | 组件 | init-status 返回 401 PASSCODE_REQUIRED | — | 只有全屏口令门；DOM 里没有工作台，也没发它的请求 | 偏离：放行 children，口令门浮在工作台上（AppBootGate.tsx:20-23、:54-58；同 AC-ACC-003.1） |
| AC-DEP-002.3 | 组件 | 口令门 | 解锁成功，重新判定得到 initialized=false | 换成向导 | 部分实现：解锁后重取 init-status（useAccessGate.ts:33-36），但解锁前工作台已经挂过 |
| AC-DEP-002.4 | 组件 | init-status 返回 500 | — | 放行进工作台；横幅「无法确认平台状态」，说明含「（后端返回 500）」、不含「离线」；没有向导 | 已实现：AppBootGate.tsx:54-58、globalBanner.ts:62-77 |
| AC-DEP-002.5 | 组件 | initialized=true | — | 工作台；向导不挂载 | 已实现：AppBootGate.tsx:54-58 |

## DEP · 初始化向导（F-DEP-INIT）

### REQ-DEP-003 · 向导：外壳之外整屏阻断、不可关闭、只出现一次 {#REQ-DEP-003}

> 状态 `偏离` · 版本 MVP · 来源 P21-8 §2 标题「阻塞性」、§7 L402「初始化向导只出现一次」；F21-8 §2「阻塞语义：没有 [取消]、没有 Esc 逃逸」；简报 §5.5；UX-DS-320；Q-DS-24 A；实现 InitWizardShell.view.tsx:1-27、:66-151，InitWizardContainer.tsx:1-8、:54-57 · 稿件 f-dep-init-02…14

向导**必须**在外壳之外整屏渲染（画布底；顶上的品牌行与口令门同一写法），本身是一个模态对话框（role=dialog、aria-modal，名称「平台初始化 · 共 5 步」，描述是页头那句说明），**不得**有关闭按钮，Esc 与点外面**不得**关闭它——关掉之后没有可回去的应用。页头**必须**说清要做什么、哪一步需要离开这一页、之后在哪改，**不得**承诺耗时。每一步都有：步骤条（REQ-DEP-004）、步骤名与一句说明、内容、页脚条（左边一句这一步的结论或后果，右边 [上一步] 与主动作）。第一步没有 [上一步]。初始化完成后向导**不再出现**，此后的配置都在「系统状态」里改。

**改写了哪条旧文**：P21-8 L19、F21-8 §2「在工作台首屏之上以阻塞层渲染」→ 外壳之外整屏（工作台根本不挂，见 REQ-DEP-002）；页头去处「设置 → 系统状态」→「系统状态」（v2 外壳没有「设置」分区，Q-DS-24 A）。步骤 chip 换成步骤条属视觉，归稿件（简报 §5.5）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-DEP-003.1 | e2e | 向导任一步 | 按 Esc；点画布空白 | 向导不关、不变 | 已实现：BlockingDialog 拦下 Esc 与点外面（InitWizardShell.view.tsx:8-13、:66） |
| AC-DEP-003.2 | 组件 | 向导 | 读屏查询 | 一个 role=dialog、aria-modal=true，名称「平台初始化 · 共 5 步」，描述是页头那句说明 | 已实现：InitWizardShell.view.tsx:83-93 |
| AC-DEP-003.3 | 组件 | 第 1 步 / 第 2–5 步 | 渲染页脚 | 第 1 步没有 [上一步]；其余有 | 已实现：InitWizardContainer.tsx:54-57 |
| AC-DEP-003.4 | e2e | 初始化已完成 | 打开任何页面 | 不出现向导 | 已实现：AppBootGate.tsx:54 |
| AC-DEP-003.5 | 组件 | 页头说明、第 5 步页脚句 | 渲染 | 去处写「系统状态」；不含耗时承诺 | 偏离：写的是「设置 → 系统状态」（InitWizardShell.view.tsx:89-90、ResourceConfirm.view.tsx:91） |

### REQ-DEP-004 · 步骤流转：代理配置按需进入、[上一步] 永远回得去、步骤条如实标记 {#REQ-DEP-004}

> 状态 `偏离` · 版本 MVP · 来源 P21-8 L20-26、L50-56「为什么这个顺序」；F21-8 §5「全通过 → nextStep 跳过它，但 Step3 按 [上一步] 仍可回来」；简报 §5.5；实现 initWizardModel.ts:33-133，useInitWizard.ts:345、:481-484，InitWizardShell.view.tsx:26-27、:94-125 · 关联 TC-DEP-004 · 稿件 f-dep-init-02、03、06、07、10

五步固定顺序：联网检查 → 代理配置 → 沙箱镜像 → 模型帐号 → 本机资源。顺序有理由：镜像要先能联网 / 走代理，它的体积又是资源评估里最大的一块；模型帐号是唯一要离开本页的一步，放在平台自己能搞定的事之后，免得设备码在等镜像时过期。

代理配置只在联网检查**有失败项**（连不上或超时未响应）时进入流程：此时第 1 步的 [下一步] 去第 2 步。全部连得上时 [下一步] 跳过它、直接到第 3 步，但它**必须**仍显示在步骤条上（标「（可跳过）」，总步数不变）；第 3 步的 [上一步] **必须**能回到它——「连得上」不等于「够快」，镜像下载中途断掉时，代理配置是唯一的出路（REQ-DEP-011）。

步骤条显示「第 N / 5 步」与五个步骤名，每一格四态：当前（aria-current="step"）、走过且达成（勾）、走过没达成（第 3 / 4 步点了 [稍后配置]：三角，读屏说「走过、没有完成」）、还没走到。不进流程的代理配置**不得**打勾（没配过就不能说配过）。「达成」与那一步自己的判据同一出处（镜像：检查结论就绪；模型帐号：至少一个可用）。

**改写了哪条旧文**：新增「[上一步] 永远回得去代理配置」（实现先行：initWizardModel.ts:108-133，2026-09-14 真机）；「走过 ≠ 达成」（实现先行：initWizardModel.ts:81-91）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-DEP-004.1 | 单元 | 联网全部连得上 | 在第 1 步点 [下一步] | 到第 3 步；步骤条第 2 格「代理配置（可跳过）」、不打勾 | 已实现：initWizardModel.ts:80、:97-106（稿件 f-dep-init-03、07） |
| AC-DEP-004.2 | 单元 | 联网有一项超时未响应 | 在第 1 步点 [下一步] | 到第 2 步；第 2 格不带「（可跳过）」 | 已实现：useInitWizard.ts:345（稿件 f-dep-init-04、06） |
| AC-DEP-004.3 | 单元 | 联网全部连得上，在第 3 步 | 点 [上一步] | 回到第 2 步代理配置，不是第 1 步 | 实现先行：initWizardModel.ts:129-133（TC-DEP-004） |
| AC-DEP-004.4 | 组件 | 在第 3 步点了 [稍后配置，下一步]（镜像未就绪） | 到第 4 步 | 步骤条第 3 格是「走过没达成」（三角 + 读屏「走过、没有完成」），不是勾 | 部分实现：判定已实现（initWizardModel.ts:81-91）；读屏文字没有，图标 aria-hidden（InitWizardShell.view.tsx:111-120） |
| AC-DEP-004.5 | 组件 | 任一步 | 渲染步骤条 | 显示「第 N / 5 步」与五个步骤名；当前那一格 aria-current="step" | 偏离：五个圆角描边 chip，没有「第 N / 5 步」，没有 aria-current（InitWizardShell.view.tsx:94-125；简报 §5.5） |

### REQ-DEP-005 · 联网检查：先显示上次结果（带时刻），没有才自动跑；[重新检测] 节流 {#REQ-DEP-005}

> 状态 `已实现` · 版本 MVP · 来源 F21-8 §5「优先读 init-status 里的上次检测结果直接渲染」「[重新检测] 3s 内不可重复点击」；P21-8 §7 L407「整轮最多自动重试 1 次」；实现 useInitWizard.ts:89-91、:238-266、:304-311，ConnectivityCheck.view.tsx:35-78，connectivityVerdict.ts:106-110、:132-140 · PARAM.INIT_RECHECK_THROTTLE_S · PARAM.INIT_AUTO_CHECK_RUNS · 稿件 f-dep-init-02、03

进第 1 步**必须**直接显示 init-status 里的上次结果，不重跑；结果**必须**带它的时刻：「上次检测：<本地时间>（<多久前>）」，后面注明「（上次检测的结果，进向导不重跑）」或「（本轮刚检测）」。没有时刻时明说「这份结果没有带时刻 —— 无法判断它有多旧，建议点 [重新检测] 跑一轮。」，**不得**静默省略。一条历史都没有（新装）时进来就自动跑一轮：结论句「还没有检查过这台机器能不能联网。」，列表位置「正在检测联网状况…」。

[重新检测] 两次之间至少隔 `PARAM.INIT_RECHECK_THROTTLE_S` 秒，冷却中按钮显示「重新检测（Ns）」并禁用（不是没有理由的置灰）；检测中按钮「检测中…」，各行「检测中…」整轮一起转（后端不逐目标推送）。自动跑的那一轮断了，最多再自动跑一次（合计 `PARAM.INIT_AUTO_CHECK_RUNS` 轮），之后只能由用户点。检测走 /diagnose 的第 ⑤ 项（与系统状态页同一个探测，不新增端点）。

**改写了哪条旧文**：P21-8 L22、L288「自动运行」→ 有历史时不自动跑（F21-8 §8 约束 1，实现）；L288、L407「单项超时 5s」→ `PARAM.DIAG_ITEM_TIMEOUT_MS`（现值 10 秒，P21-5 §9E）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-DEP-005.1 | e2e | init-status 带 14 小时前的结果 | 进向导 | 直接显示这份结果与「上次检测：…（14 小时前）（上次检测的结果，进向导不重跑）」；不发 /diagnose | 已实现：useInitWizard.ts:304-311（稿件 f-dep-init-02） |
| AC-DEP-005.2 | e2e | init-status 没有任何历史 | 进向导 | 自动跑一轮；结果到之前显示「还没有检查过这台机器能不能联网。」与「正在检测联网状况…」 | 已实现：connectivityVerdict.ts:107、ConnectivityCheck.view.tsx:59-62 |
| AC-DEP-005.3 | 组件 | 刚点过 [重新检测] | 3 秒内再点（含同一批次里连点） | 不发第二个请求；按钮显示「重新检测（Ns）」并禁用 | 已实现：useInitWizard.ts:243-251（闸门是 ref，同步打时刻）、ConnectivityCheck.view.tsx:55 |
| AC-DEP-005.4 | 单元 | 自动跑的一轮中断 | — | 再自动跑 1 次；第 2 次也断了不再自动跑 | 已实现：useInitWizard.ts:240-242、:261 |
| AC-DEP-005.5 | 组件 | 历史结果没有时刻 | 渲染 | 「这份结果没有带时刻 —— …建议点 [重新检测] 跑一轮。」 | 已实现：ConnectivityCheck.view.tsx:72-76 |

### REQ-DEP-006 · 逐目标结果：分两类、连得上带耗时、超时未响应不等于连不上、提示原文整段 {#REQ-DEP-006}

> 状态 `部分实现` · 版本 MVP · 来源 P21-5 §9E；Q-DS-21 A；DR-09；实现 connectivityVerdict.ts:72-94，ConnectivityItem.view.tsx:23-50，connectivity.probe.ts:306-356，outbound-network.check.ts:145-147 · PARAM.DIAG_ITEM_TIMEOUT_MS · PARAM.DIAG_TARGET_BUDGET_PCT · 稿件 f-dep-init-03、04、05

每个探测目标一行：目标名 + 类别（「模型 API」/「镜像下载源」——离线判定只看前者，所以这一行上就要分得开）+ 结果。结果三种：「连得上」（带耗时 ms）、「超时未响应」（时钟图标、timeout 色相）、「连不上」（叉、fail 色相）；超时与连不上**不得**同色、同词。单个目标的时限是整项时限 `PARAM.DIAG_ITEM_TIMEOUT_MS` 的 `PARAM.DIAG_TARGET_BUDGET_PCT`%（不低于 1 秒），界面不写死数字。

没通过的那一行**必须**整段显示后端给的提示原文（带着这一次的具体原因与下一步：解析不了 → 配代理；超时 → 重跑看稳不稳定，**不**把「去配代理」当结论；本机镜像站没应答 → 三条不依赖 docker 的路），不截断、不改写；上屏前按定稿词换掉「镜像仓库」（DR-09）。探测目标由已注册的 Agent 申报、由 SANDBOX_DEFAULT_IMAGE 推出，**不得**写死 api.openai.com / ghcr.io。

**改写了哪条旧文**：P21-8 L22「镜像仓库(ghcr.io) ⚠️」→「镜像下载源」（Q-DS-21 A）；P21-5 §9E 前端「⏱ 未在预算内应答 / ❌ 不可达」→「超时未响应 / 连不上」（定稿词）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-DEP-006.1 | 单元 | 一行 ok、latencyMs 182 | 渲染 | 「连得上」+「182ms」 | 已实现：connectivityVerdict.ts:84-87（稿件 f-dep-init-03） |
| AC-DEP-006.2 | 单元 | 一行 timedOut=true | 渲染 | 「超时未响应」，timeout 色相、时钟图标；不出现「连不上」 | 已实现：ConnectivityItem.view.tsx:24、connectivityVerdict.ts:88-90（稿件 f-dep-init-04） |
| AC-DEP-006.3 | 组件 | 一行连不上且带 hint | 渲染 | hint 整段显示、不截断；「镜像仓库」上屏为「镜像下载源」 | 部分实现：整段显示已实现（ConnectivityItem.view.tsx:44-48）；后端句仍写「镜像仓库」（connectivity.probe.ts:111、322 等，DR-09） |
| AC-DEP-006.4 | 单元 | 超时的那一行 | 生成 hint | 说「这不等于连不上」与「重跑一次看它稳不稳定」；只在「每次都这样」时才提代理 | 已实现：connectivity.probe.ts:332-348 |

### REQ-DEP-007 · 结论与离线判定：只有模型 API 全部「连不上」才算离线 {#REQ-DEP-007}

> 状态 `偏离` · 版本 MVP · 来源 P21-8 §1、L23-24；P21-5 §9E「超时 ≠ 够不着，分档按证据强度」；plan F-DEP-INIT（统一 P21-8 L24、L304）；实现 connectivityVerdict.ts:34-41、:62-70、:106-130，initialization.service.ts:89-108，outbound-network.check.ts:79-100 · 关联 REQ-WB-014 · 稿件 f-dep-init-03、04、05

结论句只有一个出处（向导、离线横幅、系统状态共用），**不得**点名具体 Agent 或目标（哪几条没过由逐行结果自己说）。三档：

- **全部连得上**：「联网正常：模型 API 与镜像下载源都连得上。」
- **模型 API 全部连不上**（证据确凿：解析不了、被拒绝、被重置）→ 离线：「当前连不上外网，Agent 将不可用 —— 每个 Agent 都必须能访问自己的模型 API，这是物理约束，不是配置问题。平台其余功能（项目管理、凭证与镜像配置、系统诊断）照常可用。」，并进入 REQ-DEP-008 的离线确认。
- **其余**（只有镜像下载源没过；部分模型 API 没过；模型 API 全部只是**超时**）→ 部分：按没过的是哪一类说——只挂了镜像下载源：「Agent 可用；受影响的只是下载新镜像」；挂了部分模型 API：「依赖它的那个 Agent 可能用不了，其他 Agent 不受影响」；没过的全是超时时再加一句「超时不等于连不上：…重跑一次看它是否稳定。」。模型 API **全部超时**时**不得**宣布离线、**不得**要求离线确认，结论句「模型 API 都超时未响应 —— 这不等于连不上，平台不按离线处理。一条时快时慢的链路会周期性超过这次检查的超时时限，重跑一次看它是否稳定：偶发多半只是慢，可以直接往下走；每次都这样就按不通处理。」（暂行）。

向导的结论、离线横幅（REQ-WB-014）与后端写入门（REQ-DEP-016）**必须**用同一条判定。

**改写了哪条旧文**：P21-8 L23「全部失败 → 明示离线」、L304「模型 API 全失败 → 离线」→ 全部**连不上**才离线，全部超时不算（P21-5 §9E，诊断第 ⑤ 项早已这样分档）。

**合并说明**：WB 域离线横幅（REQ-WB-014）里「判定模型 API 全部不可达」按本条读作「全部连不上」，全部只是超时不出离线横幅。（交叉引用：REQ-WB-014）

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-DEP-007.1 | 单元 | 三行都连得上 | 计算结论 | 「联网正常：…」；没有离线确认 | 已实现：connectivityVerdict.ts:39、:63（稿件 f-dep-init-03） |
| AC-DEP-007.2 | 单元 | 模型 API 都连得上，ghcr.io 超时 | 计算结论 | 「有镜像下载源超时未响应 —— 模型 API 都连得上，Agent 可用；受影响的只是下载新镜像。超时不等于连不上：…」 | 已实现：connectivityVerdict.ts:112-125（稿件 f-dep-init-04） |
| AC-DEP-007.3 | 单元 | 两个模型 API 都 timedOut=true | 计算结论 | 「部分」档、上面那句暂行结论；不宣布离线、不出离线确认 | 偏离：超时被算成失败 → offline，还会驱动离线横幅（connectivityVerdict.ts:38；globalBanner.ts 借同一判定） |
| AC-DEP-007.4 | 集成 | 同 .3，POST /init 没带 acknowledgeOffline | — | 不返回 409 OFFLINE_NOT_ACKNOWLEDGED | 偏离：后端写入门只看 ok（initialization.service.ts:93-94）；诊断第 ⑤ 项已按本条分档（outbound-network.check.ts:79-100） |
| AC-DEP-007.5 | 单元 | 两个模型 API 都解析失败 | 计算结论 | 离线那句；句子里不含 Agent 名与目标名 | 已实现：connectivityVerdict.ts:62-70（稿件 f-dep-init-05） |
| AC-DEP-007.6 | 单元 | 一个模型 API 连不上、一个连得上 | 计算结论 | 「有模型 API 没通过检查 —— 其余模型 API 连得上，所以平台不算断网；但依赖它的那个 Agent 可能用不了，其他 Agent 不受影响。」 | 已实现：connectivityVerdict.ts:126-129 |

### REQ-DEP-008 · 离线确认：显式确认才能往下走，确认后留痕 {#REQ-DEP-008}

> 状态 `部分实现` · 版本 MVP · 来源 P21-8 §1「物理约束」、L23「仍可 [继续]」；F21-8 §5「[继续] 只是确认离线，不翻页」；DR-25；实现 OfflineNotice.view.tsx:31-67，InitWizardContainer.tsx:49-52、:66-67，useInitWizard.ts:445-452、:500-503，initialization.service.ts:89-108 · 关联 REQ-WB-014 · 稿件 f-dep-init-05

判为离线时，结论下面**必须**出离线确认（role=alert）：标题「以离线模式继续」，一句「网络恢复后无需重装，回系统状态页重新检测即可。」，[我知道，继续] 与一句「点它表示你确认在这台机器上 Agent 不可用，仍要完成初始化。」。确认之前 [下一步] 禁用，页脚说「请先在上方确认「以离线模式继续」。」；[我知道，继续] 只是确认、**不**翻页。确认后提示条**不得**消失（用户要看得见自己确认了什么），按钮那一行换成「已确认以离线模式继续 —— 完成初始化后，工作台会常驻一条离线横幅，发起任务的入口会置灰（只置灰、不隐藏）。」，[下一步] 可用。

只有这一下能让写入带上 `acknowledgeOffline: true`；前端**不得**替用户填。离线结论那句只在结论行说一次（DR-25），确认框不再重复。离线不拦初始化：完成后工作台可用、离线横幅常驻、发起入口置灰并说原因（REQ-WB-014）。

**改写了哪条旧文**：P21-8 L23「仍可 [继续]」→ [我知道，继续]（显式确认、不翻页）；离线句一屏出现两次 → 只留一处（DR-25 推荐，确认框换成短标题「以离线模式继续」）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-DEP-008.1 | 组件 | 判为离线、还没确认 | 渲染 | 确认提示条（标题「以离线模式继续」，role=alert）；结论句只在结论行出现一次；[下一步] disabled；页脚那句 | 部分实现：确认框、禁用与页脚句已实现（OfflineNotice.view.tsx、InitWizardContainer.tsx:66-67）；框里第一行是结论句、与结论行重复，没有短标题（DR-25）（稿件 f-dep-init-05） |
| AC-DEP-008.2 | 组件 | 同上 | 点 [我知道，继续] | 提示条留着、换成已确认那句；[下一步] 可用；页脚句消失；仍停在第 1 步 | 已实现：OfflineNotice.view.tsx:45-56、useInitWizard.ts:500-503 |
| AC-DEP-008.3 | 集成 | 确认过离线 / 没确认过 | 第 5 步完成 | 请求体带 / 不带 acknowledgeOffline: true | 已实现：useInitWizard.ts:447-450 |
| AC-DEP-008.4 | 集成 | 写入前后端那一轮判为离线、用户没确认过 | POST /init | 409 OFFLINE_NOT_ACKNOWLEDGED，平台一个字都没写 | 已实现：initialization.service.ts:89-108（前端怎么接见 REQ-DEP-016） |

### REQ-DEP-009 · 代理配置：只存配置、存完立即重检；失败按码说人话 {#REQ-DEP-009}

> 状态 `偏离` · 版本 MVP · 来源 P21-8 L25-26；F21-8 §5「保存代理 → PUT /api/system/settings（只存配置，不放行）→ 再重跑 Step1」；UX-DS-402、DR-33；DR-25；sys-a 核实（保存的代理今天只被联网检查读取，connectivity.probe.ts:170）；实现 ProxyConfigForm.view.tsx:62-104，useInitWizard.ts:358-375、:497，initWizardModel.ts:148-160，InitWizardContainer.tsx:88-124 · 关联 REQ-SYS-060（系统状态页同一张表单）、Q-SYS-16 · PARAM.INIT_RECHECK_THROTTLE_S · 稿件 f-dep-init-06

三个字段 HTTP_PROXY / HTTPS_PROXY / NO_PROXY，从已存配置回填；三个都留空 = 清空代理，只填一项时另外两项不发。[保存并重新检测] 只存配置（PUT /api/system/settings），**不得**结束初始化——放行在最后一步；存成功后立即跑一轮联网检查（与 [重新检测] 共用节流）。保存失败**必须**在按钮之上说「保存失败：<按错误码查的前端句>」（role=alert；超时：「这次请求超时了，可以再试一次。」），**不得**拼后端原始 message。表单说明里的示例串用等宽行内代码，**不得**原样带反引号或 emoji（DR-25、DR-26）。表单下面同时显示联网结果（离线时连同离线确认），让用户看着结果改代理。页脚 [上一步] + [跳过，下一步]；「只保存配置，不会结束初始化」这件事只在按钮旁说一次（DR-25）。

从第 3 步 [上一步] 回到这里、而联网其实全部连得上时，说明句**不得**说「上一步有目标连不上」，改说「联网检查都连得上，不配代理也能往下走；要改代理的话，配好后点 [保存并重新检测]。」（暂行；Q-SYS-16 已拍板 A，「让下载也走代理」进 backlog，做了之后才加回「镜像下载中途断掉时，也可以在这里配一个代理再试」）。

> 注：保存的代理今天只被联网检查读取（sys-a 核实）；预制镜像下载要不要走它见 Q-SYS-16（2026-10-04 已拍板 A：不走，只承诺联网检查；让下载也走代理进 backlog）。所以本步说明句与第 3 步失败时的出路句都不承诺代理（REQ-DEP-011）。

**改写了哪条旧文**：P21-8 L26「→ [重新检测]」→ [保存并重新检测]（只存不放行，F21-8 §5）；P21-8 L25「检测失败时展开」→「有失败项（连不上或超时未响应）时进流程，否则可跳过、仍可经 [上一步] 回来」。

**合并说明**：片段按 img-b 当时的默认（后端让下载走代理）写了两处承诺；合并时按实现与 sys 组推荐统一为「只承诺联网检查」（Q-SYS-16 默认；2026-10-04 用户拍板 A，与此相同），本条与 REQ-DEP-011 一起改了。稿件 f-dep-init-10 的出路句已跟着改（W2 跨组一致性改动 19）；本条改的说明句只在「联网检查都连得上、从 [上一步] 回到代理配置」时出现，现有稿件没有画这一态（f-dep-init-06 画的是「上一步有目标连不上」那一版），不用改稿。（交叉引用：REQ-SYS-060、REQ-IMG-042、REQ-DEP-011）

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-DEP-009.1 | 集成 | 填好三项 | 点 [保存并重新检测] | 发 PUT /api/system/settings，不发 POST /init；成功后自动跑一轮联网检查 | 已实现：useInitWizard.ts:358-375 |
| AC-DEP-009.2 | 单元 | 三个都清空 / 只填 HTTPS_PROXY | 生成请求体 | proxyConfig: null / 只含 httpsProxy | 已实现：initWizardModel.ts:148-160 |
| AC-DEP-009.3 | 组件 | 保存请求超时 | — | 按钮之上「保存失败：这次请求超时了，可以再试一次。」（role=alert）；不显示后端原句 | 偏离：拼的是后端 message（useInitWizard.ts:497、ProxyConfigForm.view.tsx:89-93）（稿件 f-dep-init-06） |
| AC-DEP-009.4 | 组件 | 渲染表单说明 | — | 示例串是等宽行内代码，没有反引号、没有 emoji | 偏离：反引号与 ⚠️ 原样上屏（ProxyConfigForm.view.tsx:84-87，DR-25 / DR-26） |
| AC-DEP-009.5 | 组件 | 联网全部连得上，从第 3 步 [上一步] 回到代理配置 | 渲染 | 说明句不含「上一步有目标连不上」 | 未实现：说明句写死（InitWizardContainer.tsx:93） |
| AC-DEP-009.6 | 组件 | 一轮检测刚开始的 3 秒内 | 渲染 | [保存并重新检测] 禁用并显示「保存并重新检测（3s）」；保存中「保存中…」 | 已实现：ProxyConfigForm.view.tsx:95-98 |

### REQ-DEP-010 · 沙箱镜像检查：五项各说各的，任一项未通过即止 {#REQ-DEP-010}

> 状态 `偏离` · 版本 MVP · 来源 P21-8 L27-37、§2「⇒ 新判据」（L219-261）；P21-5 §9A；F21-8 §7A；Q-DS-21 A（第 N 项）；DR-22、DR-23、DR-25；实现 presetImageChain.ts:30-166、:227-231，PresetImageCheck.view.tsx:96-311，useInitWizard.ts:304-311，InitWizardContainer.tsx:37-47、:136-143 · 稿件 f-dep-init-07、08

进第 3 步、这一轮还没有镜像结论时自动跑一轮（走 /diagnose 的第 ⑧ 项，不新增端点）。五项固定：「该用哪张镜像（没指定 = 平台按你的机器自动选）」「镜像下载源里有没有这张镜像」「来源对不对：是不是平台自己构建的那一张」「平台检查过没有、能不能选用」「有没有下载到本机（只影响首个任务的耗时）」，每行写「第 N 项（共 5 项） · 名称」。

链任一项未通过即止：之前的「通过」，停下的那一项给结论，之后的「未检查」（虚线，**不等于**失败）。检查进行中是「检查中…」（转圈），与「未检查」分开；镜像这一帧到了、整轮还在跑时，停止点之后的几项**必须**已是「未检查」，不随整轮继续转（DR-22）。

未通过的那一项**必须**依次给：结论（一句）、证据、这一项**自己的**修复动作、可粘贴命令 + [复制]（平台自己搬得了时给 [准备镜像]、不给命令，见 REQ-DEP-011）、错误码；**不得**合成一句「镜像不可用」。动作与命令以后端为准（带着这台机器上的真实坐标），前端句子只兜底；通过的那一项**不得**再给动作（DR-23）。第 5 项「没下载到本机」是「提示」，不是警告——镜像仍算就绪。

检查还没出结论时 [下一步] 禁用，页脚说「镜像检查完成后才能继续。」；结论一到，再按结果给 [下一步] 或 [稍后配置，下一步]（DR-25）。流断了：「镜像检查中断：这一轮没有拿到结论，可点 [重新检测] 重跑。」，[重新检测] 可点。

**改写了哪条旧文**：P21-8 L28「配了没有 → registry 里有没有 → 是不是平台自建的那张 → 注册进来没有 → 本机 staged 没有」→ 定稿名称与「第 N 项（共 5 项）」（Q-DS-21 A）；检查中时页脚已给跳过 → 先禁用（DR-25）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-DEP-010.1 | e2e | 进第 3 步，第 ⑧ 项结论还没到 | 渲染 | 5 行「检查中…」；[下一步] 禁用，页脚「镜像检查完成后才能继续。」 | 偏离：页脚已是 [稍后配置，下一步] 与跳过警告（InitWizardContainer.tsx:138-143，DR-25）（稿件 f-dep-init-07） |
| AC-DEP-010.2 | 单元 | 帧报停在 registry、status fail | 生成模型 | 第 1 项通过；第 2 项未通过（结论 + 证据 + 动作 + 命令 + 错误码）；第 3–5 项未检查 | 已实现：presetImageChain.ts:129-160（稿件 f-dep-init-08） |
| AC-DEP-010.3 | 组件 | 镜像帧已到、其他检查还在跑 | 渲染 | 停止点之后显示「未检查」，不转圈 | 偏离：按整轮 isChecking 转圈（PresetImageCheck.view.tsx:41-46，DR-22） |
| AC-DEP-010.4 | 组件 | 任一行 | 渲染标题 | 「第 N 项（共 5 项） · 名称」 | 偏离：写的是「第 N 步（共 5 步）」（PresetImageCheck.view.tsx:134，Q-DS-21 A） |
| AC-DEP-010.5 | 单元 | 后端给了 command / 没给 | 生成 | 用后端那条 / 未通过时才用兜底；通过与提示的项不给命令、不给动作 | 已实现：presetImageChain.ts:146-150、:227-231 |
| AC-DEP-010.6 | 组件 | 点 [复制] | 剪贴板可用 / 不可用 | 轻提示「已复制」/「复制失败，请手动选中命令复制」 | 已实现：InitWizardContainer.tsx:37-47 |

### REQ-DEP-011 · 自动准备镜像（下载到本机）：进这一步就开始、只报真实进度、失败说清停在哪一步 {#REQ-DEP-011}

> 状态 `偏离` · 版本 MVP · 来源 P21-8 L33-48、L219-261（够得着就自己搬；进这一步且搬得了 ⇒ 自动开始；不加自动重试；失败不许把向导卡住）；Q-DS-21 A（下载到本机）；Q-SYS-16（已拍板 A，2026-10-04）；实现 InitWizardContainer.tsx:27-32，presetImageChain.ts:185-193，usePresetImageProvision.ts:13-139，PresetImageCheck.view.tsx:176-278，system.controller.ts:225-262 · 关联 REQ-IMG-040–042（镜像页同一块） · 待裁决 Q-DEP-02 · 稿件 f-dep-init-09、10

第 5 项是「提示：镜像还没下载到本机」，而且后端说平台自己搬得了（带搬运计划）时，进这一步**必须**自动开始（只自动开一次：失败之后、重新渲染、离开再回来都不再自动开）。块里先说代价：为什么能搬，「<来源> → <去向> · 约 N MB」（给不出体积只说来源，**不得**写「0 MB」）。

进行中：[准备中…]（转圈、禁用）；进度条 + 行尾百分比；下面一行「<阶段>：<后端那句>」与「已用时 m 分 s 秒」。阶段名「看这台机器够不够得着镜像 / 下载 / 校验完整性 / 装载镜像 / 放到位」，阶段句里**不得**再拼百分比。后端这一帧给不出分母时画进度未知（不画停在某处的假条），并说「进度未知（后端这一帧给不出分母）——期间数字没变不代表卡死，正在持续写入。」；已用时是真实挂钟，照常走。

完成后**必须**重跑镜像检查，由检查结论宣布就绪（这一块自己不说「好了」——两个真相源会打架）。失败：不再画条，留最后一句阶段文案（停在哪一步）、失败原因（role=alert）与一句出路「多半是网速：镜像下载源够得着、但拉得太慢，中途就断了。换个网络环境后再点 [准备镜像] 重试；也可以先点 [下一步]，初始化完成后在「镜像管理」里再下载。」（按钮名照屏上：第 5 项是「提示」时镜像算就绪，页脚主按钮是 [下一步]，REQ-DEP-010；Q-SYS-16 已拍板 A，「让下载也走代理」进 backlog，做了之后才改回「回上一步「代理配置」填一个代理再试」）；[准备镜像] 恢复可点，**不得**自动重试（没有断点续传，重试只会让失败时的等待翻倍）。整个过程**不阻塞**向导：[下一步] / [稍后配置，下一步] 与 [重新检测] 全程可用。

**改写了哪条旧文**：P21-8 L31「按之后带进度、可取消」→ 不提供取消（实现没有取消入口；不阻塞向导，离开这一步下载照常进行；Q-DEP-02 默认 A）；L41「`已下载 245 MB / 约 320 MB · 77%`」→ 百分比只在行尾，阶段句不拼（与镜像页同一口径，REQ-IMG-041）；「铺开 / staged」→「下载到本机」；出路里的「设置 → 系统状态 → 出网代理」→「系统状态 → 出网代理」。

**合并说明**：出路句按 Q-SYS-16（2026-10-04 已拍板 A）改为不承诺代理，与镜像页（REQ-IMG-042）同一口径；初始化之后再下载的入口是镜像管理的预制镜像卡（REQ-IMG-040）。（交叉引用：REQ-IMG-042、REQ-IMG-040、REQ-DEP-009）

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-DEP-011.1 | e2e | 第 5 项提示且 provisionable | 进第 3 步 | 不等用户点就开始；离开再回来不再开第二次 | 已实现：InitWizardContainer.tsx:32、usePresetImageProvision.ts:133-139 |
| AC-DEP-011.2 | 组件 | 进行中，progress=0.37 | 渲染 | 条到 37%、行尾「37%」；阶段句不含「· 37%」；已用时每秒走 | 偏离：阶段句拼了百分比（usePresetImageProvision.ts:85-88），百分比另起一行等宽（PresetImageCheck.view.tsx:223-231）（稿件 f-dep-init-09） |
| AC-DEP-011.3 | 组件 | progress=null | 渲染 | 进度未知那一句；不画百分比和停住的条；已用时照走 | 已实现：PresetImageCheck.view.tsx:215-222 |
| AC-DEP-011.4 | 组件 | 搬运失败 | 渲染 | 留最后一句阶段文案 + 失败原因（role=alert）+ 出路；[准备镜像] 可点；不自动重试 | 部分实现：已实现（usePresetImageProvision.ts:93-104、PresetImageCheck.view.tsx:250-278）；出路句仍让人「回上一步「代理配置」填一个代理再试」、路径写「设置 → 系统状态 → 出网代理」（PresetImageCheck.view.tsx:271-273），按 Q-SYS-16（2026-10-04 已拍板 A）要换成上面那句不承诺代理的写法（合并后补记）（稿件 f-dep-init-10） |
| AC-DEP-011.5 | 集成 | 搬运完成 | — | 重跑镜像检查；第 5 项转通过后才说就绪 | 已实现：usePresetImageProvision.ts:95-98、InitWizardContainer.tsx:27-32 |

### REQ-DEP-012 · 镜像未就绪不拦：可以稍后配置，后果只说一处 {#REQ-DEP-012}

> 状态 `偏离` · 版本 MVP · 来源 P21-8 L30-32（不阻塞，但明示「在此之前无法发起任何任务」）；F21-8 §5、§7A ③；DR-25；实现 presetImageChain.ts:99-100、:161-166，InitWizardContainer.tsx:136-143，PresetImageCheck.view.tsx:302-311 · 稿件 f-dep-init-08

镜像检查有一项未通过（未就绪）时向导**不拦**，主动作是 [稍后配置，下一步]。卡内**必须**有一句拦截说明（role=alert）：「在此之前无法发起任何任务：预制镜像还没就绪。可以 [稍后配置] 继续完成初始化，平台能进、项目能建，但新建任务会被直接拒绝。修好后回系统状态页重跑诊断即可。」——这是向导里唯一「放行了但功能不可用」的地方，不说出来，用户会在写完指令、点下发起的那一刻才发现。这句话一屏只说一次（页脚不再重复，DR-25），[稍后配置，下一步] 用 aria-describedby 指向它。点了之后步骤条第 3 格标「走过没达成」（REQ-DEP-004）。

**改写了哪条旧文**：P21-8 L32「⚠️ 这一步不阻塞：允许 [稍后配置] 继续」不变；卡内与页脚各说一次 → 只留卡内（DR-25）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-DEP-012.1 | 组件 | 第 2 项未通过 | 渲染 | 卡内拦截说明一处（role=alert）；页脚没有同义句；主按钮「稍后配置，下一步」且 aria-describedby 指向那句 | 偏离：卡内与页脚各说一次，按钮没有关联（InitWizardContainer.tsx:139-143、PresetImageCheck.view.tsx:302-311）（稿件 f-dep-init-08） |
| AC-DEP-012.2 | e2e | 同上 | 点 [稍后配置，下一步] | 到第 4 步；步骤条第 3 格「走过没达成」 | 已实现（判定）：initWizardModel.ts:81-91 |

### REQ-DEP-013 · 模型帐号：每个 Agent 一行，至少一个可用才算就绪；同一登录面板就地展开 {#REQ-DEP-013}

> 状态 `偏离` · 版本 MVP · 来源 P21-8 L50-66、§2.1（L80-145）；FE1 / TC-AUTH-002；DR-32；DR-25；Q-DS-21 A（模型帐号）；实现 SubscriptionSetup.view.tsx:63-141，subscriptionReadiness.ts:20-48，InitWizardContainer.tsx:166-222，useInitWizard.ts:189-195、:508 · 关联 REQ-AUTH-001、REQ-AUTH-003、REQ-AUTH-008 · 稿件 f-dep-init-11、12

每个已注册的 Agent 一行：名称、打码身份（有的话）、状态（已配置 / 凭证已过期 / 未配置；即将过期算已配置）与动作——未配置 [去配置]，已过期 [重新授权]，已配置**不给动作**（它没有下一步了）。判据是「**至少一个**可用」：有一个就算达成，主动作 [下一步]；一个都没有时主动作 [稍后配置，下一步]，卡内一句拦截说明「跳过后平台能进、项目能建，但在配好至少一个模型帐号之前无法发起任何任务 —— Agent 需要它才能调用模型。」（一屏只说一次，DR-25）。开头一句「配好任意一个就能开始 —— 不用全部配。」**不得**写死 Agent 的个数（Agent 是开放注册表）。

[去配置] / [重新授权] 在那一行里就地展开同一个登录面板（REQ-AUTH-001：向导里不带一次性说明与 [管理所有凭证]），行尾按钮变 [收起]。面板先停在空闲态，点 [开始帐号登录] 才开始（REQ-AUTH-003；空闲态第二句去掉「或关掉弹层」）；成功后面板停在「已连上」再收起，那一行变已配置，判据随之更新（REQ-AUTH-008）。Agent 列表读不到：「读不到 Agent 列表 —— 无法判断凭证状态。可以先跳过，之后在凭证管理页配置。」（role=alert）；一个 Agent 都没有注册：「平台一个 Agent 都没有注册 —— 这不该发生，去系统状态页看看。」。

**改写了哪条旧文**：P21-8 L47「Step 4 · 订阅配置」→「模型帐号」（Q-DS-21 A）；L52「◉ 帐号授权（推荐）○ API Key」单选 → 登录面板的两个标签（REQ-AUTH-001）；P21-8 L127-129「面板展开时就 begin」→ 点了才开始（FE1，归 REQ-AUTH-003）；卡内开头「Agent 用你自己的模型帐号跑。」与步骤说明重复 → 去掉（DR-25）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-DEP-013.1 | 单元 | Codex active、Claude Code expired | 生成模型 | 达成；Codex 无动作、Claude Code [重新授权]；没有拦截说明 | 已实现：subscriptionReadiness.ts:28-48、SubscriptionSetup.view.tsx:104-121（稿件 f-dep-init-12） |
| AC-DEP-013.2 | 单元 | 某 Agent credentialStatus=expiring | 生成模型 | 算已配置 | 已实现：subscriptionReadiness.ts:46 |
| AC-DEP-013.3 | 组件 | 两个都未配置 | 点 Codex [去配置] | 那一行里展开面板，停在空闲态（只有 [开始帐号登录]），不发 begin；行尾变 [收起] | 偏离：面板一挂上就 begin（AuthGateContainer.tsx:136-141，同 REQ-AUTH-003）（稿件 f-dep-init-11） |
| AC-DEP-013.4 | 组件 | 一个都没配 | 渲染 | 拦截说明只在卡内一处；主按钮「稍后配置，下一步」aria-describedby 指向它 | 偏离：卡内与页脚各说一次（InitWizardContainer.tsx:176-180、SubscriptionSetup.view.tsx:131-139，DR-25） |
| AC-DEP-013.5 | 组件 | /api/runtimes 失败 | 渲染 | 「读不到 Agent 列表 —— …」（role=alert）；可以跳过 | 已实现：InitWizardContainer.tsx:182-185 |
| AC-DEP-013.6 | e2e | 在面板里登录成功 | — | 「已连上」停留后收起；那一行变「已配置」+ 打码身份；主按钮变 [下一步]；拦截说明消失 | 部分实现：刷新与收起已实现（useRuntimeAuthPanel.handleSuccess），「已连上」停留没有（REQ-AUTH-008，DR-21） |

### REQ-DEP-014 · 本机资源：偏低不是门；磁盘说可用与总量、构成按档说 {#REQ-DEP-014}

> 状态 `偏离` · 版本 MVP · 来源 P21-8 L67-78、§7 L397-400；DR-25；Q-DS-21 A（本机资源）；实现 initWizardModel.ts:166-270，ResourceConfirm.view.tsx:26-96，useInitWizard.ts:174-179、:350、:510 · PARAM.SCHED_RESERVED_PCT · PARAM.INIT_LOW_CPU_CORES · PARAM.INIT_LOW_RAM_GB · PARAM.INIT_LOW_DISK_FREE_GB · 稿件 f-dep-init-13、14

三行：CPU（核数 · 当前负载）、内存（总量 · 已用比例）、磁盘（「可用 X / 总 Y（已用 Z%，<数据目录>）」——两个数都给：只给总量会让人以为宽裕，只给可用又对不上系统里看到的数）。每行「正常 / 偏低」：CPU 少于 `PARAM.INIT_LOW_CPU_CORES` 核、内存少于 `PARAM.INIT_LOW_RAM_GB` GB、**可用**磁盘少于 `PARAM.INIT_LOW_DISK_FREE_GB` GB 为偏低。偏低**不是门**：一句「仍可继续 —— 当前这台机器的资源偏低（…），建议加上去之后再正式投入使用；现在就用也行，只是同时能跑的任务更少、镜像下载到本机更慢。」（「仍可继续」前置，role=status），[确认，开始使用] 照常可点。

磁盘那一行下面一句构成：预制镜像、沙箱环境自己的镜像缓存、每个任务一份工作区副本——量级按当前默认的沙箱环境档说，档位未知时只说构成、不说数字（**不得**挑一档当默认）。预留一句：「平台会留出总容量的 <PARAM.SCHED_RESERVED_PCT>% 不拿去跑任务：内存最多能分出 …、磁盘 … —— 磁盘还要与当前可用的 … 取小。」（比例取接口，界面不写死）。向导里没有进度条，步骤说明与预留那句**不得**提进度条（DR-25）。资源读不到：「读不到本机资源占用 —— 这不代表资源充足，只代表这一项没查出来。仍可继续初始化，装好后可在系统状态页再看。」（role=alert），**不得**渲染成 0% 或空。

**改写了哪条旧文**：P21-8 L68「检测到 CPU 8 核 / RAM 16G / 磁盘：可用 62G / 总 200G（预留 15%）」→ 三行 + 预留一句（比例取接口）；L70「显示黄色 ⚠️（"当前资源配置较低，建议增加…"）」→「仍可继续」前置的那句（实现 initWizardModel.ts:250-256）；「资源池确认」→「本机资源」。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-DEP-014.1 | 单元 | 可用磁盘 38 GB | 生成模型 | 磁盘偏低；偏低那句以「仍可继续」开头，含「可用磁盘 38 GB（建议 ≥ 50 GB）」 | 已实现：initWizardModel.ts:212、:245、:256（稿件 f-dep-init-13） |
| AC-DEP-014.2 | 组件 | 偏低 | 渲染 | [确认，开始使用] 可点 | 已实现：ResourceConfirm.view.tsx:84-88 |
| AC-DEP-014.3 | 单元 | 默认档未知 | 生成磁盘构成句 | 只说构成、不说数字 | 已实现：initWizardModel.ts:196-198 |
| AC-DEP-014.4 | 组件 | /api/system/resources 失败 | 渲染 | 「读不到本机资源占用 —— …」（role=alert）；不显示 0% | 已实现：ResourceConfirm.view.tsx:34-40 |
| AC-DEP-014.5 | 单元 | 渲染步骤说明与预留一句 | — | 都不含「进度条」 | 偏离：InitWizardContainer.tsx:231、initWizardModel.ts:264（DR-25） |

### REQ-DEP-015 · [确认，开始使用]：唯一放行的动作；成功后向导卸载、落到欢迎态 {#REQ-DEP-015}

> 状态 `偏离` · 版本 MVP · 来源 P21-8 L78「→ [确认，开始使用] → 写 initialized=true → 进入冷启动建项目引导」；F21-8 §5「[确认，开始使用] → POST /api/system/init → AppBootGate 放行」；简报 §5.5；Q-DS-31 A；实现 ResourceConfirm.view.tsx:84-93，useInitWizard.ts:386-397、:432-452，initialization.service.ts:50-77 · 关联 REQ-WB-003 · PARAM.DIAG_ITEM_TIMEOUT_MS · 稿件 f-dep-init-13、14

[确认，开始使用] 是整个向导里**唯一**会写入「已初始化」的按钮（POST /api/system/init）；前面各步的保存都只是存配置。它是第 5 步页脚条的主动作，左边一句「点它才算装完 —— 这一步只做一次，之后要改任何配置都在「系统状态」里。」。请求在途：按钮「正在完成…」并禁用（写入前后端会再跑一轮联网检查，最长约 `PARAM.DIAG_ITEM_TIMEOUT_MS`）。请求**不得**自动重试（一次性、非幂等，自动重试只会制造 409）。

成功：向导整棵卸载（不留步骤条、遮罩，也不出「初始化完成」类提示），第一屏按地址渲染——首页且没有项目时就是欢迎态，焦点落到主区标题（REQ-WB-003）。写入请求**不**带代理（第 2 步已存过，后端不动已存的那份）；只有用户确认过离线时才带 `acknowledgeOffline: true`（REQ-DEP-008）。

**改写了哪条旧文**：P21-8 L78「进入冷启动建项目引导（P20 §2.1）」→ 欢迎态两张入口卡（Q-DS-31 A，REQ-WB-002 / 003）；F21-8 §5「Step4 [确认，开始使用]」→ 第 5 步（五步编号）；主按钮从内容区挪到页脚条（简报 §5.5，视觉归稿件）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-DEP-015.1 | e2e | 第 5 步，实例里没有项目 | 点 [确认，开始使用]，写入成功 | 向导卸载；第一屏是欢迎态；没有「初始化完成」提示 | 部分实现：卸载已实现；第一屏是一句话，不是欢迎态（同 AC-WB-003.3） |
| AC-DEP-015.2 | 组件 | 请求在途 | 渲染 | 按钮「正在完成…」并禁用 | 已实现：ResourceConfirm.view.tsx:86-87 |
| AC-DEP-015.3 | 集成 | 写入请求体 | — | 不含 proxyConfig；acknowledgeOffline 只在确认过时为 true | 已实现：useInitWizard.ts:445-452 |
| AC-DEP-015.4 | 组件 | 第 5 步 | 渲染页脚 | [确认，开始使用] 在页脚条右端，那句「点它才算装完…」在左；壳上不再另有 [下一步] | 偏离：按钮与旁注在内容区，页脚只有 [上一步]（ResourceConfirm.view.tsx:84-93、InitWizardContainer.tsx:232）（稿件 f-dep-init-13） |
| AC-DEP-015.5 | 集成 | POST /init 网络错误 | — | 不自动重试 | 已实现：useInitWizard.ts:433（retry: 0） |

### REQ-DEP-016 · 写入失败：「初始化没有完成」+ 原因 + [重试]，不放行；两种 409 按码分流 {#REQ-DEP-016}

> 状态 `偏离` · 版本 MVP · 来源 F21-8 §5「保存失败 → InitErrorPanel 就地人话原因 + [重试]，不放行（阻塞语义）」；10 §6.8（ALREADY_INITIALIZED / OFFLINE_NOT_ACKNOWLEDGED 两个码）；UX-DS-402；实现 InitErrorPanel.view.tsx:18-33，useInitWizard.ts:386-428、:524-528，initialization.service.ts:50-108 · 关联 TC-DEP-004 · 待裁决 Q-DEP-01 · 稿件 f-dep-init-14

写入失败**必须**停在向导：「已初始化」还是 false，这时放进工作台，下次刷新会被弹回向导，而中间做过的事有没有存下来谁也说不清。卡内最后（主按钮之上）出错误提示（role=alert）：「初始化没有完成」+ 这一次的原因 + [重试]（在途时「重试中…」，主按钮同时「正在完成…」）。按错误码分流：

- **409 `ALREADY_INITIALIZED`**（已经初始化过了，比如另一个标签页先完成了）→ 直接放行，不出错误——目标状态已经达成。
- **409 `OFFLINE_NOT_ACKNOWLEDGED`**（写入前那一轮检测发现模型 API 全部连不上，而用户没确认过离线）→ **不**放行；原因按码换成前端句「刚才这一轮联网检查发现模型 API 全部连不上：回第 1 步重新检测，确认以离线模式继续后再完成。」+ [回到联网检查]（回第 1 步并自动重跑一轮；暂行，Q-DEP-01 默认 A）；**不得**原样显示后端句（里面的「带 acknowledgeOffline: true」是写给开发者的）。
- **认不出的 409**（旧版后端两种情况共用一个码）→ 重读一次 init-status：已初始化才放行，否则按失败处理；**不得**「认不出就放行」。
- **其余失败** → 原因用后端信封的 message（它本身是人话，带着这一次的具体原因，如「写入失败：数据目录只读（/srv/agent-platform/data）。请检查挂载权限后重试。」）；拿不到信封（网络断开）时用前端句「网络请求失败，平台没收到这次写入。检查网络后再点 [重试]。」（暂行），**不得**上屏「Failed to fetch」这类原始串。

**改写了哪条旧文**：F21-8 §8 约束 3 原文「409 = 已初始化 ⇒ 放行」→ 两个码分流（实现 useInitWizard.ts:399-428）；OFFLINE_NOT_ACKNOWLEDGED 的后端句原样上屏 → 按码给前端句与回去的路（本片新增）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-DEP-016.1 | 组件 | POST /init 返回 500「写入失败：数据目录只读（…）」 | — | 停在第 5 步；「初始化没有完成」+ 原因 + [重试]（role=alert） | 已实现：InitErrorPanel.view.tsx、InitWizardContainer.tsx:241-243（稿件 f-dep-init-14） |
| AC-DEP-016.2 | 集成 | 409 ALREADY_INITIALIZED | — | 放行；不出错误面板 | 已实现：useInitWizard.ts:405-408（TC-DEP-004） |
| AC-DEP-016.3 | 集成 | 409 OFFLINE_NOT_ACKNOWLEDGED | — | 不放行；前端句 + [回到联网检查]；点它回第 1 步并重跑一轮（结果离线时出离线确认） | 偏离：后端 message 原样上屏，没有回去的按钮（useInitWizard.ts:409-414、initialization.service.ts:96-107）（TC-DEP-004） |
| AC-DEP-016.4 | 集成 | 409 code=INVALID_STATE（旧后端） | — | 重读 init-status：initialized=true 才放行；false 或读失败 → 错误面板 | 已实现：useInitWizard.ts:415-427 |
| AC-DEP-016.5 | 组件 | 点 [重试] | 在途 | [重试]「重试中…」、[确认，开始使用]「正在完成…」都禁用 | 已实现：InitErrorPanel.view.tsx:28-30、ResourceConfirm.view.tsx:86-87 |
| AC-DEP-016.6 | 组件 | 网络断开，POST /init 抛 TypeError | — | 原因是前端句，不出现「Failed to fetch」 | 偏离：退到 Error.message 原样上屏（useInitWizard.ts:524-528） |

---

## 附录 A · 改写对照（逐条，来自各片段）

### 改写对照（旧文 → 本片）（dep）

| 旧文 | 位置 | 改写为 | 依据 |
|---|---|---|---|
| P21-8 L19「检测 initialized != true → 工作台首屏显示向导」 | REQ-DEP-001、002 | 先判定、只挂一个；只有读到 false 才进向导，读不到放行并出横幅 | 实现 AppBootGate.tsx、DR-28 |
| P21-8 L22、L288「Step1 自动运行」 | REQ-DEP-005 | 有历史时直接显示、不自动跑；没有历史才跑 | F21-8 §8 约束 1、实现 |
| P21-8 L288、L407「单项超时 5s」 | REQ-DEP-005、006 | `PARAM.DIAG_ITEM_TIMEOUT_MS`（现值 10 秒），单个目标 70% | P21-5 §9E、ADR-0101 |
| P21-8 L22「镜像仓库(ghcr.io) ⚠️」 | REQ-DEP-006 | 「镜像下载源」；结果三种「连得上 / 超时未响应 / 连不上」 | Q-DS-21 A |
| P21-8 L23「全部失败 → 明示离线」、L304「模型 API 全失败 → 离线」 | REQ-DEP-007 | 模型 API 全部**连不上**才离线，全部超时不算 | P21-5 §9E、plan F-DEP-INIT |
| P21-8 L23「仍可 [继续]」 | REQ-DEP-008 | [我知道，继续]：显式确认、不翻页；离线句只说一次 | F21-8 §5、DR-25 |
| P21-8 L25-26「检测失败时展开，否则可跳过；→ [重新检测]」 | REQ-DEP-004、009 | 有失败项（含超时）才进流程；[保存并重新检测] 只存不放行；[上一步] 永远回得去 | F21-8 §5、实现 |
| P21-8 L28「配了没有 → registry → 是不是平台自建 → 注册 → staged」 | REQ-DEP-010 | 定稿名称、「第 N 项（共 5 项）」 | Q-DS-21 A |
| P21-8 L31「按之后带进度、可取消」 | REQ-DEP-011 | 不提供取消，下载不阻塞向导 | 实现；Q-DEP-02 |
| P21-8 L41「已下载 245 MB / 约 320 MB · 77%」 | REQ-DEP-011 | 百分比只在行尾，阶段句不拼 | 与 REQ-IMG-041 同口径 |
| P21-8 L47「订阅配置」、L52「◉ 帐号授权 ○ API Key」 | REQ-DEP-013 | 「模型帐号」；同一登录面板的两个标签 | Q-DS-21 A、REQ-AUTH-001 |
| P21-8 L67「Step 5 · 资源池确认」、L70「黄色 ⚠️ 当前资源配置较低」 | REQ-DEP-014 | 「本机资源」；「仍可继续」前置的那句 | Q-DS-21 A、实现 |
| 实现第 5 步「上面的进度条分母仍然是总容量」「进度条的分母仍然是总容量」 | REQ-DEP-014 | 不提进度条（向导里没有） | DR-25 |
| P21-8 L78「→ 进入冷启动建项目引导」 | REQ-DEP-015 | 欢迎态两张入口卡 | Q-DS-31 A、REQ-WB-003 |
| F21-8 §8 约束 3「409 = 已初始化 ⇒ 放行」 | REQ-DEP-016 | 两个码分流；认不出的 409 重读 init-status | 10 §6.8、实现 |
| 向导里「设置 → 系统状态」（页头、第 5 步、第 3 步失败出路） | REQ-DEP-003、011、015 | 「系统状态」/「系统状态 → 出网代理」 | Q-DS-24 A |
| 第 3 / 4 步卡内拦截框 + 页脚同一句；第 2 步表单旁注 + 页脚同义句；第 1 步离线句两次 | REQ-DEP-008、009、012、013 | 一屏只说一次 | DR-25 |

## 附录 B · 片段里的默认决定与待确认（原文）

> 下面是各片段的原文，编号仍是片段里的本地编号；统一编号与完整的选项、推荐、默认在 [open-questions.md](./open-questions.md)，对照见其 §7。

### 待裁决（dep）

#### Q-DEP-01 · 写入时才发现离线，怎么接

- **为什么要问**：POST /init 在写入前会再跑一轮联网检查（initialization.service.ts:63-72）。用户在第 1 步看到的是「连得上」，走到第 5 步时网断了（或模型 API 那一轮全部连不上），写入就会 409 `OFFLINE_NOT_ACKNOWLEDGED`。现状把后端那句原样放进错误面板——里面写着「带 acknowledgeOffline: true 明确以离线模式继续」，用户无从照做；[重试] 只会再 409 一次；唯一的出路是自己想到回第 1 步、点 [重新检测]、确认离线、再走回来。
- **A（本片默认）**：按码给前端句「刚才这一轮联网检查发现模型 API 全部连不上：回第 1 步重新检测，确认以离线模式继续后再完成。」+ [回到联网检查]（回第 1 步并自动重跑一轮）。只改前端。
- **B**：错误面板里就地给离线确认（同 REQ-DEP-008 那块），确认后直接带 acknowledgeOffline 重试。少走一步，但用户没看到这一轮的逐行结果就确认了离线。
- **C**：后端写入时不再复检，只信向导第 1 步的结论（前端把那一轮的结论随请求带上）。改后端契约；第 1 步的结果可能已经旧了。
- **不回复时默认**：A。REQ-DEP-016 第 2 条与 AC-DEP-016.3 按 A 写；选 B / C 时改这两处。

#### Q-DEP-02 · 准备镜像要不要能取消

- **为什么要问**：P21-8 L31 写「按之前先说清代价…，按之后带进度、可取消」；实现没有取消入口（usePresetImageProvision.ts 只在重新开始时掐掉旧流），后端 provision 流也没有取消语义（system.controller.ts:225-262）。2026-09-10 的裁决把它改成「进这一步就自动开始」，可取消这一句没有跟着定。
- **A（本片默认）**：不做取消。理由：下载不阻塞向导，用户可以直接 [下一步] / [稍后配置，下一步]，下载在后台照常进行；失败可以再点 [准备镜像]；取消一个半截的大下载没有断点续传，只是把字节白拉一遍。改写 P21-8 L31。
- **B**：加 [取消]（前端掐流 + 后端停止搬运、清理半截字节、不留注册记录）。代价是后端要加取消语义，并处理「推了一半的 tag」。
- **不回复时默认**：A。REQ-DEP-011 按 A 写；选 B 时 REQ-DEP-011 加一条「进行中有 [取消]，取消后块回到 [准备镜像]、第 5 项仍是提示」并补稿。

### 本片的默认决定与待确认（dep）

1. **编号**：plan 草拟「约 10 条 / 24 条 AC」；按实现与旧文拆成 16 条 / 77 条（段 001–019 内），稿件头注释已按本片编号写。REQ-DEP-017–019 留空。
2. **全部超时不算离线**（REQ-DEP-007）：按 plan 与 P21-5 §9E 定口径。要改三处才一致：前端 `connectivityVerdict`（向导结论与离线横幅共用）、后端 `assertOfflineAcknowledged`；诊断第 ⑤ 项早已这样做。离线横幅随之变化，wb 组 REQ-WB-014 的「最近一次联网检查判定模型 API 全部不可达」要按「连不上」读。全部超时那句结论是本片新写的暂行句。
3. **DR-25 的五处去重**（离线句、拦截说明 ×2、代理旁注、卡内开头一句）、检查中禁用 [下一步]、不提进度条、去掉反引号：都按 BACKLOG DR-25「不回复按推荐修」写；去重时留信息更全的那一处。离线确认框因此换成短标题「以离线模式继续」（页脚那句本来就这样称呼它）。
4. **步骤条与主按钮位置**（「第 N / 5 步」+ 细进度条、[确认，开始使用] 挪到页脚条）：按简报 §5.5；属视觉，稿件已标「需看稿」。AC-DEP-004.5、AC-DEP-015.4 只写可测的那一半（有「第 N / 5 步」与 aria-current；主按钮在页脚条）。
5. **代理配置的说明句**（AC-DEP-009.5）与 **写入时网络错误的前端句**（AC-DEP-016.6）是本片新写的暂行句；按 UX-DS-402 / DR-33 的口径（按码说人话），P3 错误文案表落地时统一。
6. **代理对镜像下载生效**依赖 IMG-B-Q3（img-b，默认 A）。默认 A 不成立时，REQ-DEP-009 的注与 REQ-DEP-011 的出路句一起改成不承诺代理。**已拍板（2026-10-04，用户原话「补全 10 条按推荐」）**：并入 Q-SYS-16，选 A「只承诺联网检查」——正是本条「默认 A 不成立」那一支，REQ-DEP-009 的注与 REQ-DEP-011 的出路句合并时已改成不承诺代理；让下载也走代理进 backlog。
7. **f-dep-init-12 的「Claude Code 凭证已过期」**：首次启动的机器上少见（v1 g8-12 的示例），保留作「至少一个可用」的判据示例；原型里经场景「凭证：Claude Code 帐号登录已过期」到达。

## 附录 C · 参数（待登记 params.yaml）

### 新增参数（待并入 params.yaml）（dep）

| id | 值 | 单位 | kind | 含义 | used_by | 代码落点（pattern） |
|---|---:|---|---|---|---|---|
| PARAM.INIT_RECHECK_THROTTLE_S | 3 | 秒 | product | 向导里 [重新检测] / [保存并重新检测] 两次之间的最短间隔 | REQ-DEP-005、REQ-DEP-009 | web/src/hooks/system/useInitWizard.ts `RECHECK_THROTTLE_MS = ([\d_]+)`（scale 0.001） |
| PARAM.INIT_AUTO_CHECK_RUNS | 2 | 轮 | product | 一次进向导最多自动跑几轮检测（首轮 + 自动重试 1 次），之后只能用户点 | REQ-DEP-005、REQ-DEP-010 | 同文件 `MAX_AUTO_RUNS = (\d+)` |
| PARAM.INIT_LOW_CPU_CORES | 2 | 核 | product | CPU 少于它，第 5 步标「偏低」 | REQ-DEP-014 | web/src/lib/system/initWizardModel.ts `LOW_CPU_CORES = (\d+)` |
| PARAM.INIT_LOW_RAM_GB | 4 | GiB | product | 内存总量少于它标「偏低」 | REQ-DEP-014 | 同文件 `LOW_RAM_BYTES = (\d+) \* 1024 \*\* 3` |
| PARAM.INIT_LOW_DISK_FREE_GB | 50 | GiB | product | **可用**磁盘少于它标「偏低」（判可用量，不判总量） | REQ-DEP-014 | 同文件 `LOW_DISK_AVAILABLE_BYTES = (\d+) \* 1024 \*\* 3` |
| PARAM.DIAG_TARGET_BUDGET_PCT | 70 | % of PARAM.DIAG_ITEM_TIMEOUT_MS | impl-first | 联网检查单个目标的时限占整项时限的比例（不低于 1 秒）；POST /init 写入前那一轮直接用整项时限（initialization.service.ts:66-67，不经这一折算） | REQ-DEP-006 | api/apps/api/src/platform/system/diagnostics/checks/outbound-network.check.ts `checkBudgetMs \* (0\.\d+)`（scale 100） |

沿用已有参数：`PARAM.DIAG_ITEM_TIMEOUT_MS`（used_by 加 REQ-DEP-005、006、015；过期副本另加 docs P21-8 L288「单项超时 5s」、L407「单项检测超时 5s」）、`PARAM.SCHED_RESERVED_PCT`（used_by 加 REQ-DEP-014）、`PARAM.AUTH_SUCCESS_HOLD_MS`（经 REQ-AUTH-008 用于 REQ-DEP-013）。

## 附录 D · 边界、覆盖对照、待核实与连带更正

### 测试用例关联更正（04-示例用例.md 里的拟定编号）（dep）

| 用例 | 原关联 | 改为 | 说明 |
|---|---|---|---|
| TC-DEP-004 | 「AC 待 21-8」 | REQ-DEP-004（AC .3）、REQ-DEP-016（AC .2–.4） | 代理步可回退 = AC-DEP-004.3；两种 409 可区分 = AC-DEP-016.2–.4 |
| TC-CMP-002、TC-CMP-003 | REQ-DEP-010（拟） | 不在本片（部署形态需求，建议放 REQ-DEP-020 起） | 本片的 REQ-DEP-010 是沙箱镜像检查，拟定号撞号 |
| TC-DEP-001、TC-DEP-002 | REQ-DEP-020（拟） | 不在本片（保留拟定号，P1 部署域重建时定） | README 照抄、镜像内容冒烟属部署形态 |
| TC-DEP-003 | REQ-DEP-030（拟） | 不在本片（同上） | .env 装载属部署形态 |
| TC-PLT-003 | REQ-DEP-0xx（拟） | 不在本片 | 配置 fail-fast 属平台启动 |

## 附录 E · 合并时改动的地方

合并只做了下面这些改动；其余文字都是片段原文（本地待定编号已换成统一编号）。

| 需求 | 改动 | 为什么 |
|---|---|---|
| [REQ-DEP-007](#REQ-DEP-007) | 加合并说明 | 离线判定与 REQ-WB-014 统一 |
| [REQ-DEP-009](#REQ-DEP-009) | 改写一句 | 说明句不再承诺代理能救镜像下载（Q-SYS-16 默认） |
| [REQ-DEP-009](#REQ-DEP-009) | 改写一句 | 注里的默认按合并后的 Q-SYS-16 改写 |
| [REQ-DEP-009](#REQ-DEP-009) | 加合并说明 | 出网代理作用范围按 Q-SYS-16 默认统一 |
| [REQ-DEP-011](#REQ-DEP-011) | 改写一句 | 出路句不再承诺代理；初始化后的入口按 REQ-IMG-040 指到镜像管理；按钮名按 W2 一致性写 [下一步]（与稿件 f-dep-init-10 同句） |
| [REQ-DEP-011](#REQ-DEP-011) | 改写一句 | AC-DEP-011.4 现状补记：实现的出路句仍承诺代理（与 Q-SYS-16 默认的差距，impl-gaps §2 已列） |
| [REQ-DEP-011](#REQ-DEP-011) | 加合并说明 | 与 REQ-IMG-042 统一 |
