// The app against a real model: the real window, driven with real mouse and keys, the daemon as the
// built executable, the Claude it ships, and a real answer. Not in `bun run test:integration`: it
// spends a little of an account's quota. Run it with:
//
//   bun run build            (in apps/desktop and in apps/daemon)
//   CYCLE_REAL_MODEL_TOKEN=<oauth token> bun test ./test/integration/real-ui.integration.ts
//
// The token goes to the daemon's config.json in a temporary directory, which is where a user puts
// it; from there only the Claude process gets it. Not the app, not the page.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canLaunch, launch } from "./launch.ts";

const token = process.env.CYCLE_REAL_MODEL_TOKEN;
const bin = new URL(
  `../../../daemon/dist/cycle-daemon-${process.platform}-${process.arch}/cycle-daemon`,
  import.meta.url,
).pathname;
const enabled = canLaunch && token !== undefined && token !== "" && existsSync(bin);

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "cv1-realui-"));
});
afterAll(() => rm(root, { recursive: true, force: true }));

test.skipIf(!enabled)(
  "a person uses the app with a real model: a streamed answer, a permission, and history after a reload",
  async () => {
    const data = join(root, "data");
    const home = join(root, "home");
    const cwd = join(root, "work");
    await Bun.write(join(cwd, ".keep"), "");
    await Bun.write(
      join(data, "config.json"),
      JSON.stringify({ claude: { env: { CLAUDE_CODE_OAUTH_TOKEN: token as string } } }),
    );
    try {
      const { exitCode, step } = await launch({
        root,
        data,
        home,
        cwd,
        daemon: [bin],
        extraEnv: { SMOKE_REAL: "1" },
        deadline: 170_000,
      });
      expect(step("failed")).toBeUndefined();
      expect(exitCode).toBe(0);
      expect(String(step("answer")?.text).toLowerCase().split("pong").length).toBeGreaterThan(2);
      expect(String(step("permission")?.text)).toContain("touch made-by-the-agent.txt");
      expect(String(step("allowed")?.text).toLowerCase()).toContain("finished");
      expect(String(step("usage")?.text)).toMatch(/\d+% of context/);
      expect(String(step("plan")?.text)).toContain("first");
      expect(String(step("plan")?.text)).toContain("second");
      expect(step("reloaded")?.ok).toBe(true);
      expect(existsSync(join(cwd, "made-by-the-agent.txt"))).toBe(true);
      expect(existsSync(join(home, "shot.png"))).toBe(true);
      // To look at what the window showed: SHOT_TO=/some/where.png
      if (process.env.SHOT_TO)
        await Bun.write(process.env.SHOT_TO, Bun.file(join(home, "shot.png")));
    } finally {
      const pid = Number((await readFile(join(data, "daemon.pid"), "utf8").catch(() => "")).trim());
      if (pid > 0) process.kill(pid, "SIGTERM");
    }
  },
  180_000,
);
