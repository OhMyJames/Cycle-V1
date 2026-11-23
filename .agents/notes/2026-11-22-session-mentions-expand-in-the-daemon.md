# Agent Note: An @ mention of another session is expanded by the daemon into a short record, not read by a tool

Status: accepted
Date: 2026-11-22
Basis: The UX parity brief of 2026-11-22 (batch 1) asked for @-mentioning another session, preferring "the simplest robust approach", a daemon expansion into an embedded text resource, or a read-session tool if clearly better. Evidence read: cycle_v2's `.agents/notes/2026-11-12-cycle-tools-in-every-session.md` (its owner chose a `ReadSession` MCP tool there), shrimpdot-durable's `chat-mentions.tsx` (a tag the model reads, then calls `session_send`), and v1's `apps/daemon/src/daemon.ts`, `harness/claude/src/content.ts`.

## Problem

A prompt may name another session so the agent can use what was said there. The agent has to get that conversation somehow, the history has to keep what the person wrote (not a copy of another conversation), and the way chosen is a wire format (`cycle://session/<id>`) and a security boundary (what the agent may read).

## Decision

- The mention is a `resource_link` to `cycle://session/<id>`, like a file mention a readable `@name` in the text plus the link.
- The daemon, when it hands the prompt to the agent (send, queued send, steer), replaces the link in place by a record of that session read from its own JSONL log: the person's words and the agent's replies only, at most 4,000 characters a message and 40,000 in all, the oldest messages dropped first. An embedded `resource` where the agent takes `embeddedContext`, a `text` block otherwise. An id not in the daemon's index (unknown, deleted), an unreadable log, or the session itself becomes a one-line note to the agent; the prompt is never refused for it.
- The block put in carries the link in `_meta["cycle/expandedFrom"]`; before the agent's `user_message` echo is written, the daemon puts the link back. The log, replays and other clients see the mention.
- Only sessions in this daemon's index can be read, looked up by id, never as a path.

## Alternatives considered

- A read-session tool (cycle_v2's `ReadSession`). It lets the agent page back on demand and costs nothing when unused, but v1 has no daemon-side MCP server for the agent: it would need a new server given to every session (MCP servers are fixed at session start), a gateway, pre-approval rules, and the same read logic. A one-shot snapshot needs none of that and works for any ACP agent.
- Leaving the link for the agent to resolve (shrimpdot's tag). The agent has no way to read Cycle's log without a tool.
- Expanding in the client. The client may hold only a page of the history, and would send the record through the log as the person's words.
- Writing the record into the history. It would show another conversation as what the person said and grow every log that mentions one.

## Consequences

- Each mention costs up to about 10k tokens of context on that turn, used or not; the agent cannot ask for more than the newest 40,000 characters.
- It is a snapshot at the moment of sending; a queued prompt is expanded when it leaves the queue.
- An agent that echoes a prompt without its blocks' `_meta` would get the record into its history; the Claude adapter keeps `_meta`. Not checked against other agents.
- The Claude adapter writes the embedded resource as `<file uri="cycle://session/…">`; the record's first sentence says what it is. Whether a model reads it better as a tool result is not measured.
- Any session can read any other session of the same daemon (the owner's own, on one machine, read-only), as with cycle_v2's tool.

## Related

- [Mentions are resource links](2026-11-18-mentions-are-resource-links.md): the file and folder mention form this follows.
- docs/protocol.md §8 "提及(@)另一个 session".
