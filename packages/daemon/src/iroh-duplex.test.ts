import { once } from "node:events";
import type { BiStream } from "@number0/iroh";
import { describe, expect, it } from "vitest";
import { irohDuplex } from "./iroh-duplex.ts";

/**
 * In-memory stand-in for a napi BiStream. Bytes pushed by the test arrive
 * through `recv.read`; `send.writeAll` / `finish` / `reset` and
 * `recv.stop` are recorded in order so the Duplex's ordering contract
 * (writes serialize, finish lands last, destroy resets both halves) can be
 * asserted without a real endpoint.
 */
class FakeBiStream {
  readonly ops: string[] = [];
  readonly sent: Buffer[] = [];
  resetCode: bigint | null = null;
  stopCode: bigint | null = null;
  /** Delay applied to the first writeAll, to force a reordering window. */
  firstWriteDelayMs = 0;

  private readonly inbox: Array<Array<number> | null> = [];
  private wake: (() => void) | null = null;
  private stopped = false;
  private finishResolve!: () => void;
  readonly finished = new Promise<void>((resolve) => {
    this.finishResolve = resolve;
  });

  push(chunk: string): void {
    this.inbox.push(Array.from(Buffer.from(chunk)));
    this.wake?.();
  }

  /** Peer half-close: resolve pending reads with EOF. */
  pushEnd(): void {
    this.inbox.push(null);
    this.wake?.();
  }

  /** Peer reset: reject pending reads. */
  pushReset(): void {
    this.stopped = true;
    this.wake?.();
  }

  get send() {
    return {
      writeAll: async (buf: Array<number>): Promise<void> => {
        const text = Buffer.from(buf).toString();
        this.ops.push(`write:${text}`);
        if (this.firstWriteDelayMs > 0) {
          const delay = this.firstWriteDelayMs;
          this.firstWriteDelayMs = 0;
          await new Promise((r) => setTimeout(r, delay));
        }
        this.sent.push(Buffer.from(buf));
      },
      finish: async (): Promise<void> => {
        this.ops.push("finish");
        this.finishResolve();
      },
      reset: async (code: bigint): Promise<void> => {
        this.ops.push(`reset:${code}`);
        this.resetCode = code;
      },
    };
  }

  get recv() {
    return {
      read: async (_sizeLimit: number): Promise<Array<number>> => {
        for (;;) {
          if (this.stopped) throw new Error("stream reset");
          const next = this.inbox.shift();
          if (next === undefined) {
            await new Promise<void>((resolve) => {
              this.wake = resolve;
            });
            this.wake = null;
            continue;
          }
          if (next === null) return []; // EOF
          return next;
        }
      },
      stop: async (code: bigint): Promise<void> => {
        this.ops.push(`stop:${code}`);
        this.stopCode = code;
        this.stopped = true;
        this.wake?.();
      },
    };
  }
}

function asBi(fake: FakeBiStream): BiStream {
  return fake as unknown as BiStream;
}

describe("irohDuplex", () => {
  it("serializes writes and finishes the send side after they flush", async () => {
    const fake = new FakeBiStream();
    fake.firstWriteDelayMs = 20; // a slow first write must not reorder later ones
    const d = irohDuplex(asBi(fake));

    d.write("he");
    d.write("llo");
    d.end();
    await fake.finished;

    expect(fake.ops).toEqual(["write:he", "write:llo", "finish"]);
    expect(Buffer.concat(fake.sent).toString()).toBe("hello");
  });

  it("delivers peer bytes as data and half-close as end, keeping the write side open", async () => {
    const fake = new FakeBiStream();
    const d = irohDuplex(asBi(fake));
    const data: Buffer[] = [];
    d.on("data", (chunk: Buffer) => data.push(chunk));

    fake.push("hel");
    fake.push("lo");
    fake.pushEnd();
    await once(d, "end");
    expect(Buffer.concat(data).toString()).toBe("hello");

    // The peer's EOF only half-closes the stream — the response can still
    // be written (this is the HTTP request-then-response shape).
    d.end("late");
    await fake.finished;
    expect(fake.ops).toEqual(["write:late", "finish"]);
  });

  it("treats a peer reset as EOF rather than an error", async () => {
    const fake = new FakeBiStream();
    const d = irohDuplex(asBi(fake));
    d.resume();

    fake.pushReset();
    await once(d, "end");
  });

  it("destroy resets the send side and stops the recv side", async () => {
    const fake = new FakeBiStream();
    const d = irohDuplex(asBi(fake));
    d.resume();

    d.destroy();
    await once(d, "close");
    expect(fake.resetCode).toBe(0n);
    expect(fake.stopCode).toBe(0n);
    expect(fake.ops).toContain("reset:0");
    expect(fake.ops).toContain("stop:0");
  });
});
