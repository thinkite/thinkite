#!/usr/bin/env bash
# Full local e2e of the pair flow:
#   1. start `sidecode up` in background against a tmp SIDECODE_HOME
#   2. run `sidecode pair` (separate process) to print an offer
#   3. mock client completes qr_bootstrap handshake → keypair persisted
#   4. mock client reconnects via trusted_reconnect → success
#   5. tear down + clean tmp dir
#
# Nothing touches the user's real ~/.sidecode. Pick a port via PORT env
# (default 41260) to avoid conflicting with a real `sidecode up`.
#
# Usage:
#   ./scripts/e2e-pair.sh
#   PORT=41999 ./scripts/e2e-pair.sh

set -euo pipefail

PORT="${PORT:-41260}"
DAEMON_DIR="$(cd "$(dirname "$0")/.." && pwd)"

TMP=$(mktemp -d)
LOG="$TMP/daemon.log"
KEY="$TMP/mock.key"

# Belt-and-suspenders cleanup: kill the daemon if we exit early.
DAEMON_PID=""
cleanup() {
  if [[ -n "$DAEMON_PID" ]]; then
    kill -INT "$DAEMON_PID" 2>/dev/null || true
    wait "$DAEMON_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT INT TERM

cd "$DAEMON_DIR"

step() { printf "\n\033[1;36m[e2e] %s\033[0m\n" "$*"; }
ok() { printf "\033[1;32m✓\033[0m %s\n" "$*"; }
fail() { printf "\033[1;31m✗\033[0m %s\n" "$*" >&2; exit 1; }

step "tmp home: $TMP"
step "port:     $PORT"

# ─── 1. start daemon ──────────────────────────────────────────────────────
step "starting sidecode up (background)"
SIDECODE_HOME="$TMP" pnpm exec tsx src/bin/sidecode.ts up --port "$PORT" > "$LOG" 2>&1 &
DAEMON_PID=$!
sleep 1.5
if ! kill -0 "$DAEMON_PID" 2>/dev/null; then
  cat "$LOG" >&2
  fail "daemon failed to start"
fi
[[ -f "$TMP/daemon.lock" ]] || fail "daemon.lock not written"
ok "daemon up (pid=$DAEMON_PID)"

# ─── 2. sidecode pair ─────────────────────────────────────────────────────
step "sidecode pair"
PAIR_OUT=$(SIDECODE_HOME="$TMP" pnpm exec tsx src/bin/sidecode.ts pair 2>&1)
OFFER=$(printf "%s\n" "$PAIR_OUT" | awk 'NR==3')
[[ -n "$OFFER" ]] || { printf "%s\n" "$PAIR_OUT"; fail "could not extract offer payload"; }
ok "offer printed (${#OFFER} chars)"

# ─── 3. mock client pair ──────────────────────────────────────────────────
step "mock-pair-client pair"
SIDECODE_HOME="$TMP" pnpm exec tsx scripts/mock-pair-client.ts pair "$OFFER" --key="$KEY" > "$TMP/pair.out" 2>&1 \
  || { cat "$TMP/pair.out" >&2; fail "mock client pair failed"; }
grep -q "✓ paired (qr_bootstrap)" "$TMP/pair.out" || { cat "$TMP/pair.out" >&2; fail "no '✓ paired' marker"; }
[[ -f "$KEY" ]] || fail "client keypair not persisted"
KNOWN_COUNT=$(python3 -c "import json;print(len(json.load(open('$TMP/known_clients.json'))['clients']))")
[[ "$KNOWN_COUNT" == "1" ]] || fail "expected 1 paired client, got $KNOWN_COUNT"
ok "first pair complete; known_clients has 1 entry"

# ─── 4. mock client trusted_reconnect ─────────────────────────────────────
step "mock-pair-client auth (trusted_reconnect)"
SIDECODE_HOME="$TMP" pnpm exec tsx scripts/mock-pair-client.ts auth "ws://127.0.0.1:$PORT" --key="$KEY" > "$TMP/auth.out" 2>&1 \
  || { cat "$TMP/auth.out" >&2; fail "mock client auth failed"; }
grep -q "✓ reconnected (trusted_reconnect)" "$TMP/auth.out" || { cat "$TMP/auth.out" >&2; fail "no '✓ reconnected' marker"; }
ok "trusted_reconnect succeeded"

# ─── 5. teardown ──────────────────────────────────────────────────────────
step "stop daemon"
kill -INT "$DAEMON_PID" 2>/dev/null || true
wait "$DAEMON_PID" 2>/dev/null || true
DAEMON_PID=""
ok "daemon stopped"

printf "\n\033[1;32mAll e2e steps passed.\033[0m\n"
printf "tmp dir was %s (now removed).\n" "$TMP"
