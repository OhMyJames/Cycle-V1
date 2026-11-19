import { afterEach, expect, test } from "bun:test";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ConnectorInfo } from "../../src/api.ts";
import { App, StoreProvider } from "../../src/react/index.ts";
import { AppStore } from "../../src/store/index.ts";
import { fakeBridge } from "../fake-bridge.ts";

afterEach(cleanup);

const notion: ConnectorInfo = {
  id: "c1",
  name: "notion",
  enabled: true,
  transport: { type: "http", url: "https://mcp.notion.example/mcp" },
  auth: { type: "oauth" },
  secrets: { headers: [], env: [] },
  authorized: false,
  status: { state: "needs_auth" },
};

const mount = async (options: { connectors?: ConnectorInfo[]; capable?: boolean } = {}) => {
  const script = fakeBridge({
    connected: true,
    capabilities: {
      queue: true,
      files: true,
      folders: true,
      connectors: options.capable !== false,
    },
    connectors: options.connectors ?? [],
  });
  const store = new AppStore(script.bridge);
  const user = userEvent.setup();
  render(
    <StoreProvider store={store}>
      <App />
    </StoreProvider>,
  );
  await act(() => store.start());
  await user.click(await screen.findByRole("button", { name: "Connectors" }));
  const dialog = await screen.findByRole("dialog", { name: "Connectors" });
  return { user, dialog, store, ...script };
};

test("opening it is counted, and an environment without connectors says so", async () => {
  const { dialog, named } = await mount();
  expect(named("track")).toContainEqual([
    "track",
    "panel_opened",
    { panel: "connectors", via: "click" },
  ]);
  expect(await within(dialog).findByText(/No connectors yet/)).toBeTruthy();
});

test("a daemon that cannot keep connectors is said, not asked", async () => {
  const { dialog, named } = await mount({ capable: false });
  expect(within(dialog).getByText(/No connected environment can keep connectors/)).toBeTruthy();
  expect(named("listConnectors")).toHaveLength(0);
});

test("adds an HTTP connector with a header; the value is sent, and only its name is shown after", async () => {
  const { user, dialog, named } = await mount();
  await user.click(within(dialog).getByRole("button", { name: "Add connector" }));
  const form = await screen.findByRole("dialog", { name: "Add a connector" });
  await user.type(within(form).getByRole("textbox", { name: "Name" }), "linear");
  await user.type(within(form).getByRole("textbox", { name: "URL" }), "https://mcp.linear.app/mcp");
  await user.click(within(form).getByRole("button", { name: "Add value" }));
  await user.type(within(form).getByRole("textbox", { name: "Secret name" }), "Authorization");
  await user.type(within(form).getByLabelText("Secret value"), "Bearer sk-1");
  await user.click(within(form).getByRole("button", { name: "Add connector" }));
  await waitFor(() => expect(named("addConnector")).toHaveLength(1));
  expect(named("addConnector")[0]).toEqual([
    "addConnector",
    "local",
    {
      name: "linear",
      transport: { type: "http", url: "https://mcp.linear.app/mcp" },
      auth: { type: "none" },
      secrets: { headers: { Authorization: "Bearer sk-1" } },
    },
  ]);
  const list = await screen.findByRole("dialog", { name: "Connectors" });
  expect(await within(list).findByText("linear")).toBeTruthy();
  expect(within(list).getByText("mcp.linear.app")).toBeTruthy();
  expect(list.textContent).not.toContain("sk-1");
});

test("a connector that needs signing in offers it, and says when it is done", async () => {
  const { user, dialog, named } = await mount({ connectors: [{ ...notion }] });
  expect(await within(dialog).findByText("Needs sign-in")).toBeTruthy();
  await user.click(within(dialog).getByRole("button", { name: "Sign in" }));
  await waitFor(() => expect(named("authorizeConnector")).toHaveLength(1));
  expect(await within(dialog).findByText("Signed in to notion.")).toBeTruthy();
  expect(within(dialog).getByText("Ready")).toBeTruthy();
  expect(within(dialog).queryByRole("button", { name: "Sign in" })).toBeNull();
});

test("turning one off goes to the daemon at once", async () => {
  const { user, dialog, named } = await mount({ connectors: [{ ...notion }] });
  await user.click(await within(dialog).findByRole("switch", { name: "Use notion in sessions" }));
  await waitFor(() =>
    expect(named("updateConnector")).toEqual([
      ["updateConnector", "local", "c1", { enabled: false }],
    ]),
  );
});

test("removing asks first, and only then removes", async () => {
  const { user, dialog, named } = await mount({ connectors: [{ ...notion }] });
  await user.click(await within(dialog).findByRole("button", { name: "Actions for notion" }));
  await user.click(await screen.findByRole("menuitem", { name: "Remove" }));
  const confirm = await screen.findByRole("alertdialog", { name: "Remove notion?" });
  expect(named("removeConnector")).toHaveLength(0);
  await user.click(within(confirm).getByRole("button", { name: "Remove connector" }));
  await waitFor(() => expect(named("removeConnector")).toHaveLength(1));
  expect(await within(dialog).findByText(/No connectors yet/)).toBeTruthy();
});

test("what the daemon refuses is said next to the form, in words", async () => {
  const { user, dialog, bridge } = await mount();
  bridge.addConnector = async () => ({ problem: "insecure_url" });
  await user.click(within(dialog).getByRole("button", { name: "Add connector" }));
  const form = await screen.findByRole("dialog", { name: "Add a connector" });
  await user.type(within(form).getByRole("textbox", { name: "Name" }), "plain");
  await user.type(within(form).getByRole("textbox", { name: "URL" }), "http://x.example/mcp");
  await user.click(within(form).getByRole("button", { name: "Add connector" }));
  expect(await within(form).findByRole("alert")).toHaveProperty(
    "textContent",
    "Use an https URL. Plain http is only for this machine.",
  );
});

test("an edit shows a kept secret by name only, and removing it sends null", async () => {
  const kept: ConnectorInfo = {
    ...notion,
    auth: { type: "none" },
    authorized: false,
    status: { state: "ready" },
    secrets: { headers: ["Authorization"], env: [] },
  };
  const { user, dialog, named } = await mount({ connectors: [kept] });
  await user.click(await within(dialog).findByRole("button", { name: "Actions for notion" }));
  await user.click(await screen.findByRole("menuitem", { name: "Edit" }));
  const form = await screen.findByRole("dialog", { name: "Edit notion" });
  expect(within(form).getByText("Authorization is set")).toBeTruthy();
  await user.click(within(form).getByRole("button", { name: "Remove Authorization" }));
  await user.click(within(form).getByRole("button", { name: "Save connector" }));
  await waitFor(() => expect(named("updateConnector")).toHaveLength(1));
  expect(named("updateConnector")[0]?.[3]).toMatchObject({
    secrets: { headers: { Authorization: null } },
  });
});
