# 协议规范

状态:草稿 v0.1(L1 客户端到 daemon),待评审

本文定义 **L1**:Cycle 客户端和 daemon 之间的协议。L2(daemon 到 agent)直接使用 ACP v2,不在这里重述;L3 见 `docs/architecture.md`。

依据:

- 决策 [0005](decisions/0005-acp-v2.md):L1 以 ACP v2 为蓝本,字段和语义保持一致,类型由我们固定版本;Cycle 的扩展用 `_cycle/*` 和 `_meta`。
- 决策 [0002](decisions/0002-session-persistence.md):daemon 自己保存历史,JSONL 是唯一来源。
- 决策 [0006](decisions/0006-own-sessions.md):只管理 Cycle 自己的 session。
- 决策 [0004](decisions/0004-auth.md):v1 不在协议里做鉴权。

ACP 方法和类型已对照 `@agentclientprotocol/sdk` 2.7.0 的 v2 稳定版 JSON schema 核对。凡标注"待验证"的地方,还没有在真实 agent 上跑过。已验证的项标注日期和版本,验证只用了本地模拟的 Anthropic API,没有用真实模型。

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
  - 以后可以换成别的远程传输(如 WebSocket):协议不依赖它,客户端用哪种传输连上 daemon,是客户端自己的配置(见 `docs/desktop.md` 的"环境")。daemon 不知道也不关心自己被当作本地还是远程。
- 一个连接对应一个客户端。daemon 同时服务多个连接。
- 连接断开不影响 session 的运行。

## 3. 版本与能力协商

连接建立后,客户端必须先发 `initialize`(ACP v2 的方法),在响应之前不得发其他请求。

- `protocolVersion`:ACP 的协议版本,整数,仅在不兼容变更时递增。
- Cycle 自己的版本放在 `_meta["cycle/protocolVersion"]`,格式 `"主.次"`,本文描述的是 `"0.2"`(`0.1` 到 `0.2` 只加了字段和 `markRead`,见 §6)。主版本不同则 daemon 以 `-32022`(ACP 的 Unsupported protocol version)拒绝,并在 `data` 里列出自己支持的版本。次版本差异通过能力协商处理。
- daemon 在 `initialize` 响应的 `_meta["cycle/capabilities"]` 中声明能力:

```json
{
  "replay": ["start", "seq"],
  "agents": ["claude"],
  "sessionOps": ["archive", "rename", "delete", "markRead"],
  "queue": true,
  "steer": true,
  "files": true,
  "folders": true,
  "filesInFolder": true,
  "trust": true,
  "connectors": true
}
```

- **旧 daemon 的降级**:远程 daemon 可能比客户端旧。`sessionOps` 里没有 `markRead` 的 daemon,客户端不发 `_cycle/session/mark_read`;它的列表里没有 `updatedAt`、`cycle/unread`、`cycle/background`,客户端按"缺失"处理,不得报错,也不得把缺失当成 `false` 或 0 以外的意思(规则见 §6)。

- 客户端在 `initialize` 的 `capabilities.elicitation.form` 里声明自己能回答表单式的提问(见 §9)。不声明就不会收到 `elicitation/create`。
- 每个 agent 能收什么样的 prompt 内容、能不能带 MCP 服务器等,不在这里:daemon 的 `initialize` 不依赖具体 agent,放在 `_cycle/agents/list`(§10)。
- 客户端不认识的能力忽略。daemon 不认识的客户端能力同样忽略。
- ACP 的 `fs/*` 和 `terminal/*` 能力 v1 不支持(v2 稳定版里本来也没有 `fs/*`)。`initialize` 的客户端能力里相应字段缺省即视为不支持。

## 4. ACP v2 方法在 L1 的使用

下表中"客户端 → daemon"的方法,daemon 按 `sessionId` 路由到对应 agent 并转发,除非标注"daemon 处理"。

| 方法                         | 方向            | 在 L1 的行为                                          |
| ---------------------------- | --------------- | ----------------------------------------------------- |
| `initialize`                 | 客户端 → daemon | daemon 处理,见 §3                                     |
| `session/new`                | 客户端 → daemon | daemon 创建 session 并启动 agent,见 §6                |
| `session/list`               | 客户端 → daemon | daemon 处理,只返回 Cycle 自己的 session,见 §6         |
| `session/resume`             | 客户端 → daemon | daemon 处理,表示"附着并按需补发历史",见 §7            |
| `session/prompt`             | 客户端 → daemon | 转发。session 忙时入队或插入当前 turn,见 §8           |
| `_cycle/prompt/dequeue`      | 客户端 → daemon | daemon 处理:把排队的 prompt 撤回,见 §8                |
| `_cycle/files/search`        | 客户端 → daemon | daemon 处理:在 session 的 `cwd` 里找文件,见 §8        |
| `_cycle/folders/list`        | 客户端 → daemon | daemon 处理:列出一个目录下的文件夹(选 `cwd` 用),见 §8 |
| `_cycle/trust/read`          | 客户端 → daemon | daemon 处理:一个文件夹是否信任,见 §8                  |
| `_cycle/trust/set`           | 客户端 → daemon | daemon 处理:记下对一个文件夹的信任决定,见 §8          |
| `_cycle/connectors/*`        | 客户端 → daemon | daemon 处理:管理 connector 和授权,见 §14              |
| `session/cancel`             | 客户端 → daemon | 转发(通知)                                            |
| `session/close`              | 客户端 → daemon | daemon 处理:停止 agent 进程,保留历史                  |
| `session/delete`             | 客户端 → daemon | daemon 处理:删除日志和索引,客户端必须先向用户确认     |
| `session/set_config_option`  | 客户端 → daemon | 转发,并把结果写入 session 的配置记录                  |
| `tool_call/cancel`           | 客户端 → daemon | 转发                                                  |
| `session/update`             | daemon → 客户端 | 转发 agent 的更新,并加上 `seq`,见 §5                  |
| `session/request_permission` | daemon → 客户端 | 转发 agent 的请求,见 §9                               |
| `elicitation/create`         | daemon → 客户端 | 转发,处理方式同 §9                                    |
| `auth/*`                     | —               | v1 不用。agent 的登录由 agent 所在环境自己完成        |

`session/update` 的变体沿用 ACP v2:`user_message(_chunk)`、`agent_message(_chunk)`、`agent_thought(_chunk)`、`state_update`、`tool_call_update`、`tool_call_content_chunk`、`terminal_update`、`terminal_output_chunk`、`plan_update`、`available_commands_update`、`config_option_update`、`session_info_update`、`usage_update`、`notice`、`compaction_update`、`compaction_summary_chunk`、`replay_complete`、`subagent_update`、`session_message(_chunk)`,以及 Cycle 自己的 `_cycle/queue_update`(§8)。客户端遇到不认识的变体应忽略,不得报错。

v1 的 Claude 适配只需产生其中的子集,见 L3 文档(待写)。

## 5. 事件序号 `seq`

daemon 为每个 session 维护一个单调递增的整数序号,从 1 开始,**每条写入该 session 日志的记录占一个序号**。

- daemon 转发给客户端的每条 `session/update` 通知,在 `_meta["cycle/seq"]` 里带上它的序号。
- agent 发来的请求(如权限请求)和它的响应同样占序号,见 §9。
- 序号只由 daemon 分配,agent 和客户端不得设置。
- 序号等于该记录在 JSONL 日志里的行号(从 1 开始),所以日志本身就是序号的事实来源。
- 序号不跨 session。
- 客户端看到的序号会有空洞:`meta`、`response`、`aborted` 记录不作为 `session/update` 发出。客户端不得要求序号连续,只需记住收到的最大值。

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

- `additionalDirectories`、`mcpServers`、`systemPrompt` 由 daemon 校验并**保存在索引里**,agent 每次启动(新建,以及停止后的恢复)都带着它们,所以 agent 进程被释放或重启后它们仍然有效。`session/resume` 发给 agent 时 daemon 重新带上;客户端不需要重发。
  - `systemPrompt`:只支持 `mode: "append"`,内容只能是 `text` 块。`override` 以 `-32602` 拒绝:它会换掉 agent 自带的指令,包括工具的用法。
  - `mcpServers`:支持 `stdio` 和 `http`。条目里可能有密钥(`env`、`headers`),所以**只存在索引里**(目录 0700,文件 0600);不进 JSONL 日志(日志会补发给每个客户端),`session/list` 也不返回它们,`_cycle/agents/list` 不提它们。Claude 适配用 `mcpServersDelivery: "initialize"` 交给 Claude 进程,密钥不出现在命令行上。
  - `additionalDirectories`:绝对路径,在 daemon 所在的机器上;和 `cwd` 一样要求存在。
