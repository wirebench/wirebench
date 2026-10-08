import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

export interface NegotiateRecord {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | undefined;
  readonly body: string;
  readonly socket: number;
}

export interface NegotiateServer {
  readonly url: string;
  readonly requests: NegotiateRecord[];
  /** Requests answered with the `redirect` option's redirect, which `requests` leaves out. */
  readonly redirected: NegotiateRecord[];
  sameSocket(): boolean;
  close(): Promise<void>;
}

/**
 * Answers 401 `WWW-Authenticate: Negotiate` (or `challenge`) to a request without
 * `Authorization: Negotiate <expectedToken>`, and 200, with an optional mutual-auth reply, to one with it.
 * With `redirect`, a request to `redirect.from` is first redirected to `/svc` on the same server.
 */
export async function startNegotiateServer(options: {
  readonly expectedToken: string;
  readonly challenge?: string;
  readonly reply?: string;
  readonly rejectToken?: boolean;
  readonly redirect?: { readonly from: string; readonly status: 302 | 307 };
}): Promise<NegotiateServer> {
  const requests: NegotiateRecord[] = [];
  const redirected: NegotiateRecord[] = [];
  const sockets = new WeakMap<Socket, number>();
  let nextSocket = 0;
  const server = createServer((request: IncomingMessage, response) => {
    let socketId = sockets.get(request.socket);
    if (socketId === undefined) {
      socketId = nextSocket++;
      sockets.set(request.socket, socketId);
    }
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const authorization = request.headers.authorization;
      const record = {
        method: request.method ?? '',
        path: request.url ?? '',
        authorization,
        body: Buffer.concat(chunks).toString(),
        socket: socketId,
      };
      if (options.redirect !== undefined && request.url === options.redirect.from) {
        redirected.push(record);
        response.writeHead(options.redirect.status, { Location: '/svc', 'Content-Length': '0' });
        response.end();
        return;
      }
      requests.push(record);
      const ok = authorization === `Negotiate ${options.expectedToken}` && options.rejectToken !== true;
      if (!ok) {
        response.writeHead(401, { 'WWW-Authenticate': options.challenge ?? 'Negotiate', 'Content-Length': '0' });
        response.end();
        return;
      }
      response.writeHead(200, {
        'Content-Type': 'text/plain',
        ...(options.reply !== undefined ? { 'WWW-Authenticate': `Negotiate ${options.reply}` } : {}),
      });
      response.end('ok');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/svc`,
    requests,
    redirected,
    sameSocket: () => new Set(requests.map((entry) => entry.socket)).size === 1,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
