import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { Button } from "@ui-sdk/react/button";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@ui-sdk/react/menu";
import { afterEach, expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import { Tip } from "../../src/react/tip.tsx";

afterEach(cleanup);

test("a tip names a control that has only an icon, and tells its keys, without taking its behaviour", async () => {
  const user = userEvent.setup();
  const pressed: string[] = [];
  render(
    <div>
      <Tip label="Hide sidebar" shortcut="mod+b">
        <Button data-variant="ghost" onClick={() => pressed.push("toggle")}>
          <svg aria-hidden="true" />
        </Button>
      </Tip>
      <Menu onAction={(value) => pressed.push(String(value))}>
        <Tip label="Session actions">
          <MenuTrigger data-variant="ghost">
            <svg aria-hidden="true" />
          </MenuTrigger>
        </Tip>
        <MenuContent>
          <MenuItem value="rename">Rename</MenuItem>
        </MenuContent>
      </Menu>
    </div>,
  );

  // Named by the tip, not by an aria-label or a title of its own; the keys are told, not bound.
  const toggle = screen.getByRole("button", { name: "Hide sidebar" });
  expect(toggle.hasAttribute("aria-label")).toBe(false);
  expect(toggle.hasAttribute("title")).toBe(false);
  // ui-sdk's first render is the same on every platform (as a server would render it, so that hydration agrees); the
  // platform's keys follow once it is mounted. That is ui-sdk's choice, not this app's.
  await waitFor(() =>
    expect(toggle.getAttribute("aria-keyshortcuts")).toBe(
      /Mac/.test(navigator.userAgent) ? "Meta+B" : "Control+B",
    ),
  );
  // The control is still the one it wraps: its own slot and its own press.
  expect(toggle.getAttribute("data-slot")).toBe("button");
  await user.click(toggle);
  expect(pressed).toEqual(["toggle"]);

  // Keyboard focus shows the tip at once.
  await user.tab();
  await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
  const actions = screen.getByRole("button", { name: "Session actions" });
  expect(document.activeElement).toBe(actions);
  const shown = document.querySelector('[data-slot="tooltip-content"][data-open]');
  expect(shown?.textContent).toBe("Session actions");

  // A menu's trigger keeps opening its menu.
  await user.keyboard("{Enter}");
  expect(actions.getAttribute("aria-expanded")).toBe("true");
  await user.keyboard("{Enter}");
  expect(pressed).toEqual(["toggle", "rename"]);
});
