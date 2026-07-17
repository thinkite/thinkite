import { Button } from "@astryxdesign/core/Button";
import { Text } from "@astryxdesign/core/Text";
import { parsePatchFiles } from "@pierre/diffs";
import { CodeView } from "@pierre/diffs/react";
import { useEffect, useMemo, useRef, useState } from "react";

// Working-tree diff panel: GET /api/diff (daemon `GitDiff` shape — see
// server/diff.ts; the endpoint later swaps to the daemon's RPC, same shape)
// → parsePatchFiles → Pierre CodeView, one virtualized section per file.
// The multifile CodeView path is the one the iOS tool-call sheet already
// ships (pierre-view.tsx "multifile"); this is its plain-DOM sibling — no
// expo-dom marshaling, so no encodeURIComponent dance, and Vite's `?worker`
// replaces the fetch→Blob worker bootstrap.
//
// Highlighting runs on the shared worker pool provided by <PierrePool> up at
// the session screen — mounted there (not here) so the pool is already warm
// by the time this panel first shows.

interface GitDiff {
  isRepo: boolean;
  diff: string;
  fileCount: number;
  truncated: boolean;
}

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
  const [result, setResult] = useState<GitDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // CodeView's scroll viewport (needs a definite height — see style below).
  const containerRef = useRef<HTMLDivElement | null>(null);

  const refresh = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/diff?dir=${encodeURIComponent(dir)}`);
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      const next = (await res.json()) as GitDiff;
      setResult(next);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refresh is stable per dir
  }, [active, dir]);

  const items = useMemo(
    () =>
      result?.diff
        ? parsePatchFiles(result.diff).flatMap((patch, pi) =>
            patch.files.map((fileDiff, fi) => ({
              id: `${pi}-${fi}`,
              type: "diff" as const,
              fileDiff,
            })),
          )
        : [],
    [result?.diff],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-3 border-b px-3 py-1.5">
        <Text size="sm">
          {error
            ? `diff failed: ${error}`
            : result === null
              ? "Loading…"
              : !result.isRepo
                ? "Not a git repository"
                : result.fileCount === 0
                  ? "No changes"
                  : `${result.fileCount} file${result.fileCount === 1 ? "" : "s"} changed${
                      result.truncated ? " (untracked truncated)" : ""
                    }`}
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
          lineDiffType: "word",
          stickyHeaders: true,
          // Matches PierrePool's engine choice (see the rationale there):
          // V8 renderer → JS regex engine, no grow-only wasm memory.
          preferredHighlighter: "shiki-js",
        }}
      />
    </div>
  );
}
