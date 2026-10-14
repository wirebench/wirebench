/**
 * `buildMcpHistoryEntry` (#79): one MCP send as History records it. The pattern rules redact the
 * HTTP calls' credential headers and cookies and the URL's credential parameters; the host's mask
 * hides the secret values it knows of in every message, the stdio command line and env, the headers,
 * the result, the error and stderr. Messages are capped at both ends, as WebSocket frames are.
 */
import { describe, expect, it } from 'vitest';
import { createSecretMasker, REDACTED_MARKER } from '../../../src/index.js';
import type { McpExchange } from '../../../src/mcp/exchange.js';
import type { McpHttpCall } from '../../../src/mcp/http-calls.js';
import {
  buildMcpHistoryEntry,
  capMcpMessages,
  historyMcpOf,
  MCP_HISTORY_RESULT_BYTES,
  redactMcpExchange,
} from '../../../src/mcp/history-entry.js';
import type { McpMessage } from '../../../src/mcp/session.js';
import { WS_HISTORY_HEAD, WS_HISTORY_MAX_BYTES, WS_HISTORY_TAIL } from '../../../src/ws/transcript.js';

const SECRET = 'live-secret-9f3a7c';
const masks = { text: createSecretMasker([SECRET]) };

const message = (index: number, extra: Partial<McpMessage> = {}): McpMessage => ({
  direction: index % 2 === 0 ? 'sent' : 'received',
  at: '2026-10-13T10:00:00.000Z',
  size: 10,
  kind: 'notification',
  method: 'notifications/message',
  text: `{"n":${String(index)}}`,
  warnings: [],
  ...extra,
});

const operationMessages: McpMessage[] = [
  message(0, {
    kind: 'request',
    id: 2,
    method: 'tools/call',
    text: `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"echo","arguments":{"k":"${SECRET}"}}}`,
    size: 90,
  }),
  message(1, {
    kind: 'result',
    id: 2,
    method: 'tools/call',
    text: `{"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"${SECRET}"}]}}`,
    size: 80,
  }),
];

const call = (method: string, status: number, extra: Partial<McpHttpCall> = {}): McpHttpCall => ({
  method,
  url: `https://mcp.test/mcp?access_token=plain-token&x=${SECRET}`,
  startedAt: '2026-10-13T10:00:00.000Z',
  status,
  requestHeaders: { Authorization: 'Bearer plain-token', 'X-Trace': `t-${SECRET}`, Cookie: 'sid=1' },
  responseHeaders: { 'set-cookie': 'sid=2', 'x-echo': SECRET },
  ...extra,
});

function exchange(overrides: Partial<McpExchange> = {}): McpExchange {
  return {
    kind: 'mcp',
    transport: { type: 'http', url: `https://mcp.test/mcp?access_token=plain-token&x=${SECRET}` },
    method: 'tools/call',
    startedAt: '2026-10-13T10:00:00.000Z',
    durationMs: 42,
    initialize: { protocolVersion: '2025-06-18', serverInfo: { name: 'fixture', version: '2.0.0' } },
    protocolVersion: '2025-06-18',
    messages: operationMessages,
    droppedMessages: 0,
    httpCalls: [
      call('POST', 200, { message: { id: 1, method: 'initialize' } }),
      call('POST', 200, { message: { id: 2, method: 'tools/call' } }),
    ],
    result: { content: [{ type: 'text', text: SECRET }] },
    warnings: [],
    ...overrides,
  };
}

