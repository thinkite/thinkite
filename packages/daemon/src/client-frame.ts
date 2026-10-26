// What a paired client may send, checked before any handler sees it. The
// frame types live in @thinkite/protocol as plain TypeScript; this is the
// one place they are validated, so only the daemon carries a schema
// library. The `Same` check below fails the build if the two drift.

import type { ClientFrame } from "@thinkite/protocol";
import * as v from "valibot";

const request = { requestId: v.string() };
const inCwd = { ...request, cwd: v.string() };
const inDirectory = { ...request, directory: v.string() };

const clientFrame = v.variant("type", [
  v.object({ type: v.literal("hello"), protocolVersion: v.string() }),
  v.object({ type: v.literal("ping"), t: v.number() }),
  v.object({ type: v.literal("subscribeGitStatus"), ...inCwd }),
  v.object({ type: v.literal("unsubscribeGitStatus"), ...inCwd }),
  v.object({
    type: v.literal("listDirectory"),
    ...request,
    path: v.string(),
    includeFiles: v.optional(v.boolean()),
    includeHidden: v.optional(v.boolean()),
  }),
  v.object({ type: v.literal("getFilesystemRoots"), ...request }),
  v.object({ type: v.literal("getPreviews"), ...inDirectory }),
  v.object({ type: v.literal("subscribePreviews"), ...inDirectory }),
  v.object({ type: v.literal("unsubscribePreviews"), ...inDirectory }),
  v.object({
    type: v.literal("stopPreview"),
    ...inDirectory,
    name: v.string(),
  }),
  v.object({ type: v.literal("getForwardPorts"), ...request }),
  v.object({ type: v.literal("subscribeForwardPorts"), ...request }),
  v.object({ type: v.literal("unsubscribeForwardPorts"), ...request }),
]);

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
true satisfies Same<v.InferOutput<typeof clientFrame>, ClientFrame>;

/** A client frame, or a thrown error naming what is wrong with it. */
export function parseClientFrame(value: unknown): ClientFrame {
  return v.parse(clientFrame, value);
}
