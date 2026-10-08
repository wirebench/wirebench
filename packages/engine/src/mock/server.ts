/**
 * Serving a mock over HTTP (spec §Running a mock): `startMock` opens the mock's contract through its
 * protocol's facet, listens with `node:http`, and answers every request by serving a definition,
 * refusing it, or dispatching it to a stub. It needs neither Electron nor the desktop: the CLI's
 * `wirebench mock` (#61) and the desktop's mock runner both call it.
 */

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { WirebenchError } from '../errors.js';
import { defaultRegistry } from '../protocols.js';
import { nodeFs } from '../project/fs.js';
import type { FsLike } from '../project/fs.js';
import type { Project } from '../project/model.js';
import type { ProtocolRegistry } from '../protocol/registry.js';
import { redactHeaderPairs, redactUrl } from '../redact/index.js';
import type { HeaderPair } from '../script/model.js';
import { createScriptSandbox } from '../script/sandbox/host.js';
import type { ScriptSandbox } from '../script/sandbox/host.js';
import type { MockContract, MockProblem, MockReply, MockRequest } from './contract.js';
import { MockState, dispatch } from './dispatch.js';
import type { MockDef, MockOperation, MockResponse } from './model.js';
import { createDispatchScriptRunner } from './script.js';

/** The largest request body a mock reads; larger is refused with 413. */
export const MOCK_REQUEST_BODY_BYTES = 10 * 1024 * 1024;
/** How long a client has to send the headers, and the whole request. */
export const MOCK_REQUEST_TIMEOUT_MS = 30_000;
/** How much of each body a log event carries. */
export const MOCK_EVENT_BODY_BYTES = 64 * 1024;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export interface StartMockInput {
  readonly project: Project;
  /** The project folder, for the definition cache. */
  readonly root: string;
  readonly mockId: string;
  /** Default `127.0.0.1`. Anything else is the caller's choice, never the mock file's. */
  readonly host?: string;
  /** Overrides the mock's own `port`. */
  readonly port?: number;
  readonly fs?: FsLike;
  readonly registry?: ProtocolRegistry;
  /** A sandbox for dispatch scripts; without one, the mock starts its own on first use. */
  readonly sandbox?: ScriptSandbox;
  /** Milliseconds a dispatch script may run (clamped as a request script's is). */
  readonly scriptTimeoutMs?: number;
  readonly onExchange?: (event: MockExchangeEvent) => void;
}

/** Something about the mock worth saying at start, which does not stop it. */
export interface MockWarning {
  readonly code: 'mock-operation-unknown';
  readonly message: string;
  readonly operationId: string;
}

/** One side of an exchange, as a log shows it: sensitive headers masked, the body cut short. */
export interface MockEventMessage {
  readonly headers: readonly HeaderPair[];
  readonly body: string;
  readonly truncated: boolean;
}

/** One request a mock answered (spec §Running a mock). */
export interface MockExchangeEvent {
  /** Increasing per running mock. */
  readonly seq: number;
  /** ISO time the request arrived. */
  readonly at: string;
  readonly method: string;
  /** Path and query, with sensitive query values masked. */
  readonly url: string;
  readonly operation?: string;
  readonly responseId?: string;
  readonly responseName?: string;
  readonly status: number;
  readonly durationMs: number;
  readonly problems: readonly MockProblem[];
  readonly error?: { readonly code: string; readonly message: string };
  /** What a dispatch script logged. */
  readonly log?: readonly string[];
  readonly request: MockEventMessage;
  readonly response: MockEventMessage;
}

export interface RunningMock {
  /** `http://<host>:<port><path>`. */
  readonly url: string;
  readonly host: string;
  readonly port: number;
  readonly warnings: readonly MockWarning[];
  /** Every scenario back to its start state, every sequence counter to 0. */
  reset(): void;
  /** Stops listening and closes every connection; pending delayed replies are dropped. */
  stop(): Promise<void>;
}

function mockError(code: string, message: string, details?: Record<string, unknown>): WirebenchError {
  return new WirebenchError(code, message, details !== undefined ? { details } : undefined);
}

