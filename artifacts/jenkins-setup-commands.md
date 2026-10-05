# Jenkins 系统服务安装与 GitHub 授权命令

在这台 Mac mini 的 Terminal 中复制执行本文件的命令。安装只操作生产 `3101`，排除本地 `3100` 预览。

当前安装状态：`system-review-20261007e` 遇到 launchd 在停止期间仍显示旧服务的中间状态，安装器保留了维护屏障。已恢复原 GUI Tunnel，精确撤除自有屏障，公网 API 正常。修复后已用 `reviewf` 在真实服务上完成停止、等待、十秒空闲、恢复、鉴权 readiness 和屏障释放验证：实际等待原 job、PID 和端口消失约 31 秒，API 进程未变。新 `reviewg` 已准备；系统服务安装和首次 Jenkins 全量 Release 仍待完成。

镜像凭证已完成：本机已验证账号为 `Xeonice`、权限为 `write:packages`、凭证文件权限为 `0600`。第 2 节保留供以后轮换凭证时使用，现在无需重复执行。

## 1 安装 Mac 常驻服务

管理员密码只在 Terminal 的 sudo 提示中输入。安装器核对没有运行任务后，建立维护屏障、临时断开原专属 Tunnel，等待原 launchd job、PID、监听全部消失，所有连接归零并连续十秒空闲，再备份、切换生产 API 并安装六个常驻服务。生产入口会短暂中断，安装器不操作 `3100`。

```sh
sudo '/Users/douglasdong/.local/share/fnm/node-versions/v22.23.3/installation/bin/node' '/Users/douglasdong/.local/share/agent-platform-jenkins-tools/system-review-20261007g/tools/install-system-services.mjs' apply '/Users/douglasdong/.local/share/agent-platform-jenkins-tools/system-review-20261007g'
```

执行后回复“常驻服务已安装”，或提供错误文字。第 2—4 节已完成，无需重跑。[实际生命周期验证](jenkins-system-cutover-live-lifecycle.json)记录本次修复的真实运行结果；本次检查前后 `3100` 均无监听，安装器没有启动或停止预览服务。

旧的 `system-review-20261007b`、`system-review-20261007c`、`system-review-20261007d`、`system-review-20261007e` 不再使用；`system-review-20261007f` 仅用于已完成的实际生命周期验证。

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

三个仓库的 main 必需检查目前指定 GitHub Actions 的来源，普通 CLI 登录发送同名状态也无法替代。完整 CI 迁移需要专属 Jenkins App。脚本已通过 21 项回归；它只准备注册和验证，不修改分支保护。

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
