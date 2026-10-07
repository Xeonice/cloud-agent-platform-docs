# BoxLite Docker 验证工具

生产 API 与 BoxLite 已在专属 Linux ARM64 Docker 环境运行，BoxLite SDK 保持 `0.9.7`，任务继续使用微虚拟机隔离。这个目录提供独立、可重跑的兼容性 smoke；业务 API 镜像使用 [Dockerfile.api](../Dockerfile.api)，当前运行结构见 [部署指南](../../../docs/macmini-deployment.md)。

[官方 Docker 文档](https://github.com/boxlite-ai/boxlite/blob/main/docs/guides/deployment-patterns.md#docker-container-deployment)提供自建镜像方式，基线为 `--privileged --device /dev/kvm`。`boxlite-agent-base` 等镜像供客体内部运行任务，不能作为包含业务 API 的服务镜像。[客体镜像 Dockerfile](https://github.com/boxlite-ai/boxlite/blob/v0.9.7/images/agent-runtime/node.Dockerfile)。

## 工具验证范围

[boxlite-smoke.mjs](../boxlite-smoke.mjs) 只接受 Node 22、Linux ARM64、SDK 0.9.7 和固定的 `/data/boxlite`。三个阶段使用同一个新测试卷：

- `create`：实际 KVM ioctl、两个真实客体、独立 guest kernel、命令执行、PTY、共享文件和停止恢复。
- `resume`：替换 Docker 容器后，使用原 VM ID 和持久磁盘，再次启动并核对标记；也检查 shim 与测试进程的 PID、挂载和用户 namespace。
- `cleanup`：只删除该测试卷记录的两个客体，验证 runtime 不再有实例。

这三个阶段已实际通过。每阶段会在 `/data/proof` 保存 JSON，执行失败会返回非零。完整业务链的隔离验证入口为 [api-smoke.mjs](../api-smoke.mjs)，覆盖平台任务、终端 WebSocket、容器配额与清理。独立 smoke 不能替代正式 Jenkins SUCCESS。

## 镜像中的兼容处理

[Dockerfile.boxlite-proof](../Dockerfile.boxlite-proof) 固定 Node 和 Rocky Linux 基础镜像 digest，npm 锁文件固定 SDK 0.9.7，下载并验证官方同版本 ARM64 companion runtime；构建拒绝其他架构。

该版本的静态 ARM64 shim 使用 glibc 2.28，运行环境采用匹配版本。官方固件原始 SHA 为 `f3011274…`，增加加载所需的 `DT_NEEDED libc.so.6` 后 SHA 为 `8b7e1bff…`；完整校验和与修补过程位于 [prepare-runtime.py](prepare-runtime.py)。运行资产通过官方支持的 `BOXLITE_RUNTIME_DIR` 指定，防止 SDK 重新覆盖；CA 证书目录经 [materialize-certs.py](materialize-certs.py) 处理，避免 bubblewrap 挂载引用未挂入的符号链接目标。[ARM64 加载依赖](https://github.com/boxlite-ai/boxlite/issues/1144)、[运行目录选择](https://github.com/boxlite-ai/boxlite/blob/v0.9.7/src/boxlite/src/util/binary_finder.rs)。

这是含固件修正的自定义镜像。未经处理的 Node/Debian SDK 安装未通过本次客体启动验证。系统包与测试客体 `alpine:3.22.2` 尚未锁定不可变包版本或 digest，因此不承诺将来重建得到相同字节。

## 在独立环境重复测试

以下命令只创建新的测试 profile、私有 Docker config 和测试数据卷。需要支持 nested virtualization 的 Apple Silicon、Colima VZ 和可用 KVM；不要复用生产 profile、卷、数据库、凭据或工作区，也不要向容器挂载 Mac 目录或 Docker socket。

```sh
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
colima stop "$proof_profile"
exit "$proof_result"
```

测试卷和 profile 保留用于读取报告；成功后按本次明确名称清理，不使用 `prune`。阶段失败时保留数据与日志，不继续执行后续阶段。需要完整 stdout/stderr 时使用具名容器，在删除前导出日志。

## 仍需单独验证的边界

实际通过的权限基线是 `privileged` 加 KVM。只添加 `SYS_ADMIN` 并放开 seccomp/AppArmor 的尝试仍被 proc mount 拒绝；最小权限策略未验证。生产将 runtime、Jenkins controller 与 PR 构建 daemon 分开，保持无 Mac mount。namespace 检查不是全部隔离属性或联网 VMM seccomp 的完整审计。[联网 seccomp 分支](https://github.com/boxlite-ai/boxlite/blob/v0.9.7/src/shim/src/main.rs#L151-L175)。

Linux 容器之间的停止恢复不代表可以直接复制 Darwin BoxLite home，也不承诺运行中任务跨容器更新零中断。日常部署先等待任务结束并备份，再替换 API。三个 Colima profile 的自动重启与 Docker 数据恢复已实际验证；整台 Mac 断电冷启动尚未执行。