describe('buildMcpHistoryEntry', () => {
  it('carries the SOAP-shaped fields, the mcp block and the tags', () => {
    const entry = buildMcpHistoryEntry(
      'p1',
      {
        requestId: 'r1',
        requestName: 'Echo',
        serverName: 'Tools',
        folderPath: 'Calls',
        exchange: exchange(),
        tags: ['cli'],
      },
      masks,
    );
    expect(entry).toMatchObject({
      kind: 'mcp',
      projectId: 'p1',
      requestId: 'r1',
      requestName: 'Echo',
      interfaceName: 'Tools',
      operationName: 'Calls',
      soapVersion: 'none',
      method: 'tools/call',
      status: 200,
      durationMs: 42,
      ok: true,
      sizeBytes: 170,
      tags: ['cli'],
    });
    expect(entry.mcp).toMatchObject({
      method: 'tools/call',
      protocolVersion: '2025-06-18',
      serverInfo: { name: 'fixture', version: '2.0.0' },
      droppedMessages: 0,
    });
    expect(entry.mcp?.messages).toHaveLength(2);
    expect(entry.request.envelopeXml).toContain('"tools/call"');
    expect(entry.response?.envelopeXml).toContain('"result"');
    expect(entry.error).toBeUndefined();
  });

  it('masks every secret value and redacts credential headers, cookies and query parameters', () => {
    const entry = buildMcpHistoryEntry(
      'p1',
      { requestId: 'r1', requestName: 'Echo', serverName: 'Tools', folderPath: '', exchange: exchange() },
      masks,
    );
    const text = JSON.stringify(entry);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('plain-token');
    expect(text).not.toContain('sid=');
    expect(entry.request.headers).toContainEqual({ name: 'Authorization', value: REDACTED_MARKER });
    expect(entry.endpoint).toContain('access_token=');
  });

  it('masks the stdio command line, every env value and stderr; the endpoint is the command line', () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to omit it
    const { httpCalls: _calls, ...withoutCalls } = exchange();
    const entry = buildMcpHistoryEntry(
      'p1',
      {
        requestId: 'r1',
        requestName: 'Echo',
        serverName: 'Local',
        folderPath: '',
        exchange: {
          ...withoutCalls,
          transport: {
            type: 'stdio',
            command: 'node',
            args: ['server.js', '--token', SECRET],
            cwd: '/work',
            env: { API_KEY: SECRET, PLAIN: 'one' },
          },
          stderr: `boot with ${SECRET}\n`,
          stderrTruncated: false,
          exitCode: 0,
          exitSignal: null,
        },
      },
      masks,
    );
    expect(JSON.stringify(entry)).not.toContain(SECRET);
    expect(entry.status).toBeUndefined();
    expect(entry.endpoint).toMatch(/^node server\.js --token /);
    expect(entry.mcp?.transport).toMatchObject({ type: 'stdio', env: { PLAIN: 'one' } });
    expect(entry.mcp?.stderr).toContain('boot with');
    expect(entry.response).toMatchObject({ status: 0, rawHeaders: [] });
  });

  it('is not ok for a JSON-RPC error, a result with isError, or a session that failed', () => {
    const ok = (overrides: Partial<McpExchange>): boolean =>
      buildMcpHistoryEntry(
        'p1',
        { requestId: 'r', requestName: 'n', serverName: 's', folderPath: '', exchange: exchange(overrides) },
        masks,
      ).ok;
    // A spread of `undefined` would still leave the key, which reads as an answer.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to omit it
    const { result: _result, ...unanswered } = exchange();
    expect(ok({})).toBe(true);
    expect(ok({ result: { content: [], isError: true } })).toBe(false);
    const failed = buildMcpHistoryEntry(
      'p1',
      {
        requestId: 'r',
        requestName: 'n',
        serverName: 's',
        folderPath: '',
        exchange: { ...unanswered, failure: { code: 'mcp-server-exited', message: `exit ${SECRET}` } },
      },
      masks,
    );
    expect(failed.ok).toBe(false);
    expect(failed.response).toBeUndefined();
    expect(failed.error).toMatchObject({ code: 'mcp-server-exited' });
    expect(JSON.stringify(failed.error)).not.toContain(SECRET);
    const errored = buildMcpHistoryEntry(
      'p1',
      {
        requestId: 'r',
        requestName: 'n',
        serverName: 's',
        folderPath: '',
        exchange: { ...unanswered, error: { code: -32602, message: `bad ${SECRET}`, data: { v: SECRET } } },
      },
      masks,
    );
    expect(errored.ok).toBe(false);
    expect(errored.mcp?.error).toMatchObject({ code: -32602 });
    expect(JSON.stringify(errored)).not.toContain(SECRET);
  });
});

describe('redactMcpExchange', () => {
  it('keeps the shape and the sizes, masking only values', () => {
    const redacted = redactMcpExchange(exchange(), masks);
    expect(redacted.messages.map((m) => m.size)).toEqual([90, 80]);
    expect(redacted.httpCalls?.[1]?.responseHeaders['set-cookie']).toBe(REDACTED_MARKER);
    expect(JSON.stringify(redacted)).not.toContain(SECRET);
  });
});

describe('historyMcpOf', () => {
  it('caps a long session at both ends', () => {
    const messages = Array.from({ length: 1000 }, (_, i) => message(i));
    const mcp = historyMcpOf(exchange({ messages }));
    expect(mcp.messages).toHaveLength(WS_HISTORY_HEAD + WS_HISTORY_TAIL);
    expect(mcp.truncated).toBe(true);
    expect(mcp.omittedMessages).toBe(1000 - WS_HISTORY_HEAD - WS_HISTORY_TAIL);
    expect(mcp.messages.at(-1)?.text).toBe('{"n":999}');
  });

  it('sets neither truncated nor omittedMessages for a short session', () => {
    const mcp = historyMcpOf(exchange());
    expect(mcp.truncated).toBeUndefined();
    expect(mcp.omittedMessages).toBeUndefined();
  });

  it('strips the text of a message past the byte budget, and leaves out a result too large to keep', () => {
    const big = 'x'.repeat(MCP_HISTORY_RESULT_BYTES + 1);
    const messages = [message(0, { size: WS_HISTORY_MAX_BYTES + 1, text: big }), message(1)];
    const mcp = historyMcpOf(exchange({ messages, result: { content: [{ type: 'text', text: big }] } }));
    expect(mcp.messages[0]).toMatchObject({ text: '', payloadTruncated: true, size: WS_HISTORY_MAX_BYTES + 1 });
    expect(mcp.messages[1]?.text).toBe('{"n":1}');
    expect(mcp.truncated).toBe(true);
    expect(mcp.omittedMessages).toBeUndefined();
    expect(mcp.result).toBeUndefined();
    expect(mcp.resultOmitted).toBe(true);
  });

  it('capMcpMessages keeps a message with no text as it is', () => {
    const empty = message(0, { size: WS_HISTORY_MAX_BYTES + 1, text: '' });
    expect(capMcpMessages([empty]).messages[0]).toBe(empty);
  });
});
