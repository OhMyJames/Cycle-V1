// Electron main for the gallery's screenshots: `shoot.ts` runs it. Argument: a JSON file of jobs
// [{ name, theme, width, height, out }]. Each job loads the scenario in a window of that size and saves a PNG.
const { app, BrowserWindow, nativeTheme } = require("electron");
const { readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");

const jobs = JSON.parse(readFileSync(process.argv.at(-1), "utf8"));
const page = pathToFileURL(join(__dirname, "dist/index.html")).href;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const report = [];
  // One window for every job: a window made and destroyed in turn made the next load fail.
  const win = new BrowserWindow({
    // Shown (on xvfb's screen): a hidden window is never laid out, and a layout that measures itself stays at its first guess.
    show: true,
    width: 1200,
    height: 800,
    useContentSize: true,
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false },
  });
  let errors = [];
  win.webContents.on("console-message", (event) => {
    const e = event.message !== undefined ? event : { level: 0, message: "" };
    if (e.level === "error" || e.level >= 2) errors.push(e.message);
  });
  for (const job of jobs) {
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
            const s = getComputedStyle(el);
            const label = el.getAttribute("aria-label") || (el.textContent || "").trim().slice(0, 30);
            return {
              on: el.tagName.toLowerCase() + (el.getAttribute("role") ? "[" + el.getAttribute("role") + "]" : "") + " " + label,
              visible: el.matches(":focus-visible"),
              outline: s.outlineStyle + " " + s.outlineWidth + " " + s.outlineColor,
            };
          })()`)
        : undefined;
    await sleep(150);
    const image = await win.webContents.capturePage();
    writeFileSync(job.out, image.toPNG());
    // Does anything overflow sideways? The page itself must not scroll across.
    const overflow = await win.webContents.executeJavaScript(
      "document.documentElement.scrollWidth - document.documentElement.clientWidth",
    );
    report.push({
      ...job,
      focus,
      ready,
      overflow,
      errors: loadError ? [loadError, ...errors] : errors,
    });
  }
  win.destroy();
  console.log(`REPORT ${JSON.stringify(report)}`);
  app.quit();
});
