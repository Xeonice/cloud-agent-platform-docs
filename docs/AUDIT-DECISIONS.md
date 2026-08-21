# 审计决策记录（AUDIT-DECISIONS）

> 状态：已定案 · 来源：独立架构师审计（2026-08）+ 用户裁决
> 本文是审计结论的裁决存档。技术文档按本文修订；本文与技术文档冲突时，以本文为准直到用户另有指示。

## 0. 裁决摘要（用户 2026-08 拍板）

| 项 | 裁决 |
|---|---|
| P0-1 工作区物理形态 | **方案 A · 宿主 bind mount 目录** |
| P0-2 事务模型 | **先验证 better-sqlite3 同步性，再改同步事务模型** |
| P0-3 安全姿态 | **两条都做**（默认监听 127.0.0.1 + 访问口令 Guard 提前 MVP） |
| MVP 瘦身四刀 | **全部否决**（无时间成本约束，保留完整架构：boxlite 双实现 / PG 双方言 / 契约发 npm 包 / application 层全展开） |

---

## 1. P0（阻塞实现，写第一个 controller 前必须清算）

### P0-1 · 工作区物理形态 = 方案 A（宿主 bind mount 目录）
- 工作区改用宿主目录：Task 副本 `${DATA_ROOT}/workspaces/<sandboxId>`、项目基线 `${DATA_ROOT}/baselines/<projectId>`；`DATA_ROOT` 同时挂进 api 容器（DooD 下 compose 用同一绝对路径挂载，宿主/容器路径一致）。
- clone = 平台进程内 `simple-git` 写入 `baselines/`；复制 = `cp -a`（同 fs 时 `cp --reflink=auto` 拿 CoW）；半成品清理 = `rm -rf`（扫目录标签 `platform.workspace.state=preparing`）；`VolumeReaper`/对账退化为目录扫描。
- **连带必改（状态序列）**：`creating → preparing-workspace → starting` 改为 **`scheduling → preparing-workspace → creating → starting`**——先备好工作区，`provider.create()` 时卷已存在，04 §2.4 的 `volumes` 语义自洽。
- 影响面：03 §4/§7、04 §2.4、13 §2.1（status CHECK 枚举顺序注释）、23 I-SBX-9、24 §1（时序 + 补偿表）、25 T-SBX-3/T-SBX-22/E2E-1、26 §1、11 §1（compose 挂载 + 推荐文件系统 btrfs/xfs）。

### P0-2 · 事务模型 = 先验证再改
- **先写 ~20 行验证脚本**证伪 better-sqlite3 在 `db.transaction(async cb)` 下是否会在首个 `await` 让出时就结束事务。
- 若证实：仓储"事务内写"改**同步签名**（`saveSync(tx, agg): void`），异步端口（provider/crypto/git）**一律在事务外**，事务内只做纯内存→SQL 写入；`UnitOfWork.run(fn: (tx) => T): T` 同步返回。**不为此换驱动**（同步事务在单机单进程足够）。
- 23 §5.7/§6.5/§7.6/§8.7/§11.6 仓储接口拆"聚合读(async)"与"事务内写(sync)"两组；25 §2.1 in-memory 替身加"同样同步写"要求（否则 L1 假绿）；REPO-TX 用例复核。
- 影响面：改动面最大的一条，牵动全部 repository 签名 + 24 R-1 + 26 全部事务标记。

### P0-3 · 安全姿态 = 两条都做
- ① compose 默认 `ports: ["127.0.0.1:3000:3000"]`；改 `0.0.0.0` 需显式配置，启动日志与系统状态页打醒目警告。
- ② 访问口令 Guard 从 v1.1 提前到 MVP（规格 11 §3.1 已完整：16 位、5 次锁 5 分钟、7 天签名 cookie、三面生效、STDIO 豁免）。
- ③ 05 §6 风险"服务端长期持有 OAuth 凭证"由中→高；P19 安全表达补一致边界说明。
- 影响面：11 §1/§3/§3.1、P19 §3（口令挪进 MVP）、P21-8 §3（v1.1→MVP）、02 §6、06 §2、13 §2.8.2、09 CI。

---

## 2. MVP 瘦身四刀 → 全部否决（保留完整架构）

boxlite 双实现、PG 双方言、契约发 npm 包、application 层全展开——**全部保留**。但以下三处一致性矛盾与成本无关，仍需定向修正（均朝"保留完整架构"一侧）：

- **M-1**：boxlite 保留为 day-one → 把 P19 的 boxlite 从 v2.0/COULD **上提到 MVP MUST**（产品文档追上技术文档，而非反向砍）。
- **M-2**：`VolumeMount.kind: 'bind'|'named-volume'|'tmpfs'` 是纯 Docker 词汇，违反 04 §2.0"contract 不含具体运行时词汇" → 改中立措辞（如 `persistent|ephemeral|host-path`）。
- **M-3**：application 层保留全展开 → 01 §6"commands/queries 可先合并为 use-cases 单目录"与 26"写死拆分"冲突 → 删 01 §6 的"可合并"选项、统一到 26。

---

## 3. 其余 P1（真·正确性/一致性，全部采纳）

