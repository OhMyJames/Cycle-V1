import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCli } from "../src/args.ts";

test("Cycle's options are read before the command, and the line after claude is left alone", () => {
  const line = [
    "--data-dir",
    "/d",
    "claude",
    "--version",
    "-p",
    "x",
    "--socket",
    "y",
    "--",
    "--help",
  ];
  const parsed = parseCli(line);
  expect(parsed.values["data-dir"]).toBe("/d");
  expect(parsed.values.socket).toBeUndefined();
  expect(parsed.values.help).toBeUndefined();
  expect(parsed.positionals).toEqual(["claude"]);
  expect(parsed.forwarded).toEqual(["--version", "-p", "x", "--socket", "y", "--", "--help"]);
});

test("login hands on what follows it, and the other commands are read whole as before", () => {
  expect(parseCli(["login", "--console"]).forwarded).toEqual(["--console"]);
  const status = parseCli(["status", "--socket", "/s"]);
  expect(status.forwarded).toBeUndefined();
  expect(status.values.socket).toBe("/s");
  expect(parseCli(["--help"]).values.help).toBe(true);
  expect(parseCli(["serve", "--data-dir=/x"]).values["data-dir"]).toBe("/x");
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cv1-cli-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("cycle claude gives the Claude binary every argument as typed", async () => {
  const seen = join(dir, "argv");
  const stub = join(dir, "bin", "claude");
  await Bun.write(stub, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > ${seen}\n`);
  await chmod(stub, 0o755);
  const main = new URL("../src/main.ts", import.meta.url).pathname;
  const child = Bun.spawn(
    [
      process.execPath,
      main,
      "--data-dir",
      join(dir, "data"),
      "claude",
      "--version",
      "-p",
      "hi",
      "--",
      "--help",
    ],
    {
      env: { ...process.env, HOME: dir, PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}` },
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  const code = await child.exited;
  expect(await new Response(child.stderr).text()).toBe("");
  expect(code).toBe(0);
  expect((await readFile(seen, "utf8")).split("\n").slice(0, -1)).toEqual([
    "--version",
    "-p",
    "hi",
    "--",
    "--help",
  ]);
}, 15_000);
