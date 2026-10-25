import semver from "semver";
import { z } from "zod";
import pkg from "../package.json" with { type: "json" };

export {
  decodeWireFrameLength,
  decodeWireFramePayload,
  encodeWireFrame,
  IROH_HTTP_ALPN,
  IROH_RPC_ALPN,
  IROH_TCP_ALPN,
  IROH_TCP_HEADER_BYTES,
  MAX_WIRE_FRAME_BYTES,
  WIRE_FRAME_HEADER_BYTES,
} from "./wire-frame.ts";

// ─── Protocol version ──────────────────────────────────────────────────────
//
// Single source of truth for "what wire schemas does this side speak."
// The protocol package IS the wire contract, so its semver IS the wire
// version — daemon and iOS both import this same value (whatever's in
// `packages/protocol/package.json`'s `version` field).
//
// Bumping = edit `packages/protocol/package.json` (e.g. `npm version
// patch`). No constant elsewhere to keep in sync; the package.json IS
// the source of truth, both at npm-install time and at runtime.
//
// Compatibility check (`isProtocolCompatible`) also lives in this
// package so the rule travels with the schemas it's protecting.
// Transports just call the helper; they don't reason about semver
// themselves.
//
// Bump policy:
//   - **patch** (0.0.1 → 0.0.2 / 1.2.3 → 1.2.4): additive only — a new
//     optional field, or a whole new frame type that older peers
//     harmlessly ignore (the daemon drops unknown command types, iOS
//     drops unknown event types; no `z.strictObject`, so extra fields
//     are stripped). NOTE: a new *enum case* on an EXISTING field is NOT
//     automatically additive — it's breaking for a closed `z.enum` the
//     daemon validates (old daemon rejects the whole frame) or for any
//     consumer that switches on the value without a default. Treat an
//     enum-case add as breaking unless that field is a loose string with
//     a fallback path. Compatible.
//   - **minor** (0.0.x → 0.1.0 during 0.x; 1.0.0 → 1.1.0 post-1.0):
//     0.x minor bump is breaking (npm semver convention for 0.x);
//     ≥1.0 minor bump is additive. The compat helper handles both.
//   - **major** (1.x → 2.0.0): breaking schema change post-1.0.
//   - **pre-release** (`0.5.0-beta.1`): NOT compatible with `0.5.0`
//     per semver convention — pre-releases are explicitly opt-in.
export const PROTOCOL_VERSION: string = pkg.version;

/**
 * True iff a remote peer reporting `remote` speaks a wire-compatible
 * schema set with this build's PROTOCOL_VERSION. Compatible means
 * "same breaking line", per the bump policy above:
 *
 *   - during 0.x the minor is the breaking axis → same `0.minor` line
 *     (`0.5.1` ↔ `0.5.9` compatible in both directions, `0.6.0` not)
 *   - ≥1.0 the major is the breaking axis → same major
 *   - pre-release on either side → exact match only (mid-development
 *     schemas churn; two builds are only known-compatible if identical)
 *
 * Deliberately NOT npm caret semantics. `satisfies(remote, ^local)` is
 * asymmetric — it rejects a remote with a LOWER patch on the same
 * breaking line, but the bump policy says patch bumps are additive and
 * old peers harmlessly ignore them. Symmetric same-line comparison is
 * the faithful implementation, and it guarantees the daemon (which
 * checks `hello` first) always rejects before iOS gets a chance to —
 * iOS's `server_info` re-check is pure drift defense.
 *
 * Returns `false` on unparseable input (defensive — we'd rather refuse
 * than blunder on with an unknown version that might or might not be
 * compatible).
 */
export function isProtocolCompatible(remote: string): boolean {
  const r = semver.parse(remote);
  const local = semver.parse(PROTOCOL_VERSION);
  if (!r || !local) return false;
  if (r.prerelease.length > 0 || local.prerelease.length > 0) {
    return semver.eq(r, local);
  }
  if (r.major !== local.major) return false;
  return local.major === 0 ? r.minor === local.minor : true;
}

