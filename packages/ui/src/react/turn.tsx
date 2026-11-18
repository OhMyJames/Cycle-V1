import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@ui-sdk/react/collapsible";
import {
  activityCounts,
  activityOf,
  type Conversation,
  isLive,
  type StopReason,
  stepOf,
  type ToolItem,
} from "../model/index.ts";
import { useI18n } from "./i18n.tsx";
import { ErrorCircleIcon, ToolIcon, WarningIcon } from "./icons.tsx";
import { ToolCard, ToolStatus, toolSummary } from "./tool.tsx";

/** A notice from the daemon or the agent, in the conversation. */
export function Notice({ severity, title }: { severity: string; title: string }) {
  return (
    <div role="status" data-slot="notice" data-severity={severity}>
      {severity === "error" ? <ErrorCircleIcon size={14} /> : null}
      {title}
    </div>
  );
}

/**
 * The tool calls of one stretch. One call is a row of its own; two or more are a card that says what they were in a line
 * (and, while one is going, which), and opens to the rows. A card with a failure starts open: that is what the person
 * came to read.
 */
export function WorkBlock({ tools, live }: { tools: readonly ToolItem[]; live: boolean }) {
  const { t, list, locale } = useI18n();
  const only = tools[0];
  if (tools.length === 1 && only !== undefined) return <ToolCard tool={only} />;
  const failed = tools.filter((tool) => tool.status === "failed").length;
  const going = live ? tools.findLast(isLive) : undefined;
  // The pieces are written to follow one another ("ran 2 commands"), and the line begins as a sentence does.
  const pieces = list(
    activityCounts(tools).map(({ activity, count }) => t(`work.summary.${activity}`, { count })),
  );
  const summary = pieces.charAt(0).toLocaleUpperCase(locale) + pieces.slice(1);
  const status = failed > 0 ? "failed" : going !== undefined ? "in_progress" : "completed";
  return (
    <Collapsible data-kind="work" data-status={status} defaultOpen={failed > 0}>
      <CollapsibleTrigger>
        <ToolIcon size={14} data-slot="tool-icon" />
        <span data-slot="work-summary">{summary}</span>
        {going !== undefined ? (
          <span data-slot="tool-summary">{toolSummary(going)}</span>
        ) : (
          <span data-slot="tool-summary" />
        )}
        <ToolStatus status={status} />
        {failed > 0 ? (
          <span data-slot="tool-status">{t("work.failed", { count: failed })}</span>
        ) : going !== undefined ? (
          <span data-slot="tool-status">{t("work.running")}</span>
        ) : (
          <span data-slot="visually-hidden">{t("work.done")}</span>
        )}
      </CollapsibleTrigger>
      <CollapsiblePanel>
        {tools.map((tool) => (
          <ToolCard key={tool.id} tool={tool} />
        ))}
      </CollapsiblePanel>
    </Collapsible>
  );
}

const ENDS: Record<string, string> = {
  cancelled: "turn.end.cancelled",
  max_tokens: "turn.end.maxTokens",
  max_turn_requests: "turn.end.maxTurnRequests",
  refusal: "turn.end.refusal",
};

/** How a turn that did not end normally ended: a colour, a shape and a sentence. */
export function EndBlock({ stop }: { stop: StopReason }) {
  const { t } = useI18n();
  if (stop.stopReason === "error") {
    const message = stop.error?.message;
    return (
      <div data-slot="notice" data-severity="error" role="alert">
        <ErrorCircleIcon size={14} />
        <span>{message ? t("turn.end.errorWith", { message }) : t("turn.end.error")}</span>
      </div>
    );
  }
  const key = ENDS[stop.stopReason];
  return (
    <div data-slot="notice" data-severity="warning" role="status">
      <WarningIcon size={14} />
      <span>{key !== undefined ? t(key) : t("turn.end.other", { reason: stop.stopReason })}</span>
    </div>
  );
}

/** What the agent is doing, at the end of the turn that is going, so a hidden thought or a long tool is not a silence. */
export function StepLine({ conversation }: { conversation: Conversation }) {
  const { t } = useI18n();
  const step = stepOf(conversation);
  if (step === undefined) return null;
  const words =
    step.kind === "approval"
      ? t("step.approval")
      : step.kind === "thinking"
        ? t("step.thinking")
        : step.kind === "working"
          ? t("step.working")
          : activityOf(step.tool) === "other"
            ? t("step.other", { name: step.tool.name ?? t("tool.unnamed") })
            : t(`step.${activityOf(step.tool)}`);
  return (
    <div data-slot="step" data-step={step.kind}>
      {step.kind === "approval" ? (
        <WarningIcon size={14} />
      ) : (
        <span data-slot="spinner" aria-hidden="true" />
      )}
      <span>{words}</span>
      {step.kind === "tool" ? <span data-slot="step-detail">{toolSummary(step.tool)}</span> : null}
    </div>
  );
}
