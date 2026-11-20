# Agent Note: daemon 停止时把进行中的 turn 记成"被打断",不续接;停之前用 session/list 问

Status: accepted
Date: 2026-11-20
Basis: CYCL-115(daemon 重启或升级时保护进行中的 turn),2026-11-20 用户要求实现并合并

## Problem

agent 是 daemon 的子进程,daemon 一停(`cycle stop`、升级、崩溃)进行中的 turn 就没了。之前历史停在"进行中",重连的客户端看不出发生了什么;从桌面端升级远端 daemon 时,命令末尾的 `cycle stop` 会直接中断正在工作的会话。

## Decision

- 被打断的 turn 在日志里写一条终态:`state_update` 为 `idle`、`stopReason: "error"`、`error.code` 为新的 `-32018`(`daemon_stopped`)。客户端按码识别,不解析文字。正常关闭时当场写;来不及写的(崩溃、`kill -9`、旧 daemon)在下一次加载 session 时补写。
- 索引新增 `turnOpen`,记日志里有没有没结束的 turn,让重启后只读需要核对的日志;旧索引没有它时各读一次日志。
- `cycle stop` 先问有没有会话在工作,问法是已有的 `session/list`(看 `cycle/state` 和 `cycle/background`),协议版本不同就按 daemon 说的版本再问。这样新的 `cycle` 能停旧 daemon,升级时正是这种情况。不在终端、没给 `--wait`/`--force` 时不停(退出码 4)。
- 桌面端升级时,有会话在工作就让人选"结束后再更新"(远端后台 `nohup cycle stop --wait`)或"立即中断"(`--force`)。

## Alternatives considered

- **重启后续接 agent 进程或重建后台任务**:agent 的状态在进程里,v1 做不到可靠续接;issue 明确不做。
- **新开一个 `_cycle/activity` 方法给 `cycle stop` 问**:旧 daemon 没有这个方法,升级时恰恰要停的是旧 daemon,所以用 `session/list`。
- **daemon 退出前给客户端发一条"要停了"的通知**:客户端断线重连后补发就能看到终态,另加通知要改协议又不解决崩溃的情况,没做。

## Consequences

- `-32018` 和 `turnOpen` 是持久格式:日志和索引里会长期存在,以后不能改含义。
- 后台子 agent 随 agent 进程结束,不写记录;它们不属于某个 turn。
- `--wait` 依赖 `cycle/background` 准确:agent 丢了终态通知时它会一直等(CYCL-114 处理)。
- `Daemon.activity()` 是同一个判断,留给空闲退出(CYCL-104)用。
