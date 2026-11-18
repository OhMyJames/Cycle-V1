import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@ui-sdk/react/select";
import { useSyncExternalStore } from "react";
import { CODE_THEMES, type CodeThemeId, codeTheme } from "../code-theme.ts";
import { useI18n } from "./i18n.tsx";

/** Which colours code is drawn in. Applies at once: the code on screen is the preview. */
export function CodeThemePicker() {
  const { t } = useI18n();
  const current = useSyncExternalStore(codeTheme.subscribe, codeTheme.get, codeTheme.get);
  return (
    <div data-slot="code-theme">
      <span data-slot="hint" id="code-theme-label">
        {t("codeTheme.label")}
      </span>
      <Select
        items={CODE_THEMES.map((t) => ({ value: t.id, label: t.label }))}
        value={current}
        onValueChange={(next) => {
          if (typeof next === "string") codeTheme.set(next as CodeThemeId);
        }}
      >
        <SelectTrigger aria-labelledby="code-theme-label">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {CODE_THEMES.map((t) => (
            <SelectItem key={t.id} value={t.id}>
              {t.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
