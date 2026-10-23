import { Button } from "@astryxdesign/core/Button";
import {
  ChatComposer,
  ChatComposerDrawer,
  ChatComposerInput,
  type ChatComposerInputHandle,
  type ChatComposerStatus,
  type ChatComposerTrigger,
} from "@astryxdesign/core/Chat";
import { Icon } from "@astryxdesign/core/Icon";
import { Text } from "@astryxdesign/core/Text";
import { Thumbnail } from "@astryxdesign/core/Thumbnail";
import type { SearchableItem } from "@astryxdesign/core/Typeahead";
import type {
  AgentInfo,
  CommandInfo,
  PromptParts,
  SkillInfo,
} from "@thinkite/oc-client";
import {
  CircleUserIcon,
  FileIcon,
  FolderIcon,
  PlusIcon,
  SparklesIcon,
} from "lucide-react";
import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ocClient } from "../lib/oc";
import {
  type Attachment,
  buildParts,
  IMAGE_TYPES,
  MAX_ATTACHMENT_BYTES,
  type Mention,
  PDF_TYPE,
  parseSlash,
  plainText,
} from "./composer-parts";

// The message composer, after opencode desktop's (v2.1.2, MIT):
// - @ suggests subagents and skills, then files and folders matching the
//   query (the service's fuzzy search); a pick becomes an inline chip and
//   travels as a mention the service resolves.
// - / at the start of the message suggests the app's own commands, which
//   run on pick, and the service's commands (`/review …`), which send with
//   their arguments.
// - Images and PDFs pasted, dropped or picked with the clip go inline, when
//   the model reads them; like opencode, nothing else attaches.

/** opencode's prompt placeholder. */
export const PLACEHOLDER = "Ask anything, / for commands, @ for context…";

/** A command the app runs itself, such as /new. */
export interface Builtin {
  name: string;
  description: string;
  run: () => void;
}

export interface ComposerProps {
  /** The folder @ searches and mentions resolve in; null disables both. */
  directory: string | null;
  value: string;
  onChange: (value: string) => void;
  /** Send a message. Reject to have the attachments put back. */
  onSend: (text: string, parts: PromptParts) => Promise<void>;
  /** Run a service command with its argument text. */
  onCommand: (name: string, args: string, parts: PromptParts) => Promise<void>;
  builtins?: readonly Builtin[];
  /** What the current model reads besides text. */
  accepts: { image: boolean; pdf: boolean };
  placeholder: string;
  isDisabled?: boolean;
  isStopShown?: boolean;
  onStop?: () => void;
  /** An error from the page, shown under the composer. */
  error?: string | null;
  footerActions?: ReactNode;
  inputStyle?: CSSProperties;
}

interface Item
  extends SearchableItem<{
    kind: "skill" | "agent" | "file" | "folder" | "command";
    detail?: string;
    mention?: Mention;
  }> {}

// Lists that rarely change, read once per folder and app run.
const lists = new Map<
  string,
  Promise<{ agents: AgentInfo[]; skills: SkillInfo[]; commands: CommandInfo[] }>
>();

function loadLists(directory: string) {
  let pending = lists.get(directory);
  if (pending === undefined) {
    pending = Promise.all([
      ocClient.listAgents(directory),
      ocClient.listSkills(directory),
      ocClient.listCommands(directory),
    ])
      .then(([agents, skills, commands]) => ({ agents, skills, commands }))
      .catch((err: unknown) => {
        lists.delete(directory);
        throw err;
      });
    lists.set(directory, pending);
  }
  return pending;
}

const matches = (query: string, ...texts: string[]) =>
  texts.some((t) => t.toLowerCase().includes(query.toLowerCase()));

