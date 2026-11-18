# 0001 Claude 的 ACP 适配

状态:已接受(取代此前"复用官方适配"的倾向)

## 决定

自己写 Claude 适配进程,基于 Claude Agent SDK,对外说 ACP v2。不使用官方 `claude-agent-acp`。

## 原因

官方适配锁定了一些行为,会妨碍后续的云端 sandbox。适配进程需要:

- 自包含:配置和凭证由外部显式传入,不依赖宿主机的用户目录和隐式环境。
- 运行位置可选:本机、远程机器、云端 sandbox 是同一种形态。
- 传输可替换:不只是 stdio。

## 代价与应对

- 要自己维护 ACP v2 到 Claude Agent SDK 的映射。应对:映射代码集中在 `packages/adapters/claude`,有测试;可以参考官方适配的行为,但不依赖它。

## old-cycle 的教训

old-cycle 做过同样的事:`claude-direct`,基于 Agent SDK 自写 ACP v2 适配,约 1500 行源码、1600 行测试,目的也是云端 sandbox。它在 2026-11-11 被删除,原因是:

- 每个官方适配已有的功能都要重做一遍(compaction、usage、标题、thinking、子 agent 输出、图片、斜杠命令、大部分内置工具、MCP、定时任务等)。
- 它把边界放在 CLI 的启动处,而 daemon 和 harness 仍在笔记本上,所以解决不了"笔记本关机后继续工作"。

我们的做法不同:适配进程本身可以运行在 sandbox 里,和 daemon 之间走可替换的传输。但"功能对齐"的工作量是真实的,所以:

- v1 只对齐核心:流式消息、tool call、权限审批、取消、恢复、模型和权限模式配置。其他功能显式列为"未做",不在 v1 范围里悄悄补。
- 老项目保留了 `archive/claude-direct` 分支,其中"每个 Query 的执行所有者"和进程组清理值得参考。

## 待细化

- 适配进程的启动参数、配置传入方式和凭证注入方式。
- 云端 sandbox 下适配进程与 daemon 的连接方向(daemon 主动连,还是适配进程回连)。
