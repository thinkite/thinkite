// The session panel's browser: `<webview>` guests in the main window, after
// DeepSeek Harness's sidebar browser (apps/desktop/src/browser-guests.ts,
// MIT). The guest is an ordinary web page, so it gets nothing of the app:
// one partition of its own, sandboxed, no preload or node, no permissions,
// no downloads, and no way to reach this process's server — /pty is a
// shell and /oc carries the service's credentials, both on loopback.
// Popups open as a new tab in the panel.
import { type BrowserWindow, session, type WebContents } from "electron";

/** The guests' partition: one cookie jar for every tab, kept across runs
 *  so a sign-in in the panel sticks. */
export const BROWSER_PARTITION = "persist:thinkite-browser";

const WEB = /^(https?|wss?):$/;

export function setupBrowserGuests(opts: {
  /** Origins of this app's own pages and server, never loaded in a guest. */
  appOrigins: string[];
}): void {
  const blocked = new Set(
    opts.appOrigins.flatMap((origin) => {
      const { port } = new URL(origin);
      // The same server answers on every loopback name.
      return ["127.0.0.1", "localhost", "[::1]"].map((h) => `${h}:${port}`);
    }),
  );
  const allowed = (raw: string) => {
    if (raw === "about:blank") return true;
    try {
      const url = new URL(raw);
      return (
        WEB.test(url.protocol) &&
        url.username === "" &&
        url.password === "" &&
        !blocked.has(url.host)
      );
    } catch {
      return false;
    }
  };

  const guests = session.fromPartition(BROWSER_PARTITION);
  guests.setPermissionRequestHandler((_wc, _permission, callback) =>
    callback(false),
  );
  guests.setPermissionCheckHandler(() => false);
  guests.setDevicePermissionHandler(() => false);
  guests.setDisplayMediaRequestHandler((_request, callback) => callback({}));
  guests.on("will-download", (event) => event.preventDefault());
  // Every request, main frame or not, so a page can't fetch the app's
  // server either. (HTTP auth prompts need an app `login` handler, which
  // there isn't: Electron cancels them.)
  guests.webRequest.onBeforeRequest((details, callback) => {
    const cancel = !allowed(details.url);
    // A cancelled page load fails silently (no did-fail-load), so the tab
    // is told here.
    if (cancel && details.resourceType === "mainFrame" && details.webContents)
      tell("thinkite:browser-blocked", {
        guest: details.webContents.id,
        url: details.url,
      });
    callback({ cancel });
  });

  allowedUrl = allowed;
}

let allowedUrl: (url: string) => boolean = () => false;
/** The window whose page holds the webviews. */
let owner: BrowserWindow | null = null;

/** Send the page a DOM event: there is no preload to carry a message, so
 *  it hears it as one (components/BrowserPanel). */
function tell(type: string, detail: unknown): void {
  if (owner === null || owner.isDestroyed()) return;
  void owner.webContents.executeJavaScript(
    `window.dispatchEvent(new CustomEvent(${JSON.stringify(type)}, { detail: ${JSON.stringify(detail)} }))`,
  );
}

/** Lock down the webviews a window's page attaches, and send their popups
 *  back to that page as new tabs. */
export function guardWebviews(win: BrowserWindow): void {
  owner = win;
  win.webContents.on("will-attach-webview", (event, prefs, params) => {
    if (params.partition !== BROWSER_PARTITION) {
      event.preventDefault();
      return;
    }
    // A tab restored at an address it may not load starts blank instead.
    if (!allowedUrl(params.src)) params.src = "about:blank";
    delete prefs.preload;
    prefs.nodeIntegration = false;
    prefs.nodeIntegrationInSubFrames = false;
    prefs.contextIsolation = true;
    prefs.sandbox = true;
    prefs.webviewTag = false;
    prefs.disableDialogs = true;
  });
  win.webContents.on("did-attach-webview", (_event, guest) =>
    guardGuest(guest),
  );
}

function guardGuest(guest: WebContents): void {
  guest.setWindowOpenHandler(({ url }) => {
    if (allowedUrl(url)) tell("thinkite:browser-open", url);
    return { action: "deny" };
  });
  guest.on("will-attach-webview", (event) => event.preventDefault());
}
