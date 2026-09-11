/**
 * Pure transcript reducer over opencode v2 events.
 *
 * Input: durable `session.next.*` events (history pages + the per-session
 * `after=` stream) and live bus events (`session.next.*.delta`,
 * `session.status`, `permission.v2.*`, `question.v2.*`). Output: an ordered
 * row model the transcript UI renders directly — no Thinkite protocol
 * shapes involved (the desktop stops importing those for sessions; the iOS
 * app still uses them until stage 3, which is why they stay in
 * `packages/protocol` untouched).
 *
 * Reduction logic ported from the official GUI's
 * `server-session-v2-reducer.ts` + `global-sync/event-reducer.ts`
 * (SolidJS store mechanics dropped; the merge semantics kept), with row
 * shapes redesigned for the existing virtualized transcript (kind dispatch
 * + `_order`, same as before).
 *
 * Merge rules:
 * - Durable events dedupe by `durable.seq` (out-of-order and duplicate
 *   delivery both converge); live deltas carry no seq and apply by key.
 * - Live deltas apply by `textID` / `reasoningID` / `callID`; the durable
 *   `*.ended` event carrying the full content is authoritative and
 *   overwrites whatever the deltas accumulated (missed-delta reconcile).
 *   Once an `*.ended` has finalized a row, later deltas for that row are
 *   stale redeliveries (the bus replays its bounded buffer to every new
 *   subscriber — observed live) and are dropped.
 * - Turn state is event-driven, never polled (`ocStatusTransition`): busy
 *   on prompt admission / step start, idle on terminal step end
 *   (`finish: "tool-calls"` continues into the next step — one prompt
 *   drives N steps) or step failure, with `session.status` as an
 *   authoritative override when the server emits it. NOTE: the v2 engine
 *   in 1.18.30 never publishes `session.status` for prompt turns (only
 *   the legacy paths do — verified live and in
 *   `core/src/session/*`, which has no status publish); the step rules
 *   below are what actually drives busy/idle. `session.wait` is 503 and
 *   `session.idle` is deprecated (still mapped).
 * - Usage is the terminal `step.ended`'s tokens (last one wins).
 */

export type OcToolStatus = "running" | "completed" | "error";

/** Per-tool typed detail for the tools the transcript renders. Unknown
 *  tools keep their opencode name + raw input (never dropped). */
export type OcToolDetail =
  | { tool: "bash"; command: string }
  | { tool: "edit"; path: string; oldString?: string; newString?: string }
  | { tool: "read"; path: string; offset?: number; limit?: number }
  | { tool: "write"; path: string; content?: string }
  | { tool: "glob"; pattern: string; path?: string }
  | { tool: "grep"; pattern: string; path?: string }
  | { tool: "webfetch"; url: string }
  | { tool: "websearch"; query: string }
  | {
      tool: "task";
      description: string;
      prompt?: string;
      subagent?: string;
    }
  | {
      tool: "question";
      questions: Array<{
        question: string;
        header: string;
        multiSelect: boolean;
        options: Array<{ label: string; description: string }>;
      }>;
    }
  | { tool: "unknown"; name: string; input: Record<string, unknown> };

export type OcRow =
  | { kind: "user"; id: string; text: string }
  | {
      kind: "text";
      id: string;
      text: string;
      streaming: boolean;
      assistantMessageID: string;
    }
  | {
      kind: "reasoning";
      id: string;
      text: string;
      streaming: boolean;
      assistantMessageID: string;
    }
  | {
      kind: "tool";
      id: string;
      name: string;
      status: OcToolStatus;
      /** Raw input JSON text while streaming; replaced by the parsed
       *  detail once `tool.called` lands. */
      input: string;
      detail: OcToolDetail;
      summary: string;
      output: string;
      error: string | null;
    }
  | {
      kind: "compaction";
      id: string;
      reason: "auto" | "manual";
      summary: string;
      streaming: boolean;
    }
  | { kind: "step-failed"; id: string; error: string }
  | {
      kind: "revert";
      id: string;
      state: "staged" | "cleared" | "committed";
      messageID?: string;
    };

