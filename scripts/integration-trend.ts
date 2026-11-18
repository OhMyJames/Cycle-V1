// Compares the latest integration run with the earlier ones, from the files integration.ts --record leaves:
//   bun scripts/integration-trend.ts <latest.json> [earlier.json | a directory of them]...
// It prints a markdown table (a CI step summary). It describes; it never fails a run, and nothing here is a
// threshold that blocks a pull request: how slow is too slow is decided from the samples, when there are
// enough of them (MIN_SAMPLES), not before.
//
// The question it answers is which of three things happened to each suite:
//   not run   not selected, or it skipped itself: there is no time, and the reason says why
//   failed    it ran and failed (or was over its deadline): its time is not a sample
//   slower    it passed, there are enough comparable earlier passes, and this one is well above their median
// Only passes on the same kind of machine are samples: a run on another operating system, image or core count is
// not a baseline for this one.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { type RunRecord, SCHEMA, type SuiteRecord } from "./integration-record.ts";

/** Earlier passes needed before any slow/fast judgement is shown. */
export const MIN_SAMPLES = 10;
/** A pass this many times the median, and at least SLOWER_BY_SECONDS over it, is called slower. */
export const SLOWER_FACTOR = 1.5;
export const SLOWER_BY_SECONDS = 3;

export const sameMachine = (a: RunRecord, b: RunRecord): boolean =>
  a.machine.platform === b.machine.platform &&
  a.machine.arch === b.machine.arch &&
  a.machine.cpus === b.machine.cpus &&
  a.machine.runnerOs === b.machine.runnerOs &&
  a.machine.image === b.machine.image;

export const median = (values: number[]): number => {
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
};

export type Verdict =
  | { kind: "not run"; reason: string }
  | { kind: "failed"; reason: string }
  | { kind: "ok" | "slower" | "too few samples"; samples: number; median?: number; ratio?: number };

export type Line = {
  suite: string;
  status: SuiteRecord["status"];
  seconds: number | undefined;
  verdict: Verdict;
  /** What the earlier runs on this machine did with it: passes, failures, skips, and runs that did not start it. */
  history: { ok: number; failed: number; skipped: number; notSelected: number };
};

export const trend = (latest: RunRecord, earlier: RunRecord[]): Line[] => {
  const comparable = earlier.filter((r) => r !== latest && sameMachine(r, latest));
  return latest.suites.map((suite) => {
    const mine = comparable.flatMap((r) => r.suites.filter((s) => s.name === suite.name));
    const passes = mine.filter((s) => s.status === "ok" && s.seconds !== undefined);
    const history = {
      ok: passes.length,
      failed: mine.filter((s) => s.status === "FAIL").length,
      skipped: mine.filter((s) => s.status === "skip").length,
      notSelected: mine.filter((s) => s.status === "not selected").length,
    };
    let verdict: Verdict;
    if (suite.status === "not selected" || suite.status === "skip")
      verdict = {
        kind: "not run",
        reason: (suite.reason ?? suite.status).replace(/^not selected: /, ""),
      };
    else if (suite.status === "FAIL")
      verdict = { kind: "failed", reason: suite.reason ?? "failed" };
    else if (passes.length < MIN_SAMPLES || suite.seconds === undefined)
      verdict = { kind: "too few samples", samples: passes.length };
    else {
      const base = median(passes.map((s) => s.seconds as number));
      const slower =
        suite.seconds > base * SLOWER_FACTOR && suite.seconds - base >= SLOWER_BY_SECONDS;
      verdict = {
        kind: slower ? "slower" : "ok",
        samples: passes.length,
        median: base,
        ratio: base === 0 ? 1 : suite.seconds / base,
      };
    }
    return { suite: suite.name, status: suite.status, seconds: suite.seconds, verdict, history };
  });
};

const describe = (v: Verdict): string => {
  switch (v.kind) {
    case "not run":
      return `not run: ${v.reason}`;
    case "failed":
      return `failed: ${v.reason}`;
    case "too few samples":
      return `${v.samples} earlier passes here; judged from ${MIN_SAMPLES}`;
    case "slower":
      return `**slower**: ${v.ratio?.toFixed(1)}x the median ${v.median?.toFixed(1)}s of ${v.samples} earlier passes`;
    case "ok":
      return `in line: ${v.ratio?.toFixed(1)}x the median ${v.median?.toFixed(1)}s of ${v.samples} earlier passes`;
  }
};

export const markdown = (latest: RunRecord, lines: Line[], earlierCount: number): string => {
  const head = `Integration timing: ${latest.commit?.slice(0, 9) ?? "no commit"} on ${latest.machine.runnerOs ?? latest.machine.platform}/${latest.machine.cpus} cores, against ${earlierCount} earlier runs on the same kind of machine (${latest.scope} suites).`;
  return [
    head,
    "",
    "| suite | this run | time | earlier here (ok / failed / skipped / not selected) | |",
    "| --- | --- | --- | --- | --- |",
    ...lines.map(
      (l) =>
        `| ${l.suite} | ${l.status} | ${l.seconds === undefined ? "" : `${l.seconds.toFixed(1)}s`} | ${l.history.ok} / ${l.history.failed} / ${l.history.skipped} / ${l.history.notSelected} | ${describe(l.verdict)} |`,
    ),
  ].join("\n");
};

/** Every record in the files and directories given (a directory: its .json files, one level down too); what is not a record is left out. */
export const readRecords = (paths: string[]): RunRecord[] => {
  const files: string[] = [];
  const add = (path: string, depth: number) => {
    if (!existsSync(path)) return;
    if (statSync(path).isDirectory()) {
      if (depth < 3) for (const entry of readdirSync(path)) add(join(path, entry), depth + 1);
    } else if (path.endsWith(".json")) files.push(path);
  };
  for (const path of paths) add(path, 0);
  const records: RunRecord[] = [];
  for (const file of files) {
    try {
      const json = JSON.parse(readFileSync(file, "utf8")) as RunRecord;
      if (json.schema === SCHEMA && Array.isArray(json.suites)) records.push(json);
    } catch {}
  }
  return records;
};

if (import.meta.main) {
  const [latestPath, ...rest] = process.argv.slice(2);
  if (latestPath === undefined) {
    console.error(
      "usage: bun scripts/integration-trend.ts <latest.json> [earlier.json | directory]...",
    );
    process.exit(2);
  }
  const latest = readRecords([latestPath])[0];
  if (latest === undefined) {
    console.error(`${latestPath} is not an integration record`);
    process.exit(2);
  }
  // The latest, if it is among the earlier, is not compared with itself.
  const earlier = readRecords(rest).filter(
    (r) => !(r.at === latest.at && r.commit === latest.commit),
  );
  console.log(markdown(latest, trend(latest, earlier), earlier.length));
}
