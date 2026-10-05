---
id: PRD-SYS
title: 系统状态 · 产品需求
type: prd
status: draft
owner: 产品 owner（仓库唯一人类 owner）
domains: [SYS, DIA, AUD]
flows: [F-SYS-RESOURCE, F-SYS-CONN, F-SYS-DIAG, F-SYS-AUDIT]
applies_to: ">= v0.2.4"
last_verified:
  docs: fd2e1ee
  api: a453bb7
  web: 93f03c5
  date: 2026-10-04（底稿未改写的 26 条沿用 2026-10-01 的核对）
covers:
  - web/src/app/settings/system/**
  - web/src/{containers,views,lib,hooks}/system/**
  - web/src/lib/audit/**
  - api/apps/api/src/platform/system/**
  - api/apps/api/src/platform/audit/**
  - api/packages/contracts/src/sse-protocol.ts
  - web/src/views/system/{ResourcePoolCard,SandboxEnvStatusCard,ConnectionStatusCard,ProxySettingsCard,ProxyConfigForm}.view.tsx
  - web/src/lib/system/{resourceModel,sandboxEnvModel,connectionModel,globalBanner,connectivityVerdict}.ts
  - web/src/lib/system/initWizardModel.ts（toProxyUpdate）
  - web/src/hooks/system/{useSystemStatus,useSystemStatusModels,useProxySettings,useGlobalBanner}.ts
  - web/src/containers/system/SystemStatusContainer.tsx、web/src/app/settings/system/page.tsx、web/src/containers/banner/GlobalBannerContainer.tsx
  - api/apps/api/src/platform/system/{system-resources,system-settings,system-providers}.service.ts、system.controller.ts
  - api/apps/api/src/platform/system/diagnostics/connectivity.probe.ts
  - api/packages/contracts/src/schemas/system.schema.ts
  - web/src/views/system/{DiagnosticsCard,DiagnosticItem,AuditStreamCard,AuditEventRow,AuditFilterBar,AuditGapNotice,AuditDetailPanel}.view.tsx
  - web/src/components/ui/status-pill.tsx
  - web/src/lib/system/{diagnoseModel,diagnosticsDisclosure}.ts
  - web/src/lib/audit/{auditStream,auditRowModel}.ts
  - web/src/hooks/system/{useSystemStatus,useAuditFilters,useAuditStream,useExportAuditLogs,useGlobalBanner,useDiagnosticsDisclosure}.ts
  - web/src/containers/system/{SystemStatusContainer,AuditStreamContainer}.tsx
  - web/src/services/api/system.service.ts
  - api/apps/api/src/platform/system/diagnostics/diagnostics.service.ts
  - api/apps/api/src/platform/audit/{audit.controller,audit-export.service,audit.projector}.ts
  - api/packages/contracts/src/{sse-protocol,schemas/system.schema}.ts
supersedes:
  - docs/product/pages/21-5-系统状态.md
  - docs/frontend/pages/21-5-系统状态.md（§1、§6、§9 中的产品规则与验收）
drafts:
  - gap/drafts/f-sys-resource-01…04.html、gap/drafts/f-sys-conn-01…04.html（说明 gap/drafts/notes/sys-a.md；正常态 = pilot/p5-system-status.html）
  - gap/drafts/f-sys-diag-01…06.html、gap/drafts/f-sys-audit-01…06.html（说明 gap/drafts/notes/sys-b.md）
merged_from:
  - format-pilot/docs/product/system-status.md（底稿）
  - gap/product/_parts/sys-a.md
  - gap/product/_parts/sys-b.md
merged_at: 2026-10-04
review_minutes: 90
---

# 系统状态 · 产品需求

<!-- 本文件只写「做什么 / 为什么 / 怎样算做对」。布局与视觉在稿件（gap/drafts/f-*），实现方法在技术设计。由 gap/product/_build/merge.py 从 _parts 合并生成；改片段后重新运行。「现状」列暂留文件:行出处，入库时按 01 §4.2 换成证据 ID。 -->

## 一屏摘要

- **这一页回答四个问题**：这台机器还能不能干活（资源）、哪里坏了（沙箱环境、连接）、怎么修（一键诊断）、发生过什么（审计流与日志导出）。三个需求域：`SYS` 页面与看板 · `DIA` 一键诊断（与初始化向导共用同一套检查）· `AUD` 审计与日志。本文以 format-pilot 试点为底：F-SYS-RESOURCE / CONN / DIAG / AUDIT 四个流程整块改写了 16 条（其中 REQ-SYS-021、REQ-DIA-012 是 2026-10-04 拍板 Q-SYS-23 A 后改名、改用词）、新增 7 条；其余 26 条沿用试点（2026-10-01 核对）。
- **五条不能违反的规则**：
  1. 测不准时不给负面结论；读不到就原位说读不到，不显示成 0%、空条或空表单（REQ-SYS-014、REQ-SYS-010、REQ-DIA-004）。
  2. 「还能不能再发任务」只由后端按创建闸门同一套规则给的数回答，前端不自己算；契约到位前不显示（REQ-SYS-071）。
  3. 下一步对准触发它的维度：磁盘或保留下来的成果紧张说清理成果与删项目，**不**说停任务——停止不腾磁盘、也不释放名额（REQ-SYS-011、012）。
  4. 诊断的清单、顺序、单项时限一律以服务端首帧为准；断开时已到的结果一条不清；超时不等于失败（REQ-DIA-002、003、040）。
  5. 审计流与运行日志分开呈现；凭证明文不出现在审计、日志和导出包里（REQ-AUD-001、008）。
- **现状**：49 条需求里 `已实现` 23 · `部分实现` 10 · `未实现` 4 · `偏离` 8 · `实现先行` 2 · `未核实` 1 · `计划中` 1。缺口：主数字「还能再发 N 个任务」（等 DR-08）、首屏骨架、按维度的下一步、[清理成果]（今天叫 [清理保留卷]）死按钮、本页与诊断、审计里的「保留卷」用词、代理保存成功反馈与格式校验、代理读取失败时可能清空已存配置；诊断用词与超时汇总、审计时间范围与按任务筛选的可见条件。保存的出网代理今天**只有联网检查**在读（Q-SYS-16 已拍板 A：就只承诺这一处）。
- **待定**：Q-SYS-16…23、Q-AUD-03、Q-AUD-04 与沿用试点的 Q-SYS / DIA / AUD（[open-questions.md](./open-questions.md) §2、§4），其中 Q-SYS-16（A）、Q-SYS-01②（A）、Q-SYS-23（A）已于 2026-10-04 拍板：本页「保留卷」统一叫「保留下来的成果」（资源卡「成果占用」、按钮 [清理成果]，REQ-SYS-020、021；诊断第 ③ 项与审计摘要同步，REQ-DIA-012、REQ-AUD-003）。

**状态词表**：`已实现`（行为与本文一致）· `部分实现` · `未实现` · `偏离`（实现与本文不同）· `实现先行`（代码已有、原产品文档没写，待确认）· `未核实` · `计划中`（目标版本未到，或待某条待定问题选定后才生效）。「层级」= 最低验证层（单元 / 组件 / 集成 / API / e2e；`文档` = 文档一致性检查，`视觉` = 截图比对）。

## 需求索引

**共 49 条需求、175 条验收标准**：`已实现` 23 · `部分实现` 10 · `未实现` 4 · `偏离` 8 · `实现先行` 2 · `未核实` 1 · `计划中` 1。

| 编号 | 需求 | 状态 | 版本 | AC | 稿件 | 待定问题 |
|---|---|---|---|---:|---|---|
| [REQ-SYS-001](#REQ-SYS-001) | 入口：所有入口都落到「设置 › 系统状态」 | `部分实现` | MVP | 5 | — | [Q-SYS-01](./open-questions.md#Q-SYS-01) [Q-SYS-01②](./open-questions.md#Q-SYS-01) |
| [REQ-SYS-002](#REQ-SYS-002) | 退出路径 | `部分实现` | MVP | 4 | — | — |
| [REQ-SYS-003](#REQ-SYS-003) | 资源概念只在本页出现 | `未核实` | MVP | 1 | — | — |
| [REQ-SYS-010](#REQ-SYS-010)（改） | 本机资源水位：展示、轮询、刷新与读取失败 | `已实现` | MVP | 9 | f-sys-resource-01、f-sys-resource-02…04、f-sys-conn-03 | [Q-SYS-02](./open-questions.md#Q-SYS-02) [Q-SYS-12](./open-questions.md#Q-SYS-12) |
| [REQ-SYS-011](#REQ-SYS-011)（改） | CPU 与内存分三档；下一步对准 CPU / 内存 | `偏离` | MVP | 4 | f-sys-resource-02 | [Q-SYS-02](./open-questions.md#Q-SYS-02) [Q-SYS-03](./open-questions.md#Q-SYS-03) [Q-SYS-13](./open-questions.md#Q-SYS-13) [Q-SYS-15](./open-questions.md#Q-SYS-15) [Q-SYS-18](./open-questions.md#Q-SYS-18) [Q-SYS-19](./open-questions.md#Q-SYS-19) |
| [REQ-SYS-012](#REQ-SYS-012)（改） | 磁盘分三档；下一步说清理成果或删项目 | `偏离` | MVP | 3 | f-sys-resource-03、f-sys-resource-04 | [Q-SYS-03](./open-questions.md#Q-SYS-03) [Q-SYS-15](./open-questions.md#Q-SYS-15) [Q-SYS-23](./open-questions.md#Q-SYS-23) |
| [REQ-SYS-013](#REQ-SYS-013) | 整体等级取最差的一维 | `已实现` | MVP | 2 | — | — |
| [REQ-SYS-014](#REQ-SYS-014) | 测不准时不判「耗尽」 | `已实现` | MVP | 2 | — | — |
| [REQ-SYS-020](#REQ-SYS-020)（改） | 成果占用、超量提示与 [清理成果] | `部分实现` | MVP | 9 | f-sys-resource-03、f-sys-resource-04、f-prj-retained-05 | [Q-SYS-03](./open-questions.md#Q-SYS-03) [Q-SYS-10](./open-questions.md#Q-SYS-10) [Q-SYS-11](./open-questions.md#Q-SYS-11) [Q-SYS-23](./open-questions.md#Q-SYS-23) [Q-DS-32](./open-questions.md#Q-DS-32) [Q-DS-33](./open-questions.md#Q-DS-33) |
| [REQ-SYS-021](#REQ-SYS-021)（改） | 「保留下来的成果」的定义与计量（旧称「保留卷」） | `已实现` | MVP | 2 | — | [Q-SBX-03](./open-questions.md#Q-SBX-03) [Q-SYS-11](./open-questions.md#Q-SYS-11) [Q-SYS-23](./open-questions.md#Q-SYS-23) |
| [REQ-SYS-030](#REQ-SYS-030)（改） | 沙箱环境状态：最近一小时失败率 + 无样本 | `部分实现` | MVP | 8 | f-sys-conn-01、P5 | [Q-SBX-03](./open-questions.md#Q-SBX-03) [Q-SYS-04](./open-questions.md#Q-SYS-04) [Q-SYS-05](./open-questions.md#Q-SYS-05) [Q-SYS-22](./open-questions.md#Q-SYS-22) |
| [REQ-SYS-031](#REQ-SYS-031) | 在卡片内查看最近日志 | `未实现` | MVP | 1 | — | [Q-SYS-05](./open-questions.md#Q-SYS-05) |
| [REQ-SYS-040](#REQ-SYS-040)（改） | 连接状态：只报本页测到的 | `偏离` | MVP | 4 | P5、f-sys-resource-01、f-sys-conn-03 | [Q-SYS-06](./open-questions.md#Q-SYS-06) [Q-SYS-21](./open-questions.md#Q-SYS-21) |
| [REQ-SYS-050](#REQ-SYS-050) | 访问保护区块 | `未实现` | MVP | 1 | — | [Q-ACC-01](./open-questions.md#Q-ACC-01) [Q-SYS-07](./open-questions.md#Q-SYS-07) [Q-SYS-07②](./open-questions.md#Q-SYS-07) |
| [REQ-SYS-051](#REQ-SYS-051) | 升级与备份区块 | `计划中` | v1.5 | 0 | — | [Q-SYS-14](./open-questions.md#Q-SYS-14) |
| [REQ-SYS-060](#REQ-SYS-060)（改） | 出网代理：回填、只存不重测、校验、成功与失败 | `偏离` | MVP | 9 | P5、f-sys-conn-02、f-sys-conn-03、f-sys-conn-04 | [Q-SYS-08](./open-questions.md#Q-SYS-08) [Q-SYS-16](./open-questions.md#Q-SYS-16) [Q-SYS-20](./open-questions.md#Q-SYS-20) [Q-DS-35](./open-questions.md#Q-DS-35) |
| [REQ-SYS-070](#REQ-SYS-070) | 首屏骨架 | `部分实现` | MVP | 4 | f-sys-resource-01 | — |
| [REQ-SYS-071](#REQ-SYS-071) | 主数字「还能再发 N 个任务」与口径句 | `未实现` | MVP | 5 | f-sys-resource-02、f-sys-resource-03、f-sys-resource-04、f-sys-conn-01、P5 | [Q-SYS-02](./open-questions.md#Q-SYS-02) [Q-SYS-12](./open-questions.md#Q-SYS-12) [Q-SYS-17](./open-questions.md#Q-SYS-17) |
| [REQ-SYS-075](#REQ-SYS-075) | 后端不可达时本页：各卡原位说、横幅不自指 | `部分实现` | MVP | 3 | f-sys-conn-03 | — |
| [REQ-SYS-076](#REQ-SYS-076) | 离线时本页：横幅 [重新检测] 就地跑诊断 | `已实现` | MVP | 2 | f-sys-conn-02、f-sys-conn-04 | — |
| [REQ-DIA-001](#REQ-DIA-001)（改） | 一键诊断：触发、连接中、不阻塞、可重复、结果保留 | `部分实现` | MVP | 6 | f-sys-diag-01、f-sys-diag-02 | — |
| [REQ-DIA-002](#REQ-DIA-002)（改） | 检查项清单以首帧为准（现为 9 项）、固定顺序、逐项到达 | `偏离` | MVP | 4 | f-sys-diag-02 | [Q-DIA-01](./open-questions.md#Q-DIA-01) |
| [REQ-DIA-003](#REQ-DIA-003)（改） | 单项时限、超时不等于失败、断开时保留已到结果 | `偏离` | MVP | 7 | f-sys-diag-03、f-sys-diag-04 | [Q-DIA-02](./open-questions.md#Q-DIA-02) |
| [REQ-DIA-004](#REQ-DIA-004) | 结论语义：提示、超时、无法判定 | `已实现` | MVP | 3 | — | — |
| [REQ-DIA-005](#REQ-DIA-005) | 判据总纲：一项检查报多重，取决于「谁需要它」 | `已实现` | MVP | 3 | — | — |
| [REQ-DIA-006](#REQ-DIA-006) | 每项结论的呈现：结论、证据、下一步、可复制命令 | `已实现` | MVP | 2 | — | — |
| [REQ-DIA-010](#REQ-DIA-010) | ① 容器服务：通了要有证据，不需要它时不报错 | `已实现` | MVP | 2 | — | — |
| [REQ-DIA-011](#REQ-DIA-011) | ② 轻量虚拟机：按平台问对的问题 | `已实现` | MVP | 2 | — | [Q-DIA-02](./open-questions.md#Q-DIA-02) |
| [REQ-DIA-012](#REQ-DIA-012)（改） | ③ 磁盘余量 | `部分实现` | MVP | 2 | f-sys-diag-01…06 | [Q-DIA-04](./open-questions.md#Q-DIA-04) [Q-SBX-03](./open-questions.md#Q-SBX-03) [Q-SYS-23](./open-questions.md#Q-SYS-23) |
| [REQ-DIA-013](#REQ-DIA-013) | ④ 端口占用：说清被谁占了 | `已实现` | v1.1 修订 | 4 | — | — |
| [REQ-DIA-014](#REQ-DIA-014) | ⑤ 外网连通：按证据强弱下结论 | `已实现` | MVP | 8 | — | — |
| [REQ-DIA-015](#REQ-DIA-015) | ⑥ 实时推送自检 | `已实现` | MVP | 0 | — | [Q-DIA-02](./open-questions.md#Q-DIA-02) |
| [REQ-DIA-016](#REQ-DIA-016) | ⑦ 数据目录文件系统：写时复制三态 | `已实现` | MVP | 2 | — | — |
| [REQ-DIA-017](#REQ-DIA-017) | ⑧ 预制镜像就绪：五步检查链，不得合并 | `已实现` | v1.1 新增 | 4 | — | [Q-DIA-02](./open-questions.md#Q-DIA-02) |
| [REQ-DIA-018](#REQ-DIA-018) | ⑧ 预制镜像：能自己动手时不只报事实 | `已实现` | v1.1 | 3 | — | — |
| [REQ-DIA-019](#REQ-DIA-019) | ⑨ 帐号登录环境 | `实现先行` | — | 0 | — | [Q-DIA-01](./open-questions.md#Q-DIA-01) |
| [REQ-DIA-020](#REQ-DIA-020) | 与初始化向导共用同一套检查 | `已实现` | v1.1 | 1 | — | — |
| [REQ-DIA-030](#REQ-DIA-030) | 后端进程起不来时的兜底 | `未实现` | MVP | 1 | — | [Q-DIA-03](./open-questions.md#Q-DIA-03) |
| [REQ-DIA-040](#REQ-DIA-040) | 一轮结束：汇总一句（超时单列）、原位播报、非正常项默认展开 | `偏离` | MVP | 5 | f-sys-diag-04、f-sys-diag-05、f-sys-diag-06 | [Q-DIA-02](./open-questions.md#Q-DIA-02) |
| [REQ-AUD-001](#REQ-AUD-001) | 审计流与运行日志是两样东西 | `已实现` | v1.1 | 1 | — | — |
| [REQ-AUD-002](#REQ-AUD-002)（改） | 审计面板：默认内容、三项筛选走服务端、增量刷新 | `偏离` | v1.1 | 4 | f-sys-audit-02 | — |
| [REQ-AUD-003](#REQ-AUD-003)（改） | 审计行：内容、行内详情、按任务看完整时间线（就地筛） | `部分实现` | v1.1 | 7 | f-sys-audit-04、f-sys-audit-06 | [Q-AUD-01](./open-questions.md#Q-AUD-01) [Q-SYS-23](./open-questions.md#Q-SYS-23) |
| [REQ-AUD-004](#REQ-AUD-004)（改） | 空、失败、断层、实时中断都要如实说 | `已实现` | v1.1 | 8 | f-sys-audit-01、f-sys-audit-02、f-sys-audit-03、f-sys-audit-04 | — |
| [REQ-AUD-005](#REQ-AUD-005) | 审计保留与完整性声明 | `已实现` | v1.1 | 1 | — | — |
| [REQ-AUD-006](#REQ-AUD-006)（改） | 导出日志包：浏览器原生下载、四件 | `已实现` | v1.1 | 5 | — | [Q-AUD-02](./open-questions.md#Q-AUD-02) |
| [REQ-AUD-007](#REQ-AUD-007) | 运行日志落盘与轮转 | `已实现` | v1.1 | 1 | — | — |
| [REQ-AUD-008](#REQ-AUD-008) | 凭证明文不出现在审计、日志与导出包里 | `已实现` | MVP | 1 | — | — |
| [REQ-AUD-020](#REQ-AUD-020) | 时间范围：只填一端、起晚于止就地提示、条件句写人能读的时间 | `部分实现` | v1.1 | 6 | f-sys-audit-05 | — |
| [REQ-AUD-021](#REQ-AUD-021) | 加载更早的记录：游标翻页、加载中、到底 | `实现先行` | v1.1 | 4 | f-sys-audit-04、f-sys-audit-06 | — |

「待定问题」一列链到 [open-questions.md](./open-questions.md)，不回复时按那里写的默认走；标「（改）」的是整块改写了 format-pilot 试点的同号旧条。

## 与旧文档的对照

由各条「改写了哪条旧文」汇总；旧文档代号见 [README](./README.md#旧文档代号)。逐条的旧文与新口径见每条需求，以及文末附录 A。

| 旧文档 | 被改写的位置 → 本文 | 其中作废 / 删去的 |
|---|---|---|
| P22 异常场景与产品补充要求 | §4.6 → REQ-SYS-003；L151 → REQ-DIA-002；§3 → REQ-DIA-030 | — |
| P21-5 系统状态 | （多处） → REQ-SYS-001；§8 → REQ-SYS-002；L83 → REQ-SYS-010；L71 → REQ-SYS-011；L72 → REQ-SYS-012；§9 → REQ-SYS-014；L73、L84、（多处） → REQ-SYS-020；L74、L125、L28 → REQ-SYS-030；§6「[查看日志]」 → REQ-SYS-031；L33-35、L75 → REQ-SYS-040；§3 → REQ-SYS-050；§3 → REQ-SYS-051；§5 → REQ-SYS-070；L25 → REQ-SYS-071；（多处） → REQ-SYS-075；L86 → REQ-DIA-001；L86、L76 → REQ-DIA-002；L108 → REQ-DIA-003；§9 → REQ-DIA-004；§9 → REQ-DIA-005；§5「诊断运行中/完成」、§6「修复建议」 → REQ-DIA-006；§9 → REQ-DIA-010；§9 → REQ-DIA-011；§9 → REQ-DIA-013；§9 → REQ-DIA-014；§6 → REQ-DIA-015；§5 → REQ-DIA-016；§9 → REQ-DIA-017；§9 → REQ-DIA-018；§9 → REQ-DIA-020；§9 → REQ-DIA-030；§5 → REQ-DIA-040；§10.1 → REQ-AUD-001；L492 → REQ-AUD-002；L511、L45 → REQ-AUD-003；（多处） → REQ-AUD-004；§10.1 → REQ-AUD-005；L518、L88 → REQ-AUD-006；§10.4 → REQ-AUD-007；§6「[导出日志]」、§9 → REQ-AUD-008；L492 → REQ-AUD-020；（多处） → REQ-AUD-021 | — |
| P21-8 部署与初始化 | §3 → REQ-SYS-050；§4 → REQ-SYS-051；L380 → REQ-SYS-060；L379 → REQ-SYS-076；L288 与 L407 → REQ-DIA-003；§2 → REQ-DIA-020 | — |
| F21-5 前端·系统状态 | §2 → REQ-SYS-001；§1 → REQ-SYS-003；§6 → REQ-SYS-013；§5 → REQ-SYS-031；§3、§8 → REQ-SYS-050；§8 → REQ-SYS-051；L63 → REQ-SYS-060；§5 L156 → REQ-DIA-001；L310 / L388 → REQ-DIA-002；§5 → REQ-DIA-004；§5、§5 → REQ-DIA-006；§5 → REQ-DIA-017；§1、§3 → REQ-AUD-001；L322 → REQ-AUD-002；L155、L327 / L364 → REQ-AUD-003；§3 → REQ-AUD-004；L150 → REQ-AUD-006 | — |
| F21-8 前端·部署与初始化 | L48 与 L250 → REQ-DIA-003 | — |

只改写实现现状、试点或稿件口径（不涉及上表旧文档）的需求：REQ-SYS-021、REQ-DIA-012、REQ-DIA-019。

---

## SYS · 页面与看板

### REQ-SYS-001 · 入口：所有入口都落到「设置 › 系统状态」 {#REQ-SYS-001}

> 状态 `部分实现` · 版本 MVP（v1.0.1 起改为设置子页）· 来源 P21-5 头注、§2；F21-5 §2 · 关联 UX-SYS-001 · Q-SYS-01

系统状态**必须**是「设置」下的一个子页，不再是独立弹层。以下入口**必须**都打开设置页并选中「系统状态」：顶栏设置菜单；Cmd+K 的 Settings → System；全局横幅与环境类错误提示上的 [诊断]。从横幅的 [诊断] 进入时，**必须**自动开始一轮诊断（REQ-DIA-001）。

**改写了哪条旧文**：format-pilot 试点整理时按状态行「来源」所列旧文（P21-5、F21-5 等）改写成本格式，措辞差异见本条「与原文的措辞差异」（如有）；本轮未再改写（合并时补记）。

**合并说明**：⌘K 入口改由 WB 域定（前往 › 系统状态；动作「运行诊断」，REQ-WB-030、031），AC-SYS-001.4 的「Settings → System」按此理解；「无法确认平台状态」横幅不自动诊断（REQ-WB-013）；AC-SYS-001.5 在任务结果卡上的落点是 REQ-SBX-001（AC-SBX-001.5）与 REQ-SBX-014：Q-SYS-01② 已于 2026-10-04 拍板 A，环境类错误（PROVIDER_UNAVAILABLE、DISK_INSUFFICIENT）的结果卡带 [运行诊断]，去系统状态并开始一轮诊断。（交叉引用：REQ-WB-030、REQ-WB-031、REQ-WB-013、REQ-SBX-001、REQ-SBX-014）

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-SYS-001.1 | e2e | 在工作台 | 点顶栏设置菜单里的「系统状态」 | 地址为 `/settings/system`，左侧菜单「系统状态」高亮 | 已实现：WorkbenchShell.view.tsx:190，settings/layout.tsx:20 |
| AC-SYS-001.2 | e2e | 工作台出现「离线模式」横幅 | 点横幅动作按钮 | 跳到系统状态页，并自动开始一轮诊断 | 已实现：GlobalBannerContainer.tsx:52-53 |
| AC-SYS-001.3 | e2e | 出现「无法确认平台状态」横幅 | 点「查看系统状态」 | 跳到系统状态页 | 已实现，但不自动诊断（GlobalBannerContainer.tsx:52-53）；它是否属于「横幅 [诊断]」待确认，见 Q-SYS-01 |
| AC-SYS-001.4 | e2e | 任意页 | 按 Cmd+K（Windows/Linux 为 Ctrl+K），选 Settings → System | 同 AC-SYS-001.1 | 未实现：web 无 cmdk 依赖与快捷键处理 |
| AC-SYS-001.5 | 组件 | 出现一条环境类错误提示（如 `PROVIDER_UNAVAILABLE`） | 查看提示 | 提示带 [运行诊断]（结果卡上的落点见 REQ-SBX-001），点击后效果同 AC-SYS-001.2 | 未实现：sandboxErrorCopy.ts:371-377 只有 [重试]，且文案让 boxlite 用户去查 Docker |

### REQ-SYS-002 · 退出路径 {#REQ-SYS-002}

> 状态 `部分实现` · 版本 MVP · 来源 P21-5 §8 · 关联 —

**必须**能通过 [← 返回工作台]、Logo、Esc 回到工作台；左侧设置菜单**必须**能切到其他设置子页。

**改写了哪条旧文**：format-pilot 试点整理时按状态行「来源」所列旧文（P21-5、F21-5 等）改写成本格式，措辞差异见本条「与原文的措辞差异」（如有）；本轮未再改写（合并时补记）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-SYS-002.1 | e2e | 在系统状态页 | 按 Esc | 回到工作台 `/` | 已实现：settings/layout.tsx:52 |
| AC-SYS-002.2 | e2e | 在系统状态页 | 点 [← 返回工作台] | 回到工作台 | 已实现：SettingsMenu.view.tsx:52 |
| AC-SYS-002.3 | e2e | 在系统状态页 | 点 Logo | 回到工作台 | 未实现：设置区没有 Logo（全仓 grep 未命中） |
| AC-SYS-002.4 | e2e | 在系统状态页 | 点左侧「凭证管理」「镜像管理」 | 切到对应子页，菜单高亮跟随 | 已实现：settings/layout.tsx:13-20 |

### REQ-SYS-003 · 资源概念只在本页出现 {#REQ-SYS-003}

> 状态 `未核实` · 版本 MVP · 来源 F21-5 §1（引 P22 §4.6）· 关联 —

本页是**唯一**允许出现资源与配额概念（CPU、内存、配额）的页面；任务列表与发起任务链路**不得**出现这些概念。

**改写了哪条旧文**：format-pilot 试点整理时按状态行「来源」所列旧文（P21-5、F21-5 等）改写成本格式，措辞差异见本条「与原文的措辞差异」（如有）；本轮未再改写（合并时补记）。

**合并说明**：工作台与发起弹层里出现的任务「名额」（已停止也占名额，DR-03 A；REQ-SBX-010、012，REQ-LCH-007）是有意的：本条禁的是 CPU、内存、配额这类资源概念，不禁「名额」。（交叉引用：REQ-LCH-007、REQ-SBX-012）

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-SYS-003.1 | e2e | 工作台、发起任务弹窗分别打开 | 读页面文字 | 不出现「CPU」「内存」「配额」 | 未核实：F21-5 §9.1 #17 标 ✅，但 web/e2e 中找不到对应的否定断言 |

### REQ-SYS-010 · 本机资源水位：展示、轮询、刷新与读取失败 {#REQ-SYS-010}

> 状态 `已实现` · 版本 MVP · 来源 P21-5 §3（L18-25）、§6「自动刷新」（L83）、§7（L115）；F21-5 §6；P21-8 §7（预留比例的算法）；UX-DS-304、UX-DS-305（spec/patterns.md:43-44）；实现 useSystemStatus.ts:37-38、87-98、195-207，ResourcePoolCard.view.tsx:110-155，resourceModel.ts:113-149 · 关联 UX-SYS-010 · Q-SYS-12 · PARAM.SYS_POLL_INTERVAL_S · PARAM.SCHED_RESERVED_PCT · 稿件 f-sys-resource-01（首次加载）、f-sys-resource-02…04（有数据）、f-sys-conn-03（读取失败）

页面**必须**展示 CPU、内存、磁盘（数据目录所在的文件系统）三项的使用率与用量，以及系统预留比例；预留只影响调度上限，**不改变**进度条的分母（分母永远是总容量）。数据每 `PARAM.SYS_POLL_INTERVAL_S` 秒（现值 30）自动重取，并提供手动 [刷新]：请求在途时按钮写「刷新中…」并禁用（首次加载同样如此），卡内**保留上一次的数字**，不清空、不换回骨架。读取失败时卡内**只剩**一句「本机资源读取失败，当前数字不可用 —— 请点 [刷新] 重试」（role="alert"），[刷新] 留在原位；**不得**显示成 0% 或空的水位条，也**不得**继续摆着上一次的数字冒充当前值。主数字与口径句见 REQ-SYS-071，首屏骨架见 REQ-SYS-070。

<details>
<summary>为什么</summary>

资源水位回答本页最高频的问题：还能不能再发任务。一条空的水位条会被读成「很空闲」，一个过期的数字会被读成「现在就是这样」，而真相是数字根本没取到。

</details>

**改写了哪条旧文**：原 REQ-SYS-010「展示当前活跃任务数」→ 活跃任务 / 已登记数的写法移到 REQ-SYS-071（D9 / Q-SYS-02 ③）；P21-5 L83「手动 [刷新] 即时」补上「刷新中…」、保留旧数据与首次加载三条（UX-DS-304）；UX-DS-305「读取失败原位一行」落成 AC-SYS-010.4 与 AC-SYS-010.9。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-SYS-010.1 | 组件 | 资源接口正常返回 | 页面渲染 | 显示 CPU、内存、磁盘三条，每条有「已用 / 总量（百分比）」；磁盘另起一行显示所测路径 | 已实现：resourceModel.ts:113-139 |
| AC-SYS-010.2 | 集成 | 页面已加载 | 假时钟推进 `PARAM.SYS_POLL_INTERVAL_S` 秒；另一次只推进该值减 1 秒 | 前者资源与沙箱环境各重取一次；后者不重取 | 已实现：useSystemStatus.ts:37-38、87-98（现值 30 秒） |
| AC-SYS-010.3 | 组件 | 页面已加载 | 点 [刷新] | 立即重取资源与沙箱环境，按钮显示「刷新中…」并禁用 | 已实现：ResourcePoolCard.view.tsx:114-122，useSystemStatus.ts:195-198、207 |
| AC-SYS-010.4（改） | 组件 | 资源接口返回 500 | 页面渲染 | 卡内只有「本机资源读取失败，当前数字不可用 —— 请点 [刷新] 重试」（role="alert"）与原位的 [刷新]；不渲染主数字、水位条与成果块 | 已实现：ResourcePoolCard.view.tsx:125-131（稿件 f-sys-conn-03：失败句与 [刷新] 同一行） |
| AC-SYS-010.5 | API | 一台有大量可回收缓存的机器 | `GET /api/system/resources` | 内存已用 = 总量 − 可用，「可用」包含可回收缓存，不把缓存算成已用 | 已实现：memory.probe.ts、system-resources.service.ts:273-286 |
| AC-SYS-010.6（改） | 组件 | 资源接口正常返回 | 页面渲染 | 结论块末尾「留出 15% 不拿去跑任务（上面的进度条分母仍然是总容量）」，15 取自接口 `disk.reservedPercent`；主数字与「已登记」口径见 REQ-SYS-071 | 已实现：ResourcePoolCard.view.tsx:151-154 |
| AC-SYS-010.7 | 组件 | 卡内已显示一组数字 | 点 [刷新]，请求在途 | 数字、徽标、水位条保持上一次的值，不清空、不出骨架；只有按钮变「刷新中…」 | 已实现：useSystemStatus.ts:207（重取时不清旧数据） |
| AC-SYS-010.8 | 组件 | 首次打开，资源与沙箱环境都还没返回 | 页面渲染 | [刷新] 显示「刷新中…」并禁用，不是可点的「刷新」 | 已实现：useSystemStatus.ts:207（稿件 f-sys-resource-01） |
| AC-SYS-010.9 | 集成 | 卡内已显示过一组数字 | 下一次轮询或 [刷新] 失败 | 卡内换成 AC-SYS-010.4 的失败句，上一次的数字不再显示；之后任一次重取成功即恢复 | 已实现：ResourcePoolCard.view.tsx:125（失败优先于旧数据） |

### REQ-SYS-011 · CPU 与内存分三档；下一步对准 CPU / 内存 {#REQ-SYS-011}

> 状态 `偏离` · 版本 MVP · 来源 P21-5 §5 第 1 行（L71）；UX-DS-313 / X-1（spec/patterns.md:52）；D9 / Q-SYS-02 ③；DR-08；DR-03 A；实现 system-resources.service.ts:16-18、244-248，resourceModel.ts:26-31、141-146 · 关联 UX-SYS-012 · Q-SYS-03 · Q-SYS-13 · Q-SYS-15 · PARAM.CPU_RAM_WARN_PCT · PARAM.CPU_RAM_CRITICAL_PCT · 稿件 f-sys-resource-02

CPU 与内存的使用率**必须**分三档（档位由后端给，前端不重算）：低于 `PARAM.CPU_RAM_WARN_PCT`%（现值 80）为正常；`PARAM.CPU_RAM_WARN_PCT`% 至低于 `PARAM.CPU_RAM_CRITICAL_PCT`%（现值 95）为警告；达到 `PARAM.CPU_RAM_CRITICAL_PCT`% 为严重。越线的那条水位挂对应徽标并给条上色，其余条保持中性。

整体结论块 = 整体档位徽标（取最差的一维，REQ-SYS-013）+ 结论（资源充足 / 资源紧张 / 资源耗尽）+ **按触发维度给的下一步** + 预留说明。CPU 或内存是触发维度时，下一步是「停掉一些任务」（停掉的任务不再吃 CPU、内存；它仍占登记名额，名额看主数字，DR-03 A）。严重档**不再**单凭实时水位承诺「无法创建新 Task」：能不能建只由主数字说（REQ-SYS-071）——主数字为 0 时结论写「资源耗尽，现在建不了新任务」，大于 0 时只写「资源耗尽」+ 下一步。几个维度同时越线时各给各的一句下一步（CPU / 内存一句、磁盘 / 成果一句），严重的在前。

**改写了哪条旧文**：P21-5 L71「⚠️ 黄"建议停止部分 Task" / 🔴 红"无法创建新 Task"」→ 警告「资源紧张，建议停掉一些任务」（现行文案，Q-SYS-03 以代码为准）；严重时的「建不了」改由主数字承诺（D9 / Q-SYS-02 ③、DR-08）；format-pilot AC-SYS-011.3「整体严重 → 『无法创建新 Task』成立」（偏离）→ AC-SYS-011.3（改）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-SYS-011.1 | 单元 | CPU 或内存使用率分别为 79.9 / 80 / 94.9 / 95 / 100 | 计算档位 | 依次为 正常 / 警告 / 警告 / 严重 / 严重 | 已实现：system-resources.service.ts:16-18、244-248 |
| AC-SYS-011.2（改） | 组件 | CPU 87%（警告），内存、磁盘正常 | 页面渲染 | CPU 行警告徽标 + 琥珀条；整体「警告 · 资源紧张，建议停掉一些任务」；不出现 [清理成果] | 已实现：resourceModel.ts:26-31、153（稿件 f-sys-resource-02） |
| AC-SYS-011.3（改） | 组件 | CPU 96%（严重），`remainingTasks = 3` | 页面渲染 | 主数字仍是 3；整体「严重 · 资源耗尽」+「停掉一些任务」类下一步；不出现「现在建不了新任务」 | 偏离：严重档固定写「资源耗尽，现在建不了新任务」（resourceModel.ts:30），与创建闸门无关（Q-SYS-02）；主数字待 DR-08 |
| AC-SYS-011.4 | 组件 | 内存严重、磁盘警告 | 页面渲染 | 结论块两句下一步：先内存（停掉一些任务），后磁盘（清理成果或删掉不用的项目） | 未实现：只有一句整体文案（resourceModel.ts:26-31）；没有稿件 |

### REQ-SYS-012 · 磁盘分三档；下一步说清理成果或删项目 {#REQ-SYS-012}

> 状态 `偏离` · 版本 MVP · 来源 P21-5 §5 第 2 行（L72）、§6（L84）；UX-DS-313 / X-1；spec/status-mapping.md:83-84；DR-03 A；实现 disk-space.check.ts:13-14，system-resources.service.ts:250-254，resourceModel.ts:26-31、150-153，ResourcePoolCard.view.tsx:73-84 · 关联 UX-SYS-012 · Q-SYS-03 · Q-SYS-15 · PARAM.DISK_WARN_PCT · PARAM.DISK_CRITICAL_PCT · 稿件 f-sys-resource-03（严重）、f-sys-resource-04（警告）

磁盘使用率**必须**分三档：低于 `PARAM.DISK_WARN_PCT`%（现值 75）为正常；`PARAM.DISK_WARN_PCT`% 至低于 `PARAM.DISK_CRITICAL_PCT`%（现值 90）为警告；达到 `PARAM.DISK_CRITICAL_PCT`% 为严重。磁盘阈值与 CPU、内存的阈值**相互独立**；诊断第 ③ 项使用同一组阈值（REQ-DIA-012）。磁盘行另起一行写所测路径。

磁盘是触发维度时，结论块里的下一步**必须**是「磁盘快满了：清理成果或删掉不用的项目」（警告）/「磁盘满了：清理成果或删掉不用的项目」（严重），并给出 [清理成果]（REQ-SYS-020；Q-SYS-23 A 之前叫「清理保留卷」）；**不得**说「停掉一些任务」——停止 = 暂停，代码副本还在，不腾磁盘，也不释放名额（DR-03 A）。磁盘严重时「新任务会不会被拒」看主数字（REQ-SYS-071），不由水位档位推出。

**改写了哪条旧文**：P21-5 L72「⚠️ 黄"已使用超 75%，建议清理" / 🔴 红"已满（无法创建 Task）"」→ 下一步按上面两句写进结论块（只写一处，磁盘行不再重复一遍）；「无法创建 Task」改由主数字说；现行整体文案在磁盘触发时也说「建议停掉一些任务」（resourceModel.ts:29；status-mapping.md:83-84）→ 按维度（UX-DS-313 / X-1）。原 AC-SYS-012.2「磁盘行显示提示句」→ AC-SYS-012.2（改）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-SYS-012.1 | 单元 | 磁盘使用率 74.9 / 75 / 89.9 / 90 | 计算档位 | 正常 / 警告 / 警告 / 严重 | 已实现：disk-space.check.ts:13-14，system-resources.service.ts:250-254 |
| AC-SYS-012.2（改） | 组件 | 磁盘 88%（警告），CPU、内存正常 | 页面渲染 | 磁盘行警告徽标 + 琥珀条 + 路径；整体「警告 · 资源紧张」+「磁盘快满了：清理成果或删掉不用的项目」；全卡不出现「停掉一些任务」；出现 [清理成果] | 偏离：整体文案是「资源紧张，建议停掉一些任务」（resourceModel.ts:29）（稿件 f-sys-resource-04） |
| AC-SYS-012.3 | 组件 | 磁盘 96%（严重） | 页面渲染 | 磁盘行严重徽标 + 红条 + 路径；整体「严重 · 资源耗尽…」+「磁盘满了：清理成果或删掉不用的项目」；出现 [清理成果] | 偏离：没有按维度的下一步（稿件 f-sys-resource-03） |

### REQ-SYS-013 · 整体等级取最差的一维 {#REQ-SYS-013}

> 状态 `已实现` · 版本 MVP · 来源 F21-5 §6（审计 P1-9）· 关联 UX-SYS-010

整体等级**必须**取 CPU、内存、磁盘三维中最差的一维，**不得**取平均。

<details>
<summary>为什么</summary>

平均会把「磁盘 98% + CPU 10%」算成健康，而那恰恰是最该拦住新建任务的时刻。

</details>

**改写了哪条旧文**：format-pilot 试点整理时按状态行「来源」所列旧文（P21-5、F21-5 等）改写成本格式，措辞差异见本条「与原文的措辞差异」（如有）；本轮未再改写（合并时补记）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-SYS-013.1 | 单元 | CPU 正常、内存正常、磁盘严重（如 10% / 20% / 98%） | 计算整体等级 | 严重 | 已实现：resourceModel.ts:39-46 |
| AC-SYS-013.2 | 单元 | 三维都正常 | 计算整体等级 | 正常 | 已实现 |

### REQ-SYS-014 · 测不准时不判「耗尽」 {#REQ-SYS-014}

> 状态 `已实现` · 版本 MVP · 来源 P21-5 §9E（第二个）「测不准时」· 关联 REQ-DIA-004 · ADR-0106

内存读数测不准时，内存档位**必须**按正常处理，**不得**据此判成警告或严重；页面仍显示能拿到的数字，并在运行日志留一条告警。

**改写了哪条旧文**：format-pilot 试点整理时按状态行「来源」所列旧文（P21-5、F21-5 等）改写成本格式，措辞差异见本条「与原文的措辞差异」（如有）；本轮未再改写（合并时补记）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-SYS-014.1 | 单元 | 可用内存无法测量（读数源不可用） | 计算内存水位 | 档位为正常，仍给出使用率数字 | 已实现：system-resources.service.ts:287-293 |
| AC-SYS-014.2 | 单元 | 同上 | 读取 | 运行日志有一条说明「已钉在 ok」的告警 | 已实现：system-resources.service.ts:76-81 |

### REQ-SYS-020 · 成果占用、超量提示与 [清理成果] {#REQ-SYS-020}

> 状态 `部分实现` · 版本 MVP · 来源 P21-5 §3（L23-24）、§5 第 3 行（L73）、§6（L84、L89）；F21-5 §6；DR-37（BACKLOG L758、L780-787）；Q-DS-33 A（plan「要拍板」默认）；DR-27（BACKLOG L380、L577-588）；Q-DS-32 B；Q-SYS-23 A（用户拍板 2026-10-04，原话「补全 10 条按推荐」：本页的「保留卷」统一叫「保留下来的成果」）；实现 resourceModel.ts:88-111、150-153，ResourcePoolCard.view.tsx:157-183，page.tsx:23-37，SystemStatusContainer.tsx:27、49-51，system-resources.service.ts:20、119-130，retained-volume.service.ts:94-101 · 关联 UX-SYS-011 · UX-SYS-060 · Q-SYS-10 · Q-SYS-11 · PARAM.RETAINED_WARN_PCT · PARAM.RETENTION_DAYS_DEFAULT · 稿件 f-sys-resource-03、f-sys-resource-04；去处 f-prj-retained-05（F-PRJ-RETAINED，PRJ 域 REQ-PRJ-056）

页面**必须**显示保留下来的成果（旧称「保留卷」，定义见 REQ-SYS-021）的总占用、个数、占数据目录总容量的比例，以及「最早一份成果多久后被清理」的倒计时（整数天向下取整：不足 1 天说「不足 1 天」，否则「还需 N 天」，已过期说「即将清理」）；这一行上屏写「成果占用 <总量>（<份数> 个 · 占数据目录的 N%）」，**不得**再写「保留卷」。统计被截断时**必须**明说「实际占用不小于这个数」。

成果占比达到 `PARAM.RETAINED_WARN_PCT`%（现值 80，档位用后端 `retainedVolumes.level`）时：成果块**必须**多一行「警告 · 保留下来的成果已占数据目录的 N%，建议手动清理」（role="status"，DR-37）；同时出全局治理横幅（Q-DS-32 B；横幅文案、位置与堆叠归 F-WB-BANNER）。

磁盘不是正常、或成果为警告时，成果块**必须**给出 [清理成果]（旧称「清理保留卷」）：点开「保留下来的成果」对话框的**跨项目视图**——范围「全部项目」、按项目分组（`GET /api/retained-volumes` 不带 `projectId`；Q-DS-33 A；列表、下载、删除的规格归 PRJ 域）；关掉后焦点回到 [清理成果]。CPU / 内存触发时**不**给这颗按钮（清盘不降 CPU）。这颗按钮接好之前**不得**出现（DR-27：不放点了没反应的按钮）。

**改写了哪条旧文**：P21-5 L73「⚠️ 黄"保留卷已占 DATA_ROOT 的 80%+，建议手动清理"」→「保留下来的成果已占数据目录的 N%，建议手动清理」（写实际百分比；上屏说「数据目录」，「（DATA_ROOT）」的桥接只留在占用那一句，resourceModel.ts:105-107）；P21-5 L84「[清理]」与原 REQ-SYS-020「进入保留卷管理」→ 本页按钮 [清理成果] 打开跨项目视图（Q-DS-33 A；Q-SYS-23 A 之前叫「清理保留卷」）；横幅里同一动作叫「去清理」（F-WB-BANNER）；P21-5、v1 与实现的「保留卷」「保留卷占用」→「保留下来的成果」「成果占用」（Q-SYS-23 A，用户拍板 2026-10-04）。

**合并说明**：倒计时口径按 PRJ 域 REQ-PRJ-055 统一——每份成果按自己的到期时间（登记时间 + 这一份的保留期），即 Q-SYS-11 ①。现状本页按状态文件时间 + 固定 30 天算（system-resources.service.ts:24、123-129），全部按默认 30 天登记时两者一致，自动化成果按规则的 3 / 7 天登记后就会不一致（实现差距，见 impl-gaps）。（交叉引用：REQ-PRJ-055）

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-SYS-020.1 | 组件 | 有 3 份保留下来的成果，共 45 GB，占数据目录 30% | 页面渲染 | 显示总占用、个数、占比 | 已实现：ResourcePoolCard.view.tsx:157-165 |
| AC-SYS-020.2 | 单元 | 最早一份距清理 0.5 天 / 6.9 天 / 已过期 | 生成倒计时 | 「不足 1 天」/「还需 6 天」/「即将清理」 | 已实现（文案不同）：resourceModel.ts:88-95，见 Q-SYS-03 |
| AC-SYS-020.3 | 组件 | 统计被截断 | 页面渲染 | 显示「统计已截断，实际占用不小于这个数」 | 已实现：ResourcePoolCard.view.tsx:172-178 |
| AC-SYS-020.4 | API | 保留下来的成果占数据目录 79.9% / 80% | `GET /api/system/resources` | `retainedVolumes.level` 为 正常 / 警告 | 已实现：system-resources.service.ts:20、122 |
| AC-SYS-020.5（改） | e2e | 成果档位为警告 | 打开任意页 | 主列顶部出「保留下来的成果占了数据目录的 N%」治理横幅，[去清理] 打开跨项目视图（规格见 F-WB-BANNER） | 未实现：全局横幅只有三类（globalBanner.ts:47-51） |
| AC-SYS-020.6（改） | e2e | 磁盘为警告 | 点 [清理成果] | 打开「保留下来的成果」对话框，范围「全部项目」、按项目分组；关闭后焦点回到 [清理成果] | 未实现（缺陷）：页面没有传入回调，点击无反应（page.tsx:30，SystemStatusContainer.tsx:49-51；DR-27） |
| AC-SYS-020.7 | 组件 | 保留下来的成果 410 GB，占数据目录 82%（警告） | 页面渲染 | 成果块多一行警告徽标 +「保留下来的成果已占数据目录的 82%，建议手动清理」（role="status"），其下是 [清理成果] | 未实现：只多一颗按钮，没有提示句（ResourcePoolCard.view.tsx:157-183；DR-37）（稿件 f-sys-resource-04） |
| AC-SYS-020.8 | 单元 | ① 磁盘、成果都正常 ② 磁盘警告 ③ 成果警告 ④ CPU 严重、磁盘正常 | 计算是否给 [清理成果] | 只有 ②③ 给 | 已实现：resourceModel.ts:153（按钮本身仍是死的，见 AC-SYS-020.6） |
| AC-SYS-020.9 | 组件 | 资源卡有 3 份成果、磁盘警告 | 扫资源卡上屏文字 | 写「成果占用 …」与 [清理成果]；整张卡不出现「保留卷」 | 偏离：「保留卷占用 …」（ResourcePoolCard.view.tsx:163）、按钮「清理保留卷」（ResourcePoolCard.view.tsx:181） |

### REQ-SYS-021 · 「保留下来的成果」的定义与计量（旧称「保留卷」） {#REQ-SYS-021}

> 状态 `已实现` · 版本 MVP · 来源 P21-5 §10「9C. 落地口径修正」；format-pilot REQ-SYS-021（「保留卷」的定义与计量）；Q-SYS-23 A、Q-SBX-03 A（用户拍板 2026-10-04，原话「补全 10 条按推荐」：屏上统一叫「保留下来的成果」「代码副本」）· 关联 ADR-0107 · Q-SYS-11 · REQ-PRJ-050 · 稿件 —

「保留下来的成果」（旧称「保留卷」；代码与接口里仍叫 retained volume / `retainedVolumes`）**只**指任务销毁时选择留下来的那份代码副本；仍在运行的任务的代码副本**不计入**。体积**必须**按「删掉能腾出多少」计算（按实际占用的磁盘块，不按文件的逻辑大小）。

**改写了哪条旧文**：format-pilot REQ-SYS-021「「保留卷」**只**指任务销毁时选择保留下来的工作区」→ 名称改为「保留下来的成果」、「工作区」改「代码副本」（Q-SYS-23 A、Q-SBX-03 A，用户拍板 2026-10-04）；定义与计量口径不变。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-SYS-021.1 | API | 一个运行中任务的代码副本 + 一个销毁时留下来的代码副本 | `GET /api/system/resources` | 只统计后者 | 已实现：system-resources.service.ts:145-205 |
| AC-SYS-021.2 | API | 保留下来的成果里有稀疏文件或共享块 | 统计体积 | 按实际占用块计 | 已实现：system-resources.service.ts:234-236 |

### REQ-SYS-030 · 沙箱环境状态：最近一小时失败率 + 无样本 {#REQ-SYS-030}

> 状态 `部分实现` · 版本 MVP · 来源 P21-5 §3（L27-31）、§5 第 4 行（L74）、§9（L125）；D9 / Q-SYS-04 ②（00-决策简报 L65、L112；plan「按默认推进」）；UX-DS-306、UX-DS-070；UX-DS-133（spec/status-mapping.md:86）+ Q-DS-15 ②A；实现 sandboxEnvModel.ts:20-49、105-141，SandboxEnvStatusCard.view.tsx:23-34、47-68、97-130，system-providers.service.ts:37-46、63-75 · 关联 UX-SYS-020 · Q-SYS-04 · Q-SYS-05 · PARAM.PROVIDER_HEALTH_WINDOW_MIN · PARAM.PROVIDER_FAIL_WARN_RATE · PARAM.PROVIDER_FAIL_ERROR_RATE · 稿件 f-sys-conn-01（故障）、P5（正常 + 无样本）

页面**必须**逐个列出这台机器上的沙箱环境（aio 容器运行时、boxlite 微 VM、以及第三方注册的环境），标出默认环境、列出已开启的能力（能力名写人话，不出内部字段名；挂载类的那一项写「挂载代码副本」，Q-SBX-03 A），并按**最近 `PARAM.PROVIDER_HEALTH_WINDOW_MIN` 分钟（现值 60）的创建失败率**给出健康状态：失败率严格大于 `PARAM.PROVIDER_FAIL_ERROR_RATE`（10%）为「故障」，严格大于 `PARAM.PROVIDER_FAIL_WARN_RATE`（1%）为「失败率偏高」，其余为「正常」；窗口内没有创建记录时为「无样本」（虚线灰），**不得**显示成 0% 或「正常」。平台**不**为这张卡主动起沙箱探测（有副作用且慢，深查交给诊断）。窗口与阈值写在分区标题旁，都以接口下发为准。

同一张卡里列出 Agent（每个 Agent 一行：凭证已配置 / 未配置 + 授权方式；未配置用「停用」灰色徽标，可访问名「凭证未配置」）与镜像读取方式（标出默认）。读取失败时卡内只剩一句「沙箱环境概览读取失败 —— 这里的空白不代表这台机器上没有沙箱环境」（role="alert"），统计窗口不显示；恢复靠 30 秒轮询或资源卡 [刷新]（两张卡一起重取）。

**改写了哪条旧文**：P21-5 L74、L125 的三态口径「探测成功 ✅ / 探测失败 ❌ + [查看日志] / 未配置 ⏸️『v2.0 开放』」→ 失败率 + 无样本（D9 / Q-SYS-04 ②），删去「未启用 · v2.0 开放」（boxlite 已注册且是 macOS 默认环境）；P21-5 L28「aio 正常 · socket proxy 可达」这类探测结论不再出现在本卡；[查看日志] 仍归 REQ-SYS-031（未实现，Q-SYS-05），本条不要求。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-SYS-030.1 | 单元 | 最近一小时失败率 0.9% / 1.1% / 10.1% | 计算健康档 | 正常 / 失败率偏高 / 故障（严格大于） | 已实现：sandboxEnvModel.ts:21-36 |
| AC-SYS-030.2（改） | 组件 | aio 最近一小时没有创建记录 | 页面渲染 | 行尾「无样本」虚线徽标，说明句里没有任何数字 | 已实现：sandboxEnvModel.ts:32、44-47（原「实现先行」，按 D9 纳入） |
| AC-SYS-030.3（改） | 组件 | boxlite 最近一小时 50 次创建失败 6 次 | 页面渲染 | 行尾「故障」徽标（红），说明「最近 1h 失败率 12%（6/50）」；不出现版本、通道等探测信息 | 已实现：sandboxEnvModel.ts:31-36、43-49（稿件 f-sys-conn-01） |
| AC-SYS-030.4（改） | 组件 | 任意机器 | 页面渲染 | 不出现「未启用」「v2.0 开放」 | 已实现 |
| AC-SYS-030.5 | 组件 | 接口下发统计窗口 3600000 ms | 页面渲染 | 分区标题旁「健康统计窗口：最近 1 小时（阈值 >1% 警告 · >10% 故障）」，窗口与阈值都来自接口 | 部分实现：窗口来自接口（sandboxEnvModel.ts:127-133）；阈值在前端写死两处（sandboxEnvModel.ts:21-22，SandboxEnvStatusCard.view.tsx:57），接口不下发 |
| AC-SYS-030.6 | 组件 | Claude Code 凭证未配置 | 页面渲染 | 该行前为「停用」灰色徽标（不是虚线「未知」），可访问名「凭证未配置」 | 偏离：映射到 unknown 虚线（SandboxEnvStatusCard.view.tsx:108-111；UX-DS-133） |
| AC-SYS-030.7 | 组件 | providers 接口返回 500 | 页面渲染 | 卡内只剩读取失败句（role="alert"），没有空列表；标题旁没有统计窗口 | 已实现：SandboxEnvStatusCard.view.tsx:55-66（稿件 f-sys-conn-03） |
| AC-SYS-030.8 | 组件 | aio 的能力位含 volumeMount | 页面渲染 | 能力写「挂载代码副本」，不写「工作区」 | 偏离：写「挂载工作区目录」（sandboxEnvModel.ts:61） |

### REQ-SYS-031 · 在卡片内查看最近日志 {#REQ-SYS-031}

> 状态 `未实现` · 版本 MVP · 来源 P21-5 §6「[查看日志]」；F21-5 §5 · 关联 UX-SYS-020 · Q-SYS-05 · PARAM.PROVIDER_LOG_TAIL_LINES

沙箱环境卡片上的 [查看日志] **必须**在卡片内展开最近 `PARAM.PROVIDER_LOG_TAIL_LINES` 行运行日志（可滚动），不跳页、不弹层。

**改写了哪条旧文**：format-pilot 试点整理时按状态行「来源」所列旧文（P21-5、F21-5 等）改写成本格式，措辞差异见本条「与原文的措辞差异」（如有）；本轮未再改写（合并时补记）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-SYS-031.1 | 组件 | 某个环境处于故障 | 点 [查看日志] | 卡片内展开最近若干行日志，父节点是卡片而不是弹层 | 未实现：没有接口（SandboxEnvStatusCard.view.tsx:10-12）；F21-5 §9.1 #8 标 ✅ 不实 |

### REQ-SYS-040 · 连接状态：只报本页测到的 {#REQ-SYS-040}

> 状态 `偏离` · 版本 MVP · 来源 P21-5 §3（L33-35）、§5 第 5 行（L75）；UX-DS-306（spec/patterns.md:45）；Q-SYS-06（format-pilot 待裁决；稿件按 ① 现状出）；实现 connectionModel.ts:46-83，useSystemStatusModels.ts:49-63，ConnectionStatusCard.view.tsx:17-27 · 关联 UX-SYS-030 · Q-SYS-06 · 稿件 P5、f-sys-resource-01（首屏）、f-sys-conn-03（REST 异常）

连接卡三行，每一行的结论**只能**来自本页真正测到的事实（UX-DS-306）：

- **REST** = 本页自己的两个请求（资源、沙箱环境）：都成功 →「正常（本页数据刚取回）」；任一失败 →「异常 · 请求失败」，拿得到错误码时带上；两个请求都还没回来 →「未知」，不写「正常」。
- **WS /events**：这条通道只挂在工作台，本页不另开连接 →「未知 · 本页未测量」+ 一句原因；**不得**显示成「已断开」或「正常」。
- **终端连接**：只报数量（「0 个终端会话」/「N 个终端会话（M 个已连接）」）。终端随工作台卸载，本页通常是 0——这是事实，不是健康结论，所以**不**挂「正常」徽标。

原文要求的 /events 延迟、「已断开，等待重连…」与「上次事件推送：N 秒前」要等全局采样（Q-SYS-06 ③），本版不要求。

**改写了哪条旧文**：P21-5 L33-35、L75「REST ✅ · WS /events ✅(15ms) · 终端 2 连接 · 上次事件推送：1 秒前」「WS 🔴 已断开，等待重连…」→ 本页测不到的写「未知」并说原因，终端只报数量（Q-SYS-06 ① + UX-DS-306）。原 AC-SYS-040.3（断开时显示「已断开，等待重连…」）与 AC-SYS-040.5（上次事件推送）删去，Q-SYS-06 选 ③ 时恢复。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-SYS-040.1（改） | 组件 | 本页两个查询都成功 / 任一失败（错误信封带 code） | 页面渲染 | REST 行「正常（本页数据刚取回）」/「请求失败」+「异常」徽标 + 错误码 | 部分实现：正常 / 异常已实现（connectionModel.ts:51-61）；错误码没有传进来（useSystemStatusModels.ts:53 只传 ok）；稿件 f-sys-conn-03 也未画错误码 |
| AC-SYS-040.2（改） | 组件 | 进入本页 | 页面渲染 | /events 行「本页未测量」+「未知」虚线徽标 + 原因句；不出现「已断开」 | 已实现：connectionModel.ts:62-71 |
| AC-SYS-040.4（改） | 组件 | 工作台开着 2 个终端，切到本页 | 页面渲染 | 终端连接行「0 个终端会话」，不挂「正常」徽标 | 偏离：数量已实现（connectionModel.ts:76-81），状态写死 ok（connectionModel.ts:75）；稿件照 v1 仍画「正常」，见待确认 Q-SYS-21 |
| AC-SYS-040.6 | 组件 | 首次打开，两个查询都还没返回 | 页面渲染 | REST 行「未知」，不写「正常（本页数据刚取回）」 | 偏离：只看失败与否，首屏就写「正常」（useSystemStatusModels.ts:49）；稿件 f-sys-resource-01 照现状画，见待确认 Q-SYS-21 |

### REQ-SYS-050 · 访问保护区块 {#REQ-SYS-050}

> 状态 `未实现` · 版本 MVP（审计 P0-3 从 v1.1 提前）· 来源 P21-5 §3；P21-8 §3（规格属部署域）；F21-5 §3、§8 · 关联 Q-SYS-07

本页**必须**渲染「访问保护」区块，规格由访问口令域定义（P21-8 §3，本轮单独成域：ACC.md 的 REQ-ACC-001–006）：可启用、重新生成、关闭访问口令；已启用时只显示「已启用」，不显示掩码或明文；并显示安全边界说明。

**改写了哪条旧文**：format-pilot 试点整理时按状态行「来源」所列旧文（P21-5、F21-5 等）改写成本格式，措辞差异见本条「与原文的措辞差异」（如有）；本轮未再改写（合并时补记）。

**合并说明**：访问口令已单独成域（ACC）。按 D9 推荐（Q-SYS-07②），本轮不画这个区块、先改 README，换口令走环境变量或接口（REQ-ACC-002）；D9 回复前本条状态保持 `未实现`。2026-10-04 用户拍板 Q-ACC-01 → C：换口令时可选「同时让已登录的浏览器失效」（REQ-ACC-007）——区块做之前落在接口参数、口令横幅与 README，不另造管理页；区块做的时候在 [重新生成口令] 的确认里露出这个选项。（交叉引用：REQ-ACC-001、REQ-ACC-002、REQ-ACC-007）

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-SYS-050.1 | 组件 | 口令未启用 / 已启用 | 页面渲染 | 两态都可见；已启用时没有掩码和明文 | 未实现：page.tsx:17-18；后端 `PUT /api/system/access-passcode` 已有；F21-5 §9.1 #18 标 ✅ 不实 |

### REQ-SYS-051 · 升级与备份区块 {#REQ-SYS-051}

> 状态 `计划中` · 版本 v1.5 · 来源 P21-5 §3；P21-8 §4；F21-5 §8 · 关联 Q-SYS-14

v1.5 起在本页提供升级与备份区块，规格由部署与初始化域定义（P21-8 §4）。当前版本不要求。

**改写了哪条旧文**：format-pilot 试点整理时按状态行「来源」所列旧文（P21-5、F21-5 等）改写成本格式，措辞差异见本条「与原文的措辞差异」（如有）；本轮未再改写（合并时补记）。

### REQ-SYS-060 · 出网代理：回填、只存不重测、校验、成功与失败 {#REQ-SYS-060}

> 状态 `偏离` · 版本 MVP（Q-SYS-08 纳入）· 来源 F21-5 §3（L36-37）、L63「代理表单的复用」、L232、L244；P21-8 §2 Step 2（L25-26）、L380；design/design-notes.md v3；Q-SYS-08（plan F-SYS-CONN：纳入）；Q-DS-35 ③（plan「要拍板」默认）；UX-DS-305、UX-DS-310、UX-DS-508；实现 useProxySettings.ts:31-72，ProxySettingsCard.view.tsx:28-56，ProxyConfigForm.view.tsx:84-103，initWizardModel.ts:148-160，system.controller.ts:107-119，system-settings.service.ts:121-147，system.schema.ts:232-236，connectivity.probe.ts:161-174、364-379 · 关联 UX-SYS-070 · Q-SYS-08 · 稿件 P5（未配置）、f-sys-conn-02（保存失败）、f-sys-conn-03（读取失败）、f-sys-conn-04（保存成功）

本页**必须**提供出网代理（HTTP_PROXY / HTTPS_PROXY / NO_PROXY）的运行期修改入口，与初始化向导第 2 步共用同一份表单，本页的按钮叫「保存」。

- **回填与读取失败**：表单从已存配置回填。读到已存配置之前**不得**提供保存：读取失败时不显示表单，原位一句「出网代理读取失败 —— 读到已存的配置之前不能修改，免得把它清空」（role="alert"）+ [重试]（只重取设置）。
- **保存**：点「保存」后按钮变「保存中…」并禁用。本页**只存配置、不重新检测**（向导里才是「保存并重新检测」）：离线横幅与诊断结果保持原样，直到下一轮联网检查（横幅 [重新检测] 或诊断 [重新诊断]）。三个都留空 = 清空代理配置；只改其中一项时，另两项保持已存的值。
- **格式**：HTTP_PROXY、HTTPS_PROXY 必须是 `http://` 或 `https://` 地址（联网检查只会走 HTTP CONNECT 隧道）；不符合时这次保存失败，已存配置不变。无协议的 `host:port` 怎么处理见待确认 Q-SYS-20。
- **失败**：表单末尾、按钮之上一句「保存失败：<按错误码给的人话>」（role="alert"）；格式错误时出错的字段标红，并用 aria-describedby 关联这一句；用户输入保留。
- **成功**：同一位置一句「已保存。下一轮联网检查会走这组代理。」（role="status"；结果在原位说，不弹轻提示，UX-DS-508）；分区标题旁出中性徽标「已配置」——已存配置里有任一项时显示，三项清空并保存后去掉；不用绿色「正常」（保存只证明配置写进去了，不代表连得上、够快）。
- **说明文字**：点破「能连上 ≠ 够快」，并且只承诺真正会走这组代理的地方。

<details>
<summary>核实：保存的代理今天谁在用（plan「待核实」第 4 条）</summary>

只有联网检查读它：`ConnectivityProbe.run()` 取 `proxyOverride ?? settings.proxyConfig()`（connectivity.probe.ts:170），调用方是诊断第 ⑤ 项（outbound-network.check.ts:25）与初始化 `POST /api/system/init`（initialization.service.ts:66-70，用向导里刚填、还没落库的那份）。镜像注册与 boxlite 镜像下载走 `oci-registry.client.ts:520` 的裸 `fetch`，预制镜像经 docker-proxy 由 Docker 自己拉，git 克隆只继承 api 进程的环境变量（git-env.ts:90-99），沙箱 provider 里没有任何代理配置；api/docker-compose.yml:154-161 写明 HTTP_PROXY / HTTPS_PROXY / NO_PROXY「故意不在」api 进程的环境里。所以成功句只写「下一轮联网检查会走这组代理」，而卡片现行说明「拉取沙箱镜像、访问模型接口都走这里」与实现不符（AC-SYS-060.9）。另：`PUT /api/system/settings` 不写审计（system-settings.service.ts:130-147），表单提示里「审计日志只记 host」说的是初始化那条审计（initialization.service.ts:135）。

</details>

**改写了哪条旧文**：format-pilot REQ-SYS-060「实现先行 … 需确认是否纳入」→ 纳入规格（Q-SYS-08）；原 AC-SYS-060.2「请求体只把 NO_PROXY 置空，另两项不出现在请求体里」与实现不符——`toProxyUpdate` 把已填的两项照发、空的那项缺席，服务端整体替换 proxyConfig（initWizardModel.ts:148-160，system-settings.service.ts:133-134）→ 改为按结果验收；F21-5 L63「代理保存成功只证明配置写进去了」→ 落成中性「已配置」+ 成功句；Q-DS-35 ③「作用范围写法待核实」→ 已核实，只写联网检查；P21-8 L380「代理失效（运行期）→ 21-5 诊断引导回代理配置」→ 运行期改代理就在本卡。

**合并说明**：保存的出网代理今天只被联网检查读取（见上方核实）；IMG 域 REQ-IMG-042 的镜像页出路句原写「到「系统状态 → 出网代理」填一个代理，再点 [准备镜像] 重试」，与此矛盾。合并时按实现统一为只承诺联网检查，镜像页出路句改用不承诺代理的写法，AC-IMG-042.4 改记「计划中」；2026-10-04 用户拍板 Q-SYS-16 → A（与此相同，原话「补全 10 条按推荐」），让下载也走代理（选项 B，后端新范围）进 backlog。（交叉引用：REQ-IMG-042、AC-IMG-042.4）

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-SYS-060.1 | 组件 | 本页的代理卡 | 页面渲染 | 按钮是「保存」，页面上没有「重新检测」 | 已实现（F21-5 §7.2）：ProxySettingsCard.view.tsx:50-53 |
| AC-SYS-060.2（改） | 集成 | 已存三项，表单已回填 | 只清空 NO_PROXY 并保存，再重取设置 | HTTP_PROXY、HTTPS_PROXY 不变，NO_PROXY 为空 | 已实现：initWizardModel.ts:148-160，system-settings.service.ts:133-134 |
| AC-SYS-060.3 | e2e | 离线横幅在显示 | 在本页改代理并保存成功 | 不发起联网检查；横幅、检测时刻与诊断卡都不变 | 已实现：PUT 只存配置（system-settings.service.ts:121-147）（稿件 f-sys-conn-04） |
| AC-SYS-060.4 | API | HTTPS_PROXY 填 `socks5://127.0.0.1:7891` | 点「保存」 | 请求被拒（校验错误），已存配置不变；表单末尾「保存失败：代理地址格式不对 —— HTTPS_PROXY 要以 http:// 或 https:// 开头」（role="alert"）；HTTPS_PROXY 输入框 aria-invalid、aria-describedby 指向这一句；输入保留 | 未实现：契约只限长度（system.schema.ts:232-236），socks5 地址会被原样存下，而联网检查只走 HTTP CONNECT（connectivity.probe.ts:364-379）（稿件 f-sys-conn-02） |
| AC-SYS-060.5 | 组件 | 保存请求返回成功 | 页面渲染 | 表单末尾「已保存。下一轮联网检查会走这组代理。」（role="status"）；分区标题旁「已配置」中性徽标；没有轻提示 | 未实现：成功静默，只重取设置（useProxySettings.ts:45-50）（稿件 f-sys-conn-04） |
| AC-SYS-060.6 | 组件 | `GET /api/system/settings` 失败 | 页面渲染 | 不显示表单与「保存」；原位读取失败句（role="alert"）+ [重试]；点 [重试] 只重取设置 | 未实现：读取失败回退三个空串、照常可存（useProxySettings.ts:35-43），保存会整体替换已存配置（system-settings.service.ts:133-134）（稿件 f-sys-conn-03） |
| AC-SYS-060.7 | 组件 | 点「保存」 | 请求在途；随后返回 500 / 断网 | 在途：「保存中…」禁用、不重复提交；失败：「保存失败：<按码人话>」/「保存失败：网络不通，请稍后再试。」，输入保留 | 已实现：ProxyConfigForm.view.tsx:89-97，useProxySettings.ts:59-70 |
| AC-SYS-060.8 | 组件 | 已存配置 ① 为空 ② 有任一项 ③ 三项清空并保存成功 | 页面渲染 | 「已配置」① 不显示 ② 显示 ③ 去掉 | 未实现 |
| AC-SYS-060.9 | 组件 | 本页代理卡 | 读说明文字 | 只承诺实际走这组代理的范围（今天 = 联网检查），并点破「能连上 ≠ 够快」（稿件句：「联网检查会走这组代理；镜像下载和沙箱里的 Agent 现在还不读它。检查只测得出「能不能连上」，测不出带宽。」） | 偏离：说明写「拉取沙箱镜像、访问模型接口都走这里」（ProxySettingsCard.view.tsx:38-41），实现只有联网检查读它（见上方核实）；稿件已按 Q-SYS-16 A 改了说明（f-sys-conn-01 等 19 张，W2 一致性；2026-10-04 用户拍板 A，与默认相同） |

### REQ-SYS-070 · 首屏骨架 {#REQ-SYS-070}

> 状态 `部分实现` · 版本 MVP · 来源 T-7 / UX-DS-304（spec/patterns.md:43）；盘点 U-75；P21-3 L53、P21-4 L91（凭证页、镜像页写了骨架屏；P21-5 §5 状态矩阵 L69-77 没有加载态）；plan F-SYS-RESOURCE；实现 ResourcePoolCard.view.tsx:132-134、SandboxEnvStatusCard.view.tsx:55-68（一行「读取中…」），AuditStreamCard.view.tsx:40、155-158（5 行骨架） · 关联 UX-DS-304 · 稿件 f-sys-resource-01

直接打开本页（或缓存里还没有数据）时，资源卡与沙箱环境卡在数据回来之前**必须**显示骨架，形状同读完后的卡：资源卡 = 主数字位 + 口径句两行 + 三条水位（名称 / 徽标 / 数值 / 条，磁盘多一行路径）+ 结论块 + 成果块；沙箱环境卡 = 每个环境一行（名称 + 行尾徽标位 + 两行说明）+ Agent 两行 + 镜像读取方式一行。**不得**用一行「读取中…」或整块转圈代替；骨架换成数据时卡片高度基本不变。骨架所在的卡标 `aria-busy="true"`，并各用一句视觉隐藏的 role="status" 播报「本机资源读取中…」「沙箱环境读取中…」。审计流 5 行骨架（REQ-AUD-004）。连接卡、出网代理与诊断不等这两张卡，照常渲染、照常可操作；沙箱环境分区标题旁的「健康统计窗口」读到之前不显示。

**改写了哪条旧文**：P21-5 §5 状态矩阵（L69-77）没有加载态 → 补；spec/patterns.md:43 记录的现状「资源卡、沙箱环境卡用一行『读取中…』」→ 骨架（T-7）。直接打开设置页时外壳先出哪套骨架，归 F-WB-SHELL（REQ-WB-060–069）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-SYS-070.1 | 组件 | 资源与沙箱环境接口都还没返回 | 页面渲染 | 两张卡显示骨架，不出现「读取中…」文字行、不转圈；两张卡 aria-busy="true"；读屏念「本机资源读取中…」「沙箱环境读取中…」 | 偏离：一行「读取中…」（ResourcePoolCard.view.tsx:133，SandboxEnvStatusCard.view.tsx:68），没有 aria-busy（稿件 f-sys-resource-01） |
| AC-SYS-070.2 | 视觉 | 同上，随后两个接口正常返回 | 骨架换成数据 | 两张卡的高度变化不超过一行；骨架各块与读完后的块一一对位 | 未实现 |
| AC-SYS-070.3 | 组件 | 审计流首屏 | 页面渲染 | 5 行骨架，列表 aria-busy="true"、可访问名「审计流加载中」 | 已实现：AuditStreamCard.view.tsx:40、155-158 |
| AC-SYS-070.4 | 组件 | 资源与沙箱环境未返回，设置已返回 | 页面渲染 | 出网代理表单已回填、可编辑；诊断「尚未运行」可点；连接卡已渲染；沙箱环境标题旁没有「健康统计窗口」 | 已实现：SystemStatusContainer.tsx:67-103 各卡独立，SandboxEnvStatusCard.view.tsx:55-59 |

### REQ-SYS-071 · 主数字「还能再发 N 个任务」与口径句 {#REQ-SYS-071}

> 状态 `未实现` · 版本 MVP · 来源 D9 / Q-SYS-02 ③（SP/final/00-决策简报.md L65、L111；plan「按默认推进」）；DR-08（design-drafts/BACKLOG.md L185、L232-252）；DR-03 A（BACKLOG L115「资源卡说明句写明含已停止的」）；P21-5 L59「资源水位回答『还能再发几个 Task』」；实现 ResourcePoolCard.view.tsx:151-154（现为「当前活跃任务：N」），system.schema.ts:379-428（没有 capacity），resource-pool.domain-service.ts:132-170（准入按登记量与最小余量判定） · 关联 Q-SYS-02 · Q-SYS-12 · 稿件 f-sys-resource-02（1）、f-sys-resource-03（0）、f-sys-resource-04（6）、f-sys-conn-01（3，正常场景；f-sys-conn-02 / 04、f-sys-diag-*、f-sys-audit-* 同值）、P5（3）

资源卡的主数字回答「现在还能再发几个任务」。它**必须**取后端按创建闸门同一套准入规则推演出的值（DR-08 提议 `capacity { remainingTasks, registeredTasks, basis }`，用与 `createSandbox` 同一个 `trySchedule` 按默认配额推演）；前端**不得**用水位、活跃任务数或任务列表自己推算。

- **写法**：「还能再发 **N** 个任务」，数字保持正文色。N = 0 时 KPI 行首加失败图标（红色 circle-x），N = 1 时加警告图标（琥珀 triangle-alert），其余不加（DR-08 的色调规则；色调只给图标，P6）。
- **口径句**：「按配额登记计算：已登记 R 个任务（含已停止的），本机最多 M 个。下面的实时占用率只作参考。」——已停止的任务仍占登记（DR-03 A），所以写明「含已停止的」；异常是终态、登记已经释放，不计入（sandbox-application.service.ts:599-605）。N = 0 时句首加「新任务会被拒绝：<basis 给的原因>。」，这时不再写「只作参考」那半句。M 的来源见待确认 Q-SYS-17。
- 磁盘水位严重只做次要提示，**不改**主数字（DR-08：闸门看磁盘登记量与最小余量，不看水位等级）。
- **契约到位之前**：资源卡维持现状（水位 + 结论块里的「当前活跃任务：N」），**不**显示「还能再发」；稿件与原型里的这个数一律标「待契约 · DR-08」。

**改写了哪条旧文**：P21-5 L25「✅ 系统就绪 · 当前活跃 Task: 5」（现行实现的写法）与 L59「资源水位回答『还能再发几个 Task』」（原文目标，但没有数据来源）→ 主数字改为后端给的 `remainingTasks`（D9 / Q-SYS-02 ③）；format-pilot AC-SYS-010.6「显示当前活跃任务数」降为契约到位前的过渡写法（AC-SYS-071.5）。

**合并说明**：新建任务弹层里资源不够那句（REQ-LCH-007「已满（R / M）」）用同一组数，随本条与 Q-SYS-17 一起落地。（交叉引用：REQ-LCH-007）

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-SYS-071.1 | API | 契约到位 | `GET /api/system/resources` | 带 `capacity.remainingTasks`、`registeredTasks`（含已停止）与 `basis`；同一时刻按默认配额发起新任务，被拒当且仅当 `remainingTasks = 0` | 未实现：契约没有 capacity（system.schema.ts:379-428；DR-08） |
| AC-SYS-071.2 | 组件 | `remainingTasks = 0`，`basis` 指向磁盘 | 页面渲染 | 「还能再发 0 个任务」+ 红色 circle-x；口径句以「新任务会被拒绝：<basis 的原因>。」开头（稿件示例「磁盘已用 96%」） | 未实现（稿件 f-sys-resource-03） |
| AC-SYS-071.3 | 组件 | `remainingTasks` 为 1 / 3 | 页面渲染 | 1：琥珀 triangle-alert；3：没有图标；两种情况数字都是正文色（3 = 正常场景，示例口径句「已登记 8 个任务（含已停止的），本机最多 11 个」：8 = 示例世界里没异常的任务，11 是待契约示例值） | 未实现（稿件 f-sys-resource-02；3 见 f-sys-conn-01 等正常场景稿与 P5） |
| AC-SYS-071.4 | 组件 | 3 个运行中、2 个已停止的任务 | 页面渲染 | 口径句写「已登记 5 个任务（含已停止的）」 | 未实现（DR-03 A） |
| AC-SYS-071.5 | 组件 | 响应里没有 `capacity`（契约到位前） | 页面渲染 | 不出现「还能再发」；结论块写「当前活跃任务：N」；前端没有任何推算 N 的逻辑 | 已实现：ResourcePoolCard.view.tsx:151-154（现状即过渡写法） |

### REQ-SYS-075 · 后端不可达时本页：各卡原位说、横幅不自指 {#REQ-SYS-075}

> 状态 `部分实现` · 版本 MVP · 来源 UX-DS-303、UX-DS-305、UX-DS-306（spec/patterns.md:42-45）；T-8 / UX-DS-311（spec/patterns.md:50）；plan F-SYS-CONN；v1 g6-14；实现 globalBanner.ts:65-77，GlobalBannerContainer.tsx:50-53，ResourcePoolCard.view.tsx:125-131，SandboxEnvStatusCard.view.tsx:62-66，connectionModel.ts:51-61，useProxySettings.ts:35-43，AuditStreamCard.view.tsx:141-150 · 稿件 f-sys-conn-03

读平台初始化状态失败（后端没起来或不可达）时，主列顶部出阻断横幅「无法确认平台状态」（位置、文案与堆叠归 F-WB-BANNER）；在本页上这条横幅**不**放「查看系统状态」（指向当前页，T-8 / UX-DS-311），只留 ×。本页每张卡各自原位说清自己读没读到，**不**用整页错误或遮罩盖住：资源卡、沙箱环境卡各一句读取失败（REQ-SYS-010、REQ-SYS-030）；连接卡 REST「异常 · 请求失败」；出网代理不显示表单（AC-SYS-060.6）；诊断照常可点（跑不通由诊断自己报，REQ-DIA-001）；审计流「审计流加载失败」+ [重试]（REQ-AUD-004）。后端恢复后，30 秒轮询或资源卡 [刷新] 让资源与沙箱环境两张卡复原。

**改写了哪条旧文**：P21-5 没有写后端不可达时本页怎么显示（只在 spec/patterns.md:44-45 与 v1 g6-14）→ 补；现状横幅动作「查看系统状态」在本页也显示（globalBanner.ts:75）→ 本页隐藏（format-pilot AC-SYS-001.3 只管从别处点它跳来）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-SYS-075.1 | e2e | `GET /api/system/init-status` 失败 | 打开本页 | 横幅「无法确认平台状态」只有 ×，没有「查看系统状态」 | 偏离：本页仍显示「查看系统状态」，点了跳回本页（globalBanner.ts:75，GlobalBannerContainer.tsx:50-53） |
| AC-SYS-075.2 | 集成 | 后端整体不可达（本页所有请求失败） | 页面渲染 | 资源卡、沙箱环境卡各一句读取失败（role="alert"），没有 0%、空条或空列表；连接卡 REST「异常」；出网代理不显示表单；诊断「尚未运行」可点；审计流失败 + [重试]；没有遮罩 | 部分实现：出网代理仍显示可保存的空表单（AC-SYS-060.6），其余已实现（稿件 f-sys-conn-03） |
| AC-SYS-075.3 | 集成 | 同上，后端随后恢复 | 等一个轮询周期，或点资源卡 [刷新] | 资源卡与沙箱环境卡恢复显示，REST 回到「正常」 | 已实现：useSystemStatus.ts:87-98、195-198 |

### REQ-SYS-076 · 离线时本页：横幅 [重新检测] 就地跑诊断 {#REQ-SYS-076}

> 状态 `已实现` · 版本 MVP · 来源 P21-8 §1（L12 物理约束）、§5（L379「离线模式：Agent 不可用 [重新检测]」）；T-8 / UX-DS-311；v1 g6-13；实现 globalBanner.ts:79-92，connectivityVerdict.ts:132-139，useGlobalBanner.ts:57-92，GlobalBannerContainer.tsx:50-53，useSystemStatus.ts:178-191 · 稿件 f-sys-conn-02、f-sys-conn-04

最近一次联网检查判定模型 API 全部连不上时，主列顶部出阻断横幅「离线模式：Agent 不可用」，说明末尾带上次检测时刻（「（上次检测：<本机时间>（<多久前>））」）。[重新检测] 在本页**保留**，因为它在本页可用：点了不跳页，直接开始一轮诊断（与诊断卡 [重新诊断] 同一路径）；这一轮第 ⑤ 项通过后横幅消失。离线时本页其余部分照常可用（资源、沙箱环境、出网代理可读可存）；横幅只随下一轮联网检查更新，**不**因保存代理而消失（AC-SYS-060.3）。

**改写了哪条旧文**：无冲突；P21-8 L379 的横幅规则落到本页（v1 g6-13 漏了检测时刻那半句，按现状补）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-SYS-076.1 | e2e | 最近一次联网检查结论为离线 | 打开本页 | 横幅「离线模式：Agent 不可用」，说明末尾「（上次检测：2026-10-02 14:31:05（刚刚））」这样的时刻；有 [重新检测] 与 × | 已实现：globalBanner.ts:79-92，connectivityVerdict.ts:132-139（稿件 f-sys-conn-02） |
| AC-SYS-076.2 | e2e | 同上，在本页 | 点横幅 [重新检测] | 留在本页，诊断卡开始一轮；第 ⑤ 项通过后横幅消失 | 已实现：GlobalBannerContainer.tsx:50-53 → useSystemStatus.ts:178-191；横幅优先取最新一轮诊断的第 ⑤ 项（useGlobalBanner.ts:57-92） |

## DIA · 一键诊断

### REQ-DIA-001 · 一键诊断：触发、连接中、不阻塞、可重复、结果保留 {#REQ-DIA-001}

> 状态 `部分实现` · 版本 MVP · 来源 P21-5 §6「[重新诊断]」（L86）、§9 第 1 条；F21-5 §2、§4、§9.1 #10 #11 #20；UX-DS-204、UX-DS-508；实现 DiagnosticsCard.view.tsx:59-71、93-104，diagnoseModel.ts:98-105，useSystemStatus.ts:40、57-58、109-120、170-191 · 关联 UX-SYS-040 · PARAM.DIAG_RESULT_KEEP_MIN · 稿件 f-sys-diag-01（首次连接中）、f-sys-diag-02（占位与逐项到达）

用户点 [重新诊断] 跑一轮诊断。点下之后按钮**必须**变成「诊断中…」并禁用（加载中写法：前缀转圈），同卡的 [导出日志] 照常可点；页面其他区域**必须**照常可用（无遮罩、无禁用）。服务端下发检查清单（首帧）之前，卡内首行**必须**说「正在连接诊断流…（检查清单由服务端下发）」并以 role="status" 播报，**不得**用本地抄来的清单画占位；不是第一次跑时，用上一轮首帧的清单原地占位（全部「检查中…」），不先清空再长出来。诊断可以重复执行；同一时刻只有一轮在写结果，新一轮开始后旧一轮的迟到结果**不得**混入。离开页面再回来，`PARAM.DIAG_RESULT_KEEP_MIN` 分钟内结果**必须**还在。从全局横幅 [重新检测] 进入本页时**必须**自动开始一轮（REQ-SYS-001）。

**改写了哪条旧文**：P21-5 L86 一格同时写了「触发」与「清单」——触发、不阻塞留在本条，清单与顺序移到 REQ-DIA-002；F21-5 §5 L156「从横幅 [诊断] 进入：路由携带 `?autorun=1`（可选）」→ 按实现改为「横幅只留一个一次性的自动诊断意图，本页消费后立即清掉」（useSystemStatus.ts:178-191；深链 `?autorun=1` 不生效，今天也没有地方产出这种链接）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-DIA-001.1 | 集成 | 诊断进行中 | 点沙箱环境卡或审计区的任意交互 | 交互照常生效，页面无遮罩、无禁用 | 已实现：DiagnosticsCard.view.tsx:7-8 |
| AC-DIA-001.2 | 集成 | 诊断已完成 | 切到 `/settings/images` 再切回 | 结果仍在 | 已实现：useSystemStatus.ts:40、57-58（gcTime 30 分钟） |
| AC-DIA-001.3 | 集成 | 一轮诊断尚未结束 | 再触发一轮 | 旧一轮的迟到结果不写入，只显示新一轮 | 已实现：useSystemStatus.ts:109-120 |
| AC-DIA-001.4 | 组件 | 第一次运行，首帧还没到 | 点 [重新诊断] | 按钮「诊断中…」禁用并带转圈；[导出日志] 仍可点；卡内首行「正在连接诊断流…（检查清单由服务端下发）」以 role="status" 播报；不画任何检查项 | 部分实现：文案、禁用、[导出日志] 可点已实现（DiagnosticsCard.view.tsx:64-70、93-96）；按钮没有转圈、该句没有 role="status"（稿件 f-sys-diag-01） |
| AC-DIA-001.5 | e2e | 工作台出现「离线模式」横幅 | 点 [重新检测] | 跳到系统状态页并自动开始一轮（先看到 AC-DIA-001.4 的连接中） | 已实现：useGlobalBanner.ts:110、174 → useSystemStatus.ts:185-191（与 AC-SYS-001.2 同一路径） |
| AC-DIA-001.6 | 组件 | 上一轮已结束（9 项都有结果、首行是汇总句） | 再点 [重新诊断] | 9 行原位变回「检查中…」，不先清空再长出来；首行汇总句清空；按钮「诊断中…」禁用 | 已实现：diagnoseModel.ts:98-105（沿用上一轮首帧清单、清掉结果与 done）；按钮转圈同 AC-DIA-001.4 未实现（稿件 f-sys-diag-02 为这一形态的参照） |

### REQ-DIA-002 · 检查项清单以首帧为准（现为 9 项）、固定顺序、逐项到达 {#REQ-DIA-002}

> 状态 `偏离` · 版本 MVP（⑧ v1.1 新增；⑨ 实现先行，api db386b6，2026-09-22）· 来源 P21-5 §6 L86、L76、§9A；P22 L151；F21-5 §5A 第 1、2 条；契约 sse-protocol.ts:39-54；UX-DS-308、UX-DS-312；Q-DIA-01 ①（按实现纳入 9 项；format-pilot 待裁决清单里仍开着）· 关联 UX-SYS-040 · Q-DIA-01 · 稿件 f-sys-diag-02

诊断的检查项清单与展示顺序**必须**以服务端首帧（`start.checks`）为准，前端不另存清单；现行为 9 项（下表）。各项并行执行、展示位置固定：已返回的项立即定格（状态、耗时、一句结论），未返回的项显示「检查中…」，没有结论句、没有展开按钮；第 ⑤ 项未返回时也显示「超时时限 N s」（N 来自首帧）。每一项都有序号（含第 ⑨ 项）。增删检查项属于产品变更；界面与文档不写死「八项」「九项」。

| # | 检查项 id | 回答的问题 | 来源 |
|---|---|---|---|
| ① | `container-runtime` | 容器服务在不在、是不是真的容器运行时 | P21-5 §6、§9F |
| ② | `dev-kvm` | 这台机器能不能跑轻量虚拟机（boxlite） | P21-5 §6、§9F |
| ③ | `disk-space` | 数据目录所在磁盘还够不够 | P21-5 §6 |
| ④ | `port-conflict` | 平台要用的端口有没有被占、被谁占 | P21-5 §6、§9B |
| ⑤ | `outbound-network` | 模型 API 与镜像下载源连不连得上 | P21-5 §6、§9D、§9E |
| ⑥ | `ws-loopback` | 实时推送通道自己通不通 | P21-5 §6 |
| ⑦ | `data-root-fs` | 数据目录的文件系统是什么、支不支持写时复制 | P21-5 §6、§9D |
| ⑧ | `preset-image` | 平台自己的预制镜像备齐了没有 | P21-5 §9A |
| ⑨ | `auth-helper` | 帐号登录环境起没起来 | 实现先行（api db386b6）；Q-DIA-01 ① 按实现纳入 |

**改写了哪条旧文**：P21-5 L86「诊断项按固定顺序展示：①…⑧」、P22 L151 的八项清单、F21-5 L310 / L388「固定八项」→「以首帧清单为准（现为 9 项）」；P21-5 L76「运行中逐项 spinner / 完成后每项 ✅⚠️❌」→ AC-DIA-002.4（未返回 =「检查中…」徽标，已返回 = 状态徽标 + 耗时 + 结论句）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-DIA-002.1 | 集成 | 服务端首帧下发 N 项清单 | 首帧到达、尚无任何结果 | 立即画出 N 个占位，顺序与首帧一致 | 已实现：diagnoseModel.ts:108-115、212-216 |
| AC-DIA-002.2 | 集成 | 第 ⑥ 项最先完成、第 ① 项最后完成 | 结果陆续到达 | 每项落在自己的固定位置，不按到达顺序追加 | 已实现：diagnoseModel.ts:118-123 |
| AC-DIA-002.3（改） | 组件 | 服务端清单为 9 项 | 页面渲染 | 9 项都有序号 ①–⑨（原文「都有序号标识」，验证层由集成改为组件） | 偏离：只备 ①–⑧，第 9 项不显示序号（DiagnosticItem.view.tsx:59、79、93）；format-pilot B-03 建议直接修 |
| AC-DIA-002.4 | 组件 | 9 项里 ②③⑥⑨ 已返回 | 页面渲染 | 已返回的 4 项：状态徽标 + 耗时 + 结论句 + [展开详情]；其余 5 项：「检查中…」转圈徽标，没有结论句、没有展开按钮；第 ⑤ 项显示「超时时限 10s」（数字来自首帧） | 已实现：DiagnosticItem.view.tsx:75-142，diagnoseModel.ts:149-166（稿件 f-sys-diag-02） |

### REQ-DIA-003 · 单项时限、超时不等于失败、断开时保留已到结果 {#REQ-DIA-003}

> 状态 `偏离` · 版本 MVP · 来源 P21-5 §6 时序图注（L108）、§9E；P21-8 L288、L407；F21-5 §5、§8；UX-DS-308 / DR-22；Q-DS-21 A（定稿词「超时未响应」）；实现 diagnostics.service.ts:38、127-145，initialization.service.ts:66-67，diagnoseModel.ts:133-139、222-229，DiagnosticsCard.view.tsx:82-91，DiagnosticItem.view.tsx:44-52、75-76、101-103 · 关联 ADR-0101 · PARAM.DIAG_ITEM_TIMEOUT_MS · Q-DIA-02 · 稿件 f-sys-diag-03、f-sys-diag-04

每一项有 `PARAM.DIAG_ITEM_TIMEOUT_MS` 毫秒的时限（现值 10000，诊断与初始化向导的联网检查共用这一个数）；界面上的「超时时限 N s」只读首帧 `start.timeoutMs`，文档与界面**不得**另写秒数。超时的项**必须**显示为「超时未响应」（时钟图标、超时色调，不是红），**不得**显示为失败，也**不得**挡住其他项；一轮诊断的最长耗时约等于单项时限，而不是各项之和。

诊断流中途断开时：已返回的结果**必须**一条不清；卡内首行**必须**出现中断句（role="alert"）——拿到清单之后断开：「诊断中断：k/N 项已返回，其余项没有结论 —— 已到达的结果保留在下方，可点 [重新诊断] 重跑」；拿到清单之前断开：「诊断中断：连接在拿到检查清单之前就断了 —— 可点 [重新诊断] 重跑」。未返回的项**必须**标「未返回」（虚线徽标），**不得**继续显示转圈的「检查中…」（UX-DS-308：转圈等于说「还在查」，而这一轮已经不会再有结果）。[重新诊断] 恢复可点。

**改写了哪条旧文**：P21-5 L108 时序图注「单项超时 10s」、P21-8 L288 与 L407「单项超时 5s」、F21-8 L48 与 L250「单项超时 5s」、接口描述 system.controller.ts:199 与 api/openapi.json:2418、web/openapi.json:2418「单项超时 5s」、契约注释 sse-protocol.ts:66「5s 内没查出来」→ 一律引用 `PARAM.DIAG_ITEM_TIMEOUT_MS`（format-pilot C-02、B-02）；原 REQ-DIA-003「显示为『没有得出结论』」→「超时未响应」（Q-DS-21 A；Q-DIA-02 仍开着时以定稿词出稿）；原 AC-DIA-003.4「超时时限 10 秒」→「超时时限 10s」（界面实际写法，diagnoseModel.ts:149-152 用 formatDurationMs）；新增中断句的两种写法与「未返回」。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-DIA-003.1 | API | 某一项卡住超过时限 | 跑一轮诊断 | 这一项以 timeout 返回，其余项照常返回 | 已实现：diagnostics.service.ts:127-145 |
| AC-DIA-003.2（改） | 组件 | 收到一条超时结果 | 页面渲染 | 徽标「超时未响应」（时钟、超时色调），结论句「10 秒内没有结果」，默认展开；不出现「失败」 | 偏离：徽标文字是「未得出结论」（DiagnosticItem.view.tsx:50-51）；定稿词见 Q-DS-21 A，Q-DIA-02 待裁决（稿件 f-sys-diag-04） |
| AC-DIA-003.3（改） | 集成 | 进行中，已返回 5 项 | 连接中断 | 5 项保留；卡内首行出现中断句（role="alert"，「5/9 项已返回」）；[重新诊断] 恢复可点 | 已实现：diagnoseModel.ts:137-139、222-229，DiagnosticsCard.view.tsx:82-91（位置在卡头下方单独一行；稿件 f-sys-diag-03 放在卡内首行左侧） |
| AC-DIA-003.4（改） | 集成 | 首帧带时限 10000 毫秒 | 第 ⑤ 项渲染（未返回时也显示） | 显示「超时时限 10s」，数字来自首帧，不是前端写死 | 已实现：diagnoseModel.ts:149-152、159-165 |
| AC-DIA-003.5 | 组件 | 首帧还没到 | 连接中断 | 首行中断句「诊断中断：连接在拿到检查清单之前就断了 —— 可点 [重新诊断] 重跑」，不画占位 | 部分实现：前半句已实现（diagnoseModel.ts:224-226）；后半句固定拼「—— 已到达的结果保留在下方，…」（DiagnosticsCard.view.tsx:89），没有结果时这半句不成立 |
| AC-DIA-003.6 | 组件 | 中断时还有 4 项没返回 | 页面渲染 | 这 4 项显示「未返回」虚线徽标，不转圈、没有结论句、没有展开按钮 | 偏离：仍显示转圈的「检查中…」（DiagnosticItem.view.tsx:75-76、101-103）（稿件 f-sys-diag-03） |
| AC-DIA-003.7 | 文档 | — | 检查产品文档、前端文档、接口描述与契约注释里的单项时限 | 只引用 `PARAM.DIAG_ITEM_TIMEOUT_MS`，不出现 5 秒 / 10 秒字面量 | 偏离：P21-8 L288、L407，F21-8 L48、L250，system.controller.ts:199，api/openapi.json:2418 与 web/openapi.json:2418，sse-protocol.ts:66 仍写 5s；实际 10000（diagnostics.service.ts:38） |

### REQ-DIA-004 · 结论语义：提示、超时、无法判定 {#REQ-DIA-004}

> 状态 `已实现` · 版本 MVP · 来源 P21-5 §9D「⑦」末段、§9E（第二个）、§9F「②」末段；F21-5 §5A 第 3 条 · 关联 REQ-SYS-014 · ADR-0106

- 「提示」表示没有需要修的东西，**必须**以提示呈现，**不得**呈现为警告。
- 「超时」不等于「失败」（REQ-DIA-003）。
- 读数测不准、无法判定时，**不得**给出负面结论：文件系统写时复制「无法判定」为提示；虚拟化支持读不出来时不判坏；内存测不准不判耗尽（REQ-SYS-014）。
- 在某类机器上恒定出现的结论**必须**是安静的提示，**不得**是常亮的警告。

**改写了哪条旧文**：format-pilot 试点整理时按状态行「来源」所列旧文（P21-5、F21-5 等）改写成本格式，措辞差异见本条「与原文的措辞差异」（如有）；本轮未再改写（合并时补记）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-DIA-004.1 | 集成 | 一项返回「提示」 | 页面渲染 | 显示为「提示」样式，不是「警告」 | 已实现：DiagnosticItem.view.tsx:44-51 |
| AC-DIA-004.2 | API | macOS 机器 | 跑第 ⑦ 项 | 写时复制结论为「无法判定」（提示），不给更换文件系统的建议 | 已实现：data-root-fs.check.ts（df6213b） |
| AC-DIA-004.3 | API | macOS 上读不出虚拟化支持标志 | 跑第 ② 项 | 不判为失败 | 已实现：dev-kvm.check.ts（eceb879） |

### REQ-DIA-005 · 判据总纲：一项检查报多重，取决于「谁需要它」 {#REQ-DIA-005}

> 状态 `已实现` · 版本 MVP · 来源 P21-5 §9F「判据总纲」· 关联 ADR-0105

一项依赖缺失时报多重，**必须**取决于当前默认沙箱环境需不需要它。默认环境按宿主平台决定（macOS 为 boxlite，其余为 aio），以平台登记的默认环境为准（第三方可以改变默认环境）。

| 这一项依赖 | 默认环境需要它 | 默认环境不需要它 | 默认环境是第三方 |
|---|---|---|---|
| 在 | 正常 | 正常 | 正常 |
| 不在 | 失败（挡住开箱即用的路） | 提示，如实说「当前默认环境不需要它」 | 警告：「不知道它要不要」，不猜 |

**改写了哪条旧文**：format-pilot 试点整理时按状态行「来源」所列旧文（P21-5、F21-5 等）改写成本格式，措辞差异见本条「与原文的措辞差异」（如有）；本轮未再改写（合并时补记）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-DIA-005.1 | API | 默认环境为 boxlite，docker 不在 | 跑第 ① 项 | 提示「当前默认环境不需要它」，不是失败 | 已实现：container-runtime.check.ts:36、78-81、108 |
| AC-DIA-005.2 | API | 默认环境为 aio（Linux），`/dev/kvm` 不在 | 跑第 ② 项 | 提示，且不给任何操作建议 | 未核实：据原文已修（P21-5 §9F 末段），本试点未核代码 |
| AC-DIA-005.3 | API | 默认环境是第三方 | 跑第 ①、② 项且依赖不在 | 警告「不知道它要不要」 | 未核实 |

### REQ-DIA-006 · 每项结论的呈现：结论、证据、下一步、可复制命令 {#REQ-DIA-006}

> 状态 `已实现` · 版本 MVP · 来源 P21-5 §5「诊断运行中/完成」、§6「修复建议」；F21-5 §5、§5A 第 6、7 条 · 关联 UX-SYS-041

每项**必须**给出一句结论；需要用户动手时**必须**给出下一步，能用命令表达的给出可一键复制的命令。只有命令可以复制；说明性文字不提供复制按钮。

**改写了哪条旧文**：format-pilot 试点整理时按状态行「来源」所列旧文（P21-5、F21-5 等）改写成本格式，措辞差异见本条「与原文的措辞差异」（如有）；本轮未再改写（合并时补记）。

**合并说明**：[复制] 在非 HTTPS 部署下（`navigator.clipboard` 不存在）没有任何反馈：SystemStatusContainer.tsx:38 与终端 [复制] 同一写法（AC-WB-063.4）；本条的 AC 只覆盖了成功路径。（交叉引用：AC-WB-063.4）

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-DIA-006.1 | 组件 | 一项带命令建议 | 点 [复制] | 剪贴板内容等于命令原文，并提示「已复制」 | 已实现：SystemStatusContainer.tsx:37-47 |
| AC-DIA-006.2 | 组件 | 一项只有文字说明、没有命令 | 页面渲染 | 没有 [复制] 按钮 | 已实现：F21-5 §5 |

### REQ-DIA-010 · ① 容器服务：通了要有证据，不需要它时不报错 {#REQ-DIA-010}

> 状态 `已实现` · 版本 MVP · 来源 P21-5 §9F「① 容器运行时」· 关联 REQ-DIA-005 · ADR-0105

判「正常」**必须**有证据：确认对端是一个真正在工作的容器运行时，而不只是套接字文件存在或端口能连上；否则如实说「有服务在应答，但它不像一个容器运行时」。默认环境不需要容器服务时，按 REQ-DIA-005 报提示。

**改写了哪条旧文**：format-pilot 试点整理时按状态行「来源」所列旧文（P21-5、F21-5 等）改写成本格式，措辞差异见本条「与原文的措辞差异」（如有）；本轮未再改写（合并时补记）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-DIA-010.1 | API | 套接字文件存在但容器服务已停 | 跑第 ① 项 | 不判正常 | 已实现：container-runtime.check.ts（eceb879） |
| AC-DIA-010.2 | API | 对端是一个普通 HTTP 服务 | 跑第 ① 项 | 「有服务在应答，但它不像一个容器运行时」 | 已实现：同上 |

### REQ-DIA-011 · ② 轻量虚拟机：按平台问对的问题 {#REQ-DIA-011}

> 状态 `已实现` · 版本 MVP · 来源 P21-5 §9F「② /dev/kvm」· 关联 REQ-DIA-005 · ADR-0105 · Q-DIA-02

| 平台 | 判据 | 满足时 |
|---|---|---|
| macOS | Apple Silicon（Intel 官方标注 coming soon）、macOS 12 及以上、系统虚拟化框架可用 | 正常 |
| Linux | `/dev/kvm` 可读写 | 正常 |
| 其他 | — | 提示「boxlite 不支持此平台」，**不提** `/dev/kvm` |

检查项的展示名**不得**写成某个平台的实现细节（例如在 macOS 上显示「/dev/kvm 可用」）。检查项 id 保持不变。

**改写了哪条旧文**：format-pilot 试点整理时按状态行「来源」所列旧文（P21-5、F21-5 等）改写成本格式，措辞差异见本条「与原文的措辞差异」（如有）；本轮未再改写（合并时补记）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-DIA-011.1 | API | Apple Silicon、macOS 12 及以上 | 跑第 ② 项 | 正常 | 已实现：dev-kvm.check.ts:15-21、42-43 |
| AC-DIA-011.2 | API | Windows 或其他平台 | 跑第 ② 项 | 提示，文案中不出现 `/dev/kvm` | 未核实 |

### REQ-DIA-012 · ③ 磁盘余量 {#REQ-DIA-012}

> 状态 `部分实现` · 版本 MVP · 来源 P21-5 §6；与 REQ-SYS-012 同阈值；format-pilot REQ-DIA-012（本条只补下一步的用词）；Q-SYS-23 A、Q-SBX-03 A（用户拍板 2026-10-04，原话「补全 10 条按推荐」）· 关联 Q-DIA-04 · REQ-SYS-012 · REQ-SYS-020 · PARAM.DISK_WARN_PCT · PARAM.DISK_CRITICAL_PCT · PARAM.DISK_MIN_FREE_GB · 稿件 f-sys-diag-01…06（第 ③ 项）

测的是数据目录所在的文件系统，与本机资源卡的磁盘使用同一组阈值。实现另有一条「可用空间低于 `PARAM.DISK_MIN_FREE_GB` GB 也告警」的规则，原文没有，见 Q-DIA-04。这一项告警或失败时，下一步与资源卡同一口径（REQ-SYS-012）：「先清理保留下来的成果（系统状态「成果占用」那一行的 [清理成果]），或删掉不用的项目。」——**不得**再写「保留卷」「保留卷占用」「工作区」（Q-SYS-23 A、Q-SBX-03 A）。

**改写了哪条旧文**：format-pilot REQ-DIA-012 沿用；实现的下一步「先清保留卷（系统状态页「保留卷占用」）或删掉已完成任务的工作区。」→ 上面那句（Q-SYS-23 A，用户拍板 2026-10-04：资源卡那一行改叫「成果占用」，原句会指向一个不存在的标签）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-DIA-012.1 | API | 磁盘使用率 90% | 跑第 ③ 项 | 失败，结论说明挡住新任务 | 已实现：disk-space.check.ts:77-81 |
| AC-DIA-012.2 | API | 磁盘使用率 80%（警告） | 跑第 ③ 项 | 下一步写「先清理保留下来的成果（系统状态「成果占用」那一行的 [清理成果]），或删掉不用的项目。」；不出现「保留卷」「工作区」 | 偏离：「先清保留卷（系统状态页「保留卷占用」）或删掉已完成任务的工作区。」（disk-space.check.ts:118） |

### REQ-DIA-013 · ④ 端口占用：说清被谁占了 {#REQ-DIA-013}

> 状态 `已实现` · 版本 v1.1 修订 · 来源 P21-5 §9B · 关联 INC-0102

端口被占时，结论**必须**包含：端口号、占用它的进程名与 pid、平台原本要用它做什么。检查的是平台**配置的**端口，不是写死的 3000。

**改写了哪条旧文**：format-pilot 试点整理时按状态行「来源」所列旧文（P21-5、F21-5 等）改写成本格式，措辞差异见本条「与原文的措辞差异」（如有）；本轮未再改写（合并时补记）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-DIA-013.1 | API | 平台端口被另一个进程占用 | 跑第 ④ 项 | 结论含端口号、进程名、pid、平台的用途 | 已实现：port-conflict.check.ts:64-89 |
| AC-DIA-013.2 | API | 用户把端口改成 3100，3000 被占 | 跑第 ④ 项 | 不报 3000 | 已实现：只检查 `env.port`（port-conflict.check.ts:44-51） |
| AC-DIA-013.3 | API | 监听该端口的正是平台自己 | 跑第 ④ 项 | 正常，不算冲突 | 实现先行：原文没写这条（port-conflict.check.ts:35-37、64） |
| AC-DIA-013.4 | API | 查不出占用者（无权限或无 lsof） | 跑第 ④ 项 | 如实说「没能查证」，不判冲突也不判正常 | 实现先行：port-conflict.check.ts:100-112 |

### REQ-DIA-014 · ⑤ 外网连通：按证据强弱下结论 {#REQ-DIA-014}

> 状态 `已实现` · 版本 MVP（v1.1 起多次修订）· 来源 P21-5 §9D「⑤」、§9E（第一个）、9C-a 小节、§9F「⑤」· 关联 UX-SYS-042 · ADR-0101 · ADR-0102 · ADR-0105 · ADR-0113 · INC-0103 · INC-0107 · INC-0108 · INC-0109 · INC-0112

**探测对象**：已注册的各个 Agent 申报的模型 API 端点，加上预制镜像所在的镜像下载源。没有任何 Agent 注册时，**不得**判为离线。

**结论分档按证据强弱，不按成败**：

| 失败形态 | 结论 | 说什么 |
|---|---|---|
| 模型 API 全部**超时** | 警告 | 都没在时限内应答，**这不等于连不上**；下一步：再跑一次，偶发多半只是慢，每次都这样再按不通处理 |
| 模型 API **够不着**（连接被拒、域名解析不了、被重置） | 失败 | 宣布离线，这一档证据确凿 |
| 混合（有超时也有够不着） | 失败 | 按证据强的走，但两种失败各说各的，不合并成一个词 |

**逐条展示**：每个目标分别显示「连得上」「超时未响应」「连不上」，超时与连不上**不得**合并。部分目标失败时的总结句**必须**按失败的是哪一类分别说，且不点名具体目标。

**本机镜像下载源**：地址带端口的本机下载源（如 `localhost:5001`）**必须**被正确判断；本机下载源不经过代理；它不通时，建议里**不得**提代理。外部下载源不因为带了端口就放宽安全校验。用户配置的「不走代理清单」**必须**生效。本机下载源的建议**必须**说清谁需要它、为什么需要，并给出不依赖 docker 的做法。

**改写了哪条旧文**：format-pilot 试点整理时按状态行「来源」所列旧文（P21-5、F21-5 等）改写成本格式，措辞差异见本条「与原文的措辞差异」（如有）；本轮未再改写（合并时补记）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-DIA-014.1 | API | 只注册了一个第三方 Agent | 跑第 ⑤ 项 | 探测的是它申报的端点，不探 anthropic/openai | 已实现：connectivity.probe.ts:105-140（cae6473）；P21-5 的 9C-a 小节仍写「待修」，已过期 |
| AC-DIA-014.2 | API | 没有任何 Agent 注册 | 跑第 ⑤ 项 | 不判离线 | 已实现：outbound-network.check.ts:80 |
| AC-DIA-014.3 | API | 模型 API 全部超时 | 跑第 ⑤ 项 | 警告，不宣布离线 | 已实现（ADR-0102） |
| AC-DIA-014.4 | API | 模型 API 全部连接被拒 | 跑第 ⑤ 项 | 失败，宣布离线 | 已实现 |
| AC-DIA-014.5 | 组件 | 一个目标超时、一个连不上 | 页面渲染 | 两行分别显示「超时未响应」「连不上」 | 已实现：connectivityVerdict.ts:79-90（50d11ec） |
| AC-DIA-014.6 | API | 本机下载源 `localhost:5001` 正常应答 | 跑第 ⑤ 项 | 判为连得上 | 已实现（INC-0103） |
| AC-DIA-014.7 | API | 本机下载源不通 | 跑第 ⑤ 项 | 建议里不出现「代理」 | 已实现（INC-0103） |
| AC-DIA-014.8 | API | 默认环境为 boxlite、机器上没有 docker、本机下载源不通 | 跑第 ⑤ 项 | 建议包含一条不依赖 docker 的做法 | 已实现（eceb879） |

### REQ-DIA-015 · ⑥ 实时推送自检 {#REQ-DIA-015}

> 状态 `已实现` · 版本 MVP · 来源 P21-5 §6 · 关联 Q-DIA-02

检查平台自己的实时推送通道是否通畅。原文对这一项没有更多规定。

**改写了哪条旧文**：format-pilot 试点整理时按状态行「来源」所列旧文（P21-5、F21-5 等）改写成本格式，措辞差异见本条「与原文的措辞差异」（如有）；本轮未再改写（合并时补记）。

### REQ-DIA-016 · ⑦ 数据目录文件系统：写时复制三态 {#REQ-DIA-016}

> 状态 `已实现` · 版本 MVP · 来源 P21-5 §5 最后一行、§9D「⑦」· 关联 REQ-DIA-004 · ADR-0106 · INC-0104

**必须**按平台报出数据目录的文件系统名称。写时复制支持分三态：支持（正常，说明加速就绪）；不支持（警告，建议换 Btrfs/XFS）；无法判定（提示，用于非 Linux 平台，说明为什么谈不上写时复制，且**不给**任何建议）。探测**必须**走平台实际会用的那条复制路径。

**改写了哪条旧文**：format-pilot 试点整理时按状态行「来源」所列旧文（P21-5、F21-5 等）改写成本格式，措辞差异见本条「与原文的措辞差异」（如有）；本轮未再改写（合并时补记）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-DIA-016.1 | API | macOS（APFS） | 跑第 ⑦ 项 | 文件系统名为 apfs，写时复制「无法判定」，无建议 | 已实现：data-root-fs.check.ts（df6213b） |
| AC-DIA-016.2 | API | Linux ext4 | 跑第 ⑦ 项 | 「不支持」，建议换 Btrfs/XFS | 未核实 |

### REQ-DIA-017 · ⑧ 预制镜像就绪：五步检查链，不得合并 {#REQ-DIA-017}

> 状态 `已实现` · 版本 v1.1 新增 · 来源 P21-5 §9A；F21-5 §5A 第 4、5 条 · 关联 UX-SYS-043 · ADR-0103 · ADR-0104 · INC-0101 · Q-DIA-02

这一项回答「平台自己备齐了没有」，这是能否建出第一个任务的决定条件。检查分五步，任一步失败即停；每一步的失败**必须**单独呈现，**不得**合成一句「镜像不可用」。

| 步 | 检查 | 失败时要说的 |
|---|---|---|
| 1 | 当前默认环境该用哪张镜像 | 出厂不配置是正确状态，平台按宿主自动选（macOS 为 boxlite，Linux 为 aio）；只有「默认环境是第三方、且平台没有为它发布镜像」才算失败，此时提示按环境配置镜像地址 |
| 2 | 这张镜像在下载源里是否存在 | 平台够得着字节时（本机已有、发布清单里有、上游下载源可达、沙箱环境自己能拉），给 [准备镜像] 由平台自己搬；只有必须从源码构建时，才给下载源地址与推送命令 |
| 3 | 它是不是平台自建的那张 | 上游镜像只是平台镜像的基础层，注册时会被来源检查拒绝；**必须**说清「注册也会被拒」，并给出构建脚本路径 |
| 4 | 是否已注册且校验通过 | 说明「平台开机会自动登记」，提示重启 |
| 5 | 是否已下载到本机 | **不是失败**，是提示；耗时按环境说（aio 与 boxlite 差一个数量级以上） |

**改写了哪条旧文**：format-pilot 试点整理时按状态行「来源」所列旧文（P21-5、F21-5 等）改写成本格式，措辞差异见本条「与原文的措辞差异」（如有）；本轮未再改写（合并时补记）。

**合并说明**：步骤句用词按 Q-DS-21 A 改为「前 N 项已通过，已到第 N 项（共 5 项）」（sys-b 改写对照登记，见附录 A），AC-DIA-017.2 的 Then 随之；Q-DIA-02 仍待裁决。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-DIA-017.1 | API | 出厂未配置镜像地址，两张发布镜像都已就绪 | 跑第 ⑧ 项 | 第 1 步通过，不提示去配置镜像地址 | 已实现（ADR-0103） |
| AC-DIA-017.2 | 集成 | 第 3 步失败 | 页面渲染 | 显示「前 2 步已通过，卡在第 3 步（共 5 步）」及第 3 步自己的下一步 | 已实现：diagnoseModel.ts:56-72（用词见 Q-DIA-02） |
| AC-DIA-017.3 | API | 第 5 步未下载到本机 | 跑第 ⑧ 项 | 状态为提示，不是警告或失败 | 已实现：preset-image.check.ts:292 |
| AC-DIA-017.4 | 组件 | 第 ⑧ 项正常、第 ⑤ 项本机下载源不通 | 页面渲染 | 第 ⑧ 项注明「此刻不需要下载源」；未下载到本机时则注明「这一步需要下载源」 | 已实现：P21-5 §9F 末段（有用例钉住） |

### REQ-DIA-018 · ⑧ 预制镜像：能自己动手时不只报事实 {#REQ-DIA-018}

> 状态 `已实现` · 版本 v1.1 · 来源 P21-5 §9A「与向导的关系」、检查链第 2、5 步 · 关联 ADR-0104 · REQ-DIA-020

第 2 步与第 5 步在平台够得着字节时，**必须**提供同一个准备动作（[准备镜像]），而不只是描述事实：第 2 步是「不做就用不了」，第 5 步是「现在做能省下第一个任务的等待」。搬运前**必须**先通过第 3 步的来源检查。搬运进度**必须**是真实数字（「已下载 X / 约 Y · N%」），任一侧数字拿不到时降级显示，**不得**编造进度。平台搬不了时，按当前默认环境给出可执行的指引；boxlite 环境**不得**指使用户手动预拉镜像。

**改写了哪条旧文**：format-pilot 试点整理时按状态行「来源」所列旧文（P21-5、F21-5 等）改写成本格式，措辞差异见本条「与原文的措辞差异」（如有）；本轮未再改写（合并时补记）。

**合并说明**：系统状态页上没有 [准备镜像] 按钮（DR-36 核实）。按 IMG 域 REQ-IMG-040、043 统一：第 2、5 步在本页的下一步指向「镜像管理 › 预制镜像卡 [准备镜像]」（文字链 [去镜像管理]），初始化向导里仍就地给同一个动作；本条「提供同一个准备动作」按此理解。现状诊断句仍指向本页不存在的按钮（AC-IMG-043.4 偏离）。（交叉引用：REQ-IMG-040、REQ-IMG-043）

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-DIA-018.1 | API | 上游镜像（非平台自建） | 触发准备动作 | 先被来源检查拒绝，不下载任何层 | 已实现（P21-5 §9A 末段） |
| AC-DIA-018.2 | 组件 | 拿不到总大小 | 搬运中 | 进度降级显示，不出现编造的百分比 | 未核实 |
| AC-DIA-018.3 | API | 默认环境为 boxlite，平台搬不了 | 跑第 ⑧ 项 | 指引中不出现 `docker pull` | 已实现（a2c2098） |

### REQ-DIA-019 · ⑨ 帐号登录环境 {#REQ-DIA-019}

> 状态 `实现先行` · 版本 — · 来源 实现（api db386b6）；原产品页没有 · 关联 Q-DIA-01

容器形态部署时，登录 CLI 运行在单独的帐号登录环境里；这个环境没起来或 CLI 版本不受支持时，诊断应显性报出，而不是等用户点登录才失败。是否纳入规格待确认。

**改写了哪条旧文**：format-pilot 试点整理时按状态行「来源」所列旧文（P21-5、F21-5 等）改写成本格式，措辞差异见本条「与原文的措辞差异」（如有）；本轮未再改写（合并时补记）。

### REQ-DIA-020 · 与初始化向导共用同一套检查 {#REQ-DIA-020}

> 状态 `已实现` · 版本 v1.1 · 来源 P21-5 §9A「与向导的关系」；P21-8 §2 · 关联 REQ-DIA-017 · REQ-DIA-018

预制镜像检查链**必须**在初始化向导里提前跑一次（用户建第一个项目之前），而不是等用户点「发起任务」之后才暴露；向导与本页使用同一套检查与同一个准备动作，结论措辞一致。

**改写了哪条旧文**：format-pilot 试点整理时按状态行「来源」所列旧文（P21-5、F21-5 等）改写成本格式，措辞差异见本条「与原文的措辞差异」（如有）；本轮未再改写（合并时补记）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-DIA-020.1 | e2e | 全新安装，预制镜像未就绪 | 进入初始化向导的镜像步骤 | 显示与系统状态页第 ⑧ 项相同的五步结论与同一个准备动作 | 未核实（本试点未复核向导代码；P21-8 §2 有对应描述） |

### REQ-DIA-030 · 后端进程起不来时的兜底 {#REQ-DIA-030}

> 状态 `未实现` · 版本 MVP · 来源 P21-5 §9 第 1 条；P22 §3 · 关联 Q-DIA-03

后端进程本身起不来时，**必须**有一个不依赖后端的自检手段（原文为 `./diagnose.sh` 脚本）。

**改写了哪条旧文**：format-pilot 试点整理时按状态行「来源」所列旧文（P21-5、F21-5 等）改写成本格式，措辞差异见本条「与原文的措辞差异」（如有）；本轮未再改写（合并时补记）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-DIA-030.1 | 真机 | 后端进程无法启动 | 运行兜底自检 | 输出 Node 版本、原生模块、数据目录、端口等检查结果 | 未实现：仓库中没有 diagnose.sh |

### REQ-DIA-040 · 一轮结束：汇总一句（超时单列）、原位播报、非正常项默认展开 {#REQ-DIA-040}

> 状态 `偏离` · 版本 MVP · 来源 UX-DS-308（收尾态）、UX-DS-312（非 ok/info 默认展开）、UX-DS-508（异步结果原位播报、不用 toast）；Q-DS-21 A（超时单列「N 项超时未响应」）；F21-5 §7.2 Phase 1「DefaultDisclosure」；v1 g6-09 / g6-10 / g6-11；实现 diagnoseModel.ts:187-210，DiagnosticsCard.view.tsx:124-128，diagnosticsDisclosure.ts:37-40，useDiagnosticsDisclosure.ts:30 · 关联 Q-DIA-02 · 稿件 f-sys-diag-04、f-sys-diag-05、f-sys-diag-06

一轮结束（收到 done 帧）后，卡内首行（与「尚未运行」那句同一位置）**必须**用一句话汇总，并以 role="status" 在原位播报；**不得**用轻提示报告诊断结论（UX-DS-508）。为零的档不写；失败与超时**分开计数**（done 帧的 `failCount` 含超时，前端按逐项状态数即可，不需要改帧）；「整轮」= done 帧的 `totalMs`（各项并行，约等于最慢的一项）。

| 情况 | 汇总句（示例） |
|---|---|
| 有失败或超时 | 「6 项正常 · 1 项警告 · 1 项失败 · 1 项超时未响应 · 整轮 10s」 |
| 没有失败与超时（只有提示 / 警告） | 「8 项正常 · 1 项提示 · 整轮 1.4s」 |
| 全部正常 | 「9 项全部正常 · 整轮 1.4s」 |

非正常项（警告、失败、超时未响应）默认展开；正常与提示默认收起（提示 = 没有需要修的东西，用 info 样式，**不得**画成警告）。用户手动展开 / 收起只影响那一项，之后到达的结果仍按默认规则展开。

**改写了哪条旧文**：P21-5 §5 状态表「诊断运行中 / 完成：逐项 spinner / 每项 ✅⚠️❌ + 修复建议命令」（L76）只写了逐项，没写整轮怎么收尾 → 本条补三种收尾汇总；现状汇总「N 项失败（含超时）」→ 超时单列（Q-DS-21 A）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-DIA-040.1 | 组件 | done：6 正常、1 警告、1 失败、1 超时 | 页面渲染 | 首行「6 项正常 · 1 项警告 · 1 项失败 · 1 项超时未响应 · 整轮 10s」 | 偏离：现状「6 项正常 · 1 项警告 · 2 项失败（含超时） · 整轮 10s」（diagnoseModel.ts:198-210；failCount 含超时，diagnostics.service.ts:116-119） |
| AC-DIA-040.2 | 组件 | done：8 正常、1 提示 | 页面渲染 | 「8 项正常 · 1 项提示 · 整轮 1.4s」，不出现「0 项…」 | 已实现：diagnoseModel.ts:201-209（稿件 f-sys-diag-05） |
| AC-DIA-040.3 | 组件 | done：9 项正常 | 页面渲染 | 「9 项全部正常 · 整轮 1.4s」 | 已实现：diagnoseModel.ts:206-208（稿件 f-sys-diag-06） |
| AC-DIA-040.4 | 组件 | 汇总到达 | 读屏 | 汇总句在卡内首行、以 role="status" 播报一次；不弹轻提示 | 部分实现：汇总在卡底、没有 role（DiagnosticsCard.view.tsx:124-128） |
| AC-DIA-040.5 | 组件 | 结果陆续到达：④ 失败、⑤ 警告、⑥ 超时、⑧ 提示 | 页面渲染 | ④⑤⑥ 自动展开，⑧ 与正常项收起；手动收起 ④ 后，后到的结果仍按默认规则展开 | 已实现：diagnosticsDisclosure.ts:37-40，useDiagnosticsDisclosure.ts:30（稿件 f-sys-diag-04） |

## AUD · 审计与日志

### REQ-AUD-001 · 审计流与运行日志是两样东西 {#REQ-AUD-001}

> 状态 `已实现` · 版本 v1.1 · 来源 P21-5 §10.1；F21-5 §1、§3 · 关联 UX-SYS-050

| | 审计流 | 运行日志 |
|---|---|---|
| 回答 | 发生了什么（谁、对谁、结果、耗时） | 为什么（栈、第三方库输出、原始报文） |
| 形态 | 结构化，可筛选、可分页 | 文本行 |
| 读者 | 产品用户、管理员，在页面上看 | 运维、开发，出问题时翻 |
| 保留 | 见 REQ-AUD-005 | 按大小轮转，见 REQ-AUD-007 |

运行日志**不得**进入审计面板；审计流**不含**栈和原始报文。两者在页面上同屏共存、互不合并。

**改写了哪条旧文**：format-pilot 试点整理时按状态行「来源」所列旧文（P21-5、F21-5 等）改写成本格式，措辞差异见本条「与原文的措辞差异」（如有）；本轮未再改写（合并时补记）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-AUD-001.1 | e2e | 打开系统状态页 | 页面渲染 | 审计区与其他卡片是独立区块 | 已实现：web/e2e/systemAudit.spec.ts:321 |

### REQ-AUD-002 · 审计面板：默认内容、三项筛选走服务端、增量刷新 {#REQ-AUD-002}

> 状态 `偏离` · 版本 v1.1 · 来源 P21-5 §10.2（L492）；F21-5 §3A ④ ⑤（L92-104）；Q-DS-21 A / UX-DS-410（上屏写「任务」）；实现 useAuditFilters.ts:42-85、auditStream.ts:58-73、AuditFilterBar.view.tsx:23-29、useAuditStream.ts:86-90 · 关联 UX-SYS-050 · PARAM.AUDIT_PAGE_SIZE · PARAM.AUDIT_POLL_INTERVAL_S · 稿件 f-sys-audit-02（类别 + 仅告警筛空）

默认显示最近 `PARAM.AUDIT_PAGE_SIZE` 条。筛选三项：类别（任务、项目、凭证、镜像、系统；上屏写「任务」，不写「沙箱」）、仅告警（警告 + 错误）、时间范围（起 / 止，细则见 REQ-AUD-020）。三项**必须**都在服务端完成并进入查询条件，结果不受「最近 N 条」截断影响；改任意一项都从头重新拉，不沿用旧的翻页位置。新事件每 `PARAM.AUDIT_POLL_INTERVAL_S` 秒增量加到顶部，不重复、不遗漏，已加载的更早内容不重新拉取。往更早翻见 REQ-AUD-021。

**改写了哪条旧文**：P21-5 L492「类别（沙箱 / 项目 / 凭证 / 镜像 / 系统）」与 F21-5 L322 → 「任务」（UX-DS-410：「任务」是唯一上屏称呼）；原 REQ-AUD-002 的「向下滚动加载更早的记录」拆到 REQ-AUD-021；原状态 `已实现` → `偏离`（类别用词）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-AUD-002.1 | e2e | 最近 200 条全是信息级，告警在更早的位置 | 打开「仅告警」 | 能看到那条告警 | 已实现：F21-5 §3A ⑤，auditStream.ts:58-73 |
| AC-AUD-002.2 | 集成 | 已向下加载 3 页 | 假时钟推进 30 秒 | 只发 1 个增量请求，0 个历史请求；新事件出现在顶部，无重复 | 已实现：F21-5 §7.3 |
| AC-AUD-002.3 | e2e | 已向下加载若干页 | 切换任一筛选 | 列表从头开始，不沿用旧的位置 | 已实现：web/e2e/systemAudit.spec.ts:136 |
| AC-AUD-002.4 | 组件 | 打开类别下拉 | 看选项与空态条件句 | 选项为 全部 / 任务 / 项目 / 凭证 / 镜像 / 系统；条件句写「类别：任务」 | 偏离：第二项是「沙箱」（AuditFilterBar.view.tsx:23-29），条件句同样写「类别：沙箱」（auditStream.ts:259-265） |

### REQ-AUD-003 · 审计行：内容、行内详情、按任务看完整时间线（就地筛） {#REQ-AUD-003}

> 状态 `部分实现` · 版本 v1.1 · 来源 P21-5 §10.2（L510-511）、L45 原型图；F21-5 §5（L153、L155）、§9.1 #27 #28；Q-AUD-01 ②（本页就地筛，按现状；format-pilot 待裁决清单里仍开着）；Q-DS-21 A / UX-DS-410（上屏写「任务」）；v1 g6-02 头注释（审计摘要与执行者按定稿词）；实现 AuditEventRow.view.tsx:46-119、AuditStreamContainer.tsx:32-45、useAuditFilters.ts:37-38、62-68、auditRowModel.ts:40-50、115-117、auditStream.ts:278、audit.projector.ts:84、103、233-251、268 · 关联 UX-SYS-051 · Q-AUD-01 · 稿件 f-sys-audit-04（行内展开）、f-sys-audit-06（按任务筛）

每条显示时间、严重度（状态点 + 文字，不只靠颜色）、一句话摘要，以及有才显示的耗时、结果、错误码、执行者。摘要与执行者上屏用定稿词：对象称「任务」不称「沙箱」，任务状态写中文状态名（「任务状态 准备中 → 运行中」），镜像校验结果写「有警告」这类人话，provider 事件推动的变化执行者写「沙箱环境事件」。有详情的行可在行内展开看详情（已脱敏，同一时刻只展开一行），没有详情的行不显示展开箭头。成果相关的记录（销毁时留下来、到期清理、手动删除）摘要用新叫法，**不得**写「保留工作区卷」「保留卷」（Q-SYS-23 A，用户拍板 2026-10-04）：销毁时留下来的写「保留成果（磁盘 … / 下载 …）」，清理的写「清理了保留下来的成果（回收约 …）」「保留期到期，已清理保留下来的成果（回收约 …）」。

任务相关的记录提供 [查看该任务完整时间线]：**在本页就地**按这个任务筛选，不跳走——筛选条末尾出现可移除的「任务：<任务名>」筛选条件（chip）；列表只剩这个任务的全部记录（时间倒序，可继续加载更早的）。进入时把类别、仅告警、起止清回默认，才是「完整」时间线（本组默认，待确认；现状保留其余筛选）。按任务筛空时，空态条件句里也写「任务：<任务名>」（现状写「对象：<ID>」，auditStream.ts:278）。移除这个条件（chip 的 ×，或空态里的 [清除筛选]）回到全部记录。已按某个任务筛选时，行尾不再出现这个按钮（点了也是原地）。任务名取不到（任务已删除）时写「任务：<任务 ID 前 8 位>」。对象是任务的记录给入口（现状判据：记录的对象类型是任务，auditRowModel.ts:115-117）；对象是成果、detail 里带来源任务的记录（摘要「保留成果（…）」，实现今天写「保留工作区卷」）本片也给，按来源任务筛——这是按 P5 / v1 示例定的默认，现状不给（audit.projector.ts:233-251），见文末待确认第 6 条。

**改写了哪条旧文**：P21-5 L511「[查看该沙箱完整时间线]：跳到工作台沙箱详情的时间线视图（按 subject_id 筛）」、F21-5 L155「跳工作台沙箱详情的时间线视图」、F21-5 L327 / L364 → 本页就地按任务筛（Q-AUD-01 ②；工作台从来没有「沙箱详情时间线」这个视图，P21-1 全文没有）；P21-5 L45 原型图里的「[查看该沙箱完整时间线]」→「查看该任务完整时间线」（UX-DS-410）；原 AC-AUD-003.2 补「同一时刻只展开一行」（现状就是这样，AuditStreamContainer.tsx:32-35）；摘要用词原文没有定义（摘要串由后端拼），本条把 v1 g6-02 已按定稿词改过的写法收进产品口径（新增 AC-AUD-003.6）；原状态 `偏离` → `部分实现`；成果记录摘要里的「保留工作区卷」「清理了保留卷」→「保留下来的成果」（Q-SYS-23 A，新增 AC-AUD-003.7）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-AUD-003.1 | e2e | 一条任务创建事件 | 页面渲染 | 摘要是人话，不是 JSON 串 | 已实现：web/e2e/systemAudit.spec.ts:109 |
| AC-AUD-003.2（改） | 组件 | 一条带详情的事件 | 点击该行 | 详情在行内展开，不弹层；没有详情的行不显示展开箭头；展开另一行时前一行收起（新增的一句） | 已实现：F21-5 §7.2，AuditStreamContainer.tsx:32-35（稿件 f-sys-audit-04） |
| AC-AUD-003.3（改） | e2e | 一条任务事件，且开着「仅告警」 | 点 [查看该任务完整时间线] | 列表只剩该任务的事件（含信息级）；筛选条末尾出现「任务：迁移构建脚本」；类别 / 仅告警 / 起止回到默认 | 部分实现：就地按 subjectId 筛已实现（AuditStreamContainer.tsx:36-45，web/e2e/systemAudit.spec.ts:174）；筛选条里没有这个条件（只在空态句里写「对象：<id>」，auditStream.ts:278）；其余筛选保留（useAuditFilters.ts:37-38）（稿件 f-sys-audit-06） |
| AC-AUD-003.4 | 组件 | 已按任务筛选 | 点「任务：…」的 × | 回到全部记录，四项筛选都在默认；焦点回到筛选条第一个控件 | 未实现：筛选条里没有这个条件，只能用空态里的 [清除筛选]（useAuditFilters.ts:62-68） |
| AC-AUD-003.5 | 组件 | 任一任务事件行 | 读行尾按钮；再按该任务筛选 | 文案「查看该任务完整时间线」；按该任务筛选后这一列不再出现 | 偏离：文案「查看该沙箱完整时间线」（auditRowModel.ts:50）；筛选后仍出现（AuditEventRow.view.tsx:100-112） |
| AC-AUD-003.6 | 集成 | 三条记录：任务状态 starting → running（provider 事件推动）、创建任务「修一下登录态刷新」、镜像校验结果 warning | 页面渲染 | 摘要「任务状态 准备中 → 运行中」「创建任务「修一下登录态刷新」」「校验镜像 <ref>：有警告」；执行者「沙箱环境事件」；行上不出现「沙箱」与英文状态值 | 偏离：摘要由后端拼原值「沙箱状态 starting → running」「创建沙箱 <名>」「校验镜像 <ref>：warning」（audit.projector.ts:84、103、268），执行者「Provider 事件」（auditRowModel.ts:45）；要后端同步，或前端按事件类型与 detail 重拼（稿件 f-sys-audit-04） |
| AC-AUD-003.7 | 集成 | 三条成果记录：销毁时留下来、到期清理、手动删除 | 页面渲染 | 摘要依次是「保留成果（磁盘 … / 下载 …）」「保留期到期，已清理保留下来的成果（回收约 …）」「清理了保留下来的成果（回收约 …）」；行上不出现「保留工作区卷」「保留卷」 | 偏离：摘要由后端拼「保留工作区卷（磁盘 N 字节 / 下载 N 字节）」（audit.projector.ts:242）、「清理了保留卷（回收约 N 字节）」「保留期到期，已清理保留卷（回收约 N 字节）」（retained-volume.service.ts:126、179）；要后端同步，或前端按事件类型与 detail 重拼 |

### REQ-AUD-004 · 空、失败、断层、实时中断都要如实说 {#REQ-AUD-004}

> 状态 `已实现` · 版本 v1.1 · 来源 P21-5 §10.2「空态」「尚未记录」（L494-512）；F21-5 §3A ③ ⑥ ⑦、§6；UX-DS-303；实现 AuditStreamCard.view.tsx:106-228、AuditGapNotice.view.tsx:24-38、auditStream.ts:228-258 · 关联 UX-SYS-052 · 稿件 f-sys-audit-01、02、03、04（读取失败 + [重试] 见 sys-a 组 f-sys-conn-03）

| 情况 | 用户要知道的 | 下一步 |
|---|---|---|
| 真的没有记录 | 「暂无记录」+ 当前条件说明（**不得**留空白） | 无（不出 [清除筛选]，也不出「加载更早的记录」） |
| 筛选没筛出来 | 「当前筛选无匹配记录」+ 当前条件 | [清除筛选] |
| 选中的类别平台还没开始记录 | 「该类事件平台尚未记录」+ 条件 +「平台目前不会为该类别写入审计事件；这不代表相关操作没有发生。」（类别判断优先于其他筛选） | [清除筛选]；等平台补上 |
| 接口失败 | 「审计流加载失败」（**不得**显示成「暂无记录」） | [重试] |
| 增量拉满上限，中间有一段没拉到 | 列表中间一行「这里有一段事件还没加载（条数未知）」（不写内部序号） | [加载中间部分]：点一次补一段，**不得**自动循环补齐 |
| 增量刷新失败 | 筛选条下一行「实时更新已中断，列表可能不是最新的」（不盖住已有列表） | [重试]（只重试增量通道） |
| 到底了 | 「已到最早记录」（REQ-AUD-021） | 无 |

三种空态三句话，互不覆盖（UX-DS-303）；空态放在审计卡里，居中、不加虚线框（稿件 f-sys-audit-01…03）。

**改写了哪条旧文**：无改写，补齐验收（原 3 条 AC 沿用，新增 5 条覆盖三种空态与两种异常的呈现）；P21-5 只写了三种空态，「实时中断」「断层」原写在 F21-5 §3A ③ ⑦，这里收进产品口径。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-AUD-004.1 | e2e | 审计接口返回 500 | 页面渲染 | 显示加载失败，页面上没有「暂无记录」 | 已实现：web/e2e/systemAudit.spec.ts:372 |
| AC-AUD-004.2 | 集成 | 增量请求返回满额且还有更多 | 页面渲染 | 断层提示出现在两段之间，且没有自动继续请求 | 已实现：F21-5 §7.3 |
| AC-AUD-004.3 | e2e | 在已有产出的类别下筛空 | 页面渲染 | 显示「当前筛选无匹配记录」，不显示「该类事件平台尚未记录」 | 已实现：web/e2e/systemAudit.spec.ts:282 |
| AC-AUD-004.4 | 组件 | 全新部署、没有筛选、0 条 | 页面渲染 | 「暂无记录」+「当前无筛选条件（全部类别、全部严重度）」；没有 [清除筛选]、没有「加载更早的记录」 | 已实现：AuditStreamCard.view.tsx:164-184、206-208（稿件 f-sys-audit-01） |
| AC-AUD-004.5 | 组件 | 类别「凭证」+ 仅告警，0 条 | 点 [清除筛选] | 先看到「当前筛选无匹配记录」+「类别：凭证 · 仅告警」+ [清除筛选]；点了之后四项筛选（含按任务筛选）全部回到默认 | 已实现：AuditStreamCard.view.tsx:170-183，useAuditFilters.ts:62-68（稿件 f-sys-audit-02） |
| AC-AUD-004.6 | 单元 | 某类别契约允许、后端还没写入（测试注入的写入表） | 选它，并同时开「仅告警」 | 判为「该类事件平台尚未记录」，不判为「筛选无匹配」 | 已实现：auditStream.ts:247-258；今天五类都在写，这一支真实数据下暂不可达（story CategoryNotYetEmitted，稿件 f-sys-audit-03） |
| AC-AUD-004.7 | 集成 | 首屏成功、随后增量轮询失败 | 页面渲染；点 [重试] | 筛选条下一行出现「实时更新已中断，列表可能不是最新的」+ [重试]，已有列表照常显示；[重试] 只重发增量请求，不重拉历史页 | 已实现：AuditStreamCard.view.tsx:127-139（稿件 f-sys-audit-04） |
| AC-AUD-004.8 | 组件 | 列表中间有断层 | 点 [加载中间部分] | 按钮变「加载中…」并禁用，补上一段；还有缺口时断层行留着，不自动再补 | 已实现：AuditGapNotice.view.tsx:34-36，F21-5 §5 L153（稿件 f-sys-audit-04） |

### REQ-AUD-005 · 审计保留与完整性声明 {#REQ-AUD-005}

> 状态 `已实现` · 版本 v1.1 · 来源 P21-5 §10.1 留存、§10.5 · 关联 PARAM.AUDIT_RETENTION_DAYS · PARAM.AUDIT_MAX_ROWS

审计保留 `PARAM.AUDIT_RETENTION_DAYS` 天，且总量不超过 `PARAM.AUDIT_MAX_ROWS` 条（先到者生效）。审计是观察设施，写入**永不**阻断业务；因此产品文案**不得**声称审计流「完整无遗漏」。

**改写了哪条旧文**：format-pilot 试点整理时按状态行「来源」所列旧文（P21-5、F21-5 等）改写成本格式，措辞差异见本条「与原文的措辞差异」（如有）；本轮未再改写（合并时补记）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-AUD-005.1 | 集成 | 审计写入失败 | 执行一次会产生审计的业务操作 | 业务操作照常成功 | 未核实 |

### REQ-AUD-006 · 导出日志包：浏览器原生下载、四件 {#REQ-AUD-006}

> 状态 `已实现` · 版本 v1.1 · 来源 P21-5 §3、§6「[导出日志]」（L88）、§10.3（L514-527）；F21-5 §5（L150）；U-61（原型只出「未接入」）；实现 system.service.ts:92-104（exportAudit）、useExportAuditLogs.ts、DiagnosticsCard.view.tsx:67-70、audit-export.service.ts:14-19、31-36、46-48 · 关联 Q-AUD-02 · PARAM.EXPORT_WINDOW_H · PARAM.EXPORT_MAX_MB · 稿件 无（入口是 f-sys-diag-01…06 诊断卡里的 [导出日志]；点了之后的反馈是浏览器自己的下载栏，应用内没有进行中 / 结果态）

[导出日志] 在诊断卡上（不在审计卡上，同一页不出现两个同名按钮），诊断进行中照常可点。点了之后交给浏览器原生下载：新标签打开导出地址，进度与完成由浏览器下载栏显示；应用内**不**显示进度、**不**弹轻提示；导出失败时（后端回 JSON 错误信封）**不得**把当前页导航走。导出物是一个 tar.gz 包，四件：审计流（`audit.jsonl`）、运行日志（`runtime.log`）、导出时刻的诊断快照与版本、资源水位（`diagnose.json`）、实际截取范围说明（`export-range.json`）。范围取「最近 `PARAM.EXPORT_WINDOW_H` 小时」与「`PARAM.EXPORT_MAX_MB` MB」中先到的那个。范围说明**必须**写明实际时间窗、是否被截断，以及每一份缺失时的原因（运行日志有三种缺法：日志设施未启用、范围内无内容、读取失败）。

**改写了哪条旧文**：P21-5 L518「含三份」（随后又列出第 4 份「实现时补」）与 F21-5 L150「三件套」→ 四件（Q-AUD-02，按现状）；P21-5 L88「浏览器下载；导出前脱敏」→ 下载方式写进本条，「导出物里没有凭证明文」归 REQ-AUD-008（format-pilot C-01）。原型里点 [导出日志] 出的一句「已开始下载日志包（原型不产生文件）」只是原型说明，不进产品。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-AUD-006.1 | e2e | 在系统状态页 | 点 [导出日志] | 触发下载，文件名以 `.tar.gz` 结尾 | 已实现：web/e2e/systemAudit.spec.ts:196 |
| AC-AUD-006.2 | API | 运行日志设施未启用 | 导出 | 包里没有 `runtime.log`，范围说明写明缺失原因，导出不报错 | 已实现：audit-export.service.ts:46-48 |
| AC-AUD-006.3 | API | 最近 24 小时日志超过 50 MB | 导出 | 包大小不超过 50 MB，范围说明标注已截断 | 已实现：audit-export.service.ts:14-19 |
| AC-AUD-006.4 | e2e | 导出接口返回 500（JSON 错误信封） | 点 [导出日志] | 当前页不被导航走，诊断结果与审计列表都还在 | 已实现：system.service.ts:98-104（`target="_blank"`），web/e2e/systemAudit.spec.ts:229 |
| AC-AUD-006.5 | 组件 | 诊断进行中 | 点 [导出日志] | 照常触发下载，诊断不中断；应用内不出现进度条或轻提示 | 已实现：DiagnosticsCard.view.tsx:67-70，useExportAuditLogs.ts:9-13 |

### REQ-AUD-007 · 运行日志落盘与轮转 {#REQ-AUD-007}

> 状态 `已实现` · 版本 v1.1 · 来源 P21-5 §10.4 · 关联 PARAM.RUNTIME_LOG_FILE_MB · PARAM.RUNTIME_LOG_FILES

平台**必须**把自己的运行日志写到数据目录下的 `logs/`，按大小轮转（单文件 `PARAM.RUNTIME_LOG_FILE_MB` MB，共 `PARAM.RUNTIME_LOG_FILES` 份），与审计使用同一套脱敏；不依赖 `docker logs`。

**改写了哪条旧文**：format-pilot 试点整理时按状态行「来源」所列旧文（P21-5、F21-5 等）改写成本格式，措辞差异见本条「与原文的措辞差异」（如有）；本轮未再改写（合并时补记）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-AUD-007.1 | 单元 | 当前日志文件已达单文件上限 | 继续写入 | 轮转出新文件，总份数不超过上限，最旧的被删除 | 已实现：runtime-log-writer.ts:15-17、91、180 |

### REQ-AUD-008 · 凭证明文不出现在审计、日志与导出包里 {#REQ-AUD-008}

> 状态 `已实现` · 版本 MVP · 来源 P21-5 §6「[导出日志]」、§9 第 2 条、§10.5 · 关联 —

审计流、运行日志与导出包中**不得**出现凭证或 token 明文。

<details>
<summary>与原文的措辞差异</summary>

原文 §6 写「导出前脱敏」，§10.5 写「脱敏发生在写入口而非导出时」。两句并不冲突：产品要求是「导出物里没有明文」；「在写入口脱敏」是实现方法（否则数据库文件与备份包两条路仍会泄露），已移到技术设计。

</details>

**改写了哪条旧文**：format-pilot 试点整理时按状态行「来源」所列旧文（P21-5、F21-5 等）改写成本格式，措辞差异见本条「与原文的措辞差异」（如有）；本轮未再改写（合并时补记）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-AUD-008.1 | API | 一次带 token 的操作写入审计 | 导出日志包并全文搜索该 token | 搜不到 | 未核实（脱敏在写入口，13 §2.8.2） |

### REQ-AUD-020 · 时间范围：只填一端、起晚于止就地提示、条件句写人能读的时间 {#REQ-AUD-020}

> 状态 `部分实现` · 版本 v1.1 · 来源 P21-5 L492「时间范围」（原文只有这四个字）；F21-5 §3A ⑤（时间范围走 from / to，是筛选不是翻页）；plan F-SYS-AUDIT（REQ-AUD-002 补 AC）；U-63；实现 useAuditFilters.ts:49-60、auditStream.ts:272-282、300-313、AuditFilterBar.view.tsx:86-110；后端 audit.controller.ts:117-133、system.schema.ts:155-157 · 稿件 f-sys-audit-05

时间范围用「起」「止」两个日期 + 时刻输入（本地时区、分钟精度），可以只填一个：只填「起」= 这一刻之后，只填「止」= 这一刻之前；填好的一端按服务端 `from` / `to` 过滤，与「最近 N 条」和翻页游标无关。只填了半截（日期选了、时刻还没选）不当作筛选条件。

「起」晚于「止」时**必须**在筛选条就地提示（role="alert"），刚改的那一格标错误态，**不发请求**，列表与条件句保持上一次生效的结果——提示写「「止」早于「起」：这组时间没有生效，下面仍是上一次的筛选结果。」（刚改的是「起」时写「「起」晚于「止」：…」）。改对之后提示消失、按新范围重新拉。

空态条件句里的时间**必须**写成人能读的本地时间：「起：10月2日 15:00」「止：10月2日 18:30」；不在今年时带年份「2025年12月31日 23:00」；**不得**出现 ISO 原串。

**改写了哪条旧文**：P21-5 L492「时间范围」四个字 → 本条（只填一端、起晚于止、条件句写法都是原文没定义的）；现状条件句直接拼 ISO（auditStream.ts:279-280）→ 人能读的本地时间。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-AUD-020.1 | 集成 | 没有其它筛选 | 只把「起」设为 10月2日 15:00 | 请求只带 `from`（不带 `to`），列表从头拉 | 已实现：useAuditFilters.ts:49-60，auditStream.ts:58-73 |
| AC-AUD-020.2 | 组件 | 只有「起」= 10月2日 15:00，筛空 | 页面渲染 | 「当前筛选无匹配记录」+「起：10月2日 15:00」+ [清除筛选] | 偏离：条件句是 ISO 原串，如「起：2026-10-02T07:00:00.000Z」（auditStream.ts:279）（稿件 f-sys-audit-05） |
| AC-AUD-020.3 | 组件 | 「起」= 10月2日 15:00 已生效 | 把「止」改成 10月2日 14:00 | 「止」标错误态（aria-invalid）+ 筛选条下一行就地提示（role="alert"）；不发请求；列表与条件句仍是上一次的 | 未实现：照常发 from 晚于 to 的请求，返回空后显示「当前筛选无匹配记录」（前端 useAuditFilters.ts:49-60 不比较起止；后端只判 since / before 互斥，audit.controller.ts:121-123，from / to 原样下传，:127-128）（稿件 f-sys-audit-05） |
| AC-AUD-020.4 | 组件 | 起 / 止不在今年 | 渲染条件句 | 带年份，如「起：2025年12月31日 23:00」 | 未实现（同 AC-AUD-020.2） |
| AC-AUD-020.5 | 单元 | 输入只到一半（日期有、时刻空，或形状不完整） | 计算筛选条件 | 不当作筛选条件，不发请求 | 已实现：auditStream.ts:305-313（`LOCAL_DATETIME_RE` 先卡形状） |
| AC-AUD-020.6 | 组件 | AC-AUD-020.3 的就地提示还在 | 把「止」改到 10月2日 18:30（晚于起） | 提示消失、「止」去掉错误态；按新范围从头拉；仍然筛空时条件句是「起：10月2日 15:00 · 止：10月2日 18:30」 | 未实现（同 AC-AUD-020.3；条件句写法同 AC-AUD-020.2） |

### REQ-AUD-021 · 加载更早的记录：游标翻页、加载中、到底 {#REQ-AUD-021}

> 状态 `实现先行` · 版本 v1.1 · 来源 P21-5 L492「默认最近 200 条」、L509（按 seq 游标增量）；F21-5 §5（L152）、§3A ①；UX-DS-303 的缺口记录（「已到最早记录」与「已达 30 天保留期」未区分）；U-66；实现 AuditStreamCard.view.tsx:206-224、useAuditStream.ts:186-189 · 关联 PARAM.AUDIT_PAGE_SIZE · PARAM.AUDIT_RETENTION_DAYS · 稿件 f-sys-audit-04（入口）、f-sys-audit-06（到底）

列表底部整行放 [加载更早的记录]：按当前已加载里最老一条的序号向更早翻一页（与当前筛选条件一起发），点了之后按钮变「加载中…」并禁用；新的一页接在末尾、不重复。没有更早的了，同一位置改为「已到最早记录」（文字，不可点，高度与按钮相同，列表底部不跳）。空列表且没有更早的记录时，底部什么都不放（只留空态那句话）；空列表但服务端说还有更早的，仍给入口。审计只保留 `PARAM.AUDIT_RETENTION_DAYS` 天，「已到最早记录」暂不区分「真的到头」与「更早的已过保留期」（待定，不在本轮）。

**改写了哪条旧文**：原产品文档没有这个动作（P21-5 只写了默认 200 条与增量刷新）；原 REQ-AUD-002 里的「向下滚动加载更早的记录」→ 按现状改为点按钮加载（实现里没有滚动自动加载）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-AUD-021.1 | 集成 | 已加载第 1 页，还有更早的 | 点 [加载更早的记录] | 请求带 `before`=已加载最老一条的序号与当前筛选；按钮「加载中…」禁用；新的一页接在末尾、不重复 | 已实现：useAuditStream.ts:186-189，AuditStreamCard.view.tsx:210-219，web/e2e/systemAudit.spec.ts:136 |
| AC-AUD-021.2 | 组件 | 最后一页返回 `hasMore: false` | 页面渲染 | 底部同一位置变成「已到最早记录」 | 已实现：AuditStreamCard.view.tsx:220-222（稿件 f-sys-audit-06） |
| AC-AUD-021.3 | 组件 | 0 条、没有更早的 | 页面渲染 | 底部既没有「加载更早的记录」也没有「已到最早记录」 | 已实现：AuditStreamCard.view.tsx:206-208（稿件 f-sys-audit-01） |
| AC-AUD-021.4 | 组件 | 这一页 0 条，但服务端回 `hasMore: true` | 页面渲染 | 空态那句话照常显示，底部仍给 [加载更早的记录] | 已实现：AuditStreamCard.view.tsx:206-208（`rows.length > 0 \|\| hasOlder`）；无稿（与 f-sys-audit-02 空态 + f-sys-audit-04 底部按钮同件） |

---

## 附录 A · 改写对照（逐条，来自各片段）

### 改写对照（旧文 → 本片）（sys-a）

| 旧文 | 位置 | 改写为 | 依据 |
|---|---|---|---|
| P21-5 L25「✅ 系统就绪 · 当前活跃 Task: 5」；L59「资源水位回答『还能再发几个 Task』」 | REQ-SYS-071 | 主数字「还能再发 N 个任务」= 后端 `remainingTasks`；契约到位前维持「当前活跃任务：N」 | D9 / Q-SYS-02 ③、DR-08 |
| P21-5 L71「⚠️ 黄"建议停止部分 Task" / 🔴 红"无法创建新 Task"」 | REQ-SYS-011 | 警告「资源紧张，建议停掉一些任务」（只在 CPU / 内存触发时）；「建不了」只由主数字说 | Q-SYS-03（按代码）、D9、DR-08、UX-DS-313 |
| P21-5 L72「⚠️ 黄"已使用超 75%，建议清理" / 🔴 红"已满（无法创建 Task）"」；原 AC-SYS-012.2「磁盘行显示提示句」 | REQ-SYS-012 | 结论块里「磁盘快满了 / 磁盘满了：清理成果或删掉不用的项目」，不说停任务 | UX-DS-313 / X-1、DR-03 A |
| resourceModel.ts:29「资源紧张，建议停掉一些任务」（任何维度触发都说） | REQ-SYS-011、012 | 按触发维度各给一句 | UX-DS-313、status-mapping.md:83-84 |
| P21-5 L73「保留卷已占 DATA_ROOT 的 80%+，建议手动清理」 | REQ-SYS-020 | 「保留下来的成果已占数据目录的 N%，建议手动清理」（role="status"） | DR-37、Q-DS-21 A（上屏说「数据目录」） |
| P21-5 L84「[清理]」；原 REQ-SYS-020「进入保留卷管理」 | REQ-SYS-020 | [清理成果] 打开跨项目「保留下来的成果」；接好之前不显示 | Q-DS-33 A、DR-27 |
| P21-5、format-pilot REQ-SYS-021 与实现的「保留卷」「保留卷占用」「[清理保留卷]」 | REQ-SYS-020、021 | 「保留下来的成果」「成果占用」「[清理成果]」（接口字段与代码标识符不改） | Q-SYS-23 A（用户拍板 2026-10-04） |
| P21-5 L69-77 状态矩阵没有加载态；spec/patterns.md:43「一行『读取中…』」 | REQ-SYS-070 | 资源卡、沙箱环境卡骨架；审计 5 行骨架 | T-7 / UX-DS-304、U-75 |
| P21-5 L74、L125 provider 三态（探测 / 未启用 · v2.0 开放） | REQ-SYS-030 | 最近一小时失败率 + 无样本，不主动探测 | D9 / Q-SYS-04 ② |
| P21-5 L33-35、L75 WS 延迟 / 已断开 / 终端 2 连接 / 上次事件推送；原 AC-SYS-040.3、040.5 | REQ-SYS-040 | 本页测不到的写「未知」并说原因；终端只报数量；两条 AC 删去 | UX-DS-306、Q-SYS-06 ①（③ 待裁决） |
| format-pilot REQ-SYS-060「实现先行，需确认是否纳入」 | REQ-SYS-060 | 纳入：回填、读取失败不许存、只存不重测、校验、成功与失败 | Q-SYS-08、UX-DS-310、Q-DS-35 ③ |
| format-pilot AC-SYS-060.2「请求体只把 NO_PROXY 置空，另两项不出现在请求体里」 | REQ-SYS-060 | 按结果验收（另两项保持已存值） | initWizardModel.ts:148-160、system-settings.service.ts:133-134 |
| Q-DS-35 ③「成功句的作用范围待核实」；ProxySettingsCard 说明「拉取沙箱镜像、访问模型接口都走这里」 | REQ-SYS-060 | 成功句只写联网检查；说明文字改为只承诺联网检查（Q-SYS-16 已拍板 A，稿件已改；实现仍是旧句，AC-SYS-060.9 记偏离） | connectivity.probe.ts:170 等（核实见 REQ-SYS-060） |
| globalBanner.ts:75「查看系统状态」在本页也显示 | REQ-SYS-075 | 本页隐藏，只留 × | T-8 / UX-DS-311 |
| 系统页没有写后端不可达、离线时的样子 | REQ-SYS-075、076 | 各卡原位说；离线横幅 [重新检测] 就地跑诊断 | spec/patterns.md:44-45、P21-8 L379、v1 g6-13 / g6-14 |

### 改写对照（旧文 → 本片）（sys-b）

| 旧文 | 位置 | 改写为 | 依据 |
|---|---|---|---|
| P21-5 L86「诊断项按固定顺序展示 ①…⑧」；P22 L151 八项清单；F21-5 L310、L388「固定八项」 | REQ-DIA-002 | 以首帧清单为准（现为 9 项），第 ⑨ 项也有序号 | Q-DIA-01 ①（按实现）、UX-DS-312、format-pilot B-03 |
| P21-5 L76「逐项 spinner / 每项 ✅⚠️❌」 | REQ-DIA-002、REQ-DIA-040 | 连接中 / 进行中 / 中断 / 三种收尾汇总 | UX-DS-308、v1 g6-06…11 |
| P21-5 L108「单项超时 10s」；P21-8 L288、L407 与 F21-8 L48、L250「单项超时 5s」；system.controller.ts:199、api/openapi.json 与 web/openapi.json :2418、sse-protocol.ts:66「5s」 | REQ-DIA-003 | 只引用 `PARAM.DIAG_ITEM_TIMEOUT_MS`（现值 10000，diagnostics.service.ts:38；初始化向导联网检查同一个数，initialization.service.ts:66-67） | format-pilot C-02、B-02 |
| 原 REQ-DIA-003「显示为『没有得出结论』」 | REQ-DIA-003 | 「超时未响应」 | Q-DS-21 A（Q-DIA-02 待裁决） |
| 现状汇总「N 项失败（含超时）」 | REQ-DIA-040 | 超时单列「N 项超时未响应」 | Q-DS-21 A、v1 g6-09 |
| 镜像检查步骤句「前 N 步已通过，已到第 N 步（共 5 步）」（diagnoseModel.ts:68-78） | REQ-DIA-017（不在本片编号段，只登记） | 「前 N 项已通过，已到第 N 项（共 5 项）」 | Q-DS-21 A（「第 N 项」定稿词）；Q-DIA-02 待裁决 |
| F21-5 L156「从横幅进入：`?autorun=1`（可选）」 | REQ-DIA-001 | 横幅留一次性意图，本页消费后清掉 | 实现 useSystemStatus.ts:178-191 |
| P21-5 L518「含三份」；F21-5 L150「三件套」 | REQ-AUD-006 | 四件 | Q-AUD-02（按现状） |
| P21-5 L88「浏览器下载；导出前脱敏」 | REQ-AUD-006、REQ-AUD-008 | 浏览器原生下载、应用内无进度无轻提示；「导出物里没有明文」归 REQ-AUD-008 | format-pilot C-01 |
| P21-5 L492「类别（沙箱 / …）」；F21-5 L322 | REQ-AUD-002 | 「任务」 | UX-DS-410、Q-DS-21 A |
| P21-5 L492「时间范围」 | REQ-AUD-020 | 只填一端、起晚于止就地提示、条件句写人能读的时间 | plan F-SYS-AUDIT |
| P21-5 L511、F21-5 L155 / L327 / L364「跳到工作台沙箱详情的时间线视图」 | REQ-AUD-003 | 本页就地按任务筛 + 可移除的「任务：<名>」条件 | Q-AUD-01 ② |
| P21-5 L45「[查看该沙箱完整时间线]」 | REQ-AUD-003 | 「查看该任务完整时间线」 | UX-DS-410 |
| （无旧文；现状审计摘要「沙箱状态 starting → running」「创建沙箱 X」「校验镜像 X：warning」与执行者「Provider 事件」） | REQ-AUD-003 | 摘要与执行者用定稿词（AC-AUD-003.6） | Q-DS-21 A、UX-DS-410、v1 g6-02 头注释 |
| 原 REQ-AUD-002「向下滚动加载更早的记录」 | REQ-AUD-021 | 点 [加载更早的记录]；到底「已到最早记录」 | 实现 AuditStreamCard.view.tsx:206-224 |
| 现状成果记录摘要「保留工作区卷（磁盘 N 字节 …）」「清理了保留卷…」；诊断第 ③ 项下一步「先清保留卷（系统状态页「保留卷占用」）或删掉已完成任务的工作区」 | REQ-AUD-003、REQ-DIA-012 | 「保留成果」「保留下来的成果」「成果占用」「[清理成果]」 | Q-SYS-23 A、Q-SBX-03 A（用户拍板 2026-10-04） |

## 附录 B · 片段里的默认决定与待确认（原文）

> 下面是各片段的原文，编号仍是片段里的本地编号；统一编号与完整的选项、推荐、默认在 [open-questions.md](./open-questions.md)，对照见其 §7。

### 本片的默认决定与待确认（sys-a）

1. **口径句的「本机最多 M 个」没有数据来源**（REQ-SYS-071）：DR-08 提议的 `capacity` 只有 `remainingTasks / registeredTasks / basis`；而 M 不能用 R + N 算——磁盘满时 R + N ≠ M（f-sys-resource-03：已登记 1、还能再发 0、最多 8）。默认：契约里补一项按默认配额推演的上限（如 `maxTasks`）；另一种做法是口径句去掉「本机最多 M 个」。同一处：稿件 N = 0 的原因句「磁盘已用 96%」是 v1 的写法，按 DR-08 核实，闸门看的是磁盘登记量与 1 GB 最小余量（resource-pool.domain-service.ts:49、163），不看水位——真正的原因句由 `basis` 给，文案随契约定。
2. **严重档「现在建不了新任务」只在主数字为 0 时说**（AC-SYS-011.3）：由 D9（主数字是唯一回答「能不能建」的数）与 DR-08（水位严重不改主数字）推出；契约到位前维持现行文案。
3. **几个维度同时越线时各给一句下一步**（AC-SYS-011.4）：UX-DS-313 的直接推论；四张稿都是单维度触发，这一态没有稿件。
4. **出网代理说明文字与实现不符**（AC-SYS-060.9）：A 改说明，只承诺联网检查（前端改文案，例：「联网检查会走这组代理；镜像下载和沙箱里的 Agent 现在还不读它」）；B 让镜像下载与沙箱也走这组代理（后端新范围；这张卡当初就是为了「镜像下载慢到中途断掉」才加的，ProxySettingsCard.view.tsx:3-8）。建议先 A、B 进 backlog；不回复时按 A。稿件已按 A 改了说明：「联网检查会走这组代理；镜像下载和沙箱里的 Agent 现在还不读它。检查只测得出「能不能连上」，测不出带宽。」（系统状态页 19 张，W2 一致性改动 18；镜像页、向导的失败出路句同时改成不承诺代理，改动 19）。**已拍板（2026-10-04，用户原话「补全 10 条按推荐」）：Q-SYS-16 选 A**，B 进 backlog。
5. **无协议的 `host:port`**（AC-SYS-060.4）：今天按 `http://` 处理（connectivity.probe.ts:376）。默认：校验落地时拒绝，并给同一句「要以 http:// 或 https:// 开头」（与 v1 g6-13 文案一致）；也可以选「自动补 `http://` 再存」。
6. **连接卡两处「正常」**（AC-SYS-040.4、040.6）：按 UX-DS-306，首屏 REST 应写「未知」、终端行不挂「正常」；稿件 f-sys-resource-01、f-sys-conn-03 与 P5 按换皮规则（T-21）照 v1 / 现状画「正常」。认可本片口径后，两张稿与 P5 各改一处徽标（前端各改一行）。
7. **沙箱环境「故障 / 失败率偏高」没有下一步**（REQ-SYS-030；UX-DS-313）：[查看日志] 没有接口（REQ-SYS-031，Q-SYS-05）。候选：说明行末加一句「可跑一轮诊断看第 ② 项」，或在故障行放 [重新诊断] 的跳转；本片不写 AC，稿件 f-sys-conn-01 照 v1。
8. **「保留卷」与「保留下来的成果」同物两名**（REQ-SYS-020）：本页沿用「保留卷」（P21-5、实现、v1），点开的对话框标题与横幅叫「保留下来的成果」（L1、L6）。留给 W2 一致性检查定：统一叫法，或保留本页叫法并在对话框说明里桥接一句。**已拍板（2026-10-04）：Q-SYS-23 选 A**——统一为「保留下来的成果」，资源卡「成果占用」、按钮 [清理成果]（REQ-SYS-020、021，AC-SYS-020.9）。

### 本片的默认决定与待确认（sys-b）

1. **按任务看时间线时清掉其余筛选**（REQ-AUD-003）：本组默认「进入时类别 / 仅告警 / 起止回到默认」，理由是按钮叫「完整时间线」，开着「仅告警」进去只能看到错误行、开着别的类别进去必然是空；现状保留其余筛选（useAuditFilters.ts:37-38）。要按现状，把 AC-AUD-003.3 的最后一句删掉即可，稿件 f-sys-audit-06 不受影响（稿面上其余筛选本来就在默认）。
2. **按任务筛选的条件写在筛选条里**（REQ-AUD-003）：plan 已定（「本页就地加『任务：<名称>』筛选 chip，可清除」）；chip 用 32 档（与筛选条其余控件同高），属新增样式，见稿件 f-sys-audit-06 与 notes/sys-b.md。
3. **起晚于止时列表保持上一次的结果**（REQ-AUD-020）：「不发请求」的直接推论；另一种做法是「清掉时间条件、显示不带时间的结果」，那要发请求，与 plan 冲突，不采用。
4. **没拿到清单就断开时，中断句不写「已到达的结果保留在下方」**（AC-DIA-003.5）：现状固定拼这半句，没有结果时它不成立。
5. Q-DIA-01 / Q-DIA-02 / Q-AUD-01 / Q-AUD-02 仍在 format-pilot 待裁决清单里，本片按 plan「按默认推进」写（9 项、定稿词、就地筛、四件）；裁决结果不同时，改对应 AC 的「Then」即可。
6. **「保留工作区卷」那一行有没有 [查看该任务完整时间线]**（REQ-AUD-003；2026-10-04 用户拍板 Q-SYS-23 A 之后这一行的摘要改说「保留成果（…）」，见 AC-AUD-003.7；入口给不给仍按本条默认）：P5 / v1 g6-02 的示例在 13:27 这一行画了入口，本组稿件按换皮规则（T-21）照抄，本片默认也给：按 detail 里来源任务的 `sandboxId` 筛（前端改动）。实现里这类记录的对象是成果（`subjectType = retained_volume`，audit.projector.ts:233-251），现状没有入口（auditRowModel.ts:115-117）。要按现状，就把 f-sys-audit-04 与 f-sys-diag-01…06 整页图里这一行的按钮去掉，原型同步。
7. **连接中那句、汇总句与中断句都挪到卡内首行**（REQ-DIA-001、REQ-DIA-003、REQ-DIA-040）：换皮时的形态变化，稿件头注释已逐条标「需看稿」（f-sys-diag-01 第 3 条、f-sys-diag-03 第 5 条、f-sys-diag-04…06 第 5 条）；文字不变，只改位置并加 role。「诊断中…」加前缀转圈按 components-v2 的加载中写法（UX-DS-204），稿件没有单列「需看稿」。

## 附录 D · 边界、覆盖对照、待核实与连带更正

### 依赖与边界（别的片负责）（sys-a）

| 部件 | 归谁 | 本片怎么引用 |
|---|---|---|
| 全局横幅的位置、级别、堆叠、文案（含「磁盘快满了」「保留下来的成果占了数据目录的 N%」两条治理横幅） | F-WB-BANNER · WB 域 REQ-WB-010–019（f-wb-banner-01…03） | REQ-SYS-020、075、076 只写「本页出哪条、动作在本页怎么处理」 |
| 「保留下来的成果」跨项目视图（范围、分组、下载、删除） | F-PRJ-RETAINED · PRJ 域 REQ-PRJ-056（f-prj-retained-05） | REQ-SYS-020 只写入口、出现条件与关闭后的焦点 |
| 诊断卡（连接中、逐项、中断、汇总、导出日志） | F-SYS-DIAG · REQ-DIA-001…040（sys-b） | REQ-SYS-076 只写横幅 [重新检测] 在本页触发一轮 |
| 审计流的骨架、失败、空态 | F-SYS-AUDIT · REQ-AUD-004（sys-b） | REQ-SYS-070、075 只引用 |
| 直接打开设置页时外壳先出哪套骨架 | F-WB-SHELL · WB 域 REQ-WB-060–069 | REQ-SYS-070 只管本页两张卡的骨架形状 |

## 附录 E · 合并时改动的地方

合并只做了下面这些改动；其余文字都是片段原文（本地待定编号已换成统一编号）。

| 需求 | 改动 | 为什么 |
|---|---|---|
| [REQ-SYS-001](#REQ-SYS-001) | 改写一句 | 按钮名按 Q-SYS-01② A（2026-10-04 用户拍板）写 [运行诊断] |
| [REQ-SYS-001](#REQ-SYS-001) | 加合并说明 | 入口范围的三个子项分别落到 WB / SBX |
| [REQ-SYS-003](#REQ-SYS-003) | 改写一句 | 现状词「未验证」统一为状态词表的「未核实」 |
| [REQ-SYS-003](#REQ-SYS-003) | 加合并说明 | 说明与 DR-03 A 的「名额」不冲突 |
| [REQ-SYS-020](#REQ-SYS-020) | 加合并说明 | 倒计时口径与 REQ-PRJ-055 统一（Q-SYS-11 ①） |
| [REQ-SYS-050](#REQ-SYS-050) | 改写一句 | 访问口令单独成域 ACC |
| [REQ-SYS-050](#REQ-SYS-050) | 加合并说明 | 与 ACC 域互相引用 |
| [REQ-SYS-060](#REQ-SYS-060) | 加合并说明 | 出网代理作用范围按实现统一（Q-SYS-16） |
| [REQ-DIA-005](#REQ-DIA-005) | 改写一句 | 现状词统一为状态词表（本试点未核代码 = 未核实） |
| [REQ-DIA-006](#REQ-DIA-006) | 加合并说明 | 同一缺陷的落点 |
| [REQ-DIA-017](#REQ-DIA-017) | 加合并说明 | 把 sys-b 改写对照里登记的用词落到本条 |
| [REQ-DIA-018](#REQ-DIA-018) | 加合并说明 | 与 REQ-IMG-040 / 043 统一（DR-36） |
| [REQ-SYS-071](#REQ-SYS-071) | 加合并说明 | 与 REQ-LCH-007 互相引用 |
