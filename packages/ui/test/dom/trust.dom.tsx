import { afterEach, expect, test } from "bun:test";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App, StoreProvider } from "../../src/react/index.ts";
import { AppStore } from "../../src/store/index.ts";
import { fakeBridge } from "../fake-bridge.ts";

afterEach(cleanup);

/** The app on a daemon that keeps folder trust, with `trusted` as the decision for every folder. */
const mount = async (trusted: boolean | null) => {
  const script = fakeBridge({
    connected: true,
    capabilities: { queue: true, files: true, folders: true, trust: true },
  });
  const decided = new Map<string, boolean>();
  script.bridge.readTrust = async (_environment, path) => {
    script.calls.push(["readTrust", _environment, path]);
    const value = decided.get(path) ?? trusted;
    return { path, trusted: value, from: value === null ? null : path };
  };
  script.bridge.setTrust = async (_environment, path, value) => {
    script.calls.push(["setTrust", _environment, path, value]);
    decided.set(path, value);
    return { path, trusted: value, from: path };
  };
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

const startIn = async (user: ReturnType<typeof userEvent.setup>, path: string) => {
  await user.click(await screen.findByRole("button", { name: "New session" }));
  const dialog = await screen.findByRole("dialog");
  const directory = within(dialog).getByRole("textbox", { name: "Directory" });
  await user.clear(directory);
  await user.type(directory, path);
  await user.click(within(dialog).getByRole("button", { name: "Start" }));
  return dialog;
};

test("a folder nobody has decided on is asked about before the session starts, and the answer is kept first", async () => {
  const { user, named, calls } = await mount(null);
  const dialog = await startIn(user, "/srv/app");
  expect(await within(dialog).findByText("Trust this folder?")).toBeTruthy();
  expect(within(dialog).getByText("/srv/app", { selector: "code" })).toBeTruthy();
  expect(named("createSession")).toHaveLength(0);
  await user.click(within(dialog).getByRole("button", { name: "Trust and start" }));
  await waitFor(() => expect(named("createSession")).toHaveLength(1));
  const order = calls.map((c) => c[0]).filter((n) => n === "setTrust" || n === "createSession");
  expect(order).toEqual(["setTrust", "createSession"]);
  expect(named("setTrust")[0]).toEqual(["setTrust", "local", "/srv/app", true]);
});

test("the question can be left, and a session can start without trusting the folder", async () => {
  const { user, named } = await mount(null);
  const dialog = await startIn(user, "/srv/app");
  await user.click(await within(dialog).findByRole("button", { name: "Back" }));
  // Back in the form, with what was typed, and nothing started or decided.
  expect(
    (within(dialog).getByRole("textbox", { name: "Directory" }) as HTMLInputElement).value,
  ).toBe("/srv/app");
  expect(named("setTrust")).toHaveLength(0);
  await user.click(within(dialog).getByRole("button", { name: "Start" }));
  await user.click(await within(dialog).findByRole("button", { name: "Start without trusting" }));
  await waitFor(() => expect(named("createSession")).toHaveLength(1));
  expect(named("setTrust")[0]).toEqual(["setTrust", "local", "/srv/app", false]);
});

test("a folder already decided on is not asked about", async () => {
  const { user, named } = await mount(false);
  await startIn(user, "/srv/app");
  await waitFor(() => expect(named("createSession")).toHaveLength(1));
  expect(named("setTrust")).toHaveLength(0);
  expect(screen.queryByText("Trust this folder?")).toBeNull();
});

test("the workspace menu trusts the shown folder after saying what that allows, and stops trusting it at once", async () => {
  const { user, named } = await mount(null);
  await user.click(screen.getByRole("button", { name: "Environment actions" }));
  await user.click(await screen.findByRole("menuitem", { name: "Trust this folder" }));
  const confirm = await screen.findByRole("alertdialog");
  expect(within(confirm).getByText("Trust this folder?")).toBeTruthy();
  await user.click(within(confirm).getByRole("button", { name: "Trust folder" }));
  await waitFor(() => expect(named("setTrust")).toHaveLength(1));
  expect(named("setTrust")[0]?.[3]).toBe(true);

  await user.click(screen.getByRole("button", { name: "Environment actions" }));
  await user.click(await screen.findByRole("menuitem", { name: "Stop trusting this folder" }));
  await waitFor(() => expect(named("setTrust")).toHaveLength(2));
  expect(named("setTrust")[1]?.[3]).toBe(false);
});

test("an answer that cannot be kept says why, starts nothing, and can be given again", async () => {
  const { user, named, bridge } = await mount(null);
  const working = bridge.setTrust;
  bridge.setTrust = async () => {
    throw new Error("disk full");
  };
  const dialog = await startIn(user, "/srv/app");
  await user.click(await within(dialog).findByRole("button", { name: "Trust and start" }));
  expect((await within(dialog).findByRole("alert")).textContent).toContain("disk full");
  expect(named("createSession")).toHaveLength(0);
  bridge.setTrust = working;
  await user.click(within(dialog).getByRole("button", { name: "Trust and start" }));
  await waitFor(() => expect(named("createSession")).toHaveLength(1));
});
