// Runs in the page's isolated world, before the page. It is sandboxed, so it may only use what
// electron gives it. It hands the page one object with the methods of AppApi and a way to hear events,
// and nothing else: no ipcRenderer, no node.

import { API_METHODS, type AppEvent, channel, EVENT_CHANNEL } from "@cycle/ui/api";
import { contextBridge, ipcRenderer } from "electron";

const bridge: Record<string, unknown> = {};
for (const method of API_METHODS) {
  bridge[method] = (...args: unknown[]) => ipcRenderer.invoke(channel(method), ...args);
}
bridge.onEvent = (listener: (event: AppEvent) => void) => {
  const handler = (_event: unknown, payload: AppEvent) => listener(payload);
  ipcRenderer.on(EVENT_CHANNEL, handler);
  return () => {
    ipcRenderer.removeListener(EVENT_CHANNEL, handler);
  };
};

contextBridge.exposeInMainWorld("cycle", bridge);
