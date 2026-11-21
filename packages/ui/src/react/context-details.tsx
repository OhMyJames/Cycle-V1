// What the context ring opens into: how much of the window is used, and, when the agent counted them, what is in it
// (docs/protocol.md §8, `_meta["cycle/context"]`). Numbers only; a line of words only for a state that has no number:
// nothing reported yet, a compaction running, or a usage from before the last compaction. Under it, the account's plan
// limits when its agent told them (docs/protocol.md §8 "套餐用量").
import type { PlanUsage, PlanWindow } from "../api.ts";
import type { ContextPart, ContextState } from "../model/conversation.ts";
import { useI18n } from "./i18n.tsx";

/** The parts Cycle names itself, by the agent's id; any other is shown by the agent's name. */
const PART_NAMES = {
  system_prompt: "composer.context.part.systemPrompt",
  system_tools: "composer.context.part.systemTools",
  mcp_tools: "composer.context.part.mcpTools",
  mcp_instructions: "composer.context.part.mcpInstructions",
  custom_agents: "composer.context.part.agents",
  memory_files: "composer.context.part.memory",
  skills: "composer.context.part.skills",
  messages: "composer.context.part.messages",
  autocompact_buffer: "composer.context.part.autocompactBuffer",
  compact_buffer: "composer.context.part.compactBuffer",
  free_space: "composer.context.part.free",
} as const;

/** The plan limits Cycle shows, in this order; one it does not know by name is not shown. */
const PLAN_NAMES = {
  five_hour: "composer.plan.fiveHour",
  seven_day: "composer.plan.weekly",
  seven_day_opus: "composer.plan.weeklyOpus",
  seven_day_sonnet: "composer.plan.weeklySonnet",
} as const;

/**
 * The plan's limits worth showing at `now`: the ones Cycle names, that have not started over since they were told (what
 * they are at after a reset is not known, so they are not shown as they were).
 */
export const planRowsOf = (plan: PlanUsage | undefined, now: number): PlanWindow[] =>
  plan === undefined
    ? []
    : Object.keys(PLAN_NAMES).flatMap((kind) =>
        plan.windows.filter((w) => w.kind === kind && w.resetsAt > now),
      );

/** How many shades of the accent the used parts go through, largest first; the rest share the last. */
const SHADES = 5;

/**
 * The parts in the window, as rows: what is used, largest first, then what is kept for compaction, then what is free.
 * Parts not loaded into the window (`deferred`) take none of it and are left out.
 */
export const rowsOf = (parts: readonly ContextPart[]): ContextPart[] => [
  ...parts.filter((p) => p.kind === "used").sort((a, b) => b.tokens - a.tokens),
  ...parts.filter((p) => p.kind === "buffer"),
  ...parts.filter((p) => p.kind === "free"),
];

