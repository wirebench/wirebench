import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { McpError } from '../../../src/errors.js';
import { inspectMessage, readMessages } from '../../../src/mcp/jsonrpc.js';
import { MCP_MAX_MESSAGE_BYTES, MCP_MAX_MESSAGES } from '../../../src/mcp/limits.js';
import { runMcpSession, type McpSessionOptions } from '../../../src/mcp/session.js';
import type { McpWireHandlers, McpWireTransport } from '../../../src/mcp/transport.js';

type Reply = (message: Record<string, unknown>, push: (value: unknown) => void) => void;

/** A transport whose server is `reply`, called with each message the session sends. */
function fakeTransport(reply: Reply): McpWireTransport & { sent: Record<string, unknown>[]; closes: unknown[] } {
  let handlers: McpWireHandlers | undefined;
  const sent: Record<string, unknown>[] = [];
  const closes: unknown[] = [];
  const push = (value: unknown): void => {
    queueMicrotask(() => handlers?.onMessage(typeof value === 'string' ? value : JSON.stringify(value)));
  };
  return {
    sent,
    closes,
    start(given) {
      handlers = given;
      return Promise.resolve();
    },
    send(text) {
      const message = JSON.parse(text) as Record<string, unknown>;
      sent.push(message);
      reply(message, push);
      return Promise.resolve();
    },
    close(options) {
      closes.push(options ?? {});
      return Promise.resolve();
    },
  };
}

const initResult = (
  capabilities: Record<string, unknown> = { tools: {} },
  protocolVersion = LATEST_PROTOCOL_VERSION,
) => ({
  protocolVersion,
  capabilities,
  serverInfo: { name: 'fake', version: '1' },
});

/** A server that answers initialize and then gives `answer` for the operation. */
const server =
  (answer: (message: Record<string, unknown>, push: (value: unknown) => void) => void, init = initResult()): Reply =>
  (message, push) => {
    if (message['method'] === 'initialize') push({ jsonrpc: '2.0', id: message['id'], result: init });
    else if (message['id'] !== undefined && typeof message['method'] === 'string') answer(message, push);
  };

const run = (transport: McpWireTransport, extra: Partial<McpSessionOptions> = {}) =>
  runMcpSession({
    transport,
    operation: { method: 'tools/list', capability: 'tools' },
    clientVersion: '9.9.9',
    ...extra,
  });

describe('jsonrpc reading', () => {
  it('classifies by shape and keeps what the schema says as warnings', () => {
    expect(inspectMessage({ jsonrpc: '2.0', id: 1, method: 'a' }).kind).toBe('request');
    expect(inspectMessage({ jsonrpc: '2.0', method: 'a' }).kind).toBe('notification');
    expect(inspectMessage({ jsonrpc: '2.0', id: 1, result: {} }).kind).toBe('result');
    expect(inspectMessage({ jsonrpc: '2.0', id: 1, error: { code: 1, message: 'x' } }).kind).toBe('error');
    const odd = inspectMessage({ jsonrpc: '1.0', id: 1, result: {} });
    expect(odd.kind).toBe('result');
    expect(odd.warnings.join('\n')).toMatch(/not a valid JSON-RPC message/);
    expect(readMessages('nope')[0]).toMatchObject({ kind: 'invalid', warnings: [expect.stringMatching(/not JSON/)] });
    expect(
      readMessages('[{"jsonrpc":"2.0","method":"a"},{"jsonrpc":"2.0","method":"b"}]').map((m) => m.method),
    ).toEqual(['a', 'b']);
  });
});