export interface OcUsage {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  cost?: number;
}

export interface OcPermissionRequest {
  id: string;
  action: string;
  resources: string[];
}

export interface OcQuestionRequest {
  id: string;
  questions: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description: string }>;
  }>;
}

export interface OcTranscriptState {
  rows: OcRow[];
  status: "busy" | "idle";
  permissions: OcPermissionRequest[];
  questions: OcQuestionRequest[];
  usage?: OcUsage;
  /** Highest durable seq consumed (informational; dedupe uses `seenSeq`). */
  lastSeq: number;
  seenSeq: Set<number>;
}

export function createInitialTranscriptState(): OcTranscriptState {
  return {
    rows: [],
    status: "idle",
    permissions: [],
    questions: [],
    lastSeq: 0,
    seenSeq: new Set(),
  };
}

/** Minimal envelope both the durable stream and the `/api/event` bus
 *  satisfy (`{id, type, data, durable?, location?}`). SDK event objects
 *  are structurally assignable (`data` is `unknown` here on purpose). */
export interface OcEventLike {
  readonly id?: string;
  readonly type: string;
  readonly data?: unknown;
  readonly durable?: { readonly seq?: unknown } | null;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

function record(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null
    ? (v as Record<string, unknown>)
    : {};
}

// ─── Tool detail table ─────────────────────────────────────────────
// Field names verified against the opencode tool sources + live logs
// (stage-1 report): the model emits `path` in practice where the docs say
// `filePath`; both accepted. `grep` has no `output_mode` (pinned to the
// content listing it produces); `webfetch` has no `prompt`; `task` has no
// per-spawn `model`.

export function buildOcToolDetail(
  tool: string,
  rawInput: unknown,
): OcToolDetail {
  const input = record(rawInput);
  switch (tool) {
    case "bash":
      return { tool, command: str(input.command) ?? "" };
    case "edit":
      return {
        tool,
        path: str(input.filePath ?? input.path) ?? "",
        ...(str(input.oldString) !== undefined
          ? { oldString: input.oldString as string }
          : {}),
        ...(str(input.newString) !== undefined
          ? { newString: input.newString as string }
          : {}),
      };
    case "read": {
      const detail: Extract<OcToolDetail, { tool: "read" }> = {
        tool,
        path: str(input.filePath ?? input.path) ?? "",
      };
      if (num(input.offset) !== undefined)
        detail.offset = input.offset as number;
      if (num(input.limit) !== undefined) detail.limit = input.limit as number;
      return detail;
    }
    case "write":
      return {
        tool,
        path: str(input.filePath ?? input.path) ?? "",
        ...(str(input.content) !== undefined
          ? { content: input.content as string }
          : {}),
      };
    case "glob":
      return {
        tool,
        pattern: str(input.pattern) ?? "",
        ...(str(input.path) !== undefined
          ? { path: input.path as string }
          : {}),
      };
    case "grep":
      return {
        tool,
        pattern: str(input.pattern) ?? "",
        ...(str(input.path) !== undefined
          ? { path: input.path as string }
          : {}),
      };
    case "webfetch":
      return { tool, url: str(input.url) ?? "" };
    case "websearch":
      return { tool, query: str(input.query) ?? "" };
    case "task":
      return {
        tool,
        description: str(input.description) ?? "",
        ...(str(input.prompt) !== undefined
          ? { prompt: input.prompt as string }
          : {}),
        ...(str(input.subagent_type) !== undefined
          ? { subagent: input.subagent_type as string }
          : {}),
      };
    case "question": {
      const questions = Array.isArray(input.questions)
        ? input.questions.map((q) => {
            const r = record(q);
            return {
              question: str(r.question) ?? "",
              header: str(r.header) ?? "",
              multiSelect: r.multiple === true,
              options: Array.isArray(r.options)
                ? r.options.map((o) => {
                    const or = record(o);
                    return {
                      label: str(or.label) ?? "",
                      description: str(or.description) ?? "",
                    };
                  })
                : [],
            };
          })
        : [];
      return { tool, questions };
    }
    default:
      return { tool: "unknown", name: tool, input };
  }
}

/** One-line target for the collapsed tool row (the transcript groups
 *  consecutive tool rows; only name/target/status surface there). */
export function summaryForOcTool(detail: OcToolDetail): string {
  switch (detail.tool) {
    case "bash":
      return detail.command.split("\n")[0]?.slice(0, 80) ?? "";
    case "edit":
    case "read":
    case "write":
      return detail.path;
    case "glob":
      return detail.pattern;
    case "grep":
      return detail.pattern;
    case "webfetch":
      return detail.url;
    case "websearch":
      return detail.query;
    case "task":
      return detail.description;
    case "question":
      return `${detail.questions.length} question${detail.questions.length === 1 ? "" : "s"}`;
    case "unknown":
      return detail.name;
  }
}

/** Display text out of a `tool.success` / `tool.failed` body: `content[]`
 *  text parts joined; `read` reports an empty `content[]` with the file
 *  text in `structured.content` instead (fallback); failures carry
 *  `error: {type, message}`. */
export function ocToolOutputText(data: Record<string, unknown>): string {
  if (Array.isArray(data.content)) {
    const texts: string[] = [];
    for (const part of data.content) {
      const text = str(record(part).text);
      // File parts (`{type:"file",...}`) carry no text — skipped.
      if (record(part).type === "text" && text !== undefined) texts.push(text);
    }
    if (texts.length > 0) return texts.join("");
    const structured = str(record(data.structured).content);
    return structured ?? "";
  }
  const message = str(record(data.error).message);
  if (message !== undefined) return message;
  const value = record(data.result).value;
  return typeof value === "string" ? value : "";
}

function ocUsageFromStep(data: Record<string, unknown>): OcUsage | undefined {
  const tokens = record(data.tokens);
  if (Object.keys(tokens).length === 0 && num(data.cost) === undefined) {
    return undefined;
  }
  const cache = record(tokens.cache);
  const usage: OcUsage = {};
  const input = num(tokens.input);
  const output = num(tokens.output);
  const reasoning = num(tokens.reasoning);
  const read = num(cache.read);
  const write = num(cache.write);
  const cost = num(data.cost);
  if (input !== undefined) usage.inputTokens = input;
  if (output !== undefined) usage.outputTokens = output;
  if (reasoning !== undefined) usage.reasoningTokens = reasoning;
  if (read !== undefined) usage.cacheReadInputTokens = read;
  if (write !== undefined) usage.cacheCreationInputTokens = write;
  if (cost !== undefined) usage.cost = cost;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

function textRowId(assistantMessageID: string, textID: string): string {
  return `${assistantMessageID}:${textID}`;
}

function reasoningRowId(
  assistantMessageID: string,
  reasoningID: string,
): string {
  return `${assistantMessageID}:${reasoningID}`;
}

function findRowIndex(rows: OcRow[], id: string): number {
  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i]?.id === id) return i;
  }
  return -1;
}

