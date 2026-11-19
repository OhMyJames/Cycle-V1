import { execFile } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isUiEvent } from "@cycle/analytics/events";
import { commandChannel, sshChannel, sshCommand } from "@cycle/transport/client";
import { createTranslator, enUS, SOURCE_LOCALE, type UpdateState } from "@cycle/ui";
import {
  API_METHODS,
  type AppEvent,
  channel,
  type EnvironmentConfig,
  EVENT_CHANNEL,
} from "@cycle/ui/api";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Notification,
  session,
  shell,
} from "electron";
import { shellQuote } from "../shared/release.ts";
import { type AnalyticsControl, offAnalytics } from "./analytics.ts";
import { notifyAttention } from "./attention.ts";
import { ConnectionManager } from "./manager.ts";
import { fileSettings } from "./settings.ts";
import { cleanStale, Updater, type UpdaterDeps } from "./updater.ts";

export type AppOptions = {
  /** Where the built page is: index.html, renderer.js, app.css. */
  rendererDir: string;
  preloadPath: string;
  /** How to run `cycle proxy` for the local environment. */
  localCommand: string[];
  /** The whole environment of that command. Nothing is inherited from the app. */
  localEnv: Record<string, string>;
  /** Show the window. A test turns it off. */
  show?: boolean;
  /** What the app reports about how it is used (docs/analytics.md). Without it, nothing is. */
  analytics?: AnalyticsControl;
  /** How the app updates itself. Without it, updating is off. */
  update?: Omit<UpdaterDeps, "emit" | "quit">;
};

/** What asking for an update came to, in the words of the dictionary; the states that are not an answer say nothing. */
const updateResult = (
  kind: UpdateState["kind"],
): "available" | "up_to_date" | "error" | "disabled" | undefined => {
  switch (kind) {
    case "available":
      return "available";
    case "up-to-date":
      return "up_to_date";
    case "error":
      return "error";
    case "disabled":
      return "disabled";
    case "idle":
    case "checking":
    case "downloading":
    case "installing":
      return undefined;
  }
};

const isWeb = (url: string): boolean => {
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
};

/** How each kind of environment is reached. The one place that knows. */
const channelFor = (options: AppOptions) => (environment: EnvironmentConfig) => async () => {
  if (environment.kind === "local")
    return commandChannel({ command: options.localCommand, env: options.localEnv });
  const { transport } = environment;
  return sshChannel({ host: transport.host, command: transport.command ?? ["cycle", "proxy"] });
};

/** What went wrong in what ssh said: its last line, which is the cause (earlier lines are warnings and progress). */
const lastLine = (stderr: string): string =>
  stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("Warning: Permanently added"))
    .at(-1)
    ?.slice(0, 300) ?? "";

/** Runs `command` on the machine of a remote environment, over ssh called as the connection calls it. */
const runOnHost = (environment: EnvironmentConfig, command: string): Promise<void> => {
  if (environment.kind === "local")
    return Promise.reject(new Error("This is not a remote environment."));
  const [program, ...args] = sshCommand({
    host: environment.transport.host,
    args: ["-o", "ConnectTimeout=15"],
    command: ["sh", "-c", shellQuote(command)],
  });
  return new Promise((done, fail) => {
    execFile(
      program ?? "ssh",
      args,
      { timeout: 180_000, encoding: "utf8", maxBuffer: 1 << 20 },
      (error, _stdout, stderr) => {
        if (error === null) return done();
        // Said in words, never as the command line ssh was given.
        if (error.killed === true) return fail(new Error("It took too long."));
        fail(new Error(lastLine(stderr) || "ssh did not succeed."));
      },
    );
  });
};

/**
 * Starts the app: the connections, the window, and the bridge between them. The page is not trusted
 * with anything it could use against the user: agent output reaches it, and agent output is the
 * agent's word. So it gets no node, no navigation, no new windows, no permissions, and no network.
 */
