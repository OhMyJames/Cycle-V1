import { Button } from "@ui-sdk/react/button";
import { useAppState, useAppStore } from "./store-context.tsx";

/**
 * Said once, at the top of the page, the first time the app runs with somewhere to report to: what is counted, and that
 * it can be turned off. Either button is an answer, and the notice does not come back.
 */
export function AnalyticsNotice() {
  const store = useAppStore();
  const analytics = useAppState((s) => s.analytics);
  if (analytics === undefined || !analytics.available || analytics.noticed) return null;
  return (
    <div data-slot="banner" data-severity="info" role="status">
      <span>
        Cycle counts which features are used, to improve them. It never sends what you write, your
        files, or their names. You can turn this off at any time in the settings menu at the bottom
        of the sidebar.
      </span>
      <Button data-variant="outline" onClick={() => void store.setAnalytics(false)}>
        Turn off
      </Button>
      <Button data-variant="outline" onClick={() => void store.setAnalytics(true)}>
        Keep on
      </Button>
    </div>
  );
}
