import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CycleClient, connectUnix } from "../src/index.ts";
import { connectorsDaemon } from "./fake-connectors-daemon.ts";

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

const setup = async (options: { capable?: boolean } = {}) => {
  const daemon = await connectorsDaemon(dir, options);
  let changes = 0;
  const client = new CycleClient({
    connect: () => connectUnix(daemon.socket),
    events: { connectorsChanged: () => changes++ },
  });
  cleanup.push(async () => {
    await client.close();
    daemon.close();
  });
  await client.start();
  return { daemon, client, changes: () => changes };
};

test("adds, lists, changes and removes a connector; secrets go in and only their names come out", async () => {
  const { daemon, client, changes } = await setup();
  const added = await client.addConnector({
    name: "linear",
    transport: { type: "http", url: "https://mcp.linear.app/mcp" },
    auth: { type: "none" },
    secrets: { headers: { Authorization: "Bearer sk-secret" } },
  });
  expect(added.secrets.headers).toEqual(["Authorization"]);
  expect(JSON.stringify(added)).not.toContain("sk-secret");
  expect(daemon.secrets.get(added.id)).toEqual({ Authorization: "Bearer sk-secret" });

  const listed = await client.listConnectors();
  expect(listed.map((c) => c.name)).toEqual(["linear"]);
  expect(JSON.stringify(listed)).not.toContain("sk-secret");

  const off = await client.updateConnector({
    id: added.id,
    enabled: false,
    secrets: { headers: { Authorization: null } },
  });
  expect(off.enabled).toBe(false);
  expect(off.secrets.headers).toEqual([]);

  await client.removeConnector(added.id);
  expect(await client.listConnectors()).toEqual([]);
  // Each change was told to the client that made it, as to any other.
  const started = Date.now();
  while (changes() < 3 && Date.now() - started < 2_000) await Bun.sleep(5);
  expect(changes()).toBeGreaterThanOrEqual(3);
});

test("starts and finishes a sign-in, and clears it", async () => {
  const { client } = await setup();
  const connector = await client.addConnector({
    name: "notion",
    transport: { type: "http", url: "https://mcp.notion.com/mcp" },
    auth: { type: "oauth" },
  });
  const { flowId, authorizationUrl } = await client.startConnectorAuth(
    connector.id,
    "http://127.0.0.1:1234/callback",
  );
  const state = new URL(authorizationUrl).searchParams.get("state") ?? "";
  const signedIn = await client.finishConnectorAuth({ flowId, code: "code-1", state });
  expect(signedIn).toMatchObject({ authorized: true, status: { state: "ready" } });
  const out = await client.clearConnectorAuth(connector.id);
  expect(out).toMatchObject({ authorized: false, status: { state: "needs_auth" } });
});

test("a daemon that does not keep connectors is not asked", async () => {
  const { client } = await setup({ capable: false });
  await expect(client.listConnectors()).rejects.toThrow("too old to keep connectors");
});
