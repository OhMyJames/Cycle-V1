# Agent Note: Effort "default" stays honest, and context usage is only what the SDK reported

Status: accepted
Date: 2026-11-20
Basis: CYCL-72 research (2026-11-20) against `@anthropic-ai/claude-agent-sdk` 0.3.327 and the owner's go-ahead on the proposed protocol scope the same day. Lessons from old-cycle's notes `2026-11-08-claude-effort-default-high.md` and `2026-11-10-context-inspection-and-turn-summaries.md` (read only; no code taken).

## Problem

The composer shows the session's effort and a context ring, and CYCL-74 opens the ring into details. Both need numbers and labels that are true. The SDK does not say which level runs when no effort is set, it reports context usage only at the end of a turn (and once more in `compact_boundary.post_tokens`, which is optional), and its per-category breakdown (`getContextUsage()`) is a separate control request.

## Decision

- `effort: "default"` means "Cycle does not override". It is shown as the model's default, never as a concrete level. Which levels a model takes comes from `ModelInfo.supportsEffort` / `supportedEffortLevels`, carried on each model choice as `_meta["cycle/efforts"]` (`[]` none, absent unknown) and cached by the daemon for the new-session page. When unknown, every level is offered and the SDK decides; when the catalog arrives, an unsupported value goes back to `default`.
- `usage_update` is sent at the end of each turn and, when `compact_boundary` carries `post_tokens`, right after `compaction_update: completed`, with the window from the process's last usage and no cost. Without `post_tokens` nothing is sent; a client treats the usage it has as from before the compaction.
- No per-category breakdown, cache split or compaction count fields now. Details show used, window, cost and compaction state only. (Superseded the same day for the breakdown: 2026-11-20-context-breakdown-from-getcontextusage.md.)

Spec: docs/protocol.md §8 "上下文用量" and §10 "思考强度".

## Alternatives considered

- Showing an unset effort as High and setting High before the first prompt (old-cycle, 2026-11-08). Rejected here: sessions would run at a level the owner's own Claude settings did not choose, and old-cycle found the resume race where setting during a momentary `default` overwrote the session's real level. The daemon already restores the recorded level on resume, before anything else is sent.
- Calling `getContextUsage({detail: "summary"})` after each turn for categories (old-cycle's `_cycle/context/inspect`). Deferred: an extra control request per turn, categories are estimates, and its window (`rawMaxTokens`, the autocompact window) differs from `contextWindow`, so two percentages would disagree on screen.
- Estimating the post-compaction usage when `post_tokens` is missing. Rejected: a made-up number in the ring is worse than saying it is from before.

## Consequences

- The ring's window is the model's nominal `contextWindow`; Claude Code may compact earlier (for example at 200K on a 1M model), so the ring can read well under 100% when a compaction starts. The details say the window is the model's.
- Per-category usage needs a protocol addition later (a `_meta` on `usage_update` or a request), with the window question settled first.
- One effort value per session, not per model: switching to a model without that level resets it to `default` rather than remembering it.
