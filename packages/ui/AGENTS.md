# packages/ui

The interface: React components, and the model of a conversation they draw. Built with
[ui-sdk](https://ui-sdk.dev) (`@ui-sdk/react`, beta) and Streamdown for markdown. Not assistant-ui.

## ui-sdk

- The ui-sdk skill is installed in `.claude/skills/ui-sdk` (from `vercel-labs/ui`, recorded in
  `skills-lock.json`). **Follow it before using ui-sdk.** It is vendored: do not edit it. Update it with
  `bunx skills@latest update ui-sdk` and look at the diff.
- Read `node_modules/@ui-sdk/react/docs/llms.txt` first, then only the pages the task needs. When building
  a component ui-sdk does not ship, search `docs/core.md` by heading and read `docs/rendering.md` with it.
- `@ui-sdk/*` is pinned to an exact version. It is beta and its API can change: upgrade on purpose and
  re-run the tests.
- Put `@layer ui-sdk;` at the top of the global stylesheet.

## Design

- Interface work follows the project skill `.claude/skills/cycle-design-taste` (ours, not vendored): tokens only,
  every state drawn, plain copy, motion only to show a change, one icon set (iconmcp). Run
  `bun .claude/skills/cycle-design-taste/scripts/scan-copy.mjs` on a change to the interface's text.

## Controls

These hold for every control, whoever wrote its behaviour (from old-cycle's `packages/ui/AGENTS.md`, kept to what fits here).
The gate does not enforce them.

- Every control has a name a screen reader can say: its visible text, a `<label>` around it, or `aria-label`.
  A placeholder is not a name, and neither is a `title`.
- A group of controls has a name too (a segmented choice takes a label).
- A key handler that acts on Enter asks `isComposing(event)` from `@ui-sdk/core` first, not the event's own
  `isComposing`: Safari reports the Enter that confirms an input method's text as not composing. Chinese input is the case.
- A choice that runs without asking, like a mode that never asks for approval, is taken by a press, never by an
  arrow key that happens to land on it.
- A list whose rows can be added, removed or reordered is keyed by an id, not by its index.
- Text has 4.5:1 against what is behind it, and a control's edge, focus ring and state fill 3:1, in both themes.
  jsdom cannot measure colour: measure in the browser (the gallery) when a token changes.
- A choice list never shows a bare "Default" or "Recommended": it names the choice and marks it ("Auto (default)").
- A destructive confirmation opens with the focus on Cancel, so a second Enter removes nothing.

## Rules for this package

- The reducer that turns `session/update` into a conversation (`src/model/`) is pure TypeScript. It must not
  import React or anything DOM: the Electron main process uses it too.
- The gate keeps these boundaries (`scripts/boundaries.ts`, `tsconfig.model.json`, `tsconfig.renderer.json`): the model
  (`src/model/`, `src/api.ts`) sees no DOM, Node or Bun globals and imports only relative files and `@cycle/acp`; the
  page (`src/`, `apps/desktop/src/renderer`) sees the DOM but no Node or Bun, and imports no Node, Electron or daemon-side
  package; the preload imports only `electron` and `@cycle/ui/api`. Anything the page needs from the main process goes
  through the bridge in `api.ts`.
- Model output is untrusted: markdown from an agent can contain raw HTML, links and images. See
  `docs/desktop.md` for what is blocked.
