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
  "cycle-accent-foreground",
  "cycle-attention",
  "cycle-success",
  "cycle-input-border",
  "cycle-focus-ring",
  "cycle-surface-workspace",
  "cycle-surface-sidebar",
  "cycle-surface-raised",
  "cycle-surface-message",
  "cycle-surface-hover",
  "cycle-surface-selected",
  "cycle-border-subtle",
  "cycle-border-default",
  "cycle-ink",
  "cycle-ink-secondary",
  "cycle-ink-muted",
  "cycle-ink-disabled",
];

const RADII = [
  ["sm", "--cycle-radius-sm"],
  ["ui", "--ui-radius"],
  ["card", "--cycle-radius-card"],
  ["message", "--cycle-radius-message"],
  ["composer", "--cycle-radius-composer"],
  ["pill", "--cycle-radius-pill"],
] as const;

export function drawTokens(root: HTMLElement) {
  const style = getComputedStyle(document.documentElement);
  const name = (n: string) => (n.startsWith("cycle-") ? `--${n}` : `--ui-${n}`);
  const value = (n: string) => style.getPropertyValue(name(n)).trim();
  const raw = (cssVar: string) => style.getPropertyValue(cssVar).trim();
  createRoot(root).render(
    <div
      style={{
        padding: "1.5rem",
        display: "flex",
        flexDirection: "column",
        gap: "1.75rem",
        maxWidth: 960,
      }}
    >
      <section>
        <h2
          style={{
            fontFamily: "var(--cycle-font-display)",
            letterSpacing: "var(--cycle-tracking-display)",
            margin: "0 0 0.75rem",
          }}
        >
          Colour
        </h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }}>
          {COLORS.map((c) => (
            <div
              key={c}
              style={{
                border: "1px solid var(--cycle-border-default)",
                borderRadius: "var(--ui-radius)",
                overflow: "hidden",
                background: "var(--cycle-surface-raised)",
                boxShadow: "var(--cycle-edge-hardware)",
              }}
            >
              <div style={{ height: 40, background: `var(${name(c)})` }} />
              <div style={{ padding: "6px 8px", fontSize: "var(--cycle-text-meta)" }}>
                <div style={{ fontWeight: 500 }}>{name(c)}</div>
                <div
                  style={{
                    color: "var(--ui-muted-foreground)",
                    fontFamily: "var(--ui-font-mono)",
                    wordBreak: "break-all",
                  }}
                >
                  {value(c)}
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>
      <section style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <h2
          style={{
            fontFamily: "var(--cycle-font-display)",
            letterSpacing: "var(--cycle-tracking-display)",
            margin: "0 0 0.5rem",
          }}
        >
          Typography (Open Runde / Inter / Geist Mono)
        </h2>
        <div
          style={{
            fontFamily: "var(--cycle-font-display)",
            fontSize: "var(--cycle-text-title)",
            fontWeight: 600,
            letterSpacing: "var(--cycle-tracking-display)",
          }}
        >
          Display (Open Runde 16px / 600): Quiet precision for agentic development.
        </div>
        <div
          style={{ fontSize: "var(--cycle-text-body)", lineHeight: "var(--cycle-leading-body)" }}
        >
          Body (Inter 14px): The agent is reviewing the build and verifying every test before
          commit.
        </div>
        <div style={{ fontSize: "var(--cycle-text-ui)", lineHeight: "var(--cycle-leading-ui)" }}>
          UI (Inter 13px): Fix the remote session · 中文混排 PingFang 字重测试
        </div>
        <div
          style={{
            fontSize: "var(--cycle-text-meta)",
            color: "var(--ui-muted-foreground)",
          }}
        >
          Meta (12px muted): 21% context · Updated 2m ago · Waiting for you
        </div>
        <code style={{ fontFamily: "var(--ui-font-mono)", alignSelf: "flex-start" }}>
          Mono (Geist Mono): bun run check --changed origin/main /packages/ui/src/styles/app.css
        </code>
        <div style={{ color: "var(--cycle-accent)", fontWeight: 500 }}>
          accent: Ready to send (#c93b00 / #fc4c01)
        </div>
        <div style={{ color: "var(--cycle-attention)", fontWeight: 500 }}>
          attention: Waiting for your approval
        </div>
        <div style={{ color: "var(--cycle-success)", fontWeight: 500 }}>
          success: Connected to local daemon
        </div>
        <div style={{ color: "var(--ui-destructive)", fontWeight: 500 }}>
          destructive: Connection refused
        </div>
      </section>
      <section>
        <h2
          style={{
            fontFamily: "var(--cycle-font-display)",
            letterSpacing: "var(--cycle-tracking-display)",
            margin: "0 0 0.75rem",
          }}
        >
          Concentric radii & hardware surface
        </h2>
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          {RADII.map(([label, cssVar]) => (
            <div
              key={label}
              style={{
                minWidth: 88,
                height: 64,
                padding: "0 12px",
                display: "grid",
                placeItems: "center",
                border: "1px solid var(--cycle-border-default)",
                borderRadius: `var(${cssVar})`,
                background: "var(--cycle-surface-raised)",
                boxShadow: "var(--cycle-edge-hardware)",
                fontFamily: "var(--cycle-font-display)",
                fontSize: "var(--cycle-text-meta)",
              }}
            >
              <span>
                {label} · {raw(cssVar)}
              </span>
            </div>
          ))}
        </div>
      </section>
      <section>
        <h2
          style={{
            fontFamily: "var(--cycle-font-display)",
            letterSpacing: "var(--cycle-tracking-display)",
            margin: "0 0 0.75rem",
          }}
        >
          Controls (ui-sdk, Cycle v2)
        </h2>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <Button data-variant="solid">Allow once</Button>
          <Button data-variant="outline">Outline</Button>
          <Button data-variant="ghost">Ghost</Button>
          <Button data-variant="destructive">Delete session</Button>
          <Button disabled>Disabled</Button>
          <Input aria-label="Name" placeholder="Workspace path" style={{ width: 220 }} />
        </div>
      </section>
    </div>,
  );
}
