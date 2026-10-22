import { Button } from "@astryxdesign/core/Button";
import { Text } from "@astryxdesign/core/Text";
import { useToast } from "@astryxdesign/core/Toast";
import { useEffect, useState } from "react";
import { Row, Section } from "./parts";

// Settings › Pairing, after opencode desktop's page of the same name: pair
// a phone, and see what is paired. Pairing itself stays in the pair window
// (the tray's Pair New Device opens the same one): the daemon admits new
// devices only while that window shows its QR code, so the button opens
// the window rather than showing the code here. opencode's Remote access
// and Keep screen active switches have no counterpart in Thinkite yet.

interface DaemonStatus {
  running: boolean;
  pairedClients?: number;
  authenticatedPeers?: number;
}

/** The daemon's status, read again every few seconds while shown. */
function useDaemonStatus(): DaemonStatus | null {
  const [status, setStatus] = useState<DaemonStatus | null>(null);
  useEffect(() => {
    let cancelled = false;
    const read = () =>
      fetch("/api/daemon/status")
        .then((res) => res.json() as Promise<DaemonStatus>)
        .then((next) => {
          if (!cancelled) setStatus(next);
        })
        .catch(() => {
          if (!cancelled) setStatus({ running: false });
        });
    void read();
    const timer = setInterval(read, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);
  return status;
}

export function Pairing() {
  const showToast = useToast();
  const status = useDaemonStatus();
  const available = status?.running === true;

  const pair = () =>
    fetch("/api/pair/window", { method: "POST" })
      .then(async (res) => {
        if (!res.ok) throw new Error(await res.text());
      })
      .catch((err: unknown) => {
        showToast({
          body: err instanceof Error ? err.message : String(err),
          type: "error",
        });
      });

  return (
    <Section title="Devices">
      <Row
        title="Pair a device"
        description="Reach this Mac from your iPhone, end-to-end encrypted"
      >
        <Button
          label="Pair device"
          variant="secondary"
          size="sm"
          isDisabled={!available}
          clickAction={pair}
        />
      </Row>
      <Row
        title="Paired devices"
        description="Devices that can reach this Mac's sessions"
      >
        <Text size="sm" color="secondary">
          {status === null
            ? "…"
            : !available
              ? "Pairing unavailable"
              : `${status.pairedClients ?? 0} paired · ${status.authenticatedPeers ?? 0} connected now`}
        </Text>
      </Row>
    </Section>
  );
}