describe('runMcpSession', () => {
  it('runs initialize, notifications/initialized, the operation, then closes', async () => {
    const transport = fakeTransport(server((m, push) => push({ jsonrpc: '2.0', id: m['id'], result: { tools: [] } })));
    const outcome = await run(transport);

    expect(outcome.failure).toBeUndefined();
    expect(outcome.response).toEqual({ result: { tools: [] } });
    expect(outcome.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
    expect(transport.sent.map((m) => m['method'])).toEqual(['initialize', 'notifications/initialized', 'tools/list']);
    expect(transport.sent[0]!['params']).toEqual({
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'wirebench', version: '9.9.9' },
    });
    expect(outcome.messages.map((m) => [m.direction, m.kind, m.method])).toEqual([
      ['sent', 'request', 'initialize'],
      ['received', 'result', 'initialize'],
      ['sent', 'notification', 'notifications/initialized'],
      ['sent', 'request', 'tools/list'],
      ['received', 'result', 'tools/list'],
    ]);
    expect(outcome.messages[0]!.size).toBe(Buffer.byteLength(outcome.messages[0]!.text));
    expect(transport.closes).toEqual([{}]);
  });

  it('asks for the configured protocol version', async () => {
    const transport = fakeTransport(server((m, push) => push({ jsonrpc: '2.0', id: m['id'], result: { tools: [] } })));
    await run(transport, { protocolVersion: '2025-03-26' });
    expect((transport.sent[0]!['params'] as { protocolVersion: string }).protocolVersion).toBe('2025-03-26');
  });

  it('keeps a JSON-RPC error answer as the response, not a failure', async () => {
    const transport = fakeTransport(
      server((m, push) => push({ jsonrpc: '2.0', id: m['id'], error: { code: -32602, message: 'Invalid params' } })),
    );
    const outcome = await run(transport);
    expect(outcome.failure).toBeUndefined();
    expect(outcome.response).toEqual({ error: { code: -32602, message: 'Invalid params' } });
  });

  it('puts validateResult warnings on the message that carried the result', async () => {
    const transport = fakeTransport(server((m, push) => push({ jsonrpc: '2.0', id: m['id'], result: { nope: 1 } })));
    const outcome = await run(transport, {
      operation: { method: 'tools/list', validateResult: () => ['tools is missing'] },
    });
    expect(outcome.messages.at(-1)!.warnings).toEqual(['tools is missing']);
  });

  it('warns on an initialize result that does not match the protocol', async () => {
    const transport = fakeTransport(
      server((m, push) => push({ jsonrpc: '2.0', id: m['id'], result: { tools: [] } }), {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: { tools: {} },
      } as never),
    );
    const outcome = await run(transport);
    expect(outcome.failure).toBeUndefined();
    expect(outcome.messages[1]!.warnings.join('\n')).toMatch(
      /initialize result does not match the protocol at serverInfo/,
    );
  });

  it('fails with mcp-capability-missing before sending the operation', async () => {
    const transport = fakeTransport(server(() => undefined, initResult({ prompts: {} })));
    const outcome = await run(transport);
    expect(outcome.failure).toBeInstanceOf(McpError);
    expect(outcome.failure?.code).toBe('mcp-capability-missing');
    expect(transport.sent.map((m) => m['method'])).toEqual(['initialize']);
    expect(transport.closes).toEqual([{}]);
  });

  it('fails with mcp-protocol-unsupported for a version the client does not know', async () => {
    const transport = fakeTransport(server(() => undefined, initResult({ tools: {} }, '1999-01-01')));
    const outcome = await run(transport);
    expect(outcome.failure?.code).toBe('mcp-protocol-unsupported');
    expect(outcome.failure?.details).toMatchObject({ offered: '1999-01-01' });
    expect(outcome.protocolVersion).toBe('1999-01-01');
  });

  it('fails with mcp-initialize-failed when the server refuses initialize', async () => {
    const transport = fakeTransport((m, push) =>
      push({ jsonrpc: '2.0', id: m['id'], error: { code: -32600, message: 'go away' } }),
    );
    const outcome = await run(transport);
    expect(outcome.failure?.code).toBe('mcp-initialize-failed');
  });

  it('refuses a server request with -32601 and records both messages', async () => {
    const transport = fakeTransport((m, push) => {
      if (m['method'] === 'initialize') push({ jsonrpc: '2.0', id: m['id'], result: initResult() });
      else if (m['method'] === 'tools/list') {
        push({ jsonrpc: '2.0', id: 'srv-1', method: 'sampling/createMessage', params: {} });
        push({ jsonrpc: '2.0', id: m['id'], result: { tools: [] } });
      }
    });
    const outcome = await run(transport);
    expect(transport.sent.find((m) => m['id'] === 'srv-1')).toEqual({
      jsonrpc: '2.0',
      id: 'srv-1',
      error: { code: -32601, message: 'Method not found: sampling/createMessage' },
    });
    const refused = outcome.messages.filter((m) => m.id === 'srv-1');
    expect(refused.map((m) => [m.direction, m.kind, m.method])).toEqual([
      ['received', 'request', 'sampling/createMessage'],
      ['sent', 'error', 'sampling/createMessage'],
    ]);
  });

  it('warns on a response to no request, and on an invalid message, without dropping either', async () => {
    const transport = fakeTransport(
      server((m, push) => {
        push({ jsonrpc: '2.0', id: 999, result: {} });
        push('{"broken"');
        push({ jsonrpc: '2.0', id: m['id'], result: { tools: [] } });
      }),
    );
    const outcome = await run(transport);
    expect(outcome.failure).toBeUndefined();
    const received = outcome.messages.filter((m) => m.direction === 'received');
    expect(received[1]!.warnings).toContain('The response answers no request this session is waiting on');
    expect(received[2]).toMatchObject({ kind: 'invalid', text: '{"broken"' });
  });

  it('times out with mcp-timeout, cancels the waiting request and closes by force', async () => {
    const transport = fakeTransport(server(() => undefined));
    const outcome = await run(transport, { timeoutMs: 50 });
    expect(outcome.failure?.code).toBe('mcp-timeout');
    const cancel = transport.sent.at(-1)!;
    expect(cancel).toMatchObject({ method: 'notifications/cancelled', params: { requestId: 2 } });
    expect(outcome.messages.at(-1)).toMatchObject({ direction: 'sent', method: 'notifications/cancelled' });
    expect(transport.closes).toEqual([{ force: true }]);
  });

  it('does not cancel initialize when the deadline passes during it', async () => {
    const transport = fakeTransport(() => undefined);
    const outcome = await run(transport, { timeoutMs: 30 });
    expect(outcome.failure?.code).toBe('mcp-timeout');
    expect(transport.sent.map((m) => m['method'])).toEqual(['initialize']);
  });

  it('cancels with mcp-cancelled when the signal aborts', async () => {
    const controller = new AbortController();
    const transport = fakeTransport(server(() => controller.abort()));
    const outcome = await run(transport, { signal: controller.signal });
    expect(outcome.failure?.code).toBe('mcp-cancelled');
    expect(transport.sent.at(-1)).toMatchObject({ method: 'notifications/cancelled', params: { reason: 'Cancelled' } });
  });

  it('does not start at all when the signal is already aborted', async () => {
    const transport = fakeTransport(() => undefined);
    const outcome = await run(transport, { signal: AbortSignal.abort() });
    expect(outcome.failure?.code).toBe('mcp-cancelled');
    expect(transport.sent).toEqual([]);
  });

  it('fails with mcp-message-too-large for a received message over 4 MiB', async () => {
    const transport = fakeTransport(
      server((m, push) => push({ jsonrpc: '2.0', id: m['id'], result: { pad: 'x'.repeat(MCP_MAX_MESSAGE_BYTES) } })),
    );
    const outcome = await run(transport);
    expect(outcome.failure?.code).toBe('mcp-message-too-large');
    expect(outcome.messages.at(-1)).toMatchObject({ direction: 'received', text: '' });
  });

  it('refuses to send a message over 4 MiB', async () => {
    const transport = fakeTransport(server(() => undefined));
    const outcome = await run(transport, {
      operation: { method: 'tools/call', params: { name: 'x', arguments: { pad: 'x'.repeat(MCP_MAX_MESSAGE_BYTES) } } },
    });
    expect(outcome.failure?.code).toBe('mcp-message-too-large');
    expect(transport.sent.map((m) => m['method'])).toEqual(['initialize', 'notifications/initialized']);
  });

  it('keeps at most 1,000 messages and counts the rest', async () => {
    const transport = fakeTransport(
      server((m, push) => {
        for (let i = 0; i < MCP_MAX_MESSAGES + 5; i += 1)
          push({ jsonrpc: '2.0', method: 'notifications/message', params: { i } });
        push({ jsonrpc: '2.0', id: m['id'], result: { tools: [] } });
      }),
    );
    const outcome = await run(transport);
    expect(outcome.messages).toHaveLength(MCP_MAX_MESSAGES);
    expect(outcome.droppedMessages).toBe(10);
    expect(outcome.response).toEqual({ result: { tools: [] } });
  });

  it('fails with the transport error when the connection ends early', async () => {
    let handlers: McpWireHandlers | undefined;
    const transport: McpWireTransport = {
      start: (given) => {
        handlers = given;
        return Promise.resolve();
      },
      send: () => {
        queueMicrotask(() => handlers?.onClose(new McpError('mcp-server-exited', 'gone')));
        return Promise.resolve();
      },
      close: () => Promise.resolve(),
    };
    const outcome = await run(transport);
    expect(outcome.failure?.code).toBe('mcp-server-exited');
  });
});
