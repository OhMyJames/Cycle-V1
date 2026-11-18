// The packaged app, as a user's machine would run it: assembled by scripts/package.ts, started with a
// bare environment (no bun, no node on PATH, no repository), under xvfb. It must find the daemon and
// Claude inside itself, and start the daemon. Linux stands in for the macOS bundle here: same layout,
// same code; what differs (Info.plist, signing) is tested elsewhere or on the macOS runner.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageApp } from "../../scripts/package.ts";

const ready = process.platform === "linux" && Bun.which("xvfb-run") !== null;

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "cv1-packaged-"));
});
afterAll(() => rm(root, { recursive: true, force: true }));

test.skipIf(!ready)(
  "the packaged app starts the daemon it carries, with nothing of the repository around",
  async () => {
    const packaged = packageApp(join(root, "build"));
    expect(existsSync(join(packaged.appDir, "build.json"))).toBe(true);
    expect(existsSync(join(packaged.appDir, "bin/claude"))).toBe(true);

    const data = join(root, "data");
    const proc = Bun.spawn(
      [
        "xvfb-run",
        "-a",
        packaged.executable,
        "--no-sandbox",
        "--disable-gpu",
        `--user-data-dir=${join(root, "electron")}`,
      ],
      {
        env: { PATH: "/usr/bin:/bin", HOME: root, CYCLE_V1_HOME: data },
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    try {
      const socket = join(data, "daemon.sock");
      const started = Date.now();
      while (!existsSync(socket)) {
        if (Date.now() - started > 30_000)
          throw new Error("the packaged app did not start a daemon");
        await Bun.sleep(100);
      }
      const pid = Number((await Bun.file(join(data, "daemon.pid")).text()).trim());
      // The process that is serving is the one inside the app.
      const link = await readlink(`/proc/${pid}/exe`);
      expect(link).toBe(join(packaged.appDir, "bin/cycle-daemon"));
      process.kill(pid, "SIGTERM");
    } finally {
      proc.kill();
      await proc.exited;
    }
  },
  120_000,
);
