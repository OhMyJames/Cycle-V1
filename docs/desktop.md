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

## 页面的安全设置

agent 的输出是不可信的:里面可以有原始 HTML、链接、图片。

- **窗口**:`contextIsolation`、`sandbox`、`nodeIntegration: false`。页面里没有 `require`、`process`、`ipcRenderer`,桥上只有约定的 20 个方法(冒烟测试逐项断言)。
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

## 还没做

- **远端 daemon 的升级**:应用只更新自己和自带的本地 daemon,不替用户在别的机器上装东西。远端的 daemon 版本(初始化时它报告自己的版本,构建时写入,和应用同一个版本号)比应用旧时,顶部会出现横幅和一条要在那台机器上运行的命令(下载本版本的 tarball、校验、`install.sh`、`cycle stop`)。`dev`(从源码运行)和比应用新的版本不提示。限于 Linux x64。
- **签名后的更新**:更新里已有"签名团队必须和当前应用相同"的检查,但还没有在真实的 Developer ID 签名包上跑过(目前发布的包只有 ad hoc 签名,这一条检查被跳过)。
- **代码高亮**:真实输出里代码块有语言标签、行号和复制/下载按钮,颜色很淡;没有单独配置高亮主题。
- **图片**:agent 消息里的图片只显示为文字;粘贴或附加图片到 prompt 也没做。
- **当前设置的来源**:session 设置对话框显示的是 daemon 索引里记下的设置;agent 自己改的(比如 Claude 的 plan 模式切换)不会反映回来。
- **Claude 的 `config.json`**(`configDir`、密钥):没有 UI,因为它会把凭证放上线路。要在 daemon 所在机器上手改。
- 搜索、快捷键、通知、多窗口、深色模式的细调、可访问性审查(ui-sdk 的组件有基础的键盘和 ARIA,我们自己的部分没单独审)。
- 真实登录(`claude login`)的验证。真实模型已经验证过(见下)。
