/**
 * What both HTTP transports of an MCP session share (#79): the options an HTTP call is made with,
 * the record kept of each call, the dispatcher a session owns, and the errors a call fails with.
 *
 * Every call goes through the engine's `sendHttp`, so it gets the proxy, TLS, client certificates
 * and timings a REST send gets. The headers handed in are already expanded, with auth applied:
 * the run facet resolves those once per send and the transports only carry them on every call.
 */
import type { Dispatcher } from 'undici';
import { HttpError, McpError, WirebenchError } from '#core/errors';
import { createDispatcher } from '#core/http/client';
import { createSseParser, type SseParser } from '#core/http/sse';
import type { HttpExchange, ProxyOptions, Timings, TlsOptions } from '#core/http/types';
import type { EgressPolicy } from '#core/net/egress';
import type { JsonRpcId } from './jsonrpc.js';
import { MCP_DEFAULT_TIMEOUT_MS, MCP_MAX_MESSAGE_BYTES } from './limits.js';

/** How much of an error response's body the `mcp-http-status` error carries. */
const ERROR_BODY_BYTES = 4 * 1024;

/** Options both HTTP transports take. Every string is already expanded. */
export interface McpHttpConnectionOptions {
  readonly url: string;
  /** Sent on every call, auth included. The transport's own headers win over a same-named one here. */
  readonly headers: Readonly<Record<string, string>>;
  readonly tls?: TlsOptions;
  readonly proxy?: ProxyOptions;
  readonly localAddress?: string;
  /** The egress rule a server applies (spec §17.5); absent, no check. */
  readonly egress?: EgressPolicy;
  /** See `HttpRequest.allowH2`. */
  readonly allowH2?: boolean;
  /** Each call's own limit; the session's deadline is the one that normally ends it. Default 30 s. */
  readonly timeoutMs?: number;
}

/** One HTTP call of a session, as the exchange records it. */
export interface McpHttpCall {
  readonly method: string;
  readonly url: string;
  /** ISO 8601. */
  readonly startedAt: string;
  /** `0` when no response came. */
  readonly status: number;
  readonly requestHeaders: Readonly<Record<string, string>>;
  /** Lower-cased names, as `sendHttp` gives them. */
  readonly responseHeaders: Readonly<Record<string, string>>;
  /** Absent when no response came. */
  readonly timings?: Timings;
  /** The JSON-RPC message the call carried, read from what was sent; absent for a GET or a DELETE. */
  readonly message?: { readonly id?: JsonRpcId; readonly method?: string };
  /** Why the call failed on the way: the network, TLS, the deadline. */
  readonly error?: string;
}

/** The calls of one session, in the order they started, each filled in as it finishes. */
export class McpHttpCallLog {
  private readonly entries: McpHttpCall[] = [];

  /** Reserves the call's place; the returned function fills it in. */
  begin(start: Omit<McpHttpCall, 'startedAt' | 'status' | 'responseHeaders'>): (end: Partial<McpHttpCall>) => void {
    const index = this.entries.length;
    const first: McpHttpCall = { ...start, startedAt: new Date().toISOString(), status: 0, responseHeaders: {} };
    this.entries.push(first);
    return (end) => {
      this.entries[index] = { ...this.entries[index]!, ...end };
    };
  }

  get calls(): readonly McpHttpCall[] {
    return [...this.entries];
  }
}

/** What a finished `sendHttp` adds to its call's record. */
export function callEnd(exchange: HttpExchange): Partial<McpHttpCall> {
  return {
    status: exchange.status,
    requestHeaders: exchange.request.headers,
    responseHeaders: exchange.headers,
    timings: exchange.timings,
  };
}

/** A session's dispatcher: its own when TLS, a proxy or a bind address is set, else the shared one. */
export interface McpDispatcher {
  readonly dispatcher: Dispatcher;
  /** True when the session must close it. */
  readonly owned: boolean;
}

/** @throws McpError `mcp-transport-failed` for options undici refuses (a malformed proxy URL) */
export function openMcpDispatcher(options: McpHttpConnectionOptions): McpDispatcher {
  const owned =
    options.tls !== undefined ||
    options.proxy !== undefined ||
    options.localAddress !== undefined ||
    options.allowH2 === false ||
    options.egress !== undefined;
  try {
    return {
      dispatcher: createDispatcher({
        ...(options.tls !== undefined ? { tls: options.tls } : {}),
        ...(options.proxy !== undefined ? { proxy: options.proxy } : {}),
        ...(options.localAddress !== undefined ? { localAddress: options.localAddress } : {}),
        ...(options.allowH2 !== undefined ? { allowH2: options.allowH2 } : {}),
        ...(options.egress !== undefined ? { egress: options.egress } : {}),
      }),
      owned,
    };
  } catch (err) {
    if (err instanceof WirebenchError && err.code === 'egress-refused') throw err;
    throw new McpError('mcp-transport-failed', err instanceof Error ? err.message : String(err), { cause: err });
  }
}

