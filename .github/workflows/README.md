# Jenkins CI

项目检查、构建、打包与发布由 Mac mini 上的 Jenkins 管理，流水线位于 `deploy/jenkins`。

Jenkins discovery 只跟踪三仓 main、同仓指向 main 的 pull request（含 draft）与 API 的 sandbox-image 标签，其他分支、fork PR 和栈式 PR 不自动构建；contract job 运行文档和真实浏览器/Nest/SQLite 验收，并在每天 03:00 Asia/Shanghai 检查 main。release job 在本机完成三仓构建、打包和上传。GitHub 检查状态由专属 Jenkins GitHub App 回写。

此目录不包含可执行的 GitHub Actions 工作流。

当前服务、构建产物、日志和恢复入口见 [Mac mini 维护文档](../../docs/macmini-deployment.md)。
