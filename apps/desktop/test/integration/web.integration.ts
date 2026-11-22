// The app, for real, in a browser: its built page in headless Chromium, driven with the browser's own mouse and keys,
// and behind it the real ConnectionManager, the real daemon (started by `proxy`), the Claude adapter, the real Agent
// SDK and a mock API (test/web/web-app.ts). No window is opened, on any system, so it takes nobody's focus.
// Run with `bun run build` and then this file in apps/desktop, or `bun run test:integration web` at the root.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  startMock,
  textReply,
  toolReply,
} from "../../../../harness/claude/test/integration/mock-anthropic.ts";
import { built, startWebApp, until } from "../web/web-app.ts";

const daemonMain = join(new URL("../..", import.meta.url).pathname, "../daemon/src/main.ts");

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "cv1-web-"));
});
afterAll(() => rm(root, { recursive: true, force: true }));

/** The newest thing the user said, in a request to the model. */
const latestUserText = (body: unknown): string => {
  const messages = (
    (body as { messages?: { role: string; content: unknown }[] }).messages ?? []
  ).filter((m) => m.role === "user");
  const last = messages.at(-1)?.content;
  return typeof last === "string" ? last : JSON.stringify(last);
};

test.skipIf(!built)(
  "a person can use the app: connect, start a session, type and paste, chat, answer a permission, and reload",
  async () => {
    const mock = startMock((requests) => {
      const body = requests.at(-1)?.body;
      const text = latestUserText(body);
      if (JSON.stringify(body).includes("tool_result")) return textReply("All done.");
      if (text.includes("touch a file"))
        return toolReply("Bash", { command: "touch made-by-the-agent.txt" });
      return textReply("Hello from the mock.");
    });
    const data = join(root, "data");
    const home = join(root, "home");
    const cwd = join(root, "work");
    await Bun.write(join(cwd, ".keep"), "");
    await Bun.write(
      join(data, "config.json"),
      JSON.stringify({
        claude: {
          configDir: join(root, "claude"),
          env: { ANTHROPIC_BASE_URL: mock.url, ANTHROPIC_API_KEY: "mock-key-not-real" },
        },
      }),
    );
    const app = await startWebApp({
      root,
      daemon: ["bun", daemonMain],
      data,
      socket: join(root, "d.sock"),
      env: { PATH: process.env.PATH ?? "", HOME: home },
      folder: cwd,
    });
    const { page } = app;
    const box = page.locator('[data-slot="composer"] [data-slot="composer-input"]');
    const agentSaid = () =>
      page
        .locator('[data-slot="message"][data-role="agent"]')
        .allTextContents()
        .then((t) => t.join(" "));
    const sendShown = () =>
      page.locator('[data-slot="composer"]').getByRole("button", { name: "Send" }).waitFor();
    try {
      // Connected: the button that starts a session is usable.
      const newSession = page.getByRole("button", { name: "New session" }).first();
      await until(
        () => newSession.isEnabled(),
        (v) => v === true,
        30_000,
      );
      // The mode that asks first, set the way the "Agent defaults" dialog sets it: what follows answers a permission.
      await page.evaluate(() =>
        (
          window as unknown as {
            cycle: { setAgentDefaults: (e: string, a: string, d: object) => Promise<void> };
          }
        ).cycle.setAgentDefaults("local", "claude", { mode: "default" }),
      );

      // A blank conversation, whose folder is typed. Its session is made by the first message.
      await newSession.click();
      const where = page.locator('[data-slot="blank-where"] input');
      await where.click();
      await page.keyboard.type(cwd);
      await until(
        () => box.getAttribute("contenteditable"),
        (v) => v === "true",
      );

      // The box shows Markdown as it is typed, and leaves the characters of a file name alone.
      await box.click();
      await page.keyboard.type("a **bold** word, my_file.py and `code`");
      await box.locator("strong", { hasText: "bold" }).waitFor();
      await box.locator("code", { hasText: "code" }).waitFor();
      expect(await box.textContent()).toBe("a bold word, my_file.py and code");

      // Pasted text goes in as it was copied: its asterisks are the person's, not formatting nobody typed.
      await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
      await page.evaluate(() => navigator.clipboard.writeText("pasted **x** my_file.py"));
      await page.keyboard.press("ControlOrMeta+V");
      await until(
        () => box.textContent(),
        (v) => String(v).includes("pasted **x** my_file.py"),
      );
      // And is emptied again, from the keyboard.
      await page.keyboard.press("ControlOrMeta+A");
      await page.keyboard.press("Backspace");
      await until(
        () => box.textContent(),
        (v) => v === "",
      );

      // A message; the folder nobody has decided on is asked about first (docs/protocol.md §8 "信任文件夹").
      await page.keyboard.type("Say hello.");
      await page.keyboard.press("Enter");
      await page.getByRole("dialog").getByRole("button", { name: "Trust and start" }).click();
      await until(
        () => box.textContent(),
        (v) => v === "",
      );
      await until(agentSaid, (v) => String(v).includes("Hello from the mock"), 60_000);
      await sendShown();

      // A tool that needs asking: a card appears, a click answers it, and the tool really runs.
      await box.click();
      await page.keyboard.type("Now touch a file.");
      await page.keyboard.press("Enter");
      const card = page.locator('[data-slot="permission"]');
      await card.waitFor({ timeout: 60_000 });
      expect(await card.textContent()).toContain("touch made-by-the-agent.txt");
      await card.getByRole("button", { name: "Allow", exact: true }).click();
      await until(agentSaid, (v) => String(v).includes("All done"), 60_000);
      await card.waitFor({ state: "detached" });
      await sendShown();
      expect(existsSync(join(cwd, "made-by-the-agent.txt"))).toBe(true);

      // The page reloads: it is given the session whole, not an empty one.
      await page.reload();
      await until(
        () => newSession.isEnabled(),
        (v) => v === true,
        30_000,
      );
      await page.getByRole("option").first().click();
      await until(agentSaid, (v) => String(v).includes("Hello from the mock"));
      await until(agentSaid, (v) => String(v).includes("All done"));

      // The folder was trusted in the dialog: on record in the daemon, and where Claude looks for it.
      const trusted = JSON.parse(await readFile(join(data, "trust.json"), "utf8"));
      expect(Object.values(trusted.folders)).toEqual([true]);
      const claudeJson = JSON.parse(await readFile(join(root, "claude", ".claude.json"), "utf8"));
      expect(claudeJson.projects[cwd]?.hasTrustDialogAccepted).toBe(true);
    } finally {
      await page.screenshot({ path: join(root, "shot.png") }).catch(() => {});
      await app.close();
      const pid = Number((await readFile(join(data, "daemon.pid"), "utf8").catch(() => "")).trim());
      // It may be gone already, and a failure above must not be hidden behind this.
      if (pid > 0) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {}
      }
      mock.stop();
    }
  },
  120_000,
);
