/**
 * The catalogue session without a server (#79): every advertised list on one session, pages
 * followed through `nextCursor` up to the cap, an absent capability skipped, and a stable result.
 */
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { collectMcpCatalogue, MCP_CATALOGUE_MAX_PAGES, storedMcpCatalogue } from '#protocol-mcp/mcp/catalogue';
import { serializeMcpCatalogue } from '#protocol-mcp/mcp/files';
import type { McpWireHandlers, McpWireTransport } from '#protocol-mcp/mcp/transport';

type Answer = (method: string, params: Record<string, unknown> | undefined) => unknown;

/** A server advertising `capabilities` whose list answers are `answer`'s. */
function fakeServer(
  capabilities: Record<string, unknown>,
  answer: Answer,
): McpWireTransport & { sent: Record<string, unknown>[] } {
  let handlers: McpWireHandlers | undefined;
  const sent: Record<string, unknown>[] = [];
  const push = (value: unknown): void => queueMicrotask(() => handlers?.onMessage(JSON.stringify(value)));
  return {
    sent,
    start(given) {
      handlers = given;
      return Promise.resolve();
    },
    send(text) {
      const message = JSON.parse(text) as Record<string, unknown>;
      sent.push(message);
      const { id, method } = message as { id?: number; method?: string };
      if (id === undefined || method === undefined) return Promise.resolve();
      if (method === 'initialize') {
        push({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: LATEST_PROTOCOL_VERSION,
            capabilities,
            serverInfo: { name: 'fake', version: '1' },
          },
        });
      } else {
        const result = answer(method, message['params'] as Record<string, unknown> | undefined);
        push(
          result instanceof Error
            ? { jsonrpc: '2.0', id, error: { code: -32603, message: result.message } }
            : { jsonrpc: '2.0', id, result },
        );
      }
      return Promise.resolve();
    },
    close() {
      return Promise.resolve();
    },
  };
}

const tool = (name: string) => ({ name, inputSchema: { type: 'object' } });

const collect = (transport: McpWireTransport) => collectMcpCatalogue({ transport, clientVersion: '9.9.9' });

describe('collectMcpCatalogue', () => {
  it('follows nextCursor through every page of a list', async () => {
    const pages: Record<string, unknown> = {
      '': { tools: [tool('a')], nextCursor: 'p2' },
      p2: { tools: [tool('b')], nextCursor: 'p3' },
      p3: { tools: [tool('c')] },
    };
    const server = fakeServer({ tools: {} }, (method, params) => pages[(params?.['cursor'] as string) ?? '']);
    const { outcome, lists, warnings } = await collect(server);
    expect(outcome.failure).toBeUndefined();
    expect(lists).toEqual({ tools: [tool('a'), tool('b'), tool('c')] });
    expect(warnings).toEqual([]);
    expect(server.sent.map((m) => [m['method'], (m['params'] as { cursor?: string } | undefined)?.cursor])).toEqual([
      ['initialize', undefined],
      ['notifications/initialized', undefined],
      ['tools/list', undefined],
      ['tools/list', 'p2'],
      ['tools/list', 'p3'],
    ]);
  });

  it('skips a list whose capability was not advertised, and lists both resource kinds', async () => {
    const server = fakeServer({ resources: {}, prompts: {} }, (method) => {
      if (method === 'resources/list') return { resources: [{ uri: 'file:///a', name: 'a' }] };
      if (method === 'resources/templates/list') return { resourceTemplates: [] };
      return { prompts: [{ name: 'greet' }] };
    });
    const { lists } = await collect(server);
    expect(Object.keys(lists)).toEqual(['resources', 'resourceTemplates', 'prompts']);
    expect(server.sent.map((m) => m['method'])).not.toContain('tools/list');
  });

  it('stops at the page cap with a warning', async () => {
    let n = 0;
    const server = fakeServer({ tools: {} }, () => ({ tools: [tool(`t${n}`)], nextCursor: `c${++n}` }));
    const { outcome, lists, warnings } = await collect(server);
    expect(outcome.failure).toBeUndefined();
    expect(lists['tools']).toHaveLength(MCP_CATALOGUE_MAX_PAGES);
    expect(warnings).toEqual([expect.stringContaining('tools/list still had more after 50 pages')]);
  });

  it('fails the session when the server refuses a list', async () => {
    const server = fakeServer({ tools: {} }, () => new Error('nope'));
    const { outcome } = await collect(server);
    expect(outcome.failure).toMatchObject({ code: 'mcp-catalogue-failed', details: { method: 'tools/list' } });
  });

  it('still sends notifications/initialized when the server advertises no list', async () => {
    const server = fakeServer({}, () => ({}));
    const { outcome, lists } = await collect(server);
    expect(outcome.failure).toBeUndefined();
    expect(lists).toEqual({});
    expect(server.sent.map((m) => m['method'])).toEqual(['initialize', 'notifications/initialized']);
  });
});

describe('storedMcpCatalogue', () => {
  it('is the stored form whatever order the server listed in, so a refresh with no change saves the same bytes', () => {
    const one = storedMcpCatalogue({
      tools: [{ inputSchema: { type: 'object' }, description: 'B', name: 'b' }, tool('a')],
      prompts: [{ name: 'z' }, { name: 'y' }],
    });
    const two = storedMcpCatalogue({
      prompts: [{ name: 'y' }, { name: 'z' }],
      tools: [tool('a'), { name: 'b', description: 'B', inputSchema: { type: 'object' } }],
    });
    expect(one.tools!.map((t) => t.name)).toEqual(['a', 'b']);
    expect(Object.keys(one.tools![1]!)).toEqual(['name', 'description', 'inputSchema']);
    expect(serializeMcpCatalogue(one)).toBe(serializeMcpCatalogue(two));
    expect(JSON.stringify(one)).toBe(JSON.stringify(two));
  });

  it('refuses an entry the catalogue file cannot keep', () => {
    expect(() => storedMcpCatalogue({ tools: [{ name: 'no-schema' }] })).toThrow(
      expect.objectContaining({ code: 'mcp-catalogue-invalid' }),
    );
  });
});
