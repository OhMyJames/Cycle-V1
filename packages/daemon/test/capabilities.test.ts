import { afterEach, beforeEach, expect, test } from "bun:test";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { methods } from "@cycle/acp";
import { PROMPT_LIMITS } from "@cycle/protocol";
import { Daemon, indexPath, sessionsDir } from "../src/index.ts";
import { connectClient, until } from "./client.ts";
import { fakeAgent } from "./fake-agent.ts";
import { tempDir } from "./support.ts";

let dir: string;
let dispose: () => Promise<void>;
let open: Daemon[] = [];
beforeEach(async () => {
  ({ dir, dispose } = await tempDir());
});
afterEach(async () => {
  for (const daemon of open) await daemon.close();
  open = [];
  await dispose();
});

const start = async (fake = fakeAgent()) => {
  const daemon = await Daemon.start({ dataDir: dir, agents: [fake.definition] });
  open.push(daemon);
  return { daemon, fake };
};

const text = (value: string) => [{ type: "text" as const, text: value }];
const png = Buffer.from("not really a png").toString("base64");
const image = { type: "image" as const, data: png, mimeType: "image/png" };
const both = { image: {}, embeddedContext: {} };

const sessionRow = async (c: Awaited<ReturnType<typeof connectClient>>) =>
  ((await c.agent.request(methods.agent.session.list, {})).sessions[0]?._meta ?? {}) as Record<
    string,
    unknown
  >;

// ---- attachments ----

test("an agent's prompt capabilities are in the agent list", async () => {
  const { daemon } = await start(fakeAgent({}, { promptCapabilities: both }));
  const c = await connectClient(daemon);
  const listed = (await c.agent.request("_cycle/agents/list", {})) as {
    agents: { id: string; promptCapabilities?: unknown }[];
  };
  expect(listed.agents[0]?.promptCapabilities).toEqual(both);
});

test("an image reaches an agent that takes images, and is in the history for the next client", async () => {
  const { daemon, fake } = await start(fakeAgent({}, { promptCapabilities: both }));
  const c = await connectClient(daemon);
  const { sessionId } = await c.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  await c.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  await c.agent.request(methods.agent.session.prompt, {
    sessionId,
    prompt: [{ type: "text", text: "look" }, image],
  });
  await until(() => c.idle() >= 2, "the turn to end");
  expect(fake.log.blocks[0]).toEqual([{ type: "text", text: "look" }, image]);

  const later = await connectClient(daemon);
  await later.agent.request(methods.agent.session.resume, {
    sessionId,
    cwd: "/tmp",
    replayFrom: { type: "start" },
  });
  await until(() => later.kinds().includes("user_message"), "the history");
  const user = later.seen.find((s) => s.update.sessionUpdate === "user_message")
    ?.update as unknown as {
    content: unknown[];
  };
  expect(user.content).toEqual([{ type: "text", text: "look" }, image]);
});

test("a prompt the agent cannot take is refused whole: nothing is started, written or sent", async () => {
  const { daemon, fake } = await start(fakeAgent({}, { promptCapabilities: { image: {} } }));
  const c = await connectClient(daemon);
  const { sessionId } = await c.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  const launches = fake.log.launches;
  const refuse = async (prompt: unknown[], reason: string) =>
    expect(
      c.agent.request(methods.agent.session.prompt, { sessionId, prompt } as never),
    ).rejects.toMatchObject({ code: -32602, data: { reason, sessionId } });

  await refuse(
    [
      { type: "text", text: "a" },
      { type: "audio", data: "AAAA", mimeType: "audio/wav" },
    ],
    "unsupported_block",
  );
  await refuse(
    [{ type: "resource", resource: { uri: "file:///a", text: "x" } }],
    "unsupported_block",
  ); // no embeddedContext
  await refuse([{ ...image, mimeType: "image/bmp" }], "unsupported_media_type");
  await refuse(
    [{ ...image, data: Buffer.alloc(PROMPT_LIMITS.blockBytes + 1).toString("base64") }],
    "block_too_large",
  );
  expect(fake.log.prompts).toEqual([]);
  expect(fake.log.launches).toBe(launches);
  expect(c.kinds()).toEqual([]);
  // The data says which block.
  await expect(
    c.agent.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [...text("a"), { ...image, data: "!!" }],
    } as never),
  ).rejects.toMatchObject({ data: { reason: "invalid_base64", index: 1 } });
});