- `cycle/agent`:agent 的 id,必须在 daemon 声明的 `agents` 里。缺省时使用 daemon 的默认 agent。
- `cycle/config`:创建时的初始配置,键由该 agent 的配置 schema 决定(见 §10)。daemon 校验后翻译成 agent 能理解的形式。
- 响应是 ACP 的 `NewSessionResponse`。`sessionId` 由 daemon 分配,格式是 UUID。

**sessionId 与 agent 侧 id:能复用就复用,不能就关联。**

1. daemon 生成 `sessionId`,创建 agent 侧 session 时把它作为建议传给 agent:`session/new` 的 `_meta["cycle/sessionId"]`。
2. 如果 agent 支持采用这个 id(Claude Agent SDK 支持:`query` 的 `sessionId` 选项,要求是合法 UUID,已在 0.3.327 的类型定义里确认),它在 `NewSessionResponse` 里返回同一个 id。两者相等,daemon 不需要额外的对应关系。
3. 如果 agent 不支持,它返回自己的 id。daemon 在索引里记录 `sessionId` 到 `agentSessionId` 的对应,对客户端仍只暴露 `sessionId`。
4. 判断方式只看响应:返回的 id 等于建议的 id 就是复用,否则是关联。daemon 不需要事先知道 agent 属于哪一种。
5. 索引里始终保存 `agentSessionId`,复用时它等于 `sessionId`。daemon 对 agent 说话时一律用 `agentSessionId`。客户端不得假设两者相等。

采用 id 的好处:agent 自己的 transcript 和 Cycle 的历史用同一个 id,排查问题和以后导入导出都更直接。注意 Claude SDK 的限制:`sessionId` 不能和 `resume` 或 `continue` 同时使用,除非同时 fork。所以只在新建时传,恢复时用 `agentSessionId` 走 resume。

### 列表

`session/list` 只返回 Cycle 自己创建的 session(决策 0006)。请求的 `_meta["cycle/onlyPrompted"]` 为 `true` 时,只返回**已经收到过用户消息**的:新建 session 在客户端是一个空白对话,首条消息发出时才 `session/new` 加 `session/prompt`(`.agents/notes/2026-11-19-session-starts-at-first-message.md`),所以一个 session 从 daemon **接下**它的第一条 prompt 起才出现在这样的列表里(通过了内容检查,不论之后是直接发给 agent、排队,还是 agent 起不来而失败),此时 daemon 发 `_cycle/session_list_changed`。不带这个标记的请求(旧客户端:它们靠在列表里找到刚建的 session 来打开它)照旧列出全部。还没有用户消息的 session 仍然存在:可以 `session/resume`、`session/prompt`、删除。daemon 不会自动删除它们。历史不可用的 session(`cycle/historyFailed`,写不进去或读不了)照旧列出,好让人能删除它。

daemon 在索引里记 `prompted`;在这个规则之前写的索引条目没有它,daemon 在列表时读一次该 session 的日志(按存储的样子,不读回图片),有 `user_message` 就算,补上之后不再读。

列表里每一项带 ACP 的 `SessionInfo` 字段,其中 `updatedAt`(ISO 8601)是 session 最后一条非 `meta` 记录的 `ts`;还没有这类记录时是创建时间。列表按它排序和按日分组。再在 `_meta` 里加:

- `cycle/archived`:布尔。
- `cycle/agent`:agent id。
- `cycle/state`:`"running"`、`"idle"`、`"requires_action"` 或 `"stopped"`(agent 进程不在)。
- `cycle/lastSeq`:该 session 的最新序号。**只用于补发**(§7):它是每个 session 自己数的记录条数,不是时间,不能在 session 之间比较,客户端不得用它排序。
- `cycle/unread`:布尔。有值得看的新记录晚于客户端上次标记已读的位置,见"已读"。
- `cycle/historyFailed`:布尔,为 `true` 时这个 session 的历史不可用:写不进去了(§12“写入失败”),或读不了(日志里有损坏的整行,§12)。没有时省略。读不了的 session 照样出现在列表里,行里没有 `cycle/lastSeq` 和 `cycle/unread`(它们来自日志),`updatedAt` 是创建时间,`cycle/state` 是 `stopped`;打开它(`session/resume`)以 `-32015` 失败。一个 session 的日志读不了,不影响列表里的其他 session。
- `cycle/background`:整数,仍在运行的后台子 agent 数(`subagent_update` 里 `_meta["cycle/subagent"].background` 为 true 且 `state` 还不是终态,见 §9)。为 0 时省略。它只记在内存里:daemon 重启后 agent 进程不在了,归 0,不写进索引。
- `cycle/usage`:最近一次 `usage_update`,`{used, size, cost?: {amount, currency}}`:已用的上下文 token、窗口大小、累计费用。daemon 存在索引里,列表不用重放日志就能显示;还没有过 `usage_update` 的 session 没有这个字段。

列表变化(出现第一条用户消息、删除、归档、`cycle/state` 改变、`cycle/unread` 改变、`cycle/background` 的值改变)通过通知 `_cycle/session_list_changed` 告诉所有客户端,通知里不带内容,客户端收到后重新拉列表。

一个等待中的请求被回答(session 不再是 `requires_action`)也发这个通知。

**`updatedAt` 自己的变化不发通知**:session 在流式输出时每条记录都会改它,每次都通知会让所有客户端不停地重拉列表。客户端在看到一个 session 状态改变的通知后重拉,拿到的就是新值。

**缺失字段的含义**(旧 daemon):没有 `updatedAt` 的 session,排在有 `updatedAt` 的之后,彼此之间按 `cycle/lastSeq` 降序(同一个 daemon 里它可比);没有 `cycle/unread` 就不显示未读;没有 `cycle/background` 且 daemon 声明了 `markRead`(即 0.2),是 0;旧 daemon 上则不显示后台状态。

### 删除、归档、改名

- 删除:`session/delete`。session 正在工作时拒绝(错误码见 §11)。daemon 先从索引里去掉它,再移除日志:从那一刻起,任何之后的 `session/resume`(包括断线重连时的)都得到 `-32002`,不会因为日志还没删完而把它重新加载出来;同时在读的列表跳过它。日志读不了的 session 也可以删除(不需要先能打开它):这是清掉它的办法。
- 归档:`_cycle/session/archive` 和 `_cycle/session/unarchive`,只改 daemon 的索引,不动历史。工作中拒绝。
- 改名:`_cycle/session/set_title`,参数 `{sessionId, title}`。daemon 自己保存标题。ACP v2 的 `session/set_title` 目前只在 unstable 里,稳定后改用它。

### 已读

未读由 daemon 记,不由客户端本地记:同一个 daemon 可以有几个客户端,换客户端、重装后也要一致(决定笔记 `2026-11-18-sidebar-workspace-environment`)。

- daemon 在索引里为每个 session 记两个序号:`readSeq`(客户端标记过已读的位置)和 `attentionSeq`(最近一条"值得看"的记录的 seq)。"值得看"的记录是:daemon 写下的一条 `request` 记录(权限或表单:不管 agent 有没有另发 `requires_action`,Claude 适配就不发),`state_update` 变成 `requires_action`,以及 `state_update` 变成 `idle` 且带 `stopReason`(turn 结束,任何 `stopReason`,出错也算:agent 中途退出、prompt 因为 agent 起不来或请求失败而被拒绝,daemon 都会写一条 `stopReason: "error"` 的 idle,所以同样算;agent 恢复时发的不带 `stopReason` 的 `idle` 只是状态快照,不算)。`meta` 记录、改标题、用量更新不算,否则它们会造成假的未读。
- `cycle/unread` = `attentionSeq > readSeq`。规则在 daemon,客户端不重新实现。
- `_cycle/session/mark_read`,参数 `{sessionId, seq}`,响应 `{}`。`readSeq` 取原值和 `seq` 中大的那个,不会倒退;`seq` 大于该 session 的 `lastSeq` 以 `-32602` 拒绝。session 在工作时也接受。
- 什么时候发由客户端决定:打开 session 且窗口有焦点时,以及回合结束时仍在看它时,发当时收到的最大 `seq`;不是每条更新都发。
- `cycle/unread` 变化时发 `_cycle/session_list_changed`。
- 不提供"标为未读":v1 不做(要做时再加,不改 `readSeq` 不倒退的规则)。

