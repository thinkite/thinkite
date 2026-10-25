import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Icon } from "@astryxdesign/core/Icon";
import { Tab, TabList } from "@astryxdesign/core/TabList";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useSelector } from "@tanstack/react-store";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ExternalLinkIcon,
  GlobeIcon,
  PlusIcon,
  RotateCwIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  addressToUrl,
  type BrowserTab,
  browserTabs,
  browserTabsOf,
  closeBrowserTab,
  MAX_BROWSER_TABS,
  openBrowserTab,
  selectBrowserTab,
  updateBrowserTab,
} from "../lib/browser";
import { isDesktopShell } from "../lib/desktop-shell";
import { stoppedServerAt, usePreviews } from "../lib/previews";

// The browser surface, after DeepSeek Harness's sidebar browser: a
// session's pages as tabs, each an Electron `<webview>` guest that the
// main process locks down (server/browser-guests), with back, forward,
// reload and an address bar for the selected one. The tab strip works as
// the terminal surface's does: × and + at its end, + always last. A tab's
// page mounts the first time it is selected and then stays mounted, so
// switching tabs keeps each page as it was. For the user only: the agent
// neither sees nor drives these pages. A page the agent asks to show
// (lib/previews) opens here as one of the user's tabs, and stays the
// user's: a stopped server leaves its tab where it is, with a note.

/** Must match server/browser-guests. */
const PARTITION = "persist:thinkite-browser";

/** The parts of Electron's WebviewTag used here. */
interface Webview extends HTMLElement {
  loadURL(url: string): Promise<void>;
  getURL(): string;
  getWebContentsId(): number;
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
  stop(): void;
}

interface Nav {
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
  /** Why the last main-frame load failed, until the next one starts. */
  error: string | null;
}

const IDLE: Nav = {
  canGoBack: false,
  canGoForward: false,
  isLoading: false,
  error: null,
};

function tabLabel(tab: BrowserTab): string {
  if (tab.title !== "") return tab.title;
  try {
    const host = new URL(tab.url).host;
    if (host !== "") return host;
  } catch {
    // not a URL
  }
  return "New tab";
}

/** One tab's page. Its address is set once, at mount; navigation then goes
 *  through the guest, and the guest's events report where it went. */
function Page({
  tab,
  isActive,
  register,
  onNav,
  onPage,
}: {
  tab: BrowserTab;
  isActive: boolean;
  register: (view: Webview | null) => void;
  onNav: (nav: Nav) => void;
  onPage: (page: { url?: string; title?: string }) => void;
}) {
  const ref = useRef<Webview>(null);
  const [src] = useState(tab.url);
  const handlers = useRef({ onNav, onPage, register });
  handlers.current = { onNav, onPage, register };

  useEffect(() => {
    const view = ref.current;
    if (view === null) return;
    let ready = false;
    let error: string | null = null;
    let isLoading = false;
    const report = () =>
      handlers.current.onNav({
        canGoBack: ready && view.canGoBack(),
        canGoForward: ready && view.canGoForward(),
        isLoading,
        error,
      });
    const on = <E extends Event>(type: string, fn: (e: E) => void) =>
      view.addEventListener(type, fn as EventListener);
    on("dom-ready", () => {
      ready = true;
      report();
    });
    on("did-start-loading", () => {
      isLoading = true;
      error = null;
      report();
    });
    on("did-stop-loading", () => {
      isLoading = false;
      report();
    });
    on<Event & { url: string }>("did-navigate", (e) => {
      handlers.current.onPage({ url: e.url });
      report();
    });
    on<Event & { url: string; isMainFrame: boolean }>(
      "did-navigate-in-page",
      (e) => {
        if (!e.isMainFrame) return;
        handlers.current.onPage({ url: e.url });
        report();
      },
    );
    on<Event & { title: string }>("page-title-updated", (e) =>
      handlers.current.onPage({ title: e.title }),
    );
    on<
      Event & {
        errorCode: number;
        errorDescription: string;
        validatedURL: string;
        isMainFrame: boolean;
      }
    >("did-fail-load", (e) => {
      // -3 is a load the next one replaced.
      if (!e.isMainFrame || e.errorCode === -3) return;
      error = `${e.errorDescription || "The page didn't load"} (${e.validatedURL})`;
      report();
    });
    // An address the main process refuses (server/browser-guests).
    const onBlocked = (e: Event) => {
      const { guest } = (e as CustomEvent<{ guest: number }>).detail;
      if (!ready || guest !== view.getWebContentsId()) return;
      error = "Thinkite doesn't open this address in its browser.";
      report();
    };
    window.addEventListener("thinkite:browser-blocked", onBlocked);
    // Where the guest really starts: the main process opens a restored
    // address it refuses as a blank page.
    on("dom-ready", () => {
      const url = view.getURL();
      if (url === "about:blank") handlers.current.onPage({ url, title: "" });
    });
    handlers.current.register(view);
    return () => {
      window.removeEventListener("thinkite:browser-blocked", onBlocked);
      handlers.current.register(null);
    };
  }, []);

  return (
    <div
      id={`browser-page-${tab.n}`}
      role="tabpanel"
      className={isActive ? "h-full" : "hidden"}
    >
      <webview
        ref={ref}
        src={src}
        partition={PARTITION}
        // Popups reach the main process, which reopens them as tabs.
        allowpopups
        style={{ display: "flex", width: "100%", height: "100%" }}
      />
    </div>
  );
}

