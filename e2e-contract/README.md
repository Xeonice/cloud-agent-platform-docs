# 真实跨仓验收

在主仓使用 Node 22：

```sh
pnpm --dir e2e-contract install --frozen-lockfile
pnpm --dir e2e-contract exec playwright install chromium
pnpm --dir e2e-contract typecheck
pnpm --dir e2e-contract test
```

Runner 启动独立端口 3110/3210、生产 Next.js 构建、完整编译后 Nest AppModule、当前 SQLite 初始化和独立 DATA_ROOT。默认开发服务及用户数据不参与验收；可以用 `CONTRACT_API_PORT` / `CONTRACT_WEB_PORT` 修改端口。Web 构建使用独立 distDir、tsconfig 与 buildinfo。

目前实际场景覆盖浏览器空项目创建、任务发起与终端、停止、同一任务重启、镜像快照保持和销毁后移除。全局入口拒绝 request/WS/HAR interception。外部沙箱/OCI 元数据使用受控夹具，终端使用实际 Node 子进程字节流，模型连接目标为本机 TCP；不声称真实 Docker/BoxLite、厂商帐号授权或 native PTY 验收。

实际 Playwright expect 事件、distinct 断言源码位置、场景结果与 SHA-256 保存到 `artifacts/execution-report.json`。失败追踪保留在 `test-results/`；Playwright 原始 JSON 在 `artifacts/acceptance-results.json`。这些文件由每次验收生成，并由 Jenkins 构建归档，不纳入源代码版本库。计划 AC 数量不能替代实际场景与断言数量。
