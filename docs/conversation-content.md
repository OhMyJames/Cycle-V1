# 对话里的内容:从 SDK 到屏幕(CYCL-14)

对话里会出现的每一类内容,每一层叫什么、保留了什么,现在怎么画,打算怎么画。样式规则在 [DESIGN.md](../DESIGN.md) 第 16、22、23 节;
这里是**映射矩阵**,实现时以它为准,改了实现就改这里。

基线:Claude Agent SDK **0.3.327**(`packages/adapters/claude/package.json`),类型取自它的 `sdk.d.ts` 和 `sdk-tools.d.ts`。
"来源"一列:**类型** = 只见于 SDK 类型或文档;**测试** = 适配器或页面的测试里有;**样本** = 抓过真实会话(还没有,见文末)。

## 路径

```
SDK 消息(assistant / stream_event / user / system / result)
  → 适配器 TurnTranslator、aside(packages/adapters/claude/src)   ACP v2 的 session/update
  → daemon 写进 JSONL(脱敏,CYCL-7)、转给客户端                 L1 与 L2 同形
  → reducer(packages/ui/src/model/conversation.ts)             6 种 item:user agent thought tool plan notice
  → blocksOf(packages/ui/src/model/blocks.ts)                  布局块:user agent thought plan notice work failed end + 步骤行
  → React(packages/ui/src/react)
```

Claude SDK 的类型只在适配器里;页面读的是 ACP 的字段(`name`、`kind`、`status`、`rawInput`、`content`、`locations`)。
**结构化的结果**(`SDKUserMessage.tool_use_result`,每个工具一个 `*Output`,类型是 `unknown`)现在只用于 TaskCreate / TaskUpdate;
别的工具只有 `tool_result.content` 的文字到了页面(图片等非文字部分被丢掉)。

## 消息和事件

| SDK                                               | ACP 更新                           | item / 块            | 现在                                                                            | 打算                                                     | 来源 |
| ------------------------------------------------- | ---------------------------------- | -------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------- | ---- |
| user 的 prompt:text、image、resource_link(@ 提及) | `user_message`                     | user                 | 右侧气泡;图片缩略图;@ 提及的链接不再画(文字里已有 `@path`),别的链接显示它的名字 | —                                                        | 测试 |
| assistant text,流式 `text_delta`                  | `agent_message(_chunk)`            | agent                | Markdown                                                                        | —                                                        | 测试 |
| thinking,`thinking_delta`                         | `agent_thought(_chunk)`            | thought              | 默认不显示("Show thinking")                                                     | —                                                        | 测试 |
| `tool_use` / `tool_result`                        | `tool_call_update`                 | tool → work / failed | 见下一节                                                                        | 见下一节                                                 | 测试 |
| TodoWrite;TaskCreate / TaskUpdate 的结果          | `plan_update`(planId 固定 `tasks`) | plan                 | 勾框清单,整个会话一份,原地更新,**位置停在第一次出现处**                         | 当前计划在输入框上方一条;对话里只记"更新了计划 3/5"(PR4) | 测试 |
| `result`                                          | `state_update` idle + `stopReason` | end                  | 正常结束不显示;出错红框;停止等灰字                                              | —                                                        | 测试 |
| (推算)                                            | —                                  | 步骤行               | "Running a command …"                                                           | 计时要 daemon 记时间(协议,另做)                          | 测试 |
| `canUseTool`                                      | `session/request_permission`       | 权限卡(不是 item)    | 吸附在输入框上方                                                                | —                                                        | 测试 |
| AskUserQuestion                                   | `elicitation/create`(表单)         | —                    | **桌面端没声明能答表单,退化成权限卡:只能允许或拒绝,选不了选项**                 | 真正的表单(PR4)                                          | 测试 |
| `system/task_*`(子 agent)                         | `subagent_update`                  | —                    | **被 reducer 丢掉**                                                             | 挂在对应 Agent 工具行上:在做什么、结束(PR4)              | 测试 |
| `system/status` compacting                        | `compaction_update`                | —                    | **被丢掉**                                                                      | 一行"Compacting the context…" / "Context compacted"(PR4) | 测试 |
| daemon 自己的提示                                 | `notice`                           | notice               | 一行带图标                                                                      | —                                                        | 测试 |
| 用量                                              | `usage_update`                     | —                    | 输入框的用量环和花费                                                            | —                                                        | 测试 |
| 命令表、设置、会话信息、模式变化                  | `available_commands_update` 等     | —                    | 不进对话                                                                        | —                                                        | 测试 |
| 主 agent 在 turn 之外的输出(后台任务唤醒)         | **适配器丢掉**                     | —                    | 看不到                                                                          | CYCL-47                                                  | —    |

## 工具

每一行都是同一种行(DESIGN.md 第 22、23 节):行首一格状态,然后是**description**(agent 写的"在做什么",有就用它)或**动词**(按时态),
再跟淡灰的等宽摘要(命令、路径、模式、地址、查询);展开是输入和输出。"打算"列是各工具在通用行之外要加的东西。

