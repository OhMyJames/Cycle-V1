# Agent Note: Plan usage belongs to the account on the daemon's machine, not to a session

Status: accepted
Date: 2026-11-20
Basis: the owner asked for subscription usage and reset times in the context panel (2026-11-20) and agreed to the proposed placement. Probe of `@anthropic-ai/claude-agent-sdk` 0.3.327 against a mock API with a made-up OAuth token in a throwaway config directory: Claude Code emitted a `rate_limit_event` after every response, with `rate_limit_info.unifiedWindows` listing the 5-hour and 7-day windows (utilization 0–1, reset in seconds), also while `allowed`. With an API key it emitted none, and `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()` answered `rate_limits_available: false` both with an API key and with the token login.

## Decision

- The Claude adapter turns each changed `rate_limit_event` into a `session/update` of Cycle's own variant `_cycle/plan_usage` `{windows, at}`.
- The daemon takes that variant out of the session's stream: never logged, never given a seq, never forwarded as a session update. It keeps, in memory, each agent's limits one by one, each replaced only by a word of it that is not older (each session has its own Claude process, so an event about one limit, or an old process's word, must not undo a newer one from another), and tells every connection `_cycle/plan_usage_changed {agent, usage}`. `_cycle/plan_usage/read` answers what it has; the capability is `planUsage`.
- The client shows the windows it names (5-hour, weekly, weekly by model) under the context details, hides a window past its reset, and shows nothing for an agent that told none.

## Alternatives considered

- On the session's turn-end `usage_update` (`_meta`). Rejected: the numbers are the account's, so every session but the last one used would show stale ones, and they would be written into every session's history.
- The SDK's experimental usage request. Rejected: it gives nothing for the token login Cycle recommends (docs/getting-started.md), and its name says it may change or go.
- Keeping plan usage on disk across daemon restarts. Not done: a reset time makes old numbers wrong soon, and the next turn tells them again.

## Consequences

- After a daemon restart nothing shows until an agent's next response.
- `unifiedWindows` is not in the SDK's types; when it is absent only the window the event is about is shown.
- The real-subscription path was not run against Anthropic's API from this machine during the change (reading the local daemon's token was refused); the mock reproduces the headers Claude Code reads.
