import type { SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import type { AgentInfo, SessionSnapshot } from "../../src/api.ts";
import { applyUpdate, emptyConversation } from "../../src/model/index.ts";
import { App, StoreProvider } from "../../src/react/index.ts";
import { AppStore } from "../../src/store/index.ts";
import { fakeBridge } from "../fake-bridge.ts";
import { press, ready, write } from "./box.ts";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const agent = (promptCapabilities: AgentInfo["promptCapabilities"]): AgentInfo => ({
  id: "fake",
  name: "Fake",
  available: true,
  configSchema: {},
  promptCapabilities,
});

const open = async (
  promptCapabilities: AgentInfo["promptCapabilities"],
  ...updates: SessionUpdate[]
) => {
  const snapshot = (): SessionSnapshot => ({
    conversation: updates.reduce(applyUpdate, emptyConversation()),
    permissions: [],
    version: updates.length,
  });
  const script = fakeBridge({ connected: true, snapshot });
  script.bridge.agents = async () => [agent(promptCapabilities)];
  const store = new AppStore(script.bridge);
  const user = userEvent.setup();
  render(
    <StoreProvider store={store}>
      <App />
    </StoreProvider>,
  );
  await act(() => store.start());
  await user.click(await screen.findByRole("option", { name: /work/ }));
  const box = await screen.findByRole("textbox", { name: "Message" });
  await ready(box);
  const tracked = () =>
    script.calls.filter(([name]) => name === "track").map(([, event, props]) => [event, props]);
  const picker = () => {
    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    if (input === null) throw new Error("no file input");
    return input;
  };
  return { user, box, script, tracked, picker };
};

const both = { image: {}, embeddedContext: {} };
const pdfBytes = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);

test("a text file and a PDF are attached as chips with name and size, and go as embedded resources", async () => {
  const { user, box, script, tracked, picker } = await open(both);
  await screen.findByRole("button", { name: "Attach files" });
  // Any file may be chosen: the picker is not limited to images.
  expect(picker().hasAttribute("accept")).toBe(false);
  // A `.ts` file is often typed as video by the system: its bytes say it is text.
  await user.upload(
    picker(),
    new File(["const secret = 1;\n"], "secret-plan.ts", { type: "video/mp2t" }),
  );
  await user.upload(picker(), new File([pdfBytes], "spec.pdf", { type: "application/pdf" }));
  const list = await screen.findByRole("list", { name: "Attachments" });
  await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(2));
  const [ts, pdf] = within(list).getAllByRole("listitem");
  expect(ts?.textContent).toContain("secret-plan.ts");
  expect(ts?.textContent).toContain("1 kB");
  expect(pdf?.textContent).toContain("spec.pdf");
  expect(screen.getByRole("button", { name: "Remove spec.pdf" })).toBeTruthy();

  await write(box, "read these");
  await press(box, "Enter");
  await waitFor(() => expect(script.named("prompt")).toHaveLength(1));
  expect(script.named("prompt")[0]?.[3]).toEqual([
    { type: "text", text: "read these" },
    {
      type: "resource",
      resource: {
        uri: "attachment:///secret-plan.ts",
        mimeType: "text/plain",
        text: "const secret = 1;\n",
      },
    },
    {
      type: "resource",
      resource: { uri: "attachment:///spec.pdf", mimeType: "application/pdf", blob: "JVBERi0x" },
    },
  ]);
  expect(tracked()).toContainEqual(["attachment_added", { kind: "text", via: "button" }]);
  expect(tracked()).toContainEqual(["attachment_added", { kind: "pdf", via: "button" }]);
  expect(JSON.stringify(tracked())).not.toContain("secret");
});

test("a binary file that is not a PDF is refused with the reason, and nothing is attached", async () => {
  const { user, tracked, picker } = await open(both);
  await screen.findByRole("button", { name: "Attach files" });
  await user.upload(
    picker(),
    new File([Uint8Array.from([0x00, 0xff, 0x10, 0x80])], "build.bin", {
      type: "application/octet-stream",
    }),
  );
  expect((await screen.findByRole("alert")).textContent).toContain(
    "build.bin is not an image, a text file or a PDF.",
  );
  expect(screen.queryByRole("list", { name: "Attachments" })).toBeNull();
  expect(tracked()).toContainEqual(["attachment_refused", { reason: "type" }]);
  expect(JSON.stringify(tracked())).not.toContain("build");
});

test("an agent that takes images only refuses a text file, and its button says images", async () => {
  const { user, picker } = await open({ image: {} });
  await screen.findByRole("button", { name: "Attach image" });
  await user.upload(picker(), new File(["hello"], "notes.txt", { type: "text/plain" }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "notes.txt is not a PNG, JPEG, GIF or WebP image.",
  );
});

test("files dropped on the box or pasted into it are attached", async () => {
  const { box, tracked } = await open(both);
  const files = (file: File) => {
    const data = new DataTransfer();
    data.items.add(file);
    return data;
  };
  const composer = box.closest<HTMLElement>('[data-slot="composer"]');
  if (composer === null) throw new Error("no composer");
  await act(async () => {
    composer.dispatchEvent(
      new DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        dataTransfer: files(new File(["a,b\n1,2\n"], "table.csv", { type: "text/csv" })),
      }),
    );
  });
  await screen.findByRole("button", { name: "Remove table.csv" });
  await act(async () => {
    box.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: files(new File(["{}"], "config.json", { type: "application/json" })),
      }),
    );
  });
  await screen.findByRole("button", { name: "Remove config.json" });
  expect(tracked()).toContainEqual(["attachment_added", { kind: "text", via: "drop" }]);
  expect(tracked()).toContainEqual(["attachment_added", { kind: "text", via: "paste" }]);
});

test("a file in a sent message is a chip with its name; what is in it is never drawn", async () => {
  await open(both, {
    sessionUpdate: "user_message",
    messageId: "m1",
    content: [
      { type: "text", text: "look" },
      {
        type: "resource",
        resource: {
          uri: "attachment:///page%20one.html",
          mimeType: "text/html",
          text: '<img src="x" onerror="alert(1)"><b>loud</b>',
        },
      },
    ],
  } as SessionUpdate);
  const log = screen.getByRole("log", { name: "Conversation" });
  await within(log).findByText("page one.html");
  expect(log.textContent).not.toContain("loud");
  expect(log.textContent).not.toContain("onerror");
  expect(log.querySelector("b")).toBeNull();
  expect(log.querySelector('img[src="x"]')).toBeNull();
});