## 7. 附着、历史补发与重连

这是 ACP 没有定义、由 L1 补上的部分。

客户端通过 `session/resume` 附着到一个 session。参数沿用 ACP 的 `ResumeSessionRequest`,其中 `replayFrom` 的取值扩展为:

| `replayFrom`                         | 含义                                    |
| ------------------------------------ | --------------------------------------- |
| 缺省或 null                          | 只附着,不补发。之后的更新会推送给客户端 |
| `{"type": "start"}`                  | 从第 1 条记录开始补发全部历史(ACP 已有) |
| `{"type": "_cycle.seq", "after": N}` | 补发序号大于 N 的记录(Cycle 扩展)       |

行为:

1. daemon 从自己的日志读取要补发的记录,按序号顺序以 `session/update` 发给该客户端,每条带 `cycle/seq`。补发过程中产生的新更新排在补发之后,不丢也不重复。
2. 补发完成后发一条 `replay_complete` 更新(ACP 已有),它的 `cycle/seq` 是补发时的最新序号。没有补发时(`replayFrom` 缺省)不发。
3. 随后发一条当前状态的 `state_update` 快照。ACP v2 规定每次成功的 `session/resume` 都在响应之前发这个快照,且响应本身不代表 session 空闲。快照是聚合状态而不是一次新的完成,客户端要幂等地应用它。
4. 之后进入实时推送。
5. 响应是 ACP 的 `ResumeSessionResponse`。

**重连的标准做法**:客户端记住每个 session 收到的最大 `cycle/seq`,断线重连后用 `{"type": "_cycle.seq", "after": 该值}` 附着。daemon 不保存客户端的位置,位置完全由客户端持有。

如果 `after` 大于 session 当前的最新序号,daemon 以 `-32602`(Invalid params)拒绝。

**重连时某个 session 已经没有了**(断线期间别的客户端删除了它):daemon 对该 session 的 `session/resume` 回 `-32002`。客户端把这个 session 从观察列表里去掉,告诉界面,并继续附着其余的 session,不重试整个连接,也不再带着它重连。只有连接本身的错误才重试整个连接。在所有 session 都附着完之前,客户端的连接状态不是 `connected`。

**历史补发不经过 agent。** agent 进程可能已经退出(daemon 重启、sandbox 销毁),历史照样可读。

### 继续一个已停止的 session

附着只读取历史,不启动 agent。当客户端对一个 `stopped` 的 session 发 `session/prompt` 时,daemon 才启动 agent 进程,并用 session 日志里保存的 `cwd`、`mcpServers`、配置去恢复它(调用 agent 的 `session/resume`,**不带 `replayFrom`**,避免 agent 重复产生历史,否则日志里会出现重复记录)。恢复失败的处理见 §11。

**agent 自己有没有这个 session 的记录。** 创建 session 时 agent 不一定已经有了它的记录(Claude 要到收到第一个 prompt 才写)。daemon 记下 session 里有没有一个被回答过的 turn(以 `end_turn` 结束;出错或被截断的不算,它们可能没到过 agent),并在恢复时把它放进 `session/resume` 的 `_meta["cycle/hadTurn"]`(为 `true` 时才带)。agent 据此决定怎么做:

- 找到自己的记录:恢复它。
- 没找到,且没有 `cycle/hadTurn`:这个 session 还没有过 turn,agent 把它当新的开始(用同一个 id),第一条消息照常完成。
- 没找到,但有 `cycle/hadTurn`:记录丢了。agent 以错误回应这个 `session/resume`,daemon 报告为 `-32013`(`resume_failed`:历史仍可读,但不能继续对话,§11),而不是悄悄在同一个名字下开一段新对话。
- agent 没办法查看自己的记录(Claude 适配器没有给 Claude 的配置目录,或查看失败)时,按有记录处理,与以前一样。

已验证(2026-11-18,Claude Agent SDK 0.3.327,本地模拟 API):新进程、同一个 `CLAUDE_CONFIG_DIR`,不带 `replayFrom` 恢复后,模型收到的请求里包含之前的用户消息,上下文完整。恢复依赖 Claude 的 transcript 还在配置目录里,而 transcript 按 `cwd` 存放,所以恢复时必须用创建时的 `cwd`。细节见 [docs/adapters/claude.md](adapters/claude.md)。

**agent 在恢复时发的状态快照不进日志。** ACP v2 要求 agent 在 `session/resume` 响应前发一条当前状态(`state_update`)。这是握手,不是历史:daemon 在等待 agent 的 resume 响应期间丢弃 agent 发来的更新。否则每次重启 agent 都会在历史里留下一条没有 `stopReason` 的 idle,客户端会把它当成一个 turn 的结束(实际测试中出现过,见 `packages/daemon` 的测试)。

**怎么区分一个 turn 的结束和状态快照**:turn 结束的 `state_update` 是 idle 并带 `stopReason`;快照没有。客户端据此判断 turn 是否结束。

**daemon 自己发的合成更新没有 `cycle/seq`**,因为它们不在日志里:

- `session/resume` 之后的 `replay_complete`:带 `cycle/seq`,值是补发到的最后序号(它不占序号,只是标记位置)。
- 随后的状态快照:没有 `cycle/seq`。

## 8. 提交 prompt 与 turn 状态

沿用 ACP v2 的模型:

- `session/prompt` 立即返回 `messageId`,不代表 turn 结束。
- turn 的状态由 `state_update` 表达:`running`、`requires_action`、`idle`。`idle` 带 `stopReason`(`end_turn`、`max_tokens`、`max_turn_requests`、`refusal`、`cancelled`、`error`),它标志 turn 结束。
- 用户消息通过 `user_message` 更新进入日志。agent 没有发出时,daemon 用 `session/prompt` 的内容合成一条,保证历史里一定有用户消息。Claude 适配自己会发这一条(用 `session/prompt` 返回的 `messageId`),所以对 Claude 不会触发合成;合成只是对其他 agent 的兜底。daemon 通过 `messageId` 去重。

**内容校验**(决策 0010):daemon 在启动 agent 之前检查 `prompt` 的每一块,不合格就以 `-32602` 拒绝,`data` 为 `{reason, index}`,不会丢掉其中一部分再继续:

- 允许的类型:`text`、`resource_link`(每个 agent 都接受),以及该 agent 的 `promptCapabilities` 允许的:`image`(PNG、JPEG、GIF、WebP)、`resource`(`embeddedContext`:文本,或 `application/pdf` 的二进制)。`audio` 一律不收。
- 上限:每块解码后 5 MiB,整个 prompt 12 MiB,最多 32 块;文本块按 UTF-8 字节数算,`resource_link` 按名字和 uri 的字节数算。常量在 `@cycle/protocol`(`PROMPT_LIMITS`),客户端可以用同一个函数 `checkPrompt` 提前检查。
- `reason`:(空数组在 ACP 的 schema 那一层就被拒绝,没有 `reason`;下面这些是 daemon 自己给的。)`too_many_blocks`、`unsupported_block`、`malformed_block`(缺必需字段,或图片没有内容)、`unsupported_media_type`、`block_too_large`、`prompt_too_large`、`invalid_base64`。

附件和图片进入日志的 `user_message`,历史补发时和文字一起到达。

多个客户端同时附着的规则:

- session 不是 `idle` 时,`session/prompt` 进入队列,不再被拒绝,见下面的"排队"。队列满了才以 `-32010`(`session_busy`)拒绝。daemon 的 `cycle/capabilities` 没有 `queue` 时,客户端只在 session 空闲时发送。
- `session/cancel` 任何附着的客户端都可以发。
- 一个客户端发出的 prompt,对所有附着的客户端都可见(通过 `user_message` 更新;排队的 prompt 通过 `_cycle/queue_update`,发出时才有 `user_message`)。

### 排队(session 忙时发的 prompt)

