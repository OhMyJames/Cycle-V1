// The tokens and controls, drawn from the live CSS: what a theme gives, not what a document says.
import { Button } from "@ui-sdk/react/button";
import { Input } from "@ui-sdk/react/input";
import { createRoot } from "react-dom/client";

const COLORS = [
  "background",
  "foreground",
  "muted",
  "muted-foreground",
  "border",
  "input",
  "primary",
  "primary-foreground",
  "destructive",
  "ring",
  "ring-border",
  "overlay",
  "cycle-accent",
  "cycle-attention",
  "cycle-success",
];
const SIZES = [0.8, 0.85, 0.9, 1, 1.1];

export function drawTokens(root: HTMLElement) {
  const style = getComputedStyle(document.documentElement);
  const name = (n: string) => (n.startsWith("cycle-") ? `--${n}` : `--ui-${n}`);
  const value = (n: string) => style.getPropertyValue(name(n)).trim();
  createRoot(root).render(
    <div
      style={{
        padding: "1.5rem",
        display: "flex",
        flexDirection: "column",
        gap: "1.5rem",
        maxWidth: 900,
      }}
    >
      <section>
        <h2>Colour</h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 }}>
          {COLORS.map((c) => (
            <div key={c} style={{ border: "1px solid var(--ui-border)" }}>
              <div style={{ height: 40, background: `var(${name(c)})` }} />
              <div style={{ padding: 6, fontSize: "0.8em" }}>
                <div>{name(c)}</div>
                <div style={{ color: "var(--ui-muted-foreground)", wordBreak: "break-all" }}>
                  {value(c)}
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>
      <section>
        <h2>Type</h2>
        {SIZES.map((s) => (
          <div key={s} style={{ fontSize: `${s}em` }}>
            {s}em: The agent is working on the build.
          </div>
        ))}
        <code style={{ fontFamily: "var(--ui-font-mono)" }}>
          mono: bun run check --quick /path/to/file.ts
        </code>
        <div style={{ color: "var(--ui-muted-foreground)" }}>muted: waiting for you</div>
        <div style={{ color: "var(--ui-destructive)" }}>destructive: Connection refused</div>
      </section>
      <section>
        <h2>Spacing and radius</h2>
        <div style={{ display: "flex", gap: 8, alignItems: "end" }}>
          {[1, 2, 3, 4, 6, 8].map((n) => (
            <div
              key={n}
              style={{
                width: `calc(var(--ui-spacing) * ${n})`,
                height: `calc(var(--ui-spacing) * ${n})`,
                background: "var(--ui-primary)",
              }}
              title={String(n)}
            />
          ))}
          <div
            style={{
              width: 48,
              height: 48,
              border: "1px solid var(--ui-border)",
              borderRadius: "var(--ui-radius)",
            }}
          >
            radius {value("radius")}
          </div>
        </div>
      </section>
      <section>
        <h2>Controls (ui-sdk, as used)</h2>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <Button data-variant="solid">Solid</Button>
          <Button data-variant="outline">Outline</Button>
          <Button data-variant="ghost">Ghost</Button>
          <Button data-variant="destructive">Delete session</Button>
          <Button disabled>Disabled</Button>
          <Input aria-label="Name" placeholder="Name" style={{ width: 200 }} />
        </div>
      </section>
    </div>,
  );
}
