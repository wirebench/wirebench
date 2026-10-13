/**
 * MCP servers over HTTP for the MCP kind's tests (#79): the SDK's own `McpServer` behind its
 * `StreamableHTTPServerTransport` on a local port, one server per session.
 *
 * `json` picks how the server answers a request: a JSON body, or an event stream. `stateless`
 * gives no session id. `status` answers every `POST` with that plain status instead, as a server
 * that refuses the client would, and `deleteStatus` answers the closing `DELETE` with one. Every
 * request is recorded with its headers and body.
 *
 * `fixtureMcpServer` is shared with the legacy HTTP+SSE helper: the same three tools as the stdio
 * fixture's `sdk` mode.
 *
 * Test-only. Never import this from production code.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { z } from 'zod';

/** An `McpServer` with `echo`, `fail` and `slow` tools. */
export function fixtureMcpServer(): McpServer {
  const server = new McpServer({ name: 'http-fixture', version: '2.0.0' });
  server.registerTool('echo', { description: 'Echoes its text', inputSchema: { text: z.string() } }, ({ text }) => ({
    content: [{ type: 'text', text }],
  }));
  server.registerTool('fail', { description: 'Always fails' }, () => ({
    content: [{ type: 'text', text: 'it went wrong' }],
    isError: true,
  }));
  server.registerTool('slow', { description: 'Answers after a while' }, async () => {
    await new Promise((done) => setTimeout(done, 5_000));
    return { content: [{ type: 'text', text: 'late' }] };
  });
  return server;
}

/** One request the server saw. */
export interface RecordedMcpHttpRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

export interface TestMcpHttpServerOptions {
  /** Answer requests with a JSON body rather than an event stream. */
  readonly json?: boolean;
  /** Give no session id. */
  readonly stateless?: boolean;
  /** Answer every `POST` with this status and a short text body. */
  readonly status?: number;
  /** Answer `DELETE` with this status. */
  readonly deleteStatus?: number;
}

export interface TestMcpHttpServer {
  /** The MCP endpoint, `http://127.0.0.1:<port>/mcp`. */
  readonly url: string;
  readonly requests: readonly RecordedMcpHttpRequest[];
  close(): Promise<void>;
}

export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((done, failed) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => done(Buffer.concat(chunks).toString('utf8')));
    req.on('error', failed);
  });
}

export async function startTestMcpHttpServer(options: TestMcpHttpServerOptions = {}): Promise<TestMcpHttpServer> {
  const requests: RecordedMcpHttpRequest[] = [];
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const all = new Set<StreamableHTTPServerTransport>();

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = await readBody(req);
    requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
    if (req.method === 'POST' && options.status !== undefined) {
      res.writeHead(options.status, { 'content-type': 'text/plain' }).end('refused by the fixture');
      return;
    }
    if (req.method === 'DELETE' && options.deleteStatus !== undefined) {
      res.writeHead(options.deleteStatus).end();
      return;
    }
    const parsed = body === '' ? undefined : (JSON.parse(body) as unknown);
    const given = req.headers['mcp-session-id'];
    let transport = typeof given === 'string' ? sessions.get(given) : undefined;
    if (transport === undefined) {
      if (typeof given === 'string') {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('no such session');
        return;
      }
      const created = new StreamableHTTPServerTransport({
        ...(options.stateless === true ? {} : { sessionIdGenerator: () => randomUUID() }),
        enableJsonResponse: options.json === true,
        onsessioninitialized: (id) => {
          sessions.set(id, created);
        },
      });
      transport = created;
      all.add(created);
      // The SDK's own types disagree under exactOptionalPropertyTypes (`onclose` may be undefined).
      await fixtureMcpServer().connect(created as Transport);
    }
    await transport.handleRequest(req, res, parsed);
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(err instanceof Error ? err.message : String(err));
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    requests,
    async close() {
      await Promise.all([...all].map((t) => t.close().catch(() => undefined)));
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}
