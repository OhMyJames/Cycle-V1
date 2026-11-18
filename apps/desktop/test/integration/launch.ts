// Starts the real app under xvfb with smoke-main.ts driving its window, and returns what it reported.
// What the app and the daemon may see is only what is passed here: nothing of this machine's own.
import { existsSync } from "node:fs";
import { join } from "node:path";

const appDir = new URL("../..", import.meta.url).pathname;
export const dist = join(appDir, "dist");

const electronPath = (): string | undefined => {
  const base = join(appDir, "../../node_modules/.bun");
  const found = Array.from(
    new Bun.Glob("electron@*/node_modules/electron/dist/electron").scanSync(base),
  );
  return found[0] === undefined ? undefined : join(base, found[0]);
};
export const electron = electronPath();
export const xvfb = Bun.which("xvfb-run");
/** Electron's binary, xvfb and a built app are all there. */
export const canLaunch =
  electron !== undefined &&
  existsSync(electron) &&
  xvfb !== null &&
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
      xvfb as string,
      "-a",
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
