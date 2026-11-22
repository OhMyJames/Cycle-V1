# Agent Note: 集成测试每次全跑,不按改动挑选,不记录耗时趋势

Status: accepted
Date: 2026-11-21
Basis: 2026-11-21 负责人要求删掉 CI 和测试里没必要和重复的内容,并选了"全删,PR 全跑";CI 实测(下面 Problem 里的数字)

## Problem

`bun run test:integration` 有两套附加机制:按改动只挑受影响的套件(`scripts/integration-plan.ts`,依赖图加手写的进程启动关系),以及每次运行写一份耗时记录、和 main 上最近 30 次比较趋势(`integration-record.ts`、`integration-trend.ts`、CI 里下载历史产物的步骤)。连同测试约 1,700 行。

而六个套件在 CI 上全跑一遍约 35 秒(删除前最后一次夜间运行,GitHub Actions run 44983049145:adapter 23.9、package 4.0、smoke 4.0、backend 2.8、ssh 2.0、node 1.0);连安装在内,PR 的 `integration` 作业约 55 秒,和 `check` 并行。挑选最多省下这 35 秒;趋势对比的阈值在文档里自己写着"暂定,等样本",从没据此做过决定。

## Decision

- 每个 PR 和手动触发都跑全部套件,`--strict`。删除按改动挑选(`--changed`、`--plan`、`--files`、`--github-output`)和耗时记录与趋势(`--record`、`integration-trend.ts`、产物上传和历史下载)。
- 删除夜间定时运行,改为每次 push 到 main 也跑全部套件:PR 已经全跑,但两个 PR 各自通过、合并后的组合没人测过,main 自己的提交要跑一遍。runner 镜像或系统包在 main 不变时出的问题,由下一次 push 或 PR 发现。
- 保留:套件清单、每个套件的时限、"结果不只看退出码"的判定(全部跳过在 strict 下是失败)、按名字只跑一部分、清理残留进程、步骤摘要表。这些在 `scripts/integration-suites.ts` 和 `scripts/integration.ts`。

## Alternatives considered

- **只删耗时记录,保留按改动挑选**:负责人没选。挑选的规则要随包和启动关系一起维护(漏写一条就是看不见的漏测),换来的是一个和 `check` 并行的作业少跑几十秒。
- **都保留**:负责人没选。

## Consequences

- 纯文档的 PR 也会跑一遍集成测试(约 1 分钟的 runner 时间),不再有漏选套件的可能。
- 没有了历史耗时对比。某个套件变慢,只能从单次运行的表里看出来;套件撞到自己的时限才会失败。
- 如果以后集成测试涨到几分钟、PR 等待明显变长,再考虑挑选;那时先看是哪个套件慢,能不能把它变快,再考虑挑选。

## Related

- 部分取代 [workspace 布局笔记](2026-11-19-workspace-layout-and-direct-acp-sdk.md) Consequences 里关于 `scripts/integration-plan.ts` 选套件的一条;那份笔记的其余决定不受影响。
