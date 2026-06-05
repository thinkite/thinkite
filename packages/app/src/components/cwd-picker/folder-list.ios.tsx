import { Text as UiText } from "@expo/ui";
import {
  Button,
  Form,
  Host,
  HStack,
  Image,
  Section,
  Text as SwiftText,
  VStack,
} from "@expo/ui/swift-ui";
import { font, foregroundStyle, frame } from "@expo/ui/swift-ui/modifiers";
import { router } from "expo-router";
import { useFilesystemRoots } from "@/hooks/use-filesystem-roots";
import { useListDirectory } from "@/hooks/use-list-directory";
import { useDaemonClient } from "@/lib/daemon-client-context";

/**
 * iOS folder list for the cwd picker. Two modes:
 *
 *   1. Root (`path === undefined`) — Files-app "Browse" layout:
 *      Locations section (home + desktop + documents from daemon roots)
 *      followed by Recent section (daemon-reported recentCwds). Tapping
 *      any row pushes into that path via the standard cwd-picker URL.
 *   2. Browse (`path` defined) — listDirectory of that folder,
 *      same Files-app row visual as Locations/Recent for consistency.
 *
 * Both modes share the same swift-ui Form + Section + raw Button pattern
 * (see workaround discussion below). Loading/error/empty branches use
 * the StatusText helper — a Host + Universal Text — so the cold-state
 * background naturally matches the populated Form view.
 *
 * Why swift-ui namespace not Universal: in @expo/ui 56.0.13 the Universal
 * Button always emits a `buttonStyle()` SwiftUI modifier (`variant="text"`
 * → `.plain`), which overrides Form's automatic list-style row rendering
 * and produces chunky borderless buttons instead of native Settings-style
 * rows. The PR for a `variant="automatic"` that resolves to no modifier
 * (https://github.com/expo/expo/issues/45602) isn't shipped here yet.
 * Dropping to swift-ui lets us hand a bare `<Button>` to `<Form>`, and
 * the iOS list-style inheritance kicks in: full-row hit area, native
 * cell highlight on tap, automatic row separators, primary foreground
 * for the label, all free.
 */
export function FolderList({ path }: { path: string | undefined }) {
  if (path === undefined) {
    return <LocationsAndRecents />;
  }
  return <BrowseFolder path={path} />;
}

/**
 * Root mode — two-section list of starting points the user can drill into.
 * Both sections pull from the single `getFilesystemRoots` daemon call.
 *
 * Recent rows show only the basename for now; if real-world use surfaces
 * basename collisions (e.g. two projects each with a `src` cwd), add a
 * supporting line with the parent path — see commented-out `Subtitle`
 * pattern at the bottom of this file.
 */
function LocationsAndRecents() {
  const query = useFilesystemRoots();
  const { connectionStatus } = useDaemonClient();

  if (query.isPending) {
    // Offline → getFilesystemRoots hangs on the facade readyPromise
    // (auto-resumes on reconnect), so isPending alone would read as
    // "Loading…" forever. Distinguish on connection: online = genuinely
    // loading, otherwise = offline (it loads when the daemon reconnects).
    return (
      <StatusText>
        {connectionStatus === "online" ? "Loading…" : "Offline"}
      </StatusText>
    );
  }

  if (query.isError) {
    return (
      <StatusText>
        {query.error instanceof Error
          ? query.error.message
          : String(query.error)}
      </StatusText>
    );
  }

  const { home, desktop, documents, recentCwds } = query.data;

  // Build the Locations list. `home` is guaranteed; desktop/documents are
  // optional (cross-platform headroom — see protocol's getFilesystemRoots
  // response schema). Filter undefined entries with the type guard.
  const locations: { label: string; path: string }[] = [
    { label: "Home", path: home },
    desktop ? { label: "Desktop", path: desktop } : null,
    documents ? { label: "Documents", path: documents } : null,
  ].filter((x): x is { label: string; path: string } => x !== null);

  return (
    <Host style={{ flex: 1 }}>
      <Form>
        <Section title="Locations">
          {locations.map((loc) => (
            <PickerRow key={loc.path} label={loc.label} path={loc.path} />
          ))}
        </Section>
        {recentCwds.length > 0 && (
          <Section title="Recent">
            {recentCwds.map((entry) => (
              <PickerRow
                key={entry.path}
                label={basename(entry.path)}
                subtitle={tildify(parentDir(entry.path), home)}
                path={entry.path}
              />
            ))}
          </Section>
        )}
      </Form>
    </Host>
  );
}

/**
 * Browse mode — single-section list of subfolders, no Recents pollution.
 * Loading / error / empty handling kept tight; if perf bites later, this
 * is the obvious LegendList-on-RN-side candidate, but a single SwiftUI
 * Form should comfortably handle a few hundred folder rows.
 */
