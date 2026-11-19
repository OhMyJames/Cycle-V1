// The one file that imports posthog-node. Node only: the main process.
import { PostHog } from "posthog-node";
import type { Sink } from "./client.ts";

/** How long quitting may wait for the last events to go out. */
const SHUTDOWN_MS = 2000;

export const posthogSink = (options: { apiKey: string; host: string }): Sink => {
  const client = new PostHog(options.apiKey, {
    host: options.host,
    flushAt: 20,
    flushInterval: 10_000,
    disableGeoip: true,
    // Only what `track` says. No errors collected by themselves: a stack has paths and messages in it.
    enableExceptionAutocapture: false,
  });
  // A network that is down is not the app's problem: it is not an error to show or to throw.
  client.on("error", () => {});
  return {
    // An installation is not a person: no profile is made for the id, only events.
    capture: (message) =>
      client.capture({ ...message, options: { process_person_profile: false } }),
    shutdown: () => client.shutdown(SHUTDOWN_MS),
  };
};
