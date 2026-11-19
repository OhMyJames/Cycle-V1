# DESIGN.md

Cycle 界面的设计系统：**这个应用长什么样、为什么**，作为界面实现的**单一事实源**。给人和 coding agent 读。

> **结构说明（2026-11-19 重整）**：本文按五层设计工程体系组织：**1. 色彩体系 → 2. 样式与材质体系 → 3. 组件体系 → 4. 设计范式 → 5. 语义决策体系**，后附状态画廊、代码配色、i18n 与实现追踪。
>
> - 执行流程、检查清单与自检脚本见 [`.claude/skills/cycle-design-taste`](.claude/skills/cycle-design-taste/SKILL.md)。
> - 控件工程边界与无障碍底线见 [`packages/ui/AGENTS.md`](packages/ui/AGENTS.md)。
> - 核心交互的背景取舍见 `.agents/notes/` 与 `docs/decisions/`。

## 定位与原则

**安静的工具。** 一个人每天开几个小时：盯着 agent 干活、批准它的操作、回看它做了什么。用户的注意力应该在 agent 正在做的事上；界面本身不该被注意到，除非它出了问题——那时它要立刻说清楚出了什么问题、下一步能做什么。

- 中性色打底，**一个强调色**，只用来表示“这里可以操作”和“正在发生”。
- 状态用**形状 + 颜色 + 文字**，不单独依赖颜色。
- 层次靠**留白、表面明度差和细边框**，只有浮层（菜单、浮出列表、权限吸附卡、对话框）带阴影。
- 小圆角、同心嵌套，不圆润、不锋利。
- 没有渐变（应用图标除外）、毛玻璃、发光、装饰图案。
- 对话是主角：内容列居中、限制行宽；侧栏与头部退后。
- 参照感觉：Linear 的克制、Zed 的密度、macOS 原生应用的安静。

---

## 第 1 层：色彩体系（Color Tokens）

全部颜色用 `light-dark()` 跟随系统深浅色，不做应用内主题开关（v1）。组件只引用语义名（`--cycle-*` 与重映射后的 `--ui-*`），不写散落十六进制值。

### 1.1 中性表面、边框与文字（暖灰）

取自 old-cycle 的设计系统 v0.8 并按对比度重核。`app.css` 中将 ui-sdk 的中性令牌映射到它们（`--ui-background` → workspace、`--ui-muted` → message、`--ui-foreground` → ink、`--ui-muted-foreground` → ink-muted、`--ui-border` → border-default）。

| 令牌                        | 用途                                                          | 浅色      | 深色      |
| --------------------------- | ------------------------------------------------------------- | --------- | --------- |
| `--cycle-surface-workspace` | 对话和主区底色                                                | `#fcfcfb` | `#161615` |
| `--cycle-surface-sidebar`   | 侧栏和窗口底色                                                | `#f7f7f5` | `#121211` |
| `--cycle-surface-raised`    | 浮层与卡片底色（菜单、权限卡、代码/表格卡片、输入框、对话框） | `#ffffff` | `#1c1b1a` |
| `--cycle-surface-message`   | 用户气泡、行内代码与下沉填充块（`--ui-muted`）                | `#f2f1ee` | `#262523` |
| `--cycle-surface-hover`     | 行和控件的悬停                                                | `#f0efec` | `#2a2927` |
| `--cycle-surface-selected`  | 选中和按下（选中的会话行等）                                  | `#e8e7e3` | `#33312e` |
| `--cycle-border-subtle`     | 列表、卡片内部行与行的轻分隔                                  | `#efeeeb` | `#2a2927` |
| `--cycle-border-default`    | 卡片、浮层、分隔线（`--ui-border`）                           | `#e5e4e0` | `#34322f` |
| `--cycle-ink`               | 正文、标题                                                    | `#1c1b1a` | `#f2f1ee` |
| `--cycle-ink-secondary`     | 标签、侧栏平时行、图标                                        | `#4f4c48` | `#c4c1bb` |
| `--cycle-ink-muted`         | 元信息、时间、路径、占位（`--ui-muted-foreground`）           | `#6a6660` | `#9d9992` |
| `--cycle-ink-disabled`      | 仅用于禁用控件，不承载关键信息                                | `#8b8780` | `#787570` |

对比度底线：

- **四档文字**：浅色下对 workspace 为 `16.8 / 8.3 / 5.6 / 3.5:1`；深色下为 `16.0 / 10.1 / 6.4 / 4.0:1`。
- **`ink-muted` 在所有表面上 ≥ 4.5:1**（包括选中行：浅色 4.61、深色 4.57）。
- **控件边框不用 `border-default`**：`border-default` 对 workspace 仅 1.24:1，只做分隔；输入控件边界用 `--cycle-input-border`（未聚焦时深浅色下均 ≥ 3:1）。

### 1.2 强调色与功能色

