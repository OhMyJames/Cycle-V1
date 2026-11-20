// Fixed samples of conversations that must look the same live and replayed (CYCL-50): calls made together whose results
// come back out of order, a turn a client was away from, and a history written before 0.3.5. The tests (here, in
// apps/desktop and apps/daemon) and the gallery draw from the same data.
import type { SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";

const u = (update: object) => update as SessionUpdate;
const text = (t: string) => [{ type: "content", content: { type: "text", text: t } }];

/** A whole turn, as a log has it, around what the agent said in it. */
export const turnOf = (
  messageId: string,
  prompt: string,
  said: readonly SessionUpdate[],
  stopReason = "end_turn",
): SessionUpdate[] => [
  u({ sessionUpdate: "user_message", messageId, content: [{ type: "text", text: prompt }] }),
  u({ sessionUpdate: "state_update", state: "running" }),
  ...said,
  u({ sessionUpdate: "state_update", state: "idle", stopReason }),
];

// ---- 1. calls made together, results out of order ----

export const PARALLEL_PROMPT = "Where is the queue handed back?";

/**
 * One assistant message with three calls; the results come back b, a, then c. a and b came back in one message, so whose
 * structured result is whose is not known and they have no `cycle/toolResult` (the adapter's rule, `resultOf`); c came
 * back alone and has its counts and location.
 */
export const PARALLEL: readonly SessionUpdate[] = [
  u({
    sessionUpdate: "agent_message",
    messageId: "p1",
    content: [{ type: "text", text: "Looking in three places at once." }],
  }),
  u({
    sessionUpdate: "tool_call_update",
    toolCallId: "a",
    name: "Read",
    kind: "read",
    status: "pending",
  }),
  u({
    sessionUpdate: "tool_call_update",
    toolCallId: "b",
    name: "Grep",
    kind: "search",
    status: "pending",
  }),
  u({
    sessionUpdate: "tool_call_update",
    toolCallId: "c",
    name: "Read",
    kind: "read",
    status: "pending",
  }),
  u({
    sessionUpdate: "tool_call_update",
    toolCallId: "a",
    status: "in_progress",
    rawInput: { file_path: "/work/apps/daemon/src/daemon.ts" },
    locations: [{ path: "/work/apps/daemon/src/daemon.ts" }],
  }),
  u({
    sessionUpdate: "tool_call_update",
    toolCallId: "b",
    status: "in_progress",
    rawInput: { pattern: "returnQueue", path: "/work/apps" },
  }),
  u({
    sessionUpdate: "tool_call_update",
    toolCallId: "c",
    status: "in_progress",
    rawInput: { file_path: "/work/docs/protocol.md", offset: 262, limit: 30 },
    locations: [{ path: "/work/docs/protocol.md", line: 262 }],
  }),
  // b, then a: one message with two results.
  u({
    sessionUpdate: "tool_call_update",
    toolCallId: "b",
    status: "completed",
    content: text("apps/daemon/src/daemon.ts\napps/daemon/test/queue.test.ts"),
    rawOutput: "apps/daemon/src/daemon.ts\napps/daemon/test/queue.test.ts",
  }),
  u({
    sessionUpdate: "tool_call_update",
    toolCallId: "a",
    status: "completed",
    content: text("     1\t// The daemon: what a client sees of its sessions.\n"),
    rawOutput: "     1\t// The daemon: what a client sees of its sessions.\n",
  }),
  // c alone: its own counts.
  u({
    sessionUpdate: "tool_call_update",
    toolCallId: "c",
    status: "completed",
    content: text("### 排队(session 忙时发的 prompt)\n"),
    locations: [{ path: "/work/docs/protocol.md", line: 262 }],
    _meta: { "cycle/toolResult": { read: { startLine: 262, numLines: 30, totalLines: 640 } } },
  }),
  u({
    sessionUpdate: "agent_message",
    messageId: "p2",
    content: [{ type: "text", text: "`#returnQueue` in daemon.ts, as protocol.md §8 describes." }],
  }),
];

// ---- 2. a turn a client was away from ----

export const RECONNECT_PROMPT = "Run the tests and fix what fails.";

/** What the agent says before the client goes: a command going, and a sub-agent at work. */
export const BEFORE_DROP: readonly SessionUpdate[] = [
  u({
    sessionUpdate: "tool_call_update",
    toolCallId: "t1",
    name: "Bash",
    kind: "execute",
    status: "pending",
  }),
  u({
    sessionUpdate: "tool_call_update",
    toolCallId: "t1",
    status: "in_progress",
    rawInput: { command: "bun test", description: "Run the tests" },
  }),
  u({
    sessionUpdate: "tool_call_update",
    toolCallId: "t2",
    name: "Agent",
    kind: "other",
    status: "pending",
  }),
  u({
    sessionUpdate: "tool_call_update",
    toolCallId: "t2",
    status: "in_progress",
    rawInput: { description: "Find the flaky test", prompt: "Find which test is flaky." },
  }),
  u({
    sessionUpdate: "subagent_update",
    sessionId: "sub-1",
    title: "Find the flaky test",
    state: { state: "running" },
    _meta: { "cycle/subagent": { toolCallId: "t2", background: false, lastTool: "Grep" } },
  }),
];

/** What the agent says while the client is away: the command ends, the sub-agent moves on, another call begins. */
export const WHILE_AWAY: readonly SessionUpdate[] = [
  u({
    sessionUpdate: "tool_call_update",
    toolCallId: "t1",
    status: "failed",
    content: text("1 fail\n queue.test.ts > hands back in order"),
    rawOutput: "1 fail",
    _meta: { "cycle/toolResult": { run: { exitCode: 1 } } },
  }),
  u({
    sessionUpdate: "subagent_update",
    sessionId: "sub-1",
    state: { state: "running" },
    _meta: {
      "cycle/subagent": {
        toolCallId: "t2",
        lastTool: "Read",
        usage: { tokens: 1200, toolUses: 3, durationMs: 4000 },
      },
    },
  }),
  u({
    sessionUpdate: "tool_call_update",
    toolCallId: "t3",
    name: "Edit",
    kind: "edit",
    status: "pending",
  }),
  u({
    sessionUpdate: "tool_call_update",
    toolCallId: "t3",
    status: "in_progress",
    rawInput: {
      file_path: "/work/apps/daemon/test/queue.test.ts",
      old_string: "a",
      new_string: "b",
    },
  }),
];

/** What it says after it is answered, to end the turn. */
export const AFTER_ANSWERS: readonly SessionUpdate[] = [
  u({
    sessionUpdate: "tool_call_update",
    toolCallId: "t3",
    status: "completed",
    content: text("ok"),
  }),
  u({
    sessionUpdate: "subagent_update",
    sessionId: "sub-1",
    state: { state: "idle", stopReason: "end_turn" },
    _meta: { "cycle/subagent": { toolCallId: "t2" } },
  }),
  u({
    sessionUpdate: "tool_call_update",
    toolCallId: "t2",
    status: "completed",
    content: text("queue.test.ts"),
  }),
  u({
    sessionUpdate: "agent_message",
    messageId: "r1",
    content: [{ type: "text", text: "Fixed the order check." }],
  }),
];

// ---- 3. a history written before 0.3.5 ----

/**
 * A session's JSONL as daemon 0.3.4 wrote it, with what its Claude adapter sent then: tool calls with `name`, `kind`,
 * `rawInput` and `rawOutput` only (no `title`, `locations`, `cycle/toolResult`; standard error not apart, no
 * `cycle/stream`), and TaskCreate with the kind `other`, as only TodoWrite was `think` then. Made up, in that format.
 */
export const OLD_SESSION_ID = "5b0e8a7c-3f41-4c2e-9d4a-0a35c0de0034";

const at = (seq: number) =>
  `2026-11-12T09:${String(10 + Math.floor(seq / 6)).padStart(2, "0")}:${String((seq * 7) % 60).padStart(2, "0")}.000Z`;
const record = (seq: number, kind: string, data: object) => ({ seq, ts: at(seq), kind, data });

const OLD_UPDATES: [string, object][] = [
  [
    "update",
    {
      sessionUpdate: "user_message",
      messageId: "m1",
      content: [{ type: "text", text: "Add a --verbose flag to the CLI." }],
    },
  ],
  ["update", { sessionUpdate: "state_update", state: "running" }],
  [
    "update",
    {
      sessionUpdate: "agent_thought_chunk",
      messageId: "a1",
      content: { type: "text", text: "Look at args first." },
    },
  ],
  [
    "update",
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "toolu_01",
      name: "TaskCreate",
      kind: "other",
      status: "pending",
    },
  ],
  [
    "update",
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "toolu_01",
      name: "TaskCreate",
      kind: "other",
      status: "in_progress",
      rawInput: { subject: "Add --verbose", description: "Parse it and pass it on" },
    },
  ],
  [
    "update",
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "toolu_01",
      status: "completed",
      content: [
        {
          type: "content",
          content: { type: "text", text: "Task #1 created successfully: Add --verbose" },
        },
      ],
      rawOutput: "Task #1 created successfully: Add --verbose",
    },
  ],
  [
    "update",
    {
      sessionUpdate: "plan_update",
      plan: {
        type: "items",
        planId: "tasks",
        entries: [{ content: "Add --verbose", priority: "medium", status: "pending" }],
      },
    },
  ],
  [
    "update",
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "toolu_02",
      name: "Read",
      kind: "read",
      status: "pending",
    },
  ],
  [
    "update",
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "toolu_02",
      name: "Read",
      kind: "read",
      status: "in_progress",
      rawInput: { file_path: "/work/src/args.ts" },
    },
  ],
  [
    "update",
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "toolu_02",
      status: "completed",
      content: [
        {
          type: "content",
          content: { type: "text", text: "     1\texport const OPTIONS = {};\n" },
        },
      ],
      rawOutput: "     1\texport const OPTIONS = {};\n",
    },
  ],
  [
    "update",
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "toolu_03",
      name: "Edit",
      kind: "edit",
      status: "pending",
    },
  ],
  [
    "update",
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "toolu_03",
      name: "Edit",
      kind: "edit",
      status: "in_progress",
      rawInput: {
        file_path: "/work/src/args.ts",
        old_string: "export const OPTIONS = {};",
        new_string: "export const OPTIONS = { verbose: false };",
      },
    },
  ],
  [
    "request",
    {
      requestId: "r1",
      method: "session/request_permission",
      params: {
        sessionId: OLD_SESSION_ID,
        toolCall: { toolCallId: "toolu_03", name: "Edit" },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
      },
    },
  ],
  ["response", { requestId: "r1", outcome: { outcome: "selected", optionId: "allow" }, by: "c1" }],
  [
    "update",
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "toolu_03",
      status: "completed",
      content: [
        {
          type: "content",
          content: { type: "text", text: "The file /work/src/args.ts has been updated." },
        },
      ],
      rawOutput: "The file /work/src/args.ts has been updated.",
    },
  ],
  [
    "update",
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "toolu_04",
      name: "Bash",
      kind: "execute",
      status: "pending",
    },
  ],
  [
    "update",
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "toolu_04",
      name: "Bash",
      kind: "execute",
      status: "in_progress",
      rawInput: { command: "bun test test/args.test.ts", description: "Run the args tests" },
    },
  ],
  [
    "update",
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "toolu_04",
      status: "completed",
      content: [
        {
          type: "content",
          content: {
            type: "text",
            text: "bun test v1.3.1\n 4 pass\n 0 fail\nwarning: unused import",
          },
        },
      ],
      rawOutput: "bun test v1.3.1\n 4 pass\n 0 fail\nwarning: unused import",
    },
  ],
  [
    "update",
    {
      sessionUpdate: "agent_message_chunk",
      messageId: "a2",
      content: { type: "text", text: "Added `--verbose`; " },
    },
  ],
  [
    "update",
    {
      sessionUpdate: "agent_message_chunk",
      messageId: "a2",
      content: { type: "text", text: "the args tests pass." },
    },
  ],
  ["update", { sessionUpdate: "usage_update", used: 18200, size: 200000 }],
  ["update", { sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" }],
  [
    "update",
    {
      sessionUpdate: "user_message",
      messageId: "m2",
      content: [{ type: "text", text: "Now run all the tests." }],
    },
  ],
  ["update", { sessionUpdate: "state_update", state: "running" }],
  [
    "update",
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "toolu_05",
      name: "Bash",
      kind: "execute",
      status: "pending",
    },
  ],
  [
    "update",
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "toolu_05",
      name: "Bash",
      kind: "execute",
      status: "in_progress",
      rawInput: { command: "bun test" },
    },
  ],
  [
    "update",
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "toolu_05",
      status: "failed",
      content: [
        {
          type: "content",
          content: { type: "text", text: 'error: script "test" exited with code 1' },
        },
      ],
      rawOutput: 'error: script "test" exited with code 1',
    },
  ],
  ["meta", { event: "agent_exited" }],
  [
    "update",
    {
      sessionUpdate: "state_update",
      state: "idle",
      stopReason: "error",
      error: { code: -32012, message: "The agent exited" },
    },
  ],
];

export const OLD_LOG = OLD_UPDATES.map(([kind, data], i) => record(i + 1, kind, data));

/** The JSONL file: one record a line, as the log writes it. */
export const OLD_JSONL = `${OLD_LOG.map((r) => JSON.stringify(r)).join("\n")}\n`;

/** Its row in a 0.3.4 index (`sessions.json`): no `turnOpen`, nor anything later. */
export const OLD_ENTRY = {
  agent: "fake",
  agentSessionId: OLD_SESSION_ID,
  cwd: "/work",
  title: "Add a --verbose flag",
  titleFromAgent: true,
  readSeq: OLD_LOG.length,
  attentionSeq: OLD_LOG.length,
  hadTurn: true,
  prompted: true,
  createdAt: "2026-11-12T09:10:00.000Z",
};

/** What a client is sent of it: the updates, in order (requests, responses and meta are not updates). */
export const OLD_UPDATES_SENT: SessionUpdate[] = OLD_LOG.filter((r) => r.kind === "update").map(
  (r) => r.data as SessionUpdate,
);
