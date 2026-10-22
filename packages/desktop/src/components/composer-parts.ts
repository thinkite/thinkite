import type { PromptFile, PromptParts } from "@thinkite/oc-client";

// What the composer sends besides its text, after opencode desktop's
// `composer/request.ts` (v2.1.2, MIT): an @-picked file goes as a `file://`
// URI the service reads, a subagent or skill by name, each with the span of
// the text that names it; a pasted or dropped image or PDF goes inline as a
// `data:` URI.

/** Something an @ pick put in the text, keyed there by its `@…` value. */
export type Mention =
  | { kind: "file"; path: string }
  | { kind: "agent"; name: string }
  | { kind: "skill"; id: string };

/** An image or PDF waiting in the composer. */
export interface Attachment {
  id: string;
  name: string;
  mime: string;
  /** `data:<mime>;base64,…` */
  dataUrl: string;
}

/** Inline types opencode desktop sends; the service decodes up to 20 MiB. */
export const IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
];
export const PDF_TYPE = "application/pdf";
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/** `file://` URI of `path` (relative to `directory` unless absolute). */
export function fileUri(directory: string, path: string): string {
  const absolute = path.startsWith("/")
    ? path
    : `${directory.replace(/\/+$/, "")}/${path}`;
  return `file://${absolute.split("/").map(encodeURIComponent).join("/")}`;
}

/**
 * The parts for `text`: every whole-word occurrence of a picked mention,
 * with its span, plus the attachments. A mention whose text was edited away
 * sends nothing.
 */
export function buildParts(
  text: string,
  mentions: ReadonlyMap<string, Mention>,
  directory: string,
  attachments: readonly Attachment[],
): PromptParts {
  const files: PromptFile[] = [];
  const agents: NonNullable<PromptParts["agents"]>[number][] = [];
  const skills: NonNullable<PromptParts["skills"]>[number][] = [];
  for (const [value, mention] of mentions) {
    for (const start of occurrences(text, value)) {
      const span = { start, end: start + value.length, text: value };
      if (mention.kind === "file")
        files.push({
          uri: fileUri(directory, mention.path),
          name: mention.path.split("/").filter(Boolean).at(-1) ?? mention.path,
          mention: span,
        });
      else if (mention.kind === "agent")
        agents.push({ name: mention.name, mention: span });
      else skills.push({ id: mention.id, mention: span });
    }
  }
  for (const a of attachments) files.push({ uri: a.dataUrl, name: a.name });
  return { files, agents, skills };
}

/** Starts of `value` in `text` bounded by whitespace or the ends. */
function occurrences(text: string, value: string): number[] {
  const out: number[] = [];
  if (value === "") return out;
  for (let i = text.indexOf(value); i >= 0; i = text.indexOf(value, i + 1)) {
    const before = i === 0 ? "" : text[i - 1];
    const after = text[i + value.length] ?? "";
    if (!/\S/.test(before ?? "") && !/\S/.test(after)) out.push(i);
  }
  return out;
}

/** `/name args` → its parts; null when the text isn't a slash command. */
export function parseSlash(
  text: string,
): { name: string; args: string } | null {
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text);
  if (match === null) return null;
  return { name: match[1] as string, args: (match[2] ?? "").trim() };
}

/** The editor keeps a no-break space after each token; send plain ones. */
const NO_BREAK_SPACE = String.fromCharCode(0xa0);

export function plainText(value: string): string {
  return value.split(NO_BREAK_SPACE).join(" ").trim();
}
