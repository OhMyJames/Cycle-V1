import { afterEach, expect, test } from "bun:test";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SessionSummary } from "../../src/api.ts";
import { App, StoreProvider } from "../../src/react/index.ts";
import { PER_PROJECT } from "../../src/sessions.ts";
import { AppStore } from "../../src/store/index.ts";
import { fakeBridge, summary } from "../fake-bridge.ts";

afterEach(cleanup);

const row = (id: string, over: Partial<SessionSummary>): SessionSummary => ({
  ...summary(id),
  title: id,
  ...over,
});

const mount = async (sessions: SessionSummary[]) => {
  const script = fakeBridge({ connected: true });
  script.bridge.sessions = async () => sessions;
  const store = new AppStore(script.bridge);
  const user = userEvent.setup();
  render(
    <StoreProvider store={store}>
      <App />
    </StoreProvider>,
  );
  await act(() => store.start());
  await screen.findAllByRole("option");
  return { user, ...script };
};

const names = () => screen.getAllByRole("option").map((o) => o.textContent ?? "");
const mod = () => (/Mac/.test(navigator.userAgent) ? "Meta" : "Control");

const mixed = [
  row("old", { lastSeq: 1, cwd: "/work/app" }),
  row("run", { lastSeq: 5, cwd: "/work/other", state: "running" }),
  row("ask", { lastSeq: 2, cwd: "/work/app", state: "requires_action" }),
  row("new", { lastSeq: 9, cwd: "/work/app" }),
];

test("what needs you comes first, then what is working, then the projects", async () => {
  await mount(mixed);
  const groups = screen.getAllByRole("group").map((g) => g.textContent);
  expect(groups[0]).toContain("Needs you");
  expect(groups[1]).toContain("Working");
  expect(groups[2]).toContain("app");
  // Each group has its name, and the rows follow in that order.
  const rows = names();
  expect(rows[0]).toContain("ask");
  expect(rows[1]).toContain("run");
  expect(rows[2]).toContain("new");
  expect(rows[3]).toContain("old");
});

test("the arrow keys walk the whole list, across its groups", async () => {
  const { user } = await mount(mixed);
  await user.click(screen.getAllByRole("option")[0] as HTMLElement);
  await user.keyboard("{ArrowDown}");
  expect(document.activeElement?.textContent).toContain("run");
  await user.keyboard("{ArrowDown}{ArrowDown}");
  expect(document.activeElement?.textContent).toContain("old");
});

test("Cmd or Ctrl+] moves to the next session on screen, not the next by number", async () => {
  const { user, named } = await mount(mixed);
  await user.click(screen.getAllByRole("option")[0] as HTMLElement);
  await waitFor(() => expect(named("openSession").at(-1)?.[2]).toBe("ask"));
  await user.keyboard(`{${mod()}>}]{/${mod()}}`);
  // By number the next would be "old" (2 -> 1); on screen it is the working one.
  await waitFor(() => expect(named("openSession").at(-1)?.[2]).toBe("run"));
});

test("a project shows a page of its sessions, and the rest on request", async () => {
  const many = Array.from({ length: PER_PROJECT + 5 }, (_, n) => row(`s${n}`, { lastSeq: n }));
  const { user } = await mount(many);
  expect(names()).toHaveLength(PER_PROJECT);
  await user.click(screen.getByRole("button", { name: "Show 5 more sessions" }));
  await waitFor(() => expect(names()).toHaveLength(PER_PROJECT + 5));
  expect(screen.queryByRole("button", { name: /more session/ })).toBeNull();
});

test("a session found by the search that is past the page is shown, not selected out of sight", async () => {
  const many = Array.from({ length: PER_PROJECT + 5 }, (_, n) =>
    row(`s${n}`, { lastSeq: n, ...(n === 0 ? { title: "needle" } : {}) }),
  );
  const { user } = await mount(many);
  expect(within(screen.getByRole("listbox")).queryByText("needle")).toBeNull();
  await user.keyboard(`{${mod()}>}k{/${mod()}}`);
  await user.type(await screen.findByRole("combobox", { name: "Search sessions" }), "needle");
  await user.keyboard("{Enter}");
  const shown = await screen.findByRole("option", { name: /^needle/ });
  await waitFor(() => expect(shown.getAttribute("aria-selected")).toBe("true"));
});
