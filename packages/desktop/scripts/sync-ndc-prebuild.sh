#!/bin/sh
# Dev (--node-modules-dir=none) resolves npm packages from the deno global
# cache, where lifecycle scripts never run — so node-datachannel's prebuilt
# .node (a prebuild-install artifact) is missing and WebRTC pairing refuses
# with peer.webrtc_unavailable. Sync the .node that `deno install` already
# built in the local auto tree into the cache copy; the dev embed then ships
# it and require() finds it at the packaged relative path.
#
# Idempotent; re-run cost is one cmp. Self-heals after a cache wipe on the
# next dev start. Missing local build (fresh clone before `deno install`) is
# a warn-and-continue: dev still boots, pairing stays unavailable as before.
set -eu

root="$(cd "$(dirname "$0")/../../.." && pwd)"
deno_dir="${DENO_DIR:-$HOME/Library/Caches/deno}"

src="$(ls "$root"/node_modules/.deno/node-datachannel@*/node_modules/node-datachannel/build/Release/node_datachannel.node 2>/dev/null | head -1 || true)"
if [ -z "$src" ]; then
  echo "[sync-ndc-prebuild] no built node_datachannel.node in local tree (run: deno install) — dev WebRTC will be unavailable" >&2
  exit 0
fi

version="$(echo "$src" | sed -n 's/.*node-datachannel@\([^/+]*\).*/\1/p')"
dest_dir="$deno_dir/npm/registry.npmjs.org/node-datachannel/$version/build/Release"
dest="$dest_dir/node_datachannel.node"

if [ -f "$dest" ] && cmp -s "$src" "$dest"; then
  exit 0
fi

mkdir -p "$dest_dir"
cp "$src" "$dest"
echo "[sync-ndc-prebuild] synced node_datachannel.node ($version) into deno cache" >&2
