import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@ui-sdk/react/collapsible";
import type { Conversation, PlanEntry, PlanItem } from "../model/index.ts";
import { useI18n } from "./i18n.tsx";
import { CheckIcon, ChevronRightIcon } from "./icons.tsx";
import { useAppStore } from "./store-context.tsx";

/** The plan's entries, each with its mark: empty to do, half going, a check done. */
export function PlanList({ entries }: { entries: readonly PlanEntry[] }) {
  const { t } = useI18n();
  return (
    <ol data-slot="plan" aria-label={t("plan.label")}>
      {entries
        .map((entry, index) => ({ entry, key: `${index}:${entry.content}` }))
        .map(({ entry, key }) => (
          <li key={key} data-status={entry.status}>
            <span data-slot="plan-mark" data-status={entry.status} aria-hidden="true">
              {entry.status === "completed" ? <CheckIcon size={12} /> : null}
            </span>
            <span>{entry.content}</span>
            <span data-slot="visually-hidden">{entry.status.replace("_", " ")}</span>
          </li>
        ))}
    </ol>
  );
}

const doneOf = (entries: readonly PlanEntry[]) =>
  entries.filter((entry) => entry.status === "completed").length;

/**
 * Where the plan was first made, in the conversation: one line, "Plan · 2 of 5 done", that opens to the list. The plan
 * is one for the session and changes in place, so the line always says how it stands now; the strip above the input
 * box is where it is followed.
 */
export function PlanBlock({ item }: { item: PlanItem }) {
  const { t } = useI18n();
  const done = doneOf(item.entries);
  return (
    <Collapsible data-kind="plan">
      <CollapsibleTrigger>
        {/* Laid out as a tool's line, so the eye runs down one edge: an empty place where a call's state would be. */}
        <span data-slot="tool-lead" aria-hidden="true" />
        <span data-slot="tool-verb">{t("plan.label")}</span>{" "}
        <span data-slot="tool-facts">
          {t("plan.progress", { done, count: item.entries.length })}
        </span>{" "}
        <ChevronRightIcon size={12} data-slot="tool-chevron" aria-hidden="true" />
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <PlanList entries={item.entries} />
      </CollapsiblePanel>
    </Collapsible>
  );
}

/** The session's plan while some of it is still to do: the newest plan item, if any of its entries is not done. */
export const currentPlan = (conversation: Conversation): PlanItem | undefined => {
  const plan = conversation.items.findLast((item): item is PlanItem => item.kind === "plan");
  return plan !== undefined && plan.entries.some((entry) => entry.status !== "completed")
    ? plan
    : undefined;
};

/**
 * The plan above the input box, while there is some of it to do: how far along it is and what is being done now, one
 * line that opens to the list. It goes when everything in it is done.
 */
export function PlanStrip({ plan }: { plan: PlanItem }) {
  const { t } = useI18n();
  const store = useAppStore();
  const done = doneOf(plan.entries);
  const now =
    plan.entries.find((entry) => entry.status === "in_progress") ??
    plan.entries.find((entry) => entry.status !== "completed");
  return (
    <Collapsible
      data-kind="plan-strip"
      onOpenChange={(open) => {
        if (open) store.track("plan_opened", {});
      }}
    >
      <CollapsibleTrigger>
        <span data-slot="plan-count">{t("plan.count", { done, count: plan.entries.length })}</span>{" "}
        <span data-slot="plan-now">{now?.content ?? ""}</span>{" "}
        <ChevronRightIcon size={12} data-slot="tool-chevron" aria-hidden="true" />
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <PlanList entries={plan.entries} />
      </CollapsiblePanel>
    </Collapsible>
  );
}