/**
 * Which side is outdated, given the version an INCOMPATIBLE remote
 * reported. Only meaningful after `isProtocolCompatible(remote)`
 * returned false — incompatible versions are never equal, so the
 * semver-lower side is the one that needs updating.
 *
 * Returns from the caller's perspective: `"remote"` → the peer is
 * older (iOS calling this → tell the user to update the Mac app),
 * `"local"` → this build is older. Returns `null` when the input is
 * unparseable or equal to ours (a peer that rejected us while
 * reporting our own version is misbehaving, not outdated) — callers
 * fall back to direction-neutral "update both" copy.
 */
export function outdatedSide(remote: string): "local" | "remote" | null {
  if (!semver.valid(remote) || !semver.valid(PROTOCOL_VERSION)) return null;
  if (semver.eq(remote, PROTOCOL_VERSION)) return null;
  return semver.lt(remote, PROTOCOL_VERSION) ? "remote" : "local";
}

// ─── Pair offer ────────────────────────────────────────────────────────────
//
// The QR carries just enough to dial + identity-verify the daemon.
// Connection itself is iroh QUIC: `daemonIdentityPublicKey` IS the
// daemon's iroh EndpointId, so the client dials it directly (relays +
// pkarr discovery resolve it to reachable addresses) and the QUIC
// handshake proves the daemon holds the matching private key.
//
// Two fields:
//   - `daemonIdentityPublicKey` — base64url ed25519 raw pubkey ==
//     iroh EndpointId. The 16-hex daemon fingerprint is
//     `sha256(pubkey).slice(0,16)` — derived, not transmitted.
//   - `serviceName` — `os.hostname()` snapshot for the iOS confirm UI.
//
// The QR carries no expiry. Admission of an unknown pubkey is gated
// daemon-side by "is the desktop app's Pair window open" — that flag, not the
// QR, is the authority on "can a fresh client pair right now." A stale
// screenshot is harmless once the window closes.

export const PAIR_OFFER_VERSION = 2;

export const pairOfferFrame = z.object({
  type: z.literal("pair.offer"),
  v: z.number().int(),
  daemonIdentityPublicKey: z.string(), // base64url ed25519 raw pubkey
  serviceName: z.string(),
});

export type PairOfferFrame = z.infer<typeof pairOfferFrame>;

/**
 * On-the-wire pair offer with one-character keys. The QR is the only
 * place this frame ever appears, and every character in the QR payload
 * costs us ~1 module in the rendered grid. Compacting to single letters
 * keeps the QR a couple version steps smaller.
 */
const pairOfferWire = z.object({
  v: z.number().int(),
  k: z.string(), // daemonIdentityPublicKey
  s: z.string(), // serviceName
});
export type PairOfferWire = z.infer<typeof pairOfferWire>;

export function toPairOfferWire(offer: PairOfferFrame): PairOfferWire {
  return { v: offer.v, k: offer.daemonIdentityPublicKey, s: offer.serviceName };
}

export function fromPairOfferWire(wire: unknown): PairOfferFrame {
  const parsed = pairOfferWire.parse(wire);
  return {
    type: "pair.offer",
    v: parsed.v,
    daemonIdentityPublicKey: parsed.k,
    serviceName: parsed.s,
  };
}

/** Encode a pair offer to its QR wire form: base64url of UTF-8 JSON. */
export function encodePairOffer(offer: PairOfferFrame): string {
  const json = JSON.stringify(toPairOfferWire(offer));
  return base64urlEncodeUtf8(json);
}

/** Decode the wire form produced by `encodePairOffer`. */
export function decodePairOfferPayload(payload: string): PairOfferFrame {
  return fromPairOfferWire(JSON.parse(base64urlDecodeUtf8(payload)));
}

