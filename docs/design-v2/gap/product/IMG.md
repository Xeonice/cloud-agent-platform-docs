---
id: PRD-IMG
title: 镜像管理 · 产品需求
type: prd
status: draft
owner: 产品 owner（仓库唯一人类 owner）
domains: [IMG]
flows: [F-IMG-REGISTER, F-IMG-ENV, F-IMG-VERSION, F-IMG-STATE, F-IMG-PRESET, F-IMG-PAGE]
applies_to: ">= v0.2.4"
last_verified:
  docs: fd2e1ee
  api: a453bb7
  web: 93f03c5
  date: 2026-10-04
covers:
  - web/src/app/settings/images/page.tsx
  - web/src/containers/image/ImagesContainer.tsx
  - web/src/views/image/{RegisterImageModal,ValidationResult,ImageRequirementsPanel,EnvVarEditor,ImageCard}.view.tsx
  - web/src/hooks/image/{useImages,useImageMutations}.ts
  - web/src/lib/image/{validateEnvVar,mapEnvErrorResponse,imageManifestCards}.ts
  - web/src/lib/sandbox/sandboxErrorCopy.ts（镜像相关的几条错误码文案）
  - api/packages/modules/image/src/application/{image-application.service,image-seeder,image-facade.adapter}.ts
  - api/packages/modules/image/src/domain/value-objects/env-var-set.vo.ts
  - api/packages/modules/image/src/infrastructure/spec/{oci-image-spec.provider,oci-registry.client}.ts
  - web/src/views/image/{ImageCard,ImageVersionHistory,UpdateCompareDialog}.view.tsx
  - web/src/views/settings/ConfirmDialog.view.tsx（删除确认的现状）
  - web/src/lib/image/{imageCardModel,imageManifestCards}.ts
  - web/src/hooks/system/usePresetImageProvision.ts
  - web/src/views/init/PresetImageCheck.view.tsx
  - api/packages/modules/image/src/application/{image-application.service,image-facade.adapter}.ts
  - api/packages/modules/image/src/infrastructure/persistence/sqlite/image-manifest.repository.impl.ts
  - api/apps/api/src/platform/system/system.controller.ts（POST /api/system/preset-image/provision）
  - api/apps/api/src/platform/system/preset-image/**
  - api/apps/api/src/platform/system/diagnostics/checks/preset-image.check.ts
supersedes:
  - docs/product/pages/21-4-镜像管理.md（§0 L19-20、§3 L58-70、§5 L91-98 与状态图 L105 / L124、§6 L223-227、§9 L289-298、§10 L342-386 / L446-462 里关于注册、镜像要求、运行参数、页面空与加载的规则）
  - docs/product/21-页面信息架构与交互.md L13、L96、L102（镜像相关的几句）
  - docs/product/22-异常场景与产品补充要求.md L12（「缺少 tmux 属于这一档」那半句）
  - docs/product/pages/21-4-镜像管理.md（§3 卡片操作、§5 状态矩阵与 ★ 裁决里版本 / 启停 / 删除的界面口径、§6 L228–L231、§9 L249–L252 与 L264–L271）
  - docs/product/pages/21-8-部署与初始化.md（Step 3「准备镜像」的入口、进度与失败口径：L27–L46、L241–L276）
drafts:
  - gap/drafts/f-img-register-01…06、f-img-env-01…03、f-img-page-01…03（说明 gap/drafts/notes/img-a.md；register-06、page-03 为 W4 补稿）
  - gap/drafts/f-img-version-01…04.html、f-img-state-01…03.html、f-img-preset-01…03.html（说明 gap/drafts/notes/img-b.md）
merged_from:
  - gap/product/_parts/img-a.md
  - gap/product/_parts/img-b.md
merged_at: 2026-10-04
review_minutes: 60
---

# 镜像管理 · 产品需求

<!-- 本文件只写「做什么 / 为什么 / 怎样算做对」。布局与视觉在稿件（gap/drafts/f-*），实现方法在技术设计。由 gap/product/_build/merge.py 从 _parts 合并生成；改片段后重新运行。「现状」列暂留文件:行出处，入库时按 01 §4.2 换成证据 ID。 -->

## 一屏摘要

- **这一域回答什么**：镜像管理页——注册新镜像与镜像要求、运行参数（环境变量）、版本（检查更新 / 重新验证 / 切换）、启用禁用与删除、预制镜像下载到本机、页面的加载与空（6 个流程，REQ-IMG-001–059）。旧口径散在 P21-4、P21、P22、P21-8。
- **五条要守的规则**：
  1. 验证结论只属于被验的那个地址：改一个字就作废、[保存] 消失，改回原值也不复活；无效时 [保存] 根本不出现（REQ-IMG-003、004）。
  2. 结论与请求失败都在弹层里原位说（role=status / alert），轻提示只作补充；已注册不是错误（REQ-IMG-005、008）。
  3. 换版本（更新 / 切换 / 回滚）是同一个动作、不确认，所以结果里**必须**说清「只影响之后新建的任务」（REQ-IMG-024、025）。
  4. 删除只给自定义镜像，会被拒的情况打开即说明并给 [改为禁用]；预制镜像不能删，禁用它先出一步非破坏性确认、说清新任务默认用不了它（REQ-IMG-032、033、034）。
  5. 加载中、读不到、过滤后为空、一张都没有，四种**不得**互相冒充（REQ-IMG-050–052）。
- **现状**：32 条需求里 `已实现` 3 · `部分实现` 14 · `未实现` 2 · `偏离` 13。页面与主要行为都已落地；偏离在后端原句上屏（DR-33）、请求失败只出轻提示、已禁用画成转圈、启用成功说「已切换到该版本」、切历史版本时「切换中…」落不到被点的那一行、删除确认点了才知道被拦、列表读不到冒充空态。[更新到新版本] 会清空运行参数与 Secret（Q-IMG-03 已拍板 C，要后端带过去）；预制镜像的 [禁用] 没有确认、徽标写「预置」；镜像页没有「下载到本机」入口（DR-36），诊断第 ⑧ 项仍指向不存在的按钮。后端：DR-07、DR-11、DR-19、Q-IMG-03。
- **待定**：Q-IMG-01…07、Q-IMG-11、Q-IMG-51（[open-questions.md](./open-questions.md)）。其中 2026-10-04 已拍板：Q-IMG-03 C（运行参数随版本、更新时继承）、Q-IMG-04 A（禁用预制镜像先确认，REQ-IMG-032）、Q-IMG-06 A（统一写「预制镜像」，徽标也写「预制」）；出网代理对下载是否生效见 Q-SYS-16（已拍板 A：先不做）；新建任务能选镜像见 Q-LCH-03（已拍板 B，REQ-LCH-004）。

**状态词表**：`已实现`（行为与本文一致）· `部分实现` · `未实现` · `偏离`（实现与本文不同）· `实现先行`（代码已有、原产品文档没写，待确认）· `未核实` · `计划中`（目标版本未到，或待某条待定问题选定后才生效）。「层级」= 最低验证层（单元 / 组件 / 集成 / API / e2e；`文档` = 文档一致性检查，`视觉` = 截图比对）。

## 需求索引

**共 32 条需求、140 条验收标准**：`已实现` 3 · `部分实现` 14 · `未实现` 2 · `偏离` 13。

| 编号 | 需求 | 状态 | 版本 | AC | 稿件 | 待定问题 |
|---|---|---|---|---:|---|---|
| [REQ-IMG-001](#REQ-IMG-001) | 注册弹层：入口、打开即可输入、何时能关 | `部分实现` | MVP | 5 | f-img-register-01…04 | [Q-LCH-03](./open-questions.md#Q-LCH-03) |
| [REQ-IMG-002](#REQ-IMG-002) | [验证]：只读预检、进行中、时限以平台为准 | `已实现` | MVP | 4 | f-img-register-01 | — |
| [REQ-IMG-003](#REQ-IMG-003) | 三级结论：通过 / 有警告可保存 / 无效不可保存，句子按错误码查表 | `偏离` | MVP | 5 | f-img-register-01、f-img-register-02 | [Q-IMG-01](./open-questions.md#Q-IMG-01) |
| [REQ-IMG-004](#REQ-IMG-004) | 地址格式就地提示；改地址即作废结论 | `部分实现` | MVP | 4 | f-img-register-03 | — |
| [REQ-IMG-005](#REQ-IMG-005) | 已经注册过：就地提示 + [定位到该镜像]，不当错误 | `部分实现` | MVP | 4 | f-img-register-04 | — |
| [REQ-IMG-006](#REQ-IMG-006) | [保存]：钉定版本、成功后的去向 | `部分实现` | MVP | 3 | f-img-register-01、f-img-register-04 | — |
| [REQ-IMG-007](#REQ-IMG-007) | 镜像要求侧弹层：四条判据、无遮罩、不抢焦点、只有 [关闭] 能关 | `偏离` | MVP | 4 | f-img-register-05 | [Q-IMG-01](./open-questions.md#Q-IMG-01) [Q-IMG-02](./open-questions.md#Q-IMG-02) |
| [REQ-IMG-008](#REQ-IMG-008) | 预检 / 保存请求本身失败：在弹层里原位说清、能再试 | `偏离` | MVP | 4 | f-img-register-06 | — |
| [REQ-IMG-010](#REQ-IMG-010) | 运行参数在卡内行内编辑 | `部分实现` | MVP | 4 | f-img-env-01 | [Q-IMG-11](./open-questions.md#Q-IMG-11) |
| [REQ-IMG-011](#REQ-IMG-011) | Secret：已存的值永不回显 | `已实现` | MVP | 3 | f-img-env-01、f-img-env-02 | — |
| [REQ-IMG-012](#REQ-IMG-012) | 变量预检：四个错误码前后端同名同句，标在出错的那一格 | `部分实现` | MVP | 5 | f-img-env-02 | — |
| [REQ-IMG-013](#REQ-IMG-013) | 每张镜像最多 50 条：到顶的按钮要说原因 | `偏离` | MVP | 3 | f-img-env-03 | — |
| [REQ-IMG-014](#REQ-IMG-014) | 保存运行参数：成功一句，平台拒绝映回具体行 | `部分实现` | MVP | 5 | 无单独稿 | — |
| [REQ-IMG-020](#REQ-IMG-020) | 运行的版本：短串、原位展开全串、复制完整版本号 | `部分实现` | MVP | 6 | f-img-version-03 | — |
| [REQ-IMG-021](#REQ-IMG-021) | [检查更新]：解析中、已是最新、tag 已不在、有新版本；不能检查时写原因 | `已实现` | MVP | 6 | f-img-version-02、f-img-version-01 | — |
| [REQ-IMG-022](#REQ-IMG-022) | 上游有新版本：信息色提示条 + 对比弹层，用户点了才更新 | `部分实现` | MVP | 6 | f-img-version-01 | — |
| [REQ-IMG-023](#REQ-IMG-023) | [重新验证]：原位转圈、结论原位改写，判为无效也不自动禁用 | `偏离` | MVP | 5 | f-img-version-02 | — |
| [REQ-IMG-024](#REQ-IMG-024) | [切换到此版本]：不确认、被点的那一行「切换中…」、卡面与历史条换位 | `偏离` | MVP | 6 | f-img-version-04 | — |
| [REQ-IMG-025](#REQ-IMG-025) | 换版本的作用范围：只影响之后新建的任务，并在结果里说清 | `部分实现` | MVP | 3 | f-img-version-01、f-img-version-04 | — |
| [REQ-IMG-026](#REQ-IMG-026) | 运行参数跟着版本走：更新时带过去，切换时用那一版自己的 | `偏离` | MVP | 3 | f-img-version-04 | [Q-IMG-03](./open-questions.md#Q-IMG-03) |
| [REQ-IMG-030](#REQ-IMG-030) | 禁用：乐观、停用色调、只挡新任务 | `偏离` | MVP | 5 | f-img-state-01 | [Q-LCH-03](./open-questions.md#Q-LCH-03) |
| [REQ-IMG-031](#REQ-IMG-031) | 启用：走「切到这一版」，说清结果 | `偏离` | MVP | 4 | f-img-state-01 | — |
| [REQ-IMG-032](#REQ-IMG-032) | 预制镜像：不能删；禁用前先确认，说清新任务默认用不了它 | `部分实现` | MVP | 5 | f-img-state-04 | [Q-IMG-04](./open-questions.md#Q-IMG-04) [Q-IMG-06](./open-questions.md#Q-IMG-06) |
| [REQ-IMG-033](#REQ-IMG-033) | 删除确认：只给自定义镜像，打开就把后果写全 | `偏离` | MVP | 5 | f-img-state-02 | — |
| [REQ-IMG-034](#REQ-IMG-034) | 删除被拦：有任务在用就打开即说明，给 [改为禁用] | `未实现` | MVP | 5 | f-img-state-03 | — |
| [REQ-IMG-040](#REQ-IMG-040) | 入口：镜像管理预制镜像卡上的「下载到本机」块（暂行） | `未实现` | v1.2 | 4 | f-img-preset-01 | — |
| [REQ-IMG-041](#REQ-IMG-041) | 下载进度：阶段、百分比或进度未知、真实已用时 | `部分实现` | v1.2 | 6 | f-img-preset-01、f-img-preset-02 | — |
| [REQ-IMG-042](#REQ-IMG-042) | 失败与冲突：说清停在哪一步、给出路、不自动重试 | `部分实现` | v1.2 | 5 | f-img-preset-03 | [Q-SYS-16](./open-questions.md#Q-SYS-16) |
| [REQ-IMG-043](#REQ-IMG-043) | 完成：以检查结论为准；诊断第 ⑧ 项指到这里 | `偏离` | v1.2 | 5 | — | — |
| [REQ-IMG-050](#REQ-IMG-050) | 首次加载：页头可用，列表位置是卡片骨架 | `部分实现` | MVP | 3 | f-img-page-02 | — |
| [REQ-IMG-051](#REQ-IMG-051) | 一张镜像都没有：空态，与「过滤后为空」分开 | `偏离` | MVP | 3 | f-img-page-01 | [Q-IMG-51](./open-questions.md#Q-IMG-51) [Q-LCH-03](./open-questions.md#Q-LCH-03) |
| [REQ-IMG-052](#REQ-IMG-052) | 列表读不到：如实说、能重试，不冒充「没有镜像」 | `偏离` | MVP | 2 | f-img-page-03 | — |

「待定问题」一列链到 [open-questions.md](./open-questions.md)，不回复时按那里写的默认走。

## 与旧文档的对照

由各条「改写了哪条旧文」汇总；旧文档代号见 [README](./README.md#旧文档代号)。逐条的旧文与新口径见每条需求，以及文末附录 A。

| 旧文档 | 被改写的位置 → 本文 | 其中作废 / 删去的 |
|---|---|---|
| P20 核心使用链路 | L348 → REQ-IMG-024 | — |
| P21 页面信息架构与交互 | L13 → REQ-IMG-001；L102 → REQ-IMG-003；L96 → REQ-IMG-007 | — |
| P22 异常场景与产品补充要求 | L12 → REQ-IMG-003；L12 → REQ-IMG-007；L155 → REQ-IMG-051 | — |
| P21-4 镜像管理 | L3、L60 → REQ-IMG-001；L105 → REQ-IMG-002；L66、L93、L252、L67、L124、L65 → REQ-IMG-003；L98 / L225 / L296 → REQ-IMG-004；L291、L227 → REQ-IMG-005；L224、L226 → REQ-IMG-006；L94 → REQ-IMG-007；L224 → REQ-IMG-008；L350、L346 → REQ-IMG-010；L350 → REQ-IMG-011；L371-373、L386 → REQ-IMG-012；L386 → REQ-IMG-013；§10 → REQ-IMG-014；L44、L51 → REQ-IMG-020；L99、L126、L228 → REQ-IMG-021；L97、L228、L216 → REQ-IMG-022；L229、L139、L268-271、（多处） → REQ-IMG-023；（多处） → REQ-IMG-024；L267 → REQ-IMG-025；L332 → REQ-IMG-026；L96、L30、L130、L244、L252 → REQ-IMG-030；L230 → REQ-IMG-031；L136、L249、（多处） → REQ-IMG-032；L231 → REQ-IMG-033；L133、L231、L250 → REQ-IMG-034；L91 → REQ-IMG-050；L20 → REQ-IMG-051；L91 → REQ-IMG-052 | — |
| P21-5 系统状态 | L161-165 → REQ-IMG-040；L151 → REQ-IMG-041 | — |
| P21-8 部署与初始化 | L27-46、L31、（多处）、L32 → REQ-IMG-040；L39-41 → REQ-IMG-041；L35-36 → REQ-IMG-042 | — |
| F21-4 前端·镜像管理 | L198 / L228 / L581 / L686 → REQ-IMG-002；L244 → REQ-IMG-014；L294 → REQ-IMG-020 | — |
| 技术 05 | §4.1 → REQ-IMG-012 | — |

只改写实现现状、试点或稿件口径（不涉及上表旧文档）的需求：REQ-IMG-043。

---

## IMG · 注册新镜像（F-IMG-REGISTER）

### REQ-IMG-001 · 注册弹层：入口、打开即可输入、何时能关 {#REQ-IMG-001}

> 状态 `部分实现` · 版本 MVP · 来源 P21-4 L34、L55、L58-70、L223；P20 L347；UX-DS-207 / UX-DS-319（普通弹层 Esc、点遮罩都能关）；实现 ImagesContainer.tsx:40、43、83-85、119-121、234-252，RegisterImageModal.view.tsx:60-135、165-190，useImages.ts:370-386，useModalFocus.ts（关闭后还原焦点）· 关联 F-WB-CMDK（⌘K「注册新镜像」打开同一个弹层，见 WB.md）· 稿件 f-img-register-01…04

镜像页顶栏的 [注册新镜像] 与「一张镜像都没有」空态里的 [注册新镜像] **必须**打开同一个注册弹层（模态，名称「注册新镜像」）。打开时焦点**必须**在「镜像 URI」输入框里；输入为空时 [验证] 不可点；没有结论区，也没有 [保存]。

弹层在用户动手之前**必须**先说清会拒绝人的那条硬约束：「自定义镜像必须从平台的预制镜像改起（Dockerfile 第一行 FROM 平台预制镜像，或它的派生）。平台按镜像内容比对来源，改标签、改名都不算数。」，并给 [查看镜像要求]（REQ-IMG-007）；另一句说明 OCI 兼容，以及「填 tag 会在此刻锁定成一个具体版本；镜像下载源之后重推同一个 tag 不会自动生效，需在卡片上 [检查更新]」。

空闲时 [取消]、Esc、点遮罩都能关闭：关闭即丢弃地址、结论与提示，焦点回到打开它的按钮。验证中、保存中**不得**被 Esc、[取消] 或点遮罩关掉，输入框只读。

**改写了哪条旧文**：P21-4 L3「前端 ⏳ 进行中（页面尚不存在）」、§0 L19「页面仍不存在」与 P21 L13「设置·镜像管理 ⏳ …路由尚不存在」→ 页面已落地（`/settings/images` + `ImagesContainer`，P20 L347 已写「✅ 页面也已落地」）；P21-4 L60「验证会检查可达性及依赖项」→ 先写来源硬约束，再写「验证会检查连得上、以及上面那几条」（实现文案，RegisterImageModal.view.tsx:96-135）。P21-4 L34 里「向导确认步镜像选择 [注册新镜像]」→ 新建任务弹层有了可选的「镜像」字段（Q-LCH-03 B，用户拍板 2026-10-04，REQ-LCH-004），但不放注册入口（弹层不叠弹层），不在本片。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-IMG-001.1 | e2e | 镜像页，列表有镜像 | 点顶栏 [注册新镜像] | 弹层打开（role=dialog、aria-modal、名称「注册新镜像」）；焦点在「镜像 URI」输入框；[验证] 不可点；没有结论区、没有 [保存] | 已实现：RegisterImageModal.view.tsx:60-88、179、185，ImagesContainer.tsx:43 |
| AC-IMG-001.2 | 组件 | 弹层刚打开 | 读正文 | 先是来源约束提示条（含 [查看镜像要求]），再是 OCI 与「锁定」说明 | 已实现：RegisterImageModal.view.tsx:96-135 |
| AC-IMG-001.3 | e2e | 弹层空闲，已填地址并出了结论 | 按 Esc，或点 [取消] | 弹层关闭；下次打开地址、结论、提示全部为空；焦点回到 [注册新镜像] | 已实现：ImagesContainer.tsx:40，useImages.ts:370-386，useModalFocus.ts |
| AC-IMG-001.4 | e2e | 弹层空闲 | 点遮罩 | 同 AC-IMG-001.3 | 未实现：手写遮罩没有点击处理（RegisterImageModal.view.tsx:60-65；UX-DS-207 要求可关闭的弹层统一用 AppDialog） |
| AC-IMG-001.5 | 组件 | 验证中或保存中 | 按 Esc / 点 [取消] / 点遮罩 | 都不关；输入框只读 | 已实现：ImagesContainer.tsx:40，RegisterImageModal.view.tsx:83、170 |

### REQ-IMG-002 · [验证]：只读预检、进行中、时限以平台为准 {#REQ-IMG-002}

> 状态 `已实现` · 版本 MVP · 来源 P21-4 L95、L105、L116、L224；F21-4 L198、L228、L581、L686；实现 useImages.ts:418-439，RegisterImageModal.view.tsx:83、170、175-183，ImagesContainer.tsx:40，image-application.service.ts:236-252（预检也做来源比对），oci-image-spec.provider.ts:84、203-206，oci-registry.client.ts:32、144、506-535 · 关联 环境变量 `IMAGE_REGISTRY_TIMEOUT_MS`（默认 15000，P1 收进 PARAM 表时定名）· 稿件 f-img-register-01（结论已回来的样子）

点 [验证] 发一次只读预检（`POST /api/images/validate`）：解析地址、按平台约定判定（**含**来源比对，与保存时同一套判据，不会「预检绿、保存红」），**不得**落库——验证完不保存就关掉弹层，列表**不得**有任何变化。进行中 [验证] **必须**写「验证中…」并禁用，输入框只读，[取消] 不可点，Esc 不关（REQ-IMG-001）。

时限以平台为准：平台对镜像下载源的**每一次**请求有时限（`IMAGE_REGISTRY_TIMEOUT_MS`，默认 15 秒）。一次预检要串行发好几个请求（质询、换令牌、manifest、多架构时再取一层、config），所以整次预检没有一个固定的总秒数；任一请求超时即按 `REGISTRY_UNREACHABLE`（界面句「连不上镜像下载源」，可重试）结束，呈现见 REQ-IMG-008。前端不自行计时；界面与文档**不得**另写一个总秒数。

**改写了哪条旧文**：P21-4 L105「验证中（60s 超时·按钮 loading）」、L224「超时 60s，含 pull manifest；超时按 TIMEOUT 处理，可重试」与 F21-4 L198 / L228 / L581 / L686 的「60s / TIMEOUT」→ 每个请求 15 秒（可配），超时归 `REGISTRY_UNREACHABLE`（核实见 notes/img-a.md「核实」第 1 条）。P21-4 L224「✅/⚠️ 出现 [保存]，❌ 禁用保存」→ 拆到 REQ-IMG-003（❌ 时不渲染 [保存]）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-IMG-002.1 | 集成 | 弹层里填了 `docker.io/acme/web-agent:v2.3` | 点 [验证] | 发 `POST /api/images/validate`；按钮「验证中…」并禁用；输入框只读；[取消] 不可点；Esc 不关 | 已实现：useImages.ts:418-421，RegisterImageModal.view.tsx:83、170、175-183，ImagesContainer.tsx:40 |
| AC-IMG-002.2 | 集成 | 预检已返回任一结论 | 不保存，点 [取消] | 列表不变（预检什么都不落库） | 已实现：image-application.service.ts:236-252 |
| AC-IMG-002.3 | 集成 | 镜像下载源对某一个请求 15 秒不回 | 预检进行中 | 该请求中止，整次预检以 `REGISTRY_UNREACHABLE`（可重试）结束，按 REQ-IMG-008 呈现 | 已实现（平台侧）：oci-registry.client.ts:513-534；呈现见 AC-IMG-008.1（偏离） |
| AC-IMG-002.4 | 集成 | 一张不是从预制镜像改起的镜像 | 预检 | 预检就报 `IMAGE_BASE_REQUIRED`（无效结论），不会等到保存才拒 | 已实现：image-application.service.ts:245-252 |

### REQ-IMG-003 · 三级结论：通过 / 有警告可保存 / 无效不可保存，句子按错误码查表 {#REQ-IMG-003}

> 状态 `偏离` · 版本 MVP · 来源 P21-4 L64-69、L91-98、L124、L248；P21 L94-104；P22 L12；UX-DS-402、UX-DS-403、UX-DS-410、UX-DS-508；Q-DS-21 A；DR-33；实现 ValidationResult.view.tsx:32-108，RegisterImageModal.view.tsx:57、184-189，useImages.ts:210-212、429-433，oci-image-spec.provider.ts:137-192，image-application.service.ts:431-447、572-588 · 关联 DR-33 · Q-IMG-01 · 稿件 f-img-register-01（有警告）、f-img-register-02（无效）

结论在说明文字下方原位出现，三级各带一句后果说明：

- **验证通过**：徽标「验证通过」+「镜像可用」；出现 [保存]。
- **有警告**：徽标「有警告」+「镜像仍可用」+ 警告清单；出现 [保存]（警告不阻断）。目前只有一种警告（`RUNTIME_NOT_PREINSTALLED`）：「未预装 <CLI>，创建时需现装，启动会明显变慢」——**不得**写耗时数字（现装耗时按沙箱环境差一个数量级，本页拿不到当前是哪一档）。
- **无效**：徽标「无效」+「镜像不符合平台约定」+ 错误清单 + [查看镜像要求]；[保存] **不渲染**（不是置灰）。

通过 / 有警告用 role="status"，无效用 role="alert"。清单里的句子**必须**按错误码查前端文案表（UX-DS-402），**不得**直接上屏后端原句，**不得**出现内部词（「血统」「rootfs.diff_ids」「runtime」「沙箱」，UX-DS-403 / 410）；`IMAGE_BASE_REQUIRED` 的句子带上当前可用的预制镜像坐标；未知码给一句不撒谎的兜底，错误码单列。注册期**不**检查 tmux：自定义镜像删了 tmux 由任务启动时实测拦下（`IMAGE_CONTRACT_VIOLATION`）；只有开机播种根镜像时检查「声明过 tmux」，与用户注册无关。

**改写了哪条旧文**：P21-4 L66、L93、L252 与 P21 L102 的「实测约 12.5 分钟」→ 不写耗时，「启动会明显变慢」（Q-DS-21 A；镜像要求面板第④条）；P21-4 L67「❌ 验证失败：…（如缺少 tmux）」、L93「tmux 由建议升为必须，缺它的镜像整档移进 ❌」、P21 L102「`IMAGE_TMUX_MISSING`」与 P22 L12「2026-08 起『缺少 tmux』属于这一档」→ 注册期不判 tmux（2026-08 删掉了标签检查：标签会被派生镜像继承，判据本身不成立，oci-image-spec.provider.ts:143-158），改为任务启动时实测；P21-4 L124「保存禁用」→ [保存] 不渲染；P21-4 L65「✅ 验证通过：镜像可用 · 钉定 …」→ 「钉定」一行拆到 REQ-IMG-006。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-IMG-003.1 | 组件 | 预检返回 valid | 渲染结论 | 「验证通过」+「镜像可用」，没有清单；出现 [保存]；role=status | 已实现：ValidationResult.view.tsx:32-46、66，RegisterImageModal.view.tsx:57、185 |
| AC-IMG-003.2 | 组件 | 预检返回 warning（`RUNTIME_NOT_PREINSTALLED`，claude-code） | 渲染结论 | 「有警告」+「镜像仍可用」+「未预装 claude-code，创建时需现装，启动会明显变慢」；出现 [保存] | 偏离：警告句是后端原句「镜像未声明预装 'claude-code'（platform.supportedRuntimes）。选用该 runtime 时会在沙箱内现装，实测可能需要数分钟而不是数秒。」（oci-image-spec.provider.ts:183-188 → useImages.ts:210-212）（稿件 f-img-register-01） |
| AC-IMG-003.3 | 组件 | 预检返回 invalid（`IMAGE_BASE_REQUIRED` + 一条 `IMAGE_ENTRYPOINT_INVALID`） | 渲染结论 | 「无效」+「镜像不符合平台约定」+ 两条按码查表的句子 + [查看镜像要求]；页脚没有 [保存]；role=alert | 部分实现：结构、role、不渲染 [保存] 已实现（ValidationResult.view.tsx:66、94-108，RegisterImageModal.view.tsx:184-189）；句子是后端原句，含「血统」「rootfs.diff_ids」（image-application.service.ts:572-588）（稿件 f-img-register-02） |
| AC-IMG-003.4 | 单元 | 镜像文案表 | 依次查 `IMAGE_BASE_REQUIRED`（带 1 个可用坐标）、`IMAGE_ENTRYPOINT_INVALID`（path=entrypoint）、`RUNTIME_NOT_PREINSTALLED`、一个未知码 | 前三个出各自的句子（第一个带坐标）；未知码出兜底句 + 错误码单列，不出后端原句 | 未实现：没有镜像文案表（DR-33 推荐在 `lib/image` 新建） |
| AC-IMG-003.5 | 集成 | 一张从预制镜像改起、但在 Dockerfile 里删了 tmux 的镜像 | 预检 | 不因 tmux 判无效 | 已实现：oci-image-spec.provider.ts:143-158，image-application.service.ts:431-447 |

### REQ-IMG-004 · 地址格式就地提示；改地址即作废结论 {#REQ-IMG-004}

> 状态 `部分实现` · 版本 MVP · 来源 P21-4 L98、L104、L120-121、L225、L294-296；P22 L43；实现 useImages.ts:388-416，RegisterImageModal.view.tsx:90-94、159-163、179 · 稿件 f-img-register-03

输入时**必须**就地检查地址形状：含空格、换行或不可见字符时，输入框标错误态（aria-invalid，并用 aria-describedby 指向错误句），下面一句「镜像地址不能包含空格、换行或不可见字符。」（role=alert）。前端只提前说、不放宽：[验证] 仍可点，最终判定在平台（`INVALID_IMAGE_REFERENCE`，呈现见 REQ-IMG-008）。

验证结论只属于被验的那个地址。验证之后输入框一变（按 trim 后的字符串比较，不做等价归一：`docker.io/x` 与 `x` 算两个输入），结论区**必须**整块清掉（不是隐藏），[保存] 消失，原位一句「已修改镜像地址，请重新验证」；改回原值也**不得**复活旧结论；同时清掉「该镜像已注册」的提示（REQ-IMG-005）。

**改写了哪条旧文**：无冲突，P21-4 L98 / L225 / L296 原样保留；补「输入框标错误态 + 读屏关联」（旧文与实现都只有错误句）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-IMG-004.1 | 组件 | 验证过 `docker.io/acme/web-agent:v2.3`（有警告） | 把 tag 改成「 v2.4」（多一个空格） | 输入框错误态（aria-invalid=true，aria-describedby 指向错误句）+「镜像地址不能包含空格、换行或不可见字符。」（role=alert）；结论清掉、[保存] 消失、出现「已修改镜像地址，请重新验证」；焦点仍在输入框 | 部分实现：错误句与结论作废已实现（useImages.ts:400-416，RegisterImageModal.view.tsx:90-94、159-163）；输入框没有错误态与 aria 关联（稿件 f-img-register-03） |
| AC-IMG-004.2 | 单元 | 验证过某地址 | 只在首尾加空格 | 不算改动，结论保留 | 已实现：useImages.ts:404 |
| AC-IMG-004.3 | 单元 | 结论已作废 | 把地址改回原值 | 不复活旧结论，仍要求重新验证 | 已实现：useImages.ts:388-408 |
| AC-IMG-004.4 | 组件 | 地址格式错 | 点 [验证] | 照常发请求，平台回 `INVALID_IMAGE_REFERENCE`，按 REQ-IMG-008 呈现 | 已实现（照常发请求，RegisterImageModal.view.tsx:179）；呈现见 AC-IMG-008.* |

### REQ-IMG-005 · 已经注册过：就地提示 + [定位到该镜像]，不当错误 {#REQ-IMG-005}

> 状态 `部分实现` · 版本 MVP · 来源 P21-4 L227、L289-292；27 §6（按 digest 幂等）；F21-4 §9.1 #32、§7.4 ⑦；UX-DS-508；foundation §3.12 `.card.is-current`（「定位到镜像」）；实现 useImages.ts:441-485，RegisterImageModal.view.tsx:137-149，ImagesContainer.tsx:137-143，image-application.service.ts:140-180，useModalFocus.ts · 关联 F-IMG-VERSION（上游重推转对比弹层，REQ-IMG-022）· 稿件 f-img-register-04

平台对注册按（镜像，版本号 digest）幂等：同一份内容再注册一次回 200 + 现有那一行，**不得**回 409。此时弹层**不关**，在结论上方就地说「该镜像已注册（<坐标>，锁定在 <短版本号>）。」+ [定位到该镜像]；用中性提示，不用警告或失败色调；这句是 [保存] 回来之后才出现的，**必须**原位播报（role="status"）。结论与 [保存] 保留。

点 [定位到该镜像]：关闭弹层；那张卡被当前搜索或状态过滤藏起来时，先清掉搜索、过滤回到「全部」（建议）；列表滚到那张卡（建议），以焦点色环标出（保留到下一次定位或离开本页）；焦点落到那张卡上，读屏念出镜像名（建议）。

同一个 tag 解出了**新的**版本（上游重推过）不算重复：关闭弹层，转入「上游有新版本」对比弹层（口径归 F-IMG-VERSION）。

**改写了哪条旧文**：P21-4 L291「命中已存在的 `(image_id, version)` 时不新建行」→ 按 `(image_id, digest)` 判重：同 tag 不同 digest 是新的一行（不自动启用），转对比弹层（image-application.service.ts:142-180）；P21-4 L227「⚠️ 就地展示新旧 digest 对比 + [更新到新版本] 这段交互仍是前端待做」→ 已实现（useImages.ts:454-471）；P21-4 L227「关闭弹窗并高亮那张卡」→ 补「先清过滤、滚到可见、焦点落卡」。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-IMG-005.1 | e2e | 列表里已有 `docker.io/acme/ml-agent:v1.0`（sha256:8e05a…d77） | 注册同一地址，验证后点 [保存] | 平台回 200；弹层不关；结论上方「该镜像已注册（docker.io/acme/ml-agent:v1.0，锁定在 sha256:8e05a…d77）。」+ [定位到该镜像]，role=status；结论与 [保存] 仍在 | 部分实现：提示与按钮已实现（useImages.ts:446-452，RegisterImageModal.view.tsx:137-149；e2e 见 F21-4 §7.4 ⑦）；提示没有 role=status（稿件 f-img-register-04） |
| AC-IMG-005.2 | e2e | 同上 | 点 [定位到该镜像] | 弹层关闭；列表滚到 ml-agent 那张卡并以焦点色环标出，其余卡不标；焦点在那张卡上 | 部分实现：关闭弹层与只标那一张已实现（useImages.ts:482-485，ImagesContainer.tsx:137-143）；不滚动；焦点回到 [注册新镜像]（useModalFocus.ts 还原） |
| AC-IMG-005.3 | 组件 | 状态过滤停在「无效」 | 定位到一张「有警告」的卡 | 过滤回到「全部」、搜索清空，再滚到那张卡（建议） | 未实现：被过滤藏起的卡加了环也看不见 |
| AC-IMG-005.4 | 集成 | 上游把 `v1.0` 重推成了新内容 | 再注册 `docker.io/acme/ml-agent:v1.0` 并保存 | 不出「已注册」提示；弹层关闭，转「上游有新版本」对比弹层 | 已实现：useImages.ts:454-471 |

### REQ-IMG-006 · [保存]：钉定版本、成功后的去向 {#REQ-IMG-006}

> 状态 `部分实现` · 版本 MVP · 来源 P21-4 L61-62、L65、L122-123、L147-155、L224、L226；P20 L347；DR-11；UX-DS-508；实现 useImages.ts:425-428、441-480，RegisterImageModal.view.tsx:185-189，ValidationResult.view.tsx:76-81，useImageMutations.ts:55-64，image-application.service.ts:152-233、591-600，imageManifestCards.ts:129-190 · 关联 DR-11 · 稿件 f-img-register-01、04（「钉定」行，标「待契约 · DR-11」）

预检通过或有警告时，结论下**应**写「钉定 <短版本号>」，告诉用户保存后锁定的是哪一版（绿勾属于这个版本，不属于 tag）。这一行依赖预检接口回 digest（DR-11）：契约补上之前**不得**编一个（预检什么都没落库，编出来的短哈希会被读成「已钉定」）；不回复时默认不显示这一行。

点 [保存]（`POST /api/images`）：按钮「保存中…」并禁用（Esc、[取消] 同 REQ-IMG-001）。平台在保存时重新解析、重新判定（与预检同一套，含来源比对），以保存这一次为准。成功新建时：弹层关闭；列表按排序规则（通过 > 有警告 > 无效，同组新注册的在前）出现新卡，默认启用（同一 tag 已有启用中的版本时除外，见 REQ-IMG-005 的上游重推）；同时轻提示「已注册，锁定在 <短版本号>」——新卡出现是原位结果，轻提示只作补充。重复见 REQ-IMG-005，失败见 REQ-IMG-008。

**改写了哪条旧文**：P21-4 L224「并回显本次解析出的 digest」→ 待 DR-11，契约补字段之前不显示；P21-4 L226「toast『已注册并钉定 sha256:…』」→「已注册，锁定在 <短版本号>」（实现文案，与弹层里的「锁定」同一个词，useImages.ts:474）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-IMG-006.1 | 组件 | 预检返回 warning，且接口带回 digest（DR-11 之后） | 渲染结论 | 结论下「钉定 sha256:5d8c4…f60」 | 未实现：预检接口只回 status / errors / warnings（useImages.ts:425-428）；不回复时默认不显示（稿件 f-img-register-01、04 标「待契约 · DR-11」） |
| AC-IMG-006.2 | e2e | 预检通过 | 点 [保存] | 「保存中…」禁用；成功后弹层关闭；列表按排序出现新卡（已启用）；轻提示「已注册，锁定在 sha256:…」 | 已实现：useImages.ts:441-480，RegisterImageModal.view.tsx:185-189，useImageMutations.ts:55-64，image-application.service.ts:216；e2e 注册全流程（F21-4 §7.3） |
| AC-IMG-006.3 | 集成 | 预检之后、保存之前，上游把这个 tag 换成了不合规的内容 | 点 [保存] | 平台按保存这一次判定为无效（`MANIFEST_INVALID`），不落库；按 REQ-IMG-008 呈现 | 已实现（平台侧）：image-application.service.ts:591-600；呈现见 AC-IMG-008.4（偏离） |

### REQ-IMG-007 · 镜像要求侧弹层：四条判据、无遮罩、不抢焦点、只有 [关闭] 能关 {#REQ-IMG-007}

> 状态 `偏离` · 版本 MVP · 来源 P21 L96（「附查看要求链接」）；P21-4 L94、L124、L216、L269；P22 L12-13；矩阵 U-57 / U-103（形态由实现补）；实现 ImageRequirementsPanel.view.tsx:22-120，useImages.ts:691-719，ImagesContainer.tsx:217、249、271-276，RegisterImageModal.view.tsx:116-127，ValidationResult.view.tsx:102-108，useModalFocus.ts；判据出处 image-application.service.ts:498-589（①）、oci-image-spec.provider.ts:99、159-192（②④）、:143-158（③）· 关联 Q-IMG-01 · Q-IMG-02 · 稿件 f-img-register-05（入口另见 f-img-register-01…04、f-img-page-01）

[查看镜像要求] 出现在四处：注册弹层的来源约束提示条、无效结论（弹层里与卡片上）、空态。点了在页面右侧打开「平台对镜像的要求」侧弹层。它是用户改 Dockerfile 时对照着看的清单，所以**不是**对话框：无遮罩；不抢焦点（焦点留在触发按钮上，触发按钮 aria-expanded=true）；页面其余部分照常可读可点；注册弹层开着时它压在遮罩之上，可以同屏对照；**不随**注册弹层的 Esc 关闭，不自动消失，只有面板上的 [关闭] 能关；再点触发按钮复用已开的那一个。注册弹层开着时，键盘用户要先关弹层才能到面板的 [关闭]（现状，见 Q-IMG-02）。

清单四条，每条写明会不会拦住注册，且**必须**与平台真正在判的东西逐条对得上：
① 必须从平台的预制镜像改起（按镜像层比对，改标签、改名不算数；被拒时错误里列出可用的预制镜像坐标）——不满足会被拒绝注册；
② 必须有启动命令（Entrypoint 或 Cmd，两者有其一即可）——不满足会被拒绝注册；面板现写的「并且要有 WorkingDir」与平台不符，见 Q-IMG-01；
③ tmux：你不用做什么，但别删掉它（注册时不检查，任务启动时实测）——只是提醒；
④ 没预装 Agent CLI 只是提醒（会现装，启动明显变慢；不写耗时数字）——只是提醒。

**改写了哪条旧文**：P21 L96「附查看要求链接」与 P21-4 L94「[查看镜像要求]」只写了按钮 → 补形态（常驻侧弹层、不阻塞、不抢焦点、只有 [关闭] 能关）与四条清单（按实现）；P22 L12 括号里「缺少 tmux 属于这一档」→ 删（见 REQ-IMG-003）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-IMG-007.1 | e2e | 无效卡片 just-registered | 点卡片上的 [查看镜像要求] | 右侧出现 role=complementary、名称「平台对镜像的要求」的面板；没有遮罩；焦点仍在该按钮上，按钮 aria-expanded=true；页面可滚动、可点 | 部分实现：面板形态已实现（ImageRequirementsPanel.view.tsx:74-81，useImages.ts:713-716）；触发按钮没有 aria-expanded（稿件 f-img-register-05） |
| AC-IMG-007.2 | e2e | 注册弹层与面板同时开着 | 按 Esc | 只关注册弹层，面板留着；面板只能用 [关闭] 关 | 已实现：ImagesContainer.tsx:40、271-276（面板不接 Esc） |
| AC-IMG-007.3 | 组件 | 面板打开 | 读四条 | ①② 标「不满足会被拒绝注册」，③④ 标「只是提醒，不拦你」；④ 不写耗时数字 | 已实现：ImageRequirementsPanel.view.tsx:31-68 |
| AC-IMG-007.4 | 集成 | 一张没声明 WorkingDir、有 Cmd、从预制镜像改起的镜像 | 预检 | 结论与面板第②条说的一致 | 偏离：面板说「并且要有 WorkingDir」，平台读取时把缺省的 WorkingDir 当成「/」（oci-image-spec.provider.ts:99），工作目录那条错误只在空串时报（:173-179），实际走不到；见 Q-IMG-01 |

### REQ-IMG-008 · 预检 / 保存请求本身失败：在弹层里原位说清、能再试 {#REQ-IMG-008}

> 状态 `偏离` · 版本 MVP · 来源 P21-4 L224（「超时…可重试」）；P22 §1（发生了什么 + 现在能做什么）；UX-DS-305（操作失败：错误句在触发按钮上方，按码查表）、UX-DS-402、UX-DS-508（异步结果不用 toast）；F21-4 L581（`retryable` 决定给不给重试）；实现 useImages.ts:214-256、435-437、476-478，sandboxErrorCopy.ts:56、201-207、317-352，image-application.service.ts:532-557 · 稿件 f-img-register-06（REGISTRY_UNREACHABLE；其余码同一位置、同一写法；W4 补稿）

预检或保存的**请求本身**失败（不是得出了「无效」结论）时，**必须**在弹层里、页脚按钮上方原位说清（role="alert"）：发生了什么 + 下一步；弹层不关，地址与草稿不清。只有可重试的失败给 [重试]。按错误码查表，沿用现有文案表的句子：

- `REGISTRY_UNREACHABLE`（含某个请求超时）：「连不上镜像下载源」——网络、DNS、代理，或下载源自己在抖；这一步发生在创建之前，没有留下任何东西；[重试]。（现有文案表写「镜像仓库」，按 Q-DS-21 A 的定稿词改称「镜像下载源」，稿件 f-img-register-06 同）
- `REF_NOT_FOUND`：「镜像下载源上没有这个名字或这个版本」——拼写、版本被删、私有仓库没有拉取凭证；不给重试。
- `INVALID_IMAGE_REFERENCE`：「镜像地址里混进了空白或控制字符」；不给重试。
- `INVALID_STATE`（平台还没有预制镜像可作来源比对，多因开机播种失败）：说清「这是平台的部署问题，不是你这张镜像的问题，不用改 Dockerfile」+ [查看系统状态]；不给重试。
- `MANIFEST_INVALID`（保存时重新判定为无效）：结论区换成无效结论（REQ-IMG-003 的无效态），不另起一句。

轻提示最多作补充，**不得**是唯一的反馈；标题里**不得**用字符当图标（现状「⚠️ 这一步现在做不了」）。

**改写了哪条旧文**：P21-4 L224「超时按 TIMEOUT 处理，可重试」→ 超时归 `REGISTRY_UNREACHABLE`，原位提示 + [重试]；其余四类失败的去处旧文没写，本片补。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-IMG-008.1 | 集成 | 镜像下载源连不上（或某个请求超时） | 点 [验证] | 「验证中…」结束；页脚上方一条失败提示（role=alert）「连不上镜像下载源」+ 一句下一步 + [重试]；地址保留；没有结论区；焦点留在 [验证] 上（f-img-register-06） | 偏离：只出右上角轻提示（标题「连不上镜像仓库」+ 建议，useImages.ts:435-437 → 237-256，sandboxErrorCopy.ts:348-352），弹层里没有任何变化，轻提示不渲染 [重试] |
| AC-IMG-008.2 | 集成 | 仓库里没有这个版本 | 点 [验证] | 原位「镜像下载源上没有这个名字或这个版本」+ 检查拼写与可见性；没有 [重试] | 偏离：同上，只出轻提示（sandboxErrorCopy.ts:334-339） |
| AC-IMG-008.3 | 集成 | 平台还没有预制镜像（开机播种失败） | 点 [验证] | 原位说清是平台部署问题、不用改 Dockerfile，并给 [查看系统状态] | 偏离：轻提示「⚠️ 这一步现在做不了」+ 后端原句（useImages.ts:226-245，image-application.service.ts:551-556） |
| AC-IMG-008.4 | 集成 | 预检通过后，上游换成了不合规的内容 | 点 [保存] | 弹层不关；结论区换成无效结论，[保存] 消失 | 偏离：弹层不变，只出轻提示「这张镜像不满足平台要求，没有注册进来」（useImages.ts:476-478，sandboxErrorCopy.ts:317-324） |

## IMG · 运行参数（F-IMG-ENV）

### REQ-IMG-010 · 运行参数在卡内行内编辑 {#REQ-IMG-010}

> 状态 `部分实现` · 版本 MVP · 来源 P21-4 L74、L297-298、L330-350（§10.1–10.2）；矩阵 U-51 / U-99；实现 ImagesContainer.tsx:153-204，EnvVarEditor.view.tsx:65-191，useImages.ts:721-822，imageManifestCards.ts:209-231，ImageCard.view.tsx:259-276 · 关联 Q-IMG-11 · 稿件 f-img-env-01

每张卡的「运行参数」块显示环境变量摘要：`KEY=value` 用「·」连接，Secret 写 `***`，一条都没有写「（未配置）」；条目很多时是否截断见 Q-IMG-11（现状全部列出、整段折行）。点 [编辑环境变量]：在这张卡的运行参数块里、摘要下面展开编辑器（**不是**弹层）；按钮是开关（aria-expanded），再点一次收起并丢弃草稿。编辑器一行 = 变量名 | 变量值 | Secret | [删除] | 字节计数「n / 4096 字节」；[添加变量] 加一个空行；一行都没有时写「还没有环境变量。」；下面 [保存运行参数] [取消]。

同一时刻只有一张卡在编辑：打开另一张卡的编辑器时，前一张收起、草稿丢弃（现状不提示）。[编辑环境变量] 只改运行参数，**不改**镜像坐标（换坐标 = 注册新镜像 + 禁用旧的）；启动命令只读展示（v1.1 可编辑）。

**改写了哪条旧文**：P21-4 L350「[编辑环境变量] 弹层 = 键值表格」→ 卡内行内编辑器（实现与 v1 g5-08 都如此）；P21-4 L346 示意里的「[编辑]」→「[编辑环境变量]」。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-IMG-010.1 | e2e | ml-agent 卡，运行参数 3 条 | 点 [编辑环境变量] | 该卡运行参数块里展开编辑器，三行与库里一致（已存 Secret 见 REQ-IMG-011）；按钮 aria-expanded=true；其余两张卡不变 | 部分实现：展开已实现（ImagesContainer.tsx:154-204）；按钮没有 aria-expanded / aria-controls（ImageCard.view.tsx:266-268）（稿件 f-img-env-01） |
| AC-IMG-010.2 | 组件 | 编辑器开着、改了两行 | 点 [取消]（或再点 [编辑环境变量]） | 编辑器收起，草稿丢弃，摘要不变 | 已实现：ImagesContainer.tsx:188-196、201-204，useImages.ts:739-741 |
| AC-IMG-010.3 | 组件 | ml-agent 的编辑器开着 | 点 sandbox 卡的 [编辑环境变量] | ml-agent 的编辑器收起（草稿丢弃），sandbox 卡展开 | 已实现：useImages.ts:723-737（只有一份草稿） |
| AC-IMG-010.4 | 组件 | 编辑器开着 | 删光所有行后保存 | 编辑器里写「还没有环境变量。」；保存后摘要为「（未配置）」 | 已实现：EnvVarEditor.view.tsx:81，ImageCard.view.tsx:270-271 |

### REQ-IMG-011 · Secret：已存的值永不回显 {#REQ-IMG-011}

> 状态 `已实现` · 版本 MVP · 来源 P21-4 L338、L350、L384-385；I-IMG-5（secret 不回读）；实现 EnvVarEditor.view.tsx:9-11、87-88、112-137，imageManifestCards.ts:193-231，useImages.ts:765-790、850-857 · 稿件 f-img-env-01（MY_SECRET）、f-img-env-02（ANTHROPIC_API_KEY 一行）

勾了 Secret 的变量加密存储。已保存的 Secret 再编辑时，值输入框为空、占位「（保持不变，输入即覆盖）」，原值**不得**进页面——即使接口误回了值也丢弃。不动它原样保存 = 保持不变；输入新值 = 覆盖；取消勾选 Secret = 这一行要重新填明文。勾了 Secret 的值输入框按密码框显示。卡面摘要里 Secret 一律写 `***`。

**改写了哪条旧文**：无冲突，P21-4 L350 原样保留，补「接口误回值也丢弃」（实现 2026-09-05 修过，imageManifestCards.ts:200-207）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-IMG-011.1 | 组件 | ml-agent 的 MY_SECRET 是已存 Secret，接口误把明文回给了前端 | 打开编辑器 | 值输入框为空、占位「（保持不变，输入即覆盖）」；页面 DOM 里找不到原值 | 已实现：imageManifestCards.ts:209-219，EnvVarEditor.view.tsx:87-88、121（story 断言 innerHTML 不含原值，F21-4 L420） |
| AC-IMG-011.2 | 集成 | 同上 | 不动 MY_SECRET，改 LOG_LEVEL 后保存 | 提交里 MY_SECRET 的值为空串（= 保持不变），保存后库里仍是原值 | 已实现：useImages.ts:850-857；后端 I-IMG-5 |
| AC-IMG-011.3 | 组件 | 同上 | 取消勾选 MY_SECRET 的 Secret | 值输入框不再是「保持不变」，变成普通输入，需要重新填 | 已实现：useImages.ts:778-790 |

### REQ-IMG-012 · 变量预检：四个错误码前后端同名同句，标在出错的那一格 {#REQ-IMG-012}

> 状态 `部分实现` · 版本 MVP · 来源 P21-4 L364-378、L384-386、L446-479（§10.4、§10.6）；10 §6.8（四码契约）；UX-DS-305；实现 validateEnvVar.ts:19-165，EnvVarEditor.view.tsx:22-47、99-176，useImages.ts:824-849，env-var-set.vo.ts:25-118 · 稿件 f-img-env-02

编辑时每次改动都在前端预检，四个错误码与平台同名：

- `ENV_NAME_INVALID`：变量名不匹配 `^[A-Za-z_][A-Za-z0-9_]*$`（小写合法）——「变量名只能包含字母、数字、下划线，且不能以数字开头」；
- `ENV_NAME_RESERVED`：系统保留名（凭证类与重定向类变量名、容器基础变量，以及 `GIT_`、`CODEX_` 前缀；名单以后端 `reserved-env.ts` 为准，大小写敏感）——「该变量名为系统保留，请使用凭证管理配置」；
- `ENV_DUPLICATE_KEY`：同名（大小写敏感）——两行同时标「变量名重复」；
- `ENV_LIMIT_EXCEEDED`：同一个码按位置分句——变量名超过 64 字符「变量名太长（最多 64 个字符）」，值超过 4096 **字节**（UTF-8，中文按 3 字节）「变量值太大（最多 4096 字节）」，超过 50 条见 REQ-IMG-013。

错误句写在出错那一行下面（role=alert，带错误码）；出错的输入框标错误态，并用 aria-describedby 指向错误句；字节计数超限变红。刚加的空行（变量名为空）不报名字类错误，空变量名留到保存时由平台判、映回该行（REQ-IMG-014）。预检没过时点 [保存运行参数] **不发请求**，只给一句失败提示「运行参数还有未修正的问题，请按行内提示改完再保存。」。不为「shell 元字符」另造第五个码（P21-4 L462 那条维持「先不实现」）。

**改写了哪条旧文**：P21-4 L371-373 流程图里的「拒绝：『变量名不合法』」「拒绝并提示上限」→ 按码、按位置分句（上面四条）；P21-4 L386 的上限与名单维持，名单以技术 05 §4.1 / 后端 `reserved-env.ts` 为唯一权威。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-IMG-012.1 | 单元 | 6 行：1BAD_NAME / ANTHROPIC_API_KEY / LOG_LEVEL / LOG_LEVEL / SYSTEM_PROMPT（1707 个中文字符）/ HTTP_TIMEOUT | 预检 | 第 1 行 `ENV_NAME_INVALID`；第 2 行 `ENV_NAME_RESERVED`；第 3、4 行都标 `ENV_DUPLICATE_KEY`；第 5 行值 `ENV_LIMIT_EXCEEDED`（5121 字节）；第 6 行无错 | 已实现：validateEnvVar.ts:99-153（单测 15 条，F21-4 L394） |
| AC-IMG-012.2 | 组件 | 同上 | 渲染编辑器 | 每个出错的输入框错误态 + aria-invalid + aria-describedby 指向下一行的错误句；错误句 role=alert、带 data-code；第 5 行字节计数「5121 / 4096 字节」变红 | 部分实现：错误句、role、data-code、计数变红已实现（EnvVarEditor.view.tsx:99-167）；输入框只有红边，没有 aria-invalid / aria-describedby（稿件 f-img-env-02） |
| AC-IMG-012.3 | 单元 | 同一张表里有 `log_level` 与 `LOG_LEVEL`，另有一行 `path` | 预检 | 不算重复；`path` 不算保留名 | 已实现：validateEnvVar.ts:79-86、102 |
| AC-IMG-012.4 | 组件 | 刚点 [添加变量]，新行变量名为空 | 渲染 | 这一行不报错 | 已实现：validateEnvVar.ts:96-98、120 |
| AC-IMG-012.5 | 集成 | 表里还有预检错误 | 点 [保存运行参数] | 不发请求；失败提示「运行参数还有未修正的问题，请按行内提示改完再保存。」 | 已实现：useImages.ts:845-849 |

### REQ-IMG-013 · 每张镜像最多 50 条：到顶的按钮要说原因 {#REQ-IMG-013}

> 状态 `偏离` · 版本 MVP · 来源 P21-4 L373、L386；DR-39（不回复默认：变量上限的按钮旁写「每张镜像最多 50 条」）；foundation §3.20（能聚焦、能说原因的禁用）；实现 EnvVarEditor.view.tsx:172-188，validateEnvVar.ts:155-163，env-var-set.vo.ts:62-68，mapEnvErrorResponse.ts:107-111 · 关联 DR-39 · 稿件 f-img-env-03（超过 50 条；正好 50 条是头注释里的变体）

正好 50 条时 [添加变量] 不可用，按钮旁**必须**写原因「每张镜像最多 50 条」：按钮仍可聚焦（aria-disabled），并用 aria-describedby 指向这句。超过 50 条（编辑器加不出来，只可能来自库里既有数据，属防御态）时，最后一行之后再加整表错误「变量条数太多（每张镜像最多 50 条）」（role=alert，`ENV_LIMIT_EXCEEDED`），删到 50 条以内才能保存；平台同样限 50 条。

**改写了哪条旧文**：P21-4 L386 只写了上限 → 补「到顶时按钮旁写原因」（DR-39）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-IMG-013.1 | 组件 | 编辑器里正好 50 行 | 渲染 | [添加变量] aria-disabled、可聚焦，旁边「每张镜像最多 50 条」，按钮 aria-describedby 指向它；没有整表错误 | 偏离：只 disabled 置灰，不说原因、不可聚焦（EnvVarEditor.view.tsx:178-188） |
| AC-IMG-013.2 | 组件 | 库里已有 51 条 | 打开编辑器 | 最后一行之后「变量条数太多（每张镜像最多 50 条）」（role=alert）+ AC-IMG-013.1 的置灰与原因 | 部分实现：整表错误已实现（EnvVarEditor.view.tsx:172-176）；原因句没有（稿件 f-img-env-03） |
| AC-IMG-013.3 | 集成 | 绕过前端提交 51 条 | 保存 | 平台拒绝（`VALIDATION_FAILED`，details 的 path=env），前端标成整表错误 | 已实现：env-var-set.vo.ts:62-68，mapEnvErrorResponse.ts:107-111 |

### REQ-IMG-014 · 保存运行参数：成功一句，平台拒绝映回具体行 {#REQ-IMG-014}

> 状态 `部分实现` · 版本 MVP · 来源 P21-4 §10.2–10.4（L342-386，没写保存后的反馈）；F21-4 L244（按 path 定位到行）；10 §6.8（错误信封）；UX-DS-305、UX-DS-508；实现 ImagesContainer.tsx:157-197，useImages.ts:843-891，mapEnvErrorResponse.ts:77-129，useImageMutations.ts:148-160，provision-sandbox.workflow.ts:463，image-facade.adapter.ts:180-216 · 稿件：无单独稿（成功提示用 W0 轻提示，见 notes/img-a.md「接线」）

点 [保存运行参数]（`PATCH /api/images/:id {imageConfig}`）：按钮「保存中…」，编辑器整体禁用。成功：编辑器收起，摘要按库里新值更新，轻提示「运行参数已保存。」（摘要更新是原位结果，轻提示只作补充）。

平台拒绝（400 `VALIDATION_FAILED`）时，按 `details[].path`（`env[i].key` / `env[i].value` / `env`）把错误标回具体那一格或整表，**不得**整表一句了事；归不了位的（未知码、指向已删掉的行、没有 details）在编辑器下面一句整体错误（role=alert）并逐条列出，**不得**吞掉。其它失败（网络、5xx）同样写在编辑器下面那一句的位置，草稿保留，轻提示只作补充。

保存后的运行参数在之后开始准备的任务里生效（任务准备阶段读入，Secret 此时才解密），已经在跑的任务不受影响。

**改写了哪条旧文**：P21-4 §10 没写保存后的反馈 → 补成功一句（实现先行：useImages.ts:863）与失败的去处；F21-4 L244 原样保留。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-IMG-014.1 | e2e | ml-agent 编辑器里把 LOG_LEVEL 改成 debug | 点 [保存运行参数] | 「保存中…」、编辑器禁用；成功后编辑器收起，摘要变成「LOG_LEVEL=debug · MY_SECRET=*** · HTTP_TIMEOUT=30」，轻提示「运行参数已保存。」 | 已实现（实现先行）：useImages.ts:858-864，ImagesContainer.tsx:157-197，useImageMutations.ts:148-160 |
| AC-IMG-014.2 | 集成 | 平台回 400，details = [{path: `env[1].key`, code: `ENV_NAME_RESERVED`}] | 保存 | 第 2 行变量名下「该变量名为系统保留，请使用凭证管理配置」；其它行不标；编辑器不收起 | 已实现：mapEnvErrorResponse.ts:97-126，useImages.ts:870-884 |
| AC-IMG-014.3 | 集成 | 平台回 400，details 里一条 path 指向已删掉的第 9 行、一条是未知码 | 保存 | 编辑器下面一句整体错误（role=alert）+ 这两条逐条列出 | 已实现：mapEnvErrorResponse.ts:86-128，ImagesContainer.tsx:169-183 |
| AC-IMG-014.4 | 集成 | 网络断开 | 保存 | 编辑器下面一句「保存失败，请稍后重试。」（role=alert），草稿保留 | 偏离：只出失败轻提示（useImages.ts:866-869），编辑器下没有原位句 |
| AC-IMG-014.5 | 集成 | 保存了新的运行参数 | 之后新建一个任务；看一个已在跑的任务 | 新任务带新值；已在跑的任务不变 | 已实现（按代码推断，未实测）：provision-sandbox.workflow.ts:463 → image-facade.adapter.ts:180-216 在准备阶段读入 |

## IMG · 镜像版本（F-IMG-VERSION）

### REQ-IMG-020 · 运行的版本：短串、原位展开全串、复制完整版本号 {#REQ-IMG-020}

> 状态 `部分实现` · 版本 MVP · 来源 P21-4 L44、L51（截断形态）；F21-4 L294；matrix U-49、U-50；实现 ImageCard.view.tsx:84-86、155-198，imageCardModel.ts:28-48，useImages.ts:678-689 · 关联 T-21 · 稿件 f-img-version-03

每张卡的「运行的版本：」一格**必须**显示这一版的版本号（digest）短串——前 12 位 +「…」+ 尾 3 位，等宽——后面跟 [展开全串]、[复制] 与「解析于 X 前」。[展开全串] 在原位把短串换成完整的 71 个字符（窄时可在任意字符处折行，**不得**撑出横向滚动），按钮变 [收起]，开关带 aria-expanded；这是纯本地显示，不发请求，刷新后回到收起。全串点一下**必须**选中整串——复制失败时用户要能手动复制。[复制] **必须**复制完整版本号（`sha256:` + 64 位），不是 tag；成功给轻提示「版本号已复制。」，失败（http 的局域网部署里浏览器不给剪贴板）给失败轻提示「复制失败（需要 HTTPS 或 localhost 才允许自动复制），请手动选中复制。」，**不得**静默。还没有确定版本（digest 缺）时写「版本未确定」，不显示假哈希，也没有这两个按钮。

**改写了哪条旧文**：P21-4 L44、L51 只画了「钉定 digest: sha256:9f2a…c31」的截断形态；F21-4 L294 写了「点击展开全串 + 一键复制」，但没写展开在哪、复制什么、成功失败怎么说 → 本条补齐。标签「钉定 digest」→ 按实现写「运行的版本」（ImageCard.view.tsx:158）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-IMG-020.1 | 组件 | ml-agent 当前版本 sha256:8e05a5d5…150d77 | 渲染卡片 | 「运行的版本：sha256:8e05a…d77」+ [展开全串] + [复制] +「解析于 3 天前」 | 已实现：ImageCard.view.tsx:155-198，imageCardModel.ts:28-48 |
| AC-IMG-020.2 | 组件 | 同上，收起态 | 点 [展开全串]，再点 [收起] | 原位换成 71 字符全串，按钮变 [收起] 且 aria-expanded="true"；全串在卡宽内折行，页面不出现横向滚动；再点回到短串、aria-expanded="false"；全程不发请求 | 部分实现：原位切换已实现（ImageCard.view.tsx:160-168）；开关没有 aria-expanded，全串没有折行约束（稿件 f-img-version-03） |
| AC-IMG-020.3 | 组件 | 展开态 | 在全串上点一下 | 整串被选中 | 未实现（稿件 f-img-version-03：user-select: all） |
| AC-IMG-020.4 | 集成 | 安全上下文（HTTPS 或 localhost） | 点 [复制] | 剪贴板里是完整版本号（不是 tag）；轻提示「版本号已复制。」 | 已实现：useImages.ts:678-684，ImageCard.view.tsx:169-180 |
| AC-IMG-020.5 | 集成 | 用 http 局域网地址打开（没有 navigator.clipboard） | 点 [复制] | 失败轻提示「复制失败（需要 HTTPS 或 localhost 才允许自动复制），请手动选中复制。」（role="alert"），不出成功提示 | 已实现：useImages.ts:685-687 |
| AC-IMG-020.6 | 组件 | 某一版 digest 为空 | 渲染卡片 | 「版本未确定」（警示图标），没有 [展开全串] / [复制]；[检查更新] 置灰并写原因「这张镜像还没有确定版本，没有可比对的基准」（REQ-IMG-021） | 已实现：ImageCard.view.tsx:182-191，imageCardModel.ts:30-34、127-130 |

### REQ-IMG-021 · [检查更新]：解析中、已是最新、tag 已不在、有新版本；不能检查时写原因 {#REQ-IMG-021}

> 状态 `已实现` · 版本 MVP · 来源 P21-4 L75、L99、L125-129、L138、L228；F21-4 L330-335、L349-351；matrix U-52、U-100；实现 ImageCard.view.tsx:200-204、284-294，useImages.ts:512-558，image-application.service.ts:337-377，imageCardModel.ts:30-34、127-150 · 关联 UX-DS-204 · 稿件 f-img-version-02（解析中）、f-img-version-01（有新版本）

[检查更新] 回答「这个 tag 现在还指向它吗」：重新解析 tag、和卡上的版本号比对，**不写库、不换版本**。只在用户点了才查，不轮询、不自动切换。点了之后按钮「解析中…」禁用（v2 带前缀转圈），卡片其余部分**一个字不改**、不整卡骨架，同卡其他按钮照常可点。结果四种：

| 结果 | 用户看到 |
|---|---|
| 没变 | 轻提示「已是最新（sha256:…）」 |
| 下载源上已经找不到这个 tag | 中性轻提示「镜像下载源上已经找不到这个 tag 了，所以没有可更新的目标。平台没有顺带去查你锁定的那一版还在不在源里 —— 那要等下一次真的拉取时才知道。」；不当失败，**不得**说「当前版本仍可正常拉取」（那件事没查过） |
| 变了 | 卡上出信息色提示条 + 打开对比弹层（REQ-IMG-022） |
| 失败（下载源不可达、超时等） | 失败轻提示（后端给的原因与出路），卡片不变，按钮恢复 |

按版本直接注册的镜像（坐标带 `@sha256:…`，没有 tag）不会有新版本：[检查更新] 置灰并写原因「这张镜像是直接按版本注册的（没有 tag），所以不会有新版本」，卡上同时标「按版本直接注册（没有 tag）」；版本未确定时置灰写「这张镜像还没有确定版本，没有可比对的基准」。置灰不隐藏。

**改写了哪条旧文**：P21-4 L99「以 digest 注册（无 tag）」+ tooltip「该镜像以 digest 注册，不存在上游漂移」→ 按实现「按版本直接注册（没有 tag）」与上面的原因句（Q-DS-21 A：上屏不写 digest）；P21-4 L126、L228 只有「未变 / 已变」两档 → 补「tag 已不在」与「失败」两档（实现 useImages.ts:517-526、552-554）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-IMG-021.1 | 组件 | 预制镜像卡 | 点 [检查更新]，服务端未返回 | 按钮「解析中…」禁用；结论、版本号、解析时间与点击前逐字相同；[重新验证] [禁用] 仍可点 | 已实现：ImageCard.view.tsx:288-293，useImages.test.tsx:159（前缀转圈属 v2 换皮，稿件 f-img-version-02） |
| AC-IMG-021.2 | 集成 | 上游 tag 仍指向同一版 | 返回 | 轻提示「已是最新（sha256:4b17e…344）」；不开弹层、不改卡片 | 已实现：useImages.ts:527-529 |
| AC-IMG-021.3 | 集成 | 下载源回 tag 不存在（upstream 为 null） | 返回 | 中性轻提示（上表那句）；不开弹层、不当失败 | 已实现：useImages.ts:517-526，useImages.test.tsx:367、395 |
| AC-IMG-021.4 | API | 一行按 `@sha256:` 注册的镜像 | POST /api/images/:id/check-update | 409 INVALID_STATE，message 说「按版本直接注册…不会有新版本可以检查」；界面上这颗按钮本来就是置灰并写了原因 | 已实现：image-application.service.ts:346-352，imageCardModel.ts:127-150，ImageCard.view.tsx:200-204、288-290 |
| AC-IMG-021.5 | 集成 | 下载源不可达 | 点 [检查更新] | 失败轻提示带后端原因与出路；卡片不变；按钮回到 [检查更新] | 已实现：useImages.ts:237-256、552-554 |
| AC-IMG-021.6 | 集成 | 打开镜像页、停留 | 观察请求 | 不出现定时的 check-update；只由 [检查更新] / [查看变更] 触发 | 已实现：ImagesContainer.tsx:208-220（P21-4 L138「MVP 仅手动检查更新」） |

### REQ-IMG-022 · 上游有新版本：信息色提示条 + 对比弹层，用户点了才更新 {#REQ-IMG-022}

> 状态 `部分实现` · 版本 MVP · 来源 P21-4 L97、L182-184、L215-217、L228；P20 L348；matrix U-52、U-100；实现 ImageCard.view.tsx:237-258，UpdateCompareDialog.view.tsx，useImages.ts:512-558、632-671，ImagesContainer.tsx:41、218-220、254-269 · 关联 T-23 · 稿件 f-img-version-01

[检查更新]（或 [重新验证]，见 REQ-IMG-023）发现上游这个 tag 已经指向另一版时，卡上元信息之后**必须**出一条**信息色**提示条（不是告警色——当前这一版完全可用）：「下载源上这个 tag 已经指向另一版（sha256:…）」+ [查看变更]；由 [检查更新] 发现的那一次同时打开对比弹层。

对比弹层（模态）写：标题「上游有新版本」、坐标、当前（短串 +「解析于 X 前」）/ 上游（短串）两行、上游新版本的三级结论、作用范围一句（REQ-IMG-025）；页脚 [暂不更新] 在左、[更新到新版本] 在右（主按钮）。上游新版本判为无效时**不得**给 [更新到新版本]（不是置灰，是不出现）：只剩 [暂不更新]，并写「上游新版本不满足平台约定，已保留当前版本。」+ [查看镜像要求]——一次检查不能把正在用的镜像变得不能用。

[暂不更新] 或 Esc：关弹层，什么都不写，提示条留着；之后点 [查看变更] 会重新检查一次再开弹层。[更新到新版本] = 先把新版本登记成一行，再把这个 tag 的当前版本切到它（与 [切换到此版本] 同一个动作，REQ-IMG-024），**不是**改旧行；进行中「更新中…」、两个按钮禁用、Esc 不关；成功后弹层关闭、卡面换成新版本、原来那一版进历史条、提示条消失，轻提示「已更新到新版本（sha256:…）。」+ 作用范围一句；失败时弹层不关、按钮恢复、失败轻提示，再点会接着做（登记按镜像与版本号幂等）。

**改写了哪条旧文**：P21-4 L97 角标文案「上游该 tag 已指向新镜像 [查看变更]」→ 按实现「下载源上这个 tag 已经指向另一版（sha256:…）」（Q-DS-21 A：「镜像仓库」→「镜像下载源」）；P21-4 L228 弹层内容沿用，新增作用范围一句（v2 新增，需看稿）；P21-4 L216「上游新版本不满足平台约定（缺少 tmux），已保留当前版本」→ 原因写进结论清单，句子按实现「上游新版本不满足平台约定，已保留当前版本。」

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-IMG-022.1 | 组件 | ml-agent 检查更新返回 changed | 返回 | 卡上出信息色提示条（data-tone="info"）「下载源上这个 tag 已经指向另一版（sha256:c1f9e…a20）」+ [查看变更]；对比弹层打开 | 已实现：useImages.ts:531-550，ImageCard.view.tsx:237-258（提示条形态见稿件 f-img-version-01） |
| AC-IMG-022.2 | 组件 | 上游新版本有效 | 看弹层 | 当前「sha256:8e05a…d77（解析于 3 天前）」/ 上游「sha256:c1f9e…a20」；结论「验证通过 · 镜像可用」；作用范围一句；[暂不更新] 在左、[更新到新版本] 在右 | 部分实现：内容与两个按钮已实现（UpdateCompareDialog.view.tsx:60-94，story UpstreamValid）；作用范围一句未实现；按钮位置见稿件 f-img-version-01 |
| AC-IMG-022.3 | 组件 | 上游新版本判为无效 | 看弹层 | 没有 [更新到新版本]；「上游新版本不满足平台约定，已保留当前版本。」+ [查看镜像要求] | 已实现：UpdateCompareDialog.view.tsx:44、79-94，story UpstreamInvalid |
| AC-IMG-022.4 | 集成 | 弹层开着 | 点 [暂不更新] 或按 Esc；再点 [查看变更] | 弹层关闭，卡片与版本都不变，提示条还在；[查看变更] 先重新检查（按钮「解析中…」）再开弹层 | 已实现：useImages.ts:632-635，ImagesContainer.tsx:41、218-220 |
| AC-IMG-022.5 | 集成 | 上游新版本有效 | 点 [更新到新版本] | 「更新中…」、两个按钮禁用、Esc 不关；先登记新版本行再切过去（旧行不改）；成功后弹层关闭、卡面是 c1f9e…a20、8e05a…d77 进历史条、提示条消失；轻提示「已更新到新版本（sha256:c1f9e…a20）。」+ 作用范围一句 | 部分实现：行为已实现（useImages.ts:637-671，ImagesContainer.tsx:41，useImages.test.tsx:314）；轻提示没有作用范围一句 |
| AC-IMG-022.6 | 集成 | 登记成功、切换失败 | 点 [更新到新版本] | 弹层不关、按钮恢复、失败轻提示；再点一次接着做（登记命中已有行回 200，不重复建行） | 已实现：useImages.ts:653-669（幂等：P21-4 L227、27 §6） |

### REQ-IMG-023 · [重新验证]：原位转圈、结论原位改写，判为无效也不自动禁用 {#REQ-IMG-023}

> 状态 `偏离` · 版本 MVP · 来源 P21-4 L139、L229、L268-271；F21-4 L329-335、L351、L450、L550；matrix U-53、U-100；实现 ImageCard.view.tsx:118-136、295-303，useImages.ts:258-266、489-510，image-facade.adapter.ts:238-242 · 关联 UX-DS-204、UX-DS-508 · 稿件 f-img-version-02

[重新验证] 回答「这一版还合格吗」：对卡上这一版（已锁定的版本号）按平台当前的规则重跑校验，**不换版本**、不动启用状态。点了之后按钮「重新验证中…」禁用，结论那一行末尾同时出「重新验证中…」（role="status"）；服务端返回前结论、版本号、解析时间**一个字不改**，不整卡骨架，不做乐观更新。返回后结论在原位改写（徽标 + 一句 + 原因清单；无效时 role="alert" 并给 [查看镜像要求]），轻提示按结论补一句（结论本身已在原位播报，轻提示只是补充，UX-DS-508）：

| 结论 | 轻提示（色调） |
|---|---|
| 有效 | 「这一版仍通过平台校验（启动命令、工作目录、预装声明）。本次没有重新检查它是从哪张预制镜像改来的 —— 那是注册时判定的。」（成功） |
| 有警告 | 「重新验证通过，但有警告——后果说明在卡上。」（中性） |
| 无效 | 「重新验证不通过：平台校验规则已更新，这一版现已不满足要求。」（失败色，role="alert"） |

判为无效**不得**自动禁用：卡片仍「已启用」，新任务在门口被拒（I-IMG-2），由用户决定禁用还是换版本（`is_active` 是用户意图，校验结论是平台判定，两者不互相写）。重新验证时若发现上游这个 tag 已经指向另一版：**不写回结论**（结论描述的是另一份内容），卡上出提示条（同 REQ-IMG-022），中性轻提示「镜像下载源上这个 tag 已经指向另一版（sha256:…）；你正在用的这一版结论未变。点 [检查更新] 看对比。」。失败时卡片保持原结论，失败轻提示。

**改写了哪条旧文**：P21-4 L229、L139、L268-271 沿用；新增三档结论的说法与色调（P21-4 只写了 L269 无效时卡上那一句）；现状「有警告」那句「…展开卡片看后果说明」→「…后果说明在卡上」（v2 卡片不折叠，后果说明本来就在卡上）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-IMG-023.1 | 组件 | ml-agent（有警告） | 点 [重新验证]，服务端挂起 | 按钮「重新验证中…」禁用；结论行末尾「重新验证中…」（role="status"）；结论、版本号、解析时间与点击前逐字相同 | 已实现：ImageCard.view.tsx:125-135、295-303，F21-4 L450（位置：现状在结论区右上角绝对定位，v2 跟在结论行末尾，稿件 f-img-version-02） |
| AC-IMG-023.2 | 集成 | 服务端返回 warning | 返回 | 结论原位不变；中性轻提示「重新验证通过，但有警告——后果说明在卡上。」 | 偏离：句子是「…展开卡片看后果说明。」，三档都用成功色（useImages.ts:258-266、502） |
| AC-IMG-023.3 | 集成 | 服务端返回 invalid | 返回 | 结论原位改成「无效」+ 原因 + [查看镜像要求]（role="alert"）；卡片仍「已启用」，不发禁用请求；失败色轻提示 | 部分实现：不自动禁用、结论改写已实现（useImages.ts:489-510，P21-4 L268-271）；轻提示是成功色 |
| AC-IMG-023.4 | 集成 | 返回 digestChanged=true | 返回 | 结论不改；卡上出上游提示条；中性轻提示（上文那句） | 已实现：useImages.ts:493-500 |
| AC-IMG-023.5 | API | 这一版被判 invalid | 用它发起新任务 | 门口拒绝（INVALID_IMAGE_REFERENCE：「…的校验结论是 invalid，不能被新任务引用」）；已有任务不受影响 | 已实现：image-facade.adapter.ts:238-242 |

### REQ-IMG-024 · [切换到此版本]：不确认、被点的那一行「切换中…」、卡面与历史条换位 {#REQ-IMG-024}

> 状态 `偏离` · 版本 MVP · 来源 P21-4 L182-184、L264；P20 L348；F21-4 L553；matrix U-56、U-104；plan F-IMG-VERSION 默认「切换到此版本不确认（按实现）」；实现 ImageVersionHistory.view.tsx:53-100，useImages.ts:337-344、560-572，ImagesContainer.tsx:224-228，imageManifestCards.ts:152-191，image-application.service.ts:312-335 · 关联 DR-39 · 稿件 f-img-version-04

同一张镜像的其他版本收在卡片页脚的历史条里（注册时间倒序）：每行写版本 tag、短串、状态（有效 / 有警告 / 无效 / 未判定）；卡面那一版不进历史条；同一张镜像另一个 tag 的当前版本在历史条里标「（当前版本）」、不给按钮。

[切换到此版本] 把这个 tag 的当前版本挪到那一行——与 [更新到新版本]、回滚是同一个动作（activate，一个事务里完成，任何时刻一个 tag 只有一行当前），**不弹确认**（plan 默认，按实现），后果在结果里说清（REQ-IMG-025）。进行中**被点的那一行**按钮「切换中…」禁用，卡面与其他行不动；成功后卡面整张换成那一版自己的样子（结论、适用、解析时间、运行参数，REQ-IMG-026），原来那一版进历史条、带 [切换到此版本]；轻提示「已切换到该版本。」+ 作用范围一句。失败：卡面与历史条不变，失败轻提示。判为无效的版本**不得**切过去（切了之后新任务都会被门口拒）：按钮置灰，旁边写原因「这一版校验不通过，切过去新任务会被拒」（DR-39）。

**改写了哪条旧文**：P21-4 只定义了底层语义（L182-184、L264：新增一行 + 旧行下线、版本行不可变；P20 L348：activate 同时是回滚），没有「切换到此版本」的界面口径（U-56）→ 本条补：不确认、进行中、换位、结果说法、无效版本不能切。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-IMG-024.1 | 组件 | ml-agent：卡面 8e05a…d77，历史一行 2c9d1…b08（有效） | 渲染 | 页脚「历史版本（1）」+「v1.0 · sha256:2c9d1…b08 · 有效」+ [切换到此版本]；卡面那一版不在历史条里 | 已实现：imageManifestCards.ts:164-191，ImageVersionHistory.view.tsx:53-100 |
| AC-IMG-024.2 | 集成 | 同上 | 点历史行的 [切换到此版本]，服务端挂起 | 不弹确认；这一行按钮「切换中…」禁用；卡面不动 | 偏离：不确认已实现（useImages.ts:560-572）；「切换中…」落不到被点的那一行——容器把 switchingId 接成卡面行 id（ImagesContainer.tsx:226），toggling 只认卡面行（useImages.ts:341-343），被点的行一直可点；view 自己的故事 Switching 是绿的（ImageVersionHistory.view.stories.tsx:93-97） |
| AC-IMG-024.3 | 集成 | 同上 | 服务端返回成功 | 卡面换成 2c9d1…b08（验证通过 · 镜像可用、适用 codex、claude-code、解析于 12 天前、运行参数是那一版自己的）；8e05a…d77（有警告）进历史条并带 [切换到此版本]；轻提示「已切换到该版本。」+ 作用范围一句 | 部分实现：换位已实现（重取列表后按当前行聚合，imageManifestCards.ts:164-191）；轻提示只有「已切换到该版本。」（useImages.ts:564）（稿件 f-img-version-04） |
| AC-IMG-024.4 | 集成 | 切换失败（后端 5xx） | 点 [切换到此版本] | 卡面与历史条不变；失败轻提示 | 已实现：useImages.ts:566-568 |
| AC-IMG-024.5 | 组件 | 历史里有一行判为无效 | 渲染 | 这一行的 [切换到此版本] 置灰，旁边写「这一版校验不通过，切过去新任务会被拒」 | 未实现：按钮总是可点（ImageVersionHistory.view.tsx:89-99），后端 activate 也不看结论（image-application.service.ts:325-335） |
| AC-IMG-024.6 | API | 同一 tag 有两行 | POST /api/images/:id/activate（目标为历史行） | 同一事务里目标行设为当前、同 tag 其余行下线 | 已实现：image-application.service.ts:312-335（I-IMG-8） |

### REQ-IMG-025 · 换版本的作用范围：只影响之后新建的任务，并在结果里说清 {#REQ-IMG-025}

> 状态 `部分实现` · 版本 MVP · 来源 P21-4 L264、L267；matrix U-104；DR-19（已停止的任务 [启动] 时还用它锁定的那一版）；实现 sandbox-application.service.ts:287、298、344-383 · 稿件 f-img-version-01（弹层里的一句）、f-img-version-04（轻提示）

任务在新建时锁定当时那一版（存的是版本行，不是 tag）；之后这张镜像怎么更新、切换、回滚，已经建好的任务（运行中、已停止的都算）都继续用它锁定的那一版，只有之后新建的任务用新的当前版本。因为更新与切换都不确认，这句后果**必须**在用户能看到的地方说清：对比弹层在 [更新到新版本] 之前写「只影响之后新建的任务；已经建好的任务继续用各自建的时候锁定的那一版。」；更新 / 切换成功的轻提示在标题后带同一句。

**改写了哪条旧文**：P21-4 L267「更新不再改写历史 Task 的镜像溯源」是技术口径，界面上没有任何一句告诉用户 → 写成上屏的一句（v2 新增文案，需看稿）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-IMG-025.1 | 集成 | 一个运行中的任务建于 8e05a…d77 | 把 ml-agent 切到 2c9d1…b08 | 这个任务的镜像仍是 8e05a…d77；之后新建、指定这张镜像的任务用 2c9d1…b08 | 已实现：sandbox-application.service.ts:298（任务存版本行 id）、344-383（门口按当前版本选） |
| AC-IMG-025.2 | 组件 | 对比弹层打开 | 看弹层 | 结论之后、页脚之前有作用范围一句 | 未实现：UpdateCompareDialog.view.tsx 没有这一句（稿件 f-img-version-01） |
| AC-IMG-025.3 | 集成 | 更新或切换成功 | 看轻提示 | 标题「已更新到新版本（sha256:…）。」或「已切换到该版本。」，正文是作用范围一句 | 未实现：useImages.ts:564、644、660 只有标题（稿件 f-img-version-04） |

### REQ-IMG-026 · 运行参数跟着版本走：更新时带过去，切换时用那一版自己的 {#REQ-IMG-026}

> 状态 `偏离` · 版本 MVP · 来源 P21-4 L332（「每个镜像可全局配置运行参数」）；Q-IMG-03 C（用户拍板 2026-10-04，原话「补全 10 条按推荐」；与本片原默认相同）；实现 image-application.service.ts:201-219（新版本行 config 为 null），useImages.ts:637-671、961，imageManifestCards.ts:221-231 · 关联 Q-IMG-03 · 稿件 f-img-version-04（切换后卡面运行参数是那一版自己的）

运行参数（环境变量，含 Secret）挂在版本行上。[更新到新版本] 登记的新版本**必须**带上当前版本的运行参数（Secret 由服务端复制密文，前端不经手明文），更新前后卡面「运行参数」不变；[切换到此版本]（含回滚）用那一版自己当时的那份，切回来时原来那份还在。后端暂时做不到带过去时，对比弹层**必须**在 [更新到新版本] 之前写明「新版本不带运行参数，更新后要重新填」，**不得**让运行参数悄悄变空。

**改写了哪条旧文**：P21-4 L332「每个镜像可全局配置运行参数」与实现（参数挂在版本行上，更新出来的新行是空的）不一致 → 本条取「挂在版本行上 + 更新时带过去」（Q-IMG-03 C，用户拍板 2026-10-04；A「跨版本共用」、B「新版本不带」不再考虑）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-IMG-026.1 | API | ml-agent 当前版本有 3 个环境变量（其中 1 个 Secret） | 检查更新 → [更新到新版本] | 新版本行带同样 3 个变量（Secret 仍是密文）；卡面运行参数摘要不变 | 偏离：新版本行 config 为 null（image-application.service.ts:215），更新后卡面变「（未配置）」，Secret 丢失 |
| AC-IMG-026.2 | 集成 | 两版各有自己的运行参数 | 在两版之间来回切 | 卡面运行参数随当前版本换，切回来时原来那份还在 | 已实现：摘要取卡面那一行自己的 config（useImages.ts:961，imageManifestCards.ts:221-231） |
| AC-IMG-026.3 | 组件 | 后端还不支持带过去 | 打开对比弹层 | 写明「新版本不带运行参数，更新后要重新填」 | 未实现（与 AC-IMG-026.1 二选一：026.1 做到后这一条删掉） |

## IMG · 启用、禁用与删除（F-IMG-STATE）

### REQ-IMG-030 · 禁用：乐观、停用色调、只挡新任务 {#REQ-IMG-030}

> 状态 `偏离` · 版本 MVP · 来源 P21-4 L30、L96、L130、L230；F21-4 L346、L446-447；Q-DS-15 ②A、T-15、UX-DS-138（已禁用画成转圈）、Q-DS-18 A；matrix U-54、U-101；实现 ImageCard.view.tsx:94-96、113-115、304-314，useImageMutations.ts:108-141，useImages.ts:580-596，image-facade.adapter.ts:232-236 · 稿件 f-img-state-01

自定义镜像的 [禁用] 不需要确认（预制镜像要先确认，见 REQ-IMG-032），点了立刻（乐观）显示「已禁用」、按钮变 [启用]；服务端失败时回滚到原状态并说「禁用失败，已回滚。」。「已禁用」是用户主动设的**稳定状态**：停用色调徽标（中性底 + 实心方块，与「已停止」同形），**不得**转圈（转圈 = 进行中），卡片**不得**整体降透明（正文对比度不打折），其余内容照常可读、可操作。成功轻提示：标题「已禁用」+「新任务不能再选用这张镜像；已经在用它的任务不受影响。」。禁用只在新建任务的门口生效：这一版不能再被新任务选用（I-IMG-3），已经建好的任务不受影响；新建任务的「镜像」一栏里它置灰、写「（已禁用）」（REQ-LCH-004，Q-LCH-03 B）。

**改写了哪条旧文**：P21-4 L96「卡片置灰，创建向导不出现」→ 停用色调、不降透明；P21-4 L30、L130、L244、L252 与实现轻提示「…向导下拉里不再出现这张镜像」→「新任务不能再选用这张镜像」：新建任务弹层的「镜像」一栏（Q-LCH-03 B，用户拍板 2026-10-04，REQ-LCH-004）里它置灰、写「（已禁用）」——「向导下拉」是旧称，轻提示不再用这个词。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-IMG-030.1 | 集成 | ml-agent 已启用 | 点 [禁用]，服务端挂起 | 立刻显示「已禁用」、按钮变 [启用]；请求体只有 isActive:false | 已实现：useImageMutations.ts:108-131，useImages.test.tsx:110，F21-4 L446 |
| AC-IMG-030.2 | 集成 | 同上 | 服务端返回 500 | 回到「已启用」；失败轻提示「禁用失败，已回滚。」 | 已实现：useImageMutations.ts:133-137，useImages.ts:590-592，useImages.test.tsx:132 |
| AC-IMG-030.3 | 组件 | 一张已禁用的镜像 | 渲染卡片 | 徽标「已禁用」：中性底 + 实心方块、不转圈；卡片不降透明 | 偏离：徽标用 pending（转圈，ImageCard.view.tsx:113-115，status-pill.tsx:44、99；UX-DS-138），整卡 opacity-60（ImageCard.view.tsx:94-96）（稿件 f-img-state-01） |
| AC-IMG-030.4 | 集成 | 禁用成功 | 看轻提示 | 标题「已禁用」+「新任务不能再选用这张镜像；已经在用它的任务不受影响。」 | 偏离：「已禁用，向导下拉里不再出现这张镜像。」（useImages.ts:588） |
| AC-IMG-030.5 | API | ml-agent 这一版已禁用 | 指定它发起新任务 | 门口拒绝（INVALID_IMAGE_REFERENCE：「…已停用，不能被新任务选用；已有任务的引用不受影响」）；已建好的任务照常 | 已实现：image-facade.adapter.ts:232-236 |

### REQ-IMG-031 · 启用：走「切到这一版」，说清结果 {#REQ-IMG-031}

> 状态 `偏离` · 版本 MVP · 来源 P21-4 L131、L230；F21-4 L446、L551-553；matrix U-54、U-101；实现 useImages.ts:560-585，image-application.service.ts:299、312-335，imageManifestCards.ts:161-175 · 关联 UX-DS-204 · 稿件 f-img-state-01（[启用] 按钮）

[启用] 把卡面那一版重新设为这个 tag 的当前版本（activate，与 [切换到此版本] 同一个端点），**不得**用 PATCH isActive:true（后端回 400 并指向 activate）。不做乐观更新：进行中按钮「启用中…」禁用；成功后徽标回「已启用」、按钮回 [禁用]，轻提示标题「已启用」+「新任务又可以选用这张镜像了。」；失败卡片不变、失败轻提示。一行当前版本都没有时（全部禁用、或删掉了当前那一版），卡面是最近登记的那一行，[启用] 启用的就是它。

**改写了哪条旧文**：P21-4 L230「[禁用]/[启用]：乐观更新 + PATCH /api/images/:id {is_active}」→ 禁用 PATCH {isActive:false} 乐观、启用 POST activate 不乐观（F21-4 L446、L551；后端 image-application.service.ts:299）；现状启用成功说「已切换到该版本。」（复用了切换版本的回调）→「已启用」。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-IMG-031.1 | 集成 | ml-agent 已禁用 | 点 [启用] | 发 POST /api/images/:id/activate，没有任何 PATCH | 已实现：useImages.ts:580-585，useImages.test.tsx:286 |
| AC-IMG-031.2 | 组件 | 同上 | 服务端挂起 | 按钮「启用中…」禁用 | 偏离：按钮禁用但文案不变（ImageCard.view.tsx:304-314；UX-DS-204 要求「X 中…」） |
| AC-IMG-031.3 | 集成 | 服务端返回成功 | 看卡片与轻提示 | 「已启用」、按钮 [禁用]；轻提示「已启用」+「新任务又可以选用这张镜像了。」 | 偏离：轻提示是「已切换到该版本。」（toggle 复用 activateVersion，useImages.ts:564、582-584） |
| AC-IMG-031.4 | 单元 | 一张镜像没有任何当前版本 | 聚合成卡 | 卡面是最近登记的那一行，显示「已禁用」+ [启用]，整张卡不消失 | 已实现：imageManifestCards.ts:161-175 |

### REQ-IMG-032 · 预制镜像：不能删；禁用前先确认，说清新任务默认用不了它 {#REQ-IMG-032}

> 状态 `部分实现` · 版本 MVP · 来源 P21-4 L76、L136、L249；I-IMG-4；Q-IMG-04 A（用户拍板 2026-10-04，原话「补全 10 条按推荐」：禁用预制镜像先弹一步非破坏性确认）；Q-IMG-06 A（同日拍板：徽标与正文统一写「预制」）；实现 ImageCard.view.tsx:103、315-320，useImageMutations.ts:108-131，useImages.ts:580-596，image-application.service.ts:383-390，image-facade.adapter.ts:44-47、77-85 · 关联 REQ-IMG-030、REQ-IMG-031、REQ-LCH-004 · 稿件 f-img-state-04（禁用预制镜像的确认）

预制镜像（平台自带、开机播种）**不得**删除：卡上没有 [删除]，后端也拒删（I-IMG-4）。它可以禁用，但后果比自定义镜像重：新建任务的「镜像」一栏默认就是它（REQ-LCH-004），不改镜像发起的任务都用它——它一旦一行当前版本都没有，用它的新任务都会被门口拒（「镜像 '…' 的所有版本都已停用，不能被新任务选用；请先启用一个版本。」），直到重新启用它，或在新建任务里改选别的镜像。

所以预制镜像的 [禁用] **必须**先出一步非破坏性确认（Q-IMG-04 A，用户拍板 2026-10-04）：标题「禁用预制镜像「<坐标>」？」，副标题「平台预制镜像 · 当前版本 <短串> · 已启用」；正文「在重新启用之前，用它的新任务都会在发起时被拒：新建任务默认用它，自动化规则到点发起的任务也用它。要接着发任务：重新启用它，或者在新建任务里换一张已启用的镜像。已经在跑的任务不受影响；随时可以在这张卡上点 [启用] 恢复。」；页脚 [取消]（打开时焦点在这里）/ [禁用]（普通次按钮，**不用**危险色——可逆，随时能 [启用] 回来）；Esc、点遮罩都等于取消。确认之后照常乐观禁用（REQ-IMG-030），轻提示标题「已禁用」+「在重新启用之前，新任务默认用不了它；可以在新建任务的「镜像」一栏改选别的镜像。」。自定义镜像的 [禁用] 不确认（REQ-IMG-030）。重新启用后恢复（REQ-IMG-031；预制镜像的启用轻提示正文写「新任务可以照常发起了。」）。

卡上标明它是平台自带的那枚徽标写「预制」，与正文的「预制镜像」同一个词（Q-IMG-06 A，用户拍板 2026-10-04；旧称「预置」不再上屏）。

**改写了哪条旧文**：P21-4 L136、L249「预置镜像不可删除，仅可禁用」→ 沿用，上屏统一写「预制镜像」（Q-IMG-06 A）；补「禁用前先确认、说清新任务默认用不了它」（P21-4 没写；实现：web 发起任务不带 image 时门口取这一档的预制镜像，image-facade.adapter.ts:44-47；Q-IMG-04 A）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-IMG-032.1 | 组件 | 预制镜像卡 | 渲染 | 没有 [删除] | 已实现：ImageCard.view.tsx:315-320 |
| AC-IMG-032.2 | API | 预制镜像的一行 | DELETE /api/images/:id | 409 INVALID_STATE，不删 | 已实现：image-application.service.ts:383-390 |
| AC-IMG-032.3 | API | 预制镜像所有版本都已禁用 | 不带 image 发起新任务；再带上一张可用的自定义镜像发起 | 前者门口拒绝 IMAGE_NOT_REGISTERED：「…所有版本都已停用，不能被新任务选用（I-IMG-3）；请先启用一个版本。」；后者照常受理 | 已实现：image-facade.adapter.ts:44-47、77-85 |
| AC-IMG-032.4 | 集成 | 预制镜像已启用 | 点 [禁用]，先点 [取消]；再点一次并确认 | 先出确认：标题「禁用预制镜像「ghcr.io/agent-infra/sandbox:latest」？」、副标题与后果句（新任务默认用它、自动化到点发起的也用它；要接着发就重新启用或换一张镜像；在跑的不受影响）；焦点在 [取消]；[禁用] 不是危险色；[取消] / Esc 什么都不发；确认后才发 PATCH isActive:false，轻提示「已禁用」+ 后果句 | 未实现：没有确认，点了直接乐观禁用（useImageMutations.ts:108-131），轻提示与自定义镜像同一句「…向导下拉里不再出现这张镜像。」（useImages.ts:588）（稿件 f-img-state-04） |
| AC-IMG-032.5 | 组件 | 镜像页有预制镜像与自定义镜像 | 渲染卡片 | 预制镜像卡的徽标写「预制」；整页不出现「预置」 | 偏离：徽标写「预置」（ImageCard.view.tsx:103） |

### REQ-IMG-033 · 删除确认：只给自定义镜像，打开就把后果写全 {#REQ-IMG-033}

> 状态 `偏离` · 版本 MVP · 来源 P21-4 L132-133、L231、L249；Q-DS-17 A / B；DR-07；matrix U-55、U-102；实现 ImagesContainer.tsx:42、278-287，ConfirmDialog.view.tsx:33-37，useImages.ts:598-628，image-application.service.ts:379-410，imageManifestCards.ts:161-175 · 关联 DR-07 · 稿件 f-img-state-02

只有自定义镜像有 [删除]（危险色文字按钮）。点了打开统一破坏性确认（Q-DS-17 A，与项目、凭证的删除同一结构）：标题「删除镜像「<坐标>」？」，副标题「自定义镜像 · 当前版本 <短串> · <启用状态>」；正文按「会删掉 / 会留下 / 删掉之后 / 不受影响」逐段写实，末尾一行清单来源；打开时焦点在 [取消]；[删除镜像] 危险色。删除的对象是**卡面这一版的登记**（一行），不是整张镜像：

| 段 | 写什么（ml-agent 示例；just-registered 版见 notes/img-b.md） |
|---|---|
| 会删掉 | 这一版的登记 · v1.0 · sha256:8e05a…d77——连同它的验证结论和运行参数（3 个环境变量，其中 1 个是 Secret）。这是最后一版时：这张镜像的卡片也会从列表消失 |
| 会留下 | 历史里的其他版本（卡片会退回到最近登记的那一版，它现在没有启用；要继续用这张镜像，到卡片上点 [启用]）· 这台机器上已经下载的镜像层（平台不清理本机缓存，删除不会腾出磁盘空间） |
| 删掉之后 | 拿不回来；要再用这一版，只能重新注册同一个地址——那时会按镜像下载源上当时的内容重新锁定版本，未必还是同一版 |
| 不受影响 | 镜像下载源（docker.io）上的镜像本身 · 已有的任务（现在没有任务在用这一版） |

版本列表取自已加载的镜像列表；「有没有任务在用这一版」**必须**由后端只读预检给（DR-07），读不到时明说「清单读不到」，**不得**由前端猜。有任务在用时打开即是被拦态（REQ-IMG-034）。确认后按钮「删除中…」、Esc 不关；成功关弹层，轻提示「已删除。」；失败（例如打开确认之后有任务开始用这一版，后端 409）弹层不关，就地换成被拦态。

**改写了哪条旧文**：P21-4 L231「仅自定义镜像；二次确认"不可逆"」→ 统一破坏性确认四段（Q-DS-17 A）；现状确认框「删除镜像版本」+ 一段话「即将删除 {名}（{版本}）这一行 manifest。此操作不可逆；被 Task 引用中的版本会被平台拒绝删除，那时请改为 [禁用]。」→ 偏离。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-IMG-033.1 | 组件 | 自定义镜像卡 / 预制镜像卡 | 渲染 | 自定义镜像有 [删除]；预制镜像没有 | 已实现：ImageCard.view.tsx:315-320 |
| AC-IMG-033.2 | 组件 | ml-agent 这一版没有任务在用 | 点 [删除] | 标题「删除镜像「docker.io/acme/ml-agent:v1.0」？」；四段与清单来源（上表）；焦点在 [取消]；[删除镜像] 危险色 | 偏离：「删除镜像版本」+ 一段话，确认按钮不是危险色，焦点不在 [取消]（ImagesContainer.tsx:278-287，ConfirmDialog.view.tsx:33-37）（稿件 f-img-state-02） |
| AC-IMG-033.3 | API | 打开确认 | 读受影响清单 | 后端只读预检返回：这张镜像的版本列表、引用这一版的未销毁任务（名称 · 项目 · 状态） | 未实现：只有 DELETE 时 409 带一个数量（image-application.service.ts:391-398；DR-07） |
| AC-IMG-033.4 | 集成 | 确认删除 | 点 [删除镜像] | 按钮「删除中…」禁用、Esc 不关；成功关弹层、轻提示「已删除。」；还有其他版本时卡片退回最近一版并显示「已禁用」+ [启用]；最后一版时整张卡消失 | 部分实现：结果已实现（useImages.ts:611-617，image-application.service.ts:399-409，imageManifestCards.ts:161-175）；进行中文案是「处理中…」（ConfirmDialog.view.tsx:37） |
| AC-IMG-033.5 | 集成 | 打开确认之后有任务开始用这一版 | 点 [删除镜像]，后端 409 | 弹层不关，就地换成被拦态（REQ-IMG-034） | 偏离：弹层留着，只弹失败轻提示（useImages.ts:618-622） |

### REQ-IMG-034 · 删除被拦：有任务在用就打开即说明，给 [改为禁用] {#REQ-IMG-034}

> 状态 `未实现` · 版本 MVP · 来源 P21-4 L133、L231、L250；Q-DS-17 A；DR-07、DR-19（sev3）、DR-39；matrix U-55、U-102；实现 image-application.service.ts:391-398，image-manifest.repository.impl.ts:181-196，useImages.ts:226-256、611-623 · 关联 DR-07 · DR-19 · 稿件 f-img-state-03

这一版被任务引用时**不能**删（删了会让任务指向一张不存在的镜像）。确认框一打开就**必须**是被拦态：拦截块「有 N 个任务在用这一版，删不了」+ 任务清单（名称 · 项目 · 状态）+ 一句「删掉会让它们指向一张不存在的镜像。改为禁用：新任务不能再选用它，这 N 个任务照常运行，之后随时能在卡片上点 [启用] 恢复。」+ [改为禁用]；[删除镜像] 禁用，旁边写原因「有任务在用这一版，只能改为禁用」；焦点在 [取消]。[改为禁用] = 关弹层 + 对这一版做 [禁用]（REQ-IMG-030）。计数只算**未销毁**的任务（已停止的算——[启动] 时还要用这一版）；只被已销毁任务用过的版本可以删。**不得**写「请先禁用后再删除」（引用约束与启用状态无关，禁用之后照样删不掉）。后端拒绝时的失败标题不带字符图标。

**改写了哪条旧文**：P21-4 L133、L231「该镜像被 N 个 Task 引用，请先禁用后再删除」→「改为禁用」；P21-4 L250「前端提前置灰并提示原因」→ 打开即拦（需后端预检 DR-07）；后端 409 原文「…禁用之后它不再出现在新任务的下拉里…」（image-application.service.ts:395-396）→「新任务不能再选用它」（同 REQ-IMG-030）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-IMG-034.1 | 集成 | ml-agent 这一版被 2 个任务用着（补 e2e 用例 · acme-web · 等待你输入；跑一遍示例测试 · 示例项目 · 已停止） | 点 [删除] | 打开即是被拦态（上文）；[删除镜像] 禁用并以 aria-describedby 指向原因；焦点在 [取消] | 未实现：现状打开的是普通确认，点了才 409 + 轻提示（useImages.ts:611-623）（稿件 f-img-state-03） |
| AC-IMG-034.2 | 集成 | 被拦态 | 点 [改为禁用] | 弹层关闭；这一版转「已禁用」（同 AC-IMG-030.1）；焦点回到这张卡的 [删除] | 未实现 |
| AC-IMG-034.3 | API | 一版只被已销毁的任务用过 | DELETE /api/images/:id | 删除成功 | 偏离：计数含已销毁的任务（image-manifest.repository.impl.ts:191-196；任务销毁后行仍保留，image_ref 外键 RESTRICT），用过一次就永远删不掉（DR-19） |
| AC-IMG-034.4 | API | 一版被 1 个已停止的任务用着 | DELETE /api/images/:id | 409；message「还有 1 个任务（含已停止）在用这个版本…请改为在这张镜像上点 [禁用]…」，不提「下拉」 | 部分实现：409 已实现，文案已不说「请先禁用后再删除」（image-application.service.ts:391-398）；没写「含已停止」，仍写「新任务的下拉」 |
| AC-IMG-034.5 | 组件 | 后端回 INVALID_STATE | 看失败轻提示 | 标题「这一步现在做不了」（不带「⚠️」）+ 后端原话 | 偏离：标题是「⚠️ 这一步现在做不了」（useImages.ts:226） |

## IMG · 预制镜像下载到本机（F-IMG-PRESET）

### REQ-IMG-040 · 入口：镜像管理预制镜像卡上的「下载到本机」块（暂行） {#REQ-IMG-040}

> 状态 `未实现` · 版本 v1.2 · 暂行（DR-36）· 来源 DR-36；P21-8 L27-46、L31、L37、L156-182、L241-245；P21-5 L148、L151-153、L161-165；spec/patterns.md:47（UX-DS-308）；matrix U-105；实现 PresetImageCheck.view.tsx:176-207，usePresetImageProvision.ts:47-67、131-139，preset-image.check.ts:289-308 · 关联 DR-36 · 稿件 f-img-preset-01（入口与进行中）

初始化完成之后，镜像管理页预制镜像卡是下载预制镜像的**唯一**入口（暂行，owner 可删；删掉时诊断第 ⑧ 项的下一步要同时改，REQ-IMG-043）。块放在预制镜像卡元信息之后、运行参数之前，只在「预制镜像就绪」那项检查（与诊断第 ⑧ 项同源）说「这台机器还没有它（没下载到本机，或下载源里没有）且平台自己搬得了」时出现；平台搬不了时不出块（那时诊断第 ⑧ 项按档指路）。块里按之前就把代价说清：一句为什么「预制镜像还没下载到本机：第一个任务会先下载它，要多等几分钟。现在就可以提前下，不必等到发起任务时。」+ [准备镜像]（卡内唯一实心按钮）+「<来源> → <去向> · 约 N MB」——体积来自后端的搬运计划，给不出就不写，**不得**写「0 MB」或照抄别处的数字。镜像页手动开始；初始化向导第 3 步在平台搬得了时自动开始（只开一次、失败不自动重开）；两处是同一个搬运，同一时刻只能有一次。本轮不提供 [取消]。

**改写了哪条旧文**：P21-8 L27-46 只把入口放在初始化向导，P21-5 L161-165 说诊断第 2、5 步「共用同一个准备动作」却没有常态入口 → 镜像页预制镜像卡补入口（DR-36）；P21-8 L31「[准备镜像 · 约 431MB · 从本机资产装载]」→ 体积来自后端计划（431MB 是另一个服务的资产，同文 L156-182 已订正）；P21-8 内部「按钮触发」（L31-32，L244-245 存档）与「自动开始」（L37、L241）两种写法 → 统一为「向导里自动、镜像页手动」；P21-8 L32「可取消」→ 本轮不提供（实现没有取消端点；前端的 abort 只用于连点时的重入保护，usePresetImageProvision.ts:70-74）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-IMG-040.1 | 集成 | 检查结论：没下载到本机、平台搬得了 | 打开镜像管理 | 预制镜像卡出现「下载到本机」块：一句为什么 + [准备镜像] +「ghcr.io/agent-infra/sandbox:latest → 本机镜像库 · 约 320 MB」（与向导第 3 步同一句：来源带 tag、去向「本机镜像库」；计划给不出体积时按 AC-IMG-040.3 只写前半句） | 未实现：镜像页没有这一块（只在向导第 3 步，PresetImageCheck.view.tsx:176-207；DR-36）（稿件 f-img-preset-01） |
| AC-IMG-040.2 | 集成 | 检查结论：已下载到本机，或平台搬不了 | 打开镜像管理 | 不出块 | 未实现 |
| AC-IMG-040.3 | 组件 | 搬运计划给不出体积（sizeBytes 为 null） | 渲染块 | 只写「<来源> → <去向>」，不写体积 | 已实现（向导）：PresetImageCheck.view.tsx:199-206 |
| AC-IMG-040.4 | 集成 | 向导第 3 步，平台搬得了 | 进入这一步 | 自动开始一次；失败后不自动重开；镜像页那一处不自动开始 | 部分实现：向导里已实现（usePresetImageProvision.ts:131-139）；镜像页未实现 |

### REQ-IMG-041 · 下载进度：阶段、百分比或进度未知、真实已用时 {#REQ-IMG-041}

> 状态 `部分实现` · 版本 v1.2 · 来源 P21-8 L39-41；P21-5 L151-152；UX-DS-308；Q-DS-21 A；W0 README §10（进度未知的画法）；实现 usePresetImageProvision.ts:13-23、69-110、112-129，PresetImageCheck.view.tsx:213-249，preset-image-provisioner.ts:250-337 · 关联 UX-DS-204 · 稿件 f-img-preset-01（37%）、f-img-preset-02（进度未知）

点 [准备镜像] 后按钮「准备中…」禁用（v2 带前缀转圈），块里出现进度：

- **阶段句**：五段——看这台机器够不够得着镜像 / 下载 / 校验完整性 / 装载镜像 / 放到位——后面跟后端那一帧的说明；没发生的阶段写「（跳过）」，**不得**画成瞬间完成；用词按定稿写「下载到本机」，不写「铺开 / 铺进 / staged」。
- **有分母**：进度条 + 行尾百分比（只出现一次，阶段句里不再拼「· N%」）。
- **没分母**（这一帧后端给不出总量）：**不得**画百分比、**不得**当 0%；画进度未知（一段在轨道里来回滑动的条）+「进度未知（后端这一帧给不出分母）——期间数字没变不代表卡死，正在持续写入。」
- **已用时**：真实挂钟，每秒跳一次，搬运结束就停；它是「没卡死」的证据，与百分比互相独立。

**改写了哪条旧文**：P21-8 L39-41（`已下载 245 MB / 约 320 MB · 77%`，分母分子各自可缺、都不许编）沿用；P21-5 L151「本机是否已 staged（rootfs 铺好没有）」与后端阶段句「正在把 … 铺进…」「已铺进…」→「下载到本机」（Q-DS-21 A）；现状阶段句末尾拼「· N%」（usePresetImageProvision.ts:85-88）、向导里百分比另起一行 → 百分比只在条的行尾出现一次（稿件 f-img-preset-01）。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-IMG-041.1 | 组件 | 块已出现 | 点 [准备镜像] | 按钮「准备中…」禁用；出现阶段句与已用时 | 已实现（向导）：PresetImageCheck.view.tsx:190-198、232-239；镜像页未实现 |
| AC-IMG-041.2 | 组件 | 一帧 progress=0.37、stage=fetch | 渲染 | 进度条 37% + 行尾「37%」；阶段句「下载：…」不带「· 37%」 | 偏离：阶段句拼了「· 37%」（usePresetImageProvision.ts:85-88），向导里百分比单独一行（PresetImageCheck.view.tsx:222-230） |
| AC-IMG-041.3 | 组件 | 一帧 progress=null | 渲染 | 不出百分比、不出 0%；进度未知的滑动条 + 上文那句 | 部分实现：null 不当 0 已实现（usePresetImageProvision.test.tsx:73），那句话已实现（PresetImageCheck.view.tsx:215-220）；没有滑动条（稿件 f-img-preset-02） |
| AC-IMG-041.4 | 单元 | 搬运进行中 | 推进假时钟 | 已用时每秒递增；done 帧到达后停止、不再显示 | 已实现：usePresetImageProvision.ts:112-129，usePresetImageProvision.test.tsx:113 |
| AC-IMG-041.5 | 组件 | 后端报 fetch / verify / load 为 skipped（字节已在本机） | 渲染阶段句 | 写「下载（跳过）：…」，不画成完成 | 已实现：usePresetImageProvision.ts:86-88，preset-image-provisioner.ts:260-265、298-300 |
| AC-IMG-041.6 | 文档 | — | 检查搬运各阶段上屏的句子 | 不出现「铺开」「铺进」「staged」 | 偏离：preset-image-provisioner.ts:277、289（「正在把 … 铺进…」「已铺进…」） |

### REQ-IMG-042 · 失败与冲突：说清停在哪一步、给出路、不自动重试 {#REQ-IMG-042}

> 状态 `部分实现` · 版本 v1.2 · 来源 P21-8 L35-36、L260-261；P22 §1；plan.md「待核实」第 4 条（本片已查，见 notes/img-b.md）；Q-SYS-16；实现 usePresetImageProvision.ts:92-110，PresetImageCheck.view.tsx:250-276，system.controller.ts:245-275，preset-image-provisioner.ts:234-248，connectivity.probe.ts:170，oci-registry.client.ts:520 · 关联 Q-SYS-16 · 稿件 f-img-preset-03

搬运失败时：撤掉进度条，**保留最后一条阶段句**（它说的是停在哪一步）；下面一句失败（圆叉、role="alert"）写后端给的原因，再一句出路；按钮回到 [准备镜像] 可重试；**不得**自动重试（断的是网络，没有断点续传，重试只会让等待翻倍）。镜像页的出路句：「多半是网速：镜像下载源够得着、但拉得太慢，中途就断了。换个网络环境后再点 [准备镜像] 重试。」（Q-SYS-16 已拍板 A；「让下载也走代理」进 backlog，做了之后才改回「到「系统状态 → 出网代理」填一个代理，再点 [准备镜像] 重试。」）；向导里那句「回上一步「代理配置」填一个代理再试」同样以 Q-SYS-16 为准（现状对下载不起作用，归 DEP 一并改）。两种冲突分开说：平台搬不了（409 PRESET_IMAGE_NOT_PROVISIONABLE，开流之前就判）——块里写后端给的原因，[准备镜像] 置灰并写原因；已经在下载（409 PRESET_IMAGE_PROVISION_IN_FLIGHT，例如向导或另一个标签页先开始了）——不当失败，写「已经在下载了（之前发起的那一次还没结束），稍后回来看。」，**不得**把后端写给开发者的原文上屏。

**改写了哪条旧文**：P21-8 L35-36（失败说清在哪一步）、L260-261（不加自动重试）沿用；向导出路句（PresetImageCheck.view.tsx:271-273）→ 镜像页版（镜像页没有「上一步」）；新增两种 409 的说法。

**合并说明**：片段原文的出路句让用户去出网代理里填代理，前提是保存的代理对下载生效；实现里只有联网检查读它（REQ-SYS-060 核实）。合并时按实现与 sys 组的推荐统一为不承诺代理的写法，AC-IMG-042.4 改记「计划中」；2026-10-04 用户拍板 Q-SYS-16 → A，与此相同。稿件 f-img-preset-03 的出路句已跟着改（W2 跨组一致性，drafts/notes/consistency.md 改动 19）。（交叉引用：REQ-SYS-060、AC-SYS-060.9）

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-IMG-042.1 | 组件 | 校验阶段 sha256 对不上 | 收到 done{ok:false} | 条撤掉；保留「校验完整性：正在校验镜像包（约 320 MB）…」；失败句（role="alert"）「校验 sha256 对不上：已停在校验这一步，没有装载。」；出路句；[准备镜像] 可点 | 部分实现：向导里已实现（usePresetImageProvision.ts:98-101，PresetImageCheck.view.tsx:250-276）；镜像页未实现（稿件 f-img-preset-03） |
| AC-IMG-042.2 | 集成 | 失败之后 | 等待 | 不自动重开；点 [准备镜像] 才重来 | 已实现：usePresetImageProvision.ts:52-57、131-139 |
| AC-IMG-042.3 | API | 平台搬不了 | POST /api/system/preset-image/provision | 开流之前 409 PRESET_IMAGE_NOT_PROVISIONABLE（message 是原因，sideEffectFree）；界面写这句原因、[准备镜像] 置灰 | 部分实现：后端已实现（system.controller.ts:250-259）；前端当一般失败显示（usePresetImageProvision.ts:105-109） |
| AC-IMG-042.4 | 集成 | 在「系统状态 → 出网代理」保存了代理 | 点 [准备镜像] | 下载（registry 拷贝 / provider 拉取）走这组代理 | 计划中（Q-SYS-16 已拍板 A，选项 B「让下载也走代理」进 backlog，做了才成立；合并时由「未实现」改记）：保存的代理只被联网检查读取（connectivity.probe.ts:170），registry 客户端用全局 fetch、没有注入代理（oci-registry.client.ts:520） |
| AC-IMG-042.5 | 集成 | 向导里已经在搬 | 镜像页点 [准备镜像] | 409 PRESET_IMAGE_PROVISION_IN_FLIGHT → 块里写「已经在下载了（之前发起的那一次还没结束），稍后回来看。」，不显示失败 | 未实现：后端原文「已经有一次搬运在进行中。⚠️ 这一步不是幂等的：两条流同时往 registry 写同一个 tag 是竞态」会被当失败原样上屏（preset-image-provisioner.ts:235-238，usePresetImageProvision.ts:105-109） |

### REQ-IMG-043 · 完成：以检查结论为准；诊断第 ⑧ 项指到这里 {#REQ-IMG-043}

> 状态 `偏离` · 版本 v1.2 · 来源 P21-8 L273-276；DR-36；spec/patterns.md:47（UX-DS-308）；P21-5 L161-165；Q-DS-21 A；实现 usePresetImageProvision.ts:5-11、92-97，preset-image.check.ts:289-308、366-396、422-433，preset-image-provisioner.ts:335-337 · 关联 DR-36 · REQ-DIA-017 / REQ-DIA-018（sys 组）· 稿件 无（完成态是块收起；诊断句在 sys 组的诊断稿里，句子由本条定）

搬运成功（done ok）后，块里先说「已下载到本机，正在重新检测…」（role="status"），然后重跑「预制镜像就绪」那项检查；**结论只认这项检查**（与诊断第 ⑧ 项同源），搬运自己**不得**宣布就绪：检查转就绪 → 块收起，预制镜像卡回到常态（不弹轻提示）；检查仍不就绪 → 块留着，写检查给的那句。

诊断第 ⑧ 项（系统状态页、初始化向导）里凡是「平台自己搬得了」的下一步——第 2 步（下载源里没有）与第 5 步（没下载到本机）——**必须**指向这里：「去「镜像管理」，在预制镜像卡上点 [准备镜像]，平台自己把它下载到本机（<来源> → <去向> · 约 N MB）。」+ 文字链 [去镜像管理]；**不得**指向系统状态页上不存在的按钮。入口被删掉（DR-36 owner 可删）时，这两句同时改回不指向按钮的写法。

**改写了哪条旧文**：诊断第 ⑧ 项第 2 步的下一步「在初始化向导或系统状态页点 [准备镜像]…」（preset-image.check.ts:431）、第 5 步「现在就可以下：点 [准备镜像]…」（preset-image.check.ts:379-382，没说在哪）→ 指向镜像管理预制镜像卡（DR-36）；搬完那一句「已放到位，正在重新检测…」（usePresetImageProvision.ts:96）→「已下载到本机，正在重新检测…」（Q-DS-21 A）。

**合并说明**：SYS 域 REQ-DIA-018「第 2、5 步提供同一个准备动作」按本条落到镜像管理的预制镜像卡。（交叉引用：REQ-DIA-018）

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-IMG-043.1 | 集成 | 搬运 done{ok:true} | 渲染块 | 「已下载到本机，正在重新检测…」（role="status"）；重跑检查 | 部分实现：向导里是「已放到位，正在重新检测…」并重跑检查（usePresetImageProvision.ts:95-97）；镜像页未实现 |
| AC-IMG-043.2 | 集成 | 重新检测为就绪 | 渲染 | 块收起，预制镜像卡回到常态；不弹轻提示 | 未实现（镜像页） |
| AC-IMG-043.3 | 集成 | 重新检测仍不就绪 | 渲染 | 块留着，写检查给的那句；[准备镜像] 可点 | 未实现（镜像页） |
| AC-IMG-043.4 | API | 第 2 步或第 5 步、平台搬得了 | 跑一次诊断 | ⑧ 的下一步是「去「镜像管理」，在预制镜像卡上点 [准备镜像]…」 | 偏离：preset-image.check.ts:379-382、431（DR-36；UX-DS-308 登记的缺口） |
| AC-IMG-043.5 | API | 搬运（推送路径）完成 | 再跑一次诊断 | ⑧ 为「预制镜像就绪，可以立即发起任务」 | 已实现：推完就地再播种（preset-image-provisioner.ts:335-337，P21-8 L273-274） |

## IMG · 页面的加载与空（F-IMG-PAGE）

### REQ-IMG-050 · 首次加载：页头可用，列表位置是卡片骨架 {#REQ-IMG-050}

> 状态 `部分实现` · 版本 MVP · 来源 P21-4 L91（加载中 → 骨架屏）；UX-DS-304 / T-7（骨架高度接近真实）；矩阵 U-75；实现 ImagesContainer.tsx:45-94，ImageCard.view.tsx:50-64，useImages.ts:894 · 关联 F-WB-SHELL（直开 `#images` 先出本页骨架，见 WB.md）· 稿件 f-img-page-02

列表第一次回来之前：页头（标题、[注册新镜像]）与工具行（搜索、状态过滤）照常可用；列表位置放两张卡片骨架，按真实镜像卡的几何排（卡头两行与右侧徽标位 → 结论 → 三行键值 → 运行参数块 → 动作行），高度接近真实卡，数据回来时列表不跳；骨架对读屏隐藏，列表 aria-busy，并播一句「正在读取镜像…」。加载期**不得**出现任何空态句（加载中不是「没有镜像」）。

**改写了哪条旧文**：P21-4 L91「加载中 → 骨架屏」维持，补骨架的几何要求与读屏一句。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-IMG-050.1 | 组件 | 镜像列表请求未返回 | 渲染 | 页头与工具行可点；两张骨架；不出现「还没有注册任何镜像」与「没有符合当前搜索/过滤条件的镜像。」 | 已实现：ImagesContainer.tsx:47-94 |
| AC-IMG-050.2 | 组件 | 同上 | 量骨架高度，再让数据回来 | 骨架与真实卡片高度相近，第一张卡的顶边位置不变 | 部分实现：现状骨架四条，约 150 高，真实卡约 340（ImageCard.view.tsx:50-64）（稿件 f-img-page-02） |
| AC-IMG-050.3 | 组件 | 同上 | 用读屏 | 列表 aria-busy=true，播「正在读取镜像…」；骨架 aria-hidden | 部分实现：骨架 aria-hidden 已实现；没有 aria-busy 与那句话 |

### REQ-IMG-051 · 一张镜像都没有：空态，与「过滤后为空」分开 {#REQ-IMG-051}

> 状态 `偏离` · 版本 MVP · 来源 P21-4 L20、L91、L273-287、L510；P22 L155；矩阵 U-106；Q-LCH-03 B（用户拍板 2026-10-04：新建任务有了「镜像」一栏，说明句改指向它）；实现 ImagesContainer.tsx:96-133，useImages.ts:146-148、896，image-seeder.ts:64、81-110，image-application.service.ts:532-557，preset-image.check.ts:200-213 · 关联 Q-IMG-51 · 稿件 f-img-page-01

平台开机时自动登记自带的预制镜像（ImageSeeder，10 秒预算，失败不阻断启动），所以正常部署里镜像页至少有一张；「一张都没有」只在开机播种失败时出现。列表回来且库里 0 行时：虚线框空态——标题「还没有注册任何镜像」、说明「注册之后，它会出现在这个列表里；新建任务时，可以在「镜像」一栏选它。」（REQ-LCH-004）、来源约束一句、[注册新镜像]（打开 REQ-IMG-001 的弹层）与 [查看镜像要求]（REQ-IMG-007）。有镜像、但搜索或状态过滤后为空是另一句话：「没有符合当前搜索/过滤条件的镜像。」，不给 CTA。

已知问题，待裁（Q-IMG-51，不回复时按上面这段现状）：这个空态出现时，平台一定会拒绝注册（`INVALID_STATE`「平台自己的预制镜像还没准备好…」，[验证] 就会被拒，REQ-IMG-008），主动作把人引向一条必然失败的路。说明句的去处随 2026-10-04 拍板的 Q-LCH-03 B 有了（新建任务的「镜像」一栏，REQ-LCH-004）；「发起任务向导」「镜像下拉」是旧称，不再上屏。

**改写了哪条旧文**：P21-4 L20「❌ 没有种子数据……全新部署在有人注册第一张镜像之前，连不带 image 的建 Task 都会被门口拒」→ 开机自动播种（同文 L510 已订正，image-seeder.ts），空态只在播种失败时出现；P22 L155「镜像页空态 CTA」维持；实现的说明句「它会出现在发起任务向导的镜像下拉里」→「注册之后，它会出现在这个列表里；新建任务时，可以在「镜像」一栏选它。」（Q-LCH-03 B，用户拍板 2026-10-04；与稿件 f-img-page-01 同句）。

**合并说明**：空态说明句原写「注册一张之后，它会出现在发起任务向导的镜像下拉里。」，当时新建任务弹层没有镜像选择，合并时一度按「不得承诺镜像下拉」去掉这半句。2026-10-04 用户拍板 Q-LCH-03 → B（原话「补全 10 条按推荐」）后新建任务有了「镜像」一栏，片段正文已改为指向它（「注册之后，它会出现在这个列表里；新建任务时，可以在「镜像」一栏选它。」，REQ-LCH-004，与稿件 f-img-page-01 同句），「发起任务向导」「镜像下拉」是旧称，AC-IMG-051.1 记偏离；空态的主动作与说法仍随 Q-IMG-51。（交叉引用：REQ-LCH-004、REQ-IMG-030）

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-IMG-051.1 | 组件 | 列表返回 0 行 | 渲染 | 虚线框空态：标题、说明「注册之后，它会出现在这个列表里；新建任务时，可以在「镜像」一栏选它。」、来源约束、两个按钮；[注册新镜像] 打开注册弹层，[查看镜像要求] 打开侧弹层 | 偏离：结构与按钮已实现；说明句写「注册一张之后，它会出现在发起任务向导的镜像下拉里。」——旧称（ImagesContainer.tsx:96-127）（稿件 f-img-page-01） |
| AC-IMG-051.2 | 组件 | 列表 3 行，状态过滤「无效」、搜索「web」 | 渲染 | 只一句「没有符合当前搜索/过滤条件的镜像。」，不出现空态与 CTA | 已实现：ImagesContainer.tsx:129-133 |
| AC-IMG-051.3 | 集成 | 开机播种失败（离线），库里 0 行 | 打开镜像页 → [注册新镜像] → 填地址 → [验证] | 平台以 `INVALID_STATE` 拒，说清是部署问题（呈现按 REQ-IMG-008）；系统状态页诊断第 ⑧ 项给出「重启平台让它重新装一次」 | 已实现（拒绝与诊断：image-application.service.ts:532-557，preset-image.check.ts:200-213）；弹层里的呈现见 AC-IMG-008.3（偏离） |

### REQ-IMG-052 · 列表读不到：如实说、能重试，不冒充「没有镜像」 {#REQ-IMG-052}

> 状态 `偏离` · 版本 MVP · 来源 UX-DS-305（读取失败原位 role=alert，不得显示成空）；同类写法 f-crd-page-02（凭证页读取失败条）；实现 useImages.ts:60-66、894-896，ImagesContainer.tsx:89-133，app/providers.tsx:37（查询默认重试 2 次）· 稿件 f-img-page-03（W4 补稿）

镜像列表读取失败（重试用完）时，列表位置**必须**放一条读取失败提示（role=alert）+ [重试]，说清是「读不到」而不是「没有」；页头与工具行照常；**不得**显示「还没有注册任何镜像」，也不给 [注册新镜像] 这类 CTA。

**改写了哪条旧文**：旧文没写读取失败（P21-4 L91 只有加载中与空），本片补。

| AC | 层级 | Given | When | Then | 现状 |
|---|---|---|---|---|---|
| AC-IMG-052.1 | 集成 | `GET /api/images` 连续失败 3 次 | 打开镜像页 | 骨架之后出现读取失败提示 + [重试]；没有空态 | 偏离：失败后「库里 0 行」判定成立（`noImagesAtAll = !isPending && 0 行`，useImages.ts:894-896），显示「还没有注册任何镜像」与 [注册新镜像]（ImagesContainer.tsx:96-127） |
| AC-IMG-052.2 | 集成 | 读取失败提示在 | 点 [重试]，这次成功 | 回到正常列表 | 未实现 |

---

## 附录 A · 改写对照（逐条，来自各片段）

### 改写对照（旧文 → 本片）（img-a）

| 旧文 | 位置 | 改写为 | 依据 |
|---|---|---|---|
| P21-4 L3「前端 ⏳ 进行中（页面尚不存在）」、§0 L19「页面仍不存在」；P21 L13「…路由尚不存在」 | REQ-IMG-001 | 页面已落地（`/settings/images` + `ImagesContainer`） | 实现 app/settings/images/page.tsx；P20 L347 |
| 原P21-4第0节 L20「❌ 没有种子数据……」 | REQ-IMG-051 | 开机自动播种，空态只在播种失败时出现 | P21-4 L510、image-seeder.ts:64、81-110 |
| P21-4 L105、L224；F21-4 L198、L228、L581、L686「60s 超时，按 TIMEOUT 处理」 | REQ-IMG-002、008 | 每个请求 15 秒（`IMAGE_REGISTRY_TIMEOUT_MS`），超时归 `REGISTRY_UNREACHABLE`，原位提示 + [重试] | oci-registry.client.ts:32、513-534；oci-image-spec.provider.ts:203-206 |
| P21-4 L224「并回显本次解析出的 digest」 | REQ-IMG-006 | 待 DR-11；契约补字段之前不显示「钉定」行 | DR-11（不回复默认） |
| P21-4 L226「toast『已注册并钉定 sha256:…』」 | REQ-IMG-006 | 「已注册，锁定在 <短版本号>」 | useImages.ts:474 |
| P21-4 L66、L93、L252；P21 L102「实测约 12.5 分钟」 | REQ-IMG-003 | 不写耗时：「启动会明显变慢」 | Q-DS-21 A；镜像要求第④条 |
| P21-4 L67、L93；P21 L102；P22 L12「缺少 tmux 属于无效」 | REQ-IMG-003、007 | 注册期不判 tmux（自定义镜像），任务启动时实测 | oci-image-spec.provider.ts:143-158；image-application.service.ts:431-447 |
| P21-4 L124「保存禁用」 | REQ-IMG-003 | 无效时 [保存] 不渲染 | RegisterImageModal.view.tsx:184-189 |
| P21-4 L227「就地对比 + [更新到新版本] 仍是前端待做」 | REQ-IMG-005 | 已实现：同 tag 新版本转对比弹层 | useImages.ts:454-471 |
| P21-4 L291「命中已存在的 `(image_id, version)`」 | REQ-IMG-005 | 按 `(image_id, digest)` 幂等 | image-application.service.ts:142-180；27 §6 |
| P21-4 L227「关闭弹窗并高亮那张卡」 | REQ-IMG-005 | + 先清过滤、滚到可见、焦点落卡 | plan F-IMG-REGISTER；foundation `.card.is-current` |
| P21 L96、P21-4 L94（只有 [查看镜像要求] 按钮） | REQ-IMG-007 | 常驻侧弹层 + 四条清单 | ImageRequirementsPanel.view.tsx |
| P21-4 L350「[编辑环境变量] 弹层」；L346「[编辑]」 | REQ-IMG-010 | 卡内行内编辑器；按钮名「编辑环境变量」 | 实现；v1 g5-08 |
| P21-4 L371-373「拒绝：『变量名不合法』」「拒绝并提示上限」 | REQ-IMG-012 | 按码、按位置分句 | EnvVarEditor.view.tsx:33-47 |
| P21-4 L386（只写上限） | REQ-IMG-013 | 到顶时按钮旁写原因 | DR-39 |
| P21-4 §10（没写保存后的反馈） | REQ-IMG-014 | 成功一句「运行参数已保存。」；拒绝映回具体行；其它失败原位 | useImages.ts:863（实现先行） |
| P21-4 L91「加载中 → 骨架屏」 | REQ-IMG-050 | 补骨架几何与读屏一句 | UX-DS-304；T-7 |
| （旧文没有） | REQ-IMG-008、052 | 请求失败与读取失败的去处 | UX-DS-305、UX-DS-508 |

### 改写对照（旧文 → 本片）（img-b）

| 旧文 | 位置 | 改写为 | 依据 |
|---|---|---|---|
| P21-4 L44、L51「钉定 digest: sha256:9f2a…c31」；F21-4 L294「点击展开全串 + 一键复制」 | REQ-IMG-020 | 「运行的版本」短串 + 原位展开 / 收起 + 复制完整版本号（两句反馈） | matrix U-49、U-50；实现 ImageCard.view.tsx:155-198 |
| P21-4 L99「以 digest 注册（无 tag）」+ tooltip「…不存在上游漂移」 | REQ-IMG-021 | 「按版本直接注册（没有 tag）」+ 原因「…所以不会有新版本」 | Q-DS-21 A；实现 imageCardModel.ts:30-34 |
| P21-4 L126、L228 检查更新只有「未变 / 已变」 | REQ-IMG-021 | 补「tag 已不在」「失败」 | 实现 useImages.ts:517-526 |
| P21-4 L97「上游该 tag 已指向新镜像 [查看变更]」 | REQ-IMG-022 | 「下载源上这个 tag 已经指向另一版（sha256:…）[查看变更]」 | Q-DS-21 A；实现 ImageCard.view.tsx:246 |
| P21-4 L228 对比弹层 | REQ-IMG-022、025 | 加作用范围一句 | U-104；稿件 f-img-version-01 |
| P21-4 L229、L268-271 重新验证 | REQ-IMG-023 | 沿用；补三档结论的轻提示与色调；「展开卡片看后果说明」→「后果说明在卡上」 | UX-DS-508；P7 卡片不折叠 |
| P21-4（无）「切换到此版本」 | REQ-IMG-024 | 不确认、进行中、换位、无效版本不能切 | U-56、U-104；plan 默认；DR-39 |
| P21-4 L267「历史 Task 的镜像溯源不变」 | REQ-IMG-025 | 上屏一句「只影响之后新建的任务…」 | U-104 |
| P21-4 L332「每个镜像可全局配置运行参数」 | REQ-IMG-026 | 参数挂在版本行上，更新时带过去 | Q-IMG-03 C（用户拍板 2026-10-04） |
| P21-4 L96「卡片置灰，创建向导不出现」 | REQ-IMG-030 | 停用色调、不转圈、不降透明 | Q-DS-15 ②A、T-15、UX-DS-138、Q-DS-18 A |
| P21-4 L30、L130、L244、L252；实现轻提示「向导下拉里不再出现」 | REQ-IMG-030、034 | 「新任务不能再选用这张镜像」；新建任务的「镜像」一栏里它置灰写原因 | Q-LCH-03 B（用户拍板 2026-10-04，REQ-LCH-004） |
| P21-4 L230「启用 / 禁用都用 PATCH {is_active}」 | REQ-IMG-031 | 禁用 PATCH 乐观；启用 activate 不乐观；成功说「已启用」 | F21-4 L446、L551；image-application.service.ts:299 |
| P21-4 L136、L249「预置镜像仅可禁用」 | REQ-IMG-032 | 沿用；禁用前先出非破坏性确认、说清后果；徽标写「预制」 | Q-IMG-04 A、Q-IMG-06 A（用户拍板 2026-10-04）；image-facade.adapter.ts:44-47、77-85 |
| P21-4 L231「二次确认"不可逆"」；现状「删除镜像版本」一段话 | REQ-IMG-033 | 统一破坏性确认四段 + 清单来源 | Q-DS-17 A；DR-07 |
| P21-4 L133、L231「请先禁用后再删除」；L250「前端提前置灰」 | REQ-IMG-034 | 打开即拦 + [改为禁用]；计数只算未销毁的任务 | Q-DS-17 A；DR-07；DR-19 |
| P21-8 L27-46 入口只在向导；P21-5 L161-165 | REQ-IMG-040 | 镜像页预制镜像卡补入口（暂行） | DR-36 |
| P21-8 L31「约 431MB」 | REQ-IMG-040 | 体积来自后端计划，给不出不写 | P21-8 L156-182（同文订正） |
| P21-8 L31-32「按钮触发」与 L37、L241「自动开始」 | REQ-IMG-040 | 向导里自动、镜像页手动 | DR-36；P21-8 L241 |
| P21-8 L32「可取消」 | REQ-IMG-040 | 本轮不提供 | 实现没有取消端点 |
| P21-5 L151「staged（rootfs 铺好没有）」；后端「铺进」 | REQ-IMG-041 | 「下载到本机」 | Q-DS-21 A |
| 向导出路句「回上一步「代理配置」…」 | REQ-IMG-042 | 镜像页版「换个网络环境后再点 [准备镜像] 重试。」（不承诺代理） | v1 g5-13c；Q-SYS-16 A（用户拍板 2026-10-04） |
| 诊断 ⑧ 下一步「在初始化向导或系统状态页点 [准备镜像]」 | REQ-IMG-043 | 「去「镜像管理」，在预制镜像卡上点 [准备镜像]…」+ [去镜像管理] | DR-36；UX-DS-308 |

## 附录 B · 片段里的默认决定与待确认（原文）

> 下面是各片段的原文，编号仍是片段里的本地编号；统一编号与完整的选项、推荐、默认在 [open-questions.md](./open-questions.md)，对照见其 §7。

### 本片的默认决定与待确认（img-a）

1. **Q-IMG-01 · 镜像要求第②条的「工作目录」**（REQ-IMG-003、007）：面板写「并且要有 WorkingDir」，平台实际不拦——缺省的 WorkingDir 按「/」处理，工作目录那条错误走不到（oci-image-spec.provider.ts:99、173-179）。A：改面板第②条为「要有启动命令（Entrypoint 或 Cmd）；没写工作目录时平台按根目录 / 处理」，并把稿件 f-img-register-02 的第二条示例错误换成平台真会报的「镜像既没有 Entrypoint 也没有 Cmd」；B：平台补拦缺 WorkingDir 的镜像。**推荐 A**（零后端，说真话）。**不回复时**：稿件与面板文字暂不动（换皮不改字，T-21），REQ-IMG-007 记「偏离」。
2. **Q-IMG-02 · 注册弹层与侧弹层同时开着时，键盘到不了侧弹层的 [关闭]**（REQ-IMG-007）：A 维持现状（先 Esc 关弹层）；B 侧弹层的 [关闭] 进入弹层的 Tab 循环。**推荐 B**（a11y）；**不回复时 A**（W0 README §10 已登记为现状行为）。
3. **Q-IMG-11 · 运行参数摘要条目很多时截不截**（REQ-IMG-010）：A 现状，全部列出、整段折行（50 条时约 9 行）；B 只列前 3 条 +「…共 N 条」，全量在编辑器里看。**推荐 B**；**不回复时 A**（稿件 f-img-env-03 按 A 画）。
4. **Q-IMG-51 · 「一张镜像都没有」的说法与主动作**（REQ-IMG-051）：A 现状——引导去注册（必然被拒），说明句承诺一个还不存在的「镜像下拉」；B 改说「平台自带的预制镜像没准备好（开机时没装上），现在注册不了自定义镜像」，主动作改 [查看系统状态]（进系统状态页并自动跑一轮诊断，第 ⑧ 项会给出「重启平台让它重新装一次」），[注册新镜像] 降为次要；说明句去掉「镜像下拉」的承诺。**推荐 B**（只改前端文案与按钮）；**不回复时 A**（稿件 f-img-page-01 按 A 画，标「待裁 · Q-IMG-51」）。（2026-10-04：Q-LCH-03 拍板 B 后新建任务有了「镜像」一栏，说明句改指向它，见 REQ-IMG-051；Q-IMG-51 本身仍按默认 A。）
5. **[定位到该镜像]**（REQ-IMG-005）：高亮保留到下一次定位或离开本页（按实现，不做「闪一下就消失」——plan 里原型写的「高亮 1.5 秒」按此改）；「先清过滤、滚到可见、焦点落卡」是本片新增的建议（实现没做），不回复时按本片写。
6. **两处没有稿的需求**：REQ-IMG-008（预检 / 保存失败的原位提示）与 REQ-IMG-052（列表读取失败）。建议补 2 张稿：f-img-register-06（失败提示放页脚上方，`.note--fail` + [重试] / [查看系统状态]）、f-img-page-03（照 f-crd-page-02 的读取失败条）。补稿之前原型不模拟这两条失败路径。**W4 已补**：f-img-register-06（REGISTRY_UNREACHABLE + [重试]）、f-img-page-03（读取失败条），原型按稿接上（场景「下一次注册 [验证]」与 img-load:fail）。
7. **DR-33 / DR-11 按 BACKLOG 的不回复默认**：DR-33 新建镜像文案表（稿件已按查表句画）；DR-11 不显示「钉定」行（稿件标「待契约」，原型不渲染这一行）。

### 本片的默认决定与待确认（img-b）

1. **IMG-B-Q1 · 运行参数要不要跨版本**（REQ-IMG-026）：A 运行参数属于镜像、跨版本共用（P21-4 L332 原意；f-img-version-04 要改 1 张）· B 按现状跟着版本行，更新后新版本没有运行参数，对比弹层写明 · **C（默认）** 跟着版本行，但 [更新到新版本] 时新版本继承当前版本的运行参数（含 Secret，服务端复制密文），[切换到此版本] 用那一版自己的。C 需要后端：登记新版本时可指定「从哪一行复制运行参数」。**已拍板（2026-10-04，用户原话「补全 10 条按推荐」）：选 C**（Q-IMG-03）。
2. **IMG-B-Q2 · 禁用预置镜像要不要先确认**（REQ-IMG-032）：**A（推荐）** 预置镜像的 [禁用] 先出非破坏性确认（标题「禁用预置镜像「ghcr.io/agent-infra/sandbox:latest」？」+「在重新启用之前，新任务都发不出去：新建任务默认用这张镜像。已经在跑的任务不受影响。」+ [取消]（焦点）/ [禁用]，不用危险色——可逆），要补 1 张稿 · **B（不回复时默认）** 不确认，只把轻提示改成说后果 · C 预置镜像不给 [禁用]（改写 P21-4 L136、L249）。**已拍板（2026-10-04）：选 A**（Q-IMG-04）——确认句按 Q-LCH-03 B 之后的事实改写（新任务可以改选别的镜像，见 REQ-IMG-032）。
3. **IMG-B-Q3 · 出网代理对预置镜像下载生效**（REQ-IMG-042）：**A（默认）** 后端让下载走保存的出网代理，出路句不变 · B 后端暂不改，出路句改成不承诺代理：「多半是网速：镜像下载源够得着、但拉得太慢，中途就断了。换个网络环境后再点 [准备镜像] 重试。」（稿件 f-img-preset-03 改一句）。**已拍板（2026-10-04）**：本条并入 Q-SYS-16，选 A「只承诺联网检查」= 本条的 B（出路句不承诺代理）；让下载也走代理进 backlog。
4. **切换到此版本不确认**（REQ-IMG-024）：plan 默认，按实现；后果靠 REQ-IMG-025 的一句说清。若改成要确认，用 Q-DS-17 的结构但不用危险色。
5. **按钮名用 [准备镜像]**（REQ-IMG-040、043）：DR-36 推荐句里写的是「在预置镜像卡上点 [下载到本机]」，而稿件、向导与实现的按钮都叫 [准备镜像]、「下载到本机」是块的说法；本片按稿件写 [准备镜像]，诊断句同步。
6. **进度未知画滑动条**（REQ-IMG-041）：W0 README §10 登记的「需看稿」；v1 g5-13b 只写一句不画条，两种都合规。
7. **重新验证三档轻提示的色调**（REQ-IMG-023）：有效成功、有警告中性、无效失败色；现状三档都是成功色。结论本身已在卡上原位播报（UX-DS-508），轻提示只是补充。
8. **跨组**：新建任务弹层没有镜像选择，自定义镜像在界面上用不上（只有 API / MCP 能指定）——是否在新建任务里加镜像选择归 F-LCH-FORM（Q-DS-29 只问了项目下拉）；「预置 / 预制」两种写法在 P7 与产品文档里混用，交 W2 统一（本片沿用 P7：徽标「预置」、正文「预制镜像」）。**已拍板（2026-10-04）**：新建任务加「镜像」字段（Q-LCH-03 B，REQ-LCH-004）；统一写「预制镜像」、徽标也写「预制」（Q-IMG-06 A，本片正文已改；引用旧文的原话不改）。

## 附录 E · 合并时改动的地方

合并只做了下面这些改动；其余文字都是片段原文（本地待定编号已换成统一编号）。

| 需求 | 改动 | 为什么 |
|---|---|---|
| [REQ-IMG-005](#REQ-IMG-005) | 改写一句 | 占位编号 REQ-IMG-02x 补成 img-b 的实际编号 |
| [REQ-IMG-051](#REQ-IMG-051) | 加合并说明 | 与 REQ-LCH-004、REQ-IMG-030 统一（Q-LCH-03 已拍板 B） |
| [REQ-IMG-042](#REQ-IMG-042) | 改写一句 | 出路句不再承诺代理（保存的代理今天只被联网检查读取） |
| [REQ-IMG-042](#REQ-IMG-042) | 改写一句 | 向导里的出路句同样不成立，交 DEP 一并改 |
| [REQ-IMG-042](#REQ-IMG-042) | 改写一句 | AC-IMG-042.4 改记「计划中」，随 Q-SYS-16 |
| [REQ-IMG-042](#REQ-IMG-042) | 加合并说明 | 与 REQ-SYS-060 统一 |
| [REQ-IMG-043](#REQ-IMG-043) | 加合并说明 | 与 REQ-DIA-018 互相引用 |
