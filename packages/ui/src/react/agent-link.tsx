import { type MouseEvent, type ReactNode, useState } from "react";
import { ConfirmDialog } from "./dialogs.tsx";
import { useI18n } from "./i18n.tsx";

/**
 * A link the agent wrote, which only http, https and mailto are (`isSafeLink`). The page never follows it: a click asks
 * first, showing the whole address, because the words of a link need not be where it goes. Opening goes through
 * `window.open`, which main hands to the person's browser or mail app (`setWindowOpenHandler`, which checks the
 * protocol again: http, https, mailto). A drag that selects the link's words is not a click on it.
 */
export function AgentLink({
  href,
  children,
  title,
  onOpened,
}: {
  href: string;
  children?: ReactNode;
  title?: string | undefined;
  /** It was opened: the person said yes. */
  onOpened?: (() => void) | undefined;
}) {
  const { t } = useI18n();
  const [asking, setAsking] = useState(false);
  const ask = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    const selection = window.getSelection();
    if (
      selection !== null &&
      !selection.isCollapsed &&
      event.currentTarget.contains(selection.anchorNode)
    )
      return;
    setAsking(true);
  };
  return (
    <>
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        title={title}
        onClick={ask}
        // A middle click opens a window without a click event: it asks as well.
        onAuxClick={(event) => {
          if (event.button === 1) ask(event);
        }}
      >
        {children}
      </a>
      {asking ? (
        <ConfirmDialog
          open
          onOpenChange={setAsking}
          title={t("link.confirmTitle")}
          description={t("link.confirmBody")}
          detail={href}
          confirmLabel={t("link.open")}
          onConfirm={() => {
            window.open(href, "_blank", "noopener,noreferrer");
            onOpened?.();
          }}
        />
      ) : null}
    </>
  );
}
