# 产品埋点(用户行为统计)

状态:已实现。验证日期 2026-11-19。决定的理由见 [`.agents/notes/2026-11-19-product-analytics-posthog.md`](../.agents/notes/2026-11-19-product-analytics-posthog.md)。

目的:知道 Cycle 的功能有没有人用、怎么用、哪里出问题,用来改产品。**只记录"做了什么",不记录"内容是什么"。**

## 它怎么工作

```
页面(渲染进程) ──track(事件, 属性)──▶ 主进程 app.ts ─┐
                                                      ├─▶ Analytics.track ──校验字典──▶ PostHog(posthog-node)
ConnectionManager(会话、环境、权限的动作) ────────────┘
```

- 事件在**主进程**发出,不在页面里、不在 daemon 里。页面只能报它自己才看得到的事件(`UI_EVENTS`),其余的页面伪造不了。daemon 不出网。
- `packages/analytics` 不依赖 Electron、文件和环境变量:`events.ts`(字典)、`client.ts`(校验、开关)、`posthog.ts`(唯一导入 `posthog-node` 的文件)。页面只能导入 `@cycle/analytics/events` 的类型,不能导入 PostHog(`scripts/boundaries.ts` 检查)。
- `apps/desktop/src/main/analytics.ts` 把它接到应用:匿名 id、开关的持久化、密钥从哪来。
- `track` 永远不抛错、不等待;网络断了不影响应用。退出时最多等 2 秒把没发的发出去。

## 隐私规则(红线)

1. **属性只能是数字、布尔,或一组固定的词。** 字典(`events.ts`)里没有 `z.string()`,有测试检查这一点。用户或 agent 写的任何文字(prompt、回复、路径、仓库名、标题、命令、报错信息、agent 的 id、配置值)都不能进属性。需要时把它换成一组词:`agentOf`(`claude` 或 `other`)、`settingOf`、`sizeOf`(`short`/`medium`/`long`)。
2. **字典里没有的事件、字典里没有的属性,一律丢弃。** `strictObject` 校验,多一个字段整条不发。
3. **匿名。** id 是首次启动随机生成、存在 `userData/analytics.json` 的 UUID,不是人名、机器名或账号。不建 person profile,不做 IP 定位,PostHog 的 autocapture、会话回放、异常自动收集都不开。
4. **用户说了算。** 默认开启。首次启动有一条说明(两个按钮都算回答,之后不再出现)。**回答之前什么都不发**:这段时间的事件只留在内存里,选"Keep on"才发出去,选"Turn off"就丢掉(也不发 `analytics_toggled`),不回答就退出的话随进程丢失;设置页(Settings → General)里随时可以开关。关闭时,最后发出一条 `analytics_toggled`,之后什么都不发。环境变量 `DO_NOT_TRACK=1` 或 `CYCLE_ANALYTICS=off`(开发者和 CI 用)直接关掉,界面里也不显示开关。决定见 [笔记](../.agents/notes/2026-11-19-analytics-opt-out-restored.md)。
5. **没有项目就不发。** 没有 PostHog key(从源码运行、测试、没配置的构建)时,什么都不创建、不发送,界面也不显示说明和开关。
6. **密钥不给 agent。** key 只在主进程;agent 的环境是白名单,不继承 `CYCLE_POSTHOG_KEY`。

## 配置

| 变量                              | 何时              | 作用                                                                                                            |
| --------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------- |
| (无,默认)                         | 构建(`package`)时 | 用 `apps/desktop/src/shared/posthog.ts` 里的项目 key 和美国区 host,写进 `build.json`。key 是公开的,只能写入事件 |
| `CYCLE_POSTHOG_KEY` / `…_HOST`    | 构建时            | 换成别的项目;`CYCLE_POSTHOG_KEY=`(空)造出不上报的构建                                                           |
| `CYCLE_POSTHOG_KEY` / `…_HOST`    | 运行时            | 覆盖构建里的值。从源码运行默认什么都不发,想看事件到没到就设它                                                   |
| `DO_NOT_TRACK`、`CYCLE_ANALYTICS` | 运行时            | 开发者和 CI 用:设了就什么都不发,界面里也不显示开关                                                              |

