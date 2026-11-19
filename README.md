# cycle-v1

一个 ADE(agentic development environment)。cycle 的重写版:协议先行,更小、更容易维护和改造。

> 状态:v1 可用。桌面应用(macOS,Apple 芯片)加 Linux daemon,Claude 为唯一的 agent。应用会自动更新自己;签名公证、远端 daemon 的升级、图标还没做。使用见 [docs/getting-started.md](docs/getting-started.md)。

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

`apps/daemon`(daemon,可编译成单文件)、`apps/desktop`(Electron 应用)、`packages/*`(协议、传输、客户端、界面、Claude 适配)。门禁约 7 秒;集成测试(`bun run test:integration`)启动真实进程;`bun run build` 构建 daemon 和桌面端,`bun run start` 启动。详见 [docs/testing.md](docs/testing.md)。

## v1 不做

git worktree、终端、diff 视图、多 provider、Web 端。

## 文档

- [docs/getting-started.md](docs/getting-started.md):安装和使用(从这里开始)
- [docs/architecture.md](docs/architecture.md):架构与分层
- [docs/protocol.md](docs/protocol.md):协议规范(草稿)
- [docs/desktop.md](docs/desktop.md):桌面客户端:构建、结构、安全设置、已知缺口
- [docs/analytics.md](docs/analytics.md):产品埋点:规则、事件字典、怎么给新功能加埋点
- [docs/daemon.md](docs/daemon.md):daemon:做了什么、没做什么、验证结果
- [docs/adapters/claude.md](docs/adapters/claude.md):Claude 适配:做了什么、没做什么、验证结果
- [docs/decisions/](docs/decisions/):设计决策记录
