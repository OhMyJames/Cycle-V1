import type { CycleBridge } from "@cycle/ui";
import { App, StoreProvider } from "@cycle/ui/react";
import { AppStore } from "@cycle/ui/store";
import { createRoot } from "react-dom/client";

declare global {
  interface Window {
    cycle: CycleBridge;
  }
}

// The page cannot ask Node for the platform; the user agent says it (the style of the title bar depends on it).
document.documentElement.dataset.platform = /Mac/.test(navigator.userAgent) ? "darwin" : "other";

const store = new AppStore(window.cycle);
const root = document.getElementById("root");
if (root === null) throw new Error("no #root");
createRoot(root).render(
  <StoreProvider store={store}>
    <App />
  </StoreProvider>,
);
void store.start();
