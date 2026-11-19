// Electron main for the gallery. shoot.ts supplies a temporary profile and a JSON file of jobs.
const { app, BrowserWindow, nativeTheme } = require("electron");
const { readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");

const jobs = JSON.parse(readFileSync(process.argv.at(-1), "utf8"));
const profile = process.argv.at(-2);
app.setPath("userData", profile);
app.setPath("sessionData", profile);
const page = pathToFileURL(join(__dirname, "dist/index.html")).href;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

app
  .whenReady()
  .then(async () => {
    const report = [];
    // One window for every job: a window made and destroyed in turn made the next load fail.
    const win = new BrowserWindow({
      // Layout components need a visible window to report their actual geometry.
      show: true,
      width: 1200,
      height: 800,
      useContentSize: true,
      ...(process.platform === "darwin"
        ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 16, y: 14 } }
        : {}),
      webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false },
    });
    let errors = [];
    win.webContents.on("console-message", (event) => {
      const e = event.message !== undefined ? event : { level: 0, message: "" };
      if (e.level === "error" || e.level >= 2) errors.push(e.message);
    });
    for (const job of jobs) {
      let stage = "loading";
      const timeout = setTimeout(() => {
        console.error(`Timed out ${stage} ${job.name} (${job.theme}, ${job.width}x${job.height})`);
        app.exit(1);
      }, 15_000);
      nativeTheme.themeSource = job.theme;
      win.setContentSize(job.width, job.height);
      errors = [];
      // Each shot starts from nothing: the sidebar's width and fold are saved in localStorage, and would leak into the next.
      await win.webContents.session.clearStorageData({ storages: ["localstorage"] });
      let loadError;
      try {
        await win.loadURL(
          `${page}?s=${job.name}&theme=${job.theme}${job.platform ? `&platform=${job.platform}` : ""}`,
        );
      } catch (error) {
        loadError = String(error);
      }
      let ready = false;
      for (let i = 0; i < 100 && !ready && loadError === undefined; i++) {
        ready = (await win.webContents.executeJavaScript("document.title")) === "ready";
        if (!ready) await sleep(100);
      }
      // Tab with real input events: a script's focus() does not count as the keyboard, and :focus-visible would not show.
      if (job.tabs > 0) {
        win.webContents.focus();
        for (let i = 0; i < job.tabs; i++) {
          win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab" });
          win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Tab" });
          await sleep(60);
        }
      }
      const focus =
        job.tabs > 0
          ? await win.webContents.executeJavaScript(`(() => {
            const el = document.activeElement;
            if (!el || el === document.body) return { on: "nothing" };
            // The message box draws its ring round the whole box, not on the text inside it.
            const s = getComputedStyle(
              el.matches('[data-slot="composer-input"]') ? el.closest('[data-slot="composer-box"]') ?? el : el,
            );
            const label = el.getAttribute("aria-label") || (el.textContent || "").trim().slice(0, 30);
            return {
              on: el.tagName.toLowerCase() + (el.getAttribute("role") ? "[" + el.getAttribute("role") + "]" : "") + " " + label,
              visible: el.matches(":focus-visible"),
              outline: s.outlineStyle + " " + s.outlineWidth + " " + s.outlineColor,
            };
          })()`)
          : undefined;
      await sleep(150);
      stage = "capturing";
      const image = await win.webContents.capturePage();
      writeFileSync(job.out, image.toPNG());
      stage = "measuring";
      const layout = await win.webContents.executeJavaScript(`(${measureLayout})()`);
      report.push({
        ...job,
        focus,
        ready,
        ...layout,
        errors: loadError ? [loadError, ...errors] : errors,
      });
      clearTimeout(timeout);
    }
    win.destroy();
    console.log(`REPORT ${JSON.stringify(report)}`);
    app.quit();
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
