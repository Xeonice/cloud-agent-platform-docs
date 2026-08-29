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

### ⚠️ 决策 A 修订（2026-08-26）：契约统一 ≠ **实现**统一

**上面这条被实测推翻了一半。** 保留的一半是对的：数据面**契约**（`ProcessStream` /
`SandboxJobs` / `SandboxFiles`）确实与 provider 无关，换 provider 不用改契约。
推翻的一半是：**「数据面 = 沙箱内 API」被当成了架构约束**，于是 boxlite 复用了 aio 的
`AioSandboxAgentClient`——理由写在 `agent-data-plane.ts` 的注释里，很诚实：

> `aio` 和 `boxlite` 运行**同一个镜像**，因此是同一个 agent。

⚠️ **「两个 provider 跑同一个镜像」是当前配置的巧合，不是契约保证的性质。** 把它当成
共用的地基，等于让 boxlite 的可用性挂在一个第三方镜像里的 python 服务上。

#### 推翻它的实测（2026-08-26，本机 M9 / boxlite 0.9.7 / arm64）

| 同一个 box，同一条命令 | 沙箱内 API（`POST /v1/bash/exec`） | BoxLite native `Box.exec` |
| --- | --- | --- |
| `echo hi` | 200 | `exit=0`，103ms |
| **`codex --version`** | **70ms → HTTP 500，agent 此后永久挂死** | **`exit=0`，18.6s，拿到 `codex-cli 0.139.0`** |
| 挂掉之后再来一条 `echo` | 500（整个沙箱废掉） | `exit=0`，82ms |

第三行最说明问题：**那个 box 的 agent 早已挂死，native exec 照常干活**。
排查过程中被自己的实验否掉的假设，一并记下来免得重走：**不是内存**（docker 限 2GB 跑同一条
命令 200/44ms，占用仅 440MB，微 VM console 无 OOM）、**不是 PATH**（绝对路径同样挂）、
**不是镜像**（`platform/base:v1` 与上游 `agent-infra/sandbox:latest` 的 `diff_ids`
**逐层完全相同**，只差三个 LABEL）、**不是 rootfs 缺失**（whiteout 的 `cp -a` 失败在两个
BOXLITE_HOME 里都发生过，而其中一个跑 `boxlite-microvm.e2e` 是**通过**的）。

⚠️ 顺带量到一个必须写进预算的数字：**codex 在微 VM 里启动 18.6 秒，docker 里 44ms——420 倍**。
那是 COW qcow2 + virtiofs 的代价，与 agent 无关；**所有按容器定的超时都要按它重算**。

#### 官方立场

BoxLite 文档对「在 box 里跑 agent CLI」的推荐是**直接用 native `Box.exec` 驱动**，
明确不建议在 box 内再套一层 HTTP agent server：*avoids unnecessary HTTP abstraction
layers in favor of direct process I/O, keeping the agent boundary minimal:
stdin/stdout and forwarded ports*。我们的做法与它正好相反。

#### 修订后的分工

- **契约不变**：`ProcessStream` / `SandboxJobs` / `SandboxFiles` 仍是 provider 无关的抽象。
  已逐字段核对：`env` / `cwd` / `user` / `timeoutMs` / `stdin` / `cols,rows` 在 native 侧
  **全是原生参数**，不需要翻译损耗。
- **实现各自选通道**：`aio`（容器）走沙箱内 API——那是 AIO 镜像自带的能力，合理；
  `boxlite`（微 VM）走 **BoxLite native exec / PTY**。
- **一致性靠契约测试，不靠共享实现**（`runSandboxProviderContractTests`）。
  ⚠️ 这是本次最要紧的一条：共享实现保证的是「两边一样」，可一旦那份实现对某个 provider
  不适用，"一样"就变成**一起错**——这次就是。像 `startJob` 的 ordering 那种
  **只写在共用实现注释里**的规则，要提升成 testkit 里的断言。

#### 这一刀顺带砍掉三笔账

