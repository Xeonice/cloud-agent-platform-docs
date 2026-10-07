# Jenkins 的 GitHub App 状态来源

当前三个仓库 main 的必需检查使用专属 Jenkins App `5204009`。发现器根据真实 Jenkins 构建结果发布提交状态；下文保留 App 配置和权限核对流程。配置脚本不会修改分支保护，不会提交、合并或发布代码。

## 1. 注册和安装

使用 Douglas 的 UID 501 账户、原生 macOS ARM64 Node 22：

```sh
node deploy/jenkins/setup-github-app.mjs serve
```

命令只监听 `http://127.0.0.1:8033/`，15 分钟后关闭。打开输出的本机地址，确认 GitHub 登录账户为 **Xeonice**，点击表单按钮，由用户在 GitHub 审阅并创建 App。服务器不会自动提交注册。

实际 manifest 由 `statusAppManifest()` 生成，可直接审阅源码。App 为私有，名称为 `Xeonice Agent Platform Jenkins`，不请求用户 OAuth，不订阅事件，webhook 为 inactive；其中的 webhook URL 是未使用的声明，不需要新增后端入口。若 GitHub 提示名称已占用，可在注册页更改名称；验证器固定 owner 和权限，不依赖显示名称。权限为：

```json
{
  "contents": "read",
  "pull_requests": "read",
  "statuses": "write"
}
```

GitHub 自动提供的 `metadata: read` 允许存在；任何其他权限都会被验证器拒绝，包括 Administration、Checks、Actions、Contents write 和 Packages write。注册回调只接受当前本机 Host、未过期随机 state 和一次性的 manifest code。兑换后使用返回的 RSA 私钥验证真实 `GET /app` 身份，再将两个文件保存到：

```text
/Users/douglasdong/.local/share/agent-platform-jenkins-tools/github-status-app.json
/Users/douglasdong/.local/share/agent-platform-jenkins-tools/github-status-app.pem
```

目录必须 UID 501 所有、0700，文件必须 UID 501 所有、0600；不能是符号链接。输出不会包含 PEM、client secret、webhook secret 或 token。现有配置和私钥不会被注册流程覆盖。兑换或本地保存失败后不可重放 code；先审查该目录的私有状态，再决定是否从 App 设置生成替代私钥或修复配置。

成功页提供安装链接。选择 **Only select repositories**，只选：

- `Xeonice/agent-platform-api`
- `Xeonice/agent-platform-web`
- `Xeonice/cloud-agent-platform-docs`

安装完成后运行：

```sh
node deploy/jenkins/setup-github-app.mjs verify
```

命令验证 App ID、slug、Xeonice 所有权、唯一匹配的 active selected installation 和实际权限，申请一个只包含上述三仓和最小权限的短期 token，再读取其有效仓库集合，核对恰好三仓后保存 installation ID。token 只在内存。底层 UI 的 selected 仓库全集不能通过这个受限 token 证明；用户必须只选择上述三仓。实现不会为探测额外选择而申请更广的 token。

## 2. Jenkins 使用方式

发现器只有提交状态的 POST 改用这个 App。分支、PR 查询以及 GitHub Release 仍使用原有私有 `github-token`；GHCR 继续使用独立 `ghcr-token`。

首次状态发布会验证 App 和 installation，使用 RSA 至少 2048 位的 RS256 JWT 申请受限 token，再核对有效仓库集合。JWT 使用 60 秒时钟偏移，约 9 分钟有效；安装 token 到期前 60 秒刷新。token 和 JWT 不写磁盘、不进入日志或构建产物。[JWT 规则](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app)、[受限安装 token](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app)。

无 App 配置或尚未验证 installation 时，保留 OAuth 状态发布，明确输出 `githubStatusSource.kind: oauth` 和原因；OAuth 来源不能满足绑定 App 的 main 必需检查。存在配置但身份、权限或文件安全校验失败时不会静默回退；状态保留在私有 outbox。`githubStatusSource.verified` 表示该进程实际验证过当前 App 授权，不替代 GitHub 保护规则的独立核对。

## 3. 当前保护规则

必需状态检查绑定以下名称和固定 App ID `5204009`：

| 仓库 | 必需状态检查         |
| ---- | -------------------- |
| API  | `jenkins/native-ci`  |
| Web  | `jenkins/web-ci`     |
| 主仓 | `jenkins/project-ci` |

success 状态只有完整 Jenkins job 最终 SUCCESS 才发送；某个中间 gate 的通过不能代替整个 job。状态绑定真实构建验证过的 SHA 与 REF，Web 和主仓同时核对三仓提交。更换 App 时，应先核验真实状态来源，再由管理员审阅规则变更，保留 strict、reviews 与其他保护；不要设为任意 App、`app_id: -1`，也不要删除 required checks 来解除阻挡。[保护规则来源限制](https://docs.github.com/en/rest/branches/branch-protection#update-status-check-protection)。本机工具没有 Administration write 权限。

## 4. 本机验收

```sh
node --test deploy/jenkins/github-status-app.test.mjs
```

验收使用临时 owner-only 文件、真实 RSA 签名和真实本机 HTTP 回调；GitHub 请求全部注入模拟响应。不会注册远端 App、发布真实状态或修改保护规则。
