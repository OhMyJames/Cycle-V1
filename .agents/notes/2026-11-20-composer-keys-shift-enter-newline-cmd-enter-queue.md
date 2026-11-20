# Agent Note: In the composer Shift+Enter is always a new line and ⌘Enter queues

Status: accepted
Date: 2026-11-20
Basis: The owner's word on 2026-11-20 (CYCL-54 review): "输入区域换行事件是 shift + 回车，但是现在它还占了排队，排队应该改成 cmd+回车". Replaces the desktop keys of [steer into the running turn](2026-11-19-steer-into-the-running-turn.md), which the owner had left to the author ("Alt+Enter is the author's choice").

## Problem

With steer, Shift+Enter queued while the agent worked and was a new line otherwise. The same key did two different things depending on a state the person may not be watching. A new line while working needed Alt+Enter, which nobody expects.

## Decision

- Enter sends. While the agent works it steers where the agent and daemon can, and queues where they cannot. The steer note's wire behaviour is unchanged.
- ⌘Enter (Ctrl+Enter off a Mac) queues while the agent works and sends when it does not.
- Shift+Enter is a new line in every state. Alt+Enter stays a new line too.
- While a permission request waits, ⌘Enter is still the card's "Allow once" (an existing app shortcut). The composer leaves it to the window rather than queueing.
- With a slash or @ menu open, only a plain Enter picks, as before.

## Alternatives considered

- Keep Shift+Enter to queue only while steering, and Alt+Enter for a new line (the 2026-11-19 choice). Rejected by the owner: a new line key that changes meaning with the agent's state.
- Give ⌘Enter to the queue even while a permission waits. Not taken: it would silently stop working as "Allow once", which people already use there.

## Consequences

- No key queues while a permission waits, apart from Enter when the agent cannot steer. The Queue button still does.
- The placeholder and the Queue button's tooltip name ⌘Enter. docs/desktop.md and the steer note's Related point here.
