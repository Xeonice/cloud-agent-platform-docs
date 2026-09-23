# 云 Agent 管理平台

单机私有化部署的沙箱 AI agent 平台。数据、代码、凭证不出本机；对外同时提供
**MCP** 与 **REST(OpenAPI)** 两套协议面。

> ⚠️ **Agent 需要出网访问 OpenAI / Anthropic API —— 不支持完全离线运行 Agent。**
> 这是物理约束不是缺陷：私有化保护的是你的代码与凭证，模型推理本身在对方那边。

当前版本 **v0.1.0**（首个发布标记，**不等于**产品路线图里的 v1.0/MVP 验收线，见
[CHANGELOG](./CHANGELOG.md)）。

---

## 1. 取代码

```bash
git clone --recursive https://github.com/Xeonice/cloud-agent-platform-docs.git
cd cloud-agent-platform-docs
```

> 📌 **用 https 而不是 `git@github.com:`** —— 三个仓都是公开的，https 形式**一份凭证都不需要**。
> SSH 形式即便对公开仓也要求先配好 SSH key，那是给要往回推代码的人用的，不该成为
> 「装一个实例」的前置。
>
> ⚠️ **`.gitmodules` 里的两个 submodule 也必须是 https，这一条 2026-09-23 才补上。**
> 在那之前主仓能 https clone、两个 submodule 却写着 `git@github.com:` ⇒ 一台没有
> GitHub SSH key 的机器上 `--recursive` **必然失败**（`Host key verification failed`），
> 而上面这句「一份凭证都不需要」只对主仓成立。
> ⛔ 这个坑在有 key 的机器上永远看不见 —— 它是在**第二台干净机器**上装的时候才现形的。

> ⛔⛔ **`--recursive` 不能省。** 后端与前端是两个 submodule（`api/` `web/`），漏了这个参数
> 拿到的是**两个空目录** —— 没有 `Dockerfile`、没有 compose 文件，而失败的样子像"仓库不全"
> 而不是"你少了个参数"。
>
> 已经 clone 过了才发现：`git submodule update --init --recursive`

## 2. 前置条件

| | 要求 | 不满足会怎样 |
|---|---|---|
| **Docker Engine** | ≥ 20.10 | 低于此版本没有 `host-gateway`，容器连不到宿主上的 registry |
| **Docker Compose** | v2（`docker compose` 子命令） | v1 的 `docker-compose` 不认 `include:` |
| **磁盘** | **≥ 50 GB 可用** | 见下 ⚠️ |
| **内存** | ≥ 8 GB（每个并发 Task 还要一份） | Task 排队或被 OOM |
| **KVM** | **不需要** | 见 §6 |

> ⚠️⚠️ **磁盘是这个平台真实的瓶颈，不是凑数的第三条。**
> 默认档（`aio`）的预制镜像**压缩 4.08 GB、解压约 13 GB**，再加 boxlite 的 rootfs 缓存与
> **每个 Task 一份工作区副本**。CPU/内存到顶的表现是「新 Task 排队」，磁盘到顶的表现是
> **clone 写到最后 ENOSPC、镜像拉一半失败** —— 后者既更常见也更难自我解释。

## 3. 起服务

> ⚠️⚠️ **网络受限的机器要先给【容器运行时】配代理 —— 这和向导里那个代理设置不是一件事。**
>
> 部署要从两处拉镜像：
> - **Docker Hub** —— `node:22-bookworm-slim`（api 与 web 两个镜像的基础层）、
>   `tecnativa/docker-socket-proxy`
> - **ghcr.io** —— 平台自己的两张预制沙箱镜像
>
> ⛔ 向导 Step 2 那个代理**救不了这一步**：它配的是 **Agent 出网**用的代理，存在
> `system_settings` 表里，而镜像是 **docker daemon** 去拉的 —— 两者走的是完全不同的路径。
> 所以 daemon 的代理必须在容器运行时里单独配（Docker Desktop / OrbStack 的设置里都有）。
>
> ⚠️ **宿主上的 `127.0.0.1:7897` 这类代理，在容器里指向的是容器自己。** 要么用
> 宿主的局域网 IP，要么用运行时提供的宿主别名（OrbStack 是 `host.orb.internal`、
> Docker Desktop 是 `host.docker.internal`），并确认代理**监听在所有接口**而不只是回环。
>
> 实测（2026-09-18，一台受限网络的 mac）：`ghcr.io` 与 `api.anthropic.com` 直连可达，
> 而 `registry-1.docker.io`、`github.com`、`api.openai.com` 全部超时 ——
> ⚠️ 也就是说**沙箱镜像拉得到、基础镜像却拉不到**，卡在 `docker compose build` 而不是向导里。

