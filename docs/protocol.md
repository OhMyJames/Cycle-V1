# 协议规范

状态:草稿 v0.1(L1 客户端到 daemon),待评审

本文定义 **L1**:Cycle 客户端和 daemon 之间的协议。L2(daemon 到 agent)直接使用 ACP v2,不在这里重述;L3 见 `docs/architecture.md`。

依据:
- 决策 [0005](decisions/0005-acp-v2.md):L1 以 ACP v2 为蓝本,字段和语义保持一致,类型由我们固定版本;Cycle 的扩展用 `_cycle/*` 和 `_meta`。
- 决策 [0002](decisions/0002-session-persistence.md):daemon 自己保存历史,JSONL 是唯一来源。
- 决策 [0006](decisions/0006-own-sessions.md):只管理 Cycle 自己的 session。
- 决策 [0004](decisions/0004-auth.md):v1 不在协议里做鉴权。

ACP 方法和类型已对照 `@agentclientprotocol/sdk` 2.7.0 的 v2 稳定版 JSON schema 核对。凡标注"待验证"的地方,还没有在真实 agent 上跑过。

## 1. 原则

1. **不重复 ACP。** ACP v2 已有的方法、通知和类型,L1 原样使用,本文只写差异。
2. **daemon 是 session 的所有者。** 客户端把 daemon 当成一个 ACP agent 来用,daemon 再去驱动真正的 agent。
3. **历史在 daemon。** 客户端看到的会话历史来自 daemon 的日志,不来自 agent 重放。
4. **协议与传输分离。** 本文只规定 JSON-RPC 消息,不规定怎么送达。

## 2. 传输与帧

- 消息格式是 JSON-RPC 2.0,UTF-8。
- 一条消息对应一个传输帧。流式传输(unix socket、stdio)上用换行分隔的 JSON,每条消息单行,不含未转义的换行。
- v1 的实现:
  - 本地:unix socket。
  - 远程:SSH 通道(`ssh host cycle proxy`,把 stdio 桥接到远端 daemon 的 socket)。
- 一个连接对应一个客户端。daemon 同时服务多个连接。
- 连接断开不影响 session 的运行。

## 3. 版本与能力协商

连接建立后,客户端必须先发 `initialize`(ACP v2 的方法),在响应之前不得发其他请求。

- `protocolVersion`:ACP 的协议版本,整数,仅在不兼容变更时递增。
- Cycle 自己的版本放在 `_meta["cycle/protocolVersion"]`,格式 `"主.次"`,当前为 `"0.1"`。主版本不同则 daemon 以 `-32022`(ACP 的 Unsupported protocol version)拒绝,并在 `data` 里列出自己支持的版本。次版本差异通过能力协商处理。
- daemon 在 `initialize` 响应的 `_meta["cycle/capabilities"]` 中声明能力:

```json
{
  "replay": ["start", "seq"],
  "agents": ["claude"],
  "sessionOps": ["archive", "rename", "delete"]
}
```

- 客户端不认识的能力忽略。daemon 不认识的客户端能力同样忽略。
- ACP 的 `fs/*` 和 `terminal/*` 能力 v1 不支持(v2 稳定版里本来也没有 `fs/*`)。`initialize` 的客户端能力里相应字段缺省即视为不支持。

## 4. ACP v2 方法在 L1 的使用

下表中"客户端 → daemon"的方法,daemon 按 `sessionId` 路由到对应 agent 并转发,除非标注"daemon 处理"。

| 方法 | 方向 | 在 L1 的行为 |
| --- | --- | --- |
| `initialize` | 客户端 → daemon | daemon 处理,见 §3 |
| `session/new` | 客户端 → daemon | daemon 创建 session 并启动 agent,见 §6 |
| `session/list` | 客户端 → daemon | daemon 处理,只返回 Cycle 自己的 session,见 §6 |
| `session/resume` | 客户端 → daemon | daemon 处理,表示"附着并按需补发历史",见 §7 |
| `session/prompt` | 客户端 → daemon | 转发。仅在 session 空闲时接受,见 §8 |
| `session/cancel` | 客户端 → daemon | 转发(通知) |
| `session/close` | 客户端 → daemon | daemon 处理:停止 agent 进程,保留历史 |
| `session/delete` | 客户端 → daemon | daemon 处理:删除日志和索引,客户端必须先向用户确认 |
| `session/set_config_option` | 客户端 → daemon | 转发,并把结果写入 session 的配置记录 |
| `tool_call/cancel` | 客户端 → daemon | 转发 |
| `session/update` | daemon → 客户端 | 转发 agent 的更新,并加上 `seq`,见 §5 |
| `session/request_permission` | daemon → 客户端 | 转发 agent 的请求,见 §9 |
| `elicitation/create` | daemon → 客户端 | 转发,处理方式同 §9 |
| `auth/*` | — | v1 不用。agent 的登录由 agent 所在环境自己完成 |

