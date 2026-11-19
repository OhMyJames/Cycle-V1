# Agent Note: 统计默认开启、用户可以关闭,首次启动告知

Status: accepted
Date: 2026-11-19
Supersedes: [统计对用户默认开启、不可关闭、无感](2026-11-19-analytics-always-on.md)
Basis: 2026-11-19 用户在被告知"用户不能关闭"有合规风险(GDPR/ePrivacy、个人信息保护法)后答复:"那就默认开启,用户可以关闭吧"。

## Problem

上一个决定让统计对用户不可关闭、无感,数据完整,但用户不知情也不能拒绝,在欧盟和中国等地区可能不合规,而且没有法律意见确认过。

## Decision

- 统计默认开启,用户可以关闭。首次启动在页面顶部说明一次(统计什么、不统计什么、可在设置菜单里关闭),"Turn off" 和 "Keep on" 都算回答,之后不再出现。
- 侧栏底部的设置菜单里有 "Turn off usage statistics" 一项,随时可改;关闭时最后发出一条 `analytics_toggled`,之后什么都不发。选择存在 `userData/analytics.json`。
- `DO_NOT_TRACK` 和 `CYCLE_ANALYTICS=off` 保留,设了就不创建、不发送,界面里也不显示开关。
- "只报行为,不报内容"规则不变。PostHog、主进程发送、key 的位置(`apps/desktop/src/shared/posthog.ts`,美国区)不变。
- 状态:已实现(恢复了被上一个决定删掉的说明和开关)。

## Alternatives considered

- 不可关闭、无感(上一个决定):数据最完整,但有合规风险。被取代。
- 默认关闭、用户主动开启:最稳妥,但样本很少。没选;如果将来进入同意要求更严的地区,再改成这个。

## Consequences

- 选择关闭的用户不在数据里,有样本偏差,但他们的选择被尊重。
- 默认开启(opt-out)在要求事先同意的地区(如欧盟)仍可能不够,发布到那里之前需要法律确认。未经确认。
- 仍然没有对真实的 PostHog 云发送过。

## Related

- 取代 [统计对用户默认开启、不可关闭、无感](2026-11-19-analytics-always-on.md);原始决定见 [产品埋点用 PostHog](2026-11-19-product-analytics-posthog.md)。
