// Builds src/styles/app.css into src/styles/built.css with Tailwind (Streamdown's markup and
// Rare UI-compatible tokens need its utility classes), and stages the self-hosted WOFF2 fonts
// beside the output stylesheet so desktop builds and the gallery load them locally under CSP.
// Run by the desktop build; `bun run --cwd packages/ui build:css` on its own.
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const out = process.argv[2] ?? `${root}src/styles/built.css`;
const proc = Bun.spawn(
  [
    "bun",
    `${root}node_modules/@tailwindcss/cli/dist/index.mjs`,
    "-i",
    `${root}src/styles/app.css`,
    "-o",
    out,
  ],
  { cwd: root, stdout: "inherit", stderr: "inherit" },
);
const code = await proc.exited;
if (code !== 0) process.exit(code);

const FONTS: [pkg: string, file: string][] = [
  ["@fontsource/open-runde", "open-runde-latin-400-normal.woff2"],
  ["@fontsource/open-runde", "open-runde-latin-500-normal.woff2"],
  ["@fontsource/open-runde", "open-runde-latin-600-normal.woff2"],
  ["@fontsource/open-runde", "open-runde-latin-700-normal.woff2"],
  ["@fontsource-variable/inter", "inter-latin-wght-normal.woff2"],
  ["@fontsource-variable/inter", "inter-latin-ext-wght-normal.woff2"],
  ["@fontsource-variable/inter", "inter-latin-wght-italic.woff2"],
  ["@fontsource-variable/inter", "inter-latin-ext-wght-italic.woff2"],
  ["@fontsource-variable/geist-mono", "geist-mono-latin-wght-normal.woff2"],
  ["@fontsource-variable/geist-mono", "geist-mono-latin-ext-wght-normal.woff2"],
  ["@fontsource-variable/geist-mono", "geist-mono-symbols2-wght-normal.woff2"],
];

const fontsDir = join(dirname(out), "fonts");
await mkdir(fontsDir, { recursive: true });
await Promise.all(
  FONTS.map(([pkg, file]) =>
    copyFile(Bun.resolveSync(`${pkg}/files/${file}`, root), join(fontsDir, file)),
  ),
);
