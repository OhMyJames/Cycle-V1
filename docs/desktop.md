# 桌面客户端

状态:草稿。验证日期 2026-11-18。

`apps/desktop`(Electron 主进程、预加载脚本、页面入口)和 `packages/ui`(界面、会话模型、渲染进程的 store)。

## 构建和运行

```bash
bun install
bun node_modules/electron/install.js   # 下载 Electron 二进制(bun 不会自动跑它的 postinstall)
bun run build                          # 根目录:先构建 daemon 的可执行文件,再构建桌面端(esm 主进程、cjs 预加载、页面、css)
bun run start                          # 启动桌面端
```

- 本地 host 通过 `cycle proxy` 连接(没有 daemon 在运行就先启动)。用哪个 daemon,取第一个存在的:`CYCLE_DAEMON_BIN`;`apps/daemon/dist` 里构建出的可执行文件;源码(`bun apps/daemon/src/main.ts`,开发时,可用 `CYCLE_BUN`、`CYCLE_DAEMON_MAIN` 覆盖)。数据目录用 `CYCLE_HOME`。
- 在 xvfb 下用构建出的 daemon 启动过:Electron 起来,`proxy` 起 `serve`,数据目录里有 socket 和 pid。
- 远程 host 用系统的 `ssh`(`BatchMode=yes`,没有密码提示),在远端运行 `cycle proxy`;命令可在"Add host"里改。
- 设置(host 列表)在 Electron 的 `userData/settings.json`。

## 结构

| 部分                                  | 作用                                                                                                             |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `apps/desktop/src/main/manager.ts`    | `ConnectionManager`:每个 host 一个 `CycleClient`,以及每个被观看 session 的会话。不依赖 Electron,用真 daemon 测试 |
| `apps/desktop/src/main/app.ts`        | 窗口、安全设置、IPC;只有它知道怎么连各种 host                                                                    |
| `apps/desktop/src/preload/preload.ts` | 给页面一个对象 `window.cycle`(`AppApi` 的方法加 `onEvent`),没有别的                                              |
| `packages/ui/src/api.ts`              | main 与页面之间的契约(只有类型和方法名)                                                                          |
| `packages/ui/src/model/`              | 会话模型:把 ACP v2 的 `session/update` 累加成对话。纯 TS,没有 React,main 也用它                                  |
| `packages/ui/src/store/`              | 页面的状态和动作。没有 React,用假桥接测试                                                                        |
| `packages/ui/src/react/`              | 组件(ui-sdk,Streamdown)                                                                                          |

## 为什么 main 持有会话状态

页面重载后只会收到之后的更新;`CycleClient` 也按 `seq` 去重。所以 **main 为每个被观看的 session 保存会话和未回答的权限请求**,页面(重新)打开时一次拿到整个状态和一个 `version`;之后每个事件带 `version`,页面只接受 `version + 1`,更小的忽略,出现空洞就重新向 main 要。冒烟测试里重载页面后会话完整回来。

## 环境、workspace 与侧栏

状态:daemon 一侧(协议 0.2:`updatedAt`、`cycle/unread`、`cycle/background`、`mark_read`)已实现;客户端一侧(environment、workspace、侧栏)是设计,未实现。代码里现在叫 host(`HostConfig`、`hostId`),落地时改叫 environment。设计依据见决定笔记 [2026-11-18-sidebar-workspace-environment](../.agents/notes/2026-11-18-sidebar-workspace-environment.md)。

### 环境(environment)

环境是**客户端**的概念:daemon 不知道自己被当作本地还是远程(协议只看到一个连接)。

```ts
type Environment = {
  id: string; // 客户端分配,稳定;会话在列表里的身份是 (environmentId, sessionId)
  name: string;
  kind: "local" | "remote"; // 以后可能有 "cloud"
  transport: // 只有 remote 有
  { type: "ssh"; host: string; command?: string[] }; // 以后可以加 websocket 等,不改别的字段
};
```

- `remote` 不等于 SSH:SSH 只是现在唯一的 `transport`。
- 可以**同时连着多个** daemon,侧栏的会话是它们的**汇总**。每个环境有自己的连接状态。
- 环境的能力(能做什么)来自 daemon 的 `initialize`(§3 `_meta["cycle/capabilities"]`),界面按能力开关功能,不写 `if (remote)`。
- 一个 session 在创建时绑定到它的环境,不能换:远程的 cwd 在本机不存在。
- **版本落后的远程 daemon** 要能用:列表里没有的字段按缺失处理(protocol.md §3、§6),界面不报错。

