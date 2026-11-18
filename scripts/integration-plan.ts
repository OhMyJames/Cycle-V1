// Which integration suites a change needs, and what a suite's result means. No process is started here: the
// runner (integration.ts) uses it, and the tests call it directly.
//
// The list of suites is the one place that says what exists. A suite is selected when a changed file is in
// the code it runs or in code that code reaches. What a package imports is in its package.json (the
// workspace dependencies), but the integration suites also START things nothing imports: the desktop app
// starts the daemon as a process, and the daemon starts the Claude adapter. Those are written down below, in
// `launches`, because no reading of imports would find them. A path the rules do not know selects every suite:
// a missed suite is a silent hole, an extra one only costs time.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type Suite = {
  name: string;
  cwd: string;
  file: string;
  seconds: number;
  /** What the machine must have for the suite to run at all; a run on a machine that should have it fails without it. */
  needs?: string;
  /** Code the suite starts as a process, which its own package does not import. */
  launches?: { dir: string; how: string }[];
};

/** The suites, in the order they run. */
export const suites: Suite[] = [
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
    needs: "sshd, ssh and ssh-keygen",
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
    needs: "xvfb on Linux",
    launches: [{ dir: "apps/daemon", how: "the app starts the daemon as a process" }],
  },
  {
    name: "smoke",
    cwd: "apps/desktop",
    file: "test/integration/smoke.integration.ts",
    seconds: 150,
    needs: "electron+xvfb",
    launches: [{ dir: "apps/daemon", how: "the app starts the daemon as a process" }],
  },
];

/** Package directory -> the package directories it depends on (dependencies and devDependencies, workspace only). */
export type Graph = Map<string, string[]>;

export const workspaceGraph = (root: string): Graph => {
  const dirs: string[] = [];
  for (const parent of ["packages", "packages/adapters", "apps"]) {
    if (!existsSync(join(root, parent))) continue;
    for (const entry of readdirSync(join(root, parent), { withFileTypes: true }))
      if (entry.isDirectory() && existsSync(join(root, parent, entry.name, "package.json")))
        dirs.push(`${parent}/${entry.name}`);
  }
  const manifests = dirs.map((dir) => ({
    dir,
    json: JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8")) as {
      name?: string;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    },
  }));
  const byName = new Map(manifests.map((m) => [m.json.name, m.dir]));
  return new Map(
    manifests.map((m) => [
      m.dir,
      Object.entries({ ...m.json.dependencies, ...m.json.devDependencies })
        .filter(([, version]) => version.startsWith("workspace:"))
        .flatMap(([name]) => byName.get(name) ?? []),
    ]),
  );
};

/** The directories a suite runs, with everything they reach, and why each is there. */
export const reach = (suite: Suite, graph: Graph): Map<string, string> => {
  const found = new Map<string, string>();
  const visit = (dir: string, why: string) => {
    if (found.has(dir)) return;
    found.set(dir, why);
    for (const dep of graph.get(dir) ?? []) visit(dep, `imported by ${dir}`);
  };
  visit(suite.cwd, "its own package");
  for (const launched of suite.launches ?? []) visit(launched.dir, launched.how);
  return found;
};

