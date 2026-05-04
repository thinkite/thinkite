import { BottomSheetScrollView } from "@gorhom/bottom-sheet";
import type { ToolCallDetail } from "@sidecodeapp/protocol";
import { Accordion, BottomSheet, Button } from "heroui-native";
import { useState } from "react";
import { Text, useColorScheme, View } from "react-native";
import { MarkdownView } from "@/lib/markdown";
import { LinearGradient } from "@/lib/styled";
import type { ToolRenderBlock } from "@/lib/transcript-blocks";

// Threshold for "this content is tall enough to cap inline + offer the
// focused-view sheet". 600pt ≈ 70% of an iPhone 17 viewport — past that,
// scrolling the transcript past inline tool output gets tedious.
//
// When tripped, three things happen together:
//   1. The MarkdownView is wrapped in a hard-clip View (`overflow-hidden`
//      + `max-h-[600px]`), so the inline preview is visually truncated. We
//      don't use DiffsView's internal scroll — nested vertical scroll
//      inside a FlatList is a UX trap, and a sharp clip makes the "open in
//      focused view" affordance unambiguous.
//   2. A LinearGradient fade-out at the bottom of the clipped area hints
//      "there's more". pointerEvents="none" so the button stays tap-through.
//   3. An "Open in focused view" button is absolutely-positioned at the
//      bottom of the clipped area (above the gradient), opening a
//      BottomSheet with the full content.
//
// Keep this in sync with the `max-h-[600px]` className applied below.
const TALL_CONTENT_THRESHOLD_PT = 600;

/**
 * One paired tool_use+tool_result. Trigger row = chip + daemon-computed
 * summary; expanded view dispatches on `detail.type` to render the
 * appropriate UI: bash/read/grep/glob get fenced output through MarkdownView
 * (tree-sitter highlight when language is known), edit/write get a unified
 * diff (DiffsView's GitHub-style red/green renderer), todo gets a custom
 * checkbox list, unknown falls back to JSON pretty-print of input + output.
 *
 * The BottomSheet for "view full output" is encapsulated here on purpose.
 * Sheet open ⇒ overlay blocks the FlatList ⇒ no virtualization unmount
 * mid-animation, so keeping per-row sheets is safe.
 */
export function ToolBlock({ block }: { block: ToolRenderBlock }) {
  const isError = block.status === "failed";
  // Claude Desktop renders Bash as a chip-less "Ran <description>" verb-led
  // header. Other tools keep the colored badge chip for now.
  const isBash = block.name === "Bash";
  return (
    <View>
      {block.showRoleHeader ? (
        <View className="border-t border-gray-200 px-4 pt-3 dark:border-gray-800">
          <Text className="mb-1 text-[10px] font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
            CLAUDE
          </Text>
        </View>
      ) : null}
      <Accordion>
        <Accordion.Item value={block.callId}>
          <Accordion.Trigger className="px-4 py-3">
            <View className="flex-1 flex-row items-center gap-2">
              {isBash ? (
                <Text
                  numberOfLines={1}
                  className="flex-1 text-sm text-gray-700 dark:text-gray-300"
                >
                  <Text
                    className={
                      isError
                        ? "text-red-600 dark:text-red-400"
                        : "text-gray-500 dark:text-gray-400"
                    }
                  >
                    Ran{" "}
                  </Text>
                  {block.summary}
                </Text>
              ) : (
                <>
                  <ToolChip name={block.name} isError={isError} />
                  {block.summary ? (
                    <Text
                      numberOfLines={1}
                      className="flex-1 text-sm text-gray-700 dark:text-gray-300"
                    >
                      {block.summary}
                    </Text>
                  ) : (
                    <View className="flex-1" />
                  )}
                </>
              )}
            </View>
            <Accordion.Indicator />
          </Accordion.Trigger>
          <Accordion.Content className="px-4 pb-4">
            <DetailBody
              detail={block.detail}
              name={block.name}
              summary={block.summary}
              isError={isError}
              error={block.error}
            />
          </Accordion.Content>
        </Accordion.Item>
      </Accordion>
    </View>
  );
}

// ─── Detail dispatchers ────────────────────────────────────────────────

