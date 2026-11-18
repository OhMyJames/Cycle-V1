// The app updating itself, for real, on macOS: an installed copy of the app that was just built finds
// a newer release (served from this machine, standing in for GitHub), downloads it, swaps the bundle
// and opens itself again as the new version, and the daemon the old one started is gone.
//
// Nothing here touches this Mac's own data: the app's data directory is a temporary one, set for the
// relaunched app too through launchd (an app opened by `open` does not inherit this process's
// environment), and removed afterwards.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanBundle } from "../../src/main/delta.ts";
import { archiveName, manifestFor, manifestName, RELEASE_REPO } from "../../src/shared/release.ts";
import { evaluate } from "./cdp.ts";

const given = process.env.CYCLE_PACKAGED_APP;
const ready = process.platform === "darwin" && given !== undefined;

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "cv1-update-"));
});
afterAll(() => rm(root, { recursive: true, force: true }));

const run = (command: string[]) => {
  const result = Bun.spawnSync(command);
  if (!result.success) throw new Error(`${command.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString();
};
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async <T>(
  what: string,
  ms: number,
  probe: () => Promise<T | undefined> | T | undefined,
) => {
  const started = Date.now();
  for (;;) {
    const value = await Promise.resolve(probe()).catch(() => undefined);
    if (value !== undefined) return value;
    if (Date.now() - started > ms) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(250);
  }
};

test.skipIf(!ready)(
  "an installed app updates itself to a newer release and opens again as it",
  async () => {
    const source = given as string;
    const installed = join(root, "apps", "Cycle.app");
    const next = join(root, "next", "Cycle.app");
    const resources = "Contents/Resources/app";
    await mkdir(join(root, "apps"), { recursive: true });
    await mkdir(join(root, "next"), { recursive: true });
    run(["/bin/cp", "-cR", source, installed]);
    run(["/bin/cp", "-cR", source, next]);

    // A newer build: the same app with its version raised, signed again as ad hoc as the build is.
    const info = JSON.parse(await readFile(join(installed, resources, "build.json"), "utf8")) as {
      version: string;
      platform: string;
      arch: string;
    };
    const [major, minor, patch] = info.version.split(".").map(Number);
    const newer = `${major}.${minor}.${(patch ?? 0) + 1}`;
    for (const file of ["build.json", "package.json"]) {
      const path = join(next, resources, file);
      const json = JSON.parse(await readFile(path, "utf8"));
      await writeFile(path, `${JSON.stringify({ ...json, version: newer }, null, 2)}\n`);
    }
    run(["/usr/bin/codesign", "--force", "--deep", "--sign", "-", next]);
    const zip = join(root, archiveName(newer, info.platform, info.arch));
    run(["/usr/bin/ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", next, zip]);
    const bytes = await readFile(zip);
    // With the file table, as the release has it: the installed app takes what it has, and fetches the rest.
    const manifest = manifestFor(
      { version: newer, platform: info.platform, arch: info.arch },
      { sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length },
      await scanBundle(next),
    );
    // What was asked of the archive: its end, and then only the files that are not in the installed app.
    let ranged = 0;
    const files: Record<string, Uint8Array | string> = {
      [`/dl/${archiveName(newer, info.platform, info.arch)}`]: bytes,
      [`/dl/${manifestName(info.platform, info.arch)}`]: JSON.stringify(manifest),
    };
    const server = Bun.serve({
      port: 0,
      fetch(request): Response {
        const url = new URL(request.url);
        if (url.pathname === `/repos/${RELEASE_REPO}/releases`) {
          return Response.json([
            {
              tag_name: `v${newer}`,
              draft: false,
              assets: Object.keys(files).map((path) => ({
                name: path.split("/").at(-1),
                browser_download_url: `${url.origin}${path}`,
              })),
            },
          ]);
        }
        const body = files[url.pathname];
        if (body === undefined) return new Response("missing", { status: 404 });
        if (typeof body === "string") return new Response(body);
        const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.get("range") ?? "");
        if (range === null) return new Response(Buffer.from(body));
        const start = Number(range[1]);
        const end = Math.min(Number(range[2]), body.length - 1);
        ranged += end - start + 1;
        return new Response(Buffer.from(body.subarray(start, end + 1)), {
          status: 206,
          headers: { "content-range": `bytes ${start}-${end}/${body.length}` },
        });
      },
    });

    const data = join(root, "data");
    const url = `http://127.0.0.1:${server.port}`;
    const port = 20000 + Math.floor(Math.random() * 20000);
    const environment = { CYCLE_HOME: data, CYCLE_UPDATE_URL: url };
    const exe = join(installed, "Contents/MacOS/Electron");
    let old: ReturnType<typeof Bun.spawn> | undefined;
    try {
      // What `open` starts does not get this process's environment; launchd's is where it can be set.
      for (const [key, value] of Object.entries(environment))
        run(["/bin/launchctl", "setenv", key, value]);
      old = Bun.spawn(
        [
          exe,
          "--disable-gpu",
          `--remote-debugging-port=${port}`,
          `--user-data-dir=${join(root, "electron")}`,
        ],
        {
          env: { PATH: "/usr/bin:/bin", HOME: root, ...environment },
          stdout: "ignore",
          stderr: "ignore",
        },
      );
      const line = await until("the update to be offered", 60_000, () =>
        evaluate(
          port,
          "document.querySelector('[data-slot=\"update-line\"]')?.textContent ?? null",
        ).then((text) => (typeof text === "string" && text.includes(newer) ? text : undefined)),
      );
      expect(line).toBe(`Version ${newer} is available`);
      const oldDaemon = await until("the old app's daemon", 45_000, async () => {
        const pid = Number((await readFile(join(data, "daemon.pid"), "utf8")).trim());
        return Number.isInteger(pid) && alive(pid) ? pid : undefined;
      });

      // The button asks first; here the answer is given straight to main, as the dialog's would.
      await evaluate(port, "void window.cycle.installUpdate(); 1");

      await until("the old app to quit", 120_000, () => (alive(old?.pid ?? 0) ? undefined : true));
      // The bundle in place is the new one, opened again.
      const installedVersion = await until("the new bundle", 60_000, async () => {
        const text = await readFile(join(installed, resources, "build.json"), "utf8");
        return JSON.parse(text).version === newer ? newer : undefined;
      });
      expect(installedVersion).toBe(newer);
      // It was done by the difference: the files that changed (the version files, the signature) came
      // over, not the Electron framework or Claude. The archive's end is read first, which is a few hundred KB.
      expect(ranged).toBeGreaterThan(0);
      expect(ranged).toBeLessThan(bytes.length / 4);
      const reopened = await until("the app to open again", 60_000, () => {
        const ps = Bun.spawnSync(["/usr/bin/pgrep", "-f", `${installed}/Contents/MacOS/Electron`]);
        const pid = Number(ps.stdout.toString().split("\n")[0]);
        return Number.isInteger(pid) && pid > 0 && pid !== old?.pid ? pid : undefined;
      });
      expect(alive(reopened)).toBe(true);
      // The daemon the old app started is gone (the new one may be starting its own).
      await until("the old daemon to stop", 30_000, () => (alive(oldDaemon) ? undefined : true));
      // And nothing of the update is left beside the app.
      expect(await readdir(join(root, "apps"))).toEqual(["Cycle.app"]);
      expect(existsSync(join(root, "apps", ".Cycle-old"))).toBe(false);
    } finally {
      for (const key of Object.keys(environment))
        Bun.spawnSync(["/bin/launchctl", "unsetenv", key]);
      server.stop(true);
      old?.kill();
      // Whatever of the app, new or old, runs from the test's own folder, and the daemon it started.
      Bun.spawnSync(["/usr/bin/pkill", "-f", join(root, "apps")]);
      try {
        process.kill(Number((await readFile(join(data, "daemon.pid"), "utf8")).trim()), "SIGTERM");
      } catch {}
    }
  },
  360_000,
);
