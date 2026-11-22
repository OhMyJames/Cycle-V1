// Starts the real app (under xvfb on Linux; on macOS with its window hidden and out of the Dock, so that it does not take
// the focus) with smoke-main.ts driving its window, and returns what it reported.
// What the app and the daemon may see is only what is passed here: nothing of this machine's own.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { electronBinary } from "../../../../scripts/electron-binary.ts";

const appDir = new URL("../..", import.meta.url).pathname;
export const dist = join(appDir, "dist");

export const electron = electronBinary(join(appDir, "../../node_modules/.bun"));
const mac = process.platform === "darwin";
export const xvfb = Bun.which("xvfb-run");
/** Electron's binary, a built app, and on Linux xvfb, are all there. */
export const canLaunch =
  electron !== undefined &&
  existsSync(electron) &&
  (mac || xvfb !== null) &&
  existsSync(join(dist, "main.mjs"));

export type Launch = {
  root: string;
  data: string;
  home: string;
  cwd: string;
  /** What the daemon is run as: `["bun", "<main.ts>"]` from source, or the built executable. */
  daemon: string[];
  extraEnv?: Record<string, string>;
  /** Longest the whole run may take, in ms. */
  deadline: number;
};

export const launch = async (options: Launch) => {
  const built = await Bun.build({
    entrypoints: [join(appDir, "test/integration/smoke-main.ts")],
    target: "node",
    format: "esm",
    external: ["electron"],
  });
  if (!built.success) throw new Error("smoke-main.ts did not build");
  const script = join(options.root, "smoke-main.mjs");
  await Bun.write(script, (await built.outputs[0]?.text()) ?? "");

  const proc = Bun.spawn(
    [
      ...(mac || xvfb === null ? [] : [xvfb, "-a"]),
      electron as string,
      // The test machine has no setuid chrome-sandbox. The window itself is still sandboxed
      // (sandbox: true); only the process-level helper is skipped. The app never ships this flag.
      "--no-sandbox",
      "--disable-gpu",
      `--user-data-dir=${join(options.root, "electron")}`,
      script,
    ],
    {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: options.home,
        ELECTRON_ENABLE_LOGGING: "0",
        CYCLE_ANALYTICS: "off",
        SMOKE_RENDERER: join(dist, "renderer"),
        SMOKE_PRELOAD: join(dist, "preload.cjs"),
        SMOKE_DAEMON: JSON.stringify(options.daemon),
        SMOKE_DATA: options.data,
        SMOKE_SOCKET: join(options.root, "d.sock"),
        SMOKE_HOME: options.home,
        SMOKE_CWD: options.cwd,
        ...(process.env.SMOKE_LOG ? { SMOKE_LOG: process.env.SMOKE_LOG } : {}),
        ...options.extraEnv,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const timer = setTimeout(() => proc.kill("SIGKILL"), options.deadline);
  try {
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    const lines = out
      .split("\n")
      .filter((l) => l.startsWith("{"))
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    if (proc.exitCode !== 0) console.log("electron stderr:", err.slice(-2000));
    for (const line of lines) console.log("step", JSON.stringify(line).slice(0, 1500));
    return {
      lines,
      exitCode: proc.exitCode,
      step: (name: string) => lines.find((l) => l.step === name),
    };
  } finally {
    clearTimeout(timer);
  }
};
