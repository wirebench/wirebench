/**
 * A legacy HTTP+SSE MCP server for the MCP kind's tests (#79): the SDK's `McpServer` behind its
 * `SSEServerTransport` on a local port. `GET /sse` opens a session's stream, whose `endpoint` event
 * names `/messages?sessionId=…`; `POST`s there are acknowledged and answered on the stream.
 *
 * Two modes misbehave by hand, which the SDK's transport will not do: `endpoint` names that URL in
 * the `endpoint` event instead (and keeps the stream open), and `closeBeforeEndpoint` ends the
 * stream before naming one. Every request is recorded with its headers and body.
 *
 * Test-only. Never import this from production code.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { fixtureMcpServer, readBody, type RecordedMcpHttpRequest } from './mcp-http-server.js';

export interface TestMcpSseServerOptions {
  /** Name this URL in the `endpoint` event, and answer nothing. */
  readonly endpoint?: string;
  /** End the stream before the `endpoint` event. */
  readonly closeBeforeEndpoint?: boolean;
}

export interface TestMcpSseServer {
  /** The event-stream URL, `http://127.0.0.1:<port>/sse`. */
  readonly url: string;
  readonly requests: readonly RecordedMcpHttpRequest[];
  /** How many event streams are open now. */
  readonly openStreams: number;
  close(): Promise<void>;
}

export async function startTestMcpSseServer(options: TestMcpSseServerOptions = {}): Promise<TestMcpSseServer> {
  const requests: RecordedMcpHttpRequest[] = [];
  const sessions = new Map<string, SSEServerTransport>();
  let openStreams = 0;

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = await readBody(req);
    requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
    const url = new URL(req.url ?? '/', 'http://fixture');
    if (req.method === 'GET' && url.pathname === '/sse') {
      openStreams += 1;
      res.on('close', () => {
        openStreams -= 1;
      });
      if (options.closeBeforeEndpoint === true) {
        res.writeHead(200, { 'content-type': 'text/event-stream' }).end(': going away\n\n');
        return;
      }
      if (options.endpoint !== undefined) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`event: endpoint\ndata: ${options.endpoint}\n\n`);
        return;
      }
      const transport = new SSEServerTransport('/messages', res);
      sessions.set(transport.sessionId, transport);
      res.on('close', () => sessions.delete(transport.sessionId));
      await fixtureMcpServer().connect(transport);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/messages') {
      const transport = sessions.get(url.searchParams.get('sessionId') ?? '');
      if (transport === undefined) {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('no such session');
        return;
      }
      await transport.handlePostMessage(req, res, body === '' ? undefined : (JSON.parse(body) as unknown));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
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
    url: `http://127.0.0.1:${port}/sse`,
    requests,
    get openStreams() {
      return openStreams;
    },
    async close() {
      await Promise.all([...sessions.values()].map((t) => t.close().catch(() => undefined)));
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}
