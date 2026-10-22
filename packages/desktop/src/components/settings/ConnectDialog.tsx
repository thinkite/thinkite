import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Icon } from "@astryxdesign/core/Icon";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useToast } from "@astryxdesign/core/Toast";
import type {
  FormAnswer,
  IntegrationAttempt,
  IntegrationInfo,
} from "@thinkite/oc-client";
import { ChevronLeftIcon, ExternalLinkIcon } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { catalogVersion, ocClient } from "../../lib/oc";
import { type Field, FormFields, initialAnswer } from "../FormFields";
import {
  accountsOf,
  confirmationCode,
  isRecommended,
  pickerGroups,
  type UsableMethod,
  usableMethods,
} from "./providers-model";

// Connect a provider, after opencode desktop's connect dialog
// (`providers/connect/dialog.tsx` + `controller.ts` at v2.1.2, MIT): pick a
// provider, pick how (when it offers more than one way), answer the
// method's form if it has one, then paste a key, sign in in the browser, or
// let the service find external credentials. A browser sign-in either
// finishes on its own (the dialog polls each second) or asks for the code
// the page shows. On success the dialog closes with a toast; the bus moves
// the catalog version, so Settings and the model picker read again.

type Step =
  | { kind: "pick" }
  | { kind: "methods"; integration: IntegrationInfo }
  | {
      kind: "form";
      integration: IntegrationInfo;
      method: UsableMethod;
      answer: FormAnswer;
    }
  | { kind: "key"; integration: IntegrationInfo; answer?: FormAnswer }
  | {
      kind: "signin";
      integration: IntegrationInfo;
      method: Extract<UsableMethod, { type: "oauth" }>;
      attempt: IntegrationAttempt | null;
    }
  | {
      kind: "error";
      integration: IntegrationInfo;
      method: UsableMethod;
      message: string;
    };

const messageOf = (err: unknown, fallback: string) =>
  err instanceof Error && err.message !== "" ? err.message : fallback;

const visibleFields = (method: UsableMethod): Field[] =>
  ((method.form ?? []) as Field[]).filter((f) => !("hidden" in f && f.hidden));

function methodLabel(method: UsableMethod): string {
  if (method.type === "key") return method.label ?? "API key";
  return method.label;
}

/** A provider in the picker: its name, and how many accounts it has. */
function PickerRow({
  integration,
  onPick,
}: {
  integration: IntegrationInfo;
  onPick: () => void;
}) {
  const accounts = accountsOf(integration).length;
  return (
    <button
      type="button"
      onClick={onPick}
      className="flex w-full cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-left hover:bg-[var(--color-overlay-hover)]"
    >
      <Text size="sm">{integration.name}</Text>
      {isRecommended(integration.id) && accounts === 0 ? (
        <Badge label="Recommended" />
      ) : null}
      <span className="flex-1" />
      {accounts > 0 ? (
        <span
          role="img"
          aria-label={`${accounts} ${accounts === 1 ? "account" : "accounts"}`}
        >
          <Badge label={String(accounts)} />
        </span>
      ) : null}
    </button>
  );
}

function Picker({
  integrations,
  onPick,
}: {
  integrations: readonly IntegrationInfo[];
  onPick: (integration: IntegrationInfo) => void;
}) {
  const [query, setQuery] = useState("");
  const { popular, other } = pickerGroups(integrations, query);
  const group = (title: string, rows: IntegrationInfo[]) =>
    rows.length > 0 ? (
      <div className="flex flex-col gap-0.5">
        <div className="px-3 pt-2 pb-1">
          <Text size="sm" color="secondary">
            {title}
          </Text>
        </div>
        {rows.map((i) => (
          <PickerRow key={i.id} integration={i} onPick={() => onPick(i)} />
        ))}
      </div>
    ) : null;
  return (
    <div className="flex min-h-0 flex-col gap-2">
      <TextInput
        label="Search providers"
        isLabelHidden
        placeholder="Search providers"
        value={query}
        onChange={setQuery}
        hasAutoFocus
      />
      <div className="-mx-3 max-h-[52vh] overflow-y-auto">
        {popular.length === 0 && other.length === 0 ? (
          <div className="px-3 py-4">
            <Text size="sm" color="secondary">
              No providers found
            </Text>
          </div>
        ) : (
          <>
            {group("Popular", popular)}
            {group("Other", other)}
          </>
        )}
      </div>
    </div>
  );
}

