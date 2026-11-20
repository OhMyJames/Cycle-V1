# Agent Note: A prompt sent while the agent works is queued by the daemon

Status: accepted
Date: 2026-11-18
Basis: The owner asked on 2026-11-18 for the composer to accept messages while a turn runs ("排队我觉得应该在 daemon 吧"), and chose that a stop returns the queued messages to the input box ("stop 的按照你倾向的那个来"). Evidence read: old-cycle's note `2026-11-11` set and its `client-queue` tests (a stop returns the queue with no error).

## Problem

Until now `session/prompt` on a busy session failed with `session_busy`, so the person could not write the next message while the agent worked. A queue has to survive a closed window, a dropped SSH tunnel and a second client, and has to say what a stop or an error does to what is waiting.

## Decision

- The daemon holds the queue and writes it to the session's JSONL as `_cycle/queue_update` snapshots; `entries` is state, `returned` is an event that a client acts on only when it arrives live. Wire details: [docs/protocol.md §8](../../docs/protocol.md).
- Queue entries have a daemon-made `queueId`. The agent makes the `messageId` of the message in history (the Claude adapter uses `randomUUID`), so the two are unrelated.
- The next prompt is sent only after `end_turn`. After anything else (cancel, error, `max_tokens`, `max_turn_requests`, `refusal`, a closed session, a daemon restart) the whole queue is returned to the composer and nothing is sent for the person.
- At most 8 entries.

## Alternatives considered

- Queue in the client: lost on a closed window or a second client; rejected for that.
- Queue in the agent (old-cycle did, and the Claude SDK can take streamed input): old-cycle had no choice, being a transparent proxy. Here the daemon owns history, and a daemon queue works the same for every agent.
- Send the next queued prompt after a stop: rejected. A stop usually means the person wants to change direction.

## Consequences

- Which client's input box takes `returned` when several are attached is open (protocol.md §13). 8 and "only `end_turn` continues" are the author's choices, not measured.
- A queued prompt appears in history as a `user_message` only when it is sent, so history order is the order things happened.

## Related

多窗口领取方式后来由[单一领取者决策](2026-11-20-queue-return-recipient.md)确定。
