import type { Stream } from "@cycle/acp";

/** One end of a connection: ACP messages in and out, and a way to hang up. */
export type Channel = { stream: Stream; close: () => void };
