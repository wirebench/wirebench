/**
 * An in-process HTTP forward proxy for integration tests: plain absolute-form forwarding for
 * `http://` targets and `CONNECT` tunnelling for `https://` ones, with optional
 * `Proxy-Authorization: Basic` enforcement and a record of everything it was asked to reach.
 *
 * It exists so "did this request actually go through the proxy?" is answerable from the test
 * rather than inferred, and so the NTLM-through-proxy case (which needs one socket to carry
 * all three legs, i.e. a real tunnel) can be exercised at all.
 *
 * Test-only. Never import this from production code.
 */

import { connect, type Socket } from 'node:net';
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';

/** One thing the proxy was asked to reach. */
export interface ProxiedRequest {
  /** `CONNECT` for a tunnel, otherwise the forwarded request's method. */
  readonly method: string;
  /** The absolute-form URL for a forward, or `host:port` for a `CONNECT`. */
  readonly target: string;
  /** The `Proxy-Authorization` header the client sent, if any. */
  readonly proxyAuthorization?: string;
}

/** A running {@link startTestProxy}. */
export interface TestProxy {
  /** `http://127.0.0.1:<port>` — what a `ProxyOptions.url` points at. */
  readonly url: string;
  readonly port: number;
  /** Everything the proxy has been asked to reach, in order. */
  readonly requests: readonly ProxiedRequest[];
  /** How many CONNECT tunnels were opened. */
  readonly tunnelCount: () => number;
  readonly close: () => Promise<void>;
}

/** Options for {@link startTestProxy}. */
export interface TestProxyOptions {
  /** When set, the proxy answers 407 unless `Proxy-Authorization` carries exactly these credentials. */
  readonly requireAuth?: { readonly username: string; readonly password: string };
}

/** The expected `Proxy-Authorization` value for a username/password pair. */
function basicToken(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

/** Splits `host:port` (or a bracketed IPv6 authority) into its parts, defaulting the port to 443. */
function splitAuthority(authority: string): { host: string; port: number } {
  const lastColon = authority.lastIndexOf(':');
  if (lastColon === -1) return { host: authority, port: 443 };
  return { host: authority.slice(0, lastColon), port: Number(authority.slice(lastColon + 1)) || 443 };
}

/**
 * Starts a forward proxy on an ephemeral port of `127.0.0.1`.
 *
 * @param options optional `Proxy-Authorization` enforcement
 * @returns the running proxy, with its recorded requests and a `close()` that also drops live tunnels
 */
export async function startTestProxy(options?: TestProxyOptions): Promise<TestProxy> {
  const requests: ProxiedRequest[] = [];
  const sockets = new Set<Socket>();
  let tunnels = 0;
  const expected =
    options?.requireAuth === undefined
      ? undefined
      : basicToken(options.requireAuth.username, options.requireAuth.password);

  /** Records the attempt and answers 407 when credentials are required but wrong/absent. */
  function authorized(header: string | undefined): boolean {
    return expected === undefined || header === expected;
  }

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const proxyAuthorization = req.headers['proxy-authorization'];
    requests.push({
      method: req.method ?? 'GET',
      target: req.url ?? '',
      ...(typeof proxyAuthorization === 'string' ? { proxyAuthorization } : {}),
    });
    if (!authorized(typeof proxyAuthorization === 'string' ? proxyAuthorization : undefined)) {
      res.writeHead(407, { 'proxy-authenticate': 'Basic realm="wirebench-test"' });
      res.end('proxy authentication required');
      return;
    }
    let target: URL;
    try {
      target = new URL(req.url ?? '');
    } catch {
      res.writeHead(400);
      res.end('absolute-form URL required');
      return;
    }
    // Hop-by-hop headers must not be forwarded; `proxy-authorization` is the proxy's own.
    const headers = { ...req.headers };
    delete headers['proxy-authorization'];
    delete headers['proxy-connection'];
    const upstream = httpRequest(
      {
        host: target.hostname,
        port: target.port === '' ? 80 : Number(target.port),
        method: req.method ?? 'GET',
        path: `${target.pathname}${target.search}`,
        headers,
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end('upstream failed');
    });
    req.pipe(upstream);
  });

  server.on('connect', (req: IncomingMessage, clientSocket: Socket, head: Buffer) => {
    const proxyAuthorization = req.headers['proxy-authorization'];
    requests.push({
      method: 'CONNECT',
      target: req.url ?? '',
      ...(typeof proxyAuthorization === 'string' ? { proxyAuthorization } : {}),
    });
    sockets.add(clientSocket);
    clientSocket.on('close', () => sockets.delete(clientSocket));
    clientSocket.on('error', () => undefined);
    if (!authorized(typeof proxyAuthorization === 'string' ? proxyAuthorization : undefined)) {
      clientSocket.end(
        'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="wirebench-test"\r\n\r\n',
      );
      return;
    }
    const { host, port } = splitAuthority(req.url ?? '');
    const upstream = connect(port, host, () => {
      tunnels += 1;
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    sockets.add(upstream);
    upstream.on('close', () => sockets.delete(upstream));
    upstream.on('error', () => {
      clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    });
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    requests,
    tunnelCount: () => tunnels,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
