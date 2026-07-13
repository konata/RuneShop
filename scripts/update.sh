#!/usr/bin/env bash
set -Eeuo pipefail

ref="${1:-origin/main}"
state="${2:-${HOME}/.runeshop}"
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
bun="${RUNESHOP_BUN:-$(command -v bun || true)}"
[[ -n "$bun" ]] || bun="/root/.bun/bin/bun"

[[ -x "$bun" ]] || { echo "Bun executable not found: $bun" >&2; exit 1; }
command -v flock >/dev/null || { echo "flock is required" >&2; exit 1; }

mkdir -p "$state"
exec 9>"$state/update.lock"
flock -n 9 || { echo "another RuneShop update is already running" >&2; exit 1; }

cd "$root"
[[ -z "$(git status --porcelain)" ]] || { echo "working tree is not clean" >&2; exit 1; }

branch="$(git symbolic-ref --quiet --short HEAD || true)"
expected="${ref#*/}"
[[ "$branch" == "$expected" ]] || { echo "update requires branch $expected, found ${branch:-detached HEAD}" >&2; exit 1; }

echo "Fetching $ref"
git fetch --quiet --prune origin
git rev-parse --verify "${ref}^{commit}" >/dev/null
git merge-base --is-ancestor HEAD "$ref" || { echo "local checkout has diverged from $ref" >&2; exit 1; }

current="$(git rev-parse HEAD)"
remote="$(git rev-parse "$ref")"
[[ "$current" != "$remote" ]] || { echo "RuneShop is already up to date"; exit 0; }

checkout="$(mktemp -d /tmp/runeshop-update.XXXXXX)"
rmdir "$checkout"
cleanup() {
  git -C "$root" worktree remove --force "$checkout" >/dev/null 2>&1 || rm -rf "$checkout"
}
trap cleanup EXIT

echo "Validating ${remote:0:7}"
git worktree add --quiet --detach "$checkout" "$ref"
(
  cd "$checkout"
  "$bun" install --frozen-lockfile
  "$bun" run check
)

echo "Activating ${remote:0:7}"
git merge --ff-only "$ref"
"$bun" install --frozen-lockfile
echo "RuneShop updated to ${remote:0:7}"
