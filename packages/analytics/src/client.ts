import { EVENTS, type EventName, type EventProps, isEventName } from "./events.ts";

/** Where events go. PostHog in the app, a list in a test. */
export type Sink = {
  capture(message: {
    distinctId: string;
    event: string;
    properties: Record<string, unknown>;
  }): void;
  /** Sends what is waiting. Resolves when done or when it gives up: it never keeps the app from quitting. */
  shutdown(): Promise<void>;
};

export type Analytics = {
  /** Reports an event. Never throws and never waits: analytics must not be able to break the app. */
  track<N extends EventName>(name: N, props: EventProps<N>): void;
  /** For what arrives from outside (the page): drops what is not in the dictionary. Says whether it was taken. */
  trackUnchecked(name: string, props: unknown): boolean;
  readonly enabled: boolean;
  setEnabled(enabled: boolean): void;
  shutdown(): Promise<void>;
};

export type AnalyticsOptions = {
  sink: Sink;
  /** A random id made on this computer. Not a person, not a machine name. */
  distinctId: string;
  enabled: boolean;
  /** On every event: what the app is, never who is using it. */
  context: { app_version: string; platform: string; arch: string };
  /** One launch of the app, so PostHog can group its events. */
  sessionId?: string;
  /** An event that was not sent because it does not fit the dictionary. For logs, never for the user. */
  onDrop?: (name: string, reason: string) => void;
};

export const createAnalytics = (options: AnalyticsOptions): Analytics => {
  let enabled = options.enabled;
  const send = (name: string, props: unknown): boolean => {
    if (!enabled) return false;
    if (!isEventName(name)) {
      options.onDrop?.(name, "not in the dictionary");
      return false;
    }
    const parsed = EVENTS[name].safeParse(props);
    if (!parsed.success) {
      options.onDrop?.(name, parsed.error.issues.map((i) => i.message).join("; "));
      return false;
    }
    try {
      options.sink.capture({
        distinctId: options.distinctId,
        event: name,
        properties: {
          ...parsed.data,
          ...options.context,
          ...(options.sessionId !== undefined ? { $session_id: options.sessionId } : {}),
          // No location from the address the request came from. (No person profile either: that one is the sink's.)
          $geoip_disable: true,
        },
      });
      return true;
    } catch (error) {
      options.onDrop?.(name, error instanceof Error ? error.message : String(error));
      return false;
    }
  };
  return {
    track: (name, props) => void send(name, props),
    trackUnchecked: send,
    get enabled() {
      return enabled;
    },
    setEnabled(value) {
      enabled = value;
    },
    shutdown: () => options.sink.shutdown().catch(() => undefined),
  };
};

/** Analytics that is off: no key (a development run, a test), or the person said no. */
export const noAnalytics: Analytics = {
  track: () => {},
  trackUnchecked: () => false,
  enabled: false,
  setEnabled: () => {},
  shutdown: async () => {},
};
