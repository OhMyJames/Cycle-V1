# Agent Note: The composer is a Markdown editor whose text is the prompt

Status: accepted
Date: 2026-11-18
Basis: The owner decided on 2026-11-18 that real-time Markdown in the composer is part of this round ("实现 markdown 放到这一轮"). Evidence read: old-cycle's note `2026-11-07-composer-markdown`, which chose Lexical and recorded what it cost.

## Problem

A textarea cannot style part of its text. Rendering Markdown while it is typed needs an editor that holds a document, and the text the agent receives, which drafts and the queue also store, then has to be written from that document without changing what the person typed.

## Decision

- The input is a Lexical editor whose document is read and written as Markdown by pure functions in `packages/ui`, tested for round trips. The prompt's text block is that Markdown.
- Text is sent as typed: `my_file.py`, `foo\.bar` and `2*3*4` must come back unchanged. The functions keep Lexical's escaping and unescaping out of the text, as old-cycle did with stand-in characters.
- Enter sends, Shift+Enter is a new line, an Enter that confirms an IME composition is not a send. `/` commands start only at the beginning of the text; `@` starts after whitespace or at the start of a line.
- Drafts are text only, kept in the renderer's localStorage by host and session, cleared on send and on delete. Images are not kept.

## Alternatives considered

- Keep the textarea: simplest, but no live Markdown, which the owner asked for.
- Styled source (CodeMirror): no conversion, so nothing is lost; the owner's choice in old-cycle was WYSIWYG, and the same preference is assumed here.
- Draft stored by the daemon: works across clients, but needs protocol and storage; deferred.

## Consequences

- The text may not come back exactly as typed for syntax Lexical normalises (`* item` becomes `- item`); the round-trip tests list what changes.
- Lexical is a pinned dependency and is upgraded as a set.
- Not verified at the time of writing: Lexical under the project's DOM test runner and the 4 GB gate budget.