/** Closes an owned dispatcher; a forced close does not wait for anything still on it. Never rejects. */
export async function closeMcpDispatcher(handle: McpDispatcher | undefined, force: boolean): Promise<void> {
  if (handle === undefined || !handle.owned) return;
  await (force ? handle.dispatcher.destroy() : handle.dispatcher.close()).catch(() => undefined);
}

/** A call's timeout. */
export const callTimeoutMs = (options: McpHttpConnectionOptions): number => options.timeoutMs ?? MCP_DEFAULT_TIMEOUT_MS;

/**
 * `base` with `own` over it, a name in `own` replacing a same-named one in `base` whatever its case,
 * so a user's `accept` cannot go out beside the transport's `Accept`.
 */
export function withHeaders(
  base: Readonly<Record<string, string>>,
  own: Readonly<Record<string, string>>,
): Record<string, string> {
  const ownNames = new Set(Object.keys(own).map((name) => name.toLowerCase()));
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) if (!ownNames.has(name.toLowerCase())) out[name] = value;
  return { ...out, ...own };
}

/** The id and method of an encoded message the session sends, for the call's record. */
export function messageSummary(text: string): McpHttpCall['message'] {
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
    const record = value as Record<string, unknown>;
    const id = record['id'];
    const method = record['method'];
    return {
      ...(typeof id === 'string' || typeof id === 'number' ? { id } : {}),
      ...(typeof method === 'string' ? { method } : {}),
    };
  } catch {
    return {};
  }
}

export const isSuccess = (status: number): boolean => status >= 200 && status < 300;

/** The text of a response body, its first `bytes`. */
export function bodyText(body: Uint8Array, bytes: number = body.length): string {
  return Buffer.from(body.buffer, body.byteOffset, Math.min(body.length, bytes)).toString('utf8');
}

/** A call the server answered with a status that is not 2xx. */
export function httpStatusError(exchange: HttpExchange, what: string): McpError {
  const status = `${exchange.status}${exchange.statusText !== '' ? ` ${exchange.statusText}` : ''}`;
  return new McpError('mcp-http-status', `The MCP server answered ${what} with HTTP ${status}`, {
    details: {
      status: exchange.status,
      method: exchange.request.method,
      url: exchange.request.url,
      body: bodyText(exchange.body, ERROR_BODY_BYTES),
    },
  });
}

/**
 * A call that got no answer: the network, TLS, a proxy, the call's own timeout. An egress refusal
 * (spec §17.5) keeps its code `egress-refused`.
 */
export function httpFailedError(err: unknown, method: string, url: string): McpError {
  if (err instanceof McpError) return err;
  // The egress rule's refusal keeps its code, message and details, as a send's does: it says why,
  // without the address.
  for (let cause: unknown = err, depth = 0; depth < 5 && cause instanceof Error; depth++) {
    if (cause instanceof WirebenchError && cause.code === 'egress-refused') {
      return new McpError('egress-refused', cause.message, {
        ...(cause.details !== undefined ? { details: cause.details } : {}),
        cause,
      });
    }
    cause = cause.cause;
  }
  const reason = err instanceof Error ? err.message : String(err);
  return new McpError('mcp-http-failed', `The MCP ${method} to ${url} failed: ${reason}`, {
    details: {
      method,
      url,
      ...(err instanceof HttpError ? { reason: err.code, ...err.details } : {}),
    },
    cause: err,
  });
}

/** A message, or a stream event still being read, over the cap. */
export function tooLargeError(bytes: number): McpError {
  return new McpError(
    'mcp-message-too-large',
    `The MCP server sent a message larger than ${MCP_MAX_MESSAGE_BYTES} bytes`,
    { details: { bytes, limit: MCP_MAX_MESSAGE_BYTES } },
  );
}

/**
 * An event-stream reader: each event goes to `onEvent` with its type and data. One event may not
 * grow past the message cap, so a stream that never ends its event cannot hold memory without
 * bound; `onTooLarge` is told, once, and nothing more is read.
 */
export function eventStreamReader(
  onEvent: (event: string, data: string) => void,
  onTooLarge: (error: McpError) => void,
): SseParser {
  let pendingBytes = 0;
  let failed = false;
  const parser = createSseParser((row) => {
    if (row.kind !== 'event') return;
    pendingBytes = 0;
    onEvent(row.event, row.data);
  });
  return {
    push(chunk, at) {
      if (failed) return;
      pendingBytes += chunk.length;
      // The line framing around the data is allowed for, beyond the cap on the data itself.
      if (pendingBytes > MCP_MAX_MESSAGE_BYTES + 64 * 1024) {
        failed = true;
        onTooLarge(tooLargeError(pendingBytes));
        return;
      }
      parser.push(chunk, at);
    },
    end() {
      if (!failed) parser.end();
    },
  };
}

/** Waits for `calls` to settle, or `ms`, whichever is first. Never rejects. */
export async function settleWithin(calls: readonly Promise<unknown>[], ms: number): Promise<void> {
  if (calls.length === 0) return;
  let timer: NodeJS.Timeout | undefined;
  const cap = new Promise<void>((done) => {
    timer = setTimeout(done, ms);
  });
  await Promise.race([Promise.allSettled(calls), cap]);
  clearTimeout(timer);
}
