# 03 - Sandbox 调度中心设计

> 状态：✅ 可评审（基于 2026-08 调研结论；§4.0–4.2 / §7 / §8 按产品定稿 P20·P22·P21-6·P21-7 补充）
> 关联文档：[01 后端目录结构](./01-后端目录结构与DDD分层.md) · [04 Contract 体系](./04-Contract与Registry扩展体系.md) · [11 部署与扩展预留](../shared/11-部署与扩展预留.md)
> 产品依据：[P20 §9](../product/20-核心使用链路.md) · [P22 §1/§4](../product/22-异常场景与产品补充要求.md) · [P21-6 项目](../product/pages/21-6-项目管理.md) · [P21-7 自动化](../product/pages/21-7-自动化.md)

## 1. 资源模型

```typescript
interface ResourceQuota {
  cores: number;      // 可小数，如 0.5
  ramMb: number;
  diskMb?: number;
}

interface ResourcePoolSnapshot {
  totalCores: number;
  totalRamMb: number;
  totalDiskMb: number;     // ← 磁盘进调度（审计 P1-9）：它才是本平台的真实瓶颈
  usedCores: number;
  usedRamMb: number;
  usedDiskMb: number;
}
```

- **quota 值的来源（产品决策：用户不暴露配额概念）**：创建 sandbox 时用户**不输入**任何资源参数——平台自动决定：以镜像的 `resource_defaults`（04 §7 / 13 §2）为基础，后端策略可按 runtime/当前负载调整；REST/MCP API 保留**可选** quota 参数供程序化消费方（如上层 agent）使用，缺省即自动。调度、配额登记、对账等内部机制不变。
- 启动时探测宿主机资源：`os.cpus().length` / `os.totalmem()`。
  - ⚠️ **这两个 API 在容器里报的是宿主的值，不是 cgroup 限额**，而平台自己就是以 docker-compose 形态部署的：一个被限到 2 核 4GB 的 api 容器会以为自己有 64 核 512GB，然后按那个数发配额。落地时因此加了三个显式覆盖 `SCHEDULER_HOST_CORES` / `SCHEDULER_HOST_RAM_MB` / `SCHEDULER_HOST_DISK_MB`（不填则退回探测；裸装单机时探测是对的）。**可用空间刻意不可覆盖** —— 声明总量是策略，声明可用量就是直接对着 `statfs` 撒谎。
- **安全余量**：默认保留 15% 给宿主 OS 与平台自身进程（可配置：`SCHEDULER_SAFETY_MARGIN`，取值 `[0,1)`）。
- **超配策略**：CPU 允许超配（`overcommit.cpuRatio`，如 1.5——AI CLI 多为突发负载）；**内存不超配**（防 OOM）；**磁盘不超配**（超配等于必然写满）。落地为 `SCHEDULER_CPU_OVERCOMMIT`（默认 1.5）；内存与磁盘只乘安全余量，没有对应旋钮 —— 那是有意的，不是漏了。
- **磁盘参与调度（审计 P1-9）**：工作区是宿主目录（§7.1），一个 Task 副本 ≈ 仓库体积；十几个 Task 就能写满盘，而 CPU/内存往往还很闲——**磁盘才是本平台的真实瓶颈**，必须进调度而不是只在准备阶段做一次预检。
  - 登记：创建时在**互斥区内**按 `projects.baseline_size_bytes × 1.2`（空项目取配置下限，默认 512MB）登记 `resource_allocations.disk_mb_reserved`；**消除 TOCTOU**——原先"准备阶段才预检"的写法在并发下会让 N 个 Task 同时通过预检然后一起写满盘。
    - ✅ **已落地**（`diskMbForBaseline` / `planQuota`，见 §3 的落点说明）。⚠️ 实现把「配置下限」做成了**全局下限**（`max(下限, ×1.2)`）而不是只在「空项目」那一格生效：按 ×1.2 直算，一个 3MB 的仓库会登记 4MB —— 而工作区里最终躺着的不只是基线（git 对象、依赖、构建产物、agent 写下的东西），`disk_mb_reserved > 0` 的 CHECK 也不接受向下取整成 0 的算法。下限旋钮是 `SANDBOX_DISK_FLOOR_MB`。
    - ⚠️ **`projects.baseline_size_bytes` 经 `ProjectFacade.getRuntimeContextForTask` 透出**（新增字段 `baselineSizeBytes`，`null` = 还没量过）；换算规则住在 sandbox 上下文，project 侧只报原始字节。
  - 释放：与 CPU/内存同时释放；但**保留目录（§7.7）占用的磁盘不进资源池**（它已脱离 sandbox 生命周期），改为治理视角展示（P21-5 水位 + 保留卷占用横幅）。
  - 探测：`statfs(DATA_ROOT)` 取总量与已用；同样留 15% 安全余量。

## 2. 调度策略（可切换）

```typescript
interface SchedulingStrategy {
  trySchedule(request: ResourceQuota, pool: ResourcePoolSnapshot): SchedulingDecision;
  // SchedulingDecision = { ok: true } | { ok: false; reason: string }
}
```

| 策略 | 状态 | 适用 |
|---|---|---|
| **First-Fit（默认）** | 首期实现 | 单机场景足够，实现简单、延迟低 |
| Best-Fit | 接口预留 | sandbox 数量多、资源碎片化明显时切换 |
| NodeSelector + 节点内 first-fit | 多节点预留 | 先选节点再节点内调度，核心算法不变（见文档 11） |

调度策略是 `domain/services/scheduling.domain-service.ts` 内的纯函数逻辑，无 IO，可单测穷举。

## 3. 并发控制（防超分配）

> **✅ 已落地（2026-08-31 互斥登记切片）。** 落点：
> `api/packages/modules/sandbox/src/application/resource-allocator.ts`（`async-mutex` 临界区）+
> `domain/services/resource-pool.domain-service.ts`（纯函数：`snapshotOf` / `trySchedule` /
> `planQuota`）+ `resource_allocations` 表（13 §2.1.3，`drizzle/0019`）。
>
> ⭐ **这是 `RESOURCE_EXHAUSTED` 在本平台的第一个真实抛出点。** 此前全仓 grep 该码只有枚举
> 定义、HTTP 映射表、automation adapter 的 catch，以及两个自己造错误的 spec —— **零个 throw
> 点**。叠加 `SandboxApplicationService.create` 的后半段是 `void provision.runSafely(...)`，
> 容量类失败根本不在 `createSandbox` 的调用栈上，于是 §8.2 决策表行 3 连同它下面那一整套
> （`queueRetry` / `listPendingRetries` / `retry_at` / 「已排队 n/5」）全是死代码，而真实的
> 资源不足走「后台 provision 失败 ⇒ 记一次失败 ⇒ `consecutive_failures++`」——机器一忙，一条
> 只是排队等资源的规则连撞三次降频、十次自动禁用（I-AUT-1 明说那不是规则的错）。
>
> **登记因此必须发生在 `create` 同步返回之前**（互斥区里那一小段读-改-写），而耗时的
> provision 照旧在临界区外异步跑 —— 两件事，不能合并。
>
> **✅ `SchedulerQueue`（FIFO）已落地** —— `application/scheduler-queue.ts`。上一轮它只是
> `ResourceAllocator` 内部一个裸的 `async-mutex`：行为对（`async-mutex` 本身按 `acquire()`
> 的调用顺序放行，就是 FIFO），但本节要的两件事一件都没有 —— 没有可以指名道姓的队列对象，
> **也没有队列深度可观测**。现在互斥与排队都归队列，`ResourceAllocator` 只负责「判定什么、
> 写什么」。三条落地口径：
>
> - ⚠️ **队列与互斥区在实现里是同一个东西，不是两层。** 下面那张图把「SchedulerQueue」与
>   「互斥区」画成前后两格；单机单进程下，一个一次只放行一个的 FIFO **就同时是**这两格，
>   再套一层 mutex 只会多一次可以死锁的嵌套。图保留（它讲的是概念顺序），但别照着它去找
>   两个对象。
> - ⚠️ **进队列的是「读-改-写资源池」那一小段，不是整个请求。** 本节第 3 条说慢 IO 在临界区
>   **外**并行，而字面意义上的「所有创建/销毁请求先进队列」会把 `provider.destroy()` 那几十秒
>   也串起来 —— 两条自相矛盾，按第 3 条办：`create` 进的是配额登记，`destroy` 进的是配额释放。
> - ⭐ **第三类请求：对账。** 13 §4 的判孤儿 + 释放同样是对账本的读-改-写，也排这条队 ——
>   不排的话，「用户按了销毁」与「对账判它是孤儿」可能同时改同一行登记，后到的那次撞上
>   I-RA-1「释放不可回退」抛异常，而那是一个只在真实并发下出现的偶发。
>
> **可观测落在哪（本轮的选择）**：**审计流** —— `AUDIT_RECORDER` → `audit_events` →
> 已有的 `GET /api/system/audit`（13 §2.8.2 的写入口 ②），type `sandbox.scheduler.queued`；
> 外加一条深度告警日志（`SCHEDULER_QUEUE_WARN_DEPTH`，默认 8）。
> ⛔ **没有新造 HTTP 端点，也没有改 `GET /api/system/resources` 的响应形状** —— 那会连带动
> 10 §6 / 27 与两仓 codegen，而这条信息今天还没有前端消费方。
> ⚠️ **只有真的排过队才记一条**（入队时前面有人），与 §7.8「`sandbox.health` 只在翻转时记，
> 不是每 30s 记一条」是同一条纪律：空闲平台上每次创建都记一行「深度 0」，等于把审计面板变成
> 运行日志。⚠️ 判据是**深度**不是耗时 —— 耗时要读 `Clock`，而测试里的 `Clock` 是可冻结的，
> 用 `waitedMs > 0` 当判据会让这条分支在单测里永远走不到（`waitedMs` 仍照记，它是 detail）。
> ⚠️ **只读的容量探测（决策表行 3 的判据）不进队列**：它没有读-改-写，而「队列深度」这个数字
> 的意思是「有多少创建/销毁请求卡在调度上」，把自动化每分钟一次的探测算进去，那个数字就
> 开始撒谎。
>
> **两道闸，各挡各的**（实现在 `trySchedule`）：① **账本闸** `已登记 + 本次 ≤ 池子上限`，挡
> 并发超分配；② **物理闸** `statfs` 的可用字节 ≥ `WORKSPACE_MIN_FREE_BYTES`，挡账本看不见的
> 占用（别的程序、日志、保留卷）。②复用的就是工作区复制前那道预检的同一个环境变量 ——
> 把它提前到互斥区里，正是 §1「必须进调度而不是只在准备阶段做一次预检」那句话的意思；
> §7.6 里那一次**不删**（它覆盖「登记之后、复制之前，别人把盘写满了」）。

- **能力静态校验是创建链路的第 0 步**，在进队列之前就把不可能成功的请求挡掉（详见 §3.1）。
- 资源池"读-改-写"（校验剩余容量 → 登记占用）必须在**临界区**内完成：`async-mutex` 或 Promise 链式队列，只把「配额登记/释放」这一小段串行化。
- 慢 IO（拉镜像、起容器）在临界区**外**并行执行；失败时回滚已登记配额。
- 所有创建/销毁请求先进 `SchedulerQueue`（FIFO），保证公平性与可预测性。✅ 已落地；**进队列的是各自那一小段读-改-写**，不是整个请求（理由见上方落地说明），对账是第三类。

```
请求 → [能力静态校验] → 解析项目 → 落 pending 记录 → SchedulerQueue(FIFO)
         │ 不满足                                              │
         ▼                                                     ▼
  409 UNSUPPORTED_CAPABILITY              [互斥区: 校验+登记配额] → 并行: 拉镜像/create/start
  （零副作用：不落库、不进队列）                        │ 失败
                                                      ▼
                                              回滚配额登记 → 状态 failed
```

### 3.1 创建前的能力静态校验（04 §5 「创建前静态校验」的落点）

`SandboxApplicationService.assertCapabilities()` 是创建链路上**第一个**执行的检查，位置在 `create()` 的最前面——**早于项目解析、早于落库、早于进调度队列**。两条规则：

| 规则 | 判定 | 为什么是无条件/可选 |
|---|---|---|
| **`spawnTty` 无条件必需** | 所选 provider `capabilities.spawnTty === false` → 直接拒绝，**与请求传没传 `require` 无关** | 本平台每个 agent runtime 都要 TTY（终端页 + runtime 鉴权入口，04 §2.5 `spawnTty` 行）。不支持 TTY 的 provider 承载不了**任何** sandbox，与其让它建完再在终端环节失败，不如建不出来 |
| **`require.*` 逐位校验** | 请求显式要求某位为 `true` 而 provider 声明 `false` → 拒绝。可要求的位：`spawnTty` / `volumeMount` / `updateResources` / `pauseResume` / `snapshot` | 调用方对隔离档位有硬需求时（如"必须能快照"），**宁可在入口拒绝，也不要深入到 provisioning 里才炸**。**刻意不含 `watchEvents`**——push/poll 对调用方完全封装（04 §5），要求它没有可观测意义 |

两条都抛 `SandboxProviderError(UNSUPPORTED_CAPABILITY)`，经 04 §4 同一张 contract→HTTP 映射表出 **409**。这是 `UNSUPPORTED_CAPABILITY` 在平台里的**第一个真实抛出点**（此前该码只存在于映射表中）。

> **"零副作用"是这一步的关键性质，不只是"早"**：校验失败时**没有 sandbox 记录落库、没有配额登记、`provider.create()` 一次都没被调用、不产生任何 WS 事件**（单测 `capability-negotiation.spec.ts` 逐条断言 `provider.create` 未被调用且仓储零行）。因此调用方拿不到 sandbox id，前端**不应**按"创建失败可重试"渲染，而应就地提示改选 provider——这与 `WORKSPACE_PREPARE_FAILED` 那类"已落库、已进调度、中途失败"的错误在产品语义上完全不同（27 §2）。
>
> 顺带一提，**放在项目解析之前也是有意的**：能力不匹配是"这个请求本身不可能成功"，与项目存不存在、能不能接任务无关；先做项目解析只会让一个必然被拒的请求多打一次 DB。
>
> ⚠️ **§3 的配额登记落在这道门之外，门的「零副作用」因此原样保住**（`capability-negotiation.spec.ts` 那几条断言未改一字）。互斥登记发生在 `admit()` 返回**之后**，它是这条链路上第一个会改变世界的动作。
> 由此产生一个刻意的取舍：容量不足的 `RESOURCE_EXHAUSTED`（429）**事实上也什么都没写**（登记与落库同一个事务，判定在写之前），但它的信封里**不带 `sideEffectFree`**。理由是那个标记的可信度来自它是**位置**决定的 —— `atDoor` 包住的那一段结构上就碰不到 `uow`；在门外手写一个 `true`，等于把一条结构性事实退回成「每个抛出点各自记得」的承诺，而 `create-door.spec.ts` 整个守卫就是冲着这件事来的。缺席 = 保守读法，而 `retryable:true` 已经把用户真正需要的下一步（等一会儿再来）说清楚了。

## 4. 生命周期状态机

```
pending → scheduling → preparing-workspace → creating → starting → running ⇄ idle → stopping → stopped
               ↘              ↘                 ↘          ↘         ↘
                failed（可重试回 scheduling，或转 destroying）
stopped → starting          （重新拉起，复用已有工作区目录）
stopped/failed → destroying → destroyed（终态）
```

> **顺序定案（审计 P0-1 连带项）**：`preparing-workspace` 在 **`creating` 之前**。工作区是宿主目录（§7.1），必须在 `provider.create()` 之前就绪——否则创建实例时挂载源还不存在，04 §2.4 的 `volumes` 语义无法自洽。原先"先建实例再准备工作区"的顺序是 named volume 时代的遗留。

实现要点：

