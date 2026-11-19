# Agent Note: A prompt sent while the agent works can go into the running turn (steer)

Status: accepted
Date: 2026-11-19
Basis: The owner asked on 2026-11-19 for "插队" beside the queue: "shift + 回车是 排队，回车是插队". The question of which key makes a new line while the agent works was put to the owner and not answered; Alt+Enter is the author's choice. Evidence read: old-cycle's `harness/claude/src/claude-harness.ts` (`steer`, `user_message_uuids`) and its integration test "a turn can be stopped, and steered while it works"; the Agent SDK 0.3.327 types (`SDKUserMessage.priority`, `uuid`; `user_message_uuids` on results).

## Problem

Until now a prompt sent during a turn was always queued by the daemon ([queue note](2026-11-18-prompt-queue-in-the-daemon.md)) and reached the agent only after `end_turn`. A correction that matters now ("not that file") had to wait for the whole turn, or the person had to stop it and lose the work in flight.

## Decision

- `session/prompt` with `_meta["cycle/steer"]: true` puts the prompt into the running turn. An agent says it can with `steer: true` in its definition and in `_cycle/agents/list`; the daemon says it understands with `steer: true` in its capabilities. Wire details: [docs/protocol.md §8](../../docs/protocol.md).
- The daemon forwards it to the agent with the same `_meta`. If the agent cannot take it (does not declare it, refuses, has no process), the daemon queues it as before, or sends it if the turn has just ended. A steer never fails where a queue would have worked.
- A steered prompt appears in history as a `user_message` when the agent takes it, in the middle of the turn. It does not touch the queue.
- Claude adapter: the message is pushed into the live process with `priority: "next"` and its own `uuid`; the main prompt also carries its `uuid`. A `result` whose `user_message_uuids` does not contain every steered uuid does not end the turn: Claude answers the rest itself in the same process, and the turn ends with one `idle` after that. A stopped turn that still holds an untaken steer kills the process, so Claude does not answer it after the stop with no turn to show it in; the next prompt resumes the session in a new process.
- Desktop: while the agent works and the agent and daemon can steer, Enter steers and Shift+Enter queues; Alt+Enter is a new line. When idle, Enter sends and Shift+Enter is a new line, as before. With no steer, Enter queues while working, as before.

## Alternatives considered

- "插队" as the front of the daemon's queue: rejected. The queue is usually empty or one deep, so this would differ from queueing in almost no case the person cares about.
- Stop the turn, then send: rejected. It throws away the tool call in flight; the queue note already chose not to act for the person after a stop.
- Finish the turn at the first `result` and let the steered prompt start the next turn: rejected. Claude goes on with it in the same process without a new `session/prompt`, so its output would arrive with no turn to own it.

## Consequences

- Real-CLI integration tests cover both cases: a steer folded in at a tool call, and one that arrives as the model finishes its answer. Both end in one `idle`.
- A steer killed by a stop is in history as a `user_message` that the model may never have seen. Taking it back into the composer the way `returned` queue entries are was not done.
- The keys are the author's guess where the owner did not answer: Alt+Enter for a new line while working, Ctrl/Cmd+Enter still send.