### workspace

- **workspace = 环境里的一个 cwd**,即 `(environmentId, cwd)`。同一个路径在两个环境里是两个 workspace。
- 不把 git 仓库的子目录或 worktree 合并成一个项目(old-cycle 是按 git 主 checkout 合并的;咱们 v1 没有 worktree,以后要合并时再决定)。
- 远程环境的 workspace 在侧栏里带一个**图标**,hover 的 tooltip 写它属于哪个环境(名字,以及连接状态);本地的没有图标。环境名不能只靠 tooltip:图标有可访问名,里面包含环境名。不同环境里同名的目录,标题再带上环境名区分。
- 在一个 workspace 里新建 session,就在它的环境里新建。要在别的环境里工作,就是选另一个 workspace,或者"New workspace…"时先选环境、再在那个环境的文件系统里选文件夹。

### 侧栏

一次只显示一个 workspace(沿用 old-cycle 2026-11-08 的决定):

- 显示哪个:你在 switcher 里选的,直到打开了别的东西;然后是当前打开的 session 或草稿所在的 workspace;最后是最近有活动的(`updatedAt` 最大的)。从列表里打开任何一行,都会放弃 switcher 的选择。
- **Switcher** 是一个菜单,列出所有 workspace,按环境分组(本地在前;多于一个环境时才显示分组标题,标题带连接状态),组内按 `updatedAt` 倒序。只有一个环境时,界面里不出现"环境"这个词。
- Switcher 上有一个方块数字徽章,数**其他 workspace**(所有环境)里最紧急的那一类;完整的计数写进 aria-label。
- 搜索跨所有 workspace 和环境,结果按 workspace 分组。

当前 workspace 里的会话分组:**Needs you**(`requires_action`)、**Running**(`running`,以及有后台子 agent 的)、然后 Today / Yesterday / Earlier,按本地日界线分,用 `updatedAt`。每个 workspace 默认显示 20 条,"Show N more";有状态的和当前打开的永远显示。

一行只带一个状态标记,优先级:`requires_action` > `running` > background(`cycle/background` > 0)> unread(`cycle/unread`)。来源都是 daemon 的列表字段。

排序用 `updatedAt`,不用 `cycle/lastSeq`(后者按记录条数,不是时间)。旧 daemon 的 session 没有 `updatedAt` 时排在有的之后,彼此按 `lastSeq`。

### 待定

- 一个环境断线时,它的会话:保留最后一次的列表(灰显),还是隐藏。
- 远程环境上选文件夹的界面:要在那个环境的文件系统里浏览,daemon 还没有对应的方法。
- Switcher 分组:同一个 workspace 里有 session 在别的环境的情况不会出现(workspace 属于一个环境),所以不需要处理。如果以后同一个仓库要在本地和远程之间对应起来,那是另一个决定。

## 页面的安全设置

agent 的输出是不可信的:里面可以有原始 HTML、链接、图片。

- **窗口**:`contextIsolation`、`sandbox`、`nodeIntegration: false`。页面里没有 `require`、`process`、`ipcRenderer`,桥上只有约定的方法(`API_METHODS` 加 `onEvent`,冒烟测试逐项断言)。
- **IPC**:main 只接受来自应用自己页面(`senderFrame.url` 等于 index.html)的调用。
- **导航**:不能跳转,不能开新窗口;http/https 链接交给用户的浏览器。无权限(`setPermissionRequestHandler` 一律拒绝)。
- **CSP**:`default-src 'none'`,`connect-src 'none'`,没有 frame、没有内联脚本,`img-src` 只有自己和 data:。
- **Markdown**(`packages/ui/src/react/markdown.tsx`):丢弃原始 HTML;只有 http、https、mailto 是链接,其余是文字;图片从不加载,显示成文字。Streamdown 自己的默认是允许所有图片和链接前缀,所以这几条不交给它(DOM 测试逐项断言)。
- **`--no-sandbox`** 只在冒烟测试里用(测试机上没有 setuid 的 chrome-sandbox),窗口本身仍然是 `sandbox: true`。应用不带这个参数。

## 样式:Streamdown 带来了 Tailwind

Streamdown 的标记用 Tailwind 的工具类,而且用的是 shadcn 的颜色名(`text-muted-foreground`、`bg-sidebar`……),Tailwind 只在这些名字有定义时才生成对应的类。所以:

