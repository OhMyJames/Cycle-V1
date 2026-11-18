import type { CycleBridge } from "@cycle/ui";
import { App, StoreProvider } from "@cycle/ui/react";
import { AppStore } from "@cycle/ui/store";
import { createRoot } from "react-dom/client";

declare global {
  interface Window {
    cycle: CycleBridge;
  }
}

const store = new AppStore(window.cycle);
const root = document.getElementById("root");
if (root === null) throw new Error("no #root");
createRoot(root).render(
  <StoreProvider store={store}>
    <App />
  </StoreProvider>,
);
void store.start();
