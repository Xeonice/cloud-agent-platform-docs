---
id: PRD-PRJ
title: 项目管理 · 产品需求
type: prd
status: draft
owner: 产品 owner（仓库唯一人类 owner）
domains: [PRJ]
flows: [F-PRJ-CREATE, F-PRJ-CLONE, F-PRJ-INFO, F-PRJ-DETAIL, F-PRJ-DELETE, F-PRJ-RETAINED]
applies_to: ">= v0.2.4"
last_verified:
  docs: fd2e1ee
  api: a453bb7
  web: 93f03c5
  date: 2026-10-04
covers:
  - web/src/views/project/{NewProjectForm,CloneProgress,ProjectGroupHeader,ProjectGroupMenu}.view.tsx
  - web/src/containers/project/{NewProjectContainer,ProjectRecoveryContainer}.tsx
  - web/src/containers/workbench/WorkbenchContainer.tsx（新任务原因、主区分支、组头菜单接线）
  - web/src/views/workbench/WorkbenchShell.view.tsx（新建入口、空组入口）
  - web/src/hooks/project/{useProjects,useProjectClone,useProjectRecovery}.ts
  - web/src/lib/project/{projectClone,projectErrorCopy,selectProjectTaskTree}.ts
  - web/src/stores/createProjectCloneSlice.ts
  - api/packages/modules/project/src/application/{project-application.service,clone-project.workflow}.ts
  - api/packages/modules/project/src/domain/{entities/project.entity,value-objects/project-status.vo}.ts
  - api/packages/contracts/src/schemas/project.schema.ts
  - web/src/views/project/{ProjectInfoBar,ProjectDetailPanel,DeleteProjectConfirm,RetainedVolumesPanel,ProjectGroupMenu}.view.tsx
  - web/src/containers/project/ProjectMenuContainer.tsx
  - web/src/containers/workbench/WorkbenchContainer.tsx（只读条、项目详情 / 删除确认 / 成果弹层的装配）
  - web/src/hooks/project/{useProjectBranches,useProjects,useRetainedVolumes}.ts
  - web/src/lib/project/{projectClone,projectDeletion,projectErrorCopy,retainedVolumeModel,selectProjectTaskTree}.ts
  - web/src/app/settings/system/page.tsx、web/src/containers/system/SystemStatusContainer.tsx、web/src/views/system/ResourcePoolCard.view.tsx、web/src/lib/system/resourceModel.ts（系统状态 [清理成果] 入口，旧称 [清理保留卷]）
  - api/packages/modules/project/src/application/{project-application.service,sync-baseline.workflow,retained-volume.service}.ts
  - api/packages/modules/project/src/domain/entities/project.entity.ts
  - api/packages/modules/automation/src/infrastructure/persistence/schema/automation.sqlite.ts、api/drizzle/0018_hesitant_bushwacker.sql
supersedes:
  - docs/product/pages/21-6-项目管理.md（§2、§3.1、§3.2、§4、§6、§9 里关于新建项目、克隆、克隆失败处置的规则）
  - docs/product/20-核心使用链路.md（§8.2 L407、L409 两行）
  - docs/product/22-异常场景与产品补充要求.md（§2「项目阶段」L56、L57、L59 三行）
  - docs/frontend/pages/21-6-项目管理.md（§4–§6、§9.4 中的产品规则与验收）
  - docs/product/pages/21-6-项目管理.md §3.3（L52-63）、§6「[删除项目]」行（L102）、§9 第 2、5 条（L116、L118）
  - docs/product/20-核心使用链路.md L339（「已保留卷」名称与 v1.1 标注）
  - docs/product/22-异常场景与产品补充要求.md §2「删除项目」行（L60）
  - docs/product/pages/21-5-系统状态.md L89（倒计时起点）
  - docs/product/pages/21-7-自动化.md L170（删项目时规则「运行中的等完成或超时取消」）
  - docs/frontend/pages/21-6-项目管理.md §9.2、§9.3、L186、§9.1 #15–17 中的产品口径
drafts:
  - gap/drafts/f-prj-create-01…08.html、gap/drafts/f-prj-clone-01…07.html（说明 gap/drafts/notes/prj-a.md）
  - gap/drafts/f-prj-info-01…05、f-prj-detail-01、f-prj-delete-01…04、f-prj-retained-01…05（说明 gap/drafts/notes/prj-b.md）
merged_from:
  - gap/product/_parts/prj-a.md
  - gap/product/_parts/prj-b.md
merged_at: 2026-10-04
review_minutes: 60
---

# 项目管理 · 产品需求

<!-- 本文件只写「做什么 / 为什么 / 怎样算做对」。布局与视觉在稿件（gap/drafts/f-*），实现方法在技术设计。由 gap/product/_build/merge.py 从 _parts 合并生成；改片段后重新运行。「现状」列暂留文件:行出处，入库时按 01 §4.2 换成证据 ID。 -->

## 一屏摘要

- **这一域回答什么**：项目从新建、克隆（克隆中 / 克隆失败的处置）、项目信息与拉取、项目详情、删除，到「保留下来的成果」的全过程（6 个流程，REQ-PRJ-001–059）。旧口径散在 P20、P21-6、F21-6、P22，逐条改写见各条「改写了哪条旧文」与文末附录 A。
- **五条要守的规则**：
  1. 新建项目只有一个弹层，四处入口都打开它；新建任务弹层里**不得**嵌套新建项目（REQ-PRJ-001）。
  2. 克隆进度按阶段与对象数说，拿不到分母**不得**编百分比；失败出口按失败码给，权限类与「打不开仓库」**不给** [重试克隆]（REQ-PRJ-004、005、014）。
  3. 未就绪项目不能发起任务，原因按克隆中 / 克隆失败分两句，**不得**对克隆失败的项目说「克隆完成后可发起」（REQ-PRJ-016）。
  4. 删除项目打开即说清能不能删；失败时项目**原样保留**，代码目录在事务提交之后才删（REQ-PRJ-040、043）。
  5. 屏上统一叫「保留下来的成果」，被销毁任务留下的那份叫「代码副本」，「保留卷」「工作目录」不再上屏（含系统状态页，Q-SYS-23 A、Q-SBX-03 A）；倒计时只属于成果，按每份自己的到期时间（REQ-PRJ-050、055）。
- **现状**：29 条需求里 `已实现` 3 · `部分实现` 15 · `未实现` 2 · `偏离` 9。偏离与缺口集中在前端：入口只有侧栏一个、克隆中的主区没有进度、未就绪的空组仍给「发起第一个任务」（幽灵弹层）、组头菜单对权限类失败也给 [重试克隆]、项目信息是常驻条而不是浮层、系统状态的 [清理成果]（今天叫 [清理保留卷]）点了没反应、成果弹层与删除项目确认还写「工作目录」。后端：删项目不拦活跃任务、有自动化规则时 500 且先删了代码目录、排队中的克隆被取消后停在「克隆中」。
- **待定**：Q-PRJ-01…09（[open-questions.md](./open-questions.md)）。其中 Q-PRJ-06 已于 2026-10-04 拍板 A（成果行写来源任务名，与默认相同，要后端快照）；同日拍板的 Q-SYS-23 A、Q-SBX-03 A 让本域屏上统一叫「保留下来的成果」「代码副本」（REQ-PRJ-050，AC-PRJ-050.6）。

**状态词表**：`已实现`（行为与本文一致）· `部分实现` · `未实现` · `偏离`（实现与本文不同）· `实现先行`（代码已有、原产品文档没写，待确认）· `未核实` · `计划中`（目标版本未到，或待某条待定问题选定后才生效）。「层级」= 最低验证层（单元 / 组件 / 集成 / API / e2e；`文档` = 文档一致性检查，`视觉` = 截图比对）。

## 需求索引

**共 29 条需求、136 条验收标准**：`已实现` 3 · `部分实现` 15 · `未实现` 2 · `偏离` 9。

