import { Button } from "@ui-sdk/react/button";
import { useI18n } from "./i18n.tsx";
import { useAppState, useAppStore } from "./store-context.tsx";

/**
 * Said once, at the top of the page, the first time the app runs with somewhere to report to: what is counted, and that
 * it can be turned off. Either button is an answer, and the notice does not come back.
 */
export function AnalyticsNotice() {
  const store = useAppStore();
  const { t } = useI18n();
  const analytics = useAppState((s) => s.analytics);
  if (analytics === undefined || !analytics.available || analytics.noticed) return null;
  return (
    <div data-slot="banner" data-severity="info" role="status">
      <span>{t("analytics.notice")}</span>
      <Button data-variant="outline" onClick={() => void store.setAnalytics(false)}>
        {t("analytics.turnOff")}
      </Button>
      <Button data-variant="outline" onClick={() => void store.setAnalytics(true)}>
        {t("analytics.keepOn")}
      </Button>
    </div>
  );
}
