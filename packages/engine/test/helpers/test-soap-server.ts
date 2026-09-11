import { createGzip, gunzipSync } from 'node:zlib';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { Socket } from 'node:net';
import { createSecureServer as createSecureHttp2Server } from 'node:http2';
import { createSecureContext, type SecureContext, type TLSSocket } from 'node:tls';
import { buildMultipartRelated, mediaTypeOf, parseMultipartRelated } from '../../src/soap/mime/multipart.js';
import { readFixtureWsdl } from './fixtures.js';
import { createNtlmAuthenticator } from './ntlm-server.js';
import { secureResponse, type TestWssMode, type TestWssOptions } from './wss-responses.js';

/**
 * The 1x1 PNG the `/mime-fixture` route sends as its single XOP part, so a test can assert
 * on the exact bytes an expanded `xop:Include` must produce.
 */
export const MIME_FIXTURE_PNG = new Uint8Array(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ),
);

/** Content-ID of the `/mime-fixture` PNG part. */
export const MIME_FIXTURE_CID = 'png@wirebench';

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
  /**
   * Distinct cert/key pairs to alternate across TLS handshakes, round-robin, via
   * `SNICallback` — Node invokes it once per handshake even when the servername
   * repeats, so two concurrent sockets to the same origin each end up presenting
   * a different leaf certificate. That lets a test tell, from the response alone,
   * which physical connection an exchange actually landed on. `cert`/`key` above
   * are still required (`https.createServer` needs a default context) but are
   * not served once this is set — every handshake goes through the callback.
   */
  readonly perConnectionCerts?: readonly { readonly cert: string; readonly key: string }[];
  /**
   * ALPN protocols to advertise. Including `h2` switches the server to `http2.createSecureServer`
   * with `allowHTTP1: true`, so the same request listener serves both protocols and a test can
   * check what was actually negotiated rather than what was merely offered.
   */
  readonly alpnProtocols?: readonly string[];
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
 * A well-formed SOAP 1.1 response envelope of roughly `targetBytes` bytes, made of repeated
 * `<Row>` elements. Deterministic: the same target always produces the same bytes, so a spec
 * measuring render or scroll cost over it compares like with like between runs.
 */