function findMock(project: Project, mockId: string): MockDef {
  const mock = project.mocks.find((candidate) => candidate.id === mockId);
  if (mock === undefined) {
    throw mockError('mock-not-found', `The project has no mock with id ${mockId}`, { mockId });
  }
  return mock;
}

/**
 * Opens the contract a mock implements, through its container's protocol.
 *
 * @throws WirebenchError `mock-container-missing`, `mock-protocol-unsupported`, and what the facet's
 * `open` throws
 */
export async function openMockContract(
  project: Project,
  mock: MockDef,
  root: string,
  fs: FsLike,
  registry: ProtocolRegistry,
): Promise<MockContract> {
  for (const module of registry.modules) {
    const container = module.storage.containers(project).find((item) => item.id === mock.source.containerId);
    if (container === undefined) continue;
    if (module.mock === undefined) {
      throw mockError(
        'mock-protocol-unsupported',
        `"${container.name}" is a ${module.kind} container; mocks serve SOAP and REST only`,
        { kind: module.kind },
      );
    }
    return module.mock.open({ project, root, fs, mock });
  }
  throw mockError(
    'mock-container-missing',
    `The interface or API mock "${mock.name}" implements is not in the project`,
    { containerId: mock.source.containerId },
  );
}

function hostnameOf(hostHeader: string | undefined): string | undefined {
  if (hostHeader === undefined) return undefined;
  const value = hostHeader.trim().toLowerCase();
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    return end === -1 ? undefined : value.slice(0, end + 1);
  }
  const colon = value.indexOf(':');
  return colon === -1 ? value : value.slice(0, colon);
}

function isLoopback(host: string): boolean {
  return LOOPBACK_HOSTS.has(host) || /^127\.\d+\.\d+\.\d+$/.test(host);
}

function urlHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

function headerPairs(req: IncomingMessage): HeaderPair[] {
  const pairs: HeaderPair[] = [];
  for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
    pairs.push([req.rawHeaders[i] ?? '', req.rawHeaders[i + 1] ?? '']);
  }
  return pairs;
}

function queryOf(search: URLSearchParams): Record<string, string[]> {
  const query = Object.create(null) as Record<string, string[]>;
  for (const [name, value] of search) {
    (query[name] ??= []).push(value);
  }
  return query;
}

/** Path and query with sensitive query values masked; `redactUrl` wants an absolute URL. */
function maskedUrl(pathAndQuery: string): string {
  const origin = 'http://mock.invalid';
  const masked = redactUrl(`${origin}${pathAndQuery.startsWith('/') ? '' : '/'}${pathAndQuery}`);
  return masked.startsWith(origin) ? masked.slice(origin.length) : masked;
}

function cut(text: string): { body: string; truncated: boolean } {
  const bytes = Buffer.from(text, 'utf8');
  return bytes.byteLength <= MOCK_EVENT_BODY_BYTES
    ? { body: text, truncated: false }
    : { body: bytes.subarray(0, MOCK_EVENT_BODY_BYTES).toString('utf8'), truncated: true };
}

/** The reply's headers: the stub's own, then the protocol's defaults for names the stub did not set. */
function replyHeaders(response: MockResponse, contract: MockContract): HeaderPair[] {
  const own = response.headers.map((header): HeaderPair => [header.name, header.value]);
  const named = new Set(own.map(([name]) => name.toLowerCase()));
  return [...own, ...contract.defaults(response).filter(([name]) => !named.has(name.toLowerCase()))];
}

function write(res: ServerResponse, reply: MockReply): void {
  const grouped = new Map<string, { name: string; values: string[] }>();
  for (const [name, value] of reply.headers) {
    const key = name.toLowerCase();
    const entry = grouped.get(key) ?? { name, values: [] };
    entry.values.push(value);
    grouped.set(key, entry);
  }
  for (const { name, values } of grouped.values()) {
    res.setHeader(name, values.length === 1 ? (values[0] as string) : values);
  }
  const body = Buffer.from(reply.body, 'utf8');
  res.setHeader('Content-Length', String(body.byteLength));
  res.writeHead(reply.status);
  res.end(body);
}

function plain(status: number, text: string): MockReply {
  return { status, headers: [['Content-Type', 'text/plain; charset=utf-8']], body: `${text}\n` };
}

