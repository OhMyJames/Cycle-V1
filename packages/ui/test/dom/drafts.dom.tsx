import { afterEach, expect, test } from "bun:test";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SessionSummary } from "../../src/api.ts";
import { App, StoreProvider } from "../../src/react/index.ts";
import { AppStore } from "../../src/store/index.ts";
import { fakeBridge, summary } from "../fake-bridge.ts";

afterEach(cleanup);

const sessions: SessionSummary[] = [
  { ...summary("s1"), title: "alpha", lastSeq: 2 },
  { ...summary("s2"), title: "beta", lastSeq: 1 },
];

const mount = async () => {
  const script = fakeBridge({ connected: true });
  script.bridge.sessions = async () => sessions;
  script.bridge.agents = async () => [
    {
      id: "fake",
      name: "Fake",
      available: true,
      configSchema: {},
      promptCapabilities: { image: {} },
    },
  ];
  const store = new AppStore(script.bridge);
  const user = userEvent.setup();
  render(
    <StoreProvider store={store}>
      <App />
    </StoreProvider>,
  );
  await act(() => store.start());
  const open = async (title: string) => {
    await user.click(await screen.findByRole("option", { name: new RegExp(title) }));
    return screen.findByRole("textbox", { name: "Message" });
  };
  return { store, user, open, ...script };
};

const png = (name: string) =>
  new File([Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])], name, { type: "image/png" });
const picker = () => {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (input === null) throw new Error("no file input");
  return input;
};

test("what is written in one session is there when the person comes back to it, and not in another", async () => {
  const { user, open } = await mount();
  const alpha = await open("alpha");
  await user.type(alpha, "half a sentence");
  const beta = await open("beta");
  expect((beta as HTMLTextAreaElement).value).toBe("");
  await user.type(beta, "something else");
  expect(((await open("alpha")) as HTMLTextAreaElement).value).toBe("half a sentence");
  expect(((await open("beta")) as HTMLTextAreaElement).value).toBe("something else");
});

test("sending clears the draft of that session only", async () => {
  const { user, open, named } = await mount();
  await user.type(await open("alpha"), "to send");
  await user.type(await open("beta"), "to keep");
  await user.click(await open("alpha"));
  await user.keyboard("{Enter}");
  await waitFor(() => expect(named("prompt")).toHaveLength(1));
  expect(((await open("alpha")) as HTMLTextAreaElement).value).toBe("");
  expect(((await open("beta")) as HTMLTextAreaElement).value).toBe("to keep");
});

test("the images attached to a session stay with it while another is open", async () => {
  const { user, open } = await mount();
  await open("alpha");
  await user.upload(picker(), png("one.png"));
  expect(await screen.findByRole("button", { name: "Remove one.png" })).toBeTruthy();
  await open("beta");
  expect(screen.queryByRole("button", { name: "Remove one.png" })).toBeNull();
  await open("alpha");
  expect(await screen.findByRole("button", { name: "Remove one.png" })).toBeTruthy();
});

test("an image still being read when the person goes to another session lands in the one it was added to", async () => {
  const { user, open } = await mount();
  await open("alpha");
  // A file that is read when the test says so.
  let finish: (bytes: ArrayBuffer) => void = () => {};
  const slow = png("slow.png");
  Object.defineProperty(slow, "arrayBuffer", {
    value: () =>
      new Promise<ArrayBuffer>((resolve) => {
        finish = resolve;
      }),
  });
  await user.upload(picker(), slow);
  await open("beta");
  await act(async () => finish(Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]).buffer));
  // It is not in the session that is open now...
  expect(screen.queryByRole("button", { name: "Remove slow.png" })).toBeNull();
  // ...but in the one it was added to.
  await open("alpha");
  expect(await screen.findByRole("button", { name: "Remove slow.png" })).toBeTruthy();
});

test("a deleted session takes its draft with it", async () => {
  const { store, user, open } = await mount();
  await user.type(await open("alpha"), "never sent");
  expect(store.drafts.get("local:s1").text).toBe("never sent");
  await act(() => store.deleteSession("s1"));
  expect(store.drafts.get("local:s1").text).toBe("");
});
