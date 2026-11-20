// The session's settings that are a choice (the permission mode, the model), at hand in the composer: what the agent does
// next is decided where the next message is written. Read from the agent's own schema, so nothing here knows Claude.
// Visual interaction pattern inspired by Rare UI's Model Picker (https://www.rareui.com/components/modelpicker);
// clean-room Cycle implementation with portaled collision-aware popover, smooth spring highlight, optional inline filter,
// WAI-ARIA menu/combobox semantics, full IME safety, and explicit-activation guard for high-risk modes.
import { isComposing } from "@ui-sdk/core";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { type Option, OptionLabel, optionsOf, propertiesOf } from "./config-form.tsx";
import { useI18n } from "./i18n.tsx";
import { CheckIcon, ChevronDownIcon, SearchIcon } from "./icons.tsx";

export type SettingsOf = {
  /** The agent's `configSchema`. */
  schema: Record<string, unknown>;
  /** What the session has: a setting with no value is not shown as today's default, which it may not have. */
  value: Record<string, string>;
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

function SettingPickerChip({
  settingKey,
  heading,
  options,
  current,
  disabled,
  onSet,
}: {
  settingKey: string;
  heading: string;
  options: readonly Option[];
  current: string | undefined;
  disabled: boolean;
  onSet: (key: string, value: string) => void;
}) {
  const { t } = useI18n();
  const reduced = Boolean(useReducedMotion());
  const pickerId = useId();
  const listId = `${pickerId}-list`;
  const [open, setOpen] = useState(false);
  const [openSeq, setOpenSeq] = useState(0);
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState(0);
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
  const navOriginRef = useRef<"init" | "keyboard" | "pointer">("init");

  const chosen = current === undefined ? undefined : options.find((o) => o.value === current);
  // A value the schema does not list (a model named in full, say) is still what the session runs on: it is shown as it is.
  const label = current === undefined ? t("config.notSet") : (chosen?.label ?? current);
  const name = t("composer.setting", { setting: heading, value: label });
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
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  const openMenu = () => {
    if (disabled) return;
    const selectedIndex = current === undefined ? 0 : options.findIndex((o) => o.value === current);
    navOriginRef.current = "init";
    setQuery("");
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
    const left = Math.max(VIEWPORT_MARGIN, Math.min(rect.left, maxLeft));
    setPosition((prev) =>
      prev.top === top && prev.left === left && prev.placement === placement
        ? prev
        : { top, left, placement },
    );
  }, []);

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
  const optionId = (index: number) => `${pickerId}-opt-${index}`;
  const activeOptionId = activeIndex >= 0 ? optionId(activeIndex) : undefined;

  useEffect(() => {
    if (!open || activeIndex < 0 || navOriginRef.current === "pointer") return;
    const item = listRef.current?.querySelector<HTMLElement>(
      `[data-slot="setting-option"]:nth-of-type(${activeIndex + 1})`,
    );
    item?.scrollIntoView?.({ block: "nearest" });
  }, [open, activeIndex]);

  const onPopoverKeyDown = (event: React.KeyboardEvent) => {
    if (isComposing(event.nativeEvent)) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.key === "Tab") {
      close(false);
      return;
    }
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
          data-slot="setting-popover"
          data-placement={position.placement}
          style={{
            top: `${position.top}px`,
            left: `${position.left}px`,
            transformOrigin: position.placement === "top" ? "bottom left" : "top left",
          }}
          initial={
            reduced
              ? { opacity: 1 }
              : { opacity: 0, y: position.placement === "top" ? 6 : -6, scale: 0.98 }
          }
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={
            reduced
              ? { opacity: 0 }
              : { opacity: 0, y: position.placement === "top" ? 4 : -4, scale: 0.98 }
          }
          transition={{
            duration: reduced ? 0 : 0.16,
            ease: [0.2, 0.8, 0.2, 1],
          }}
          onMouseDown={(event) => {
            if (event.target !== searchRef.current) event.preventDefault();
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
                const active = index === activeIndex;
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
                    onMouseEnter={() => {
                      navOriginRef.current = "pointer";
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
                          reduced
                            ? { duration: 0 }
                            : { type: "spring", stiffness: 520, damping: 38, mass: 0.7 }
                        }
                      />
                    ) : null}
                    <span data-slot="setting-check" aria-hidden="true">
                      {selected ? <CheckIcon size={13} /> : null}
                    </span>
                    <span data-slot="setting-option-body">
                      <OptionLabel option={option} />
                    </span>
                  </button>
                );
              })
            )}
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );

  return (
    <div ref={rootRef} data-slot="setting-picker">
      <button
        ref={triggerRef}
        type="button"
        data-slot="button"
        data-variant="ghost"
        data-kind="setting-chip"
        data-unset={current === undefined || undefined}
        data-danger={chosen?.danger || undefined}
        data-open={open || undefined}
        data-disabled={disabled || undefined}
        disabled={disabled}
        aria-haspopup={searchable ? "listbox" : "menu"}
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={name}
        title={name}
        onClick={() => (open ? close(false) : openMenu())}
        onKeyDown={onTriggerKeyDown}
      >
        <span data-slot="setting-value">{label}</span>
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

export function SettingChips({
  settings,
  disabled,
  onSet,
}: {
  settings: SettingsOf;
  disabled: boolean;
  onSet: (key: string, value: string) => void;
}) {
  return propertiesOf(settings.schema).map(([key, property]) => {
    const options = optionsOf(property);
    if (options === undefined || options.length === 0) return null;
    return (
      <SettingPickerChip
        key={key}
        settingKey={key}
        heading={property.title ?? key}
        options={options}
        current={settings.value[key]}
        disabled={disabled}
        onSet={onSet}
      />
    );
  });
}
