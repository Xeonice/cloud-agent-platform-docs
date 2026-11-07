# 三 PR 的独立 CI 请求

此入口只验证操作者冻结的三个仓库提交，不启用 Jenkins 全局 discovery／release，不修改作业、节点、worker 或 VM。没有 `--root-go` 时，两个 CLI 均返回 `held`，不读文件、凭据或网络。

## 冻结输入

完成 CI 改动提交后，Root 将下列 JSON 中的 SHA 换成最终精确提交。三个 PR 必须仍为本仓库向 main 发起的开放 PR，实际 head 必须匹配；Draft 可以运行。输入文件须为当前执行账号所有的 0600 普通文件，不能是符号链接或硬链接。

```json
{
  "schemaVersion": 1,
  "requestId": "required-ci-20261105-r1",
  "commits": {
    "project": "<最终 Root 40 位 SHA>",
    "api": "89fa7fdb6846111e9d941e57ffb5a5167fe83574",
    "web": "1d2d7df13a19aee361ee97e4046ac89b47e32a3c"
  },
  "pullRequests": { "project": 69, "api": 51, "web": 47 }
}
```

Root 将相同请求文件放到 Mac 私有目录和现有本地 `agent-platform-linux-deploy` 的 `/run/agent-platform/jenkins-tools/`。仅将本轮审阅的 CI 模块安装到该容器已有公开工具目录；不运行 `refresh`／`activate`，不复制凭据或重建容器。该工具需要 Node 22、原部署账号与原卷的所有权检查。先只读确认实际安装的 API／Web／contract pipeline 和 executor 可用。本轮已安装的 Web 报告阶段使用原有在线的 `agent-platform-linux-deploy`；仓库新模板写的 publisher 不构成本轮修改 job／node 的理由。

## 启动独立守护，再推进请求

先在 Mac 保持独立监控进程运行；下面是命令格式，路径由 Root 冻结：

```sh
node deploy/jenkins/scoped-ci-monitor.mjs --root-go MAC_REQUEST.json /run/agent-platform/jenkins-tools/SCOPED_REQUEST.json NEW_OUTPUT_DIRECTORY
```

它不会启动任何构建。`ready.json` 写出后，Root 核对其中 scopeKey、监控进程存活与实际容量，再在本地部署容器执行：

```sh
/usr/local/bin/node /opt/agent-platform/tools/scoped-ci-request.mjs --root-go /run/agent-platform/jenkins-tools/SCOPED_REQUEST.json advance --expect-scope SCOPE_KEY
```

运行中使用相同命令的 `reconcile` 只观察实际队列／构建并回传本请求 outbox，不启动下一阶段。需要继续时显式调用 `advance`：先 API，API 实际成功后 Web；Web 包含真实三仓 contract 子任务。最终一次 advance 校验 Web 的真实报告、子任务 number／URL／完整三 SHA 参数及实际 Jenkins SUCCESS，复用该子任务报告 Root 必需检查，不再排一次 contract。每次 advance 最多推进一个阶段，没有自动重试循环。

状态由原 GitHub App 回传 `jenkins/native-ci`／`jenkins/web-ci`／`jenkins/project-ci`。OAuth fallback 不用于本入口。原有其他 pending／outbox 不处理；没有分支、tag、其他 PR 或 release 的枚举与派发。Root 最后仍读取 GitHub 上三个精确 head 的必需检查结果，再进行 PR ready／合并操作。

## 派发与容量边界

- 新 POST 之前持久保存 scope／完整参数／原已知 queue IDs 的 intent。响应未知时，只查找唯一新增的实际 queue ID，不再次 POST；没有唯一证据则保持 HOLD。复用历史 SUCCESS 不取得停止权限；其他人的运行中队列不接管。
- Mac 守护持有独占构建锁，入场要求 Jenkins 无在途构建／队列、controller 无 executor，且全局 discovery／release 仍 disabled。既有只读 service-monitor 不构成构建占用。
- 开始时 Mac 和 build VM 数据文件系统均须至少 8 GiB 可用。随后每秒采样，数据超过 2 秒即拒绝；Mac／VM 可用量始终检查 4 GiB 下限。增长取 build VM 两个实际磁盘文件的 allocated blocks 增量、Mac 可用量下降、VM 可用量下降三者的最大值，上限 3 GiB。锁定磁盘原 inode，不用镜像标称体积代替实际占用，也不回收缓存掩盖增长。
- 越界、观测失败或 SIGTERM／SIGINT 时，先持久写本 scope 的 abort 哨兵，阻止之后的 dispatch；独立 Mac 路径立即核对原 request／queue ID／build number／实际参数，停止自己的队列或构建。Web 子任务还须匹配精确 upstream Web build。正常 HTTPS Jenkins URL 会归一后比较。不会停止 worker／VM，不清理无关数据。
- 停止请求每个精确 endpoint 只发一次；响应丢失不会变成重复停止。继续采样并观察实际 terminal。120 秒仍无法证明停止完成则结果明确为 `held-owned-stop-not-terminal`，Root 必须按保留的原身份调查；不能称已清理或继续派发。守护总窗口最多三小时。

守护使用 Mac 原有 `admin-api.json` 和 listener 归属检查；凭据只用于既有本机 Jenkins，值不写日志。Linux 工具继续使用原部署私有卷中的 App 配置。所有监控输出在新独占目录保留；`ci-passed-and-capacity-observed` 要求三个真实结果成功且该 scope 的 outbox 已清空。采样属于观察与停止保护，不是磁盘硬配额；不据此声称两次采样之间绝无瞬时波动。
