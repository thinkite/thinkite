import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { Selector } from "@astryxdesign/core/Selector";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useToast } from "@astryxdesign/core/Toast";
import type { FormAnswer, IntegrationInfo } from "@thinkite/oc-client";
import { PlusIcon } from "lucide-react";
import { useState } from "react";
import { ocClient } from "../../lib/oc";
import { catalogKeys, invalidateCatalog } from "../../lib/query";
import { type Field, FormFields, initialAnswer } from "../FormFields";
import { Note, Section, useLoad } from "./parts";
import {
  accountsOf,
  addableOf,
  connectedOf,
  envDetected,
  envNames,
  externalMethod,
  keyMethod,
  loginProblem,
  sourceLabel,
} from "./providers-model";

// Settings › Providers, after DeepSeek Harness's Models settings: the
// providers configured now, each with Edit (a new API key, or delete it),
// and "Add model provider" — pick a provider from the service's catalog
// and paste its key, or leave the key empty when the opencode service
// finds one in its environment. A provider with a login of its own outside
// opencode (Claude Agent) connects with a button instead. Browser sign-ins
// (OpenAI's, Copilot's) are left to opencode's own clients; accounts made
// there still list here and can be replaced with a key or deleted.
// Everything reads the service's integration list again whenever the bus
// says providers, accounts or models changed (the catalog queries,
// lib/query).

const messageOf = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

const refresh = () => void invalidateCatalog();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const integrationOf = async (id: string) =>
  (await ocClient.listIntegrations()).find((i) => i.id === id);

/**
 * Connect a provider through its login outside opencode; rejects with what
 * is wrong with that login. Connecting only records the choice and starts
 * the service's check, which can take a minute (30 s for the program to
 * start, 30 more to read its models). The models show up before a problem
 * does, so a problem is looked for once more after them.
 */
async function connectLogin(integrationID: string, methodID: string) {
  const before = await integrationOf(integrationID);
  await ocClient.connectExternal(integrationID, methodID);
  // Each connect saves a new credential; this one replaces the others.
  await Promise.all(
    (before ? accountsOf(before) : []).map((a) =>
      ocClient.removeCredential(a.id),
    ),
  );
  const problem = async () => {
    const current = await integrationOf(integrationID);
    return current ? loginProblem(current) : null;
  };
  const deadline = Date.now() + 65_000;
  while (Date.now() < deadline) {
    const found = await problem();
    if (found !== null) throw new Error(found);
    const models = await ocClient.listModels();
    if (models.some((m) => m.providerID === integrationID)) {
      await sleep(1_000);
      const late = await problem();
      if (late !== null) throw new Error(late);
      return;
    }
    await sleep(500);
  }
  throw new Error("The login check timed out. Try again.");
}

/** Where the key can come from besides the field, for its placeholder and
 *  the hint under it. */
function envHelp(integration: IntegrationInfo | undefined): {
  placeholder: string;
  hint: string | null;
  isWarning: boolean;
} {
  const plain = {
    placeholder: "Enter your API key",
    hint: null,
    isWarning: false,
  };
  if (integration === undefined) return plain;
  if (accountsOf(integration).length > 0)
    return { ...plain, placeholder: "Leave blank to keep the saved key" };
  const detected = envDetected(integration);
  if (detected !== null)
    return {
      placeholder: `Leave blank to use ${detected}`,
      hint: `Environment variable detected (${detected}).`,
      isWarning: false,
    };
  const names = envNames(integration);
  if (names.length === 0) return plain;
  return {
    ...plain,
    hint: `No environment variable detected. Enter an API key, or set ${names.join(" or ")} where the opencode service runs.`,
    isWarning: true,
  };
}

/**
 * The card that adds a provider (`integration` null: pick one first) or
 * edits one. A new key replaces the stored ones; an empty key keeps them.
 */
