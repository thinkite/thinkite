#!/usr/bin/env bash
# Package the desktop app from a pruned staging copy (no git required).
#
# `deno desktop` embeds every workspace member directory and the local
# node_modules wholesale — no .gitignore awareness, and --exclude reaches
# neither (cli/standalone/binary.rs: fill_npm_vfs and the workspace-member
# walk run outside the exclude logic). Packaging straight from the working
# tree therefore sweeps in build artifacts (packages/app's ios/Pods alone
# is ~1.4GB) plus every devDependency.
#
# Instead we stage exactly what the .app needs — electron-builder-style
# production-dependency pruning at the manifest level:
#   - workspace = desktop + daemon + protocol only (no app)
#   - devDependencies stripped everywhere before `deno install`
#   - deno.lock copied in, so surviving deps keep their locked versions
#
# Usage: scripts/package-desktop.sh [extra `deno desktop` args, e.g. --compress xz]
set -euo pipefail

root="$(cd "$(dirname "$0")/../../.." && pwd)"
stage="$(mktemp -d "${TMPDIR:-/tmp}/sidecode-pack.XXXXXX")"
trap 'rm -rf "$stage"' EXIT

echo "==> building desktop frontend"
vite_bin="$root/packages/desktop/node_modules/.bin/vite"
[ -x "$vite_bin" ] || vite_bin="$root/node_modules/.bin/vite"
(cd "$root/packages/desktop" && "$vite_bin" build)

echo "==> staging runtime members at $stage"
mkdir -p "$stage/packages"
cp "$root/deno.lock" "$stage/"
rsync -a \
  --exclude node_modules \
  --exclude .tanstack \
  --exclude .DS_Store \
  --exclude Sidecode.app \
  --exclude out \
  "$root/packages/desktop" "$root/packages/daemon" "$root/packages/protocol" \
  "$stage/packages/"

python3 - "$root" "$stage" <<'EOF'
import json, sys

root, stage = sys.argv[1], sys.argv[2]

# Packaging workspace: the three runtime members. The app package is pure
# dead weight inside the desktop bundle.
cfg = json.load(open(f"{root}/deno.json"))
cfg["workspace"] = ["packages/desktop", "packages/daemon", "packages/protocol"]
json.dump(cfg, open(f"{stage}/deno.json", "w"), indent=2)

# Strip devDependencies so `deno install` materializes the production
# closure only; deno.lock keeps the surviving deps pinned.
pkg = json.load(open(f"{root}/package.json"))
pkg.pop("devDependencies", None)
json.dump(pkg, open(f"{stage}/package.json", "w"), indent=2)

for member in ("desktop", "daemon", "protocol"):
    path = f"{stage}/packages/{member}/package.json"
    pkg = json.load(open(path))
    pkg.pop("devDependencies", None)
    json.dump(pkg, open(path, "w"), indent=2)
EOF

echo "==> installing production dependencies"
(cd "$stage" && deno install)

echo "==> packaging"
(cd "$stage/packages/desktop" && deno desktop -A main.ts "$@")

out="$root/packages/desktop/out"
mkdir -p "$out"
rm -rf "$out/Sidecode.app"
cp -R "$stage/packages/desktop/Sidecode.app" "$out/"
echo "==> $out/Sidecode.app"
