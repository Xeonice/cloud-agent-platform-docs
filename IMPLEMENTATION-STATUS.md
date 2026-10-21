# 当前实现与验收入口

当前生成验收清单包含1096个AC，既有REQ／AC保持稳定编号；UPG领域包含9个REQ、52个AC，完整验收尚未完成。稳定编号与Given/When/Then保存在[领域需求](./docs/product/requirements/README.md)；互斥替代与延后范围见[产品裁决](./docs/product/requirements/decisions.md)。

## 当前实现

前端以共享 AppFrame 承载工作台与设置页，任务、项目与管理流程采用同一组实际查询和操作。后端提供 REST/MCP、终端 WebSocket、诊断 SSE、SQLite 事务和 BoxLite 生命周期。接口与前端类型从同源契约生成，读取失败不伪装为空或健康，取消与失败保留可恢复状态。

任务发起的项目、分支与镜像采用统一搜索单选控件；镜像支持注册别名、独立编辑和按别名查找，任务继续提交真实镜像坐标。代码、迁移与本地验收见[任务选择与镜像别名记录](./docs/product/changes/2026-10-09-任务选择与镜像别名.md#8-本轮交付检查)，该记录不代表已发布到远端。

本轮已恢复部署／Golden测试入口、生产Owner扩展和credential台账边界，修复升级原请求恢复，落实完整类型感知lint与纯领域入口，并强化CI契约完整性。联网历史与诊断只展示声明目标的事实，不再决定任务准入；初始化显式确认和实际业务校验保留。源码、PRD、原型与本地验收见[架构整改执行记录](./docs/testing/results/2026-10-18-架构审查与整改执行记录.md)，发布和实例激活分别记录。

构建与发布固定 Root／API／Web 精确提交，PR 构建用于验收；CD 仅发布产物。服务统一采用 Colima Linux arm64、Foundation 与 ControlAPI／Web／StateCoordinator／RuntimeOwner／Installer，实例管理员决定升级时机。Jenkins controller 和通用构建与业务运行分开。部署、运行与维护见 [运维入口](./docs/ops/README.md)。本页不保存容易过期的 PID、构建号或部署快照。

## 实施中的升级连续性

[独立升级控制、恢复与安全退役](./docs/testing/results/2026-10-20-独立升级控制实现与资格准备.md)已进入代码与隔离协议验收阶段：控制账本及访问策略独立，恢复使用新意图和epoch，业务包不替换控制系统；候选退役须等待原工作及真实引用排空。首次真实迁移、Native沙箱连续性和远端更新尚未执行，当前部署结构仍以运维记录为准。

[不停机升级与沙箱续接](./docs/product/changes/2026-10-10-不停机升级与沙箱续接.md)已确定CD只发布版本与安装包，实例升级时机由用户主动决定；PRD、原工作台增量设计及前后端实施方案据此更新。[独立测试计划](./docs/testing/changes/2026-10-10-不停机升级与沙箱续接测试计划.md)统一验证前端、后端、契约、真实升级联调及原任务连续性，逐项覆盖52条AC。发现新版／用户发起升级／安装后刷新为三个阶段，检查和日提醒不升级，原沙箱与终端持续。本轮源码已接入现有实例访问认证与幂等受理、持久实例控制器、版本化Web入口、纯发包CD、RuntimeOwner／StateCoordinator／ControlAPI角色、唯一写权交接、兼容投影迁移与恢复。实际完成范围和本地检查见[验证记录](./docs/testing/results/2026-10-12-升级实现验证记录.md)。本机与远端已采用分离角色部署，远端本轮数据迁移、Cookie 刷新、真实 Guest／终端重连及来源退役已通过，见[统一部署验收](./docs/testing/results/2026-10-17-统一部署与在线升级验收.md)。后续 CLI 新包、管理员触发升级实验、模型 Agent 连续性和完整故障门禁仍未完成，UPG 的 52 条 AC 不记为全部通过。

## 持续验收

各仓的 Jenkins 门禁、阶段与本地等价命令以 [CONTRIBUTING](./CONTRIBUTING.md) 为准；`e2e-contract` 使用独立真实 API、临时数据和浏览器验证跨仓链路。

api 的 `pnpm check:acceptance` 核对验收清单与 `docs/product/requirements` 的对应关系，它读取主仓的 `docs/`，只能在主仓检出的 `api/` 里本地运行，不在 Jenkins 门禁内。

组件验收保留真实 container、hook、service 与 store，只替换外部边界；API 验收使用生产服务、SQLite 和完整 HTTP/MCP/WS 装配。Storybook 承载视图状态与交互样本；真实跨仓和外部 Provider 验证单独记录执行条件。

## 结果口径

实际执行结果由各仓测试报告与 Jenkins 构建产物维护，记录源 SHA、命令、数量、失败、跳过和适用环境。代码审查、规格条目、截图与测试 case 是不同证据；未执行的行为不记作通过。维护策略见 [共享验收策略](./docs/shared/29-测试策略与测试Agent.md)。

升级入口已移除额外密钥和授权弹窗，访问实例后直接点击升级；前后端及真实浏览器的验证与未上线边界见[会话升级验收](./docs/testing/results/2026-10-17-升级复用实例访问会话.md)。
