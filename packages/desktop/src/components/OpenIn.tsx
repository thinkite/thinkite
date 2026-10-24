import { Button } from "@astryxdesign/core/Button";
import { ButtonGroup } from "@astryxdesign/core/ButtonGroup";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { Icon } from "@astryxdesign/core/Icon";
import { useQuery } from "@tanstack/react-query";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { useState } from "react";

// "Open in" for the session's folder, after DeepSeek Harness's split
// button: the icon opens the folder in the app last picked from the
// chevron's list of installed apps (server/open-in.ts), Finder until one
// is. As in OpenCode desktop, a pick is kept whether or not the app
// opened, and an app no longer installed falls back to Finder.

/** Must match server/open-in's OpenInApp. */
interface OpenInApp {
  id: string;
  name: string;
}

const FINDER: OpenInApp = { id: "finder", name: "Finder" };
const KEY = "thinkite:open-in";

function readChoice(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

function saveChoice(id: string): void {
  try {
    localStorage.setItem(KEY, id);
  } catch {
    // Private mode: the choice still holds for this run.
  }
}

function AppIcon({ app }: { app: OpenInApp }) {
  return (
    <img
      src={`/api/open-in/icon?app=${encodeURIComponent(app.id)}`}
      alt=""
      className="size-4 shrink-0"
      draggable={false}
    />
  );
}

function open(app: OpenInApp, directory: string): void {
  void fetch(
    `/api/open-in?app=${encodeURIComponent(app.id)}&directory=${encodeURIComponent(directory)}`,
    { method: "POST" },
  )
    .then(async (res) => {
      if (!res.ok) throw new Error(await res.text());
    })
    .catch((err) => console.warn(`[open-in] ${app.name} failed:`, err));
}

export function OpenIn({ directory }: { directory: string }) {
  const { data: apps = [FINDER] } = useQuery({
    queryKey: ["open-in"],
    queryFn: async () => {
      const res = await fetch("/api/open-in");
      if (!res.ok) throw new Error(await res.text());
      return (await res.json()) as OpenInApp[];
    },
  });
  const [choice, setChoice] = useState(readChoice);
  const current = apps.find((a) => a.id === choice) ?? FINDER;

  const pick = (app: OpenInApp) => {
    saveChoice(app.id);
    setChoice(app.id);
    open(app, directory);
  };

  return (
    <ButtonGroup label="Open in" size="sm">
      <Button
        label={`Open in ${current.name}`}
        tooltip={`Open in ${current.name}`}
        variant="secondary"
        size="sm"
        isIconOnly
        icon={<AppIcon app={current} />}
        onClick={() => open(current, directory)}
      />
      <DropdownMenu
        button={{
          label: "Open in…",
          icon: <Icon icon={ChevronDownIcon} size="sm" />,
          variant: "secondary",
          size: "sm",
          isIconOnly: true,
        }}
        hasChevron={false}
        alignment="end"
        items={apps.map((app) => ({
          id: app.id,
          label: app.name,
          icon: <AppIcon app={app} />,
          endContent:
            app.id === current.id ? (
              <Icon icon={CheckIcon} size="sm" />
            ) : undefined,
          onClick: () => pick(app),
        }))}
      />
    </ButtonGroup>
  );
}
