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

- **传输**:daemon 现在只接收 ACP 的 `Stream`(或进程内的 client)。**unix socket 监听、`cycle proxy`(把 stdio 桥接到 socket)和 SSH 通道都还没有。** 这是客户端能连上远程 daemon 之前必须做的。
- **入口**:没有可运行的 daemon 进程(`main`),没有数据目录和 agent 的启动配置。
- **`_cycle/agent_defaults/*`**:只是占位,读返回空,写什么都不存。
- **配置校验**:`cycle/config` 不按 `configSchema` 校验,直接交给 agent,由 agent 拒绝(映射为 `invalid_config`)。
- **合成 `user_message`**:协议 §8 写的"agent 不发时 daemon 合成"没有实现。Claude 自己会发,所以现在不需要;接入不发的 agent 时再做。
- **`session/list` 的分页和过滤**。
- **日志里的敏感字段过滤**。
- **一个 session 一个 agent 进程**:没有复用。
- **空闲退出和 session 的内存回收**:已加载的 session 一直在内存里。
- **客户端先于 `initialize` 发请求的处理**:交给 SDK(返回 `-32600`)。

## 验证

- `bun test`(门禁里):对一个进程内的假 ACP agent,覆盖上面"已做"的每一项。
- `bun run test:integration`(在 `packages/daemon` 下):客户端、daemon、Claude 适配进程、真实 Agent SDK、本地模拟 API 一起跑:
  - 一个 turn 的流式输出,客户端断线后按 `cycle/seq` 补发,daemon 重启后历史从磁盘读出来,再 prompt 时 Claude 恢复并带着之前的上下文;
  - 模型还在输出时取消,剩余文本没有到达客户端。
- 一个由测试发现的问题:agent 恢复时发的状态快照曾被当作历史记进日志,客户端会把它当成 turn 结束。现在丢弃,并有测试(把修复去掉,测试会失败)。
