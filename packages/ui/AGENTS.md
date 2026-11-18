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

## Rules for this package

- The reducer that turns `session/update` into a conversation (`src/model/`) is pure TypeScript. It must not
  import React or anything DOM: the Electron main process uses it too.
- Model output is untrusted: markdown from an agent can contain raw HTML, links and images. See
  `docs/desktop.md` for what is blocked.
