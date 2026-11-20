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

## macOS 签名包更新验收

用已登录图形桌面的 Apple 芯片测试账号串行执行。安装和替换都发生在临时目录。重启走 Launch Services，会使用该账号的 Electron 偏好设置。测试临时给登录会话设置 `CYCLE_HOME`、`CYCLE_UPDATE_URL` 和 `CYCLE_ANALYTICS=off`，退出时恢复原值。

1. **准备前后两个版本。** 取上一次发布和目标版本各自的 macOS CI 产物，每份都应包含原始 zip 和 `latest-darwin-arm64.json`。需要重新构建时，在两个发布提交上分别建测试分支，手动运行 `release.yml`，选 `sign=true` 和 `runner=self-hosted`。从**分支**运行只上传 artifact。从标签运行会进入发布流程。每次核对 Sign、Gatekeeper 和上传三个步骤都成功。0.3.6 和 0.3.7 的旧工作流给 macOS artifact 一律加了 `-unsigned` 后缀，下载这两个版本时按实际名称取包，下面的测试会检查包内签名。
2. **同团队安装。** 在仓库根目录执行下面的命令，替换两个 run ID。测试从回环地址提供原始清单和 zip，验证包大小、SHA-256、Developer ID、Gatekeeper、公证票据和 Team ID，驱动旧应用发现并安装更新。通过条件包括旧应用和 daemon 均退出、新应用重启、安装后的签名仍有效，以及临时套接字上的 daemon 在更新前后分别报出两个发布版本。
3. **异团队拒绝。** 另取一份由不同 Apple 团队签名并公证的较新 Cycle 构建，沿用旧版本，把 `CYCLE_SIGNED_TO` 指向该产物，另设 `CYCLE_EXPECT_DIFFERENT_TEAM=1` 再跑一次。应出现签名团队不匹配的错误，旧应用和原 daemon 继续运行，安装目录保留原版本，暂存目录清理完成。两张同团队证书具有相同 Team ID，只能用于同团队用例。
4. **远端旧 daemon 横幅。** 在更新后的版本中用「Add environment」连接专用 SSH 测试环境，选择该环境的会话。使用能完成协议握手、版本低于目标版本 `MIN_DAEMON_VERSION` 的已编译 daemon（0.3.7 的下限是 0.2.1）。核对横幅中的环境名称、实际 daemon 版本，以及按钮的目标版本。换用达到下限的 daemon 后重连，横幅应消失。记录两次观察；远端协议主版本不兼容时会显示另一条提示。
5. **记录结果。** 保留两个构建链接、版本、Team ID、清单 SHA-256、正反例的测试输出及远端横幅截图。缺少异团队产物或测试环境的用例记为待验。

```bash
fixtures=$(mktemp -d)
gh run download OLD_RUN_ID -n app-darwin-arm64 -D "$fixtures/old"
gh run download NEW_RUN_ID -n app-darwin-arm64 -D "$fixtures/new"
CYCLE_SIGNED_FROM="$fixtures/old" CYCLE_SIGNED_TO="$fixtures/new" \
  bun test ./apps/desktop/test/integration/update.integration.ts
```

常规发布中签名前的更新测试仍走 `CYCLE_PACKAGED_APP`，会调高临时副本的版本并用 ad hoc 重签。该测试验证差分下载与重启，真实签名验收单独记录。

### CYCL-105 实测记录

