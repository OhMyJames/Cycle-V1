import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRecord, junitTimes, type RunRecord, type SuiteRecord } from "./integration-record.ts";
import {
  MIN_SAMPLES,
  markdown,
  median,
  readRecords,
  sameMachine,
  trend,
} from "./integration-trend.ts";

const suite = (
  name: string,
  status: SuiteRecord["status"],
  seconds?: number,
  reason?: string,
): SuiteRecord => ({
  name,
  status,
  limit: 60,
  ...(seconds === undefined ? {} : { seconds }),
  ...(reason === undefined ? {} : { reason }),
});

const run = (
  suites: SuiteRecord[],
  over: Partial<RunRecord["machine"]> = {},
  at = "2026-11-18T03:00:00Z",
): RunRecord => ({
  schema: 1,
  at,
  commit: `c${at}`,
  ref: "main",
  scope: "all",
  strict: true,
  machine: {
    platform: "linux",
    arch: "x64",
    cpus: 4,
    memoryMB: 16000,
    runnerOs: "Linux",
    image: "ubuntu24/20261101",
    ci: true,
    ...over,
  },
  ci: { event: "schedule", runId: "1", attempt: "1", workflow: "ci" },
  suites,
});

/** n earlier runs in which "smoke" passed in the given times. */
const passes = (times: number[], over: Partial<RunRecord["machine"]> = {}) =>
  times.map((s, i) =>
    run([suite("smoke", "ok", s)], over, `2026-11-${String(i + 1).padStart(2, "0")}T03:00:00Z`),
  );

const lineFor = (latest: RunRecord, earlier: RunRecord[], name = "smoke") => {
  const line = trend(latest, earlier).find((l) => l.suite === name);
  if (!line) throw new Error(`no line for ${name}`);
  return line;
};

describe("what happened to a suite", () => {
  const ten = passes([5, 5.2, 4.8, 5.1, 5, 4.9, 5.3, 5, 5.1, 4.7]);

  test("a pass in line with enough earlier passes is ok, with its ratio to the median", () => {
    const line = lineFor(run([suite("smoke", "ok", 5.2)]), ten);
    expect(line.verdict.kind).toBe("ok");
    expect(line.history.ok).toBe(10);
  });

  test("a pass well above the median, by enough seconds, is slower", () => {
    const line = lineFor(run([suite("smoke", "ok", 9)]), ten);
    expect(line.verdict.kind).toBe("slower");
  });

  test("a suite of a second or two is not called slower for a second of noise", () => {
    const quick = passes([1, 1.1, 0.9, 1, 1, 1.2, 1, 0.8, 1, 1]);
    expect(lineFor(run([suite("smoke", "ok", 2.5)]), quick).verdict.kind).toBe("ok");
  });

  test("before there are enough earlier passes nothing is judged, and it says how many there are", () => {
    const few = passes([5, 5, 5]);
    const line = lineFor(run([suite("smoke", "ok", 50)]), few);
    expect(line.verdict).toEqual({ kind: "too few samples", samples: 3 });
    expect(MIN_SAMPLES).toBeGreaterThan(3);
  });

  test("a failure is failed, with its reason, whatever its time", () => {
    const line = lineFor(run([suite("smoke", "FAIL", 150, "over its limit of 150s")]), ten);
    expect(line.verdict).toEqual({ kind: "failed", reason: "over its limit of 150s" });
  });

  test("a suite that was not run, or skipped itself, is not run, with why: not a quick pass", () => {
    expect(
      lineFor(run([suite("smoke", "not selected", undefined, "no changed file reaches it")]), ten)
        .verdict,
    ).toEqual({
      kind: "not run",
      reason: "no changed file reaches it",
    });
    expect(
      lineFor(run([suite("smoke", "skip", 0.2, "all tests skipped: needs electron")]), ten).verdict
        .kind,
    ).toBe("not run");
  });

  test("earlier failures, skips and runs without it are counted apart and are not samples", () => {
    const earlier = [
      ...ten,
      run([suite("smoke", "FAIL", 150)], {}, "2026-11-20T03:00:00Z"),
      run([suite("smoke", "skip", 0.1)], {}, "2026-11-21T03:00:00Z"),
      run([suite("smoke", "not selected")], {}, "2026-11-22T03:00:00Z"),
      run([suite("smoke", "not selected")], {}, "2026-11-23T03:00:00Z"),
    ];
    const line = lineFor(run([suite("smoke", "ok", 5)]), earlier);
    expect(line.history).toEqual({ ok: 10, failed: 1, skipped: 1, notSelected: 2 });
    expect(line.verdict.kind).toBe("ok");
  });

  test("a failed run in the history does not drag the median up", () => {
    const earlier = [
      ...ten,
      ...passes([300, 300, 300]).map((r, i) => ({
        ...r,
        at: `2026-12-0${i + 1}T00:00:00Z`,
        suites: [suite("smoke", "FAIL", 300)],
      })),
    ];
    expect(lineFor(run([suite("smoke", "ok", 9)]), earlier).verdict.kind).toBe("slower");
  });
});