- 领域层**显式转移表 + guard** 实现（不引入 XState 这类较重依赖，接口设计不排斥未来替换为 XState v5）。
- **镜像拉取的职责归属（审计 P2-10）**：`creating` 阶段的"拉镜像"由 **`provider.create()` 内部负责**（04 testkit SP-03 要求镜像不存在时抛 `IMAGE_PULL_FAILED`），平台**不单独调用任何拉取接口**；`ImageSpecProvider.resolve()`（IS-01）只做**元数据解析与 digest 获取**，不拉层数据。两者职责不重叠：一个负责"这个 ref 长什么样、合不合规"，一个负责"把它变成能跑的实体"。
- **provider 拉镜像的两档差异 + agent 就绪门（权威见 [SANDBOX-RUNTIME-DECISIONS](../SANDBOX-RUNTIME-DECISIONS.md)）**：aio 走 Docker（socket-proxy）；**boxlite 走 BoxLite 自己的 OCI store（独立于 Docker、层下载不断点续传），落地须经本地 registry（`localhost:5001`）预置目标镜像**——自定义 `imageRegistries` 会替换默认表，必须显式保留 `docker.io`。⛔ **这里原写「aio 走 docker，本地 `docker build` 出来的镜像直接可用、不必 push ⇒ 只跑 aio 的单机部署不需要自建 registry」——那是错的**（2026-08-29 真 Linux 实测推翻，2026-08-30 复验；权威见 [api/images/README.md](../../api/images/README.md) §「要不要 push」）。镜像要过**两道**关，查的是两个不同的地方：**注册/开机播种**走 `OciImageSpecProvider` → **registry 的 HTTP API**，从不问 docker daemon；只有**起容器**那一步才用 docker 的本机镜像库。⇒ 一张只存在于本机、没 push 过的镜像过不了第一关，平台「一张预制镜像都没有」，`POST /api/sandboxes` 直接不可用。**两档都需要一个够得着的 registry，只是需要它的「时刻」不同。**此外，`starting → running` 前须**探测数据面就绪**——终端/exec 依赖它，未就绪即转 `running` 会让首个终端连接失败。⚠️ **探什么按档分**（决策 A 修订）：`aio` 探沙箱内 API（`:8080`）；`boxlite` 走 BoxLite native 通道，**不需要沙箱内 API、也不转发端口**。

  ⚠️ **那条 ⏳ 安全账因此只剩 aio 一档**（而且**只在默认部署形态下**：配了 `SANDBOX_DOCKER_NETWORK` 时端口一个都不发布，见 [11 §1.4](../shared/11-部署与扩展预留.md)）：agent 端口 publish 到宿主 loopback（`127.0.0.1` + 临时端口），**宿主本地任意进程可直连一个无鉴权 shell**——`aio` 靠每沙箱一把 `SANDBOX_API_KEY` 兜住（⚠️ 2026-08-29 从平台自造的 RS256 JWT 换成**镜像原生**的那套：`gem.sh` 两个 env 都认、走同一扇 nginx `auth_request` 门，鉴权强度不变，换掉的是我们自己维护的密码学代码；头用原生的 `X-AIO-API-Key`，WS 仍走 `POST /tickets` 换短票而**不用** `?api_key=`——query 会进沙箱自己的 access log，而这把钥匙的寿命是整个沙箱）；`boxlite` ⚠️ **不是「消失」而是「换了把锁」**：BoxLite 把镜像 `EXPOSE` 的 8080 **自动发布到宿主通配地址且关不掉**（实测 IPv6 `*:8080`，局域网可达），所以它注入 `JWT_PUBLIC_KEY` **只上锁不留钥匙**——私钥当场丢弃、不签 token、不落库，平台自己也进不去（数据面全在 native 那侧）。⏳ 仍是残留风险：那扇门对外可达，只是回 401。详见 ADR 决策 A 修订。权威登记见 [SANDBOX-RUNTIME-DECISIONS](../SANDBOX-RUNTIME-DECISIONS.md)「安全姿态」。
- **`starting` 段内有五步编排**（`provider.start` → **数据面就绪探测**（aio=沙箱内 API / boxlite=native 通道）→ 装 CLI → 注入凭证 → 起 agent 会话），见 **§4.3**——顺序被「exec 要求实例已在跑」这条物理约束钉死。
- 每次转移落库并发 `SandboxStateChanged` 领域事件 → WS 事件通道推送前端 + terminal 上下文级联处理。
- **idle 回收**：可配置 `idleTimeoutSec`，后台 `SandboxReaper` 定时扫描，无活动则 running→idle→stopped，**释放配额但保留数据卷**，可快速重新拉起。判定口径见 §4.2。
- 非法转移抛领域错误，interface 层翻译为 409。
- **对账特权转移**：对账（文档 13 §4）判定 orphaned 时，允许从**任意非终态**直接转 `failed`——reconcile 属于特权路径，不受常规转移表约束，但同样落库转移历史（`triggered_by: 'health-check'`）。

### 4.0 `preparing-workspace` 细分态：**加**（产品 P20 §9.6 待评估项的技术定案）

**结论：作为正式状态值加入状态机与 `sandboxes.status` 枚举**（13 §2 同步），位于 **`scheduling` 与 `creating` 之间**（审计 P0-1 修订——工作区必须先于实例存在）。

理由（三条，缺一条都不足以升格为状态）：

1. **产品进度卡的四个阶段是定稿契约**（P20 §3.3：初始化 → 拉取镜像 → 准备工作区 → 启动实例）。若不加状态，前端只能靠事件里的自定义 phase 字段推断阶段，UI 阶段与状态机两套真值必然漂移；加了状态，`sandbox.status_changed` 一条通道同时喂状态与进度。
2. **它是可失败、可耗时、可取消的独立阶段**：Task 级工作区副本准备（§7.6）要复制整个仓库，几十秒到数分钟；失败有专属错误码 `WORKSPACE_PREPARE_FAILED` / `DISK_INSUFFICIENT`（P22 §1），与拉镜像失败必须能被用户区分。
3. **它有专属的失败清理动作**：半成品**目录**必须删除（§7.6 `rm -rf`），而 `creating` 失败清理的是实例。清理动作不同 = 状态不同。

代价与边界：`sandboxes.status` 枚举加一个值（drizzle 双方言 CHECK 同步改，13 §5）、转移表加两条边（`scheduling→preparing-workspace`、`preparing-workspace→creating|failed`）。`stopped → starting` 的重新拉起**不再经过**该状态（工作区目录已存在，无需重复准备）。

> 产品侧的四阶段进度卡（P20 §3.3「初始化 → 拉取镜像 → 准备工作区 → 启动实例」）**展示顺序与技术顺序不同**：技术上先备工作区再拉镜像/建实例。进度卡是**面向用户的叙述**，不是状态机的镜像——前端按 `sandbox.status_changed` 映射到四个格子即可（`preparing-workspace` → 「准备工作区」，`creating` → 「拉取镜像」）。这条差异必须写在前端状态映射表里，否则会有人以为状态机顺序错了。

### 4.1 `waiting-input` 子态（产品 P20 §9.8 / P21 §2.1 的技术定案）

**它不是状态机的第 12 个状态，而是 `running` 的运行时子态。**

| 方面 | 定案 |
|---|---|
| 归属 | `running` 之下的布尔子态，**不写 `sandboxes.status`、不进 `sandbox_state_transitions`**——它每次输入输出都可能翻转，落库会造成写放大与转移历史噪音（一个 10 分钟会话可能翻转上百次） |
| 检测位置 | **TerminalGateway（网关侧）**——它是唯一持有已解复用 pty 字节流的地方（06 §8）；provider / adapter 不介入，避免每个实现各写一份启发式 |
| 判定 | pty 输出**静默 > N 秒**（`terminal.waitingInputSilenceSec`，**默认 10s**，可配）**且**该会话最后一个非空行匹配提示符启发式正则集 |
| 恢复条件 | **任意 pty 输出**或**任意用户输入帧**立即回 `running` 并推送——两者都是"不在等待"的确证，不设去抖延迟 |
| 适用范围 | 仅对**存在 attached tty 会话**的 sandbox 检测；无头 Task（`headless: true`）不参与，其"卡住"由硬超时兜底（§8.3）。sandbox 有多个终端会话时，**全部会话都判定为等待**才上报子态（任一会话在刷输出即说明 agent 在干活） |
| 上报 | WS `sandbox.waiting_input { sandboxId, waiting: boolean, sessionId? }`（10 §3）；REST `GET /api/sandboxes` / `GET /api/sandboxes/:id` 响应带派生字段 `waitingInput: boolean`（由网关内存态提供，供前端刷新后恢复展示） |
| 与 idle 的关系 | 两者互不抑制：waiting-input 期间 `last_active_at` **照常不更新**，idle 计时正常推进——"等待用户输入"本身就是空闲，静默 30min 依然应被回收（P22 §2 的 idle 文案与此一致） |

**误报容忍度（必须写进实现注释与测试用例）**：提示符启发式是**不可能做准的**——agent CLI 的输出里出现形似提示符的文本、或 agent 长时间思考不输出，都会误报；反之 agent 用带动画的 spinner 持续刷新会漏报。因此定死一条红线：

> **`waiting-input` 只驱动展示，不驱动任何自动化决策。** 它不触发 idle 回收、不参与调度、不改变 `sandboxes.status`、不影响自动化调度器的 `PREVIOUS_RUNNING` 判定、不进入任何 SLA 统计。误报的最坏后果是列表上一个图标短暂显示错误，用户点进终端一眼即知。

调参方向据此确定：**宁可漏报不可误报**——阈值宁大勿小（10s 是折中；实测误报多则调到 15–20s），正则集宁窄勿宽。

提示符启发式正则集（可配置扩展，`terminal.promptPatterns`）：

```
/[>$#❯➜»]\s*$/          // 通用 shell / REPL 提示符
/\?\s*$/                 // 疑问句结尾（"Do you want to continue?"）
/\[[yYnN]\/[yYnN]\]\s*$/ // [y/N] 确认
/:\s*$/                  // "Enter your choice:" 类
```

判定前先剥离 ANSI 转义序列与光标控制码，再取最后一个非空行。

### 4.2 idle 判定口径（产品 P22 §2 的技术定案）

- **idle = 终端无输入输出**，**不是**进程 CPU 占用。理由：agent CLI 等待用户输入时进程照样有心跳/轮询开销，按 CPU 判定会把"人已经走了"的会话永远判成活跃；反过来 agent 跑长任务时输出不断，终端流量天然覆盖。
- `sandboxes.last_active_at` 的唯一写入方是 TerminalGateway：每收到 pty `data` 帧或客户端 `input` 帧即刷新，**落库节流 ≥10s 一次**（内存里实时、DB 里粗粒度，Reaper 的分钟级扫描不需要秒级精度）。
- **无终端会话的 sandbox**：无头 Task 不走 idle 回收（无终端可言），只受硬超时约束（§8.3）；交互式 Task 的终端全部关闭后 `last_active_at` 停止更新，idle 计时正常推进。
- **重启语义**：`stopped → starting` 开的是**新的 agent 会话**——tmux 现场恢复（06 §6）**只适用于 WS 断线重连**，不适用于 idle 回收后重启。stop 时 tmux server 随实例一起停止，重启后是全新 session；工作区文件在卷上保留。前端文案不得暗示"恢复现场"（P22 §2 已定文案）。

### 4.3 `starting` 段的五步编排（Task 真正开跑的地方）

> 权威裁决见 [TASK-LAUNCH-DECISIONS](../TASK-LAUNCH-DECISIONS.md) T-2 / T-3；时序见 24 §1、调用图见 26 §1。**本节不新增任何状态**——五步全在 `starting` 之内，失败一律按 `starting` 失败补偿（24 §1.3）。

```
creating  ─── ⓪ prepareRuntimeCredential → env 形态并入 SandboxProviderContext.env
              → provider.create(ctx)                          ← 见下方「凭证的两个注入时机」

starting ─┬─ ① provider.start(handle)
          ├─ ② 数据面就绪探测（aio=:8080 / boxlite=native）  ← §4 既有条款
          ├─ ③ ensureRuntimeInstalled(runtimeId, exec)        ← 装 CLI（T-3）
          ├─ ④ injectCredential → recordRuntimeInjection      ← 文件/stdin 形态注入（05 §4.3）
          ├─ ⑤ bootstrapAgentSession(sandboxId, initialTask)  ← 起 agent 会话（T-2）
          └─ running
```

**⚠️ 顺序是被物理约束钉死的，不是风格选择**：③④⑤ 都需要 `SandboxExecFn`，而 `exec` 由 `spawn({tty:false})` 派生（04 §2.3），要求实例**已经在跑**且数据面已就绪（aio=沙箱内 API，boxlite=native 通道）。因此 `provider.start()` 必须排在最前。**这同时更正了 24 §1 / 26 §1 里「先 `injectCredential` 再 `provider.start`」的既有错序**（05 §7.1 #2 的实现侧注记「provision 起容器后 prepare → inject → record 三步接入」本来就是对的，是两张图没跟上）。

#### ⚠️ 凭证的两个注入时机：**env 形态在 `create` 前，文件/stdin 形态在 `start` 后**（S5 实现修正，2026-08）

**本条修正的是本节原文的一处遗漏，不是实现走样**：原文把「凭证注入」整体画成第 ④ 步、排在 `provider.start()` 之后。这对**文件形态**（codex 的 `~/.codex/auth.json`）完全正确——它要 `exec`，而 `exec` 要实例在跑。但它对 **env 形态**物理上做不到：

- **claude-code 的账号凭证就是一个 env**（`CLAUDE_CODE_OAUTH_TOKEN`；api-key 模式的 `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` 同理）。`ClaudeCodeAdapter.injectCredential` 因此**没有任何 exec 动作**——它本就声明「env 在沙箱启动时施加」。
- **已经启动的进程无法追加 env**。等到第 ④ 步再谈 env 注入，那份凭证就永远进不了沙箱：agent 起来后是未登录状态，而平台会以为自己注入过了。
- 04 §2.3★ 与 05 §4.1 其实早已各自写明「api-key 形态的 env 注入落在沙箱创建时（`SandboxProviderContext.env`）」——**只是本节的五步图没有把这条时机画进去**，实现按图施工就会漏掉整个 env 通道。

**现在的口径（两个时机，一次解密）**：

| 形态 | 时机 | 怎么做 | 为什么只能在这 |
|---|---|---|---|
| **env**（claude setup-token / 各家 api-key） | **`creating` 段，`provider.create()` 之前** | provision 先调一次 `prepareRuntimeCredential(runtimeId)`，把 `cred.env` **最后**合并进 `SandboxProviderContext.env`（05 §4.1「凭证永远赢」靠的就是这个「最后写入」的顺序，不是黑名单） | 进程启动后加不了 env |
| **文件 / stdin**（codex 脱敏 `auth.json`、`--with-access-token`） | **`starting` 段第 ④ 步，`provider.start()` 之后** | 复用同一个凭证对象调 `adapter.injectCredential(cred, exec)` → `recordRuntimeInjection` → `finally cred.zeroize()` | 要 `exec`，而 `exec` 由 `spawn({tty:false})` 派生（04 §2.3） |

**三条要点，避免被读成「顺序松动了」**：

1. **`injectCredential` 的位置没有变**——它仍然严格排在 `provider.start()` 之后，25 T-SBX-31 的断言语义不变（它断言的就是「`injectCredential` 在 `provider.start` 之后」）。挪到前面的只有 `prepareRuntimeCredential` 这一次**解密取值**。
2. **只解密一次**：同一个 `InjectableRuntimeCredential` 对象横跨 `create` 与 ④，用完在 `finally` 里 `zeroize()`。解两次等于把明文在内存里多摊一份，没有任何收益。
3. **per-call `env` 不是替代方案**：`ProcessSpec.env` 现在虽然生效了，但它会被 agent 物化成 `export K=V` 拼进命令串，**沙箱内 `ps` 可见**（04 §2.3★ 第 2 条）。所以 env 形态的凭证只能走沙箱创建时那一条通道。

> **无凭证不算 provision 失败**（S5 实现裁定）：`prepareRuntimeCredential` 抛 `NO_CREDENTIAL` 时只记一条 WARN、照常继续起沙箱——用户完全可能先建任务再去授权，agent 自己会说「未登录」，这是可恢复状态，不该阻断创建。无头 Task 的「无凭证不触发」另由 §8.2 决策表第 2 条管。

#### ① `provider.start()`：整段 provision 里**最长、且曾经零反馈**的一步

> 2026-08-28 实测（本机 boxlite）：一个 Task 停在前端的「启动实例」格 **3 分 10 秒**，用户判它卡死；去排查的人第一次采样看到 CPU 0%、到 registry 零连接，**也判成了卡死**。审计流事后才说清楚：`sandbox.provision.stage`「starting」**190529ms**，而同一秒内的 `sandbox.probe` / `runtime_install` / `credential.injected` / `agent_session` 加起来不到 **0.4 秒**。⇒ 那 190 秒**全在这一步**：13GB 的 `platform/sandbox:v2` 本机首次使用，要现拉 + 铺 rootfs（微 VM 是**懒**的：`runtime.create()` 只要 ~4ms，第一次 exec 才真起）。