| 令牌                        | 用途                                    | 浅色                                            | 深色                   | 对比度（字对底） |
| --------------------------- | --------------------------------------- | ----------------------------------------------- | ---------------------- | ---------------- |
| `--cycle-accent`            | 主要操作、选中焦点、正在工作            | `oklch(0.511 0.262 277)`                        | `oklch(0.68 0.19 277)` | 6.44 / 6.41      |
| `--cycle-accent-foreground` | 强调色底上的文字                        | `oklch(1 0 0)`                                  | `oklch(0.145 0 0)`     | 6.44 / 6.41      |
| `--cycle-attention`         | 等待批准（Needs you）、警告、高风险提示 | `oklch(0.52 0.13 65)`                           | `oklch(0.80 0.15 80)`  | 5.69 / 10.44     |
| `--cycle-success`           | 已连接、完成                            | `oklch(0.48 0.12 150)`                          | `oklch(0.76 0.16 150)` | 6.18 / 9.80      |
| `--ui-destructive`（沿用）  | 失败、断线、不可逆删除                  | 沿用 ui-sdk                                     | 沿用 ui-sdk            | 5.41 / 7.14      |
| `--cycle-input-border`      | 输入框等需要可识别边界的控件边框        | 80% `--ui-muted-foreground` + `--ui-background` | 同左                   | ≥ 3:1            |

约束：

- **不新增色相**。区分第四种状态时，优先使用形状或文字。
- **功能色柔化填充**：出错块（如回合失败 `turn-end`）采用 `8%` 功能色底 + `40%` 功能色描边（`color-mix`），不把整块涂成实色块。
- **焦点环**：统一为 `2px solid var(--cycle-accent)` + `2px` 偏移（侧栏列表内部行用 `-2px` 内偏移避免被滚动容器裁切）。ui-sdk 默认的 `--ui-ring`（浅色下仅 1.29:1）禁止用于焦点指示。

---

## 第 2 层：样式与材质体系（Style & Surface Tokens）

### 2.1 排版（Typography）

- **字体栈**：系统无衬线字体（`--ui-font-sans`）；等宽字体（`--ui-font-mono`）**仅用于代码、命令、路径、id、ssh 错误原话**。不加载网络字体，不打包字体。
- **中文 PingFang 字重映射**：PingFang SC 为固定字重档，`420` 会落到 Medium 导致中文全粗。`app.css` 用 `Cycle PingFang`（4 个 `@font-face` + `local()`）把 Light/Regular/Medium/Semibold 映射到 1–349 / 350–449 / 450–549 / 550+，排在 `PingFang SC` 前面。
- **字阶（仅四档，根字号 16px）**：

| 档位    | 大小令牌             | 行高令牌                | 真实值             | 用在                                    |
| ------- | -------------------- | ----------------------- | ------------------ | --------------------------------------- |
| `meta`  | `--cycle-text-meta`  | `--cycle-leading-meta`  | 12px / 1.5 (18px)  | 状态文字、用量、按键提示、路径、时间    |
| `ui`    | `--cycle-text-ui`    | `--cycle-leading-ui`    | 13px / 1.54 (20px) | 按钮、侧栏、表单、工具行（ui-sdk 基准） |
| `body`  | `--cycle-text-body`  | `--cycle-leading-body`  | 14px / 1.57 (22px) | 对话正文、输入框正文                    |
| `title` | `--cycle-text-title` | `--cycle-leading-title` | 16px / 1.5 (24px)  | 对话框标题、大区块标题                  |

- **字重与数字**：常规字重为 `--cycle-weight`（浅色 `420`，深色 `400`，避免浅字在深底显粗）；其余仅用 `500` 和 `600`（`600` 仅用于标题、`Needs you` / `Unread` 加重）。灰字保持常规字重。数字（用量、百分比、版本、价格）用 `tabular-nums`。

### 2.2 间距、尺度与同心圆角

- **间距**：4px 网格（`--ui-spacing`），间距只取 1、2、3、4、6、8 倍；基本间距 `--cycle-gap` 为 `0.75rem`（12px），turn 之间 `--cycle-gap-turn` 为 `2rem`（32px）。
- **内容列**：对话、权限区、输入框、空白页条件区共用同一条居中列宽：`--cycle-measure`（`48rem`，约 72 字符），水平内边距由 `--cycle-column-pad` 算出。
- **圆角（五档同心，内圆角 = 外圆角 − 内边距）**：
  - `--cycle-radius-sm`（`4px`）：徽标、计划勾框、行内代码、按键胶囊、缩略图
  - `--ui-radius`（`8px`）：控件、按钮、侧栏行、菜单项、输入框控件、工具展开块
  - `--cycle-radius-card`（`12px`）：菜单、下拉列表、工具/代码/表格/连接器卡片、权限卡
  - `--cycle-radius-message`（`16px`）：用户消息气泡、对话框
  - `--cycle-radius-composer`（`20px`）：主输入框外框（`padding: 12px` 内嵌 `8px` 控件）

### 2.3 阴影、遮罩与动效令牌

- **阴影与遮罩**：`--cycle-shadow-popover`（菜单、权限卡、候选列表）、`--cycle-shadow-dialog`（对话框、搜索面板）、`--cycle-scrim`（模态遮罩）。深色模式下阴影更深，并配合更亮一档的 `surface-raised` 区分层次。
- **长文末尾淡出**：`--cycle-fade-end`（末尾 `1.5rem` 线性透明遮罩），通过滚动驱动动画只在实际溢出时触发，`prefers-reduced-motion` 下仍保持静态显示。
- **动效（三档时长 + 统一曲线）**：
  - 曲线：`--cycle-ease`（`cubic-bezier(0.2, 0.8, 0.2, 1)`）
  - `--cycle-motion-state`（`100ms`）：悬停底色、按钮/操作显隐
  - `--cycle-motion-disclosure`（`160ms`）：展开/收起箭头旋转与面板过渡
  - `--cycle-motion-enter`（`200ms`）：浮层、横幅、对话框进入
  - `prefers-reduced-motion: reduce` 下所有过渡与动画静止（除 `--cycle-fade-end`）。

