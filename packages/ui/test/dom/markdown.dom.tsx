import { afterEach, expect, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { isSafeLink, Markdown } from "../../src/react/markdown.tsx";

afterEach(cleanup);

const html = (text: string) => render(<Markdown text={text} />).container;

test("renders markdown", async () => {
  const c = html(
    "# Title\n\nSome **bold** text and a list:\n\n- one\n- two\n\n```ts\nconst x = 1;\n```",
  );
  expect(c.querySelector("h1")?.textContent).toBe("Title");
  // Streamdown draws bold as a styled span, not <strong>.
  expect(c.querySelector('[data-streamdown="strong"]')?.textContent).toBe("bold");
  expect(c.querySelectorAll("li")).toHaveLength(2);
  await waitFor(() => expect(c.textContent).toContain("const x = 1;"));
});

test("drops raw HTML instead of putting it in the page", () => {
  const c = html(
    'Hello <script>window.__pwned = 1</script><img src="https://evil.example/x.png" onerror="window.__pwned = 2"> <iframe src="https://evil.example"></iframe> <style>body{display:none}</style>',
  );
  expect(c.querySelector("script")).toBeNull();
  expect(c.querySelector("iframe")).toBeNull();
  expect(c.querySelector("style")).toBeNull();
  expect(c.querySelector("img")).toBeNull();
  expect((globalThis as { __pwned?: number }).__pwned).toBeUndefined();
});

test("never loads an image: a markdown image becomes text", () => {
  const c = html("![a diagram](https://evil.example/pixel.png)");
  expect(c.querySelector("img")).toBeNull();
  expect(c.textContent).toContain("[image not loaded: a diagram]");
});

test("a link to the web opens as a link that cannot reach back", () => {
  const c = html("[docs](https://example.com/docs)");
  const a = c.querySelector("a");
  expect(a?.getAttribute("href")).toBe("https://example.com/docs");
  expect(a?.getAttribute("target")).toBe("_blank");
  expect(a?.getAttribute("rel")).toContain("noopener");
  expect(a?.getAttribute("rel")).toContain("noreferrer");
});

test("a link to anything but http, https and mailto is only text", () => {
  for (const href of [
    "javascript:alert(1)",
    "data:text/html,<b>x</b>",
    "file:///etc/passwd",
    "vbscript:x",
  ]) {
    const c = html(`[click](${href})`);
    expect(c.querySelector("a")).toBeNull();
    expect(c.textContent).toContain("click");
  }
});

test("knows which links are safe", () => {
  expect(isSafeLink("https://example.com")).toBe(true);
  expect(isSafeLink("http://example.com")).toBe(true);
  expect(isSafeLink("mailto:a@example.com")).toBe(true);
  expect(isSafeLink("javascript:alert(1)")).toBe(false);
  expect(isSafeLink("//example.com")).toBe(false);
  expect(isSafeLink("not a url")).toBe(false);
  expect(isSafeLink(undefined)).toBe(false);
});

test("half a message streams without breaking the page", () => {
  const c = render(<Markdown text={"A list:\n\n- one\n- **tw"} streaming />).container;
  expect(c.textContent).toContain("one");
  expect(c.textContent).toContain("tw");
});

test("Tailwind has the classes the markup uses, or it would be drawn bare", async () => {
  const css = await Bun.file(
    new URL("../../src/styles/built.css", import.meta.url).pathname,
  ).text();
  const c = html(
    "# T\n\n- a\n\n> q\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```ts\nx\n```\n\n[l](https://e.com)",
  );
  const used = new Set<string>();
  for (const el of Array.from(c.querySelectorAll("[class]"))) {
    for (const name of el.getAttribute("class")?.split(/\s+/) ?? []) {
      // The plain utilities, which are what a missing @source loses.
      if (/^[a-z]+(-[a-z0-9]+)*$/.test(name) && !name.startsWith("language-")) used.add(name);
    }
  }
  const missing = [...used].filter((name) => !css.includes(`.${name}`));
  expect(used.size).toBeGreaterThan(3);
  expect(missing).toEqual([]);
});