这一步**没有中间进度可读**——`provider.start()` 就是一个 `await`，只有「开始」和「结束」。所以平台**不编百分比**（本仓已经因为同一条理由删过 `project.clone_progress.totalBytes` 这个幽灵字段），推的是**两个边界**加**一个事实**：

| 推什么 | 事件 | 谁知道 |
|---|---|---|
| 这一步**开始了** / **结束了** | WS `sandbox.instance_progress{phase:'starting'\|'ready'}`（10 §7.4） | 只有平台 |
| **本机有没有这份镜像的位** | 同一帧的 `imageStaged?`，来自可选方法 `SandboxProvider.imageStaged(image)`（04 §11「minor = 新增可选方法」） | 只有 provider |
| 已经等了多久 | **不推**——前端从自己收到 `starting` 的那一刻数（10 §7.4 明写这条取舍） | 浏览器自己就知道 |

- **`imageStaged` 缺席 ≠ `false`**：缺席是「provider 说不出」（没实现这个可选方法，或这次问不出来），`false` 是「本机确实没有」。只有后者能拿去当「你要等几分钟」的理由，前者只能退回中性文案。
- **它是提示，不是闸门**：没有任何逻辑因这个布尔而拒绝、延迟或重排 provision；问不出来只记 WARN，**绝不让 provision 失败**——一句文案的输入把整个 Task 判死，是拿装饰品当承重墙。
- **不进 Outbox**（与 `runtime.install_progress` 相反）：丢一帧 `starting` 只让这一次等待退回中性文案，丢一帧 `ready` 会被随后必到的 `status_changed` 盖掉；而 install 进度后面没有别的东西跟上，丢了就永远钉在陈旧文案上。
- boxlite 侧的实现读的是 BoxLite 自己的 image store 索引（`image_index.reference`），**不是平台的任何一张表**——「这个镜像以前有沙箱跑成功过」是个会说谎的代理量（store 可能被清、上次也可能是拉了一半就失败的）。⚠️ 它有一个排除不掉的**假阳性**：`image_index.complete`（半截的 pull 是 0）没有透出到 SDK 的 `images.list()`，所以拉到一半的镜像也会被数成「有」。这正是前端 `true` 那一支只写「镜像已在本机」、**不承诺任何时间**的原因。

#### ③ `ensureRuntimeInstalled`：装 CLI

| 子步 | 做什么 | 落点 |
|---|---|---|
| `getInstallPlan(imageSpec)` | **纯函数**，判据是（镜像, runtime）这一对（04 §3 ★1） | 创建校验阶段也调它一次，但那次只用来**给用户提示**（「这张镜像上 claude-code 要装 12.5 分钟」），**不写库** |
| `isInstalled(exec)` | 走 `command -v` + `--version` **实测**，绝不硬编码路径（04 §2.1★） | 决定 `runtime_installations.status` 是 `installed` 还是 `not_installed` |
| `install(exec)` | 仅当上一步为 false 且策略为 `install-on-start`；期间状态转 `installing` | 可重入（实测重跑仅 6 秒，04 §3 ★1） |

- **写库全部在本段的短事务里，绝不进创建事务 T1**（13 §2.3.2 / 23 §4.3 已存档否决理由）。
- **进度可见**：`RuntimeInstallationStateChanged` → WS `runtime.install_progress`（23 §12 / 10 §3.1）。现装可达 **12.5 分钟**，没有这条事件前端只能盯着「启动实例」格子干等。
- **失败**：`starting → failed` + `failure_reason`（人话），错误码 **`INSTALL_FAILED`**（04 §4 / 02 §6.1 / P22 §1）；补偿动作与 `starting` 失败同（24 §1.3）。

#### ⑤ `bootstrapAgentSession`：让「启动时即执行」名副其实

产品 P20 §0 与 02 §5.2 都承诺「agent 启动时即执行」，但原设计把它绑在 `openSession` 的**首个会话**上（06 §3），后果有三：① 用户创建完关掉浏览器 ⇒ 指令永不执行；② **MCP `create_sandbox` 根本没有终端 ⇒ 必不执行**；③ S5 已 live 验证的「agent 真改文件」闭环在设计上没有触发路径。改为 provision 触发后三者同时消失。

- **命令选择**：`initialTask.prompt` 非空 ⇒ `buildStartCommand({ prompt, headless:false })`；为空 ⇒ `buildAttachCommand()`。成功后置 `initial_prompt_consumed_at`（23 I-SBX-10），**重启不重放**。
- **终端网关此后一律 attach 已存在的会话，自己不再判断「首次」**（06 §3 / 26 §8 已改写）。
- **只对 `headless=false` 执行**。`headless=true` 的执行路径属后续切片（§8.3 / TASK-LAUNCH-DECISIONS T-4），S5 内不起 agent。

**单档形态（tmux 是镜像**必须**项，04 §7；2026-08 用户裁决，取代原 A/B 两档）**：

| 步 | 做什么 | 失败怎么办 |
|---|---|---|
| ⑤.1 **自检** | 沙箱内 `command -v tmux` **实测** | **未命中 ⇒ 响亮失败**：`starting → failed` + `failure_reason`（人话："镜像缺少 tmux，不满足平台约定"），错误码 **`IMAGE_CONTRACT_VIOLATION`**（04 §4 / 02 §6.1 / P22 §1），补偿动作与 `starting` 失败同（24 §1.3）。**不得静默降级** |
| ⑤.2 **起会话** | `spawn({tty:true})` 跑 `tmux new-session -d -s platform-agent <cmd>`；会话由**沙箱内的 tmux server 持有**，平台侧不保持任何连接；网关此后一律 `tmux attach`（06 §3/§6） | 按 `starting` 失败处理 |

- **为什么仍要实测，而不是信 `validate()` 的结论**：与 04 §2.1★ 的方法论一致——沙箱内的运行时事实一律实测。`validate()` 是注册期的静态判定，镜像换 tag、上游换 base image 都可能让它过期。（原先写的「不用 `ResolvedImageSpec.supportsTmux` 判定」这条更强了一步：**那个字段已经删除**，04 §7 ★。）
- **为什么实测不过要响亮失败而不是降级**：这与「agent 鉴权自检失败即 `start()` 响亮失败」（[SANDBOX-RUNTIME-DECISIONS](../SANDBOX-RUNTIME-DECISIONS.md)「安全姿态」）是同一条纪律——自检的意义就在于不过就停，静默降级会把「镜像不合格」伪装成「产品行为不一样」，等用户在平台重启后丢了会话才发现。
- **被取代的 B 档（存档，勿当现状读）**：镜像无 tmux 时由**终端网关持有 `ProcessStream`** + 06 §6 的 ring buffer 兜底。**取消理由**：它的代价②是「平台进程重启 ⇒ pty 归属者消失 ⇒ agent 会话中断」，对一个把 Task 当第一概念的产品不可接受；且两个内建镜像本来就自带 tmux，这条降级路没人走却要平台长期养一个分支。完整轨迹见 04 §7 ★ 与 TASK-LAUNCH-DECISIONS T-2。
- **更早被否掉的第三种方案**：无 tmux 时把 `initialPrompt` 当无头任务跑（`spawn({tty:false})` + 日志文件）。它同时破坏「终端可观察」（用户点开终端看到的是与 agent 无关的干净 shell），并且**提前实现 T-4 里刚决定不做的那套东西**（输出传输 + 日志存储）。
- **实现期可选的快速失败**（不改本节五步语义）：⑤.1 的探测**可以前移到 ② 之后**当作「镜像约定自检」，好处是缺 tmux 的镜像不必先白等 ③ 现装 CLI 的十几分钟才失败。语义等价（同一次实测、同一个错误码），是否前移由实现切片定。

## 5. CPU 限额的两种模式（按 sandbox tier 提供）

平台只在 quota 上表达 tier 语义（hard / burst），具体施加方式是 provider 实现内部的事（04 §2.4：quota 由调度器登记，实现负责落到运行时）：

| 模式 | 语义 | 实现落点（参考） | 适用 |
|---|---|---|---|
| 硬 cap | 严格按 cores 上限 | aio：cgroup CPU 配额；boxlite：micro-VM vCPU 配置 | 强隔离场景，严格公平 |
| 软 cap + burst | 允许临时借用空闲算力 | aio：CPU shares + 软限制；boxlite：视版本支持 | 追求响应速度；建议默认留 20–30% burst 余量 |

内存统一硬限制（不超配）。

## 6. 与其他模块的边界

- 调度器只产出「决策 + 配额登记」；实际实例操作走 `SandboxProvider` contract（文档 04），调度器不依赖任何具体实现细节。
- 配额登记表持久化（重启后恢复资源池视图：扫描存活容器 + 落库配额对账）。
  - ✅ **已全部落地** —— `application/quota-reconciler.ts`：**开机全量**（`onApplicationBootstrap`）+ **运行期每 5min 增量**（`setInterval`，`unref` + `onModuleDestroy` 清理）。增量按 13 §4 的口径**只挑长时间未更新的活跃记录**（默认 30min 未核对，单轮上限 20 条，最旧的先来），不是每 5 分钟重扫一遍全部。
  - 三处实现口径（`instance_missing` 才算查无 / `inspect` 抛异常一律不动 / 不改 `sandboxes.status`）**两条路径共用同一段判据**，细节与 `SandboxReconciledAsOrphan` 的产出方都记在 13 §4。

## 7. 工作区编排：项目 clone 与 Task 独立副本

> 产品依据：P20 §9.5/§9.6、P21-6 §3.2/§6/§9、P21-3 §10、P22 §2/§4.13/§4.16。

### 7.1 两级工作区模型：**宿主 bind mount 目录**（审计 P0-1 方案 A）

```
DATA_ROOT/                              ← compose 用同一绝对路径挂进 api 容器（宿主/容器路径一致）
├── baselines/<projectId>/              ← 项目基线：clone 的落点，只读语义，不挂进任何 sandbox
└── workspaces/<sandboxId>/             ← Task 专属副本，bind mount 到实例内 /workspace（rw）
```

| 环节 | 实现 |
|---|---|
| 创建项目 | 平台进程内 `simple-git` 直接 clone 到 `DATA_ROOT/baselines/<projectId>`（§7.2） |
| Task 准备 | `cp -a` 复制到 `DATA_ROOT/workspaces/<sandboxId>`；**同文件系统时用 `cp --reflink=auto` 拿写时复制**（btrfs/xfs 上近乎零拷贝、零额外占用，见 11 §1） |
| 挂载 | `VolumeMount{ source: '<DATA_ROOT>/workspaces/<sandboxId>', target: '/workspace', mode: 'rw', kind: 'host-path' }`（04 §2.4） |
| 半成品清理 | `rm -rf` 目录；识别靠目录内的标记文件 `.platform-workspace-state`（值 `preparing` / `ready` / `kept`） |
| 回收与对账 | `VolumeReaper` 与启动对账**退化为目录扫描**——`readdir(workspaces/)` 与 DB 记录比对，无需 provider API |

**为什么是宿主目录而不是 named volume**（审计 P0-1 裁决理由）：

1. **DooD 下 named volume 的复制无解**——平台进程在容器里，要把基线复制进 named volume 得再起一个挂载两卷的临时容器，一次 Task 创建多一次容器生命周期；宿主目录只是一次 `cp -a`。
2. **CoW 只有文件系统给得了**：`--reflink=auto` 在 btrfs/xfs 上让"每 Task 独立副本"的磁盘成本从 N×仓库体积降到接近 1×，这是本方案最大的收益（磁盘是真实瓶颈，§1）。
3. **可观测**：出问题时运维能直接 `ls` / `du` 看工作区，不必 `docker volume inspect`。
4. **代价与边界**：① 宿主路径与容器路径必须一致（compose 用绝对路径挂载，11 §1）；② 文件属主/权限要与沙箱内运行用户对齐——**准备阶段实际做的是父目录 `chmod 0700` + 工作区 `chmod 0777`，不是 `chown`**（原文写 `chown`，已按实现更正；原因见 §7.6）；③ 跨文件系统时 `--reflink` 静默退化为全量拷贝，**必须在启动诊断里报出 DATA_ROOT 的文件系统类型**，否则用户会在 ext4 上疑惑磁盘为什么涨得快。

空项目（`source_type='empty'`）没有基线目录，Task 级直接 `mkdir` 空目录。
`projects.workspace_mode='shared'`（v1.1 协作共享卷）时跳过复制，直接把 `baselines/<projectId>` 以 rw 挂载——本文档只留分支位，v1.1 再细化并发写保护。

### 7.2 项目 clone 的异步编排

| 环节 | 设计 |
|---|---|
| 入口 | `POST /api/projects` **立即返回 202** + project 记录（`clone_status='cloning'`），不阻塞请求 |
| 执行 | 后台 job（与 SchedulerQueue 分离的独立队列——clone 不占 CPU/内存配额，只占磁盘与带宽；同一时刻并发 clone 数上限 `project.maxConcurrentClones`，默认 2）。**平台进程内直接跑 `simple-git`**，落点 `DATA_ROOT/baselines/<projectId>`——不再需要任何容器参与 |
| 进度 | `git clone --progress` stderr 解析**全部六个阶段** → 节流 1s → WS `project.clone_progress { projectId, phase, stage?, percent?, objectsDone?, objectsTotal?, receivedBytes?, bytesPerSecond? }`（10 §3）。★ 见下方 |
| 慢仓库提示 | 超过 **10min** 仍未完成：推一条 `phase:'slow'` 事件，前端出"⚠️ 仓库较大或网络缓慢 [继续等待]/[取消]"（P21-6 §6），**不终止**。★ 2026-08 才补上产出方，见下方「幽灵态」块 |
| 硬超时 | **30min** 强制终止子进程 → `clone_status='failed'` + `error_code='TIMEOUT'`；半成品目录 `rm -rf` |
| 重试 | `POST /api/projects/:id/retry-clone`（仅 `failed` 态，02 §5.1）→ 显式重置 `clone_status='cloning'` 重新入队；**不允许隐式回退**（23 I-PRJ-6） |
| **改为空项目** | `POST /api/projects/:id/convert-to-empty`（仅 `failed` 态）→ 放弃克隆转空项目：`source_type='empty'` + `repo_url/baseline_path/baseline_size_bytes` 全部置 null + **`rm -rf` 半成品基线目录**（复用本表「取消」的清理路径）+ `clone_status='ready'`；**项目 id / 名称 / 已关联 Task 保持不变**。产品语义见 P21-6 §5/§9 |
| 取消 | `DELETE /api/projects/:id`（cloning 态）或前端 [取消] → SIGTERM 子进程 → `rm -rf` 半成品目录 → 删项目记录 |
| 幂等 | 进程重启后扫描 `clone_status='cloning'` 的项目：无对应子进程即判定中断 → 置 `failed`（`error_code='INTERRUPTED'`）+ `rm -rf` 目录，让用户显式重试（与自动化的 "missed 不补跑" 同一哲学：不擅自续跑用户看不见的长操作） |
| 深度 | **完整克隆**（不带 `--depth=1`，也不带 `--single-branch`）。★ 见下方「为什么从浅克隆改回完整克隆」 |
| 磁盘预检 | clone 前检查 `DATA_ROOT` 所在分区可用空间，不足即**直接拒绝**并给 `DISK_INSUFFICIENT`，不落半成品目录。★ 见下方 |

#### ★ 基线同步（`POST /api/projects/:id/sync`）

基线在建项目时克隆一次之后**此前是冻住的** —— 一周前建的项目永远是一周前的代码，
而端点里只有 retry / convert-to-empty / cancel / delete，没有任何"重新同步"。

本轮补最小的一档：`git fetch --all` 更新基线的远端引用，刷新
`baseline_size_bytes` 与 `updated_at`。**已有 Task 的工作区一律不动** —— 它们是当时
的写时复制副本，重写它们等于在用户背后改掉正在跑的代码。

⚠️ **由此产生的一个语义，本轮刻意不做呈现**：同一个项目下的两个 Task 可能跑在
不同代码上（一个建于同步前、一个建于同步后），而界面上看不出来。做这个呈现属于
"完整"那一档（要处理"基线更新了但有 N 个任务跑在旧副本上"）。这轮只在项目只读条上
显示**基线的最后同步时间**，至少让"我的基线是什么时候的"可见。

