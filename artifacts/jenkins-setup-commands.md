# Jenkins 容器迁移与 GitHub 授权命令

Mac mini 已安装三个 Docker 引擎的系统启动项：Jenkins controller、隔离构建、生产运行时。用户已执行管理员安装并验证三个 LaunchDaemon 已加载；日常容器启动、构建和发布不需要手工初始化。参见[已完成的开机配置](container-boot-commands.md)。

生产 API、BoxLite 和 Tunnel 的初次 Docker 数据迁移已完成。API 保留原有项目、基线文件、口令与会话配置；实际 HTTPS 健康、登录 cookie、精确 Origin 及 BoxLite KVM 虚拟机均已验证。原生 API/Tunnel 启动项已停用，原目录和迁移备份保留。日常发布及下载包以上述 Jenkins 的实际构建、上传收据和 GitHub Release 为准，不需要重跑本文件的安装命令。

## 1 Docker 引擎开机配置已完成

无需重跑安装。Docker 管理 API、Tunnel、Jenkins 与各构建节点的进程、重启和日志；Mac 系统启动项仅启动三个 Colima Docker 引擎。已经停用重复的用户级引擎启动项。

所有旧 `system-review-20261007*` 和 `host-service-installer-20261006` 安装命令已退役，不再执行。保留旧审核材料、原生服务数据和 Jenkins 导出，便于追溯及回退。实际整机冷启动尚未验证。

### 已完成：原 Jenkins 数据导出与导入

原 Jenkins Home 属于专属 UID `400`，目录权限为 `0700`，当前登录账户无法读取。本步骤需要在 Terminal 输入本机管理员密码，以标准 `tar` 导出已停止的原 Jenkins；不会修改原目录、停止生产 API 或 Tunnel，也不会启动发布任务。

本步骤已完成：归档含 9 个 job、6 次已完成构建记录，SHA-256 为 `713de5d21ed03d61be5b72b00bb952fd8f1bc5b0fafd53343f0525efe0daeeeb`。无需重跑。下面保留已执行的冻结导出命令供追溯：

```sh
sudo '/Users/douglasdong/.local/share/fnm/node-versions/v22.23.3/installation/bin/node' '/Users/douglasdong/.local/share/agent-platform-jenkins-tools/container-home-export-20261006/export-jenkins-home.mjs' apply '/Users/douglasdong/.local/share/agent-platform-jenkins-tools/migration/bc32cab8-c8a7-4891-9849-fd85bee61ddf/plan.json'
```

导出已成功，实际停止状态检查及归档完整校验通过。完整归档和 manifest 保存在上述 migration 目录，权限为 `0600`，其中包含加密密钥，不能上传到 GitHub 或聊天。导出源码 SHA-256 为 `e6943a8321c30d2c2da293f34cbfa6870f7b7426c51ec1a7f3ec408699c929a1`；实际停止状态检查已通过。

