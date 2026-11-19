/**
 * One request from an agent, sent on to a connector's real server with the connector's credentials
 * (docs/protocol.md §14). Streamable HTTP is plain HTTP with JSON or an event stream in the answer,
 * so this needs to know nothing of MCP: it passes the body both ways as it comes.
 *
 * Headers go by allowlist in both directions. What the agent sent as `Authorization` (the gateway's
 * key) never reaches the server; what the server says to sign in (`WWW-Authenticate`) never reaches
 * the agent, which would otherwise start a sign-in of its own.
 */

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

const TO_SERVER = [
  "accept",
  "content-type",
  "mcp-session-id",
  "mcp-protocol-version",
  "last-event-id",
] as const;

const TO_AGENT = [
  "content-type",
  "mcp-session-id",
  "mcp-protocol-version",
  "cache-control",
] as const;

/** A request the agent made, held so it can be sent again after a refresh. */
export type HeldRequest = {
  method: string;
  headers: Record<string, string>;
  body: ArrayBuffer | undefined;
  signal: AbortSignal;
};

export const hold = async (request: Request): Promise<HeldRequest> => {
  const headers: Record<string, string> = {};
  for (const name of TO_SERVER) {
    const value = request.headers.get(name);
    if (value !== null) headers[name] = value;
  }
  const body =
    request.method === "GET" || request.method === "HEAD" || request.method === "DELETE"
      ? undefined
      : await request.arrayBuffer();
  return { method: request.method, headers, body, signal: request.signal };
};

/** Sends the held request to `url` with the connector's own headers added. */
export const send = async (
  fetchImpl: Fetch,
  url: string,
  held: HeldRequest,
  credentials: Record<string, string>,
): Promise<Response> => {
  const upstream = await fetchImpl(url, {
    method: held.method,
    headers: { ...held.headers, ...credentials },
    ...(held.body !== undefined ? { body: held.body } : {}),
    // A redirect would take the token to wherever it points.
    redirect: "error",
    signal: held.signal,
  });
  const headers = new Headers();
  for (const name of TO_AGENT) {
    const value = upstream.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return new Response(upstream.body, { status: upstream.status, headers });
};
