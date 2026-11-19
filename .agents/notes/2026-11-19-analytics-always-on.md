# Agent Note: 统计对用户默认开启、不可关闭、无感

Status: superseded
Date: 2026-11-19
Basis: 2026-11-19 用户在被问到"默认开启还是默认关闭"时答复:"默认开启,用户不能关闭,用户无感。同意"。
Superseded by: [统计默认开启、用户可以关闭](2026-11-19-analytics-opt-out-restored.md)

## Problem

上一个决定([产品埋点用 PostHog](2026-11-19-product-analytics-posthog.md))做了首次启动的说明和侧栏的开关,默认开、用户可关。产品方要求用户不能关闭、也感觉不到:要拿到完整的使用数据,不因用户关闭而缺样本。

## Decision

- 去掉首次启动说明、侧栏开关,以及页面与主进程之间关于开关的接口(`analytics`、`setAnalytics`)和 `analytics_toggled` 事件。`analytics.json` 里只剩匿名 id。
- 统计在有 PostHog key 时始终开启。
- 保留 `DO_NOT_TRACK` 和 `CYCLE_ANALYTICS=off` 环境变量:给开发者和 CI 用,不是给用户的入口,界面里没有。
- 因为用户无从选择,"只报行为,不报内容"(属性只能是数字、布尔、固定的词)成为唯一的保护,规则不放宽。
- 状态:曾实现,同一天被取代,见上。

## Alternatives considered

- 保留首次说明但没有开关:只告知、不给选择。用户已明确要"无感",没选。
- 默认开、用户可关(上一个决定):数据缺口来自选择关闭的用户。按产品要求取代。
- 默认关、用户主动开启:样本最少。没选。

## Consequences

- 数据完整,没有因关闭造成的样本偏差。
- **合规风险,未经法律意见确认:** 在欧盟(GDPR / ePrivacy)、中国(个人信息保护法)等地区,在用户不知情、不能拒绝的情况下收集使用数据,可能需要同意或告知,匿名 id 和设备信息也可能被视为个人信息。发布到这些地区之前应该有人确认,必要时恢复告知或开关。恢复的改动不大:代码历史里有现成实现(`AnalyticsNotice`、`AnalyticsSwitch`)的思路,见上一个笔记。
- 用户可能发现应用在联网并有疑问:隐私说明或发布说明里应当写明收集什么、不收集什么(`docs/analytics.md`)。
- PostHog 项目 key 提交在 `apps/desktop/src/shared/posthog.ts`(用户 2026-11-19 说明不用关心它的安全:它是公开的写入 key),美国区。
- 未验证:没有对真实的 PostHog 云发送过。

## Related

- 部分取代 [产品埋点用 PostHog](2026-11-19-product-analytics-posthog.md) 中"首次启动告知、侧栏可关"和 opt-out 的部分。