配置、用户、密钥及构建历史已导入新的 Docker 持久卷；旧插件、启动脚本、工作区和待执行队列已排除。正式 `8080` 在迁移模式下完成 Home 验证，随后切到 active 模式。导入时九个作业禁用，之后按验收结果启用；当前状态查看 [Jenkins](http://127.0.0.1:8080/)。原始导入验证见 [Home 迁移证据](jenkins-controller-home-migration-verification.json)及[模式验证](jenkins-controller-active-mode-verification.json)。

第 2—4 节已完成，无需重跑。既有[命令诊断](jenkins-system-cutover-command-probe-diagnosis.json)、[账户验证](jenkins-system-isolated-account-record-readonly.json)与 [Tunnel 生命周期验证](jenkins-system-cutover-live-lifecycle.json)保留作为历史证据；它们不表示 Docker 服务已经部署。

所有既有 `system-review-20261007*` 目录均不用于新的安装；其中的准备文件和验证结果保留，不删除或执行。

## 2 配置独立的 GitHub 镜像凭证

先打开 [GitHub classic PAT 创建页](https://github.com/settings/tokens/new?scopes=write:packages&description=Agent%20Platform%20Jenkins%20GHCR)，只选择 `write:packages`（`read:packages` 自动包含），设置合适的到期时间并自己生成 token。GHCR 需要这种凭证；`gh auth refresh` 得到的现有 OAuth 登录保留用于 Release 上传。[GitHub 官方说明](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry#authenticating-to-the-container-registry)

然后运行下面的本机导入命令，在隐藏输入提示中粘贴刚生成的 token。脚本会核对账号为 `Xeonice` 和 `write:packages` 权限，通过后保存为私有 `0600` 文件；不用粘贴到聊天或 shell 命令正文。

```sh
'/Users/douglasdong/.local/share/fnm/node-versions/v22.23.3/installation/bin/node' '/Users/douglasdong/orca/workspaces/cloud-agent-platform-docs/初始化一下项目开发/deploy/jenkins/import-ghcr-token.mjs'
```

执行新安装命令后回复“已完成”；若命令报错，提供错误文字即可，保留管理员密码和 token。

## 3 授权推送旧 CI 的归档改动

此步骤已完成：本机已核对现有 GitHub CLI 登录包含 `repo` 和 `workflow`，API/Web 的 CI 迁移提交已成功推送。下面的命令保留供以后授权时使用，现在无需重复执行。

GitHub 已实际拒绝这次推送：归档 `.github/workflows` 下的旧 CI 定义需要 `workflow` 权限；当前 GitHub CLI OAuth 登录只有 `repo` 等权限。下面的命令只补充这个权限，不修改已导入的独立 GHCR 凭证。[GitHub CLI 官方说明](https://cli.github.com/manual/gh_auth_refresh)

```sh
gh auth refresh -h github.com -s workflow
```

按 Terminal 提示完成 GitHub 授权后回复“workflow 授权已完成”。我会在本机核对权限并继续推送，无需在聊天里提供任何 token。

## 4 注册 Jenkins 的 GitHub 状态 App

本次 App 已成功创建，ID 为 `5204009`，名称为 `Xeonice Agent Platform Jenkins`，installation 为 `168317369`。已改为 **Only select repositories**，实际短期 token 的有效仓库集合验证恰好三仓，`verify` 已通过。此步骤无需重复执行；[安装设置](https://github.com/settings/installations/168317369)保留供日后维护。

三个仓库的 main 必需检查已切到专属 Jenkins App `5204009`，六个旧 GitHub Actions 工作流已停用，其余分支保护保持原值。注册脚本只准备和验证 App；检查来源的切换由独立 CI 迁移工具在真实 Jenkins 验收通过后执行。

下面的注册命令仅供首次创建时使用，本次已创建完成，无需重复执行。Terminal 会保持本机注册页面开启十五分钟：

```sh
'/Users/douglasdong/.local/share/fnm/node-versions/v22.23.3/installation/bin/node' '/Users/douglasdong/orca/workspaces/cloud-agent-platform-docs/初始化一下项目开发/deploy/jenkins/setup-github-app.mjs' serve
```

打开 [本机注册页面](http://127.0.0.1:8033/)，确认 GitHub 登录为 `Xeonice`，点击按钮审阅并创建私有 App。权限仅为 Contents read、Pull requests read、Commit statuses write；不订阅 webhook。成功页提供安装链接，请选择 **Only select repositories**，只选 `agent-platform-api`、`agent-platform-web`、`cloud-agent-platform-docs` 三个仓库。

完成安装后运行：

```sh
'/Users/douglasdong/.local/share/fnm/node-versions/v22.23.3/installation/bin/node' '/Users/douglasdong/orca/workspaces/cloud-agent-platform-docs/初始化一下项目开发/deploy/jenkins/setup-github-app.mjs' verify
```

通过后回复“Jenkins App 已安装”。私钥和配置只保存在本机私有目录，不用提供给聊天。后续我会用真实 Jenkins 构建核对状态来源，再迁移必需检查，保留其余保护规则。完整说明见 [GitHub App 设置](../deploy/jenkins/github-status-app.md)。
