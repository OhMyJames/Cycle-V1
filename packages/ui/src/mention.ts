// What an @ in the message may be the start of. Pure TypeScript.

/**
 * The query of a file or folder being named after an @, or undefined. The @ starts the text or follows a space, so that an
 * address like a@b.c is not one; the query runs to the caret and has no space in it. `before` is the text of the caret's
 * block up to the caret.
 */
export const mentionQuery = (before: string): string | undefined =>
  /(?:^|\s)@([^\s@]{0,80})$/.exec(before)?.[1];

/** The name a file or folder is shown by, and the folder it is in. A folder's name ends with a slash. */
export const mentionRow = (
  path: string,
  kind: "file" | "folder",
): { name: string; folder: string } => {
  const at = path.lastIndexOf("/");
  return {
    name: `${path.slice(at + 1)}${kind === "folder" ? "/" : ""}`,
    folder: at < 0 ? "" : path.slice(0, at),
  };
};