`session/update` 的变体沿用 ACP v2:`user_message(_chunk)`、`agent_message(_chunk)`、`agent_thought(_chunk)`、`state_update`、`tool_call_update`、`tool_call_content_chunk`、`terminal_update`、`terminal_output_chunk`、`plan_update`、`available_commands_update`、`config_option_update`、`session_info_update`、`usage_update`、`notice`、`compaction_update`、`compaction_summary_chunk`、`replay_complete`、`subagent_update`、`session_message(_chunk)`。客户端遇到不认识的变体应忽略,不得报错。

v1 的 Claude 适配只需产生其中的子集,见 L3 文档(待写)。

## 5. 事件序号 `seq`

daemon 为每个 session 维护一个单调递增的整数序号,从 1 开始,**每条写入该 session 日志的记录占一个序号**。

- daemon 转发给客户端的每条 `session/update` 通知,在 `_meta["cycle/seq"]` 里带上它的序号。
- agent 发来的请求(如权限请求)和它的响应同样占序号,见 §9。
- 序号只由 daemon 分配,agent 和客户端不得设置。
- 序号等于该记录在 JSONL 日志里的行号(从 1 开始),所以日志本身就是序号的事实来源。
- 序号不跨 session。

## 6. session 生命周期

### 创建

`session/new` 的参数是 ACP v2 的 `cwd`、`additionalDirectories`、`mcpServers`、`systemPrompt`,加上 Cycle 扩展:

```json
{
  "cwd": "/abs/path",
  "_meta": {
    "cycle/agent": "claude",
    "cycle/config": { "model": "...", "mode": "..." }
  }
}
```

- `cycle/agent`:agent 的 id,必须在 daemon 声明的 `agents` 里。缺省时使用 daemon 的默认 agent。
- `cycle/config`:创建时的初始配置,键由该 agent 的配置 schema 决定(见 §10)。daemon 校验后翻译成 agent 能理解的形式。
- 响应是 ACP 的 `NewSessionResponse`,`sessionId` 由 daemon 分配。**sessionId 是 daemon 的,不是 agent 的**:daemon 内部维护它与 agent 侧 session id 的对应关系,客户端不得依赖两者相等。

### 列表

`session/list` 只返回 Cycle 自己创建的 session(决策 0006),带 ACP 的 `SessionInfo` 字段,并在 `_meta` 里加:

- `cycle/archived`:布尔。
- `cycle/agent`:agent id。
- `cycle/state`:`"running"`、`"idle"`、`"requires_action"` 或 `"stopped"`(agent 进程不在)。
- `cycle/lastSeq`:该 session 的最新序号。

列表变化(新建、删除、归档、状态改变)通过通知 `_cycle/session_list_changed` 告诉所有客户端,通知里不带内容,客户端收到后重新拉列表。

### 删除、归档、改名

- 删除:`session/delete`。session 正在工作时拒绝(错误码见 §11)。
- 归档:`_cycle/session/archive` 和 `_cycle/session/unarchive`,只改 daemon 的索引,不动历史。工作中拒绝。
- 改名:`_cycle/session/set_title`,参数 `{sessionId, title}`。daemon 自己保存标题。ACP v2 的 `session/set_title` 目前只在 unstable 里,稳定后改用它。

## 7. 附着、历史补发与重连

这是 ACP 没有定义、由 L1 补上的部分。

客户端通过 `session/resume` 附着到一个 session。参数沿用 ACP 的 `ResumeSessionRequest`,其中 `replayFrom` 的取值扩展为:

