---
id: GAPS-GAP
title: 补全原型「未接入」· 实现差距清单
type: impl-gaps
status: draft
owner: 实现 agent（转 issue 前由产品 owner 抽查 §1）
date: 2026-10-04
last_verified:
  api: a453bb7
  web: 93f03c5
sources:
  - gap/product/{PRJ,LCH,SBX,AUTH,CRD,ACC,IMG,SYS,WB,AUT,DEP}.md（AC 表「现状」列）
  - tasks/whk1xm5a2.output · result.lanes[].verified（W1 核实结论）
generated_by: gap/product/_build/gaps.py（§1 手写在 _build/impl-gaps-defects.md）
---

# 补全原型「未接入」· 实现差距清单

<!-- 这份清单以后要转成 issue，现在只写文档。§1、§2 手写；§3–§6 由 _build/gaps.py 从各领域文件的 AC 表生成，改了领域文件后重新运行。 -->

## 一屏摘要

- **范围**：各领域文件里状态为 `偏离` / `部分实现` / `未实现` 的 **195 条需求、484 条验收**（`偏离` 156 · `部分实现` 127 · `未实现` 201，按 AC 计）。
- **按层**：前端 442 · 后端 34 · 契约 8（一条 AC 只归一层，按「现状」里点名的文件判；同时涉及别的层时，在「建议修法」末尾写「另需…配合」）。
- **W1 核实出的实现缺陷 65 条**（§1）：sev1 1 · sev2 12 · sev3 38 · sev4 14。sev1 / sev2 的 13 条建议先排：其中 DR-17、DR-18 已在 00-决策简报列为 sev2、要求 7 天内修。
- **2026-10-04 用户拍板（原话「补全 10 条按推荐」）带来的实现工作**：20 项（按主层计：前端 13 · 后端 5 · 契约 2；跨层的在「层」一列写明另需哪层配合），逐项见 §2 末尾「2026-10-04 拍板带来的实现工作」；每项都已落在某条 AC 上，§3–§5 里同样有它们。
- **转 issue 的建议**：§1 每条一个 issue（带 sev 标签）；§3–§5 按「同一条需求、同一层」合成一个 issue（标 gap，不标 sev：它们多半是按产品说明补齐的功能，不全是缺陷）；§2 的口径统一随对应需求的 issue 一起做。
- **读法**：每行 = 一条 AC。「差在哪」是领域文件「现状」列的原话；「出处」是其中点名的文件:行；「建议修法」写的是这条 AC 的目标行为（Then），也就是改完之后应该观察到的样子；「稿件」是该需求对应的 v2 稿。

| 域 | 差距需求（偏离 / 部分实现 / 未实现） | 差距 AC：前端 | 后端 | 契约 |
|---|---|---:|---:|---:|
| PRJ | 9 / 15 / 2 | 68 | 6 | 1 |
| LCH | 3 / 10 / 3 | 41 | 1 | 3 |
| SBX | 3 / 6 / 9 | 50 | 1 | 1 |
| AUTH | 6 / 2 / 1 | 23 | 2 | 0 |
| CRD | 5 / 11 / 1 | 32 | 5 | 0 |
| ACC | 4 / 1 / 1 | 9 | 6 | 0 |
| IMG | 13 / 14 / 2 | 59 | 7 | 0 |
| SYS | 4 / 6 / 3 | 30 | 0 | 2 |
| DIA | 3 / 2 / 1 | 8 | 1 | 1 |
| AUD | 1 / 2 / 0 | 8 | 2 | 0 |
| WB | 4 / 6 / 9 | 51 | 0 | 0 |
| EVT | 1 / 0 / 1 | 3 | 0 | 0 |
| AUT | 5 / 11 / 1 | 35 | 2 | 0 |
| DEP | 12 / 2 / 0 | 25 | 1 | 0 |

## 1. W1 核实出的实现缺陷

来自 W1 十二个组的「核实结论」（tasks/whk1xm5a2.output · result.lanes[].verified）与各片段的「待核实」，去重后 65 条；标「合并时补查」的是合并这份清单时顺着同一线索读代码补上的落点。严重度按 02-测试计划 §14：**sev1** 数据或凭证丢失 / 安全边界失效 / 资源永久泄漏 · **sev2** 主链路在某个支持配置下不可用或卡住无出口 · **sev3** 功能降级但有替代路径 · **sev4** 文案、样式。除特别注明，结论都是**读代码得出、未实跑**；转 issue 时先按「复现」实跑一次，再定最终严重度。

### sev1（1 条）

#### 1 · 准备中的任务删不掉：DELETE 返回 500，崩溃残留的任务长期占名额

- **复现**：发起一个任务，在「拉取镜像」阶段（creating）或排队阶段（pending / scheduling）调 `DELETE /api/sandboxes/{id}`（web 没有入口，用接口）→ 500 `INTERNAL`；能转 failed 的状态还被改成「异常」留在树上。崩溃残留的 pending 任务同样删不掉，一直占名额。
- **出处**：api `sandbox-application.service.ts:731-741`（destroy 只先处理 running / idle / stopping / starting）、`:768-772`（catch 改成 failed）；`sandbox-status.vo.ts:39-52`（只允许 stopped / failed → destroying）；`provider-error.http.ts:38-59`（转移错误没有 HTTP 映射）。
- **关联**：AC-LCH-014.2；01 §3.2 复核 B2、BE2；原测试计划第14节 sev1 的例子「pending 僵尸长期占配额」。
- **修法**：DELETE 对任意状态可用且幂等（BE2）：准备中的状态先推进到可删再销毁，或状态机允许准备中直接 → destroying；转移错误映射成 409 而不是 500；乐观锁发现已 destroying 就放弃写入（BE3）。

### sev2（12 条）

#### 2 · 删除有自动化规则的项目：500，而且代码目录已经先被删了

- **复现**：建一个项目 → 给它加一条自动化规则 → 项目「⋯」→ 删除项目 → 500；项目还在树上，数据目录里它的代码目录已经没了。
- **出处**：`automation.sqlite.ts:16-18` 与迁移 `api/drizzle/0018_hesitant_bushwacker.sql:51`（`automations.project_id` ON DELETE restrict）；`drizzle.connection.ts:55`（foreign_keys=ON）；`project-application.service.ts:254-281`（只删成果墓碑行与项目行，不删规则；`:264-267` 在事务之前删代码目录）；`error-envelope.filter.ts:32-33、94`（落成 500）。prj-b、aut 两组独立核实；同一机制在保留成果外键上实证过（`retained-volume.repository.ts:20-35`）。
- **关联**：AC-PRJ-041.4、AC-PRJ-043.3；DR-17（00-决策简报列 sev2）。空项目或有未推送改动时会真丢数据，届时升 sev1。
- **修法**：同一事务里先删规则与运行历史再删项目行；代码目录在事务提交之后再删；外键错误不落成 500。

#### 3 · 删项目不处理任务：任务成了「未分组」的孤儿，继续占名额

- **复现**：项目下有一个运行中的任务 → 删除项目（后端不拦）→ 任务出现在树上的「未分组」里，继续占名额；web 又没有销毁入口，只能走接口。
- **出处**：`project-application.service.ts:254-281`（没有任何 sandbox 调用）；`sandbox.sqlite.ts:17`（`sandboxes.project_id` 没有外键）；web `selectProjectTaskTree.ts:4、21、42-52`。
- **关联**：AC-PRJ-041.3、AC-PRJ-044.1、REQ-PRJ-040（有活跃任务时应 409 拦下，码名见 Q-PRJ-04）；DR-04。
- **修法**：有活跃任务时 409 拦下并给去处；已停止 / 异常的任务随项目在同一事务里销毁。

#### 4 · 排队中的克隆被取消后，一直停在「克隆中」直到平台重启

- **复现**：连着新建 3 个 Git 项目（克隆并发上限 2）→ 对第 3 个（还在排队）点 [取消克隆] → 它一直是「克隆中」，[重试克隆]、[改为空项目] 都不可用；重启平台后才变「克隆失败 · 被中断」。
- **出处**：`clone-project.workflow.ts:21`（并发 2）、`:90-101`（排队项被取消只出队）、`:211-221`（失败只在 runClone 的 catch 里落定）、`:277-290`（重启时 reconcileInterrupted）；`project.entity.ts:239-251`（cancelClone 只发事件、不改状态）。
- **关联**：AC-PRJ-013.5。
- **修法**：排队项被取消时直接落定为「克隆失败 · 被中断」（与运行中被取消同一终态）。

#### 5 · 访问口令：没带口令的普通请求也计入失败，首屏就把人锁 5 分钟

- **复现**：开启访问口令 → 清掉浏览器 cookie → 打开工作台（首屏并发拉取多个受保护接口）→ 口令门出现时已经被锁，第一次输入正确口令也回 429。
- **出处**：`passcode.guard.ts:61-69`（对既没有有效会话、也没带对口令的请求一律 `recordFailure`，:68）；`access.controller.ts:31-40`（注释写明首屏并发会「各撞一次」）、`:65-69`（解锁先查锁）。
- **关联**：AC-ACC-005.2。口令默认开启（D3 推荐）后，这是每个新浏览器的必经路径。
- **修法**：守卫只拦、不计数；只有解锁接口提交的错误口令才计入失败。

#### 6 · /events 断线重连后不重同步：任务停在旧状态

- **复现**：发起一个任务 → 在「准备中」时断网约 30 秒（或重启 api）→ 恢复后后端已是「运行中」，前端仍停在准备中，直到手动刷新。
- **出处**：web `useSandboxEventsSocket.ts:141-153`（open 时只更新 connState）、`WorkbenchContainer.tsx:101-115`（丢弃返回值）、`useSandboxRestore.ts:120-123`（内存状态只在没有记录时才用 DTO 种子）。
- **关联**：AC-EVT-002.1、002.2；FE2；原测试计划第14节 sev2 的例子「/events 断线后永远停在启动中」。
- **修法**：重连成功即让任务列表、项目列表与当前任务详情失效重取，并用 DTO 覆盖内存状态（FE2）。

#### 7 · 自动化跑完不收尾：残留任务占满名额，规则继而被判失败、自动停用

- **复现**：建一条每小时跑一次的规则 → 跑满本机名额（默认 8 个）后，后续运行变「没排到资源」，连续失败后规则被放慢、再被自动停用；「保留下来的成果」里也看不到任何自动化产物。
- **出处**：`automation.scheduler.ts:349-373`（finished 只记终态、发通知）；launcher 没有收尾方法；automation-artifact 没有任何写入点，成果来源写死 manual-destroy（`sandbox-application.service.ts:757`）。
- **关联**：AC-AUT-025.1、025.2、025.4；REQ-PRJ-051；DR-18（00-决策简报列 sev2）。
- **修法**：运行到终态后以 keepVolume 销毁任务、登记来源为自动化的保留成果（保留期取规则设置）。

#### 8 · [更新到新版本] 之后运行参数（含 Secret）被清空

- **复现**：给某张镜像配好运行参数（含一个 Secret）→ 上游重推同一 tag → [检查更新] → [更新到新版本] → 卡面运行参数变「（未配置）」，之后新建的任务不再带这些环境变量。
- **出处**：web `useImages.ts:637-671`（更新 = 登记新行再 activate）、`:961`（卡面取卡面行自己的 config）；api `image-application.service.ts:201-219`（新版本行 config 为 null，:215）。
- **关联**：AC-IMG-026.1；Q-IMG-03（2026-10-04 已拍板 C：更新时继承）。
- **修法**：按 Q-IMG-03 C：登记新版本时能指定从哪一行复制运行参数（服务端复制密文）。

#### 9 · 出网代理只对联网检查生效：照着界面指引填了代理，镜像照样下不来

- **复现**：在只能经代理出网的机器上，系统状态里填好代理并保存 → 诊断第 ⑤ 项通过 → 镜像管理或初始化向导里 [准备镜像] 仍然失败（下载请求不走代理）；卡片说明却写「拉取沙箱镜像、访问模型接口都走这里」，向导出路句也让人「回上一步填一个代理再试」。
- **出处**：`connectivity.probe.ts:170`（唯一读取方，调用方只有诊断第 ⑤ 项与初始化）；`oci-registry.client.ts:520`（裸 fetch）；`git-env.ts:90-99`；`api/docker-compose.yml:154-161`（三个变量故意不放进 api 进程）；web `ProxySettingsCard.view.tsx:38-41`、`PresetImageCheck.view.tsx:271-273`。sys-a、img-b 两组独立核实。
- **关联**：AC-SYS-060.9、AC-IMG-042.4（合并后记「计划中」）；Q-SYS-16（§1 第 1 条）。
- **修法**：Q-SYS-16 已拍板 A（2026-10-04）：先改两处文案，只承诺联网检查；B（后端给 registry 客户端与 provider 拉取注入代理）进 backlog。

#### 10 · 重新登录后旧注入记录指向已擦除的凭证，之后删除凭证销毁不到这些任务

- **复现**：Codex 帐号登录 → 发起任务 A → 凭证页 [重新登录] → 再删除 Codex 的帐号登录凭证 → 删除确认里没有任务 A，A 也没被销毁，继续用旧 token 跑。
- **出处**：`runtime-credential.service.ts:143-160`（同方式再保存时 `revokeAndEraseSync` 直接擦除旧凭证，不发 CredentialRevoked）；`credential.entity.ts:167、200-205`；`credential-revoked.handler.ts:66-69`（只订阅 CredentialRevoked）。crd-a、crd-b 两组独立核实「重新登录不销毁在跑任务」，后果一句出自 crd-b。
- **关联**：REQ-AUTH-009、REQ-CRD-002、REQ-CRD-003。涉及凭证撤销边界，实测成立可升 sev1。
- **修法**：重新登录时把在跑任务的注入记录改指新凭证（或删除凭证时按 Agent 而不是按凭证 id 找任务）。

#### 11 · 准备中的任务与删除凭证的竞态：任务带着已删的凭证起来（待实测）

- **复现**：发起任务，在它进入 creating 之后、启动第 ④ 步之前删除这个 Agent 的凭证 → 任务仍然起来并能用这份凭证，而且不进绑定表，不会被这次删除销毁。
- **出处**：`provision-sandbox.workflow.ts:191-201`（creating 时就解密备好）、`:618-637`（第 ④ 步才注入并记账）；`runtime-credential.service.ts:309-333`（记账只找未删除的凭证）。
- **关联**：AC-CRD-003.6；DR-05 ②A 那句「会以未登录状态起来」只对还没到 creating 的任务成立。
- **修法**：第 ④ 步注入前复查凭证是否已删除，已删则按未登录处理。

#### 12 · 强制销毁也失败的任务保留绑定「留待重试」，但没有任何重试方（待实测）

- **复现**：删除一份凭证时，让其中一个任务的强制销毁失败（如 provider 不可达）→ 任务继续带着已删除的凭证跑，界面也不提示。
- **出处**：`credential-revoked.handler.ts:76`（只在删除那一刻读一次绑定表）、`:138-145`（失败保留绑定）。
- **关联**：REQ-CRD-005。
- **修法**：后台重试销毁并在界面提示「有 N 个任务没能停下」。

#### 13 · 出网代理读取失败时表单回退成空、照样能保存，一保存就清空已存配置

- **复现**：让 `GET /api/system/settings` 失败一次（后端短暂不可达）→ 代理表单显示为空 → 点「保存」→ 已存的三项代理被整体替换成空。
- **出处**：web `useProxySettings.ts:35-43`（读取失败回退三个空串）、`initWizardModel.ts:148-160`（全空发 proxyConfig:null）；api `system-settings.service.ts:133-134`（整体替换）、`:130-147`（不写审计）。
- **关联**：AC-SYS-060.6。默认归 sev2：配置被悄悄清空后，必须走代理的网络里联网检查随之失败；能重新填写，实测后可降 sev3。
- **修法**：读到已存配置之前不渲染表单、不许保存；失败时原位一句 + [重试]。

### sev3（38 条）

#### 14 · 未就绪项目的空组「发起第一个任务 →」造成幽灵弹层，离线时也绕过置灰

- **复现**：新建一个大仓库的 Git 项目（克隆中）或一个克隆失败的项目 → 展开它的空组 → 点「发起第一个任务 →」→ 什么都没出现，地址多了 `?new=1&project=<id>` → 克隆完成时弹层自己弹出，还误报「刷新后指令未保留」。离线时同一个按钮也照样打开弹层。
- **出处**：`WorkbenchShell.view.tsx:495-521`（对任何 0 任务的组都渲染，不看 cloneStatus 与 newTaskDisabledReason）；`WorkbenchContainer.tsx:176-181、378-380`（无条件 setCurrentModal）、`:289-320`（未就绪不挂 SandboxTerminalContainer）；`useDeepLinkModal.ts:121-135`；`SandboxTerminalContainer.tsx:125-129、404-405`。prj-a、lch-a、wb 三组独立核实；原型 proto.js:468 只对就绪项目渲染，没有这个问题。
- **关联**：AC-PRJ-011.4、AC-LCH-001.4、AC-WB-014.5。
- **修法**：空组按钮只对就绪项目渲染，并接上离线置灰（`onNewTask` 先判就绪与离线）。

#### 15 · 组头菜单对权限类克隆失败也给 [重试克隆]，不给 [配置 Git 凭证]

- **出处**：`ProjectGroupMenu.view.tsx:120-136`；`WorkbenchContainer.tsx:406-429`（没有把失败码传给菜单）。主区恢复引导按码分流（`projectClone.ts:115-146`），两处不一致。
- **复现**：一个因 401 / 403 克隆失败的项目 → 组头「⋯」→ 只有 [重试克隆]，点了必然再失败。
- **关联**：AC-PRJ-014.7。**修法**：菜单按失败码给与主区同一组出口。

#### 16 · 克隆进度「已用」刷新后从 0:00 重算

- **出处**：`createProjectCloneSlice.ts:48`（锚点是本页收到的第一帧）。**复现**：克隆中刷新页面，已用时长归零。
- **关联**：AC-PRJ-004.8。**修法**：后端在 DTO 或进度帧里给出克隆开始时刻。

#### 17 · 项目详情里的成果数、规则数在读取失败时显示 0

- **出处**：`ProjectMenuContainer.tsx:101-102`（只判断加载中）；`useRetainedVolumes.ts:104`、`useAutomations.ts:273`。**复现**：让 `/api/retained-volumes` 失败 → 项目详情「已保留成果 0 项」。
- **关联**：AC-PRJ-030.3。**修法**：读取失败写「—」。

#### 18 · 删除项目进行中，对话框仍能被 Esc、点遮罩、✕ 关掉

- **出处**：`WorkbenchContainer.tsx:467-473`（没传 busy）；`AppDialog.view.tsx:11-12、50、65-70`（busy 守卫在这里）。**复现**：删项目时在「删除中…」期间按 Esc。
- **关联**：AC-PRJ-043.1。**修法**：传 busy。

#### 19 · 系统状态 [清理保留卷]（改名 [清理成果]）点了没反应

- **出处**：`app/settings/system/page.tsx:30`（没传 onCleanupRetained）；`SystemStatusContainer.tsx:27、49-51`；按钮出现条件在 `resourceModel.ts:153`。prj-b、sys-a 两组核实（DR-27）。**复现**：磁盘或保留下来的成果为警告时点它。
- **关联**：AC-SYS-020.6、AC-PRJ-056.1；Q-DS-33 A。**修法**：接到跨项目的「保留下来的成果」视图（`GET /api/retained-volumes` 不带 projectId，接口现成）；按钮名随 Q-SYS-23 A（2026-10-04 拍板）改为 [清理成果]（AC-SYS-020.9）。

#### 20 · 任务指令长度三处数法不同：含 emoji 的长指令前端放行、后端 400

- **出处**：web `NewSandboxPanel.view.tsx:178-179`（码点）、`SandboxTerminalContainer.tsx:314`（提交前 trim，计数却按原文）；contracts `sandbox.schema.ts:57`（zod 按 UTF-16 单元）；SQLite `length()`（format-pilot params.yaml:248）。**复现**：贴 8000 个 emoji 后发起 → 400。
- **关联**：AC-LCH-005.2、005.3；Q-LCH-01。**修法**：按 Q-LCH-01 的默认统一为码点（契约用自定义 refine，数据库 CHECK 同口径）。

#### 21 · 启动进度的四格先打勾再回退

- **出处**：`SandboxStartupProgress.view.tsx:89`（按展示下标判完成）；`sandboxLifecycle.ts:33-74`（展示序与状态机序不同）。**复现**：观察 preparing-workspace → creating 的几秒。
- **关联**：REQ-LCH-012；Q-LCH-02。**修法**：随 Q-LCH-02（推荐展示序改成状态机序）。

#### 22 · 停止 / 销毁失败不写 failureCode，刷新后只剩兜底「操作没有完成」

- **复现**：经接口让一个运行中的任务在 [停止] 时 provider 出错（如容器服务中途不可达）→ 任务转异常；刷新页面后结果卡只剩兜底「操作没有完成」，没有错误码。
- **出处**：`sandbox-application.service.ts:599-605`（stop）、`:767-772`（destroy）的 catch 只推到 failed；只有启动链路 `provision-sandbox.workflow.ts:716-733` 写码。
- **关联**：AC-SBX-014.3、AC-SBX-022.1。**修法**：catch 里改用 failWith(code)。

#### 23 · 停止中、删除中的任务在前端被显示成「任务已停止」

- **出处**：`sandboxLifecycle.ts:76、84、131-134`（stopping / destroying 归为 ended）。**复现**：经接口停止或销毁一个任务，过程中看主区。
- **关联**：AC-SBX-011.1、AC-SBX-020.1。**修法**：停止中、删除中各自成一态（REQ-SBX-011、020）。

#### 24 · 无头任务运行详情说「只能看输出、不能敲命令」，主区却仍挂终端标签

- **复现**：让一条自动化规则跑起来 → 运行详情点 [打开任务] → 主区上半仍是终端标签，可以连 Agent。
- **出处**：`RunHistoryItem.view.tsx:157-171`；`SandboxLifecycleContainer.tsx:77-96`。
- **关联**：AC-SBX-031.1；DR-01 A。**修法**：无头任务主区只放只读输出。

#### 25 · 在闸门里配好另一种登录方式后，生效方式不跟着变、闸门不消失

- **出处**：`runtime-credential.service.ts:146-159`（只在没有 runtime_settings 行时写生效方式，I-RTS-3）；`runtime-application.service.ts:79-82`（credentialStatus 按生效方式算）。按代码推断。
- **复现**：Codex 只配帐号登录 → 删掉它 → 在新建任务闸门里配 API Key → 闸门仍在。
- **关联**：AC-AUTH-008.4、AC-CRD-011.2、011.3；Q-CRD-01。**修法**：按 Q-CRD-01 的默认扩大「配好即生效」。

#### 26 · Claude Code 授权码被拒一次后会话即被销毁，第二次粘贴必然失败

- **复现**：Claude Code 帐号登录 → 粘一个错的授权码提交、被拒 → 再粘正确的授权码提交 → 404 与英文原句。
- **出处**：`runtime-application.service.ts:243-249`（completeAuth 出错后 dispose 并删登记）、`:218`（英文原句）；web `useRuntimeAuthFlow.ts:88-92`（原样上屏）。按代码推断。
- **关联**：AC-AUTH-006.5；Q-AUTH-02。**修法**：先在真实 helper 上确认，再定「后端保留会话」或「前端自动重新准备链接」。

#### 27 · 设备码页网络异常的 [重试] 实际是换一串码；后端没有取消登录的接口

- **复现**：Codex 帐号登录走到设备码页 → 断网让状态查询失败 → 点 [重试] → 出现一串新的设备码，授权页里已输入的码作废。
- **出处**：web `DeviceCodeAuth.view.tsx:154`、`AuthGateContainer.tsx:235-239`；api `runtime.controller.ts`（只有 begin / status / complete / secret / auth-mode / delete）、`runtime.schema.ts:156`（cancel 字段被丢弃）；`useRuntimeAuthFlow.ts:233-237`（第 1 次失败就提示）。
- **关联**：AC-AUTH-004.5、AC-AUTH-003.4、REQ-AUTH-010；Q-AUTH-01。**修法**：[重试] 立即再查一次、不换码；补取消接口，收起面板即取消。

#### 28 · 切换生效方式的确认框没有 Esc、关闭按钮与初始焦点

- **复现**：凭证页两种方式都配好 → 点另一种方式的单选 → 确认框里按 Esc 没反应、没有关闭按钮、焦点不在框内。
- **出处**：`ConfirmDialog.view.tsx:22-43`。**关联**：AC-CRD-010.1、010.4。**修法**：改用 AppDialog。

#### 29 · 凭证页两张卡的单选互抢

- **出处**：`AuthMethodRadioRow.view.tsx:104`（name 只按方式区分，两张卡同一组）。**复现**：Codex、Claude Code 都选帐号登录 → 浏览器只留一个选中点。
- **关联**：AC-CRD-012.1；DR-20。**修法**：name 带上 Agent。

#### 30 · 设置区按 Esc 无条件回工作台，删除确认框开着时也一样

- **复现**：凭证页点某个凭证的 [删除] → 确认框打开时按 Esc → 直接回到工作台。
- **出处**：`app/settings/layout.tsx:50-58`（window 上监听）；`RevokeConfirmDialog.view.tsx:48-54`（手写遮罩、没有初始焦点）。
- **关联**：AC-CRD-002.6；Q-WB-04。**修法**：弹层开着时 Esc 只关弹层；确认框改用 AppDialog。

#### 31 · 删掉当前在用的凭证后选「取消」：空着的那行单选被选中、显示「当前使用」

- **复现**：某个 Agent 两种方式都配了、当前用帐号登录 → 删除帐号登录 → 追问「要不要切到 API Key」时选「取消」→ 已空的帐号登录那一行显示选中与「当前使用」。
- **出处**：`runtime-credential.service.ts:243-248`；`AuthMethodRadioRow.view.tsx:102-114`。
- **关联**：AC-CRD-004.4。**修法**：后端删掉生效方式时清空 active_auth_method，或前端在「生效方式没有凭证」时不显示单选与徽标（技术设计定）。

#### 32 · 从克隆失败跳到凭证页不定位到 Git 分区；从项目主区跳来不带仓库地址

- **复现**：新建一个私有仓的 Git 项目、401 克隆失败 → 点 [配置 Git 凭证] → 凭证页从顶部打开，Git 分区不在视口；从项目主区点同一按钮跳来时，卡上 [测试连接] 测的是 host 根地址。
- **出处**：`NewProjectContainer.tsx:76`、`ProjectRecoveryContainer.tsx:35-36`（都只是 `router.push('/settings/credentials')`，后者不带地址）。prj-a、crd-b 两组核实。
- **关联**：AC-CRD-034.1、034.6、AC-PRJ-005.5。**修法**：跳转带锚点与仓库地址。

#### 33 · 卡片 [测试连接] 不带回程仓库时探测 host 根地址，有效 Token 也可能报「认证失败」（待联网实测）

- **复现**：直接打开凭证页（不是从克隆失败跳来），给 github.com 配一个有效 Token → 点卡上 [测试连接] → 可能显示「认证失败」。
- **出处**：`credential-application.service.ts:350-362`；`git-ls-remote.tester.ts:50-59`（not found 归为 CLONE_FAILED_PERMISSION）。
- **关联**：AC-CRD-023.7；Q-CRD-03。**修法**：实测属实后按 Q-CRD-03 A 取项目仓库地址作目标。

#### 34 · [定位到该镜像] 不滚动、不清过滤，焦点回到 [注册新镜像]

- **出处**：`ImagesContainer.tsx:137-143`；`useModalFocus.ts`（关弹层还原焦点）。**复现**：状态过滤停在「无效」时注册一张已注册的「有警告」镜像 → [定位到该镜像] → 看不到被标的卡。
- **关联**：AC-IMG-005.2、005.3。**修法**：先清过滤与搜索、滚到可见、焦点落卡。

#### 35 · 镜像预检 / 保存请求失败只出右上角轻提示，弹层里没有变化

- **复现**：注册新镜像，填一个下载源不可达的地址 → [验证] → 弹层里没有任何变化，只有右上角轻提示。
- **出处**：`useImages.ts:435-437、476-478 → 237-256`；`:226`（INVALID_STATE 标题带「⚠️」）。
- **关联**：AC-IMG-008.1–008.4。**修法**：失败在弹层里原位说（页脚上方 role=alert + [重试]），轻提示只作补充。

#### 36 · 镜像列表读取失败显示成「还没有注册任何镜像」

- **出处**：`useImages.ts:894-896`（`noImagesAtAll = !isPending && 0 行`）；`providers.tsx:37`（默认重试 2 次）。**复现**：让 `/api/images` 失败。
- **关联**：AC-IMG-052.1、052.2。**修法**：读取失败单独一态 + [重试]。

#### 37 · 切到历史版本时，被点的那一行不显示「切换中…」

- **复现**：一张镜像有 2 个历史版本 → 在历史条点 [切换到此版本] → 被点的那一行没有「切换中…」、按钮也不禁用。
- **出处**：`ImagesContainer.tsx:226`（switchingId 接成卡面行 id）；`useImages.ts:341-343`；故事 `ImageVersionHistory.view.stories.tsx:93-97` 是绿的，测试没抓到。
- **关联**：AC-IMG-024.2。**修法**：switchingId 用被点的那一行。

#### 38 · 镜像引用计数含已销毁的任务：任务都销毁了，镜像仍删不掉

- **复现**：用某个自定义镜像跑一个任务 → 销毁这个任务 → 删除这张镜像 → 仍 409「还有任务在用」。
- **出处**：`image-manifest.repository.impl.ts:191-196`；`sandbox.repository.impl.ts:72`（只在列表里过滤 destroyed）；drizzle 0010:58（image_ref ON DELETE RESTRICT）。
- **关联**：AC-IMG-034.3；DR-19。**修法**：计数只算未销毁的任务，外键随之调整。

#### 39 · 已经在下载时再点 [准备镜像]：409 IN_FLIGHT 的开发者原文被当失败上屏

- **复现**：两个标签页同时停在初始化向导第 3 步（或下载进行中刷新页面）→ 后一个再触发 [准备镜像] → 失败样式里出现后端原文「已经有一次搬运在进行中。⚠️ …」。
- **出处**：`preset-image-provisioner.ts:235-238`；`usePresetImageProvision.ts:105-109`。
- **关联**：AC-IMG-042.5。**修法**：IN_FLIGHT 不当失败，写「已经在下载了…稍后回来看。」。

#### 40 · 诊断第 ⑧ 项让人去「系统状态页点 [准备镜像]」，本页没有这个按钮

- **复现**：让预制镜像处于「下载源里没有」或「没下载到本机」→ 系统状态跑一轮诊断 → 第 ⑧ 项第 2 步的下一步写「在初始化向导或系统状态页点 [准备镜像]」，本页找不到这个按钮。
- **出处**：`preset-image.check.ts:431`（第 2 步）、`:379-382`（第 5 步没说在哪）。
- **关联**：AC-IMG-043.4、REQ-DIA-018；DR-36。**修法**：指向「镜像管理 › 预制镜像卡 [准备镜像]」+ 文字链（REQ-IMG-043）。

#### 41 · 禁用预制镜像后用它的新任务都被门口拒，界面事先没有任何说明

- **复现**：镜像管理里禁用预制镜像（轻提示只说「…向导下拉里不再出现这张镜像」）→ 发起任何新任务 → 门口被拒「所有版本都已停用」。
- **出处**：`image-facade.adapter.ts:44-47、77-85`；`useImages.ts:588`（轻提示还说「向导下拉里不再出现这张镜像」）。
- **关联**：AC-IMG-032.4；Q-IMG-04（2026-10-04 已拍板 A）。**修法**：[禁用] 先出一步非破坏性确认、说清后果，轻提示也改说后果（REQ-IMG-032）；新建任务的「镜像」一栏里它置灰写原因，用户可以改选别的镜像（Q-LCH-03 B，REQ-LCH-004）。

#### 42 · 连接卡首屏就写「正常」，终端行状态写死 ok

- **复现**：打开系统状态页，在数据回来之前看连接卡 → REST 行已写「正常（本页数据刚取回）」；终端行始终是「正常」。
- **出处**：`useSystemStatusModels.ts:49`（只看 isError）、`:53`（错误码没传）；`connectionModel.ts:75`。
- **关联**：AC-SYS-040.4、040.6；Q-SYS-21。**修法**：首屏写「未知」，终端行不挂「正常」。

#### 43 · 代理地址只限长度，`socks5://` 被原样存下

