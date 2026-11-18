// `bun run test:integration`: the tests that start real processes (Claude, a daemon, Electron under
// xvfb). They are not in the gate: each takes seconds to a minute and the heaviest holds about 1.5 GB.
//
// Serial on purpose: the target is a 2-core, 4 GB machine, where running two Electron stacks at once
// would not finish sooner and could be killed for memory. Each suite has a deadline of its own, so a
// hang costs that, not the 10 minutes of a default.
//   bun run test:integration            all of them
//   bun run test:integration smoke      only those whose name contains "smoke"

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;

type Suite = { name: string; cwd: string; file: string; seconds: number; needs?: string };

const suites: Suite[] = [
  {
    name: "node",
    cwd: "packages/client",
    file: "test/integration/node.integration.ts",
    seconds: 60,
    needs: "electron",
  },
  {
    name: "adapter",
    cwd: "packages/adapters/claude",
    file: "test/integration/adapter.integration.ts",
    seconds: 90,
  },
  {
    name: "ssh",
    cwd: "apps/daemon",
    file: "test/integration/ssh.integration.ts",
    seconds: 60,
  },
  {
    name: "backend",
    cwd: "apps/daemon",
    file: "test/integration/full.integration.ts",
    seconds: 120,
  },
  {
    name: "package",
    cwd: "apps/desktop",
    file: "test/integration/packaged.integration.ts",
    seconds: 90,
  },
  {
    name: "smoke",
    cwd: "apps/desktop",
    file: "test/integration/smoke.integration.ts",
    seconds: 150,
    needs: "electron+xvfb",
  },
];

const only = process.argv[2];
const chosen = suites.filter((s) => only === undefined || s.name.includes(only));
if (chosen.length === 0) {
  console.error(`no suite matches "${only}"; they are: ${suites.map((s) => s.name).join(", ")}`);
  process.exit(2);
}

// Every temporary directory a suite makes is under this run's own: a process that a killed suite leaves
// behind has it in its command line, so it is found by that and by nothing else. Another checkout's run, or
// the person's own app, is not matched by a pattern that happens to look like it.
// The name is short: a unix socket's path has about 100 characters on macOS, and a suite's temporary directory is under this.
const scratch = mkdtempSync(join(tmpdir(), "cv1-r-"));
let running: ReturnType<typeof Bun.spawn> | undefined;
const cleanUp = () => {
  // The suite itself has this directory in its environment, not on its command line.
  running?.kill(9);
  Bun.spawnSync(["pkill", "-9", "-f", scratch]);
  try {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {}
};
for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
  ["SIGHUP", 129],
] as const)
  process.on(signal, () => {
    cleanUp();
    process.exit(code);
  });

const run = async (cmd: string[], cwd: string, seconds: number): Promise<number> => {
  const proc = Bun.spawn(cmd, {
    cwd: `${root}${cwd}`,
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, TMPDIR: scratch },
  });
  running = proc;
  const timer = setTimeout(() => proc.kill(9), seconds * 1000);
  const code = await proc.exited;
  clearTimeout(timer);
  running = undefined;
  return code;
};

if (chosen.some((s) => s.name === "smoke")) {
  console.log("== build the desktop app");
  if ((await run(["bun", "run", "build"], "apps/desktop", 60)) !== 0) process.exit(1);
}

const results: string[] = [];
let failed = false;
for (const suite of chosen) {
  const started = Date.now();
  console.log(`\n== ${suite.name} (limit ${suite.seconds}s)`);
  const code = await run(["bun", "test", `./${suite.file}`], suite.cwd, suite.seconds);
  const took = ((Date.now() - started) / 1000).toFixed(1);
  results.push(`${code === 0 ? "ok  " : "FAIL"} ${suite.name.padEnd(8)} ${took}s`);
  if (code !== 0) failed = true;
  // A suite that was killed can leave processes behind: this run's directory says whose they are.
  Bun.spawnSync(["pkill", "-9", "-f", scratch]);
}
cleanUp();
console.log(`\n${results.join("\n")}`);
process.exit(failed ? 1 : 0);
