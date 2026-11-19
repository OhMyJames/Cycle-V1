import { expect, test } from "bun:test";
import { type Spawned, StdioBridge } from "../src/index.ts";

/** A process in this test: what is written to it is recorded, what it says is pushed by the test. */
const fakeProcess = () => {
  const written: unknown[] = [];
  let push: (line: string) => void = () => {};
  let fail: (error: Error) => void = () => {};
  let kills = 0;
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      push = (line) => controller.enqueue(new TextEncoder().encode(line));
      fail = (error) => controller.error(error);
    },
  });
  const process: Spawned = {
    stdin: {
      write: (data) => {
        written.push(JSON.parse(data));
      },
      end: () => {},
    },
    stdout,
    exited: new Promise(() => {}),
    kill: () => {
      kills++;
    },
  };
  return { process, written, push: (line: string) => push(line), fail, kills: () => kills };
};

const post = (body: unknown, signal?: AbortSignal) =>
  new Request("http://127.0.0.1/mcp/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    ...(signal !== undefined ? { signal } : {}),
  });

test("a request is answered with the process's reply to it", async () => {
  const p = fakeProcess();
  const bridge = new StdioBridge(p.process, () => {});
  const answer = bridge.handle(post({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
  await Bun.sleep(5);
  p.push(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } })}\n`);
  expect(await (await answer).json()).toEqual({ jsonrpc: "2.0", id: 1, result: { tools: [] } });
  bridge.stop();
});

test("output that breaks ends the process too, and says it failed; a stop by Cycle does not", async () => {
  const broken = fakeProcess();
  const failures: boolean[] = [];
  const bridge = new StdioBridge(broken.process, (failed) => failures.push(failed));
  broken.fail(new Error("stdout broke"));
  await bridge.ended;
  expect(broken.kills()).toBeGreaterThan(0);
  expect(failures).toEqual([true]);

  const stopped = fakeProcess();
  const ends: boolean[] = [];
  const second = new StdioBridge(stopped.process, (failed) => ends.push(failed));
  second.stop();
  stopped.fail(new Error("killed"));
  await second.ended;
  expect(ends).toEqual([false]);
});

test("a request the agent cancels, or gives up on, stops being waited for", async () => {
  const p = fakeProcess();
  const bridge = new StdioBridge(p.process, () => {});
  const first = bridge.handle(post({ jsonrpc: "2.0", id: 7, method: "tools/call" }));
  await Bun.sleep(5);
  await bridge.handle(
    post({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7 } }),
  );
  expect(await (await first).json()).toMatchObject({ id: 7, error: { code: -32800 } });

  const controller = new AbortController();
  const second = bridge.handle(
    post({ jsonrpc: "2.0", id: 8, method: "tools/call" }, controller.signal),
  );
  await Bun.sleep(5);
  controller.abort();
  expect(await (await second).json()).toMatchObject({ id: 8, error: { code: -32800 } });
  bridge.stop();
});