### 2.4 材质样式整合（Surface Styles）

所有界面容器必须归属于以下六种预设材质之一，不再在局部各自组合边框与阴影：

| 材质名             | 底色                                  | 边框                                               | 圆角                             | 阴影                     | 适用对象                                                |
| ------------------ | ------------------------------------- | -------------------------------------------------- | -------------------------------- | ------------------------ | ------------------------------------------------------- |
| `Surface/Base`     | `workspace` / `sidebar`               | 无                                                 | 0                                | 无                       | 主区、侧栏背景                                          |
| `Surface/Ghost`    | 透明（悬停 `hover`，选中 `selected`） | 无                                                 | 8px (`--ui-radius`)              | 无                       | 侧栏行、动作行、工具单行/折叠头、设置芯片               |
| `Surface/Sunken`   | `surface-message`                     | 用户气泡用 `border-default`，内嵌块无边            | 4 / 8 / 16px                     | 无                       | 用户消息气泡、工具输入输出、行内代码、按键胶囊          |
| `Surface/Card`     | `surface-raised`                      | `1px border-default`                               | 12px (`--cycle-radius-card`)     | 无                       | 代码块卡片、表格卡片、连接器列表                        |
| `Surface/Popover`  | `surface-raised`                      | `1px border-default`（权限卡顶边 3px `attention`） | 12px (`--cycle-radius-card`)     | `--cycle-shadow-popover` | 下拉菜单、`Select` 列表、`PickerMenu`、`PermissionCard` |
| `Surface/Dialog`   | `surface-raised`                      | `1px border-default`                               | 16px (`--cycle-radius-message`)  | `--cycle-shadow-dialog`  | 模态对话框、确认框、`⌘K` 搜索面板                       |
| `Surface/Composer` | `surface-raised`                      | `1px --cycle-input-border`                         | 20px (`--cycle-radius-composer`) | 无                       | 主输入框整块                                            |

---

## 第 3 层：组件体系（Components & Variants）

基础控件优先使用 `@ui-sdk/react` 并映射为 Cycle 样式；业务通用件收口在 `packages/ui/src/react/`。**注意 ui-sdk 坑点**：`Collapsible`、`Command` 等会覆盖传给它的 `data-slot`，写样式优先用 `data-kind` 或 `data-palette`。