1. **本文档「安全姿态」里那条 ⏳** —— ⚠️ **这一条我先写错了，实测更正如下。**
   写修订时我判断「boxlite 不再需要转发端口 ⇒ 该攻击面在这一档直接消失，连 RS256 JWT
   注入都不需要了」。**错的。** BoxLite 会把镜像 `EXPOSE` 的端口**自动发布到宿主，且是
   通配地址**，我们要不要都一样：

   | `JsBoxOptions.ports` | 宿主上新增的监听 |
   | --- | --- |
   | 不传 / `[]` | `*:8080` |
   | `[{guestPort: 1}]` | `*:8080` **和** `*:1`（给别的端口加映射只是**追加**） |
   | `[{hostPort: 45999, guestPort: 8080, hostIp: '127.0.0.1'}]` | `*:45999`（只改宿主那侧的号；**`hostIp` 被忽略**，根本不是 loopback） |

   ⚠️ 而且**不是 loopback，是局域网可达**：实测那条监听是 **IPv6 通配** `*:8080`。
   不注入 `JWT_PUBLIC_KEY` 时 `POST http://[::1]:8080/v1/bash/exec {"command":"id"}`
   回 **HTTP 200 + `uid=1000(gem)`**——一个局域网内任意机器都能打的免鉴权 shell；
   注入后同一请求 **401**（`/v1/ping` 仍 200，白名单）。

   ⛔ **我自己的复验一度否掉了这个发现，方法有 bug**：拿 `lsof` 的 NAME 列做差集，
   而宿主上 Docker 已占着 IPv4 `*:8080`，boxlite 新增的 IPv6 `*:8080` **被当成同一条
   抵消掉了**。差集为空 ≠ 没有新增监听。**取证要带协议栈和 pid，不能只看端口字符串。**

   ⇒ 结论改成：**关不掉，所以必须上锁。** boxlite 仍注入 `JWT_PUBLIC_KEY`，但**只上锁
   不留钥匙**（私钥当场丢弃、一枚 token 都不签、不落库、`providerState` 依旧为空）——
   平台自己也进不去那扇门，因为数据面全在 native 那侧。**「删掉 boxlite 对 agent 的依赖」
   指的是数据面依赖，不是那个 HTTP 服务不存在了。**
   另外仍须给 guest 8080 指一个**空闲宿主端口**：不是为了连它，而是把这个无法关闭的发布
   从「固定端口」挪到「唯一端口」，否则第二个 box 起不来
   （`gvproxy_create failed: 0.0.0.0:8080 already in use`，本仓 e2e 真红过）。
   ⏳ 真正的收口要么 BoxLite 提供抑制自动发布的开关、要么给微 VM 加网络策略，当前 SDK 都没有。
2. **jobs 的「生存义务」**（04 §2.6 ★★★）：agent 的 streaming socket 断开会销毁它创建的
   session、连输出带命令一起杀掉，现在靠"先建 session 再 attach"的顺序硬绕，还要在
   create 时提前拉高 `BASH_SESSION_TIMEOUT`/`MAX_BASH_SESSIONS`。native 下改成
   **输出落 box 内文件 + 游标 seek**：进程与读取者解耦，平台重启后照样续读。
3. **`kill` 语义**：aio 的 PTY 没有信号通道，`kill()` 只能往终端里写 `ETX + exit\n`
   ——按 `ProcessStream.detach` 的注释，那会 SIGINT 掉用户正在跑的 agent。
   native 有 `signal(n)`，是真信号。

#### native 能力已逐项实测（不是从文档推断）

并发（3×sleep2 墙钟 2252ms，串行会是 6000ms）、长跑进程 193ms 立刻返回、
**进程独立于 execution 存活**（3.5s 后日志 4 行）、**真 PTY**（`TTY=/dev/pts/2`，
`resizeTty(30,100)` 后 `tput cols`=100，stdin 交互与退出码正常）。


## 决策 B：boxlite = **BoxLite micro-VM**（Mac 原生独立内核隔离）