测试永远不设这些变量(打包出来的应用带着真的 key,所以启动它的集成测试要设 `CYCLE_ANALYTICS=off`,`packaged`、`update` 套件已经设了)。只有打包出来的安装版带项目 key,从源码运行和测试没有,所以不会把开发数据混进线上数据。

## 事件字典

每一行对应 `packages/analytics/src/events.ts` 里的一个事件(门禁检查两边一致)。公共属性:`app_version`、`platform`、`arch`,以及每次启动一个随机的 `$session_id`。

| 事件                     | 何时                                                                | 属性                                                                                                                                                                         | 发出处              |
| ------------------------ | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| `app_launched`           | 应用启动                                                            | `remote_environments` 个数,`first_run`                                                                                                                                       | `app.ts`            |
| `analytics_toggled`      | 用户开或关统计                                                      | `enabled`                                                                                                                                                                    | `analytics.ts`      |
| `update_checked`         | 用户手动检查更新                                                    | `result`:`available`/`up_to_date`/`error`/`disabled`                                                                                                                         | `app.ts`            |
| `update_install_started` | 用户开始安装更新                                                    | 无                                                                                                                                                                           | `app.ts`            |
| `theme_changed`          | 用户在设置页选了浅色、深色或跟随系统                                | `theme`:`system`/`light`/`dark`                                                                                                                                              | `preferences.ts`    |
| `language_changed`       | 用户在设置页选了界面语言                                            | `language`:`system`/`en-US`/`zh-CN`                                                                                                                                          | `preferences.ts`    |
| `environment_saved`      | 保存了一个远程环境                                                  | `transport`:`ssh`                                                                                                                                                            | `manager.ts`        |
| `environment_removed`    | 删除了一个环境                                                      | `kind`:`local`/`remote`                                                                                                                                                      | `manager.ts`        |
| `daemon_upgraded`        | 点了"升级",应用在远端环境上更新了 daemon                            | `ok`:是否成功(失败原因不报);`when`:`idle` 那边没有在工作的会话,`now` 有而选了立即中断,`later` 有而选了等它们结束再停                                                         | `manager.ts`        |
| `environment_connection` | 环境连上、断开重连、关闭                                            | `kind`,`state`:`connected`/`reconnecting`/`closed`                                                                                                                           | `manager.ts`        |
| `session_list_loaded`    | 环境首次完整载入会话列表需要多少页                                  | `pages`（正整数）                                                                                                                                                            | `manager.ts`        |
| `session_created`        | 新建会话                                                            | `agent`,`environment`,`configured`(是否改了设置)                                                                                                                             | `manager.ts`        |
| `session_opened`         | 打开(选中)会话                                                      | `agent`,`environment`                                                                                                                                                        | `manager.ts`        |
| `session_renamed`        | 重命名(就地改标题)                                                  | `where`:`header`(会话头部)/`sidebar`(侧栏的行)/`other`;标题是内容,不发                                                                                                       | `manager.ts`        |
| `queue_return_restored`  | 接收窗口已还原草稿，daemon 已记录确认                               | 无                                                                                                                                                                           | `manager.ts`        |
| `background_dismissed`   | 用户将状态未知的后台任务标记为已结束                                | `count` 清理数量                                                                                                                                                             | `manager.ts`        |
| `session_archived`       | 归档或取消归档                                                      | `archived`                                                                                                                                                                   | `manager.ts`        |
| `session_deleted`        | 删除(客户端已确认)                                                  | 无                                                                                                                                                                           | `manager.ts`        |
| `session_config_changed` | 改会话设置                                                          | `setting`:`mode`/`model`/`effort`/`other`(不发值)                                                                                                                            | `manager.ts`        |
| `agent_defaults_saved`   | 保存 agent 的默认设置                                               | `agent`                                                                                                                                                                      | `manager.ts`        |
| `session_attention`      | 会话完成、需要用户、停止                                            | `kind`:`finished`/`needs-you`/`stopped`                                                                                                                                      | `manager.ts`        |
| `prompt_sent`            | 发送消息                                                            | `agent`,`environment`,`size`(三档),`images` 数,`mentions` 数,`steered`(直接插入正在进行的回合),`via`:`enter`/`shortcut`(⌘Enter,工作中即排队)/`button`/`other`                | `manager.ts`        |
| `prompt_cancelled`       | 取消正在进行的回合                                                  | `agent`                                                                                                                                                                      | `manager.ts`        |
| `permission_answered`    | 回答权限请求                                                        | `outcome`:`allowed`/`rejected`/`cancelled`,`remembered`                                                                                                                      | `manager.ts`        |
| `form_answered`          | 回答 agent 的提问表单(AskUserQuestion、MCP 的表单)                  | `outcome`:`answered`/`declined`/`dismissed`                                                                                                                                  | `manager.ts`        |
| `connector_added`        | 添加了一个 connector                                                | `transport`:`http`/`stdio`,`auth`:`none`/`oauth`,`secrets` 个数(不发名字、URL、命令和密钥)                                                                                   | `manager.ts`        |
| `connector_changed`      | 开关或编辑了一个 connector                                          | `change`:`enabled`/`disabled`/`edited`                                                                                                                                       | `manager.ts`        |
| `connector_removed`      | 删除 connector(客户端已确认)                                        | `transport`                                                                                                                                                                  | `manager.ts`        |
| `connector_authorized`   | 在浏览器里登录 connector 结束                                       | `result`:`ok`/`failed`/`cancelled`                                                                                                                                           | `manager.ts`        |
| `connector_signed_out`   | 退出 connector 的登录                                               | 无                                                                                                                                                                           | `manager.ts`        |
| `panel_opened`           | 打开面板(搜索、新建会话、设置页、环境增改删、信任、connector 等)    | `panel`,`via`:`click`/`shortcut`                                                                                                                                             | 页面 `app.tsx`      |
| `sidebar_toggled`        | 展开或折叠侧栏                                                      | `open` 布尔值,`via`:`click`/`shortcut`                                                                                                                                       | 页面 `app.tsx`      |
| `settings_section_shown` | 在设置页里换到另一个分区(打开设置页是 `panel_opened` 的 `settings`) | `section`:`general`/`appearance`/`environments`/`defaults`/`shortcuts`                                                                                                       | 页面 `app.tsx`      |
| `side_panel_toggled`     | 打开或关闭右侧面板                                                  | `open` 布尔值,`via`:`click`/`shortcut`/`handle`/`tab_button`(头部的标签按钮,如 Overview),`tab`:`overview`/`files`/`diff`/`terminal`/`browser`                                | 页面 `app.tsx`      |
| `side_panel_tab_shown`   | 在右侧面板里换到另一个标签                                          | `tab`:同上                                                                                                                                                                   | 页面 `app.tsx`      |
| `overview_item_revealed` | 在 Overview 里点回对话中 todo 或后台任务开始的地方                  | `section`:`todo`/`background`                                                                                                                                                | 页面 `overview.tsx` |
| `tool_copied`            | 复制工具调用的命令或输出                                            | `part`:`command`/`output`                                                                                                                                                    | 页面 `tool.tsx`     |
| `tool_output_expanded`   | 把只显示末尾的输出展开成全部                                        | 无                                                                                                                                                                           | 页面 `tool.tsx`     |
| `plan_opened`            | 打开输入框上方的计划条                                              | 无                                                                                                                                                                           | 页面 `plan.tsx`     |
| `context_details_opened` | 点开输入框下方的 context 用量环,看详情                              | `state`:`measured`(有现在的用量)/`empty`(还没有用量)/`before_compaction`(用量是上次压缩之前的);`parts`:是否列出了窗口里各部分的占用;`plan`:是否显示了订阅的用量限额;不发数字 | 页面 `composer.tsx` |
| `tool_link_opened`       | 打开工具结果里的链接(网页搜索的结果),在确认之后                     | 无(不发地址)                                                                                                                                                                 | 页面 `tool.tsx`     |
| `message_link_opened`    | 打开 agent 消息里的链接,在确认之后                                  | 无(不发地址)                                                                                                                                                                 | 页面 `markdown.tsx` |
| `code_block_expanded`    | 把只显示一部分的长代码块展开                                        | 无(不发行数和语言)                                                                                                                                                           | 页面 `markdown.tsx` |
| `diagram_opened`         | 把 agent 回复里画出来的 mermaid 图表放大打开                        | 无(不发图表的种类和内容)                                                                                                                                                     | 页面 `diagram.tsx`  |
| `diagram_source_shown`   | 在画出来的图表上点 "Show source" 看源码                             | 无                                                                                                                                                                           | 页面 `diagram.tsx`  |
| `code_theme_changed`     | 换代码主题                                                          | 无                                                                                                                                                                           | 页面 `settings.tsx` |
| `slash_command_used`     | 从菜单选了斜杠命令                                                  | 无(命令名由 agent 给,不发)                                                                                                                                                   | 页面 `composer.tsx` |
| `turn_resend_opened`     | 在失败的回合尾点了"Send again",消息放回输入框                       | `failure`:`agent_exited`/`daemon_stopped`/`history`/`resume`/`agent_error`(按错误码,不发错误信息);`changed`:回合里已经跑过命令或改过文件、先提示过                           | 页面 `turn.tsx`     |
| `turn_resent`            | 放回的消息发出去了                                                  | `edited`:是否改过再发(不发内容)                                                                                                                                              | 页面 `store.ts`     |
| `blank_folder_chosen`    | 在新建会话的空白页上选了文件夹                                      | `via`:`recent`(有会话的文件夹)/`browse`(系统或 daemon 的文件夹浏览)/`typed`(输入路径);不发路径                                                                               | 页面 `blank.tsx`    |
| `blank_connect_pressed`  | 空白页的环境没连上，点了 Connect again                              | 无                                                                                                                                                                           | 页面 `blank.tsx`    |
| `blank_sent`             | 空白页的第一条消息发出                                              | `waited`:打开空白页到发出的时长,`under_10s`/`under_1m`/`under_5m`/`longer`                                                                                                   | 页面 `store.ts`     |

