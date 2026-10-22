import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { Selector } from "@astryxdesign/core/Selector";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useToast } from "@astryxdesign/core/Toast";
import { useSelector } from "@tanstack/react-store";
import type { FormAnswer, IntegrationInfo } from "@thinkite/oc-client";
import { PlusIcon } from "lucide-react";
import { useState } from "react";
import { catalogVersion, ocClient } from "../../lib/oc";
import { type Field, FormFields, initialAnswer } from "../FormFields";
import { Note, Section, useLoad } from "./parts";
import {
  accountsOf,
  addableOf,
  connectedOf,
  envDetected,
  envNames,
  keyMethod,
  sourceLabel,
} from "./providers-model";

// Settings › Providers, after DeepSeek Harness's Models settings: the
// providers configured now, each with Edit (a new API key, or delete it),
// and "Add model provider" — pick a provider from the service's catalog
// and paste its key, or leave the key empty when the opencode service
// finds one in its environment. Browser sign-ins (OpenAI's, Copilot's)
// are left to opencode's own clients; accounts made there still list
// here and can be replaced with a key or deleted. Everything reads the
// service's integration list again whenever the bus says providers,
// accounts or models changed (lib/oc's catalog version).

const messageOf = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

const refresh = () => catalogVersion.set((v) => v + 1);

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
  const [pickedID, setPickedID] = useState<string | null>(null);
  const target =
    integration ?? addable.find((i) => i.id === pickedID) ?? undefined;
  const method = target ? keyMethod(target) : undefined;
  const fields = (method?.form ?? []) as Field[];
  const [key, setKey] = useState("");
  const [answer, setAnswer] = useState<FormAnswer>(() => initialAnswer(fields));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const help = envHelp(target);
  const accounts = target ? accountsOf(target) : [];

  const pick = (id: string) => {
    setPickedID(id);
    const next = addable.find((i) => i.id === id);
    setAnswer(
      next ? initialAnswer((keyMethod(next).form ?? []) as Field[]) : {},
    );
    setError(null);
  };

  const save = () => {
    if (busy || target === undefined) return;
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
            {...(pickedID !== null ? { value: pickedID } : {})}
            onChange={pick}
          />
        </>
      ) : null}
      {target !== undefined ? (
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
          label="Save"
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
            detected !== null
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
  const version = useSelector(catalogVersion);
  const { data, error } = useLoad(() => ocClient.listIntegrations(), version);
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
          connected.map((integration) => (
            <div key={integration.id} className="flex flex-col">
              <div className="flex min-h-12 items-center gap-2 px-4 py-2.5">
                <Text size="sm">{integration.name}</Text>
                <StatusDot variant="success" label="Configured" />
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
              {editing === integration.id ? (
                <ProviderEditor
                  integration={integration}
                  addable={addable}
                  onDone={() => setEditing(null)}
                />
              ) : null}
            </div>
          ))
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
