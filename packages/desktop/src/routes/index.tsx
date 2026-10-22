import { ChatComposer, ChatComposerInput } from "@astryxdesign/core/Chat";
import { Icon } from "@astryxdesign/core/Icon";
import { Selector } from "@astryxdesign/core/Selector";
import { Text } from "@astryxdesign/core/Text";
import { FolderIcon, SparklesIcon } from "@heroicons/react/24/outline";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { parseModelRef, type SessionInfo } from "@thinkite/oc-client";
import { useSessions } from "@thinkite/oc-client/react";
import { useMemo, useState } from "react";
import { ModelPicker, useDefaultModel } from "../components/ModelPicker";
import { ocStore } from "../lib/oc";

// The new-session draft. The words are wisp's (after Waku's New task):
// "What should we build in <folder>?", where the folder name is the picker —
// recent folders from the session list, or open another one. The layout is
// DeepSeek Harness's empty state: one centred stack with the composer in
// it. Nothing exists on the service until the first prompt: sending creates
// the session there, shows the prompt at once and opens the session.
export const Route = createFileRoute("/")({
  component: NewSession,
});

const LAST_DIR_KEY = "thinkite:last-directory";
const OPEN_FOLDER = "__open-folder__";
const MAX_RECENT = 8;

function loadLastDir(): string | null {
  try {
    return localStorage.getItem(LAST_DIR_KEY);
  } catch {
    return null;
  }
}

function saveLastDir(dir: string): void {
  try {
    localStorage.setItem(LAST_DIR_KEY, dir);
  } catch {
    // Private mode — the picker still works, just not remembered.
  }
}

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || trimmed;
}

/** Where a folder lives, short enough for a menu hint. */
function shortParent(path: string): string {
  const parent = path.slice(0, path.lastIndexOf("/")) || "/";
  return parent.length <= 32 ? parent : `…${parent.slice(-31)}`;
}

function recentDirectories(
  sessions: readonly SessionInfo[],
  current: string | null,
): string[] {
  const out: string[] = current ? [current] : [];
  for (const s of sessions) {
    if (out.length >= MAX_RECENT) break;
    if (!out.includes(s.location.directory)) out.push(s.location.directory);
  }
  return out;
}

interface PickResponse {
  canceled: boolean;
  path?: string;
}

function NewSession() {
  const navigate = useNavigate();
  const sessions = useSessions(ocStore);
  const [picked, setPicked] = useState<string | null>(loadLastDir);
  // No pick yet: the folder of the most recent session.
  const directory = picked ?? sessions[0]?.location.directory ?? null;
  const recent = useMemo(
    () => recentDirectories(sessions, directory),
    [sessions, directory],
  );
  const [model, setModel] = useState<string | null>(null);
  const defaultModel = useDefaultModel(directory);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pick = (dir: string) => {
    setPicked(dir);
    saveLastDir(dir);
  };

  const openFolder = async () => {
    setError(null);
    try {
      const res = await fetch("/api/pick-directory");
      if (!res.ok) throw new Error(`picker: ${res.status}`);
      const result = (await res.json()) as PickResponse;
      if (!result.canceled && result.path !== undefined) pick(result.path);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const submit = (value: string) => {
    const text = value.trim();
    if (text === "" || directory === null || busy) return;
    setBusy(true);
    setError(null);
    saveLastDir(directory);
    void (async () => {
      try {
        const session = await ocStore.createSession({
          directory,
          // No pick = the store pins the folder's default model.
          ...(model !== null ? { model: parseModelRef(model) } : {}),
        });
        // Not awaited: a failed first prompt still leaves a valid (empty)
        // session behind to type into.
        ocStore.prompt(session.id, text).catch((err: unknown) => {
          console.warn("[new-session] first prompt failed:", err);
        });
        await navigate({
          to: "/session/$sessionId",
          params: { sessionId: session.id },
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setBusy(false);
      }
    })();
  };

  const composer = (
    <ChatComposer
      onSubmit={submit}
      value={draft}
      onChange={setDraft}
      placeholder={busy ? "Creating session…" : "Ask anything…"}
      isDisabled={busy || directory === null}
      status={error ? { type: "error", message: error } : undefined}
      footerActions={
        <ModelPicker value={model ?? defaultModel} onChange={setModel} />
      }
      input={<ChatComposerInput style={{ minHeight: 52 }} />}
    />
  );

  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center gap-5 px-6 pb-16">
      <Icon icon={SparklesIcon} size="md" color="accent" />
      {directory === null ? (
        <div className="flex flex-col items-center gap-3">
          <Text size="xl" weight="medium">
            Open a project folder to begin
          </Text>
          <Selector
            label="Project folder"
            isLabelHidden
            placeholder="Open folder…"
            options={[{ value: OPEN_FOLDER, label: "Open folder…" }]}
            onChange={() => void openFolder()}
          />
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Text size="xl" weight="medium">
            What should we build in
          </Text>
          <Selector
            label="Project folder"
            isLabelHidden
            variant="secondary"
            startIcon={FolderIcon}
            value={directory}
            options={[
              ...recent.map((d) => ({
                value: d,
                label: basename(d),
                description: shortParent(d),
              })),
              { type: "divider" as const },
              { value: OPEN_FOLDER, label: "Open folder…" },
            ]}
            renderValue={(option) => option.label}
            onChange={(next) =>
              next === OPEN_FOLDER ? void openFolder() : pick(next)
            }
          />
          <Text size="xl" weight="medium">
            ?
          </Text>
        </div>
      )}
      <div className="composer-col">{composer}</div>
    </div>
  );
}
