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
