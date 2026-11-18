// How a state is drawn: a colour, a shape and a word, so it is never told by colour alone (DESIGN.md section 3).
import type { ConnectionState, SessionSummary } from "../api.ts";
import { CloseIcon } from "./icons.tsx";

export type Tone = "accent" | "attention" | "success" | "danger" | "muted";
export type Shape = "solid" | "pulse" | "square" | "ring" | "cross";

export function StatusDot({ tone, shape }: { tone: Tone; shape: Shape }) {
  if (shape === "cross") return <CloseIcon size={12} data-slot="dot" data-tone={tone} />;
  return <span data-slot="dot" data-tone={tone} data-shape={shape} aria-hidden="true" />;
}

export const HOST_STATE: Record<ConnectionState, { word: string; tone: Tone; shape: Shape }> = {
  connected: { word: "Connected", tone: "success", shape: "solid" },
  connecting: { word: "Connecting…", tone: "accent", shape: "ring" },
  reconnecting: { word: "Reconnecting…", tone: "attention", shape: "ring" },
  closed: { word: "Not connected", tone: "danger", shape: "cross" },
};

/** What a session is doing that the person should see; idle and stopped say nothing. */
export const SESSION_STATE: Partial<
  Record<SessionSummary["state"], { word: string; tone: Tone; shape: Shape }>
> = {
  running: { word: "Working", tone: "accent", shape: "pulse" },
  requires_action: { word: "Needs you", tone: "attention", shape: "square" },
};
