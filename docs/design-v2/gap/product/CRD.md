---
id: PRD-CRD
title: 凭证管理 · 产品需求
type: prd
status: draft
owner: 产品 owner（仓库唯一人类 owner）
domains: [CRD]
flows: [F-CRD-REVOKE, F-CRD-MODE, F-CRD-GIT, F-CRD-PAGE]
applies_to: ">= v0.2.4"
last_verified:
  docs: fd2e1ee
  api: a453bb7
  web: 93f03c5
  date: 2026-10-04
covers:
  - web/src/containers/credential/{AuthGateContainer,CredentialsContainer}.tsx
  - web/src/hooks/credential/{useRuntimeAuthFlow,useRuntimeAuthPanel,useRuntimeAuthMutations,useRuntimeAuthSync,useOpenAuthPage,useCredentials}.ts
  - web/src/lib/credential/{authFlow,runtimeCredential}.ts
  - web/src/views/settings/{AuthMethodRadioRow,ConfirmDialog,RuntimeCredentialCard}.view.tsx
  - api/packages/modules/credential/src/application/runtime-credential.service.ts
  - web/src/views/settings/{RevokeConfirmDialog,RuntimeCredentialsSection,RuntimeCredentialCard,AuthMethodRadioRow,GitCredentialsSection,GitCredentialCard,HttpsTokenForm,AllowedHostsEditor,SshKeyForm,KnownHostsRow,TestConnectionResult}.view.tsx
  - web/src/hooks/credential/{useCredentials,useAffectedTasks,useGitCredentialManager}.ts
  - web/src/lib/credential/{affectedTasks,runtimeCredential,credentialExpiry,gitCredential,gitPlatforms,maskAccount}.ts
  - web/src/containers/credential/CredentialsContainer.tsx、web/src/containers/project/{NewProjectContainer,ProjectRecoveryContainer,PendingCloneReturnGuard}.tsx
  - api/packages/modules/credential/src/application/{runtime-credential.service,credential-application.service,credential-facade.adapter}.ts
  - api/packages/modules/credential/src/infrastructure/git/git-ls-remote.tester.ts
  - api/packages/modules/sandbox/src/application/event-handlers/credential-revoked.handler.ts
  - api/packages/modules/sandbox/src/application/workflows/provision-sandbox.workflow.ts（注入那一段）
  - api/packages/modules/project/src/application/git-auth.ts
supersedes:
  - docs/product/pages/21-3-凭证管理.md §3 示意、§5 状态与状态图、§6 L114-118、§9 L133-136（Agent 凭证部分；Git 与删除凭证归 crd-b）
  - docs/product/pages/21-3-凭证管理.md（§5 状态矩阵的加载 / 无凭证 / 即将过期 / 已过期 / 吊销各行，§6「[吊销]」「搜索」，§9 吊销三条，§10 Git 凭证分区）
  - docs/product/22-异常场景与产品补充要求.md L57、L124-125、L127-128 中删除凭证与 Git 回程的部分
  - docs/product/20-核心使用链路.md L252「吊销」
drafts:
  - gap/drafts/f-auth-panel-01…09.html、f-crd-mode-01.html、f-acc-unlock-01…03.html（说明 gap/drafts/notes/crd-a.md）
  - gap/drafts/f-crd-revoke-01…03、f-crd-git-01…05、f-crd-page-01…05（说明 gap/drafts/notes/crd-b.md）
merged_from:
  - gap/product/_parts/crd-a.md
  - gap/product/_parts/crd-b.md
merged_at: 2026-10-04
review_minutes: 65
---

# 凭证管理 · 产品需求

<!-- 本文件只写「做什么 / 为什么 / 怎样算做对」。布局与视觉在稿件（gap/drafts/f-*），实现方法在技术设计。由 gap/product/_build/merge.py 从 _parts 合并生成；改片段后重新运行。「现状」列暂留文件:行出处，入库时按 01 §4.2 换成证据 ID。 -->

## 一屏摘要

- **这一域回答什么**：凭证管理页——删除 Agent 凭证（如实披露会被销毁的任务）、切换生效方式（帐号登录 ↔ API Key）、Git 凭证（测试连接 / 配置 HTTPS Token / 配置 SSH 密钥 / 更换 / 删除）、页面的加载、读取失败、搜索、有效期与从克隆失败跳来的回程（REQ-CRD-001–034）。
- **五条要守的规则**：
  1. 上屏只说「删除」，「吊销」只作内部事件名；删 Agent 凭证的后果写「销毁」，不写「重启」（REQ-CRD-001）。
  2. 删除确认框打开即如实列出会被销毁的任务；读不到就明说并可重试，**不得**说成「没有任务」（REQ-CRD-002）。
  3. 删一份 Agent 凭证只波及这个 Agent 自己的任务，被销毁任务的代码副本保留为成果（REQ-CRD-003，D3）。
  4. 切换生效方式先确认、确认前单选不动；在闸门或卡上配好的方式什么时候自动生效，见 REQ-CRD-011（REQ-CRD-010–012）。
  5. 读不到 ≠ 没有：两份列表读取失败各自明说 + [重试]，**不得**退化成「未配置」或「没有匹配」；Git 凭证只在平台侧克隆 / 拉取时用（REQ-CRD-031、024）。
- **现状**：20 条需求里 `已实现` 2 · `部分实现` 11 · `未实现` 1 · `偏离` 5 · `实现先行` 1。删除 Agent 凭证的主干能用；偏离在确认框清单由前端自算、建实例时跨 Agent 注入（待 D3）、用词（「确认删除」「会被重启」「吊销」）、Git 凭证删除没有确认框、[测试连接] 可能误报、两张卡的单选互抢（DR-20）、不定位到 Git 分区、Esc 在弹层开着时也直接回工作台、切换确认框没有 Esc 与初始焦点。后端：DR-07 预检、D3、DR-14、准备中任务的竞态（待核实）。
- **待定**：Q-CRD-01…03（[open-questions.md](./open-questions.md)）；D3、DR-05、DR-07 在 00-决策简报与 BACKLOG 里。

**状态词表**：`已实现`（行为与本文一致）· `部分实现` · `未实现` · `偏离`（实现与本文不同）· `实现先行`（代码已有、原产品文档没写，待确认）· `未核实` · `计划中`（目标版本未到，或待某条待定问题选定后才生效）。「层级」= 最低验证层（单元 / 组件 / 集成 / API / e2e；`文档` = 文档一致性检查，`视觉` = 截图比对）。

## 需求索引

**共 20 条需求、94 条验收标准**：`已实现` 2 · `部分实现` 11 · `未实现` 1 · `偏离` 5 · `实现先行` 1。

