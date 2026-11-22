// A right panel to try the columns with (CYCL-66), until CYCL-90 brings the real one: the tabs it will have, holding
// placeholder text. Gallery only.
import { useState } from "react";
import { PanelTabs } from "../src/react/panel-tabs.tsx";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "files", label: "Files" },
  { id: "diff", label: "Diff" },
  { id: "terminal", label: "Terminal" },
];

function SamplePanel() {
  const [tab, setTab] = useState("overview");
  return (
    <PanelTabs
      label="Panel"
      value={tab}
      onValueChange={setTab}
      tabs={TABS.map((t) => ({
        ...t,
        content: (
          <div style={{ padding: "0.75rem 1rem" }}>
            <p>{t.label} of the open session, as CYCL-85 to CYCL-98 will draw it.</p>
          </div>
        ),
      }))}
    />
  );
}

export const samplePanel = { content: <SamplePanel /> };
