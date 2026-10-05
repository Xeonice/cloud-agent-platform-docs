# 设计迁移最终证据

当前完成情况以 [IMPLEMENTATION-STATUS](../../IMPLEMENTATION-STATUS.md) 和 [current-summary.json](current-summary.json) 为准。代码核对、指定层级测试与生产构建浏览器状态检查分别记录，不将 1016 条核对结果称为 1016 场端到端测试。

- [current-ac-ledger.json](current-ac-ledger.json)：1016 条 AC 的最终合并台账，保留源 Given/When/Then、要求层级、证据与负责台账。
- [current-requirement-ledger.json](current-requirement-ledger.json)：247 条需求；其中 4 条无独立 AC 的额外核对见 [requirements-without-ac.json](requirements-without-ac.json)。
- 四份最终负责台账：[工作台/项目](shell-project-current.json)、[初始化](deployment-current.json)、[凭证/访问](credential-access-current.json)、[镜像/系统/自动化](image-system-current.json)。
- 三份最终稿件清单：[91 稿](shell-project-design-manifest.json)、[26 稿](credential-access-design-manifest.json)、[55 稿](image-system-design-manifest.json)。170 张 UI 稿各有 6 组实际通过截图，另有 1 张 CLI 验证与 1 张当前不适用的历史审计状态稿。
- [migration-decisions.md](migration-decisions.md)：3 条被选定分支替代及 2 条源规格当前版本延期的原因。
- 实际执行：[API 160 场](../../api/acceptance/execution-report.json)、[Web 78 场](web-acceptance-execution.json)、[Storybook 540 场](web-storybook-execution.json)、[最终变更 Storybook 11 场](web-final-changed-story-execution.json)、[真实跨仓 1 场](cross-execution-report.json)。
- [Web 执行汇总](web-execution-report.json)：实际测试、生产构建、静态门禁、稿件证据和源文件 SHA；[最终一致性复核](final-verification.json) 记录主仓完成门禁与选定截图的人工可视复核。
- 新测试重建与旧测试退休：[API 映射](../../api/acceptance/legacy-retirement-plan.json)、[Web 映射](web-test-retirement.json)、[Storybook 重建说明](web-story-rebuild.json)、[跨仓说明](../../e2e-contract/README.md)。
- [baseline.json](baseline.json) 与 [设计导入清单](../../docs/design-v2/source-manifest.json)：源需求、AC 与导入文件来源；原 provider 会话和原稿历史来源只读。

`summary.json`、`shell-audit.json`、`project-access-*-audit.json`、`image-system-audit.json`、`*-summary.json` 为历史审计；`sandbox-current.json`、`credential-git-current.json`、`project-automation-current.json` 为分批核对阶段记录。它们不参与最终完成比例。浏览器初轮失败报告保留；最终 manifest 按每张稿、主题、宽度引用最后实际通过的证据，没有改写初轮结果。

复跑主仓 `pnpm migration:report` 更新汇总；`pnpm migration:check:complete` 检查全量 AC、需求补充、稿件归属、六组截图、证据路径及导入 SHA。运行 `pnpm docs:check` 检查文档与当前跨仓契约。各测试运行方式见 API/Web/跨仓 README。

提交前的格式统一与复验另记在 `publication-verification.json`；原浏览器证据保留实跑时的源码及报告，不把仅格式变化写成重新执行1020组。
