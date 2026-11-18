import { afterEach, expect, test } from "bun:test";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { HostConfig } from "../../src/api.ts";
import { App, StoreProvider } from "../../src/react/index.ts";
import { AppStore } from "../../src/store/index.ts";
import { fakeBridge } from "../fake-bridge.ts";

afterEach(cleanup);

const far: HostConfig = { id: "far", name: "Build box", kind: "ssh", host: "me@box" };

const mount = async (states: Record<string, "connected" | "closed" | "reconnecting"> = {}) => {
  const script = fakeBridge({ connected: true, hosts: [far], states });
  const store = new AppStore(script.bridge);
  const user = userEvent.setup();
  render(
    <StoreProvider store={store}>
      <App />
    </StoreProvider>,
  );
  await act(() => store.start());
  await screen.findAllByRole("option");
  // An event can start a read (the agents of a host that connected): wait for it inside act, or React warns.
  const emit = (event: Parameters<typeof script.emit>[0]) =>
    act(async () => {
      script.emit(event);
      await Bun.sleep(5);
    });
  return { store, user, ...script, emit };
};

test("the sessions of every host are in one list, and a project on another host is named after it", async () => {
  await mount();
  expect(screen.getAllByRole("option")).toHaveLength(2);
  expect(screen.getByRole("group", { name: "work" })).toBeTruthy();
  expect(screen.getByRole("group", { name: "work · Build box" })).toBeTruthy();
});

test("a host that is away: its sessions stay, greyed and saying why, and it can be tried again", async () => {
  const { user, named } = await mount({ far: "closed" });
  const rows = screen.getAllByRole("option");
  const greyed = rows.filter((row) => row.getAttribute("data-away") !== null);
  expect(greyed).toHaveLength(1);
  expect(greyed[0]?.getAttribute("data-host")).toBe("far");
  expect(greyed[0]?.getAttribute("title")).toBe("Build box · Not connected");
  // The sidebar says which host, and how it stands, with a way to try again.
  const status = screen.getByText(/Build box · Not connected/, {
    selector: '[data-slot="host-state"]',
  });
  await user.click(within(status).getByRole("button", { name: "Retry" }));
  expect(named("connect")).toEqual([["connect", "far"]]);
});

test("a session of a host that is away is not asked of, and opening one that was never opened says why", async () => {
  const { user, named } = await mount({ far: "closed" });
  await user.click(
    screen.getAllByRole("option").find((o) => o.getAttribute("data-host") === "far") as HTMLElement,
  );
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Build box is not connected, so this session cannot be opened.",
  );
  expect(named("openSession")).toEqual([]);
});

test("when the host comes back its rows are no longer greyed", async () => {
  const { emit } = await mount({ far: "closed" });
  expect(screen.getAllByRole("option").some((o) => o.getAttribute("data-away") !== null)).toBe(
    true,
  );
  await emit({ type: "host-status", hostId: "far", state: "connected" });
  await waitFor(() =>
    expect(screen.getAllByRole("option").every((o) => o.getAttribute("data-away") === null)).toBe(
      true,
    ),
  );
});

test("a new session asks which host when there are several, and Browse is only for this computer", async () => {
  const { user, named } = await mount();
  await user.click(await screen.findByRole("button", { name: "New session" }));
  const dialog = await screen.findByRole("dialog");
  // It starts where the person is: this computer, which has a folder chooser.
  expect(within(dialog).getByRole("button", { name: "Browse…" })).toBeTruthy();
  await user.click(within(dialog).getByRole("combobox"));
  await user.click(await screen.findByRole("option", { name: "Build box" }));
  expect(within(dialog).queryByRole("button", { name: "Browse…" })).toBeNull();
  await user.type(within(dialog).getByRole("textbox", { name: "Directory" }), "/srv/app");
  await user.click(within(dialog).getByRole("button", { name: "Start" }));
  await waitFor(() => expect(named("createSession")).toHaveLength(1));
  expect(named("createSession")[0]).toEqual([
    "createSession",
    "far",
    { cwd: "/srv/app", agent: "fake", config: {} },
  ]);
});

test("a host that is not connected cannot have a session started on it", async () => {
  const { user } = await mount({ far: "closed" });
  await user.click(await screen.findByRole("button", { name: "New session" }));
  const dialog = await screen.findByRole("dialog");
  // Only the host that is connected: nothing to choose.
  expect(within(dialog).queryByRole("combobox", { name: /host/i })).toBeNull();
  expect(within(dialog).queryByText("Build box")).toBeNull();
});
