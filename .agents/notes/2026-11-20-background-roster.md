# Agent Note: 用 Claude 后台清单核对遗漏的终态

Status: accepted
Date: 2026-11-20
Basis: CYCL-114 与 CYCL-104 的依赖，及当前 Claude SDK 对 background_tasks_changed 的全量替换语义。

## Problem

某个任务长时间安静、主 turn 结束、具体结束通知丢失，在只看进度事件时无法区分。

## Decision

清单仍列出的后台子任务继续阻止空闲回收。已离开清单但缺少终态时，保留未知记录供用户标记为已结束。晚到的终态仍可补全工具行。

## Alternatives considered

按固定时长或 turn 边界清理会中断合法的后台工作。把离开清单直接显示为成功会丢失失败和取消的区别。

## Consequences

未知记录单独展示，不占用已确认运行的计数。这个判断依赖适配器的全量清单语义。见[协议 §6](../../docs/protocol.md)和[子 agent 通告决策](../../docs/decisions/0014-warm-start-and-subagents.md)。
