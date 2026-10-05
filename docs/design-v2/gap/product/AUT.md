---
id: PRD-AUT
title: 自动化规则 · 产品需求
type: prd
status: draft
owner: 产品 owner（仓库唯一人类 owner）
domains: [AUT]
flows: [F-AUT-RULES]
applies_to: ">= v0.2.4"
last_verified:
  docs: fd2e1ee
  api: a453bb7
  web: 93f03c5
  date: 2026-10-04
covers:
  - web/src/containers/project/AutomationsPanelContainer.tsx
  - web/src/views/project/{AutomationList,AutomationListItem,AutomationEmptyState,AutomationForm,ScheduleSelector,WebhookSection,AutomationDetail,RunHistoryList,RunHistoryItem}.view.tsx
  - web/src/lib/automation/*.ts
  - web/src/hooks/automation/*.ts
  - web/src/types/{automation,automation.schema}.ts
  - web/src/containers/workbench/WorkbenchContainer.tsx（弹层挂载、[打开任务]）
  - web/src/views/project/ProjectGroupMenu.view.tsx（项目「⋯」入口）
  - web/src/containers/banner/GlobalBannerContainer.tsx（横幅入口）
  - api/packages/modules/automation/src/**
  - api/packages/contracts/src/schemas/automation.schema.ts
supersedes:
  - docs/product/pages/21-7-自动化.md（全文）
  - docs/product/22-异常场景与产品补充要求.md L131-139（自动化触发阶段）
  - docs/product/21-页面信息架构与交互.md L16、docs/product/20-核心使用链路.md L413 中「自动化规则侧弹层」的说法
drafts:
  - gap/drafts/f-aut-rules-01…11、f-aut-rules-13.html（说明 gap/drafts/notes/aut.md；13 为 W4 补稿：列表读取中 / 读取失败）
merged_from:
  - gap/product/_parts/aut.md
merged_at: 2026-10-04
review_minutes: 35
---

# 自动化规则 · 产品需求

<!-- 本文件只写「做什么 / 为什么 / 怎样算做对」。布局与视觉在稿件（gap/drafts/f-*），实现方法在技术设计。由 gap/product/_build/merge.py 从 _parts 合并生成；改片段后重新运行。「现状」列暂留文件:行出处，入库时按 01 §4.2 换成证据 ID。 -->

## 一屏摘要

- **这一域回答什么**：自动化规则——从哪进、长什么样、列表与四种规则状态、20 条上限与空态、新建 / 编辑与校验、保存失败、详情与运行历史六类结果、运行详情与 [打开任务]、删除确认，以及到点时的判定和跑完之后的收尾（REQ-AUT-001–029）。本域取代 P21-7 全文与 P22 L131-139。
- **五条要守的规则**：
  1. 一个弹层、几个视图：列表、详情、表单、删除确认在同一个居中弹层里切换，带返回链，不叠第二层（REQ-AUT-002）。
  2. 时区是建规则那一刻的快照，永远写出来；编辑时没显式改就不提交（REQ-AUT-003、011）。
  3. 只有真跑挂了才算失败：失败与超时 +1、成功清零，跳过与错过不算；连着 3 次放慢、再 7 次自动停用（REQ-AUT-004）。
  4. 不知道就说不知道：取不回来不画成空，读不到**不得**写「共 0 次」（REQ-AUT-006、021、022）。
  5. 删除走统一确认，数量由后端给、拿不到不编；每次跑完**必须**收尾，不能一直占着名额（REQ-AUT-024、025，DR-18）。
- **现状**：19 条需求里 `已实现` 2 · `部分实现` 11 · `未实现` 1 · `偏离` 5。增删改、启停、调度、时区快照、失败策略、运行历史、Webhook 都已实现；偏离在 Agent 显示成内部 id（DR-24）、删除用行内小框、运行历史读取失败仍写「共 0 次」（DR-22）、弹层整体滚动。未实现：项目空态与 ⌘K 入口、跑完收尾（DR-18，sev2，要后端）、删除预检的数量、名称 / 描述长度的前端校验、跨项目的规则概览（Q-WB-01 已拍板 B，治理横幅按全部项目判定要它，AC-AUT-004.6）。
- **待定**：Q-AUT-01…06（[open-questions.md](./open-questions.md)）；都按默认走即可。「自动化需关注」横幅按全部项目判定见 Q-WB-01（2026-10-04 已拍板 B）。

**状态词表**：`已实现`（行为与本文一致）· `部分实现` · `未实现` · `偏离`（实现与本文不同）· `实现先行`（代码已有、原产品文档没写，待确认）· `未核实` · `计划中`（目标版本未到，或待某条待定问题选定后才生效）。「层级」= 最低验证层（单元 / 组件 / 集成 / API / e2e；`文档` = 文档一致性检查，`视觉` = 截图比对）。

## 需求索引

**共 19 条需求、86 条验收标准**：`已实现` 2 · `部分实现` 11 · `未实现` 1 · `偏离` 5。

| 编号 | 需求 | 状态 | 版本 | AC | 稿件 | 待定问题 |
|---|---|---|---|---:|---|---|
| [REQ-AUT-001](#REQ-AUT-001) | 入口：四个入口打开同一个弹层 | `部分实现` | v1.1 | 5 | f-aut-rules-01、f-aut-rules-03 | [Q-WB-01](./open-questions.md#Q-WB-01) |
| [REQ-AUT-002](#REQ-AUT-002) | 形态：居中弹层，视图就地切换，带返回链 | `部分实现` | v1.1 | 4 | f-aut-rules-01…11 | — |
| [REQ-AUT-003](#REQ-AUT-003) | 规则列表：每行说清 Agent、调度、下次、时区、状态 | `偏离` | v1.1 | 5 | f-aut-rules-01 | — |
| [REQ-AUT-004](#REQ-AUT-004) | 规则的四种状态与连续失败策略 | `部分实现` | v1.1 | 6 | f-aut-rules-01、f-aut-rules-08 | [Q-WB-01](./open-questions.md#Q-WB-01) |
| [REQ-AUT-005](#REQ-AUT-005) | 每个项目最多 20 条 | `部分实现` | v1.1 | 3 | f-aut-rules-02 | — |
| [REQ-AUT-006](#REQ-AUT-006) | 列表的空、加载中与读取失败 | `部分实现` | v1.1 | 4 | f-aut-rules-03、f-aut-rules-13 | — |
| [REQ-AUT-010](#REQ-AUT-010) | 表单字段、默认值与上限 | `偏离` | v1.1 | 5 | f-aut-rules-04 | [Q-LCH-01](./open-questions.md#Q-LCH-01) |
| [REQ-AUT-011](#REQ-AUT-011) | 调度、预览与时区快照 | `已实现` | v1.1 | 5 | f-aut-rules-04、f-aut-rules-05 | — |
| [REQ-AUT-012](#REQ-AUT-012) | Webhook 通知与 [测试连接] | `部分实现` | v1.1 | 5 | f-aut-rules-04、f-aut-rules-05 | — |
| [REQ-AUT-013](#REQ-AUT-013) | 填写时的校验：字段错误紧贴字段 | `部分实现` | v1.1 | 5 | f-aut-rules-06 | [Q-AUT-06](./open-questions.md#Q-AUT-06) |
| [REQ-AUT-014](#REQ-AUT-014) | 保存：进行中、成功去向、失败与错误码 | `部分实现` | v1.1 | 4 | f-aut-rules-06、f-aut-rules-10 | — |
| [REQ-AUT-020](#REQ-AUT-020) | 规则详情：配置摘要与动作 | `偏离` | v1.1 | 4 | f-aut-rules-07、f-aut-rules-10、f-aut-rules-11 | — |
| [REQ-AUT-021](#REQ-AUT-021) | 运行历史：六类结果、算不算失败、翻页 | `部分实现` | v1.1 | 5 | f-aut-rules-07、f-aut-rules-08 | [Q-AUT-01](./open-questions.md#Q-AUT-01) |
| [REQ-AUT-022](#REQ-AUT-022) | 运行历史的空、加载中与读取失败 | `偏离` | v1.1 | 4 | f-aut-rules-10、f-aut-rules-11 | — |
| [REQ-AUT-023](#REQ-AUT-023) | 运行详情与 [打开任务] | `部分实现` | v1.1 | 5 | f-aut-rules-08 | [Q-AUT-02](./open-questions.md#Q-AUT-02) [Q-AUT-04](./open-questions.md#Q-AUT-04) |
| [REQ-AUT-024](#REQ-AUT-024) | 删除规则：同一弹层里的统一确认 | `偏离` | v1.1 | 5 | f-aut-rules-09 | [Q-AUT-03](./open-questions.md#Q-AUT-03) |
| [REQ-AUT-025](#REQ-AUT-025) | 跑完收尾：销毁任务、留下成果 | `未实现` | v1.1 | 4 | — | [Q-AUT-02](./open-questions.md#Q-AUT-02) |
| [REQ-AUT-026](#REQ-AUT-026) | 不做成果 diff 导出 | `已实现` | v1.1 | 1 | f-aut-rules-08 | — |
| [REQ-AUT-027](#REQ-AUT-027) | 到点时的判定：每个触发时刻都留一行 | `部分实现` | v1.1 | 7 | f-aut-rules-07 | [Q-AUT-05](./open-questions.md#Q-AUT-05) [Q-DS-32](./open-questions.md#Q-DS-32) |

「待定问题」一列链到 [open-questions.md](./open-questions.md)，不回复时按那里写的默认走。

## 与旧文档的对照

由各条「改写了哪条旧文」汇总；旧文档代号见 [README](./README.md#旧文档代号)。逐条的旧文与新口径见每条需求，以及文末附录 A。

| 旧文档 | 被改写的位置 → 本文 | 其中作废 / 删去的 |
|---|---|---|
| P20 核心使用链路 | L413 → REQ-AUT-001 | — |
| P21 页面信息架构与交互 | L16 → REQ-AUT-001 | — |
| P22 异常场景与产品补充要求 | L136 → REQ-AUT-021；L135 → REQ-AUT-027 | — |
| P21-1 工作台 | L66 → REQ-AUT-001 | — |
| P21-7 自动化 | L14 → REQ-AUT-001；L1、L14 → REQ-AUT-002；L23、L25、L71、L26 → REQ-AUT-003；L72、§4「全局横幅同步提示」、L94-95、L93 → REQ-AUT-004；L57 → REQ-AUT-005；L73 → REQ-AUT-006；L38 → REQ-AUT-010；L42-43 → REQ-AUT-011；L51 → REQ-AUT-012；（多处） → REQ-AUT-013；L29 → REQ-AUT-020；L61 → REQ-AUT-021；L62 → REQ-AUT-023；L99 → REQ-AUT-024；L146、L174、L175、L176 → REQ-AUT-025；L62 → REQ-AUT-026；L134-156 → REQ-AUT-027 | L94-95（REQ-AUT-004）；L62（REQ-AUT-026） |

只改写实现现状、试点或稿件口径（不涉及上表旧文档）的需求：REQ-AUT-014、REQ-AUT-022。

---

## AUT · 入口与列表（F-AUT-RULES）

### REQ-AUT-001 · 入口：四个入口打开同一个弹层 {#REQ-AUT-001}

> 状态 `部分实现` · 版本 v1.1（项目空态入口为 v2 新增）· 来源 P21-7 L14；P20 L413；P21 L16；P21-6 L60；P21-1 L66；matrix U-22、U-28；实现 ProjectGroupMenu.view.tsx:114-117，WorkbenchContainer.tsx:231-239、424-426、490-507，GlobalBannerContainer.tsx:40-48 · 关联 F-WB-CMDK（REQ-WB-030–039）、F-WB-BANNER（REQ-WB-010–019）· 稿件 f-aut-rules-01、f-aut-rules-03

自动化规则按项目管理。以下四个入口**必须**打开同一个弹层（标题「自动化规则」、副标题「在 <项目名> 中」）：

| # | 入口 | 打开后落在 |
|---|---|---|
| ① | 树组头或项目卡的「⋯」→「自动化规则」（图标 lucide settings） | 列表视图 |
| ② | 已就绪、还没有任务的项目主区空态里的次链接「设置自动化规则 →」（aria-haspopup="dialog"；v2 新入口，P6 第 13e 条） | 列表视图（该项目没有规则时就是空态） |
| ③ | ⌘K 搜「自动化」→「自动化规则 · <项目名>」（每个就绪项目一条，带规则数或「还没有规则」；面板的动作清单归 F-WB-CMDK） | 列表视图 |
| ④ | 治理横幅「有 N 条定时规则…」的 [查看这些规则]（横幅归 F-WB-BANNER；按全部项目判定，Q-WB-01 B） | 说明里点名的第一条规则所在项目的列表视图（不一定是当前项目）；不在工作台时先回工作台 |

从入口打开**不得**改变当前选中的项目与任务（看 B 的规则不该把正在干活的 A 换走）。关闭弹层（✕、Esc、点遮罩）后焦点**必须**回到打开它的那个控件；从 ⌘K 打开时回到原先的焦点。

**改写了哪条旧文**：P21-7 L14、P20 L413、P21 L16「项目菜单 → [⚙️ 自动化规则]（侧弹层）」→ 居中弹层（形态见 REQ-AUT-002），菜单项图标用 lucide settings，不用 emoji；P21-1 L66 有项目无任务时只给「发起第一个任务 →」→ 另加次链接「设置自动化规则 →」（U-22，v2 新入口）；P21-7 L14「Cmd+K → "自动化"」→ 逐项目一条（F-WB-CMDK 稿 f-wb-cmdk-02）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-AUT-001.1 | e2e | 工作台选中 acme-web 的某个任务 | 点「示例项目」组头「⋯」→「自动化规则」 | 弹层「自动化规则 · 在 示例项目 中」，落在列表视图；工作台仍选中原来那个任务 | 已实现：ProjectGroupMenu.view.tsx:114-117，WorkbenchContainer.tsx:231-239、490-497 |
| AC-AUT-001.2 | e2e | docs-site 已就绪、没有任务、没有规则 | 点主区空态的「设置自动化规则 →」 | 打开同一个弹层，落在空态（REQ-AUT-006） | 未实现：现状空态占位没有这条链接（matrix U-22；稿件 f-aut-rules-03） |
| AC-AUT-001.3 | e2e | 任意页 | ⌘K 输入「自动化」，选「自动化规则 · acme-web」 | 打开 acme-web 的弹层，落在列表视图 | 未实现：web 没有命令面板（package.json 无 cmdk）；面板本身归 F-WB-CMDK |
| AC-AUT-001.4 | 组件 | 当前选中 acme-web；治理横幅「有 1 条定时规则已自动停用」点名「示例项目 的「每日报表」」 | 点 [查看这些规则] | 回到工作台并打开示例项目的弹层（列表视图）；当前选中的项目与任务不变 | 部分实现：回到工作台并打开弹层已实现，打开的是当前项目的（GlobalBannerContainer.tsx:40-48）；横幅还不按全部项目判定（REQ-WB-013） |
| AC-AUT-001.5 | e2e | 从「⋯」菜单打开了弹层 | 按 Esc | 弹层关闭，焦点回到该组头的「⋯」 | 未核实：AppDialog 的还焦点目标没有用例覆盖 |

### REQ-AUT-002 · 形态：居中弹层，视图就地切换，带返回链 {#REQ-AUT-002}

> 状态 `部分实现` · 版本 v1.1 · 来源 P21-7 L1、L14、L18-31；P20 §8.4（弹层不叠层）；research/shell-options.md:593（SH-6「升为独立页」阶段 2 之后再定，不回复维持弹层）；plan F-AUT-RULES 默认；实现 AutomationsPanelContainer.tsx:4-6、21、70-129、177-180、206-208，WorkbenchContainer.tsx:241-246 · 关联 UX-DS-319 · 稿件 f-aut-rules-01…11

自动化规则**必须**是一个居中的普通弹层（宽同现状 AppDialog），没有独立路由。列表、详情、表单（新建 / 编辑）、删除确认是**同一个对话框里的四个视图**：全程只有一个 `role="dialog"`，**不得**再叠第二层弹层。标题「自动化规则」与副标题「在 <项目名> 中」在列表、详情、表单三个视图里不变；删除确认视图换成「动词 + 对象」的标题（REQ-AUT-024）。

视图之间的去向（返回链）：

| 从 | 动作 | 到 |
|---|---|---|
| 列表 | 点规则行 / [查看原因] | 详情（后者自动展开最近一次失败，REQ-AUT-023） |
| 列表 / 空态 | [新建规则] | 表单（新建） |
| 详情 | [返回列表] | 列表 |
| 详情 | [编辑] | 表单（编辑，回填该规则） |
| 详情 | [删除] | 删除确认 |
| 表单（新建） | [取消] / 保存成功 | 列表 / 新规则的详情 |
| 表单（编辑） | [取消] / 保存成功 | 该规则的详情 |
| 删除确认 | [取消] / Esc / 删除成功 | 详情 / 详情 / 列表 |

内容超过一屏时**只滚正文**：头部（标题、副标题、✕）与页脚（[新建规则]；[取消] [保存规则]；[取消] [删除规则]）**必须**始终可见；正文滚动后头部底边出一条分隔线。关闭弹层即丢弃未保存的表单草稿（草稿只在内存里，不落任何存储）；再次打开回到列表视图。

**改写了哪条旧文**：P21-7 L1、L14「侧弹层」与 L18-31「列表下方展开选中规则」→ 居中弹层、视图切换（以现状为准；SH-6「升为带项目过滤的独立页」暂不问）；新增「删除确认是第四个视图」（现状为详情里的行内小框，见 REQ-AUT-024）与「只滚正文」。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-AUT-002.1 | 集成 | 弹层打开 | 依次走 列表 → 详情 → 表单 → 详情 → 删除确认 | 全程只有一个 `role="dialog"`；前三个视图的标题与副标题不变 | 部分实现：单一对话框已实现（AutomationsPanelContainer.tsx:4-6 及其测试）；删除确认不是视图（REQ-AUT-024） |
| AC-AUT-002.2 | 组件 | 在表单（编辑）里改了几项 | 点 [取消] | 回到该规则的详情，改动丢弃；从新建表单 [取消] 则回列表 | 已实现：AutomationsPanelContainer.tsx:177-180 |
| AC-AUT-002.3 | 组件 | 表单内容高于视口 | 滚动正文到底 | 标题、✕ 与页脚 [取消] [保存规则] 一直在视野里；头部底边出现分隔线 | 偏离：AppDialog 整体在 90vh 内滚动，标题与 ✕ 随内容滚走（v1 g7-12b 头注释；稿件 f-aut-rules-02、05、08） |
| AC-AUT-002.4 | e2e | 表单里填了一半 | 按 Esc 关弹层，再从「⋯」打开 | 落在列表视图，没有残留草稿 | 已实现：WorkbenchContainer.tsx:241-246（关闭即卸载），AutomationsPanelContainer.tsx:34-39（初始视图 list） |

### REQ-AUT-003 · 规则列表：每行说清 Agent、调度、下次、时区、状态 {#REQ-AUT-003}

> 状态 `偏离` · 版本 v1.1 · 来源 P21-7 L20-27、L43、L70-71；DR-24；Q-DS-15 ②A；Q-DS-18 A；实现 automationModel.ts:38-89，AutomationListItem.view.tsx:28-37、69-145，useAutomations.ts:187-215，AutomationsPanelContainer.tsx:78-82、138-142 · 关联 UX-DS-306 · 稿件 f-aut-rules-01

每条规则一行，从上到下：状态图标 + 名称；「<Agent 显示名> · <调度人话>」，规则在跑（已开启或被放慢）时接「· 下次: M-D HH:mm」；「时区 <IANA 名>（现在是 UTC±N）」，与本机时区不同时接「· 按 <规则时区> 的钟点触发（你现在是 <本机时区>）」；状态句。时区一行**必须**永远显示，偏移按此刻实时算（夏令时地区换季会变），时区名非法时不写偏移，**不得**回落成本机时区。下次触发**必须**按规则自己的时区格式化；已关掉与自动停用的规则**不得**显示下次触发。

| 规则状态 | 图标（语义色） | 状态句 | 行尾动作 |
|---|---|---|---|
| 已开启 | check（成功） | 已开启 | [关掉] |
| 已关掉 | 停用灰方块（中性） | 已关掉（到点不会触发） | [开启] |
| 被放慢 | 三角（警告） | 连着失败 N 次，已经放慢：现在每天只试一次（警告色） | [关掉] [查看原因] |
| 自动停用 | ×（失败） | 连着失败 N 次（放慢后又失败 N−3 次），已自动停用（警告色） | [重新开启] [查看原因]；行下一句「[重新开启] 会把失败次数清零，规则按原来的时间表继续。」 |

点名称或说明进入详情；[查看原因] 进入详情并自动展开最近一次算失败的运行。启停**必须**即时生效（先改界面、再等后端；失败回滚并在列表顶部说原因），只禁用正在启停的那一行。

**改写了哪条旧文**：P21-7 L23「Codex · 每天 08:00 · 下次: 8-10 08:00」→ Agent 写显示名（DR-24：现状写 runtime id `codex`），并补时区一行（P21-7 L43 快照语义的落点）；P21-7 L25、L71「⏸️ 灰显」→ 停用灰方块（Q-DS-15 ②A）；P21-7 L26「🔴 每日报表（连续失败已暂停 [查看原因]）」→ 两档：被放慢、自动停用（REQ-AUT-004）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-AUT-003.1 | 单元 | 规则 runtime=`codex`、每天 03:00、Asia/Shanghai、已开启 | 生成列表行 | 摘要「Codex · 每天 03:00 · 下次: 10-3 03:00」 | 偏离：摘要写 runtime id「codex · …」（automationModel.ts:46，DR-24）；下次触发已实现（automationModel.ts:73-89） |
| AC-AUT-003.2 | 单元 | 规则时区 Asia/Tokyo，本机 Asia/Shanghai | 生成列表行 | 「时区 Asia/Tokyo（现在是 UTC+9） · 按 Asia/Tokyo 的钟点触发（你现在是 Asia/Shanghai）」；两者相同时只有前半句 | 已实现：automationModel.ts:38-57，AutomationListItem.view.tsx:101-105 |
| AC-AUT-003.3 | 单元 | 规则已关掉 / 自动停用 | 生成列表行 | 不出现「下次:」 | 已实现：automationModel.ts:78 |
| AC-AUT-003.4 | 组件 | 一条已开启的规则 | 点 [关掉]，后端返回失败 | 行立即变「已关掉」、只有这一行按钮禁用；失败后回到「已开启」，列表顶部一句原因（role="alert"） | 已实现：useAutomations.ts:187-215，AutomationList.view.tsx:52-56 |
| AC-AUT-003.5 | 组件 | 一条已关掉的规则 | 渲染列表 | 图标为停用灰方块（不是暂停符号），状态句次要灰 | 偏离：现状用 Pause（AutomationListItem.view.tsx:28-37、AutomationDetail.view.tsx:26-36）；Q-DS-15 ②A |

### REQ-AUT-004 · 规则的四种状态与连续失败策略 {#REQ-AUT-004}

> 状态 `部分实现`（失败策略已实现；治理横幅只覆盖已缓存的项目，跨项目概览接口未实现）· 版本 v1.1 · 来源 P21-7 L70-75、L87-99、L148-151、L169；P22 L139；plan F-AUT-RULES 默认（按实现）；Q-WB-01 B（用户拍板 2026-10-04，原话「补全 10 条按推荐」：横幅按全部项目判定，后端加跨项目规则概览接口）；实现 policies.vo.ts:50-62，automation.entity.ts:50-58、326-390，automationStatus.ts:29-35、52-110，automation-application.service.ts:197-241，automation.notifier.ts:82-112，automationAttention.ts:63-97 · 关联 PARAM.AUTOMATION_DEGRADE_AFTER · PARAM.AUTOMATION_DISABLE_AFTER · F-WB-BANNER · 稿件 f-aut-rules-01、f-aut-rules-08

规则有四种状态：已开启、已关掉（用户关的）、被放慢、自动停用。**连续失败计数**只看真正跑过的结果：成功清零；失败（含「没排到资源」）与超时各 +1；跳过、错过与还没结束的运行**不改**计数（既不 +1 也不清零）。

- 计数到 `PARAM.AUTOMATION_DEGRADE_AFTER`（3）→ **被放慢**：改成每天试一次，原来的调度**不改写**；之后成功一次就恢复原调度并清零。
- 计数到 `PARAM.AUTOMATION_DISABLE_AFTER`（10，即放慢后再失败 7 次）→ **自动停用**：退出调度，不再触发；状态句**必须**同时给出两个数（「连着失败 10 次（放慢后又失败 7 次）」），免得用户拿「3 次」「7 次」「10 次」对不上。
- [开启] 与 [重新开启] 是同一个动作：**同时**清零计数与放慢标记；界面**不得**出现「已开启但仍放慢」。
- 转为被放慢或自动停用时：规则配了 Webhook 就各发一条（不看「什么时候发通知」）；工作台与设置页出治理横幅，按**全部项目**判定，不要求用户打开过这个项目的弹层（F-WB-BANNER，REQ-WB-013）。
- 横幅的数据来自一个**跨项目的规则概览**（后端新增，Q-WB-01 B）：一次返回所有被放慢、已自动停用的规则，每条带项目 id 与名称、规则 id 与名称、状态、连续失败次数；不用逐个项目拉规则列表。只读、不改任何状态，与按项目的规则列表同一套判定（被放慢 / 自动停用的口径就是上面两条）。

项目归档联动不在本期（归档功能不做，F21-6 §10 D）。

**改写了哪条旧文**：P21-7 L72「连续 3 次失败自动 enabled=false」→ 3 次放慢、再 7 次停用（与同文 L90-92、L149-151、L169，P22 L139 及实现一致）；P21-7 §4「全局横幅同步提示」→ 按全部项目判定，数据来自跨项目规则概览（Q-WB-01 B，用户拍板 2026-10-04）；P21-7 L94-95「随项目归档禁用 / 恢复回原状态」→ 不做（归档不做）；P21-7 L93「[重新启用]」→「[重新开启]」（现状上屏词）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-AUT-004.1 | 单元 | 计数为 2 | 依次记一次 跳过、错过、超时 | 计数 2 → 2 → 2 → 3，规则转被放慢 | 已实现：automation.entity.ts:326-360（I-AUT-1、I-AUT-2），automationStatus.ts:106-110 |
| AC-AUT-004.2 | 单元 | 被放慢、原调度「每小时 :15」 | 下一次成功 | 恢复每小时 :15，计数清零，状态句回「已开启」 | 已实现：automation.entity.ts:326-340（I-AUT-3） |
| AC-AUT-004.3 | 单元 | 计数 9、被放慢 | 再失败一次 | 自动停用；状态句「连着失败 10 次（放慢后又失败 7 次），已自动停用」 | 已实现：policies.vo.ts:50-62，automationStatus.ts:77-84 |
| AC-AUT-004.4 | API | 自动停用的规则 | `POST /api/automations/:id/enable` | 已开启、计数 0、放慢标记清除；审计一条「重新启用了自动化规则…（失败计数与降频态已清零）」 | 已实现：automation-application.service.ts:197-221，useAutomations.ts:187-205 |
| AC-AUT-004.5 | 集成 | 规则配了 Webhook、「什么时候发通知」= 仅成功 | 规则转为被放慢 | 仍发一条 `automation.degraded`；同一状态不重复发；任何页面都出治理横幅（不必打开过这个项目的弹层） | 部分实现：Webhook 已实现（automation.notifier.ts:82-112）；横幅只读**当前选中项目**已缓存的规则列表，没打开过弹层的项目不会触发（useAutomations.ts:96-111，「不知道」≠「没问题」，见 F-WB-BANNER） |
| AC-AUT-004.6 | API | 示例项目 1 条已自动停用、acme-web 1 条被放慢、docs-site 没有规则 | 调跨项目规则概览接口 | 一次返回这 2 条，各带项目名、规则名、状态、连续失败次数；不需要先按项目拉列表；只读 | 未实现：只有按项目的 `GET /api/projects/:id/automations`（project-automation.controller.ts），没有跨项目的概览，契约里没有对应的 DTO |

### REQ-AUT-005 · 每个项目最多 20 条 {#REQ-AUT-005}

> 状态 `部分实现` · 版本 v1.1 · 来源 P21-7 L57；实现 types/automation.ts:88，contracts automation.schema.ts:224-227，automation-application.service.ts:91-95、341-349，AutomationList.view.tsx:78-87，e2e automations.e2e-spec.ts:242-259 · 关联 PARAM.AUTOMATION_RULE_LIMIT · components-v2 §3.20（能聚焦、能说原因的禁用）· 稿件 f-aut-rules-02

每个项目最多 `PARAM.AUTOMATION_RULE_LIMIT`（20）条规则。到上限时，页脚左侧**必须**写原因「每个项目最多 20 条规则，先删一条再建。」（警告色 + 三角图标），右侧 [新建规则] 不可用但**能聚焦**（`aria-disabled` + `aria-describedby` 指向原因）；按下不进表单。原因写在页脚，不随列表滚动。服务端同样拦第 21 条。

**改写了哪条旧文**：无冲突（P21-7 L57 只写了上限）；新增「原因在页脚、按钮能聚焦」。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-AUT-005.1 | 组件 | 已有 20 条 | 渲染列表 | 页脚左侧原因句、右侧 [新建规则] `aria-disabled="true"` 且 `aria-describedby` 指向原因；Tab 能停在按钮上 | 部分实现：原因与置灰已实现（AutomationList.view.tsx:78-87），但用 `disabled`（键盘到不了）、原因在列表末尾随正文滚动（稿件 f-aut-rules-02） |
| AC-AUT-005.2 | API | 项目已有 20 条 | `POST /api/projects/:id/automations` | 409 `AUTOMATION_LIMIT_REACHED`，不落库；表单页脚「这个项目的自动化规则已经到上限了。先删掉一条旧规则，再加新的。」 | 已实现：automation-application.service.ts:91-95、341-349，automationErrorCopy.ts:29，automations.e2e-spec.ts:242-259 |
| AC-AUT-005.3 | 文档 | — | 检查前后端的上限 | 都等于 `PARAM.AUTOMATION_RULE_LIMIT` | 已实现：两处常量各写 20（web types/automation.ts:88；contracts automation.schema.ts:224），尚未接参数登记 |

### REQ-AUT-006 · 列表的空、加载中与读取失败 {#REQ-AUT-006}

> 状态 `部分实现` · 版本 v1.1 · 来源 P21-7 L73；UX-DS-303、UX-DS-305；README §3.2（错误文案）；实现 AutomationList.view.tsx:38-60，AutomationEmptyState.view.tsx:15-23 · 稿件 f-aut-rules-03（空态）、f-aut-rules-13（加载中与读取失败，W4 补稿；写法同 f-aut-rules-11 的失败条）

- **取回来是空的**：弹层里的空态——图标、标题「为重复性工作创建一条自动化规则」、说明「规则到点会自动起一个任务：不开终端、不用你盯着，跑完把结果留在运行历史里。」、[新建规则]。空态时页脚**不再**出第二个 [新建规则]。空态与上限互斥。
- **加载中**：「正在读取自动化规则…」，不画空态、不画规则行。
- **取不回来**：原位一条失败提示（role="alert"）「规则没读出来：<按码的原因>」+ [重试]；**不得**显示空态（一次 500 被空态盖住，用户会以为自己从来没建过规则）。

**改写了哪条旧文**：P21-7 L73「为重复性工作创建一条自动化规则 [+ 新建]」→ 标题去掉句末句号、加说明一句（现状已有）、按钮「新建规则」带 plus 图标；新增读取失败的 [重试]。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-AUT-006.1 | 组件 | docs-site 没有规则 | 打开弹层 | 空态三件（标题、说明、[新建规则]）；页脚没有 [新建规则] | 已实现：AutomationEmptyState.view.tsx:15-23，AutomationList.view.tsx:58-60；形态换成卡内空态（稿件 f-aut-rules-03） |
| AC-AUT-006.2 | 组件 | 规则列表请求未返回 | 渲染 | 「正在读取自动化规则…」，没有空态 | 已实现：AutomationList.view.tsx:38-42 |
| AC-AUT-006.3 | 组件 | 规则列表返回 500 `INTERNAL` | 渲染 | 失败条「规则没读出来：服务出错了。」+ [重试]（role="alert"），没有空态 | 部分实现：有失败句、不显示空态（AutomationList.view.tsx:44-60）；句子是码表原句「服务出错了，稍后再试。」，没有 [重试] |
| AC-AUT-006.4 | 组件 | 读取失败 | 点 [重试] | 失败条换成「正在读取自动化规则…」，成功后出列表或空态 | 未实现：没有重试入口 |

## AUT · 新建与编辑（F-AUT-RULES）

### REQ-AUT-010 · 表单字段、默认值与上限 {#REQ-AUT-010}

> 状态 `偏离` · 版本 v1.1 · 来源 P21-7 L36-57；DR-35 第 9 条；Q-DS-21 A（屏上说 Agent 不说 runtime）；实现 useAutomationForm.ts:29-46，AutomationForm.view.tsx:101-104、186-205、241-298，ScheduleSelector.view.tsx:69-78，WebhookSection.view.tsx:26-29，types/automation.ts:84，types/task.ts:51、58，contracts automation.schema.ts:92-104，policies.vo.ts:13-22、68 · 关联 PARAM.TASK_PROMPT_MAX · Q-LCH-01 · 稿件 f-aut-rules-04

表单开头一句：「新建自动化规则：到点自动起一个无头任务，跑完自动销毁实例、只留成果。」（编辑时换「编辑自动化规则：…」；这句话在 REQ-AUT-025 落地之前与事实不符，见那一条）。字段：

| 字段 | 规则 | 默认 |
|---|---|---|
| 名称 | 必填，≤ `PARAM.AUTOMATION_NAME_MAX`（60）字 | 空 |
| 描述（可选） | ≤ `PARAM.AUTOMATION_DESC_MAX`（500）字 | 空 |
| 用哪个 Agent 跑 | 必选；下拉列已注册的 Agent，写显示名 | 「请选择」（读取中写「正在读取…」） |
| 任务内容 | 必填，≤ `PARAM.TASK_PROMPT_MAX`（8000，按码点计）；与新建任务的「任务指令」是同一字段；计数「n / 8000」在标签行右端，超出变红 | 空 |
| 最长运行时间 | `PARAM.AUTOMATION_TIMEOUT_OPTIONS_MIN`：30 分钟 / 1 小时 / 2 小时 / 4 小时；说明「任务最长能跑多久。跑过头会被强制结束，并且这次算一次失败。」 | 2 小时 |
| 调度 | 每天 / 每小时 / 每周；「自定义 cron（还没开放）」可见但不可选 | 每天 08:00 |
| 时区与预览 | 见 REQ-AUT-011 | 当前环境时区 |
| 高级选项（默认收起）· 并发模式 | 只有「跳过（上次还在跑就不再起一个）」可选；「排队（还没开放）」「并发（还没开放）」可见但不可选 | 跳过 |
| 高级选项 · 成果保留期 | `PARAM.AUTOMATION_RETENTION_OPTIONS_DAYS`：3 / 7 / 30 天；说明「成果会留在项目的「保留下来的成果」里，到期自动清理；到期之前都可以下载。」 | 7 天 |
| Webhook 通知 | 见 REQ-AUT-012 | 不启用 |

镜像用项目默认值，不在表单里出现；资源由平台分配，表单里没有配额概念。

**改写了哪条旧文**：P21-7 L38「Runtime: Codex ▾」→「用哪个 Agent 跑」（Q-DS-21 A）；L46「自定义 cron（v1.2，高级 Tab）」与 L48「排队(v1.2) / 并发(v1.2)」→「（还没开放）」（DR-35 第 9 条；现状并发两项仍写「（v1.2）」，AutomationForm.view.tsx:258、267）；L57 只写了任务内容 8000 与 20 条 → 补名称 60、描述 500（后端已有约束）；L51 的触发事件见 REQ-AUT-012。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-AUT-010.1 | 组件 | 点 [新建规则] | 表单渲染 | 默认值：Agent 未选、2 小时、每天 08:00、当前时区、跳过、7 天、Webhook 未启用 | 已实现：useAutomationForm.ts:29-46 |
| AC-AUT-010.2 | 组件 | Agent 列表含 codex、claude-code | 展开「用哪个 Agent 跑」 | 选项写「Codex」「Claude Code」 | 已实现：AutomationsPanelContainer.tsx:144-147 |
| AC-AUT-010.3 | 组件 | 任务内容 168 字 | 渲染 | 标签行右端「168 / 8000」；8001 字时计数变红并出字段错误（REQ-AUT-013） | 已实现：AutomationForm.view.tsx:97、163-185；码点与后端 UTF-16 计法不一致见 Q-LCH-01 |
| AC-AUT-010.4 | 组件 | 展开「高级选项」 | 渲染 | 并发模式三项：跳过（选中）、「排队（还没开放）」「并发（还没开放）」不可选 | 偏离：后两项写「（v1.2）」（AutomationForm.view.tsx:258、267，DR-35 第 9 条） |
| AC-AUT-010.5 | API | — | 提交超时 45 分钟 / 保留期 5 天 | 400 `VALIDATION_FAILED`（请求校验先拦；领域里的 `INVALID_TIMEOUT` 在 HTTP 上走不到）；表单只给四档与三档，正常操作走不到这里 | 已实现：contracts enums.ts:40-46、automation.schema.ts:102-103，e2e automations.e2e-spec.ts:101-108；领域兜底 policies.vo.ts:24-32、71-78 |

### REQ-AUT-011 · 调度、预览与时区快照 {#REQ-AUT-011}

> 状态 `已实现` · 版本 v1.1 · 来源 P21-7 L41-46；23 I-AUT-9；实现 useAutomationForm.ts:37、99-126，automationPayload.ts:103-117，ScheduleSelector.view.tsx:137-160，scheduleToCron.ts:66-77，automationModel.ts:63-89，useAutomationRuns.ts:39-47，schedule.vo.ts:57-65，automationErrorCopy.ts:22-23 · 关联 REQ-AUT-003 · 稿件 f-aut-rules-04、f-aut-rules-05

调度三种预设：每天（时间）、每小时（第几分钟）、每周（星期 + 时间）。时区**始终可见**（不折进高级选项）：

- **新建**：默认取当前环境的 IANA 时区，随创建一起提交，这一刻就是快照。说明「默认取你当前的时区，建好之后就定下来了；之后你换机器或改系统时区都不会影响这条规则。」
- **编辑**：显示规则的快照值。用户**没有显式改**时区，保存请求里**不得**带时区这个键（否则换台机器改个任务内容，凌晨 3 点的任务就挪到了别的钟点）；显式改过才带，并在标签旁写「（已修改，保存时会一并提交）」（警告色）。说明换成「时区是建这条规则时定下的。不动它，保存时就不会重传——否则换台机器编辑一次，触发时刻就跟着这台机器挪走了。」
- **预览**：调度下方一句「预览：每天 03:00（Asia/Tokyo）」，随调度与时区实时变化；每周没选星期时写「每周（未选星期）09:00（…）」。
- 时区名**必须**是 IANA 城市写法；UTC+8 这类固定偏移由服务端以 `INVALID_TIMEZONE` 拒绝，表单页脚按码说人话（REQ-AUT-014）。
- 下次触发、运行历史里的每个时刻都按**规则的**时区显示，不读浏览器时区。

**改写了哪条旧文**：无冲突（P21-7 L42-43 已写快照）；补「编辑时不重传」「已修改」提示与预览句（现状已有）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-AUT-011.1 | 单元 | 本机 Asia/Shanghai | 新建并保存 | 创建请求带 `timezone: "Asia/Shanghai"` | 已实现：useAutomationForm.ts:37，automationPayload.ts:103-106 |
| AC-AUT-011.2 | 单元 | 编辑一条 Asia/Shanghai 的规则，只改任务内容 | 保存 | PUT 请求体里**没有** `timezone` 键（断言键集合，不断言值） | 已实现：automationPayload.ts:108-117，useAutomationForm.ts:99-109 |
| AC-AUT-011.3 | 组件 | 编辑时把时区改成 Asia/Tokyo | 渲染 | 标签旁「（已修改，保存时会一并提交）」；预览「每天 03:00（Asia/Tokyo）」；保存请求带 `timezone` | 已实现：ScheduleSelector.view.tsx:137-160，useAutomationForm.ts:108-110、123-126 |
| AC-AUT-011.4 | API | — | 创建时 `timezone: "UTC+8"` 或 `"Asia/NotACity"` | 400 `INVALID_TIMEZONE`（不是笼统的 `VALIDATION_FAILED`）；页脚「这个时区名用不了。请选一个城市写法的时区（例如 Asia/Shanghai）……」 | 已实现：schedule.vo.ts:57-65，automationErrorCopy.ts:22-23，e2e automations.e2e-spec.ts:110-118 |
| AC-AUT-011.5 | 单元 | Asia/Shanghai 的规则，浏览器在 UTC | 渲染列表与运行历史 | 「下次: 10-3 03:00」与历史时刻都按 Asia/Shanghai | 已实现：automationModel.ts:63-89，useAutomationRuns.ts:39-47 |

### REQ-AUT-012 · Webhook 通知与 [测试连接] {#REQ-AUT-012}

> 状态 `部分实现` · 版本 v1.1 · 来源 P21-7 L50-51、L178-185（决策 3）；实现 validateWebhookUrl.ts:20-44，automationPayload.ts:96-100，WebhookSection.view.tsx:26-29、58、91-118，useAutomations.ts:217-231，http-webhook.sender.ts:22-23、55-81，contracts automation.schema.ts:196-210，automationErrorCopy.ts:26-35，ssrf.policy.ts · 关联 PARAM.WEBHOOK_TIMEOUT_S · PARAM.WEBHOOK_RETRY_BACKOFF_S · 稿件 f-aut-rules-04、f-aut-rules-05

「Webhook 通知」一节：复选「启用（定时任务的价值就在「我不在的时候」，仅靠页面横幅收不到）」。启用后：地址输入框（可访问名称「Webhook URL」）必填，只认 http / https；「什么时候发通知」三选一（radiogroup）：仅失败（含超时）/ 仅成功 / 全部，默认仅失败；[测试连接]；一句投递说明「投递超时 10 秒；失败重试 2 次（间隔 5 秒、25 秒）。两次重试仍失败只记一条投递失败，不影响规则的启用状态。」没启用时请求里**不带**地址与时机两个键（空串在后端是「配了一个非法地址」）。

[测试连接] 发一条样例载荷（只发一次、不重试，超时同 `PARAM.WEBHOOK_TIMEOUT_S`），按钮「测试中…」并禁用；结果写在按钮右侧：

| 结果 | 句子（图标带色、句子正文色） | 播报 |
|---|---|---|
| 送到了 | 测试消息已经送到了 | role="status" |
| `TIMEOUT` | 发过去之后对方一直没回应（超时）。确认一下这个地址现在能不能收。 | role="alert" |
| `UPSTREAM_UNAVAILABLE` | 发过去了，但对方没有正常回应。确认一下这个地址现在能不能收。 | role="alert" |
| `HOST_NOT_ALLOWED` | Webhook 地址指向的是内网地址，出于安全没有放行。换一个公网能访问到的地址；如果确实要发到内网，需要先给这台机器开启访问口令。 | role="alert" |
| `VALIDATION_FAILED` | 提交的内容不合要求，请检查后再试。 | role="alert" |

投递失败**不得**改变规则的启用、放慢、停用状态；运行详情里如实写投递结果（REQ-AUT-023）。地址解析到内网时，只有这台机器开了访问口令才放行。

**改写了哪条旧文**：P21-7 L51「触发事件 ☐成功 ☐失败 ☐超时」→ 三选一单选（与同文 L180 `trigger_on: failure/success/all` 及实现一致；超时算失败）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-AUT-012.1 | 单元 | 没勾启用、地址框里有残留文字 | 保存 | 请求里没有 `webhookUrl`、`triggerOn` | 已实现：automationPayload.ts:96-100 |
| AC-AUT-012.2 | 组件 | 勾了启用 | 渲染 | 地址框带名称「Webhook URL」；三项单选在一个带名称的 radiogroup 里，默认「仅失败（含超时）」 | 部分实现：选项与默认已实现（WebhookSection.view.tsx:26-29）；地址框与单选组没有可访问名称（稿件 f-aut-rules-04 第 9 条） |
| AC-AUT-012.3 | 组件 | 地址能收 | 点 [测试连接] | 「测试中…」禁用 → 绿色圆勾 +「测试消息已经送到了」（role="status"） | 部分实现：WebhookSection.view.tsx:91-109，成功句没有 role="status"，整句绿字 |
| AC-AUT-012.4 | 组件 | 地址 10 秒没回应 | 点 [测试连接] | 红色圆叉 + TIMEOUT 一句（role="alert"），句子正文色 | 已实现（颜色写法除外）：WebhookSection.view.tsx:110-118，automationErrorCopy.ts:35 |
| AC-AUT-012.5 | 集成 | 运行失败、规则只在失败时通知、对方一直 500 | 投递 | 共 3 次（首发 + 重试 2 次，间隔 5 秒、25 秒）后记「投递失败」；规则状态不变 | 已实现：http-webhook.sender.ts:22-23、55-65，automation.notifier.ts:151 |

### REQ-AUT-013 · 填写时的校验：字段错误紧贴字段 {#REQ-AUT-013}

> 状态 `部分实现` · 版本 v1.1 · 来源 P21-7 L57；UX-DS-310（字段错误紧贴字段）；实现 automationPayload.ts:59-78，scheduleToCron.ts:37-54、73，validateWebhookUrl.ts:20-35，useAutomationForm.ts:115-121，AutomationForm.view.tsx:118-122、163-185、329，ScheduleSelector.view.tsx:162-166；contracts automation.schema.ts:92-93 · 关联 Q-AUT-06 · 稿件 f-aut-rules-06

客户端校验句（逐字）：

| 情况 | 字段错误 |
|---|---|
| 名称为空 | 请填写规则名称。 |
| 名称超过 60 字 | 规则名称最多 60 个字。（新增，暂行） |
| 描述超过 500 字 | 描述最多 500 个字。（新增，暂行） |
| 没选 Agent | 请选择用哪个 Agent 跑。 |
| 任务内容为空 | 请填写任务内容。 |
| 任务内容超过上限 | 任务内容超出 8000 字符上限。（计数同时变红） |
| 每小时没填分钟 / 分钟越界 | 请填写每小时触发的分钟。/ 分钟必须是 0–59 的整数。 |
| 时间不合法 | 请填写合法的触发时间（HH:MM）。 |
| 每周没选星期 | 请至少选择一天。（预览写「每周（未选星期）…」） |
| 启用了 Webhook 却没填地址 | 启用了通知就必须填 Webhook URL。 |
| 地址解析不了 | URL 格式不正确（需要形如 https://example.com/hook）。 |
| 不是 http / https | 只支持 http / https。 |

错误句**必须**紧贴出错的控件（星期错误在星期那一行下面，地址错误在地址框下面），带失败图标、`role="alert"`；出错的控件 `aria-invalid="true"` 并用 `aria-describedby` 连到错误句。有任一错误时 [保存规则] 不可用。新建表单刚打开时**不得**一次性亮出全部「请填写」——某个字段被改过或失焦后才显示它的错误（Q-AUT-06）。

**改写了哪条旧文**：原产品文档没有校验句（P21-7 只写了上限）；本条按实现补齐，并新增两条长度错误与「紧贴字段 + aria-invalid」。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-AUT-013.1 | 单元 | 上表每一种情况 | 校验草稿 | 得到对应的句子（逐字） | 已实现（两条新增长度错误除外）：automationPayload.ts:59-78，scheduleToCron.ts:37-54，validateWebhookUrl.ts:23-34 |
| AC-AUT-013.2 | 组件 | 每周、一天都没选；地址漏写协议 | 渲染 | 「请至少选择一天。」在星期行下面、「URL 格式不正确…」在地址框下面；两个控件 `aria-invalid="true"` + `aria-describedby` | 部分实现：句子与 role 已实现；星期错误排在时区说明之后（ScheduleSelector.view.tsx:162-166），控件没有 `aria-invalid`（稿件 f-aut-rules-06 第 5、6 条） |
| AC-AUT-013.3 | 组件 | 任一字段有错 | 渲染 | [保存规则] 不可用 | 已实现：useAutomationForm.ts:121，AutomationForm.view.tsx:329 |
| AC-AUT-013.4 | 组件 | 名称填 61 个字 | 失焦 | 字段错误「规则名称最多 60 个字。」，不发请求 | 未实现：前端不拦，后端 400 `VALIDATION_FAILED`，页脚只得到通用句「提交的内容不合要求，请检查后再试。」（contracts automation.schema.ts:92-93） |
| AC-AUT-013.5 | 组件 | 刚打开新建表单，什么都没填 | 渲染 | 不显示任何字段错误，读屏不播报；[保存规则] 不可用 | 偏离：校验每次渲染都跑，三条「请填写…」一打开就带 role="alert" 出现（useAutomationForm.ts:115-121，AutomationForm.view.tsx:118-122） |

### REQ-AUT-014 · 保存：进行中、成功去向、失败与错误码 {#REQ-AUT-014}

> 状态 `部分实现` · 版本 v1.1 · 来源 UX-DS-305（错误句在触发按钮上方、按码查表）；README §3.2（错误文案）；实现 AutomationsPanelContainer.tsx:98-114，useAutomations.ts:63-83、154-178，automationErrorCopy.ts:21-44，errorCopy.ts:37-38、56-67，AutomationForm.view.tsx:322-334，automation-application.service.ts:297-349 · 关联 F-PRJ-DETAIL（规则数）· 稿件 f-aut-rules-06、f-aut-rules-10

点 [保存规则]：按钮「保存中…」，[取消] 不可点。

- **成功**：新建 → 落在新规则的详情（运行历史「共 0 次」+ 空态句，REQ-AUT-022）；编辑 → 回到该规则的详情。列表、项目详情里的规则数（F-PRJ-DETAIL）、⌘K 里的条数同步。
- **失败**：留在表单，输入**全部保留**；页脚条第一行一句（role="alert"，在 [保存规则] 上方、不随正文滚走），按码查表，**不得**显示后端原文：

| 码 | HTTP | 什么时候 | 页脚一句 |
|---|---|---|---|
| `INVALID_TIMEZONE` | 400 | 时区不是 IANA 名 | 这个时区名用不了。请选一个城市写法的时区（例如 Asia/Shanghai）—— 像 UTC+8 这样的固定偏移写法表达不了夏令时，规则会在换季时跑错点。 |
| `INVALID_TIMEOUT` | 400 | 不在四档里（经 HTTP 会先被请求校验拦成 `VALIDATION_FAILED`，此码是领域兜底） | 最长运行时间只能从给定的几档里选（30 分钟 / 1 小时 / 2 小时 / 4 小时）。 |
| `INVALID_SCHEDULE` | 400 | 调度不完整或不合法 | 这条规则的时间设置不完整或不合法，检查一下时间和星期再保存。 |
| `INVALID_WEBHOOK_URL` | 400 | 地址不合法 | Webhook 地址填得不对：要是一个完整的 http:// 或 https:// 地址。 |
| `VALIDATION_FAILED` | 400 | 其它字段约束（如名称超长） | 提交的内容不合要求，请检查后再试。 |
| `AUTOMATION_LIMIT_REACHED` | 409 | 第 21 条 | 这个项目的自动化规则已经到上限了。先删掉一条旧规则，再加新的。 |
| `PROJECT_NOT_FOUND` | 404 | 项目已在别处被删 | 这个项目已经不在了（可能在别处被删掉了）。 |
| `NOT_FOUND` | 404 | 编辑时规则已在别处被删 | 这条规则已经不在了（可能在别处被删掉了）。 |
| `INVALID_STATE` | 409 | 状态不允许 | 这条规则现在的状态不允许这个操作，刷新一下看看它是不是在别处被改过了。 |
| （没有码：请求没到后端） | — | 断网 | 规则没保存：网络不通，检查网络后再点 [保存规则]。 |
| 其它码 | — | — | 操作失败，请稍后重试。（报障时请提供 traceId：<id>） |

**改写了哪条旧文**：原产品文档没有保存失败的写法；本条按实现的码表补齐，断网一句按 README §3.2 改写（现状「网络不通，请稍后再试。」）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-AUT-014.1 | 组件 | 表单校验通过 | 点 [保存规则] | 按钮「保存中…」、[取消] 不可点 | 已实现：AutomationForm.view.tsx:329-333 |
| AC-AUT-014.2 | 集成 | 新建「每周五汇总本周合并请求」 | 保存成功 | 落在它的详情：已开启、「共 0 次」+ 空态句；回到列表能看到它；项目详情规则数 +1 | 已实现：AutomationsPanelContainer.tsx:98-114，useAutomations.ts:154-171（项目详情计数归 F-PRJ-DETAIL） |
| AC-AUT-014.3 | 组件 | 断网 | 保存 | 留在表单、输入不丢；页脚第一行「规则没保存：网络不通，检查网络后再点 [保存规则]。」（role="alert"），按钮在下一行 | 部分实现：留在表单、按码查表已实现（useAutomations.ts:75-83）；句子是「网络不通，请稍后再试。」，位置在表单末尾随正文滚动（AutomationForm.view.tsx:322-326；稿件 f-aut-rules-06 第 7 条） |
| AC-AUT-014.4 | 单元 | 后端回上表任一码 | 生成页脚句 | 得到表中句子；未知码得到通用句 + traceId；不出现后端 message 原文 | 已实现：automationErrorCopy.ts:21-44，errorCopy.ts:56-67 |

## AUT · 详情、运行历史、删除与执行（F-AUT-RULES）

### REQ-AUT-020 · 规则详情：配置摘要与动作 {#REQ-AUT-020}

> 状态 `偏离` · 版本 v1.1 · 来源 P21-7 L28-30；DR-24；实现 AutomationDetail.view.tsx:93-174，useAutomationPresentation.ts:15-66 · 稿件 f-aut-rules-07、f-aut-rules-10、f-aut-rules-11

详情从上到下：[返回列表]；状态图标 + 规则名；状态句（被放慢 / 自动停用用警告色）；配置 8 行；任务内容预览；动作；运行历史（REQ-AUT-021）。

| 配置（键逐字） | 值 |
|---|---|
| Agent | 显示名（Codex / Claude Code） |
| 什么时候跑 | 每天 03:00 / 每小时 :15 / 每周一三五 08:00 |
| 时区 | <IANA>（建规则时定下的，改别的字段不会动它） |
| 最长运行时间 | 30 分钟 / 1 小时 / 2 小时 / 4 小时 |
| 成果保留期 | N 天（存放在项目的「保留下来的成果」里） |
| 撞上了怎么办 | 跳过（上一次还在跑，这一次就不再起一个） |
| Webhook 通知 | <地址> · 只在失败时发（超时也算失败）/ 只在成功时发 / 每次都发；没配写「没开」 |
| 连着失败 | N 次 |

任务内容预览：前 300 字，超出加「…」；最多约 4 行高，内部滚动，**必须**能用键盘聚焦并滚动（带名称的区域）；完整内容只在编辑表单里展开。动作：[编辑]；[关掉] / [开启] / [重新开启]（同 REQ-AUT-003、REQ-AUT-004）；[删除]——进入二次确认的入口，红字次级按钮（REQ-AUT-024）。动作失败的句子写在动作行上方（role="alert"）。

**改写了哪条旧文**：P21-7 L29「配置详情 · [编辑] [禁用/启用] [删除]」→ 配置 8 行逐项写明，按钮名用现状上屏词（关掉 / 开启 / 重新开启）。

**合并说明**：规则没有「立即触发」；WB 域离线置灰清单（REQ-WB-014）里的那一项暂不适用。（交叉引用：REQ-WB-014）

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-AUT-020.1 | 单元 | 规则 runtime=`codex`、仅失败通知 | 生成配置 8 行 | 第 1 行「Agent：Codex」；Webhook 行「<地址> · 只在失败时发（超时也算失败）」 | 偏离：Agent 一行写 runtime id（useAutomationPresentation.ts:35，DR-24）；其余已实现（:33-56） |
| AC-AUT-020.2 | 单元 | 任务内容 412 字 | 生成预览 | 前 300 字 +「…」 | 已实现：useAutomationPresentation.ts:15、57-60 |
| AC-AUT-020.3 | 组件 | 预览需要滚动 | 用 Tab | 焦点能停在预览区（区域有名称），方向键能滚动 | 未实现：预览是不可聚焦的 `<pre>`（AutomationDetail.view.tsx:122-130；稿件 f-aut-rules-07 第 8 条） |
| AC-AUT-020.4 | 组件 | 详情 | 渲染动作行 | [编辑]、启停按钮为次级按钮；[删除] 为红字次级按钮（不是幽灵按钮） | 偏离：[删除] 是 ghost（AutomationDetail.view.tsx:161-173） |

### REQ-AUT-021 · 运行历史：六类结果、算不算失败、翻页 {#REQ-AUT-021}

> 状态 `部分实现` · 版本 v1.1 · 来源 P21-7 L30、L59-62、L75、L102-125；P22 L136；DR-35 第 1 条；DR-42 第 4 条；实现 types/automation.ts:40-65、119-128，formatRunOutcome.ts:33-173，automationModel.ts:101-130，useAutomationRuns.ts:44-92，RunHistoryList.view.tsx:49-150，RunHistoryItem.view.tsx:22-123，automation-application.service.ts:243-261 · 关联 PARAM.AUTOMATION_RUNS_PREVIEW · PARAM.AUTOMATION_RUNS_PAGE_SIZE · Q-AUT-01 · 稿件 f-aut-rules-07、f-aut-rules-08

运行历史按触发时刻倒序。详情里先显示最近 `PARAM.AUTOMATION_RUNS_PREVIEW`（10）条；[查看全部] 展开已加载的并在需要时取下一页；展开后底部 [加载更多]（加载中「加载中…」）。翻页用游标（`before=<runId>`），每页 `PARAM.AUTOMATION_RUNS_PAGE_SIZE`（20）。标题旁的计数：还有下一页时写「已加载 N 次」，翻到底才写「共 N 次」——游标拿不到总数，**不得**拿已加载条数冒充总数。

8 个后端状态先收成 6 类，每行：结果图标 + 结果词 + 触发时刻（规则时区）+ 耗时（有才写）+ 行尾 [详情] / [收起]（`aria-expanded`、`aria-controls`）；下一行写这次算不算失败——「这次算一次失败」（次要灰 + 三角）/「这次不算失败」（低一档的灰），每行都写，不折叠。

| 类 | 后端状态 | 结果词 | 图标 · 色调 | 算失败 | 展开后的一句 |
|---|---|---|---|---|---|
| 运行中 | running | 运行中 | 转圈 · 信息蓝 | 不算 | 任务正在跑。 |
| 还没结果 | pending | 待执行 | 转圈 · 警告琥珀 | 不算 | 已经触发，正在创建任务。 |
| 还没结果 | resource-exhausted | 排队重试中 n/5 | 转圈 · 警告琥珀 | 不算 | 触发的时候没有空闲资源，正在按 24 分钟一次的间隔排队重试（最多 5 次）。还没有结果，这次不算失败。 |
| 成功 | success | 成功 | check · 成功绿 | 不算（清零） | 任务跑完了，成功。之前累计的失败次数已经清零。 |
| 失败 | failed | 失败 | × · 失败红 | 算 | 任务真的跑起来了，但没跑成。这次算一次失败：累计 3 次会自动放慢（每天只试一次）。 |
| 失败 | failed + `RESOURCE_EXHAUSTED` | 没排到资源 | × · 失败红 | 算 | 一直没排到资源，等了 5 次还是没跑起来，这一次就不再等了。任务没有真正开始，所以没有输出可看。这次算一次失败：累计 3 次会自动放慢（每天只试一次）。 |
| 失败 | timeout | 超时 | × · 失败红（Q-AUT-01） | 算 | 跑到了规则里设的最长运行时间，被强制结束，按失败处理。这次算一次失败；可以在规则里把最长运行时间调大一档。 |
| 跳过 | skipped + `AUTH_EXPIRED` | 跳过 | 横线 · 中性灰 | 不算 | 这个 Agent 的凭证已过期或被删除，本次没有触发。重新授权后会按原来的时间表继续。这次没有执行，不算失败。 |
| 跳过 | skipped + `PREVIOUS_RUNNING` | 跳过 | 横线 · 中性灰 | 不算 | 上一次触发的任务当时还在跑，按「跳过」的策略这次没有再起一个。这次没有执行，不算失败。 |
| 错过 | missed | 错过 | 空心圆 · 中性灰 | 不算 | 平台的定时调度当时没在运行，错过了这个时刻。这不是规则的问题；按设计也不会补跑（补跑会让凌晨的任务在中午执行）。这次不算失败。 |

跳过与错过**不得**用红色或琥珀（它们不是失败，琥珀会和「排队重试中」撞色）。运行历史随规则保留，规则删除时一起删（REQ-AUT-024）。

**改写了哪条旧文**：P21-7 L61「状态（✅ 成功 ⏭️ 跳过 ❌ 失败 ⚠️ 资源重试中 ⏸️ missed）」→ 上表六类与「算不算失败」一行；P22 L136「资源临时不足，已排队（3/5）」→「排队重试中 3/5」（现状上屏词）；跳过原因「被吊销」→「被删除」（DR-35 第 1 条；现状 formatRunOutcome.ts:35 仍写「被吊销」）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-AUT-021.1 | 集成 | 规则有 42 次运行 | 打开详情 | 先显示最近 10 条，计数「已加载 20 次」；[查看全部] → 显示 20 条，底部 [加载更多]；翻到底计数变「共 42 次」 | 已实现：useAutomationRuns.ts:51-67，RunHistoryList.view.tsx:64-71、110-148 |
| AC-AUT-021.2 | 单元 | 上表每一种后端状态 | 归类 | 结果词、算不算失败与表一致 | 已实现：formatRunOutcome.ts:39-142 |
| AC-AUT-021.3 | 单元 | skipped + `AUTH_EXPIRED` | 生成展开句 | 「这个 Agent 的凭证已过期或被删除，……」 | 偏离：写「已过期或被吊销」（formatRunOutcome.ts:35，DR-35 第 1 条） |
| AC-AUT-021.4 | 组件 | 任一运行行 | 点 [详情] | 按钮变 [收起]，`aria-expanded="true"` 且 `aria-controls` 指向展开区 | 未实现：没有 aria-expanded（RunHistoryItem.view.tsx:94-103；稿件 f-aut-rules-07 第 4 条） |
| AC-AUT-021.5 | 组件 | 有跳过、错过、排队重试中各一行 | 渲染 | 跳过 / 错过为中性灰；排队重试中为琥珀转圈；三者互不同色 | 已实现：RunHistoryItem.view.tsx:22-51 |

### REQ-AUT-022 · 运行历史的空、加载中与读取失败 {#REQ-AUT-022}

> 状态 `偏离` · 版本 v1.1 · 来源 DR-22（把「不知道」说成具体结论）；UX-DS-305、UX-DS-306；README §3.2；实现 RunHistoryList.view.tsx:60-90，useAutomationRuns.ts:74-80，errorCopy.ts:37 · 稿件 f-aut-rules-10、f-aut-rules-11

三种情况**必须**分开说：

- **取回来是空的**：计数「共 0 次」+「这条规则还没有运行过。到点触发后，每一次的结果都会记在这里。」（14 次要灰，不画空表格、不转圈）。
- **加载中**：「正在读取运行历史…」，计数**不写数字**。
- **取不回来**：原位一条失败提示（role="alert"）「运行历史没读出来：<按码的原因>」+ [重试]（例：`INTERNAL` →「服务出错了。」；断网 →「网络不通。」）；计数写「共 — 次」；**不得**显示空态句，**不得**写「共 0 次」。

**改写了哪条旧文**：原产品文档没有这三种情况；现状读取失败与加载中都写「共 0 次」（DR-22），失败句是码表原句「服务出错了，稍后再试。」且没有重试（README §3.2 改写）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-AUT-022.1 | 组件 | 运行历史返回空 | 渲染 | 「共 0 次」+ 空态句 | 已实现：RunHistoryList.view.tsx:69-71、86-90 |
| AC-AUT-022.2 | 组件 | 运行历史返回 500 `INTERNAL` | 渲染 | 「共 — 次」；失败条「运行历史没读出来：服务出错了。」+ [重试]；没有空态句 | 偏离：计数写「共 0 次」，句子「服务出错了，稍后再试。」，没有 [重试]（RunHistoryList.view.tsx:69-84，DR-22） |
| AC-AUT-022.3 | 组件 | 运行历史请求未返回 | 渲染 | 「正在读取运行历史…」，计数不写数字 | 偏离：计数写「共 0 次」（RunHistoryList.view.tsx:69-78） |
| AC-AUT-022.4 | 组件 | 读取失败 | 点 [重试] | 失败条换成加载中，成功后出列表或空态 | 未实现：hook 有 refresh（useAutomationRuns.ts:74-78），界面没有接 |

### REQ-AUT-023 · 运行详情与 [打开任务] {#REQ-AUT-023}

> 状态 `部分实现` · 版本 v1.1 · 来源 P21-7 L62、L64；DR-18；实现 RunHistoryItem.view.tsx:125-175，RunHistoryList.view.tsx:19-58，automationModel.ts:101-130，formatRunOutcome.ts:144-160，automation.notifier.ts:15-16、44-53，AutomationsPanelContainer.tsx:131-142，WorkbenchContainer.tsx:497-503 · 关联 F-SBX-HEADLESS · Q-AUT-02 · Q-AUT-04 · PARAM.AUTOMATION_SUMMARY_BYTES · 稿件 f-aut-rules-08

展开一条运行，与结果词同列依次是：

1. 人话一句（REQ-AUT-021 表的最后一列）；
2. 「失败信息（后端原文）」——带标签的等宽块、失败色、最多约 4 行内滚；它是给排障用的机器原文，**不得**放在人话那一句的位置上；后端没给就不画；
3. Webhook 投递旁注：「Webhook 通知已送达。」/「Webhook 通知没发出去（重试 2 次后放弃）。只是通知没送到，规则本身的状态不受影响。」/「按这条规则「什么时候发通知」的设置，这次不发 Webhook。」；没配 Webhook 或这次没有投递就不写；
4. 输出摘要：标准输出末尾 `PARAM.AUTOMATION_SUMMARY_BYTES`（1 KB），等宽，最多约 10 行内滚；没有就不画；
5. [打开任务] +「这是自动跑的任务，右侧只能看输出，不能敲命令。」——只在这次运行带得出任务、且那个任务还在时出现；点了关掉弹层，在工作台选中这个无头任务（只读输出，F-SBX-HEADLESS）。

从列表 [查看原因] 进来时，**必须**自动展开最近一次算失败的运行；它不在最近 10 条里就同时展开全部；用户自己点过任何一行后不再自动抢回。展开后把它滚到正文顶部（上留 12），人话一句、失败信息与输出摘要一起进视野，焦点放在它的 [收起] 上（Q-AUT-04；只滚进视野会让失败信息落在视口下面，W4 评审 R2-28）。

跑完收尾（REQ-AUT-025）落地后，已结束的运行没有任务可开：**不得**再出 [打开任务]，改出 [查看成果]（打开项目「保留下来的成果」并定位到这一份，F-PRJ-RETAINED；Q-AUT-02）。

**改写了哪条旧文**：P21-7 L62「[打开 Task]（跳工作台看只读输出流）+ [下载成果 diff] + [查看规则]」→ [打开任务] 保留并加「任务还在」前提；[下载成果 diff] 作废（REQ-AUT-026）；[查看规则] 不需要（运行详情本来就在规则详情里）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-AUT-023.1 | 组件 | 一次失败的运行，后端给了 errorMessage、输出摘要、投递失败 | 展开 | 依次出现人话一句、「失败信息（后端原文）」块、投递旁注、输出摘要、[打开任务] + 只读说明 | 已实现：RunHistoryItem.view.tsx:125-175 |
| AC-AUT-023.2 | 组件 | 运行带 sandboxId | 点 [打开任务] | 弹层关闭，工作台选中该任务 | 已实现：WorkbenchContainer.tsx:497-503 |
| AC-AUT-023.3 | 组件 | 自动停用的规则，最近一次算失败的运行排在第 12 条 | 从 [查看原因] 进入详情 | 运行历史展开全部，第 12 条处于展开态 | 已实现：RunHistoryList.view.tsx:49-58 |
| AC-AUT-023.4 | 组件 | 同上 | 进入详情 | 展开的那条滚到正文顶部（上留 12），失败信息与输出摘要在视口里；焦点在它的 [收起] 上 | 未实现：只展开、不滚动不移焦（稿件 f-aut-rules-08 第 5 条，Q-AUT-04） |
| AC-AUT-023.5 | e2e | REQ-AUT-025 已落地；一次已结束的运行 | 展开 | 不出 [打开任务]，出 [查看成果]；点了打开「保留下来的成果」并定位到这一份 | 未实现：随 DR-18；[查看成果] 未出稿（Q-AUT-02） |

### REQ-AUT-024 · 删除规则：同一弹层里的统一确认 {#REQ-AUT-024}

> 状态 `偏离` · 版本 v1.1 · 来源 Q-DS-17 A（破坏性确认统一结构）；UX-DS-307；P21-7 L96-99；DR-07（受影响清单由后端预检）；实现 AutomationDetail.view.tsx:132-136、161-205，AutomationsPanelContainer.tsx:116-129，useAutomations.ts:173-178，automation-application.service.ts:179-195，automation.sqlite.ts:95 · 关联 Q-AUT-03 · 稿件 f-aut-rules-09

详情点 [删除] → 同一个弹层**就地切到确认视图**（不叠第二层）：标题「删除自动化规则「<规则名>」？」，副标题「自动化规则 · 在 <项目> 中 · <状态>」。正文按统一结构分段：

- **会删掉**：这条规则，以及它的 N 次运行历史；之后不会再按时触发（原定下次 <时刻>）。
- **删掉之后**：拿不回来；要接着跑，只能重新建一条规则。
- **不受影响**：已经由它发起、还保留着的成果与任务（M 份运行成果仍在「保留下来的成果」里，到期自动清理，到期之前都可以下载）；正在跑的任务「<任务名>」不会被中断，会跑完。
- 清单来源一行：「清单来源：后端返回（规则详情、运行记录数、保留成果列表、正在跑的运行）。」

页脚 [取消]（打开时焦点在这里）· [删除规则]（destructive）。Esc 等同 [取消]，回到详情。N、M 与正在跑的任务**必须**来自后端；拿不到时**不写数字**（「它的全部运行历史」），**不得**拿已加载的条数充数。点 [删除规则] → 按钮「正在删除…」，两个按钮都不可点；成功 → 回到列表，这条消失；失败 → 留在确认视图，页脚第一行一句（按码查表，REQ-AUT-014）；`NOT_FOUND`（已在别处删掉）→ 直接回列表并刷新。

删除只删规则与它的运行历史，**不碰**任务与成果：正在跑的那次照常跑完，之后不再推进这条记录。

**改写了哪条旧文**：现状的行内小框「删除「X」？这条规则的运行历史会一起删掉，删了拿不回来。」+ 主按钮样式的 [确认删除]（AutomationDetail.view.tsx:176-205）→ 统一确认视图（Q-DS-17 A）；P21-7 L99「运行中的 Task 等完成或超时取消」→ 写进「不受影响」（删除不碰任务）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-AUT-024.1 | 组件 | 「每天凌晨跑一遍回归」的详情 | 点 [删除] | 同一个对话框切到确认视图：标题「删除自动化规则「每天凌晨跑一遍回归」？」，三段 + 清单来源；焦点在 [取消]；[删除规则] 为 destructive | 偏离：现状是详情里的行内小框 + [确认删除]，标题不变（AutomationDetail.view.tsx:176-205） |
| AC-AUT-024.2 | 组件 | 确认视图 | 按 Esc | 回到该规则的详情，弹层不关 | 未实现（随确认视图） |
| AC-AUT-024.3 | API | 规则有 42 次运行，其中一次在跑 | `DELETE /api/automations/:id` | 204；运行记录随外键级联删除；在跑的任务不受影响 | 已实现：automation-application.service.ts:179-195，automation.sqlite.ts:95 |
| AC-AUT-024.4 | 组件 | 后端没有给运行次数 | 打开确认视图 | 写「这条规则，以及它的全部运行历史」，不出现数字 | 未实现：运行历史游标不回总数（types/automation.ts:119-123），没有删除预检（Q-AUT-03） |
| AC-AUT-024.5 | 组件 | 确认视图 | 点 [删除规则] 成功 / 回 `NOT_FOUND` | 成功：回列表，该规则消失；`NOT_FOUND`：回列表并刷新 | 部分实现：成功回列表已实现（AutomationsPanelContainer.tsx:116-129）；404 时列表刷新（useAutomations.ts:173-178）但界面停在详情并出错误句 |

### REQ-AUT-025 · 跑完收尾：销毁任务、留下成果 {#REQ-AUT-025}

> 状态 `未实现` · 版本 v1.1（DR-18，sev2）· 来源 DR-18（推荐：运行结束后以 keepVolume 销毁该任务，登记 source=automation-artifact，保留期取规则的 3 / 7 / 30 天）；P21-7 L146、L172-176；P20 L341；实现 automation.scheduler.ts:349-373，contracts automation-collaborators.port.ts:75-96，retained-volume.entity.ts:15，sandbox-application.service.ts:753-758，AutomationForm.view.tsx:101-104 · 关联 F-PRJ-RETAINED · REQ-SYS-020 · Q-AUT-02

一次运行到终态（成功、失败、超时）后，平台**必须**收尾：以「留下来作为成果」的方式销毁这个无头任务（`keepVolume`，释放名额），把它的代码副本登记为一份保留下来的成果（来源 = 自动化），保留期取规则上的成果保留期（3 / 7 / 30 天）。成果出现在项目「保留下来的成果」里，到期按统一规则清理（REQ-SYS-020、F-PRJ-RETAINED）。没有真正起过任务的运行（跳过、错过、没排到资源）没有任务、也不产生成果。

在本条落地之前，表单开头那句「跑完自动销毁实例、只留成果」与事实不符：每跑一次就留下一个还在运行或空闲的任务，名额耗尽后规则自己开始排队、继而被判失败、最后被自动停用（DR-18 核实）。

**改写了哪条旧文**：P21-7 L146、L174「完成后 sandbox 自动销毁·卷保留 24h → 仅留成果 diff」→ 以 keepVolume 销毁 + 登记自动化来源的保留成果 + 保留期取规则（24 小时与 diff 都作废，DR-18、P20 L341）；P21-7 L175「定期清理任务 v1.2」→ 走保留成果的统一到期清理；P21-7 L176「无询问是否保留卷环节」保留（无人守终端）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-AUT-025.1 | 集成 | 规则成果保留期 7 天 | 一次运行成功结束 | 该任务被销毁、代码副本留下来；新增一份保留下来的成果，来源 `automation-artifact`，到期时间 = 结束时刻 + 7 天 | 未实现：收尾只记终态与通知（automation.scheduler.ts:349-373），launcher 没有收尾方法（automation-collaborators.port.ts:75-96），`automation-artifact` 没有写入点（DR-18） |
| AC-AUT-025.2 | e2e | 同上 | 打开项目「保留下来的成果」 | 能看到这份，标明来自规则「<规则名>」；工作台任务树里不再有这个任务 | 未实现 |
| AC-AUT-025.3 | 集成 | 一次「跳过」/「错过」/「没排到资源」 | 记录落地 | 不产生任务与成果 | 已实现（自然成立：这几类不建任务，automation.scheduler.ts:462-512） |
| AC-AUT-025.4 | e2e | 连续 10 次运行都成功 | 第 11 次到点 | 名额不因前 10 次的残留任务而耗尽，第 11 次正常起任务 | 未实现：残留任务一直占名额（DR-18 后果 1、2） |

### REQ-AUT-026 · 不做成果 diff 导出 {#REQ-AUT-026}

> 状态 `已实现` · 版本 v1.1 · 来源 P20 L341（2026-08-31 定案：不做 diff 导出）· 关联 F-PRJ-RETAINED · 稿件 f-aut-rules-08

运行详情与规则详情里**不得**出现「下载成果 diff」。成果的下载只在项目「保留下来的成果」里，以整份代码副本为单位（含 `.git` 与全部历史，解压即可继续干）。

**改写了哪条旧文**：P21-7 L62「[下载成果 diff]」、L174「仅留成果 diff（artifact）」→ 作废（P20 L341：agent 自己 commit 之后 diff 是空的，空项目没有基线）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-AUT-026.1 | 组件 | 任一运行的展开态 | 渲染 | 没有「下载成果 diff」或同义按钮 | 已实现：RunHistoryItem.view.tsx:125-175 没有该按钮 |

### REQ-AUT-027 · 到点时的判定：每个触发时刻都留一行 {#REQ-AUT-027}

> 状态 `部分实现` · 版本 v1.1 · 来源 P21-7 L104-125、L129-157、L161-170；P22 L131-139；实现 trigger-decision.domain-service.ts:42-88，automation.scheduler.ts:37-38、450-512、705-719，automation.entity.ts:50-60（I-AUT-8、I-AUT-10），policies.vo.ts:35-48、64-65，automation.notifier.ts:70-80 · 关联 PARAM.AUTOMATION_RETRY_INTERVAL_MIN · PARAM.AUTOMATION_RETRY_MAX · PARAM.AUTOMATION_MISSED_THRESHOLD_MIN · F-WB-BANNER · Q-AUT-05 · 稿件 f-aut-rules-07（六类在运行历史里的样子）

调度每分钟扫一次已开启、到点的规则。每个到点的触发时刻**必须**在运行历史里恰好留下一行（触发、跳过、错过之一），并且先把下一次触发推进到未来、再执行——崩溃重启不会把同一个时刻触发两次，也不会让一个时刻无声消失。判定按下表顺序：

| 顺序 | 到点时的情况 | 记一行 | 算失败 | 通知 |
|---|---|---|---|---|
| 0 | 平台调度当时没在跑，超过 `PARAM.AUTOMATION_MISSED_THRESHOLD_MIN`（5 分钟）才扫到 | 错过 | 不算 | 无；**不补跑** |
| 1 | 上一次触发的任务还没结束 | 跳过（`PREVIOUS_RUNNING`） | 不算 | 无 |
| 2 | 这个 Agent 没有可用凭证 | 跳过（`AUTH_EXPIRED`） | 不算 | 配了 Webhook 就发 `auth.expired`（不看「什么时候发通知」）；工作台提示归 Agent 凭证治理横幅（F-WB-BANNER，Q-AUT-05） |
| 3 | 资源不够 | 排队重试中：每 `PARAM.AUTOMATION_RETRY_INTERVAL_MIN`（24）分钟再试，最多 `PARAM.AUTOMATION_RETRY_MAX`（5）次；仍不够 → 失败「没排到资源」 | 排队时不算；放弃时算一次 | 终态按「什么时候发通知」 |
| 4 | 正常 | 起一个标准无头任务（同一套名额与代码副本），硬超时 = 规则的最长运行时间 | 按结果 | 终态按「什么时候发通知」 |

**改写了哪条旧文**：P22 L135「横幅『规则 X 因凭证过期已暂停 [重新授权]』」→ 规则并没有暂停，只是这次没跑；工作台由 Agent 凭证治理横幅提示（Q-DS-32 B），不另出逐条规则的横幅（Q-AUT-05）；P21-7 L134-156 的判定顺序按实现补上第 0 步「错过排在最前」（宕机两小时不会在历史里显示成一串「上一次还在跑」）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-AUT-027.1 | 集成 | 一条每小时规则 | 连续扫 3 轮，其中一轮执行时进程崩溃 | 每个到点时刻恰好一行记录，没有重复触发 | 已实现：automation.entity.ts（I-AUT-8、I-AUT-10），automation.scheduler.ts:450-458 |
| AC-AUT-027.2 | 单元 | 上一次运行仍在跑，且凭证也过期了 | 判定 | 跳过（`PREVIOUS_RUNNING`），不是 `AUTH_EXPIRED` | 已实现：trigger-decision.domain-service.ts:42-80 |
| AC-AUT-027.3 | 集成 | Agent 凭证已删除，规则配了 Webhook、仅成功通知 | 到点 | 记跳过（`AUTH_EXPIRED`），不起任务；仍发一条 `auth.expired`；该行投递旁注「Webhook 通知已送达。」 | 已实现：automation.scheduler.ts:475-489，automation.notifier.ts:70-80 |
| AC-AUT-027.4 | 集成 | 名额已满 | 到点，之后每次重试都没资源 | 同一行记录从「排队重试中 1/5」每 24 分钟更新到「5/5」，第 5 次仍不够 → 这一行变成失败「没排到资源」，失败计数 +1；排队期间不建任务 | 已实现：policies.vo.ts:35-48，automation.scheduler.ts:490-512、600-614 |
| AC-AUT-027.5 | 集成 | 调度停了 2 小时（每小时规则） | 恢复后第一轮 | 记一行「错过」，不补跑；下一次触发落在未来 | 已实现：trigger-decision.domain-service.ts:61-67，automation.scheduler.ts:462-472 |
| AC-AUT-027.6 | 单元 | — | 部署设置 `AUTOMATION_MISSED_THRESHOLD_MIN=10` | 错过判定按 10 分钟 | 已实现：automation.scheduler.ts:715-719（环境变量，未进参数登记） |
| AC-AUT-027.7 | e2e | Agent 凭证已过期，规则因此被跳过 | 看工作台 | 出「Agent 凭证已过期」治理横幅 + [重新登录]；不另出逐条规则的横幅 | 未实现：凭证治理横幅还没有（globalBanner.ts 只有三种，Q-DS-32 B 归 F-WB-BANNER） |

---

## 附录 A · 改写对照（逐条，来自各片段）

### 改写对照（旧文 → 本片）（aut）

| 旧文 | 位置 | 改写为 | 依据 |
|---|---|---|---|
| P21-7 L1、L14；P21 L16；P20 L413「项目菜单侧弹层」 | REQ-AUT-001、002 | 居中弹层，四个视图就地切换；SH-6 升独立页暂不问 | plan F-AUT-RULES 默认；现状 AppDialog |
| P21-1 L66 有项目无任务只有「发起第一个任务 →」 | REQ-AUT-001 | 另加次链接「设置自动化规则 →」 | U-22、P6 第 13e 条 |
| P21-7 L14「Cmd+K → 自动化」 | REQ-AUT-001 | 每个就绪项目一条「自动化规则 · <项目>」 | F-WB-CMDK（f-wb-cmdk-02） |
| P21-7 L18-31 列表下方展开选中规则 | REQ-AUT-002、020 | 详情是单独视图，带 [返回列表] | 现状 |
| P21-7 L23 摘要写 runtime | REQ-AUT-003、020 | 写 Agent 显示名，加时区一行 | DR-24；P21-7 L43 |
| P21-7 L25、L71「⏸️ 灰显」 | REQ-AUT-003 | 停用灰方块 | Q-DS-15 ②A |
| P21-7 L72「连续 3 次失败自动 enabled=false」 | REQ-AUT-004 | 3 次放慢、再 7 次停用，重新开启清零 | 同文 L90-92、L149-151、L169；P22 L139；实现 |
| P21-7 L94-95 归档联动 | REQ-AUT-004 | 不做 | F21-6 §10 D |
| P21-7 L38「Runtime」 | REQ-AUT-010 | 「用哪个 Agent 跑」 | Q-DS-21 A |
| P21-7 L46、L48「（v1.2）」 | REQ-AUT-010 | 「（还没开放）」 | DR-35 第 9 条 |
| P21-7 L51「☐成功 ☐失败 ☐超时」 | REQ-AUT-012 | 仅失败（含超时）/ 仅成功 / 全部，单选 | 同文 L180；实现 |
| （无旧文）校验句、保存失败、错误码 | REQ-AUT-013、014 | 按实现补齐；断网句按 README §3.2 改写 | 实现；README §3.2 |
| P21-7 L61 历史状态五个 emoji | REQ-AUT-021 | 六类 + 每行「算不算失败」 | 实现；P21-7 L75 |
| P22 L136「资源临时不足，已排队（3/5）」 | REQ-AUT-021、027 | 「排队重试中 3/5」 | 现状上屏词 |
| 现状跳过原因「被吊销」 | REQ-AUT-021 | 「被删除」 | DR-35 第 1 条 |
| 现状读取失败写「共 0 次」 | REQ-AUT-022 | 「共 — 次」+ [重试] | DR-22 |
| P21-7 L62「[打开 Task] + [下载成果 diff] + [查看规则]」 | REQ-AUT-023、026 | [打开任务]（任务还在时）；diff 作废；收尾后改 [查看成果] | P20 L341；DR-18；Q-AUT-02 |
| 现状行内删除小框 + [确认删除] | REQ-AUT-024 | 同一弹层就地切到统一确认视图 | Q-DS-17 A |
| P21-7 L99「运行中的 Task 等完成或超时取消」 | REQ-AUT-024 | 「不受影响：正在跑的任务会跑完」 | 实现（删除不碰任务） |
| P21-7 L146、L174「自动销毁·卷保留 24h·仅留成果 diff」 | REQ-AUT-025 | keepVolume 销毁 + 自动化来源的保留成果 + 规则保留期 | DR-18 |
| P22 L135 横幅「规则 X 因凭证过期已暂停」 | REQ-AUT-027 | 不另出；由凭证治理横幅提示 | Q-DS-32 B；Q-AUT-05 |

**移交给别的域的旧文**（不在本片编号）：P21-7 L10「触发产生的 Task 在列表用 [自动] 标签、可溯源到规则」与 L64「无头 Task 的只读输出流」→ F-SBX-HEADLESS（REQ-SBX）；P21-7 L8、L170「删除项目级联删规则」→ F-PRJ-DELETE（现状外键 restrict，见 DR-17 与本组 notes 的核实结论）；P21-7 L187「本机命令钩子 v1.5」、L191「trigger-now / runs/:id/retry v1.2」→ 范围外（`GET …/runs/:runId/logs` 后端已有、web 未用，实现先行，不在本期界面）；P21-7 L196「运行历史保留 ≥30 天」→ 现状随规则永久保留，满足下限，无需条目。

## 附录 B · 片段里的默认决定与待确认（原文）

> 下面是各片段的原文，编号仍是片段里的本地编号；统一编号与完整的选项、推荐、默认在 [open-questions.md](./open-questions.md)，对照见其 §7。

### 本片的默认决定与待确认（aut）

新开的待裁决号沿用 01 §4.4「试点 Q-<域>-NN」写法，合并时进 review/open-questions.md。

1. **Q-AUT-01 · 超时在运行历史里怎么画**（REQ-AUT-021）：默认照现状——红叉、归「失败」类（formatRunOutcome.ts:81-91；v1 g7-16 备注）。另一选项是 v1 tokens 登记的「超时」色调 + 时钟图标（与诊断的「超时未响应」同一视觉），只改视觉，计数口径不变。
2. **Q-AUT-02 · 跑完收尾后，已结束的运行 [打开任务] 去哪**（REQ-AUT-023、025）：默认——已结束的运行不再出 [打开任务]，改出 [查看成果]（打开项目「保留下来的成果」并定位到这一份）；运行中的照旧 [打开任务]。[查看成果] 本轮未出稿，随 DR-18 落地补 1 张。
3. **Q-AUT-03 · 删除确认里的数量从哪来**（REQ-AUT-024）：默认——后端给一个删除预检（运行记录总数、来自这条规则的保留成果、正在跑的运行），与 DR-07 同一口径；拿不到就不写数字。现状运行历史游标刻意不回总数。
4. **Q-AUT-04 · 从 [查看原因] 进来要不要滚动并移焦**（REQ-AUT-023）：默认要——把展开的那条滚进视野、焦点放在它的 [收起]（稿件 f-aut-rules-08 第 5 条）；现状只展开。
5. **Q-AUT-05 · 凭证原因的跳过要不要单独出横幅**（REQ-AUT-027）：默认不单出——P22 L135 的「规则 X 因凭证过期已暂停」说法不准（规则没有暂停），由 Agent 凭证治理横幅（Q-DS-32 B，F-WB-BANNER）统一提示；运行历史与 Webhook 已如实记录。
6. **Q-AUT-06 · 新建表单什么时候亮出字段错误**（REQ-AUT-013）：默认——字段被改过或失焦后才显示它的错误；刚打开不显示、不播报；[保存规则] 在有错误时仍不可用（同现状、同稿 f-aut-rules-06）。两条长度错误的句子（「规则名称最多 60 个字。」「描述最多 500 个字。」）为新增文案，暂行。
7. **形态按现状居中弹层**（REQ-AUT-002）：plan 默认，SH-6「升为带项目过滤的独立页」阶段 2 之后再定（research/shell-options.md:593）；选独立页时 G7 自动化 11 张稿要改画。
8. **Q-LCH-01（format-pilot 待裁决）**：任务内容 8000 的计法——前端按码点、后端 zod 按 UTF-16 单元；全是 emoji 的 8000 码点会在后端被拒。本片沿用该题，不另开号。

## 附录 C · 参数（待登记 params.yaml）

### 本片登记的参数（aut）

合并时进 `params.yaml`（数值与出处都是现状；改数字是产品变更）。

| 参数 | 值 | 用在 | 出处 |
|---|---|---|---|
| `PARAM.AUTOMATION_RULE_LIMIT` | 20 条 / 项目 | REQ-AUT-005 | web types/automation.ts:88；contracts automation.schema.ts:224 |
| `PARAM.AUTOMATION_DEGRADE_AFTER` | 3 次 | REQ-AUT-004 | policies.vo.ts:52；web types/automation.ts:94 |
| `PARAM.AUTOMATION_DISABLE_AFTER` | 10 次（放慢后再 7 次） | REQ-AUT-004 | policies.vo.ts:53；web types/automation.ts:96 |
| `PARAM.AUTOMATION_RETRY_INTERVAL_MIN` | 24 分钟 | REQ-AUT-027 | policies.vo.ts:37 |
| `PARAM.AUTOMATION_RETRY_MAX` | 5 次 | REQ-AUT-021、REQ-AUT-027 | policies.vo.ts:38；web types/automation.ts:91 |
| `PARAM.AUTOMATION_MISSED_THRESHOLD_MIN` | 5 分钟（环境变量 `AUTOMATION_MISSED_THRESHOLD_MIN` 可调） | REQ-AUT-027 | policies.vo.ts:65；automation.scheduler.ts:715-719 |
| `PARAM.AUTOMATION_TIMEOUT_OPTIONS_MIN` | 30 / 60 / 120 / 240，默认 120 | REQ-AUT-010 | policies.vo.ts:13-22；web types/task.ts:51 |
| `PARAM.AUTOMATION_RETENTION_OPTIONS_DAYS` | 3 / 7 / 30，默认 7 | REQ-AUT-010、REQ-AUT-025 | policies.vo.ts:68；web types/automation.ts:84 |
| `PARAM.AUTOMATION_NAME_MAX` / `PARAM.AUTOMATION_DESC_MAX` | 60 / 500 字 | REQ-AUT-010、REQ-AUT-013 | contracts automation.schema.ts:92-93 |
| `PARAM.AUTOMATION_RUNS_PREVIEW` / `PARAM.AUTOMATION_RUNS_PAGE_SIZE` | 10 / 20 条 | REQ-AUT-021 | web types/automation.ts:126-128；automation-application.service.ts:45 |
| `PARAM.AUTOMATION_SUMMARY_BYTES` | 1024 字节 | REQ-AUT-023 | automation.notifier.ts:16 |
| `PARAM.WEBHOOK_TIMEOUT_S` / `PARAM.WEBHOOK_RETRY_BACKOFF_S` | 10 秒 / 5、25 秒 | REQ-AUT-012 | http-webhook.sender.ts:22-23；validateWebhookUrl.ts:43-44 |
| `PARAM.TASK_PROMPT_MAX`（已登记） | 8000 | REQ-AUT-010 | format-pilot params.md（「用于」列写的是试点占位 REQ-AUT-007，合并时改成 REQ-AUT-010） |

## 附录 E · 合并时改动的地方

合并只做了下面这些改动；其余文字都是片段原文（本地待定编号已换成统一编号）。

| 需求 | 改动 | 为什么 |
|---|---|---|
| [REQ-AUT-020](#REQ-AUT-020) | 加合并说明 | 与 REQ-WB-014 互相引用 |
