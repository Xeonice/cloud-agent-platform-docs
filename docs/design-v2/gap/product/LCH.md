---
id: PRD-LCH
title: 发起任务 · 产品需求
type: prd
status: draft
owner: 产品 owner（仓库唯一人类 owner）
domains: [LCH]
flows: [F-LCH-FORM, F-LCH-STARTUP]
applies_to: ">= v0.2.4"
last_verified:
  docs: fd2e1ee
  api: a453bb7
  web: 93f03c5
  date: 2026-10-04
covers:
  - web/src/containers/sandbox/{SandboxTerminalContainer,SandboxLifecycleContainer,NewTaskDeepLinkContainer}.tsx
  - web/src/views/sandbox/{NewSandboxPanel,SandboxStartupProgress}.view.tsx
  - web/src/lib/sandbox/{sandboxLifecycle,sandboxErrorCopy,instanceStartupCopy,runtimeInstallProgress}.ts
  - web/src/hooks/sandbox/{useSandboxLifecycle,useCreateSandbox}.ts
  - web/src/hooks/_shared/useDeepLinkModal.ts
  - web/src/containers/workbench/WorkbenchContainer.tsx、web/src/views/workbench/WorkbenchShell.view.tsx（发起入口、任务树）
  - api/packages/modules/sandbox/src/application/sandbox-application.service.ts（create / admit / destroy）
  - api/packages/modules/sandbox/src/domain/value-objects/sandbox-status.vo.ts
  - api/packages/contracts/src/schemas/sandbox.schema.ts（CreateSandboxSchema、SandboxDtoSchema）
  - web/src/hooks/image/useImages.ts、api/packages/contracts/src/schemas/image.schema.ts（新建任务的「镜像」字段，2026-10-04 拍板 Q-LCH-03 B 后纳入）
supersedes:
  - docs/product/pages/21-2-发起任务向导.md（全篇的产品规则：§1–§9）
  - docs/product/20-核心使用链路.md §3.1–§3.3、§4.2「记住上次选择」，§8.1 L381–394、§8.2 L410 / L417–419、§8.3 L429、§8.5 L446 中与发起相关的行
  - docs/product/21-页面信息架构与交互.md L11、L38–46、L67、L115 中与发起、准备中相关的部分
  - docs/product/22-异常场景与产品补充要求.md §1 L10、§1.1（补 BRANCH_NOT_FOUND）、§2「发起 Task 阶段」L67–71
drafts:
  - gap/drafts/f-lch-form-01…09.html、gap/drafts/f-lch-startup-01…06.html（说明 gap/drafts/notes/lch-a.md）
merged_from:
  - gap/product/_parts/lch-a.md
merged_at: 2026-10-04
review_minutes: 35
---

# 发起任务 · 产品需求

<!-- 本文件只写「做什么 / 为什么 / 怎样算做对」。布局与视觉在稿件（gap/drafts/f-*），实现方法在技术设计。由 gap/product/_build/merge.py 从 _parts 合并生成；改片段后重新运行。「现状」列暂留文件:行出处，入库时按 01 §4.2 换成证据 ID。 -->

## 一屏摘要

- **这一域回答什么**：怎样发起一个任务——新建任务弹层（项目、Agent、凭证闸门、分支、镜像、指令、加载与失败、深链）与受理之后的启动流程（创建中 → 准备中四阶段 → 可能卡住 / 取消并删除 → 运行中或结果卡；任务上看得到所用镜像），REQ-LCH-001–017。
- **五条要守的规则**：
  1. 弹层里不嵌套建项目、也不嵌套注册镜像；「项目」只能选就绪的，未就绪的置灰并按状态写原因（REQ-LCH-001，原因句同 REQ-PRJ-016）；「镜像」可选、默认平台预制镜像，已禁用 / 验证没通过的置灰写原因（REQ-LCH-004）。
  2. 平台没有默认 Agent，必须手选；凭证闸门点了才展开登录面板，选中单选不起任何登录（REQ-LCH-002、003）。
  3. 指令只活在弹层的局部状态里：不进 URL、不进任何存储；同步失败放回，受理或关弹层即清空（REQ-LCH-005、007、009、010）。
  4. 门口拒绝（零副作用）与创建失败按后端信封的 `sideEffectFree` 分两条路，**不得**按 HTTP 状态码推断（REQ-LCH-007）。
  5. 进度放主区不放弹层；卡住只提示并给「取消并删除」出口，平台不自动处置（REQ-LCH-011–014）。
- **现状**：17 条需求里 `已实现` 1 · `部分实现` 10 · `未实现` 3 · `偏离` 3。弹层、启动进度卡、深链大体已实现；缺 v2 的「项目」下拉与「镜像」字段、任务上看不出用的是哪张镜像（SandboxDto 不回显，REQ-LCH-017）、树上准备中 / 可能卡住的行、卡住提示与「取消并删除」（web 没有入口；后端对 starting 之前的任务 DELETE 返回 500）。指令长度三处数法不同（Q-LCH-01），展示格会先打勾再回退（Q-LCH-02）。
- **待定**：Q-LCH-01…06（[open-questions.md](./open-questions.md)）。其中 Q-LCH-03 已于 2026-10-04 拍板 B（新建任务加可选「镜像」字段：REQ-LCH-004 改写、REQ-LCH-017 新增，[重新发起] 预填镜像见 REQ-SBX-003）；同日拍板的 Q-SBX-02 B、Q-SYS-01② A 也落在 REQ-LCH-014、015。

**状态词表**：`已实现`（行为与本文一致）· `部分实现` · `未实现` · `偏离`（实现与本文不同）· `实现先行`（代码已有、原产品文档没写，待确认）· `未核实` · `计划中`（目标版本未到，或待某条待定问题选定后才生效）。「层级」= 最低验证层（单元 / 组件 / 集成 / API / e2e；`文档` = 文档一致性检查，`视觉` = 截图比对）。

## 需求索引

**共 17 条需求、68 条验收标准**：`已实现` 1 · `部分实现` 10 · `未实现` 3 · `偏离` 3。

