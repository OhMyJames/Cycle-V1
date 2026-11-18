# Claude 适配

状态:草稿。验证日期 2026-11-18。

`packages/adapters/claude`:把 Claude Agent SDK 包装成 ACP v2 agent,通过 stdio 与 daemon 通信。决策见 [0001](../decisions/0001-claude-acp-adapter.md)。

验证所用版本:`@anthropic-ai/claude-agent-sdk` 0.3.327,`@agentclientprotocol/sdk` 2.7.0,Bun 1.4.4。验证用本地模拟的 Anthropic API,没有用真实模型。

## 启动与配置

- 入口 `src/main.ts`。所有配置通过环境变量 `CYCLE_ADAPTER_CONFIG`(JSON)传入:`{ env, claudeExecutable? }`。
- `env` 是 Claude 进程能看到的**全部**环境,不继承适配进程自己的环境。由 daemon 按白名单填。
- 凭证、`CLAUDE_CONFIG_DIR`、`ANTHROPIC_BASE_URL` 等都在这里。适配进程不读宿主机的 `~/.claude`。
- 不设 `claudeExecutable` 时用 SDK 自带的二进制,不依赖机器上装了 `claude`。

## 已做(v1 核心)

| 能力             | 状态 | 说明                                                                    |
| ---------------- | ---- | ----------------------------------------------------------------------- |
| `initialize`     | 做了 | 只声明最少的能力                                                        |
| `session/new`    | 做了 | 采用 daemon 通过 `_meta["cycle/sessionId"]` 提议的 UUID,否则自己生成    |
| `session/prompt` | 做了 | 立即返回 `messageId`,turn 在后台跑,以 idle 的 `state_update` 结束       |
| 流式消息与思考   | 做了 | `agent_message_chunk`、`agent_thought_chunk`                            |
| tool call        | 做了 | `tool_call_update`:pending、in_progress、completed 或 failed            |
| 权限审批         | 做了 | `canUseTool` 对应 `session/request_permission`,选项为允许一次和拒绝一次 |
| `session/cancel` | 做了 | 中断 SDK、取消待决的权限请求,以 `cancelled` 结束                        |
| `session/resume` | 做了 | 不重放(daemon 管历史);响应前先发状态快照                                |
| 权限模式配置     | 做了 | `session/set_config_option` 的 `mode`:default、acceptEdits、plan        |
| 模型配置         | 部分 | 能通过 `set_config_option` 设 `model`,但没有可选模型列表                |
| `session/close`  | 做了 |                                                                         |

## 未做(显式列出,不要悄悄补)

- 长驻 query:现在每个 turn 起一个 Claude 进程,首个 turn 用 `sessionId` 创建,之后用 `resume`。每个 turn 多一次启动,约 1 到 2 秒。映射验证通过后改成流式输入的长驻 query。
- `config_option_update` 通知:配置变更只在 `set_config_option` 的响应里返回,没有主动通知。
- `session/list`、`session/delete`:daemon 管理 session 列表和历史。
- 图片和资源类型的 prompt 内容:只取文本块。
- 子 agent 输出、`compaction`、`usage_update`、`plan_update`、`available_commands_update`、标题。
- MCP 服务器、系统提示、`additionalDirectories`:`session/new` 的这些参数目前被忽略。
- `bypassPermissions` 模式:有意不提供。
- `elicitation`、`terminal`。
- 凭证注入和真实模型的验证(需要登录或密钥,见下)。

## 验证结果

`bun run test:integration`(在 `packages/adapters/claude` 下)把适配器作为独立进程启动,走真实的 SDK 和它自带的 Claude 二进制,对本地模拟 API 说话。`bun test` 和提交门禁不运行它。

