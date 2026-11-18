// Screenshots of the gallery: `bun packages/ui/gallery/shoot.ts [--out dir] [--themes light,dark] [--sizes 1200x800,720x480] [names...]`.
// Builds the gallery and runs Electron on macOS or under xvfb on Linux. With no names, captures every scenario.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Scenario, scenarios } from "./scenarios.ts";

const here = new URL(".", import.meta.url).pathname;
const argv = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : (argv[at + 1] ?? fallback);
};
const out = flag("out", join(here, "shots"));
const themes = flag("themes", "light,dark").split(",");
const sizes = flag("sizes", "1200x800,720x480").split(",");
const platform = flag("platform", "");
const VALUE_FLAGS = new Set(["--out", "--themes", "--sizes", "--platform"]);
const flagged = new Set(
  argv.flatMap((a, i) => (VALUE_FLAGS.has(a) ? [i, i + 1] : a.startsWith("--") ? [i] : [])),
);
const named = argv.filter((_, i) => !flagged.has(i));
const names = named.length > 0 ? named : ["tokens", ...Object.keys(scenarios)];

const mac = process.platform === "darwin";
const bunModules = join(here, "../../../node_modules/.bun");
const binary = mac ? "Electron.app/Contents/MacOS/Electron" : "electron";
const electron = Array.from(
  new Bun.Glob(`electron@*/node_modules/electron/dist/${binary}`).scanSync(bunModules),
)[0];
const xvfb = mac ? null : Bun.which("xvfb-run");
if (electron === undefined || (!mac && xvfb === null)) {
  console.error(mac ? "needs the Electron binary" : "needs the Electron binary and xvfb-run");
  process.exit(1);
}
const build = Bun.spawn(["bun", join(here, "build.ts")], { stdout: "ignore", stderr: "inherit" });
if ((await build.exited) !== 0) process.exit(1);

mkdirSync(out, { recursive: true });
const jobs = names.flatMap((name) =>
  themes.flatMap((theme) =>
    sizes.map((size) => {
      const [width, height] = size.split("x").map(Number);
      return {
        name,
        theme,
        platform,
        tabs: (scenarios as Record<string, Scenario | undefined>)[name]?.tabs ?? 0,
        width,
        height,
        out: join(out, `${name}.${theme}.${size}.png`),
      };
    }),
  ),
);
const jobFile = join(out, "jobs.json");
writeFileSync(jobFile, JSON.stringify(jobs));
const profile = mkdtempSync(join(tmpdir(), "cycle-ui-gallery-"));
let results: string;
try {
  const command = [join(bunModules, electron)];
  if (xvfb !== null) command.unshift(xvfb, "-a", "-s", "-screen 0 1600x1200x24");
  if (!mac) command.push("--no-sandbox");
  // Screen captures do not need the GPU. macOS can drop the compositor between capturePage calls.
  command.push("--disable-gpu");
  command.push(`--user-data-dir=${profile}`, join(here, "shoot-main.cjs"), profile, jobFile);
  const run = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [text, errors, exitCode] = await Promise.all([
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
    run.exited,
  ]);
  const line = text.split("\n").find((l) => l.startsWith("REPORT "));
  if (exitCode !== 0 || line === undefined) throw new Error(`Electron: ${text}\n${errors}`);
  results = line.slice(7);
} finally {
  rmSync(profile, { recursive: true, force: true });
}
let bad = 0;
let total = 0;
for (const r of JSON.parse(results) as {
  name: string;
  theme: string;
  width: number;
  height: number;
  ready: boolean;
  overflowX: number;
  overflowY: number;
  firstSessionVisible: boolean;
  composerContrast: number | null;
  errors: string[];
  focus?: { on: string; visible?: boolean; outline?: string };
  out: string;
}[]) {
  const problems = [
    !r.ready && "not ready",
    r.overflowX > 0 && `root overflows horizontally by ${r.overflowX}px`,
    r.name !== "tokens" && r.overflowY > 0 && `root overflows vertically by ${r.overflowY}px`,
    (r.name === "session-groups" || r.name === "many-sessions") &&
      !r.firstSessionVisible &&
      "first session is clipped",
    r.composerContrast !== null &&
      r.composerContrast < 3 &&
      `composer border contrast is ${r.composerContrast.toFixed(2)}:1 (need 3:1)`,
    r.errors.length > 0 && r.errors.join("; "),
  ].filter(Boolean);
  // A tabbed shot says where the focus is, and fails if it is on a control that shows no ring.
  if (r.focus !== undefined) {
    const ringless = r.focus.visible !== true || /^none/.test(r.focus.outline ?? "none");
    console.log(
      `${ringless ? "!" : " "} ${r.name} (${r.theme}): focus on ${r.focus.on}; ${r.focus.outline ?? "no outline"}`,
    );
    if (ringless) problems.push("focus without a ring");
  }
  if (problems.length > 0) bad++;
  if (problems.length > 0 || argv.includes("--all"))
    console.log(
      `${problems.length > 0 ? "!" : " "} ${r.out}${problems.length > 0 ? `  ${problems.join(", ")}` : ""}`,
    );
  total++;
}
console.log(`${total} shots in ${out}, ${bad} with problems`);
process.exit(bad > 0 ? 1 : 0);
