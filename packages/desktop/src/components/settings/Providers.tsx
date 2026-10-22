import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import {
  DropdownMenu,
  type DropdownMenuOption,
} from "@astryxdesign/core/DropdownMenu";
import { Icon } from "@astryxdesign/core/Icon";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useToast } from "@astryxdesign/core/Toast";
import { useSelector } from "@tanstack/react-store";
import type { IntegrationInfo } from "@thinkite/oc-client";
import { CheckIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { type SVGProps, useRef, useState } from "react";
import { catalogVersion, ocClient } from "../../lib/oc";
import { ConnectDialog } from "./ConnectDialog";
import { Note, Row, Section, useLoad } from "./parts";
import {
  type Account,
  accountsOf,
  connectedOf,
  isRecommended,
  popularOf,
  sourceLabel,
} from "./providers-model";

// Settings › Providers, after opencode desktop's
// (`settings/providers/providers.tsx` at v2.1.2, MIT): the providers
// connected now, each with its accounts (switch, rename, remove, add
// another), then the popular ones not connected yet, each a Connect away;
// "Show more providers" opens the full picker. Everything is the service's
// integration list, read again whenever the bus says providers, accounts
// or models changed (lib/oc's catalog version).

const NoIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg aria-hidden {...props} />
);

const messageOf = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

/** An account's name, edited in place: Enter or leaving saves, Escape
 *  cancels; an empty or unchanged name just closes. */
function AccountName({
  account,
  onDone,
}: {
  account: Account;
  onDone: () => void;
}) {
  const [draft, setDraft] = useState(account.label);
  const done = useRef(false);
  const save = () => {
    if (done.current) return;
    done.current = true;
    const next = draft.trim();
    onDone();
    if (next === "" || next === account.label) return;
    ocClient
      .renameCredential(account.id, next)
      .then(() => catalogVersion.set((v) => v + 1))
      .catch((err: unknown) => console.warn("[providers] rename:", err));
  };
  return (
    <TextInput
      label="Account name"
      isLabelHidden
      size="sm"
      width={200}
      value={draft}
      onChange={setDraft}
      hasAutoFocus
      onFocus={(e) => (e.target as HTMLInputElement).select()}
      onEnter={save}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          done.current = true;
          onDone();
        }
      }}
    />
  );
}

function ConnectedRow({
  integration,
  onAddAccount,
}: {
  integration: IntegrationInfo;
  onAddAccount: () => void;
}) {
  const showToast = useToast();
  const accounts = accountsOf(integration);
  // The service lists the active account first.
  const active = accounts[0];
  const [renaming, setRenaming] = useState(false);
  const [removing, setRemoving] = useState<Account | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = () => catalogVersion.set((v) => v + 1);

  const use = (account: Account) => {
    ocClient
      .activateCredential(account.id)
      .then(() => {
        refresh();
        showToast({
          body: `${integration.name} account switched. Now using ${account.label}.`,
          isAutoHide: true,
        });
      })
      .catch((err: unknown) =>
        showToast({ body: messageOf(err), type: "error" }),
      );
  };

  const remove = (account: Account) => {
    setBusy(true);
    return ocClient
      .removeCredential(account.id)
      .then(() => {
        refresh();
        showToast({
          body:
            accounts.length === 1
              ? `${integration.name} disconnected. Its models are no longer available.`
              : `${account.label} removed. ${integration.name} will no longer use this account.`,
          isAutoHide: true,
        });
        setRemoving(null);
      })
      .catch((err: unknown) =>
        showToast({ body: messageOf(err), type: "error" }),
      )
      .finally(() => setBusy(false));
  };

  let control = (
    <Text size="sm" color="secondary">
      Connected from your environment variables
    </Text>
  );
  if (active !== undefined) {
    const items: DropdownMenuOption[] = [];
    if (accounts.length > 1)
      items.push(
        {
          type: "section",
          title: "Accounts",
          items: accounts.map((account) => ({
            label: account.label,
            // An empty slot keeps the names lined up beside the check.
            icon: account === active ? CheckIcon : NoIcon,
            onClick: () => {
              if (account !== active) use(account);
            },
          })),
        },
        { type: "divider" },
      );
    items.push(
      {
        label: `Rename ${active.label}`,
        icon: PencilIcon,
        onClick: () => setRenaming(true),
      },
      { label: "Add account", icon: PlusIcon, onClick: onAddAccount },
      { type: "divider" },
      {
        label: `Remove ${active.label}…`,
        icon: Trash2Icon,
        variant: "destructive",
        onClick: () => setRemoving(active),
      },
    );
    control = renaming ? (
      <AccountName account={active} onDone={() => setRenaming(false)} />
    ) : (
      <DropdownMenu
        button={{
          label: active.label,
          variant: "secondary",
          size: "sm",
          "aria-label": `Manage ${integration.name} accounts`,
        }}
        items={items}
      />
    );
  }

  return (
    <Row
      title={
        <span className="flex items-center gap-2">
          {integration.name}
          <Badge label={sourceLabel(integration)} />
        </span>
      }
    >
      {control}
      <AlertDialog
        isOpen={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title={`Remove ${removing?.label ?? ""}?`}
        description={
          accounts.length === 1
            ? `${integration.name} will be disconnected and its models will no longer be available.`
            : `${integration.name} will no longer use this account.`
        }
        actionLabel="Remove"
        isActionLoading={busy}
        onAction={() => (removing ? remove(removing) : undefined)}
      />
    </Row>
  );
}

export function Providers() {
  const version = useSelector(catalogVersion);
  const { data, error } = useLoad(() => ocClient.listIntegrations(), version);
  const [dialog, setDialog] = useState<{
    isOpen: boolean;
    start: IntegrationInfo | null;
  }>({ isOpen: false, start: null });
  const all = data ?? [];
  const connected = connectedOf(all);
  const popular = popularOf(all);
  const connect = (start: IntegrationInfo | null) =>
    setDialog({ isOpen: true, start });

  return (
    <>
      <Section title="Connected providers">
        {error && data === null ? (
          <Note text={error} />
        ) : data === null ? (
          <Note text="Loading…" />
        ) : connected.length === 0 ? (
          <Note text="No connected providers" />
        ) : (
          connected.map((integration) => (
            <ConnectedRow
              key={integration.id}
              integration={integration}
              onAddAccount={() => connect(integration)}
            />
          ))
        )}
      </Section>
      <Section title="Popular providers">
        {popular.map((integration) => (
          <Row
            key={integration.id}
            title={
              <span className="flex items-center gap-2">
                {integration.name}
                {isRecommended(integration.id) ? (
                  <Badge label="Recommended" />
                ) : null}
              </span>
            }
          >
            <Button
              label="Connect"
              variant="secondary"
              size="sm"
              icon={<Icon icon={PlusIcon} size="sm" />}
              onClick={() => connect(integration)}
            />
          </Row>
        ))}
        <div className="px-2 py-1.5">
          <Button
            label="Show more providers"
            variant="ghost"
            size="sm"
            isDisabled={data === null}
            onClick={() => connect(null)}
          />
        </div>
      </Section>
      <ConnectDialog
        isOpen={dialog.isOpen}
        start={dialog.start}
        integrations={all}
        onClose={() => setDialog({ isOpen: false, start: null })}
      />
    </>
  );
}
