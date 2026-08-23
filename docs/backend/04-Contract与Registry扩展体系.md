# 04 - Contract 与 Registry 扩展体系（细化版）

> 状态：✅ 可评审（第三轮：收敛暴露面为 6 个必须方法、补齐每个方法的用途说明、明确 `aio`/`boxlite` 两个内建方案、契约抽 npm 子包、testkit 补规范条款）
> 关联文档：[01 后端目录结构](./01-后端目录结构与DDD分层.md) · [03 调度中心](./03-Sandbox调度中心.md) · [05 鉴权流转](./05-Runtime鉴权流转.md) · [13 数据库设计](./13-后端数据库设计.md)

## 1. 设计目标

sandbox、runtime、镜像三层都可由用户注册自己的实现；平台在 `packages/contracts/` 集中维护一套**框架无关**的 contract（纯 TS，不依赖 NestJS）。

三条贯穿全文的取舍（细则见 §2.0）：

1. **暴露面尽可能小**——第三方要实现的东西越少，实现之间就越难跑偏；能派生的平台自己派生。
2. **契约与具体 sandbox 实现无关**——同一份 contract 必须能被容器与 micro-VM 两种形态同时满足（§2.1 的 `aio` / `boxlite` 就是这条的活体检验）。
3. **版本管理不自研**——契约抽成独立 npm 子包，semver / 兼容范围解析 / 升级提示全交给包管理器（§9）。

```
packages/contracts/                 # 现名 @platform/contracts（private）；→ 发布为 @platform/sandbox-contracts（⏳ §9）
├── src/
│   ├── sandbox-provider.contract.ts
│   ├── runtime-adapter.contract.ts
│   ├── image-spec.contract.ts     # ⏳ 未实现，随镜像管理切片落地
│   ├── errors.ts                  # 统一错误模型（§4）
│   ├── registry.tokens.ts
│   └── testkit/                   # 契约一致性套件（§10），子路径导出 /testkit
├── CHANGELOG.md                   # ⏳ changesets 尚未接入（§9）
└── package.json                   # version 即契约版本
```

## 2. SandboxProvider contract

### 2.0 三条硬约束（决定这份 contract 长什么样）

1. **最小暴露面**：第三方只需实现 **6 个必须方法**。凡是"平台没有一条分支逻辑依赖它"的东西，一律不进 contract；能由已有原语派生的，平台自己派生，不让每个实现重写一遍。
2. **实现无关**：contract 里不出现任何具体运行时的词汇（container / micro-VM / docker exec / 8 字节流头 / Pod）。解复用、句柄格式、会话保活方式等全部由实现内部消化，对平台只暴露语义。
3. **双实现验证**：任何新增方法或字段，必须能被 `aio` 与 `boxlite` 两个内建实现**同时**自然满足；只有一方能满足的，就是实现细节而不是契约，应该退回 capabilities 或实现内部。

### 2.1 内建 sandbox 方案（registry key）

平台内建两个 SandboxProvider 实现，覆盖"够用"与"隔离强"两端：