| 编号 | 需求 | 状态 | 版本 | AC | 稿件 | 待定问题 |
|---|---|---|---|---:|---|---|
| [REQ-CRD-001](#REQ-CRD-001) | 上屏只说「删除」：确认框标题「删除 X 的 Y？」、按钮写动作本身 | `偏离` | MVP | 3 | f-crd-revoke-01、f-crd-revoke-02、f-crd-revoke-03 | — |
| [REQ-CRD-002](#REQ-CRD-002) | 打开即如实列出会被销毁的任务：按绑定、最多 10 条、读不到明说可重试、没有就说没有 | `偏离` | MVP | 6 | f-crd-revoke-01、f-crd-revoke-02、f-crd-revoke-03 | — |
| [REQ-CRD-003](#REQ-CRD-003) | 波及范围：只销毁本 Agent 的在跑任务、保留代码副本；准备中任务写进「删掉之后」 | `偏离` | MVP | 6 | f-crd-revoke-01、f-crd-revoke-03 | — |
| [REQ-CRD-004](#REQ-CRD-004) | 删的是当前生效方式：删前说清，删后追问要不要切到另一种 | `部分实现` | MVP | 4 | f-crd-revoke-01、f-crd-revoke-02、f-crd-revoke-03、f-crd-mode-01 | — |
| [REQ-CRD-005](#REQ-CRD-005) | 确认之后：立即生效、轻提示、卡片原地刷新；任务走删除中后移除；失败说人话 | `部分实现` | MVP | 4 | — | — |
| [REQ-CRD-010](#REQ-CRD-010) | 切到已配置的方式：确认 → 切换 →「当前使用」移动 | `部分实现` | MVP | 4 | f-crd-mode-01 | — |
| [REQ-CRD-011](#REQ-CRD-011) | 什么时候「配好即生效」 | `偏离` | MVP | 4 | 无单独稿 | — |
| [REQ-CRD-012](#REQ-CRD-012) | 单选按 Agent 分组，确认前不动 | `偏离` | MVP | 2 | f-crd-mode-01 | — |
| [REQ-CRD-020](#REQ-CRD-020) | Git 分区：已配置卡、未配置卡、缺哪种补哪种，永不回显 | `部分实现` | MVP | 5 | f-crd-git-01、f-crd-git-02 | — |
| [REQ-CRD-021](#REQ-CRD-021) | 配置 HTTPS Token：来源推导 host、白名单、scope 提示、可选的测试、保存只留尾号 | `部分实现` | MVP | 6 | f-crd-git-03 | — |
| [REQ-CRD-022](#REQ-CRD-022) | 配置 SSH 密钥：保存前本地预检、只显指纹、主机指纹首连信任可核对 | `部分实现` | MVP | 5 | f-crd-git-04 | — |
| [REQ-CRD-023](#REQ-CRD-023) | 测试连接：最多 15 秒、原位三态、按错误码说人话、目标仓库 | `部分实现` | MVP | 7 | f-crd-git-01、f-crd-git-03 | — |
| [REQ-CRD-024](#REQ-CRD-024) | 使用范围与选择规则：只在平台侧克隆 / 拉取时用、按地址协议选、Token 只发给白名单 host | `已实现` | MVP | 3 | — | — |
| [REQ-CRD-025](#REQ-CRD-025) | [更换]：同类型空表单，保存即替换旧的那份 | `实现先行` | MVP | 4 | f-crd-git-04 | — |
| [REQ-CRD-026](#REQ-CRD-026) | 删除 Git 凭证：统一破坏性确认，说清后果、如实列出相关项目 | `未实现` | MVP | 6 | f-crd-git-05、f-crd-git-02 | — |
| [REQ-CRD-030](#REQ-CRD-030) | 首次加载：两个分区各自骨架，与真卡同结构同高 | `部分实现` | MVP | 4 | f-crd-page-01 | — |
| [REQ-CRD-031](#REQ-CRD-031) | 读取失败：两份各自明说 + [重试]，不退化成「未配置」或「没有匹配」 | `已实现` | MVP | 4 | f-crd-page-02 | — |
| [REQ-CRD-032](#REQ-CRD-032) | 搜索 Agent：过滤名字与打码标识的可见部分；无匹配与本来为空分开说 | `部分实现` | MVP | 5 | f-crd-page-03 | — |
| [REQ-CRD-033](#REQ-CRD-033) | 有效期：即将过期 / 已过期，建议句与 [重新登录] | `部分实现` | MVP | 6 | f-crd-page-04 | [Q-DS-32](./open-questions.md#Q-DS-32) |
| [REQ-CRD-034](#REQ-CRD-034) | 从克隆失败跳来的回程：Git 分区回程条、重试克隆 / 放弃 | `部分实现` | MVP | 6 | f-crd-page-05 | — |

「待定问题」一列链到 [open-questions.md](./open-questions.md)，不回复时按那里写的默认走。

## 与旧文档的对照

由各条「改写了哪条旧文」汇总；旧文档代号见 [README](./README.md#旧文档代号)。逐条的旧文与新口径见每条需求，以及文末附录 A。

| 旧文档 | 被改写的位置 → 本文 | 其中作废 / 删去的 |
|---|---|---|
| P20 核心使用链路 | L252 → REQ-CRD-001；L207 → REQ-CRD-011 | — |
| P22 异常场景与产品补充要求 | L128 → REQ-CRD-003；L127 → REQ-CRD-004；L126 → REQ-CRD-011；L57 → REQ-CRD-034 | — |
| P21-2 发起任务向导 | L73 → REQ-CRD-011 | — |
| P21-3 凭证管理 | 全文 → REQ-CRD-001；L60、L133 → REQ-CRD-002；L61、L101、L133 → REQ-CRD-003；L136、L76-78 → REQ-CRD-004；L59-61 → REQ-CRD-005；L114、L20、L114 → REQ-CRD-010；L114 → REQ-CRD-011；L150 → REQ-CRD-020；L161、L160-161、L180-184 → REQ-CRD-021；L160 → REQ-CRD-022；L163、L198 → REQ-CRD-023；L197-199 → REQ-CRD-024；L150 → REQ-CRD-025；L150 → REQ-CRD-026；L53 → REQ-CRD-030；§5 → REQ-CRD-031；L54、L119 → REQ-CRD-032；L56 → REQ-CRD-033；L165 → REQ-CRD-034 | — |

只改写实现现状、试点或稿件口径（不涉及上表旧文档）的需求：REQ-CRD-012。

---

## CRD · 删除 Agent 凭证（F-CRD-REVOKE）

### REQ-CRD-001 · 上屏只说「删除」：确认框标题「删除 X 的 Y？」、按钮写动作本身 {#REQ-CRD-001}

> 状态 `偏离` · 版本 MVP · 来源 Q-DS-21 A（spec/content.md:77 第 13 条：上屏用「删除凭证」，「吊销」只作内部事件名）；UX-DS-408（content.md:42：按钮文案就是动作本身）；DR-35 ①②（BACKLOG §4）；P21-3 L8、L23-25、L47、L60-61、L117、L133、L136；P20 L252；实现 RevokeConfirmDialog.view.tsx:55-57、80、97，runtimeCredential.ts:121-122、131-132 · 关联 UX-DS-307 · 稿件 f-crd-revoke-01、02、03

凭证页上「删掉一份 Agent 凭证」这个动作**必须**叫「删除」：行内入口 [删除]（进入二次确认的入口，危险色文字按钮）；确认框标题「删除 <Agent 名> 的<方式名>？」（方式名 = 帐号登录 / API Key），副标题说明它是不是当前在用的那份（「凭证 · 当前在用」）。危险按钮写动作本身：会销毁任务时写「删除并销毁 N 个任务」，清单读不到或没有任务在用时写「删除凭证」，**不得**写「确定」「确认删除」。上屏任何地方**不得**出现「吊销」（只作内部事件名 `CredentialRevoked`），也**不得**把销毁说成「重启」（后端实际是销毁，DR-35 ②）。

**改写了哪条旧文**：P21-3 全文的「吊销」（L8、L23 与 L25「[吊销]」、L47、L60-61、L76-78、L98-101、L117、L133、L136、L150「[吊销]」）与 P20 L252「吊销」→「删除」；现状确认框「这些正在跑的任务会被重启：」与警示句「删除会重启正在用这份凭证跑的任务」→「会销毁」（DR-35 ②）；跟进句「…那边才是唯一能真正吊销它的地方」→「…只有那边能让它真正失效」（DR-35 ①）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-CRD-001.1 | 组件 | 删 Codex 的帐号登录（当前在用），会销毁 5 个任务 | 打开确认框 | 标题「删除 Codex 的帐号登录？」、副标题「凭证 · 当前在用」；危险按钮「删除并销毁 5 个任务」 | 偏离：标题已是这句（RevokeConfirmDialog.view.tsx:55-57），没有副标题；按钮恒为「确认删除」、不写数量（:97） |
| AC-CRD-001.2 | 组件 | 清单读不到，或没有任务在用 | 打开确认框 | 危险按钮「删除凭证」，不编数量 | 偏离：恒为「确认删除」（:97） |
| AC-CRD-001.3 | 单元 | 凭证页、删除确认框、删后的轻提示与追问框 | 扫上屏文字 | 不含「吊销」「重启」 | 偏离：「这些正在跑的任务会被重启：」（:80）、「删除会重启正在用这份凭证跑的任务…」（runtimeCredential.ts:121-122）、「…那边才是唯一能真正吊销它的地方」（:131-132） |

### REQ-CRD-002 · 打开即如实列出会被销毁的任务：按绑定、最多 10 条、读不到明说可重试、没有就说没有 {#REQ-CRD-002}

> 状态 `偏离` · 版本 MVP · 来源 P21-3 L60、L117、L123、L133；Q-DS-17 A（UX-DS-307：受影响清单由后端给，拿不到就明说；焦点默认在「取消」；Esc = 取消）；DR-07（不回复默认：读不到就明说；前端自算至少对齐后端 LIVE）；实现 affectedTasks.ts:12-27、useAffectedTasks.ts:36-57、RevokeConfirmDialog.view.tsx:48-54、73-90；api credential-revoked.handler.ts:14、73-81 · 关联 PARAM.REVOKE_LIST_MAX · 稿件 f-crd-revoke-01（有清单）、02（读不到）、03（没有）

点 [删除] 后，确认框**必须**马上说清这一下会销毁哪些任务。清单口径与后端实际销毁的一致：**注入过这份凭证、且状态在 running / idle / starting 的任务**（「等待你输入」「空闲」都属于运行中，列出时用树上的状态词）。每条写「任务名 · Agent · 状态词」，最多列 `PARAM.REVOKE_LIST_MAX` 条，多出的折成「等共 N 个」。分段按 Q-DS-17 A 的固定顺序：会销毁这 N 个任务 → 会留下 → 平台删不掉 → 删掉之后 → 不受影响 → 清单来源一行（12 次要灰）。三种情况**必须**分开：

1. **拿到清单、非空**：如上。
2. **清单读不到**（接口失败或还没返回）：「会销毁」一段换成警示块——标题「会被销毁的任务清单暂时查不到」、说明「凭证绑定表这次没读出来 —— 这不代表没有任务在用它。正在用这份凭证的任务都会被销毁，代码副本保留为成果。」+ [重试读取]；**不得**说成「没有任务」；危险按钮仍可点，写「删除凭证」。[重试读取] 成功后在同一个框里换成情况 1 或 3，框不关。
3. **拿到清单、为空**：「不受影响」写「现在没有任务在用这份凭证，不会销毁任何任务」，照样写清单来源。

打开时焦点在 [取消]；[取消]、Esc、点遮罩都只关框、留在凭证页、不删。清单来源：后端只读预检接口（DR-07 推荐，例如 `GET …/credentials/:id/deletion-impact`，与 D3 的销毁口径同一套），来源行写「后端凭证绑定表」；接口落地前前端自算**至少**对齐后端口径（同一 Agent × running / idle / starting），来源行如实写「前端按 Agent 推算」。

<details>
<summary>为什么</summary>

这是一个不可逆操作的确认框。前端自算的清单今天会漏掉空闲的任务、多算还没注入的 pending 任务；读不到时若显示成空，用户会以为「没有任务在用」而按下删除——正是 useAffectedTasks.ts 头注释记下的那次事故。

</details>

**改写了哪条旧文**：P21-3 L60「吊销确认中 → 确认框 + 受影响 Task 列表」、L117「二次确认（列出受影响运行中 Task）」、L123「受影响 Task：`['sandboxes','list']` 本地按 runtime 过滤」→ 清单按后端绑定给（DR-07），读不到 / 没有分开说；P21-3 L133「最多列 10 条 +『等共 N 个』折叠」保留。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-CRD-002.1 | 集成 | 绑定表里 Codex 帐号登录绑了 5 个 LIVE 任务（2 个等待你输入、1 个运行中、1 个空闲、1 个无头运行中） | 打开确认框 | 「会销毁这 5 个任务」列 5 条，空闲那条在内，每条「名 · Codex · 状态词」 | 偏离：前端按同 Agent × running / starting / pending / waiting_input 自算（affectedTasks.ts:12、20），空闲（idle）漏列、pending 多列 |
| AC-CRD-002.2 | 组件 | 会销毁 12 个 | 打开确认框 | 列 10 条 +「等共 12 个」 | 已实现：affectedTasks.ts:13、21-25，RevokeConfirmDialog.view.tsx:85 |
| AC-CRD-002.3 | 组件 | 清单接口失败 | 打开确认框 | 警示块（标题 + 说明 + [重试读取]）；不出现「没有任务」；危险按钮「删除凭证」可点 | 部分实现：有一句「正在跑的任务清单暂时查不到，删除前请自行确认。」（RevokeConfirmDialog.view.tsx:73-77），没有 [重试读取]，按钮「确认删除」 |
| AC-CRD-002.4 | 集成 | AC-CRD-002.3 的框开着 | 点 [重试读取]，这次读到了 | 同一个框里换成 AC-CRD-002.1 或 002.5 的内容，框不关、焦点留在框内 | 未实现：没有手动重试（列表查询自己重取成功时会自动换，useAffectedTasks.ts:49） |
| AC-CRD-002.5 | 组件 | 绑定表里没有任务在用这份凭证 | 打开确认框 | 「不受影响」写「现在没有任务在用这份凭证，不会销毁任何任务」+ 清单来源一行 | 部分实现：有「现在没有任务在用这份凭证。」（:88-90），没有来源行 |
| AC-CRD-002.6 | e2e | 确认框打开 | 看焦点；按 Esc | 焦点在 [取消]；Esc 只关框，仍在凭证页，凭证还在 | 偏离：手写遮罩，没有初始焦点（RevokeConfirmDialog.view.tsx:48-54）；Esc 被设置区全局监听直接跳回工作台（app/settings/layout.tsx:50-58） |

### REQ-CRD-003 · 波及范围：只销毁本 Agent 的在跑任务、保留代码副本；准备中任务写进「删掉之后」 {#REQ-CRD-003}

> 状态 `偏离`（待 D3 落地）· 版本 MVP · 来源 D3（00-决策简报 L31、L87：只影响该凭证所属 Agent 的任务，并停止向其他 Agent 注入）；DR-05 ①A / ②A（BACKLOG §1，按推荐）；DR-35 ②；P21-3 L61、L98-101、L133；P22 L127-128；实现 provision-sandbox.workflow.ts:518-533（跨 Agent 注入）、:536-577（缺凭证以未登录启动）、credential-revoked.handler.ts:14-19、38-50、73-146 · 关联 PARAM.RETENTION_DAYS_DEFAULT · PARAM.REVOKE_GRACEFUL_DESTROY_S · PARAM.REVOKE_FORCE_DESTROY_S · 稿件 f-crd-revoke-01、03

删除一份 Agent 凭证**必须**只波及这个 Agent 自己的任务：平台给任务注入凭证时只注入该任务所用 Agent 的那一份（停止跨 Agent 注入，D3）；因此删 Claude Code 的凭证**不得**销毁任何 Codex 任务。

- **会销毁**：注入过这份凭证、仍在运行的任务（REQ-CRD-002 的口径）。先优雅停止，`PARAM.REVOKE_GRACEFUL_DESTROY_S` 秒没停下转强制，强制最多 `PARAM.REVOKE_FORCE_DESTROY_S` 秒（实现先行）。
- **会留下**：被销毁任务的代码副本，**必须**保留为成果，`PARAM.RETENTION_DAYS_DEFAULT` 天后自动清理（可在「保留下来的成果」里下载）。
- **平台删不掉**：已经从任务里带出去的 token / key。**必须**写出这一条并给出路：「担心已经外流的话，去 <厂商> 后台把它作废，只有那边能让它真正失效。」（厂商 = OpenAI / Anthropic）。
- **删掉之后**：同一 Agent 里还没走到注入那一步的**准备中**任务不销毁，但**必须**列出名字：「<名> · <Agent> · 准备中」+「还没注入凭证，不会被销毁；但它启动时 <Agent> 若还没有可用的凭证（没切到 API Key、也没重新登录），会以未登录状态起来。」（DR-05 ②A）。删的是当前生效方式时另见 REQ-CRD-004。
- **不受影响**：同一 Agent 的另一种方式、Git 凭证（都不动）；其他 Agent 的任务（「这份凭证只注入 <Agent> 自己的任务」）；各项目的代码和远端 Git 仓库。
- **过渡期**：D3 落地前（实现仍跨 Agent 注入），若清单仍由前端按 Agent 推算，**必须**加一句「跨 Agent 注入的任务不在这份清单里」（DR-07 不回复默认），不能让确认框比实际少说。

<details>
<summary>为什么是「销毁」而不是「继续跑、标 ⚠️」</summary>

环境变量形态的凭证一旦注入进程，平台从外面撤不回来，只有停掉进程才算真的删掉（credential-revoked.handler.ts:38-50 的注释与 05 §4）。旧文「继续跑、标 ⚠️」与实现相反，用户按旧文理解会以为任务还在。代码副本保留为成果，所以销毁不丢代码。

</details>

**改写了哪条旧文**：P21-3 L61「吊销成功 → 卡片转未授权态 + toast + 相关 Task 标 ⚠️」、P22 L128「凭证被吊销 / 过期后，运行中的 Task 标 ⚠️ 凭证已失效（不改主状态）…运行中 Task 下次重启生效」中「吊销」那一半 → 删除即销毁注入过它的在跑任务（保留代码副本），不是继续跑（「过期」那一半不在本片）；P21-3 L101、L133「吊销联动清除已注入文件 / 环境变量」→「销毁注入过它的任务」（DR-35 ②）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-CRD-003.1 | 集成 | Codex 任务 A 运行中；镜像同时支持 Codex 与 Claude Code，两个 Agent 都配了凭证 | 删除 Claude Code 的 API Key | A 不被销毁（A 本来就没有被注入 Claude Code 的凭证） | 偏离：建实例时把镜像支持的所有 Agent 的凭证都注入并记账（provision-sandbox.workflow.ts:518-533、618-637），删 Claude Code 的凭证会按绑定销毁 A（credential-revoked.handler.ts:76-80）；待 D3 |
| AC-CRD-003.2 | 集成 | Codex 任务 B 运行中，注入过 Codex 帐号登录 | 删除 Codex 帐号登录 | B 先优雅停止、超时转强制；B 的代码副本留成成果（30 天） | 已实现：credential-revoked.handler.ts:17-19、103-146，`keepVolume: true`（:118、:133） |
| AC-CRD-003.3 | 组件 | Codex 任务 C 准备中（还没注入） | 打开删除 Codex 帐号登录的确认框 | C 不在「会销毁」里；「删掉之后」列「C · Codex · 准备中」+ 说明句 | 未实现：前端把 pending / starting 算进「会被重启」（affectedTasks.ts:12），没有准备中这一句 |
| AC-CRD-003.4 | 集成 | C 处于 pending…preparing-workspace，Codex 生效方式的凭证刚被删 | C 继续启动 | C 以未登录状态起来；审计记「没有可用的 codex 凭证，agent 将以未登录状态启动」 | 已实现：provision-sandbox.workflow.ts:536-577 |
| AC-CRD-003.5 | 组件 | 任一会销毁任务的删除确认框 | 打开 | 「平台删不掉」写「已经从任务里带出去的 token」+ 去厂商后台作废的一句 | 部分实现：有警示句与跟进句（runtimeCredential.ts:121-122、131-132），用词见 AC-CRD-001.3 |
| AC-CRD-003.6 | 集成 | 任务 D 已过了准备凭证那一步（creating）、还没走到注入记账（starting 第 ④ 步） | 此时删除这份凭证 | D 不得带着被删的凭证起来：要么被列进「会销毁」并销毁，要么以未登录状态起来 | 未核实：代码推断 D 会带着已删的凭证起来且不进绑定表，见文末「待核实」① |

### REQ-CRD-004 · 删的是当前生效方式：删前说清，删后追问要不要切到另一种 {#REQ-CRD-004}

> 状态 `部分实现` · 版本 MVP · 来源 P21-3 L76-78、L136；P22 L127；DR-35 ⑩（「切换到API Key」补空格）；实现 RevokeConfirmDialog.view.tsx:67-71、useCredentials.ts:285-304、runtimeCredential.ts:147-149、157-159、AuthMethodRadioRow.view.tsx:102-114；api runtime-credential.service.ts:243-248 · 关联 REQ-CRD-010–019（F-CRD-MODE，crd-a）· 稿件 f-crd-revoke-01、02（另一种已配置）、03（另一种未配置）；追问框 = f-crd-mode-01 头注释「同一个框的变体」

删的是这个 Agent 当前生效的那份时，确认框「删掉之后」第一条**必须**写「这个 Agent 现在用的就是它，删掉就不能用了」，并按另一种方式的情况接半句：另一种已配置 →「—— 它的 <另一种> 还留着，删完会问你要不要切过去」；另一种未配置 →「—— 要再发 <Agent> 任务，先登录帐号或重新添加 API Key」。

删除成功后：

- **另一种已配置**：立刻用 F-CRD-MODE 的确认框追问——标题「切换到 <另一种>」、正文「这个 Agent 现在没有可用的凭证了。它的 <另一种> 还留着 —— 要现在切过去用吗？」、按钮 [取消] / [切过去]。[切过去] = 切换生效方式（REQ-CRD-010–019）+ 轻提示「已切换到 <另一种>」。
- **另一种未配置，或在追问里点了 [取消]**：这个 Agent 没有生效中的凭证——卡头「未配置」，两行都**不得**显示「当前使用」；之后新建任务选它会出现凭证闸门（F-AUTH-PANEL）。
- **删的不是当前生效方式**：不追问，只有那一行转「未配置」。

**改写了哪条旧文**：P21-3 L136、P22 L127「确认弹层额外提示"该模式将不可用"」→「这个 Agent 现在用的就是它，删掉就不能用了 —— …」两种接法；P21-3 L76-78 状态图「吊销帐号授权 → 询问 →『切换过去』/『不切换』」→「删除 → 追问「切过去」/ 取消」。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-CRD-004.1 | 组件 | Codex 帐号登录当前在用，API Key 已配置 | 打开删除帐号登录的确认框 | 「删掉之后」第一条「这个 Agent 现在用的就是它，删掉就不能用了 —— 它的 API Key 还留着，删完会问你要不要切过去」 | 部分实现：只有前半句「这个 Agent 现在用的就是它，删掉就不能用了。」（RevokeConfirmDialog.view.tsx:67-71） |
| AC-CRD-004.2 | e2e | 同上 | 确认删除，204 | 追问框：标题「切换到 API Key」、正文「这个 Agent 现在没有可用的凭证了。它的 API Key 还留着 —— 要现在切过去用吗？」、[切过去] | 部分实现：追问已有（useCredentials.ts:296-304）；标题与正文「切换到API Key」「它的API Key还留着」缺空格（runtimeCredential.ts:147-149、157-159，DR-35 ⑩） |
| AC-CRD-004.3 | 集成 | Claude Code 只配了 API Key 且在用 | 删除它 | 不追问；卡头「未配置」；之后新建任务选 Claude Code 出现凭证闸门 | 已实现：只有「当前在用且另一种已配置」才追问（useCredentials.ts:296）；闸门见 F-AUTH-PANEL |
| AC-CRD-004.4 | 组件 | AC-CRD-004.2 的追问框 | 点 [取消] | 卡头「未配置」；两行都不显示「当前使用」，单选不选中被删的那一行 | 偏离：后端仍把生效方式记在被删的那一种（runtime 模块不处理删除；view 因选不出凭证回 `none`，runtime-credential.service.ts:243-248），于是空着的「帐号登录」行单选选中并显示「当前使用」（AuthMethodRadioRow.view.tsx:102-114） |

### REQ-CRD-005 · 确认之后：立即生效、轻提示、卡片原地刷新；任务走删除中后移除；失败说人话 {#REQ-CRD-005}

> 状态 `部分实现` · 版本 MVP · 来源 P21-3 L59-61、L117；P20 L252；UX-DS-508（轻提示只确认刚做的一步，不报告异步结果）；UX-DS-305（不直接显示后端 message）；实现 RevokeConfirmDialog.view.tsx:92-99、useCredentials.ts:285-311、useRuntimeAuthMutations.ts:16-17；api runtime.controller.ts:100-101、runtime-credential.service.ts:295-307、credential-revoked.handler.ts:66-81 · 关联 F-SBX-DESTROY（删除中过程）· 稿件 —（不另出稿：轻提示用 W0 .toast；树上的删除中归 F-SBX-DESTROY）

按下危险按钮后两个按钮都禁用，危险按钮写「删除中…」。接口 204 后关框，主区右上角轻提示「已删除」（role=status，4 秒），凭证卡原地刷新（该行转「未配置」，或按 REQ-CRD-004 追问）。删除对凭证即时生效（密文擦除，只留审计元数据）；对任务是异步的：清单里的任务在树上陆续进入「删除中」再移除，树组计数、导航徽标、总览随之变——轻提示**不得**报告「任务已全部销毁」这类异步结果。删除失败：关框，轻提示「删除失败，请稍后重试。」（role=alert），凭证不变；**不得**直接显示后端 message 原文。

已知缺口（待核实 ③）：强制销毁也失败的任务会留在原状态、绑定留着「待重试」，但现状没有任何重试方，界面也不提示。

**改写了哪条旧文**：P21-3 L59-61「吊销成功 → 卡片转未授权态 + toast + 相关 Task 标 ⚠️」→ 轻提示「已删除」+ 卡片原地刷新 + 任务走删除中后移除（不标 ⚠️，见 REQ-CRD-003）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-CRD-005.1 | e2e | 确认框打开 | 点危险按钮 | 两个按钮禁用、危险按钮「删除中…」；204 后关框，轻提示「已删除」，该行转「未配置」 | 已实现：RevokeConfirmDialog.view.tsx:93-98，useCredentials.ts:291-293（轻提示是 sonner，v2 换 W0 .toast） |
| AC-CRD-005.2 | 集成 | 删除时有 5 个会销毁的任务 | 204 之后 | 5 个任务在树上进入「删除中」后移除；树组计数、导航徽标、总览三处一致 | 部分实现：后端按绑定逐个销毁并推 sandbox.status_changed / sandbox.removed（credential-revoked.handler.ts:73-81）；树上「删除中」的样子与计数见 F-SBX-DESTROY（未核实） |
| AC-CRD-005.3 | 组件 | DELETE 返回 500 | 点危险按钮 | 关框，轻提示「删除失败，请稍后重试。」（role=alert），凭证不变 | 偏离：优先显示后端 envelope.message 原文（useCredentials.ts:306-307） |
| AC-CRD-005.4 | API | 同一凭证 | 连续 DELETE 两次 | 两次都 204（幂等） | 已实现：runtime-credential.service.ts:300 |

## CRD · 切换生效方式（F-CRD-MODE）

### REQ-CRD-010 · 切到已配置的方式：确认 → 切换 →「当前使用」移动 {#REQ-CRD-010}

> 状态 `部分实现` · 版本 MVP · 来源 P21-3 L26-27、L73-74、L80-82、L114、L135；P20 L249；Q-DS-17（非破坏性确认不用 danger）；DR-35 ⑩；实现 useCredentials.ts:200-243、runtimeCredential.ts:101-113、:135-149、ConfirmDialog.view.tsx:21-43、useRuntimeAuthMutations.ts:49-57；api runtime-application.service.ts:450-471 · 关联 U-42、U-95 · 稿件 f-crd-mode-01

凭证页一张 Agent 卡里，点未生效那一行的单选：那种方式已配置 → 弹普通确认框（非破坏性）：标题「切换到 <方式>」（中英文之间留空格）、副标题「<Agent> · 当前使用：<现在的方式>」、正文按目标方式「之后新开的任务会用 API Key（按量计费），已经在跑的任务不受影响。」/「之后新开的任务会用帐号登录（走订阅额度），已经在跑的任务不受影响。」、[取消]（打开时焦点在这里）与 [切换]；Esc 与右上关闭等同 [取消]。确认 → 切换中（按钮忙、不可重复提交）→ 成功：「当前使用」徽标与单选移到新的一行，轻提示「已切换到 <方式>」；失败：关框、轻提示失败句（按码，不上屏后端原句），徽标不动。切换只改「谁生效」：两种凭证都留着，切回不用重新登录；只影响之后新开的任务（已停止的任务下次启动时按新方式注入），已经在跑的不受影响。

**改写了哪条旧文**：P21-3 L114 确认弹层文案「切换后新任务将使用 API Key（按量计费），已运行任务不受影响」→ 实现的口语句（runtimeCredential.ts:135-139，v1 g4-08 照用）；P21-3 L20、L114「[生效中] 徽标」→「当前使用」（实现 AuthMethodRadioRow.view.tsx:112、P3）；标题与轻提示「切换到API Key」「已切换到API Key」→ 加空格（DR-35 ⑩）；新增副标题（说清是哪个 Agent、从哪种方式切过来）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-CRD-010.1 | 组件 | Codex 两种都已配置，帐号登录生效 | 点 API Key 行的单选 | 确认框：标题「切换到 API Key」、副标题「Codex · 当前使用：帐号登录」、正文、[取消][切换]；焦点在 [取消]；单选仍在帐号登录 | 部分实现：框与正文已有（useCredentials.ts:210-217）；标题缺空格（runtimeCredential.ts:147-149）；没有副标题；不设初始焦点（ConfirmDialog.view.tsx:22-43）（稿件 f-crd-mode-01） |
| AC-CRD-010.2 | 集成 | 确认框打开 | 点 [切换] | PUT auth-mode 1 次，切换中按钮不可再点；成功后徽标移到 API Key 行，轻提示「已切换到 API Key」 | 部分实现：已实现（useCredentials.ts:223-240）；轻提示缺空格（:230） |
| AC-CRD-010.3 | 集成 | 打开确认框之后目标方式被删 | 点 [切换] | 后端 409；框关闭，轻提示前端句；徽标不动 | 部分实现：409 已有（runtime-application.service.ts:453-457）；失败句是后端英文原句经 errorMessageOf 上屏（useCredentials.ts:139-143、:234） |
| AC-CRD-010.4 | 组件 | 确认框打开 | 按 Esc / 点右上关闭 | 关框，什么都不变 | 未实现：ConfirmDialog 没有 Esc 处理与关闭按钮（ConfirmDialog.view.tsx:22-43） |

### REQ-CRD-011 · 什么时候「配好即生效」 {#REQ-CRD-011}

> 状态 `偏离` · 版本 MVP · 来源 P21-3 L75、L114；P22 L126；P20 L207、L249；P21-2 L73；U-40 的口径缺口；I-RTS-3；实现 runtimeCredential.ts:101-113（needs-setup）、useCredentials.ts:200-209（只展开面板）、runtime-credential.service.ts:146-159（已有 runtime_settings 行就不改生效方式）、runtime-application.service.ts:79-82（credentialStatus 按生效方式算） · 稿件 无单独稿（面板见 f-auth-panel-08、09；f-auth-panel-09 头注释写了第 3 条）

点未配置那一行的单选：**不得**弹确认框、**不得**报错；就地展开那种方式的登录面板（REQ-AUTH-001，停在对应标签），单选在配好之前不动。配好之后要不要让它生效，按三条：

1. **从单选进来**：配好即成为生效方式（用户点单选就是在说「用这个」），「当前使用」移过去，轻提示「已切换到 <方式>」。
2. **这个 Agent 当前没有可用的生效方式**（从未配置；生效的那份已删除或已过期）：任何入口（新建任务闸门、向导、凭证页任一按钮）配好的方式都直接成为生效方式。
3. **其余**（当前生效的方式可用，从 [添加 API Key] / [更换] / [重新登录] 进来）：只保存、不切换（I-RTS-3）；要切走 REQ-CRD-010。

**改写了哪条旧文**：P21-3 L114「若未配置：就地展开该模式的配置面板，配置完成即自动切换」、P22 L126 保留为第 1 条；P20 L207 / P21-2 L73「在闸门中完成配置的方式即成为该 runtime 的全局生效模式」保留为第 2 条，并把「从未配置」扩到「生效的那份已删除或已过期」；第 3 条是原文没写的（U-40 指出的缺口），按实现补。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-CRD-011.1 | e2e | Claude Code 两种都未配置 | 点 API Key 行单选 | 不弹框；卡内展开面板停在 API Key 标签；单选不动 | 已实现：runtimeCredential.ts:101-113、useCredentials.ts:206-208 |
| AC-CRD-011.2 | 集成 | Codex 帐号登录生效且可用、API Key 未配置 | 点 API Key 单选 → 保存 key 成功 | API Key 成为当前使用；轻提示「已切换到 API Key」 | 偏离：只保存、不切换（runtime-credential.service.ts:146-159），要再点一次单选走确认框 |
| AC-CRD-011.3 | 集成 | Codex 帐号登录已删除（或已过期），API Key 未配置 | 任一入口保存 API Key 成功 | API Key 成为当前使用，卡片不再是「未配置 / 已过期」 | 偏离（按代码推断，未实跑）：runtime_settings 行在首配后一直保留，生效方式仍指向帐号登录（runtime-credential.service.ts:151-159），credentialStatus 仍按帐号登录算（runtime-application.service.ts:79-82） |
| AC-CRD-011.4 | 集成 | Codex 帐号登录生效且可用 | 从 [添加 API Key] 保存成功 | 只保存：API Key 行出现尾号，「当前使用」仍在帐号登录 | 已实现：runtime-credential.service.ts:146-159（稿件 f-auth-panel-09 头注释） |

### REQ-CRD-012 · 单选按 Agent 分组，确认前不动 {#REQ-CRD-012}

> 状态 `偏离` · 版本 MVP · 来源 DR-20；P21-3 L19-25（每个 Agent 一组二选一）；实现 AuthMethodRadioRow.view.tsx:86-91、:102-107（`name=auth-mode-<mode>`，不含 Agent） · 稿件 f-crd-mode-01（`name="codex-auth"`）

每张 Agent 卡的两行单选是一组（radiogroup，按 Agent 命名），与别的卡互不影响。单选只反映「当前使用」：点了之后在确认（REQ-CRD-010）或配好（REQ-CRD-011）之前**不得**移动；取消即保持原样。

**改写了哪条旧文**：无（旧文对单选怎么分组没写；DR-20 按推荐修）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-CRD-012.1 | 组件 | Codex 与 Claude Code 都是帐号登录生效 | 渲染凭证页 | 两张卡的帐号登录单选都显示选中 | 偏离：两张卡同属 `auth-mode-account` 一组，浏览器只留一个选中点（DR-20） |
| AC-CRD-012.2 | 组件 | 点 API Key 单选弹出确认框 | 点 [取消] | 单选仍在帐号登录 | 已实现：受控 `checked={row.active}`（AuthMethodRadioRow.view.tsx:105） |

## CRD · Git 凭证（F-CRD-GIT）

### REQ-CRD-020 · Git 分区：已配置卡、未配置卡、缺哪种补哪种，永不回显 {#REQ-CRD-020}

> 状态 `部分实现` · 版本 MVP · 来源 P21-3 L138-153、L162、L196；Q-DS-15 ②A（未配置 = 停用色调，不是失败色）；DR-29（未配置徽标不拉满整行）；Q-DS-21 A（content.md 第 1 条：「Runtime 凭证」→ Agent）；实现 GitCredentialCard.view.tsx:61-131、GitCredentialsSection.view.tsx:63-75、125-150、gitCredential.ts:15-16；api credential.controller.ts:52-61、credential.mapper.ts:12-24 · 稿件 f-crd-git-01（已配置）、f-crd-git-02（未配置）

分区头：标题「Git 凭证（私有仓库访问）」、选型引导「GitHub / GitLab SaaS → HTTPS Token；公司自建 Git（SSH 接入）→ SSH 密钥。」、一句「Git 凭证用于克隆私有仓库，与 Agent 凭证无关。」。

- **已配置**（每种协议最多一份）：一张卡，键值两列——HTTPS Token：类型 / Token 尾号（等宽）/ host 白名单（明文）/ 最后使用；SSH 私钥：类型 / 指纹（SHA256:…，等宽）/ 最后使用，另加「已记录主机指纹」块（REQ-CRD-022）。没用过时不显示「最后使用」。动作 [更换] [测试连接] [删除]（[删除] 是进入二次确认的入口）。只配了一种时，页脚条「添加其他类型凭证：」+ 缺的那一种的入口。
- **未配置**（查到了、确实为空）：一张卡「未配置」停用徽标 + [配置 SSH 密钥] [配置 HTTPS Token]。读取失败不是未配置（REQ-CRD-031）。
- 任何地方**不得**回显 Token 或私钥明文。

**改写了哪条旧文**：P21-3 L150「[更换凭证] [测试连接] [吊销]」→「[更换] [测试连接] [删除]」（Q-DS-21 A）；L153「与 Agent 的 Runtime 凭证无关」→「与 Agent 凭证无关」；L147-149 三行布局 → 按类型分别四行 / 三行，「最后使用」没有就不显示。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-CRD-020.1 | 组件 | 有一份 HTTPS Token（ghp_…ab12，白名单 github.com，2 小时前用过），没有 SSH | 渲染 Git 分区 | 卡片四行键值 + [更换] [测试连接] [删除]；页脚条「添加其他类型凭证：[配置 SSH 密钥]」 | 已实现：GitCredentialCard.view.tsx:81-131，GitCredentialsSection.view.tsx:136-150 |
| AC-CRD-020.2 | 组件 | Git 列表查到了、为空 | 渲染 | 「未配置」停用徽标 + 两个入口；没有页脚条 | 已实现：GitCredentialCard.view.tsx:61-78（StatusPill skipped） |
| AC-CRD-020.3 | 组件 | 刚保存的 Token 还没用过 | 渲染 | 不显示「最后使用」行 | 已实现：GitCredentialCard.view.tsx:99-104 |
| AC-CRD-020.4 | API | 任一 Git 凭证 | `GET /api/credentials?kind=git` | 只返回 id、类型、尾号 / 指纹、来源、白名单、knownHosts、lastUsedAt、createdAt，不含密文 | 已实现：credential.mapper.ts:12-24 |
| AC-CRD-020.5 | 组件 | 渲染分区头 | 读说明句 | 「Git 凭证用于克隆私有仓库，与 Agent 凭证无关。」 | 偏离：「…与 Agent 的 Runtime 凭证无关。」（GitCredentialsSection.view.tsx:72） |

### REQ-CRD-021 · 配置 HTTPS Token：来源推导 host、白名单、scope 提示、可选的测试、保存只留尾号 {#REQ-CRD-021}

> 状态 `部分实现` · 版本 MVP · 来源 P21-3 L161、L180-184、L197；附录 A G4-OI-9（来源按代码画 5 项）；UX-DS-305；实现 HttpsTokenForm.view.tsx:58-120、AllowedHostsEditor.view.tsx:44、61、76、gitPlatforms.ts:24-47、gitCredential.ts:10-19、41-49、useGitCredentialManager.ts:180-197、285-304、392；api credential-application.service.ts:76-135 · 稿件 f-crd-git-03

入口：未配置卡 / 页脚条的 [配置 HTTPS Token]、HTTPS 卡的 [更换]（REQ-CRD-025）。表单在 Git 分区底部就地展开：

- **来源（自动推导 host）**：GitHub / GitLab / Gitee / Gitea / 其他（自建），单选；选 SaaS 时 host 白名单自动换成它的 host（github.com / gitlab.com / gitee.com / gitea.com），选「其他（自建）」清空白名单待手填。
- **host 白名单（明文，可加多个；一条 Token 只对白名单内的主机生效）**：可移除的 chip（「移除 <host>」）+ 输入框 + [添加 host]；至少一个。
- **Personal Access Token（保存后仅展示尾号）**：密码遮罩；下方 scope 提示「需 repo（仓库读取）权限的 Token。」。
- **动作**：[取消]（收起并清空）、[测试连接]（可选，REQ-CRD-023）、[保存]。Token 为空或白名单为空时 [测试连接] [保存] 禁用；保存中「保存中…」。测试失败**不拦**保存（测试可能因目标仓库不可达而误报，REQ-CRD-023）。
- **保存成功**：表单收起、Token 从内存清掉，轻提示「HTTPS Token 已保存」，卡片显示尾号 + 白名单。**保存失败**：表单留着，轻提示「保存失败，请稍后重试。」，**不得**直接显示后端 message。

**改写了哪条旧文**：P21-3 L161 来源「GitHub / GitLab / Gitee + 其他」→ 按实现 5 项（加 Gitea，G4-OI-9）；P21-3 L160-161「弹层」→ 分区底部就地展开（实现）；P21-3 L180-184 流程图「❌ → 显示原因 · 重填」隐含的「测试通过才能保存」→ 测试可选、失败不拦保存（实现与 v1 g4-11）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-CRD-021.1 | 组件 | 打开表单（默认 GitHub、白名单 github.com） | 改选 GitLab；再改选「其他（自建）」 | 白名单先变 gitlab.com，再清空 | 已实现：useGitCredentialManager.ts:191-197，gitCredential.ts:10-12 |
| AC-CRD-021.2 | 组件 | Token 为空，或白名单为空 | 看按钮 | [测试连接] [保存] 禁用 | 已实现：useGitCredentialManager.ts:392，HttpsTokenForm.view.tsx:104-117 |
| AC-CRD-021.3 | API | 白名单为空 | `POST /api/credentials/git` {type: https-token} | 400，不入库 | 已实现：credential-application.service.ts:77-83 |
| AC-CRD-021.4 | e2e | 填好 Token 与白名单 | 点 [保存] | 表单收起，轻提示「HTTPS Token 已保存」，卡片显示尾号 + 白名单 | 已实现：useGitCredentialManager.ts:285-304 |
| AC-CRD-021.5 | 组件 | 测试连接认证失败 | 看表单 | Token 字段下原位圆叉一句（role=alert）；[保存] 仍可点 | 已实现：HttpsTokenForm.view.tsx:103-117（稿件 f-crd-git-03） |
| AC-CRD-021.6 | 组件 | 保存接口 500 | 点 [保存] | 表单留着，轻提示「保存失败，请稍后重试。」 | 偏离：优先显示后端 message（useGitCredentialManager.ts:299-301） |

### REQ-CRD-022 · 配置 SSH 密钥：保存前本地预检、只显指纹、主机指纹首连信任可核对 {#REQ-CRD-022}

> 状态 `部分实现` · 版本 MVP · 来源 P21-3 L160、L164、L196；P22 L58；DR-14（主机指纹落库，不回复默认：稿件标「待后端」）；实现 SshKeyForm.view.tsx:43-89、gitCredential.ts:26-39、useGitCredentialManager.ts:269-283、339-363、381-382、KnownHostsRow.view.tsx、GitCredentialCard.view.tsx:107-109；api credential-application.service.ts:85-97、108 · 稿件 f-crd-git-04

入口：未配置卡 / 页脚条的 [配置 SSH 密钥]、SSH 卡的 [更换]。表单：「粘贴私钥（保存后仅展示 SHA256 指纹，永不回显）」多行框（等宽、6 行、关拼写检查与自动填充，占位「-----BEGIN OPENSSH PRIVATE KEY-----」）。保存前本地预检，有问题时原位一句警告（role=alert），并禁用 [测试连接] [保存]：

- 不像私钥（最常见：粘成了 .pub 公钥）：「这看起来不是私钥（应以 -----BEGIN … PRIVATE KEY----- 开头）。最常见的原因是粘成了 .pub 公钥文件 —— 要的是没有 .pub 后缀的那一个（如 id_ed25519）。」
- 带 passphrase：「检测到带 passphrase 的私钥，当前不支持，请改用无口令的密钥。」

OpenSSH 新格式的私钥是否带口令前端看不出，由后端兜底拒绝。保存成功：轻提示「SSH 密钥已保存」，卡片显示「类型：SSH 私钥 / 指纹：SHA256:…」。

**主机指纹**：首次连接自动信任并记录（无头环境里没法交互确认，内网风险由网络隔离承担）；SSH 卡上「已记录主机指纹（首次连接自动信任，可核对）：」逐行列出「<host>（<密钥类型>）<SHA256 指纹>」。现状后端从不写 `metadata.knownHosts`，这一块永远不出现（DR-14 推荐：首次连接成功后写回）。

**改写了哪条旧文**：P21-3 L160「弹层粘贴私钥」→ 分区底部就地展开（实现）；P21-3 L160「带 passphrase 的私钥 MVP 不支持（保存前校验并提示）」保留，并补「误粘公钥」一句（实现先行）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-CRD-022.1 | 组件 | SSH 表单 | 粘入以 ssh-ed25519 开头的公钥 | 原位警告「这看起来不是私钥…」（role=alert），[测试连接] [保存] 禁用 | 已实现：useGitCredentialManager.ts:339-363、381-382，SshKeyForm.view.tsx:63-83（稿件 f-crd-git-04） |
| AC-CRD-022.2 | 单元 | 私钥含 `Proc-Type: 4,ENCRYPTED` 或 `BEGIN ENCRYPTED PRIVATE KEY` | 预检 | 判为带 passphrase，给那一句并禁用 | 已实现：gitCredential.ts:26-34 |
| AC-CRD-022.3 | API | OpenSSH 新格式、带口令的私钥 | `POST /api/credentials/git` {type: ssh-key} | 拒绝保存，不入库 | 已实现：credential-application.service.ts:85-92；前端轻提示显示后端 message（文案未核实） |
| AC-CRD-022.4 | e2e | 一把无口令私钥 | 保存 | 轻提示「SSH 密钥已保存」；卡片「指纹：SHA256:…」，不出现私钥任何片段 | 已实现：useGitCredentialManager.ts:269-283，credential-application.service.ts:93-97 |
| AC-CRD-022.5 | 集成 | 用这把私钥第一次成功克隆 git.acme.example.com 上的仓库 | 回到凭证页 | SSH 卡出现「已记录主机指纹」块，列出 git.acme.example.com（ssh-ed25519）SHA256:… | 未实现：后端只写 metadata.provider（credential-application.service.ts:108），不写 knownHosts，块永不渲染（GitCredentialCard.view.tsx:107-109）；DR-14 |

### REQ-CRD-023 · 测试连接：最多 15 秒、原位三态、按错误码说人话、目标仓库 {#REQ-CRD-023}

> 状态 `部分实现` · 版本 MVP · 来源 P21-3 L163、L180-184、L198；P22 L170；UX-DS-508（异步结果在原位播报，不用轻提示）；实现 TestConnectionResult.view.tsx:12-33、gitCredential.ts:64-79、useGitCredentialManager.ts:36、199-267；api credential.controller.ts:73-74、credential-application.service.ts:163-232、335-363、git-ls-remote.tester.ts:12-60 · 关联 PARAM.GIT_TEST_TIMEOUT_S · 稿件 f-crd-git-01（成功）、f-crd-git-03（失败）

[测试连接] 用 `git ls-remote` 检查这份凭证能不能访问目标仓库，最多 `PARAM.GIT_TEST_TIMEOUT_S` 秒（后端硬上限，前端同值兜底）。两个位置：卡片上测已保存的那份；表单里测正在填、还没保存的那份（不入库）。按所在位置选凭证（SSH 卡 / 表单测 SSH，HTTPS 卡 / 表单测 HTTPS）。

- **进行中**：原位一句「正在测试连接…（最多 15 秒）」（转圈 + 次要灰，role=status），本按钮禁用。
- **成功**：原位「连接成功」（圆勾 + 正文色，role=status）。
- **失败**：原位圆叉 + 按错误码的人话（role=alert）——认证类「认证失败：凭证无效、没有该仓库访问权限，或目标 host 不在白名单内，请检查凭证与 host 白名单。」；网络类「网络错误，请检查网络后重试。」；超时「测试连接超时（等了 15 秒没有结果）。这只说明没等到回应，不代表凭证有问题。」；其它「连接失败，请检查凭证与仓库地址后重试。」
- 结果写在原位，**不得**用轻提示报告；**不得**展示任何分支 / ref 名；Token **不得**发给白名单外的 host（白名单外直接回认证类失败）。
- **目标仓库**：从克隆失败跳来时（REQ-CRD-034）= 那个项目的仓库地址；其它时候现状探测白名单第一个 host 的根地址（如 `https://github.com/`）——对 GitHub 这类 SaaS，根地址不是仓库，代码推断会被判成认证失败，见「待核实」②。

**改写了哪条旧文**：P21-3 L163「`git ls-remote` 目标 / 测试仓库（超时 15s）→ ✅ / ❌ + 原因」→ 写清两种目标与四句人话；P21-3 L198 的例句（`git ls-remote git@github.com:user/repo.git`）只是示意，不是固定测试仓库。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-CRD-023.1 | 组件 | 已保存的 HTTPS Token | 点卡上 [测试连接] | 原位「正在测试连接…（最多 15 秒）」（role=status），[测试连接] 禁用 | 已实现：TestConnectionResult.view.tsx:13-18，GitCredentialCard.view.tsx:117-125 |
| AC-CRD-023.2 | 组件 | 测试返回 ok | 渲染 | 原位「连接成功」（role=status），[测试连接] 恢复可点 | 已实现：TestConnectionResult.view.tsx:21-31（稿件 f-crd-git-01） |
| AC-CRD-023.3 | 单元 | errorCode 依次为 CLONE_FAILED_PERMISSION / CLONE_FAILED_NETWORK / TIMEOUT / 其它 | 取人话 | 依次为上面四句 | 已实现：gitCredential.ts:64-79 |
| AC-CRD-023.4 | 集成 | 目标 15 秒无响应 | 测试 | 15 秒时给超时句；前端 15 秒兜底给同一句 | 已实现：git-ls-remote.tester.ts:12、24-28、39-40，useGitCredentialManager.ts:36、204-225 |
| AC-CRD-023.5 | API | 任一测试 | `POST /api/credentials/git/test` | 响应只有 ok、errorCode、message（已脱敏），没有 ref 列表 | 已实现：git-ls-remote.tester.ts:14-19、36-46、62-72 |
| AC-CRD-023.6 | API | Token 白名单只有 github.com，目标仓库在 gitlab.com | 测试 | 不携带 Token，回认证类失败 | 已实现：credential-application.service.ts:192-199 |
| AC-CRD-023.7 | e2e | 有效、有 repo 权限的 GitHub Token；不是从克隆失败跳来 | 点卡上 [测试连接] | 「连接成功」 | 未核实：代码推断会报认证失败（credential-application.service.ts:350-362 探测 `https://github.com/`；git-ls-remote.tester.ts:50-59 把 not found 归为 PERMISSION），见「待核实」② |

### REQ-CRD-024 · 使用范围与选择规则：只在平台侧克隆 / 拉取时用、按地址协议选、Token 只发给白名单 host {#REQ-CRD-024}

> 状态 `已实现` · 版本 MVP · 来源 P21-3 L140、L197-199；P22 L57；实现 api project/src/application/git-auth.ts:5-36、project/src/domain/value-objects/repo-url.vo.ts:51、clone-project.workflow.ts:175、sync-baseline.workflow.ts:65、credential-facade.adapter.ts:98-132、credential-revoked.handler.ts:48-49 · 稿件 —（规则；体现在 f-crd-git-05 的「删掉之后」「不受影响」）

Git 凭证全局一份（每种协议最多一份），所有项目共用；只在平台这一侧**克隆新项目**与**拉取最新代码**时使用，**不**注入任务（任务里的 Agent 拿不到它）。选择规则：仓库地址是 `git@` / `ssh://` → 用 SSH 私钥；`https://` → 用 HTTPS Token；HTTPS Token 只发给白名单内的 host。没有对应凭证、或 host 不在白名单时按匿名访问：公开仓照常，私有仓失败为权限类（克隆失败 · 需要凭证，回程见 REQ-CRD-034）。

**改写了哪条旧文**：无（P21-3 L197-199 照旧）；补一句「白名单外 / 没配 = 匿名访问，私有仓失败为权限类」（实现 git-auth.ts:13-17）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-CRD-024.1 | 集成 | 仓库 `git@git.acme.example.com:acme/infra.git`；SSH 私钥与 HTTPS Token 都配了 | 克隆 | 用 SSH 私钥 | 已实现：repo-url.vo.ts:51，git-auth.ts:30 |
| AC-CRD-024.2 | 集成 | HTTPS Token 白名单只有 github.com；克隆私有仓 `https://gitlab.com/acme/x.git` | 克隆 | 不携带 Token，匿名访问失败，归为权限类 | 已实现：credential-facade.adapter.ts:116-122，git-auth.ts:31-34 |
| AC-CRD-024.3 | 集成 | 有 3 个运行中的任务 | 删除 Git 凭证 | 没有任务被销毁或重启 | 已实现：Git 凭证没有注入绑定（credential-revoked.handler.ts:48-49） |

### REQ-CRD-025 · [更换]：同类型空表单，保存即替换旧的那份 {#REQ-CRD-025}

> 状态 `实现先行` · 版本 MVP · 来源 P21-3 L150（只有按钮名「[更换凭证]」）、L196（永不回显）；U-44；实现 useGitCredentialManager.ts:164-197、317-320；api credential-application.service.ts:112-126（I-CRD-5） · 稿件 f-crd-git-04（从 SSH 卡 [更换] 进来；HTTPS 的表单同 f-crd-git-03）

[更换] 打开同类型的表单：HTTPS Token 预填这份的来源与 host 白名单、Token 必须重新粘贴（不回显）；SSH 私钥从空表单起。只有保存成功才替换：旧的那份即刻擦除密文（保留审计元数据），新的入库，同一协议始终只有一份；[取消] 或测试失败都不动旧的。HTTPS 与 SSH 是两份，不能跨类型「更换」。

**改写了哪条旧文**：P21-3 L150「[更换凭证]」只有按钮名 → 写明语义（按实现）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-CRD-025.1 | 组件 | HTTPS 卡（来源 GitHub，白名单 github.com、git.acme.example.com） | 点 [更换] | 展开「配置 HTTPS Token」，来源与两个 host 预填，Token 为空 | 已实现：useGitCredentialManager.ts:180-187、317-320 |
| AC-CRD-025.2 | 组件 | SSH 卡 | 点 [更换] | 展开「配置 SSH 密钥」，私钥框为空 | 已实现：useGitCredentialManager.ts:172-177、317-319（稿件 f-crd-git-04） |
| AC-CRD-025.3 | API | 已有一份 HTTPS Token | 再保存一份 HTTPS Token | 旧的 revokedAt 有值、密文擦除；列表只剩新的 | 已实现：credential-application.service.ts:112-126 |
| AC-CRD-025.4 | 组件 | [更换] 打开的表单 | 点 [取消] | 表单收起、清空，旧凭证不变 | 已实现：useGitCredentialManager.ts:164-170 |

### REQ-CRD-026 · 删除 Git 凭证：统一破坏性确认，说清后果、如实列出相关项目 {#REQ-CRD-026}

> 状态 `未实现` · 版本 MVP · 来源 Q-DS-17 A（UX-DS-307）；DR-07（不回复默认：Git 凭证沿用前端推算 + 来源行）；Q-DS-21 A、DR-35 ①；P21-3 L150、L196、L199；U-46；实现 GitCredentialCard.view.tsx:126、useGitCredentialManager.ts:306-315；api credential.controller.ts:103-104、credential-application.service.ts:142-155 · 稿件 f-crd-git-05（确认框）、f-crd-git-02（删完：未配置 + 轻提示）

点 [删除] → 统一破坏性确认框（与 REQ-CRD-002 同一结构）。HTTPS Token：标题「删除 Git 凭证「HTTPS Token · <白名单 host>」？」，副标题「Git 凭证 · 最后使用 <相对时间>」（没用过只写「Git 凭证」）。分段：

- **会删掉**：「这份 HTTPS Token（<尾号>）」+「平台不再保存它，也不会再拿它访问 <host>。」
- **平台删不掉**：「<托管方> 上的这个 Token 本身」+「去 <托管方> 的设置里把它作废，否则它在 <托管方> 那边一直有效。」
- **删掉之后**：「克隆或拉取 <host> 上的私有仓会失败，直到重新配置凭证」；「仓库在 <host> 的 N 个项目：<名单>」+「仓库是私有的话，项目里的「拉取最新代码」会失败；新建任务仍用这台机器上已有的代码副本。」
- **不受影响**：「已经建好的任务：代码副本已在这台机器上，Git 凭证也不会注入任务」。
- **项目清单来源**：「项目列表里仓库 host 在这份 Token 白名单（<host>）内的项目。」（前端推算，DR-07）

焦点在 [取消]；危险按钮「删除凭证」。确认 → 204 → 关框，轻提示「凭证已删除」（DR-35 ①），这一种转「未配置」（两种都没了就是未配置卡）。失败 → 轻提示「删除失败，请稍后重试。」，凭证不变。

SSH 私钥用同一个框（不另出稿）：标题「删除 Git 凭证「SSH 私钥」？」；会删掉「这把 SSH 私钥（SHA256:…）」；平台删不掉「Git 服务上登记的对应公钥」——去 Git 服务的 SSH Keys 设置里删；删掉之后「克隆或拉取 SSH 地址（git@ / ssh://）的私有仓会失败」，项目清单 = 仓库地址是 SSH 形式的项目。

**改写了哪条旧文**：P21-3 L150「[吊销]」→「[删除]」，并补确认框（旧文没写确认框内容）；现状轻提示「凭证已吊销」「吊销失败，请稍后重试。」→「凭证已删除」「删除失败，请稍后重试。」（DR-35 ①）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-CRD-026.1 | 组件 | HTTPS Token ghp_…ab12（白名单 github.com，2 小时前用过） | 点 [删除] | 确认框：标题「删除 Git 凭证「HTTPS Token · github.com」？」、副标题「Git 凭证 · 最后使用 2 小时前」；会删掉 → 平台删不掉 → 删掉之后 → 不受影响 → 来源；焦点在 [取消]；危险按钮「删除凭证」 | 未实现：[删除] 一点即删（GitCredentialCard.view.tsx:126 → useGitCredentialManager.ts:306-315） |
| AC-CRD-026.2 | 单元 | 项目列表里 5 个项目的仓库都在 github.com | 推算受影响项目 | 「仓库在 github.com 的 5 个项目：示例项目、acme-web、acme-api、docs-site、infra-scripts」 | 未实现（同上） |
| AC-CRD-026.3 | e2e | 确认框打开 | 点 [删除凭证] | 204；关框；轻提示「凭证已删除」；Git 分区转「未配置」卡（两个入口） | 偏离：没有确认框；轻提示「凭证已吊销」（useGitCredentialManager.ts:309）；未配置卡已实现（GitCredentialCard.view.tsx:61-78，稿件 f-crd-git-02） |
| AC-CRD-026.4 | 组件 | DELETE 失败 | 确认 | 轻提示「删除失败，请稍后重试。」；凭证不变 | 偏离：「吊销失败，请稍后重试。」，且优先显示后端 message（:312） |
| AC-CRD-026.5 | e2e | Git 凭证已删，acme-web 是私有仓 | 在项目信息浮层点 [拉取最新代码] | 浮层里原位失败句 + [配置 Git 凭证]（F-PRJ-INFO）；凭证页本身无变化 | 未核实（联动归 F-PRJ-INFO / F-PRJ-CLONE） |
| AC-CRD-026.6 | API | 任一 Git 凭证 | `DELETE /api/credentials/git/{id}` 两次 | 都 204；密文擦除、保留审计元数据 | 已实现：credential-application.service.ts:142-155 |

## CRD · 凭证页的状态（F-CRD-PAGE）

### REQ-CRD-030 · 首次加载：两个分区各自骨架，与真卡同结构同高 {#REQ-CRD-030}

> 状态 `部分实现` · 版本 MVP · 来源 P21-3 L53；T-7 / UX-DS-304（spec/patterns.md:43：首次加载用骨架、高度接近真实，刷新保留旧数据）；plan F-WB-SHELL（直接打开设置页出本页骨架）；实现 RuntimeCredentialsSection.view.tsx:83-84、GitCredentialsSection.view.tsx:101-102、useCredentials.ts:349、useGitCredentialManager.ts:356 · 稿件 f-crd-page-01

第一次进凭证页（包括刷新、直接打开 `/settings/credentials`）、两份列表还没回来时：分区标题、说明、搜索框照常显示（搜索框可以输入）；Agent 分区两张骨架卡、Git 分区一张骨架卡，结构与真卡一致（卡头名称条 + 徽标位；每行单选圆 + 方式名条 + 行尾按钮位；Git 卡左侧键值条 + 右上三个按钮位 + 页脚条），高度与真卡相同，数据一到不跳高。骨架 `aria-hidden`、列表容器 `aria-busy`，每个分区一句读屏「正在读取 Agent 列表…」「正在读取 Git 凭证…」（role=status）。两份各自结束各自替换，不互等；已有数据时的后台重取不回骨架。

**改写了哪条旧文**：P21-3 L53「加载中 → 骨架屏」→ 补「与真卡同结构同高、两个分区各自结束、读屏一句」。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-CRD-030.1 | 组件 | 两份列表都在加载 | 渲染 | Agent 区 2 张、Git 区 1 张骨架卡，高度与真卡一致；数据到了不跳高 | 部分实现：两个分区各一块 h-24 脉冲灰块（RuntimeCredentialsSection.view.tsx:84，GitCredentialsSection.view.tsx:102），数据一到 Agent 分区跳高 |
| AC-CRD-030.2 | 组件 | 同上 | 用读屏 | 听到「正在读取 Agent 列表…」「正在读取 Git 凭证…」；骨架不被读出 | 未实现：骨架块没有可读文字，也没有 aria-busy |
| AC-CRD-030.3 | 集成 | Agent 列表先回来，Git 还在加载 | 渲染 | Agent 区出卡片，Git 区仍是骨架 | 已实现：两份查询各自的 isPending（useCredentials.ts:349，useGitCredentialManager.ts:356） |
| AC-CRD-030.4 | 集成 | 已有数据 | 后台重取中 | 不回骨架，保留旧数据 | 已实现：loading 只取 isPending（同上） |

### REQ-CRD-031 · 读取失败：两份各自明说 + [重试]，不退化成「未配置」或「没有匹配」 {#REQ-CRD-031}

> 状态 `已实现` · 版本 MVP · 来源 UX-DS-305（spec/patterns.md:44：读取失败原位明说、不得显示成空）；P21-3 L49-61（状态矩阵没有这一态）；实现 RuntimeCredentialsSection.view.tsx:85-97、GitCredentialCard.view.tsx:46-58、GitCredentialsSection.view.tsx:125-134、useCredentials.ts:345、useGitCredentialManager.ts:357-360 · 稿件 f-crd-page-02

Agent 列表读不出来：卡片的位置换成一条警示（role=alert）「Agent 列表没能加载出来，现在看不到这台机器上都配了些什么。」+ [重试]；**不得**显示「没有匹配的 Agent。」或「这台机器上还没有可用的 Agent。」。Git 凭证读不出来：「Git 凭证没能加载出来 —— 这不代表它被删了，只是现在读不到。」+ [重试]；**不得**显示「未配置」卡与「添加其他类型凭证」条（用户会以为密钥被清了而重配一份）。两份互不影响，[重试] 只重取自己那一份，成功后原位换成卡片。

**改写了哪条旧文**：P21-3 §5 状态矩阵（L49-61）没有「读取失败」→ 补这一态，并与「未配置」「列表空」分开。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-CRD-031.1 | 组件 | `GET /api/runtimes` 失败 | 渲染 | Agent 区警示句 + [重试]（role=alert）；没有「没有匹配」「还没有可用的 Agent」 | 已实现：RuntimeCredentialsSection.view.tsx:85-97 |
| AC-CRD-031.2 | 组件 | `GET /api/credentials?kind=git` 失败 | 渲染 | Git 区警示句 + [重试]；没有「未配置」卡、没有页脚条 | 已实现：GitCredentialCard.view.tsx:46-58，GitCredentialsSection.view.tsx:125-127 |
| AC-CRD-031.3 | 集成 | Git 失败、Agent 正常 | 渲染 | Agent 区照常出卡片，只有 Git 区报错 | 已实现：两份查询独立 |
| AC-CRD-031.4 | 集成 | 任一失败态 | 点 [重试]，这次成功 | 原位换成卡片 | 已实现：useCredentials.ts:345，useGitCredentialManager.ts:358-360（refetch） |

### REQ-CRD-032 · 搜索 Agent：过滤名字与打码标识的可见部分；无匹配与本来为空分开说 {#REQ-CRD-032}

> 状态 `部分实现` · 版本 MVP · 来源 P21-3 L54、L119；P21 L118（列表必有空态）；实现 useCredentials.ts:160-170、maskAccount.ts:28-47、RuntimeCredentialsSection.view.tsx:71-80、98-101 · 稿件 f-crd-page-03

搜索框「搜索 Agent 名字或帐号尾号…」只过滤 Agent 分区，实时、不发请求。命中规则：Agent 名，或任一方式打码标识的**可见部分**（帐号 a***@example.com 的「a」「@example.com」，API Key sk-…f3a9 的「sk-」「f3a9」），不分大小写；**不得**匹配被遮住的中间段（掩码不能被反推）。一个都没命中：卡片位置一句「没有匹配的 Agent。」（role=status）；没搜索、本来就没有注册任何 Agent：「这台机器上还没有可用的 Agent。」；读取失败见 REQ-CRD-031——三者**不得**混用。Git 分区不受搜索影响。

**改写了哪条旧文**：P21-3 L54「无凭证 → 空态 + [立即授权] CTA」→ 没配凭证的 Agent 照常出卡片（「未配置」+ 两个入口），不是空态；真正的空态只在「一个 Agent 都没有注册」时出现，一句话、没有 CTA（没有可授权的对象）。P21-3 L119 的匹配规则保留（「帐号邮箱可见部分」就是帐号掩码的可见段）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-CRD-032.1 | 单元 | Codex 的 API Key 打码为 sk-…f3a9 | 搜「f3a9」；搜「F3A9」 | 都命中 Codex | 已实现：maskAccount.ts:32-47 |
| AC-CRD-032.2 | 单元 | 帐号 alice@example.com 打码为 a***@example.com | 搜「lice」 | 不命中 | 已实现：maskAccount.ts:42-46 |
| AC-CRD-032.3 | 组件 | 两个 Agent | 搜「gemini」 | 卡片位置「没有匹配的 Agent。」；Git 分区照常 | 已实现：RuntimeCredentialsSection.view.tsx:98-101（稿件 f-crd-page-03） |
| AC-CRD-032.4 | 组件 | 后端没有注册任何 Agent，没搜索 | 渲染 | 「这台机器上还没有可用的 Agent。」 | 已实现：RuntimeCredentialsSection.view.tsx:100 |
| AC-CRD-032.5 | 组件 | AC-CRD-032.3 | 用读屏边输边听 | 听到「没有匹配的 Agent。」 | 未实现：这句是普通段落，没有 role=status（:99-101） |

### REQ-CRD-033 · 有效期：即将过期 / 已过期，建议句与 [重新登录] {#REQ-CRD-033}

> 状态 `部分实现` · 版本 MVP · 来源 P21-3 L55-57、L132；P22 L124-125；P20 L251；DR-20（两张卡的单选互抢，按推荐修）；Q-DS-32 B + UX-DS-311（治理横幅的动作指向当前页时隐藏）；实现 credentialExpiry.ts:11-39、AuthMethodRadioRow.view.tsx:52-74、102-114、RuntimeCredentialCard.view.tsx:26-45、runtimeCredential.ts:32-36；api runtime-credential.service.ts:46-48、285-292 · 关联 PARAM.CRED_EXPIRY_WARN_DAYS · PARAM.CRED_REFRESH_FAIL_LIMIT · 稿件 f-crd-page-04

帐号登录有到期时间（API Key 一般没有，不显示倒计时）：

- **有效**（剩余 ≥ `PARAM.CRED_EXPIRY_WARN_DAYS` 天）：帐号后次要灰「剩 N 天」。
- **即将过期**（不足 7 天）：卡头「即将过期」警告徽标；行内「剩 N 天」带三角与警告色；下一行建议句「建议在它到期前重新登录一次，免得任务跑到一半断掉。」
- **已过期**（到期，或自动续期连续失败 `PARAM.CRED_REFRESH_FAIL_LIMIT` 次）：卡头「已过期」失败徽标；行内「已过期」带叉与失败色；建议句「现在用它发任务会失败，点 [重新登录] 换一份。」；[重新登录] 走 Agent 登录面板（F-AUTH-PANEL）。
- 「剩 N 天」按整天向下取整，不足 1 天写「剩 <1 天」。
- 两个 Agent 的单选**必须**各自成组：两张卡可以同时「当前使用：帐号登录」。
- 全局「Agent 凭证即将过期 / 已过期」治理横幅的动作指向本页，在本页**不**显示（UX-DS-311）。

**改写了哪条旧文**：P21-3 L56「⚠️ 黄色 + "建议在 X 前重新授权"」→ 行内「剩 N 天」+ 建议句（只说该做什么，不再重复时间）；L57、L95、L115「重新授权」→「重新登录」（实现用词）；L132 保留。

**合并说明**：WB 域「<Agent> 的帐号登录 N 天后过期」治理横幅（REQ-WB-015）用同一个参数 `PARAM.CRED_EXPIRY_WARN_DAYS`。（交叉引用：REQ-WB-015）

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-CRD-033.1 | 单元 | 到期时间距今 7 天整 / 6 天 23 小时 / 12 小时 / 已过 | 计算 | 有效「剩 7 天」/ 即将过期「剩 6 天」/ 即将过期「剩 <1 天」/ 已过期 | 已实现：credentialExpiry.ts:14-39 |
| AC-CRD-033.2 | 单元 | 到期还早，但自动续期已连续失败 3 次 | 计算状态 | 已过期 | 已实现：runtime-credential.service.ts:48、286-287 |
| AC-CRD-033.3 | 组件 | Codex 帐号登录剩 5 天 | 渲染 | 卡头「即将过期」；行内三角「剩 5 天」；建议句 | 已实现：AuthMethodRadioRow.view.tsx:54-62，RuntimeCredentialCard.view.tsx:26-45（稿件 f-crd-page-04） |
| AC-CRD-033.4 | 组件 | Claude Code 帐号登录已过期 | 渲染 | 卡头「已过期」；行内「已过期」；建议句；[重新登录] | 已实现：AuthMethodRadioRow.view.tsx:64-70 |
| AC-CRD-033.5 | 组件 | 两个 Agent 当前都用帐号登录 | 渲染 | 两张卡的「帐号登录」单选都选中 | 偏离：单选 name 只按方式（`auth-mode-${row.mode}`，AuthMethodRadioRow.view.tsx:104），两张卡落在同一组，浏览器只保留一个选中（DR-20） |
| AC-CRD-033.6 | e2e | 存在「Agent 凭证即将过期」治理横幅 | 打开凭证页 | 本页不显示这条横幅 | 计划中：横幅本身随 Q-DS-32 B 新增（F-WB-BANNER） |

### REQ-CRD-034 · 从克隆失败跳来的回程：Git 分区回程条、重试克隆 / 放弃 {#REQ-CRD-034}

> 状态 `部分实现` · 版本 MVP · 来源 P21-3 L165、L175-189（L189「待原型落实」）；P22 L57；附录 A G7-OI-8（权限类失败不给 [重试克隆]，重试走凭证页回程）；实现 GitCredentialsSection.view.tsx:76-99、useGitCredentialManager.ts:199-202、322-337、PendingCloneReturnGuard.tsx:14-28、createUiSlice.ts:21-31、NewProjectContainer.tsx:67-77、ProjectRecoveryContainer.tsx:35-36 · 依赖 F-PRJ-CLONE（来处）· 稿件 f-crd-page-05

新建项目或克隆失败的项目因权限（401 / 403）克隆失败时，[配置 Git 凭证] 带着「回程」跳到凭证页：视口直接落到 Git 分区；分区顶部一条回程条「为项目「<项目名>」配置凭证后，可重试克隆。」+ [重试克隆]（实心主按钮）+ [放弃]（文字按钮），回程条是一个有名字的地标（「重试克隆」）。用户在下面配好（或更换）凭证；表单与卡片的 [测试连接] 直接测这个项目的仓库地址。

- [重试克隆]：按钮「重试中…」、两个按钮禁用 → 成功：回程条消失，回到工作台，该项目进入「克隆中」；失败：回程条留着，轻提示「重试克隆失败，请稍后重试。」（不直接显示后端 message）。
- [放弃]：回程条消失，项目保持「克隆失败」。
- 回程只活在这一次：离开凭证页（切菜单、回工作台、Esc）即作废；刷新也会丢（只存在内存里，因为含内部仓库地址）。
- 项目信息浮层「拉取失败 · 需要 Git 凭证」跳来时只定位到 Git 分区，不出回程条（拉取不是克隆）。

**改写了哪条旧文**：P21-3 L165「配置完成 → [重试克隆]」、L185「回创建弹层 [重试克隆]」、L189「跳设置页后自动回创建弹层的状态载体（待原型落实）」与 P22 L57「配置完成回弹层 [重试克隆]」→ 载体是凭证页 Git 分区的回程条，不回创建弹层（G7-OI-8）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-CRD-034.1 | e2e | 新建项目 acme-api 克隆 401 | 点 [配置 Git 凭证] | 进凭证页，视口在 Git 分区，顶部回程条「为项目「acme-api」配置凭证后，可重试克隆。」 | 部分实现：回程条已实现（GitCredentialsSection.view.tsx:76-99）；跳转不带定位（NewProjectContainer.tsx:76 `router.push('/settings/credentials')`），回程条可能在首屏之下 |
| AC-CRD-034.2 | e2e | 回程条在、已配好 Token | 点 [重试克隆] | 按钮「重试中…」、两按钮禁用；成功后回工作台，acme-api「克隆中」 | 已实现：useGitCredentialManager.ts:322-334（成功 `router.push('/')`） |
| AC-CRD-034.3 | 组件 | 重试接口失败 | 点 [重试克隆] | 回程条留着；轻提示「重试克隆失败，请稍后重试。」 | 部分实现：优先显示后端 message（:328-331） |
| AC-CRD-034.4 | 组件 | 回程条在 | 点 [放弃] | 回程条消失；项目仍克隆失败 | 已实现：useGitCredentialManager.ts:335-337 |
| AC-CRD-034.5 | e2e | 回程条在 | 切到「镜像管理」再回来 | 回程条不再出现 | 已实现：PendingCloneReturnGuard.tsx:14-28 |
| AC-CRD-034.6 | 集成 | 从克隆失败的项目主区（不是新建弹层）跳来 | 点卡上 [测试连接] | 以 acme-api 的仓库地址为目标 | 部分实现：新建弹层跳来带地址（NewProjectContainer.tsx:70-75）；项目主区跳来不带（ProjectRecoveryContainer.tsx:35），退回探测 host 根地址（「待核实」②） |

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

### 改写对照（旧文 → 本片）（crd-b）

| 旧文 | 位置 | 改写为 | 依据 |
|---|---|---|---|
| P21-3 全文「吊销」23 处（L8、L23、L25、L47、L60-61、L76-78、L98-101、L117、L133、L136、L150）；P20 L252 | REQ-CRD-001、026 | 「删除」；「吊销」只作内部事件名 | Q-DS-21 A（content.md:77）、DR-35 ① |
| 现状「这些正在跑的任务会被重启」「删除会重启正在用这份凭证跑的任务」 | REQ-CRD-001、003 | 「会销毁」 | DR-35 ②（后端实际销毁） |
| P21-3 L61、P22 L128「吊销后相关 Task 标 ⚠️、继续跑、下次重启生效」 | REQ-CRD-003 | 删除即销毁注入过它的在跑任务，代码副本保留为成果 | 实现 credential-revoked.handler.ts、D3 |
| P21-3 L101、L133「吊销联动清除已注入文件 / 环境变量」 | REQ-CRD-003 | 销毁注入过它的任务（环境变量撤不回） | credential-revoked.handler.ts:38-50 |
| （无旧文）建实例时把镜像支持的所有 Agent 的凭证都注入 | REQ-CRD-003 | 只注入任务所用 Agent 的那一份 | D3（00-决策简报 L87） |
| P21-3 L60、L117、L123「受影响 Task 本地按 runtime 过滤」 | REQ-CRD-002 | 后端按绑定给；读不到明说 + [重试读取]；没有就说没有 | Q-DS-17 A、DR-07 |
| P21-3 L136、P22 L127「额外提示"该模式将不可用"，吊销后询问是否切换」 | REQ-CRD-004 | 删前接半句说清另一种在不在；删后追问「切过去」；不切 = 无生效方式 | 实现 useCredentials.ts:296-304、P21-3 L77 |
| P21-3 L150「[更换凭证] [测试连接] [吊销]」 | REQ-CRD-020、025、026 | [更换] = 同类型空表单、保存即替换；[删除] 走统一确认 | 实现、Q-DS-17 A |
| P21-3 L153「与 Agent 的 Runtime 凭证无关」 | REQ-CRD-020 | 「与 Agent 凭证无关」 | content.md 第 1 条 |
| P21-3 L161 来源三项 + 其他 | REQ-CRD-021 | 五项（加 Gitea） | 实现 gitPlatforms.ts、G4-OI-9 |
| P21-3 L160-161「弹层」 | REQ-CRD-021、022 | Git 分区底部就地展开的表单卡 | 实现 |
| P21-3 L180-184 流程图「❌ → 重填」（隐含测试通过才能保存） | REQ-CRD-021 | 测试可选，失败不拦保存 | 实现、v1 g4-11 |
| P21-3 L163「git ls-remote 目标 / 测试仓库」 | REQ-CRD-023 | 回程仓库或白名单第一个 host；四句人话 | 实现；目标选择待核实 ② |
| 现状 Git 删除轻提示「凭证已吊销」「吊销失败，请稍后重试。」 | REQ-CRD-026 | 「凭证已删除」「删除失败，请稍后重试。」 | DR-35 ① |
| P21-3 L53「加载中 → 骨架屏」 | REQ-CRD-030 | 两个分区各自骨架、与真卡同结构同高、读屏一句 | T-7、UX-DS-304 |
| P21-3 §5 状态矩阵（L49-61）缺「读取失败」 | REQ-CRD-031 | 两份各自明说 + [重试]，不退化成未配置 / 没有匹配 | UX-DS-305 |
| P21-3 L54「无凭证 → 空态 + [立即授权] CTA」 | REQ-CRD-032 | 没配凭证的 Agent 照常出卡片；空态只在一个 Agent 都没注册时出现，没有 CTA | 实现 RuntimeCredentialsSection.view.tsx:98-101 |
| P21-3 L56-57「建议在 X 前重新授权」「[重新授权]」；L95、L115「重新授权」 | REQ-CRD-033 | 「剩 N 天」+ 建议句；「重新登录」 | 实现 AuthMethodRadioRow.view.tsx:52-74 |
| P21-3 L165、L185、L189；P22 L57「回创建弹层 [重试克隆]」「待原型落实」 | REQ-CRD-034 | 凭证页 Git 分区回程条 | G7-OI-8、实现 GitCredentialsSection.view.tsx:76-99 |

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

### 本片的默认决定与待确认（crd-b）

1. **D3 / DR-05 按推荐写**（REQ-CRD-003）：停止跨 Agent 注入、准备中任务加一句。D3 若改为「维持注入」，REQ-CRD-003 第一条改成「如实列出跨 Agent 注入的任务」（v1 g4-05 原稿的写法），AC-CRD-003.1 的 Then 反过来，f-crd-revoke-01 恢复那一条；实现代价是同一任务里不再预置另一种 CLI 的凭证（决策简报 L87）。
2. **DR-07 按不回复默认**（REQ-CRD-002、026）：Agent 凭证清单的目标是后端预检；接口落地前前端至少对齐 LIVE、来源行写「前端按 Agent 推算」；Git 凭证沿用前端按白名单推算 + 来源行。
3. **「不切」之后的样子**（AC-CRD-004.4）：本片按 P21-3 L77 的状态图写「无生效方式」（两行都不显示「当前使用」）。实现要么在删掉生效方式时清空 `active_auth_method`（后端），要么前端在「生效方式没有凭证」时不显示单选与徽标；选哪种属技术设计。
4. **SSH 私钥的删除确认框**（REQ-CRD-026 末段）：v1 只画了 HTTPS；SSH 的四段文字是按同一结构推出来的，没有出稿，看稿时一并确认。
5. **两处删除的轻提示用词不同**：Agent 凭证「已删除」（实现）、Git 凭证「凭证已删除」（DR-35 ①）。都合规；要统一时改一处即可，不影响结构。
6. **设置区的 Esc**（AC-CRD-002.6）：现状设置布局在 window 上监听 Esc 直接回工作台，弹层或就地表单开着时也一样。本片要求「弹层开着时 Esc 只关弹层」；表单展开时 Esc 的行为（收起表单还是回工作台）不在本片，留给 F-WB-SHELL 一并定。
7. **卡片 [测试连接] 测什么**（REQ-CRD-023 目标仓库）：先核实「待核实」②；若确实误报，建议从项目列表里取一个仓库 host 在白名单内的项目地址作目标，没有这样的项目时明说「没有可用来测试的仓库」（前端改动，不要新接口）——待产品确认后再写进 AC。
8. **术语**（2026-10-04 用户拍板 Q-SBX-03 A，原话「补全 10 条按推荐」）：被销毁任务留下的那份统一叫「代码副本」、留下来的叫「保留下来的成果」；本片原写的「工作目录」已全部改掉（REQ-CRD-002 读不到时的说明句、REQ-CRD-003「会留下」一段与标题、AC-CRD-003.2）。

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

### 参数（待登记 params.yaml）（crd-b）

| 参数 | 值 | 类别 | 含义 | 被谁用 | 代码落点 |
|---|---|---|---|---|---|
| `PARAM.REVOKE_LIST_MAX` | **10** 条 | product | 删除确认框最多列出的任务数，多的折成「等共 N 个」 | REQ-CRD-002 | `affectedTasks.ts:13`；P21-3 L133 |
| `PARAM.REVOKE_GRACEFUL_DESTROY_S` | **20** 秒 | impl-first | 删除凭证后销毁绑定任务的优雅停止时限 | REQ-CRD-003 | `credential-revoked.handler.ts:17` |
| `PARAM.REVOKE_FORCE_DESTROY_S` | **15** 秒 | impl-first | 优雅停止超时后的强制销毁时限 | REQ-CRD-003 | `credential-revoked.handler.ts:19` |
| `PARAM.GIT_TEST_TIMEOUT_S` | **15** 秒 | product | Git 测试连接上限（后端硬上限、前端同值兜底） | REQ-CRD-023 | `git-ls-remote.tester.ts:12`、`useGitCredentialManager.ts:36`；文案「（最多 15 秒）」写死在 `TestConnectionResult.view.tsx:16`、`gitCredential.ts:75`（多一处漂移点） |
| `PARAM.CRED_EXPIRY_WARN_DAYS` | **7** 天 | product | 帐号凭证进入「即将过期」的剩余天数 | REQ-CRD-033 | `credentialExpiry.ts:11`、`runtime-credential.service.ts:46`（两处落点） |
| `PARAM.CRED_REFRESH_FAIL_LIMIT` | **3** 次 | impl-first | 自动续期连续失败多少次判为已过期 | REQ-CRD-033 | `runtime-credential.service.ts:48` |
| `PARAM.RETENTION_DAYS_DEFAULT` | **30** 天 | product（已登记） | 被销毁任务的代码副本保留期 | REQ-CRD-003 | 已登记（format-pilot params.md） |

## 附录 D · 边界、覆盖对照、待核实与连带更正

### 测试用例关联更正（04-示例用例.md 里的拟定编号）（crd-a）

| 用例 | 原关联 | 改为 | 说明 |
|---|---|---|---|
| TC-AUTH-001 | REQ-AUTH-010（拟） | REQ-AUTH-010 | 编号沿用，内容即本片 REQ-AUTH-010 |
| TC-AUTH-002 | REQ-AUTH-020（拟） | REQ-AUTH-003 | 020 超出 F-AUTH-PANEL 的编号段（001–019） |
| TC-AUTH-004 | — | REQ-AUTH-008（界面给出结果） | 「登录完成回放」的界面部分 |
| TC-ACC-001 | REQ-DEP-0xx（拟：访问保护） | REQ-ACC-001、REQ-ACC-002、REQ-ACC-006 | 访问保护单独成域 ACC |
| TC-ACC-002 | REQ-DEP-0xx（拟） | 不在本片（来源校验属 NFR-SEC） | 口令不能替代 Host / Origin 校验 |

### 待核实（代码推断，未实测）（crd-b）

1. **准备中任务的竞态**（AC-CRD-003.6）：凭证在任务进入 creating 时就解密备好（`provision-sandbox.workflow.ts:191-201`），到 starting 第 ④ 步才写进沙箱并记账（`:618-637`）；记账只找未删除的凭证（`runtime-credential.service.ts:309-333`，`listByRuntime(…, false)`）。所以「creating 之后、第 ④ 步之前」删除的凭证，代码推断会被注入进沙箱、却不进绑定表，任务带着已删的凭证起来，也不会被这次删除销毁。DR-05 ②A 那句「会以未登录状态起来」只对还没到 creating 的任务成立。建议后端在第 ④ 步注入前复查凭证是否已删除。
2. **卡片 [测试连接] 在 SaaS 上误报**（AC-CRD-023.7）：不带回程仓库时探测 `https://<白名单第一个 host>/`（`credential-application.service.ts:350-362`）；`git ls-remote` 对 GitHub 根地址这类非仓库地址会回 not found，`classify` 把 not found / 404 归为 `CLONE_FAILED_PERMISSION`（`git-ls-remote.tester.ts:50-59`）——有效 Token 也会显示「认证失败…」。需要在能联网的环境实测一次。
3. **强制销毁也失败的任务**（REQ-CRD-005）：处理器在强制销毁失败时保留绑定「留待重试」（`credential-revoked.handler.ts:138-145`），但全仓只有这个处理器在删除那一刻读一次绑定表（`:76`），没有任何重试方；界面也不提示。被留下的任务会带着已删除的凭证继续跑。

**本片顺手核实的结论**（供 crd-a 与原型接线参考）：

- plan「待核实」第 1 条（REQ-AUTH-007）：**重新登录、重新添加 API Key 都不会触发删除那一套**。同一方式再保存时，旧凭证由仓储直接擦除（`runtime-credential.service.ts:143-160` 的 `repo.revokeAndEraseSync`），只发布新凭证的 `CredentialStored`（`credential.entity.ts:167`）；只有 `revoke()` 才发 `CredentialRevoked`（`credential.entity.ts:200-205`），而销毁任务的处理器只订阅这一个事件（`credential-revoked.handler.ts:66-69`）。后果：在跑任务不会被销毁，继续用旧 token 直到厂商那边失效；旧的注入记录仍指向已擦除的旧凭证，之后再删除新凭证也不会销毁这些任务。
- `/events` 契约里定义了 `runtime-auth.status_changed`，但后端没有产出（`ws-protocol.ts:144-147`）；凭证卡只在本页自己的请求成功后重取（`useRuntimeAuthMutations.ts:16-17`），另一个标签页开着的凭证页不会自动刷新。
- DR-20 在实现里仍在（`AuthMethodRadioRow.view.tsx:104`），P3 / v2 稿件已按修好画。
- 删除 Git 凭证同样发 `CredentialRevoked`，处理器查不到绑定、不销毁任何任务（`credential-revoked.handler.ts:48-49`）。

## 附录 E · 合并时改动的地方

合并只做了下面这些改动；其余文字都是片段原文（本地待定编号已换成统一编号）。

| 需求 | 改动 | 为什么 |
|---|---|---|
| [REQ-CRD-033](#REQ-CRD-033) | 加合并说明 | 与 REQ-WB-015 互相引用 |