session 不是 `idle` 时(`running` 或 `requires_action`),`session/prompt` 不再被拒绝,daemon 把它放进该 session 的**队列**。队列由 daemon 持有、写进日志,所以客户端断线、关窗口、换客户端都不会丢。

- **id**:`messageId` 是 agent 在收到 prompt 时自己生成的(Claude 适配用 `randomUUID`),排队的 prompt 还没到 agent,所以没有。队列条目用 daemon 生成的 `queueId`。它**不是**之后历史里 `user_message` 的 `messageId`,两者没有对应关系,客户端不得假设相同。
- **响应**:立即返回,`messageId` 填 `queueId`(ACP 的响应必须有这个字段),`_meta["cycle/queued"]` 为 `true`。内容校验(`checkPrompt`)在入队时就做,不合格同样以 `-32602` 拒绝。
- **上限**:每个 session 最多排 8 条,满了以 `-32010`(`session_busy`)拒绝。
- **`stopped` 的 session 不排队**:照 §7 启动 agent 并直接发送。如果它的队列里还留着东西(崩溃留下的),先把旧队列以 `reason: "interrupted"` 退回,再处理这条 prompt。
- **队列的表达**:`session/update` 的一个 Cycle 变体 `sessionUpdate: "_cycle/queue_update"`,每次队列变化发一条**完整快照**,占一个序号,写进日志。它由 daemon 产生,不是 agent 发的:

```json
{
  "sessionUpdate": "_cycle/queue_update",
  "entries": [{ "queueId": "…", "prompt": [{ "type": "text", "text": "…" }] }],
  "returned": [{ "queueId": "…", "prompt": [] }],
  "reason": "cancelled"
}
```

- **`entries` 是状态,`returned` 是事件。** 客户端以最后一条的 `entries` 为当前队列,所以从任意位置补发都能得到它。`returned` 和 `reason` 只在队列被退回的那一条里出现,客户端**只在它实时到达时**(`replay_complete` 之后)把内容放回输入框;补发过程中遇到的 `returned` 一律忽略,否则重启应用后每次历史里的退回都会再放一遍。
- **附件字节**照决策 0013 存进 blob(daemon 的提取是递归的,覆盖快照里的 `entries[].prompt[]` 和 `returned[].prompt[]`),同一份内容按 sha256 只存一次,快照反复出现不会反复占用空间。
- **发出**:turn 以 `idle` 加 `stopReason: "end_turn"` 结束时,daemon 取队头发给 agent,再发一条新的 `_cycle/queue_update`。它的 `user_message` 和直接发的 prompt 一样,来自 agent 收到时的回显(Claude 适配会发),所以也是此时才进历史,历史里的顺序就是真实发生的顺序。
- **退回,不自动发**:turn 以 `end_turn` 之外的原因结束(`cancelled`、`error`、`max_tokens`、`max_turn_requests`、`refusal`),或者 `session/cancel`、`session/close` 到达时,队列里剩下的**整体退回**:`entries` 清空,原内容放在 `returned`,`reason` 说明原因(`cancelled`、`error`、`closed`、`interrupted`)。客户端把 `returned` 的内容放回输入框,不当作错误显示。宁可退回,也不在用户已经叫停或出错之后替他发出他可能想改的消息。
- **退回时没有客户端附着**(窗口都关了),或者 **daemon 重启**(进程被中断,没有机会退回):daemon 不退回,也不自动发送,队列留着。下一次有客户端附着时,daemon 在补发、`replay_complete` 和状态快照**之后**退回:原因照旧(重启则是 `interrupted`)。这条 `_cycle/queue_update` 是新写的记录(占新的序号),所以附着的客户端是实时收到它的。daemon 自己关闭时杀掉 agent 进程,不算退回的理由。
- **撤回**:`_cycle/prompt/dequeue`(客户端 → daemon),参数 `{sessionId, queueId}`。成功时响应里带那条 prompt 的内容(`{prompt}`),客户端放回输入框编辑,并发一条 `_cycle/queue_update`。那条已经发出或不在队列里,以 `-32016`(`not_queued`)拒绝。

### 插入(steer:把 prompt 放进正在运行的 turn)

排队的 prompt 要等 turn 结束才发;插入的 prompt 现在就交给 agent,由 agent 在当前 turn 里接着处理(Claude 在下一次工具调用之间读到它)。

- **请求**:`session/prompt` 的 `_meta["cycle/steer"]` 为 `true`。只在 session 是 `running` 或 `requires_action` 时有意义;session 空闲或已停止时,这个标记被忽略,照常发送。
- **能力**:daemon 的 `cycle/capabilities` 有 `steer: true`,`_cycle/agents/list` 里能插入的 agent 带 `steer: true`(§10)。客户端只对这样的 agent 提供插入;旧 daemon 不认识这个 `_meta`,会照常排队,所以发了也不会出错。
- **daemon 的处理**:agent 声明能插入时,daemon 把 `session/prompt` 原样转给 agent,`_meta` 里带 `cycle/steer: true`;agent 不声明、拒绝或 agent 进程不在,daemon 退回到排队(§8 "排队"),响应照排队的写法带 `cycle/queued`。插入成功的响应是 agent 给的 `messageId`,`_meta["cycle/steered"]` 为 `true`。
- **agent 的处理**(L2):agent 在当前 turn 收下这条 prompt,立即发它的 `user_message`(带同一个 `messageId`),然后继续这个 turn,不另起 `state_update`。turn 在 agent 处理完它之前结束的(例如 Claude 恰好已经说完),agent 让 turn 继续,把它当作同一个 turn 的后续处理,turn 只以一条 `idle` 结束。turn 被取消时还没处理的插入,agent 必须保证它不会在之后悄悄运行(Claude 适配会结束进程,下一条 prompt 启动新进程恢复会话)。
- **历史**:插入的 `user_message` 在 agent 收下时进日志,所以它在历史里出现在 turn 中间,位置就是它被收下的时刻。
- 插入不经过队列,也不改变队列:队列里等着的 prompt 仍在 turn 正常结束后发出。

### 提及(@)文件与文件夹

客户端在输入框里用 `@` 引用 session 的 `cwd` 下的文件或文件夹。还没有 session 的空白对话(§6 列表)引用它选好的 `cwd` 下的。

**搜索**:`_cycle/files/search`(客户端 → daemon),参数 `{sessionId, query, limit?}` 或 `{cwd, query, limit?}`(两者恰好给一个),响应 `{root, entries: [{path, kind}], truncated}`:

- `root` 是 `cwd` 的绝对路径;`path` 是相对 `root` 的路径,用 `/` 分隔;`kind` 是 `"file"` 或 `"folder"`。
- 排序:名字以 `query` 开头的在前,名字包含的次之,路径包含的最后;`query` 含 `/` 时只匹配路径。`query` 为空时给顶层的文件夹和文件。`limit` 缺省 20,最大 50。
- **只在 `cwd` 内**:daemon 对每个候选取 `realpath`,不在 `cwd` 的 `realpath` 之内的丢掉;符号链接不跟随,也不列出。`cwd` 不存在时返回空列表,不是错误。
- **有上限**:最多检查 50,000 个条目、最多走 2 秒;到了上限就带 `truncated: true` 返回已找到的。跳过 `.git` 和 `node_modules`;名字以 `.` 开头的文件,只有 `query` 里含 `.` 时才给。
- 这是 daemon 读本机文件系统的新入口:不返回文件内容,只返回路径;只在 loopback、unix socket 或 SSH 通道上服务,不放宽。session 不存在以 `-32002` 拒绝。
- **按 `cwd` 搜**:给空白对话用,那时还没有 session。`cwd` 必须是绝对路径,否则以 `-32602` 拒绝;同时给 `sessionId` 和 `cwd`,或都不给,也是 `-32602`。规则和按 session 搜完全一样,`root` 是给的 `cwd`;不存在时同样返回空列表。它不比按 session 搜多暴露什么:谁能连上 daemon,谁就能用任意 `cwd` 新建 session 再搜。能力 `filesInFolder` 为 `true` 才有;旧 daemon 没有时,客户端在空白对话里不提供 @ 搜索,有了 session 之后照常。

### 选文件夹

新建 session 要在 daemon 所在机器的文件系统里选一个 `cwd`;远程环境的文件夹在本机看不到,所以由 daemon 来列。**不依赖 session**(session 还不存在)。

