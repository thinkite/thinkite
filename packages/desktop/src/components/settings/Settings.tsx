import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { Dialog } from "@astryxdesign/core/Dialog";
import { Heading } from "@astryxdesign/core/Heading";
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
  TerminalIcon,
  XIcon,
} from "lucide-react";
import {
  type ComponentType,
  type ReactNode,
  type SVGProps,
  useEffect,
  useMemo,
  useState,
} from "react";
import { ocClient, ocStore } from "../../lib/oc";
import { prefs, settingsOpen, updatePrefs } from "../../lib/prefs";
import { isVisible, newestOfFamilies, useModels } from "../ModelPicker";

// Settings, as a modal (wisp's call: a full page is hard to leave) with
// opencode desktop's pages. Only pages that do something are here: the
// color mode, which models the picker lists (client-side, like opencode
// desktop), the server's terminal shell, and read-only views of the
// service's providers, MCP servers and skills.

type IconType = ComponentType<SVGProps<SVGSVGElement>>;

/** A read from the service, with its error and a reload. */
function useLoad<T>(load: () => Promise<T>): {
  data: T | null;
  error: string | null;
} {
  const [state, setState] = useState<{ data: T | null; error: string | null }>({
    data: null,
    error: null,
  });
  useEffect(() => {
    let cancelled = false;
    load()
      .then((data) => {
        if (!cancelled) setState({ data, error: null });
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setState({
            data: null,
            error: err instanceof Error ? err.message : String(err),
          });
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return state;
}

function PageTitle({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="mb-5 flex flex-col gap-1">
      <Heading level={4}>{title}</Heading>
      <Text size="sm" color="secondary">
        {description}
      </Text>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-6 flex flex-col gap-1">
      <Text size="sm" weight="medium" color="secondary">
        {title}
      </Text>
      <div className="flex flex-col divide-y divide-[var(--color-border)] rounded-lg border border-[var(--color-border)]">
        {children}
      </div>
    </section>
  );
}

function Row({
  title,
  description,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex min-h-12 items-center gap-4 px-4 py-2.5">
      <div className="flex min-w-0 flex-1 flex-col">
        <Text size="sm">{title}</Text>
        {description ? (
          <Text size="sm" color="secondary" maxLines={1}>
            {description}
          </Text>
        ) : null}
      </div>
      {children}
    </div>
  );
}

function Note({ text }: { text: string }) {
  return (
    <div className="px-4 py-3">
      <Text size="sm" color="secondary">
        {text}
      </Text>
    </div>
  );
}

// ---- pages ----

function Appearance() {
  const mode = useSelector(prefs, (p) => p.appearance.mode);
  return (
    <>
      <PageTitle title="Appearance" description="How Thinkite looks" />
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
    </>
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
    <>
      <PageTitle title="Shortcuts" description="Keyboard shortcuts" />
      <Section title="General">
        {SHORTCUTS.map(([action, keys]) => (
          <Row key={action} title={action}>
            <Kbd keys={keys} />
          </Row>
        ))}
      </Section>
    </>
  );
}

function Providers() {
  const { data, error } = useLoad(() => ocClient.listProviders());
  const models = useModels();
  const counts = useMemo(() => {
    const out = new Map<string, number>();
    for (const m of models?.models ?? [])
      out.set(m.providerID, (out.get(m.providerID) ?? 0) + 1);
    return out;
  }, [models]);
  const connected = (data ?? []).filter((p) => counts.has(p.id));
  return (
    <>
      <PageTitle
        title="Providers"
        description="Model providers connected on the opencode service"
      />
      <Section title="Connected providers">
        {error ? (
          <Note text={error} />
        ) : data === null || models === null ? (
          <Note text="Loading…" />
        ) : connected.length === 0 ? (
          <Note text="No connected providers. Connect one in opencode." />
        ) : (
          connected.map((p) => (
            <Row key={p.id} title={p.name} description={p.id}>
              <Badge label={`${counts.get(p.id)} models`} />
            </Row>
          ))
        )}
      </Section>
    </>
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
      <PageTitle
        title="Models"
        description="Which models the picker lists. By default, the newest of each family."
      />
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
      <PageTitle
        title="Extensions"
        description="MCP servers and skills on the opencode service"
      />
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
      <PageTitle
        title="Server"
        description="The opencode service Thinkite uses"
      />
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
    <>
      <PageTitle title="About" description="Thinkite, a client for opencode" />
      <Section title="Versions">
        <Row title="opencode service">
          <Text size="sm">{info.data?.version ?? "—"}</Text>
        </Row>
      </Section>
    </>
  );
}

const PAGES: {
  id: string;
  label: string;
  icon: IconType;
  Page: () => ReactNode;
}[] = [
  {
    id: "appearance",
    label: "Appearance",
    icon: PaintbrushIcon,
    Page: Appearance,
  },
  {
    id: "shortcuts",
    label: "Shortcuts",
    icon: TerminalIcon,
    Page: Shortcuts,
  },
  { id: "providers", label: "Providers", icon: ServerIcon, Page: Providers },
  { id: "models", label: "Models", icon: BoxIcon, Page: Models },
  {
    id: "extensions",
    label: "Extensions",
    icon: PuzzleIcon,
    Page: Extensions,
  },
  { id: "server", label: "Server", icon: ServerIcon, Page: Server },
  { id: "about", label: "About", icon: InfoIcon, Page: About },
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
        <div className="relative min-w-0 flex-1 overflow-y-auto px-8 py-6">
          <div className="absolute top-3 right-3">
            <Button
              label="Close"
              variant="ghost"
              isIconOnly
              icon={<Icon icon={XIcon} size="sm" />}
              onClick={close}
            />
          </div>
          {current ? <current.Page key={current.id} /> : null}
        </div>
      </div>
    </Dialog>
  );
}