- **aio** = runc 容器（AIO Sandbox 镜像，经 Docker），container 级隔离，默认档。
- **boxlite** = 同一 OCI 镜像跑进 **BoxLite Box**（每个 Box = 独立 Linux kernel 的 micro-VM），强隔离档，**非仅标签**。
- **BoxLite**（github.com/boxlite-ai/boxlite）= Rust micro-VM 运行时，**可插拔 hypervisor：macOS→Apple Hypervisor.framework、Linux→KVM、Windows→WSL2**。sub-50ms、daemonless、无 root、OCI 兼容；有 Node/TS SDK（`@boxlite-ai/boxlite`）+ Python/Rust/C + BoxRun CLI/REST。
- **为什么是它、不是 gVisor/Kata/Firecracker**：本平台单机私有化、**部署目标含 macOS**，gVisor 是 Linux-only、Firecracker/Kata 需 KVM/Linux，**都上不了 Mac 原生**。BoxLite 是当前唯一能在 Mac（Apple Silicon / Hypervisor.framework）原生跑"独立内核 microVM"的选型——boxlite 这一档从设计之初就是为此而生（P19"独立内核微虚拟机"措辞正确，无需修订）。
- **控制面差异**：aio 生命周期用 dockerode（docker daemon）；boxlite 生命周期用 **BoxLite SDK/API**（非 docker）。~~数据面（沙箱内 `:8080` agent）两档统一。~~ ⚠️ **数据面已不统一**（决策 A 修订）：aio 走沙箱内 API，boxlite 走 BoxLite native exec/PTY；统一的是**契约**不是实现。
- **落地门槛：已实测通过 ✅**（本机 macOS 15.5 / Apple Silicon）：
  - **aio(Docker)**：`/v1/shell/exec`（S1 当时的验证端点；**数据面现已切到 `/v1/bash/exec`**，见 04 §2.3★）+ `ws /v1/shell/ws` 终端 ✅；Chromium 经 CDP 真导航 example.com 拿到标题 ✅（在 AIO 镜像 amd64/QEMU 副本上实测；arm64 原生功能等价、未复测）。
  - **boxlite(BoxLite microVM)**：microVM 起 ✅（aarch64, kernel 6.12, Hypervisor.framework, ~6s）；exec/并发 ✅；**Chromium 148 在 microVM 内起动 + 本地渲染 + 联网导航 ✅**（唯一告警 headless 无 dbus，无害，exit 0）。
  - **Box 内 `:8080` 访问机制（此前未知，已确认）**：BoxLite SDK `SimpleBox({ ports:[{hostPort, guestPort}] })` 做端口转发，实测 host→VM HTTP 200。数据面模型在 boxlite 上成立。

## 决策 C（2026-08-29）：**镜像**与**控制面**也拆开 —— 决策 A 修订没做完的那一半

### 病灶：数据面拆了，镜像没拆

决策 A 修订把数据面拆成两套（aio 走沙箱内 API、boxlite 走 native exec/PTY），但**两档仍共用同一个镜像**。于是留下一个谁都没得益的中间态：

> **boxlite 跑着一个 13GB 的 aio 镜像，而那个镜像里的 HTTP 服务在 boxlite 档位下一次都不会被调用。**

boxlite 实际只用到 `tmux` + `node` + CLI。镜像里的 Chrome、VNC、VSCode server、Jupyter、MCP 那一整套，在微 VM 里是纯粹的死重。代价是实测出来的：**冷启动 190 秒**（13GB 现拉 + 铺 rootfs），而这段时间里 `sandbox.status` 恒为 `starting`、CPU 0%、无网络活动 —— 用户判它卡死，**排查的人第一眼也判它卡死**（2026-08-28 实录）。

### 病灶二：为了盖一个章，造出一整条依赖链

`platform/base` 相对上游 aio **只加了三个 LABEL、零实质内容**：

```dockerfile
FROM ghcr.io/agent-infra/sandbox:latest
LABEL platform.tmux="true" platform.supportedRuntimes="codex" platform.resourceDefaults="{...}"
```

而血统检查卡的就是 `platform.tmux`。⚠️ **上游镜像本来就有 tmux**（实机验证：`/usr/bin/tmux` 3.2a，另有 node v22.23.0、codex 0.139.0；只缺 claude-code）。所以那一层加的是**一个它本来就为真的事实的声明**。

代价却是完整的一条链：pull 13GB → 打标签 → push 13GB → **必须自建 registry 存它** → registry 跑在 Docker 里 → **Docker 一停整条链断**。2026-08-28 这条链真的断了：用户一个 Task 都建不出来，而错误出现在**新建任务弹窗**里 —— 整条链路上最晚、最挫败的时机。