`_cycle/folders/list`(客户端 → daemon),参数 `{path?, hidden?}`,响应 `{path, parent, home, folders: [{name}], truncated}`:

- `path` 缺省是 daemon 所属用户的主目录;给了就必须是绝对路径,否则以 `-32602` 拒绝。
- 响应的 `path` 是**真实路径**(`realpath`,符号链接已解开):客户端显示它,往下走时用 `path` 加 `name` 拼出下一个。`parent` 是上一级(根目录没有上一级,为 `null`);`home` 是主目录,给"回到主目录"用。
- `folders` 只有**文件夹**,不含文件,更不含内容。指向文件夹的符号链接算文件夹(这是为了能走进 `~/work` 这样的链接),指向别处的不算。名字以 `.` 开头的,只有 `hidden: true` 才给。按名字排序,不分大小写,同序的以字节序为准。
- **有上限**:最多看一个文件夹的 20,000 个条目,最多给 1,000 个;多了带 `truncated: true` 返回已有的。指向别处的符号链接成批地(每批 64 个)去看。
- 路径里有 NUL 字节,以 `-32602` 拒绝;路径穿过一个文件(`/etc/hosts/x`)当作`not_a_folder`。
- 错误:`path` 不存在,`-32002`;不是文件夹或读不了,`-32602`,`data.reason` 是 `not_a_folder` 或 `unreadable`。
- **和 `_cycle/files/search` 不同,它不限定在某个 `cwd` 之内**:选文件夹本来就要走遍整个文件系统。它给出的只有文件夹的名字,而且谁能连上 daemon,谁本来就能让 agent 在这台机器上执行命令;所以没有新增能被利用的东西。仍然只在 loopback、unix socket 或 SSH 通道上服务,不放宽。
- **路径用 `/` 分隔**:v1 只支持 POSIX 的 daemon(Linux、macOS);客户端拼下一级时按这个来。
- 能力 `folders` 为 `true` 才有这个方法。旧 daemon 没有:客户端不提供浏览,用户自己输入路径。

### 信任文件夹

项目自己的配置里有会**执行命令**的部分:Claude 的 hooks、`.mcp.json` 里 stdio 服务器的命令和 http 服务器的 `headersHelper` 等。agent 只在被信任的文件夹里运行它们。用户级的配置由 Cycle 托管(Claude 的配置目录是 `$CYCLE_HOME/claude`,不是 `~/.claude`),项目级的配置照常加载;"这个文件夹可以运行它自己的命令"这个决定由 Cycle 记下,由 agent 适配交给 agent。理由见决定笔记 [2026-11-19-folder-trust-is-cycles](../.agents/notes/2026-11-19-folder-trust-is-cycles.md)。

- **决定记在 daemon**(它所在的机器上,`$CYCLE_HOME/trust.json`):文件夹的真实路径(`realpath`)到 `true`(信任)或 `false`(不信任)。没有记录就是**没有决定**。
- **管到子文件夹**:一个文件夹的决定适用于它下面的所有文件夹,**离得最近的决定生效**(信任 `/work`、不信任 `/work/x`,则 `/work/x/y` 不信任)。
- `_cycle/trust/read`,参数 `{path}`,响应 `{path, trusted, from}`:`path` 是真实路径;`trusted` 是 `true`、`false`,没有决定时为 `null`;`from` 是这个决定记在哪个文件夹上(`path` 自己或它的上级),没有决定时为 `null`。
- `_cycle/trust/set`,参数 `{path, trusted}`(`trusted` 是布尔),记在 `path` 的真实路径上,响应同 `read`。
- `path` 必须是绝对路径,否则 `-32602`;不存在,`-32002`;不是文件夹或看不了,`-32602`,`data.reason` 是 `not_a_folder` 或 `unreadable`(和 `_cycle/folders/list` 一致)。
- **交给 agent**(L2):daemon 每次启动 agent(`session/new`,以及恢复时的 `session/resume`)都按 session 的 `cwd` 查一次,有决定就在 `_meta["cycle/trusted"]` 里带上 `true` 或 `false`,没有决定就不带。没有决定时 agent 保持它自己原有的状态,不改。Claude 适配的做法见 [docs/adapters/claude.md](adapters/claude.md)。
- **对已有 session 何时生效**:决定在 agent 进程启动时交给它,agent 之后每次起自己的子进程都按它来。所以 `_cycle/trust/set` 之后,daemon 结束这个文件夹(含子文件夹)里每个 session 的 agent 进程:空闲的(没有在跑的 turn、没有排队的 prompt、没有等待回答的请求、没有后台子 agent)立即结束;正在工作或正在启动的,等它下一次这样空闲时结束(turn 结束、最后一个后台子 agent 结束)。下一条 prompt 以新的决定恢复它。
- **客户端**:新建 session 时(空白对话发出第一条消息、`session/new` 之前),`cwd` 没有决定就先问用户(信任并开始、不信任也开始、取消),答案用 `_cycle/trust/set` 记下;不要默认替用户信任。workspace 的菜单里可以改这个决定。
- 能力 `trust` 为 `true` 才有这两个方法。旧 daemon 没有:客户端不问,也不显示。

**发送**:composer 里的 `@路径` 在发送时变成两样东西:

1. 文本块里保留可读的 `@相对路径`,所以历史、其他客户端、别的 agent 都看得懂。
2. 在 prompt 末尾追加一个 `resource_link` 块:`{type: "resource_link", name: 文件名, uri: "file:///绝对路径"}`,文件夹的 `uri` 以 `/` 结尾。同一个 `uri` 只追加一次。结构化引用才是准的:路径里有空格时,文本里的 `@` 形式可能有歧义。

`resource_link` 和图片共用 32 块的上限;超了,多出的 `resource_link` 不发(文字里的 `@路径` 还在,agent 仍读得到路径),文字和图片不受影响。只有文字里还完整写着 `@路径`(前后是空白或标点,不是更长名字的开头)的提及才发。`resource_link` 怎么交给模型是 agent 适配的事:Claude 适配把它写成 XML 标签(见 [docs/adapters/claude.md](adapters/claude.md)),不是协议的一部分。

## 9. 权限请求与交互请求

agent 发来的 `session/request_permission` 和 `elicitation/create` 是**需要回答的请求**,必须能跨越客户端的断线和重连。

1. daemon 收到请求后先写入日志(占一个序号),再转发给所有附着的客户端,同时把 session 的状态置为 `requires_action`。
2. **第一个到达的响应生效**,daemon 把它转给 agent,并把响应写入日志(占一个序号)。随后给其他客户端发 `_cycle/request_resolved` 通知,带上 `requestId` 和被选中的结果,让它们关闭各自的对话框。后到的响应被丢弃,不报错。
3. 没有客户端附着时,请求保持挂起。新客户端附着时,daemon 在补发之后重新发送所有未解决的请求,并在 `session/resume` 的应答里用 `_meta["cycle/pending"]` 列出它们的 `requestId`。客户端断线前收到过、这里没有列出的请求,在它离线时已被别的客户端答复(或已中止),应关闭对应的对话框。旧 daemon 的应答没有这个字段:客户端不据此关闭任何东西。
4. 客户端收到 `session/cancel` 之后,按 ACP 的规定,所有未解决的权限请求必须以"已取消"的结果回复。这一步由 daemon 代为完成,不依赖客户端。
5. agent 进程退出时,未解决的请求在日志中标记为"已中止",并发 `_cycle/request_resolved`。

### elicitation(决策 0011)

`elicitation/create` 用上面同一套机制,差别只有这些:

- 只有在 `initialize` 里声明了 `elicitation.form` 的、已附着的客户端才会被问。请求的 `_meta["cycle/requestId"]` 和权限请求一样。
- 回答是 ACP 的 `{action: "accept" | "decline" | "cancel", content?}`;日志的 `response` 记录整个回答。
- **没有这样的客户端附着时立即回答**(最后一个有能力的客户端断开时,正在等的表单同样如此回答) `{action: "cancel", _meta: {"cycle/noClient": true}}`,不挂起。agent 据此回退:MCP 的 elicitation 当作拒绝,`AskUserQuestion` 走权限请求。
- **表单里填的内容不进日志,也不发给别的客户端**(可能是密码或令牌):agent 拿到完整的回答,日志的 `response` 记录和 `_cycle/request_resolved` 只有 `action`。客户端的回答只取 `action`(`accept`、`decline`、`cancel`)和 `accept` 时的 `content`;别的字段(包括客户端自己加的 `_meta`)丢掉,不是回答的当作 `cancel`。客户端处理不了表单(回了错误)时,和没有客户端一样回 `cycle/noClient`。
- `session/cancel`、agent 退出:未解决的 elicitation 以 `{action: "cancel"}` 结束,并发 `_cycle/request_resolved`。
- URL 模式 v1 不支持,daemon 不声明。
- **`AskUserQuestion` 的表单**:每个问题一个选择字段(`q0`,`q1`…:单选 `oneOf`、多选 `array`)和一个可选的自由输入字段(`q0_other`…,最多 2000 字符)。都没有 `required`:一个字段表达不了"二选一"。自由输入非空时,单选以它为答案,多选把它加在所选标签之后;全部为空等于没回答,工具得到"The user did not answer"。

### 子 agent

`subagent_update`(决策 0014)原样转给客户端:`sessionId` 是子的 id(不是可以打开的 session),`title`、`description`、`state`,以及 `_meta["cycle/subagent"]`:`toolCallId`、`background`、`parentId`、`summary`、`lastTool`、`usage`。只是通告:子 agent 的对话不转发,也不能对它发 `session/*` 请求。

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

可选值有两种写法。只有值:`enum`。值要带给人看的名字和说明:用 JSON Schema 的 `oneOf`,每项是 `{const, title, description?}`,`const` 是值(发给 agent、存进配置的就是它),`title` 是显示名,`description` 说明选了会怎样。agent 建议用的那一项带 `_meta: {"cycle/recommended": true}`,客户端在它旁边标"推荐";`default` 只说明不设时取哪个值，不代表推荐，两者可以不同。客户端两种都要认:`oneOf` 显示 `title`,并显示 `description`(选项列表里,以及当前选中的那一项);只有 `enum` 时显示值本身。同一个属性不要两种都写。列出的值默认就是全部可取的值:`_cycle/agent_defaults/set` 遇到不在其中的值返回 `-32014`,`data` 里有 `configId`、`value` 和 `allowed`(可取的值),什么都不保存。agent 还接受没列出的值时(例如模型可以写完整的模型名),在这个属性上带 `_meta: {"cycle/open": true}`,列表只是菜单,daemon 不拦。

```json
{
  "type": "string",
  "title": "Permission mode",
  "oneOf": [
    {
      "const": "auto",
      "title": "Auto",
      "description": "…",
      "_meta": { "cycle/recommended": true }
    },
    { "const": "default", "title": "Ask before acting", "description": "…" },
    { "const": "plan", "title": "Plan mode", "description": "…" }
  ],
  "default": "auto"
}
```

session 里 ACP 的 `configOptions` 用 ACP 自己的字段表达同样的东西:`SessionConfigSelectOption` 的 `name`、`description`,推荐项同样在它的 `_meta` 里带 `cycle/recommended`。agent 两边给的名字和说明应当一致。

能把 prompt 插入正在运行的 turn 的 agent 带 `steer: true`(§8 "插入"),没有就是不能。

每个 agent 还有 `promptCapabilities`(ACP 的 `PromptCapabilities`:`image`、`embeddedContext`,缺省都是没有),客户端据此决定是否提供附件入口,daemon 据此校验 prompt(§8)。Claude 的 `model` 用 `oneOf` 给出取值和名字(`default` 叫 "Default model",以及 `sonnet`、`opus`、`haiku`;值不变,0.2.7 之前是只有值的 `enum`,客户端两种都认),`mode` 是权限模式,取值就是 Claude Agent SDK 的 `PermissionMode`:`default`、`acceptEdits`、`plan`、`auto`、`dontAsk`、`bypassPermissions`,新 session 默认且推荐 `auto`,各自的名字和说明见 L3 文档。

agent 自己改了配置(例如 Claude 在 plan 模式里被批准后切回常规模式),通过 `config_option_update` 回报;daemon 把变化写进索引的 `config`,恢复时才不会把它改回去。

**标题**:agent 的 `session_info_update.title` 只在用户没有改过名的 session 上生效:`_cycle/session/set_title` 设置的标题优先,之后 agent 给的标题忽略。agent 给出的标题写入索引,`session/list` 的 `_meta.title` 反映它,并发 `_cycle/session_list_changed`。

### 默认配置

- `_cycle/agent_defaults/read`:参数 `{agent}`,返回该 agent 当前的默认配置。
- `_cycle/agent_defaults/set`:参数 `{agent, config}`,daemon 按 `configSchema` 校验后保存,并发 `_cycle/agent_defaults_changed` 通知。

新建 session 时,`cycle/config` 覆盖默认配置。daemon 把 agent 在 `session/new` 应答里报的各项当前值(`configOptions` 的 `currentValue`)也写进 session 的配置记录，再用设置的值覆盖:恢复时整份重发，所以 agent 以后改了新 session 的默认值，已有的 session 不跟着变。`session/new` 的应答里的 `configOptions` 是设置之后的值。恢复时,`session/resume` 应答里有而记录里没有的项(在记录初始值之前建的 session)按应答补记。客户端显示一个已有 session 的配置时,没有记录的项显示为"未设置",不套用 `configSchema` 的 `default`:那是给新 session 的。

恢复时某一项被 agent 拒绝(例如 agent 升级后不再有这个模型或模式),daemon 不把它留在记录里当作仍然生效:记录改为 agent 在 `session/resume` 应答里报的当前值(应答里也没有这项就去掉它),`session/list` 的 `cycle/config` 反映的是实际生效的值,并往该 session 的会话里写一条 `severity: "warning"` 的 `notice`,说明哪一项没有恢复、现在是什么。这发生在下一条 prompt 发出之前。

### session 级配置

session 运行中的配置变更使用 ACP 的 `session/set_config_option`,agent 通过 `config_option_update` 回报当前值。daemon 把最终生效的值写入 session 的配置记录,用于恢复。

### 环境变量

daemon 启动 agent 时只传入显式白名单里的环境变量,不继承自己的环境(AGENTS.md 红线)。白名单是 daemon 的配置,不通过协议修改。

## 11. 错误

沿用 JSON-RPC 2.0 和 ACP v2 的错误码。ACP 已占用:-32700、-32600 到 -32603、-32800(请求取消)、-32000(需要鉴权)、-32002(资源不存在)、-32022(不支持的协议版本)。

- session 不存在,或不属于 Cycle:用 ACP 的 `-32002`,`data` 用 ACP 的 `SessionNotFoundErrorData`。
- 协议版本不兼容:用 ACP 的 `-32022`。
- 其余是 Cycle 自己的,取 -32010 到 -32019,避开 ACP 已用的码:

| 码     | 名称                | 含义                                                              |
| ------ | ------------------- | ----------------------------------------------------------------- |
| -32010 | `session_busy`      | session 正在工作,不接受该操作                                     |
| -32011 | `agent_unavailable` | agent 不可用(未安装、启动失败)                                    |
| -32012 | `agent_exited`      | agent 进程在操作中退出                                            |
| -32013 | `resume_failed`     | agent 无法恢复该 session。历史仍可读,但不能继续对话               |
| -32014 | `invalid_config`    | 配置不符合 `configSchema`                                         |
| -32015 | `log_unavailable`   | 历史日志读写失败。写入失败后,该 session 的 prompt 都以它拒绝(§12) |
| -32016 | `not_queued`        | 要撤回的 prompt 不在队列里(已发出或已退回)                        |
| -32017 | `connector_failed`  | connector 的授权服务器拒绝、不可达(§14)                           |

ACP 以后可能占用这个范围里的码,所以 Cycle 的码在 schema 里集中定义,升级 ACP 时对照检查。

错误的 `data` 里带 `{sessionId?, detail?}`,`detail` 供人阅读,客户端不得解析它。

## 12. 日志格式(daemon 内部,但规定以保证可迁移)

每个 session 一个 JSONL 文件,一行一条记录,字段:

```json
{
  "seq": 12,
  "ts": "2026-11-18T04:00:00.000Z",
  "kind": "update",
  "data": { "sessionUpdate": "agent_message_chunk", "...": "..." }
}
```

`kind` 取值:

- `update`:agent 发来的 `session/update` 内容(daemon 合成的用户消息和 daemon 自己产生的 `_cycle/queue_update` 也是这一类)。
- `request`:agent 发来的需要回答的请求,`data` 含 `requestId`、`method`、`params`。
- `response`:对某个 `request` 的回答,`data` 含 `requestId` 和结果,以及回答来自哪个客户端。
- `aborted`:某个 `request` 被中止。
- 附件的字节(决策 0013):`update` 里 `image` 块的 `data` 和嵌入资源的 `blob`,base64 不小于 16 KiB 时不写进日志,而写在 `<数据目录>/blobs/<sessionId>/<sha256>`,日志里该字段为 `""`,所在对象的 `_meta["cycle/blob"]` 记 `{field, sha256, bytes}`。daemon 读日志时还原,客户端不会看到引用;文件丢了的那一块是 `data: ""` 加 `_meta["cycle/blobMissing"]: true`,其余照常。旧日志里内联的字节照常读。
- `meta`:daemon 自己的事件(session 创建、agent 启动和退出、配置变更)。

要求:

- 只追加。写入单行,崩溃留下的末尾半行在读取时丢弃。
- `seq` 严格递增且连续。读取时发现不连续视为日志损坏,以 `-32015` 报告,不静默跳过。
- 日志不包含已知的凭证。写入前过滤,过滤发生在 daemon 把记录交给存储的那一处;客户端收到的是日志写下的那份,所以磁盘、实时推送和重放看到的一样。给客户端的权限请求(它不经过日志)用同一个过滤。规则刻意收得窄,因为猜错会改掉用户自己历史里的内容:
  1. **键名**:`tool_call` / `tool_call_update` 和权限请求里的工具调用(`subject.toolCall`)中,键名表示秘密的值换成 `"[redacted]"`,不论嵌套多深。键名按小写、去掉 `_ - .` 和空格后比较,以 password、passwd、passphrase、secret、apikey、accesskey、privatekey、credential、authorization、cookie 结尾(可带复数 s),或以 token 结尾(单数:`inputTokens` 这类计数不算),或恰好是 auth、bearer、pwd、pin。`{name, value}` 形式的列表(环境变量),`name` 符合上面的规则时换掉 `value`。
  2. **字符串**:工具调用里的所有字符串(命令、输出、文件内容、标题),把确定是凭证的部分换掉:常见令牌形态(`sk-ant-`、`sk-`、GitHub、Slack、AWS、Google、JWT)、私钥块、`Bearer`/`Basic` 后面又长又带数字的串(`Basic configuration` 这类文字不动)、`://用户:密码@主机` 里的密码、等号两边没有空格的赋值(全大写的 `NAME_KEY=值`,即 `cat .env` 的输出;小写的 `token=值`,如查询串)、`--token=值` 这类命令行参数、文本里 JSON 的 `"password": "值"`。等号两边有空格的(`const API_KEY = x`)、`==` 是代码,不动。
  3. **不过滤**:用户和模型说的话(`user_message`、`agent_message_chunk` 等):它们分块到达,模式跨不过块;也是用户自己的话。表单(elicitation)的答案不进日志,见 §9。
     这是已知凭证的过滤,不是保证:没有固定形态、也不在带名字的键里的秘密(命令输出里的一串随机字符)认不出来。已经写下的历史不会被改写,回放时也不会补过滤:升级前的会话里原有的内容仍在盘上,也仍会回放给客户端。

session 索引是另一个文件,记录 sessionId、agent id、agent 侧 session id、`cwd`、归档标记、标题、创建时间,以及 `readSeq` 和 `attentionSeq`(§6"已读")。`lastSeq` 和 `updatedAt` 不存在索引里,以日志为准(`updatedAt` 取最后一条非 `meta` 记录的 `ts`),避免每条记录都改写索引。`attentionSeq` 在每条值得看的记录(通常每个 turn 一两条)后改写一次,`readSeq` 每次标记已读改写一次,都不是每条记录一次。daemon 打开 session 时,若 `readSeq` 或 `attentionSeq` 超过日志的 `lastSeq`(崩溃截掉了日志末尾的半行,之后的 seq 会重新分配),把它们压回 `lastSeq`。

从没有这两个字段的旧索引升级时,两个都按 0 算,所以旧 session 不是未读(升级不会让所有旧 session 变成未读);之后第一个值得看的记录才会让它变成未读。索引整体写入:先写临时文件再改名,崩溃后留下的是旧索引或新索引,不会是半个。索引存在但无法读取时 daemon 拒绝启动,不覆盖它(决策 0002)。

**写入失败。** 日志有一条写不进去(磁盘满、权限、存储故障)时,daemon 不当作没事:

- 这个 session 标记为历史不可写,到 daemon 重启为止(写了一半的行可能留在文件末尾,在同一进程里继续写会把新记录接在它后面;重启时打开日志会把它截掉)。
- 正在跑的 turn 被停止:daemon 向 agent 发 `session/cancel`,等着回答的权限请求和表单按取消回给 agent。
- 已附着的每个客户端收到一条不进日志、不带 `seq` 的 `state_update`:`state: "idle"`、`stopReason: "error"`、`error.code` 为 `-32015`。它走的不是日志(日志正是坏的),所以重放里没有它;之后才附着的客户端,打开时收到的 `state_update` 的 `_meta["cycle/historyFailed"]` 为 `true`,列表行里也有同一个字段。
- 之后的 `session/prompt` 以 `-32015` 拒绝,不启动 agent,不写任何东西。读取已有历史仍可用。
- 权限答复和表单答复在 `response` 记录写成功之后才交给 agent;写不成,agent 得到的是取消,不是客户端的答案。`request` 记录写不成时,请求没有给任何客户端看过,agent 同样得到取消。

同一个 session 同时被几个请求打开(比如两个客户端同时 `session/resume`)时,daemon 只加载一次,日志只有一个写入者;打开日志本身也是先占位再读文件,同一个 session 的第二次打开会被拒绝,打开失败会释放占位。

**读不了。** 日志里有损坏的整行(不是 JSON、不是记录、`seq` 不连续)时,这个 session 的读取以 `-32015` 失败,但只是这一个 session:`session/list` 仍列出所有 session,损坏的那个带 `cycle/historyFailed: true`(§6),其余照常打开、读取、写入。崩溃留下的末尾半行不算损坏,仍在打开时截掉。

日志的写入细节:打开时先把崩溃留下的末尾半行截掉,再追加,否则新记录会接在半行后面,损坏落在文件中间。写入按调用顺序逐条进行,保证序号和文件一致。

## 13. 待定

- 排队退回时,多个客户端附着:现在是**每个**附着的客户端都把 `returned` 放进自己那个 session 的输入框(桌面端是每个窗口的渲染进程各放一份;一个窗口里,重载页面不会再放第二次,按 `queueId` 去重)。两个窗口同时开着同一个 session 时,同一批消息会在两边都出现;要不要只让发出那条 prompt 的客户端接收,留到实际用起来再定。
- 排队的上限(8)和"只有 `end_turn` 才自动发下一条"是否合适。
- L3:Claude 适配需要产生哪些 `session/update` 变体,以及配置 schema 的具体字段。
- 日志过滤的规则能否让用户加自己的键名和模式;已有历史是否提供一次性清理。
- fork 时新 session 的 id 怎么分配(Claude SDK 允许 fork 时指定新 id,待验证)。
- 日志的压缩和滚动(上云时再定)。
- 云端 sandbox 下 daemon 与适配进程的连接方向(见决策 0001)。
- ACP v2 稳定后,`session/set_title`、`session/archive` 等 unstable 方法是否替换我们的 `_cycle/session/*`。
- `attentionSeq` 里"值得看"的记录是否还要包括用户取消的 turn(`stopReason: cancelled`)。现在按"都算",因为取消时用户通常在看,客户端会立刻标记已读。
- `cycle/background` 要不要在 daemon 重启后重建:agent 进程已不在,v1 不重建。
- connector(§14):loopback 回调的随机端口哪些授权服务器接受(没有在真实服务器上验证);agent 在云端 sandbox 时网关的地址;正在运行的 agent 要不要在 connector 变化后重启。
- 一个后台子 agent 一直不报 `idle`(agent 丢了终态通知)时,`cycle/background` 会一直不为 0,直到 agent 进程退出。v1 不另设超时:后台子 agent 本来就可以活过 turn,所以不能用 turn 结束去清。