| 编号 | 需求 | 状态 | 版本 | AC | 稿件 | 待定问题 |
|---|---|---|---|---:|---|---|
| [REQ-LCH-001](#REQ-LCH-001) | 打开弹层：八个入口、「项目」字段与预选 | `部分实现` | MVP | 5 | f-lch-form-01 | [Q-DS-29](./open-questions.md#Q-DS-29) |
| [REQ-LCH-002](#REQ-LCH-002) | Agent 必选、没有默认 | `部分实现` | MVP | 4 | f-lch-form-01、f-lch-form-02 | — |
| [REQ-LCH-003](#REQ-LCH-003) | 凭证闸门：只看凭证状态拦，点了才展开登录 | `已实现` | MVP | 3 | f-lch-form-02、f-auth-panel-01…07 | — |
| [REQ-LCH-004](#REQ-LCH-004) | 分支与镜像：都可选；分支跟随项目，镜像默认平台预制镜像；读不到只降级 | `部分实现` | MVP | 10 | f-lch-form-01、f-lch-form-05、f-lch-form-07、f-lch-form-10 | [Q-LCH-03](./open-questions.md#Q-LCH-03) |
| [REQ-LCH-005](#REQ-LCH-005) | 任务指令：可选、上限 `PARAM.TASK_PROMPT_MAX`、超出就地说 | `部分实现` | MVP | 3 | f-lch-form-02、f-lch-form-03 | [Q-LCH-01](./open-questions.md#Q-LCH-01) |
| [REQ-LCH-006](#REQ-LCH-006) | 弹层自己的加载与加载失败 | `偏离` | MVP | 3 | f-lch-form-04、f-lch-form-05 | — |
| [REQ-LCH-007](#REQ-LCH-007) | 同步失败留在弹层：门口拒绝与创建失败（含资源不够） | `偏离` | MVP | 6 | f-lch-form-06、f-lch-form-07 | [Q-LCH-03](./open-questions.md#Q-LCH-03) [Q-SYS-02③](./open-questions.md#Q-SYS-02) [Q-SYS-17](./open-questions.md#Q-SYS-17) |
| [REQ-LCH-008](#REQ-LCH-008) | 这台机器开不了终端：只说事实和去处 | `偏离` | MVP | 2 | f-lch-form-08 | — |
| [REQ-LCH-009](#REQ-LCH-009) | 深链打开、刷新与回落 | `部分实现` | MVP | 4 | f-lch-form-09 | [Q-DS-29](./open-questions.md#Q-DS-29) [Q-DS-35①](./open-questions.md#Q-DS-35) |
| [REQ-LCH-010](#REQ-LCH-010) | 提交：创建中不可关，受理即关 | `部分实现` | MVP | 3 | f-lch-startup-02 | — |
| [REQ-LCH-011](#REQ-LCH-011) | 受理之后：树里出现准备中行，主区是启动进度卡 | `部分实现` | MVP | 3 | f-lch-startup-03、f-lch-startup-01 | — |
| [REQ-LCH-012](#REQ-LCH-012) | 启动四阶段、已等待与长等待说明 | `部分实现` | MVP | 4 | f-lch-startup-03、f-lch-startup-04 | [Q-LCH-02](./open-questions.md#Q-LCH-02) |
| [REQ-LCH-013](#REQ-LCH-013) | 可能卡住：提示与出口 | `未实现` | MVP | 5 | f-lch-startup-05、f-lch-startup-01 | — |
| [REQ-LCH-014](#REQ-LCH-014) | 取消并删除：二次确认，任何准备阶段都删得掉 | `未实现` | MVP | 4 | f-lch-startup-06 | [Q-SBX-02](./open-questions.md#Q-SBX-02) [Q-SBX-03](./open-questions.md#Q-SBX-03) |
| [REQ-LCH-015](#REQ-LCH-015) | 启动的三种结局：运行中 / 异常 / 超时未响应 | `部分实现` | MVP | 2 | P1、f-sbx-relaunch-01、f-sbx-relaunch-02 | [Q-LCH-03](./open-questions.md#Q-LCH-03) [Q-SYS-01②](./open-questions.md#Q-SYS-01) |
| [REQ-LCH-016](#REQ-LCH-016) | 刷新恢复与计时锚点 | `部分实现` | MVP | 2 | 无单独稿 | — |
| [REQ-LCH-017](#REQ-LCH-017) | 看得到这个任务用的是哪张镜像：启动进度卡、结果卡、复制诊断信息 | `未实现` | MVP | 5 | f-lch-startup-03、f-lch-startup-04、f-lch-startup-05、f-sbx-relaunch-01、f-sbx-relaunch-02、f-sbx-stopstart-02、f-sbx-stopstart-04 | [Q-LCH-03](./open-questions.md#Q-LCH-03) |

「待定问题」一列链到 [open-questions.md](./open-questions.md)，不回复时按那里写的默认走。

## 与旧文档的对照

由各条「改写了哪条旧文」汇总；旧文档代号见 [README](./README.md#旧文档代号)。逐条的旧文与新口径见每条需求，以及文末附录 A。

| 旧文档 | 被改写的位置 → 本文 | 其中作废 / 删去的 |
|---|---|---|
| P20 核心使用链路 | L101、L85–89 → REQ-LCH-001；L168 → REQ-LCH-002；L414 → REQ-LCH-003；L115、L122–124 → REQ-LCH-004；L140、L393 → REQ-LCH-007；L116 → REQ-LCH-008；L429 → REQ-LCH-009；L126、L136、L417 → REQ-LCH-010；L389–392 → REQ-LCH-011；L137 → REQ-LCH-012；L140 → REQ-LCH-015 | L168（REQ-LCH-002） |
| P21 页面信息架构与交互 | L98 → REQ-LCH-004；L11 → REQ-LCH-009；L46 → REQ-LCH-011；L39–40 → REQ-LCH-012；L115 → REQ-LCH-013；L67 → REQ-LCH-014 | — |
| P22 异常场景与产品补充要求 | L10、L67、§1.1 L28 / L39–46 → REQ-LCH-007；L14 → REQ-LCH-012；L71、L69 → REQ-LCH-013；L71 → REQ-LCH-014；L72 → REQ-LCH-016 | — |
| P21-1 工作台 | L94 → REQ-LCH-011 | — |
| P21-2 发起任务向导 | L53、L11、L232 → REQ-LCH-001；L183 / L199 / L230、L226 → REQ-LCH-002；L7、L188 → REQ-LCH-003；L98 → REQ-LCH-005；§5 → REQ-LCH-006；L148、L192 → REQ-LCH-007；L92–93 → REQ-LCH-008；L1 → REQ-LCH-009；L113、L205 → REQ-LCH-010；L117–131 → REQ-LCH-011；L119–131 与 L231、L120 / L122 / L127 → REQ-LCH-012；L128–129 / L144 / L151 / L233、L126 / L157 / L191 → REQ-LCH-013；L157 → REQ-LCH-014；L192、L159 / L207 → REQ-LCH-015；L119–131 → REQ-LCH-017 | L53（REQ-LCH-001）；L183 / L199 / L230（REQ-LCH-002） |
| P21-4 镜像管理 | L30 / L244、L34 → REQ-LCH-004 | — |
| P21-6 项目管理 | L11 → REQ-LCH-001 | L11（REQ-LCH-001） |
| F21-2 前端·发起任务向导 | §9.0 → REQ-LCH-001；L124 → REQ-LCH-002 | L124（REQ-LCH-002） |

---

## LCH · 新建任务弹层（F-LCH-FORM）

### REQ-LCH-001 · 打开弹层：八个入口、「项目」字段与预选 {#REQ-LCH-001}

> 状态 `部分实现` · 版本 MVP · 来源 P20 L85–89（入口三处）、L101（项目归属）、L381、L410、L438；P21-2 L11、L26、L53、L90–91、L200–201、L225、L232；P21-6 L11；F21-2 N.0（L328–341）、L123；Q-DS-29 默认 A（plan.md「要拍板」）；Q-DS-27 A（⌘K）、Q-DS-28 A（项目总览「新建 ⌄」）；DR-16、DR-39、DR-40；原型评审 F3；实现 WorkbenchContainer.tsx:276–287、:378–380，WorkbenchShell.view.tsx:495–521、:575–587，SandboxTerminalContainer.tsx:67–75、:425–436 · 关联 REQ-SBX-003（重新发起预选）、REQ-WB-030（⌘K）、REQ-AUTH-001 · 稿件 f-lch-form-01

新建任务是一个弹层（不占路由）。下列入口**必须**打开同一个弹层：顶栏 [新任务]；项目总览 [新建 ⌄] 的「新任务…」；任务树空组与项目卡上的「发起第一个任务」；工作台空态；已停止结果卡的 [发起新任务]；异常结果卡的 [重新发起]（REQ-SBX-003）；⌘K 的「新任务…」；深链（REQ-LCH-009）。

弹层字段栈第一格是「项目」下拉（Q-DS-29 A）：默认 = 打开时所在的项目（从项目里的入口打开就是那个项目；从总览或 ⌘K 打开且没有当前项目时 = 左侧树里第一个就绪项目）；选项 = 全部项目，顺序同左侧树（当前项目置顶）；克隆中 / 克隆失败的项目**必须**置灰不可选，名称后写原因「（克隆中）」「（克隆失败）」；**不得**放「＋ 新建项目…」——两个新建弹层彼此独立、不嵌套（P20 §8.4）。副标题与第一句引导句跟着所选项目变：「在「X」中发起」。改选项目时已选的 Agent、镜像与已写的指令保留，分支回到默认（分支属于项目，镜像不属于项目）。

没有可发起的项目时，入口**不得**打开弹层：顶栏 [新任务] 与总览入口置灰并能说出原因（离线时离线原因优先；否则「先在左侧选中一个项目」，或按项目状态分两句：克隆中「项目还在克隆，克隆完成后可发起」、克隆失败「克隆失败的项目不能发起任务：先重试克隆或改为空项目」（同 REQ-PRJ-016））；克隆中 / 克隆失败项目的空组与项目卡**不出**「发起第一个任务」，那里是它们自己的处置（F-PRJ-CLONE）。

页脚条固定在弹层底部：左 [取消]、右 [发起任务并打开终端]（唯一的主按钮）；正文超高时正文内部滚动，主按钮始终可见（DR-40）。不可发起时主按钮用「能聚焦、能说原因」的禁用（`aria-disabled` + `aria-describedby` 指向原因句），不是原生 `disabled`（DR-39、原型评审 F3）。Esc / 点遮罩 / [取消] / 右上「关闭」= 关弹层（创建中除外，REQ-LCH-010），关掉即清空指令。

**改写了哪条旧文**：P20 L101「弹窗内不放项目下拉…只读回显」与 F21-2 N.0 → 「可以选项目，但不嵌套建项目」（Q-DS-29 A；F21-2 L340 自己写了「若你要保留下拉行，这条推翻即可」）；P21-2 L53「项目上下文条 [切换]」、L90–91 / L200–201 / L225「选项 = 全部项目 +『＋ 新建项目…』，建完回确认步、表单值不丢」、P21-6 L11「确认步项目行『＋ 新建项目…』」→ 删掉「＋ 新建项目…」与回程保值（`wizardData` / `wizardReturn` 已是死值，F21-2 L123）；P20 L85–89「入口三处」与 P21-2 L11 → 上面八个入口；P21-2 L232「无选中项目时向导不可进入」→ 「没有可发起的项目时入口置灰并说原因」。

**合并说明**：片段原文这里沿用了现行实现的一句「项目尚未就绪（克隆完成后可发起）」，与 REQ-PRJ-016 冲突——对克隆失败的项目这句不成立（P22 L46）。合并时按 REQ-PRJ-016 统一为两句。另：离线模式下弹层主按钮同样置灰并说「离线模式：需连接网络才能发起任务」，规则在 REQ-WB-014（AC-WB-014.5）。（交叉引用：REQ-PRJ-016、REQ-WB-014）

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-LCH-001.1 | e2e | 在 acme-web 的任务里 | 点顶栏 [新任务] | 弹层打开，项目 = acme-web，副标题「在「acme-web」中发起」，主按钮因未选 Agent 不可发起 | 部分实现：入口在侧栏底部 [＋ 新任务]（WorkbenchShell.view.tsx:575–584），副标题已实现（SandboxTerminalContainer.tsx:432–434）；v2 顶栏入口、总览入口、⌘K 未实现（稿件 f-lch-form-01） |
| AC-LCH-001.2 | 组件 | 弹层已打开 | 展开「项目」下拉 | 列出全部项目、顺序同树；acme-api「（克隆失败）」、infra-scripts「（克隆中）」置灰不可选；没有「＋ 新建项目…」 | 未实现：弹层没有项目字段，归属继承左侧树选中项（SandboxTerminalContainer.tsx:67–75），Q-DS-29 A 带来的前端新增（稿件 f-lch-form-01） |
| AC-LCH-001.3 | 组件 | 项目 = acme-web、已选 codex、已选镜像 ml-agent、已写指令 | 改选 docs-site | 副标题与引导句变成「在「docs-site」中发起」；codex、ml-agent 与指令保留；分支回到默认、选项换成 docs-site 的 | 未实现（同上） |
| AC-LCH-001.4 | e2e | infra-scripts 克隆中、acme-api 克隆失败、docs-site 就绪且没有任务，三组都展开 | 看三个空组 | 只有 docs-site 出「发起第一个任务」，点了打开弹层并预选 docs-site | 偏离：空组按钮对任何 0 任务的组都渲染、不看就绪（WorkbenchShell.view.tsx:495–521），对未就绪项目点了会进入幽灵态（见本片「待核实」1） |
| AC-LCH-001.5 | 组件 | 任一不可发起的状态（未选 Agent、闸门在场、开不了终端、指令超长） | 用 Tab 移到主按钮并按下 | 主按钮能聚焦，读屏念出原因，按下不发请求 | 偏离：原生 `disabled`，Tab 到不了、不说原因（NewSandboxPanel.view.tsx:478–485） |

### REQ-LCH-002 · Agent 必选、没有默认 {#REQ-LCH-002}

> 状态 `部分实现` · 版本 MVP · 来源 P20 L130（唯一必须决策的是 runtime）、L168；P21-2 L183、L199、L226、L230；F21-2 L124、L501；Q-DS-21 A（上屏词「Agent」）；实现 SandboxTerminalContainer.tsx:83–85、:197–212，NewSandboxPanel.view.tsx:176–177、:219、:249–281 · 稿件 f-lch-form-01、02

Agent 列表来自平台注册表（`GET /api/runtimes`），一项一行：Agent id（等宽）+「— 名称（厂商）」。平台**没有**默认 Agent：打开时**不得**预选，也**不得**记住上一次的选择；没选时组内一句「请选择一个 Agent —— 平台没有默认 Agent，必须你来指定」（这是待办提示，不是错误，不用 `role="alert"`），主按钮不可发起。注册表一个 Agent 都没有时，组内一句「平台上一个 Agent 都没有注册，现在发不了任务。」，不给重试（与读取失败区分，REQ-LCH-006）。选了凭证有效的 Agent 时组内一句「将以 <打码身份> 身份运行」（REQ-LCH-003）。组标题写「Agent · 必选」，`runtime` 这个内部词不上屏。

**改写了哪条旧文**：P20 L168「记住上次选择：上次用过的 runtime 默认高亮（persist）」、P21-2 L183 / L199 / L230「上次选择高亮、persist 到下次」、F21-2 L124「`lastUsedRuntime`（下次预选）」→ 删掉（按实现与 F21-2 L501：注册表顺序只是注册顺序，不表达默认，SandboxTerminalContainer.tsx:198–211）；P21-2 L226「Step 1 未选中 runtime 时 [下一步] 置灰」→ 本条（单弹窗一屏，按钮是 [发起任务并打开终端]）；实现组标题「Agent（runtime）· 必选」→「Agent · 必选」（Q-DS-21 A）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-LCH-002.1 | 组件 | 注册表有 codex、claude-code | 打开弹层 | 两项都未选；组内「请选择一个 Agent —— 平台没有默认 Agent，必须你来指定」，没有 `role="alert"`；主按钮不可发起 | 已实现：NewSandboxPanel.view.tsx:275–281、:191 |
| AC-LCH-002.2 | 集成 | 上一次用 codex 发起过任务 | 再打开弹层 | 仍是两项都未选 | 已实现：每次挂载 `pickedRuntime = null`（SandboxTerminalContainer.tsx:85），没有 `lastUsedRuntime` 持久化 |
| AC-LCH-002.3 | 组件 | 注册表为空 | 打开弹层 | 「平台上一个 Agent 都没有注册，现在发不了任务。」，没有重试按钮 | 已实现：NewSandboxPanel.view.tsx:249–253 |
| AC-LCH-002.4 | 组件 | 任意 | 读组标题 | 「Agent · 必选」 | 偏离：「Agent（runtime）· 必选」（NewSandboxPanel.view.tsx:219） |

### REQ-LCH-003 · 凭证闸门：只看凭证状态拦，点了才展开登录 {#REQ-LCH-003}

> 状态 `已实现` · 版本 MVP · 来源 P20 §5（L96–107、L386–388、L414–416）；P21-2 形态 B（L69–83）、L184–189、L228；FE1（01 §3.2）；DR-21、DR-40；实现 SandboxTerminalContainer.tsx:214–306、:440–444、:463–469，NewSandboxPanel.view.tsx:284–294、:459–463，hooks/credential/useRuntimeAuthPanel.ts · 关联 REQ-AUTH-001–008（登录面板本体，凭证组）· 稿件 f-lch-form-02（凭证有效这一支）；闸门折叠 / 展开各态见 f-auth-panel-01…07

闸门拦不拦只看所选 Agent 的凭证状态（服务端下发的 `credentialStatus`），前端不自己记：

- 有效（`active`）：不出闸门，组内一句「将以 <打码身份> 身份运行」；
- 即将过期（`expiring`）：**不拦**，同一句后面加「（凭证即将到期，建议尽快重新授权）」；
- 未配置（`none`）：组下一句「<Agent 名> 还没有配置凭证，配置好才能发起任务。」+ [配置凭证]；
- 已过期（`expired`）：「<Agent 名> 的凭证已过期，重新授权后才能发起任务。」+ [重新授权]。

闸门在场时，弹层底部还**必须**有一句「先完成上面的 <Agent 名> 登录，才能发起任务。」，主按钮不可发起并指向这两句。选中单选这个动作**不得**发起任何登录：只有点了 [配置凭证] / [重新授权] 才在原地展开登录面板（凭证页、初始化向导共用的那一份，REQ-AUTH-001）；改选别的 Agent = 收起面板并取消进行中的登录。登录成功后闸门消失、身份句出现、主按钮解禁，面板里的「已连上」停留到用户看见（DR-21）。

**改写了哪条旧文**：P21-2 L7「仅该 runtime 首次配置时插入拦截面板」、L184「选中 runtime 无生效凭证 → 一次性全局登录面板」、P20 L414「选 runtime（仅一次）→ 鉴权拦截面板」→ 选中只出闸门句与按钮，点了才展开（FE1；2026-09-24 实测「点三下单选堆出 3 个会话」，SandboxTerminalContainer.tsx:234–245）；P21-2 L188「配置完成 2s 后自动进确认步」→ 停留到用户看见（DR-21）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-LCH-003.1 | 集成 | Claude Code 两种凭证都未配置 | 选中 claude-code | 闸门句 +[配置凭证]；底部「先完成上面的 Claude Code 登录，才能发起任务。」；没有向服务端发起任何登录请求 | 已实现：SandboxTerminalContainer.tsx:256–278，NewSandboxPanel.view.tsx:459–463（稿件 f-auth-panel-01） |
| AC-LCH-003.2 | 组件 | Codex 凭证即将过期 | 选中 codex | 不拦；「将以 a***@example.com 身份运行（凭证即将到期，建议尽快重新授权）」 | 已实现：SandboxTerminalContainer.tsx:463–469 |
| AC-LCH-003.3 | 集成 | 已展开 Claude Code 的登录面板 | 改选 codex | 面板收起，进行中的登录取消 | 已实现：SandboxTerminalContainer.tsx:440–444 |

### REQ-LCH-004 · 分支与镜像：都可选；分支跟随项目，镜像默认平台预制镜像；读不到只降级 {#REQ-LCH-004}

> 状态 `部分实现` · 版本 MVP · 来源 P20 L98、L115、L122–124；P21 L98；P21-4 L30、L34、L244；F21-2 §N.1（L496–504）；Q-LCH-03 B（用户拍板 2026-10-04，原话「补全 10 条按推荐」）；实现 SandboxTerminalContainer.tsx:91–103、:318–330、:327–329、:505–512，NewSandboxPanel.view.tsx:342–385，useImages.ts（`useImages(runtimeId)` 今天没有消费方）；契约 sandbox.schema.ts:33–57（`CreateSandboxSchema` 已有可选的 `image`）；api sandbox-application.service.ts:272–370（门口按版本行 id 或坐标解析镜像，拒绝零副作用），image-facade.adapter.ts:38–145 · 关联 REQ-LCH-007（门口拒绝）、REQ-LCH-017（任务上看得到镜像）、REQ-SBX-003（[重新发起] 预填）、REQ-IMG-030、REQ-IMG-032 · 待裁决 Q-LCH-03（已拍板 B）· 稿件 f-lch-form-01、05、07、10（10 = 镜像下拉展开态）

**分支**：只有 Git 项目有分支字段（空项目整块不出、也不发分支请求）。默认项「跟随项目当前的分支（默认）」——不选就不带分支字段，由平台用项目当前的分支。选项来自项目本地那份代码的引用（不联网、不需要 Git 凭证）。列表还在读：这一格骨架，不拦发起；读不到：照常可发起，下面一句「分支列表暂时取不到（读取本地引用失败），这次会用项目当前的分支。」（`role="status"`）。选了一个其实已不存在的分支 → 门口拒绝（REQ-LCH-007）。

**镜像**（2026-10-04 用户拍板 Q-LCH-03 B）：放在「分支」之后，Git 项目与空项目都有。可选，默认项「平台预制镜像（默认）」——不改就不带 `image`，由平台按这台机器的档取预制镜像（与拍板前一样）。选项来自镜像管理，一张镜像一项，写镜像坐标（如 docker.io/acme/ml-agent:v1.0）：

- 已启用、验证通过或有警告的可选；与所选 Agent 有关的警告（这张镜像没有预装这个 Agent 的命令行工具）在选项后补「（没有预装 <Agent>，启动会明显变慢）」，选中后字段下面同一句，不拦（REQ-IMG-003）；
- 已禁用的（这张镜像一行当前版本都没有，REQ-IMG-030）与当前版本验证没通过的（REQ-IMG-023）**必须**置灰不可选，名称后写原因「（已禁用）」「（无效：<结论一句>）」（如「（无效：不符合平台约定）」）——与「项目」下拉里未就绪项目同一写法（REQ-LCH-001），**不得**从列表里藏掉（藏掉了，用户会以为注册没成功）；展开的列表底一句「置灰的镜像不能选：到「镜像管理」里处理好再回来。」；
- 跑不在这台机器沙箱环境上的镜像（档位不符）不列。这一项由后端随列表给出（契约补一项），前端不自己推；给出之前照常列，选了由门口拒绝就地说（见下）。

提交带的是「这张镜像」：门口按那一刻它的当前版本锁定（REQ-IMG-025），弹层开着期间这张镜像换了版本不算错误。改选项目时已选的镜像保留（镜像不属于项目，REQ-LCH-001）；关弹层即回到默认项，不记住上一次的选择（与 Agent 同一原则，REQ-LCH-002）。弹层里**不得**放「注册新镜像」——注册在镜像管理里做，两个弹层不嵌套（与「项目」下拉不放「新建项目」同理）。

- **列表还在读**：这一格骨架，不拦发起（默认项照常能发）；**读不到**：下拉只剩默认项，下面一句「镜像列表暂时取不到，这次会用平台预制镜像。」（`role="status"`），照常可发起——与分支读不到同一处理。
- **平台预制镜像已被禁用**（REQ-IMG-032）：默认项写「平台预制镜像（已禁用）」，字段下面一句「平台预制镜像已禁用，新任务用不了它：改选一张镜像，或到「镜像管理」重新启用它。」（`role="status"`）；主按钮不可发起并指向这句，直到改选一张能用的镜像——**不得**等用户点了发起才被门口拒。
- **门口拒绝**（零副作用，走 REQ-LCH-007 的琥珀路径，不给重试）：选的镜像在提交前刚被禁用、验证没通过或删掉（INVALID_IMAGE_REFERENCE、IMAGE_NOT_REGISTERED）写「无法用当前配置创建：这张镜像现在不能被新任务选用（刚被禁用、验证没通过或已删除）。请改选一张镜像后再试（本次请求未创建任何任务）。」；档位不符（IMAGE_PROVIDER_MISMATCH）写「无法用当前配置创建：这张镜像跑不在这台机器的沙箱环境上。请改选一张镜像后再试（本次请求未创建任何任务）。」。弹层里**不得**出现「镜像地址里混进了空白或控制字符」——那是给手填地址的 API 调用方的句子，弹层里没有地址可填。

**改写了哪条旧文**：P20 L115「分支: main ▾（本地引用，留空=基线分支）」→ 默认项写「跟随项目当前的分支（默认）」，「基线」不上屏；P20 L122–124、P21 L98、P21-4 L30 / L244 的「向导镜像下拉」→ 新建任务弹层的可选「镜像」字段，默认平台预制镜像、不能用的置灰写原因（Q-LCH-03 B，用户拍板 2026-10-04；拍板前本条按实现写「弹层里没有镜像」）；P20 L122–124 的「高级选项」仍不在弹层里；P21-4 L34「向导确认步镜像选择 [注册新镜像]」→ 弹层里不放注册入口（不叠弹层）。

**合并说明**：IMG 域原有两处说法承诺「发起任务向导的镜像下拉」（空态说明句、禁用轻提示），合并时曾按「弹层里没有镜像选择」统一去掉；2026-10-04 用户拍板 Q-LCH-03 → B 后本条有了「镜像」字段，那两处改称新建任务的「镜像」一栏（REQ-IMG-051 空态说明句、REQ-IMG-030 禁用后在这一栏里置灰）。（交叉引用：REQ-IMG-051、REQ-IMG-030）

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-LCH-004.1 | 集成 | Git 项目，分支没动 | 点发起 | 请求体不含 `branch` | 已实现：SandboxTerminalContainer.tsx:327–329 |
| AC-LCH-004.2 | 组件 | 分支列表读取失败 | 弹层渲染 | 下拉只剩默认项，下面一句降级说明（`role="status"`），主按钮照常可用 | 已实现：NewSandboxPanel.view.tsx:379–383，SandboxTerminalContainer.tsx:512 |
| AC-LCH-004.3 | 组件 | 空项目（没有 Git） | 打开弹层 | 没有分支字段，也不发分支请求 | 已实现：SandboxTerminalContainer.tsx:101–103、:507 |
| AC-LCH-004.4 | 组件 | 镜像管理里有平台预制镜像（ghcr.io/agent-infra/sandbox:latest）、docker.io/acme/ml-agent:v1.0（已启用，有警告：未预装 claude-code）、docker.io/acme/just-registered:v1（已启用、验证无效）；已选 claude-code | 打开弹层，展开「镜像」 | 「平台预制镜像（默认）」已选中；ml-agent 可选，选项后补「（没有预装 claude-code，启动会明显变慢）」；just-registered 写「（无效：不符合平台约定）」、置灰不可选；列表底「置灰的镜像不能选：到「镜像管理」里处理好再回来。」；把 ml-agent 禁用后再打开，它写「（已禁用）」、置灰；没有「注册新镜像」；空项目里这一栏同样在 | 未实现：弹层没有镜像字段（NewSandboxPanel.view.tsx），`useImages(runtimeId)` 没有消费方（useImages.ts）（稿件 f-lch-form-01、10） |
| AC-LCH-004.5 | 集成 | 镜像保持默认 | 点发起 | 请求体不带 `image`；任务用这台机器那一档的预制镜像 | 已实现：请求体本来就不带 image（SandboxTerminalContainer.tsx:318–330） |
| AC-LCH-004.6 | 集成 | 选了 docker.io/acme/ml-agent:v1.0 | 点发起 | 请求体带 `image` = 这张镜像；受理后任务锁定它当时的当前版本（REQ-IMG-025）；弹层开着期间它换了版本也照常受理 | 未实现：请求体不带 image（SandboxTerminalContainer.tsx:318–330）；后端已有：创建请求可带 image，门口按版本行 id 或坐标解析 |
| AC-LCH-004.7 | 组件 | 镜像列表读取失败 | 弹层渲染 | 下拉只剩默认项，下面一句「镜像列表暂时取不到，这次会用平台预制镜像。」（`role="status"`）；主按钮照常可用 | 未实现（同 AC-LCH-004.4） |
| AC-LCH-004.8 | 组件 | 平台预制镜像已被禁用，ml-agent 可用 | 打开弹层 | 默认项「平台预制镜像（已禁用）」+ 字段下那句说明；主按钮不可发起并指向它；改选 ml-agent 后可发起 | 未实现：要点了发起才被门口拒（IMAGE_NOT_REGISTERED，sandboxErrorCopy.ts:193–200） |
| AC-LCH-004.9 | 集成 | 已选 ml-agent，提交前它被禁用 | 点发起 | 琥珀门口拒绝「无法用当前配置创建：这张镜像现在不能被新任务选用（…）。请改选一张镜像后再试（本次请求未创建任何任务）。」；不给重试；不出现「空白或控制字符」 | 偏离：INVALID_IMAGE_REFERENCE 的前端句是「镜像地址里混进了空白或控制字符」（sandboxErrorCopy.ts:201–207），而门口对已停用、验证没通过的版本回的也是这个码 |
| AC-LCH-004.10 | API | 一张不是从这一档预制镜像派生的镜像 | 读新建任务用的镜像列表；指定它发起 | 列表能看出它跑不在这台机器的档上（弹层据此不列它）；发起时门口 IMAGE_PROVIDER_MISMATCH（零副作用） | 部分实现：门口已拦（image-facade.adapter.ts:118–145）；列表不给这一项（image.schema.ts:99–150 的 ImageManifestSchema 没有档位字段） |

### REQ-LCH-005 · 任务指令：可选、上限 `PARAM.TASK_PROMPT_MAX`、超出就地说 {#REQ-LCH-005}

> 状态 `部分实现` · 版本 MVP · 来源 P20 L117–121、L130；P21-2 L94–99（L98「上限 8000 字符，超限就地红字计数」）；P21-1 L138（码点计）；P22 L21（VALIDATION_FAILED）；TASK-LAUNCH T-1；实现 NewSandboxPanel.view.tsx:176–195、:387–413，SandboxTerminalContainer.tsx:314–315；契约 sandbox.schema.ts:48–57；format-pilot params.yaml:234–251 · 关联 `PARAM.TASK_PROMPT_MAX` · Q-LCH-01 · 稿件 f-lch-form-02、03

指令可选；填了，Agent 启动时就开始执行，不必等用户打开终端。上限 `PARAM.TASK_PROMPT_MAX`（现值 8000）个字符，**按 Unicode 码点数**（一个汉字、一个 emoji 都算 1），前端、契约、数据库三处**必须**同一个数法。框下右侧常显计数「N/8000」；超出时计数行变成字段错误「N/8000 —— 已超出上限，请精简后再发起」（红 + 图标，`role="alert"`），文本域标错误态（`aria-invalid`），主按钮不可发起并指向这一行。计数与提交用同一份内容（提交前去掉首尾空白的话，计数也按去掉之后的算）。指令不进 URL、不进任何存储（REQ-LCH-007、009、010）。

**改写了哪条旧文**：P21-2 L98 只写了「超限就地红字计数」→ 补「主按钮不可发起」与计数单位；参数名：plan 里写作 `PARAM.PROMPT_MAX_CHARS`，与 format-pilot 已登记的 `PARAM.TASK_PROMPT_MAX` 是同一个参数，统一用后者（params.yaml:239 的 `used_by: REQ-LCH-012` 是示意号，合并后应为 REQ-LCH-005）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-LCH-005.1 | 组件 | 指令粘进 8123 个码点 | 弹层渲染 | 计数「8123/8000 —— 已超出上限，请精简后再发起」`role="alert"`；文本域 `aria-invalid`；主按钮不可发起 | 已实现：NewSandboxPanel.view.tsx:399–413、:192（稿件 f-lch-form-03 只改视觉） |
| AC-LCH-005.2 | 集成 | 一段 7000 码点、其中 1200 个 emoji 的指令 | 前端计数并提交 | 前端显示 7000/8000、可发起，后端同样接受 | 偏离：前端按码点数（NewSandboxPanel.view.tsx:178–179），契约 zod `.max(8000)` 按 UTF-16 单元数（这段是 8200 → 400 VALIDATION_FAILED，sandbox.schema.ts:57），SQLite CHECK 按字符数（params.yaml:236 已点名，Q-LCH-01） |
| AC-LCH-005.3 | 组件 | 指令首尾带大段空白，正文 7990 码点、连空白 8010 | 弹层渲染并提交 | 计数与提交口径一致（都按去空白后的 7990），可发起 | 部分实现：提交前 `trim()`（SandboxTerminalContainer.tsx:314），计数按未 trim 的原文（NewSandboxPanel.view.tsx:179），会出现「显示超限、实际不超」而按钮被禁 |

### REQ-LCH-006 · 弹层自己的加载与加载失败 {#REQ-LCH-006}

> 状态 `偏离` · 版本 MVP · 来源 v1 g3-12、g3-13（design-drafts/README.md §3.2 错误文案 A）；UX-DS-402、UX-DS-509、DR-39、T-7；U-77；实现 NewSandboxPanel.view.tsx:168–195、:221–253、:307–340、:354–360，SandboxTerminalContainer.tsx:445–461 · 稿件 f-lch-form-04、05

弹层打开时 Agent 列表、这台机器的沙箱环境、分支列表三样各自加载、互不等待：

- **加载中**：各自骨架（形状接近加载完成后的控件），每块 `role="status"` + `aria-label`（「正在加载可选 Agent」「正在确认这台机器的沙箱环境」「正在加载可选分支」）。Agent 或沙箱环境加载中时主按钮不可发起，但不写原因（骨架已说明在加载，DR-39）；分支加载中不拦。指令框加载期间就能写。「项目」下拉不需要加载（项目列表工作台里已有）。
- **加载失败**：各自一条失败提示 + 各自的重试（[重试加载 Agent] / [重试]），`role="alert"`。句子写「发生了什么：原因。」——「Agent 列表没读出来：网络请求失败。」「没能确认这台机器的沙箱环境：网络请求失败。」；原因按错误类型给人话（网络不通写「网络请求失败」，服务端出错写「服务出错了」），**不得**拼后端或浏览器的原串（「请求失败」「Failed to fetch」「HTTP 500」）。分支读取失败只降级（REQ-LCH-004）。
- **与「真的没有」区分**：注册表为空是另一句、不给重试（REQ-LCH-002；沙箱环境同理「平台上一个沙箱环境都没有注册，现在发不了任务。」）。

**改写了哪条旧文**：原产品文档没写弹层自己的加载与失败（P21-2 §5 状态矩阵从「Step 1 首入」开始）→ 新增本条；实现的「Agent 列表加载失败：{原串}」→「Agent 列表没读出来：<人话原因>。」（v1 g3-13，README §3.2）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-LCH-006.1 | 组件 | `/api/runtimes` 与 `/api/providers` 都还没返回 | 打开弹层 | Agent 两行骨架、沙箱环境一条骨架，各带 `role="status"` 与 `aria-label`；指令框可写；主按钮不可发起、不写原因 | 部分实现：骨架与 `aria-label` 已有（NewSandboxPanel.view.tsx:221–231、:309–316），但骨架是只挂 `aria-label` 的 `span`/`div`，没有 role（UX-DS-509）（稿件 f-lch-form-04） |
| AC-LCH-006.2 | 组件 | 两个请求都因断网失败 | 弹层渲染 | 两条失败提示（`role="alert"`）「Agent 列表没读出来：网络请求失败。」+ [重试加载 Agent]、「没能确认这台机器的沙箱环境：网络请求失败。」+ [重试]；分支照常 | 偏离：句子是「Agent 列表加载失败：{error.message}」，原因直接取请求错误的原串、缺省「请求失败」（NewSandboxPanel.view.tsx:233–247、:318–332，SandboxTerminalContainer.tsx:446–458）（稿件 f-lch-form-05） |
| AC-LCH-006.3 | 集成 | Agent 列表读取失败 | 点 [重试加载 Agent] 且这次成功 | 失败提示消失，出现两个都未选的 Agent 单选 | 已实现：SandboxTerminalContainer.tsx:449–451 |

### REQ-LCH-007 · 同步失败留在弹层：门口拒绝与创建失败（含资源不够） {#REQ-LCH-007}

> 状态 `偏离` · 版本 MVP · 来源 P22 §1 L10、L21，§1.1 L26–48，§2 L67；P20 L140、L393；P21-2 L148、L192；DR-02 A（同步失败回填指令）、DR-03 A（停止不释放名额）、DR-15（不回复默认：429 仍走红色「创建失败」）、DR-33；UX-DS-402；Q-SYS-02③ / D9（「还能再发 N 个任务」同口径）；实现 SandboxTerminalContainer.tsx:316–317、:350–358、:488–498，useCreateSandbox.ts:39–55，NewSandboxPanel.view.tsx:427–440，sandboxErrorCopy.ts:98–216、:355–363、:440–499；api sandbox-application.service.ts:184–207（429 刻意不标 `sideEffectFree`）、:240–270（门口七条）、project-facade.adapter.ts:78–84 · 稿件 f-lch-form-06、07

点发起之后、平台受理之前被拒的，弹层**留着**，就地一条提示（放在字段栈之后、页脚条之前），项目 / Agent / 分支保持原选择，**指令放回框里**（DR-02 A：只放回弹层的局部状态；关弹层或受理即清空，不进任何存储、不进 URL）。两条路径互斥，按后端错误信封里的 `sideEffectFree` 判，不按 HTTP 状态码；字段缺席按「可能有副作用」读：

1. **门口拒绝（零副作用）**：后端标了 `sideEffectFree: true` 的七条——UNKNOWN_PROVIDER、UNKNOWN_RUNTIME、INVALID_IMAGE_REFERENCE、UNSUPPORTED_CAPABILITY（400 / 409）、PROJECT_NOT_FOUND（404）、PROJECT_NOT_READY（409）、BRANCH_NOT_FOUND（400）；弹层能选镜像之后（Q-LCH-03 B），门口透传镜像模块的 IMAGE_NOT_REGISTERED、IMAGE_PROVIDER_MISMATCH 也会到这里，同样零副作用，弹层里怎么说见 REQ-LCH-004。琥珀提示（`role="alert"`）「无法用当前配置创建：<按码查表的原因>。<按码的去处>（本次请求未创建任何任务）。」；**不给**任何重试（原样重发只会被同一道门再拒）；原因与去处按码查前端文案表，**不得**拼后端原串。BRANCH_NOT_FOUND 写「无法用当前配置创建：项目里没有这个分支（远端可能已经删掉了它，项目这边还停在同步之前）。请改选一个列表里有的分支后再试（本次请求未创建任何任务）。」
2. **创建失败**（含资源不够 RESOURCE_EXHAUSTED 429——它结构上也什么都没写，但后端刻意不标 `sideEffectFree`，DR-15 按不回复默认维持）：红色提示「标题 —— 建议」（`role="alert"`）。资源不够写「这台机器能同时登记的任务已满（8 / 8）—— 销毁不用的任务才能腾出名额（已停止的任务也占着名额）；在「系统状态」能看到还能再发几个。」（两个数取接口，与系统状态「还能再发 N 个任务」同一口径）；名额腾出来后再点主按钮就是重试，弹层里不另放 [稍后重试]。没收录的错误码走兜底「操作没有完成 —— 未能获取具体原因，可以重试一次；若持续失败请查看系统状态。」，**不得**把后端 message 填进建议位，也不得裸抛码。

用户改了任何一个字段后，提示消失。

**改写了哪条旧文**：P22 L10「当前任务较多，资源暂时不足 —— [停止部分任务] / [稍后重试]」、P22 L67「资源不足：阶段进度卡第一步即红」、P21-2 L148「INIT → FAIL : RESOURCE_EXHAUSTED」→ 资源不够在提交时同步返回、留在弹层，建议句改「销毁不用的任务才能腾出名额」（DR-03 A：停止不释放名额，停掉腾不出来）；P22 §1.1 L28 / L39–46「这六条」→ 七条，补 BRANCH_NOT_FOUND（400；契约与实现已有，sandbox-application.service.ts:252–255、sandboxErrorCopy.ts:156–162）；P20 L140 / P21-2 L192「失败：阶段进度卡就地变红 + [重试]」→ 同步失败在弹层就地说、异步失败转结果卡（REQ-LCH-015）；P20 L393「失败：回弹窗改配置」→ 本条（弹层本来就还开着）；实现「提交即清空、失败也不回填」（SandboxTerminalContainer.tsx:316–317）→ 同步失败回填（DR-02 A）。

**合并说明**：「已满（R / M）」里的 M 与 REQ-SYS-071 口径句的「本机最多 M 个」是同一个数，契约里还没有这个字段（DR-08 只提了 remainingTasks / registeredTasks / basis），两处一起随 Q-SYS-17 定；契约到位前这句不写这两个数（与 REQ-SYS-071「契约到位之前」同一处理）。（交叉引用：REQ-SYS-071、Q-SYS-17）

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-LCH-007.1 | 集成 | 本机任务名额已满 | 选 codex、填 236 字指令、点发起 | 弹层留着；红色「这台机器能同时登记的任务已满（8 / 8）—— …还能再发几个。」；指令回填（236/8000）；主按钮可用 | 偏离：建议句是「停掉几个不用的任务把资源让出来，或者过一会儿再试。」（sandboxErrorCopy.ts:355–358，与 DR-03 矛盾）；指令提交前已清空、不回填（SandboxTerminalContainer.tsx:316–317）（稿件 f-lch-form-06） |
| AC-LCH-007.2 | 集成 | 选了 feat/login-refresh，而项目本地已没有这个分支 | 点发起 | 琥珀「无法用当前配置创建：项目里没有这个分支（…）。请改选一个列表里有的分支后再试（本次请求未创建任何任务）。」；没有任何重试入口；指令回填 | 偏离：原因位直接拼后端原串「project <id> has no branch 'feat/login-refresh'」，去处是通用的「请调整配置后再试」（sandboxErrorCopy.ts:472–479，project-facade.adapter.ts:81–84）；指令不回填（稿件 f-lch-form-07） |
| AC-LCH-007.3 | 单元 | 错误信封 `sideEffectFree` 分别为 缺席 / false / true | 判走哪条路 | 只有 true 走门口拒绝，其余走创建失败 | 已实现：sandboxErrorCopy.ts:440–443，useCreateSandbox.ts:42–52 |
| AC-LCH-007.4 | 单元 | 后端返回一个文案表里没有的码，message 是英文原句 | 渲染创建失败 | 兜底句「操作没有完成 —— 未能获取具体原因，…」，不出现那句英文 | 偏离：兜底把后端 message 当建议位（sandboxErrorCopy.ts:488–498） |
| AC-LCH-007.5 | 集成 | 同步失败之后 | 关掉弹层再打开 | 指令框为空，上次的提示不在 | 已实现：SandboxTerminalContainer.tsx:367–371 |
| AC-LCH-007.6 | 文档 | — | 对照 P22 §1.1 与前端文案表 | 七条门口拒绝都有中文原因与去处，BRANCH_NOT_FOUND 在两边都有 | 部分实现：前端表七条齐（sandboxErrorCopy.ts:98–216），P22 §1.1 只列了六条 |

### REQ-LCH-008 · 这台机器开不了终端：只说事实和去处 {#REQ-LCH-008}

> 状态 `偏离` · 版本 MVP · 来源 P20 L116（模式：交互式终端 / 无头任务 v1.1）；P21-2 L92–93；DR-01 A（新建弹层不加无头选项）、DR-25（只说事实和去处，不提无头）；实现 SandboxTerminalContainer.tsx:193–195、:474–487，NewSandboxPanel.view.tsx:442–446 · 稿件 f-lch-form-08

这台机器默认的沙箱环境不支持交互式终端（服务端能力位 `spawnTty = false`）时，主按钮不可发起，字段栈下面一条琥珀提示（`role="alert"`，主按钮 `aria-describedby` 指向它）：「这台机器的沙箱环境开不了终端。跑在哪种沙箱环境上是这台机器的事实，不是一个可以在这里改的选项；在「系统状态」的「沙箱环境状态」里能看到它是哪一种、支持哪些能力。」**不得**再写「改发无头任务」——新建弹层没有无头模式（DR-01 A），那是一个不存在的出口。

**改写了哪条旧文**：P20 L116 / P21-2 L92–93「模式：◉ 交互式终端 ○ 无头任务(v1.1)，无头超时 30 分钟 ▾」→ 新建弹层不出现模式选择，无头任务只由自动化规则发起（DR-01 A）；实现原句「…改发无头任务就可以——不开终端，agent 启动就开始执行。」→ 上面那句（DR-25）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-LCH-008.1 | 组件 | 默认沙箱环境 `spawnTty=false` | 打开弹层、选 codex | 琥珀提示（上句，没有「无头」字样）；主按钮不可发起且指向这句 | 偏离：句子仍是「…改发无头任务就可以——…」，按钮是原生 `disabled`（SandboxTerminalContainer.tsx:482–486，NewSandboxPanel.view.tsx:482） |
| AC-LCH-008.2 | 组件 | 任意 | 看弹层 | 没有「交互式 / 无头」的模式选择，请求体不带 `headless` | 已实现：SandboxTerminalContainer.tsx:318–330 |

### REQ-LCH-009 · 深链打开、刷新与回落 {#REQ-LCH-009}

> 状态 `部分实现` · 版本 MVP · 来源 P20 §8.2 L410、§8.3 L429、§8.5 L446；F21-2 §2.1（L21–82）；P21 L11；P21-2 L1–2、L11–12、L41–43；Q-DS-35① 默认（plan.md「要拍板」）；实现 useDeepLinkModal.ts:48–55、:89–171，SandboxTerminalContainer.tsx:51、:112–137、:501–504，NewSandboxPanel.view.tsx:414–424 · 关联 REQ-WB-040–049（地址指向的对象已不在，F-WB-ROUTE） · 稿件 f-lch-form-09（回落画面归 f-wb-route-01）

弹层可寻址：`/?new=1&project=<项目 id>`（原型写作 `#new&project=<id>`）。只认这两个键；指令**永远不得**进 URL。

- 打开弹层时地址写上这两个参数（只写一次）；关弹层去掉；浏览器后退 = 关弹层，前进 = 重新打开。
- 直接访问 / 刷新这个地址，项目存在且就绪 → 选中该项目、打开弹层、「项目」预选它；Agent 不预选（REQ-LCH-002）；指令框为空，框下一句「刷新后指令未保留，请重新输入」（`role="status"`）。站内点开不出这句。
- 项目不存在（含已删除）→ 不开弹层，回落项目总览，顶部一句「找不到项目「<名称>」：可能已被删除。」（不知道名称时「找不到这个项目：可能已被删除。」），地址去掉参数（Q-DS-35①，与 REQ-WB-040 同一写法）。
- 项目存在但未就绪 → 不开弹层，选中该项目（主区就是它的克隆进度或克隆失败处置，F-PRJ-CLONE），主区顶部一句页内提示（`role="status"`）：克隆中「「infra-scripts」还在克隆，克隆完成后才能发起任务。」，克隆失败「「acme-api」克隆失败了，重试克隆或改为空项目之后才能发起任务。」，地址去掉参数。
- 只带 `?new=1`、没带项目 → 不算深链，什么都不做。

**改写了哪条旧文**：P21 L11「modal（深链 `/new`）」、P21-2 L1「深链路由 `/new`」、L11–12「深链 `/new?runtime=codex`（预选 runtime）；modal 刷新即关闭」、L41–43 状态图注「刷新时 modal 直接关闭回工作台」→ 本条（query 深链；刷新恢复弹层与项目上下文；指令为空并明说；不预选 Agent）；P20 L429「`project` 指向不存在 / 已删项目 → 不开弹窗，回落工作台常态」→ 回落项目总览并说一句（Q-DS-35①）；未就绪项目的那句是本片新增。

**合并说明**：片段原写「<名称或 id>」；按 REQ-WB-040 统一：知道名称写名称，不知道写「这个项目」，不把 id 上屏。（交叉引用：REQ-WB-040）

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-LCH-009.1 | e2e | acme-web 就绪 | 直接访问 `/?new=1&project=<acme-web 的 id>` | 弹层打开、「项目」= acme-web；框下「刷新后指令未保留，请重新输入」（`role="status"`）；Agent 未选 | 部分实现：弹层、项目上下文与那句已实现（useDeepLinkModal.ts:102–119，SandboxTerminalContainer.tsx:501–504，NewSandboxPanel.view.tsx:414–424；F21-2 e2e ⑥）；「项目」字段未实现（Q-DS-29）（稿件 f-lch-form-09） |
| AC-LCH-009.2 | e2e | 站内点 [新任务]，写了指令 | 按浏览器后退 | 弹层关闭、地址回到干净 URL；整个过程地址里从未出现指令 | 已实现：useDeepLinkModal.ts:121–171（F21-2 e2e ⑦） |
| AC-LCH-009.3 | e2e | 项目已被删除 | 访问它的深链 | 不开弹层；回落项目总览，顶部「找不到项目「…」：可能已被删除。」；参数被去掉 | 部分实现：不开弹层、抹参数已实现（useDeepLinkModal.ts:110–111、:136–141）；静默，不回总览、不说一句 |
| AC-LCH-009.4 | e2e | infra-scripts 克隆中 | 访问它的深链 | 不开弹层；选中 infra-scripts；主区顶部说明还不能发起（`role="status"`）；参数被去掉 | 部分实现：选中且不开弹层（useDeepLinkModal.ts:112–117），没有那句说明 |

## LCH · 发起后的启动流程（F-LCH-STARTUP）

### REQ-LCH-010 · 提交：创建中不可关，受理即关 {#REQ-LCH-010}

> 状态 `部分实现` · 版本 MVP · 来源 P20 L126、L136、L389、L417；P21-2 L113、L190、L205；UX-DS-204；DR-02 A；v1 g3-14；实现 SandboxTerminalContainer.tsx:308–360、:404–413、:516–520，NewSandboxPanel.view.tsx:217、:365、:397、:466–485；api sandbox.controller.ts:36–41（201）、sandbox-application.service.ts:162–220 · 稿件 f-lch-startup-02

主按钮名统一「发起任务并打开终端」。点了以后、平台受理之前是「创建中」：所有字段、[取消]、右上「关闭」都禁用，主按钮换成转圈 +「创建中…」并禁用（UX-DS-204「X 中…」）；Esc / 点遮罩 / 关闭都**不**关弹层——创建中被误关，会留下一个用户以为没发生过的请求。指令在提交这一刻从框里取走（框显示为空）。之后：

- 受理（`201`，任务状态 `pending`）→ 立即关弹层，前端不再在任何地方持有这条指令；转 REQ-LCH-011。
- 同步失败 → 留在弹层，指令放回（REQ-LCH-007）。

受理不等于启动成功：启动是异步的，进度在主区（REQ-LCH-011–015），弹层里不显示进度、不提供 [后台运行]；受理之前不能取消，受理之后要取消走 REQ-LCH-014。

**改写了哪条旧文**：P20 L126「[创建]」、P21-2 L113「[发起]」→「发起任务并打开终端」（实现原名）；P20 L136「返回 202 + sandbox 记录（pending）」→ `201`（sandbox.controller.ts:36–41 是 `@ApiCreatedResponse` 的 `@Post`）；P20 L417「新建任务弹窗 → 进度卡：取消 = 终止并自动回收资源，需确认」与 P21-2 L205「创建中取消 = 终止创建并自动回收资源，需确认」→ 受理前不可取消，受理后取消走 REQ-LCH-014。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-LCH-010.1 | 组件 | 已选 codex、填了指令 | 点发起，请求还没返回 | 字段、[取消]、关闭全部禁用；主按钮转圈 +「创建中…」禁用；指令框为空 | 部分实现：禁用与「创建中…」已实现（NewSandboxPanel.view.tsx:217、:365、:397、:470、:482–484，SandboxTerminalContainer.tsx:520）；按钮没有转圈；「项目」字段未实现（稿件 f-lch-startup-02） |
| AC-LCH-010.2 | 组件 | 创建中 | 按 Esc、点遮罩 | 弹层不关 | 已实现：SandboxTerminalContainer.tsx:408–412 |
| AC-LCH-010.3 | 集成 | 创建中 | 平台返回 201（pending） | 弹层关闭；新任务成为当前选中；前端不再持有指令 | 已实现：SandboxTerminalContainer.tsx:332–353 |

### REQ-LCH-011 · 受理之后：树里出现准备中行，主区是启动进度卡 {#REQ-LCH-011}

> 状态 `部分实现` · 版本 MVP · 来源 P20 L136–137；P21 L38–46；P21-1 L94、L137–139；P21-2 L117–131（形态 D）、L206（[后台运行]）；Q-DS-15 ①A ②A；UX-DS-111、UX-DS-120（SP/design-track/final/spec/status-mapping.md:61–73）；实现 WorkbenchShell.view.tsx:29–46、:539–564，sandboxLifecycle.ts:121–138，SandboxLifecycleContainer.tsx:129–146，SandboxTerminalContainer.tsx:332–349；api packages/modules/sandbox/src/domain/services/task-name.policy.ts:33–46 · 稿件 f-lch-startup-03、01

受理后，新任务**立即**出现在所属项目组的最上面并成为当前项：状态点 = 准备中灰色脉冲点（Q-DS-15 ②A），副行「准备中 · <当前阶段名>」；顶栏面包屑「项目 / 任务名」+ 中性徽标「准备中」。任务名是平台从指令派生的默认名（第一个非空行的前 20 个码点，被截断或后面还有内容时加「…」；没写指令时「<Agent 名> · <时间>」），前端不自己派生。主区是启动进度卡（REQ-LCH-012），没有终端栏（这时还没有终端）。树筛选「准备中」包含它（可能卡住也算准备中）；导航「任务」徽标只数等待你输入，不数准备中。进度**不**放弹层，也没有 [后台运行]：弹层已关，用户随时可以去别的任务，回来进度照常。

**改写了哪条旧文**：P21-2 L117–131 形态 D「弹窗变阶段进度卡 + [后台运行] [取消]」、L206「[后台运行] → toast + 列表项显示阶段名与进度条」、P20 L389–392「NewTask → Progress →（成功 / [后台运行]）」→ 主区进度卡、没有 [后台运行]（实现与 v1 g3-14 / g2-01）；P21 L46「🟡 准备中：脉冲黄点」→ 灰色脉冲点（Q-DS-15 ②A；琥珀留给「可能卡住」）；P21-1 L94「全部 / 准备中 / 运行中 / 等待输入 / 已暂停 / 异常」→「全部 / 准备中 / 运行中 / 等待输入 / 已停止 / 异常」（Q-DS-15 ①A）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-LCH-011.1 | e2e | 在 acme-web 发起「修一下首页加载慢」 | 平台受理 | acme-web 组首行出现该任务、为当前项；灰脉冲点（`aria-label`「准备中」）；副行「准备中 · 初始化」；顶栏徽标「准备中」 | 部分实现：受理后任务进列表并被选中（SandboxTerminalContainer.tsx:332–349）；树点只有两色，准备中显示成绿点「运行中」，副行不写阶段（WorkbenchShell.view.tsx:539–564）（稿件 f-lch-startup-03） |
| AC-LCH-011.2 | 组件 | 有一个准备中、一个可能卡住的任务 | 树筛选选「准备中」 | 两个都在；筛空时「没有准备中的任务」 | 部分实现：「准备中」档已按 pending…starting 过滤（WorkbenchShell.view.tsx:31、:40）；「可能卡住」未实现 |
| AC-LCH-011.3 | 组件 | 任务准备中 | 看主区与弹层 | 主区是启动进度卡、没有终端栏；弹层已关，没有任何地方出现 [后台运行] | 已实现：SandboxLifecycleContainer.tsx:129–146 |

### REQ-LCH-012 · 启动四阶段、已等待与长等待说明 {#REQ-LCH-012}

> 状态 `部分实现` · 版本 MVP · 来源 P20 L137、L139；P21 L38–42；P21-2 L119–131、L231；P22 L14、L69；UX-DS-308；Q-DS-21 A（「铺开」「拉到本机」→「下载到本机」；屏上一律写「Agent」）；实现 sandboxLifecycle.ts:33–74、:103–107，useSandboxLifecycle.ts:86–130，SandboxStartupProgress.view.tsx:73–131，instanceStartupCopy.ts:34–78，runtimeInstallProgress.ts:28–43；api provision-sandbox.workflow.ts:238–245 · 关联 Q-LCH-02 · 稿件 f-lch-startup-03、04

启动进度卡：标题「正在启动：<任务名>」，标题下一行写这个任务用的镜像（REQ-LCH-017）；一条进度条；四格按**展示序**：初始化 → 拉取镜像 → 准备代码副本 → 启动运行环境（后端状态 → 格：pending / scheduling → 初始化，preparing-workspace → 准备代码副本，creating → 拉取镜像，starting → 启动运行环境）。进度条按技术推进单调递增：20 / 40 / 60 / 80%，进入运行中之前永不到 100%。每格三态：做完（勾）/ 进行中（实心点 + 行尾「已等待 m:ss」，超过一小时写 h:mm:ss）/ 未开始（空心圆）。整块 `role="status" aria-live="polite"`。

长等待**必须**说清「不是卡死」。说明挂在「启动运行环境」格下面，同一时刻只出一句（装命令行工具的说明出现后接管）：

- 本机没有这张镜像：卡标题下副标题「首次使用这个镜像，要先把它下载到本机 —— 整个启动里这一步最久」，格下「本机还没有这个镜像，正在下载到本机并启动运行环境…（首次使用可能持续数分钟，期间没有输出，不是卡死）」；
- 本机已有：格下「镜像已在本机，正在启动运行环境…」，不出副标题；平台说不清有没有：格下「正在启动运行环境…」，不出副标题；
- 运行环境就绪、正在起 Agent：「运行环境已就绪，正在启动 Agent…」；
- 镜像没预装所选 Agent 的命令行工具：「正在安装 <Agent> 的命令行工具…（这张镜像里没有预装它，现装可能要十几分钟，不是卡死）」。

「本机有没有这张镜像」平台只在进入「启动运行环境」之后才问得出来，所以副标题只在这一格出现，「拉取镜像」格期间不出。内部词不上屏（工作区、实例、铺开、sandbox、原始状态名；原始状态只挂 `data-status`）。

**改写了哪条旧文**：P21-2 L119–131 与 L231「五段：初始化 / 拉取镜像 / 准备工作区 / 启动实例 / 连接终端」、P21 L39–40 → 四段，上屏词「准备代码副本」「启动运行环境」（P21-1 §9），「连接终端」不单列（会话在「启动运行环境」里已起好，打开终端只是接上，P20 L139、TASK-LAUNCH T-2）；P21-2 L120 / L122 / L127「已耗时 45s」「150/800MB（预计还需 40s）」「参考耗时」→ 当前格「已等待 m:ss」，不写字节进度与预计剩余（平台不推这些字段）；P20 L137 / P22 L14「正在安装 …」子文案 → 上面那句（写全「不是卡死」）；实现的「拉到本机」「下载并铺开运行环境」「正在启动 agent」→ 定稿词（Q-DS-21 A）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-LCH-012.1 | 单元 | 12 个后端状态 | 映射到格与百分比 | pending / scheduling → 初始化 20%；preparing-workspace → 准备代码副本 40%；creating → 拉取镜像 60%；starting → 启动运行环境 80%；其余不属于启动 | 已实现：sandboxLifecycle.ts:55–74、:79–86、:103–107 |
| AC-LCH-012.2 | 组件 | creating，本页 42 秒前收到这次状态变化 | 渲染进度卡 | 初始化打勾、拉取镜像进行中「已等待 0:42」、后两格未开始；进度条 60% | 已实现：useSandboxLifecycle.ts:86–130，SandboxStartupProgress.view.tsx:88–123（现状行尾只显示等宽「0:42」，加「已等待」三字是 v2 改动）（稿件 f-lch-startup-03） |
| AC-LCH-012.3 | 组件 | starting，`instance_progress.imageStaged = false` | 渲染进度卡 | 副标题与格下说明按上文（「下载到本机」） | 偏离：用词是「拉到本机」「下载并铺开运行环境」，就绪后「正在启动 agent」（instanceStartupCopy.ts:36、:40、:77）（稿件 f-lch-startup-04） |
| AC-LCH-012.4 | 组件 | starting，`runtime.install_progress = installing` | 渲染进度卡 | 格下换成「正在安装 claude-code 的命令行工具…（…不是卡死）」，副标题不变 | 已实现：useSandboxLifecycle.ts:109–116，runtimeInstallProgress.ts:33–35 |

### REQ-LCH-013 · 可能卡住：提示与出口 {#REQ-LCH-013}

> 状态 `未实现` · 版本 MVP · 来源 Q-DS-16 A（plan.md「按默认推进」；design-decisions.md:56–60；00-决策简报 L47）、Q-DS-15 ②A；UX-DS-112、UX-DS-308；FE4（01 §3.2）；DR-42 ②（卡里进行中的点不变色）；P21 L115；P21-2 L126–129、L144、L151、L157、L191、L233；P22 L69、L71；实现 SandboxStartupProgress.view.tsx（props 没有任何回调）、WorkbenchShell.view.tsx:539–542 · 关联 `PARAM.STUCK_HINT_S`（新增，暂行 300 秒，W4 随 NFR-15 定）· 稿件 f-lch-startup-05、01

同一阶段超过 `PARAM.STUCK_HINT_S` 没有任何进展（没有新的状态变化，也没有新的阶段说明）时：

- 进度卡最后加一条琥珀提示（`role="alert"`）：标题「可能卡住了：已 m:ss 没有新进展」（只写已等待时长，不写阈值）；一句按阶段的说明——拉取镜像：「拉取镜像通常会持续推进；这么久没有任何进展，多半是网络或镜像下载源的问题。」（其余三格的说明句待补，见「默认决定与待确认」6）；两个出口同时出现，不分两段：[取消并删除…]（进二次确认，REQ-LCH-014）在前，[继续等待] 在后。
- 卡里进行中那一格的点**不变色**；树上这一行的点升为琥珀「可能卡住」，副行「可能卡住 · m:ss 无进展」（琥珀）；顶栏徽标「可能卡住」。
- 这个任务进项目总览与 ⌘K 的「需要你处理」，排在异常之后、等待你输入之前；导航「任务」徽标仍只数等待你输入。

[继续等待] = 收起提示、从这一刻重新计时，树点回到准备中。有新进展时提示自动收起。正在安装 Agent 命令行工具（`install_progress = installing`，格下有说明）期间**不判**卡住（P22 L69）。卡住只是提示，平台**不得**自动处置。

**改写了哪条旧文**：P21 L115「>10min 卡住显示『⚠️ 可能卡住』+ 强制操作入口」、P21-2 L128–129 / L144 / L151 / L233「任一阶段 >5min（300 秒）无进展，检测间隔 10s，『⚠️ 可能卡住（第 n 次检测）』」、P21-2 L126 / L157 / L191「>10min 出现 [强制停止]」、P22 L71「创建整体 >10min『可能卡住』+ [强制停止]」→ 一律引用 `PARAM.STUCK_HINT_S`，提示与出口同时出现，出口是「取消并删除」（任务删除、名额释放），不是「强制停止」后转异常留在树上（Q-DS-16 A 而非 C）；P22 L69「该标签的 10min 计时只针对无子文案的停滞」→ 保留语义（装命令行工具期间不判卡住），阈值改引用参数。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-LCH-013.1 | 组件 | creating，已 6:40 没有新事件（阈值 300 秒） | 渲染进度卡 | 卡内琥珀提示「可能卡住了：已 6:40 没有新进展」+ 说明 + [取消并删除…][继续等待]；进行中的点不变色；不出现阈值数字 | 未实现：进度卡没有提示也没有出口（SandboxStartupProgress.view.tsx 无回调）（稿件 f-lch-startup-05） |
| AC-LCH-013.2 | 组件 | 同上 | 看树与顶栏 | 树点琥珀（`aria-label`「可能卡住」）、副行「可能卡住 · 6:40 无进展」；顶栏徽标「可能卡住」 | 未实现：树点只有两色（WorkbenchShell.view.tsx:539–542） |
| AC-LCH-013.3 | 集成 | 卡住提示在场 | 点 [继续等待] | 提示收起，计时从此刻重来，树点回到准备中 | 未实现 |
| AC-LCH-013.4 | 单元 | starting，`install_progress = installing` 已 12 分钟 | 判卡住 | 不判卡住 | 未实现（整条未实现；语义沿用 P22 L69） |
| AC-LCH-013.5 | 集成 | 有一个可能卡住的任务 | 打开项目总览、按 ⌘K | 出现在「需要你处理」（异常之后、等待你输入之前）；导航徽标不数它 | 未实现（总览与 ⌘K 是 v2 新增，Q-DS-27 A / Q-DS-28 A） |

### REQ-LCH-014 · 取消并删除：二次确认，任何准备阶段都删得掉 {#REQ-LCH-014}

> 状态 `未实现` · 版本 MVP · 来源 Q-DS-16 A、Q-DS-17 A（统一破坏性确认）、D4（任意状态都能删）；Q-SBX-02 B（用户拍板 2026-10-04：只有首次启动不给「留下来」）；BE2 / BE3（01 §3.2：DELETE 任意状态可用且幂等；乐观锁，发现行已 destroying 就放弃写入并销毁新实例）；DR-03（删掉才释放名额）；P21 L67；P20 L417；v1 g2-04；实现 api sandbox-application.service.ts:720–774，sandbox-status.vo.ts:39–52；web 没有入口 · 关联 REQ-SBX-013（从已停止重新启动）、REQ-SBX-020（删除中）、REQ-SBX-021（当前任务被删后主区去向）· 稿件 f-lch-startup-06

[取消并删除…] 打开统一破坏性确认（Q-DS-17 A）：标题「取消并删除任务「<任务名>」？」，副标题「<项目> · <Agent> · 准备中（可能卡住）」；分段：**会删掉**（准备到一半的运行环境〔卡在「<阶段>」，已 m:ss 没有新进展〕；这条任务记录）→ **代码副本怎么处理**：首次启动的任务（从受理到第一次运行起来之前）写「一起删掉，不留成果」——Agent 还没开始干活，代码副本里只有刚复制出来的项目代码，没有成果可留，所以不给「留下来」的选项；从已停止重新启动、还在准备中的任务（REQ-SBX-013），代码副本里可能有上一轮的成果，给二选一「留下来作为成果（默认；30 天后自动清理，可在「保留下来的成果」里下载）/ 一起删掉，不留成果」，默认选中「留下来」（Q-SBX-02 B，用户拍板 2026-10-04）→ **删掉之后**（占用的任务名额会释放，可以马上重新发起）→ **不受影响**（项目代码，以及同项目的其他任务）；最后一行清单来源。打开时焦点在 [取消]；[取消并删除]（danger）在右。确认后走删除过程（REQ-SBX-020：树行淡出、副行「删除中…」、移除；主区去向见 REQ-SBX-021）。

平台**必须**能删除处于准备中任何一个阶段（pending 到 starting）的任务，不论后台的启动流程跑到了哪一步；删除与仍在进行的启动流程并发时，以删除为准（BE2 / BE3）。

**改写了哪条旧文**：P21-2 L157「STUCK → FAIL：>10min 用户 [强制停止]（二次确认·资源回收）」、L191「[强制停止]」、P22 L71 → 出口叫「取消并删除」，任务被删除、名额释放，而不是转「异常」留在树上；P21 L67「准备中 → 取消：终止创建 + 资源自动回收」→ 保留语义，补二次确认与上述分段；本片原写「一律不给『留下来』」→ 按首次启动 / 重新启动分开（Q-SBX-02 B）；确认里的「工作目录」→「代码副本」（Q-SBX-03 A，用户拍板 2026-10-04）。

**合并说明**：片段原文「不给『留下来』」的理由（Agent 还没开始干活）只对首次启动成立；合并时按 Q-SBX-02 的默认补了「重新启动的给『留下来作为成果』（默认选中）」。2026-10-04 用户拍板 Q-SBX-02 → B（与默认相同）后，这一分法已写进正文与 AC-LCH-014.4。（交叉引用：REQ-SBX-013、REQ-SBX-020、Q-SBX-02）

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-LCH-014.1 | 组件 | 首次启动的任务，卡住提示在场 | 点 [取消并删除…] | 出上面那张确认；初始焦点在 [取消]；「代码副本怎么处理」只写「一起删掉，不留成果」，没有「留下来」的选项 | 未实现：web 没有任何入口（稿件 f-lch-startup-06） |
| AC-LCH-014.2 | API | 任务处于 pending / scheduling / preparing-workspace / creating | `DELETE /api/sandboxes/{id}` | 删除成功、名额释放 | 偏离：destroy 只把 running / idle / stopping / starting 先走到可删的状态（sandbox-application.service.ts:731–741），其余直接转 destroying 被状态机拒（sandbox-status.vo.ts:39–52 只允许 stopped / failed → destroying）；`InvalidSandboxTransitionError` 没有 HTTP 映射 → 500，creating 等还会被顺手改成 failed（:768–772）。只有 starting 删得掉。依赖 BE2 |
| AC-LCH-014.3 | e2e | 确认框已打开 | 点 [取消并删除] | 树行进入「删除中…」后移除，主区离开该任务；系统状态「还能再发」+1 | 未实现（随 REQ-SBX-020） |
| AC-LCH-014.4 | 组件 | 从已停止 [启动] 的「跑一遍示例测试」卡在「启动运行环境」，卡住提示在场 | 点 [取消并删除…] | 「代码副本怎么处理」二选一，默认选中「留下来作为成果」；确认后以留下来的方式删除（`keepVolume: true`），这一份出现在「保留下来的成果」里 | 未实现：web 没有任何入口（稿件 f-lch-startup-06 只画了首次启动） |

### REQ-LCH-015 · 启动的三种结局：运行中 / 异常 / 超时未响应 {#REQ-LCH-015}

> 状态 `部分实现` · 版本 MVP · 来源 P20 L138–140；P21 L65–66；P21-2 L159、L192–193、L207；DR-02 A、DR-16、DR-31、DR-34；TASK-LAUNCH T-2；实现 sandboxLifecycle.ts:79–86，useSandboxLifecycle.ts:131–138，SandboxLifecycleContainer.tsx:100–127，WorkbenchShell.view.tsx:539–564 · 关联 REQ-SBX-001（异常结果卡）、REQ-SBX-002（超时未响应）、REQ-SBX-003（重新发起）· 稿件 运行中 = pilot P1；结果卡归 lch-b 的 f-sbx-relaunch-01、02

- **成功**（running）：主区换成终端并自动连上；填了指令时能看到 Agent 已经在执行（会话在「启动运行环境」里就起好了，打开终端只是接上，可能已有一屏输出）；树点转运行中（绿），徽标随之变。
- **失败**（failed）：主区换成异常结果卡（REQ-SBX-001：人话标题 + 主语行 + 建议 + 细节 + [重新发起] 等 + 诊断码行），树点红、副行短原因（如「启动失败：没能把镜像拉下来」，DR-31）。弹层早已关闭，所以指令**不**回填；[重新发起] 打开新建任务弹层，预选原项目、Agent 与镜像（REQ-SBX-003，DR-02 A；镜像随 Q-LCH-03 B）。环境类错误（容器服务没有响应、磁盘空间不够）的结果卡另带 [运行诊断]：去「系统状态」并开始一轮诊断（REQ-SBX-001，Q-SYS-01② A，用户拍板 2026-10-04）。
- **超时**（TIMEOUT）：结果卡按「超时未响应」写（时钟、超时色调，不是红，REQ-SBX-002），树点仍是异常。

**改写了哪条旧文**：P20 L140 / P21-2 L192「失败：进度卡就地变红 + [重试]」、P21-2 L159 / L207「已 ✅ 阶段锁定，仅失败阶段可重试」→ 异步失败转结果卡、按钮叫 [重新发起]（后端没有「从失败阶段重试」的接口，DR-02 A / DR-16）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-LCH-015.1 | e2e | 启动中 | 状态变为 running | 主区换终端并自动连上；树点绿；顶栏徽标「运行中」 | 部分实现：主区换终端已实现（sandboxLifecycle.ts:82，SandboxLifecycleContainer）；树点本来就一直是绿（两色），徽标是 v2 新增 |
| AC-LCH-015.2 | 集成 | 拉取镜像阶段 | 状态变为 failed（IMAGE_PULL_FAILED） | 主区异常结果卡；树点红 + 副行「启动失败：没能把镜像拉下来」；结果卡细则见 REQ-SBX-001 | 部分实现：结果卡已有（SandboxLifecycleContainer.tsx:100–127）；树点与副行未实现（WorkbenchShell.view.tsx:539–564）；按钮语义见 DR-16 |

### REQ-LCH-016 · 刷新恢复与计时锚点 {#REQ-LCH-016}

> 状态 `部分实现` · 版本 MVP · 来源 P20 L445–449；P22 L72（中途关页创建继续）；UX-DS-308（拿不到就降级，不编造）；实现 useSandboxLifecycle.ts:47–55、:86–101、:130，SandboxStartupProgress.view.tsx:42–50、:116–123 · 稿件 无单独稿（f-lch-startup-03 去掉行尾时间即是）

刷新、关标签重开、断线重连之后，准备中的任务照常显示阶段与进度条；「已等待」**只在本页亲眼看到这次状态变化时才显示**——恢复出来的状态没有「何时进入」的锚点，这时行尾不写时间，**不得**补成 0:00。卡住判定在没有锚点时从本页开始观察的那一刻起算（只会更晚提示，不会误报）。创建在后台照常进行，回来如实显示当前阶段。

**改写了哪条旧文**：无（原产品文档没写刷新时的「已等待」；P22 L72 只写了「回来后列表如实显示当前阶段」）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-LCH-016.1 | 组件 | 刷新后恢复出一个 creating 的任务 | 渲染进度卡 | 拉取镜像进行中，行尾没有任何时间；进度条 60% | 已实现：useSandboxLifecycle.ts:90、:130，SandboxStartupProgress.view.tsx:116–123 |
| AC-LCH-016.2 | 集成 | 同上，之后 `PARAM.STUCK_HINT_S` 秒内没有任何新事件 | 计时 | 从刷新那一刻起算，满阈值出卡住提示，提示里的时长按刷新后的算 | 未实现（卡住整条未实现） |

### REQ-LCH-017 · 看得到这个任务用的是哪张镜像：启动进度卡、结果卡、复制诊断信息 {#REQ-LCH-017}

> 状态 `未实现` · 版本 MVP · 来源 Q-LCH-03 B（用户拍板 2026-10-04，原话「补全 10 条按推荐」：启动过程与任务详情里能看到用的是哪张镜像）；P21-2 L119–131（旧进度卡）；DR-16（镜像类错误去镜像管理要能定位到那一张）；实现 sandbox.schema.ts:178–275（SandboxDto 没有镜像字段），sandbox-application.service.ts:298（库里 sandboxes.image_ref 存着版本行 id），SandboxStartupProgress.view.tsx，SandboxOutcome.view.tsx:59–76、:106–118 · 关联 REQ-LCH-004、REQ-LCH-012、REQ-SBX-001、REQ-SBX-003、REQ-SBX-004、REQ-SBX-005、REQ-SBX-012、REQ-IMG-025 · 待裁决 Q-LCH-03（已拍板 B）· 稿件 f-lch-startup-03、04、05，f-sbx-relaunch-01、02，f-sbx-stopstart-02、04（各加「镜像」一行）

弹层里能选镜像之后（REQ-LCH-004），任务**必须**能看出自己用的是哪张镜像、哪一版——不然出了镜像类的错，用户不知道该去镜像管理看哪一张：

- **启动进度卡**（首次启动与从已停止重新启动，REQ-LCH-012、REQ-SBX-013）：标题之后一行次要文字「镜像：<坐标>」，用平台预制镜像时写「镜像：<坐标>（平台预制镜像）」；与主语行同一写法，放在播报的容器之外，不进播报。
- **结果卡**（异常、超时未响应、已停止，REQ-SBX-001、002、012）：主语行「任务：<任务名>」之后同级一行「镜像：…」，同样不进播报。
- **[复制诊断信息]**：复制文本在「任务：」之后多一行「镜像：<坐标>@<完整版本号>」（REQ-SBX-005）。
- **运行中的任务**：任务菜单最上面一行只读的「镜像：…」（不是菜单项，不可点、不进 Tab 顺序）；无头任务的只读详情里同样一行。

写的是**这个任务锁定的那一版**（REQ-IMG-025）：之后这张镜像怎么更新、切换，这一行都不变。数据**必须**由后端随任务给（SandboxDto 回显所用镜像：版本行 id、坐标、版本号、是不是平台预制镜像），刷新后仍在；前端**不得**拿「镜像管理里这张镜像现在的当前版本」去冒充。

**改写了哪条旧文**：无（新增；原产品文档里任务不显示镜像，旧进度卡 P21-2 L119–131 只在「拉取镜像」一格写字节进度）——2026-10-04 用户拍板 Q-LCH-03 B 后补。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-LCH-017.1 | API | 任务用 docker.io/acme/ml-agent:v1.0（版本 sha256:8e05a…d77）建成 | `GET /api/sandboxes/{id}`；之后把 ml-agent 切到别的版本，再取一次 | 两次都带这个任务锁定的镜像：版本行 id、坐标、版本号、是不是平台预制镜像；不随镜像管理里的切换变 | 未实现：SandboxDto 没有镜像字段（sandbox.schema.ts:178–275）；库里存着版本行 id（sandbox-application.service.ts:298），没有回显 |
| AC-LCH-017.2 | 组件 | 用 docker.io/acme/ml-agent:v1.0 新发起的任务在「拉取镜像」 | 渲染启动进度卡 | 标题之后一行「镜像：docker.io/acme/ml-agent:v1.0」；用平台预制镜像的任务写「镜像：ghcr.io/agent-infra/sandbox:latest（平台预制镜像）」；这一行不进播报 | 未实现：进度卡不写镜像（SandboxStartupProgress.view.tsx）（稿件 f-lch-startup-03 随拍板补画） |
| AC-LCH-017.3 | 组件 | 异常任务「迁移构建脚本」（IMAGE_PULL_FAILED，用平台预制镜像） | 渲染结果卡 | 主语行之后「镜像：ghcr.io/agent-infra/sandbox:latest（平台预制镜像）」；超时卡、已停止卡同样有这一行 | 未实现：结果卡只有标题与主语行（SandboxOutcome.view.tsx:106–118）（稿件 f-sbx-relaunch-01、02） |
| AC-LCH-017.4 | 组件 | 同上 | 点 [复制诊断信息] | 复制文本「任务：」之后一行「镜像：ghcr.io/agent-infra/sandbox:latest@sha256:…」 | 未实现：拼的几行里没有镜像（SandboxOutcome.view.tsx:59–76） |
| AC-LCH-017.5 | 组件 | 一个运行中的交互式任务；一个无头任务 | 打开前者的任务菜单；看后者的只读详情 | 菜单最上面一行只读「镜像：…」（不可点、不进 Tab 顺序）；只读详情里同一行 | 未实现：任务行还没有菜单（REQ-SBX-010），只读详情不写镜像（HeadlessTaskDetail.view.tsx） |

---

## 附录 A · 改写对照（逐条，来自各片段）

### 改写对照（旧文 → 本片）（lch-a）

| 旧文 | 位置 | 改写为 | 依据 |
|---|---|---|---|
| P20 L101「弹窗内不放项目下拉…只读回显」；F21-2 N.0 | REQ-LCH-001 | 可以选项目（只列就绪，未就绪置灰写原因），不嵌套建项目 | Q-DS-29 A |
| P21-2 L53、L90–91、L200–201、L225；P21-6 L11「＋ 新建项目…」与回程保值 | REQ-LCH-001 | 删掉 | Q-DS-29 A、P20 §8.4 L438、F21-2 L123 |
| P20 L85–89「入口三处」；P21-2 L11 | REQ-LCH-001 | 八个入口打开同一个弹层 | Q-DS-27 A、Q-DS-28 A、REQ-SBX-003 |
| P20 L168；P21-2 L183 / L199 / L230；F21-2 L124「记住上次选择」 | REQ-LCH-002 | 不预选、不记住 | 实现 SandboxTerminalContainer.tsx:83–85、F21-2 L501 |
| 实现组标题「Agent（runtime）· 必选」 | REQ-LCH-002 | 「Agent · 必选」 | Q-DS-21 A |
| P21-2 L7 / L184、P20 L414「选中 runtime 即插入拦截面板」 | REQ-LCH-003 | 只出闸门句与按钮，点了才展开 | FE1 |
| P21-2 L188「配置完成 2s 后自动进确认步」 | REQ-LCH-003 | 停留到用户看见 | DR-21 |
| P20 L115「留空 = 基线分支」 | REQ-LCH-004 | 「跟随项目当前的分支（默认）」 | 实现 SandboxTerminalContainer.tsx:327–329 |
| P20 L122–124、P21 L98、P21-4 L30 / L244「向导镜像下拉」；P21-4 L34「[注册新镜像]」 | REQ-LCH-004、017 | 可选「镜像」字段，默认平台预制镜像，不能用的置灰写原因，不放注册入口；任务上写出所用镜像；「高级选项」仍不做 | Q-LCH-03 B（用户拍板 2026-10-04） |
| P21-2 L98「超限就地红字计数」；plan「PARAM.PROMPT_MAX_CHARS」 | REQ-LCH-005 | 补「不可发起」与码点数法；参数名 `PARAM.TASK_PROMPT_MAX` | format-pilot params.yaml:234 |
| （无）弹层自己的加载与失败；实现「Agent 列表加载失败：{原串}」 | REQ-LCH-006 | 新增；「Agent 列表没读出来：<人话原因>。」 | v1 g3-12 / g3-13、UX-DS-402 |
| P22 L10「[停止部分任务] / [稍后重试]」；P22 L67「进度卡第一步即红」；P21-2 L148 | REQ-LCH-007 | 资源不够同步返回、留在弹层，建议句「销毁不用的任务才能腾出名额」 | DR-03 A、DR-15 默认 |
| P22 §1.1「这六条」 | REQ-LCH-007 | 七条，补 BRANCH_NOT_FOUND | 契约与实现已有 |
| P20 L140 / L393、P21-2 L192「失败：进度卡变红 + [重试] / 回弹窗改配置」 | REQ-LCH-007、015 | 同步失败在弹层就地说（指令放回），异步失败转结果卡 | DR-02 A |
| 实现「提交即清空、失败也不回填」 | REQ-LCH-007 | 同步失败回填，只放局部状态 | DR-02 A |
| P20 L116、P21-2 L92–93「模式：交互式 / 无头」；实现「改发无头任务就可以」 | REQ-LCH-008 | 不出模式选择；句子只说事实和去处 | DR-01 A、DR-25 |
| P21 L11、P21-2 L1–2 / L11–12 / L41–43「/new 路由、预选 runtime、刷新即关闭」 | REQ-LCH-009 | `?new=1&project=`，刷新恢复弹层与项目，指令为空并明说 | P20 §8.3、F21-2 §2.1 |
| P20 L429「项目不存在 → 回落工作台常态」 | REQ-LCH-009 | 回落项目总览并说一句；未就绪项目说明还不能发起 | Q-DS-35① |
| P20 L126「[创建]」、P21-2 L113「[发起]」 | REQ-LCH-010 | 「发起任务并打开终端」 | 实现 |
| P20 L136「返回 202」 | REQ-LCH-010 | `201` | sandbox.controller.ts:36–41 |
| P20 L417、P21-2 L205「创建中取消需确认」 | REQ-LCH-010、014 | 受理前不可取消；受理后走「取消并删除」 | Q-DS-16 A |
| P21-2 L117–131 形态 D、L206 [后台运行]；P20 L389–392 | REQ-LCH-011 | 进度在主区，没有 [后台运行] | 实现、v1 g3-14 / g2-01 |
| P21 L46「准备中脉冲黄点」 | REQ-LCH-011 | 灰色脉冲点 | Q-DS-15 ②A |
| P21-1 L94 筛选「已暂停」档 | REQ-LCH-011 | 「已停止」 | Q-DS-15 ①A |
| P21-2 L119–131、L231、P21 L39–40「五段：…准备工作区 / 启动实例 / 连接终端」 | REQ-LCH-012 | 四段：初始化 / 拉取镜像 / 准备代码副本 / 启动运行环境 | 实现 sandboxLifecycle.ts:33–40 |
| P21-2 L120 / L122 / L127「已耗时」「150/800MB（预计还需 40s）」「参考耗时」 | REQ-LCH-012 | 当前格「已等待 m:ss」，不写字节与预计剩余 | 实现 useSandboxLifecycle.ts:47–55 |
| 实现「拉到本机」「下载并铺开运行环境」「正在启动 agent」 | REQ-LCH-012 | 「下载到本机」「下载到本机并启动运行环境」「正在启动 Agent」 | Q-DS-21 A |
| P21 L115「>10min」；P21-2 L128–129 / L144 / L151 / L233「>5min」；P22 L71「整体 >10min」 | REQ-LCH-013 | 一律引用 `PARAM.STUCK_HINT_S`（暂行 300 秒） | Q-DS-16 A |
| P21-2 L126 / L157 / L191、P22 L71「[强制停止]」 | REQ-LCH-013、014 | 「取消并删除」（删除、释放名额），与 [继续等待] 同时出现 | Q-DS-16 A |
| 本片原写「取消并删除一律不给『留下来』」 | REQ-LCH-014 | 首次启动不给；从已停止重新启动的给二选一、默认留下来 | Q-SBX-02 B（用户拍板 2026-10-04） |
| P21-2 L159 / L207「仅失败阶段可重试」 | REQ-LCH-015 | [重新发起] 打开新建弹层 | DR-02 A、DR-16 |

## 附录 B · 片段里的默认决定与待确认（原文）

> 下面是各片段的原文，编号仍是片段里的本地编号；统一编号与完整的选项、推荐、默认在 [open-questions.md](./open-questions.md)，对照见其 §7。

### 本片的默认决定与待确认（lch-a）

1. **「项目」下拉的默认项与顺序**（REQ-LCH-001）：plan 只写了「从项目里打开预选该项目」。本片默认：从总览或 ⌘K 打开且没有当前项目时取树里第一个就绪项目；选项顺序同左侧树（当前项目置顶）。改选项目时 Agent 与指令保留、分支回默认。
2. **深链指向未就绪项目的那句说明**（REQ-LCH-009）是本片新增的文案：克隆中「「X」还在克隆，克隆完成后才能发起任务。」，克隆失败「「X」克隆失败了，重试克隆或改为空项目之后才能发起任务。」——画面就是 F-PRJ-CLONE 的克隆进度 / 克隆失败主区，本片不另出稿，需看文案。
3. **「需要你处理」的排序**（REQ-LCH-013）：异常 > 可能卡住 > 等待你输入（UX-DS-112 只排了异常 > 等待输入；可能卡住按严重程度插在中间）。
4. **刷新后的卡住计时**从本页开始观察的时刻起算（REQ-LCH-016）：只会更晚提示，不会误报。
5. **弹层里的资源不够不另放 [稍后重试]**（REQ-LCH-007）：与实现一致（文案表 RESOURCE_EXHAUSTED 的 actions 在弹层里本来就不渲染，NewSandboxPanel.view.tsx:436–440 只渲染一句话）；名额腾出来后再点主按钮就是重试。
6. **卡住说明句只定了「拉取镜像」这一格**（REQ-LCH-013，稿件 f-lch-startup-05 与 v1 g2-03 同句）；其余三格的说明句待补（初始化 / 准备代码副本 / 启动运行环境卡住时说什么，各自可能的原因不同），补之前用不带原因的通用句「这一步通常会持续推进；这么久没有任何进展，可能出了问题。」。
7. **任务菜单里的「删除…」对准备中任务**：沿用 REQ-SBX-020 的入口，确认内容与 REQ-LCH-014 同一张（标题按状态写「取消并删除任务…」）；待 lch-b 在 SBX 片段里对齐。
8. **Q-LCH-01（指令计数单位）**：format-pilot params.yaml:236 已点名、open-questions.md 里还没立项。本片按 P21-1 L138 写「码点」，要求契约（zod 现按 UTF-16 单元）与数据库（SQLite `length()` 按字符）跟上；AC-LCH-005.2 在裁决前保持「偏离」。
9. **Q-LCH-02（拟，展示格回退）**：展示序与状态机序不同（P21 L42 的刻意设计），而格的做完 / 进行中按展示下标判（SandboxStartupProgress.view.tsx:89）。于是 preparing-workspace（约 5 秒）期间「拉取镜像」先打勾，进入 creating 后又回到进行中、「准备代码副本」又回到未开始；而 creating 时代码副本其实已经备好（v1 g2-04 头注释同一观察）。选项：**A** 展示序改成状态机序（初始化 → 准备代码副本 → 拉取镜像 → 启动运行环境），格只进不退、与百分比一致，改 f-lch-startup-03 / 04 / 05 与 lch-b 的 f-sbx-stopstart-03 的格顺序（需看稿）；**B** 保留展示序，格按「这一步做完没有」判（creating 时「准备代码副本」打勾，会出现「进行中排在已完成之前」的跳格）；**C** 维持现状、接受这几秒的回退。本轮稿件按 C 画（与实现一致），推荐 A。
10. **DR-15**（配额满算不算门口拒绝）仍按不回复默认：429 走红色「创建失败」。若改选推荐（标 `sideEffectFree`），REQ-LCH-007 的资源不够改走琥珀路径、句尾加「（本次请求未创建任何任务）」。
11. **2026-10-04 用户拍板（原话「补全 10 条按推荐」），本片随之改写**：Q-LCH-03 → B，弹层加可选「镜像」字段（REQ-LCH-004 改写为 10 条 AC）、任务上看得到所用镜像（REQ-LCH-017 新增，用 F-LCH-STARTUP 段的空号 017）、[重新发起] 预填镜像（REQ-SBX-003）；Q-SBX-02 → B，取消并删除按首次启动 / 重新启动分开（REQ-LCH-014，AC-LCH-014.4 新增）；Q-SYS-01② → A，环境类错误的结果卡带 [运行诊断]（REQ-LCH-015 引 REQ-SBX-001）；Q-SBX-03 → A，确认里的「工作目录」统一为「代码副本」。

## 附录 D · 边界、覆盖对照、待核实与连带更正

### 待核实（代码阅读结论，未实测）（lch-a）

1. **空组「发起第一个任务」对未就绪项目造成幽灵弹层**（plan.md「待核实」第 3 条）：成立。WorkbenchShell.view.tsx:495–521 对任何 0 任务的组都渲染这个按钮（克隆中 / 克隆失败的项目永远是 0 任务），点击 = `onSelectProject` + `onNewTask`，不看 `newTaskDisabledReason`（侧栏 [＋ 新任务] 才看，:579）；`onNewTask` 无条件 `setCurrentModal('newTask')`（WorkbenchContainer.tsx:378–380）；而未就绪项目的主区不挂 `SandboxTerminalContainer`（:289–320），弹层没有容器可渲染——`currentModal` 停在 `'newTask'`，深链钩子照常把 `?new=1&project=<id>` 推进地址栏（useDeepLinkModal.ts:122–135）。项目后来经 WS 转为就绪时没有任何地方清 `currentModal`（全仓 `setCurrentModal(null)` 只在选项目、`handleProjectReady`、关弹层等处，WorkbenchContainer.tsx:180、:186、:242，SandboxTerminalContainer.tsx:352、:370），容器一挂载弹层就「突然」出现，而且因为地址上的参数正指着这个项目，还会误出「刷新后指令未保留，请重新输入」（SandboxTerminalContainer.tsx:125–129）。只有经恢复面板 / 组头菜单的 [重试克隆]、[改为空项目] 走 `handleProjectReady` 的路径会把它清掉。修法：空组按钮只对就绪项目渲染（AC-LCH-001.4），或 `onNewTask` 先判就绪。
2. **对准备中任务发 DELETE**：01 §3.2 复核 B2 记的是「对 pending 返回 500」；按代码，pending / scheduling / preparing-workspace / creating 四个状态都会在 `→ destroying` 时被状态机拒（sandbox-status.vo.ts:39–52），错误没有 HTTP 映射（provider-error.http.ts:38–59 只映射 SandboxProviderError）→ 500；其中能转 failed 的三个状态还会被 catch 分支改成 failed（sandbox-application.service.ts:768–772）——用户点了「取消并删除」，任务反而变成「异常」留在树上。只有 starting 走得通（:739–740）。见 AC-LCH-014.2，依赖 BE2。
3. **指令长度三处数法不同**：前端 `Array.from` 数码点（NewSandboxPanel.view.tsx:178–179，注释写「与后端口径一致」不成立）；契约 zod v3 `z.string().max(8000)` 比的是 `input.data.length`，即 UTF-16 单元（sandbox.schema.ts:57；zod@3.25.76 `v3/types.js:509–510`）；SQLite CHECK 用 `length()` 数字符（params.yaml:248）。含 emoji 的长指令会「前端放行、后端 400」。见 AC-LCH-005.2，Q-LCH-01。

## 附录 E · 合并时改动的地方

合并只做了下面这些改动；其余文字都是片段原文（本地待定编号已换成统一编号）。

| 需求 | 改动 | 为什么 |
|---|---|---|
| [REQ-LCH-001](#REQ-LCH-001) | 改写一句 | 未就绪原因按 REQ-PRJ-016 分两句（原文是现行实现的一句，对克隆失败不成立） |
| [REQ-LCH-001](#REQ-LCH-001) | 加合并说明 | 与 REQ-PRJ-016 统一；补离线置灰的交叉引用 |
| [REQ-LCH-004](#REQ-LCH-004) | 加合并说明 | 与 REQ-IMG-051、030 互相引用（Q-LCH-03 已拍板 B） |
| [REQ-LCH-007](#REQ-LCH-007) | 加合并说明 | 与 REQ-SYS-071 统一（同一组数，契约未到前不写） |
| [REQ-LCH-009](#REQ-LCH-009) | 改写一句 | 回落句按 REQ-WB-040 统一，不把 id 上屏；补全占位编号 REQ-WB-04x |
| [REQ-LCH-009](#REQ-LCH-009) | 加合并说明 | 与 REQ-WB-040 统一 |
| [REQ-LCH-014](#REQ-LCH-014) | 加合并说明 | 按 lch-b 待定 ③（Q-SBX-02）区分首次启动与重新启动 |
