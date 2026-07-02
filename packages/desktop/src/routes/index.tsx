import { useCallback, useEffect, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Timestamp } from "@astryxdesign/core/Timestamp";

// Session list (standalone mode): sessions are cwd bookmarks stored by our
// Deno server (~/.sidecode/desktop/sessions.json); "New session" candidates
// are the cwds of the daemon's Claude sessions (read-only) — the projects
// this user actually works in. Flat, newest-activity-first (iOS parity).
export const Route = createFileRoute("/")({
  component: Home,
});

interface SessionRow {
  id: string;
  cwd: string;
  name: string;
  createdAt: number;
  lastActivityAt: number;
  live: boolean;
}

interface ProjectCandidate {
  cwd: string;
  lastActivityAt: number;
}

function Home() {
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [projects, setProjects] = useState<ProjectCandidate[]>([]);
  const [customPath, setCustomPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      const [s, p] = await Promise.all([
        fetch("/api/sessions").then((r) => r.json()),
        fetch("/api/projects").then((r) => r.json()),
      ]);
      setSessions(s as SessionRow[]);
      setProjects(p as ProjectCandidate[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const create = async (cwd: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwd }),
      });
      if (!res.ok) throw new Error(await res.text());
      const s = (await res.json()) as SessionRow;
      void navigate({
        to: "/session/$sessionId",
        params: { sessionId: s.id },
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    await fetch(`/api/sessions/${id}`, { method: "DELETE" });
    void reload();
  };

  // Don't re-offer cwds that already have a session.
  const sessionCwds = new Set((sessions ?? []).map((s) => s.cwd));
  const candidates = projects.filter((p) => !sessionCwds.has(p.cwd)).slice(0, 6);

  return (
    <div className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 p-8">
      <Heading level={2}>Sessions</Heading>

      {error ? (
        <Text size="sm" className="text-red-600">
          {error}
        </Text>
      ) : null}

      {sessions === null ? (
        <Text>Loading…</Text>
      ) : sessions.length === 0 ? (
        <Text color="secondary">No sessions yet — pick a project below.</Text>
      ) : (
        <div className="flex flex-col gap-2">
          {sessions.map((s) => (
            <Card key={s.id}>
              <div className="flex items-center gap-3 p-3">
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${s.live ? "bg-green-500" : "bg-neutral-300"}`}
                  title={s.live ? "shell running" : "idle"}
                />
                <button
                  type="button"
                  className="flex min-w-0 flex-1 cursor-pointer flex-col items-start gap-0.5 text-left"
                  onClick={() =>
                    void navigate({
                      to: "/session/$sessionId",
                      params: { sessionId: s.id },
                    })
                  }
                >
                  <Text weight="medium">{s.name}</Text>
                  <Text size="sm" color="secondary" maxLines={1}>
                    {s.cwd}
                  </Text>
                </button>
                <Text size="sm" color="secondary">
                  <Timestamp
                    value={new Date(s.lastActivityAt).toISOString()}
                    format="relative"
                  />
                </Text>
                <Button
                  label="Delete"
                  size="sm"
                  variant="ghost"
                  onClick={() => void remove(s.id)}
                />
              </div>
            </Card>
          ))}
        </div>
      )}

      <div className="flex flex-col gap-3">
        <Heading level={5}>New session</Heading>
        {candidates.length > 0 ? (
          <div className="flex flex-col gap-1">
            {candidates.map((p) => (
              <button
                key={p.cwd}
                type="button"
                disabled={busy}
                className="cursor-pointer rounded-md px-3 py-2 text-left hover:bg-black/5"
                onClick={() => void create(p.cwd)}
              >
                <Text weight="medium">
                  {p.cwd.split("/").filter(Boolean).at(-1)}
                </Text>
                <Text size="sm" color="secondary" maxLines={1}>
                  {p.cwd}
                </Text>
              </button>
            ))}
          </div>
        ) : (
          <Text size="sm" color="secondary">
            No recent projects found — enter a directory below.
          </Text>
        )}
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (customPath.trim()) void create(customPath.trim());
          }}
        >
          <div className="flex-1">
            <TextInput
              label="Directory"
              placeholder="/path/to/project"
              value={customPath}
              onChange={(v) => setCustomPath(v)}
            />
          </div>
          <Button
            label="Open"
            type="submit"
            isDisabled={busy || customPath.trim().length === 0}
          />
        </form>
      </div>
    </div>
  );
}