⚠️ 代码注释自己把这条规则定位成「**运维方对自己指定的那张镜像做的一次声明**」。问题正在这里：**一个「声明」被要求刻进镜像**，于是运维方为了声明一件事，被迫成为镜像作者。

### 目标形态：统一的是**契约**，镜像 / 数据面 / 控制面三样都不必统一

| | 平台 | 镜像 | 数据面 | 控制面 |
|---|---|---|---|---|
| **boxlite** | macOS（Virtualization.framework） | **精简镜像**（tmux + node + CLI，**实测 1.25GB**，见下方订正） | BoxLite native exec/PTY | BoxLite SDK |
| **aio** | Linux（boxlite 在 Linux 上用不了，这是 aio 存在的全部理由） | 上游 aio + CLI 派生层 | **aio 自己的 HTTP API** | 容器运行时（docker） |

⚠️ **别把两档的定位搞反**（本文档作者犯过）：boxlite 是 **macOS** 档，aio 是 **Linux** 档。

### aio 数据面：**早就是**它自己的 API（本节初稿写错，2026-08-29 订正）

⚠️ **本节初稿断言「数据面全部走 docker exec」，是错的。** 那是从 `AioSandboxProvider extends DockerContainerBackend` 这一行**推断**出来的，而没有去读 `aio-sandbox-agent.client.ts`（1545 行）——它早已在用 `/v1/bash/exec`、`/v1/bash/output`（双游标 + `wait` 长轮询）、`/v1/bash/kill`、`/v1/bash/sessions/{id}/close`、`/v1/file/*`、`ws /v1/shell/ws`。`DockerExecAgentClient` 只在 `agentPort` 未设时作**裸镜像兜底**，而注册的两个方案都设了 `agentPort`，**谁都走不到它**。

⇒ 「数据面对称」这个目标**在决策 A 修订时就已经达成**，本决策真正欠的是**控制面拆分**与**镜像拆分**两项。⚠️ 教训：`extends` 一个 docker 类，不等于数据面走 docker —— 继承关系说明的是控制面从哪来，数据面在另一个协作者里。

下表仍是权威映射（实测形状见后），只是它描述的是**已完成状态**而非待办：

实测到的映射（2026-08-29，`ghcr.io/agent-infra/sandbox:latest`，spec 取自镜像自带的 `/v1/openapi.json`）：

| 契约 | aio 原生 API | 实测形状 |
|---|---|---|
| `startJob` | `POST /v1/bash/exec` + **`async_mode:true`** | 返回 `command_id`(UUID) / `status:"running"` / `offset:0` / `stderr_offset:0` |
| `readJob(cursor)` | `POST /v1/bash/output` + `offset`/`stderr_offset` | 返回 `stdout` / `stderr` / **推进后的 offset** / `command.status` / `exit_code`；另有 `wait`+`wait_timeout` 可长轮询 |
| `killJob(signal)` | `POST /v1/bash/kill` + `signal` | — |
| `releaseJob` | `POST /v1/bash/sessions/{id}/close` | — |
| stdin | `POST /v1/bash/write` + `input` | — |
| `readFile`/`writeFile`/`listFiles` | `/v1/file/read` `/write` `/list` | — |
| `openFileStream` | `GET /v1/file/download` | — |
| TTY | `/v1/shell/ws`（WebSocket） | — |
| `inspect` | `GET /v1/sandbox` + 容器状态 | 返回发行版/端口占用/已装语言运行时 |

⚠️ **`offset` 是字节游标**（实测 `"A\nB\n"` 之后回 `offset:4`），与 boxlite 那套**自建**的 setsid + 文件 + 游标语义一致 —— 也就是说 boxlite 费力模拟出来的东西，aio 原生就给了。

⚠️ **stdout / stderr 各有独立游标**，契约的 `JobCursor` 要能装下两个偏移（boxlite 侧已经是这个形状，对得上）。

### 认证：用 aio 原生的，别自造

