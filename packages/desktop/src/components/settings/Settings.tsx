import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { Dialog } from "@astryxdesign/core/Dialog";
import { Icon } from "@astryxdesign/core/Icon";
import { Kbd } from "@astryxdesign/core/Kbd";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@astryxdesign/core/SegmentedControl";
import { Selector } from "@astryxdesign/core/Selector";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Switch } from "@astryxdesign/core/Switch";
import { Text } from "@astryxdesign/core/Text";
import { useSelector } from "@tanstack/react-store";
import { formatModelRef, type ModelInfo } from "@thinkite/oc-client";
import { useConnectionStatus } from "@thinkite/oc-client/react";
import {
  BoxIcon,
  InfoIcon,
  PaintbrushIcon,
  PuzzleIcon,
  ServerIcon,
  SmartphoneIcon,
  TerminalIcon,
  XIcon,
} from "lucide-react";
import {
  type ComponentType,
  type ReactNode,
  type SVGProps,
  useMemo,
  useState,
} from "react";
import { ocClient, ocStore } from "../../lib/oc";
import { prefs, settingsOpen, updatePrefs } from "../../lib/prefs";
import { isVisible, newestOfFamilies, useModels } from "../ModelPicker";
import { Pairing } from "./Pairing";
import { Providers } from "./Providers";
import { Note, PageTitle, Row, Section, useLoad } from "./parts";

// Settings, as a modal (wisp's call: a full page is hard to leave) with
// opencode desktop's pages. Only pages that do something are here: the
// color mode, connecting providers and managing their accounts, which
// models the picker lists (client-side, like opencode desktop), the
// server's terminal shell, and read-only views of the service's MCP
// servers and skills.

type IconType = ComponentType<SVGProps<SVGSVGElement>>;

// ---- pages ----

function Appearance() {
  const mode = useSelector(prefs, (p) => p.appearance.mode);
  return (
    <Section title="Theme">
      <Row title="Color mode" description="System follows your Mac">
        <SegmentedControl
          label="Color mode"
          value={mode}
          onChange={(next) =>
            updatePrefs((p) => ({
              ...p,
              appearance: { mode: next as typeof mode },
            }))
          }
        >
          <SegmentedControlItem value="system" label="System" />
          <SegmentedControlItem value="light" label="Light" />
          <SegmentedControlItem value="dark" label="Dark" />
        </SegmentedControl>
      </Row>
    </Section>
  );
}

const SHORTCUTS: [string, string][] = [
  ["New session", "mod+n"],
  ["Settings", "mod+,"],
  ["Send message", "enter"],
  ["New line", "shift+enter"],
  ["Allow once (approval)", "enter"],
  ["Reject (approval)", "escape"],
];

function Shortcuts() {
  return (
    <Section title="General">
      {SHORTCUTS.map(([action, keys]) => (
        <Row key={action} title={action}>
          <Kbd keys={keys} />
        </Row>
      ))}
    </Section>
  );
}

function Models() {
  const list = useModels();
  const visibility = useSelector(prefs, (p) => p.models);
  const latest = useMemo(() => newestOfFamilies(list?.models ?? []), [list]);
  const groups = useMemo(() => {
    const out = new Map<string, ModelInfo[]>();
    for (const m of list?.models ?? [])
      out.set(m.providerID, [...(out.get(m.providerID) ?? []), m]);
    return [...out].sort(([a], [b]) =>
      (list?.providers.get(a) ?? a).localeCompare(list?.providers.get(b) ?? b),
    );
  }, [list]);
  const setVisible = (m: ModelInfo, visible: boolean) => {
    const ref = formatModelRef(m.providerID, m.id);
    updatePrefs((p) => {
      const hidden = p.models.hidden.filter((r) => r !== ref);
      const shown = p.models.shown.filter((r) => r !== ref);
      // Back to the default when the choice matches it; remember it otherwise.
      const byDefault = latest.has(ref);
      return {
        ...p,
        models: {
          hidden: !visible && byDefault ? [...hidden, ref] : hidden,
          shown: visible && !byDefault ? [...shown, ref] : shown,
        },
      };
    });
  };
  return (
    <>
      {list === null ? (
        <Section title="Models">
          <Note text="Loading…" />
        </Section>
      ) : (
        groups.map(([provider, models]) => (
          <Section
            key={provider}
            title={list.providers.get(provider) ?? provider}
          >
            {models
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((m) => (
                <Row key={m.id} title={m.name} description={m.id}>
                  <Switch
                    label={`Show ${m.name}`}
                    isLabelHidden
                    value={isVisible(m, latest, visibility)}
                    onChange={(checked) => setVisible(m, checked)}
                  />
                </Row>
              ))}
          </Section>
        ))
      )}
    </>
  );
}

function Extensions() {
  const mcp = useLoad(() => ocClient.raw.mcp.list().then((r) => r.data));
  const skills = useLoad(() => ocClient.raw.skill.list().then((r) => r.data));
  return (
    <>
      <Section title="MCP servers">
        {mcp.error ? (
          <Note text={mcp.error} />
        ) : mcp.data === null ? (
          <Note text="Loading…" />
        ) : mcp.data.length === 0 ? (
          <Note text="No MCP servers" />
        ) : (
          mcp.data.map((s) => (
            <Row key={s.name} title={s.name}>
              <Badge label={s.status.status} />
            </Row>
          ))
        )}
      </Section>
      <Section title="Skills">
        {skills.error ? (
          <Note text={skills.error} />
        ) : skills.data === null ? (
          <Note text="Loading…" />
        ) : skills.data.length === 0 ? (
          <Note text="No skills" />
        ) : (
          skills.data.map((s) => (
            <Row key={s.id} title={s.name} description={s.description} />
          ))
        )}
      </Section>
    </>
  );
}