| key | 方案 | 形态 | 隔离强度 | 为什么选它 |
|---|---|---|---|---|
| **`aio`**（默认） | [AIO Sandbox](https://github.com/agent-infra/sandbox)（agent-infra） | 单个 OCI 容器镜像，内置 shell / 文件系统 / 浏览器 / VSCode Server / 预置 MCP server，统一端口暴露 HTTP API | 容器级（namespace + cgroup） | 开箱即用的 agent 工作环境，省掉自己拼镜像与装 CLI 依赖；自带 MCP 面，与本平台 02 的 MCP 协议面同构；社区维护，镜像随上游更新 |
| **`boxlite`** | [BoxLite](https://github.com/boxlite-ai/boxlite) micro-VM | Rust 库**进程内嵌**调用（无 daemon、无 root），OCI 兼容，可直接跑同一份 AIO 镜像 | micro-VM 级（每个 Box 独立 Linux 内核，硬件辅助隔离） | 隔离强度高于容器，跑不可信 agent 更稳；亚秒级启动；Box 是**有状态**工作区，天然支撑 03 §4 的"stopped → starting 复用已分配卷"；macOS / Linux(KVM) / WSL2 都能跑，本地开发与部署同构 |

**关键前提**：两个方案都以 **OCI 镜像**为交付单元，所以 §7 的 ImageSpec 契约在两侧完全一致——同一份 AIO 镜像既能被 `aio` 当容器起，也能被 `boxlite` 塞进 micro-VM 跑。这是这两个方案能共用一套 contract 的根本原因，也是新增第三个方案时的准入条件。

> 隔离强度的进一步演进（gVisor / Firecracker 等，见文档 11 §5）不需要改 contract：`boxlite` 已经把"contract 能不能容纳非容器实现"这件事验证过一遍了。

> **★ S5 技术验证 · 纠错重写（2026-08）：经平台真实执行通道实测的两侧事实——原差异表已被推翻**
>
> ⚠️ **本节此前那张差异表（`aio` = `uid=0` root / `CapEff=a80425fb` / `$HOME=/root` / npm prefix `/opt/nodejs/22`，`boxlite` = `uid=1000` gem / `/home/gem`）以及由它推出的"两 provider 身份/能力不同"这个前提，已被推翻并删除，不要再引用。**
>
> **错在哪：验证走错了通道。**那批数据是用 `docker run --entrypoint bash` 直接进容器量的——那条路径进去确实是 `root`、`HOME=/root`；但**平台从不走那条路**：平台的 `spawn` 走 **in-sandbox API 的 HTTP exec 端点**（当时是 `/v1/shell/exec`，现已切到 `/v1/bash/exec`——见 §2.3★；身份结论不受端点切换影响）（§2.2 映射表、[SANDBOX-RUNTIME-DECISIONS](../SANDBOX-RUNTIME-DECISIONS.md)），而**该 agent 以非 root 用户 `gem` 运行**。代码侧其实早有旁证：`api/packages/modules/sandbox/src/infrastructure/workspace/workspace-preparer.ts` 的类注释写着 *"the in-sandbox agent runs as the NON-root user `gem`"*（⚠️ 这是**代码原文的逐字引用**，其中的 `agent` 指沙箱内 API——00 §0 的改名不适用于引文，改了引文就等于把一句代码里不存在的话归给代码），工作区 0755 会 `Permission denied`、只能放到 0777。
>
> **用平台真实通道重测（真 `AioSandboxProvider.spawn`，同一镜像 `agent-infra/sandbox:latest`，只换 provider）——两侧一致，不存在"身份不同"**：
>
> | 维度（一律经平台 `spawn` 通道实测） | `aio`（docker 容器） | `boxlite`（microVM） |
> |---|---|---|
> | 运行身份 | `gem`（agent 的运行用户；HOME/prefix 与右列一致佐证） | `uid=1000` gem |
> | `$HOME` | `/home/gem` | `/home/gem` |
> | npm prefix（`npm config get prefix`） | `/home/gem/.npm-global` | `/home/gem/.npm-global` |
> | `PATH` | 两侧**相同**，且含用户级 prefix：`/opt/gem/bin:/home/gem/.fnm_shell/bin:/opt/nodejs/22/bin:…:/home/gem/.npm-global/bin:/home/gem/.local/bin:…` | 同左 |
> | `command -v codex` | `/home/gem/.fnm_shell/bin/codex`（**fnm shim**，不是 `/opt/nodejs/22/bin/codex`） | 同左 |
>
> **⛔ 方法论教训（本次纠错真正的产出，比表格本身更值钱）：平台行为必须用平台自己的执行路径验证。**`docker run` / `docker exec` 进容器测出来的身份、HOME、PATH，**不代表平台看到的身份**——同一个容器，宿主直连是一条路径，in-sandbox API 是另一条，用户与环境都不同。凡是要写进契约条款的"运行时事实"，必须经 `provider.spawn()` 取得；用别的通道量出来的数字一律不作数、不写进文档。
>
> **仍然成立的三条条款（结论不变，理由已按新事实改写）**：
>
> 1. **凭证物化按运行时 `$HOME` 展开、不硬编码**——真实通道下 `HOME=/home/gem`，**硬编码 `/root` 必错**（05 §4、05 §1★★）；§7 的镜像约定只承诺"HOME 可写"，从不承诺 HOME 是哪个路径。
> 2. **`isInstalled` 必须走 `command -v` / PATH 查找**——理由**已更正**：不再是"两侧 npm prefix 不同"（实测**相同**），而是 ① prefix 是**用户级非标准位置** `/home/gem/.npm-global`，② `codex` 实际解析到 **fnm shim** `/home/gem/.fnm_shell/bin/codex` 而非 npm prefix 下的路径 ⇒ **硬编码任何具体路径都会错**（§3 `isInstalled` 行、§10.3 RA-01）。**正面证据（已实测，不再是推理）**：往 `$(npm config get prefix)/bin` 放一个可执行文件后，**新起一次 exec 跑 `command -v` 能找到它**（`/home/gem/.npm-global/bin/probecli`）——PATH 查找这条路在平台真实通道上是通的。
> 3. **install-on-start 在两侧都成立**——两侧都以非 root 的 `gem` 跑，但用户级 npm prefix 把 CLI 装进 `$HOME`，**不需要 root**（§3 ★1）。
>
> **真正的 provider 差异在别处**：`boxlite` 是 microVM、每个 Box 有**独立 Linux 内核**（硬件辅助隔离），`aio` 是共享宿主内核的容器——这条由上面的方案表承载，不依赖任何沙箱内身份。**⏳ 其余维度（`CapEff`、免密 sudo 是否可用、seccomp 档位等）此前的数值全部取自 `docker run` 通道、未经平台通道复核，已从本表删除；需要时用 `spawn` 通道重测后再写回。**

### 2.2 必须实现的 6 个方法（每个方法平台拿它干什么）

```typescript
interface SandboxProvider {
  readonly name: string;                       // registry key: 'aio' | 'boxlite' | <自定义>
  readonly capabilities: SandboxProviderCapabilities;   // §2.5

  create(ctx: SandboxProviderContext): Promise<SandboxHandle>;
  start(handle: SandboxHandle): Promise<void>;
  stop(handle: SandboxHandle, opts?: { timeoutSec?: number }): Promise<void>;
  destroy(handle: SandboxHandle): Promise<void>;
  inspect(handle: SandboxHandle): Promise<SandboxRuntimeStatus>;
  spawn(handle: SandboxHandle, spec: ProcessSpec): Promise<ProcessStream>;

  // 可选：capabilities 对应位为 true 时才必须实现（§5 列出平台如何降级）
  updateResources?(handle: SandboxHandle, quota: ResourceQuota): Promise<void>;
  watchEvents?(): AsyncIterable<ProviderEvent>;                  // §6

  // 可选「面」（成组，§2.6）：一位 headlessTask 同时管住两者，由 §10 CAP-02 双向钉死
  readonly jobs?: SandboxJobs;      // 作业面：无头 Task 的执行与流式读回
  readonly files?: SandboxFiles;    // 文件面：产物回传与文件写入
}
```

| 方法 | 平台拿它干什么（唯一用途，不做别的） | 谁在什么时候调 | 必须遵守的语义 |
|---|---|---|---|
| `create` | 把一次**已完成配额登记**的调度决策物化成实体，并换回平台后续只认的句柄 | `SandboxApplicationService` 创建流程，在互斥区**之外**（03 §3）；状态 `scheduling→creating` | 只创建不启动（平台要分两步落库）；失败必须抛 §4 的错误码，平台据此回滚配额登记 |
| `start` | 让实体进入"可接受 `spawn`"的状态 | `creating→starting`；以及 `stopped→starting` 重新拉起（03 §4） | 对已运行实体必须**幂等成功**，不得抛 `ALREADY_EXISTS` |
| `stop` | 释放算力但**保留工作区数据**，使后续 `start` 能复用 | Reaper idle 回收、用户手动 stop（03 §4） | 超过 `timeoutSec` 转强制终止；停止后工作区必须仍可见，否则 `volumeMount` 能力位必须声明 `false` |
| `destroy` | 终态清理，连数据一并回收 | `destroying→destroyed`；对账清理野实例（13 §4） | **幂等**：对已销毁或根本不存在的句柄调用必须静默成功 |
| `inspect` | 平台**唯一**的外部真相来源：状态机纠偏、启动/增量对账、健康判定全靠它 | 轮询模式 10s / 60s 分频（§5）、事件流重连补偿（§6）、`onApplicationBootstrap` 全量对账（13 §4） | 实体查无时返回 `lifecycleState: 'instance_missing'`，**不要抛 `NOT_FOUND`**——对账必须能区分"确认不存在"与"查不动"（后者才抛 `PROVIDER_UNAVAILABLE`） |
| `spawn` | **唯一**的"在 sandbox 里跑东西"原语：终端会话、runtime 安装与探测、凭证物化、鉴权登录，全部走它 | terminal 网关（06）、RuntimeAdapter 全部方法（§3）、`CredentialVault.materialize`（05 §4） | 交出的输出必须是**已解复用的干净字节流**；流头/多路复用/tty 合并 stderr 是实现内部的事，平台不做任何解码 |

**两个内建实现的映射**（第三方实现可对照）：

| 方法 | `aio` 实现 | `boxlite` 实现 |
|---|---|---|
| create / start / stop / destroy | OCI 容器 create/start/stop/rm（经 socket proxy，文档 11 §1） | BoxLite 库调用创建/启动/停止/销毁 Box |
| inspect | 容器 inspect + 健康探针 | Box 状态查询 |
| spawn(tty=false) | 经 in-sandbox API `POST /v1/bash/exec`（收集输出到 EOF）——**选它而不是 `/v1/shell/exec`，是因为后者不支持 `env`/stdin/signal**（§2.3★） | 同左（Box 内 `:8080`，端口转发） |
| spawn(tty=true) | 经 in-sandbox API `ws /v1/shell/ws`，翻译成 `ProcessStream` | 同左（Box 内 `:8080`，端口转发） |
| watchEvents | ✅ 原生事件流 | ✅ 库回调包装成同一 `AsyncIterable` |
| `jobs`（§2.6） | ✅ 已实现（S6）：`POST /v1/bash/sessions/create` → `POST /v1/bash/exec async_mode` → `POST /v1/bash/output`（游标读 + 长轮询）；`ws /v1/bash/ws` 只做**唤醒**、不取字节（理由见 §2.6 ★★ 下的实现注记） | 同左（共用同一个 data-plane 客户端） |
| `files`（§2.6） | ✅ 已实现（S6）：`GET /v1/file/download`·`POST /v1/file/write`·`POST /v1/file/list` | 同左 |

> **boxlite 那两个"同左"的依据**：boxlite 跑的是**同一张镜像** `agent-infra/sandbox:latest`，复用**同一个** `AioSandboxAgentClient`，只是 guest `:8080` 转发到宿主 loopback 端口 ⇒ 端点集合相同是结构性成立。**文件面已在真 micro-VM 上单独实测（2026-08）**：文本往返 ✅；二进制 260B **逐字节一致**、`application/octet-stream` ✅；`list` 返回结构与 aio 一致（`modified_time` 同样是字符串装的 epoch 秒）✅；**8MB 下载 12ms**（aio 是 36ms）✅；**宿主写入到 guest 可见 3ms** ✅；缺文件的两套错误约定与 aio **完全一致**（download 回 404、read 回 `success:false` + `error_type:"not_found"`）✅。⇒ 跨 virtio-fs 没有观察到额外的传播代价。

> **数据面 = 沙箱内 API（权威：[SANDBOX-RUNTIME-DECISIONS](../SANDBOX-RUNTIME-DECISIONS.md)）**：aio/boxlite 的 `spawn` 由 **AIO Sandbox 自带的 in-sandbox API**（`:8080`——`/v1/shell/ws` 交互终端、`/v1/bash/exec` 一次性命令；**命令面选 `/v1/bash/exec` 而非 `/v1/shell/exec`，因为后者不支持 `env`/stdin/signal**，实测能力面见 §2.3★）支撑，AIO 协议 ↔ 中立 `ProcessStream` 的翻译在 **provider 内**完成——**不是宿主 `docker exec`**（后者仅作无内置 agent 裸镜像的 `DockerExecAgentClient` fallback）。控制面：aio=dockerode、boxlite=BoxLite SDK。agent 端口**⚠️ 实现上 publish 到宿主 loopback（`127.0.0.1` + 临时端口）**（原文"仅内网可达、不外泄"与实现不符，已按实现更正）+ 就绪探测；宿主本地任意进程可直连该无鉴权 shell，⏳ 待 Step 4 加固——登记见该 ADR「安全姿态」。该选型的两档实测验证与工程注记（含 BoxLite 本地 registry 预置镜像）见该 ADR。
>
> **术语**：本节的 "沙箱内 API" 指镜像自带的那个 HTTP 服务（①），**不是** `codex`/`claude` 那个 agent（②）——两者的区分与判据见 [00 §0](../00-总体架构概览.md)。
>
> **⚠️ 别把镜像认错（2026-08 实测）**：平台默认的 AIO 镜像是 `agent-infra/sandbox:latest`，拉 `GET /v1/openapi.json` 得 **123 个端点**；而 `cap-aio-sandbox:v0.37.1` 只有 **34 个、且完全没有 `/v1/bash` 家族**。拿后者去量能力面会得出"agent 不支持异步执行"的错误结论——这与 §2.1★（拿 `docker run` 量身份）、§2.3★（拿 `/v1/shell/exec` 量能力上限）是**同一类错的第三次**，纪律见 §2.3★ 的方法论教训。

### 2.3 为什么把 `exec` / `attachPty` / `healthCheck` 从必须方法里删掉

这三个是上一版的必须方法，本版移除——直接对应"暴露给用户定义的越少越好"：

- **`exec` = `spawn({ tty:false })` + 收集输出到 EOF**。平台在 contract 之上提供 `toExecFn(provider, handle): SandboxExecFn` 便利封装（即 §3 各方法收的那个 `SandboxExecFn`），实现方不用再写第二遍。
- **`attachPty` = `spawn({ tty:true })`**。两者只差一个 flag，拆成两个方法会让每个实现写两套几乎一样的进程创建代码，且极易出现"exec 支持 `env`/`cwd` 但 pty 不支持"这类实现间不一致——正是"无视各自实现保持统一"要防的。
- **`healthCheck` 与 `inspect().health` 完全重复**（上一版两者都返回 `HealthStatus`），两个入口迟早给出两种答案。删掉方法，健康状态作为 `inspect` 的可选字段返回，平台只在一个地方读。

结果：第三方需要实现的必须方法从 **9 个降到 6 个**，可选方法 2 个。

> 与文档 06 的衔接：06 §3 的 `PtyStream` 就是 `spawn({tty:true})` 返回的 `ProcessStream`，**不再单独定义**——以本节为准，06 只保留实现对照表。

> **★ S5 技术验证 · 二次纠错（2026-08）：`ProcessSpec` 的能力已基本兑现——此前判定"agent 做不到"，错在【我们一直在调一个能力最弱的端点】**
>
> **头条不是"补齐了实现"，而是"我们一直在敲错门"。**本节上一版写的是：`stdin` / `env` / `cwd` / `timeoutMs` / `kill()` **五项全被静默丢弃**、`⏳ S5 待补齐`，并把原因归给"沙箱内 API 侧没有对应能力"。**这个前提是错的。**起真镜像（`localhost:5001/agent-infra/sandbox:latest`）拉 `GET /v1/openapi.json`（⚠️ **只有这一个路径拿得到**——`/openapi.json` 与 `/docs` 都 404）后发现：agent 暴露的是 **~120 个端点**，而我们从头到尾只用了其中**能力最弱的那一个**——`POST /v1/shell/exec`。换一个端点，五项里四项是**原生透传**，剩下一项（stdin）用一次文件重定向合成即可。
>
> **⛔ 方法论教训（本次真正的产出；与 §2.1★ 的"验证走错通道"是同一类错，这已经是第二次）：把一条限制写进设计之前，先探明依赖方 API 的真实能力面。**两次踩的是同一个坑——**用错入口，然后把这个入口的边界当成对方的能力上限**：§2.1★ 是"拿 `docker run` 量出来的身份当成平台看到的身份"，本节是"拿 `/v1/shell/exec` 量出来的能力当成 agent 的能力上限"。落成纪律：**写"依赖方做不到 XX"之前，必须先把对方的端点/参数清单拉全**（openapi / `--help` / 源码，任选但要拉全），并在文档里注明**探过哪些入口**；只试过一条路就下的否定结论，不许写进契约。
>
> **沙箱内 API 端点能力面（实测真镜像，2026-08）**：
>
> | 端点 | body 实际支持的字段 | 实测结论 |
> |---|---|---|
> | `POST /v1/shell/exec`（**旧；平台已不再使用**，沙箱内 API 侧仍在） | 仅 `command` / `exec_dir` / `timeout` / `hard_timeout` | **没有 `env`**（传了被静默吞：`{command:'echo E=$PROBE', env:{PROBE:'x'}}` ⇒ `E=`）、没有 stdin、没有 signal ⇒ 上一版"五项全 ✗"量的其实是**这一个端点**的边界 |
> | `POST /v1/bash/exec`（**现用**） | `session_id` / `command` / `exec_dir` / **`env`** / `async_mode` / `timeout` / **`hard_timeout`** / `max_output_length` | 全部**原生生效**；返回 **stdout / stderr 分离 + `exit_code` + `command_id`** |
> | `POST /v1/bash/kill` | `session_id` + `signal`（`SIGTERM`/`SIGKILL`/`SIGINT`，只此三种） | **真实信号投递**：`sleep 60` 被杀回 `exit_code:-15`，且**在飞的同步 exec 请求立刻解阻塞** |
> | `POST /v1/file/write` | `file` / `content` / `encoding` / `append` | 内容走 **HTTP body**——不经过命令行 |
> | `POST /v1/bash/write` | `session_id` / `command_id` / `input` | 能往 stdin 写字节，**但发不出 EOF**（`\x04`、空串都只当普通字节——该 stdin 是 socket 不是 tty）⇒ **没有采用**，理由见下 |
> | `ws /v1/shell/ws` | 上行 `input` / `resize`；下行 `output` / `ping` / `session_id` / `ready` | 交互终端；**不提供任何进程管理接口**，见下 |
>
> **现在的能力表**（真 `AioSandboxProvider.spawn` 实测；`aio` 与 `boxlite` **共用同一个 data-plane 客户端**，故两侧同表现）：
>
> | `ProcessSpec` / `ProcessStream` 能力 | 现状 | 怎么做到的 |
> |---|---|---|
> | `cmd` | ✓ | argv 逐元素 POSIX 引用后拼成 shell 串（中立契约收 argv，agent 跑 shell 字符串） |
> | `cwd` | ✓ | **原生透传** → `exec_dir` |
> | `env` | ✓ | **原生透传** → `env`，**逐字、客户端零转义**（agent 自己物化，注入面见下） |
> | `timeoutMs` | ✓ | **原生透传** → `hard_timeout`（秒）——**agent 在沙箱内真杀**；客户端另有 `timeoutMs + 5s` 的 `AbortController`，**仅作传输层兜底**。超时统一上报 **`exit=124`**（对齐 03 §8.3 既有的 codex 口径，而不是 agent 内部的 `-1`） |
> | `stdin`（`tty:false`） | ✓ | **唯一需要合成的一项**：`mkdir -m 700 -- /tmp/.platform-stdin-<128bit hex>`（**不带 `-p`**——原子、路径已存在即失败，防抢占）→ `POST /v1/file/write` 把明文放进 **HTTP body** → 命令包成 `__platform_rc=0; <argv> < '<file>' \|\| __platform_rc=$?; rm -rf -- '<dir>'; ( exit $__platform_rc )`。⇒ **命令行里只有路径、没有内容**，且**保留原始退出码**；`finally` 再补一次**不带 abort** 的 `rm -rf`（kill 路径下 in-command 的 `rm` 根本没机会跑）并关掉沙箱内 API 的那个 session（否则 session 会在沙箱内 API 侧累积） |
> | `kill()`（`tty:false`） | ✓ **真杀** | `session_id` 改为**客户端生成、请求发出前就持有**（它就是 kill 句柄，否则命令跑完之前无处可杀）→ `POST /v1/bash/kill`。默认两阶段：`SIGTERM` → **5s 宽限** → `SIGKILL`；显式传 signal 则按传的投递（非三种之一降级为 `SIGTERM`）。**只有 沙箱内 API 不可达时**才退回 abort fetch（03 §8.3） |
> | `kill()`（`tty:true`） | ⚠️ 真 SIGINT + **尽力而为** | 见下"仍然存在的限制" |
> | `user` | ✗ **显式抛错** | agent 无任何用户切换参数 ⇒ 抛 `UNSUPPORTED_CAPABILITY`（§4），**不再静默丢弃** |
> | `command -v` / PATH 查找 | ✓ | §2.1★ 条款 2 的正面证据 |
>
> **三条决定了实现形态的关键实测**：
>
> 1. **`hard_timeout` 是真杀，不是 HTTP 超时**：`sleep 30` + `hard_timeout:2` ⇒ **2.0s** 返回 `status:timed_out`，且沙箱内 `pgrep` **查不到残留**。这是"平台侧到点强制 kill"（§3 ★3、03 §8.3）今天真正的底座。
> 2. **`env` 会进 argv ⇒ 它不是密钥通道**：agent 把 `env` 物化成 `export K=V` 拼进 `bash -c '<script>'`。注入测试（值传 `'; touch /tmp/PWNED; echo '`）**没有逃逸**（沙箱内 API 侧引用正确），但沙箱内 `ps -eo args` **能看到 env 的值**。同理 **`command` 本身在 `ps` / `/proc/<pid>/cmdline` 里全文可见** ⇒ **"用 heredoc 把密钥塞进命令串"的方案已否决**（会直接违反 05 §7 #3 / RA-14）。密钥只能走 HTTP body（`/v1/file/write`）或沙箱创建时的 `SandboxProviderContext.env`。
> 3. **ws PTY 没有进程管理**：ws 的 `session_id` 与 `/v1/shell/sessions` 是**两套命名空间**——`POST /v1/shell/kill`、`DELETE /v1/shell/sessions/{id}` 对 ws 的 session_id 一律回 `Session not found`；而且**单纯关 ws 不杀任何东西**（前台 `sleep 444` 与 `/bin/bash -i` 在关闭 8s 后仍在 ⇒ **每断一次终端就泄漏一个 shell**）。但**写 ETX（0x03）真的经 tty 行规程给前台进程组投递了 SIGINT**，再写 `exit\n` 能让 `bash -i` 退出。
>
> **仍然存在的限制（据实登记，不要读成"全好了"）**：
>
> - **`ProcessSpec.user` 不支持** —— agent API 里没有这个参数。现在是**显式抛 `UNSUPPORTED_CAPABILITY`**（比静默丢弃好，但能力本身仍然没有）。要切用户只能改镜像/入口。
> - **`tty:true` 的 `kill()` 是尽力而为** —— 先 ETX（真 SIGINT）、再 `exit\n`（顺带修掉"每断线泄漏一个 `bash -i`"）、最后关 socket。**忽略 SIGINT 的进程仍可能存活**；**唯一有保证的兜底是 `SandboxProvider.destroy()` / `stop()`**（整个实例连同里面的进程一起没）。所以 03 §8.3 的"连带 destroy 实例"不是可选项。
> - **`tty:true` 一侧 `spec.cmd` 仍然没传进去（⏳ 未解决）** —— provider 调的是 `client.openTerminal(cols, rows)`，终端固定起 agent 的默认 shell；**adapter 的 `buildAttachCommand()` 至今无处落地**（§3 契约里有、06 §3 与 P20 §3 的链路指望它）。这条**不在本次修复范围内**，随终端切片解决。
> - **没有用 `/v1/bash/write` 做 stdin** —— 它写得进字节但**发不出 EOF**，`codex login --with-access-token` 这类"读到 EOF 才动作"的命令会**挂死**。所以 stdin 走文件重定向（`< file` 有真 fd 0、有真 EOF），而不是这条上行通道。
> - **`env` / `command` 在沙箱内的 `ps` 可见** —— 见上第 2 条。**per-call `env` 不是密钥通道**，这条不随本次修复改变。
>
> **曾经的根因（保留：这是怎么错的）与现状**：
>
> - **曾经**：`api/packages/modules/sandbox/src/infrastructure/providers/aio/aio-sandbox-agent.client.ts` 的 `exec(spec)` **只用 `spec.cmd`**——argv 逐个 shell-quote 拼成一串，`POST /v1/shell/exec { command }`，`env` / `cwd` / `user` / `timeoutMs` / `reuse` **从不读取**；`AioExecProcessStream.kill()` 只把本地 promise settle 掉，**不向远端发任何信号**。
> - **现状**：同一个文件已整体切到 `POST /v1/bash/exec` + `/v1/bash/kill` + `/v1/file/write`，映射与合成见上表；`user` 改为显式抛错。**`tty:true` 一侧的 `spec.cmd` 未传入这条仍然成立**（见上）。
> - **为什么当时没发现**：因为 `/v1/shell/exec` **能跑通命令**——它只是把其余字段静默吞掉，表现为"命令确实跑了、语义没生效"。**能跑通 ≠ 能力到顶**，这正是上面那条方法论教训的具体形态。
>
> **对设计的约束（已按修复后的事实更新）**：
>
> - **凭证注入可以依赖 `stdin` 了** —— 05 §1★★ 把 `--with-access-token`（stdin）档降级的**第二重理由（"这条通道会静默丢 stdin"）已不成立并撤销**；**第一重理由（CLI 版本敏感，实测 0.147.0 产的 token 喂 0.139.0 直接被拒）仍然成立**，该档因此**仍是可选 / 版本敏感档**，默认档不变。
> - **api-key 形态的 env 注入仍落在沙箱创建时**（`SandboxProviderContext.env`，§2.4）—— 理由**已更换**：不再是"per-call `env` 会被丢弃"（现在生效了），而是 **per-call `env` 会进 argv、沙箱内 `ps` 可见**（上文第 2 条）。
> - **"到点强制 kill"现在有底座了** —— `timeoutMs`→`hard_timeout` 真杀 + `ProcessStream.kill()` 真信号（03 §8.3 已按此改写）。**但交互式终端那一侧仍只是尽力而为**，兜底仍是 `destroy()`。
>
> **验证与仍缺的条款**：
>
> - **已有 e2e**：`apps/api/test/e2e/aio-exec-capabilities.e2e-spec.ts`（真镜像，10 例全过），含 `env`/`cwd`/`stdin`/`hard_timeout`/两阶段 kill/`user` 抛错，以及**"密钥不出现在沙箱内 `ps` 与 `/proc/*/cmdline`"**——该用例带**防空断言的反向 sanity**（先证明探针能抓到故意泄漏的值，再断言真实路径抓不到），避免"探针本身失效"造成的假绿。
> - **⏳ 建议补条款（上一版提出的这条仍然有效，只是不再是"实现欠账"而是"契约欠账"）**：§10.2 现有 SP-\* 里**没有一条**钉住 `env` / `cwd` / `stdin` / 超时 / 远端 kill。实现侧已有上面那套 e2e，但那是**平台自测**，第三方实现复用不到；这些语义要进 testkit 才算对所有 provider 生效。补条款时注意它们都需要真宿主，属 live 条款（§10.2 的分档规则）。

### 2.4 支撑类型（附字段用途）

```typescript
/** 平台交给实现的全部输入；实现不得从别处读取平台状态 */
interface SandboxProviderContext {
  sandboxId: string;               // 平台 id。仅供实现打 label / 命名，不得当作句柄回传
  quota: ResourceQuota;            // 调度器已登记，实现只负责把限额施加到运行时
  image: ResolvedImageSpec;        // 已 resolve + validate 过（§7），实现不再重复校验
  env: Record<string, string>;
  volumes?: VolumeMount[];         // capabilities.volumeMount=false 时平台不会传。
                                   // 平台保证 create() 被调用时挂载源【已存在】（03 §4 状态序列：preparing-workspace 先于 creating）
  labels?: Record<string, string>; // 平台强制注入 platform.managed=true —— 对账靠它识别野实例（13 §4）
}

/** 不透明句柄：平台只做存取、落库（sandboxes.provider_handle）与相等比较，禁止解析内容 */
interface SandboxHandle {
  readonly provider: string;           // 必须等于 provider.name，registry 路由靠它
  readonly providerSandboxId: string;  // 容器 id / Box id / 任意实现自定义标识
}

/** 中立措辞：instance = 容器或 micro-VM。与平台状态机（03 §4）的 12 个状态是两套东西 */
type SandboxRuntimeLifecycleState =
  | 'instance_creating' | 'instance_running' | 'instance_paused'
  | 'instance_exited'   | 'instance_dead'    | 'instance_missing';

interface SandboxRuntimeStatus {
  lifecycleState: SandboxRuntimeLifecycleState;  // 状态机纠偏与对账的判定依据
  exitCode?: number;
  startedAt?: string;            // ISO
  finishedAt?: string;
  resourceUsage?: { cpuPercent: number; ramUsedMb: number };  // 拿得到就填，用于展示与容量校准
  health?: HealthStatus;         // 取代已删除的 healthCheck()
  raw?: unknown;                 // 实现原始输出。**仅允许打日志**，平台任何分支逻辑不得读取其字段
}

type HealthState = 'healthy' | 'unhealthy' | 'unknown' | 'starting';
interface HealthStatus {
  state: HealthState;
  lastCheckedAt: string;
  message?: string;
  consecutiveFailures: number;   // 平台据此决定"抖动"还是"真挂了"
}

/** 唯一的进程创建入参：一次性命令与交互式会话只差 tty 一个 flag */
interface ProcessSpec {
  cmd: string[];
  tty: boolean;                  // true=交互式（终端会话 / 鉴权登录）；false=一次性命令
  cols?: number; rows?: number;  // tty=true 时必填
  env?: Record<string, string>;
  cwd?: string;
  user?: string;
  timeoutMs?: number;            // 仅 tty=false 生效；超时由实现负责 kill
  reuse?: string;                // 传入已有会话标识则复用而非新建（断线重连，06 §6）
}

interface ProcessStream {
  readonly ref: string;          // 会话标识，落库 terminal_sessions.exec_id；reuse 传的就是它
  onData(cb: (chunk: Buffer) => void): void;        // 已解复用的干净字节流
  write(data: string | Buffer): void;               // tty=true 时即 stdin
  resize(cols: number, rows: number): void;         // tty=false 时为 no-op
  onExit(cb: (code: number | null) => void): void;  // null = 被信号终止 / 会话 detach
  kill(signal?: NodeJS.Signals): Promise<void>;
}

interface VolumeMount {
  source: string;                // 由平台决定的来源标识；host-path 时是宿主绝对路径（03 §7.1）
  target: string;                // 实体内挂载点
  mode: 'ro' | 'rw';
  kind: 'host-path' | 'persistent' | 'ephemeral';   // 中立措辞（审计 M-2）：不含具体运行时词汇
}
```

### 2.5 Capabilities（准入规则：一个能力位必须对应一条平台分支）

**加位规则**：只有当"平台存在一条明确的分支逻辑，会因为它 true/false 而走不同的路"时，才配拥有一个能力位。否则不加——想加时按 minor 版本追加即可（§9），漏加的代价远小于一堆没人读的布尔。据此把上一版的 10 位裁到 6 位；S6 因无头 Task 增一位，现为 **7 位**（加位仍走同一条准入规则，见下）。

```typescript
interface SandboxProviderCapabilities {
  spawnTty: boolean;         // spawn({tty:true}) 是否可用
  volumeMount: boolean;      // 是否支持持久工作区
  updateResources: boolean;  // 是否支持不重建改配额
  pauseResume: boolean;      // 是否支持暂停/恢复
  snapshot: boolean;         // 是否支持 checkpoint
  watchEvents: boolean;      // 是否支持事件订阅
  headlessTask: boolean;     // 是否同时具备作业面 jobs 与文件面 files（§2.6）
}
```

| 能力位 | 平台对应的分支（§5 详列） | `aio` | `boxlite` | 分支落地状态 |
|---|---|---|---|---|
| `spawnTty` | false → 终端页与 runtime 鉴权入口整体不可用，创建时即拒绝需要 TTY 的 runtime | ✅ | ✅ | ✅ 已实现（`SandboxApplicationService.assertCapabilities`：`spawnTty=false` 的 provider 在**进调度前**拒绝创建，`UNSUPPORTED_CAPABILITY` → 409） |
| `volumeMount` | false → `stopped → starting` 不承诺数据保留，Reaper 的 idle 回收降级为直接 destroy（03 §4） | ✅ | ✅（Box 有状态） | ⏳ 分支随 **Reaper idle 回收切片**落地（当前平台只有 `idleTimeoutSec` 字段，无 idle 回收调度器，无处可挂分支）；能力位已经 `GET /api/providers` 下发，且可被创建请求的 `require.volumeMount` 静态校验 |
| `updateResources` | false → 扩缩容转 "stop + 重建" | ✅ | 视版本 | ⏳ 分支随 **扩缩容端点切片**落地（当前 controller 只有 POST/GET/GET:id/DELETE:id，没有改配额入口）；能力位已下发 + 可被 `require.updateResources` 静态校验 |
| `pauseResume` | false → 前端不显示"暂停"按钮（经 `GET /providers` 下发） | ✅ | 视版本 | ✅ 已实现（后端半场：`GET /api/providers` 逐 provider 下发 6 位；前端据此显隐按钮） |
| `snapshot` | false → 显式要求 `requireSnapshot` 的创建请求直接拒绝，不进调度队列 | ❌ | ❌ | ✅ 已实现（`CreateSandbox.require.snapshot` → `assertCapabilities` 拒绝，不进调度、不落库、不调 `provider.create`） |
| `watchEvents` | false → `SandboxStatusObserver` 退化为轮询 `inspect()` | ✅ | ✅ | ⏳ 分支随 **SandboxStatusObserver 切片**落地（当前平台没有该组件：状态由 application 主动转移，无 push/poll 二选一的位置）；能力位已下发 |
| `headlessTask` | false → **无头 Task 发起即拒**（`UNSUPPORTED_CAPABILITY` → 409）。交互式 Task 完全不受影响——它走 `spawn`，不走作业面 | ✅ | ✅ | ✅ 已实现（S6）：准入分支落在 `assertCapabilities`，与两个面同切片（见下方排期约束）；两个内建 provider 均声明 `true` |

> **落地状态列的读法**：本节的准入规则是"一个能力位必须对应一条平台分支"。三条标 ⏳ 的分支所依赖的平台组件（idle 回收调度器 / 扩缩容端点 / StatusObserver）**今天不存在**，因此不为它们伪造分支——那只会把死契约换一种形式。它们保留能力位的理由是：位本身已通过 `GET /api/providers` 下发给调用方，且创建请求可用 `require.*` 对其做静态校验（§5 第一行），即"位有真实读者，只是降级分支等组件到位再接"。组件落地时，本列改为 ✅ 并补 testkit 用例。
>
> **`headlessTask` 与另外三条 ⏳ 的差别，要说清楚。** `volumeMount` / `updateResources` / `watchEvents` 保留能力位的理由里有一条是「可被创建请求的 `require.*` 静态校验」——**`headlessTask` 没有这一条，是刻意的**：它不进 `RequiredCapabilities`，理由与 `watchEvents` 不可请求同源——`headless: true` 已经**蕴含**了这一位，平台自己推导出该要求即可，不该让每个调用方再复述一遍。所以它今天的读者只有 `GET /api/providers` 的下发（前端据此判断"这个档位能不能跑无头任务"）。这比另外三位弱一档，如实记在这里。
>
> **为什么是一位而不是两位（作业面 / 文件面各一）。** 它们服务的是**同一条分支**：无头 Task 发起即拒。拆成两位就等于承认"能跑任务但取不回产物"是一种合法形态——那不是可交付的一半。而一个背后没有独立分支的位，正是本节准入规则要挡住的东西（删掉 `networkPolicy` / `gpuAllocation` 用的就是这条）。第三方 provider 只实现其一的假想场景，不足以支撑提前占坑。
>
> **⚠️ 一条排期约束（已按它执行，留档）**：S6 之前 `headless: true` 的沙箱**能创建成功**——provision 走到 `starting` 段第 ⑤ 步遇 `headless` 直接返回（03 §4.3 ⑤），于是沙箱起好、CLI 装好、凭证注好，只是没有 agent 会话。一旦按上表加了「`headlessTask=false` → 拒绝」的准入分支，而两个内建 provider 的两个面尚未实现，**现有的 headless 建沙箱路径会立刻变成 409**。因此准入分支与两个面**落在了同一个切片（S6）**，没有分两次。

**已删除的 4 位及理由**：`exec` / `attachPty` → 合并为必须方法 `spawn` 与 `spawnTty` 一位；`metricsStream` → 直接体现为 `inspect().resourceUsage` 有没有值，不需要单独声明；`networkPolicy` / `gpuAllocation` → 平台当前没有任何一条分支读它们，属于"提前占坑"。

**能力位不是自我描述而是承诺**：声明 `true` 就必须通过 testkit 里对应的用例（§10 的 CAP-01 条款），声明与实际不符视为不合格实现。对有面挂靠的 `headlessTask`，**位与面必须双向一致**（§10 的 **CAP-02** 条款）——声明 `true` 却没有面，应用层会调到 `undefined`；有面却声明 `false`，`GET /api/providers` 瞒报，而前端正是按这些位显隐控件的。两个方向都是真故障，不是洁癖。

### 2.6 作业面与文件面（无头 Task 的两个可选面）

#### ★ 为什么不是"再开一条流"

`spawn` / `ProcessStream` 是**连接**抽象：短命、活在平台进程的内存里、调用方必须一直等着。装 CLI、探 tmux、注凭证都是这个形状，对它们这是**对的**，不要动。

无头 Task 不是这个形状：

| 它需要什么 | 依据 |
|---|---|
| 一条命令跑几十分钟 | 硬超时档位 30min / 1h / 2h / 4h（P20 §0） |
| 平台重启不打断它 | 与 tmux 从 SHOULD 抬成 MUST 同源的理由（§7 ★） |
| 刷新 / 断线要能续上 | 前端恢复链路 |
| stdout 是必须与 stderr 分开的纯 JSONL | 2026-08 实测，见下 |
| 退出码就是任务落地态 | 2026-08 实测 `exit_code` |

这些都不是"再开一条流"能满足的——它要的是**作业**抽象：长命、有 ID、可事后重新查询。

**这个区分平台已经在交互侧解过一次**：tmux 抬成 MUST 的理由正是「会话由沙箱**自己的** tmux server 持有，所以重启后端不打断 agent」（§7 ★）。作业面是同一个道理的无头侧实例——持有者从 tmux server 换成沙箱内 API **自己的** command session。

#### ★★ 为什么不用 `spawn` 实现它、也不用它实现 `spawn`

两者职责**不重叠**：

```
spawn    = 我要一条「连接」，现在就要字节，我会一直等着
startJob = 我要一个「作业」，我这就走开，之后凭 ID 回来
```

把 `spawn({tty:false})` 改写成 start+poll，会给装 CLI 探测、tmux 自检这类**短命令**平白加两次 HTTP 往返，而同步端点本来就适合它们；反过来用 `spawn` 硬撑长任务，就要一直挂着 HTTP 连接，且拿不到可持久化的 ID。**加的是能力，不是第二条路。**

> 附带一个好处：`toExecFn` 那句「要分离 stdout/stderr 就自己在命令里重定向」的坑，**对无头 Task 自动失效**——它全走作业面，`toExecFn` 只剩短命令用，而短命令不在乎合流。这个坑本身仍在（以后谁写个需要分离的短命令还会踩），但不阻塞本切片，单独记账。

#### 契约

```typescript
interface JobSpec {
  cmd: string[];
  env?: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;   // 第一道，沙箱侧真 kill；平台侧强制 kill 仍是兜底（★3、03 §8.3）
  stdin?: string;       // 同 ProcessSpec.stdin：走 body，绝不进 argv（05 §7 #3）
}

interface JobHandle { readonly provider: string; readonly jobId: string; }
type JobCursor = string;                    // 不透明：只存只比，永不解析
type JobStatus = 'running' | 'exited';

interface JobChunk {
  stdout: string;            // 与 stderr 分离，理由见下表第 3 条
  stderr: string;
  cursor: JobCursor;
  status: JobStatus;
  exitCode?: number;         // 仅 exited 时有意义，且【可能缺席】（被信号杀掉没有退出码）
}

interface SandboxJobs {
  startJob(handle: SandboxHandle, spec: JobSpec): Promise<JobHandle>;
  readJob(handle: SandboxHandle, job: JobHandle,
          cursor?: JobCursor, opts?: { waitMs?: number }): Promise<JobChunk>;
  killJob(handle: SandboxHandle, job: JobHandle, signal?: NodeJS.Signals): Promise<void>;
  // ⚠️ 释放必须显式、且不能提前调：关掉沙箱侧 session 会【连输出一起销毁】（实测，见下）。
  //    killJob 刻意【不】释放——杀完之后要看的正是退出码和输出末尾。
  releaseJob(handle: SandboxHandle, job: JobHandle): Promise<void>;
}

// size 对目录【缺席】（agent 回 null）；modifiedAt 对外是 ISO，agent 给的是字符串装的 epoch 秒，由 provider 转换
interface FileEntry { path: string; kind: 'file' | 'dir'; size?: number; modifiedAt: string; }

interface SandboxFiles {
  readFile(handle: SandboxHandle, path: string): Promise<Buffer | null>;   // 缺文件回 null，不抛
  openFileStream(handle: SandboxHandle, path: string): Promise<NodeJS.ReadableStream | null>;
  writeFile(handle: SandboxHandle, path: string, content: string | Buffer): Promise<void>;
  listFiles(handle: SandboxHandle, path: string,
            opts?: { recursive?: boolean; maxEntries?: number }): Promise<FileEntry[]>;
}
```

#### 五条设计裁决

| # | 裁决 | 理由 |
|---|---|---|
| 1 | `JobHandle` 是**纯数据**，不是活对象 | 它必须能整个落库——"平台重启不丢正在跑的 Task"全押在这上面。与 `SandboxHandle` 同纪律：只存只比，永不解析 |
| 2 | `JobCursor` **不透明** | 字节偏移只是**某一个** provider 对"读到哪了"的编码，别的可能按行 / 按帧。露成数字就会有人在上面做算术，换 provider 即崩。调用方判断"有没有新数据"看 `stdout` / `stderr` 是否为空即可，根本不需要看游标本身 |
| 3 | stdout / stderr **分成两个字段** | **实测**：`codex exec --json` 的 stdout 是 **100% 纯净 JSONL（14/14 行可解析）**，全部 tracing 噪声走 stderr；两者一合流，同一次运行就变成 **14 可解析 + 8 行垃圾**，`parseOutput` 从"逐行 `JSON.parse`"退化成"写正则猜格式"——正是 §10 RA-04 列为脆弱性风险的那件事。`claude --output-format stream-json` 同样 **3/3 纯净** |
| 4 | `readJob` 带 `waitMs` **长轮询** | **实测**：沙箱内 API 侧原生支持等待语义。没有它只能忙轮询——一个跑 40 分钟、几秒才吐一个事件的任务，按 1s 轮询是约 2400 次空转 |
| 5 | 两个面**成组**，而不是平铺 7 个可选方法 | 让"三个方法要么全有要么全无"变成**结构性**约束：写不出"有 `startJob` 没 `readJob`"的 provider。与把 `InjectableRuntimeCredential` / `RefreshableRuntimeCredential` 拆开是同一条思路（05 §4） |

#### 沙箱内 API 侧的支撑（`agent-infra/sandbox:latest`，2026-08 实测）

| 契约方法 | 沙箱内 API 端点 | 实测结论 |
|---|---|---|
| `startJob` | `POST /v1/bash/exec` + `async_mode:true` | 命令跑 6 秒，**exec 39ms 返回**，回 `command_id` |
| `readJob` | `POST /v1/bash/output`（`session_id`·`command_id`·`offset`·`stderr_offset`·`wait`·`wait_timeout`） | 每轮精确返回增量；游标 `10→20→30` / `8→16→24` 单调推进；**stdout / stderr 真分离且各自独立游标** |
| — 终态 | 同上，嵌在 `data.command` 里 | 运行中 `status:"running"` · `exit_code:null`；结束 `status:"completed"` · `exit_code:7` |
| — 回放 | 同上，`offset=0` | 命令**结束后**仍可全量回放并拿到 `exit_code` ⇒ 刷新恢复 / 断线重连天然成立 |
| `killJob` | `POST /v1/bash/kill` | 平台已在用（§2.3★）。**async 作业上实测有效**：`SIGTERM` ⇒ `status:"completed"`·`exit_code:-15` |
| `releaseJob` | `POST /v1/bash/sessions/{id}/close` | ⚠️ **关 session 会连输出一起销毁**（实测：关后再读回 `Session <id> not found`，不是空 chunk）⇒ 释放必须在平台持久化完之后 |
| `readFile` / `openFileStream` | **`GET /v1/file/download?path=`**（`application/octet-stream`） | ⚠️ **不能挂 `POST /v1/file/read`**——那是纯文本端点，读二进制直接抛 `'utf-8' codec can't decode byte 0xa3`。download 通道 264 字节**逐字节一致**、8 MB **36ms** 取回。⚠️ 两端点**错误约定不同**：read 回 `HTTP 200 + success:false + error_type:"not_found"`，download 回 **404** —— provider 把两者都归一成 `null` |
| `writeFile` | `POST /v1/file/write` | 平台已在用（凭证注入，05 §4）。实测：**父目录不存在会自动创建**、`encoding:"base64"` 二进制原样落盘 ⇒ 这是 `mkdir` 不进文件面的实证依据，不只是偏好 |
| `listFiles` | `POST /v1/file/list`（`recursive`·`max_depth`·`include_size`…） | 实测返回 `{name,path,is_directory,size,modified_time,permissions,extension}`，可填满 `FileEntry`；但 **`size` 对目录是 `null`**、**`modified_time` 是字符串装的 epoch 秒**（不是 ISO）⇒ 两处都由 provider 归一 |

> **★★ 流式通道:走 `ws /v1/bash/ws`,不用轮询(专项 spike 已验完,2026-08)**
>
> **这个端点不在 openapi 里** —— FastAPI 不把 WebSocket 路由写进 OpenAPI，只有读镜像源码（`app/api/v1/bash.py:278` 的 `@router.websocket('/ws')`）才看得到。**这已经是同一类错的第四次**（§2.1★ 拿 `docker run` 量身份、§2.3★ 拿 `/v1/shell/exec` 量能力、§2.2 拿错镜像量端点数，本条拿 openapi 量传输面）。纪律照旧：**下否定结论前把对方的入口拉全**，openapi 不等于全部入口。
>
> 协议：上行 `{"type":"exec"|"input","data":…}`；下行 `{"type":"session_id"}` · `{"type":"output"}` · `{"type":"command_done",{command_id,exit_code}}`。
>
> **⚠️⚠️ 最大的坑:WS 绝不能自己建 session。** 源码 `finally` 里写着 `if created_by_ws: await manager.close_session(session.id)` —— **WS 断开会把它自己创建的 session 关掉**，而关 session **销毁输出并杀掉作业**。照直觉写"连上 WS 就 exec"，平台一重启作业就死，且要到第一次重启才暴露。
>
> **⇒ 正确的三步序列（已端到端验证）**：
>
> ```
> ① POST /v1/bash/sessions/create        先建 session ⇒ created_by_ws=false
> ② POST /v1/bash/exec  async_mode:true  起作业 → command_id
> ③ ws  /v1/bash/ws?session_id=<同一个>   只做【附着】，断开不影响 session
> ```
>
> **spike 结果全表**：
>
> | 场景 | 结果 |
> |---|---|
> | 长跑 **33 分钟**、**100 秒静默 × 20 轮** | **断开 0 次**，每个标记准点到达零漂移，`command_done` 带 `exit_code=0` —— nginx idle timeout 不是问题（`python-server` 起了 `--ws-ping-interval 30`） |
> | 客户端 **SIGKILL**（模拟平台崩溃）× 3 轮 | 服务端 CPU 从 2.4% **降到** 0.5%，不空转；REST 照常；**session 与作业存活** |
> | 并发 3 个 session | 各自输出、**无串扰**，`exit_code` 各自正确 |
> | 断连重连 | **不回放历史**（连上时 `offset` = 当前流末尾）；重新附着后新输出继续到达 |
> | 补洞 | `POST /v1/bash/output` 游标读能拿回断连期间的全部行 |
>
> **⇒ 两处必须补洞，用同一条代码路径**：① **首段** —— ②③ 之间有间隙，附着前的输出收不到；② **断连期间**。都用**一次**带游标的 `readJob` 补齐后切回 WS。**一次补读不是轮询。**
>
> **⚠️ stderr 不走 WS**：`send_output` 只转发 `result.stdout`，从不发 stderr。而失败路径上 **codex 写零字节 stdout、信息全在 stderr**。⇒ 起作业时把 stderr 重定向进沙箱内文件，退出时用文件面 `readFile` 读一次；stdout 保持纯净 JSONL 走 WS。
>
> **⚠️ 一条更正**：本文档曾据早期观察推断"`/v1/bash/output` 必须带 `command_id` 才有数据"——**错的**。那次读到空是因为 session 已被 WS 断开时关掉。实测不带 `command_id` 同样读得到。
>
> **⚠️ 一次未能复现的异常**：spike 期间观察到一次 `python-server` 卡在 **73.8% CPU** 空转、API 从容器内部也不可达。但受控实验（干净关闭 ×3、强杀 ×3、并发、33 分钟长跑）**全部健康**，真因是探针侧留了孤儿进程长期挂连接。**记为"观察到一次、未能复现、原因未明"**，不作为 WS 的结论；实现期若再现，从这里查起。

> **⚠️ `offset` 是字节游标**（实测：首行 `{"type":"item.completed","n":1}\n` 恰为 32 字节，回的就是 32）。所以平台侧**必须缓冲半行**，不能假设每轮都拿到完整行。
>
> **★★★ 会话生存期：默认配置下会把跑超过 1 小时的作业连根回收——这条会打破产品，必须在实现前处理。**
>
> 读 agent 源码（`app/services/bash.py`）+ 压缩 TTL 实测，三条事实：
>
> 1. **闲置 TTL = `BASH_SESSION_TIMEOUT`，默认 `3600` 秒**；后台清理任务每 `60` 秒扫一次。
> 2. **回收判定不看命令是否还在跑**：条件只有 `now - last_used_at > session_timeout` 或会话已关闭。
> 3. **轮询输出不刷新 `last_used_at`**：全文只有三处写它——建会话、`send_command`、`write_stdin`；`wait_for_output` **不碰**。
>
> **实测坐实**（把 `BASH_SESSION_TIMEOUT` 压到 5 秒）：一条要跑 300 秒的命令，在 t=10/30/55 三次轮询里都健在并持续产出（`TICK11 → TICK31 → TICK57`），**t=70 时整个会话 404 消失**，输出与退出码一起丢。
>
> **⇒ 直接后果**：硬超时档位 **30min / 1h / 2h / 4h**（P20 §0）里，**2h 与 4h 两档在 agent 默认配置下根本活不到结束**，1h 档正好压线。而且"平台勤快轮询就能保活"是**错的**——轮询不刷新时钟。
>
> **⇒ 还有一条**：**会话数上限 `MAX_BASH_SESSIONS` 默认 50，超了按 `last_used_at` 淘汰最老的**。一个连跑很多 Task 的沙箱会**静默丢掉**早先作业的输出。
>
> **⇒ 处理办法（成本很低）**：两个都是 `get_env_int` 读的环境变量 ⇒ **建沙箱时经 `SandboxProviderContext.env` 设大即可**，与 `JWT_PUBLIC_KEY` 走同一条通道。这条已固化成契约义务写进 `SandboxJobs` 的注释（"生存义务"）：声明 `headlessTask` 的 provider 必须保证作业在 `JobSpec.timeoutMs` 期间可读可杀，做不到就在发起时拒绝，而不是接下来再让它中途消失。
>
> **保留期与截断：已验（2026-08）。**
>
> - **`max_output_length` 不截断游标通道**：设 `max_output_length:100` 跑一个产出 1492 字节的命令，`/v1/bash/output` 从 `offset=0` 读回的仍是**完整 1492 字节**，一字不少。它的作用是触发把全量**溢出到文件**并回报路径（`stdout_full_output_file_path`，形如 `/tmp/aio-sandbox-truncated-output/bash/<uuid>.stdout.log`；未超限时该字段为 `null`）。
> - **保留期不是时间，是 session 生命周期**：输出随 session 存活，**关掉 session 即销毁**（见上表 `releaseJob` 行）。所以"重启可续 / 刷新可续"成立的前提是**平台在持久化完成前不释放**——这条已固化进 `SandboxJobs.releaseJob` 的契约注释。
>
> **原先挂在这里的两条已验完（2026-08，真凭证 + 隔离 HOME）**：① `resumeFrom` 的真实接续 ⇒ §3 ★4（两边都真接上，并顺带推翻了 encoded-cwd 那条约束、揪出 resume 选项集不同）；② 成功路径的 `item.type` 取值 ⇒ §3 ★4 末段的事件面表，`'tool-call'` 映射已可定死。

#### 刻意**不**进文件面的

`mkdir` / `rename` / `remove` / `exists` / `watch`。

- 前三个不携带秘密（路径不是凭证），用 `exec` 做没有 05 §7 #3 的泄密风险，不值得让每个 provider 各实现一遍；
- `exists` 就是 `readFile` 回 `null`；
- `watch` 在 沙箱内 API 侧确实有整套（`/v1/file/watch/*`，6 个端点，带游标轮询），但**今天没有用户**——Task 的产物在任务结束时读一次就够。现在加，等于用猜测而不是真实需求把它的形状钉死。

## 3. RuntimeAdapter contract（完整定义）

RuntimeAdapter 封装的是"**某个 agent CLI 的怪癖**"——怎么装、怎么登录、怎么起任务。它**不碰任何 sandbox 实现细节**：拿到的是 §2 的中立原语（`SandboxExecFn` / `ProcessStream`），所以同一个 `ClaudeCodeAdapter` 在 `aio` 和 `boxlite` 下是同一份代码。

```typescript
interface RuntimeAdapter {
  readonly id: 'claude-code' | 'codex' | string;

  // 安装
  getInstallPlan(imageSpec: ResolvedImageSpec): RuntimeInstallPlan;
  isInstalled(exec: SandboxExecFn): Promise<boolean>;
  install(exec: SandboxExecFn): Promise<void>;

  // 鉴权（流转见文档 05）。注意收的是 ProcessStream 而非 SandboxExecFn：
  // 交互式登录命令永远不会退出，一次性 exec 既拿不到增量输出也写不了 stdin。
  getAuthMethods(): RuntimeAuthMethod[];
  beginAuth(method: RuntimeAuthMethod, pty: ProcessStream): Promise<AuthChallenge>;
  completeAuth(challenge: AuthChallenge, input: AuthCompletionInput,
               pty: ProcessStream): Promise<RuntimeCredential>;
  // 密钥直存模式（'api-key' / 'access-token-paste'）：不经 sandbox pty 的短路路径（05 §3.1），
  // 纯函数构造凭证形态（credentialFiles / env），无需任何宿主
  createCredentialFromSecret?(method: 'api-key' | 'access-token-paste',
                              secret: string): Promise<RuntimeCredential>;
  // ★ S5 裁决 D-18（TASK-LAUNCH-DECISIONS T-5）：注入路径的入参类型【没有 authFile 字段】。
  //   InjectableRuntimeCredential = RuntimeCredential 去掉 authFile。真 refresh_token 在类型层面
  //   就到不了这里；带 authFile 的 RefreshableRuntimeCredential 只交给 05 §5.1 的刷新扫描器。
  //   （契约层的类型拆分属下一步改动，本文先固化裁决。）
  injectCredential(cred: InjectableRuntimeCredential, exec: SandboxExecFn): Promise<void>;

  // 运行
  buildStartCommand(task: RuntimeTaskSpec): SandboxCommand;
  buildAttachCommand(): SandboxCommand;
  parseOutput?(chunk: Buffer): RuntimeEvent[];
}
```

| 方法 | 平台拿它干什么 | 谁在什么时候调 | 要点 |
|---|---|---|---|
| `getInstallPlan` | 创建 sandbox 前预估"这个镜像要不要装、装多久"，用于决定 `runtime_installations.status` 初值（13 §2.3.2）与是否提示用户换镜像 | 创建流程校验阶段 | 纯函数，不产生副作用、不碰网络。**判据是（镜像, runtime）这一对，不是 runtime 单独**——同一 runtime 在不同镜像上一个零安装、一个要装 12.5 分钟（S5 实测见下方 ★1） |
| `isInstalled` | 幂等判断，避免每次启动都重装 | `install` 之前；健康检查时复查 | 洁净环境必须返回 false（testkit RA-01）。**必须走 `command -v` / PATH 查找，绝不硬编码安装路径**——**理由已更正（§2.1★）**：旧说法"同一 runtime 在 aio 与 boxlite 下装的位置不同"**已被推翻**（经平台 exec 通道实测，两侧 npm prefix 相同）；真正的理由是 ① prefix 是**用户级非标准位置** `/home/gem/.npm-global`，② `codex` 实际解析到 **fnm shim** `/home/gem/.fnm_shell/bin/codex` 而非 prefix 下的路径 ⇒ **硬编码任何具体路径都会错**。**PATH 查找已实测可用**：往 `$(npm config get prefix)/bin` 放可执行文件后，新起一次 exec 的 `command -v` 能找到（`/home/gem/.npm-global/bin/probecli`） |
| `install` | 按 plan 真正装 CLI | `isInstalled=false` 且策略为 `install-on-start` 时 | 必须可重入：中途失败后重调不能留半个环境（实测重入仅 **6 秒**，几乎免费——不必设计增量恢复，★1） |
| `getAuthMethods` | 决定前端鉴权页给这个 provider 渲染哪种模式；Claude 官方支持 device-code 后**只改这里**（05 §6） | 鉴权页加载、`beginAuth` 前校验 | 返回顺序即推荐优先级 |
| `beginAuth` | 在容器内起交互式登录命令，从**增量 pty 输出**里正则捕获 URL / device-code，交前端展示 | `POST .../auth/begin`（05 §3） | 脆弱点：CLI 改输出格式即失效 → golden fixture 兜底（§10 RA-04） |
| `completeAuth` | 把用户贴回来的 code 写进 pty stdin（或持续读输出等登录完成），产出可入库的凭证 | `POST .../auth/complete` | 返回的 `credentialFiles.content` 是明文，**只在内存流转**，落库前必经 Vault 加密 |
| `createCredentialFromSecret`（可选） | 把用户直接提交的 API key / access token 构造成可入库凭证（注入形态由 adapter 决定：env 变量或 config 文件） | `POST /api/runtimes/:rt/credentials/secret`（05 §3.1） | **不需要 sandbox 宿主**；可含轻量格式校验；同样只在内存流转、Vault 加密落库 |
| `injectCredential` | 把 Vault 里已有的凭证物化进新 sandbox，实现"登录一次、后续复用" | **provision workflow `starting` 段的第 ④ 步**（03 §4.3）——**必须排在 `provider.start()` 之后**：`exec` 由 `spawn({tty:false})` 派生（§2.3），实例没跑起来根本没有 `exec`（此前 24 §1 / 26 §1 的顺序是错的，S5 已更正） | 用一次性 exec 即可，无需 tty。**收的 `cred` 是明文（`SecretMaterial` 承载）——这是被许可的 runtime 注入路径**：credential 上下文经门面 `prepareRuntimeCredential` 交出 `RuntimeCredential`，由 **sandbox 编排侧持 `exec`** 调本方法**一次性注入**（写 `auth.json`/env/喂 stdin），**用后 `zeroize()`、不落 argv/日志**（23 §8.2 放宽后的 I-CRD-2、05 §4）。**注入形态见 05 §4 / §1★★——本表刻意不复述优先级**（此处原先那份"access-token-only（stdin）> `0600` 文件 >（禁用）整份 env"**已被 05 §1★★ 的 S5 实测推翻**：stdin 档版本敏感、已降为可选，且在当前 exec 通道上还会被静默丢弃（§2.3★）。优先级只在 05 §4 存一份，本处只留指针——同一条规则两处各存一份正是这次自相矛盾的成因）。不变的硬红线：**绝不 `CODEX_AUTH_JSON` env 注入整份含真 refresh_token 的 auth.json**（P0-3，05 §4/§7 #3，adapter 契约固化） |
| `buildStartCommand` | **两种用法共用一个方法**：① **交互式**（`headless:false`，S5 主路径）——provision 的 `bootstrapAgentSession` 用它把 `initialPrompt` 拼成"带指令启动 CLI"（03 §4.3 ⑤）；② **无头**（`headless:true`，MCP `run_agent_task`，02 §5）——**产品化不进 S5**（TASK-LAUNCH-DECISIONS T-4），执行通道见 §2.6 作业面 | ① provision `starting` 段第 ⑤ 步；② 后续切片 | 纯函数。**per-runtime 封装两件平台通用逻辑管不了的事**：① **关掉 CLI 自带的内层沙箱**（codex bwrap / claude permission 模型，形态完全不同，★2）；② 带上 CLI 自己的超时旗标作为第一道——但**真正兜底的是平台侧的强制 kill**（★3，03 §8.3） |
| `buildAttachCommand` | 终端会话默认跑什么（`ProcessSpec.cmd` 缺省值） | 终端网关建会话时（06） | 纯函数 |
| `parseOutput` | 可选：把 CLI 原始输出解析成结构化 `RuntimeEvent`，供任务进度展示 | 无头任务流式输出时（喂给它的是 §2.6 `JobChunk.stdout`，**绝不喂 stderr**） | 不实现则平台只透传原始字节。**实测后已不再需要正则**——见 ★4 末段 |

> **★1 install 策略：优先"镜像预装"，install-on-start 是兜底（S5 技术验证，2026-08 实测）**
>
> | 镜像 | codex | claude-code |
> |---|---|---|
> | `agent-infra/sandbox:latest`（AIO 默认） | ✅ **预装** `@openai/codex@0.139.0` | ❌ 无 → 现装 `npm i -g @anthropic-ai/claude-code` 耗时 **753 秒（12.5 分钟）**，装后 2.1.238 |
> | `cap-boxlite-sandbox:yolo-20260725-claude-2.1.207`（对照） | ✅ 预装 0.144.1 | ✅ 预装 2.1.207 |
>
> 三条结论：
>
> 1. **`getInstallPlan(imageSpec)` 按（镜像, runtime）这一对判断不是过度设计**——同一个 `claude-code`，在一张镜像上要装 12.5 分钟、在另一张上零安装。现在这是实测数据而不是假想场景。
> 2. **强烈建议预装**（§7 镜像约定已据此加严）。install-on-start 只作兜底：12.5 分钟会把创建链路的「启动实例」阶段拖成用户以为卡死的黑洞（P20 §3.3 的四阶段进度卡撑不住这个量级）。
> 3. **重入只要 6 秒**——RA-02 的"可重入"在真镜像上不仅成立，而且几乎免费；失败重跑不需要设计增量恢复逻辑。
>
> **install-on-start 在两个 provider 上都可行**：**⚠️ 本段原写"aio 是 root、npm prefix `/opt/nodejs/22`；boxlite 是 uid=1000 且 CapEff 为零"，已被推翻**（那是 `docker run` 通道的观察，平台不走那条路——见 §2.1★）。经平台真实 exec 通道实测：**两侧都以非 root 的 `gem` 跑**，npm prefix 同为用户级 `/home/gem/.npm-global`，CLI 装进 `$HOME`，**两侧都不需要 root**。这同时是 `isInstalled` 必须走 PATH 查找、不能硬编码路径的直接原因（§2.1★，理由已更正）。

> **★2 runtime 自带的内层沙箱必须由 `buildStartCommand` 统一关闭（S5 技术验证，2026-08 实测）——这是 adapter 级差异，不进平台通用逻辑**
>
> codex 自带 **bwrap**（bubblewrap）沙箱，其威胁模型是"跑在开发者笔记本上、外面没有任何隔离层"。在我们的沙箱里它要**再嵌套一层 namespace**：
>
> | namespace | `aio`（docker 容器） | `boxlite`（microVM） |
> |---|---|---|
> | user namespace | ❌ `Operation not permitted` | ✅ 可创建 |
> | **mount namespace** | ❌ | ❌ **也被拒** |
>
> bwrap 需要 mount ns 做 bind mount ⇒ **两个 provider 都起不来，不存在"provider 不对称"**——这一条必须写明，否则很容易被误判成 boxlite 的能力缺口而去补一个 capability 位（违反 §2.5 的加位规则）。第一次真跑的表现极具迷惑性：**鉴权成功、模型真跑了 13,093 tokens，但所有文件操作被拦**，agent 回报 `bwrap: No permissions to create a new namespace`，最后只能说"我改不了文件"——既不是鉴权失败，也不报错退出。
>
> **为什么关掉它不削弱安全**（这是本条的关键论证，不是图省事）：真正的隔离边界是容器 / microVM 本身；而**平台自己的 in-sandbox 数据面 agent 就是一个无鉴权 shell**（⚠️ 原写"无鉴权 **root** shell"，**已更正**：该 agent 以非 root 用户 `gem` 运行，见 §2.1★；论证不受影响——沙箱内可任意执行这一点与是不是 root 无关）——`POST /v1/bash/exec`，代码注释原文 *"the agent is an unauthenticated shell"*，正因如此它**只 publish 到宿主 loopback**（[SANDBOX-RUNTIME-DECISIONS](../SANDBOX-RUNTIME-DECISIONS.md)「安全姿态」；实现见 `docker-container-backend.ts` 的 `PortBindings: { HostIp: '127.0.0.1' }`）——**终端功能本身就靠它**。也就是说容器内早已可任意执行，内层 bwrap **挡不住任何新东西**。反过来，要让 bwrap 跑起来只能给容器 `--cap-add SYS_ADMIN` / `seccomp=unconfined`：**为了一层冗余的内层，去削弱真正起作用的外层，方向是反的**。
>
> **实现形态 per-runtime，由 adapter 封装**：codex 用 `-s danger-full-access`（实测可行）或 `--dangerously-bypass-approvals-and-sandbox`（帮助原文：*"Intended solely for running in environments that are externally sandboxed"*——我们正是那个 external sandbox）。**claude 没有 bwrap**，走 permission/approval 模型（`--permission-mode` / `--dangerously-skip-permissions`，帮助原文 *"Recommended only for sandboxes with no internet access"*——它本来就假设自己跑在外部沙箱里）。**两者形态毫无共性 ⇒ 只能落在 `buildStartCommand` 里 per-runtime 封装，绝不抽成平台通用规则**（否则平台就要开始认识每个 CLI 的沙箱旗标，正是本节开篇"adapter 封装某个 agent CLI 的怪癖"要挡住的东西）。

> **★3 无头任务必须有超时 + 强制 kill 兜底，不能指望 CLI 自己收敛（S5 技术验证，2026-08 实测）**
>
> **⚠️ 与 §2.6 ★★★ 一起读**：本条讲的是"到点要杀得掉"；§2.6 ★★★ 讲的是"到点之前不能被沙箱自己弄没"。后者在 agent 默认配置下**不成立**（2h/4h 两档会被闲置 TTL 中途回收），处理办法见该节。两条缺一不可。
>
> **落点（[TASK-LAUNCH-DECISIONS](../TASK-LAUNCH-DECISIONS.md) T-4）：本条结论已定、不需要重验，但落点在 S5 之后的切片**——无头 Task 整块不进 S5（缺 command handler、缺输出传输定案、日志存储只有 automation 口径）。**S5 的 live 技术验证跑的正是无头路径（`codex exec`），它证明的是机制成立，不等于产品化的无头 Task 已经就绪。** S5 内的交互式 Task 不依赖本条：它的兜底是 idle 回收 + 硬超时 24h（P20 §0）。
>
> 同一场景（**无凭证**起无头任务）两个 CLI 的表现完全不同：**codex 不会干净退出**——反复重试 `401 Unauthorized`（`wss://api.openai.com/v1/responses`，`Reconnecting... 1/5..5/5`）直到被 timeout 杀掉（`exit=124`）；**claude 干净 `exit=1`** 并打印 "Not logged in"。
>
> 实测的触发条件（无凭证）本身会被 03 §8.2 决策表第 2 条挡在前面，但它暴露的是**通用性质**：codex 遇到持续性 API 错误会一直重连而不退出——**凭证运行中失效、网络中断、上游持续 5xx 都会走到同一条不退出的重连循环**。⇒ 平台的硬超时不是"以防万一"，而是**已知有 runtime 会挂在那里**：无头任务执行必须有超时 + 到点强制 kill（落点见 03 §8.3）。`buildStartCommand` 可以带上 CLI 自己的超时旗标作为第一道，但**平台侧的 kill 才是唯一可靠的那道**。

> **实现补充（S4 后）**：adapter 另有一个**只读声明**字段 `credentialTtlMs?: Partial<Record<RuntimeAuthMethod, number>>`——"用某 method 拿到的凭证能活多久"。这是**厂商事实**（codex 的 access token ~1h、claude 的 setup-token ~1yr），必须由 adapter 声明：原先它以常量形式待在 application 层并按 **method** 分支，导致任何用 `oauth-device` 的第三方 runtime 都被安上 Codex 的 1 小时过期（真 bug）。未声明该 method ⇒ `expiresAt = null`（平台侧不设过期）。

> **★4 上下文管理整块落在 adapter，沙箱层零改动（2026-08 实测 + 检索；resume 已用真凭证端到端跑通）**
>
> 两个 CLI 的会话续接机制**都是现成的**，而且**上下文状态都落在沙箱自己的文件系统里**：
>
> | | 续接命令 | 状态落点 |
> |---|---|---|
> | codex | `codex exec resume <SESSION_ID> [PROMPT]`（另有 `--last`） | `$CODEX_HOME`（**默认持久化**；`--ephemeral` 才关掉） |
> | claude | `claude -p --resume <id>`（另有 `-c/--continue`、`--fork-session`、`--session-id <uuid>` 预先指定） | `$CLAUDE_CONFIG_DIR/projects/<encoded-cwd>/<session_id>.jsonl` |
>
> 于是**同一沙箱内多轮接续不需要任何新机制**——上下文文件本来就在那儿，只有"引用"需要旅行。这是主路径，也是当前唯一一条。
>
> **形态完全不同，所以只能留在 adapter**：codex 是**子命令**、claude 是**旗标**。没有任何通用包装能同时容纳两者——与 ★2「关掉各 CLI 内层沙箱」是同一条理由。
>
> **会话 id 从哪来：走事件，不另开门。** 实测两个 CLI **都在第一个输出事件里**就吐出了自己的会话 id——codex 是 `thread.started.thread_id`，claude 是 `system/init.session_id`。它天生就是个事件，那就走 `parseOutput` 这一个既有出口，因此新增 `RuntimeEventType` 成员 `'session-started'`，而不是给 adapter 单开一个 `sessionRefOf()` 方法。
>
> **两条已用真凭证端到端跑通（2026-08，全程隔离 HOME）**：codex 与 claude 的 resume **都真的接上了上下文**（第 1 轮"记住 4271"，第 2 轮 resume 追问，两边都答 4271），且**都把同一个 id 回显在第一个事件里** ⇒ 平台可据此**确认"真的续上了"**，而不是假定。
>
> **⚠️ 我上一版写错、已被实测推翻的一条**：原文说"claude 的 transcript 按 encoded-cwd 分桶，换 `workdir` 再 resume 会找不到历史，平台必须保证 workdir 稳定"。**实测:换 cwd 照样接上**（codex、claude 都是）。transcript 路径确实按 encoded-cwd 分桶，但**按 id 的 `--resume` 不受 cwd 约束**；受约束的是 `-c/--continue`（其 help 原文即"当前目录下最近一条会话"）。我们用显式 id，所以不受影响——**这条约束不存在，别照旧文实现**。
>
> **⚠️ resume 的调用不是"起任务的调用加个旗标"**：实测 `codex exec resume` 的**选项集与 `codex exec` 不同**——**既没有 `-s/--sandbox` 也没有 `-C/--cd`**。而 `-s danger-full-access` 正是 ★2 用来关掉 codex 内层沙箱的旗标 ⇒ **把 resume 拼成"起任务 argv + resume"会直接死在 `unexpected argument '-s' found`**，等价能力要改走 `-c sandbox_mode="danger-full-access"`。两个子命令之间什么都别假设会继承。
>
> **引用不存在时两边都响亮失败，不会静默新开**：codex 退出码 1、stderr `no rollout found for thread id …`、**stdout 零字节**；claude 退出码 1、stdout 出 `result/error_during_execution` 且 `is_error: true`、stderr `No conversation found with session ID: …`。
>
> **⏳ 明确划到本切片之外**：跨沙箱 / 沙箱销毁后的续接。那需要把 context 目录导出导入（用 §2.6 文件面搬）或用 provider 快照——而两个内建 provider 今天都声明 `snapshot: false`（§2.5），这条路根本走不通。别顺手做。
>
> **附带把 RA-04 的风险评估更新掉：`parseOutput` 不需要正则。** §10 RA-04 把"CLI 升级改了输出格式"列为脆弱性风险，其隐含前提是要从 stdout 文本里正则抠信息。实测推翻了这个前提：两个 CLI 在结构化模式下 stdout 都是**纯净 JSONL**（codex 14/14、claude 3/3，均 0 行污染），噪声全在 stderr。只要 §2.6 作业面保证两条流不合流，`parseOutput` 就是**逐行 `JSON.parse` + 一张事件名映射表**，脆弱性大幅下降。**成功路径的完整事件面已实测（2026-08 真凭证，用一个必然触发工具调用的任务：读文件 → 写文件 → 跑 `wc`）**，两边都是 **0 行污染、stderr 全空**：
>
> | | 顶层 type | 载荷 |
> |---|---|---|
> | codex | `thread.started` · `turn.started` · `item.started` · `item.completed` · `turn.completed`（失败路径另有 `turn.failed` · `error`） | `item.type`：`agent_message{id,type,text}`、`command_execution{id,type,command,aggregated_output,exit_code,status}`、`file_change{id,type,changes:[{path,kind}],status}` |
> | claude | `system/init` · `system/thinking_tokens` · `assistant` · `user` · `result/success` | `message.content[]`：`text`、`thinking{thinking,signature}`、`tool_use{id,name,input,caller}`、`tool_result{tool_use_id,content}`（**在后续的 `user` 消息里**） |
>
> ⇒ **`'tool-call'` 的映射现在可以定死**：codex 取 `command_execution` / `file_change` 两种 item（`item.started` → `status:'started'`，`item.completed` → `'completed'` 并带 `exitCode`/`output`），claude 取 `tool_use` 块（`status:'started'`）+ 后续 `user` 消息里的 `tool_result`（`status:'completed'`，靠 `tool_use_id` 关联）。⚠️ **两者不同构**——codex 一个 item 自带输出，claude 把「调用」与「结果」拆在两条消息 ⇒ **写不出跨两家的通用解析器**，各 adapter 各映各的。**`name` 只在 `started` 半边**：claude 的 `tool_result` 只带 `tool_use_id`，而解析器刻意逐行无状态（有状态的 id→name 表会让「实时解析」与「回放解析」产出不同载荷，正是平台 `seq` 回放绝不能出现的事）⇒ 与其发一个空串，不如让该字段在 completed 半边**根本不存在**，消费方按 `id` 关联。⚠️ 由此产生一条对 codex 的**依赖**：`name`/`input` 只在 `item.started` 上，所以某个 item 类型若只发 `item.completed` 就会丢掉它们；依据是实测那次成功跑（读文件→写文件→跑 `wc`）的**逐类型计数**：`item.started` 3 条（`command_execution` 2 / `file_change` 1），`item.completed` 5 条（`command_execution` 2 / `file_change` 1 / `agent_message` 2）——顶层 3:5 的差额**全部来自 `agent_message`**（它本就不是工具 item），两种工具 item **严格成对**（2:2、1:1）。真出现不成对的类型，改 codex mapper 一行（从它的 completed 同时发两半），**不要**改成有状态查表。⚠️ claude 的 `tool_result.is_error` 走**独立的 `isError`**，**不折成 `exitCode: 1`**：`exitCode` 里 codex 放的是实测退出码，合成一个 1 进去，两者就长得一模一样而消费方分不出来。（这与「沙箱侧硬超时归一成 124」不是一回事——124 是真实进程的真实退出码，不是布尔装出来的。）消费方判失败：`isError === true || (exitCode !== undefined && exitCode !== 0)`。
>
> ~~⚠️ **一个已知缺口**：codex 的 `agent_message` 与 claude 的 `text` 块没有忠实对应~~ → **S6 已补**：真消费者出现了（前端要把 agent 正文与工具调用分开呈现），于是新增成员 `'agent-message'`，`'stdout-chunk'` 回归它的字面意思——留给没有结构化输出模式的 runtime 的原始字节。这正是当初「先不猜着加、等有消费者再补」想要的结局。
>
> **⚠️ 两个陷阱**：① codex 的 `-o/--output-last-message <FILE>` 在任务**失败时根本不生成**——"文件不存在"是正常路径，这正是 §2.6 `readFile` 回 `null` 而不抛的原因；② claude 的 `result` 行会出现 `subtype:"success"` 与 `is_error:true` **并存**，判定成败**只能看 `is_error`，不能看 `subtype`**。
>
> **⚠️ 成功路径尚未实测**：上述事件名取自零凭证探针（鉴权失败路径）与官方文档。`item.completed` 在成功路径上的 `item.type` 取值（工具调用 / 消息 / 命令执行等）**没有真机验证过**，`'tool-call'` 的映射表要等成功路径实测后才能定死。

**支撑类型**：

```typescript
interface RuntimeInstallPlan {
  strategy: 'preinstalled' | 'install-on-start' | 'sidecar-inject';
  packageManagerCmds: string[];
  requiredBinaries: string[];
  envRequirements: string[];
  estimatedInstallSec?: number;
}

type RuntimeAuthMethod = 'oauth-device' | 'setup-token' | 'api-key' | 'access-token-paste';

interface AuthChallenge {
  method: RuntimeAuthMethod;
  kind: 'url' | 'device-code' | 'paste-prompt';
  verificationUrl?: string;
  userCode?: string;
  expiresAt?: string;
  instructions: string;          // 前端展示的人类可读引导文案
  challengeRef: string;          // 关联同一次登录会话（内部映射到 pty session）
}

interface AuthCompletionInput { pastedText?: string; cancel?: boolean; }

interface RuntimeCredential {
  runtimeId: string;
  obtainedVia: RuntimeAuthMethod;
  maskedIdentifier?: string;
  issuedAt: string;
  expiresAt?: string;
  // ★ S5 裁决 D-19（TASK-LAUNCH-DECISIONS T-6）：containerPath 是【~/ 相对形态】（如 '~/.codex/auth.json'），
  //   【不是绝对路径】—— prepareRuntimeCredential(runtimeId) 的签名里根本没有 sandbox，构造这份凭证时
  //   不知道要注进哪个沙箱、更不知道它的 $HOME；同一份凭证本就要能注入不同沙箱。$HOME 只在
  //   injectCredential(cred, exec) 内部靠 exec 实测展开（testkit RA-06 已同步改判据）。
  credentialFiles: Array<{ containerPath: string; content: string; mode?: string }>;
  // content 明文只在内存流转，落库前必须经 CredentialVault 加密（文档 05/13）
  // ★ codex 的 auth.json 走【出生时脱敏】：completeAuth / parseRefreshedAuth 产出凭证时就同时给出
  //   ① 脱敏版（refresh_token 值 = shared-kernel 占位常量，字段保留）落 credentialFiles，
  //   ② 完整版落平台专用的 authFile。注入路径直接取①，【不做任何 JSON 解析或字段改写】（05 §4.3）。
}

interface RuntimeTaskSpec {
  prompt?: string;
  taskId?: string;
  headless: boolean;
  outputFormat?: 'text' | 'json-stream';
  extraArgs?: string[];
  workdir?: string;
  // ★4：上一轮的会话引用。给了 = 接着上次聊，不给 = 全新会话。
  //   由 buildStartCommand 自己翻译成各 CLI 的形态（codex 是子命令、claude 是旗标）。
  resumeFrom?: string;
}

interface SandboxCommand { cmd: string[]; env?: Record<string, string>; cwd?: string; }

// 'session-started' 携带 { ref: string }：CLI 自己的会话 id，存下来下一轮填回 resumeFrom（★4）
// ★ S6 修订：载荷按成员钉死，且新增 'agent-message'。
//   原形态是 { type; timestamp; data: unknown }——消费方只能【猜字段名】，而改名不会
//   触发任何编译期或 schema 报错，失败形态是「输出渲染不出来」这种最难归因的静默。
type RuntimeEvent =
  | { type: 'session-started'; timestamp: string; data: { ref: string } }
  | { type: 'agent-message';   timestamp: string; data: { text: string } }  // agent 正文（★4 的已知缺口到此补上）
  | { type: 'stdout-chunk';    timestamp: string; data: { text: string } }  // 留给无结构化模式的原始字节
  // ⚠️ 载荷按 status 再判别一次：`name` 只出现在 started 半边（且必填）。
  //   曾经把 name 放在两边，逼得 claude 的 completed 半边发空串——而"必填但有时是假的"
  //   恰恰是这个联合被钉死时要消灭的那种静默。消费方按 id 配对。
  | { type: 'tool-call';       timestamp: string; data:
        | { status: 'started';   id: string; name: string; input?: unknown }
        // ⚠️ exitCode 只放【真实退出码】，isError 放【工具自己说它失败了】。
        //   codex 有前者、claude 有后者；把 claude 的布尔折成 exitCode:1，会让
        //   一个实测的 1 和一个合成的 1 落进同一个字段、消费方分不出来——正是这个
        //   联合被钉死时要消灭的那类静默，只是换了个地方。两者不冗余。
        | { status: 'completed'; id: string; exitCode?: number; isError?: boolean; output?: string } }
  // ⚠️ 载荷【空】：实测两个 CLI 的完成事件都不带退出码——那是【作业】的事实，
  //   走 `/tasks` 的 `exit` 帧。留一个没有生产者的可选字段只会让后人白找一遍。
  | { type: 'task-complete';   timestamp: string; data: Record<string, never> }
  | { type: 'error';           timestamp: string; data: { message: string } }
  | { type: 'auth-required';   timestamp: string; data: { method?: string } };
// timestamp 产出时【可以为空串】：parseOutput 在 infrastructure，没有 Clock（01 §3），
// 两个 CLI 的事件本身也不带时间——由 application 层盖章。

/**
 * 一次性命令执行。**不是 SandboxProvider 的方法**——由平台的 toExecFn(provider, handle)
 * 在 spawn({tty:false}) 之上派生（§2.3），Adapter 作者与 Provider 作者都不用实现它。
 */
type SandboxExecFn = (cmd: string[], opts?: Omit<ProcessSpec, 'cmd' | 'tty'>) =>
  Promise<{ stdout: string; stderr: string; exitCode: number }>;
```

## 4. 统一错误模型

```typescript
enum SandboxProviderErrorCode {
  IMAGE_PULL_FAILED      = 'IMAGE_PULL_FAILED',
  RESOURCE_EXHAUSTED     = 'RESOURCE_EXHAUSTED',
  NOT_FOUND              = 'NOT_FOUND',
  ALREADY_EXISTS         = 'ALREADY_EXISTS',
  TIMEOUT                = 'TIMEOUT',
  PERMISSION_DENIED      = 'PERMISSION_DENIED',
  INVALID_STATE          = 'INVALID_STATE',           // 对已销毁 sandbox 调 exec 等
  PROVIDER_UNAVAILABLE   = 'PROVIDER_UNAVAILABLE',    // docker daemon 不可达
  UNSUPPORTED_CAPABILITY = 'UNSUPPORTED_CAPABILITY',
  INTERNAL               = 'INTERNAL',
}

class SandboxProviderError extends Error {
  constructor(
    readonly code: SandboxProviderErrorCode,
    message: string,
    readonly cause?: unknown,
    readonly retryable: boolean = false,
  ) { super(message); }
}

// RuntimeAdapter 同构错误码：INSTALL_FAILED / AUTH_CHALLENGE_EXPIRED / AUTH_REJECTED
//   / BINARY_NOT_FOUND / UNSUPPORTED_METHOD / PARSE_ERROR
// ImageSpecProvider：REGISTRY_UNREACHABLE / REF_NOT_FOUND / MANIFEST_INVALID
//   / IMAGE_CONTRACT_VIOLATION —— 运行期实测发现镜像违反 §7 约定（当前唯一触发点：缺 tmux）
```

**分层映射原则**：infrastructure 抛 contract 层错误，只在 infrastructure→application 边界短暂穿越；application 统一 `mapProviderErrorToDomain()` 转为 domain 错误再上抛——**domain 层永不依赖 contract 包的错误类**（保持文档 01 的依赖方向纯净）。

interface 层再映射：


| 错误码                                      | REST      | MCP                                                                                  |
| ---------------------------------------- | --------- | ------------------------------------------------------------------------------------ |
| IMAGE_PULL_FAILED / PROVIDER_UNAVAILABLE | 502 / 503 | tool 层错误（`isError:true` + 文本 + code 字段），**不用 JSON-RPC 传输级错误**——让 LLM 调用方读到具体原因判断是否重试 |
| RESOURCE_EXHAUSTED                       | 429       | 同上                                                                                   |
| NOT_FOUND                                | 404       | 同上                                                                                   |
| ALREADY_EXISTS / INVALID_STATE           | 409       | 同上                                                                                   |
| PERMISSION_DENIED                        | 403       | 同上                                                                                   |
| TIMEOUT                                  | 504       | 同上                                                                                   |
| **INSTALL_FAILED**（RuntimeAdapter）      | **500**   | 同上                                                                                   |
| **IMAGE_CONTRACT_VIOLATION**（ImageSpec） | **500**   | 同上                                                                                   |
| INTERNAL                                 | 500       | 同上                                                                                   |

> **`INSTALL_FAILED` 的主要露出面不是 HTTP（S5 补，TASK-LAUNCH-DECISIONS T-3）**：装 CLI 发生在 202 之后的 provision workflow（03 §4.3 ③），用户此时早已拿到 202，**没有同步响应可承载它**。它的实际路径是 `starting → failed` + `failure_reason` + WS `sandbox.status_changed`，前端按 P22 §1 的人话表展示（"运行时 CLI 安装失败"）。上表那行 500 是为了**将来出现同步入口时有据可依**（如重试安装端点），以及满足 02 §6.2「任何错误码都必须有映射、绝不裸抛」的兜底纪律。产品文案与 REST/MCP 映射见 02 §6.1 与 P22 §1。

> **`IMAGE_CONTRACT_VIOLATION`（2026-08 随「tmux 升 MUST」新增）**：镜像**注册期过了 `validate()`、运行期却被实测证伪**时抛它——当前唯一触发点是 `bootstrapAgentSession` 起会话前的 `command -v tmux` 未命中（§7 ★ / 03 §4.3 ⑤）。**为什么不复用 `MANIFEST_INVALID`**：那条是 `ImageSpecProvider.validate()/resolve()` 在注册期给出的静态判定，而本条发生在 provision 的 `starting` 段、由沙箱内实测触发，排障时「注册期就该拦住却没拦住」与「注册期判定已过期」是两个完全不同的下一步动作，合成一个码等于把这个区分抹掉。**露出面同 `INSTALL_FAILED`**：主路径是 `starting → failed` + `failure_reason` + WS `sandbox.status_changed`，上表那行 500 是为将来的同步入口与 02 §6.2 的兜底纪律留的；`retryable:false`（重试不会给镜像装上 tmux，正确动作是换镜像）。

### 4.1 「门口拒绝」与 `sideEffectFree`（2026-08 新增）

创建门（§5「创建前静态校验」）给出的拒绝与「受理后失败」是**两种事件**，用户能做的动作完全相反：

- **门口拒绝** —— 不进调度、不落库、不调 `provider.create`。没有 sandbox id、列表里不留 `failed` 记录、没有任何东西可供 [重试] 作用 ⇒ 正确呈现是**就地改请求再发**。
- **受理后失败** —— 已落库、`starting` 段中途挂掉（`INSTALL_FAILED` 等）⇒ 走失败卡 + [重试]。

前端此前靠 `httpStatus === 409` 区分，**而四条门口拒绝里它只覆盖到一条**。因此错误信封新增一等字段 **`sideEffectFree?: boolean`**（权威定义见 [shared/10 §6.8](../shared/10-接口契约与类型共享.md)）：`true` = 这次请求在产生任何副作用之前就被拒；**缺席 = 未表态，按「可能有副作用」读**（optional 正是为此——漏标只退化回现状，必填则会让猜错的那条对着半成品说「什么都没发生」）。

创建门全量清单（每条都 `retryable:false` + `sideEffectFree:true`）：

| 拒绝 | 码 | REST | 说明 |
|---|---|---|---|
| provider 不在注册表 | **`UNKNOWN_PROVIDER`** | **400** | §8 开放注册表的入参问题，不是服务端故障 |
| runtime 不在注册表 | `UNKNOWN_RUNTIME` | **400** | 同上，姊妹注册表（`UnknownRuntimeError`，见下） |
| 镜像引用含空白/控制字符 | **`INVALID_IMAGE_REFERENCE`** | **400** | ref 会被拼进 registry 引用并回显进日志，`\x1b[` 即终端转义注入 |
| 能力静态校验不通过 | `UNSUPPORTED_CAPABILITY` | 409 | §5，本表唯一原本就带信封的一条 |
| 项目不存在 | `PROJECT_NOT_FOUND` | 404 | 门口的跨上下文只读校验（`ProjectFacade`，26 §3 link①） |
| 项目尚不能接任务 | `PROJECT_NOT_READY` | 409 | `Project.assertCanAcceptTask`（I-PRJ） |

> **门口拒绝一律 `retryable:false`，这是门的性质不是逐条判断**：门说的是「这个请求本身不被接受」，原样再发必然同样被拒——要变的是请求或它的前置条件。同 `UnknownRuntimeError` 那条既有理由：每按必败的 [重试] 比没有按钮更糟。
>
> **⚠️ 上表前三条此前根本不产出信封（本次一并修复）**：它们是裸 `BadRequestException(string)` 抛的，出线的是 Nest 默认 `{statusCode, message, error}`——**没有 `code`、没有 `retryable`**，前端 `toApiError` 判定「不是信封」后整体替换成 `{code:'UNKNOWN', message:'请求失败（HTTP 400）'}`。也就是说 §4 这套「统一错误模型」在这三条上**从未生效**，后端那句 `unknown runtime 'shell'` 从来没到过用户眼前。**给一个没人读的 body 加字段等于没加**，所以这三条先改成真信封，`sideEffectFree` 才有意义。`UNKNOWN_RUNTIME` 现在直接抛 `UnknownRuntimeError` 交给本节的映射表，而不是把同一件事再用字符串写一遍。
>
> **落地形态：位置换取，不是逐点标注**。创建门收敛成 `SandboxApplicationService.admit` 一个方法（不持 `uow`、不写库、不调度、不碰 `provider.create`），`atDoor` 在其出口统一打标——**创建门里只有这一处写这个字段**（全库另有一处：controller 之前的 zod 校验管道，§4.2——同样是位置换取，不是逐点标注）。于是新增的门口校验只要写在这个方法里就自动标对，作者不需要知道有这个字段；而逐点标注正是三条漏标的成因。守卫用例 `packages/modules/sandbox/test/application/create-door.spec.ts` 不测清单、测机制。
>
> **⏳ 尚未覆盖的门（已登记；本轮仍然未改）**：
>
> - `POST /api/sandboxes/:id/runtimes/:rt/tasks` 的准入（沙箱不存在 / 非 running / runtime 不匹配）同属零副作用，但它们今天仍是裸 `NotFoundException` / 未标注；
> - 更广地说，application 层至今有 **35 处**拒绝是裸 `BadRequestException` / `NotFoundException` / `ConflictException` / … 抛/返的（27 处 `throw` + 8 处 `catch` 里 `return new …Exception(e.message)` 的映射器；2026-08 实测，口径见下），出线的仍是 Nest 默认 `{statusCode, message, error}`——**没有 `code`、没有 `retryable`**，前端一律降级成「请求失败（HTTP xxx）」。
>
> **§4.2 收编的不是它们**：那一节收的是 **DTO schema 校验**这一层（全局 pipe，在 controller 之前），而上面这 35 处是 controller 方法体/application 里**手写**的拒绝，根本不经过 pipe。两者一个都替不了另一个，所以这条 ⏳ 原样留着。兜底纪律见 02 §6.2。
>
> 上面那个数的实测口径（可复跑）：`grep -rnE "new (BadRequest|NotFound|Conflict|Forbidden|Unauthorized|Gone|UnprocessableEntity|InternalServerError|ServiceUnavailable|PayloadTooLarge)Exception\(" --include="*.ts" apps/api/src packages/modules/*/src`，减去两处**已经**产出信封的 pipe 绑定（`bootstrap/validation.pipe.ts`、`credential/.../zod-body.pipe.ts`）。

### 4.2 DTO 校验失败也产出信封：`VALIDATION_FAILED`（2026-08 新增）

§4.1 修的是「门口拒绝」这**六条**，而它们的成因——**body 不是信封，前端就整体丢弃**——在另一条路上还原封不动地存在：**每个端点的每一次 DTO 校验失败**。

`nestjs-zod` 的 `ZodValidationPipe` 出线的是 `{ statusCode: 400, message: 'Validation failed', errors: [...] }`——**没有 `code`、没有 `retryable`**，于是 `toApiError` 判定「不是信封」，用户看到的永远是那句「请求失败（HTTP 400）」。刚给 `initialPrompt` 加的 `max(8000)` 就是活例：超长时用户**看不到**「指令超长」，只看到「请求失败」——一个一句话就能说清、改一下就好的问题，被压成了一句没有信息量的话。

**本轮改法：换掉管道，不加全局 filter。**`createZodValidationPipe({ createValidationException })` 直接把信封塞进 400；filter 是事后补救，管道是就地产出，后者少一层且不会被别的异常路径误伤。

| 项 | 取值 | 理由 |
|---|---|---|
| `code` | **`VALIDATION_FAILED`** | 与既有码同构词法（`<环节>_FAILED`：`INSTALL_FAILED` / `CLONE_FAILED_*`），说的是「schema 校验这一关没过」；`BAD_REQUEST` 只是把状态码重写一遍 |
| REST | **400** | |
| `retryable` | ❌ | 原样再发必然被同一条规则拒掉——同 §4.1「每按必败的 [重试] 比没有按钮更糟」 |
| `sideEffectFree` | ✅ | **构造上**成立：pipe 跑在 controller **之前**，没进 application service、没落库、没进调度、没碰 `provider.create`。与 `atDoor` 同一套「位置换取标记」的道理（§4.1），不是逐条判断 |
| `message` | 人话，指名字段与规则 | 如「请求参数 initialPrompt 长度超过上限 8000 字符」。前端在创建语境下会把它嵌进「无法用当前配置创建：{message}。请调整配置后再试」 |
| `details[]` | `{ path, code, message }` | 逐项错误，路径用点号（`require.snapshot` / `env[3].key`，10 §6.8） |

> **⚠️ `details` 里刻意不放用户提交的值。**诱惑写法是把 `error.issues` 原样透出（zod 的 issue 刚好塞得进 `z.array(z.record(...))`），而 zod 的 issue **本身带 `received`**：`invalid_enum_value` 带原始值**且默认 message 里就嵌着它**、`invalid_literal` 带原始值、`invalid_union` 的 `unionErrors` 是整棵子树同样带。偏偏校验失败的字段最可能是不该回显的东西——`initialPrompt` 是指令正文，`InlineGitTestSchema.secret` 是明文凭证，`type` 填错时 `received` 装的就是隔壁字段的值。信封会进前端渲染、进服务端日志、进用户发过来的截图。所以实现是**逐个 issue code 白名单取字段**（路径 + 规则 + schema 侧的期望），而不是「透出后删几个」。`invalid_type` 的 `expected`/`received` 例外——那是**类型名**（`string`/`number`/`undefined`）不是值，且正是用户改请求需要的。
>
> **落地形态：一处构造，17 处接线全部收敛**。这只管道此前在仓里被 `new` 了 17 次（`main.ts` 1 次 + 16 个 e2e 各自建 app）。只改 `main.ts` 会让**生产用信封管道、e2e 用裸管道**——测的不是线上跑的那只，变异防线整个失效。现在唯一构造在 `apps/api/src/bootstrap/validation.pipe.ts#platformValidationPipe()`，17 处全用它；`apps/api/test/e2e/suite-hygiene.e2e-spec.ts` 有一条机械守卫钉住「e2e 不许再 `new ZodValidationPipe`」。判别联合体（`POST /api/credentials/git/test`）接不住 `createZodDto`，只能在参数上挂 schema，它用 `credential/.../zod-body.pipe.ts` 的第二处绑定——**形状仍单点**：信封由 `@platform/contracts` 的 `validationFailureEnvelope` 生成，两处绑定各只有一行。
>
> 用例：`packages/contracts/test/unit/validation-envelope.spec.ts`（信封形状 + 泄漏防线，哨兵串搜整份 JSON）与 `apps/api/test/e2e/validation-envelope.e2e-spec.ts`（HTTP 上真的出来的是它；并用 `GET /api/sandboxes` 为空证明 `sideEffectFree` 不是空话）。

## 5. Capabilities 协商与降级规则


| 场景                      | 规则                                                                                                                    | 落地状态 |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------- | --- |
| 创建前静态校验                 | 请求显式要求某能力（如 `requireSnapshot`）而 provider 为 false → application 层直接拒绝，不进调度队列                                           | ✅ 已实现。`CreateSandbox.require: { spawnTty?, volumeMount?, updateResources?, pauseResume?, snapshot? }`（`requireSnapshot` 泛化为逐位一字段）→ `SandboxApplicationService.assertCapabilities` 在解析项目、落库、进调度**之前**抛 `SandboxProviderError(UNSUPPORTED_CAPABILITY)` → 409。这是 `UNSUPPORTED_CAPABILITY` 的**第一个真实抛出点**。`watchEvents` 刻意不可 require——push/poll 对调用方完全封装，"要求 watchEvents"对 API 调用方没有意义 |
| `watchEvents=false`     | 平台 `SandboxStatusObserver` 自动切轮询 `inspect()`（running 每 10s，idle/stopped 降频 60s）；push/poll 差异对 domain/application 完全封装 | ⏳ 分支随 **SandboxStatusObserver 切片**落地——当前平台没有这个组件（状态由 application 在生命周期流程中主动转移），造一个观测器属于新功能，不在本切片内伪造分支。能力位仍经 `GET /api/providers` 下发 |
| `updateResources=false` | 扩缩容请求转为 "stop + 重建" 组合；连无损重建都不支持（无持久卷）则拒绝并提示                                                                          | ⏳ 分支随 **扩缩容端点切片**落地——当前 sandbox controller 只有 POST / GET / GET:id / DELETE:id，没有改配额入口可降级。能力位仍经 `GET /api/providers` 下发，并可被 `require.updateResources` 静态校验 |
| 能力发现                    | capabilities 随 provider 写入 registry，`GET /providers` 只读暴露 → 前端据此动态显隐按钮（无 pauseResume 就不显示"暂停"）                        | ✅ 已实现。`GET /api/providers`（sandbox 上下文 interface 层，zod + createZodDto，已进 openapi.json）返回 `{ name, capabilities（6 位全量）, isDefault }[]`。**registry 驱动**：第三方经 §8 方式一 `register()` 进来后自动出现在该端点（e2e `registry-extension.e2e-spec.ts` 有断言） |

> **落地状态列的读法**：同 §2.5 末尾的说明——⏳ 的两条不是"忘了做"，而是**平台侧的降级对象今天不存在**（没有 StatusObserver、没有扩缩容端点）。能力位本身已有真实读者（`GET /api/providers` 下发 + `require.*` 静态校验），组件到位时把降级分支接上即可，contract 不需要改。


## 6. 生命周期事件上报：事件订阅优先，轮询兜底

```typescript
interface ProviderEvent {
  handle: SandboxHandle;
  kind: 'state-changed' | 'oom' | 'health-changed' | 'died' | 'unknown';
  status: SandboxRuntimeStatus;
  occurredAt: string;
}
```

- `aio`：对接容器运行时的原生事件流（die / oom / health_status），一条长连接替代轮询。
- `boxlite`：库层 Box 生命周期回调包装成同一 `AsyncIterable<ProviderEvent>`——**同一形状**是这里的全部要求，事件怎么来是实现自己的事。
- 第三方（k8s Watch API、本地进程 child_process exit…）同理，只需产出同形状事件。
- 平台统一 `SandboxStatusObserver`：按 capabilities 选订阅或轮询，事件驱动状态机转移 + 写 `domain_events`。
- **事件流重连必做补偿**：断开自动重连 + 重连后立即全量 `inspect()` 对账（防断连期间漏事件）——与文档 13 §4 的启动对账共用同一套基础设施，触发场景一个是进程重启、一个是事件流重连。

## 7. ImageSpec contract 与镜像约定

```typescript
interface ImageSpecManifest {
  name: string;
  version: string;
  baseImage: string;
  entrypointContract: { workdir: string; entrypoint: string[]; healthcheckCmd?: string[] };
  supportedRuntimes: string[];
  resourceDefaults: ResourceQuota;
  labelsRequired?: string[];
}

interface ImageSpecProvider {
  readonly name: string;
  resolve(ref: string): Promise<ResolvedImageSpec>;
  validate(manifest: ImageSpecManifest): ValidationResult;
}

interface ResolvedImageSpec {
  ref: string;
  manifest: ImageSpecManifest;
  digest?: string;
  resolvedAt: string;
}

interface ValidationResult {
  valid: boolean;
  errors: Array<{ code: string; message: string; path?: string }>;
  warnings?: Array<{ code: string; message: string }>;
}
```

| 方法 | 平台拿它干什么 | 谁在什么时候调 | 要点 |
|---|---|---|---|
| `resolve` | 把用户写的 ref（tag / digest / 内部别名）钉成一个**不可变**的镜像坐标 + manifest | 创建 sandbox 的校验阶段，早于进调度队列 | 必须解出 `digest`，否则同一 tag 前后两次创建可能不是同一镜像 |
| `validate` | 判断这个镜像能不能被平台正常驱动（入口约定、支持的 runtime、资源默认值） | 镜像注册时；`resolve` 之后再校一次 | 只做**判断**不做修复；结果落 `image_manifests.validation_status`（13 §2） |

> 两个内建方案都以 **OCI 镜像**为交付单元（§2.1），所以下面这套约定在 `aio` 与 `boxlite` 下一字不差地成立——正是 §2.0 第 3 条"双实现验证"要保住的性质。

镜像约定（写入用户文档）：**必须含 bash 与 tmux**——tmux 于 2026-08 由用户裁决**从「建议」升为「必须」**（轨迹见下方 ★ 与 [TASK-LAUNCH-DECISIONS](../TASK-LAUNCH-DECISIONS.md) T-2）：缺 tmux 时 `validate()` 产出 **error（`IMAGE_TMUX_MISSING`）、`valid:false`、镜像不合格**，既不能注册也不能被 Task 选用（不再是 warning，无 tmux 镜像**不能**用）；**runtime CLI 强烈建议预装**，install plan 现装只作兜底；**HOME 可写（凭证物化需要）——但平台不假设 HOME 是哪个路径**。

> **★ S5 技术验证对镜像约定的加严（2026-08 实测，数据见 §3 ★1）**
>
> - **"可预装或现装"这句话在真实量级下不对等，必须表态**：AIO 默认镜像 `agent-infra/sandbox:latest` 预装了 codex（`@openai/codex@0.139.0`）但**没有 claude-code**，现装 `npm i -g @anthropic-ai/claude-code` 实测 **753 秒（12.5 分钟）**；两个 CLI 都预装的对照镜像则是**零安装**。⇒ 镜像作者文档里写**强烈建议预装 `supportedRuntimes` 声明的每个 runtime**，并在 manifest 里如实声明——现装仍然能用，但要按分钟级预期而不是秒级。
> - **tmux 从「建议」升为「必须」（用户裁决 2026-08；取代 S5 裁决 D-15 原文的「强烈建议 + 两档降级」口径，[TASK-LAUNCH-DECISIONS](../TASK-LAUNCH-DECISIONS.md) T-2）**：agent 会话由 provision workflow 在 `starting` 段起（03 §4.3 ⑤），**先于任何 WS 连接存在**，因此「谁持有这个会话」是镜像属性。
>   - **升 MUST 之前的口径（存档，勿当现状读）**：tmux 曾是 SHOULD，缺失时 `validate()` 出 warning 并在 `ResolvedImageSpec` 上标 `supportsTmux:false`，`bootstrapAgentSession` 据此分两档——**A 档**会话由沙箱内 tmux server 持有；**B 档**（无 tmux）由终端网关持有 `ProcessStream` + ring buffer（06 §6），代价是 ① 首次 attach 前的输出受 ring buffer 上限截断、② **平台进程重启 ⇒ pty 归属者消失 ⇒ agent 会话中断**。**B 档已整体取消。**
>   - **取代理由**：代价②对一个把 Task 当第一概念的产品不可接受——「重启一次平台就打断用户正在跑的 agent」不是可以写进镜像约定让作者自担的代价；而两个内建镜像本来就自带 tmux，为一条没人走的降级路在平台侧长期养一个分支不划算。单档之后代价①也一并消失：scrollback 的权威是 tmux 的 `history-limit`，不再有网关缓冲的截断上限。
>   - **现在的口径**：`validate()` 缺 tmux ⇒ `valid:false` + `errors[]` 含 `IMAGE_TMUX_MISSING`（testkit **IS-05 已随之从 SHOULD 升 MUST**，§10.4），镜像不能注册、不能被 Task 选用；`bootstrapAgentSession` 只有一档。
>   - **注册期判定不免除运行期实测，且实测失败必须响亮**（方法论同 §2.1★）：`validate()` 是注册期静态判定，镜像换 tag、上游换 base image 都可能让它过期，所以 `bootstrapAgentSession` 起会话前仍跑一次 `command -v tmux`。**未命中不得静默降级**——实例转 `failed` + `failure_reason`，错误码 **`IMAGE_CONTRACT_VIOLATION`**（§4 / 02 §6.1 / P22 §1）。这与「agent 鉴权自检失败即 `start()` 响亮失败」（[SANDBOX-RUNTIME-DECISIONS](../SANDBOX-RUNTIME-DECISIONS.md)「安全姿态」）是同一条纪律：**自检不过就失败，不要安静地退化成一个和用户预期不同的东西**。
>   - **`supportsTmux` 字段就此删除，不要再补**（本次裁决顺带结掉的契约缺口）：它此前只活在本节散文里，`ResolvedImageSpec` 的类型声明中从来没有（TASK-LAUNCH-DECISIONS §1 第 2 条登记在案）。它的两个用途现在都不存在——注册期 warning 变成了 `errors[]` 里的一条 error，运行期分支随 B 档一起取消。**合格镜像一律有 tmux，没有需要这个字段回答的问题**；运行期唯一的真相来源是那次 `command -v tmux` 实测。
> - **HOME 路径不属于约定的一部分**：⚠️ 原写"实测 `aio` 的 `$HOME=/root`（uid 0）、`boxlite` 的 `$HOME=/home/gem`（uid 1000）"，**已更正**——那是 `docker run` 通道的观察；经平台真实 exec 通道实测，**两侧 `$HOME` 同为 `/home/gem`**（§2.1★）。这不改变本条的效力：约定只要求 **HOME 可写**，而且**恰恰因为"两侧碰巧一样"更容易诱人去硬编码，本条更要坚持**；凭证物化落点（05 §4）与 CLI 安装位置（§3 `isInstalled`）一律按**运行时 `$HOME` / PATH** 解析，镜像不需要为此对齐路径，平台也不许硬编码（§2.1★）。**S5 裁决 D-19 把这条落到了具体位置**：`RuntimeCredential.credentialFiles[].containerPath` 改为 `~/` 相对形态，`$HOME` 的展开**只发生在 `injectCredential(cred, exec)` 内部**（那里才有 `exec` 可探测）——`prepareRuntimeCredential(runtimeId)` 的签名里根本没有 sandbox，构造凭证时无从知道 `$HOME`（TASK-LAUNCH-DECISIONS T-6）。

## 8. Registry 注册机制（双通道）

### 方式一（主）：DI Token + 动态模块

```typescript
// packages/contracts/src/registry.tokens.ts
export const SANDBOX_PROVIDER_REGISTRY = Symbol('SandboxProviderRegistry');
export const RUNTIME_ADAPTER_REGISTRY  = Symbol('RuntimeAdapterRegistry');
export const IMAGE_SPEC_REGISTRY       = Symbol('ImageSpecRegistry');   // ⏳ 仅占位，见下

// packages/contracts/src/sandbox-provider.contract.ts
export interface ProviderRegistry {
  register(impl: SandboxProvider, opts?: { default?: boolean }): void;
  get(name: string): SandboxProvider;    // 未注册抛 NOT_FOUND
  has(name: string): boolean;
  list(): SandboxProvider[];
  readonly defaultProvider: string;      // 'aio'，被 register(x, { default: true }) 移动
}

// packages/contracts/src/runtime-adapter.contract.ts
export interface RuntimeAdapterRegistry {
  register(impl: RuntimeAdapter): void;  // 无 opts.default —— 见下方"两处设计取舍"①
  get(id: string): RuntimeAdapter;       // 未注册抛错
  has(id: string): boolean;
  list(): RuntimeAdapter[];
}
```

**注册机制不是 `XxxModule.register()` 语法糖**：第三方模块在自己的 `@Module` 里注入 registry token，在自己的 `onModuleInit` 里调 `register()`——没有平台侧的动态模块工厂要写。内建 **`AioSandboxProvider`（`aio`，default）**、**`BoxliteSandboxProvider`（`boxlite`）**、`ClaudeCodeAdapter`、`CodexAdapter` 走的是**同一个** `register()`（构造器注入 → `this.register(x)`），因此只有一条注册路径、一次唯一性校验。`CreateSandbox.provider` 未指定时回退 `defaultProvider`；`CreateSandbox.runtime` 必填、无回退。注册校验：name/id 唯一，冲突启动即 fail-fast。

> **落地状态（✅ 已实现）**：上面的两个接口就是 `packages/contracts` 里的原文，`SandboxProviderRegistry`（sandbox/infrastructure/registry）与 `DefaultRuntimeAdapterRegistry`（runtime/infrastructure/registry）是它们的实现；重名/重 id **抛错 fail-fast**（provider 抛 `ALREADY_EXISTS`）。`SANDBOX_PROVIDER_REGISTRY` 与 `RUNTIME_ADAPTER_REGISTRY` 两个 token 均由各自 `@Global` 模块 `exports`，所以第三方模块能真正注入到。
> 两处**设计取舍**：① `RuntimeAdapterRegistry.register` 不收 `opts.default`——本平台没有"默认 runtime"概念（`CreateSandbox.runtime` 必填），加一个没有读者的选项正是本文档反对的死契约；② 注册期只校验唯一性，**capabilities 完整性由类型系统保证**（`SandboxProviderCapabilities` 6 位全必填，少一位编译不过，另有 wire schema 的编译期对齐守卫），无需运行时再查一遍。
> 验收：e2e `apps/api/test/e2e/registry-extension.e2e-spec.ts` 以一个"第三方 npm 包"形态的 `@Module` 注入两个 token 并在 `onModuleInit` 注册——**不改任何内建模块的 providers 数组、不改 registry 构造器**——随后 `GET /api/providers` 列出它、`POST /api/sandboxes` 经它 provision、`GET /api/runtimes` + `POST .../credentials/secret` 走它的 adapter。
>
> **`IMAGE_SPEC_REGISTRY`（⏳ 未实现）**：token 已在 `registry.tokens.ts` 预留，但它今天是一个**裸 Symbol**——没有接口、没有实现、没有 DI 绑定、没有任何注入点。image-spec registry 与其实现**随镜像管理切片落地**（届时 §7 的 ImageSpec contract 与 §10.4 的 IS-xx 条款一并生效）。在那之前，"provider / runtime / 镜像三层可注册"（产品 19 §1 原则 5）实际只有前两层是活的。

### 方式二（补充）：插件目录扫描 — ⏳ **后续，当前不做**

设计意图保留：`plugins/<type>/<name>/index.ts` 导出实现，其 `package.json` 用**标准 `peerDependencies`** 声明契约兼容范围（见 §9），不引入自定义字段；`PluginLoader` 启动扫描后注册进同一 registry。⚠️ 进程内加载需信任来源（长期可选 worker_threads 隔离壳）。

> **落地状态（⏳ 未实现）**：代码里**没有** `plugins/` 目录、没有 `PluginLoader`、没有 semver 校验。当前不做的两条理由：① 上面那条 ⚠️ 是本方式自带的——**进程内加载一个来路不明的 `index.ts` 等于把它当平台代码信任**，在没有隔离壳（worker_threads / 子进程）之前，这条通道的安全收益是负的；② 当前**没有任何 out-of-tree 消费者**，而方式一（DI token + `onModuleInit` 注册）已经把"不改内建代码即可扩展"这件事做到了，并有 e2e 验收——再加一条旁路只是多一个未被使用的攻击面。等真出现"用户把插件丢进目录就生效"的需求时再补，届时连同 §9 的 `semver.satisfies` 一起落地。

### 方式三（内建目录）：git 平台一等公民注册表

与方式一/二"用户运行时注册第三方 provider"不同，**git 托管平台的一等公民目录是平台内建的、代码级的单一数据源**——`shared-kernel` 的 `GIT_PLATFORM_REGISTRY`（`github`/`gitlab`/`gitee`/`gitea` → `label` + `defaultHost`）。不做成运行时插件，因为公网 git SaaS 就那么几个，且"一等公民"要配套 SSH host-key pin（host key 是随平台发布固化的安全数据，不该由第三方运行时注入）。落 `shared-kernel` 是因为 credential 的 domain 与 contracts 都要用它，而 boundaries 禁 `domain→contracts`——shared-kernel 是两端唯一共同可依赖点（与 `git-remote.ts` 同性质）。

- **单一源驱动、零 switch**：`GitPlatform` 类型、`GitPlatformSchema` zod 枚举、openapi 的 `platform` 枚举、`defaultHostFor()` host 推导，全部从这张 registry 派生（旧实现散在契约枚举 + 领域重复 type + `hostForPlatform` switch + 前端两处，已收敛）。
- **加一个公网 SaaS 一等公民 = registry 加一行**（自动驱动上述全部；前端一份 `Record<Exclude<GitPlatform,'other'>,meta>` map 靠 TS 强制跟随，漏跟即编译报错）+（可选）在后端 `known-hosts` 按其 `defaultHost` 加一条 SSH pin（不加则 `accept-new` TOFU）。**无任何 switch/case 要改**。
- **自建实例（Gitea / GitLab / GHE，任意内网 host）零代码改动**：认证/clone 逻辑按 **host + scheme + token/key** 驱动、**不认平台**（03 §7.3），自建走 `platform:'other'` + `allowed_hosts` + `accept-new` 即用。registry 只影响"公网 SaaS 的默认 host 推导 + 显示名 + SSH pin"这三件便利/加固事。

## 9. Contract 版本管理：抽成独立 npm 子包，版本交给 npm 管

`packages/contracts` **就是一个真正发布的 npm 包** `@platform/sandbox-contracts`（含 §10 的 testkit 作为 `@platform/sandbox-contracts/testkit` 子路径导出）。版本管理因此不需要任何自研机制——semver、兼容范围解析、冲突检测、升级提示全是包管理器的既有能力：

| 要解决的问题 | 自研方案（已废弃） | 现方案（npm 原生） |
|---|---|---|
| 契约版本号 | contract 内置 `CONTRACT_VERSION` 常量 | 包的 `version` 字段 |
| 插件声明兼容范围 | 自定义 `platformPlugin.contractVersion` 字段 | `peerDependencies: { "@platform/sandbox-contracts": "^2.0.0" }` |
| 兼容性校验 | 启动时 `semver.satisfies()` 自己算 | **安装期**由 pnpm 解析 peer range，不满足直接装不上 |
| 破坏性变更提示 | 自己维护 CHANGELOG + WARN | changesets 生成 CHANGELOG + release note，`npm outdated` / Renovate 自动开 PR |
| 废弃过渡 | 运行时探测 + `/providers` 展示"将在 vNext 移除" | `@deprecated` JSDoc（IDE 与 tsc 直接提示）+ 保留一个 major 周期 |

- **版本语义**（写进包的发布纪律）：**patch** = 实现无关的内部修复；**minor** = 新增可选方法/字段或新增能力位（旧插件不实现即该位 false，不破坏）；**major** = 必须方法签名变更 / 删字段。本文档这一版把 `exec`+`attachPty`→`spawn`、删 `healthCheck`、能力位 10→6，是一次 **major**。
- **发布纪律**：`packages/contracts` 用 changesets 管理，任何改动必须带 changeset，CI 校验缺失即 fail——这是"有版本的公共契约"唯一需要自己加的一道闸。
- **唯一保留的运行时校验**（⏳ **随 §8 方式二一起未实现**）：仅"插件目录扫描"这条旁路绕过了包管理器，`PluginLoader` 对它保留一次 `semver.satisfies(installedContractVersion, pkg.peerDependencies['@platform/sandbox-contracts'])`，不满足拒绝注册。走 npm 安装的插件不需要这一步——而当前**只有** npm/方式一这一条路，所以这道运行时校验今天没有存在的对象，代码里也没有它。

> **落地状态（⏳ 尚未发包）**：本节整节是**目标形态**。今天 `packages/contracts` 的 `name` 是 `@platform/contracts`、`private: true`，只在 workspace 内以 `workspace:*` 被消费；仓里没有 `.changeset/`，CI（`.github/workflows/ci.yml`）也没有 changeset 闸。上表右列的 npm 原生能力因此**都还没有真正接管**——只要还没有 out-of-tree 消费者，这是刻意不付的成本；一旦要对外分发，本节就是执行清单（改 `name`→`@platform/sandbox-contracts`、去 `private`、接 changesets、加 CI 闸）。全文出现的 `@platform/sandbox-contracts/…` 是发包后的名字，当前代码里对应 `@platform/contracts/…`。

> 与文档 10「REST/WS 不发 npm 包」不冲突：那条结论针对的是**前后端接口类型**（REST 有 codegen、WS 有 hash 比对两条更优路径）。这里是**后端内部的插件 SPI**，消费方是第三方实现者、分发渠道本来就是 npm，发包是成本最低而非最高的选项。

## 10. Golden 契约测试套件（testkit）

**目的**：第三方实现跑通即视为合格插件，无需平台维护者逐个审查。**内建实现（`aio` / `boxlite` / ClaudeCode / Codex）在 CI 跑同一套 testkit——无双重标准**，也倒逼 testkit 覆盖全面。

**形态**：`@platform/contracts/testkit` 子路径导出（发包后为 `@platform/sandbox-contracts/testkit`，§9），导出两个套件，内部 describe/it，按"声明了什么"自动决定条款必跑还是跳过。

```typescript
import {
  runSandboxProviderContractTests,
  runRuntimeAdapterContractTests,
} from '@platform/contracts/testkit';

// SandboxProvider：不传 context 只跑无宿主条款；传了才打开 live 条款
runSandboxProviderContractTests('my-provider', () => new MyCustomSandboxProvider(cfg), {
  context,                                   // 省略 ⇒ live 条款报告为 SKIPPED（附原因）
  skipLiveReason: 'docker daemon unreachable',
});

// RuntimeAdapter：全部条款零 CLI / 零网络，任何环境都无条件跑
runRuntimeAdapterContractTests('my-agent', () => new MyRuntimeAdapter(), {
  registryKey: 'my-agent',                   // RA-08：id 必须等于注册键
  validApiKeySample: 'myk-0123456789abcdef', // RA-11 正例 + RA-14 自动注入用例
  injectionCases: [{ label: '帐号凭证', credential, secrets: [token] }], // RA-14
});
// 全部 MUST 条款通过 = 兼容平台契约
```

> **落地状态（✅ 已实现，范围见下）**：两个套件都已落地并进 `pnpm test:contract`（CI 的 `contract-testkit` 步骤，`.github/workflows/ci.yml`）。
>
> | 跑套件的实现 | 位置 | 跑到的条款 |
> |---|---|---|
> | `aio` / `boxlite`（**真实内建类**） | `packages/modules/sandbox/test/contract/builtin-providers.contract.spec.ts` | SP-00、CAP-01（结构半场）——**无条件跑**，构造这两个 provider 既不连 docker 也不起 micro-VM |
> | `aio` / `boxlite`（**真实内建类，live**） | `apps/api/test/e2e/builtin-provider-contract.e2e-spec.ts` | 再加 SP-01（真 create→destroy）。宿主不可用时**大声 skip**（stderr 打黄框，说明缺什么），绝不假装通过 |
> | `fake`（内存实现） | `packages/contracts/test/contract/sandbox-provider.contract.spec.ts` | SP-00、CAP-01、SP-01 |
> | `codex` / `claude-code`（**真实内建 adapter**） | `packages/modules/runtime/test/contract/builtin-adapters.contract.spec.ts` | RA-03、RA-08 ~ RA-14（见 §10.3）——**无条件跑** |
> | 第三方 provider + adapter | `apps/api/test/e2e/registry-extension.e2e-spec.ts`（注册链路验收，非 testkit） | —— |
>
> **live 条款的 skip 语义**：`runSandboxProviderContractTests` 只在**传入 `opts.context`** 时打开 live 条款；不传则该 describe 块以 `SKIPPED — <skipLiveReason>` 的标题出现在报告里（不是消失）。live 块之所以放在 e2e 而非 contract 工程：一要真宿主，二是 BoxLite **跨进程只允许一个 runtime per `BOXLITE_HOME`**，而 `e2e` 是 vitest workspace 里唯一 `singleFork` 的工程，`contract` 是并行的。
>
> **为什么 RuntimeAdapter 套件只覆盖一部分**：它刻意只收"零 CLI、零网络"的条款，这样它能在任何机器上无条件跑；需要真 CLI 的条款（RA-01/02 安装往返、RA-05 challenge 形状、RA-06 凭证材料）留给后续的 sandbox-run 切片。

### 10.1 判定标准（先有要求，用例只是要求的可执行表达）

- **条款分级**：`MUST` = 平台有代码依赖这条行为，违反会导致平台逻辑出错；`SHOULD` = 违反不致命但会降级体验。
- **准入线**：**全部 MUST 条款 100% 通过**才算合格实现；SHOULD 未过输出 warning 并计入报告，不阻断。
- **能力位一致性**：声明为 `true` 的每个能力位，其挂靠条款自动**从跳过转为必跑**。声明 true 却跑不过 = 不合格（比不声明更严重，因为平台会据此走对应分支）。
- **报告产物**（⏳ **未实现，待有插件生态消费者时再做**）：设计意图是 testkit 输出 `contract-conformance.json`（条款 id → pass/fail/skipped + 实测值），插件仓库 CI 与平台 CI 都留档；`GET /providers` 诊断接口回显最近一次结果。今天两者都没有：报告的读者是"插件作者 + 审核者"，而当前没有 out-of-tree 插件，vitest 自己的 pass/fail/skipped 输出（条款 id 就写在用例名里）已经覆盖平台侧的全部需求；`GET /api/providers` 也**不**回显任何 conformance 字段——它只列 name / capabilities / isDefault（§5）。一旦真出现插件生态，这两件按本条落地。

### 10.2 SandboxProvider 条款

| id | 级别 | 要求（规范原文） | 怎么判定（用例断言） |
|---|:--:|---|---|
| **SP-00** | MUST | `name` 是非空 registry 键 | 断言非空字符串；registry 以它为键，空串等于注册了一个取不出来的实现 |
| SP-01 | MUST | `create()` 返回的句柄，其 `provider` 字段必须等于 `provider.name` | 断言 `handle.provider === provider.name`；否则 registry 路由会串到别的实现 |
| SP-02 | MUST | `create()` 只创建不启动 | `create()` 后立即 `inspect()`，`lifecycleState` 不得为 `instance_running` |
| SP-03 | MUST | 镜像不存在时必须抛 `IMAGE_PULL_FAILED`，不得抛裸 Error | 传入垃圾 ref，断言错误 `code`；平台靠 code 决定"回滚配额并置 failed"还是"重试" |
| SP-04 | MUST | `start()` 后 `inspect()` 必须在 N 秒内报告 `instance_running` | 轮询 `inspect()` 至超时，断言到达 running；N 默认 30s，可由 `opts.startTimeoutSec` 放宽 |
| SP-05 | MUST | `start()` 对已运行实体幂等成功 | 连调两次 `start()`，断言第二次不抛 |
| SP-06 | MUST | `destroy()` 幂等 | 连调两次，断言第二次静默成功；对账清理逻辑依赖这一点 |
| SP-07 | MUST | 对已销毁句柄调用 `start`/`stop`/`spawn` 必须抛 `INVALID_STATE`，**不得静默成功** | 销毁后逐个方法调用并断言 code；静默成功会让状态机以为操作生效 |
| SP-08 | MUST | 实体查无时 `inspect()` 返回 `instance_missing`，**不抛 `NOT_FOUND`**；仅在自身不可达时抛 `PROVIDER_UNAVAILABLE` | 销毁后 `inspect()` 断言返回值而非异常——对账要靠它区分"确认没了"和"我看不见" |
| SP-09 | MUST | `spawn({tty:false})` 的输出是**已解复用的干净字节流**，`exitCode` 如实反映退出码 | 跑 `echo`/`exit 3`，断言 stdout 无任何流头字节、exitCode===3 |
| SP-10 | MUST | 并发 `create()` 两个 sandbox 互不干扰 | 并发创建后交叉 `spawn` 写文件，断言彼此看不到对方的文件 |
| SP-11 | MUST | `inspect()` 返回结构满足 `SandboxRuntimeStatus`，`health` 若存在则字段齐全 | schema 校验（zod）而非 `typeof` 抽查 |
| SP-12 | SHOULD | `stop()` 在 `timeoutSec` 内返回；超时转强制终止 | 起一个忽略 SIGTERM 的进程，断言仍能在 timeout+buffer 内停掉 |
| **CAP-01** | MUST | **声明的每个能力位都必须与实际行为一致** | 对每个声明 `true` 的位跑其挂靠条款；对声明 `false` 的位，断言调用对应可选方法抛 `UNSUPPORTED_CAPABILITY` |
| **SP-J1** | MUST（`headlessTask`） | **作业生存义务**：`startJob` 与 `releaseJob` 之间，作业必须在其 `JobSpec.timeoutMs` 期间保持可读可杀，且**读取不得成为保活手段** | 起一个时长接近 `timeoutMs` 的作业，全程**不**轮询，到期后再读——必须仍能拿到输出与退出码。⚠️ 这条专治一类默认就违反它的实现：内建 agent 的会话有闲置 TTL（默认 1 小时），而**读输出不刷新它的时钟**、回收也**不检查命令是否在跑**（§2.6 ★★★）。✅ 已落地为 live e2e（`apps/api/test/e2e/agent-task-job-plane.e2e-spec.ts`，aio 与 boxlite 各一遍），并**同时断言沙箱确实是带着放大后的 TTL / 会话上限启动的**——只断言「到期后读得到」会让一个从没放大过 TTL 的实现也蒙混过关。仍未进 testkit（它需要真 host） |
| **CAP-02** | MUST | **有面挂靠的能力位与该面的存在性双向一致**：`headlessTask` ⟺ `provider.jobs` 与 `provider.files` 同时存在（§2.6） | 断言 `(provider.jobs !== undefined) === capabilities.headlessTask`，`files` 同理。**两个方向都判**：声明 `true` 而无面 ⇒ 应用层调到 `undefined`；有面而声明 `false` ⇒ `GET /api/providers` 瞒报，前端据此显隐控件会漏掉可用能力 |
| SP-T1 | MUST（`spawnTty`） | `spawn({tty:true})` 能双向收发，`resize()` 生效 | 写入 `stty size` 并 resize，断言输出的行列数随之变化 |
| SP-T2 | **SHOULD**（`spawnTty`） | `ProcessStream.ref` 稳定可复用：用它作 `reuse` 重连回同一会话 | 建会话 → 写入标记 → 断开 → `spawn({reuse: ref})` → 断言能看到先前会话的现场。**维持 SHOULD，但理由已更换（2026-08）**：原理由是「保活依赖 tmux 而 §7 只把 tmux 定为 SHOULD，一个 MUST 一个 SHOULD 自相矛盾」（审计 P1-10）——tmux 升 MUST 后该矛盾不复存在，原理由作废。**现在的理由更硬**：现场保活由**沙箱内的 tmux server**提供，与 provider 支不支持 `ref` 复用正交——网关重连时再跑一次 `tmux attach` 同样回到现场，并不要求 provider 复用同一个 `ProcessStream.ref`。因此 ref 复用是**省一次 spawn 的优化**，不是保活的前提，不该定成准入线。⚠️ 原文那句「不具备会话保活的实现必须降级为网关侧 ring buffer」**已随 B 档一起作废**（§7 ★ / 06 §6），不要再照它实现 |
| SP-V1 | MUST（`volumeMount`） | `stop()` → `start()` 后工作区数据仍在 | 停机前写文件，重启后读出同一内容 |
| SP-W1 | MUST（`watchEvents`） | 实体异常退出后 N 秒内产出 `kind:'died'` 事件 | 强杀实体，断言事件在窗口内到达且 `handle` 匹配 |
| SP-U1 | MUST（`updateResources`） | 改配额后 `inspect().resourceUsage` 或实体限额随之变化，且**不重建**（句柄不变） | 断言前后 `providerSandboxId` 相同 |
| SP-P1 | MUST（`pauseResume`） | pause 后 `inspect()` 为 `instance_paused`，resume 后回到 `instance_running` | 状态往返断言 |

> **已落地的条款**：**SP-00**、**CAP-01 的结构半场**（七位能力位齐全且都是 boolean，另可用 `opts.expectedCapabilities` 逐位钉死）、**CAP-02**（静态条款，无宿主需求；已做**反例验证**——把 `aio` 的 `headlessTask` 篡改成 `true` 而不挂面，CAP-01 与 CAP-02 双双变红并给出准确消息，还原后恢复绿，不是空转用例）——这两条无宿主需求，`aio`/`boxlite`/fake 一律无条件跑；**SP-01** 为 live 条款，只在传入 `opts.context` 时打开。其余 SP-02 ~ SP-12 / SP-T\* / SP-V1 / SP-W1 / SP-U1 / SP-P1 与 CAP-01 的**行为半场**（声明 false 的位调用即抛 `UNSUPPORTED_CAPABILITY`）**尚未进 testkit**——它们都要真宿主，属 live 条款，随 sandbox-run 切片补齐；其中 create→exec→destroy、stop→start 数据留存、重启重连等路径今天由 `docker-backend.e2e` / `boxlite-provider.e2e` / `boxlite-microvm.e2e` 单独覆盖（不是 testkit 形态，所以第三方实现复用不到）。

### 10.3 RuntimeAdapter 条款

| id | 级别 | 要求 | 怎么判定 |
|---|:--:|---|---|
| RA-01 | MUST | 洁净环境 `isInstalled()` 返回 false；`install()` 之后返回 true。**判定必须走 `command -v` / PATH 查找，不得硬编码安装路径** | 在干净镜像里跑完整安装往返，**并在两个 provider 上各跑一次**。⚠️ **判定理由已更正（§2.1★）**：旧理由"同一 runtime 在 aio（root，prefix `/opt/nodejs/22`）与 boxlite（uid 1000，prefix `/home/gem/.npm-global`）下装的位置不同"**已被推翻**——经平台 exec 通道实测两侧位置**相同**。真正的理由是：prefix 是**用户级非标准位置** `/home/gem/.npm-global`，且 `codex` 解析到 **fnm shim** `/home/gem/.fnm_shell/bin/codex` ⇒ 硬编码任何具体路径都会错，而"洁净环境返回 false"这一条**照样通过**、抓不到它。**双 provider 往返仍然保留**（理由改为防回归：两侧共用同一 data-plane 客户端，任一侧的镜像/PATH 变动都可能只在单侧显形），单侧跑绿不算数 |
| RA-02 | MUST | `install()` 可重入：中途失败后重跑能收敛到已安装 | 注入一次失败后重跑，断言最终 `isInstalled()` 为 true |
| RA-03 | MUST | `beginAuth()` 收到 `getAuthMethods()` 之外的 method 必须抛 `UNSUPPORTED_METHOD` | 传非法 method 断言 code |
| **RA-04** | MUST | `parseOutput()` / 鉴权解析器对**录制的真实 CLI 输出 fixture** 产出预期结果 | 回放各 CLI 版本的 golden fixture；这就是 05 §6"CLI 升级改输出格式导致静默失效"风险的落地防线——CLI 一改输出，此条第一时间红。**每支持一个新 CLI 版本必须新增一份 fixture** |
| RA-05 | MUST | `beginAuth()` 产出的 `AuthChallenge` 字段齐全（`instructions` / `challengeRef` 必填）且 `expiresAt` 是 ISO 绝对时间 | schema 校验；前端倒计时依赖 `expiresAt` 语义 |
| **RA-06** | MUST | `completeAuth()` 返回的 `credentialFiles[].content` 非空；**`containerPath` 必须是 `~/` 相对形态**（⚠️ **原判据「路径为绝对路径」已被 S5 裁决 D-19 推翻**，TASK-LAUNCH-DECISIONS T-6） | 结构断言（内容不入日志、不写快照）+ **断言 `containerPath` 不以 `/` 开头、以 `~/` 开头**。理由：`prepareRuntimeCredential(runtimeId)` 的签名里没有 sandbox，构造凭证时不知道目标沙箱的 `$HOME`；同一份凭证要能注入不同沙箱。绝对路径要么写死 `/root`（两个 provider 都错，§2.1★）、要么把凭证绑死在一个沙箱上 |
| RA-07 | MUST | `buildStartCommand()` / `buildAttachCommand()` 返回非空 `cmd`，且为纯函数（同输入同输出、无 IO） | 连调两次断言深相等 |
| **RA-08** | MUST | `id` / `displayName` / `vendor` 非空，且 `id` **等于注册键** | 三个字段断言非空 + `adapter.id === opts.registryKey`；registry 以 `id` 为键，对不上则 `GET /api/runtimes` 里那一行永远取不出 adapter |
| **RA-09** | MUST | `getAuthMethods()` 非空、无重复、且 ⊆ 契约闭集 `RUNTIME_AUTH_METHODS` | 逐项断言落在闭集里；前端鉴权页只认这四个值，越界的方式渲染不出来 |
| **RA-10** | MUST | 每个声明的**交互式**方式（∈ `RUNTIME_BEGIN_METHODS`）`loginCommand(method)` 返回非空 argv，且是纯函数 | 断言 argv 非空、每个 token 非空字符串，连调两次深相等。非交互式方式（api-key / access-token-paste）允许抛 `UNSUPPORTED_METHOD`，不做断言 |
| **RA-11** | MUST（声明了 `validateApiKey`） | 明显非法串必须被拒 | 喂 `''` / 空白 / 带空格串（可由 `opts.extraInvalidApiKeySamples` 追加本 provider 特有的反例）断言 `ok:false`；合法样例由 `opts.validApiKeySample` 传入，断言 `ok:true` |
| **RA-12** | MUST（声明了 `credentialTtlMs`） | 键 ⊆ `RUNTIME_AUTH_METHODS` **且 ⊆ 自己 `getAuthMethods()`**，值为正有限数 | 逐条断言；值显式为 `undefined` 视同"无过期"（等价于不写），跳过。给一个自己不提供的方式配 TTL = 死配置 |
| **RA-13** | MUST（声明了 `refreshCapability`） | `probeCommand` 非空、`parseRefreshedAuth` 是函数 | 结构断言；刷新扫描器（05 §5.1）就靠这两样，缺一它会静默跳过该 runtime |
| **RA-15** | MUST | **真 `refresh_token` 禁进沙箱（P0-3 的机械验证，S5 裁决 D-18）**：`injectCredential()` 交给 `exec` 的**全部字节**里不得出现该凭证的真 `refresh_token` 值 | 用假 `SandboxExecFn` 捕获**三条通道的全部字节**——argv、stdin、以及任何写文件命令的内容（含 heredoc / `printf` 参数）——断言不含真 `refresh_token` 子串。**与 RA-14 的区别**：RA-14 只查 argv（env 是合法通道），本条查**全部**，因为 refresh_token 走**任何**通道进沙箱都是违规 |
| **RA-16** | MUST（产出 auth 文件的 runtime） | 注入产物里 `refresh_token` **字段保留、值恰等于占位常量** | 解析注入的 auth 文件内容，断言 `tokens.refresh_token === RUNTIME_REFRESH_TOKEN_PLACEHOLDER`（shared-kernel 常量）。**不能是缺失、也不能是空串**——删字段会让 codex 报 `missing field 'refresh_token'`（05 §1★★ 实测） |
| **RA-17** | MUST | **`authFile` 非空时仍不泄漏**：用一条「凭证确实带着完整 auth.json 存在库里」的用例跑 RA-15/RA-16 | 构造带真 `authFile` 的凭证记录 → 走完整 `prepareRuntimeCredential → injectCredential` 路径 → 断言 RA-15/16 仍然通过。**这一条专门盯「分支漏改」**：注入与刷新此前共用同一个对象，只要有一个分支忘了脱敏就泄漏（裁决 D-18 用类型分家把它变成编译期问题，本条是运行期复核） |
| **RA-14** | MUST | **密钥禁进 argv**：`injectCredential()` 构造的任何命令行都不得含凭证明文 | 用假 `SandboxExecFn` 捕获全部 argv，断言不含任何给定密钥片段（契约纪律来自 05 §4/§7 #3——`/proc/<pid>/cmdline` 在沙箱内可读，进了 argv 就是泄漏）。**只查 argv，不查 env**：api-key 形态本来就走 env 在沙箱启动时注入（05 §4.1 ④），查 env 会把合法通道判成违规 |

> **已落地的条款**：**RA-03、RA-08 ~ RA-14**——全部零 CLI、零网络，`codex` / `claude-code` 两个真实内建 adapter 无条件跑（`packages/modules/runtime/test/contract/builtin-adapters.contract.spec.ts`）。
>
> **与上表的差异**：
>
> - **RA-01 / RA-02（安装往返）**：S4 的 `RuntimeAdapter` 契约里**还没有** `isInstalled()` / `install()`（见 `runtime-adapter.contract.ts` 顶部 NOTE：run 方法随后续 sandbox-run 切片加），无从断言。
> - **RA-04（golden fixture 回放）**：不在 testkit 里，而在各 adapter 自己的解析器单测（`packages/modules/runtime/test/unit/output-parsers.spec.ts`）——fixture 是**每个 CLI 特有**的，做成通用套件参数收益低；`packages/contracts/src/testkit/fixtures/CLI-VERSION-MATRIX.md` 仍是版本矩阵的登记处。
> - **RA-05 / RA-06**：要真跑一次 `beginAuth`/`completeAuth`（真 CLI + 真浏览器授权），不属"零 CLI"范围。
> - **RA-07**：`buildStartCommand` / `buildAttachCommand` 同样还不在 S4 契约里；其"非空 argv + 纯函数"的判定纪律已由 **RA-10** 用在 `loginCommand` 上。
> - **RA-15 / RA-16 / RA-17（S5 新增）**：要等契约层的类型拆分（`InjectableRuntimeCredential` / `RefreshableRuntimeCredential`）与 shared-kernel 占位常量落地后才能写；三条都是**零 CLI、零网络**（假 `exec` 即可），落地后进无条件跑的那一组。落点见 25 §3.4 / §4.3。
> - **RA-06 的判据已随 D-19 改写**（上表），实现时注意别照抄旧的"绝对路径"断言。
> - **RA-03 的判定放宽**：`contracts` 里没有 adapter 错误**类**（`AdapterAuthError` 在 runtime 的 domain 层，第三方拿不到），所以断言是"必须 reject；若错误对象带 `code`，则必须是 `UNSUPPORTED_METHOD`"——裸 `Error` 容忍，错的 `code` 不容忍。

### 10.4 ImageSpecProvider 条款

| id | 级别 | 要求 | 怎么判定 |
|---|:--:|---|---|
| IS-01 | MUST | 合法 ref → 完整 manifest 且 `digest` 非空 | 断言 digest 存在——没有它就谈不上"不可变坐标" |
| IS-02 | MUST | 不存在的 ref → 抛 `REF_NOT_FOUND` | 断言 code |
| IS-03 | MUST | `validate()` 违反入口约定 → `valid:false` 且 `errors` 非空并带可定位的 `path` | 断言 errors 结构，不接受只给 `valid:false` |
| IS-04 | MUST | `validate()` 是纯判断，不修改入参、不产生副作用 | 深冻结入参后调用，断言不抛 |
| IS-05 | **MUST**（2026-08 由 SHOULD 升级，随「tmux 升 MUST」） | **缺 tmux ⇒ `valid:false` 且 `errors[]` 含 `IMAGE_TMUX_MISSING`**（§7）；真正的非致命项（如 `supportedRuntimes` 声明的 CLI 未预装）才走 `warnings` | 两个断言都要：① 无 tmux 的镜像 → `valid:false` 且 errors 命中 `IMAGE_TMUX_MISSING`；② 有 tmux 但未预装 CLI 的镜像 → `valid:true` 且 warnings 命中对应 code。**原条款（存档）**：本条曾是 SHOULD、要求「缺 tmux 走 warnings 而非 errors、该镜像 `valid:true`」——与 §7 当时把 tmux 定为 SHOULD 配套；tmux 升 MUST 后该断言会**反向**判定，必须整条改写而不是删掉 |

> **落地状态（⏳ 全部未实现）**：ImageSpec contract 本身还没有（`packages/contracts` 里没有 `image-spec.contract.ts`），`IMAGE_SPEC_REGISTRY` 只是一个占位 token（§8），所以本表五条一条都跑不了。整块随**镜像管理切片**落地。

## 11. 风险与备选


| 风险 | 缓解 |
| --- | --- |
| 插件进程内加载信任问题 | 文档明示；长期 worker_threads / 子进程隔离壳 |
| contract 过早固化 | capabilities + 可选方法渐进扩展；minor 版本加能力 |
| 第三方实现质量参差 | §10 的 MUST 条款作准入线 + 内建实现同标准 |
| 事件流断连漏事件 | §6 重连补偿对账 |
| **`aio` 上游镜像变更**（agent-infra 改入口/端口/预置 CLI） | ImageSpec `validate()` 校验入口约定 + 锁 digest（§7 IS-01）；testkit 在 CI 定期对最新镜像回归 |
| **`boxlite` 相对年轻**，能力位可能随版本变动 | 能力位由实现在注册时**实测上报**而非硬编码；CAP-01 条款保证声明与行为一致，不一致启动即 fail-fast |
| **runtime CLI 自带的内层沙箱在外层沙箱内起不来**（codex bwrap：mount ns 在 aio/boxlite 两侧都被拒 → 鉴权成功但文件操作全被拦，表现为"agent 说改不了文件"） | `buildStartCommand` per-runtime 关掉内层（§3 ★2）；**不为它给容器加 `SYS_ADMIN`/`seccomp=unconfined`**——那是拿真正起作用的外层去换一层冗余的内层 |
| **runtime CLI 现装拖垮创建链路**（实测 12.5 分钟） | §7 加严为强烈建议预装；`getInstallPlan` 按（镜像, runtime）对判定并回填 `runtime_installations.status` 初值（13 §2.3.2），前端据此提示换镜像（§3 ★1） |
| **平台侧硬编码沙箱内路径**（`/root`、npm prefix、CLI 安装位置）静默失效——**风险来源已更正**：不是"两 provider 路径不同"（实测相同，§2.1★），而是路径本身是**用户级非标准位置 + fnm shim**，且随镜像/CLI 版本漂移 | §2.1★ 的实测表 + 方法论条款（运行时事实一律经 `provider.spawn()` 取得，不用 `docker run` 通道量）：凭证物化按 `$HOME` 展开、`isInstalled` 走 `command -v`；§10.3 RA-01 要求双 provider 各跑一次安装往返，单侧跑绿不算数 |
| 契约发包带来的版本碎片（多个插件锁不同 major） | peerDependencies 让冲突在**安装期**暴露而非运行期；平台同时只支持一个 major |


