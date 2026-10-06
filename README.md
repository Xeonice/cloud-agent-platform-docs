# 云 Agent 管理平台

管理项目、交互式 Agent 任务与无头自动化。产品规则见 [当前需求](./docs/product/requirements/README.md)，实现与验收入口见 [实现状态](./IMPLEMENTATION-STATUS.md)，技术文档见 [文档索引](./docs/README.md)。

## 1. 仓库组成

主仓固定 `api`、`web` 子模块版本，包含 `e2e-contract` 跨仓验收、文档及本地 Jenkins 构建发布工具。

```sh
git clone --recurse-submodules https://github.com/Xeonice/cloud-agent-platform-docs.git
cd cloud-agent-platform-docs
git submodule update --init --recursive
```

## 2. 开发环境

使用 Node 22 和各仓 `packageManager` 指定的 pnpm。API 原生依赖须在目标系统及架构安装；生产 BoxLite 在专属 Linux ARM64 VM 中使用 KVM。开发环境与生产数据目录分开。

## 3. 本地开发

在 `api`、`web` 分别安装依赖。API 配置参见其 `.env.example` 与 [部署规范](./docs/shared/11-部署与扩展预留.md)，前端接口配置见 [共享契约](./docs/shared/10-接口契约与类型共享.md)。

```sh
pnpm --dir api install --frozen-lockfile
pnpm --dir web install --frozen-lockfile
pnpm --dir api start:dev
# 另一个终端
pnpm --dir web dev
```

根 `docker-compose.yml` 提供包含前后端的本地 Compose 入口；后端 Compose 的 Provider 与资源前提仍须满足。正式 Mac mini 部署采用下面的独立服务方案。

## 4. 生产部署与发布

本地 Jenkins 负责构建、验收、打包、API 发布与 GitHub Release，前端发布 Vercel prebuilt 产物。生产 API、BoxLite 与 Cloudflare Tunnel 使用专属运行 VM；Jenkins controller 与通用 CI 使用独立 Docker 环境。服务启动、持久卷、日志、空闲切换与恢复命令见 [Mac mini 部署](./docs/macmini-deployment.md)。

API、web 与主仓 SHA 是同一发布计划的组成部分。部署使用已验证的不可变产物，不能用本机未提交文件替代发布来源。

## 5. 访问与凭证

访问口令默认开启，匿名请求不能读受保护资源；部署口令与 Agent/Git 凭证独立。口令会话、轮换及浏览器失效规则见 [ACC](./docs/product/requirements/ACC.md)。厂商登录由用户显式开始，敏感值保存后不回显。

## 6. 运行时与数据

生产任务由 BoxLite microVM 隔离。项目基线、数据库、凭据密钥与保留成果属于持久数据；删除容器不等于删除持久卷。任务停止保留名额与代码副本，销毁按确认选择保留成果。实际部署的数据路径和备份策略见部署说明。

## 7. 当前验收

```sh
pnpm docs:check
pnpm deploy:test
pnpm --dir api test:acceptance
pnpm --dir web test:acceptance
pnpm --dir web test:storybook
pnpm --dir e2e-contract test
```

类型、lint、构建、OpenAPI/WS/SSE 一致性与验收执行仍由对应仓入口和 Jenkins 记录。规格条数、Storybook 状态数与实际测试通过数分别报告。

## 8. 文档入口

[产品总纲](./docs/product/19-产品总纲.md) · [页面信息架构](./docs/product/21-页面信息架构与交互.md) · [产品裁决](./docs/product/requirements/decisions.md) · [测试协作](./docs/shared/29-测试策略与测试Agent.md) · [更新记录](./CHANGELOG.md)。
