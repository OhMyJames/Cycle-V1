import { Button } from "@ui-sdk/react/button";
import type { PermissionRequest } from "../api.ts";

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
  onAnswer: (key: string, optionId: string | "cancelled") => void | Promise<void>;
};

export function PermissionCard({ request, onAnswer }: PermissionCardProps) {
  const detail = describeSubject(request.subject);
  return (
    <section data-slot="permission" aria-label={request.title}>
      <div data-slot="permission-title">{request.title}</div>
      {detail !== "" ? <pre data-slot="permission-detail">{detail}</pre> : null}
      <div data-slot="permission-actions">
        {request.options.map((option) => (
          <Button
            key={option.optionId}
            data-variant={option.kind.startsWith("allow") ? "solid" : "outline"}
            onClick={() => onAnswer(request.key, option.optionId)}
          >
            {option.name}
          </Button>
        ))}
        <Button data-variant="ghost" onClick={() => onAnswer(request.key, "cancelled")}>
          Dismiss
        </Button>
      </div>
    </section>
  );
}
