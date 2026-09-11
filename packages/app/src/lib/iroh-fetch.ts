import type {
  BiStreamLike,
  RecvStreamLike,
  SendStreamLike,
} from "react-native-iroh-ffi";

/**
 * `fetch` over the daemon's iroh HTTP tunnel (`thinkite/http/1`, stage 3a):
 * one bi-stream per request carrying a plain HTTP/1.1 exchange. Shaped as a
 * real `fetch` so `@opencode-ai/sdk`'s client — and its SSE parser —
 * run unchanged: the SDK builds `new Request(url, init)`, hands it to us,
 * and reads `ok` / `status` / `statusText` / `headers` / `body.pipeThrough(
 * new TextDecoderStream())` / `json()` / `text()` / `arrayBuffer()`.
 *
 * The baseUrl is a placeholder origin (`http://daemon.iroh`); only the path
 * (+ query) is written on the wire. Credentials never cross the tunnel —
 * the daemon injects its own Basic auth toward opencode.
 *
 * Ported from the spike (`spike/iroh-http-client:packages/app/src/lib/
 * iroh-http.ts`), reshaped around a streaming body instead of a buffered
 * `text`.
 */

export interface IrohFetchOptions {
  /**
   * Open one fresh bi-stream to the daemon's `thinkite/http/1` endpoint.
   * `iroh-wire.ts` owns the shared QUIC connection and reuses it across
   * requests; errors thrown here surface to the caller as `fetch`'s
   * network `TypeError`.
   */
  openStream(): Promise<BiStreamLike>;
}

const READ_CHUNK = 64 * 1024;

const CRLF = [13, 10];
const CRLFCRLF = [13, 10, 13, 10];

const enc = (s: string): ArrayBuffer => {
  // Latin-1/ASCII fast path is wrong for non-ASCII; use manual UTF-8.
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      c = 0x10000 + ((c - 0xd800) << 10) + (s.charCodeAt(++i) - 0xdc00);
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000)
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else
      out.push(
        0xf0 | (c >> 18),
        0x80 | ((c >> 12) & 63),
        0x80 | ((c >> 6) & 63),
        0x80 | (c & 63),
      );
  }
  return Uint8Array.from(out).buffer;
};

const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

const concat = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
};

const indexOf = (buf: Uint8Array, pat: number[], from = 0): number => {
  outer: for (let i = from; i <= buf.length - pat.length; i++) {
    for (let j = 0; j < pat.length; j++) {
      if (buf[i + j] !== pat[j]) continue outer;
    }
    return i;
  }
  return -1;
};

/** fetch's abort error, without relying on `DOMException` on Hermes. */
function abortError(): Error {
  const err = new Error("The operation was aborted.");
  err.name = "AbortError";
  return err;
}

/** Connection failures reject like `fetch` does (TypeError). */
function networkError(cause: unknown): TypeError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new TypeError(`fetch failed: ${detail}`);
}

/** Incremental HTTP/1.1 response reader over a RecvStream. */
class ResponseReader {
  private buf: Uint8Array = new Uint8Array(0);
  private eof = false;

  constructor(private readonly recv: RecvStreamLike) {}

  private async fill(): Promise<boolean> {
    if (this.eof) return false;
    try {
      const chunk = new Uint8Array(await this.recv.read(READ_CHUNK));
      if (chunk.length === 0) {
        this.eof = true;
        return false;
      }
      this.buf = concat(this.buf, chunk);
      return true;
    } catch {
      // stream finished/reset by peer — EOF for HTTP purposes
      this.eof = true;
      return false;
    }
  }

  async head(): Promise<{
    status: number;
    statusText: string;
    /** Lowercase-keyed lookup for framing decisions. */
    lower: Record<string, string>;
    /** Original header pairs for the `Headers` object. */
    entries: [string, string][];
  }> {
    let at = indexOf(this.buf, CRLFCRLF);
    while (at < 0) {
      if (!(await this.fill())) {
        throw new Error("connection closed before HTTP headers");
      }
      at = indexOf(this.buf, CRLFCRLF);
    }
    const headText = dec(this.buf.subarray(0, at));
    this.buf = this.buf.subarray(at + 4);
    const lines = headText.split("\r\n");
    const statusMatch = /^HTTP\/\d(?:\.\d)? (\d{3})(?: (.*))?$/.exec(lines[0]);
    if (statusMatch === null) throw new Error("malformed HTTP status line");
    const status = Number(statusMatch[1]);
    const statusText = statusMatch[2] ?? "";
    const lower: Record<string, string> = {};
    const entries: [string, string][] = [];
    for (const line of lines.slice(1)) {
      const i = line.indexOf(":");
      if (i <= 0) continue;
      const name = line.slice(0, i).trim();
      const value = line.slice(i + 1).trim();
      lower[name.toLowerCase()] = value;
      entries.push([name, value]);
    }
    return { status, statusText, lower, entries };
  }

