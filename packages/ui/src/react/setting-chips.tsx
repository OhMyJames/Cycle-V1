// The session's settings that are a choice (the permission mode, the model and its reasoning effort), at hand in the
// composer utility bar: what the agent does next is decided where the next message is written. Read from the agent's
// own schema, so nothing here knows Claude.
// Visual interaction patterns inspired by Rare UI's Model Picker (https://www.rareui.com/components/modelpicker):
// clean-room Cycle implementation with portaled collision-aware popover, spring unfold, critically-damped sliding
// highlight, compact description-free model rows, draggable elastic Effort slider, WAI-ARIA semantics, full IME
// safety, and explicit-activation guard for high-risk modes.
import { isComposing } from "@ui-sdk/core";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { type Option, OptionLabel, optionsOf, propertiesOf } from "./config-form.tsx";
import { useI18n } from "./i18n.tsx";
import { CheckIcon, ChevronDownIcon, SearchIcon, ShieldAlertIcon, ShieldIcon } from "./icons.tsx";

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

/** Show the inline filter input once a setting offers enough choices to benefit from search. */
const SEARCH_THRESHOLD = 5;
const VIEWPORT_MARGIN = 12;
const POPOVER_GAP = 6;

type PopoverPosition = {
  top: number;
  left: number;
  placement: "top" | "bottom";
};

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/** Compact tick label for the discrete Effort slider track. */
const shortTick = (label: string): string => {
  if (label === "Default") return "Def";
  if (label === "Medium") return "Med";
  return label;
};

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
  const displayLabel = isUnset ? t("config.notSet") : (displayOption?.label ?? "");
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
            {shortTick(opt.label)}
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
  onSet: (key: string, value: string) => void;
}) {
  const { t } = useI18n();
  const reduced = Boolean(useReducedMotion());
  const pickerId = useId();
  const popoverId = `${pickerId}-popover`;
  const listId = `${pickerId}-list`;
  const [open, setOpen] = useState(false);
  const [openSeq, setOpenSeq] = useState(0);
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState(0);
  const [sliderFocused, setSliderFocused] = useState(false);
  const [position, setPosition] = useState<PopoverPosition>({
    top: VIEWPORT_MARGIN,
    left: VIEWPORT_MARGIN,
    placement: "top",
  });
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
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
  const searchable = options.length >= SEARCH_THRESHOLD;

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === "") return options;
    return options.filter(
      (o) =>
        o.label.toLowerCase().includes(q) ||
        o.value.toLowerCase().includes(q) ||
        (o.description?.toLowerCase().includes(q) ?? false),
    );
  }, [options, query]);

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    setQuery("");
    setSliderFocused(false);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  const openMenu = () => {
    if (disabled) return;
    const selectedIndex = current === undefined ? 0 : options.findIndex((o) => o.value === current);
    navOriginRef.current = "init";
    setQuery("");
    setSliderFocused(false);
    setHighlighted(Math.max(selectedIndex, 0));
    setOpenSeq((seq) => seq + 1);
    setOpen(true);
  };

  const choose = (option: Option) => {
    if (option.value !== current) onSet(settingKey, option.value);
    close(true);
  };

  useEffect(() => {
    if (disabled && open) {
      setOpen(false);
      setQuery("");
    }
  }, [disabled, open]);

  useEffect(() => {
    if (!open) return;
    if (searchable) searchRef.current?.focus();
    else listRef.current?.focus();
  }, [open, searchable]);

  const reposition = useCallback(() => {
    const trigger = triggerRef.current;
    const popover = popoverRef.current;
    if (trigger === null || popover === null) return;
    const rect = trigger.getBoundingClientRect();
    // Measure natural layout size so scale enter/exit transforms never skew collision clamping.
    const width = popover.offsetWidth;
    const height = popover.offsetHeight;
    const spaceAbove = rect.top - POPOVER_GAP - VIEWPORT_MARGIN;
    const spaceBelow = window.innerHeight - rect.bottom - POPOVER_GAP - VIEWPORT_MARGIN;
    const placement: "top" | "bottom" =
      height > spaceAbove && spaceBelow > spaceAbove ? "bottom" : "top";
    const rawTop =
      placement === "top" ? rect.top - POPOVER_GAP - height : rect.bottom + POPOVER_GAP;
    const maxTop = Math.max(VIEWPORT_MARGIN, window.innerHeight - VIEWPORT_MARGIN - height);
    const top = Math.max(VIEWPORT_MARGIN, Math.min(rawTop, maxTop));
    const maxLeft = Math.max(VIEWPORT_MARGIN, window.innerWidth - VIEWPORT_MARGIN - width);
    const rawLeft = align === "end" ? rect.right - width : rect.left;
    const left = Math.max(VIEWPORT_MARGIN, Math.min(rawLeft, maxLeft));
    setPosition((prev) =>
      prev.top === top && prev.left === left && prev.placement === placement
        ? prev
        : { top, left, placement },
    );
  }, [align]);

  useLayoutEffect(() => {
    if (!open) return;
    reposition();
    const popover = popoverRef.current;
    if (popover === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => reposition());
    observer.observe(popover);
    return () => observer.disconnect();
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return;
    const isInside = (target: EventTarget | null) => {
      if (!(target instanceof Node)) return false;
      return Boolean(rootRef.current?.contains(target) || popoverRef.current?.contains(target));
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!isInside(event.target)) close(false);
    };
    const onFocusIn = (event: FocusEvent) => {
      if (!isInside(event.target)) close(false);
    };
    const onDocumentKeyDown = (event: KeyboardEvent) => {
      if (isComposing(event)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close(true);
      }
    };
    const onScroll = (event: Event) => {
      if (event.target instanceof Node && popoverRef.current?.contains(event.target)) return;
      reposition();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("keydown", onDocumentKeyDown);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("keydown", onDocumentKeyDown);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open, close, reposition]);

  const activeIndex = visible.length === 0 ? -1 : Math.min(highlighted, visible.length - 1);
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
      if (secondary === undefined) {
        close(false);
        return;
      }
      event.preventDefault();
      if (inSecondary) {
        if (searchable) searchRef.current?.focus();
        else listRef.current?.focus();
      } else {
        sliderInputRef.current?.focus();
      }
      return;
    }
    if (inSecondary) return;
    if (visible.length === 0) return;
    const inSearch = event.target === searchRef.current;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      navOriginRef.current = "keyboard";
      setHighlighted((activeIndex + 1) % visible.length);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      navOriginRef.current = "keyboard";
      setHighlighted((activeIndex - 1 + visible.length) % visible.length);
      return;
    }
    if (event.key === "Home" && !inSearch) {
      event.preventDefault();
      navOriginRef.current = "keyboard";
      setHighlighted(0);
      return;
    }
    if (event.key === "End" && !inSearch) {
      event.preventDefault();
      navOriginRef.current = "keyboard";
      setHighlighted(visible.length - 1);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const target = visible[activeIndex];
      if (target !== undefined) choose(target);
      return;
    }
    if (event.key === " " && !inSearch) {
      event.preventDefault();
      const target = visible[activeIndex];
      if (target !== undefined) choose(target);
    }
  };

  const onTriggerKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (open) return;
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      openMenu();
    }
  };

  const popover = (
    <AnimatePresence>
      {open ? (
        <motion.div
          key={openSeq}
          ref={popoverRef}
          {...(secondary !== undefined
            ? { id: popoverId, role: "dialog", "aria-label": heading }
            : {})}
          data-slot="setting-popover"
          data-compact={compact || undefined}
          data-placement={position.placement}
          style={{
            top: `${position.top}px`,
            left: `${position.left}px`,
            transformOrigin: `${position.placement === "top" ? "bottom" : "top"} ${align === "end" ? "right" : "left"}`,
          }}
          initial={reduced ? { opacity: 1 } : { opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.96 }}
          transition={reduced ? { duration: 0 } : { type: "spring", duration: 0.3, bounce: 0.14 }}
          onMouseDown={(event) => {
            const target = event.target;
            if (target === searchRef.current) return;
            if (target instanceof Node && secondaryWrapRef.current?.contains(target)) return;
            event.preventDefault();
          }}
          onKeyDown={onPopoverKeyDown}
        >
          <div data-slot="setting-popover-head">{heading}</div>
          {searchable ? (
            <div data-slot="setting-search">
              <SearchIcon size={13} aria-hidden="true" />
              <input
                ref={searchRef}
                type="search"
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={open}
                aria-controls={listId}
                {...(activeOptionId !== undefined
                  ? { "aria-activedescendant": activeOptionId }
                  : {})}
                data-slot="setting-search-input"
                value={query}
                placeholder={t("config.filterPlaceholder")}
                aria-label={t("config.filterLabel", { setting: heading })}
                onChange={(event) => {
                  navOriginRef.current = "keyboard";
                  setQuery(event.currentTarget.value);
                  setHighlighted(0);
                }}
              />
            </div>
          ) : null}
          <motion.div
            ref={listRef}
            id={listId}
            layoutScroll
            role={searchable ? "listbox" : "menu"}
            aria-label={heading}
            {...(!searchable && activeOptionId !== undefined
              ? { "aria-activedescendant": activeOptionId }
              : {})}
            tabIndex={-1}
            data-slot="setting-list"
          >
            {visible.length === 0 ? (
              <div role="status" aria-live="polite" data-slot="setting-empty">
                {t("config.noMatch")}
              </div>
            ) : (
              visible.map((option, index) => {
                const selected = option.value === current;
                const active = index === listActiveIndex;
                const displayOption = compact ? { ...option, description: undefined } : option;
                return (
                  <button
                    key={option.value}
                    id={optionId(index)}
                    type="button"
                    role={searchable ? "option" : "menuitemradio"}
                    {...(searchable ? { "aria-selected": selected } : { "aria-checked": selected })}
                    tabIndex={-1}
                    data-slot="setting-option"
                    data-active={active || undefined}
                    data-selected={selected || undefined}
                    data-danger={option.danger || undefined}
                    title={option.description}
                    onMouseEnter={() => {
                      navOriginRef.current = "pointer";
                      setSliderFocused(false);
                      setHighlighted(index);
                    }}
                    onClick={() => choose(option)}
                  >
                    {active ? (
                      <motion.span
                        {...(reduced
                          ? {}
                          : { layoutId: `setting-highlight-${pickerId}-${openSeq}` })}
                        data-slot="setting-highlight"
                        aria-hidden="true"
                        transition={
                          reduced ? { duration: 0 } : { type: "spring", duration: 0.18, bounce: 0 }
                        }
                      />
                    ) : null}
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
              })
            )}
          </motion.div>
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
        </motion.div>
      ) : null}
    </AnimatePresence>
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
        aria-haspopup={secondary !== undefined ? "dialog" : searchable ? "listbox" : "menu"}
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
      {typeof document !== "undefined" ? createPortal(popover, document.body) : null}
    </div>
  );
}

type ChoiceEntry = {
  key: string;
  heading: string;
  options: Option[];
  current: string | undefined;
};

export function SettingChips({
  settings,
  disabled,
  onSet,
  side = "all",
}: {
  settings: SettingsOf;
  disabled: boolean;
  onSet: (key: string, value: string) => void;
  /** Partition settings across the composer utility bar: permission/other on the left, model + effort on the right. */
  side?: "left" | "right" | "all";
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
  const hasModel = entries.some((entry) => entry.key === "model");
  const effortEntry = hasModel ? entries.find((entry) => entry.key === "effort") : undefined;
  // Hide the Effort slider when the active model reports `supportsEffort: false` (only the default option remains).
  const secondaryEffort: SecondarySetting | undefined =
    effortEntry === undefined || effortEntry.options.length <= 1
      ? undefined
      : {
          key: effortEntry.key,
          heading: effortEntry.heading,
          options: effortEntry.options,
          current: effortEntry.current,
        };

  return entries.map((entry) => {
    // When both `model` and `effort` are offered, effort lives inside the Model picker as an elastic slider.
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
        onSet={onSet}
      />
    );
  });
}
