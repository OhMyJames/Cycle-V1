import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UpdateState } from "@cycle/ui/api";
import { SWAP_SCRIPT, type Swap, teamOf, Updater, verifySameTeam } from "../src/main/updater.ts";
import { archiveName, manifestFor, manifestName } from "../src/shared/release.ts";

const REPO = "o/r";
const PLATFORM = { platform: "darwin", arch: "arm64" };

let dir: string;
let server: ReturnType<typeof Bun.serve>;
let base: string;
/** What the fake GitHub answers, and what was asked of it. */
const github = {
  releases: [] as unknown[],
  requests: [] as { path: string; ifNoneMatch: string | null }[],
  files: new Map<string, Uint8Array>(),
  status: 200,
  etag: '"v1"',
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cv1-updater-"));
  github.releases = [];
  github.requests = [];
  github.files = new Map();
  github.status = 200;
  github.etag = '"v1"';
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const ifNoneMatch = request.headers.get("if-none-match");
      github.requests.push({ path: url.pathname, ifNoneMatch });
      if (github.status !== 200) return new Response("no", { status: github.status });
      if (url.pathname === `/repos/${REPO}/releases`) {
        if (ifNoneMatch === github.etag) return new Response(null, { status: 304 });
        return Response.json(github.releases, { headers: { etag: github.etag } });
      }
      const file = github.files.get(url.pathname);
      return file ? new Response(Buffer.from(file)) : new Response("missing", { status: 404 });
    },
  });
  base = `http://localhost:${server.port}`;
});
afterEach(async () => {
  server.stop(true);
  await rm(dir, { recursive: true, force: true });
});

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Puts a release on the fake GitHub; its archive is these bytes. */
const publish = (
  version: string,
  options: {
    bytes?: Uint8Array;
    draft?: boolean;
    manifest?: boolean;
    claimedSha?: string;
    claimedSize?: number;
  } = {},
) => {
  const bytes = options.bytes ?? new TextEncoder().encode(`archive ${version}`);
  const manifest = manifestFor(
    { version, ...PLATFORM },
    { sha256: options.claimedSha ?? sha(bytes), size: options.claimedSize ?? bytes.length },
  );
  const tag = `v${version}`;
  const assets: unknown[] = [];
  const add = (name: string) => {
    assets.push({ name, browser_download_url: `${base}/dl/${tag}/${name}` });
  };
  add(archiveName(version, "darwin", "arm64"));
  github.files.set(`/dl/${tag}/${archiveName(version, "darwin", "arm64")}`, bytes);
  if (options.manifest !== false) {
    add(manifestName("darwin", "arm64"));
    github.files.set(
      `/dl/${tag}/${manifestName("darwin", "arm64")}`,
      new TextEncoder().encode(JSON.stringify(manifest)),
    );
  }
  github.releases.push({ tag_name: tag, draft: options.draft ?? false, assets });
};

const make = (over: Partial<ConstructorParameters<typeof Updater>[0]> = {}) => {
  const states: UpdateState[] = [];
  const log: string[] = [];
  const swaps: Swap[] = [];
  const updater = new Updater({
    current: { version: "0.1.0", ...PLATFORM },
    appPath: join(dir, "apps", "Cycle.app"),
    repo: REPO,
    apiBase: base,
    assetPrefix: `${base}/dl/`,
    fetch,
    // The archive here is not a zip; the fake unpacks a bundle of the version the manifest names.
    extract: async (_zip, into) => {
      log.push("extract");
      const app = join(into, "Cycle.app", "Contents/Resources/app");
      await mkdir(app, { recursive: true });
      const version = (await readFile(_zip, "utf8")).replace("archive ", "");
      await writeFile(join(app, "build.json"), JSON.stringify({ version, ...PLATFORM }));
    },
    beforeSwap: async () => {
      log.push("beforeSwap");
    },
    handOff: (swap) => {
      log.push("handOff");
      swaps.push(swap);
    },
    quit: () => log.push("quit"),
    emit: (state) => states.push(state),
    ...over,
  });
  return { updater, states, log, swaps };
};

test("with nothing newer it says it is up to date, and a second ask is answered by GitHub with 'not modified'", async () => {
  publish("0.1.0");
  const { updater } = make();
  expect((await updater.check(false)).kind).toBe("up-to-date");
  expect((await updater.check(false)).kind).toBe("up-to-date");
  const asks = github.requests.filter((r) => r.path.endsWith("/releases"));
  expect(asks[0]?.ifNoneMatch).toBeNull();
  expect(asks[1]?.ifNoneMatch).toBe('"v1"');
});

test("it picks the newest release, skipping drafts and releases without this platform's manifest", async () => {
  publish("0.1.1");
  publish("0.3.0", { draft: true });
  publish("0.2.0", { manifest: false });
  publish("0.1.5");
  const { updater } = make();
  const state = await updater.check(false);
  expect(state).toMatchObject({ kind: "available", version: "0.1.5" });
});

