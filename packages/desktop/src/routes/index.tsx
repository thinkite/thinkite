import { Icon } from "@astryxdesign/core/Icon";
import { Selector } from "@astryxdesign/core/Selector";
import { Text } from "@astryxdesign/core/Text";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useSelector } from "@tanstack/react-store";
import {
  type PromptParts,
  parseModelRef,
  type SessionInfo,
} from "@thinkite/oc-client";
import { useLastUsedModel, useSessions } from "@thinkite/oc-client/react";
import { FolderIcon, SparklesIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { Composer, PLACEHOLDER } from "../components/Composer";
import {
  findModel,
  inputsOf,
  ModelPicker,
  useDefaultModel,
  useModels,
  VariantPicker,
} from "../components/ModelPicker";
import { ocStore } from "../lib/oc";
import { usePreviews } from "../lib/previews";

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
  const [pickedDir, setPickedDir] = useState<string | null>(loadLastDir);
  // No pick yet: the folder of the most recent session.
  const directory = pickedDir ?? sessions[0]?.location.directory ?? null;
  const recent = useMemo(
    () => recentDirectories(sessions, directory),
    [sessions, directory],
  );
  // Watching the folder's servers is what makes the daemon serve its tools
  // there; opencode fixes the first turn's tools when the prompt lands.
  usePreviews(directory);
  // No pick: the last used model and its reasoning variant, else the
  // folder's default — what the store will pin on create.
  const [picked, setPicked] = useState<{
    model: string;
    variant: string;
  } | null>(null);
  const lastUsed = useLastUsedModel(ocStore);
  const lastVariant = useSelector(ocStore.lastUsedModel, (m) => m?.variant);
  const defaultModel = useDefaultModel(lastUsed === null ? directory : null);
  const model = picked?.model ?? lastUsed ?? defaultModel;
  const variant =
    picked?.variant ??
    (lastUsed !== null ? (lastVariant ?? "default") : "default");
  const modelInfo = findModel(useModels(), model);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pick = (dir: string) => {
    setPickedDir(dir);
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

  // Sending creates the session first; a service command then runs in it.
  const start = (
    first: (sessionID: string) => Promise<unknown>,
  ): Promise<void> => {
    if (directory === null || busy) return Promise.resolve();
    setBusy(true);
    setError(null);
    saveLastDir(directory);
    return (async () => {
      try {
        const session = await ocStore.createSession({
          directory,
          // No pick = the store pins the last used or default model.
          ...(picked !== null
            ? {
                model: {
                  ...parseModelRef(picked.model),
                  ...(picked.variant !== "default"
                    ? { variant: picked.variant }
                    : {}),
                },
              }
            : {}),
        });
        // Not awaited: a failed first prompt still leaves a valid (empty)
        // session behind to type into.
        first(session.id).catch((err: unknown) => {
          console.warn("[new-session] first prompt failed:", err);
        });
        await navigate({
          to: "/session/$sessionId",
          params: { sessionId: session.id },
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setBusy(false);
        throw err;
      }
    })();
  };

  const composer = (
    <Composer
      directory={directory}
      value={draft}
      onChange={setDraft}
      onSend={(text: string, parts: PromptParts) =>
        start((id) => ocStore.prompt(id, text, parts))
      }
      onCommand={(name, args, parts) =>
        start((id) => ocStore.command(id, name, args, parts))
      }
      accepts={inputsOf(modelInfo)}
      placeholder={busy ? "Creating session…" : PLACEHOLDER}
      isDisabled={busy || directory === null}
      error={error}
      inputStyle={{ minHeight: 52 }}
      footerActions={
        <>
          <ModelPicker
            value={model}
            onChange={(m) => setPicked({ model: m, variant: "default" })}
          />
          <VariantPicker
            model={modelInfo}
            value={variant}
            onChange={(v) => {
              if (model !== null) setPicked({ model, variant: v });
            }}
          />
        </>
      }
    />
  );

  return (
    <div className="relative flex h-full min-h-0 flex-col items-center justify-center gap-5 px-6 pb-16">
      {/* The window's top row here: no title, but it still drags. */}
      <div className="absolute inset-x-0 top-0 h-12" data-window-drag />
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
