// The gallery's scenarios: one state of the interface each, drawn by the real components over a scripted
// bridge. DESIGN.md says what each is for. Add one when a surface gets a new state.
import type { SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";
import type {
  AppEvent,
  EnvironmentConfig,
  EnvironmentStatus,
  PermissionRequest,
  SessionSnapshot,
  SessionSummary,
  UpdateState,
} from "../src/api.ts";
import { type CodeThemeId, codeTheme } from "../src/code-theme.ts";
import { applyUpdate, emptyConversation } from "../src/model/index.ts";
import { thinking } from "../src/thinking.ts";
import {
  BEFORE_DROP,
  OLD_UPDATES_SENT,
  PARALLEL,
  PARALLEL_PROMPT,
  RECONNECT_PROMPT,
  turnOf,
  WHILE_AWAY,
} from "../test/samples.ts";
import { SAMPLE_PNG } from "./sample-image.ts";

export type Scenario = {
  title: string;
  environments?: EnvironmentConfig[];
  status?: EnvironmentStatus[];
  sessions?: SessionSummary[];
  /** The conversation of the session that is opened. Without it nothing is opened. */
  history?: SessionUpdate[];
  permissions?: PermissionRequest[];
  update?: UpdateState;
  /** The agent takes images: the composer shows how to attach them. */
  attach?: boolean;
  /** The environment has no available agent: the blank view explains why and offers a re-check. */
  noAgents?: boolean;
  /** Folder trust: the daemon keeps it, and this is the decision for every folder (null: nobody has decided). */
  trust?: boolean | null;
  /** Presses Tab this many times with real input events, so :focus-visible shows as it does for a keyboard. */
  tabs?: number;
  /**
   * A blank conversation is opened, in this folder. `starting`: this first message is sent, and the session it makes is
   * never answered, so that the page stays as it is while a session is being made.
   */
  blank?: { cwd?: string; starting?: string };
  /** Runs once the page has drawn: open a dialog, press a key, or send an event as the app's main process would. */
  after?: (root: HTMLElement, emit: (event: AppEvent) => void) => Promise<void>;
};

const u = (update: object) => update as SessionUpdate;

// For the scenarios that act on the page after it has drawn: wait for a condition, and fail loudly if it never comes.
const until = async (condition: () => boolean, what: string, ms = 4000) => {
  for (let waited = 0; waited < ms; waited += 25) {
    if (condition()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`gallery: timed out waiting for ${what}`);
};
const frames = async (n: number) => {
  for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(() => r(undefined)));
};
const conversationOf = (root: HTMLElement): HTMLElement => {
  const el = root.querySelector<HTMLElement>('[data-slot="conversation"]');
  if (el === null) throw new Error("gallery: no conversation on the page");
  return el;
};
const drawnIn = (el: HTMLElement): number => el.querySelectorAll('[data-slot="block"]').length;
const LOCAL: EnvironmentConfig = { id: "local", name: "This computer", kind: "local" };
const BUILD: EnvironmentConfig = {
  id: "build",
  name: "build-1",
  kind: "remote",
  transport: { type: "ssh", host: "build-1" },
};
const UP = (environmentId: string): EnvironmentStatus => ({ environmentId, state: "connected" });

const session = (id: string, over: Partial<SessionSummary> = {}): SessionSummary => ({
  environmentId: "local",
  sessionId: id,
  cwd: "/home/dev/cycle-v1",
  archived: false,
  agent: "claude",
  state: "idle",
  lastSeq: 1,
  // What a session made since the daemon records its settings has: the composer shows them.
  config: { mode: "auto", model: "default" },
  ...over,
});

const say = (id: string, t: string) =>
  u({ sessionUpdate: "agent_message", messageId: id, content: [{ type: "text", text: t }] });
const you = (id: string, t: string) =>
  u({ sessionUpdate: "user_message", messageId: id, content: [{ type: "text", text: t }] });
const tool = (id: string, name: string, status: string, rawInput: object) => [
  u({ sessionUpdate: "tool_call_update", toolCallId: id, name, status: "pending" }),
  u({ sessionUpdate: "tool_call_update", toolCallId: id, status, rawInput }),
];
/** A finished call with the result an agent sent for it: its content, rawOutput and locations. */
const done = (id: string, name: string, rawInput: object, result: object) => [
  u({ sessionUpdate: "tool_call_update", toolCallId: id, name, status: "pending" }),
  u({ sessionUpdate: "tool_call_update", toolCallId: id, status: "in_progress", rawInput }),
  u({ sessionUpdate: "tool_call_update", toolCallId: id, status: "completed", ...result }),
];
const text = (t: string) => [{ type: "content", content: { type: "text", text: t } }];
const diff = (path: string, created: boolean, hunks: string) => ({
  type: "diff",
  changes: [{ operation: created ? "add" : "modify", path }],
  patch: {
    format: "git_patch",
    text: `diff --git a/${path} b/${path}\n${created ? "--- /dev/null" : `--- a/${path}`}\n+++ b/${path}\n${hunks}`,
  },
});
const idle = (extra: object = {}) => u({ sessionUpdate: "state_update", state: "idle", ...extra });
const running = () => u({ sessionUpdate: "state_update", state: "running" });

const MARKDOWN = [
  "The build fails in two places. Both come from the same change.",
  "",
  "| File | Problem |",
  "| --- | --- |",
  "| `packages/daemon/src/daemon.ts` | the cwd is not checked |",
  "| `apps/daemon/src/proxy.ts` | the log is not kept |",
  "",
  "```ts",
  "if (!(await stat(params.cwd).then((s) => s.isDirectory(), () => false)))",
  '  throw new RpcError(INVALID_PARAMS, "The working directory does not exist");',
  "```",
  "",
  "- check the directory first",
  "- keep the daemon's output in a file",
].join("\n");

const LONG_PATH = `/home/dev/${"very-long-directory-name-".repeat(12)}file.ts`;

const CODE = [
  "Here is the same change in four languages.",
  "",
  "```ts",
  "export const toolSummary = (tool: ToolItem): string => {",
  "  // A line saying what a tool is doing.",
  "  const input = (tool.rawInput ?? {}) as Record<string, unknown>;",
  '  return typeof input.command === "string" ? input.command : "";',
  "};",
  "```",
  "",
  "```bash",
  'bun run check && git commit -m "ui: search" # the gate runs first',
  'for f in *.ts; do echo "$f"; done',
  "```",
  "",
  "```json",
  '{ "name": "cycle", "version": "0.1.1", "private": true, "scripts": { "check": "bun scripts/check.ts" } }',
  "```",
  "",
  "```diff",
  "- const radius = 0;",
  "+ const radius = 8;",
  "```",
  "",
  "```python",
  "def total(items: list[int]) -> int:",
  "    return sum(x for x in items if x > 0)",
  "```",
].join("\n");

/** 240 turns: about 1200 blocks. */
const LONG: SessionUpdate[] = Array.from({ length: 240 }, (_, n) => [
  you(`u${n}`, `Question ${n + 1}: what does step ${n + 1} do?`),
  ...tool(`r${n}`, "Read", "completed", { file_path: `src/step-${n + 1}.ts` }),
  ...tool(`b${n}`, "Bash", "completed", { command: `bun test step-${n + 1}` }),
  say(
    `m${n}`,
    `Step ${n + 1} reads its input, checks it, and passes it on. ${"It keeps no state between calls. ".repeat(6)}`,
  ),
  idle({ stopReason: "end_turn" }),
]).flat();

export const conversation: SessionUpdate[] = [
  you("u1", "Why does the remote session fail, and fix it."),
  u({
    sessionUpdate: "agent_thought_chunk",
    messageId: "t1",
    content: { type: "text", text: "The error mentions libc, but the directory may be missing." },
  }),
  ...tool("c1", "Bash", "completed", { command: "ls /data/workspaces" }),
  ...tool("c2", "Read", "failed", { file_path: "/data/workspaces/missing.ts" }),
  ...tool("c3", "Bash", "in_progress", { command: "bun test packages/daemon" }),
  u({
    sessionUpdate: "plan_update",
    plan: {
      type: "items",
      planId: "p",
      entries: [
        { content: "Find the cause", priority: "high", status: "completed" },
        { content: "Check the directory in the daemon", priority: "high", status: "in_progress" },
        { content: "Add a test", priority: "medium", status: "pending" },
      ],
    },
  }),
  say("a1", MARKDOWN),
  u({ sessionUpdate: "usage_update", used: 41_200, size: 200_000 }),
  idle({ stopReason: "end_turn" }),
];

const permission = (title: string, command: string): PermissionRequest => ({
  key: "local:s1:p1",
  environmentId: "local",
  sessionId: "s1",
  title,
  subject: { type: "tool_call", toolCall: { name: "Bash", rawInput: { command } } },
  options: [
    { optionId: "allow", name: "Allow once", kind: "allow_once" },
    { optionId: "always", name: "Allow always", kind: "allow_always" },
    { optionId: "deny", name: "Deny", kind: "reject_once" },
  ],
});

const click = async (root: HTMLElement, text: string) => {
  for (let i = 0; i < 50; i++) {
    const found = Array.from(root.querySelectorAll('button, [role="menuitem"]')).find(
      // By its name: a button's label when it has one (the sidebar's actions also show their shortcut), else its text.
      (b) => (b.getAttribute("aria-label") ?? b.textContent?.trim()) === text,
    );
    if (found) return void (found as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`no button "${text}"`);
};

/** Cmd+K / Ctrl+K, as the keyboard does it (the page reads either). */
const openSearch = async (root: HTMLElement) => {
  window.dispatchEvent(
    new KeyboardEvent("keydown", { key: "k", metaKey: true, ctrlKey: true, bubbles: true }),
  );
  for (
    let i = 0;
    i < 40 && root.ownerDocument.querySelector('[data-palette="search"]') === null;
    i++
  )
    await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 200));
};