自动同步策略（定时 / 建 Task 时自动 fetch）**不在本轮** —— 那是运维策略，与
"missed 不补跑"同一哲学：不擅自替用户跑他看不见的长操作（见本表「幂等」一行）。


★ **两处实现时才浮出来的约束**：

- **判据是 `ready` ∧ `git`，只判状态不够**——**空项目也是 `ready`**。只按状态放行会让
  `git fetch` 跑进一个根本不是仓库的目录，然后回一个 502「网络错误」去解释一个
  「压根没有远端」的项目。fetch 前与写入前两处都拒。
- **超时 5 分钟**（`SYNC_TIMEOUT_MS`）。clone 有 10min/30min 而 sync 此前没有，
  但它是**同步返回 `ProjectDto`** 的——没有上限等于把一个可能挂死的请求交给前端。

★ **`git branch -r` 的输出不能直接用**（列分支端点的两个坑）：

1. 原始输出带 `origin/HEAD -> origin/main` 这条**符号引用**——照搬会让选择器里多出一个
   叫 `HEAD -> origin/main` 的"分支"；
2. 得**剥 `origin/` 前缀**，否则 `git checkout origin/x` 进的是 detached HEAD，
   工作区看起来对、`rev-parse --abbrev-ref HEAD` 却是 `HEAD`。

实现用 simple-git 的 `branch(['-r'])`（它已过滤 ①）+ 按**实际 remote 名**剥前缀
（不硬编码 `origin`）。

#### ★ 建 Task 时选分支：纯本地操作

完整克隆之后，列分支与切分支都**不碰网络、不需要凭证**：

- `GET /api/projects/:id/branches` 读**本地**引用（`git branch -r`），不是
  `git ls-remote`；
- `CreateSandbox.branch`（可选，缺省 = 基线当前分支）在**工作区准备阶段**做一次本地
  `git checkout` —— 排在 `cp --reflink` 之后、instance 创建之前（§7.1 的顺序不变，
  只是多一步）。

这是选完整克隆的直接红利：这条路上**一条网络失败路径都没有**，而浅克隆方案里它
必然带一条。分支不存在时在**门口**拒绝（零副作用，04 §5），不是等工作区准备到
一半才失败。

#### ★ 为什么从浅克隆改回完整克隆（前提变了，不是决策反复）

原文写的是：*"MVP 用 `--depth=1`（**后续 Task 只需工作副本，不需要历史**）"*。
括号里那句是整条决策的前提，而它已经被推翻：**产品要求建 Task 时能选分支**
（P20 §3.2 / P21-2），而选分支就需要历史 —— 浅克隆之后本地只有一个分支引用，
`git checkout <其它分支>` 直接 `pathspec did not match`（实测）。

三条路走过一遍，选了完整克隆：

| 方案 | 代价 |
|---|---|
| 建 Task 时按所选分支**重新浅克隆**一份 | 每次建 Task 一次网络 clone（大仓几十秒），且 `--reflink` 的写时复制优势没了——那正是"每 Task 独立副本磁盘成本接近 1×"的来源（§7.1） |
| **基线完整克隆**，建 Task 时**本地** checkout ✅ | 基线体积变大（大仓的完整历史可能十倍级）。换来的是：选分支是纯本地操作、秒级，reflink 优势保留，且**列分支不需要网络也不需要凭证** |
| 基线保持浅克隆，建 Task 时在工作区 `fetch --depth=1 <branch>` | 磁盘代价最小，但把"准备工作区"从纯本地变成带网络的一步 —— 那一步从此可能因网络失败，多一整条失败路径 |

**没有保留"浅克隆"选项**：两种模式意味着"能不能选分支"取决于项目当初怎么建的，
而建项目时用户还不知道自己以后要不要切分支。代价用可见性抵消——基线体积进
`ProjectDto` 并显示在项目只读条上（P21-6），让磁盘占用看得见。

⚠️ 磁盘是本平台**已在册的瓶颈**（§1）。完整克隆放大它，所以配套加了下面的预检。

#### ★ 进度明细：git 说的比我们用的多得多

改完整克隆之后克隆变慢，"到底进行到哪了"才成了问题。**实测一个真仓库**
（flask，26348 对象）拆解各阶段耗时：

| 阶段 | 占用 | 占比 |
|---|---|---|
| Enumerating / Counting / Compressing | 0.06s | 0.1% |
| **Receiving objects** | **53.05s** | **93.7%** |
| Resolving deltas | 0.15s | 0.3% |

先说一个**被实测推翻的猜测**：原以为完整克隆会让「解析增量」变成大头、把进度条卡在
尾巴上——不是，receiving 仍然是绝对主阶段。所以原先"只跟踪 Receiving"抓的阶段没错，
错的是**从那一行里只取了一半信息**：

```
Receiving objects:   2% (527/26348), 380.00 KiB | 189.00 KiB/s
                     ~~  ~~~~~~~~~~  ~~~~~~~~~~   ~~~~~~~~~~~~
                   已取①   已取/总②     已收③        速率④
```

②在正则里是**非捕获组**（匹配了就扔），④**根本没匹配**。现在四项全取。

**为什么速率排第一优先级**：卡住时它先归零，而百分比要等很久才看得出"不再动了"。

**`totalBytes` 是幽灵字段，本轮删除。** `git clone` 不报总字节数（包在传输中边算边发，
它自己也不知道），所以后端从来没有一处给它赋过值；而前端 `buildDetailLabel` 的第一条
分支正是 `if (receivedBytes && totalBytes)` —— 一条**生产永远走不到**的格式化路径，
配着一条手工构造 state 才能变绿的测试。

> ⚠️ **当时顺手补的那句「需要分母就用 `objectsTotal`，它是 git 唯一事前就知道的总量」
> 不准确（2026-08 订正）。** `Enumerating objects: 26348` 确实在开头报出远端对象总数，
> 但**后面每个阶段都用同一个字段报自己的分母，而那些分母是不同的量**：
> `Compressing objects` 的 total 只算需压缩的对象，`Resolving deltas` 的 total 是
> **delta 数**，`Updating files` 的 total 是**文件数**——连量纲都不一样。把它当成跨阶段
> 稳定的分母，数字会在阶段切换时跳变（26348 → 12000 → 3000）。
>
> 现有消费方没出错，但是**碰巧**没出错：`cloneProgressPercent` 优先吃 git 给的 per-stage
> `percent`，`buildDetailLabel` 把这对数与**阶段名**并排渲染，阶段名恰好限定了它们的含义。
> 照这句话去做"整体进度"的人不会这么幸运。
>
> **随之而来的真实观感（已知，未修）**：进度条走的是每个阶段自己的百分比，所以一次 clone
> 里它会 0→100 好几遍。实测占比（flask，26348 对象）enumerate/count/compress 0.1%、
> receiving 93.7%、resolving 0.3%，绝大多数时间是 receiving 那一遍，其余一闪而过。
> **没有按这组占比加权**——它们来自一个仓库的一次实测，写成常量就是拿一次采样冒充普遍
> 规律（大仓的 `Resolving deltas` 能跑几十秒）。要修得先有多仓数据，或者改成分段显示。

**六个阶段全解析，是为了填住 receiving 之前那段空窗**：实测 3.4s（慢远端上长得多），
期间旧解析器一律返回 `null`，UI 只有一条脉冲条、一个数都没有——正是"搞不清克隆到哪了"
最刺眼的那一段。实测新实现的第一帧就是 `stage:'counting'`。

#### ★ 磁盘预检：从"写爆之后认出来"改成"写之前拦住"

`DISK_INSUFFICIENT` 此前**只在 stderr 里事后分类**（`/enospc|no space left/`，
见 `error.classifier.ts`）——磁盘满了才知道，而此时半成品目录已经写了一半，还要
再 `rm -rf` 一次。浅克隆时这是边缘情况；完整克隆之后会变常见。

clone 前检查 `DATA_ROOT` 分区可用空间，不足即直接拒绝。**事后分类那条保留**：
预检只能防住"一开始就不够"，防不住"克隆途中别的进程把盘吃满"。

★ **判据是「可配置下限」，不是「剩余空间 < 需求」。** 需求 = 仓库体积，而它在 clone 前
**不可知**——要知道就得问远端（各家 forge 各一套 API，还要凭证），那正好把 §7.2★ 刚
去掉的网络依赖原样加回来。落地为 `CLONE_MIN_FREE_BYTES`（默认 1 GiB），实现取
`statfs` 的 `bavail`（非 root 可用块），且**向上找最深的已存在祖先**——预检必须跑在
`mkdir` 之前，目标目录此刻还不存在。

（写"剩余空间 < 需求"是本节初稿的说法，实现时发现它不可算，改为下限。）

### 7.3 Git 凭证的使用链路（凭证 kind='git'，见 05 §3.2 / 23 §8）

**编排边界（A 裁决）**：clone 编排在 **project 上下文**，Git 凭证的解密与 materialize 在 **credential 上下文**。project 侧**不碰明文**——`RepoUrl.credentialKind()` + `RepoUrl.host()` + `RepoUrl.scheme()` 算出 `kind`、`host` 与 `scheme`（23 §6.3），经门面 `CREDENTIAL_FACADE.prepareGitAuth(kind, host, scheme)`（`@Inject(CREDENTIAL_FACADE)`，23 §8 / 27 §5）拿一个**不透明句柄** `GitAuthContext = { env, gitSshCommand?, dispose() }`。`GitCloner` 的 `CloneRequest` 因此扩展两字段承载已 materialize 的产物：

```ts
interface CloneRequest {
  url: string; targetDir: string; branch?: string;
  env?: Record<string, string>;   // 来自 GitAuthContext.env（token/helper 配置只在此）
  gitSshCommand?: string;         // 来自 GitAuthContext.gitSshCommand（SSH 场景）
}                                 // ❌ 绝不把 credentialId 传进 adapter——否则 infrastructure 回调 credential，层次颠倒
```

句柄的 `dispose()` 由 clone workflow 在 clone 的 **`try/finally`** 调用（删临时密钥目录、清 env 引用）。**选择规则（P21-3 §10.3 已定，后端按 URL 协议自动选，不给用户选择项）**：

| clone URL | 使用凭证 | 落地方式（**全部发生在 `credential/infrastructure` 内**，project 只拿句柄） |
|---|---|---|
| `git@host:...` / `ssh://...` | `obtained_via='git-ssh-key'` | 解密私钥 → `fs.mkdtemp()` 随机目录（平台用户属主 `0700`）内 keyfile 以 `wx`+`0600` **独占创建、不跟随符号链接**；`gitSshCommand = "ssh -F /dev/null -i <keyfile> -o IdentitiesOnly=yes -o GlobalKnownHostsFile=/dev/null -o UserKnownHostsFile=<平台私有> -o StrictHostKeyChecking=accept-new"`（两处 `/dev/null` 见 §7.3 known_hosts 段）。每次 clone **独立目录**，`dispose()` 整目录 `rm -rf`（防可预测文件名的 symlink 攻击） |
| `https://...` | `obtained_via='git-https-token'` | **credential helper 走内存 + 按 host 绑定**：对 `allowedHosts` 里**每个** host 各下发一条 **URL-scoped** 配置 `-c credential.https://<host>.helper='!f(){ echo username=x-access-token; echo password=$GIT_TOKEN; }; f'`（git 仅在请求该 host 时才调它）；token 仍只经 env `$GIT_TOKEN`、**绝不进 URL/argv**、不写任何文件（防落进 `git config`、reflog、进程 argv 与日志） |

**host 绑定与白名单（C 裁决——修一条能外泄 PAT 的 P0）**：

- **git-https-token 凭证携带 `allowed_hosts`（host 白名单，≥1 个；一条 token 可绑多个 host，13 §2.5.1 / 23 I-CRD-8）**。此前的 helper 对**任何** URL 无条件回吐 token → 用户配了 GitHub PAT 后，建一个 `https://evil.example.com/x.git`（公网、能过 SSRF 黑名单）的项目，clone 时 helper 就把 PAT 发给 evil；`/git/test { repoUrl }` 更是直接汲取面。
- **helper 按 host 绑定**（上表 C2）：URL-scoped 到白名单里每个 host，git 只在请求该 host 时才调对应 helper。
- **clone 与 `/git/test` 前置校验（C3，凭证去向的唯一授权边界）**：目标 URL 的 host ∈ 该凭证 `allowed_hosts`，否则**拒绝携带凭证**（clone 失败 / test 返回 `errorCode`），不给"对任意 host 吐 token"的机会。**`allowed_hosts` 是"token/私钥可以发给谁"的唯一控制**——用户把内网 host 填进白名单就是显式授权发内网，把公网 host 填进去就发公网。
- **口径是 authority（host + 非默认端口），不是裸 host（git ≥ 2.50 端口敏感）**：git 的凭证匹配按 authority——`credential.https://h.helper` **不**匹配 `https://h:8443/`。因此全链（`RepoUrl.host()` → 门面 → helper 键 `credential.<scheme>://<authority>.helper` → `allowed_hosts` 精确相等校验）统一用 **authority**：默认端口（https=443 / ssh=22）省略、非默认端口保留。企业自建 GitLab/Gitea 常跑 `:8443`/`:3000`，用户在 `allowed_hosts` 里填 `git.company.com:8443`；`github.com`（默认端口）即裸 host。只此一套规范化，不搞"端口无关"的第二套（避歧义）。
- **helper 键按 repoUrl 的实际 scheme 生成（http/https 都支持，git 凭证匹配是 scheme+authority 敏感）**：git 的凭证匹配同样对 scheme 敏感——`credential.https://h.helper` **不**匹配明文 `http://h/`。因此 helper 键的 scheme 段取自 repoUrl 的**实际** scheme（`RepoUrl.scheme()` → 门面 → materializer），http 远端下发 `credential.http://<authority>.helper`、https 远端下发 `credential.https://<authority>.helper`；否则内网明文 http git 远端即使 token 正确也匹配不上 helper、被静默丢弃（"权限失败"）。**`allowed_hosts` 保持 scheme 无关**（用户授权某 host 即授权其 http/https，scheme 跟随 repoUrl），只 helper **键**跟 scheme 走。**http 远端 token 是明文过线**（cleartext）——materializer 会打一条 warn 日志提示，但**不硬阻断**：内网明文自建 git 是用户自己的信任域（与 C4"不禁私网"同哲学），是否走 http 由用户的网络决定。
- **平台一等公民靠单一注册表驱动（横向扩展点）**：公网 git SaaS 的"默认 host 推导 + 显示名 + SSH host-key pin"由 `shared-kernel` 的 `GIT_PLATFORM_REGISTRY`（github/gitlab/gitee/gitea → label + defaultHost）**单一数据源**驱动——`GitPlatform` 类型、zod 枚举、openapi 枚举、`defaultHostFor()` 查表全部从它派生，**无 switch/case**。**加一个公网 SaaS 一等公民 = registry 加一行**（自动驱动上述全部；前端一份 `Record<平台id,meta>` map 靠 TS `Exclude<GitPlatform,'other'>` 强制跟随，漏跟即编译报错）+（可选）在 `known-hosts` 按其 defaultHost 加一条 SSH pin（不加则走 `accept-new` TOFU）。**认证/clone 逻辑本身按 host+scheme+token/key 驱动、不认平台**，因此**自建 GitLab/Gitea/GHE（任意内网 host）零代码改动**——走 `platform:'other'` + `allowed_hosts` + `accept-new` 即用。
- **rebinding/MITM 闭合（C4，修正版）**：**本产品是单机私有化部署，企业自建 git 常在内网（`10.x`/`172.16.x`/`192.168.x`），clone 内网私有仓是核心用例——因此"携凭证禁私网"是错的、已废弃**（会砸掉核心用例）。DNS rebinding / MITM 的**硬闭合**改为：
  - **HTTPS**：**TLS 证书校验**（保持默认 `sslVerify=on`，`GUARDED_ENV` 额外剥离 ambient `GIT_SSL_NO_VERIFY` 防静默关闭）。rebind 到内网 IP 的伪主机拿不出该域名的合法证书 → 发凭证前 TLS 握手即断。内网自建若用自签证书，那是**用户自己的网络信任域**（与网络隔离同一前提），需用户为其配 CA；平台不因此关校验。host-scoped credential.helper 只对原 host 发、git 默认不跨 host 重发凭证（即使重定向），是第二重。

