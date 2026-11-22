// The tabs of a panel (CYCL-66): the right panel's (Overview, Files, Diff, Terminal, Browser) and, later, the settings
// page's sections. The SDK's tabs: arrows move and select, Home and End, and only the chosen tab's content is in the
// page, so a tab not looked at loads nothing. The strip is 42px, level with the conversation's header.
import { Tabs, TabsList, TabsPanel, TabsTab } from "@ui-sdk/react/tabs";
import type { ReactNode } from "react";

export type PanelTab = {
  /** Stable: what is remembered, and what the analytics name (a fixed word, never a title). */
  id: string;
  label: string;
  content: ReactNode;
};

export function PanelTabs({
  label,
  tabs,
  value,
  onValueChange,
}: {
  /** What the strip is called, for a screen reader. */
  label: string;
  tabs: readonly PanelTab[];
  value: string | null;
  onValueChange: (id: string) => void;
}) {
  return (
    <Tabs
      data-kind="panel-tabs"
      value={value}
      onValueChange={(next) => {
        if (typeof next === "string") onValueChange(next);
      }}
    >
      <TabsList aria-label={label}>
        {tabs.map((tab) => (
          <TabsTab key={tab.id} value={tab.id}>
            {tab.label}
          </TabsTab>
        ))}
      </TabsList>
      {tabs.map((tab) => (
        <TabsPanel key={tab.id} value={tab.id}>
          {tab.content}
        </TabsPanel>
      ))}
    </Tabs>
  );
}
