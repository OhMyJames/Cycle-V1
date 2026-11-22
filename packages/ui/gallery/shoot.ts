// Screenshots of the gallery: `bun packages/ui/gallery/shoot.ts [--out dir] [--themes light,dark] [--sizes 1200x800,720x480] [names...]`.
// Builds the gallery and opens it in headless Chromium (Playwright): no window, on any system, so it takes nobody's focus.
// With no names, captures every scenario.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { serveDir } from "../../../scripts/serve-dir.ts";
import { type Scenario, scenarios } from "./scenarios.ts";

const here = new URL(".", import.meta.url).pathname;
const argv = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : (argv[at + 1] ?? fallback);
};
const out = flag("out", join(here, "shots"));
const themes = flag("themes", "light,dark").split(",");
for (const theme of themes)
  if (theme !== "light" && theme !== "dark") {
    console.error(`--themes takes light and dark, not ${theme}`);
    process.exit(2);
  }
const sizes = flag("sizes", "1200x800,720x480").split(",");
const platform = flag("platform", "");
const VALUE_FLAGS = new Set(["--out", "--themes", "--sizes", "--platform"]);
const flagged = new Set(
  argv.flatMap((a, i) => (VALUE_FLAGS.has(a) ? [i, i + 1] : a.startsWith("--") ? [i] : [])),
);
const named = argv.filter((_, i) => !flagged.has(i));
const names = named.length > 0 ? named : ["tokens", ...Object.keys(scenarios)];

const build = Bun.spawn(["bun", join(here, "build.ts")], { stdout: "ignore", stderr: "inherit" });
if ((await build.exited) !== 0) process.exit(1);

mkdirSync(out, { recursive: true });
const jobs = names.flatMap((name) =>
  themes.flatMap((theme) =>
    sizes.map((size) => {
      const [width = 1200, height = 800] = size.split("x").map(Number);
      return {
        name,
        theme: theme as "light" | "dark",
        tabs: (scenarios as Record<string, Scenario | undefined>)[name]?.tabs ?? 0,
        width,
        height,
        out: join(out, `${name}.${theme}.${size}.png`),
      };
    }),
  ),
);

