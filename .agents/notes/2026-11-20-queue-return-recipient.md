# Agent Note: 队列退回由一个已附着的客户端确认

Status: accepted
Date: 2026-11-20
Basis: CYCL-113 要求同一会话的两个窗口只还原一份草稿，并能在领取者断线后找回。

## Problem

队列快照需要广播。把退回内容也作为普通实时更新广播，会让每个窗口都还原一份草稿。

## Decision

daemon 按附着顺序只向一个已结束回放的连接交付一批。批次与确认记入 JSONL，新客户端在还原草稿后确认。重启或领取者断线时重新交付未确认的批次。

## Alternatives considered

绑定原发送者会让其他窗口依赖已离线的窗口回来。只在本机存去重标记无法协调两台连接同一个 daemon 的机器。

## Consequences

确认在网络中丢失时允许重投，同一草稿按 queueId 去重。旧客户端只支持通知送达时确认。详见[协议 §8](../../docs/protocol.md)。

## Related

补充[队列决策](2026-11-18-prompt-queue-in-the-daemon.md)中留待确定的多窗口规则。
