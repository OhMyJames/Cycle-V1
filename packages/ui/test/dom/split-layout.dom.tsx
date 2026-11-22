import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createResizableController } from "@ui-sdk/react/resizable";
import { createTranslator, SOURCE_LOCALE } from "../../src/i18n.ts";
import { enUS } from "../../src/messages/en-US.ts";
import { I18nProvider } from "../../src/react/i18n.tsx";
import { PanelTabs } from "../../src/react/panel-tabs.tsx";
import {
  fitColumns,
  foldedByWindow,
  MAIN_MIN,
  PANEL,
  SIDEBAR,
  SplitLayout,
} from "../../src/react/split-layout.tsx";

afterEach(cleanup);
const translator = createTranslator(SOURCE_LOCALE, enUS);
const wrap = (ui: React.ReactNode) =>
  render(<I18nProvider translator={translator}>{ui}</I18nProvider>);

// The order is .agents/notes/2026-11-21-right-panel-layout.md's: the conversation gives way first, down to its
// minimum; then the panel, down to its own; then the sidebar folds. The panel never covers the conversation.
describe("fitColumns", () => {
  const want = { sidebar: SIDEBAR.default, panel: PANEL.default };

  test("a wide window keeps what the user chose", () => {
    expect(fitColumns(1600, want)).toEqual({ ...want, sidebarFolded: false });
  });

  test("the conversation narrows first, then the panel, then the sidebar folds", () => {
    // 256 + 400 + 400 = 1056: the conversation is at its minimum, nothing else moves.
    expect(fitColumns(1056, want)).toEqual({ ...want, sidebarFolded: false });
    // Narrower: the panel gives the difference, down to its minimum.
    expect(fitColumns(1000, want)).toEqual({ sidebar: 256, panel: 344, sidebarFolded: false });
    expect(fitColumns(256 + MAIN_MIN + PANEL.min, want)).toEqual({
      sidebar: 256,
      panel: PANEL.min,
      sidebarFolded: false,
    });
    // Narrower still: the sidebar folds, and the panel gets back what it can.
    expect(fitColumns(900, want)).toEqual({ sidebar: 0, panel: 400, sidebarFolded: true });
  });

  test("the smallest window holds the conversation and the panel side by side", () => {
    const fit = fitColumns(720, want);
    expect(fit).toEqual({ sidebar: 0, panel: 320, sidebarFolded: true });
    expect(720 - fit.panel).toBeGreaterThanOrEqual(MAIN_MIN);
  });

  test("without the panel, a sidebar the user folded stays folded and is not counted as the window's", () => {
    expect(fitColumns(720, { sidebar: SIDEBAR.default, panel: 0 })).toEqual({
      sidebar: SIDEBAR.default,
      panel: 0,
      sidebarFolded: false,
    });
    expect(fitColumns(500, { sidebar: 0, panel: PANEL.default })).toEqual({
      sidebar: 0,
      panel: PANEL.min,
      sidebarFolded: false,
    });
  });
});

describe("foldedByWindow", () => {
  test("the user's own change to the sidebar makes its fold the user's; a change elsewhere does not", () => {
    // The window folded it; the user drags the panel's handle: still the window's, given back when there is room.
    expect(foldedByWindow(true, true, true)).toBe(true);
    // The user shows it (⌘B), or hides it again: the user's from then on, and not reopened by a wider window.
    expect(foldedByWindow(true, true, false)).toBe(false);
    expect(foldedByWindow(false, false, true)).toBe(false);
  });
});

describe("SplitLayout", () => {
  test("the panel is not in the page while closed; open, it has its own named handle beside the sidebar's", () => {
    const controller = createResizableController();
    const { rerender } = wrap(
      <SplitLayout controller={controller} sidebar={<nav>Sidebar</nav>} main={<main>Main</main>} />,
    );
    expect(screen.getAllByRole("separator").map((s) => s.getAttribute("aria-label"))).toEqual([
      "Resize sidebar",
    ]);
    expect(screen.queryByRole("complementary", { name: "Panel" })).toBeNull();

    rerender(
      <I18nProvider translator={translator}>
        <SplitLayout
          controller={controller}
          sidebar={<nav>Sidebar</nav>}
          main={<main>Main</main>}
          panel={{ content: <p>Overview here</p> }}
        />
      </I18nProvider>,
    );
    expect(screen.getAllByRole("separator").map((s) => s.getAttribute("aria-label"))).toEqual([
      "Resize sidebar",
      "Resize panel",
    ]);
    const panel = screen.getByRole("complementary", { name: "Panel" });
    expect(within(panel).getByText("Overview here")).toBeTruthy();
  });
  // The handles' keys and drags are the SDK's and tested there; happy-dom has no layout to move. The gallery's
  // `panel-*` scenarios show the columns in a real window.
});

describe("PanelTabs", () => {
  test("arrows choose a tab, and only the chosen tab's content is in the page", async () => {
    const user = userEvent.setup();
    const chosen: string[] = [];
    let value = "overview";
    const tabs = [
      { id: "overview", label: "Overview", content: <p>The session at a glance</p> },
      { id: "files", label: "Files", content: <p>The tree</p> },
    ];
    const { rerender } = wrap(
      <PanelTabs
        label="Panel"
        tabs={tabs}
        value={value}
        onValueChange={(id) => {
          chosen.push(id);
          value = id;
        }}
      />,
    );
    expect(screen.getByRole("tablist", { name: "Panel" })).toBeTruthy();
    expect(screen.getByText("The session at a glance")).toBeTruthy();
    expect(screen.queryByText("The tree")).toBeNull();

    screen.getByRole("tab", { name: "Overview" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(chosen).toEqual(["files"]);
    rerender(
      <I18nProvider translator={translator}>
        <PanelTabs label="Panel" tabs={tabs} value={value} onValueChange={() => {}} />
      </I18nProvider>,
    );
    expect(screen.getByRole("tab", { name: "Files" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("The tree")).toBeTruthy();
    expect(screen.queryByText("The session at a glance")).toBeNull();
  });
});