| 组件                     | 来源                                               | 允许变体 / 状态                                                                                          | 映射材质与规则                                                                                                                                                                                                                                                                                 |
| ------------------------ | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Button`                 | `@ui-sdk/react/button`                             | `solid`、`destructive`、`outline`、`ghost`、`data-kind="round"`、`data-kind="queue"`                     | `solid` 用 `--cycle-accent`；破坏性操作用 `destructive`（`--ui-destructive`）；`outline` 为默认描边按钮；`ghost` 无底无边（`Surface/Ghost`）                                                                                                                                                   |
| `Banner`                 | 自建（`app.tsx` / `update.tsx` / `analytics.tsx`） | `data-severity="info" \| "warning" \| "error"`                                                           | 全宽底栏 + `3px` 左侧语义竖条 + 16px 图标 + 单句事实 + 至多 1 个操作按钮 + `Dismiss`                                                                                                                                                                                                           |
| `StatusDot` & `Badge`    | 自建（`status.tsx` / `workspace-switcher.tsx`）    | 点：`solid`、`pulse`、`square`、`ring`、`cross`；角标：`needs-you` / `running` / `background` / `unread` | 颜色 + 形状双通道：Working=accent 脉动圆点，Needs you=attention 实心方块，Background=accent 空心环，Unread=accent 实心圆点，Connected=success 圆点，Reconnecting=attention 空心环，Not connected=danger 叉                                                                                     |
| `SettingChip`            | 自建（`setting-chips.tsx`）                        | 正常、`data-unset`（`Not set`）、危险权限态（如免确认）                                                  | `Surface/Ghost`，点击弹出单选 `Menu`（带说明与 `Recommended` / `Caution` 标）；危险模式用 `--cycle-attention` 警示；带轻微下拉箭头线索避免误认为静态文本                                                                                                                                       |
| `ToolRow` & `WorkCard`   | 自建（`tool.tsx` / `turn.tsx`）                    | `pending` / `in_progress` / `completed` / `failed` / `cancelled`                                         | 单次调用为 `ToolRow`；连续两次以上聚合为 `WorkCard`（垂直细线串联子行）；左边一列只放状态（完成为 5px `--cycle-ink-disabled` 灰点、在跑为转圈、失败为红叉，**不用工具图标**）；失败行整行红色并写明 `failed`、默认展开；展开区的命令 / 输出 / 错误各为一块 `Surface/Sunken`，带小标题与 `Copy` |
| `Plan` & `PlanStrip`     | 自建（`plan.tsx`）                                 | `pending` / `in_progress` / `completed`                                                                  | 勾框列表（空框 / 半实框 / 绿色勾框），不用删除线；对话里是一行 `Plan · 1 of 3 done`（排成工具行，点开是列表）；有未完成项时输入框上方一条 `Surface/Card` 细条 `1/3 + 正在做的那项`，全部完成即消失                                                                                             |
| `FormCard`               | 自建（`form.tsx`）                                 | `disabled`、必填未填、含画不了的必填字段                                                                 | 与 `PermissionCard` 同位同材质，**顶边 3px 用 `accent`**（是提问，不是警示）；问题：大写淡色小标题 + 加粗问题 + 整行可点的选项（圆点单选 / 方框多选，选中为 accent 边 + 8% 底）+ 一行 `Other`；问题区卡内滚动，`Answer`（`solid`）/ `Skip`（`outline`）/ `Dismiss`（`ghost`）固定在底          |
| `PermissionCard`         | 自建（`permission.tsx`）                           | `disabled`                                                                                               | `Surface/Popover` + 3px 顶部 `attention` 边条；标题 + 可滚动等宽命令区（最多 8 行）+ `Allow once`（`solid`，标出快捷键）+ 其他 `outline` + 最右 `ghost` `Dismiss`                                                                                                                              |
| `Dialog` / `AlertDialog` | `@ui-sdk/react` + `dialogs.tsx`                    | 表单弹窗 / 信息弹窗 / 破坏性确认弹窗                                                                     | `Surface/Dialog` + `--cycle-scrim`；非破坏性支持 Esc 关闭并将焦点还回触发源                                                                                                                                                                                                                    |
| `Icons`                  | `icons.tsx`（iconmcp 线性 16 单位网格）            | `size` 16（控件内）/ 20（空状态），`1.5px` 描边，`currentColor`                                          | 集中维护，禁止内联 SVG；仅图标按钮必须配 `aria-label` 与 `title`                                                                                                                                                                                                                               |

---

## 第 4 层：设计范式（Patterns）

新增功能或调整页面时，必须优先套用以下最小任务范式，不在局部另起交互逻辑：

### 4.1 窗口与侧栏导航范式

- **窗口尺寸**：默认 `1200×800`，最小 `720×480`。
- **macOS 标题栏**：`titleBarStyle: "hiddenInset"`，红绿灯位于侧栏左上角；侧栏折叠时主区头部自动留出左侧避让（`5.5rem`）且可拖动。
- **侧栏三段结构**（默认 `256px`，可拖动 `200–360px` 并记忆，`⌘B` 或按钮折叠）：
  - **顶段（固定）**：`New session`（`⌘N`）与 `Search sessions`（`⌘K`）`ghost` 行、`Connectors` 入口、紧贴列表的 `WorkspaceSwitcher` + 环境 `"…"` 菜单；如有断线/重连环境，在此展示两行状态块（状态点+名称+`Retry` / 最多三行原因）。
  - **中段（独立滚动，保底 `10rem`）**：当前选中 workspace 的会话列表，分组顺序固定为 **`Needs you` → `Running` → `Today` → `Yesterday` → `Earlier`**（本地日界线，按 `updatedAt` 排序）；每项目默认展示 20 条（有状态标记或当前打开的永远展示），底部附 `Show N more sessions`（切换 workspace/环境时重置）与 `Show archived`。窗口极矮时改为整栏滚动，确保底部不裁切。
  - **底段（固定）**：当前版本号、更新状态、与 `App settings` 菜单（`Code colours`、`Usage statistics` 开关、`Check for updates`）。
- **折叠恢复**：主区头部必须提供 `SidebarIcon` 开关按钮（或对应入口），确保折叠后无需快捷键也能用鼠标打开侧栏。

### 4.2 会话切换与工作区范式

- **一次一个 workspace**：一个 workspace = `(environmentId, cwd)`。Switcher 按环境分组（本机在前，仅一个环境时不显示分组头），远程环境带 `ServerIcon` 与可访问名称；同名目录在不同环境或同环境多级重名时自动补全前缀/环境名区分。
- **跨区提醒**：Switcher 右侧方块角标显示**其他 workspace** 中最紧急一类的计数（优先级：`needs-you > running > background > unread`），完整分布写入 `aria-label`。
- **断线态**：断线环境的会话列表灰显并附 tooltip 说明原因；已打开过有缓存的会话仍可阅读并编辑草稿（断线横幅提示“重连后恢复”），无法新开未读会话。

### 4.3 新建空白会话与文件夹信任范式

- **先写后建**：点击 `New session` 打开居中的 `BlankConversationView`，直到发出第一条消息才依次调用 `session/new` 与 `session/prompt`，未发出前不污染侧栏。
- **草稿保留**：空白页草稿使用独立持久键（`BLANK_KEY`），切换环境或目录时不丢失已输入文字；若创建 session 失败，消息退回空白框并保留焦点；若 session 已建好但发送失败，打开该 session 并把消息退回该 session 的草稿框。
- **文件夹信任前置**：发出首条消息前，若目标目录未做过信任决定且 daemon 支持 `trust` 能力，阻塞弹出 `Trust this folder?`（展示真实路径与风险说明），提供 `Back` / `Start without trusting` / `Trust and start`。

### 4.4 对话阅读、流式输出与输入范式

- **头部**：固定 `42px` 一行，无底线，左侧会话标题（`13px / 500`）+ 等宽路径（路径优先保留末尾项目名），右侧 `"…"` 菜单（`Rename` / `Show thinking` / `Archive` / `Delete`）。
- **Turn 切块与对话内容规则（CYCL-14，详见 [docs/conversation-content.md](docs/conversation-content.md)）**：
  - 按 daemon 日志的 `stopReason` 切分 turn（`--cycle-gap-turn` 隔开问题起止）；思考默认折叠隐藏，不打断连续工具流；未正常结束的 turn 拎出末尾失败工具并附原因块（`turn-end`）。
  - **工具行不用图标，左列只放状态**：完成为 5px 灰点（`--cycle-ink-disabled`，纯装饰，读屏给状态词），在跑为旋转线，失败为红叉；一段调用展开后细竖线串联各点。
  - **有 `description` 优先展示**：Bash / Monitor / Agent 的单行短说明（≤ 160 字）用正文字体居前，后跟淡灰等宽命令/路径，放不下时先让摘要再让说明并在末尾淡出；没有时用“动词 + 摘要”。StepLine 与进行中卡片同步遵循。
  - **`@` 提及不画两遍**：用户消息中带 `cycle/mention` 的 `resource_link` 当正文中仍含 `@path` 时不重复渲染；其余链接渲染为 `[名字]`。
  - **文件工具（Edit / Write / Read / Glob / Grep）**：按 ACP `diff` 与 `_meta["cycle/toolResult"]`（协议 §9）渲染、不硬编码工具名——Edit 仅显示本次调用的增删计数（`+2 −1`，新建为 `Created +N`），展开显示带行号与浅绿/浅红底的 diff（省去首段 `@@`，段间 `⋯`，上限 400 行，不再重复输入 JSON，过大或空文件给出明确提示）；Read 写出行范围/总行数（含读取图片直接展示）；Glob/Grep 写出文件数与匹配数/行数（截断时带 `+`）；输入中仅含行上已显示的字段时展开不再重复。
  - **命令（Bash / Monitor）**：行上只在没照常跑完时多写一句（`interrupted`、`exited with code 2`、`ran past 2 min, now in the background`、`in the background`）；有退出码含义（`returnCodeInterpretation`）时显示模型看到的原文。展开为三块：命令（不再是输入 JSON）、输出、错误（另一块，标题为红；来自 `_meta["cycle/stream"]: "stderr"`），各带 `Copy`（经 main 的 `copyText`，页面无剪贴板权限，失败不显示 `Copied`）。长输出只显示末 40 行，上方 `Show N earlier lines`；超过 20,000 字时保留末尾。
  - **子 agent 挂在它的 Agent 行上**：只在调用本身未结束时转圈（转到后台的之后不转，只写文字：它的结束可能永远不来），写 `in the background · using Grep`；结束写 `done · 4 steps · 1m 3s`，失败为红字。
  - **压缩上下文是一行**（同 notice）：`Compacting the context…` → `Context compacted`。
  - **计划**：见第 3 层 `Plan & PlanStrip`；改计划的调用（ACP `kind` 为 `think`：TodoWrite、TaskCreate、TaskUpdate）不成行，进行中也不，失败的照常；只读计划的（TaskGet、TaskList）照常成行。提出的计划（输入有 `plan`，如 ExitPlanMode）动词为 `Proposed a plan`，展开为 Markdown 正文；提问（输入有 `questions`）动词为 `Asked`，摘要为问题。均按输入的形状判断，不看工具名。
  - **工具折叠状态保持**：连续工具调用从 1 个变为 2 个以上时保留用户已手动展开的状态；展开态下的长输入/输出与代理消息支持快捷复制；turn 失败支持就地重试。
  - **提问是表单**：agent 的提问（`AskUserQuestion`、MCP 的 elicitation）以 `FormCard` 出现在权限区；只发回填了的字段（main 再按 schema 的字段过滤）；什么都没填、`required` 字段未填、数字不合 schema（非整数、超出 `minimum`/`maximum`）时 `Send answers` 不可点；一个字段都画不了或必填字段画不了时写明只能跳过。
  - **StepLine**：turn 进行中且未开始输出文本时，在末尾展示实时步骤行（等待批准 / 思考中 / 运行中的工具摘要），防止“静默卡死感”。
- **长会话窗口与滚动锚定**：
  - 初次仅渲染最后 60 块；向上滚动至距顶 `< 800px` 或点击 `Show earlier` 时向上增量加载 60 块，通过首块位移修正保持视口不跳动；页面内存中记住最近 50 个会话的阅读锚点；用户向上翻阅时提供浮动的回到底部入口。
- **Composer 与排队/插话**：
  - `Surface/Composer` 整块：上方挂载排队消息列表（虚线边框，可 `Edit` 取回）与附件/离线提示；内部依次为附件缩略图、Lexical Markdown 所见即所得输入框、单行/窄屏自适应工具条（附件按钮[仅声明 `image` 能力时显示]、`SettingChips`、会话全量设置齿轮、右侧 `ContextMeter` 用量环、Queue/Send/Stop）；下方固定高度 `KeyHints` 行。
  - **发送与草稿**：文本草稿持久化到 `localStorage`（按环境+会话键隔离），图片与 `@` 链接保持在内存；发送失败或被退回时自动放回输入框前端，不丢内容。
  - **命令与提及**：行首 `/` 触发 agent 命令候选；`@` 触发工作区文件搜索，发送时附带 `resource_link`。

### 4.5 表单弹窗与破坏性确认范式

- **表单弹窗（添加/编辑环境、重命名、添加连接器、Agent 默认设置）**：
  - 必须包裹 `<form onSubmit>`，支持在输入框内按 `Enter` 提交；
  - 打开时自动聚焦首个有效输入字段；
  - 底部操作行右对齐，**取消在左，主确认按钮在右**；提交中禁用按钮并就地展示失败原因。
- **破坏性确认弹窗（删除会话、移除连接器、移除远端环境、升级应用/Daemon 中断提示）**：
  - 必须经由 `AlertDialog` 确认；
  - 不可逆删除/移除操作的主确认按钮必须使用 `destructive` 语义样式（禁止使用 `solid` 靛蓝主按钮），且按钮文案采用“动词 + 对象”（如 `Delete session`、`Remove environment`）；
  - 打开时默认焦点落在 `Cancel` 上，防止连续两次回车误删。

### 4.6 空、加载、断线与错误反馈范式

- 每一块界面必须完整覆盖 **空、加载、出错、断线/重连、超长内容、超多数量** 六态。
- **错误三要素**：发生了什么 + 原样等宽可选择的系统/远端原因 + 下一步操作按钮（`Retry` / 编辑配置 / 重读）。错误发生就地展示，不依赖会自动消失的 toast。
- **空状态有出口**：任何空状态（无会话、无环境、无可用 agent）都不能只有一句静态描述，必须写明原因/下一步并就地提供直接动作按钮（如 `New session` 或连接/排查指引）。

### 4.7 命令面板与全局搜索范式

- `⌘K` 打开跨环境、跨 workspace 的会话搜索（匹配标题、文件夹、agent、环境名，含已归档会话），底部附新建会话快捷入口；全文内容搜索预留在 daemon 侧扩展。

---

## 第 5 层：语义决策体系（Decision Trees & Do / Don't）

### 5.1 什么时候用什么组件 / 反馈层？

```text
需要打断用户或获得明确授权？
├─ 是，且为不可逆破坏或中断正在运行的任务 ──▶ AlertDialog（ConfirmDialog，destructive 主按钮，焦点落 Cancel）
├─ 是，agent 等待单次/永久工具权限批准   ──▶ PermissionCard（吸附在输入框上方，不遮挡最近对话）
├─ 是，agent 提出问题要人回答（表单）     ──▶ FormCard（同一位置，accent 顶边，可 Skip）
└─ 否，不阻断当前编辑：
   ├─ 属于全局/环境/应用级状态（断线、更新、版本过旧、全局错误） ──▶ 顶部 Banner（带左竖条，不自动消失）
   ├─ 属于某个输入或列表项的校验/执行失败（附件超限、连接器报错） ──▶ 就地 inline alert / hint
   └─ 属于用户未注视的后台会话状态变化（Needs you / 完成 / 异常退出） ──▶ 系统桌面通知 + 侧栏/Switcher 角标