aio 原生支持 `SANDBOX_API_KEY`（`X-AIO-API-Key` / `Authorization: Bearer` / `?api_key=`），**不设则完全开放**（实测属实：不带任何 key 的 GET 返回 200）。平台现有那套自造的 `withAgentAuthEnv` / `agentAuthToken` / `createAgentAuthMaterial` 可以退役。

⚠️ `providerState` 里持久化 token 的理由仍然成立（04 §7：端口可从 `docker inspect` 重新推出，token 不能）—— 迁移时别把它一起丢了。

### 控制面：保留容器运行时，但收窄成端口

aio 官方**只文档化了 `docker run` 与 Kubernetes**，SDK 只覆盖「已运行实例内的操作」，**没有任何实例 provisioning API** —— 所有示例都是 `Sandbox(base_url="http://localhost:8080")` 连一个已经起好的实例。**平台自己就是那个缺失的编排层**，这不是可以外包的部分。

调研过的两个现成方案都不适用（**都要完整 K8s 集群**，与单机私有化定位冲突）：

| | 依赖 | 单机可用 |
|---|---|:--:|
| `kubernetes-sigs/agent-sandbox` | K8s + CRD + RuntimeClass（gVisor/Kata） | ❌ |
| `agent-sandbox/agent-sandbox` | K8s ≥ 1.28 | ❌ |

但 k8s-sigs 那个的 **Sandbox CRD 形状值得抄**：`create / destroy / pause / resume` + 稳定网络身份 + 可选持久存储 + **把底层隔离委托给可替换的 RuntimeClass**。最后一条正是我们要的分层：**控制逻辑（起几个、配额、回收、生命周期）留在平台，「把一个 OCI 镜像变成一个跑起来的进程」交给一个可替换的执行者。**

⇒ 把控制面从 `AioSandboxProvider extends DockerContainerBackend` 里拆出来，做成一个薄端口（`create/start/stop/destroy/inspect`）。docker 是它今天唯一的实现；镜像本身不依赖 Docker 任何特性（不挂 socket、不 DinD、不要 BuildKit，官方自己给 k8s 清单就是证明），所以将来换 podman / containerd 只是换实现。⚠️ 唯一的硬约束是 `--security-opt seccomp=unconfined`（官方标为必需）。

### 隔离粒度：**一个 Task 一个实例**，不用 session 分

⚠️ 曾考虑过「一个项目一个 aio 实例、Task 用 `/v1/bash/sessions` 区分」以省容器数量。**这条路是错的**：aio 的 session 只隔离会话状态（cwd / 环境变量 / 进程上下文），**完全不隔离文件系统** —— 同容器内所有 session 共享 `/home/gem`，而「共享」正是 aio 的卖点（官方原话：browser 下载的文件能立即被 shell 访问），**是设计意图，不是可绕开的限制**。

同项目的 Task 之间会：文件互相可见可覆盖、同一个 `gem` 用户、同一 PID namespace 看得到彼此进程、一个 Task 写满磁盘拖垮全部。而平台跑的是 **LLM 生成的代码** —— 隔离在这里是安全边界，不是资源优化。用子目录分只是弱约定，agent 一句 `cd ..` 就穿过去了。

### 镜像：删掉只打标签的中间层

- **删 `platform/base`**（零实质内容）
- **boxlite 档**：精简镜像（tmux + node + CLI）。**实测收益（2026-08-29，本机 macOS）**：

  | | 镜像 | 冷启动（空 `BOXLITE_HOME`） | 整套 e2e |
  |---|---|---|---|
  | 改动前 | 13GB aio | **190 秒** | 1056s，2 个文件红 |
  | 改动后 | **1.22GB** 精简 | **24.4 秒** | **380s，全绿** |

  ⚠️ ADR 初稿写的是「冷启动会掉到**秒级**」——量级对了，但实测是 **24.4 秒**，「秒级」会让人以为是个位数。
  ⚠️ 顺带证伪了一次误判：`workspace-clone` 与 `agent-task-job-plane` 两条 e2e 在 13GB 镜像下红（60 秒预算 / 600 秒 hook 都不够 190 秒的 provision），换镜像后**自己就绿了** —— 差点被当成「测试超时预算写小了」去调数字，那会把真问题掩盖掉。⚠️ 这两条此前一直因为无 Docker 而整体跳过，**是第一次真跑**，红了才被看见
