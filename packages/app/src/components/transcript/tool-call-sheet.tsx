import {
  BottomSheetModal,
  BottomSheetScrollView,
} from "@expo/ui/community/bottom-sheet";
import type { ToolCallDetail } from "@sidecodeapp/protocol";
import {
  type ComponentRef,
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import { Text, View } from "react-native";
import { MarkdownView } from "@/lib/markdown";
import type { ToolRenderBlock } from "@/lib/transcript-blocks";

/**
 * Single shared BottomSheet at transcript level (Paseo pattern). Each
 * ToolBlock row is a Pressable that calls `openToolCall(block)` — the sheet
 * lives outside the virtualized list, so its open state is independent of
 * row-recycle lifecycle. Combined with the trigger row losing the inline
 * DiffsView, this lets LegendList run with `recycleItems` enabled and a
 * uniform low estimated row height.
 *
 * Implementation: `@expo/ui/community/bottom-sheet` (gorhom-API drop-in
 * backed by SwiftUI `.sheet(isPresented:)` → `UISheetPresentationController`
 * on iOS). API stays gorhom-shaped (imperative ref `present()`/`dismiss()`,
 * `snapPoints`, `onDismiss`); under the hood it's an iOS native sheet — no
 * Reanimated layer, matches Apple Maps / Files location-card physics.
 *
 * Lifecycle: `block` holds the rendered detail across the slide-out and is
 * cleared in `onDismiss`. Per the community-bottom-sheet iOS impl, user
 * dismissals route through SwiftUI's @State change → JS handler runs AFTER
 * the close animation, so content stays mounted during the slide-out and
 * we don't flash empty content.
 *
 * Caveats vs gorhom (per node_modules/@expo/ui/src/community/bottom-sheet/CLAUDE.md):
 *   - `BottomSheetBackdrop` not supported → SwiftUI provides system backdrop
 *   - `handleIndicatorStyle` / `handleStyle` accepted but no-op on native
 *   - `enablePanDownToClose` controls BOTH swipe-to-dismiss AND backdrop tap
 *     (SwiftUI doesn't expose these separately)
 */

type SheetRef = ComponentRef<typeof BottomSheetModal>;

interface ToolCallSheetContextValue {
  openToolCall: (block: ToolRenderBlock) => void;
  closeToolCall: () => void;
}

const ToolCallSheetContext = createContext<ToolCallSheetContextValue | null>(
  null,
);

export function useToolCallSheet(): ToolCallSheetContextValue {
  const ctx = useContext(ToolCallSheetContext);
  if (!ctx) {
    throw new Error(
      "useToolCallSheet must be used within ToolCallSheetProvider",
    );
  }
  return ctx;
}

const SNAP_POINTS = ["50%", "100%"];

export function ToolCallSheetProvider({ children }: { children: ReactNode }) {
  const sheetRef = useRef<SheetRef>(null);
  const [block, setBlock] = useState<ToolRenderBlock | null>(null);

  const openToolCall = useCallback((b: ToolRenderBlock) => {
    setBlock(b);
    sheetRef.current?.present();
  }, []);

  const closeToolCall = useCallback(() => {
    sheetRef.current?.dismiss();
  }, []);

  const handleDismiss = useCallback(() => {
    setBlock(null);
  }, []);

  const value = useMemo(
    () => ({ openToolCall, closeToolCall }),
    [openToolCall, closeToolCall],
  );

  // iOS 26's SwiftUI sheet uses Liquid Glass as the default presentation
  // material — translucent over the transcript behind. We let that through
  // (no backgroundColor override) so the sheet has a consistent glassy look
  // edge-to-edge. Painting a solid color on just the inner ScrollView
  // covers the middle but leaves the drag-handle strip and bottom safe-area
  // chrome translucent → looks broken (those strips live OUTSIDE our
  // ScrollView, inside community/bottom-sheet's internal RNHostView).
  // SwiftUI's `presentationBackground` modifier (the proper override) isn't
  // exposed by @expo/ui — until it is, embrace the glass aesthetic and tune
  // child content (code blocks, diffs) for transparency instead.
  return (
    <ToolCallSheetContext.Provider value={value}>
      {children}
      <BottomSheetModal
        ref={sheetRef}
        snapPoints={SNAP_POINTS}
        enableDynamicSizing={false}
        enablePanDownToClose
        onDismiss={handleDismiss}
      >
        <BottomSheetScrollView
          contentContainerStyle={{ padding: 16, paddingBottom: 48 }}
        >
          {block ? <SheetBody block={block} /> : null}
        </BottomSheetScrollView>
      </BottomSheetModal>
    </ToolCallSheetContext.Provider>
  );
}

// ─── Sheet content ─────────────────────────────────────────────────────

function SheetBody({ block }: { block: ToolRenderBlock }) {
  const isError = block.status === "failed";
  return (
    <View>
      <View className="mb-3 flex-row items-center gap-2">
        <ToolChip name={block.name} isError={isError} />
        {block.summary ? (
          <Text
            numberOfLines={1}
            className="flex-1 text-base text-gray-700 dark:text-gray-300"
          >
            {block.summary}
          </Text>
        ) : null}
      </View>
      <DetailBody detail={block.detail} isError={isError} error={block.error} />
    </View>
  );
}

function DetailBody({
  detail,
  isError,
  error,
}: {
  detail: ToolCallDetail;
  isError: boolean;
  error: string | null;
}) {
  switch (detail.type) {
    case "bash":
      return (
        <FencedDetail
          markdownContent={fence(
            formatBashBody(detail.command, detail.output),
            "bash",
          )}
        />
      );
    case "edit":
    case "write":
      // Failed Edit/Write: the unified diff was *computed from input* and
      // never actually applied — rendering it would imply a successful change.
      if (isError) return <ErrorBanner text={error ?? "Tool failed."} />;
      // Pass unifiedDiff RAW (no ```diff fence). MarkdownView's diff renderer
      // is the auto-detect path triggered by content starting with `--- ` /
      // `+++ ` / `@@`; wrapping in a fence makes it fall through to the
      // generic code-block renderer (no red/green rows).
      return <FencedDetail markdownContent={detail.unifiedDiff} />;
    case "read":
      // Failed Read: detail.content is the error string; show as plain banner.
      if (isError) return <ErrorBanner text={error ?? "Read failed."} />;
      return (
        <FencedDetail
          markdownContent={fence(detail.content, detail.language)}
        />
      );
    case "todo":
      return <TodoDetail detail={detail} />;
    case "grep":
    case "glob":
      return <FencedDetail markdownContent={fence(detail.output)} />;
    case "unknown":
      return <UnknownDetail detail={detail} isError={isError} error={error} />;
  }
}

function FencedDetail({ markdownContent }: { markdownContent: string }) {
  if (markdownContent.length === 0) {
    return (
      <Text className="text-xs italic text-gray-500 dark:text-gray-400">
        (no output)
      </Text>
    );
  }
  return <MarkdownView content={markdownContent} />;
}

function ErrorBanner({ text }: { text: string }) {
  return (
    <View className="rounded border border-red-300 bg-red-50 p-2 dark:border-red-800 dark:bg-red-950">
      <Text selectable className="text-xs text-red-700 dark:text-red-300">
        {text}
      </Text>
    </View>
  );
}

function TodoDetail({
  detail,
}: {
  detail: Extract<ToolCallDetail, { type: "todo" }>;
}) {
  if (detail.todos.length === 0) {
    return (
      <Text className="text-xs italic text-gray-500 dark:text-gray-400">
        (empty todo list)
      </Text>
    );
  }
  return (
    <View className="gap-2">
      {detail.todos.map((todo) => (
        <View key={todo.content} className="flex-row items-start gap-2">
          <TodoCheckbox status={todo.status} />
          <Text
            className={
              todo.status === "completed"
                ? "flex-1 text-base text-gray-500 line-through dark:text-gray-500"
                : "flex-1 text-base text-gray-900 dark:text-gray-100"
            }
          >
            {todo.status === "in_progress" ? todo.activeForm : todo.content}
          </Text>
        </View>
      ))}
    </View>
  );
}

function TodoCheckbox({
  status,
}: {
  status: "pending" | "in_progress" | "completed";
}) {
  const base = "mt-0.5 h-4 w-4 rounded border items-center justify-center";
  switch (status) {
    case "completed":
      return (
        <View className={`${base} border-green-500 bg-green-500`}>
          <Text className="text-[10px] font-bold text-white">✓</Text>
        </View>
      );
    case "in_progress":
      return (
        <View
          className={`${base} border-blue-500 bg-blue-100 dark:bg-blue-900`}
        />
      );
    case "pending":
      return (
        <View className={`${base} border-gray-400 dark:border-gray-600`} />
      );
  }
}

function UnknownDetail({
  detail,
  isError,
  error,
}: {
  detail: Extract<ToolCallDetail, { type: "unknown" }>;
  isError: boolean;
  error: string | null;
}) {
  const inputJson = prettyJson(detail.input);
  const hasOutput = detail.output.length > 0;
  // For unknown tools we don't know whether the diagnostic lives in `output`
  // or only in `error` — surface the error banner only when output is empty.
  const showErrorBanner = isError && !hasOutput;
  return (
    <View>
      {showErrorBanner ? (
        <View className="mb-3">
          <ErrorBanner text={error ?? "Tool failed."} />
        </View>
      ) : null}
      <SectionLabel>Input</SectionLabel>
      <Text
        selectable
        className="rounded bg-gray-100 p-2 text-xs text-gray-900 dark:bg-gray-900 dark:text-gray-100"
      >
        {inputJson}
      </Text>
      {hasOutput ? (
        <View className="mt-3">
          <SectionLabel error={isError}>Output</SectionLabel>
          <Text
            selectable
            className="rounded bg-gray-100 p-2 text-xs text-gray-900 dark:bg-gray-900 dark:text-gray-100"
          >
            {detail.output}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

function SectionLabel({
  children,
  error,
}: {
  children: ReactNode;
  error?: boolean;
}) {
  return (
    <Text
      className={`mb-1 text-[10px] font-medium uppercase tracking-wider ${
        error
          ? "text-red-600 dark:text-red-400"
          : "text-gray-500 dark:text-gray-400"
      }`}
    >
      {children}
    </Text>
  );
}

// ─── Shared chip (used by trigger row in tool-block.tsx and sheet header) ──

export function ToolChip({
  name,
  isError,
}: {
  name: string;
  isError: boolean;
}) {
  return (
    <View
      className={`rounded-md px-2 py-0.5 ${
        isError ? "bg-red-100 dark:bg-red-900" : "bg-blue-100 dark:bg-blue-900"
      }`}
    >
      <Text
        className={`text-[11px] font-semibold uppercase tracking-wide ${
          isError
            ? "text-red-700 dark:text-red-200"
            : "text-blue-700 dark:text-blue-200"
        }`}
      >
        {name}
      </Text>
    </View>
  );
}

// ─── Helpers ───────────────────────────────────────────────────────────

function fence(body: string, lang?: string): string {
  if (body.length === 0) return "";
  return `\`\`\`${lang ?? ""}\n${body}\n\`\`\``;
}

/**
 * Compose a Bash detail body the way Claude Desktop does: the command
 * prefixed with `$ ` (subsequent lines with `> ` like an interactive shell
 * continuation), then the captured output below. We always show the command
 * — even when output is empty — so a Bash invocation stays visible after
 * its expected silence (e.g. `cd`, `mkdir`).
 */
function formatBashBody(command: string, output: string): string {
  const cmdLines = command.split("\n");
  const cmdFormatted = cmdLines
    .map((line, i) => (i === 0 ? `$ ${line}` : `> ${line}`))
    .join("\n");
  return output.length > 0 ? `${cmdFormatted}\n${output}` : cmdFormatted;
}

function prettyJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