test("a release that is not newer, or whose tag is not a version, is no update", async () => {
  publish("0.0.9");
  github.releases.push({ tag_name: "nightly", draft: false, assets: [] });
  const { updater } = make();
  expect((await updater.check(false)).kind).toBe("up-to-date");
});

test("a check that fails on the timer says nothing, and one the user asked for says why", async () => {
  github.status = 403;
  const { updater, states } = make();
  await updater.check(false);
  expect(states).toEqual([]);
  const state = await updater.check(true);
  expect(state).toMatchObject({ kind: "error" });
  expect((state as { message: string }).message).toMatch(/limiting/);
  // The next good answer clears it.
  github.status = 200;
  expect((await updater.check(true)).kind).toBe("up-to-date");
});

test("it installs: downloads, checks, unpacks, stops what the old app left running, hands off and quits, in that order", async () => {
  publish("0.2.0");
  await mkdir(join(dir, "apps"), { recursive: true });
  const { updater, states, log, swaps } = make();
  await updater.check(false);
  await updater.install();
  expect(log).toEqual(["extract", "beforeSwap", "handOff", "quit"]);
  expect(states.map((s) => s.kind)).toEqual([
    "available",
    "downloading",
    "downloading",
    "installing",
  ]);
  const swap = swaps[0];
  expect(swap?.appPath).toBe(join(dir, "apps", "Cycle.app"));
  expect(existsSync(join(swap?.newApp ?? "", "Contents/Resources/app/build.json"))).toBe(true);
  // Beside the app, so the swap is a rename.
  expect(swap?.newApp.startsWith(join(dir, "apps"))).toBe(true);
});

test("an archive that does not match its checksum is not installed, and leaves nothing behind", async () => {
  publish("0.2.0", { claimedSha: "0".repeat(64) });
  await mkdir(join(dir, "apps"), { recursive: true });
  const { updater, log, states } = make();
  await updater.check(false);
  await expect(updater.install()).rejects.toThrow(/checksum/);
  expect(log).toEqual([]);
  expect(await readdir(join(dir, "apps"))).toEqual([]);
  expect(states.at(-1)).toMatchObject({ kind: "error", version: "0.2.0" });
});

test("an archive larger or smaller than its manifest says is refused", async () => {
  await mkdir(join(dir, "apps"), { recursive: true });
  publish("0.2.0", { claimedSize: 3 });
  const first = make();
  await first.updater.check(false);
  await expect(first.updater.install()).rejects.toThrow(/larger/);

  github.releases = [];
  publish("0.3.0", { claimedSize: 10_000 });
  const second = make();
  await second.updater.check(false);
  await expect(second.updater.install()).rejects.toThrow(/incomplete/);
});

test("a download outside the allowed place is refused", async () => {
  publish("0.2.0");
  const { updater } = make({ assetPrefix: "https://github.com/o/r/releases/download/" });
  const state = await updater.check(true);
  expect(state).toMatchObject({ kind: "error" });
  expect((state as { message: string }).message).toMatch(/Refused/);
});

test("a manifest for another version than its release is refused", async () => {
  publish("0.2.0");
  const other = manifestFor({ version: "0.9.0", ...PLATFORM }, { sha256: "a".repeat(64), size: 5 });
  github.files.set(
    `/dl/v0.2.0/${manifestName("darwin", "arm64")}`,
    new TextEncoder().encode(JSON.stringify(other)),
  );
  const { updater } = make();
  const state = await updater.check(true);
  expect((state as { message: string }).message).toMatch(/not for this release/);
});

test("an unpacked bundle that is not the version promised is refused before anything is touched", async () => {
  publish("0.2.0");
  await mkdir(join(dir, "apps"), { recursive: true });
  const { updater, log } = make({
    extract: async (_zip, into) => {
      const app = join(into, "Cycle.app", "Contents/Resources/app");
      await mkdir(app, { recursive: true });
      await writeFile(join(app, "build.json"), JSON.stringify({ version: "9.9.9", ...PLATFORM }));
    },
  });
  await updater.check(false);
  await expect(updater.install()).rejects.toThrow(/not the version/);
  expect(log).toEqual([]);
});

test("a folder the user cannot write to, or a translocated app, is told so before downloading", async () => {
  publish("0.2.0");
  const { updater } = make({ appPath: "/proc/nowhere/Cycle.app" });
  await updater.check(false);
  await expect(updater.install()).rejects.toThrow(/cannot replace itself/);
  const translocated = make({ appPath: "/private/var/folders/x/AppTranslocation/ABC/d/Cycle.app" });
  await translocated.updater.check(false);
  await expect(translocated.updater.install()).rejects.toThrow(/temporary read-only/);
  expect(
    github.requests.some((r) => r.path.startsWith("/dl/v0.2.0") && r.path.endsWith(".zip")),
  ).toBe(false);
});

test("there is nothing to install before something has been found, and a failed install can be tried again", async () => {
  const { updater } = make();
  await expect(updater.install()).rejects.toThrow(/no update/);
  publish("0.2.0", { claimedSha: "0".repeat(64) });
  await mkdir(join(dir, "apps"), { recursive: true });
  await updater.check(false);
  await expect(updater.install()).rejects.toThrow();
  // The timer does not wipe the error the user has not seen; their own check does.
  await updater.check(false);
  expect(updater.state.kind).toBe("error");
  expect((await updater.check(true)).kind).toBe("available");
});

