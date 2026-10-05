# 设计迁移最终证据

当前完成情况以 [IMPLEMENTATION-STATUS](../../IMPLEMENTATION-STATUS.md) 和 [current-summary.json](current-summary.json) 为准。代码核对、指定层级测试与生产构建浏览器状态检查分别记录，不将 1016 条核对结果称为 1016 场端到端测试。

- [current-ac-ledger.json](current-ac-ledger.json)：1016 条 AC 的最终合并台账，保留源 Given/When/Then、要求层级、证据与负责台账。
- [current-requirement-ledger.json](current-requirement-ledger.json)：247 条需求；其中 4 条无独立 AC 的额外核对见 [requirements-without-ac.json](requirements-without-ac.json)。
- 四份最终负责台账：[工作台/项目](shell-project-current.json)、[初始化](deployment-current.json)、[凭证/访问](credential-access-current.json)、[镜像/系统/自动化](image-system-current.json)。
- 三份最终稿件清单：[91 稿](shell-project-design-manifest.json)、[26 稿](credential-access-design-manifest.json)、[55 稿](image-system-design-manifest.json)。170 张 UI 稿各有 6 组实际通过截图，另有 1 张 CLI 验证与 1 张当前不适用的历史审计状态稿。
- [migration-decisions.md](migration-decisions.md)：3 条被选定分支替代及 2 条源规格当前版本延期的原因。
- 实际执行：[API 166 场（本轮复验）](../../api/acceptance/execution-report.json)、[Web 78 场](web-acceptance-execution.json)、[Storybook 540 场](web-storybook-execution.json)、[最终变更 Storybook 11 场](web-final-changed-story-execution.json)、[真实跨仓 1 场](cross-execution-report.json)。
- [Web 执行汇总](web-execution-report.json)：实际测试、生产构建、静态门禁、稿件证据和源文件 SHA；[最终一致性复核](final-verification.json) 记录主仓完成门禁与选定截图的人工可视复核。
- 新测试重建与旧测试退休：[API 映射](../../api/acceptance/legacy-retirement-plan.json)、[Web 映射](web-test-retirement.json)、[Storybook 重建说明](web-story-rebuild.json)、[跨仓说明](../../e2e-contract/README.md)。
- [baseline.json](baseline.json) 与 [设计导入清单](../../docs/design-v2/source-manifest.json)：源需求、AC 与导入文件来源；原 provider 会话和原稿历史来源只读。

`summary.json`、`shell-audit.json`、`project-access-*-audit.json`、`image-system-audit.json`、`*-summary.json` 为历史审计；`sandbox-current.json`、`credential-git-current.json`、`project-automation-current.json` 为分批核对阶段记录。它们不参与最终完成比例。浏览器初轮失败报告保留；最终 manifest 按每张稿、主题、宽度引用最后实际通过的证据，没有改写初轮结果。

复跑主仓 `pnpm migration:report` 更新汇总；`pnpm migration:check:complete` 检查全量 AC、需求补充、稿件归属、六组截图、证据路径及导入 SHA。运行 `pnpm docs:check` 检查文档与当前跨仓契约。各测试运行方式见 API/Web/跨仓 README。

提交前的格式统一与复验另记在 `publication-verification.json`；原浏览器证据保留实跑时的源码及报告，不把仅格式变化写成重新执行1020组。

## 本次 UI 细节修复（2026-10-05）

本轮独立记录在 [ui-detail-refinement.json](ui-detail-refinement.json)。前次全量完成记录表示迁移覆盖与当时已执行的行为、浏览器状态验收，不能据此推断每个组件都已经在相同示例数据与交互状态下逐项对齐视觉细节。本次用户检查与补充场景实际暴露了新建项目布局和结果视图、项目 POST/WS 时序及凭证回程、终端栏组合、阴影样式和 Storybook Portal 主题的缺口；相应修复和新证据另行记录，原迁移报告与截图保留。

