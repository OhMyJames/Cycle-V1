# Agent Note: 用户级配置由 Cycle 托管、项目级照常加载;文件夹信任由 Cycle 决定,经适配交给 agent

Status: accepted
Date: 2026-11-19
Basis: 负责人 2026-11-19 的要求:"用户级的配置默认是 `~/.claude`,Cycle 托管到 `$cycle_home/claude`,项目级应该正常加载",并同意按下面的方案做。起因:项目的 `.mcp.json` 里的 plan 服务器(http,`headersHelper` 从 `.env` 取 key)在 Cycle 里一直显示"需要登录"。Claude 的 MCP 日志(`$CYCLE_HOME/claude/.cache/claude-cli-nodejs/<项目>/mcp-logs-plan/`)每次都写着 `headersHelper not run: this workspace has no persisted trust`;同一个 key 手动请求服务端返回 200。

## Problem

daemon 把 Claude 的 `CLAUDE_CONFIG_DIR` 和 `HOME` 设为 `$CYCLE_HOME/claude`,不把 `~/.claude` 里的登录和设置交给 agent(AGENTS.md 红线)。SDK 不传 `settingSources` 时加载全部来源,项目级的配置本来就照常加载;但"这个文件夹可以运行它自己的命令"这个信任,Claude 记在用户级的 `.claude.json` 里(`projects[路径].hasTrustDialogAccepted`),托管之后就没有了。SDK 里没有信任弹窗,也没有传信任的选项,于是项目配置里会执行命令的部分(`headersHelper`、hooks)在 Cycle 里永远不运行,也没有人看得到原因。

## Decision

- 用户级配置由 Cycle 托管(不变);项目级配置照常从 `cwd` 加载(不变,写进 `docs/adapters/claude.md`)。
- **信任是 Cycle 的决定**:daemon 在 `$CYCLE_HOME/trust.json` 记文件夹真实路径到 `true` / `false`,管到子文件夹,最近的决定生效。L1 用 `_cycle/trust/read`、`_cycle/trust/set`,能力 `trust`(protocol.md §8 "信任文件夹")。
- **daemon 不认识具体 agent**:它只在 L2 的 `session/new`、`session/resume` 的 `_meta["cycle/trusted"]` 里带上决定;怎么交给 agent 是适配的事。Claude 适配在启动 Claude 前把它写进 `$CLAUDE_CONFIG_DIR/.claude.json`。没有决定时不带,适配也不改,agent 保持原状。
- **客户端在新建 session 时问**:`cwd` 没有决定就问(信任并开始、不信任也开始、取消),不默认信任。workspace 菜单里可以改决定。改了之后 daemon 结束这个文件夹里空闲的 session 的 agent 进程,下一条 prompt 以新决定恢复。
- 状态:本笔记和协议、实现在同一个分支(`feat/workspace-trust`)里。

## Alternatives considered

- **默认信任每个 `cwd`**(Cycle 里选了文件夹就算信任)。最省事,但信任一旦给出,项目里的 hooks、stdio MCP、`headersHelper` 都会在 daemon 的机器上执行命令;克隆一个来路不明的仓库、在 Cycle 里开个 session 就会执行它的命令。AGENTS.md 的红线也是为这类风险定的("daemon 只绑 loopback……因为 agent 能执行命令")。
- **让用户把 `CLAUDE_CONFIG_DIR` 指回 `~/.claude`**(配置里已经能这样做)。这会把登录和全部用户级设置一起交出去,是另一个决定;只为信任这样做,范围太大。
- **适配自己记信任,daemon 不管。** 信任是"这个文件夹可以运行它的命令",不是 Claude 才有的概念,以后的 agent(如 Codex)也有;决定放在适配里,客户端就要认识具体 agent,换 agent 时决定也丢了。
- **把信任放进 session 的配置(`configSchema`)。** 信任属于文件夹,不属于某个 session:同一个文件夹里的 session 应当一致,改一次对所有 session 生效。
- **没有决定时写 `false`。** 当 `CLAUDE_CONFIG_DIR` 被有意指向 `~/.claude` 时,这会悄悄撤掉用户在命令行里给过的信任。所以只有明确的决定才写。

## Consequences

- 用户对每个新文件夹多一次确认;之后同一文件夹和其子文件夹不再问。
- Claude 进程自己也会改 `.claude.json`,和适配同时写时可能丢一方的改动;适配只在值不同时写,而且每次起 Claude 进程都按 daemon 的决定再写一次,所以丢了的改动在下一次启动时补回,但在那之前可能按旧值运行。Claude 有没有对这个文件加锁,没有验证。
- 不信任 `/work/x` 而信任 `/work` 时,Cycle 给 `/work/x` 写 `false`。2026-11-19 在 SDK 0.3.327 自带的 Claude 上验证:`projects` 里父目录是 `true`、子目录明确是 `false` 时,子目录的 `headersHelper` 不运行,明确的决定优先。
- 改了决定后,正在工作或正在启动的 session 的 agent 进程要等它空闲(turn 结束、后台子 agent 结束)才结束;在那之前它按旧决定运行。agent 进程被结束时日志里多一条 `agent_exited` 的 meta 记录(不发给客户端)。
- `claude mcp add --scope local` 加的 MCP 存在用户级 `.claude.json` 里,在 `~/.claude` 里加的,Cycle 看不到;要跟着项目走,写在 `.mcp.json` 里。

## Related

- [protocol.md §8 "信任文件夹"](../../docs/protocol.md)
- [docs/adapters/claude.md "启动与配置"](../../docs/adapters/claude.md)
