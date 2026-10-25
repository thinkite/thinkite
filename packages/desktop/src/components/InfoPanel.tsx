import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { ProgressBar } from "@astryxdesign/core/ProgressBar";
import { Text } from "@astryxdesign/core/Text";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSelector } from "@tanstack/react-store";
import {
  contextTokens,
  costWithin,
  descendantsOf,
  type FileDiffInfo,
  formatModelRef,
  lastAssistantWithUsage,
  type SessionInfo,
  type VcsInfo,
} from "@thinkite/oc-client";
import { useMessages } from "@thinkite/oc-client/react";
import type { PreviewEntry } from "@thinkite/protocol";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FileDiffIcon,
  FolderIcon,
  GitBranchIcon,
  SquareIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { ocClient, ocStore } from "../lib/oc";
import { prefs, updatePrefs } from "../lib/prefs";
import { isLive, previewUrl, stopPreview, usePreviews } from "../lib/previews";
import { vcsKeys } from "../lib/query";
import { findModel, useModels } from "./ModelPicker";

// The session panel's default view, after Claude Code's: a column of small
// cards that each sum up one thing in a line and open in place for more —
// where the session runs, how full its context is, what it changed (a
// click on that opens the diff), and the servers the agent started in the
// folder. Which cards are open is a client pref.

type CardID = "environment" | "context" | "changes" | "servers";

const compact = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const usd = new Intl.NumberFormat("en", {
  style: "currency",
  currency: "USD",
});
/** Dollars, with an amount under a cent (but not none) shown as such
 *  rather than $0.00. */
const dollars = (n: number) => (n > 0 && n < 0.01 ? "<$0.01" : usd.format(n));

/**
 * What the session cost, its subagents' sessions included, and whether it
 * has any. opencode keeps each session's cost on its own row, so the rows
 * below this one are read once (lib/query); the bus adds new subagents and
 * keeps every row's cost current from then on.
 */
function useCost(sessionID: string) {
  useQuery({
    queryKey: ["session", sessionID, "descendants"],
    queryFn: () => ocStore.loadDescendants(sessionID),
    staleTime: Number.POSITIVE_INFINITY,
  });
  return useSelector(
    ocStore.session.info,
    (all) => ({
      total: costWithin(sessionID, all),
      hasSubagents: descendantsOf(sessionID, all).length > 0,
    }),
    {
      compare: (a, b) =>
        a.total === b.total && a.hasSubagents === b.hasSubagents,
    },
  );
}

function InfoCard({
  id,
  title,
  summary,
  children,
}: {
  id: CardID;
  title: string;
  /** Shown beside the title while the card is closed. */
  summary?: ReactNode;
  children: ReactNode;
}) {
  const isOpen = useSelector(prefs, (p) => !p.infoPanel.closed.includes(id));
  const toggle = () =>
    updatePrefs((p) => ({
      ...p,
      infoPanel: {
        closed: isOpen
          ? [...p.infoPanel.closed, id]
          : p.infoPanel.closed.filter((c) => c !== id),
      },
    }));
  return (
    <section className="flex flex-col gap-2 rounded-lg border border-[var(--color-border)] px-3 py-2.5">
      <button
        type="button"
        className="flex min-h-6 items-center gap-1 text-left"
        aria-expanded={isOpen}
        onClick={toggle}
      >
        <Text size="sm" weight="medium">
          {title}
        </Text>
        <Icon
          icon={isOpen ? ChevronDownIcon : ChevronRightIcon}
          size="xsm"
          color="secondary"
        />
        {!isOpen && summary !== undefined ? (
          <span className="ml-auto flex items-center gap-2">{summary}</span>
        ) : null}
      </button>
      {isOpen ? children : null}
    </section>
  );
}

function Row({
  icon,
  children,
  title,
}: {
  icon: typeof FolderIcon;
  children: ReactNode;
  title?: string;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2" title={title}>
      <Icon icon={icon} size="sm" color="secondary" />
      <Text size="sm" maxLines={1}>
        {children}
      </Text>
    </div>
  );
}