项目创建按 [PRJ001–006](../../docs/design-v2/gap/product/PRJ.md#REQ-PRJ-001) 与原稿 [01](../../docs/design-v2/gap/drafts/f-prj-create-01.html) / [02](../../docs/design-v2/gap/drafts/f-prj-create-02.html) / [03](../../docs/design-v2/gap/drafts/f-prj-create-03.html) / [04](../../docs/design-v2/gap/drafts/f-prj-create-04.html) / [05](../../docs/design-v2/gap/drafts/f-prj-create-05.html) / [06](../../docs/design-v2/gap/drafts/f-prj-create-06.html) / [07](../../docs/design-v2/gap/drafts/f-prj-create-07.html) / [08](../../docs/design-v2/gap/drafts/f-prj-create-08.html)，和 [最终截图画廊](../storybook-project-detail-review/index.html)、[final-comparison.json](../storybook-project-detail-review/final-comparison.json) 对照：01–08 × 亮色/暗色 × 1440/390，共 32 组同状态比较；32 组弹窗宽高全部匹配、无溢出，原稿/Storybook/并排截图共 96 张。[原始像素诊断](../storybook-project-detail-review/pixel-comparison.json)另记32组RGB最大通道差大于12/255的像素占比，范围0.05385%–4.12123%，并提供32张50% alpha叠加图；这不是像素等价判定。01–03部分组合的PNG截取比DOM高1px，两侧一致，分别按DOM和PNG口径记录。没有将这四组主题/宽度称为前次六组合浏览器的全量重跑。

[初轮 28 组](../storybook-project-detail-review/initial-comparison.json) 仅作为调试数据：缺少 07；01 存在截图时 Storybook play 尚未结束的竞态；05 示例数据与原稿未对齐。它们不能作为同状态验收，也不能仅凭其几何差值归因视觉实现。最终 32 组替代其验收用途，初轮文件保留。

本轮执行另见 [Web 新验收](web-acceptance-execution-ui-refinement.json)、[Storybook 新验收](web-storybook-execution-ui-refinement.json)、[终端同尺寸对照](../terminal-chrome-review/comparison-manifest.json) 和 [终端栏并排截图](../terminal-chrome-review/terminal-termbar-draft-vs-storybook.png)。终端原稿/Storybook的1440px暗色同宽组合有48项指标全部匹配；原稿的重连条和示例ANSI输出不在本组件Story中，不声称整页像素等价；早期before截图尚未正确应用整页暗色，仅保留为调试对照。本轮全套 Web 20 文件 / 97 测试、Storybook 97 文件 / 542 测试均无失败或跳过，格式/lint/类型检查通过，[最终生产构建日志](web-build-ui-refinement.log)实跑退出 0；Vitest 的 Web `numTotalTestSuites=42` 是 describe 套件数，不是 42 个文件。[目标生产浏览器](../design-ui-detail-refinement/review.json)18稿×6组实际108次全部通过，包含120张状态截图，0意外请求、0错误；[最终真实跨仓](cross-execution-report.json)1/1通过，31个公开expect步骤，0失败/跳过。用户现有API进程和运行任务保留；[实际生产终端截图](../terminal-chrome-review/production-final-live-termbar.png)与[指标](../terminal-chrome-review/production-final-live-metrics.json)确认40px栏、28px工具、栏底145px与画布顶部145px相接、无横向溢出。完整API42文件/166测试通过；根代理的迁移汇总、完整迁移检查与13项文档门禁均退出0。本轮报告仅对本轮实际变更代码记录最终SHA，执行边界和未验证的外部能力单列。前次跨仓报告另存 [before-ui-refinement](cross-execution-report-before-ui-refinement.json)。

本轮后续契约检查发现项目名称Unicode refine运行校验正确、MCP `tools/list`的`maxLength=40`声明丢失。已通过公开`serverMutator/setRequestHandler`窄适配补回同源上限，新增真实MCP发现、40/41 emoji调用及SQLite无副作用回归通过；[API最终复验](../../api/acceptance/execution-report.json)为42文件/166测试，0失败/跳过。最终跨仓场景是在声明适配前的`c4ac0ef`运行校验版本执行，最后的声明适配由新MCP协议场景另验；保持此前已通过的Web和截图证据，未将它们写成适配后的重复执行。
