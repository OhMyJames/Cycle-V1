import type { AgentApp, Stream } from "@cycle/acp";

/** Where an agent is reached: a stream to a process, or an app in this process (tests). */
export type AgentTarget = { target: Stream | AgentApp; kill?: () => void };

/**
 * An agent the daemon can run. How it is started is the definition's business: the daemon only
 * speaks ACP v2 to what `launch` returns, whether that is a child process, a remote one or a
 * sandbox (decision 0001).
 */
export type AgentDefinition = {
  id: string;
  name: string;
  /** JSON Schema of what can be configured, for a client to draw a form from. */
  configSchema: Record<string, unknown>;
  available?: () => boolean | Promise<boolean>;
  launch: () => Promise<AgentTarget>;
};
