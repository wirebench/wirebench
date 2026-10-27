/**
 * MCP's wire shapes (#79): what crosses the bridge for a server, a request and a send, and that the
 * engine's exchange and History entry survive the schemas whole.
 */
import { buildMcpHistoryEntry, type McpExchange } from '@wirebench/engine';
import { describe, expect, it } from 'vitest';
import {
  appMcpApproveRequestSchema,
  mcpExchangeSummarySchema,
  mcpOperationWireSchema,
  mcpRequestWireSchema,
  mcpServerWireSchema,
} from '@wirebench/wire/kinds/mcp/wire';
import { historyEntrySchema, projectChangeSchema, projectWireSchema } from '@wirebench/wire/wire-types';
import { NO_REST, PROJECT_SETTINGS } from './helpers/wire-defaults.js';

const server = {
  kind: 'mcp',
  id: 's1',
  name: 'Files',
  slug: 'files',
  order: 0,
  settings: {},
} as const;

/** A finished `tools/call` over Streamable HTTP, as the engine records it. */
const exchange: McpExchange = {
  kind: 'mcp',
  transport: { type: 'http', url: 'https://mcp.test/mcp' },
  method: 'tools/call',
  startedAt: '2026-10-14T10:00:00.000Z',
  durationMs: 42,
  initialize: { protocolVersion: '2025-06-18', serverInfo: { name: 'files', version: '1.0.0' }, capabilities: {} },
  protocolVersion: '2025-06-18',
  messages: [
    {
      direction: 'sent',
      at: '2026-10-14T10:00:00.010Z',
      size: 70,
      kind: 'request',
      id: 2,
      method: 'tools/call',
      text: '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"read"}}',
      warnings: [],
    },
    {
      direction: 'received',
      at: '2026-10-14T10:00:00.040Z',
      size: 60,
      kind: 'result',
      id: 2,
      method: 'tools/call',
      text: '{"jsonrpc":"2.0","id":2,"result":{"content":[],"isError":true}}',
      warnings: ['an unexpected field'],
    },
  ],
  droppedMessages: 0,
  httpCalls: [
    {
      method: 'POST',
      url: 'https://mcp.test/mcp',
      startedAt: '2026-10-14T10:00:00.010Z',
      status: 200,
      requestHeaders: { accept: 'application/json, text/event-stream' },
      responseHeaders: { 'content-type': 'application/json' },
      timings: { startedAt: '2026-10-14T10:00:00.010Z', totalMs: 30, ttfbMs: 20 },
      message: { id: 2, method: 'tools/call' },
    },
  ],
  result: { content: [], isError: true },
  warnings: ['The arguments do not match the tool’s input schema: /path is required'],
};

describe('an MCP server on the wire', () => {
  it.each([
    { type: 'stdio', command: 'node', args: ['server.js'], cwd: 'tools', env: [] },
    { type: 'http', url: 'https://mcp.test/mcp', headers: [], auth: { type: 'inherit' } },
    { type: 'sse', url: 'https://mcp.test/sse', headers: [] },
  ])('takes a $type transport', (transport) => {
    const parsed = mcpServerWireSchema.parse({ ...server, transport });
    expect(parsed.transport).toEqual(transport);
  });

  it('refuses a transport it does not know', () => {
    expect(mcpServerWireSchema.safeParse({ ...server, transport: { type: 'ws', url: 'ws://x' } }).success).toBe(false);
  });

  it('keeps a catalogue entry’s fields the protocol adds later', () => {
    const catalogue = {
      tools: [{ name: 'read', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }],
    };
    const parsed = mcpServerWireSchema.parse({
      ...server,
      transport: { type: 'sse', url: 'u', headers: [] },
      catalogue,
    });
    expect(parsed.catalogue).toEqual(catalogue);
  });
});

describe('an MCP request on the wire', () => {
  it.each([
    { method: 'tools/list' },
    { method: 'resources/templates/list' },
    { method: 'tools/call', tool: 'read', arguments: '{"path":"a"}' },
    { method: 'resources/read', uri: 'file:///a' },
    { method: 'prompts/get', prompt: 'review', arguments: [{ name: 'code', value: 'x', enabled: true }] },
  ])('takes the $method operation', (operation) => {
    expect(mcpOperationWireSchema.parse(operation)).toEqual(operation);
  });

  it('refuses a free-form method, and a call with no tool', () => {
    expect(mcpOperationWireSchema.safeParse({ method: 'ping' }).success).toBe(false);
    expect(mcpOperationWireSchema.safeParse({ method: 'tools/call', arguments: '' }).success).toBe(false);
  });

  it('defaults a stub’s assertions', () => {
    const parsed = mcpRequestWireSchema.parse({
      kind: 'mcp',
      id: 'r1',
      apiId: 's1',
      name: 'List tools',
      slug: 'list-tools',
      order: 0,
      operation: { method: 'tools/list' },
      settings: {},
    });
    expect(parsed.assertions).toEqual([]);
  });

  it('sits in a project snapshot beside the other kinds', () => {
    const project = projectWireSchema.parse({
      id: 'p',
      name: 'P',
      dir: '/p',
      dirty: false,
      interfaces: [],
      requests: [],
      ...NO_REST,
      mcpServers: [{ ...server, transport: { type: 'stdio', command: 'node', args: [], env: [] } }],
      properties: {},
      disabledProperties: [],
      environments: [],
      problems: [],
      settings: PROJECT_SETTINGS,
      keystores: [],
      wssOutgoing: [],
      wssIncoming: [],
    });
    expect(project.mcpServers.map((one) => one.name)).toEqual(['Files']);
  });

  it.each([
    { kind: 'add-mcp-server', name: 'Files', transport: { type: 'http', url: 'https://mcp.test', headers: [] } },
    { kind: 'update-mcp-server', apiId: 's1', patch: { description: null, settings: { timeoutMs: 5000 } } },
    { kind: 'remove-mcp-server', apiId: 's1' },
    { kind: 'add-mcp-request', apiId: 's1', operation: { method: 'tools/call', tool: 'read', arguments: '' } },
    { kind: 'update-mcp-request', requestId: 'r1', patch: { operation: { method: 'resources/read', uri: 'a' } } },
    { kind: 'remove-mcp-request', requestId: 'r1' },
    { kind: 'clone-mcp-request', requestId: 'r1' },
  ])('carries the $kind change', (change) => {
    expect(projectChangeSchema.parse(change)).toEqual(change);
  });
});

describe('an MCP send on the wire', () => {
  it('carries the engine’s exchange whole', () => {
    const summary = { ...exchange, sendId: 'send-1' };
    expect({ kind: 'mcp', ...mcpExchangeSummarySchema.parse(summary) }).toEqual(summary);
  });

  it('carries the engine’s History entry whole', () => {
    const entry = buildMcpHistoryEntry(
      'p',
      { requestId: 'r1', requestName: 'Read', serverName: 'Files', folderPath: '', exchange },
      { text: (text) => text },
    );
    expect(entry.mcp).toBeDefined();
    expect(historyEntrySchema.parse(entry)).toEqual(entry);
  });

  it('answers an approval prompt with one of the dialog’s three buttons', () => {
    for (const answer of ['once', 'always', 'cancel']) {
      expect(appMcpApproveRequestSchema.safeParse({ promptId: 'p1', answer }).success).toBe(true);
    }
    expect(appMcpApproveRequestSchema.safeParse({ promptId: 'p1', answer: 'forever' }).success).toBe(false);
  });
});