describe("comparable machines", () => {
  test("another operating system, image, core count or architecture is not a baseline", () => {
    const here = run([suite("smoke", "ok", 5)]);
    expect(sameMachine(here, run([], {}))).toBe(true);
    for (const other of [
      { runnerOs: "macOS" },
      { image: "ubuntu24/20270101" },
      { cpus: 2 },
      { arch: "arm64" },
      { platform: "darwin" },
    ])
      expect(sameMachine(here, run([], other))).toBe(false);
  });

  test("runs on another machine do not count as samples, and do not raise a slower", () => {
    const elsewhere = passes([20, 21, 19, 20, 20, 22, 20, 21, 19, 20], { runnerOs: "macOS" });
    const line = lineFor(run([suite("smoke", "ok", 5)]), elsewhere);
    expect(line.history.ok).toBe(0);
    expect(line.verdict.kind).toBe("too few samples");
  });

  test("the latest run is not compared with itself", () => {
    const latest = run([suite("smoke", "ok", 5)]);
    expect(lineFor(latest, [latest]).history.ok).toBe(0);
  });
});

test("median", () => {
  expect(median([3, 1, 2])).toBe(2);
  expect(median([4, 1, 3, 2])).toBe(2.5);
});

test("the table says what each suite did, in words", () => {
  const latest = run([
    suite("node", "ok", 2),
    suite("smoke", "not selected", undefined, "no changed file reaches it"),
  ]);
  const text = markdown(latest, trend(latest, passes([5])), 1);
  expect(text).toContain("| node | ok | 2.0s |");
  expect(text).toContain("not run: no changed file reaches it");
  expect(text).toContain("against 1 earlier runs");
});

describe("a record", () => {
  const rows = [
    {
      name: "node",
      status: "skip" as const,
      seconds: 0.21,
      reason: "all tests skipped: needs electron",
    },
    { name: "smoke", status: "ok" as const, seconds: 5.347 },
    {
      name: "ssh",
      status: "not selected" as const,
      reason: "not selected: no changed file reaches it",
    },
  ];
  const record = buildRecord({
    rows,
    limits: { node: 60, smoke: 150, ssh: 60 },
    slowest: { smoke: [{ name: "the app", seconds: 5.1 }] },
    scope: "selected",
    strict: true,
    commit: "abc123",
    env: {
      GITHUB_ACTIONS: "true",
      GITHUB_SHA: "deadbeef",
      GITHUB_HEAD_REF: "feature",
      GITHUB_RUN_ID: "99",
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_WORKFLOW: "ci",
      RUNNER_OS: "Linux",
      ImageVersion: "20261101.1",
    },
    now: new Date("2026-11-18T03:00:00Z"),
  });

  test("says which commit, which run, which machine", () => {
    expect(record.commit).toBe("deadbeef");
    expect(record.ref).toBe("feature");
    expect(record.at).toBe("2026-11-18T03:00:00.000Z");
    expect(record.ci).toEqual({ event: "pull_request", runId: "99", attempt: "1", workflow: "ci" });
    expect(record.machine).toMatchObject({ runnerOs: "Linux", image: "20261101.1", ci: true });
    expect(record.machine.cpus).toBeGreaterThan(0);
  });

  test("has every suite with its status, so that a missing time has its reason", () => {
    expect(record.suites.map((s) => [s.name, s.status, s.seconds, s.limit])).toEqual([
      ["node", "skip", 0.21, 60],
      ["smoke", "ok", 5.35, 150],
      ["ssh", "not selected", undefined, 60],
    ]);
    expect(record.suites[1]?.slowest).toEqual([{ name: "the app", seconds: 5.1 }]);
    expect(record.suites[0]?.reason).toContain("electron");
  });

  test("outside CI it has the commit from git and no run", () => {
    const local = buildRecord({
      rows,
      limits: {},
      slowest: {},
      scope: "all",
      strict: false,
      commit: "abc123",
      env: {},
      now: new Date(0),
    });
    expect(local.commit).toBe("abc123");
    expect(local.ci).toBeUndefined();
    expect(local.machine.ci).toBe(false);
  });
});