| 工具                                                                         | 输入(R 必有)                                              | SDK 的结构化结果                                                                         | 现在:摘要 / 展开                                       | 打算                                                            | PR  |
| ---------------------------------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------- | --- |
| Bash                                                                         | command R、description、timeout、run_in_background        | stdout、stderr、interrupted、timedOutAfterMs、backgroundTaskId、returnCodeInterpretation | description 或 Ran + 命令 / 输入 JSON + 混在一起的输出 | 输出只显示尾部、可看全;stderr 分开;超时、被中断、转后台各说一句 | 3   |
| Monitor                                                                      | description R、timeout_ms R、command                      | taskId、timeoutMs、persistent                                                            | description / 通用                                     | 同 Bash 的后台                                                  | 3   |
| TaskStop                                                                     | task_id                                                   | message、task_type、command                                                              | 名字 / 通用                                            | "Stopped …" 一句                                                | 3   |
| Read                                                                         | file_path R、offset、limit、pages                         | text / image / notebook / pdf / parts                                                    | Read + 路径 / 全文                                     | 读了哪几行;图片带过来显示;全文不默认展开                        | 2   |
| Edit                                                                         | file_path R、old_string R、new_string R、replace_all      | structuredPatch、gitDiff                                                                 | Edited + 路径 / **old/new 的 JSON**                    | 这一次调用的增删行(ACP `diff` 内容),+N −M                       | 2   |
| Write                                                                        | file_path R、content R                                    | type create/update、structuredPatch                                                      | Edited + 路径 / **整个文件的 JSON**                    | 新建:行数;修改:增删行                                           | 2   |
| NotebookEdit                                                                 | notebook_path R、new_source R                             | old/new source                                                                           | Edited + 路径 / JSON                                   | 同 Edit                                                         | 2   |
| Glob                                                                         | pattern R、path                                           | filenames、numFiles、truncated                                                           | Searched + 模式 / 文件列表文字                         | "12 files";展开是列表                                           | 2   |
| Grep                                                                         | pattern R、path、glob、output_mode…                       | numFiles、numMatches、content                                                            | Searched + 模式 / 文字                                 | "34 matches in 5 files"                                         | 2   |
| WebFetch                                                                     | url R、prompt R                                           | code、bytes、result                                                                      | Fetched + 地址 / 文字                                  | 状态码;地址可点(经安全路径)                                     | 5   |
| WebSearch                                                                    | query R                                                   | results                                                                                  | Fetched + 查询 / 文字                                  | 结果列表(标题、域名)                                            | 5   |
| Agent                                                                        | description R、prompt R、subagent_type、run_in_background | completed / async_launched / remote_launched,用量、耗时                                  | description / prompt 和报告                            | 子 agent 的进度挂在这一行;转后台、结束                          | 4   |
| TodoWrite、TaskCreate、TaskUpdate、TaskGet、TaskList                         | todos / subject / taskId…                                 | old/new todos、task                                                                      | 名字 / JSON,另有 plan 清单                             | 不再单独成行,由计划表示                                         | 4   |
| EnterPlanMode / ExitPlanMode                                                 | — / allowedPrompts                                        | plan、planWasEdited                                                                      | 名字 / JSON                                            | 计划正文(Markdown),审批走权限卡                                 | 4   |
| AskUserQuestion                                                              | questions R                                               | answers                                                                                  | 名字 / JSON                                            | 表单;答过的显示问题和所选                                       | 4   |
| `mcp__<server>__<tool>`                                                      | 任意                                                      | 字符串、内容块数组或对象                                                                 | **很长的全名** / JSON                                  | 写成 "server · tool",摘要取输入里第一个短字符串;内容块按类型画  | 5   |
| 其余(Skill、Cron*、Workflow、*Worktree、PushNotification、ListMcpResources…) | —                                                         | 各自的 Output                                                                            | 名字 / JSON                                            | 通用回退:可读的名字、第一个短字段                               | 5   |

**哪些真的会出现**:SDK 的 `BUILTIN_TOOL_NAMES` 自己说不完整,一个会话实际有哪些工具,以 `system/init` 的 `tools` 为准。表里出现不等于本产品接通了。

## 长内容和复制(现状,打算改的在 PR2、3)

- 输入和输出各最多 20,000 字符,多出的写明字数;展开后的框最高 16rem,自己滚动。
- 复制:现在只能选中文字。打算:展开后的命令、输出、路径各有一个复制(PR3)。

## 还没做的盘点

- **样本**:没有抓真实会话。抓的方式:`CYCL_REAL_MODEL_TOKEN=… bun run test:real`(packages/adapters/claude),在隔离的目录里让 agent 各用一次上表的工具,
  把适配器收到的 SDK 消息(脱敏)存成测试夹具。每个 PR 开始前抓它负责的工具。
- **回放**:旧的 JSONL 没有结构化字段;新增的字段都是可缺的,缺了就是今天的样子。
