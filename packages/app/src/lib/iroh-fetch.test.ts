import type {
  BiStreamLike,
  RecvStreamLike,
  SendStreamLike,
} from "react-native-iroh-ffi";
import { describe, expect, it } from "vitest";
import { createIrohFetch } from "./iroh-fetch";

/**
 * In-memory BiStream pair: client writes land in `FakeSend.writes`, the
 * test "server" pushes response bytes into `FakeRecv`. `read` rejects at
 * EOF, matching uniffi's `RecvStream` after the peer finishes/resets.
 */

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
const ab = (b: Uint8Array): ArrayBuffer =>
  b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

class FakeSend implements SendStreamLike {
  readonly writes: Uint8Array[] = [];
  finished = false;
  resetCode: bigint | null = null;

  async finish(): Promise<void> {
    this.finished = true;
  }
  async reset(code: bigint): Promise<void> {
    this.resetCode = code;
  }
  async write(buf: ArrayBuffer): Promise<bigint> {
    await this.writeAll(buf);
    return BigInt(buf.byteLength);
  }
  async writeAll(buf: ArrayBuffer): Promise<void> {
    this.writes.push(new Uint8Array(buf));
  }
  async id(): Promise<string> {
    return "0";
  }
  async priority(): Promise<number> {
    return 0;
  }
  async setPriority(): Promise<void> {}
  async stopped(): Promise<bigint | undefined> {
    return undefined;
  }

  text(): string {
    const total = this.writes.reduce((n, w) => n + w.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const w of this.writes) {
      out.set(w, at);
      at += w.length;
    }
    return new TextDecoder().decode(out);
  }

  head(): string {
    return this.text().split("\r\n\r\n")[0];
  }
}

class FakeRecv implements RecvStreamLike {
  private chunks: Uint8Array[] = [];
  private waiters: (() => void)[] = [];
  private ended = false;
  stopCode: bigint | null = null;

  push(chunk: Uint8Array): void {
    this.chunks.push(chunk);
    this.wake();
  }
  end(): void {
    this.ended = true;
    this.wake();
  }
  private wake(): void {
    for (const w of this.waiters.splice(0)) w();
  }
  async read(size: number): Promise<ArrayBuffer> {
    for (;;) {
      if (this.chunks.length > 0) {
        const first = this.chunks[0] as Uint8Array;
        if (first.length <= size) {
          this.chunks.shift();
          return ab(first);
        }
        this.chunks[0] = first.subarray(size);
        return ab(first.subarray(0, size));
      }
      if (this.ended) throw new Error("stream finished");
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }
  async stop(code: bigint): Promise<void> {
    this.stopCode = code;
    this.ended = true;
    this.wake();
  }
  async bytesRead(): Promise<bigint> {
    return 0n;
  }
  async id(): Promise<string> {
    return "0";
  }
  async readExact(): Promise<ArrayBuffer> {
    throw new Error("not used");
  }
  async readToEnd(): Promise<ArrayBuffer> {
    throw new Error("not used");
  }
  async receivedReset(): Promise<bigint | undefined> {
    return undefined;
  }
}

function makePair() {
  const send = new FakeSend();
  const recv = new FakeRecv();
  const bi = {
    send: () => send,
    recv: () => recv,
  } as unknown as BiStreamLike;
  return { bi, send, recv };
}

const OK = "HTTP/1.1 200 OK\r\ncontent-length: 0\r\n\r\n";

describe("createIrohFetch", () => {
  it("serializes method, path, headers and content-length", async () => {
    const { bi, send, recv } = makePair();
    recv.push(bytes(OK));
    const fetchFn = createIrohFetch({ openStream: async () => bi });

    const response = await fetchFn(
      "http://daemon.iroh/api/session?directory=%2Ftmp%2Fproj",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"a":1}',
      },
    );

    expect(response.status).toBe(200);
    const head = send.head();
    const [requestLine, ...headerLines] = head.split("\r\n");
    expect(requestLine).toBe(
      "POST /api/session?directory=%2Ftmp%2Fproj HTTP/1.1",
    );
    expect(headerLines).toContain("host: daemon.iroh");
    expect(headerLines).toContain("connection: close");
    expect(headerLines).toContain("content-type: application/json");
    expect(headerLines).toContain("content-length: 7");
    expect(send.text().endsWith('{"a":1}')).toBe(true);
  });

  it("omits content-length for a bodyless GET", async () => {
    const { bi, send, recv } = makePair();
    recv.push(bytes(OK));
    const fetchFn = createIrohFetch({ openStream: async () => bi });

    await fetchFn("http://daemon.iroh/global/health");

    expect(send.head()).not.toContain("content-length");
    expect(send.head().split("\r\n")[0]).toBe("GET /global/health HTTP/1.1");
  });

