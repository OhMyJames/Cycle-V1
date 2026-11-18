# DESIGN.md

Cycle 界面的设计:**什么样子、为什么**。给人和 coding agent 读。怎么做事(流程、文案、检查)在
[`.claude/skills/cycle-design-taste`](.claude/skills/cycle-design-taste/SKILL.md);界面的各个状态在**状态画廊**里画出来
(`bun packages/ui/gallery/shoot.ts`,见末尾)。

> **状态:草案,等拍板。** 现在的界面是 ui-sdk 的默认外观加少量布局,没有设计。下面标"提议"的都是还没确认的决定;
> 第 11 节列出需要你定的 8 件事,每件带推荐。确认之前不改组件代码。确认后把"提议"改成"已定",再按它改。

## 1. 现状(画廊的截图所见)

2026-11-18,默认窗口 1200×800 与 760×600,浅色和深色,64 张。

**整体**:纯黑白灰,直角(`--ui-radius: 0`),一档字重,没有强调色,没有图标。一眼看去是未上色的线框。
这是 ui-sdk 默认外观的样子,不是有意的选择。

**具体的问题**(都能在画廊里复现):

| 场景               | 问题                                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| host-down          | "Not connected to this host." 和原因(ssh 原话)被隔在屏幕两端,读不成一句话;侧栏多出一个空的边框方块(空列表);输入框仍显示、Send 像可点 |
| 所有               | 会话状态(working、needs you)是 11px 的小字;"needs you"是最需要人响应的状态,却最不显眼                                                |
| 所有               | 当前选中的会话在侧栏里看不出来                                                                                                       |
| 所有               | "New session"是全屏最重的黑块,抢过了对话本身;一个视图里有多个同等分量的主按钮(Allow once、Allow always)                              |
| conversation       | 工具行是裸文本("Bash ls … completed"),没有图标、没有状态形状;失败只靠红字;计划没有勾选标记;思考是一个小三角                          |
| conversation       | 用户消息是灰块靠右,agent 回答铺满整行,长行宽(1000px 以上)难读                                                                        |
| permission         | 权限卡片在输入框上方,边框是 `--ui-ring`(浅色下对比度 1.29:1,几乎看不见);卡片和对话的视觉分量一样                                     |
| many-sessions @760 | 侧栏固定 18rem,窄窗口里主区被挤;头部的四个按钮占据一整行                                                                             |
| 所有               | 焦点环用 `--ui-ring`/`--ui-ring-border`:浅色下 1.29:1 和 2.68:1,都低于焦点指示要求的 3:1                                             |
| 深色               | 没有明显错误,但因为所有层都是灰,层次几乎靠边框维持                                                                                   |

没有出现:页面横向溢出(64 张均为 0)、控制台错误。

## 2. 视觉方向(提议)

**安静的工具。** 一个人每天开几小时,眼睛应该在 agent 的输出上。

- 中性色打底,**一个强调色**,只用来表示"这里可以操作"和"正在发生"。
- 状态用**形状加颜色加文字**,不只靠颜色。
- 层次靠**留白和细边框**,不靠阴影;只有浮层(菜单、对话框)有阴影。
- 小圆角,不圆润、不锋利。
- 没有渐变、毛玻璃、发光、装饰图案。唯一的装饰是应用图标。
- 对话是主角:内容区居中、限制行宽;侧栏和头部退后。

参照的感觉(用词描述,不抄):Linear 的克制、Zed 的密度、macOS 原生应用的安静。

## 3. 颜色(提议)

沿用 ui-sdk 的中性令牌(`--ui-background`、`--ui-foreground`、`--ui-muted`、`--ui-muted-foreground`、`--ui-border`、
`--ui-input`),它们已用 `light-dark()` 跟随系统。新增一组 `--cycle-*`,语义化命名,**组件只引用语义名**。

| 令牌                        | 用途                             | 浅色                   | 深色                 | 对比度(文字对背景) |
| --------------------------- | -------------------------------- | ---------------------- | -------------------- | ------------------ |
| `--cycle-accent`            | 主要操作、选中、焦点、"正在工作" | oklch(0.511 0.262 277) | oklch(0.68 0.19 277) | 6.44 / 6.41        |
| `--cycle-accent-foreground` | 强调色底上的文字                 | oklch(1 0 0)           | oklch(0.145 0 0)     | 6.44 / 6.41        |
| `--cycle-attention`         | "需要你"(等批准)、警告           | oklch(0.52 0.13 65)    | oklch(0.80 0.15 80)  | 5.69 / 10.44       |
| `--cycle-success`           | 已连接、完成                     | oklch(0.48 0.12 150)   | oklch(0.76 0.16 150) | 6.18 / 9.80        |
| `--ui-destructive`(沿用)    | 失败、断线、删除                 | 沿用                   | 沿用                 | 5.41 / 7.14        |

- 强调色取应用图标的靛蓝(`#4f46e5` 一带),让图标和界面是一家人。
- 上表每一对文字色都已核对 ≥ 4.5:1(WCAG AA)。沿用的 `--ui-muted-foreground` 在 `--ui-background` 上为 5.32(浅)/7.58(深),
  在 `--ui-muted` 上为 4.84/6.53,也合格。