function BrowseFolder({ path }: { path: string }) {
  const query = useListDirectory(path);
  const { connectionStatus } = useDaemonClient();

  if (query.isPending) {
    // Same offline handling as the root list — see LocationsAndRecents.
    return (
      <StatusText>
        {connectionStatus === "online" ? "Loading…" : "Offline"}
      </StatusText>
    );
  }

  if (query.isError) {
    return (
      <StatusText>
        {query.error instanceof Error
          ? query.error.message
          : String(query.error)}
      </StatusText>
    );
  }

  const folders = query.data.entries.filter((e) => e.kind === "directory");

  if (folders.length === 0) {
    return <StatusText>No folders</StatusText>;
  }

  return (
    <Host style={{ flex: 1 }}>
      <Form>
        <Section title="Folders">
          {folders.map((entry) => (
            <PickerRow key={entry.path} label={entry.name} path={entry.path} />
          ))}
        </Section>
      </Form>
    </Host>
  );
}

/**
 * Loading / error / empty wrapper — SwiftUI Host filling its parent with
 * a single centered secondary-colored label. Since Host has no explicit
 * background, the sheet's natural fill shows through and matches the
 * adjacent Form view's grouped background automatically (no manual
 * `PlatformColor` plumbing). Dynamic Type + dark mode handled by the
 * system semantic colors.
 *
 * `frame({ maxWidth: Infinity, maxHeight: Infinity, alignment: "center" })`
 * is SwiftUI's idiomatic "fill all available space and center the child"
 * — equivalent to RN flex:1 + items-center + justify-center, just native.
 */
function StatusText({ children }: { children: string }) {
  return (
    <Host style={{ flex: 1 }}>
      <UiText
        modifiers={[
          frame({
            maxWidth: Number.POSITIVE_INFINITY,
            maxHeight: Number.POSITIVE_INFINITY,
            alignment: "center",
          }),
          foregroundStyle("secondary"),
        ]}
        textStyle={{ textAlign: "center" }}
      >
        {children}
      </UiText>
    </Host>
  );
}

/**
 * Single row primitive — folder.fill icon + label, push into that path.
 * Shared by both root and browse modes so the visual is consistent
 * (matches the Files-app pattern where Locations/Recent/Folders all look
 * the same in the list, just grouped by section header).
 *
 * Optional `subtitle` shows a footnote-styled secondary line beneath the
 * label (Recent rows use it for the tildified parent dir, so identical
 * basenames like two `src/` cwds stay disambiguable). Locations and
 * Folders rows omit it → single-line layout.
 *
 * `foregroundStyle("primary")` is required on the label — without it,
 * SwiftUI tints the only Button-content text with the accent color
 * (system blue) because Buttons inherit tint by default. Subtitle uses
 * `"secondary"` for the dimmer system-gray look.
 */
function PickerRow({
  label,
  subtitle,
  path,
}: {
  label: string;
  subtitle?: string;
  path: string;
}) {
  return (
    <Button
      onPress={() => router.push({ pathname: "/cwd-picker", params: { path } })}
    >
      <HStack alignment="center" spacing={12}>
        <Image systemName="folder.fill" size={20} />
        <VStack alignment="leading" spacing={2}>
          <SwiftText modifiers={[foregroundStyle("primary")]}>
            {label}
          </SwiftText>
          {subtitle !== undefined && (
            <SwiftText
              modifiers={[
                font({ textStyle: "footnote" }),
                foregroundStyle("secondary"),
              ]}
            >
              {subtitle}
            </SwiftText>
          )}
        </VStack>
      </HStack>
    </Button>
  );
}

/** Cheap last-segment helper. Mirrors the one in cwd-picker/index.tsx
 *  and git-status-bar.tsx — duplicated rather than centralized to keep
 *  each file's import surface small. Returns "/" for the filesystem
 *  root edge case. */
function basename(p: string): string {
  const trimmed = p.replace(/\/+$/, "");
  if (trimmed === "") return "/";
  const idx = trimmed.lastIndexOf("/");
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

/** Drop the last segment to get the parent directory. Returns "/" when
 *  the parent is the filesystem root, mirroring `basename`'s edge case. */
function parentDir(p: string): string {
  const trimmed = p.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  if (idx <= 0) return "/";
  return trimmed.slice(0, idx);
}

/** Replace a leading home path with `~` for compact display, matching
 *  shell convention. Falls through unchanged for paths outside home. */
function tildify(p: string, home: string): string {
  if (p === home) return "~";
  if (p.startsWith(`${home}/`)) return `~${p.slice(home.length)}`;
  return p;
}
