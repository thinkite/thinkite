import { type ComponentProps, useCallback, useState } from "react";
import { type StyleProp, useColorScheme, type ViewStyle } from "react-native";
import { DiffsView } from "react-native-diffs";

type DiffsProps = ComponentProps<typeof DiffsView>;

// Caller-facing API: keep callbacks as plain functions. Internally we wrap
// `onContentSizeChange` in `{ f: fn }` for Nitro 0.35's JSI bridge convention.
export type MarkdownViewProps = Omit<
  DiffsProps,
  | "colorScheme"
  | "style"
  | "onContentSizeChange"
  | "onLineSelection"
  | "onLineSelectionEnd"
  | "onCustomMenuAction"
> & {
  colorScheme?: "light" | "dark";
  style?: StyleProp<ViewStyle>;
  onContentSizeChange?: (size: { width: number; height: number }) => void;
};

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
  const system = useColorScheme() ?? "light";
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
      colorScheme={colorScheme ?? system}
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
