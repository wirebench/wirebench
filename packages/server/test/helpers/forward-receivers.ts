/**
 * Local receivers for the audit forward sinks (issue #209): a syslog listener over TCP or TLS that
 * splits RFC 6587 octet-counted frames, and an HTTP(S) listener that records each request. Each
 * listens on 127.0.0.1 with an OS-assigned port.
 */
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createServer as createNetServer, type Server, type Socket } from 'node:net';
import { createServer as createTlsServer } from 'node:tls';

export interface TlsIdentity {
  readonly certPem: string;
  readonly keyPem: string;
}

/** Splits octet-counted frames out of `buffer`; returns the messages and the unconsumed rest. */
export function splitFrames(buffer: Buffer): { messages: string[]; rest: Buffer } {
  const messages: string[] = [];
  let rest = buffer;
  for (;;) {
    const space = rest.indexOf(0x20);
    if (space <= 0) break;
    const length = Number(rest.subarray(0, space).toString('ascii'));
    if (!Number.isInteger(length) || rest.length < space + 1 + length) break;
    messages.push(rest.subarray(space + 1, space + 1 + length).toString('utf8'));
    rest = rest.subarray(space + 1 + length);
  }
  return { messages, rest };
}

export interface SyslogReceiver {
  readonly port: number;
  /** Every complete message received, across connections, in arrival order. */
  readonly messages: string[];
  /** Every accepted connection, in order. */
  readonly sockets: Socket[];
  /** Resolves once at least `n` messages have arrived. */
  received(n: number): Promise<void>;
  close(): Promise<void>;
}

function listen(server: Server, port = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address !== null ? address.port : 0);
    });
  });
}

function closeServer(server: Server, sockets: readonly Socket[]): Promise<void> {
  for (const socket of sockets) socket.destroy();
  return new Promise((resolve) => server.close(() => resolve()));
}

/** A syslog listener: plain TCP, or TLS when `tls` is given; on `port`, or one the OS picks. */
export async function syslogReceiver(options: { tls?: TlsIdentity; port?: number } = {}): Promise<SyslogReceiver> {
  const tls = options.tls;
  const messages: string[] = [];
  const sockets: Socket[] = [];
  const waiters: { n: number; resolve: () => void }[] = [];
  const onConnection = (socket: Socket) => {
    sockets.push(socket);
    let pending: Buffer = Buffer.alloc(0);
    socket.on('error', () => undefined);
    socket.on('data', (chunk: Buffer) => {
      const split = splitFrames(Buffer.concat([pending, chunk]));
      pending = split.rest;
      messages.push(...split.messages);
      for (const waiter of waiters.filter((w) => messages.length >= w.n)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    });
  };
  const server =
    tls === undefined
      ? createNetServer(onConnection)
      : createTlsServer({ cert: tls.certPem, key: tls.keyPem }, onConnection);
  const port = await listen(server, options.port);
  return {
    port,
    messages,
    sockets,
    received: (n) =>
      messages.length >= n ? Promise.resolve() : new Promise((resolve) => waiters.push({ n, resolve })),
    close: () => closeServer(server, sockets),
  };
}

/** A TCP listener that accepts connections and never reads or answers: a stalled peer. */
export async function silentListener(): Promise<{ port: number; sockets: Socket[]; close(): Promise<void> }> {
  const sockets: Socket[] = [];
  const server = createNetServer((socket) => {
    sockets.push(socket);
    socket.on('error', () => undefined);
    socket.pause();
  });
  const port = await listen(server);
  return { port, sockets, close: () => closeServer(server, sockets) };
}

export interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingMessage['headers'];
  readonly body: string;
}

export interface HttpReceiver {
  readonly port: number;
  readonly requests: RecordedRequest[];
  close(): Promise<void>;
}

/**
 * An HTTP listener, or HTTPS when `tls` is given. `answer` writes the response; a handler that never
 * ends it makes the request hang.
 */
export async function httpReceiver(
  answer: (res: ServerResponse, request: RecordedRequest) => void = (res) => res.writeHead(204).end(),
  tls?: TlsIdentity,
): Promise<HttpReceiver> {
  const requests: RecordedRequest[] = [];
  const sockets: Socket[] = [];
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const request = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(request);
      answer(res, request);
    });
  };
  const server =
    tls === undefined ? createHttpServer(handler) : createHttpsServer({ cert: tls.certPem, key: tls.keyPem }, handler);
  server.on('connection', (socket: Socket) => sockets.push(socket));
  server.on('secureConnection', (socket: Socket) => sockets.push(socket));
  const port = await listen(server);
  return { port, requests, close: () => closeServer(server, sockets) };
}