test("an agent that says nothing about prompt capabilities takes text and links, not images", async () => {
  const { daemon } = await start();
  const c = await connectClient(daemon);
  const { sessionId } = await c.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  await expect(
    c.agent.request(methods.agent.session.prompt, { sessionId, prompt: [image] } as never),
  ).rejects.toMatchObject({ code: -32602 });
  await c.agent.request(methods.agent.session.prompt, {
    sessionId,
    prompt: [{ type: "resource_link", name: "a", uri: "file:///a" }],
  } as never);
});

// ---- what a session is made with ----

const setup = {
  mcpServers: [
    {
      name: "files",
      type: "stdio" as const,
      command: "/usr/bin/files-mcp",
      args: [],
      env: [{ name: "TOKEN", value: "s3cret-token" }],
    },
  ],
  systemPrompt: { mode: "append", content: [{ type: "text" as const, text: "Be brief." }] },
};

test("directories, MCP servers and system prompt are sent to the agent, kept, and sent again when it restarts", async () => {
  const { daemon, fake } = await start();
  const c = await connectClient(daemon);
  const { sessionId } = await c.agent.request(methods.agent.session.new, {
    cwd: "/tmp",
    additionalDirectories: [dir],
    ...setup,
  } as never);
  expect(fake.log.news[0]).toMatchObject({ cwd: "/tmp", additionalDirectories: [dir], ...setup });

  // The agent goes away (it was let go, or crashed); the next prompt starts another.
  fake.crash();
  await Bun.sleep(30);
  await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("again") });
  await until(() => fake.log.resumes.length === 1, "the agent to be resumed");
  expect(fake.log.resumes[0]).toMatchObject({
    sessionId,
    cwd: "/tmp",
    additionalDirectories: [dir],
    ...setup,
  });
});

test("the setup survives a new daemon, and a session without one sends none", async () => {
  const first = await start();
  const c = await connectClient(first.daemon);
  const withSetup = await c.agent.request(methods.agent.session.new, {
    cwd: "/tmp",
    ...setup,
  } as never);
  const plain = await c.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  await first.daemon.close();
  open = [];

  const second = await start();
  const d = await connectClient(second.daemon);
  await d.agent.request(methods.agent.session.prompt, {
    sessionId: withSetup.sessionId,
    prompt: text("hi"),
  });
  await d.agent.request(methods.agent.session.prompt, {
    sessionId: plain.sessionId,
    prompt: text("hi"),
  });
  await until(() => second.fake.log.resumes.length === 2, "both to be resumed");
  expect(second.fake.log.resumes[0]).toMatchObject(setup);
  expect(second.fake.log.resumes[1]).not.toHaveProperty("mcpServers");
  expect(second.fake.log.resumes[1]).not.toHaveProperty("systemPrompt");
  expect(second.fake.log.resumes[1]).not.toHaveProperty("additionalDirectories");
});

test("a server's secrets are in the index and nowhere else: not in the list, not in the log", async () => {
  const { daemon } = await start();
  const c = await connectClient(daemon);
  const { sessionId } = await c.agent.request(methods.agent.session.new, {
    cwd: "/tmp",
    ...setup,
  } as never);
  await c.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("hi") });
  await until(() => c.ended() >= 1, "the turn to end");

  const everywhere = JSON.stringify(await c.agent.request(methods.agent.session.list, {}));
  expect(everywhere).not.toContain("s3cret-token");
  for (const file of await readdir(sessionsDir(dir))) {
    expect(await readFile(join(sessionsDir(dir), file), "utf8")).not.toContain("s3cret-token");
  }
  expect(await readFile(indexPath(dir), "utf8")).toContain("s3cret-token");
  expect((await stat(indexPath(dir))).mode & 0o777).toBe(0o600);
});

test("a directory that is not there is refused up front, and nothing is stored", async () => {
  const { daemon, fake } = await start();
  const c = await connectClient(daemon);
  await expect(
    c.agent.request(methods.agent.session.new, {
      cwd: "/tmp",
      additionalDirectories: ["/no/such/directory"],
    } as never),
  ).rejects.toMatchObject({ code: -32602 });
  expect(fake.log.launches).toBe(0);
  expect((await c.agent.request(methods.agent.session.list, {})).sessions).toEqual([]);
});

// ---- what the agent tells about itself ----