/**
 * Turn-state transition for one event (`"busy"` / `"idle"` / no opinion).
 * Single source of truth, shared by the transcript reducer and the
 * session-list busy dots — both consume the same bus.
 *
 * `session.status` wins when present (authoritative override, plus
 * forward-compat if a later server publishes it for v2 turns). The
 * step-level rules carry 1.18.30, where the v2 engine
 * (`core/src/session/*`) publishes no status at all:
 * - busy on prompt admission (the server WILL run the turn — steer or
 *   queued) and on every step start (idempotent);
 * - a step ending with `finish: "tool-calls"` continues into the next
 *   step (no opinion — stay busy); any other finish ends the turn
 *   (`needsContinuation` is set only on tool-call —
 *   `core/src/session/runner/llm.ts`), as does any step failure.
 */
export function ocStatusTransition(event: {
  type: string;
  data?: unknown;
}): "busy" | "idle" | null {
  const data = record(event.data);
  switch (event.type) {
    case "session.next.prompt.admitted":
    case "session.next.prompted":
    case "session.next.step.started":
      return "busy";
    case "session.next.step.ended":
      return str(data.finish) === "tool-calls" ? null : "idle";
    case "session.next.step.failed":
      return "idle";
    case "session.status": {
      const next = str(record(data.status).type);
      if (next === "busy" || next === "retry") return "busy";
      if (next === "idle") return "idle";
      return null;
    }
    case "session.idle":
      // Deprecated in this opencode version, still mapped so an older
      // server never wedges the composer in `busy`.
      return "idle";
    default:
      return null;
  }
}

