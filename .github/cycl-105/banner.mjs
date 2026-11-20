import { expect } from "bun:test";
import { rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

const [root, old, app] = process.argv.slice(2);
const port = 20000 + Math.floor(Math.random() * 20000);
const child = Bun.spawn(
  [
    join(app, "Contents/MacOS/Electron"),
    "--disable-gpu",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${root}/electron`,
  ],
  {
    env: {
      HOME: join(root, "local-home"),
      PATH: `${root}/bin:/usr/bin:/bin`,
      CYCLE_HOME: join(root, "local"),
      LANG: "en_US.UTF-8",
      CYCLE_ANALYTICS: "off",
      CYCLE_UPDATE_URL: "http://127.0.0.1:1",
    },
    stdout: "ignore",
    stderr: Bun.file(join(root, "window.log")),
  },
);
const until = async (name, probe, ms = 20000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const result = await probe();
    if (result) return result;
    await Bun.sleep(150);
  }
  throw new Error(`timed out: ${name}`);
};
let socket;
let evaluate;
try {
  const endpoint = await until("DevTools", async () => {
    const pages = await fetch(`http://127.0.0.1:${port}/json`)
      .then((r) => r.json())
      .catch(() => []);
    return pages.find((p) => p.type === "page")?.webSocketDebuggerUrl;
  });
  socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  let id = 0;
  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const current = ++id;
      const timer = setTimeout(() => {
        socket.removeEventListener("message", reply);
        reject(new Error(method));
      }, 3000);
      function reply(event) {
        const msg = JSON.parse(event.data);
        if (msg.id !== current) return;
        socket.removeEventListener("message", reply);
        clearTimeout(timer);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
      socket.addEventListener("message", reply);
      socket.send(JSON.stringify({ id: current, method, params }));
    });
  evaluate = async (expression) =>
    (await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result
      .value;
  const click = async (name, expression) => {
    const [x, y] = await until(name, () =>
      evaluate(
        `(() => {const el=(${expression}); if (!el || el.disabled) return null; const r=el.getBoundingClientRect(); return r.width && r.height ? [r.x+r.width/2,r.y+r.height/2] : null;})()`,
      ),
    );
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"])
      await call("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
  };
  const remote = async () =>
    (await evaluate("window.cycle.environments()"))?.status?.find((s) => s.environmentId === "far");
  await until(
    "connected to 0.2.0 via SSH",
    async () => (await remote())?.daemon?.version === "0.2.0",
  );
  await click("New session", `document.querySelector('button[title^="New session"]')`);
  await click(
    "environment picker",
    `document.querySelector('[data-slot="blank-where"] [role="combobox"], [data-slot="blank-where"] [data-slot="select-trigger"]')`,
  );
  await click(
    "SSH environment",
    `[...document.querySelectorAll('[role="option"]')].find(el=>el.textContent.includes("CYCL-105 SSH"))`,
  );
  const banner = await until("warning", () =>
    evaluate(`document.querySelector('[data-kind="daemon"]')?.textContent`),
  );
  expect(banner).toContain("CYCL-105 SSH");
  expect(banner).toContain("0.2.0");
  expect(banner).toContain("Update to 0.3.7");
  console.log("Old remote:", banner);
  const screenshot = async (name) => {
    const result = await call("Page.captureScreenshot", { format: "png" });
    await writeFile(join(process.env.RUNNER_TEMP, name), Buffer.from(result.data, "base64"));
  };
  await screenshot("cycl105-old-remote.png");
  await symlink(join(app, "Contents/Resources/app/bin/cycle"), join(root, "new-daemon"));
  await rename(join(root, "new-daemon"), join(root, "remote-daemon"));
  const stop = Bun.spawnSync([old, "stop", "--data-dir", join(root, "remote")]);
  expect(stop.success).toBe(true);
  await until("SSH reconnect to 0.3.7", async () => (await remote())?.daemon?.version === "0.3.7");
  await until("warning cleared", () =>
    evaluate(`document.querySelector('[data-kind="daemon"]') === null`),
  );
  console.log("Reconnected remote:", JSON.stringify(await remote()));
  await screenshot("cycl105-current-remote.png");
} catch (error) {
  if (evaluate) {
    console.log("Test window:", await evaluate("document.body.innerText.slice(0,2600)"));
    console.log(
      "Test environments:",
      JSON.stringify(await evaluate("window.cycle.environments()")),
    );
    console.log(
      "Test selectors:",
      await evaluate(
        `[...document.querySelectorAll('[data-slot="blank-where"] button,[role="option"]')].map(e=>e.outerHTML.slice(0,230))`,
      ),
    );
  }
  throw error;
} finally {
  socket?.close();
  child.kill();
  await child.exited;
}