// Paths no integration suite can be affected by: documents, tools for the person, the gate's own scripts.
const NO_SUITE: [RegExp, string][] = [
  [/\.md$/, "a document"],
  [/^docs\//, "a document"],
  [/^\.(?:agents|claude|githooks)\//, "an agent skill, note or hook"],
  [/^(?:\.gitignore|\.mcp\.json|biome\.json|skills-lock\.json)$/, "editor and lint configuration"],
  [
    /^scripts\/(?:check|boundaries|release-guard|set-apple-secrets)\b/,
    "the gate's or release's own script",
  ],
  [/^\.github\/workflows\/release\.yml$/, "the release workflow"],
];
// A unit test is run by the gate. The files under test/integration are the suites' own and are not unit tests.
const UNIT_TEST = /\.(?:test\.tsx?|dom\.tsx)$/;
// Everything the suites share, so every suite: a wrong version or a changed config reaches all of them.
const EVERYTHING: [RegExp, string][] = [
  [
    /^(?:bun\.lock|package\.json|bunfig\.toml|tsconfig[^/]*\.json)$/,
    "the lockfile or a root configuration",
  ],
  [/^scripts\/integration/, "the integration runner itself"],
  [/^\.github\/workflows\/ci\.yml$/, "the CI workflow"],
];

export type Plan = {
  /** Why every suite is selected, when it is that kind of change. */
  everything?: string;
  /** Suite name -> the reasons, each "path: why". */
  selected: Map<string, string[]>;
  /** Files that select nothing, and why. */
  ignored: [string, string][];
};

export const plan = (changed: string[], graph: Graph): Plan => {
  const result: Plan = { selected: new Map(), ignored: [] };
  const packageDirs = [...graph.keys()].sort((a, b) => b.length - a.length);
  const reaches = new Map(suites.map((suite) => [suite.name, reach(suite, graph)]));
  const select = (suite: Suite, why: string) =>
    result.selected.set(suite.name, [...(result.selected.get(suite.name) ?? []), why]);

  const everything = (path: string, why: string) => {
    result.everything ??= `${path}: ${why}`;
  };

  for (const path of changed) {
    const every = EVERYTHING.find(([pattern]) => pattern.test(path));
    if (every) {
      everything(path, every[1]);
      continue;
    }
    const none = NO_SUITE.find(([pattern]) => pattern.test(path));
    if (none) {
      result.ignored.push([path, none[1]]);
      continue;
    }
    const integration = /(^|\/)test\/integration\/[^/]+\.integration\.ts$/.exec(path);
    if (integration) {
      const own = suites.find((s) => path === `${s.cwd}/${s.file}`);
      if (own) select(own, `${path}: the suite itself`);
      else result.ignored.push([path, "not in the default list of suites (it is run on purpose)"]);
      continue;
    }
    if (UNIT_TEST.test(path) && !path.includes("/test/integration/")) {
      result.ignored.push([path, "a unit test, run by the gate"]);
      continue;
    }
    const dir = packageDirs.find((d) => path.startsWith(`${d}/`));
    if (dir === undefined) {
      everything(path, "a path the plan has no rule for");
      continue;
    }
    let reached = false;
    for (const suite of suites) {
      const why = reaches.get(suite.name)?.get(dir);
      if (why !== undefined) {
        select(suite, `${path}: ${dir} is ${why}`);
        reached = true;
      }
    }
    if (!reached) result.ignored.push([path, `no suite runs or reaches ${dir}`]);
  }
  return result;
};

/** The suites to run, in their order, and for each that is not run, why. */
export const decide = (
  result: Plan,
  filter?: string,
): { run: Suite[]; skipped: Map<string, string> } => {
  const run: Suite[] = [];
  const skipped = new Map<string, string>();
  for (const suite of suites) {
    if (filter !== undefined && !suite.name.includes(filter)) {
      skipped.set(suite.name, `not selected: the name does not contain "${filter}"`);
    } else if (result.everything !== undefined || result.selected.has(suite.name)) {
      run.push(suite);
    } else {
      skipped.set(suite.name, "not selected: no changed file reaches it");
    }
  }
  return { run, skipped };
};

export const formatPlan = (result: Plan, chosen: ReturnType<typeof decide>): string => {
  const lines: string[] = [];
  if (result.everything !== undefined) lines.push(`every suite: ${result.everything}`);
  for (const suite of chosen.run) {
    lines.push(`run   ${suite.name}`);
    if (result.everything === undefined)
      for (const why of (result.selected.get(suite.name) ?? []).slice(0, 3))
        lines.push(`        ${why}`);
  }
  for (const [name, why] of chosen.skipped) lines.push(`skip  ${name}: ${why}`);
  for (const [path, why] of result.ignored.slice(0, 10)) lines.push(`      ${path}: ${why}`);
  return lines.join("\n");
};

/** What bun test says at the end: " 12 pass", " 1 skip", " 0 fail". */
export const parseSummary = (output: string): { pass: number; skip: number; fail: number } => {
  const count = (word: string) => {
    const match = new RegExp(`^\\s*(\\d+) ${word}\\s*$`, "m").exec(output);
    return match ? Number(match[1]) : 0;
  };
  return { pass: count("pass"), skip: count("skip"), fail: count("fail") };
};

export type Outcome = { status: "ok" | "FAIL" | "skip"; reason?: string };

/**
 * The exit code alone is not the result: a suite whose tests were all skipped (no Electron, no xvfb, no sshd)
 * exits 0. Where the machine is meant to have what the suite needs (`strict`, on CI), that is a failure;
 * elsewhere it is reported as skipped, with what it was waiting for.
 */
export const outcome = (input: {
  suite: Suite;
  code: number;
  timedOut: boolean;
  output: string;
  strict: boolean;
}): Outcome => {
  const { suite, code, timedOut, output, strict } = input;
  if (timedOut) return { status: "FAIL", reason: `over its limit of ${suite.seconds}s` };
  if (code !== 0) return { status: "FAIL", reason: `exit ${code}` };
  const { pass, skip } = parseSummary(output);
  const waiting = suite.needs ? `needs ${suite.needs}` : "its tests were skipped";
  if (pass === 0)
    return strict || skip === 0
      ? { status: "FAIL", reason: skip === 0 ? "no test ran" : `nothing ran: ${waiting}` }
      : { status: "skip", reason: `all tests skipped: ${waiting}` };
  if (skip > 0)
    return strict
      ? { status: "FAIL", reason: `${skip} skipped, and this machine should not: ${waiting}` }
      : { status: "ok", reason: `${skip} skipped` };
  return { status: "ok" };
};

export type Row = {
  name: string;
  status: Outcome["status"] | "not selected";
  seconds?: number | undefined;
  reason?: string | undefined;
};

export const markdown = (rows: Row[]): string =>
  [
    "| suite | result | time | reason |",
    "| --- | --- | --- | --- |",
    ...rows.map(
      (r) =>
        `| ${r.name} | ${r.status} | ${r.seconds === undefined ? "" : `${r.seconds.toFixed(1)}s`} | ${r.reason ?? ""} |`,
    ),
  ].join("\n");
