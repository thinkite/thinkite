/**
 * Bare http(s) URLs in text. md4c's own autolinks need a dotted host and no
 * port, so `http://localhost:5173/`, the link an agent writes for a dev
 * server, would stay plain text (enriched-markdown#954). Up to whitespace
 * or CJK punctuation (agents write `http://localhost:5173/。`), and not
 * ending in sentence punctuation. Links already in the markdown, autolinks
 * and code are never matched.
 */
export const LINK_RECOGNITION = {
  text: /https?:\/\/[^\s<>`"'，。、；：！？（）【】「」《》]*[^\s<>`"'，。、；：！？（）【】「」《》.,:;!?)*_~]/,
};
