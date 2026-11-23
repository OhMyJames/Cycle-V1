# Agent Note: an update's time is its log record's `ts`, sent as ISO 8601

Status: accepted
Date: 2026-11-22
Basis: UX parity batch 1 (2026-11-22): message timestamps and "Thought for Ns" need when each record happened, live and replayed.

## Problem

Forwarded `session/update`s carried only `_meta["cycle/seq"]`. A client could only stamp updates with the time it received them, which is wrong for a replay (everything would look like "just now") and for a reconnect (a burst of old records).

## Decision

Every forwarded `session/update` that has a log record carries `_meta["cycle/ts"]`: that record's `ts`, copied verbatim (ISO 8601, UTC, millisecond precision), in live delivery and in replay alike (docs/protocol.md §5). Synthesized updates (attach snapshot, `replay_complete`, the write-failure idle) carry none. `@cycle/protocol`'s `tsOf` turns it into epoch milliseconds for clients; the UI model keeps per item `at` (first record) and, for messages, `lastAt` (last chunk). A missing or malformed value is "unknown": never the receive time, never 0.

## Alternatives considered

- Epoch milliseconds on the wire: smaller, but a second encoding of the same fact; the log and `session/list`'s `updatedAt` already use ISO, so the daemon copies rather than converts, and the three can be compared as strings.
- Client-side receive time: wrong for every replayed record, which is most of what a reopened session shows.

## Consequences

Old daemons send no `cycle/ts`; clients show no time rather than a made-up one. The time is the daemon's clock, not the agent's or the client's; a remote daemon with a skewed clock shows skewed times, the same skew `updatedAt` already has. `applyUpdate` takes the time as `{ at }`, not a bare number, so `updates.reduce(applyUpdate)` cannot pass an array index as a time.
