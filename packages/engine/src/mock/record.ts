/**
 * The recording proxy (#60, `docs/specs/2026-10-08-mock-recording-design.md`): a loopback listener
 * that passes every request through to one upstream, relays the real response, and keeps each one
 * that reaches a contract operation as a masked stub. The stubs become a mock's response files when
 * the caller adds them with `addRecordedStubs` and saves the project.
 */

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { HttpError, WirebenchError } from '../errors.js';
import { decodeBody } from '../http/charset.js';
import { sendHttp } from '../http/client.js';
import type { HttpExchange, HttpRequest, ProxyOptions, TlsOptions } from '../http/types.js';
import { defaultRegistry } from '../protocols.js';
import { nodeFs } from '../project/fs.js';
import type { FsLike } from '../project/fs.js';
import type { Project } from '../project/model.js';
import type { ProtocolRegistry } from '../protocol/registry.js';
import {
  REDACTED_XML_MARKER,
  redactHeaderPairs,
  redactSecurityTokens,
  redactStructuredBody,
  redactXml,
} from '../redact/index.js';
import { createSecretMasker } from '../redact/literal.js';
import type { HeaderPair } from '../script/model.js';
import type { MockProblem, MockRequest } from './contract.js';
import { MOCK_RESERVED_HEADERS } from './file.js';
import {
  cut,
  headerPairs,
  hostnameOf,
  isLoopback,
  listen,
  maskedUrl,
  plain,
  queryOf,
  readBody,
  urlHost,
  write,
} from './http.js';
import { MOCK_LIMITS, mockPathPrefix } from './model.js';
import type { MockBodyLanguage, MockHeader } from './model.js';
import type { MockRecording } from './record-stubs.js';
import { MOCK_REQUEST_BODY_BYTES, MOCK_REQUEST_TIMEOUT_MS, findMock, openMockContract } from './server.js';
import type { MockEventMessage } from './server.js';

/** How long the upstream has to answer, by default. */
export const RECORD_UPSTREAM_TIMEOUT_MS = 60_000;
/** The largest upstream response the recorder relays; larger is a 502. */
export const RECORD_RELAY_BYTES = 64 * 1024 * 1024;

/** Headers that describe one connection, not the message: never forwarded, relayed or kept. */
const HOP_BY_HOP: ReadonlySet<string> = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const METHODS: ReadonlySet<string> = new Set(['GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS', 'PATCH']);

export interface StartRecorderInput {
  readonly project: Project;
  /** The project folder, for the definition cache. */
  readonly root: string;
  readonly mockId: string;
  /** The real system: an absolute `http:` or `https:` URL. The mock's `path` maps onto its path. */
  readonly target: string;
  /** Default `127.0.0.1`. */
  readonly host?: string;
  /** Overrides the mock's own `port`. */
  readonly port?: number;
  /** For the upstream connection. */
  readonly tls?: TlsOptions;
  readonly proxy?: ProxyOptions;
  /** How long the upstream has to answer; default {@link RECORD_UPSTREAM_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /** Values masked wherever they appear in a kept response, besides what the patterns mask. */
  readonly secrets?: readonly string[];
  readonly fs?: FsLike;
  readonly registry?: ProtocolRegistry;
  readonly onExchange?: (event: RecordExchangeEvent) => void;
}

/** One request the recorder passed through (spec §For each request, step 7). */
export interface RecordExchangeEvent {
  /** Increasing per recorder. */
  readonly seq: number;
  /** ISO time the request arrived. */
  readonly at: string;
  readonly method: string;
  /** Path and query, with sensitive query values masked. */
  readonly url: string;
  /** The contract operation the request routed to. */
  readonly operation?: string;
  readonly status: number;
  readonly durationMs: number;
  /** Whether the response was kept as a stub. */
  readonly recorded: boolean;
  /** Why the response was not kept. */
  readonly problems: readonly MockProblem[];
  /** What stopped the request reaching the target, or the recorder answering. */
  readonly error?: { readonly code: string; readonly message: string };
  readonly request: MockEventMessage;
  readonly response: MockEventMessage;
}

export interface RunningRecorder {
  /** `http://<host>:<port><path>`: where a client sends what it would send to the target. */
  readonly url: string;
  readonly host: string;
  readonly port: number;
  /** Every response kept so far, masked, in the order they arrived. */
  recordings(): readonly MockRecording[];
  /** Stops listening, aborts what is in flight, and closes every connection. */
  stop(): Promise<void>;
}

