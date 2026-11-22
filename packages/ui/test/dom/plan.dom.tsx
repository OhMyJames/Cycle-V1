import { afterEach, expect, test } from "bun:test";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { createTranslator, SOURCE_LOCALE } from "../../src/i18n.ts";
import { enUS } from "../../src/messages/en-US.ts";
import type { PlanEntry } from "../../src/model/index.ts";
import { I18nProvider } from "../../src/react/i18n.tsx";
import { PlanList } from "../../src/react/plan.tsx";

afterEach(cleanup);

const translator = createTranslator(SOURCE_LOCALE, enUS);
const list = (statuses: PlanEntry["status"][]) => (
  <I18nProvider translator={translator}>
    <PlanList
      entries={statuses.map((status, n) => ({
        content: `Step ${n + 1}`,
        priority: "medium",
        status,
      }))}
    />
  </I18nProvider>
);
const rows = () =>
  within(screen.getByRole("list", { name: "Plan" }))
    .getAllByRole("listitem")
    .map(
      (li) => `${li.querySelector('[data-slot="plan-label"]')?.textContent}:${li.dataset.status}`,
    );

test("what is done is drawn below what is still open, and moves down once the agent marks it done", async () => {
  const { rerender } = render(list(["completed", "in_progress", "pending"]));
  expect(rows()).toEqual(["Step 2:in_progress", "Step 3:pending", "Step 1:completed"]);

  rerender(list(["completed", "completed", "in_progress"]));
  // It ticks where it stands, then goes below the open ones.
  await waitFor(() =>
    expect(rows()).toEqual(["Step 3:in_progress", "Step 1:completed", "Step 2:completed"]),
  );
});
