---
id: PRD-ACC
title: 访问口令 · 产品需求
type: prd
domains: [ACC]
flows: [F-ACC-UNLOCK]
status: current
---

# 访问口令 · 产品需求

本文定义当前产品行为与验收条件；REQ/AC 编号保持稳定。适用范围与互斥规则见 [产品裁决](./decisions.md)。验收结果由实际执行记录维护，不在规格中保存实现进度。

## 一屏摘要

- **这一域回答什么**：访问口令——口令从哪来、被拒时的全屏口令门、口令不对与连错锁定、会话与豁免面、换口令时能不能让已登录的浏览器失效（REQ-ACC-001–007）。界面里的口令管理区块本轮不做（D9 推荐 Q-SYS-07②，见 SYS.md REQ-SYS-050）。
- **五条要守的规则**：
  1. 口令默认开启：首次启动时生成，只在服务日志里给一次，不在界面里给（REQ-ACC-001，D3 推荐）。
  2. 被拒即全屏口令门，底下**不**挂工作台；解锁后重跑初始化判定（REQ-ACC-003）。
  3. 只有「提交口令」的失败才计入锁定，按分钟说剩多久（REQ-ACC-005）。
  4. 会话按浏览器、固定 7 天不顺延；换口令默认不踢人，可选「同时让已登录的浏览器失效」；口令不能替代 Host / Origin 校验（REQ-ACC-006、007，来源校验属 NFR-SEC）。
  5. 换口令、忘记口令走环境变量或接口；回环免口令要显式开启（REQ-ACC-002）。

## 需求索引

**共 7 条需求、28 条验收标准**。