```

### 5.2 截断与溢出策略（区分文本语义）

| 内容类型                                              | 策略                                                                                         | 理由                                                           |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| **会话标题、环境名、连接器名、工具动词摘要**          | 单行，超长时末尾渐隐（`--cycle-fade-end`）+ `title` 悬停全称                                 | 最具辨识度的字词在开头                                         |
| **文件路径（头部 `session-where`、连接器地址/命令）** | 优先保留尾部目录/文件名（中间省略或左端截断）+ `title` 悬停完整路径                          | 路径最有区别度的仓库名和文件名在末尾，末尾淡出反而抹掉关键信息 |
| **代码块、表格、命令输入输出、错误原话**              | 代码块/表格独立横向滚动；错误原话与路径 `overflow-wrap: anywhere` 换行且 `user-select: text` | 绝不撑破 48rem 内容列或触发根页面横向滚动                      |

### 5.3 动作权重 Do / Don't

- **Do**：主工作区同一视图内至多保留一个 `solid` 主操作（`Send` 或 `Allow once`）；次要按钮用 `outline`；工具栏、行内、导航类用 `ghost`。
- **Do**：空状态允许提供一个明确的引导按钮（`outline` 或轻量主动作），让用户就地开始，而不必四处找入口。
- **Do**：模态确认弹窗的取消在左、主动作在右；不可逆删除用 `destructive`，常规确认/保存用 `solid`。
- **Don't**：不要把危险设置（如免确认权限模式）画成毫无区别的普通灰字；必须有明确的警示色标记。
- **Don't**：不要隐藏设置芯片的所有交互线索；保持无边框的安静感的同时，保留轻量悬停底色或极淡下拉指示。

### 5.4 键盘与焦点规范（Do / Don't）

| 按键                                  | 动作与适用范围                                            | 边界条件                                                                                                           |
| ------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `⌘N` / `Ctrl+N`                       | 打开空白新会话                                            | 至少有一个已连接环境时可用                                                                                         |
| `⌘K` / `Ctrl+K`                       | 打开跨环境会话搜索                                        | 全局可用                                                                                                           |
| `⌘B` / `Ctrl+B`                       | 展开/折叠侧栏                                             | 全局可用（主区头部同步提供可点击图标按钮）                                                                         |
| `⌘L` / `Ctrl+L`                       | 聚焦主输入框                                              | 当前有打开会话或空白会话时可用                                                                                     |
| `⌘[` / `⌘]`                           | 上一个 / 下一个会话                                       | 严格按侧栏可见列表顺序，自动跳过断线且未加载的会话                                                                 |
| `⌘.` / `Ctrl+.`                       | 停止当前正在运行的回合                                    | 仅当前环境已连接且 `activity !== "idle"` 时                                                                        |
| `⌘Return`                             | 批准当前第一张权限卡的 `Allow once`                       | **即使焦点在输入框中也应生效**（输入框不使用 `⌘Return` 发送/换行），仅在存在模态对话框时让位                       |
| `Enter` / `Shift+Enter` / `Alt+Enter` | 发送（或排队/插话） / 换行 / 强制换行                     | **必须先检查 `@ui-sdk/core` 的 `isComposing(event)`**，禁止用原生 `event.isComposing`，确保中文 IME 选词回车不误发 |
| `Esc`                                 | 逐层关闭：候选菜单 → 模态对话框（焦点归还触发处）         | 在纯输入状态且无弹窗/菜单时不清空草稿                                                                              |
| `↑` / `↓`                             | 光标在首/末块时召回历史发送消息；候选菜单打开时切换候选项 | 候选菜单优先消费上下键                                                                                             |

---

## 附录 A：状态画廊（Visual Regression）

```bash
bun packages/ui/gallery/shoot.ts                                  # 所有场景，浅色和深色，1200x800 和 720x480
bun packages/ui/gallery/shoot.ts permission --themes dark         # 指定场景和主题
bun packages/ui/gallery/shoot.ts --sizes 1200x800,720x480 --all   # 指定尺寸，列出每张
```

画廊使用临时 profile 在 macOS Electron 或 Linux xvfb 中运行，检查根页面溢出、控制台错误、焦点环、列表首项可见性与输入框边界对比度。在浏览器中预览：`bun packages/ui/gallery/build.ts` 后打开 `packages/ui/gallery/dist/index.html`（`?s=<场景>` 或 `?s=tokens`）。

核心场景（定义在 `packages/ui/gallery/scenarios.ts`）：`tokens`、`empty`、`empty-conversation`、`conversation`、`streaming`、`permission`、`permission-queue`、`turn-error`、`host-down`、`host-reconnecting`、`session-reconnecting`、`many-sessions`、`update-available`、`update-failed`、`daemon-old`、`new-session`、`dialog-add-host`、`dialog-agent-defaults`、`long`、`long-back`、`session-focus`、`turns`、`files`（文件工具的 diff 与计数）、`work`（命令输出与错误、子 agent、压缩、计划条）、`ask`（提问表单）等。

## 附录 B：代码配色（Shiki）

代码块由 `@streamdown/code`（Shiki JS 正则引擎，无需 WASM，CSP 不变）按需分包高亮。用户在侧栏底部 `App settings → Code colours` 中选择（即时生效且菜单不关闭）：

| 选择                 | 浅色 / 深色主题                                            | 最低文字对比度（浅 / 深） | 低于 4.5:1 的文字色个数（浅 / 深） |
| -------------------- | ---------------------------------------------------------- | ------------------------- | ---------------------------------- |
| GitHub（默认）       | `github-light-default` / `github-dark-default`             | 4.55 / 6.44               | 0 / 0                              |
| GitHub high contrast | `github-light-high-contrast` / `github-dark-high-contrast` | 5.04 / 9.34               | 0 / 0                              |
| VS Code              | `light-plus` / `dark-plus`                                 | 3.54 / 3.65               | 1 / 1                              |
| One                  | `one-light` / `one-dark-pro`                               | 2.58 / 3.27               | 6 / 2                              |
| Catppuccin           | `catppuccin-latte` / `catppuccin-mocha`                    | 2.62 / 7.01               | 12 / 0                             |

默认两套主题全部文字色均通过 WCAG AA（4.5:1）。

## 附录 C：语言、文案与 i18n（decision 0012）

- **源语言为 `en-US`**（句首大写，其余小写，不用 Title Case、感叹号、emoji、破折号或空话），新界面文字全部写入 `packages/ui/src/messages/en-US.ts`，组件使用 `t("key")`；门禁棘轮 `scan-copy.mjs --i18n` 只减不增。
- **整句与复数**：变化参数用 `{placeholder}`，数量用复数消息，数字/日期/单位用 `Intl`（`t.number` / `t.date`）。
- **术语统一**：统一用 `environment`（不用 `host`）、`session`、`agent`、`turn`、`permission`。
- **不翻译的数据**：agent 输出、daemon/ssh 错误原话、命令、路径、版本号。
- **版式弹性**：预留约 40% 的翻译变长空间；将来支持 RTL 时需把 `padding-left` 等迁为逻辑属性（`padding-inline-start`）。

## 附录 D：桌面端通知规则

- 窗口不在前台时，主进程在每次读取会话列表后通过纯函数 `attentionOf(之前, 现在)` 对状态差发系统通知：_Waiting for your answer_（`requires_action`）、_Waiting for your next message_（从运行/等待变为 idle，或首次出现的未读已完成会话）、_The agent stopped unexpectedly_（运行/等待变为 stopped，静默释放的空闲会话不报）。
- 断线重连后只报 `requires_action`，不误报历史完成或释放。点击通知激活应用并聚焦对应会话；若环境已断开或会话已删除则静默忽略。

## 附录 E：当前实现状态与已知待办（单一追踪清单）

以下为当前设计规范已明确、但代码尚待补齐或真机尚未验证的项目（按 P0–P3 分级追踪）：

### P0：代码缺陷与关键防呆修复

- [x] **中文 IME 与 `@` 提及替换修复**：`markdown-input.tsx` 改用 `@ui-sdk/core` 的 `isComposing(event)`，并修复 `replaceBeforeCaret` 在非 TextNode 边界时的替换行为。
- [x] **全局 `⌘Return` 批准权限**：去掉 `app.tsx` 中 `⌘Return` 的 `typing === null` 限制（仅模态弹窗开启时让位），并在 `Allow once` 按钮展示 `⌘↩` 提示。
- [x] **macOS 折叠侧栏红绿灯避让与恢复按钮**：为折叠态下的主区顶部横幅与空状态补齐红绿灯避让空间，并在主区头部接入 `SidebarIcon` 恢复/折叠入口。
- [x] **弹窗提交失败防丢 & ID 碰撞修复**：`saveEnvironment` / `renameSession` 失败时保留弹窗并就地展示原因（不关闭清空）；修复 `EnvironmentDialog` `id` 碰撞；`ConfirmDialog` 异步动作等待期间禁用防重；显式补齐 `connectors.tsx` 表单内非提交按钮的 `type="button"`。
- [x] **Hooks 依赖与渲染性能修复**：补齐 `app.tsx` 键盘监听 `useEffect` 依赖、优化 `conversation.tsx` 滚底触发、`SearchDialog` 关闭时跳过全量分组计算；修复 `composer.tsx` 拖放子元素触发 `dragleave` 闪烁并提示不支持的非图片文件。
- [x] **Banner 与 KeyHints 窄屏修复**：`app.tsx` 警告横幅文本包入 `<span>`；`key-hints` 在窄屏下避免折行后第二行被 `overflow: hidden` 腰斩。

### P1：落实第 3–5 层核心体验规范

- [x] **破坏性与表单弹窗规范化**：`ConfirmDialog` 破坏性操作改用 `destructive` 按钮变体；移除远端环境增加二次确认并补充编辑远端环境能力；`EnvironmentDialog` / `RenameDialog` 包裹 `<form>` 支持回车提交、打开自动聚焦首项、所有弹窗底部按钮统一右对齐（取消在左、主动作在右）。
- [x] **空状态与无 Agent 引导**：主区空状态提供就地引导按钮；无可用 agent 时说明可能原因（凭证/安装）并给出排查与重检按钮。
- [x] **第 3 层基础组件与材质/动效收口**：补充 `UpdateBanner` 临时关闭、`Button[data-variant="destructive"]` 约定；将 `--cycle-motion-enter`（200ms）实际接入弹窗/浮层/横幅出现过渡，清理死 CSS `[data-slot="session-main"]`。（注：`Banner` / `EmptyBlock` 抽取与功能色柔化令牌统一可在后续重构中继续收口。）
- [x] **路径截断与危险设置芯片**：路径类文本（头部 `session-where`、连接器路径）改为优先保留尾部的截断方式；`SettingChips` 补充轻量下拉线索与免确认模式的警示色（协议 `_meta["cycle/danger"]`）。

### P2：对话流与日常工作流质感打磨

- [ ] **对话内高频操作**：消息、代理回复的快捷 Copy（工具的命令、输出、错误已可复制，CYCL-14）；回合失败（`turn-end` error）就地 Retry；长会话向上阅读时显示浮动“回到底部”按钮；思考内容走 `Markdown` 只读渲染；空白会话转正式会话时平滑衔接。
- [ ] **工具调用与侧栏辨识度**：连续工具从 1 个升格为多个时保留手动展开态；会话行补充次要元信息（相对时间与未发送草稿标）；切换 workspace/环境时重置 `showAll`。
- [ ] **窄视口与缓存治理**：720×480 下 `composer-toolbar` 折行/紧凑适配；为 `store.views` 增加 LRU 上限，为 `selectSession` 加并发加载保护。
- [ ] **存量 i18n 迁移**：将剩余约 40 处 JSX 硬编码与 store/dialog 文案迁入 `packages/ui/src/messages/en-US.ts`。

### P3：跨层能力与真机未验证项

- [ ] **macOS 真机验收**：`hiddenInset` 红绿灯与拖动区域、自定义原生应用菜单与系统快捷键冲突、系统通知与点击唤起（需签名）、中文输入法实测、SF 字体实际行高与长会话帧率。
- [ ] **协议/后端协同项**：利用 `config_option_update` 补齐 agent 主动改设置的 UI 回显、工具执行耗时计时（需 daemon 记录开始时间）、会话内容全文搜索（daemon 侧）、多窗口与 VoiceOver 完整审查。