export function BrowserPanel({
  sessionId,
  directory,
}: {
  sessionId: string;
  directory: string;
}) {
  const { open, active } = useSelector(browserTabs, (all) =>
    browserTabsOf(all, sessionId),
  );
  const current = open.find((t) => t.n === active);
  const views = useRef(new Map<number, Webview>());
  const [navs, setNavs] = useState<Record<number, Nav>>({});
  const nav = navs[active] ?? IDLE;
  const [seen, setSeen] = useState(() => new Set([active]));
  if (open.length > 0 && !seen.has(active)) setSeen(new Set(seen).add(active));
  const [draft, setDraft] = useState<string | null>(null);
  const previews = usePreviews(directory);
  const stopped =
    current === undefined ? undefined : stoppedServerAt(previews, current.url);

  // A page's popup, sent back by the main process (server/browser-guests).
  useEffect(() => {
    const onOpen = (e: Event) => {
      const url = (e as CustomEvent<string>).detail;
      if (typeof url === "string") openBrowserTab(sessionId, url);
    };
    window.addEventListener("thinkite:browser-open", onOpen);
    return () => window.removeEventListener("thinkite:browser-open", onOpen);
  }, [sessionId]);

  const add = () => openBrowserTab(sessionId);
  const view = views.current.get(active);
  const go = (text: string) => {
    setDraft(null);
    // The tab records the address once the page goes there (did-navigate).
    void view?.loadURL(addressToUrl(text)).catch(() => {
      // did-fail-load reports it
    });
  };

  if (!isDesktopShell)
    return (
      <div className="flex h-full items-center justify-center p-4">
        <EmptyState
          title="Browser"
          description="Pages open in the Thinkite app, not in a browser tab."
          icon={<Icon icon={GlobeIcon} size="lg" color="secondary" />}
          isCompact
        />
      </div>
    );

  const iconButton = (
    label: string,
    icon: typeof PlusIcon,
    onClick: () => void,
    isDisabled = false,
  ) => (
    <Button
      label={label}
      tooltip={label}
      icon={<Icon icon={icon} size="sm" />}
      isIconOnly
      variant="ghost"
      size="sm"
      isDisabled={isDisabled}
      onClick={onClick}
    />
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-[var(--color-border)] px-2">
        <div className="min-w-0 flex-1">
          {open.length > 0 ? (
            <TabList
              aria-label="Pages"
              role="tablist"
              size="sm"
              value={String(active)}
              onChange={(v) => {
                setDraft(null);
                selectBrowserTab(sessionId, Number(v));
              }}
            >
              {open.map((tab) => (
                <Tab
                  key={tab.n}
                  value={String(tab.n)}
                  label={tabLabel(tab)}
                  panelId={`browser-page-${tab.n}`}
                  className="max-w-40"
                />
              ))}
            </TabList>
          ) : null}
        </div>
        {/* As in the terminal surface: + stays last, × comes and goes to
            its left. */}
        {open.length > 0
          ? iconButton("Close tab", XIcon, () =>
              closeBrowserTab(sessionId, active),
            )
          : null}
        {iconButton("New tab", PlusIcon, add, open.length >= MAX_BROWSER_TABS)}
      </div>
      {current === undefined ? (
        <div className="flex flex-1 items-center justify-center">
          <EmptyState
            title="No pages"
            description="Open a page beside the conversation."
            icon={<Icon icon={GlobeIcon} size="lg" color="secondary" />}
            actions={<Button label="New tab" size="sm" onClick={add} />}
            isCompact
          />
        </div>
      ) : (
        <>
          <div className="flex shrink-0 items-center gap-1 border-b border-[var(--color-border)] px-2 py-1.5">
            {iconButton(
              "Back",
              ArrowLeftIcon,
              () => view?.goBack(),
              !nav.canGoBack,
            )}
            {iconButton(
              "Forward",
              ArrowRightIcon,
              () => view?.goForward(),
              !nav.canGoForward,
            )}
            {nav.isLoading
              ? iconButton("Stop", XIcon, () => view?.stop())
              : iconButton("Reload", RotateCwIcon, () => view?.reload())}
            <div className="min-w-0 flex-1">
              <TextInput
                label="Address"
                isLabelHidden
                size="sm"
                width="100%"
                placeholder="Search or enter an address"
                value={
                  draft ?? (current.url === "about:blank" ? "" : current.url)
                }
                onChange={setDraft}
                onFocus={(e) => (e.target as HTMLInputElement).select()}
                onEnter={() => go(draft ?? current.url)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setDraft(null);
                }}
                autoComplete="off"
              />
            </div>
            {iconButton(
              "Open in your browser",
              ExternalLinkIcon,
              () => window.open(current.url, "_blank"),
              !/^https?:/.test(current.url),
            )}
          </div>
          {stopped !== undefined ? (
            <div className="shrink-0 border-b border-[var(--color-border)] px-3 py-2">
              <Text size="sm" color="secondary">
                {`${stopped.name} stopped`}
              </Text>
            </div>
          ) : null}
          {nav.error !== null ? (
            <div className="shrink-0 border-b border-[var(--color-border)] px-3 py-2">
              <Text size="sm" color="secondary">
                {nav.error}
              </Text>
            </div>
          ) : null}
          <div className="min-h-0 flex-1">
            {open
              .filter((tab) => seen.has(tab.n))
              .map((tab) => (
                <Page
                  key={tab.n}
                  tab={tab}
                  isActive={tab.n === active}
                  register={(v) => {
                    if (v === null) views.current.delete(tab.n);
                    else views.current.set(tab.n, v);
                  }}
                  onNav={(next) =>
                    setNavs((all) => ({ ...all, [tab.n]: next }))
                  }
                  onPage={(page) => updateBrowserTab(sessionId, tab.n, page)}
                />
              ))}
          </div>
        </>
      )}
    </div>
  );
}
