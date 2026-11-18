// `bun run check`: the gate. It must pass before any commit; the pre-commit hook runs it.
// Boundaries first (cheap), then types, lint and tests. Stops at the first failure.

import { Glob } from "bun";

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
}
if (failures.length > 0) {
  console.error(`boundaries failed:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log("boundaries ok");

const steps: [string, string[]][] = [
  ["typecheck", ["bun", "run", "typecheck"]],
  ["lint", ["bun", "run", "lint"]],
  ["test", ["bun", "test"]],
];
for (const [name, cmd] of steps) {
  console.log(`\n== ${name}`);
  const proc = Bun.spawn(cmd, { cwd: root, stdout: "inherit", stderr: "inherit" });
  if ((await proc.exited) !== 0) {
    console.error(`\ncheck failed at ${name}`);
    process.exit(1);
  }
}
console.log("\ncheck ok");