test("a setting the agent changes itself is on record, and applied again when it restarts", async () => {
  const fake = fakeAgent({
    onPrompt: async ({ say }) => {
      await say({
        sessionUpdate: "config_option_update",
        configOptions: [
          {
            configId: "mode",
            name: "Mode",
            type: "select",
            currentValue: "acceptEdits",
            options: [{ value: "acceptEdits", name: "Accept edits" }],
          },
          {
            configId: "model",
            name: "Model",
            type: "select",
            currentValue: "default",
            options: [{ value: "default", name: "Default" }],
          },
        ],
      });
    },
  });
  const { daemon } = await start(fake);
  const c = await connectClient(daemon);
  const { sessionId } = await c.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  await c.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("go") });
  await until(() => c.ended() >= 1, "the turn to end");
  await Bun.sleep(30);
  expect((await sessionRow(c))["cycle/config"]).toEqual({ mode: "acceptEdits", model: "default" });

  fake.crash();
  await Bun.sleep(30);
  fake.log.configs.length = 0;
  await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("again") });
  await until(() => fake.log.configs.length === 2, "the settings to be applied");
  expect(fake.log.configs.map((x) => [x.configId, x.value])).toEqual([
    ["mode", "acceptEdits"],
    ["model", "default"],
  ]);
});

test("the agent's title names a session until the user does", async () => {
  const titles = ["Fixing the login bug", "Fixing the login bug, again"];
  const fake = fakeAgent({
    onPrompt: async ({ say }) => {
      await say({ sessionUpdate: "session_info_update", title: titles.shift() });
    },
  });
  const { daemon } = await start(fake);
  const c = await connectClient(daemon);
  const { sessionId } = await c.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  await c.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  const turn = async (what: string) => {
    const before = c.ended();
    await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text(what) });
    await until(() => c.ended() > before, "the turn to end");
    await Bun.sleep(30);
  };
  await turn("one");
  expect((await sessionRow(c)).title).toBe("Fixing the login bug");

  await c.agent.request("_cycle/session/set_title", { sessionId, title: "My name for it" });
  await turn("two");
  expect((await sessionRow(c)).title).toBe("My name for it");
  // Clients are not shown the agent's second title either, here or when they come back for the history.
  const told = (client: typeof c) =>
    client.seen
      .filter((s) => s.update.sessionUpdate === "session_info_update")
      .map((s) => (s.update as unknown as { title: string }).title);
  expect(told(c)).toEqual(["Fixing the login bug"]);
  const later = await connectClient(daemon);
  await later.agent.request(methods.agent.session.resume, {
    sessionId,
    cwd: "/tmp",
    replayFrom: { type: "start" },
  });
  await until(() => later.kinds().includes("replay_complete"), "the history");
  expect(told(later)).toEqual(["Fixing the login bug"]);
});

// ---- elicitation ----

const form = (fake: ReturnType<typeof fakeAgent>) => fake;

test("a form goes to a client that can answer it, and its answer goes back to the agent", async () => {
  const answers: unknown[] = [];
  const fake = fakeAgent({
    onPrompt: async ({ elicit }) => {
      answers.push(await elicit());
    },
  });
  const { daemon } = await start(form(fake));
  const capable = await connectClient(daemon, {
    onElicitation: () => ({ action: "accept", content: { pick: "b" } }),
  });
  const bystander = await connectClient(daemon, { onPermission: () => "never" });
  const { sessionId } = await capable.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  await capable.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  await bystander.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  await capable.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("ask") });
  await until(() => answers.length === 1, "the agent to be answered");
  expect(answers[0]).toEqual({ action: "accept", content: { pick: "b" } });
  expect(capable.elicitations).toHaveLength(1);
  expect(capable.elicitations[0]).toMatchObject({ sessionId, mode: "form", message: "Which one?" });
  // The request carries the daemon's id for it, like a permission request.
  expect(
    (capable.elicitations[0] as { _meta: Record<string, unknown> })._meta["cycle/requestId"],
  ).toBeString();
  // A client that cannot answer a form is not asked one.
  expect(bystander.elicitations).toHaveLength(0);
});

test("the first of two capable clients to answer settles it; the other is told", async () => {
  const answers: unknown[] = [];
  const { daemon } = await start(
    fakeAgent({
      onPrompt: async ({ elicit }) => {
        answers.push(await elicit());
      },
    }),
  );
  const a = await connectClient(daemon, {
    onElicitation: () => ({ action: "accept", content: { pick: "a" } }),
  });
  const b = await connectClient(daemon, { onElicitation: () => "never" });
  const { sessionId } = await a.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  await a.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  await b.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  await a.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("ask") });
  await until(() => answers.length === 1, "the agent to be answered");
  expect(answers[0]).toMatchObject({ action: "accept", content: { pick: "a" } });
  await until(() => b.resolved.length === 1, "request_resolved");
  expect(b.resolved[0]).toMatchObject({ sessionId, outcome: { action: "accept" } });
});

