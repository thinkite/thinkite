import { Stack } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";

import { ChatMarkdown, ChunkedMarkdown } from "@/lib/markdown";

/**
 * Dev screen — side-by-side: whole-message ChatMarkdown (former
 * production path) vs the PRODUCTION chunked renderer (now what the
 * transcript ships). Same corpus streams into both panes.
 *
 * What to verify on device:
 *  1. Selection feel — continuous within a run (across paragraphs AND the
 *     table), breaks at code-block boundaries.
 *  2. HUD lex timing — whole-message re-lex per tick should stay ~ms.
 *  3. HUD tok timing — per-delta full re-tokenize cost of code blocks.
 *  4. ASCII diagram (bare fence) — no wrap, box-drawing aligns, zero
 *     tok cost (resolveLang null → plain path).
 */

const CORPUS = `### Chunked renderer check

Some *emphasis*, \`inline code\`, and a [link](https://example.com) in the
opening paragraph.

- list item one
- list item two with **bold**

\`\`\`tsx
export function Demo({ items }: { items: string[] }) {
  return (
    <ul>
      {items.map((it) => (
        <li key={it}>{it.toUpperCase()}</li>
      ))}
    </ul>
  );
}
\`\`\`

Text between the two code blocks — selection should flow from the list
above, through this paragraph, into the table below as ONE run.

| col A | col B | col C |
| --- | --- | --- |
| tables | stay in | enriched |
| runs | by | decision |

\`\`\`python
def fib(n: int) -> int:
    a, b = 0, 1
    for _ in range(n):
        a, b = b, a + b
    return a
\`\`\`

An ASCII diagram in a bare fence — must not wrap, box-drawing must align:

\`\`\`
┌──────────┐  patch_text   ┌──────────────┐  flatten   ┌────────────┐
│  daemon  │ ────────────▶ │ TanStack DB  │ ─────────▶ │ LegendList │
└──────────┘               └──────┬───────┘            └────────────┘
                                  │ 中文标签对齐测试
                                  ▼
                           ┌──────────────┐
                           │ ChunkedMd 渲染 │
                           └──────────────┘
\`\`\`

Closing paragraph after the second code block.`;

const STEP = 24;
const TICK_MS = 60;

export default function ChunkedMarkdownDevScreen() {
  const [pos, setPos] = useState(CORPUS.length);
  const [streaming, setStreaming] = useState(false);
  const statsRef = useRef({ lexAvg: 0, lexMax: 0, n: 0, segs: 0, changed: -1 });
  const tokRef = useRef({ sum: 0, max: 0, n: 0 });
  const [, forceHud] = useState(0);

  // Stable identity — CodeBlockSegment is memo'd on this prop.
  const onTokenizeMs = useCallback((ms: number) => {
    const t = tokRef.current;
    t.sum += ms;
    t.n += 1;
    if (ms > t.max) t.max = ms;
  }, []);

  useEffect(() => {
    if (!streaming) return;
    const timer = setInterval(() => {
      setPos((p) => {
        const next = Math.min(p + STEP, CORPUS.length);
        if (next >= CORPUS.length) setStreaming(false);
        return next;
      });
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [streaming]);

  // Throttled HUD refresh while streaming (stats land in a ref).
  useEffect(() => {
    if (!streaming) return;
    const t = setInterval(() => forceHud((x) => x + 1), 300);
    return () => clearInterval(t);
  }, [streaming]);

  const text = CORPUS.slice(0, pos);
  const done = pos >= CORPUS.length && !streaming;
  const s = statsRef.current;
  const tk = tokRef.current;

  return (
    <>
      <Stack.Screen options={{ title: "Chunked markdown spike" }} />
      <View className="flex-1 bg-white dark:bg-black">
        <View className="flex-row items-center gap-2 px-4 py-2">
          <Pressable
            onPress={() => {
              setPos(0);
              statsRef.current = {
                lexAvg: 0,
                lexMax: 0,
                n: 0,
                segs: 0,
                changed: -1,
              };
              tokRef.current = { sum: 0, max: 0, n: 0 };
              setStreaming(true);
            }}
            className="px-3 py-1.5 rounded-full bg-blue-600"
          >
            <Text className="text-sm font-medium text-white">
              {streaming ? "restart" : "▶︎ stream"}
            </Text>
          </Pressable>
          <Pressable
            onPress={() => {
              setStreaming(false);
              setPos(CORPUS.length);
            }}
            className="px-3 py-1.5 rounded-full bg-zinc-200 dark:bg-zinc-800"
          >
            <Text className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
              ⏭ finish
            </Text>
          </Pressable>
          <View className="flex-1">
            <Text className="text-[10px] font-mono text-zinc-500 text-right">
              lex avg {s.n ? (s.lexAvg / s.n).toFixed(2) : "—"} / max{" "}
              {s.lexMax.toFixed(1)}ms · {s.segs} segs · Δ@{s.changed}
            </Text>
            <Text className="text-[10px] font-mono text-zinc-500 text-right">
              tok avg {tk.n ? (tk.sum / tk.n).toFixed(2) : "—"} / max{" "}
              {tk.max.toFixed(1)}ms · {tk.n}×
            </Text>
          </View>
        </View>

        <View className="flex-1 border-b border-zinc-200 dark:border-zinc-800">
          <Text className="px-4 py-1 text-[10px] font-mono text-zinc-400 uppercase">
            current: whole-message enriched
          </Text>
          <ScrollView className="flex-1 px-4">
            <ChatMarkdown markdown={text} />
            <View className="h-8" />
          </ScrollView>
        </View>

        <View className="flex-1">
          <Text className="px-4 py-1 text-[10px] font-mono text-zinc-400 uppercase">
            spike: chunked (runs + code breakout)
          </Text>
          <ScrollView className="flex-1 px-4">
            <ChunkedMarkdown
              markdown={text}
              streamDone={done}
              onTokenizeMs={onTokenizeMs}
              onStats={(stats) => {
                const st = statsRef.current;
                st.lexAvg += stats.lexMs;
                st.n += 1;
                if (stats.lexMs > st.lexMax) st.lexMax = stats.lexMs;
                st.segs = stats.segmentCount;
                st.changed = stats.firstChangedIndex;
              }}
            />
            <View className="h-8" />
          </ScrollView>
        </View>
      </View>
    </>
  );
}
