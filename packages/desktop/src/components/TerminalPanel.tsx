import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Icon } from "@astryxdesign/core/Icon";
import { Tab, TabList } from "@astryxdesign/core/TabList";
import { useSelector } from "@tanstack/react-store";
import { PlusIcon, TerminalIcon, XIcon } from "lucide-react";
import { useState } from "react";
import {
  closeTerminal,
  dropTerminal,
  MAX_TERMINALS,
  openTerminal,
  ptyName,
  selectTerminal,
  terminals,
  terminalsOf,
} from "../lib/terminals";
import { TerminalPane } from "./TerminalPane";

// The terminal surface: a session's shells as tabs, after DeepSeek
// Harness's terminal dock. A tab's pane mounts the first time it is
// selected — TerminalPane measures its cell grid on mount and must be laid
// out then (the route's lazy attach, one level down) — and then stays
// mounted, hidden when not selected, so it keeps its buffer. Closing a tab
// ends its shell, and a shell that exits closes its tab.

export function TerminalPanel({
  sessionId,
  cwd,
}: {
  sessionId: string;
  cwd: string;
}) {
  const { open, active } = useSelector(terminals, (all) =>
    terminalsOf(all, sessionId),
  );
  const add = () => openTerminal(sessionId);
  const [seen, setSeen] = useState(() => new Set([active]));
  if (!seen.has(active)) setSeen(new Set(seen).add(active));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-[var(--color-border)] px-2">
        <div className="min-w-0 flex-1">
          {open.length > 0 ? (
            <TabList
              aria-label="Terminals"
              role="tablist"
              size="sm"
              value={String(active)}
              onChange={(v) => selectTerminal(sessionId, Number(v))}
            >
              {open.map((n) => (
                <Tab
                  key={n}
                  value={String(n)}
                  label={`Terminal ${n}`}
                  panelId={`terminal-${sessionId}-${n}`}
                />
              ))}
            </TabList>
          ) : null}
        </div>
        <Button
          label="New terminal"
          tooltip="New terminal"
          icon={<Icon icon={PlusIcon} size="sm" />}
          isIconOnly
          variant="ghost"
          size="sm"
          isDisabled={open.length >= MAX_TERMINALS}
          onClick={add}
        />
        {open.length > 0 ? (
          <Button
            label="Close terminal"
            tooltip="Close terminal"
            icon={<Icon icon={XIcon} size="sm" />}
            isIconOnly
            variant="ghost"
            size="sm"
            onClick={() => closeTerminal(sessionId, active)}
          />
        ) : null}
      </div>
      {open.length === 0 ? (
        <div className="flex flex-1 items-center justify-center">
          <EmptyState
            title="No terminals"
            description="Open a shell in this session's folder."
            icon={<Icon icon={TerminalIcon} size="lg" color="secondary" />}
            actions={<Button label="New terminal" size="sm" onClick={add} />}
            isCompact
          />
        </div>
      ) : (
        <div className="min-h-0 flex-1 p-2">
          {open
            .filter((n) => seen.has(n))
            .map((n) => (
              <div
                key={n}
                id={`terminal-${sessionId}-${n}`}
                role="tabpanel"
                className={n === active ? "h-full" : "hidden"}
              >
                <TerminalPane
                  name={ptyName(sessionId, n)}
                  cwd={cwd}
                  onExit={() => dropTerminal(sessionId, n)}
                />
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
