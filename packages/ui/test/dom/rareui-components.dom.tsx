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

  test("a long model list has no filter: the list takes the focus however it opens, and composing keys are left alone", async () => {
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
    expect(chip.getAttribute("aria-haspopup")).toBe("menu");
    await user.click(chip);
    const menu = screen.getByRole("menu", { name: "Model" });
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(within(menu).getAllByRole("menuitemradio")).toHaveLength(5);
    expect(document.activeElement).toBe(menu);

    // Composing (standard, and Safari's keyCode 229) neither commits nor closes.
    fireEvent.keyDown(menu, { key: "Enter", isComposing: true });
    fireEvent.keyDown(menu, { key: "Escape", isComposing: true });
    fireEvent.keyDown(menu, { key: "Enter", isComposing: false, keyCode: 229 });
    fireEvent.keyDown(menu, { key: "Escape", isComposing: false, keyCode: 229 });
    expect(calls).toHaveLength(0);
    expect(chip.getAttribute("aria-expanded")).toBe("true");

    // With the focus back on the chip while it is open, the arrows still go to the list.
    chip.focus();
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(menu);
    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(calls).toEqual([["model", "sonnet-4"]]);
    expect(chip.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(chip);

    // Opened from the keyboard, the list has the focus at once.
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(screen.getByRole("menu", { name: "Model" }));
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

  test("pairs compact description-free Model picker and draggable Effort slider on the right", async () => {
    const user = userEvent.setup();
    const calls: [string, string][] = [];
    const schema = {
      type: "object",
      properties: {
        mode: {
          type: "string",
          title: "Permission mode",
          oneOf: [{ const: "auto", title: "Auto" }],
        },
        model: {
          type: "string",
          title: "Model",
          oneOf: [
            { const: "default", title: "Default model", description: "Default description." },
            { const: "opus", title: "Opus", description: "Most capable." },
            { const: "sonnet", title: "Sonnet", description: "Balanced." },
          ],
        },
        effort: {
          type: "string",
          title: "Effort",
          oneOf: [
            { const: "default", title: "Default", description: "Model default depth." },
            { const: "low", title: "Low", description: "Minimal reasoning." },
            { const: "high", title: "High", description: "Deeper reasoning." },
          ],
        },
      },
    };

    const { rerender } = wrap(
      <div>
        <div data-testid="left">
          <SettingChips
            side="left"
            settings={{ schema, value: { mode: "auto", model: "opus", effort: "high" } }}
            disabled={false}
            onSet={(k, v) => calls.push([k, v])}
          />
        </div>
        <div data-testid="right">
          <SettingChips
            side="right"
            settings={{ schema, value: { mode: "auto", model: "opus", effort: "high" } }}
            disabled={false}
            onSet={(k, v) => calls.push([k, v])}
          />
        </div>
      </div>,
    );

    // Permission mode stays on the left; paired Model + Effort lives on the right (no standalone Effort chip).
    expect(
      within(screen.getByTestId("left")).getByRole("button", { name: "Permission mode: Auto" }),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId("left")).queryByRole("button", { name: /Model|Effort/ }),
    ).toBeNull();
    const modelChip = within(screen.getByTestId("right")).getByRole("button", {
      name: "Model: Opus, Effort: High",
    });
    expect(within(screen.getByTestId("right")).getAllByRole("button")).toHaveLength(1);
    expect(modelChip.querySelector('[data-slot="setting-subvalue"]')?.textContent).toBe("High");

    // Opening the Model chip renders compact description-free Model rows plus the elastic Effort slider.
    expect(modelChip.getAttribute("aria-haspopup")).toBe("dialog");
    await user.click(modelChip);
    const dialog = screen.getByRole("dialog", { name: "Model" });
    expect(modelChip.getAttribute("aria-controls")).toBe(dialog.id);
    expect(screen.queryByText("Most capable.")).toBeNull();
    const slider = screen.getByRole("slider", { name: "Effort" }) as HTMLInputElement;
    expect(slider.value).toBe("2");
    expect(slider.getAttribute("aria-valuetext")).toBe("High");

    // Tab cycles focus from Model list into the Effort slider and Shift+Tab cycles back without closing.
    await user.keyboard("{Tab}");
    expect(document.activeElement).toBe(slider);
    expect(modelChip.getAttribute("aria-expanded")).toBe("true");
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(document.activeElement).toBe(screen.getByRole("menu", { name: "Model" }));
    expect(modelChip.getAttribute("aria-expanded")).toBe("true");

    // Adjusting the Effort slider (or clicking a tick) updates effort, keeps focus on the range input, and leaves the popover open.
    fireEvent.change(slider, { target: { value: "1" } });
    expect(calls).toEqual([["effort", "low"]]);
    expect(modelChip.getAttribute("aria-expanded")).toBe("true");

    await user.click(screen.getByRole("button", { name: "Default" }));
    expect(document.activeElement).toBe(slider);
    expect(calls).toEqual([
      ["effort", "low"],
      ["effort", "default"],
    ]);
    expect(modelChip.getAttribute("aria-expanded")).toBe("true");

    // Pointer scrubbing across the Effort slider track commits the nearest discrete stop.
    const sliderTrack = dialog.querySelector<HTMLElement>('[data-slot="effort-slider"]');
    expect(sliderTrack).not.toBeNull();
    if (sliderTrack !== null) {
      sliderTrack.getBoundingClientRect = () =>
        ({ left: 0, width: 116, top: 0, bottom: 20, right: 116, height: 20 }) as DOMRect;
      fireEvent.pointerDown(sliderTrack, { button: 0, pointerId: 1, clientX: 58 });
      fireEvent.pointerMove(sliderTrack, { pointerId: 1, clientX: 58 });
      fireEvent.pointerUp(sliderTrack, { pointerId: 1, clientX: 58 });
    }
    expect(calls.at(-1)).toEqual(["effort", "low"]);

    // Selecting a model option updates model and closes the popover.
    await user.click(screen.getByRole("menuitemradio", { name: /Sonnet/ }));
    expect(calls.at(-1)).toEqual(["model", "sonnet"]);
    expect(modelChip.getAttribute("aria-expanded")).toBe("false");

    // When effort is unset (`undefined`), the Effort slider displays "Not set" instead of claiming "Default".
    rerender(
      <I18nProvider translator={translator}>
        <SettingChips
          side="right"
          settings={{ schema, value: { mode: "auto", model: "sonnet" } }}
          disabled={false}
          onSet={(k, v) => calls.push([k, v])}
        />
      </I18nProvider>,
    );
    const conciseChip = screen.getByRole("button", { name: "Model: Sonnet" });
    expect(conciseChip.querySelector('[data-slot="setting-subvalue"]')).toBeNull();
    await user.click(conciseChip);
    const unsetSlider = screen.getByRole("slider", { name: "Effort" });
    expect(unsetSlider.getAttribute("aria-valuetext")).toBe("Not set");
  });

  test("effort follows the model's own levels: none hides it, a few narrow it, and a new session's choice goes back to default", async () => {
    const user = userEvent.setup();
    const calls: [string, string][] = [];
    const schema = {
      type: "object",
      properties: {
        model: {
          type: "string",
          title: "Model",
          oneOf: [
            { const: "default", title: "Default model" },
            { const: "opus", title: "Opus", _meta: { "cycle/efforts": ["low", "high", "max"] } },
            { const: "haiku", title: "Haiku", _meta: { "cycle/efforts": [] } },
            { const: "odd", title: "Odd" },
          ],
        },
        effort: {
          type: "string",
          title: "Effort",
          oneOf: ["default", "low", "medium", "high", "max"].map((v) => ({ const: v, title: v })),
        },
      },
    };
    const render = (value: Record<string, string>, draft: boolean) => (
      <I18nProvider translator={translator}>
        <SettingChips
          settings={{ schema, value }}
          disabled={false}
          draft={draft}
          onSet={(k, v) => calls.push([k, v])}
        />
      </I18nProvider>
    );
    const { rerender } = wrap(render({ model: "opus", effort: "max" }, true));
    const ticks = () =>
      [...document.querySelectorAll('[data-slot="effort-tick"]')].map((t) => t.textContent);

    // Opus takes low, high and max: the slider offers those and the model's default, nothing else.
    await user.click(screen.getByRole("button", { name: /^Model: Opus/ }));
    expect(ticks()).toEqual(["Default", "low", "high", "max"]);

    // Choosing Haiku, which takes no effort, on a new session puts the effort back to default with it.
    await user.click(screen.getByRole("menuitemradio", { name: "Haiku" }));
    expect(calls).toEqual([
      ["model", "haiku"],
      ["effort", "default"],
    ]);

    // With Haiku chosen, there is no effort to show.
    rerender(render({ model: "haiku", effort: "default" }, true));
    await user.click(screen.getByRole("button", { name: "Model: Haiku" }));
    expect(screen.queryByRole("slider", { name: "Effort" })).toBeNull();
    await user.keyboard("{Escape}");

    // A model that does not say keeps every level; and in a live session the agent, not the picker, resets effort.
    calls.length = 0;
    rerender(render({ model: "odd", effort: "medium" }, false));
    await user.click(screen.getByRole("button", { name: /^Model: Odd/ }));
    expect(ticks()).toEqual(["Default", "low", "medium", "high", "max"]);
    await user.click(screen.getByRole("menuitemradio", { name: "Haiku" }));
    expect(calls).toEqual([["model", "haiku"]]);
  });
});