- **hermetic 对无凭证/公开仓 clone 同样成立（凭证卫生红线）**：带凭证时 materializer 在 `GIT_CONFIG` index 0 下发空 `credential.helper=` 复位 helper 链（中和内置 osxkeychain 等 ambient helper）；**无凭证（公开仓 / 私有仓未配凭证）clone 路径必须同样注入这条复位**——否则 git 会去问 ambient/内置 helper（macOS Apple Git 编译内置的 osxkeychain 不是 env 变量、`GUARDED_ENV` 剥不掉），用宿主 keychain 里缓存的某条凭证完成一次平台本意匿名的 clone（对真实 GitLab 私有仓已实测复现：污染 keychain 后无凭证 clone 竟成功）。故 `git-cloner` 对**所有**平台 clone（credentialed 与否）**恒**注入 `credential.helper=` 复位 + 一条无 ambient identity 的 hermetic `GIT_SSH_COMMAND`（`-F /dev/null -o IdentitiesOnly=yes -o IdentityAgent=none`），确保任何平台 clone 都不使用 ambient 凭证/密钥。
  - **SSH**：**pinned known_hosts（公网 SaaS，见 H）**——rebind/MITM 到伪主机时 host key 不匹配、握手即断（私钥签名前）；自建未知 host 的首连由**网络隔离**承担（accept-new，H）。
  - **纵深（非硬闭合）**：`RepoUrl` VO 的字面 SSRF 黑名单仍拦 **loopback（`127/8`、`::1`）+ 链路本地/云 metadata（`169.254/16`、`fe80::/10`）+ 未指定地址（`0/8`）**——这些**永不是**合法 git host，免费纵深；**但私网段（`10/8`、`172.16/12`、`192.168/16`、`fc00::/7`）放行**。
- **SSH 侧（C5）**：SSH 凭证也记录 host（用于 known_hosts 指纹与展示）；SSH 私钥不会被对端服务器窃取（只交换签名挑战），rebinding/MITM 由 **pinned known_hosts（H）**闭合。

补充纪律：

- **凭证只在平台侧使用，绝不注入 sandbox**（P21-3 §10.3）——clone 与复制都发生在平台进程内，Task 容器里没有任何 git 凭证。
- `GIT_TERMINAL_PROMPT=0` + `GIT_ASKPASS=/bin/true`：禁止 git 在无人值守环境下卡在交互提示上（否则 30min 硬超时才能救回来）。
- **passphrase 私钥 MVP 不支持（F 裁决，检测须完备）**：保存时校验——私钥 PEM 含 `Proc-Type: 4,ENCRYPTED` / `DEK-Info:`（传统 PEM）、**`-----BEGIN ENCRYPTED PRIVATE KEY-----`（PKCS#8 加密私钥）**，或 **OpenSSH 新格式稳健解析出的 `ciphername ≠ none`** → 拒绝保存并返回人话提示（P21-3 §10.2）。**无法确证为"无口令"的格式默认拒绝**（而非默认放行）。理由：无人值守环境无处输入 passphrase，ssh-agent 常驻又把明文密钥留在内存里跨请求存活，MVP 不值得。

**SSH 临时文件落地加固（F 裁决）**：

- 临时私钥文件：`fs.mkdtemp()` 随机目录（平台用户属主 `0700`）+ keyfile `wx`+`0600` **独占创建、绝不跟随符号链接**；**每次 clone 独立目录**，用完整目录 `rm -rf`（防可预测文件名的 symlink 攻击）。目录**建议置于 tmpfs**；文档明示"明文私钥短暂落盘"为**接受风险**。
- **崩溃兜底**：`try/finally` 与 `process.on('exit')` 在 SIGKILL/OOM/断电下都不执行 → 改成**启动清扫**私有 keyfile 目录（与 §7.6 工作区 `.platform-workspace-state` 对账同思路），不依赖进程退出钩子作为唯一防线。
- **`GIT_SSH_COMMAND` 注入必须在 guard 之后**：git-cloner 的 `GUARDED_ENV` 会剥离 `GIT_SSH_COMMAND`/`GIT_SSH`（防环境透传）→ 平台自造的 `GIT_SSH_COMMAND` 必须在 **guard 之后合并**（是平台自造值、非透传）。自造值为 `ssh -F /dev/null -i <keyfile> -o IdentitiesOnly=yes -o GlobalKnownHostsFile=/dev/null -o UserKnownHostsFile=<pinned 或平台私有> -o StrictHostKeyChecking=<yes 或 accept-new>`（按 host 是否 pinned SaaS 二选一，见 H）。**两处 `/dev/null` 都是硬性要求(host-key 验证必须只认平台自己的 known_hosts 文件)**：① `-F /dev/null` 忽略 ambient `~/.ssh/config`，防其改写 host（如 `github.com`→`ssh.github.com:443` 会绕过 pin）、注入 `ProxyCommand` 或追加 ambient IdentityFile；② **`GlobalKnownHostsFile=/dev/null` 忽略宿主 `/etc/ssh/ssh_known_hosts`**——否则宿主全局 known_hosts 里若有 github 真 key,会在我们 pin 了别的 key 时**照样接受、静默绕过 pin**(CI runner 预置全局 known_hosts 的场景已实测复现)。**加断言**：带 SSH 凭证时子进程 env 里 `GIT_SSH_COMMAND` 存在且含 `-F /dev/null -o GlobalKnownHostsFile=/dev/null` 并指向本次 keyfile。

**日志脱敏（G 裁决）**：

- **`GIT_TRACE*` 按前缀整族剥离，`GIT_CURL_VERBOSE` 单列**——否则宿主设了这些，clone 的 curl trace 会把 `Authorization: Basic base64(x-access-token:PAT)` 打进 stderr → `stderrTail`。

  > ⚠️ **本条曾经写成四个名字，那是个洞（2026-08 修）。** 原文列 `GIT_TRACE` / `GIT_TRACE_CURL` / `GIT_CURL_VERBOSE` / `GIT_TRACE_PACKET` 并称之为"整族"，代码也照抄成四个字面量。git 还有**第二代** trace 变量，一个都没在里面，而漏掉的那半恰恰更狠：
  >
  > - **`GIT_TRACE2_ENV_VARS`** —— 把你点名的环境变量的**值**打进 trace。指向 `GIT_TOKEN`，PAT 原文直接落进 `stderrTail`，且不经任何脱敏（是 git 被要求照打的）。
  > - **`GIT_TRACE2_REDACT=0`**（及 `GIT_TRACE_REDACT=0`）—— **关掉 git 自己对 `Authorization:` 头的脱敏**。那层脱敏正是本条其余部分所依赖的最后一道，被一个清单没听说过的变量掀掉。
  > - 另有 `GIT_TRACE2` / `_EVENT` / `_PERF`、`GIT_TRACE_SETUP` / `_PERFORMANCE` / `_PACK_ACCESS` / `_SHALLOW` / `_REFS`。
  >
  > **枚举本身就是病因**：字面量清单是某人某天记得的快照，而 git 还在往里加成员——清单会静默过期，注释却一直在承诺"整族"。所以规则改成前缀 `/^GIT_TRACE/`，让代码兑现注释早就说过的话，并覆盖 git 尚未发布的成员。代价照直说：宿主再也不能靠 `export GIT_TRACE=1` 调试平台的 git 子进程——这是"子进程无法被诱导打印自己的凭证"的价钱。
  >
  > **两处清单、一条规则**：`project/…/git-env.ts` 与 `credential/…/git-spawn.ts` 各有一份且不能互相 import，两边分头"完整"是这类洞的常态。变异用例分居两个 spec，改一处不改另一处时由对侧那条报警。
- `sanitizeCloneMessage` 现只匹配 `ghp_`/`github_pat_`/URL userinfo/query → **补 `Authorization:` 行整体打码**；过滤 URL 中的 userinfo 与任何 `password=` 片段（与 05 §4 同一纪律）。
- **加断言**：拼出的 git 参数数组**不含 token 明文**，`GIT_TOKEN` **只出现在 env**。

**known_hosts（H 裁决——SSH rebinding/MITM 的硬闭合）**：

- **公网 SaaS（`github.com` / `gitlab.com` / `gitee.com`）内置 pinned host 公钥**（ed25519 + rsa 两类，固化进代码 `credential/infrastructure/git/known-hosts.ts`；github/gitlab 已核对与各厂商官方公布的 SHA256 指纹一致，gitee 经 ssh-keyscan 采集）。这些 host 用 **`StrictHostKeyChecking=yes`** 指向**每次写入的** pinned `known_hosts` 文件（`0600`，每次覆写保证不可被前次写入污染）——rebind/MITM 到伪主机时 host key 不匹配 → **"Host key verification failed"，握手即断、私钥签名之前**。key 轮换需改代码 + 指纹（这正是 pin 生效：静默换 key 必须失败而非自动信任）。
- **仅"公司自建 Git（用户填的未知 host）"回落 `StrictHostKeyChecking=accept-new`**（首连 TOFU）——使用**平台私有** `UserKnownHostsFile`（不碰系统 `~/.ssh/known_hosts`），首连自动记录主机指纹，**之后主机密钥变更则 clone 失败**（accept-new 只信任新主机、不接受变更，这是与 `no` 的关键差别）。安全边界明示：自建场景首连 MITM 风险由网络隔离承担，无头容器内交互确认不可行（P21-3 §10.2 已定）。
- 两条都配 `-F /dev/null` + `-o GlobalKnownHostsFile=/dev/null` 使 ssh 只认平台自己的 `UserKnownHostsFile`：前者忽略 ambient `~/.ssh/config`（host 改写会绕过 pin），后者忽略宿主 `/etc/ssh/ssh_known_hosts`（全局 known_hosts 里的真 key 会静默绕过 pin，见上）。

### 7.4 测试连接端点

`POST /api/credentials/git/test` → 执行 `git ls-remote --exit-code <url>`，**15s 超时**（P21-3 §10.2），只回 `{ ok, errorCode?, message }`，不回任何 ref 列表（避免泄露私有仓分支名）。未传 `repoUrl` 时用凭证来源推断的默认探测地址（GitHub/GitLab/Gitee 的 `git@host` 回环测试）。

**body 是判别联合，两种来源（产品有"存前测"与"卡片测"两个入口，P21-3 §10.1/§10.2）**：

```ts
GitTestRequest =
  // ① 存前测（配置面板「粘贴→测试→保存」，密钥尚未入库）：用 inline 密钥瞬时组装凭证，绝不写库
  | { source: 'inline'; type: 'ssh-key' | 'https-token'; secret: string;
      platform?: 'github' | 'gitlab' | 'gitee' | 'other'; allowedHosts: string[]; repoUrl?: string }
  // ② 卡片测（已配置卡片的 [测试连接]）：用已存凭证从 Vault 解密
  | { source: 'stored'; credentialId: string; repoUrl?: string }
```

- `inline` → 用请求里的 `secret` 走 §7.3 同一 `git-auth.materializer` 做**瞬时 materialize**（产 `GitAuthContext`，**绝不入 `credentials` 表**），`host ∈ allowedHosts` 按**请求里的 `allowedHosts`** 校验；passphrase 私钥在此同样拒绝（F）。
- `stored` → 经 `CREDENTIAL_FACADE.prepareGitAuth`（A2）从 Vault 解密，`host` 按该凭证的 `allowedHosts` 校验。

**前置校验同 clone（C 裁决）**：目标 URL 的 host **必须 ∈ 该凭证 `allowed_hosts`**，否则**拒绝携带凭证**并直接返回 `errorCode`（不给"对任意 host 吐 token"的机会——`/git/test` 是最直接的汲取面）；rebinding/MITM 闭合同 clone（HTTPS 靠 TLS、SSH 靠 pinned known_hosts，**不禁私网**——内网自建仓的 test 是核心用例，C4 修正版）。`/git/test` 支持 `source: 'inline' | 'stored'` 判别联合（存前测/测已存卡片），inline 密钥瞬时 materialize、绝不入库。

### 7.5 clone 错误码（对应 P22 §1 新增项）

| 判定来源 | 错误码 | retryable |
|---|---|---|
| `Authentication failed` / `Permission denied (publickey)` / HTTP 401·403 / `could not read Username` | `CLONE_FAILED_PERMISSION` | ❌（要用户去配凭证） |
| DNS 解析失败 / `Could not resolve host` / 连接被拒 / TLS 失败 / HTTP 5xx / `Repository not found` 且无凭证 | `CLONE_FAILED_NETWORK` | ✅ |
| 目标卷所在盘剩余空间 < 需求（clone 前预检 + 写失败时 `ENOSPC`） | `DISK_INSUFFICIENT` | ❌（要用户清理） |
| 30min 硬超时 | `TIMEOUT` | ✅ |

> ★ **`phase:'slow'` 曾是个幽灵态（2026-08 补上产出方）。**
>
> 它出现在 `ws-protocol.ts` 的联合类型、web 的 zod 枚举、`ProjectCloneState`、
> `useProjectClone.isSlow`、`CloneProgress.view` 的黄字分支、以及**两个 Storybook story**
> 里（story 的数据是手写的，当然显示得出来）。后端 `clone-project.workflow.ts` 只发过
> `cloning` / `done` / `failed` 三种——**它在生产里一次都不会出现**。
>
> 这类幽灵态比"缺失"更难发现：缺失会在某处报错，幽灵态哪里都不报，类型检查通过、story 截得出图。
>
> 补产出方时有两个实现细节是**从前端的形状倒推出来的**，不是可选的润色：
>
> - **粘性**：store（`createProjectCloneSlice`）每来一个事件就**整体替换** clone 状态。若
>   `slow` 之后的进度帧仍报 `cloning`，警告最多 1 秒后就被抹掉——用户在第 10 分钟看到黄字
>   闪一下，然后再也不见。所以一旦 slow，后续帧一路报 slow 直到 done/failed。
> - **`slow` 帧自带最后一次进度**：同理，裸 `{phase:'slow'}` 会把 stage/percent/速率清空，
>   进度条掉回不确定态的脉冲——我们告诉用户「还在跑」的那一刻，正好是界面不再显示跑到哪儿
>   的那一刻。
> - 这一帧**绕过 1s 节流直接发**：慢是因为**卡住**时，根本不会再有进度行到来，而那正是最需要
>   告诉用户点什么的时候。等下一帧等于永远不发。

**权限类与网络类必须区分**（P22 §2 的前端分支引导依赖它）：判定顺序是先匹配权限类关键字，再匹配网络类，都不匹配则归 `CLONE_FAILED_NETWORK`（更保守——引导用户重试比引导去配凭证的代价小）。`Repository not found` 在 GitHub 上对私有仓也是这个文案（防信息泄露），因此**已配置凭证时**把它归为 `CLONE_FAILED_PERMISSION`。

### 7.6 Task 级工作区准备（`preparing-workspace` 阶段）

