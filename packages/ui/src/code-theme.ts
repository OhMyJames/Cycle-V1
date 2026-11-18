// Which colours code blocks are drawn in. A preference of this machine, kept in the page's storage: no React and no DOM
// here, so it can be tested with a fake storage. Each option is a light and a dark theme of Shiki (the dark one is used
// when the system is dark). Contrast of the text colours on our white and near-black grounds is measured in DESIGN.md.

export type CodeThemeId = "github" | "github-high-contrast" | "vscode" | "one" | "catppuccin";

export const CODE_THEMES: readonly {
  id: CodeThemeId;
  label: string;
  /** Shiki theme names: [light, dark]. */
  themes: readonly [string, string];
}[] = [
  { id: "github", label: "GitHub", themes: ["github-light-default", "github-dark-default"] },
  {
    id: "github-high-contrast",
    label: "GitHub high contrast",
    themes: ["github-light-high-contrast", "github-dark-high-contrast"],
  },
  { id: "vscode", label: "VS Code", themes: ["light-plus", "dark-plus"] },
  { id: "one", label: "One", themes: ["one-light", "one-dark-pro"] },
  { id: "catppuccin", label: "Catppuccin", themes: ["catppuccin-latte", "catppuccin-mocha"] },
];

export const DEFAULT_CODE_THEME: CodeThemeId = "github";
export const CODE_THEME_KEY = "cycle-code-theme";

const isCodeThemeId = (value: unknown): value is CodeThemeId =>
  CODE_THEMES.some((theme) => theme.id === value);

export type Storage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

/** The choice, and a way to hear of a change. A stored value that is not one of the options is ignored. */
export const createCodeThemeStore = (storage: Storage | undefined) => {
  const listeners = new Set<() => void>();
  let current: CodeThemeId = DEFAULT_CODE_THEME;
  try {
    const saved = storage?.getItem(CODE_THEME_KEY);
    if (isCodeThemeId(saved)) current = saved;
  } catch {
    // Storage that cannot be read (disabled, full): the default stands.
  }
  return {
    get: (): CodeThemeId => current,
    set: (id: CodeThemeId): void => {
      if (id === current) return;
      current = id;
      try {
        storage?.setItem(CODE_THEME_KEY, id);
      } catch {
        // Not saved, but the choice holds for this run.
      }
      for (const listener of [...listeners]) listener();
    },
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};

/** The one the page uses. */
export const codeTheme = createCodeThemeStore(
  typeof localStorage === "undefined" ? undefined : localStorage,
);

export const themesOf = (id: CodeThemeId): readonly [string, string] =>
  CODE_THEMES.find((theme) => theme.id === id)?.themes ?? [
    "github-light-default",
    "github-dark-default",
  ];
