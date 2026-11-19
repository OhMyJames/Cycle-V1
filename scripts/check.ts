// `bun run check`: the gate. It must pass before any commit; the pre-commit hook runs it.
// Boundaries first (cheap), then types, lint and tests. Stops at the first failure.

import { Glob } from "bun";
import { violations } from "./boundaries.ts";

const root = new URL("..", import.meta.url).pathname;

type Rule = { name: string; pattern: RegExp; allowed: (file: string) => boolean; why: string };

const rules: Rule[] = [
  {
    name: "ACP SDK only in packages/acp",
    pattern: /@agentclientprotocol\//,
    allowed: (f) => f.startsWith("packages/acp/"),
    why: "ACP v2 is a draft; every other package imports `@cycle/acp` so a change lands in one place.",
  },
  {
    name: "no Bun APIs where Node runs",
    pattern: /\bBun\./,
    allowed: (f) =>
      !(
        f.startsWith("packages/client/src/") ||
        f === "packages/transport/src/client.ts" ||
        f === "packages/transport/src/channel.ts" ||
        f.startsWith("packages/ui/src/") ||
        f.startsWith("apps/desktop/src/")
      ),
    why: "Electron's main process is Node. Use node: modules there (see packages/transport/src/client.ts).",
  },
  {
    name: "no suppressed checks",
    pattern: /@ts-ignore|@ts-expect-error|biome-ignore/,
    allowed: (f) => f === "scripts/check.ts",
    why: "fix the cause, or change the rule on purpose.",
  },
];

const sources = new Glob("{packages,apps,scripts}/**/*.{ts,tsx,json}");
const failures: string[] = [];
for await (const file of sources.scan({ cwd: root })) {
  if (file.includes("node_modules/")) continue;
  const text = await Bun.file(root + file).text();
  for (const rule of rules) {
    if (!rule.allowed(file) && rule.pattern.test(text)) {
      failures.push(`${file}: ${rule.name} (${rule.why})`);
    }
  }
  failures.push(...violations(file, text));
}
// DESIGN.md and the stylesheet agree on the --cycle-* tokens: one that is written and not defined is a promise
// nothing keeps, and one that is defined and not written is a decision nobody can see.
{
  const design = await Bun.file(`${root}DESIGN.md`).text();
  const css = await Bun.file(`${root}packages/ui/src/styles/app.css`).text();
  const named = new Set(design.match(/--cycle-[a-z-]+/g) ?? []);
  const defined = new Set(
    Array.from(css.matchAll(/^\s*(--cycle-[a-z-]+)\s*:/gm), (m) => m[1] as string),
  );
  for (const token of named)
    if (!defined.has(token))
      failures.push(`DESIGN.md names ${token}, which app.css does not define`);
  for (const token of defined)
    if (!named.has(token))
      failures.push(`app.css defines ${token}, which DESIGN.md does not mention`);
}

// The dictionary of analytics events and its document agree: an event nobody wrote down is one nobody can review for what it
// sends, and one written down that is not in the dictionary is a promise nothing keeps.
{
  const { EVENTS } = await import("../packages/analytics/src/events.ts");
  const document = await Bun.file(`${root}docs/analytics.md`).text();
  const written = new Set(
    Array.from(document.matchAll(/^\| `([a-z_]+)`/gm), (m) => m[1] as string),
  );
  for (const name of Object.keys(EVENTS))
    if (!written.has(name))
      failures.push(
        `packages/analytics/src/events.ts has ${name}, which docs/analytics.md does not list`,
      );
  for (const name of written)
    if (!(name in EVENTS))
      failures.push(`docs/analytics.md lists ${name}, which the dictionary does not have`);
}

// New interface text goes in the message catalog, not in the markup (decision 0012). The count of what is still in the markup
// may only go down; the script says which file got worse.
{
  const ratchet = Bun.spawnSync(
    ["bun", `${root}.claude/skills/cycle-design-taste/scripts/scan-copy.mjs`, "--i18n"],
    { cwd: root },
  );
  if (ratchet.exitCode !== 0)
    failures.push(`i18n:\n${new TextDecoder().decode(ratchet.stdout).trim()}`);
}

if (failures.length > 0) {
  console.error(`boundaries failed:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log("boundaries ok");

// The interface's tests need a browser's globals, which would break the other tests if every test had
// them, so they are named *.dom.tsx and run on their own, with happy-dom preloaded.
const domTests = Array.from(new Glob("packages/ui/test/dom/*.dom.tsx").scanSync({ cwd: root })).map(
  (file) => `./${file}`,
);

const steps: [string, string[]][] = [
  ["css", ["bun", "run", "--cwd", "packages/ui", "build:css"]],
  ["typecheck", ["bun", "run", "typecheck"]],
  ["lint", ["bun", "run", "lint"]],
  ["test", ["bun", "test"]],
  ["test (dom)", ["bun", "test", "--preload", "./packages/ui/test/dom/setup.ts", ...domTests]],
];
const timings: string[] = [];
for (const [name, cmd] of steps) {
  console.log(`\n== ${name}`);
  const started = Date.now();
  const proc = Bun.spawn(cmd, { cwd: root, stdout: "inherit", stderr: "inherit" });
  if ((await proc.exited) !== 0) {
    console.error(`\ncheck failed at ${name}`);
    process.exit(1);
  }
  timings.push(`${name} ${((Date.now() - started) / 1000).toFixed(1)}s`);
}
console.log(`\n${timings.join("  ")}`);
console.log("\ncheck ok");
