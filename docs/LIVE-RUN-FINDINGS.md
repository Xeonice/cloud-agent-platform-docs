# 跑起来才发现的 9 件事（2026-08-24）

> 定位：本轮（完整克隆 / 建 Task 选分支 / 两个新建弹窗 / 项目只读条）在**真实启动、真实点击**
> 之后暴露出的缺陷存档。与其它 ADR 的分工：`*-DECISIONS.md` 记的是**开工前的裁决**，
> 本文记的是**做完之后、跑起来才知道错了**的部分。
> 细节一律落在各自主文档里，本文只写「现象 → 根因 → 落点」，不做第二份权威副本。
> 文末 [附录 D](#附录-d部署形态的实测经过从-11-迁入) 收纳从 11 迁出的部署形态实测经过：现行规则写在 11 和 CONTRIBUTING，这里只留解释这些规则从哪来的经过。

## 0. 一页总览

| # | 现象（用户看到的） | 根因 | 落点 |
|---|---|---|---|
| **L-1** | 建 Task 时选不了分支 | `--depth=1 --single-branch` 的基线只有一个 ref | 03 §7.2★ |
| **L-2** | 克隆进度条一直转，看不出到哪了 | 解析器只取了 git 给的一半信息；`totalBytes` 是幽灵字段 | 03 §7.2★ · 10 §7.4 |
| **L-3** | 新建项目卡在"正在克隆"永不结束 | dev 下 MSW 无条件拦截，请求根本没到后端 | 11 §1.3 |
| **L-4** | 左侧树里看不到刚建的任务 | 三层同时断：前端写死空数组 / 后端不带过滤返回空 / 点击没接线 | 10 §6 · P21-2 |
| **L-5** | 终端不占满，页面出现整页滚动条 | `main` 改成 flex 列后缺 `min-h-0` | P21-2 §N |
| **L-6** | 终端里一大片空白、内容在最底下 | **两个 xterm 实例上下叠着**（attach 竞态） | 08 §7.4 |
| **L-7** | agent 欢迎横幅按 80 列画 | detached tmux 会话默认 80x24 | 03 §4.3 |
| **L-8** | 底部「无头任务」看不懂 | 界面上两个东西都叫"任务"；面板没按 `headless` 门控 | P21-2 §N.3 |
| **L-9** | 存量项目点[重新同步]仍只有一个分支 | `--depth=1` 同时关上了**深度**和**分支**两扇门 | ✅ 已解决（2026-08）：sync 探测浅仓 → 复原 refspec + `--unshallow` |

**三条贯穿全文的共性**（先说，免得后面重复）：

1. **九件里有八件是"跑起来"才发现的，读代码全都读不出来。** L-3/L-6 尤其典型：
   两者的代码单看都对，错的是**运行时的组合**（dev 开关、React StrictMode 的双调 effect）。
   这直接反驳"测试全绿 + typecheck 干净 = 可以交付"。
2. **好几处的"证据"本身是假的。** `21-2 §9` 的验收清单给 14 条打了 ✅，而被测组件根本
   不存在；`useProjectClone.test` 断言了一条生产不可达的格式化分支；`InMemorySandboxRepo`
   忽略 `projectId` 参数，让所有"按项目过滤"的断言都测的是替身自己。
   **绿灯不等于覆盖**——得问一句"它红过吗"。
3. **同一个词在两处指不同东西，就一定会出事。** L-4 与 L-8 是同一个病：
   界面上「任务」既指 Sandbox 又指 AgentTask，于是"· 1"和"还没有任务"同屏打架。

---

## L-1 建 Task 选分支 → 必须完整克隆

### 现象
产品上想在建 Task 时选分支，但选择器给不出候选。

### 根因
`git-cloner.ts` 传的是 `--depth=1`，指定分支时再加 `--single-branch`。
实测：这样克隆出来的基线 `git branch -a` **只有一个分支**，
`git checkout 其它分支` 直接 `error: pathspec did not match`。

原决策的括号里写着理由——「后续 Task 只需工作副本，**不需要历史**」。那句话是整条
决策的支点，而"选分支"恰恰需要历史。**不是决策反复，是前提变了。**

### 落点
`03 §7.2★`。**无浅克隆逃生阀**：留两种模式意味着"能不能选分支"取决于项目当初怎么建的，
而那时用户还不知道自己以后要不要切。

配套加了 **clone 前磁盘预检**（完整克隆放大磁盘这个已在册的瓶颈）。判据是
**可配置下限**（`CLONE_MIN_FREE_BYTES`，默认 1 GiB）而不是"剩余 < 需求"——
需求 = 仓库体积，clone 前**不可知**，要知道就得问远端，那正好把刚去掉的网络依赖加回来。

---

## L-2 克隆进度：git 说的比我们用的多得多

### 现象
进度条一直转，项目名下面空空的，不知道到哪一步了。

### 根因
**实测**一个真仓库（flask，26348 对象）拆解各阶段耗时：

| 阶段 | 占用 | 占比 |
|---|---|---|
| Enumerating / Counting / Compressing | 0.06s | 0.1% |
| **Receiving objects** | **53.05s** | **93.7%** |
| Resolving deltas | 0.15s | 0.3% |

先说一个**被实测推翻的猜测**：原以为完整克隆会让「解析增量」变成大头把进度条卡在尾巴上
——不是。原先"只跟踪 Receiving"抓的阶段没错，错的是**从那一行只取了一半信息**：

```
Receiving objects:   2% (527/26348), 380.00 KiB | 189.00 KiB/s
                     ~~  ~~~~~~~~~~  ~~~~~~~~~~   ~~~~~~~~~~~~
                    已取   已取/总②     已收        速率④
```

②在正则里是**非捕获组**（匹配了就扔），④**根本没匹配**。

**`totalBytes` 是幽灵字段。** `git clone` 不报总字节数（包在传输中边算边发，它自己也不
知道），所以后端从来没有一处给它赋过值；而前端 `buildDetailLabel` 的第一条分支正是
`if (receivedBytes && totalBytes)` —— **生产永远走不到**，配着一条手工构造 state 才能变绿
的测试。分母改用 `objectsTotal`。

> ⚠️ **本条括号里原有一句「`Enumerating objects: 26348` 开头就报，是 git 唯一事前就知道
> 的总量」，2026-08 订正删除——它是错的。** `objectsTotal` 是**本阶段的**分母：
> `Compressing` 只算需压缩的对象、`Resolving deltas` 的分母是 delta 数、`Updating files`
> 的分母是文件数。跨阶段当同一分母用会跳变。详见 03 §7.2★ 与
> `git-cloner.port.ts` 上 `CloneProgress` 的长注释。
>
> 这条本身也是共性 2 的一例：**修 bug 时顺手写下的解释没有被任何东西检验过**，
> 于是一句错话跟着一个正确的修复一起传播到了三个文件。

### 落点
`03 §7.2★` · `10 §7.4`。六个阶段全解析，为的是填住 receiving 之前那段空窗
（实测 3.4s，慢远端更久）——旧解析器对那段一律返回 `null`，UI 只有一条脉冲条。
**速率排第一优先级**：卡住时它先归零，百分比要等很久才看得出不动了。

---

## L-3 dev 下 MSW 无条件拦截

### 现象
新建项目，弹层停在"正在克隆项目…"，转多久都不动。

### 根因
`providers.tsx` 是 `if (!IS_DEV) return;` —— **dev 下无条件启动 MSW，且没有开关**。
mock 的 `POST /api/projects` 返回 202 `cloning` 之后**再无下文**（`src/mocks/` 里一条
`clone_progress` 都没有），于是前端在等一个永远不会来的事件。

证据链：proxy 全日志 **`POST` 出现 0 次**、项目列表里没有那个名字、没有任何 `git clone`
进程、界面上还有个 404 的 `GET /api/sandboxes/mock-1787536274481`（`mock-` 前缀是
`handlers.ts:443` 造的）。

**它不是一个决策，是脚手架残留**：这行随 web 初始脚手架（`b76a4ad`，2026-08-12）一起
进来，当时**后端还不存在**；后端做出来之后没人回头改它。文档侧也从没要求过——
`12 §4` 把 MSW 限定在 **Storybook container story 层**。

代价不是"多了一层 mock"，而是 **dev 下谁都碰不到真后端、且关不掉**。掩盖方式还很隐蔽：
`onUnhandledRequest:'bypass'` 让没写 handler 的请求穿透到真后端，于是真假混着走，
界面上看不出哪条是假的。

### 落点
改成 `NEXT_PUBLIC_API_MOCK === '1'` 显式开启，**默认关**。Storybook 不受影响
（它单独引 `@/mocks/handlers`，不走 `providers.tsx`）。

---

## L-4 左侧树看不到任务：三层同时断

### 现象
建完任务，终端里 agent 在跑，左侧树却写着"在 X 中发起第一个任务 →"。

### 根因
三层**同时**断，只修一层都还是空：

1. **前端写死**：`WorkbenchContainer` 的 `const NO_TASKS: Sandbox[] = []`，
   注释是"sandbox 列表端点在后续切片接入"——树的任务列表永远空；
2. **后端返回空**：`list()` 是 `if (!projectId) return [];`，而前端发的正是裸
   `GET /api/sandboxes`。控制器自己的 summary 写的却是 "optionally filtered"；
3. **点击没接线**：`onSelectTask` 根本没从 container 传下去——修完前两层后任务行
   渲染出来了，点了没反应（终端挂在 `selectedProject` 上，只设 `selectedSandboxId`
   主区会停在空态）。

**为什么难查**：它不报错。树上的计数走的是**另一条路**（`ProjectDto.taskCount` ←
`countActiveByProject`），所以界面呈现的是"项目后面写着 · 1，展开却一条都没有"。

顺带查出两处口径不一致：`countActiveByProject` 排除 `destroyed` 而 `findByProject` 不排除
（列表与计数会各说各话，已统一到 `list()` 一处过滤）；`openapi` 里这个端点
`parameters: []` —— `projectId` 根本没进契约，**typed client 传不了**
（`@Query()` + `createZodDto` 不足以让 swagger 认出查询参数，要显式 `@ApiQuery`）。

### 落点
`10 §6`（缺省 = 全部项目）· `P21-2`。

---

## L-5 终端不占满 + 整页滚动条

### 现象
终端区只占上面一截，页面出现整页滚动条。

### 根因
主区顶部新增只读条时，`main` 从块级改成了 flex 列，但**没补 `min-h-0`**。
flex 项默认 `min-height: auto`，内容一高就撑破 `h-screen`。

**合成复现**（不等真容器，直接在浏览器里塞探针）：往主区插一个 4000px 元素，
`documentHeight` 从 2762 变 6762 —— **正好被撑破 4000**。

### 落点
`min-h-0 overflow-hidden` 缺一不可（终端自己有 scrollback，不需要页面滚）。

---

## L-6 两个 xterm 实例上下叠着（attach 竞态）

### 现象
终端里一大片空白，内容在最底下。

### 根因
**这是本轮最难查的一个**，前两轮都判断偏了（先怀疑 PTY 尺寸、再怀疑 tmux）。
浏览器里量出来才看见：容器里有**两个 `.terminal.xterm`**——

| 实例 | top | 高 |
|---|---|---|
| 0（空的） | 97 | 2520 ← 占满可视区 |
| 1（有内容） | **2617** | 2556 ← 被挤到屏幕外 |

用户看到的"空白 + 内容在最底下"，是**第二个实例的顶边露出来了**。

`attach()` 的守卫：

```ts
const existing = instances.current.get(sessionId);   // ← 查表
if (existing) { ...复用...; return; }
const [...] = await Promise.all([import(...)]);      // ← 让出
terminal.open(container);                             // ← 建 DOM
instances.current.set(sessionId, managed);            // ← 到这才写表
```

**查的表在 await 之后才写入。** `reactStrictMode: true` 下 React 双调 effect：
attach① 起飞 → cleanup 调 `dispose`（表里没东西，**空转**）→ attach② 起飞 →
两个都过守卫 → 两个 `terminal.open(container)`。**不是 dev 专属**——任何两次快速
attach（重挂、容器换父）都会撞上。

⚠️ **第一版修复把它修反了**：加了"在途撤销"标记后变成**一个实例都不建**——①被撤销
自我拆除，②等到后发现没实例就直接返回。**撤销 ≠ 放弃**：StrictMode 里被撤销的是①，
②才是要留下的那个。这个坑现在是一条独立用例。

### 落点
`08 §7.4`。在途表 `pending` + 撤销标记 `disposedWhilePending`，三条变异各自守一个方向。

---

## L-7 agent 会话的出生尺寸

### 现象
agent CLI 的欢迎横幅按 80 列画，之后再宽也不重排。

### 根因
两处都写死 80x24，且**成因不同**：

1. **前端建连 query**：`terminalSocket.ts` 的 `cols:'80', rows:'24'`。时序上必然错——
   `useSandboxTerminalSocket` 在 **render 阶段**发起连接，xterm 的 attach/fit 在**之后的
   effect** 里，连接永远早于测量。
2. **后端 agent 会话**：`tmux new-session -d`（无 `-x/-y`）。**实测**：detached tmux
   会话默认就是 **80x24**，加 `-x 200 -y 50` 才是 200x50。

**终端协议里没有"回流"**：已经吐出的字节不会因为后来的 resize 重排，所以事后补一帧
resize **救不回第一屏**。

### 落点
前端改成**先 fit 再连**（`enabled: fittedSize !== null`）；后端给 detached 会话一个宽松默认值。

⚠️ **纵向错位仍会残留**：真实尺寸只有 attach 那一刻才知道，客户端比默认高时旧内容仍被
留在底部。彻底解决要把客户端尺寸随创建请求传下来，但**创建任务时浏览器里还没有终端实例**，
量不出 cols/rows（xterm 的格子尺寸要有实例才知道）。本轮取舍：修好宽度这一半。

顺带纠正一个曾经的误判：**Codex 的欢迎盒子只有 45 字符宽，那是它自己的设计**，
不是 80 列换行造成的。

---

## L-8 「无头任务」面板看不懂

### 现象
交互式任务跑着，底下一条「无头任务」说"这个沙箱还没有任务"，而左边树里写着 `项目 · 1`。

### 根因
**界面上两个东西都叫"任务"**：

| 界面位置 | 它说的"任务" | 数据来源 |
|---|---|---|
| 左侧树 `项目 · N` | **Task = 一个沙箱**（名字就是用户填的指令） | `SandboxDto` |
| 无头面板 | **AgentTask = 沙箱内部的一次无头运行** | `GET /api/sandboxes/:id/tasks` |

两句话各自都对，摆在一屏上就是自相矛盾。

而且面板**没按 `headless` 门控**——`SandboxTerminalContainer` 只判断了
`sandboxRuntime === undefined`。于是交互式沙箱底下也挂一条，那个计数**永远是 0**
（交互式沙箱不会有无头运行），永久停在空态。

模式在创建时**二选一**（`20 §3.2`：◉ 交互式终端 / ○ 无头任务，`SandboxDto.headless`）。

### 落点
`P21-2 §N.3`。门控加在 `headlessSlot`：`headless === true` 才渲染。
按钮同步改名 `[新任务]` → `[发起无头运行]`——侧栏的 `[＋ 新任务]` 建的是**新沙箱**，
面板里建的是**同沙箱内的下一次运行**，同名正是混淆源。

---

## L-9 ✅ 存量浅克隆基线的迁移（2026-08 解决）

### 现象
改造前建的项目，点[重新同步]之后**仍然只有一个分支**，界面上没有任何东西解释。

### 根因
`sync` 走 `git fetch --all`，**在浅仓上不会转成完整克隆**（要 `--unshallow`）。
实测确认存量基线 `.git/shallow` 存在、只有 1 个提交。

### 曾经为什么留着
`--unshallow` 在**非浅仓上会报错**（`fatal: --unshallow on a complete repository does not
make sense`，实测确认），不能无条件加；要么检测再决定，要么显式记为已知限制。本轮时间用在了
L-1..L-8 上，这条**明确留作待办**而不是假装不存在。

### ⚠️ 当时写下的「建议做法」是错的，而且它配的验收会在错修法上变绿

原文是：

> `sync` 前探测 `.git/shallow`：存在则 `git fetch --unshallow`，否则 `git fetch --all`。
> 配一条用例：浅仓基线 sync 后 `git rev-list --count HEAD` 应大于 1。

实测（本地双分支仓，`file://` 远端）：

```
git clone --depth=1 file://…    → 提交 1，分支 [origin/main]
git fetch --unshallow           → 提交 3，分支 [origin/main]   ← 分支数没变！
```

**提交数确实从 1 变成 3，那条验收会绿——而用户抱怨的那件事一点没修。**

根因比原先记的深一层：`--depth` 会**隐含 `--single-branch`**，于是 remote 的 refspec 被钉成
`+refs/heads/main:refs/remotes/origin/main`。`--unshallow` 严格按 refspec 加深，别的分支
它根本不会去看。**`--depth=1` 关上的是两扇门——深度和分支——只开一扇，症状原样还在。**

### 实际做法

```
git rev-parse --is-shallow-repository        # 探测（不是 existsSync('.git/shallow')：
                                             #  worktree/submodule 里 .git 是文件）
git remote set-branches origin '*'           # 先复原 refspec ← 原建议缺的就是这一行
git fetch --unshallow                        # 此时才会把所有分支都取回来
```

实测结果：提交 3，分支 `[origin/main, origin/feature/x]`，`.git/shallow` 消失。
顺序不能反；`set-branches '*'` 在已通配的仓上重复执行无害（实测幂等）。

落点 `infrastructure/git/baseline-git.ts`，验收
`test/integration/shallow-baseline-migration.spec.ts`（真 git，5 条）。
**每一条都断言分支，不只断言提交数**——提交数是那个错修法也能满足的指标。
变异验证：去掉 `set-branches` 那一行 ⇒ 分支断言红、提交数断言绿，正好复现"错修法配错验收"。

> ⚠️ 远端必须用 `file://` URL 而不是裸路径：git 对**本地路径**克隆会忽略 `--depth`
> （`warning: --depth is ignored in local clones`），用裸路径根本造不出浅仓，
> 整个用例会变成一个测不到东西的空壳——又一个"绿灯不等于覆盖"。

### 这条本身给共性 2 添了一笔
「修 bug 时顺手写下的**下一步建议**」和「顺手写下的**解释**」（见 L-2 里的 objectsTotal 订正）
一样，从来没有被任何东西检验过，却会被下一个人当成结论照做。

---

## 附录 D：部署形态的实测经过（从 11 迁入）

这些条目原写在 11 §1–§1.4 和本地开发清单里。现行规则已收敛到 [11](./shared/11-部署与扩展预留.md)（自托管 compose）与 [CONTRIBUTING](../CONTRIBUTING.md)（本地开发），这里只保留仍在解释现行约束的经过，格式同正文「现象 → 根因 → 落点」。

| # | 现象 | 根因 | 现行规则在哪 |
|---|---|---|---|
| **D-1** | 照着 11 的 compose 骨架理解部署，第一个 Task 就失败 | 骨架与真 compose 对不上，而那时没有任何检查看 compose | 11 §1 · 09 §2.4（C1） |
| **D-2** | helper 写成 compose 服务后平台连不进去 | 平台不走 `docker exec`，agent token 在 provider `create()` 时才注入 | 11 §1.1 |
| **D-3** | 宿主机形态下 claude 登录一直 500，codex 却能用 | 登录 CLI 检测 TTY，管道下一个字节都不输出 | 11 §1.1 |
| **D-4** | 日志轮转后 `runtime.log` 消失，日志照写却找不到 | 旧 write stream 跟着 inode 写进了改名后的文件 | 11 §1.2.1 |
| **D-5** | 数据库文件实际是 `0644` | better-sqlite3 按 umask 建文件，文档里的 `0600` 没人执行 | 11 §1.2 |
| **D-6** | 本地照清单起服务，界面停在「启动实例」，不报错 | 三个配置装载问题叠在一起 | CONTRIBUTING · `api/.env.example` |
| **D-7** | 本地前端连不上后端、WS 无限重连 | 当时后端没有 CORS，WS 基址是构建期常量 | CONTRIBUTING · `web/next.config.mjs` |
| **D-8** | compose 起得来，建 Task 必定失败 | DooD 下 api 拼出的 loopback 地址只有宿主解得开 | 11 §1.4 |

### D-1 compose 骨架与真 compose 对不上（v0.1.0 前后）

**现象**：骨架与 `api/docker-compose.yml` 有三处不一致，恰好都是"照抄就跑不起来"：卷两边不同名（违反 11 §1.2 的同名挂载）、缺 `DOCKER_HOST`（socket proxy 白挂）、缺 `SANDBOX_DEFAULT_IMAGE`（当时默认落到 `alpine:3.20`，Task 死在 `agent port 8080 is not published`）。骨架里还写着已被推翻的兜底 `${SANDBOX_DEFAULT_IMAGE:-ghcr.io/agent-infra/sandbox:latest}`（没装 claude-code，现装要 753 秒），一路活到 v0.1.0 的 tag 上。

**根因**：「文档 ↔ 部署产物」这一层没有门守着，`docs:check` 当时 12 项全绿，因为它不看 compose。

**落点**：骨架按实现订正；新增 C1 compose 骨架对账（服务集合与插值默认值，解析不到即判失败），见 09 §2.4。

### D-2 auth helper 容器形态的两处设计错误（2026-09-22）

**现象**：按原设计在 compose 里加一个 `auth-helper` 服务、用 `command: sleep infinity` 常驻，平台连不进去。

**根因**：两条都是照着 `docker exec` 的模型写的设计，而实现从一开始就不是那个模型：平台在容器里跑进程走镜像内的 HTTP agent，它的 token 在 `aio-sandbox.provider.ts` 的 `create()` 那一刻生成并注入，compose 建的容器没经过这一步；AIO 镜像的 entrypoint 正是启动 agent 的东西，覆盖它会得到「running 但永远连不上」的容器。

**落点**：helper 由平台经 provider 创建、不覆盖任何命令，见 11 §1.1。

### D-3 宿主机 helper 必须是真伪终端（2026-09-07）

**现象**：`AUTH_HELPER_MODE=host` 下 claude 登录对用户只表现为一个不解释任何事的 HTTP 500，codex 却正常。

**根因**：当时用 `child_process` 管道，而登录 CLI 会检测 TTY：

| | 输出 |
|---|---|
| `claude setup-token` 走管道 | **0 字节**（实测 25s） |
| `claude setup-token` 走真 PTY | 3654 字节 / 5 个 OSC-8 超链接 / 授权 URL（秒级） |

解析器认的正是 OSC-8 ⇒ `readUntil` 空等满 120s。codex 能用纯属输出格式的运气：`codex login --device-auth` 在管道下照样打印纯文本设备码。同一条链路一个通一个不通，最容易被当成配置问题查很久。

另外两处同类问题：`node-pty` 的 darwin 预编译 `spawn-helper` 以 644 发布（上游 #850），pnpm 保留原权限 ⇒ 对任何命令都报 `posix_spawnp failed.`，第一眼像「PATH 里没有那个 CLI」；隔离 HOME 曾是相对路径 `./data`，子进程换 cwd 后指向别处，codex 校验目录后立刻退出、claude 不校验照跑，同一个 bug 只打挂一半 runtime。

**落点**：改用 `@lydell/node-pty` 起真 PTY，隔离 HOME 用绝对路径，见 11 §1.1。

### D-4 运行日志轮转的 inode 坑（2026-08-27 预研）

**现象**：自写的按大小轮转在 rename 之后，所有日志继续写进已改名的旧文件，`runtime.log` 这个路径直接消失，外部 `tail -f` 一并断掉（`tail -F` 才能恢复）。

```
写 BEFORE-1 / BEFORE-2 → renameSync(runtime.log → runtime.log.1) → 写 AFTER-RENAME
结果：runtime.log.1 = "BEFORE-1\nBEFORE-2\nAFTER-RENAME"
      runtime.log   = 不存在
```

**根因**：rename 之后旧的 write stream 跟随 inode。而且把上面这段照抄成回归测试会得到假绿：`createWriteStream` 的 fd 是异步打开的，同步 burst 时 rename 那一刻还没有 inode 可跟随，坑不复现，把轮转改成「直接 rename 不 end()」的变异照样绿。要先等字节真正落盘再 rename，断言才有效。

**落点**：`end()` 旧流 → 回调里 rename 链式移位 → 重开流，窗口内的日志缓冲后重放。实测 800 行连续写、触发 4 次轮转，保留窗口内空洞 0 处、末行完整，依赖 0 个。见 11 §1.2.1。

### D-5 数据库文件权限曾只是一句愿望（2026-08-30）

**现象**：文档要求 `.master.key` 与 `platform.db` 为 `0600`，而全新 `DATA_ROOT` 实测 `pnpm db:migrate` 建出的 `platform.db` / `-wal` / `-shm` 都是 `0644`（`logs/runtime.log` 倒是 `0600`）。

**根因**：better-sqlite3 按 umask 建文件，没有 mode 参数可给，也没人 chmod。这个库装着任务历史、prompt、仓库地址与加密后的凭证密文，和 `.master.key` 放在同一个 `DATA_ROOT` 里：把钥匙锁好、把锁着的箱子摊在桌上是一种自欺。

**落点**：`drizzle.connection.ts` 的 `hardenDatabaseFiles`，顺序是「建库 → 先 chmod 主库 → 再开 WAL」，因为 SQLite 建边车时照抄主库的权限位。见 11 §1.2。

### D-6 本地照清单起服务的三个坑（2026-08）

**现象**：本地演示环境「看起来在转、实际什么都没发生」：界面停在「启动实例」，日志里事件照发，但库里没有行、容器没有起，全程不报错。三个都不是业务缺陷，是配置装载。

**根因**：

- **坑一：`DATABASE_URL=`（空串）**。代码是 `process.env.DATABASE_URL ?? <默认>`，`??` 只对 null/undefined 回落，空串让 better-sqlite3 开了一个匿名临时库：列表永远回 `[]`，`platform.db` 根本不存在。这颗雷曾随 `.env.example` 一起发出。
- **坑二：默认镜像落到 `alpine:3.20`**。alpine 里没有沙箱内 API、没有常驻进程，容器一启动就退出，`NetworkSettings.Ports` 为空，报 `agent port 8080 is not published`。
- **坑三：`api/.env` 没人加载**。清单让人写 `api/.env`，而当时入口是裸 `node`，照抄的人拿到的全是默认值，直接掉进坑二。清单还漏了装 pnpm 和 `cd api`：在根目录执行时 corepack 读的是根 `package.json` 的 pnpm 版本。

教训是：一份「能照抄的清单」如果没被真照抄跑过一遍，它写的是作者记忆里的流程，不是仓库当下的行为。

**落点**：`.env.example` 里 `DATABASE_URL` 改为注释掉；`start`、`start:dev`、`db:migrate` 都带 `--env-file-if-exists=.env`，且 shell 变量优先于文件；`SANDBOX_DEFAULT_IMAGE` 留空时按宿主档位选平台发布的镜像。本地步骤收敛到 CONTRIBUTING。

### D-7 前后端之间那一层（2026-08-30）

**现象**：本地前端直连后端在真浏览器里跑不通，单测却全绿；WS 基址写成绝对地址后，同事从局域网打开时连到他自己机器的端口，界面一直「正在重连…」。

**根因**：

- 当时后端没有 CORS，而 `ap_session` 是 HttpOnly cookie，跨源还需要 `credentials: 'include'` 加精确 Origin 白名单；MSW 替身让前端与它自己的替身完全自洽，所以单测发现不了。
- `NEXT_PUBLIC_*` 是构建期烤进 bundle 的，而 WS 基址取决于运行时访问者用的 host。`ws://localhost:3001` 曾被烤进生产 bundle，1001 条测试一条都没红。
- 「WS 不能走 rewrites」的说法在 Next 15.5.23 上不成立。加上三条 `/socket.io` 规则后 polling 与 websocket 都能经 Next 转发；但必须开 `skipTrailingSlashRedirect`（否则握手被 308，客户端不会跟着重定向再发 upgrade），空 path 的两条规则要把尾斜杠写死在 destination 里（否则 Next 吃掉 `/`，后端 404）。
- `next start` 默认绑 `0.0.0.0`。`HOSTNAME=127.0.0.1 pnpm start` 静默无效，`pnpm start -- -H 127.0.0.1` 会把 `--` 透传给 next 而启动失败，只有 `pnpm start -H 127.0.0.1` 是对的。
- 一套 demo 是两个进程，半死的一套最难认：后端被挤掉时前端照常渲染、每个 `/api/*` 都失败；远程用 `nohup` 起的 Next 会被 ssh 断开的 SIGHUP 带走，要用 `setsid`。

**落点**：本地与 compose 形态用 Next rewrites 同源转发、两个 `NEXT_PUBLIC_*_BASE_URL` 留空；后端后来为生产的 Vercel 前端开启了按 `API_ALLOWED_ORIGINS` 精确放行的 credentialed CORS。现行做法见 CONTRIBUTING 与 `web/next.config.mjs` 的注释。

### D-8 loopback 发布与 DooD 互斥（2026-08-29 / 08-30）

**现象**：`docker compose up` 一切正常（api `Up`、health 200、镜像播种成功），建 Task 却必定失败，而沙箱容器本身是健康的：

```
status: failed
failureCode: PROVIDER_UNAVAILABLE
failureMessage: in-sandbox agent at http://127.0.0.1:45171 did not become ready
platform-aio-<id>  Up 11 seconds (healthy)  127.0.0.1:45995->8080/tcp
```

**根因**：两条各自正确的决定撞在一起：agent 端口只发布到宿主 loopback（安全加固），`agentOrigin` 又照着 `HostIp` 拼回调地址。DooD 下端口在宿主的 netns，api 的 `127.0.0.1` 却是容器自己的。实测同一个 `127.0.0.1:18080`：宿主 `curl` 回 401，api 容器内 `fetch` 回 `fetch failed`。

修好之后又撞到另一半：api 裸跑在宿主却配了 `SANDBOX_DOCKER_NETWORK`，`agentOrigin` 是容器名而宿主解析不了，sandbox 卡在 starting 超过 6 分钟，无错误、无超时、无日志。`not attached` 守卫只查沙箱容器在不在网络上，从没查过调用方自己。

开机自检的判据当时在真 Linux（Docker Engine 28.3.2 / API v1.51）上按生产形态逐条验过：

| # | 实测 | 结果 |
|---|---|---|
| ① | `GET /containers/json?filters={"network":["<net>"]}` | 返回该网络上的容器与它的地址，filter 真的被支持 |
| ② | 在那个容器里 `ip -o -4 addr` | 与 daemon 报的地址一字不差，交集判定的前提成立 |
| ③ | 宿主自己的地址表里有没有那个地址 | 没有 ⇒ api 裸跑时判定 not-attached，与实情一致 |
| ④ | 网络名写成 `proj_<net>`（模拟 compose 项目名前缀） | 名单返回 `[]` ⇒ 判定 not-attached，与实情一致 |

同白名单（`CONTAINERS/EXEC/IMAGES/POST`）的 `docker-socket-proxy` 对照：容器列表请求穿得过去，`GET /networks/<net>` 回 403，这是自检不走 `/networks` 的实证理由。

同一时期还修了同一病根的两处：`oci-registry.client.ts` 只认 loopback 字面量走明文（容器里指容器自己），播种失败的提示让人「把 `SANDBOX_DEFAULT_IMAGE` 指向预制镜像」而它其实已经指着了。

**落点**：`SANDBOX_DOCKER_NETWORK` 形态、开机自检、`IMAGE_REGISTRY_INSECURE_HOSTS` 与按形态分岔的播种提示，见 11 §1.4。
