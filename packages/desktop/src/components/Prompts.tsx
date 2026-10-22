import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import {
  CheckboxList,
  CheckboxListItem,
} from "@astryxdesign/core/CheckboxList";
import { Link } from "@astryxdesign/core/Link";
import { RadioList, RadioListItem } from "@astryxdesign/core/RadioList";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@astryxdesign/core/SegmentedControl";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import type { FormAnswer } from "@thinkite/oc-client";
import {
  useForms,
  usePermissions,
  useReplying,
} from "@thinkite/oc-client/react";
import { type ReactNode, useEffect, useState } from "react";
import { ocStore } from "../lib/oc";

// Permission requests and questions (opencode "forms") for the open session.
// Like DeepSeek Harness, a pending one takes the composer's place — the turn
// is waiting on the user, so there is nothing else to type — and the answer
// works the way opencode's own clients do: the card stays, its buttons
// disabled, until the service has the answer (store.replyPermission /
// replyForm), and goes only then.

type PermissionRequest = ReturnType<typeof usePermissions>[number];
type FormInfo = ReturnType<typeof useForms>[number];
type Field = FormInfo["fields"][number];
type Value = FormAnswer[string];

function report(err: unknown) {
  console.warn("[prompts] answer failed:", err);
}

function Shell({
  status,
  title,
  children,
  actions,
}: {
  status: string;
  title: string;
  children?: ReactNode;
  actions: ReactNode;
}) {
  return (
    <Card padding={4} elevation="high">
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <StatusDot variant="warning" label={status} />
          <Text size="sm" color="secondary">
            {status}
          </Text>
        </div>
        <Text size="base" weight="medium">
          {title}
        </Text>
        {children}
        <div className="flex items-center gap-2">{actions}</div>
      </div>
    </Card>
  );
}

function PermissionCard({ request }: { request: PermissionRequest }) {
  const busy = useReplying(ocStore, request.id);
  const reply = (decision: "once" | "always" | "reject") => {
    ocStore.replyPermission(request, decision).catch(report);
  };
  // Enter allows once, Escape rejects (DeepSeek Harness's keys).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (busy || e.isComposing) return;
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        reply("once");
      } else if (e.key === "Escape") {
        e.preventDefault();
        reply("reject");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  const shown = request.resources.slice(0, 6);
  return (
    <Shell
      status="Waiting for approval"
      title={`Allow ${request.action}?`}
      actions={
        <>
          <Button
            label="Allow once"
            variant="primary"
            isDisabled={busy}
            onClick={() => reply("once")}
          />
          <Button
            label="Always allow"
            variant="secondary"
            isDisabled={busy}
            onClick={() => reply("always")}
          />
          <div className="flex-1" />
          <Button
            label="Reject"
            variant="ghost"
            isDisabled={busy}
            onClick={() => reply("reject")}
          />
        </>
      }
    >
      {request.message ? (
        <Text size="sm" color="secondary">
          {request.message}
        </Text>
      ) : null}
      {shown.length > 0 ? (
        <div className="flex flex-col gap-0.5 font-mono text-[13px]">
          {shown.map((resource) => (
            <span key={resource} className="truncate">
              {resource}
            </span>
          ))}
          {request.resources.length > shown.length ? (
            <Text size="sm" color="secondary">
              {`+${request.resources.length - shown.length} more`}
            </Text>
          ) : null}
        </div>
      ) : null}
    </Shell>
  );
}

function FieldInput({
  field,
  value,
  onChange,
}: {
  field: Field;
  value: Value | undefined;
  onChange: (next: Value) => void;
}) {
  const label = field.title ?? field.description ?? field.key;
  if (field.type === "external") {
    return <Link href={field.url}>{label}</Link>;
  }
  if (field.type === "boolean") {
    return (
      <SegmentedControl
        label={label}
        value={value === true ? "yes" : value === false ? "no" : ""}
        onChange={(v) => onChange(v === "yes")}
      >
        <SegmentedControlItem value="yes" label="Yes" />
        <SegmentedControlItem value="no" label="No" />
      </SegmentedControl>
    );
  }
  if (field.type === "multiselect") {
    const chosen = Array.isArray(value) ? (value as readonly string[]) : [];
    return (
      <CheckboxList
        label={label}
        isLabelHidden
        value={[...chosen]}
        onChange={(next) => onChange(next)}
      >
        {field.options.map((option) => (
          <CheckboxListItem
            key={option.value}
            value={option.value}
            label={option.label}
          />
        ))}
      </CheckboxList>
    );
  }
  if (field.type === "string" && field.options && field.options.length > 0) {
    const options = field.options;
    const custom =
      typeof value === "string" && !options.some((o) => o.value === value)
        ? value
        : "";
    return (
      <div className="flex flex-col gap-2">
        <RadioList
          label={label}
          isLabelHidden
          value={typeof value === "string" ? value : ""}
          onChange={onChange}
        >
          {options.map((option) => (
            <RadioListItem
              key={option.value}
              value={option.value}
              label={option.label}
            />
          ))}
        </RadioList>
        {field.custom ? (
          <TextInput
            label="Your answer"
            isLabelHidden
            placeholder="Or type your answer"
            value={custom}
            onChange={onChange}
          />
        ) : null}
      </div>
    );
  }
  return (
    <TextInput
      label={label}
      isLabelHidden
      placeholder={
        field.type === "string" ? (field.placeholder ?? "Type your answer") : ""
      }
      value={value === undefined ? "" : String(value)}
      onChange={(text) =>
        onChange(
          field.type === "number" || field.type === "integer"
            ? Number(text)
            : text,
        )
      }
    />
  );
}

function initialAnswer(form: FormInfo): FormAnswer {
  const answer: FormAnswer = {};
  for (const field of form.fields) {
    if (field.type === "external") continue;
    if ("default" in field && field.default !== undefined)
      answer[field.key] = field.default;
  }
  return answer;
}

function FormCard({ form }: { form: FormInfo }) {
  const busy = useReplying(ocStore, form.id);
  const [answer, setAnswer] = useState<FormAnswer>(() => initialAnswer(form));
  const fields = form.fields.filter(
    (field) => !("hidden" in field && field.hidden),
  );
  return (
    <Shell
      status="Waiting for your answer"
      title={form.title}
      actions={
        <>
          <Button
            label="Submit"
            variant="primary"
            isDisabled={busy}
            onClick={() => ocStore.replyForm(form, answer).catch(report)}
          />
          <Button
            label="Skip"
            variant="ghost"
            isDisabled={busy}
            onClick={() => ocStore.cancelForm(form).catch(report)}
          />
        </>
      }
    >
      {fields.map((field) => (
        <div key={field.key} className="flex flex-col gap-1.5">
          {field.type !== "external" && (field.title || field.description) ? (
            <Text size="sm" color="secondary">
              {field.title ?? field.description}
            </Text>
          ) : null}
          <FieldInput
            field={field}
            value={answer[field.key]}
            onChange={(next) =>
              setAnswer((current) => ({ ...current, [field.key]: next }))
            }
          />
        </div>
      ))}
    </Shell>
  );
}

/**
 * The oldest pending permission request or question for the session, or
 * null when none waits. Requests come before questions, as they arrive.
 */
export function usePendingPrompt(sessionID: string): ReactNode | null {
  const permissions = usePermissions(ocStore, sessionID);
  const forms = useForms(ocStore, sessionID);
  const permission = permissions[0];
  if (permission !== undefined)
    return <PermissionCard key={permission.id} request={permission} />;
  const form = forms[0];
  if (form !== undefined) return <FormCard key={form.id} form={form} />;
  return null;
}
