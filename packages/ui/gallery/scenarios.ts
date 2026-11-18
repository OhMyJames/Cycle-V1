// The gallery's scenarios: one state of the interface each, drawn by the real components over a scripted
// bridge. DESIGN.md says what each is for. Add one when a surface gets a new state.
import type { SessionUpdate } from "@cycle/acp";
import type {
  HostConfig,
  HostStatus,
  PermissionRequest,
  SessionSnapshot,
  SessionSummary,
  UpdateState,
} from "../src/api.ts";
import { type CodeThemeId, codeTheme } from "../src/code-theme.ts";
import { applyUpdate, emptyConversation } from "../src/model/index.ts";
import { thinking } from "../src/thinking.ts";
import { SAMPLE_PNG } from "./sample-image.ts";

export type Scenario = {
  title: string;
  hosts?: HostConfig[];
  status?: HostStatus[];
  sessions?: SessionSummary[];
  /** The conversation of the session that is opened. Without it nothing is opened. */
  history?: SessionUpdate[];
  permissions?: PermissionRequest[];
  update?: UpdateState;
  /** The agent takes images: the composer shows how to attach them. */
  attach?: boolean;
  /** Presses Tab this many times with real input events, so :focus-visible shows as it does for a keyboard. */
  tabs?: number;
  /** Runs once the page has drawn: open a dialog, press a key. */
  after?: (root: HTMLElement) => Promise<void>;
};

const u = (update: object) => update as SessionUpdate;
const LOCAL: HostConfig = { id: "local", name: "This computer", kind: "local" };
const BUILD: HostConfig = { id: "build", name: "build-1", kind: "ssh", host: "build-1" };
const UP = (hostId: string): HostStatus => ({ hostId, state: "connected" });