| `replayFrom` | 含义 |
| --- | --- |
| 缺省或 null | 只附着,不补发。之后的更新会推送给客户端 |
| `{"type": "start"}` | 从第 1 条记录开始补发全部历史(ACP 已有) |
| `{"type": "_cycle.seq", "after": N}` | 补发序号大于 N 的记录(Cycle 扩展) |

行为:

1. daemon 从自己的日志读取要补发的记录,按序号顺序以 `session/update` 发给该客户端,每条带 `cycle/seq`。补发过程中产生的新更新排在补发之后,不丢也不重复。
2. 补发完成后发一条 `replay_complete` 更新(ACP 已有),它的 `cycle/seq` 是补发时的最新序号。
3. 之后进入实时推送。
4. 响应是 ACP 的 `ResumeSessionResponse`。

**重连的标准做法**:客户端记住每个 session 收到的最大 `cycle/seq`,断线重连后用 `{"type": "_cycle.seq", "after": 该值}` 附着。daemon 不保存客户端的位置,位置完全由客户端持有。

如果 `after` 大于 session 当前的最新序号,daemon 以 `-32602`(Invalid params)拒绝。

**历史补发不经过 agent。** agent 进程可能已经退出(daemon 重启、sandbox 销毁),历史照样可读。

### 继续一个已停止的 session

附着只读取历史,不启动 agent。当客户端对一个 `stopped` 的 session 发 `session/prompt` 时,daemon 才启动 agent 进程,并用 session 日志里保存的 `cwd`、`mcpServers`、配置去恢复它(调用 agent 的 `session/resume`,**不带 `replayFrom`**,避免 agent 重复产生历史,否则日志里会出现重复记录)。恢复失败的处理见 §11。

待验证:Claude 适配在不带 `replayFrom` 恢复时,能否恢复出完整的对话上下文。

## 8. 提交 prompt 与 turn 状态

沿用 ACP v2 的模型:

- `session/prompt` 立即返回 `messageId`,不代表 turn 结束。
- turn 的状态由 `state_update` 表达:`running`、`requires_action`、`idle`。`idle` 带 `stopReason`(`end_turn`、`max_tokens`、`max_turn_requests`、`refusal`、`cancelled`、`error`),它标志 turn 结束。
- 用户消息通过 `user_message` 更新进入日志。agent 没有发出时,daemon 用 `session/prompt` 的内容合成一条,保证历史里一定有用户消息。待验证。

多个客户端同时附着的规则:

- 只有 session 为 `idle` 时才接受 `session/prompt`。否则以 `-32010`(`session_busy`)拒绝。
- `session/cancel` 任何附着的客户端都可以发。
- 一个客户端发出的 prompt,对所有附着的客户端都可见(通过 `user_message` 更新)。

## 9. 权限请求与交互请求

agent 发来的 `session/request_permission` 和 `elicitation/create` 是**需要回答的请求**,必须能跨越客户端的断线和重连。

1. daemon 收到请求后先写入日志(占一个序号),再转发给所有附着的客户端,同时把 session 的状态置为 `requires_action`。
2. **第一个到达的响应生效**,daemon 把它转给 agent,并把响应写入日志(占一个序号)。随后给其他客户端发 `_cycle/request_resolved` 通知,带上 `requestId` 和被选中的结果,让它们关闭各自的对话框。后到的响应被丢弃,不报错。
3. 没有客户端附着时,请求保持挂起。新客户端附着时,daemon 在补发之后重新发送所有未解决的请求。
4. 客户端收到 `session/cancel` 之后,按 ACP 的规定,所有未解决的权限请求必须以"已取消"的结果回复。这一步由 daemon 代为完成,不依赖客户端。
5. agent 进程退出时,未解决的请求在日志中标记为"已中止",并发 `_cycle/request_resolved`。

## 10. agent 与配置

### agent 清单

`_cycle/agents/list`(无参数)返回 daemon 可用的 agent:

```json
{
  "agents": [
    {
      "id": "claude",
      "name": "Claude",
      "available": true,
      "configSchema": { "...": "JSON Schema,描述该 agent 的可配置项" }
    }
  ]
}
```

