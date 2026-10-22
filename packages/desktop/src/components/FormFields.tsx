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
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import type { FormAnswer } from "@thinkite/oc-client";
import type { useForms } from "@thinkite/oc-client/react";

// opencode's form fields, as a question card asks them and as a provider's
// sign-in asks for its settings (an account name, a GitLab URL): one input
// per field, hidden fields left out, defaults filled in.

export type Field = ReturnType<typeof useForms>[number]["fields"][number];
type Value = FormAnswer[string];

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

/** The answer before the user touches anything: each field's default. */
export function initialAnswer(fields: readonly Field[]): FormAnswer {
  const answer: FormAnswer = {};
  for (const field of fields) {
    if (field.type === "external") continue;
    if ("default" in field && field.default !== undefined)
      answer[field.key] = field.default;
  }
  return answer;
}

/** The fields not marked hidden, each with its title above its input. */
export function FormFields({
  fields,
  answer,
  onChange,
}: {
  fields: readonly Field[];
  answer: FormAnswer;
  onChange: (next: FormAnswer) => void;
}) {
  return (
    <>
      {fields
        .filter((field) => !("hidden" in field && field.hidden))
        .map((field) => (
          <div key={field.key} className="flex flex-col gap-1.5">
            {field.type !== "external" && (field.title || field.description) ? (
              <Text size="sm" color="secondary">
                {field.title ?? field.description}
              </Text>
            ) : null}
            <FieldInput
              field={field}
              value={answer[field.key]}
              onChange={(next) => onChange({ ...answer, [field.key]: next })}
            />
          </div>
        ))}
    </>
  );
}