/** Reads the body, or `undefined` once it passes the cap. */
function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (chunk: Buffer) => {
      if (over) return;
      size += chunk.byteLength;
      if (size > MOCK_REQUEST_BODY_BYTES) {
        over = true;
        chunks.length = 0;
        resolve(undefined);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!over) resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

/**
 * Starts serving the mock `input.mockId` of `input.project`.
 *
 * @throws WirebenchError `mock-not-found`, `mock-container-missing`, `mock-protocol-unsupported`,
 * `mock-definition-missing`, `mock-binding-unknown`, `mock-port-in-use`, `mock-listen-failed`
 */
export async function startMock(input: StartMockInput): Promise<RunningMock> {
  const mock = findMock(input.project, input.mockId);
  const registry = input.registry ?? defaultRegistry();
  const contract = await openMockContract(input.project, mock, input.root, input.fs ?? nodeFs, registry);
  const known = new Set(contract.operations.map((operation) => operation.key));
  const warnings: MockWarning[] = mock.operations
    .filter((operation) => !known.has(operation.operation))
    .map((operation) => ({
      code: 'mock-operation-unknown' as const,
      message: `"${operation.name}" names ${operation.operation}, which the contract does not have; no request can reach it`,
      operationId: operation.id,
    }));
  const byKey = new Map<string, MockOperation>();
  for (const operation of mock.operations) {
    if (known.has(operation.operation) && !byKey.has(operation.operation)) byKey.set(operation.operation, operation);
  }

  const host = input.host ?? '127.0.0.1';
  const loopbackOnly = isLoopback(host);
  const state = new MockState();
  let ownSandbox: ScriptSandbox | undefined;
  const sandbox = (): ScriptSandbox => input.sandbox ?? (ownSandbox ??= createScriptSandbox());
  const script = createDispatchScriptRunner(sandbox, input.scriptTimeoutMs);
  const sockets = new Set<Socket>();
  const timers = new Set<NodeJS.Timeout>();
  let seq = 0;
  let stopped = false;

  const prefix = mock.path === '/' ? '' : mock.path.replace(/\/+$/, '');
  const underPath = (path: string): boolean => prefix === '' || path === prefix || path.startsWith(`${prefix}/`);

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const started = Date.now();
    const at = new Date(started).toISOString();
    const method = (req.method ?? 'GET').toUpperCase();
    const rawUrl = req.url ?? '/';
    const parsed = new URL(rawUrl, 'http://mock.invalid');
    const headers = headerPairs(req);
    const event = (
      reply: MockReply,
      requestBody: string,
      extra: Partial<Omit<MockExchangeEvent, 'request' | 'response'>>,
    ): MockExchangeEvent => ({
      seq: ++seq,
      at,
      method,
      url: maskedUrl(`${parsed.pathname}${parsed.search}`),
      status: reply.status,
      durationMs: Date.now() - started,
      problems: [],
      ...extra,
      request: { headers: redactHeaderPairs(headers), ...cut(requestBody) },
      response: { headers: redactHeaderPairs(reply.headers), ...cut(reply.body) },
    });
    const finish = (reply: MockReply, requestBody: string, extra: Parameters<typeof event>[2] = {}): void => {
      write(res, reply);
      input.onExchange?.(event(reply, requestBody, extra));
    };

    const hostname = hostnameOf(req.headers.host);
    if (loopbackOnly && (hostname === undefined || !isLoopback(hostname))) {
      req.resume();
      finish(plain(421, 'This mock answers only requests addressed to localhost'), '', {
        error: { code: 'mock-host-refused', message: `Host ${String(req.headers.host)} is not a loopback name` },
      });
      return;
    }
    const body = await readBody(req);
    if (body === undefined) {
      res.setHeader('Connection', 'close');
      finish(plain(413, `The request body is larger than ${MOCK_REQUEST_BODY_BYTES} bytes`), '', {
        error: { code: 'mock-request-too-large', message: 'The request body is over the limit' },
      });
      return;
    }
    const request: MockRequest = {
      method,
      path: parsed.pathname,
      query: queryOf(parsed.searchParams),
      rawQuery: parsed.search.startsWith('?') ? parsed.search.slice(1) : parsed.search,
      headers,
      body,
      bodyText: body.toString('utf8'),
    };
    const mockUrl = `http://${req.headers.host ?? `${urlHost(host)}:${String(port)}`}${mock.path}`;

    if (!underPath(request.path)) {
      finish(
        contract.fail('mock-operation-not-found', `Nothing is served at ${request.path}; the mock is at ${mock.path}`),
        request.bodyText,
        {
          error: { code: 'mock-operation-not-found', message: `Outside ${mock.path}` },
        },
      );
      return;
    }
    const definition = contract.definition(request, mockUrl);
    if (definition !== undefined) {
      finish(definition, request.bodyText);
      return;
    }
    const route = await contract.route(request, mock.validation, mockUrl);
    if (route.kind === 'refused') {
      finish(route.reply, request.bodyText, {
        ...(route.operation !== undefined ? { operation: route.operation } : {}),
        problems: route.problems,
        error: {
          code: route.problems[0]?.code ?? 'mock-request-invalid',
          message: route.problems[0]?.message ?? 'Refused',
        },
      });
      return;
    }
    const operation = byKey.get(route.operation);
    if (operation === undefined) {
      const message = `The mock has no stubs for ${route.operation}`;
      finish(contract.fail('mock-no-stub', message), request.bodyText, {
        operation: route.operation,
        problems: route.problems,
        error: { code: 'mock-no-stub', message },
      });
      return;
    }
    const picked = await dispatch(operation, route.operation, request, route.view, state, { script });
    const problems = [...route.problems, ...picked.problems];
    if (!picked.ok) {
      finish(contract.fail(picked.code, picked.message), request.bodyText, {
        operation: route.operation,
        problems,
        error: { code: picked.code, message: picked.message },
        ...(picked.log !== undefined ? { log: picked.log } : {}),
      });
      return;
    }
    const response = picked.response;
    const reply: MockReply = {
      status: response.status,
      headers: replyHeaders(response, contract),
      body: response.bodyText,
    };
    const send = (): void =>
      finish(reply, request.bodyText, {
        operation: route.operation,
        responseId: response.id,
        responseName: response.name,
        problems,
        ...(picked.log !== undefined ? { log: picked.log } : {}),
      });
    if (response.delayMs > 0) {
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (!stopped) send();
      }, response.delayMs);
      timers.add(timer);
    } else {
      send();
    }
  };

  const server: Server = createServer(
    { requireHostHeader: false, headersTimeout: MOCK_REQUEST_TIMEOUT_MS, requestTimeout: MOCK_REQUEST_TIMEOUT_MS },
    (req, res) => {
      handle(req, res).catch((error: unknown) => {
        if (!res.headersSent) {
          write(res, plain(500, 'The mock failed to answer'));
        }
        input.onExchange?.({
          seq: ++seq,
          at: new Date().toISOString(),
          method: req.method ?? 'GET',
          url: maskedUrl(req.url ?? '/'),
          status: 500,
          durationMs: 0,
          problems: [],
          error: { code: 'mock-failed', message: error instanceof Error ? error.message : String(error) },
          request: { headers: [], body: '', truncated: false },
          response: { headers: [], body: '', truncated: false },
        });
      });
    },
  );
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  const port = await new Promise<number>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      reject(
        error.code === 'EADDRINUSE'
          ? mockError('mock-port-in-use', `Port ${String(input.port ?? mock.port)} is already in use`, {
              port: input.port ?? mock.port,
            })
          : mockError('mock-listen-failed', `The mock could not listen on ${host}: ${error.message}`, {
              host,
              reason: error.code ?? error.message,
            }),
      );
    };
    server.once('error', onError);
    server.listen(input.port ?? mock.port, host, () => {
      server.off('error', onError);
      const address = server.address();
      resolve(typeof address === 'object' && address !== null ? address.port : 0);
    });
  });

  return {
    url: `http://${urlHost(host)}:${String(port)}${mock.path}`,
    host,
    port,
    warnings,
    reset: () => state.reset(),
    stop: async () => {
      if (stopped) return;
      stopped = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      for (const socket of sockets) socket.destroy();
      await closed;
      if (ownSandbox !== undefined) await ownSandbox.dispose();
    },
  };
}
