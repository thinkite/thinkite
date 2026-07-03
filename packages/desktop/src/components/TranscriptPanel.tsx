import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Markdown } from "@astryxdesign/core/Markdown";
import { Text } from "@astryxdesign/core/Text";

// Offline transcript replay for ONE Claude session — the daemon record's
// cliSessionId keys the JSONL directly (/api/transcript, SDK
// getSessionMessages), no listSessions enumeration. A 404 means the JSONL was
// GC'd (Claude Code cleans transcripts after ~30 days) or the session ran on
// another machine — rendered as a notice, not an error.
//
// Virtualization follows TanStack Virtual's chat guide verbatim: normal
// top-to-bottom order (NO column-reverse — WKWebView reading-position trap),
// `anchorTo: 'end'` for prepend/growth stability (WebKit has no native
// overflow-anchor), stable uuid keys, measureElement for dynamic heights,
// scrollToEnd() once content lands. followOnAppend stays off — this is
// static replay; it turns on when live streaming arrives with the daemon.

interface TranscriptRow {
  uuid: string;
  kind: "user" | "assistant" | "tool";
  text?: string;
  tool?: { name: string; summary: string };
  timestamp?: string;
}

export function TranscriptPanel({
  dir,
  claudeSessionId,
}: {
  dir: string;
  claudeSessionId: string;
}) {
  const [rows, setRows] = useState<TranscriptRow[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const parentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setRows(null);
    setNotice(null);
    void (async () => {
      try {
        const res = await fetch(
          `/api/transcript?session=${claudeSessionId}&dir=${encodeURIComponent(dir)}`,
        );
        if (res.status === 404) {
          setRows([]);
          setNotice(
            "No transcript on this machine — it may have been cleaned up (30-day GC) or created on another device.",
          );
          return;
        }
        if (!res.ok) throw new Error(await res.text());
        setRows((await res.json()) as TranscriptRow[]);
      } catch (e) {
        setRows([]);
        setNotice(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [claudeSessionId, dir]);

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
  }, [count > 0, claudeSessionId]);

  if (rows === null) {
    return (
      <div className="p-4">
        <Text size="sm" color="secondary">
          Loading transcript…
        </Text>
      </div>
    );
  }

  if (notice || rows.length === 0) {
    // The SDK returns [] for a missing JSONL rather than throwing, so empty
    // and absent are indistinguishable — and a real session always has at
    // least its first prompt, so treat both as "not on this machine".
    return (
      <div className="p-4">
        <Text size="sm" color="secondary">
          {notice ??
            "No transcript on this machine — it may have been cleaned up (30-day GC) or created on another device."}
        </Text>
      </div>
    );
  }

  return (
    <div ref={parentRef} className="h-full min-h-0 overflow-auto">
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
