# BoxLite Docker 验证工具

生产 API 与 BoxLite 已在专属 Linux ARM64 Docker 环境运行，BoxLite SDK 保持 `0.9.7`，任务继续使用微虚拟机隔离。这个目录提供独立、可重跑的兼容性 smoke 与 API 隔离回归的步骤；业务 API 镜像使用 [Dockerfile.api](../Dockerfile.api)，当前运行结构见 [生产架构](../../../docs/ops/生产架构.md)。

[官方 Docker 文档](https://github.com/boxlite-ai/boxlite/blob/main/docs/guides/deployment-patterns.md#docker-container-deployment)提供自建镜像方式，基线为 `--privileged --device /dev/kvm`。`boxlite-agent-base` 等镜像供客体内部运行任务，不能作为包含业务 API 的服务镜像。[客体镜像 Dockerfile](https://github.com/boxlite-ai/boxlite/blob/v0.9.7/images/agent-runtime/node.Dockerfile)。

## 工具验证范围

[boxlite-smoke.mjs](../boxlite-smoke.mjs) 只接受 Node 22、Linux ARM64、SDK 0.9.7 和固定的 `/data/boxlite`。三个阶段使用同一个新测试卷：

- `create`：实际 KVM ioctl、两个真实客体、独立 guest kernel、命令执行、PTY、共享文件和停止恢复。
- `resume`：替换 Docker 容器后，使用原 VM ID 和持久磁盘，再次启动并核对标记；也检查 shim 与测试进程的 PID、挂载和用户 namespace。
- `cleanup`：只删除该测试卷记录的两个客体，验证 runtime 不再有实例。

这三个阶段已实际通过。每阶段会在 `/data/proof` 保存 JSON，执行失败会返回非零。完整业务链的隔离验证入口为 [api-smoke.mjs](../api-smoke.mjs)，覆盖平台任务、终端 WebSocket、容器配额与清理，步骤见下文「API 隔离回归」。独立 smoke 不能替代正式 Jenkins SUCCESS。

api-smoke 默认只跑这条业务链，其余检查用环境变量开启：

- `API_SMOKE_STAGES` 取 `listeners`、`helper`、`cgroup` 的任意组合，写错名称直接失败。`listeners` 要求没有属于 BoxLite VM 的通配监听，且 BoxLite 日志里 helper 与任务都没有发布端口；`helper` 要求诊断 auth-helper 为 ok，恰好一个规范名 helper，它的 bwrap 根下是唯一的 VM 和全部 BoxLite 进程（发版探针的判据），不在 sandboxes 与资源登记里，容量说明写明 1 核 / 512 MB 的常驻预留，清理后只剩它的 box 目录与进程树；`cgroup` 要求 API 与 `docker exec` 都在委派后的 `/api`，helper 与任务的 box cgroup 有 `pids.max=1024`，日志里没有 `Cgroup setup failed`。
- `API_SMOKE_HELPER_CHAOS=1` 杀掉 helper VM，要求按发版探针的判据它立即不再算作 helper，此刻的诊断只记录不判定：BoxLite 0.9.7 不开 health check 时，box 在下一次 exec 或 metrics 接管失败前仍记 running，诊断可能仍报 ok。随后用一次立即取消的 claude-code setup-token 登录触发自愈，核对出现新 id 的规范 helper、旧 box 的目录与进程都已消失、诊断回到 ok、登录会话已回收。`API_SMOKE_HELPER_CHAOS_LOGIN=0` 跳过这次登录；平台没有后台自愈，此时清理后不应留下任何 BoxLite 进程。chaos 只在 PID 1 的环境含 `API_SMOKE_ISOLATED=1` 与 `PORT=3191`、且 `127.0.0.1:3191` 由 PID 1 监听时执行，所以这两个变量要在 `docker run` 时交给容器，`docker exec -e` 不算。

## 镜像中的兼容处理

[Dockerfile.boxlite-proof](../Dockerfile.boxlite-proof) 固定 Node 和 Rocky Linux 基础镜像 digest，npm 锁文件固定 SDK 0.9.7，下载并验证官方同版本 ARM64 companion runtime；构建拒绝其他架构。

该版本的静态 ARM64 shim 使用 glibc 2.28，运行环境采用匹配版本。官方固件原始 SHA 为 `f3011274…`，增加加载所需的 `DT_NEEDED libc.so.6` 后 SHA 为 `8b7e1bff…`；完整校验和与修补过程位于 [prepare-runtime.py](prepare-runtime.py)。运行资产通过官方支持的 `BOXLITE_RUNTIME_DIR` 指定，防止 SDK 重新覆盖；CA 证书目录经 [materialize-certs.py](materialize-certs.py) 处理，避免 bubblewrap 挂载引用未挂入的符号链接目标。[ARM64 加载依赖](https://github.com/boxlite-ai/boxlite/issues/1144)、[运行目录选择](https://github.com/boxlite-ai/boxlite/blob/v0.9.7/src/boxlite/src/util/binary_finder.rs)。

这是含固件修正的自定义镜像。未经处理的 Node/Debian SDK 安装未通过本次客体启动验证。系统包与测试客体 `alpine:3.22.2` 尚未锁定不可变包版本或 digest，因此不承诺将来重建得到相同字节。

## 在独立环境重复 BoxLite smoke

以下命令只创建新的测试 profile、私有 Docker config 和测试数据卷。需要支持 nested virtualization 的 Apple Silicon、Colima VZ 和可用 KVM；不要复用生产 profile、卷、数据库、凭据或工作区，也不要向容器挂载 Mac 目录或 Docker socket。

```sh
# Mac，主仓根目录
proof_profile="agent-platform-boxlite-proof-$(date +%s)"
test ! -e "$HOME/.colima/$proof_profile" || exit 1
proof_cli="$(command -v docker)"
proof_config="$(mktemp -d)"
chmod 700 "$proof_config"
proof_socket="unix://$HOME/.colima/$proof_profile/docker.sock"
proof_image="$proof_profile:local"
proof_volume="$proof_profile-data"

DOCKER_CONFIG="$proof_config" colima start "$proof_profile" --vm-type vz --arch aarch64 --cpu 2 --memory 4 --disk 30 --nested-virtualization=true --mount none --activate=false --ssh-agent=false --ssh-config=false
proof_docker() { "$proof_cli" --config "$proof_config" --host "$proof_socket" "$@"; }
proof_docker build --platform linux/arm64 --file deploy/containers/Dockerfile.boxlite-proof --tag "$proof_image" deploy/containers
proof_docker volume create "$proof_volume"

proof_docker run --rm --privileged --device /dev/kvm:/dev/kvm --memory 1536m --cpus 2 --pids-limit 512 --ulimit core=0:0 --mount "type=volume,source=$proof_volume,target=/data" "$proof_image" create &&
proof_docker run --rm --privileged --device /dev/kvm:/dev/kvm --memory 1536m --cpus 2 --pids-limit 512 --ulimit core=0:0 --mount "type=volume,source=$proof_volume,target=/data" "$proof_image" resume &&
proof_docker run --rm --privileged --device /dev/kvm:/dev/kvm --memory 1536m --cpus 2 --pids-limit 512 --ulimit core=0:0 --mount "type=volume,source=$proof_volume,target=/data" "$proof_image" cleanup
proof_result=$?
DOCKER_CONFIG="$proof_config" colima stop "$proof_profile"
exit "$proof_result"
```

测试卷和 profile 保留用于读取报告；成功后按本次明确名称清理，不使用 `prune`。阶段失败时保留数据与日志，不继续执行后续阶段。需要完整 stdout/stderr 时使用具名容器，在删除前导出日志。所有 `colima` 命令都带临时 `DOCKER_CONFIG`，避免在默认 `~/.docker` 里留下 context。

## API 隔离回归

**适用场景**：改了 API 镜像输入（`Dockerfile.api`、`api-entrypoint.mjs`、`api-cgroup.mjs` 等）、BoxLite 或 auth helper 相关代码，上线前要用候选镜像核对隔离、helper 与 cgroup。何时必须跑见 [发版手册](../../../docs/ops/发版手册.md)。

**影响**：不碰生产的三台 VM、卷和凭据。临时 VM 占 4 核 / 7 GiB 内存，宿主内存紧张时不要跑；全程按第 4 步监控生产。

**前置条件**：

- 在 Mac mini 上、主仓根目录执行，`$NODE22` 指向 Node 22（取值见 [参考表](../../../docs/ops/参考表.md)）。
- 开始前 `sysctl -n kern.memorystatus_vm_pressure_level` 应为 `1`。宿主已处于内存告警（见[运维记录](../../../docs/ops/运维记录.md) T31）时，先按[运维手册](../../../docs/ops/运维手册.md)的内存一节降压，再开始。
- 候选改动已提交到本地分支：主仓与 `api` 子模块都要提交，不必推送。构建上下文只取已跟踪文件，并要求工作树干净（`api-context.mjs`）。
- buildx 插件由 OrbStack 提供，临时 Docker 配置里只写插件目录，不放任何凭据。
- api-smoke 只接受 Linux ARM64、Node 22，以及 `PORT=3191`、`HOST=127.0.0.1`、`DATA_ROOT=/data`、`DATABASE_URL=/data/platform.db`、`BOXLITE_HOME=/data/boxlite`、`SANDBOX_DEFAULT_PROVIDER=boxlite`、`SCHEDULER_CPU_OVERCOMMIT=1`、`API_SMOKE_ISOLATED=1`、至少 16 位的 `ACCESS_PASSCODE`；不满足时报 `ISOLATED_CONTAINER_REQUIRED`。除端口、隔离标记和口令外，其余都由 `Dockerfile.api` 的 `ENV` 给出。

**步骤**：

1. 建临时 profile、私有 Docker 配置与测试卷，并备份 Colima 的 ssh 配置：

   ```sh
   # Mac，主仓根目录
   proof_profile="agent-platform-regress-$(date +%s)"
   test ! -e "$HOME/.colima/$proof_profile" || exit 1
   proof_cli="$(command -v docker)"
   proof_config="$(realpath "$(mktemp -d)")" && chmod 700 "$proof_config"
   printf '{"cliPluginsExtraDirs":["/Applications/OrbStack.app/Contents/MacOS/xbin"]}\n' > "$proof_config/config.json"
   cp "$HOME/.colima/ssh_config" "$proof_config/ssh_config.before"
   proof_socket="unix://$HOME/.colima/$proof_profile/docker.sock"
   proof_image="agent-platform-api:regress-cand"
   proof_volume="$proof_profile-data"
   proof_api="$proof_profile-api"
   DOCKER_CONFIG="$proof_config" colima start "$proof_profile" --vm-type vz --arch aarch64 --cpu 4 --memory 7 --disk 40 --nested-virtualization=true --mount none --activate=false --ssh-agent=false --ssh-config=false
   proof_docker() { "$proof_cli" --config "$proof_config" --host "$proof_socket" "$@"; }
   proof_docker volume create "$proof_volume"
   ```

2. 在临时干净克隆里准备构建上下文，构建候选镜像：

   ```sh
   # Mac，主仓根目录；临时目录要用物理路径（realpath），api-context.mjs 拒绝经符号链接的路径
   work="$(realpath "$(mktemp -d)")" && chmod 700 "$work"
   git clone --quiet --no-local . "$work/root"
   git -C "$work/root" checkout --quiet --detach "$(git rev-parse HEAD)"
   git clone --quiet --no-local api "$work/api"
   git -C "$work/api" checkout --quiet --detach "$(git -C api rev-parse HEAD)"
   ctx="$("$NODE22" "$work/root/deploy/containers/api-context.mjs" "$work/api" "$work/root" |
     "$NODE22" -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0, "utf8")).context)')"
   proof_docker build --platform linux/arm64 -f "$ctx/Dockerfile.api" -t "$proof_image" "$ctx"
   ```

3. 起隔离容器，等它 healthy 后放入 smoke 脚本并运行：

   ```sh
   # Mac，主仓根目录；参数对齐生产的 runtimeArguments，资源缩小，不加生产的 --dns 127.0.0.2
   (umask 077; printf 'PORT=3191\nAPI_SMOKE_ISOLATED=1\nACCESS_PASSCODE=%s\n' "$(openssl rand -hex 16)" > "$proof_config/smoke.env")
   proof_docker run -d --name "$proof_api" --network host --privileged --device /dev/kvm --cpus 4 --memory 6g --pids-limit 8192 --stop-timeout 90 --env-file "$proof_config/smoke.env" --mount "type=volume,source=$proof_volume,target=/data" "$proof_image"
   for i in $(seq 60); do [ "$(proof_docker inspect -f '{{.State.Health.Status}}' "$proof_api")" = healthy ] && break; sleep 5; done
   proof_docker inspect -f '{{.State.Health.Status}}' "$proof_api"   # 期望 healthy；不是就先看 proof_docker logs
   proof_docker cp "$work/root/deploy/containers/api-smoke.mjs" "$proof_api":/tmp/api-smoke.mjs
   proof_docker exec "$proof_api" node /tmp/api-smoke.mjs
   proof_docker exec -e API_SMOKE_STAGES=listeners,helper,cgroup -e API_SMOKE_HELPER_CHAOS=1 "$proof_api" node /tmp/api-smoke.mjs
   proof_docker exec "$proof_api" cat /data/proof/api-smoke.json
   ```

4. 回归期间另开一个终端监控生产，任何一行不是 `200` 或内存压力到 `2` 及以上，就停下回归、按第 6 步清理：

   ```sh
   # Mac，任意目录
   while sleep 15; do printf '%s %s %s\n' "$(date +%T)" "$(curl -s -o /dev/null -w '%{http_code}' https://agent-api.douglasdong.com/api/health)" "$(sysctl -n kern.memorystatus_vm_pressure_level)"; done
   ```

5. **验证**：每次 smoke 退出码为 0，`/data/proof/api-smoke.json` 的 `state` 为 `passed`，`cleanup` 各项都为 `true`。失败时先导出日志再判断：`proof_docker logs "$proof_api" > "$work/api.log"`。

6. **清理**（只按本次的明确名称，不用 `prune`）：

   ```sh
   # Mac，主仓根目录
   proof_docker rm -f "$proof_api"
   proof_docker volume rm "$proof_volume"
   DOCKER_CONFIG="$proof_config" colima stop "$proof_profile"
   DOCKER_CONFIG="$proof_config" colima delete --data --force "$proof_profile"
   colima list                                           # 只应剩三台生产 profile
   grep -c "$proof_profile" "$HOME/.colima/ssh_config"   # 期望 0
   ```

   `~/.colima/ssh_config` 里若残留临时 profile 的条目，用 `cp "$proof_config/ssh_config.before" "$HOME/.colima/ssh_config"` 恢复；只有回归期间三台生产 VM 没有重启过才可以这么做。确认无误后删除临时目录：`rm -rf "${work:?}" "${ctx:?}" "${proof_config:?}"`。

**回退**：回归只影响临时 VM，任何一步失败都可以直接按第 6 步清理后重来。生产出现异常时先清理临时 VM 释放内存，再按 [运维手册](../../../docs/ops/运维手册.md) 排查。

## 仍需单独验证的边界

实际通过的权限基线是 `privileged` 加 KVM。只添加 `SYS_ADMIN` 并放开 seccomp/AppArmor 的尝试仍被 proc mount 拒绝；最小权限策略未验证。生产将 runtime、Jenkins controller 与 PR 构建 daemon 分开，保持无 Mac mount。namespace 检查不是全部隔离属性或联网 VMM seccomp 的完整审计。[联网 seccomp 分支](https://github.com/boxlite-ai/boxlite/blob/v0.9.7/src/shim/src/main.rs#L151-L175)。

BoxLite 0.9.7 在生产实际生效的隔离（KVM 加 bwrap 命名空间、shim 身份、seccomp、cgroup 委派、端口映射）与 Lima 端口规则，见 [生产架构](../../../docs/ops/生产架构.md)。

Linux 容器之间的停止恢复不代表可以直接复制 Darwin BoxLite home，也不承诺运行中任务跨容器更新零中断。日常部署先等待任务结束并备份，再替换 API。自动启动与冷启动演练的状态见 [运维记录](../../../docs/ops/运维记录.md)。
