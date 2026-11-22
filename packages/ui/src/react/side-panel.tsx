// The right panel of the open session (CYCL-90): its tabs, as that session last had them. It is in the page only while
// open, and only the tab shown is mounted, so a panel or a tab not looked at loads nothing and asks the daemon nothing.
import type { MessageKey } from "../messages/en-US.ts";
import type { PanelTabKind, SidePanelState } from "../side-panel.ts";
import { useI18n } from "./i18n.tsx";
import { Overview } from "./overview.tsx";
import { PanelTabs } from "./panel-tabs.tsx";

const LABEL: Record<PanelTabKind, MessageKey> = { overview: "panel.tab.overview" };

const contentOf = (tab: PanelTabKind) => {
  switch (tab) {
    case "overview":
      return <Overview />;
  }
};

export function SidePanel({
  state,
  onShow,
}: {
  state: SidePanelState;
  onShow: (tab: PanelTabKind) => void;
}) {
  const { t } = useI18n();
  return (
    <PanelTabs
      label={t("panel.tabs")}
      value={state.active}
      onValueChange={(id) => {
        const tab = state.tabs.find((kind) => kind === id);
        if (tab !== undefined && tab !== state.active) onShow(tab);
      }}
      tabs={state.tabs.map((tab) => ({ id: tab, label: t(LABEL[tab]), content: contentOf(tab) }))}
    />
  );
}
