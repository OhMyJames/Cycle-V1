import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionUpdate } from "@cycle/acp";
import { Daemon } from "@cycle/daemon";
import { type Channel, commandChannel, connectUnix } from "@cycle/transport/client";
import { listenUnix } from "@cycle/transport/server";
import { fakeAgent } from "../../daemon/test/fake-agent.ts";
import { CycleClient, type PermissionAnswer } from "../src/index.ts";

let dir: string;
let cleanup: (() => void | Promise<void>)[] = [];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cv1-"));
});
afterEach(async () => {
  for (const clean of cleanup.reverse()) await clean();
  cleanup = [];
  await rm(dir, { recursive: true, force: true });
});

const until = async (condition: () => boolean, what: string, ms = 3_000) => {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > ms) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
};

const text = (value: string) => [{ type: "text" as const, text: value }];

/** A daemon on a unix socket, and a way to make clients that can be cut off. */
const setup = async (fake = fakeAgent()) => {
  const daemon = await Daemon.start({ dataDir: dir, agents: [fake.definition] });
  const socket = join(dir, "d.sock");
  const server = await listenUnix({
    path: socket,
    onConnection: ({ stream }) => void daemon.accept(stream),
  });
  cleanup.push(async () => {
    server.close();
    await daemon.close();
  });
  const channels: Channel[] = [];
  let down = false;
  const connect = async () => {
    if (down) throw new Error("the network is down");
    const channel = await connectUnix(socket);
    channels.push(channel);
    return channel;
  };
  const make = (events: ConstructorParameters<typeof CycleClient>[0]["events"] = {}) => {
    const client = new CycleClient({ connect, events, backoff: { first: 10, max: 50 } });
    cleanup.push(() => client.close());
    return client;
  };
  return {
    fake,
    make,
    /** Cuts every connection, as a network drop would. */
    drop: () => {
      for (const channel of channels.splice(0)) channel.close();
    },
    network: (up: boolean) => {
      down = !up;
    },
  };
};

/** The seq of each record seen. replay_complete marks a place and is not a record. */
const seqs = (seen: { update: SessionUpdate; seq: number | undefined }[]) =>
  seen
    .filter((s) => s.seq !== undefined && s.update.sessionUpdate !== "replay_complete")
    .map((s) => s.seq);

test("starts, makes a session, and shows a turn as it happens", async () => {
  const { make } = await setup();
  const seen: { update: SessionUpdate; seq: number | undefined }[] = [];
  const client = make({ update: (_id, update, seq) => seen.push({ update, seq }) });
  await client.start();
  expect(client.state).toBe("connected");
  expect(client.capabilities).toMatchObject({ agents: ["fake"] });
  const sessionId = await client.newSession({ cwd: "/tmp" });
  await client.watch(sessionId, "/tmp");
  await client.prompt(sessionId, text("hi"));
  await until(
    () => seen.some((s) => (s.update as { stopReason?: string }).stopReason === "end_turn"),
    "the turn",
  );
  expect(seqs(seen)).toEqual([2, 3, 4, 5]);
  expect((await client.listSessions()).map((s) => s.sessionId)).toEqual([sessionId]);
});

