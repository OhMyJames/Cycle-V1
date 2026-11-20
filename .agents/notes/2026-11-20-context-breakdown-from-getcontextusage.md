# Agent Note: The context details show what the window holds, as Claude Code's /context counts it

Status: accepted
Date: 2026-11-20
Basis: the owner asked for the context popover to read like Claude Code's `/context` (a total, a bar, a row a part, no explanatory text) on 2026-11-20, after the first version shipped. Probe of `@anthropic-ai/claude-agent-sdk` 0.3.327 against a mock API in a throwaway config directory: `getContextUsage({detail: "summary"})` answered in about 5 ms after a turn, with no API call, and its total equalled the last response's usage. Supersedes the "no per-category breakdown" part of 2026-11-20-effort-default-and-context-usage-sources.md.

## Problem

The first details listed used, window, cost and compactions, plus a paragraph explaining that the window is the model's and Claude Code may compact earlier. The owner found the paragraph noise and wanted the parts. The earlier note had deferred `getContextUsage()` for three reasons: an extra control request per turn, estimated categories, and a window (`rawMaxTokens`) that differs from the model's `contextWindow`, so two percentages would disagree.

## Decision

- At the end of each turn, before the usage is told, the Claude adapter asks the turn's process `getContextUsage({detail: "summary"})`, waiting at most 2 s. The answer goes on that `usage_update` as `_meta["cycle/context"] = {window, parts, autoCompactAt?}`, and its `window` becomes the update's `size`. Without an answer the usage is as before.
- Asked while the turn is still the running one, so nothing of a next turn can come before its end.
- The client names parts by `id` in its own words and falls back to the agent's `name`; it leaves out `deferred` parts (not in the window); it shows parts only for the usage that carried them, never after a compaction.
- The popover is numbers only. A line of words appears only for a state with no number: nothing reported, compacting, from before the last compaction.

## Why the earlier reasons no longer hold

- The extra request is local and takes milliseconds in `summary` mode; `full` (one token-count API call per category) is not used.
- The parts are estimates, but the total is still the measured one; `messages` is the remainder, as in Claude Code.
- Using the SDK's window as `size` makes the ring, the total and every part agree, and it is the window Claude Code compacts against, which is what the person needs to see coming.

## Consequences

- On a 1M model that Claude Code compacts at 200K, the ring now reads against 200K once a turn has ended in this process.
- The usage told right after a compaction (from `post_tokens`) has no parts; they come with the next turn's end.
- A session opened before any turn has no parts and no total. Asking a warm process for its baseline (system prompt and tools, about 10K in the probe) before the first prompt is possible and not done.
- Plan limits (Claude Code's `/usage`, `getUsage()`) are a separate request and not part of this.
