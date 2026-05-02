import { router, Stack } from "expo-router";
import { useState } from "react";
import {
  Pressable,
  ScrollView,
  Text,
  useColorScheme,
  View,
} from "react-native";
import { DiffsView } from "react-native-diffs";
import { SafeAreaView } from "@/lib/styled";

// Dev page: probe react-native-diffs (DiffsView) with the kinds of content
// our Read/Write/Edit tool blocks will throw at it. Pick a case from the chip
// row and inspect; toggle "Show raw" to see the literal string we pass.

interface TestCase {
  id: string;
  label: string;
  description: string;
  content: string;
}

// ----- Edit tool variants (unified diff in fenced block) -----

const SMALL_EDIT = `\`\`\`diff
@@ -10,7 +10,7 @@ export default function Home() {
   <div>
-    <h2>Design Engineer</h2>
+    <h2>Designer</h2>
   </div>
 }
\`\`\``;

const MULTI_HUNK = `\`\`\`diff
@@ -1,8 +1,8 @@
-import { useState, useEffect } from "react";
+import { useState, useEffect, useMemo } from "react";
 import { View } from "react-native";

-function Counter() {
-  const [count, setCount] = useState(0);
+function Counter({ initial = 0 }: { initial?: number }) {
+  const [count, setCount] = useState(initial);
   return <View>{count}</View>;
 }
@@ -20,5 +20,7 @@ function Counter() {
 export default function App() {
   return <Counter />;
 }
+
+export { Counter };
\`\`\``;

const ADDITIONS_ONLY = `\`\`\`diff
@@ -5,6 +5,12 @@
 import { View } from "react-native";

 export default function App() {
+  const [count, setCount] = useState(0);
+
+  useEffect(() => {
+    console.log("mounted");
+  }, []);
+
   return <View />;
 }
\`\`\``;

const DELETIONS_ONLY = `\`\`\`diff
@@ -10,12 +10,6 @@
 import { View } from "react-native";

 export default function App() {
-  const [count, setCount] = useState(0);
-
-  useEffect(() => {
-    console.log("mounted");
-  }, []);
-
   return <View />;
 }
\`\`\``;

// "Write" tool — new file, encoded as a /dev/null → file diff
const WRITE_NEW_FILE = `\`\`\`diff
--- /dev/null
+++ b/src/utils/format.ts
@@ -0,0 +1,12 @@
+export function projectName(cwd: string): string {
+  const parts = cwd.split("/");
+  return parts[parts.length - 1] ?? cwd;
+}
+
+export function relativeTime(ms: number): string {
+  const diff = Date.now() - ms;
+  if (diff < 60_000) return "just now";
+  if (diff < 3_600_000) return \`\${Math.floor(diff / 60_000)}m ago\`;
+  if (diff < 86_400_000) return \`\${Math.floor(diff / 3_600_000)}h ago\`;
+  return \`\${Math.floor(diff / 86_400_000)}d ago\`;
+}
\`\`\``;

// Big diff: 50+ lines, multiple hunks — perf check
const LARGE_DIFF = `\`\`\`diff
@@ -1,20 +1,22 @@
-import { createContext, useContext, useState } from "react";
+import { createContext, useContext, useState, useEffect } from "react";
 import { View, Text } from "react-native";

-interface ThemeContext {
+export interface ThemeContextValue {
   mode: "light" | "dark";
-  toggle: () => void;
+  setMode: (m: "light" | "dark") => void;
+  systemMode: "light" | "dark";
 }

-const Context = createContext<ThemeContext | null>(null);
+const Context = createContext<ThemeContextValue | null>(null);

 export function ThemeProvider({ children }: { children: React.ReactNode }) {
   const [mode, setMode] = useState<"light" | "dark">("light");
+  const systemMode = useColorScheme() ?? "light";

-  const toggle = () => setMode((m) => (m === "light" ? "dark" : "light"));
+  useEffect(() => {
+    setMode(systemMode);
+  }, [systemMode]);

-  return <Context.Provider value={{ mode, toggle }}>{children}</Context.Provider>;
+  return <Context.Provider value={{ mode, setMode, systemMode }}>{children}</Context.Provider>;
 }
@@ -25,8 +27,12 @@ export function useTheme() {
   if (!ctx) throw new Error("useTheme must be used inside ThemeProvider");
   return ctx;
 }

-export function ThemeBadge() {
+export function ThemeBadge({ showSystem = false }: { showSystem?: boolean }) {
   const theme = useTheme();
-  return <Text>{theme.mode}</Text>;
+  return (
+    <View>
+      <Text>mode: {theme.mode}</Text>
+      {showSystem && <Text>system: {theme.systemMode}</Text>}
+    </View>
+  );
 }
\`\`\``;