  /**
   * Body byte chunks honoring chunked / content-length / close-delimited
   * framing. `yield`s as bytes arrive — an SSE response never reaches the
   * end of the generator, so consumers see each event as it lands.
   */
  async *body(headers: Record<string, string>): AsyncGenerator<Uint8Array> {
    if ((headers["transfer-encoding"] ?? "").includes("chunked")) {
      for (;;) {
        let nl = indexOf(this.buf, CRLF);
        while (nl < 0) {
          if (!(await this.fill())) return;
          nl = indexOf(this.buf, CRLF);
        }
        const size = Number.parseInt(
          dec(this.buf.subarray(0, nl)).split(";")[0],
          16,
        );
        this.buf = this.buf.subarray(nl + 2);
        if (!Number.isFinite(size) || size <= 0) return;
        while (this.buf.length < size + 2) {
          if (!(await this.fill())) return;
        }
        yield this.buf.subarray(0, size);
        this.buf = this.buf.subarray(size + 2);
      }
    }
    const lenHeader = headers["content-length"];
    const len = lenHeader !== undefined ? Number(lenHeader) : -1;
    let got = 0;
    for (;;) {
      if (this.buf.length > 0) {
        const take =
          len >= 0 ? Math.min(this.buf.length, len - got) : this.buf.length;
        if (take > 0) {
          yield this.buf.subarray(0, take);
          got += take;
          this.buf = this.buf.subarray(take);
        }
      }
      if (len >= 0 && got >= len) return;
      if (!(await this.fill())) return;
    }
  }
}

function pathOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    // Relative input with no placeholder origin (tests, hand calls).
    return url.startsWith("/") ? url : `/${url}`;
  }
}

function buildHead(
  method: string,
  path: string,
  headers: Headers,
  contentLength: number | null,
): string {
  const lines = [
    `${method} ${path} HTTP/1.1`,
    "host: daemon.iroh",
    "connection: close",
  ];
  headers.forEach((value, name) => {
    const key = name.toLowerCase();
    // `connection`/`content-length`/`host` are ours: one bi-stream per
    // request, so the connection is always `close`, and the length must
    // match the bytes we actually write.
    if (key === "connection" || key === "content-length" || key === "host") {
      return;
    }
    lines.push(`${key}: ${value}`);
  });
  if (contentLength !== null) lines.push(`content-length: ${contentLength}`);
  return `${lines.join("\r\n")}\r\n\r\n`;
}

