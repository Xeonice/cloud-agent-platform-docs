# 沙箱运行时架构决策（ADR · S1 定基线）

> 状态：✅ 已决策，待据此更新 04/06/03/13/P19 并实施 refactor。
> 背景：S1 三方审查 + 主流调研发现 S1 的 provider 是 **docker exec 薄封装**（隔离最弱档），且宿主 `docker exec` 与 microVM 不兼容。为"第一级骨架定对、早期少欠债"，定下两个互相耦合的决策。

## 决策 A：执行/终端走**沙箱内 API 数据面**（控制面 / 数据面分离）

主流架构（E2B envd / AIO Sandbox / Daytona）= 控制面管生命周期、数据面经**沙箱内 API** 暴露 fs/process/pty。我们采用同构模型：

- **控制面**（NestJS backend + dockerode / containerd）：沙箱生命周期 `create/start/stop/destroy/inspect`。provider 特定。
- **数据面**：`exec / pty / fs` 走**沙箱内 API**。aio/boxlite = **AIO Sandbox 自带 API**（`http://<container>:8080`，agent-infra/sandbox）：
  - 交互终端：`ws /v1/shell/ws`
  - 命令执行：**`POST /v1/bash/exec`**（有状态会话，原生带 `env`/`exec_dir`/`hard_timeout`，stdout/stderr 分离 + `exit_code`）+ 同族的 `/v1/bash/kill`（真实信号）。⚠️ **不是 `/v1/shell/exec`**——那个端点只收 `command`/`exec_dir`/`timeout`，**没有 `env`/stdin/signal**（实测，04 §2.3★）
  - 文件（后续切片）：其 File API
- **裸镜像 fallback**：`DockerExecAgentClient`（宿主 `docker exec`），仅用于**无内置沙箱内 API 的镜像**（如 S1 alpine e2e）。是 fallback，不是主路。
- **未来 microVM**（Kata/Firecracker）：**同一数据面契约**，agent 经 vsock/网络；**终端/exec 契约零改动**。

> 关键收益：终端/exec 契约焊在"沙箱内 API"而非 docker exec —— provider（容器/gVisor/microVM）可换，契约不变。

## 决策 B：boxlite = **BoxLite micro-VM**（Mac 原生独立内核隔离）

- **aio** = runc 容器（AIO Sandbox 镜像，经 Docker），container 级隔离，默认档。
- **boxlite** = 同一 OCI 镜像跑进 **BoxLite Box**（每个 Box = 独立 Linux kernel 的 micro-VM），强隔离档，**非仅标签**。
- **BoxLite**（github.com/boxlite-ai/boxlite）= Rust micro-VM 运行时，**可插拔 hypervisor：macOS→Apple Hypervisor.framework、Linux→KVM、Windows→WSL2**。sub-50ms、daemonless、无 root、OCI 兼容；有 Node/TS SDK（`@boxlite-ai/boxlite`）+ Python/Rust/C + BoxRun CLI/REST。
- **为什么是它、不是 gVisor/Kata/Firecracker**：本平台单机私有化、**部署目标含 macOS**，gVisor 是 Linux-only、Firecracker/Kata 需 KVM/Linux，**都上不了 Mac 原生**。BoxLite 是当前唯一能在 Mac（Apple Silicon / Hypervisor.framework）原生跑"独立内核 microVM"的选型——boxlite 这一档从设计之初就是为此而生（P19"独立内核微虚拟机"措辞正确，无需修订）。
- **控制面差异**：aio 生命周期用 dockerode（docker daemon）；boxlite 生命周期用 **BoxLite SDK/API**（非 docker）。数据面（沙箱内 `:8080` agent）两档统一。
- **落地门槛：已实测通过 ✅**（本机 macOS 15.5 / Apple Silicon）：
  - **aio(Docker)**：`/v1/shell/exec`（S1 当时的验证端点；**数据面现已切到 `/v1/bash/exec`**，见 04 §2.3★）+ `ws /v1/shell/ws` 终端 ✅；Chromium 经 CDP 真导航 example.com 拿到标题 ✅（在 AIO 镜像 amd64/QEMU 副本上实测；arm64 原生功能等价、未复测）。
  - **boxlite(BoxLite microVM)**：microVM 起 ✅（aarch64, kernel 6.12, Hypervisor.framework, ~6s）；exec/并发 ✅；**Chromium 148 在 microVM 内起动 + 本地渲染 + 联网导航 ✅**（唯一告警 headless 无 dbus，无害，exit 0）。
  - **Box 内 `:8080` 访问机制（此前未知，已确认）**：BoxLite SDK `SimpleBox({ ports:[{hostPort, guestPort}] })` 做端口转发，实测 host→VM HTTP 200。数据面模型在 boxlite 上成立。

