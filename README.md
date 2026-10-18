# 云 Agent 管理平台

管理项目、交互式 Agent 任务与无头自动化。产品规则见 [当前需求](./docs/product/requirements/README.md)，实现与验收入口见 [实现状态](./IMPLEMENTATION-STATUS.md)，技术文档见 [文档索引](./docs/README.md)。参与开发先读 [CONTRIBUTING](./CONTRIBUTING.md)，部署与运维从 [运维入口](./docs/ops/README.md) 开始。

## 1. 仓库组成

主仓固定 `api`、`web` 子模块版本，包含 `e2e-contract` 跨仓验收、文档及本地 Jenkins 构建发布工具（`deploy/`）。

```sh
# 本地，任意目录
git clone --recurse-submodules https://github.com/Xeonice/cloud-agent-platform-docs.git
cd cloud-agent-platform-docs
git submodule update --init --recursive
```

## 2. 开发环境

使用 Node 22（建议 22.23.3，与 CI 一致；不支持 20 和 24），pnpm 由 corepack 按各仓 `packageManager` 选择，所以 pnpm 命令要在各仓目录内执行。原因与切换版本后的处理见 [CONTRIBUTING](./CONTRIBUTING.md)。

## 3. 本地开发

最小步骤如下，端口约定为 API `3001`、Web `3000`；配置说明、端口被占用时的备选和常见问题见 [CONTRIBUTING](./CONTRIBUTING.md)。

```sh
# 本地，仓库根目录，Node 22
corepack enable                     # 不想写系统目录时：corepack enable --install-directory ~/.local/bin
(cd api && pnpm install --frozen-lockfile)
(cd web && pnpm install --frozen-lockfile)
mkdir -p "$HOME/agent-platform/dev-data"
test -e api/.env || cat > api/.env <<EOF
HOST=127.0.0.1
PORT=3001
DATA_ROOT=$HOME/agent-platform/dev-data
BOXLITE_HOME=$HOME/agent-platform/dev-data/boxlite
EOF
cp -n web/.env.example web/.env.local
(cd api && pnpm start:dev)          # 首次启动会打印一次访问口令
# 另一个终端
(cd web && pnpm dev -H 127.0.0.1)   # 打开 http://127.0.0.1:3000
```

部署实例统一采用 Colima Linux arm64、Foundation 与五个独立角色，见 [统一虚拟化与实例部署](./docs/ops/统一虚拟化与实例部署.md)。上面的本地开发进程不作为服务部署入口。

## 4. 生产部署与发布

CD 构建、验证、签名并发布不可变版本与安装包。管理员决定本实例的升级时机；合并代码、发布包、检查新版和页面刷新都不会替管理员发起升级。每个实例固定自己的 Web 产物、业务数据、Owner home、信任根与升级历史。

本机与 `100.73.71.22` 已统一部署架构，当前均已完成`v0.3.15-experiment.*.20261018.2`实例限定更新。单次快速受理、原请求查询、同Web无刷新、原资源对照和现场问题见[本轮升级优化验收](./docs/testing/results/2026-10-18-升级优化发版与双实例更新验收.md)。

基础迁移与来源退役见[统一部署验收记录](./docs/testing/results/2026-10-17-统一部署与在线升级验收.md)。CLI沿用10/17已实测的Codex `0.163.0`／Claude Code `2.1.302`，历史镜像、终端和覆盖边界见[CLI镜像与双实例验收](./docs/testing/results/2026-10-17-CLI镜像与双实例更新验收.md)及对应[发包计划](./docs/ops/2026-10-17-Codex与ClaudeCode升级发包计划.md)、[独立测试计划](./docs/testing/changes/2026-10-17-CLI版本升级与用户触发更新测试计划.md)。

部署只使用有精确三仓提交、平台及完整摘要的已验证不可变产物，不能用本机未提交文件替代。发版、运维与灾备流程见 [运维入口](./docs/ops/README.md)。完整升级要求见 [UPG](./docs/product/requirements/UPG.md)。

## 5. 访问与凭证

访问口令默认开启，匿名请求不能读受保护资源；部署口令与 Agent/Git 凭证独立。口令会话、轮换及浏览器失效规则见 [ACC](./docs/product/requirements/ACC.md)。厂商登录由用户显式开始，敏感值保存后不回显。

## 6. 运行时与数据

生产任务由 BoxLite microVM 隔离。项目基线、数据库、凭据密钥与保留成果属于持久数据；删除容器不等于删除持久卷。任务停止保留名额与代码副本，销毁按确认选择保留成果。生产数据卷与备份见 [灾备与重建](./docs/ops/灾备与重建.md)。

## 7. 当前验收

```sh
# 本地，仓库根目录，Node 22
pnpm docs:check
pnpm deploy:test
(cd api && pnpm test:acceptance)
(cd web && pnpm test:acceptance && pnpm test:storybook)
(cd e2e-contract && pnpm test)
```

e2e-contract 首次运行前要装依赖和 Chromium；各仓 Jenkins 门禁的完整阶段与本地等价命令见 [CONTRIBUTING](./CONTRIBUTING.md)。规格条数、Storybook 状态数与实际测试通过数分别报告。

## 8. 文档入口

[产品总纲](./docs/product/19-产品总纲.md) · [页面信息架构](./docs/product/21-页面信息架构与交互.md) · [产品裁决](./docs/product/requirements/decisions.md) · [测试协作](./docs/shared/29-测试策略与测试Agent.md) · [参与开发](./CONTRIBUTING.md) · [运维入口](./docs/ops/README.md) · [更新记录](./CHANGELOG.md)。