export const startApp = async (options: AppOptions) => {
  await app.whenReady();
  const indexUrl = pathToFileURL(join(options.rendererDir, "index.html")).href;
  let window: BrowserWindow | undefined;

  const usage = options.analytics ?? offAnalytics;
  const { analytics } = usage;

  const emit = (event: AppEvent) => {
    if (window !== undefined && !window.isDestroyed())
      window.webContents.send(EVENT_CHANNEL, event);
  };
  const manager = new ConnectionManager({
    ...(options.update !== undefined ? { appVersion: options.update.current.version } : {}),
    settings: fileSettings(join(app.getPath("userData"), "settings.json")),
    channelFor: channelFor(options),
    runOnHost,
    emit,
    track: (name, props) => analytics.track(name, props),
    // A connector's sign-in page: the manager only hands over a web address (connector-auth.ts checks it).
    openBrowser: (url) => shell.openExternal(url),
    attention: notifyAttention({
      window: () => window,
      supported: () => Notification.isSupported(),
      create: (notification) => new Notification(notification),
      activate: () => app.focus({ steal: true }),
      translator: createTranslator(SOURCE_LOCALE, enUS),
      emit,
    }),
    chooseDirectory: async () => {
      const result = await dialog.showOpenDialog({
        properties: ["openDirectory", "createDirectory"],
      });
      return result.canceled ? undefined : result.filePaths[0];
    },
  });
  await manager.init();
  analytics.track("app_launched", {
    remote_environments: (await manager.environments()).environments.filter(
      (e) => e.kind === "remote",
    ).length,
    first_run: usage.first,
  });

  const updater = new Updater({
    ...(options.update ?? {
      current: { version: "0.0.0", platform: process.platform, arch: process.arch },
      appPath: "",
      repo: "",
      fetch,
      extract: async () => {},
      beforeSwap: async () => {},
      handOff: () => {},
      disabled: "Updates are for the installed app.",
    }),
    emit: (state) => emit({ type: "app-update", state }),
    quit: () => app.quit(),
  });
  /** The most the page may put on the clipboard at once: a long output, not a file. */
  const MAX_COPY = 5_000_000;
  const methods: Record<string, (...a: unknown[]) => unknown> = {
    updateState: () => updater.state,
    checkForUpdate: async () => {
      const state = await updater.check(true);
      const result = updateResult(state.kind);
      if (result !== undefined) analytics.track("update_checked", { result });
      return state;
    },
    installUpdate: () => {
      analytics.track("update_install_started", {});
      return updater.install();
    },
    // From the page, so only what the page may say, and checked: anything else is dropped.
    track: (event: unknown, props: unknown) => {
      if (typeof event === "string" && isUiEvent(event))
        analytics.trackUnchecked(event, props ?? {});
    },
    analytics: () => usage.status(),
    setAnalytics: (enabled: unknown) => usage.set(enabled === true),
    // Through main, not the page's navigator.clipboard: the page is given no permissions. Text only, of a sane size.
    copyText: (text: unknown) => {
      if (typeof text !== "string" || text.length > MAX_COPY) return false;
      clipboard.writeText(text);
      return true;
    },
  };

  // Only our own page may ask main for anything.
  for (const method of API_METHODS) {
    ipcMain.handle(channel(method), (event, ...args: unknown[]) => {
      if (event.senderFrame?.url !== indexUrl) throw new Error("Refused: not from the app's page");
      const own = methods[method];
      // With what the page sent: `track` and `setAnalytics` take it (they were called without, and so did nothing).
      if (own !== undefined) return own(...args);
      return (manager as unknown as Record<string, (...a: unknown[]) => unknown>)[method]?.(
        ...args,
      );
    });
  }

  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) =>
    callback(false),
  );
  session.defaultSession.setPermissionCheckHandler(() => false);

  window = new BrowserWindow({
    width: 1200,
    height: 800,
    // Below this the sidebar and the conversation cannot both be used (DESIGN.md section 9).
    minWidth: 720,
    minHeight: 480,
    // On a Mac the title bar is hidden; the traffic lights sit in the sidebar's corner.
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 16, y: 14 } }
      : {}),
    show: options.show ?? true,
    webPreferences: {
      preload: options.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });
  const contents = window.webContents;
  // A link in the conversation opens in the user's browser, if it is a web link, and never here.
  contents.setWindowOpenHandler(({ url }) => {
    if (isWeb(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  contents.on("will-navigate", (event, url) => {
    if (url === indexUrl) return;
    event.preventDefault();
    if (isWeb(url)) void shell.openExternal(url);
  });
  contents.on("will-attach-webview", (event) => event.preventDefault());
  await window.loadURL(indexUrl);
  // Every environment is connected from here, not when the person picks one: what is wrong with one is in its status.
  void manager.connectAll();
  if (options.update !== undefined && options.update.disabled === undefined) {
    await cleanStale(options.update.appPath);
    updater.start();
  }

  app.on("window-all-closed", () => app.quit());
  // What is waiting to be reported goes out before the app ends, for as long as the sink allows (two seconds).
  let flushed = false;
  app.on("before-quit", (event) => {
    updater.stop();
    void manager.close();
    // Also when it was just turned off: its last word may still be waiting.
    if (flushed || !usage.status().available) return;
    flushed = true;
    event.preventDefault();
    void analytics.shutdown().finally(() => app.quit());
  });
  return { window, manager, contents, updater };
};