- `packages/ui/src/styles/app.css` 引入 Tailwind、ui-sdk 的 `web.css`(在 `components` 层)、Streamdown 的样式,`@source` 指向 Streamdown 的代码,并用 `@theme inline` 把那些颜色名映射到 ui-sdk 的 `--ui-*` 变量。换 ui-sdk 的主题,Markdown 也跟着换。
- 一个 DOM 测试检查 Streamdown 渲染出的每个工具类都在构建出的 css 里。它抓到过缺口(上面的颜色名没定义,Markdown 会"光着身子")。
- 生成的 `built.css` 不进 git;`bun run check` 的第一步会生成它。

## 测试

- 门禁里(`bun run check`):会话模型、store(假桥接)、`ConnectionManager`(真 daemon)、页面组件和 Markdown 安全(happy-dom,`*.dom.tsx`,单独一步,因为它们需要浏览器全局,会破坏其他测试)。
- `packages/client`:`bun run test:integration` 把客户端打成包,用 Electron 自带的 Node 跑,证明它在 Node 下能用(Bun 通过自己的测试说明不了这一点)。
- `apps/desktop`:`bun run test:integration smoke`(会先 `build`)。在 xvfb 下启动真实 Electron,用真实的鼠标和键盘事件操作真实窗口,后面是真 daemon、Claude 适配、真 SDK 和模拟 API:连上 host、点击和打字创建 session、发消息、看到流式回答、出现权限卡片并点击 Allow(工具真的运行了)、重载页面后会话回来。

## 真实模型下的窗口

`CYCLE_REAL_MODEL_TOKEN=… bun run test:real`(在 `apps/desktop` 下,先在根目录 `bun run build`):xvfb 下的真实 Electron 窗口,真实鼠标键盘,daemon 是构建出的可执行文件,token 只写在它的 `config.json` 里,模型 haiku。约 16 秒。依次:连接、新建 session、问一个词、让它用 Bash `touch` 一个文件、点 Allow、让它写一段带标题、列表、表格和代码块的 markdown,让它用任务工具建两个任务,最后重载页面看历史是否回来。通过(头部显示用量,对话里有计划)。截图(`SHOT_TO=路径`)里:标题、列表、表格、带语言标签和行号的代码块都正确渲染;工具卡显示命令和"completed"。

这次发现并改掉的是**测试自己的问题**:先是等待条件会被用户输入的 prompt 本身满足(prompt 里就含"pong"和"finished"),现在只看 agent 消息;再是重载发生在回合收尾之前,界面显示"working",现在等回合结束。

## 踩过的坑(都在测试里有对应)

- Electron 的主文件是 ES module 时,**不能在顶层 await `app.whenReady()`**:ready 要等主文件执行完才发出,等于自己等自己。冒烟测试因此挂过。
- Bun 在 Electron 的主进程里不存在:客户端用 `node:net` 和 `node:child_process`,门禁拒绝在这些目录里用 Bun 的 API。
- 点击输入框时如果对话框还在关闭动画里,点击会落在别处。冒烟脚本点到输入框真的拿到焦点为止。

## 自动更新

只在安装好的 macOS 应用里启用;`bun run start` 的开发运行里显示"Updates are for the installed app",不检查。实现在 `src/main/updater.ts`,所有外部依赖(网络、解压、进程、定时器)都注入,门禁里用假的 GitHub 测试;`test/integration/update.integration.ts` 在 macOS 上用真实的包走完整个流程(release 工作流里跑)。