- **aio 档**：`FROM 上游` + 装 claude-code + **升级 codex**（上游 0.139.0，npm 最新 0.150.1）
- 血统检查那个「运维方的声明」**移到平台侧配置**。防谎报仍由运行期 `command -v tmux` 兜底 —— 契约注释里明说了本条替代不了它

⚠️⚠️ **「aio 走 docker 时本地 build 的镜像可直接用、不必 push」—— 本节初稿这句话是错的，2026-08-29 在真 Linux 机器上证伪。**

镜像要过**两关**，而它们问的不是同一个东西：

| 关 | 谁在问 | 问谁 |
|---|---|---|
| 注册 / 开机播种 | `OciImageSpecProvider` | **registry 的 HTTP API —— 从不问 docker daemon** |
| 起容器 | 容器运行时 | 本机镜像库 |

`DefaultImageSpecRegistry` 只注册了 `oci` 一个 provider，所以第一关**必须**能从 registry 拉到 manifest。实测：`docker build -t platform/sandbox:dev` 之后注册 ⇒ `registry-1.docker.io answered 401`（它把无 host 的名字当成了 Docker Hub）；push 到自建 registry 后立刻 `seeded … (valid)`。

⇒ **自建 registry 在 aio 这条路上同样不能省。** 两档都要。

⚠️ 更值得记的是**这句错话为什么能活这么久**：唯一走 `registerImage` 的那批 e2e 全部用 `.overrideProvider(IMAGE_SPEC_REGISTRY).useValue(makeFakeImageSpecRegistry())` 换成了不联网替身 —— **真实的镜像播种路径没有任何自动化测试覆盖**。补一个不走替身的 e2e，是防止同类错话再次发生的根因修法。

✅ **已补（2026-08-29）**：`apps/api/test/e2e/image-seeding-registry.e2e-spec.ts`。它**不覆盖** `IMAGE_SPEC_REGISTRY`：真的起一个 `registry:2`、真的 `docker build` + `docker push`、真的让 `ImageSeeder` 在 `app.init()` 里播种。正反两向：

| 方向 | 断言 | 排除的是 |
|---|---|---|
| 正 | push 过 ⇒ 播成 `valid`，且 digest **等于 registry 自己回答的那一个** | 「registry 这条路根本不通」/「digest 是编出来的」 |
| 反 | 同一份 bits、同一个 registry、**只是没 push** ⇒ `REF_NOT_FOUND`（前置先断言 daemon 里确实有它） | **就是上面那句错话本身** |

⚠️ 依赖 docker + 本机有 `registry:2` / `alpine:3.20`，缺前置**大声跳过并说明缺什么**。已在真 docker 下实跑，并用四个变异验证过会红（播种被跳过 / 根镜像 tmux 检查被摘掉 / 404 不再当 `REF_NOT_FOUND` / digest 改成自己合成）。

⚠️⚠️ **CI 里必须让它真的跑起来，否则等于没补。** ubuntu runner 自带 docker 但不带这两张镜像 ⇒ 默认会跳过，而跳过就是「镜像从哪来」这个问题在 CI 里继续没人问 —— 那正是这句错话能活这么久的机制本身。`ci.yml` 因此在 e2e 之前 `docker pull registry:2 alpine:3.20`（两张共 ~50MB）。**13GB 的 AIO 镜像仍然永不自动拉**：放行的判据是体积，不是「反正拉一下」。

⚠️ 顺带在同一轮里抓到一个**同形状**的东西：`terminal-container` / `boxlite-microvm` / `workspace-clone` 三个 e2e 裸赋值 `process.env.SANDBOX_DEFAULT_IMAGE` 且从不还原（e2e 是 `singleFork`，一个进程共享一份 env）。泄漏之后 `registry-extension.e2e` 会因为「播种时已经注册过了」而红。**而 CI 从来没红过 —— 因为 CI 上没有 AIO 镜像，那三个文件全被跳过，泄漏根本不发生。** 一个只在「测试真的跑起来时」才存在的串扰。已改走 `useEnv`，并在 `suite-hygiene.e2e-spec.ts` 加了机械守卫。同一轮还发现 `terminal-container` 把 `registry.defaultProvider` 硬写成 `'aio'`，而它跟宿主平台走（darwin ⇒ boxlite）—— 在 macOS 上一旦真跑起来必红。

