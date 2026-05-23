import { GlassView } from "expo-glass-effect";
import { SymbolView } from "expo-symbols";
import { useState } from "react";
import { Pressable, TextInput, useColorScheme, View } from "react-native";

/**
 * Chat input bar — pill-shaped GlassView with placeholder + action row.
 *
 * Visual layout matches Claude iOS: glass surface, two visual rows —
 * placeholder/text on top, action row below (plus | spacer | mic | send).
 * The send button has three states:
 *   - `arrow.up` (active): user has typed text, tap → onSend(text)
 *   - `waveform` (idle):   no text, tap is a no-op (voice slot, V0.5+)
 *   - `stop.fill` (running): turn is in flight, tap → onInterrupt
 *
 * Liquid Glass requires iOS 26+. On older iOS / Android the GlassView
 * silently falls back to a plain View; the inline `backgroundColor`
 * provides the fallback fill so the surface stays visible.
 */
export function InputBar({
  onSend,
  onInterrupt,
  isRunning,
}: {
  onSend?: (text: string) => void;
  onInterrupt?: () => void;
  isRunning?: boolean;
}) {
  const [text, setText] = useState("");
  const colorScheme = useColorScheme() ?? "light";
  const hasText = text.length > 0;

  const handlePress = () => {
    if (isRunning) {
      onInterrupt?.();
      return;
    }
    if (!hasText) return;
    onSend?.(text);
    setText("");
  };

  const sendIconName: "arrow.up" | "waveform" | "stop.fill" = isRunning
    ? "stop.fill"
    : hasText
      ? "arrow.up"
      : "waveform";

  return (
    <View className="px-4">
      <GlassView
        isInteractive
        style={{
          borderRadius: 24,
          borderCurve: "continuous",
          // Fallback for iOS<26 / Android — GlassView degrades to plain
          // View, this color shows through. On iOS 26+ it sits behind the
          // Liquid Glass material and is mostly invisible.
          backgroundColor:
            colorScheme === "dark"
              ? "rgba(28,28,30,0.6)"
              : "rgba(255,255,255,0.6)",
        }}
      >
        <View className="p-3">
          <TextInput
            multiline
            numberOfLines={5}
            value={text}
            onChangeText={setText}
            placeholder="Reply to Claude"
            placeholderTextColor={
              colorScheme === "dark" ? "#71717a" : "#a1a1aa"
            }
            style={{
              color: colorScheme === "dark" ? "#fafafa" : "#0a0a0a",
            }}
            className="text-base"
          />
          <View className="mt-2 flex-row items-center justify-between">
            <Pressable className="p-1.75">
              <SymbolView
                name="plus"
                size={22}
                weight="regular"
                tintColor={colorScheme === "dark" ? "#e4e4e7" : "#3f3f46"}
              />
            </Pressable>
            <View className="flex-row items-center gap-3">
              <Pressable className="p-1.75">
                <SymbolView
                  name="mic"
                  size={22}
                  weight="regular"
                  tintColor={colorScheme === "dark" ? "#e4e4e7" : "#3f3f46"}
                />
              </Pressable>
              <Pressable
                onPress={handlePress}
                className={`p-1.75 items-center justify-center rounded-full ${
                  colorScheme === "dark" ? "bg-zinc-100" : "bg-zinc-900"
                }`}
              >
                <SymbolView
                  name={sendIconName}
                  size={22}
                  weight="semibold"
                  tintColor={colorScheme === "dark" ? "#0a0a0a" : "#fafafa"}
                />
              </Pressable>
            </View>
          </View>
        </View>
      </GlassView>
    </View>
  );
}
