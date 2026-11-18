# Agent Note: The composer is a Markdown editor whose text is the prompt

Status: accepted
Date: 2026-11-18
Basis: The owner decided on 2026-11-18 that real-time Markdown in the composer is part of this round ("实现 markdown 放到这一轮"). Evidence read: old-cycle's note `2026-11-07-composer-markdown`, which chose Lexical and recorded what it cost.

## Problem

A textarea cannot style part of its text. Rendering Markdown while it is typed needs an editor that holds a document, and the text the agent receives, which drafts and the queue also store, then has to be written from that document without changing what the person typed.

## Decision

- The input is a Lexical editor whose document is read and written as Markdown by pure functions in `packages/ui`, tested for round trips. The prompt's text block is that Markdown.
- Text is sent as typed: `my_file.py`, `foo\.bar`, `2*3*4` and a pasted `**x**` must come back unchanged. Lexical rewrites several characters when it reads and writes Markdown, so `composer-markdown.ts` swaps `\`, `&` and `_` for private-use stand-ins while it reads, and `\`, `&`, `_`, `*`, backtick and `~` while it writes (the characters of a text node are text; its formatting is its flags), as old-cycle did for fewer. A character of that range already in the text is escaped, so the swap is reversible for any text. Underscores never format; links are not a node.
- Enter sends, Shift+Enter is a new line, an Enter that confirms an IME composition is not a send. `/` commands start only at the beginning of the text; `@` starts after whitespace or at the start of a line.
- Drafts are text only, kept in the renderer's localStorage by host and session, cleared on send and on delete. Images are not kept.

## Alternatives considered

- Keep the textarea: simplest, but no live Markdown, which the owner asked for.
- Styled source (CodeMirror): no conversion, so nothing is lost; the owner's choice in old-cycle was WYSIWYG, and the same preference is assumed here.
- Draft stored by the daemon: works across clients, but needs protocol and storage; deferred.

## Consequences

- Round-trip tests (fixed cases, and random text) show the text coming back as typed for the cases listed there, including `* item` (the list marker is kept). Syntax with no node (a table) stays text. What was not tried: every Markdown construct Lexical may normalise.
- Lexical is a pinned dependency and is upgraded as a set.
- Lexical runs headless in the gate's tests and in happy-dom. happy-dom has no selection or input events for it, so DOM tests drive the editor through its commands, and real typing, IME and pasting are checked only in the Electron smoke test.
