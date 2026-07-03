// Deno Desktop entry. Serves the Vite-built SPA from dist/ (the auto-window
// navigates to Deno.serve) — same shape as deno's own Vite framework-detection
// entrypoint, kept explicit because P1+ mounts our own routes (PTY WebSocket,
// search, git) on this same server, which detection's synthetic entry can't do.
// No npm imports here (denoland/deno#35544 monorepo guard); jsr: is fine.
//
// Dev:   pnpm build && deno desktop --hmr -A main.ts
//        (or `pnpm dev:web` + SIDECODE_DESKTOP_VITE=http://localhost:5183
//         deno desktop --hmr -A main.ts   for full React HMR)
// Pack:  vite build first, then `deno desktop --include dist -o Sidecode.app main.ts`
//        + entitlements re-sign (sidecode#23) via the packaging script.
import { serveDir } from "jsr:@std/http/file-server";
import { handleDiff } from "./server/diff.ts";
import { handlePty, setSessionHooks } from "./server/pty.ts";
import { getSessionCwd, handleSessionsApi } from "./server/sessions.ts";
import { handleTranscript } from "./server/transcript.ts";

// PTY ↔ session-store wiring (kept out of the modules to avoid a two-way
// import between two top-level-awaiting modules). Sessions are the daemon's
// (read-only mirror), so PTY activity no longer touches any store — daemon
// metadata records Claude activity, not shell keystrokes.
setSessionHooks({
  getCwd: getSessionCwd,
  onActivity: () => {},
});

// Two possible dist/ roots:
//  - packaged: `--include dist` embeds it next to the compiled entry (import.meta)
//  - dev (--hmr): import.meta points at a temp compile dir, so fall back to cwd
//    (reads the live dist from disk — `vite build --watch` output shows up on
//    plain reload, no deno restart / re-embed needed)
const fsRoot = await (async () => {
  const roots = [`${import.meta.dirname}/dist`, `${Deno.cwd()}/dist`];
  for (const root of roots) {
    try {
      await Deno.stat(`${root}/index.html`);
      return root;
    } catch {
      // try next root
    }
  }
  console.error("dist/index.html not found — run `pnpm build` first");
  return roots[1];
})();

const viteDev = Deno.env.get("SIDECODE_DESKTOP_VITE");

// NOTE: deno desktop's runtime pre-allocates the serve port and IGNORES the
// `port` option (publishes the real one via DENO_SERVE_ADDRESS) — fixed ports
// are impossible here. The Vite proxy learns our real port via env instead.
Deno.serve({ port: 0, onListen() {} }, async (req) => {
  const url = new URL(req.url);
  if (
    url.pathname === "/pty" &&
    (req.headers.get("upgrade") ?? "").toLowerCase() === "websocket"
  ) {
    return handlePty(req);
  }
  if (url.pathname === "/api/diff") {
    return await handleDiff(req);
  }
  if (url.pathname === "/api/transcript") {
    return await handleTranscript(req);
  }
  if (url.pathname.startsWith("/api/")) {
    return await handleSessionsApi(req);
  }
  const res = await serveDir(req, { fsRoot, quiet: true });
  // SPA fallback: only for HTML navigations, so missing assets/API paths still 404.
  if (
    res.status === 404 &&
    req.method === "GET" &&
    (req.headers.get("accept") ?? "").includes("text/html")
  ) {
    const index = new Request(new URL("/index.html", req.url), {
      headers: req.headers,
    });
    return await serveDir(index, { fsRoot, quiet: true });
  }
  return res;
});

const win = new Deno.BrowserWindow({
  title: "Sidecode",
  width: 1200,
  height: 800,
});

// Full React HMR loop: spawn the Vite dev server ourselves (what deno's
// framework-dev mode intends but hasn't wired up) and point the window at it.
// Frontend edits → Vite ws HMR; main.ts HANDLER-BODY edits → V8 hot-swap +
// auto page reload. Caveat (rt/hmr.rs): TOP-LEVEL main.ts changes can't
// hot-swap ("blocked by top-level ES module change") — restart for those.
if (viteDev) {
  const alive = async () => {
    try {
      await fetch(viteDev, { method: "HEAD" });
      return true;
    } catch {
      return false;
    }
  };
  // Reuse an already-running dev server (e.g. a separate `pnpm dev:web`);
  // otherwise spawn one and tie its lifetime to the window.
  if (!(await alive())) {
    // Tell Vite's proxy where our (runtime-chosen) server actually is.
    const serveAddr = Deno.env.get("DENO_SERVE_ADDRESS") ?? "";
    const ptyTarget = `http://127.0.0.1:${serveAddr.split(":").pop()}`;
    const vite = new Deno.Command("pnpm", {
      args: ["dev:web"],
      stdout: "inherit",
      stderr: "inherit",
      env: { ...Deno.env.toObject(), SIDECODE_PTY_TARGET: ptyTarget },
    }).spawn();
    win.addEventListener("close", () => {
      try {
        vite.kill();
      } catch {
        // already gone
      }
      Deno.exit(0);
    });
    for (let i = 0; i < 100 && !(await alive()); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  win.navigate(viteDev);
}
