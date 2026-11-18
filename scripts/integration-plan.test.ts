import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decide,
  diffArgs,
  type Graph,
  markdown,
  outcome,
  parseSummary,
  plan,
  suites,
  workspaceGraph,
} from "./integration-plan.ts";

const root = new URL("..", import.meta.url).pathname;
const graph = workspaceGraph(root);
const names = (paths: string[]) => decide(plan(paths, graph)).run.map((s) => s.name);
const ALL = suites.map((s) => s.name);

describe("the list of suites", () => {
  test("is what integration.ts runs, in order, and every suite's file exists", () => {
    expect(ALL).toEqual(["node", "adapter", "ssh", "backend", "package", "smoke"]);
    for (const suite of suites)
      expect(() => readFileSync(`${root}${suite.cwd}/${suite.file}`)).not.toThrow();
  });

  test("the documents count the same suites", () => {
    expect(readFileSync(`${root}AGENTS.md`, "utf8")).toContain(`串行跑 ${ALL.length} 个套件`);
    expect(readFileSync(`${root}docs/testing.md`, "utf8")).toContain(`${ALL.length} 个套件`);
  });
});

describe("the workspace graph", () => {
  test("reads who depends on whom, devDependencies too", () => {
    expect(graph.get("apps/daemon")).toContain("packages/adapters/claude");
    expect(graph.get("apps/desktop")).toContain("packages/ui");
    expect(graph.get("apps/desktop")).toContain("packages/daemon");
    expect(graph.get("packages/acp")).toEqual([]);
  });
});

// [what changed, the suites that must run, the ones that must not]
const table: [string, string[], string[], string[]][] = [
  ["an adapter source file", ["packages/adapters/claude/src/index.ts"], ["adapter", "backend"], []],
  [
    "the protocol package",
    ["packages/protocol/src/index.ts"],
    ["node", "ssh", "backend", "package", "smoke"],
    ["adapter"],
  ],
  [
    "the daemon library",
    ["packages/daemon/src/daemon.ts"],
    ["node", "backend", "ssh"],
    ["adapter"],
  ],
  [
    "the daemon app",
    ["apps/daemon/src/main.ts"],
    ["ssh", "backend", "package", "smoke"],
    ["node", "adapter"],
  ],
  [
    "the interface",
    ["packages/ui/src/react/app.tsx"],
    ["package", "smoke"],
    ["node", "adapter", "ssh", "backend"],
  ],
  [
    "the desktop renderer",
    ["apps/desktop/src/renderer/main.tsx"],
    ["package", "smoke"],
    ["node", "adapter", "backend"],
  ],
  ["the client", ["packages/client/src/client.ts"], ["node", "backend"], ["adapter"]],
  [
    "a suite's own file",
    ["apps/daemon/test/integration/ssh.integration.ts"],
    ["ssh"],
    ["backend", "node", "smoke"],
  ],
  [
    "a helper the desktop suites share",
    ["apps/desktop/test/integration/launch.ts"],
    ["package", "smoke"],
    ["node", "backend"],
  ],
  [
    "a helper another package's suite imports",
    ["packages/daemon/test/fake-agent.ts"],
    ["node"],
    ["adapter"],
  ],
  ["a document", ["docs/testing.md", "README.md", "packages/ui/AGENTS.md"], [], ALL],
  ["a unit test", ["packages/ui/test/store.test.ts", "packages/ui/test/dom/app.dom.tsx"], [], ALL],
  [
    "the gate's own scripts",
    ["scripts/check.ts", "scripts/boundaries.ts", "scripts/release-guard.ts"],
    [],
    ALL,
  ],
  [
    "a suite that is run on purpose",
    ["packages/adapters/claude/test/integration/real-model.integration.ts"],
    [],
    ALL,
  ],
  [
    "two changes together",
    ["docs/a.md", "packages/adapters/claude/src/x.ts"],
    ["adapter", "backend"],
    ["node"],
  ],
];

describe("which suites a change selects", () => {
  test.each(table)("%s", (_what, paths, mustRun, mustNot) => {
    const run = names(paths);
    for (const name of mustRun) expect(run).toContain(name);
    for (const name of mustNot) expect(run).not.toContain(name);
  });
});

describe("a change that cannot be placed runs everything", () => {
  test.each([
    "bun.lock",
    "package.json",
    "tsconfig.base.json",
    "bunfig.toml",
    "scripts/integration.ts",
    "scripts/integration-plan.ts",
    ".github/workflows/ci.yml",
    "somewhere/new/file.ts",
    "packages/not-a-package-yet/src/x.ts",
    "Makefile",
  ])("%s", (path) => {
    const result = plan([path], graph);
    expect(result.everything).toBeDefined();
    expect(decide(result).run.map((s) => s.name)).toEqual(ALL);
  });

  test("one such path among documents is enough", () => {
    expect(names(["docs/a.md", "bun.lock"])).toEqual(ALL);
  });
});

