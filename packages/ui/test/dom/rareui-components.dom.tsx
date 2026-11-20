import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createTranslator, SOURCE_LOCALE } from "../../src/i18n.ts";
import { enUS } from "../../src/messages/en-US.ts";
import { I18nProvider } from "../../src/react/i18n.tsx";
import { formatElapsed, InlineAiStatus } from "../../src/react/inline-ai-status.tsx";
import { SettingChips } from "../../src/react/setting-chips.tsx";

afterEach(cleanup);

const translator = createTranslator(SOURCE_LOCALE, enUS);
const wrap = (ui: React.ReactNode) =>
  render(<I18nProvider translator={translator}>{ui}</I18nProvider>);

describe("InlineAiStatus", () => {
  test("formats elapsed seconds concisely via i18n and clamps negatives", () => {
    expect(formatElapsed(-3, translator.t)).toBe("0s");
    expect(formatElapsed(5, translator.t)).toBe("5s");
    expect(formatElapsed(60, translator.t)).toBe("1m");
    expect(formatElapsed(75, translator.t)).toBe("1m 15s");
  });

  test("renders thinking state with status role, live pulse, and optional detail", () => {
    const { container } = wrap(
      <InlineAiStatus
        kind="thinking"
        label="Thinking…"
        stepKey="1:thinking"
        detail={<span data-slot="step-detail">checking daemon</span>}
      />,
    );
    const step = container.querySelector('[data-slot="step"]');
    expect(step?.getAttribute("data-step")).toBe("thinking");
    const status = within(container).getByRole("status");
    const label = status.querySelector('[data-slot="step-label"]');
    expect(label?.textContent).toBe("Thinking…");
    expect(label?.hasAttribute("data-live")).toBe(true);
    expect(within(status).getByText("checking daemon")).toBeTruthy();
  });

  test("does not pulse or track elapsed time on approval state", () => {
    const { container } = wrap(
      <InlineAiStatus kind="approval" label="Waiting for your answer" stepKey="1:approval" />,
    );
    const step = container.querySelector('[data-slot="step"]');
    expect(step?.getAttribute("data-step")).toBe("approval");
    const status = within(container).getByRole("status");
    const label = status.querySelector('[data-slot="step-label"]');
    expect(label?.hasAttribute("data-live")).toBe(false);
    expect(container.querySelector('[data-slot="step-elapsed"]')).toBeNull();
  });

  test("shows elapsed timer outside the live region after 1s and resets when stepKey changes", async () => {
    const realNow = performance.now.bind(performance);
    let offsetMs = 0;
    performance.now = () => realNow() + offsetMs;
    try {
      const { container, rerender } = wrap(
        <InlineAiStatus kind="working" label="Working…" stepKey="1:working" />,
      );
      // Hidden during the first second.
      expect(container.querySelector('[data-slot="step-elapsed"]')).toBeNull();

      // Advance monotonic clock past 2 seconds and let the 500ms interval tick.
      offsetMs = 2200;
      await waitFor(
        () => {
          const elapsed = container.querySelector('[data-slot="step-elapsed"]');
          expect(elapsed?.textContent).toBe("2s");
        },
        { timeout: 2000 },
      );

      // ElapsedTimer must stay outside role="status" so ticks do not spam screen readers.
      const status = within(container).getByRole("status");
      const elapsed = container.querySelector('[data-slot="step-elapsed"]');
      expect(elapsed).not.toBeNull();
      expect(status.contains(elapsed)).toBe(false);

      // Changing stepKey resets the elapsed counter back below 1s.
      rerender(
        <I18nProvider translator={translator}>
          <InlineAiStatus kind="working" label="Working…" stepKey="2:working" />
        </I18nProvider>,
      );
      expect(container.querySelector('[data-slot="step-elapsed"]')).toBeNull();
    } finally {
      performance.now = realNow;
    }
  });
});