/**
 * The target without query or fragment.
 *
 * @throws WirebenchError `mock-record-target-invalid`
 */
function parseTarget(target: string): URL {
  let url: URL | undefined;
  try {
    url = new URL(target);
  } catch {
    url = undefined;
  }
  if (url !== undefined && (url.username !== '' || url.password !== '')) {
    // The forwarded URL is built from the origin, which has no userinfo: refuse rather than drop it.
    throw new WirebenchError(
      'mock-record-target-invalid',
      'The target must not carry credentials; the client sends its own with each request',
      { details: { target: `${url.protocol}//${url.host}` } },
    );
  }
  if (url === undefined || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
    throw new WirebenchError(
      'mock-record-target-invalid',
      `The target ${target} is not an absolute http or https URL`,
      {
        details: { target },
      },
    );
  }
  url.hash = '';
  url.search = '';
  return url;
}

/**
 * Where a request goes: the target's origin and path, then what follows the mock's prefix in the
 * request path, then the raw query. The origin is the target's whatever the request path holds.
 */
function upstreamUrl(target: URL, prefix: string, request: MockRequest): string {
  const base = target.pathname.replace(/\/+$/, '');
  const rest = request.path.slice(prefix.length);
  const path = `${base}${rest}`;
  return `${target.origin}${path === '' ? '/' : path}${request.rawQuery === '' ? '' : `?${request.rawQuery}`}`;
}

/**
 * Conditional request headers: forwarded, they would let the upstream answer 304 with no body, and a
 * recording needs the full response.
 */
const CONDITIONAL: ReadonlySet<string> = new Set([
  'if-match',
  'if-none-match',
  'if-modified-since',
  'if-unmodified-since',
  'if-range',
]);

/** The hop-by-hop fields, and every field the message's own `Connection` header names (RFC 9110 §7.6.1). */
function hopByHop(pairs: readonly (readonly [string, string])[]): Set<string> {
  const names = new Set(HOP_BY_HOP);
  for (const [name, value] of pairs) {
    if (name.toLowerCase() !== 'connection') continue;
    for (const token of value.split(',')) {
      const field = token.trim().toLowerCase();
      if (field !== '') names.add(field);
    }
  }
  return names;
}

/**
 * The request's headers for `sendHttp`: no hop-by-hop field, no `Host`, no `Content-Length` and no
 * conditional header.
 */
function forwardHeaders(pairs: readonly HeaderPair[]): Record<string, string> {
  const headers: Record<string, string> = {};
  const names = new Map<string, string>();
  const hop = hopByHop(pairs);
  for (const [name, value] of pairs) {
    const lower = name.toLowerCase();
    if (hop.has(lower) || CONDITIONAL.has(lower) || lower === 'host' || lower === 'content-length') continue;
    const first = names.get(lower);
    if (first === undefined) {
      names.set(lower, name);
      headers[name] = value;
    } else {
      headers[first] = `${headers[first] ?? ''}${lower === 'cookie' ? '; ' : ', '}${value}`;
    }
  }
  return headers;
}

/** The upstream's headers as the client gets them: the body is relayed decompressed and re-measured. */
function relayHeaders(pairs: readonly (readonly [string, string])[]): HeaderPair[] {
  const hop = hopByHop(pairs);
  return pairs
    .filter(([name]) => {
      const lower = name.toLowerCase();
      return !hop.has(lower) && lower !== 'content-encoding' && lower !== 'content-length';
    })
    .map(([name, value]): HeaderPair => [name, value]);
}

function headerValue(pairs: readonly (readonly [string, string])[], name: string): string | undefined {
  return pairs.find(([candidate]) => candidate.toLowerCase() === name)?.[1];
}

/** The language a body of `contentType` is kept in, or `binary` when a stub cannot hold it. */
function bodyLanguage(contentType: string | undefined): Exclude<MockBodyLanguage, 'none'> | 'binary' {
  const type = (contentType?.split(';')[0] ?? '').trim().toLowerCase();
  if (type === '') return 'text';
  if (type === 'text/xml' || type === 'application/xml' || type.endsWith('+xml')) return 'xml';
  if (type === 'application/json' || type.endsWith('+json')) return 'json';
  if (type.startsWith('text/') || type === 'application/x-www-form-urlencoded') return 'text';
  return 'binary';
}

