import type { FormAnswer } from "@thinkite/oc-client";
import {
  useForms,
  usePermissions,
  useReplying,
} from "@thinkite/oc-client/react";
import { SymbolView } from "expo-symbols";
import { type ReactNode, useState } from "react";
import {
  Linking,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  useColorScheme,
  View,
} from "react-native";
import { ocStore } from "@/lib/oc";
import { ComposerGlass } from "./composer-glass";

// Permission requests and questions (opencode "forms") for the open session.
// As in opencode's own iOS app (and the desktop's Prompts.tsx), a pending
// one takes the composer's place — the turn waits on the user, so there is
// nothing else to type — on the composer's own glass. The card stays, its
// controls disabled, until the service has the answer (store.replyPermission
// / replyForm), and goes only then.
//
//   Read                                Question title               (×)
//   test.env                            Which color do you prefer?
//   [ Allow Once ] [ Always Allow ]     ○ Red
//   Tell it what to do instead  [Deny]  ○ Green
//                                       ○ Answer in your own words   (↑)

type PermissionRequest = ReturnType<typeof usePermissions>[number];
type FormInfo = ReturnType<typeof useForms>[number];
type Field = FormInfo["fields"][number];
type Value = FormAnswer[string];

function report(err: unknown) {
  console.warn("[prompt-card] answer failed:", err);
}

/** iOS systemBlue, the app's accent (see input-bar.tsx). */
const ACCENT = "#007aff";

