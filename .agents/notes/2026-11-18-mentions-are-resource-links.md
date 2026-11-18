# Agent Note: An @ mention is text for people and a resource_link for the agent

Status: accepted
Date: 2026-11-18
Basis: The owner asked on 2026-11-18 whether a mention should reach the model as XML, which models read better ("llm 对 xml 格式的理解更好"). Evidence read: `packages/adapters/claude/src/content.ts` and decision 0010, which turn a `resource_link` into `[name](uri)`; old-cycle wrote mentions into the text as Markdown links because it was a transparent proxy.

## Problem

A mention needs a form on the wire, one a person reads in history, other clients and other agents understand, and the model reads well. Listing files for the picker is also a new way for the daemon to read the machine.

## Decision

- The composer sends the readable `@relative/path` in the text block and appends a `resource_link` block per distinct path (`file://` URI, a folder's ending in `/`). The structured block is the truth when a path has spaces.
- How the agent sees a `resource_link` is the adapter's choice. The Claude adapter writes it as an XML tag, replacing `[name](uri)` from decision 0010 for this one block type; the rest of 0010 stands. Whether XML reads better than the Markdown link is the author's judgement, not measured.
- `_cycle/files/search` lists paths only, inside the session's `cwd`: every candidate is resolved with `realpath` and kept only inside it, symlinks are not followed, and the walk is capped in entries and time. It serves only on the daemon's local socket or SSH channel.

## Alternatives considered

- XML written in the person's text: it would leave tags in history and tie L1 to one model's taste.
- A Markdown link in the text, as old-cycle did: only needed there because it could not add blocks.
- Sending file contents: large, and the agent can read the path.

## Consequences

- Both the `@` text and the block are in the log, so replays show what the person saw.
- Mentions share the 32-block prompt limit with images.

## Related

- [Decision 0010](../../docs/decisions/0010-attachments-inline.md) is historical and is not edited; this note replaces its `resource_link` rendering only.
