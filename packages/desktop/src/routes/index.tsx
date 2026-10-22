import { Button } from "@astryxdesign/core/Button";
import { ChatComposer, ChatComposerInput } from "@astryxdesign/core/Chat";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { FolderOpenIcon, SparklesIcon } from "@heroicons/react/24/outline";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { ocStore } from "../lib/oc";

// New-session landing (astryx ai-chat-landing template, simplified):
// greeting + directory row + composer. Submit creates the opencode
// session (`location.directory`, default model/agent), shows the first
// prompt optimistically, and navigates to `/session/<ses_id>`. The last
// picked directory persists in localStorage.
export const Route = createFileRoute("/")({
  component: NewSession,
});

const LAST_DIR_KEY = "sidecode:last-directory";

function loadLastDir(): string {
  try {
    return localStorage.getItem(LAST_DIR_KEY) ?? "";
  } catch {
    return "";
  }
}

interface PickResponse {
  canceled: boolean;
  path?: string;
}

function NewSession() {
  const navigate = useNavigate();
  const [directory, setDirectory] = useState(loadLastDir);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pickDirectory = async () => {
    setError(null);
    try {
      const res = await fetch("/api/pick-directory");
      if (!res.ok) throw new Error(`picker: ${res.status}`);
      const picked = (await res.json()) as PickResponse;
      if (!picked.canceled && picked.path !== undefined) {
        setDirectory(picked.path);
        try {
          localStorage.setItem(LAST_DIR_KEY, picked.path);
        } catch {
          // Private mode — the picker still works, just not remembered.
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const submit = (value: string) => {
    const text = value.trim();
    if (text === "" || directory.trim() === "" || busy) return;
    setBusy(true);
    setError(null);
    const dir = directory.trim();
    try {
      localStorage.setItem(LAST_DIR_KEY, dir);
    } catch {
      // Ignore (see above).
    }
    void (async () => {
      try {
        const session = await ocStore.createSession({ directory: dir });
        // Not awaited: a failed first prompt still leaves a valid (empty)
        // session behind to type into.
        ocStore.prompt(session.id, text).catch((err: unknown) => {
          console.warn("[landing] first prompt failed:", err);
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

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col justify-center gap-8 px-8 py-12">
      {/* Greeting */}
      <VStack gap={1}>
        <HStack gap={2} vAlign="center">
          <Icon icon={SparklesIcon} size="md" color="accent" />
          <Text type="large" as="h2">
            New session
          </Text>
        </HStack>
        <Text type="display-2" as="h1">
          Where should we start?
        </Text>
      </VStack>

      {/* Working directory */}
      <VStack gap={2}>
        <HStack gap={2} vAlign="center">
          <div className="min-w-0 flex-1">
            <TextInput
              label="Working directory"
              placeholder="/path/to/project"
              size="md"
              value={directory}
              onChange={setDirectory}
            />
          </div>
          <Button
            label="Browse"
            variant="secondary"
            size="md"
            icon={<FolderOpenIcon />}
            onClick={() => void pickDirectory()}
          />
        </HStack>

        <ChatComposer
          onSubmit={submit}
          placeholder={
            busy
              ? "Creating session…"
              : directory.trim() === ""
                ? "Pick a directory first"
                : "Ask anything"
          }
          input={<ChatComposerInput style={{ minHeight: 84 }} />}
          value={draft}
          onChange={setDraft}
          isDisabled={busy || directory.trim() === ""}
          status={error ? { type: "error", message: error } : undefined}
        />
        <Text size="sm" color="secondary">
          {busy
            ? "Creating the opencode session…"
            : "Creates an opencode session in the directory above and sends your first prompt."}
        </Text>
      </VStack>
    </div>
  );
}
