/**
 * Serving a mock over HTTP (spec §Running a mock): `startMock` opens the mock's contract through its
 * protocol's facet, listens with `node:http`, and answers every request by serving a definition,
 * refusing it, or dispatching it to a stub. It needs neither Electron nor the desktop: the CLI's
 * `wirebench mock` (#61) and the desktop's mock runner both call it.
 */

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { WirebenchError } from '../errors.js';
import { defaultRegistry } from '../protocols.js';
import { nodeFs } from '../project/fs.js';
import type { FsLike } from '../project/fs.js';
import type { Project } from '../project/model.js';
import type { ProtocolRegistry } from '../protocol/registry.js';
import { redactHeaderPairs } from '../redact/index.js';
import type { HeaderPair } from '../script/model.js';
import { createScriptSandbox } from '../script/sandbox/host.js';
import type { ScriptSandbox } from '../script/sandbox/host.js';
import type { MockContract, MockProblem, MockReply, MockRequest } from './contract.js';
import { MockState, dispatch } from './dispatch.js';
import {
  MOCK_REQUEST_BODY_BYTES,
  MOCK_REQUEST_TIMEOUT_MS,
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
import { mockPathPrefix } from './model.js';
import type { MockDef, MockOperation, MockResponse } from './model.js';
import { renderResponse } from './render.js';
import { createDispatchScriptRunner } from './script.js';

export { MOCK_EVENT_BODY_BYTES, MOCK_REQUEST_BODY_BYTES, MOCK_REQUEST_TIMEOUT_MS } from './http.js';

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

/** @throws WirebenchError `mock-not-found` */
export function findMock(project: Project, mockId: string): MockDef {
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

/** The reply's headers: the stub's own, then the protocol's defaults for names the stub did not set. */
export function replyHeaders(response: MockResponse, contract: MockContract): HeaderPair[] {
  const own = response.headers.map((header): HeaderPair => [header.name, header.value]);
  const named = new Set(own.map(([name]) => name.toLowerCase()));
  return [...own, ...contract.defaults(response).filter(([name]) => !named.has(name.toLowerCase()))];
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
  const timers = new Set<NodeJS.Timeout>();
  let seq = 0;
  let stopped = false;

  const prefix = mockPathPrefix(mock.path);
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
    const chosen = picked.response;
    const rendered = await renderResponse(chosen, request, route.view);
    problems.push(...rendered.problems);
    if (!rendered.ok) {
      finish(contract.fail(rendered.code, rendered.message), request.bodyText, {
        operation: route.operation,
        responseId: chosen.id,
        responseName: chosen.name,
        problems,
        error: { code: rendered.code, message: rendered.message },
        ...(picked.log !== undefined ? { log: picked.log } : {}),
      });
      return;
    }
    const response: MockResponse = { ...chosen, headers: rendered.headers, bodyText: rendered.bodyText };
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
  const listening = await listen(server, host, input.port ?? mock.port, 'mock');
  const port = listening.port;

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
      await listening.close();
      if (ownSandbox !== undefined) await ownSandbox.dispose();
    },
  };
}