/** `git rev-parse --abbrev-ref` says `heads/x` when a tag is also named x. */
const branchName = (vcs: VcsInfo | null) =>
  vcs?.branch.current?.replace(/^heads\//, "");

function Environment({
  directory,
  vcs,
}: {
  directory: string;
  vcs: VcsInfo | null;
}) {
  const branch = branchName(vcs);
  return (
    <InfoCard id="environment" title="Environment">
      <div className="flex flex-col gap-1.5">
        <Row icon={FolderIcon} title={directory}>
          {directory.split("/").filter(Boolean).at(-1) ?? directory}
        </Row>
        {branch !== undefined ? <Row icon={GitBranchIcon}>{branch}</Row> : null}
      </div>
    </InfoCard>
  );
}

function Context({ session }: { session: SessionInfo }) {
  const rows = useMessages(ocStore, session.id);
  const models = useModels();
  const cost = useCost(session.id);
  const last = lastAssistantWithUsage(rows, session.revert);
  const model = last
    ? findModel(models, formatModelRef(last.model.providerID, last.model.id))
    : undefined;
  const used = last ? contextTokens(last.tokens) : 0;
  const limit = model?.limit.context;
  const percent =
    limit !== undefined && limit > 0
      ? Math.min(100, Math.round((used / limit) * 100))
      : null;

  const bar = (isWide: boolean) =>
    percent !== null ? (
      <span className={isWide ? "block" : "block w-12"}>
        <ProgressBar
          label="Context used"
          isLabelHidden
          value={percent}
          max={100}
        />
      </span>
    ) : null;

  const breakdown: [string, number][] = last
    ? [
        ["Input", last.tokens.input],
        ["Cache read", last.tokens.cache.read],
        ["Cache write", last.tokens.cache.write],
        ["Output", last.tokens.output],
        ["Reasoning", last.tokens.reasoning],
      ]
    : [];

  return (
    <InfoCard
      id="context"
      title="Context"
      summary={
        last ? (
          <>
            <Text size="sm" color="secondary">
              {percent !== null ? `${percent}%` : compact.format(used)}
            </Text>
            {bar(false)}
          </>
        ) : undefined
      }
    >
      {last ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between gap-2">
            <Text size="sm">
              {percent !== null ? `${percent}% used` : "Used"}
            </Text>
            <Text size="sm" color="secondary">
              {limit !== undefined
                ? `${compact.format(used)} / ${compact.format(limit)}`
                : compact.format(used)}
            </Text>
          </div>
          {bar(true)}
          <div className="flex flex-col gap-1">
            {breakdown.map(([label, value]) => (
              <div key={label} className="flex justify-between gap-2">
                <Text size="sm" color="secondary">
                  {label}
                </Text>
                <Text size="sm">{compact.format(value)}</Text>
              </div>
            ))}
            {/* Shown at $0.00 too (a free model, a subscription): a missing
                line reads as unknown, not as nothing spent. */}
            <div className="flex justify-between gap-2 border-t border-[var(--color-border)] pt-1">
              <Text size="sm" color="secondary">
                {cost.hasSubagents
                  ? "Session cost, incl. subagents"
                  : "Session cost"}
              </Text>
              <Text size="sm">{dollars(cost.total)}</Text>
            </div>
          </div>
        </div>
      ) : (
        <Text size="sm" color="secondary">
          No replies yet
        </Text>
      )}
    </InfoCard>
  );
}

function Changes({
  vcs,
  status,
  onOpenDiff,
}: {
  vcs: VcsInfo | null;
  status: FileDiffInfo[] | null;
  onOpenDiff: () => void;
}) {
  const added = status?.reduce((n, f) => n + f.additions, 0) ?? 0;
  const deleted = status?.reduce((n, f) => n + f.deletions, 0) ?? 0;
  const files = status?.length ?? 0;
  return (
    <InfoCard id="changes" title="Changes">
      {vcs !== null && vcs.provider === undefined ? (
        <Text size="sm" color="secondary">
          Not a git repository
        </Text>
      ) : status === null ? (
        <Text size="sm" color="secondary">
          Loading…
        </Text>
      ) : files === 0 ? (
        <Text size="sm" color="secondary">
          No changes on this branch
        </Text>
      ) : (
        <button
          type="button"
          className="-mx-1.5 flex items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-[var(--color-background-secondary)]"
          aria-label="Open the diff"
          onClick={onOpenDiff}
        >
          <Icon icon={FileDiffIcon} size="sm" color="secondary" />
          <span className="text-[var(--color-text-green)]">
            <Text
              size="sm"
              color="inherit"
            >{`+${added.toLocaleString("en")}`}</Text>
          </span>
          <span className="text-[var(--color-text-red)]">
            <Text
              size="sm"
              color="inherit"
            >{`−${deleted.toLocaleString("en")}`}</Text>
          </span>
          <span className="ml-auto">
            <Text size="sm" color="secondary">
              {files === 1 ? "1 file" : `${files} files`}
            </Text>
          </span>
        </button>
      )}
    </InfoCard>
  );
}

/** One server's state in a word or two. */
function serverState(e: PreviewEntry): string {
  switch (e.status) {
    case "starting":
      return "Starting";
    case "running":
      return e.ports.length === 0 ? "No port" : (e.kind ?? "Running");
    case "exited":
      return e.exit === undefined ? "Exited" : `Exited (${e.exit})`;
    default:
      return "Stopped";
  }
}

