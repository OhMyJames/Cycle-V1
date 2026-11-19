import { Button } from "@ui-sdk/react/button";
import type { PermissionRequest } from "../api.ts";
import { useI18n } from "./i18n.tsx";
import { WarningIcon } from "./icons.tsx";
import { MOD } from "./sidebar.tsx";

/** What the agent wants to do, as the request says it. Text only: it is the agent's word. */
export const describeSubject = (subject: unknown): string => {
  const subjectObject = (subject ?? {}) as Record<string, unknown>;
  const call = (subjectObject.toolCall ?? subjectObject) as Record<string, unknown>;
  const input = (call.rawInput ?? {}) as Record<string, unknown>;
  const detail = ["command", "file_path", "path", "url", "pattern"]
    .map((key) => input[key])
    .find((value): value is string => typeof value === "string");
  const name = typeof call.name === "string" ? call.name : "";
  return [name, detail].filter(Boolean).join(": ");
};

export type PermissionCardProps = {
  request: PermissionRequest;
  disabled: boolean;
  onAnswer: (key: string, optionId: string | "cancelled") => void | Promise<void>;
};

export function PermissionCard({ request, disabled, onAnswer }: PermissionCardProps) {
  const { t } = useI18n();
  const detail = describeSubject(request.subject);
  return (
    <section data-slot="permission" aria-label={request.title}>
      <div data-slot="permission-title">
        <WarningIcon size={16} />
        {request.title}
      </div>
      {detail !== "" ? <pre data-slot="permission-detail">{detail}</pre> : null}
      <div data-slot="permission-actions">
        {request.options.map((option) => {
          const allowOnce = option.kind === "allow_once";
          const label = allowOnce ? option.name : undefined;
          const tip = allowOnce ? `${option.name} (${MOD}↩)` : undefined;
          return (
            <Button
              key={option.optionId}
              // One main answer: allowing once. The rest are quieter, so that the strong one is not a default to click through.
              data-variant={allowOnce ? "solid" : "outline"}
              aria-label={label}
              title={tip}
              disabled={disabled}
              onClick={() => onAnswer(request.key, option.optionId)}
            >
              {option.name}
              {allowOnce ? <kbd>{MOD}↩</kbd> : null}
            </Button>
          );
        })}
        <Button
          data-variant="ghost"
          data-kind="permission-dismiss"
          disabled={disabled}
          onClick={() => onAnswer(request.key, "cancelled")}
        >
          {t("permission.dismiss")}
        </Button>
      </div>
    </section>
  );
}
