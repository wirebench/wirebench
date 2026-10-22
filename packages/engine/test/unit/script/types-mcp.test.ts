/**
 * MCP script types (#79): the arguments typed from the tool's `inputSchema` and the structured
 * content from its `outputSchema`, both phases' declarations compiling with a script, the method a
 * script has to narrow on, and the untyped forms when the catalogue does not have the tool.
 */
import { describe, expect, it } from 'vitest';
import { mcpScriptTypes, mcpToolFor } from '#protocol-mcp/mcp/script-types';
import type { McpCatalogueTool } from '#protocol-mcp/mcp/model';
import { apiDeclarations, secretNameType } from '#core/script/types/api';
import { typeErrors } from './ts-check.js';
// The composition: the entry points fall back to the registry it installs (package split spec §3.3).
import '../../../src/protocols.js';

const TOOL: McpCatalogueTool = {
  name: 'search',
  inputSchema: {
    type: 'object',
    properties: { q: { type: 'string' }, limit: { type: 'integer' } },
    required: ['q'],
  },
  outputSchema: {
    type: 'object',
    properties: { hits: { type: 'array', items: { type: 'string' } } },
    required: ['hits'],
  },
};

const declarations = (phase: 'pre' | 'post', tool: McpCatalogueTool | null = TOOL): string =>
  apiDeclarations('mcp', phase) + secretNameType([]) + mcpScriptTypes(tool ?? undefined);

describe('mcpScriptTypes', () => {
  it('types a tool call from its catalogue entry', () => {
    const ok = `
      if (request.method === 'tools/call') {
        request.arguments = { q: 'cats', limit: 3 };
        request.tool = 'search';
      }
      request.url = request.url + '?trace=1';
    `;
    expect(typeErrors(declarations('pre'), ok)).toEqual([]);
    const bad = `
      if (request.method === 'tools/call') request.arguments = { query: 'cats' };
      if (request.method === 'resources/read') request.tool = 'x';
    `;
    expect(typeErrors(declarations('pre'), bad)).toHaveLength(2);
  });

  it('types the response, its structured content from the output schema', () => {
    const ok = `
      const hits: string[] | undefined = response.result?.structuredContent?.hits;
      test('answered', () => expect(response.isError).toBe(false));
      vars.set('server', response.serverInfo?.name ?? '');
      log(hits, response.messageCount, response.durationMs, response.error?.code);
    `;
    expect(typeErrors(declarations('post'), ok)).toEqual([]);
    expect(typeErrors(declarations('post'), 'log(response.result?.structuredContent?.hitz);')).toHaveLength(1);
    expect(typeErrors(declarations('post'), "if (request.method === 'tools/call') request.tool = 'x';")).toHaveLength(
      1,
    );
  });

  it('leaves the arguments and the structured content untyped without the tool', () => {
    expect(mcpScriptTypes(undefined)).toContain('type WbMcpArguments = Record<string, unknown>;');
    expect(
      typeErrors(declarations('pre', null), "if (request.method === 'tools/call') request.arguments = { any: 1 };"),
    ).toEqual([]);
  });

  it('finds the tool a request calls, and none for another operation', () => {
    const catalogue = { tools: [TOOL] };
    expect(mcpToolFor(catalogue, { method: 'tools/call', tool: 'search', arguments: '' })).toBe(TOOL);
    expect(mcpToolFor(catalogue, { method: 'tools/call', tool: 'other', arguments: '' })).toBeUndefined();
    expect(mcpToolFor(catalogue, { method: 'tools/list' })).toBeUndefined();
    expect(mcpToolFor(undefined, { method: 'tools/call', tool: 'search', arguments: '' })).toBeUndefined();
  });
});