/** A `Content-Type` naming another charset says `utf-8` instead: a stub file is UTF-8, sent as is. */
function utf8ContentType(value: string): string {
  const charset = /charset=("?)([^";]*)\1/i.exec(value)?.[2]?.trim().toLowerCase();
  return charset === undefined || charset === 'utf-8' || charset === 'utf8'
    ? value
    : value.replace(/charset=("[^"]*"|[^;]*)/i, 'charset=utf-8');
}

/** Whether `text` is a JSON object or array, whatever its `Content-Type` says. */
function looksLikeJson(text: string): boolean {
  const start = text.trimStart()[0];
  if (start !== '{' && start !== '[') return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

interface Masks {
  readonly text?: (text: string) => string;
  readonly xml?: (text: string) => string;
}

type Kept =
  { readonly ok: true; readonly recording: MockRecording } | { readonly ok: false; readonly problem: MockProblem };

/** The upstream's response as a masked stub (spec §What a recording keeps, §Masking), or why not. */
function keep(
  exchange: HttpExchange,
  method: string,
  operation: { readonly key: string; readonly name: string },
  masks: Masks,
): Kept {
  const contentType = headerValue(exchange.rawHeaders, 'content-type');
  const language = exchange.body.byteLength === 0 || method === 'HEAD' ? 'none' : bodyLanguage(contentType);
  if (language === 'binary') {
    return {
      ok: false,
      problem: { code: 'mock-record-binary', message: `A ${String(contentType)} body cannot be kept as a stub` },
    };
  }
  if (exchange.body.byteLength > MOCK_LIMITS.bodyBytes) {
    return {
      ok: false,
      problem: {
        code: 'mock-record-too-large',
        message: `The body is larger than a stub may be (${String(MOCK_LIMITS.bodyBytes)} bytes)`,
      },
    };
  }
  let bodyText = '';
  if (language === 'xml') {
    bodyText = redactSecurityTokens(redactXml(decodeBody(exchange.body, contentType).text));
    bodyText = masks.xml?.(bodyText) ?? bodyText;
  } else if (language !== 'none') {
    bodyText = decodeBody(exchange.body, contentType).text;
    // JSON served as text is still JSON: its secret keys are masked as for application/json.
    const maskedAs = language === 'text' && looksLikeJson(bodyText) ? 'application/json' : contentType;
    // The structured mask re-serialises JSON; the server's own text stays when it masked nothing,
    // which is when the result equals the same re-serialisation with no key counted secret.
    const structured = redactStructuredBody(bodyText, maskedAs);
    if (structured !== redactStructuredBody(bodyText, maskedAs, { isSecretKey: () => false })) {
      bodyText = structured;
    }
    bodyText = masks.text?.(bodyText) ?? bodyText;
  }
  const hop = hopByHop(exchange.rawHeaders);
  const kept = exchange.rawHeaders.filter(([name]) => {
    const lower = name.toLowerCase();
    return !hop.has(lower) && !MOCK_RESERVED_HEADERS.has(lower) && lower !== 'content-encoding' && lower !== 'date';
  });
  const headers = redactHeaderPairs(kept).map(([name, value]): MockHeader => {
    const own = name.toLowerCase() === 'content-type' ? utf8ContentType(value) : value;
    return { name, value: masks.text?.(own) ?? own };
  });
  return {
    ok: true,
    recording: {
      operation: operation.key,
      operationName: operation.name,
      status: exchange.status,
      headers,
      body: language,
      bodyText,
    },
  };
}

/** Writes the upstream's status, headers and decompressed bytes to the client. */
function relay(res: ServerResponse, exchange: HttpExchange, headers: readonly HeaderPair[], method: string): void {
  // A HEAD reply's length is the representation's, and a 204 or 304 carries none (RFC 9110 §8.6).
  if (method === 'HEAD' || exchange.status === 204 || exchange.status === 304) {
    const length = method === 'HEAD' ? headerValue(exchange.rawHeaders, 'content-length') : undefined;
    const grouped = new Map<string, { name: string; values: string[] }>();
    for (const [name, value] of headers) {
      const entry = grouped.get(name.toLowerCase()) ?? { name, values: [] };
      entry.values.push(value);
      grouped.set(name.toLowerCase(), entry);
    }
    for (const { name, values } of grouped.values()) {
      res.setHeader(name, values.length === 1 ? (values[0] as string) : values);
    }
    if (length !== undefined) res.setHeader('Content-Length', length);
    res.writeHead(exchange.status);
    res.end();
    return;
  }
  write(res, { status: exchange.status, headers, body: Buffer.from(exchange.body) });
}

/**
 * Starts recording traffic for the mock `input.mockId` from `input.target` (spec §Engine).
 *
 * @throws WirebenchError `mock-record-target-invalid`, `mock-not-found`, `mock-container-missing`,
 * `mock-protocol-unsupported`, `mock-definition-missing`, `mock-binding-unknown`, `mock-port-in-use`,
 * `mock-listen-failed`
 */
export async function startRecorder(input: StartRecorderInput): Promise<RunningRecorder> {
  const target = parseTarget(input.target);
  const mock = findMock(input.project, input.mockId);
  const fs = input.fs ?? nodeFs;
  const contract = await openMockContract(input.project, mock, input.root, fs, input.registry ?? defaultRegistry());
  const names = new Map(contract.operations.map((operation) => [operation.key, operation.name]));
  const secrets = (input.secrets ?? []).filter((value) => value.length > 0);
  const masks: Masks =
    secrets.length > 0
      ? { text: createSecretMasker(secrets), xml: createSecretMasker(secrets, { marker: REDACTED_XML_MARKER }) }
      : {};

  const host = input.host ?? '127.0.0.1';
  const loopbackOnly = isLoopback(host);
  const prefix = mockPathPrefix(mock.path);
  const underPath = (path: string): boolean => prefix === '' || path === prefix || path.startsWith(`${prefix}/`);
  const recordings: MockRecording[] = [];
  const inflight = new Set<AbortController>();
  let seq = 0;

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const started = Date.now();
    const at = new Date(started).toISOString();
    const method = (req.method ?? 'GET').toUpperCase();
    const parsed = new URL(req.url ?? '/', 'http://mock.invalid');
    const headers = headerPairs(req);
    let requestText = '';
    const emit = (
      status: number,
      responseHeaders: readonly HeaderPair[],
      responseText: string,
      extra: Partial<Pick<RecordExchangeEvent, 'operation' | 'recorded' | 'problems' | 'error'>>,
    ): void =>
      input.onExchange?.({
        seq: ++seq,
        at,
        method,
        url: maskedUrl(`${parsed.pathname}${parsed.search}`),
        status,
        durationMs: Date.now() - started,
        recorded: false,
        problems: [],
        ...extra,
        request: { headers: redactHeaderPairs(headers), ...cut(requestText) },
        response: { headers: redactHeaderPairs(responseHeaders), ...cut(responseText) },
      });
    const refuse = (status: number, text: string, code: string, message: string): void => {
      const reply = plain(status, text);
      write(res, reply);
      emit(reply.status, reply.headers, reply.body, { error: { code, message } });
    };

    const hostname = hostnameOf(req.headers.host);
    if (loopbackOnly && (hostname === undefined || !isLoopback(hostname))) {
      req.resume();
      refuse(
        421,
        'This recorder answers only requests addressed to localhost',
        'mock-host-refused',
        `Host ${String(req.headers.host)} is not a loopback name`,
      );
      return;
    }
    const body = await readBody(req);
    if (body === undefined) {
      res.setHeader('Connection', 'close');
      refuse(
        413,
        `The request body is larger than ${String(MOCK_REQUEST_BODY_BYTES)} bytes`,
        'mock-request-too-large',
        'The request body is over the limit',
      );
      return;
    }
    requestText = body.toString('utf8');
    const request: MockRequest = {
      method,
      path: parsed.pathname,
      query: queryOf(parsed.searchParams),
      rawQuery: parsed.search.startsWith('?') ? parsed.search.slice(1) : parsed.search,
      headers,
      body,
      bodyText: requestText,
    };
    if (!underPath(request.path)) {
      refuse(
        404,
        `Nothing is recorded at ${request.path}; the recorder is at ${mock.path}`,
        'mock-operation-not-found',
        `Outside ${mock.path}`,
      );
      return;
    }
    if (!METHODS.has(method)) {
      refuse(
        501,
        `The recorder does not forward ${method}`,
        'mock-record-upstream-failed',
        `${method} is not forwarded`,
      );
      return;
    }

    const controller = new AbortController();
    inflight.add(controller);
    // A client that goes away does not need its answer: stop waiting for the upstream.
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });
    let exchange: HttpExchange;
    try {
      const forward: HttpRequest = {
        url: upstreamUrl(target, prefix, request),
        method: method as HttpRequest['method'],
        headers: forwardHeaders(headers),
        ...(body.byteLength > 0 ? { body: new Uint8Array(body) } : {}),
        timeoutMs: input.timeoutMs ?? RECORD_UPSTREAM_TIMEOUT_MS,
        followRedirects: false,
        maxSizeBytes: RECORD_RELAY_BYTES,
        decompress: true,
        signal: controller.signal,
        ...(input.tls !== undefined ? { tls: input.tls } : {}),
        ...(input.proxy !== undefined ? { proxy: input.proxy } : {}),
      };
      exchange = await sendHttp(forward);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const timeout = error instanceof HttpError && error.code === 'timeout';
      // The client gets a fixed text; the cause, which may echo what the network said, goes to the log only.
      refuse(
        timeout ? 504 : 502,
        timeout ? 'The target did not answer in time' : 'The recorder could not reach the target',
        'mock-record-upstream-failed',
        message,
      );
      return;
    } finally {
      inflight.delete(controller);
    }
    if (exchange.truncated) {
      refuse(
        502,
        `The target's response is larger than ${String(RECORD_RELAY_BYTES)} bytes`,
        'mock-record-upstream-failed',
        'The response is over the relay limit',
      );
      return;
    }

    // The client gets the real response; only what is kept is masked.
    const relayed = relayHeaders(exchange.rawHeaders);
    const relayedText = (): string => decodeBody(exchange.body, headerValue(exchange.rawHeaders, 'content-type')).text;
    const done = (extra: Parameters<typeof emit>[3]): void => {
      relay(res, exchange, relayed, method);
      emit(exchange.status, relayed, relayedText(), extra);
    };
    const mockUrl = `http://${req.headers.host ?? `${urlHost(host)}:${String(running.port)}`}${mock.path}`;
    if (contract.definition(request, mockUrl) !== undefined) {
      done({});
      return;
    }
    const route = await contract.route(request, 'off', mockUrl);
    if (route.kind === 'refused') {
      const why = route.problems[0]?.message;
      done({
        ...(route.operation !== undefined ? { operation: route.operation } : {}),
        problems: [
          {
            code: 'mock-record-unrouted',
            message: `No operation of the contract matches this request${why !== undefined ? `: ${why}` : ''}`,
          },
        ],
      });
      return;
    }
    const kept = keep(
      exchange,
      method,
      { key: route.operation, name: names.get(route.operation) ?? route.operation },
      masks,
    );
    if (!kept.ok) {
      done({ operation: route.operation, problems: [kept.problem] });
      return;
    }
    recordings.push(kept.recording);
    done({ operation: route.operation, recorded: true });
  };

  const server: Server = createServer(
    { requireHostHeader: false, headersTimeout: MOCK_REQUEST_TIMEOUT_MS, requestTimeout: MOCK_REQUEST_TIMEOUT_MS },
    (req, res) => {
      handle(req, res).catch((error: unknown) => {
        if (!res.headersSent) write(res, plain(500, 'The recorder failed to answer'));
        input.onExchange?.({
          seq: ++seq,
          at: new Date().toISOString(),
          method: req.method ?? 'GET',
          url: maskedUrl(req.url ?? '/'),
          status: 500,
          durationMs: 0,
          recorded: false,
          problems: [],
          error: { code: 'mock-failed', message: error instanceof Error ? error.message : String(error) },
          request: { headers: [], body: '', truncated: false },
          response: { headers: [], body: '', truncated: false },
        });
      });
    },
  );
  const listening = await listen(server, host, input.port ?? mock.port, 'recorder');
  const running: RunningRecorder = {
    url: `http://${urlHost(host)}:${String(listening.port)}${mock.path}`,
    host,
    port: listening.port,
    recordings: () => [...recordings],
    stop: async () => {
      for (const controller of inflight) controller.abort();
      await listening.close();
    },
  };
  return running;
}
