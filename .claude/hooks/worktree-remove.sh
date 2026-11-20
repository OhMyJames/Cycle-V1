#!/bin/bash
# WorktreeRemove hook: pair of worktree-create.sh. Claude Code calls it only after deciding the
# worktree may go (clean, or you chose to remove it). Removes the worktree and the
# `worktree-<name>` branch the create hook made; only touches paths under .agents/worktree/.
set -euo pipefail

path=$(jq -er .worktree_path)
[ -d "$path" ] || exit 0

common=$(git -C "$path" rev-parse --path-format=absolute --git-common-dir)
root=$(cd "$(dirname "$common")" && pwd -P)
case "$(cd "$path" && pwd -P)/" in
  "$root/.agents/worktree/"?*) ;;
  *) echo "worktree-remove: $path is not under $root/.agents/worktree/" >&2; exit 1 ;;
esac

branch=$(git -C "$path" symbolic-ref --quiet --short HEAD 2>/dev/null || true)
git -C "$root" worktree remove --force "$path" >&2
git -C "$root" worktree prune >&2 || true
case "$branch" in
  worktree-*) git -C "$root" branch -D "$branch" >&2 || true ;;
esac