async function loadShells() {
  const [shells, config] = await Promise.all([
    ocClient.raw.config.shells(),
    ocClient.raw.config.get(),
  ]);
  let configured: string | null = null;
  for (const entry of config)
    if (entry.type === "document" && entry.info.shell)
      configured = entry.info.shell;
  return { shells, configured };
}

function Server() {
  const status = useConnectionStatus(ocStore);
  const info = useLoad(() => ocClient.info());
  const shells = useLoad(loadShells);
  const [shell, setShell] = useState<string | null>(null);
  const current = shell ?? shells.data?.configured ?? "auto";
  const change = (next: string) => {
    setShell(next);
    ocClient.raw.config
      .update({ shell: next === "auto" ? null : next })
      .catch((err: unknown) => console.warn("[settings] shell:", err));
  };
  return (
    <>
      <Section title="Connection">
        <Row
          title="Local service"
          description={
            status === "ready"
              ? "Found through opencode's service registry"
              : "Not connected"
          }
        >
          <StatusDot
            variant={status === "ready" ? "success" : "neutral"}
            label={status}
          />
          {info.data ? (
            <Text size="sm">{`opencode ${info.data.version}`}</Text>
          ) : null}
        </Row>
      </Section>
      <Section title="Preferences">
        <Row
          title="Terminal shell"
          description="Shell used by the terminal and agent tools"
        >
          {shells.error ? (
            <Text size="sm" color="secondary">
              Unavailable
            </Text>
          ) : (
            <Selector
              label="Terminal shell"
              isLabelHidden
              width={240}
              value={current}
              options={[
                { value: "auto", label: "Auto (default)" },
                ...(shells.data?.shells ?? []).map((s) => ({
                  value: s.path,
                  label: s.acceptable ? s.name : `${s.name} (terminal only)`,
                })),
              ]}
              onChange={change}
            />
          )}
        </Row>
      </Section>
    </>
  );
}

function About() {
  const info = useLoad(() => ocClient.info());
  return (
    <Section title="Versions">
      <Row title="opencode service">
        <Text size="sm">{info.data?.version ?? "—"}</Text>
      </Row>
    </Section>
  );
}

const PAGES: {
  id: string;
  label: string;
  /** Shown under the title in the header. */
  description: string;
  icon: IconType;
  Page: () => ReactNode;
}[] = [
  {
    id: "appearance",
    label: "Appearance",
    description: "How Thinkite looks",
    icon: PaintbrushIcon,
    Page: Appearance,
  },
  {
    id: "shortcuts",
    label: "Shortcuts",
    description: "Keyboard shortcuts",
    icon: TerminalIcon,
    Page: Shortcuts,
  },
  {
    id: "pairing",
    label: "Pairing",
    description: "Connect your phone to this Mac",
    icon: SmartphoneIcon,
    Page: Pairing,
  },
  {
    id: "providers",
    label: "Providers",
    description: "Enter API keys to use models from these providers",
    icon: ServerIcon,
    Page: Providers,
  },
  {
    id: "models",
    label: "Models",
    description:
      "Which models the picker lists. By default, the newest of each family.",
    icon: BoxIcon,
    Page: Models,
  },
  {
    id: "extensions",
    label: "Extensions",
    description: "MCP servers and skills on the opencode service",
    icon: PuzzleIcon,
    Page: Extensions,
  },
  {
    id: "server",
    label: "Server",
    description: "The opencode service Thinkite uses",
    icon: ServerIcon,
    Page: Server,
  },
  {
    id: "about",
    label: "About",
    description: "Thinkite, a client for opencode",
    icon: InfoIcon,
    Page: About,
  },
];

export function Settings() {
  const open = useSelector(settingsOpen);
  const [page, setPage] = useState(PAGES[0]?.id ?? "appearance");
  const current = PAGES.find((p) => p.id === page) ?? PAGES[0];
  const close = () => settingsOpen.set(false);
  return (
    <Dialog
      isOpen={open}
      onOpenChange={(next) => settingsOpen.set(next)}
      width={880}
      maxHeight="80vh"
      padding={0}
    >
      <div className="flex h-[min(620px,80vh)]">
        <nav className="flex w-52 shrink-0 flex-col gap-0.5 border-r border-[var(--color-border)] p-3">
          {PAGES.map((p) => (
            <Button
              key={p.id}
              label={p.label}
              variant={p.id === page ? "secondary" : "ghost"}
              icon={<Icon icon={p.icon} size="sm" />}
              style={{ width: "100%", justifyContent: "flex-start" }}
              onClick={() => setPage(p.id)}
            />
          ))}
        </nav>
        {/* The page's title and the close button stay put; only the
            page below them scrolls. */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex shrink-0 items-start gap-4 px-8 pt-6 pb-4">
            <div className="min-w-0 flex-1">
              {current ? (
                <PageTitle
                  title={current.label}
                  description={current.description}
                />
              ) : null}
            </div>
            <Button
              label="Close"
              variant="ghost"
              isIconOnly
              icon={<Icon icon={XIcon} size="sm" />}
              onClick={close}
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-8 pb-6">
            {current ? <current.Page key={current.id} /> : null}
          </div>
        </div>
      </div>
    </Dialog>
  );
}
