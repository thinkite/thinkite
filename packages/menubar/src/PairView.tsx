import { useCallback, useEffect, useState } from "react";
import { QRCode } from "react-qrcode-logo";
import sidecodeLogo from "@/assets/sidecode-logo.svg";

/**
 * Pair window content — rendered into the BrowserWindow opened by
 * `openPairWindow()` in electron/main.ts.
 *
 * Mints the offer via the daemon (over IPC) and encodes it into the
 * Universal Link form `https://sidecode.app/pair?o=<base64url>` so that
 * pointing the iPhone's built-in Camera app at the QR opens the iOS
 * sidecode app directly at the `/pair` modal route.
 *
 * The offer is pure (same daemon → same payload), so we mint once on
 * mount — no refresh. The admission gate is driven by this window's
 * open/close in electron/main (daemon.setPairing), so the QR "always
 * works" while the window is open and stops admitting the moment it closes.
 *
 * Below the QR, a copy-code row surfaces the raw payload for the iOS app's
 * "Paste code" path (when the camera can't scan, e.g. simulator).
 *
 * Visual: plain square modules + center logo. ecLevel M (15%
 * recovery) leaves ~10% of area for safely-occluded codewords; a 72px
 * logo on a 320px QR covers ~5% area, comfortably inside the budget.
 * The result lands on Version 12 / 65×65 modules.
 */

const UNIVERSAL_LINK_BASE = "https://sidecode.app/pair";

export default function PairView() {
  const [offer, setOffer] = useState<{ encoded: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const fresh = await window.sidecode.getPairOffer();
      setOffer(fresh);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Copy the raw payload to the clipboard for the iOS app's "Paste code" path
  // (when the camera can't scan). `navigator.clipboard.writeText` is the
  // built-in web API — no extra dep; the button click is the user gesture it
  // needs, and a file:// / localhost renderer is a secure context.
  const handleCopy = useCallback(async () => {
    if (!offer) return;
    try {
      await navigator.clipboard.writeText(offer.encoded);
      setCopied(true);
    } catch {
      // Write can reject if the window isn't focused; ignore — QR is primary.
    }
  }, [offer]);

  // Revert the "Copied!" label after a beat. Cleanup clears the timer on a
  // re-copy or unmount, so no setState-after-unmount.
  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(id);
  }, [copied]);

  if (error) {
    return (
      <Shell>
        <div className="text-sm text-red-500">{error}</div>
        <button
          type="button"
          onClick={() => void refresh()}
          className="inline-flex h-8 items-center justify-center rounded-full bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/80"
        >
          Retry
        </button>
      </Shell>
    );
  }

  if (!offer) {
    return (
      <Shell>
        <div className="text-xs text-muted-foreground">Loading…</div>
      </Shell>
    );
  }

  const url = `${UNIVERSAL_LINK_BASE}?o=${offer.encoded}`;

  return (
    <Shell>
      <div className="rounded-lg bg-white p-1.5 border">
        {/* Plain square modules + center logo at ecLevel M.
            72px logo on 320px QR = 22.5% per side / ~5% area, still
            under the ~10% area budget M's 15% codeword recovery
            covers. `removeQrCodeBehindLogo` clears the modules
            beneath instead of relying on z-overlay so the SVG
            transparency doesn't matter. The card stays white in BOTH
            themes — dark-on-light is the most universally scannable, and
            the white card just pops against the dark window. */}
        <QRCode
          value={url}
          size={320}
          ecLevel="M"
          quietZone={8}
          qrStyle="dots"
          logoImage={sidecodeLogo}
          logoWidth={72}
          logoHeight={72}
          logoPadding={4}
          logoPaddingStyle="square"
          removeQrCodeBehindLogo
        />
      </div>
      <div className="flex flex-col items-center gap-1">
        <div className="text-sm font-medium text-foreground">
          Scan with iPhone camera
        </div>
        {/* The window IS the admission gate (electron/main setPairing): closing
            it stops admitting, so warn against closing before the phone has
            finished connecting. */}
        <div className="text-center text-xs text-muted-foreground">
          Keep this window open until your iPhone connects
        </div>
      </div>
      {/* Copy-code fallback: a truncated preview of the raw payload that the
          whole row copies. Mirrors the iOS "Paste code" path for when the
          camera can't scan (e.g. simulator). */}
      <div className="flex w-[320px] flex-col gap-1.5">
        <div className="text-center text-xs text-muted-foreground">
          Or paste this code in the app
        </div>
        <button
          type="button"
          onClick={() => void handleCopy()}
          className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-left transition-colors hover:bg-muted"
        >
          <code className="flex-1 truncate font-mono text-xs text-muted-foreground">
            {offer.encoded}
          </code>
          <span className="shrink-0 text-xs font-medium text-foreground">
            {copied ? "Copied!" : "Copy"}
          </span>
        </button>
      </div>
      <button
        type="button"
        onClick={() => window.close()}
        className="inline-flex h-8 items-center justify-center rounded-full border border-border bg-card px-3 text-sm font-medium text-foreground transition-colors hover:bg-muted"
      >
        Done
      </button>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative flex h-screen w-full flex-col items-center justify-center gap-4 p-6 bg-background text-foreground">
      {/* Drag handle for the `titleBarStyle: "hiddenInset"` window —
          without it macOS leaves the frame stationary. 28px clears the
          traffic-light row; the rest of the chrome stays click-through
          so the QR and buttons keep working. */}
      <div
        className="absolute inset-x-0 top-0 h-7"
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
      />
      {children}
    </div>
  );
}