const session = (id: string, over: Partial<SessionSummary> = {}): SessionSummary => ({
  hostId: "local",
  sessionId: id,
  cwd: "/home/dev/cycle-v1",
  archived: false,
  agent: "claude",
  state: "idle",
  lastSeq: 1,
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
  hostId: "local",
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
      (b) => b.textContent?.trim() === text,
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

/** An item of the host's menu, opened as a click would. */
const hostAction = async (root: HTMLElement, item: string) => {
  await clickByLabel(root, "Host actions");
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
      you("u1", "Run the tests and fix what fails."),
      ...tool("a1", "Read", "completed", { file_path: "packages/daemon/src/daemon.ts" }),
      ...tool("a2", "Read", "completed", { file_path: "packages/daemon/test/daemon.test.ts" }),
      ...tool("a3", "Edit", "completed", { file_path: "packages/daemon/src/daemon.ts" }),
      ...tool("a4", "Bash", "completed", { command: "bun test packages/daemon" }),
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
      ...tool("c2", "Bash", "in_progress", { command: "bun run deploy --profile staging" }),
    ],
  },
  long: {
    title:
      "A long conversation (240 turns): only the end is drawn; scrolling to the top adds earlier blocks without moving what is being read",
    sessions: [session("s1", { title: "A very long session" })],
    history: LONG,
    after: async (root) => {
      const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const el = root.querySelector<HTMLElement>('[data-slot="conversation"]');
      if (el === null) throw new Error("no conversation");
      const blocks = () => el.querySelectorAll('[data-slot="block"]').length;
      const first = blocks();
      // 240 turns have about 1200 blocks; only the last page is drawn.
      if (first > 80) console.error(`long: ${first} blocks drawn, expected about 60`);
      // Scroll to the top: earlier blocks are added, and the block that was being read stays where it was.
      const reading = el.querySelectorAll('[data-slot="block"]')[3] as HTMLElement;
      const offset = () => reading.getBoundingClientRect().top - el.getBoundingClientRect().top;
      el.scrollTop = 2000;
      await wait(250);
      const was = el.scrollTop;
      const before = offset();
      el.scrollTop = 100;
      await wait(500);
      const grown = blocks();
      if (grown <= first) console.error(`long: scrolling up added nothing (${first} -> ${grown})`);
      // The reading block moved only by what the scroll itself moved, not by the blocks added above it.
      const moved = Math.abs(offset() - (before - (100 - was)));
      if (moved > 4) console.error(`long: the block being read jumped by ${moved}px`);
      el.scrollTop = el.scrollHeight;
      await wait(250);
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
      const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const log = () => root.querySelector<HTMLElement>('[data-slot="conversation"]');
      const el = log();
      if (el === null) throw new Error("no conversation");
      el.scrollTop = 2000;
      await wait(300);
      const where = el.scrollTop;
      const drawn = el.querySelectorAll('[data-slot="block"]').length;
      const options = Array.from(root.querySelectorAll<HTMLElement>('[role="option"]'));
      if (options.length < 2) console.error(`long-back: ${options.length} sessions in the list`);
      options.find((o) => o.textContent?.includes("Another one"))?.click();
      await wait(400);
      options.find((o) => o.textContent?.includes("A very long session"))?.click();
      await wait(500);
      const back = log();
      if (back === null) throw new Error("no conversation after going back");
      const now = back.scrollTop;
      const redrawn = back.querySelectorAll('[data-slot="block"]').length;
      if (Math.abs(now - where) > 4)
        console.error(`long-back: was at ${where}, came back to ${now}`);
      if (redrawn < drawn) console.error(`long-back: ${drawn} blocks were drawn, ${redrawn} after`);
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
  "turn-error": {
    title: "A turn that ended in an error",
    sessions: [session("s1")],
    history: [
      you("u1", "Run it."),
      running(),
      idle({ stopReason: "error", error: { code: -32012, message: "The agent exited" } }),
    ],
  },
  "host-down": {
    title: "The remote host cannot be reached (its own words shown)",
    hosts: [BUILD, LOCAL],
    status: [
      {
        hostId: "build",
        state: "closed",
        error: "ssh: connect to host build-1 port 22: Connection refused",
      },
      UP("local"),
    ],
    sessions: [],
  },
  "host-reconnecting": {
    title: "The connection dropped and is being retried",
    hosts: [LOCAL],
    status: [{ hostId: "local", state: "reconnecting" }],
    sessions: [session("s1", { title: "Fix the remote session" })],
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
    hosts: [BUILD, LOCAL],
    status: [
      {
        hostId: "build",
        state: "connected",
        daemon: {
          version: "0.1.0",
          upgrade: "cycle stop; curl -fsSL https://example.invalid/install.sh | sh",
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
    hosts: [BUILD, LOCAL],
    status: [UP("build"), UP("local")],
    sessions: [],
    after: async (root) => {
      await clickByLabel(root, "Host actions");
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
    title: "The session search, opened with nothing typed (two hosts, several states)",
    hosts: [LOCAL, BUILD],
    status: [UP("local"), UP("build")],
    sessions: [
      session("s1", { title: "Fix the remote session", state: "running", lastSeq: 9 }),
      session("s2", { title: "Clean the build", state: "requires_action", lastSeq: 8 }),
      session("s3", { cwd: "/home/dev/docs", agent: "claude", lastSeq: 7 }),
      session("s4", { title: "Old idea", archived: true, lastSeq: 1 }),
      session("b1", { hostId: "build", title: "Nightly release", cwd: "/srv/release", lastSeq: 6 }),
    ],
    after: openSearch,
  },
  "search-typed": {
    title: "The session search with a query that matches by folder and by host",
    hosts: [LOCAL, BUILD],
    status: [UP("local"), UP("build")],
    sessions: [
      session("s1", { title: "Fix the remote session", lastSeq: 9 }),
      session("b1", { hostId: "build", title: "Nightly release", cwd: "/srv/release", lastSeq: 6 }),
      session("b2", { hostId: "build", title: "Cache warm-up", cwd: "/srv/cache", lastSeq: 5 }),
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
  "dialog-new-session": {
    title: "New session dialog",
    sessions: [],
    after: (root) => click(root, "New session"),
  },
  "dialog-add-host": {
    title: "Add host dialog",
    sessions: [],
    after: (root) => hostAction(root, "Add host"),
  },
  "dialog-agent-defaults": {
    title: "Agent defaults dialog",
    sessions: [],
    after: (root) => hostAction(root, "Agent defaults"),
  },
};

export const snapshotOf = (s: Scenario): SessionSnapshot => ({
  conversation: (s.history ?? []).reduce(applyUpdate, emptyConversation()),
  permissions: s.permissions ?? [],
  version: (s.history ?? []).length,
});
export { BUILD, LOCAL, UP };
