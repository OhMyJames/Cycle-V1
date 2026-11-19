import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { methods } from "@cycle/acp";
import { Daemon, TrustUnreadableError } from "../src/index.ts";
import { connectClient, until } from "./client.ts";
import { fakeAgent } from "./fake-agent.ts";
import { tempDir } from "./support.ts";

let dir: string;
let work: string;
let dispose: () => Promise<void>;
let disposeWork: () => Promise<void>;
let open: Daemon[] = [];
beforeEach(async () => {
  ({ dir, dispose } = await tempDir());
  ({ dir: work, dispose: disposeWork } = await tempDir());
  work = await realpath(work);
});
afterEach(async () => {
  for (const daemon of open) await daemon.close();
  open = [];
  await dispose();
  await disposeWork();
});

const start = async (fake = fakeAgent()) => {
  const daemon = await Daemon.start({ dataDir: dir, agents: [fake.definition] });
  open.push(daemon);
  return { daemon, fake, c: await connectClient(daemon) };
};

type Trust = { path: string; trusted: boolean | null; from: string | null };
type Client = Awaited<ReturnType<typeof connectClient>>;
const read = (c: Client, path: string) =>
  c.agent.request("_cycle/trust/read" as never, { path } as never) as Promise<Trust>;
const set = (c: Client, path: string, trusted: boolean) =>
  c.agent.request("_cycle/trust/set" as never, { path, trusted } as never) as Promise<Trust>;
const text = (value: string) => [{ type: "text" as const, text: value }];

test("a folder has no decision until one is set; it covers the folders under it, and the nearest wins", async () => {
  await mkdir(join(work, "app", "lib", "deep"), { recursive: true });
  const { c } = await start();
  const capabilities = (c.init._meta as Record<string, { trust?: boolean }>)["cycle/capabilities"];
  expect(capabilities?.trust).toBe(true);

  expect(await read(c, work)).toEqual({ path: work, trusted: null, from: null });
  expect(await set(c, work, true)).toEqual({ path: work, trusted: true, from: work });
  expect(await read(c, join(work, "app", "lib"))).toEqual({
    path: join(work, "app", "lib"),
    trusted: true,
    from: work,
  });
  await set(c, join(work, "app"), false);
  expect(await read(c, join(work, "app", "lib", "deep"))).toMatchObject({
    trusted: false,
    from: join(work, "app"),
  });
  expect(await read(c, work)).toMatchObject({ trusted: true, from: work });
});

test("a decision is kept by the real path, and outlasts the daemon", async () => {
  await mkdir(join(work, "real"));
  const { symlink } = await import("node:fs/promises");
  await symlink(join(work, "real"), join(work, "link"));
  const first = await start();
  expect(await set(first.c, join(work, "link"), true)).toMatchObject({
    path: join(work, "real"),
    from: join(work, "real"),
  });
  await first.daemon.close();
  open = [];
  const second = await start();
  expect(await read(second.c, join(work, "real"))).toMatchObject({ trusted: true });
});

test("only an absolute path to a folder that is there can be decided on", async () => {
  await writeFile(join(work, "file"), "x");
  const { c } = await start();
  await expect(read(c, "relative/path")).rejects.toMatchObject({ code: -32602 });
  await expect(set(c, join(work, "missing"), true)).rejects.toMatchObject({ code: -32002 });
  await expect(set(c, join(work, "file"), true)).rejects.toMatchObject({
    code: -32602,
    data: { reason: "not_a_folder" },
  });
});

test("a trust file that cannot be read stops the daemon from starting, and is not replaced", async () => {
  await writeFile(join(dir, "trust.json"), "{ not json");
  await expect(
    Daemon.start({ dataDir: dir, agents: [fakeAgent().definition] }),
  ).rejects.toBeInstanceOf(TrustUnreadableError);
  expect(await Bun.file(join(dir, "trust.json")).text()).toBe("{ not json");
});

test("the agent is told the decision for the session's folder when it starts, and nothing when there is none", async () => {
  await mkdir(join(work, "trusted"));
  await mkdir(join(work, "open"));
  const { c, fake } = await start();
  await set(c, join(work, "trusted"), true);
  await c.agent.request(methods.agent.session.new, { cwd: join(work, "trusted") });
  await c.agent.request(methods.agent.session.new, { cwd: join(work, "open") });
  const metas = fake.log.news.map((p) => (p._meta ?? {}) as Record<string, unknown>);
  expect(metas[0]?.["cycle/trusted"]).toBe(true);
  expect(metas[1]).not.toHaveProperty("cycle/trusted");
});

test("a new decision stops the agents of idle sessions in that folder, and the next prompt resumes with it", async () => {
  await mkdir(join(work, "project", "sub"), { recursive: true });
  await mkdir(join(work, "elsewhere"));
  const { c, fake } = await start();
  const inside = await c.agent.request(methods.agent.session.new, {
    cwd: join(work, "project", "sub"),
  });
  await c.agent.request(methods.agent.session.new, { cwd: join(work, "elsewhere") });
  expect(fake.log.launches).toBe(2);

  await set(c, join(work, "project"), true);
  const stateOf = async (sessionId: string) => {
    const { sessions } = await c.agent.request(methods.agent.session.list, {});
    const row = sessions.find((s) => s.sessionId === sessionId);
    return ((row?._meta ?? {}) as Record<string, unknown>)["cycle/state"];
  };
  for (let at = Date.now(); (await stateOf(inside.sessionId)) !== "stopped"; ) {
    if (Date.now() - at > 2_000) throw new Error("the agent did not stop");
    await Bun.sleep(10);
  }

  // Watching it, to see the turn end.
  await c.agent.request(methods.agent.session.resume, {
    sessionId: inside.sessionId,
    cwd: join(work, "project", "sub"),
  });
  await c.agent.request(methods.agent.session.prompt, {
    sessionId: inside.sessionId,
    prompt: text("again"),
  });
  await until(() => c.ended() >= 1, "the turn");
  // One more process, for the session in the folder; the other kept its own.
  expect(fake.log.launches).toBe(3);
  expect((fake.log.resumes.at(-1)?._meta ?? {}) as Record<string, unknown>).toHaveProperty(
    "cycle/trusted",
    true,
  );
});