describe("SettingChips picker", () => {
  const shortSchema = {
    type: "object",
    properties: {
      mode: {
        type: "string",
        title: "Permission mode",
        oneOf: [
          {
            const: "auto",
            title: "Auto",
            description: "Reviews each action.",
            _meta: { "cycle/recommended": true },
          },
          { const: "plan", title: "Plan mode", description: "Changes nothing." },
          {
            const: "bypass",
            title: "Bypass permissions",
            description: "Runs without asking.",
            _meta: { "cycle/danger": true },
          },
        ],
      },
    },
  };

  const longModelSchema = {
    type: "object",
    properties: {
      model: {
        type: "string",
        title: "Model",
        oneOf: [
          { const: "default", title: "Default model" },
          { const: "opus-4", title: "Claude Opus" },
          { const: "sonnet-4", title: "Claude Sonnet" },
          { const: "haiku-4", title: "Claude Haiku" },
          { const: "custom", title: "Custom endpoint" },
        ],
      },
    },
  };

  const twoChipSchema = {
    type: "object",
    properties: {
      ...shortSchema.properties,
      ...longModelSchema.properties,
    },
  };

  test("navigates short menu with ARIA activedescendant, prevents arrow auto-select on danger mode, and commits on Enter/Space", async () => {
    const user = userEvent.setup();
    const calls: [string, string][] = [];
    wrap(
      <SettingChips
        settings={{ schema: shortSchema, value: { mode: "auto" } }}
        disabled={false}
        onSet={(k, v) => calls.push([k, v])}
      />,
    );

    const chip = screen.getByRole("button", { name: "Permission mode: Auto" });
    expect(chip.getAttribute("aria-haspopup")).toBe("menu");

    // ArrowDown on trigger opens the menu.
    chip.focus();
    await user.keyboard("{ArrowDown}");
    expect(chip.getAttribute("aria-expanded")).toBe("true");
    expect(screen.queryByRole("combobox")).toBeNull();

    const menu = screen.getByRole("menu", { name: "Permission mode" });
    expect(chip.getAttribute("aria-controls")).toBe(menu.id);
    const items = within(menu).getAllByRole("menuitemradio");
    expect(items).toHaveLength(3);
    expect(menu.getAttribute("aria-activedescendant")).toBe(items[0]?.id ?? null);

    // ArrowUp wraps to the last item (Bypass permissions) without selecting it.
    await user.keyboard("{ArrowUp}");
    expect(menu.getAttribute("aria-activedescendant")).toBe(items[2]?.id ?? null);
    expect(calls).toHaveLength(0);

    // Home jumps to first, End jumps to last.
    await user.keyboard("{Home}");
    expect(menu.getAttribute("aria-activedescendant")).toBe(items[0]?.id ?? null);
    await user.keyboard("{End}");
    expect(menu.getAttribute("aria-activedescendant")).toBe(items[2]?.id ?? null);
    expect(calls).toHaveLength(0);

    // Escape closes without changing setting and returns focus to chip.
    await user.keyboard("{Escape}");
    expect(chip.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(chip);
    expect(calls).toHaveLength(0);

    // Re-selecting current choice with Space closes without calling onSet.
    await user.click(chip);
    await user.keyboard(" ");
    expect(calls).toHaveLength(0);
    expect(chip.getAttribute("aria-expanded")).toBe("false");

    // Re-open, arrow down once to Plan mode, press Enter to commit.
    await user.click(chip);
    await user.keyboard("{ArrowDown}{Enter}");
    expect(calls).toEqual([["mode", "plan"]]);
    expect(chip.getAttribute("aria-expanded")).toBe("false");
  });

  test("uses combobox/listbox ARIA for 5+ options, preserves search caret keys, and respects standard + Safari IME composition", async () => {
    const user = userEvent.setup();
    const calls: [string, string][] = [];
    wrap(
      <SettingChips
        settings={{ schema: longModelSchema, value: { model: "default" } }}
        disabled={false}
        onSet={(k, v) => calls.push([k, v])}
      />,
    );

    const chip = screen.getByRole("button", { name: "Model: Default model" });
    expect(chip.getAttribute("aria-haspopup")).toBe("listbox");
    await user.click(chip);

    const combobox = screen.getByRole("combobox", { name: "Filter Model" });
    const listbox = screen.getByRole("listbox", { name: "Model" });
    expect(combobox.getAttribute("aria-controls")).toBe(listbox.id);

    // Home/End/Space inside the search box must not hijack text input or commit an option.
    await user.type(combobox, "claude ");
    fireEvent.keyDown(combobox, { key: "Home" });
    fireEvent.keyDown(combobox, { key: "End" });
    expect(calls).toHaveLength(0);

    await user.clear(combobox);
    await user.type(combobox, "haiku");
    const options = within(listbox).getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(within(listbox).getByRole("option", { name: "Claude Haiku" })).toBeTruthy();
    expect(combobox.getAttribute("aria-activedescendant")).toBe(options[0]?.id ?? null);

    // Standard IME composition must ignore Enter and Escape.
    fireEvent.keyDown(combobox, { key: "Enter", isComposing: true });
    fireEvent.keyDown(combobox, { key: "Escape", isComposing: true });
    expect(calls).toHaveLength(0);
    expect(chip.getAttribute("aria-expanded")).toBe("true");

    // Safari IME edge case (isComposing: false, keyCode: 229) must also ignore Enter and Escape.
    fireEvent.keyDown(combobox, { key: "Enter", isComposing: false, keyCode: 229 });
    fireEvent.keyDown(combobox, { key: "Escape", isComposing: false, keyCode: 229 });
    expect(calls).toHaveLength(0);
    expect(chip.getAttribute("aria-expanded")).toBe("true");

    // Non-composing Enter commits the filtered choice.
    await user.keyboard("{Enter}");
    expect(calls).toEqual([["model", "haiku-4"]]);
  });

  test("announces empty search results via status role", async () => {
    const user = userEvent.setup();
    wrap(
      <SettingChips
        settings={{ schema: longModelSchema, value: { model: "default" } }}
        disabled={false}
        onSet={() => {}}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Model: Default model" }));
    await user.type(screen.getByRole("combobox", { name: "Filter Model" }), "zzzzz");
    const empty = screen.getByText("No matching option.");
    expect(empty.getAttribute("role")).toBe("status");
  });

  test("closes on outside click, Tab, switching chips, and becoming disabled", async () => {
    const user = userEvent.setup();
    const { rerender } = wrap(
      <div>
        <button type="button">Outside</button>
        <SettingChips
          settings={{ schema: twoChipSchema, value: { mode: "auto", model: "default" } }}
          disabled={false}
          onSet={() => {}}
        />
      </div>,
    );

    const modeChip = screen.getByRole("button", { name: "Permission mode: Auto" });
    const modelChip = screen.getByRole("button", { name: "Model: Default model" });
    const outside = screen.getByRole("button", { name: "Outside" });

    // Outside click closes popover.
    await user.click(modeChip);
    expect(modeChip.getAttribute("aria-expanded")).toBe("true");
    await user.click(outside);
    expect(modeChip.getAttribute("aria-expanded")).toBe("false");

    // Switching to another chip closes the first.
    await user.click(modeChip);
    expect(modeChip.getAttribute("aria-expanded")).toBe("true");
    await user.click(modelChip);
    expect(modeChip.getAttribute("aria-expanded")).toBe("false");
    expect(modelChip.getAttribute("aria-expanded")).toBe("true");

    // Tab closes popover.
    await user.keyboard("{Tab}");
    expect(modelChip.getAttribute("aria-expanded")).toBe("false");

    // Becoming disabled while open closes the popover and sets data-disabled.
    await user.click(modeChip);
    expect(modeChip.getAttribute("aria-expanded")).toBe("true");
    rerender(
      <I18nProvider translator={translator}>
        <div>
          <button type="button">Outside</button>
          <SettingChips
            settings={{ schema: twoChipSchema, value: { mode: "auto", model: "default" } }}
            disabled={true}
            onSet={() => {}}
          />
        </div>
      </I18nProvider>,
    );
    expect(modeChip.getAttribute("aria-expanded")).toBe("false");
    expect(modeChip.hasAttribute("data-disabled")).toBe(true);
  });
});
