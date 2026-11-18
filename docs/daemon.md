# daemon

状态:草稿。验证日期 2026-11-18。

`packages/daemon`:L1 协议的实现(见 [protocol.md](protocol.md))。daemon 对客户端说 ACP v2,对 agent 也说 ACP v2。

## 结构

| 文件                             | 作用                                                                             |
| -------------------------------- | -------------------------------------------------------------------------------- |
| `src/log/`                       | 事件日志:接口、JSONL 实现、补发(`attach`)                                        |
| `src/index-file.ts`              | session 索引,整体原子写入                                                        |
| `src/agents.ts`、`agent-link.ts` | agent 的定义,以及到 agent 的 ACP 连接(daemon 是 client)                          |
| `src/process-agent.ts`           | 把一个子进程作为 agent 启动,显式环境,不继承                                      |
| `src/session.ts`                 | 一个已加载的 session 的状态                                                      |
| `src/daemon.ts`                  | 面向客户端的 ACP 应用:session 的创建、列表、附着、prompt、取消、权限、归档、删除 |

客户端看到的一切都经过 session 的日志:补发和实时是同一条路径。

## 已做并测过

- `session/new`:daemon 分配 UUID,作为建议传给 agent;agent 回的 id 和它对应关系记在索引里。
- `session/list`:只列 Cycle 自己的 session,带状态、agent、归档、标题和最新序号。
- `session/resume`:附着;不带 `replayFrom` 只附着,`start` 或 `_cycle.seq` 补发,然后 `replay_complete` 和状态快照。
- `session/prompt`:session 忙时拒绝(`session_busy`);agent 没在运行时先启动并恢复它。
- 权限请求:写日志,发给所有附着的客户端,先到先得,其余客户端收到 `_cycle/request_resolved`;没人附着时挂起,有人附着再发;取消或 agent 退出时回答为已取消。
- `session/cancel`、`session/set_config_option`(记入索引,agent 重启时重新应用)、`session/close`、`session/delete`。
- `_cycle/agents/list`、`_cycle/session/archive`、`unarchive`、`set_title`,以及 `_cycle/session_list_changed` 通知。
- agent 进程退出:挂起的请求中止,进行中的 turn 以错误结束,下一次 prompt 重新启动并恢复。
- daemon 重启:索引和日志在磁盘上,历史可读,不启动 agent。
- 协议主版本不一致时以 ACP 的 `-32022` 拒绝。

## 没做

- **`_cycle/agent_defaults/*`**:只是占位,读返回空,写什么都不存。
- **配置校验**:`cycle/config` 不按 `configSchema` 校验,直接交给 agent,由 agent 拒绝(映射为 `invalid_config`)。
- **合成 `user_message`**:协议 §8 写的"agent 不发时 daemon 合成"没有实现。Claude 自己会发,所以现在不需要;接入不发的 agent 时再做。
- **`session/list` 的分页和过滤**。
- **日志里的敏感字段过滤**。
- **一个 session 一个 agent 进程**:没有复用。
- **daemon 的打包和安装**:现在是 `bun apps/daemon/src/main.ts`;没有 `cycle-daemon` 可执行文件,也没有远端机器上的安装步骤。ssh 通道里的命令得由调用方写全。
- **daemon 退出时对客户端的通知**:客户端靠连接断开发现,然后重连。
- **多个 daemon 版本之间的升级**:daemon 重启会丢掉进行中的 turn(agent 是它的子进程),这一点没变。
- **空闲退出和 session 的内存回收**:已加载的 session 一直在内存里。
- **客户端先于 `initialize` 发请求的处理**:交给 SDK(返回 `-32600`)。

## 运行

```bash
bun apps/daemon/src/main.ts serve  [--data-dir <dir>] [--socket <path>]   # 前台运行
bun apps/daemon/src/main.ts proxy  [--data-dir <dir>] [--socket <path>]   # stdin/stdout 接到 socket;daemon 没在运行就先启动它
```

