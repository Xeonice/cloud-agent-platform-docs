---
id: PRD-SBX
title: 任务生命周期 · 产品需求
type: prd
status: draft
owner: 产品 owner（仓库唯一人类 owner）
domains: [SBX]
flows: [F-SBX-RELAUNCH, F-SBX-STOPSTART, F-SBX-DESTROY, F-SBX-HEADLESS]
applies_to: ">= v0.2.4"
last_verified:
  docs: fd2e1ee
  api: a453bb7
  web: 93f03c5
  date: 2026-10-04
covers:
  - web/src/views/sandbox/SandboxOutcome.view.tsx
  - web/src/containers/sandbox/{SandboxLifecycleContainer,SandboxTerminalContainer}.tsx
  - web/src/lib/sandbox/{sandboxErrorCopy,sandboxLifecycle}.ts
  - web/src/services/api/sandbox.service.ts
  - web/src/{views,containers}/task/**、web/src/lib/task/taskOutcome.ts、web/src/hooks/task/**、web/src/services/ws/taskSocket.ts
  - web/src/views/project/RunHistoryItem.view.tsx
  - api/packages/modules/sandbox/src/interface/http/{sandbox,agent-task}.controller.ts
  - api/packages/modules/sandbox/src/application/sandbox-application.service.ts
  - api/packages/modules/sandbox/src/application/workflows/{provision-sandbox,run-agent-task}.workflow.ts
  - api/packages/contracts/src/{schemas/sandbox.schema.ts,sandbox-failure-codes.ts,sandbox-provider.contract.ts}
  - api/packages/modules/image/src/application/image-facade.adapter.ts
supersedes:
drafts:
  - gap/drafts/f-sbx-relaunch-01…04、f-sbx-stopstart-01…04、f-sbx-destroy-01…02、f-sbx-headless-01…06（说明 gap/drafts/notes/lch-b.md；destroy-02、headless-06 为 W4 补稿）
merged_from:
  - gap/product/_parts/lch-b.md
merged_at: 2026-10-04
review_minutes: 35
---

# 任务生命周期 · 产品需求

<!-- 本文件只写「做什么 / 为什么 / 怎样算做对」。布局与视觉在稿件（gap/drafts/f-*），实现方法在技术设计。由 gap/product/_build/merge.py 从 _parts 合并生成；改片段后重新运行。「现状」列暂留文件:行出处，入库时按 01 §4.2 换成证据 ID。 -->

## 一屏摘要

- **这一域回答什么**：任务跑起来之后——失败了怎么重来、停止与启动、销毁过程、无头任务（自动化发起的任务）的只读输出与结果（REQ-SBX-001–035）。SBX 此前没有产品页，旧口径散在 P20、P21、P21-1、P21-2、P21-7、P22 与 LIVE-RUN。
- **五条要守的规则**：
  1. 异常任务不能「重试」：按钮叫 [重新发起]，打开预选原项目、Agent 与镜像的新建任务弹层，指令不回填，原任务留在树上（REQ-SBX-003）；环境类错误另带 [运行诊断]（REQ-SBX-001）。
  2. 错误码不进句子：只出现在 12px 的「诊断码：X」一行、`data-code` 与 [复制诊断信息] 的文本里（REQ-SBX-001、005）。
  3. 停止 = 暂停：不二次确认、继续占名额、不过期、没有倒计时；[启动] 从「启动运行环境」开始，会话从头、原指令不重放（REQ-SBX-010–013）。
  4. 超时未响应用超时色、不用失败红，也没有 [强制停止]（REQ-SBX-002）。
  5. 无头任务的主区只放只读输出，不挂终端、不自动连 Agent；终止本轮用行内确认（REQ-SBX-031、032）。
- **现状**：20 条需求里 `已实现` 1 · `部分实现` 6 · `未实现` 9 · `偏离` 3 · `实现先行` 1。web 没有停止、启动、销毁的任何调用，结果卡上的按钮都只做「取消选中」（DR-16），所以前三个流程大多是「未实现」，后端接口都在；无头任务基本已实现，偏离在主区布局（DR-01）。要后端配合：停止 / 销毁失败时写 failureCode、自动化跑完收尾（DR-18）、SandboxDto 回显所用镜像（Q-LCH-03 B 带来）、回显来源规则与任务名。
- **待定**：Q-SBX-01…07、Q-SYS-01②（[open-questions.md](./open-questions.md)）。其中 2026-10-04 已拍板：Q-SBX-02 B（只有首次启动阶段失败不给「留下来作为成果」，其余给、默认选中，REQ-SBX-022）、Q-SYS-01② A（环境类错误的结果卡带 [运行诊断]，REQ-SBX-001）、Q-SBX-03 A（屏上统一叫「代码副本」）。

**状态词表**：`已实现`（行为与本文一致）· `部分实现` · `未实现` · `偏离`（实现与本文不同）· `实现先行`（代码已有、原产品文档没写，待确认）· `未核实` · `计划中`（目标版本未到，或待某条待定问题选定后才生效）。「层级」= 最低验证层（单元 / 组件 / 集成 / API / e2e；`文档` = 文档一致性检查，`视觉` = 截图比对）。

## 需求索引

**共 20 条需求、73 条验收标准**：`已实现` 1 · `部分实现` 6 · `未实现` 9 · `偏离` 3 · `实现先行` 1。

| 编号 | 需求 | 状态 | 版本 | AC | 稿件 | 待定问题 |
|---|---|---|---|---:|---|---|
| [REQ-SBX-001](#REQ-SBX-001) | 异常结果卡：一句人话、主语行、建议、细节、动作、诊断码行 | `偏离` | MVP | 5 | f-sbx-relaunch-01、f-sbx-stopstart-04 | [Q-SYS-01②](./open-questions.md#Q-SYS-01) |
| [REQ-SBX-002](#REQ-SBX-002) | 超时未响应：时钟 + 超时色，没有 [强制停止] | `部分实现` | MVP | 3 | f-sbx-relaunch-02 | [Q-SBX-01](./open-questions.md#Q-SBX-01) |
| [REQ-SBX-003](#REQ-SBX-003) | [重新发起]：预选原项目、Agent 与镜像，指令不回填，原任务留着 | `未实现` | MVP | 5 | f-sbx-relaunch-03 | [Q-LCH-03](./open-questions.md#Q-LCH-03) [Q-DS-29](./open-questions.md#Q-DS-29) |
| [REQ-SBX-004](#REQ-SBX-004) | 改配置的出口按错误码分流；镜像类去镜像管理并带来源提示 | `未实现` | MVP | 5 | f-sbx-relaunch-04 | [Q-LCH-03](./open-questions.md#Q-LCH-03) |
| [REQ-SBX-005](#REQ-SBX-005) | [复制诊断信息]：多行纯文本 + 两句轻提示 | `部分实现` | MVP | 3 | f-sbx-relaunch-01 | [Q-LCH-03](./open-questions.md#Q-LCH-03) |
| [REQ-SBX-010](#REQ-SBX-010) | 停止 = 暂停：入口、不二次确认、继续占名额、不过期 | `未实现` | MVP | 4 | f-sbx-stopstart-01 | — |
| [REQ-SBX-011](#REQ-SBX-011) | 停止中：副行「停止中…」、终端只读、新终端与 [启动] 不可用 | `未实现` | MVP | 3 | f-sbx-stopstart-01 | — |
| [REQ-SBX-012](#REQ-SBX-012) | 已停止：结果卡说真话，给 [启动][发起新任务] | `偏离` | MVP | 3 | f-sbx-stopstart-02 | — |
| [REQ-SBX-013](#REQ-SBX-013) | 启动：从「启动运行环境」开始，会话从头、指令不重放 | `未实现` | MVP | 4 | f-sbx-stopstart-03 | — |
| [REQ-SBX-014](#REQ-SBX-014) | 停止 / 启动失败：转异常结果卡 | `未实现` | MVP | 3 | f-sbx-stopstart-04 | [Q-SYS-01②](./open-questions.md#Q-SYS-01) |
| [REQ-SBX-015](#REQ-SBX-015) | 状态已变：409「现在的状态不允许做这件事」 | `部分实现` | MVP | 2 | — | — |
| [REQ-SBX-020](#REQ-SBX-020) | 删除中：淡出点 + 半透明，菜单只剩禁用项，移除后出树 | `未实现` | MVP | 3 | f-sbx-destroy-01 | [Q-SBX-02](./open-questions.md#Q-SBX-02) |
| [REQ-SBX-021](#REQ-SBX-021) | 删的是当前任务：主区回项目总览，页内提示过程与结果 | `未实现` | MVP | 3 | f-sbx-destroy-01 | [Q-DS-35](./open-questions.md#Q-DS-35) |
| [REQ-SBX-022](#REQ-SBX-022) | 销毁失败与保留期 | `未实现` | MVP | 4 | f-sbx-destroy-02、f-sbx-destroy-03 | [Q-SBX-02](./open-questions.md#Q-SBX-02) [Q-SBX-03](./open-questions.md#Q-SBX-03) |
| [REQ-SBX-030](#REQ-SBX-030) | 无头任务只由自动化（与 MCP）发起；入口是运行详情 [打开任务]；能看出来自哪条规则 | `部分实现` | v1.1 | 3 | f-sbx-headless-01 | [Q-SBX-06](./open-questions.md#Q-SBX-06) |
| [REQ-SBX-031](#REQ-SBX-031) | 主区只放只读输出：不挂终端标签、不自动连 Agent | `偏离` | v1.1 | 4 | f-sbx-headless-01 | — |
| [REQ-SBX-032](#REQ-SBX-032) | 剩余时间与终止：行内确认、两阶段强杀 | `部分实现` | v1.1 | 5 | f-sbx-headless-01、f-sbx-headless-05 | — |
| [REQ-SBX-033](#REQ-SBX-033) | 事件流断线：如实说、自动重连、按序号续，不重复不丢 | `已实现` | v1.1 | 4 | f-sbx-headless-02、f-sbx-headless-03 | — |
| [REQ-SBX-034](#REQ-SBX-034) | 本轮结果：结论、退出码、建议、产物、诊断码 | `部分实现` | v1.1 | 4 | f-sbx-headless-04 | — |
| [REQ-SBX-035](#REQ-SBX-035) | 续接与下一轮：同一运行环境里再跑一轮 | `实现先行` | v1.1 | 3 | f-sbx-headless-04、f-sbx-headless-06 | [Q-SBX-04](./open-questions.md#Q-SBX-04) |

「待定问题」一列链到 [open-questions.md](./open-questions.md)，不回复时按那里写的默认走。

## 与旧文档的对照

由各条「改写了哪条旧文」汇总；旧文档代号见 [README](./README.md#旧文档代号)。逐条的旧文与新口径见每条需求，以及文末附录 A。

| 旧文档 | 被改写的位置 → 本文 | 其中作废 / 删去的 |
|---|---|---|
| P20 核心使用链路 | L140 → REQ-SBX-001；L393-394、L140 → REQ-SBX-003；L116-127 → REQ-SBX-004；L327-337 → REQ-SBX-010；L331-334 → REQ-SBX-022；L15 / L116 → REQ-SBX-030；（多处） → REQ-SBX-035 | — |
| P21 页面信息架构与交互 | L119 → REQ-SBX-001；L49 → REQ-SBX-010；L49 → REQ-SBX-011；L78 → REQ-SBX-013；L51 → REQ-SBX-020 | — |
| P22 异常场景与产品补充要求 | L9-22、L84、L15 / L84 → REQ-SBX-001；L16 → REQ-SBX-002；L68 → REQ-SBX-003；L11 / L43 → REQ-SBX-004；L84 → REQ-SBX-005；L80 → REQ-SBX-013；（多处）、L15 → REQ-SBX-014；L17 → REQ-SBX-015；L73 → REQ-SBX-032；L79 → REQ-SBX-033 | — |
| P21-1 工作台 | L69、L145、L83 → REQ-SBX-010；L71 → REQ-SBX-012；L83 → REQ-SBX-013；L145 → REQ-SBX-022；L70 → REQ-SBX-031；L70 → REQ-SBX-034 | L71（REQ-SBX-012）；L70（REQ-SBX-031） |
| P21-2 发起任务向导 | L159 → REQ-SBX-003；L100 → REQ-SBX-004 | — |
| P21-7 自动化 | （多处） → REQ-SBX-030；L146、L174 → REQ-SBX-034；（多处） → REQ-SBX-035 | — |
| LIVE-RUN | （多处） → REQ-SBX-030；（多处） → REQ-SBX-035 | — |

只改写实现现状、试点或稿件口径（不涉及上表旧文档）的需求：REQ-SBX-021。

---

## SBX · 失败后重来（F-SBX-RELAUNCH）

### REQ-SBX-001 · 异常结果卡：一句人话、主语行、建议、细节、动作、诊断码行 {#REQ-SBX-001}

> 状态 `偏离` · 版本 MVP · 来源 P22 §1 L9-22（错误码 → 用户语义）、L15（PROVIDER_UNAVAILABLE → [运行诊断]）、L24（「人话 + 按钮，禁止裸抛错误码」）、L84（未映射兜底）；P21 L50（异常 = 红点 + 人话原因）、L119（环境类错误附 [诊断]）；Q-SYS-01② A（用户拍板 2026-10-04：环境类错误的结果卡带 [运行诊断]）；Q-DS-15 ②A；DR-34 推荐（诊断码单列一行）；DR-31（副行短原因）；原型评审 PF-12（结果卡统一顺序）；UX-DS-102、UX-DS-402；实现 web/src/views/sandbox/SandboxOutcome.view.tsx:1-10、106-118、144，web/src/lib/sandbox/sandboxErrorCopy.ts（按码查表；fallbackCopy L480-498；describeSandboxError L529-541），web/src/containers/sandbox/SandboxLifecycleContainer.tsx:99-128 · 关联 REQ-LCH-015（启动失败转本卡）· 稿件 f-sbx-relaunch-01、f-sbx-stopstart-04

任务转为异常（`status=failed`）时，主区**必须**换成一张结果卡（不再挂终端），自上而下固定为：图标框 → 标题（按错误码查表的一句人话，失败色）→ 主语行「任务：<任务名>」→ 建议（为什么、现在能做什么；**必须**可见、不折叠）→ 失败细节（后端 `failureMessage` 原文，等宽，排障用；没有就不画）→ 动作（按码查表，至少一个，都不是实心主按钮）→ 附注（可选）→ 一行 12px「诊断码：<码>」。错误码**不得**写进标题、建议等句子；它只出现在诊断码行、`data-code` 与 [复制诊断信息] 的文本里。没有错误码时（旧数据、后端没写）不画诊断码行，也不把「UNKNOWN」当成码上屏。查不到文案的码用兜底：标题「操作没有完成」，建议用后端原话或「未能获取具体原因，可以重试一次；若持续失败请查看系统状态。」，动作 [重新发起]（REQ-SBX-003）。标题与主语行作为一个整体播报（失败用 role="alert"；随视图切换插入时，由「已打开 …」那句统一播报，不重复抢播）。树上该行红点 + 副行「<哪一步>失败：<标题主句>」（例「启动失败：没能把镜像拉下来」），顶栏状态徽标「异常」。

**环境类错误**（原因在这台机器的运行环境、不在任务配置里的码：PROVIDER_UNAVAILABLE「容器服务没有响应」、DISK_INSUFFICIENT「磁盘空间不够，代码副本没能准备出来」）的动作里**必须**另有 [运行诊断]（secondary，排在 [重新发起] 之后、[复制诊断信息] 之前）：去「系统状态」并自动开始一轮诊断（REQ-DIA-001；与离线横幅的 [重新检测] 同一个去处）。这类卡的建议句**不得**只点名 Docker Desktop / OrbStack——这台机器跑的可能是别的沙箱环境（boxlite），诊断会说清是哪一种、起没起来、磁盘还剩多少（Q-SYS-01② A，用户拍板 2026-10-04；首次启动、停止 / 启动、销毁失败的卡都按这一条，REQ-LCH-015、REQ-SBX-014、REQ-SBX-022）。

**改写了哪条旧文**：P22 L9-22「用户看到」列里的 emoji（❌ 🔴 ⏱️）→ 按 sandboxErrorCopy 的现行人话，图标由界面按 severity 决定；P22 L84「操作失败（错误码 XXX）[重试] [运行诊断]」→「操作没有完成」+ 诊断码行（码不进句子）；实现把诊断码挪进了 [复制诊断信息]、正文一个码都不出（SandboxOutcome.view.tsx:6-10）→ 按 DR-34 恢复为单独一行 12px（「标签 + 码」单列，不算裸抛）；P20 L140「阶段进度卡就地变红 + [重试]」→ 进度卡换成结果卡、按钮见 REQ-SBX-003；P21 L119、P22 L15 / L84「环境类错误附 [运行诊断]」→ 只给环境类的两个码，兜底卡不给（Q-SYS-01② A）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-SBX-001.1 | 组件 | 任务 failed，failureCode=IMAGE_PULL_FAILED，failureMessage 有值 | 主区渲染 | 依次出现：圆叉图标框、标题「没能把镜像拉下来（网络不通，或者镜像名写错了）」（失败色）、「任务：迁移构建脚本」、建议、等宽细节、[重新发起][检查镜像地址][复制诊断信息]、「诊断码：IMAGE_PULL_FAILED」；标题与建议里没有码 | 偏离：主语行在标题上方、没有图标框与诊断码行、按钮叫 [重试]（SandboxOutcome.view.tsx:106-118，sandboxErrorCopy.ts:267-272）；建议里「镜像仓库」按 Q-DS-21 A 改「镜像下载源」（稿件 f-sbx-relaunch-01） |
| AC-SBX-001.2 | 单元 | failureCode 不在文案表里（如 AUTH_REJECTED、INTERNAL） | 取文案 | 标题「操作没有完成」；建议为后端原话或兜底句；有一个可点动作；诊断码行显示该码 | 部分实现：兜底已有（sandboxErrorCopy.ts:480-498），动作名是 [重试] / [返回重新配置]，诊断码不上屏 |
| AC-SBX-001.3 | 组件 | 任务 failed 但没有 failureCode | 主区渲染 | 出兜底卡；不出现「诊断码：」行，也不出现「UNKNOWN」 | 未实现：现状把缺码记作 UNKNOWN 放进复制文本（sandboxErrorCopy.ts:534-538） |
| AC-SBX-001.4 | e2e | 任务从 starting 转 failed | 看左侧树与顶栏 | 红点（aria-label「异常」）+ 副行人话原因；顶栏徽标「异常」 | 部分实现：toDisplayStatus failed → error（sandboxLifecycle.ts:121-140）；副行短原因随 DR-31 |
| AC-SBX-001.5 | 组件 | 任务 failed，failureCode=PROVIDER_UNAVAILABLE（首次启动时容器服务不可达）；另一个任务 failureCode=DISK_INSUFFICIENT | 主区渲染 | 两张卡都有 [运行诊断]（在 [复制诊断信息] 之前）；点它跳到「系统状态」并自动开始一轮诊断；PROVIDER_UNAVAILABLE 的建议句不只点名 Docker / OrbStack | 未实现：文案表 PROVIDER_UNAVAILABLE 只有 [重试]、建议句只说 Docker Desktop / OrbStack（sandboxErrorCopy.ts:371-377），DISK_INSUFFICIENT 只有 [清理磁盘后重试]（sandboxErrorCopy.ts:235-244）；结果卡没有去系统状态的动作 |

### REQ-SBX-002 · 超时未响应：时钟 + 超时色，没有 [强制停止] {#REQ-SBX-002}

> 状态 `部分实现` · 版本 MVP · 来源 P22 L16（TIMEOUT「⏱️ 操作超时」→ [重试] / [强制停止]）；Q-DS-21 A（定稿词「超时未响应」，SP/design-track/final/spec/content.md:71）；UX-DS-102 / UX-DS-139（超时 ≠ 失败，用超时色；spec/status-mapping.md:47、92）；Q-DS-15 ②A（树点仍是异常红）；v1 g2-06；实现 sandboxErrorCopy.ts:382-388（TIMEOUT，severity timeout，动作 [重试]）、web/src/components/ui/outcome-icon.tsx:21（timeout → 时钟）、SandboxOutcome.view.tsx:110-118（failed 一律红字） · 稿件 f-sbx-relaunch-02

错误码为 TIMEOUT（平台在限定时间内没等到容器服务应答，先停了下来）时，结果卡**必须**用时钟图标与超时色（不是失败红），标题以状态词「超时未响应：」开头、接现有那句「这一步等太久，平台先停下了」；建议首句说清是在限定时间内没有等到应答——拿得到时长才写秒数（「600 秒内没有等到应答。」），拿不到就只说「在限定时间内没有等到应答」，**不得**编数字——并保留「超时只说明这次在限定时间内没做完，不等于对面连不上」。动作 [重新发起][复制诊断信息] + 诊断码行；**不得**出现 [强制停止]：超时之后任务已经落成异常、停下了，没有可停的东西。树上该行仍是红点（用户态是「异常」），副行用超时色写同一句。

**改写了哪条旧文**：P22 L16「⏱️ 操作超时 → [重试] / [强制停止]」→「超时未响应：这一步等太久，平台先停下了」+ [重新发起][复制诊断信息]，删 [强制停止]；同族退役词「预算」不在本卡出现（无头任务那一处见 REQ-SBX-032）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-SBX-002.1 | 组件 | failed，failureCode=TIMEOUT | 主区渲染 | 时钟图标框；标题「超时未响应：这一步等太久，平台先停下了」为超时色（不是失败红）；建议首句说「在限定时间内没有等到应答」（拿得到时长才写秒数） | 部分实现：时钟图标已有（outcome-icon.tsx:21）；标题没有前缀、是红字（SandboxOutcome.view.tsx:114）；时长目前没有数据来源（待定 Q-SBX-01；稿件 f-sbx-relaunch-02 用 v1 的示例值 600） |
| AC-SBX-002.2 | 组件 | 同上 | 看动作 | [重新发起][复制诊断信息]；没有 [强制停止]；「诊断码：TIMEOUT」 | 部分实现：动作只有 [重试]（sandboxErrorCopy.ts:387），诊断码不上屏 |
| AC-SBX-002.3 | e2e | 同上 | 看左侧树 | 红点（aria-label「异常」）+ 副行超时色「超时未响应：这一步等太久，平台先停下了」 | 部分实现：红点已有，副行超时色未实现 |

### REQ-SBX-003 · [重新发起]：预选原项目、Agent 与镜像，指令不回填，原任务留着 {#REQ-SBX-003}

> 状态 `未实现` · 版本 MVP · 来源 DR-02 A（弹层已关后的失败不回填指令，结果卡按钮叫「重新发起」）；DR-16 推荐（sev2：retry = 打开新建弹层，预填 Agent 和分支）；Q-LCH-03 B（用户拍板 2026-10-04：[重新发起] 预填原任务的镜像）；Q-DS-29 默认 A（弹层里有项目下拉）；TASK-LAUNCH T-1（docs/TASK-LAUNCH-DECISIONS.md:27-40：initialPrompt 存了但不回显）；P21-2 L159、L192、L207，P20 L140、L393-394，P22 L68；实现 SandboxTerminalContainer.tsx:373-378（handleRetry 只清选中与状态）、:531-543（随后主区「「X」下还没有任务。」）、api/packages/contracts/src/schemas/sandbox.schema.ts:178-275（SandboxDto 没有 branch / image / initialPrompt）、sandbox-application.service.ts:546-553（failed 不能 start，只能销毁后重建） · 关联 REQ-LCH-001–009（弹层本身，镜像字段见 REQ-LCH-004）、REQ-LCH-010–017（发起后的启动流程；SandboxDto 回显镜像见 REQ-LCH-017）· 稿件 f-sbx-relaunch-03

结果卡上「再来一次」的动作**必须**叫 [重新发起]，不叫 [重试]：后端没有「重跑失败阶段」的接口，异常任务也不能被启动，只能另建一个。点了之后打开新建任务弹层（REQ-LCH-001）：项目预选原任务的项目，Agent 预选原任务的 Agent，镜像预选原任务用的那张镜像（Q-LCH-03 B；靠 SandboxDto 回显镜像，REQ-LCH-017）；弹层顶部一条信息说明「从失败的任务「X」重新发起」+「项目、Agent 和镜像已按原任务选好。原来那个任务留在左侧不动，不需要了可以从它的任务菜单销毁。」。预选的是这张镜像、不是原任务锁定的那一版：发起时用它那一刻的当前版本（原任务失败可能正因为那一版）。原任务用的镜像现在已禁用或验证没通过时仍预选它（置灰、写原因），字段下一句「原任务用的镜像「X」现在不能用（已禁用）：改选一张，或到「镜像管理」重新启用它。」，主按钮不可发起并指向这句——**不得**悄悄换成平台预制镜像（与 Agent 不可用时仍预选同一原则）。分支**不**预填（SandboxDto 不回显 branch）：下拉停在「跟随项目当前的分支（默认）」，下面一句「原任务用的分支没有带过来；需要的话在这里重新选。」——后端回显 branch 之后改为预选、去掉这句（不在本轮）。任务指令**不**回填（平台不回显提交过的指令）：框为空，框下一句「原来的任务指令没有带过来（平台不回显提交过的指令），需要的话重新填写。」。原任务的 Agent 现在不可用时仍然预选它，交给凭证闸门（REQ-LCH-003）拦，不悄悄改选别的 Agent。发起之后走正常的启动流程（REQ-LCH-010–017）：新任务进树并成为当前任务；原失败任务原样留在树上，不自动销毁。关掉弹层不发起时，回到原任务的结果卡（不清选中，不出现「还没有任务」）。

**改写了哪条旧文**：P21-2 L159「FAIL --> PULL : 重试（已 ✅ 阶段锁定不重跑）」、L192「[重试]/[上一步]」、L207「仅失败阶段可 [重试]」，P20 L393-394「失败: [重试]（仅失败阶段）」，P22 L68「[重试]（已完成的初始化不重跑）」→ [重新发起] = 新建一个任务（后端无重试接口）；P20 L140「人话原因 + [重试]」同改；DR-16 指出的缺陷（[重试] 只清选中，主区说「还没有任务」）随本条消失；DR-16 推荐的「预填 Agent 和分支」→ 预填项目、Agent 与镜像，分支等后端回显（Q-LCH-03 B，用户拍板 2026-10-04）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-SBX-003.1 | e2e | 选中异常任务「迁移构建脚本」（acme-web · codex） | 点 [重新发起] | 新建任务弹层打开：项目 = acme-web、Agent = codex、镜像 = 原任务用的那张（这里是平台预制镜像）、顶部来源说明；分支停在默认 + 一句说明；指令框为空 + 一句说明；[发起任务并打开终端] 可用 | 未实现：handleRetry 只清选中（SandboxTerminalContainer.tsx:373-378）；稿件 f-sbx-relaunch-03 |
| AC-SBX-003.2 | e2e | 同上，弹层已打开 | 不改任何东西直接发起 | 新任务进树（准备中）并成为当前任务；「迁移构建脚本」仍在树上、仍是异常 | 未实现 |
| AC-SBX-003.3 | e2e | 同上，弹层已打开 | 点 [取消] 或按 Esc | 弹层关闭，焦点回到 [重新发起]，主区仍是原任务的结果卡 | 未实现：现状主区落到「「acme-web」下还没有任务。」（SandboxTerminalContainer.tsx:531-543） |
| AC-SBX-003.4 | 组件 | 原任务的 Agent（claude-code）现在没有可用凭证 | 点 [重新发起] | Agent 仍预选 claude-code，弹层按凭证闸门拦住发起；不改选别的 Agent | 未实现 |
| AC-SBX-003.5 | 组件 | 原任务用 ml-agent:v1.0，现在 ml-agent 已禁用 | 点 [重新发起] | 「镜像」预选 ml-agent（置灰、写「（已禁用）」）+ 说明句；主按钮不可发起并指向它；改选平台预制镜像后可发起 | 未实现：handleRetry 只清选中（SandboxTerminalContainer.tsx:373-378），弹层也没有镜像字段；SandboxDto 契约里没有镜像（AC-LCH-017.1） |

### REQ-SBX-004 · 改配置的出口按错误码分流；镜像类去镜像管理并带来源提示 {#REQ-SBX-004}

> 状态 `未实现` · 版本 MVP · 来源 DR-16 推荐（reconfigure 按错误码分流：去镜像管理 / 改选分支 / 改选 Agent）；P22 L11、L43（[检查镜像地址] 只有按钮名）；P20 L98、L169 与 F21-2（新建弹层的镜像下拉，2026-10-04 拍板 Q-LCH-03 B 后补上，REQ-LCH-004）；实现 sandboxErrorCopy.ts（各码 reconfigure 的动作名）、SandboxLifecycleContainer.tsx:107-111（retry 与 reconfigure 同走 onRetry）、api/packages/modules/image/src/application/image-facade.adapter.ts:38-47（不给镜像 → 本档预制镜像 builtinImageRefFor）、api/packages/contracts/src/sandbox-failure-codes.ts（异常任务可携带的码闭集）· 稿件 f-sbx-relaunch-04

结果卡上「改配置」那一个动作（文案表里 key=reconfigure）**必须**去到能改的地方，不得只是清掉选中：

| 异常任务可能携带的码 | 动作名（沿用现状） | 去处 |
|---|---|---|
| IMAGE_PULL_FAILED | 检查镜像地址 | 镜像管理 + 来源提示 + 定位到该任务用的镜像 |
| IMAGE_DIGEST_GONE | 去镜像管理检查更新 | 同上 |
| IMAGE_CONTRACT_VIOLATION | 换一张含 tmux 的镜像 | 同上 |
| INSTALL_FAILED | 换一张预装该工具的镜像 | 同上 |
| UNKNOWN_RUNTIME | 改选 Agent | [重新发起] 的弹层（REQ-SBX-003），这一次 Agent 不预选 |
| WORKSPACE_PREPARE_FAILED、其余兜底 | 返回重新配置 | [重新发起] 的弹层 |
| AUTH_REJECTED（凭证注入被拒；现状落兜底） | 去凭证管理（新增） | 凭证管理，定位到该 Agent 的卡片 |

来源提示放在镜像管理内容顶部、工具行之前，随内容滚动（不是全局横幅、不是轻提示），信息色调、可关：标题「从任务「X」来：<结果卡标题的主句>——看看镜像地址与验证结论」；正文说清这个任务用的是哪张镜像（下面已标出，REQ-LCH-017），地址与验证结论都没问题时多半是这台机器连不上镜像下载源，可以到「系统状态」看连接，改好之后回到任务点 [重新发起]（要换一张镜像就在弹层的「镜像」一栏里选，REQ-LCH-004）；两个链接 [回到任务「X」]、[系统状态]；× 的可访问名「关闭来源提示」。该任务用的镜像卡**必须**被定位：焦点色环 + 一枚徽标「「X」用的镜像」（只靠环会被读成键盘焦点）。提示只属于这一次跳转：点 × 或离开镜像管理即消失。定位的是这个任务用的那张镜像：按 SandboxDto 回显的镜像（REQ-LCH-017）找卡——工作台发起的任务也可能用自定义镜像了（Q-LCH-03 B，用户拍板 2026-10-04）；回显到位之前退回定位平台预制镜像（拍板前工作台发起的任务都用它）。

INVALID_IMAGE_REFERENCE、REF_NOT_FOUND、REGISTRY_UNREACHABLE、IMAGE_NOT_REGISTERED、IMAGE_PROVIDER_MISMATCH、MANIFEST_INVALID、BRANCH_NOT_FOUND 等不在异常任务可携带的码里，它们是新建时的同步拒绝，出现在新建弹层里（REQ-LCH-007），不走本条。

**改写了哪条旧文**：P22 L11 / L43 只有按钮名 [检查镜像地址] → 补上去处；plan 原写「IMAGE_PULL_FAILED / INVALID_IMAGE_REFERENCE → 去镜像管理」→ 按实现收窄（INVALID_IMAGE_REFERENCE 只会是同步拒绝，sandbox-failure-codes.ts 的闭集里没有它）；「回到新建弹层改镜像」（P20 L116-127、P21-2 L100 的镜像下拉）→ 镜像本身有问题（地址、版本、缺 tmux）去镜像管理；要改用另一张镜像，在 [重新发起] 弹层的「镜像」一栏里选（Q-LCH-03 B，用户拍板 2026-10-04）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-SBX-004.1 | e2e | 异常任务「迁移构建脚本」failureCode=IMAGE_PULL_FAILED | 点 [检查镜像地址] | 跳到镜像管理；内容顶部来源提示（标题含任务名与「没能把镜像拉下来」）；平台预制镜像卡（这个任务用的那张）被定位、带徽标「「迁移构建脚本」用的镜像」 | 未实现：reconfigure 与 retry 是同一个 handler（SandboxLifecycleContainer.tsx:107-111）；稿件 f-sbx-relaunch-04 |
| AC-SBX-004.2 | e2e | 同上，已在镜像管理 | 点 [回到任务「迁移构建脚本」] | 回到工作台并选中该任务（结果卡）；回到镜像管理时提示不再出现 | 未实现 |
| AC-SBX-004.3 | 组件 | 同上 | 点来源提示的 × | 提示消失，焦点落到工具行的搜索框；页面其余不变 | 未实现 |
| AC-SBX-004.4 | 单元 | 上表各码 | 取 reconfigure 的去处 | 镜像类 → 镜像管理；UNKNOWN_RUNTIME / WORKSPACE_PREPARE_FAILED / 兜底 → 重新发起弹层；AUTH_REJECTED → 凭证管理 | 未实现 |
| AC-SBX-004.5 | e2e | 异常任务用的是 ml-agent:v1.0（IMAGE_CONTRACT_VIOLATION） | 点 [换一张含 tmux 的镜像] | 镜像管理里定位的是 ml-agent 卡（带徽标「「X」用的镜像」），不是平台预制镜像卡 | 未实现：去处还没接（SandboxLifecycleContainer.tsx:107-111）；SandboxDto 契约里没有镜像（AC-LCH-017.1） |

### REQ-SBX-005 · [复制诊断信息]：多行纯文本 + 两句轻提示 {#REQ-SBX-005}

> 状态 `部分实现` · 版本 MVP · 来源 P22 L24；v1 g2-05；UX-DS-508（轻提示不报告异步结果，SP/design-track/final/spec/a11y.md:43）；实现 SandboxOutcome.view.tsx:59-76（拼文本）、:94-98（有码 / 细节 / traceId 才给按钮）、:144，SandboxLifecycleContainer.tsx:57-73（剪贴板与两句轻提示），sandbox.schema.ts:246-258（异步失败只有 failureCode / failureMessage）· 稿件 f-sbx-relaunch-01（成功轻提示）

结果卡有错误码、失败细节或 traceId 任一项时才给 [复制诊断信息]（tertiary）；只有一句标题的卡（如「任务已停止」）不给。点了把下面几行纯文本写进剪贴板，缺的行不出现：「任务：<任务名>」「现象：<标题>」「错误码：<码>」「traceId：<…>」「细节：<failureMessage>」。成功出成功轻提示「诊断信息已复制」；失败（剪贴板不可用，例如非 HTTPS 的局域网部署）出失败轻提示「复制失败，请手动选中下面的失败细节复制」（role="alert"），**不得**静默——静默会让用户粘出上一次复制的内容。轻提示只确认这一次复制，不报告任务状态。异步失败（启动途中失败）没有 traceId：traceId 只在同步请求的错误信封里，所以这类卡的复制文本没有这一行；同步请求失败（停止失败，REQ-SBX-014）有 traceId 就带上。2026-10-04 拍板 Q-LCH-03 B 之后，「任务：」之后多一行「镜像：<坐标>@<版本号>」（REQ-LCH-017，AC-LCH-017.4）。

**改写了哪条旧文**：原产品文档没有这个动作（只有实现与 v1 g2-05）；P22 L84 兜底把「（错误码 XXX）」写进正文 → 码只进诊断码行与复制文本（REQ-SBX-001）。

**合并说明**：片段原记「已实现」；WB 组核实 AC-WB-063.4 时发现的写法在本处也有（合并时读代码确认），按代码更正为「部分实现」。（交叉引用：AC-WB-063.4）

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-SBX-005.1 | 组件 | 卡片有码与细节 | 点 [复制诊断信息] | 剪贴板为「任务：迁移构建脚本」「现象：没能把镜像拉下来（…）」「错误码：IMAGE_PULL_FAILED」「细节：pull ghcr.io/…」四行；主区右上角成功轻提示「诊断信息已复制」 | 已实现：SandboxOutcome.view.tsx:59-76，SandboxLifecycleContainer.tsx:66-73（稿件 f-sbx-relaunch-01） |
| AC-SBX-005.2 | 组件 | 剪贴板 API 不可用 | 点 [复制诊断信息] | 失败轻提示「复制失败，请手动选中下面的失败细节复制」（role="alert"）；失败细节块仍可选中复制 | 部分实现：写入被拒那一支已实现（SandboxLifecycleContainer.tsx:70-72）；`navigator.clipboard` 不存在（非 HTTPS 部署）时 `writeText` 同步抛 TypeError，失败轻提示出不来（:67；同 AC-WB-063.4，合并时据代码更正） |
| AC-SBX-005.3 | 组件 | 卡片没有码、细节、traceId | 渲染 | 不出现 [复制诊断信息] | 已实现：SandboxOutcome.view.tsx:94-98 |

## SBX · 停止与启动（F-SBX-STOPSTART）

### REQ-SBX-010 · 停止 = 暂停：入口、不二次确认、继续占名额、不过期 {#REQ-SBX-010}

> 状态 `未实现` · 版本 MVP · 来源 DR-03 A（看稿组 1；BACKLOG DR-03 核实：stopped 保留配额登记、没有任何过期回收）；Q-DS-15 ①A（stopping / stopped 归「已停止」，删「已暂停」档）；v1 g2-08、g2-09（各状态的任务菜单）；P20 L327-337；P21 L47-49、L70-71；P21-1 L69、L83、L145；实现 api sandbox.controller.ts:77-83（POST /stop）、sandbox-application.service.ts:584-607（只接受 running / idle；同步 provider.stop；`stopped` 保留登记，:601）、web/src/services/api/sandbox.service.ts:27-53（只有 create / get / list）· 关联 REQ-LCH-007（资源不够的建议句，lch-a）· 稿件 f-sbx-stopstart-01（停止后的第一屏）

运行中、运行中 · 空闲、等待你输入的任务，任务菜单里有 [停止]（菜单：[停止] ┃ [销毁任务…] +「销毁前会让你确认代码副本留不留。」）。点了直接停止，**不**二次确认：停止不丢东西，随时能 [启动] 回来。停止 = 暂停：运行环境（容器 / 虚拟机实例）与代码副本都保留，Agent 会话结束；任务**继续占一个任务名额**（准入按未释放的登记算）；**没有**保留期，不会自动过期或回收，副行不写任何倒计时。要腾出名额只能销毁（REQ-SBX-020）。

**改写了哪条旧文**：P20 L327-337「Stop：资源立即释放、卷保留… 30 天自动过期」与 P21-1 L69「卷保留中（还需 X 天）」→ 停止不释放名额、不过期、没有倒计时；P21-1 L145「Stop / 销毁一律二次确认」→ 只有销毁要确认；P21 L49「⏸️ 已暂停 = idle / stopping / stopped」→ idle 归运行中、stopping / stopped 归「已停止」；P21-1 L83 右键菜单「[重启] [Stop] [销毁] [改名]」→ [停止] / [启动] / [销毁任务…]（[改名] 没有接口，不做）；资源不够的建议句「停掉几个不用的任务把资源让出来」（sandboxErrorCopy.ts:357）照做无效 → 改为已停止也占名额、要销毁才能腾出（REQ-LCH-007）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-SBX-010.1 | e2e | 运行中任务「修一下登录态刷新」 | 打开它的任务菜单 | 有 [停止] 与 [销毁任务…]，没有 [启动] | 未实现：任务行没有菜单（v1 g2-08 核实），sandbox.service.ts 没有 stop |
| AC-SBX-010.2 | e2e | 同上 | 点 [停止] | 不弹确认，直接进入停止中（REQ-SBX-011）；发出 POST /api/sandboxes/{id}/stop | 未实现 |
| AC-SBX-010.3 | 集成 | 任务已停止 | 再发起新任务、过几天再看 | 准入仍把它算作占用；它不会被自动回收 | 已实现（后端）：sandbox-application.service.ts:601（stopped 保留登记），VolumeReaper 只清理保留下来的成果（BACKLOG DR-03 核实） |
| AC-SBX-010.4 | e2e | 停掉的是等待你输入的任务 | 停好后看导航与总览 | 导航「等待你输入」徽标减 1；项目总览「需要你处理」不再列它 | 未实现 |

### REQ-SBX-011 · 停止中：副行「停止中…」、终端只读、新终端与 [启动] 不可用 {#REQ-SBX-011}

> 状态 `未实现` · 版本 MVP · 来源 Q-DS-15 ①A（spec/status-mapping.md:70：stopping 副行「停止中…」）；v1 g1-02（树行）、g2-09 / g2-09b（停止中 [启动] 禁用）；实现 sandbox-application.service.ts:584-607（stop 同步：stopping → provider.stop → stopped，/events 依次推送）、:546-553（start 只接受 stopped，停止中调 start → 409）、web sandboxLifecycle.ts:76、84（stopping 归 ended，直接显示「任务已停止」卡）· 稿件 f-sbx-stopstart-01

从点 [停止] 到后端返回（通常是秒级）之间，任务处于停止中：树上灰方块（属「已停止」）+ 副行「停止中…」；顶栏状态徽标「停止中…」；主区仍是终端，终端栏下面一条连接条「正在停止…」+「这期间终端不能输入；停好后运行环境和代码副本都留着，随时可以 [启动]。」（role="status"）；终端停在最后一屏，可读、可复制，但不接收输入；[新终端] 不可用（仍能聚焦，说明「正在停止，不能再开新终端」）；任务菜单里 [启动] 禁用。停好（stopped）后主区换成已停止结果卡（REQ-SBX-012），终端标签收起。

**改写了哪条旧文**：原产品文档只有状态名（P21 L49 把 stopping 归「已暂停」），没有停止中的画面；实现把 stopping 当成已结束，直接出「任务已停止」卡（sandboxLifecycle.ts:76）→ 停止中是单独一态。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-SBX-011.1 | e2e | 点了 [停止]，后端还没返回 | 看树与主区 | 树行灰方块 +「停止中…」；终端栏下「正在停止…」连接条；在终端里打字没有任何回显 | 未实现：web 把 stopping 直接显示成「任务已停止」卡（sandboxLifecycle.ts:76、84）；稿件 f-sbx-stopstart-01 |
| AC-SBX-011.2 | 组件 | 停止中 | 点 [新终端]；打开任务菜单 | [新终端] 不开菜单并说出原因；菜单里 [启动] 禁用 | 未实现 |
| AC-SBX-011.3 | e2e | 停止中 | 后端返回 stopped | 主区换成「任务已停止」卡，树副行变「已停止」 | 未实现 |

### REQ-SBX-012 · 已停止：结果卡说真话，给 [启动][发起新任务] {#REQ-SBX-012}

> 状态 `偏离` · 版本 MVP · 来源 DR-03 A（结果卡如实改成「运行环境停着，代码副本还在」+ [启动][发起新任务]；去掉倒计时）；Q-DS-15 ②A（已停止 = 灰方块）；P22 L80（重启开新会话，文案不得暗示恢复现场）；v1 g2-07；实现 sandboxErrorCopy.ts:500-517（SANDBOX_ENDED_COPY「这个任务的运行环境已经回收了…」，只给 [发起新任务]，同时用于 stopping / stopped / destroying）、SandboxLifecycleContainer.tsx:115-123（ended 不传诊断码）· 稿件 f-sbx-stopstart-02

已停止的任务：树上灰方块 + 副行「已停止」（没有倒计时、没有保留天数）。主区结果卡（中性色调、信息图标，role="status"）：标题「任务已停止」→ 主语行 → 说明「运行环境停着，代码副本还在；启动后 Agent 会话从头开始，不会接着上次的对话。」→ [启动]（secondary）[发起新任务]（secondary）→ 附注「停着的任务仍占一个任务名额；不用了就从任务菜单销毁，名额才会腾出来。」。不出现诊断码行，也不出现 [复制诊断信息]。[发起新任务] 打开新建任务弹层并预选这个项目（REQ-LCH-001），不预选 Agent。任务菜单：[启动] ┃ [销毁任务…]。

**改写了哪条旧文**：sandboxErrorCopy.ts:509-517「这个任务的运行环境已经回收了。可以再发起一个 —— 那是全新的一轮…」→ 只用于 stopped，说明改为真实语义并补 [启动]；v1 g2-07「运行环境已经停下，工作目录还在。[启动] 会在原来的工作目录上…」→ DR-03 A 原句；P21-1 L71「全部已暂停：选择一个任务并点[重启]继续」→ 删除（每张已停止卡上都有 [启动]）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-SBX-012.1 | 组件 | 任务 stopped | 主区渲染 | 卡片文字与按钮同上；没有「回收」「还需 N 天」；没有诊断码行 | 偏离：「运行环境已经回收了」+ 只有 [发起新任务]（sandboxErrorCopy.ts:509-517）；稿件 f-sbx-stopstart-02 |
| AC-SBX-012.2 | e2e | 同上 | 看树 | 灰方块（aria-label「已停止」）+ 副行「已停止」 | 部分实现：toDisplayStatus → stopped（sandboxLifecycle.ts:131-134）；灰方块原语随 Q-DS-15 |
| AC-SBX-012.3 | e2e | 同上 | 点 [发起新任务] | 新建任务弹层打开、预选该项目、Agent 未选；已停止任务仍在、仍选中 | 部分实现：现状回到新建入口前先清掉选中（DR-16） |

### REQ-SBX-013 · 启动：从「启动运行环境」开始，会话从头、指令不重放 {#REQ-SBX-013}

> 状态 `未实现` · 版本 MVP · 来源 DR-03 A；P21 L78（原文「重启（开启新 agent 会话·上下文不保留·比冷建快）」）；P20 L337；P22 L80；TASK-LAUNCH L39（initial_prompt_consumed_at：重启不重放指令）；实现 sandbox.controller.ts:67-75（POST /start，受理即返回）、sandbox-application.service.ts:546-565（只接受 stopped 且有实例；同步转 starting，后台 restartSafely）、provision-sandbox.workflow.ts:303-337（restart：重新确认镜像是否在本机、重新注入全部凭证、起新会话；失败落 failed 并释放名额）、:700-707（指令只在第一次消费）、web sandboxLifecycle.ts:48-60、103-107（starting → 第 4 格，进度 80%）· 关联 REQ-LCH-012、REQ-LCH-013（四阶段与可能卡住，lch-a）· 稿件 f-sbx-stopstart-03

在已停止结果卡或任务菜单点 [启动]（名称就叫「启动」，不叫「重启」）：任务立刻转准备中（树行灰脉冲点 + 副行「准备中 · 启动运行环境」，顶栏徽标「准备中」），主区换成启动进度卡：标题「正在启动：<任务名>」，副标题「从已停止重新启动：沿用原来的代码副本，Agent 会话从头开始」，进度条 80%，四格里前三格（初始化 / 拉取镜像 / 准备代码副本）标「沿用」，当前格「启动运行环境」带「已等待 m:ss」与阶段说明，进度块下一句「原来的任务指令不会再执行一遍（上次启动时已经执行过）；启动好后回到终端。」。运行起来后回到终端（新的 Agent 会话）。停机期间镜像被清理时，这一次会和首次一样慢（要重新下载）：仍停在「启动运行环境」格，阶段说明换成下载子文案，不回退到第 2 格；「可能卡住」的规则同首次启动（REQ-LCH-013）。

**改写了哪条旧文**：P21-1 L83「[重启]」、P22 L80「[重启并开新会话]」→ [启动]（文案仍须明示会话从头开始）；P21 L78「重启 → 准备中」保留语义，改名并补「从第 4 格开始、前三格沿用」。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-SBX-013.1 | e2e | 已停止的「跑一遍示例测试」 | 点 [启动] | 发出 POST /api/sandboxes/{id}/start；树行灰脉冲点 +「准备中 · 启动运行环境」；主区进度卡前三格「沿用」、第 4 格进行中、进度 80% | 未实现：web 没有启动入口；稿件 f-sbx-stopstart-03 |
| AC-SBX-013.2 | e2e | 启动完成（running） | 看主区 | 回到终端，Agent 会话是新的；原来的指令没有再执行 | 未实现（web）；后端已实现：provision-sandbox.workflow.ts:700-707 |
| AC-SBX-013.3 | 集成 | 停机期间该镜像已被清理 | 点 [启动] | 进度停在「启动运行环境」格，阶段说明为下载子文案，不回退到「拉取镜像」 | 未实现（web）；后端：provision-sandbox.workflow.ts:322-324（imageStagedOf：停机期间镜像可能已被回收） |
| AC-SBX-013.4 | 组件 | 停止中 / 异常 / 运行中的任务 | 打开任务菜单 | 停止中 [启动] 禁用；异常与运行中没有 [启动] | 未实现；后端只接受 stopped（sandbox-application.service.ts:548-553） |

### REQ-SBX-014 · 停止 / 启动失败：转异常结果卡 {#REQ-SBX-014}

> 状态 `未实现` · 版本 MVP · 来源 plan F-SBX-STOPSTART 014；P21 L119（环境类错误附 [诊断]）；P22 L15；Q-SYS-01② A（用户拍板 2026-10-04）；实现 sandbox-application.service.ts:599-605（stop 失败：tryAdvance('failed') + 释放名额 + 抛 provider 错误码，**不写 failureCode**）、provision-sandbox.workflow.ts:331-336、716-733（start 失败：compensate → failWith 写 failureCode + 释放名额）、sandbox.entity.ts:291-295（failWith）、sandboxErrorCopy.ts:371-377（PROVIDER_UNAVAILABLE）· 稿件 f-sbx-stopstart-04

停止或启动没成功时，任务转异常：树上红点 + 副行「停止失败：<人话>」或「启动失败：<人话>」；主区为异常结果卡（REQ-SBX-001 的结构，按错误码查表），动作 [重新发起][复制诊断信息]，环境类错误另有 [运行诊断]（异常任务不能再启动，只能另建）；附注说清是在哪一步失败的、任务已转为异常不能再启动、代码副本还在、销毁时选「留下来作为成果」就不会丢。名额在这一刻释放（异常是终态）。启动失败的错误码随任务记录保存，刷新后仍在；停止失败的错误码目前只在这次 POST /stop 的错误响应里——前端用它渲染这张卡，刷新之后只能落兜底「操作没有完成」，直到后端在停止失败时也写入 failureCode（后端待办（停止 / 销毁失败时写 failureCode，见 impl-gaps））。环境类错误的范围与 [运行诊断] 的去处见 REQ-SBX-001（Q-SYS-01② A，用户拍板 2026-10-04）。

**改写了哪条旧文**：原产品文档没有停止 / 启动失败（P22 只有启动阶段与终端阶段的失败）；P22 L15「PROVIDER_UNAVAILABLE → [运行诊断]」→ 标题用现状文案「容器服务没有响应」，动作 [重新发起][运行诊断][复制诊断信息]（Q-SYS-01② A，用户拍板 2026-10-04）。

**合并说明**：环境类错误要不要带 [运行诊断]，与试点 AC-SYS-001.5（环境类错误提示带 [诊断]）是同一个问题，合并为 Q-SYS-01②；2026-10-04 用户拍板选 A（带）：环境类错误的范围与去处写在 REQ-SBX-001（AC-SBX-001.5），本条 AC-SBX-014.1 的动作已补上。（交叉引用：REQ-SYS-001、AC-SYS-001.5）

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-SBX-014.1 | e2e | 已停止任务 [启动] 时容器服务不可达 | 后台启动失败 | 树行红点 +「启动失败：容器服务没有响应」；主区卡标题「容器服务没有响应」、[重新发起][运行诊断][复制诊断信息]、附注、「诊断码：PROVIDER_UNAVAILABLE」 | 未实现（web 没有启动入口）；后端已写码：provision-sandbox.workflow.ts:331-336；稿件 f-sbx-stopstart-04 |
| AC-SBX-014.2 | e2e | 运行中任务 [停止] 时 provider.stop 抛错 | POST /stop 返回错误 | 同一张卡，副行「停止失败：…」，附注首句「这次是在 [停止] 时失败的」；错误码取自这次响应 | 未实现 |
| AC-SBX-014.3 | 集成 | 停止失败之后刷新页面 | 重新拉取任务 | 仍是异常卡；没有码时出兜底而不是空白 | 偏离（后端）：stop 失败不写 failureCode（sandbox-application.service.ts:599-605），后端待办（停止 / 销毁失败时写 failureCode，见 impl-gaps） |

### REQ-SBX-015 · 状态已变：409「现在的状态不允许做这件事」 {#REQ-SBX-015}

> 状态 `部分实现` · 版本 MVP · 来源 P22 L17（INVALID_STATE「当前状态不允许此操作」→ 自动刷新后按新状态操作）；实现 sandboxErrorCopy.ts:389-394（「现在的状态不允许做这件事」/「这个任务的状态在你操作之前已经变了。刷新一下，按新的状态再操作。」/ [刷新重试]）、sandbox-application.service.ts:548-553、586-591（start / stop 的 409 INVALID_STATE）· 稿件 无（同步操作的反馈，走 W0 轻提示，不单独出稿）

[停止] / [启动] 被后端以 409 INVALID_STATE 拒绝时（例如另一个窗口刚停掉或删掉了它），**不得**把任务标成异常：出一条中性轻提示，标题「现在的状态不允许做这件事」、正文「这个任务的状态在你操作之前已经变了。刷新一下，按新的状态再操作。」，同时立刻重新拉取这个任务，树行、主区与菜单按新状态显示。轻提示在这里是对用户刚做的同步操作的回应，不是报告异步结果。

**改写了哪条旧文**：P22 L17「⚠️ 当前状态不允许此操作」→ 现状文案；「自动刷新」写实为「立即重新拉取这个任务」。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-SBX-015.1 | 集成 | 任务已在另一个窗口被停止 | 本窗口点 [停止] | 409；中性轻提示；重新拉取后显示已停止卡；没有变成异常 | 部分实现：文案已有（sandboxErrorCopy.ts:389-394），web 没有停止调用 |
| AC-SBX-015.2 | 集成 | 任务正在停止中 | 另一个窗口点 [启动] | 409；同上提示；显示停止中 / 已停止的真实状态 | 部分实现（同上） |

## SBX · 销毁过程（F-SBX-DESTROY）

### REQ-SBX-020 · 删除中：淡出点 + 半透明，菜单只剩禁用项，移除后出树 {#REQ-SBX-020}

> 状态 `未实现` · 版本 MVP · 来源 Q-DS-15 ②A（删除中 = 淡出点 + 整行 0.5；spec/status-mapping.md:72）；D4（任意状态都能删、删除幂等）；P21 L51（destroying / destroyed：淡出动画后移除）、L77；v1 g2-11、g2-09（删除中菜单只剩一项禁用的「删除中…」）；实现 sandbox.controller.ts:97-103（DELETE，204）、sandbox-application.service.ts:720-774（同步：running → stopping → stopped → destroying → provider.destroy → 代码副本清理或保留登记 → destroyed；释放名额）、sandbox-event.projector（status_changed destroying / destroyed + sandbox.removed）、web sandboxLifecycle.ts:76、131-134（destroying 被显示成「已停止」）· 关联 REQ-LCH-014（取消并删除走同一过程）· 稿件 f-sbx-destroy-01

任务菜单的删除入口按状态写：准备中 / 可能卡住的任务是 [取消并删除…]（确认内容见 REQ-LCH-014），其余状态是 [销毁任务…]（确认见试点 P4）；两种确认点下去之后都进入本条的删除中。在确认里点 [销毁任务] / [取消并删除] 之后：树上该行立刻变成淡出点 + 整行半透明 + 副行「删除中…」（点的 aria-label「删除中」），行的主按钮不可点，「⋯」菜单只剩一项禁用的「删除中…」。导航「等待你输入」徽标、项目总览「需要你处理」与项目卡上的状态计数立刻不再算它；树组计数在行移除时才减。后端返回、`sandbox.removed` 到达后，该行移除；之后它不再出现在树、总览、⌘K 与新建弹层里。

**改写了哪条旧文**：P21 L51「（淡出）destroying / destroyed → 淡出动画后移除」保留，补删除中的菜单与计数口径；实现把 destroying 归「已停止」（sandboxLifecycle.ts:131-134）→ 删除中是单独一态。

**合并说明**：准备中任务的「取消并删除」确认（REQ-LCH-014）按「首次启动 / 重新启动」分开：重新启动的给「留下来作为成果」（Q-SBX-02，2026-10-04 用户拍板 B）。（交叉引用：REQ-LCH-014）

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-SBX-020.1 | e2e | 运行中 / 已停止 / 异常的任务 | 在销毁确认里点 [销毁任务] | 树行立刻淡出点 + 半透明 +「删除中…」；菜单只剩禁用的「删除中…」 | 未实现：web 没有销毁入口，destroying 显示成「已停止」（sandboxLifecycle.ts:76、131-134）；稿件 f-sbx-destroy-01 |
| AC-SBX-020.2 | 集成 | 删除中 | 收到 sandbox.removed | 行移除；树组计数减 1；⌘K 搜不到它 | 部分实现：后端事件已有（sandbox-event.projector）；web 没有删除流程 |
| AC-SBX-020.3 | e2e | 删除中的是等待你输入的任务 | 看导航与总览 | 「等待你输入」徽标与「需要你处理」立刻不再算它 | 未实现 |

### REQ-SBX-021 · 删的是当前任务：主区回项目总览，页内提示过程与结果 {#REQ-SBX-021}

> 状态 `未实现` · 版本 MVP · 来源 DR-16（「「X」下还没有任务。」在项目还有别的任务时不成立）；Q-DS-28 A（项目总览）；原型评审 PF-07（销毁提示是页内提示，不是整宽色带）；Q-DS-35 ①（后退到已删任务 → 找不到对象，F-WB-ROUTE）；v1 g2-11；原型 pilot/proto/proto.js destroyTask、noticeHtml · 稿件 f-sbx-destroy-01

被删的正是当前选中的任务时，主区立刻离开它、回到项目总览（全部项目），内容顶部一条页内提示（中性 .note，随内容滚动；不是全局横幅、不是轻提示）：进行中「正在销毁任务「X」…」+「完成后从左侧移除；<代码副本怎么处理>」（role="status"，转圈）；完成后换成「已销毁任务「X」」+ 结果一句 + ×——留下来作为成果：「代码副本留下来作为成果：30 天后自动清理，可在「保留下来的成果」里下载。」；一起删掉：「代码副本一起删掉了，没有留成果。」；首次启动失败的任务：「代码副本一起删掉了（没有成果可留）。」。被删的不是当前任务时，当前页不动，完成提示以浮动小卡叠在主区右上角（同 PF-07 的浮动写法）。浏览器后退到已删任务的地址时按「找不到对象」处理（回落项目总览 +「找不到任务「X」：可能已被销毁。」，REQ-WB-040 / F-WB-ROUTE），不会把它复活。

**改写了哪条旧文**：v1 g2-11「组头仍选中，主区「「acme-web」下还没有任务。」」→ 回到项目总览 + 页内提示（DR-16：同项目还有别的任务时那句不成立）；产品文档原来没写「删的是当前任务时主区去哪」。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-SBX-021.1 | e2e | 正看着「迁移构建脚本」（异常） | 销毁它 | 主区回到项目总览；顶部「正在销毁任务「迁移构建脚本」…」；完成后「已销毁任务「迁移构建脚本」」+「代码副本一起删掉了（没有成果可留）。」+ × | 未实现（web）；原型已有完成态（proto.js destroyTask）；稿件 f-sbx-destroy-01 |
| AC-SBX-021.2 | e2e | 正看着另一个任务 | 从树上销毁别的任务 | 当前页不变；完成提示叠在主区右上角 | 未实现 |
| AC-SBX-021.3 | e2e | 任务已销毁 | 浏览器后退到它的地址 | 回落项目总览 +「找不到任务「迁移构建脚本」：可能已被销毁。」 | 未实现（归 REQ-WB-040，AC-WB-040.1） |

### REQ-SBX-022 · 销毁失败与保留期 {#REQ-SBX-022}

> 状态 `未实现` · 版本 MVP · 来源 D4（删除幂等）；plan「不做」清单（销毁时选保留期不在本轮）；Q-SBX-02 B（用户拍板 2026-10-04：只有首次启动阶段失败不给「留下来作为成果」）；实现 sandbox-application.service.ts:767-772（失败：tryAdvance('failed') + 释放名额 + 抛错，不写 failureCode）、api/packages/contracts/src/schemas/sandbox.schema.ts:114-116（DestroySandboxSchema 只有 keepVolume）、api/packages/modules/project/src/application/retained-volume.service.ts:28（DEFAULT_RETENTION_DAYS = 30）· 稿件 f-sbx-destroy-02（W4 补稿；失败卡同 f-sbx-stopstart-04 的结构）、f-sbx-destroy-03（异常任务的销毁确认，随 Q-SBX-02 B 补）

销毁没成功（provider.destroy 抛错）时，任务转异常、名额释放：树行回到红点并写「删除失败：<人话>」，主区（若它是当前任务）显示异常结果卡（REQ-SBX-001），动作 [销毁任务…]（再试一次；删除幂等）+ [复制诊断信息]（环境类错误另有 [运行诊断]，REQ-SBX-001），建议句写「起来之后再销毁一次」，附注说清是在销毁时失败的、名额已释放、可以放心再试（f-sbx-destroy-02）。销毁的正是当时看着的任务时，主区已按 REQ-SBX-021 回到项目总览：那条「正在销毁任务「X」…」页内提示换成「没能销毁任务「X」」+「<原因>。任务已转为异常，名额已释放；在左侧点开它可以再试一次。」+ ×（中性页内提示，只有圆叉带失败色调；W4 补稿时补的口径）。保留期固定 30 天：销毁确认只问「留下来作为成果 / 一起删掉」，不问天数（DELETE 只收 keepVolume）。错误码的去留同 REQ-SBX-014（后端在销毁失败时也不写 failureCode，后端待办（停止 / 销毁失败时写 failureCode，见 impl-gaps））。异常任务的销毁确认：只有首次启动阶段失败的任务不给「留下来作为成果」（Agent 还没开始干活，只写「一起删掉（没有成果可留）」）；其余异常任务——停止失败、从已停止重新启动时失败、上一次销毁失败的——都给二选一，默认选中「留下来」（Q-SBX-02 B，用户拍板 2026-10-04）。

**改写了哪条旧文**：P20 L331-334、P21-1 L145 的「☐ 保留工作区卷（默认勾选）」→ 二选一单选「留下来作为成果（默认；30 天后自动清理）/ 一起删掉」（试点 P4 已是这样）；保留期 3 / 7 / 30 天可选不在本轮；确认里的「工作目录怎么处理」→「代码副本怎么处理」（Q-SBX-03 A，用户拍板 2026-10-04）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-SBX-022.1 | 集成 | DELETE 时 provider.destroy 抛错 | 请求返回错误 | 任务转异常（红点、「删除失败：…」）；名额已释放；主区异常卡带 [销毁任务…][复制诊断信息] | 未实现（web）；后端落 failed 但不写 failureCode（sandbox-application.service.ts:767-772） |
| AC-SBX-022.3 | e2e | 正看着「跑一遍示例测试」时销毁它，provider.destroy 抛错 | 请求返回错误 | 总览顶部那条「正在销毁…」换成「没能销毁任务「跑一遍示例测试」」+ 原因与去处一句 + ×；树行红点 +「删除失败：容器服务没有响应」；点开它是 AC-SBX-022.1 的结果卡 | 未实现（web）；原型已按稿件 f-sbx-destroy-02 演示（场景「下一次销毁：失败」） |
| AC-SBX-022.2 | e2e | 打开运行中或已停止任务的销毁确认 | 看「代码副本怎么处理」 | 只有「留下来作为成果（默认；30 天后自动清理，可在「保留下来的成果」里下载）」与「一起删掉，不留成果」，没有天数选择 | 未实现（web）；试点 P4 与原型已是这样 |
| AC-SBX-022.4 | e2e | 异常任务「跑一遍示例测试」（从已停止 [启动] 时失败）与「迁移构建脚本」（首次启动拉镜像失败） | 分别打开销毁确认 | 前者「代码副本怎么处理」二选一、默认选中「留下来作为成果」；后者只写「一起删掉（没有成果可留）」、没有选项 | 未实现：web 没有销毁界面；后端已有：keepVolume 对异常任务同样生效（sandbox-application.service.ts:720-760），原型已按此演示（稿件 f-sbx-destroy-03） |

## SBX · 无头任务（F-SBX-HEADLESS）

### REQ-SBX-030 · 无头任务只由自动化（与 MCP）发起；入口是运行详情 [打开任务]；能看出来自哪条规则 {#REQ-SBX-030}

> 状态 `部分实现` · 版本 v1.1 · 来源 DR-01 A（新建弹层暂不加无头选项）；LIVE-RUN L-8（docs/LIVE-RUN-FINDINGS.md:248-275：界面上两个东西都叫「任务」）；TASK-LAUNCH T-4；P20 L15、L116（「模式：◉ 交互式终端 ○ 无头任务」）；P21-7 L10（「触发产生的 Task 在工作台列表用 [自动] 标签区分，详情可溯源到规则」，aut 组移交）、L64；实现 SandboxTerminalContainer.tsx:318-331（新建请求不带 headless）、web/src/views/project/RunHistoryItem.view.tsx:157-171（[打开任务] +「这是自动跑的任务，右侧只能看输出，不能敲命令。」）、sandbox.schema.ts（SandboxDto.headless）· 关联 REQ-AUT-023（运行详情与 [打开任务]：只在任务还在时出现，F-AUT-RULES）· 稿件 f-sbx-headless-01（树里的行）

无头任务是自动化规则（或上层 Agent 经 MCP）发起的任务：不开终端，把指令交给 Agent 一口气跑完，输出与产物在平台里回收。它在树上和其它任务并列，用同样的状态点与副行。工作台的新建任务弹层**不**提供「无头」选项（等真有自动化之外手动发无头任务的需要再加）。进入方式：树里点它，或自动化规则运行详情里的 [打开任务]。界面用词：「任务」只指树上的一行（一个运行环境）；运行环境里先后跑的每一轮叫「无头运行」（REQ-SBX-035）。自动化触发的任务**应当**能被认出来、能回到来源规则（P21-7 L10：树行带「自动」标签，详情可回到规则）——现状 SandboxDto 不带来源规则，本轮稿件也没画（v1 同样没有）；口径保留，等后端回显来源规则（或先以 headless 近似「自动」）后补稿，见待定 Q-SBX-06。

**改写了哪条旧文**：P20 L15 / L116、P21-7 把「无头」当成新建时与交互式二选一的「模式」→ 只由自动化 / MCP 发起，新建弹层不提供；LIVE-RUN L-8 的两个「任务」→「任务」与「无头运行」两个词；plan 与示例世界写的 [打开 Task] → 现状按钮名「打开任务」。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-SBX-030.1 | 组件 | 打开新建任务弹层 | 看字段 | 没有「交互式 / 无头」选项与超时档 | 已实现：请求体不带 headless（SandboxTerminalContainer.tsx:318-331） |
| AC-SBX-030.2 | e2e | 自动化规则「每天凌晨跑一遍回归」有一次运行 #12 | 在运行详情点 [打开任务] | 工作台选中「每天凌晨跑一遍回归 #12」 | 已实现：RunHistoryItem.view.tsx:157-171（主区布局见 REQ-SBX-031） |
| AC-SBX-030.3 | 组件 | 树上「每天凌晨跑一遍回归 #12」由规则「每天凌晨跑一遍回归」触发 | 看树行与主区 | 树行能看出来自自动化（「自动」标签）；主区能回到来源规则 | 未实现：SandboxDto 不带来源规则（sandbox.schema.ts:178-275），web 没有标签；稿件未画（待定 Q-SBX-06） |

### REQ-SBX-031 · 主区只放只读输出：不挂终端标签、不自动连 Agent {#REQ-SBX-031}

> 状态 `偏离` · 版本 v1.1 · 来源 DR-01 A；P21-1 L70（只读输出面板：等宽、保留换行不自动折行、横向滚动）；P21-7 L64；BACKLOG DR-01 核实（打开 Agent 标签会在同一运行环境里另起一个没有指令的交互 Agent：api terminal-session.service.ts:287-309）；实现 SandboxLifecycleContainer.tsx:77-96（running 分支先挂终端标签栏、再挂无头面板）、web/src/views/task/TaskOutputPane.view.tsx:104-108（工具调用状态）、:183（结果还没回来）、:204-206（通道错误诊断码，10px）、:390-440、:480（回放中 / 过长 / 空 / 回到底部）、web/src/lib/task/taskOutcome.ts:108-113（通道错误人话）· 稿件 f-sbx-headless-01

选中无头任务时，主区**只**放只读输出：顶部一条输出栏（左「任务输出」+「只读」徽标；右侧剩余时间与动作），下面是输出流。**不得**挂终端标签栏，也**不得**自动连 Agent 会话（打开 Agent 标签会在同一运行环境里另起一个没有指令、却共用凭证与代码副本的交互 Agent）。输出流：等宽、保留换行不自动折行、超长行横向滚动；Agent 的正文消息用正文色；工具调用折叠成一行（「工具调用：」+ 工具名 + 状态「已完成（退出码 N）」/「失败（退出码 N）」/「运行中…」；没有退出码就不写），展开看入参与输出，结果没回来时写「结果还没回来（完成事件到达后会就地补上，不会另起一条）。」；事件通道的错误帧一行失败色 + 下一行 12px「诊断码：X」；整段一个 role="log"（逐条 alert 会刷屏）。其它情况如实说：还没有输出「任务已发起，等待第一批输出…」、正在回放「正在回放已有输出…」、输出过长「输出过长：前 N 条已省略，下方只保留最近的部分。」、往上翻时有新输出 [回到底部（有新输出）]。

**改写了哪条旧文**：P21-1 L70「exit code + 最后 100 行日志（倒序）+ [查看完整日志] / [下载]」→ 整段输出流（过长才省略前面）+ 结果区（REQ-SBX-034），[查看完整日志] 本轮不做（实现没有）；现状「上半终端、下半输出」→ 只放输出（DR-01 A）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-SBX-031.1 | e2e | 选中运行中的无头任务 | 看主区 | 只有输出栏与输出流；没有 Agent / 终端标签栏 | 偏离：上半终端标签、下半输出面板（SandboxLifecycleContainer.tsx:77-96）；稿件 f-sbx-headless-01 |
| AC-SBX-031.2 | 组件 | 输出里有一行 300 字符的命令 | 渲染 | 不折行，输出区可以横向滚动 | 已实现：TaskOutputPane.view.tsx:426-428（whitespace-pre + overflow-auto） |
| AC-SBX-031.3 | 组件 | 收到通道错误帧 REPLAY_FAILED | 渲染 | 一行失败色「历史输出回放失败，下方内容可能不完整；重连或刷新可以再试一次。」+ 下一行 12px「诊断码：REPLAY_FAILED」 | 部分实现：文案与码已有（taskOutcome.ts:108-113，TaskOutputPane.view.tsx:204-206），码是 10px |
| AC-SBX-031.4 | 组件 | 某个工具调用还没有完成事件 | 展开它 | 显示入参与「结果还没回来（…）」；完成事件到达后就地补上结果，不新增一行 | 已实现：TaskOutputPane.view.tsx:104-108、183 |

### REQ-SBX-032 · 剩余时间与终止：行内确认、两阶段强杀 {#REQ-SBX-032}

> 状态 `部分实现` · 版本 v1.1 · 来源 P20 L15（硬超时 30min / 1h / 2h / 4h，超时转失败）；P22 L73；Q-DS-17（删数据才走统一破坏性确认；终止本轮运行用行内确认，gap/drafts/README §5.8）；Q-DS-21 A / DR-35（退役词「预算」）；v1 g2-12、g2-15；实现 HeadlessTaskContainer.tsx:56（默认 120 分钟）、:61（「终止任务失败，任务可能仍在运行」）、:70-85（倒计时）、:134、:238（确认按任务收口）、:245（还焦点）、:288-298（确认 → cancel）、TaskOutputPane.view.tsx:259-321（CancelControl：按钮 → 确认（autoFocus、Esc 撤销、role="alert"）→「正在终止…（两阶段强杀）」）、taskOutcome.ts:276-297（「还剩 X」/ 超时句）、agent-task.controller.ts:77-79（POST …/cancel：SIGTERM → 5s → SIGKILL）· 稿件 f-sbx-headless-01、f-sbx-headless-05

运行中，输出栏右侧显示剩余时间「还剩 X 小时 Y 分」（按开始时间与硬超时档算，随时间更新；拿不到开始时间时写「任务运行中」）与 [终止任务]（secondary）。点 [终止任务] → 同一位置就地换成行内确认：「终止后本轮无法恢复，确定？」（role="alert"）+ [确认终止] + [取消]，焦点落在 [确认终止]；Esc 或 [取消] 换回 [终止任务] 并把焦点还给它。确认后换成「正在终止…（两阶段强杀）」（先 SIGTERM，5 秒后 SIGKILL），本轮结束后出结果区（标题「任务被终止」，REQ-SBX-034）。终止请求失败时输出栏下一句失败提示「终止任务失败，任务可能仍在运行」。超过硬超时仍未结束时，剩余时间的位置写「已超过硬超时上限，平台正在强制终止…」（琥珀色）。终止只结束本轮运行、不删任务也不删数据，所以用行内确认，不进统一破坏性确认弹层。确认状态只属于发起它的那一轮：那一轮自己跑完了，确认随之消失，不会出现在下一轮上。

**改写了哪条旧文**：现状超时句「已超过硬超时预算，平台正在强制终止…」（taskOutcome.ts:292）→「上限」（Q-DS-21 A 退役「预算」）；P22 L73「无头 Task 超时…[重新发起] + [更改超时]」→ 结果区与发起表单（REQ-SBX-034、035）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-SBX-032.1 | 组件 | 运行中，超时档 120 分钟，已跑 37 分钟 | 渲染输出栏 | 「还剩 1 小时 23 分」+ [终止任务] | 已实现：HeadlessTaskContainer.tsx:70-85，taskOutcome.ts:297；稿件 f-sbx-headless-01 |
| AC-SBX-032.2 | 组件 | 同上 | 点 [终止任务]，再按 Esc | 先出现行内确认、焦点在 [确认终止]；Esc 后换回 [终止任务] 且焦点回到它 | 已实现：TaskOutputPane.view.tsx:269-310，HeadlessTaskContainer.tsx:245；稿件 f-sbx-headless-05 |
| AC-SBX-032.3 | 集成 | 行内确认中 | 点 [确认终止] | 发出 POST …/tasks/{taskId}/cancel（202）；显示「正在终止…（两阶段强杀）」；收到结束帧（killed）后出结果区「任务被终止」 | 已实现：HeadlessTaskContainer.tsx:288-298，TaskOutputPane.view.tsx:266-268 |
| AC-SBX-032.4 | 组件 | 已超过硬超时仍未结束 | 渲染输出栏 | 「已超过硬超时上限，平台正在强制终止…」，琥珀色 | 偏离：现状写「预算」（taskOutcome.ts:292） |
| AC-SBX-032.5 | 组件 | 第 1 轮的行内确认没点，这一轮自己跑完；随后发起第 2 轮 | 看第 2 轮的输出栏 | 显示 [终止任务]，不是残留的确认 | 已实现：HeadlessTaskContainer.tsx:134、238（按 taskId 收口） |

### REQ-SBX-033 · 事件流断线：如实说、自动重连、按序号续，不重复不丢 {#REQ-SBX-033}

> 状态 `已实现` · 版本 v1.1 · 来源 FE2（实时通道断线如实提示）；D4；v1 g2-13、g2-13b；实现 TaskOutputPane.view.tsx:211-257（ConnectionNote：连接中 / 重连中（第 N 次）/ 已断开 + [重新连接]）、HeadlessTaskContainer.tsx:186-195（DTO 已终结时不显示倒计时与终止）、:424（重连不清空已渲染输出，按 fromSeq 续订）、web/src/services/ws/taskSocket.ts:50（自动重连上限 8 次）· 稿件 f-sbx-headless-02、f-sbx-headless-03

无头输出的事件流（WS /tasks）断线时，自动重连期间输出栏下一条警示连接条「正在重连事件流…（第 N 次）；重连后会从上次序号继续，不会重复也不会丢」（role="status"）；自动重连次数用完后换成失败连接条「事件流已断开，已停止自动重连；输出停止更新。（已收到的输出会保留，只补缺的那一截）」+ 行尾 [重新连接]（role="alert"）。已收到的输出始终保留；重连从上次收到的序号继续订阅，补上缺的那一截，不重复、不丢。断线期间任务本身照常跑：剩余时间与 [终止任务] 按任务状态显示；任务记录已经是终态、结束帧还没到时，不再显示倒计时与终止，改为「任务已结束，正在取回本次结果…」。第一次连接时写「正在连接事件流…」。

**改写了哪条旧文**：原产品文档没有写无头输出的断线（P22 L79 只写了终端 WS 断线）；按实现补齐。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-SBX-033.1 | 集成 | 输出流断线，自动重连第 2 次中 | 看主区 | 警示连接条「正在重连事件流…（第 2 次）；…」；已收到的输出原样保留；剩余时间与 [终止任务] 还在 | 已实现：TaskOutputPane.view.tsx:224-230；稿件 f-sbx-headless-02 |
| AC-SBX-033.2 | 集成 | 自动重连 8 次都失败 | 看主区 | 失败连接条 + [重新连接]；输出停在断开时 | 已实现：TaskOutputPane.view.tsx:231-250，taskSocket.ts:50；稿件 f-sbx-headless-03 |
| AC-SBX-033.3 | 集成 | 已断开，期间产生了序号 41–57 的事件 | 点 [重新连接] | 从 41 起补齐；原有 1–40 不重复出现 | 已实现：按 fromSeq 续订（HeadlessTaskContainer.tsx:424 与 useTaskStream） |
| AC-SBX-033.4 | 集成 | 任务记录已是 succeeded，WS 连不上 | 刷新后打开 | 不显示倒计时与 [终止任务]；显示「任务已结束，正在取回本次结果…」 | 已实现：HeadlessTaskContainer.tsx:186-195，TaskOutputPane.view.tsx:390-396 |

### REQ-SBX-034 · 本轮结果：结论、退出码、建议、产物、诊断码 {#REQ-SBX-034}

> 状态 `部分实现` · 版本 v1.1 · 来源 P21-1 L70（exit code + [下载]）；P21-7 L64；P22 L73（无头超时 → 失败）；DR-34（诊断码单列一行 12px）；DR-18（运行结束不收尾，sev2）；Q-DS-20 A（禁 10px）；v1 g2-14；实现 web/src/views/task/TaskOutcome.view.tsx（终态卡；退出码 :68；[下载] / 下载中… :84-94；续接 :110-136；诊断码 10px :139）、taskOutcome.ts:145-215（标题表、退出码缺席「未知（进程被信号终止，没有退出码）」、建议拼法）、agent-task.controller.ts:97-99（GET …/artifacts/{name}）· 稿件 f-sbx-headless-04

本轮无头运行结束（成功 / 失败 / 被终止 / 超时）后，输出栏不再显示剩余时间与 [终止任务]，输出流停在末尾，下面接结果区（不是弹层，输出仍可上翻）：结论标题（「任务完成（退出码 0）」「任务失败」「任务被终止」「任务超时，已被强制终止」，按结论着色）+「退出码：N」——拿不到退出码时写「未知（进程被信号终止，没有退出码）」，**不得**当成 0——+ 建议（按结论与错误码查表；非 0 退出补「CLI 以退出码 N 结束。」；超时建议调大超时档后重跑）+ 产物列表（文件名 · 大小 · 时间 + [下载]；下载中按钮写「下载中…」、其余 [下载] 暂不可点；没有产物时不出这一节）+ 续接动作（REQ-SBX-035）+ 有错误码时一行 12px「诊断码：X」。本轮结束不改变任务（运行环境）的状态：树行与顶栏仍是运行中、仍占名额，直到自动化收尾（DR-18）落地。

**改写了哪条旧文**：P21-1 L70「最后 100 行日志 + [查看完整日志] / [下载]」→ 整段输出 + 产物逐个下载；P21-7 L146、L174「完成后 sandbox 自动销毁、卷保留 24h」→ 现状不收尾（DR-18，后端改好后保留天数取规则上的 3 / 7 / 30）；plan 原写「退出码缺席写『—』」→ 结果区写人话「未知（…没有退出码）」，只读详情里写「—」（HeadlessTaskDetail.view.tsx:111）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-SBX-034.1 | 组件 | 本轮 failed、exitCode=1、errorCode=TASK_FAILED、2 个产物 | 渲染结果区 | 「任务失败」+「退出码：1」+「任务以失败告终（CLI 非零退出或运行途中报错）。可以看上方输出定位原因后重跑。 CLI 以退出码 1 结束。」+ 两行产物带 [下载] +「诊断码：TASK_FAILED」（12px） | 部分实现：除诊断码字号外已实现（现状 10px，TaskOutcome.view.tsx:139）；稿件 f-sbx-headless-04 |
| AC-SBX-034.2 | 单元 | 本轮被信号终止，exitCode 缺席 | 取结论 | 退出码「未知（进程被信号终止，没有退出码）」；建议含「已按非零退出处理」；不出现 0 | 已实现：taskOutcome.ts:184-200 |
| AC-SBX-034.3 | 组件 | 正在下载 regression-report.html | 看产物列表 | 该行按钮「下载中…」，其余 [下载] 暂不可点 | 已实现：TaskOutcome.view.tsx:84-94 |
| AC-SBX-034.4 | e2e | 本轮已结束 | 看树与顶栏 | 仍是运行中；不出现「已停止」「删除中」 | 已实现（现状不收尾）；待 DR-18 |

### REQ-SBX-035 · 续接与下一轮：同一运行环境里再跑一轮 {#REQ-SBX-035}

> 状态 `实现先行` · 版本 v1.1 · 来源 LIVE-RUN L-8（运行环境里的下一次运行，与侧栏新建的任务不是一回事）；v1 g2-14；实现 TaskOutcome.view.tsx:110-136（[接着聊（续接这轮会话）]，没有会话引用时禁用并说明；[发起全新任务]）、HeadlessTaskContainer.tsx:300-317（handleResume 带上 sessionRef；handleNewTask 不带；都打开同一运行环境里的发起表单）、:319-333、:369（只读详情与收起表单）、web/src/views/task/HeadlessTaskLauncher.view.tsx:192（提交按钮「发起无头任务」/「接着跑（续接会话）」）、HeadlessTaskDetail.view.tsx:86、146（「只读；同一个运行环境里可以跑多次无头运行」、[发起无头运行]）· 稿件 f-sbx-headless-04（入口）、f-sbx-headless-06（发起表单，W4 补稿）

结果区的两个续接动作都在**同一个运行环境**里再跑一轮，不新建任务：[接着聊（续接这轮会话）]（secondary）带上本轮的会话引用，打开发起表单（提交按钮写「接着跑（续接会话）」）；本轮没拿到会话引用时这个按钮禁用，下面一句「这轮没有拿到会话引用（CLI 未上报 session-started），无法续接；可以发起一轮全新任务。」。[发起全新任务]（tertiary）打开同一个发起表单，不带会话引用。发起表单可以收起，回到只读详情（最近一轮的指令、状态、耗时、产物、退出码 + [发起无头运行]）。树上的任务不变；新一轮从输出栏重新开始计时。这是一个运行环境里先后跑多轮无头运行的唯一入口（工作台的新建任务弹层不提供无头，REQ-SBX-030）。

**改写了哪条旧文**：原产品文档没有「同一运行环境里再跑一轮」与「续接会话」（P20 / P21-7 只写了一次运行）；LIVE-RUN L-8 已把面板里的入口改名 [发起无头运行]，结果区的 [发起全新任务] 仍与侧栏「新任务」同名不同物（待定 Q-SBX-04）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-SBX-035.1 | 组件 | 本轮结束，有会话引用 | 点 [接着聊（续接这轮会话）] | 结果区换成发起表单，提交按钮「接着跑（续接会话）」；树上没有新任务 | 已实现：HeadlessTaskContainer.tsx:300-308，HeadlessTaskLauncher.view.tsx:192 |
| AC-SBX-035.2 | 组件 | 本轮结束，没有会话引用 | 渲染结果区 | [接着聊] 禁用，下面一句「这轮没有拿到会话引用（…）」 | 已实现：TaskOutcome.view.tsx:110-136 |
| AC-SBX-035.3 | 组件 | 本轮结束 | 点 [发起全新任务] | 打开同一个发起表单、不带会话引用；可以收起回到只读详情 | 已实现：HeadlessTaskContainer.tsx:310-333 |

---

## 附录 A · 改写对照（逐条，来自各片段）

### 改写对照（旧文 → 本片）（lch-b）

| 旧文 | 位置 | 改写为 | 依据 |
|---|---|---|---|
| P22 L11 IMAGE_PULL_FAILED「❌ 镜像拉取失败」→ [重试] / [检查镜像地址] | REQ-SBX-001、003、004 | 标题用现行人话；[重新发起]；[检查镜像地址] 去镜像管理 + 来源提示 | DR-02 A、DR-16 |
| P22 L15 PROVIDER_UNAVAILABLE「🔴 运行时无响应（容器服务未启动？）」→ [运行诊断] | REQ-SBX-001、014 | 「容器服务没有响应」+ [重新发起][运行诊断][复制诊断信息]；环境类错误都带诊断入口 | Q-SYS-01② A（用户拍板 2026-10-04）；sandboxErrorCopy.ts:371-377 |
| P22 L16 TIMEOUT「⏱️ 操作超时」→ [重试] / [强制停止] | REQ-SBX-002 | 「超时未响应：…」超时色；[重新发起]；删 [强制停止] | Q-DS-21 A、UX-DS-102 |
| P22 L17 INVALID_STATE「⚠️ 当前状态不允许此操作」 | REQ-SBX-015 | 现行文案 + 立即重新拉取 | 实现 |
| P22 L24 原则「人话 + 按钮，禁止裸抛错误码」 | REQ-SBX-001 | 保留；码单列一行 12px | DR-34 |
| P22 L68、P21-2 L159 / L192 / L207、P20 L393-394「[重试]（仅失败阶段）」 | REQ-SBX-003 | [重新发起] = 另建一个任务 | DR-02 A；后端无重试接口 |
| P20 L140「阶段进度卡就地变红 + [重试]」 | REQ-SBX-001、003 | 换结果卡 + [重新发起] | DR-02 A |
| P22 L80「[重启并开新会话]」 | REQ-SBX-013 | [启动]，文案明示会话从头 | DR-03 A |
| P22 L84 兜底「操作失败（错误码 XXX）[重试] [运行诊断]」 | REQ-SBX-001 | 「操作没有完成」+ 诊断码行 | P22 L24、DR-34 |
| P20 L327-337「Stop：资源立即释放… 30 天自动过期」 | REQ-SBX-010 | 停止 = 暂停：占名额、不过期 | DR-03 A |
| P21-1 L69「卷保留中（还需 X 天）」 | REQ-SBX-010、012 | 删除倒计时 | DR-03 A |
| P21-1 L71「全部已暂停：选择一个任务并点[重启]继续」 | REQ-SBX-012 | 删除 | 每张已停止卡上都有 [启动] |
| P21-1 L83 右键菜单「[重启] [Stop] [销毁] [改名]」 | REQ-SBX-010、012、013、020 | [停止] / [启动] / [销毁任务…]；[改名] 不做 | D4、DR-03 A、v1 g2-09 |
| P21-1 L145「Stop / 销毁一律二次确认」 | REQ-SBX-010 | 只有销毁确认 | v1 g2-08 |
| P21 L49「⏸️ 已暂停 = idle / stopping / stopped」 | REQ-SBX-011、012 | idle → 运行中；stopping / stopped → 已停止 | Q-DS-15 ①A |
| P21 L50「异常：重试 / 销毁」 | REQ-SBX-003 | 重新发起 / 销毁 | DR-02 A |
| P21 L51「（淡出）destroying / destroyed」 | REQ-SBX-020 | 保留 + 删除中的菜单与计数 | Q-DS-15 ②A |
| P21 L78「重启 → 准备中」 | REQ-SBX-013 | [启动] → 准备中，从第 4 格开始 | DR-03 A |
| P20 L331-334、P21-1 L145「☐ 保留工作区卷（默认勾选）」 | REQ-SBX-022 | 二选一单选，保留期固定 30 天；异常任务除首次启动失败外都给、默认留下来 | 试点 P4、plan「不做」；Q-SBX-02 B（用户拍板 2026-10-04） |
| DR-16「[重新发起] 预填 Agent 和分支」 | REQ-SBX-003 | 预填项目、Agent 与镜像；分支等后端回显 | Q-LCH-03 B（用户拍板 2026-10-04） |
| P20 L15、L116「无头是新建时的模式」 | REQ-SBX-030 | 只由自动化 / MCP 发起 | DR-01 A |
| P21-1 L70「最后 100 行 + [查看完整日志] / [下载]」 | REQ-SBX-031、034 | 整段输出流 + 产物下载；[查看完整日志] 不做 | 实现 |
| P21-7 L64「只读输出流 + [查看完整日志] [导出日志]」 | REQ-SBX-031 | 同上 | DR-01 A |
| P21-7 L146、L174「完成后 sandbox 自动销毁、卷保留 24h」 | REQ-SBX-034 | 现状不收尾；后端改好后按规则保留天数 | DR-18 |
| P22 L73「无头超时…[重新发起] + [更改超时]」 | REQ-SBX-034、035 | 结果区 + 同一运行环境里的发起表单（含超时档） | 实现 |
| P21-7 L10「触发产生的 Task 用 [自动] 标签区分，详情可溯源到规则」 | REQ-SBX-030 | 保留口径；本轮未画，待后端回显来源规则 | aut 组移交（aut.md 改写对照） |
| LIVE-RUN L-8 两个「任务」 | REQ-SBX-030、035 | 「任务」= 树上一行；「无头运行」= 运行环境里的一轮 | LIVE-RUN |
| sandboxErrorCopy.ts:509-517 SANDBOX_ENDED_COPY「运行环境已经回收了」 | REQ-SBX-012 | 真实语义 + [启动] | DR-03 A |
| sandboxErrorCopy.ts:357 资源不够「停掉几个不用的任务」 | REQ-LCH-007（lch-a） | 已停止也占名额，要销毁才能腾出 | DR-03 A |
| SandboxOutcome.view.tsx:6-10 码一个都不上屏 | REQ-SBX-001 | 码单列一行 | DR-34 |
| taskOutcome.ts:292「已超过硬超时预算…」 | REQ-SBX-032 | 「上限」 | Q-DS-21 A |
| TaskOutcome.view.tsx:139、TaskOutputPane.view.tsx:204-206 诊断码 10px | REQ-SBX-031、034 | 12px | DR-34、Q-DS-20 A |
| plan「IMAGE_PULL_FAILED / INVALID_IMAGE_REFERENCE → 去镜像管理」 | REQ-SBX-004 | INVALID_IMAGE_REFERENCE 是同步拒绝，不走结果卡 | sandbox-failure-codes.ts |
| plan「退出码缺席写『—』」 | REQ-SBX-034 | 结果区写人话，只读详情写「—」 | taskOutcome.ts:187 |

## 附录 B · 片段里的默认决定与待确认（原文）

> 下面是各片段的原文，编号仍是片段里的本地编号；统一编号与完整的选项、推荐、默认在 [open-questions.md](./open-questions.md)，对照见其 §7。

### 本片的默认决定与待确认（lch-b）

编号与 notes/lch-b.md「待定」同号（稿件头注释引用的「待定 ③」即下面 ③）。

1. **① 环境类错误卡要不要带 [运行诊断]**：P21 L119（环境类错误附 [诊断]）、P22 L15、format-pilot AC-SYS-001.5 都要求；plan REQ-SBX-014 只列 [重新发起][复制诊断信息]，稿件 f-sbx-stopstart-04 按 plan 画。建议加（第三个动作 tertiary，去系统状态并自动跑一轮诊断），等拍板；选「加」时 AC-SBX-014.1 的动作补上即可。**已拍板（2026-10-04，用户原话「补全 10 条按推荐」）：选 A（加）**——环境类码（PROVIDER_UNAVAILABLE、DISK_INSUFFICIENT）的结果卡带 [运行诊断]，写进 REQ-SBX-001（AC-SBX-001.5）、AC-SBX-014.1 与 REQ-SBX-022。
2. **② 超时卡的秒数**：TIMEOUT 失败只带 failureCode / failureMessage，后端没有与之对应的时长字段；稿件 f-sbx-relaunch-02 的「600 秒」是 v1 示例值。本片口径：拿不到时长时不写数字（AC-SBX-002.1）；要写数字需后端随失败给出时长。
3. **③ 异常任务的销毁确认给不给「留下来作为成果」**：后端 keepVolume 对 failed 同样生效（sandbox-application.service.ts:720-760）；原型与试点对异常任务一律不给（理由「Agent 还没开始干活」只对启动阶段失败成立）。停止失败、重新启动失败的任务代码副本里可能有成果——稿件 f-sbx-stopstart-04 的附注「销毁时选「留下来作为成果」就不会丢」依赖本条。建议：只有「启动阶段（首次启动）失败」不给，其余异常任务给，默认仍是「留下来」。同理，从已停止重新启动、还在准备中的任务被 [取消并删除…]（REQ-LCH-014）时，也不能套用「Agent 还没开始干活」那句，要给「留下来」——请 lch-a 在 REQ-LCH-014 里按「首次启动 / 重新启动」分开写。**已拍板（2026-10-04）：选 B**（与本条建议相同），REQ-SBX-022（AC-SBX-022.4）与 REQ-LCH-014（AC-LCH-014.4）已按此写。
4. **④ 停止 / 销毁失败时写 failureCode（后端）**：现状只有启动链路写码（provision-sandbox.workflow.ts:716-733）；stop / destroy 的 catch 只把状态推到 failed（sandbox-application.service.ts:599-605、767-772），刷新后码就丢了。建议后端改用 failWith(code)；前端在此之前用同步响应里的码（AC-SBX-014.2）。
5. **⑤ 术语「代码副本」与「工作目录」并存**：启动 / 停止语境用「代码副本」（sandboxErrorCopy.ts:18 的上屏规则「工作区 → 代码副本」、DR-03 A 原句），销毁确认、保留下来的成果用「工作目录」（试点 P4、原型、RetainedVolumesPanel.view.tsx）。本片按各自语境沿用，统一用词待 Q-DS-21 同类裁决。**已拍板（2026-10-04）：统一为「代码副本」**（Q-SBX-03 A），本片的销毁确认、页内提示与菜单说明已改；`keepVolume`、`workspace` 这类代码标识符不改。
6. **⑥ 无头结果区 [发起全新任务] 的名字**：它在同一运行环境里再跑一轮，和侧栏「新任务」（新建一个任务）同名不同物，正是 LIVE-RUN L-8 的病；建议改「再跑一轮」或「发起无头运行」（与只读详情一致）。本轮按 v1 / 现状保留。
7. **⑦ 产物时间写后端 ISO 原串**（稿件 f-sbx-headless-04 第 9 条）：没有改的依据，照现状；建议改成本地时间（同 Q-DS-35 一类小口径）。
8. **⑧ 同一运行环境里的发起表单没有 v2 稿**：[接着聊] / [发起全新任务] 打开的发起表单（HeadlessTaskLauncher.view）与只读详情（HeadlessTaskDetail.view）本轮没有出稿；接线时先照现状结构画，下一轮补稿。
9. **⑨ 编号撞号**：SP/final/04-示例用例.md 与 test-plan 里已有 REQ-SBX-010 / 020 / 030 / 040 / 050（拟），指后端生命周期不变量（转移表、DELETE 幂等、provision 中删除、崩溃收敛等）；本片按 plan lanes[].req_ranges 用了 001–039。合并 SBX.md 时需要把 04 的拟号整体后移（例如从 REQ-SBX-050 起）。
10. **⑩ 自动化任务的「自动」标签与回到规则**（P21-7 L10，aut 组移交）：现状 SandboxDto 不带来源规则，web 没有标签，v1 / v2 稿都没画。建议后端在 SandboxDto 回显 `automationId`（与规则名）后，树行加中性徽标「自动」、输出栏加「来自规则「X」」链接；在那之前可以先用 headless 近似「自动」（无头任务今天只由自动化或 MCP 建）。
11. **本片默认（不另问）**：[重新发起] 关掉弹层不发起时主区回到原任务的结果卡（AC-SBX-003.3）；原任务的 Agent 不可用时仍预选、交给凭证闸门（AC-SBX-003.4）；来源提示只属于这一次跳转（REQ-SBX-004）；AUTH_REJECTED 的去处是凭证管理，标题与建议待凭证组（F-CRD-*）给词；销毁失败卡的动作是 [销毁任务…] 而不是 [重新发起]（REQ-SBX-022）；409 INVALID_STATE 用中性轻提示（REQ-SBX-015）。

## 附录 E · 合并时改动的地方

合并只做了下面这些改动；其余文字都是片段原文（本地待定编号已换成统一编号）。

| 需求 | 改动 | 为什么 |
|---|---|---|
| [REQ-SBX-005](#REQ-SBX-005) | 改状态 | 非 HTTPS 下失败提示出不来（据代码更正） |
| [REQ-SBX-005](#REQ-SBX-005) | 改写一句 | AC-SBX-005.2 由「已实现」更正为「部分实现」 |
| [REQ-SBX-005](#REQ-SBX-005) | 加合并说明 | 与 AC-WB-063.4 统一 |
| [REQ-SBX-014](#REQ-SBX-014) | 加合并说明 | 与 REQ-SYS-001 合并为同一待定问题 |
| [REQ-SBX-020](#REQ-SBX-020) | 加合并说明 | 与 REQ-LCH-014 互相引用 |
