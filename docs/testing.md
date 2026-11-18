# 测试与 CI

目标机器:2 核 4 GB。验证日期 2026-11-18(这台机器 4 核,下面的时间和内存是在这里量的)。

## 两层

|      | 命令                       | 时间     | 峰值内存        | 谁跑                                      |
| ---- | -------------------------- | -------- | --------------- | ----------------------------------------- |
| 门禁 | `bun run check`            | 约 7 秒  | 约 0.5 GB(tsc)  | 每次提交(pre-commit)、每次 push 和 PR(CI) |
| 集成 | `bun run test:integration` | 约 20 秒 | 约 1.5 GB(冒烟) | 手动、每晚(CI)                            |

门禁依次是:边界检查、Tailwind 生成 css、类型检查、lint、常规测试(约 110 个,1.5 秒)、界面测试(约 17 个,2 秒,需要 happy-dom 所以单独一步)。`check.ts` 在最后打印每一步的耗时。

集成测试会启动真实进程(Claude、daemon、xvfb 下的 Electron),所以不在门禁里。6 个套件**串行**,每个有自己的时限:

| 套件    | 证明什么                                                                                                                                                                                                 | 时限   |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| node    | 客户端和传输在真正的 Node(Electron 自带的)下能用                                                                                                                                                         | 60 秒  |
| adapter | 真实 SDK 上:不带 replayFrom 恢复后上下文完整;权限的允许和拒绝真的决定工具是否运行;模型输出到一半时取消                                                                                                   | 90 秒  |
| ssh     | **真实的 ssh**:一个私有的 sshd(非特权、回环端口、测试自己生成的主机密钥和用户密钥,不读不改 `~/.ssh`)加系统的 `ssh` 客户端;一个回合,断开,新连接拿到历史。设了 `CYCLE_DAEMON_BIN` 就用构建出的可执行文件跑 | 60 秒  |
| backend | `proxy` 自动启动 daemon、daemon 脱离、断线后新客户端拿到历史并继续、daemon 的环境变量不会到 Claude                                                                                                       | 120 秒 |
| package | 打包后的应用在干净的环境里(没有 bun、node、仓库)找到自带的 daemon 和 Claude,启动 daemon,窗口显示已连接                                                                                                   | 90 秒  |
| smoke   | 真实窗口、真实鼠标键盘:连接、建会话、聊天、回答权限、重载                                                                                                                                                | 150 秒 |

## 按改动选套件

`bun run test:integration --changed origin/main` 只跑这次改动能碰到的套件;`--plan`(可以和 `--changed` 或 `--files a b c` 连用)只打印选了哪些、每个是哪个文件、通过什么关系选上的,不运行。规则和套件清单在 `scripts/integration-plan.ts`,一个地方:

- 一个套件覆盖它自己所在的包,加上这个包在 `package.json` 里依赖的所有工作区包(包括 devDependencies)。
- import 推不出来的运行时启动关系写在套件的 `launches` 里:桌面应用把 daemon 当进程启动(`package`、`smoke` 因此也覆盖 `apps/daemon`,连带它依赖的 Claude 适配器)。新的这类关系要在这里加。
- 文档、技能和笔记、门禁自己的脚本、单元测试文件(门禁已经跑它们)不选任何套件;`*.integration.ts` 只选它自己的套件,不在默认清单里的(真实模型那几个)不选。
- **不认识的路径、锁文件、根配置、集成脚本、ci.yml 全选。** 比对失败(没有这个 ref、不是 git 仓库)也是全选,计划里会写原因。漏跑一个套件是看不见的洞,多跑只是花时间。

`--changed` 比的是已提交的内容(`<ref>...HEAD`,不含重命名检测:移走的文件按旧路径和新路径都算),没提交的改动不在里面。

CI 的 PR 用同一套规则,每晚和手动触发仍是全部(完整模拟模型的验证);真实模型继续只能显式开启。

套件的结果不只看退出码:一个套件的测试如果全被跳过(没有 Electron、xvfb 或 sshd)退出码是 0,以前汇总里会显示 ok。现在汇总每个套件是 ok、FAIL、skip(带原因)还是 not selected(带原因);没有任何测试运行是 FAIL。加 `--strict`(CI 用)时,在应该有这些前置条件的机器上跳过就是 FAIL。`--summary <文件>` 把同样的表写成 markdown(CI 写进步骤摘要)。