> ★ **2026-08 补两件事：这一段的磁盘预检，以及 `WORKSPACE_PREPARE_FAILED` 的产出方。**
>
> **① 复制侧此前没有任何磁盘预检。** clone 那条路 03 §7.2★ 早就有了；这条路搬的是**同样多的
> 字节**（整个仓库），频率却高得多——clone 每个项目一次，工作区复制**每个 Task 一次**。
> 而且 `cp -a --reflink=auto` 在 **ext4 上没有 reflink**，会静默退化成整字节复制（本节
> §274 ② 早就写过这条），于是"每建一个 Task 就再复制一整个仓库"在单机私有化部署里是常态。
>
> 用**地板值**而不是「基线体积」，理由与 clone 侧相反但结论相同：clone 侧是需求不可知
> （没问过远端多大）；这里是需求**在两个极端之间**不可知——btrfs/XFS 上 reflink 让复制花掉
> ≈0 字节，ext4 上花掉≈基线体积，而 `--reflink=auto` 不会提前告诉你走哪条。要求「基线体积」
> 的空闲会把 CoW 文件系统上本可免费完成的 Task 拒掉。**旋钮 `WORKSPACE_MIN_FREE_BYTES` 与
> clone 侧的 `CLONE_MIN_FREE_BYTES` 分开**：两个检查守着两个目录，真实部署里常在不同挂载点。
>
> **② `WORKSPACE_PREPARE_FAILED` 此前有五处文档承诺、零个产出方。** 02 §6.1 的错误码表、
> 23 §5.6 的领域事件、25 的 E2E-1-wsFail、27 §2、以及本节 §114 都写着它，
> `provision-sandbox.workflow.ts` 里甚至有一行注释说「a failure here … lands as
> WORKSPACE_PREPARE_FAILED」——**而它不会**。
>
> 真实发生的是：`prepare()` 抛 Node 的 fs 错误，`failureOf` 读 `error.code` 拿到 **`ENOSPC` /
> `ENOENT` / `EACCES`**，把 errno 当平台错误码存进 `failureCode` 并广播。前端按码查 P22 §1
> 文案表，查不到 `ENOSPC`，落到通用兜底——**于是全部失败里用户处置最明确的一件（"去清磁盘"），
> 得到的是最含糊的那句话**。02 §6.2 那条「失败必须带码」防的是"没有码"，没防住"有一个不属于
> 这套词汇表的码"。
>
> 修法是**两层**：
>
> - **抛出处命名**：`FsWorkspacePreparer.prepare()` 整个方法包一层，errno → 闭集
>   （`ENOSPC`/`EDQUOT` → `DISK_INSUFFICIENT`，其余 → `WORKSPACE_PREPARE_FAILED`）。
>   包在**方法边界**而不是逐个 await：五个 await 各能抛 errno，逐个 try/catch 是五次可以忘的
>   机会，还包括下一个人新加的那行。原始 errno 不丢，进 `cause` 与 `message` 供 traceId 排查。
> - **出口校验**：`splitFailure` 拿 `SANDBOX_FAILURE_CODES` 过一遍，兜住所有没做上一层的路径。
>   被拒的码打 `error` 日志而**不是**静默换成 `INTERNAL`——静默降级与"没这个 bug"从外面看
>   一模一样。
>
> ⚠️ **只改后端是白改的**：码准了而前端 `sandboxErrorCopy` 的表里没有对应句子，用户看到的
> 还是同一段兜底话。两条文案已同时补上（`DISK_INSUFFICIENT` 刻意**不给裸 [重试]**，只给
> 「清理磁盘后重试」——把前置条件写进 label，而不是配一个会骗人的按钮）。这是
> `BRANCH_NOT_FOUND` 那次「两侧各自完整、合起来漏一条」的同一种形状。


```
scheduling 完成（配额已登记，含 disk_mb_reserved —— §1 已消除 TOCTOU）
   → preparing-workspace
       1. mkdir DATA_ROOT/workspaces/<sandboxId>
       1b. ★ 磁盘预检（2026-08 补）：剩余空间 < WORKSPACE_MIN_FREE_BYTES（默认 1 GiB）
           ⇒ 直接 DISK_INSUFFICIENT，一个字节都不复制。见下方块
       2. 写标记文件 .platform-workspace-state=preparing
       3. cp -a --reflink=auto  baselines/<projectId>/.  →  workspaces/<sandboxId>/
          （空项目：跳过复制，留空目录）
       4. 父目录 workspaces/ chmod 0700 + 工作区目录 chmod 0777（⚠️ 原文写 "chown 到容器内运行用户"，与实现不符——按实现更正，理由见下方块）
       5. 标记文件改为 ready
   → creating（provider.create 时把该目录作为 host-path 挂载，源已存在）
   → starting（凭证 materialize + injectCredential，05 §4；注入形态与落点见下）
```

- **✅ 工作区权限（Step 4 已加固）：工作区目录 0777 保留，可达面收在父目录 `workspaces/` 的 0700 上**
  - **实现事实**：`api/packages/modules/sandbox/src/infrastructure/workspace/workspace-preparer.ts` 的 `prepare()` 先 `mkdir` 并把 `${DATA_ROOT}/workspaces` `chmod 0o700`（**每次 prepare 都做**，把加固前遗留、或被部署脚本重建成 0755 的父目录一并收紧），再在末尾对工作区目录 `chmod(hostPath, 0o777)`。
  - **为什么工作区目录仍是 0777**：bind mount 进沙箱后属主显示为 **root**（docker 与 BoxLite 都**不重映射宿主属主**），而 in-sandbox API 以非 root 用户 **`gem`** 跑，**实测 0755 ⇒ `Permission denied`，0777 ⇒ 可读写**。
  - **为什么不 `chown`（两条硬约束，都成立）**：① 宿主侧 `chown` 到别的 uid 需要 root/CAP_CHOWN，平台进程通常没有；② **更关键**——本阶段**根本拿不到那个 uid**：流水线顺序是 `preparing-workspace` **先于** `creating`，chmod 发生时实例还不存在，没有对象可探测，而本节自己禁止硬编码 1000。所以“运行时探测 uid 后 chown”在这个插入点不可实现，除非额外起一个探测容器。
  - **为什么 0700 父目录就够**：0777 的目录**够不到就不是可达面**。POSIX 目录的 `x` 位控制 traverse——父目录 0700 且属平台用户时，宿主上**其他本地用户**对 `workspaces/<id>/…` 的读与写（含 `unlink`/`create`，即投喂 `AGENTS.md` / `.mcp.json` 的路径）**一律 EACCES**。**实测**（Linux 同内核对照）：父 0700 ⇒ 另一 uid 读失败、在 0777 子目录内建文件也失败；父改 0755 ⇒ 两者立刻成功。bind mount 不受影响——挂载源由**宿主的容器运行时（root）**解析，不走调用方的 traverse 权限；实测 0700 父目录下的 0777 子目录挂进沙箱后 `gem` 照常读写。
  - **残留风险（如实说明，别当已解决）**：这挡住的是**其他本地用户**，**挡不住以平台用户身份运行的其他进程**（同一 uid 天然可 traverse）。同 uid 进程本来就能读 `platform.db` 与 `.master.key`，所以不是新增暴露面，但也意味着本条**不是**“同用户隔离”。真正消除它需要独立 uid / user namespace remap / rootless 形态——属部署形态问题，不在本层解决。
  - **回归**：`workspace-permissions.spec.ts`（父 0700 + 子 0777 + 旧 0755 父目录被收紧）；两条真实例 e2e（`terminal-container` / `boxlite-microvm`）在断言“沙箱内能读写 `/workspace`、宿主与沙箱双向可见”的同时断言这两个 mode。
- **`starting` 阶段的凭证注入步（S5 provision 接线点，05 §7.1 第 2 条留的那个）**：`prepare → inject → record` 三步——`CREDENTIAL_FACADE.prepareRuntimeCredential` → `adapter.injectCredential(cred, exec)` 一次性 exec → 写 `credential_sandbox_bindings` 台账（吊销联动依赖它，05 §4 吊销行）。两条实现纪律来自 **S5 技术验证（2026-08 真容器实测）**：
  - **注入形态按 05 §4 的最小暴露优先级，且已按实测修订**：codex 落 `0600` 的 `auth.json` 且 **`refresh_token` 值替换为占位串**（字段必须保留——直接删会 `missing field 'refresh_token'`；真值绝不进沙箱，05 §1★★）；claude 走 `CLAUDE_CODE_OAUTH_TOKEN` env。
  - **落点路径按沙箱内实际 `$HOME` 展开，不硬编码 `/root`**——⚠️ 原写"实测 aio 的 `$HOME=/root`（uid 0）、boxlite 的 `$HOME=/home/gem`（uid 1000）"，**已更正**：那是 `docker run` 通道的观察，平台走的是 in-sandbox API（以 `gem` 用户跑），**真实通道下两侧 `$HOME` 同为 `/home/gem`**——所以硬编码 `/root` 在**两侧都必错**（04 §2.1★）。工作区本身不受此影响：bind mount 落在 `/workspace`（§7.1），实测宿主与沙箱**双向可见、uid 映射正常**。
- **失败即 `WORKSPACE_PREPARE_FAILED`**（磁盘写满时用更具体的 `DISK_INSUFFICIENT`）→ 状态转 `failed` + `rm -rf` 半成品目录 + 回滚配额登记（§3）。✅ **回滚配额那一步已落地**：`ProvisionSandboxWorkflow` 的 catch 里 `resources.release(sandbox.id)`（`restart` 失败同款），`SandboxApplicationService.destroy` / `stop` 失败路径亦然。⚠️ **`stopped` 刻意不释放** —— 工作区还在盘上、实例还在，`start` 会把它接回来；只有终态（`failed` / `destroyed`）才回池。⚠️ **`keepVolume` 也照样释放**：登记的是 sandbox 的占用，留下的那块盘由 §7.7「保留卷占用」横幅去说，不由资源池去记（§1 已定）。此时**尚未创建实例**，补偿动作比旧顺序更简单——这是把 `preparing-workspace` 前移的附带收益。
- **取消的清理**：用户在进度卡取消或进程重启后发现残留 → 扫 `workspaces/` 下标记文件为 `preparing` 的目录，一律 `rm -rf`（启动对账，13 §4）。半成品目录没有任何保留价值。
- **`ready` 孤儿目录清理**（交叉评审 P2-8）：销毁 keepVolume 流程中"`provider.destroy` 后、打 `kept` 标记/登记 `RetainedVolume` 前"崩溃，会留下标记仍为 `ready` 且 DB 无 `retained_volumes` 记录的孤儿目录。启动对账补一条判据：**sandbox 已 destroyed/failed 但目录标记仍 `ready` 且无 retained 记录 → `rm -rf`**（有 retained 记录的 `kept` 目录才保留）。
- 复制期间不占用 CPU/内存配额（配额已在 §3 互斥区登记，此处只是 IO），但**计入并发准备数上限**（`sandbox.maxConcurrentWorkspacePrepare`，默认 2）防止多个 Task 同时复制大仓库把磁盘 IO 打满。**在 CoW 文件系统上这个上限可以调高**（reflink 复制几乎不产生 IO）。

### 7.7 保留工作区（keepVolume）

产品语义见 P20 §6（销毁二次确认默认勾选保留）与 P21-6 §3.3（项目菜单「已保留卷」入口）。产品术语仍叫「卷」，技术上是**目录**。

- `DELETE /api/sandboxes/:id { keepVolume?: boolean }`（02 §5.1）：`keepVolume=true` 时销毁实例但**保留 `workspaces/<sandboxId>/` 目录**，标记文件改 `kept` 并写入 `retain_until`；缓存与临时目录**无论如何都删**（P22 §4.2）。
- 保留期：默认 **30 天**（P20 §6，支持 3/7/30 天可配）；自动化触发的 Task 用规则的 `artifact_retention_days`（13 §2 automations）。到期由 `VolumeReaper` 扫目录 + 查 `retained_volumes` 后 `rm -rf`。
- 保留记录落 `retained_volumes` 表（13 §2）供「已保留卷」列表查询——**目录是事实，表是索引与保留期账本**；两者不一致时以目录为准（对账时补记或标记 `deleted_at`）。
- 保留目录占用的磁盘**不回资源池**（§1）——它已脱离 sandbox 生命周期，改为治理视角展示（P21-5 水位 + 保留卷占用横幅）。
- sandbox 记录仍按终态保留（审计），目录与记录的生命周期解耦。

## 7.8 运行期健康检查（v1.1）—— `running` 不许再撒谎

### 背景：这块是被一次真实故障逼出来的

2026-08 排障：一个沙箱 DB 里写着 `running`、微 VM 也确实在跑，但**沙箱内的数据面已经挂了**——用户点开终端才发现 agent 起不来。平台一路都说正常。

⚠️ 病根是**状态字段记录的是「当时成功过」，被当成了「现在还成立」**。provision 结束那一刻它确实 running，此后平台再也不看它一眼。同一个病在本仓出现过至少三次（另两处：`cloneStatus=ready` 但 baseline 目录已被清理；`destroy` 对已消失的容器不幂等）。

### 探测的第一个问题不是「怎么探」，是「探测的代价」

⛔ **只读探测也可能是致命的。** 同一轮排障里，`probeOnPath` 那条 `codex --version` **把整个沙箱的 agent 打挂了**——一次意在"检查"的调用，摧毁了被检查的对象。任何周期性健康检查，先回答代价。

实测三层信号（2026-08-27，boxlite 0.9.7 / arm64）：

| 信号 | 耗时 | 是否进沙箱 | 能回答 |
|---|---|:--:|---|
| `box.info()` | **0ms**（本地状态） | 否 | VM 在不在跑 |
| `box.metrics()` | **0.1ms**（×10 均值） | 否 | CPU / 内存 / `commandsExecutedTotal` / **`execErrorsTotal`** |
| native `exec` | **85–592ms**（均 ~160ms） | **是** | 数据面真的能用 |

⚠️ **`metrics().execErrorsTotal` 是一个零成本的异常指示器**：不进沙箱就能知道「最近有没有 exec 出错」。这是分层方案能成立的关键。

`aio` 侧有一个**看起来白送、实测不能直接当判据**的信号。AIO 镜像自带 `HEALTHCHECK`（实测 2026-08-27，`platform/sandbox:v2`）：

```
nc -z localhost ${SANDBOX_SRV_PORT} && ([ "$DISABLE_BROWSER" = "true" ] || nc -z localhost ${BROWSER_REMOTE_DEBUGGING_PORT}) || exit 1
Interval 10s / Timeout 5s / Retries 8
```

`docker inspect` 的 `State.Health` 确实**可读**，且带 `Log`（最近 5 条，含 exitCode）与 `FailingStreak`。

⛔ **但照抄它会把好沙箱判死。** 默认参数拉起该镜像，60s 后 `State.Health = unhealthy`（`FailingStreak = 10`），而同一时刻沙箱**完全可用**：

| 端口 | 谁在看它 | 实测 |
|---|---|---|
| `8091` `SANDBOX_SRV_PORT` | 镜像 HEALTHCHECK | 在听 ✅ |
| `9222` 浏览器调试口 | 镜像 HEALTHCHECK | **没起** ❌ ← unhealthy 的唯一原因 |
| `8080` `PUBLIC_PORT` | **平台自己**（`agentPort: 8080`） | HTTP 200，`shell/exec` 回 `exit_code: 0` ✅ |

三条结论：

1. **它探的口 ≠ 平台用的口**（8091 + 9222 vs 8080）。
2. 它比平台的关心面**更严格**，多押一个浏览器；而 `docker-container-backend.ts` 创建容器时**不设** `DISABLE_BROWSER`——所以浏览器没起就 unhealthy，**这是默认路径下的常态，不是边缘情况**。
3. 语义因此是单向的：`healthy` ⇒ agent 可用（充分条件），`unhealthy` ⇏ agent 不可用。

⚠️ 还有一条时间上的硬伤：`Retries 8 × Interval 10s` ⇒ Docker 自己认定 unhealthy **最长要 80 秒**，比 30s 采样周期还慢，不能承担抗抖动。

⇒ **aio 的零成本层：`State.Health` 只作辅助信号与诊断详情，判据仍是平台自己关心的 8080。** 好处依然在——读它不进沙箱，避开了打挂 agent 的那条路。

### 分层探测

```
常态（每 30s）    ── 零成本层 ──  aio: 8080 探活(+State.Health 辅助)  boxlite: info() + metrics()
                                  ↓ 出现异常迹象
异常确认（按需）  ── 数据面层 ──  一次最小 exec（boxlite native / aio 谨慎）
                                  ↓ 连续 N 次失败
                     health.state: healthy → unhealthy + 审计 error + WS 通知
                     ⚠️ 翻转的是 health，**不是 status** —— status 保持 running，见下
```

- **异常迹象**：`execErrorsTotal` 相对上次采样增长 ／ `info().state.running == false` ／ aio: `State.Health` **由 healthy 翻转**（只取翻转，不取绝对值——绝对值天然为 unhealthy，见上）
- **抗抖动**：用契约里**早就定义好**的 `HealthStatus.consecutiveFailures`（04 `SandboxRuntimeStatus.health`）——⚠️ 该字段与 `resourceUsage` 一样，**两个 provider 的 `inspect()` 至今都没填**，本节就是把它填上
- **单次探测超时**必须远小于采样周期，否则探测自己会堆积

##### ⚠️ 健康度**不进状态机**：翻转 `health.state`，不加第 13 个 `status`（2026-08-31 修正）

本节此前写的是「`status: running → unhealthy`」，那句话**与本仓自己的契约冲突**，而且
挡住过一次实现（「要加第 13 个状态、跨仓枚举变更」被判为前置门槛）。契约里两者从一开始
就是**分开**的：

```ts
// packages/contracts/src/sandbox-provider.contract.ts
export type HealthState = 'healthy' | 'unhealthy' | 'unknown' | 'starting';
export interface SandboxRuntimeStatus {
  lifecycleState: SandboxRuntimeLifecycleState;   // 生命周期
  health?: HealthStatus;                          // 健康度 —— 独立字段
}
```