mac-mini 上用同一 Developer ID 团队 `AGKXLGRXJ7` 对发布提交 0.3.6、0.3.7 分别签名并公证。原始清单和 zip 的 SHA-256 均保存在[验收日志](https://github.com/OhMyJames/Cycle-V1/actions/runs/44703626920)中。

| 用例                                  | 观察结果                                                                                                                                                                                                                                      |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 原版 0.3.6 → 0.3.7                    | 应用下载更新、通过团队检查并重启。旧 daemon 的 PID 已退出，五秒后临时套接字仍应答 0.3.6，已安装的二进制报告 0.3.7。旧桌面在退出前有机会自动重连，重新启动旧二进制。[复现记录](https://github.com/OhMyJames/Cycle-V1/actions/runs/44705021238) |
| 签名版 0.3.6 收到公开的 ad hoc 0.3.7  | 窗口提示签名团队不匹配；旧应用和 daemon 继续运行，暂存目录清理完成。[拒绝安装记录](https://github.com/OhMyJames/Cycle-V1/actions/runs/44705021238)                                                                                            |
| 签名版 0.3.7 连接远端旧 daemon        | 通过隔离的真实 SSH 连接 0.2.0，窗口显示环境名称、0.2.0 和「Update to 0.3.7」。切换远端二进制并重连 0.3.7 后横幅消失。[运行和截图](https://github.com/OhMyJames/Cycle-V1/actions/runs/44704590908)                                             |
| 两个不同 Developer ID 团队的 Cycle 包 | 待验。目前只有一个团队的 Cycle 产物。                                                                                                                                                                                                         |

## 按改动选套件

`bun run test:integration --changed origin/main` 只跑这次改动能碰到的套件;`--plan`(可以和 `--changed` 或 `--files a b c` 连用)只打印选了哪些、每个是哪个文件、通过什么关系选上的,不运行。规则和套件清单在 `scripts/integration-plan.ts`,一个地方:

- 一个套件覆盖它自己所在的包,加上这个包在 `package.json` 里依赖的所有工作区包(包括 devDependencies)。
- import 推不出来的运行时启动关系写在套件的 `launches` 里:桌面应用把 daemon 当进程启动(`package`、`smoke` 因此也覆盖 `apps/daemon`,连带它依赖的 Claude 适配器)。新的这类关系要在这里加。
- 文档、技能和笔记、门禁自己的脚本、单元测试文件(门禁已经跑它们)不选任何套件;`*.integration.ts` 只选它自己的套件,不在默认清单里的(真实模型那几个)不选。
- **不认识的路径、锁文件、根配置、集成脚本、ci.yml 全选。** 比对失败(没有这个 ref、不是 git 仓库)也是全选,计划里会写原因。漏跑一个套件是看不见的洞,多跑只是花时间。

`--changed` 比的是已提交的内容(`<ref>...HEAD`,不含重命名检测:移走的文件按旧路径和新路径都算),没提交的改动不在里面。

CI 的 PR 用同一套规则,每晚和手动触发仍是全部(完整模拟模型的验证);真实模型继续只能显式开启。

套件的结果不只看退出码:一个套件的测试如果全被跳过(没有 Electron、xvfb 或 sshd)退出码是 0,以前汇总里会显示 ok。现在汇总每个套件是 ok、FAIL、skip(带原因)还是 not selected(带原因);没有任何测试运行是 FAIL。加 `--strict`(CI 用)时,在应该有这些前置条件的机器上跳过就是 FAIL。`--summary <文件>` 把同样的表写成 markdown(CI 写进步骤摘要)。

## 耗时的记录和趋势

`bun run test:integration --record <文件>` 把这一次运行写成一个 JSON(`scripts/integration-record.ts`):提交、时间、分支或 PR 的来源、机器(平台、架构、核数、内存;在 CI 上还有 runner 的系统和镜像版本)、CI 的运行号和事件,以及**全部六个套件**各自的结果(ok、FAIL、skip、not selected)、耗时、时限、原因和最慢的几个测试(来自 bun 的 junit 输出)。没有时间的套件有状态和原因,所以"没跑"、"自己跳过"、"失败"和"快"不会混在一起。

CI 的 `integration` 作业每次都生成这个记录,作为 `integration-timing` 产物保存(PR 14 天,其余 90 天,即使有套件失败也会上传)。夜间和手动触发的运行还会下载最近 30 个产物,用 `bun scripts/integration-trend.ts <这次的记录> <历史目录>` 在步骤摘要里写一张表:每个套件这次的结果和耗时,历史上(同一种机器)通过、失败、跳过、没选中的次数,以及一句判断。

- **只拿同一种机器比。** 平台、架构、核数、runner 系统相同才算。runner 镜像版本**不**算在里面(GitHub 的镜像大约每周换一次,算进去的话基线每周重来、永远攒不到 10 个),但每条记录里有它,表头会写"其中 n 个在另一个镜像上",镜像更换前后耗时跳了一档能看出来。换了核数或系统,历史样本就不算数,重新积累。
- **历史只用 main 自己的运行。** 夜间和手动运行从 main 上跑;下载历史时只取 `head_branch == main` 且来自本仓库(不是 fork)的运行的产物。PR 的运行也上传记录(14 天,用来追溯),但不进基线:PR 的代码还不是 main 的,fork 的 PR 能写任何内容。
- 记录里的 `commit` 在 PR 上是 GitHub 合成的合并提交,要追到 PR 的头,看记录里的 `ref` 和 `ci.runId`。
- **只有通过的运行是样本。** 失败的耗时(常常是撞到时限)、跳过的、没选中的都不进基线,只被单独计数。
- **够样本才评判。** 少于 10 个可比的通过样本时只写"几个,从 10 个开始判断"。有够样本之后,这次超过中位数的 1.5 倍、而且多出至少 3 秒,才标"slower"(3 秒的下限是为了让 1~2 秒的套件不因一秒的抖动被标出)。这两个数是**暂定的**,要等有了真实样本再决定要不要告警、阈值多少。
- **它只描述,不阻断。** 对比步骤 `continue-on-error`,不会让作业变红;PR 上不做对比,也不因耗时挡 PR。

### 固定等待

记录出来之前先看了现有的等待(`Bun.sleep`、`setTimeout`)。CI 上一次全选(2026-11-18,PR #35 的运行)六个套件合计约 34 秒:adapter 17.4、package 4.3、smoke 5.3、node 2.3、ssh 2.3、backend 2.5;这台开发机上同样跑一遍 adapter 要 42.7 秒。大头是适配器套件(真实 SDK 起进程)。

- **换掉了一个:** 冒烟里按下 Enter 后无条件 `sleep(1500)` 再看一眼页面写日志,现在等"输入框被清空"(消息已发出)这个可观察的事件。同一台机器上交替跑 4 次:原来 7.4~7.8 秒(平均 7.6),现在 5.6~7.0 秒(平均 6.1),约省 1.5 秒。
- **有意留着的:** 适配器取消用例里取消之后放行模型再等 1 秒,是在证明"取消之后什么也不会再到客户端"这个没有事件可等的负面观察窗口;它前面的 8 秒是上限不是等待;其余的 `until`、`waitFor`、50~250 ms 的轮询都有上限,是有界轮询。
- **看到了、没动的:** 客户端的 Node 套件里首个 chunk 之后的 200 ms(给后续更新留的余量),冒烟里点击之后的 80 ms 等页面落定。它们加起来不到半秒,也没有证据说明去掉后稳定,所以没改;等记录里有足够样本、能看出它们占的比例再说。

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
CYCLE_REAL_MODEL_TOKEN=<oauth token> bun run --cwd harness/claude test:real          # 适配器层,4 项
CYCLE_REAL_MODEL_TOKEN=<oauth token> bun run --cwd apps/daemon test:real:daemon      # 经过 daemon,中间重启它
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