- **复现**：系统状态 → 出网代理，HTTPS_PROXY 填 `socks5://127.0.0.1:7891` 并保存 → 保存成功；之后的联网检查按 HTTP CONNECT 走这个地址失败。
- **出处**：`system.schema.ts:232-236`；`connectivity.probe.ts:364-379`（只走 HTTP CONNECT，无协议按 http:// 处理，:376）。
- **关联**：AC-SYS-060.4；Q-SYS-20。**修法**：契约限定 http:// / https://，前端就地报错。

#### 44 · 诊断中断后，没返回的项仍在转圈

- **复现**：跑一轮诊断，中途断开 SSE（如重启 api）→ 没返回的项一直转圈；在拿到清单之前就断开时，中断句仍写「已到达的结果保留在下方」。
- **出处**：`status-pill.tsx:44、99`；`DiagnosticItem.view.tsx:75-76、101-103`；`DiagnosticsCard.view.tsx:89`（中断句后半句固定拼，没拿到清单时也拼）。
- **关联**：AC-DIA-003.5、003.6。**修法**：未返回的项改「未返回」虚线徽标；没有结果时中断句不写后半句。

#### 45 · 诊断汇总把超时算进失败

- **复现**：让第 ⑤ 项有一个目标超时（如把某个模型 API 指向不应答的地址）→ 诊断汇总写「N 项失败（含超时）」。
- **出处**：`diagnostics.service.ts:116-119`（failCount 含超时）；`diagnoseModel.ts:198-210`。
- **关联**：AC-DIA-040.1。**修法**：前端按逐项状态计数，超时单列（不用改帧）。

#### 46 · 审计时间范围：起晚于止照常发请求、拿回空结果；条件句是 ISO 原串

- **复现**：审计流的「起」填得比「止」晚 → 列表变「当前筛选无匹配记录」，没有提示起止颠倒；条件句显示 ISO 原串。
- **出处**：`useAuditFilters.ts:49-60`（不比较起止）；`audit.controller.ts:121-128`；`auditStream.ts:279-280、305-313`。
- **关联**：AC-AUD-020.2、020.3、020.4、020.6。**修法**：起晚于止就地提示、不发请求；条件句写本地时间。

#### 47 · 非 HTTPS 部署下所有 [复制] 失败都没有反馈

- **复现**：用 `http://<局域网 IP>` 打开平台 → 终端 [复制]、结果卡 [复制诊断信息]、诊断命令 [复制] → 没有任何提示，剪贴板没变；用户会粘出上一次复制的内容。
- **出处**：`navigator.clipboard` 不存在时 `writeText` 同步抛 TypeError、`.then` 的失败回调走不到：`TerminalMount.tsx:105`、`SandboxLifecycleContainer.tsx:67`、`SystemStatusContainer.tsx:38`、`InitWizardContainer.tsx:38`；`AuthGateContainer.tsx:232-234`（设备码 [复制] 连成功提示都没有）。wb 组核实前两处，后三处为合并时补查；只有 `useImages.ts:683`（复制版本号）用 try/await 做对了。现有测试只替身了「存在但拒绝」（`TerminalMount.test.tsx:436、456`）。
- **关联**：AC-WB-063.4、AC-SBX-005.2（合并时由「已实现」更正）、REQ-DIA-006。**修法**：抽一个共用的 copyText（try/await + 非安全上下文直接走失败提示），五处统一替换。

#### 48 · 「自动化需关注」横幅只看当前项目，且要打开过自动化面板才有数据

- **复现**：从不打开某个项目的自动化面板，让它的一条规则连续失败到被自动停用 → 工作台与项目总览都不出「自动化需关注」横幅。
- **出处**：`useGlobalBanner.ts:115-120`；`automationAttention.ts:120-134`（自述缺跨项目接口）。
- **关联**：AC-WB-013.3、REQ-WB-013；Q-WB-01（2026-10-04 已拍板 B）。**修法**：后端加跨项目规则概览接口（AC-AUT-004.6），横幅改用它按全部项目判定、说明里点名项目与规则（AC-WB-013.5、013.6）。

#### 49 · 因凭证跳过的运行也发 Webhook，不看「什么时候发通知」

- **复现**：规则的通知设为「只在成功时发」→ 让 Agent 凭证过期 → 到点因凭证跳过 → 仍收到一条 Webhook。
- **出处**：`automation.scheduler.ts:485-488 → automation.notifier.ts:70-80`。上一次还在跑导致的跳过与错过都不发，只有凭证这一类发。
- **关联**：REQ-AUT-027（AC-AUT-027.3 记的是现状）。**修法**：凭证跳过也按规则的通知设置决定发不发（或在产品说明里明确「凭证问题总是通知」）。

#### 50 · 自动化表单一打开就播报三条「请填写…」；名称 / 描述上限前端不查

- **复现**：打开新建规则表单 → 读屏立刻念出三条「请填写…」；名称填 61 个字保存 → 只得到通用句「提交的内容不合要求，请检查后再试。」。
- **出处**：`useAutomationForm.ts:115-121`；`automationPayload.ts:59-78`（只查空）；contracts `automation.schema.ts:92-93`（60 / 500 字）。
- **关联**：AC-AUT-013.4、013.5；Q-AUT-06。**修法**：改过或失焦才显示；前端补长度校验。

#### 51 · 系统状态的成果倒计时按「状态文件时间 + 固定 30 天」算（合并时发现）

- **复现**：目前所有成果都按默认 30 天登记，两边暂时一致；DR-18 落地、自动化成果按规则的 3 / 7 天登记后：建一条保留期 7 天的规则跑一次 → 系统状态「最早一份成果…后清理」仍按 30 天算。
- **出处**：`system-resources.service.ts:24、123-129`；而成果账本每份有自己的到期时间（`retained-volume.entity.ts:104`、`retained-volume.service.ts:28`）。自动化成果按规则的 3 / 7 天登记后，两边就会不一致。
- **关联**：REQ-SYS-020（合并说明）、REQ-PRJ-055；Q-SYS-11 ①。**修法**：本页取账本里最早到期的那一份。

### sev4（14 条）

| # | 缺陷 | 复现 | 出处 | 关联 | 修法 |
|---|---|---|---|---|---|
| 52 | 空项目提交后多一步「项目可用了」 | 新建一个空项目并提交 → 弹层多出一屏「项目可用了」+ [打开项目] | `NewProjectContainer.tsx:21-24`、`CloneProgress.view.tsx:107-111` | AC-PRJ-006.1 | 空项目直接关弹层、选中、落到「还没有任务」 |
| 53 | 取消克隆失败时，未知码的兜底句是「删除失败，请稍后重试。」 | 让取消克隆请求失败（后端回一个前端没收录的码）→ 提示「删除失败，请稍后重试。」 | `useProjects.ts:94-99`、`WorkbenchContainer.tsx:209-212` | AC-PRJ-013.3 | 换成取消克隆自己的兜底句 |
| 54 | 拉取失败沿用克隆文案（句尾「可重试克隆」）；BRANCH_NOT_FOUND 建议句写 [重新同步] | 在就绪的 Git 项目上 [拉取最新代码]，让远端回 403 → 失败句尾是「可重试克隆」 | `useProjectBranches.ts:98-99`、`projectClone.ts:113-181`、`sandboxErrorCopy.ts:159` | AC-PRJ-022.2、022.3；DR-25 | 拉取单独一张文案表 |
| 55 | BRANCH_NOT_FOUND 就地提示拼后端英文原串；未收录的码把后端 message 填进建议位 | 用一个不存在的分支发起任务（改请求或深链）→ 就地提示里出现英文「project … has no branch …」 | `project-facade.adapter.ts:81-84`、`sandboxErrorCopy.ts:472-479、488-498` | AC-LCH-007.2、007.4 | 只用前端文案表 |
| 56 | 无头超时句带退役词「预算」；退出码缺席时结果区写「未知（…）」、只读详情写「—」 | 让无头任务超过最长运行时间 → 结果句里有「预算」；被信号终止 → 结果区与只读详情的退出码写法不同 | `taskOutcome.ts:187、292`、`HeadlessTaskDetail.view.tsx:111` | AC-SBX-032.4、REQ-SBX-034 | 改「上限」；两处写法统一 |
| 57 | 切换确认框标题与轻提示「切换到API Key」少空格 | 切换生效方式 → 确认框标题「切换到API Key」 | `runtimeCredential.ts:147-149`、`useCredentials.ts:230` | AC-CRD-010.1、010.2；DR-35 ⑩ | 补空格 |
| 58 | 启用镜像成功的提示是「已切换到该版本。」 | 禁用一张自定义镜像后再 [启用] → 轻提示「已切换到该版本。」 | `useImages.ts:564、580-585` | AC-IMG-031.3 | 启用单独一句 |
| 59 | 后端搬运阶段句仍写「铺进」 | 在向导里准备预制镜像 → 阶段句出现「铺进」 | `preset-image-provisioner.ts:277、289` | AC-IMG-041.6 | 改「下载到本机」 |
| 60 | 镜像要求面板第②条「要有 WorkingDir」平台不拦 | 注册一张有 Entrypoint、没写 WorkingDir 的镜像 → 验证通过，与面板第②条矛盾 | `oci-image-spec.provider.ts:99、173-179` | AC-IMG-007.4；Q-IMG-01 | 随 Q-IMG-01（推荐改面板文案） |
| 61 | 注册弹层点遮罩不关（手写遮罩） | 打开注册弹层，点遮罩 → 不关 | `RegisterImageModal.view.tsx:60-65` | AC-IMG-001.4 | 改用 AppDialog |
| 62 | 第 ⑨ 项诊断没有序号 | 跑一轮诊断 → 第 9 项没有序号 | `DiagnosticItem.view.tsx:59、93` | AC-DIA-002.3；format-pilot B-03 | 序号表补到 ⑨，按首帧长度生成 |
| 63 | 单项时限的接口描述与契约注释仍写 5 秒（实际 10 秒） | 看 `POST /api/system/diagnose` 的接口描述（openapi）→ 写「5s」 | `system.controller.ts:199`、`api/openapi.json` 与 `web/openapi.json:2418`、`sse-protocol.ts:66` | AC-DIA-003.7；format-pilot B-02 | 注释改引用 `PARAM.DIAG_ITEM_TIMEOUT_MS` |
| 64 | 审计摘要与执行者上屏英文状态值、「沙箱」「Provider 事件」 | 让一个任务从 starting 变 running → 审计行摘要「沙箱状态 starting → running」，执行者「Provider 事件」 | `audit.projector.ts:84、103、268`、`auditRowModel.ts:45` | AC-AUD-003.6 | 后端同步定稿词，或前端按事件类型重拼 |
| 65 | 「无法确认平台状态」横幅在系统状态页上仍给 [查看系统状态]；Agent 凭证未配置在本页映射成「未知」虚线徽标；沙箱环境阈值在前端写死两处；自动化建任务不传任务名（树上看不出是哪条规则跑的） | 在系统状态页触发「无法确认平台状态」横幅 → 仍有 [查看系统状态]；Agent 凭证未配置时沙箱环境那一行是虚线「未知」；自动化跑出的任务在树上是按 Agent 名生成的兜底名 | `globalBanner.ts:75`；`SandboxEnvStatusCard.view.tsx:57、108-111`、`sandboxEnvModel.ts:21-22`；`automation-task-launcher.adapter.ts:77-87` | AC-WB-013.4、AC-SYS-030.5、030.6、AC-SBX-030.2；Q-SBX-07 | 各改一处；任务名随 Q-SBX-07 |

> 只是事实、不是缺陷的核实结论（例如受理返回 201 不是 202、预检时限实际是每次请求 15 秒、拉取同步请求 5 分钟超时、终端重连上限 8 有两处落点）已经写进对应 REQ 的「改写了哪条旧文」或参数附录，这里不重复。

## 2. 合并时统一口径带出的差距

合并时按「实现与已有推荐」统一了 16 处说法（各领域文件附录 E 有逐条记录）。其中会带出实现改动的如下；已经落在某条 AC 上的，§3–§5 的表里也有，这里只为了让你一眼看到它们是「统一口径」而来的。

| 统一的口径 | 涉及 | 实现差距 | 层 | 在哪条 AC |
|---|---|---|---|---|
| 未就绪项目的禁用原因分两句（克隆中 / 克隆失败） | REQ-LCH-001 ↔ REQ-PRJ-016 | 现状只有一句「项目尚未就绪（克隆完成后可发起）」（WorkbenchContainer.tsx:286） | 前端 | AC-PRJ-016.1、016.2 |
| 出网代理只承诺联网检查（Q-SYS-16，2026-10-04 已拍板 A） | REQ-SYS-060 ↔ REQ-IMG-042、REQ-DEP-009、REQ-DEP-011 | 卡片说明（ProxySettingsCard.view.tsx:38-41）、向导第 3 步失败出路句（PresetImageCheck.view.tsx:271-273）都承诺「走这组代理」 | 前端 | AC-SYS-060.9、AC-DEP-011.4 |
| 全部只是超时不算离线 | REQ-DEP-007 ↔ REQ-WB-014 | 前端结论把超时算成失败并驱动离线横幅（connectivityVerdict.ts:38）；后端写入门只看 ok（initialization.service.ts:93-94） | 前端 + 后端 | AC-DEP-007.3、007.4 |
| 镜像页空态与禁用提示不再说「发起任务向导的镜像下拉」（旧称；Q-LCH-03 已拍板 B，改指新建任务的「镜像」一栏） | REQ-IMG-051 ↔ REQ-LCH-004、REQ-IMG-030 | 空态说明句（ImagesContainer.tsx:96-127）、禁用轻提示（useImages.ts:588）、删除被拒的 409 文案（image-application.service.ts:395-396）都提「下拉」 | 前端 + 后端 | AC-IMG-051.1（偏离）、AC-IMG-030.4、AC-IMG-034.4 |
| 成果倒计时按每份自己的到期时间（Q-SYS-11 ①） | REQ-SYS-020 ↔ REQ-PRJ-055 | 系统状态页按状态文件时间 + 固定 30 天算（system-resources.service.ts:24、123-129） | 后端 | 无单独 AC，见 §1 第 51 条 |
| 「已满（R / M）」与「本机最多 M 个」是同一个数 | REQ-LCH-007 ↔ REQ-SYS-071 | 契约没有 M（DR-08 只有 remainingTasks / registeredTasks / basis）；契约到位前两处都不写数字 | 契约 | AC-SYS-071.1；Q-SYS-17 |
| 非 HTTPS 下 [复制] 必须有失败反馈 | REQ-SBX-005 ↔ REQ-WB-063、REQ-DIA-006 | 五处写法相同、都没有保护（见 §1 第 47 条） | 前端 | AC-SBX-005.2（合并时由已实现更正）、AC-WB-063.4 |
| 诊断第 ⑧ 项的准备动作指向镜像管理 | REQ-DIA-018 ↔ REQ-IMG-040、043 | 诊断句仍指向系统状态页上不存在的 [准备镜像]（preset-image.check.ts:379-382、431） | 后端 | AC-IMG-043.4 |
| 帐号登录即将过期的参数只登记一个 | REQ-WB-015 ↔ REQ-CRD-033 | 统一用 `PARAM.CRED_EXPIRY_WARN_DAYS`（7 天；两处代码落点 credentialExpiry.ts:11、runtime-credential.service.ts:46） | 文档（params.yaml） | — |
| 离线置灰清单里的「自动化 [立即触发]」 | REQ-WB-014 ↔ REQ-AUT-020 | 没有这个控件，不是差距；AC-WB-014.5 对这一项不验收 | — | — |
| 环境类错误的 [运行诊断]（Q-SYS-01②，2026-10-04 已拍板 A） | REQ-SBX-001、014 ↔ REQ-SYS-001 | 文案表 PROVIDER_UNAVAILABLE、DISK_INSUFFICIENT 没有诊断动作，建议句只点名 Docker（sandboxErrorCopy.ts:235-244、371-377） | 前端 | AC-SBX-001.5、AC-SBX-014.1、AC-SYS-001.5 |

### 2026-10-04 拍板带来的实现工作

用户 2026-10-04 回复「补全 10 条按推荐」（open-questions.md §1）。其中 4 条与原默认相同（Q-SYS-16 A、Q-IMG-03 C、Q-SBX-02 B、Q-PRJ-06 A），没有新的实现范围，原有差距照旧（AC-SYS-060.9、AC-DEP-011.4；AC-IMG-026.1；AC-PRJ-051.3），只把 Q-SBX-02 B 的两处界面写成了验收；另 6 条带来的实现工作如下，已经都落在某条 AC 上，§3–§5 的表里按「现状」点名的文件再归一次层。「层」写主层，跨层的写在后面。

| 拍板 | 实现工作 | 层 | 在哪条 AC |
|---|---|---|---|
| Q-LCH-03 B | 新建任务弹层加「镜像」字段：选项取镜像列表（`GET /api/images`），默认项平台预制镜像，已禁用 / 验证无效的置灰并在括号里写原因，读不到只降级；请求体带 `image`；平台预制镜像被禁用时主按钮说原因 | 前端 | AC-LCH-004.4、004.6、004.7、004.8 |
| Q-LCH-03 B | 弹层里镜像相关的门口拒绝按码换句：INVALID_IMAGE_REFERENCE 不再说「空白或控制字符」，IMAGE_NOT_REGISTERED、IMAGE_PROVIDER_MISMATCH 写「请改选一张镜像」 | 前端 | AC-LCH-004.9 |
| Q-LCH-03 B | 镜像列表给出「这张镜像跑不跑得在这台机器的档上」（加字段或按档过滤），弹层据此不列档位不符的 | 契约 + 后端 | AC-LCH-004.10 |
| Q-LCH-03 B | `SandboxDto` 回显所用镜像（版本行 id、坐标、版本号、是不是平台预制镜像），刷新后仍在 | 契约 + 后端 | AC-LCH-017.1 |
| Q-LCH-03 B | 启动进度卡、异常 / 超时 / 已停止结果卡、[复制诊断信息]、任务菜单与无头只读详情写出所用镜像 | 前端（依赖上一行） | AC-LCH-017.2–017.5 |
| Q-LCH-03 B | [重新发起] 预填原任务的镜像（不能用时置灰、不悄悄换回默认）；[检查镜像地址] 一类去处定位到任务用的那张镜像 | 前端（依赖 AC-LCH-017.1） | AC-SBX-003.5、AC-SBX-004.5 |
| Q-LCH-03 B | 镜像页空态说明句、禁用轻提示、删除被拒的 409 文案改指新建任务的「镜像」一栏，不再说「向导下拉」 | 前端 + 后端 | AC-IMG-051.1、AC-IMG-030.4、AC-IMG-034.4 |
| Q-ACC-01 C | `PUT /api/system/access-passcode` 的 regenerate 加可选参数「同时让已登录的浏览器失效」：轮换会话签名密钥、给发起者换发 cookie、`PASSCODE_COOKIE_SECRET` 固定时整个拒绝（409，零副作用）、审计写明选了哪种 | 后端 + 契约 | AC-ACC-007.1、007.3 |
| Q-ACC-01 C | README「换口令」一节与首次启动的口令横幅写两条路（接口参数；改 `PASSCODE_COOKIE_SECRET` 后重启）；不新造口令管理页（区块按 D9 延后，U-112） | 后端（日志横幅）+ 文档 | AC-ACC-007.4 |
| Q-IMG-04 A | 预制镜像的 [禁用] 先出非破坏性确认（焦点在 [取消]、不用危险色），确认后才 PATCH；轻提示改说后果 | 前端 | AC-IMG-032.4 |
| Q-SYS-01② A | 环境类错误（PROVIDER_UNAVAILABLE、DISK_INSUFFICIENT）的结果卡加 [运行诊断]：去系统状态并自动开始一轮诊断；建议句不只点名 Docker | 前端 | AC-SBX-001.5、AC-SBX-014.1、AC-SYS-001.5 |
| Q-WB-01 B | 新增跨项目的规则概览接口：一次返回所有被放慢 / 自动停用的规则，带项目与规则名、状态、连续失败次数；只读 | 后端 + 契约 | AC-AUT-004.6 |
| Q-WB-01 B | 「自动化需关注」横幅改用概览、按全部项目判定；说明点名「<项目> 的「<规则>」」（最多 3 条）；[查看这些规则] 去点名的那个项目；概览读不到就不出 | 前端 | AC-WB-013.3、013.5、013.6、AC-AUT-001.4 |
| Q-SBX-02 B | 销毁确认与「取消并删除」按首次启动与否决定给不给「留下来作为成果」（给时默认选中） | 前端 | AC-SBX-022.4、AC-LCH-014.4 |
| Q-SYS-23 A | 系统状态资源卡「保留卷占用」「清理保留卷」→「成果占用」「[清理成果]」 | 前端 | AC-SYS-020.9 |
| Q-SYS-23 A | 诊断第 ③ 项的下一步「先清保留卷（系统状态页「保留卷占用」）或删掉已完成任务的工作区」→ 新用词 | 后端 | AC-DIA-012.2 |
| Q-SYS-23 A | 审计摘要「保留工作区卷（磁盘 N 字节 …）」「清理了保留卷…」→「保留成果（…）」「清理了保留下来的成果…」 | 后端 | AC-AUD-003.7 |
| Q-SBX-03 A | 成果弹层（说明、空态、行内确认）与删除项目确认里的「工作目录」→「代码副本」 | 前端 | AC-PRJ-050.6 |
| Q-SBX-03 A | 系统状态沙箱环境的能力名「挂载工作区目录」→「挂载代码副本」 | 前端 | AC-SYS-030.8 |
| Q-IMG-06 A | 镜像卡徽标「预置」→「预制」 | 前端 | AC-IMG-032.5 |
| 三组术语 | 只改上屏文字：接口字段、代码标识符、诊断码与审计对象类型都不改（`retainedVolumes`、`/api/retained-volumes`、`RetainedVolumesPanel`、`keepVolume`、`retained_volume`、`isBuiltin`） | — | — |

## 3. 前端（442 条 AC）

### 前端 · PRJ（68）