export function buildLargeSoapResponse(targetBytes: number): string {
  const head =
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">\n' +
    '  <soapenv:Body>\n    <Rows xmlns="urn:wirebench:perf">\n';
  const tail = '    </Rows>\n  </soapenv:Body>\n</soapenv:Envelope>\n';
  const parts: string[] = [head];
  let size = head.length + tail.length;
  let index = 0;
  while (size < targetBytes) {
    const row = `      <Row id="${index}"><Name>Row ${index}</Name><Value>${(index * 37) % 100000}</Value></Row>\n`;
    parts.push(row);
    size += row.length;
    index += 1;
  }
  parts.push(tail);
  return parts.join('');
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
  /** Key material for the `/wss/*` routes, which sign and encrypt their responses. */
  readonly wss?: TestWssOptions;
}): Promise<TestSoapServer> {
  const requests: RecordedRequest[] = [];
  const sockets = new Set<Socket>();
  const ntlmAuthenticator = createNtlmAuthenticator({ username: 'user', password: 'pass', domain: 'WORKGROUP' });

  const listener = (req: IncomingMessage, res: ServerResponse): void => {
    // Stamped the moment the request reaches the handler, so `/soap` can report how much of a
    // client-side round trip was the server's own doing — see `x-server-ms` below.
    const receivedAt = performance.now();
    void handle(req, res, receivedAt).catch((err: unknown) => {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(err));
    });
  };

  const tls = options?.tls;
  // Round-robins `perConnectionCerts` across handshakes; a plain counter is enough because
  // `SNICallback` runs synchronously on the (single-threaded) server, one call per handshake.
  let perConnectionIndex = 0;
  const perConnectionCerts = tls?.perConnectionCerts;
  const tlsCa = tls?.ca;
  const sniCallback =
    perConnectionCerts !== undefined
      ? (_servername: string, cb: (err: Error | null, ctx?: SecureContext) => void): void => {
          const pick = perConnectionCerts[perConnectionIndex % perConnectionCerts.length];
          perConnectionIndex += 1;
          cb(
            null,
            createSecureContext({
              cert: pick?.cert,
              key: pick?.key,
              ...(tlsCa !== undefined ? { ca: typeof tlsCa === 'string' ? tlsCa : [...tlsCa] } : {}),
            }),
          );
        }
      : undefined;
  const tlsOptions =
    tls === undefined
      ? undefined
      : {
          cert: tls.cert,
          key: tls.key,
          ...(tls.ca !== undefined ? { ca: typeof tls.ca === 'string' ? tls.ca : [...tls.ca] } : {}),
          ...(tls.requestCert === true ? { requestCert: true, rejectUnauthorized: false } : {}),
          ...(tls.maxVersion !== undefined ? { maxVersion: tls.maxVersion } : {}),
          ...(sniCallback !== undefined ? { SNICallback: sniCallback } : {}),
          ...(tls.alpnProtocols !== undefined ? { ALPNProtocols: [...tls.alpnProtocols] } : {}),
        };
  const wantsH2 = tls?.alpnProtocols?.includes('h2') === true;
  const server: Server =
    tlsOptions === undefined
      ? createServer(listener)
      : wantsH2
        ? // The compat layer hands the listener `Http2ServerRequest`/`Http2ServerResponse`, which are
          // structurally close enough for everything this fixture reads but not assignable; the cast
          // is the usual price of serving both protocols from one handler.
          (createSecureHttp2Server(
            { ...tlsOptions, allowHTTP1: true },
            listener as unknown as Parameters<typeof createSecureHttp2Server>[1],
          ) as unknown as Server)
        : createHttpsServer(tlsOptions, listener);

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  async function handle(req: IncomingMessage, res: ServerResponse, receivedAt: number): Promise<void> {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const body = await readBody(req);

    if (url.pathname !== '/timeout') {
      requests.push({ method, url: req.url ?? '/', headers: req.headers, body });
    }

    if (method === 'GET' && url.pathname === '/service') {
      const fixtureName = options?.fixture ?? 'calculator';
      const wsdl = readFixtureWsdl(fixtureName).replace(/location="[^"]*"/g, `location="${baseUrl}/soap"`);
      res.writeHead(200, { 'content-type': 'text/xml' });
      res.end(wsdl);
      return;
    }

    // The `/wss/*` family: an ordinary SOAP response, secured with the server's own keys, so a
    // client's *incoming* configuration has something real to decrypt and verify.
    const wssMatch = /^\/wss\/(sign|encrypt|sign-encrypt|tampered|untrusted)$/.exec(url.pathname);
    if (method === 'POST' && wssMatch !== null) {
      const wssOptions = options?.wss;
      if (wssOptions === undefined) {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('this server was started without wss key material');
        return;
      }
      const requestText = body.toString('utf-8');
      const envelope = buildCalculatorAddResponse(requestText) ?? requestText;
      const secured = await secureResponse(envelope, wssMatch[1] as TestWssMode, wssOptions);
      res.writeHead(200, { 'content-type': 'text/xml; charset=UTF-8' });
      res.end(secured);
      return;
    }

    if (method === 'POST' && url.pathname === '/soap') {
      const fixtureName = options?.fixture ?? 'calculator';
      // How long this server itself spent on the request (arrival of the request through to the
      // response being written). The send-overhead budget subtracts it from the client's
      // wall-clock time, so the number it gates on is Wirebench's own cost rather than however
      // fast this fixture — or the loopback interface — happens to be on the machine running it.
      const serverMs = (): string => (performance.now() - receivedAt).toFixed(3);
      if (fixtureName === 'calculator' && options?.respondToCalculatorAdd === true) {
        const addResponse = buildCalculatorAddResponse(body.toString('utf-8'));
        if (addResponse !== undefined) {
          res.writeHead(200, { 'content-type': req.headers['content-type'] ?? 'text/xml', 'x-server-ms': serverMs() });
          res.end(addResponse);
          return;
        }
      }
      res.writeHead(200, { 'content-type': req.headers['content-type'] ?? 'text/xml', 'x-server-ms': serverMs() });
      res.end(body);
      return;
    }

    // Echoes a multipart request: every part comes back byte for byte with its own
    // Content-ID and type, and the response envelope describes what arrived. An MTOM
    // request (an `application/xop+xml` root part) is answered with an MTOM package.
    if (method === 'POST' && url.pathname === '/mime') {
      const requestContentType = req.headers['content-type'] ?? '';
      if (!mediaTypeOf(requestContentType).toLowerCase().startsWith('multipart/')) {
        res.writeHead(200, { 'content-type': requestContentType.length > 0 ? requestContentType : 'text/xml' });
        res.end(body);
        return;
      }
      const parsed = parseMultipartRelated(body, requestContentType);
      const mtom = mediaTypeOf(parsed.root.contentType).toLowerCase() === 'application/xop+xml';
      const parts = parsed.parts
        .map((part) => `<part cid="${part.contentId ?? ''}" size="${part.bytes.length}"/>`)
        .join('');
      const envelope = `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Body>
    <UploadResponse rootLength="${parsed.root.bytes.length}">${parts}</UploadResponse>
  </soapenv:Body>
</soapenv:Envelope>`;
      const built = buildMultipartRelated({
        root: {
          contentType: mtom ? 'application/xop+xml; charset=UTF-8; type="text/xml"' : 'text/xml; charset=UTF-8',
          contentId: 'response@wirebench',
          bytes: Buffer.from(envelope, 'utf-8'),
        },
        parts: parsed.parts.map((part) => ({
          contentId: part.contentId ?? '',
          contentType: part.contentType,
          bytes: part.bytes,
          transferEncoding: 'binary' as const,
          ...(part.fileName !== undefined ? { fileName: part.fileName } : {}),
        })),
        ...(mtom ? { mtom: true } : {}),
      });
      res.writeHead(200, { 'content-type': built.contentType });
      res.end(Buffer.from(built.body));
      return;
    }

    // A fixed MTOM response whose envelope references a PNG through xop:Include, for the
    // expand/inline options. Answers any method so a normal POST send reaches it too.
    if (url.pathname === '/mime-fixture') {
      const envelope = `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Body>
    <GetImageResponse xmlns="urn:img">
      <image><xop:Include href="cid:${MIME_FIXTURE_CID}" xmlns:xop="http://www.w3.org/2004/08/xop/include"/></image>
    </GetImageResponse>
  </soapenv:Body>
</soapenv:Envelope>`;
      const built = buildMultipartRelated({
        root: {
          contentType: 'application/xop+xml; charset=UTF-8; type="text/xml"',
          contentId: 'fixture-root@wirebench',
          bytes: Buffer.from(envelope, 'utf-8'),
        },
        parts: [
          {
            contentId: MIME_FIXTURE_CID,
            contentType: 'image/png',
            bytes: MIME_FIXTURE_PNG,
            transferEncoding: 'binary',
            fileName: 'pixel.png',
          },
        ],
        boundary: 'MIMEFIXTUREBOUNDARY',
        mtom: true,
      });
      res.writeHead(200, { 'content-type': built.contentType });
      res.end(Buffer.from(built.body));
      return;
    }

    // NTLM route: the full three-leg handshake against user/pass in WORKGROUP. NTLM state is
    // per-connection, so `ntlmAuthenticator` keys its challenge off `req.socket`.
    if (method === 'POST' && url.pathname === '/auth/ntlm') {
      if (ntlmAuthenticator.handle(req, res) !== 'authenticated') {
        return;
      }
      const contentType = req.headers['content-type'] ?? 'text/xml';
      if ((options?.fixture ?? 'calculator') === 'calculator' && options?.respondToCalculatorAdd === true) {
        const addResponse = buildCalculatorAddResponse(body.toString('utf-8'));
        if (addResponse !== undefined) {
          res.writeHead(200, { 'content-type': contentType, 'x-auth-scheme': 'ntlm' });
          res.end(addResponse);
          return;
        }
      }
      res.writeHead(200, { 'content-type': contentType, 'x-auth-scheme': 'ntlm' });
      res.end(body);
      return;
    }

    // Basic-auth routes: `/auth/basic` challenges with `WWW-Authenticate`, `/auth/basic-nochallenge`
    // answers 401 without one so a client must not retry.
    if (method === 'POST' && (url.pathname === '/auth/basic' || url.pathname === '/auth/basic-nochallenge')) {
      const expected = `Basic ${Buffer.from('user:pass', 'utf-8').toString('base64')}`;
      if (req.headers.authorization !== expected) {
        res.writeHead(401, {
          'content-type': 'text/plain',
          ...(url.pathname === '/auth/basic' ? { 'www-authenticate': 'Basic realm="wirebench"' } : {}),
        });
        res.end('Unauthorized');
        return;
      }
      const contentType = req.headers['content-type'] ?? 'text/xml';
      if ((options?.fixture ?? 'calculator') === 'calculator' && options?.respondToCalculatorAdd === true) {
        const addResponse = buildCalculatorAddResponse(body.toString('utf-8'));
        if (addResponse !== undefined) {
          res.writeHead(200, { 'content-type': contentType, 'x-auth-scheme': 'basic' });
          res.end(addResponse);
          return;
        }
      }
      res.writeHead(200, { 'content-type': contentType, 'x-auth-scheme': 'basic' });
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

    const bigSoapMatch = /^\/big-soap\/(\d+)$/.exec(url.pathname);
    if (method === 'POST' && bigSoapMatch !== null) {
      // `/big/<n>` above is `n` MB of opaque bytes, which the app renders as a non-SOAP body.
      // This is its SOAP counterpart: a well-formed envelope of roughly `n` MB, so the response
      // pane puts it in the XML editor, the Outline and the Query view — what the e2e
      // performance budgets need something large to measure.
      res.writeHead(200, { 'content-type': 'text/xml; charset=utf-8' });
      res.end(buildLargeSoapResponse(Number(bigSoapMatch[1]) * 1024 * 1024));
      return;
    }

    if (url.pathname === '/tls-info') {
      const socket = req.socket as TLSSocket;
      const peer = typeof socket.getPeerCertificate === 'function' ? socket.getPeerCertificate() : undefined;
      const commonName = peer?.subject?.CN;
      // The server's own (local) certificate for *this specific* connection — with
      // `perConnectionCerts`, different sockets to the same origin get a different one,
      // which is how the concurrency test tells its two exchanges apart.
      const local = typeof socket.getCertificate === 'function' ? socket.getCertificate() : undefined;
      const serverFingerprint =
        local !== null && local !== undefined && 'fingerprint256' in local
          ? (local as { fingerprint256?: string }).fingerprint256
          : undefined;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          peerAuthorized: socket.authorized === true,
          ...(typeof commonName === 'string' ? { peerCN: commonName } : {}),
          ...(typeof serverFingerprint === 'string' ? { serverFingerprint } : {}),
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