/** In the page: what the eye can miss. Overflow, a clipped first session, the message box's edge against its ground. */
function measureLayout() {
  const root = document.scrollingElement;
  const sidebar = document.querySelector('[data-slot="sidebar"]');
  const list = sidebar?.querySelector('[role="listbox"]');
  const row = list?.querySelector('[role="option"]');
  let firstSessionVisible = false;
  if (row) {
    const visible = row.getBoundingClientRect();
    const outer = sidebar.getBoundingClientRect();
    const inner = list.getBoundingClientRect();
    firstSessionVisible =
      visible.top >= Math.max(inner.top, outer.top) &&
      visible.bottom <= Math.min(inner.bottom, outer.bottom);
  }

  // The edge of the message is the box round the text, the images and the controls.
  const input = document
    .querySelector('[data-slot="composer-input"][contenteditable="true"]')
    ?.closest('[data-slot="composer-box"]');
  let composerContrast = null;
  if (input) {
    // Canvas resolves CSS colors to sRGB. Sample the outline against the same background it is drawn over.
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d");
    const surface = getComputedStyle(document.body).backgroundColor;
    const luminance = (color) => {
      context.fillStyle = surface;
      context.fillRect(0, 0, 1, 1);
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      const [r, g, b] = Array.from(context.getImageData(0, 0, 1, 1).data).map((n) => {
        const v = n / 255;
        return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const style = getComputedStyle(input);
    const edge = luminance(
      style.borderTopWidth === "0px" ? style.backgroundColor : style.borderTopColor,
    );
    const background = luminance(surface);
    composerContrast = (Math.max(edge, background) + 0.05) / (Math.min(edge, background) + 0.05);
  }
  return {
    overflowX: root.scrollWidth - root.clientWidth,
    overflowY: root.scrollHeight - root.clientHeight,
    firstSessionVisible,
    composerContrast,
  };
}

// The built gallery, from loopback only: its module scripts do not load from a file.
const dist = join(here, "dist");
const server = serveDir(dist);
const browser = await chromium.launch();
const report = [];
try {
  for (const job of jobs) {
    // Each shot starts from nothing: the sidebar's width and fold are saved in localStorage, and would leak into the next.
    const context = await browser.newContext({
      viewport: { width: job.width, height: job.height },
      // At twice the pixels, as a Mac's screen shows it: a hairline and an edge's colour are what a review looks at.
      deviceScaleFactor: 2,
      colorScheme: job.theme,
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("pageerror", (error) => errors.push(String(error)));
    let ready = false;
    try {
      await page.goto(
        `http://127.0.0.1:${server.port}/?s=${job.name}&theme=${job.theme}${platform ? `&platform=${platform}` : ""}`,
      );
      await page.waitForFunction(() => document.title === "ready", undefined, { timeout: 10_000 });
      ready = true;
    } catch (error) {
      errors.push(String(error));
    }
    // Tab with the browser's own keys: a script's focus() does not count as the keyboard, and :focus-visible would not show.
    for (let i = 0; i < job.tabs; i++) await page.keyboard.press("Tab");
    const focus =
      job.tabs > 0
        ? await page.evaluate(() => {
            const el = document.activeElement as HTMLElement | null;
            if (!el || el === document.body) return { on: "nothing" };
            // The message box draws its ring round the whole box, not on the text inside it.
            const s = getComputedStyle(
              el.matches('[data-slot="composer-input"]')
                ? (el.closest('[data-slot="composer-box"]') ?? el)
                : el,
            );
            const named = (el.getAttribute("aria-labelledby") || "")
              .split(" ")
              .map((id) => document.getElementById(id)?.textContent || "")
              .join(" ")
              .trim();
            const label =
              el.getAttribute("aria-label") || named || (el.textContent || "").trim().slice(0, 30);
            return {
              on: `${el.tagName.toLowerCase()}${el.getAttribute("role") ? `[${el.getAttribute("role")}]` : ""} ${label}`,
              visible: el.matches(":focus-visible"),
              outline: `${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor}`,
            };
          })
        : undefined;
    // Animations at their end, not halfway: a dialog that is fading in, a ring that is still growing.
    await page.screenshot({ path: job.out, animations: "disabled" });
    const layout = await page.evaluate(measureLayout);
    report.push({ ...job, focus, ready, ...layout, errors });
    await context.close();
  }
} finally {
  await browser.close();
  server.stop(true);
}

let bad = 0;
let total = 0;
for (const r of report) {
  const problems = [
    !r.ready && "not ready",
    r.overflowX > 0 && `root overflows horizontally by ${r.overflowX}px`,
    r.name !== "tokens" && r.overflowY > 0 && `root overflows vertically by ${r.overflowY}px`,
    (r.name === "session-groups" || r.name === "many-sessions") &&
      !r.firstSessionVisible &&
      "first session is clipped",
    r.composerContrast !== null &&
      r.composerContrast < 3 &&
      `composer border contrast is ${r.composerContrast.toFixed(2)}:1 (need 3:1)`,
    r.errors.length > 0 && r.errors.join("; "),
  ].filter(Boolean);
  // A tabbed shot says where the focus is, and fails if it is on a control that shows no ring.
  if (r.focus !== undefined) {
    const ringless = r.focus.visible !== true || /^none/.test(r.focus.outline ?? "none");
    console.log(
      `${ringless ? "!" : " "} ${r.name} (${r.theme}): focus on ${r.focus.on}; ${r.focus.outline ?? "no outline"}`,
    );
    if (ringless) problems.push("focus without a ring");
  }
  if (problems.length > 0) bad++;
  if (problems.length > 0 || argv.includes("--all"))
    console.log(
      `${problems.length > 0 ? "!" : " "} ${r.out}${problems.length > 0 ? `  ${problems.join(", ")}` : ""}`,
    );
  total++;
}
console.log(`${total} shots in ${out}, ${bad} with problems`);
process.exit(bad > 0 ? 1 : 0);
