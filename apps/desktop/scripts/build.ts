// Builds the app into dist/: main (node, esm), the preload (cjs: a sandboxed preload cannot be esm),
// and the page (a browser bundle, its html, and the css Tailwind builds).
import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const dist = join(root, "dist");
await rm(dist, { recursive: true, force: true });
await mkdir(join(dist, "renderer"), { recursive: true });

const bundle = async (config: Parameters<typeof Bun.build>[0]) => {
  const result = await Bun.build(config);
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
};

await bundle({
  entrypoints: [join(root, "src/main/main.ts")],
  outdir: dist,
  target: "node",
  format: "esm",
  external: ["electron"],
  naming: "main.mjs",
});
await bundle({
  entrypoints: [join(root, "src/preload/preload.ts")],
  outdir: dist,
  target: "node",
  format: "cjs",
  external: ["electron"],
  naming: "preload.cjs",
});
await bundle({
  entrypoints: [join(root, "src/renderer/main.tsx")],
  outdir: join(dist, "renderer"),
  target: "browser",
  format: "esm",
  naming: "renderer.js",
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
});
await cp(join(root, "src/renderer/index.html"), join(dist, "renderer/index.html"));

const css = Bun.spawn(
  ["bun", join(root, "../../packages/ui/scripts/build-css.ts"), join(dist, "renderer/app.css")],
  { stdout: "inherit", stderr: "inherit" },
);
if ((await css.exited) !== 0) process.exit(1);
console.log("built", dist);
