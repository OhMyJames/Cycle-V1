// Runs inside Electron (under xvfb in the test) in place of main.ts: it starts the real app, then
// drives the real window with real mouse and key events, and reports what it saw as JSON lines.
// The test that starts it sets everything through the environment.
import { appendFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { app } from "electron";
import { startApp } from "../../src/main/app.ts";

const env = process.env as Record<string, string>;
// Each step is also appended, synchronously, to SMOKE_LOG when set, so a run that hangs can be read.
const out = (value: unknown) => {
  const line = `${JSON.stringify(value)}\n`;
  process.stdout.write(line);
  if (env.SMOKE_LOG) appendFileSync(env.SMOKE_LOG, line);
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Not a top-level await: see src/main/main.ts.
const main = async () => {
  const trace = (...args: unknown[]) => process.stderr.write(`[smoke] ${args.join(" ")}\n`);
  trace("starting the app");
  const { contents } = await startApp({
    rendererDir: env.SMOKE_RENDERER as string,
    preloadPath: env.SMOKE_PRELOAD as string,
    localCommand: [
      "bun",
      env.SMOKE_DAEMON as string,
      "proxy",
      "--data-dir",
      env.SMOKE_DATA as string,
      "--socket",
      env.SMOKE_SOCKET as string,
    ],
    localEnv: { PATH: env.PATH ?? "", HOME: env.SMOKE_HOME as string },
    show: false,
  });
  trace("the app is up");
  contents.on("console-message", (_e, level, message, line, source) =>
    trace("page console", level, message, `(${source}:${line})`),
  );
  contents.on("preload-error", (_e, path, error) => trace("preload error", path, String(error)));
  contents.on("render-process-gone", (_e, details) =>
    trace("render process gone", JSON.stringify(details)),
  );
  contents.on("did-fail-load", (_e, code, description, url) =>
    trace("did-fail-load", code, description, url),
  );

  // A page that stops answering (a render loop, say) must show up as a failure, not as a hang.
  const run = <T>(js: string): Promise<T> =>
    Promise.race([
      contents.executeJavaScript(js, true) as Promise<T>,
      sleep(10_000).then(() => Promise.reject(new Error("the page did not answer within 10s"))),
    ]);

  const waitFor = async (what: string, js: string, ms = 20_000) => {
    const started = Date.now();
    for (;;) {
      const ok = await run<boolean>(
        `(() => { try { return Boolean(${js}); } catch { return false; } })()`,
      ).catch(() => false);
      if (ok) return;
      if (Date.now() - started > ms) throw new Error(`timed out waiting for ${what}`);
      await sleep(50);
    }
  };

  /** The centre of the first element matching, as a real click would hit it. */
  const centre = async (find: string) => {
    const point = await run<{ x: number; y: number } | null>(`(() => {
    const el = ${find};
    if (!el) return null;
    el.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
    if (point === null) throw new Error(`nothing to click: ${find}`);
    return point;
  };

  const click = async (find: string) => {
    const { x, y } = await centre(find);
    contents.sendInputEvent({ type: "mouseMove", x, y });
    contents.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
    contents.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
    await sleep(80);
  };

  /** Clicks the composer until it has the focus: a dialog that is still closing can take the click. */
  const focusComposer = async () => {
    await waitFor(
      "the dialogs to be gone",
      `!document.querySelector('[role="dialog"], [role="alertdialog"]')`,
    );
    for (let attempt = 0; attempt < 8; attempt++) {
      await click(`document.querySelector('[data-slot="composer"] textarea')`);
      const focused = await run<boolean>(
        `document.activeElement === document.querySelector('[data-slot="composer"] textarea')`,
      );
      if (focused) return;
      await sleep(250);
    }
    throw new Error("could not focus the composer");
  };

  const type = async (text: string) => {
    for (const ch of text) {
      contents.sendInputEvent({ type: "char", keyCode: ch });
      await sleep(5);
    }
  };

  const press = async (key: string) => {
    contents.sendInputEvent({ type: "keyDown", keyCode: key });
    contents.sendInputEvent({ type: "keyUp", keyCode: key });
    await sleep(50);
  };

  const byText = (selector: string, text: string) =>
    `[...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.textContent.trim() === ${JSON.stringify(text)})`;

  // Parenthesised: it is spliced into larger expressions, and `a ?? ""` binds loosely.
  const conversationText = () =>
    `(document.querySelector('[data-slot="conversation"]')?.textContent ?? "")`;

  try {
    // What the page is, before anything else.
    await waitFor("the app", `document.querySelector('[data-slot="app"]')`);
    out({
      step: "page",
      security: await run(`({
      csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content ?? null,
      nodeRequire: typeof require,
      nodeProcess: typeof process,
      bridgeKeys: Object.keys(window.cycle).sort(),
      ipcRenderer: typeof window.ipcRenderer,
    })`),
    });

    await waitFor(
      "the host to be connected",
      `document.querySelector('[data-slot="host-state"]')?.textContent === "connected"`,
    );
    out({ step: "connected" });

    // A new session, started by clicking and typing.
    await click(byText("button", "New session"));
    await waitFor("the dialog", `document.querySelector('[role="dialog"]')`);
    await click(`document.querySelector('[role="dialog"] input')`);
    await type(env.SMOKE_CWD as string);
    await click(byText('[role="dialog"] button', "Start"));
    await waitFor(
      "the composer to be ready",
      `document.querySelector('[data-slot="composer"] textarea') && !document.querySelector('[data-slot="composer"] textarea').disabled`,
    );
    out({
      step: "session",
      title: await run(`document.querySelector('[data-slot="session-header"] h1')?.textContent`),
    });

    // A message, and a streamed answer.
    await focusComposer();
    await type("Say hello.");
    out({
      step: "typed",
      active: await run(
        `document.activeElement ? document.activeElement.tagName + ':' + (document.activeElement.getAttribute('aria-label') ?? document.activeElement.getAttribute('data-slot') ?? '') : null`,
      ),
      rect: await run(
        `JSON.stringify(document.querySelector('[data-slot="composer"] textarea').getBoundingClientRect())`,
      ),
      value: await run(`document.querySelector('[data-slot="composer"] textarea').value`),
      disabled: await run(`document.querySelector('[data-slot="composer"] textarea').disabled`),
    });
    await press("Enter");
    await sleep(1500);
    out({ step: "after-enter", body: await run("document.body.innerText.slice(0, 700)") });
    await waitFor("the answer", `${conversationText()}.includes("Hello from the mock")`);
    await waitFor(
      "the turn to end",
      `!!document.querySelector('[data-slot="composer"]') && [...document.querySelectorAll('[data-slot="composer"] button')].some((b) => b.textContent.trim() === "Send")`,
    );
    out({ step: "answer", text: await run(conversationText()) });

    // A tool that needs asking: a card appears, a click answers it.
    await focusComposer();
    await type("Now touch a file.");
    await press("Enter");
    await waitFor("the permission card", `document.querySelector('[data-slot="permission"]')`);
    out({
      step: "permission",
      text: await run(`document.querySelector('[data-slot="permission"]').textContent`),
    });
    await click(byText('[data-slot="permission"] button', "Allow"));
    await waitFor("the end of that turn", `${conversationText()}.includes("All done")`);
    await waitFor("the card to go", `!document.querySelector('[data-slot="permission"]')`);
    out({ step: "allowed", text: await run(conversationText()) });

    // The page reloads: it is given the session whole, not an empty one.
    await run("location.reload()").catch(() => undefined);
    await waitFor(
      "the app again",
      `document.querySelector('[data-slot="host-state"]')?.textContent === "connected"`,
    );
    await click(`document.querySelector('[role="option"]')`);
    await waitFor(
      "the conversation back",
      `${conversationText()}.includes("Hello from the mock") && ${conversationText()}.includes("All done")`,
    );
    out({ step: "reloaded", ok: true });

    const shot = await contents.capturePage();
    await writeFile(join(env.SMOKE_HOME as string, "shot.png"), shot.toPNG());
    out({ step: "done" });
    app.exit(0);
  } catch (error) {
    out({
      step: "failed",
      error: String(error),
      text: await run(`document.body.innerText.slice(0, 2000)`).catch(() => ""),
    });
    app.exit(1);
  }
};

void main();
