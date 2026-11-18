// Which module may import which, by zone. The type environments (tsconfig.model.json, tsconfig.renderer.json) keep
// the wrong globals out (document in the model, node:fs or Bun in the page); a type check cannot say that
// the model may not import React or that the preload may not reach the daemon, so that is here.
//
//   model     packages/ui/src/model, packages/ui/src/api.ts: pure TypeScript. The Electron main process runs
//             it too (packages/ui/AGENTS.md), and the preload and the page share the bridge contract in api.ts.
//   renderer  the page: apps/desktop/src/renderer and all of packages/ui/src. Browser code: no Node, no
//             Electron, no Bun, and nothing that starts or talks to the daemon directly (it goes by the bridge).
//   preload   apps/desktop/src/preload: sandboxed. electron, and the bridge contract from @cycle/ui/api, nothing else.

export type Zone = "model" | "renderer" | "preload";

export const zoneOf = (file: string): Zone[] => {
  const zones: Zone[] = [];
  if (file.startsWith("packages/ui/src/model/") || file === "packages/ui/src/api.ts")
    zones.push("model");
  if (file.startsWith("packages/ui/src/") || file.startsWith("apps/desktop/src/renderer/"))
    zones.push("renderer");
  if (file.startsWith("apps/desktop/src/preload/")) zones.push("preload");
  return zones;
};

/** The module names a file imports: static, side-effect, re-export, dynamic and require. A line in a comment is not one. */
export const importsOf = (text: string): string[] => {
  const found: string[] = [];
  const patterns = [
    /^[ \t]*(?:import|export)\b[^;'"]*?\bfrom\s*["']([^"']+)["']/gm,
    /^[ \t]*import\s*["']([^"']+)["']/gm,
    /\b(?:import|require)\s*\(\s*["']([^"']+)["']/g,
  ];
  for (const pattern of patterns)
    for (const match of text.matchAll(pattern)) found.push(match[1] as string);
  return found;
};

const NODE = /^(?:node:|bun(?::|$)|electron(?:\/|$))/;
const BUILTIN =
  /^(?:assert|buffer|child_process|cluster|crypto|dgram|dns|events|fs|http|http2|https|net|os|path|perf_hooks|process|readline|stream|tls|url|util|worker_threads|zlib)(?:\/|$)/;
// Packages that run in the daemon or the main process: the page has no business with them.
const BACKEND = /^@cycle\/(?:daemon|client|transport|protocol|desktop)(?:\/|$)|^@cycle\/adapter/;

const isRelative = (name: string) => name.startsWith(".");

const forbidden: Record<Zone, (name: string) => string | undefined> = {
  model: (name) => {
    if (isRelative(name) || name === "@cycle/acp") return undefined;
    return "the model is pure TypeScript: it may import only relative files and @cycle/acp";
  },
  renderer: (name) => {
    if (NODE.test(name) || BUILTIN.test(name))
      return "the page runs in a browser: no Node, Bun or Electron module";
    if (BACKEND.test(name))
      return "the page reaches the daemon only through the bridge (@cycle/ui/api), not by importing it";
    return undefined;
  },
  preload: (name) => {
    if (isRelative(name))
      return "the preload is bundled alone: it may not import app code by relative path";
    if (name === "electron" || name === "@cycle/ui/api") return undefined;
    return "the preload may import only electron and @cycle/ui/api";
  },
};

/** One line per broken rule in this file; empty when it keeps to its zones. */
export const violations = (file: string, text: string): string[] => {
  const zones = zoneOf(file);
  if (zones.length === 0) return [];
  const names = importsOf(text);
  const out: string[] = [];
  for (const zone of zones)
    for (const name of names) {
      const why = forbidden[zone](name);
      if (why) out.push(`${file}: ${zone} imports "${name}" (${why})`);
    }
  return out;
};
