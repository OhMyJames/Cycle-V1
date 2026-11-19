import { join } from "node:path";
import { agent as acpAgent, methods, RequestError } from "@cycle/acp";
import {
  CONNECTORS_CHANGED,
  type Connector,
  CYCLE_PROTOCOL_VERSION,
  connectorsAdd,
  connectorsAuthClear,
  connectorsAuthFinish,
  connectorsAuthStart,
  connectorsList,
  connectorsRemove,
  connectorsUpdate,
  META,
} from "@cycle/protocol";
import { listenUnix } from "@cycle/transport/server";

/**
 * A daemon that only keeps connectors, as docs/protocol.md §14 says one answers: enough for the client and the desktop's
 * main process to be tested on their own. It keeps secrets as a real one would (by name only on the way out), and
 * records every value it was given, so a test can say what reached it.
 */
export const connectorsDaemon = async (dir: string, options: { capable?: boolean } = {}) => {
  const connectors: Connector[] = [];
  const secrets = new Map<string, Record<string, string>>();
  const flows = new Map<string, { id: string; state: string; redirectUri: string }>();
  const finished: unknown[] = [];
  const clients: { notify: (method: string, params: unknown) => Promise<void> }[] = [];
  let flowCount = 0;

  const changed = () => {
    for (const client of clients) void client.notify(CONNECTORS_CHANGED, {}).catch(() => {});
  };
  const find = (id: string): Connector => {
    const connector = connectors.find((c) => c.id === id);
    if (connector === undefined) throw new RequestError(-32002, "No such connector", { id });
    return connector;
  };
  const write = (
    id: string,
    written: { headers?: object | undefined; env?: object | undefined } | undefined,
  ) => {
    const kept = secrets.get(id) ?? {};
    for (const [name, value] of [
      ...Object.entries(written?.headers ?? {}),
      ...Object.entries(written?.env ?? {}),
    ]) {
      if (value === null) delete kept[name];
      else kept[name] = value as string;
    }
    secrets.set(id, kept);
  };
  const named = (connector: Connector): Connector => {
    const names = Object.keys(secrets.get(connector.id) ?? {});
    const http = connector.transport.type === "http";
    return {
      ...connector,
      secrets: { headers: http ? names : [], env: http ? [] : names },
    };
  };

  const app = acpAgent({ name: "fake-connectors" });
  app.onRequest(methods.agent.initialize, async () => ({
    protocolVersion: 2,
    info: { name: "cycle", version: "dev" },
    capabilities: { session: {} },
    _meta: {
      [META.protocolVersion]: CYCLE_PROTOCOL_VERSION,
      [META.capabilities]: options.capable === false ? {} : { connectors: true },
    },
  }));
  app.onRequest(methods.agent.session.list, async () => ({ sessions: [] }) as never);
  app.onRequest(connectorsList.name as `_${string}`, connectorsList.params, async () => ({
    connectors: connectors.map(named),
  }));
  app.onRequest(connectorsAdd.name as `_${string}`, connectorsAdd.params, async (request) => {
    const params = request.params as typeof connectorsAdd.params._output;
    if (connectors.some((c) => c.name === params.name))
      throw new RequestError(-32602, "That name is taken", { reason: "name_taken" });
    const connector: Connector = {
      id: `c${connectors.length + 1}`,
      name: params.name,
      enabled: params.enabled ?? true,
      transport: params.transport,
      auth: params.auth,
      secrets: { headers: [], env: [] },
      authorized: false,
      status: { state: params.auth.type === "oauth" ? "needs_auth" : "ready" },
    };
    connectors.push(connector);
    write(connector.id, params.secrets);
    changed();
    return { connector: named(connector) };
  });
  app.onRequest(connectorsUpdate.name as `_${string}`, connectorsUpdate.params, async (request) => {
    const {
      id,
      secrets: written,
      ...change
    } = request.params as typeof connectorsUpdate.params._output;
    const at = connectors.indexOf(find(id));
    const connector = { ...(connectors[at] as Connector), ...change } as Connector;
    connectors[at] = connector;
    write(id, written);
    changed();
    return { connector: named(connector) };
  });
  app.onRequest(connectorsRemove.name as `_${string}`, connectorsRemove.params, async (request) => {
    const { id } = request.params as { id: string };
    connectors.splice(connectors.indexOf(find(id)), 1);
    secrets.delete(id);
    changed();
    return {};
  });
  app.onRequest(
    connectorsAuthStart.name as `_${string}`,
    connectorsAuthStart.params,
    async (request) => {
      const { id, redirectUri } = request.params as { id: string; redirectUri: string };
      find(id);
      const flowId = `f${++flowCount}`;
      const state = `s${flowCount}`;
      flows.set(flowId, { id, state, redirectUri });
      const url = new URL("https://auth.example/authorize");
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("state", state);
      return { flowId, authorizationUrl: url.href };
    },
  );
  app.onRequest(
    connectorsAuthFinish.name as `_${string}`,
    connectorsAuthFinish.params,
    async (request) => {
      const params = request.params as typeof connectorsAuthFinish.params._output;
      finished.push(params);
      const flow = flows.get(params.flowId);
      if (flow === undefined) throw new RequestError(-32002, "No such sign-in", {});
      flows.delete(params.flowId);
      if (params.error !== undefined)
        throw new RequestError(-32017, "The server refused", { reason: "auth_rejected" });
      if (params.state !== flow.state)
        throw new RequestError(-32602, "State does not match", { reason: "state_mismatch" });
      const connector = find(flow.id);
      connector.authorized = true;
      connector.status = { state: "ready" };
      changed();
      return { connector: named(connector) };
    },
  );
  app.onRequest(
    connectorsAuthClear.name as `_${string}`,
    connectorsAuthClear.params,
    async (request) => {
      const connector = find((request.params as { id: string }).id);
      connector.authorized = false;
      connector.status = { state: "needs_auth" };
      changed();
      return { connector: named(connector) };
    },
  );

  const socket = join(dir, "connectors.sock");
  const server = await listenUnix({
    path: socket,
    onConnection: ({ stream }) => {
      const connection = app.connect(stream);
      clients.push({
        notify: (method, params) => connection.client.notify(method as never, params as never),
      });
    },
  });
  return {
    socket,
    connectors,
    /** Every secret value the daemon was given, by connector. */
    secrets,
    /** What each auth/finish carried. */
    finished,
    close: () => server.close(),
  };
};