## 终端两段映射（前端契约不变；AIO 协议翻译在 provider，不在网关）

分两段边界，各司其职，**网关对 provider 无关**：

**① 前端 ⇄ 网关**：**我们的 socket.io `/terminal`**（shared/10 §7.4，**不变**）。网关只做「我们的帧 ↔ 中立 `ProcessStream`」，与 06 现状**完全一致**：`input`→`stream.write`、`resize`→`stream.resize`、`stream.onData`→`data` 帧、`stream.onExit`→`exit` 帧；`socketSessionKey` 由网关**服务端生成、128-bit、不落盘**。

**② 网关持有的 `ProcessStream` ⇄ 实际 PTY 源**：由 **provider 的 `spawn` 实现**提供，网关不感知底层。aio/boxlite 的 `spawn({tty:true})` = `AioSandboxAgentClient` 连 in-sandbox API `ws /v1/shell/ws`，把 AIO 协议翻译成中立 `ProcessStream`——**翻译在此，不在网关**：

| 中立 `ProcessStream` | AIO Sandbox `/v1/shell/ws`（provider 内翻译） |
|---|---|
| `stream.write(s)` | 发 `{type:'input', data:s}` |
| `stream.resize(c,r)` | 发 `{type:'resize', data:{cols,rows}}` |
| `stream.onData(buf)` ← | 收 `{type:'output', data}` |
| （keepalive，provider 内部消化） | 收其 `{type:'ping'}` → 回 `{type:'pong', data:{timestamp}}` |
| `stream.onExit(code)` ← | ws 关闭 / 进程结束 → **合成** exit |
| （不外泄） | 连接返回 `session_id`（provider 内部持有，**绝不外泄**；对外只有网关生成的 `socketSessionKey`） |

- **fallback**：无内置 agent 的裸镜像用 `DockerExecAgentClient`（docker exec 包装成同一 `ProcessStream`）。
- 好处：网关永远只跟 `ProcessStream` 打交道 → docker-exec / AIO-agent / 未来 microVM-agent **一视同仁**，provider 差异全被 `spawn` 实现吸收。

## SPI 与实现（文档 04）

- **契约面不变**：04 的 `SandboxProvider.spawn({tty}) → ProcessStream` 已是实现无关的正确抽象（04 §2.2/§2.4）。**本决策不改 04 契约**，只钉死 aio/boxlite 的**实现形态**：
  - `spawn` 由 **in-sandbox API 数据面**支撑，**不是宿主 docker exec**：
    - `tty:true` → 连 AIO `ws /v1/shell/ws`，包装成 `ProcessStream`（翻译见上表）。
    - `tty:false` → 走 AIO **`POST /v1/bash/exec`**（收集输出到 EOF；即 04 §2.3 的 `toExecFn` 语义）。**选它而不是 `/v1/shell/exec`：后者不支持 `env`/stdin/signal**，`/v1/bash/exec` 原生带 `env`/`exec_dir`/`hard_timeout`，配套 `/v1/bash/kill` 投递真实信号（能力面与实测见 04 §2.3★）。
  - 裸镜像 fallback：`DockerExecAgentClient`（docker exec 包装成同一 `ProcessStream`）。
- **控制面按 provider 分实现**（04 §2.2 已列）：`AioSandboxProvider`→dockerode（经 socket-proxy，11 §1）；`BoxliteSandboxProvider`→BoxLite SDK（`@boxlite-ai/boxlite`，进程内嵌，无 daemon）。
- provider capability 增：`hasInSandboxAgent: boolean`、`agentPort`（默认 8080）、`isolationKind: 'docker-container'|'boxlite-microvm'`。
- `ProcessStream` 中立 seam **不变**（`onData/onExit/write/resize/kill`）。
- （后续）fs / 富 exec 等数据面能力可抽 `SandboxAgentClient` 扩展，仍**不破 `spawn` 契约**。

## 安全姿态（收敛 S1 审查 P1）

