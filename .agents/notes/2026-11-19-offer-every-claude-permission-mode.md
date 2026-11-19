# Agent Note: Claude 的权限模式全部提供,默认并推荐 auto,值用 SDK 原名,名字和说明随协议下发

Status: accepted
Date: 2026-11-19
Basis: 用户 2026-11-19 的要求("全部提供";每个模式的说明"要在协议里面加出来,选项里面要展示";"auto 是 suggested 的,default 是 auto");当时的代码只提供 `default`、`acceptEdits`、`plan`,`docs/adapters/claude.md` 写着 `bypassPermissions`"有意不提供",但没有记录原因;SDK 0.3.327 的 `PermissionMode` 有六种。

## Problem

Claude Agent SDK 有六种权限模式(`default`、`acceptEdits`、`plan`、`auto`、`dontAsk`、`bypassPermissions`),Cycle 只给了三种。界面上的下拉框显示的是原始值(`acceptEdits`),用户看不出各模式的区别。`configSchema` 的 `enum` 也没法给每个值配名字和说明。

## Decision

- 六种全部提供,包括 `bypassPermissions`。这是用户明确的决定;之前"有意不提供"没有留下理由。
- 值保持 SDK 原名,不改名。用户提议把 `default` 改叫 `alwaysAsk`,没有采纳:值会存进 agent 默认配置和 session 索引,改名要做映射和迁移;而且 `default` 并不是"总是问",读文件不问,settings 里允许过的也不问。改的是显示名:"Ask before acting"。
- 新 session 默认 `auto`,并标为推荐:选项的 `_meta["cycle/recommended"]`(ACP 的 `configOptions` 和 `configSchema` 的 `oneOf` 两边都有),列表里排第一。推荐和 `default` 分开表达:`default` 只说明不设时取哪个值。
- 恢复一个没有记下 mode 的 session 时，适配器仍按 `default`。这类 session 是在 auto 成为默认之前建的，当时就是先问再做，恢复不能悄悄放宽成由模型判断。daemon 从这次起会把 `session/new` 应答里各项的当前值也记进 session 的配置，所以以后恢复的 session 按记下的值走，不受 agent 默认值变化的影响。更早的 session 在第一次恢复时，按 agent 的 resume 应答补记;在那之前，界面的 Session settings 显示 "Not set",不套用新 session 的默认值(code review 发现那里会把这些 session 显示成 Auto)。
- 名字和说明只写一处(`CLAUDE_PERMISSION_MODES`),ACP 的 `configOptions`(`name`、`description` 是 ACP 自带的字段)和 daemon 的 `configSchema` 都从它生成。
- `configSchema` 的可选值可以写成 JSON Schema 的 `oneOf: [{const, title, description}]`(写进 `docs/protocol.md` §10),客户端显示 `title`,并显示选项和当前值的 `description`;原来的纯 `enum` 仍然支持。
- 起进程时总是传 `allowDangerouslySkipPermissions: true`。这个标志只是允许进入该模式,不会打开它。只在模式是 bypass 时才传的话,运行中切到 bypass 会被 SDK 拒绝,进程就会被释放(决策 0007)。

## Alternatives considered

- 值改名为 `alwaysAsk`(用户提议):理由见上。
- 恢复时也按 `auto`:实现最简单，但会把旧 session 从"先问"悄悄改成"模型判断"。没有采纳。
- 只在 `mode === "bypassPermissions"` 时传 `allowDangerouslySkipPermissions`:更保守,但运行中切换会失败,进程被释放。没有采纳。
- 在 `x-` 自定义字段里放名字和说明,不用 `oneOf`/`const`:那是私有约定,`oneOf` 是 JSON Schema 自带的写法。没有采纳。

## Consequences

- `bypassPermissions` 下,agent 不经批准就编辑文件、执行命令,能动到 daemon 用户能访问的一切。说明里写了"Use only where Claude can do no harm, such as a sandbox"。界面目前没有额外的确认步骤,要不要加没有决定。
- `auto` 不是每个账号都有，现在又是默认值。在没有 auto 的账号上显式传它，SDK 会怎样没有验证过:如果是报错而不是退回 default,这些用户的新 session 都会失败。要先在真实账号上确认。
- 推荐的标记只有 Cycle 自己的客户端认识;别的客户端看到的只是普通选项。
- `dontAsk` 只有在 settings 里配了允许规则才有用,Cycle 目前不提供配置这些规则的界面。
- 说明文字是 agent 给的数据,不走界面的 `messages/en-US.ts`。

## Related

- [docs/protocol.md](../../docs/protocol.md) §10 的 `configSchema`
- [docs/adapters/claude.md](../../docs/adapters/claude.md) 的"权限模式"
- [决策 0007](../../docs/decisions/0007-resident-claude-process.md):配置发不出去就释放进程
