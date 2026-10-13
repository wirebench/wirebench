import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { McpError } from '../../../src/errors.js';
import { buildMcpExchange, mcpSubject, type McpExchangeTransport } from '../../../src/mcp/exchange.js';
import type { McpHttpCall } from '../../../src/mcp/http-calls.js';
import type { McpCatalogue, McpOperation } from '../../../src/mcp/model.js';
import { mcpOperationCall } from '../../../src/mcp/operation.js';
import { runMcpSession, type McpSessionOutcome } from '../../../src/mcp/session.js';
import type { McpWireHandlers, McpWireTransport } from '../../../src/mcp/transport.js';

const noWire: McpWireTransport = {
  start: () => Promise.resolve(),
  send: () => Promise.resolve(),
  close: () => Promise.resolve(),
};

/** A wire transport that recorded `recorded` as its HTTP calls. */
const httpWire = (recorded: readonly McpHttpCall[]): McpWireTransport =>
  Object.assign({ ...noWire }, { calls: recorded });

const outcome = (extra: Partial<McpSessionOutcome> = {}): McpSessionOutcome => ({
  startedAt: '2026-10-13T10:00:00.000Z',
  durationMs: 12.5,
  messages: [],
  droppedMessages: 0,
  initialize: {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: { tools: {} },
    serverInfo: { name: 's', version: '1' },
  },
  protocolVersion: LATEST_PROTOCOL_VERSION,
  ...extra,
});

const stdio: McpExchangeTransport = { type: 'stdio', command: 'node', args: ['server.js'], cwd: '/p', env: { A: 'b' } };
const http: McpExchangeTransport = { type: 'http', url: 'https://mcp.example/mcp' };
const sse: McpExchangeTransport = { type: 'sse', url: 'https://mcp.example/sse' };

const httpCall = (
  method: string,
  status: number,
  message?: McpHttpCall['message'],
  headers: Record<string, string> = {},
): McpHttpCall => ({
  method,
  url: 'https://mcp.example/mcp',
  startedAt: '2026-10-13T10:00:00.000Z',
  status,
  requestHeaders: {},
  responseHeaders: headers,
  ...(message !== undefined ? { message } : {}),
});

const calls: McpHttpCall[] = [
  httpCall('POST', 200, { id: 1, method: 'initialize' }, { 'mcp-session-id': 'abc' }),
  httpCall('POST', 202, { method: 'notifications/initialized' }),
  httpCall('POST', 200, { id: 2, method: 'tools/list' }, { 'content-type': 'application/json', 'x-trace': 't1' }),
  httpCall('DELETE', 204),
];

const list: McpOperation = { method: 'tools/list' };

