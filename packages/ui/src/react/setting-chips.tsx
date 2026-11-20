// The session's settings that are a choice (the permission mode, the model and its reasoning effort), at hand in the
// composer utility bar: what the agent does next is decided where the next message is written. Read from the agent's
// own schema, so nothing here knows Claude.
// Each opens the utility bar's popover (`anchored-popover.tsx`): a short list that is read at a glance, so no filter.
// The effort is a chip of its own beside the model's, offering only the levels that model takes. It shows what the
// session has, never a value it was asked for and may not get: a change shows when the agent has made it.
import { isComposing } from "@ui-sdk/core";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { AnchoredPopover } from "./anchored-popover.tsx";
import { type Option, OptionLabel, optionsOf, propertiesOf } from "./config-form.tsx";
import { useI18n } from "./i18n.tsx";
import { CheckIcon, ChevronDownIcon, ShieldAlertIcon, ShieldIcon } from "./icons.tsx";

export type SettingsOf = {
  /** The agent's `configSchema`. */
  schema: Record<string, unknown>;
  /** What the session has: a setting with no value is not shown as today's default, which it may not have. */
  value: Record<string, string>;
};

function SettingPickerChip({
  settingKey,
  heading,
  options,
  current,
  valueLabel,
  compact = false,
  align = "start",
  disabled,
  onSet,
}: {
  settingKey: string;
  heading: string;
  options: readonly Option[];
  current: string | undefined;
  /** What the chip says for the current value, when not the option's own label. */
  valueLabel?: string | undefined;
  /** Compact mode omits option descriptions inside the list (the model's and the effort's: read by name). */
  compact?: boolean;
  align?: "start" | "end";
  disabled: boolean;
  onSet: SetSetting;
}) {
  const { t } = useI18n();
  const pickerId = useId();
  const listId = `${pickerId}-list`;
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  /** The highlight was moved by the pointer: the list is not scrolled to it. */
  const pointedRef = useRef(false);

  const chosen = current === undefined ? undefined : options.find((o) => o.value === current);
  // A value the schema does not list (a model named in full, say) is still what the session runs on: it is shown as it is.
  const named = current === undefined ? t("config.notSet") : (chosen?.label ?? current);
  const label = current === undefined ? named : (valueLabel ?? named);
  const name = t("composer.setting", { setting: heading, value: named });
  // What was last asked for and is not the session's yet. Not shown (the chip says what the session has), but it is
  // what a choice is measured against: asking again for it sends nothing, and going back to the session's value while
  // it is on its way sends that, so the last choice is the one that lands.
  const [asked, setAsked] = useState<string | undefined>(undefined);
  const [seen, setSeen] = useState(current);
  if (seen !== current) {
    // The session's value moved: what was asked is answered, or overtaken.
    setSeen(current);
    setAsked(undefined);
  }

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  const openMenu = () => {
    if (disabled) return;
    const selectedIndex = current === undefined ? 0 : options.findIndex((o) => o.value === current);
    pointedRef.current = false;
    setHighlighted(Math.max(selectedIndex, 0));
    setOpen(true);
  };

  const choose = (option: Option) => {
    if (option.value !== (asked ?? current)) {
      const value = option.value;
      setAsked(value);
      // Settled with no change (refused, say): nothing is on its way any more, so the same choice can be made again.
      void Promise.resolve(onSet(settingKey, value)).finally(() =>
        setAsked((now) => (now === value ? undefined : now)),
      );
    }
    close(true);
  };

  useEffect(() => {
    if (disabled && open) setOpen(false);
  }, [disabled, open]);

  // The list takes the focus as it opens, however it was opened: arrows then move in it at once.
  useEffect(() => {
    if (open) listRef.current?.focus();
  }, [open]);

  const count = options.length;
  const activeIndex = count === 0 ? -1 : Math.min(highlighted, count - 1);
  const optionId = (index: number) => `${pickerId}-opt-${index}`;
  const activeOptionId = activeIndex >= 0 ? optionId(activeIndex) : undefined;

  useEffect(() => {
    if (!open || activeIndex < 0 || pointedRef.current) return;
    const item = listRef.current?.querySelector<HTMLElement>(
      `[data-slot="setting-option"]:nth-of-type(${activeIndex + 1})`,
    );
    item?.scrollIntoView?.({ block: "nearest" });
  }, [open, activeIndex]);

  const move = (index: number) => {
    pointedRef.current = false;
    setHighlighted(index);
    listRef.current?.focus();
  };

  const onPopoverKeyDown = (event: React.KeyboardEvent) => {
    if (isComposing(event.nativeEvent)) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    // Nothing else in it to go to: Tab leaves, and closes it.
    if (event.key === "Tab") {
      close(false);
      return;
    }
    if (count === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      move((activeIndex + 1) % count);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      move((activeIndex - 1 + count) % count);
    } else if (event.key === "Home") {
      event.preventDefault();
      move(0);
    } else if (event.key === "End") {
      event.preventDefault();
      move(count - 1);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const target = options[activeIndex];
      if (target !== undefined) choose(target);
    }
  };

  const onTriggerKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    // Open, or already open with the focus back on the chip: either way the arrows go to the list.
    if (open) listRef.current?.focus();
    else openMenu();
  };

  const popover = (
    <AnchoredPopover
      open={open}
      anchorRef={triggerRef}
      ownerRef={rootRef}
      popoverRef={popoverRef}
      align={align}
      onDismiss={close}
      compact={compact}
      // A press in the list keeps the focus where it is, so the list's keys keep working.
      onMouseDown={(event) => event.preventDefault()}
      onKeyDown={onPopoverKeyDown}
    >
      <div data-slot="setting-popover-head">{heading}</div>
      <div
        ref={listRef}
        id={listId}
        role="menu"
        aria-label={heading}
        {...(activeOptionId !== undefined ? { "aria-activedescendant": activeOptionId } : {})}
        tabIndex={-1}
        data-slot="setting-list"
      >
        {options.map((option, index) => {
          const selected = option.value === current;
          const active = index === activeIndex;
          const displayOption = compact ? { ...option, description: undefined } : option;
          return (
            <button
              key={option.value}
              id={optionId(index)}
              type="button"
              role="menuitemradio"
              aria-checked={selected}
              tabIndex={-1}
              data-slot="setting-option"
              data-active={active || undefined}
              data-selected={selected || undefined}
              data-danger={option.danger || undefined}
              title={option.description}
              onMouseEnter={() => {
                pointedRef.current = true;
                setHighlighted(index);
              }}
              onClick={() => choose(option)}
            >
              <span data-slot="setting-option-body">
                <OptionLabel option={displayOption} />
              </span>
              {selected ? (
                <span data-slot="setting-check" aria-hidden="true">
                  <CheckIcon size={13} />
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </AnchoredPopover>
  );

  const leadingIcon =
    settingKey === "mode" ? (
      chosen?.danger ? (
        <ShieldAlertIcon size={13} data-slot="setting-icon" aria-hidden="true" />
      ) : (
        <ShieldIcon size={13} data-slot="setting-icon" aria-hidden="true" />
      )
    ) : null;

  return (
    <div ref={rootRef} data-slot="setting-picker">
      <button
        ref={triggerRef}
        type="button"
        data-slot="button"
        data-variant="ghost"
        data-kind="setting-chip"
        data-setting={settingKey}
        data-unset={current === undefined || undefined}
        data-danger={chosen?.danger || undefined}
        data-open={open || undefined}
        data-disabled={disabled || undefined}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={name}
        title={name}
        onClick={() => (open ? close(false) : openMenu())}
        onKeyDown={onTriggerKeyDown}
      >
        {leadingIcon}
        <span data-slot="setting-value">{label}</span>
        <ChevronDownIcon
          size={12}
          data-slot="setting-chevron"
          data-open={open || undefined}
          aria-hidden="true"
        />
      </button>
      {popover}
    </div>
  );
}

/** Asks for a setting; what it returns, if anything, settles when the asking is over. */
export type SetSetting = (key: string, value: string) => unknown;

type ChoiceEntry = {
  key: string;
  heading: string;
  options: Option[];
  current: string | undefined;
};

/**
 * The effort levels a model takes, from its `cycle/efforts` (docs/protocol.md §10): `undefined` when the model does not
 * say, so every level stays; `[]` when it takes none.
 */
const effortsFor = (models: readonly Option[], model: string | undefined) =>
  model === undefined ? undefined : models.find((m) => m.value === model)?.efforts;

export function SettingChips({
  settings,
  disabled,
  onSet,
  side = "all",
}: {
  settings: SettingsOf;
  disabled: boolean;
  onSet: SetSetting;
  /** Partition settings across the composer utility bar: permission/other on the left, model and effort on the right. */
  side?: "left" | "right" | "all";
}) {
  const { t } = useI18n();
  const entries: ChoiceEntry[] = [];
  for (const [key, property] of propertiesOf(settings.schema)) {
    const options = optionsOf(property);
    if (options === undefined || options.length === 0) continue;
    entries.push({
      key,
      heading: property.title ?? key,
      options,
      current: settings.value[key],
    });
  }
  const modelEntry = entries.find((entry) => entry.key === "model");
  // The effort is the model's second word: right after it, wherever the schema lists it.
  const effortAt = entries.findIndex((entry) => entry.key === "effort");
  if (modelEntry !== undefined && effortAt >= 0) {
    const [effort] = entries.splice(effortAt, 1);
    if (effort !== undefined) entries.splice(entries.indexOf(modelEntry) + 1, 0, effort);
  }
  // The levels the chosen model takes; a model that takes none has no effort to show.
  const levels =
    modelEntry !== undefined ? effortsFor(modelEntry.options, modelEntry.current) : undefined;

  return entries.map((entry) => {
    const isRight = entry.key === "model" || entry.key === "effort";
    if (side === "left" && isRight) return null;
    if (side === "right" && !isRight) return null;
    let options = entry.options;
    let valueLabel: string | undefined;
    if (entry.key === "effort" && modelEntry !== undefined) {
      if (levels !== undefined)
        options = options.filter(
          // The level in force stays shown until the agent says otherwise, rather than reading "Not set".
          (o) => o.value === "default" || levels.includes(o.value) || o.value === entry.current,
        );
      if (options.length <= 1) return null;
      // `default` is no level: the model's own, which the agent does not name (docs/protocol.md §10).
      options = options.map((o) =>
        o.value === "default" ? { ...o, label: t("composer.effort.modelDefault") } : o,
      );
      if (entry.current === "default") valueLabel = t("composer.effort.chip");
    }
    return (
      <SettingPickerChip
        key={entry.key}
        settingKey={entry.key}
        heading={entry.heading}
        options={options}
        current={entry.current}
        valueLabel={valueLabel}
        // The model and its effort are read by name; what a level does is in its title.
        compact={isRight}
        align={side === "right" ? "end" : "start"}
        disabled={disabled}
        onSet={onSet}
      />
    );
  });
}