function DetailBody({
  detail,
  name,
  summary,
  isError,
  error,
}: {
  detail: ToolCallDetail;
  name: string;
  summary: string;
  isError: boolean;
  error: string | null;
}) {
  switch (detail.type) {
    case "bash":
      // Bash failure has no separate banner: the "Ran <cmd>" header turned red
      // in the trigger, and the body's `output` already carries stderr/exit
      // text the model saw. Showing a stderr blob as both "output" and "error
      // banner" would just duplicate.
      return (
        <FencedDetail
          markdownContent={fence(
            formatBashBody(detail.command, detail.output),
            "bash",
          )}
          toolName={name}
          summary={summary}
          isError={isError}
        />
      );
    case "edit":
    case "write":
      // Failed Edit/Write: the unified diff was *computed from input* and
      // never actually applied — rendering it would imply a successful change.
      // Show the error string instead (e.g. "old_string not found in file",
      // "File has not been read yet"). The diff itself stays hidden.
      if (isError) return <ErrorBanner text={error ?? "Tool failed."} />;
      // Pass unifiedDiff RAW (no ```diff fence). MarkdownView's diff renderer
      // is the auto-detect path triggered by content starting with `--- ` /
      // `+++ ` / `@@`; wrapping in a fence makes it fall through to the
      // generic code-block renderer (no red/green rows). Daemon's
      // makeUnifiedDiff already strips jsdiff's `Index:`/`===` preamble so
      // the content meets the auto-detect heuristic.
      return (
        <FencedDetail
          markdownContent={detail.unifiedDiff}
          toolName={name}
          summary={summary}
          isError={isError}
        />
      );
    case "read":
      // Failed Read (e.g. nonexistent path): `detail.content` would be the
      // error string, so fenced syntax-highlight would mis-render it as code
      // in `language`. Show as a plain banner instead.
      if (isError) return <ErrorBanner text={error ?? "Read failed."} />;
      return (
        <FencedDetail
          markdownContent={fence(detail.content, detail.language)}
          toolName={name}
          summary={summary}
          isError={isError}
        />
      );
    case "todo":
      // TodoWrite failures are exceedingly rare (input-only validation); if it
      // somehow does fail, the next assistant turn will say so — no special UI.
      return <TodoDetail detail={detail} />;
    case "grep":
    case "glob":
      // For grep/glob, the result text IS the rg/glob diagnostic on failure
      // (e.g. "No such file or directory") — show as the regular fenced
      // output, no separate banner.
      return (
        <FencedDetail
          markdownContent={fence(detail.output)}
          toolName={name}
          summary={summary}
          isError={isError}
        />
      );
    case "unknown":
      return (
        <UnknownDetail
          detail={detail}
          toolName={name}
          summary={summary}
          isError={isError}
          error={error}
        />
      );
  }
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

function FencedDetail({
  markdownContent,
  toolName,
  summary,
  isError,
}: {
  markdownContent: string;
  toolName: string;
  summary: string;
  isError: boolean;
}) {
  // Decide "show focused-view sheet button" based on the actually-rendered
  // markdown height (callback fired by MarkdownView wrapper, same channel
  // it uses internally for self-sizing). Raw line count is a poor proxy for
  // diffs/tables — DiffsView's gutter + word highlight rows balloon vertical
  // space well past what a `\n` count predicts.
  const [measuredHeight, setMeasuredHeight] = useState<number | null>(null);
  const isTall =
    measuredHeight !== null && measuredHeight > TALL_CONTENT_THRESHOLD_PT;
  const colorScheme = useColorScheme() ?? "light";

  if (markdownContent.length === 0) {
    return (
      <Text className="text-xs italic text-gray-500 dark:text-gray-400">
        (no output)
      </Text>
    );
  }

  // Fade end matches the transcript page background (white in light mode,
  // black in dark — see SafeAreaView in app/session/[cliSessionId].tsx).
  const fadeEndColor =
    colorScheme === "dark" ? "rgba(0,0,0,1)" : "rgba(255,255,255,1)";

  return (
    <View className={isTall ? "max-h-[600px] overflow-hidden" : undefined}>
      <MarkdownView
        content={markdownContent}
        onContentSizeChange={(size) => setMeasuredHeight(size.height)}
      />
      {isTall && (
        <>
          {/* Bottom fade to hint "there's more". pointerEvents=none so the
              button stays tap-through. LinearGradient takes className via
              uniwind's runtime style transform. */}
          <LinearGradient
            colors={["transparent", fadeEndColor]}
            className="absolute inset-x-0 bottom-0 h-20"
            pointerEvents="none"
          />
          {/* Absolute-positioned sheet trigger over the gradient. The
              BottomSheet's Portal escapes overflow:hidden via React Portal,
              so the modal content isn't clipped — only the trigger button
              lives inside this clipping View. */}
          <View className="absolute inset-x-0 bottom-3 items-center">
            <FullOutputSheet
              toolName={toolName}
              summary={summary}
              markdownContent={markdownContent}
              isError={isError}
              measuredHeight={measuredHeight ?? 0}
            />
          </View>
        </>
      )}
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
      {detail.todos.map((todo: (typeof detail.todos)[number]) => (
        // Anthropic's TodoWrite emits no stable id per item. Use content as
        // the React key — if Claude ever emits two todos with identical
        // content, React will warn about duplicate keys but the render
        // still works. Empirically this hasn't happened.
        <View key={todo.content} className="flex-row items-start gap-2">
          <TodoCheckbox status={todo.status} />
          <Text
            className={
              todo.status === "completed"
                ? "flex-1 text-sm text-gray-500 line-through dark:text-gray-500"
                : "flex-1 text-sm text-gray-900 dark:text-gray-100"
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
  toolName,
  summary,
  isError,
  error,
}: {
  detail: Extract<ToolCallDetail, { type: "unknown" }>;
  toolName: string;
  summary: string;
  isError: boolean;
  error: string | null;
}) {
  const inputJson = prettyJson(detail.input);
  const hasOutput = detail.output.length > 0;
  // For unknown tools we don't know whether the diagnostic lives in `output`
  // or only in `error` — surface the error banner only when output is empty
  // (otherwise trust the output blob to contain the message).
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
          {detail.output.split("\n").length > 40 ? (
            // Unknown variant doesn't render through MarkdownView so we
            // can't use the measured-height path. Fall back to line count
            // for the threshold; estimate height for the button label only
            // (~14pt per line of small selectable text).
            <FullOutputSheet
              toolName={toolName}
              summary={summary}
              markdownContent={fence(detail.output)}
              isError={isError}
              measuredHeight={detail.output.split("\n").length * 14}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

// ─── Shared ────────────────────────────────────────────────────────────

function FullOutputSheet({
  toolName,
  summary,
  markdownContent,
  isError,
  measuredHeight,
}: {
  toolName: string;
  summary: string;
  markdownContent: string;
  isError: boolean;
  /** Used only for the button label hint ("Open in focused view (1234pt)"). */
  measuredHeight: number;
}) {
  return (
    <BottomSheet>
      <BottomSheet.Trigger asChild>
        <Button variant="tertiary" size="sm" className="mt-2">
          <Button.Label>
            Open in focused view ({Math.round(measuredHeight)}pt tall)
          </Button.Label>
        </Button>
      </BottomSheet.Trigger>
      <BottomSheet.Portal>
        <BottomSheet.Overlay />
        <BottomSheet.Content
          snapPoints={["75%", "90%"]}
          enableOverDrag={false}
          enableDynamicSizing={false}
          contentContainerClassName="h-full px-0"
        >
          <BottomSheetScrollView
            contentContainerStyle={{ padding: 16, paddingBottom: 48 }}
          >
            <View className="mb-3 flex-row items-center gap-2">
              <ToolChip name={toolName} isError={isError} />
              {summary ? (
                <Text
                  numberOfLines={1}
                  className="flex-1 text-sm text-gray-700 dark:text-gray-300"
                >
                  {summary}
                </Text>
              ) : null}
            </View>
            <MarkdownView content={markdownContent} />
          </BottomSheetScrollView>
        </BottomSheet.Content>
      </BottomSheet.Portal>
    </BottomSheet>
  );
}

function ToolChip({ name, isError }: { name: string; isError: boolean }) {
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

function SectionLabel({
  children,
  error,
}: {
  children: React.ReactNode;
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
