// Screenshots of the gallery: `bun packages/ui/gallery/shoot.ts [--out dir] [--themes light,dark] [--sizes 1200x800,820x600] [names...]`.
// It builds the gallery, then runs the real Electron under xvfb (as the integration tests do). Names are scenarios
// (and `tokens`); none means all. Prints what each shot found: whether the page was ready, sideways overflow, errors.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scenarios } from "./scenarios.ts";

const here = new URL(".", import.meta.url).pathname;
const argv = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : (argv[at + 1] ?? fallback);
};
const out = flag("out", join(here, "shots"));
const themes = flag("themes", "light,dark").split(",");
const sizes = flag("sizes", "1200x800").split(",");
const VALUE_FLAGS = new Set(["--out", "--themes", "--sizes"]);
const flagged = new Set(
  argv.flatMap((a, i) => (VALUE_FLAGS.has(a) ? [i, i + 1] : a.startsWith("--") ? [i] : [])),
);
const named = argv.filter((_, i) => !flagged.has(i));
const names = named.length > 0 ? named : ["tokens", ...Object.keys(scenarios)];

const electron = Array.from(
  new Bun.Glob("electron@*/node_modules/electron/dist/electron").scanSync(
    join(here, "../../../node_modules/.bun"),
  ),
)[0];
const xvfb = Bun.which("xvfb-run");
if (electron === undefined || xvfb === null) {
  console.error("needs Electron (bun install) and xvfb-run");
  process.exit(1);
}
const build = Bun.spawn(["bun", join(here, "build.ts")], { stdout: "ignore", stderr: "inherit" });
if ((await build.exited) !== 0) process.exit(1);

mkdirSync(out, { recursive: true });
const jobs = names.flatMap((name) =>
  themes.flatMap((theme) =>
    sizes.map((size) => {
      const [width, height] = size.split("x").map(Number);
      return { name, theme, width, height, out: join(out, `${name}.${theme}.${size}.png`) };
    }),
  ),
);
const jobFile = join(out, "jobs.json");
writeFileSync(jobFile, JSON.stringify(jobs));
const run = Bun.spawn(
  [
    xvfb,
    "-a",
    "-s",
    "-screen 0 1600x1200x24",
    join(here, "../../../node_modules/.bun", electron),
    "--no-sandbox",
    "--disable-gpu",
    join(here, "shoot-main.cjs"),
    jobFile,
  ],
  { stdout: "pipe", stderr: "pipe" },
);
const text = await new Response(run.stdout).text();
await run.exited;
const line = text.split("\n").find((l) => l.startsWith("REPORT "));
if (line === undefined) {
  console.error(text, await new Response(run.stderr).text());
  process.exit(1);
}
let bad = 0;
let total = 0;
for (const r of JSON.parse(line.slice(7)) as {
  name: string;
  theme: string;
  width: number;
  height: number;
  ready: boolean;
  overflow: number;
  errors: string[];
  out: string;
}[]) {
  const problems = [
    !r.ready && "not ready",
    r.overflow > 0 && `overflows by ${r.overflow}px`,
    r.errors.length > 0 && r.errors.join("; "),
  ].filter(Boolean);
  if (problems.length > 0) bad++;
  if (problems.length > 0 || argv.includes("--all"))
    console.log(
      `${problems.length > 0 ? "!" : " "} ${r.out}${problems.length > 0 ? "  " + problems.join(", ") : ""}`,
    );
  total++;
}
console.log(`${total} shots in ${out}, ${bad} with problems`);
process.exit(bad > 0 ? 1 : 0);