function ProviderEditor({
  integration,
  addable,
  onDone,
}: {
  integration: IntegrationInfo | null;
  addable: readonly IntegrationInfo[];
  onDone: () => void;
}) {
  const showToast = useToast();
  // Held whole: connecting a login moves it out of `addable` mid-check.
  const [picked, setPicked] = useState<IntegrationInfo | null>(null);
  const target = integration ?? picked ?? undefined;
  const method = target ? keyMethod(target) : undefined;
  const external = target ? externalMethod(target) : null;
  const fields = (method?.form ?? []) as Field[];
  const [key, setKey] = useState("");
  const [answer, setAnswer] = useState<FormAnswer>(() => initialAnswer(fields));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const help = envHelp(target);
  const accounts = target ? accountsOf(target) : [];

  const pick = (id: string) => {
    const next = addable.find((i) => i.id === id);
    setPicked(next ?? null);
    setAnswer(
      next ? initialAnswer((keyMethod(next).form ?? []) as Field[]) : {},
    );
    setError(null);
  };

  const connect = (name: string, integrationID: string, methodID: string) => {
    setBusy(true);
    setError(null);
    connectLogin(integrationID, methodID)
      .then(() => {
        refresh();
        showToast({ body: `Connected ${name}.`, isAutoHide: true });
        onDone();
      })
      .catch((err: unknown) => {
        refresh();
        // A new login is in the list now, showing the problem; Edit retries.
        if (integration === null) {
          onDone();
          return;
        }
        setError(messageOf(err));
        setBusy(false);
      });
  };

  const save = () => {
    if (busy || target === undefined) return;
    if (external !== null) {
      connect(target.name, target.id, external.id);
      return;
    }
    const value = key.trim();
    if (value === "") {
      // Nothing new: an edit keeps what is stored.
      if (integration !== null) {
        onDone();
        return;
      }
      setError("Enter an API key.");
      return;
    }
    setBusy(true);
    setError(null);
    const previous = accounts.map((a) => a.id);
    ocClient
      .connectKey(
        target.id,
        value,
        fields.length > 0 ? answer : undefined,
        // A replaced key keeps its name.
        accounts[0]?.label,
      )
      // The new key is the active credential now; drop the ones it replaces.
      .then(() =>
        Promise.all(previous.map((id) => ocClient.removeCredential(id))),
      )
      .then(() => {
        refresh();
        showToast({ body: `Saved ${target.name}.`, isAutoHide: true });
        onDone();
      })
      .catch((err: unknown) => {
        setError(messageOf(err));
        setBusy(false);
      });
  };

  const remove = () => {
    if (target === undefined) return;
    setBusy(true);
    return Promise.all(accounts.map((a) => ocClient.removeCredential(a.id)))
      .then(() => {
        refresh();
        showToast({ body: `Deleted ${target.name}.`, isAutoHide: true });
        setConfirmDelete(false);
        onDone();
      })
      .catch((err: unknown) => {
        setError(messageOf(err));
        setBusy(false);
      });
  };

  const detected = target ? envDetected(target) : null;

  return (
    <div className="flex flex-col gap-3 bg-[var(--color-background-secondary)] px-4 py-4">
      {integration === null ? (
        <>
          <Text size="sm" color="secondary">
            Pick OpenAI, Anthropic, DeepSeek or another provider from the
            opencode catalog and enter its API key.
          </Text>
          <Selector
            label="Provider"
            hasSearch
            searchPlaceholder="Search providers"
            emptySearchText="No providers found"
            placeholder="Choose a provider"
            options={addable.map((i) => ({ value: i.id, label: i.name }))}
            {...(picked !== null ? { value: picked.id } : {})}
            onChange={pick}
          />
        </>
      ) : null}
      {target !== undefined && external !== null ? (
        <div className="flex flex-col gap-1.5">
          <Text size="sm" color="secondary">
            Uses {external.label}, not an API key. Sign in on this Mac first,
            then connect.
          </Text>
          {error !== null ? (
            <span className="text-[var(--color-text-red)]">
              <Text size="sm" color="inherit">
                {error}
              </Text>
            </span>
          ) : null}
        </div>
      ) : target !== undefined ? (
        <>
          <div className="flex flex-col gap-1.5">
            <TextInput
              type="password"
              label={method?.label ?? "API key"}
              placeholder={help.placeholder}
              htmlName="apiKey"
              autoComplete="off"
              value={key}
              onChange={(next) => {
                setKey(next);
                setError(null);
              }}
              onEnter={save}
              {...(error !== null
                ? { status: { type: "error" as const, message: error } }
                : {})}
            />
            {help.hint !== null ? (
              <span
                className={
                  help.isWarning ? "text-[var(--color-text-orange)]" : ""
                }
              >
                <Text
                  size="sm"
                  color={help.isWarning ? "inherit" : "secondary"}
                >
                  {help.hint}
                </Text>
              </span>
            ) : null}
          </div>
          {fields.length > 0 ? (
            <FormFields fields={fields} answer={answer} onChange={setAnswer} />
          ) : null}
        </>
      ) : null}
      <div className="flex items-center gap-2 pt-1">
        {integration !== null && accounts.length > 0 ? (
          <Button
            label="Delete"
            variant="ghost"
            size="sm"
            isDisabled={busy}
            onClick={() => setConfirmDelete(true)}
          />
        ) : null}
        <span className="flex-1" />
        <Button
          label="Cancel"
          variant="secondary"
          size="sm"
          isDisabled={busy}
          onClick={onDone}
        />
        <Button
          label={
            external === null
              ? "Save"
              : accounts.length > 0
                ? "Check again"
                : "Connect"
          }
          variant="primary"
          size="sm"
          isLoading={busy}
          isDisabled={target === undefined}
          onClick={save}
        />
      </div>
      {target !== undefined ? (
        <AlertDialog
          isOpen={confirmDelete}
          onOpenChange={setConfirmDelete}
          title={`Delete ${target.name}?`}
          description={
            external !== null
              ? "Its models are no longer available. The login itself stays as it is."
              : detected !== null
                ? `Its stored API key is removed. ${target.name} stays connected through ${detected}.`
                : "Its stored API key is removed, and its models are no longer available."
          }
          actionLabel={`Delete ${target.name}`}
          isActionLoading={busy}
          onAction={remove}
        />
      ) : null}
    </div>
  );
}

