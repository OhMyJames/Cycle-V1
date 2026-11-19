# Agent Note: 新建打开的是空白对话,session 在首条消息发出时才创建;列表不显示没有消息的 session

Status: accepted
Date: 2026-11-19
Basis: 用户 2026-11-19 的要求:新建应打开一个 blank conversation 页面,第一条消息发送出去才算建立 session,这决定 sidebar 是否显示它;同日决定:客户端分两步(`session/new` 再 `session/prompt`)、空白页面上的 @ 加协议而不是禁用、空 session 由 daemon 处理。参考 old-cycle 的 `packages/ui/src/acp/conversation.ts`(`DraftSession`:"The agent hears of it at its first prompt")和它的 [2026-11-11 draft options 笔记](https://github.com/OhMyJames/old-cycle/blob/main/.agents/notes/2026-11-11-draft-options-from-the-adapter.md)。

## Problem

新建 session 是一个弹窗,点"创建"就发 `session/new`:daemon 写日志、写索引、启动 Claude 进程、通知列表变化。于是只是打开看看的新建也会在 sidebar 里留下一条空行,每次都启动一个 agent 进程,而清理空行又是要确认的删除。

## Decision

- **客户端**:新建打开一个空白对话(blank conversation),只存在客户端:环境、目录、agent、配置。配置项来自 `_cycle/agents/list` 的 `configSchema` 加 agent 默认值,不需要像 old-cycle 那样为预览单独开一个 agent 连接。首条消息发送时依次调 `session/new` 和 `session/prompt`;`session/new` 失败,消息回到空白对话的输入框;`session/prompt` 失败,打开已建好的 session,消息回到它的输入框。
- **daemon**:`session/list` 带 `_meta["cycle/onlyPrompted"]` 时只列出收到过用户消息的 session;新客户端总是带,旧客户端不带、照旧看到全部。索引里的 `prompted` 在 daemon 接下第一条 prompt 时置为 true(不等 agent 回显 `user_message`:agent 起不来或不回显时,session 也要能被看到和删除),并发 `_cycle/session_list_changed`;没有这个字段的旧条目在列表时读一次日志补上。没列出的 session 仍可 `session/resume`、`session/prompt`、删除。历史不可用(写不进去或读不了)的 session 照旧列出(否则没法删除它)。
- **@ 提及**:`_cycle/files/search` 可以用 `{cwd}` 代替 `{sessionId}`,能力 `filesInFolder` 声明;规则和按 session 搜一样,只在 `cwd` 内。

## Alternatives considered

- **daemon 在升级时删除空 session**:用户提出过。没有采用:红线规定删除 session 要客户端先确认;隐藏已经足够,空 session 只占一个很小的日志和一条索引。以后如需清理,做成需要确认的操作。
- **在客户端过滤空 session**:每个客户端都要自己判断,而且要读日志才知道有没有消息;放在 daemon 里所有客户端一致。
- **`session/new` 带上首条 prompt,daemon 一起处理**:更原子,但要改 `session/new` 的语义;两步之间失败只会留下一个不显示的空 session,可以接受。
- **空白对话上禁用 @**:用户否决。

## Consequences

- 首条消息要等 agent 启动(几秒),期间消息先显示在空白对话里,输入框不可用。
- `session/new` 成功到 `user_message` 写入之间,session 不在列表里;两步之间失败留下的空 session 不显示,但留在磁盘上。
- 旧客户端(弹窗直接建 session)连新 daemon:它不带标记,列表照旧,它靠在列表里找到刚建的 session 来打开它(代码评审发现:若一律隐藏,旧客户端打不开自己建的 session)。新客户端连旧 daemon:没有 `filesInFolder` 时空白对话不提供 @ 搜索;旧 daemon 的列表仍显示空 session。
- session 从发出第一条消息起才进列表,出现时往往已经在跑,甚至已经跑完。桌面端的通知因此改了两处:第一次之后新出现的 session 按"之前空闲(有未读则之前在跑)"比较;一直空闲、却变成未读的,也算"做完了"(很短的 turn 可能没有一次列表看到它在跑)。
- 斜杠命令来自 agent 启动后的 `available_commands_update`,空白对话上没有。

## Related

- [docs/protocol.md](../../docs/protocol.md) §6 列表、§8 提及
- [docs/desktop.md](../../docs/desktop.md)
- [Sidebar 的 workspace 与环境](2026-11-18-sidebar-workspace-environment.md)
