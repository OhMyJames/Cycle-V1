import { afterEach, expect, test } from "bun:test";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AgentInfo } from "../../src/api.ts";
import { AgentDefaultsDialog, EnvironmentDialog } from "../../src/react/index.ts";

afterEach(cleanup);

const agents: AgentInfo[] = [
  { id: "a", name: "Alpha", available: true, configSchema: {} },
  { id: "b", name: "Beta", available: true, configSchema: {} },
];

test("an environment dialog that is opened again is empty: what was added is not added twice", async () => {
  const user = userEvent.setup();
  const saved: string[] = [];
  const view = (open: boolean) => (
    <EnvironmentDialog open={open} onOpenChange={() => {}} onSave={(e) => void saved.push(e.id)} />
  );
  const { rerender } = render(view(true));
  await user.type(await screen.findByLabelText("Address"), "me@box");
  rerender(view(false));
  rerender(view(true));
  expect(((await screen.findByLabelText("Address")) as HTMLInputElement).value).toBe("");
  expect(screen.getByRole("button", { name: "Add" }).hasAttribute("disabled")).toBe(true);
});

test("an environment is not added twice by a double click", async () => {
  const user = userEvent.setup();
  let calls = 0;
  let finish: () => void = () => {};
  render(
    <EnvironmentDialog
      open
      onOpenChange={() => {}}
      onSave={() => {
        calls++;
        return new Promise<void>((resolve) => {
          finish = resolve;
        });
      }}
    />,
  );
  await user.type(await screen.findByLabelText("Address"), "me@box");
  const add = screen.getByRole("button", { name: "Add" });
  await user.click(add);
  await user.click(add);
  expect(calls).toBe(1);
  await act(async () => finish());
});

test("agent defaults are saved only once they are the ones of the agent shown", async () => {
  const user = userEvent.setup();
  let release: (value: Record<string, string>) => void = () => {};
  const read = () =>
    new Promise<Record<string, string> | undefined>((resolve) => {
      release = resolve;
    });
  const saved: string[] = [];
  render(
    <AgentDefaultsDialog
      open
      onOpenChange={() => {}}
      agents={agents}
      read={read}
      onSave={(agent) => void saved.push(agent)}
    />,
  );
  const save = await screen.findByRole("button", { name: "Save" });
  // Not read yet: what the form holds is not this agent's.
  expect(save.hasAttribute("disabled")).toBe(true);
  await act(async () => release({}));
  expect(save.hasAttribute("disabled")).toBe(false);
  await user.click(save);
  expect(saved).toEqual(["a"]);
});

test("agent defaults that cannot be read leave the form empty and can be saved", async () => {
  render(
    <AgentDefaultsDialog
      open
      onOpenChange={() => {}}
      agents={agents}
      read={() => Promise.reject(new Error("no"))}
      onSave={() => {}}
    />,
  );
  const save = await screen.findByRole("button", { name: "Save" });
  await act(async () => {
    await Bun.sleep(5);
  });
  expect(save.hasAttribute("disabled")).toBe(false);
});