| 项 | 问题 | 处置 |
|---|---|---|
| P1-2 | WS 推送 P19 标 SHOULD，waiting-input/进度卡全依赖它 | P19 WS 推送提到 MUST |
| P1-3 | validate 端点两版本冲突（前端已用无 id 版） | 拆两端点：`POST /api/images/validate`（注册前预检，不落库）+ `POST /api/images/:id/validate`（已注册重验证） |
| P1-4 | 全库无统一错误响应 schema | 10 新增 §6.8 错误 envelope（`code/message/retryable/traceId/details[]`），非 2xx 一律遵守；25 每错误码加 envelope 完整性用例 |
| P1-5 | REST 命名 snake/camel 混用 | 对外一律 camelCase（`?projectId=`、`{isActive, imageConfig}`），DB 保持 snake_case，映射在 repository 层 |
| P1-6 | 权威端点清单缺项 + 同端点三名 | 补 `DELETE /api/images/:id`、`GET /api/system/providers`（统一名）、`GET /api/health`；09 CI 加"10 §6 路径集合 ⊇ openapi.json paths" |
| **P1-7** | Codex 凭证刷新回写只有一句话，缺整条组件，击穿"登录一次处处可用" | **先技术验证**（Codex 能否平台侧凭 refresh token 刷新）；A=平台侧统一刷新（推荐，与决策 A 一致）/ B=CredentialSyncBack 从 sandbox 回收。MVP 必补，落 05 §5 + 01 + 26 + 25 + 13 |
| P1-8 | preparing-workspace 未进产品 6 态映射（11/12 态打架） | P21-4 §2.1 改"12 技术状态"，🟡 准备中补 preparing-workspace；04 §2.4 注释改 12；前端状态矩阵行数加 CI 断言 |
| P1-9 | 磁盘不被调度，而它才是真实瓶颈 | ResourcePoolSnapshot 加 `totalDiskMb/usedDiskMb`；`disk_mb_reserved` 在互斥区内按 `baseline_size_bytes×1.2` 登记（消 TOCTOU）；P21-5 展示磁盘水位 + 保留卷占用治理横幅；11 §1 推荐 btrfs/xfs |
| P1-10 | testkit SP-T2(MUST) 实际要求必有 tmux，与 04 §7(SHOULD) 矛盾 | SP-T2 降 SHOULD + 注明"无会话保活则降级网关 ring buffer"，或挂新能力位 `sessionReattach`。**⚠️ 2026-08 部分被取代**：tmux 已升 MUST（04 §7），本行认定的矛盾前提消失，"降级网关 ring buffer"那半句作废。**SP-T2 仍维持 SHOULD，但换了理由**——保活由沙箱内 tmux 提供，与 provider 支不支持 `ref` 复用正交（04 §10.2）|
| P1-11 | Vault master key 生成/存放/轮换/备份全未定义 | 05 新增 §4.2：优先读 `PLATFORM_MASTER_KEY` env，未设则首启生成 32 字节写 `${DATA_ROOT}/.master.key`(0600) + 提示；轮换=新 key 后台逐条重加密更新 `encryption_key_id`；备份不含 key，恢复缺 key 时凭证以 revoked 呈现引导重授权（不静默失败）；25 §3.4 补用例 |
| P1-12 | waitingInput 派生字段取数违反分层 | terminal application 层暴露只读查询端口 `WaitingInputQueryPort`，sandbox 经 DI 注入；检测器仍在 terminal/infrastructure；同步 06 §8.2/01 §2/26 §9/23 §10.4 |
| P1-13 | headless 的 timeoutMinutes 缺省未定义，撞 DB CHECK 抛 500 | 02 §5.1/§5.2 明写 headless=true 缺省 120；headless=false 传 timeout 一律 400；25 补 2 用例 |
| P1-16 | README 严重过期 + 计数漂移(17/16 表、11/12 态) + 无机器校验 | 修 README（补 23-26/pages、改计数）、13 两处计数、清 25 §1.2 过期告警；CI 加 `docs:check`（相对链接可达 + `xx §y.z` 引用目标存在 + README 清单==实际文件）；**不再新增全局编号文档** |

---

## 4. P2（可推迟，实现期逐条处理）

P2-1 Outbox 单进程内改事务后同步 in-process dispatch（relay 退化为启动补投）· P2-2 automation_runs `resource-exhausted` 语义 · P2-3 WS patch 用 `setQueriesData` 覆盖全部匹配缓存 · P2-4 `POST /api/system/init` 409 非幂等表述 · P2-5 卷端点统一 `/api/retained-volumes` · P2-6 P21-4 §10.5 的 30+ 示例参数标注"仅示例不校验" · P2-7 生命周期端点动作 vs 更新判据补注 · P2-8 01 §2 与 26 §13 文件清单脚本生成 · P2-9 `socket_session_key` 服务端生成（防终端接管）· P2-10 SP-03/IS-01 拉取职责 · P2-11 前端 LRU 默认降 4-6 · P2-12 webhook 私网放行依赖口令启用 · P2-13 Claude Code MVP 仅 api-key 路径（对齐 P19，但注意瘦身否决——此项按"保留完整"重新评估是否仍做 setup-token）。

> 注：P2-13 原建议基于瘦身；瘦身已否决，setup-token 路径是否推迟由后端 agent 结合 04/05 既有 adapter 完整度重新判断，报告结论。

---

## 5. 值得保留、禁止误改（审计确认的亮点）

waiting-input"只驱动展示不驱动决策"红线 · 凭证靠写入顺序而非黑名单取胜 · preparing-workspace 升格三判据（可失败/可耗时/专属清理）· spawn 唯一进程原语 · golden fixture 版本矩阵纪律（勿挪进可选门）· 测试替身最低语义 + REPO-CONSIST · SecretMaterial 类型级三纪律 · 分组树是派生视图非状态 · 产品默认值哲学两步向导 · shared-kernel 不含业务概念判据。