/**
 * Fold one event into the transcript state. Returns the input state
 * untouched when the event carries nothing renderable (durable duplicate,
 * empty text, unrelated bus event) — cheap `===` check for subscribers.
 */
export function applyOcEvent(
  state: OcTranscriptState,
  event: OcEventLike,
): OcTranscriptState {
  const data = record(event.data);
  const type = event.type;

  // Durable dedupe: each durable event carries its own aggregate seq, so
  // skipping a seen seq can only drop an exact duplicate.
  const seq = num(event.durable?.seq);
  let seenSeq = state.seenSeq;
  let lastSeq = state.lastSeq;
  if (seq !== undefined) {
    if (seenSeq.has(seq)) return state;
    seenSeq = new Set(seenSeq);
    seenSeq.add(seq);
    if (seq > lastSeq) lastSeq = seq;
  }

  // Shallow-copy helper: rows/permissions/questions clone on first write.
  let rows: OcRow[] | null = null;
  let permissions: OcPermissionRequest[] | null = null;
  let questions: OcQuestionRequest[] | null = null;
  let status: OcTranscriptState["status"] | null = null;
  let usage: OcUsage | undefined;
  let usageSet = false;

  const transition = ocStatusTransition({ type, data });
  if (transition !== null) status = transition;

  const rowsMut = (): OcRow[] => {
    if (rows === null) {
      rows = state.rows.slice();
    }
    return rows;
  };
  const upsertRow = (row: OcRow): void => {
    const mut = rowsMut();
    const idx = findRowIndex(mut, row.id);
    if (idx >= 0) mut[idx] = row;
    else mut.push(row);
  };
  const patchRow = (id: string, patch: (row: OcRow) => OcRow): boolean => {
    const mut = rowsMut();
    const idx = findRowIndex(mut, id);
    if (idx < 0) return false;
    const current = mut[idx];
    if (current === undefined) return false;
    mut[idx] = patch(current);
    return true;
  };

  switch (type) {
    case "session.next.prompt.admitted":
    case "session.next.prompted": {
      const messageID = str(data.messageID);
      if (messageID === undefined) break;
      if (findRowIndex(rows ?? state.rows, messageID) >= 0) break;
      const text = str(record(data.prompt).text) ?? "";
      if (text.length === 0) break;
      upsertRow({ kind: "user", id: messageID, text });
      break;
    }

    case "session.next.text.started": {
      const assistantMessageID = str(data.assistantMessageID);
      const textID = str(data.textID);
      if (assistantMessageID === undefined || textID === undefined) break;
      const id = textRowId(assistantMessageID, textID);
      if (findRowIndex(rows ?? state.rows, id) >= 0) break;
      upsertRow({
        kind: "text",
        id,
        text: "",
        streaming: true,
        assistantMessageID,
      });
      break;
    }

    case "session.next.text.delta": {
      const assistantMessageID = str(data.assistantMessageID);
      const textID = str(data.textID);
      const delta = str(data.delta);
      if (textID === undefined || delta === undefined || delta.length === 0) {
        break;
      }
      const id = textRowId(assistantMessageID ?? "", textID);
      const existing = (rows ?? state.rows)[
        findRowIndex(rows ?? state.rows, id)
      ];
      if (existing?.kind === "text" && !existing.streaming) {
        // Stale redelivery (bus buffer replay after `ended`) — the full
        // text is already authoritative. Dropping also avoids resurrecting
        // `streaming` on a finalized row.
        break;
      }
      if (
        !patchRow(id, (row) =>
          row.kind === "text"
            ? { ...row, text: row.text + delta, streaming: true }
            : row,
        )
      ) {
        // Attached mid-text (missed `started`): self-heal the row with
        // this fragment so the text still renders; `text.ended`
        // reconciles the full content later.
        upsertRow({
          kind: "text",
          id,
          text: delta,
          streaming: true,
          assistantMessageID: assistantMessageID ?? "",
        });
      }
      break;
    }

    case "session.next.text.ended": {
      const assistantMessageID = str(data.assistantMessageID);
      const textID = str(data.textID);
      const text = str(data.text);
      if (assistantMessageID === undefined || textID === undefined) break;
      if (text === undefined) break;
      const id = textRowId(assistantMessageID, textID);
      const row: OcRow = {
        kind: "text",
        id,
        text,
        streaming: false,
        assistantMessageID,
      };
      // Authoritative: full content overwrites any delta accumulation
      // (missed deltas while detached converge here). Empty final text
      // still finalizes a streaming row; without any row it renders
      // nothing, so skip creating one.
      if (text.length === 0) {
        patchRow(id, (current) =>
          current.kind === "text" ? { ...current, streaming: false } : current,
        );
      } else {
        upsertRow(row);
      }
      break;
    }

    case "session.next.reasoning.started": {
      const assistantMessageID = str(data.assistantMessageID);
      const reasoningID = str(data.reasoningID);
      if (assistantMessageID === undefined || reasoningID === undefined) break;
      const id = reasoningRowId(assistantMessageID, reasoningID);
      if (findRowIndex(rows ?? state.rows, id) >= 0) break;
      upsertRow({
        kind: "reasoning",
        id,
        text: "",
        streaming: true,
        assistantMessageID,
      });
      break;
    }

    case "session.next.reasoning.delta": {
      const assistantMessageID = str(data.assistantMessageID);
      const reasoningID = str(data.reasoningID);
      const delta = str(data.delta);
      if (
        reasoningID === undefined ||
        delta === undefined ||
        delta.length === 0
      ) {
        break;
      }
      const id = reasoningRowId(assistantMessageID ?? "", reasoningID);
      const existing = (rows ?? state.rows)[
        findRowIndex(rows ?? state.rows, id)
      ];
      // Stale redelivery after `ended` (see text.delta).
      if (existing?.kind === "reasoning" && !existing.streaming) break;
      if (
        !patchRow(id, (row) =>
          row.kind === "reasoning"
            ? { ...row, text: row.text + delta, streaming: true }
            : row,
        )
      ) {
        upsertRow({
          kind: "reasoning",
          id,
          text: delta,
          streaming: true,
          assistantMessageID: assistantMessageID ?? "",
        });
      }
      break;
    }

    case "session.next.reasoning.ended": {
      const assistantMessageID = str(data.assistantMessageID);
      const reasoningID = str(data.reasoningID);
      const text = str(data.text);
      if (assistantMessageID === undefined || reasoningID === undefined) break;
      if (text === undefined) break;
      const id = reasoningRowId(assistantMessageID, reasoningID);
      if (text.length === 0) {
        patchRow(id, (current) =>
          current.kind === "reasoning"
            ? { ...current, streaming: false }
            : current,
        );
      } else {
        upsertRow({
          kind: "reasoning",
          id,
          text,
          streaming: false,
          assistantMessageID,
        });
      }
      break;
    }

    case "session.next.tool.input.started": {
      const callID = str(data.callID);
      if (callID === undefined) break;
      if (findRowIndex(rows ?? state.rows, callID) >= 0) break;
      const name = str(data.name) ?? "unknown";
      const detail = buildOcToolDetail(name, {});
      upsertRow({
        kind: "tool",
        id: callID,
        name,
        status: "running",
        input: "",
        detail,
        summary: summaryForOcTool(detail),
        output: "",
        error: null,
      });
      break;
    }

    case "session.next.tool.input.delta": {
      const callID = str(data.callID);
      const delta = str(data.delta);
      if (callID === undefined || delta === undefined || delta.length === 0) {
        break;
      }
      // Results are terminal for the input (`called` carries the parsed
      // object, success/failed settle the row) — later deltas are stale
      // redeliveries, and a missing row means missed `input.started`
      // (the `input.ended`/`called` heal below).
      const existing = (rows ?? state.rows)[
        findRowIndex(rows ?? state.rows, callID)
      ];
      if (existing?.kind !== "tool" || existing.status !== "running") break;
      patchRow(callID, (row) =>
        row.kind === "tool" ? { ...row, input: row.input + delta } : row,
      );
      break;
    }

    case "session.next.tool.input.ended": {
      const callID = str(data.callID);
      const text = str(data.text);
      if (callID === undefined || text === undefined) break;
      if (
        !patchRow(callID, (row) =>
          row.kind === "tool" ? { ...row, input: text } : row,
        )
      ) {
        // Missed `input.started` (attached mid-turn): heal a running row;
        // `tool.called` fills in the name + detail.
        upsertRow({
          kind: "tool",
          id: callID,
          name: "unknown",
          status: "running",
          input: text,
          detail: { tool: "unknown", name: "unknown", input: {} },
          summary: "unknown",
          output: "",
          error: null,
        });
      }
      break;
    }

    case "session.next.tool.called": {
      const callID = str(data.callID);
      if (callID === undefined) break;
      const tool = str(data.tool) ?? "unknown";
      // `input.ended` carries the full input as JSON text; `called`
      // carries it parsed. Prefer the parsed object, fall back to the
      // streamed text when the row already has it.
      let parsed: Record<string, unknown> | null = null;
      if (typeof data.input === "object" && data.input !== null) {
        parsed = data.input as Record<string, unknown>;
      }
      const existing = (rows ?? state.rows)[
        findRowIndex(rows ?? state.rows, callID)
      ];
      if (parsed === null && existing?.kind === "tool" && existing.input) {
        try {
          parsed = JSON.parse(existing.input) as Record<string, unknown>;
        } catch {
          parsed = null;
        }
      }
      const detail = buildOcToolDetail(tool, parsed ?? {});
      const row: OcRow = {
        kind: "tool",
        id: callID,
        name: tool,
        status: "running",
        input:
          parsed !== null
            ? JSON.stringify(parsed)
            : existing?.kind === "tool"
              ? existing.input
              : "",
        detail,
        summary: summaryForOcTool(detail),
        output: "",
        error: null,
      };
      upsertRow(row);
      break;
    }

    case "session.next.tool.success":
    case "session.next.tool.failed": {
      const callID = str(data.callID);
      if (callID === undefined) break;
      const outputText = ocToolOutputText(data);
      const failed = type === "session.next.tool.failed";
      if (
        !patchRow(callID, (row) => {
          if (row.kind !== "tool") return row;
          const detail = { ...row.detail };
          attachOcOutputToDetail(detail, outputText);
          return {
            ...row,
            status: failed ? "error" : "completed",
            detail,
            summary: summaryForOcTool(detail),
            output: outputText,
            error: failed ? outputText : null,
          };
        })
      ) {
        // Orphan result (missed `called`): heal a settled row so the
        // output is not lost.
        const detail = buildOcToolDetail("unknown", {});
        attachOcOutputToDetail(detail, outputText);
        upsertRow({
          kind: "tool",
          id: callID,
          name: "unknown",
          status: failed ? "error" : "completed",
          input: "",
          detail,
          summary: summaryForOcTool(detail),
          output: outputText,
          error: failed ? outputText : null,
        });
      }
      break;
    }

    case "session.next.step.ended": {
      // Terminal usage wins; a token-less step leaves the previous reading.
      // (Busy/idle comes from `ocStatusTransition` above, not here.)
      const u = ocUsageFromStep(data);
      if (u !== undefined) {
        usage = u;
        usageSet = true;
      }
      break;
    }

    case "session.next.step.failed": {
      const message = str(record(data.error).message) ?? "opencode step failed";
      upsertRow({
        kind: "step-failed",
        id: str(event.id) ?? `step-failed-${seq ?? Date.now()}`,
        error: message,
      });
      break;
    }

    case "session.next.compaction.started": {
      const id =
        str(data.inputID) ??
        str(data.messageID) ??
        str(event.id) ??
        "compaction";
      if (findRowIndex(rows ?? state.rows, id) >= 0) break;
      upsertRow({
        kind: "compaction",
        id,
        reason: data.reason === "auto" ? "auto" : "manual",
        summary: "",
        streaming: true,
      });
      break;
    }

    case "session.next.compaction.delta": {
      // Live-only delta (not in the durable union): appends to the running
      // compaction summary. Dropped once `ended` finalized the row (bus
      // buffer replay — see text.delta).
      const text = str(data.text);
      if (text === undefined || text.length === 0) break;
      const id = str(data.inputID) ?? str(data.messageID) ?? "compaction";
      const existing = (rows ?? state.rows)[
        findRowIndex(rows ?? state.rows, id)
      ];
      if (existing?.kind === "compaction" && !existing.streaming) break;
      if (
        !patchRow(id, (row) =>
          row.kind === "compaction"
            ? { ...row, summary: row.summary + text }
            : row,
        )
      ) {
        upsertRow({
          kind: "compaction",
          id,
          reason: data.reason === "auto" ? "auto" : "manual",
          summary: text,
          streaming: true,
        });
      }
      break;
    }

    case "session.next.compaction.ended": {
      const messageID = str(data.messageID);
      if (messageID === undefined) break;
      // Authoritative full summary, like `text.ended`.
      upsertRow({
        kind: "compaction",
        id: messageID,
        reason: data.reason === "auto" ? "auto" : "manual",
        summary: str(data.text) ?? "",
        streaming: false,
      });
      break;
    }

    case "session.next.revert.staged":
    case "session.next.revert.cleared":
    case "session.next.revert.committed": {
      // Single revert slot per session: a later boundary replaces the
      // earlier marker in place (staged → committed/cleared).
      const nextState =
        type === "session.next.revert.staged"
          ? "staged"
          : type === "session.next.revert.cleared"
            ? "cleared"
            : "committed";
      const row: OcRow = {
        kind: "revert",
        id: "revert",
        state: nextState,
        ...(str(data.messageID) !== undefined
          ? { messageID: data.messageID as string }
          : {}),
      };
      upsertRow(row);
      break;
    }

    case "permission.v2.asked": {
      const id = str(data.id);
      if (id === undefined) break;
      const request: OcPermissionRequest = {
        id,
        action: str(data.action) ?? "",
        resources: Array.isArray(data.resources)
          ? data.resources.filter((r): r is string => typeof r === "string")
          : [],
      };
      permissions = (permissions ?? state.permissions).slice();
      const idx = permissions.findIndex((p) => p.id === id);
      if (idx >= 0) permissions[idx] = request;
      else permissions.push(request);
      break;
    }

    case "permission.v2.replied": {
      const requestID = str(data.requestID);
      if (requestID === undefined) break;
      if (!state.permissions.some((p) => p.id === requestID)) break;
      permissions = state.permissions.filter((p) => p.id !== requestID);
      break;
    }

    case "question.v2.asked": {
      const id = str(data.id);
      if (id === undefined) break;
      const request: OcQuestionRequest = {
        id,
        questions: Array.isArray(data.questions)
          ? data.questions.map((q) => {
              const r = record(q);
              return {
                question: str(r.question) ?? "",
                header: str(r.header) ?? "",
                options: Array.isArray(r.options)
                  ? r.options.map((o) => {
                      const or = record(o);
                      return {
                        label: str(or.label) ?? "",
                        description: str(or.description) ?? "",
                      };
                    })
                  : [],
              };
            })
          : [],
      };
      questions = (questions ?? state.questions).slice();
      const idx = questions.findIndex((q) => q.id === id);
      if (idx >= 0) questions[idx] = request;
      else questions.push(request);
      break;
    }

    case "question.v2.replied":
    case "question.v2.rejected": {
      const requestID = str(data.requestID);
      if (requestID === undefined) break;
      if (!state.questions.some((q) => q.id === requestID)) break;
      questions = state.questions.filter((q) => q.id !== requestID);
      break;
    }

    case "message.part.delta": {
      // Live-only message-projection delta (the official GUI's primary
      // text path). Best-effort mapping onto the assistant text row for
      // `messageID`: the durable `text.ended` stays authoritative.
      const messageID = str(data.messageID);
      const partID = str(data.partID);
      const delta = str(data.delta);
      if (messageID === undefined || partID === undefined) break;
      if (delta === undefined || delta.length === 0) break;
      const id = `${messageID}:${partID}`;
      const existing = (rows ?? state.rows)[
        findRowIndex(rows ?? state.rows, id)
      ];
      // Stale redelivery after a finalized row (see text.delta).
      if (existing?.kind === "text" && !existing.streaming) break;
      if (
        !patchRow(id, (row) =>
          row.kind === "text"
            ? { ...row, text: row.text + delta, streaming: true }
            : row,
        )
      ) {
        upsertRow({
          kind: "text",
          id,
          text: delta,
          streaming: true,
          assistantMessageID: messageID,
        });
      }
      break;
    }

    default:
      // step.started, tool.input progress, shell.*, synthetic,
      // context.updated, agent/model switched, moved, retried,
      // message.updated, session.created/updated/deleted (the session
      // list owns those) — no transcript row.
      break;
  }

  if (
    rows === null &&
    permissions === null &&
    questions === null &&
    status === null &&
    !usageSet &&
    seq === undefined
  ) {
    return state;
  }
  return {
    rows: rows ?? state.rows,
    status: status ?? state.status,
    permissions: permissions ?? state.permissions,
    questions: questions ?? state.questions,
    ...(usageSet
      ? { usage }
      : state.usage !== undefined
        ? { usage: state.usage }
        : {}),
    lastSeq,
    seenSeq,
  };
}

/** Fold an ordered event log (history page, fixture, replay) left to right. */
export function foldOcEvents(
  events: readonly OcEventLike[],
  initial: OcTranscriptState = createInitialTranscriptState(),
): OcTranscriptState {
  let state = initial;
  for (const event of events) state = applyOcEvent(state, event);
  return state;
}

// Attach display output back onto details that render it (read shows the
// file text; edit/write show the diff/result). Mirrors the daemon's
// `attachOutputToDetail` for the subset this row model keeps.
function attachOcOutputToDetail(detail: OcToolDetail, output: string): void {
  if (detail.tool === "read" || detail.tool === "write") {
    (detail as { content?: string }).content = output;
  }
}
