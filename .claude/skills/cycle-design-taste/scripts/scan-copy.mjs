#!/usr/bin/env node
// Scans the user-facing text of Cycle's interface for what reads as model-written or careless:
// hype words, stock lines, exclamation marks, emoji, em dashes, process talk. It reads JSX text and the
// strings in title, aria-label, placeholder and alt; it does not run the app and opens no browser.
//   bun scan-copy.mjs [files or folders...]     (default: packages/ui/src/react)
// Exit 1 when something is found, so it can gate a change; every hit names the rule in references/copy.md.
//
//   bun scan-copy.mjs --i18n [--update]
// The i18n ratchet: counts the user-visible text still written in the code (JSX text, title, aria-label, placeholder, alt)
// instead of coming from the message catalog (`t("key")`), per file, and compares it with i18n-baseline.json beside this
// script. A file may only go down: a new string is written in the catalog (packages/ui/src/messages/en-US.ts), not in the
// markup. `--update` writes the baseline (do it after moving strings into the catalog, never to let new ones in).
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const WORDS = [
  "delve", "tapestry", "testament", "realm", "embark", "beacon", "multifaceted", "paradigm", "myriad",
  "plethora", "meticulous", "intricate", "elevate", "unlock", "unleash", "empower", "harness", "supercharge",
  "seamless", "seamlessly", "effortless", "effortlessly", "cutting-edge", "revolutionary", "transformative",
  "holistic", "next-level", "world-class", "game-changer", "state-of-the-art", "synergy", "leverage",
  "reimagine", "powerful", "robust", "ecosystem", "journey", "supercharged",
];
const VIRTUE = ["honest", "honestly", "actually", "genuinely", "truly", "simply", "thoughtful", "carefully", "intentional"];
const STOCK = [
  /in today's/i, /look no further/i, /at your fingertips/i, /in just a few clicks/i, /made simple/i,
  /it's not just/i, /whether you're/i, /say goodbye/i, /one-stop/i, /here's the thing/i,
  /this (section|page|screen) (shows|lets)/i, /below,? you'll find/i, /we've added/i, /oops/i, /uh[- ]oh/i,
  /something went wrong/i, /please try again later/i, /an error occurred/i, /\bwhoops\b/i,
];
const EMOJI = /\p{Extended_Pictographic}/u;

const files = [];
const walk = (p) => {
  if (statSync(p).isDirectory()) for (const f of readdirSync(p)) walk(join(p, f));
  else if (/\.tsx$/.test(p)) files.push(p);
};
const args = process.argv.slice(2);
const i18n = args.includes("--i18n");
const paths = args.filter((a) => !a.startsWith("--"));
for (const p of paths.length ? paths : ["packages/ui/src/react"]) walk(p);

/** The strings a user can read on one line of a component. */
const readable = (line) => {
  const out = [];
  for (const m of line.matchAll(/>([^<>{}]*[A-Za-z][^<>{}]*)</g)) out.push(m[1].trim());
  for (const m of line.matchAll(/\b(?:title|aria-label|placeholder|alt|label)=["{`]+([^"}`]+)/g)) out.push(m[1].trim());
  for (const m of line.matchAll(/\b(?:throw new Error|notice|error|message|detail)[^"'`\n]*(["'`])([^"'`]{6,})\1/g)) out.push(m[2].trim());
  // Words a user reads, not a class name or an identifier.
  return out.filter((s) => /[A-Za-z]{3}/.test(s) && (/\s/.test(s) || /^[A-Z]/.test(s)));
};

if (i18n) {
  const baselinePath = join(dirname(fileURLToPath(import.meta.url)), "i18n-baseline.json");
  const counts = {};
  const where = {};
  for (const file of files) {
    if (/icons\.tsx$/.test(file)) continue;
    const list = [];
    readFileSync(file, "utf8").split("\n").forEach((line, i) => {
      if (/^\s*(import|\/\/|\*)/.test(line)) return;
      for (const text of readable(line)) list.push(`${i + 1}: ${text}`);
    });
    counts[file] = list.length;
    where[file] = list;
  }
  if (args.includes("--update")) {
    writeFileSync(baselinePath, `${JSON.stringify(counts, null, 2)}\n`);
    console.log(`i18n: baseline written (${Object.values(counts).reduce((a, b) => a + b, 0)} strings still in markup)`);
    process.exit(0);
  }
  let baseline = {};
  try {
    baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  } catch {}
  let worse = 0;
  for (const [file, n] of Object.entries(counts)) {
    const allowed = baseline[file] ?? 0;
    if (n > allowed) {
      worse++;
      console.log(`${file}: ${n} strings written in the markup, ${allowed} allowed. Put the new ones in the catalog (t("key")):`);
      for (const line of where[file].slice(-(n - allowed))) console.log(`    ${line}`);
    }
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const base = Object.values(baseline).reduce((a, b) => a + b, 0);
  console.log(worse === 0 ? `i18n: ${total} strings still in markup (baseline ${base}); none added` : `i18n: ${worse} file(s) got worse`);
  process.exit(worse === 0 ? 0 : 1);
}

let hits = 0;
const hit = (file, n, rule, text) => {
  hits++;
  console.log(`${file}:${n}  [${rule}]  ${text}`);
};
for (const file of files) {
  readFileSync(file, "utf8").split("\n").forEach((line, i) => {
    if (/^\s*(import|\/\/|\*)/.test(line)) return;
    for (const text of readable(line)) {
      const lower = text.toLowerCase();
      for (const w of WORDS) if (new RegExp(`\\b${w}\\b`).test(lower)) hit(file, i + 1, `hype: ${w}`, text);
      for (const w of VIRTUE) if (new RegExp(`\\b${w}\\b`).test(lower)) hit(file, i + 1, `virtue: ${w}`, text);
      for (const re of STOCK) if (re.test(text)) hit(file, i + 1, `stock: ${re.source}`, text);
      if (/!/.test(text) && !/!=/.test(text)) hit(file, i + 1, "exclamation", text);
      if (EMOJI.test(text)) hit(file, i + 1, "emoji", text);
      if (/—/.test(text)) hit(file, i + 1, "em dash", text);
    }
  });
}
console.log(hits === 0 ? "scan-copy: nothing found" : `scan-copy: ${hits} found`);
process.exit(hits === 0 ? 0 : 1);
