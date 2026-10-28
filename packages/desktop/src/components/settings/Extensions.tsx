import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Tab, TabList } from "@astryxdesign/core/TabList";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useToast } from "@astryxdesign/core/Toast";
import { useQuery } from "@tanstack/react-query";
import { PlusIcon } from "lucide-react";
import { useState } from "react";
import { ocClient } from "../../lib/oc";
import {
  extensionKeys,
  invalidateExtensions,
  queryClient,
} from "../../lib/query";
import { Note, Row, Section, useLoad } from "./parts";

// Settings › Extensions: the opencode service's plugins, MCP servers and
// skills, one tab each. Plugins can be installed, updated and uninstalled
// (after DeepSeek Harness's plugin manager, without its per-plugin switch:
// opencode has no "disabled" state, only `plugin add` and `plugin remove`);
// MCP servers and skills are read-only.

type PluginInfo = Awaited<
  ReturnType<typeof ocClient.raw.plugin.list>
>["data"][number];

const messageOf = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

/** What a plugin is called in the list: its id, else where it comes from. */
function pluginName(plugin: PluginInfo): string {
  if (plugin.id) return plugin.id;
  switch (plugin.source.type) {
    case "package":
      return plugin.source.target;
    case "local":
      return plugin.source.path;
    default:
      return "Plugin";
  }
}

function pluginSource(plugin: PluginInfo): string {
  switch (plugin.source.type) {
    case "package":
      return plugin.source.version
        ? `${plugin.source.target} ${plugin.source.version}`
        : plugin.source.target;
    case "local":
      return plugin.source.path;
    case "sdk":
      return "Added by the app running opencode";
    default:
      return "Built into opencode";
  }
}

// Built-in plugins (around ninety in opencode 2.2) are opencode itself.
const listPlugins = () =>
  ocClient.raw.plugin
    .list()
    .then((r) => r.data.filter((p) => p.source.type !== "builtin"));

const packageTargets = (plugins: readonly PluginInfo[]) =>
  new Set(
    plugins.flatMap((p) =>
      p.source.type === "package" ? [p.source.target] : [],
    ),
  );

/**
 * POST to the Electron main's plugin routes (server/index.ts), which run
 * `opencode plugin add|remove`; rejects with the CLI's error. The CLI
 * returns once opencode.json is rewritten, and the service loads or
 * unloads the plugin a few seconds later, so this waits (up to 15 s) for
 * the list to show the change before the caller says it is done.
 */
async function pluginCommand(action: "add" | "remove", spec: string) {
  const before = packageTargets(await listPlugins().catch(() => []));
  const res = await fetch(
    `/api/plugins/${action}?spec=${encodeURIComponent(spec)}`,
    { method: "POST" },
  );
  if (!res.ok) throw new Error((await res.text()) || res.statusText);
  // An install's spec can carry a version or be a Git URL, so it shows as
  // any new package; a removal names the package's own target.
  const changed = (now: Set<string>) =>
    action === "add"
      ? now.has(spec) || [...now].some((target) => !before.has(target))
      : !now.has(spec);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const now = await listPlugins().catch(() => null);
    if (now !== null && changed(packageTargets(now))) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  await invalidateExtensions();
}

function AddPlugin({ onDone }: { onDone: () => void }) {
  const showToast = useToast();
  const [spec, setSpec] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const install = () => {
    const value = spec.trim();
    if (busy) return;
    if (value === "") {
      setError("Enter an npm package or Git URL.");
      return;
    }
    setBusy(true);
    setError(null);
    pluginCommand("add", value)
      .then(() => {
        void queryClient.invalidateQueries({
          queryKey: extensionKeys.pluginUpdates,
        });
        showToast({ body: `Installed ${value}.`, isAutoHide: true });
        onDone();
      })
      .catch((err: unknown) => {
        setError(messageOf(err));
        setBusy(false);
      });
  };

  return (
    <div className="flex flex-col gap-3 px-4 py-4">
      <TextInput
        label="Package"
        placeholder="npm package or Git URL"
        autoComplete="off"
        value={spec}
        isDisabled={busy}
        onChange={(next) => {
          setSpec(next);
          setError(null);
        }}
        onEnter={install}
        {...(error !== null
          ? { status: { type: "error" as const, message: error } }
          : {})}
      />
      <Text size="sm" color="secondary">
        {busy
          ? "Installing… this can take a minute."
          : "opencode installs it and adds it to your global opencode.json. A plugin runs with your account's access to this Mac, so install only ones you trust."}
      </Text>
      <div className="flex items-center justify-end gap-2">
        <Button
          label="Cancel"
          variant="secondary"
          size="sm"
          isDisabled={busy}
          onClick={onDone}
        />
        <Button
          label="Install"
          variant="primary"
          size="sm"
          isLoading={busy}
          onClick={install}
        />
      </div>
    </div>
  );
}

