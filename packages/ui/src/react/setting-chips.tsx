// The session's settings that are a choice (the permission mode, the model and its reasoning effort), at hand in the
// composer utility bar: what the agent does next is decided where the next message is written. Read from the agent's
// own schema, so nothing here knows Claude.
// Each opens the utility bar's popover (`anchored-popover.tsx`): a short list that is read at a glance, so no filter,
// and the model's effort as a slider under the models, showing only the levels that model takes.
import { isComposing } from "@ui-sdk/core";
import { motion, useReducedMotion } from "motion/react";
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

export type SecondarySetting = {
  key: string;
  heading: string;
  options: readonly Option[];
  current: string | undefined;
};

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/**
 * Draggable discrete slider for reasoning effort (or any paired ordered setting), with elastic spring snap,
 * pointer-capture scrubbing (plus window fallback), optimistic commit, clickable stops, and native
 * `<input type="range">` keyboard/screen-reader semantics.
 */
function EffortSlider({
  setting,
  reduced,
  inputRef,
  onSelect,
  onFocusChange,
}: {
  setting: SecondarySetting;
  reduced: boolean;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onSelect: (value: string) => void;
  onFocusChange: (focused: boolean) => void;
}) {
  const { t } = useI18n();
  const count = setting.options.length;
  const max = Math.max(count - 1, 1);
  const selectedIndex =
    setting.current === undefined
      ? -1
      : setting.options.findIndex((o) => o.value === setting.current);
  const trackRef = useRef<HTMLDivElement>(null);
  const activePointerId = useRef<number | null>(null);
  const [dragRatio, setDragRatio] = useState<number | null>(null);
  const [pending, setPending] = useState<{
    current: string | undefined;
    count: number;
    index: number;
  } | null>(null);
  const dragging = dragRatio !== null;
  const pendingIndex =
    pending !== null && pending.current === setting.current && pending.count === count
      ? pending.index
      : null;

  const effectiveIndex = pendingIndex !== null ? Math.min(pendingIndex, max) : selectedIndex;
  const isUnset = !dragging && effectiveIndex < 0;
  const committedIndex = Math.max(effectiveIndex, 0);
  const liveIndex = dragRatio !== null ? Math.round(dragRatio * max) : committedIndex;
  const displayOption = setting.options[liveIndex];
  // `default` is no level: the model's own, which the agent does not name (docs/protocol.md §10).
  const displayLabel = isUnset
    ? t("config.notSet")
    : displayOption?.value === "default"
      ? t("composer.effort.modelDefault")
      : (displayOption?.label ?? "");
  const ratio = dragRatio ?? (count > 1 && !isUnset ? committedIndex / max : 0);
  const isEnergized = !isUnset && liveIndex > 0;

  const ratioFromClientX = useCallback((clientX: number): number => {
    const track = trackRef.current;
    if (track === null) return 0;
    const rect = track.getBoundingClientRect();
    // Account for half-thumb inset (8px each side) so dragging to either end hits 0% and 100% smoothly.
    const pad = 8;
    const usable = Math.max(rect.width - pad * 2, 1);
    return clamp01((clientX - rect.left - pad) / usable);
  }, []);

  const commitIndex = useCallback(
    (index: number) => {
      const opt = setting.options[index];
      if (opt === undefined) return;
      if (opt.value !== setting.current) {
        setPending({ current: setting.current, count, index });
        onSelect(opt.value);
      }
    },
    [setting.options, setting.current, count, onSelect],
  );

  const cleanupFallback = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => cleanupFallback.current?.(), []);

  const finishDrag = useCallback(
    (clientX: number, target?: HTMLDivElement | null, pointerId?: number) => {
      if (activePointerId.current === null) return;
      if (pointerId !== undefined && pointerId !== activePointerId.current) return;
      const capturedId = activePointerId.current;
      activePointerId.current = null;
      cleanupFallback.current?.();
      cleanupFallback.current = undefined;
      try {
        if (target?.hasPointerCapture?.(capturedId)) {
          target.releasePointerCapture(capturedId);
        }
      } catch {
        // Ignore release errors when capture was already lost or unavailable.
      }
      const nextIndex = Math.round(ratioFromClientX(clientX) * max);
      setDragRatio(null);
      commitIndex(nextIndex);
    },
    [commitIndex, max, ratioFromClientX],
  );

  const cancelDrag = useCallback(() => {
    activePointerId.current = null;
    cleanupFallback.current?.();
    cleanupFallback.current = undefined;
    setDragRatio(null);
  }, []);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || count <= 1) return;
    event.preventDefault();
    activePointerId.current = event.pointerId;
    const target = event.currentTarget;
    let captured = false;
    try {
      if (typeof target.setPointerCapture === "function") {
        target.setPointerCapture(event.pointerId);
        captured = true;
      }
    } catch {
      captured = false;
    }
    if (!captured) {
      const onWindowMove = (e: PointerEvent) => {
        if (e.pointerId !== activePointerId.current) return;
        setDragRatio(ratioFromClientX(e.clientX));
      };
      const onWindowUp = (e: PointerEvent) => {
        finishDrag(e.clientX, target, e.pointerId);
      };
      const onWindowCancel = (e: PointerEvent) => {
        if (e.pointerId === activePointerId.current) cancelDrag();
      };
      window.addEventListener("pointermove", onWindowMove);
      window.addEventListener("pointerup", onWindowUp);
      window.addEventListener("pointercancel", onWindowCancel);
      cleanupFallback.current = () => {
        window.removeEventListener("pointermove", onWindowMove);
        window.removeEventListener("pointerup", onWindowUp);
        window.removeEventListener("pointercancel", onWindowCancel);
      };
    }
    inputRef.current?.focus();
    setDragRatio(ratioFromClientX(event.clientX));
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging || event.pointerId !== activePointerId.current) return;
    setDragRatio(ratioFromClientX(event.clientX));
  };

  const springTransition = reduced
    ? { duration: 0 }
    : dragging
      ? { type: "spring" as const, stiffness: 900, damping: 46, mass: 0.35 }
      : { type: "spring" as const, stiffness: 460, damping: 26, mass: 0.72 };

  return (
    <div data-slot="setting-section">
      <div data-slot="effort-head">
        <span data-slot="setting-section-head">{setting.heading}</span>
        <span data-slot="effort-value" data-active={isEnergized || undefined}>
          {displayLabel}
        </span>
      </div>
      <div
        ref={trackRef}
        data-slot="effort-slider"
        data-dragging={dragging || undefined}
        data-energized={isEnergized || undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(event) => finishDrag(event.clientX, event.currentTarget, event.pointerId)}
        onPointerCancel={cancelDrag}
        onLostPointerCapture={() => {
          if (activePointerId.current !== null) cancelDrag();
        }}
      >
        <input
          ref={inputRef}
          type="range"
          min={0}
          max={Math.max(count - 1, 0)}
          step={1}
          value={committedIndex}
          aria-label={setting.heading}
          aria-valuetext={displayLabel}
          data-slot="visually-hidden"
          onFocus={() => onFocusChange(true)}
          onBlur={() => onFocusChange(false)}
          onChange={(event) => commitIndex(Number(event.currentTarget.value))}
        />
        <motion.div
          data-slot="effort-fill"
          aria-hidden="true"
          animate={{ width: `calc(8px + (100% - 16px) * ${ratio})` }}
          transition={springTransition}
        />
        <div data-slot="effort-dots" aria-hidden="true">
          {setting.options.map((opt, idx) => (
            <span
              key={opt.value}
              data-slot="effort-dot"
              data-passed={(!isUnset && idx <= liveIndex) || undefined}
            />
          ))}
        </div>
        <motion.div
          data-slot="effort-thumb"
          aria-hidden="true"
          animate={{
            left: `calc(8px + (100% - 16px) * ${ratio})`,
            scale: dragging ? 1.14 : 1,
          }}
          transition={springTransition}
        />
      </div>
      <div
        data-slot="effort-ticks"
        style={{ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))` }}
      >
        {setting.options.map((opt, idx) => (
          <button
            key={opt.value}
            type="button"
            tabIndex={-1}
            data-slot="effort-tick"
            data-selected={(!isUnset && idx === liveIndex) || undefined}
            title={opt.description}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              inputRef.current?.focus();
              commitIndex(idx);
            }}
          >
            {opt.value === "default" ? t("composer.effort.tickDefault") : opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function SettingPickerChip({
  settingKey,
  heading,
  options,
  current,
  secondary,
  compact = false,
  align = "start",
  disabled,
  onChoose,
  onSet,
}: {
  settingKey: string;
  heading: string;
  options: readonly Option[];
  current: string | undefined;
  secondary?: SecondarySetting | undefined;
  /** Compact mode omits option descriptions inside the list (used for Model picker). */
  compact?: boolean;
  align?: "start" | "end";
  disabled: boolean;
  /** A choice in the list; the caller may set more than this one setting (the model's effort). */
  onChoose?: (option: Option) => void;
  onSet: (key: string, value: string) => void;
}) {
  const { t } = useI18n();
  const reduced = Boolean(useReducedMotion());
  const pickerId = useId();
  const popoverId = `${pickerId}-popover`;
  const listId = `${pickerId}-list`;
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const [sliderFocused, setSliderFocused] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const secondaryWrapRef = useRef<HTMLDivElement>(null);
  const sliderInputRef = useRef<HTMLInputElement>(null);
  const navOriginRef = useRef<"init" | "keyboard" | "pointer">("init");

  const chosen = current === undefined ? undefined : options.find((o) => o.value === current);
  // A value the schema does not list (a model named in full, say) is still what the session runs on: it is shown as it is.
  const label = current === undefined ? t("config.notSet") : (chosen?.label ?? current);
  const secondaryChosen =
    secondary?.current === undefined
      ? undefined
      : secondary.options.find((o) => o.value === secondary.current);
  const secondaryLabel =
    secondary?.current === undefined ? undefined : (secondaryChosen?.label ?? secondary.current);
  const showSecondaryBadge =
    secondary !== undefined &&
    secondary.current !== undefined &&
    secondary.current !== "default" &&
    secondaryLabel !== undefined;
  const primaryName = t("composer.setting", { setting: heading, value: label });
  const name = showSecondaryBadge
    ? t("composer.settingPair", {
        first: primaryName,
        second: t("composer.setting", { setting: secondary.heading, value: secondaryLabel }),
      })
    : primaryName;

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    setSliderFocused(false);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  const openMenu = () => {
    if (disabled) return;
    const selectedIndex = current === undefined ? 0 : options.findIndex((o) => o.value === current);
    navOriginRef.current = "init";
    setSliderFocused(false);
    setHighlighted(Math.max(selectedIndex, 0));
    setOpen(true);
  };

  const choose = (option: Option) => {
    if (option.value !== current) {
      if (onChoose !== undefined) onChoose(option);
      else onSet(settingKey, option.value);
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
  const listActiveIndex = sliderFocused ? -1 : activeIndex;
  const optionId = (index: number) => `${pickerId}-opt-${index}`;
  const activeOptionId = listActiveIndex >= 0 ? optionId(listActiveIndex) : undefined;

  useEffect(() => {
    if (!open || listActiveIndex < 0 || navOriginRef.current === "pointer") return;
    const item = listRef.current?.querySelector<HTMLElement>(
      `[data-slot="setting-option"]:nth-of-type(${listActiveIndex + 1})`,
    );
    item?.scrollIntoView?.({ block: "nearest" });
  }, [open, listActiveIndex]);

  const move = (index: number) => {
    navOriginRef.current = "keyboard";
    setSliderFocused(false);
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
    const inSecondary =
      event.target instanceof Node && Boolean(secondaryWrapRef.current?.contains(event.target));
    if (event.key === "Tab") {
      // Tab goes between the list and the effort slider; with nothing else in it, it leaves and closes.
      if (secondary === undefined) {
        close(false);
        return;
      }
      event.preventDefault();
      if (inSecondary) listRef.current?.focus();
      else sliderInputRef.current?.focus();
      return;
    }
    // The slider's own arrows set the effort.
    if (inSecondary || count === 0) return;
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
      {...(secondary !== undefined
        ? { id: popoverId, role: "dialog" as const, label: heading }
        : {})}
      compact={compact}
      onMouseDown={(event) => {
        const target = event.target;
        if (target instanceof Node && secondaryWrapRef.current?.contains(target)) return;
        // A press in the list keeps the focus where it is, so the list's keys keep working.
        event.preventDefault();
      }}
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
          const active = index === listActiveIndex;
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
                navOriginRef.current = "pointer";
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
      {secondary !== undefined ? (
        <div ref={secondaryWrapRef}>
          <EffortSlider
            setting={secondary}
            reduced={reduced}
            inputRef={sliderInputRef}
            onSelect={(value) => onSet(secondary.key, value)}
            onFocusChange={setSliderFocused}
          />
        </div>
      ) : null}
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
        aria-haspopup={secondary !== undefined ? "dialog" : "menu"}
        aria-expanded={open}
        aria-controls={open ? (secondary !== undefined ? popoverId : listId) : undefined}
        aria-label={name}
        title={name}
        onClick={() => (open ? close(false) : openMenu())}
        onKeyDown={onTriggerKeyDown}
      >
        {leadingIcon}
        <span data-slot="setting-value">{label}</span>
        {showSecondaryBadge ? <span data-slot="setting-subvalue">{secondaryLabel}</span> : null}
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
  models.find((m) => m.value === (model ?? "default"))?.efforts;

export function SettingChips({
  settings,
  disabled,
  onSet,
  side = "all",
  draft = false,
}: {
  settings: SettingsOf;
  disabled: boolean;
  onSet: (key: string, value: string) => void;
  /** Partition settings across the composer utility bar: permission/other on the left, model + effort on the right. */
  side?: "left" | "right" | "all";
  /**
   * Settings of a session not made yet (the new-session page): no agent is there to put an effort the new model does
   * not take back to `default`, so the picker does.
   */
  draft?: boolean;
}) {
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
  const effortEntry =
    modelEntry !== undefined ? entries.find((entry) => entry.key === "effort") : undefined;
  // The levels the chosen model takes; a model that takes none has no effort to show.
  const levels =
    modelEntry !== undefined ? effortsFor(modelEntry.options, modelEntry.current) : undefined;
  const effortOptions =
    effortEntry === undefined
      ? []
      : levels === undefined
        ? effortEntry.options
        : effortEntry.options.filter((o) => o.value === "default" || levels.includes(o.value));
  const secondaryEffort: SecondarySetting | undefined =
    effortEntry === undefined || effortOptions.length <= 1
      ? undefined
      : {
          key: effortEntry.key,
          heading: effortEntry.heading,
          options: effortOptions,
          current: effortEntry.current,
        };

  const chooseModel = (option: Option) => {
    onSet("model", option.value);
    const effort = effortEntry?.current;
    if (!draft || effort === undefined || effort === "default" || option.efforts === undefined)
      return;
    if (!option.efforts.includes(effort)) onSet("effort", "default");
  };

  return entries.map((entry) => {
    // When both `model` and `effort` are offered, effort lives inside the Model picker as a slider.
    if (effortEntry !== undefined && entry.key === "effort") return null;
    const isRight = entry.key === "model" || entry.key === "effort";
    if (side === "left" && isRight) return null;
    if (side === "right" && !isRight) return null;
    return (
      <SettingPickerChip
        key={entry.key}
        settingKey={entry.key}
        heading={entry.heading}
        options={entry.options}
        current={entry.current}
        secondary={entry.key === "model" ? secondaryEffort : undefined}
        compact={entry.key === "model"}
        align={side === "right" ? "end" : "start"}
        disabled={disabled}
        {...(entry.key === "model" ? { onChoose: chooseModel } : {})}
        onSet={onSet}
      />
    );
  });
}
