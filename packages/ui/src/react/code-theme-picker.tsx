import {
  MenuGroupLabel,
  MenuItemIndicator,
  MenuRadioGroup,
  MenuRadioItem,
} from "@ui-sdk/react/menu";
import { useSyncExternalStore } from "react";
import { CODE_THEMES, type CodeThemeId, codeTheme } from "../code-theme.ts";
import { useI18n } from "./i18n.tsx";
import { useAppStore } from "./store-context.tsx";

/**
 * Which colours code is drawn in, as a group of a menu. Applies at once and the menu stays open: the code on screen is
 * the preview, so the arrows and a press can walk through the choices while looking at it.
 */
export function CodeThemeItems() {
  const { t } = useI18n();
  const store = useAppStore();
  const current = useSyncExternalStore(codeTheme.subscribe, codeTheme.get, codeTheme.get);
  return (
    <MenuRadioGroup
      value={current}
      onValueChange={(next) => {
        if (typeof next !== "string") return;
        codeTheme.set(next as CodeThemeId);
        store.track("code_theme_changed", {});
      }}
    >
      <MenuGroupLabel>{t("codeTheme.label")}</MenuGroupLabel>
      {CODE_THEMES.map((theme) => (
        <MenuRadioItem key={theme.id} value={theme.id}>
          <MenuItemIndicator />
          {theme.label}
        </MenuRadioItem>
      ))}
    </MenuRadioGroup>
  );
}
