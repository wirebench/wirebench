import { afterEach, describe, expect, it } from 'vitest';
import { runMcpSession, type McpOperationCall } from '#protocol-mcp/mcp/session';
import { openSseTransport, type McpSseTransport } from '#protocol-mcp/mcp/sse-transport';
import {
  startTestMcpSseServer,
  type TestMcpSseServer,
  type TestMcpSseServerOptions,
} from '../../helpers/mcp-sse-server.js';

const servers: TestMcpSseServer[] = [];

async function server(options: TestMcpSseServerOptions = {}): Promise<TestMcpSseServer> {
  const started = await startTestMcpSseServer(options);
  servers.push(started);
  return started;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const echo: McpOperationCall = { method: 'tools/call', params: { name: 'echo', arguments: { text: 'hi' } } };

const send = (t: McpSseTransport, operation: McpOperationCall = echo, timeoutMs = 10_000) =>
  runMcpSession({ transport: t, operation, clientVersion: '1.0.0', timeoutMs });

/** Waits until `check` holds, for a server-side effect of a close the client has already finished. */
async function eventually(check: () => boolean, ms = 2_000): Promise<void> {
  const until = Date.now() + ms;
  while (!check() && Date.now() < until) await new Promise((done) => setTimeout(done, 10));
}

describe('legacy HTTP+SSE transport', () => {
  it('opens the stream, posts to the endpoint it names, and reads the answers off the stream', async () => {
    const s = await server();
    const t = openSseTransport({ url: s.url, headers: { 'X-Api-Key': 'k1' } });
    const outcome = await send(t);
    expect(outcome.failure).toBeUndefined();
    expect(outcome.response).toEqual({ result: { content: [{ type: 'text', text: 'hi' }] } });
    expect(outcome.messages.every((m) => m.warnings.length === 0)).toBe(true);

    expect(t.endpoint).toMatch(new RegExp(`^${new URL(s.url).origin}/messages\\?sessionId=`));
    const [get, ...posts] = t.calls;
    expect(get).toMatchObject({ method: 'GET', url: s.url, status: 200 });
    expect(get?.responseHeaders['content-type']).toBe('text/event-stream');
    expect(posts.map((c) => [c.method, c.status, c.message?.method])).toEqual([
      ['POST', 202, 'initialize'],
      ['POST', 202, 'notifications/initialized'],
      ['POST', 202, 'tools/call'],
    ]);
    expect(s.requests[0]?.headers['accept']).toBe('text/event-stream');
    for (const req of s.requests) expect(req.headers['x-api-key']).toBe('k1');
  });

  it('aborts the stream on close', async () => {
    const s = await server();
    const t = openSseTransport({ url: s.url, headers: {} });
    await send(t, { method: 'tools/list', capability: 'tools' });
    await eventually(() => s.openStreams === 0);
    expect(s.openStreams).toBe(0);
    // The GET's record is filled in once the aborted stream has ended.
    expect(t.calls[0]?.timings).toBeDefined();
  });

  it('refuses an endpoint on another origin with mcp-endpoint-origin', async () => {
    const s = await server({ endpoint: 'http://elsewhere.test:9/messages' });
    const t = openSseTransport({ url: s.url, headers: {} });
    const outcome = await send(t);
    expect(outcome.failure?.code).toBe('mcp-endpoint-origin');
    expect(outcome.failure?.details).toMatchObject({
      endpoint: 'http://elsewhere.test:9/messages',
      origin: new URL(s.url).origin,
    });
    expect(outcome.messages).toHaveLength(0);
    expect(s.requests.map((r) => r.method)).toEqual(['GET']);
    await eventually(() => s.openStreams === 0);
    expect(s.openStreams).toBe(0);
  });

  it('resolves a relative endpoint against the stream URL', async () => {
    const s = await server({ endpoint: 'messages?sessionId=x' });
    const t = openSseTransport({ url: s.url, headers: {} });
    // The fixture keeps no such session, so the first POST there is answered 404.
    const outcome = await send(t);
    expect(t.endpoint).toBe(`${new URL(s.url).origin}/messages?sessionId=x`);
    expect(outcome.failure?.code).toBe('mcp-http-status');
  });

  it('fails with mcp-endpoint-missing when the stream closes before naming its endpoint', async () => {
    const s = await server({ closeBeforeEndpoint: true });
    const t = openSseTransport({ url: s.url, headers: {} });
    const outcome = await send(t);
    expect(outcome.failure?.code).toBe('mcp-endpoint-missing');
    expect(t.calls).toHaveLength(1);
  });

  it('fails with mcp-http-status when the stream URL is not found', async () => {
    const s = await server();
    const t = openSseTransport({ url: s.url.replace(/\/sse$/, '/nowhere'), headers: {} });
    const outcome = await send(t);
    expect(outcome.failure?.code).toBe('mcp-http-status');
    expect(outcome.failure?.details).toMatchObject({ status: 404, method: 'GET' });
  });
});
