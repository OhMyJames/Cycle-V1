# cycle-v1

一个 ADE(agentic development environment)。cycle 的重写版:协议先行,更小、更容易维护和改造。

> 状态:设计阶段。目前只有文档,还没有代码。

## 目标(v1)

先把协议定下来,并以 Claude agent 作为最小接入单元,跑通三项核心能力:

1. 连接远程 daemon(通过 SSH 隧道)
2. 完整展示 session 的会话,并支持交互
3. 配置 Claude agent

## 技术栈

Bun、TypeScript、Electron,均使用最新版本。

## 架构概览

```
Desktop(Electron) ──L1: Cycle 协议──▶ Daemon ──L2: ACP──▶ Agent 适配进程(Claude)
```

- **L1** 客户端到 daemon:以 ACP v2 为蓝本加 `_cycle/*` 扩展,类型自己定义并固定,要稳定。
- **L2** daemon 到 agent:以 ACP v2(Agent Client Protocol)为标准。L1 的消息模型也以它为蓝本,类型由我们固定版本。
- **L3** agent 适配:每个 agent 自带适配进程和 manifest;Claude 的适配自己写,基于 Claude Agent SDK。

详见 [docs/architecture.md](docs/architecture.md)。

## 开发

```bash
bun install      # 安装依赖,并启用 pre-commit 钩子
bun run check    # 边界、类型、lint、测试
```

目前是骨架:`packages/acp`、`packages/protocol` 有内容和测试,`daemon`、Claude 适配和 `desktop` 还是空壳。

## v1 不做

git worktree、终端、diff 视图、多 provider、Web 端。

## 文档

- [docs/architecture.md](docs/architecture.md):架构与分层
- [docs/protocol.md](docs/protocol.md):协议规范(草稿)
- [docs/decisions/](docs/decisions/):设计决策记录