function PermissionCard({ request }: { request: PermissionRequest }) {
  const busy = useReplying(ocStore, request.id);
  const [instead, setInstead] = useState("");
  const scheme = useColorScheme();
  const reply = (decision: "once" | "always" | "reject") => {
    const message = decision === "reject" ? instead.trim() : "";
    ocStore
      .replyPermission(request, decision, message === "" ? undefined : message)
      .catch(report);
  };
  const shown = request.resources.slice(0, 3);
  return (
    <View className="p-4 gap-3" style={{ opacity: busy ? 0.5 : 1 }}>
      <View className="gap-1">
        <Text className="text-sm text-zinc-500 dark:text-zinc-400">
          {request.action.charAt(0).toUpperCase() + request.action.slice(1)}
        </Text>
        {request.message ? (
          <Text className="text-sm text-zinc-700 dark:text-zinc-300">
            {request.message}
          </Text>
        ) : null}
        {shown.map((resource) => (
          <Text
            key={resource}
            numberOfLines={2}
            // The transcript's code font (lib/markdown/chat-markdown.tsx).
            style={{ fontFamily: "JetBrains Mono" }}
            className="text-sm text-black dark:text-white"
          >
            {resource}
          </Text>
        ))}
        {request.resources.length > shown.length ? (
          <Text className="text-sm text-zinc-500 dark:text-zinc-400">
            {`+${request.resources.length - shown.length} more`}
          </Text>
        ) : null}
      </View>
      <View className="flex-row gap-2">
        <PillButton
          label="Allow Once"
          disabled={busy}
          onPress={() => reply("once")}
        />
        <PillButton
          label="Always Allow"
          prominent
          disabled={busy}
          onPress={() => reply("always")}
        />
      </View>
      <View className="flex-row items-center gap-2">
        <TextInput
          value={instead}
          onChangeText={setInstead}
          editable={!busy}
          placeholder="Tell it what to do instead"
          placeholderTextColor={scheme === "dark" ? "#71717a" : "#a1a1aa"}
          className="flex-1 py-2 text-base text-black dark:text-white"
        />
        <Pressable
          onPress={() => reply("reject")}
          disabled={busy}
          accessibilityRole="button"
          className="px-4 py-2 rounded-full bg-black/5 dark:bg-white/10"
        >
          <Text className="text-[15px] font-semibold text-black dark:text-white">
            Deny
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

function PillButton({
  label,
  prominent = false,
  disabled,
  onPress,
}: {
  label: string;
  prominent?: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      className={
        prominent
          ? "flex-1 h-11 items-center justify-center rounded-full"
          : "flex-1 h-11 items-center justify-center rounded-full bg-black/5 dark:bg-white/10"
      }
      style={prominent ? { backgroundColor: ACCENT } : undefined}
    >
      <Text
        className={
          prominent
            ? "text-[15px] font-semibold text-white"
            : "text-[15px] font-semibold text-black dark:text-white"
        }
      >
        {label}
      </Text>
    </Pressable>
  );
}

/** The answer before the user touches anything: each field's default. */
function initialAnswer(fields: readonly Field[]): FormAnswer {
  const answer: FormAnswer = {};
  for (const field of fields) {
    if (field.type === "external") continue;
    if (field.default !== undefined) answer[field.key] = field.default;
  }
  return answer;
}

const isAnswered = (value: Value | undefined) =>
  value !== undefined &&
  value !== "" &&
  !(Array.isArray(value) && value.length === 0);

function FormCard({ form }: { form: FormInfo }) {
  const busy = useReplying(ocStore, form.id);
  const [answer, setAnswer] = useState<FormAnswer>(() =>
    initialAnswer(form.fields),
  );
  // "Answer in your own words" text per field, kept apart from the answer
  // so picking an option afterwards unpicks it without erasing it (as in
  // opencode's app); its circle picks it again.
  const [typed, setTyped] = useState<Record<string, string>>({});
  const scheme = useColorScheme();
  const fields = form.fields.filter(
    (field) => !("hidden" in field && field.hidden),
  );
  // opencode's question tool titles the form "Questions" and each field
  // with a short title over the question itself. One field: its title
  // heads the card, as in opencode's app.
  const only = fields.length === 1 ? fields[0] : undefined;
  const heading = only?.title ?? form.title;
  const last = fields.at(-1);
  // The last field's own answer sits in the footer beside the submit
  // arrow, as opencode's app does with "Answer in your own words".
  const footerField =
    last !== undefined && hasCustomInput(last) ? last : undefined;
  // opencode's question tool leaves `required` unset, so a field counts as
  // required unless it says otherwise: Skip (×) is the way to not answer.
  const canSubmit = fields.every(
    (field) =>
      field.type === "external" ||
      field.required === false ||
      isAnswered(answer[field.key]),
  );
  const set = (key: string, value: Value) =>
    setAnswer((prev) => ({ ...prev, [key]: value }));
  const type = (key: string, text: string) =>
    setTyped((prev) => ({ ...prev, [key]: text }));
  const submit = () => {
    if (canSubmit) ocStore.replyForm(form, answer).catch(report);
  };

  return (
    <View className="p-4 gap-3" style={{ opacity: busy ? 0.5 : 1 }}>
      <View className="flex-row items-center gap-2">
        <Text
          numberOfLines={1}
          className="flex-1 text-sm text-zinc-500 dark:text-zinc-400"
        >
          {heading}
        </Text>
        <Pressable
          onPress={() => ocStore.cancelForm(form).catch(report)}
          disabled={busy}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Dismiss"
          className="size-7 items-center justify-center rounded-full bg-black/5 dark:bg-white/10"
        >
          <SymbolView
            name="xmark"
            size={12}
            weight="semibold"
            tintColor={scheme === "dark" ? "#a1a1aa" : "#52525b"}
          />
        </Pressable>
      </View>
      {/* A long question scrolls inside the card rather than pushing the
          card up over the transcript. */}
      <ScrollView
        style={{ maxHeight: 360 }}
        keyboardShouldPersistTaps="handled"
      >
        <View className="gap-4">
          {fields.map((field) => (
            <FieldInput
              key={field.key}
              field={field}
              value={answer[field.key]}
              onChange={(v) => set(field.key, v)}
              text={typed[field.key] ?? ""}
              onText={(t) => type(field.key, t)}
              withCustom={field !== footerField}
              withTitle={only === undefined}
              disabled={busy}
            />
          ))}
        </View>
      </ScrollView>
      <View className="flex-row items-center gap-2">
        {footerField !== undefined ? (
          <CustomRow
            field={footerField}
            value={answer[footerField.key]}
            onChange={(v) => set(footerField.key, v)}
            text={typed[footerField.key] ?? ""}
            onText={(t) => type(footerField.key, t)}
            disabled={busy}
          />
        ) : (
          <View className="flex-1" />
        )}
        <Pressable
          onPress={submit}
          disabled={busy || !canSubmit}
          accessibilityRole="button"
          accessibilityLabel="Submit"
          style={{ opacity: canSubmit ? 1 : 0.4 }}
          className="p-1.75 items-center justify-center rounded-full bg-zinc-900 dark:bg-zinc-100"
        >
          <SymbolView
            name="arrow.up"
            size={22}
            weight="semibold"
            tintColor={scheme === "dark" ? "#0a0a0a" : "#fafafa"}
          />
        </Pressable>
      </View>
    </View>
  );
}

/** A field that also takes a typed answer besides its options. */
const hasCustomInput = (field: Field) =>
  (field.type === "string" &&
    field.options !== undefined &&
    field.options.length > 0 &&
    field.custom === true) ||
  (field.type === "multiselect" && field.custom === true);

const choices = (field: Field) =>
  field.type === "boolean"
    ? [
        { value: "yes", label: "Yes" },
        { value: "no", label: "No" },
      ]
    : field.type === "multiselect" ||
        (field.type === "string" && field.options !== undefined)
      ? (field.options ?? [])
      : [];

/** The options a value has picked: one for a single choice, any for a
 *  multiselect. A typed custom answer is a value no option has. */
function picked(field: Field, value: Value | undefined): readonly string[] {
  if (field.type === "boolean")
    return value === true ? ["yes"] : value === false ? ["no"] : [];
  if (Array.isArray(value)) return value;
  return typeof value === "string" ? [value] : [];
}

function FieldInput({
  field,
  value,
  onChange,
  text,
  onText,
  withCustom,
  withTitle,
  disabled,
}: {
  field: Field;
  value: Value | undefined;
  onChange: (next: Value) => void;
  text: string;
  onText: (next: string) => void;
  withCustom: boolean;
  /** Show the field's title over its question; off when it heads the card. */
  withTitle: boolean;
  disabled: boolean;
}) {
  const scheme = useColorScheme();
  // The question is the description; a field without one is asked by its
  // title, unless that already heads the card.
  const question = field.description ?? (withTitle ? field.title : undefined);
  const caption =
    withTitle && field.description !== undefined ? field.title : undefined;
  let body: ReactNode;
  if (field.type === "external") {
    body = (
      <Pressable
        onPress={() => void Linking.openURL(field.url)}
        accessibilityRole="link"
      >
        <Text className="text-base" style={{ color: ACCENT }}>
          {field.title ?? field.description ?? field.url}
        </Text>
      </Pressable>
    );
    return body;
  }
  const options = choices(field);
  if (options.length > 0) {
    const chosen = picked(field, value);
    const multi = field.type === "multiselect";
    const toggle = (option: string) => {
      if (field.type === "boolean") onChange(option === "yes");
      else if (multi)
        onChange(
          chosen.includes(option)
            ? chosen.filter((v) => v !== option)
            : [...chosen, option],
        );
      else onChange(option);
    };
    body = (
      <View>
        {options.map((option) => (
          <OptionRow
            key={option.value}
            label={option.label}
            description={
              "description" in option ? option.description : undefined
            }
            selected={chosen.includes(option.value)}
            multi={multi}
            disabled={disabled}
            onPress={() => toggle(option.value)}
          />
        ))}
        {withCustom && hasCustomInput(field) ? (
          <View className="py-2.5 flex-row items-center">
            <CustomRow
              field={field}
              value={value}
              onChange={onChange}
              text={text}
              onText={onText}
              disabled={disabled}
            />
          </View>
        ) : null}
      </View>
    );
  } else {
    body = (
      <TextInput
        value={value === undefined ? "" : String(value)}
        onChangeText={(text) =>
          onChange(
            field.type === "number" || field.type === "integer"
              ? Number(text)
              : text,
          )
        }
        editable={!disabled}
        keyboardType={
          field.type === "number" || field.type === "integer"
            ? "decimal-pad"
            : "default"
        }
        placeholder={
          field.type === "string"
            ? (field.placeholder ?? "Type your answer")
            : ""
        }
        placeholderTextColor={scheme === "dark" ? "#71717a" : "#a1a1aa"}
        className="py-2 text-base text-black dark:text-white"
      />
    );
  }
  return (
    <View className="gap-1">
      {caption ? (
        <Text className="text-sm text-zinc-500 dark:text-zinc-400">
          {caption}
        </Text>
      ) : null}
      {question ? (
        <Text className="text-base font-medium text-black dark:text-white">
          {question}
        </Text>
      ) : null}
      {body}
    </View>
  );
}

function OptionRow({
  label,
  description,
  selected,
  multi,
  disabled,
  onPress,
}: {
  label: string;
  description: string | undefined;
  selected: boolean;
  multi: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  const scheme = useColorScheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole={multi ? "checkbox" : "radio"}
      accessibilityState={{ checked: selected }}
      className="py-2.5 flex-row items-center gap-3"
    >
      <SymbolView
        name={
          multi
            ? selected
              ? "checkmark.square.fill"
              : "square"
            : selected
              ? "checkmark.circle.fill"
              : "circle"
        }
        size={20}
        tintColor={
          selected ? ACCENT : scheme === "dark" ? "#52525b" : "#a1a1aa"
        }
      />
      <View className="flex-1">
        <Text className="text-base text-black dark:text-white">{label}</Text>
        {/* opencode's question tool often repeats the label here. */}
        {description && description !== label ? (
          <Text className="text-sm text-zinc-500 dark:text-zinc-400">
            {description}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

/** "Answer in your own words": a typed answer that no option has. For a
 *  single choice it is the pick while picked; for a multiselect it is one
 *  more entry beside the picked options. Typing picks it; picking an option
 *  of a single choice unpicks it but keeps the text, which the circle picks
 *  again. */
function CustomRow({
  field,
  value,
  onChange,
  text,
  onText,
  disabled,
}: {
  field: Field;
  value: Value | undefined;
  onChange: (next: Value) => void;
  text: string;
  onText: (next: string) => void;
  disabled: boolean;
}) {
  const scheme = useColorScheme();
  const multi = field.type === "multiselect";
  const known = new Set(choices(field).map((o) => o.value));
  const chosen = picked(field, value);
  const options = chosen.filter((v) => known.has(v));
  const selected = text !== "" && chosen.includes(text) && !known.has(text);
  const pick = (next: string) => {
    if (multi) onChange(next === "" ? options : [...options, next]);
    else onChange(next);
  };
  const write = (next: string) => {
    onText(next);
    pick(next);
  };
  const toggle = () => {
    if (selected) onChange(multi ? options : "");
    else if (text !== "") pick(text);
  };
  return (
    <View className="flex-1 flex-row items-center gap-3">
      <Pressable
        onPress={toggle}
        disabled={disabled}
        hitSlop={8}
        accessibilityRole={multi ? "checkbox" : "radio"}
        accessibilityState={{ checked: selected }}
      >
        <SymbolView
          name={
            multi
              ? selected
                ? "checkmark.square.fill"
                : "square"
              : selected
                ? "checkmark.circle.fill"
                : "circle"
          }
          size={20}
          tintColor={
            selected ? ACCENT : scheme === "dark" ? "#52525b" : "#a1a1aa"
          }
        />
      </Pressable>
      <TextInput
        value={text}
        onChangeText={write}
        editable={!disabled}
        placeholder="Answer in your own words"
        placeholderTextColor={scheme === "dark" ? "#71717a" : "#a1a1aa"}
        // A font size without the class's line height: iOS sets a single
        // line TextInput's text low when given one.
        style={{ fontSize: 16 }}
        className="flex-1 py-1 text-black dark:text-white"
      />
    </View>
  );
}

/**
 * The card for the session's oldest pending permission request or
 * question, or null when none waits. Requests come before questions, as
 * they arrive. Keyed by id so a new request starts with fresh state.
 */
export function usePendingPrompt(sessionID: string | null): ReactNode | null {
  const permissions = usePermissions(ocStore, sessionID);
  const forms = useForms(ocStore, sessionID);
  const permission = permissions[0];
  const form = forms[0];
  if (permission === undefined && form === undefined) return null;
  return (
    <ComposerGlass>
      {permission !== undefined ? (
        <PermissionCard key={permission.id} request={permission} />
      ) : form !== undefined ? (
        <FormCard key={form.id} form={form} />
      ) : null}
    </ComposerGlass>
  );
}
