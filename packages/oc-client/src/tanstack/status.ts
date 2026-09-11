// Busy/idle for the OPEN session comes from its durable stream (the
// transcript collection replays with `after=`, so it never misses a
// `step.ended`), while the sessions collection's rows get busy/idle from
// the shared bus, which the server closes after idle turns and which can
// drop a boundary on reconnect (observed: composer stuck on "opencode is
// working…" after a completed turn). The transcript publishes here; the
// sessions collection registers as the sink so the durable reading wins
// for that row.
//
// A registry instead of a direct import keeps the module graph acyclic:
// sessions.ts and transcript.ts never import each other.

export type SessionStatus = "busy" | "idle";
type Sink = (sessionId: string, status: SessionStatus) => void;

let sink: Sink | null = null;

export function registerSessionStatusSink(fn: Sink): () => void {
  sink = fn;
  return () => {
    if (sink === fn) sink = null;
  };
}

export function publishSessionStatus(
  sessionId: string,
  status: SessionStatus,
): void {
  sink?.(sessionId, status);
}