## 加新功能时怎么埋点

每个用户能感知的新功能或新操作都要有埋点,和功能一起提交。

1. 想清楚要回答的产品问题:"有人用吗"、"在哪一步放弃"、"失败率多少",而不是"能记什么记什么"。
2. 在 `events.ts` 的 `EVENTS` 里加事件,属性按上面的规则:数字、布尔、固定的词。需要新的词表就加一个枚举,并像 `agentOf` 那样写一个把原始值变成词的函数。
3. 在**主进程**能知道的地方发(通常是 `ConnectionManager` 里,动作成功之后)。只有页面才知道的(面板、主题、输入框里的选择),把事件名加进 `UI_EVENTS`,在页面里调 `store.track(...)`。
4. 在上面的表里加一行(门禁会检查字典里的每个事件都在这份文档里)。
5. 写测试:至少一条证明事件发出了,和一条证明内容没有跟着发出去(`apps/desktop/test/manager.test.ts` 里有例子)。
6. 属性里需要自由文字时:不要加。去问,再决定。

## 在 PostHog 里看什么

数据在 PostHog 项目的 Activity 里。常用的看法:

- **漏斗**:`app_launched` → `session_created` → `prompt_sent` → `session_attention`(`finished`),看新用户走到哪一步。
- **留存**:`prompt_sent` 的周留存。
- **功能使用**:`panel_opened` 按 `panel` 分,`permission_answered` 按 `outcome` 分。
- **稳定性**:`environment_connection` 里 `closed` 和 `reconnecting` 的占比,按 `kind` 分。
- **版本差异**:任何事件按 `app_version` 分。