// ----- Read tool variants (plain fenced code, no diff) -----

const READ_TS = `\`\`\`tsx
import { useState } from "react";
import { View, Text } from "react-native";

interface CounterProps {
  initial?: number;
  step?: number;
}

export function Counter({ initial = 0, step = 1 }: CounterProps) {
  const [count, setCount] = useState(initial);

  return (
    <View>
      <Text>Count: {count}</Text>
    </View>
  );
}
\`\`\``;

const READ_PYTHON = `\`\`\`python
def fibonacci(n: int) -> list[int]:
    """Generate the first n Fibonacci numbers."""
    if n <= 0:
        return []
    if n == 1:
        return [0]

    result = [0, 1]
    while len(result) < n:
        result.append(result[-1] + result[-2])
    return result


if __name__ == "__main__":
    print(fibonacci(10))
\`\`\``;

const READ_JSON = `\`\`\`json
{
  "name": "@sidecodeapp/app",
  "version": "1.0.0",
  "main": "expo-router/entry",
  "scripts": {
    "start": "expo start",
    "ios": "expo run:ios"
  },
  "dependencies": {
    "expo": "~55.0.19",
    "react-native": "0.83.6",
    "react-native-diffs": "^1.0.3"
  }
}
\`\`\``;

const READ_RUST = `\`\`\`rust
use std::collections::HashMap;

#[derive(Debug, Clone)]
struct Counter<K> {
    counts: HashMap<K, usize>,
}

impl<K: std::hash::Hash + Eq> Counter<K> {
    fn new() -> Self {
        Self { counts: HashMap::new() }
    }

    fn add(&mut self, key: K) {
        *self.counts.entry(key).or_insert(0) += 1;
    }
}
\`\`\``;

// ----- Bash tool — shell session output -----

const BASH_OUTPUT = `\`\`\`bash
$ pnpm test
> sidecode@1.0.0 test
> vitest run

 ✓ src/lib/format.test.ts (3)
 ✓ src/lib/transcript-blocks.test.ts (8)
 ✓ src/lib/pair-config.test.ts (2)

Test Files  3 passed (3)
     Tests  13 passed (13)
  Start at  09:52:14
  Duration  428ms
\`\`\``;

// ----- Edge cases -----

const LONG_LINES = `\`\`\`diff
@@ -1,3 +1,3 @@
-const longString = "this is a very long string that should test how the diff viewer handles horizontal overflow when a single line exceeds the typical viewport width on a mobile device";
+const longString = "this is a slightly different but still very long string that should test how the diff viewer handles horizontal overflow when a single line exceeds the typical viewport width on a mobile device, with extra text appended at the end";
 const short = "ok";
\`\`\``;

const UNICODE = `\`\`\`diff
@@ -1,5 +1,5 @@
-const greeting = "Hello 👋";
-const status = "✅ Done";
+const greeting = "你好 👋🌍";
+const status = "🎉 Completed!";
 const emoji = "🚀";
\`\`\``;

const EMPTY = "";

const RAW_DIFF_NO_FENCE = `@@ -1,3 +1,3 @@
-const a = 1;
+const a = 2;
 const b = 3;`;

const MULTI_BLOCK = `\`\`\`diff
@@ -1,3 +1,3 @@
 // file: a.ts
-const a = 1;
+const a = 2;
\`\`\`

\`\`\`diff
@@ -1,3 +1,3 @@
 // file: b.ts
-const b = 1;
+const b = 2;
\`\`\``;

const MARKDOWN_MIXED = `# Design Doc

This is a paragraph with **bold** and _italic_ text, plus inline \`code\`.

## Code block

\`\`\`tsx
function hello() {
  return "world";
}
\`\`\`

## Diff

\`\`\`diff
@@ -1,3 +1,3 @@
-old line
+new line
 unchanged
\`\`\`

End of doc.`;

