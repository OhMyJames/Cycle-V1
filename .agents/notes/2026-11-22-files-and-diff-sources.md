# Agent Note: Files 由 daemon 在 cwd 内只读；Diff 分两个视图：git 工作区对比 HEAD，和按轮次的工具编辑

Status: accepted
Date: 2026-11-22
Basis: 2026-11-22 用户在对话里把 CYCL-60(Files)和 CYCL-61(Diff)放在一起评估，选了"git 工作区对比 HEAD 加按轮次的工具编辑，快照暂缓"，以及"只在信任的文件夹里跑 git"。CYCL-93 要求先定基线再做视图。

## Problem

右侧面板要能浏览、预览 session 工作目录里的文件，并显示改动。两件事都要读 daemon 那台机器上的文件(远程时客户端看不到),都要守住"只在 cwd 内"。Diff 还要先回答"跟什么比":同一个词，"这个会话改了什么"和"工作区现在和提交的差多少"是两个问题，混成一个视图就说不清哪些改动是 agent 做的。而算 diff 最便宜的工具是 git,它会读仓库自己的配置，有几项能让 git 执行命令，这和信任文件夹要防的是同一类风险。

## Decision

**Files(`_cycle/fs/list`、`_cycle/fs/read`,协议见 docs/protocol.md §8)**

- daemon 读，客户端只看。路径一律相对 session 的 `cwd`,每次请求都重新取 `realpath` 核对仍在 `cwd` 的真实路径之内：`..`、绝对路径、NUL 都拒绝；符号链接列出来，指向 `cwd` 之内的能打开，指向外面或断了的只列不开。和 `@` 搜索同一套限制，抽成共用代码。
- 一次列一层(懒加载),不递归，所以不怕链接成环。`.git` 不列。
- 读文件有上限：文本按块读(每块最多 1 MiB,在 UTF-8 字符边界切),图片整张给(有上限),二进制只给大小不给内容。
- 被 git 忽略的条目标出来(界面上变淡),不藏；这要跑 git,所以只在信任的仓库里标：看的是仓库根目录(最近的 `.git` 所在)的信任，不是 `cwd` 的，并用 `GIT_CEILING_DIRECTORIES` 让 git 不再往上找。
- 不监听文件系统：一轮结束、编辑类工具完成时刷新，另有手动刷新。大仓库上监听的代价不值得。

**Diff 的两个视图**

1. **工作区**:git 仓库里，工作区(含暂存的、未暂存的、未跟踪的，不含被忽略的)对比 `HEAD`;还没有提交时对比空树。它说的是"现在要提交的是什么",包括 agent 之外的改动和开工前就没提交的改动，不归因给谁。由 daemon 算(CYCL-94),在客户端点开时取，不进日志。
2. **本会话的编辑**:日志里工具调用带的 ACP `diff` 内容，按轮次汇总，在客户端算，不需要新协议。界面明确写"只含 agent 通过文件工具做的编辑":Bash 里的 `sed`、格式化、代码生成不在内；日志里因太大没带 patch 的编辑，只给计数并说明。非 git 目录和不信任的文件夹也有这个视图。

**git 只在信任的文件夹里跑。** 判断的是仓库根目录：git 读的是仓库的配置，信任了仓库里的一个子文件夹不等于信任整个仓库。不信任或没决定的，Diff 只有"本会话的编辑",并说明为什么没有工作区视图、在哪里改信任；Files 不标忽略。信任的文件夹里也总是加固：`--no-ext-diff --no-textconv`、`-c core.fsmonitor=false`、`GIT_OPTIONAL_LOCKS=0`(不和 agent 抢 index 锁)、`GIT_TERMINAL_PROMPT=0`、不用 pager,环境变量按白名单给。

## Alternatives considered

- **每轮开始给工作区做快照(暂缓)**:能把 Bash 造成的改动也按轮次归因。但大仓库每轮都要把工作区哈希一遍；要么把对象写进用户的 `.git`(动了用户的仓库),要么维护一套单独的对象库(`GIT_OBJECT_DIRECTORY` 加 alternates),实现和清理都重。等真有人需要"命令的改动也按轮次看"再做，到时这份笔记换成新决定。
- **只有工作区视图**:非 git 目录就没有 Diff,也看不出 agent 这一轮改了什么，而这正是对话旁边最常问的问题。
- **所有文件夹都跑 git,只靠 `-c` 参数加固**:`core.fsmonitor`、外部 diff、textconv 能关，但 `.gitattributes` 指定、`.git/config` 定义的 clean filter 在 `status`/`diff` 时会被调用，没有一个开关能整体关掉。在不信任的文件夹里留着这条路不可接受。
- **客户端自己读文件**:远程 daemon 的文件客户端看不到，而且会绕开 daemon 的路径限制。

## Consequences

- 工作区视图看不出哪些改动是 agent 做的；需要归因时看"本会话的编辑",它看不到命令造成的改动。两个视图各自写明自己的范围。
- 不信任的文件夹没有工作区 diff,也没有忽略标记。
- 路径检查和真正读取之间有空档。读文件用一个句柄，打开后核对 `dev`/`ino` 和真实路径，能挡住换成链接；列文件夹没有按句柄读目录的办法，只在读前后各核对一次，挡不住"换过去又换回来"。能做到这一步的是在这台机器上执行命令的 agent,它本来就能读到这些文件，所以接受。
- `_cycle/fs/read` 把文件内容交给连上 daemon 的客户端。这不比现状多暴露什么：能连上 daemon 的人本来就能让 agent 在那台机器上执行命令；监听仍只在 loopback、unix socket 或 SSH 通道上。daemon 日志只记事件，不记路径和内容。
- 埋点只报行为和类别(打开了哪种预览、哪个视图),不报路径、文件名和内容。

## Related

- [right-panel-scope](2026-11-19-right-panel-scope.md)、[right-panel-layout](2026-11-21-right-panel-layout.md):面板的边界与布局。
- [folder-trust-is-cycles](2026-11-19-folder-trust-is-cycles.md):信任由 Cycle 记下，本笔记复用同一个决定来约束 git。