const clickByLabel = async (root: HTMLElement, label: string) => {
  for (let i = 0; i < 50; i++) {
    const found = root.querySelector(`[aria-label="${label}"]`) as HTMLElement | null;
    if (found) return void found.click();
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`nothing labelled "${label}"`);
};

/** An item of the environment's menu, opened as a click would. */
const hostAction = async (root: HTMLElement, item: string) => {
  await clickByLabel(root, "Environment actions");
  await new Promise((r) => setTimeout(r, 200));
  await click(root, item);
};

export const scenarios: Record<string, Scenario> = {
  empty: { title: "Connected, no sessions", sessions: [] },
  conversation: {
    title: "A finished turn: thought, tools (done, failed, running), plan, markdown, usage",
    sessions: [session("s1", { title: "Fix the remote session" })],
    history: conversation,
  },
  turns: {
    title:
      "Three turns: a card of tool calls that went well; a turn that failed (the failure pulled out, how it ended); a turn that is going (the step)",
    sessions: [session("s1", { title: "Ship the fix", state: "running" })],
    history: [
      // A mention: the text says @path, and the link that goes with it is not drawn again.
      u({
        sessionUpdate: "user_message",
        messageId: "u1",
        content: [
          { type: "text", text: "Run the tests in @packages/daemon and fix what fails." },
          {
            type: "resource_link",
            name: "daemon",
            uri: "file:///home/dev/cycle-v1/packages/daemon/",
            _meta: { "cycle/mention": "packages/daemon" },
          },
        ],
      }),
      ...tool("a1", "Read", "completed", { file_path: "packages/daemon/src/daemon.ts" }),
      ...tool("a2", "Read", "completed", { file_path: "packages/daemon/test/daemon.test.ts" }),
      ...tool("a3", "Edit", "completed", { file_path: "packages/daemon/src/daemon.ts" }),
      ...tool("a4", "Bash", "completed", {
        command: "bun test packages/daemon",
        description: "Run the daemon tests",
      }),
      say(
        "m1",
        "Two tests failed because the working directory was never checked. I fixed it and the suite passes.",
      ),
      idle({ stopReason: "end_turn" }),
      you("u2", "Now deploy it."),
      ...tool("b1", "Bash", "completed", { command: "bun run build" }),
      ...tool("b2", "Bash", "completed", { command: "scp dist/cycle-daemon build-1:" }),
      ...tool("b3", "Bash", "failed", { command: "ssh build-1 ./cycle-daemon --version" }),
      idle({ stopReason: "error", error: { message: "The agent exited unexpectedly (code 1)" } }),
      you("u3", "Try again, with the staging profile."),
      running(),
      ...tool("c1", "Read", "completed", { file_path: "deploy/staging.json" }),
      ...tool("c2", "Bash", "in_progress", {
        command: "bun run deploy --profile staging",
        description: "Deploy to staging",
      }),
    ],
  },
  work: {
    title:
      "A command's output and errors apart, a sub-agent in the background, a compaction, a plan proposed, and the plan above the input box",
    sessions: [session("s1", { title: "Speed up the build", state: "running" })],
    history: [
      you("u1", "The build is slow. Find out why and make a plan."),
      u({
        sessionUpdate: "plan_update",
        plan: {
          type: "items",
          planId: "tasks",
          entries: [
            { content: "Profile the build", priority: "medium", status: "completed" },
            { content: "Cache the dependency step", priority: "medium", status: "in_progress" },
            { content: "Measure again", priority: "medium", status: "pending" },
          ],
        },
      }),
      ...done(
        "b1",
        "Bash",
        { command: "bun run build --profile", description: "Profile the build" },
        {
          content: [
            {
              type: "content",
              content: {
                type: "text",
                text: Array.from(
                  { length: 60 },
                  (_, n) => `[${n + 1}/60] step ${n + 1} ${n % 7 === 0 ? "(slow)" : ""}`,
                ).join("\n"),
              },
            },
            {
              type: "content",
              content: {
                type: "text",
                text: "warning: cache directory not found, building from scratch",
              },
              _meta: { "cycle/stream": "stderr" },
            },
          ],
          _meta: { "cycle/toolResult": { run: { timedOutMs: 120000, background: true } } },
        },
      ),
      say(
        "m1",
        "Most of the time is in installing dependencies. A sub-agent is checking the cache settings.",
      ),
      ...tool("a1", "Agent", "completed", { description: "Check the cache settings", prompt: "…" }),
      u({
        sessionUpdate: "subagent_update",
        sessionId: "task-1",
        state: { state: "running" },
        _meta: { "cycle/subagent": { toolCallId: "a1", background: true, lastTool: "Grep" } },
      }),
      u({ sessionUpdate: "compaction_update", compactionId: "k1", status: "completed" }),
      ...done(
        "p1",
        "ExitPlanMode",
        { plan: "## Cache the install\n\n1. Keep `node_modules` between runs\n2. Measure again" },
        {},
      ),
    ],
    after: async (root) => {
      for (const label of ["Profile the build", "Proposed a plan"]) {
        const row = [...root.querySelectorAll<HTMLElement>('[data-kind="tool"] > button')].find(
          (b) => b.textContent?.includes(label),
        );
        row?.click();
      }
      (document.activeElement as HTMLElement | null)?.blur();
      await frames(4);
    },
  },
  web: {
    title:
      "The web and MCP: a search's hits as links with their sites, a fetch that failed (404), an MCP tool by its title and the first short line of its input, and a tool nothing knows",
    sessions: [session("s1", { title: "Check the docs" })],
    history: [
      you("u1", "How do I run one test file with Bun? Then file an issue to update our docs."),
      ...done(
        "w1",
        "WebSearch",
        { query: "bun test run a single file" },
        {
          content: [
            { type: "content", content: { type: "text", text: "Three results look relevant." } },
            ...[
              ["Test runner – Bun docs", "https://bun.sh/docs/cli/test"],
              ["Writing tests | Bun Docs", "https://www.bun.sh/docs/test/writing"],
              [
                "How to run a single test file with bun test? A long question title that wraps onto a second line in a narrow window",
                "https://stackoverflow.com/questions/77000000/bun-test-single-file",
              ],
            ].map(([name, uri]) => ({
              type: "content",
              content: { type: "resource_link", uri, name },
            })),
          ],
        },
      ),
      say("m1", "The docs say to pass the file's path. Let me check the old page we link to."),
      ...done(
        "w2",
        "WebFetch",
        { url: "https://bun.sh/docs/old-test-page", prompt: "What does it say about one file?" },
        {
          content: [{ type: "content", content: { type: "text", text: "Page not found." } }],
          _meta: { "cycle/toolResult": { fetch: { status: 404, bytes: 1534 } } },
        },
      ),
      say("m2", "That page is gone. Filing the issue."),
      u({
        sessionUpdate: "tool_call_update",
        toolCallId: "w3",
        name: "mcp__linear__create_issue",
        title: "linear · create_issue",
        status: "completed",
        rawInput: {
          title: "Update the test docs link",
          team: "CYCL",
          description: "The link in…\nlong",
        },
        content: [{ type: "content", content: { type: "text", text: "Created CYCL-52" } }],
      }),
      ...done(
        "w4",
        "CronList",
        {},
        { content: [{ type: "content", content: { type: "text", text: "No jobs." } }] },
      ),
      say("m3", "Done: `bun test path/to/file.test.ts`, and CYCL-52 tracks the docs."),
      idle({ stopReason: "end_turn" }),
    ],
    after: async (root) => {
      const row = [...root.querySelectorAll<HTMLElement>('[data-kind="tool"] > button')].find((b) =>
        b.textContent?.includes("bun test run a single file"),
      );
      row?.click();
      root.querySelector<HTMLElement>('[data-kind="work"] > button')?.click();
      (document.activeElement as HTMLElement | null)?.blur();
      await frames(4);
    },
  },
  ask: {
    title:
      "The agent asks: a question with choices and an answer of one's own, as a form above the input box",
    sessions: [session("s1", { state: "requires_action", title: "Pick a validation library" })],
    history: [you("u1", "Add validation to the config file."), running()],
    permissions: [
      {
        key: "local:s1:f1",
        environmentId: "local",
        sessionId: "s1",
        title: "Claude has some questions",
        options: [],
        form: {
          message: "Claude has some questions",
          schema: {
            type: "object",
            properties: {
              q0: {
                type: "string",
                title: "Library",
                description: "Which library should we use?",
                oneOf: [
                  {
                    const: "zod",
                    title: "zod",
                    description: "Already a dependency of the protocol package",
                  },
                  { const: "valibot", title: "valibot", description: "Smaller, newer" },
                ],
              },
              q0_other: {
                type: "string",
                title: "Other",
                description: "Your own answer, if none of the choices fits",
                maxLength: 2000,
              },
              q1: {
                type: "array",
                title: "Checks",
                description: "What should be checked?",
                items: {
                  anyOf: [
                    { const: "types", title: "Types" },
                    { const: "ranges", title: "Ranges" },
                    { const: "paths", title: "Paths exist" },
                  ],
                },
              },
              q1_other: {
                type: "string",
                title: "Other",
                description: "Your own answer, if none of the choices fits",
                maxLength: 2000,
              },
            },
          },
        },
      },
    ],
    after: async (root) => {
      root.querySelector<HTMLInputElement>('[data-slot="form-option"] input')?.click();
      root
        .querySelector<HTMLInputElement>('[data-slot="form-option"] input[type="checkbox"]')
        ?.click();
      (document.activeElement as HTMLElement | null)?.blur();
      await frames(2);
    },
  },
  files: {
    title:
      "File tools with what they amount to: an edit's own lines (+2 −1), a new file, the lines a read read, a picture read, what searches found",
    sessions: [session("s1", { title: "Tidy the daemon's config" })],
    history: [
      you("u1", "Make the port configurable and add a README for it."),
      ...done(
        "f1",
        "Read",
        { file_path: "packages/daemon/src/config.ts", offset: 20, limit: 40 },
        {
          content: text("    20\texport const PORT = 4100;\n    21\t"),
          _meta: { "cycle/toolResult": { read: { startLine: 20, numLines: 40, totalLines: 212 } } },
        },
      ),
      say("m1", "The port is a constant. I'll read it from the environment instead."),
      ...done(
        "f2",
        "Edit",
        { file_path: "packages/daemon/src/config.ts", old_string: "…", new_string: "…" },
        {
          content: [
            diff(
              "packages/daemon/src/config.ts",
              false,
              '@@ -19,4 +19,5 @@\n import { env } from "./env.ts";\n \n-export const PORT = 4100;\n+export const PORT = Number(env.CYCLE_PORT ?? 4100);\n+export const HOST = "127.0.0.1";\n \n',
            ),
          ],
          _meta: { "cycle/toolResult": { edit: { additions: 2, deletions: 1 } } },
        },
      ),
      say("m2", "Now the README."),
      ...done(
        "f3",
        "Write",
        { file_path: "packages/daemon/README.md", content: "…" },
        {
          content: [
            diff(
              "packages/daemon/README.md",
              true,
              "@@ -0,0 +1,3 @@\n+# Daemon\n+\n+Set `CYCLE_PORT` to change the port (default 4100).\n",
            ),
          ],
          _meta: { "cycle/toolResult": { edit: { additions: 3, deletions: 0, created: true } } },
        },
      ),
      say("m3", "And where else the port is used:"),
      ...done(
        "f4",
        "Grep",
        { pattern: "PORT", output_mode: "count" },
        {
          content: text("src/config.ts:2\nsrc/serve.ts:3"),
          _meta: { "cycle/toolResult": { search: { files: 2, matches: 5 } } },
        },
      ),
      say("m4", "The diagram the README should show:"),
      ...done(
        "f5",
        "Glob",
        { pattern: "docs/**/*.png" },
        {
          content: text("docs/daemon.png"),
          _meta: { "cycle/toolResult": { search: { files: 1 } } },
        },
      ),
      say("m6", "Here it is."),
      ...done(
        "f6",
        "Read",
        { file_path: "docs/daemon.png" },
        {
          content: [
            {
              type: "content",
              content: { type: "image", data: SAMPLE_PNG, mimeType: "image/png" },
            },
          ],
        },
      ),
      say("m5", "Done: the port comes from `CYCLE_PORT`, and the README says so."),
      idle({ stopReason: "end_turn" }),
    ],
    after: async (root) => {
      for (const id of ["config.ts", "README.md", "daemon.png"]) {
        const row = [...root.querySelectorAll<HTMLElement>('[data-kind="tool"] > button')].find(
          (b) =>
            b.textContent?.includes(id) && (id !== "config.ts" || b.textContent.includes("Edited")),
        );
        row?.click();
      }
      (document.activeElement as HTMLElement | null)?.blur();
      await frames(4);
      const list = conversationOf(root);
      list.scrollTop = list.scrollHeight;
      await frames(4);
    },
  },
  long: {
    title:
      "A long conversation (240 turns): only the end is drawn; scrolling to the top adds earlier blocks without moving what is being read",
    sessions: [session("s1", { title: "A very long session" })],
    history: LONG,
    after: async (root) => {
      const el = conversationOf(root);
      // Chromium keeps the reader in place by itself (scroll anchoring); WebKit does not. Turn it off, so that this checks
      // the view's own correction, which is what a browser without anchoring would need.
      el.style.overflowAnchor = "none";
      await until(
        () => el.scrollHeight > el.clientHeight + 2200,
        "the conversation to have content to scroll",
      );
      const first = drawnIn(el);
      // 240 turns have about 1200 blocks; only the last page is drawn.
      if (first > 80) console.error(`long: ${first} blocks drawn, expected about 60`);
      el.scrollTop = 1800;
      await until(() => Math.abs(el.scrollTop - 1800) < 2, "the scroll to 1800");
      // A block in view stays where it is, whatever is added above it.
      const reading = Array.from(el.querySelectorAll<HTMLElement>('[data-slot="block"]')).find(
        (b) => b.getBoundingClientRect().top > el.getBoundingClientRect().top + 20,
      );
      if (reading === undefined) throw new Error("long: no block in view to read");
      const offset = () => reading.getBoundingClientRect().top - el.getBoundingClientRect().top;
      const before = offset();
      const was = el.scrollTop;
      el.scrollTop = 100;
      await until(() => drawnIn(el) > first, "earlier blocks to be drawn");
      await frames(3);
      // It moved only by what the scroll itself moved, not by the blocks added above it.
      const moved = Math.abs(offset() - (before - (100 - was)));
      if (moved > 4) console.error(`long: the block being read jumped by ${moved}px`);
      el.scrollTop = el.scrollHeight;
      await frames(3);
    },
  },
  "long-back": {
    title:
      "Going back to a long session finds the reader where they were (scrolled up, with earlier blocks drawn)",
    sessions: [
      session("s1", { title: "A very long session", lastSeq: 2 }),
      session("s2", { title: "Another one", lastSeq: 1 }),
    ],
    history: LONG,
    after: async (root) => {
      const el = conversationOf(root);
      await until(
        () => el.scrollHeight > el.clientHeight + 2200,
        "the conversation to have content to scroll",
      );
      // Up near the top, so that a second page is drawn, and a place that is neither the top nor the end.
      el.scrollTop = 100;
      await until(() => drawnIn(el) > 80, "earlier blocks to be drawn");
      await frames(3);
      el.scrollTop = 1500;
      await until(() => Math.abs(el.scrollTop - 1500) < 2, "the scroll to 1500");
      await frames(3);
      const where = el.scrollTop;
      const drawn = drawnIn(el);
      const title = () => root.querySelector('[data-slot="session-header"] h1')?.textContent;
      const open = (text: string) =>
        Array.from(root.querySelectorAll<HTMLElement>('[role="option"]'))
          .find((o) => o.textContent?.includes(text))
          ?.click();
      open("Another one");
      await until(
        () => title() === "Another one" && conversationOf(root) !== el,
        "the other session to open",
      );
      open("A very long session");
      await until(() => title() === "A very long session", "the long session to open again");
      const back = conversationOf(root);
      await until(
        () => back.getAttribute("aria-busy") === "false" && back !== el,
        "it to be loaded",
      );
      await frames(3);
      if (Math.abs(back.scrollTop - where) > 4)
        console.error(`long-back: was at ${where}, came back to ${back.scrollTop}`);
      if (drawnIn(back) !== drawn)
        console.error(`long-back: ${drawn} blocks were drawn, ${drawnIn(back)} after`);
    },
  },
  "turn-stopped": {
    title: "A turn that was stopped, a turn that ran out of length, a turn the agent declined",
    sessions: [session("s1", { title: "Stops" })],
    history: [
      you("u1", "Rewrite everything."),
      ...tool("a1", "Bash", "in_progress", { command: "bun test" }),
      idle({ stopReason: "cancelled" }),
      you("u2", "Explain the whole codebase."),
      say("m2", "The codebase has four layers. The first is"),
      idle({ stopReason: "max_tokens" }),
      you("u3", "Do the other thing."),
      idle({ stopReason: "refusal" }),
    ],
  },
  "thinking-shown": {
    title:
      "The same turn with thinking shown (it is hidden by default, and the step line says so while it is going)",
    sessions: [session("s1", { title: "Think it through", state: "running" })],
    history: [
      you("u1", "Why is it slow?"),
      u({
        sessionUpdate: "agent_thought",
        messageId: "t1",
        content: [{ type: "text", text: "The log is read whole on every resume; that may be it." }],
      }),
      ...tool("a1", "Read", "completed", { file_path: "packages/daemon/src/log/jsonl.ts" }),
      ...tool("a2", "Grep", "completed", { pattern: "readAll" }),
      say("m1", "It reads the whole log on every resume."),
      idle({ stopReason: "end_turn" }),
      you("u2", "And now?"),
      running(),
      u({
        sessionUpdate: "agent_thought",
        messageId: "t2",
        content: [{ type: "text", text: "Checking whether the index is used at all." }],
      }),
    ],
    after: async () => {
      thinking.set(true);
    },
  },
  code: {
    title: "Code blocks in five languages (syntax colours, light and dark)",
    sessions: [session("s1", { title: "Colour the code" })],
    history: [you("u1", "Show it."), say("a1", CODE), idle({ stopReason: "end_turn" })],
  },
  // The same code in each of the five colour choices.
  ...Object.fromEntries(
    (["github", "github-high-contrast", "vscode", "one", "catppuccin"] as CodeThemeId[]).map(
      (id) => [
        `code-${id}`,
        {
          title: `Code colours: ${id}`,
          sessions: [session("s1", { title: "Colour the code" })],
          history: [you("u1", "Show it."), say("a1", CODE), idle({ stopReason: "end_turn" })],
          after: async () => {
            codeTheme.set(id);
            // The highlighter loads a language when a block first needs it.
            await new Promise((r) => setTimeout(r, 2500));
          },
        } satisfies Scenario,
      ],
    ),
  ),
  images: {
    title:
      "Images in a conversation: one you sent, one the agent sent between two paragraphs, one that cannot be shown",
    sessions: [session("s1", { title: "Look at the mock" })],
    history: [
      u({
        sessionUpdate: "user_message",
        messageId: "u1",
        content: [
          { type: "text", text: "Does this match the design?" },
          {
            type: "image",
            data: SAMPLE_PNG,
            mimeType: "image/png",
            uri: "file:///Users/dev/mock.png",
          },
        ],
      }),
      u({
        sessionUpdate: "agent_message",
        messageId: "a1",
        content: [
          { type: "text", text: "Close. The colours match; the sun sits lower in the design:" },
          { type: "image", data: SAMPLE_PNG, mimeType: "image/png" },
          { type: "text", text: "And one more, which I could not render as a picture." },
          { type: "image", data: "PHN2Zz48L3N2Zz4=", mimeType: "image/svg+xml" },
        ],
      }),
      idle({ stopReason: "end_turn" }),
    ],
  },
  attach: {
    title: "Images attached to a message (two pictures and one the agent cannot take)",
    attach: true,
    sessions: [session("s1", { title: "Look at the mock" })],
    history: [
      you("u1", "Here is the design."),
      say("a1", "Got it. Send me the screenshot."),
      idle({ stopReason: "end_turn" }),
    ],
    after: async () => {
      const bytes = Uint8Array.from(atob(SAMPLE_PNG), (c) => c.charCodeAt(0));
      const files = new DataTransfer();
      files.items.add(new File([bytes], "mock.png", { type: "image/png" }));
      files.items.add(
        new File([bytes], "a-rather-long-screenshot-name-2026-11-18.png", { type: "image/png" }),
      );
      files.items.add(new File(["x"], "notes.bmp", { type: "image/bmp" }));
      const input = document.querySelector('input[type="file"]') as HTMLInputElement | null;
      if (input === null) throw new Error("no file input");
      input.files = files.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 600));
    },
  },
  "image-open": {
    title: "An image opened large",
    sessions: [session("s1", { title: "Look at the mock" })],
    history: [
      u({
        sessionUpdate: "agent_message",
        messageId: "a1",
        content: [{ type: "image", data: SAMPLE_PNG, mimeType: "image/png" }],
      }),
      idle({ stopReason: "end_turn" }),
    ],
    after: async () => {
      (document.querySelector('[data-slot="image"]') as HTMLElement | null)?.click();
      await new Promise((r) => setTimeout(r, 400));
    },
  },
  "empty-conversation": {
    title: "A session with nothing said yet",
    sessions: [session("s1")],
    history: [],
  },
  streaming: {
    title: "The agent is working: the answer is half written",
    sessions: [session("s1", { state: "running", title: "Fix the remote session" })],
    history: [
      you("u1", "Explain the retry logic."),
      running(),
      u({
        sessionUpdate: "agent_message_chunk",
        messageId: "a1",
        content: {
          type: "text",
          text: "The client waits 250 ms, then doubles the wait up to 5 s. Each attempt asks the daemon for what",
        },
      }),
    ],
  },
  permission: {
    title: "The agent waits for a decision (a long command)",
    sessions: [session("s1", { state: "requires_action", title: "Clean the build" })],
    history: [you("u1", "Clean the build."), running()],
    permissions: [
      permission("Allow Bash?", `rm -rf ${LONG_PATH} && find . -name '*.tmp' -delete && echo done`),
    ],
  },
  "permission-queue": {
    title: "Several permissions wait without pushing the composer out of the window",
    sessions: [session("s1", { state: "requires_action", title: "Check the build" })],
    history: [you("u1", "Check the build and compare the logs."), running()],
    permissions: [
      permission("Read the build log?", `cat ${LONG_PATH}`),
      { ...permission("Compare the logs?", "diff build.log reference.log"), key: "local:s1:p2" },
    ],
  },
  "turn-error": {
    title: "A turn that ended in an error",
    sessions: [session("s1")],
    history: [
      you("u1", "Run it."),
      running(),
      idle({ stopReason: "error", error: { code: -32012, message: "The agent exited" } }),
    ],
  },
  "turn-error-changed": {
    title:
      "A turn that failed after running a command: Send again asks first, as the message may do it again",
    sessions: [session("s1")],
    history: [
      you("u1", "Bump the version and publish the package."),
      running(),
      ...done("b1", "Bash", { command: "npm version patch" }, { content: text("v1.4.3") }),
      u({ sessionUpdate: "tool_call_update", toolCallId: "b1", kind: "execute" }),
      idle({
        stopReason: "error",
        error: { message: "API Error: 529 Overloaded. The service is busy; try again later." },
      }),
    ],
    after: async (root) => {
      const button = [...root.querySelectorAll<HTMLButtonElement>("button")].find(
        (b) => b.textContent === "Send again",
      );
      button?.click();
      await until(() => document.querySelector('[role="alertdialog"]') !== null, "the dialog");
      await frames(4);
    },
  },
  "turn-error-resent": {
    title: "Send again: the message is back in the input box, to read and send",
    sessions: [session("s1")],
    history: [
      you("u1", "Summarise the open issues by label."),
      running(),
      idle({
        stopReason: "error",
        error: { code: -32018, message: "Cycle was stopped while this turn was running" },
      }),
    ],
    after: async (root) => {
      [...root.querySelectorAll<HTMLButtonElement>("button")]
        .find((b) => b.textContent === "Send again")
        ?.click();
      await frames(4);
    },
  },
  "turn-retrying": {
    title: "The agent's request failed and it is trying again by itself: a state, not a row",
    sessions: [session("s1", { state: "running" })],
    history: [
      you("u1", "Explain the queue hand-off."),
      running(),
      u({
        sessionUpdate: "notice",
        severity: "info",
        title: "Retrying the request (attempt 2 of 10)",
        _meta: { "cycle/retry": { attempt: 2, maxRetries: 10, delayMs: 1200, status: 529 } },
      }),
    ],
  },
  // CYCL-50: the samples the tests compare live, replayed and after a reconnect (packages/ui/test/samples.ts).
  parallel: {
    title:
      "Calls made together, results back out of order: one card in call order; counts only where whose is known",
    sessions: [session("s1")],
    history: turnOf("u1", PARALLEL_PROMPT, PARALLEL),
    after: async (root) => {
      root.querySelector<HTMLElement>('[data-kind="work"] > button')?.click();
      (document.activeElement as HTMLElement | null)?.blur();
      await frames(4);
    },
  },
  reconnected: {
    title:
      "Back after a dropped connection mid-turn: what was missed is drawn once, the open permission and form once",
    sessions: [session("s1", { state: "requires_action", title: "Run the tests" })],
    history: [
      you("u1", RECONNECT_PROMPT),
      running(),
      ...BEFORE_DROP,
      ...WHILE_AWAY,
      u({ sessionUpdate: "state_update", state: "requires_action" }),
    ],
    permissions: [
      { ...permission("Allow it?", "bun test"), key: "local:s1:r1" },
      {
        key: "local:s1:r2",
        environmentId: "local",
        sessionId: "s1",
        title: "Which one?",
        options: [],
        form: {
          message: "Which one?",
          schema: { type: "object", properties: { pick: { type: "string" } } },
        },
      },
    ],
  },
  "history-0.3.4": {
    title:
      "A history written before 0.3.5, replayed: plain rows, no counts or diffs, TaskCreate shown as then",
    sessions: [session("s1", { title: "Add a --verbose flag" })],
    history: OLD_UPDATES_SENT,
    after: async (root) => {
      for (const button of root.querySelectorAll<HTMLElement>('[data-kind="work"] > button'))
        button.click();
      (document.activeElement as HTMLElement | null)?.blur();
      await frames(4);
    },
  },
  "host-down": {
    title: "The remote host cannot be reached (its own words shown)",
    environments: [BUILD, LOCAL],
    status: [
      {
        environmentId: "build",
        state: "closed",
        error: "ssh: connect to host build-1 port 22: Connection refused",
      },
      UP("local"),
    ],
    sessions: [],
  },
  "host-reconnecting": {
    title: "The connection dropped and is being retried",
    environments: [LOCAL],
    status: [{ environmentId: "local", state: "reconnecting" }],
    sessions: [session("s1", { title: "Fix the remote session" })],
  },
  "session-reconnecting": {
    title: "An open session can still take a draft during reconnection",
    sessions: [session("s1", { title: "Fix the remote session" })],
    history: conversation,
    after: async (_root, emit) => {
      emit({ type: "environment-status", environmentId: "local", state: "reconnecting" });
    },
  },
  "session-groups": {
    title:
      "The session list: what needs you, what is working, then projects (one with more than a page, two with the same last folder name)",
    sessions: [
      session("ask", { title: "Approve the deploy", state: "requires_action", lastSeq: 90 }),
      session("run1", {
        title: "Index the logs",
        state: "running",
        cwd: "/home/dev/docs-site",
        lastSeq: 80,
      }),
      session("run2", { title: "Port the tests", state: "running", lastSeq: 70 }),
      ...Array.from({ length: 24 }, (_, n) =>
        session(`c${n}`, { title: `Cycle task ${n + 1}`, lastSeq: 24 - n }),
      ),
      session("d1", { title: "Fix the sidebar", cwd: "/home/dev/docs-site", lastSeq: 30 }),
      session("d2", { title: "Write the guide", cwd: "/home/dev/docs-site", lastSeq: 29 }),
      session("a1", { title: "Another app", cwd: "/home/other/app", lastSeq: 40 }),
      session("a2", { title: "The app", cwd: "/home/dev/app", lastSeq: 35 }),
      session("old", { title: "Archived thing", archived: true, lastSeq: 2 }),
    ],
    history: [you("u1", "Where were we?"), say("a1", "Here.")],
  },
  "session-focus": {
    title: "A row that starts working moves to the Working group and keeps the keyboard focus",
    sessions: [
      session("one", { title: "First", lastSeq: 1 }),
      session("two", { title: "Second", lastSeq: 2 }),
    ],
    history: [you("u1", "Hello"), say("a1", "Hi.")],
    after: async (root, emit) => {
      const option = (id: string) => root.querySelector<HTMLElement>(`[data-session="${id}"]`);
      const first = option("one");
      if (first === null) throw new Error("gallery: no row for the first session");
      first.focus();
      if (document.activeElement !== first)
        throw new Error("gallery: the row did not take the focus");
      emit({
        type: "sessions",
        environmentId: "local",
        sessions: [
          session("one", { title: "First", lastSeq: 3, state: "running" }),
          session("two", { title: "Second", lastSeq: 2 }),
        ],
      });
      await until(
        () => option("one")?.closest('[data-kind="running"]') !== null,
        "the row to move to Working",
      );
      await frames(3);
      if (document.activeElement !== option("one"))
        console.error("session-focus: the row moved and the keyboard focus was lost");
    },
  },
  "many-sessions": {
    title: "800 sessions, long titles, every state",
    sessions: Array.from({ length: 800 }, (_, i) =>
      session(`s${i}`, {
        title:
          i % 5 === 0
            ? `${"A title that goes on and on and on, "}${i}`
            : i % 7 === 0
              ? undefined
              : `Session ${i}`,
        cwd: i % 3 === 0 ? LONG_PATH : "/home/dev/cycle-v1",
        state: (["idle", "running", "requires_action", "stopped"] as const)[i % 4] ?? "idle",
        archived: i % 11 === 0,
        lastSeq: 1000 - i,
      }),
    ),
    history: conversation,
  },
  "update-available": {
    title: "An update is available",
    sessions: [session("s1")],
    update: { current: "0.1.0", kind: "available", version: "0.1.1" },
  },
  "update-failed": {
    title: "An install failed",
    sessions: [session("s1")],
    update: {
      current: "0.1.0",
      kind: "error",
      message: "The update could not be unpacked: no space left on device",
      version: "0.1.1",
    },
  },
  "daemon-old": {
    title: "The remote daemon is older than the app",
    environments: [BUILD, LOCAL],
    status: [
      {
        environmentId: "build",
        state: "connected",
        daemon: {
          version: "0.1.0",
          upgrade: {
            to: "0.1.1",
            command: "cycle stop; curl -fsSL https://example.invalid/install.sh | sh",
          },
        },
      },
      UP("local"),
    ],
    sessions: [],
  },
  "daemon-incompatible": {
    title: "The remote daemon speaks an incompatible protocol major version",
    environments: [BUILD, LOCAL],
    status: [
      {
        environmentId: "build",
        state: "reconnecting",
        incompatible: {
          with: "daemon",
          supported: ["0.2"],
          requested: "1.0",
          command: "cycle stop; curl -fsSL https://example.invalid/install.sh | sh",
        },
      },
      UP("local"),
    ],
    sessions: [],
  },
  "menu-session": {
    title: "The session's menu is open",
    sessions: [session("s1", { title: "Fix the remote session" })],
    history: conversation,
    after: async (root) => {
      await clickByLabel(root, "Session actions");
      await new Promise((r) => setTimeout(r, 200));
    },
  },
  "menu-host": {
    title: "The host's menu is open (a remote host)",
    environments: [BUILD, LOCAL],
    status: [UP("build"), UP("local")],
    sessions: [],
    after: async (root) => {
      await clickByLabel(root, "Environment actions");
      await new Promise((r) => setTimeout(r, 200));
    },
  },
  // Where keyboard focus lands after 1 to 7 Tabs, and that it shows.
  ...Object.fromEntries(
    [1, 2, 3, 4, 5, 6, 7].map((n) => [
      `focus-tab-${n}`,
      {
        title: `Keyboard focus after ${n} Tab${n > 1 ? "s" : ""}`,
        sessions: [
          session("s1", { title: "Fix the remote session" }),
          session("s2", { title: "Second" }),
        ],
        history: conversation,
        tabs: n,
      } satisfies Scenario,
    ]),
  ),
  "sidebar-collapsed": {
    title:
      "The sidebar folded away (Cmd+B); on a Mac the traffic lights sit where the title starts",
    sessions: [session("s1", { title: "Fix the remote session" })],
    history: conversation,
    after: async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "b", metaKey: true, ctrlKey: true }),
      );
      await new Promise((r) => setTimeout(r, 300));
    },
  },
  "search-open": {
    title: "The session search, opened with nothing typed (two environments, several states)",
    environments: [LOCAL, BUILD],
    status: [UP("local"), UP("build")],
    sessions: [
      session("s1", { title: "Fix the remote session", state: "running", lastSeq: 9 }),
      session("s2", { title: "Clean the build", state: "requires_action", lastSeq: 8 }),
      session("s3", { cwd: "/home/dev/docs", agent: "claude", lastSeq: 7 }),
      session("s4", { title: "Old idea", archived: true, lastSeq: 1 }),
      session("b1", {
        environmentId: "build",
        title: "Nightly release",
        cwd: "/srv/release",
        lastSeq: 6,
      }),
    ],
    after: openSearch,
  },
  "search-typed": {
    title: "The session search with a query that matches by folder and by host",
    environments: [LOCAL, BUILD],
    status: [UP("local"), UP("build")],
    sessions: [
      session("s1", { title: "Fix the remote session", lastSeq: 9 }),
      session("b1", {
        environmentId: "build",
        title: "Nightly release",
        cwd: "/srv/release",
        lastSeq: 6,
      }),
      session("b2", {
        environmentId: "build",
        title: "Cache warm-up",
        cwd: "/srv/cache",
        lastSeq: 5,
      }),
    ],
    after: async (root) => {
      await openSearch(root);
      const input = document.querySelector(
        '[data-palette="search"] input',
      ) as HTMLInputElement | null;
      if (input === null) throw new Error("no search input");
      // As a keyboard types: through the input's own value setter, so the framework sees it.
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      set?.call(input, "build");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 300));
    },
  },
  "search-none": {
    title: "The session search with a query nothing matches",
    sessions: [session("s1", { title: "Fix the remote session" })],
    after: async (root) => {
      await openSearch(root);
      const input = document.querySelector(
        '[data-palette="search"] input',
      ) as HTMLInputElement | null;
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      set?.call(input, "zzz");
      input?.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 300));
    },
  },
  "new-session": {
    title: "New session: a blank conversation, with no workspace yet",
    sessions: [],
    after: (root) => click(root, "New session"),
  },
  "new-session-workspace": {
    title: "New session in the workspace that is shown: its folder, the agent's defaults",
    sessions: [session("s1", { title: "Fix the remote session" })],
    attach: true,
    blank: { cwd: "/Users/me/work/app" },
  },
  "new-session-starting": {
    title: "The first message is sent, and the session is being made",
    sessions: [session("s1", { title: "Fix the remote session" })],
    blank: {
      cwd: "/Users/me/work/app",
      starting: "Find why the remote session drops after a minute, and fix it.",
    },
  },
  "new-session-trust": {
    title: "The first message, in a folder nobody has decided on: asked whether to trust it",
    sessions: [session("s1", { title: "Fix the remote session" })],
    trust: null,
    blank: {
      cwd: "/Users/me/work/app",
      starting: "Find why the remote session drops after a minute, and fix it.",
    },
    after: () =>
      until(
        () => document.querySelector('[role="dialog"] [data-slot="decision-path"]') !== null,
        "the trust question",
      ),
  },
  "menu-trust": {
    title: "The environment menu offers to trust the shown workspace's folder",
    sessions: [session("s1", { title: "Fix the remote session" })],
    trust: null,
    after: async (root) => {
      await clickByLabel(root, "Environment actions");
      await new Promise((r) => setTimeout(r, 200));
    },
  },
  "dialog-add-host": {
    title: "Add environment dialog",
    sessions: [],
    after: (root) => hostAction(root, "Add environment"),
  },
  "dialog-agent-defaults": {
    title: "Agent defaults dialog",
    sessions: [],
    after: (root) => hostAction(root, "Agent defaults"),
  },
  "new-session-no-agent": {
    title: "New session with no available agent: explains why and offers to check again",
    sessions: [],
    noAgents: true,
    blank: {},
  },
  "dialog-edit-host": {
    title: "Edit environment dialog",
    environments: [BUILD, LOCAL],
    sessions: [],
    after: (root) => hostAction(root, "Edit build-1"),
  },
  "dialog-delete-session": {
    title: "Destructive confirmation dialog for deleting a session",
    sessions: [session("s1", { title: "Fix the remote session" })],
    history: conversation,
    after: async (root) => {
      await clickByLabel(root, "Session actions");
      await new Promise((r) => setTimeout(r, 200));
      await click(root.ownerDocument.body, "Delete");
      await until(
        () => document.querySelector('[role="alertdialog"], [role="dialog"]') !== null,
        "the delete confirmation dialog",
      );
    },
  },
  "danger-setting": {
    title: "High-risk permission mode chip and menu option marked with caution",
    sessions: [
      session("s1", {
        title: "Fix the remote session",
        config: { mode: "bypassPermissions", model: "default" },
      }),
    ],
    history: conversation,
    after: async (root) => {
      await clickByLabel(root, "Permission mode: Bypass permissions");
      await new Promise((r) => setTimeout(r, 200));
    },
  },
  "step-live": {
    title: "Live inline AI status while the agent is thinking",
    sessions: [session("s1", { title: "Audit the design tokens", state: "running" })],
    history: [
      you("u1", "Check contrast ratios across dark and light modes."),
      running(),
      u({
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "Measuring luminance for every surface pair." },
      }),
    ],
  },
};

export const snapshotOf = (s: Scenario): SessionSnapshot => ({
  conversation: (s.history ?? []).reduce(applyUpdate, emptyConversation()),
  permissions: s.permissions ?? [],
  version: (s.history ?? []).length,
});
export { BUILD, LOCAL, UP };
