import { GlassView } from "expo-glass-effect";
import type { ReactNode } from "react";
import { useColorScheme, View } from "react-native";

/**
 * The composer's Liquid Glass pill, shared by the InputBar and the prompt
 * cards that take its place, so swapping one for the other keeps the same
 * surface.
 *
 * Liquid Glass requires iOS 26+. On older iOS / Android the GlassView
 * silently falls back to a plain View; the inline `backgroundColor`
 * provides the fallback fill so the surface stays visible.
 */
export function ComposerGlass({ children }: { children: ReactNode }) {
  const colorScheme = useColorScheme();
  return (
    <View className="px-4">
      <GlassView
        isInteractive
        glassEffectStyle="regular"
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
        {children}
      </GlassView>
    </View>
  );
}