- **检查**:启动时一次,之后每 60 秒一次;侧栏里的 "Check for updates" 立即检查。后台检查失败(断网、被限流)不提示,用户自己点的检查会显示原因。
- **发现**:读 GitHub 的发布列表(带 `If-None-Match`:内容没变时 GitHub 回 304,据 GitHub 文档不计入未登录的每小时 60 次限额),取比当前版本新、不是草稿、带本平台清单文件(`latest-darwin-arm64.json`)的最高版本。不能用 `/releases/latest`,因为它跳过 pre-release,而没签名的发布都是 pre-release。
- **安装**要用户确认:顶部横幅 "Update and restart" → 确认框(会说明本机上正在工作的会话会被中断)。然后下载到应用旁边的隐藏目录(同一个卷,最后的替换是 rename),校验大小和 SHA-256,`ditto` 解压,检查解出的包的版本、平台和清单一致;当前应用有 Developer ID 签名时,还要新包签名有效且是同一个团队。
- **替换**:先停掉旧应用带起来的本地 daemon(它跑在旧包里,不停的话替换后会留下一个找不到 `claude` 的旧 daemon),再由一个脱离的小 shell 脚本等旧进程退出后 `mv` 换包并 `open -n` 打开新的;替换失败会放回旧包并照样打开。不在运行中的进程自己换自己,是因为替换正在运行的 Electron 的包可能让它崩溃。下次启动清理遗留的临时目录。
- **下载只来自**仓库自己的 release 地址(`https://github.com/OhMyJames/Cycle-V1/releases/download/`)。没签名的包靠 HTTPS 加 SHA-256 保证完整性,不能证明来源,这一点要等签名后才补上。程序自己下载的文件没有隔离标记,所以没签名的更新不会被 Gatekeeper 拦(第一次安装仍要手动去掉)。
- **装不上时**会提前说明:应用所在的目录不可写,或应用是从下载位置直接打开的(App Translocation,只读)。
- 测试用的 `CYCLE_UPDATE_URL` 只接受 `127.0.0.1` 或 `localhost`,不能把应用指到别处。

## 代码配色、图片、搜索

- **代码配色**:Streamdown 2.x 自己不带语法高亮,它是单独的插件 `@streamdown/code`(Shiki,JavaScript 正则引擎,不需要 WebAssembly,CSP 不变)。侧栏底部可以在五套配色里选(见 DESIGN.md 第 15 节,含各套的对比度)。打包开了分包:语言和主题按需加载,启动约 0.9 MB,全部约 12 MB。
- **图片**:agent 和用户消息里的图片(png、jpeg、gif、webp;svg 不是)用 data URL 画,不请求网络;超过大小上限的显示成一行字。Markdown 里的远程图片仍然不加载。
- **搜索**:⌘K(Windows、Linux 是 Ctrl+K)。

## 还没做

- **远端 daemon 的升级**:应用只更新自己和自带的本地 daemon,不替用户在别的机器上装东西。远端的 daemon 版本(初始化时它报告自己的版本,构建时写入,和应用同一个版本号)比应用旧时,顶部会出现横幅和一条要在那台机器上运行的命令(下载本版本的 tarball、校验、`install.sh`、`cycle stop`)。`dev`(从源码运行)和比应用新的版本不提示。限于 Linux x64。
- **签名后的更新**:更新里已有"签名团队必须和当前应用相同"的检查,但还没有在真实的 Developer ID 签名包上跑过(目前发布的包只有 ad hoc 签名,这一条检查被跳过)。
- **会话内容的全文搜索**:⌘K 搜的是标题、文件夹、agent 和主机(跨已连接的主机)。对话内容的全文要在历史所在的 daemon 里做。
- **图片的发送只对声明了能力的 agent 开放**:附加的控件(按钮、粘贴、拖放)只在 `_cycle/agents/list` 里这个 agent 的 `promptCapabilities.image` 存在时出现。带附件支持的 daemon(decision 0010)上的 Claude 声明了;更早的 daemon 不报告,界面上就没有附加入口,不会发出 daemon 不认的内容。主进程这一段有测试(`apps/desktop/test/manager.test.ts`):能力被报告,图片块原样送达 agent,没有声明的 agent 拒绝图片。
- **界面文字迁入 i18n 目录**:源语言是 en-US(decision 0012);新文字已经走目录,存量约 60 处还在标记里,门禁的棘轮保证不再增加。
- **当前设置的来源**:session 设置对话框显示的是 daemon 索引里记下的设置;agent 自己改的(比如 Claude 的 plan 模式切换)不会反映回来。
- **Claude 的 `config.json`**(`configDir`、密钥):没有 UI,因为它会把凭证放上线路。要在 daemon 所在机器上手改。
- 多窗口、可访问性审查(ui-sdk 的组件有基础的键盘和 ARIA,我们自己的部分没单独审)。
- 真实登录(`claude login`)的验证。真实模型已经验证过(见下)。

## 通知

一个你没在看的会话需要你(等你回答、做完了、agent 没了)时,主进程用系统通知告诉你;设计和限制见 DESIGN.md 第 20 节。主进程在每次重读会话列表时和上一次比较(`ConnectionManager` 的 `attention` 选项),窗口在前面时不显示;点通知回到那个会话(`focus-session` 事件)。macOS 上通知需要应用已签名并经用户允许,这一点没有在 Mac 上验证。