`configSchema` 是 JSON Schema,客户端用它渲染配置界面,不需要认识具体 agent。候选配置项(Claude):模型、权限模式、思考强度、MCP 服务、环境变量白名单、系统提示。具体字段在 L3 文档里定义。

### 默认配置

- `_cycle/agent_defaults/read`:参数 `{agent}`,返回该 agent 当前的默认配置。
- `_cycle/agent_defaults/set`:参数 `{agent, config}`,daemon 按 `configSchema` 校验后保存,并发 `_cycle/agent_defaults_changed` 通知。

新建 session 时,`cycle/config` 覆盖默认配置。

### session 级配置

session 运行中的配置变更使用 ACP 的 `session/set_config_option`,agent 通过 `config_option_update` 回报当前值。daemon 把最终生效的值写入 session 的配置记录,用于恢复。

### 环境变量

daemon 启动 agent 时只传入显式白名单里的环境变量,不继承自己的环境(AGENTS.md 红线)。白名单是 daemon 的配置,不通过协议修改。

## 11. 错误

沿用 JSON-RPC 2.0 和 ACP v2 的错误码。ACP 已占用:-32700、-32600 到 -32603、-32800(请求取消)、-32000(需要鉴权)、-32002(资源不存在)、-32022(不支持的协议版本)。

- session 不存在,或不属于 Cycle:用 ACP 的 `-32002`,`data` 用 ACP 的 `SessionNotFoundErrorData`。
- 协议版本不兼容:用 ACP 的 `-32022`。
- 其余是 Cycle 自己的,取 -32010 到 -32019,避开 ACP 已用的码:

| 码 | 名称 | 含义 |
| --- | --- | --- |
| -32010 | `session_busy` | session 正在工作,不接受该操作 |
| -32011 | `agent_unavailable` | agent 不可用(未安装、启动失败) |
| -32012 | `agent_exited` | agent 进程在操作中退出 |
| -32013 | `resume_failed` | agent 无法恢复该 session。历史仍可读,但不能继续对话 |
| -32014 | `invalid_config` | 配置不符合 `configSchema` |
| -32015 | `log_unavailable` | 历史日志读写失败 |

ACP 以后可能占用这个范围里的码,所以 Cycle 的码在 schema 里集中定义,升级 ACP 时对照检查。

错误的 `data` 里带 `{sessionId?, detail?}`,`detail` 供人阅读,客户端不得解析它。

## 12. 日志格式(daemon 内部,但规定以保证可迁移)

每个 session 一个 JSONL 文件,一行一条记录,字段:

```json
{"seq": 12, "ts": "2026-11-18T04:00:00.000Z", "kind": "update", "data": { "sessionUpdate": "agent_message_chunk", "...": "..." }}
```

`kind` 取值:
- `update`:agent 发来的 `session/update` 内容(daemon 合成的用户消息也是这一类)。
- `request`:agent 发来的需要回答的请求,`data` 含 `requestId`、`method`、`params`。
- `response`:对某个 `request` 的回答,`data` 含 `requestId` 和结果,以及回答来自哪个客户端。
- `aborted`:某个 `request` 被中止。
- `meta`:daemon 自己的事件(session 创建、agent 启动和退出、配置变更)。

要求:
- 只追加。写入单行,崩溃留下的末尾半行在读取时丢弃。
- `seq` 严格递增且连续。读取时发现不连续视为日志损坏,以 `-32015` 报告,不静默跳过。
- 日志不包含任何凭证。写入前过滤已知的敏感字段。待定:过滤规则。

session 索引是另一个文件,记录 sessionId、agent id、agent 侧 session id、`cwd`、归档标记、标题、创建时间和 `lastSeq`。索引无法读取时 daemon 拒绝启动(决策 0002)。

## 13. 待定

- L3:Claude 适配需要产生哪些 `session/update` 变体,以及配置 schema 的具体字段。
- 日志里敏感字段的过滤规则。
- 日志的压缩和滚动(上云时再定)。
- 云端 sandbox 下 daemon 与适配进程的连接方向(见决策 0001)。
- ACP v2 稳定后,`session/set_title`、`session/archive` 等 unstable 方法是否替换我们的 `_cycle/session/*`。
