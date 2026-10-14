/**
 * MCP's scripting converters (#79): the pre-request snapshot of each operation (the URL only for an
 * HTTP transport, never a stdio command line), a script's changes applied back to the send, text it
 * left alone kept exactly, and the post-response snapshot.
 */
import { describe, expect, it } from 'vitest';
import type { McpExchange } from '../../../src/mcp/exchange.js';
import type { McpResolvedInput } from '../../../src/mcp/run.js';
import { applyMcpSnapshot, mcpRequestSnapshot, mcpResponseSnapshot } from '../../../src/mcp/scripting.js';

const input = (operation: McpResolvedInput['operation'], http = true): McpResolvedInput => ({
  transport: http
    ? { type: 'http', url: 'https://mcp.test/mcp', headers: [] }
    : { type: 'stdio', command: 'node', args: ['server.js', '--secret-flag'], cwd: '/work', env: [] },
  operation,
  timeoutMs: 1000,
  commandLine: http ? '' : 'node server.js --secret-flag',
});

describe('mcpRequestSnapshot', () => {
  it('holds the operation, and the URL of an HTTP server only', () => {
    const call = input({ method: 'tools/call', tool: 'echo', arguments: '{ "text": "hi" }' });
    expect(mcpRequestSnapshot(call)).toEqual({
      protocol: 'mcp',
      transport: 'http',
      url: 'https://mcp.test/mcp',
      method: 'tools/call',
      tool: 'echo',
      arguments: { text: 'hi' },
    });
    const local = mcpRequestSnapshot(input({ method: 'tools/list' }, false));
    expect(local).toEqual({ protocol: 'mcp', transport: 'stdio', url: '', method: 'tools/list' });
    expect(JSON.stringify(local)).not.toContain('secret-flag');
  });

  it('reads blank arguments as {}, keeps text that is not JSON as text, and a prompt as an object', () => {
    expect(mcpRequestSnapshot(input({ method: 'tools/call', tool: 't', arguments: '  ' }))).toMatchObject({
      arguments: {},
    });
    expect(mcpRequestSnapshot(input({ method: 'tools/call', tool: 't', arguments: '{oops' }))).toMatchObject({
      arguments: '{oops',
    });
    const prompt = input({
      method: 'prompts/get',
      prompt: 'greet',
      arguments: [
        { name: 'name', value: 'Ada', enabled: true },
        { name: 'off', value: 'x', enabled: false },
        { name: 'name', value: 'Grace', enabled: true },
      ],
    });
    expect(mcpRequestSnapshot(prompt)).toMatchObject({ prompt: 'greet', arguments: { name: 'Grace' } });
  });
});

describe('applyMcpSnapshot', () => {
  it('keeps the arguments text exactly when the script left them alone', () => {
    const was = input({ method: 'tools/call', tool: 'echo', arguments: '{ "text":   "hi" }' });
    const before = mcpRequestSnapshot(was);
    expect(applyMcpSnapshot(was, before, { ...before })).toEqual(was);
  });

  it('writes changed arguments, a changed tool, URI, prompt and URL back', () => {
    const call = input({ method: 'tools/call', tool: 'echo', arguments: '{}' });
    const before = mcpRequestSnapshot(call);
    const after = applyMcpSnapshot(call, before, {
      ...before,
      url: 'https://mcp.test/v2',
      tool: 'find',
      arguments: { q: 1 },
    } as typeof before);
    expect(after.operation).toEqual({ method: 'tools/call', tool: 'find', arguments: '{\n  "q": 1\n}' });
    expect(after.transport).toMatchObject({ url: 'https://mcp.test/v2' });

    const read = input({ method: 'resources/read', uri: 'res://a' });
    const readBefore = mcpRequestSnapshot(read);
    expect(
      applyMcpSnapshot(read, readBefore, { ...readBefore, uri: 'res://b' } as typeof readBefore).operation,
    ).toEqual({ method: 'resources/read', uri: 'res://b' });

    const prompt = input({ method: 'prompts/get', prompt: 'p', arguments: [{ name: 'a', value: '1', enabled: true }] });
    const promptBefore = mcpRequestSnapshot(prompt);
    expect(
      applyMcpSnapshot(prompt, promptBefore, { ...promptBefore, arguments: { b: '2' } } as typeof promptBefore)
        .operation,
    ).toEqual({ method: 'prompts/get', prompt: 'p', arguments: [{ name: 'b', value: '2', enabled: true }] });
  });

  it('never touches a stdio transport', () => {
    const local = input({ method: 'tools/list' }, false);
    const before = mcpRequestSnapshot(local);
    expect(applyMcpSnapshot(local, before, { ...before, url: 'x' }).transport).toBe(local.transport);
  });
});

describe('mcpResponseSnapshot', () => {
  const exchange: McpExchange = {
    kind: 'mcp',
    transport: { type: 'http', url: 'https://mcp.test/mcp' },
    method: 'tools/call',
    startedAt: '2026-10-13T10:00:00.000Z',
    durationMs: 21,
    initialize: { serverInfo: { name: 'fixture', version: '1.2.3' } },
    messages: [],
    droppedMessages: 0,
    result: { content: [], isError: true },
    warnings: [],
  };

  it('holds the result, isError, serverInfo, the message count and the duration', () => {
    expect(mcpResponseSnapshot({ ...exchange, droppedMessages: 3 })).toEqual({
      protocol: 'mcp',
      method: 'tools/call',
      result: { content: [], isError: true },
      isError: true,
      serverInfo: { name: 'fixture', version: '1.2.3' },
      messageCount: 3,
      durationMs: 21,
    });
  });

  it('holds the error of a JSON-RPC error answer', () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to omit it
    const { result: _result, ...unanswered } = exchange;
    expect(mcpResponseSnapshot({ ...unanswered, error: { code: -32602, message: 'Invalid params' } })).toMatchObject({
      error: { code: -32602, message: 'Invalid params' },
      isError: false,
    });
  });
});
