// Tells the person, with a notification, that a session wants them while the app is not in front of them. The parts that
// are Electron's (the window, Notification) come in as arguments, so this is tested without Electron, and the whole of what
// it decides is the few lines below.
import type { AppEvent, Translator } from "@cycle/ui";
import type { AttentionNotice } from "./manager.ts";

/** What of a window this needs. */
export type NotifyWindow = {
  isFocused(): boolean;
  isDestroyed(): boolean;
  show(): void;
  focus(): void;
};

/** What of Electron's Notification this needs. */
export type NotificationLike = {
  show(): void;
  on(event: "click", listener: () => void): unknown;
};

export type AttentionDeps = {
  window: () => NotifyWindow | undefined;
  /** Whether the system can show notifications at all. */
  supported: () => boolean;
  create: (options: { title: string; subtitle?: string; body: string }) => NotificationLike;
  translator: Translator;
  emit: (event: AppEvent) => void;
};

const titleOf = (notice: AttentionNotice): string => {
  const { session } = notice;
  if (session.title !== undefined && session.title !== "") return session.title;
  return session.cwd.split("/").filter(Boolean).at(-1) ?? session.cwd;
};

/**
 * The function the manager calls. While the window is in front the person can see the sidebar, and a notification would
 * only repeat it: it is for when they are elsewhere. Pressing it brings the window back and shows the session.
 */
export const notifyAttention = (deps: AttentionDeps) => (notice: AttentionNotice) => {
  const window = deps.window();
  if (window === undefined || window.isDestroyed() || window.isFocused()) return;
  if (!deps.supported()) return;
  const notification = deps.create({
    title: titleOf(notice),
    // Which machine, when it is not this one: the same title may be on two.
    ...(notice.hostId === "local" ? {} : { subtitle: notice.hostName }),
    body: deps.translator.t(`attention.${notice.kind}`),
  });
  notification.on("click", () => {
    const target = deps.window();
    if (target === undefined || target.isDestroyed()) return;
    target.show();
    target.focus();
    deps.emit({
      type: "focus-session",
      hostId: notice.hostId,
      sessionId: notice.session.sessionId,
    });
  });
  notification.show();
};
