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
- **附件**(决策 0010):`session/prompt` 在启动 agent 之前按 agent 的 `promptCapabilities` 和上限(`PROMPT_LIMITS`)检查每一块,不合格整个拒绝(`-32602`,`data` 里有 `reason` 和 `index`);`_cycle/agents/list` 给出每个 agent 的 `promptCapabilities`;图片等进入日志的 `user_message`,补发时和文字一起到。
- **session 的启动参数**:`additionalDirectories`、`mcpServers`、`systemPrompt` 在 `session/new` 里校验(目录必须在 daemon 的机器上存在),存进索引,每次启动或恢复 agent 时重新发送。索引文件权限 0600,MCP 的 `env`/`headers` 只在这里,不进日志,也不在 `session/list` 里。
- **agent 自己的变化回写**:`config_option_update` 写进索引的 `config`(agent 重启后按它恢复,不会改回去);`session_info_update.title` 写进标题,但用户起的名字不被覆盖(索引里标了 `titleFromAgent` 的才是 agent 起的;没有标记的一律当作用户的,包括这个功能之前写下的)。
- **elicitation**(决策 0011):`elicitation/create` 和权限请求同一套机制(写日志、先到先得、`_cycle/request_resolved`、取消和 agent 退出时以 `cancel` 结束),但只发给在 `initialize` 里声明了 `elicitation.form` 的客户端;没有这样的客户端附着时立刻回 `{action:"cancel", _meta:{"cycle/noClient":true}}`,不挂起。
- **附件字节落盘**(决策 0013):`BlobLogStore` 包住日志存储,`append` 把大的 base64 写到 `<数据目录>/blobs/<sessionId>/` 并在日志里留引用,`read`、`subscribe` 还原;删除 session 时整个目录一起删。daemon 其余部分和客户端不知道有这回事。
- **用量**:`usage_update` 写进索引的 `usage`,`session/list` 的 `_meta["cycle/usage"]` 给出。
- **`_cycle/agent_defaults/*`**:读写都有实现,存在 `<数据目录>/agent-defaults.json`,新 session 按它开始,session 自己的配置覆盖它(此前这份文档误写成占位)。

## 没做

- **配置校验**:`cycle/config` 不按 `configSchema` 校验,直接交给 agent,由 agent 拒绝(映射为 `invalid_config`)。
- **合成 `user_message`**:协议 §8 写的"agent 不发时 daemon 合成"没有实现。Claude 自己会发,所以现在不需要;接入不发的 agent 时再做。
- **`session/list` 的分页和过滤**。
- **日志里的敏感字段过滤**。
- **一个 session 一个 agent 进程**:没有复用。
- **daemon 的打包和安装**:现在是 `bun apps/daemon/src/main.ts`;没有 `cycle` 可执行文件,也没有远端机器上的安装步骤。ssh 通道里的命令得由调用方写全。
- **daemon 退出时对客户端的通知**:客户端靠连接断开发现,然后重连。
- **多个 daemon 版本之间的升级**:daemon 重启会丢掉进行中的 turn(agent 是它的子进程),这一点没变。
- **空闲退出和 session 的内存回收**:已加载的 session 一直在内存里。
- **客户端先于 `initialize` 发请求的处理**:交给 SDK(返回 `-32600`)。

## 运行

```bash
bun apps/daemon/src/main.ts serve  [--data-dir <dir>] [--socket <path>]   # 前台运行
bun apps/daemon/src/main.ts proxy  [--data-dir <dir>] [--socket <path>]   # stdin/stdout 接到 socket;daemon 没在运行就先启动它
```

- 数据目录默认 `$CYCLE_HOME` 或 `~/.cycle`;socket 默认 `<数据目录>/daemon.sock`。
- `proxy` 启动的 daemon 是脱离的(`detached`),不随 ssh 连接结束,所以连接断了 session 照常运行。
- 同一个 socket 上只能有一个 daemon(`serve` 发现已有进程在监听就以退出码 3 退出);进程异常退出留下的 socket 文件会被清掉。
- daemon 在数据目录里写 `daemon.pid`。
- socket 权限 0600,所在目录 0700。这就是 v1 的全部访问控制(决策 0004)。