describe('buildMcpExchange', () => {
  it('records a stdio session with its stderr and exit code, and no HTTP calls', () => {
    const wire = { ...noWire, stderr: 'log line\n', stderrTruncated: false, exitCode: 0, exitSignal: null, calls: [] };
    const exchange = buildMcpExchange({
      transport: stdio,
      wire,
      operation: list,
      outcome: outcome({ response: { result: { tools: [] } } }),
    });
    expect(exchange).toMatchObject({
      kind: 'mcp',
      transport: stdio,
      method: 'tools/list',
      durationMs: 12.5,
      stderr: 'log line\n',
      stderrTruncated: false,
      exitCode: 0,
      exitSignal: null,
      result: { tools: [] },
      droppedMessages: 0,
      warnings: [],
    });
    expect(exchange.httpCalls).toBeUndefined();
    expect(exchange.error).toBeUndefined();
    expect(exchange.initialize?.['serverInfo']).toEqual({ name: 's', version: '1' });
  });

  it('records an HTTP session with its calls, and no stderr', () => {
    const exchange = buildMcpExchange({
      transport: http,
      wire: httpWire(calls),
      operation: list,
      outcome: outcome(),
    });
    expect(exchange.httpCalls).toEqual(calls);
    expect(exchange.stderr).toBeUndefined();
    expect('result' in exchange).toBe(false);
  });

  it('records a JSON-RPC error, the dropped count and a failure', () => {
    const exchange = buildMcpExchange({
      transport: stdio,
      wire: noWire,
      operation: list,
      outcome: outcome({
        droppedMessages: 4,
        response: { error: { code: -32601, message: 'Method not found' } },
        failure: new McpError('mcp-timeout', 'late'),
      }),
    });
    expect(exchange).toMatchObject({
      error: { code: -32601, message: 'Method not found' },
      droppedMessages: 4,
      failure: { code: 'mcp-timeout', message: 'late' },
    });
    expect('result' in exchange).toBe(false);
  });

  it('carries the catalogue checks as warnings', () => {
    const catalogue: McpCatalogue = {
      tools: [{ name: 'add', inputSchema: { type: 'object', required: ['a'] }, outputSchema: { type: 'object' } }],
    };
    const exchange = buildMcpExchange({
      transport: stdio,
      wire: noWire,
      operation: { method: 'tools/call', tool: 'add', arguments: '{}' },
      outcome: outcome({ response: { result: { content: [] } } }),
      catalogue,
    });
    expect(exchange.warnings).toHaveLength(2);
    expect(exchange.warnings[0]).toContain('inputSchema of "add"');
    expect(exchange.warnings[1]).toContain('no structuredContent');
  });

  it('keeps a result that does not match the protocol, with a warning on its message', async () => {
    let handlers: McpWireHandlers | undefined;
    const push = (value: unknown) => queueMicrotask(() => handlers?.onMessage(JSON.stringify(value)));
    const wire: McpWireTransport = {
      start(given) {
        handlers = given;
        return Promise.resolve();
      },
      send(text) {
        const message = JSON.parse(text) as Record<string, unknown>;
        if (message['method'] === 'initialize') {
          push({ jsonrpc: '2.0', id: message['id'], result: outcome().initialize });
        } else if (message['method'] === 'tools/list') {
          push({ jsonrpc: '2.0', id: message['id'], result: { tools: 'none' } });
        }
        return Promise.resolve();
      },
      close: () => Promise.resolve(),
    };
    const session = await runMcpSession({
      transport: wire,
      operation: mcpOperationCall(list),
      clientVersion: '1',
      timeoutMs: 5_000,
    });
    const exchange = buildMcpExchange({ transport: stdio, wire, operation: list, outcome: session });
    expect(exchange.result).toEqual({ tools: 'none' });
    const answer = exchange.messages.find((m) => m.direction === 'received' && m.method === 'tools/list');
    expect(answer?.warnings.some((w) => w.startsWith('The tools/list result does not match the protocol'))).toBe(true);
  });
});

describe('mcpSubject', () => {
  it('gives the result as JSON, with status 0 and no headers for stdio', () => {
    const exchange = buildMcpExchange({
      transport: stdio,
      wire: noWire,
      operation: list,
      outcome: outcome({ response: { result: { tools: [] } } }),
    });
    expect(mcpSubject(exchange)).toEqual({
      protocol: 'mcp',
      status: 0,
      durationMs: 12.5,
      bodyText: '{"tools":[]}',
      bodyKind: 'json',
      headers: [],
    });
  });

  it('gives an error as {"error": …}', () => {
    const exchange = buildMcpExchange({
      transport: stdio,
      wire: noWire,
      operation: list,
      outcome: outcome({ response: { error: { code: -32602, message: 'Invalid params', data: { x: 1 } } } }),
    });
    expect(JSON.parse(mcpSubject(exchange).bodyText)).toEqual({
      error: { code: -32602, message: 'Invalid params', data: { x: 1 } },
    });
  });

  it("gives the operation POST's status and headers for Streamable HTTP", () => {
    const exchange = buildMcpExchange({
      transport: http,
      wire: httpWire(calls),
      operation: list,
      outcome: outcome({ response: { result: { tools: [] } } }),
    });
    const subject = mcpSubject(exchange);
    expect(subject.status).toBe(200);
    expect(subject.headers).toEqual([
      ['content-type', 'application/json'],
      ['x-trace', 't1'],
    ]);
  });

  it("gives the operation POST's headers but status 0 for the legacy transport", () => {
    const sseCalls = [httpCall('GET', 200), httpCall('POST', 202, { id: 2, method: 'tools/list' }, { 'x-a': '1' })];
    const exchange = buildMcpExchange({
      transport: sse,
      wire: httpWire(sseCalls),
      operation: list,
      outcome: outcome({ response: { result: {} } }),
    });
    const subject = mcpSubject(exchange);
    expect(subject.status).toBe(0);
    expect(subject.headers).toEqual([['x-a', '1']]);
  });

  it('gives an empty body and status 0 when the session failed before the operation was answered', () => {
    const exchange = buildMcpExchange({
      transport: http,
      wire: httpWire(calls.slice(0, 2)),
      operation: list,
      outcome: outcome(),
    });
    expect(mcpSubject(exchange)).toMatchObject({ status: 0, bodyText: '', bodyKind: 'other', headers: [] });
  });
});
