import { afterEach, beforeEach, expect, test } from "bun:test";
import { realpath, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { methods } from "@agentclientprotocol/sdk/experimental/v2";
import { ConnectorFileUnreadableError, ConnectorService, Daemon } from "../src/index.ts";
import { connectClient, until } from "./client.ts";
import { fakeAgent } from "./fake-agent.ts";
import { tempDir } from "./support.ts";

/**
 * A fake MCP server that wants a bearer token, and the authorization server it names, both on
 * loopback (http to loopback is allowed). It records what reached it.
 */
/** Polls an async condition, at most `ms`. */
const eventually = async (condition: () => Promise<boolean>, what: string, ms = 2_000) => {
  const started = Date.now();
  while (!(await condition())) {
    if (Date.now() - started > ms) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
};

const fakeServer = () => {
  const seen = {
    mcp: [] as { authorization: string | null; custom: string | null; body: string }[],
    registrations: [] as Record<string, unknown>[],
    tokens: [] as Record<string, string>[],
    revoked: [] as string[],
  };
  const state = {
    access: "access-1",
    refresh: "refresh-1",
    valid: new Set(["access-1"]),
    /** When set, a refresh waits for it: a test changes things meanwhile. */
    refreshGate: undefined as Promise<void> | undefined,
  };
  let issued = 1;
  const server: ReturnType<typeof Bun.serve> = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request: Request): Promise<Response> => {
      const url = new URL(request.url);
      const origin: string = `http://127.0.0.1:${server.port}`;
      if (url.pathname === "/mcp") {
        const body = await request.text();
        seen.mcp.push({
          authorization: request.headers.get("authorization"),
          custom: request.headers.get("x-team"),
          body,
        });
        const token = request.headers.get("authorization")?.replace(/^Bearer /, "");
        if (token === undefined || !state.valid.has(token)) {
          return new Response("no", {
            status: 401,
            headers: {
              "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
            },
          });
        }
        const id = (JSON.parse(body) as { id: number }).id;
        return Response.json({ jsonrpc: "2.0", id, result: { ok: true } });
      }
      if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
        return Response.json({
          resource: `${origin}/mcp`,
          authorization_servers: [`${origin}/as`],
          scopes_supported: ["read"],
        });
      }
      if (url.pathname === "/.well-known/oauth-authorization-server/as") {
        return Response.json({
          issuer: `${origin}/as`,
          authorization_endpoint: `${origin}/as/authorize`,
          token_endpoint: `${origin}/as/token`,
          registration_endpoint: `${origin}/as/register`,
          revocation_endpoint: `${origin}/as/revoke`,
          code_challenge_methods_supported: ["S256"],
        });
      }
      if (url.pathname === "/as/register") {
        seen.registrations.push((await request.json()) as Record<string, unknown>);
        return Response.json({ client_id: "client-1" }, { status: 201 });
      }
      if (url.pathname === "/as/token") {
        const form = Object.fromEntries(new URLSearchParams(await request.text()));
        seen.tokens.push(form);
        if (form.grant_type === "authorization_code" && form.code === "good-code") {
          return Response.json({
            access_token: state.access,
            refresh_token: state.refresh,
            expires_in: 3600,
          });
        }
        if (form.grant_type === "refresh_token" && form.refresh_token === state.refresh) {
          await state.refreshGate;
          issued++;
          state.access = `access-${issued}`;
          state.valid = new Set([state.access]);
          return Response.json({ access_token: state.access, expires_in: 3600 });
        }
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      if (url.pathname === "/as/revoke") {
        seen.revoked.push(new URLSearchParams(await request.text()).get("token") ?? "");
        return new Response(null, { status: 200 });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/mcp`,
    seen,
    state,
    stop: () => server.stop(true),
  };
};

let dir: string;
let dispose: () => Promise<void>;
let open: Daemon[] = [];
let upstream: ReturnType<typeof fakeServer>;
beforeEach(async () => {
  ({ dir, dispose } = await tempDir());
  upstream = fakeServer();
});
afterEach(async () => {
  for (const daemon of open) await daemon.close();
  open = [];
  upstream.stop();
  await dispose();
});

const start = async (fake = fakeAgent({}, { mcpHttp: true })) => {
  const daemon = await Daemon.start({ dataDir: dir, agents: [fake.definition] });
  open.push(daemon);
  return { daemon, fake, c: await connectClient(daemon) };
};

type Client = Awaited<ReturnType<typeof connectClient>>;
type GivenServer = { url: string; headers: { name: string; value: string }[] };
const call = <T = Record<string, unknown>>(c: Client, method: string, params: object) =>
  c.agent.request(method as never, params as never) as Promise<T>;
type Connector = {
  id: string;
  name: string;
  enabled: boolean;
  secrets: { headers: string[]; env: string[] };
  authorized: boolean;
  status: { state: string; reason?: string };
};

const errorOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error as { code: number; data?: { reason?: string } };
  }
  throw new Error("it did not fail");
};

/** Calls the gateway as the agent would, with what the agent was given. */
const asAgent = (
  server: { url: string; headers: { name: string; value: string }[] },
  init: RequestInit = {},
) =>
  fetch(server.url, {
    method: "POST",
    ...init,
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...Object.fromEntries(server.headers.map((h) => [h.name, h.value])),
      ...(init.headers as Record<string, string> | undefined),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" }),
  });

const signIn = async (c: Client, id: string) => {
  const begun = await call<{ flowId: string; authorizationUrl: string }>(
    c,
    "_cycle/connectors/auth/start",
    { id, redirectUri: "http://127.0.0.1:43123/callback" },
  );
  const state = new URL(begun.authorizationUrl).searchParams.get("state") ?? "";
  return call<{ connector: Connector }>(c, "_cycle/connectors/auth/finish", {
    flowId: begun.flowId,
    code: "good-code",
    state,
  });
};

test("a connector is added, listed, changed and removed; its secrets go in and never come out", async () => {
  const { c } = await start();
  const capabilities = (c.init._meta as Record<string, { connectors?: boolean }>)[
    "cycle/capabilities"
  ];
  expect(capabilities?.connectors).toBe(true);

  const { connector } = await call<{ connector: Connector }>(c, "_cycle/connectors/add", {
    name: "linear",
    transport: { type: "http", url: upstream.url },
    auth: { type: "none" },
    secrets: { headers: { "X-Team": "team-secret-value" } },
  });
  expect(connector).toMatchObject({
    name: "linear",
    enabled: true,
    secrets: { headers: ["X-Team"], env: [] },
    authorized: false,
    status: { state: "ready" },
  });
  const listed = await call<{ connectors: Connector[] }>(c, "_cycle/connectors/list", {});
  expect(listed.connectors).toHaveLength(1);
  expect(JSON.stringify(listed)).not.toContain("team-secret-value");
  await until(() => c.connectorsChanged() >= 1, "a change notice");

  // The catalog has no secret; the vault is 0600 in a 0700 folder.
  const catalog = await Bun.file(join(dir, "connectors", "catalog.json")).text();
  expect(catalog).not.toContain("team-secret-value");
  expect((await stat(join(dir, "connectors", "credentials.json"))).mode & 0o777).toBe(0o600);
  expect((await stat(join(dir, "connectors"))).mode & 0o777).toBe(0o700);

  const off = await call<{ connector: Connector }>(c, "_cycle/connectors/update", {
    id: connector.id,
    enabled: false,
    secrets: { headers: { "X-Team": null } },
  });
  expect(off.connector).toMatchObject({
    enabled: false,
    secrets: { headers: [] },
    status: { state: "disabled" },
  });

  await call(c, "_cycle/connectors/remove", { id: connector.id });
  expect(
    (await call<{ connectors: Connector[] }>(c, "_cycle/connectors/list", {})).connectors,
  ).toEqual([]);
  expect(await Bun.file(join(dir, "connectors", "credentials.json")).text()).not.toContain(
    connector.id,
  );
});

test("names are unique, addresses must be safe for a token, and signing in needs http", async () => {
  const { c } = await start();
  await call(c, "_cycle/connectors/add", {
    name: "one",
    transport: { type: "http", url: upstream.url },
    auth: { type: "none" },
  });
  expect(
    (
      await errorOf(
        call(c, "_cycle/connectors/add", {
          name: "one",
          transport: { type: "http", url: upstream.url },
          auth: { type: "none" },
        }),
      )
    ).data?.reason,
  ).toBe("name_taken");
  expect(
    (
      await errorOf(
        call(c, "_cycle/connectors/add", {
          name: "two",
          transport: { type: "http", url: "http://example.com/mcp" },
          auth: { type: "none" },
        }),
      )
    ).data?.reason,
  ).toBe("insecure_url");
  expect(
    (
      await errorOf(
        call(c, "_cycle/connectors/add", {
          name: "three",
          transport: { type: "stdio", command: "x", args: [] },
          auth: { type: "oauth" },
        }),
      )
    ).data?.reason,
  ).toBe("oauth_needs_http");
  expect(
    (
      await errorOf(
        call(c, "_cycle/connectors/add", {
          name: "Bad Name",
          transport: { type: "http", url: upstream.url },
          auth: { type: "none" },
        }),
      )
    ).code,
  ).toBe(-32602);
});

test("signing in: the daemon discovers, registers and keeps the verifier; only a code crosses the wire", async () => {
  const { c } = await start();
  const { connector } = await call<{ connector: Connector }>(c, "_cycle/connectors/add", {
    name: "linear",
    transport: { type: "http", url: upstream.url },
    auth: { type: "oauth" },
  });
  expect(connector.status.state).toBe("needs_auth");

  const begun = await call<{ flowId: string; authorizationUrl: string }>(
    c,
    "_cycle/connectors/auth/start",
    { id: connector.id, redirectUri: "http://127.0.0.1:43123/callback" },
  );
  const url = new URL(begun.authorizationUrl);
  expect(url.pathname).toBe("/as/authorize");
  expect(Object.fromEntries(url.searchParams)).toMatchObject({
    response_type: "code",
    client_id: "client-1",
    redirect_uri: "http://127.0.0.1:43123/callback",
    code_challenge_method: "S256",
    scope: "read",
    resource: upstream.url,
  });
  expect(url.searchParams.get("code_challenge")?.length).toBeGreaterThan(40);
  expect(upstream.seen.registrations[0]).toMatchObject({
    redirect_uris: ["http://127.0.0.1:43123/callback"],
    token_endpoint_auth_method: "none",
  });

  // The wrong state is refused, and the flow is spent.
  expect(
    (
      await errorOf(
        call(c, "_cycle/connectors/auth/finish", {
          flowId: begun.flowId,
          code: "good-code",
          state: "forged",
        }),
      )
    ).data?.reason,
  ).toBe("state_mismatch");
  expect(
    (
      await errorOf(
        call(c, "_cycle/connectors/auth/finish", {
          flowId: begun.flowId,
          code: "good-code",
          state: url.searchParams.get("state"),
        }),
      )
    ).code,
  ).toBe(-32002);

  const done = await signIn(c, connector.id);
  expect(done.connector).toMatchObject({ authorized: true, status: { state: "ready" } });
  const exchange = upstream.seen.tokens.find((t) => t.grant_type === "authorization_code");
  expect(exchange?.code_verifier?.length).toBeGreaterThan(40);
  expect(exchange?.resource).toBe(upstream.url);
  // No token in anything a client reads.
  const listed = JSON.stringify(await call(c, "_cycle/connectors/list", {}));
  expect(listed).not.toContain("access-1");
  expect(listed).not.toContain("refresh-1");

  // Signing out forgets the token here and asks the server to forget it too.
  const cleared = await call<{ connector: Connector }>(c, "_cycle/connectors/auth/clear", {
    id: connector.id,
  });
  expect(cleared.connector).toMatchObject({ authorized: false, status: { state: "needs_auth" } });
  expect(upstream.seen.revoked).toContain("refresh-1");
});

test("an agent gets each connector as the gateway's address with a key of its session; the token stays here", async () => {
  const { c, fake } = await start();
  const { connector } = await call<{ connector: Connector }>(c, "_cycle/connectors/add", {
    name: "linear",
    transport: { type: "http", url: upstream.url },
    auth: { type: "oauth" },
    secrets: { headers: { "X-Team": "team-7" } },
  });
  await signIn(c, connector.id);
  await c.agent.request(methods.agent.session.new, {
    cwd: dir,
    mcpServers: [{ type: "http", name: "own", url: "http://127.0.0.1:1/own", headers: [] }],
  } as never);
  const given = (fake.log.news[0]?.mcpServers ?? []) as {
    name: string;
    url: string;
    headers: { name: string; value: string }[];
  }[];
  expect(given.map((s) => s.name)).toEqual(["own", "linear"]);
  const server = given[1] as { url: string; headers: { name: string; value: string }[] };
  expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\//);
  expect(JSON.stringify(given)).not.toContain("access-1");
  expect(JSON.stringify(given)).not.toContain("team-7");

  // Through the gateway: the server gets the token and the header, never the agent's key.
  const answer = await asAgent(server);
  expect(answer.status).toBe(200);
  expect(answer.headers.get("www-authenticate")).toBeNull();
  expect(await answer.json()).toEqual({ jsonrpc: "2.0", id: 7, result: { ok: true } });
  const reached = upstream.seen.mcp.at(-1);
  expect(reached).toMatchObject({ authorization: "Bearer access-1", custom: "team-7" });

  // An expired token is refreshed once, here, and the request goes again.
  upstream.state.valid = new Set();
  upstream.state.access = "access-1";
  const refreshed = await asAgent(server);
  expect(refreshed.status).toBe(200);
  expect(upstream.seen.tokens.filter((t) => t.grant_type === "refresh_token")).toHaveLength(1);
  expect(upstream.seen.mcp.at(-1)?.authorization).toBe("Bearer access-2");

  // Without the key, or under another name for the host, nothing.
  expect((await asAgent({ url: server.url, headers: [] })).status).toBe(401);
  expect(
    (
      await asAgent(
        { url: server.url.replace("127.0.0.1", "localhost"), headers: server.headers },
        { headers: { host: "evil.example" } },
      )
    ).status,
  ).toBe(421);
});

test("a refused refresh marks the connector as needing a sign-in, and the agent is not told to sign in itself", async () => {
  const { c, fake } = await start();
  const { connector } = await call<{ connector: Connector }>(c, "_cycle/connectors/add", {
    name: "linear",
    transport: { type: "http", url: upstream.url },
    auth: { type: "oauth" },
  });
  await signIn(c, connector.id);
  await c.agent.request(methods.agent.session.new, { cwd: dir } as never);
  const server = (
    (fake.log.news[0]?.mcpServers ?? []) as {
      url: string;
      headers: { name: string; value: string }[];
    }[]
  )[0];
  if (server === undefined) throw new Error("no server");
  upstream.state.valid = new Set();
  upstream.state.refresh = "rotated-elsewhere";
  const answer = await asAgent(server);
  expect(answer.status).toBe(401);
  expect(answer.headers.get("www-authenticate")).toBeNull();
  await eventually(async () => {
    const list = await call<{ connectors: Connector[] }>(c, "_cycle/connectors/list", {});
    return list.connectors[0]?.status.state === "needs_auth";
  }, "needs_auth");
});

test("an agent that does not reach http MCP is given no connectors, and a disabled one is given to none", async () => {
  const plain = fakeAgent();
  const { c } = await start(plain);
  await call(c, "_cycle/connectors/add", {
    name: "linear",
    transport: { type: "http", url: upstream.url },
    auth: { type: "none" },
  });
  await c.agent.request(methods.agent.session.new, { cwd: dir } as never);
  expect(plain.log.news[0]?.mcpServers).toBeUndefined();
});

test("the key stops working when the agent goes", async () => {
  const fake = fakeAgent({}, { mcpHttp: true });
  const { c } = await start(fake);
  await call(c, "_cycle/connectors/add", {
    name: "open",
    transport: { type: "http", url: upstream.url },
    auth: { type: "none" },
  });
  const created = (await c.agent.request(methods.agent.session.new, { cwd: dir } as never)) as {
    sessionId: string;
  };
  const server = (
    (fake.log.news[0]?.mcpServers ?? []) as {
      url: string;
      headers: { name: string; value: string }[];
    }[]
  )[0];
  if (server === undefined) throw new Error("no server");
  expect((await asAgent(server)).status).toBe(401); // the upstream wants a token; the gateway let it through
  await c.agent.request(methods.agent.session.close, { sessionId: created.sessionId } as never);
  await eventually(
    async () => (await asAgent(server)).status === 401 && upstream.seen.mcp.length === 1,
    "the key to stop working",
  );
  const before = upstream.seen.mcp.length;
  await asAgent(server);
  expect(upstream.seen.mcp.length).toBe(before);
});

test("a stdio connector runs in the daemon with its own values and the allowlist only, behind the gateway", async () => {
  const script = join(dir, "server.js");
  await writeFile(
    script,
    `let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let at;
  while ((at = buffer.indexOf("\\n")) >= 0) {
    const message = JSON.parse(buffer.slice(0, at));
    buffer = buffer.slice(at + 1);
    if (message.id !== undefined) {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { env: Object.keys(process.env).sort(), token: process.env.SERVICE_TOKEN, cwd: process.cwd() } }) + "\\n");
    }
  }
});
`,
  );
  const fake = fakeAgent({}, { mcpHttp: true });
  const daemon = await Daemon.start({
    dataDir: dir,
    agents: [fake.definition],
    connectors: await ConnectorService.load(dir, {
      env: { PATH: process.env.PATH, HOME: dir, ANTHROPIC_API_KEY: "must-not-pass" },
    }),
  });
  open.push(daemon);
  const c = await connectClient(daemon);
  await call(c, "_cycle/connectors/add", {
    name: "local",
    transport: { type: "stdio", command: process.execPath, args: [script] },
    auth: { type: "none" },
    secrets: { env: { SERVICE_TOKEN: "svc-secret" } },
  });
  await c.agent.request(methods.agent.session.new, { cwd: dir } as never);
  const server = (
    (fake.log.news[0]?.mcpServers ?? []) as {
      url: string;
      headers: { name: string; value: string }[];
    }[]
  )[0];
  if (server === undefined) throw new Error("no server");
  expect(JSON.stringify(fake.log.news[0])).not.toContain("svc-secret");
  const answer = (await (await asAgent(server)).json()) as {
    id: number;
    result: { env: string[]; token: string; cwd: string };
  };
  expect(answer.id).toBe(7);
  expect(answer.result.token).toBe("svc-secret");
  expect(answer.result.env).not.toContain("ANTHROPIC_API_KEY");
  expect(answer.result.env).toEqual(expect.arrayContaining(["HOME", "PATH", "SERVICE_TOKEN"]));
  expect(answer.result.cwd).toBe(await realpath(dir));
});

test("a store file that cannot be read stops the daemon from starting, and is not replaced", async () => {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(dir, "connectors"), { recursive: true });
  await writeFile(join(dir, "connectors", "catalog.json"), "{ not json");
  await expect(Daemon.start({ dataDir: dir, agents: [] })).rejects.toBeInstanceOf(
    ConnectorFileUnreadableError,
  );
  expect(await Bun.file(join(dir, "connectors", "catalog.json")).text()).toBe("{ not json");
});

test("a sign-out made while a refresh waits on the network is not undone by it", async () => {
  const { c, fake } = await start();
  const { connector } = await call<{ connector: Connector }>(c, "_cycle/connectors/add", {
    name: "linear",
    transport: { type: "http", url: upstream.url },
    auth: { type: "oauth" },
  });
  await signIn(c, connector.id);
  await c.agent.request(methods.agent.session.new, { cwd: dir } as never);
  const server = ((fake.log.news[0]?.mcpServers ?? []) as GivenServer[])[0];
  if (server === undefined) throw new Error("no server");
  let release = () => {};
  upstream.state.refreshGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  upstream.state.valid = new Set();
  const pending = asAgent(server);
  await eventually(
    async () => upstream.seen.tokens.some((t) => t.grant_type === "refresh_token"),
    "the refresh to reach the server",
  );
  await call(c, "_cycle/connectors/auth/clear", { id: connector.id });
  release();
  await pending;
  const list = await call<{ connectors: Connector[] }>(c, "_cycle/connectors/list", {});
  expect(list.connectors[0]).toMatchObject({ authorized: false, status: { state: "needs_auth" } });
  expect(await Bun.file(join(dir, "connectors", "credentials.json")).text()).not.toContain(
    "access-2",
  );
});

test("renaming keeps the sign-in; another address drops it; a registration is reused on another loopback port", async () => {
  const { c } = await start();
  const { connector } = await call<{ connector: Connector }>(c, "_cycle/connectors/add", {
    name: "linear",
    transport: { type: "http", url: upstream.url },
    auth: { type: "oauth", scopes: ["read"] },
  });
  await signIn(c, connector.id);
  // The desktop's callback is on a new port each time: the client registered before still serves.
  await call(c, "_cycle/connectors/auth/start", {
    id: connector.id,
    redirectUri: "http://127.0.0.1:50999/callback",
  });
  expect(upstream.seen.registrations).toHaveLength(1);
  const renamed = await call<{ connector: Connector }>(c, "_cycle/connectors/update", {
    id: connector.id,
    name: "linear2",
    auth: { type: "oauth" },
  });
  expect(renamed.connector).toMatchObject({ name: "linear2", authorized: true });
  const moved = await call<{ connector: Connector }>(c, "_cycle/connectors/update", {
    id: connector.id,
    transport: { type: "http", url: `${upstream.url}/v2` },
  });
  expect(moved.connector.authorized).toBe(false);
  expect(upstream.seen.revoked).toContain("refresh-1");
});

test("a header Cycle sets itself is refused as such", async () => {
  const { c } = await start();
  const refused = await errorOf(
    call(c, "_cycle/connectors/add", {
      name: "x",
      transport: { type: "http", url: upstream.url },
      auth: { type: "none" },
      secrets: { headers: { "Content-Type": "text/plain" } },
    }),
  );
  expect(refused.data?.reason).toBe("reserved_header");
});