- **焦点环用 `--cycle-accent`**,2px,偏移 2px。现有 `--ui-ring`(1.29:1)和 `--ui-ring-border`(2.68:1)都不够 3:1。
- 底色层次:`--ui-background`(内容)、`--ui-muted`(侧栏、代码、用户消息、工具行)、浮层用 `--ui-background` 加 `--ui-shadow`。
- **不新增别的颜色。** 要区分第四种状态时,先想能不能用形状或文字。

### 状态到颜色和形状

| 状态                      | 颜色                           | 形状(不依赖颜色)     | 文字            |
| ------------------------- | ------------------------------ | -------------------- | --------------- |
| 会话 working              | accent                         | 缓慢脉动的实心点     | "Working"       |
| 会话 needs you            | attention                      | 实心方块点,不脉动    | "Needs you"     |
| 会话 idle / stopped       | muted                          | 无                   | 无              |
| 连接 connected            | success                        | 实心点               | "Connected"     |
| 连接 reconnecting         | attention                      | 空心点               | "Reconnecting"  |
| 连接 closed / error       | destructive                    | 叉                   | "Not connected" |
| 工具 完成 / 失败 / 进行中 | success / destructive / accent | 勾 / 叉 / 转动的线   | 同名            |
| 计划 完成 / 进行中 / 待办 | muted / accent / foreground    | 勾框 / 半实框 / 空框 | 无              |

## 4. 字体(提议)

- **字体栈**:系统字体(`--ui-font-sans`,mac 上是 SF),等宽用 `--ui-font-mono`(SF Mono)。不加载网络字体,不打包字体(包已经 319 MB)。
- **字阶**,只有四档:

| 档    | 大小 | 行高 | 用在                                    |
| ----- | ---- | ---- | --------------------------------------- |
| meta  | 12px | 1.4  | 状态文字、用量、时间、路径              |
| ui    | 13px | 1.5  | 按钮、侧栏、表单、工具行(ui-sdk 的基准) |
| body  | 14px | 1.6  | 对话的正文                              |
| title | 16px | 1.3  | 会话标题、对话框标题                    |

- 字重只用 400、500、600:600 只给标题和"Needs you"。
- 等宽只给代码、命令、路径、id、ssh 原话。
- 数字用 `font-variant-numeric: tabular-nums`(用量、百分比、版本)。

## 5. 间距与布局(提议)

- **单位 4px**(`--ui-spacing`),间距只取 1、2、3、4、6、8 倍。现有的 `--cycle-gap: 0.75rem` 改为 3 倍(12px)并保留。
- **圆角**:`--ui-radius` 设为 6px(控件、卡片、气泡);代码块和表格 6px;不用更大的圆角。
- **窗口**:最小 720×480(BrowserWindow 的 `minWidth/minHeight`);默认 1200×800。
- **侧栏**:16rem(原 18rem);可拖动调宽(240–360px),记住宽度;窗口窄于 900px 时自动收起成可呼出的抽屉。
- **对话**:内容列最大 48rem(≈ 72 个字符),在主区内水平居中;用户消息靠右最大 80%,agent 消息占满内容列。
- **头部**:标题一行,路径和用量放在标题下方的 meta 行;操作按钮收进一个"…"菜单,只留 Settings 外露。
- **输入框**:固定在底部,与内容列同宽;断线或无会话时不显示,换成一行说明和下一步。

## 6. 组件(提议)

按 `data-slot`。只写和现状不同的地方;没写的保持现状。

- **host-bar**:主机选择加一个状态点(第 3 节);"Add host"、"Remove"、"Agent defaults"收进选择器旁的"…"菜单。
- **session row**:左侧状态点,标题一行省略,第二行 meta(路径末段、相对时间);选中行用 `--ui-muted` 底加 2px accent 左条;
  "Needs you"行加粗标题。归档的 60% 透明。
- **New session**:次要按钮(描边),放在侧栏顶部。**只有 Send 和权限卡的"Allow once"是 accent 实心按钮。**
- **message**:用户消息 `--ui-muted` 底、6px 圆角;agent 消息无底无边,直接排版。
- **tool row**:图标(按工具:Bash、Read、Edit…)+ 名称 + 等宽摘要 + 状态形状;展开后输入输出等宽,左侧竖线缩进。失败行加
  destructive 状态形状和"failed",输出默认展开。
- **thought**:默认折叠,一行 muted "Thinking",展开后 muted 文字,左侧竖线。
- **plan**:勾框列表(第 3 节),不用删除线表示完成,改用 muted 颜色加勾。
- **permission**:吸附在输入框上方,和对话分开:accent 的 2px 上边条、`--ui-background` 加浮层阴影;标题写"Bash wants to run",
  命令等宽、可滚动(最多 8 行);按钮顺序:Allow once(accent 实心)、Allow always(描边)、Deny(描边),Dismiss 放最右、文字按钮。