⚠️ 另一个隐形约束（同轮撞到）：血统已知表匹配的是 `platform/sandbox`（**斜杠**），而 Dockerfile 目录叫 `platform-sandbox`（**连字符**）。build 成 `…/platform-sandbox:v1` 会被拒（「平台还没有可用的预制镜像作为血统基准」），必须是 `…/platform/sandbox:v1`。

✅ **已让它自己说得出来（2026-08-29）**：这条约束此前**只存在于一张表里**，而失败信息一个字都没提到名字 ⇒ 排查方向必然跑偏。现在三处补齐：

- `builtin-image.ts#explainKnownTmuxRepositories` —— 认出「只差一个分隔符」并给出正确形态（`platform-sandbox` ↔ `platform/sandbox`），否则至少列出内置已知仓库；接在 `IMAGE_TMUX_MISSING` 的 message 后面；
- ⚠️ **`ImageSeeder` 的日志此前把原因整个丢了**：`ManifestInvalidError.message` 是一句「镜像不满足平台约定，未注册」，真正的 finding 住在 `outcome.errors[]` 里 —— HTTP 出口把它们放进 `details[]` 所以界面上看得见，**只有日志这条出口没有**，而那正是运维方看 `docker compose up` 输出时唯一的信息源。已改成渲染 findings；
- `api/images/README.md` 与 `.env.example` 显式写明「`-t` 里是斜杠，不是目录名」。

### ⚠️ 落地实测订正（2026-08-29，实机 WSL2 + Docker 28.3.2）

本节记的是**落地时与上面描述对不上的地方**，按发现顺序。

1. **「现在的 `AioSandboxProvider` 数据面全部走 docker exec」——不成立。**
   代码里数据面**早就是** aio 原生 HTTP/WS（`AioSandboxAgentClient`：`/v1/bash/exec`、
   `/v1/bash/output`、`/v1/bash/kill`、`/v1/shell/ws`、`/v1/file/*`），`docker exec`
   （`DockerExecAgentClient`）只在 `agentPort` 未设时作为**裸镜像 fallback**存在，而注册的
   两个方案都不会走到它。⇒ 决策 C 的「aio 数据面」那一节描述的是**已经完成的状态**；本轮
   真正未做的是**控制面拆分**与**镜像拆分**。

2. **`platform/boxlite` 实测 1.25GB，不是「百 MB 级」。**
   其中 **550MB 是两个 CLI 的预编译二进制**（codex 318MB + claude-code 205MB），
   不可压缩——两个包都只装当前平台那一份。590MB 是 `node:22-bookworm-slim`，106MB 是 apt。
   结论（13GB → 1.25GB，小一个数量级）仍然成立，**数字别照抄**。

3. **上游镜像里 `npm install -g` 的默认 prefix 是「每个用户一份」的，直接用会装了等于没装。**
   镜像 ENV `NPM_CONFIG_PREFIX=/root/.npm-global`，而沙箱内命令以 **`gem`** 跑
   （prefix `/home/gem/.npm-global`）；Dockerfile 的 `RUN` 以 root 跑 ⇒ 装进 root 的目录，
   `gem` 的 PATH 上没有它，**不报任何错**。
   `/usr/local` 同样不行：`gem` 的 PATH 里 `/opt/nodejs/22/bin` **排在 `/usr/local/bin` 前面**，
   而上游 codex 就在那儿——新装的会被旧的遮住，升级看起来成功、实际没生效。
   ⇒ prefix 必须取 **node 自己的安装前缀**（三个 shim 目录共同指向的那一份）。

4. **不能在跑着的容器里 `npm install` 来验证镜像内容。**
   实测：`docker exec` 装完后 `docker exec` 看得见，而**沙箱 API 的 bash 会话看不见**
   （它的 `/opt/nodejs/22/bin` 里没有新文件，mtime 还是构建日期）——沙箱服务跑在自己的
   mount namespace 里。验证只有一条路：**构建镜像、起新容器、经 `/v1/bash/exec` 问**。

