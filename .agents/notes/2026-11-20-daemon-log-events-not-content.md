# Agent Note: daemon 的运行日志只记事件,不记内容

Status: accepted
Date: 2026-11-20
Basis: CYCL-103(daemon 日志文件,带轮转,不含敏感内容),2026-11-20 用户要求实现并合并

## Problem

daemon 在后台运行,原来只有 stdout/stderr 被接到 `daemon.log`:没有时间和级别,运行中不轮转,daemon 自己几乎什么都不记,远端出了问题没法查。加日志又有一个风险:日志比 session 历史更容易被拷走、贴进 issue,里面不能有 prompt、agent 的回答和凭证。

## Decision

- `<数据目录>/daemon.log` 由 daemon 自己写(`src/logger.ts`):一行一个事件,`时间 级别 事件名 key=value…`。0600,目录 0700,按大小轮转,保留有限个旧文件(默认 1 MB × 4)。
- **只记事件**:调用处只传事件名、id、计数、退出码、`stopReason`、错误码和错误信息,从不把 prompt、agent 消息、工具输入输出传进来。这是在调用处守住的规则,不是靠过滤兜底。
- 每个值仍过一遍历史用的凭证过滤 `redactText` 并截到 500 字符,防的是错误信息和 agent stderr 里偶然带出的凭证。
- agent 的 stderr 接进日志(过滤、截断、每个进程最多 200 行),它是诊断输出,不是对话。
- 没被捕获的异常写进日志(带调用栈)再退出;运行时自己在 daemon 代码之外的输出放在单独的 `daemon.out`。

## Alternatives considered

- **继续把 stdout/stderr 重定向到 `daemon.log`,只加启动时截断**:运行中不轮转,没有结构,也没有 daemon 自己的事件,查不了问题。
- **把 agent 的 stderr 直接丢掉**:Claude 适配器崩溃时的调用栈就没了,而它正是最需要的原因。

## Consequences

- 新加日志点时,只能传上面那类值;要记新的自由文字,先想清楚它是不是内容。
- `redactText` 只认已知形态的凭证;agent stderr 里没有固定形态的秘密认不出来,靠截断和行数上限限制范围。
- 日志里有路径(socket、调用栈里的源码位置、出错时的 `cwd`),它在本机、只有本人能读,不上报到任何地方;这和埋点"不报路径"的规则不冲突。
