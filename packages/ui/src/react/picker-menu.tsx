import { useEffect, useRef } from "react";

/** A choice in a picker: what it is called, a note beside it, and a line of what it is. */
export type PickerRow = { key: string; name: string; hint?: string; description: string };

export type PickerMenuProps = {
  id: string;
  label: string;
  rows: readonly PickerRow[];
  active: number;
  onPick: (index: number) => void;
  onHover: (index: number) => void;
};

/** The id of an option, for the input to say which one is active. */
export const optionId = (id: string, index: number): string => `${id}-${index}`;

/** What fits what is typed, above the input. The input keeps the focus: keys reach the menu through it. */
export function PickerMenu({ id, label, rows, active, onPick, onHover }: PickerMenuProps) {
  const list = useRef<HTMLDivElement>(null);
  // The active one is kept in view when the arrows go past the ones shown.
  useEffect(() => {
    list.current?.children[active]?.scrollIntoView?.({ block: "nearest" });
  }, [active]);
  return (
    <div data-slot="picker" id={id} role="listbox" aria-label={label} ref={list}>
      {rows.map((row, index) => (
        <div
          key={row.key}
          id={optionId(id, index)}
          role="option"
          // Not reached by Tab: the input keeps the focus, and names the active one. These are for the pointer, and for a
          // reader that does reach it.
          tabIndex={-1}
          aria-selected={index === active}
          data-active={index === active || undefined}
          // The mouse must not take the focus from the input.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onPick(index)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") onPick(index);
          }}
          onMouseMove={() => onHover(index)}
        >
          <span data-slot="picker-name">{row.name}</span>
          {row.hint !== undefined ? <span data-slot="picker-hint">{row.hint}</span> : null}
          <span data-slot="picker-description">{row.description}</span>
        </div>
      ))}
    </div>
  );
}
