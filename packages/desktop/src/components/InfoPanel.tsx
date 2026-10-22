import { Icon } from "@astryxdesign/core/Icon";
import { ProgressBar } from "@astryxdesign/core/ProgressBar";
import { Text } from "@astryxdesign/core/Text";
import { useSelector } from "@tanstack/react-store";
import {
  contextTokens,
  formatModelRef,
  lastAssistantWithUsage,
  type SessionInfo,
  type VcsFileStatus,
  type VcsInfo,
} from "@thinkite/oc-client";
import { useMessages } from "@thinkite/oc-client/react";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FileDiffIcon,
  FolderIcon,
  GitBranchIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { ocClient, ocStore } from "../lib/oc";
import { prefs, updatePrefs } from "../lib/prefs";
import { findModel, useModels } from "./ModelPicker";

// The session panel's default view, after Claude Code's: a column of small
// cards that each sum up one thing in a line and open in place for more —
// where the session runs, how full its context is, and what it changed
// (a click on that opens the diff). Which cards are open is a client pref.

type CardID = "environment" | "context" | "changes";

const compact = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const usd = new Intl.NumberFormat("en", {
  style: "currency",
  currency: "USD",
});

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
            {session.cost > 0 ? (
              <div className="flex justify-between gap-2 border-t border-[var(--color-border)] pt-1">
                <Text size="sm" color="secondary">
                  Session cost
                </Text>
                <Text size="sm">{usd.format(session.cost)}</Text>
              </div>
            ) : null}
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
  status: VcsFileStatus[] | null;
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
          No uncommitted changes
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

/**
 * The repository state of `directory`, read again when a turn ends (the
 * agent may have edited files or switched branch) and when the window
 * comes back to the front (the user may have, elsewhere). opencode pushes
 * no event for file changes.
 */
function useVcs(directory: string, isRunning: boolean) {
  const [vcs, setVcs] = useState<VcsInfo | null>(null);
  const [status, setStatus] = useState<VcsFileStatus[] | null>(null);
  const [focusCount, setFocusCount] = useState(0);
  useEffect(() => {
    const onFocus = () => setFocusCount((n) => n + 1);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);
  // focusCount is only a trigger: each focus reads the repository again.
  useEffect(() => {
    if (isRunning) return;
    let cancelled = false;
    Promise.all([ocClient.vcs(directory), ocClient.vcsStatus(directory)])
      .then(([info, files]) => {
        if (cancelled) return;
        setVcs(info);
        setStatus(files);
      })
      .catch((err: unknown) => console.warn("[info] vcs failed:", err));
    return () => {
      cancelled = true;
    };
  }, [directory, isRunning, focusCount]);
  return { vcs, status };
}

export function InfoPanel({
  session,
  isRunning,
  onOpenDiff,
}: {
  session: SessionInfo;
  isRunning: boolean;
  onOpenDiff: () => void;
}) {
  const directory = session.location.directory;
  const { vcs, status } = useVcs(directory, isRunning);
  return (
    <div className="flex h-full min-h-0 flex-col gap-2 overflow-y-auto p-3">
      <Environment directory={directory} vcs={vcs} />
      <Context session={session} />
      <Changes vcs={vcs} status={status} onOpenDiff={onOpenDiff} />
    </div>
  );
}