> ⚠️⚠️ **macOS 上必须先设 `DATA_ROOT`，否则起不来。**
> 默认值 `/srv/agent-platform/data` 在 macOS 上**建不出来** —— 不是"需要 sudo"，
> 而是 `/` 本身是**只读文件系统**（SIP 保护的系统卷），`/srv` 连目录都不存在。
> 实测（2026-09-18，macOS 26.5.2）：`mkdir -p /srv/...` → `Read-only file system`；
> `/opt`、`/usr/local`、`/private/var` 同样不可写。
>
> ⇒ 在**仓库根目录**建一份 `.env`，指向一个家目录下的绝对路径：
>
> ```bash
> mkdir -p ~/agent-platform/data
> echo "DATA_ROOT=$HOME/agent-platform/data" > .env    # ★ 必须绝对路径
> ```
>
> Linux 上不需要这一步（`/srv` 可建），但设了也无妨。
> ⚠️ 这个路径会被**原样**用作容器内路径（同名挂载，见 §8）—— 所以它必须是绝对路径，
> 而且换机迁移时两边要一起改。

```bash
docker compose up --build       # 在仓库根目录，不是 api/
```

首次启动要拉约 4 GB 的预制镜像 + 构建两个应用镜像，慢是正常的。

起来之后打开 **<http://127.0.0.1:3000>**。

> ⚠️ **只有前端发布端口，后端不对外暴露。** 浏览器所有请求（含 WebSocket）都经前端同源转发
> 给容器内的 `api`。这少一个暴露面，也让 WS 不必写死地址（见 §7）。

> ⛔ **不要 `cp api/.env.example api/.env`。** 那份模板是给**裸跑**形态写的，里面
> `DATA_ROOT=./data` 是相对路径；compose 会读它做插值，于是容器里的挂载点变成相对路径，
> 直接报 `invalid mount path: 'data' mount path must be absolute`。
> 要改配置请在**仓库根目录**建 `.env`，并且 `DATA_ROOT` 必须写**绝对路径**。

### 想带上版本号

```bash
APP_VERSION=$(git describe --tags --always) \
APP_COMMIT=$(git rev-parse HEAD) \
APP_BUILT_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ) \
docker compose up --build
```

不传就是 `null` —— 这是刻意的。⛔ 不给假默认值：一个写死的版本号会让每一个忘了传的构建
都报出同一个**看起来像真的、但永远是错的**版本（`GET /api/system/version`）。

## 4. 第一次进去要做什么

浏览器打开后是**初始化向导**（`initialized=false` 时阻塞式）：

| Step | 做什么 | 要动手吗 |
|---|---|---|
| 1 | 出网可达性检测 | 自动 |
| 2 | 代理配置（检测失败才展开） | 视情况 |
| 3 | 沙箱镜像就绪 —— 平台自己从 GHCR 搬 | 自动，慢 |
| 4 | **订阅配置** | **要** ⚠️ 见下 |
| 5 | 资源池确认 | 看一眼 |

> ⚠️⚠️ **Step 4 在 compose 形态下只能用 API Key，「帐号授权」那条必然失败。**
> 那条路要在平台进程里起 `codex login` / `claude setup-token` 子进程，而实现挂的是
> `HostAuthHelper`（宿主形态）—— 容器里既没有那两个 CLI，`setup-token` 起的本地监听
> 也在容器内、宿主浏览器够不着。容器形态的 auth helper 尚未落地
> （`docs/shared/11` §1.1 已标 ⏳）。

