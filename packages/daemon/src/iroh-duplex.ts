// Wrap an @number0/iroh BiStream as a Node Duplex so Node's http stack can
// treat one QUIC bi-stream as one HTTP/1.1 connection (server: emit
// "connection"; client: http.request createConnection).

import { Duplex } from "node:stream";
import type { BiStream } from "@number0/iroh";

const READ_CHUNK = 64 * 1024;

export function irohDuplex(bi: BiStream, log?: (m: string) => void): Duplex {
  let reading = false;
  let ended = false;
  let finished = false;
  let writeChain: Promise<void> = Promise.resolve();

  const d = new Duplex({
    read() {
      if (reading || ended) return;
      reading = true;
      (async () => {
        try {
          while (true) {
            const bytes = await bi.recv.read(READ_CHUNK);
            if (!bytes || bytes.length === 0) {
              ended = true;
              d.push(null);
              return;
            }
            if (!d.push(Buffer.from(bytes))) return; // backpressure: resume on next _read
          }
        } catch (err) {
          // stream finished/reset by peer → EOF (not an error for HTTP)
          ended = true;
          log?.(`recv end: ${(err as Error).message}`);
          d.push(null);
        } finally {
          reading = false;
        }
      })();
    },
    write(chunk: Buffer, _enc, cb) {
      writeChain = writeChain
        .then(() => bi.send.writeAll(Array.from(chunk)))
        .then(
          () => cb(),
          (err) => cb(err),
        );
    },
    final(cb) {
      writeChain
        .then(() => bi.send.finish())
        .then(
          () => {
            finished = true;
            cb();
          },
          (err) => cb(err),
        );
    },
    destroy(err, cb) {
      // After a clean finish/EOF there is nothing to abort, and a reset
      // after finish would discard bytes the peer hasn't acknowledged yet.
      if (!finished) bi.send.reset(0n).catch(() => {});
      if (!ended) bi.recv.stop(0n).catch(() => {});
      cb(err);
    },
  });
  // Node http pokes at socket-ish methods; make them harmless.
  const sock = d as unknown as Record<string, unknown>;
  for (const k of ["setTimeout", "setNoDelay", "setKeepAlive", "ref", "unref"])
    sock[k] = () => d;
  sock.remoteAddress = "iroh";
  return d;
}
