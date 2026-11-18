// Builds src/styles/app.css into src/styles/built.css with Tailwind (Streamdown's markup needs its
// utility classes). Run by the desktop build; `bun run --cwd packages/ui build:css` on its own.
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
process.exit(await proc.exited);
