// How much memory a daemon holds with N sessions loaded, and what idle reclaim gives back (CYCL-104, docs/daemon.md
// "空闲回收"). It runs a daemon of its own in a temporary data directory, against a real Claude: each session gets
// one short turn (a little of an account's quota), so it is not part of any test run.
//
//   bun apps/daemon/scripts/measure-memory.ts [--source <data dir>] [--counts 1,5,10] [--model haiku]
//
// The credential is CYCLE_REAL_MODEL_TOKEN, or else `claude.env.CLAUDE_CODE_OAUTH_TOKEN` from the source data
// directory's config.json (default /Users/$USER/.cycle). It goes into the temporary config and nowhere else; the
// temporary directory is removed at the end. A daemon already running is not touched.
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";
import { CycleClient, connectUnix } from "@cycle/client";

const { values } = parseArgs({
  options: {
    source: { type: "string", default: `/Users/${process.env.USER}/.cycle` },
    counts: { type: "string", default: "1,5,10" },
    model: { type: "string", default: "haiku" },
  },
});
const counts = (values.counts as string).split(",").map(Number);
const main = new URL("../src/main.ts", import.meta.url).pathname;

const token =
  process.env.CYCLE_REAL_MODEL_TOKEN ||
  (
    (await Bun.file(join(values.source as string, "config.json"))
      .json()
      .catch(() => ({}))) as { claude?: { env?: Record<string, string> } }
  ).claude?.env?.CLAUDE_CODE_OAUTH_TOKEN;
if (!token) {
  console.error(
    "No credential: set CYCLE_REAL_MODEL_TOKEN, or give --source a data directory that has one.",
  );
  process.exit(2);
}

/** Resident memory (KB) of a process and everything under it, and how many processes that is. */
const treeOf = (root: number): { kb: number; processes: number; ownKb: number } => {
  const rows = execFileSync("ps", ["-A", "-o", "pid=,ppid=,rss="], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number) as [number, number, number]);
  const children = new Map<number, number[]>();
  const rss = new Map<number, number>();
  for (const [pid, ppid, kb] of rows) {
    rss.set(pid, kb);
    children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  let kb = 0;
  let processes = 0;
  const stack = [root];
  while (stack.length > 0) {
    const pid = stack.pop() as number;
    kb += rss.get(pid) ?? 0;
    processes += 1;
    stack.push(...(children.get(pid) ?? []));
  }
  return { kb, processes, ownKb: rss.get(root) ?? 0 };
};

const mb = (kb: number) => `${(kb / 1024).toFixed(0)} MB`;

const dir = await mkdtemp("/tmp/cyc-mem-");
const work = join(dir, "work");
await mkdir(work);
// Agents are let go 15 s after they are idle with nobody attached, so the script need not wait ten minutes.
await writeFile(
  join(dir, "config.json"),
  JSON.stringify({
    claude: { env: { CLAUDE_CODE_OAUTH_TOKEN: token } },
    idle: { agentMinutes: 0.25, exitMinutes: 0 },
    log: { level: process.env.CYCLE_MEASURE_DEBUG ? "debug" : "info" },
  }),
  { mode: 0o600 },
);
const daemon = Bun.spawn(["bun", main, "serve", "--data-dir", dir], {
  stdout: "ignore",
  stderr: "ignore",
  env: { ...process.env, CYCLE_HOME: dir },
});
const socket = join(dir, "daemon.sock");

const ended = new Map<string, number>();
const connect = async () => {
  const client = new CycleClient({
    connect: () => connectUnix(socket),
    name: "measure-memory",
    events: {
      update: (sessionId: string, update: SessionUpdate) => {
        const u = update as { sessionUpdate: string; state?: string; stopReason?: string };
        if (u.sessionUpdate === "state_update" && u.state === "idle" && u.stopReason !== undefined)
          ended.set(sessionId, (ended.get(sessionId) ?? 0) + 1);
      },
    },
  });
  for (let n = 0; ; n++) {
    try {
      await client.start();
      return client;
    } catch (error) {
      if (n > 100) throw error;
      await Bun.sleep(100);
    }
  }
};
const waitFor = async (condition: () => boolean, what: string, ms = 300_000) => {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(200);
  }
};

const rows: string[] = [];
const measure = async (label: string) => {
  await Bun.sleep(3_000);
  const { kb, processes, ownKb } = treeOf(daemon.pid);
  const row = `| ${label} | ${processes - 1} | ${mb(ownKb)} | ${mb(kb)} |`;
  rows.push(row);
  console.log(row);
};

try {
  let client = await connect();
  await measure("0 sessions");
  const sessions: string[] = [];
  for (const target of counts) {
    while (sessions.length < target) {
      const id = await client.newSession({ cwd: work, config: { model: values.model as string } });
      await client.watch(id, work);
      await client.prompt(id, [{ type: "text", text: "Reply with just the word: ok" }]);
      await waitFor(() => (ended.get(id) ?? 0) >= 1, `turn of session ${sessions.length + 1}`);
      sessions.push(id);
    }
    await measure(`${target} sessions, attached`);
  }
  // Every client gone: the sweep lets each idle agent go once it has been idle 15 s.
  await client.close();
  await Bun.sleep(15_000 + 35_000);
  await measure(`${sessions.length} sessions, no client, after reclaim`);
  // And a session whose agent was let go answers again: its agent is started and resumes it.
  client = await connect();
  const first = sessions[0] as string;
  // The replay a new client is sent repeats the old turn's end: counted from after it.
  await client.watch(first, work);
  const before = ended.get(first) ?? 0;
  await client.prompt(first, [{ type: "text", text: "Reply with just the word: again" }]);
  await waitFor(() => (ended.get(first) ?? 0) > before, "the turn after reclaim");
  await measure(`${sessions.length} sessions, 1 reopened`);
  await client.close();
  console.log(
    `\n| state | processes under the daemon | daemon | daemon + agents |\n| --- | --- | --- | --- |\n${rows.join("\n")}`,
  );
} catch (error) {
  // What the daemon said is the way to learn why; it has events and ids only, no content or credential.
  console.error(
    (
      await Bun.file(join(dir, "daemon.log"))
        .text()
        .catch(() => "")
    )
      .split("\n")
      .slice(-40)
      .join("\n"),
  );
  throw error;
} finally {
  daemon.kill("SIGTERM");
  await daemon.exited;
  if (process.env.CYCLE_MEASURE_KEEP) console.error(`kept ${dir}`);
  else await rm(dir, { recursive: true, force: true });
}
