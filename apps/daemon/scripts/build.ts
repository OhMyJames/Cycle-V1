// Builds the daemon into one directory you can copy to a machine and run:
//
//   dist/cycle-daemon-<os>-<arch>/cycle-daemon   the daemon, one executable (Bun inside)
//   dist/cycle-daemon-<os>-<arch>/claude         the Claude Code binary the adapter drives
//
// plus a .tar.gz of it. The machine needs nothing else: no Bun, no Node, no `claude` on PATH.
import { chmod, cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const name = `cycle-daemon-${process.platform}-${process.arch}`;
const out = join(root, "dist", name);
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

// The SDK's platform package holds the Claude Code binary. Find it where the SDK is installed.
const sdkPackage = Bun.resolveSync(
  "@anthropic-ai/claude-agent-sdk/package.json",
  join(root, "../../packages/adapters/claude"),
);
const platformPackage = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
const platformDir = dirname(
  Bun.resolveSync(`${platformPackage}/package.json`, dirname(sdkPackage)),
);
const binary = (await readdir(platformDir)).find((f) => f === "claude" || f === "claude.exe");
if (binary === undefined) throw new Error(`no Claude binary in ${platformDir}`);

const result = await Bun.build({
  entrypoints: [join(root, "src/main.ts")],
  compile: { outfile: join(out, "cycle-daemon") },
  minify: false,
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
await cp(join(platformDir, binary), join(out, "claude"));
await chmod(join(out, "claude"), 0o755);
await chmod(join(out, "cycle-daemon"), 0o755);

const tar = Bun.spawn(["tar", "-czf", `${name}.tar.gz`, name], {
  cwd: join(root, "dist"),
  stdout: "inherit",
  stderr: "inherit",
});
if ((await tar.exited) !== 0) process.exit(1);
const size = async (p: string) => ((await stat(p)).size / 1e6).toFixed(0);
console.log(
  `built ${out}  (cycle-daemon ${await size(join(out, "cycle-daemon"))} MB, claude ${await size(join(out, "claude"))} MB, tarball ${await size(join(root, "dist", `${name}.tar.gz`))} MB)`,
);
