import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Markdown } from "@astryxdesign/core/Markdown";
import { Text } from "@astryxdesign/core/Text";

// Offline transcript replay for the Claude sessions of this project dir.
// List = /api/claude-sessions (SDK listSessions — only sessions whose JSONL
// still exists; Claude Code GC's 30-day-old transcripts, so an empty list is
// the honest state). Body = /api/transcript rows (server-side normalize).
//
// Virtualization follows TanStack Virtual's chat guide verbatim: normal
// top-to-bottom order (NO column-reverse — WKWebView reading-position trap),
// `anchorTo: 'end'` for prepend/growth stability (WebKit has no native
// overflow-anchor), stable uuid keys, measureElement for dynamic heights,
// scrollToEnd() once content lands. followOnAppend stays off — this is
// static replay; it turns on when live streaming arrives with the daemon.

interface ClaudeSessionRow {
  id: string;
  title: string;
  lastModified: number;
  sizeBytes: number;
}

interface TranscriptRow {
  uuid: string;
  kind: "user" | "assistant" | "tool";
  text?: string;
  tool?: { name: string; summary: string };
  timestamp?: string;
}

export function TranscriptPanel({
  active,
  dir,
}: {
  active: boolean;
  dir: string;
}) {
  const [sessions, setSessions] = useState<ClaudeSessionRow[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [rows, setRows] = useState<TranscriptRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const parentRef = useRef<HTMLDivElement>(null);

  // Load the session list on first activation (once per dir).
  useEffect(() => {
    if (!active || sessions !== null) return;
    void (async () => {
      try {
        const res = await fetch(
          `/api/claude-sessions?dir=${encodeURIComponent(dir)}`,
        );
        if (!res.ok) throw new Error(await res.text());
        const list = (await res.json()) as ClaudeSessionRow[];
        setSessions(list);
        if (list.length > 0) setSelected(list[0].id);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [active, dir, sessions]);

  // Load the transcript whenever the selected session changes.
  useEffect(() => {
    if (!selected) return;
    setRows(null);
    void (async () => {
      try {
        const res = await fetch(
          `/api/transcript?session=${selected}&dir=${encodeURIComponent(dir)}`,
        );
        if (!res.ok) throw new Error(await res.text());
        setRows((await res.json()) as TranscriptRow[]);
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [selected, dir]);

  const count = rows?.length ?? 0;
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => parentRef.current,
    // Per-kind estimates: tool one-liners are ~28px while markdown rows run
    // hundreds. A flat estimate makes backward scroll jump on every
    // measurement correction (the "scroll-up jitter"); closer estimates
    // shrink the corrections. Text estimate scales roughly with content
    // length, capped — cheap and good enough for unmeasured items.
    estimateSize: (index) => {
      const row = rows![index];
      if (row.kind === "tool") return 28;
      const len = row.text?.length ?? 0;
      return Math.min(60 + Math.ceil(len / 90) * 24, 800);
    },
    getItemKey: (index) => rows![index].uuid,
    anchorTo: "end",
    overscan: 6,
  });

  // Start at the latest message once rows land (chat-guide pattern).
  useLayoutEffect(() => {
    if (count > 0) virtualizer.scrollToEnd();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire per content load
  }, [count > 0, selected]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-3 border-b px-3 py-1.5">
        {sessions === null ? (
          <Text size="sm">Loading…</Text>
        ) : sessions.length === 0 ? (
          <Text size="sm" color="secondary">
            No Claude sessions found for this project (transcripts older than
            30 days are cleaned up by Claude Code).
          </Text>
        ) : (
          <>
            <select
              className="min-w-0 max-w-[32rem] flex-1 truncate rounded-md border px-2 py-1 text-sm"
              value={selected ?? ""}
              onChange={(e) => setSelected(e.target.value)}
            >
              {sessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {new Date(s.lastModified).toLocaleDateString()} ·{" "}
                  {s.title || s.id.slice(0, 8)}
                </option>
              ))}
            </select>
            <Text size="sm" color="secondary">
              {rows === null ? "…" : `${rows.length} messages`}
            </Text>
          </>
        )}
      </div>

      {error ? (
        <div className="p-3">
          <Text size="sm" className="text-red-600">
            {error}
          </Text>
        </div>
      ) : (
        <div ref={parentRef} className="min-h-0 flex-1 overflow-auto">
          <div
            style={{
              height: virtualizer.getTotalSize(),
              position: "relative",
              width: "100%",
            }}
          >
            {virtualizer.getVirtualItems().map((item) => {
              const row = rows![item.index];
              return (
                <div
                  key={item.key}
                  ref={virtualizer.measureElement}
                  data-index={item.index}
                  style={{
                    position: "absolute",
                    transform: `translateY(${item.start}px)`,
                    width: "100%",
                  }}
                >
                  <TranscriptRowView row={row} />
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function TranscriptRowView({ row }: { row: TranscriptRow }) {
  if (row.kind === "tool") {
    return (
      <div className="flex items-baseline gap-2 px-4 py-1 font-mono text-xs opacity-70">
        <span className="shrink-0 select-none">●</span>
        <span className="shrink-0 font-semibold">{row.tool!.name}</span>
        <span className="truncate">{row.tool!.summary}</span>
      </div>
    );
  }
  return (
    <div
      className={`px-4 py-2 ${
        row.kind === "user" ? "bg-black/[0.04]" : ""
      }`}
    >
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide opacity-50">
        {row.kind}
      </div>
      <Markdown>{row.text ?? ""}</Markdown>
    </div>
  );
}