  it("accepts a built Request (the SDK's call shape)", async () => {
    const { bi, send, recv } = makePair();
    recv.push(bytes(OK));
    const fetchFn = createIrohFetch({ openStream: async () => bi });

    const body = '{"location":{"directory":"/tmp"}}';
    const request = new Request("http://daemon.iroh/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    await fetchFn(request);

    expect(send.head().split("\r\n")[0]).toBe("POST /api/session HTTP/1.1");
    expect(send.head()).toContain(
      `content-length: ${new TextEncoder().encode(body).length}`,
    );
    expect(send.text().endsWith(body)).toBe(true);
  });

  it("reads a content-length body", async () => {
    const { bi, recv } = makePair();
    recv.push(bytes("HTTP/1.1 200 OK\r\ncontent-length: 5\r\n\r\nhello"));
    recv.end();
    const fetchFn = createIrohFetch({ openStream: async () => bi });

    const response = await fetchFn("http://daemon.iroh/global/health");
    expect(response.ok).toBe(true);
    expect(await response.text()).toBe("hello");
  });

  it("reads a chunked body", async () => {
    const { bi, recv } = makePair();
    recv.push(
      bytes(
        "HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n" +
          "5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n",
      ),
    );
    recv.end();
    const fetchFn = createIrohFetch({ openStream: async () => bi });

    const response = await fetchFn("http://daemon.iroh/api/session");
    expect(await response.text()).toBe("hello world");
  });

  it("reads a close-delimited body", async () => {
    const { bi, recv } = makePair();
    recv.push(bytes("HTTP/1.1 200 OK\r\n\r\nclose-delimited"));
    recv.end();
    const fetchFn = createIrohFetch({ openStream: async () => bi });

    const response = await fetchFn("http://daemon.iroh/api/session");
    expect(await response.text()).toBe("close-delimited");
  });

  it("delivers SSE chunks incrementally before the stream closes", async () => {
    const { bi, send, recv } = makePair();
    recv.push(
      bytes(
        "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\n\r\n" +
          'data: {"n":1}\n\n',
      ),
    );
    const fetchFn = createIrohFetch({ openStream: async () => bi });
    const response = await fetchFn(
      "http://daemon.iroh/api/session/ses_1/event",
    );
    expect(response.headers.get("content-type")).toBe("text/event-stream");

    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    if (reader === undefined) return;
    const read = async () => {
      const { value } = await reader.read();
      return value === undefined ? "" : new TextDecoder().decode(value);
    };

    expect(await read()).toContain('data: {"n":1}');
    expect(send.finished).toBe(false);

    recv.push(bytes('data: {"n":2}\n\n'));
    expect(await read()).toContain('data: {"n":2}');
    expect(send.finished).toBe(false);

    recv.push(bytes('data: {"n":3}\n\n'));
    expect(await read()).toContain('data: {"n":3}');
    expect(send.finished).toBe(false);

    recv.end();
    await reader.read();
    expect(send.finished).toBe(true);
  });

  it("aborts with reset + stop and errors the body with AbortError", async () => {
    const { bi, send, recv } = makePair();
    recv.push(
      bytes("HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\n\r\n"),
    );
    const fetchFn = createIrohFetch({ openStream: async () => bi });
    const controller = new AbortController();
    const response = await fetchFn(
      new Request("http://daemon.iroh/api/session/ses_1/event", {
        signal: controller.signal,
      }),
    );
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    if (reader === undefined) return;

    controller.abort();
    await expect(reader.read()).rejects.toMatchObject({ name: "AbortError" });
    expect(send.resetCode).toBe(0n);
    expect(recv.stopCode).toBe(0n);
  });

  it("aborts while the stream is still opening", async () => {
    const { bi, send, recv } = makePair();
    const controller = new AbortController();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchFn = createIrohFetch({
      openStream: async () => {
        await gate;
        return bi;
      },
    });
    const pending = fetchFn(
      new Request("http://daemon.iroh/global/health", {
        signal: controller.signal,
      }),
    );
    const assertion = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    controller.abort();
    release?.();
    await assertion;
    expect(send.resetCode).toBe(0n);
    expect(recv.stopCode).toBe(0n);
  });

  it("finishes only after the body has been consumed", async () => {
    const { bi, send, recv } = makePair();
    recv.push(bytes("HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nhi"));
    recv.end();
    const fetchFn = createIrohFetch({ openStream: async () => bi });

    const response = await fetchFn("http://daemon.iroh/api/session");
    await Promise.resolve();
    expect(send.finished).toBe(false);

    expect(await response.text()).toBe("hi");
    expect(send.finished).toBe(true);
  });

  it("rejects with a TypeError when the stream cannot be opened", async () => {
    const fetchFn = createIrohFetch({
      openStream: async () => {
        throw new Error("dial refused");
      },
    });
    await expect(fetchFn("http://daemon.iroh/global/health")).rejects.toThrow(
      TypeError,
    );
  });

  it("returns HTTP errors as responses without finishing early", async () => {
    const { bi, send, recv } = makePair();
    recv.push(
      bytes(
        'HTTP/1.1 502 Bad Gateway\r\ncontent-length: 12\r\n\r\n{"e": "bad"}',
      ),
    );
    recv.end();
    const fetchFn = createIrohFetch({ openStream: async () => bi });

    const response = await fetchFn("http://daemon.iroh/global/health");
    expect(response.ok).toBe(false);
    expect(response.status).toBe(502);
    expect(response.statusText).toBe("Bad Gateway");
    expect(await response.json()).toEqual({ e: "bad" });
    expect(send.finished).toBe(true);
  });
});