- **banner**(更新、daemon 版本、错误):一行,左侧图标,右侧一个主要动作和"Dismiss";更新用 accent,错误用 destructive,
  不用整行染色,只用左侧竖条和图标。
- **empty / loading / error 的屏**:图标、一句话、一个动作;错误的原因在同一块里,等宽,可选中。
- **对话框**:6px 圆角,浮层阴影,标题 16px;主要按钮在右,取消在左;首个输入自动聚焦;Esc 关闭并把焦点还回去。

## 7. 图标(提议)

iconmcp,线性,16 单位网格,1.5px 描边,`currentColor`,16px(控件内)和 20px(空状态)。集中在
`packages/ui/src/react/icons.tsx`。清单(需要时再加):new-session、host、settings、more、archive、trash、rename、send、stop、
chevron、check、x、warning、tool(按工具)、thought、plan。

## 8. 层次与深度(提议)

边框 1px `--ui-border`。浮层(菜单、对话框、权限卡)用 `--ui-shadow`。其余不用阴影。深色下浮层背景比内容层亮一档(`--ui-muted`),
因为深色里阴影看不见。

## 9. 窗口与桌面(提议,macOS 为主)

- 标题栏:`titleBarStyle: "hiddenInset"`,红绿灯留在侧栏顶部,头部整条可拖动(`-webkit-app-region: drag`,按钮区域 `no-drag`)。
- 文字可选中(消息、命令、错误),界面控件不可选中;控件的光标是默认箭头,只有链接是手形。
- 应用菜单:原生(Edit 菜单必须有,复制粘贴才工作);快捷键见第 10 节。
- 字体平滑用系统默认,不覆盖。
- 深浅色跟随系统;不做应用内的主题开关(v1)。

## 10. 键盘(提议)

| 键                  | 动作                          |
| ------------------- | ----------------------------- |
| ⌘N                  | 新会话                        |
| ⌘K                  | 搜索会话(下一步功能,先留位置) |
| ⌘[ / ⌘]             | 上一个 / 下一个会话           |
| ⌘L                  | 聚焦输入框                    |
| Esc                 | 关闭对话框;在输入框里不做事   |
| Enter / Shift+Enter | 发送 / 换行(已有)             |
| ⌘.                  | 停止当前回合                  |
| ⌘Return             | 在权限卡上 Allow once         |

快捷键写在对应控件的提示里。

## 11. 需要你定的事

每件事我给了推荐;不同意的直接说。

| #   | 决定         | 推荐                         | 备选                                   |
| --- | ------------ | ---------------------------- | -------------------------------------- |
| D1  | 强调色       | 靛蓝,和图标一致              | 中性(只用黑白,最安静);别的色相         |
| D2  | 圆角         | 6px                          | 保持直角(现状,更"工具味");10px(更圆润) |
| D3  | 状态点和图标 | 加,按第 3、7 节              | 只改文字和颜色,不加图标                |
| D4  | 侧栏         | 16rem、可拖动、窄窗口收起    | 固定宽度                               |
| D5  | 头部操作     | 收进"…"菜单,只留 Settings    | 保持四个按钮外露                       |
| D6  | 权限卡       | 吸附在输入框上方,和对话分开  | 留在对话流里                           |
| D7  | 标题栏       | hiddenInset,红绿灯在侧栏顶部 | 保持系统标题栏                         |
| D8  | 对话内容列   | 48rem 居中                   | 占满主区                               |

## 12. 状态画廊

```bash
bun packages/ui/gallery/shoot.ts                                  # 所有场景,浅色和深色,1200x800 和 760x600
bun packages/ui/gallery/shoot.ts permission --themes dark         # 指定场景和主题
bun packages/ui/gallery/shoot.ts --sizes 1200x800,720x480 --all   # 指定尺寸,列出每张
```

截图在 `packages/ui/gallery/shots/`(不进 git)。每张还会报告页面是否就绪、是否横向溢出、有没有控制台错误。
场景定义在 `packages/ui/gallery/scenarios.ts`:界面加了新状态,就加一个场景。在浏览器里直接看:
`bun packages/ui/gallery/build.ts` 后打开 `packages/ui/gallery/dist/index.html`(带 `?s=<场景>` 或 `?s=tokens`)。

| 场景                                                       | 看什么                                           |
| ---------------------------------------------------------- | ------------------------------------------------ |
| tokens                                                     | 令牌的真实值、字阶、间距、控件                   |
| empty, empty-conversation                                  | 空状态                                           |
| conversation                                               | 思考、三种工具状态、计划、表格、代码、列表、用量 |
| streaming                                                  | 流式中的半句话                                   |
| permission                                                 | 等待决定,命令很长                                |
| turn-error                                                 | 回合以错误结束                                   |
| host-down, host-reconnecting                               | 连不上(带原话)、重连中                           |
| many-sessions                                              | 800 个会话、长标题、各种状态                     |
| update-available, update-failed, daemon-old                | 三种横幅                                         |
| dialog-new-session, dialog-add-host, dialog-agent-defaults | 对话框                                           |
