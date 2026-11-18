// What one run of the integration suites leaves behind, so that a result can be traced and later runs compared with
// it: the commit, the machine, and for every suite what happened and how long it took. integration.ts writes it
// (--record <file>); integration-trend.ts reads many of them.
//
// All six suites are in every record, with the status that says why a suite has no time: "ok" and "FAIL" ran,
// "skip" started and skipped itself, "not selected" was not started. A time without its status would make a run
// that skipped a suite look like a fast one.

import { cpus, totalmem } from "node:os";
import type { Row } from "./integration-plan.ts";

export const SCHEMA = 1;

export type TestTime = { name: string; seconds: number };

export type SuiteRecord = {
  name: string;
  status: Row["status"];
  seconds?: number;
  /** The suite's own deadline, in seconds: a time near it is a suite about to be killed. */
  limit: number;
  reason?: string;
  /** The slowest tests in the suite, to say where the time went. */
  slowest?: TestTime[];
};

export type RunRecord = {
  schema: typeof SCHEMA;
  at: string;
  commit: string | undefined;
  /** For a pull request, the branch it is from. */
  ref: string | undefined;
  /** "all": every suite was asked for. "selected": a part of them was (a pull request's plan, a name filter). */
  scope: "all" | "selected";
  strict: boolean;
  machine: {
    platform: string;
    arch: string;
    cpus: number;
    memoryMB: number;
    /** On CI: the runner's operating system and image, which is what "the same machine" means there. */
    runnerOs: string | undefined;
    image: string | undefined;
    ci: boolean;
  };
  ci: { event: string; runId: string; attempt: string; workflow: string } | undefined;
  suites: SuiteRecord[];
};

/** <testcase name="..." time="1.23"> out of bun's junit output, slowest first. */
export const junitTimes = (xml: string, top = 5): TestTime[] => {
  const times: TestTime[] = [];
  for (const match of xml.matchAll(/<testcase\b([^>]*)>/g)) {
    const attrs = match[1] as string;
    const name = /\bname="([^"]*)"/.exec(attrs)?.[1];
    const time = /\btime="([^"]*)"/.exec(attrs)?.[1];
    if (name !== undefined && time !== undefined && Number.isFinite(Number(time)))
      times.push({
        name: name
          .replace(/&quot;/g, '"')
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">"),
        seconds: Number(Number(time).toFixed(3)),
      });
  }
  return times.sort((a, b) => b.seconds - a.seconds).slice(0, top);
};

export const buildRecord = (input: {
  rows: Row[];
  limits: Record<string, number>;
  slowest: Record<string, TestTime[]>;
  scope: RunRecord["scope"];
  strict: boolean;
  commit: string | undefined;
  env: Record<string, string | undefined>;
  now: Date;
}): RunRecord => {
  const { env } = input;
  return {
    schema: SCHEMA,
    at: input.now.toISOString(),
    commit: env.GITHUB_SHA ?? input.commit,
    ref: env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME || undefined,
    scope: input.scope,
    strict: input.strict,
    machine: {
      platform: process.platform,
      arch: process.arch,
      cpus: cpus().length,
      memoryMB: Math.round(totalmem() / 1024 / 1024),
      runnerOs: env.RUNNER_OS,
      image: env.ImageVersion,
      ci: env.GITHUB_ACTIONS === "true",
    },
    ci:
      env.GITHUB_RUN_ID === undefined
        ? undefined
        : {
            event: env.GITHUB_EVENT_NAME ?? "",
            runId: env.GITHUB_RUN_ID,
            attempt: env.GITHUB_RUN_ATTEMPT ?? "1",
            workflow: env.GITHUB_WORKFLOW ?? "",
          },
    suites: input.rows.map((row) => ({
      name: row.name,
      status: row.status,
      ...(row.seconds === undefined ? {} : { seconds: Number(row.seconds.toFixed(2)) }),
      limit: input.limits[row.name] ?? 0,
      ...(row.reason === undefined ? {} : { reason: row.reason }),
      ...(input.slowest[row.name] === undefined ? {} : { slowest: input.slowest[row.name] }),
    })),
  };
};
