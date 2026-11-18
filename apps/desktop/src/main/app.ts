import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { commandChannel, sshChannel } from "@cycle/transport/client";
import { createTranslator, enUS, SOURCE_LOCALE } from "@cycle/ui";
import { API_METHODS, type AppEvent, channel, EVENT_CHANNEL, type HostConfig } from "@cycle/ui/api";
import { app, BrowserWindow, dialog, ipcMain, Notification, session, shell } from "electron";
import { notifyAttention } from "./attention.ts";
import { ConnectionManager } from "./manager.ts";
import { fileSettings } from "./settings.ts";
import { cleanStale, Updater, type UpdaterDeps } from "./updater.ts";

export type AppOptions = {
  /** Where the built page is: index.html, renderer.js, app.css. */
  rendererDir: string;
  preloadPath: string;
  /** How to run `cycle proxy` for the local host. */
  localCommand: string[];
  /** The whole environment of that command. Nothing is inherited from the app. */
  localEnv: Record<string, string>;
  /** Show the window. A test turns it off. */
  show?: boolean;
  /** How the app updates itself. Without it, updating is off. */
  update?: Omit<UpdaterDeps, "emit" | "quit">;
};

const isWeb = (url: string): boolean => {
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
};

/** How each kind of host is reached. The one place that knows. */
const channelFor = (options: AppOptions) => (host: HostConfig) => async () => {
  if (host.kind === "local")
    return commandChannel({ command: options.localCommand, env: options.localEnv });
  return sshChannel({ host: host.host, command: host.command ?? ["cycle", "proxy"] });
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

  const emit = (event: AppEvent) => {
    if (window !== undefined && !window.isDestroyed())
      window.webContents.send(EVENT_CHANNEL, event);
  };
  const manager = new ConnectionManager({
    ...(options.update !== undefined ? { appVersion: options.update.current.version } : {}),
    settings: fileSettings(join(app.getPath("userData"), "settings.json")),
    channelFor: channelFor(options),
    emit,
    attention: notifyAttention({
      window: () => window,
      supported: () => Notification.isSupported(),
      create: (notification) => new Notification(notification),
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
  const methods: Record<string, (...a: unknown[]) => unknown> = {
    updateState: () => updater.state,
    checkForUpdate: () => updater.check(true),
    installUpdate: () => updater.install(),
  };

  // Only our own page may ask main for anything.
  for (const method of API_METHODS) {
    ipcMain.handle(channel(method), (event, ...args: unknown[]) => {
      if (event.senderFrame?.url !== indexUrl) throw new Error("Refused: not from the app's page");
      const own = methods[method];
      if (own !== undefined) return own();
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
  if (options.update !== undefined && options.update.disabled === undefined) {
    await cleanStale(options.update.appPath);
    updater.start();
  }

  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", () => {
    updater.stop();
    void manager.close();
  });
  return { window, manager, contents, updater };
};
