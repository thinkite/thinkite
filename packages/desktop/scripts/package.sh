#!/usr/bin/env bash
# Build + sign a distributable Sidecode.app (and optionally a notarized .dmg).
#
#   SIGN_ID="Developer ID Application: <you> (<TEAM>)" ./scripts/package.sh
#   NOTARIZE=1 NOTARY_KEY_JSON=~/notary.json SIGN_ID=… ./scripts/package.sh
#
# Without SIGN_ID the app keeps `deno desktop`'s ad-hoc signature — runs
# locally, not distributable. SIGN_ID is intentionally env-only (no identity
# committed to the repo).
#
# Real-identity signing REQUIRES the re-sign step below: `deno desktop` signs
# the webview host with Hardened Runtime but EMPTY entitlements, and V8 then
# crashes at launch allocating JIT memory (sidecode#23, validated in T-Gate 2).
# We re-sign inside-out with the same 5 entitlements deno's own CLI uses
# (scripts/entitlements.plist) — which also lets the vendored pty FFI dylib
# load under library validation.
set -euo pipefail
cd "$(dirname "$0")/.."

APP_NAME="${APP_NAME:-Sidecode}"
BUNDLE_ID="${BUNDLE_ID:-app.sidecode.desktop}"
SIGN_ID="${SIGN_ID:-}"
ENTITLEMENTS="$PWD/scripts/entitlements.plist"
NOTARIZE="${NOTARIZE:-0}"
NOTARY_KEY_JSON="${NOTARY_KEY_JSON:-$HOME/Downloads/notarize-key.json}" # {key_id, issuer_id, private_key}

APP="$APP_NAME.app"; DMG="$APP_NAME.dmg"
sign() { codesign --force --timestamp --options runtime "$@"; }

echo "==> build web bundle (vite)"
pnpm build

echo "==> compile desktop app ($APP)"
rm -rf "$APP" "$DMG"
# --include dist:   main.ts serves the SPA from import.meta.dirname/dist
# --include vendor: server/pty.ts loads the pty dylib from ../vendor (a signed
#                   .app must never download binaries at runtime)
deno desktop -A --minimum-dependency-age=0 \
  --include dist --include vendor \
  --output "$APP" main.ts

if [ -n "$SIGN_ID" ]; then
  echo "==> re-sign inside-out (Developer ID + deno CLI entitlements)"
  # Nested Mach-O first: runtime dylib(s) in MacOS/ + anything embedded via
  # --include (the vendored pty dylib). Entitlements only matter on the main
  # executable; libraries just need valid Developer ID signatures.
  find "$APP" -type f \( -name "*.dylib" -o -name "*.node" \) | while read -r lib; do
    sign -s "$SIGN_ID" "$lib"
  done
  for f in "$APP/Contents/MacOS/"*; do
    case "$(file -b "$f")" in
      *Mach-O*executable*) sign --entitlements "$ENTITLEMENTS" --identifier "$BUNDLE_ID" -s "$SIGN_ID" "$f" ;;
    esac
  done
  sign --entitlements "$ENTITLEMENTS" --identifier "$BUNDLE_ID" -s "$SIGN_ID" "$APP"
  codesign --verify --deep --strict "$APP"
  echo "==> signature OK"
else
  echo "==> SIGN_ID not set — keeping ad-hoc signature (local use only)"
fi

if [ "$NOTARIZE" = 1 ]; then
  [ -n "$SIGN_ID" ] || { echo "NOTARIZE=1 requires SIGN_ID"; exit 1; }
  echo "==> build + sign dmg"
  STAGE="$(mktemp -d)"
  cp -Rc "$APP" "$STAGE/$APP" # APFS clonefile
  ln -s /Applications "$STAGE/Applications"
  hdiutil create -volname "$APP_NAME" -srcfolder "$STAGE" -fs HFS+ -format UDZO -ov "$DMG" >/dev/null
  rm -rf "$STAGE"
  sign -s "$SIGN_ID" "$DMG"

  echo "==> notarize ($DMG) — waits for Apple"
  KEY="$(mktemp /tmp/notary.XXXXXX.p8)"
  trap 'rm -f "$KEY"' EXIT
  creds=$(python3 - "$NOTARY_KEY_JSON" "$KEY" <<'PY'
import json, sys
d = json.load(open(sys.argv[1])); pk = d["private_key"].strip()
if "-----BEGIN" not in pk:
    pk = "-----BEGIN PRIVATE KEY-----\n" + "\n".join(pk[i:i+64] for i in range(0, len(pk), 64)) + "\n-----END PRIVATE KEY-----\n"
open(sys.argv[2], "w").write(pk)
print(d["key_id"], d["issuer_id"])
PY
  )
  KID="${creds% *}"; ISS="${creds#* }"
  xcrun notarytool submit "$DMG" --key "$KEY" --key-id "$KID" --issuer "$ISS" --wait
  echo "==> staple"
  xcrun stapler staple "$DMG"
  xcrun stapler staple "$APP"
  ls -lh "$DMG" | awk '{print $5, $9}'
fi

echo "==> done: $PWD/$APP"
