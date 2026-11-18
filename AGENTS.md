# AGENTS.md

给在本仓库工作的 coding agent 和协作者的说明。

## 项目

cycle-v1 是 ADE(agentic development environment),是 cycle 的重写。这是全新的代码库,不要参考旧的 cycle。
目标和范围见 [README.md](README.md)。

## 当前阶段

设计阶段:先定协议,再写代码。协议文档在 `docs/protocol.md`,是后续实现的依据。

## 架构约束

- 三层:L1 客户端到 daemon(自有协议,稳定,zod schema)、L2 daemon 到 agent(以 ACP v2 为主要参考)、L3 agent 适配。
- 不使用官方 `claude-agent-acp`;Claude 适配自己写,且必须自包含、传输可替换,为云端 sandbox 留路。
- L1 的消息模型以 ACP v2 为蓝本,字段和语义保持一致,不另造事件模型;类型由 zod 在 `packages/acp` 定义并固定版本。Cycle 自己的扩展用 `_cycle/*` 和 `_meta`。
- daemon 自己保存会话历史(JSONL),不依赖 agent 重放。只管理 Cycle 自己创建的 session。
- session 事件日志用 JSONL,放在存储接口后面。
- L1 事件由 L2 的 ACP 更新映射而来,不原样透传,使客户端不受 ACP 变化和具体 agent 的影响。
- agent 是可替换的接口;v1 只实现 Claude。
- 协议和传输分离。远程连接走 SSH 隧道,协议本身不依赖具体传输。
- v1 范围外:git worktree、终端、diff、多 provider、Web 端。不要提前实现。

## 红线(参考 old-cycle,以后违反前先问)

- 不让 agent 继承环境变量。`ANTHROPIC_API_KEY` 之类会覆盖账号登录并计费,环境变量只能走显式白名单。
- 测试永远不指向真实的 `~/.claude`、`~/.agents` 和 Cycle 的真实数据目录。
- daemon 只绑 loopback 或 unix socket,因为 agent 能执行命令。不要放宽。
- 任何账号或 SSO 的 token 不得到达 agent。
- 删除 session 会永久移除记录,客户端必须先确认。

## 技术栈

Bun、TypeScript、Electron,均使用最新版本。包管理和脚本都用 Bun。

## 约定

- 文档用中文,代码标识符、协议字段和提交信息的类型前缀用英文。
- 设计上的取舍记录在 `docs/decisions/`,一条决策一个文件,编号递增。
- 协议变更先改 `docs/protocol.md`,再改实现。
- 提交信息简短,说明做了什么和为什么。
