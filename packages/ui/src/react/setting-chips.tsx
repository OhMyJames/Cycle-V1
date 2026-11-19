// The session's settings that are a choice (the permission mode, the model), at hand in the composer: what the agent does
// next is decided where the next message is written. Read from the agent's own schema, so nothing here knows Claude.
import {
  Menu,
  MenuContent,
  MenuGroupLabel,
  MenuItemIndicator,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "@ui-sdk/react/menu";
import { optionsOf, propertiesOf } from "./config-form.tsx";
import { useI18n } from "./i18n.tsx";
import { ChevronDownIcon } from "./icons.tsx";

export type SettingsOf = {
  /** The agent's `configSchema`. */
  schema: Record<string, unknown>;
  /** What the session has: a setting with no value is not shown as today's default, which it may not have. */
  value: Record<string, string>;
};

export function SettingChips({
  settings,
  disabled,
  onSet,
}: {
  settings: SettingsOf;
  disabled: boolean;
  onSet: (key: string, value: string) => void;
}) {
  const { t } = useI18n();
  return propertiesOf(settings.schema).map(([key, property]) => {
    const options = optionsOf(property);
    if (options === undefined || options.length === 0) return null;
    const title = property.title ?? key;
    const current = settings.value[key];
    const label = options.find((o) => o.value === current)?.label ?? t("config.notSet");
    const name = t("composer.setting", { setting: title, value: label });
    return (
      <Menu key={key}>
        <MenuTrigger
          data-variant="ghost"
          data-kind="setting-chip"
          data-unset={current === undefined || undefined}
          disabled={disabled}
          aria-label={name}
          title={name}
        >
          <span data-slot="setting-value">{label}</span>
          <ChevronDownIcon size={12} />
        </MenuTrigger>
        <MenuContent side="top" align="start">
          <MenuRadioGroup
            value={current ?? null}
            onValueChange={(next) => {
              if (typeof next === "string" && next !== current) onSet(key, next);
            }}
          >
            <MenuGroupLabel>{title}</MenuGroupLabel>
            {options.map((o) => (
              <MenuRadioItem key={o.value} value={o.value} closeOnSelect>
                <MenuItemIndicator />
                <span data-slot="option">
                  <span data-slot="option-name">
                    {o.label}
                    {o.recommended ? (
                      <span data-slot="option-tag">{t("config.recommended")}</span>
                    ) : null}
                  </span>
                  {o.description ? (
                    <span data-slot="option-description">{o.description}</span>
                  ) : null}
                </span>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuContent>
      </Menu>
    );
  });
}
