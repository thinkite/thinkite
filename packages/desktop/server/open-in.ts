// "Open in": the session's folder in an editor, a terminal or Finder,
// after DeepSeek Harness's open-in-app (@deepseek-ai/dsh-host-open-in-app,
// MIT): a fixed list of apps, shown only when installed, each opened with
// `open -a <app> <folder>`. Git clients are left out: they want a
// repository, and a session's folder may not be one.
//
// An app counts as installed when its bundle is in /Applications or
// ~/Applications (where JetBrains Toolbox puts its IDEs) under one of the
// names it ships as; no Launch Services query, no disk scan. The list is
// read again on every request, so an app installed while Thinkite runs
// shows up the next time the menu is read. Icons are each app's own, as
// macOS shows it (its Quick Look thumbnail), so no brand artwork ships with
// Thinkite.

import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { nativeImage } from "electron";

interface CatalogEntry {
  id: string;
  name: string;
  /** Bundle names to look for in the application folders. */
  bundles?: readonly string[];
  /** Where a system app lives instead. */
  path?: string;
}

const CATALOG: readonly CatalogEntry[] = [
  {
    id: "finder",
    name: "Finder",
    path: "/System/Library/CoreServices/Finder.app",
  },
  { id: "cursor", name: "Cursor", bundles: ["Cursor.app"] },
  { id: "vscode", name: "VS Code", bundles: ["Visual Studio Code.app"] },
  {
    id: "vscode-insiders",
    name: "VS Code Insiders",
    bundles: ["Visual Studio Code - Insiders.app"],
  },
  { id: "windsurf", name: "Windsurf", bundles: ["Windsurf.app"] },
  { id: "zed", name: "Zed", bundles: ["Zed.app", "Zed Preview.app"] },
  { id: "sublime-text", name: "Sublime Text", bundles: ["Sublime Text.app"] },
  { id: "xcode", name: "Xcode", bundles: ["Xcode.app", "Xcode-beta.app"] },
  {
    id: "android-studio",
    name: "Android Studio",
    bundles: ["Android Studio.app"],
  },
  {
    id: "intellij",
    name: "IntelliJ IDEA",
    bundles: [
      "IntelliJ IDEA.app",
      "IntelliJ IDEA Ultimate.app",
      "IntelliJ IDEA CE.app",
    ],
  },
  {
    id: "pycharm",
    name: "PyCharm",
    bundles: [
      "PyCharm.app",
      "PyCharm Professional.app",
      "PyCharm CE.app",
      "PyCharm Community.app",
    ],
  },
  { id: "webstorm", name: "WebStorm", bundles: ["WebStorm.app"] },
  { id: "phpstorm", name: "PhpStorm", bundles: ["PhpStorm.app"] },
  { id: "goland", name: "GoLand", bundles: ["GoLand.app"] },
  { id: "rider", name: "Rider", bundles: ["Rider.app", "JetBrains Rider.app"] },
  { id: "rustrover", name: "RustRover", bundles: ["RustRover.app"] },
  { id: "ghostty", name: "Ghostty", bundles: ["Ghostty.app"] },
  { id: "warp", name: "Warp", bundles: ["Warp.app"] },
  { id: "iterm", name: "iTerm", bundles: ["iTerm.app"] },
  { id: "kitty", name: "kitty", bundles: ["kitty.app"] },
  {
    id: "terminal",
    name: "Terminal",
    path: "/System/Applications/Utilities/Terminal.app",
  },
];

export interface OpenInApp {
  id: string;
  name: string;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Where `entry` is installed, if it is. */
async function locate(entry: CatalogEntry): Promise<string | null> {
  if (entry.path !== undefined)
    return (await isDirectory(entry.path)) ? entry.path : null;
  for (const folder of ["/Applications", join(homedir(), "Applications")]) {
    for (const bundle of entry.bundles ?? []) {
      const path = join(folder, bundle);
      if (await isDirectory(path)) return path;
    }
  }
  return null;
}

async function installed(): Promise<Map<string, string>> {
  const found = await Promise.all(
    CATALOG.map(async (e) => [e.id, await locate(e)] as const),
  );
  const out = new Map<string, string>();
  for (const [id, path] of found) if (path !== null) out.set(id, path);
  return out;
}

/** The catalog's installed apps, in catalog order. */
export async function listOpenInApps(): Promise<OpenInApp[]> {
  const paths = await installed();
  return CATALOG.filter((e) => paths.has(e.id)).map(({ id, name }) => ({
    id,
    name,
  }));
}

const icons = new Map<string, Buffer>();

/** The app's icon as a 64px PNG (a 16pt icon at 2x, with room to
 *  spare), or null when it isn't installed. */
export async function openInIcon(id: string): Promise<Buffer | null> {
  const entry = CATALOG.find((e) => e.id === id);
  const path = entry === undefined ? null : await locate(entry);
  if (path === null) return null;
  let png = icons.get(path);
  if (png === undefined) {
    // Quick Look's thumbnail of a bundle is its icon (`app.getFileIcon`
    // answers the generic folder icon for every bundle). It comes back at
    // the screen's scale, so it is sized down after.
    const thumbnail = await nativeImage.createThumbnailFromPath(path, {
      width: 64,
      height: 64,
    });
    png = thumbnail.resize({ width: 64, height: 64, quality: "best" }).toPNG();
    icons.set(path, png);
  }
  return png;
}

/** Open `directory` in the app; rejects when it can't. */
export async function openIn(id: string, directory: string): Promise<void> {
  const entry = CATALOG.find((e) => e.id === id);
  const path = entry === undefined ? null : await locate(entry);
  if (path === null) throw new Error(`${id} isn't installed`);
  if (!(await isDirectory(directory)))
    throw new Error(`${directory} isn't a folder`);
  await new Promise<void>((resolve, reject) => {
    execFile("open", ["-a", path, directory], (error) =>
      error === null ? resolve() : reject(error),
    );
  });
}