test("after a drop it reconnects and shows what it missed once, in order", async () => {
  const { make, drop } = await setup();
  const states: string[] = [];
  const seen: { update: SessionUpdate; seq: number | undefined }[] = [];
  const watcher = make({
    update: (_id, update, seq) => seen.push({ update, seq }),
    connection: (state) => states.push(state),
  });
  await watcher.start();
  const sessionId = await watcher.newSession({ cwd: "/tmp" });
  await watcher.watch(sessionId, "/tmp");
  await watcher.prompt(sessionId, text("one"));
  await until(() => seqs(seen).length === 4, "the first turn");

  // Everyone's connection is cut; another client carries on while this one is away.
  const other = make();
  await other.start();
  drop();
  await until(() => states.includes("reconnecting"), "the loss to be noticed");
  await until(() => watcher.state === "connected", "the reconnect");
  await other.start().catch(() => undefined);
  await until(() => other.state === "connected", "the other client to be back");
  await other.watch(sessionId, "/tmp");
  await other.prompt(sessionId, text("two"));
  await until(() => seqs(seen).length === 8, "the second turn");

  // Each record once, in order, with no gap and no repeat.
  expect(seqs(seen)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
  expect(states).toEqual(["connecting", "connected", "reconnecting", "connected"]);
});

test("what happened while it was away is delivered when it comes back", async () => {
  const { make, drop, network } = await setup();
  const seen: { update: SessionUpdate; seq: number | undefined }[] = [];
  const watcher = make({ update: (_id, update, seq) => seen.push({ update, seq }) });
  await watcher.start();
  const sessionId = await watcher.newSession({ cwd: "/tmp" });
  await watcher.watch(sessionId, "/tmp");

  const other = make();
  await other.start();
  await other.watch(sessionId, "/tmp");
  network(false);
  drop();
  await until(() => watcher.state === "reconnecting", "the loss");
  // The other client was cut too; wait for it, then let only it back.
  network(true);
  await until(() => other.state === "connected", "the other client");
  await other.prompt(sessionId, text("while you were out"));
  await until(
    () => seqs(seen).length === 4,
    "the turn to be shown to the one that was away",
    5_000,
  );
  expect(seqs(seen)).toEqual([2, 3, 4, 5]);
});

test("a permission request is answered by the handler", async () => {
  const outcomes: unknown[] = [];
  const fake = fakeAgent({
    onPrompt: async ({ ask }) => {
      outcomes.push(await ask());
    },
  });
  const { make } = await setup(fake);
  const asked: string[] = [];
  const client = make({
    permission: async (sessionId): Promise<PermissionAnswer> => {
      asked.push(sessionId);
      return { outcome: "selected", optionId: "allow" };
    },
  });
  await client.start();
  const sessionId = await client.newSession({ cwd: "/tmp" });
  await client.watch(sessionId, "/tmp");
  await client.prompt(sessionId, text("ask"));
  await until(() => outcomes.length === 1, "the answer");
  expect(asked).toEqual([sessionId]);
  expect(outcomes[0]).toMatchObject({ outcome: { outcome: "selected", optionId: "allow" } });
});

test("a request left open by a dropped connection is asked again after the reconnect", async () => {
  const outcomes: unknown[] = [];
  const fake = fakeAgent({
    onPrompt: async ({ ask }) => {
      outcomes.push(await ask());
    },
  });
  const { make, drop } = await setup(fake);
  let asked = 0;
  const client = make({
    permission: async (): Promise<PermissionAnswer> => {
      asked++;
      // The first time the user is slow, and the connection goes before they answer.
      if (asked === 1) return new Promise<PermissionAnswer>(() => {});
      return { outcome: "selected", optionId: "allow" };
    },
  });
  await client.start();
  const sessionId = await client.newSession({ cwd: "/tmp" });
  await client.watch(sessionId, "/tmp");
  await client.prompt(sessionId, text("ask"));
  await until(() => asked === 1, "the first ask");
  drop();
  await until(() => asked === 2, "the second ask, after the reconnect", 5_000);
  await until(() => outcomes.length === 1, "the agent to be answered");
  expect(outcomes[0]).toMatchObject({ outcome: { outcome: "selected", optionId: "allow" } });
});

test("start fails if the daemon cannot be reached, and close stops retrying", async () => {
  const { make, network } = await setup();
  network(false);
  const client = make();
  await expect(client.start()).rejects.toThrow("the network is down");
  expect(client.state).toBe("closed");

  network(true);
  const second = make();
  await second.start();
  network(false);
  const states: string[] = [];
  const third = make({ connection: (s) => states.push(s) });
  network(true);
  await third.start();
  network(false);
  await third.close();
  expect(third.state).toBe("closed");
});

test("reads and sets an agent's defaults, and hears of a change made by someone else", async () => {
  const { make } = await setup();
  const heard: string[] = [];
  const a = make({ defaultsChanged: (agent) => heard.push(agent) });
  const b = make();
  await a.start();
  await b.start();
  expect(await a.agentDefaults("fake")).toEqual({});
  await b.setAgentDefaults("fake", { mode: "plan" });
  expect(await a.agentDefaults("fake")).toEqual({ mode: "plan" });
  await until(() => heard.length === 1, "the change");
  expect(heard).toEqual(["fake"]);
});

test("a command that cannot run fails with what it said, not only that the connection ended", async () => {
  const client = new CycleClient({
    connect: async () =>
      commandChannel({
        command: [
          "/bin/sh",
          "-c",
          "echo 'sh: /home/u/.local/bin/cycle-daemon: No such file or directory' >&2; exit 127",
        ],
      }),
  });
  await expect(client.start()).rejects.toThrow(/cycle-daemon: No such file or directory/);
});
