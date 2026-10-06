# BoxLite 在本机 Docker 中的兼容性验证

2026-10-06 已实测成功。当前方案是自建 Linux ARM64 镜像，在专属 Colima VZ VM 中开启嵌套虚拟化，向容器提供 KVM，并在容器中保留 BoxLite 微虚拟机。生产 API、现有 BoxLite home 和 Cloudflare Tunnel 尚未迁移。

[官方文档](https://github.com/boxlite-ai/boxlite/blob/main/docs/guides/deployment-patterns.md#docker-container-deployment)提供自建镜像的部署方式，基线为 `--privileged --device /dev/kvm`。`boxlite-agent-base` 等镜像供微虚拟机内部运行任务，不能当作包含当前业务 API 的完整 BoxLite 服务镜像。[客体镜像 Dockerfile](https://github.com/boxlite-ai/boxlite/blob/v0.9.7/images/agent-runtime/node.Dockerfile)

## 已验证

本机 M5 Pro、macOS 27.0.1、Colima 0.10.3、Lima 2.2.1；测试 profile 为 `agent-platform-boxlite-proof`，2 CPU、4 GiB RAM、30 GiB 磁盘，无 Mac 目录共享。Docker 命令使用该 profile 的显式 socket，没有更改全局 context。

- KVM API 返回 12，容器内实际创建 KVM VM 文件描述符。
- Node 22.23.3、BoxLite SDK 0.9.7 的 Linux ARM64 原生模块可载入。
- 两个真实 BoxLite 客体可执行命令、创建 PTY、读写共享目录、停止并重启。
- 外层内核为 `6.8.0-117-generic`，客体独立内核为 `6.12.76`。
- 替换 Docker 容器并复用全新测试卷后，原 VM ID 与磁盘标记保留；两个客体能同时运行。
- 各运行中的 shim 与 API 测试进程的 PID、挂载和用户命名空间实际不同。这不是两个 shim 之间全部隔离属性的完整审计。
- 最后恢复并删除本次成功测试的两个客体；数据卷与失败记录保留用于追溯。

实际退出码、容器 ID、挂载、镜像、每阶段报告和未通过的尝试见[验证记录](../../../artifacts/boxlite-docker-compatibility-verification.json)。

## 镜像中的兼容处理

[Dockerfile](../Dockerfile.boxlite-proof)固定 Node 和 Rocky Linux 基础镜像 digest，使用 npm 锁文件固定 SDK 0.9.7，下载并验证官方同版本 ARM64 companion runtime。构建阶段拒绝其他架构。

现有 0.9.7 静态 ARM64 shim 使用 glibc 2.28，因此最终运行环境采用匹配版本。官方固件原始 SHA 为 `f3011274…`，增加 ARM64 静态加载所需的 `DT_NEEDED libc.so.6` 后 SHA 为 `8b7e1bff…`，两者均在构建时完整校验。运行资产通过官方支持的 `BOXLITE_RUNTIME_DIR` 指定，防止每次启动复制回旧固件。CA 证书目录物化，避免 bubblewrap 挂载期间引用尚未挂入的符号链接目标。[ARM64 加载依赖说明](https://github.com/boxlite-ai/boxlite/issues/1144) · [运行目录选择](https://github.com/boxlite-ai/boxlite/blob/v0.9.7/src/boxlite/src/util/binary_finder.rs)

这是含固件修正的自定义镜像。直接在普通 Node/Debian 镜像安装未经处理的 SDK，本次实际未能启动客体。官方 companion runtime 的 shim 与 npm 内嵌 shim 字节不同；两条路线都已分别实测，最终 Dockerfile 使用官方 companion runtime。构建步骤可重复，但 apt/dnf 系统包及测试客体 `alpine:3.22.2` 尚未锁到不可变包版本/digest，不能承诺未来构建字节相同。

## 在独立环境重复测试

在仓库根目录执行。该命令组只操作专属测试 VM 和新建的测试卷；不要把生产数据库、工作区、BoxLite home 或 Docker socket 挂进去。

```sh
proof_cli='/Users/douglasdong/.orbstack/bin/docker'
proof_config='/Users/douglasdong/.local/share/agent-platform-jenkins-tools/container-docker-context'
proof_socket='unix:///Users/douglasdong/.colima/agent-platform-boxlite-proof/docker.sock'

PATH='/Users/douglasdong/.orbstack/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin' DOCKER_CONFIG="$proof_config" colima start agent-platform-boxlite-proof --vm-type vz --arch aarch64 --cpu 2 --memory 4 --disk 30 --nested-virtualization=true --mount none --activate=false --ssh-config=false --save-config=false

proof_docker() { "$proof_cli" --config "$proof_config" --host "$proof_socket" "$@"; }
proof_docker build --platform linux/arm64 --file deploy/containers/Dockerfile.boxlite-proof --tag agent-platform-boxlite-proof:local deploy/containers
proof_volume="agent-platform-boxlite-proof-manual-$(date +%s)"
proof_docker volume create "$proof_volume"

proof_docker run --rm --privileged --device /dev/kvm:/dev/kvm --memory 1536m --cpus 2 --pids-limit 512 --ulimit core=0:0 --mount "type=volume,source=$proof_volume,target=/data" agent-platform-boxlite-proof:local create
proof_docker run --rm --privileged --device /dev/kvm:/dev/kvm --memory 1536m --cpus 2 --pids-limit 512 --ulimit core=0:0 --mount "type=volume,source=$proof_volume,target=/data" agent-platform-boxlite-proof:local resume
proof_docker run --rm --privileged --device /dev/kvm:/dev/kvm --memory 1536m --cpus 2 --pids-limit 512 --ulimit core=0:0 --mount "type=volume,source=$proof_volume,target=/data" agent-platform-boxlite-proof:local cleanup
colima stop agent-platform-boxlite-proof
```

阶段失败时保留其数据卷和日志进行诊断，不能把失败当作完成。此处 `--rm` 会删除退出容器；实际本轮验收保留了容器并导出报告。需要完整日志追溯时应同样使用具名容器、导出日志后再删除。

## 后续生产迁移边界

候选路径为 `Mac → 专属 Linux VM（嵌套虚拟化）→ Docker（API + BoxLite）→ 任务微虚拟机`。API 与 BoxLite 可一起放入容器，由 Docker 管理进程、重启和日志；Mac 仍需开机启动 Docker 所依赖的 Linux VM。

目前通过的是 `--privileged` 基线。只添加 `SYS_ADMIN`、开放 seccomp/AppArmor 的尝试仍在 bubblewrap 挂载 proc 时失败；最小权限组合尚未验证。正式运行应保持 runtime 与 Jenkins controller、PR 构建 daemon 分开，也不能据此宣称联网 VMM 的内部 seccomp 全部启用。[联网 seccomp 分支](https://github.com/boxlite-ai/boxlite/blob/v0.9.7/src/shim/src/main.rs#L151-L175)

下一步仍需适配 Linux 上默认选择 AIO 的 provider、容器资源容量探测、完整业务 API 和真实任务验收；另行验证 Darwin 生产 SQLite、主密钥、工作区、成果和 BoxLite 持久数据的迁移。当前恢复测试只证明 Linux 容器之间恢复已停止的测试客体，不证明 Darwin→Linux 数据可直接搬运，也不承诺正在运行的任务跨容器更新零中断。Jenkins 正式 CI、Release 上传、分支保护迁移与冷启动验收仍未完成。此前四项原生 Mac agent 的安装命令已在[本机命令文档](../../../artifacts/jenkins-setup-commands.md)标为暂缓执行。
