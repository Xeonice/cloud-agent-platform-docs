# CHANGELOG

本文件记录**平台整体**的版本。

三仓之中**只有主仓打 tag** —— 只有它能钉住一个完整、可复现的部署状态（两个 submodule 指针）。
⛔ 不给 `api` / `web` 各自打产品版本号：它们 `package.json` 里的 version 是**包版本**，
跟着产品号走会立刻与主仓 tag 漂移，而且改它们又会反过来动指针，绕成一个环。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循
[语义化版本](https://semver.org/lang/zh-CN/)。

---

## [0.1.0] - 2026-09-16

首个打 tag 的版本。在此之前主仓 142 次、`api` 106 次、`web` 97 次提交（2026-08-08 起）
**没有任何发布记录**。

> ⚠️ **这个号与产品路线图里的 v1.0 / v1.1 不是一回事。**
> 19 §6 用「v1.0」指代 **MVP 验收线**，那是一条产品裁决 —— 本仓没有任何验收记录，
> 我不替你宣布它达成了。本 tag 只是工程侧的第一个发布标记，故从 `0.1.0` 起。
> 真要宣布 MVP 达成，另打 `v1.0.0`。

### 交付形态

`docker compose up` 单机私有化部署（权威是 `api/docker-compose.yml`，那份经实跑验证）。
数据 / 代码 / 凭证不出本机；⚠️ 但 Agent 需出网访问 OpenAI / Anthropic API ——
**不支持完全离线跑 Agent**，这是物理约束不是缺陷（21-8 §1）。

默认只监听 `127.0.0.1`（审计 P0-3），改 `0.0.0.0` 需显式配置且会告警。

### 已实现

**双协议面**
- REST / OpenAPI：**62** 条 path（含 3 条 MCP 传输层），业务端点 **59** 条
- MCP：**14** 个 tool 已注册，与 02 §5.2 的设计集合逐条相等（`docs:check` B2 守着）
- **86** 个错误码，源码与 10 §6.8 的表集合相等（`docs:check` A5 守着）

**沙箱与运行时**
- 两档隔离 provider：`aio`（默认）/ `boxlite`（微虚拟机，独立内核强隔离）
- 两个 runtime：`codex` / `claude-code`
- 非交互执行 `exec_in_sandbox`；无头任务 `run_agent_task`（202 返回 taskId，单次最长 4h）

**实时通道**（三个 WS 网关）
- `/events` —— sandbox.* 事件驱动的状态投影
- terminal —— 双向 PTY 转发 + tmux 断线恢复
- tasks —— 无头任务的高频输出流（⚠️ 刻意不走 `/events`，那条通道会被字节流淹掉）

**前端**（4 条路由）
- `/` 工作台：任务树 / 终端多标签（LRU 挂载）/ 发起任务向导
- `/settings/credentials` 凭证管理
- `/settings/images` 镜像管理
- `/settings/system` 系统状态与诊断

**项目与自动化**
- 项目 CRUD + 异步 clone（`cloning` → `ready` 轮询，MCP 无推送通道）
- 自动化规则：定时唤起无头 Task、运行历史、webhook 失败通知、硬超时默认 2h

**无障碍与主题**（本轮收口）
- `prefers-reduced-motion` 全局兜底；真实渲染整页跑 axe 的 e2e 门禁
- 三态主题（跟随系统 / 暗色 / 亮色），默认暗色（产品 P21），首屏无闪烁

### 门禁

- 主仓 `docs:check` **12** 项（A1–A5 / B1–B7），含三处跨仓逐字节对账（openapi / WS / SSE）
- `web`：typecheck · lint · format · stories · mock-contracts · unit **1678** · storybook **501** · e2e **60**
- `api`：build · 分层边界（`eslint-plugin-boundaries`）· 单元 / 集成 / 契约 / e2e · mutation

### 已知缺口

- `POST /api/system/backup` · `GET /api/system/version` —— **v1.5 占位**，10 §6 已标 ⏳。
  ⚠️ 顺带一提：正因为 `/api/system/version` 还没落地，**运行中的实例读不到自己的版本号** ——
  这个 tag 目前只存在于 git 里，产品界面上看不见。
- 本机跑起来才发现的若干项见 `docs/LIVE-RUN-FINDINGS.md`（其中浅仓迁移仍 ⏳）
- `smoke.spec.ts:110` 在本机红、CI 绿 —— 本机环境问题，非回归

[0.1.0]: https://github.com/Xeonice/cloud-agent-platform-docs/releases/tag/v0.1.0