## 14. Connector

connector 是 Cycle 自己管理的 MCP 服务器:在 Cycle 里加一次、授权一次,每个 agent 的每个 session 都能用,不需要在各个 agent 里分别配置。理由和取舍见决定笔记 [2026-11-19-connectors-behind-a-daemon-gateway](../.agents/notes/2026-11-19-connectors-behind-a-daemon-gateway.md)。能力 `connectors` 为 `true` 才有这些方法;旧 daemon 没有时,客户端不显示 connector 的入口。schema 在 `@cycle/protocol` 的 `connectors.ts`。

### 模型

```json
{
  "id": "3f0c…",
  "name": "linear",
  "enabled": true,
  "transport": { "type": "http", "url": "https://mcp.example.com/mcp" },
  "auth": { "type": "oauth" },
  "secrets": { "headers": ["X-Team"], "env": [] },
  "authorized": false,
  "status": { "state": "needs_auth" }
}
```

- `id`:daemon 分配的 UUID,不会变。`name`:交给 agent 时用的服务器名,`[a-z0-9_-]{1,32}`,在这台 daemon 的 connector 里唯一,可以改。
- `transport`:
  - `{type: "http", url}`:streamable HTTP。`url` 必须是 `https`;`http` 只允许 loopback 地址(否则 `insecure_url`)。
  - `{type: "stdio", command, args, cwd?}`:daemon 在自己的机器上启动的进程。`cwd` 是绝对路径;缺省时用 session 的 `cwd`。
- `auth`:`{type: "none"}`,或 `{type: "oauth", clientId?, scopes?}`(只用于 http,否则 `oauth_needs_http`)。按 MCP 的授权规范:protected resource metadata(RFC 9728)、authorization server metadata(RFC 8414)、动态注册(RFC 7591)、PKCE S256、resource 参数(RFC 8707);服务器什么元数据都没有时,退回它所在源的 `/authorize`、`/token`、`/register`。`clientId` 只在服务器不支持动态注册时由用户填(否则 `no_registration`)。
- `secrets`:用户填的密钥**的名字**。http 的 `headers` 加在每个发往服务器的请求上,stdio 的 `env` 是进程的环境变量。值只能写入,永不读出。`Host`、`Content-Type`、`Accept`、`Mcp-Session-Id` 这类由网关自己管的头不能设(`reserved_header`)。
- `authorized`:daemon 有没有这个 connector 的 token。
- `status.state`:`disabled`(关着)、`needs_auth`(oauth 没有 token,或 token 被拒、刷新也失败)、`error`(附带 `status.reason`:`unreachable`、`auth_failed`、`spawn_failed`、`protocol`)、`ready`。它是 daemon 最近一次知道的情况,不是实时探测;daemon 重启后从 `ready` 或 `needs_auth` 重新开始。

### 方法(客户端 → daemon)

| 方法                            | 参数                                                 | 响应                         |
| ------------------------------- | ---------------------------------------------------- | ---------------------------- |
| `_cycle/connectors/list`        | 无                                                   | `{connectors}`               |
| `_cycle/connectors/add`         | `{name, enabled?, transport, auth, secrets?}`        | `{connector}`                |
| `_cycle/connectors/update`      | `{id, name?, enabled?, transport?, auth?, secrets?}` | `{connector}`                |
| `_cycle/connectors/remove`      | `{id}`                                               | `{}`                         |
| `_cycle/connectors/auth/start`  | `{id, redirectUri}`                                  | `{flowId, authorizationUrl}` |
| `_cycle/connectors/auth/finish` | `{flowId, code?, state?, error?}`                    | `{connector}`                |
| `_cycle/connectors/auth/clear`  | `{id}`                                               | `{connector}`                |

- **密钥只进不出**:`secrets` 是 `{headers?: {名字: 值}, env?: {名字: 值}}`,只出现在 `add` 和 `update` 的参数里。没提到的名字保留原值,值为 `null` 表示删除。daemon 不在任何响应、通知、日志里回传密钥或 token。
- **换了地址或授权方式,旧 token 作废**:`update` 改了服务器的地址(stdio 是命令、参数、目录)、授权方式或 `clientId` 时(改名字、开关、scopes 不算),daemon 先尽力向授权服务器撤销,再删掉 token 和注册信息,不会把旧服务器的 token 发给新地址。用户填的 `secrets` 保留(是用户自己的决定)。
- **授权**:
  1. 客户端在**自己这一侧**开一个 loopback 回调(`http://127.0.0.1:<端口>/callback`),把它作为 `redirectUri` 调 `auth/start`。`redirectUri` 必须是 loopback 的 http。
  2. daemon 做发现、按需动态注册、生成 PKCE 和 `state`,返回 `authorizationUrl`。verifier 只在 daemon 的内存里。
  3. 客户端在系统浏览器里打开它,接到回调后把 `code`、`state`(或授权服务器给的 `error`)交给 `auth/finish`;daemon 校验 `state`,换 token,存进凭证库。
  4. 动态注册得到的 client 会被复用:回调只换了端口时算同一个(RFC 8252 §7.3),不重新注册。
  5. 一个 `flowId` 10 分钟内有效,只能用一次(错的 `state` 也会用掉它);同一个 connector 开新的流程,旧的作废;daemon 重启,流程都没了。
- `auth/clear` 尽力撤销并删掉 token 和注册信息。`remove` 同时删掉清单条目和全部凭证,客户端必须先向用户确认。
- 有变化(增删改、授权、状态变了)时,daemon 向每个连接发 `_cycle/connectors_changed`(无参数),客户端重新 `list`。

### 交给 agent(L2)

- daemon **每次启动 agent**(`session/new`,以及恢复时的 `session/resume`)时,把当时所有 `enabled` 的 connector 放进 L2 的 `mcpServers`,每个是一个 http 条目:`{type: "http", name, url: "http://127.0.0.1:<端口>/mcp/<connectorId>", headers: [{name: "Authorization", value: "Bearer <key>"}]}`。所以新加或打开的 connector,在 agent 下次启动时生效;正在运行的 agent 不变。
- 只给在 `initialize` 里声明了 `capabilities.session.mcp.http` 的 agent。session 自己的 `mcpServers`(§6)和 connector 重名时,session 自己的优先,那个 connector 不给这个 session。
- **key** 每次启动 agent 时新生成,只能访问这次给它的 connector,agent 退出就失效。它不是任何账号的 token。
- **网关**只绑 `127.0.0.1`,`Host` 必须是 `127.0.0.1:<端口>` 或 `localhost:<端口>`(否则 421),没有 key 是 401。请求头和响应头都按白名单转发:agent 的 `Authorization` 不发给服务器,服务器的 `WWW-Authenticate` 不回给 agent(否则 agent 会自己去登录)。不跟随重定向(它会把 token 带到别处)。服务器回 401 时,daemon 用 refresh token 刷新一次再重发;同一个 connector 同时只刷新一次;刷新得到的 token 只在凭证没被改过时写入,期间的退出登录或重新登录优先。还是不行就把它标成 `needs_auth`。
- **stdio** 的进程由 daemon 启动,每个 session 每个 connector 一个,在 agent 第一次用到时启动,agent 退出时结束。环境变量只有 `PATH`、`HOME`、`USER`、`LANG`、`LC_ALL`、`TMPDIR`(取自 daemon 的环境)加上它自己的 `secrets.env`;它的 stderr 丢弃(可能打印密钥)。网关把它当 streamable HTTP 提供:POST 写入消息、回复按 JSON 返回(agent 取消或放弃的请求不再等待);GET 是它主动发的消息的事件流;DELETE 结束它。改了它的环境变量值或关掉它,正在运行的进程随即结束。

### 错误

- `id` 或 `flowId` 不存在、已用过、已过期:`-32002`。
- 参数不合法:`-32602`,`data.reason` 是固定的词:`name_taken`、`insecure_url`、`oauth_needs_http`、`invalid_cwd`、`reserved_header`、`state_mismatch`、`no_registration`;名字格式不对是 schema 校验的 `-32602`。
- 授权服务器拒绝或不可达:`-32017`(`connector_failed`),`data.reason` 是 `auth_rejected` 或 `unreachable`,`detail` 只说状态码之类,不含 token。
