# Agent Note: Claude 暂不支持 goal,不靠 CLAUDE_CODE_REMOTE 或会话记录去拿

Status: accepted
Date: 2026-11-22
Basis: 2026-11-22 CYCL-120 真实模型验证(SDK 0.3.327、CLI 2.1.327、haiku)与 CLI 二进制的检查;负责人当天选定"先标记不支持,留 issue 跟进"(CYCL-121)。

## Problem

[Overview 的来源决定](2026-11-22-overview-sources-and-layout.md)假定 SDK 的 `active_goal` 会经 `query()` 到达,适配器把它转成 `_cycle/goal_update`。真实模型下,本地进程设了 `/goal`、经过多轮判断直到达成,一条 `active_goal` 都没有收到,Overview 永远看不到 goal。CLI 里只有在环境变量 `CLAUDE_CODE_REMOTE` 为真时才把 goal 的变化写进 SDK 输出;设了它的探针里,设定、每次没达成(轮数加 1、带理由)、达成(`null`)都按协议到达。

## Decision

Claude 的会话暂不报告 goal:文档写明不支持,客户端按"不知道"显示。适配器里 `active_goal` 到 `_cycle/goal_update` 的转换保留,SDK 哪天对本地进程发了就能直接用。真实模型测试里有一条 goal 用例,收不到时只打印"未送达",收到时断言完整生命周期,作为跟进的信号(CYCL-121)。

## Alternatives considered

- **适配器给 Claude 进程设 `CLAUDE_CODE_REMOTE`**:一行就能拿到原生的 goal 消息。否决:这个变量表示"运行在云端容器里",在 CLI 里有六百多处引用,会改登录提示、子 agent 并发上限、可信设备注册,并关掉定时任务、远程会话等工具,代价和 goal 无关且难以评估。
- **读 CLI 的会话记录(`projects/…/<session>.jsonl` 里的 `goal_status` 附件)**:里面有设定、每次判断的理由和达成,能马上用。否决:依赖 CLI 的内部文件格式,SDK 升级可能悄悄失效;daemon 的历史原则也是不依赖 agent 自己的记录。
- **用 SDK 的 hook**:负责人问过。查了 0.3.327 的全部 hook 事件:`/goal` 本身是一个 Stop hook,我们的 Stop hook 和它并行,看不到它的判断;`UserPromptExpansion` 只能知道设了什么条件,不知道进展和达成;hook 能给的只有 `transcript_path`,最终仍是读会话记录。

## Consequences

- Claude 会话的 Overview 没有 goal 区块的数据;`/goal` 本身照常工作,只是界面看不到它的状态。
- 每次升级 Claude Agent SDK 时要跑 `harness/claude` 的 `test:real`,看 goal 用例是否开始收到更新;收到后把它改成必须收到并去掉"不支持"的说明。
- 未验证:云端容器以外是否有别的开关会让本地进程发 `active_goal`;只检查了 CLI 2.1.327 的二进制。
