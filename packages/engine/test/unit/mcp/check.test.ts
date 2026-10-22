import { describe, expect, it } from 'vitest';
import { checkMcpResult, firstTextContent, MCP_RESULT_CHECK, mcpCatalogueChecks } from '#protocol-mcp/mcp/check';
import type { McpCatalogue, McpOperation } from '#protocol-mcp/mcp/model';

const call = (args: string, tool = 'add'): McpOperation => ({ method: 'tools/call', tool, arguments: args });

const catalogue: McpCatalogue = {
  tools: [
    {
      name: 'add',
      inputSchema: {
        type: 'object',
        properties: { a: { type: 'number' }, b: { type: 'number' } },
        required: ['a', 'b'],
      },
      outputSchema: { type: 'object', properties: { sum: { type: 'number' } }, required: ['sum'] },
    },
    { name: 'echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
  ],
};

describe('checkMcpResult', () => {
  it('passes a result', () => {
    expect(checkMcpResult({ method: 'tools/list', result: { tools: [] } })).toEqual({
      type: 'mcp',
      label: MCP_RESULT_CHECK,
      outcome: 'passed',
      expected: 'no error',
      actual: 'OK',
    });
  });

  it('fails a JSON-RPC error, with its code and message', () => {
    expect(checkMcpResult({ method: 'tools/call', error: { code: -32602, message: 'Invalid params' } })).toMatchObject({
      type: 'mcp',
      outcome: 'failed',
      actual: 'Error -32602 Invalid params',
    });
  });

  it('fails a tools/call result with isError, with its first text content as the actual', () => {
    const result = {
      isError: true,
      content: [
        { type: 'image', data: 'AA==', mimeType: 'image/png' },
        { type: 'text', text: 'division by zero' },
        { type: 'text', text: 'second' },
      ],
    };
    expect(checkMcpResult({ method: 'tools/call', result })).toMatchObject({
      outcome: 'failed',
      actual: 'division by zero',
    });
  });

  it('fails an isError result with no text content', () => {
    expect(checkMcpResult({ method: 'tools/call', result: { isError: true, content: [] } })).toMatchObject({
      outcome: 'failed',
      actual: 'isError: true',
    });
  });

  it('caps a long actual', () => {
    const actual = checkMcpResult({
      method: 'tools/call',
      result: { isError: true, content: [{ type: 'text', text: 'x'.repeat(1000) }] },
    }).actual!;
    expect(actual.length).toBe(300);
    expect(actual.endsWith('…')).toBe(true);
  });

  it('passes isError on a method that is not tools/call', () => {
    expect(checkMcpResult({ method: 'resources/read', result: { isError: true, contents: [] } }).outcome).toBe(
      'passed',
    );
  });

  it('fails when there was no answer at all', () => {
    expect(checkMcpResult({ method: 'tools/list' })).toMatchObject({ outcome: 'failed', actual: 'no answer' });
  });
});

describe('firstTextContent', () => {
  it('reads nothing from a result with no content', () => {
    expect(firstTextContent({})).toBeUndefined();
    expect(firstTextContent('text')).toBeUndefined();
  });
});

describe('mcpCatalogueChecks', () => {
  it('finds nothing for arguments and structured content that match', () => {
    expect(
      mcpCatalogueChecks({
        operation: call('{"a":1,"b":2}'),
        result: { content: [], structuredContent: { sum: 3 } },
        catalogue,
      }),
    ).toEqual([]);
  });

  it('warns about arguments that do not match the inputSchema, without copying their values', () => {
    const warnings = mcpCatalogueChecks({ operation: call('{"a":"secret-value"}'), catalogue });
    expect(warnings.length).toBe(2);
    expect(warnings.every((w) => w.startsWith('The arguments do not match the inputSchema of "add"'))).toBe(true);
    expect(warnings.join('\n')).toContain('/a');
    expect(warnings.join('\n')).not.toContain('secret-value');
  });

  it('checks blank arguments as {}', () => {
    expect(mcpCatalogueChecks({ operation: call(''), catalogue }).length).toBeGreaterThan(0);
  });

  it('warns about structuredContent that does not match the outputSchema', () => {
    const warnings = mcpCatalogueChecks({
      operation: call('{"a":1,"b":2}'),
      result: { content: [], structuredContent: { sum: 'three' } },
      catalogue,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^The structuredContent does not match the outputSchema of "add" at \/sum: /);
    expect(warnings[0]).not.toContain('three');
  });

  it('warns about a result with no structuredContent when the tool has an outputSchema', () => {
    expect(mcpCatalogueChecks({ operation: call('{"a":1,"b":2}'), result: { content: [] }, catalogue })).toEqual([
      'The result of "add" has no structuredContent, which its outputSchema calls for',
    ]);
  });

  it('does not check the structured content of an isError result', () => {
    expect(
      mcpCatalogueChecks({ operation: call('{"a":1,"b":2}'), result: { isError: true, content: [] }, catalogue }),
    ).toEqual([]);
  });

  it('does not check the output of a tool with no outputSchema', () => {
    expect(mcpCatalogueChecks({ operation: call('{"text":"x"}', 'echo'), result: { content: [] }, catalogue })).toEqual(
      [],
    );
  });

  it('checks nothing without a catalogue, for a tool it does not have, or for another method', () => {
    expect(mcpCatalogueChecks({ operation: call('{"a":"x"}') })).toEqual([]);
    expect(mcpCatalogueChecks({ operation: call('{"a":"x"}', 'missing'), catalogue })).toEqual([]);
    expect(mcpCatalogueChecks({ operation: { method: 'tools/list' }, result: {}, catalogue })).toEqual([]);
  });

  it('skips the input check for arguments that are not an object', () => {
    expect(mcpCatalogueChecks({ operation: call('[1]'), catalogue })).toEqual([]);
  });
});