| AC | 差在哪 | 出处 | 建议修法（目标行为） | 稿件 |
|---|---|---|---|---|
| [AC-PRJ-001.1](./PRJ.md#REQ-PRJ-001) `部分实现` | 入口是侧栏底部整宽按钮「＋ 新建项目」（WorkbenchShell.view.tsx:588-590）；弹层与 autoFocus 已实现（WorkbenchContainer.tsx:461-465、NewProjectForm.view.tsx:62） | WorkbenchShell.view.tsx:588-590、WorkbenchContainer.tsx:461-465、NewProjectForm.view.tsx:62 | 打开「新建项目」弹层；来源默认「Git 仓库」，焦点在「项目名称」 | f-prj-create-01 |
| [AC-PRJ-001.2](./PRJ.md#REQ-PRJ-001) `未实现` | 实现没有项目总览（Q-DS-28 A） | — | 打开同一个弹层 | f-prj-create-01 |
| [AC-PRJ-001.3](./PRJ.md#REQ-PRJ-001) `未实现` | 实现没有命令面板 | — | 「新建项目…」排在动作组第一，回车打开同一个弹层 | f-prj-create-01 |
| [AC-PRJ-001.4](./PRJ.md#REQ-PRJ-001) `未实现` | 欢迎态只有一句「选择左侧项目，或新建一个项目开始。」（WorkbenchContainer.tsx:321-325） | WorkbenchContainer.tsx:321-325 | 都打开同一个弹层，来源分别预选「Git 仓库」/「空项目」；后者名称预填「未命名项目 1」 | f-prj-create-01 |
| [AC-PRJ-002.5](./PRJ.md#REQ-PRJ-002) `未实现` | 输入不限长；超长由服务端 400 `VALIDATION_FAILED`，前端只说「提交的内容不合要求，请检查后再试。」（errorCopy.ts:38） | errorCopy.ts:38 | 只留前 40 个，不等提交后才被拒（另需后端配合） | f-prj-create-01、f-prj-create-02 |
| [AC-PRJ-002.6](./PRJ.md#REQ-PRJ-002) `未实现` | 现状没有这句（P21-6 L44-45 要求；稿件 f-prj-create-01 第 7 条需看稿） | — | 仓库地址下有私有仓提示一句，并经 aria-describedby 关联到输入框 | f-prj-create-01、f-prj-create-02 |
| [AC-PRJ-004.7](./PRJ.md#REQ-PRJ-004) `偏离` | role="status" 包住了按钮（CloneProgress.view.tsx:62-104） | CloneProgress.view.tsx:62-104 | live 区域只含进度块，不含 [返回…] 按钮 | f-prj-create-04、f-prj-create-05 |
| [AC-PRJ-004.8](./PRJ.md#REQ-PRJ-004) `偏离` | 锚点是本页收到的第一帧（createProjectCloneSlice.ts:48），刷新后从 0:00 起算；要后端在 DTO 或进度帧里给开始时刻 | createProjectCloneSlice.ts:48 | 已用时长从克隆开始算；拿不到开始时刻时不写已用（另需后端配合） | f-prj-create-04、f-prj-create-05 |
| [AC-PRJ-005.1](./PRJ.md#REQ-PRJ-005) `部分实现` | 视图已实现（CloneProgress.view.tsx:56、107-111）；这一态没有 live 区域 | CloneProgress.view.tsx:56、107-111 | 「项目可用了」+ 项目名 + [打开项目]；结果以 role="status" 播报（f-prj-create-08） | f-prj-create-06、f-prj-create-07、f-prj-create-08 |
| [AC-PRJ-005.3](./PRJ.md#REQ-PRJ-005) `未实现` | 徽标随列表刷新消失，但没有播报，也没有轻提示 | — | 树组头徽标消失并在原位播报；当前任务不被切走；出一条轻提示「项目「X」可用了」 | f-prj-create-06、f-prj-create-07、f-prj-create-08 |
| [AC-PRJ-005.5](./PRJ.md#REQ-PRJ-005) `部分实现` | 跳转与回程态已实现（NewProjectContainer.tsx:67-77、ProjectRecoveryContainer.tsx:33-37；Git 分区回程横幅 GitCredentialsSection.view.tsx:78-86；重试成功回工作台 useGitCredentialManager.ts:322-333）；跳转只到凭证页，没找到定位到 Git 分区的代码；回程条归 F-CRD-PAGE | NewProjectContainer.tsx:67-77、ProjectRecoveryContainer.tsx:33-37、GitCredentialsSection.view.tsx:78-86、useGitCredentialManager.ts:322-333 | 落在凭证管理的 Git 凭证分区；重试作用在同一个项目上，项目数不变；成功后回到工作台，该项目显示克隆中 | f-prj-create-06、f-prj-create-07、f-prj-create-08 |
| [AC-PRJ-006.1](./PRJ.md#REQ-PRJ-006) `偏离` | 现状多一步「项目可用了」+ [打开项目]（NewProjectContainer.tsx:21-24 把 ready 种成 done → CloneProgress.view.tsx:107-111） | NewProjectContainer.tsx:21-24、CloneProgress.view.tsx:107-111 | 弹层关闭；infra-scripts 被选中；主区「「infra-scripts」下还没有任务」；中途没有出现进度或「项目可用了」视图 | f-prj-create-02 |
| [AC-PRJ-010.2](./PRJ.md#REQ-PRJ-010) `部分实现` | 可以选中；主区只有一句话（REQ-PRJ-012） | — | infra-scripts 成为当前项目；主区是克隆进度（f-prj-clone-01） | f-prj-clone-01、f-prj-clone-04 |
| [AC-PRJ-010.3](./PRJ.md#REQ-PRJ-010) `部分实现` | 主区与菜单共用 useProjectRecovery（WorkbenchContainer.tsx:198-205，F21-6 §10.8 第 3 条有用例）；总览卡不存在 | WorkbenchContainer.tsx:198-205 | 每次只发一个 `retry-clone`；三处的禁用态与错误句一致 | f-prj-clone-01、f-prj-clone-04 |
| [AC-PRJ-010.4](./PRJ.md#REQ-PRJ-010) `未实现` | 实现没有总览；原型卡片写死网络错误一句与 [重试克隆]（proto.js:626-629） | proto.js:626-629 | 第一行是失败说明，下面是同一组动作；失败码为 `PERMISSION` / `NOT_FOUND` 时是 [配置 Git 凭证] [改为空项目] | f-prj-clone-01、f-prj-clone-04 |
| [AC-PRJ-011.1](./PRJ.md#REQ-PRJ-011) `部分实现` | 计数位已是任务数「0」、不写进度；「克隆中」是跟在计数后面的 10px 黄字小块，不是计数前的琥珀徽标，读屏念成「infra-scripts 0 克隆中」（ProjectGroupHeader.view.tsx:106-111） | ProjectGroupHeader.view.tsx:106-111 | 徽标「克隆中」+ 计数位「0」（任务数，不写「42%」）；读屏「infra-scripts，克隆中，0 个任务」（f-prj-create-04） | f-prj-create-04、f-prj-clone-01、f-prj-clone-04 |
| [AC-PRJ-011.3](./PRJ.md#REQ-PRJ-011) `偏离` | 箭头照常可点，且默认展开（ProjectGroupHeader.view.tsx:65-86、selectProjectTaskTree.ts:35） | ProjectGroupHeader.view.tsx:65-86、selectProjectTaskTree.ts:35 | 不展开；说出原因 | f-prj-create-04、f-prj-clone-01、f-prj-clone-04 |
| [AC-PRJ-011.4](./PRJ.md#REQ-PRJ-011) `偏离` | 代码核对，未实测；空组对任何状态都渲染「发起第一个任务 →」（WorkbenchShell.view.tsx:495-521），点了把 currentModal 置成 newTask、地址写上 `?new=1&project=`（useDeepLinkModal.ts:121-135），但未就绪时不挂新建任务容器，弹层不出现（幽灵态）；该项目克隆完成、容器挂上时弹层会突然打开（SandboxTerminalContainer.tsx:4… | WorkbenchShell.view.tsx:495-521、useDeepLinkModal.ts:121-135、SandboxTerminalContainer.tsx:404-405、useDeepLinkModal.ts:114-117 | 没有「发起第一个任务」；之后项目就绪也不会自己弹出新建任务弹层 | f-prj-create-04、f-prj-clone-01、f-prj-clone-04 |
| [AC-PRJ-012.1](./PRJ.md#REQ-PRJ-012) `未实现` | 只有一句「项目正在克隆，克隆完就能发起任务。」（WorkbenchContainer.tsx:313-319）；进度数据已在全局订阅的 store 里 | WorkbenchContainer.tsx:313-319 | 主区「正在克隆项目…」+ 项目名 + 那一句 + 进度 42% 与明细（f-prj-clone-01） | f-prj-clone-01、f-prj-clone-02 |
| [AC-PRJ-012.2](./PRJ.md#REQ-PRJ-012) `未实现` | （还没有做；片段没写细节，见需求正文） | — | 进度未知 + 明细 + 慢提示（f-prj-clone-02） | f-prj-clone-01、f-prj-clone-02 |
| [AC-PRJ-012.4](./PRJ.md#REQ-PRJ-012) `未实现` | 主区没有进度；已用的锚点问题同 AC-PRJ-004.8 | — | 主区按进度未知显示，不写已用 | f-prj-clone-01、f-prj-clone-02 |
| [AC-PRJ-013.1](./PRJ.md#REQ-PRJ-013) `部分实现` | 菜单项已实现（ProjectGroupMenu.view.tsx:155-167）；没有附注 | ProjectGroupMenu.view.tsx:155-167 | 项目详情 / 保留下来的成果 / 自动化规则 → 分隔 → 取消克隆（保留项目）+ 附注 → 分隔 → 删除项目…（红）（f-prj-clone-03） | f-prj-clone-03、f-prj-clone-06 |
| [AC-PRJ-013.3](./PRJ.md#REQ-PRJ-013) `部分实现` | 不收起与原因已实现（WorkbenchContainer.tsx:209-212）；未知码兜底借用了「删除失败，请稍后重试。」（useProjects.ts:94-99） | WorkbenchContainer.tsx:209-212、useProjects.ts:94-99 | 菜单不收起；底部一句取消失败的原因 | f-prj-clone-03、f-prj-clone-06 |
| [AC-PRJ-014.7](./PRJ.md#REQ-PRJ-014) `偏离` | 菜单不看失败码，克隆失败一律给 [重试克隆]、不给 [配置 Git 凭证]（ProjectGroupMenu.view.tsx:120-136；WorkbenchContainer.tsx:406-429 没有传失败码）；原型 proto.js:902-905 同样 | ProjectGroupMenu.view.tsx:120-136、WorkbenchContainer.tsx:406-429、proto.js:902-905 | 与主区同一组出口：[配置 Git 凭证] [改为空项目]，没有 [重试克隆] | f-prj-clone-04、f-prj-clone-05、f-prj-clone-06 |
| [AC-PRJ-016.1](./PRJ.md#REQ-PRJ-016) `偏离` | 现状一句「项目尚未就绪（克隆完成后可发起）」（WorkbenchContainer.tsx:286） | WorkbenchContainer.tsx:286 | 不打开弹层；原因「项目还在克隆，克隆完成后可发起」（f-prj-clone-01） | f-prj-clone-01、f-prj-clone-04 |
| [AC-PRJ-016.2](./PRJ.md#REQ-PRJ-016) `偏离` | 同一句「…克隆完成后可发起」 | — | 原因「克隆失败的项目不能发起任务：先重试克隆或改为空项目」（f-prj-clone-04） | f-prj-clone-01、f-prj-clone-04 |
| [AC-PRJ-016.5](./PRJ.md#REQ-PRJ-016) `未实现` | 实现的新建任务弹层没有项目下拉（Q-DS-29 A 要补，归 F-LCH-FORM） | — | acme-api（克隆失败）、infra-scripts（克隆中）不可选 | f-prj-clone-01、f-prj-clone-04 |
| [AC-PRJ-020.1](./PRJ.md#REQ-PRJ-020) `偏离` | 现状是主区顶部常驻信息条，没有 chip 与浮层（ProjectInfoBar.view.tsx:114-171）（稿件 f-prj-info-01） | ProjectInfoBar.view.tsx:114-171 | 浮层打开：标题 acme-web、副标题「项目信息」；四行 仓库 https://github.com/acme/web.git / 分支 main / 代码体积 45 MB / 最后拉取 2026/10/2 09:12:01；chip 打开态且 `aria-expanded="true"`；焦点在 [拉取最新代码] | f-prj-info-01、f-prj-info-02 |
| [AC-PRJ-020.2](./PRJ.md#REQ-PRJ-020) `未实现` | 同上；（稿件 f-prj-info-01 头注释、previews/f-prj-info-01.check-1024.png）：现状是主区顶部常驻信息条，没有 chip 与浮层（ProjectInfoBar.view.tsx:114-171）（稿件 f-prj-info-01） | — | 打开同一张浮层，贴在 ⓘ 下方、右缘对齐 | f-prj-info-01、f-prj-info-02 |
| [AC-PRJ-020.3](./PRJ.md#REQ-PRJ-020) `部分实现` | 两项文字已有（ProjectInfoBar.view.tsx:109-134），形态同 020.1（稿件 f-prj-info-02） | ProjectInfoBar.view.tsx:109-134 | 浮层两行：仓库「空项目（没有关联仓库）」、创建于 2026/10/2 10:05:12；没有 [拉取最新代码]，没有页脚 | f-prj-info-01、f-prj-info-02 |
| [AC-PRJ-020.4](./PRJ.md#REQ-PRJ-020) `偏离` | 写「—」（ProjectInfoBar.view.tsx:126） | ProjectInfoBar.view.tsx:126 | 都写「远端默认分支」 | f-prj-info-01、f-prj-info-02 |
| [AC-PRJ-020.5](./PRJ.md#REQ-PRJ-020) `未实现` | 同 020.1 | — | 浮层关闭，焦点回到 chip（窄顶栏时回到 ⓘ），chip 回到常态 | f-prj-info-01、f-prj-info-02 |
| [AC-PRJ-021.3](./PRJ.md#REQ-PRJ-021) `部分实现` | 这句只在按钮的 title 与 aria-label 里（ProjectInfoBar.view.tsx:142-143）（稿件 f-prj-info-01） | ProjectInfoBar.view.tsx:142-143 | [拉取最新代码] 下方可见作用范围一句，按钮的 `aria-describedby` 指向它 | f-prj-info-01、f-prj-info-03 |
| [AC-PRJ-021.4](./PRJ.md#REQ-PRJ-021) `部分实现` | 只有一处按钮；「正在拉取…」禁用已实现（ProjectInfoBar.view.tsx:141、149），没有转圈、没有播报，读屏仍念「拉取最新代码」（稿件 f-prj-info-03） | ProjectInfoBar.view.tsx:141、149 | 顶栏按钮与浮层按钮同时变「正在拉取…」并禁用（前缀转圈）；四项保持旧值；role="status"「正在拉取 acme-web 的最新代码…」 | f-prj-info-01、f-prj-info-03 |
| [AC-PRJ-021.6](./PRJ.md#REQ-PRJ-021) `偏离` | 仍写「[重新同步]」（sandboxErrorCopy.ts:159） | sandboxErrorCopy.ts:159 | 指路写「拉取最新代码」，全句不出现「重新同步」 | f-prj-info-01、f-prj-info-03 |
| [AC-PRJ-022.1](./PRJ.md#REQ-PRJ-022) `偏离` | 成功静默，只刷新数据（useProjectBranches.ts:93-95）（稿件 f-prj-info-05） | useProjectBranches.ts:93-95 | 「最后拉取」= 刚刚（提示里是 2026/10/2 14:28:05）、代码体积 46 MB；role="status"「已更新到最新；已建好的任务不受影响」；两处按钮恢复 | f-prj-info-04、f-prj-info-05 |
| [AC-PRJ-022.2](./PRJ.md#REQ-PRJ-022) `偏离` | 句尾是「可重试克隆」（projectClone.ts:120），句子挂在信息条右侧（ProjectInfoBar.view.tsx:153-170）（稿件 f-prj-info-04） | projectClone.ts:120、ProjectInfoBar.view.tsx:153-170 | 四项不变；浮层正文 role="alert" 一句（见上表）+ [配置 Git 凭证]；两处按钮恢复 | f-prj-info-04、f-prj-info-05 |
| [AC-PRJ-022.3](./PRJ.md#REQ-PRJ-022) `偏离` | 五个码都用克隆的句子（projectClone.ts:138-181，经 useProjectBranches.ts:98-99） | projectClone.ts:138-181、useProjectBranches.ts:98-99 | 每个码一句拉取自己的话，句子里没有「克隆」 | f-prj-info-04、f-prj-info-05 |
| [AC-PRJ-022.4](./PRJ.md#REQ-PRJ-022) `部分实现` | 只跳页面，不定位（WorkbenchContainer.tsx:357-359） | WorkbenchContainer.tsx:357-359 | 到「凭证管理」并定位到 Git 分区 | f-prj-info-04、f-prj-info-05 |
| [AC-PRJ-022.5](./PRJ.md#REQ-PRJ-022) `未实现` | 稿件 f-prj-info-04 头注释 | — | 浮层自动打开贴在 chip（或 ⓘ）下，焦点不动，失败句 role="alert" | f-prj-info-04、f-prj-info-05 |
| [AC-PRJ-022.6](./PRJ.md#REQ-PRJ-022) `未实现` | 稿件 f-prj-info-05 头注释 | — | 浮层不打开；视觉隐藏的 status 播报「已更新到最新；已建好的任务不受影响」；chip 的说明与总览项目卡的最后拉取变成「刚刚」 | f-prj-info-04、f-prj-info-05 |
| [AC-PRJ-030.3](./PRJ.md#REQ-PRJ-030) `偏离` | 只判断加载中，读取失败后按空列表算成 0（ProjectMenuContainer.tsx:101-102；useRetainedVolumes.ts:104，useAutomations.ts:273） | ProjectMenuContainer.tsx:101-102、useRetainedVolumes.ts:104、useAutomations.ts:273 | 对应那一行写「—」，不写「0 项 / 0 条」 | f-prj-detail-01 |
| [AC-PRJ-040.1](./PRJ.md#REQ-PRJ-040) `偏离` | 打开时不拦，只有一句「其中 N 个任务正在跑，会被强制停下」（DeleteProjectConfirm.view.tsx:89-98）；成果要按下之后才被 409 拦（稿件 f-prj-delete-02） | DeleteProjectConfirm.view.tsx:89-98 | 拦截块两条：活跃任务逐个列名 + [去停止或销毁]；成果一句 + [去清理]；[删除项目] `aria-disabled`，左边「先停止或销毁上面 5 个任务，并清理 1 份成果」；焦点在 [取消] | f-prj-delete-02 |
| [AC-PRJ-040.2](./PRJ.md#REQ-PRJ-040) `部分实现` | 只数 preparing / running / waiting-input（projectDeletion.ts:16-20）；停止中在前端没有单独状态（types/domain.ts:5-6） | projectDeletion.ts:16-20、types/domain.ts:5-6 | 前五种计入；已停止、异常不计入 | f-prj-delete-02 |
| [AC-PRJ-040.3](./PRJ.md#REQ-PRJ-040) `未实现` | （还没有做；片段没写细节，见需求正文） | — | 弹层关闭；树的筛选回到「全部」，该项目展开并滚入视野，5 个活跃任务都看得见 | f-prj-delete-02 |
| [AC-PRJ-040.4](./PRJ.md#REQ-PRJ-040) `未实现` | 没有这个按钮，409 文案只指路（projectErrorCopy.ts:31-32） | projectErrorCopy.ts:31-32 | 删除确认关闭，打开该项目的「保留下来的成果」 | f-prj-delete-02 |
| [AC-PRJ-041.1](./PRJ.md#REQ-PRJ-041) `偏离` | 只写「这个项目下的 N 个任务，以及它们的工作目录。」，不列名、不提规则（DeleteProjectConfirm.view.tsx:73-74）（稿件 f-prj-delete-01） | DeleteProjectConfirm.view.tsx:73-74 | 会删掉三条：「3 个任务和它们的代码副本：跑一遍示例测试、梳理目录结构、试用自动化规则（都已停止）」「这台机器上的仓库副本（12 MB）」「1 条自动化规则，以及它的运行历史」；不受影响两条；焦点在 [取消] | f-prj-delete-01 |
| [AC-PRJ-041.2](./PRJ.md#REQ-PRJ-041) `偏离` | 固定写「这个项目下的 0 个任务…」（DeleteProjectConfirm.view.tsx:74） | DeleteProjectConfirm.view.tsx:74 | 会删掉只有「这台机器上的仓库副本（8 MB）」一条，不出现任务与规则两条 | f-prj-delete-01 |
| [AC-PRJ-042.1](./PRJ.md#REQ-PRJ-042) `部分实现` | 有一句指路，没有就地按钮（DeleteProjectConfirm.view.tsx:100-106）（稿件 f-prj-delete-03） | DeleteProjectConfirm.view.tsx:100-106 | 顶部说明块 + [取消克隆（保留项目）]；会删掉两条（见上）；焦点在 [取消] | f-prj-delete-03 |
| [AC-PRJ-042.2](./PRJ.md#REQ-PRJ-042) `部分实现` | 「⋯」菜单里的同名项已接（ProjectGroupMenu.view.tsx:155-167），确认框里没有 | ProjectGroupMenu.view.tsx:155-167 | 删除确认关闭；发 `POST /api/projects/{id}/cancel-clone`；项目留在树上，随后落定为「克隆失败 · 被中断」（REQ-PRJ-013） | f-prj-delete-03 |
| [AC-PRJ-043.1](./PRJ.md#REQ-PRJ-043) `偏离` | 只禁两个按钮（DeleteProjectConfirm.view.tsx:119、130、137）；对话框没拿到 busy，✕ / Esc / 遮罩仍能关（WorkbenchContainer.tsx:467-473，AppDialog.view.tsx:50、65-70）（稿件 f-prj-delete-04 左） | DeleteProjectConfirm.view.tsx:119、130、137、WorkbenchContainer.tsx:467-473、AppDialog.view.tsx:50、65-70 | 「删除中…」禁用并带转圈；[取消] 与右上关闭禁用；Esc、点遮罩不关；role="status"「正在删除项目「示例项目」…」 | f-prj-delete-04 |
| [AC-PRJ-043.2](./PRJ.md#REQ-PRJ-043) `部分实现` | 不关、就地红字已有（ProjectMenuContainer.tsx:70-73，DeleteProjectConfirm.view.tsx:108-112）；没有「原样保留」那半句（现状也不成立，见 043.3）（稿件 f-prj-delete-04 右） | ProjectMenuContainer.tsx:70-73、DeleteProjectConfirm.view.tsx:108-112 | 弹层不关；正文末尾 role="alert"「没能删除项目：连不上平台（网络不通）。」+「项目原样保留，什么都没删；网络恢复后可以再点一次「删除项目」。」；按钮与关闭恢复 | f-prj-delete-04 |
| [AC-PRJ-044.1](./PRJ.md#REQ-PRJ-044) `部分实现` | 项目列表与任务列表都失效重取（useProjects.ts:148-149）；任务成孤儿（见 AC-PRJ-041.3） | useProjects.ts:148-149 | 树、总览、⌘K、新建任务下拉里都没有示例项目；它的 3 个任务不在任何组里 | — |
| [AC-PRJ-044.2](./PRJ.md#REQ-PRJ-044) `部分实现` | 选中态已清空（useProjects.ts:143-147），主区落到「选择左侧项目…」引导，没有提示 | useProjects.ts:143-147 | 主区回项目总览，顶部「已删除项目「示例项目」」，读屏播报同一句 | — |
| [AC-PRJ-050.2](./PRJ.md#REQ-PRJ-050) `未实现` | 缺陷；页面没传回调，点了没反应（page.tsx:30，SystemStatusContainer.tsx:47-51；DR-27） | page.tsx:30、SystemStatusContainer.tsx:47-51 | 打开同一个弹层的跨项目视图 | f-prj-retained-01、f-prj-retained-05 |
| [AC-PRJ-050.3](./PRJ.md#REQ-PRJ-050) `未实现` | 同 AC-PRJ-040.4 | — | 打开该项目的「保留下来的成果」 | f-prj-retained-01、f-prj-retained-05 |
| [AC-PRJ-050.4](./PRJ.md#REQ-PRJ-050) `未实现` | web 没有销毁任务的界面（BACKLOG DR-03：sandbox.service 只有 create / get / list） | — | 页内提示里的「保留下来的成果」是链接，点开是该项目的列表，新的一份在里面 | f-prj-retained-01、f-prj-retained-05 |
| [AC-PRJ-050.5](./PRJ.md#REQ-PRJ-050) `未实现` | web 没有 ⌘K（format-pilot AC-SYS-001.4）；由 F-WB-CMDK 补 | — | 每个有成果的项目一条「保留下来的成果 · <项目> N 份」，选中打开该项目的列表 | f-prj-retained-01、f-prj-retained-05 |
| [AC-PRJ-050.6](./PRJ.md#REQ-PRJ-050) `偏离` | 成果弹层的说明、空态与行内确认写「工作目录」（RetainedVolumesPanel.view.tsx:65、87、158），删除项目确认写「…以及它们的工作目录。」（DeleteProjectConfirm.view.tsx:74） | RetainedVolumesPanel.view.tsx:65、87、158、DeleteProjectConfirm.view.tsx:74 | 只用「保留下来的成果」「代码副本」；不出现「工作目录」「保留卷」「已保留卷」「成果卷」「工作区卷」 | f-prj-retained-01、f-prj-retained-05 |
| [AC-PRJ-051.5](./PRJ.md#REQ-PRJ-051) `部分实现` | 只用黄色字，没有图标（RetainedVolumesPanel.view.tsx:115-125）（稿件 f-prj-retained-01） | RetainedVolumesPanel.view.tsx:115-125 | 警告徽标：三角图标 +「不足 1 天」 | f-prj-retained-01、f-prj-retained-05 |
| [AC-PRJ-053.1](./PRJ.md#REQ-PRJ-053) `偏离` | 行内确认（RetainedVolumesPanel.view.tsx:155-183）（稿件 f-prj-retained-02） | RetainedVolumesPanel.view.tsx:155-183 | 同一对话框换成确认：标题「删除成果「补一份示例 README」？」；会删掉「这份代码副本（占用 2.1 GB）」；不受影响「同项目里另外 1 份成果」「示例项目本身，以及它的 3 个任务」；焦点在 [取消]；没有第二层遮罩 | f-prj-retained-02 |
| [AC-PRJ-053.2](./PRJ.md#REQ-PRJ-053) `未实现` | 同上：行内确认（RetainedVolumesPanel.view.tsx:155-183）（稿件 f-prj-retained-02） | — | 回到列表，焦点回到那一行的 [删除] | f-prj-retained-02 |
| [AC-PRJ-053.4](./PRJ.md#REQ-PRJ-053) `部分实现` | 列表与项目详情同一个查询（useRetainedVolumes.ts:73-79）；系统状态的占用走资源接口，要等下一次轮询（REQ-SYS-010） | useRetainedVolumes.ts:73-79 | 该行消失、合计更新；项目详情的「已保留成果」与系统状态的成果占用随之更新 | f-prj-retained-02 |
| [AC-PRJ-054.2](./PRJ.md#REQ-PRJ-054) `部分实现` | 有失败句「网络不通，请稍后再试。」（useRetainedVolumes.ts:36），没有 [重试]（RetainedVolumesPanel.view.tsx:74-78）（稿件 f-prj-retained-04） | useRetainedVolumes.ts:36、RetainedVolumesPanel.view.tsx:74-78 | 失败提示「没能读出保留下来的成果」+「网络不通。」+ [重试]；没有空态 | f-prj-retained-03、f-prj-retained-04 |
| [AC-PRJ-054.3](./PRJ.md#REQ-PRJ-054) `未实现` | （还没有做；片段没写细节，见需求正文） | — | 重新请求，按钮转圈禁用；成功后显示列表或空态 | f-prj-retained-03、f-prj-retained-04 |
| [AC-PRJ-056.1](./PRJ.md#REQ-PRJ-056) `未实现` | 按钮没接（DR-27），前端只有按项目的查询（useRetainedVolumes.ts:64-69）（稿件 f-prj-retained-05） | useRetainedVolumes.ts:64-69 | 跨项目视图：副标题「全部项目」，合计「共 3 个 · 占用 4.2 GB · 全部下载 1.1 GB」，两组：示例项目「2 个 · 占用 3.7 GB」、acme-web「1 个 · 占用 512 MB」 | f-prj-retained-05 |
| [AC-PRJ-056.2](./PRJ.md#REQ-PRJ-056) `未实现` | （还没有做；片段没写细节，见需求正文） | — | 只剩 acme-web 一组，合计随之变，副标题「在 acme-web 中」 | f-prj-retained-05 |
| [AC-PRJ-056.3](./PRJ.md#REQ-PRJ-056) `未实现` | （还没有做；片段没写细节，见需求正文） | — | 该组消失，合计更新；系统状态的成果占用随之更新 | f-prj-retained-05 |

### 前端 · LCH（41）

| AC | 差在哪 | 出处 | 建议修法（目标行为） | 稿件 |
|---|---|---|---|---|
| [AC-LCH-001.1](./LCH.md#REQ-LCH-001) `部分实现` | 入口在侧栏底部 [＋ 新任务]（WorkbenchShell.view.tsx:575–584），副标题已实现（SandboxTerminalContainer.tsx:432–434）；v2 顶栏入口、总览入口、⌘K 未实现（稿件 f-lch-form-01） | WorkbenchShell.view.tsx:575–584、SandboxTerminalContainer.tsx:432–434 | 弹层打开，项目 = acme-web，副标题「在「acme-web」中发起」，主按钮因未选 Agent 不可发起 | f-lch-form-01 |
| [AC-LCH-001.2](./LCH.md#REQ-LCH-001) `未实现` | 弹层没有项目字段，归属继承左侧树选中项（SandboxTerminalContainer.tsx:67–75），Q-DS-29 A 带来的前端新增（稿件 f-lch-form-01） | SandboxTerminalContainer.tsx:67–75 | 列出全部项目、顺序同树；acme-api「（克隆失败）」、infra-scripts「（克隆中）」置灰不可选；没有「＋ 新建项目…」 | f-lch-form-01 |
| [AC-LCH-001.3](./LCH.md#REQ-LCH-001) `未实现` | 同上：弹层没有项目字段，归属继承左侧树选中项（SandboxTerminalContainer.tsx:67–75），Q-DS-29 A 带来的前端新增（稿件 f-lch-form-01） | — | 副标题与引导句变成「在「docs-site」中发起」；codex、ml-agent 与指令保留；分支回到默认、选项换成 docs-site 的 | f-lch-form-01 |
| [AC-LCH-001.4](./LCH.md#REQ-LCH-001) `偏离` | 空组按钮对任何 0 任务的组都渲染、不看就绪（WorkbenchShell.view.tsx:495–521），对未就绪项目点了会进入幽灵态（见本片「待核实」1） | WorkbenchShell.view.tsx:495–521 | 只有 docs-site 出「发起第一个任务」，点了打开弹层并预选 docs-site | f-lch-form-01 |
| [AC-LCH-001.5](./LCH.md#REQ-LCH-001) `偏离` | 原生 `disabled`，Tab 到不了、不说原因（NewSandboxPanel.view.tsx:478–485） | NewSandboxPanel.view.tsx:478–485 | 主按钮能聚焦，读屏念出原因，按下不发请求 | f-lch-form-01 |
| [AC-LCH-002.4](./LCH.md#REQ-LCH-002) `偏离` | 「Agent（runtime）· 必选」（NewSandboxPanel.view.tsx:219） | NewSandboxPanel.view.tsx:219 | 「Agent · 必选」 | f-lch-form-01、f-lch-form-02 |
| [AC-LCH-004.4](./LCH.md#REQ-LCH-004) `未实现` | 弹层没有镜像字段（NewSandboxPanel.view.tsx），`useImages(runtimeId)` 没有消费方（useImages.ts）（稿件 f-lch-form-01、10） | NewSandboxPanel.view.tsx、useImages.ts | 「平台预制镜像（默认）」已选中；ml-agent 可选，选项后补「（没有预装 claude-code，启动会明显变慢）」；just-registered 写「（无效：不符合平台约定）」、置灰不可选；列表底「置灰的镜像不能选：到「镜像管理」里处理好再回来。」；把 ml-agent 禁用后再打开，它写「（已禁用）」、置灰；没有「注册新镜像」；空项目里这一栏同样在 | f-lch-form-01、f-lch-form-05、f-lch-form-07、f-lch-form-10 |
| [AC-LCH-004.6](./LCH.md#REQ-LCH-004) `未实现` | 请求体不带 image（SandboxTerminalContainer.tsx:318–330）；后端已有：创建请求可带 image，门口按版本行 id 或坐标解析 | SandboxTerminalContainer.tsx:318–330 | 请求体带 `image` = 这张镜像；受理后任务锁定它当时的当前版本（REQ-IMG-025）；弹层开着期间它换了版本也照常受理 | f-lch-form-01、f-lch-form-05、f-lch-form-07、f-lch-form-10 |
| [AC-LCH-004.7](./LCH.md#REQ-LCH-004) `未实现` | 同 AC-LCH-004.4 | — | 下拉只剩默认项，下面一句「镜像列表暂时取不到，这次会用平台预制镜像。」（`role="status"`）；主按钮照常可用 | f-lch-form-01、f-lch-form-05、f-lch-form-07、f-lch-form-10 |
| [AC-LCH-004.8](./LCH.md#REQ-LCH-004) `未实现` | 要点了发起才被门口拒（IMAGE_NOT_REGISTERED，sandboxErrorCopy.ts:193–200） | sandboxErrorCopy.ts:193–200 | 默认项「平台预制镜像（已禁用）」+ 字段下那句说明；主按钮不可发起并指向它；改选 ml-agent 后可发起 | f-lch-form-01、f-lch-form-05、f-lch-form-07、f-lch-form-10 |
| [AC-LCH-004.9](./LCH.md#REQ-LCH-004) `偏离` | INVALID_IMAGE_REFERENCE 的前端句是「镜像地址里混进了空白或控制字符」（sandboxErrorCopy.ts:201–207），而门口对已停用、验证没通过的版本回的也是这个码 | sandboxErrorCopy.ts:201–207 | 琥珀门口拒绝「无法用当前配置创建：这张镜像现在不能被新任务选用（…）。请改选一张镜像后再试（本次请求未创建任何任务）。」；不给重试；不出现「空白或控制字符」 | f-lch-form-01、f-lch-form-05、f-lch-form-07、f-lch-form-10 |
| [AC-LCH-005.3](./LCH.md#REQ-LCH-005) `部分实现` | 提交前 `trim()`（SandboxTerminalContainer.tsx:314），计数按未 trim 的原文（NewSandboxPanel.view.tsx:179），会出现「显示超限、实际不超」而按钮被禁 | SandboxTerminalContainer.tsx:314、NewSandboxPanel.view.tsx:179 | 计数与提交口径一致（都按去空白后的 7990），可发起 | f-lch-form-02、f-lch-form-03 |
| [AC-LCH-006.1](./LCH.md#REQ-LCH-006) `部分实现` | 骨架与 `aria-label` 已有（NewSandboxPanel.view.tsx:221–231、:309–316），但骨架是只挂 `aria-label` 的 `span`/`div`，没有 role（UX-DS-509）（稿件 f-lch-form-04） | NewSandboxPanel.view.tsx:221–231 | Agent 两行骨架、沙箱环境一条骨架，各带 `role="status"` 与 `aria-label`；指令框可写；主按钮不可发起、不写原因 | f-lch-form-04、f-lch-form-05 |
| [AC-LCH-006.2](./LCH.md#REQ-LCH-006) `偏离` | 句子是「Agent 列表加载失败：{error.message}」，原因直接取请求错误的原串、缺省「请求失败」（NewSandboxPanel.view.tsx:233–247、:318–332，SandboxTerminalContainer.tsx:446–458）（稿件 f-lch-form-05） | NewSandboxPanel.view.tsx:233–247、SandboxTerminalContainer.tsx:446–458 | 两条失败提示（`role="alert"`）「Agent 列表没读出来：网络请求失败。」+ [重试加载 Agent]、「没能确认这台机器的沙箱环境：网络请求失败。」+ [重试]；分支照常 | f-lch-form-04、f-lch-form-05 |
| [AC-LCH-007.1](./LCH.md#REQ-LCH-007) `偏离` | 建议句是「停掉几个不用的任务把资源让出来，或者过一会儿再试。」（sandboxErrorCopy.ts:355–358，与 DR-03 矛盾）；指令提交前已清空、不回填（SandboxTerminalContainer.tsx:316–317）（稿件 f-lch-form-06） | sandboxErrorCopy.ts:355–358、SandboxTerminalContainer.tsx:316–317 | 弹层留着；红色「这台机器能同时登记的任务已满（8 / 8）—— …还能再发几个。」；指令回填（236/8000）；主按钮可用 | f-lch-form-06、f-lch-form-07 |
| [AC-LCH-007.2](./LCH.md#REQ-LCH-007) `偏离` | 原因位直接拼后端原串「project <id> has no branch 'feat/login-refresh'」，去处是通用的「请调整配置后再试」（sandboxErrorCopy.ts:472–479，project-facade.adapter.ts:81–84）；指令不回填（稿件 f-lch-form-07） | sandboxErrorCopy.ts:472–479、project-facade.adapter.ts:81–84 | 琥珀「无法用当前配置创建：项目里没有这个分支（…）。请改选一个列表里有的分支后再试（本次请求未创建任何任务）。」；没有任何重试入口；指令回填 | f-lch-form-06、f-lch-form-07 |
| [AC-LCH-007.4](./LCH.md#REQ-LCH-007) `偏离` | 兜底把后端 message 当建议位（sandboxErrorCopy.ts:488–498） | sandboxErrorCopy.ts:488–498 | 兜底句「操作没有完成 —— 未能获取具体原因，…」，不出现那句英文 | f-lch-form-06、f-lch-form-07 |
| [AC-LCH-007.6](./LCH.md#REQ-LCH-007) `部分实现` | 前端表七条齐（sandboxErrorCopy.ts:98–216），P22 §1.1 只列了六条 | sandboxErrorCopy.ts:98–216 | 七条门口拒绝都有中文原因与去处，BRANCH_NOT_FOUND 在两边都有 | f-lch-form-06、f-lch-form-07 |
| [AC-LCH-008.1](./LCH.md#REQ-LCH-008) `偏离` | 句子仍是「…改发无头任务就可以——…」，按钮是原生 `disabled`（SandboxTerminalContainer.tsx:482–486，NewSandboxPanel.view.tsx:482） | SandboxTerminalContainer.tsx:482–486、NewSandboxPanel.view.tsx:482 | 琥珀提示（上句，没有「无头」字样）；主按钮不可发起且指向这句 | f-lch-form-08 |
| [AC-LCH-009.1](./LCH.md#REQ-LCH-009) `部分实现` | 弹层、项目上下文与那句已实现（useDeepLinkModal.ts:102–119，SandboxTerminalContainer.tsx:501–504，NewSandboxPanel.view.tsx:414–424；F21-2 e2e ⑥）；「项目」字段未实现（Q-DS-29）（稿件 f-lch-form-09） | useDeepLinkModal.ts:102–119、SandboxTerminalContainer.tsx:501–504、NewSandboxPanel.view.tsx:414–424 | 弹层打开、「项目」= acme-web；框下「刷新后指令未保留，请重新输入」（`role="status"`）；Agent 未选 | f-lch-form-09 |
| [AC-LCH-009.3](./LCH.md#REQ-LCH-009) `部分实现` | 不开弹层、抹参数已实现（useDeepLinkModal.ts:110–111、:136–141）；静默，不回总览、不说一句 | useDeepLinkModal.ts:110–111 | 不开弹层；回落项目总览，顶部「找不到项目「…」：可能已被删除。」；参数被去掉 | f-lch-form-09 |
| [AC-LCH-009.4](./LCH.md#REQ-LCH-009) `部分实现` | 选中且不开弹层（useDeepLinkModal.ts:112–117），没有那句说明 | useDeepLinkModal.ts:112–117 | 不开弹层；选中 infra-scripts；主区顶部说明还不能发起（`role="status"`）；参数被去掉 | f-lch-form-09 |
| [AC-LCH-010.1](./LCH.md#REQ-LCH-010) `部分实现` | 禁用与「创建中…」已实现（NewSandboxPanel.view.tsx:217、:365、:397、:470、:482–484，SandboxTerminalContainer.tsx:520）；按钮没有转圈；「项目」字段未实现（稿件 f-lch-startup-02） | NewSandboxPanel.view.tsx:217、SandboxTerminalContainer.tsx:520 | 字段、[取消]、关闭全部禁用；主按钮转圈 +「创建中…」禁用；指令框为空 | f-lch-startup-02 |
| [AC-LCH-011.1](./LCH.md#REQ-LCH-011) `部分实现` | 受理后任务进列表并被选中（SandboxTerminalContainer.tsx:332–349）；树点只有两色，准备中显示成绿点「运行中」，副行不写阶段（WorkbenchShell.view.tsx:539–564）（稿件 f-lch-startup-03） | SandboxTerminalContainer.tsx:332–349、WorkbenchShell.view.tsx:539–564 | acme-web 组首行出现该任务、为当前项；灰脉冲点（`aria-label`「准备中」）；副行「准备中 · 初始化」；顶栏徽标「准备中」 | f-lch-startup-03、f-lch-startup-01 |
| [AC-LCH-011.2](./LCH.md#REQ-LCH-011) `部分实现` | 「准备中」档已按 pending…starting 过滤（WorkbenchShell.view.tsx:31、:40）；「可能卡住」未实现 | WorkbenchShell.view.tsx:31 | 两个都在；筛空时「没有准备中的任务」 | f-lch-startup-03、f-lch-startup-01 |
| [AC-LCH-012.3](./LCH.md#REQ-LCH-012) `偏离` | 用词是「拉到本机」「下载并铺开运行环境」，就绪后「正在启动 agent」（instanceStartupCopy.ts:36、:40、:77）（稿件 f-lch-startup-04） | instanceStartupCopy.ts:36 | 副标题与格下说明按上文（「下载到本机」） | f-lch-startup-03、f-lch-startup-04 |
| [AC-LCH-013.1](./LCH.md#REQ-LCH-013) `未实现` | 进度卡没有提示也没有出口（SandboxStartupProgress.view.tsx 无回调）（稿件 f-lch-startup-05） | SandboxStartupProgress.view.tsx | 卡内琥珀提示「可能卡住了：已 6:40 没有新进展」+ 说明 + [取消并删除…][继续等待]；进行中的点不变色；不出现阈值数字 | f-lch-startup-05、f-lch-startup-01 |
| [AC-LCH-013.2](./LCH.md#REQ-LCH-013) `未实现` | 树点只有两色（WorkbenchShell.view.tsx:539–542） | WorkbenchShell.view.tsx:539–542 | 树点琥珀（`aria-label`「可能卡住」）、副行「可能卡住 · 6:40 无进展」；顶栏徽标「可能卡住」 | f-lch-startup-05、f-lch-startup-01 |
| [AC-LCH-013.3](./LCH.md#REQ-LCH-013) `未实现` | （还没有做；片段没写细节，见需求正文） | — | 提示收起，计时从此刻重来，树点回到准备中 | f-lch-startup-05、f-lch-startup-01 |
| [AC-LCH-013.4](./LCH.md#REQ-LCH-013) `未实现` | 整条未实现；语义沿用 P22 L69 | — | 不判卡住 | f-lch-startup-05、f-lch-startup-01 |
| [AC-LCH-013.5](./LCH.md#REQ-LCH-013) `未实现` | 总览与 ⌘K 是 v2 新增，Q-DS-27 A / Q-DS-28 A | — | 出现在「需要你处理」（异常之后、等待你输入之前）；导航徽标不数它 | f-lch-startup-05、f-lch-startup-01 |
| [AC-LCH-014.1](./LCH.md#REQ-LCH-014) `未实现` | web 没有任何入口（稿件 f-lch-startup-06） | — | 出上面那张确认；初始焦点在 [取消]；「代码副本怎么处理」只写「一起删掉，不留成果」，没有「留下来」的选项 | f-lch-startup-06 |
| [AC-LCH-014.3](./LCH.md#REQ-LCH-014) `未实现` | 随 REQ-SBX-020 | — | 树行进入「删除中…」后移除，主区离开该任务；系统状态「还能再发」+1 | f-lch-startup-06 |
| [AC-LCH-014.4](./LCH.md#REQ-LCH-014) `未实现` | web 没有任何入口（稿件 f-lch-startup-06 只画了首次启动） | — | 「代码副本怎么处理」二选一，默认选中「留下来作为成果」；确认后以留下来的方式删除（`keepVolume: true`），这一份出现在「保留下来的成果」里 | f-lch-startup-06 |
| [AC-LCH-015.1](./LCH.md#REQ-LCH-015) `部分实现` | 主区换终端已实现（sandboxLifecycle.ts:82，SandboxLifecycleContainer）；树点本来就一直是绿（两色），徽标是 v2 新增 | sandboxLifecycle.ts:82 | 主区换终端并自动连上；树点绿；顶栏徽标「运行中」 | P1、f-sbx-relaunch-01、f-sbx-relaunch-02 |
| [AC-LCH-015.2](./LCH.md#REQ-LCH-015) `部分实现` | 结果卡已有（SandboxLifecycleContainer.tsx:100–127）；树点与副行未实现（WorkbenchShell.view.tsx:539–564）；按钮语义见 DR-16 | SandboxLifecycleContainer.tsx:100–127、WorkbenchShell.view.tsx:539–564 | 主区异常结果卡；树点红 + 副行「启动失败：没能把镜像拉下来」；结果卡细则见 REQ-SBX-001 | P1、f-sbx-relaunch-01、f-sbx-relaunch-02 |
| [AC-LCH-016.2](./LCH.md#REQ-LCH-016) `未实现` | 卡住整条未实现 | — | 从刷新那一刻起算，满阈值出卡住提示，提示里的时长按刷新后的算 | 无单独稿 |
| [AC-LCH-017.2](./LCH.md#REQ-LCH-017) `未实现` | 进度卡不写镜像（SandboxStartupProgress.view.tsx）（稿件 f-lch-startup-03 随拍板补画） | SandboxStartupProgress.view.tsx | 标题之后一行「镜像：docker.io/acme/ml-agent:v1.0」；用平台预制镜像的任务写「镜像：ghcr.io/agent-infra/sandbox:latest（平台预制镜像）」；这一行不进播报 | f-lch-startup-03、f-lch-startup-04、f-lch-startup-05、f-sbx-rel… |
| [AC-LCH-017.3](./LCH.md#REQ-LCH-017) `未实现` | 结果卡只有标题与主语行（SandboxOutcome.view.tsx:106–118）（稿件 f-sbx-relaunch-01、02） | SandboxOutcome.view.tsx:106–118 | 主语行之后「镜像：ghcr.io/agent-infra/sandbox:latest（平台预制镜像）」；超时卡、已停止卡同样有这一行 | f-lch-startup-03、f-lch-startup-04、f-lch-startup-05、f-sbx-rel… |
| [AC-LCH-017.4](./LCH.md#REQ-LCH-017) `未实现` | 拼的几行里没有镜像（SandboxOutcome.view.tsx:59–76） | SandboxOutcome.view.tsx:59–76 | 复制文本「任务：」之后一行「镜像：ghcr.io/agent-infra/sandbox:latest@sha256:…」 | f-lch-startup-03、f-lch-startup-04、f-lch-startup-05、f-sbx-rel… |
| [AC-LCH-017.5](./LCH.md#REQ-LCH-017) `未实现` | 任务行还没有菜单（REQ-SBX-010），只读详情不写镜像（HeadlessTaskDetail.view.tsx） | HeadlessTaskDetail.view.tsx | 菜单最上面一行只读「镜像：…」（不可点、不进 Tab 顺序）；只读详情里同一行 | f-lch-startup-03、f-lch-startup-04、f-lch-startup-05、f-sbx-rel… |

### 前端 · SBX（50）

| AC | 差在哪 | 出处 | 建议修法（目标行为） | 稿件 |
|---|---|---|---|---|
| [AC-SBX-001.1](./SBX.md#REQ-SBX-001) `偏离` | 主语行在标题上方、没有图标框与诊断码行、按钮叫 [重试]（SandboxOutcome.view.tsx:106-118，sandboxErrorCopy.ts:267-272）；建议里「镜像仓库」按 Q-DS-21 A 改「镜像下载源」（稿件 f-sbx-relaunch-01） | SandboxOutcome.view.tsx:106-118、sandboxErrorCopy.ts:267-272 | 依次出现：圆叉图标框、标题「没能把镜像拉下来（网络不通，或者镜像名写错了）」（失败色）、「任务：迁移构建脚本」、建议、等宽细节、[重新发起][检查镜像地址][复制诊断信息]、「诊断码：IMAGE_PULL_FAILED」；标题与建议里没有码 | f-sbx-relaunch-01、f-sbx-stopstart-04 |
| [AC-SBX-001.2](./SBX.md#REQ-SBX-001) `部分实现` | 兜底已有（sandboxErrorCopy.ts:480-498），动作名是 [重试] / [返回重新配置]，诊断码不上屏 | sandboxErrorCopy.ts:480-498 | 标题「操作没有完成」；建议为后端原话或兜底句；有一个可点动作；诊断码行显示该码 | f-sbx-relaunch-01、f-sbx-stopstart-04 |
| [AC-SBX-001.3](./SBX.md#REQ-SBX-001) `未实现` | 现状把缺码记作 UNKNOWN 放进复制文本（sandboxErrorCopy.ts:534-538） | sandboxErrorCopy.ts:534-538 | 出兜底卡；不出现「诊断码：」行，也不出现「UNKNOWN」 | f-sbx-relaunch-01、f-sbx-stopstart-04 |
| [AC-SBX-001.4](./SBX.md#REQ-SBX-001) `部分实现` | toDisplayStatus failed → error（sandboxLifecycle.ts:121-140）；副行短原因随 DR-31 | sandboxLifecycle.ts:121-140 | 红点（aria-label「异常」）+ 副行人话原因；顶栏徽标「异常」 | f-sbx-relaunch-01、f-sbx-stopstart-04 |
| [AC-SBX-001.5](./SBX.md#REQ-SBX-001) `未实现` | 文案表 PROVIDER_UNAVAILABLE 只有 [重试]、建议句只说 Docker Desktop / OrbStack（sandboxErrorCopy.ts:371-377），DISK_INSUFFICIENT 只有 [清理磁盘后重试]（sandboxErrorCopy.ts:235-244）；结果卡没有去系统状态的动作 | sandboxErrorCopy.ts:371-377、sandboxErrorCopy.ts:235-244 | 两张卡都有 [运行诊断]（在 [复制诊断信息] 之前）；点它跳到「系统状态」并自动开始一轮诊断；PROVIDER_UNAVAILABLE 的建议句不只点名 Docker / OrbStack | f-sbx-relaunch-01、f-sbx-stopstart-04 |
| [AC-SBX-002.1](./SBX.md#REQ-SBX-002) `部分实现` | 时钟图标已有（outcome-icon.tsx:21）；标题没有前缀、是红字（SandboxOutcome.view.tsx:114）；时长目前没有数据来源（待定 Q-SBX-01；稿件 f-sbx-relaunch-02 用 v1 的示例值 600） | outcome-icon.tsx:21、SandboxOutcome.view.tsx:114 | 时钟图标框；标题「超时未响应：这一步等太久，平台先停下了」为超时色（不是失败红）；建议首句说「在限定时间内没有等到应答」（拿得到时长才写秒数） | f-sbx-relaunch-02 |
| [AC-SBX-002.2](./SBX.md#REQ-SBX-002) `部分实现` | 动作只有 [重试]（sandboxErrorCopy.ts:387），诊断码不上屏 | sandboxErrorCopy.ts:387 | [重新发起][复制诊断信息]；没有 [强制停止]；「诊断码：TIMEOUT」 | f-sbx-relaunch-02 |
| [AC-SBX-002.3](./SBX.md#REQ-SBX-002) `部分实现` | 红点已有，副行超时色未实现 | — | 红点（aria-label「异常」）+ 副行超时色「超时未响应：这一步等太久，平台先停下了」 | f-sbx-relaunch-02 |
| [AC-SBX-003.1](./SBX.md#REQ-SBX-003) `未实现` | handleRetry 只清选中（SandboxTerminalContainer.tsx:373-378）；稿件 f-sbx-relaunch-03 | SandboxTerminalContainer.tsx:373-378 | 新建任务弹层打开：项目 = acme-web、Agent = codex、镜像 = 原任务用的那张（这里是平台预制镜像）、顶部来源说明；分支停在默认 + 一句说明；指令框为空 + 一句说明；[发起任务并打开终端] 可用 | f-sbx-relaunch-03 |
| [AC-SBX-003.2](./SBX.md#REQ-SBX-003) `未实现` | （还没有做；片段没写细节，见需求正文） | — | 新任务进树（准备中）并成为当前任务；「迁移构建脚本」仍在树上、仍是异常 | f-sbx-relaunch-03 |
| [AC-SBX-003.3](./SBX.md#REQ-SBX-003) `未实现` | 现状主区落到「「acme-web」下还没有任务。」（SandboxTerminalContainer.tsx:531-543） | SandboxTerminalContainer.tsx:531-543 | 弹层关闭，焦点回到 [重新发起]，主区仍是原任务的结果卡 | f-sbx-relaunch-03 |
| [AC-SBX-003.4](./SBX.md#REQ-SBX-003) `未实现` | （还没有做；片段没写细节，见需求正文） | — | Agent 仍预选 claude-code，弹层按凭证闸门拦住发起；不改选别的 Agent | f-sbx-relaunch-03 |
| [AC-SBX-003.5](./SBX.md#REQ-SBX-003) `未实现` | handleRetry 只清选中（SandboxTerminalContainer.tsx:373-378），弹层也没有镜像字段；SandboxDto 契约里没有镜像（AC-LCH-017.1） | SandboxTerminalContainer.tsx:373-378 | 「镜像」预选 ml-agent（置灰、写「（已禁用）」）+ 说明句；主按钮不可发起并指向它；改选平台预制镜像后可发起（另需契约配合） | f-sbx-relaunch-03 |
| [AC-SBX-004.1](./SBX.md#REQ-SBX-004) `未实现` | reconfigure 与 retry 是同一个 handler（SandboxLifecycleContainer.tsx:107-111）；稿件 f-sbx-relaunch-04 | SandboxLifecycleContainer.tsx:107-111 | 跳到镜像管理；内容顶部来源提示（标题含任务名与「没能把镜像拉下来」）；平台预制镜像卡（这个任务用的那张）被定位、带徽标「「迁移构建脚本」用的镜像」 | f-sbx-relaunch-04 |
| [AC-SBX-004.2](./SBX.md#REQ-SBX-004) `未实现` | （还没有做；片段没写细节，见需求正文） | — | 回到工作台并选中该任务（结果卡）；回到镜像管理时提示不再出现 | f-sbx-relaunch-04 |
| [AC-SBX-004.3](./SBX.md#REQ-SBX-004) `未实现` | （还没有做；片段没写细节，见需求正文） | — | 提示消失，焦点落到工具行的搜索框；页面其余不变 | f-sbx-relaunch-04 |
| [AC-SBX-004.4](./SBX.md#REQ-SBX-004) `未实现` | （还没有做；片段没写细节，见需求正文） | — | 镜像类 → 镜像管理；UNKNOWN_RUNTIME / WORKSPACE_PREPARE_FAILED / 兜底 → 重新发起弹层；AUTH_REJECTED → 凭证管理 | f-sbx-relaunch-04 |
| [AC-SBX-004.5](./SBX.md#REQ-SBX-004) `未实现` | 去处还没接（SandboxLifecycleContainer.tsx:107-111）；SandboxDto 契约里没有镜像（AC-LCH-017.1） | SandboxLifecycleContainer.tsx:107-111 | 镜像管理里定位的是 ml-agent 卡（带徽标「「X」用的镜像」），不是平台预制镜像卡（另需契约配合） | f-sbx-relaunch-04 |
| [AC-SBX-005.2](./SBX.md#REQ-SBX-005) `部分实现` | 写入被拒那一支已实现（SandboxLifecycleContainer.tsx:70-72）；`navigator.clipboard` 不存在（非 HTTPS 部署）时 `writeText` 同步抛 TypeError，失败轻提示出不来（:67；同 AC-WB-063.4，合并时据代码更正） | SandboxLifecycleContainer.tsx:70-72 | 失败轻提示「复制失败，请手动选中下面的失败细节复制」（role="alert"）；失败细节块仍可选中复制 | f-sbx-relaunch-01 |
| [AC-SBX-010.1](./SBX.md#REQ-SBX-010) `未实现` | 任务行没有菜单（v1 g2-08 核实），sandbox.service.ts 没有 stop | sandbox.service.ts | 有 [停止] 与 [销毁任务…]，没有 [启动] | f-sbx-stopstart-01 |
| [AC-SBX-010.2](./SBX.md#REQ-SBX-010) `未实现` | （还没有做；片段没写细节，见需求正文） | — | 不弹确认，直接进入停止中（REQ-SBX-011）；发出 POST /api/sandboxes/{id}/stop | f-sbx-stopstart-01 |
| [AC-SBX-010.4](./SBX.md#REQ-SBX-010) `未实现` | （还没有做；片段没写细节，见需求正文） | — | 导航「等待你输入」徽标减 1；项目总览「需要你处理」不再列它 | f-sbx-stopstart-01 |
| [AC-SBX-011.1](./SBX.md#REQ-SBX-011) `未实现` | web 把 stopping 直接显示成「任务已停止」卡（sandboxLifecycle.ts:76、84）；稿件 f-sbx-stopstart-01 | sandboxLifecycle.ts:76、84 | 树行灰方块 +「停止中…」；终端栏下「正在停止…」连接条；在终端里打字没有任何回显 | f-sbx-stopstart-01 |
| [AC-SBX-011.2](./SBX.md#REQ-SBX-011) `未实现` | （还没有做；片段没写细节，见需求正文） | — | [新终端] 不开菜单并说出原因；菜单里 [启动] 禁用 | f-sbx-stopstart-01 |
| [AC-SBX-011.3](./SBX.md#REQ-SBX-011) `未实现` | （还没有做；片段没写细节，见需求正文） | — | 主区换成「任务已停止」卡，树副行变「已停止」 | f-sbx-stopstart-01 |
| [AC-SBX-012.1](./SBX.md#REQ-SBX-012) `偏离` | 「运行环境已经回收了」+ 只有 [发起新任务]（sandboxErrorCopy.ts:509-517）；稿件 f-sbx-stopstart-02 | sandboxErrorCopy.ts:509-517 | 卡片文字与按钮同上；没有「回收」「还需 N 天」；没有诊断码行 | f-sbx-stopstart-02 |
| [AC-SBX-012.2](./SBX.md#REQ-SBX-012) `部分实现` | toDisplayStatus → stopped（sandboxLifecycle.ts:131-134）；灰方块原语随 Q-DS-15 | sandboxLifecycle.ts:131-134 | 灰方块（aria-label「已停止」）+ 副行「已停止」 | f-sbx-stopstart-02 |
| [AC-SBX-012.3](./SBX.md#REQ-SBX-012) `部分实现` | 现状回到新建入口前先清掉选中（DR-16） | — | 新建任务弹层打开、预选该项目、Agent 未选；已停止任务仍在、仍选中 | f-sbx-stopstart-02 |
| [AC-SBX-013.1](./SBX.md#REQ-SBX-013) `未实现` | web 没有启动入口；稿件 f-sbx-stopstart-03 | — | 发出 POST /api/sandboxes/{id}/start；树行灰脉冲点 +「准备中 · 启动运行环境」；主区进度卡前三格「沿用」、第 4 格进行中、进度 80% | f-sbx-stopstart-03 |
| [AC-SBX-013.2](./SBX.md#REQ-SBX-013) `未实现` | web；后端已实现：provision-sandbox.workflow.ts:700-707 | provision-sandbox.workflow.ts:700-707 | 回到终端，Agent 会话是新的；原来的指令没有再执行 | f-sbx-stopstart-03 |
| [AC-SBX-013.3](./SBX.md#REQ-SBX-013) `未实现` | web；后端：provision-sandbox.workflow.ts:322-324（imageStagedOf：停机期间镜像可能已被回收） | provision-sandbox.workflow.ts:322-324 | 进度停在「启动运行环境」格，阶段说明为下载子文案，不回退到「拉取镜像」 | f-sbx-stopstart-03 |
| [AC-SBX-013.4](./SBX.md#REQ-SBX-013) `未实现` | 后端只接受 stopped（sandbox-application.service.ts:548-553） | sandbox-application.service.ts:548-553 | 停止中 [启动] 禁用；异常与运行中没有 [启动] | f-sbx-stopstart-03 |
| [AC-SBX-014.1](./SBX.md#REQ-SBX-014) `未实现` | web 没有启动入口；后端已写码：provision-sandbox.workflow.ts:331-336；稿件 f-sbx-stopstart-04 | provision-sandbox.workflow.ts:331-336 | 树行红点 +「启动失败：容器服务没有响应」；主区卡标题「容器服务没有响应」、[重新发起][运行诊断][复制诊断信息]、附注、「诊断码：PROVIDER_UNAVAILABLE」 | f-sbx-stopstart-04 |
| [AC-SBX-014.2](./SBX.md#REQ-SBX-014) `未实现` | （还没有做；片段没写细节，见需求正文） | — | 同一张卡，副行「停止失败：…」，附注首句「这次是在 [停止] 时失败的」；错误码取自这次响应 | f-sbx-stopstart-04 |
| [AC-SBX-015.1](./SBX.md#REQ-SBX-015) `部分实现` | 文案已有（sandboxErrorCopy.ts:389-394），web 没有停止调用 | sandboxErrorCopy.ts:389-394 | 409；中性轻提示；重新拉取后显示已停止卡；没有变成异常 | — |
| [AC-SBX-015.2](./SBX.md#REQ-SBX-015) `部分实现` | 同上：文案已有（sandboxErrorCopy.ts:389-394），web 没有停止调用 | — | 409；同上提示；显示停止中 / 已停止的真实状态 | — |
| [AC-SBX-020.1](./SBX.md#REQ-SBX-020) `未实现` | web 没有销毁入口，destroying 显示成「已停止」（sandboxLifecycle.ts:76、131-134）；稿件 f-sbx-destroy-01 | sandboxLifecycle.ts:76、131-134 | 树行立刻淡出点 + 半透明 +「删除中…」；菜单只剩禁用的「删除中…」 | f-sbx-destroy-01 |
| [AC-SBX-020.2](./SBX.md#REQ-SBX-020) `部分实现` | 后端事件已有（sandbox-event.projector）；web 没有删除流程 | — | 行移除；树组计数减 1；⌘K 搜不到它 | f-sbx-destroy-01 |
| [AC-SBX-020.3](./SBX.md#REQ-SBX-020) `未实现` | （还没有做；片段没写细节，见需求正文） | — | 「等待你输入」徽标与「需要你处理」立刻不再算它 | f-sbx-destroy-01 |
| [AC-SBX-021.1](./SBX.md#REQ-SBX-021) `未实现` | web；原型已有完成态（proto.js destroyTask）；稿件 f-sbx-destroy-01 | proto.js | 主区回到项目总览；顶部「正在销毁任务「迁移构建脚本」…」；完成后「已销毁任务「迁移构建脚本」」+「代码副本一起删掉了（没有成果可留）。」+ × | f-sbx-destroy-01 |
| [AC-SBX-021.2](./SBX.md#REQ-SBX-021) `未实现` | （还没有做；片段没写细节，见需求正文） | — | 当前页不变；完成提示叠在主区右上角 | f-sbx-destroy-01 |
| [AC-SBX-021.3](./SBX.md#REQ-SBX-021) `未实现` | 归 REQ-WB-040，AC-WB-040.1 | — | 回落项目总览 +「找不到任务「迁移构建脚本」：可能已被销毁。」 | f-sbx-destroy-01 |
| [AC-SBX-022.1](./SBX.md#REQ-SBX-022) `未实现` | web；后端落 failed 但不写 failureCode（sandbox-application.service.ts:767-772） | sandbox-application.service.ts:767-772 | 任务转异常（红点、「删除失败：…」）；名额已释放；主区异常卡带 [销毁任务…][复制诊断信息]（另需后端配合） | f-sbx-destroy-02、f-sbx-destroy-03 |
| [AC-SBX-022.3](./SBX.md#REQ-SBX-022) `未实现` | web；原型已按稿件 f-sbx-destroy-02 演示（场景「下一次销毁：失败」） | — | 总览顶部那条「正在销毁…」换成「没能销毁任务「跑一遍示例测试」」+ 原因与去处一句 + ×；树行红点 +「删除失败：容器服务没有响应」；点开它是 AC-SBX-022.1 的结果卡 | f-sbx-destroy-02、f-sbx-destroy-03 |
| [AC-SBX-022.2](./SBX.md#REQ-SBX-022) `未实现` | web；试点 P4 与原型已是这样 | — | 只有「留下来作为成果（默认；30 天后自动清理，可在「保留下来的成果」里下载）」与「一起删掉，不留成果」，没有天数选择 | f-sbx-destroy-02、f-sbx-destroy-03 |
| [AC-SBX-022.4](./SBX.md#REQ-SBX-022) `未实现` | web 没有销毁界面；后端已有：keepVolume 对异常任务同样生效（sandbox-application.service.ts:720-760），原型已按此演示（稿件 f-sbx-destroy-03） | sandbox-application.service.ts:720-760 | 前者「代码副本怎么处理」二选一、默认选中「留下来作为成果」；后者只写「一起删掉（没有成果可留）」、没有选项 | f-sbx-destroy-02、f-sbx-destroy-03 |
| [AC-SBX-031.1](./SBX.md#REQ-SBX-031) `偏离` | 上半终端标签、下半输出面板（SandboxLifecycleContainer.tsx:77-96）；稿件 f-sbx-headless-01 | SandboxLifecycleContainer.tsx:77-96 | 只有输出栏与输出流；没有 Agent / 终端标签栏 | f-sbx-headless-01 |
| [AC-SBX-031.3](./SBX.md#REQ-SBX-031) `部分实现` | 文案与码已有（taskOutcome.ts:108-113，TaskOutputPane.view.tsx:204-206），码是 10px | taskOutcome.ts:108-113、TaskOutputPane.view.tsx:204-206 | 一行失败色「历史输出回放失败，下方内容可能不完整；重连或刷新可以再试一次。」+ 下一行 12px「诊断码：REPLAY_FAILED」 | f-sbx-headless-01 |
| [AC-SBX-032.4](./SBX.md#REQ-SBX-032) `偏离` | 现状写「预算」（taskOutcome.ts:292） | taskOutcome.ts:292 | 「已超过硬超时上限，平台正在强制终止…」，琥珀色 | f-sbx-headless-01、f-sbx-headless-05 |
| [AC-SBX-034.1](./SBX.md#REQ-SBX-034) `部分实现` | 除诊断码字号外已实现（现状 10px，TaskOutcome.view.tsx:139）；稿件 f-sbx-headless-04 | TaskOutcome.view.tsx:139 | 「任务失败」+「退出码：1」+「任务以失败告终（CLI 非零退出或运行途中报错）。可以看上方输出定位原因后重跑。 CLI 以退出码 1 结束。」+ 两行产物带 [下载] +「诊断码：TASK_FAILED」（12px） | f-sbx-headless-04 |

### 前端 · AUTH（23）

| AC | 差在哪 | 出处 | 建议修法（目标行为） | 稿件 |
|---|---|---|---|---|
| [AC-AUTH-001.3](./AUTH.md#REQ-AUTH-001) `部分实现` | 展开与标签已实现（useCredentials.ts:180-191、CredentialsContainer.tsx:30）；触发按钮没有打开态与 aria-expanded（稿件 f-auth-panel-08、09） | useCredentials.ts:180-191、CredentialsContainer.tsx:30 | 面板在这张卡的最后一行展开，停在对应标签；触发按钮显示打开态（aria-expanded="true"、aria-controls 指向面板） | f-auth-panel-01、f-auth-panel-02、f-auth-panel-08、f-auth-panel… |
| [AC-AUTH-001.4](./AUTH.md#REQ-AUTH-001) `未实现` | 没有滚动处理；现状弹层没有固定页脚，面板展开后主按钮被挤出可视区（DR-40）（稿件 f-auth-panel-03…07） | — | 面板滚进视野（block: nearest），弹层头与页脚条固定，[发起任务并打开终端] 始终可见 | f-auth-panel-01、f-auth-panel-02、f-auth-panel-08、f-auth-panel… |
| [AC-AUTH-002.4](./AUTH.md#REQ-AUTH-002) `部分实现` | 不发请求已实现（:308-313 兜底）；按钮是原生 disabled、键盘到不了（NewSandboxPanel.view.tsx:482） | NewSandboxPanel.view.tsx:482 | 按钮可聚焦，读屏读出两句原因；不发请求 | f-auth-panel-01 |
| [AC-AUTH-003.1](./AUTH.md#REQ-AUTH-003) `偏离` | 挂载即 begin（AuthGateContainer.tsx:136-141）（稿件 f-auth-panel-02） | AuthGateContainer.tsx:136-141 | begin 0 次；只见 [开始帐号登录] 与说明句 | f-auth-panel-02 |
| [AC-AUTH-003.2](./AUTH.md#REQ-AUTH-003) `偏离` | key=currentMethod 重挂，回到帐号登录标签又 begin 一次（:105-113） | — | begin 0 次 | f-auth-panel-02 |
| [AC-AUTH-003.3](./AUTH.md#REQ-AUTH-003) `部分实现` | 准备中句已有（:203、:254），没有空闲态与按钮 | — | begin 恰好 1 次；按钮换成准备中句（按 Agent 两种） | f-auth-panel-02 |
| [AC-AUTH-003.4](./AUTH.md#REQ-AUTH-003) `部分实现` | 卸载即停轮询（useRuntimeAuthFlow.ts:246-250）；没有取消接口，后端会话只能等过期；关弹层不收面板，重开弹层会自动再 begin（SandboxTerminalContainer.tsx:367-371） | useRuntimeAuthFlow.ts:246-250、SandboxTerminalContainer.tsx:367-371 | 停止轮询；向后端发取消，会话在回收期限内清掉（REQ-AUTH-010）（另需后端配合） | f-auth-panel-02 |
| [AC-AUTH-003.5](./AUTH.md#REQ-AUTH-003) `未实现` | 同 AC-AUTH-003.1 | — | 第二句不含「或关掉弹层」 | f-auth-panel-02 |
| [AC-AUTH-004.5](./AUTH.md#REQ-AUTH-004) `偏离` | 第 1 次失败就提示（useRuntimeAuthFlow.ts:233-237）；[重试] 调的是重新申请设备码（DeviceCodeAuth.view.tsx:154 → AuthGateContainer.tsx:235-239），用户在授权页里输到一半的码随之作废 | useRuntimeAuthFlow.ts:233-237、DeviceCodeAuth.view.tsx:154、AuthGateContainer.tsx:235-239 | 1 次：界面不变、照常再查；3 次：换成「网络异常，正在重试…」+ [重试]；[重试] 立即再查、不换码、倒计时不重置 | f-auth-panel-03、f-auth-panel-08 |
| [AC-AUTH-006.1](./AUTH.md#REQ-AUTH-006) `部分实现` | 结构已实现（SetupTokenAuth.view.tsx:38-102）；等待句前是「⏳」字符，应换图标（DR-26）（稿件 f-auth-panel-05） | SetupTokenAuth.view.tsx:38-102 | 说明句（无 Markdown 符号）→ [打开授权链接] → 等待句 → 粘贴框（遮罩）+ [展开查看] → [提交]（空时禁用） | f-auth-panel-05 |
| [AC-AUTH-006.4](./AUTH.md#REQ-AUTH-006) `偏离` | 优先显示后端 message，没有时才用这句（useRuntimeAuthFlow.ts:88-92、:146-149） | useRuntimeAuthFlow.ts:88-92 | 只显示固定句，不出现后端原句 | f-auth-panel-05 |
| [AC-AUTH-006.5](./AUTH.md#REQ-AUTH-006) `偏离` | 按代码推断，未实跑；任何提交错误后后端都销毁该会话（runtime-application.service.ts:243-249），第二次提交必然 404，且 404 的英文原句「challenge … expired or unknown」（:218）会原样上屏 | runtime-application.service.ts:243-249 | 能完成登录，不需要收起再展开 | f-auth-panel-05 |
| [AC-AUTH-007.4](./AUTH.md#REQ-AUTH-007) `偏离` | 标题显示后端原句「这串 API Key 没有通过格式检查，没有保存。」（useRuntimeAuthFlow.ts:88-92、runtime-application.service.ts:432）（稿件 f-auth-panel-06、09） | useRuntimeAuthFlow.ts:88-92、runtime-application.service.ts:432 | 标题「这串 API Key 格式不对，没有保存。」+ 1 条原因（如「比正常的 key 短，可能只复制到了一部分。」）；面板不收起 | f-auth-panel-06、f-auth-panel-09 |
| [AC-AUTH-007.5](./AUTH.md#REQ-AUTH-007) `偏离` | 兜底一条「可能是格式不对、这个 key 没有权限，或者额度用完了。」（useRuntimeAuthFlow.ts:85） | useRuntimeAuthFlow.ts:85 | 只出标题 | f-auth-panel-06、f-auth-panel-09 |
| [AC-AUTH-007.6](./AUTH.md#REQ-AUTH-007) `部分实现` | 凭证页点名（CredentialsContainer.tsx:27、ApiKeyAuth.view.tsx:84-87）；新建任务闸门没把 vendor 传给面板，用兜底句（SandboxTerminalContainer.tsx:280-295）——稿件 f-auth-panel-06 照现状画兜底句 | CredentialsContainer.tsx:27、ApiKeyAuth.view.tsx:84-87、SandboxTerminalContainer.tsx:280-295 | 两处都点名厂商（「在 OpenAI 的控制台…」） | f-auth-panel-06、f-auth-panel-09 |
| [AC-AUTH-008.1](./AUTH.md#REQ-AUTH-008) `偏离` | 成功回调与收起同批（useRuntimeAuthPanel.ts:72-76），「已连上」（AuthGateContainer.tsx:149-156）在新建任务与凭证页里根本画不出来（稿件 f-auth-panel-07） | useRuntimeAuthPanel.ts:72-76、AuthGateContainer.tsx:149-156 | 面板显示「已连上」（role=status），≥ 2 秒且 runtimes 重取完成后才收起 | f-auth-panel-07 |
| [AC-AUTH-008.2](./AUTH.md#REQ-AUTH-008) `偏离` | 重取完成前 credentialStatus 仍是旧值，闸门短暂退回折叠句（SandboxTerminalContainer.tsx:256-276，DR-21） | SandboxTerminalContainer.tsx:256-276 | 闸门不闪回；身份句已出现；发起可用；任务指令仍在 | f-auth-panel-07 |
| [AC-AUTH-008.3](./AUTH.md#REQ-AUTH-008) `部分实现` | 已有（useRuntimeAuthMutations.ts:41）；sonner 恒为亮色（DR-29） | useRuntimeAuthMutations.ts:41 | 轻提示「凭证已更新」（role=status），跟随主题 | f-auth-panel-07 |
| [AC-AUTH-010.1](./AUTH.md#REQ-AUTH-010) `未实现` | TC-AUTH-001 基线红 | — | 进行中会话 ≤ 1，登录进程 ≤ 1，并发不出 500 | — |
| [AC-AUTH-010.2](./AUTH.md#REQ-AUTH-010) `未实现` | （还没有做；片段没写细节，见需求正文） | — | 被拒，可区分的错误码；不拉起进程 | — |
| [AC-AUTH-010.4](./AUTH.md#REQ-AUTH-010) `未实现` | 只清墓碑（sweepOutcomes），进行中的授权链接会话不回收 | — | 会话数为 0，进程已回收 | — |
| [AC-AUTH-011.1](./AUTH.md#REQ-AUTH-011) `部分实现` | 句子来自后端信封（runtime-application.service.ts:138 → useRuntimeAuthFlow.ts:126-129），只有 [重试]（AuthGateContainer.tsx:257-272） | runtime-application.service.ts:138、useRuntimeAuthFlow.ts:126-129、AuthGateContainer.tsx:257-272 | 503 那句 + [重试] + 去系统状态诊断的入口（另需后端配合） | — |
| [AC-AUTH-011.2](./AUTH.md#REQ-AUTH-011) `偏离` | 前端优先显示后端 message（useRuntimeAuthFlow.ts:88-92），adapter 的原句与 404「challenge … expired or unknown」会原样上屏（runtime-application.service.ts:218、:242、:544-562） | useRuntimeAuthFlow.ts:88-92、runtime-application.service.ts:218 | 面板里不出现英文原句与错误码原文 | — |

### 前端 · CRD（32）

| AC | 差在哪 | 出处 | 建议修法（目标行为） | 稿件 |
|---|---|---|---|---|
| [AC-CRD-001.1](./CRD.md#REQ-CRD-001) `偏离` | 标题已是这句（RevokeConfirmDialog.view.tsx:55-57），没有副标题；按钮恒为「确认删除」、不写数量（:97） | RevokeConfirmDialog.view.tsx:55-57 | 标题「删除 Codex 的帐号登录？」、副标题「凭证 · 当前在用」；危险按钮「删除并销毁 5 个任务」 | f-crd-revoke-01、f-crd-revoke-02、f-crd-revoke-03 |
| [AC-CRD-001.2](./CRD.md#REQ-CRD-001) `偏离` | 恒为「确认删除」（:97） | — | 危险按钮「删除凭证」，不编数量 | f-crd-revoke-01、f-crd-revoke-02、f-crd-revoke-03 |
| [AC-CRD-001.3](./CRD.md#REQ-CRD-001) `偏离` | 「这些正在跑的任务会被重启：」（:80）、「删除会重启正在用这份凭证跑的任务…」（runtimeCredential.ts:121-122）、「…那边才是唯一能真正吊销它的地方」（:131-132） | runtimeCredential.ts:121-122 | 不含「吊销」「重启」 | f-crd-revoke-01、f-crd-revoke-02、f-crd-revoke-03 |
| [AC-CRD-002.1](./CRD.md#REQ-CRD-002) `偏离` | 前端按同 Agent × running / starting / pending / waiting_input 自算（affectedTasks.ts:12、20），空闲（idle）漏列、pending 多列 | affectedTasks.ts:12、20 | 「会销毁这 5 个任务」列 5 条，空闲那条在内，每条「名 · Codex · 状态词」 | f-crd-revoke-01、f-crd-revoke-02、f-crd-revoke-03 |
| [AC-CRD-002.3](./CRD.md#REQ-CRD-002) `部分实现` | 有一句「正在跑的任务清单暂时查不到，删除前请自行确认。」（RevokeConfirmDialog.view.tsx:73-77），没有 [重试读取]，按钮「确认删除」 | RevokeConfirmDialog.view.tsx:73-77 | 警示块（标题 + 说明 + [重试读取]）；不出现「没有任务」；危险按钮「删除凭证」可点 | f-crd-revoke-01、f-crd-revoke-02、f-crd-revoke-03 |
| [AC-CRD-002.4](./CRD.md#REQ-CRD-002) `未实现` | 没有手动重试（列表查询自己重取成功时会自动换，useAffectedTasks.ts:49） | useAffectedTasks.ts:49 | 同一个框里换成 AC-CRD-002.1 或 002.5 的内容，框不关、焦点留在框内 | f-crd-revoke-01、f-crd-revoke-02、f-crd-revoke-03 |
| [AC-CRD-002.5](./CRD.md#REQ-CRD-002) `部分实现` | 有「现在没有任务在用这份凭证。」（:88-90），没有来源行 | — | 「不受影响」写「现在没有任务在用这份凭证，不会销毁任何任务」+ 清单来源一行 | f-crd-revoke-01、f-crd-revoke-02、f-crd-revoke-03 |
| [AC-CRD-002.6](./CRD.md#REQ-CRD-002) `偏离` | 手写遮罩，没有初始焦点（RevokeConfirmDialog.view.tsx:48-54）；Esc 被设置区全局监听直接跳回工作台（app/settings/layout.tsx:50-58） | RevokeConfirmDialog.view.tsx:48-54、app/settings/layout.tsx:50-58 | 焦点在 [取消]；Esc 只关框，仍在凭证页，凭证还在 | f-crd-revoke-01、f-crd-revoke-02、f-crd-revoke-03 |
| [AC-CRD-003.3](./CRD.md#REQ-CRD-003) `未实现` | 前端把 pending / starting 算进「会被重启」（affectedTasks.ts:12），没有准备中这一句 | affectedTasks.ts:12 | C 不在「会销毁」里；「删掉之后」列「C · Codex · 准备中」+ 说明句 | f-crd-revoke-01、f-crd-revoke-03 |
| [AC-CRD-003.5](./CRD.md#REQ-CRD-003) `部分实现` | 有警示句与跟进句（runtimeCredential.ts:121-122、131-132），用词见 AC-CRD-001.3 | runtimeCredential.ts:121-122、131-132 | 「平台删不掉」写「已经从任务里带出去的 token」+ 去厂商后台作废的一句 | f-crd-revoke-01、f-crd-revoke-03 |
| [AC-CRD-004.1](./CRD.md#REQ-CRD-004) `部分实现` | 只有前半句「这个 Agent 现在用的就是它，删掉就不能用了。」（RevokeConfirmDialog.view.tsx:67-71） | RevokeConfirmDialog.view.tsx:67-71 | 「删掉之后」第一条「这个 Agent 现在用的就是它，删掉就不能用了 —— 它的 API Key 还留着，删完会问你要不要切过去」 | f-crd-revoke-01、f-crd-revoke-02、f-crd-revoke-03、f-crd-mode-0… |
| [AC-CRD-004.2](./CRD.md#REQ-CRD-004) `部分实现` | 追问已有（useCredentials.ts:296-304）；标题与正文「切换到API Key」「它的API Key还留着」缺空格（runtimeCredential.ts:147-149、157-159，DR-35 ⑩） | useCredentials.ts:296-304、runtimeCredential.ts:147-149、157-159 | 追问框：标题「切换到 API Key」、正文「这个 Agent 现在没有可用的凭证了。它的 API Key 还留着 —— 要现在切过去用吗？」、[切过去] | f-crd-revoke-01、f-crd-revoke-02、f-crd-revoke-03、f-crd-mode-0… |
| [AC-CRD-005.2](./CRD.md#REQ-CRD-005) `部分实现` | 后端按绑定逐个销毁并推 sandbox.status_changed / sandbox.removed（credential-revoked.handler.ts:73-81）；树上「删除中」的样子与计数见 F-SBX-DESTROY（未核实） | credential-revoked.handler.ts:73-81 | 5 个任务在树上进入「删除中」后移除；树组计数、导航徽标、总览三处一致 | — |
| [AC-CRD-005.3](./CRD.md#REQ-CRD-005) `偏离` | 优先显示后端 envelope.message 原文（useCredentials.ts:306-307） | useCredentials.ts:306-307 | 关框，轻提示「删除失败，请稍后重试。」（role=alert），凭证不变 | — |
| [AC-CRD-010.1](./CRD.md#REQ-CRD-010) `部分实现` | 框与正文已有（useCredentials.ts:210-217）；标题缺空格（runtimeCredential.ts:147-149）；没有副标题；不设初始焦点（ConfirmDialog.view.tsx:22-43）（稿件 f-crd-mode-01） | useCredentials.ts:210-217、runtimeCredential.ts:147-149、ConfirmDialog.view.tsx:22-43 | 确认框：标题「切换到 API Key」、副标题「Codex · 当前使用：帐号登录」、正文、[取消][切换]；焦点在 [取消]；单选仍在帐号登录 | f-crd-mode-01 |
| [AC-CRD-010.2](./CRD.md#REQ-CRD-010) `部分实现` | 已实现（useCredentials.ts:223-240）；轻提示缺空格（:230） | useCredentials.ts:223-240 | PUT auth-mode 1 次，切换中按钮不可再点；成功后徽标移到 API Key 行，轻提示「已切换到 API Key」 | f-crd-mode-01 |
| [AC-CRD-010.3](./CRD.md#REQ-CRD-010) `部分实现` | 409 已有（runtime-application.service.ts:453-457）；失败句是后端英文原句经 errorMessageOf 上屏（useCredentials.ts:139-143、:234） | runtime-application.service.ts:453-457、useCredentials.ts:139-143 | 后端 409；框关闭，轻提示前端句；徽标不动 | f-crd-mode-01 |
| [AC-CRD-010.4](./CRD.md#REQ-CRD-010) `未实现` | ConfirmDialog 没有 Esc 处理与关闭按钮（ConfirmDialog.view.tsx:22-43） | ConfirmDialog.view.tsx:22-43 | 关框，什么都不变 | f-crd-mode-01 |
| [AC-CRD-012.1](./CRD.md#REQ-CRD-012) `偏离` | 两张卡同属 `auth-mode-account` 一组，浏览器只留一个选中点（DR-20） | — | 两张卡的帐号登录单选都显示选中 | f-crd-mode-01 |
| [AC-CRD-020.5](./CRD.md#REQ-CRD-020) `偏离` | 「…与 Agent 的 Runtime 凭证无关。」（GitCredentialsSection.view.tsx:72） | GitCredentialsSection.view.tsx:72 | 「Git 凭证用于克隆私有仓库，与 Agent 凭证无关。」 | f-crd-git-01、f-crd-git-02 |
| [AC-CRD-021.6](./CRD.md#REQ-CRD-021) `偏离` | 优先显示后端 message（useGitCredentialManager.ts:299-301） | useGitCredentialManager.ts:299-301 | 表单留着，轻提示「保存失败，请稍后重试。」 | f-crd-git-03 |
| [AC-CRD-026.1](./CRD.md#REQ-CRD-026) `未实现` | [删除] 一点即删（GitCredentialCard.view.tsx:126 → useGitCredentialManager.ts:306-315） | GitCredentialCard.view.tsx:126、useGitCredentialManager.ts:306-315 | 确认框：标题「删除 Git 凭证「HTTPS Token · github.com」？」、副标题「Git 凭证 · 最后使用 2 小时前」；会删掉 → 平台删不掉 → 删掉之后 → 不受影响 → 来源；焦点在 [取消]；危险按钮「删除凭证」 | f-crd-git-05、f-crd-git-02 |
| [AC-CRD-026.2](./CRD.md#REQ-CRD-026) `未实现` | 同上：[删除] 一点即删（GitCredentialCard.view.tsx:126 → useGitCredentialManager.ts:306-315） | — | 「仓库在 github.com 的 5 个项目：示例项目、acme-web、acme-api、docs-site、infra-scripts」 | f-crd-git-05、f-crd-git-02 |
| [AC-CRD-026.3](./CRD.md#REQ-CRD-026) `偏离` | 没有确认框；轻提示「凭证已吊销」（useGitCredentialManager.ts:309）；未配置卡已实现（GitCredentialCard.view.tsx:61-78，稿件 f-crd-git-02） | useGitCredentialManager.ts:309、GitCredentialCard.view.tsx:61-78 | 204；关框；轻提示「凭证已删除」；Git 分区转「未配置」卡（两个入口） | f-crd-git-05、f-crd-git-02 |
| [AC-CRD-026.4](./CRD.md#REQ-CRD-026) `偏离` | 「吊销失败，请稍后重试。」，且优先显示后端 message（:312） | — | 轻提示「删除失败，请稍后重试。」；凭证不变 | f-crd-git-05、f-crd-git-02 |
| [AC-CRD-030.1](./CRD.md#REQ-CRD-030) `部分实现` | 两个分区各一块 h-24 脉冲灰块（RuntimeCredentialsSection.view.tsx:84，GitCredentialsSection.view.tsx:102），数据一到 Agent 分区跳高 | RuntimeCredentialsSection.view.tsx:84、GitCredentialsSection.view.tsx:102 | Agent 区 2 张、Git 区 1 张骨架卡，高度与真卡一致；数据到了不跳高 | f-crd-page-01 |
| [AC-CRD-030.2](./CRD.md#REQ-CRD-030) `未实现` | 骨架块没有可读文字，也没有 aria-busy | — | 听到「正在读取 Agent 列表…」「正在读取 Git 凭证…」；骨架不被读出 | f-crd-page-01 |
| [AC-CRD-032.5](./CRD.md#REQ-CRD-032) `未实现` | 这句是普通段落，没有 role=status（:99-101） | — | 听到「没有匹配的 Agent。」 | f-crd-page-03 |
| [AC-CRD-033.5](./CRD.md#REQ-CRD-033) `偏离` | 单选 name 只按方式（`auth-mode-${row.mode}`，AuthMethodRadioRow.view.tsx:104），两张卡落在同一组，浏览器只保留一个选中（DR-20） | AuthMethodRadioRow.view.tsx:104 | 两张卡的「帐号登录」单选都选中 | f-crd-page-04 |
| [AC-CRD-034.1](./CRD.md#REQ-CRD-034) `部分实现` | 回程条已实现（GitCredentialsSection.view.tsx:76-99）；跳转不带定位（NewProjectContainer.tsx:76 `router.push('/settings/credentials')`），回程条可能在首屏之下 | GitCredentialsSection.view.tsx:76-99、NewProjectContainer.tsx:76 | 进凭证页，视口在 Git 分区，顶部回程条「为项目「acme-api」配置凭证后，可重试克隆。」 | f-crd-page-05 |
| [AC-CRD-034.3](./CRD.md#REQ-CRD-034) `部分实现` | 优先显示后端 message（:328-331） | — | 回程条留着；轻提示「重试克隆失败，请稍后重试。」 | f-crd-page-05 |
| [AC-CRD-034.6](./CRD.md#REQ-CRD-034) `部分实现` | 新建弹层跳来带地址（NewProjectContainer.tsx:70-75）；项目主区跳来不带（ProjectRecoveryContainer.tsx:35），退回探测 host 根地址（「待核实」②） | NewProjectContainer.tsx:70-75、ProjectRecoveryContainer.tsx:35 | 以 acme-api 的仓库地址为目标 | f-crd-page-05 |

### 前端 · ACC（9）

| AC | 差在哪 | 出处 | 建议修法（目标行为） | 稿件 |
|---|---|---|---|---|
| [AC-ACC-001.3](./ACC.md#REQ-ACC-001) `未实现` | 随 AC-ACC-001.1；DR-13 的单独 stdout 通道还没有 | — | 两处都没有口令明文 | f-acc-unlock-01 |
| [AC-ACC-002.4](./ACC.md#REQ-ACC-002) `未实现` | 没有这个开关（TC-ACC-001 第 4 条） | — | 回环免口令，非回环仍要 | f-acc-unlock-01、f-acc-unlock-02 |
| [AC-ACC-003.1](./ACC.md#REQ-ACC-003) `偏离` | init-status 401 时放行 children，口令门浮在工作台上（bg-black/60 + 模糊），工作台照常挂载、发请求（AppBootGate.tsx:54-58、AccessGateContainer.tsx:14-28）（稿件 f-acc-unlock-02） | AppBootGate.tsx:54-58、AccessGateContainer.tsx:14-28 | 只有全屏口令门（中性底 + 品牌行 + 口令卡）；DOM 里没有工作台与向导；不发项目 / 任务等请求 | f-acc-unlock-02 |
| [AC-ACC-003.2](./ACC.md#REQ-ACC-003) `部分实现` | 解锁后 invalidateQueries 重取 init-status（useAccessGate.ts:33-36），由 AppBootGate 换成向导；但解锁前工作台已经挂过 | useAccessGate.ts:33-36 | 重新判定：未初始化 → 向导；已初始化 → 工作台 | f-acc-unlock-02 |
| [AC-ACC-003.3](./ACC.md#REQ-ACC-003) `部分实现` | 置锁已实现（useAccessGate.ts:80-89），外观同 AC-ACC-003.1 的偏离 | useAccessGate.ts:80-89 | 回到全屏口令门 | f-acc-unlock-02 |
| [AC-ACC-004.1](./ACC.md#REQ-ACC-004) `偏离` | 说明句取后端信封（UnlockForm.view.tsx:36-40、useAccessGate.ts:85-86）；没有口令从哪来那句（稿件 f-acc-unlock-02） | UnlockForm.view.tsx:36-40、useAccessGate.ts:85-86 | 标题、前端说明句、字段（焦点在此）、禁用的 [解锁]、口令从哪来那句（另需后端配合） | f-acc-unlock-02、f-acc-unlock-03 |
| [AC-ACC-004.2](./ACC.md#REQ-ACC-004) `部分实现` | 没有转圈（UnlockForm.view.tsx:24、:52、:66） | UnlockForm.view.tsx:24 | 提交去掉首尾空白的口令；输入框禁用；按钮「验证中…」带转圈 | f-acc-unlock-02、f-acc-unlock-03 |
| [AC-ACC-004.3](./ACC.md#REQ-ACC-004) `偏离` | 显示后端原句「访问口令不正确」（passcode-errors.ts:43、useAccessGate.ts:50），输入框没有错误态（稿件 f-acc-unlock-03 ①） | passcode-errors.ts:43、useAccessGate.ts:50 | 输入框错误态 +「口令不对，再试一次。」；输入保留；可再提交 | f-acc-unlock-02、f-acc-unlock-03 |
| [AC-ACC-005.3](./ACC.md#REQ-ACC-005) `偏离` | 显示后端原句「口令错误次数过多，已暂时锁定；请 287 秒后重试」（passcode-errors.ts:59），[解锁] 仍可点、提交照样被拒（稿件 f-acc-unlock-03 ③） | passcode-errors.ts:59 | 「错得太多次，已暂时锁定，约 5 分钟后再试。」；[解锁] 置灰；输入保留 | f-acc-unlock-03 |

### 前端 · IMG（59）

| AC | 差在哪 | 出处 | 建议修法（目标行为） | 稿件 |
|---|---|---|---|---|
| [AC-IMG-001.4](./IMG.md#REQ-IMG-001) `未实现` | 手写遮罩没有点击处理（RegisterImageModal.view.tsx:60-65；UX-DS-207 要求可关闭的弹层统一用 AppDialog） | RegisterImageModal.view.tsx:60-65 | 同 AC-IMG-001.3 | f-img-register-01…04 |
| [AC-IMG-003.2](./IMG.md#REQ-IMG-003) `偏离` | 警告句是后端原句「镜像未声明预装 'claude-code'（platform.supportedRuntimes）。选用该 runtime 时会在沙箱内现装，实测可能需要数分钟而不是数秒。」（oci-image-spec.provider.ts:183-188 → useImages.ts:210-212）（稿件 f-img-register-01） | oci-image-spec.provider.ts:183-188、useImages.ts:210-212 | 「有警告」+「镜像仍可用」+「未预装 claude-code，创建时需现装，启动会明显变慢」；出现 [保存] | f-img-register-01、f-img-register-02 |
| [AC-IMG-003.3](./IMG.md#REQ-IMG-003) `部分实现` | 结构、role、不渲染 [保存] 已实现（ValidationResult.view.tsx:66、94-108，RegisterImageModal.view.tsx:184-189）；句子是后端原句，含「血统」「rootfs.diff_ids」（image-application.service.ts:572-588）（稿件 f-img-register-02） | ValidationResult.view.tsx:66、94-108、RegisterImageModal.view.tsx:184-189、image-application.service.ts:572-588 | 「无效」+「镜像不符合平台约定」+ 两条按码查表的句子 + [查看镜像要求]；页脚没有 [保存]；role=alert | f-img-register-01、f-img-register-02 |
| [AC-IMG-003.4](./IMG.md#REQ-IMG-003) `未实现` | 没有镜像文案表（DR-33 推荐在 `lib/image` 新建） | — | 前三个出各自的句子（第一个带坐标）；未知码出兜底句 + 错误码单列，不出后端原句 | f-img-register-01、f-img-register-02 |
| [AC-IMG-004.1](./IMG.md#REQ-IMG-004) `部分实现` | 错误句与结论作废已实现（useImages.ts:400-416，RegisterImageModal.view.tsx:90-94、159-163）；输入框没有错误态与 aria 关联（稿件 f-img-register-03） | useImages.ts:400-416、RegisterImageModal.view.tsx:90-94、159-163 | 输入框错误态（aria-invalid=true，aria-describedby 指向错误句）+「镜像地址不能包含空格、换行或不可见字符。」（role=alert）；结论清掉、[保存] 消失、出现「已修改镜像地址，请重新验证」；焦点仍在输入框 | f-img-register-03 |
| [AC-IMG-005.1](./IMG.md#REQ-IMG-005) `部分实现` | 提示与按钮已实现（useImages.ts:446-452，RegisterImageModal.view.tsx:137-149；e2e 见 F21-4 §7.4 ⑦）；提示没有 role=status（稿件 f-img-register-04） | useImages.ts:446-452、RegisterImageModal.view.tsx:137-149 | 平台回 200；弹层不关；结论上方「该镜像已注册（docker.io/acme/ml-agent:v1.0，锁定在 sha256:8e05a…d77）。」+ [定位到该镜像]，role=status；结论与 [保存] 仍在 | f-img-register-04 |
| [AC-IMG-005.2](./IMG.md#REQ-IMG-005) `部分实现` | 关闭弹层与只标那一张已实现（useImages.ts:482-485，ImagesContainer.tsx:137-143）；不滚动；焦点回到 [注册新镜像]（useModalFocus.ts 还原） | useImages.ts:482-485、ImagesContainer.tsx:137-143、useModalFocus.ts | 弹层关闭；列表滚到 ml-agent 那张卡并以焦点色环标出，其余卡不标；焦点在那张卡上 | f-img-register-04 |
| [AC-IMG-005.3](./IMG.md#REQ-IMG-005) `未实现` | 被过滤藏起的卡加了环也看不见 | — | 过滤回到「全部」、搜索清空，再滚到那张卡（建议） | f-img-register-04 |
| [AC-IMG-006.1](./IMG.md#REQ-IMG-006) `未实现` | 预检接口只回 status / errors / warnings（useImages.ts:425-428）；不回复时默认不显示（稿件 f-img-register-01、04 标「待契约 · DR-11」） | useImages.ts:425-428 | 结论下「钉定 sha256:5d8c4…f60」 | f-img-register-01、f-img-register-04 |
| [AC-IMG-007.1](./IMG.md#REQ-IMG-007) `部分实现` | 面板形态已实现（ImageRequirementsPanel.view.tsx:74-81，useImages.ts:713-716）；触发按钮没有 aria-expanded（稿件 f-img-register-05） | ImageRequirementsPanel.view.tsx:74-81、useImages.ts:713-716 | 右侧出现 role=complementary、名称「平台对镜像的要求」的面板；没有遮罩；焦点仍在该按钮上，按钮 aria-expanded=true；页面可滚动、可点 | f-img-register-05 |
| [AC-IMG-008.1](./IMG.md#REQ-IMG-008) `偏离` | 只出右上角轻提示（标题「连不上镜像仓库」+ 建议，useImages.ts:435-437 → 237-256，sandboxErrorCopy.ts:348-352），弹层里没有任何变化，轻提示不渲染 [重试] | useImages.ts:435-437、sandboxErrorCopy.ts:348-352 | 「验证中…」结束；页脚上方一条失败提示（role=alert）「连不上镜像下载源」+ 一句下一步 + [重试]；地址保留；没有结论区；焦点留在 [验证] 上（f-img-register-06） | f-img-register-06 |
| [AC-IMG-008.2](./IMG.md#REQ-IMG-008) `偏离` | 同上，只出轻提示（sandboxErrorCopy.ts:334-339）：只出右上角轻提示（标题「连不上镜像仓库」+ 建议，useImages.ts:435-437 → 237-256，sandboxErrorCopy.ts:348-352），弹层里没有任何变化，轻提示不渲染 [重试] | sandboxErrorCopy.ts:334-339 | 原位「镜像下载源上没有这个名字或这个版本」+ 检查拼写与可见性；没有 [重试] | f-img-register-06 |
| [AC-IMG-008.3](./IMG.md#REQ-IMG-008) `偏离` | 轻提示「⚠️ 这一步现在做不了」+ 后端原句（useImages.ts:226-245，image-application.service.ts:551-556） | useImages.ts:226-245、image-application.service.ts:551-556 | 原位说清是平台部署问题、不用改 Dockerfile，并给 [查看系统状态] | f-img-register-06 |
| [AC-IMG-008.4](./IMG.md#REQ-IMG-008) `偏离` | 弹层不变，只出轻提示「这张镜像不满足平台要求，没有注册进来」（useImages.ts:476-478，sandboxErrorCopy.ts:317-324） | useImages.ts:476-478、sandboxErrorCopy.ts:317-324 | 弹层不关；结论区换成无效结论，[保存] 消失 | f-img-register-06 |
| [AC-IMG-010.1](./IMG.md#REQ-IMG-010) `部分实现` | 展开已实现（ImagesContainer.tsx:154-204）；按钮没有 aria-expanded / aria-controls（ImageCard.view.tsx:266-268）（稿件 f-img-env-01） | ImagesContainer.tsx:154-204、ImageCard.view.tsx:266-268 | 该卡运行参数块里展开编辑器，三行与库里一致（已存 Secret 见 REQ-IMG-011）；按钮 aria-expanded=true；其余两张卡不变 | f-img-env-01 |
| [AC-IMG-012.2](./IMG.md#REQ-IMG-012) `部分实现` | 错误句、role、data-code、计数变红已实现（EnvVarEditor.view.tsx:99-167）；输入框只有红边，没有 aria-invalid / aria-describedby（稿件 f-img-env-02） | EnvVarEditor.view.tsx:99-167 | 每个出错的输入框错误态 + aria-invalid + aria-describedby 指向下一行的错误句；错误句 role=alert、带 data-code；第 5 行字节计数「5121 / 4096 字节」变红 | f-img-env-02 |
| [AC-IMG-013.1](./IMG.md#REQ-IMG-013) `偏离` | 只 disabled 置灰，不说原因、不可聚焦（EnvVarEditor.view.tsx:178-188） | EnvVarEditor.view.tsx:178-188 | [添加变量] aria-disabled、可聚焦，旁边「每张镜像最多 50 条」，按钮 aria-describedby 指向它；没有整表错误 | f-img-env-03 |
| [AC-IMG-013.2](./IMG.md#REQ-IMG-013) `部分实现` | 整表错误已实现（EnvVarEditor.view.tsx:172-176）；原因句没有（稿件 f-img-env-03） | EnvVarEditor.view.tsx:172-176 | 最后一行之后「变量条数太多（每张镜像最多 50 条）」（role=alert）+ AC-IMG-013.1 的置灰与原因 | f-img-env-03 |
| [AC-IMG-014.4](./IMG.md#REQ-IMG-014) `偏离` | 只出失败轻提示（useImages.ts:866-869），编辑器下没有原位句 | useImages.ts:866-869 | 编辑器下面一句「保存失败，请稍后重试。」（role=alert），草稿保留 | 无单独稿 |
| [AC-IMG-020.2](./IMG.md#REQ-IMG-020) `部分实现` | 原位切换已实现（ImageCard.view.tsx:160-168）；开关没有 aria-expanded，全串没有折行约束（稿件 f-img-version-03） | ImageCard.view.tsx:160-168 | 原位换成 71 字符全串，按钮变 [收起] 且 aria-expanded="true"；全串在卡宽内折行，页面不出现横向滚动；再点回到短串、aria-expanded="false"；全程不发请求 | f-img-version-03 |
| [AC-IMG-020.3](./IMG.md#REQ-IMG-020) `未实现` | 稿件 f-img-version-03：user-select: all | — | 整串被选中 | f-img-version-03 |
| [AC-IMG-022.2](./IMG.md#REQ-IMG-022) `部分实现` | 内容与两个按钮已实现（UpdateCompareDialog.view.tsx:60-94，story UpstreamValid）；作用范围一句未实现；按钮位置见稿件 f-img-version-01 | UpdateCompareDialog.view.tsx:60-94 | 当前「sha256:8e05a…d77（解析于 3 天前）」/ 上游「sha256:c1f9e…a20」；结论「验证通过 · 镜像可用」；作用范围一句；[暂不更新] 在左、[更新到新版本] 在右 | f-img-version-01 |
| [AC-IMG-022.5](./IMG.md#REQ-IMG-022) `部分实现` | 行为已实现（useImages.ts:637-671，ImagesContainer.tsx:41，useImages.test.tsx:314）；轻提示没有作用范围一句 | useImages.ts:637-671、ImagesContainer.tsx:41、useImages.test.tsx:314 | 「更新中…」、两个按钮禁用、Esc 不关；先登记新版本行再切过去（旧行不改）；成功后弹层关闭、卡面是 c1f9e…a20、8e05a…d77 进历史条、提示条消失；轻提示「已更新到新版本（sha256:c1f9e…a20）。」+ 作用范围一句 | f-img-version-01 |
| [AC-IMG-023.2](./IMG.md#REQ-IMG-023) `偏离` | 句子是「…展开卡片看后果说明。」，三档都用成功色（useImages.ts:258-266、502） | useImages.ts:258-266、502 | 结论原位不变；中性轻提示「重新验证通过，但有警告——后果说明在卡上。」 | f-img-version-02 |
| [AC-IMG-023.3](./IMG.md#REQ-IMG-023) `部分实现` | 不自动禁用、结论改写已实现（useImages.ts:489-510，P21-4 L268-271）；轻提示是成功色 | useImages.ts:489-510 | 结论原位改成「无效」+ 原因 + [查看镜像要求]（role="alert"）；卡片仍「已启用」，不发禁用请求；失败色轻提示 | f-img-version-02 |
| [AC-IMG-024.2](./IMG.md#REQ-IMG-024) `偏离` | 不确认已实现（useImages.ts:560-572）；「切换中…」落不到被点的那一行——容器把 switchingId 接成卡面行 id（ImagesContainer.tsx:226），toggling 只认卡面行（useImages.ts:341-343），被点的行一直可点；view 自己的故事 Switching 是绿的（ImageVersionHistory.view.stories.tsx:93-97） | useImages.ts:560-572、ImagesContainer.tsx:226、useImages.ts:341-343、ImageVersionHistory.view.stories.tsx:93-97 | 不弹确认；这一行按钮「切换中…」禁用；卡面不动 | f-img-version-04 |
| [AC-IMG-024.3](./IMG.md#REQ-IMG-024) `部分实现` | 换位已实现（重取列表后按当前行聚合，imageManifestCards.ts:164-191）；轻提示只有「已切换到该版本。」（useImages.ts:564）（稿件 f-img-version-04） | imageManifestCards.ts:164-191、useImages.ts:564 | 卡面换成 2c9d1…b08（验证通过 · 镜像可用、适用 codex、claude-code、解析于 12 天前、运行参数是那一版自己的）；8e05a…d77（有警告）进历史条并带 [切换到此版本]；轻提示「已切换到该版本。」+ 作用范围一句 | f-img-version-04 |
| [AC-IMG-024.5](./IMG.md#REQ-IMG-024) `未实现` | 按钮总是可点（ImageVersionHistory.view.tsx:89-99），后端 activate 也不看结论（image-application.service.ts:325-335） | ImageVersionHistory.view.tsx:89-99、image-application.service.ts:325-335 | 这一行的 [切换到此版本] 置灰，旁边写「这一版校验不通过，切过去新任务会被拒」（另需后端配合） | f-img-version-04 |
| [AC-IMG-025.2](./IMG.md#REQ-IMG-025) `未实现` | UpdateCompareDialog.view.tsx 没有这一句（稿件 f-img-version-01） | UpdateCompareDialog.view.tsx | 结论之后、页脚之前有作用范围一句 | f-img-version-01、f-img-version-04 |
| [AC-IMG-025.3](./IMG.md#REQ-IMG-025) `未实现` | useImages.ts:564、644、660 只有标题（稿件 f-img-version-04） | useImages.ts:564、644、660 | 标题「已更新到新版本（sha256:…）。」或「已切换到该版本。」，正文是作用范围一句 | f-img-version-01、f-img-version-04 |
| [AC-IMG-026.3](./IMG.md#REQ-IMG-026) `未实现` | 与 AC-IMG-026.1 二选一：026.1 做到后这一条删掉 | — | 写明「新版本不带运行参数，更新后要重新填」 | f-img-version-04 |
| [AC-IMG-030.3](./IMG.md#REQ-IMG-030) `偏离` | 徽标用 pending（转圈，ImageCard.view.tsx:113-115，status-pill.tsx:44、99；UX-DS-138），整卡 opacity-60（ImageCard.view.tsx:94-96）（稿件 f-img-state-01） | ImageCard.view.tsx:113-115、status-pill.tsx:44、99、ImageCard.view.tsx:94-96 | 徽标「已禁用」：中性底 + 实心方块、不转圈；卡片不降透明 | f-img-state-01 |
| [AC-IMG-030.4](./IMG.md#REQ-IMG-030) `偏离` | 「已禁用，向导下拉里不再出现这张镜像。」（useImages.ts:588） | useImages.ts:588 | 标题「已禁用」+「新任务不能再选用这张镜像；已经在用它的任务不受影响。」 | f-img-state-01 |
| [AC-IMG-031.2](./IMG.md#REQ-IMG-031) `偏离` | 按钮禁用但文案不变（ImageCard.view.tsx:304-314；UX-DS-204 要求「X 中…」） | ImageCard.view.tsx:304-314 | 按钮「启用中…」禁用 | f-img-state-01 |
| [AC-IMG-031.3](./IMG.md#REQ-IMG-031) `偏离` | 轻提示是「已切换到该版本。」（toggle 复用 activateVersion，useImages.ts:564、582-584） | useImages.ts:564、582-584 | 「已启用」、按钮 [禁用]；轻提示「已启用」+「新任务又可以选用这张镜像了。」 | f-img-state-01 |
| [AC-IMG-032.4](./IMG.md#REQ-IMG-032) `未实现` | 没有确认，点了直接乐观禁用（useImageMutations.ts:108-131），轻提示与自定义镜像同一句「…向导下拉里不再出现这张镜像。」（useImages.ts:588）（稿件 f-img-state-04） | useImageMutations.ts:108-131、useImages.ts:588 | 先出确认：标题「禁用预制镜像「ghcr.io/agent-infra/sandbox:latest」？」、副标题与后果句（新任务默认用它、自动化到点发起的也用它；要接着发就重新启用或换一张镜像；在跑的不受影响）；焦点在 [取消]；[禁用] 不是危险色；[取消] / Esc 什么都不发；确认后才发 PATCH isActive:false，轻提示「已禁用」+ 后果句 | f-img-state-04 |
| [AC-IMG-032.5](./IMG.md#REQ-IMG-032) `偏离` | 徽标写「预置」（ImageCard.view.tsx:103） | ImageCard.view.tsx:103 | 预制镜像卡的徽标写「预制」；整页不出现「预置」 | f-img-state-04 |
| [AC-IMG-033.2](./IMG.md#REQ-IMG-033) `偏离` | 「删除镜像版本」+ 一段话，确认按钮不是危险色，焦点不在 [取消]（ImagesContainer.tsx:278-287，ConfirmDialog.view.tsx:33-37）（稿件 f-img-state-02） | ImagesContainer.tsx:278-287、ConfirmDialog.view.tsx:33-37 | 标题「删除镜像「docker.io/acme/ml-agent:v1.0」？」；四段与清单来源（上表）；焦点在 [取消]；[删除镜像] 危险色 | f-img-state-02 |
| [AC-IMG-033.4](./IMG.md#REQ-IMG-033) `部分实现` | 结果已实现（useImages.ts:611-617，image-application.service.ts:399-409，imageManifestCards.ts:161-175）；进行中文案是「处理中…」（ConfirmDialog.view.tsx:37） | useImages.ts:611-617、image-application.service.ts:399-409、imageManifestCards.ts:161-175、ConfirmDialog.view.tsx:37 | 按钮「删除中…」禁用、Esc 不关；成功关弹层、轻提示「已删除。」；还有其他版本时卡片退回最近一版并显示「已禁用」+ [启用]；最后一版时整张卡消失（另需后端配合） | f-img-state-02 |
| [AC-IMG-033.5](./IMG.md#REQ-IMG-033) `偏离` | 弹层留着，只弹失败轻提示（useImages.ts:618-622） | useImages.ts:618-622 | 弹层不关，就地换成被拦态（REQ-IMG-034） | f-img-state-02 |
| [AC-IMG-034.1](./IMG.md#REQ-IMG-034) `未实现` | 现状打开的是普通确认，点了才 409 + 轻提示（useImages.ts:611-623）（稿件 f-img-state-03） | useImages.ts:611-623 | 打开即是被拦态（上文）；[删除镜像] 禁用并以 aria-describedby 指向原因；焦点在 [取消] | f-img-state-03 |
| [AC-IMG-034.2](./IMG.md#REQ-IMG-034) `未实现` | （还没有做；片段没写细节，见需求正文） | — | 弹层关闭；这一版转「已禁用」（同 AC-IMG-030.1）；焦点回到这张卡的 [删除] | f-img-state-03 |
| [AC-IMG-034.5](./IMG.md#REQ-IMG-034) `偏离` | 标题是「⚠️ 这一步现在做不了」（useImages.ts:226） | useImages.ts:226 | 标题「这一步现在做不了」（不带「⚠️」）+ 后端原话 | f-img-state-03 |
| [AC-IMG-040.1](./IMG.md#REQ-IMG-040) `未实现` | 镜像页没有这一块（只在向导第 3 步，PresetImageCheck.view.tsx:176-207；DR-36）（稿件 f-img-preset-01） | PresetImageCheck.view.tsx:176-207 | 预制镜像卡出现「下载到本机」块：一句为什么 + [准备镜像] +「ghcr.io/agent-infra/sandbox:latest → 本机镜像库 · 约 320 MB」（与向导第 3 步同一句：来源带 tag、去向「本机镜像库」；计划给不出体积时按 AC-IMG-040.3 只写前半句） | f-img-preset-01 |
| [AC-IMG-040.2](./IMG.md#REQ-IMG-040) `未实现` | （还没有做；片段没写细节，见需求正文） | — | 不出块 | f-img-preset-01 |
| [AC-IMG-040.4](./IMG.md#REQ-IMG-040) `部分实现` | 向导里已实现（usePresetImageProvision.ts:131-139）；镜像页未实现 | usePresetImageProvision.ts:131-139 | 自动开始一次；失败后不自动重开；镜像页那一处不自动开始 | f-img-preset-01 |
| [AC-IMG-041.2](./IMG.md#REQ-IMG-041) `偏离` | 阶段句拼了「· 37%」（usePresetImageProvision.ts:85-88），向导里百分比单独一行（PresetImageCheck.view.tsx:222-230） | usePresetImageProvision.ts:85-88、PresetImageCheck.view.tsx:222-230 | 进度条 37% + 行尾「37%」；阶段句「下载：…」不带「· 37%」 | f-img-preset-01、f-img-preset-02 |
| [AC-IMG-041.3](./IMG.md#REQ-IMG-041) `部分实现` | null 不当 0 已实现（usePresetImageProvision.test.tsx:73），那句话已实现（PresetImageCheck.view.tsx:215-220）；没有滑动条（稿件 f-img-preset-02） | usePresetImageProvision.test.tsx:73、PresetImageCheck.view.tsx:215-220 | 不出百分比、不出 0%；进度未知的滑动条 + 上文那句 | f-img-preset-01、f-img-preset-02 |
| [AC-IMG-042.1](./IMG.md#REQ-IMG-042) `部分实现` | 向导里已实现（usePresetImageProvision.ts:98-101，PresetImageCheck.view.tsx:250-276）；镜像页未实现（稿件 f-img-preset-03） | usePresetImageProvision.ts:98-101、PresetImageCheck.view.tsx:250-276 | 条撤掉；保留「校验完整性：正在校验镜像包（约 320 MB）…」；失败句（role="alert"）「校验 sha256 对不上：已停在校验这一步，没有装载。」；出路句；[准备镜像] 可点 | f-img-preset-03 |
| [AC-IMG-042.3](./IMG.md#REQ-IMG-042) `部分实现` | 后端已实现（system.controller.ts:250-259）；前端当一般失败显示（usePresetImageProvision.ts:105-109） | system.controller.ts:250-259、usePresetImageProvision.ts:105-109 | 开流之前 409 PRESET_IMAGE_NOT_PROVISIONABLE（message 是原因，sideEffectFree）；界面写这句原因、[准备镜像] 置灰 | f-img-preset-03 |
| [AC-IMG-042.5](./IMG.md#REQ-IMG-042) `未实现` | 后端原文「已经有一次搬运在进行中。⚠️ 这一步不是幂等的：两条流同时往 registry 写同一个 tag 是竞态」会被当失败原样上屏（preset-image-provisioner.ts:235-238，usePresetImageProvision.ts:105-109） | preset-image-provisioner.ts:235-238、usePresetImageProvision.ts:105-109 | 409 PRESET_IMAGE_PROVISION_IN_FLIGHT → 块里写「已经在下载了（之前发起的那一次还没结束），稍后回来看。」，不显示失败 | f-img-preset-03 |
| [AC-IMG-043.1](./IMG.md#REQ-IMG-043) `部分实现` | 向导里是「已放到位，正在重新检测…」并重跑检查（usePresetImageProvision.ts:95-97）；镜像页未实现 | usePresetImageProvision.ts:95-97 | 「已下载到本机，正在重新检测…」（role="status"）；重跑检查 | — |
| [AC-IMG-043.2](./IMG.md#REQ-IMG-043) `未实现` | 镜像页 | — | 块收起，预制镜像卡回到常态；不弹轻提示 | — |
| [AC-IMG-043.3](./IMG.md#REQ-IMG-043) `未实现` | 镜像页 | — | 块留着，写检查给的那句；[准备镜像] 可点 | — |
| [AC-IMG-050.2](./IMG.md#REQ-IMG-050) `部分实现` | 现状骨架四条，约 150 高，真实卡约 340（ImageCard.view.tsx:50-64）（稿件 f-img-page-02） | ImageCard.view.tsx:50-64 | 骨架与真实卡片高度相近，第一张卡的顶边位置不变 | f-img-page-02 |
| [AC-IMG-050.3](./IMG.md#REQ-IMG-050) `部分实现` | 骨架 aria-hidden 已实现；没有 aria-busy 与那句话 | — | 列表 aria-busy=true，播「正在读取镜像…」；骨架 aria-hidden | f-img-page-02 |
| [AC-IMG-051.1](./IMG.md#REQ-IMG-051) `偏离` | 结构与按钮已实现；说明句写「注册一张之后，它会出现在发起任务向导的镜像下拉里。」——旧称（ImagesContainer.tsx:96-127）（稿件 f-img-page-01） | ImagesContainer.tsx:96-127 | 虚线框空态：标题、说明「注册之后，它会出现在这个列表里；新建任务时，可以在「镜像」一栏选它。」、来源约束、两个按钮；[注册新镜像] 打开注册弹层，[查看镜像要求] 打开侧弹层 | f-img-page-01 |
| [AC-IMG-052.1](./IMG.md#REQ-IMG-052) `偏离` | 失败后「库里 0 行」判定成立（`noImagesAtAll = !isPending && 0 行`，useImages.ts:894-896），显示「还没有注册任何镜像」与 [注册新镜像]（ImagesContainer.tsx:96-127） | useImages.ts:894-896、ImagesContainer.tsx:96-127 | 骨架之后出现读取失败提示 + [重试]；没有空态 | f-img-page-03 |
| [AC-IMG-052.2](./IMG.md#REQ-IMG-052) `未实现` | （还没有做；片段没写细节，见需求正文） | — | 回到正常列表 | f-img-page-03 |

### 前端 · SYS（30）

| AC | 差在哪 | 出处 | 建议修法（目标行为） | 稿件 |
|---|---|---|---|---|
| [AC-SYS-001.4](./SYS.md#REQ-SYS-001) `未实现` | web 无 cmdk 依赖与快捷键处理 | — | 同 AC-SYS-001.1 | — |
| [AC-SYS-001.5](./SYS.md#REQ-SYS-001) `未实现` | sandboxErrorCopy.ts:371-377 只有 [重试]，且文案让 boxlite 用户去查 Docker | sandboxErrorCopy.ts:371-377 | 提示带 [运行诊断]（结果卡上的落点见 REQ-SBX-001），点击后效果同 AC-SYS-001.2 | — |
| [AC-SYS-002.3](./SYS.md#REQ-SYS-002) `未实现` | 设置区没有 Logo（全仓 grep 未命中） | — | 回到工作台 | — |
| [AC-SYS-011.3](./SYS.md#REQ-SYS-011) `偏离` | 严重档固定写「资源耗尽，现在建不了新任务」（resourceModel.ts:30），与创建闸门无关（Q-SYS-02）；主数字待 DR-08 | resourceModel.ts:30 | 主数字仍是 3；整体「严重 · 资源耗尽」+「停掉一些任务」类下一步；不出现「现在建不了新任务」 | f-sys-resource-02 |
| [AC-SYS-011.4](./SYS.md#REQ-SYS-011) `未实现` | 只有一句整体文案（resourceModel.ts:26-31）；没有稿件 | resourceModel.ts:26-31 | 结论块两句下一步：先内存（停掉一些任务），后磁盘（清理成果或删掉不用的项目） | f-sys-resource-02 |
| [AC-SYS-012.2](./SYS.md#REQ-SYS-012) `偏离` | 整体文案是「资源紧张，建议停掉一些任务」（resourceModel.ts:29）（稿件 f-sys-resource-04） | resourceModel.ts:29 | 磁盘行警告徽标 + 琥珀条 + 路径；整体「警告 · 资源紧张」+「磁盘快满了：清理成果或删掉不用的项目」；全卡不出现「停掉一些任务」；出现 [清理成果] | f-sys-resource-03、f-sys-resource-04 |
| [AC-SYS-012.3](./SYS.md#REQ-SYS-012) `偏离` | 没有按维度的下一步（稿件 f-sys-resource-03） | — | 磁盘行严重徽标 + 红条 + 路径；整体「严重 · 资源耗尽…」+「磁盘满了：清理成果或删掉不用的项目」；出现 [清理成果] | f-sys-resource-03、f-sys-resource-04 |
| [AC-SYS-020.5](./SYS.md#REQ-SYS-020) `未实现` | 全局横幅只有三类（globalBanner.ts:47-51） | globalBanner.ts:47-51 | 主列顶部出「保留下来的成果占了数据目录的 N%」治理横幅，[去清理] 打开跨项目视图（规格见 F-WB-BANNER） | f-sys-resource-03、f-sys-resource-04、f-prj-retained-05 |
| [AC-SYS-020.6](./SYS.md#REQ-SYS-020) `未实现` | 缺陷；页面没有传入回调，点击无反应（page.tsx:30，SystemStatusContainer.tsx:49-51；DR-27） | page.tsx:30、SystemStatusContainer.tsx:49-51 | 打开「保留下来的成果」对话框，范围「全部项目」、按项目分组；关闭后焦点回到 [清理成果] | f-sys-resource-03、f-sys-resource-04、f-prj-retained-05 |
| [AC-SYS-020.7](./SYS.md#REQ-SYS-020) `未实现` | 只多一颗按钮，没有提示句（ResourcePoolCard.view.tsx:157-183；DR-37）（稿件 f-sys-resource-04） | ResourcePoolCard.view.tsx:157-183 | 成果块多一行警告徽标 +「保留下来的成果已占数据目录的 82%，建议手动清理」（role="status"），其下是 [清理成果] | f-sys-resource-03、f-sys-resource-04、f-prj-retained-05 |
| [AC-SYS-020.9](./SYS.md#REQ-SYS-020) `偏离` | 「保留卷占用 …」（ResourcePoolCard.view.tsx:163）、按钮「清理保留卷」（ResourcePoolCard.view.tsx:181） | ResourcePoolCard.view.tsx:163、ResourcePoolCard.view.tsx:181 | 写「成果占用 …」与 [清理成果]；整张卡不出现「保留卷」 | f-sys-resource-03、f-sys-resource-04、f-prj-retained-05 |
| [AC-SYS-030.5](./SYS.md#REQ-SYS-030) `部分实现` | 窗口来自接口（sandboxEnvModel.ts:127-133）；阈值在前端写死两处（sandboxEnvModel.ts:21-22，SandboxEnvStatusCard.view.tsx:57），接口不下发 | sandboxEnvModel.ts:127-133、sandboxEnvModel.ts:21-22、SandboxEnvStatusCard.view.tsx:57 | 分区标题旁「健康统计窗口：最近 1 小时（阈值 >1% 警告 · >10% 故障）」，窗口与阈值都来自接口 | f-sys-conn-01、P5 |
| [AC-SYS-030.6](./SYS.md#REQ-SYS-030) `偏离` | 映射到 unknown 虚线（SandboxEnvStatusCard.view.tsx:108-111；UX-DS-133） | SandboxEnvStatusCard.view.tsx:108-111 | 该行前为「停用」灰色徽标（不是虚线「未知」），可访问名「凭证未配置」 | f-sys-conn-01、P5 |
| [AC-SYS-030.8](./SYS.md#REQ-SYS-030) `偏离` | 写「挂载工作区目录」（sandboxEnvModel.ts:61） | sandboxEnvModel.ts:61 | 能力写「挂载代码副本」，不写「工作区」 | f-sys-conn-01、P5 |
| [AC-SYS-031.1](./SYS.md#REQ-SYS-031) `未实现` | 没有接口（SandboxEnvStatusCard.view.tsx:10-12）；F21-5 §9.1 #8 标 ✅ 不实 | SandboxEnvStatusCard.view.tsx:10-12 | 卡片内展开最近若干行日志，父节点是卡片而不是弹层 | — |
| [AC-SYS-040.1](./SYS.md#REQ-SYS-040) `部分实现` | 正常 / 异常已实现（connectionModel.ts:51-61）；错误码没有传进来（useSystemStatusModels.ts:53 只传 ok）；稿件 f-sys-conn-03 也未画错误码 | connectionModel.ts:51-61、useSystemStatusModels.ts:53 | REST 行「正常（本页数据刚取回）」/「请求失败」+「异常」徽标 + 错误码 | P5、f-sys-resource-01、f-sys-conn-03 |
| [AC-SYS-040.4](./SYS.md#REQ-SYS-040) `偏离` | 数量已实现（connectionModel.ts:76-81），状态写死 ok（connectionModel.ts:75）；稿件照 v1 仍画「正常」，见待确认 Q-SYS-21 | connectionModel.ts:76-81、connectionModel.ts:75 | 终端连接行「0 个终端会话」，不挂「正常」徽标 | P5、f-sys-resource-01、f-sys-conn-03 |
| [AC-SYS-040.6](./SYS.md#REQ-SYS-040) `偏离` | 只看失败与否，首屏就写「正常」（useSystemStatusModels.ts:49）；稿件 f-sys-resource-01 照现状画，见待确认 Q-SYS-21 | useSystemStatusModels.ts:49 | REST 行「未知」，不写「正常（本页数据刚取回）」 | P5、f-sys-resource-01、f-sys-conn-03 |
| [AC-SYS-050.1](./SYS.md#REQ-SYS-050) `未实现` | page.tsx:17-18；后端 `PUT /api/system/access-passcode` 已有；F21-5 §9.1 #18 标 ✅ 不实 | page.tsx:17-18 | 两态都可见；已启用时没有掩码和明文（另需后端配合） | — |
| [AC-SYS-060.5](./SYS.md#REQ-SYS-060) `未实现` | 成功静默，只重取设置（useProxySettings.ts:45-50）（稿件 f-sys-conn-04） | useProxySettings.ts:45-50 | 表单末尾「已保存。下一轮联网检查会走这组代理。」（role="status"）；分区标题旁「已配置」中性徽标；没有轻提示 | P5、f-sys-conn-02、f-sys-conn-03、f-sys-conn-04 |
| [AC-SYS-060.6](./SYS.md#REQ-SYS-060) `未实现` | 读取失败回退三个空串、照常可存（useProxySettings.ts:35-43），保存会整体替换已存配置（system-settings.service.ts:133-134）（稿件 f-sys-conn-03） | useProxySettings.ts:35-43、system-settings.service.ts:133-134 | 不显示表单与「保存」；原位读取失败句（role="alert"）+ [重试]；点 [重试] 只重取设置（另需后端配合） | P5、f-sys-conn-02、f-sys-conn-03、f-sys-conn-04 |
| [AC-SYS-060.8](./SYS.md#REQ-SYS-060) `未实现` | （还没有做；片段没写细节，见需求正文） | — | 「已配置」① 不显示 ② 显示 ③ 去掉 | P5、f-sys-conn-02、f-sys-conn-03、f-sys-conn-04 |
| [AC-SYS-060.9](./SYS.md#REQ-SYS-060) `偏离` | 说明写「拉取沙箱镜像、访问模型接口都走这里」（ProxySettingsCard.view.tsx:38-41），实现只有联网检查读它（见上方核实）；稿件已按 Q-SYS-16 A 改了说明（f-sys-conn-01 等 19 张，W2 一致性；2026-10-04 用户拍板 A，与默认相同） | ProxySettingsCard.view.tsx:38-41 | 只承诺实际走这组代理的范围（今天 = 联网检查），并点破「能连上 ≠ 够快」（稿件句：「联网检查会走这组代理；镜像下载和沙箱里的 Agent 现在还不读它。检查只测得出「能不能连上」，测不出带宽。」） | P5、f-sys-conn-02、f-sys-conn-03、f-sys-conn-04 |
| [AC-SYS-070.1](./SYS.md#REQ-SYS-070) `偏离` | 一行「读取中…」（ResourcePoolCard.view.tsx:133，SandboxEnvStatusCard.view.tsx:68），没有 aria-busy（稿件 f-sys-resource-01） | ResourcePoolCard.view.tsx:133、SandboxEnvStatusCard.view.tsx:68 | 两张卡显示骨架，不出现「读取中…」文字行、不转圈；两张卡 aria-busy="true"；读屏念「本机资源读取中…」「沙箱环境读取中…」 | f-sys-resource-01 |
| [AC-SYS-070.2](./SYS.md#REQ-SYS-070) `未实现` | （还没有做；片段没写细节，见需求正文） | — | 两张卡的高度变化不超过一行；骨架各块与读完后的块一一对位 | f-sys-resource-01 |
| [AC-SYS-071.2](./SYS.md#REQ-SYS-071) `未实现` | 稿件 f-sys-resource-03 | — | 「还能再发 0 个任务」+ 红色 circle-x；口径句以「新任务会被拒绝：<basis 的原因>。」开头（稿件示例「磁盘已用 96%」） | f-sys-resource-02、f-sys-resource-03、f-sys-resource-04、f-sys-… |
| [AC-SYS-071.3](./SYS.md#REQ-SYS-071) `未实现` | 稿件 f-sys-resource-02；3 见 f-sys-conn-01 等正常场景稿与 P5 | — | 1：琥珀 triangle-alert；3：没有图标；两种情况数字都是正文色（3 = 正常场景，示例口径句「已登记 8 个任务（含已停止的），本机最多 11 个」：8 = 示例世界里没异常的任务，11 是待契约示例值） | f-sys-resource-02、f-sys-resource-03、f-sys-resource-04、f-sys-… |
| [AC-SYS-071.4](./SYS.md#REQ-SYS-071) `未实现` | DR-03 A | — | 口径句写「已登记 5 个任务（含已停止的）」 | f-sys-resource-02、f-sys-resource-03、f-sys-resource-04、f-sys-… |
| [AC-SYS-075.1](./SYS.md#REQ-SYS-075) `偏离` | 本页仍显示「查看系统状态」，点了跳回本页（globalBanner.ts:75，GlobalBannerContainer.tsx:50-53） | globalBanner.ts:75、GlobalBannerContainer.tsx:50-53 | 横幅「无法确认平台状态」只有 ×，没有「查看系统状态」 | f-sys-conn-03 |
| [AC-SYS-075.2](./SYS.md#REQ-SYS-075) `部分实现` | 出网代理仍显示可保存的空表单（AC-SYS-060.6），其余已实现（稿件 f-sys-conn-03） | — | 资源卡、沙箱环境卡各一句读取失败（role="alert"），没有 0%、空条或空列表；连接卡 REST「异常」；出网代理不显示表单；诊断「尚未运行」可点；审计流失败 + [重试]；没有遮罩 | f-sys-conn-03 |

### 前端 · DIA（8）

| AC | 差在哪 | 出处 | 建议修法（目标行为） | 稿件 |
|---|---|---|---|---|
| [AC-DIA-001.4](./SYS.md#REQ-DIA-001) `部分实现` | 文案、禁用、[导出日志] 可点已实现（DiagnosticsCard.view.tsx:64-70、93-96）；按钮没有转圈、该句没有 role="status"（稿件 f-sys-diag-01） | DiagnosticsCard.view.tsx:64-70、93-96 | 按钮「诊断中…」禁用并带转圈；[导出日志] 仍可点；卡内首行「正在连接诊断流…（检查清单由服务端下发）」以 role="status" 播报；不画任何检查项 | f-sys-diag-01、f-sys-diag-02 |
| [AC-DIA-002.3](./SYS.md#REQ-DIA-002) `偏离` | 只备 ①–⑧，第 9 项不显示序号（DiagnosticItem.view.tsx:59、79、93）；format-pilot B-03 建议直接修 | DiagnosticItem.view.tsx:59、79、93 | 9 项都有序号 ①–⑨（原文「都有序号标识」，验证层由集成改为组件） | f-sys-diag-02 |
| [AC-DIA-003.2](./SYS.md#REQ-DIA-003) `偏离` | 徽标文字是「未得出结论」（DiagnosticItem.view.tsx:50-51）；定稿词见 Q-DS-21 A，Q-DIA-02 待裁决（稿件 f-sys-diag-04） | DiagnosticItem.view.tsx:50-51 | 徽标「超时未响应」（时钟、超时色调），结论句「10 秒内没有结果」，默认展开；不出现「失败」 | f-sys-diag-03、f-sys-diag-04 |
| [AC-DIA-003.5](./SYS.md#REQ-DIA-003) `部分实现` | 前半句已实现（diagnoseModel.ts:224-226）；后半句固定拼「—— 已到达的结果保留在下方，…」（DiagnosticsCard.view.tsx:89），没有结果时这半句不成立 | diagnoseModel.ts:224-226、DiagnosticsCard.view.tsx:89 | 首行中断句「诊断中断：连接在拿到检查清单之前就断了 —— 可点 [重新诊断] 重跑」，不画占位 | f-sys-diag-03、f-sys-diag-04 |
| [AC-DIA-003.6](./SYS.md#REQ-DIA-003) `偏离` | 仍显示转圈的「检查中…」（DiagnosticItem.view.tsx:75-76、101-103）（稿件 f-sys-diag-03） | DiagnosticItem.view.tsx:75-76、101-103 | 这 4 项显示「未返回」虚线徽标，不转圈、没有结论句、没有展开按钮 | f-sys-diag-03、f-sys-diag-04 |
| [AC-DIA-030.1](./SYS.md#REQ-DIA-030) `未实现` | 仓库中没有 diagnose.sh | — | 输出 Node 版本、原生模块、数据目录、端口等检查结果 | — |
| [AC-DIA-040.1](./SYS.md#REQ-DIA-040) `偏离` | 现状「6 项正常 · 1 项警告 · 2 项失败（含超时） · 整轮 10s」（diagnoseModel.ts:198-210；failCount 含超时，diagnostics.service.ts:116-119） | diagnoseModel.ts:198-210、diagnostics.service.ts:116-119 | 首行「6 项正常 · 1 项警告 · 1 项失败 · 1 项超时未响应 · 整轮 10s」（另需后端配合） | f-sys-diag-04、f-sys-diag-05、f-sys-diag-06 |
| [AC-DIA-040.4](./SYS.md#REQ-DIA-040) `部分实现` | 汇总在卡底、没有 role（DiagnosticsCard.view.tsx:124-128） | DiagnosticsCard.view.tsx:124-128 | 汇总句在卡内首行、以 role="status" 播报一次；不弹轻提示 | f-sys-diag-04、f-sys-diag-05、f-sys-diag-06 |

### 前端 · AUD（8）

| AC | 差在哪 | 出处 | 建议修法（目标行为） | 稿件 |
|---|---|---|---|---|
| [AC-AUD-002.4](./SYS.md#REQ-AUD-002) `偏离` | 第二项是「沙箱」（AuditFilterBar.view.tsx:23-29），条件句同样写「类别：沙箱」（auditStream.ts:259-265） | AuditFilterBar.view.tsx:23-29、auditStream.ts:259-265 | 选项为 全部 / 任务 / 项目 / 凭证 / 镜像 / 系统；条件句写「类别：任务」 | f-sys-audit-02 |
| [AC-AUD-003.3](./SYS.md#REQ-AUD-003) `部分实现` | 就地按 subjectId 筛已实现（AuditStreamContainer.tsx:36-45，web/e2e/systemAudit.spec.ts:174）；筛选条里没有这个条件（只在空态句里写「对象：<id>」，auditStream.ts:278）；其余筛选保留（useAuditFilters.ts:37-38）（稿件 f-sys-audit-06） | AuditStreamContainer.tsx:36-45、web/e2e/systemAudit.spec.ts:174、auditStream.ts:278、useAuditFilters.ts:37-38 | 列表只剩该任务的事件（含信息级）；筛选条末尾出现「任务：迁移构建脚本」；类别 / 仅告警 / 起止回到默认 | f-sys-audit-04、f-sys-audit-06 |
| [AC-AUD-003.4](./SYS.md#REQ-AUD-003) `未实现` | 筛选条里没有这个条件，只能用空态里的 [清除筛选]（useAuditFilters.ts:62-68） | useAuditFilters.ts:62-68 | 回到全部记录，四项筛选都在默认；焦点回到筛选条第一个控件 | f-sys-audit-04、f-sys-audit-06 |
| [AC-AUD-003.5](./SYS.md#REQ-AUD-003) `偏离` | 文案「查看该沙箱完整时间线」（auditRowModel.ts:50）；筛选后仍出现（AuditEventRow.view.tsx:100-112） | auditRowModel.ts:50、AuditEventRow.view.tsx:100-112 | 文案「查看该任务完整时间线」；按该任务筛选后这一列不再出现 | f-sys-audit-04、f-sys-audit-06 |
| [AC-AUD-020.2](./SYS.md#REQ-AUD-020) `偏离` | 条件句是 ISO 原串，如「起：2026-10-02T07:00:00.000Z」（auditStream.ts:279）（稿件 f-sys-audit-05） | auditStream.ts:279 | 「当前筛选无匹配记录」+「起：10月2日 15:00」+ [清除筛选] | f-sys-audit-05 |
| [AC-AUD-020.3](./SYS.md#REQ-AUD-020) `未实现` | 照常发 from 晚于 to 的请求，返回空后显示「当前筛选无匹配记录」（前端 useAuditFilters.ts:49-60 不比较起止；后端只判 since / before 互斥，audit.controller.ts:121-123，from / to 原样下传，:127-128）（稿件 f-sys-audit-05） | useAuditFilters.ts:49-60、audit.controller.ts:121-123 | 「止」标错误态（aria-invalid）+ 筛选条下一行就地提示（role="alert"）；不发请求；列表与条件句仍是上一次的（另需后端配合） | f-sys-audit-05 |
| [AC-AUD-020.4](./SYS.md#REQ-AUD-020) `未实现` | 同 AC-AUD-020.2 | — | 带年份，如「起：2025年12月31日 23:00」 | f-sys-audit-05 |
| [AC-AUD-020.6](./SYS.md#REQ-AUD-020) `未实现` | 同 AC-AUD-020.3；条件句写法同 AC-AUD-020.2 | — | 提示消失、「止」去掉错误态；按新范围从头拉；仍然筛空时条件句是「起：10月2日 15:00 · 止：10月2日 18:30」 | f-sys-audit-05 |

### 前端 · WB（51）

| AC | 差在哪 | 出处 | 建议修法（目标行为） | 稿件 |
|---|---|---|---|---|
| [AC-WB-001.1](./WB.md#REQ-WB-001) `部分实现` | 「未选择项目」静态不可点已实现（CurrentProjectIndicator.view.tsx:23-28）；侧栏仍常驻「搜索任务」与状态筛选（WorkbenchShell.view.tsx:358-416） | CurrentProjectIndicator.view.tsx:23-28、WorkbenchShell.view.tsx:358-416 | 树区没有任何行；「项目」分区标题旁只有「新建项目」图标按钮，没有筛选控件；顶栏左侧「未选择项目」不是按钮 | f-wb-welcome-01、f-wb-welcome-02 |
| [AC-WB-001.2](./WB.md#REQ-WB-001) `偏离` | 原因句是「先在左侧选中一个项目」（WorkbenchContainer.tsx:283-284）；按钮用 `disabled`（不可聚焦）+ 下方常驻一行（WorkbenchShell.view.tsx:575-587） | WorkbenchContainer.tsx:283-284、WorkbenchShell.view.tsx:575-587 | 不打开弹层；提示「先新建一个项目」，按钮的 aria-describedby 指向同一句 | f-wb-welcome-01、f-wb-welcome-02 |
| [AC-WB-002.1](./WB.md#REQ-WB-002) `未实现` | WorkbenchContainer.tsx:321-325 | WorkbenchContainer.tsx:321-325 | 主区是欢迎态：标题「为你的代码建一个项目」、两张卡「用我的代码库」「开一个空项目」、「第二步」一句；不出现「选择左侧项目，或新建一个项目开始。」 | f-wb-welcome-01 |
| [AC-WB-002.2](./WB.md#REQ-WB-002) `未实现` | （还没有做；片段没写细节，见需求正文） | — | 打开新建项目弹层，来源 = Git 仓库，焦点在仓库地址输入框 | f-wb-welcome-01 |
| [AC-WB-002.3](./WB.md#REQ-WB-002) `未实现` | （还没有做；片段没写细节，见需求正文） | — | 打开同一弹层，来源 = 空项目，名称框为「未命名项目 1」且可编辑；此时还没有发出任何创建请求 | f-wb-welcome-01 |
| [AC-WB-002.4](./WB.md#REQ-WB-002) `未实现` | 后端不自动命名 | — | 「未命名项目 4」；没有任何「未命名项目 N」时为「未命名项目 1」 | f-wb-welcome-01 |
| [AC-WB-002.5](./WB.md#REQ-WB-002) `未实现` | （还没有做；片段没写细节，见需求正文） | — | 弹层关闭，仍是欢迎态，焦点回到刚才点的那张卡 | f-wb-welcome-01 |
| [AC-WB-003.1](./WB.md#REQ-WB-003) `部分实现` | 建好后自动选中已实现（WorkbenchContainer.tsx:183-188）；空态归 F-PRJ-CREATE / P6 | WorkbenchContainer.tsx:183-188 | 树里出现并选中该项目；主区为它的「还没有任务」空态，带 [发起第一个任务]；欢迎态消失 | f-wb-welcome-02 |
| [AC-WB-003.2](./WB.md#REQ-WB-003) `部分实现` | 主区只有一句「项目正在克隆，克隆完就能发起任务。」（WorkbenchContainer.tsx:313-319） | WorkbenchContainer.tsx:313-319 | 不显示欢迎态，主区显示该项目的克隆进度（F-PRJ-CLONE） | f-wb-welcome-02 |
| [AC-WB-003.3](./WB.md#REQ-WB-003) `部分实现` | 向导卸载后进入工作台（AppBootGate.tsx），但第一屏是一句话而不是欢迎态 | AppBootGate.tsx | 向导卸载；第一屏为欢迎态；没有「初始化完成」类提示；焦点在主区标题 | f-wb-welcome-02 |
| [AC-WB-010.1](./WB.md#REQ-WB-010) `偏离` | 横幅栈挂在根布局、整宽在页顶（app/layout.tsx:66-69） | app/layout.tsx:66-69 | 横幅都在顶栏之下、内容之上，左缘与主列对齐；侧栏顶部（实例菜单、查找）不被压住 | f-wb-banner-01、f-wb-banner-02、f-wb-banner-03 |
| [AC-WB-011.2](./WB.md#REQ-WB-011) `未实现` | 没有折叠（types/banner.ts:11-13） | types/banner.ts:11-13 | 显示前 2 条 + 一行「还有 1 条提示」（带第 3 条的标题），aria-expanded="false"；点开后 3 条全显示，aria-expanded="true" | f-wb-banner-02、f-wb-banner-03 |
| [AC-WB-012.2](./WB.md#REQ-WB-012) `偏离` | 语义已实现（globalBanner.ts:114-137；bannerDismissedToday 持久化，stores/index.ts:64）；按钮文字是「关闭」（BannerStack.view.tsx:97-105） | globalBanner.ts:114-137、stores/index.ts:64、BannerStack.view.tsx:97-105 | 当天（含刷新后）不再出现；第二天重新出现 | f-wb-banner-01、f-wb-banner-02、f-wb-banner-03 |
| [AC-WB-013.3](./WB.md#REQ-WB-013) `部分实现` | 点了打开当前项目的弹层已实现（GlobalBannerContainer.tsx:36-48）；数据只来自当前选中项目、且要打开过该项目的自动化弹层才有（automationAttention.ts:120-134），后端没有跨项目概览接口 | GlobalBannerContainer.tsx:36-48、automationAttention.ts:120-134 | 出治理横幅「有 1 条定时规则已自动停用」，说明点名「示例项目 的「每日报表」」；点了打开示例项目的自动化规则（列表视图），当前选中不变（另需后端配合） | f-wb-banner-01、f-wb-banner-02、f-wb-banner-03、f-wb-banner-04 |
| [AC-WB-013.4](./WB.md#REQ-WB-013) `未实现` | 容器不看当前路由，系统状态页上照样显示 [查看系统状态]（GlobalBannerContainer.tsx:31-55） | GlobalBannerContainer.tsx:31-55 | 前者没有 [查看系统状态]、只有关闭；离线横幅的 [重新检测] 照常显示 | f-wb-banner-01、f-wb-banner-02、f-wb-banner-03、f-wb-banner-04 |
| [AC-WB-013.5](./WB.md#REQ-WB-013) `未实现` | 判定只看一个项目的规则列表（automationAttention.ts:45-97），说明不点名项目与规则 | automationAttention.ts:45-97 | 一条治理横幅：标题「有 3 条定时规则已自动停用」；说明先列 3 条自动停用的「<项目> 的「<规则>」」，再「等共 4 条」；[查看这些规则] 去第一条所在的项目 | f-wb-banner-01、f-wb-banner-02、f-wb-banner-03、f-wb-banner-04 |
| [AC-WB-013.6](./WB.md#REQ-WB-013) `未实现` | 概览接口还没有；读取失败时的处理随横幅的取数一起改（useGlobalBanner.ts） | useGlobalBanner.ts | 不出「自动化需关注」；其它横幅照常；不拿当前项目缓存的列表冒充 | f-wb-banner-01、f-wb-banner-02、f-wb-banner-03、f-wb-banner-04 |
| [AC-WB-014.5](./WB.md#REQ-WB-014) `部分实现` | 只有侧栏 [＋ 新任务] 接了离线判定（useOfflineMode 只在 WorkbenchContainer.tsx:68、282 使用）；空组「发起第一个任务 →」不看禁用原因、照样打开弹层（WorkbenchShell.view.tsx:503-521，WorkbenchContainer.tsx:378-380）；弹层 [发起] 与 [立即触发] 未置灰 | WorkbenchContainer.tsx:68、282、WorkbenchShell.view.tsx:503-521、WorkbenchContainer.tsx:378-380 | 都置灰并说「离线模式：需连接网络才能发起任务」；新建项目、凭证配置照常可用 | f-wb-banner-01、f-wb-banner-02 |
| [AC-WB-015.1](./WB.md#REQ-WB-015) `未实现` | （还没有做；片段没写细节，见需求正文） | — | 治理横幅「磁盘快满了」，说明含「已用 88%，还剩 60 GB」，动作 [去清理] | f-wb-banner-03 |
| [AC-WB-015.2](./WB.md#REQ-WB-015) `未实现` | （还没有做；片段没写细节，见需求正文） | — | 「磁盘已满」，仍是治理类，不是阻断 | f-wb-banner-03 |
| [AC-WB-015.3](./WB.md#REQ-WB-015) `未实现` | （还没有做；片段没写细节，见需求正文） | — | 「保留下来的成果占了数据目录的 82%」+ [去清理] | f-wb-banner-03 |
| [AC-WB-015.4](./WB.md#REQ-WB-015) `未实现` | 数据已有：runtime-credential.service.ts:285-291 | runtime-credential.service.ts:285-291 | 两条：「Codex 的帐号登录 5 天后过期」「Claude Code 的帐号登录已过期」，都是治理类，动作 [重新登录] | f-wb-banner-03 |
| [AC-WB-015.5](./WB.md#REQ-WB-015) `未实现` | Q-DS-33 A；F-PRJ-RETAINED | — | 打开跨项目的「保留下来的成果」（范围「全部项目」） | f-wb-banner-03 |
| [AC-WB-015.6](./WB.md#REQ-WB-015) `未实现` | F-AUTH-PANEL | — | 跳到凭证管理，Codex 的登录面板已展开 | f-wb-banner-03 |
| [AC-WB-015.7](./WB.md#REQ-WB-015) `未实现` | （还没有做；片段没写细节，见需求正文） | — | 不出磁盘与成果两条 | f-wb-banner-03 |
| [AC-WB-030.1](./WB.md#REQ-WB-030) `未实现` | 只有一个 aria-hidden 的「⌘K」字样（WorkbenchShell.view.tsx:218-229） | WorkbenchShell.view.tsx:218-229 | 面板打开、焦点在输入框；Esc 后面板关闭、焦点回到打开前的元素 | f-wb-cmdk-01 |
| [AC-WB-030.2](./WB.md#REQ-WB-030) `未实现` | （还没有做；片段没写细节，见需求正文） | — | 只剩动作组两条：「新建项目…」（名称开头命中）排第一，「新任务…」（同义词「新建任务」）排第二 | f-wb-cmdk-01 |
| [AC-WB-030.3](./WB.md#REQ-WB-030) `未实现` | （还没有做；片段没写细节，见需求正文） | — | 列表收起（combobox aria-expanded="false"），说「没有找到匹配“zzz”的结果」 | f-wb-cmdk-01 |
| [AC-WB-031.1](./WB.md#REQ-WB-031) `未实现` | （还没有做；片段没写细节，见需求正文） | — | 动作组 12 条：新任务… / 新建项目… / 注册新镜像… / 运行诊断 / 自动化规则 · 示例项目（1 条）· acme-web（4 条）· docs-site（还没有规则）/ 保留下来的成果 · 示例项目（2 份）· acme-web（1 份）/ 切到亮色 / 收起侧栏 / 清屏（禁用）；没有 acme-api、infra-scripts 的项 | f-wb-cmdk-01、f-wb-cmdk-02 |
| [AC-WB-031.2](./WB.md#REQ-WB-031) `未实现` | （还没有做；片段没写细节，见需求正文） | — | 只有一条「自动化规则…」，说明 acme-web | f-wb-cmdk-01、f-wb-cmdk-02 |
| [AC-WB-031.3](./WB.md#REQ-WB-031) `未实现` | （还没有做；片段没写细节，见需求正文） | — | 面板关闭，跳到系统状态并自动开始一轮诊断 | f-wb-cmdk-01、f-wb-cmdk-02 |
| [AC-WB-031.4](./WB.md#REQ-WB-031) `未实现` | （还没有做；片段没写细节，见需求正文） | — | 弹层打开过；关掉后焦点回到打开面板前的元素 | f-wb-cmdk-01、f-wb-cmdk-02 |
| [AC-WB-031.5](./WB.md#REQ-WB-031) `未实现` | （还没有做；片段没写细节，见需求正文） | — | 跳到镜像管理并打开注册弹层 | f-wb-cmdk-01、f-wb-cmdk-02 |
| [AC-WB-032.1](./WB.md#REQ-WB-032) `未实现` | （还没有做；片段没写细节，见需求正文） | — | 没有任何删除 / 销毁 / 禁用类条目 | f-wb-cmdk-02 |
| [AC-WB-032.2](./WB.md#REQ-WB-032) `未实现` | （还没有做；片段没写细节，见需求正文） | — | 不执行；该行禁用，说明「离线模式：需连接网络才能发起任务」 | f-wb-cmdk-02 |
| [AC-WB-040.1](./WB.md#REQ-WB-040) `未实现` | 原型 parseHash 遇未知 token 静默回落（proto.js:272-305）；真实应用任务不进地址（P20 L428） | proto.js:272-305 | 仍是总览，顶部「找不到任务「迁移构建脚本」：可能已被销毁。」；地址变回总览，历史里没有新增坏记录 | f-wb-route-01 |
| [AC-WB-040.2](./WB.md#REQ-WB-040) `未实现` | （还没有做；片段没写细节，见需求正文） | — | 总览 + 「找不到这个任务：可能已被销毁。」 | f-wb-route-01 |
| [AC-WB-040.3](./WB.md#REQ-WB-040) `部分实现` | 不开弹窗、抹掉参数已实现（useDeepLinkModal.ts:83-119），没有提示句 | useDeepLinkModal.ts:83-119 | 不开弹窗；回落 + 「找不到这个项目：可能已被删除。」；两个参数从地址抹掉 | f-wb-route-01 |
| [AC-WB-040.4](./WB.md#REQ-WB-040) `部分实现` | 静默清掉（useSandboxRestore.ts:131-143） | useSandboxRestore.ts:131-143 | 清掉选中，回落 + 「找不到这个任务：可能已被销毁。」 | f-wb-route-01 |
| [AC-WB-040.5](./WB.md#REQ-WB-040) `未实现` | （还没有做；片段没写细节，见需求正文） | — | 播报为「找不到…。已打开 项目总览」；关闭或离开后提示消失 | f-wb-route-01 |
| [AC-WB-040.6](./WB.md#REQ-WB-040) `未实现` | app 下没有 not-found.tsx，落 Next 默认 404 | not-found.tsx | 回落总览 + 「这个地址没有对应的页面，已打开项目总览。」 | f-wb-route-01 |
| [AC-WB-050.1](./WB.md#REQ-WB-050) `未实现` | 实现没有总览；树的筛选是组件内状态，WorkbenchShell.view.tsx:376-458 | WorkbenchShell.view.tsx:376-458 | 工具行与树分区下各出现 chip「等待输入」；树只剩有等待输入任务的组 | f-wb-overview-01 |
| [AC-WB-050.2](./WB.md#REQ-WB-050) `未实现` | （还没有做；片段没写细节，见需求正文） | — | 需要你处理只剩等待输入的 2 条；项目卡只剩 acme-web，卡上计数只写「2 等待你输入」；分区标题行右侧「按筛选显示 1 个 / 共 5 个」；本机资源卡不变 | f-wb-overview-01 |
| [AC-WB-050.3](./WB.md#REQ-WB-050) `未实现` | （还没有做；片段没写细节，见需求正文） | — | 前者写「等待输入的任务都列在「需要你处理」里」；后者写「没有准备中的任务」 | f-wb-overview-01 |
| [AC-WB-050.4](./WB.md#REQ-WB-050) `未实现` | （还没有做；片段没写细节，见需求正文） | — | 两处 chip 都消失，回到「全部」 | f-wb-overview-01 |
| [AC-WB-051.1](./WB.md#REQ-WB-051) `未实现` | 实现没有总览 | — | 没有视图切换控件；只有搜索、筛选（含已选 chip）与「新建 ⌄」 | f-wb-overview-01、f-wb-route-01 |
| [AC-WB-060.1](./WB.md#REQ-WB-060) `未实现` | 实现没有实例菜单，只有顶栏「设置」下拉（凭证管理 / 镜像管理 / 系统状态 + 外观，WorkbenchShell.view.tsx:230-333） | WorkbenchShell.view.tsx:230-333 | 只有「系统状态」「外观」三选一、「快捷键」；没有「文档」 | 全部 f-wb 稿的实例菜单 |
| [AC-WB-061.1](./WB.md#REQ-WB-061) `未实现` | 首屏只有一行「正在检查平台初始化状态…」（AppBootGate.tsx:38-48），之后没有工作台骨架（WorkbenchContainer.tsx:289-326） | AppBootGate.tsx:38-48、WorkbenchContainer.tsx:289-326 | 树区与面包屑是骨架；[新任务] 与「更多操作」禁用，悬停不出原因 | f-wb-shell-01 |
| [AC-WB-061.2](./WB.md#REQ-WB-061) `未实现` | （还没有做；片段没写细节，见需求正文） | — | 都能用 | f-wb-shell-01 |
| [AC-WB-062.3](./WB.md#REQ-WB-062) `偏离` | 两张卡是一行「读取中…」（ResourcePoolCard.view.tsx:133、SandboxEnvStatusCard.view.tsx:68；UX-DS-304 → T-7） | ResourcePoolCard.view.tsx:133、SandboxEnvStatusCard.view.tsx:68 | 资源卡与沙箱环境卡是骨架（不是一行「读取中…」） | f-crd-page-01、f-img-page-02、f-sys-resource-01 |
| [AC-WB-063.4](./WB.md#REQ-WB-063) `部分实现` | 被拒那一支已实现（TerminalMount.tsx:105-112）；不存在那一支没有保护——`navigator.clipboard.writeText` 同步抛 TypeError，失败回调走不到，没有任何反馈（同样的写法在 SandboxLifecycleContainer.tsx:66-75）；现有测试只替身了「存在但拒绝」（TerminalMount.test.tsx:436、456） | TerminalMount.tsx:105-112、SandboxLifecycleContainer.tsx:66-75、TerminalMount.test.tsx:436、456 | 两种都出「复制失败，请手动选中终端内容复制」 | — |

### 前端 · EVT（3）

| AC | 差在哪 | 出处 | 建议修法（目标行为） | 稿件 |
|---|---|---|---|---|
| [AC-EVT-001.1](./WB.md#REQ-EVT-001) `偏离` | connState 不渲染（useSandboxEventsSocket.ts:15-17；WorkbenchContainer.tsx:101-115 丢弃返回值） | useSandboxEventsSocket.ts:15-17、WorkbenchContainer.tsx:101-115 | 查找框下出现 role="status" 提示「实时更新已中断，正在重连…」「列表可能不是最新的」，位于导航与等待徽标之上；没有按钮 | f-wb-live-03 |
| [AC-EVT-002.1](./WB.md#REQ-EVT-002) `未实现` | 重连成功不触发任何重取（useSandboxEventsSocket.ts:141-153 只更新 connState）；内存状态只在没有记录时才用 DTO 种子（useSandboxRestore.ts:120-123） | useSandboxEventsSocket.ts:141-153、useSandboxRestore.ts:120-123 | 立刻重新请求任务列表与项目列表；A 显示运行中，B 从树里消失；侧栏提示消失 | f-wb-live-03 |
| [AC-EVT-002.2](./WB.md#REQ-EVT-002) `未实现` | （还没有做；片段没写细节，见需求正文） | — | C 的状态由详情查询更新为运行中 | f-wb-live-03 |

### 前端 · AUT（35）

| AC | 差在哪 | 出处 | 建议修法（目标行为） | 稿件 |
|---|---|---|---|---|
| [AC-AUT-001.2](./AUT.md#REQ-AUT-001) `未实现` | 现状空态占位没有这条链接（matrix U-22；稿件 f-aut-rules-03） | — | 打开同一个弹层，落在空态（REQ-AUT-006） | f-aut-rules-01、f-aut-rules-03 |
| [AC-AUT-001.3](./AUT.md#REQ-AUT-001) `未实现` | web 没有命令面板（package.json 无 cmdk）；面板本身归 F-WB-CMDK | package.json | 打开 acme-web 的弹层，落在列表视图 | f-aut-rules-01、f-aut-rules-03 |
| [AC-AUT-001.4](./AUT.md#REQ-AUT-001) `部分实现` | 回到工作台并打开弹层已实现，打开的是当前项目的（GlobalBannerContainer.tsx:40-48）；横幅还不按全部项目判定（REQ-WB-013） | GlobalBannerContainer.tsx:40-48 | 回到工作台并打开示例项目的弹层（列表视图）；当前选中的项目与任务不变 | f-aut-rules-01、f-aut-rules-03 |
| [AC-AUT-002.1](./AUT.md#REQ-AUT-002) `部分实现` | 单一对话框已实现（AutomationsPanelContainer.tsx:4-6 及其测试）；删除确认不是视图（REQ-AUT-024） | AutomationsPanelContainer.tsx:4-6 | 全程只有一个 `role="dialog"`；前三个视图的标题与副标题不变 | f-aut-rules-01…11 |
| [AC-AUT-002.3](./AUT.md#REQ-AUT-002) `偏离` | AppDialog 整体在 90vh 内滚动，标题与 ✕ 随内容滚走（v1 g7-12b 头注释；稿件 f-aut-rules-02、05、08） | — | 标题、✕ 与页脚 [取消] [保存规则] 一直在视野里；头部底边出现分隔线 | f-aut-rules-01…11 |
| [AC-AUT-003.1](./AUT.md#REQ-AUT-003) `偏离` | 摘要写 runtime id「codex · …」（automationModel.ts:46，DR-24）；下次触发已实现（automationModel.ts:73-89） | automationModel.ts:46、automationModel.ts:73-89 | 摘要「Codex · 每天 03:00 · 下次: 10-3 03:00」 | f-aut-rules-01 |
| [AC-AUT-003.5](./AUT.md#REQ-AUT-003) `偏离` | 现状用 Pause（AutomationListItem.view.tsx:28-37、AutomationDetail.view.tsx:26-36）；Q-DS-15 ②A | AutomationListItem.view.tsx:28-37、AutomationDetail.view.tsx:26-36 | 图标为停用灰方块（不是暂停符号），状态句次要灰 | f-aut-rules-01 |
| [AC-AUT-004.5](./AUT.md#REQ-AUT-004) `部分实现` | Webhook 已实现（automation.notifier.ts:82-112）；横幅只读**当前选中项目**已缓存的规则列表，没打开过弹层的项目不会触发（useAutomations.ts:96-111，「不知道」≠「没问题」，见 F-WB-BANNER） | automation.notifier.ts:82-112、useAutomations.ts:96-111 | 仍发一条 `automation.degraded`；同一状态不重复发；任何页面都出治理横幅（不必打开过这个项目的弹层）（另需后端配合） | f-aut-rules-01、f-aut-rules-08 |
| [AC-AUT-005.1](./AUT.md#REQ-AUT-005) `部分实现` | 原因与置灰已实现（AutomationList.view.tsx:78-87），但用 `disabled`（键盘到不了）、原因在列表末尾随正文滚动（稿件 f-aut-rules-02） | AutomationList.view.tsx:78-87 | 页脚左侧原因句、右侧 [新建规则] `aria-disabled="true"` 且 `aria-describedby` 指向原因；Tab 能停在按钮上 | f-aut-rules-02 |
| [AC-AUT-006.3](./AUT.md#REQ-AUT-006) `部分实现` | 有失败句、不显示空态（AutomationList.view.tsx:44-60）；句子是码表原句「服务出错了，稍后再试。」，没有 [重试] | AutomationList.view.tsx:44-60 | 失败条「规则没读出来：服务出错了。」+ [重试]（role="alert"），没有空态 | f-aut-rules-03、f-aut-rules-13 |
| [AC-AUT-006.4](./AUT.md#REQ-AUT-006) `未实现` | 没有重试入口 | — | 失败条换成「正在读取自动化规则…」，成功后出列表或空态 | f-aut-rules-03、f-aut-rules-13 |
| [AC-AUT-010.4](./AUT.md#REQ-AUT-010) `偏离` | 后两项写「（v1.2）」（AutomationForm.view.tsx:258、267，DR-35 第 9 条） | AutomationForm.view.tsx:258、267 | 并发模式三项：跳过（选中）、「排队（还没开放）」「并发（还没开放）」不可选 | f-aut-rules-04 |
| [AC-AUT-012.2](./AUT.md#REQ-AUT-012) `部分实现` | 选项与默认已实现（WebhookSection.view.tsx:26-29）；地址框与单选组没有可访问名称（稿件 f-aut-rules-04 第 9 条） | WebhookSection.view.tsx:26-29 | 地址框带名称「Webhook URL」；三项单选在一个带名称的 radiogroup 里，默认「仅失败（含超时）」 | f-aut-rules-04、f-aut-rules-05 |
| [AC-AUT-012.3](./AUT.md#REQ-AUT-012) `部分实现` | WebhookSection.view.tsx:91-109，成功句没有 role="status"，整句绿字 | WebhookSection.view.tsx:91-109 | 「测试中…」禁用 → 绿色圆勾 +「测试消息已经送到了」（role="status"） | f-aut-rules-04、f-aut-rules-05 |
| [AC-AUT-013.2](./AUT.md#REQ-AUT-013) `部分实现` | 句子与 role 已实现；星期错误排在时区说明之后（ScheduleSelector.view.tsx:162-166），控件没有 `aria-invalid`（稿件 f-aut-rules-06 第 5、6 条） | ScheduleSelector.view.tsx:162-166 | 「请至少选择一天。」在星期行下面、「URL 格式不正确…」在地址框下面；两个控件 `aria-invalid="true"` + `aria-describedby` | f-aut-rules-06 |
| [AC-AUT-013.4](./AUT.md#REQ-AUT-013) `未实现` | 前端不拦，后端 400 `VALIDATION_FAILED`，页脚只得到通用句「提交的内容不合要求，请检查后再试。」（contracts automation.schema.ts:92-93） | automation.schema.ts:92-93 | 字段错误「规则名称最多 60 个字。」，不发请求（另需契约配合） | f-aut-rules-06 |
| [AC-AUT-013.5](./AUT.md#REQ-AUT-013) `偏离` | 校验每次渲染都跑，三条「请填写…」一打开就带 role="alert" 出现（useAutomationForm.ts:115-121，AutomationForm.view.tsx:118-122） | useAutomationForm.ts:115-121、AutomationForm.view.tsx:118-122 | 不显示任何字段错误，读屏不播报；[保存规则] 不可用 | f-aut-rules-06 |
| [AC-AUT-014.3](./AUT.md#REQ-AUT-014) `部分实现` | 留在表单、按码查表已实现（useAutomations.ts:75-83）；句子是「网络不通，请稍后再试。」，位置在表单末尾随正文滚动（AutomationForm.view.tsx:322-326；稿件 f-aut-rules-06 第 7 条） | useAutomations.ts:75-83、AutomationForm.view.tsx:322-326 | 留在表单、输入不丢；页脚第一行「规则没保存：网络不通，检查网络后再点 [保存规则]。」（role="alert"），按钮在下一行 | f-aut-rules-06、f-aut-rules-10 |
| [AC-AUT-020.1](./AUT.md#REQ-AUT-020) `偏离` | Agent 一行写 runtime id（useAutomationPresentation.ts:35，DR-24）；其余已实现（:33-56） | useAutomationPresentation.ts:35 | 第 1 行「Agent：Codex」；Webhook 行「<地址> · 只在失败时发（超时也算失败）」 | f-aut-rules-07、f-aut-rules-10、f-aut-rules-11 |
| [AC-AUT-020.3](./AUT.md#REQ-AUT-020) `未实现` | 预览是不可聚焦的 `<pre>`（AutomationDetail.view.tsx:122-130；稿件 f-aut-rules-07 第 8 条） | AutomationDetail.view.tsx:122-130 | 焦点能停在预览区（区域有名称），方向键能滚动 | f-aut-rules-07、f-aut-rules-10、f-aut-rules-11 |
| [AC-AUT-020.4](./AUT.md#REQ-AUT-020) `偏离` | [删除] 是 ghost（AutomationDetail.view.tsx:161-173） | AutomationDetail.view.tsx:161-173 | [编辑]、启停按钮为次级按钮；[删除] 为红字次级按钮（不是幽灵按钮） | f-aut-rules-07、f-aut-rules-10、f-aut-rules-11 |
| [AC-AUT-021.3](./AUT.md#REQ-AUT-021) `偏离` | 写「已过期或被吊销」（formatRunOutcome.ts:35，DR-35 第 1 条） | formatRunOutcome.ts:35 | 「这个 Agent 的凭证已过期或被删除，……」 | f-aut-rules-07、f-aut-rules-08 |
| [AC-AUT-021.4](./AUT.md#REQ-AUT-021) `未实现` | 没有 aria-expanded（RunHistoryItem.view.tsx:94-103；稿件 f-aut-rules-07 第 4 条） | RunHistoryItem.view.tsx:94-103 | 按钮变 [收起]，`aria-expanded="true"` 且 `aria-controls` 指向展开区 | f-aut-rules-07、f-aut-rules-08 |
| [AC-AUT-022.2](./AUT.md#REQ-AUT-022) `偏离` | 计数写「共 0 次」，句子「服务出错了，稍后再试。」，没有 [重试]（RunHistoryList.view.tsx:69-84，DR-22） | RunHistoryList.view.tsx:69-84 | 「共 — 次」；失败条「运行历史没读出来：服务出错了。」+ [重试]；没有空态句 | f-aut-rules-10、f-aut-rules-11 |
| [AC-AUT-022.3](./AUT.md#REQ-AUT-022) `偏离` | 计数写「共 0 次」（RunHistoryList.view.tsx:69-78） | RunHistoryList.view.tsx:69-78 | 「正在读取运行历史…」，计数不写数字 | f-aut-rules-10、f-aut-rules-11 |
| [AC-AUT-022.4](./AUT.md#REQ-AUT-022) `未实现` | hook 有 refresh（useAutomationRuns.ts:74-78），界面没有接 | useAutomationRuns.ts:74-78 | 失败条换成加载中，成功后出列表或空态 | f-aut-rules-10、f-aut-rules-11 |
| [AC-AUT-023.4](./AUT.md#REQ-AUT-023) `未实现` | 只展开、不滚动不移焦（稿件 f-aut-rules-08 第 5 条，Q-AUT-04） | — | 展开的那条滚到正文顶部（上留 12），失败信息与输出摘要在视口里；焦点在它的 [收起] 上 | f-aut-rules-08 |
| [AC-AUT-023.5](./AUT.md#REQ-AUT-023) `未实现` | 随 DR-18；[查看成果] 未出稿（Q-AUT-02） | — | 不出 [打开任务]，出 [查看成果]；点了打开「保留下来的成果」并定位到这一份 | f-aut-rules-08 |
| [AC-AUT-024.1](./AUT.md#REQ-AUT-024) `偏离` | 现状是详情里的行内小框 + [确认删除]，标题不变（AutomationDetail.view.tsx:176-205） | AutomationDetail.view.tsx:176-205 | 同一个对话框切到确认视图：标题「删除自动化规则「每天凌晨跑一遍回归」？」，三段 + 清单来源；焦点在 [取消]；[删除规则] 为 destructive | f-aut-rules-09 |
| [AC-AUT-024.2](./AUT.md#REQ-AUT-024) `未实现` | 随确认视图 | — | 回到该规则的详情，弹层不关 | f-aut-rules-09 |
| [AC-AUT-024.4](./AUT.md#REQ-AUT-024) `未实现` | 运行历史游标不回总数（types/automation.ts:119-123），没有删除预检（Q-AUT-03） | types/automation.ts:119-123 | 写「这条规则，以及它的全部运行历史」，不出现数字 | f-aut-rules-09 |
| [AC-AUT-024.5](./AUT.md#REQ-AUT-024) `部分实现` | 成功回列表已实现（AutomationsPanelContainer.tsx:116-129）；404 时列表刷新（useAutomations.ts:173-178）但界面停在详情并出错误句 | AutomationsPanelContainer.tsx:116-129、useAutomations.ts:173-178 | 成功：回列表，该规则消失；`NOT_FOUND`：回列表并刷新 | f-aut-rules-09 |
| [AC-AUT-025.2](./AUT.md#REQ-AUT-025) `未实现` | （还没有做；片段没写细节，见需求正文） | — | 能看到这份，标明来自规则「<规则名>」；工作台任务树里不再有这个任务 | — |
| [AC-AUT-025.4](./AUT.md#REQ-AUT-025) `未实现` | 残留任务一直占名额（DR-18 后果 1、2） | — | 名额不因前 10 次的残留任务而耗尽，第 11 次正常起任务 | — |
| [AC-AUT-027.7](./AUT.md#REQ-AUT-027) `未实现` | 凭证治理横幅还没有（globalBanner.ts 只有三种，Q-DS-32 B 归 F-WB-BANNER） | globalBanner.ts | 出「Agent 凭证已过期」治理横幅 + [重新登录]；不另出逐条规则的横幅 | f-aut-rules-07 |

### 前端 · DEP（25）

| AC | 差在哪 | 出处 | 建议修法（目标行为） | 稿件 |
|---|---|---|---|---|
| [AC-DEP-002.2](./DEP.md#REQ-DEP-002) `偏离` | 放行 children，口令门浮在工作台上（AppBootGate.tsx:20-23、:54-58；同 AC-ACC-003.1） | AppBootGate.tsx:20-23 | 只有全屏口令门；DOM 里没有工作台，也没发它的请求 | f-dep-init-01、f-dep-init-02 |
| [AC-DEP-002.3](./DEP.md#REQ-DEP-002) `部分实现` | 解锁后重取 init-status（useAccessGate.ts:33-36），但解锁前工作台已经挂过 | useAccessGate.ts:33-36 | 换成向导 | f-dep-init-01、f-dep-init-02 |
| [AC-DEP-003.5](./DEP.md#REQ-DEP-003) `偏离` | 写的是「设置 → 系统状态」（InitWizardShell.view.tsx:89-90、ResourceConfirm.view.tsx:91） | InitWizardShell.view.tsx:89-90、ResourceConfirm.view.tsx:91 | 去处写「系统状态」；不含耗时承诺 | f-dep-init-02…14 |
| [AC-DEP-004.4](./DEP.md#REQ-DEP-004) `部分实现` | 判定已实现（initWizardModel.ts:81-91）；读屏文字没有，图标 aria-hidden（InitWizardShell.view.tsx:111-120） | initWizardModel.ts:81-91、InitWizardShell.view.tsx:111-120 | 步骤条第 3 格是「走过没达成」（三角 + 读屏「走过、没有完成」），不是勾 | f-dep-init-02、f-dep-init-03、f-dep-init-06、f-dep-init-07、f-de… |
| [AC-DEP-004.5](./DEP.md#REQ-DEP-004) `偏离` | 五个圆角描边 chip，没有「第 N / 5 步」，没有 aria-current（InitWizardShell.view.tsx:94-125；简报 §5.5） | InitWizardShell.view.tsx:94-125 | 显示「第 N / 5 步」与五个步骤名；当前那一格 aria-current="step" | f-dep-init-02、f-dep-init-03、f-dep-init-06、f-dep-init-07、f-de… |
| [AC-DEP-006.3](./DEP.md#REQ-DEP-006) `部分实现` | 整段显示已实现（ConnectivityItem.view.tsx:44-48）；后端句仍写「镜像仓库」（connectivity.probe.ts:111、322 等，DR-09） | ConnectivityItem.view.tsx:44-48、connectivity.probe.ts:111、322 | hint 整段显示、不截断；「镜像仓库」上屏为「镜像下载源」（另需后端配合） | f-dep-init-03、f-dep-init-04、f-dep-init-05 |
| [AC-DEP-007.3](./DEP.md#REQ-DEP-007) `偏离` | 超时被算成失败 → offline，还会驱动离线横幅（connectivityVerdict.ts:38；globalBanner.ts 借同一判定） | connectivityVerdict.ts:38、globalBanner.ts | 「部分」档、上面那句暂行结论；不宣布离线、不出离线确认 | f-dep-init-03、f-dep-init-04、f-dep-init-05 |
| [AC-DEP-008.1](./DEP.md#REQ-DEP-008) `部分实现` | 确认框、禁用与页脚句已实现（OfflineNotice.view.tsx、InitWizardContainer.tsx:66-67）；框里第一行是结论句、与结论行重复，没有短标题（DR-25）（稿件 f-dep-init-05） | OfflineNotice.view.tsx、InitWizardContainer.tsx:66-67 | 确认提示条（标题「以离线模式继续」，role=alert）；结论句只在结论行出现一次；[下一步] disabled；页脚那句 | f-dep-init-05 |
| [AC-DEP-009.3](./DEP.md#REQ-DEP-009) `偏离` | 拼的是后端 message（useInitWizard.ts:497、ProxyConfigForm.view.tsx:89-93）（稿件 f-dep-init-06） | useInitWizard.ts:497、ProxyConfigForm.view.tsx:89-93 | 按钮之上「保存失败：这次请求超时了，可以再试一次。」（role=alert）；不显示后端原句 | f-dep-init-06 |
| [AC-DEP-009.4](./DEP.md#REQ-DEP-009) `偏离` | 反引号与 ⚠️ 原样上屏（ProxyConfigForm.view.tsx:84-87，DR-25 / DR-26） | ProxyConfigForm.view.tsx:84-87 | 示例串是等宽行内代码，没有反引号、没有 emoji | f-dep-init-06 |
| [AC-DEP-009.5](./DEP.md#REQ-DEP-009) `未实现` | 说明句写死（InitWizardContainer.tsx:93） | InitWizardContainer.tsx:93 | 说明句不含「上一步有目标连不上」 | f-dep-init-06 |
| [AC-DEP-010.1](./DEP.md#REQ-DEP-010) `偏离` | 页脚已是 [稍后配置，下一步] 与跳过警告（InitWizardContainer.tsx:138-143，DR-25）（稿件 f-dep-init-07） | InitWizardContainer.tsx:138-143 | 5 行「检查中…」；[下一步] 禁用，页脚「镜像检查完成后才能继续。」 | f-dep-init-07、f-dep-init-08 |
| [AC-DEP-010.3](./DEP.md#REQ-DEP-010) `偏离` | 按整轮 isChecking 转圈（PresetImageCheck.view.tsx:41-46，DR-22） | PresetImageCheck.view.tsx:41-46 | 停止点之后显示「未检查」，不转圈 | f-dep-init-07、f-dep-init-08 |
| [AC-DEP-010.4](./DEP.md#REQ-DEP-010) `偏离` | 写的是「第 N 步（共 5 步）」（PresetImageCheck.view.tsx:134，Q-DS-21 A） | PresetImageCheck.view.tsx:134 | 「第 N 项（共 5 项） · 名称」 | f-dep-init-07、f-dep-init-08 |
| [AC-DEP-011.2](./DEP.md#REQ-DEP-011) `偏离` | 阶段句拼了百分比（usePresetImageProvision.ts:85-88），百分比另起一行等宽（PresetImageCheck.view.tsx:223-231）（稿件 f-dep-init-09） | usePresetImageProvision.ts:85-88、PresetImageCheck.view.tsx:223-231 | 条到 37%、行尾「37%」；阶段句不含「· 37%」；已用时每秒走 | f-dep-init-09、f-dep-init-10 |
| [AC-DEP-011.4](./DEP.md#REQ-DEP-011) `部分实现` | 已实现（usePresetImageProvision.ts:93-104、PresetImageCheck.view.tsx:250-278）；出路句仍让人「回上一步「代理配置」填一个代理再试」、路径写「设置 → 系统状态 → 出网代理」（PresetImageCheck.view.tsx:271-273），按 Q-SYS-16（2026-10-04 已拍板 A）要换成上面那句不承诺代理的写法（合并后补记）（稿件 f-dep-init… | usePresetImageProvision.ts:93-104、PresetImageCheck.view.tsx:250-278、PresetImageCheck.view.tsx:271-273 | 留最后一句阶段文案 + 失败原因（role=alert）+ 出路；[准备镜像] 可点；不自动重试 | f-dep-init-09、f-dep-init-10 |
| [AC-DEP-012.1](./DEP.md#REQ-DEP-012) `偏离` | 卡内与页脚各说一次，按钮没有关联（InitWizardContainer.tsx:139-143、PresetImageCheck.view.tsx:302-311）（稿件 f-dep-init-08） | InitWizardContainer.tsx:139-143、PresetImageCheck.view.tsx:302-311 | 卡内拦截说明一处（role=alert）；页脚没有同义句；主按钮「稍后配置，下一步」且 aria-describedby 指向那句 | f-dep-init-08 |
| [AC-DEP-013.3](./DEP.md#REQ-DEP-013) `偏离` | 面板一挂上就 begin（AuthGateContainer.tsx:136-141，同 REQ-AUTH-003）（稿件 f-dep-init-11） | AuthGateContainer.tsx:136-141 | 那一行里展开面板，停在空闲态（只有 [开始帐号登录]），不发 begin；行尾变 [收起] | f-dep-init-11、f-dep-init-12 |
| [AC-DEP-013.4](./DEP.md#REQ-DEP-013) `偏离` | 卡内与页脚各说一次（InitWizardContainer.tsx:176-180、SubscriptionSetup.view.tsx:131-139，DR-25） | InitWizardContainer.tsx:176-180、SubscriptionSetup.view.tsx:131-139 | 拦截说明只在卡内一处；主按钮「稍后配置，下一步」aria-describedby 指向它 | f-dep-init-11、f-dep-init-12 |
| [AC-DEP-013.6](./DEP.md#REQ-DEP-013) `部分实现` | 刷新与收起已实现（useRuntimeAuthPanel.handleSuccess），「已连上」停留没有（REQ-AUTH-008，DR-21） | — | 「已连上」停留后收起；那一行变「已配置」+ 打码身份；主按钮变 [下一步]；拦截说明消失 | f-dep-init-11、f-dep-init-12 |
| [AC-DEP-014.5](./DEP.md#REQ-DEP-014) `偏离` | InitWizardContainer.tsx:231、initWizardModel.ts:264（DR-25） | InitWizardContainer.tsx:231、initWizardModel.ts:264 | 都不含「进度条」 | f-dep-init-13、f-dep-init-14 |
| [AC-DEP-015.1](./DEP.md#REQ-DEP-015) `部分实现` | 卸载已实现；第一屏是一句话，不是欢迎态（同 AC-WB-003.3） | — | 向导卸载；第一屏是欢迎态；没有「初始化完成」提示 | f-dep-init-13、f-dep-init-14 |
| [AC-DEP-015.4](./DEP.md#REQ-DEP-015) `偏离` | 按钮与旁注在内容区，页脚只有 [上一步]（ResourceConfirm.view.tsx:84-93、InitWizardContainer.tsx:232）（稿件 f-dep-init-13） | ResourceConfirm.view.tsx:84-93、InitWizardContainer.tsx:232 | [确认，开始使用] 在页脚条右端，那句「点它才算装完…」在左；壳上不再另有 [下一步] | f-dep-init-13、f-dep-init-14 |
| [AC-DEP-016.3](./DEP.md#REQ-DEP-016) `偏离` | 后端 message 原样上屏，没有回去的按钮（useInitWizard.ts:409-414、initialization.service.ts:96-107）（TC-DEP-004） | useInitWizard.ts:409-414、initialization.service.ts:96-107 | 不放行；前端句 + [回到联网检查]；点它回第 1 步并重跑一轮（结果离线时出离线确认） | f-dep-init-14 |
| [AC-DEP-016.6](./DEP.md#REQ-DEP-016) `偏离` | 退到 Error.message 原样上屏（useInitWizard.ts:524-528） | useInitWizard.ts:524-528 | 原因是前端句，不出现「Failed to fetch」 | f-dep-init-14 |

## 4. 后端（34 条 AC）

### 后端 · PRJ（6）

| AC | 差在哪 | 出处 | 建议修法（目标行为） | 稿件 |
|---|---|---|---|---|
| [AC-PRJ-013.5](./PRJ.md#REQ-PRJ-013) `偏离` | 代码核对，未实测；排队项只被移出队列（clone-project.workflow.ts:90-101），没有路径把它写成 failed，项目停在「克隆中」直到平台重启（:277-290） | clone-project.workflow.ts:90-101 | 它落定为 failed + `INTERRUPTED` 并推送 | f-prj-clone-03、f-prj-clone-06 |
| [AC-PRJ-040.5](./PRJ.md#REQ-PRJ-040) `未实现` | delete() 不检查任务（project-application.service.ts:254-281） | project-application.service.ts:254-281 | 409（专属码），项目与任务都不动 | f-prj-delete-02 |
| [AC-PRJ-041.3](./PRJ.md#REQ-PRJ-041) `偏离` | delete() 不碰任务，任务成为孤儿落进「未分组」（project-application.service.ts:254-281；sandboxes.project_id 无外键，sandbox.sqlite.ts:17；selectProjectTaskTree.ts:42-52） | project-application.service.ts:254-281、sandbox.sqlite.ts:17、selectProjectTaskTree.ts:42-52 | 3 个任务都被销毁（记录与代码副本），任务列表里不再有它们，树上不出现「未分组」（另需前端配合） | f-prj-delete-01 |
| [AC-PRJ-041.4](./PRJ.md#REQ-PRJ-041) `偏离` | 代码推断，未实测；规则外键 RESTRICT 且外键检查开着，delete() 不删规则 ⇒ 事务被顶回、500 `INTERNAL`（automation.sqlite.ts:15-18，0018_hesitant_bushwacker.sql:51，drizzle.connection.ts:55，error-envelope.filter.ts:32-33）；同一机制已在保留成果的外键上实证过（retained-volume.re… | automation.sqlite.ts:15-18、0018_hesitant_bushwacker.sql:51、drizzle.connection.ts:55、error-envelope.filter.ts:32-33 | 规则与运行历史一起删掉，删除成功 | f-prj-delete-01 |
| [AC-PRJ-043.3](./PRJ.md#REQ-PRJ-043) `偏离` | 代码推断；代码目录在事务之前就删了（project-application.service.ts:264-267），事务失败后项目还在、代码没了；外键错误落成 500 | project-application.service.ts:264-267 | 项目、任务、规则、代码目录都还在；返回 409（不是 500） | f-prj-delete-04 |
| [AC-PRJ-055.4](./PRJ.md#REQ-PRJ-055) `未实现` | 自动化跑完不登记成果，`automation-artifact` 没有写入点（DR-18） | — | 登记一份「自动化产物」，到期 = 登记时间 + 7 天 | f-prj-retained-01 |

### 后端 · LCH（1）

| AC | 差在哪 | 出处 | 建议修法（目标行为） | 稿件 |
|---|---|---|---|---|
| [AC-LCH-014.2](./LCH.md#REQ-LCH-014) `偏离` | destroy 只把 running / idle / stopping / starting 先走到可删的状态（sandbox-application.service.ts:731–741），其余直接转 destroying 被状态机拒（sandbox-status.vo.ts:39–52 只允许 stopped / failed → destroying）；`InvalidSandboxTransitionError` 没有 HTT… | sandbox-application.service.ts:731–741、sandbox-status.vo.ts:39–52 | 删除成功、名额释放 | f-lch-startup-06 |

### 后端 · SBX（1）

| AC | 差在哪 | 出处 | 建议修法（目标行为） | 稿件 |
|---|---|---|---|---|
| [AC-SBX-014.3](./SBX.md#REQ-SBX-014) `偏离` | 后端；stop 失败不写 failureCode（sandbox-application.service.ts:599-605），后端待办（停止 / 销毁失败时写 failureCode，见 impl-gaps） | sandbox-application.service.ts:599-605 | 仍是异常卡；没有码时出兜底而不是空白 | f-sbx-stopstart-04 |

### 后端 · AUTH（2）

| AC | 差在哪 | 出处 | 建议修法（目标行为） | 稿件 |
|---|---|---|---|---|
| [AC-AUTH-008.4](./AUTH.md#REQ-AUTH-008) `偏离` | 按代码推断，未实跑；见 AC-CRD-011.3——生效方式仍指向帐号登录，credentialStatus 仍按帐号登录算（runtime-application.service.ts:79-82），面板说「已连上」而闸门不消失 | runtime-application.service.ts:79-82 | Codex 改用 API Key；闸门消失，可发起 | f-auth-panel-07 |
| [AC-AUTH-010.3](./AUTH.md#REQ-AUTH-010) `未实现` | 没有取消接口 | — | 会话与进程在回收期限内清掉 | — |

### 后端 · CRD（5）

| AC | 差在哪 | 出处 | 建议修法（目标行为） | 稿件 |
|---|---|---|---|---|
| [AC-CRD-003.1](./CRD.md#REQ-CRD-003) `偏离` | 建实例时把镜像支持的所有 Agent 的凭证都注入并记账（provision-sandbox.workflow.ts:518-533、618-637），删 Claude Code 的凭证会按绑定销毁 A（credential-revoked.handler.ts:76-80）；待 D3 | provision-sandbox.workflow.ts:518-533、618-637、credential-revoked.handler.ts:76-80 | A 不被销毁（A 本来就没有被注入 Claude Code 的凭证） | f-crd-revoke-01、f-crd-revoke-03 |
| [AC-CRD-004.4](./CRD.md#REQ-CRD-004) `偏离` | 后端仍把生效方式记在被删的那一种（runtime 模块不处理删除；view 因选不出凭证回 `none`，runtime-credential.service.ts:243-248），于是空着的「帐号登录」行单选选中并显示「当前使用」（AuthMethodRadioRow.view.tsx:102-114） | runtime-credential.service.ts:243-248、AuthMethodRadioRow.view.tsx:102-114 | 卡头「未配置」；两行都不显示「当前使用」，单选不选中被删的那一行（另需前端配合） | f-crd-revoke-01、f-crd-revoke-02、f-crd-revoke-03、f-crd-mode-0… |
| [AC-CRD-011.2](./CRD.md#REQ-CRD-011) `偏离` | 只保存、不切换（runtime-credential.service.ts:146-159），要再点一次单选走确认框 | runtime-credential.service.ts:146-159 | API Key 成为当前使用；轻提示「已切换到 API Key」 | 无单独稿 |
| [AC-CRD-011.3](./CRD.md#REQ-CRD-011) `偏离` | 按代码推断，未实跑；runtime_settings 行在首配后一直保留，生效方式仍指向帐号登录（runtime-credential.service.ts:151-159），credentialStatus 仍按帐号登录算（runtime-application.service.ts:79-82） | runtime-credential.service.ts:151-159、runtime-application.service.ts:79-82 | API Key 成为当前使用，卡片不再是「未配置 / 已过期」 | 无单独稿 |
| [AC-CRD-022.5](./CRD.md#REQ-CRD-022) `未实现` | 后端只写 metadata.provider（credential-application.service.ts:108），不写 knownHosts，块永不渲染（GitCredentialCard.view.tsx:107-109）；DR-14 | credential-application.service.ts:108、GitCredentialCard.view.tsx:107-109 | SSH 卡出现「已记录主机指纹」块，列出 git.acme.example.com（ssh-ed25519）SHA256:…（另需前端配合） | f-crd-git-04 |

### 后端 · ACC（6）

| AC | 差在哪 | 出处 | 建议修法（目标行为） | 稿件 |
|---|---|---|---|---|
| [AC-ACC-001.1](./ACC.md#REQ-ACC-001) `偏离` | 出厂不开口令（passcode.service.ts:68-75，source=none ⇒ enabled=false），全仓没有开机生成口令的代码（TC-ACC-001 基线红）（稿件 f-acc-unlock-01） | passcode.service.ts:68-75 | stdout 出现一次口令横幅；库里只有哈希；口令门开启 | f-acc-unlock-01 |
| [AC-ACC-001.2](./ACC.md#REQ-ACC-001) `部分实现` | ENABLED 行已有（passcode.service.ts:55-60） | passcode.service.ts:55-60 | 不再打印口令，只打「access passcode ENABLED via stored …」一行 | f-acc-unlock-01 |
| [AC-ACC-005.2](./ACC.md#REQ-ACC-005) `偏离` | 按代码核实，未实跑；守卫对每个既没有有效会话、也没带对口令的请求都记一次失败（passcode.guard.ts:68），与解锁接口共用同一把锁（access.controller.ts:31-40 的注释写明首屏并发拉取会「各撞一次」）；解锁接口先查锁（:65-69）⇒ 用户输对口令也被拒 5 分钟。D3 默认开启口令后每台新机器的首次打开都会撞上 | passcode.guard.ts:68、access.controller.ts:31-40 | 解锁成功 | f-acc-unlock-03 |
| [AC-ACC-007.1](./ACC.md#REQ-ACC-007) `未实现` | regenerate 只换口令、不动会话签名密钥（access-passcode.service.ts:63-72，passcode.service.ts:111-118）；契约里没有这个参数（请求体只有 action） | access-passcode.service.ts:63-72、passcode.service.ts:111-118 | 200，响应里有新口令（只此一次）；B 的下一次请求回到口令门；A 随响应拿到新会话、不被踢出；审计写明选了让已登录的浏览器失效（另需契约配合） | — |
| [AC-ACC-007.3](./ACC.md#REQ-ACC-007) `未实现` | 随 AC-ACC-007.1；签名密钥取 PASSCODE_COOKIE_SECRET 优先，passcode.service.ts:156-182 | passcode.service.ts:156-182 | 409，原因说签名密钥由部署配置固定、要改变量后重启；口令不变（零副作用） | — |
| [AC-ACC-007.4](./ACC.md#REQ-ACC-007) `未实现` | 开机口令横幅还没有（passcode.service.ts:52-61 只打 ENABLED 一行），README 没有这一句 | passcode.service.ts:52-61 | 都写了怎样同时让已登录的浏览器失效（接口参数；改 PASSCODE_COOKIE_SECRET 后重启）；界面里没有为这一项新造的页面 | — |

### 后端 · IMG（7）

| AC | 差在哪 | 出处 | 建议修法（目标行为） | 稿件 |
|---|---|---|---|---|
| [AC-IMG-007.4](./IMG.md#REQ-IMG-007) `偏离` | 面板说「并且要有 WorkingDir」，平台读取时把缺省的 WorkingDir 当成「/」（oci-image-spec.provider.ts:99），工作目录那条错误只在空串时报（:173-179），实际走不到；见 Q-IMG-01 | oci-image-spec.provider.ts:99 | 结论与面板第②条说的一致 | f-img-register-05 |
| [AC-IMG-026.1](./IMG.md#REQ-IMG-026) `偏离` | 新版本行 config 为 null（image-application.service.ts:215），更新后卡面变「（未配置）」，Secret 丢失 | image-application.service.ts:215 | 新版本行带同样 3 个变量（Secret 仍是密文）；卡面运行参数摘要不变 | f-img-version-04 |
| [AC-IMG-033.3](./IMG.md#REQ-IMG-033) `未实现` | 只有 DELETE 时 409 带一个数量（image-application.service.ts:391-398；DR-07） | image-application.service.ts:391-398 | 后端只读预检返回：这张镜像的版本列表、引用这一版的未销毁任务（名称 · 项目 · 状态） | f-img-state-02 |
| [AC-IMG-034.3](./IMG.md#REQ-IMG-034) `偏离` | 计数含已销毁的任务（image-manifest.repository.impl.ts:191-196；任务销毁后行仍保留，image_ref 外键 RESTRICT），用过一次就永远删不掉（DR-19） | image-manifest.repository.impl.ts:191-196 | 删除成功 | f-img-state-03 |
| [AC-IMG-034.4](./IMG.md#REQ-IMG-034) `部分实现` | 409 已实现，文案已不说「请先禁用后再删除」（image-application.service.ts:391-398）；没写「含已停止」，仍写「新任务的下拉」 | image-application.service.ts:391-398 | 409；message「还有 1 个任务（含已停止）在用这个版本…请改为在这张镜像上点 [禁用]…」，不提「下拉」 | f-img-state-03 |
| [AC-IMG-041.6](./IMG.md#REQ-IMG-041) `偏离` | preset-image-provisioner.ts:277、289（「正在把 … 铺进…」「已铺进…」） | preset-image-provisioner.ts:277、289 | 不出现「铺开」「铺进」「staged」 | f-img-preset-01、f-img-preset-02 |
| [AC-IMG-043.4](./IMG.md#REQ-IMG-043) `偏离` | preset-image.check.ts:379-382、431（DR-36；UX-DS-308 登记的缺口） | preset-image.check.ts:379-382、431 | ⑧ 的下一步是「去「镜像管理」，在预制镜像卡上点 [准备镜像]…」 | — |

### 后端 · DIA（1）

| AC | 差在哪 | 出处 | 建议修法（目标行为） | 稿件 |
|---|---|---|---|---|
| [AC-DIA-012.2](./SYS.md#REQ-DIA-012) `偏离` | 「先清保留卷（系统状态页「保留卷占用」）或删掉已完成任务的工作区。」（disk-space.check.ts:118） | disk-space.check.ts:118 | 下一步写「先清理保留下来的成果（系统状态「成果占用」那一行的 [清理成果]），或删掉不用的项目。」；不出现「保留卷」「工作区」 | f-sys-diag-01…06 |

### 后端 · AUD（2）

| AC | 差在哪 | 出处 | 建议修法（目标行为） | 稿件 |
|---|---|---|---|---|
| [AC-AUD-003.6](./SYS.md#REQ-AUD-003) `偏离` | 摘要由后端拼原值「沙箱状态 starting → running」「创建沙箱 <名>」「校验镜像 <ref>：warning」（audit.projector.ts:84、103、268），执行者「Provider 事件」（auditRowModel.ts:45）；要后端同步，或前端按事件类型与 detail 重拼（稿件 f-sys-audit-04） | audit.projector.ts:84、103、268、auditRowModel.ts:45 | 摘要「任务状态 准备中 → 运行中」「创建任务「修一下登录态刷新」」「校验镜像 <ref>：有警告」；执行者「沙箱环境事件」；行上不出现「沙箱」与英文状态值（另需前端配合） | f-sys-audit-04、f-sys-audit-06 |
| [AC-AUD-003.7](./SYS.md#REQ-AUD-003) `偏离` | 摘要由后端拼「保留工作区卷（磁盘 N 字节 / 下载 N 字节）」（audit.projector.ts:242）、「清理了保留卷（回收约 N 字节）」「保留期到期，已清理保留卷（回收约 N 字节）」（retained-volume.service.ts:126、179）；要后端同步，或前端按事件类型与 detail 重拼 | audit.projector.ts:242、retained-volume.service.ts:126、179 | 摘要依次是「保留成果（磁盘 … / 下载 …）」「保留期到期，已清理保留下来的成果（回收约 …）」「清理了保留下来的成果（回收约 …）」；行上不出现「保留工作区卷」「保留卷」 | f-sys-audit-04、f-sys-audit-06 |

### 后端 · AUT（2）

| AC | 差在哪 | 出处 | 建议修法（目标行为） | 稿件 |
|---|---|---|---|---|
| [AC-AUT-004.6](./AUT.md#REQ-AUT-004) `未实现` | 只有按项目的 `GET /api/projects/:id/automations`（project-automation.controller.ts），没有跨项目的概览，契约里没有对应的 DTO | project-automation.controller.ts | 一次返回这 2 条，各带项目名、规则名、状态、连续失败次数；不需要先按项目拉列表；只读（另需契约配合） | f-aut-rules-01、f-aut-rules-08 |
| [AC-AUT-025.1](./AUT.md#REQ-AUT-025) `未实现` | 收尾只记终态与通知（automation.scheduler.ts:349-373），launcher 没有收尾方法（automation-collaborators.port.ts:75-96），`automation-artifact` 没有写入点（DR-18） | automation.scheduler.ts:349-373、automation-collaborators.port.ts:75-96 | 该任务被销毁、代码副本留下来；新增一份保留下来的成果，来源 `automation-artifact`，到期时间 = 结束时刻 + 7 天（另需契约配合） | — |

### 后端 · DEP（1）

| AC | 差在哪 | 出处 | 建议修法（目标行为） | 稿件 |
|---|---|---|---|---|
| [AC-DEP-007.4](./DEP.md#REQ-DEP-007) `偏离` | 后端写入门只看 ok（initialization.service.ts:93-94）；诊断第 ⑤ 项已按本条分档（outbound-network.check.ts:79-100） | initialization.service.ts:93-94、outbound-network.check.ts:79-100 | 不返回 409 OFFLINE_NOT_ACKNOWLEDGED | f-dep-init-03、f-dep-init-04、f-dep-init-05 |

## 5. 契约（8 条 AC）

### 契约 · PRJ（1）

| AC | 差在哪 | 出处 | 建议修法（目标行为） | 稿件 |
|---|---|---|---|---|
| [AC-PRJ-051.3](./PRJ.md#REQ-PRJ-051) `未实现` | DTO 只有 sandboxId（project.schema.ts:141-155），行上是 8 位短号（retainedVolumeModel.ts:53-58）；需后端登记时快照任务名（DR-10） | project.schema.ts:141-155、retainedVolumeModel.ts:53-58 | 行标题「改一处示例代码」，完整任务 id 在提示里（另需前端配合） | f-prj-retained-01、f-prj-retained-05 |

### 契约 · LCH（3）

| AC | 差在哪 | 出处 | 建议修法（目标行为） | 稿件 |
|---|---|---|---|---|
| [AC-LCH-004.10](./LCH.md#REQ-LCH-004) `部分实现` | 门口已拦（image-facade.adapter.ts:118–145）；列表不给这一项（image.schema.ts:99–150 的 ImageManifestSchema 没有档位字段） | image-facade.adapter.ts:118–145、image.schema.ts:99–150 | 列表能看出它跑不在这台机器的档上（弹层据此不列它）；发起时门口 IMAGE_PROVIDER_MISMATCH（零副作用）（另需后端配合） | f-lch-form-01、f-lch-form-05、f-lch-form-07、f-lch-form-10 |
| [AC-LCH-005.2](./LCH.md#REQ-LCH-005) `偏离` | 前端按码点数（NewSandboxPanel.view.tsx:178–179），契约 zod `.max(8000)` 按 UTF-16 单元数（这段是 8200 → 400 VALIDATION_FAILED，sandbox.schema.ts:57），SQLite CHECK 按字符数（params.yaml:236 已点名，Q-LCH-01） | NewSandboxPanel.view.tsx:178–179、sandbox.schema.ts:57、params.yaml:236 | 前端显示 7000/8000、可发起，后端同样接受（另需前端配合） | f-lch-form-02、f-lch-form-03 |
| [AC-LCH-017.1](./LCH.md#REQ-LCH-017) `未实现` | SandboxDto 没有镜像字段（sandbox.schema.ts:178–275）；库里存着版本行 id（sandbox-application.service.ts:298），没有回显 | sandbox.schema.ts:178–275、sandbox-application.service.ts:298 | 两次都带这个任务锁定的镜像：版本行 id、坐标、版本号、是不是平台预制镜像；不随镜像管理里的切换变（另需后端配合） | f-lch-startup-03、f-lch-startup-04、f-lch-startup-05、f-sbx-rel… |

### 契约 · SBX（1）

| AC | 差在哪 | 出处 | 建议修法（目标行为） | 稿件 |
|---|---|---|---|---|
| [AC-SBX-030.3](./SBX.md#REQ-SBX-030) `未实现` | SandboxDto 不带来源规则（sandbox.schema.ts:178-275），web 没有标签；稿件未画（待定 Q-SBX-06） | sandbox.schema.ts:178-275 | 树行能看出来自自动化（「自动」标签）；主区能回到来源规则 | f-sbx-headless-01 |

### 契约 · SYS（2）

| AC | 差在哪 | 出处 | 建议修法（目标行为） | 稿件 |
|---|---|---|---|---|
| [AC-SYS-060.4](./SYS.md#REQ-SYS-060) `未实现` | 契约只限长度（system.schema.ts:232-236），socks5 地址会被原样存下，而联网检查只走 HTTP CONNECT（connectivity.probe.ts:364-379）（稿件 f-sys-conn-02） | system.schema.ts:232-236、connectivity.probe.ts:364-379 | 请求被拒（校验错误），已存配置不变；表单末尾「保存失败：代理地址格式不对 —— HTTPS_PROXY 要以 http:// 或 https:// 开头」（role="alert"）；HTTPS_PROXY 输入框 aria-invalid、aria-describedby 指向这一句；输入保留（另需后端配合） | P5、f-sys-conn-02、f-sys-conn-03、f-sys-conn-04 |
| [AC-SYS-071.1](./SYS.md#REQ-SYS-071) `未实现` | 契约没有 capacity（system.schema.ts:379-428；DR-08） | system.schema.ts:379-428 | 带 `capacity.remainingTasks`、`registeredTasks`（含已停止）与 `basis`；同一时刻按默认配额发起新任务，被拒当且仅当 `remainingTasks = 0` | f-sys-resource-02、f-sys-resource-03、f-sys-resource-04、f-sys-… |

### 契约 · DIA（1）

| AC | 差在哪 | 出处 | 建议修法（目标行为） | 稿件 |
|---|---|---|---|---|
| [AC-DIA-003.7](./SYS.md#REQ-DIA-003) `偏离` | P21-8 L288、L407，F21-8 L48、L250，system.controller.ts:199，api/openapi.json:2418 与 web/openapi.json:2418，sse-protocol.ts:66 仍写 5s；实际 10000（diagnostics.service.ts:38） | system.controller.ts:199、api/openapi.json:2418、web/openapi.json:2418、sse-protocol.ts:66 | 只引用 `PARAM.DIAG_ITEM_TIMEOUT_MS`，不出现 5 秒 / 10 秒字面量 | f-sys-diag-03、f-sys-diag-04 |

## 6. 状态是差距、但没有对应 AC 行的需求

| 需求 | 状态 | 说明 |
|---|---|---|
| [REQ-CRD-023](./CRD.md#REQ-CRD-023) 测试连接：最多 15 秒、原位三态、按错误码说人话、目标仓库 | `部分实现` | 差距写在需求正文里，AC 表全是已实现 / 未核实；转 issue 时以正文为准 |