## 构建成一个可以拷走的目录

```bash
bun run --cwd apps/daemon build
```

产出 `apps/daemon/dist/cycle-<os>-<arch>/`(和同名 `.tar.gz`,约 220 MB):

- `cycle`:daemon 本身,一个可执行文件(`bun build --compile`,约 110 MB,里面带着 Bun 和 Claude 适配)。
- `claude`:Claude Code 的二进制(约 370 MB,取自 SDK 的平台包),放在它旁边,适配通过 `claudeExecutable` 找到它。

机器上不需要 Bun、Node,也不需要装 `claude`。适配器作为同一个可执行文件的子命令(`cycle adapter claude`)运行,所以只有这一个文件加 `claude`。

```bash
cycle status   # 在运行返回 0,不在运行返回 1
cycle stop     # 发 SIGTERM,等 socket 关闭
cycle login    # 为这个 daemon 登录 Claude(跑 claude auth login),在 daemon 所在的机器上执行
cycle claude auth status   # 用同样的环境跑 claude 的其他命令
```

**登录**:`login` 和 `claude` 用的环境和目录,正是 daemon 给它启动的 Claude 的那份(`config.json` 里的 `configDir`,默认 `<数据目录>/claude`;`HOME` 回落到它),所以登录落在 Claude 以后会去找的地方,不会碰 `~/.claude`。全新的数据目录里 `claude auth status` 报 `loggedIn: false`(已验证)。**登录流程本身没有验证过**:它要在浏览器里完成 OAuth,我没法替你做。验证过的做法是把 OAuth token 或 API key 写进 `config.json` 的 `claude.env`。构建目录里缺 `claude` 时,`agents/list` 里 Claude 是 `available: false`,不是等到第一个 prompt 才失败。

**装到远端机器**:解开 tarball,把目录放到 `$PATH` 上(或在桌面端 "Add host" 里把命令写成绝对路径,如 `/opt/cycle/cycle proxy`)。`<os>-<arch>` 要和那台机器一致:在哪个平台构建就产出哪个平台的;跨平台要在对应平台构建。凭证写进那台机器上的 `<数据目录>/config.json`(见下)。

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
- `CYCLE_DAEMON_BIN=<构建出的 cycle> bun run test:integration`(在 `apps/daemon` 下)把同一个端到端测试换成跑构建出的可执行文件,通过。
- `CYCLE_REAL_MODEL_TOKEN=… bun run test:real`(在 `apps/daemon` 下,先 `build`):只用构建出的可执行文件、**空的环境**(PATH 只有 `/usr/bin:/bin`,没有 bun、node、token,token 只写在 `config.json` 里),经 `proxy` 起 daemon,真实模型一轮带权限审批,再 `status`、`stop`。通过,约 7 秒。
- `bun run test:integration`(在 `apps/daemon` 下):**整个后端**。客户端用 `CycleClient` 经过 ssh(用一个在本机执行命令的替身)连上;没有 daemon 在运行,`proxy` 把它启动起来;daemon 启动 Claude 适配进程,跑真实 SDK,对本地模拟 API。一个 turn 之后客户端断开,daemon 仍在运行且 pid 不变;新客户端再连上,拿到历史,继续对话,模型的请求里有前一个 turn 的上下文。
- `packages/transport` 和 `packages/client` 的测试在门禁里:8MB 的消息、500 条消息保序、socket 权限、单实例、残留 socket、桥接、ssh 参数;客户端断线重连不丢不重、断线时错过的内容回来后补上、断线时挂起的权限请求在重连后重新问、`start` 失败、`close` 后不再重试。
- 一个由测试发现的问题:agent 恢复时发的状态快照曾被当作历史记进日志,客户端会把它当成 turn 结束。现在丢弃,并有测试(把修复去掉,测试会失败)。
