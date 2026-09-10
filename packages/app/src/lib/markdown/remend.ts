import { useMemo } from "react";
import type { RemendOptions } from "remend";
import remend from "remend";

/**
 * remend repairs unterminated inline markdown mid-stream (`**bold`,
 * half-typed links, unclosed backticks) — the layer enriched's own
 * streaming props do NOT cover (those handle table/code BLOCKS + token
 * fade only). Fence-aware: it never rewrites inside a code block.
 *
 * Runs SYNC on the JS thread, deliberately. The SWM lab pattern
 * (react-native-streamdown) offloads remend to a worklet runtime, but
 * calling an npm library inside a worklet requires babel-workletizing the
 * module ("Tried to synchronously call a non-worklet function" otherwise)
 * — config tax we don't need: it is regex work over one chat message,
 * sub-millisecond at our sizes. Revisit only if profiling says otherwise.
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

/** Repaired markdown while `streaming`; the input untouched once settled
 *  (a finished message needs no repair, and the identity-stable string
 *  keeps enriched's measurement cache warm). */
export function useRemend(markdown: string, streaming: boolean): string {
  return useMemo(() => {
    if (!streaming || markdown === "") return markdown;
    return remend(markdown, defaultRemendConfig);
  }, [markdown, streaming]);
}
