import { createGzip } from 'node:zlib';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { readPublicFixture } from './fixtures.js';

/** One request recorded by the test SOAP server, for assertions. */
export interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: Buffer;
}

/** Handle to a running {@link startTestSoapServer} instance. */
export interface TestSoapServer {
  readonly url: string;
  readonly wsdlUrl: string;
  readonly requests: RecordedRequest[];
  close(): Promise<void>;
}

const SOAP_FAULT = `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Body>
    <soapenv:Fault>
      <faultcode>soapenv:Server</faultcode>
      <faultstring>Simulated fault</faultstring>
      <detail><code>42</code></detail>
    </soapenv:Fault>
  </soapenv:Body>
</soapenv:Envelope>`;

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/**
 * Starts a minimal in-process SOAP server for integration tests, bound to
 * `127.0.0.1` on an ephemeral port. Every route is documented in Task 10's
 * brief; this is transport-fixture-only (no real SOAP semantics beyond
 * echoing bytes back).
 */
export async function startTestSoapServer(options?: { readonly fixture?: string }): Promise<TestSoapServer> {
  const requests: RecordedRequest[] = [];
  const sockets = new Set<Socket>();

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(err));
    });
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', `http://127.0.0.1`);
    const body = await readBody(req);

    if (url.pathname !== '/timeout') {
      requests.push({ method, url: req.url ?? '/', headers: req.headers, body });
    }

    if (method === 'GET' && url.pathname === '/service') {
      const fixtureName = options?.fixture ?? 'calculator';
      const wsdl = readPublicFixture(fixtureName).replace(/location="[^"]*"/g, `location="${baseUrl}/soap"`);
      res.writeHead(200, { 'content-type': 'text/xml' });
      res.end(wsdl);
      return;
    }

    if (method === 'POST' && url.pathname === '/soap') {
      res.writeHead(200, { 'content-type': req.headers['content-type'] ?? 'text/xml' });
      res.end(body);
      return;
    }

    if (method === 'POST' && url.pathname === '/fault') {
      res.writeHead(500, { 'content-type': 'text/xml' });
      res.end(SOAP_FAULT);
      return;
    }

    const delayMatch = /^\/delay\/(\d+)$/.exec(url.pathname);
    if (method === 'POST' && delayMatch !== null) {
      const ms = Number(delayMatch[1]);
      await new Promise((resolve) => setTimeout(resolve, ms));
      res.writeHead(200, { 'content-type': req.headers['content-type'] ?? 'text/xml' });
      res.end(body);
      return;
    }

    if (method === 'POST' && url.pathname === '/gzip') {
      res.writeHead(200, { 'content-type': 'text/xml', 'content-encoding': 'gzip' });
      const gzip = createGzip();
      gzip.pipe(res);
      gzip.end(body);
      return;
    }

    if (method === 'POST' && url.pathname === '/redirect') {
      res.writeHead(307, { location: `${baseUrl}/soap` });
      res.end();
      return;
    }

    if (url.pathname === '/redirect-get') {
      res.writeHead(302, { location: `${baseUrl}/headers` });
      res.end();
      return;
    }

    if (url.pathname === '/loop') {
      res.writeHead(302, { location: `${baseUrl}/loop` });
      res.end();
      return;
    }

    const bigMatch = /^\/big\/(\d+)$/.exec(url.pathname);
    if (method === 'POST' && bigMatch !== null) {
      const mb = Number(bigMatch[1]);
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      const chunk = Buffer.alloc(1024 * 1024, 'x');
      for (let i = 0; i < mb; i++) {
        if (!res.write(chunk)) await new Promise((resolve) => res.once('drain', resolve));
      }
      res.end();
      return;
    }

    if (url.pathname === '/headers') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(req.headers));
      return;
    }

    const statusMatch = /^\/status\/(\d+)$/.exec(url.pathname);
    if (method === 'POST' && statusMatch !== null) {
      res.writeHead(Number(statusMatch[1]), { 'content-type': 'text/plain' });
      res.end('status');
      return;
    }

    if (method === 'GET' && url.pathname === '/timeout') {
      // Intentionally never responds; the test's client-side timeout is what ends this.
      return;
    }

    res.writeHead(404);
    res.end();
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('failed to bind test SOAP server');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    url: baseUrl,
    wsdlUrl: `${baseUrl}/service?wsdl`,
    requests,
    async close(): Promise<void> {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    },
  };
}
