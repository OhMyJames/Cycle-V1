// The window's columns: the sidebar, the conversation and, when open, the right panel (CYCL-66). One SDK `Resizable`
// group, so both handles drag, take the arrow keys, Home and End, and fold on Enter or a double-click alike. What gives
// way on a narrow window is decided in .agents/notes/2026-11-21-right-panel-layout.md: the conversation down to its
// minimum, then the panel to its own, then the sidebar folds, and comes back when there is room. The panel never covers
// the conversation.
import {
  type createResizableController,
  Resizable,
  ResizableHandle,
  ResizablePanel,
} from "@ui-sdk/react/resizable";
import { type ReactNode, useEffect, useRef } from "react";
import { useI18n } from "./i18n.tsx";

export const SIDEBAR = { default: 256, min: 200, max: 360 } as const;
export const PANEL = { default: 400, min: 280 } as const;
/** The conversation's least width: the composer's controls still fit on one line. */
export const MAIN_MIN = 400;

export type ResizableController = ReturnType<typeof createResizableController>;

/**
 * What the columns have to give up to fit `width`, in the order the note decides. `sidebar` and `panel` are the widths
 * the user left them at (`0` when folded or closed). The conversation takes what is left, down to `MAIN_MIN`; below that
 * the panel narrows to its minimum, and below that the sidebar folds. Pure, so the order is tested without a window.
 */
export const fitColumns = (
  width: number,
  want: { sidebar: number; panel: number },
): { sidebar: number; panel: number; sidebarFolded: boolean } => {
  let panel = want.panel;
  let sidebar = want.sidebar;
  if (width - sidebar - panel >= MAIN_MIN) return { sidebar, panel, sidebarFolded: false };
  if (panel > 0) panel = Math.max(PANEL.min, width - sidebar - MAIN_MIN);
  if (width - sidebar - panel >= MAIN_MIN || sidebar === 0)
    return { sidebar, panel, sidebarFolded: false };
  sidebar = 0;
  return {
    sidebar,
    panel: want.panel > 0 ? Math.max(PANEL.min, Math.min(want.panel, width - MAIN_MIN)) : 0,
    sidebarFolded: true,
  };
};

const FOLDED_KEY = "cycle-layout-folded";
const readFolded = (): boolean => {
  try {
    return globalThis.localStorage?.getItem(FOLDED_KEY) === "1";
  } catch {
    return false;
  }
};
const writeFolded = (value: boolean) => {
  try {
    if (value) globalThis.localStorage?.setItem(FOLDED_KEY, "1");
    else globalThis.localStorage?.removeItem(FOLDED_KEY);
  } catch {}
};

/**
 * After a change the user made (a drag, a key, the sidebar button, ⌘B): whether the sidebar's fold is still the window's.
 * Only a change to the sidebar itself makes it the user's; a drag of the panel's handle while the window has the sidebar
 * folded leaves that fold the window's, to give back when there is room.
 */
export const foldedByWindow = (byWindow: boolean, wasFolded: boolean, folded: boolean): boolean =>
  folded === wasFolded ? byWindow : false;

/** Records who folded the sidebar: `true` the window, `false` the user (or nobody). */
const foldBy = (folded: { current: boolean }, byWindow: boolean) => {
  folded.current = byWindow;
  writeFolded(byWindow);
};

const widthIn = (group: HTMLElement, id: string) =>
  group.querySelector<HTMLElement>(`[data-slot="resizable-panel"]#${id}`)?.getBoundingClientRect()
    .width ?? 0;

export type SplitPanel = {
  /** What the panel holds: its tabs. */
  content: ReactNode;
};