test("with no client that can answer a form attached, the agent is told so at once and the turn goes on", async () => {
  const answers: unknown[] = [];
  const { daemon } = await start(
    fakeAgent({
      onPrompt: async ({ elicit }) => {
        answers.push(await elicit());
      },
    }),
  );
  // This client has no elicitation capability, as the desktop client does not today.
  const c = await connectClient(daemon);
  const { sessionId } = await c.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  await c.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("ask") });
  await until(() => c.ended() >= 1, "the turn to end");
  expect(answers).toEqual([{ action: "cancel", _meta: { "cycle/noClient": true } }]);
  expect(c.elicitations).toHaveLength(0);
  // It never made the session wait for anyone.
  expect(c.kinds()).not.toContain("requires_action");
  expect((await sessionRow(c))["cycle/state"]).toBe("idle");
});

test("a cancel ends a form that is waiting, and the agent hears it was cancelled", async () => {
  const answers: unknown[] = [];
  const { daemon } = await start(
    fakeAgent({
      onPrompt: async ({ elicit }) => {
        answers.push(await elicit());
      },
    }),
  );
  const c = await connectClient(daemon, { onElicitation: () => "never" });
  const { sessionId } = await c.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  await c.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("ask") });
  await until(() => c.elicitations.length === 1, "the form to arrive");
  expect((await sessionRow(c))["cycle/state"]).toBe("requires_action");
  await c.agent.notify(methods.agent.session.cancel, { sessionId } as never);
  await until(() => answers.length === 1, "the agent to be answered");
  expect(answers[0]).toEqual({ action: "cancel" });
});

test("a form that waits when the agent exits is ended, not left behind", async () => {
  const fake = fakeAgent({ onPrompt: ({ elicit }) => elicit().then(() => undefined) });
  const { daemon } = await start(fake);
  const c = await connectClient(daemon, { onElicitation: () => "never" });
  const { sessionId } = await c.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  await c.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("ask") });
  await until(() => c.elicitations.length === 1, "the form to arrive");
  fake.crash();
  await until(() => c.resolved.length === 1, "request_resolved");
  expect(c.resolved[0]).toMatchObject({ outcome: { action: "cancel" } });
  expect((await sessionRow(c))["cycle/state"]).toBe("stopped");
});

test("when the last client that can answer a form goes, the agent is told, not kept waiting", async () => {
  const answers: unknown[] = [];
  const { daemon } = await start(
    fakeAgent({
      onPrompt: async ({ elicit }) => {
        answers.push(await elicit());
      },
    }),
  );
  const first = await connectClient(daemon, { onElicitation: () => "never" });
  const other = await connectClient(daemon); // cannot answer forms, and stays
  const { sessionId } = await first.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  await first.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  await other.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  await first.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("ask") });
  await until(() => first.elicitations.length === 1, "the form to arrive");
  first.close();
  await until(() => answers.length === 1, "the agent to be answered");
  expect(answers[0]).toEqual({ action: "cancel", _meta: { "cycle/noClient": true } });
  await until(() => other.ended() >= 1, "the turn to end");
});

test("a name the user gave before agents named sessions is not replaced by the agent's", async () => {
  const first = await start();
  const c = await connectClient(first.daemon);
  const { sessionId } = await c.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  await first.daemon.close();
  open = [];
  // The index as an older daemon wrote it: a title, and nothing that says where it came from.
  const index = JSON.parse(await readFile(indexPath(dir), "utf8"));
  index.sessions[sessionId].title = "Old name";
  await writeFile(indexPath(dir), JSON.stringify(index));

  const fake = fakeAgent({
    onPrompt: async ({ say }) => {
      await say({ sessionUpdate: "session_info_update", title: "The agent's idea" });
    },
  });
  const second = await start(fake);
  const d = await connectClient(second.daemon);
  await d.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  await d.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("go") });
  await until(() => d.ended() >= 1, "the turn to end");
  await Bun.sleep(30);
  expect((await sessionRow(d)).title).toBe("Old name");
});
