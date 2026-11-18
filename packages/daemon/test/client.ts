import { type ClientContext, client, methods, type SessionUpdate } from "@cycle/acp";
import { META } from "@cycle/protocol";
import type { Daemon } from "../src/index.ts";

export const until = async (condition: () => boolean, what: string, ms = 2_000): Promise<void> => {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > ms) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
};

export type Seen = { update: SessionUpdate; seq: number | undefined };

/** A client of the daemon, in this process, that writes down everything it is sent. */
export const connectClient = async (
  daemon: Daemon,
  options: { onPermission?: (params: unknown) => "allow" | "deny" | "cancel" | "never" } = {},
) => {
  let agent: ClientContext | undefined;
  const seen: Seen[] = [];
  const permissions: unknown[] = [];
  const resolved: unknown[] = [];
  let listChanged = 0;
  let defaultsChanged = 0;
  const app = client({ name: "test-client" })
    .onConnect((connection) => {
      agent = connection.agent;
    })
    .onNotification(methods.client.session.update, ({ params }) => {
      const seq = (params._meta as Record<string, unknown> | null | undefined)?.[META.seq];
      seen.push({ update: params.update, seq: typeof seq === "number" ? seq : undefined });
    })
    .onNotification(
      "_cycle/request_resolved",
      (p: unknown) => p as object,
      ({ params }) => {
        resolved.push(params);
      },
    )
    .onNotification(
      "_cycle/agent_defaults_changed",
      (p: unknown) => p as object,
      () => {
        defaultsChanged++;
      },
    )
    .onNotification(
      "_cycle/session_list_changed",
      (p: unknown) => p as object,
      () => {
        listChanged++;
      },
    )
    .onRequest(methods.client.session.requestPermission, async ({ params }) => {
      permissions.push(params);
      const answer = options.onPermission?.(params) ?? "allow";
      if (answer === "never") return new Promise<never>(() => {});
      return answer === "cancel"
        ? { outcome: { outcome: "cancelled" } }
        : { outcome: { outcome: "selected", optionId: answer } };
    });
  const handle = daemon.acceptApp(app);
  if (agent === undefined) throw new Error("the client was not connected");
  const api = agent;
  const init = await api.request(methods.agent.initialize, {
    protocolVersion: 2,
    info: { name: "test", version: "0" },
  } as never);
  return {
    agent: api,
    init,
    seen,
    permissions,
    resolved,
    listChanged: () => listChanged,
    defaultsChanged: () => defaultsChanged,
    kinds: () => seen.map((s) => s.update.sessionUpdate),
    /** Turns that have ended: an idle that says why, as opposed to a state snapshot. */
    ended: () =>
      seen.filter((s) => {
        const u = s.update as { state?: string; stopReason?: string };
        return u.state === "idle" && u.stopReason !== undefined;
      }).length,
    idle: () => seen.filter((s) => (s.update as { state?: string }).state === "idle").length,
    close: () => handle.close(),
    closed: handle.closed,
  };
};