describe("bun's junit file", () => {
  test("gives the slowest tests, with their names unescaped", () => {
    const xml = [
      '<testsuite name="x" time="9">',
      '  <testcase name="quick" classname="" time="0.5" file="a.ts" line="1" assertions="1" />',
      '  <testcase name="the &quot;slow&quot; one &amp; more" classname="" time="4.25" file="a.ts" line="9" assertions="2">',
      "  </testcase>",
      '  <testcase name="skipped" classname="" time="0"><skipped /></testcase>',
      "</testsuite>",
    ].join("\n");
    expect(junitTimes(xml, 2)).toEqual([
      { name: 'the "slow" one & more', seconds: 4.25 },
      { name: "quick", seconds: 0.5 },
    ]);
    expect(junitTimes("not xml")).toEqual([]);
  });
});

describe("reading the records", () => {
  test("takes files and directories (one level down too), and leaves out what is not a record", () => {
    const dir = mkdtempSync(join(tmpdir(), "cv1-trend-"));
    try {
      mkdirSync(join(dir, "123"));
      writeFileSync(
        join(dir, "123", "integration-timing.json"),
        JSON.stringify(run([suite("node", "ok", 1)])),
      );
      writeFileSync(join(dir, "other.json"), JSON.stringify(run([suite("node", "ok", 2)])));
      writeFileSync(join(dir, "broken.json"), "{ not json");
      writeFileSync(join(dir, "old.json"), JSON.stringify({ schema: 0, suites: [] }));
      writeFileSync(join(dir, "note.txt"), "x");
      expect(readRecords([dir, join(dir, "missing")]).length).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the command line", () => {
  test("prints the table for a latest record and a directory of earlier ones, and never fails the run for a slow suite", () => {
    const dir = mkdtempSync(join(tmpdir(), "cv1-trend-"));
    try {
      const earlier = passes([5, 5, 5, 5, 5, 5, 5, 5, 5, 5]);
      for (const [i, r] of earlier.entries())
        writeFileSync(join(dir, `${i}.json`), JSON.stringify(r));
      const latest = join(dir, "latest.json");
      writeFileSync(
        latest,
        JSON.stringify(run([suite("smoke", "ok", 30)], {}, "2026-12-01T00:00:00Z")),
      );
      const out = Bun.spawnSync(["bun", `${import.meta.dir}/integration-trend.ts`, latest, dir]);
      expect(out.exitCode).toBe(0);
      expect(out.stdout.toString()).toContain("**slower**");
      expect(
        Bun.spawnSync(["bun", `${import.meta.dir}/integration-trend.ts`, join(dir, "nothing.json")])
          .exitCode,
      ).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the CI workflow's record and comparison", () => {
  const ci = readFileSync(`${import.meta.dir}/../.github/workflows/ci.yml`, "utf8");
  const job = ci.slice(ci.indexOf("  integration:"));

  test("every run records, and keeps the record as an artifact even when a suite failed", () => {
    expect(job).toContain('--record "$RUNNER_TEMP/integration-timing.json"');
    const upload = job.slice(job.indexOf("actions/upload-artifact"));
    expect(upload).toContain("if: always()");
    expect(upload).toContain("name: integration-timing");
  });

  test("the comparison is not for pull requests, never fails the job, and may read the artifacts", () => {
    const step = job.slice(
      job.indexOf("Timing against the earlier runs"),
      job.indexOf("actions/upload-artifact"),
    );
    expect(step).toContain("github.event_name != 'pull_request'");
    expect(step).toContain("continue-on-error: true");
    expect(step).toContain("integration-trend.ts");
    expect(job).toMatch(/permissions:\n {6}contents: read\n(?: {6}#.*\n)? {6}actions: read/);
  });
});

describe("--record on the runner", () => {
  test("a run that starts no suite still leaves a record with all six, each with its reason", () => {
    const dir = mkdtempSync(join(tmpdir(), "cv1-record-"));
    try {
      const file = join(dir, "r.json");
      const out = Bun.spawnSync(
        ["bun", `${import.meta.dir}/integration.ts`, "--record", file, "--files", "docs/a.md"],
        {
          env: Object.fromEntries(
            Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")),
          ),
        },
      );
      expect(out.exitCode).toBe(0);
      const record = readRecords([file])[0];
      expect(record?.scope).toBe("selected");
      expect(record?.suites.map((s) => s.status)).toEqual(Array(6).fill("not selected"));
      expect(record?.suites.every((s) => s.limit > 0 && s.reason?.includes("not selected"))).toBe(
        true,
      );
      expect(record?.commit).toMatch(/^[0-9a-f]{7,40}$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
