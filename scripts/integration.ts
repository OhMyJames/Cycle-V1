// `bun run test:integration`: the tests that start real processes (Claude, a daemon, Electron under
// xvfb). They are not in the gate: each takes seconds to a minute and the heaviest holds about 1.5 GB.
//
// Serial on purpose: the target is a 2-core, 4 GB machine, where running two Electron stacks at once
// would not finish sooner and could be killed for memory. Each suite has a deadline of its own, so a
// hang costs that, not the 10 minutes of a default.
//   bun run test:integration                      all of them
//   bun run test:integration smoke                only those whose name contains "smoke"
//   bun run test:integration --changed origin/main   only those the files changed since that ref can affect
//   bun run test:integration --plan --changed origin/main   say which, and why, and run nothing
//   bun run test:integration --plan --files a/b.ts c.md      the same for a list of paths
// Options: --strict (a suite that was skipped, or ran no test, fails: for a machine that is meant to have
// Electron, xvfb and sshd), --summary <file> (a markdown table of the result: CI's step summary),
// --github-output <file> (what a workflow's later steps need to know about the plan).
// The list of suites, and the rules that choose among them, are in integration-plan.ts.
// A change that cannot be compared (no such ref, no git) runs every suite.

import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decide,
  formatPlan,
  markdown,
  outcome,
  type Plan,
  plan,
  type Row,
  suites,
  workspaceGraph,
} from "./integration-plan.ts";

const root = new URL("..", import.meta.url).pathname;

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string): string | undefined => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};
const filesAt = args.indexOf("--files");
const files = filesAt === -1 ? undefined : args.slice(filesAt + 1);
const base = option("--changed");
const named = new Set(["--changed", "--summary", "--github-output"]);
const only = args.find(
  (a, i) => !a.startsWith("--") && !named.has(args[i - 1] ?? "") && (filesAt === -1 || i < filesAt),
);

const unknownChange = (why: string): Plan => ({
  everything: `the change could not be compared (${why})`,
  selected: new Map(),
  ignored: [],
});

const changedFiles = (): string[] | string => {
  if (files !== undefined) return files;
  if (base === undefined) return "no change given";
  const diff = Bun.spawnSync(["git", "diff", "--name-only", `${base}...HEAD`], {
    cwd: root,
    // A pre-commit hook has GIT_DIR in its environment; a git here must find this checkout, not the hook's.
    env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))),
  });
  if (diff.exitCode !== 0)
    return `git diff ${base}...HEAD failed: ${diff.stderr.toString().trim().split("\n")[0]}`;
  return diff.stdout.toString().split("\n").filter(Boolean);
};

const selection = (): Plan | undefined => {
  if (files === undefined && base === undefined) return undefined;
  const changed = changedFiles();
  if (typeof changed === "string") return unknownChange(changed);
  try {
    return plan(changed, workspaceGraph(root));
  } catch (error) {
    return unknownChange(error instanceof Error ? error.message : String(error));
  }
};

const planned = selection();
const everything: Plan = {
  selected: new Map(),
  ignored: [],
  everything: "no change given: all of them",
};
const chosen = decide(planned ?? everything, only);
if (planned !== undefined) console.log(`== plan\n${formatPlan(planned, chosen)}`);

if (only !== undefined && !suites.some((s) => s.name.includes(only))) {
  console.error(`no suite matches "${only}"; they are: ${suites.map((s) => s.name).join(", ")}`);
  process.exit(2);
}

const githubOutput = option("--github-output");
if (githubOutput !== undefined) {
  const needsMachine = chosen.run.some((s) => s.needs !== undefined);
  appendFileSync(
    githubOutput,
    `any=${chosen.run.length > 0}\nmachine=${needsMachine}\nsuites=${chosen.run.map((s) => s.name).join(",")}\n`,
  );
}
if (flag("--plan")) process.exit(0);

const strict = flag("--strict");
const summaryFile = option("--summary");

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

/** Passes the output on as it comes, and keeps it: bun test says at the end how many tests it skipped. */
const run = async (
  cmd: string[],
  cwd: string,
  seconds: number,
): Promise<{ code: number; timedOut: boolean; output: string }> => {
  const proc = Bun.spawn(cmd, {
    cwd: `${root}${cwd}`,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, TMPDIR: scratch },
  });
  running = proc;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill(9);
  }, seconds * 1000);
  let output = "";
  const pass = async (stream: ReadableStream<Uint8Array>, to: (text: string) => void) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      const text = decoder.decode(chunk, { stream: true });
      output += text;
      to(text);
    }
  };
  await Promise.all([
    pass(proc.stdout as ReadableStream<Uint8Array>, (t) => process.stdout.write(t)),
    pass(proc.stderr as ReadableStream<Uint8Array>, (t) => process.stderr.write(t)),
  ]);
  const code = await proc.exited;
  clearTimeout(timer);
  running = undefined;
  return { code, timedOut, output };
};

const rows: Row[] = [];
let failed = false;
const finish = () => {
  cleanUp();
  const table = suites.map(
    (s) =>
      rows.find((r) => r.name === s.name) ?? {
        name: s.name,
        status: "not selected" as const,
        reason: chosen.skipped.get(s.name),
      },
  );
  console.log(
    `\n${table
      .map(
        (r) =>
          `${r.status.padEnd(12)} ${r.name.padEnd(8)} ${r.seconds === undefined ? "" : `${r.seconds.toFixed(1)}s`}${r.reason ? `  ${r.reason}` : ""}`,
      )
      .join("\n")}`,
  );
  if (summaryFile !== undefined) appendFileSync(summaryFile, `${markdown(table)}\n`);
  process.exit(failed ? 1 : 0);
};

if (chosen.run.some((s) => s.name === "smoke")) {
  console.log("== build the desktop app");
  if ((await run(["bun", "run", "build"], "apps/desktop", 60)).code !== 0) {
    rows.push({ name: "smoke", status: "FAIL", reason: "the desktop app did not build" });
    failed = true;
    finish();
  }
}

for (const suite of chosen.run) {
  const started = Date.now();
  console.log(`\n== ${suite.name} (limit ${suite.seconds}s)`);
  const { code, timedOut, output } = await run(
    ["bun", "test", `./${suite.file}`],
    suite.cwd,
    suite.seconds,
  );
  const result = outcome({ suite, code, timedOut, output, strict });
  rows.push({
    name: suite.name,
    ...result,
    seconds: (Date.now() - started) / 1000,
  });
  if (result.status === "FAIL") failed = true;
  // A suite that was killed can leave processes behind: this run's directory says whose they are.
  Bun.spawnSync(["pkill", "-9", "-f", scratch]);
}
finish();
