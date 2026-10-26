// md4c, enriched's parser, links a bare URL only when its host has a dot
// and no port (`MD_FLAG_PERMISSIVEURLAUTOLINKS`): `http://localhost:5173/`,
// the link an agent writes for a dev server, stays plain text. So bare
// http(s) URLs outside code become `<…>` autolinks first, which CommonMark
// takes with any host. Links already written as links are left alone.

/** Up to whitespace, markdown delimiters or CJK punctuation (agents write
 *  `http://localhost:5173/。`). */
const URL = /https?:\/\/[^\s<>`"'[\]{}|\\^，。、；：！？（）【】「」《》]+/g;
const TRAILING = /[.,:;!?*_~]+$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

function count(text: string, ch: string): number {
  return text.split(ch).length - 1;
}

function linkText(text: string): string {
  return text.replace(URL, (match: string, offset: number) => {
    const before = text.slice(Math.max(0, offset - 2), offset);
    // `<url>`, `[url](…)`, `[…](url)`: already a link.
    if (before.endsWith("<") || before.endsWith("[") || before === "](")
      return match;
    let url = match.replace(TRAILING, "");
    while (url.endsWith(")") && count(url, "(") < count(url, ")"))
      url = url.slice(0, -1).replace(TRAILING, "");
    return `<${url}>${match.slice(url.length)}`;
  });
}

/** A line outside fenced code: links in the text between code spans. */
function linkLine(line: string): string {
  let out = "";
  let at = 0;
  for (const span of line.matchAll(/(`+)[^`]*?\1/g)) {
    out += linkText(line.slice(at, span.index)) + span[0];
    at = span.index + span[0].length;
  }
  return out + linkText(line.slice(at));
}

/** `markdown` with bare http(s) URLs outside code turned into autolinks. */
export function linkBareUrls(markdown: string): string {
  if (!markdown.includes("://")) return markdown;
  let fence: string | null = null;
  return markdown
    .split("\n")
    .map((line) => {
      const open = FENCE.exec(line)?.[1];
      if (fence !== null) {
        if (open?.[0] === fence[0] && open.length >= fence.length) fence = null;
        return line;
      }
      if (open !== undefined) {
        fence = open;
        return line;
      }
      return linkLine(line);
    })
    .join("\n");
}
