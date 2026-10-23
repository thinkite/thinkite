// v2 model identity is `providerID/modelID` (split on the first `/` —
// model ids may contain `/`). The picker stores this string form.

export function parseModelRef(value: string): {
  providerID: string;
  id: string;
} {
  const slash = value.indexOf("/");
  if (slash < 0) return { providerID: value, id: "" };
  return { providerID: value.slice(0, slash), id: value.slice(slash + 1) };
}

export function formatModelRef(providerID: string, id: string): string {
  return `${providerID}/${id}`;
}

/** A reasoning variant as the effort pickers name it: "default" (no
 *  variant, the model's own setting), "xhigh", or the variant's id. */
export const variantLabel = (id: string) =>
  id === "default"
    ? "Default"
    : id === "xhigh"
      ? "Extra high"
      : id.charAt(0).toUpperCase() + id.slice(1);
