import { afterEach, expect, test } from "bun:test";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App, StoreProvider } from "../../src/react/index.ts";
import { AppStore } from "../../src/store/index.ts";
import { fakeBridge, summary } from "../fake-bridge.ts";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const mod = /Mac/.test(navigator.userAgent) ? "Meta" : "Control";

const mount = async () => {
  const script = fakeBridge({ connected: true });
  script.bridge.sessions = async () => [
    { ...summary("s1"), title: "first" },
    { ...summary("s2"), title: "second" },
  ];
  const store = new AppStore(script.bridge);
  render(
    <StoreProvider store={store}>
      <App />
    </StoreProvider>,
  );
  await act(() => store.start());
  const user = userEvent.setup();
  const tracked = () =>
    script.calls
      .filter(([name]) => name === "track")
      .map(([, event, props]) => [event, props])
      .filter(([event]) => String(event).startsWith("side_panel"));
  return { store, user, script, tracked };
};

const panel = () => document.querySelector('[data-slot="side-panel"]');

test("no session open, no panel and no button for one", async () => {
  await mount();
  expect(panel()).toBeNull();
  expect(screen.queryByRole("button", { name: "Show panel" })).toBeNull();
});

test("the button and ⌘\\ open and close the open session's panel, on its Overview", async () => {
  const { user, tracked } = await mount();
  await user.click(await screen.findByRole("option", { name: /first/ }));
  expect(panel()).toBeNull();
  await user.click(await screen.findByRole("button", { name: "Show panel" }));
  await waitFor(() => expect(panel()).not.toBeNull());
  expect(screen.getByRole("tab", { name: "Overview", selected: true })).toBeDefined();
  await user.keyboard(`{${mod}>}\\{/${mod}}`);
  await waitFor(() => expect(panel()).toBeNull());
  expect(await screen.findByRole("button", { name: "Show panel" })).toBeDefined();
  expect(tracked()).toEqual([
    ["side_panel_toggled", { open: true, via: "click", tab: "overview" }],
    ["side_panel_toggled", { open: false, via: "shortcut", tab: "overview" }],
  ]);
});

test("each session has its own panel, and a restart finds it as it was", async () => {
  const { user, store } = await mount();
  await user.click(await screen.findByRole("option", { name: /first/ }));
  await user.click(await screen.findByRole("button", { name: "Show panel" }));
  await waitFor(() => expect(panel()).not.toBeNull());
  await user.click(await screen.findByRole("option", { name: /second/ }));
  await waitFor(() => expect(panel()).toBeNull());
  await user.click(await screen.findByRole("option", { name: /first/ }));
  await waitFor(() => expect(panel()).not.toBeNull());
  cleanup();
  // What a restart reads: the page's storage, written as the panel changed.
  expect(new AppStore(fakeBridge().bridge).sidePanels.get("local:s1").open).toBe(true);
  expect(store.sidePanels.get("local:s2").open).toBe(false);
});

test("a deleted session's panel is forgotten", async () => {
  const { user, store } = await mount();
  await user.click(await screen.findByRole("option", { name: /first/ }));
  await user.click(await screen.findByRole("button", { name: "Show panel" }));
  await waitFor(() => expect(panel()).not.toBeNull());
  await act(() => store.deleteSession("s1"));
  expect(store.sidePanels.get("local:s1").open).toBe(false);
  expect(localStorage.getItem("cycle:side-panel")).toBeNull();
});