describe("the reasons", () => {
  test("say which file reached the suite and how", () => {
    const result = plan(["packages/adapters/claude/src/x.ts"], graph);
    expect(result.selected.get("backend")?.[0]).toContain("packages/adapters/claude/src/x.ts");
    expect(result.selected.get("backend")?.[0]).toContain("imported by apps/daemon");
    expect(plan(["apps/desktop/src/main/app.ts"], graph).selected.get("smoke")?.[0]).toContain(
      "its own package",
    );
  });

  test("a suite the desktop app starts as a process is reached through launches, not imports", () => {
    // apps/daemon is not in apps/desktop's package.json.
    expect(graph.get("apps/desktop")).not.toContain("apps/daemon");
    const result = plan(["apps/daemon/src/main.ts"], graph);
    expect(result.selected.get("smoke")?.[0]).toContain("starts the daemon as a process");
  });

  test("a file no suite reaches is said to be ignored, with the reason", () => {
    const alone: Graph = new Map([...graph, ["packages/orphan", []]]);
    const result = plan(["packages/orphan/src/x.ts"], alone);
    expect(result.ignored[0]?.[1]).toContain("no suite runs or reaches packages/orphan");
    expect(decide(result).run).toEqual([]);
  });

  test("the name filter narrows the choice, and says so", () => {
    const chosen = decide(plan(["bun.lock"], graph), "smoke");
    expect(chosen.run.map((s) => s.name)).toEqual(["smoke"]);
    expect(chosen.skipped.get("node")).toContain('does not contain "smoke"');
  });
});

describe("the result of a suite", () => {
  const suite = suites.find((s) => s.name === "smoke");
  if (!suite) throw new Error("no smoke suite");
  const bun = (pass: number, skip: number, fail = 0) =>
    ` ${pass} pass\n ${skip} skip\n ${fail} fail\n 3 expect() calls\nRan ${pass + skip + fail} tests across 1 file.`;
  const base = { suite, code: 0, timedOut: false, strict: false };

  test("reads bun's summary, without colours, and the last of two", () => {
    expect(parseSummary("\x1b[32m 4 pass\x1b[0m\n\x1b[2m 1 skip\x1b[0m\n 0 fail")).toEqual({
      pass: 4,
      skip: 1,
      fail: 0,
    });
    expect(parseSummary(" 9 pass\nlater: a test printed this\n 2 pass\n 0 fail").pass).toBe(2);
  });

  test("reads bun's summary", () => {
    expect(parseSummary(bun(4, 1, 2))).toEqual({ pass: 4, skip: 1, fail: 2 });
    expect(parseSummary("nothing here")).toEqual({ pass: 0, skip: 0, fail: 0 });
  });

  test("a pass is ok", () => {
    expect(outcome({ ...base, output: bun(3, 0) })).toEqual({ status: "ok" });
  });

  test("a suite that skipped everything is skipped, with what it needed, not ok", () => {
    const result = outcome({ ...base, output: bun(0, 1) });
    expect(result.status).toBe("skip");
    expect(result.reason).toContain("electron+xvfb");
  });

  test("on a machine that should have it, the same is a failure", () => {
    const result = outcome({ ...base, strict: true, output: bun(0, 1) });
    expect(result.status).toBe("FAIL");
    expect(result.reason).toContain("electron+xvfb");
  });

  test("some skipped: ok on a person's machine, a failure where strict", () => {
    expect(outcome({ ...base, output: bun(2, 1) }).status).toBe("ok");
    expect(outcome({ ...base, strict: true, output: bun(2, 1) }).status).toBe("FAIL");
  });

  test("no test at all is a failure, even outside strict", () => {
    expect(outcome({ ...base, output: bun(0, 0) }).status).toBe("FAIL");
    expect(outcome({ ...base, output: "" }).status).toBe("FAIL");
  });

  test("a failed exit, and a time-out, are failures that say which", () => {
    expect(outcome({ ...base, code: 1, output: bun(1, 0, 1) })).toEqual({
      status: "FAIL",
      reason: "exit 1",
    });
    expect(outcome({ ...base, code: 137, timedOut: true, output: "" }).reason).toContain(
      "over its limit of 150s",
    );
  });

  test("the table has a row per suite with its result and reason", () => {
    const table = markdown([
      { name: "node", status: "ok", seconds: 2.34 },
      { name: "smoke", status: "skip", reason: "needs electron" },
      { name: "ssh", status: "not selected", reason: "no changed file reaches it" },
    ]);
    expect(table).toContain("| node | ok | 2.3s |  |");
    expect(table).toContain("| smoke | skip |  | needs electron |");
    expect(table).toContain("| ssh | not selected |  | no changed file reaches it |");
  });
});

