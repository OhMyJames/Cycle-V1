// The app without Electron: its built page in headless Chromium (through Playwright), and behind the page the real
// ConnectionManager, which starts the real daemon through `proxy` the way the desktop app does. The page's bridge
// (window.cycle) is the preload's, made in the page by an init script, and each call is handed to the manager here, as
// main.ts hands an IPC call to it. Nothing opens a window, so nothing takes the person's focus.
//
// What only Electron can show (the preload, the page's lockdown, the packaged app finding its own daemon) is the packaged
// test's (test/integration/packaged.integration.ts).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { commandChannel } from "@cycle/client";
import type { AnalyticsStatus, UpdateState } from "@cycle/ui";
import { API_METHODS, type AppEvent } from "@cycle/ui/api";
import { type Browser, chromium, type Page } from "playwright";
import { serveDir } from "../../../../scripts/serve-dir.ts";
import { dispatch, type Handlers } from "../../src/main/dispatch.ts";
import { ConnectionManager } from "../../src/main/manager.ts";
import { fileSettings } from "../../src/main/settings.ts";

const appDir = new URL("../..", import.meta.url).pathname;
export const rendererDir = join(appDir, "dist", "renderer");
/** The page has been built (`bun run build` in apps/desktop). */
export const built = existsSync(join(rendererDir, "index.html"));

/** Reads until it says what is wanted, for at most `ms`; then fails with the last thing it read. */
export const until = async <T>(read: () => Promise<T>, ok: (value: T) => boolean, ms = 10_000) => {
  const started = Date.now();
  for (;;) {
    const value = await read();
    if (ok(value)) return;
    if (Date.now() - started > ms)
      throw new Error(`waited ${ms} ms; last read: ${String(value).slice(0, 300)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

export type WebAppOptions = {
  /** A directory of the test's own: settings, and the browser's profile. */
  root: string;
  /** What the daemon is run as: `["bun", "<main.ts>"]` from source, or the built executable. */
  daemon: string[];
  /** The daemon's data directory and socket. */
  data: string;
  socket: string;
  /** The whole environment of `proxy`, and so of the daemon: nothing of this machine's is passed on. */
  env: Record<string, string>;
  /** What the folder picker answers. */
  folder?: string;
};

export type WebApp = {
  page: Page;
  manager: ConnectionManager;
  /** What the page put on the clipboard through the app (`copyText`). */
  copied: string[];
  close: () => Promise<void>;
};

/** What main.ts answers itself, for a run that is not an installed app. */
const DISABLED: UpdateState = {
  current: "0.0.0",
  kind: "disabled",
  reason: "Updates are for the installed app.",
};
const NO_ANALYTICS: AnalyticsStatus = { available: false, enabled: false, noticed: true };

/** In the page, before its own script: the bridge the preload gives it, with the same methods and nothing else. */
const bridgeScript = (methods: readonly string[]) => `(() => {
  const listeners = new Set();
  const bridge = {};
  for (const method of ${JSON.stringify(methods)}) bridge[method] = (...args) => window.__cycleCall(method, args);
  bridge.onEvent = (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
  Object.defineProperty(window, "__cycleEmit", { value: (event) => { for (const l of listeners) l(event); } });
  Object.defineProperty(window, "cycle", { value: Object.freeze(bridge) });
})();`;

export const startWebApp = async (options: WebAppOptions): Promise<WebApp> => {
  // The built page, from this machine's loopback only.
  const server = serveDir(rendererDir);

  let page: Page | undefined;
  const emit = (event: AppEvent) => {
    // As main.ts sends to a window that is gone: nothing, and no error.
    void page
      ?.evaluate(
        (e) => (window as unknown as { __cycleEmit?: (e: unknown) => void }).__cycleEmit?.(e),
        event,
      )
      .catch(() => {});
  };
  const manager = new ConnectionManager({
    settings: fileSettings(join(options.root, "settings.json")),
    channelFor: (environment) => async () => {
      if (environment.kind !== "local") throw new Error("only this computer, in a web test");
      return commandChannel({
        command: [
          ...options.daemon,
          "proxy",
          "--data-dir",
          options.data,
          "--socket",
          options.socket,
        ],
        env: options.env,
      });
    },
    emit,
    chooseDirectory: async () => options.folder,
  });
  await manager.init();

  const copied: string[] = [];
  const own: Handlers = {
    updateState: () => DISABLED,
    checkForUpdate: () => DISABLED,
    installUpdate: () => undefined,
    track: () => undefined,
    analytics: () => NO_ANALYTICS,
    setAnalytics: () => NO_ANALYTICS,
    copyText: (text) => {
      if (typeof text !== "string") return false;
      copied.push(text);
      return true;
    },
  };

  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
    page = await context.newPage();
    // As main.ts routes an IPC call, through the same dispatch.
    const call = dispatch(manager, own);
    await page.exposeBinding("__cycleCall", (_source, method: string, args: unknown[]) =>
      call(method, args),
    );
    await page.addInitScript({ content: bridgeScript(API_METHODS) });
    await page.goto(`http://127.0.0.1:${server.port}/`);
    // Every environment is connected from here, as main.ts does once the page is loaded.
    void manager.connectAll();
  } catch (error) {
    await browser?.close();
    server.stop(true);
    await manager.close();
    throw error;
  }

  const opened = browser;
  return {
    page,
    manager,
    copied,
    close: async () => {
      await opened.close();
      server.stop(true);
      await manager.close();
    },
  };
};
