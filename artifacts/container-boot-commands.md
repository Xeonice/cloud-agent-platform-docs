# Docker 版服务：一次性 Mac 开机自启安装

应用 API、BoxLite、Cloudflare Tunnel、Jenkins 和构建节点都运行在容器内。日常发布、初始化数据目录、容器启动和日志由 Jenkins 与 Docker 完成。

**本机已完成安装并核对三个系统启动项。无需重跑以下命令。** 容器使用 `restart: unless-stopped`，Mac 的 `/Library/LaunchDaemons` 启动三个专属 Docker 虚拟机。原登录级重复入口已移除。一次管理员安装已完成；以后不需要手工启动每个服务。

以下命令只安装三个固定的 Docker 引擎启动项，不停止当前 API 或 Tunnel，不安装宿主 Java/Node 应用守护进程，不改变 Docker 全局 context，也不挂载 Mac 用户目录到容器。

```sh
sudo '/Users/douglasdong/.local/share/fnm/node-versions/v22.23.3/installation/bin/node' '/Users/douglasdong/.local/share/agent-platform-jenkins-tools/container-boot/bootstrap-host.mjs' apply-system
```

准备材料：`/Users/douglasdong/.local/share/agent-platform-jenkins-tools/container-boot/review.json`。安装前脚本验证已审阅的固定启动定义、安装器校验和及三个 profile 的配置校验和。

安装器 SHA256：`5e694190c586e160a7bdc75772691a86185dc8ba88dadc8766690f6b22220cb9`。

成功输出应包括：`state: system-engine-services-installed`、`profileCount: 3`、`domain: system`。不要重跑早期 `system-review-20261007*` 或旧的四个宿主服务安装命令。

目前尚未宣称整台 Mac 冷启动验收完成。容器和发布迁移的验收继续自动进行。