| 编号 | 需求 | 版本 | AC | 产品裁决 |
| --- | --- | --- | --- | --- |
| [REQ-ACC-001](#REQ-ACC-001) | 口令默认开启：首次启动生成，只在服务日志里显示一次 | MVP | 3 | [Q-SYS-07②](./decisions.md#Q-SYS-07) |
| [REQ-ACC-002](#REQ-ACC-002) | 换口令与忘记口令；回环免口令要显式开启 | MVP | 4 | [Q-ACC-01](./decisions.md#Q-ACC-01) [Q-SYS-07②](./decisions.md#Q-SYS-07) |
| [REQ-ACC-003](#REQ-ACC-003) | 被拒即全屏口令门，底下不挂工作台；解锁后重跑初始化判定 | MVP | 4 | — |
| [REQ-ACC-004](#REQ-ACC-004) | 口令卡：输入、解锁、验证中、口令不对、口令从哪来 | MVP | 4 | — |
| [REQ-ACC-005](#REQ-ACC-005) | 连错锁定：只数提交口令的失败，按分钟说 | MVP | 5 | — |
| [REQ-ACC-006](#REQ-ACC-006) | 会话：7 天、按浏览器；豁免面 | MVP | 4 | [Q-ACC-01](./decisions.md#Q-ACC-01) |
| [REQ-ACC-007](#REQ-ACC-007) | 换口令时可选「同时让已登录的浏览器失效」 | MVP | 4 | [Q-ACC-01](./decisions.md#Q-ACC-01) [Q-SYS-07②](./decisions.md#Q-SYS-07) |

## ACC · 访问口令门（F-ACC-UNLOCK）

### REQ-ACC-001 · 口令默认开启：首次启动生成，只在服务日志里显示一次 {#REQ-ACC-001}

> 版本 MVP

全新数据目录、没有设 `ACCESS_PASSCODE` 时，平台首次启动**必须**生成一个访问口令（16 位，不含 0 O l 1 这类易混字符）并开启口令门；口令明文只在这一次启动的服务日志（stdout）里打一段醒目的横幅：口令；为什么现在就记下来（平台只存哈希，之后的日志、页面、接口都不再显示它）；之后打开平台都要先输入它（同一个浏览器 7 天内免输，REQ-ACC-006）；换口令的两种方式与忘了怎么办（REQ-ACC-002），以及换口令时怎样同时让已登录的浏览器失效（REQ-ACC-007）。之后的启动**不得**再打印口令，只打一行「access passcode ENABLED via <来源>」。口令横幅**不得**写进平台日志文件、**不得**进 [导出日志] 的包；README 写明 docker 的 json-file 日志驱动会保留 stdout（`docker logs` 仍能查到那一次输出）。

| AC | 层级 | Given | When | Then |
| --- | --- | --- | --- | --- |
| AC-ACC-001.1 | 集成 | 全新 DATA_ROOT、未设 ACCESS_PASSCODE | 启动 | stdout 出现一次口令横幅；库里只有哈希；口令门开启 |
| AC-ACC-001.2 | 集成 | 已生成过口令 | 再次启动 | 不再打印口令，只打「access passcode ENABLED via stored …」一行 |
| AC-ACC-001.3 | 集成 | 首次启动打印过口令 | 导出日志包；读平台日志文件 | 两处都没有口令明文 |

### REQ-ACC-002 · 换口令与忘记口令；回环免口令要显式开启 {#REQ-ACC-002}

> 版本 MVP · 关联 REQ-SYS-050、REQ-ACC-007

换口令有两种方式：① 部署配置里设 `ACCESS_PASSCODE=<新口令>`，重启生效；设了它就以它为准，接口改不动（409，说明口令由部署配置固定）；② 用当前口令解锁后调 `PUT /api/system/access-passcode {"action":"regenerate"}`，新口令只在那次响应里返回一次。忘了口令：用 ① 重设并重启。换口令默认不让已解锁的浏览器失效（REQ-ACC-006）；要同时让它们失效，换口令时选「同时让已登录的浏览器失效」（两条路各怎么做见 REQ-ACC-007，Q-ACC-01 C）。界面里的口令管理区块不在本轮（D9 Q-SYS-07②，REQ-SYS-050）。

回环免口令：默认不免——来自本机回环地址的访问同样要口令（进程内看不到宿主把端口发布在哪，平台不能自己判断「这是本机」）；只有部署方显式开启（变量名由实现定，写进 README）后，来自回环地址的请求才免口令，来自非回环地址的仍然要。

| AC | 层级 | Given | When | Then |
| --- | --- | --- | --- | --- |
| AC-ACC-002.1 | 集成 | 设了 ACCESS_PASSCODE | 调 regenerate | 409，说明口令由部署配置固定；口令不变 |
| AC-ACC-002.2 | 集成 | 口令来自库，不带「同时让已登录的浏览器失效」 | 调 regenerate | 200，响应里有新口令（只此一次）；旧口令立即失效；已解锁的会话仍有效 |
| AC-ACC-002.3 | 集成（L5） | 口令开启、未开回环免口令 | 从 127.0.0.1 访问受保护接口 | 要口令 |
| AC-ACC-002.4 | 集成（L5） | 开启回环免口令 | 分别从回环 / 非回环地址访问 | 回环免口令，非回环仍要 |

### REQ-ACC-003 · 被拒即全屏口令门，底下不挂工作台；解锁后重跑初始化判定 {#REQ-ACC-003}

> 版本 MVP

任何受保护请求被口令门拒绝（REST 401 `PASSCODE_REQUIRED` / `PASSCODE_INVALID`、429 `PASSCODE_LOCKED`，或终端 / 事件 WebSocket 握手未授权）→ 整个应用**必须**换成全屏口令门：不透明的中性底，正中是品牌行（与侧栏实例菜单同一个 Logo 与名称 +「本机」）和口令卡；口令门之下**不得**挂工作台或向导（不渲染、不发它们的请求）。口令卡本身是模态对话框（role=dialog、aria-modal、名称「访问口令」）。解锁成功后**必须**重新跑一次初始化判定，再决定进初始化向导还是工作台；之前被拒的查询自动重取，终端与事件连接在下一次重连时通过。判定依据是错误码，不是 HTTP 状态（429 也算）。

| AC | 层级 | Given | When | Then |
| --- | --- | --- | --- | --- |
| AC-ACC-003.1 | e2e | 口令开启、浏览器没有会话 | 打开首页 | 只有全屏口令门（中性底 + 品牌行 + 口令卡）；DOM 里没有工作台与向导；不发项目 / 任务等请求 |
| AC-ACC-003.2 | e2e | 口令门 | 解锁成功 | 重新判定：未初始化 → 向导；已初始化 → 工作台 |
| AC-ACC-003.3 | 组件 | 已解锁使用中 | 会话到期，下一次请求 401 | 回到全屏口令门 |
| AC-ACC-003.4 | 组件 | 收到 429 `PASSCODE_LOCKED` | — | 也进口令门（锁定态见 REQ-ACC-005） |

### REQ-ACC-004 · 口令卡：输入、解锁、验证中、口令不对、口令从哪来 {#REQ-ACC-004}

> 版本 MVP

口令卡：标题「需要访问口令」；说明「这个平台设了访问口令，输入后才能继续。」（`PASSCODE_REQUIRED` 的前端句）；字段「访问口令」（遮罩、不自动填充、打开时焦点在这里）；[解锁]（整宽主按钮，没输入时禁用；回车提交；提交前去掉首尾空白）；表单说明「口令只在首次启动时输出在服务日志里，可以找部署这台平台的人要；忘了可以用环境变量 ACCESS_PASSCODE 重设。」。提交中：输入框禁用、按钮「验证中…」带转圈。口令不对（`PASSCODE_INVALID`）：输入框错误态 + 紧跟一句「口令不对，再试一次。」（role=alert；图标带错误色，句子正文色），保留刚才的输入，[解锁] 可再点。口令卡上**不得**出现后端原句或秒数。

| AC | 层级 | Given | When | Then |
| --- | --- | --- | --- | --- |
| AC-ACC-004.1 | 组件 | 口令门出现 | 渲染 | 标题、前端说明句、字段（焦点在此）、禁用的 [解锁]、口令从哪来那句 |
| AC-ACC-004.2 | 组件 | 输入了口令 | 回车 / 点 [解锁] | 提交去掉首尾空白的口令；输入框禁用；按钮「验证中…」带转圈 |
| AC-ACC-004.3 | 集成 | 口令不对（第 1–4 次） | 提交 | 输入框错误态 +「口令不对，再试一次。」；输入保留；可再提交 |
| AC-ACC-004.4 | 集成 | 口令正确 | 提交 | 设会话 cookie（REQ-ACC-006），离开口令门（AC-ACC-003.2） |

### REQ-ACC-005 · 连错锁定：只数提交口令的失败，按分钟说 {#REQ-ACC-005}

> 版本 MVP · 关联 PARAM.PASSCODE_MAX_FAILURES

同一来源（客户端 IP）连续提交错误口令 `PARAM.PASSCODE_MAX_FAILURES` 次，锁 `PARAM.PASSCODE_LOCK_MIN` 分钟：达到次数的那一次仍说「口令不对」，之后锁定期间的提交一律被拒（429 `PASSCODE_LOCKED`，带剩余秒数）。**只数在提交口令的请求**（解锁接口、带口令头的请求）；没带口令、只是还没解锁的普通请求（打开页面时的那一轮并发拉取）**不得**计入失败次数，否则用户还没输口令就被自己的页面锁住。带有效会话的请求不受锁定影响。锁定时口令卡显示「错得太多次，已暂时锁定，约 N 分钟后再试。」（剩余秒数向上取整成分钟；锁图标带错误色、句子正文色，role=alert），保留输入，锁定期间 [解锁] 置灰，到点自动恢复可点。解锁成功清零计数。

| AC | 层级 | Given | When | Then |
| --- | --- | --- | --- | --- |
| AC-ACC-005.1 | 集成 | 同一 IP | 连续提交错口令 5 次、再提交 | 第 5 次回 401 `PASSCODE_INVALID`；第 6 次起 429 `PASSCODE_LOCKED`（带 retryAfterSec） |
| AC-ACC-005.2 | 集成 | 口令开启、浏览器没有会话 | 首屏发出 ≥ 5 个没带口令的受保护请求（都 401）后，用户提交正确口令 | 解锁成功 |
| AC-ACC-005.3 | 组件 | 收到 `PASSCODE_LOCKED`，retryAfterSec=287 | 渲染 | 「错得太多次，已暂时锁定，约 5 分钟后再试。」；[解锁] 置灰；输入保留 |
| AC-ACC-005.4 | 集成 | 锁定到期，期间没有成功解锁 | 再错一次 | 立即再锁 5 分钟（连续失败计数到成功为止才清零） |
| AC-ACC-005.5 | 集成 | 已解锁的浏览器 | 同一 IP 上有人连错 5 次 | 已解锁的浏览器照常使用 |

### REQ-ACC-006 · 会话：7 天、按浏览器；豁免面 {#REQ-ACC-006}

> 关联 Q-ACC-01

解锁成功后发一个签名会话 cookie（HttpOnly、SameSite=Lax，TLS 下可加 Secure），有效期 `PARAM.PASSCODE_SESSION_DAYS` 天，从解锁那一刻算（不随使用顺延）；平台重启不影响会话。会话按浏览器：换浏览器或无痕窗口要重新输入。换口令（REQ-ACC-002）默认不使已解锁的会话失效；换口令时选了「同时让已登录的浏览器失效」，此前签发的会话一律作废（REQ-ACC-007）。口令门覆盖 REST、MCP over HTTP、终端与事件 WebSocket；豁免 `GET /api/health` 与解锁接口本身；本机 STDIO 的 MCP 天然不经过它。

| AC | 层级 | Given | When | Then |
| --- | --- | --- | --- | --- |
| AC-ACC-006.1 | 集成 | 解锁成功 | 读响应头 | `ap_session`：HttpOnly、SameSite=Lax、Max-Age 7 天；PASSCODE_COOKIE_SECURE=true 时带 Secure |
| AC-ACC-006.2 | 集成 | 解锁后每天都在用 | 第 8 天 | 会话过期，回口令门 |
| AC-ACC-006.3 | 集成 | 已解锁 | 平台重启 | 会话仍有效 |
| AC-ACC-006.4 | 集成 | 口令开启、没有会话 | `GET /api/health`；`POST /api/access/unlock` | 都不被拦 |

### REQ-ACC-007 · 换口令时可选「同时让已登录的浏览器失效」 {#REQ-ACC-007}

> 版本 MVP · 关联 REQ-ACC-001、REQ-ACC-002、REQ-ACC-006、REQ-SYS-050

换口令时**必须**能选「同时让已登录的浏览器失效」，默认**不选**：换一次口令不该把所有人踢下线（技术 11 §3.1 的取舍保留为默认），但口令外泄时要能一并止住已经解锁的浏览器（P21-8 L355 的本意）。

- **接口**：`PUT /api/system/access-passcode {"action":"regenerate"}` 加一个可选参数（例 `signOutAllSessions: true`，名字由实现定，写进 openapi）。选了它：换口令的同时轮换会话签名密钥——此前签发的会话一律作废，那些浏览器下一次请求就回到全屏口令门（REQ-ACC-003），要用新口令重新解锁；发起这次请求的会话（若是浏览器）随响应换发新 cookie，不被自己踢出。不选：与今天一样，已解锁的会话不受影响（REQ-ACC-006）。两种结果都记一条审计，并写明选了哪一种。
- **签名密钥由部署配置固定时**（设了 `PASSCODE_COOKIE_SECRET`）：平台改不动它，带这个参数的请求**整个**被拒（409，口令也不换，零副作用），原因写「会话签名密钥由部署配置 PASSCODE_COOKIE_SECRET 固定：要让已登录的浏览器失效，改这个变量后重启」——**不得**只换了口令、悄悄没让旧会话失效。
- **环境变量那条路**（改 `ACCESS_PASSCODE` 后重启，REQ-ACC-002 ①）：口令换了，已解锁的会话默认仍有效；要同时让它们失效，同时把 `PASSCODE_COOKIE_SECRET` 设成一个新值再重启。
- **说在哪**：界面里的口令管理区块本轮不做（D9 Q-SYS-07②，U-112 延后，REQ-SYS-050），**不得**为这一项另造管理页；上面两条路写进 README 的「换口令」一节，首次启动的口令横幅在「换口令的两种方式」后面接一句怎样同时让已登录的浏览器失效（REQ-ACC-001）。区块以后做的时候，[重新生成口令] 的确认里露出这个选项（默认不选）。

| AC | 层级 | Given | When | Then |
| --- | --- | --- | --- | --- |
| AC-ACC-007.1 | 集成 | 口令来自库；浏览器 A、B 都已解锁 | A 调 regenerate 并选「同时让已登录的浏览器失效」 | 200，响应里有新口令（只此一次）；B 的下一次请求回到口令门；A 随响应拿到新会话、不被踢出；审计写明选了让已登录的浏览器失效 |
| AC-ACC-007.2 | 集成 | 同上 | A 调 regenerate、不带这个参数 | 新口令生效、旧口令立即失效；A、B 的会话都仍有效 |
| AC-ACC-007.3 | 集成 | 部署配置设了 PASSCODE_COOKIE_SECRET | 调 regenerate 并选这个参数 | 409，原因说签名密钥由部署配置固定、要改变量后重启；口令不变（零副作用） |
| AC-ACC-007.4 | 文档 | — | 读 README「换口令」一节与首次启动的口令横幅 | 都写了怎样同时让已登录的浏览器失效（接口参数；改 PASSCODE_COOKIE_SECRET 后重启）；界面里没有为这一项新造的页面 |

---

## 参数

### 新增参数（待并入 params.yaml）（crd-a）

| id | 值 | 单位 | kind | 含义 | used_by | 代码落点（pattern） |
|---|---:|---|---|---|---|---|
| PARAM.AUTH_POLL_INTERVAL_S | 3 | 秒 | product | 设备码登录查结果的间隔 | REQ-AUTH-004 | web/src/hooks/credential/useRuntimeAuthFlow.ts `POLL_INTERVAL_MS = ([\d_]+)`（scale 0.001） |
| PARAM.AUTH_POLL_MAX_MIN | 10 | 分钟 | product | 前端最多等多久就先停下（与码有效期无关的兜底） | REQ-AUTH-005 | 同文件 `MAX_POLL_DURATION_MS = (\d+) \* 60` |
| PARAM.DEVICE_CODE_TTL_MS | 900000 | 毫秒 | tech | 平台给设备码登录会话的有效期（TC-AUTH-001 已用此名） | REQ-AUTH-004、REQ-AUTH-010 | api/packages/modules/runtime/src/application/runtime-application.service.ts `DEVICE_CODE_TTL_MS = (\d+) \* 60_000`（scale 60000） |
| PARAM.DEVICE_CODE_WARN_S | 300 | 秒 | product | 倒计时转警示色的剩余时间 | REQ-AUTH-004 | web/src/views/wizard/auth/DeviceCodeAuth.view.tsx `WARN_THRESHOLD_SEC = (\d+) \* 60`（scale 60） |
| PARAM.AUTH_SUCCESS_HOLD_MS | 2000 | 毫秒 | product | 「已连上」最短停留时间（DR-21） | REQ-AUTH-008 | 待实现 |
| PARAM.AUTH_SESSION_MAX | 2 | 个 | tech | 全机同时进行中的登录会话上限（TC-AUTH-001 已用此名） | REQ-AUTH-010 | 待实现（BE4） |
| PARAM.PASSCODE_MAX_FAILURES | 5 | 次 | product | 连续提交错误口令多少次后锁定 | REQ-ACC-005 | api/apps/api/src/platform/access-passcode/passcode-attempt-limiter.ts `MAX_FAILURES = (\d+)` |
| PARAM.PASSCODE_LOCK_MIN | 5 | 分钟 | product | 锁定时长 | REQ-ACC-005 | 同文件 `LOCK_MS = (\d+) \* 60` |
| PARAM.PASSCODE_SESSION_DAYS | 7 | 天 | product | 解锁后会话有效期 | REQ-ACC-006 | passcode.service.ts `COOKIE_TTL_MS = (\d+) \* 24`；session-cookie.ts `COOKIE_MAX_AGE_SEC = (\d+) \* 24`（两处落点，标 duplicated） |