- 数据目录默认 `$CYCLE_V1_HOME` 或 `~/.cycle-v1`;socket 默认 `<数据目录>/daemon.sock`。
- `proxy` 启动的 daemon 是脱离的(`detached`),不随 ssh 连接结束,所以连接断了 session 照常运行。
- 同一个 socket 上只能有一个 daemon(`serve` 发现已有进程在监听就以退出码 3 退出);进程异常退出留下的 socket 文件会被清掉。
- daemon 在数据目录里写 `daemon.pid`。
- socket 权限 0600,所在目录 0700。这就是 v1 的全部访问控制(决策 0004)。

## 配置:`<数据目录>/config.json`

```json
{
  "claude": {
    "configDir": "/path/to/claude-config",
    "allowEnv": ["PATH", "LANG", "LC_ALL", "TERM"],
    "env": { "ANTHROPIC_API_KEY": "..." }
  }
}
```

- **Claude 进程看到的环境只有三样**:`allowEnv` 里点名的、daemon 自己环境中存在的变量;`CLAUDE_CONFIG_DIR`;`env` 里写明的值。daemon 自己的环境变量不会传下去。端到端测试里给 daemon 设了 `ANTHROPIC_API_KEY`,检查 Claude 一侧的请求里没有它。
- `configDir` 默认是 `<数据目录>/claude`,一个独立目录,里面没有登录。要用已有登录,把它**有意地**指向那个目录(比如 `~/.claude`);要新登录,用 `CLAUDE_CONFIG_DIR=<目录> claude login`。
- `HOME` 默认不传(回落到 `configDir`),免得 Claude 找到没人打算共享的登录或设置。

## 客户端侧

- `packages/transport`:unix socket 的监听和连接、stdio 到 socket 的桥接、ssh 通道(用系统的 `ssh`,`BatchMode=yes`,所以 `~/.ssh/config`、密钥和 known_hosts 都照常生效)。
- `packages/client`:`CycleClient`,给 Electron 的主进程用。记住每个被观看的 session 看到的最大 `cycle/seq`;连接断了就按退避重连,重连后对每个 session 用 `_cycle.seq` 要回错过的部分,每条记录只交给调用方一次,按序,没有重复。重连期间发的请求立刻失败,不排队。

## 验证

- `bun test`(门禁里):对一个进程内的假 ACP agent,覆盖上面"已做"的每一项。
- `bun run test:integration`(在 `packages/daemon` 下):客户端、daemon、Claude 适配进程、真实 Agent SDK、本地模拟 API 一起跑:
  - 一个 turn 的流式输出,客户端断线后按 `cycle/seq` 补发,daemon 重启后历史从磁盘读出来,再 prompt 时 Claude 恢复并带着之前的上下文;
  - 模型还在输出时取消,剩余文本没有到达客户端。
- `bun run test:integration`(在 `apps/daemon` 下):**整个后端**。客户端用 `CycleClient` 经过 ssh(用一个在本机执行命令的替身)连上;没有 daemon 在运行,`proxy` 把它启动起来;daemon 启动 Claude 适配进程,跑真实 SDK,对本地模拟 API。一个 turn 之后客户端断开,daemon 仍在运行且 pid 不变;新客户端再连上,拿到历史,继续对话,模型的请求里有前一个 turn 的上下文。
- `packages/transport` 和 `packages/client` 的测试在门禁里:8MB 的消息、500 条消息保序、socket 权限、单实例、残留 socket、桥接、ssh 参数;客户端断线重连不丢不重、断线时错过的内容回来后补上、断线时挂起的权限请求在重连后重新问、`start` 失败、`close` 后不再重试。
- 一个由测试发现的问题:agent 恢复时发的状态快照曾被当作历史记进日志,客户端会把它当成 turn 结束。现在丢弃,并有测试(把修复去掉,测试会失败)。