export function createIrohFetch({
  openStream,
}: IrohFetchOptions): typeof fetch {
  const irohFetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    // The SDK hands us a built Request; string/URL callers get normalized
    // the same way. Avoid `new Request(request)` when there is no init —
    // cloning a stream-bodied request can throw.
    const request =
      input instanceof Request && init === undefined
        ? input
        : new Request(input, init);
    const signal = request.signal;
    if (signal.aborted) throw abortError();

    const url = request.url;
    const path = pathOf(url);
    // RN's whatwg-fetch Request has no `.body` getter, so always read the
    // buffered body (an empty body yields an empty buffer). A zero-length
    // GET/HEAD body omits content-length; a POST/PUT/DELETE keeps the
    // explicit 0.
    const body = await request.arrayBuffer();
    const contentLength =
      body.byteLength > 0 ||
      (request.method !== "GET" && request.method !== "HEAD")
        ? body.byteLength
        : null;

    let bi: BiStreamLike;
    try {
      bi = await openStream();
    } catch (err) {
      if (signal.aborted) throw abortError();
      throw networkError(err);
    }
    const send: SendStreamLike = bi.send();
    const recv: RecvStreamLike = bi.recv();

    type Phase = "live" | "completed" | "aborted" | "failed";
    let phase: Phase = "live";
    let bodyController: ReadableStreamDefaultController<Uint8Array> | null =
      null;

    const resetQuietly = (): void => {
      send.reset(0n).catch(() => {});
      recv.stop(0n).catch(() => {});
    };
    const finishQuietly = (): void => {
      // Do NOT finish() before the response is consumed: a half-closed
      // stream reads as a closed socket to some HTTP servers (the daemon's
      // proxy sets httpAllowHalfOpen precisely because of this).
      send.finish().catch(() => {});
      recv.stop(0n).catch(() => {});
    };
    const onAbort = (): void => {
      if (phase !== "live") return;
      phase = "aborted";
      resetQuietly();
      try {
        bodyController?.error(abortError());
      } catch {
        // stream already closed
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const settle = (next: Exclude<Phase, "live">): void => {
      phase = next;
      signal.removeEventListener("abort", onAbort);
    };
    // Abort can land while `openStream()` was in flight, before the
    // listener above was registered: catch that case explicitly and reset
    // the stream we just opened before bailing.
    const throwIfAborted = (): void => {
      if (!signal.aborted) return;
      onAbort();
      settle("aborted");
      throw abortError();
    };
    throwIfAborted();

    try {
      await send.writeAll(
        enc(buildHead(request.method, path, request.headers, contentLength)),
      );
      if (body.byteLength > 0) await send.writeAll(body);
    } catch (err) {
      if (signal.aborted) throwIfAborted();
      settle("failed");
      resetQuietly();
      throw networkError(err);
    }
    throwIfAborted();

    const reader = new ResponseReader(recv);
    let head: Awaited<ReturnType<ResponseReader["head"]>>;
    try {
      head = await reader.head();
    } catch (err) {
      if (signal.aborted) throwIfAborted();
      settle("failed");
      resetQuietly();
      throw networkError(err);
    }
    throwIfAborted();

    const { status, statusText, lower, entries } = head;
    const complete = (): void => {
      if (phase !== "live") return;
      settle("completed");
      finishQuietly();
    };

    // Bodies that are empty by definition: the caller may never touch
    // `response.body` (the SDK short-circuits 204 / content-length 0), so
    // finish the request side here rather than leave the stream open.
    const emptyBody =
      request.method === "HEAD" ||
      status === 204 ||
      status === 304 ||
      lower["content-length"] === "0";

    let bodyStream: ReadableStream<Uint8Array>;
    if (emptyBody) {
      complete();
      bodyStream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      });
    } else {
      const chunks = reader.body(lower);
      bodyStream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          bodyController = controller;
          if (phase === "aborted") {
            controller.error(abortError());
            return;
          }
          try {
            const next = await chunks.next();
            if (next.done) {
              complete();
              controller.close();
              return;
            }
            controller.enqueue(next.value);
          } catch (err) {
            if (phase === "live") {
              settle("failed");
              resetQuietly();
            }
            controller.error(err);
          }
        },
        cancel() {
          if (phase === "live") {
            settle("aborted");
            resetQuietly();
          }
        },
      });
    }

    let bodyUsed = false;
    const readAll = async (): Promise<Uint8Array> => {
      if (bodyUsed) {
        throw new TypeError("Body is unusable: Body has already been read");
      }
      bodyUsed = true;
      const streamReader = bodyStream.getReader();
      const parts: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await streamReader.read();
        if (done) break;
        parts.push(value);
        total += value.length;
      }
      const out = new Uint8Array(total);
      let at = 0;
      for (const part of parts) {
        out.set(part, at);
        at += part.length;
      }
      return out;
    };

    // Plain object rather than a real `Response`: React Native's `Response`
    // rejects a `ReadableStream` body (its BodyInit is text/Blob/etc.), and
    // the SDK only touches the fields below. The cast keeps `typeof fetch`.
    const response = {
      ok: status >= 200 && status < 300,
      status,
      statusText,
      headers: new Headers(entries),
      url,
      redirected: false,
      type: "basic",
      body: bodyStream,
      get bodyUsed(): boolean {
        return bodyUsed;
      },
      arrayBuffer: async (): Promise<ArrayBuffer> => {
        const bytes = await readAll();
        return bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ) as ArrayBuffer;
      },
      text: async (): Promise<string> => dec(await readAll()),
      json: async <T = unknown>(): Promise<T> =>
        JSON.parse(dec(await readAll())) as T,
    };
    return response as unknown as Response;
  };
  return irohFetch as typeof fetch;
}
