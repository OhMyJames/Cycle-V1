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
    show: false,
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
    let loadError;
    try {
      await win.loadURL(`${page}?s=${job.name}&theme=${job.theme}`);
    } catch (error) {
      loadError = String(error);
    }
    let ready = false;
    for (let i = 0; i < 100 && !ready && loadError === undefined; i++) {
      ready = (await win.webContents.executeJavaScript("document.title")) === "ready";
      if (!ready) await sleep(100);
    }
    await sleep(150);
    const image = await win.webContents.capturePage();
    writeFileSync(job.out, image.toPNG());
    // Does anything overflow sideways? The page itself must not scroll across.
    const overflow = await win.webContents.executeJavaScript(
      "document.documentElement.scrollWidth - document.documentElement.clientWidth",
    );
    report.push({ ...job, ready, overflow, errors: loadError ? [loadError, ...errors] : errors });
  }
  win.destroy();
  console.log("REPORT " + JSON.stringify(report));
  app.quit();
});
