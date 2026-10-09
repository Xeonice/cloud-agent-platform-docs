# 当前实现与验收入口

当前产品规格包含 250 个 REQ、1036 个 AC，覆盖工作台、项目、任务、Agent/Git 凭证、访问口令、镜像、系统诊断/审计、自动化和初始化。稳定编号与 Given/When/Then 保存在 [领域需求](./docs/product/requirements/README.md)；互斥替代与延后范围见 [产品裁决](./docs/product/requirements/decisions.md)。

## 当前实现

前端以共享 AppFrame 承载工作台与设置页，任务、项目与管理流程采用同一组实际查询和操作。后端提供 REST/MCP、终端 WebSocket、诊断 SSE、SQLite 事务和 BoxLite 生命周期。接口与前端类型从同源契约生成，读取失败不伪装为空或健康，取消与失败保留可恢复状态。

任务发起的项目、分支与镜像采用统一搜索单选控件；镜像支持注册别名、独立编辑和按别名查找，任务继续提交真实镜像坐标。代码、迁移与本地验收见[任务选择与镜像别名记录](./docs/product/changes/2026-10-09-任务选择与镜像别名.md#8-本轮交付检查)，该记录不代表已发布到远端。

正式构建与发布由本地 Jenkins 管理，发布来源固定为主仓及 API/Web 三仓 `main` 的精确 SHA；PR 构建用于验收。生产 API/BoxLite/Tunnel、Jenkins controller 和通用构建分离运行；前端采用 Vercel prebuilt 发布。部署、运行与维护见 [运维入口](./docs/ops/README.md)。本页不保存容易过期的 PID、构建号或部署快照。

## 持续验收

各仓的 Jenkins 门禁、阶段与本地等价命令以 [CONTRIBUTING](./CONTRIBUTING.md) 为准；`e2e-contract` 使用独立真实 API、临时数据和浏览器验证跨仓链路。

api 的 `pnpm check:acceptance` 核对验收清单与 `docs/product/requirements` 的对应关系，它读取主仓的 `docs/`，只能在主仓检出的 `api/` 里本地运行，不在 Jenkins 门禁内。

组件验收保留真实 container、hook、service 与 store，只替换外部边界；API 验收使用生产服务、SQLite 和完整 HTTP/MCP/WS 装配。Storybook 承载视图状态与交互样本；真实跨仓和外部 Provider 验证单独记录执行条件。

## 结果口径

实际执行结果由各仓测试报告与 Jenkins 构建产物维护，记录源 SHA、命令、数量、失败、跳过和适用环境。代码审查、规格条目、截图与测试 case 是不同证据；未执行的行为不记作通过。维护策略见 [共享验收策略](./docs/shared/29-测试策略与测试Agent.md)。
