// The agent thinking, as one quiet row where it happened: "Thinking…" while it streams, "Thought for 5 sec" once done
// ("Thought" when its times are not known). It opens to the thinking as markdown, through the same sanitized path as a
// reply. Closed unless the person opens it, or has chosen "Expand thinking" in the session menu.
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@ui-sdk/react/collapsible";
import { useState, useSyncExternalStore } from "react";
import { type ThoughtItem, textOf, thoughtMs } from "../model/index.ts";
import { thinking } from "../thinking.ts";
import { useI18n } from "./i18n.tsx";
import { ChevronRightIcon, ThoughtIcon } from "./icons.tsx";
import { Markdown } from "./markdown.tsx";
import { useAppStore } from "./store-context.tsx";
import { durationOf } from "./tool.tsx";

/** Under a second is not worth a number: it reads "Thought". */
const MIN_SHOWN_MS = 1000;

export function ThoughtRow({ item, live }: { item: ThoughtItem; live: boolean }) {
  const i18n = useI18n();
  const { t } = i18n;
  const store = useAppStore();
  const expand = useSyncExternalStore(thinking.subscribe, thinking.get, thinking.get);
  // The person's own choice for this row, once they make one; until then, the menu's.
  const [chosen, setChosen] = useState<boolean | undefined>(undefined);
  const open = chosen ?? expand;
  const took = thoughtMs(item);
  const label = live
    ? t("thought.thinking")
    : took !== undefined && took >= MIN_SHOWN_MS
      ? t("thought.took", { duration: durationOf(i18n, took) })
      : t("thought.done");
  const text = textOf(item.blocks);
  // The text sits in a message slot (role "thought"), so its markdown is set the same way as a reply.
  return (
    <Collapsible
      data-kind="thought"
      data-live={live || undefined}
      open={open}
      onOpenChange={(next) => {
        setChosen(next);
        if (next) store.track("thought_expanded", { live });
      }}
    >
      <CollapsibleTrigger>
        <ThoughtIcon size={14} />
        <span data-slot="thought-label">{label}</span>
        <ChevronRightIcon size={12} data-slot="tool-chevron" aria-hidden="true" />
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div data-slot="thought-text">
          <div data-slot="message" data-role="thought">
            <Markdown text={text} streaming={live} />
          </div>
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}