export function SplitLayout({
  controller,
  sidebar,
  main,
  panel,
}: {
  controller: ResizableController;
  sidebar: ReactNode;
  main: ReactNode;
  /** The right panel, when open. Closed, it is not in the page at all: nothing in it loads. */
  panel?: SplitPanel | undefined;
}) {
  const { t } = useI18n();
  const groupRef = useRef<HTMLDivElement>(null);
  // What the user left the sidebar and the panel at: read from the page when the columns attach (the SDK has restored
  // the saved layout by then), and from every change the user makes.
  const want = useRef<{ sidebar: number; panel: number }>({
    sidebar: SIDEBAR.default,
    panel: PANEL.default,
  });
  // Whether the window folded the sidebar (not the user). Kept beside the saved layout, which saves the fold too: after
  // a restart a fold the window made is still the window's, and comes back when there is room.
  const folded = useRef(readFolded());
  // The changes this component asked for: their commits are not the user's.
  const ours = useRef(0);
  const sidebarWasFolded = useRef(false);
  const open = panel !== undefined;

  useEffect(() => {
    const group = groupRef.current;
    if (group === null || typeof ResizeObserver === "undefined") return;
    const widthOf = (id: string) => widthIn(group, id);
    sidebarWasFolded.current = controller.isCollapsed("sidebar");
    if (!sidebarWasFolded.current && widthOf("sidebar") > 0)
      want.current.sidebar = widthOf("sidebar");
    if (open && widthOf("panel") > 0) want.current.panel = widthOf("panel");
    const fit = () => {
      const width = group.getBoundingClientRect().width;
      if (width === 0) return;
      const collapsed = controller.isCollapsed("sidebar");
      const userFolded = collapsed && !folded.current;
      const next = fitColumns(width, {
        sidebar: userFolded ? 0 : want.current.sidebar,
        panel: open ? want.current.panel : 0,
      });
      if (next.sidebarFolded && !collapsed) {
        foldBy(folded, true);
        ours.current++;
        controller.collapse("sidebar");
      } else if (!next.sidebarFolded && folded.current && collapsed) {
        foldBy(folded, false);
        ours.current++;
        controller.expand("sidebar");
      }
      sidebarWasFolded.current = controller.isCollapsed("sidebar");
      if (open && Math.abs(widthOf("panel") - next.panel) > 1) {
        ours.current++;
        controller.resize("panel", `${next.panel}px`);
      }
    };
    const observer = new ResizeObserver(fit);
    observer.observe(group);
    fit();
    return () => observer.disconnect();
  }, [controller, open]);

  return (
    <div data-slot="split" ref={groupRef}>
      <Resizable
        controller={controller}
        autoSaveId="cycle-layout"
        onLayoutCommit={(_layout, details) => {
          if (ours.current > 0) {
            ours.current--;
            return;
          }
          // Everything else is the user's: a drag, a key, the sidebar button or ⌘B. The window's own resizing moves
          // nothing the user chose.
          const collapsed = controller.isCollapsed("sidebar");
          const byWindow = foldedByWindow(folded.current, sidebarWasFolded.current, collapsed);
          if (byWindow !== folded.current) foldBy(folded, byWindow);
          sidebarWasFolded.current = collapsed;
          const group = groupRef.current;
          if (details.reason === "resize" || group === null) return;
          const widthOf = (id: string) => widthIn(group, id);
          if (!collapsed && widthOf("sidebar") > 0) want.current.sidebar = widthOf("sidebar");
          if (open && widthOf("panel") > 0) want.current.panel = widthOf("panel");
        }}
      >
        <ResizablePanel
          id="sidebar"
          defaultSize={`${SIDEBAR.default}px`}
          minSize={`${SIDEBAR.min}px`}
          maxSize={`${SIDEBAR.max}px`}
          collapsible
          collapsedSize="0px"
        >
          {sidebar}
        </ResizablePanel>
        <ResizableHandle aria-label={t("layout.resizeSidebar")} />
        <ResizablePanel id="main" minSize={`${MAIN_MIN}px`}>
          {main}
        </ResizablePanel>
        {open ? (
          <>
            <ResizableHandle aria-label={t("layout.resizePanel")} />
            <ResizablePanel
              id="panel"
              defaultSize={`${PANEL.default}px`}
              minSize={`${PANEL.min}px`}
              collapsible
              collapsedSize="0px"
            >
              <aside data-slot="side-panel" aria-label={t("layout.panel")}>
                {panel.content}
              </aside>
            </ResizablePanel>
          </>
        ) : null}
      </Resizable>
    </div>
  );
}
