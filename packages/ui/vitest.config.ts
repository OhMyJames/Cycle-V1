// The interface's tests run in a real browser (Chromium, headless, through Playwright): real layout, focus, selection and
// key events, which happy-dom only imitated. `bun run test:browser`, and CI's browser job: not the pre-commit gate (see
// .agents/notes/2026-11-21-interface-tests-in-a-real-browser.md).
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/browser/*.browser.tsx"],
    // Two files at once: most of a test's time is waiting on the browser (a real click waits for the element to be still),
    // not computing, so two halve the time (about 40 s to 20 s) even on the 2-core target. Measured on 2026-11-21, adding
    // up the processes' resident memory (which counts what Chromium's processes share more than once): one file at a
    // time 1.6 GB, two 2.2 GB, four 3.3 GB. That is why these tests are not in the pre-commit gate.
    maxWorkers: 2,
    setupFiles: ["test/browser/setup.ts"],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      // The app's own window size (BrowserWindow in apps/desktop), not a phone's, which is Vitest's default.
      viewport: { width: 1200, height: 800 },
      instances: [{ browser: "chromium" }],
      // A failure leaves a picture of the page next to the report.
      screenshotFailures: true,
    },
  },
});
