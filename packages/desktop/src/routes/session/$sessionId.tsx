import { useState } from "react";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { Heading } from "@astryxdesign/core/Heading";
import { Tab, TabList } from "@astryxdesign/core/TabList";
import { Text } from "@astryxdesign/core/Text";
import { DiffPanel } from "../../components/DiffPanel";
import { TerminalPane } from "../../components/TerminalPane";
import { TranscriptPanel } from "../../components/TranscriptPanel";

interface SessionRow {
  id: string;
  cwd: string;
  name: string;
}

// Session screen: header + terminal / working-tree diff tabs. The session
// record (cwd) comes from the server store; a stale link (deleted session)
// bounces back to the list.
export const Route = createFileRoute("/session/$sessionId")({
  loader: async ({ params }) => {
    const rows = (await (await fetch("/api/sessions")).json()) as SessionRow[];
    const session = rows.find((s) => s.id === params.sessionId);
    if (!session) throw redirect({ to: "/" });
    return session;
  },
  component: Session,
});

function Session() {
  const session = Route.useLoaderData();
  const [tab, setTab] = useState("terminal");
  // Mount Diff/Transcript on first visit, keep them mounted after (preserves
  // scroll position; refetch-on-activation is each panel's own concern). The
  // terminal stays mounted always — unmounting would drop the xterm buffer
  // and re-replay the scrollback ring on every tab switch.
  const [visited, setVisited] = useState<Record<string, boolean>>({});

  return (
    <div className="flex h-screen flex-col">
      <div className="flex items-center gap-4 border-b px-4 py-2">
        <Link to="/">← Sessions</Link>
        <div className="flex min-w-0 items-baseline gap-3">
          <Heading level={5}>{session.name}</Heading>
          <Text size="sm" color="secondary" maxLines={1}>
            {session.cwd}
          </Text>
        </div>
        <div className="ml-auto">
          <TabList
            value={tab}
            size="sm"
            onChange={(v) => {
              setTab(v);
              setVisited((prev) => ({ ...prev, [v]: true }));
            }}
          >
            <Tab value="terminal" label="Terminal" />
            <Tab value="transcript" label="Transcript" />
            <Tab value="diff" label="Diff" />
          </TabList>
        </div>
      </div>
      <div className={tab === "terminal" ? "min-h-0 flex-1 p-2" : "hidden"}>
        <TerminalPane sessionId={session.id} />
      </div>
      {visited.transcript || tab === "transcript" ? (
        <div className={tab === "transcript" ? "min-h-0 flex-1" : "hidden"}>
          <TranscriptPanel active={tab === "transcript"} dir={session.cwd} />
        </div>
      ) : null}
      {visited.diff || tab === "diff" ? (
        <div className={tab === "diff" ? "min-h-0 flex-1" : "hidden"}>
          <DiffPanel active={tab === "diff"} dir={session.cwd} />
        </div>
      ) : null}
    </div>
  );
}
