#!/usr/bin/env bash
# Package the desktop app from a pristine worktree.
#
# `deno desktop` embeds every deno.json workspace member directory and the
# root node_modules wholesale — no .gitignore awareness, and --exclude does
# not reach either (cli/standalone/binary.rs fill_npm_vfs + workspace member
# walk run outside the exclude logic). Packaging from the working tree
# therefore sweeps in whatever build artifacts happen to exist (packages/app
# ios/Pods alone is ~1.4GB). A fresh worktree contains only committed files,
# so the embed stays at the necessary size (root node_modules + sources).
#
# Usage: scripts/package-desktop.sh [extra `deno desktop` args, e.g. --compress xz]
set -euo pipefail

root=$(git rev-parse --show-toplevel)
head=$(git -C "$root" rev-parse --short HEAD)
tmp=$(mktemp -d "${TMPDIR:-/tmp}/sidecode-pack.XXXXXX")

cleanup() {
  git -C "$root" worktree remove --force "$tmp" 2>/dev/null || true
}
trap cleanup EXIT

echo "==> packaging from pristine worktree @ $head"
git -C "$root" worktree add --detach "$tmp" HEAD >/dev/null

(cd "$tmp" && deno install --frozen)
(cd "$tmp/packages/desktop" && deno desktop -A main.ts "$@")

out="$root/packages/desktop/out"
mkdir -p "$out"
rm -rf "$out/Sidecode.app"
cp -R "$tmp/packages/desktop/Sidecode.app" "$out/"
echo "==> $out/Sidecode.app"