export function Providers() {
  const { data, error } = useLoad(catalogKeys.integrations, () =>
    ocClient.listIntegrations(),
  );
  // The one card open: a provider's id, "add", or none.
  const [editing, setEditing] = useState<string | null>(null);
  const all = data ?? [];
  const connected = connectedOf(all);
  const addable = addableOf(all);

  return (
    <>
      <Section title="Configured providers">
        {error && data === null ? (
          <Note text={error} />
        ) : data === null ? (
          <Note text="Loading…" />
        ) : connected.length === 0 ? (
          <Note text="No providers yet. Add one below to use its models." />
        ) : (
          connected.map((integration) => {
            const problem = loginProblem(integration);
            return (
              <div key={integration.id} className="flex flex-col">
                <div className="flex min-h-12 items-center gap-2 px-4 py-2.5">
                  <Text size="sm">{integration.name}</Text>
                  {problem !== null ? (
                    <StatusDot variant="error" label="Needs sign-in" />
                  ) : (
                    <StatusDot variant="success" label="Configured" />
                  )}
                  <Badge label={sourceLabel(integration)} />
                  <span className="flex-1" />
                  {editing !== integration.id ? (
                    <Button
                      label="Edit"
                      variant="secondary"
                      size="sm"
                      aria-label={`Edit ${integration.name}`}
                      onClick={() => setEditing(integration.id)}
                    />
                  ) : null}
                </div>
                {problem !== null && editing !== integration.id ? (
                  <div className="px-4 pb-2.5">
                    <Text size="sm" color="secondary">
                      {problem}
                    </Text>
                  </div>
                ) : null}
                {editing === integration.id ? (
                  <ProviderEditor
                    integration={integration}
                    addable={addable}
                    onDone={() => setEditing(null)}
                  />
                ) : null}
              </div>
            );
          })
        )}
      </Section>
      {editing === "add" ? (
        <Section title="Add model provider">
          <ProviderEditor
            integration={null}
            addable={addable}
            onDone={() => setEditing(null)}
          />
        </Section>
      ) : (
        <div>
          <Button
            label="Add model provider"
            variant="secondary"
            size="sm"
            icon={<Icon icon={PlusIcon} size="sm" />}
            isDisabled={data === null}
            onClick={() => setEditing("add")}
          />
        </div>
      )}
    </>
  );
}
