import { createGzip, gunzipSync } from 'node:zlib';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { Socket } from 'node:net';
import type { TLSSocket } from 'node:tls';
import { readPublicFixture } from './fixtures.js';

/** One request recorded by the test SOAP server, for assertions. */
export interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: Buffer;
}

/**
 * Serves every route over TLS instead of plain HTTP. `cert`/`key` are PEM strings
 * (see `test-certs.ts`); `ca` plus `requestCert` turns on optional client-certificate
 * verification, and `maxVersion` caps the protocol so a client `minVersion` can be
 * tested against a server that cannot meet it.
 */
export interface TestSoapServerTls {
  readonly cert: string;
  readonly key: string;
  readonly ca?: string | readonly string[];
  readonly requestCert?: boolean;
  readonly maxVersion?: 'TLSv1.2' | 'TLSv1.3';
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

/**
 * If `requestBody` is a `tem:Add` SOAP 1.1/1.2 envelope (the `calculator` fixture's only
 * operation with a meaningful responder here), returns a proper `AddResponse` envelope with
 * `AddResult` computed from `intA`/`intB`. Returns `undefined` for anything else, so the
 * caller falls back to the plain echo behaviour the rest of the test suite depends on.
 */
function buildCalculatorAddResponse(requestBody: string): string | undefined {
  const addMatch = /<(?:\w+:)?Add[ >]/.exec(requestBody);
  if (addMatch === null) {
    return undefined;
  }
  const intAMatch = /<(?:\w+:)?intA>([^<]*)<\/(?:\w+:)?intA>/.exec(requestBody);
  const intBMatch = /<(?:\w+:)?intB>([^<]*)<\/(?:\w+:)?intB>/.exec(requestBody);
  if (intAMatch?.[1] === undefined || intBMatch?.[1] === undefined) {
    return undefined;
  }
  // The request editor's default draft uses the SoapUI-style `?` placeholder for untouched
  // leaves (see `sampleValueFor` in the engine's xsd/sample-values.ts) rather than a real
  // number, so unparseable operands are treated as 0 instead of falling back to an echo.
  const toOperand = (text: string): number => {
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const sum = toOperand(intAMatch[1]) + toOperand(intBMatch[1]);
  const isSoap12 = requestBody.includes('http://www.w3.org/2003/05/soap-envelope');
  const envelopeNs = isSoap12 ? 'http://www.w3.org/2003/05/soap-envelope' : 'http://schemas.xmlsoap.org/soap/envelope/';

  return `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="${envelopeNs}" xmlns:tem="http://tempuri.org/">
  <soapenv:Body>
    <tem:AddResponse>
      <tem:AddResult>${sum}</tem:AddResult>
    </tem:AddResponse>
  </soapenv:Body>
</soapenv:Envelope>`;
}

/**
 * Reads the request body, transparently gunzipping it when the client announced
 * `Content-Encoding: gzip` — so a spec asserting on what the server received sees the
 * envelope, not the compressed bytes. A body that claims gzip but is not is left as-is.
 */
async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks);
  if ((req.headers['content-encoding'] ?? '').toLowerCase().includes('gzip') && raw.length > 0) {
    try {
      return gunzipSync(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

/**
 * Starts a minimal in-process SOAP server for integration tests, bound to
 * `127.0.0.1` on an ephemeral port. Every route is documented in Task 10's
 * brief; this is transport-fixture-only (no real SOAP semantics beyond
 * echoing bytes back).
 */
export async function startTestSoapServer(options?: {
  readonly fixture?: string;
  readonly respondToCalculatorAdd?: boolean;
  /** Serve over HTTPS with these credentials instead of plain HTTP. */
  readonly tls?: TestSoapServerTls;
}): Promise<TestSoapServer> {
  const requests: RecordedRequest[] = [];
  const sockets = new Set<Socket>();

  const listener = (req: IncomingMessage, res: ServerResponse): void => {
    void handle(req, res).catch((err: unknown) => {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(err));
    });
  };

  const tls = options?.tls;
  const server: Server =
    tls === undefined
      ? createServer(listener)
      : createHttpsServer(
          {
            cert: tls.cert,
            key: tls.key,
            ...(tls.ca !== undefined ? { ca: typeof tls.ca === 'string' ? tls.ca : [...tls.ca] } : {}),
            ...(tls.requestCert === true ? { requestCert: true, rejectUnauthorized: false } : {}),
            ...(tls.maxVersion !== undefined ? { maxVersion: tls.maxVersion } : {}),
          },
          listener,
        );

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
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
      const fixtureName = options?.fixture ?? 'calculator';
      if (fixtureName === 'calculator' && options?.respondToCalculatorAdd === true) {
        const addResponse = buildCalculatorAddResponse(body.toString('utf-8'));
        if (addResponse !== undefined) {
          res.writeHead(200, { 'content-type': req.headers['content-type'] ?? 'text/xml' });
          res.end(addResponse);
          return;
        }
      }
      res.writeHead(200, { 'content-type': req.headers['content-type'] ?? 'text/xml' });
      res.end(body);
      return;
    }

    if (method === 'POST' && url.pathname === '/latin1') {
      res.writeHead(200, { 'content-type': 'text/xml; charset=ISO-8859-1' });
      res.end(Buffer.concat([Buffer.from('<root>', 'ascii'), Buffer.from([0xe9]), Buffer.from('</root>', 'ascii')]));
      return;
    }

    if (method === 'POST' && url.pathname === '/bad-charset') {
      res.writeHead(200, { 'content-type': 'text/xml; charset=x-unknown' });
      res.end(body.length > 0 ? body : Buffer.from('<root/>'));
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

    if (url.pathname === '/redirect-cross') {
      // Same server, different origin string (localhost vs 127.0.0.1): used to
      // verify credential headers are dropped across an origin change.
      res.writeHead(307, { location: `http://localhost:${new URL(baseUrl).port}/headers` });
      res.end();
      return;
    }

    if (url.pathname === '/bad-gzip') {
      res.writeHead(200, { 'content-type': 'text/xml', 'content-encoding': 'gzip' });
      res.end(Buffer.from([0x1f, 0x8b, 0x00, 0x00, 0xff, 0xff, 0xff]));
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

    if (url.pathname === '/tls-info') {
      const socket = req.socket as TLSSocket;
      const peer = typeof socket.getPeerCertificate === 'function' ? socket.getPeerCertificate() : undefined;
      const commonName = peer?.subject?.CN;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          peerAuthorized: socket.authorized === true,
          ...(typeof commonName === 'string' ? { peerCN: commonName } : {}),
        }),
      );
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
  const baseUrl = `${tls === undefined ? 'http' : 'https'}://127.0.0.1:${address.port}`;

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
