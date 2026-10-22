import { Button } from "@astryxdesign/core/Button";
import { Text } from "@astryxdesign/core/Text";
import { parsePatchFiles } from "@pierre/diffs";
import { CodeView } from "@pierre/diffs/react";
import type { FileDiffInfo } from "@thinkite/oc-client";
import { useEffect, useMemo, useRef, useState } from "react";
import { ocClient } from "../lib/oc";

// Diff panel: opencode's `vcs.diff` for the session's folder — everything
// the branch changed since it left the default branch, uncommitted and
// untracked files included, as Claude Code's diff shows by default — one
// patch per file, parsed into Pierre's CodeView, one virtualized section
// per file, long lines wrapped.
// The multifile CodeView path is the one the iOS tool-call sheet already
// ships (pierre-view.tsx "multifile"); this is its plain-DOM sibling — no
// expo-dom marshaling, so no encodeURIComponent dance, and Vite's `?worker`
// replaces the fetch→Blob worker bootstrap.
//
// Highlighting runs on the shared worker pool provided by <PierrePool> up at
// the session screen — mounted there (not here) so the pool is already warm
// by the time this panel first shows.

function useColorScheme(): "light" | "dark" {
  const mq = useMemo(() => matchMedia("(prefers-color-scheme: dark)"), []);
  const [dark, setDark] = useState(mq.matches);
  useEffect(() => {
    const onChange = (e: MediaQueryListEvent) => setDark(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [mq]);
  return dark ? "dark" : "light";
}

export function DiffPanel({ active, dir }: { active: boolean; dir: string }) {
  const scheme = useColorScheme();
  const [files, setFiles] = useState<FileDiffInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // CodeView's scroll viewport (needs a definite height — see style below).
  const containerRef = useRef<HTMLDivElement | null>(null);

  const refresh = async () => {
    setLoading(true);
    try {
      setFiles(await ocClient.vcsDiff(dir, "branch"));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };
  // Refetch on every activation (tab switch). Stale-while-refetch: the old
  // diff stays rendered until the new one lands.
  useEffect(() => {
    if (active) void refresh();
  }, [active, dir]);

  const items = useMemo(
    () =>
      parsePatchFiles(files?.map((f) => f.patch).join("\n") ?? "").flatMap(
        (patch, pi) =>
          patch.files.map((fileDiff, fi) => ({
            id: `${pi}-${fi}`,
            type: "diff" as const,
            fileDiff,
          })),
      ),
    [files],
  );

  const count = files?.length ?? 0;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-3 border-b border-[var(--color-border)] px-3 py-1.5">
        <Text size="sm" color="secondary">
          {error
            ? `Diff failed: ${error}`
            : files === null
              ? "Loading…"
              : count === 0
                ? "No changes"
                : `${count} file${count === 1 ? "" : "s"} changed`}
        </Text>
        <div className="ml-auto">
          <Button
            label="Refresh"
            size="sm"
            variant="secondary"
            isLoading={loading}
            onClick={() => void refresh()}
          />
        </div>
      </div>
      <CodeView
        items={items}
        containerRef={containerRef}
        // CodeView virtualizes against this element's own height — it must
        // be definite (flex-1 + min-h-0 in a bounded column) and be the
        // scroll container, or it windows nothing (iOS lesson).
        style={{ flex: 1, minHeight: 0, overflow: "auto" }}
        options={{
          theme: scheme === "dark" ? "pierre-dark" : "pierre-light",
          diffStyle: "unified",
          overflow: "wrap",
          lineDiffType: "word",
          stickyHeaders: true,
          // Matches PierrePool's engine (see the rationale there); this one
          // covers what highlights on the main thread.
          preferredHighlighter: "highlights",
        }}
      />
    </div>
  );
}
