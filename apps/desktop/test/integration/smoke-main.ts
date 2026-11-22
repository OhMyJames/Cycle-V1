// Runs inside Electron (under xvfb on Linux, hidden on macOS) in place of main.ts: it starts the real app, then
// drives the real window with real mouse and key events, and reports what it saw as JSON lines.
// The test that starts it sets everything through the environment.
import { appendFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { app, clipboard } from "electron";
import { startApp } from "../../src/main/app.ts";

/** In the page: an element's accessible name, as a person hears it (an icon-only button's comes from its tip). */
const NAME_OF =
  '((e) => e.getAttribute("aria-label") ?? (e.getAttribute("aria-labelledby") ? e.getAttribute("aria-labelledby").split(" ").map((id) => document.getElementById(id)?.textContent ?? "").join(" ").trim() : null) ?? e.textContent.trim())';

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
      ...(JSON.parse(env.SMOKE_DAEMON as string) as string[]),
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
      await click(`document.querySelector('[data-slot="composer"] [data-slot="composer-input"]')`);
      const focused = await run<boolean>(
        `document.activeElement === document.querySelector('[data-slot="composer"] [data-slot="composer-input"]')`,
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

  // By the name a person hears: the label when there is one (the sidebar's actions also show their shortcut), then what
  // names it (an icon-only button is named by its tip, through aria-labelledby), else the text.
  const byText = (selector: string, text: string) =>
    `[...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => ${NAME_OF}(e) === ${JSON.stringify(text)})`;

  // Parenthesised: it is spliced into larger expressions, and `a ?? ""` binds loosely.
  const conversationText = () =>
    `(document.querySelector('[data-slot="conversation"]')?.textContent ?? "")`;

  // Against a mock the answers are exact. Against a real model they are not: the prompts ask for one
  // word, and the page is checked for it without regard to case.
  const real = env.SMOKE_REAL === "1";
  const hello = real ? "pong" : "Hello from the mock";
  const finished = real ? "finished" : "All done";
  // What the agent said, not what the person typed: the prompt itself may contain the word.
  const agentText = `[...document.querySelectorAll('[data-slot="message"][data-role="agent"]')].map((e) => e.textContent).join(" ")`;
  const has = (text: string) =>
    `(${agentText}).toLowerCase().includes(${JSON.stringify(text.toLowerCase())})`;

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
      "a host to be connected (the New session button is on)",
      `[...document.querySelectorAll('button')].some((b) => ${NAME_OF}(b) === 'New session' && !b.disabled)`,
    );
    out({ step: "connected" });
    // Set the way the "Agent defaults" dialog sets them. The mode that asks first: what follows
    // answers a permission, and new sessions start in auto, where the action may not be asked about.
    // With a real model, the cheapest one.
    const defaults = {
      mode: "default",
      ...(real ? { model: env.SMOKE_MODEL ?? "haiku" } : {}),
    };
    await run(`window.cycle.setAgentDefaults("local", "claude", ${JSON.stringify(defaults)})`);

    // A new session: a blank conversation, whose folder is typed through its folder menu's "Enter a path…" (CYCL-55).
    // Its session is made by the first message below.
    await click(byText("button", "New session"));
    await waitFor("the blank conversation", `document.querySelector('[data-kind="blank-folder"]')`);
    await click(`document.querySelector('[data-kind="blank-folder"]')`);
    await waitFor("the folder menu", `document.querySelector('[data-kind="blank-folders"]')`);
    await click(
      `[...document.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent === "Enter a path…")`,
    );
    await waitFor(
      "the path field, focused",
      `document.activeElement?.closest('[role="dialog"]') && document.activeElement.tagName === "INPUT"`,
    );
    contents.selectAll();
    await press("Backspace");
    await type(env.SMOKE_CWD as string);
    await waitFor(
      "the path typed",
      `document.activeElement?.value === ${JSON.stringify(env.SMOKE_CWD)}`,
    );
    // A whole Enter (down, its character, up), as a keyboard sends it: the form is submitted by the character.
    contents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
    contents.sendInputEvent({ type: "char", keyCode: "\r" });
    contents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
    await waitFor(
      "the folder chosen",
      `!document.querySelector('[role="dialog"]') && document.querySelector('[data-kind="blank-folder"]:not([data-unset])')`,
    );
    await waitFor(
      "the composer to be ready",
      `document.querySelector('[data-slot="composer"] [data-slot="composer-input"]')?.getAttribute('contenteditable') === 'true'`,
    );
    out({
      step: "blank",
      title: await run(`document.querySelector('[data-slot="session-header"] h1')?.textContent`),
    });

    // The box shows Markdown as it is typed, with real key events, and sends it as it was typed.
    await focusComposer();
    await type("a **bold** word, my_file.py and `code`");
    await waitFor(
      "the formatting",
      `document.querySelector('[data-slot="composer-input"] strong')?.textContent === "bold" && document.querySelector('[data-slot="composer-input"] code')?.textContent === "code"`,
    );
    out({
      step: "markdown-typed",
      shown: await run(`document.querySelector('[data-slot="composer-input"]').textContent`),
      underscoreKept: await run(
        `document.querySelector('[data-slot="composer-input"]').textContent.includes("my_file.py")`,
      ),
    });
    // Pasted text goes in as text, as it was copied: its asterisks are the person's, not formatting nobody typed.
    clipboard.writeText("pasted **x** my_file.py");
    contents.paste();
    await waitFor(
      "the pasted text",
      `document.querySelector('[data-slot="composer-input"]').textContent.includes("pasted **x** my_file.py")`,
    );
    out({
      step: "pasted",
      shown: await run(`document.querySelector('[data-slot="composer-input"]').textContent`),
    });
    // And is emptied again, from the keyboard.
    contents.selectAll();
    await press("Backspace");
    await waitFor(
      "the box to be empty",
      `document.querySelector('[data-slot="composer-input"]').textContent === ""`,
    );

    // A message, and a streamed answer.
    await focusComposer();
    await type(real ? "Reply with exactly one word: pong" : "Say hello.");
    out({
      step: "typed",
      active: await run(
        `document.activeElement ? document.activeElement.tagName + ':' + (${NAME_OF}(document.activeElement) || document.activeElement.getAttribute('data-slot') || '') : null`,
      ),
      rect: await run(
        `JSON.stringify(document.querySelector('[data-slot="composer"] [data-slot="composer-input"]').getBoundingClientRect())`,
      ),
      value: await run(
        `document.querySelector('[data-slot="composer"] [data-slot="composer-input"]').textContent`,
      ),
      editable: await run(
        `document.querySelector('[data-slot="composer"] [data-slot="composer-input"]').getAttribute('contenteditable')`,
      ),
    });
    await press("Enter");
    // The first message makes the session; a folder nobody has decided on is asked about first (docs/protocol.md §8
    // "信任文件夹").
    await waitFor(
      "the folder trust question",
      `[...document.querySelectorAll('[role="dialog"] button')].some((b) => b.textContent === "Trust and start")`,
    );
    await click(byText('[role="dialog"] button', "Trust and start"));
    // Sent: the box is emptied. (This was a fixed wait of 1.5 s, then a look at the page for the log.)
    await waitFor(
      "the message to leave the box",
      `document.querySelector('[data-slot="composer"] [data-slot="composer-input"]').textContent === ""`,
    );
    out({ step: "after-enter", body: await run("document.body.innerText.slice(0, 700)") });
    await waitFor("the answer", has(hello), 60_000);
    await waitFor(
      "the turn to end",
      `!!document.querySelector('[data-slot="composer"]') && [...document.querySelectorAll('[data-slot="composer"] button')].some((b) => ${NAME_OF}(b) === "Send")`,
      60_000,
    );
    out({ step: "answer", text: await run(conversationText()) });

    // A tool that needs asking: a card appears, a click answers it.
    await focusComposer();
    await type(
      real
        ? "Use the Bash tool to run exactly: touch made-by-the-agent.txt  Then say: finished"
        : "Now touch a file.",
    );
    await press("Enter");
    await waitFor(
      "the permission card",
      `document.querySelector('[data-slot="permission"]')`,
      60_000,
    );
    out({
      step: "permission",
      text: await run(`document.querySelector('[data-slot="permission"]').textContent`),
    });
    await click(byText('[data-slot="permission"] button', "Allow"));
    await waitFor("the end of that turn", has(finished), 60_000);
    await waitFor("the card to go", `!document.querySelector('[data-slot="permission"]')`);
    await waitFor(
      "the turn to end",
      `[...document.querySelectorAll('[data-slot="composer"] button')].some((b) => ${NAME_OF}(b) === "Send")`,
      60_000,
    );
    out({ step: "allowed", text: await run(conversationText()) });

    if (real) {
      // What a real model writes when asked for structure: a heading, a list, a table, a code block.
      await focusComposer();
      await type(
        "Without using any tools, reply in markdown with: a level-2 heading, a bullet list of 3 items, a table of 2 columns and 2 rows, and a fenced python code block of about 12 lines defining a function with a docstring.",
      );
      await press("Enter");
      await waitFor(
        "the turn to start",
        `[...document.querySelectorAll('[data-slot="composer"] button')].some((b) => ${NAME_OF}(b) === "Stop")`,
      );
      await waitFor(
        "the turn to end",
        `[...document.querySelectorAll('[data-slot="composer"] button')].some((b) => ${NAME_OF}(b) === "Send")`,
        90_000,
      );
      out({
        step: "markdown",
        found: await run(`(() => {
          const last = [...document.querySelectorAll('[data-slot="message"][data-role="agent"]')].at(-1);
          const q = (s) => last ? last.querySelectorAll(s).length : -1;
          return { heading: q("h2"), list: q("li"), table: q("table"), pre: q("pre"), code: q("code"), coloured: q("pre span[style], pre span[class]"), html: last ? last.innerHTML.length : 0 };
        })()`),
      });
    }

    if (real) {
      // The header says how full the context is; a plan appears when Claude keeps a todo list.
      await waitFor(
        "the usage in the header",
        `document.querySelector('[data-slot="usage"]')`,
        10_000,
      );
      out({
        step: "usage",
        text: await run(`document.querySelector('[data-slot="usage"]').textContent`),
      });
      await focusComposer();
      await type(
        "Use your task tools (TaskCreate and TaskUpdate; load them with ToolSearch if needed) to create exactly two tasks, named first and second, then mark first completed. Then say: listed",
      );
      await press("Enter");
      await waitFor(
        "the turn to start",
        `[...document.querySelectorAll('[data-slot="composer"] button')].some((b) => ${NAME_OF}(b) === "Stop")`,
      );
      await waitFor(
        "the turn to end",
        `[...document.querySelectorAll('[data-slot="composer"] button')].some((b) => ${NAME_OF}(b) === "Send")`,
        90_000,
      );
      out({
        step: "plan",
        tail: (await run<string>(conversationText())).slice(-400),
        text: await run(`document.querySelector('[data-slot="plan"]')?.textContent ?? null`),
        tools: await run(
          `[...document.querySelectorAll('[data-slot="tool-name"]')].map((e) => e.textContent).join(",")`,
        ),
      });
    }

    // The page reloads: it is given the session whole, not an empty one.
    await run("location.reload()").catch(() => undefined);
    await waitFor(
      "the app again",
      `[...document.querySelectorAll('button')].some((b) => ${NAME_OF}(b) === 'New session' && !b.disabled)`,
    );
    await click(`document.querySelector('[role="option"]')`);
    await waitFor("the conversation back", `${has(hello)} && ${has(finished)}`);
    out({ step: "reloaded", ok: true });

    // The look, chosen in Settings as a person does: main makes the whole window light or dark, which the page's own
    // media query then says. The language, kept by main: after a reload the page's words are in it, without a restart.
    const dark = `matchMedia('(prefers-color-scheme: dark)').matches`;
    const theme = (name: string) =>
      `[...document.querySelectorAll('[role="radio"]')].find((r) => r.textContent === '${name}')`;
    await click(`document.querySelector('[data-kind="settings-open"]')`);
    await waitFor("the settings page", `document.querySelector('[data-kind="page"]') !== null`);
    await click(
      `[...document.querySelectorAll('[role="tab"]')].find((t) => t.textContent === 'Appearance')`,
    );
    await waitFor("the theme choice", theme("Light"));
    await click(theme("Light"));
    await waitFor("the light theme", `!${dark}`);
    await click(theme("Dark"));
    await waitFor("the dark theme", dark);
    await run(`window.cycle.setPreferences({ language: 'zh-CN' })`);
    await run("location.reload()").catch(() => undefined);
    await waitFor(
      "the app in Chinese",
      `document.documentElement.lang === 'zh-CN' && [...document.querySelectorAll('button')].some((b) => ${NAME_OF}(b) === '搜索会话')`,
    );
    out({ step: "preferences", ok: (await run<boolean>(dark)) === true });

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
