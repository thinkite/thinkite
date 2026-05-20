import { useCallback, useEffect, useState } from "react";
import { QRCode } from "react-qrcode-logo";
import { Button } from "@/components/ui/button";
import sidecodeLogo from "@/assets/sidecode-logo.svg";

/**
 * Pair window content — rendered into the BrowserWindow opened by
 * `openPairWindow()` in electron/main.ts.
 *
 * Mints a fresh offer via the daemon (over IPC) and encodes it into the
 * Universal Link form `https://sidecode.app/pair?o=<base64url>` so that
 * pointing the iPhone's built-in Camera app at the QR opens the iOS
 * sidecode app directly at the `/pair` modal route.
 *
 * Auto-refresh: offers carry a 5-minute TTL on the daemon side, and we
 * rotate every 2.5 minutes so the displayed QR always has at least
 * half its lifetime left. No countdown shown — the rotation is silent;
 * the user just sees a QR that "always works" without UX pressure.
 *
 * Visual: plain square modules + small center logo. ecLevel M (15%
 * recovery) leaves ~10% of area for safely-occluded codewords; a 48px
 * logo on a 320px QR covers only ~2.25% area, well inside the budget.
 * The result lands on Version 12 / 65×65 modules.
 */

const UNIVERSAL_LINK_BASE = "https://sidecode.app/pair";
const REFRESH_INTERVAL_MS = 150_000; // 2.5min, half of the daemon's 5min TTL

export default function PairView() {
  const [offer, setOffer] = useState<{
    encoded: string;
    expiresAt: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

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
    const id = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  if (error) {
    return (
      <Shell>
        <div className="text-sm text-red-500">{error}</div>
        <Button variant="default" size="sm" onClick={() => void refresh()}>
          Retry
        </Button>
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
      <div className="rounded-lg bg-white p-1.5 shadow-sm">
        {/* Plain square modules + small center logo at ecLevel M.
            48px logo on 320px QR = 15% per side / 2.25% area, well
            under the ~10% area budget M's 15% codeword recovery
            covers. `removeQrCodeBehindLogo` clears the modules
            beneath instead of relying on z-overlay so the SVG
            transparency doesn't matter. */}
        <QRCode
          value={url}
          size={320}
          ecLevel="M"
          quietZone={8}
          logoImage={sidecodeLogo}
          logoWidth={48}
          logoHeight={48}
          logoPadding={4}
          logoPaddingStyle="square"
          removeQrCodeBehindLogo
        />
      </div>
      <div className="text-sm font-medium text-foreground">
        Scan with iPhone camera
      </div>
      <Button variant="secondary" size="sm" onClick={() => window.close()}>
        Done
      </Button>
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
