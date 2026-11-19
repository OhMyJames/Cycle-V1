// How the app uses @cycle/analytics: whether it is on, which anonymous id it reports under, and where the key comes from.
// The package knows nothing of files, Electron or the environment; this is where they meet it.

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { type Analytics, createAnalytics, noAnalytics, type Sink } from "@cycle/analytics";

/** What is kept between launches. The id is random: it names an installation, not a person or a machine. */
export type AnalyticsRecord = {
  id: string;
  enabled: boolean;
  /** The person has been told (the notice was shown and answered). */
  noticed: boolean;
};

export type AnalyticsStore = {
  load(): Promise<{ record: AnalyticsRecord; first: boolean }>;
  save(record: AnalyticsRecord): Promise<void>;
};

export const fileAnalyticsStore = (path: string): AnalyticsStore => {
  // One save at a time: two at once would write the same temporary file.
  let saving: Promise<void> = Promise.resolve();
  const write = async (record: AnalyticsRecord): Promise<void> => {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`);
    await rename(temporary, path);
  };
  return {
    async load() {
      try {
        const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<AnalyticsRecord>;
        if (typeof parsed.id === "string" && parsed.id !== "") {
          return {
            first: false,
            record: {
              id: parsed.id,
              enabled: parsed.enabled !== false,
              noticed: parsed.noticed === true,
            },
          };
        }
      } catch {
        // No file, or one that is not ours: a new id is made. What was in it was only an id and two flags.
      }
      return { first: true, record: { id: randomUUID(), enabled: true, noticed: false } };
    },
    save(record) {
      const done = saving.then(
        () => write(record),
        () => write(record),
      );
      saving = done;
      return done;
    },
  };
};

/**
 * What a person says, outside the app, that nothing is to be sent: the community's DO_NOT_TRACK, or our own variable.
 * Any value but empty, "0" and "false" counts as saying so for DO_NOT_TRACK; our own says "off" or "0".
 */
export const optedOutByEnvironment = (env: Record<string, string | undefined>): boolean => {
  const dnt = env.DO_NOT_TRACK?.trim().toLowerCase();
  if (dnt !== undefined && dnt !== "" && dnt !== "0" && dnt !== "false") return true;
  const own = env.CYCLE_ANALYTICS?.trim().toLowerCase();
  return own === "off" || own === "0" || own === "false";
};

/** The PostHog project: the key is public (it can only add events), made into the build by `package`. Without one, nothing is sent. */
export type PosthogProject = { key: string; host?: string | undefined };

export const projectOf = (
  build: { posthogKey?: unknown; posthogHost?: unknown } | undefined,
  env: Record<string, string | undefined>,
): PosthogProject | undefined => {
  // An empty variable is not set: a blank exported in a shell must not switch an installed app off.
  const key =
    env.CYCLE_POSTHOG_KEY || (typeof build?.posthogKey === "string" ? build.posthogKey : "");
  if (key === "") return undefined;
  const host =
    env.CYCLE_POSTHOG_HOST || (typeof build?.posthogHost === "string" ? build.posthogHost : "");
  return { key, ...(host !== "" ? { host } : {}) };
};

export type AnalyticsStatus = {
  /** There is a project to report to and the person did not opt out outside the app. Without it the switch is not shown. */
  available: boolean;
  enabled: boolean;
  noticed: boolean;
};

/** The analytics of one run of the app, and the person's say over it. */
export type AnalyticsControl = {
  analytics: Analytics;
  /** True when the app has never run here before. */
  first: boolean;
  status(): AnalyticsStatus;
  /** The person's answer. Also means they have been told. */
  set(enabled: boolean): Promise<AnalyticsStatus>;
};

export const startAnalytics = async (options: {
  store: AnalyticsStore;
  /** Without one (no project, or opted out outside the app) nothing is created and nothing is sent. */
  sink: (() => Sink) | undefined;
  context: { app_version: string; platform: string; arch: string };
  onDrop?: (name: string, reason: string) => void;
}): Promise<AnalyticsControl> => {
  const { record: loaded, first } = await options.store.load();
  let record = loaded;
  // Written at the first run, so the id stays the same from then on.
  if (first) await options.store.save(record).catch(() => undefined);
  const make = options.sink;
  const analytics =
    make === undefined
      ? noAnalytics
      : createAnalytics({
          sink: make(),
          distinctId: record.id,
          enabled: record.enabled,
          // Not told yet: nothing is sent until the person has answered.
          held: !record.noticed,
          context: options.context,
          sessionId: randomUUID(),
          ...(options.onDrop !== undefined ? { onDrop: options.onDrop } : {}),
        });
  const available = make !== undefined;
  const status = (): AnalyticsStatus => ({
    available,
    enabled: available && record.enabled,
    noticed: record.noticed,
  });
  return {
    analytics,
    first,
    status,
    async set(enabled) {
      // Kept first: if it cannot be, nothing changes and the person is told, instead of a switch that says one thing and a file another.
      const next = { ...record, enabled, noticed: true };
      await options.store.save(next);
      const wasHeld = !record.noticed;
      record = next;
      if (available) {
        if (enabled) {
          analytics.setEnabled(true);
          // What the first run did while the notice was up goes now, and "on" is the first word after it.
          analytics.release(true);
          analytics.track("analytics_toggled", { enabled: true });
        } else {
          // Said no to the notice: nothing at all was sent, and nothing will be. Said no later: one last word, then silence.
          if (wasHeld) analytics.release(false);
          else analytics.track("analytics_toggled", { enabled: false });
          analytics.setEnabled(false);
        }
      }
      return status();
    },
  };
};

/** No analytics: a test, or a run with nowhere to report to. */
export const offAnalytics: AnalyticsControl = {
  analytics: noAnalytics,
  first: false,
  status: () => ({ available: false, enabled: false, noticed: true }),
  set: async () => ({ available: false, enabled: false, noticed: true }),
};