- **agent 端口的可达面 + 鉴权（Step 4 已加固）**：
  **端口形态（未变，据实记录）**：aio 走 dockerode `PortBindings: { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }] }`（内核分配临时端口，`docker-container-backend.ts`）；boxlite 走 `ports: [{ hostPort, guestPort: 8080, hostIp: "127.0.0.1" }]` 且 `detach: true`（端口转发随 microVM 存活，跨后端重启仍可达，`boxlite-sandbox.provider.ts`）。选它的原因是单机形态（含 macOS Docker Desktop，容器 IP 宿主不可达）拿不到内部网络地址。**⚠️ 原文写"仅经 docker 内部网络对 backend 可达、绝不 publish 到宿主"——与实现不符，已按实现更正。**
  **原风险**：`127.0.0.1` 挡的是**外部主机**，挡不住**宿主本机**——加固前宿主上任意本地进程（任意用户、任意脚本，例如 `npm install` 的 postinstall）都能直接 `POST http://127.0.0.1:<port>/v1/bash/exec`，那是一个**无鉴权 shell**，绕开平台全部鉴权在沙箱内任意执行、读走凭证与私有仓源码。
  **✅ 加固形态：用 agent 自带的鉴权网关（探明 2026-08，实测真镜像 `ghcr.io/agent-infra/sandbox:latest`）**。AIO 镜像**原生支持鉴权，只是默认关**：`/opt/gem/entrypoint.sh` 依据环境变量 `JWT_PUBLIC_KEY` 是否非空，在 `nginx-server-without-auth.conf` 与 `nginx-server-with-auth.conf` 之间切换前门。开启后除 `GET /v1/ping` 外**所有路由**都过 nginx `auth_request` → agent 自己的 `GET /auth`（`gem/routers/auth.py`）：base64 解码 `JWT_PUBLIC_KEY` 得到 PEM 公钥，**只认 RS256**（`jwt_algorithms=["RS256"]` 硬编码、无 env 覆盖），不校验 `aud`/`iss`，`exp` 存在才校验。
  **实现**：两个 provider 在 `create()` 各自生成一次性 RSA-2048 密钥对（`agent-auth.ts`）——公钥经 `ctx.env.JWT_PUBLIC_KEY` 注入实例（**平台的值覆盖调用方的值**：空值会把镜像切回免鉴权配置），用私钥签一枚 claim 极简（`sub`+`jti`，无 `exp`/`aud`）的 RS256 JWT 后**私钥即丢弃**；token 挂在 `SandboxHandle.agentAuthToken` 上由平台持久化（`sandboxes.agent_auth_token`），客户端每次 HTTP 调用带 `Authorization: Bearer`。
  **websocket（PTY）走 ticket**：运行时的 WHATWG `WebSocket` **不能带请求头**，token 无法随 upgrade 走。agent 正好为此留了口子——`POST /tickets`（自身受 Bearer 保护）签发短票，`GET /auth` **优先**从 nginx 的 `X-Original-URI` 里读 `ticket` 查询参数。所以 `openTerminal` 先用 token 换票、再把票拼进 `ws /v1/shell/ws?ticket=…`；**换票失败绝不降级为匿名连接**（`aio-sandbox-agent.client.ts`）。
  **就绪门槛同时变成鉴权自检**：`waitForAgent` 现在要求**带 token 的请求 2xx**（证明前门 + auth 后端 + 注入的公钥三者都活了，第一次 exec 不会撞上半启动的网关），并且**匿名请求必须被拒**——镜像若忽略 `JWT_PUBLIC_KEY`，实例会在 `start()` **响亮失败**而不是安静地继续当开放 shell。
  **实测证据**：匿名 `POST /v1/bash/exec` / `POST /v1/file/read` ⇒ 401；伪造 Bearer ⇒ 401；匿名 ws upgrade ⇒ 拒绝；平台带 token 的 exec 与 PTY ⇒ 正常（`apps/api/test/e2e/aio-agent-auth.e2e-spec.ts`，8 条断言全过）。
  **残留风险（如实登记）**：token 与 `platform.db` 同处 `DATA_ROOT`，**以平台用户身份运行的进程**仍能读出它——那类进程本来也能读 `.master.key`，所以不是新增暴露面，但本条买到的是"挡住盲扫 loopback 与其他本地用户"，**不是**"同用户隔离"。**复议触发条件不变且升 P0**：一旦引入端口转发、多用户、或把 agent 端口暴露到非 loopback/远程可达，必须重新评估（届时应改走共享 docker 网络 + 不 publish，或 unix socket）。