function base64urlEncodeUtf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 1) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecodeUtf8(b64: string): string {
  const padded = b64 + "===".slice(0, (4 - (b64.length % 4)) % 4);
  const std = padded.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(std);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// ─── Git status: snapshot (get) + live subscription (workspace info bar) ──
//
// Split into two RPCs so the client maps onto the canonical react-query
// realtime shape: `getGitStatus` is the one-shot snapshot (queryFn —
// cached + deduped daemon-side, symmetric with `getWorkingTreeDiff`), and
// `subscribeGitStatus` is a PURE change stream (no initial in its response)
// that pushes `gitStatus` events as the per-cwd watcher detects changes
// (client folds each into the query cache). Closing the DataChannel
// implicitly unsubscribes; an explicit `unsubscribeGitStatus` releases the
// watcher ref-count early so the daemon can dispose its fs.watch handles.

export const gitStatus = z.object({
  /** False when `cwd` isn't a git repository. Numeric fields are zero,
   *  `branch` is null, `project` is still filled with basename(cwd). */
  isRepo: z.boolean(),
  /** `path.basename(cwd)`. Daemon's heuristic — what the user sees in
   *  Finder, no `package.json` peek, works for any language. */
  project: z.string(),
  /** Null when not a repo OR in detached-HEAD state. */
  branch: z.string().nullable(),
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
  insertions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  isDirty: z.boolean(),
});
export type GitStatus = z.infer<typeof gitStatus>;

/** One-shot snapshot for `cwd`. Reuses the per-cwd watcher's cached
 *  `refresh()` (15s TTL + in-flight dedup), so firing this concurrently
 *  with `subscribeGitStatus` costs at most one git invocation. */
export const getGitStatusCommand = z.object({
  type: z.literal("getGitStatus"),
  requestId: z.string(),
  cwd: z.string(),
});

export const getGitStatusResponse = z.object({
  type: z.literal("getGitStatus.response"),
  requestId: z.string(),
  cwd: z.string(),
  status: gitStatus,
});

export const subscribeGitStatusCommand = z.object({
  type: z.literal("subscribeGitStatus"),
  requestId: z.string(),
  cwd: z.string(),
});

/** Pure change-stream ack — NO initial snapshot (use `getGitStatus`).
 *  The watcher's listener fires only on subsequent changes, delivered as
 *  `gitStatus` events. */
export const subscribeGitStatusResponse = z.object({
  type: z.literal("subscribeGitStatus.response"),
  requestId: z.string(),
  cwd: z.string(),
});

export const unsubscribeGitStatusCommand = z.object({
  type: z.literal("unsubscribeGitStatus"),
  requestId: z.string(),
  cwd: z.string(),
});

export const unsubscribeGitStatusResponse = z.object({
  type: z.literal("unsubscribeGitStatus.response"),
  requestId: z.string(),
});

/** Server-initiated push. `cwd` is the routing key — iOS may subscribe
 *  to multiple cwds (e.g. listing pages) and route by this field. */
export const gitStatusEvent = z.object({
  type: z.literal("gitStatus"),
  cwd: z.string(),
  status: gitStatus,
});

// ─── Working-tree diff (one-shot RPC; opened from the status bar) ──────────
//
// Returns the raw unified diff matching the `+N -M` the status bar shows:
// `git diff <ref>` against the SAME comparison ref the watcher uses (upstream
// tracking ref, else HEAD) for tracked changes, PLUS synthesized all-add
// patches for untracked non-binary files (`git diff` never sees untracked, but
// the count includes them). `diff` is "" when the tree is clean.

export const getWorkingTreeDiffCommand = z.object({
  type: z.literal("getWorkingTreeDiff"),
  requestId: z.string(),
  cwd: z.string(),
});

export const getWorkingTreeDiffResponse = z.object({
  type: z.literal("getWorkingTreeDiff.response"),
  requestId: z.string(),
  cwd: z.string(),
  /** False when `cwd` isn't a git repository (`diff` is then ""). */
  isRepo: z.boolean(),
  /** Raw multi-file unified diff (tracked vs comparison ref + untracked
   *  all-add patches). "" when there are no changes. */
  diff: z.string(),
  /** Number of files present in `diff` (tracked changed + untracked
   *  included). Matches what renders — excludes untracked files dropped by
   *  the caps. 0 when clean / non-repo. */
  fileCount: z.number().int().nonnegative(),
  /** True when untracked synthesis hit its caps (>500 files, or a file
   *  >256 KiB skipped) — the diff is "useful" not "exhaustive". */
  truncated: z.boolean(),
});

// ─── Filesystem browser (cwd picker + V0.5+ file picker) ───────────────────
//
// One workhorse RPC + one bootstrap RPC. The workhorse `listDirectory`
// reads a single directory level (Finder-style hierarchical browser);
// the bootstrap `getFilesystemRoots` returns the home/desktop/documents
// paths iOS needs as starting points + a recents list aggregated from
// session history (since iOS doesn't know the daemon machine's HOME).
//
// File-picker readiness: `includeFiles` defaults to false for V0's
// folder-only picker; flipping it surfaces files too. `directoryEntry`
// carries optional size + modifiedAt so a future file picker can show
// metadata without a schema bump. To skip the per-file stat cost in
// the V0 folder-only path, the daemon's handler ONLY stats entries
// when `includeFiles === true`.

export const directoryEntry = z.object({
  /** Last path segment, e.g. "src" or "package.json". */
  name: z.string(),
  /** Absolute path. */
  path: z.string(),
  kind: z.enum(["directory", "file"]),
  /** Size in bytes. Populated only when the response includes files
   *  AND the daemon could stat the entry. Absent otherwise. */
  size: z.number().optional(),
  /** ISO 8601 mtime. Populated alongside `size` only. */
  modifiedAt: z.string().optional(),
});
export type DirectoryEntry = z.infer<typeof directoryEntry>;

export const listDirectoryCommand = z.object({
  type: z.literal("listDirectory"),
  requestId: z.string(),
  /** Absolute path, or "~" / "~/..." (server expands to HOME). Anything
   *  else (relative paths, "~user") is treated as-is and likely errors. */
  path: z.string(),
  /** Include files in the response. Default false — V0 folder picker
   *  needs directories only, skipping files lets the daemon skip the
   *  per-entry stat loop entirely. */
  includeFiles: z.boolean().optional(),
  /** Include dotfile / dot-directory entries (.git, .config, etc.).
   *  Default false. */
  includeHidden: z.boolean().optional(),
});

export const listDirectoryResponse = z.object({
  type: z.literal("listDirectory.response"),
  requestId: z.string(),
  /** Echoed canonical absolute path of the listed dir (post-"~"-expansion). */
  path: z.string(),
  /** Parent absolute path for breadcrumb / up-nav. Null when at the
   *  filesystem root ("/"). */
  parent: z.string().nullable(),
  /** Sorted by daemon: directories first, then files; alphabetical
   *  within each group (case-insensitive). iOS can render straight
   *  through without re-sorting. */
  entries: z.array(directoryEntry),
});

/** Recent cwd entry — union of Desktop session cwds and sidecode session
 *  cwds, filtered to only paths that still exist on disk (stale cwds
 *  from deleted/moved projects are dropped). */
export const recentCwd = z.object({
  path: z.string(),
  /** ISO 8601 timestamp of the most recent session activity at this cwd. */
  lastUsedAt: z.string(),
});

export const getFilesystemRootsCommand = z.object({
  type: z.literal("getFilesystemRoots"),
  requestId: z.string(),
});

export const getFilesystemRootsResponse = z.object({
  type: z.literal("getFilesystemRoots.response"),
  requestId: z.string(),
  /** Daemon machine's HOME directory absolute path (e.g.
   *  "/Users/you"). Always populated — every OS has $HOME. */
  home: z.string(),
  /** `${home}/Desktop` if it exists on disk. Optional because Desktop
   *  is not universal (Linux headless servers / non-standard XDG
   *  locales lack it); macOS always has it. */
  desktop: z.string().optional(),
  /** `${home}/Documents` if it exists on disk. Same optionality
   *  reasoning as `desktop`. */
  documents: z.string().optional(),
  /** Recent project cwds, sorted by lastUsedAt desc, deduped and
   *  filtered to existing paths. Max 10. */
  recentCwds: z.array(recentCwd),
});

// ─── Previews: servers the agent started ──────────────────────────────────
//
// The agent starts dev servers and APIs with the daemon's `server_start`
// (docs/preview-tool-v1.md); to show the user a page it writes the link in
// its reply, and the client the user reads it in opens it by its port. Per
// project directory, same shape as git status: `getPreviews` is the
// snapshot, `subscribePreviews` a pure change stream of full `previews`
// snapshots. Separately, `forwardPorts` lists every running server's ports
// across projects: what the phone forwards while it is in the foreground.

export const previewEntry = z.object({
  /** The agent's label, unique per directory ("web", "api"). */
  name: z.string(),
  /** The TCP ports its processes listen on, ascending, as last seen: kept
   *  after it ends. Absent until it listens. A link in a reply to
   *  `localhost` on one of these ports is this server's page. */
  ports: z.array(z.number().int().positive()).optional(),
  /** `http://localhost:<lowest port>/`, with `ports`: the page the Servers
   *  list opens. */
  url: z.string().optional(),
  status: z.enum(["running", "ended"]),
  /** The shell's command. */
  command: z.string(),
  /** When its shell started, and the session whose agent started it. */
  started: z.object({ at: z.number(), sessionID: z.string().optional() }),
  /** How it ended: the user's stop button, an agent's `server_stop` (and
   *  which session), the process exiting, or something outside Thinkite
   *  (opencode's kill, a service restart). */
  ended: z
    .object({
      at: z.number(),
      by: z.enum(["user", "agent", "process", "external"]),
      sessionID: z.string().optional(),
      exit: z.number().int().optional(),
    })
    .optional(),
});
export type PreviewEntry = z.infer<typeof previewEntry>;

export const getPreviewsCommand = z.object({
  type: z.literal("getPreviews"),
  requestId: z.string(),
  directory: z.string(),
});

export const getPreviewsResponse = z.object({
  type: z.literal("getPreviews.response"),
  requestId: z.string(),
  directory: z.string(),
  entries: z.array(previewEntry),
});

/** Pure change-stream ack — NO initial snapshot (use `getPreviews`). */
export const subscribePreviewsCommand = z.object({
  type: z.literal("subscribePreviews"),
  requestId: z.string(),
  directory: z.string(),
});

export const subscribePreviewsResponse = z.object({
  type: z.literal("subscribePreviews.response"),
  requestId: z.string(),
  directory: z.string(),
});

export const unsubscribePreviewsCommand = z.object({
  type: z.literal("unsubscribePreviews"),
  requestId: z.string(),
  directory: z.string(),
});

export const unsubscribePreviewsResponse = z.object({
  type: z.literal("unsubscribePreviews.response"),
  requestId: z.string(),
});

/** The user's stop button: the agent's `server_stop`, recorded as the
 *  user's. */
export const stopPreviewCommand = z.object({
  type: z.literal("stopPreview"),
  requestId: z.string(),
  directory: z.string(),
  name: z.string(),
});

export const stopPreviewResponse = z.object({
  type: z.literal("stopPreview.response"),
  requestId: z.string(),
});

/** Server-initiated push: the directory's full snapshot after any change. */
export const previewsEvent = z.object({
  type: z.literal("previews"),
  directory: z.string(),
  entries: z.array(previewEntry),
});

/** A port a running server listens on, in any project. */
export const forwardPort = z.object({
  port: z.number().int().positive(),
  directory: z.string(),
  name: z.string(),
});
export type ForwardPort = z.infer<typeof forwardPort>;

export const getForwardPortsCommand = z.object({
  type: z.literal("getForwardPorts"),
  requestId: z.string(),
});

export const getForwardPortsResponse = z.object({
  type: z.literal("getForwardPorts.response"),
  requestId: z.string(),
  ports: z.array(forwardPort),
});

/** Pure change-stream ack — NO initial snapshot (use `getForwardPorts`). */
export const subscribeForwardPortsCommand = z.object({
  type: z.literal("subscribeForwardPorts"),
  requestId: z.string(),
});

export const subscribeForwardPortsResponse = z.object({
  type: z.literal("subscribeForwardPorts.response"),
  requestId: z.string(),
});

export const unsubscribeForwardPortsCommand = z.object({
  type: z.literal("unsubscribeForwardPorts"),
  requestId: z.string(),
});

export const unsubscribeForwardPortsResponse = z.object({
  type: z.literal("unsubscribeForwardPorts.response"),
  requestId: z.string(),
});

/** Server-initiated push: the full list whenever it changes. */
export const forwardPortsEvent = z.object({
  type: z.literal("forwardPorts"),
  ports: z.array(forwardPort),
});

// ─── Health + error ────────────────────────────────────────────────────────

export const pingFrame = z.object({
  type: z.literal("ping"),
  t: z.number(),
});

export const pongFrame = z.object({
  type: z.literal("pong"),
  t: z.number(),
  echoT: z.number(),
});

export const errorFrame = z.object({
  type: z.literal("error"),
  requestId: z.string().optional(),
  code: z.enum([
    "invalid_message",
    "unauthenticated",
    "session_not_found",
    "internal",
    "unsupported",
    "rate_limited",
    "incompatible_protocol",
    // Filesystem browser errors (listDirectory / getFilesystemRoots).
    "not_found",
    "permission_denied",
    "not_a_directory",
  ]),
  message: z.string(),
  /** Sender's PROTOCOL_VERSION. Set on `incompatible_protocol` VERSION-
   *  mismatch rejections so the receiver can run `outdatedSide()` and
   *  name the side that needs updating. Deliberately absent on the
   *  other `incompatible_protocol` use (frame-before-hello, a protocol-
   *  misuse rejection where versions may well be EQUAL and direction is
   *  meaningless) and on all other codes. */
  protocolVersion: z.string().optional(),
});

// ─── Hello / server_info (wire-version handshake on stream open) ──────────
//
// iOS sends `hello` as the first frame on the RPC stream carrying its
// PROTOCOL_VERSION. Daemon checks compatibility via `isProtocolCompatible`
// and responds with its own `server_info` (or with
// `error{code:"incompatible_protocol", protocolVersion}` + close on
// mismatch — the version lets iOS name which side is outdated via
// `outdatedSide`). iOS treats `server_info` as the "ready" signal —
// application commands may only flow after it arrives.
//
// Single field exchanged each way. There's no separate "app release
// version" / "daemon release version" — the protocol package owns the
// only version that matters for whether the two ends can talk.

export const helloCommand = z.object({
  type: z.literal("hello"),
  protocolVersion: z.string(),
});

export const serverInfoEvent = z.object({
  type: z.literal("server_info"),
  protocolVersion: z.string(),
});

export type HelloCommand = z.infer<typeof helloCommand>;
export type ServerInfoEvent = z.infer<typeof serverInfoEvent>;

// ─── Top-level direction unions (parse the wire against these) ─────────────
//
// The RPC carries what opencode does not offer the phone: git status and
// diffs, the folder picker, the agent's servers and pages, and the ports to
// forward. Sessions, prompts and transcripts go to opencode over the HTTP
// tunnel (IROH_HTTP_ALPN) instead.

export const command = z.discriminatedUnion("type", [
  getGitStatusCommand,
  subscribeGitStatusCommand,
  unsubscribeGitStatusCommand,
  getWorkingTreeDiffCommand,
  listDirectoryCommand,
  getFilesystemRootsCommand,
  getPreviewsCommand,
  subscribePreviewsCommand,
  unsubscribePreviewsCommand,
  stopPreviewCommand,
  getForwardPortsCommand,
  subscribeForwardPortsCommand,
  unsubscribeForwardPortsCommand,
]);

export type Command = z.infer<typeof command>;

export const response = z.discriminatedUnion("type", [
  getGitStatusResponse,
  subscribeGitStatusResponse,
  unsubscribeGitStatusResponse,
  getWorkingTreeDiffResponse,
  listDirectoryResponse,
  getFilesystemRootsResponse,
  getPreviewsResponse,
  subscribePreviewsResponse,
  unsubscribePreviewsResponse,
  stopPreviewResponse,
  getForwardPortsResponse,
  subscribeForwardPortsResponse,
  unsubscribeForwardPortsResponse,
]);

export type Response = z.infer<typeof response>;

/** All frames a client may send to the daemon over the authenticated iroh
 *  stream. `hello` is the only frame the daemon accepts before the
 *  wire-version handshake completes (see helloCommand). */
export const clientFrame = z.discriminatedUnion("type", [
  helloCommand,
  pingFrame,
  ...command.options,
]);

export type ClientFrame = z.infer<typeof clientFrame>;

/** All frames the daemon may send to a client. `server_info` is the
 *  daemon's reply to `hello` and the signal that the client may begin
 *  sending commands. */
export const daemonFrame = z.discriminatedUnion("type", [
  serverInfoEvent,
  pongFrame,
  errorFrame,
  gitStatusEvent,
  previewsEvent,
  forwardPortsEvent,
  ...response.options,
]);

export type DaemonFrame = z.infer<typeof daemonFrame>;