let attachmentSeq = 0;

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function Composer({
  directory,
  value,
  onChange,
  onSend,
  onCommand,
  builtins = [],
  accepts,
  placeholder,
  isDisabled,
  isStopShown,
  onStop,
  error,
  footerActions,
  inputStyle,
}: ComposerProps) {
  const handle = useRef<ChatComposerInputHandle>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  // `@…` text of each pick → what it names. Kept across sends: a mention is
  // only sent while its text is in the message.
  const mentions = useRef(new Map<string, Mention>());
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  // Read on every search, so the latest props win without new triggers.
  const live = useRef({ directory, builtins });
  live.current = { directory, builtins };

  // Warm the menus' lists for this folder, so the first @ or / has them.
  useEffect(() => {
    if (directory !== null) loadLists(directory).catch(() => {});
  }, [directory]);

  const triggers = useMemo<ChatComposerTrigger[]>(() => {
    // opencode's order: skills, then subagents, then paths.
    const named = async (query: string): Promise<Item[]> => {
      const dir = live.current.directory;
      if (dir === null) return [];
      const { agents, skills } = await loadLists(dir);
      return [
        ...skills
          .filter((s) => matches(query, s.id, s.name))
          .map((s) => ({
            id: `skill:${s.id}`,
            label: `@${s.id}`,
            auxiliaryData: {
              kind: "skill" as const,
              detail: s.description ?? "",
              mention: { kind: "skill" as const, id: s.id },
            },
          })),
        ...agents
          .filter((a) => !a.hidden && a.mode !== "primary")
          .filter((a) => matches(query, a.name))
          .map((a) => ({
            id: `agent:${a.name}`,
            label: `@${a.name}`,
            auxiliaryData: {
              kind: "agent" as const,
              detail: a.description ?? "",
              mention: { kind: "agent" as const, name: a.name },
            },
          })),
      ];
    };
    const mention: ChatComposerTrigger = {
      character: "@",
      menuLabel: "Mention",
      searchSource: {
        bootstrap: () => named(""),
        async search(query) {
          const dir = live.current.directory;
          if (dir === null) return [];
          const [first, paths] = await Promise.all([
            named(query),
            query === "" ? [] : ocClient.findFiles(dir, query, 50),
          ]);
          return [
            ...first,
            ...paths
              // The folder itself comes back as "/"; it's not a mention.
              .filter((p) => p.path.replace(/\/+$/, "") !== "")
              .map((p) => ({
                id: `file:${p.path}`,
                label: `@${p.path}`,
                auxiliaryData: {
                  kind:
                    p.type === "directory"
                      ? ("folder" as const)
                      : ("file" as const),
                  mention: { kind: "file" as const, path: p.path },
                },
              })),
          ];
        },
      },
      renderItem: (item) => <SuggestionRow item={item as Item} />,
      onSelect(item) {
        const picked = (item as Item).auxiliaryData?.mention;
        if (picked !== undefined) mentions.current.set(item.label, picked);
        // Inline colored text with the whole `@path`, as opencode shows it
        // (the neutral theme's accent is near-black, so blue).
        return {
          value: item.label,
          render: () => (
            <span style={{ color: "var(--color-text-blue)" }}>
              {item.label}
            </span>
          ),
        };
      },
    };

    // opencode opens / only while the whole message is the command name,
    // and lists the service's commands before its own.
    const atStart = () => /^\/\S*$/.test(handle.current?.getValue() ?? "");
    const commands = async (query: string): Promise<Item[]> => {
      if (!atStart()) return [];
      const dir = live.current.directory;
      const service =
        dir === null ? [] : (await loadLists(dir).catch(() => null))?.commands;
      return [
        ...(service ?? []).map((c) => ({
          id: `command:${c.name}`,
          label: `/${c.name}`,
          auxiliaryData: {
            kind: "command" as const,
            detail: c.description ?? "",
          },
        })),
        ...live.current.builtins.map((b) => ({
          id: `builtin:${b.name}`,
          label: `/${b.name}`,
          auxiliaryData: { kind: "command" as const, detail: b.description },
        })),
      ].filter((i) => matches(query, i.label.slice(1)));
    };
    const command: ChatComposerTrigger = {
      character: "/",
      menuLabel: "Commands",
      // A multi-word query that matches nothing hides the menu (core FR14),
      // so a / mid-message opens nothing, as in opencode.
      hasMultiWordQuery: true,
      searchSource: { bootstrap: () => commands(""), search: commands },
      renderItem: (item) => <SuggestionRow item={item as Item} />,
      onSelect(item) {
        const builtin = live.current.builtins.find(
          (b) => `/${b.name}` === item.label,
        );
        if (builtin === undefined) return `${item.label} `;
        builtin.run();
        return "";
      },
    };
    return [mention, command];
  }, []);

  const addFiles = async (files: readonly File[]) => {
    const skipped: string[] = [];
    const added: Attachment[] = [];
    for (const file of files) {
      const ok =
        (IMAGE_TYPES.includes(file.type) && accepts.image) ||
        (file.type === PDF_TYPE && accepts.pdf);
      if (!ok || file.size > MAX_ATTACHMENT_BYTES) {
        skipped.push(file.name);
        continue;
      }
      added.push({
        id: `attachment-${++attachmentSeq}`,
        name: file.name,
        mime: file.type,
        dataUrl: await readDataUrl(file),
      });
    }
    if (added.length > 0) setAttachments((all) => [...all, ...added]);
    setNotice(
      skipped.length === 0
        ? null
        : `Can't attach ${skipped.join(", ")}: the model reads ${
            [accepts.image && "images", accepts.pdf && "PDFs"]
              .filter(Boolean)
              .join(" and ") || "text only"
          }, up to 20 MB.`,
    );
  };

  const submit = (raw: string) => {
    const text = plainText(raw);
    if (directory === null || (text === "" && attachments.length === 0)) return;
    const slash = parseSlash(text);
    const builtin =
      slash !== null && slash.args === ""
        ? builtins.find((b) => b.name === slash.name)
        : undefined;
    if (builtin !== undefined) {
      onChange("");
      builtin.run();
      return;
    }
    const sent = attachments;
    setAttachments([]);
    setNotice(null);
    const restore = () => setAttachments((now) => [...sent, ...now]);
    void (async () => {
      // `/name` the service doesn't define is sent as a plain message.
      const service =
        slash === null
          ? []
          : await loadLists(directory)
              .then((l) => l.commands)
              .catch(() => []);
      if (slash !== null && service.some((c) => c.name === slash.name)) {
        const parts = buildParts(slash.args, mentions.current, directory, sent);
        await onCommand(slash.name, slash.args, parts).catch(restore);
        return;
      }
      const parts = buildParts(text, mentions.current, directory, sent);
      await onSend(text, parts).catch(restore);
    })();
  };

  const status: ChatComposerStatus | undefined = error
    ? { type: "error", message: error }
    : notice
      ? { type: "warning", message: notice }
      : undefined;

  const canAttach = accepts.image || accepts.pdf;

  return (
    <>
      <ChatComposer
        // Flat: a border, no shadow.
        elevation="none"
        onSubmit={submit}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        {...(isDisabled !== undefined ? { isDisabled } : {})}
        {...(isStopShown !== undefined ? { isStopShown } : {})}
        {...(onStop !== undefined ? { onStop } : {})}
        {...(status !== undefined ? { status } : {})}
        drawer={
          attachments.length > 0 ? (
            <ChatComposerDrawer count={attachments.length} label="Attachments">
              <div className="flex flex-wrap gap-2">
                {attachments.map((a) => (
                  <Thumbnail
                    key={a.id}
                    {...(a.mime.startsWith("image/") ? { src: a.dataUrl } : {})}
                    alt={a.name}
                    label={a.name}
                    showRemoveOn="hover"
                    onRemove={() =>
                      setAttachments((all) => all.filter((x) => x !== a))
                    }
                  />
                ))}
              </div>
            </ChatComposerDrawer>
          ) : undefined
        }
        footerActions={
          <>
            <Button
              label={canAttach ? "Add images or PDFs" : "Model reads text only"}
              tooltip={
                canAttach ? "Add images or PDFs" : "This model reads text only"
              }
              variant="ghost"
              size="sm"
              isIconOnly
              isDisabled={!canAttach || isDisabled === true}
              icon={<Icon icon={PlusIcon} size="sm" />}
              onClick={() => fileInput.current?.click()}
            />
            {footerActions}
          </>
        }
        input={
          <ChatComposerInput
            handleRef={handle}
            triggers={triggers}
            onFiles={(files) => void addFiles(files)}
            {...(inputStyle !== undefined ? { style: inputStyle } : {})}
          />
        }
      />
      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        accept={[
          ...(accepts.image ? IMAGE_TYPES : []),
          ...(accepts.pdf ? [PDF_TYPE] : []),
        ].join(",")}
        onChange={(e) => {
          void addFiles([...(e.target.files ?? [])]);
          e.target.value = "";
        }}
      />
    </>
  );
}

const ROW_ICON = {
  skill: SparklesIcon,
  agent: CircleUserIcon,
  file: FileIcon,
  folder: FolderIcon,
};

/** A menu row as opencode lays it out: name, then the description. Paths
 *  drop the @ the inserted text carries. */
function SuggestionRow({ item }: { item: Item }) {
  const data = item.auxiliaryData;
  const kind = data?.kind ?? "command";
  const isPath = kind === "file" || kind === "folder";
  return (
    <span className="flex min-w-0 items-center gap-2">
      {kind !== "command" && (
        <Icon icon={ROW_ICON[kind]} size="sm" color="secondary" />
      )}
      <span className={`shrink-0 ${isPath ? "" : "font-medium"}`}>
        {isPath ? item.label.slice(1) : item.label}
      </span>
      {data?.detail !== undefined && data.detail !== "" && (
        <Text size="sm" color="secondary" maxLines={1}>
          {data.detail}
        </Text>
      )}
    </span>
  );
}
