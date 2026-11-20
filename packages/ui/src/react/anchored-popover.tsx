// The popover the composer's utility bar opens from its controls (the permission mode, the model and effort, the
// context ring): one surface, placed against its trigger, out of the way of the window's edges, closed by Escape, a
// press outside or focus leaving. Taken out of the setting picker so the ring's details are the same popover, not a
// second one (CYCL-74). Not a general popover for the app: that is CYCL-65's.
import { isComposing } from "@ui-sdk/core";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useState,
} from "react";
import { createPortal } from "react-dom";

const VIEWPORT_MARGIN = 12;
/** `--cycle-ease`. */
const EASE = [0.2, 0.8, 0.2, 1] as const;
const POPOVER_GAP = 6;

type Position = { top: number; left: number; placement: "top" | "bottom" };

export function AnchoredPopover({
  open,
  anchorRef,
  ownerRef,
  popoverRef,
  align,
  onDismiss,
  id,
  role,
  label,
  kind,
  compact,
  onKeyDown,
  onMouseDown,
  focusable,
  children,
}: {
  open: boolean;
  /** What it is placed against: the trigger. */
  anchorRef: RefObject<HTMLElement | null>;
  /** What a press or focus may land on without closing it (the trigger's wrapper). */
  ownerRef: RefObject<HTMLElement | null>;
  popoverRef: RefObject<HTMLDivElement | null>;
  align: "start" | "end";
  /** Escape gives the focus back to the trigger (`true`); a press or focus elsewhere leaves it where it went. */
  onDismiss: (returnFocus: boolean) => void;
  id?: string;
  role?: "dialog";
  label?: string;
  /** Which popover this is, for its styles. */
  kind?: string;
  compact?: boolean;
  onKeyDown?: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  onMouseDown?: (event: React.MouseEvent<HTMLDivElement>) => void;
  /** The popover itself takes the focus (it has nothing inside that does), so a screen reader reads it. */
  focusable?: boolean;
  children: ReactNode;
}) {
  const reduced = Boolean(useReducedMotion());
  const [position, setPosition] = useState<Position>({
    top: VIEWPORT_MARGIN,
    left: VIEWPORT_MARGIN,
    placement: "top",
  });

  const reposition = useCallback(() => {
    const anchor = anchorRef.current;
    const popover = popoverRef.current;
    if (anchor === null || popover === null) return;
    const rect = anchor.getBoundingClientRect();
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
  }, [align, anchorRef, popoverRef]);

  useLayoutEffect(() => {
    if (!open) return;
    reposition();
    const popover = popoverRef.current;
    if (popover === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => reposition());
    observer.observe(popover);
    return () => observer.disconnect();
  }, [open, reposition, popoverRef]);

  useEffect(() => {
    if (!open) return;
    const isInside = (target: EventTarget | null) => {
      if (!(target instanceof Node)) return false;
      return Boolean(ownerRef.current?.contains(target) || popoverRef.current?.contains(target));
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!isInside(event.target)) onDismiss(false);
    };
    const onFocusIn = (event: FocusEvent) => {
      if (!isInside(event.target)) onDismiss(false);
    };
    const onDocumentKeyDown = (event: KeyboardEvent) => {
      if (isComposing(event)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onDismiss(true);
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
  }, [open, onDismiss, reposition, ownerRef, popoverRef]);

  if (typeof document === "undefined") return null;
  return createPortal(
    <AnimatePresence>
      {open ? (
        <motion.div
          key="popover"
          ref={popoverRef}
          {...(id !== undefined ? { id } : {})}
          {...(role !== undefined ? { role } : {})}
          {...(label !== undefined ? { "aria-label": label } : {})}
          {...(focusable ? { tabIndex: -1 } : {})}
          data-slot="setting-popover"
          data-kind={kind}
          data-compact={compact || undefined}
          data-placement={position.placement}
          style={{
            top: `${position.top}px`,
            left: `${position.left}px`,
            transformOrigin: `${position.placement === "top" ? "bottom" : "top"} ${align === "end" ? "right" : "left"}`,
          }}
          // DESIGN.md motion: unfold in 160ms, leave in 100ms, no bounce; still under reduced motion.
          initial={reduced ? { opacity: 1 } : { opacity: 0, scale: 0.97 }}
          animate={{
            opacity: 1,
            scale: 1,
            transition: reduced ? { duration: 0 } : { duration: 0.16, ease: EASE },
          }}
          exit={{
            opacity: 0,
            ...(reduced ? {} : { scale: 0.97 }),
            transition: { duration: reduced ? 0 : 0.1, ease: EASE },
          }}
          {...(onMouseDown !== undefined ? { onMouseDown } : {})}
          {...(onKeyDown !== undefined ? { onKeyDown } : {})}
        >
          {children}
        </motion.div>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}