function ServerRow({
  directory,
  entry,
  onOpenPage,
}: {
  directory: string;
  entry: PreviewEntry;
  onOpenPage: (url: string) => void;
}) {
  const [isStopping, setStopping] = useState(false);
  const live = isLive(entry);
  const port = entry.primaryPort ?? entry.ports[0];
  const dot = !live
    ? "bg-[var(--color-text-secondary)]"
    : entry.status === "running" && port !== undefined
      ? "bg-[var(--color-text-green)]"
      : "bg-[var(--color-text-yellow)]";
  return (
    <div
      className="flex min-h-7 min-w-0 items-center gap-2"
      title={entry.command}
    >
      <span className={`size-1.5 shrink-0 rounded-full ${dot}`} />
      <Text size="sm" maxLines={1}>
        {entry.name}
      </Text>
      {live && port !== undefined ? (
        <button
          type="button"
          className="rounded px-1 font-mono text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-background-secondary)] hover:text-[var(--color-text-primary)]"
          aria-label={`Open ${entry.name} in the browser`}
          onClick={() => onOpenPage(previewUrl(entry))}
        >
          {`:${port}`}
        </button>
      ) : null}
      <span className="ml-auto flex shrink-0 items-center gap-1">
        <Text size="sm" color="secondary">
          {serverState(entry)}
        </Text>
        {live ? (
          <Button
            label={`Stop ${entry.name}`}
            tooltip="Stop"
            icon={<Icon icon={SquareIcon} size="xsm" />}
            isIconOnly
            variant="ghost"
            size="sm"
            isDisabled={isStopping}
            onClick={() => {
              setStopping(true);
              stopPreview(directory, entry.name)
                .catch(() => undefined)
                .finally(() => setStopping(false));
            }}
          />
        ) : null}
      </span>
    </div>
  );
}

/** The servers the agent started in the folder (lib/previews); hidden
 *  while there are none. */
function Servers({
  directory,
  onOpenPage,
}: {
  directory: string;
  onOpenPage: (url: string) => void;
}) {
  const entries = usePreviews(directory);
  if (entries.length === 0) return null;
  const live = entries.filter(isLive).length;
  return (
    <InfoCard
      id="servers"
      title="Servers"
      summary={
        <Text size="sm" color="secondary">
          {live > 0 ? `${live} running` : "None running"}
        </Text>
      }
    >
      <div className="flex flex-col">
        {entries.map((e) => (
          <ServerRow
            key={e.name}
            directory={directory}
            entry={e}
            onOpenPage={onOpenPage}
          />
        ))}
      </div>
    </InfoCard>
  );
}

/**
 * The repository state of `directory`, cached per folder (lib/query), so
 * the panel of another session in it — a subagent's, say — opens with it.
 * Read again on mount, when the window comes back to the front, when a
 * turn ends, and whenever the daemon's git watcher sees the folder change
 * (lib/git-events, wired by the session screen): opencode pushes no event
 * for file changes.
 */
function useVcs(directory: string, isRunning: boolean) {
  const queryClient = useQueryClient();
  const vcs = useQuery({
    queryKey: vcsKeys.info(directory),
    queryFn: () => ocClient.vcs(directory),
  });
  // The diff panel's view, counted: the whole branch. No context lines, as
  // only the counts are read.
  const status = useQuery({
    queryKey: vcsKeys.diff(directory, 0),
    queryFn: () => ocClient.vcsDiff(directory, "branch", 0),
  });
  const wasRunning = useRef(isRunning);
  useEffect(() => {
    if (wasRunning.current && !isRunning)
      void queryClient.invalidateQueries({ queryKey: vcsKeys.all(directory) });
    wasRunning.current = isRunning;
  }, [queryClient, directory, isRunning]);
  return { vcs: vcs.data ?? null, status: status.data ?? null };
}

export function InfoPanel({
  session,
  isRunning,
  onOpenDiff,
  onOpenPage,
}: {
  session: SessionInfo;
  isRunning: boolean;
  onOpenDiff: () => void;
  /** Show a page in the session's browser. */
  onOpenPage: (url: string) => void;
}) {
  const directory = session.location.directory;
  const { vcs, status } = useVcs(directory, isRunning);
  return (
    <div className="flex h-full min-h-0 flex-col gap-2 overflow-y-auto p-3">
      <Environment directory={directory} vcs={vcs} />
      <Context session={session} />
      <Changes vcs={vcs} status={status} onOpenDiff={onOpenDiff} />
      <Servers directory={directory} onOpenPage={onOpenPage} />
    </div>
  );
}