test("not an installed app: nothing is asked of GitHub", async () => {
  publish("0.2.0");
  const { updater } = make({ disabled: "development" });
  updater.start();
  expect((await updater.check(true)).kind).toBe("disabled");
  await expect(updater.install()).rejects.toThrow(/development/);
  expect(github.requests).toEqual([]);
});

test("it checks at once and then every minute, and stops", async () => {
  publish("0.1.0");
  const calls: { fn: () => void; ms: number }[] = [];
  const cleared: unknown[] = [];
  const { updater } = make({
    setInterval: (fn, ms) => {
      calls.push({ fn, ms });
      return "handle";
    },
    clearInterval: (h) => cleared.push(h),
  });
  updater.start();
  expect(calls[0]?.ms).toBe(60_000);
  await Bun.sleep(100);
  expect(github.requests.length).toBe(1);
  calls[0]?.fn();
  await Bun.sleep(100);
  expect(github.requests.length).toBe(2);
  updater.stop();
  expect(cleared).toEqual(["handle"]);
});

test("a tick while a check is still going does not start another", async () => {
  publish("0.1.0");
  const { updater } = make();
  await Promise.all([updater.check(false), updater.check(false), updater.check(false)]);
  expect(github.requests.filter((r) => r.path.endsWith("/releases")).length).toBe(1);
});

// ---- the swap, run for real ----

const sh = async (script: string, args: string[]) => {
  const proc = Bun.spawn(["/bin/sh", "-c", script, "swap", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;
  return proc;
};

const bundles = async () => {
  const apps = join(dir, "apps");
  const app = join(apps, "Cycle.app");
  const staging = join(apps, ".Cycle-update-0.2.0");
  const next = join(staging, "unpacked", "Cycle.app");
  await mkdir(app, { recursive: true });
  await mkdir(next, { recursive: true });
  await writeFile(join(app, "which"), "old");
  await writeFile(join(next, "which"), "new");
  const opener = join(dir, "open");
  await writeFile(opener, `#!/bin/sh\nprintf '%s\\n' "$*" > ${dir}/opened\n`);
  await chmod(opener, 0o755);
  return { apps, app, staging, next, old: join(apps, ".Cycle-old"), opener };
};

test("the swap script waits for the old app to go, puts the new bundle in place, removes the leftovers and opens it", async () => {
  const b = await bundles();
  const sleeper = Bun.spawn(["sleep", "0.6"]);
  const started = Date.now();
  await sh(SWAP_SCRIPT, [String(sleeper.pid), b.app, b.next, b.old, b.staging, b.opener]);
  expect(Date.now() - started).toBeGreaterThanOrEqual(500);
  expect(await readFile(join(b.app, "which"), "utf8")).toBe("new");
  expect(await readdir(b.apps)).toEqual(["Cycle.app"]);
  expect((await readFile(join(dir, "opened"), "utf8")).trim()).toBe(`-n ${b.app}`);
});

test("if the new bundle cannot be put in place the old one is put back and still opened", async () => {
  const b = await bundles();
  await rm(b.next, { recursive: true });
  await sh(SWAP_SCRIPT, ["999999", b.app, b.next, b.old, b.staging, b.opener]);
  expect(await readFile(join(b.app, "which"), "utf8")).toBe("old");
  expect((await readFile(join(dir, "opened"), "utf8")).trim()).toBe(`-n ${b.app}`);
});

// ---- signatures ----

test("the team is read from codesign's listing; an ad hoc signature has none", () => {
  expect(teamOf("Identifier=dev.cycle.app\nTeamIdentifier=ABCDE12345\n")).toBe("ABCDE12345");
  expect(teamOf("Signature=adhoc\nTeamIdentifier=not set\n")).toBeUndefined();
  expect(teamOf("")).toBeUndefined();
});

test("a signed app takes only an update of the same team that verifies; an ad hoc one takes any", async () => {
  const listing = (team: string) => `TeamIdentifier=${team}\n`;
  const codesign =
    (teams: Record<string, string>, valid = true) =>
    async (args: string[]) => {
      if (args[0] === "--verify") {
        if (!valid) throw new Error("bad");
        return "";
      }
      const path = args.at(-1) ?? "";
      return teams[path] ?? "";
    };
  const ok = verifySameTeam(codesign({ cur: listing("T1"), next: listing("T1") }));
  await ok("next", "cur");
  const other = verifySameTeam(codesign({ cur: listing("T1"), next: listing("T2") }));
  await expect(other("next", "cur")).rejects.toThrow(/same team/);
  const broken = verifySameTeam(codesign({ cur: listing("T1"), next: listing("T1") }, false));
  await expect(broken("next", "cur")).rejects.toThrow(/not valid/);
  const adhoc = verifySameTeam(codesign({ cur: "TeamIdentifier=not set\n", next: listing("T2") }));
  await adhoc("next", "cur");
});
