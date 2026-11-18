// Builds the gallery into gallery/dist: `bun packages/ui/gallery/build.ts`. It is a development tool, not part of the app.
import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

const here = new URL(".", import.meta.url).pathname;
const dist = join(here, "dist");
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
const result = await Bun.build({
  entrypoints: [join(here, "main.tsx")],
  outdir: dist,
  target: "browser",
  format: "esm",
  // Split, so the highlighter's languages and themes load when a block needs them, not all at start.
  splitting: true,
  naming: { entry: "gallery.js", chunk: "chunks/[name]-[hash].js", asset: "[name]-[hash].[ext]" },
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
await cp(join(here, "index.html"), join(dist, "index.html"));
const css = Bun.spawn(["bun", join(here, "../scripts/build-css.ts"), join(dist, "app.css")], {
  stdout: "inherit",
  stderr: "inherit",
});
if ((await css.exited) !== 0) process.exit(1);
console.log("built", dist);
