import { useMemo } from "react";
import type { RemendOptions } from "remend";
import remend from "remend";

/**
 * remend repairs unterminated inline markdown mid-stream (`**bold`,
 * half-typed links, unclosed backticks) — the layer enriched's own
 * streaming props do NOT cover (those handle table blocks + token fade
 * only). Applied to the TAIL run only — completed segments need no repair.
 *
 * Runs SYNC on the JS thread, deliberately. The SWM lab pattern
 * (react-native-streamdown) offloads remend to a worklet runtime, but
 * calling an npm library inside a worklet requires babel-workletizing the
 * module ("Tried to synchronously call a non-worklet function" otherwise)
 * — config tax we don't need: chunk-first means remend's input is just
 * the trailing run, sub-ms regex work. Revisit only if profiling says
 * otherwise.
 */

const defaultRemendConfig: RemendOptions = {
  bold: true,
  italic: true,
  boldItalic: true,
  strikethrough: true,
  links: true,
  linkMode: "text-only",
  images: true,
  inlineCode: true,
  katex: false,
  setextHeadings: true,
};

export function useRemend(markdown: string, config?: RemendOptions): string {
  return useMemo(() => {
    if (markdown === "") return "";
    const mergedConfig = config
      ? { ...defaultRemendConfig, ...config }
      : defaultRemendConfig;
    return remend(markdown, mergedConfig);
  }, [markdown, config]);
}
