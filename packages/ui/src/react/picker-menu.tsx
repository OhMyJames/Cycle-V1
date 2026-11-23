import { useEffect, useId, useRef } from "react";

/**
 * A choice in a picker: what it is called, a note beside it, and a line of what it is. `group`: the heading of the
 * rows it is among (rows of a group come together); rows without one are not grouped.
 */
export type PickerRow = {
  key: string;
  name: string;
  hint?: string;
  description: string;
  group?: string;
  /** What it is, for its look: a session's name is a title, not a path. */
  kind?: string;
};

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

/** Rows in runs of the same group, each row with its place in the whole list (the arrows walk the whole list). */
const runsOf = (rows: readonly PickerRow[]) => {
  const runs: { group: string | undefined; rows: { row: PickerRow; index: number }[] }[] = [];
  rows.forEach((row, index) => {
    const last = runs.at(-1);
    if (last !== undefined && last.group === row.group) last.rows.push({ row, index });
    else runs.push({ group: row.group, rows: [{ row, index }] });
  });
  return runs;
};

/** What fits what is typed, above the input. The input keeps the focus: keys reach the menu through it. */
export function PickerMenu({ id, label, rows, active, onPick, onHover }: PickerMenuProps) {
  const list = useRef<HTMLDivElement>(null);
  const headingId = useId();
  // The active one is kept in view when the arrows go past the ones shown.
  useEffect(() => {
    list.current?.ownerDocument
      .getElementById(optionId(id, active))
      ?.scrollIntoView?.({ block: "nearest" });
  }, [active, id]);
  const option = (row: PickerRow, index: number) => (
    <div
      key={row.key}
      id={optionId(id, index)}
      role="option"
      // Not reached by Tab: the input keeps the focus, and names the active one. These are for the pointer, and for a
      // reader that does reach it.
      tabIndex={-1}
      aria-selected={index === active}
      data-active={index === active || undefined}
      data-kind={row.kind}
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
  );
  return (
    <div data-slot="picker" id={id} role="listbox" aria-label={label} ref={list}>
      {runsOf(rows).map((run, at) =>
        run.group === undefined ? (
          run.rows.map(({ row, index }) => option(row, index))
        ) : (
          // A fieldset is a group without a role written on it: the listbox's group, named by its heading.
          <fieldset
            key={`group-${run.group}`}
            data-slot="picker-group"
            aria-labelledby={`${headingId}-${at}`}
          >
            <div data-slot="picker-group-label" id={`${headingId}-${at}`} role="presentation">
              {run.group}
            </div>
            {run.rows.map(({ row, index }) => option(row, index))}
          </fieldset>
        ),
      )}
    </div>
  );
}
