import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { InvalidTokenError, resolveToken, startHttpServer } from '../../../src/mcp/http.js';
import type { RunningHttpServer } from '../../../src/mcp/http.js';
import { createMcpServer } from '../../../src/mcp/server.js';
import { removeTempDirs, soapProject } from '../ops/helpers.js';

const TOKEN = 'abc123def456ghi789abc123def456ghi789';

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'test', version: '0' } },
};

let running: RunningHttpServer | undefined;
let logged: string[] = [];

afterEach(async () => {
  await running?.close();
  running = undefined;
  logged = [];
  await removeTempDirs();
});

async function start(maxSessions?: number): Promise<RunningHttpServer> {
  const fixture = await soapProject();
  running = await startHttpServer({
    port: 0,
    ...(maxSessions !== undefined ? { maxSessions } : {}),
    token: TOKEN,
    createServer: () => createMcpServer(fixture.base({ gates: { write: false, send: false } }), '0.0.0-test'),
    log: (line) => logged.push(line),
  });
  return running;
}

async function post(
  url: string,
  headers: Record<string, string>,
  body: string = JSON.stringify(INITIALIZE),
): Promise<Response> {
  return await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body,
  });
}

async function status(url: string, headers: Record<string, string>, body?: string): Promise<number> {
  const response = await post(url, headers, body);
  await response.body?.cancel();
  return response.status;
}