向导走完就能建项目、发起 Task 了。

## 5. 安全

**出厂只有一道防护：默认只监听 `127.0.0.1`。**

> ⚠️⚠️ **访问口令出厂是【关闭】的。** 只要你把服务暴露到回环之外（改 `HOST`、改端口绑定、
> 挂反向代理、开隧道），在你手动开启口令之前**任何人都能直接用**，而这个平台手里有你的
> 模型 API Key 和 Git 凭证。
>
> 开启方式：进去之后【设置 → 系统】里启用（会一次性给你 16 位明文，此后只存 hash）。
>
> ⛔ 在根目录 `.env` 里写 `ACCESS_PASSCODE=` **不等于**开启 —— 它只是把一个值透传给后端；
> 而且 compose 的 `.env` 只做**变量插值**，不会自动注入容器。
>
> 📌 产品文档 `21-8 §3` 写的是「默认启用状态」，与实现不符，**待裁决**（见该处标注）。

## 6. 隔离档位：不需要 KVM

平台有两档隔离 provider：

- **`aio`** —— 容器隔离，走 docker。**Linux 默认走这档，不需要 KVM。**
- **`boxlite`** —— 微虚拟机、独立内核，强隔离。Linux 需要 `/dev/kvm`。

> ⚠️ **compose 形态下恒为 `aio`**，包括 macOS 宿主 —— 档位是 api 进程判的，而它跑在
> **Linux 容器**里。文档里「macOS ⇒ boxlite」那些话描述的是**裸跑**形态。
> ⇒ 没开嵌套虚拟化的云主机可以正常部署。

> ⛔ **不要设 `SANDBOX_DEFAULT_IMAGE`。** 留空时平台按宿主档位自动在两张预制镜像里挑；
> 一旦填死，按档自动选**永久失效**，另一半宿主会直接撞 `IMAGE_PROVIDER_MISMATCH`。

## 7. 拓扑

```
浏览器 ──▶ 127.0.0.1:3000 ──▶ [web]  Next.js standalone
                                 │  /api/*      rewrites
                                 │  /socket.io  rewrites（WS 也走这里）
                                 ▼
                              [api]  NestJS（不发布端口）
                                 │  DOCKER_HOST=tcp://docker-proxy:2375
                                 ▼
                         [docker-proxy]  只放行 containers/exec/images
                                 ▼
                            宿主 docker ──▶ 沙箱容器（platform-sandbox-net）
```

WS 不写绝对地址、走同源，因为绝对地址是**构建期**常量而正确值取决于**运行时**访问者用的
host —— 写死 `ws://localhost:3000`，同事从局域网打开时它会去连**同事自己机器**的 3000。

## 8. 数据在哪

宿主 `DATA_ROOT`（默认 `/srv/agent-platform/data`；⚠️ **macOS 上必须改**，见 §3）
**原样挂到容器内同一个绝对路径**。

> ⚠️ 两边**必须同名**：平台要在其中按 0700/0777 建目录给沙箱内的非 root 用户用，路径两边
> 不一致时它写下的绝对路径对另一边无意义。

备份直接备这个目录（`platform.db` 也在里面）。

## 9. 更多

| | |
|---|---|
| 版本与变更 | [CHANGELOG.md](./CHANGELOG.md) |
| 设计文档索引（53 篇） | [docs/README.md](./docs/README.md) |
| 部署形态细节 | [docs/shared/11-部署与扩展预留.md](./docs/shared/11-部署与扩展预留.md) |
| 部署与初始化的产品规格 | [docs/product/pages/21-8-部署与初始化.md](./docs/product/pages/21-8-部署与初始化.md) |
| 跑起来才发现的那些事 | [docs/LIVE-RUN-FINDINGS.md](./docs/LIVE-RUN-FINDINGS.md) |

开发（裸跑、不用容器）看 `docs/shared/11` §1.3。
