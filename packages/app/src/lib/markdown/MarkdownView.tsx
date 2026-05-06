import { type ComponentProps, useCallback, useState } from "react";
import { type StyleProp, useColorScheme, type ViewStyle } from "react-native";
import { DiffsView, type Theme } from "react-native-diffs";

type DiffsProps = ComponentProps<typeof DiffsView>;

// Caller-facing API: keep callbacks as plain functions. Internally we wrap
// `onContentSizeChange` in `{ f: fn }` for Nitro 0.35's JSI bridge convention.
//
// `theme` is intentionally NOT exposed — MarkdownView owns the chat/tool
// detail visual contract. Callers needing a custom theme should drop down
// to raw `DiffsView` instead.
export type MarkdownViewProps = Omit<
  DiffsProps,
  | "colorScheme"
  | "style"
  | "onContentSizeChange"
  | "onLineSelection"
  | "onLineSelectionEnd"
  | "onCustomMenuAction"
  | "theme"
> & {
  colorScheme?: "light" | "dark";
  style?: StyleProp<ViewStyle>;
  onContentSizeChange?: (size: { width: number; height: number }) => void;
};

// Default code styling — chosen to match ChatMarkdown's palette so chat
// markdown and tool-detail markdown render code blocks with the same
// background + text colors. DiffsView's Theme has only ONE
// `codeBackground` field (no separate inline-vs-block knob), so the dark
// codeBlock background wins (block is the dominant tool-detail content;
// inline code in tool detail is rare). fontFamily is NOT supported by
// DiffsView's Theme (sizes-only; see reference_react_native_diffs.md) —
// chat ↔ tool monospace face will diverge until upstream exposes it.
function buildDefaultTheme(scheme: "light" | "dark"): Theme {
  if (scheme === "dark") {
    return {
      fonts: { codeSize: 14, codeInlineSize: 14 },
      colors: {
        body: "#fafafa",
        code: "#fafafa",
        codeBackground: "#18181b",
      },
    };
  }
  return {
    fonts: { codeSize: 14, codeInlineSize: 14 },
    colors: {
      body: "#0a0a0a",
      code: "#0a0a0a",
      codeBackground: "#f4f4f5",
    },
  };
}

// Wraps react-native-diffs DiffsView so it can be embedded in content-sized
// React Native parents. Nitro does not propagate UIView intrinsic size to
// Yoga (mrousavy/nitro#1199), so the local fork's onContentSizeChange callback
// reports measured markdown height, which we apply as inline style.
export function MarkdownView({
  colorScheme,
  style,
  onContentSizeChange,
  ...rest
}: MarkdownViewProps) {
  const systemRaw = useColorScheme();
  const resolvedScheme: "light" | "dark" =
    colorScheme ?? (systemRaw === "dark" ? "dark" : "light");
  const [measuredHeight, setMeasuredHeight] = useState<number | undefined>(
    undefined,
  );

  const handleContentSizeChange = useCallback(
    (size: { width: number; height: number }) => {
      setMeasuredHeight(size.height);
      onContentSizeChange?.(size);
    },
    [onContentSizeChange],
  );

  return (
    <DiffsView
      {...(rest as DiffsProps)}
      colorScheme={resolvedScheme}
      theme={buildDefaultTheme(resolvedScheme)}
      // Nitro 0.35 callback prop convention — bare function silently becomes nil.
      onContentSizeChange={{ f: handleContentSizeChange } as never}
      style={
        [
          measuredHeight != null ? { height: measuredHeight } : null,
          style,
        ] as DiffsProps["style"]
      }
    />
  );
}

export type { Theme as MarkdownTheme } from "react-native-diffs";
