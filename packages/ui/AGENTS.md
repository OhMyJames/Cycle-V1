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
