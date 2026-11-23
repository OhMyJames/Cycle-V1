import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import { StoreProvider } from "../../src/react/index.ts";
import { Markdown } from "../../src/react/markdown.tsx";
import { AppStore } from "../../src/store/index.ts";
import { fakeBridge } from "../fake-bridge.ts";

afterEach(cleanup);

const fence = (source: string) => `Here:\n\n\`\`\`mermaid\n${source}\n\`\`\`\n\nDone.`;
const FLOW = "flowchart LR\n  A[Start] --> B{Ready?}\n  B -->|yes| C[Ship]";

/** Mermaid loads on the first diagram and lays it out; bounded all the same. */
const DRAWN = { timeout: 10_000 };
const pictureIn = (c: HTMLElement) =>
  waitFor(() => {
    const img = c.querySelector<HTMLImageElement>('[data-slot="diagram"] img');
    expect(img).not.toBeNull();
    return img as HTMLImageElement;
  }, DRAWN);

test("a mermaid fence is drawn as a picture, and nothing Mermaid drew is in the page", async () => {
  const c = render(<Markdown text={fence(FLOW)} />).container;
  const img = await pictureIn(c);
  expect(img.src.startsWith("data:image/svg+xml")).toBe(true);
  expect(img.getAttribute("alt")).toBe("Diagram");
  // The labels are in the picture, laid out as SVG text, not HTML.
  const svg = decodeURIComponent(img.src.slice(img.src.indexOf(",") + 1));
  expect(svg).toContain("Ship");
  expect(svg).not.toContain("foreignObject");
  expect(c.querySelector("svg text, foreignObject")).toBeNull();
  // The source is still there, hidden, for "Show source".
  const source = c.querySelector<HTMLElement>('[data-slot="diagram-source"]');
  expect(source?.hidden).toBe(true);
  expect(source?.textContent).toContain("A[Start]");
});

test("while the fence is still open it is a code block, and no picture is drawn", async () => {
  const c = render(
    <Markdown text={"Here:\n\n```mermaid\nflowchart LR\n  A --> B"} streaming />,
  ).container;
  await waitFor(() => expect(c.textContent).toContain("A --> B"));
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(c.querySelector('[data-slot="diagram"]')).toBeNull();
  expect(c.querySelector('[data-slot="diagram-source"]')?.hasAttribute("hidden")).toBe(false);
});

test("a diagram that does not parse stays its code block, says so, and is not tried again and again", async () => {
  const c = render(<Markdown text={fence("flowchart LR\n  A -->")} />).container;
  await waitFor(() => expect(c.textContent).toContain("This diagram could not be drawn"), DRAWN);
  expect(c.querySelector('[data-slot="diagram"]')).toBeNull();
  expect(c.textContent).toContain("A -->");
  // No error picture of Mermaid's left in the page either.
  expect(document.querySelector('[id^="dcycle-diagram"], [id^="cycle-diagram"]')).toBeNull();
});

test("what a diagram says cannot become HTML, a script or a link, and cannot turn HTML labels back on", async () => {
  const source = [
    "%%{init: {'securityLevel': 'loose', 'htmlLabels': true, 'flowchart': {'htmlLabels': true}}}%%",
    "flowchart LR",
    '  A["<img src=x onerror=window.__pwned=1>"] --> B["<b>bold</b>"]',
    '  click A "javascript:window.__pwned=2"',
    '  click B "https://evil.example/"',
  ].join("\n");
  const c = render(<Markdown text={fence(source)} />).container;
  const img = await pictureIn(c);
  const svg = decodeURIComponent(img.src.slice(img.src.indexOf(",") + 1));
  expect(svg).not.toContain("foreignObject");
  expect(svg).not.toContain("javascript:");
  expect(svg).not.toContain("evil.example");
  expect(svg).not.toMatch(/<script|onerror=|<img/i);
  expect(c.querySelector("a, script, iframe, foreignObject, svg[id^=cycle-diagram]")).toBeNull();
  expect((globalThis as { __pwned?: number }).__pwned).toBeUndefined();
});

test("Show source and back, by keyboard; the picture opens large; both are counted with nothing of the diagram", async () => {
  const user = userEvent.setup();
  const script = fakeBridge({ connected: true });
  const c = render(
    <StoreProvider store={new AppStore(script.bridge)}>
      <Markdown text={fence(FLOW)} />
    </StoreProvider>,
  ).container;
  await pictureIn(c);
  const show = within(c).getByRole("button", { name: "Show source" });
  show.focus();
  await user.keyboard("{Enter}");
  expect(c.querySelector('[data-slot="diagram"]')).toBeNull();
  expect(c.querySelector<HTMLElement>('[data-slot="diagram-source"]')?.hidden).toBe(false);
  const back = within(c).getByRole("button", { name: "Show diagram" });
  expect(back.getAttribute("aria-expanded")).toBe("true");
  await user.click(back);
  await pictureIn(c);

  await user.click(within(c).getByRole("button", { name: "Open diagram" }));
  const dialog = await screen.findByRole("dialog");
  expect(dialog.querySelector("img")?.getAttribute("src")?.startsWith("data:image/svg+xml")).toBe(
    true,
  );
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

  const tracked = script.calls.filter(([name]) => name === "track");
  expect(tracked).toEqual([
    ["track", "diagram_source_shown", {}],
    ["track", "diagram_opened", {}],
  ]);
});