export function ContextDetails({
  context,
  plan,
  percentOf,
  titleId,
}: {
  context: ContextState;
  plan?: PlanUsage | undefined;
  /** The share as the ring says it ("<1%" for a little). */
  percentOf: (share: number) => string;
  /** The id of the title, for what holds the details to be named by it. */
  titleId?: string;
}) {
  const { t, number, date } = useI18n();
  const { usage } = context;
  // Read as the panel opens: a limit that started over meanwhile goes when it is opened again.
  const now = Date.now();
  const limits = planRowsOf(plan, now);
  const resetsOf = (at: number) => {
    const minutes = Math.max(1, Math.ceil((at - now) / 60_000));
    if (minutes < 60) return t("composer.plan.resetsInMinutes", { minutes: number(minutes) });
    if (minutes < 24 * 60)
      return t("composer.plan.resetsInHours", {
        hours: number(Math.floor(minutes / 60)),
        minutes: number(minutes % 60),
      });
    return t("composer.plan.resetsOn", {
      when: date(at, { weekday: "short", hour: "numeric", minute: "2-digit" }),
    });
  };
  const measured = usage !== undefined && usage.size > 0;
  const before = usage?.beforeCompaction === true;
  const short = (amount: number) =>
    number(amount, { notation: "compact", maximumFractionDigits: 1 });
  // A column of figures lines up: thousands each with its one decimal, a few tokens as they are.
  const tokensOf = (amount: number) =>
    amount < 1000
      ? number(amount)
      : number(amount, { notation: "compact", minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const share = (amount: number) => {
    const ratio = measured ? amount / usage.size : 0;
    const percent = (v: number) =>
      number(v, { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 });
    // Something in it that rounds to 0.0% is not nothing.
    return ratio > 0 && 0.0005 > ratio
      ? t("composer.context.underPercent", { percent: percent(0.001) })
      : percent(ratio);
  };
  // The agent names the currency: one Intl does not know is written as given, not thrown on.
  const costOf = (cost: { amount: number; currency: string }) => {
    try {
      return number(cost.amount, {
        style: "currency",
        currency: cost.currency,
        maximumFractionDigits: cost.amount < 0.1 ? 3 : 2,
      });
    } catch {
      return `${number(cost.amount)} ${cost.currency}`;
    }
  };
  const nameOf = (part: ContextPart) => {
    const key = part.id === undefined ? undefined : PART_NAMES[part.id as keyof typeof PART_NAMES];
    return key === undefined ? part.name : t(key);
  };

  // Parts measured before a compaction say nothing of what is in the window now.
  const rows = measured && !before && usage.parts !== undefined ? rowsOf(usage.parts) : [];
  let shade = 0;
  // Keyed by what the part is, and how many like it came before: two parts may share a name.
  const seen = new Map<string, number>();
  const toned = rows.map((part) => {
    const self = `${part.kind}:${part.id ?? part.name}`;
    const before = seen.get(self) ?? 0;
    seen.set(self, before + 1);
    return {
      part,
      key: `${self}:${before}`,
      tone: part.kind === "used" ? String(Math.min(++shade, SHADES)) : part.kind,
    };
  });
  // Without parts the bar is the used share alone.
  const segments = measured
    ? toned.length > 0
      ? toned.filter((r) => r.tone !== "free")
      : [{ part: { name: "", tokens: usage.used, kind: "used" as const }, key: "used", tone: "1" }]
    : [];
  const state = context.compacting
    ? t("composer.context.compacting")
    : !measured
      ? t("composer.context.empty")
      : before
        ? t("composer.context.beforeCompaction")
        : undefined;

  return (
    <div data-slot="context-details">
      <div data-slot="context-head">
        <span id={titleId}>{t("composer.context.title")}</span>
        {measured ? (
          <span data-slot="context-total" data-before={before || undefined}>
            {t("composer.context.total", {
              used: short(usage.used),
              size: short(usage.size),
              percent: percentOf(Math.min(1, usage.used / usage.size)),
            })}
          </span>
        ) : null}
      </div>
      <div data-slot="context-bar" data-before={before || undefined} aria-hidden="true">
        {segments.map(({ part, key, tone }) => (
          <span
            key={key}
            data-slot="context-segment"
            data-tone={tone}
            style={{ flexGrow: part.tokens }}
          />
        ))}
        {measured ? (
          <span
            data-slot="context-segment"
            data-tone="free"
            style={{
              flexGrow: Math.max(
                0,
                usage.size - segments.reduce((sum, { part }) => sum + part.tokens, 0),
              ),
            }}
          />
        ) : null}
      </div>
      {state !== undefined ? (
        <p data-slot="context-state" data-tone={context.compacting ? "attention" : undefined}>
          {state}
        </p>
      ) : null}
      {toned.length > 0 ? (
        <ul data-slot="context-parts" aria-label={t("composer.context.parts")}>
          {toned.map(({ part, key, tone }) => (
            <li key={key} data-slot="context-part">
              <span data-slot="context-swatch" data-tone={tone} aria-hidden="true" />
              <span data-slot="context-part-name">{nameOf(part)}</span>
              <span data-slot="context-part-tokens">{tokensOf(part.tokens)}</span>
              <span data-slot="context-part-share">{share(part.tokens)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {measured &&
      (usage.autoCompactAt !== undefined || usage.cost !== undefined || context.compactions > 0) ? (
        <dl data-slot="context-facts">
          {usage.autoCompactAt !== undefined ? (
            <div>
              <dt>{t("composer.context.autoCompactAt")}</dt>
              <dd>{short(usage.autoCompactAt)}</dd>
            </div>
          ) : null}
          {usage.cost !== undefined ? (
            <div>
              <dt>{t("composer.context.cost")}</dt>
              <dd>{costOf(usage.cost)}</dd>
            </div>
          ) : null}
          {context.compactions > 0 ? (
            <div>
              <dt>{t("composer.context.compactions")}</dt>
              <dd>{number(context.compactions)}</dd>
            </div>
          ) : null}
        </dl>
      ) : null}
      {limits.length > 0 ? (
        <section data-slot="plan-usage" aria-label={t("composer.plan.title")}>
          <div data-slot="context-head">
            <span>{t("composer.plan.title")}</span>
          </div>
          {limits.map((w) => {
            const share = Math.max(0, Math.min(1, w.utilization));
            const tone =
              w.status === "rejected" || share >= 0.9
                ? "danger"
                : w.status === "allowed_warning" || share >= 0.7
                  ? "attention"
                  : undefined;
            return (
              <div key={w.kind} data-slot="plan-limit" data-tone={tone}>
                <div data-slot="plan-limit-row">
                  <span data-slot="plan-limit-name">
                    {t(PLAN_NAMES[w.kind as keyof typeof PLAN_NAMES])}
                  </span>
                  <span data-slot="plan-limit-value">
                    {t("composer.plan.used", {
                      // Down, not to the nearest: 99.6% is not yet at the limit, and does not read as 100%.
                      percent: number(Math.floor(w.utilization * 100) / 100, { style: "percent" }),
                      resets: resetsOf(w.resetsAt),
                    })}
                  </span>
                </div>
                <div data-slot="plan-bar" aria-hidden="true">
                  <span data-slot="plan-bar-fill" style={{ width: `${share * 100}%` }} />
                </div>
              </div>
            );
          })}
        </section>
      ) : null}
    </div>
  );
}