- **前端→网关鉴权**：终端 socket.io 握手纳入访问口令/会话校验（修 S1 审查 P1-1，`PasscodeGuard` 对 ws 上下文自豁免的洞）。
- 组合（**加固后**）：外层前端→网关认口令；内层网关→agent 走**宿主 loopback + 每沙箱一枚 RS256 bearer token**。⚠️ 原写"走内网、不外露"，已按实现更正；内层这一段**现在有鉴权**，loopback 只是纵深的第一层而非唯一防线。剩下的缺口是同一 uid 的本地进程（见上条残留风险）。

## 影响面

- **文档**：本 ADR（新增，权威）· 04（钉 aio/boxlite 的 `spawn` 实现=in-sandbox API，指针引用本 ADR）· 06（`ProcessStream` 源=in-sandbox API；**网关设计不变**，AIO↔ProcessStream 翻译在 provider）· 03（容器/Box 暴露 agent 端口——**实现为宿主 loopback publish**，见上「安全姿态」+ 就绪探测；boxlite 控制面=BoxLite SDK；镜像经本地 registry 预置）· 13（沙箱内 API 端点：`aio` 运行时解析不落库，`boxlite` 的转发端口与**两侧的 agent bearer token** 必须落库——⚠️ 原写"一律不落库"，已按实现更正，见 13 §2.1.1）· P19（boxlite 措辞已正确，无需改）。
- **代码 refactor（S1 之上）**：
  - 后端：**provider 的 `spawn` 实现**从 docker exec 换成 `AioSandboxAgentClient(ws /v1/shell/ws)`（`tty:false` 走 exec 端点——当时是 `/v1/shell/exec`，**现为 `/v1/bash/exec`**，见 04 §2.3★），**网关保持不变**；`DockerExecAgentClient` 降为 fallback；boxlite 控制面接 BoxLite SDK；容器/Box 创建暴露 agent 端口（**实现为宿主 loopback publish**）+ 就绪探测；provision 失败销毁容器/Box（修审查 P1-2）；WS 握手口令校验（修 P1-1）。
  - 前端：**契约不变**，仅并入 S1 审查的 P0（连接抖动）+ P1（onInvalidFrame 接线）修复。
- **验证**：docker/boxlite e2e 改用 **AIO Sandbox 镜像**（含 `:8080`）跑真 `ws /v1/shell/ws` 终端；boxlite 档经 BoxLite 起 Box（宿主未装 BoxLite 则该档 skip loud，不静默假过）。

## 工程注记（BoxLite 集成必读，来自实测）

1. **BoxLite 有独立于 Docker 的 OCI image store**（`~/.boxlite`），且**层下载不断点续传**——每次重试新建 `.downloading` 临时文件，慢网下大镜像（如 Chromium 层 ~727MB）直连外网几乎拉不全。
2. **可行解 = 本地 registry 中转**：Docker（可续传）拉好目标 arm64 镜像 → `docker push localhost:5001/...` → BoxLite runtime 配 `imageRegistries:[{host:'docker.io',search:true},{host:'localhost:5001',transport:'http'}]` → 走 localhost 秒拉。落地时预置沙箱镜像（AIO Sandbox）走此中转，避免每次冷拉。
3. **坑**：自定义 `imageRegistries` 会**替换**默认表，**必须显式保留 `docker.io`**，否则连 bootstrap base（`debian:bookworm-slim`）都 `manifest unknown`。
4. macOS Apple Silicon 上 Hypervisor.framework **无需额外权限**即可起 microVM；原生二进制为 `@boxlite-ai/boxlite-darwin-arm64`（~79MB `.node`，napi-rs），须确保完整安装（曾遇截断二进制 dlopen 失败）。
5. BoxRun CLI 公开安装 URL（`boxlite.ai/boxrun/install`）当前 **404**——集成走 npm SDK `@boxlite-ai/boxlite`，勿依赖该 CLI。

## 减债原则落地

1. 终端/exec 契约 = 沙箱内 API 数据面 → microVM 化零改动。
2. 前端 socket.io 协议是**稳定边界**，后端翻译层吸收 provider 差异。
3. BoxLite 可插拔 hypervisor 覆盖 macOS/Linux/Windows，boxlite 档跨平台单机可跑（Mac 原生，无需 Linux/KVM）；aio 走 Docker。
4. docker exec 保留为 fallback（裸镜像/无 agent），不删，但非主路。