⇒ `SANDBOX_STATUSES` 那 12 个取值**一个都不用动**。`status` 保持 `running`，翻转的是
`health.state`。

**三条理由，第三条是本节自己的话：**

1. **枚举不可扩展。** Kubernetes 在 [#7856](https://github.com/kubernetes/kubernetes/issues/7856)
   里把这件事讲透了：「Enums aren't extensible. Every addition is a breaking,
   non-backward-compatible API change.」——加一个状态值是一次破坏性的跨仓契约变更
   （本仓两侧各有一份 `status-enum-parity` 对账），而它换来的东西用一个可选字段就能表达。
2. **把健康度塞进 phase 会被读成状态机迁移。** 同一个 issue：「users and developers
   apparently think of phases as **states in a state machine**, regardless of how much
   we try to dissuade them」——顽固到 K8s 一度想干脆废掉 phase。现代做法是
   **conditions 是事实来源、phase 是推导出来的摘要**，而不是把 condition 挤进 phase。
3. ⭐ **本节自己就写了「`unhealthy` ⇏ agent 不可用」**（见上文 aio HEALTHCHECK 那段：
   语义是单向的，`healthy` 才是充分条件）。**一个连"不可用"都推不出来的信号，没有资格
   决定生命周期。** 它进 `status` 之后，`running` 这个值反而变得更不可信 —— 恰好是本节
   要消灭的那种「状态字段在撒谎」。

⚠️ **对外怎么表达**：`SandboxDto` 增一个可选 `health`（不是改 `status`），前端据它渲染
角标/提示；老客户端读不到这个字段时**行为与今天完全一致**（`status` 仍是 `running`），
这也正是可选字段相对枚举扩展的全部好处。



### 实现纪律

1. ⚠️ **`exitCode === undefined` 绝不当成功。** 实测中出现过一批 `undefined`（后续未能复现，疑为调用写法），但健康判定必须显式要求 `=== 0`。
2. ⚠️ **命令不存在会「抛异常」而非返回非零**（实测：`executable '/nope' not found in $PATH`），探测实现必须 catch，否则一次探测异常会冒泡成 provision 失败。
3. **探测结果一律进审计**（`sandbox.health`，13 §2.8.2），否则「什么时候开始不健康的」仍然答不出来。
4. 探测**不得**使用 runtime CLI（`codex --version` 这类）——见开头那条教训；只用 `/bin/true` 级别的最小命令。

### 沙箱审计事件清单（对应 13 §2.8.2 的 `type`）

> ⚠️ **本表只是五档里的一档。** 其余四档（`project` / `credential` / `image` / `system`）的 `type` 清单在 13 §2.8.2「各 `category` 的生产者清单」——那张表是「今天后端到底写不写」的**唯一上游**，前端的 `AUDIT_CATEGORY_EMIT_STATUS` 按它手抄。本表新增/删除一行时，那边也要同步。

| `type` | 何时 | `detail` 关键字段 | 补的是哪个「查不出来」 | 实现 |
|---|---|---|---|:--:|
| `sandbox.provision.stage` | 每阶段结束 | 阶段名 / `duration_ms` / outcome；**`starting` 段另带 `imageStaged`** | 启动 237s→4s 无历史可比 | ✅ |
| `sandbox.probe` | 每次探测 | **argv（不含 env 值）** / exitCode / 输出尾部 | 探测失败只有一行 message | ✅ |
| `sandbox.workspace.prepared` | 工作区就绪 | 源 baseline **是否存在** / 产出条目数（`entryCount`，**不含**平台自己写的 `.platform-workspace-state`） | workspace 空了无人报错 | ✅ |
| `sandbox.agent_session` | 会话启动后 | 起没起 / 跑的是什么 | 要进 tmux 才知道 CLI 没起 | ✅ |
| `sandbox.health` | 状态翻转时（非每次采样） | state / previousState / consecutiveFailures / 判据 / **`status`（恒 `running` —— 别去找一个不存在的状态流转）** | running 但 agent 已挂 | ✅ |
| `sandbox.state_changed` | 状态流转 | from / to / actor | 已有 transitions，补 actor | ✅ |
| `sandbox.credential.absent` | 凭证缺席 | 缺哪个 runtime 的凭证 | **凭证缺席不发任何领域事件**，projector 收不到 | ✅ |
| `sandbox.runtime_install` | 运行时安装状态变化 | runtime / 状态 | — | ✅ |
| `sandbox.scheduler.queued` | 请求**真的排过队**时（入队时前面有人），非每次创建 | `kind`（create/destroy/reconcile）/ `depthOnEnqueue` / `peakDepth`；`durationMs` = 等了多久 | 「公平性与可预测性」（§3）此前没有任何出口 —— 队列深度只活在进程内存里 | ✅ |
| `sandbox.reconciled_orphan` | 对账判定实例已不在、并释放其配额 | `status`（**当时**的，对账不改它）/ `reason` / `projectId` | 对账发生在没人在看的时刻；用户下次打开只看见一个状态没变、配额却被收走的沙箱 | ✅ |

⚠️ `sandbox.health` **只在状态翻转时记**，不是每 30s 记一条——否则一个长命沙箱一天就是 2880 条噪音，把审计流冲垮。**`sandbox.scheduler.queued` 遵守同一条**：只有真的排过队才记，空闲平台上一行都不写。

✅ **`sandbox.health` 已有落点**（2026-08-31）：`SandboxHealthMonitor`（`packages/modules/sandbox/src/application/sandbox-health.monitor.ts`）每 30s 采样 `running`/`idle` 的沙箱，翻转时写这一条。两个 provider 的 `inspect()` 也已经填上 `health`（`boxlite-health.ts` / `aio-health.ts`）。

⚠️ **实测纠正了本节一个假设**（真微 VM，2026-08-31）：`agent-infra/sandbox:latest` 的 `info().healthStatus.state === 'None'` —— **这张镜像根本没配 health check**。于是零成本层能拿到的正面证据只有「VM 在跑」+「`execErrorsTotal` 没涨」。⇒ monitor **不把「没有异常迹象」写成 `healthy`**（那是替沙箱担保一件没人问过的事，而本节定的语义是「`healthy` ⇒ agent 可用」这个**充分条件**）；没有正面信号时是 `unknown`，`healthy` 要么由 provider 明确报出、要么由**数据面确认成功**挣来。

⚠️ **aio 那一侧本机没有镜像，验证不了**：`aio-health.ts` 的判据（8080 探活 / `State.Health` 仅作诊断详情）目前只有纯函数单测覆盖映射逻辑，**没有活容器背书**。别把它当成已验证。

##### 落地时补上的三处契约缺口（2026-08-27）

清单里三条事件在实现时发现**源头根本没有那个字段**，不是记录方式的问题：

| 缺口 | 补法 |
|---|---|
| `SandboxStateChanged` 事件**没有 actor** | 给事件加 `triggeredBy`（`packages/modules/sandbox/src/domain/events/sandbox-events.ts`）。同一次流转落在 `sandbox_state_transitions` 行里有 actor、事件里没有——**两处记录不该只有一处能回答「谁干的」** |
| `PreparedWorkspace` 只有 `hostPath`，答不出「baseline 在不在 / 产出几条」 | 给 port 加 `baselineExisted` / `entryCount`（`packages/contracts/src/workspace-preparer.port.ts`），由 adapter 如实报。⚠️ `importBaseline` 的 `catch { return; }` 是条**静默降级路径**，workflow 事后 stat 只能猜。⚠️ **`entryCount` 必须排除 `.platform-workspace-state`**：那是 `prepare()` 自己写进去的，`readdir` 又把点文件算上 ⇒ 含它的计数在真实文件系统上恒 ≥ 1，于是 workflow 里 `entryCount === 0`（「产出为空」那条 warn）**成了死代码**，空工作区反被报成「1 个顶层条目 / info」。真实文件系统上的行为由 `packages/modules/sandbox/test/integration/workspace-entry-count.spec.ts` 钉住——此前关于这两个字段的断言**全部**来自 `_harness.ts` 里硬编码返回的假 preparer，真实计算一次也没跑过 |
| `sandbox.probe` 若记裸命令串会漏密 | 只记 argv 形状。04 §2.3★：agent 把 `env` 物化成 `export K=V` 拼进命令串，沙箱内 `ps` 全文可见 |

⚠️ **`starting` 段的 `imageStaged` 必须在**进入该段那一刻**取，不能在段末取。** 段末镜像早已铺好、答案恒为 `true`，那等于什么都没说——而这个字段的全部价值是解释**这一段为什么慢**（实测冷 store 190529ms 现拉 13GB 镜像 vs 热 3–4s）。⚠️ 失败路径同样带上它：`provider.start()` 炸在铺镜像的中途，与炸在一个早已 staged 的镜像上，是两个不同的故障，下一步动作也不同。⚠️ 整段 `provision` 的那条**刻意不带**——它横跨多个阶段，把某一段的解释挂在总计上会让读者以为那是整段的成因。⚠️ provider 答不上时**整个字段缺席**，不退化成 `false`：`false` 是「问了，本机没有」，缺席是「没问出来」，退化等于替 provider 编一个它没说过的答案。

⚠️ **`sandbox.probe` 不包 `install()`**：一次冷装 753s、上万行输出，包进去等于把审计流变成安装日志转储。只包探测。

## 8. 自动化调度器（v1.1）

> 产品依据：P21-7 §4.5/§5/§7/§9、P20 §9.9、P22 §2「自动化触发阶段」。规则与运行历史表见 13 §2 automations / automation_runs。

### 8.1 扫描循环

> **✅ 已落地（F21-7，2026-08-31）：`AutomationScheduler`（`@platform/automation`）。**
> 本节五条逐条实现并各有变异验证。两点与原文的措辞差异：
> - **不用 `@nestjs/schedule`/`@Cron`**：`setInterval(60_000)` + `timer.unref()`，与
>   `VolumeReaper` / `CredentialRefreshScanner` 同款。为一个每分钟一次的循环引入一个新的
>   调度框架不划算，而 `unref()` 是那两个循环已经付过的学费。
> - **`async-mutex` 用的是 `isLocked()` 早退，不是排队**：默认的 `runExclusive` 会把第二个
>   调用者排队等前一个跑完；对一个每分钟一次的定时器，排队意味着一轮跑了 90 秒之后立刻
>   再跑一轮，越积越多。本节要的是「上一轮没完就跳过这一轮」（25 T-AUT-42 的原话是
>   「第二次**立即返回**」）。
> - **`outcome_applied` 这一列 13 §2.7.2 原本没有**（只有本节要求它）。已按本节落地并回填 13。

- `AutomationScheduler` 定时任务，**每分钟**扫描 `WHERE enabled = true AND next_trigger_at <= now()`（走 `(enabled, next_trigger_at)` 索引，13 §2）。
- **单实例串行**：整个扫描批次在一个 `async-mutex` 内跑完，防止上一轮未结束时下一轮重入（单机单进程前提；多节点时改为 DB 行级锁 + `claimed_by`，见 11 §4 预留）。
- **outcome-pending 孤儿 run 补扫（交叉评审 P2-7）**：run 已 `finalize`（终态写入）但 `Automation.recordOutcome()`（增 `consecutive_failures` / 触发降频）尚未生效时崩溃——仅按 `next_trigger_at` 扫规则无法发现它，会**漏记一次失败计数**。故每轮额外扫 `automation_runs WHERE status IN (failed,timeout,success) AND outcome_applied = false`，对每条补调 `recordOutcome` 并置 `outcome_applied=true`（幂等，13 automation_runs 加 `outcome_applied` 列）。
- 触发即 `next_trigger_at` **先推进后执行**（按 `schedule_kind` + `schedule_config` + `timezone` 算下一次），保证任何执行异常都不会导致同一时刻被反复触发。
- ⭐ **一个已到期的触发槽不许无声消失（I-AUT-10，2026-09-04 立）**：`next_trigger_at <= now` 的槽在被移出扫描面之前，必须在 `automation_runs` 里留下**恰好一行**（triggered / skipped / missed 之一）。

  > **它是被一处真缺陷逼出来的**（测试 agent 上报，29 §3.3.2b-6 末尾）：本节的三步顺序
  > `applyPendingOutcomes() → advanceInFlight() → fireDue()` 与聚合里那行「失败之后顺手
  > 重算 `next_trigger_at`」叠在一起，会让**上一发在本轮刚落成 `failed`** 的规则在
  > `fireDue()` 的 `listDue(now)` 里消失 —— 那一槽既没触发也没记录。同样局面下上一发若是
  > `success` 会正常触发、若还在跑会留下 `skipped/PREVIOUS_RUNNING`，**三条路径三种历史**。
  >
  > **修法是把那行无条件重算去掉**（只在 degraded/disabled 状态真的翻转时才重算，且重算
  > 不许动一个已到期的槽），不是加补偿代码：槽留在原地 ⇒ `fireDue()` 照常取到 ⇒ 走既有的
  > 三条出路之一。⚠️ 代价是**连续失败的规则在降频闸落下之前仍按原频率跑** —— 明确接受，
  > 理由是 §8.4 的降频/禁用已经是那道闸，再叠一层隐式退避重复且不可见。
  >
  > 落点在聚合的结构上（`_nextTriggerAt` 的五个写口各带 `// slot: …` 标记 + 一条守卫用例），
  > 逐条见 23 §11.1「I-AUT-10 的来历与落点」。⛔ **调度器这一侧不需要任何新代码** ——
  > 这是判断「这条不变量修对了没有」的标志：它由既有结构自动满足。
- **时区（快照语义，产品 P21-7 §3.2）**：计算下一次触发时间**只用规则自己的 `automations.timezone` 列**（13 §2.7.1），**绝不读服务器系统时区、也不读请求方时区**。该列在规则创建时快照（前端默认填当时的浏览器时区），此后**规则存续期内不变**——用户换个时区的机器再打开平台，既有规则的触发时刻不会漂移（"每天凌晨 3 点"不会变成中午 3 点）；只有**新建**规则才继承当时的用户时区。
  - 算法：在 `timezone` 下按**本地墙钟**语义求下一个满足 `schedule_config` 的时刻，再转 UTC 存 `next_trigger_at`。夏令时切换日照此自然处理——"每天 08:00"永远是当地 08:00，UTC 偏移随 DST 变化（25 T-AUT-4）。
  - 编辑规则时**不隐式改写 `timezone`**：用户要换时区必须显式改这个字段（否则"改了个 prompt 顺手把触发时刻挪了 8 小时"是最难排查的一类 bug）。

### 8.2 触发决策表（实现即 P21-7 §5 决策表，逐条对齐）

| 判定顺序 | 条件 | 动作 | `automation_runs.status` |
|---|---|---|---|
| 1 | 上次触发的 Task 仍在非终态 | 跳过（`concurrency_mode='skip'`，MVP 唯一值） | `skipped`，`error_code='PREVIOUS_RUNNING'` |
| 2 | 该 runtime 无生效凭证 / 已过期 / 已吊销（查 `runtime_settings.active_auth_method` + credentials，05 §4） | 跳过 + 横幅 + webhook | `skipped`，`error_code='AUTH_EXPIRED'` |
| 3 | 调度决策返回 `RESOURCE_EXHAUSTED`（§2） | 排队重试：**24min 间隔 × 最多 5 次**（≈2h 窗口），置 `retry_at`；5 次仍失败转终态 | 过程中 `resource-exhausted`；终态 `failed` |
| 4 | 以上皆否 | 创建**标准无头 Task**（同状态机、同配额登记、同独立副本——自动化层**不得**绕过任何一条，P21-7 §9） | `success` / `failed` |

- 重试不是新的 run 记录：同一 `automation_runs` 行更新 `retry_count` 与 `retry_at`，历史上显示"已排队 n/5"（P21-7 §3.3）。

> **✅ 行 3 到本轮才真正成立。** 在 §3 的互斥登记落地之前，`schedulingDecision` 在
> `AutomationScheduler.fireOne` 里**恒传 `'ok'`**（源码注释当时如实写着「没有真实产出方」），
> 而 `RESOURCE_EXHAUSTED` 全仓没有 throw 点 —— 整行连同重试机器都是死代码。
>
> **它有两条路径，缺一条就等于修了一半：**
> - **同步路径** —— `AutomationTaskLauncher.capacityFor()`（只读判据，走创建门那份 quota）
>   给出 `resource-exhausted` ⇒ 落一条 run 直接 `queueRetry`，**一个沙箱都不建**；即便判定
>   放行，创建那一刻的互斥区仍可能拒（那才是闸），adapter 把 429 信封认成
>   `AutomationResourceExhausted`。
> - **后台路径** —— 沙箱已经建出来了，但 provision 阶段撞上容量（典型：工作区复制时磁盘
>   写满 ⇒ `DISK_INSUFFICIENT`）。这一条此前 100% 走 `applyOutcome('failed')`，也就是
>   `consecutive_failures++`。现在 `AutomationTaskPhase` 带上了 `errorCode`，调度器按
>   `CAPACITY_FAILURE_CODES`（`RESOURCE_EXHAUSTED` / `DISK_INSUFFICIENT`）判定，走与同步路径
>   **同一段记账**。判据是**码**不是文案。
>
> ⛔ `WORKSPACE_PREPARE_FAILED` **不在容量码集合里**：它是泛化码（权限、分支、git 炸了都用
> 它），重试一百次也不会好；算进去会让一条真坏了的规则永远停在「已排队 n/5」上不报警。
>
> 只有 5 次排完仍无资源才转终态 `failed`，**那一次才计入失败计数**（§8.4）。
- **宕机 missed**：扫描时发现 `next_trigger_at` 已过期**超过一个调度周期**（或超过 `missedThresholdMin`，默认 5min），判定为宕机错过 → 记 `missed`、**不补跑**、直接推进到下一个未来时刻（P21-7 §5；catchup v1.2）。
- 触发产生的 sandbox 打 `labels.automation_id`，前端据此渲染 `[自动]` 标签并溯源到规则。

### 8.3 无头 Task 硬超时

> **✅ 已落地（S6，[T-4](../TASK-LAUNCH-DECISIONS.md) 的 ⏳ 到此结清）。** 无头 Task 现在有 `RunAgentTaskWorkflow` 这个 handler、输出走 WS `/tasks`、日志按 Task 口径落盘（§8.6）。本节的两阶段 kill 与 `timeoutMs → hard_timeout` 映射按原结论实现，未做改动。**交互式 Task 仍不受影响**：它的兜底是 idle 回收（30min）+ 硬超时 24h（P20 §0）。
>
> **实现落点与两条补充**：
> - **两道防线都在，谁都不替代谁**：`JobSpec.timeoutMs → hard_timeout` 由**沙箱侧**真杀（平台进程死了也照杀，超时统一上报 `exit=124`）；**平台侧**另有一条以 `Clock` 计时的兜底，覆盖「沙箱 agent 不再应答」这类第一道够不着的情形，SIGTERM 一次、下一轮才 SIGKILL，绝不连发信号。
> - **用户可以主动停**：`POST /api/sandboxes/:id/tasks/:taskId/cancel`（27 §2）。终态记 `killed` 而不是 `failed`——被信号杀掉的进程没有退出码，没有这条记录在案的意图，「有人按了停止」和「它崩了」就再也分不开。**取消不立即 `releaseJob`**：退出码和输出末尾正是取消之后要看的东西（04 §2.6）。

- **默认 2h**，规则可配 30min / 1h / 2h / 4h（`automations.timeout_minutes`，13 §2；P20 §0 决策 5 与 P21-7 §3.2 同源）。
- 计时起点是 Task 转 `running` 的时刻（不含排队与拉镜像——否则慢网络会吃掉用户的执行预算）。
- 超时动作：kill 进程 → sandbox 转 `failed`（`failure_reason='automation timeout'`）→ run 记 `status='timeout'`，**并计入 `consecutive_failures`**（P20 §9.9 明确要求）。
- **kill 必须是强制的，不能等 CLI 自己退（S5 技术验证，2026-08 实测）**：CLI **不一定会收敛**。同一场景（无凭证起无头任务）两个 runtime 表现相反——**codex 反复重试 `401 Unauthorized`**（`wss://api.openai.com/v1/responses`，`Reconnecting... 1/5..5/5`）直到被 timeout 杀掉（`exit=124`）；**claude 干净 `exit=1`** + "Not logged in"。实测的触发条件（无凭证）会被 §8.2 决策表第 2 条挡在前面，但暴露的是**通用性质**：持续性 API 错误（凭证运行中失效、网络中断、上游持续 5xx）都会让 codex 走进同一条不退出的重连循环。⇒ 到点先 `SIGTERM` 给一个清理窗口、**超时未退即 `SIGKILL` 强杀**，并连带 destroy 实例（进程死了但容器还在同样是资源泄漏）；adapter 可在 `buildStartCommand` 里带上 CLI 自己的超时旗标作为第一道，但**平台侧这一刀才是唯一可靠的兜底**（04 §3 ★3）。
- **这一刀落在哪（2026-08 补，与实现对表）**：两阶段 kill 由**数据面**真正投递，不是纸面承诺——
  - **无头 Task / 一次性 exec（`tty:false`）**：`ProcessStream.kill()` → **真实信号**。`aio` 经沙箱内 API 的 `POST /v1/bash/kill`（agent 只接受 `SIGTERM`/`SIGKILL`/`SIGINT`，其余降级为 `SIGTERM`）；`boxlite` 用 BoxLite native `JsExecution.signal(n)`。默认走两阶段：`SIGTERM` → **5s 宽限** → 仍未退则 `SIGKILL`；显式传 `SIGKILL` 则不再降格。实测：被 `SIGTERM` 杀掉的命令回 `exit_code=-15`，且在飞的 exec 请求立刻解阻塞。
  - **硬超时本身**：`ProcessSpec.timeoutMs` 直接映射到 agent 的 `hard_timeout`（秒），由 agent **在沙箱内强杀**远端进程，平台侧统一上报 `exit=124`（与本节 codex 实测的 `exit=124` 同义）。客户端另有一个 `timeoutMs + 5s` 的 abort，仅作传输兜底。
  - **交互式终端（`tty:true`）**：agent **没有**给 ws PTY 会话提供任何进程管理接口（实测：`POST /v1/shell/kill` 与 `DELETE /v1/shell/sessions/{id}` 对 ws 的 session_id 一律回 `Session not found`；单纯关 ws **不会**杀掉 shell 及其前台作业）。所以 `kill()` 走 tty 自己的信号通道：先送 `ETX`（0x03，由行规程给前台进程组发 `SIGINT`），再送 `exit` 结束交互 shell（否则每断一次终端就泄漏一个 `bash -i`），最后关 socket。**忽略 SIGINT 的进程仍可能存活** —— 这条路是尽力而为。
  - **唯一保证的兜底仍是 `SandboxProvider.destroy()` / `stop()`**（整个实例连同里面的进程一起没）。所以本节"连带 destroy 实例"不是可选项。
- 与 idle 回收的关系：无头 Task 没有终端，**不参与 idle 回收**（§4.2），硬超时是它唯一的兜底。
- 手动发起的交互式 Task 不受本条约束（其兜底是 idle 30min + 硬超时 24h，P20 §0）。

### 8.4 连续失败：先降频、再禁用

```
consecutive_failures：success 清零；failed / timeout 累加（skipped 与 missed 不计——不是规则的错）
  ≥3        → degraded = true：调度降频为【每日一次】+ 横幅 + webhook 通知
  降频后再连续失败 7 次（即 consecutive_failures ≥ 10）→ enabled = false（自动禁用 🔴）
  降频态下成功一次 → degraded = false + consecutive_failures = 0（恢复原调度）
  用户 [重新启用] → enabled = true, degraded = false, consecutive_failures = 0
```

`degraded=true` 时 `next_trigger_at` 按"每日一次"重算（沿用原规则的时刻，只把频率压到一天一次），规则原始的 `schedule_kind/schedule_config` **不改写**——恢复时直接按原配置重算即可。

⚠️ **「重算」只发生在状态真的翻转的那一次**（转降频 / 从降频恢复 / 转禁用），
**一次普通失败不动 `next_trigger_at`**（I-AUT-10，2026-09-04）。而且翻转时的重算也
**不许推走一个已经到期的槽** —— 降频由那一槽触发时的推进兑现，晚一步，但那一步有记录。
⇒ 一条连续失败的规则在降频闸落下之前**仍按原频率跑**，这是明确接受的取舍（见 §8.1）。

### 8.5 Webhook 通知（v1.1）

| 方面 | 设计 |
|---|---|
| 配置 | `automations.webhook_url` + `trigger_on`（`failure`（默认）/ `success` / `all`；对应 P21-7 §3.2 的☐成功☐失败☐超时——`timeout` 归入 `failure` 语义）|
| 触发点 | run 进入终态时按 `trigger_on` 匹配；**降频与自动禁用**也各发一条（P21-7 §5 明确要求）|
| 载荷 | `POST` JSON：`{ event, automationId, automationName, projectId, projectName, runtimeId, triggeredAt, finishedAt?, status, errorCode?, errorMessage?, taskUrl }`——`taskUrl` 是「打开 Task」深链（`<publicBaseUrl>/?taskId=<sandboxId>`，P20 §8.3；`publicBaseUrl` 取系统配置，未配置时省略该字段而非拼出错误链接）|
| 投递纪律 | 10s 超时；失败重试 2 次（指数退避 5s/25s）后放弃并记入 run 的 `webhook_status`；**投递失败绝不影响 run 本身的状态**（通知是旁路）|
| 安全 | 仅允许 `http`/`https`；**SSRF 防护**：解析目标 IP，默认拒绝环回/链路本地/元数据地址（`127.0.0.0/8`、`::1`、`169.254.0.0/16`），私网段（`10/8`、`172.16/12`、`192.168/16`）**默认放行**——私有化部署里内网 webhook 是主要用法；开关 `automation.webhook.allowPrivateNetwork`（默认 true）。**放行有前提（审计 P2-12）**：未启用访问口令时（11 §3.1）私网放行**自动降级为拒绝**——否则「能建规则的人」= 「能让平台向内网任意地址发 POST 的人」；口令 MVP 即可用，正常部署不会触发该降级 |
| 测试 | 规则表单 [测试连接]（P21-7 §3.2）→ `POST /api/automations/webhook-test { url }` 发一条 `event:'test'` 的样例载荷，同上超时与 SSRF 规则 |

### 8.6 无头 Task 的 stdout/stderr 完整捕获（P21-7 §9 缺口②）

> **✅ 已上提为 Task 口径（S6）。** 上一版这里写的「非自动化的无头 Task 没有 run 记录、没有 `logPath`、没有查询端点、没有 exit 落点」已全部解决：新表 `agent_tasks`（13 §2.1.4）承载记录与 exit 落点，日志落 `data/logs/agent-tasks/<taskId>/{stdout,stderr}.jsonl`，查询端点见 27 §2。**automation 口径（`automation_runs.log_path`）保留不动**——v1.1 的自动化 run 仍是它自己的记录。
>
> **两条实现纪律**：
> - **stdout 与 stderr 分成两个文件，绝不合流**。实测：`codex exec --json` 的 stdout 是 14/14 行纯净 JSONL，一合流就变成「14 行可解析 + 8 行垃圾」，`parseOutput` 随之从「逐行 `JSON.parse`」退化成「写正则猜格式」。
> - **正文只写一份**。库里只存指针（`agent_tasks.log_path`）与摘要；**不另存一份解析后的事件流**——`parseOutput` 是纯函数且逐行独立，把原始行重放一遍就能得到完全相同的事件与序号，回放因此不需要第二份日志。

`RuntimeAdapter.parseOutput` 产出的是**结构化 `RuntimeEvent`**（04 §3），用于进度展示；原始字节另需一条独立链路：

> **✅ 已落地（F21-7，2026-08-31）——但落法与下面这段原文有一处偏差，如实记在这里。**
>
> `automation_runs.log_path` **存的是那份 Task 日志的绝对路径**
> （`data/logs/agent-tasks/<taskId>/stdout.jsonl`），**不再另写一份
> `data/logs/automation-runs/<runId>/output.log`**。
>
> 判据是本节自己立的第二条纪律 **「正文只写一份」**：S6 已经把无头 Task 的日志上提为
> Task 口径（13 §2.1.4），而自动化触发的**就是**一个标准无头 Task —— 它的字节已经落在
> 那里了。再抄一份等于同样的兆字节写第二遍，还多出一处会与另一处不一致的地方。
> `automation_runs` 仍然是自动化自己的记录（本节「automation 口径保留不动」那句保住了），
> 只是它的 `log_path` **指过去**而不是复制过来。
>
> 由此，「10MB × 3 分片轮转」由 **Task 侧**的落盘策略负责；`automation_runs.log_bytes`
> 只是那份文件当时的体积，I-AUR-4 的 30MB 上限照旧在 `AutomationRun.attachLog` 里把关。
> `GET /api/automations/runs/:runId/logs` 按字节区间读那个路径（`text/plain`，游标走
> `x-log-offset`/`x-log-total`/`x-log-eof` 三个响应头，`offset` 缺席即回末尾 64KB）。

- **捕获**：`spawn({ tty:false })` 的 stdout/stderr 原样写入 `data/logs/automation-runs/<runId>/output.log`（tty=false 时两路已由 provider 解复用，04 §2.2）。
- **轮转**：单文件上限 **10MB**、最多 **3 个** 分片（`output.log.1/.2`），超出即丢弃最旧分片并在文件头写一行截断标记——agent 刷屏能轻易写满磁盘，无上限的日志是运维事故。
- **保留**：与规则的 `artifact_retention_days` 同期（默认 7 天）过期清理；`automation_runs.output_summary` 仍存末尾 1KB 供列表快速预览（13 §2）。
- **查询**：`GET /api/automations/runs/:runId/logs?offset=&limit=`（分页字节区间，默认回末尾 64KB）；v1.2 再加 SSE 实时流（P21-7 §8 已标 v1.2）。
- 日志文件路径与体积记入 `automation_runs.log_path` / `log_bytes`（13 §2），清理任务据此删文件。

## 9. 风险与备选

| 风险 | 缓解 |
|---|---|
| 并发创建导致超分配 | §3 互斥登记（✅ 已落地）；回归用例 `resource-admission.spec.ts`「6 并发 / 容量 3 ⇒ 恰好 3 成功」+「用时间证明互斥区真的串行」，存储层由 `uq_alloc_active` 部分唯一索引兜底（13 §2.1.3） |
| 平台重启后资源池视图漂移 | 启动对账：inspect 存活容器 vs 落库配额，差异以实际容器为准修正 |
| CPU 硬限流压制突发负载 | §5 双模式 + burst 余量 |
| **磁盘写满导致全平台不可用**（工作区是宿主目录） | §1 磁盘进调度 + 互斥区内登记消 TOCTOU；11 §1 推荐 btrfs/xfs 拿 CoW；诊断报出 DATA_ROOT 文件系统类型 |
| **非 CoW 文件系统上磁盘暴涨**（ext4 静默退化为全量拷贝） | 启动诊断显式报出 fs 类型与是否支持 reflink；文档明示推荐 btrfs/xfs（11 §1） |
| **提示符启发式误报**（§4.1） | 定死"只驱动展示、不驱动决策"红线；阈值与正则集可配；宁可漏报 |
| **半成品工作区目录残留占满磁盘**（§7.6） | 目录标记文件 `.platform-workspace-state=preparing` + 启动对账无条件 `rm -rf` |
| **⏳ backlog：boxlite `detach:true` 的残留 Box 让宿主端口活过后端**（ADR 决策 B） | 现状只有"DB 里没有该 sandbox ⇒ 收 Box"这一条判据（`runtime-reconciler.ts` 按 `platform-boxlite-` 前缀），**够不到**"DB 里有行、但行已 destroyed / 端口已换、Box 仍在转发"的情况。加固 1 之后残留端口至少是**带鉴权**的（token 随行消亡即失效），所以不是敞口 shell，只是端口与资源泄漏。**本轮不做**；目标形态：启动对账按 DB 的 `agent_endpoint_port` + 终态行反查并回收残留 Box |
| **clone 子进程僵死**（§7.2） | 30min 硬超时 + `GIT_TERMINAL_PROMPT=0` 禁交互 + 进程重启时按 `INTERRUPTED` 判死不续跑 |
| **自动化规则刷屏**（失败每分钟重试、webhook 轰炸） | §8.4 先降频再禁用；webhook 投递失败不重试到底（2 次即放弃） |
| **无头日志写满磁盘**（§8.6） | 10MB × 3 分片轮转 + 保留期清理 |
