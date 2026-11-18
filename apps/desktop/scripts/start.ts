// Runs the built app with the Electron binary in node_modules. `bun run build` first.
import electron from "electron";

const root = new URL("..", import.meta.url).pathname;
const proc = Bun.spawn([electron as unknown as string, root, ...process.argv.slice(2)], {
  stdout: "inherit",
  stderr: "inherit",
  stdin: "inherit",
});
process.exit(await proc.exited);