function KeyStep({
  integration,
  onSubmit,
}: {
  integration: IntegrationInfo;
  onSubmit: (key: string) => Promise<void>;
}) {
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = () => {
    if (busy) return;
    if (key.trim() === "") {
      setError("API key is required");
      return;
    }
    setBusy(true);
    setError(null);
    onSubmit(key.trim()).catch((err: unknown) => {
      setError(messageOf(err, "Couldn't save the key"));
      setBusy(false);
    });
  };
  return (
    <div className="flex flex-col gap-3">
      <Text size="sm" color="secondary">
        {`Enter your ${integration.name} API key to connect your account and use ${integration.name} models in Thinkite.`}
      </Text>
      <TextInput
        type="password"
        label={`${integration.name} API key`}
        placeholder="API key"
        htmlName="apiKey"
        autoComplete="off"
        value={key}
        onChange={setKey}
        onEnter={submit}
        hasAutoFocus
        {...(error !== null
          ? { status: { type: "error" as const, message: error } }
          : {})}
      />
      <div className="flex justify-end">
        <Button
          label="Connect"
          variant="primary"
          isLoading={busy}
          onClick={submit}
        />
      </div>
    </div>
  );
}

function SignInStep({
  integration,
  attempt,
  onComplete,
}: {
  integration: IntegrationInfo;
  attempt: IntegrationAttempt | null;
  onComplete: (code: string) => Promise<void>;
}) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (attempt === null)
    return (
      <div className="flex items-center gap-2 py-2">
        <Spinner size="sm" label="Starting sign-in" />
        <Text size="sm" color="secondary">
          Authorization in progress…
        </Text>
      </div>
    );
  const open = () => window.open(attempt.url, "_blank");
  const confirm = confirmationCode(attempt.url, attempt.instructions);
  const submit = () => {
    if (busy) return;
    if (code.trim() === "") {
      setError("Authorization code is required");
      return;
    }
    setBusy(true);
    setError(null);
    onComplete(code.trim()).catch((err: unknown) => {
      setError(messageOf(err, "Invalid authorization code"));
      setBusy(false);
    });
  };
  return (
    <div className="flex flex-col gap-3">
      <Text size="sm" color="secondary">
        {attempt.mode === "code"
          ? `Your browser opens so you can sign in to ${integration.name}. Paste the authorization code it gives you below.`
          : `Your browser opens so you can sign in to ${integration.name}. Come back here when you are done.`}
      </Text>
      {confirm !== null ? (
        <div className="flex flex-col gap-1">
          <Text size="sm" weight="medium">
            {`Confirmation code: ${confirm}`}
          </Text>
          <Text size="sm" color="secondary">
            Check that your browser shows the same code before you authorize.
          </Text>
        </div>
      ) : null}
      {attempt.mode === "code" ? (
        <TextInput
          label="Authorization code"
          placeholder="Authorization code"
          value={code}
          onChange={setCode}
          onEnter={submit}
          hasAutoFocus
          {...(error !== null
            ? { status: { type: "error" as const, message: error } }
            : {})}
        />
      ) : (
        <div className="flex items-center gap-2">
          <Spinner size="sm" label="Waiting for authorization" />
          <Text size="sm" color="secondary">
            Waiting for authorization…
          </Text>
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button
          label="Open browser"
          variant="secondary"
          icon={<Icon icon={ExternalLinkIcon} size="sm" />}
          onClick={open}
        />
        {attempt.mode === "code" ? (
          <Button
            label="Continue"
            variant="primary"
            isLoading={busy}
            onClick={submit}
          />
        ) : null}
      </div>
    </div>
  );
}

/**
 * `start`: open straight on this provider (a Connect button, "Add
 * account"), or on the picker when null.
 */
export function ConnectDialog({
  isOpen,
  start,
  integrations,
  onClose,
}: {
  isOpen: boolean;
  start: IntegrationInfo | null;
  integrations: readonly IntegrationInfo[];
  onClose: () => void;
}) {
  const showToast = useToast();
  const [step, setStep] = useState<Step>({ kind: "pick" });
  // Counts openings: the dialog stays mounted while closed, so each opening
  // remounts its body and starts with empty fields.
  const [opening, setOpening] = useState(0);
  // The sign-in in flight, cancelled on back, close and unmount.
  const attempt = useRef<{ integrationID: string; attemptID: string } | null>(
    null,
  );

  const cancelAttempt = () => {
    const current = attempt.current;
    attempt.current = null;
    if (current)
      void ocClient
        .cancelOAuth(current.integrationID, current.attemptID)
        .catch(() => {});
  };

  const finish = (integration: IntegrationInfo) => {
    attempt.current = null;
    // Off the sign-in step, so nothing keeps polling a finished attempt
    // (the dialog stays mounted while closed).
    setStep({ kind: "pick" });
    catalogVersion.set((v) => v + 1);
    showToast({
      body: `${integration.name} connected. Its models are now available to use.`,
      isAutoHide: true,
    });
    onClose();
  };

  const fail = (
    integration: IntegrationInfo,
    method: UsableMethod,
    err: unknown,
  ) =>
    setStep({
      kind: "error",
      integration,
      method,
      message: messageOf(err, "Something went wrong"),
    });

  /** Run a method once its form (if any) is answered. */
  const run = (
    integration: IntegrationInfo,
    method: UsableMethod,
    answer: FormAnswer | undefined,
  ) => {
    if (method.type === "key") {
      setStep({ kind: "key", integration, ...(answer ? { answer } : {}) });
      return;
    }
    if (method.type === "external") {
      ocClient
        .connectExternal(integration.id, method.id, answer)
        .then(() => finish(integration))
        .catch((err: unknown) => fail(integration, method, err));
      return;
    }
    setStep({ kind: "signin", integration, method, attempt: null });
    ocClient
      .startOAuth(integration.id, method.id, answer)
      .then((started) => {
        attempt.current = {
          integrationID: integration.id,
          attemptID: started.attemptID,
        };
        window.open(started.url, "_blank");
        setStep({ kind: "signin", integration, method, attempt: started });
      })
      .catch((err: unknown) => fail(integration, method, err));
  };

  const choose = (integration: IntegrationInfo, method: UsableMethod) => {
    if (visibleFields(method).length > 0) {
      setStep({
        kind: "form",
        integration,
        method,
        answer: initialAnswer((method.form ?? []) as Field[]),
      });
      return;
    }
    // Hidden fields still send their defaults.
    const defaults = method.form
      ? initialAnswer(method.form as Field[])
      : undefined;
    run(integration, method, defaults);
  };

  const pick = (integration: IntegrationInfo) => {
    const methods = usableMethods(integration);
    const only = methods[0];
    if (methods.length === 1 && only !== undefined) choose(integration, only);
    else setStep({ kind: "methods", integration });
  };

  // Each opening starts over: on the provider asked for, or the picker.
  // Keyed on the provider's id: the list is re-read while a sign-in runs
  // (the bus moves the catalog), and a fresh copy of the same provider
  // must not restart it.
  const startID = start?.id ?? null;
  const startRef = useRef(start);
  startRef.current = start;
  useEffect(() => {
    if (!isOpen) return;
    setOpening((n) => n + 1);
    const target = startRef.current;
    if (target !== null) pick(target);
    else setStep({ kind: "pick" });
    return cancelAttempt;
  }, [isOpen, startID]);

  // An automatic sign-in finishes on the service: poll it each second
  // while the dialog is open, and stop at the first final status, which
  // the service keeps reporting afterwards.
  const signin = isOpen && step.kind === "signin" ? step : null;
  useEffect(() => {
    if (signin === null || signin.attempt?.mode !== "auto") return;
    const { integration, method } = signin;
    const attemptID = signin.attempt.attemptID;
    let stopped = false;
    const stop = () => {
      stopped = true;
      clearInterval(timer);
    };
    const timer = setInterval(() => {
      ocClient
        .oauthStatus(integration.id, attemptID)
        .then((status) => {
          if (stopped || status.status === "pending") return;
          stop();
          if (status.status === "complete") finish(integration);
          else if (status.status === "failed")
            fail(integration, method, new Error(status.message));
          else fail(integration, method, new Error("Authorization expired"));
        })
        .catch(() => {
          // A missed poll; the next one tries again.
        });
    }, 1000);
    return stop;
  }, [signin?.attempt?.attemptID]);

  const back = () => {
    cancelAttempt();
    if (step.kind === "pick") return;
    const integration = step.integration;
    const methods = usableMethods(integration);
    const atMethods =
      step.kind === "methods" ||
      methods.length === 1 ||
      (step.kind === "error" && methods.length === 1);
    if (atMethods) setStep({ kind: "pick" });
    else setStep({ kind: "methods", integration });
  };

  const close = () => {
    cancelAttempt();
    onClose();
  };

  let title = "Connect provider";
  let body: ReactNode = null;
  switch (step.kind) {
    case "pick":
      body = <Picker integrations={integrations} onPick={pick} />;
      break;
    case "methods": {
      title = `Connect ${step.integration.name}`;
      body = (
        <div className="flex flex-col gap-2">
          <Text size="sm" color="secondary">
            {`Select login method for ${step.integration.name}.`}
          </Text>
          {usableMethods(step.integration).map((method) => (
            <Button
              key={method.type === "key" ? "key" : method.id}
              label={methodLabel(method)}
              variant="secondary"
              style={{ width: "100%", justifyContent: "flex-start" }}
              onClick={() => choose(step.integration, method)}
            />
          ))}
        </div>
      );
      break;
    }
    case "form": {
      title = `Connect ${step.integration.name}`;
      body = (
        <div className="flex flex-col gap-3">
          <FormFields
            fields={(step.method.form ?? []) as Field[]}
            answer={step.answer}
            onChange={(answer) => setStep({ ...step, answer })}
          />
          <div className="flex justify-end">
            <Button
              label="Continue"
              variant="primary"
              onClick={() => run(step.integration, step.method, step.answer)}
            />
          </div>
        </div>
      );
      break;
    }
    case "key":
      title = `Connect ${step.integration.name}`;
      body = (
        <KeyStep
          integration={step.integration}
          onSubmit={(key) =>
            ocClient
              .connectKey(step.integration.id, key, step.answer)
              .then(() => finish(step.integration))
          }
        />
      );
      break;
    case "signin": {
      title = `Connect ${step.integration.name}`;
      const current = step.attempt;
      body = (
        <SignInStep
          integration={step.integration}
          attempt={current}
          onComplete={(code) =>
            current === null
              ? Promise.resolve()
              : ocClient
                  .completeOAuth(step.integration.id, current.attemptID, code)
                  .then(() => finish(step.integration))
          }
        />
      );
      break;
    }
    case "error":
      title = `Connect ${step.integration.name}`;
      body = (
        <div className="flex flex-col gap-3">
          <Banner
            status="error"
            title={`Authorization failed: ${step.message}`}
          />
          <div className="flex justify-end">
            <Button
              label="Try again"
              variant="secondary"
              onClick={() => choose(step.integration, step.method)}
            />
          </div>
        </div>
      );
      break;
  }

  return (
    <Dialog
      isOpen={isOpen}
      onOpenChange={(next) => {
        if (!next) close();
      }}
      width={460}
    >
      <DialogHeader
        title={title}
        onOpenChange={(next) => {
          if (!next) close();
        }}
        {...(step.kind !== "pick"
          ? {
              startContent: (
                <Button
                  label="Navigate back"
                  variant="ghost"
                  size="sm"
                  isIconOnly
                  icon={<Icon icon={ChevronLeftIcon} size="sm" />}
                  onClick={back}
                />
              ),
            }
          : {})}
      />
      <div key={opening} className="pt-3">
        {body}
      </div>
    </Dialog>
  );
}