| 问题                                                         | 结果                                                                                                                                                                                                                         |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SDK 的 `query()` 能在 Bun 下运行,且这台机器上没有 `node` 吗? | 能。SDK 自带二进制,不需要 Claude 登录,也不需要 `claude` 在 PATH 上                                                                                                                                                           |
| daemon 提议的 sessionId 会被采用吗?                          | 会。`session/new` 返回同一个 id,第二个进程用它恢复                                                                                                                                                                           |
| **不带 `replayFrom` 恢复,上下文完整吗?**                     | **完整**。新进程、同一个 `CLAUDE_CONFIG_DIR`,恢复后发出的请求里包含第一个进程里的用户消息                                                                                                                                    |
| 适配器自己发 `user_message` 吗?                              | 发,用 `session/prompt` 返回的 `messageId`。所以 Claude 不需要 daemon 合成这一条(协议 §8)                                                                                                                                     |
| 权限请求                                                     | 触发 `session/request_permission`;允许后工具真的运行(文件被创建),拒绝后没有运行,tool call 为 failed                                                                                                                          |
| 取消                                                         | 模型正在流式输出时发 `session/cancel`:约 0.4 秒后以 idle、`stopReason: cancelled` 结束,模型之后才放出的剩余文本没有到达客户端。turn 在 prompt 一返回就存在,所以紧跟 prompt 的取消,或者紧跟的第二个 prompt(被拒绝),都不会漏掉 |
| resume 的状态快照                                            | 响应前收到一条 `state_update`                                                                                                                                                                                                |

## 观察到的行为

- Claude 对只读或安全的 Bash 命令(如 `echo`)不请求权限,所以测试用 `touch` 来触发审批。
- SDK 启动的 Claude 进程会在发给模型的用户消息里自己加 `<system-reminder>` 文本(比如 git 提交的署名说明)。这是 Claude Code 自己的行为,不是适配器加的。
- 取消时适配器无论 SDK 怎么结束都报 `cancelled`;"剩余文本没有到达"这条断言靠的是适配器不再转发,不能单独证明 Claude 进程已被终止(进程是否被终止没有断言)。

## 还没验证

- 真实模型:已验证,见文末。真实的登录流程(用户在专用的 `CLAUDE_CONFIG_DIR` 里 `claude login`)没验证,验证用的是显式传入的 OAuth token。
- 云端 sandbox:适配进程本身是自包含的(配置全部由外部传入),但没有在 sandbox 里实际跑过。
- 恢复时 `cwd` 变了的情况:Claude 的 transcript 按 cwd 存放,cwd 变了可能找不到。

## 真实模型验证(2026-11-18)

Claude Agent SDK 0.3.327,模型 haiku,账号的 OAuth token(`CLAUDE_CODE_OAUTH_TOKEN`),只在 Claude 进程的环境里。测试:`packages/adapters/claude` 下的 `bun run test:real`,`packages/daemon` 下的 `test:real`(见 [testing.md](../testing.md))。

| 问题                                     | 结果                                                                                                                                   |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 流式回答                                 | 通过。一个单词的回答用时约 3 秒,以 `end_turn` 结束                                                                                     |
| 权限请求                                 | 通过。真实的请求带着工具名和完整的 `rawInput`(命令和描述);允许后文件真的创建了;拒绝后没有创建,模型自己说明"被拒绝了,所以没有创建"      |
| 工具的状态序列                           | pending、in_progress,然后 completed(或 failed)。**结果那条更新不带 name 和 kind**,靠 toolCallId 补丁到已有条目(会话模型本来就这样处理) |
| 读文件                                   | 通过。`Read` 的结果是 `[{type:"content", content:{type:"text", text:"1\t…"}}]`,和模拟的形状一致,带行号                                 |
| 思考                                     | 出现 `agent_thought_chunk`(拒绝那次有 2 条)。界面里是折叠的"Thinking"                                                                  |
| 不带 replayFrom 的恢复,用真实 transcript | 通过。新进程、同一个 `CLAUDE_CONFIG_DIR`,模型记得文件里的词                                                                            |
| 模型输出中途取消                         | 通过。取消后约 0.5 秒结束,之后没有任何更新到达;之后的新 prompt 正常                                                                    |
| 通过 daemon,中间重启 daemon              | 通过。Claude 进程随 daemon 消失,只剩磁盘;历史从 JSONL 读回;再 prompt,Claude 恢复,模型记得口令                                          |
| 真实更新里有没有我们没处理的种类         | 没有。整段真实历史喂给界面的会话模型,`ignored` 为 0                                                                                    |

这次真实运行里没有出现的:`usage_update`、`plan_update`、`notice`、`compaction_update`、子 agent(适配器本来就没发)。图片、长输出、很长的会话没试过。
