// The gallery page: `index.html?s=<scenario>` draws that scenario with the real components over a scripted
// bridge, `?s=tokens` draws the tokens, and no `s` lists the scenarios. `&theme=light|dark` forces a scheme.
import { App, StoreProvider } from "@cycle/ui/react";
import { AppStore } from "@cycle/ui/store";
import { createRoot } from "react-dom/client";
import { fakeBridge } from "../test/fake-bridge.ts";
import { LOCAL, type Scenario, scenarios, snapshotOf, UP } from "./scenarios.ts";

const params = new URLSearchParams(location.search);
const name = params.get("s");
const theme = params.get("theme");
if (theme === "light" || theme === "dark") document.documentElement.style.colorScheme = theme;

const root = document.getElementById("root");
if (root === null) throw new Error("no #root");

const bridgeFor = (scenario: Scenario) => {
  const script = fakeBridge({
    connected: true,
    ...(scenario.update ? { update: scenario.update } : {}),
  });
  const hosts = scenario.hosts ?? [LOCAL];
  const status = scenario.status ?? hosts.map((h) => UP(h.id));
  const sessions = scenario.sessions ?? [];
  script.bridge.hosts = async () => ({ hosts, status });
  script.bridge.sessions = async (hostId) => sessions.filter((s) => s.hostId === hostId);
  script.bridge.openSession = async () => snapshotOf(scenario);
  script.bridge.agents = async () => [
    {
      id: "claude",
      name: "Claude",
      available: true,
      configSchema: {
        type: "object",
        properties: {
          model: { type: "string", enum: ["default", "sonnet", "opus"] },
          mode: { type: "string", enum: ["default", "plan", "acceptEdits"] },
        },
      },
    },
  ];
  return script.bridge;
};

const list = () => {
  root.innerHTML = "";
  const ul = document.createElement("ul");
  ul.style.cssText = "font: 14px system-ui; padding: 1rem 2rem; line-height: 1.8";
  const all: [string, { title: string }][] = [
    ["tokens", { title: "Tokens, type, spacing, controls" }],
    ...Object.entries(scenarios),
  ];
  for (const [key, s] of all) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = `?s=${key}`;
    a.textContent = key;
    li.append(a, ` - ${s.title}`);
    ul.append(li);
  }
  root.append(ul);
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const scenario = async (key: string) => {
  const s = scenarios[key];
  if (s === undefined) return list();
  const store = new AppStore(bridgeFor(s));
  createRoot(root).render(
    <StoreProvider store={store}>
      <App />
    </StoreProvider>,
  );
  await store.start();
  // The first session is chosen, as a click would.
  if (s.history !== undefined && (s.sessions ?? []).length > 0) {
    for (let i = 0; i < 100 && root.querySelector('[role="option"]') === null; i++) await sleep(30);
    (root.querySelector('[role="option"]') as HTMLElement | null)?.click();
  }
  await sleep(300);
  await s.after?.(root);
  await sleep(400);
  document.title = "ready";
};

if (name === null) list();
else if (name === "tokens")
  void import("./tokens.tsx").then(({ drawTokens }) => {
    drawTokens(root);
    document.title = "ready";
  });
else void scenario(name);
