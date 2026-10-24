import { Button } from "@astryxdesign/core/Button";
import { ButtonGroup } from "@astryxdesign/core/ButtonGroup";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { Icon } from "@astryxdesign/core/Icon";
import { useQuery } from "@tanstack/react-query";
import { ChevronDownIcon } from "lucide-react";

// "Open in" for the session's folder, after DeepSeek Harness's split
// button: Finder's icon opens the folder there, and the chevron lists the
// other installed apps (server/open-in.ts).

/** Must match server/open-in's OpenInApp. */
interface OpenInApp {
  id: string;
  name: string;
}

const FINDER: OpenInApp = { id: "finder", name: "Finder" };

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

  return (
    <ButtonGroup label="Open in" size="sm">
      <Button
        label="Open in Finder"
        tooltip="Open in Finder"
        variant="secondary"
        size="sm"
        isIconOnly
        icon={<AppIcon app={FINDER} />}
        onClick={() => open(FINDER, directory)}
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
          onClick: () => open(app, directory),
        }))}
      />
    </ButtonGroup>
  );
}