describe("the CI workflow", () => {
  const ci = readFileSync(`${root}.github/workflows/ci.yml`, "utf8");
  const job = ci.slice(ci.indexOf("  integration:"));

  test("the integration job runs on pull requests, with the whole history, and compares with the base", () => {
    expect(ci).toMatch(/^on:[\s\S]*\n {2}pull_request:/m);
    // Not on a push to main: that is what the check job is for; the nightly run is all of them.
    expect(job).toMatch(
      /^ {4}if: github\.event_name == 'pull_request' \|\| github\.event_name == 'workflow_dispatch' \|\| github\.event_name == 'schedule'$/m,
    );
    expect(job).toContain("fetch-depth: 0");
    expect(job).toContain("--changed origin/{0}', github.base_ref");
  });

  test("the plan comes first, before anything is installed, and what is installed depends on it", () => {
    const at = (text: string) => job.indexOf(text);
    expect(at("--plan $CHANGED --github-output")).toBeGreaterThan(-1);
    expect(at("--plan $CHANGED")).toBeLessThan(at("bun install"));
    for (const step of [
      "bun install",
      "install.js",
      "apt-get install",
      "test:integration $CHANGED",
    ]) {
      const rest = job.slice(at(step));
      const stepText = rest.slice(0, rest.search(/\n {6}- /));
      expect(
        stepText +
          job
            .slice(at(step) - 200, at(step))
            .split("\n      - ")
            .pop(),
      ).toContain("if: steps.plan.outputs.");
    }
  });

  test("the run is strict and writes the step summary", () => {
    expect(job).toContain('test:integration $CHANGED --strict --summary "$GITHUB_STEP_SUMMARY"');
  });
});

const cleanEnv = () =>
  Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));

describe("the command line", () => {
  const cli = (...args: string[]) =>
    Bun.spawnSync(["bun", `${root}scripts/integration.ts`, ...args], {
      cwd: root,
      env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))),
    });

  test("--plan prints the choice and runs nothing", () => {
    const out = cli("--plan", "--files", "packages/adapters/claude/src/x.ts", "docs/a.md");
    const text = out.stdout.toString();
    expect(out.exitCode).toBe(0);
    expect(text).toContain("run   adapter");
    expect(text).toContain("run   backend");
    expect(text).toContain("skip  node: not selected");
    expect(text).toContain("docs/a.md: a document");
    expect(text).not.toContain("== adapter");
  });

  test("a ref that cannot be compared selects everything, and says why", () => {
    const out = cli("--plan", "--changed", "no-such-ref-anywhere");
    const text = out.stdout.toString();
    expect(out.exitCode).toBe(0);
    expect(text).toContain("every suite: the change could not be compared");
    for (const name of ALL) expect(text).toContain(`run   ${name}`);
  });

  test("an option with no value, or written with =, is refused, not turned into a full run", () => {
    expect(cli("--plan", "--changed").exitCode).toBe(2);
    expect(cli("--plan", "--changed", "--strict").exitCode).toBe(2);
    expect(cli("--plan", "--changed=origin/main").exitCode).toBe(2);
    expect(cli("--plan", "--summary").exitCode).toBe(2);
  });

  test("a file moved out of a package is a change to the package it left: the diff is without renames", () => {
    const repo = mkdtempSync(join(tmpdir(), "cv1-plan-"));
    const git = (...a: string[]) => {
      const out = Bun.spawnSync(["git", "-C", repo, ...a], { env: cleanEnv() });
      if (out.exitCode !== 0) throw new Error(out.stderr.toString());
      return out.stdout.toString();
    };
    try {
      git("init", "-q", "-b", "main");
      git("config", "user.email", "t@t");
      git("config", "user.name", "t");
      mkdirSync(join(repo, "packages/protocol/src"), { recursive: true });
      mkdirSync(join(repo, "docs"));
      writeFileSync(join(repo, "packages/protocol/src/a.ts"), "export const a = 1;\n".repeat(20));
      git("add", "-A");
      git("commit", "-q", "-m", "one");
      git("mv", "packages/protocol/src/a.ts", "docs/a.md");
      git("commit", "-q", "-am", "move");
      // The same arguments as integration.ts's, so that a change to them is a change here.
      const changed = Bun.spawnSync(["git", "-C", repo, ...diffArgs("HEAD~1")], { env: cleanEnv() })
        .stdout.toString()
        .split("\0")
        .filter(Boolean);
      expect(changed.sort()).toEqual(["docs/a.md", "packages/protocol/src/a.ts"]);
      expect(names(changed)).toContain("backend");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a name no suite has is refused", () => {
    expect(cli("--plan", "nothing-like-it").exitCode).toBe(2);
  });
});
