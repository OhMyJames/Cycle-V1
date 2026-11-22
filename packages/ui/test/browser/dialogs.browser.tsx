import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import type { AgentInfo } from "../../src/api.ts";
import { ConfirmDialog } from "../../src/react/dialogs.tsx";
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
  // Two presses in a row, as a double click lands: the second must not save again.
  await user.dblClick(add);
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

test("agent defaults that cannot be read are not replaced by an empty form: they cannot be saved over", async () => {
  render(
    <AgentDefaultsDialog
      open
      onOpenChange={() => {}}
      agents={agents}
      read={() => Promise.reject(new Error("no"))}
      onSave={() => {}}
    />,
  );
  expect(await screen.findByText(/could not be read/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
});

test("environment dialog keeps user input on failure, avoids id collisions, and supports editing", async () => {
  const user = userEvent.setup();
  const saved: { id: string; name: string; host: string }[] = [];
  let fail = true;
  render(
    <EnvironmentDialog
      open
      onOpenChange={() => {}}
      existingIds={new Set(["ssh-me-box"])}
      onSave={async (e) => {
        if (fail) return "Disk full";
        saved.push({ id: e.id, name: e.name, host: e.kind === "remote" ? e.transport.host : "" });
        return undefined;
      }}
    />,
  );
  await user.type(await screen.findByLabelText("Address"), "me@box");
  await user.click(screen.getByRole("button", { name: "Add" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Disk full");
  expect(((await screen.findByLabelText("Address")) as HTMLInputElement).value).toBe("me@box");
  fail = false;
  await user.click(screen.getByRole("button", { name: "Add" }));
  expect(saved).toEqual([{ id: "ssh-me-box-2", name: "me@box", host: "me@box" }]);
});

test("destructive confirm dialog uses destructive variant and stays open on failure", async () => {
  const user = userEvent.setup();
  let closed = false;
  render(
    <ConfirmDialog
      open
      onOpenChange={(next) => {
        if (!next) closed = true;
      }}
      title="Remove Build?"
      description="Removes settings."
      confirmLabel="Remove environment"
      destructive
      onConfirm={async () => "Still busy"}
    />,
  );
  const button = await screen.findByRole("button", { name: "Remove environment" });
  expect(button.getAttribute("data-variant")).toBe("destructive");
  await user.click(button);
  expect((await screen.findByRole("alert")).textContent).toContain("Still busy");
  expect(closed).toBe(false);
});
