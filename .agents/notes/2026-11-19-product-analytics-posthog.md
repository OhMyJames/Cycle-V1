# Agent Note: 产品埋点用 PostHog,在主进程发送,只报行为不报内容

Status: accepted
Date: 2026-11-19
Basis: 2026-11-19 用户要求给 Cycle 前端加用户行为埋点用于产品分析,并确认"选 PostHog、主进程发送、不上报内容";要求之后所有开发都加埋点。

## Problem

要知道用户怎么使用 Cycle(功能使用、漏斗、留存、连接稳定性)来改产品。但 Cycle 里几乎所有文字都是用户的代码、路径、对话和 agent 的输出,可能含密钥和公司机密;一旦发到第三方就收不回。agent 还能执行命令,所以任何能到 agent 手里的密钥或出网能力都是风险。

## Decision

- 用 PostHog 云(免费额度约每月 100 万事件),通过 `posthog-node` 在 Electron **主进程**发送。页面不引入 PostHog,不直接联网;daemon 不出网。
- 新包 `@cycle/analytics`:事件字典(zod `strictObject`)、`Analytics` 接口、PostHog 适配。字典里**属性只能是数字、布尔、固定的词**;不允许 `z.string()`。字典外的事件和属性一律丢弃。
- 页面只能报三个自己才看得到的事件(`UI_EVENTS`),其余由主进程在动作成功后发,页面伪造不了。
- 匿名随机 id;不建 person profile,不做 IP 定位;不开 autocapture、会话回放、异常自动收集。
- 默认开、首次启动告知、侧栏可关;`DO_NOT_TRACK` / `CYCLE_ANALYTICS=off` 直接关;没有 key(从源码运行、测试)就不创建、不发送。
- key 在构建时写进 `build.json`(PostHog 项目 key 是公开的),只在主进程;agent 环境是白名单,不继承。
- 规则写进 AGENTS.md:新增用户可感知的功能要同时加埋点;`docs/analytics.md` 是字典的文档,门禁检查两边一致。

状态:已实现(见 `docs/analytics.md`),项目 key 在 `apps/desktop/src/shared/posthog.ts`,只由 `package` 写进安装版。

## Alternatives considered

- Aptabase(开源、为桌面应用设计、隐私友好):更轻,但免费额度小(约每月 2 万事件)、分析维度少,没有漏斗和留存。没选。
- Umami / Plausible:偏网站流量统计,Electron 里要手写 HTTP,产品分析弱。没选。
- 自托管 PostHog:依赖 ClickHouse、Kafka、Postgres,目标机器是 2 核 4 GB,带不动。没选;云版的 EU 区域可以解决数据所在地的问题。
- 在页面里用 `posthog-js`:有 autocapture 和会话回放,会抓到界面上的代码和对话;页面被设计成没有网络、不被信任(agent 的输出会渲染在里面)。没选。
- 事件属性允许自由字符串、靠"约定"不放内容:约定会被一次疏忽打破,而发出去无法撤回。没选,改为字典在类型和运行时都拒绝自由文字。

## Consequences

- 新功能多一步:加事件、加文档行、加测试。代价小,换来可以看到功能有没有人用。
- 字典不允许自由文字,所以一些分析做不了(哪个仓库、哪个报错信息、哪个具体命令)。要做就必须单独决定,不能顺手加。
- 默认开启(opt-out):比 opt-in 的数据完整,但需要首次启动说明和开关,已做。如果将来要进入有更严格同意要求的地区,需要改成 opt-in。
- 未验证:没有对真实的 PostHog 云做过发送(测试只对本机假服务验证了发出的内容);发布前需要设置真实 key 并在 PostHog 里看一次事件到达。
- 新增一个运行时依赖 `posthog-node`(进主进程包,约 +0.4 MB)。

## Related

- 红线:agent 不继承环境变量;daemon 只绑 loopback(AGENTS.md)。
- 同一天曾改成不可关闭([笔记](2026-11-19-analytics-always-on.md)),随后又恢复为可关闭([笔记](2026-11-19-analytics-opt-out-restored.md)),所以本笔记里的"默认开、首次告知、侧栏可关"现在仍然成立。
