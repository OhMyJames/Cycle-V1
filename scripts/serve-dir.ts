// A directory over http on this machine's loopback only, for a built page whose module scripts do not load from a file:
// the web tests, the gallery's screenshots, and a person who wants to look (`bun scripts/serve-dir.ts <dir>`).
import { existsSync, statSync } from "node:fs";
import { join, normalize, resolve, sep } from "node:path";

export const serveDir = (dir: string) => {
  const root = resolve(dir);
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      const path = normalize(decodeURIComponent(new URL(request.url).pathname));
      const file = join(root, path === "/" ? "index.html" : path);
      // Nothing outside the directory, a sibling whose name starts the same way included.
      if (!file.startsWith(root + sep)) return new Response("no", { status: 403 });
      return existsSync(file) && statSync(file).isFile()
        ? new Response(Bun.file(file))
        : new Response("no", { status: 404 });
    },
  });
};

if (import.meta.main) {
  const dir = process.argv[2];
  if (dir === undefined) {
    console.error("usage: bun scripts/serve-dir.ts <directory>");
    process.exit(2);
  }
  const server = serveDir(dir);
  console.log(`http://127.0.0.1:${server.port}/`);
}
