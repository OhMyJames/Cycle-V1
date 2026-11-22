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
  // What the user left the sidebar and the panel at, and whether the window folded the sidebar (not the user).
  const want = useRef<{ sidebar: number; panel: number }>({
    sidebar: SIDEBAR.default,
    panel: PANEL.default,
  });
  const folded = useRef(false);
  const open = panel !== undefined;

  useEffect(() => {
    const group = groupRef.current;
    if (group === null || typeof ResizeObserver === "undefined") return;
    const sizeOf = (id: string) =>
      group
        .querySelector<HTMLElement>(`[data-slot="resizable-panel"]#${id}`)
        ?.getBoundingClientRect().width ?? 0;
    const fit = () => {
      const width = group.getBoundingClientRect().width;
      if (width === 0) return;
      const userFolded = controller.isCollapsed("sidebar") && !folded.current;
      const next = fitColumns(width, {
        sidebar: userFolded ? 0 : want.current.sidebar,
        panel: open ? want.current.panel : 0,
      });
      if (next.sidebarFolded && !controller.isCollapsed("sidebar")) {
        folded.current = true;
        controller.collapse("sidebar");
      } else if (!next.sidebarFolded && folded.current) {
        folded.current = false;
        controller.expand("sidebar");
      }
      if (open && Math.abs(sizeOf("panel") - next.panel) > 1)
        controller.resize("panel", `${next.panel}px`);
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
          // A size the user chose is what the window gives back when it widens; one it forced is not.
          if (details.reason === "imperative" || details.reason === "resize") return;
          const group = groupRef.current;
          if (group === null) return;
          const widthOf = (id: string) =>
            group
              .querySelector<HTMLElement>(`[data-slot="resizable-panel"]#${id}`)
              ?.getBoundingClientRect().width ?? 0;
          const sidebar = widthOf("sidebar");
          if (sidebar > 0) want.current.sidebar = sidebar;
          if (open && widthOf("panel") > 0) want.current.panel = widthOf("panel");
          folded.current = false;
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
