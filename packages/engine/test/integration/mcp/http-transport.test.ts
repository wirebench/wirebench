import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { openStreamableHttpTransport, type McpStreamableHttpTransport } from '#protocol-mcp/mcp/http-transport';
import { runMcpSession, type McpOperationCall } from '#protocol-mcp/mcp/session';
import {
  startTestMcpHttpServer,
  type TestMcpHttpServer,
  type TestMcpHttpServerOptions,
} from '../../helpers/mcp-http-server.js';

const servers: TestMcpHttpServer[] = [];

async function server(options: TestMcpHttpServerOptions = {}): Promise<TestMcpHttpServer> {
  const started = await startTestMcpHttpServer(options);
  servers.push(started);
  return started;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const echo: McpOperationCall = { method: 'tools/call', params: { name: 'echo', arguments: { text: 'hi' } } };

const send = (t: McpStreamableHttpTransport, operation: McpOperationCall = echo, timeoutMs = 10_000) =>
  runMcpSession({ transport: t, operation, clientVersion: '1.0.0', timeoutMs });

describe('Streamable HTTP transport', () => {
  for (const json of [true, false]) {
    it(`calls a tool on a server that answers with ${json ? 'JSON' : 'an event stream'}`, async () => {
      const s = await server({ json });
      const t = openStreamableHttpTransport({ url: s.url, headers: { 'X-Api-Key': 'k1' } });
      const outcome = await send(t);
      expect(outcome.failure).toBeUndefined();
      expect(outcome.response).toEqual({ result: { content: [{ type: 'text', text: 'hi' }] } });
      expect(outcome.messages.every((m) => m.warnings.length === 0)).toBe(true);

      const operationCall = t.calls.find((c) => c.message?.method === 'tools/call');
      expect(operationCall).toMatchObject({ method: 'POST', url: s.url, status: 200 });
      expect(operationCall?.responseHeaders['content-type']).toContain(json ? 'application/json' : 'text/event-stream');
      expect(operationCall?.timings?.totalMs).toBeGreaterThanOrEqual(0);
      // The notification is acknowledged with a 202 and no body.
      expect(t.calls.find((c) => c.message?.method === 'notifications/initialized')?.status).toBe(202);
      for (const req of s.requests.filter((r) => r.method === 'POST')) {
        expect(req.headers['accept']).toBe('application/json, text/event-stream');
        expect(req.headers['content-type']).toBe('application/json');
        expect(req.headers['x-api-key']).toBe('k1');
      }
    });
  }

  it('carries the session id and the protocol version after initialize, and ends the session with DELETE', async () => {
    const s = await server({ json: true });
    const t = openStreamableHttpTransport({ url: s.url, headers: {} });
    const outcome = await send(t, { method: 'tools/list', capability: 'tools' });
    expect(outcome.failure).toBeUndefined();
    expect(t.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(t.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);

    const [init, ...later] = s.requests;
    expect(init?.headers['mcp-session-id']).toBeUndefined();
    expect(init?.headers['mcp-protocol-version']).toBeUndefined();
    expect(later.map((r) => r.method)).toEqual(['POST', 'POST', 'DELETE']);
    for (const req of later) {
      expect(req.headers['mcp-session-id']).toBe(t.sessionId);
      expect(req.headers['mcp-protocol-version']).toBe(LATEST_PROTOCOL_VERSION);
    }
    expect(t.calls.map((c) => [c.method, c.status])).toEqual([
      ['POST', 200],
      ['POST', 202],
      ['POST', 200],
      ['DELETE', 200],
    ]);
  });

  it('accepts a 405 on the closing DELETE', async () => {
    const s = await server({ json: true, deleteStatus: 405 });
    const t = openStreamableHttpTransport({ url: s.url, headers: {} });
    const outcome = await send(t, { method: 'tools/list' });
    expect(outcome.failure).toBeUndefined();
    expect(t.calls.at(-1)).toMatchObject({ method: 'DELETE', status: 405 });
  });

  it('sends no DELETE for a server that gave no session id', async () => {
    const s = await server({ json: true, stateless: true });
    const t = openStreamableHttpTransport({ url: s.url, headers: {} });
    const outcome = await send(t, { method: 'tools/list' });
    expect(outcome.failure).toBeUndefined();
    expect(t.sessionId).toBeUndefined();
    expect(s.requests.map((r) => r.method)).toEqual(['POST', 'POST', 'POST']);
  });

  for (const status of [401, 500]) {
    it(`fails with mcp-http-status when initialize is answered with ${status}`, async () => {
      const s = await server({ status });
      const t = openStreamableHttpTransport({ url: s.url, headers: {} });
      const outcome = await send(t);
      expect(outcome.failure?.code).toBe('mcp-http-status');
      expect(outcome.failure?.message).toContain(`HTTP ${status}`);
      expect(outcome.failure?.details).toMatchObject({ status, method: 'POST', body: 'refused by the fixture' });
      expect(t.calls).toHaveLength(1);
      expect(t.calls[0]).toMatchObject({ status, message: { method: 'initialize' } });
    });
  }

  it('fails with mcp-http-failed when nothing listens', async () => {
    const s = await server();
    const url = s.url;
    await s.close();
    servers.length = 0;
    const t = openStreamableHttpTransport({ url, headers: {} });
    const outcome = await send(t);
    expect(outcome.failure?.code).toBe('mcp-http-failed');
    expect(t.calls[0]).toMatchObject({ status: 0 });
    expect(t.calls[0]?.error).toBeDefined();
  });

  it('refuses a URL that is not http or https', async () => {
    const t = openStreamableHttpTransport({ url: 'ftp://example.test/mcp', headers: {} });
    const outcome = await send(t);
    expect(outcome.failure?.code).toBe('mcp-bad-url');
  });

  it('aborts a call still waiting when the deadline passes', async () => {
    const s = await server({ json: false });
    const t = openStreamableHttpTransport({ url: s.url, headers: {} });
    const started = performance.now();
    const outcome = await send(t, { method: 'tools/call', params: { name: 'slow', arguments: {} } }, 800);
    expect(outcome.failure?.code).toBe('mcp-timeout');
    expect(performance.now() - started).toBeLessThan(4_000);
    expect(outcome.messages.some((m) => m.method === 'notifications/cancelled')).toBe(true);
  });
});