const CASES: TestCase[] = [
  { id: "small-edit", label: "Edit · small", description: "1-line change in 1 hunk", content: SMALL_EDIT },
  { id: "multi-hunk", label: "Edit · multi-hunk", description: "2 hunks in 1 file", content: MULTI_HUNK },
  { id: "additions", label: "Edit · adds only", description: "no -lines, only +", content: ADDITIONS_ONLY },
  { id: "deletions", label: "Edit · dels only", description: "no +lines, only -", content: DELETIONS_ONLY },
  { id: "write-new", label: "Write · new file", description: "/dev/null → file (Write tool encoding)", content: WRITE_NEW_FILE },
  { id: "large", label: "Edit · large", description: "~50 lines, 2 hunks (perf check)", content: LARGE_DIFF },
  { id: "read-ts", label: "Read · TS", description: "plain ```tsx code block (Read tool)", content: READ_TS },
  { id: "read-py", label: "Read · Python", description: "plain ```python (test multi-language highlight)", content: READ_PYTHON },
  { id: "read-json", label: "Read · JSON", description: "plain ```json (test data formatting)", content: READ_JSON },
  { id: "read-rust", label: "Read · Rust", description: "plain ```rust (test less-common language)", content: READ_RUST },
  { id: "bash", label: "Bash · output", description: "shell session in ```bash", content: BASH_OUTPUT },
  { id: "long", label: "Long lines", description: "horizontal overflow behavior", content: LONG_LINES },
  { id: "unicode", label: "Unicode", description: "CJK + emoji (sanity-check on iOS 26.4 sim)", content: UNICODE },
  { id: "raw-no-fence", label: "Raw diff", description: "unified diff without ```diff fence", content: RAW_DIFF_NO_FENCE },
  { id: "multi-block", label: "Multi-block", description: "two ```diff blocks in one content", content: MULTI_BLOCK },
  { id: "markdown", label: "Markdown mixed", description: "headings + prose + code + diff", content: MARKDOWN_MIXED },
  { id: "empty", label: "Empty", description: "edge case: empty string", content: EMPTY },
];

export default function DiffsDevScreen() {
  const systemColorScheme = useColorScheme() ?? "light";
  const [caseId, setCaseId] = useState(CASES[0].id);
  const [showRaw, setShowRaw] = useState(false);
  const current = CASES.find((c) => c.id === caseId) ?? CASES[0];

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <SafeAreaView className="flex-1 bg-white dark:bg-black" edges={["top"]}>
        {/* Header row: back + raw toggle */}
        <View className="flex-row items-center justify-between px-4 pt-3">
          <Pressable onPress={() => router.back()} hitSlop={12}>
            <Text className="text-base text-blue-600 dark:text-blue-400">
              ← Back
            </Text>
          </Pressable>
          <Text className="text-base font-semibold text-black dark:text-white">
            Diffs Dev
          </Text>
          <Pressable onPress={() => setShowRaw((s) => !s)} hitSlop={12}>
            <Text className="text-sm text-gray-600 dark:text-gray-400">
              {showRaw ? "rendered" : "raw"}
            </Text>
          </Pressable>
        </View>

        {/* Case picker (horizontal chips) */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          className="border-b border-gray-200 py-2 dark:border-gray-800"
          contentContainerStyle={{ paddingHorizontal: 16, gap: 8 }}
        >
          {CASES.map((c) => {
            const active = c.id === caseId;
            return (
              <Pressable
                key={c.id}
                onPress={() => setCaseId(c.id)}
                className={
                  active
                    ? "rounded-full bg-blue-600 px-3 py-1.5"
                    : "rounded-full bg-gray-100 px-3 py-1.5 dark:bg-gray-900"
                }
              >
                <Text
                  className={
                    active
                      ? "text-xs font-medium text-white"
                      : "text-xs text-gray-700 dark:text-gray-300"
                  }
                >
                  {c.label}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>

        {/* Description strip */}
        <View className="border-b border-gray-200 px-4 py-2 dark:border-gray-800">
          <Text className="text-xs text-gray-500 dark:text-gray-400">
            {current.description} · {current.content.length} chars
          </Text>
        </View>

        {/* Body: rendered DiffsView OR raw string */}
        {showRaw ? (
          <ScrollView className="flex-1 bg-gray-50 dark:bg-gray-950">
            <Text
              selectable
              className="p-4 text-xs text-gray-800 dark:text-gray-200"
              style={{ fontFamily: "Menlo" }}
            >
              {current.content || "(empty string)"}
            </Text>
          </ScrollView>
        ) : (
          <DiffsView
            content={current.content}
            colorScheme={systemColorScheme}
            style={{ flex: 1 }}
          />
        )}
      </SafeAreaView>
    </>
  );
}
