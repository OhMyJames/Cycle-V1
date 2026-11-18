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
- L1 的消息模型以 ACP v2 为蓝本,字段和语义保持一致,不另造事件模型。ACP 类型只从 `@cycle/acp` 导入(它固定 SDK 的精确版本,是唯一导入 `@agentclientprotocol/sdk` 的地方)。Cycle 自己的扩展用 `_cycle/*` 和 `_meta`,用 zod 定义在 `@cycle/protocol`。
- daemon 自己保存会话历史(JSONL),不依赖 agent 重放。只管理 Cycle 自己创建的 session。
- session 事件日志用 JSONL,放在存储接口后面。
- L1 事件由 L2 的 ACP 更新映射而来,不原样透传,使客户端不受 ACP 变化和具体 agent 的影响。
- agent 是可替换的接口;v1 只实现 Claude。
- 协议和传输分离。远程连接走 SSH 隧道,协议本身不依赖具体传输。
- v1 范围外:git worktree、终端、diff、多 provider、Web 端。不要提前实现。

## 命令

- `bun run check`:门禁,提交前必须通过(pre-commit 钩子会运行它)。依次检查边界、类型、lint、测试。
- `bun run format`:格式化并修复可自动修复的 lint。
- `bun run test:integration`(根目录):集成测试,串行跑 4 个套件(Node 下的客户端、Claude 适配、整个后端、Electron 冒烟),每个套件有自己的时限。它们会启动真实进程(Claude、daemon、xvfb 下的 Electron),最重的约 1.5 GB,所以不在门禁里。`bun run test:integration smoke` 只跑名字里有 smoke 的。需要真实模型的运行必须显式开启:`CYCLE_REAL_MODEL_TOKEN=... bun run test:real`(在 `packages/adapters/claude` 和 `packages/daemon` 下),token 只给 Claude 进程,不要从环境里继承,不要进 CI。
- `bun run build`(根目录):构建 daemon 的单文件可执行(约 40 秒,峰值内存约 0.25 GB,产出约 480 MB)和桌面端;`bun run start` 启动桌面端。真实模型的 `test:real` 在 `apps/daemon` 和 `apps/desktop` 下也有,要先 build。
- 目标机器是 2 核 4 GB:门禁约 7 秒、峰值约 0.5 GB;不要把重的东西加进门禁,也不要并行跑集成套件。
- 测试里的等待要有上限:单个测试的超时是它该有的时间,不是"够长就行"。挂住的测试几十秒内必须失败。
- 不要用 `--no-verify`、`@ts-ignore`、`@ts-expect-error` 或 `biome-ignore` 绕过它;修复原因,或有意改规则。
- 测试放在各包的 `test/` 目录,与 `src/` 并列。
- `bun install` 会把 `core.hooksPath` 设为 `.githooks`。

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
