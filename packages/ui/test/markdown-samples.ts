// Fixed samples of agent Markdown (CYCL-53): what an answer of Claude's holds in practice, for the gallery to draw and the
// DOM tests to check, so that how a reply reads is compared on the same text each time.

/** Sixty lines: longer than a block is shown whole. */
export const LONG_CODE_LINES = 60;
const longCode = Array.from({ length: LONG_CODE_LINES }, (_, n) =>
  n === 0
    ? "export function retry(attempt: number): number {"
    : n === LONG_CODE_LINES - 1
      ? "}"
      : `  // step ${n}: wait ${250 * 2 ** Math.min(n, 4)} ms before attempt ${n + 1}`,
).join("\n");

/** One answer with every kind of block a reply uses: headings, lists in lists, a quote, a rule, a long block, a wide table. */
export const READING = [
  "## What changed",
  "",
  "The reconnect path had **two** problems. Both are fixed in `apps/daemon/src/connection-manager.ts`; the tests are in `apps/daemon/test/reconnect.test.ts`.",
  "",
  "1. The client gave up after the first failure.",
  "   - It now waits 250 ms, then doubles the wait.",
  "   - The wait stops growing at 5 s.",
  "2. A turn that was going when the link dropped was lost.",
  "3. The status line said *connected* before the session was loaded.",
  "",
  "### Still to do",
  "",
  "- [x] Retry with backoff",
  "- [ ] Show the attempt count in the status line",
  "",
  "> The daemon keeps the log, so nothing the agent said while the client was away is lost.",
  "",
  "---",
  "",
  "| Case | Before | After | Notes |",
  "| --- | --- | ---: | --- |",
  "| link drops mid-turn | turn lost | 0 lost | replays from `/home/dev/.cycle/sessions/5b0e8a7c-3f41-4c2e-9d4a-0a35c0de0034.jsonl` |",
  "| daemon restarts | hangs for 30 s | 1.2 s | the socket is recreated |",
  "| laptop sleeps | 2 reconnects | 1 | |",
  "",
  "The tests, run again:",
  "",
  "```",
  "$ bun test apps/daemon/test/reconnect.test.ts",
  " 3 pass",
  " 0 fail",
  "```",
  "",
  "The retry, in full:",
  "",
  "```ts",
  longCode,
  "```",
  "",
  "See [the protocol](https://example.com/docs/protocol#reconnect), the file [connection-manager.ts](apps/daemon/src/connection-manager.ts), or https://example.com/issues/71 for the history.",
].join("\n");

/** The same answer cut inside its code block, as it is while it streams. */
export const READING_STREAMING = READING.slice(0, READING.indexOf("  // step 9"));
