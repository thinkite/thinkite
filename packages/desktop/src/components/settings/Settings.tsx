import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Icon } from "@astryxdesign/core/Icon";
import { Kbd } from "@astryxdesign/core/Kbd";
import { Layout, LayoutContent, LayoutPanel } from "@astryxdesign/core/Layout";
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
} from "lucide-react";
import {
  type ComponentType,
  type ReactNode,
  type SVGProps,
  useMemo,
  useState,
} from "react";
import { ocClient, ocStore } from "../../lib/oc";
import {
  prefs,
  settingsOpen,
  settingsPage,
  updatePrefs,
} from "../../lib/prefs";
import { serviceInfoKey } from "../../lib/query";
import {
  checkForUpdate,
  installUpdate,
  readyVersion,
  type UpdateInfo,
  useUpdate,
} from "../../lib/update";
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
  const mcp = useLoad(["mcp"], () =>
    ocClient.raw.mcp.list().then((r) => r.data),
  );
  const skills = useLoad(["skills"], () =>
    ocClient.raw.skill.list().then((r) => r.data),
  );
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
  const info = useLoad(serviceInfoKey, () => ocClient.info());
  const shells = useLoad(["shells"], loadShells);
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

/** One line on where the app's update stands. */
function updateNote(update: UpdateInfo): string {
  const { state } = update;
  const ready = readyVersion(state);
  if (ready !== undefined)
    return update.notApplied === ready
      ? `${ready} didn't install last time; restart to try again`
      : `${ready} is ready; restart to install it`;
  if (!update.packaged && state.status === "idle")
    return "Updates work in the installed app only";
  switch (state.status) {
    case "checking":
      return "Checking for updates…";
    case "downloading":
      return `Downloading ${state.version}… ${state.percent}%`;
    case "installing":
      return `Restarting into ${state.version}…`;
    case "up-to-date":
      return "Up to date";
    case "error":
      return state.message;
    default:
      return "Checked every hour; updates download on their own";
  }
}

function About() {
  const info = useLoad(serviceInfoKey, () => ocClient.info());
  const update = useUpdate();
  const ready = update ? readyVersion(update.state) : undefined;
  const busy =
    update?.state.status === "checking" ||
    update?.state.status === "downloading" ||
    update?.state.status === "installing";
  return (
    <>
      <Section title="Versions">
        <Row title="Thinkite">
          <Text size="sm">{update?.version ?? "—"}</Text>
        </Row>
        <Row title="opencode service">
          <Text size="sm">{info.data?.version ?? "—"}</Text>
        </Row>
      </Section>
      <Section title="Updates">
        <Row
          title="Thinkite updates"
          description={update ? updateNote(update) : "…"}
        >
          {ready !== undefined ? (
            <Button
              label="Restart to update"
              variant="primary"
              size="sm"
              onClick={() => void installUpdate()}
            />
          ) : (
            <Button
              label="Check now"
              variant="secondary"
              size="sm"
              isDisabled={!update?.packaged || busy}
              isLoading={update?.state.status === "checking"}
              onClick={() => void checkForUpdate()}
            />
          )}
        </Row>
      </Section>
    </>
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
  const page = useSelector(settingsPage);
  const setPage = (id: string) => settingsPage.set(id);
  const current = PAGES.find((p) => p.id === page) ?? PAGES[0];
  return (
    <Dialog
      isOpen={open}
      onOpenChange={(next) => settingsOpen.set(next)}
      width={880}
      maxHeight="80vh"
    >
      {/* One header across the dialog holds the title and the close button,
          as in DeepSeek Harness; the pages and the page beside them scroll
          on their own below it. */}
      <Layout
        className="h-[min(620px,80vh)]"
        header={
          <DialogHeader
            title="Settings"
            hasDivider
            onOpenChange={(next) => settingsOpen.set(next)}
          />
        }
        start={
          <LayoutPanel width={208} hasDivider label="Settings pages">
            <div className="flex flex-col gap-0.5">
              {PAGES.map((p) => (
                <Button
                  key={p.id}
                  label={p.label}
                  variant={p.id === current?.id ? "secondary" : "ghost"}
                  icon={<Icon icon={p.icon} size="sm" />}
                  style={{ width: "100%", justifyContent: "flex-start" }}
                  onClick={() => setPage(p.id)}
                />
              ))}
            </div>
          </LayoutPanel>
        }
        content={
          <LayoutContent key={current?.id}>
            {current ? (
              <>
                <PageTitle
                  title={current.label}
                  description={current.description}
                />
                <current.Page />
              </>
            ) : null}
          </LayoutContent>
        }
      />
    </Dialog>
  );
}
