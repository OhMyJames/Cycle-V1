// The name of a control that has only an icon, shown beside it on hover and on keyboard focus (CYCL-65). The SDK's
// tooltip: it also names the control for a screen reader, so the control carries no aria-label or title of its own.
// It wraps any trigger (a button, a menu's or a popover's) through `render`, which keeps the trigger's own behaviour.
import { Tooltip, TooltipContent, TooltipShortcut, TooltipTrigger } from "@ui-sdk/react/tooltip";
import type { ReactElement } from "react";

export function Tip({
  label,
  shortcut,
  side = "top",
  children,
}: {
  label: string;
  /** The keys that do the same, like `"mod+b"`: shown in the tip and told to a screen reader. It binds nothing. */
  shortcut?: string;
  side?: "top" | "bottom" | "left" | "right";
  /** The control, rendered as the tip's trigger. */
  children: ReactElement<Record<string, unknown>>;
}) {
  return (
    <Tooltip type="label" {...(shortcut !== undefined ? { shortcut } : {})}>
      <TooltipTrigger render={children} />
      <TooltipContent side={side} sideOffset={6} collisionPadding={8}>
        {label}
        {shortcut !== undefined ? <TooltipShortcut /> : null}
      </TooltipContent>
    </Tooltip>
  );
}