## 为什么不并行

2 核 4 GB 上同时跑两套 Electron 加 Claude 不会更快,还可能因内存被杀。每个套件的时限是为了让挂住的测试在一分钟内失败,而不是等 Bun 默认的几分钟。

## 删测试的原则

一个测试留下,要么它抓到过或会抓到真实的错误,要么它是别处没有的唯一证明。删的是:

- **只是在重述库或常量**:ACP SDK 的方法名常量、zod 的正则、一个只是把字符串放进状态的赋值。
- **在更低一层已经证明、而更高一层只是重复**:例如界面的"空消息不发"(store 的测试已经证明)、daemon 的 e2e 集成(取消和重启恢复已分别由适配器的集成测试和 daemon 的单元测试证明,`backend` 套件又走了一遍整条路径)。
- 在每个集成测试里都会发生的东西:"一个回合能流式输出"。

这次删了 17 个单元测试、1 个集成文件、1 个集成用例(142 个测试到 125 个)。**这不会让门禁变快**(它本来就只有几秒),减少的是要维护的东西。留下的测试里,抓到过真实问题的有:resume 的状态快照被当成历史、`replay_complete` 被去重丢掉、Streamdown 的颜色名没定义、turn 在 prompt 返回前不存在导致取消落空。

## 真实模型

`bun run test:integration` 全程用模拟的 API,不花额度。真实模型的测试要显式开启,凭证显式给:

```bash
CYCLE_REAL_MODEL_TOKEN=<oauth token> bun run --cwd packages/adapters/claude test:real   # 适配器层,4 项
CYCLE_REAL_MODEL_TOKEN=<oauth token> bun run --cwd packages/daemon test:real            # 经过 daemon,中间重启它
```

- token 只放进 Claude 进程的环境,不进适配器自己的环境、不进日志(跑完检查过日志里没有它)。没设 `CYCLE_REAL_MODEL_TOKEN` 时这些测试是跳过的。
- 默认用最小的模型(`CYCLE_REAL_MODEL`,默认 haiku)。断言是松的,因为真实模型不确定;这些测试的价值在它打印的报告,结果记在 [adapters/claude.md](adapters/claude.md)。
- 还有两个只在构建之后才有意义的:`apps/daemon` 下 `test:real`(只用构建出的可执行文件、空环境)和 `apps/desktop` 下 `test:real`(真实窗口加真实模型加构建出的 daemon)。先在根目录 `bun run build`。
- 四个套件加起来约一分钟,花几个很短的回合。**不在 CI 里**:CI 不应该持有账号的 token。

## CI

`.github/workflows/ci.yml`:

- `check`:每次 push 和 PR。`bun install --frozen-lockfile --ignore-scripts`,然后 `bun run check`。同一个分支的新提交会取消上一次还在跑的。10 分钟上限。
- `integration`:每个 PR(只跑计划选中的套件,先在 "Which suites" 一步里列出并说明原因;没选中任何套件时跳过安装,在步骤摘要里写一句)、手动触发和每晚一次(全部)。装 xvfb 和 Electron 需要的库(只有选中的套件需要它们时),下载 Electron 二进制(bun 不跑它的 postinstall),`bun run test:integration --strict`。工作流 checkout 完整历史,因为计划要和 base 比对。20 分钟上限。不需要任何密钥:模型是模拟的。

`check` 已经在 GitHub 上跑过:最近几次 push 全部通过,约 20 秒。**`integration`(每晚和手动)还没跑过**:装 xvfb 和 Electron 的库、真实 sshd 能否在 runner 上启动,要等第一次运行才知道,可能要调整 apt 包名。

## 还没做的

- 门禁里的步骤是串行的;类型检查和 lint 可以并行,2 核上大约省 2 秒,不值得先做。
- 集成测试里最慢的仍然是 Claude 的首次启动(每个 session 一次,约 1.5 秒);后续回合在同一个进程里(决策 0007)。
