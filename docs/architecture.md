# 架构

状态:草稿

## 分层

```
Desktop(Electron) ──L1──▶ Daemon ──L2(ACP)──▶ Agent 适配进程
   renderer ⇄ main   (SSH 隧道)   会话 / 事件日志     stdio 子进程
```

### L1:客户端到 daemon

- 基于 JSON-RPC 2.0,与传输分离。消息模型以 ACP v2 为蓝本,字段和语义保持一致。ACP 的类型来自固定版本的 SDK(只经 `@cycle/acp` 使用),Cycle 的扩展用 zod 定义在 `@cycle/protocol`(见 [决策 0005](decisions/0005-acp-v2.md))。daemon 转发 agent 的消息并补充 Cycle 自己的能力,Cycle 的扩展放在 `_cycle/*` 方法和 `_meta` 里,不重复定义 ACP 已有的概念。
- daemon 长驻,支持多个客户端观察同一个 session;客户端断线后 session 继续运行。
- **daemon 自己保存会话历史**(见 [决策 0002](decisions/0002-session-persistence.md)):JSONL,每个 session 一个文件,只追加,每条事件带单调递增的 `seq`。历史不依赖 agent 重放,因为云端 sandbox 销毁后 agent 侧的历史会丢。重连时按 `since=seq` 补发,或先取快照再接增量。
- 会话内容沿用 ACP v2 的 item 模型:消息、tool call 等按稳定 id 打补丁。
- daemon 只管理 Cycle 自己创建的 session(见 [决策 0006](decisions/0006-own-sessions.md))。
- 管理类方法(`_cycle/*`):session 列表和创建、归档与删除、agent 配置的读写、能力与版本协商。
- **MCP 是 daemon 的公共能力,不是某个 agent 的**(protocol.md §14):connector 的清单、凭证和 OAuth 都在 daemon,并且各自放在接口后面,以后可以换成 cloud 的实现;agent 只在 L2 的 `mcpServers` 里看到 daemon 网关的 loopback 地址,拿不到上游的 token。理由见决定笔记 [2026-11-19-connectors-behind-a-daemon-gateway](../.agents/notes/2026-11-19-connectors-behind-a-daemon-gateway.md)。

### L2:daemon 到 agent

- 以 **ACP v2** 为主要参考(见 [决策 0005](decisions/0005-acp-v2.md))。daemon 充当 ACP client。
- v2 的关键特性正好是我们需要的:`session/update` 可在会话任意时刻到达,消息、tool call 按稳定 id 打补丁,agent 可报告空闲,支持多个客户端观察同一个 session。
- v2 仍是草案(alpha),所以 ACP 的 schema 只在 `packages/acp` 一处定义,版本固定。ACP 变化的影响限制在这个包和适配层。
- **传输不绑定 stdio。** L2 抽象为一个双向消息通道:v1 实现 stdio 子进程,后续可加 WebSocket 等,用于云端 sandbox。
- v1 不使用 `fs/*`、`terminal/*` 等 client 能力。以后这些能力必须在 agent 所在的环境里执行,而不是在 daemon 的机器上。

### L3:agent 适配

- 不使用官方 `claude-agent-acp`,自己写 Claude 适配(见 [决策 0001](decisions/0001-claude-acp-adapter.md)),基于 Claude Agent SDK,对外说 ACP v2。
- 每个 agent = 一个 ACP 进程 + 一份 manifest。
- manifest:id、启动命令、环境变量、可配置项的 schema。
- 客户端按 schema 渲染配置界面,不需要认识具体 agent。
- 适配进程是**自包含**的:所有配置(模型、权限模式、MCP、环境变量、凭证)都通过协议或显式参数传入,不隐式读取宿主机的用户目录。适配进程运行在 workspace 所在的位置,本机、远程机器或云端 sandbox 都是同一种形态。

## 远程连接

- 用系统 `ssh`,复用 `~/.ssh/config`、密钥和 known_hosts。
- daemon 在远端长驻,只监听 unix socket 或 loopback。
- 候选方式:`ssh -L` 转发,或 `ssh host <cmd> proxy`(stdio 桥接到 socket)。倾向后者。
- 本地模式是同一个 daemon 加本地 socket,只有一条代码路径。

## 规划中的仓库结构

```
packages/protocol          Cycle 对 ACP 的扩展:_cycle/* 方法、_meta 键、错误码(zod)
packages/acp               ACP v2 类型和常量(固定 SDK 版本,唯一导入它的地方)
packages/daemon            会话管理、事件日志(JSONL)、ACP client 调度
packages/transport         unix socket、stdio 桥接、ssh 通道
packages/client            给客户端用的 CycleClient:重连、按 seq 补发、去重
apps/daemon                可运行的 daemon:serve 和 proxy
packages/adapters/claude   Claude 适配进程(基于 Claude Agent SDK)和 manifest
apps/desktop               Electron(main:ssh 与 daemon 连接;renderer:UI)
docs/
```

## v1 范围外

git worktree、终端、diff 视图、多 provider、Web 端。
