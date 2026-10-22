import { describe, expect, it } from 'vitest';
import { McpError } from '#core/errors';
import type { McpOperation } from '#protocol-mcp/mcp/model';
import {
  MCP_METHOD_CAPABILITY,
  mcpOperationCall,
  mcpOperationParams,
  mcpResultWarnings,
  parseMcpArguments,
} from '#protocol-mcp/mcp/operation';

const row = (name: string, value: string, enabled = true) => ({ name, value, enabled });

describe('mcpOperationCall', () => {
  it.each([
    ['tools/list', 'tools'],
    ['resources/list', 'resources'],
    ['resources/templates/list', 'resources'],
    ['prompts/list', 'prompts'],
  ] as const)('sends %s with no params and needs %s', (method, capability) => {
    const call = mcpOperationCall({ method });
    expect(call.method).toBe(method);
    expect(call.params).toBeUndefined();
    expect(call.capability).toBe(capability);
  });

  it('sends a tools/call with the tool name and its parsed arguments', () => {
    const call = mcpOperationCall({ method: 'tools/call', tool: 'echo', arguments: '{"text":"hi","n":2}' });
    expect(call).toMatchObject({
      method: 'tools/call',
      capability: 'tools',
      params: { name: 'echo', arguments: { text: 'hi', n: 2 } },
    });
  });

  it('sends {} for a tools/call with blank arguments', () => {
    expect(mcpOperationParams({ method: 'tools/call', tool: 'now', arguments: '  \n' })).toEqual({
      name: 'now',
      arguments: {},
    });
  });

  it('sends a resources/read with its URI', () => {
    const call = mcpOperationCall({ method: 'resources/read', uri: 'file:///a.txt' });
    expect(call).toMatchObject({ capability: 'resources', params: { uri: 'file:///a.txt' } });
  });

  it('sends a prompts/get with its enabled arguments as strings', () => {
    const operation: McpOperation = {
      method: 'prompts/get',
      prompt: 'greet',
      arguments: [row('name', 'Ada'), row('tone', 'cold', false), row('', 'x'), row('name', 'Grace')],
    };
    expect(mcpOperationCall(operation)).toMatchObject({
      capability: 'prompts',
      params: { name: 'greet', arguments: { name: 'Grace' } },
    });
  });

  it('sends a prompts/get with no enabled arguments without an arguments member', () => {
    expect(mcpOperationParams({ method: 'prompts/get', prompt: 'p', arguments: [row('a', 'b', false)] })).toEqual({
      name: 'p',
    });
  });

  it('refuses arguments that are not JSON, or not an object', () => {
    expect(() => mcpOperationCall({ method: 'tools/call', tool: 't', arguments: '{nope' })).toThrow(McpError);
    for (const text of ['[1]', '3', 'null', '"s"']) {
      try {
        parseMcpArguments(text);
        expect.unreachable(text);
      } catch (err) {
        expect((err as McpError).code).toBe('mcp-arguments-invalid');
      }
    }
  });

  it('maps every method to a capability', () => {
    expect(Object.keys(MCP_METHOD_CAPABILITY)).toHaveLength(7);
  });
});

describe('mcpResultWarnings', () => {
  const valid: Record<string, unknown> = {
    'tools/list': { tools: [{ name: 't', inputSchema: { type: 'object' } }] },
    'tools/call': { content: [{ type: 'text', text: 'ok' }] },
    'resources/list': { resources: [{ uri: 'file:///a', name: 'a' }] },
    'resources/templates/list': { resourceTemplates: [{ uriTemplate: 'file:///{x}', name: 'x' }] },
    'resources/read': { contents: [{ uri: 'file:///a', text: 'hello' }] },
    'prompts/list': { prompts: [{ name: 'p' }] },
    'prompts/get': { messages: [{ role: 'user', content: { type: 'text', text: 'hi' } }] },
  };
  const invalid: Record<string, unknown> = {
    'tools/list': { tools: [{ inputSchema: { type: 'object' } }] },
    'tools/call': { content: [{ type: 'text' }] },
    'resources/list': { resources: 'none' },
    'resources/templates/list': { resourceTemplates: [{ name: 'x' }] },
    'resources/read': { contents: 3 },
    'prompts/list': { prompts: [{}] },
    'prompts/get': { messages: [{ role: 'robot', content: { type: 'text', text: 'hi' } }] },
  };

  it.each(Object.keys(valid))('accepts a valid %s result', (method) => {
    expect(mcpResultWarnings(method as McpOperation['method'], valid[method])).toEqual([]);
  });

  it.each(Object.keys(invalid))('warns about an invalid %s result, naming the method and the path', (method) => {
    const warnings = mcpResultWarnings(method as McpOperation['method'], invalid[method]);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain(`The ${method} result does not match the protocol`);
  });

  it('is what the call validates its result with', () => {
    const call = mcpOperationCall({ method: 'resources/list' });
    expect(call.validateResult?.({ resources: 'none' })).toEqual(
      mcpResultWarnings('resources/list', { resources: 'none' }),
    );
  });
});
