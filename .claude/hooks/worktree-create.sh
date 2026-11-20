#!/bin/bash
# WorktreeCreate hook: put Claude Code worktrees in <main checkout>/.agents/worktree/<name>
# instead of the default .claude/worktrees/<name>.
#
# Mirrors Claude Code's defaults: branch `worktree-<name>` from the remote default branch
# (worktree.baseRef "fresh"), and reopen an existing worktree of the same name.
# Everything except the final path goes to stderr; Claude Code reads the last stdout line.
set -euo pipefail

input=$(cat)
name=$(jq -er .name <<<"$input")
cwd=$(jq -r '.cwd // empty' <<<"$input")
cwd=${cwd:-$PWD}

case "$name" in
  "" | /* | *..* | *//* ) echo "worktree-create: refusing name '$name'" >&2; exit 1 ;;
esac
if [[ ! "$name" =~ ^[A-Za-z0-9._/-]+$ ]]; then
  echo "worktree-create: refusing name '$name'" >&2
  exit 1
fi

# The main checkout, even when called from inside another worktree.
common=$(git -C "$cwd" rev-parse --path-format=absolute --git-common-dir)
root=$(cd "$(dirname "$common")" && pwd -P)
dir="$root/.agents/worktree/$name"
branch="worktree-$name"

if [ -d "$dir" ]; then
  if git -C "$dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "worktree-create: reusing $dir" >&2
    echo "$dir"
    exit 0
  fi
  echo "worktree-create: $dir exists and is not a worktree" >&2
  exit 1
fi

# Base: the remote default branch, refreshed without ever prompting; fall back to HEAD.
export GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND="ssh -o BatchMode=yes"
git -C "$root" fetch --quiet origin >&2 2>&1 || echo "worktree-create: fetch failed, using cached refs" >&2
base=$(git -C "$root" symbolic-ref --quiet refs/remotes/origin/HEAD 2>/dev/null || true)
if [ -z "$base" ]; then
  if git -C "$root" rev-parse --verify --quiet refs/remotes/origin/main >/dev/null; then
    base=refs/remotes/origin/main
  else
    base=HEAD
  fi
fi

mkdir -p "$(dirname "$dir")"
if git -C "$root" rev-parse --verify --quiet "refs/heads/$branch" >/dev/null; then
  git -C "$root" worktree add "$dir" "$branch" >&2
else
  git -C "$root" worktree add --no-track -b "$branch" "$dir" "$base" >&2
fi

# Gitignored local files a fresh checkout lacks (what .worktreeinclude would have copied).
for f in "$root"/.env "$root"/.env.*; do
  [ -f "$f" ] && [ "$(basename "$f")" != ".env.example" ] && cp -p "$f" "$dir/" || true
done

# Dependencies, so the new session can run the gate right away. Not fatal.
(cd "$dir" && bun install --frozen-lockfile) >&2 2>&1 || echo "worktree-create: bun install failed; run it in $dir" >&2

echo "$dir"