5. **`--security-opt seccomp=unconfined`：官方标为必需，但主路径不需要它。**
   实测不加它，`bash` / `tmux` / `codex` / `claude` 全部正常。⇒ 它买的是 browser/VNC 那一档
   的可用性。已加上（官方要求），但**如实登记它放宽了容器隔离**，缓解在别处（一个 Task 一个
   实例 + loopback + `SANDBOX_API_KEY` + 配额）。

6. **`?api_key=` 实测能把 WS 开到 101，但我们仍走 `POST /tickets`。**
   query 会进沙箱自己的 nginx access log，而这把钥匙的寿命是**整个沙箱**（ticket 30 秒过期）——
   等于把长期凭证写进沙箱内进程读得到的日志。

7. **`GET /v1/ping` 是镜像唯一免鉴权的路由**（nginx `map` 里显式列出）。就绪探测该用它，
   而「匿名必须被拒」那条反向自检**绝不能**用它——用了会在一张完全正确的镜像上判失败。

8. **`DockerExecAgentClient` 已删除** —— 见下方「决策 C-2：docker exec fallback 废止」。
   它取代了「减债原则落地 4」原先那条「保留为 fallback，不删」。

### 影响面

- `AioSandboxProvider` 重写（数据面走 HTTP API，控制面拆成端口）
- `DockerContainerBackend` 降级为控制面的一个实现
- 现有 aio e2e **建立在 docker exec 之上，语义会变**
- `platform/base` 镜像与其构建脚本删除；`platform/sandbox` 改为直接 `FROM` 上游
- `.env.example` 的 `SANDBOX_DEFAULT_IMAGE` 与血统检查配置同步（那一行 2026-08-28 已因指向上游镜像而修过一次）

## 决策 C-2（2026-08-29）：**docker exec fallback 废止**

**结论**：删除 `DockerExecAgentClient`，`SandboxProvider.spawn` 不再有 docker exec 这条路。
本条**取代**「减债原则落地 4」原先写的「保留为 fallback，不删，但非主路」。

### 为什么废止

| 当初留它的理由 | 今天的事实 |
|---|---|
| 「给没有内置 agent 的裸镜像兜底」 | 注册的方案只有 **aio**（自带 `:8080` agent）与 **boxlite**（native exec/PTY）。**没有任何一条代码路径走得到它** —— 它是 `DockerContainerBackend` 里 `agentPort === undefined` 才进的分支，而 aio 恒定传 8080 |
| 「多一条路总没坏处」 | 它是一条**从外面撬进沙箱**的通道，且**比正路弱**：绕开 `/v1/bash/exec` 的 `hard_timeout`（真实远端 kill，不只是 HTTP 超时）、绕开 job 的存活语义（`BASH_SESSION_TIMEOUT` / `MAX_BASH_SESSIONS`）、绕开沙箱自己那道 `SANDBOX_API_KEY` 鉴权门 |

⚠️ **一条没人走、又比正路弱的旁路，留着的唯一效果是「将来有人会走它」** —— 而走它的那个人会以为自己拿到了和主路一样的语义。这正是决策 A 修订立下的那条原则的反面：两档都用**沙箱自己的接口**，不是「一个从里面、一个从外面」。

### 恢复方式（如果将来真的需要裸镜像档）

`packages/modules/sandbox/src/infrastructure/providers/docker/docker-exec-agent.client.ts`，
git 历史里的一个 **117 行**文件（删除于本轮）。⚠️ 恢复它之前先回答：**这个裸镜像档要怎么兑现 `headlessTask`？**
`docker exec` 没有 job 存活语义，所以恢复它意味着那一档的 `headlessTask` 必须是 `false`
—— 而那正是本轮 ④ 修掉的那类「声明了却兑现不了」的能力位。

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
4. ~~docker exec 保留为 fallback（裸镜像/无 agent），不删，但非主路。~~
   ⚠️ **本条已被「决策 C-2」废止（2026-08-29）**，`DockerExecAgentClient` 已删除。理由见该节。