function PluginRow({
  plugin,
  outdated,
}: {
  plugin: PluginInfo;
  outdated: boolean;
}) {
  const showToast = useToast();
  const [busy, setBusy] = useState<"update" | "remove" | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const name = pluginName(plugin);
  const target = plugin.source.type === "package" ? plugin.source.target : null;
  const failed = plugin.state.status === "failed" ? plugin.state.error : null;

  const update = () => {
    if (target === null) return;
    setBusy("update");
    ocClient.raw.plugin
      .update({ targets: [target] })
      .then(() => {
        void queryClient.invalidateQueries({
          queryKey: extensionKeys.pluginUpdates,
        });
        showToast({ body: `Updated ${name}.`, isAutoHide: true });
      })
      .catch((err: unknown) =>
        showToast({ type: "error", body: messageOf(err), isAutoHide: false }),
      )
      .finally(() => setBusy(null));
  };

  const remove = () => {
    if (target === null) return;
    setBusy("remove");
    return pluginCommand("remove", target)
      .then(() => {
        showToast({ body: `Uninstalled ${name}.`, isAutoHide: true });
        setConfirmRemove(false);
      })
      .catch((err: unknown) => {
        setConfirmRemove(false);
        showToast({ type: "error", body: messageOf(err), isAutoHide: false });
      })
      .finally(() => setBusy(null));
  };

  return (
    <Row
      title={name}
      description={
        failed !== null ? (
          <span className="text-[var(--color-text-red)]">{failed}</span>
        ) : (
          pluginSource(plugin)
        )
      }
    >
      {failed !== null ? (
        <StatusDot variant="error" label="Failed" />
      ) : outdated ? (
        <Badge label="Update available" />
      ) : null}
      {target !== null && outdated ? (
        <Button
          label="Update"
          variant="secondary"
          size="sm"
          aria-label={`Update ${name}`}
          isLoading={busy === "update"}
          isDisabled={busy !== null}
          onClick={update}
        />
      ) : null}
      {target !== null ? (
        <Button
          label="Uninstall"
          variant="ghost"
          size="sm"
          aria-label={`Uninstall ${name}`}
          isDisabled={busy !== null}
          onClick={() => setConfirmRemove(true)}
        />
      ) : null}
      {target !== null ? (
        <AlertDialog
          isOpen={confirmRemove}
          onOpenChange={setConfirmRemove}
          title={`Uninstall ${name}?`}
          description="opencode unloads it and removes it from your global opencode.json, along with any options set for it there."
          actionLabel="Uninstall"
          actionVariant="destructive"
          isActionLoading={busy === "remove"}
          onAction={remove}
        />
      ) : null}
    </Row>
  );
}

function Plugins() {
  const [adding, setAdding] = useState(false);
  const plugins = useLoad(extensionKeys.plugins, listPlugins);
  const updates = useQuery({
    queryKey: extensionKeys.pluginUpdates,
    queryFn: () => ocClient.raw.plugin.check({}).then((r) => r.data),
    staleTime: 10 * 60_000,
  });
  const outdated = new Set(
    (updates.data ?? []).flatMap((p) =>
      p.source.type === "package" && p.source.outdated ? [p.source.target] : [],
    ),
  );

  return (
    <>
      <Section title="Installed">
        {plugins.error && plugins.data === null ? (
          <Note text={plugins.error} />
        ) : plugins.data === null ? (
          <Note text="Loading…" />
        ) : plugins.data.length === 0 ? (
          <Note text="No plugins installed." />
        ) : (
          plugins.data.map((plugin) => (
            <PluginRow
              key={`${plugin.source.type}:${pluginName(plugin)}`}
              plugin={plugin}
              outdated={
                plugin.source.type === "package" &&
                outdated.has(plugin.source.target)
              }
            />
          ))
        )}
      </Section>
      {adding ? (
        <Section title="Add plugin">
          <AddPlugin onDone={() => setAdding(false)} />
        </Section>
      ) : (
        <div>
          <Button
            label="Add plugin"
            variant="secondary"
            size="sm"
            icon={<Icon icon={PlusIcon} size="sm" />}
            onClick={() => setAdding(true)}
          />
        </div>
      )}
    </>
  );
}

function McpServers() {
  const mcp = useLoad(extensionKeys.mcp, () =>
    ocClient.raw.mcp.list().then((r) => r.data),
  );
  return (
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
  );
}

function Skills() {
  const skills = useLoad(extensionKeys.skills, () =>
    ocClient.raw.skill.list().then((r) => r.data),
  );
  return (
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
  );
}

const TABS = [
  { value: "plugins", label: "Plugins", Panel: Plugins },
  { value: "mcp", label: "MCP", Panel: McpServers },
  { value: "skills", label: "Skills", Panel: Skills },
] as const;

export function Extensions() {
  const [tab, setTab] = useState<string>("plugins");
  const current = TABS.find((t) => t.value === tab) ?? TABS[0];
  return (
    <>
      <div className="mb-4">
        <TabList
          aria-label="Extensions"
          role="tablist"
          size="sm"
          hasDivider
          value={current.value}
          onChange={setTab}
        >
          {TABS.map((t) => (
            <Tab
              key={t.value}
              value={t.value}
              label={t.label}
              panelId={`extensions-${t.value}`}
            />
          ))}
        </TabList>
      </div>
      <div id={`extensions-${current.value}`} role="tabpanel">
        <current.Panel />
      </div>
    </>
  );
}
