import { useEffect, useRef } from "react";
import type { Command } from "../model/index.ts";
import { useI18n } from "./i18n.tsx";

export type CommandMenuProps = {
  id: string;
  commands: readonly Command[];
  active: number;
  onPick: (command: Command) => void;
  onHover: (index: number) => void;
};

/** The id of an option, for the input to say which one is active. */
export const optionId = (id: string, index: number): string => `${id}-${index}`;

/** The commands that fit what is typed, above the input. The input keeps the focus: keys reach the menu through it. */
export function CommandMenu({ id, commands, active, onPick, onHover }: CommandMenuProps) {
  const { t } = useI18n();
  const list = useRef<HTMLDivElement>(null);
  // The active one is kept in view when the arrows go past the ones shown.
  useEffect(() => {
    list.current?.children[active]?.scrollIntoView?.({ block: "nearest" });
  }, [active]);
  return (
    <div
      data-slot="command-menu"
      id={id}
      role="listbox"
      aria-label={t("composer.commands.label")}
      ref={list}
    >
      {commands.map((command, index) => (
        <div
          key={command.name}
          id={optionId(id, index)}
          role="option"
          // Not reached by Tab: the input keeps the focus, and names the active one. These are for the pointer, and for a
          // reader that does reach it.
          tabIndex={-1}
          aria-selected={index === active}
          data-active={index === active || undefined}
          // The mouse must not take the focus from the input.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onPick(command)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") onPick(command);
          }}
          onMouseMove={() => onHover(index)}
        >
          <span data-slot="command-name">/{command.name}</span>
          {command.hint !== undefined ? <span data-slot="command-hint">{command.hint}</span> : null}
          <span data-slot="command-description">{command.description}</span>
        </div>
      ))}
    </div>
  );
}
