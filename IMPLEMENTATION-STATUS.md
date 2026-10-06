# 当前实现与验收入口

当前产品规格包含 247 个 REQ、1016 个 AC，覆盖工作台、项目、任务、Agent/Git 凭证、访问口令、镜像、系统诊断/审计、自动化和初始化。稳定编号与 Given/When/Then 保存在 [领域需求](./docs/product/requirements/README.md)；互斥替代与延后范围见 [产品裁决](./docs/product/requirements/decisions.md)。

## 当前实现

前端以共享 AppFrame 承载工作台与设置页，任务、项目与管理流程采用同一组实际查询和操作。后端提供 REST/MCP、终端 WebSocket、诊断 SSE、SQLite 事务和 BoxLite 生命周期。接口与前端类型从同源契约生成，读取失败不伪装为空或健康，取消与失败保留可恢复状态。

正式构建与发布由本地 Jenkins 管理，生产 API/BoxLite/Tunnel、Jenkins controller 和通用构建分离运行；前端采用 Vercel prebuilt 发布。运行状态、日志、持久数据和维护操作见 [Mac mini 部署](./docs/macmini-deployment.md)。本页不保存容易过期的 PID、构建号或部署快照。

## 持续验收

- 主仓：`pnpm docs:check`、`pnpm deploy:test`。
- API：`pnpm check:acceptance`、`pnpm test:acceptance`、`pnpm typecheck`、`pnpm lint`、`pnpm build`，以及 OpenAPI 与 wire 一致性检查。
- web：`pnpm test:acceptance`、`pnpm test:storybook`、`pnpm typecheck`、`pnpm lint`、`pnpm build`。
- `e2e-contract`：`pnpm test`，使用独立真实 API、临时数据和浏览器验证跨仓链路。

组件验收保留真实 container、hook、service 与 store，只替换外部边界；API 验收使用生产服务、SQLite 和完整 HTTP/MCP/WS 装配。Storybook 承载视图状态与交互样本；真实跨仓和外部 Provider 验证单独记录执行条件。

## 结果口径

实际执行结果由各仓测试报告与 Jenkins 构建产物维护，记录源 SHA、命令、数量、失败、跳过和适用环境。代码审查、规格条目、截图与测试 case 是不同证据；未执行的行为不记作通过。维护策略见 [共享验收策略](./docs/shared/29-测试策略与测试Agent.md)。