| 编号 | 需求 | 状态 | 版本 | AC | 稿件 | 待定问题 |
|---|---|---|---|---:|---|---|
| [REQ-PRJ-001](#REQ-PRJ-001) | 入口：四处入口打开同一个「新建项目」弹层 | `部分实现` | MVP | 6 | f-prj-create-01 | [Q-PRJ-01](./open-questions.md#Q-PRJ-01) [Q-DS-29](./open-questions.md#Q-DS-29) [Q-DS-31](./open-questions.md#Q-DS-31) |
| [REQ-PRJ-002](#REQ-PRJ-002) | 字段与校验：名称、来源、仓库地址、分支 | `部分实现` | MVP | 6 | f-prj-create-01、f-prj-create-02 | — |
| [REQ-PRJ-003](#REQ-PRJ-003) | 提交与被拒：按码就地一句、输入全部保留 | `已实现` | MVP | 6 | f-prj-create-03 | [Q-PRJ-01](./open-questions.md#Q-PRJ-01) |
| [REQ-PRJ-004](#REQ-PRJ-004) | 克隆进度：同一弹层换视图，按阶段与对象数说进度 | `部分实现` | MVP | 8 | f-prj-create-04、f-prj-create-05 | — |
| [REQ-PRJ-005](#REQ-PRJ-005) | 克隆的结果：完成，或按失败码给出口 | `部分实现` | MVP | 5 | f-prj-create-06、f-prj-create-07、f-prj-create-08 | — |
| [REQ-PRJ-006](#REQ-PRJ-006) | 空项目：提交即就绪，不经进度视图 | `偏离` | MVP | 2 | f-prj-create-02 | — |
| [REQ-PRJ-010](#REQ-PRJ-010) | 克隆中 / 克隆失败的项目可以选中；三处给同一组动作 | `部分实现` | MVP | 4 | f-prj-clone-01、f-prj-clone-04 | — |
| [REQ-PRJ-011](#REQ-PRJ-011) | 树：未就绪项目的组头（徽标、计数位、折叠箭头） | `偏离` | MVP | 4 | f-prj-create-04、f-prj-clone-01、f-prj-clone-04 | [Q-PRJ-03](./open-questions.md#Q-PRJ-03) |
| [REQ-PRJ-012](#REQ-PRJ-012) | 克隆中项目的主区：进度卡 | `未实现` | MVP | 4 | f-prj-clone-01、f-prj-clone-02 | — |
| [REQ-PRJ-013](#REQ-PRJ-013) | 取消克隆（保留项目） | `部分实现` | MVP | 6 | f-prj-clone-03、f-prj-clone-06 | — |
| [REQ-PRJ-014](#REQ-PRJ-014) | 重试克隆 | `部分实现` | MVP | 7 | f-prj-clone-04、f-prj-clone-05、f-prj-clone-06 | — |
| [REQ-PRJ-015](#REQ-PRJ-015) | 改为空项目 | `已实现` | MVP | 4 | f-prj-clone-04、f-prj-clone-07 | [Q-PRJ-02](./open-questions.md#Q-PRJ-02) |
| [REQ-PRJ-016](#REQ-PRJ-016) | 未就绪项目不能发起任务：原因分两句 | `偏离` | MVP | 5 | f-prj-clone-01、f-prj-clone-04 | [Q-DS-29](./open-questions.md#Q-DS-29) |
| [REQ-PRJ-020](#REQ-PRJ-020) | 项目信息：只读四项 / 空项目两项，分支缺省「远端默认分支」，chip 与 ⓘ 打开同一张浮层 | `偏离` | MVP | 5 | f-prj-info-01、f-prj-info-02 | [Q-PRJ-09](./open-questions.md#Q-PRJ-09) |
| [REQ-PRJ-021](#REQ-PRJ-021) | 拉取最新代码：仅就绪的 Git 项目，按下之前说清作用范围，拉取中两处同态 | `部分实现` | MVP | 6 | f-prj-info-01、f-prj-info-03 | — |
| [REQ-PRJ-022](#REQ-PRJ-022) | 拉取的结果：成功一句、失败按原因说并给去处，原位播报 | `偏离` | MVP | 6 | f-prj-info-04、f-prj-info-05 | [Q-PRJ-08](./open-questions.md#Q-PRJ-08) [Q-DS-35②](./open-questions.md#Q-DS-35) |
| [REQ-PRJ-030](#REQ-PRJ-030) | 项目详情：独立只读弹层五行，计数不知道写「—」，零按钮 | `部分实现` | MVP | 5 | f-prj-detail-01 | — |
| [REQ-PRJ-040](#REQ-PRJ-040) | 删除项目打开即说清：活跃任务与没清理的成果拦下并给去处 | `偏离` | MVP | 6 | f-prj-delete-02 | [Q-PRJ-04](./open-questions.md#Q-PRJ-04) [Q-PRJ-05](./open-questions.md#Q-PRJ-05) [Q-PRJ-07](./open-questions.md#Q-PRJ-07) |
| [REQ-PRJ-041](#REQ-PRJ-041) | 可删时如实列出：会删掉 / 删掉之后 / 不受影响 | `偏离` | MVP | 4 | f-prj-delete-01 | — |
| [REQ-PRJ-042](#REQ-PRJ-042) | 删除正在克隆的项目：先停克隆再删，就地给 [取消克隆（保留项目）] | `部分实现` | MVP | 3 | f-prj-delete-03 | — |
| [REQ-PRJ-043](#REQ-PRJ-043) | 删除中不可关、失败就地说、项目原样保留 | `偏离` | MVP | 3 | f-prj-delete-04 | — |
| [REQ-PRJ-044](#REQ-PRJ-044) | 删除成功：各处同时消失，删的是当前项目时回总览并说一句 | `部分实现` | MVP | 2 | — | [Q-DS-35①](./open-questions.md#Q-DS-35) |
| [REQ-PRJ-050](#REQ-PRJ-050) | 「保留下来的成果」：统一名称，五个入口打开同一个弹层 | `部分实现` | MVP | 6 | f-prj-retained-01、f-prj-retained-05 | [Q-PRJ-07](./open-questions.md#Q-PRJ-07) [Q-SBX-03](./open-questions.md#Q-SBX-03) [Q-SYS-23](./open-questions.md#Q-SYS-23) [Q-DS-33](./open-questions.md#Q-DS-33) |
| [REQ-PRJ-051](#REQ-PRJ-051) | 成果列表：按到期先后、来源任务名、两个大小、三档倒计时、合计与读法 | `部分实现` | MVP | 5 | f-prj-retained-01、f-prj-retained-05 | [Q-PRJ-06](./open-questions.md#Q-PRJ-06) |
| [REQ-PRJ-052](#REQ-PRJ-052) | 下载：浏览器原生下载，不做恢复 | `已实现` | MVP | 2 | f-prj-retained-01 | — |
| [REQ-PRJ-053](#REQ-PRJ-053) | 删除一份成果：同一弹层就地切成统一确认，删除中只禁这一行 | `偏离` | MVP | 5 | f-prj-retained-02 | — |
| [REQ-PRJ-054](#REQ-PRJ-054) | 空与读取失败两个分支不混，读取失败给 [重试] | `部分实现` | MVP | 3 | f-prj-retained-03、f-prj-retained-04 | — |
| [REQ-PRJ-055](#REQ-PRJ-055) | 倒计时只属于保留下来的成果，按每份自己的到期时间 | `部分实现` | MVP | 4 | f-prj-retained-01 | — |
| [REQ-PRJ-056](#REQ-PRJ-056) | 跨项目视图：系统状态 [清理成果] 进入，范围「全部项目」、按项目分组 | `未实现` | MVP | 4 | f-prj-retained-05 | [Q-SYS-23](./open-questions.md#Q-SYS-23) [Q-DS-33](./open-questions.md#Q-DS-33) |

「待定问题」一列链到 [open-questions.md](./open-questions.md)，不回复时按那里写的默认走。

## 与旧文档的对照

由各条「改写了哪条旧文」汇总；旧文档代号见 [README](./README.md#旧文档代号)。逐条的旧文与新口径见每条需求，以及文末附录 A。

| 旧文档 | 被改写的位置 → 本文 | 其中作废 / 删去的 |
|---|---|---|
| P20 核心使用链路 | L407 → REQ-PRJ-001；L409 → REQ-PRJ-005；L339 → REQ-PRJ-050；L339 → REQ-PRJ-051；L339、L341 → REQ-PRJ-052；L326-335 → REQ-PRJ-055 | L339（REQ-PRJ-050）；L326-335（REQ-PRJ-055） |
| P22 异常场景与产品补充要求 | L59 → REQ-PRJ-004；L56、L57 → REQ-PRJ-005；L59 → REQ-PRJ-013；L56 → REQ-PRJ-014；L46 → REQ-PRJ-016；L60 → REQ-PRJ-040 | — |
| P21-1 工作台 | L42、L50 → REQ-PRJ-020 | — |
| P21-3 凭证管理 | L189 → REQ-PRJ-005 | — |
| P21-5 系统状态 | L84 → REQ-PRJ-050；L89 → REQ-PRJ-055；L84 → REQ-PRJ-056 | — |
| P21-6 项目管理 | L7、L31、L11、L129 → REQ-PRJ-001；L41-47、L49 → REQ-PRJ-002；L120 → REQ-PRJ-003；L49、L98 → REQ-PRJ-004；L76、L75、L77 → REQ-PRJ-005；L98 → REQ-PRJ-006；L28-29 → REQ-PRJ-010；L28、L28-29 → REQ-PRJ-011；L75 → REQ-PRJ-012；L98 → REQ-PRJ-013；L76、L77 → REQ-PRJ-014；L101 → REQ-PRJ-015；全文 → REQ-PRJ-021；全文 → REQ-PRJ-022；§3.3 → REQ-PRJ-030；L102、L118 → REQ-PRJ-040；L61 → REQ-PRJ-050 | L11（REQ-PRJ-001）；L28（REQ-PRJ-011）；L61（REQ-PRJ-050） |
| P21-7 自动化 | L170 → REQ-PRJ-041 | — |
| F21-6 前端·项目管理 | L187 → REQ-PRJ-001；L196、L177 → REQ-PRJ-004；L184、L199、L313 → REQ-PRJ-010；L199 → REQ-PRJ-011；L162 → REQ-PRJ-012；§9.2「主区顶部一条只读信息」、§9.2 → REQ-PRJ-020；§9.3、L290-293 → REQ-PRJ-021；§10.2 → REQ-PRJ-030；L186 与 §9.1 → REQ-PRJ-040；§10.6 → REQ-PRJ-042；（多处） → REQ-PRJ-043；§9.1 → REQ-PRJ-044 | L184、L199、L313（REQ-PRJ-010）；L199（REQ-PRJ-011） |

只改写实现现状、试点或稿件口径（不涉及上表旧文档）的需求：REQ-PRJ-053、REQ-PRJ-054。

---

## PRJ · 新建项目（F-PRJ-CREATE）

### REQ-PRJ-001 · 入口：四处入口打开同一个「新建项目」弹层 {#REQ-PRJ-001}

> 状态 `部分实现` · 版本 MVP（入口随 v2 外壳）· 来源 P21-6 L7、L11、L31；P20 L407、L438；P21-8 L404（离线时项目管理不置灰）；Q-DS-29 A；Q-DS-31 A；Q-DS-27 A、Q-DS-28 A（⌘K、总览）；实现 WorkbenchShell.view.tsx:588-590、WorkbenchContainer.tsx:375-377、461-465 · 关联 REQ-WB-001–009（欢迎态，F-WB-WELCOME）、REQ-WB-030–039（⌘K，F-WB-CMDK）· 待裁决 Q-PRJ-01 · 稿件 f-prj-create-01

新建项目**必须**只有一个弹层（标题「新建项目」）。以下入口**必须**都打开它：侧栏「项目」分区标题右侧的「新建项目」图标按钮；项目总览「新建 ⌄」菜单里的「新建项目…」；⌘K 命令面板的「新建项目…」（同义词「创建项目」）；一个项目都没有时欢迎态的两张入口卡——「用我的代码库」预选来源「Git 仓库」，「开一个空项目」预选「空项目」并预填名称「未命名项目 N」（N 由前端按现有名称取最大值 + 1，后端不自动命名；入口卡本身归 F-WB-WELCOME）。从任一入口打开时，焦点在第一个需要填的字段上。新建任务弹层里**不得**再放「＋ 新建项目…」（弹层不嵌套）：要先关掉它，再从上面的入口新建。离线模式下这些入口照常可用（建项目不依赖模型 API；Git 项目没网时按克隆失败处理，REQ-PRJ-005）。

**改写了哪条旧文**：P21-6 L7、L31「树底 [＋ 新建项目] 常驻入口」→ 侧栏「项目」分区标题的图标按钮（v2 外壳）；P20 L407「唯一入口：左侧树底 / 组头⋯菜单」→ 上述四个入口打开同一个弹层（组头「⋯」里没有新建项目，现状与 v1 都没有）；P21-6 L11「确认步项目行『＋ 新建项目…』」→ 删除（Q-DS-29 A；P20 L438 已取消创建项目弹层嵌在任务弹窗里的例外）；P21-6 L129 / F21-6 L187「欢迎态 [开空项目] 一键直建、跳过弹层」→ 也打开本弹层，只预选来源与预填名称（Q-DS-31 默认 A，不选 C）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-PRJ-001.1 | e2e | 在工作台 | 点侧栏「项目」分区的「新建项目」图标 | 打开「新建项目」弹层；来源默认「Git 仓库」，焦点在「项目名称」 | 部分实现：入口是侧栏底部整宽按钮「＋ 新建项目」（WorkbenchShell.view.tsx:588-590）；弹层与 autoFocus 已实现（WorkbenchContainer.tsx:461-465、NewProjectForm.view.tsx:62） |
| AC-PRJ-001.2 | e2e | 在项目总览 | 点「新建 ⌄」→「新建项目…」 | 打开同一个弹层 | 未实现：实现没有项目总览（Q-DS-28 A） |
| AC-PRJ-001.3 | e2e | 任意页 | 按 ⌘K，输入「新建」或「创建项目」，回车 | 「新建项目…」排在动作组第一，回车打开同一个弹层 | 未实现：实现没有命令面板 |
| AC-PRJ-001.4 | e2e | 一个项目都没有（欢迎态），现有名称里没有「未命名项目 N」 | 分别点「用我的代码库」「开一个空项目」 | 都打开同一个弹层，来源分别预选「Git 仓库」/「空项目」；后者名称预填「未命名项目 1」 | 未实现：欢迎态只有一句「选择左侧项目，或新建一个项目开始。」（WorkbenchContainer.tsx:321-325） |
| AC-PRJ-001.5 | 组件 | 新建任务弹层开着 | 查看项目字段 | 没有「＋ 新建项目…」之类的嵌套入口 | 已实现：新建任务弹层没有项目字段，自然没有嵌套入口（项目下拉要按 Q-DS-29 A 补，归 F-LCH-FORM） |
| AC-PRJ-001.6 | 组件 | 离线模式横幅在 | 查看「新建项目」入口 | 入口可用（[新任务] 置灰而它不置灰） | 已实现：WorkbenchShell.view.tsx:588-590 不受 newTaskDisabledReason 影响 |

### REQ-PRJ-002 · 字段与校验：名称、来源、仓库地址、分支 {#REQ-PRJ-002}

> 状态 `部分实现` · 版本 MVP · 来源 P21-6 L35-50（弹层字段）、L44-45（私有仓提示）；F21-6 §9.4 L295-304（补「分支」、改成真弹窗）；实现 NewProjectForm.view.tsx:33-151、api project.schema.ts:54-59 · 关联 PARAM.PROJECT_NAME_MAX · 稿件 f-prj-create-01、f-prj-create-02

弹层副标题「从 Git 仓库克隆，或创建一个空项目」。字段：

| 字段 | 规则 |
|---|---|
| 项目名称 | 必填；去掉首尾空白后 1–`PARAM.PROJECT_NAME_MAX`（40）个字符，输入框**不得**接受第 41 个字符；不得与现有项目重名（重名由服务端判定，REQ-PRJ-003） |
| 来源 | 单选：Git 仓库（默认）/ 空项目 |
| 仓库地址 | 仅来源为 Git 仓库时出现；必填；等宽字体，占位 `https://github.com/org/repo.git`；下方一句「私有仓库需先配置 Git 凭证（凭证管理 › Git 凭证）。」 |
| 分支（可选） | 仅来源为 Git 仓库时出现；占位「留空 = 仓库的默认分支」；留空时**不得**发这个字段（由远端默认分支决定，前端不猜 `main`） |

来源切到「空项目」时，仓库地址与分支两栏整块不渲染（不是置灰）。必填没满足时 [创建项目] 禁用。页脚左 [取消]、右 [创建项目]。

**改写了哪条旧文**：P21-6 L41-47 弹层示意里的「◉ 从 Git 仓库克隆 / ○ 空项目（从零开始）」「URL:」「[创建] [取消]」→ 按现状改为「Git 仓库 / 空项目」「仓库地址」「创建项目 / 取消」，并补「分支（可选）」（F21-6 §9.4）；P21-6 L49 的进度句移到 REQ-PRJ-004。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-PRJ-002.1 | 组件 | 名称为空或只有空白 | 渲染 | [创建项目] 禁用；提交出去的名称去掉了首尾空白 | 已实现：NewProjectForm.view.tsx:33-37、46 |
| AC-PRJ-002.2 | 组件 | 来源 Git 仓库，名称已填、仓库地址为空 | 渲染 | [创建项目] 禁用（f-prj-create-01） | 已实现：NewProjectForm.view.tsx:36-37 |
| AC-PRJ-002.3 | 组件 | 名称已填 | 切到「空项目」 | 仓库地址与分支两栏不在页面上；[创建项目] 可点（f-prj-create-02） | 已实现：NewProjectForm.view.tsx:100-133 |
| AC-PRJ-002.4 | 集成 | Git 仓库，分支留空 | 提交 | 请求体里没有 `repoBranch` | 已实现：NewProjectForm.view.tsx:49-51 |
| AC-PRJ-002.5 | 组件 | — | 往名称里粘贴 45 个字符 | 只留前 40 个，不等提交后才被拒 | 未实现：输入不限长；超长由服务端 400 `VALIDATION_FAILED`，前端只说「提交的内容不合要求，请检查后再试。」（errorCopy.ts:38） |
| AC-PRJ-002.6 | 组件 | 来源 Git 仓库 | 渲染 | 仓库地址下有私有仓提示一句，并经 aria-describedby 关联到输入框 | 未实现：现状没有这句（P21-6 L44-45 要求；稿件 f-prj-create-01 第 7 条需看稿） |

### REQ-PRJ-003 · 提交与被拒：按码就地一句、输入全部保留 {#REQ-PRJ-003}

> 状态 `已实现` · 版本 MVP · 来源 P21-6 L39-40、L120；P22 §2；实现 NewProjectForm.view.tsx:65-144、useProjects.ts:27-47、projectErrorCopy.ts:19-24、errorCopy.ts:38、56-67；api project-application.service.ts:42、97-142、357 · 关联 PARAM.PROJECT_MAX · 待裁决 Q-PRJ-01 · 稿件 f-prj-create-03

点 [创建项目] 后按钮**必须**变成「创建中…」并禁用，字段只读、[取消] 禁用，直到服务端回答。被拒时弹层**不得**关闭或清空：最后一个字段之后、页脚之前出现一句（以 role="alert" 播报），改完可以直接再提交。句子**必须**按服务端信封里的业务码选，**不得**按 HTTP 状态码推断：

| 情况 | 码 | 用户看到 |
|---|---|---|
| 同名 | `ALREADY_EXISTS`（409） | 项目名已存在，请换一个名称。 |
| 地址不合法 | `INVALID_REPO_URL`（400） | 这个仓库地址看起来不对，检查一下再试。 |
| 到上限 | `PROJECT_LIMIT_REACHED`（400） | 项目数量已经到上限（最多 50 个）。先删掉一个用不上的项目，再建新的。 |
| 来源与地址不配 | `INVALID_PROJECT_SOURCE`（400） | 克隆已有仓库要填仓库地址；空项目则不要填地址。 |
| 名称超长等 | `VALIDATION_FAILED`（400） | 提交的内容不合要求，请检查后再试。 |
| 没有应答 | — | 网络不通，请稍后再试。 |
| 其他 | 未知码 | 创建失败，请稍后重试。（报障时请提供 traceId：…） |

项目数上限 `PARAM.PROJECT_MAX`（50），克隆失败的项目也占名额。入口在满额时照常可点（按现状），由这一句说明，见待裁决 Q-PRJ-01。服务端英文原话**不得**上屏。

**改写了哪条旧文**：P21-6 L120「上限 50 达到时 [＋ 新建项目] 按钮置灰 + tooltip『已达 50 个项目上限，请先删除部分项目』」→ 按现状不置灰、提交时就地说明（DEC-0004 现状为底；v2 有四个入口，名额以服务端为准），列入待裁决 Q-PRJ-01。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-PRJ-003.1 | e2e | 已有 acme-web | 以名称 acme-web 提交 | 出现「项目名已存在，请换一个名称。」（role="alert"）；名称、仓库地址、分支都保留；[创建项目] 可再点（f-prj-create-03） | 已实现：useProjects.ts:43-47、NewProjectForm.view.tsx:135-139 |
| AC-PRJ-003.2 | 单元 | 服务端回 409，码不是 `ALREADY_EXISTS` | 取文案 | 不说「项目名已存在」 | 已实现：useProjects.ts:30-34（按码查表） |
| AC-PRJ-003.3 | 集成 | 请求在途 | 查看弹层 | 按钮「创建中…」禁用，字段只读，[取消] 禁用 | 已实现：NewProjectForm.view.tsx:65、72、109、127、143-146 |
| AC-PRJ-003.4 | 集成 | 已有 50 个项目（含克隆失败的） | 提交 | 上限那句；弹层不关 | 已实现：api project-application.service.ts:124-131；projectErrorCopy.ts:20 |
| AC-PRJ-003.5 | 集成 | 断网 | 提交 | 「网络不通，请稍后再试。」 | 已实现：useProjects.ts:45 |
| AC-PRJ-003.6 | 单元 | 未知码，信封带 traceId | 取文案 | 「创建失败，请稍后重试。（报障时请提供 traceId：…）」，不出现服务端原话 | 已实现：errorCopy.ts:56-67 |

### REQ-PRJ-004 · 克隆进度：同一弹层换视图，按阶段与对象数说进度 {#REQ-PRJ-004}

> 状态 `部分实现` · 版本 MVP · 来源 P21-6 L49、L75、L98；P22 L59；LIVE-RUN-FINDINGS L13、L84-93（L-2）；F21-6 L149、L177、L196；实现 CloneProgress.view.tsx:52-105、useProjectClone.ts:39-102、projectClone.ts:9-69、createProjectCloneSlice.ts:48；api clone-project.workflow.ts:21-33、81-88、129-201 · 关联 REQ-PRJ-012 · PARAM.CLONE_SLOW_AFTER_S · PARAM.CLONE_TIMEOUT_MIN · PARAM.CLONE_CONCURRENCY · 稿件 f-prj-create-04、f-prj-create-05

Git 项目的提交被接受后（服务端先落库、状态「克隆中」，项目立即出现在树、总览与 ⌘K 里），同一个弹层**必须**立即换成进度视图，不等第一帧进度：「正在克隆项目…」、项目名、进度条、明细、已用时长、[返回（后台继续克隆）]。

- **明细**逐段可缺（缺了不留空位）：阶段名 +（第 n/N 步）（N = 阶段表长度，现为 6：枚举远端对象、清点对象、远端压缩、接收对象、解析增量、检出文件）· 本阶段对象数 `done/total`（只有总数时写「共 X 个对象」）· 已收字节 · 速率。git 不报总字节，**不得**写「12MB/45MB」式的字节进度。
- **百分比**取服务端给的值，没有时取本阶段对象数之比；都拿不到时进度条走「进度未知」，**不得**显示百分比或编一个数。
- **已用 m:ss** 每秒自走（不靠进度帧驱动），以克隆开始为锚点；拿不到锚点时不写。
- 克隆超过 `PARAM.CLONE_SLOW_AFTER_S`（600 秒）后，进度下方加一句慢提示「还在克隆。仓库比较大或者网络比较慢，可能要等一会儿——不用一直守在这一屏。」，之后一直保留；超过 `PARAM.CLONE_TIMEOUT_MIN`（30 分钟）转克隆失败（`TIMEOUT`，REQ-PRJ-005）。
- [返回（后台继续克隆）] 与右上角关闭都只关弹层、**不得**中断克隆；树组头保持「克隆中」徽标（REQ-PRJ-011），进度继续显示在主区（REQ-PRJ-012）。弹层里**不放** [继续等待] / [取消]：要停下用项目菜单里常驻的 [取消克隆（保留项目）]（REQ-PRJ-013）。
- 进度块以 role="status"（polite）播报；按钮不在 live 区域里。
- 同一时刻最多 `PARAM.CLONE_CONCURRENCY`（2）个克隆在跑，之后的排队；排队期间没有进度帧，按「进度未知」显示。

<details>
<summary>为什么不给 [继续等待] / [取消]</summary>

克隆本来就跑在后台，关掉弹层不会中断它；「继续等待」是一个什么都不做的按钮。旧文把取消藏在 10 分钟后的提示里，也没说取消后项目去留。现在取消在项目菜单里随时可用，取消后项目留着、可重试（REQ-PRJ-013）。现状 CloneProgress.view.tsx:85-91 的注释记录了同一屏「请继续等待」与「返回（后台继续克隆）」自相矛盾的旧问题。

</details>

**改写了哪条旧文**：P21-6 L49「创建中：进度态『🔄 正在克隆仓库…（12MB/45MB）』」与 F21-6 L196「弹层进度态（字节进度）」→ 按阶段与对象数（LIVE-RUN L-2：`totalBytes` 是幽灵字段）；P21-6 L98、P22 L59、F21-6 L177「>10min 提示『仓库较大或网络缓慢 [继续等待]/[取消]』」→ 一句慢提示、不给按钮，取消挪到菜单常驻（REQ-PRJ-013）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-PRJ-004.1 | 集成 | 提交 Git 项目被接受（202） | 第一帧进度到达之前 | 弹层已换成「正在克隆项目…」+ 项目名；树里同时出现该项目（克隆中） | 已实现：NewProjectContainer.tsx:47-54（种子进度）；F21-6 L149（先落库） |
| AC-PRJ-004.2 | 单元 | 帧 `{stage: receiving, objectsDone: 11066, objectsTotal: 26348, receivedBytes ≈ 18.4 MB, bytesPerSecond ≈ 1.2 MB/s, percent: 42}` | 渲染 | 「42%」；明细「接收对象（第 4/6 步） · 11,066/26,348 · 18.4 MB · 1.2 MB/s」（f-prj-create-04） | 已实现：useProjectClone.ts:39-52、projectClone.ts:63-69 |
| AC-PRJ-004.3 | 单元 | 帧只有 `stage: enumerating` 与 `objectsTotal: 26348`（或排队中、还没有帧） | 渲染 | 不显示百分比，进度条走进度未知；明细「枚举远端对象（第 1/6 步） · 共 26,348 个对象」（f-prj-create-05） | 已实现：projectClone.ts:16-26、useProjectClone.ts:45-48 |
| AC-PRJ-004.4 | 集成 | 克隆跑到第 600 秒 | 服务端推 `phase: slow` | 出慢提示；之后的进度帧不把它冲掉，明细与百分比照常更新 | 已实现：clone-project.workflow.ts:129-163（slow 粘住并带上一帧数据）、CloneProgress.view.tsx:92-96 |
| AC-PRJ-004.5 | 集成 | 克隆跑满 30 分钟 | 计时到点 | 转克隆失败，说明「克隆超时（仓库较大或网络较慢），可重试。」 | 已实现：clone-project.workflow.ts:22、122-125、254；projectClone.ts:153-158 |
| AC-PRJ-004.6 | e2e | 进度视图开着 | 点 [返回（后台继续克隆）] 或右上角关闭 | 弹层关闭；树组头仍是克隆中；克隆没有中断 | 已实现：CloneProgress.view.tsx:97-103、WorkbenchContainer.tsx:461-463 |
| AC-PRJ-004.7 | 组件 | 进度视图 | 读屏 | live 区域只含进度块，不含 [返回…] 按钮 | 偏离：role="status" 包住了按钮（CloneProgress.view.tsx:62-104） |
| AC-PRJ-004.8 | 集成 | 克隆已跑 20 分钟，用户刷新页面后再打开该项目 | 下一帧到达 | 已用时长从克隆开始算；拿不到开始时刻时不写已用 | 偏离：锚点是本页收到的第一帧（createProjectCloneSlice.ts:48），刷新后从 0:00 起算；要后端在 DTO 或进度帧里给开始时刻 |

### REQ-PRJ-005 · 克隆的结果：完成，或按失败码给出口 {#REQ-PRJ-005}

> 状态 `部分实现` · 版本 MVP · 来源 P21-6 L75-78、L98、L100-101、L130；P20 L409；P22 L56-57；P21-3 L165、L168-190；F21-6 L178-181、L311-312；UX-DS-508；实现 CloneProgress.view.tsx:107-148、projectClone.ts:103-183、NewProjectContainer.tsx:61-77、WorkbenchContainer.tsx:183-188；api clone-project.workflow.ts:203-221、252-257、project.schema.ts:15-42 · 关联 REQ-PRJ-014、REQ-PRJ-015、REQ-CRD-030–039（凭证页回程，F-CRD-PAGE）· 稿件 f-prj-create-06、f-prj-create-07、f-prj-create-08

**完成**：弹层开着时换成「项目可用了」+ 项目名 + [打开项目]（弹层里唯一的实心按钮），结果以 role="status" 在原位播报；点 [打开项目] 选中该项目、关弹层，主区落到「「X」下还没有任务」。完成**不得**自动把用户从正在看的项目或任务上切走。弹层已经关了（点过 [返回…]）时，完成**必须**在原位可见：树组头的「克隆中」徽标消失、计数位回到任务数；用户正选中该项目时，主区换成「还没有任务」并播报；另给一条轻提示「项目「X」可用了」作补充——**不得**只靠轻提示报告这个异步结果。

**失败**：同一视图换成「克隆失败」+ 项目名 + 一句说明（三者在同一条 role="alert" 播报里念出：role 容器包住标题、项目名与说明句——「克隆失败」本身不说原因，原因不能落在播报之外；W4 评审 R2-01，稿件 f-prj-clone-04…06、f-prj-create-06 / 07）+ 出口 + [改为空项目] 的附注「[改为空项目]：项目留着、已有的任务也留着，只是工作区从空的开始，不再关联这个仓库。」。项目留在树里，组头标「克隆失败」。说明与出口按失败码：

| 失败码 | 什么情况 | 说明（逐字以 projectClone.ts 为准） | 出口 |
|---|---|---|---|
| `CLONE_FAILED_PERMISSION` | 远端拒绝了凭证（401 / 403 / publickey） | 远端拒绝了这次访问：凭证无效或没有这个仓库的权限。配置 Git 访问凭证后可重试克隆。 | [配置 Git 凭证] [改为空项目] |
| `CLONE_FAILED_NOT_FOUND` | 远端回「Repository not found」：私有仓没配凭证，或地址写错，git 分不出 | 打不开这个仓库：可能是私有仓库还没配 Git 凭证，也可能是地址写错了。如果是私有仓库，配好凭证后可以重试克隆；如果是地址写错了，远端地址建好之后改不了，需要删掉这个项目重新建一个。 | [配置 Git 凭证] [改为空项目] |
| `CLONE_FAILED_NETWORK` | 网络 | 网络错误导致克隆失败，请检查网络后重试。 | [重试克隆] [改为空项目] |
| `TIMEOUT` | 超过 30 分钟 | 克隆超时（仓库较大或网络较慢），可重试。 | [重试克隆] [改为空项目] |
| `INTERRUPTED` | 用户取消，或平台重启时没跑完 | 克隆被中断，请重试。 | [重试克隆] [改为空项目] |
| `DISK_INSUFFICIENT` | 开始前剩余空间低于 `PARAM.CLONE_MIN_FREE_BYTES`，或途中写满 | 磁盘空间不足，没能克隆完。清理出空间后可以在这个项目上重试克隆；也可以改为空项目。 | [重试克隆] [改为空项目] |
| 未知码 | — | 克隆失败，请重试。 | [重试克隆] [改为空项目] |

`NOT_FOUND` 的说明**不得**断言是哪一种原因；「删掉重建」没有按钮（删除只在项目菜单里），所以写在句子里。[配置 Git 凭证] 带回程：跳到「凭证管理 › Git 凭证」，配好后由凭证页的回程条对**同一个项目**发起重试（不重新创建，F-CRD-PAGE f-crd-page-05）。[重试克隆]、[改为空项目] 的行为见 REQ-PRJ-014、REQ-PRJ-015。

**改写了哪条旧文**：P21-6 L76 / P22 L56「克隆失败·网络/URL：就地红字『仓库不可访问：检查 URL 或网络』+ [重试]」→ 拆成 `CLONE_FAILED_NETWORK`（可重试）与 `CLONE_FAILED_NOT_FOUND`（不给重试、两条出路都写）；P22 L57「克隆失败：无权访问该仓库」→ `CLONE_FAILED_PERMISSION` 那句；P21-6 L75「完成自动选中新项目」、L98「成功自动选中 + toast」、P20 L409「克隆完成自动选中新项目」→ 弹层开着时给 [打开项目]（不自动跳）、弹层已关时原位可见 + 轻提示补充；P21-6 L77 / P22 L57「配置完成回弹层 [重试克隆]」与 P21-3 L189「回程载体待原型落实」→ 回程不回弹层，由凭证页回程条重试（载体为现状 `pendingProjectCreate`）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-PRJ-005.1 | 集成 | 弹层开着 | 收到 `done` | 「项目可用了」+ 项目名 + [打开项目]；结果以 role="status" 播报（f-prj-create-08） | 部分实现：视图已实现（CloneProgress.view.tsx:56、107-111）；这一态没有 live 区域 |
| AC-PRJ-005.2 | e2e | done 视图 | 点 [打开项目] | 弹层关闭；新项目被选中；主区「「X」下还没有任务」 | 已实现：NewProjectContainer.tsx:61-65 → WorkbenchContainer.tsx:183-188 |
| AC-PRJ-005.3 | e2e | 点过 [返回…]，正在看 acme-web 的某个任务 | 克隆完成 | 树组头徽标消失并在原位播报；当前任务不被切走；出一条轻提示「项目「X」可用了」 | 未实现：徽标随列表刷新消失，但没有播报，也没有轻提示 |
| AC-PRJ-005.4 | 单元 | 6 个失败码与未知码 | 取说明与出口 | 按上表；`PERMISSION` / `NOT_FOUND` 不给 [重试克隆]、给 [配置 Git 凭证] | 已实现：projectClone.ts:113-182、CloneProgress.view.tsx:123-142 |
| AC-PRJ-005.5 | e2e | 权限类失败 | 点 [配置 Git 凭证]，配好凭证后点回程条的 [重试克隆] | 落在凭证管理的 Git 凭证分区；重试作用在同一个项目上，项目数不变；成功后回到工作台，该项目显示克隆中 | 部分实现：跳转与回程态已实现（NewProjectContainer.tsx:67-77、ProjectRecoveryContainer.tsx:33-37；Git 分区回程横幅 GitCredentialsSection.view.tsx:78-86；重试成功回工作台 useGitCredentialManager.ts:322-333）；跳转只到凭证页，没找到定位到 Git 分区的代码；回程条归 F-CRD-PAGE |

### REQ-PRJ-006 · 空项目：提交即就绪，不经进度视图 {#REQ-PRJ-006}

> 状态 `偏离` · 版本 MVP · 来源 P21-6 L98（空项目即时）、L111；F21-6 L176；plan F-PRJ-CREATE 接线（空项目 → 关弹层、落 P6 空态）；实现 api project-application.service.ts:160-169、NewProjectContainer.tsx:21-24、50-54 · 关联 REQ-PRJ-015（同一落点）· 稿件 f-prj-create-02（提交后的落点见 f-prj-clone-07 的布局）

来源为空项目时，服务端同步建好空工作区，提交被接受即就绪。此时弹层**必须**直接关闭、选中新项目，主区落到「「X」下还没有任务」+ [新任务]，树里新组展开并给「发起第一个任务」；**不得**经过进度视图或「项目可用了」那一步。不发轻提示（结果就在眼前）。

**改写了哪条旧文**：P21-6 L98「空项目即时 → 成功自动选中 + toast」→ 自动选中保留，toast 去掉（同步结果原位可见，轻提示没有增量信息）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-PRJ-006.1 | e2e | 来源「空项目」，名称 infra-scripts | 提交 | 弹层关闭；infra-scripts 被选中；主区「「infra-scripts」下还没有任务」；中途没有出现进度或「项目可用了」视图 | 偏离：现状多一步「项目可用了」+ [打开项目]（NewProjectContainer.tsx:21-24 把 ready 种成 done → CloneProgress.view.tsx:107-111） |
| AC-PRJ-006.2 | API | — | `POST /api/projects {sourceType: empty}` | 202，`cloneStatus: ready`，空工作区已建好 | 已实现：api project-application.service.ts:160-169、project.controller.ts:28-30 |

## PRJ · 克隆中与克隆失败的项目（F-PRJ-CLONE）

### REQ-PRJ-010 · 克隆中 / 克隆失败的项目可以选中；三处给同一组动作 {#REQ-PRJ-010}

> 状态 `部分实现` · 版本 MVP · 来源 P21-6 L28-29、L78、L97、L99、L103、L130 ④⑥；F21-6 L164、L182、L184、§10.2 A L431-441、§10.8 第 3 条；按默认推进（DEC-0004 现状为底，F21-6 §10.2 A）；实现 WorkbenchContainer.tsx:176-181、198-212、289-320、401-444、useProjectRecovery.ts、ProjectRecoveryContainer.tsx · 关联 REQ-PRJ-012、REQ-PRJ-014、REQ-PRJ-015 · 稿件 f-prj-clone-01、f-prj-clone-04

克隆中与克隆失败的项目**必须**和就绪项目一样可以选中（树里点组头、面包屑切换、⌘K、总览项目卡），选中后主区不是终端：克隆中给进度（REQ-PRJ-012），克隆失败给恢复引导（结果卡：「克隆失败」+ 说明 + 出口 + 附注，出口同 REQ-PRJ-005 的表）。

克隆失败项目的处置动作**必须**在三处给出：主区恢复引导、项目「⋯」菜单（树组头与顶栏「⋯ 更多操作」是同一组菜单项）、项目总览的项目卡。三处**必须**调同一个动作实现：点一次只发一个请求，忙碌态、回滚与错误句一致。菜单里的顺序：项目详情 / 保留下来的成果 / 自动化规则 → [重试克隆]（失败码允许时）/ [改为空项目] + 附注 → [删除项目…]。克隆中项目的「⋯」菜单另见 REQ-PRJ-013。

**改写了哪条旧文**：P21-6 L28-29「失败项目点击展开 → [重试克隆]/[改为空项目]/[删除]」、L78 / L97 / L99 / L130 ④「failed 无法选为当前项目，组头点击仅展开、不切换」、L103 / L130 ⑥「处置入口仅组头菜单（无其他路径）」→ 可以选中；主区、组头菜单、总览卡三处共用；F21-6 L184 已注明原条作废，F21-6 L199、L313 同步改。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-PRJ-010.1 | e2e | acme-api 克隆失败（网络错误） | 点树里 acme-api 的组头 | acme-api 成为当前项目（树当前项、面包屑都指向它）；主区是恢复引导（f-prj-clone-04） | 已实现：WorkbenchContainer.tsx:176-181、302-311 |
| AC-PRJ-010.2 | e2e | infra-scripts 克隆中 | 点组头 | infra-scripts 成为当前项目；主区是克隆进度（f-prj-clone-01） | 部分实现：可以选中；主区只有一句话（REQ-PRJ-012） |
| AC-PRJ-010.3 | 集成 | 克隆失败项目 | 分别从主区、组头菜单、总览卡点 [重试克隆] | 每次只发一个 `retry-clone`；三处的禁用态与错误句一致 | 部分实现：主区与菜单共用 useProjectRecovery（WorkbenchContainer.tsx:198-205，F21-6 §10.8 第 3 条有用例）；总览卡不存在 |
| AC-PRJ-010.4 | e2e | 在项目总览 | 看 acme-api 的项目卡 | 第一行是失败说明，下面是同一组动作；失败码为 `PERMISSION` / `NOT_FOUND` 时是 [配置 Git 凭证] [改为空项目] | 未实现：实现没有总览；原型卡片写死网络错误一句与 [重试克隆]（proto.js:626-629） |

### REQ-PRJ-011 · 树：未就绪项目的组头（徽标、计数位、折叠箭头） {#REQ-PRJ-011}

> 状态 `偏离` · 版本 MVP · 来源 P21-6 L28、L78、L130 ③；F21-6 L199；原型评审 F13③（proto.js:456-458）；map-impl-api U-04（待核实项）；实现 ProjectGroupHeader.view.tsx:65-117、WorkbenchShell.view.tsx:495-521、selectProjectTaskTree.ts:35、useDeepLinkModal.ts:114-135、SandboxTerminalContainer.tsx:404-405 · 关联 REQ-PRJ-016 · 待裁决 Q-PRJ-03 · 稿件 f-prj-create-04、f-prj-clone-01、f-prj-clone-04

组头写项目名 + 状态徽标：克隆中「克隆中」（琥珀）、克隆失败「克隆失败」（红）。徽标后的计数位一律写任务数（未就绪的项目还没有任务，所以是「0」），**不得**写克隆进度——进度只在主区（REQ-PRJ-012）与新建项目弹层的进度视图（REQ-PRJ-004）里说；读屏念「infra-scripts，克隆中，0 个任务」/「acme-api，克隆失败，0 个任务」。计数位口径按 Q-PRJ-03 定为 B（W2 跨组一致性修正时由编排方定，与原型 `renderTree`、现状 ProjectGroupHeader.view.tsx:106-111 和其余工作台稿一致；本片原稿写进度「42%」，已改回）。克隆中 / 克隆失败的项目没有可展开的内容，所以：

- 折叠箭头**必须**不可用（aria-disabled，仍可聚焦；按下或悬停时说原因「正在克隆，分组里还没有内容」/「克隆失败，分组里还没有内容」）；
- 组下**不得**出现「发起第一个任务」——点了既不能发起，又会留下一个看不见的新建任务状态。

当前项目钉在树最前（从树以外进入时），当前行的计数位照常让位给「⋯」。

**改写了哪条旧文**：P21-6 L28「🔴 📁 ProjectD ⚠️克隆失败 ⋯」与 F21-6 L199「组头 `🔴 📁 ProjectName ⚠️ 克隆失败 ⋯`」→ 去掉前导红点与徽标里的三角（徽标本身就是红色状态，读屏仍念「克隆失败」）；P21-6 L28-29「点击展开 → 出口」→ 失败项目没有可展开的内容，出口在主区与「⋯」菜单（REQ-PRJ-010）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-PRJ-011.1 | 组件 | infra-scripts 克隆中，进度 42% | 渲染组头 | 徽标「克隆中」+ 计数位「0」（任务数，不写「42%」）；读屏「infra-scripts，克隆中，0 个任务」（f-prj-create-04） | 部分实现：计数位已是任务数「0」、不写进度；「克隆中」是跟在计数后面的 10px 黄字小块，不是计数前的琥珀徽标，读屏念成「infra-scripts 0 克隆中」（ProjectGroupHeader.view.tsx:106-111） |
| AC-PRJ-011.2 | 组件 | 克隆中但拿不到百分比 | 渲染组头 | 计数位写任务数「0」，不编数（f-prj-create-05、f-prj-clone-02） | 已实现（现状只写任务数） |
| AC-PRJ-011.3 | e2e | 克隆中 / 克隆失败的组 | 按折叠箭头 | 不展开；说出原因 | 偏离：箭头照常可点，且默认展开（ProjectGroupHeader.view.tsx:65-86、selectProjectTaskTree.ts:35） |
| AC-PRJ-011.4 | e2e | 克隆中 / 克隆失败的组 | 查看组下 | 没有「发起第一个任务」；之后项目就绪也不会自己弹出新建任务弹层 | 偏离（代码核对，未实测）：空组对任何状态都渲染「发起第一个任务 →」（WorkbenchShell.view.tsx:495-521），点了把 currentModal 置成 newTask、地址写上 `?new=1&project=`（useDeepLinkModal.ts:121-135），但未就绪时不挂新建任务容器，弹层不出现（幽灵态）；该项目克隆完成、容器挂上时弹层会突然打开（SandboxTerminalContainer.tsx:404-405）。深链入口已有同类守卫（useDeepLinkModal.ts:114-117），空组入口没有 |

### REQ-PRJ-012 · 克隆中项目的主区：进度卡 {#REQ-PRJ-012}

> 状态 `未实现` · 版本 MVP · 来源 P21-6 L75；F21-6 L162、L196；v1 g7-05 / g7-05b（挪位）；原型 tpl-project-cloning（index.html:706-720）；实现 WorkbenchContainer.tsx:313-319 · 关联 REQ-PRJ-004、REQ-PRJ-016 · 稿件 f-prj-clone-01、f-prj-clone-02

选中克隆中的项目时，主区**必须**显示克隆进度：图标框（转圈）、「正在克隆项目…」、项目名、一句「项目正在克隆，克隆完就能发起任务。」、进度块。进度块的字段与规则同 REQ-PRJ-004（阶段与对象数、进度未知不编数、已用时长、600 秒后的慢提示），与弹层用同一份进度数据。主区**不放** [返回（后台继续克隆）]（没有可返回的地方）、[继续等待]、[取消]；取消在项目菜单里（REQ-PRJ-013）。顶栏：面包屑项目名 +「克隆中」徽标；没有分支 chip 与 [拉取最新代码]；[新任务] 不可用并说原因（REQ-PRJ-016）。刷新页面后，下一帧到达之前按「进度未知」显示，不写已用。

**改写了哪条旧文**：P21-6 L75「克隆中：弹层进度态」、F21-6 L162「弹层进度态；项目已在树中」→ 弹层与主区都显示进度（主区是新增；现状主区只有一句话）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-PRJ-012.1 | e2e | infra-scripts 克隆中 42% | 选中它 | 主区「正在克隆项目…」+ 项目名 + 那一句 + 进度 42% 与明细（f-prj-clone-01） | 未实现：只有一句「项目正在克隆，克隆完就能发起任务。」（WorkbenchContainer.tsx:313-319）；进度数据已在全局订阅的 store 里 |
| AC-PRJ-012.2 | 集成 | 克隆超过 600 秒且拿不到百分比 | 主区渲染 | 进度未知 + 明细 + 慢提示（f-prj-clone-02） | 未实现 |
| AC-PRJ-012.3 | 组件 | 主区克隆中 | 查看按钮 | 没有 [返回…]、[继续等待]、[取消] | 已实现（现状主区没有任何按钮） |
| AC-PRJ-012.4 | 集成 | 克隆进行中，刷新页面后选中该项目 | 下一帧到达之前 | 主区按进度未知显示，不写已用 | 未实现（主区没有进度）；已用的锚点问题同 AC-PRJ-004.8 |

### REQ-PRJ-013 · 取消克隆（保留项目） {#REQ-PRJ-013}

> 状态 `部分实现` · 版本 MVP · 来源 F21-6 L183、L421、L449-450、L505、§10.6 第 2 条 L513-519；DR-41；P21-6 L98、P22 L59（旧取消入口）；实现 ProjectGroupMenu.view.tsx:155-178、WorkbenchContainer.tsx:206-212、430-437、useProjects.ts:94-120；api project-application.service.ts:231-240、project.entity.ts:239-251、clone-project.workflow.ts:72-78、90-101、211-221、252-257、277-290 · 关联 REQ-PRJ-040–049（删除项目，F-PRJ-DELETE f-prj-delete-03）· 稿件 f-prj-clone-03、f-prj-clone-06

克隆中项目的「⋯」菜单（树组头与顶栏）**必须**常驻 [取消克隆（保留项目）]，与 [删除项目…] 分开放、文案**不得**相像；它下面一句附注「只停下这次克隆，项目留在树里；之后可以重试克隆，或改为空项目。」。点了之后：

- 请求立即返回；成功后菜单收起；失败时菜单**不得**收起，菜单底部一句原因（未知码的兜底句**不得**借用删除那句「删除失败…」）。
- 克隆随后落定为「克隆失败」+ `INTERRUPTED`：主区「克隆被中断，请重试。」+ [重试克隆] [改为空项目]（f-prj-clone-06），树徽标同步；项目 id、名称都保留。结果在原位播报，**不发**轻提示。
- 按晚了（克隆已经完成）按无事发生处理：项目照常就绪，不报错。
- 排队中、还没开始的克隆被取消，也**必须**落定为 `INTERRUPTED`，**不得**停在「克隆中」。
- 平台重启时没跑完的克隆落成同一态，所以说明句不断言是谁中断的。

删除确认里对克隆中项目另有就地 [取消克隆（保留项目）]（DR-41，归 F-PRJ-DELETE）。

**改写了哪条旧文**：P21-6 L98、P22 L59「>10min 提示里的 [取消]」→ 菜单常驻、任何时候都能取消，并写明取消后项目保留、可重试（旧文没说取消后项目去留）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-PRJ-013.1 | 组件 | infra-scripts 克隆中 | 打开组头「⋯」 | 项目详情 / 保留下来的成果 / 自动化规则 → 分隔 → 取消克隆（保留项目）+ 附注 → 分隔 → 删除项目…（红）（f-prj-clone-03） | 部分实现：菜单项已实现（ProjectGroupMenu.view.tsx:155-167）；没有附注 |
| AC-PRJ-013.2 | 集成 | 同上 | 点 [取消克隆（保留项目）]，请求成功 | 菜单收起；随后项目变「克隆失败」+ `INTERRUPTED`，主区与树原位更新（f-prj-clone-06） | 已实现：WorkbenchContainer.tsx:430-437；clone-project.workflow.ts:211-221、255 |
| AC-PRJ-013.3 | 集成 | 取消请求失败（未知码） | 查看菜单 | 菜单不收起；底部一句取消失败的原因 | 部分实现：不收起与原因已实现（WorkbenchContainer.tsx:209-212）；未知码兜底借用了「删除失败，请稍后重试。」（useProjects.ts:94-99） |
| AC-PRJ-013.4 | API | 克隆刚好已完成 | `POST /api/projects/{id}/cancel-clone` | 200；项目仍就绪；不记一条取消 | 已实现：project.entity.ts:247-251、project-application.service.ts:231-240 |
| AC-PRJ-013.5 | API | 已有两个克隆在跑，第三个在排队 | 取消第三个 | 它落定为 failed + `INTERRUPTED` 并推送 | 偏离（代码核对，未实测）：排队项只被移出队列（clone-project.workflow.ts:90-101），没有路径把它写成 failed，项目停在「克隆中」直到平台重启（:277-290） |
| AC-PRJ-013.6 | API | 平台重启时有克隆没跑完 | 启动 | 这些项目落成 failed + `INTERRUPTED` 并推送 | 已实现：clone-project.workflow.ts:72-78、277-290 |

### REQ-PRJ-014 · 重试克隆 {#REQ-PRJ-014}

> 状态 `部分实现` · 版本 MVP · 来源 P21-6 L100、L130 ⑦；P22 L56-57；F21-6 L150、L179-182、L311；实现 useProjectRecovery.ts:39-84、projectClone.ts:113-182、ProjectGroupMenu.view.tsx:119-153；api project.entity.ts:209-220、project-application.service.ts:172-182、project.controller.ts:51-52 · 关联 REQ-PRJ-005、REQ-PRJ-010 · 稿件 f-prj-clone-04、f-prj-clone-05、f-prj-clone-06

[重试克隆] 只给克隆失败、且失败码允许重试的项目（`NETWORK` / `TIMEOUT` / `INTERRUPTED` / `DISK_INSUFFICIENT` / 未知码）；`PERMISSION` / `NOT_FOUND` **不给**，改给 [配置 Git 凭证]（REQ-PRJ-005）——主区、组头菜单、总览卡三处一样（REQ-PRJ-010）。点了以后项目**必须**立即回到「克隆中」（树徽标、主区进度、总览卡同步），从头重新克隆，进度与结果同 REQ-PRJ-004、REQ-PRJ-005；可以重试多次，每次失败按新的失败码更新说明。重试永远作用在同一个项目上，**不得**新建项目。请求被拒时**必须**回到「克隆失败」（不停在克隆中），在原位一句原因：

| 情况 | 用户看到 |
|---|---|
| 项目已不是克隆失败（别处处理过，409 `INVALID_STATE`） | 这个项目现在不是「克隆失败」状态，重试克隆用不上了 —— 可能已经克隆成功、或者在别处被改成了空项目。刷新一下看看。 |
| 没有应答 | 网络不通，请稍后再试。 |
| 未知码 | 操作失败，请稍后重试。（报障时请提供 traceId：…） |

**改写了哪条旧文**：P21-6 L76 / P22 L56 的按钮名「[重试]」→ 统一叫 [重试克隆]；P21-6 L77「权限类配置完成回弹层 [重试克隆]」→ 由凭证页回程条重试（REQ-PRJ-005）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-PRJ-014.1 | 组件 | 失败码 `CLONE_FAILED_NETWORK` | 渲染恢复引导 | [重试克隆] [改为空项目] + 附注（f-prj-clone-04） | 已实现：CloneProgress.view.tsx:129-146 |
| AC-PRJ-014.2 | 组件 | 失败码 `PERMISSION` 或 `NOT_FOUND` | 渲染 | 没有 [重试克隆]；有 [配置 Git 凭证]（f-prj-clone-05） | 已实现：projectClone.ts:115-146 |
| AC-PRJ-014.3 | 集成 | — | 点 [重试克隆] | 项目立即显示为克隆中；请求在途时动作禁用 | 已实现：useProjectRecovery.ts:72-76、104 |
| AC-PRJ-014.4 | 集成 | 重试请求没有应答 | — | 回到克隆失败（原失败码），原位「网络不通，请稍后再试。」 | 已实现：useProjectRecovery.ts:77-82 |
| AC-PRJ-014.5 | 集成 | 项目已在别处改成空项目 | 点 [重试克隆] | 409 → 表中第一句 | 已实现：useProjectRecovery.ts:53-54 |
| AC-PRJ-014.6 | API | 失败项目 | 重试后再失败 | 失败码更新为这一次的；项目总数不变 | 已实现：project.entity.ts:209-220、clone-project.workflow.ts:211-221 |
| AC-PRJ-014.7 | 组件 | 失败码 `PERMISSION` 或 `NOT_FOUND` 的项目 | 打开组头「⋯」（或看总览卡） | 与主区同一组出口：[配置 Git 凭证] [改为空项目]，没有 [重试克隆] | 偏离：菜单不看失败码，克隆失败一律给 [重试克隆]、不给 [配置 Git 凭证]（ProjectGroupMenu.view.tsx:120-136；WorkbenchContainer.tsx:406-429 没有传失败码）；原型 proto.js:902-905 同样 |

### REQ-PRJ-015 · 改为空项目 {#REQ-PRJ-015}

> 状态 `已实现` · 版本 MVP · 来源 P21-6 L101 ①–⑥、L130 ⑧；F21-6 L151、L181、L200、L312；实现 useProjectRecovery.ts:55-56、86-99、WorkbenchContainer.tsx:183-188、198-205、ProjectGroupMenu.view.tsx:137-151、CloneProgress.view.tsx:134-146；api project.entity.ts:222-237、project-application.service.ts:184-196、project.controller.ts:59-60 · 关联 REQ-PRJ-006（同一落点）、REQ-PRJ-020（空项目的项目信息，F-PRJ-INFO）· 待裁决 Q-PRJ-02 · 稿件 f-prj-clone-04、f-prj-clone-07

[改为空项目] 只给克隆失败的项目，即时生效（同步）：项目转为就绪的空项目——来源变空项目、远端地址与分支清空、工作区从空目录开始；项目 id、名称、创建时间与已有的任务保留。之后红标消失、该项目被选中，主区落到「「X」下还没有任务」+ [新任务]，[新任务] 可用（f-prj-clone-07）；顶栏项目信息写「空项目」（REQ-PRJ-020）。按钮旁**必须**有附注说清留下什么（主区：「[改为空项目]：项目留着、已有的任务也留着，只是工作区从空的开始，不再关联这个仓库。」；菜单：「…项目和它下面已有的任务都留着…」）。改完能不能再改回 Git 项目产品没有裁过（现状事实上回不去），界面**不得**写「不可逆」，也**不得**写「以后可以改回」（待裁决 Q-PRJ-02）。不发轻提示（同步结果就在眼前）。被拒时原位一句：409「这个项目现在不是「克隆失败」状态，改不成空项目 —— 可能已经克隆成功、或者在别处改过了。刷新一下看看。」；没有应答「网络不通，请稍后再试。」。

**改写了哪条旧文**：无冲突；P21-6 L101 ①–⑥ 与现状一致，本条把落点（选中并到「还没有任务」）与附注写明。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-PRJ-015.1 | e2e | acme-api 克隆失败 | 在主区、组头菜单或总览卡点 [改为空项目] | acme-api 变就绪：红标消失、被选中、主区「「acme-api」下还没有任务」、[新任务] 可用（f-prj-clone-07） | 已实现（总览卡除外）：useProjectRecovery.ts:86-99 → WorkbenchContainer.tsx:183-188 |
| AC-PRJ-015.2 | API | 失败项目 | `POST /api/projects/{id}/convert-to-empty` | 200；`sourceType: empty`、`cloneStatus: ready`、`repoUrl` / `repoBranch` 清空；id、名称、创建时间不变；工作区为空目录 | 已实现：project.entity.ts:222-237、project-application.service.ts:184-196 |
| AC-PRJ-015.3 | API | 就绪项目 | 同上 | 409 `INVALID_STATE`；前端说「…改不成空项目…刷新一下看看。」 | 已实现：project.entity.ts:224-226、useProjectRecovery.ts:55-56 |
| AC-PRJ-015.4 | 组件 | 恢复引导与组头菜单 | 查看 [改为空项目] | 都有附注；没有「不可逆」「可以改回」字样 | 已实现：CloneProgress.view.tsx:143-146、ProjectGroupMenu.view.tsx:137-151 |

### REQ-PRJ-016 · 未就绪项目不能发起任务：原因分两句 {#REQ-PRJ-016}

> 状态 `偏离` · 版本 MVP · 来源 P21-6 L78、L130；P20 L410；P21-2 L232；P22 L46；P21-8 §7 L402-404（离线时 [+ 新任务] 置灰）；Q-DS-29 A（项目下拉）；实现 WorkbenchContainer.tsx:270-287、WorkbenchShell.view.tsx:575-587、sandboxErrorCopy.ts:142-148；api sandbox-application.service.ts:252-255 · 关联 REQ-LCH-001–009（新建任务弹层，F-LCH-FORM）· 稿件 f-prj-clone-01、f-prj-clone-04

选中克隆中或克隆失败的项目时，发起任务的入口**必须**都不可用并说原因：顶栏 [新任务]（aria-disabled、可聚焦；按下或悬停时出原因提示，读屏经 aria-describedby 念原因）、⌘K「新任务…」、新建任务弹层的项目下拉（该项不可选，括注「克隆中」/「克隆失败」）。原因按状态分两句，**不得**混用：

| 状态 | 原因 |
|---|---|
| 克隆中 | 项目还在克隆，克隆完成后可发起 |
| 克隆失败 | 克隆失败的项目不能发起任务：先重试克隆或改为空项目 |

离线时先说离线原因。服务端兜底：对未就绪项目建任务一律 409 `PROJECT_NOT_READY`（零副作用）。

**改写了哪条旧文**：现状与原型都只有一句「项目尚未就绪（克隆完成后可发起）」→ 分两句；对克隆失败的项目说「克隆完成后可发起」是 P22 L46 点名的假话（克隆失败不会「完成」）。

**合并说明**：新建任务弹层与顶栏入口的禁用原因（REQ-LCH-001）已按本条统一为两句。（交叉引用：REQ-LCH-001）

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-PRJ-016.1 | 组件 | 选中 infra-scripts（克隆中） | 按下或悬停顶栏 [新任务] | 不打开弹层；原因「项目还在克隆，克隆完成后可发起」（f-prj-clone-01） | 偏离：现状一句「项目尚未就绪（克隆完成后可发起）」（WorkbenchContainer.tsx:286） |
| AC-PRJ-016.2 | 组件 | 选中 acme-api（克隆失败） | 同上 | 原因「克隆失败的项目不能发起任务：先重试克隆或改为空项目」（f-prj-clone-04） | 偏离：同一句「…克隆完成后可发起」 |
| AC-PRJ-016.3 | 组件 | 离线，且选中未就绪项目 | 查看原因 | 先说离线原因 | 已实现：WorkbenchContainer.tsx:282 |
| AC-PRJ-016.4 | API | 克隆中 / 克隆失败的项目 | 新建任务 | 409 `PROJECT_NOT_READY`，零副作用；前端「这个项目现在还不能接任务」+ [去项目页查看状态] | 已实现：sandbox-application.service.ts:252-255、sandboxErrorCopy.ts:142-148 |
| AC-PRJ-016.5 | 组件 | 新建任务弹层 | 展开项目下拉 | acme-api（克隆失败）、infra-scripts（克隆中）不可选 | 未实现：实现的新建任务弹层没有项目下拉（Q-DS-29 A 要补，归 F-LCH-FORM） |

## PRJ · 项目信息与拉取最新代码（F-PRJ-INFO）

### REQ-PRJ-020 · 项目信息：只读四项 / 空项目两项，分支缺省「远端默认分支」，chip 与 ⓘ 打开同一张浮层 {#REQ-PRJ-020}

> 状态 `偏离` · 版本 MVP · 来源 F21-6 §9.1–9.2（L259-284；产品文档此前没有这块）；P21-1 L42、L50（顶部当前项目指示器）；pilot P1 第 11 条（顶栏收纳，简报 §5.2）；U-12、U-13、U-90；实现 ProjectInfoBar.view.tsx:109-134、WorkbenchContainer.tsx:338-364，契约 project.schema.ts:80-104（`repoBranch` 可缺省）· 关联 REQ-PRJ-021 · REQ-PRJ-010、012、015（克隆中 / 克隆失败的出口与改为空项目）· 稿件 f-prj-info-01、f-prj-info-02

选中一个**就绪**的项目时，工作台顶栏**必须**能让人看到「我在拿什么代码干活」：

| 项目 | 浮层里的行 |
|---|---|
| Git 项目 | 仓库（地址）· 分支 · 代码体积 · 最后拉取 |
| 空项目（含克隆失败后「改为空项目」的） | 仓库「空项目（没有关联仓库）」· 创建于 |

这些信息只读：改仓库地址、切默认分支、重新克隆都**不在**这里。触发器：顶栏宽度够时是分支 chip（Git 项目写分支名，空项目写「空项目」），顶栏窄于 960 时 chip 收进 ⓘ；两者打开**同一张**浮层卡。浮层是非模态的：打开后焦点进卡内第一个可操作的控件（空项目没有控件，焦点落在卡上），Esc 或点卡外关闭并把焦点还给触发器；触发器带打开态与 `aria-expanded`。卡标题是项目名，副标题「项目信息」。

分支：建项目时没填分支（`repoBranch` 缺省 = 远端默认分支）的，chip 与卡里**必须**写「远端默认分支」，**不得**写 main，也不得写「—」。代码体积写人能读的单位；最后拉取写本地时间（刚拉完写「刚刚」，见 REQ-PRJ-022）。克隆中、克隆失败的项目不出 chip / ⓘ，它们的出口在主区（REQ-PRJ-010、012）。

**改写了哪条旧文**：P21-1 L42、L50「顶部只有当前项目指示器（只读，点击在树中定位）」→ 另加项目信息入口（chip / ⓘ + 浮层）；F21-6 §9.2「主区顶部一条只读信息」→ 收进顶栏 chip 与浮层（P1 第 11 条已把信息条并进顶栏，本条补点开之后的那张卡）；F21-6 §9.2 表「分支：—」→「远端默认分支」；F21-6 §9.2 的「远端地址 / 基线体积 / 最后同步」→ 屏上词「仓库 / 代码体积 / 最后拉取」（与实现一致，ProjectInfoBar.view.tsx:3）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-PRJ-020.1 | 组件 | 选中 acme-web（Git、就绪、分支 main、45 MB、最后拉取 2026/10/2 09:12:01） | 点顶栏分支 chip「main」 | 浮层打开：标题 acme-web、副标题「项目信息」；四行 仓库 https://github.com/acme/web.git / 分支 main / 代码体积 45 MB / 最后拉取 2026/10/2 09:12:01；chip 打开态且 `aria-expanded="true"`；焦点在 [拉取最新代码] | 偏离：现状是主区顶部常驻信息条，没有 chip 与浮层（ProjectInfoBar.view.tsx:114-171）（稿件 f-prj-info-01） |
| AC-PRJ-020.2 | e2e | 视口 1024（顶栏 < 960） | 点 ⓘ | 打开同一张浮层，贴在 ⓘ 下方、右缘对齐 | 未实现（同上）（稿件 f-prj-info-01 头注释、previews/f-prj-info-01.check-1024.png） |
| AC-PRJ-020.3 | 组件 | 选中空项目 acme-api（克隆失败后改为空项目） | 点 chip「空项目」 | 浮层两行：仓库「空项目（没有关联仓库）」、创建于 2026/10/2 10:05:12；没有 [拉取最新代码]，没有页脚 | 部分实现：两项文字已有（ProjectInfoBar.view.tsx:109-134），形态同 020.1（稿件 f-prj-info-02） |
| AC-PRJ-020.4 | 单元 | 项目建时没填分支（`repoBranch` 缺省） | 渲染 chip 与分支行 | 都写「远端默认分支」 | 偏离：写「—」（ProjectInfoBar.view.tsx:126） |
| AC-PRJ-020.5 | 组件 | 浮层开着 | 按 Esc；另一次点浮层外 | 浮层关闭，焦点回到 chip（窄顶栏时回到 ⓘ），chip 回到常态 | 未实现（同 020.1） |

### REQ-PRJ-021 · 拉取最新代码：仅就绪的 Git 项目，按下之前说清作用范围，拉取中两处同态 {#REQ-PRJ-021}

> 状态 `部分实现` · 版本 MVP · 来源 F21-6 §9.3（L286-293「[重新同步]」：仅 ready，只更新基线、已有 Task 工作区不动）；LIVE-RUN L-9；U-14、U-89；实现 ProjectInfoBar.view.tsx:72-77、136-151，WorkbenchContainer.tsx:349-350，project.entity.ts:200-207，sync-baseline.workflow.ts:20、56-80，project-application.service.ts:220-229 · 关联 PARAM.PROJECT_SYNC_TIMEOUT_MIN（新增，现值 5）· 稿件 f-prj-info-01、f-prj-info-03

动作名统一为「拉取最新代码」。只给**就绪的 Git 项目**（空项目、克隆中、克隆失败都不出；后端对它们回 409 `INVALID_STATE`，且在执行 git 之前就拒绝）。入口两处——浮层卡页脚、顶栏按钮（顶栏窄于 800 时收进「⋯」菜单）——是同一个动作，状态**必须**一致。

作用范围**必须**在按下之前看得到：浮层页脚里一句可见文字，并挂在按钮的说明上（`aria-describedby`）：「只更新项目里的这份代码。已经建好的任务用的是各自建的时候复制的那一份，不会跟着变；下次新建任务才会用到刚拉下来的代码。」拉取不动已有任务的代码副本，也不改任务列表。

拉取是同步请求，最长 `PARAM.PROJECT_SYNC_TIMEOUT_MIN` 分钟，超时按失败处理（REQ-PRJ-022）。拉取中：两处按钮都变「正在拉取…」（前缀转圈）并禁用，可访问名称改为「正在拉取最新代码」；四项信息保持旧值直到结果回来；浮层里以 role="status" 播报「正在拉取 X 的最新代码…」。

<details>
<summary>为什么作用范围要在按下之前说</summary>

同一个项目下的两个任务可能跑在不同的代码上（拉取之前建的那个用旧代码），界面上暂时区分不出来（F21-6 L290-293 有意留下的缺口）。至少要让人在按下之前知道「这一下不会改已经在跑的任务」，而不是拉完之后再解释。

</details>

**改写了哪条旧文**：F21-6 §9.3 标题与 L288「[重新同步]」→「拉取最新代码」（实现上屏词；「同步」双向暧昧，见 ProjectInfoBar.view.tsx:3-4）；sandboxErrorCopy.ts:159 BRANCH_NOT_FOUND 建议句「先到项目上做一次[重新同步]再回来选」→「先在项目信息里点「拉取最新代码」再回来选」；F21-6 L290-293「刻意不做呈现」→ 作用范围一句改为按下之前可见（实现已把它放在按钮 title 上，ProjectInfoBar.view.tsx:72-77）；P21-6 全文没有这个动作，本条补入。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-PRJ-021.1 | 组件 | 选中空项目 / 克隆中 / 克隆失败的项目 | 看顶栏与浮层 | 没有 [拉取最新代码]（「⋯」菜单里也没有） | 已实现：canSync 只给 ready（WorkbenchContainer.tsx:349），空项目不渲染按钮（ProjectInfoBar.view.tsx:136） |
| AC-PRJ-021.2 | API | 空项目，或 cloneStatus 不是 ready | `POST /api/projects/{id}/sync` | 409 `INVALID_STATE`，不执行 git fetch | 已实现：project.entity.ts:200-207，sync-baseline.workflow.ts:57 |
| AC-PRJ-021.3 | 组件 | 就绪的 Git 项目，浮层打开 | 看页脚 | [拉取最新代码] 下方可见作用范围一句，按钮的 `aria-describedby` 指向它 | 部分实现：这句只在按钮的 title 与 aria-label 里（ProjectInfoBar.view.tsx:142-143）（稿件 f-prj-info-01） |
| AC-PRJ-021.4 | 集成 | 浮层打开 | 点 [拉取最新代码] | 顶栏按钮与浮层按钮同时变「正在拉取…」并禁用（前缀转圈）；四项保持旧值；role="status"「正在拉取 acme-web 的最新代码…」 | 部分实现：只有一处按钮；「正在拉取…」禁用已实现（ProjectInfoBar.view.tsx:141、149），没有转圈、没有播报，读屏仍念「拉取最新代码」（稿件 f-prj-info-03） |
| AC-PRJ-021.5 | API | 远端一直不应答 | 拉取 | `PARAM.PROJECT_SYNC_TIMEOUT_MIN` 分钟后以 `TIMEOUT`（504）失败 | 已实现：sync-baseline.workflow.ts:20、59、74，project-application.service.ts:52 |
| AC-PRJ-021.6 | 单元 | 新建任务时返回 `BRANCH_NOT_FOUND` | 生成建议句 | 指路写「拉取最新代码」，全句不出现「重新同步」 | 偏离：仍写「[重新同步]」（sandboxErrorCopy.ts:159） |

### REQ-PRJ-022 · 拉取的结果：成功一句、失败按原因说并给去处，原位播报 {#REQ-PRJ-022}

> 状态 `偏离` · 版本 MVP · 来源 Q-DS-35②（plan「要拍板」默认）；BACKLOG DR-25（拉取失败单独写一句，不说「重试克隆」）；UX-DS-508（异步结果原位播报，design-track/final/spec/a11y.md:43）；原稿 F21-3 第10.2节（权限类失败给凭证入口）；U-89；实现 useProjectBranches.ts:89-109、projectClone.ts:113-183、ProjectInfoBar.view.tsx:153-170、WorkbenchContainer.tsx:357-359，api project-application.service.ts:44-62、391，sync-baseline.workflow.ts:78-79 · 稿件 f-prj-info-04、f-prj-info-05

**成功**（返回新的项目信息）：「最后拉取」写「刚刚」（完整时间放提示里），代码体积按返回值刷新；浮层里一句 role="status"「已更新到最新；已建好的任务不受影响」；两处按钮恢复。浮层关着时成功：**不**自动打开浮层，用视觉隐藏的 status 播报同一句；chip 的说明与项目总览卡上的最后拉取同步刷新。

**失败**：四项保持旧值；浮层正文里一句 role="alert" 说原因，句子**必须**用拉取自己的话，**不得**出现「克隆」「重试克隆」；需要凭证的给 [配置 Git 凭证]（去「凭证管理」并定位到 Git 分区）。浮层关着时失败（从顶栏按钮或「⋯」菜单发起）：浮层**自动打开**贴在触发器下，不抢焦点，失败句照常 role="alert"——否则失败没有看得见的出口。逐字文案以代码文案表为准（01 §4.2 第 3 条），每个码必须表达的信息：

| 码 | 必须说清 | 给什么 | 句子 |
|---|---|---|---|
| `CLONE_FAILED_PERMISSION`（403） | 远端拒绝了访问；配好凭证后再拉 | [配置 Git 凭证] | 「远端拒绝了这次访问：凭证无效或没有这个仓库的权限。配置 Git 访问凭证后再点「拉取最新代码」。」（稿件 f-prj-info-04） |
| `CLONE_FAILED_NOT_FOUND`（404） | 打不开仓库；分不清是凭证失效还是远端仓库改名 / 删除 / 不再开放，两种都说 | [配置 Git 凭证] | 建议句（未出稿）：「打不开这个仓库：可能是 Git 凭证失效了，也可能是远端仓库已经改名、删掉或不再对你开放。」 |
| `CLONE_FAILED_NETWORK`（502）/ `INTERRUPTED` | 没拉下来的原因；再点一次即可 | （按钮本身就是重试） | 建议句：「网络不通，没拉下来。检查网络后再点「拉取最新代码」。」/「拉取被中断了，再点一次「拉取最新代码」。」 |
| `TIMEOUT`（504） | 超时（时限取 `PARAM.PROJECT_SYNC_TIMEOUT_MIN`）；仓库大或网慢 | — | 建议句：「5 分钟内没拉完（仓库较大或网络较慢），再点一次试试。」 |
| `DISK_INSUFFICIENT`（507） | 磁盘不够；先腾空间 | — | 建议句：「磁盘空间不足，没拉下来。清理出空间后再拉。」 |
| `INVALID_STATE`（409） | 这个项目现在不能拉取 | — | 建议句：「这个项目现在不能拉取（只有就绪的 Git 项目可以）。」 |

**改写了哪条旧文**：原产品文档没有结果口径（P21-6 全文无此动作）；现状成功静默（useProjectBranches.ts:93-95 只让项目列表失效）→ 成功一句（Q-DS-35②）；现状失败句复用克隆文案「…配置 Git 访问凭证后可重试克隆」等（projectClone.ts:120、141-145、149-181）→ 拉取自己的话（DR-25）；现状失败红字挂在信息条右侧（ProjectInfoBar.view.tsx:153-170）→ 浮层正文；现状 [配置 Git 凭证] 只跳页面（WorkbenchContainer.tsx:357-359）→ 定位到 Git 分区。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-PRJ-022.1 | 集成 | 浮层开着，拉取返回 200（体积 46 MB） | 结果回来 | 「最后拉取」= 刚刚（提示里是 2026/10/2 14:28:05）、代码体积 46 MB；role="status"「已更新到最新；已建好的任务不受影响」；两处按钮恢复 | 偏离：成功静默，只刷新数据（useProjectBranches.ts:93-95）（稿件 f-prj-info-05） |
| AC-PRJ-022.2 | 集成 | 浮层开着，拉取返回 403 `CLONE_FAILED_PERMISSION` | 结果回来 | 四项不变；浮层正文 role="alert" 一句（见上表）+ [配置 Git 凭证]；两处按钮恢复 | 偏离：句尾是「可重试克隆」（projectClone.ts:120），句子挂在信息条右侧（ProjectInfoBar.view.tsx:153-170）（稿件 f-prj-info-04） |
| AC-PRJ-022.3 | 单元 | 拉取分别返回 404 / 502 / 504 / 507 / 中断 | 生成失败句 | 每个码一句拉取自己的话，句子里没有「克隆」 | 偏离：五个码都用克隆的句子（projectClone.ts:138-181，经 useProjectBranches.ts:98-99） |
| AC-PRJ-022.4 | e2e | 失败句带 [配置 Git 凭证] | 点它 | 到「凭证管理」并定位到 Git 分区 | 部分实现：只跳页面，不定位（WorkbenchContainer.tsx:357-359） |
| AC-PRJ-022.5 | 集成 | 浮层关着，从顶栏按钮发起拉取 | 拉取失败 | 浮层自动打开贴在 chip（或 ⓘ）下，焦点不动，失败句 role="alert" | 未实现（稿件 f-prj-info-04 头注释） |
| AC-PRJ-022.6 | 集成 | 浮层关着，从顶栏按钮发起拉取 | 拉取成功 | 浮层不打开；视觉隐藏的 status 播报「已更新到最新；已建好的任务不受影响」；chip 的说明与总览项目卡的最后拉取变成「刚刚」 | 未实现（稿件 f-prj-info-05 头注释） |

## PRJ · 项目详情（F-PRJ-DETAIL）

### REQ-PRJ-030 · 项目详情：独立只读弹层五行，计数不知道写「—」，零按钮 {#REQ-PRJ-030}

> 状态 `部分实现` · 版本 MVP · 来源 P21-6 §3.3（L52-63）；F21-6 L40、L105-140、L201（不展示来源）、L226（零按钮的否定断言）；v1 g7-02；U-26、U-84；实现 ProjectGroupMenu.view.tsx:106-109、ProjectDetailPanel.view.tsx:34-38、61-63、82-120，ProjectMenuContainer.tsx:61-62、96-103，WorkbenchContainer.tsx:466-488 · 关联 REQ-PRJ-050、F-AUT-RULES（规则数）· 稿件 f-prj-detail-01

任一项目的「⋯」→「项目详情」打开一个只读对话框：标题「项目详情」，副标题项目名；五行——状态（可用 / 正在克隆 / 克隆失败）、任务数、创建时间、已保留成果 N 项、自动化规则 N 条。**不列**名称（标题区已有）与来源。对话框里**没有任何按钮**，只有右上关闭（打开时焦点在它上面）；跳转与删除都只在「⋯」菜单。关闭后焦点回到「⋯」。

两个计数还不知道（加载中**或**取不回来）时**必须**写「—」，**不得**写 0——写 0 会让人以为自己什么都没留下。计数与「保留下来的成果」「自动化规则」同源：在那两处删掉一份 / 一条之后，再打开详情，数字已随之变化。克隆失败的项目在五行下面多一句指路：「克隆没成功。[重试克隆] 和 [改为空项目] 在项目名右边的「⋯」菜单里，不用删掉重建。」（只指路，不放按钮：全仓只许一处持有重试克隆）。

**改写了哪条旧文**：P21-6 §3.3（L52-63）「项目菜单 = 侧弹层：项目名 + 任务数 + 创建时间 + [重命名][归档][删除] + 自动化规则 + 已保留卷」→ 已被 2026-09-14 的菜单拆分取代（F21-6 L120-140）：去处平铺在「⋯」菜单一层，详情独立成只读弹层并加两行计数；[重命名][归档] 不做（F21-6 §10.2 D，plan「不做」U-91）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-PRJ-030.1 | 组件 | acme-web：可用、7 个任务、创建于 2026/9/8 14:02:33、1 份成果、4 条规则 | 「⋯」→ 项目详情 | 五行依次为 可用 / 7 / 2026/9/8 14:02:33 / 1 项 / 4 条；没有名称行、来源行；对话框里的按钮只有关闭 | 已实现：ProjectDetailPanel.view.tsx:82-100（零按钮由 story 否定断言钉住，F21-6 L226）（稿件 f-prj-detail-01） |
| AC-PRJ-030.2 | 组件 | 成果与规则的计数还在加载 | 渲染 | 两行写「—」 | 已实现：ProjectDetailPanel.view.tsx:61-63，ProjectMenuContainer.tsx:101-102 |
| AC-PRJ-030.3 | 集成 | 成果列表（或规则列表）读取失败 | 渲染 | 对应那一行写「—」，不写「0 项 / 0 条」 | 偏离：只判断加载中，读取失败后按空列表算成 0（ProjectMenuContainer.tsx:101-102；useRetainedVolumes.ts:104，useAutomations.ts:273） |
| AC-PRJ-030.4 | 组件 | 克隆失败的项目 | 打开项目详情 | 状态「克隆失败」，下面一句指路到「⋯」菜单，没有重试 / 改空按钮 | 已实现：ProjectDetailPanel.view.tsx:113-120（这句现为 11px，换皮按 v2 字阶改） |
| AC-PRJ-030.5 | 集成 | 在「保留下来的成果」里删掉 1 份 | 再打开项目详情 | 「已保留成果」少 1 | 已实现：同一个查询键，删除后失效（useRetainedVolumes.ts:73-79，ProjectMenuContainer.tsx:61） |

## PRJ · 删除项目（F-PRJ-DELETE）

### REQ-PRJ-040 · 删除项目打开即说清：活跃任务与没清理的成果拦下并给去处 {#REQ-PRJ-040}

> 状态 `偏离` · 版本 MVP · 来源 BACKLOG DR-04 推荐 ①、③A（看稿组 1；不回复默认同推荐）；D3（01 §3.2「如实披露」）；Q-DS-17 A（design-track/final/design-decisions.md:37「后端会拒绝的情况打开时就说明并给去处」）；P21-6 L102、L118；P22 L60；F21-6 L186、§10.6；v1 g7-10；U-30、U-85；实现 DeleteProjectConfirm.view.tsx:89-98，projectDeletion.ts:16-30，projectErrorCopy.ts:31-32，useProjects.ts:94-108，api project-application.service.ts:254-262、340-352、370-377 · 关联 REQ-PRJ-050 · 稿件 f-prj-delete-02

打开删除确认时就判断能不能删，**不得**等用户按下 [删除项目] 才被后端拒绝。两类情况拦下，都有时两条都列：

1. 项目下还有**活跃的任务**——准备中、运行中（含空闲）、等待你输入、停止中（自动化跑出来、还在跑的任务也算）：拦截块标题「请先停止或销毁 N 个还在活动的任务」，逐个列「任务名 · 状态」，去处 [去停止或销毁]——关掉弹层，左侧树展开该项目并滚到它，树的筛选若不是「全部」先清回「全部」，让这些任务都出现在眼前（树没有「活跃」这一档，只筛「运行中」会把「等待你输入」的藏起来，见待裁决 Q-PRJ-05）。
2. 项目下还有**没清理的保留下来的成果**：一句「还有 M 份保留下来的成果没清理：<来源任务名、…>（也可以等它到期自动清理）」（多份写「等它们」；W4 评审 R2-22：原写「 · 或等到期自动回收」，折行后分隔点会落到行首，「回收」也与全站的「清理」不一致），去处 [去清理]——打开该项目的「保留下来的成果」（REQ-PRJ-050；关掉删除确认，不叠弹层）。

只有第 2 类时拦截块标题写「请先清理 M 份保留下来的成果」。被拦时 [删除项目] 禁用但可聚焦（`aria-disabled` + 说明指向原因），左边写原因：「先停止或销毁上面 N 个任务，并清理 M 份成果」（只有一类时只写那一类）；「处理完之后，会删掉」照常如实列出（REQ-PRJ-041；任务一条写「这个项目下剩下的任务和它们的代码副本（现在共 X 个）」——处理时可能先销毁其中几个）；焦点在 [取消]。

后端同样拦，界面先拦、后端兜底，判据一致：有活跃任务 → 409（专属码，**不得**复用 `INVALID_STATE` 或 `PROJECT_HAS_LIVE_RETAINED_VOLUMES`）；有没清理的成果 → 409 `PROJECT_HAS_LIVE_RETAINED_VOLUMES`（已清理的留档记录不拦）。

**改写了哪条旧文**：P21-6 L102「失败项目点击 [删除]：…级联销毁项目记录 + 工作区（若有 Task 则一并删除）」、P21-6 L118「项目删除是唯一的级联破坏性操作」、P22 L60「将删除该项目下 N 个 Task 及其数据卷（保留的成果卷除外）…确认后级联销毁」、F21-6 L186 与 §9.1 #16「含 N 个运行中任务将被强制停止」→ 活跃任务不再被强制停下，而是拦下并给去处（DR-04 ①、D3）；没清理的成果不再「除外」，而是拦下 + [去清理]（DR-04 ③A）；现状确认框里的「其中 N 个任务正在跑，会被强制停下」（DeleteProjectConfirm.view.tsx:91-92）作废。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-PRJ-040.1 | 组件 | acme-web：5 个活跃任务（等待你输入 2、运行中 3）+ 1 份没清理的成果 | 「⋯」→ 删除项目… | 拦截块两条：活跃任务逐个列名 + [去停止或销毁]；成果一句 + [去清理]；[删除项目] `aria-disabled`，左边「先停止或销毁上面 5 个任务，并清理 1 份成果」；焦点在 [取消] | 偏离：打开时不拦，只有一句「其中 N 个任务正在跑，会被强制停下」（DeleteProjectConfirm.view.tsx:89-98）；成果要按下之后才被 409 拦（稿件 f-prj-delete-02） |
| AC-PRJ-040.2 | 单元 | 任务状态分别为 准备中 / 运行中 / 空闲 / 等待你输入 / 停止中 / 已停止 / 异常 | 计算活跃数 | 前五种计入；已停止、异常不计入 | 部分实现：只数 preparing / running / waiting-input（projectDeletion.ts:16-20）；停止中在前端没有单独状态（types/domain.ts:5-6） |
| AC-PRJ-040.3 | 集成 | 被拦态，左侧树筛选为「已停止」 | 点 [去停止或销毁] | 弹层关闭；树的筛选回到「全部」，该项目展开并滚入视野，5 个活跃任务都看得见 | 未实现 |
| AC-PRJ-040.4 | 集成 | 被拦态 | 点 [去清理] | 删除确认关闭，打开该项目的「保留下来的成果」 | 未实现：没有这个按钮，409 文案只指路（projectErrorCopy.ts:31-32） |
| AC-PRJ-040.5 | API | 项目下有活跃任务 | `DELETE /api/projects/{id}` | 409（专属码），项目与任务都不动 | 未实现：delete() 不检查任务（project-application.service.ts:254-281） |
| AC-PRJ-040.6 | API | 项目下有 deletedAt 为空的成果；另一项目只有已清理的成果 | 分别 `DELETE` | 前者 409 `PROJECT_HAS_LIVE_RETAINED_VOLUMES`；后者不被成果拦 | 已实现：project-application.service.ts:259、340-352、370-377 |

### REQ-PRJ-041 · 可删时如实列出：会删掉 / 删掉之后 / 不受影响 {#REQ-PRJ-041}

> 状态 `偏离` · 版本 MVP · 来源 BACKLOG DR-04 ②A（已停止 / 异常的任务随项目销毁并列名）、DR-17（规则与运行历史在同一事务里先删）；Q-DS-17 A；P21-7 L8、L170（删项目级联删规则）；P21-6 L118（确认文案列出受影响数）；v1 g7-09；实现 DeleteProjectConfirm.view.tsx:71-87，api project-application.service.ts:254-281，automation.sqlite.ts:15-18，drizzle/0018_hesitant_bushwacker.sql:51，drizzle.connection.ts:55，sandbox.sqlite.ts:17，web selectProjectTaskTree.ts:4、21、42-52 · 稿件 f-prj-delete-01

没有活跃任务、也没有没清理的成果时可以删。确认对话框按 Q-DS-17 A 的统一结构：标题「删除项目「X」？」，副标题一句概况（如「项目 · 3 个任务，都已停止」）；分段如下，没有的那一项不写：

- **会删掉**：已停止 / 异常的 N 个任务和它们的代码副本（逐个列任务名，后跟一句状态）；这台机器上的仓库副本（体积）；N 条自动化规则，以及它们的运行历史。克隆失败的项目这台机器上没有代码副本（失败时已清掉），如实写「项目「X」本身（克隆没成功，这台机器上没有它的代码；也没有任务、保留成果和自动化规则）」。
- **删掉之后**：拿不回来；要再用这个仓库，只能重新建项目、重新克隆。
- **不受影响**：远端 Git 仓库（代码和提交历史都不动）；其它项目，以及它们的任务和成果。
- 清单来源一句（后端返回：任务列表、保留成果列表、自动化规则）。

页脚 [取消]（左，打开时焦点在这里）+ [删除项目]（右，destructive）。后端**必须**按同一份清单做：同一事务里删掉这些任务的记录与代码副本、规则与运行历史、项目行；代码目录在事务提交之后再删（REQ-PRJ-043）。删完不留孤儿任务。

**改写了哪条旧文**：现状确认三段「会删掉 / 会留下 / 删掉之后」（DeleteProjectConfirm.view.tsx:71-87）→ Q-DS-17 A 的「会删掉 → 删掉之后 → 不受影响」，并列出任务名与规则数；P21-7 L170「删除→级联删规则（运行中的等完成或超时取消）」→ 规则在同一事务里先删；规则正在跑出来的任务是活跃任务，按 REQ-PRJ-040 先拦下，不再「等完成或超时取消」。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-PRJ-041.1 | 组件 | 示例项目：3 个已停止任务、12 MB、1 条规则、成果已清理 | 「⋯」→ 删除项目… | 会删掉三条：「3 个任务和它们的代码副本：跑一遍示例测试、梳理目录结构、试用自动化规则（都已停止）」「这台机器上的仓库副本（12 MB）」「1 条自动化规则，以及它的运行历史」；不受影响两条；焦点在 [取消] | 偏离：只写「这个项目下的 N 个任务，以及它们的工作目录。」，不列名、不提规则（DeleteProjectConfirm.view.tsx:73-74）（稿件 f-prj-delete-01） |
| AC-PRJ-041.2 | 组件 | docs-site：没有任务、8 MB、没有规则 | 打开删除确认 | 会删掉只有「这台机器上的仓库副本（8 MB）」一条，不出现任务与规则两条 | 偏离：固定写「这个项目下的 0 个任务…」（DeleteProjectConfirm.view.tsx:74） |
| AC-PRJ-041.3 | API | 项目下有 3 个已停止的任务 | 删除成功 | 3 个任务都被销毁（记录与代码副本），任务列表里不再有它们，树上不出现「未分组」 | 偏离：delete() 不碰任务，任务成为孤儿落进「未分组」（project-application.service.ts:254-281；sandboxes.project_id 无外键，sandbox.sqlite.ts:17；selectProjectTaskTree.ts:42-52） |
| AC-PRJ-041.4 | API | 项目下有 1 条自动化规则（带运行历史） | `DELETE /api/projects/{id}` | 规则与运行历史一起删掉，删除成功 | 偏离（代码推断，未实测）：规则外键 RESTRICT 且外键检查开着，delete() 不删规则 ⇒ 事务被顶回、500 `INTERNAL`（automation.sqlite.ts:15-18，0018_hesitant_bushwacker.sql:51，drizzle.connection.ts:55，error-envelope.filter.ts:32-33）；同一机制已在保留成果的外键上实证过（retained-volume.repository.ts:20-35） |

### REQ-PRJ-042 · 删除正在克隆的项目：先停克隆再删，就地给 [取消克隆（保留项目）] {#REQ-PRJ-042}

> 状态 `部分实现` · 版本 MVP · 来源 BACKLOG DR-41（不回复默认：保留就地按钮）；F21-6 §10.6 第 2 条（L513-518）；Q-DS-17 A（有安全选项就就地给出）；v1 g7-11；实现 DeleteProjectConfirm.view.tsx:100-106，ProjectGroupMenu.view.tsx:155-167，api project-application.service.ts:231-240、263 · 关联 REQ-PRJ-013（取消克隆之后落定为「克隆失败 · 被中断」）· 稿件 f-prj-delete-03

项目正在克隆时，删除确认顶部一块说明「这个项目正在克隆」：「删除会先停掉这次克隆，再把项目一起删掉。如果你只是想停下这次克隆、把项目留着，用这个：」+ 就地 [取消克隆（保留项目）]（次按钮，与页脚的红色 [删除项目] 刻意长得不一样）。会删掉：「正在进行的这次克隆：先停掉，已经下载的 X MB 直接丢弃」「项目「X」本身（还没有任务、保留成果和自动化规则）」。点 [取消克隆（保留项目）] = 关掉删除确认 + 取消克隆（与「⋯」菜单里的同名项是同一个动作），项目留在树上，克隆随后落定为「克隆失败 · 被中断」（REQ-PRJ-013，f-prj-clone-06）。

**改写了哪条旧文**：现状只有一句指路「请改用菜单里的 [取消克隆（保留项目）]」（DeleteProjectConfirm.view.tsx:101-104）→ 就地按钮（DR-41）；产品文档此前没有这一态（只有 F21-6 §10.6 第 2 条）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-PRJ-042.1 | 组件 | infra-scripts 克隆中（42%，已下载 18.4 MB） | 「⋯」→ 删除项目… | 顶部说明块 + [取消克隆（保留项目）]；会删掉两条（见上）；焦点在 [取消] | 部分实现：有一句指路，没有就地按钮（DeleteProjectConfirm.view.tsx:100-106）（稿件 f-prj-delete-03） |
| AC-PRJ-042.2 | 集成 | 同上 | 点 [取消克隆（保留项目）] | 删除确认关闭；发 `POST /api/projects/{id}/cancel-clone`；项目留在树上，随后落定为「克隆失败 · 被中断」（REQ-PRJ-013） | 部分实现：「⋯」菜单里的同名项已接（ProjectGroupMenu.view.tsx:155-167），确认框里没有 |
| AC-PRJ-042.3 | API | 克隆中的项目 | `DELETE /api/projects/{id}` | 先取消克隆，再删项目 | 已实现：project-application.service.ts:263 |

### REQ-PRJ-043 · 删除中不可关、失败就地说、项目原样保留 {#REQ-PRJ-043}

> 状态 `偏离` · 版本 MVP · 来源 BACKLOG DR-17（sev2：代码目录在事务提交之后再删；外键错误映射为 409 不要 500）；F21-6 §10.7 集成 ③（删除失败不静默关闭）；AppDialog 的 busy 守卫（F21-6 L228）；实现 DeleteProjectConfirm.view.tsx:108-139，ProjectMenuContainer.tsx:64-75，WorkbenchContainer.tsx:466-488，AppDialog.view.tsx:11-12、50、65-70，api project-application.service.ts:264-280 · 稿件 f-prj-delete-04

点 [删除项目] 之后：按钮变「删除中…」（前缀转圈）并禁用，[取消] 与右上关闭也禁用，Esc 与点遮罩都**不**关；读屏 status「正在删除项目「X」…」。失败时弹层不关，正文末尾就地一句 role="alert"：失败原因 +「项目原样保留，什么都没删；<下一步>」，按钮与关闭恢复。不用轻提示报告这个结果（UX-DS-508）。

删除**必须**全有或全无：任务、规则、运行历史、项目行在同一个事务里删；代码目录在事务提交之后再删；任何一步失败，什么都不少。

**改写了哪条旧文**：F21-6 VS-2 失败路径「删除请求 500 → 组仍在 + 错误 toast」（L382）→ 弹层不关、就地一句（与 §10.7 ③ 一致）；现状删除中只禁两个按钮，对话框仍能关（WorkbenchContainer.tsx:467-473 没传 busy）；现状先删代码目录、再在事务里删行（project-application.service.ts:264-280）→ 事务提交之后再删目录（DR-17）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-PRJ-043.1 | 组件 | 删除确认（可删态） | 点 [删除项目] | 「删除中…」禁用并带转圈；[取消] 与右上关闭禁用；Esc、点遮罩不关；role="status"「正在删除项目「示例项目」…」 | 偏离：只禁两个按钮（DeleteProjectConfirm.view.tsx:119、130、137）；对话框没拿到 busy，✕ / Esc / 遮罩仍能关（WorkbenchContainer.tsx:467-473，AppDialog.view.tsx:50、65-70）（稿件 f-prj-delete-04 左） |
| AC-PRJ-043.2 | 集成 | 删除请求网络不通 | 结果回来 | 弹层不关；正文末尾 role="alert"「没能删除项目：连不上平台（网络不通）。」+「项目原样保留，什么都没删；网络恢复后可以再点一次「删除项目」。」；按钮与关闭恢复 | 部分实现：不关、就地红字已有（ProjectMenuContainer.tsx:70-73，DeleteProjectConfirm.view.tsx:108-112）；没有「原样保留」那半句（现状也不成立，见 043.3）（稿件 f-prj-delete-04 右） |
| AC-PRJ-043.3 | API | 删除在事务里失败（如外键冲突） | `DELETE /api/projects/{id}` | 项目、任务、规则、代码目录都还在；返回 409（不是 500） | 偏离（代码推断）：代码目录在事务之前就删了（project-application.service.ts:264-267），事务失败后项目还在、代码没了；外键错误落成 500 |

### REQ-PRJ-044 · 删除成功：各处同时消失，删的是当前项目时回总览并说一句 {#REQ-PRJ-044}

> 状态 `部分实现` · 版本 MVP · 来源 F21-6 §10.6 第 1 条（L510-512）、§9.1 #17；plan F-PRJ-DELETE（回总览 + 页内提示）；Q-DS-28 A（项目总览）；Q-DS-35①（找不到对象回总览，F-WB-ROUTE）；实现 useProjects.ts:138-151，WorkbenchContainer.tsx:483-486 · 稿件（无单独稿：结果是总览页顶部的页内提示，写法同销毁任务之后的提示）

删除成功：弹层关闭；项目同时从左侧树、项目总览、⌘K、新建任务的项目下拉里消失，它的任务**不得**在任何地方残留（不出现「未分组」）；树组计数、导航「等待你输入」徽标随之更新。删掉的正是当前项目（或当前任务所属的项目）时：选中态清空，主区回到项目总览，顶部一句页内提示「已删除项目「X」」（可加一句删掉了什么），读屏播报同一句；地址改为总览；浏览器后退到被删项目的地址时按 Q-DS-35① 回落总览。

**改写了哪条旧文**：F21-6 §9.1 #17「当前项目被删 → 自动落到另一个项目」与 §10.6 第 1 条「主区回到引导态」→ 回项目总览 + 一句页内提示（v2 有总览，Q-DS-28 A）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-PRJ-044.1 | 集成 | 删除示例项目成功 | 结果回来 | 树、总览、⌘K、新建任务下拉里都没有示例项目；它的 3 个任务不在任何组里 | 部分实现：项目列表与任务列表都失效重取（useProjects.ts:148-149）；任务成孤儿（见 AC-PRJ-041.3） |
| AC-PRJ-044.2 | e2e | 正在看示例项目里的任务 | 删除示例项目成功 | 主区回项目总览，顶部「已删除项目「示例项目」」，读屏播报同一句 | 部分实现：选中态已清空（useProjects.ts:143-147），主区落到「选择左侧项目…」引导，没有提示 |

## PRJ · 保留下来的成果（F-PRJ-RETAINED）

### REQ-PRJ-050 · 「保留下来的成果」：统一名称，五个入口打开同一个弹层 {#REQ-PRJ-050}

> 状态 `部分实现` · 版本 MVP（原标 v1.1，实现已落地）· 来源 P21-6 L61、L67（「已保留卷」，v1.1）；P20 L339；Q-SYS-23 A、Q-SBX-03 A（用户拍板 2026-10-04，原话「补全 10 条按推荐」：统一叫「保留下来的成果」「代码副本」）；P21-5 L23-24、L84；F21-6 L34、L106、L315；Q-DS-33 A（plan 默认）；BACKLOG DR-27；U-27、U-86、U-108；实现 ProjectGroupMenu.view.tsx:110-113，WorkbenchContainer.tsx:508-516，RetainedVolumesPanel.view.tsx:3-5、64-66，page.tsx:30，SystemStatusContainer.tsx:25-30、47-51，ResourcePoolCard.view.tsx:179-183，resourceModel.ts:153 · 关联 REQ-SYS-020（AC-SYS-020.6 的去处由 REQ-PRJ-056 定义）· F-WB-CMDK · F-SBX-DESTROY · 稿件 f-prj-retained-01、f-prj-retained-05

销毁任务时选择留下的那份代码副本（以及自动化跑完留下的产物），屏上一律叫「保留下来的成果」；「保留卷」「已保留卷」「成果卷」「工作区卷」「工作目录」**不得**上屏——系统状态资源卡也改用「成果占用」与 [清理成果]（Q-SYS-23 A、Q-SBX-03 A，用户拍板 2026-10-04；此前给系统状态页留的「保留卷占用」「[清理保留卷]」例外取消，REQ-SYS-020）。代码标识符（`/api/retained-volumes`、`RetainedVolumesPanel`、`PROJECT_HAS_LIVE_RETAINED_VOLUMES`）与审计里的对象类型不改；需要对照旧文时注明「旧称保留卷」。五个入口打开**同一个**弹层（标题「保留下来的成果」，副标题「在 X 中」；跨项目视图为「全部项目」）：

| 入口 | 打开哪一份 |
|---|---|
| 项目「⋯」→ 保留下来的成果 | 该项目 |
| 删除项目被拦时的 [去清理]（REQ-PRJ-040） | 该项目 |
| 销毁任务确认里「留下来作为成果」的说明、销毁之后的页内提示里的「保留下来的成果」（文字链接） | 该任务所属项目 |
| ⌘K「保留下来的成果 · <项目>」（每个有成果的项目一条，F-WB-CMDK） | 该项目 |
| 系统状态 [清理成果]（REQ-SYS-020，旧称 [清理保留卷]） | 跨项目视图（REQ-PRJ-056） |

弹层顶部一句说明：「X 保留下来的成果：销毁任务时选择留下的那份代码副本。到期后由后台自动清理。」不提供「恢复」（P20 L339）。

**改写了哪条旧文**：P21-6 L61「🎁 [已保留卷]（管理成果，v1.1）」、L67、P20 L339「项目菜单可见为"已保留卷"（…v1.1）」→「保留下来的成果」，不再标 v1.1（实现已落地，F21-6 L34）；P21-5 L84 横幅 [清理] 与 [清理保留卷] 的去处未定 → Q-DS-33 A 跨项目视图，按钮改叫 [清理成果]（Q-SYS-23 A）；DR-27 的不回复默认「接好之前先隐藏按钮」→ 本轮直接接好，按钮保留。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-PRJ-050.1 | e2e | 任一项目 | 「⋯」→ 保留下来的成果 | 打开「保留下来的成果」，副标题「在 X 中」 | 已实现：ProjectGroupMenu.view.tsx:110-113，WorkbenchContainer.tsx:508-516 |
| AC-PRJ-050.2 | e2e | 系统状态磁盘警告，出现 [清理成果] | 点它 | 打开同一个弹层的跨项目视图 | 未实现（缺陷）：页面没传回调，点了没反应（page.tsx:30，SystemStatusContainer.tsx:47-51；DR-27） |
| AC-PRJ-050.3 | 集成 | 删除项目被拦（有没清理的成果） | 点 [去清理] | 打开该项目的「保留下来的成果」 | 未实现（同 AC-PRJ-040.4） |
| AC-PRJ-050.4 | e2e | 销毁任务时选「留下来作为成果」 | 销毁完成 | 页内提示里的「保留下来的成果」是链接，点开是该项目的列表，新的一份在里面 | 未实现：web 没有销毁任务的界面（BACKLOG DR-03：sandbox.service 只有 create / get / list） |
| AC-PRJ-050.5 | e2e | 示例项目与 acme-web 都有成果 | ⌘K 搜「成果」 | 每个有成果的项目一条「保留下来的成果 · <项目> N 份」，选中打开该项目的列表 | 未实现：web 没有 ⌘K（format-pilot AC-SYS-001.4）；由 F-WB-CMDK 补 |
| AC-PRJ-050.6 | 组件 | 成果弹层（列表、空态、删除确认）与删除项目确认 | 扫上屏文字 | 只用「保留下来的成果」「代码副本」；不出现「工作目录」「保留卷」「已保留卷」「成果卷」「工作区卷」 | 偏离：成果弹层的说明、空态与行内确认写「工作目录」（RetainedVolumesPanel.view.tsx:65、87、158），删除项目确认写「…以及它们的工作目录。」（DeleteProjectConfirm.view.tsx:74） |

### REQ-PRJ-051 · 成果列表：按到期先后、来源任务名、两个大小、三档倒计时、合计与读法 {#REQ-PRJ-051}

> 状态 `部分实现` · 版本 MVP · 来源 P20 L339-341；P21-5 L89（取整规则）；技术 10 §6「保留卷的打包口径」（两个大小）；BACKLOG DR-10（来源任务名；plan REQ-PRJ-051 按推荐写）；Q-PRJ-06 A（用户拍板 2026-10-04，原话「补全 10 条按推荐」）；UX-DS-113；v1 g2-16；实现 RetainedVolumesPanel.view.tsx:44-46、92-139、202，retainedVolumeModel.ts:33-36、51-58、63-85、96-120，契约 project.schema.ts:141-155 · 稿件 f-prj-retained-01、f-prj-retained-05

列表按到期先后排：最先被清掉的在最上面，到期时间读不出的排最后。顶部合计「共 N 个 · 占用 X · 全部下载 Y」。每一行：

- 标题 = **来源任务名**（登记成果时快照下来的任务名；拿不到名字时写「来自任务 <8 位短号>…」，完整 id 放提示里；连 id 也关联不到时写「关联不到来源任务（可能已被删除）」，**不得**写「已归档」）；
- 行尾倒计时（REQ-PRJ-055）：快到期（不足 1 天 / 即将清理）用警告徽标（三角图标 + 字，不只靠颜色），其余次要灰文字；
- 「<来源> · 保留于 <时间>」，来源是「销毁任务时保留」或「自动化产物」；
- 「占用 X · 下载 Y」：两个大小都**必须**显示（同一份可能差几十倍，只给一个都会误导）；
- 动作 [下载（Y）]（REQ-PRJ-052）+ [删除]（进入二次确认的入口，红字次级按钮，REQ-PRJ-053）。

列表下方一句读法：「「占用」是宿主磁盘实占（删掉能拿回的空间）；「下载」是打包成 tar 的大小（.gitignore 命中的不打包，.git 保留）。」

**改写了哪条旧文**：现状行标题「来自任务 7f3a1c2e…」（retainedVolumeModel.ts:53-58）→ 来源任务名（Q-PRJ-06 已拍板 A，用户拍板 2026-10-04；即 DR-10 推荐，不是它的不回复默认「维持短号」）；P20 L339 只写「可再次下载 / 重新删除」→ 补齐列表内容。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-PRJ-051.1 | 单元 | 3 份成果，到期分别在 10/2 18:20、10/18 11:05、10/29 10:12，另 1 份到期时间读不出 | 生成列表 | 按这个顺序排，读不出的排最后 | 已实现：retainedVolumeModel.ts:96-108 |
| AC-PRJ-051.2 | 组件 | 示例项目 2 份成果 | 打开列表 | 合计「共 2 个 · 占用 3.7 GB · 全部下载 1.0 GB」；每行「占用 · 下载」两个大小；底部有读法 | 已实现：RetainedVolumesPanel.view.tsx:94-96、136-139、202（读法现为 11px，换皮按 v2 字阶改）（稿件 f-prj-retained-01） |
| AC-PRJ-051.3 | 组件 | 成果登记时快照了来源任务名「改一处示例代码」 | 渲染行 | 行标题「改一处示例代码」，完整任务 id 在提示里 | 未实现：DTO 只有 sandboxId（project.schema.ts:141-155），行上是 8 位短号（retainedVolumeModel.ts:53-58）；需后端登记时快照任务名（DR-10） |
| AC-PRJ-051.4 | 单元 | 来源任务名与 sandboxId 都缺 | 渲染行 | 「关联不到来源任务（可能已被删除）」 | 已实现：retainedVolumeModel.ts:53-54 |
| AC-PRJ-051.5 | 组件 | 一份成果不足 1 天到期 | 渲染行尾 | 警告徽标：三角图标 +「不足 1 天」 | 部分实现：只用黄色字，没有图标（RetainedVolumesPanel.view.tsx:115-125）（稿件 f-prj-retained-01） |

### REQ-PRJ-052 · 下载：浏览器原生下载，不做恢复 {#REQ-PRJ-052}

> 状态 `已实现` · 版本 MVP · 来源 P20 L339、L341（打包下载；不做恢复、不做 diff）；技术 10 §6；实现 RetainedVolumesPanel.view.tsx:15-22、146-153，retained-volume.service.ts:138-158（未压缩 tar + 精确 Content-Length）· 稿件 f-prj-retained-01

[下载（Y）] 是浏览器原生下载（链接 + download 属性），服务端给未压缩的 tar 和精确的 Content-Length，浏览器自己显示进度、走「另存为」；应用内不画进度、不弹轻提示。文件在磁盘上已经找不到的那一份，下载失败由浏览器报告，列表里那一条仍可以删掉（REQ-PRJ-053）。**不**提供「恢复」，也不摆禁用的 [恢复]。

**改写了哪条旧文**：无（沿用 P20 L339、L341：打包下载、不做恢复、不做 diff；合并时补记）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-PRJ-052.1 | e2e | 一份成果，下载包 412 MB | 点 [下载（412 MB）] | 浏览器开始下载一个 tar，响应带精确的 Content-Length | 已实现：RetainedVolumesPanel.view.tsx:146-153，retained-volume.service.ts:138-158 |
| AC-PRJ-052.2 | 组件 | 任意一行 | 渲染 | 没有 [恢复]（也没有禁用的） | 已实现：RetainedVolumesPanel.view.tsx:20-22 |

原型里点 [下载] 出的一句轻提示「已开始下载（原型不产生文件）」只是原型说明，不进产品。

### REQ-PRJ-053 · 删除一份成果：同一弹层就地切成统一确认，删除中只禁这一行 {#REQ-PRJ-053}

> 状态 `偏离` · 版本 MVP · 来源 Q-DS-17 A；gap/drafts/README §4（删数据走同一弹层就地切换的确认视图，不用行内确认）；P20 L339（重新删除）；v1 g2-17；实现 RetainedVolumesPanel.view.tsx:155-196、206-210，useRetainedVolumes.ts:71-81、89-99，retained-volume.service.ts:110-127，projectErrorCopy.ts:37-42 · 关联 REQ-PRJ-030（成果数）· REQ-SYS-020（成果占用）· 稿件 f-prj-retained-02

点某一行的 [删除]：同一个对话框就地切成破坏性确认（标题与副标题替换，**不**叠第二层遮罩）——

- 标题「删除成果「<来源任务名>」？」，副标题「<项目> · <来源> · <倒计时>」；
- 会删掉：这份代码副本（占用 X）；
- 删掉之后：拿不回来；已经下载到本地的压缩包不受影响；
- 不受影响：同项目里另外 N 份成果；<项目>本身，以及它的 N 个任务；
- 清单来源一句；页脚 [取消]（打开时焦点在这里）+ [删除成果]（destructive）。

[取消] 回到列表，焦点回到那一行的 [删除]；右上关闭关掉整个对话框。确认后回到列表：该行显示删除中（**只禁这一行**，其余行照常可用）；成功后该行消失、合计更新，项目详情的成果数与系统状态的成果占用随之更新；失败时列表里就地一句说原因（如「这份成果已经不在了（可能刚被自动清理）。」），记录已经不在的那一行随列表刷新消失。

**改写了哪条旧文**：现状行内确认「永久删除？删掉之后这份工作目录拿不回来。」+ [确认删除][取消]（RetainedVolumesPanel.view.tsx:155-183）→ 同一弹层就地切换的统一确认（Q-DS-17 A；v1 g2-17 已按此画）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-PRJ-053.1 | 组件 | 列表里点「补一份示例 README」的 [删除] | 视图切换 | 同一对话框换成确认：标题「删除成果「补一份示例 README」？」；会删掉「这份代码副本（占用 2.1 GB）」；不受影响「同项目里另外 1 份成果」「示例项目本身，以及它的 3 个任务」；焦点在 [取消]；没有第二层遮罩 | 偏离：行内确认（RetainedVolumesPanel.view.tsx:155-183）（稿件 f-prj-retained-02） |
| AC-PRJ-053.2 | 组件 | 确认视图 | 点 [取消] | 回到列表，焦点回到那一行的 [删除] | 未实现（同上） |
| AC-PRJ-053.3 | 集成 | 确认删除 | 请求进行中 | 只有这一行禁用并显示「删除中…」，其余行可用 | 已实现：useRetainedVolumes.ts:89-96，RetainedVolumesPanel.view.tsx:99、164-170、186-194 |
| AC-PRJ-053.4 | 集成 | 删除成功 | 结果回来 | 该行消失、合计更新；项目详情的「已保留成果」与系统状态的成果占用随之更新 | 部分实现：列表与项目详情同一个查询（useRetainedVolumes.ts:73-79）；系统状态的占用走资源接口，要等下一次轮询（REQ-SYS-010） |
| AC-PRJ-053.5 | 集成 | 删除返回 404 `NOT_FOUND` | 结果回来 | 列表里就地「这份成果已经不在了（可能刚被自动清理）。」，列表刷新后那一行消失 | 已实现：projectErrorCopy.ts:37-42，useRetainedVolumes.ts:73-79（失败也刷新列表） |

### REQ-PRJ-054 · 空与读取失败两个分支不混，读取失败给 [重试] {#REQ-PRJ-054}

> 状态 `部分实现` · 版本 MVP · 来源 BACKLOG DR-38（补 [重试]，不回复默认补上）；v1 g2-18、g2-18b；实现 RetainedVolumesPanel.view.tsx:68-90，useRetainedVolumes.ts:34-43、98 · 稿件 f-prj-retained-03、f-prj-retained-04

- **加载中**：一句「正在读取…」，不显示空态。
- **取回来是空的**：空态——图标 + 标题「这个项目还没有保留下来的成果」+ 说明「销毁任务时选择把代码副本留下来，它就会出现在这里，可以下载，也可以手动删掉。」；没有合计、没有读法。
- **取不回来**：一条失败提示「没能读出保留下来的成果」+ 原因（如「网络不通。」）+ [重试]（重试中转圈禁用）；**不得**显示空态或合计。

**改写了哪条旧文**：现状读取失败只有一句、没有重试，要关掉弹层重开才会重读（RetainedVolumesPanel.view.tsx:74-78）→ 补 [重试]（DR-38）；产品文档此前没写这两个分支。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-PRJ-054.1 | 组件 | docs-site 没有成果 | 打开列表 | 空态标题与说明；没有合计、没有读法 | 已实现：RetainedVolumesPanel.view.tsx:80-90（稿件 f-prj-retained-03） |
| AC-PRJ-054.2 | 组件 | 列表接口网络不通 | 打开列表 | 失败提示「没能读出保留下来的成果」+「网络不通。」+ [重试]；没有空态 | 部分实现：有失败句「网络不通，请稍后再试。」（useRetainedVolumes.ts:36），没有 [重试]（RetainedVolumesPanel.view.tsx:74-78）（稿件 f-prj-retained-04） |
| AC-PRJ-054.3 | 集成 | 失败态 | 点 [重试] | 重新请求，按钮转圈禁用；成功后显示列表或空态 | 未实现 |

### REQ-PRJ-055 · 倒计时只属于保留下来的成果，按每份自己的到期时间 {#REQ-PRJ-055}

> 状态 `部分实现` · 版本 MVP · 来源 UX-DS-113（design-track/final/spec/status-mapping.md:57）；BACKLOG DR-03 A（已停止的任务不过期、不显示倒计时）、DR-18（自动化产物按规则的保留期登记）；P21-5 L89（取整规则）；P20 L341（3 / 7 / 30 天）；实现 retainedVolumeModel.ts:63-85、lib/_shared/formatTime.ts:29-55、retained-volume.service.ts:28、80，sandbox-application.service.ts:753-758 · 关联 PARAM.RETENTION_DAYS_DEFAULT · 稿件 f-prj-retained-01

保留期倒计时只出现在「保留下来的成果」里（以及系统状态的「最早的成果…后清理」）；已停止的任务不过期，任务树副行**不得**出现倒计时。每份成果按**自己的**到期时间（登记时间 + 这一份的保留期）计算：销毁任务时保留的取 `PARAM.RETENTION_DAYS_DEFAULT` 天（现值 30）；自动化产物取规则上设的 3 / 7 / 30 天。三档显示：剩余 ≥ 1 天「还需 N 天」（向下取整）；不足 1 天「不足 1 天」；已过到期时间还没被清走「即将清理」。到期由后台自动清理，先到期的先清。

**改写了哪条旧文**：P21-5 L89「倒计时 = 任务停止/销毁时间 + 30 天」→「成果登记时间 + 这一份的保留期」，停止不起算（DR-03 A、UX-DS-113）；P20 L326-335 生命周期图里「卷保留中（⏸️）→ 30 天自动过期」对已停止任务的 30 天过期作废。

**合并说明**：系统状态资源卡的「最早一份成果多久后被清理」（REQ-SYS-020）按本条的口径统一。（交叉引用：REQ-SYS-020）

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-PRJ-055.1 | 单元 | 到期还剩 6.9 天 / 0.5 天 / 已过到期 | 生成倒计时 | 「还需 6 天」/「不足 1 天」/「即将清理」 | 已实现：retainedVolumeModel.ts:64-72 |
| AC-PRJ-055.2 | 组件 | 有已停止的任务 | 看任务树副行 | 只写「已停止」，没有倒计时 | 已实现：web 树副行没有倒计时（全仓无「保留中」）；v1 稿与 foundation 的副行倒计时按 DR-03 去掉 |
| AC-PRJ-055.3 | API | 销毁任务时选择保留 | 登记成果 | 到期时间 = 登记时间 + `PARAM.RETENTION_DAYS_DEFAULT` 天 | 已实现：retained-volume.service.ts:28、80，sandbox-application.service.ts:753-758 |
| AC-PRJ-055.4 | API | 一条保留期 7 天的自动化规则跑完一次 | 收尾 | 登记一份「自动化产物」，到期 = 登记时间 + 7 天 | 未实现：自动化跑完不登记成果，`automation-artifact` 没有写入点（DR-18） |

### REQ-PRJ-056 · 跨项目视图：系统状态 [清理成果] 进入，范围「全部项目」、按项目分组 {#REQ-PRJ-056}

> 状态 `未实现` · 版本 MVP · 来源 Q-DS-33 A（plan 默认）；BACKLOG DR-27（推荐之一「改成跨项目的列表」）；P21-5 L84；实现 api retained-volume.service.ts:94-101、契约 project.schema.ts:158-162（不带 projectId = 全部项目），web useRetainedVolumes.ts:18-22、64-69（只按项目查）、resourceModel.ts:153 · 关联 REQ-SYS-020 · 稿件 f-prj-retained-05

系统状态在磁盘不是正常、或保留下来的成果超量时给 [清理成果]（REQ-SYS-020；旧称 [清理保留卷]，Q-SYS-23 A）；点它打开「保留下来的成果」弹层的**跨项目视图**：

- 副标题「全部项目」；说明「按项目分组；删掉一份，马上腾出它「占用」那么多磁盘。到期的由后台自动清理。」；
- 范围选择「全部项目 ⌄」（选项：全部项目 + 每个有成果的项目；选了某个项目，等于从该项目「⋯」打开）与合计同一行；
- 按项目分组：组按项目顺序，组头 = 项目名 +「N 个 · 占用 X」，组内按到期先后；行与 REQ-PRJ-051 相同，删除走 REQ-PRJ-053（组空了整组消失）；
- 打开时焦点在范围选择上；关闭后焦点回到 [清理成果]。

数据：`GET /api/retained-volumes` 不带 projectId（接口现成，不加端点）。

<details>
<summary>为什么不是先选项目</summary>

清理的目的是腾磁盘：用户要先看到全部占用再决定删哪份。先弹一个项目菜单（Q-DS-33 B）多一步，而且看不到跨项目的大小对比。

</details>

**改写了哪条旧文**：没有直接对应的旧文（P21-5 L84 只写了横幅 [清理]、没写去处）→ 去处定为跨项目视图（Q-DS-33 A、DR-27；合并时补记）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-PRJ-056.1 | e2e | 磁盘 88%（警告）；共 3 份成果（示例项目 2、acme-web 1） | 点 [清理成果] | 跨项目视图：副标题「全部项目」，合计「共 3 个 · 占用 4.2 GB · 全部下载 1.1 GB」，两组：示例项目「2 个 · 占用 3.7 GB」、acme-web「1 个 · 占用 512 MB」 | 未实现：按钮没接（DR-27），前端只有按项目的查询（useRetainedVolumes.ts:64-69）（稿件 f-prj-retained-05） |
| AC-PRJ-056.2 | 集成 | 跨项目视图 | 范围选「acme-web」 | 只剩 acme-web 一组，合计随之变，副标题「在 acme-web 中」 | 未实现 |
| AC-PRJ-056.3 | 集成 | 跨项目视图里删掉 acme-web 唯一的一份 | 成功 | 该组消失，合计更新；系统状态的成果占用随之更新 | 未实现 |
| AC-PRJ-056.4 | API | 两个项目都有成果 | `GET /api/retained-volumes`（不带 projectId） | 返回全部未清理的成果 | 已实现：retained-volume.service.ts:94-101 |

---

## 附录 A · 改写对照（逐条，来自各片段）

### 改写对照（旧文 → 本片）（prj-b）

| 旧文 | 位置 | 改写为 | 依据 |
|---|---|---|---|
| P21-1 L42、L50「顶部只有当前项目指示器」；F21-6 §9.2「主区顶部一条只读信息」 | REQ-PRJ-020 | 顶栏分支 chip / ⓘ + 项目信息浮层 | pilot P1 第 11 条；plan F-PRJ-INFO |
| F21-6 §9.2 表「分支：—」 | REQ-PRJ-020 | 「远端默认分支」 | 契约 `repoBranch` 可缺省（project.schema.ts:98） |
| F21-6 §9.3「[重新同步]」；sandboxErrorCopy.ts:159「[重新同步]」 | REQ-PRJ-021 | 「拉取最新代码」 | 实现上屏词（ProjectInfoBar.view.tsx:3-4） |
| F21-6 L290-293「作用范围刻意不呈现」 | REQ-PRJ-021 | 按下之前可见的一句 | 实现 SYNC_SCOPE_NOTE（ProjectInfoBar.view.tsx:72-77） |
| 现状拉取成功静默；失败句「…可重试克隆」 | REQ-PRJ-022 | 成功一句；失败说拉取自己的话 + 凭证去处 | Q-DS-35②；DR-25；UX-DS-508 |
| P21-6 §3.3（L52-63）项目菜单侧弹层头部 + [重命名][归档][删除] | REQ-PRJ-030 | 独立只读「项目详情」五行、零按钮；重命名 / 归档不做 | F21-6 L120-140（2026-09-14 拆分）；plan「不做」U-91 |
| P21-6 L102、L118；P22 L60「级联销毁全部任务（保留的成果卷除外）」；F21-6 L186「运行中任务将被强制停止」 | REQ-PRJ-040、041 | 活跃任务 → 拦下 + [去停止或销毁]；没清理的成果 → 拦下 + [去清理]；已停止 / 异常的任务随项目销毁并列名 | DR-04 ①②A③A；D3；Q-DS-17 A |
| 现状确认三段「会删掉 / 会留下 / 删掉之后」 | REQ-PRJ-041 | 「会删掉 → 删掉之后 → 不受影响」+ 清单来源 | Q-DS-17 A |
| P21-7 L170「删除→级联删规则（运行中的等完成或超时取消）」 | REQ-PRJ-041 | 规则与运行历史同一事务先删；规则跑出来的活跃任务按 REQ-PRJ-040 先拦 | DR-17；DR-04 ① |
| 现状删除克隆中项目只有一句指路 | REQ-PRJ-042 | 就地 [取消克隆（保留项目）] | DR-41 |
| F21-6 VS-2 失败路径「错误 toast」（L382）；现状删除中对话框仍能关 | REQ-PRJ-043 | 弹层不可关、失败就地一句、项目原样保留 | DR-17；F21-6 §10.7 ③；UX-DS-508 |
| F21-6 §9.1 #17、§10.6 第 1 条「落到另一个项目 / 回到引导态」 | REQ-PRJ-044 | 回项目总览 + 页内提示 | Q-DS-28 A；plan F-PRJ-DELETE |
| P21-6 L61、L67；P20 L339「已保留卷（v1.1）」 | REQ-PRJ-050 | 「保留下来的成果」，不标 v1.1 | 实现（RetainedVolumesPanel.view.tsx:3-5）；F21-6 L34 |
| P21-5 L84 横幅 [清理]；DR-27 不回复默认「先隐藏按钮」 | REQ-PRJ-050、056 | 接到跨项目视图 | Q-DS-33 A |
| 现状行标题「来自任务 7f3a1c2e…」 | REQ-PRJ-051 | 来源任务名（拿不到写短号） | DR-10 推荐（plan 按推荐） |
| 现状成果行内确认 | REQ-PRJ-053 | 同一弹层就地切换的统一确认 | Q-DS-17 A |
| 现状读取失败没有重试 | REQ-PRJ-054 | 补 [重试] | DR-38 |
| P21-5 L89「倒计时 = 任务停止/销毁时间 + 30 天」；P20 L326-335 已停止任务 30 天过期 | REQ-PRJ-055 | 成果登记时间 + 这一份的保留期；停止不起算 | DR-03 A；UX-DS-113 |

## 附录 B · 片段里的默认决定与待确认（原文）

> 下面是各片段的原文，编号仍是片段里的本地编号；统一编号与完整的选项、推荐、默认在 [open-questions.md](./open-questions.md)，对照见其 §7。

### 待裁决（prj-a）

合入 PRJ.md 时编成 Q-PRJ-NN（与 prj-b 统一编号，避免撞号）。都给了默认，稿件按默认画。

| # | 问题 | 选项 | 默认（稿件按此） | 影响 |
|---|---|---|---|---|
| ① | 满 50 个项目时，新建项目的入口要不要置灰 | A 按现状不置灰，提交时就地说明 · B 四个入口都置灰并说原因（P21-6 L120） | A（DEC-0004 现状为底） | REQ-PRJ-001、REQ-PRJ-003 |
| ② | 改为空项目之后能不能再改回 Git 项目 | A 不能，界面写明不可逆 · B 能，要新接口 · C 先不说（现状） | C（现状：`retry-clone` 只接受 failed，事实上回不去；ProjectGroupMenu.view.tsx:144-147 刻意没写） | REQ-PRJ-015 |
| ③ | 树组头克隆中写不写进度 | A 计数位写进度「42%」（本片原稿）· B 只写「克隆中」+ 任务数 0（原型、实现与别组稿件） | **B**（W2 跨组一致性修正时由编排方定，本片原默认 A）：f-prj-create-03 / 04、f-prj-clone-01 / 03 / 04 / 07 的计数位已改回 0，进度只放主区与项目卡；改选 A 时这 6 张与别组工作台稿都要改成进度写法 | REQ-PRJ-011 |

### 待裁决（prj-b）

接着 prj-a 的 ①–③ 往下编；合入 PRJ.md 时与 prj-a 一起编成 Q-PRJ-NN。都给了默认，稿件按默认画。

| # | 问题 | 选项 | 默认（稿件按此） | 影响 |
|---|---|---|---|---|
| ④ | 删项目时「有活跃任务」的 409 用什么码 | A 新增专属码（建议 `PROJECT_HAS_ACTIVE_TASKS`）· B 复用 `INVALID_STATE`（现文案「还有任务在跑或克隆还没停」对不上新口径） | A；码名由后端定 | REQ-PRJ-040（AC-PRJ-040.5） |
| ⑤ | [去停止或销毁] 把人带到哪 | A 关弹层 + 树的筛选清回「全部」+ 展开该项目并滚入视野（本片）· B plan 原型接线写的「筛到运行中」（会把「等待你输入」的任务藏起来，acme-web 5 个里有 2 个）· C 给树加一档「活跃」筛选（新范围） | A | REQ-PRJ-040（AC-PRJ-040.3） |
| ⑥ | 成果行写来源任务名还是短号 | A 登记成果时快照任务名（DR-10 推荐，plan 采用；要后端加字段）· B 维持 8 位短号（DR-10 的不回复默认） | **已拍板 A**（Q-PRJ-06，2026-10-04 用户原话「补全 10 条按推荐」）：快照任务名，稿件已按 A 画；后端在登记成果时快照任务名 | REQ-PRJ-051、053 |
| ⑦ | 从删除项目点 [去清理]，清理完要不要自动回到删除确认 | A 不回：弹层不叠不串，清理完再从「⋯」删（本片）· B 自动回到删除确认（要另画返回链） | A | REQ-PRJ-040、050 |
| ⑧ | 浮层关着时拉取失败，怎么让人看到 | A 浮层自动打开、不抢焦点、失败句 role="alert"（本片）· B 不打开，顶栏按钮旁出一句（要另画） | A；成功时不自动打开，只播报 | REQ-PRJ-022（AC-PRJ-022.5、022.6） |
| ⑨ | 顶栏 chip 的新文字 | A 空项目写「空项目」、没指定分支写「远端默认分支」（本片）· B 空项目不出 chip，只出 ⓘ | A，需看稿 | REQ-PRJ-020 |

另外两处按「要拍板」与看稿组的默认写，裁决不同时改对应 AC 的 Then：Q-DS-35②（拉取成功一句）→ REQ-PRJ-022；Q-DS-33（[清理成果]，旧称 [清理保留卷]，去处）→ REQ-PRJ-050、056；DR-04、DR-17（看稿组 1）→ REQ-PRJ-040–043。

## 附录 C · 参数（待登记 params.yaml）

### 参数（prj-a）

合入时登记进 docs/reference/params.yaml（01 §4.3）。

| 参数 | 值 | 代码落点 |
|---|---|---|
| `PARAM.PROJECT_MAX` | 50（含克隆失败的项目） | api project-application.service.ts:42；文案 projectErrorCopy.ts:20 |
| `PARAM.PROJECT_NAME_MAX` | 40 字符 | api contracts project.schema.ts:55 |
| `PARAM.CLONE_SLOW_AFTER_S` | 600 秒 | api clone-project.workflow.ts:32 |
| `PARAM.CLONE_TIMEOUT_MIN` | 30 分钟 | api clone-project.workflow.ts:22 |
| `PARAM.CLONE_CONCURRENCY` | 2 | api clone-project.workflow.ts:21 |
| `PARAM.CLONE_MIN_FREE_BYTES` | 1 GiB（环境变量 `CLONE_MIN_FREE_BYTES` 可改） | api clone-project.workflow.ts:46、294-299 |

### 参数（prj-b）

合入时登记进 docs/reference/params.yaml（01 §4.3）。

| 参数 | 值 | 代码落点 |
|---|---|---|
| `PARAM.PROJECT_SYNC_TIMEOUT_MIN`（新增） | 5 分钟 | api sync-baseline.workflow.ts:20 |
| `PARAM.RETENTION_DAYS_DEFAULT`（format-pilot 已登记） | 30 天（销毁任务时保留的成果） | api retained-volume.service.ts:28；system-resources.service.ts 的 `RETENTION_DAYS` |

自动化产物的保留期是每条规则自己的设定（3 / 7 / 30 天，归 F-AUT-RULES），不是平台参数。

## 附录 D · 边界、覆盖对照、待核实与连带更正

### 覆盖对照（盘点项 → 需求）（prj-a）

| 盘点项 | 控件 | 需求 |
|---|---|---|
| U-01 | 侧栏「新建项目」图标 | REQ-PRJ-001 |
| U-10 | 总览「新建 ⌄ → 新建项目…」 | REQ-PRJ-001 |
| U-83 | 新建项目弹层（Git / 空项目 / 提交失败） | REQ-PRJ-002、003、004、005、006 |
| U-04 | 树：克隆失败 / 克隆中项目的折叠箭头 | REQ-PRJ-011 |
| U-11 | 总览项目卡 [重试克隆] [改为空项目] | REQ-PRJ-010、014、015 |
| U-23 | 主区恢复引导 [重试克隆] [改为空项目] | REQ-PRJ-010、014、015 |
| U-24 | 顶栏「新任务」（未就绪项目） | REQ-PRJ-016 |
| U-25 | 克隆进度卡（42%） | REQ-PRJ-012、013 |
| U-29 | 项目菜单 [重试克隆] [改为空项目] | REQ-PRJ-010、014、015 |
| U-88 | 克隆过程与失败变体 | REQ-PRJ-004、005、012、013、014、015 |

### 与其它片的边界（prj-b）

- **prj-a（REQ-PRJ-001–019）**：克隆中 / 克隆失败的项目不出 chip / ⓘ，出口在主区（REQ-PRJ-010、012）；[取消克隆（保留项目）] 之后「克隆失败 · 被中断」（REQ-PRJ-013）、改为空项目之后的样子（REQ-PRJ-015，顶栏项目信息写「空项目」= 本片 REQ-PRJ-020）都由 F-PRJ-CLONE 定义。
- **系统状态（REQ-SYS-020）**：[清理成果] 出现的条件、「成果占用」的用词与计量归 SYS（Q-SYS-23 A 之后与本域同名）；AC-SYS-020.6「进入保留卷管理」的去处 = 本片 REQ-PRJ-056。
- **任务生命周期（F-SBX-DESTROY）**：销毁确认里「留下来作为成果」与销毁之后页内提示里的「保留下来的成果」链接（REQ-PRJ-050 第 3 个入口）由 L2 渲染。
- **其它（F-WB-CMDK、F-WB-ROUTE、F-AUT-RULES）**：⌘K 的「保留下来的成果 · <项目>」、删除之后后退到旧地址的回落（Q-DS-35①）、规则数的来源。
- **凭证（F-CRD-GIT / F-CRD-PAGE）**：[配置 Git 凭证] 要能定位到凭证页的 Git 分区。

### 覆盖对照（盘点项 → 需求）（prj-b）

| 盘点项 | 控件 | 需求 |
|---|---|---|
| U-12 | 顶栏分支 chip「main」（项目信息） | REQ-PRJ-020 |
| U-13 | 顶栏 ⓘ「项目信息」（顶栏 < 960） | REQ-PRJ-020 |
| U-90 | 项目信息浮层 | REQ-PRJ-020 |
| U-14 | 「拉取最新代码」（顶栏按钮 + 窄顶栏菜单项） | REQ-PRJ-021、022 |
| U-89 | 拉取的过程与结果（拉取中 / 成功 / 需要 Git 凭证） | REQ-PRJ-021、022 |
| U-26 | 项目菜单「项目详情」 | REQ-PRJ-030 |
| U-84 | 项目详情弹层 | REQ-PRJ-030 |
| U-30 | 项目菜单「删除项目…」 | REQ-PRJ-040–044 |
| U-85 | 删除项目确认（可删 / 被拦 / 删除克隆中的项目） | REQ-PRJ-040、041、042、043 |
| U-27 | 项目菜单「保留下来的成果」 | REQ-PRJ-050 |
| U-86 | 保留下来的成果（列表 / 下载 / 删除确认 / 空 / 读取失败） | REQ-PRJ-051、052、053、054、055 |
| U-108 | 系统状态 [清理成果]（旧称 [清理保留卷]）的去处（资源告警本身归 F-SYS-RESOURCE） | REQ-PRJ-050、056 |

## 附录 E · 合并时改动的地方

合并只做了下面这些改动；其余文字都是片段原文（本地待定编号已换成统一编号）。

| 需求 | 改动 | 为什么 |
|---|---|---|
| [REQ-PRJ-016](#REQ-PRJ-016) | 加合并说明 | 与 REQ-LCH-001 互相引用 |
| [REQ-PRJ-052](#REQ-PRJ-052) | 补「改写了哪条旧文」 | 补「改写了哪条旧文」 |
| [REQ-PRJ-055](#REQ-PRJ-055) | 加合并说明 | 与 REQ-SYS-020 互相引用 |
| [REQ-PRJ-056](#REQ-PRJ-056) | 补「改写了哪条旧文」 | 补「改写了哪条旧文」 |
