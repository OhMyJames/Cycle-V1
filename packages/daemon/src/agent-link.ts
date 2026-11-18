import {
  AgentApp,
  type ClientContext,
  client,
  methods,
  type SessionUpdate,
  type Stream,
} from "@cycle/acp";
import type { AgentDefinition } from "./agents.ts";

export type LinkHandlers = {
  /** An update the agent sent, with the agent's own session id taken off. */
  update: (update: SessionUpdate) => void;
  /** The agent asks the user something. Answers when someone has decided. */
  permission: (params: Record<string, unknown>) => Promise<unknown>;
  /** The connection to the agent ended, however it ended. */
  closed: () => void;
};

/** A live connection to one agent process, as ACP v2 sees it: the daemon is the client. */
export class AgentLink {
  readonly agent: ClientContext;
  readonly #close: () => void;
  readonly #kill: (() => void) | undefined;

  private constructor(agent: ClientContext, close: () => void, kill: (() => void) | undefined) {
    this.agent = agent;
    this.#close = close;
    this.#kill = kill;
  }

  static async connect(definition: AgentDefinition, handlers: LinkHandlers): Promise<AgentLink> {
    const launched = await definition.launch();
    const app = client({ name: "cycle-daemon" })
      .onNotification(methods.client.session.update, ({ params }) => {
        handlers.update(params.update);
      })
      .onRequest(methods.client.session.requestPermission, async ({ params }) => {
        return (await handlers.permission(params as unknown as Record<string, unknown>)) as never;
      });
    const connection =
      launched.target instanceof AgentApp
        ? app.connect(launched.target)
        : app.connect(launched.target as Stream);
    void connection.closed.then(handlers.closed, handlers.closed);
    try {
      await connection.agent.request(methods.agent.initialize, {
        protocolVersion: 2,
        info: { name: "cycle-daemon", version: "0.0.0" },
        capabilities: {},
      } as never);
    } catch (error) {
      connection.close();
      launched.kill?.();
      throw error;
    }
    return new AgentLink(connection.agent, () => connection.close(), launched.kill);
  }

  kill(): void {
    this.#close();
    this.#kill?.();
  }
}