/** A POST with the given Host header, or none: `fetch` will not let a test choose its Host. */
async function postWithHost(
  server: RunningHttpServer,
  host: string | undefined,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return await new Promise((resolve, reject) => {
    const req = request(
      server.url,
      {
        method: 'POST',
        setHost: false,
        headers: {
          ...(host !== undefined ? { Host: host } : {}),
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...headers,
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => {
          body += chunk.toString();
          // An initialize answers with a stream that stays open; the status is all a test needs.
          if (res.statusCode === 200) {
            res.destroy();
            resolve({ status: 200, body });
          }
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        res.on('error', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify(INITIALIZE));
  });
}

describe('the MCP HTTP server', () => {
  it('binds 127.0.0.1 and serves /mcp', async () => {
    const server = await start();
    expect(server.host).toBe('127.0.0.1');
    expect(server.url).toBe(`http://127.0.0.1:${String(server.port)}/mcp`);
  });

  it('answers 401 without the token or with a wrong one', async () => {
    const server = await start();
    const none = await post(server.url, {});
    await none.body?.cancel();
    expect(none.status).toBe(401);
    expect(none.headers.get('www-authenticate')).toBe('Bearer');
    expect(await status(server.url, { Authorization: 'Bearer abc123def456ghi789' })).toBe(401);
    expect(await status(server.url, { Authorization: `Bearer ${TOKEN}x` })).toBe(401);
    expect(await status(server.url, { Authorization: `Basic ${TOKEN}` })).toBe(401);
  });

  it('answers 403 to a foreign Origin, even with the token, and serves a local one', async () => {
    const server = await start();
    const auth = { Authorization: `Bearer ${TOKEN}` };
    expect(await status(server.url, { ...auth, Origin: 'http://evil.example' })).toBe(403);
    expect(await status(server.url, { ...auth, Origin: 'http://localhost:1' })).toBe(403);
    expect(await status(server.url, { ...auth, Origin: 'null' })).toBe(403);
    expect(await status(server.url, { ...auth, Origin: `http://localhost:${String(server.port)}` })).toBe(200);
    expect(await status(server.url, { ...auth, Origin: `http://127.0.0.1:${String(server.port)}` })).toBe(200);
  });

  it('compares the Origin exactly: an uppercase host or a trailing slash is refused', async () => {
    const server = await start();
    const auth = { Authorization: `Bearer ${TOKEN}` };
    const port = String(server.port);
    expect(await status(server.url, { ...auth, Origin: `http://LOCALHOST:${port}` })).toBe(403);
    expect(await status(server.url, { ...auth, Origin: `http://localhost:${port}/` })).toBe(403);
    expect(await status(server.url, { ...auth, Origin: `http://127.0.0.1:${port}/` })).toBe(403);
  });

  it.each(['GET', 'POST', 'DELETE', 'OPTIONS', 'HEAD'])(
    'checks Origin then token for every method (%s)',
    async (method) => {
      const server = await start();
      const send = async (headers: Record<string, string>): Promise<number> => {
        const response = await fetch(server.url, { method, headers });
        await response.body?.cancel();
        return response.status;
      };
      expect(await send({ Authorization: `Bearer ${TOKEN}`, Origin: 'http://evil.example' })).toBe(403);
      expect(await send({ Origin: 'http://evil.example' })).toBe(403);
      expect(await send({})).toBe(401);
      expect(await send({ Authorization: 'Bearer wrong-wrong-wrong-wrong' })).toBe(401);
    },
  );

  it('allows only its own Host, checked after the Origin and before the token', async () => {
    const server = await start();
    const auth = { Authorization: `Bearer ${TOKEN}` };
    const port = String(server.port);
    expect((await postWithHost(server, `evil.example:${port}`, auth)).status).toBe(403);
    expect((await postWithHost(server, `evil.example:${port}`, {})).status).toBe(403);
    expect((await postWithHost(server, `127.0.0.1:${String(server.port + 1)}`, auth)).status).toBe(403);
    expect((await postWithHost(server, '127.0.0.1', auth)).status).toBe(403);
    expect((await postWithHost(server, undefined, auth)).status).toBe(403);
    expect(
      (await postWithHost(server, `evil.example:${port}`, { ...auth, Origin: 'http://evil.example' })).status,
    ).toBe(403);
    const refused = await postWithHost(server, `evil.example:${port}`, auth);
    expect(refused.body).not.toContain('evil.example');
    expect((await postWithHost(server, `127.0.0.1:${port}`, auth)).status).toBe(200);
    expect((await postWithHost(server, `localhost:${port}`, auth)).status).toBe(200);
    expect((await postWithHost(server, `LOCALHOST:${port}`, auth)).status).toBe(200);
  });

  it('refuses an initialize beyond the session cap, and takes one again when a session ends', async () => {
    const server = await start(2);
    const auth = { Authorization: `Bearer ${TOKEN}` };
    const first = await post(server.url, auth);
    await first.body?.cancel();
    const second = await post(server.url, auth);
    await second.body?.cancel();
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const third = await post(server.url, auth);
    const body = await third.text();
    expect(third.status).toBe(503);
    expect(body).not.toContain(TOKEN);
    const firstId = first.headers.get('mcp-session-id') ?? '';
    expect(
      (await fetch(server.url, { method: 'DELETE', headers: { ...auth, 'mcp-session-id': firstId } })).status,
    ).toBe(200);
    expect(await status(server.url, auth)).toBe(200);
  });

  it('checks the Origin before the token', async () => {
    const server = await start();
    expect(await status(server.url, { Origin: 'http://evil.example' })).toBe(403);
  });

  it('answers 404 off /mcp and for an unknown session', async () => {
    const server = await start();
    const auth = { Authorization: `Bearer ${TOKEN}` };
    expect(await status(server.url.replace('/mcp', '/other'), auth)).toBe(404);
    expect(await status(server.url, { ...auth, 'mcp-session-id': 'nope' })).toBe(404);
  });

  it('checks the token before the path', async () => {
    const server = await start();
    expect(await status(server.url.replace('/mcp', '/other'), {})).toBe(401);
  });

  it('serves a client that sends the token', async () => {
    const server = await start();
    const client = new Client({ name: 'wirebench-test', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
    });
    await client.connect(transport as Transport);
    try {
      expect((await client.listTools()).tools).toHaveLength(8);
      const result = await client.callTool({ name: 'operations', arguments: {} });
      expect(result.isError).not.toBe(true);
    } finally {
      await client.close();
    }
  });

  it('gives each client its own session, and forgets a session when the client ends it', async () => {
    const server = await start();
    const auth = { Authorization: `Bearer ${TOKEN}` };
    const first = await post(server.url, auth);
    await first.body?.cancel();
    const second = await post(server.url, auth);
    await second.body?.cancel();
    const firstId = first.headers.get('mcp-session-id');
    const secondId = second.headers.get('mcp-session-id');
    expect(firstId).toBeTruthy();
    expect(secondId).toBeTruthy();
    expect(firstId).not.toBe(secondId);

    const ended = await fetch(server.url, {
      method: 'DELETE',
      headers: { ...auth, 'mcp-session-id': firstId ?? '' },
    });
    expect(ended.status).toBe(200);
    expect(await status(server.url, { ...auth, 'mcp-session-id': firstId ?? '' })).toBe(404);
    expect(await status(server.url, { ...auth, 'mcp-session-id': secondId ?? '' }, '{}')).not.toBe(404);
  });

  it('refuses a request body over 16 MiB', async () => {
    const server = await start();
    const auth = { Authorization: `Bearer ${TOKEN}` };
    const big = JSON.stringify({ ...INITIALIZE, padding: 'x'.repeat(17 * 1024 * 1024) });
    expect(await status(server.url, auth, big)).toBe(413);
  });

  it('never puts the token or a request header in an error body', async () => {
    const server = await start();
    const secretHeader = 'abc123def456ghi789-header';
    const bodies: string[] = [];
    for (const headers of [
      { Authorization: 'Bearer wrong', 'X-Probe': secretHeader },
      { Authorization: `Bearer ${TOKEN}`, Origin: `http://evil.example/${secretHeader}` },
      { Authorization: `Bearer ${TOKEN}`, 'mcp-session-id': secretHeader },
    ]) {
      bodies.push(await (await post(server.url, headers)).text());
    }
    bodies.push(await (await post(server.url.replace('/mcp', '/other'), { Authorization: `Bearer ${TOKEN}` })).text());
    for (const body of bodies) {
      expect(body).not.toContain(TOKEN);
      expect(body).not.toContain(secretHeader);
    }
    expect(logged.join('\n')).not.toContain(TOKEN);
  });

  it('frees the port when closed', async () => {
    const server = await start();
    await server.close();
    running = undefined;
    await expect(fetch(server.url)).rejects.toThrow();
  });

  it('takes the token from WIREBENCH_MCP_TOKEN, or makes one', () => {
    expect(resolveToken({ WIREBENCH_MCP_TOKEN: TOKEN })).toEqual({ token: TOKEN, generated: false });
    const made = resolveToken({});
    expect(made.generated).toBe(true);
    expect(made.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(resolveToken({ WIREBENCH_MCP_TOKEN: '' }).generated).toBe(true);
    expect(resolveToken({}).token).not.toBe(made.token);
  });

  it('trims the token, treats a blank one as unset, and refuses a short or spaced one', () => {
    expect(resolveToken({ WIREBENCH_MCP_TOKEN: `  ${TOKEN}\n` })).toEqual({ token: TOKEN, generated: false });
    expect(resolveToken({ WIREBENCH_MCP_TOKEN: ' \t\n ' }).generated).toBe(true);
    for (const bad of ['short', 'abc123def456ghi', `${TOKEN} ${TOKEN}`, 'abc123def456ghi7\n89012345678']) {
      expect(() => resolveToken({ WIREBENCH_MCP_TOKEN: bad })).toThrow(InvalidTokenError);
    }
    expect(() => resolveToken({ WIREBENCH_MCP_TOKEN: ' short ' })).toThrow(
      'WIREBENCH_MCP_TOKEN must be at least 16 characters with no spaces',
    );
    expect(resolveToken({ WIREBENCH_MCP_TOKEN: 'abc123def456ghi7' }).generated).toBe(false);
  });
});
