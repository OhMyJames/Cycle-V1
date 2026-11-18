// Runs under real Node (Electron's, with ELECTRON_RUN_AS_NODE), not Bun: the client half of the
// transport and CycleClient must work where Electron's main process runs. Prints one JSON line.
import { CycleClient } from "@cycle/client";
import { connectUnix } from "@cycle/transport/client";

const socket = process.argv[2];
if (socket === undefined) throw new Error("no socket path");
const seen: { kind: string; seq: number | undefined }[] = [];
const client = new CycleClient({
  connect: () => connectUnix(socket),
  events: { update: (_id, update, seq) => seen.push({ kind: update.sessionUpdate, seq }) },
});
await client.start();
const sessionId = await client.newSession({ cwd: "/work" });
await client.watch(sessionId, "/work");
await client.prompt(sessionId, [{ type: "text", text: "hello from node" }]);
const started = Date.now();
while (!seen.some((s) => s.kind === "agent_message_chunk") && Date.now() - started < 10_000) {
  await new Promise((resolve) => setTimeout(resolve, 20));
}
await new Promise((resolve) => setTimeout(resolve, 200));
const sessions = await client.listSessions();
await client.close();
console.log(
  JSON.stringify({
    node: process.version,
    bun: typeof Bun,
    sessionId,
    seen,
    sessions: sessions.length,
  }),
);
process.exit(0);
