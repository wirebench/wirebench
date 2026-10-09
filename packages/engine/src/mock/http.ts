/**
 * The listening side the mock server and the recording proxy share (spec §Running a mock): the
 * loopback `Host` check, request parsing, the body cap, writing a reply, the log's masking and cut,
 * and listening with the mock's start errors. Internal to `mock/`; the barrel does not export it.
 */

import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { WirebenchError } from '../errors.js';
import { redactUrl } from '../redact/index.js';
import type { HeaderPair } from '../script/model.js';
import type { MockReply } from './contract.js';

/** The largest request body a mock reads; larger is refused with 413. */
export const MOCK_REQUEST_BODY_BYTES = 10 * 1024 * 1024;
/** How long a client has to send the headers, and the whole request. */
export const MOCK_REQUEST_TIMEOUT_MS = 30_000;
/** How much of each body a log event carries. */
export const MOCK_EVENT_BODY_BYTES = 64 * 1024;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function hostnameOf(hostHeader: string | undefined): string | undefined {
  if (hostHeader === undefined) return undefined;
  const value = hostHeader.trim().toLowerCase();
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    return end === -1 ? undefined : value.slice(0, end + 1);
  }
  const colon = value.indexOf(':');
  return colon === -1 ? value : value.slice(0, colon);
}

export function isLoopback(host: string): boolean {
  return LOOPBACK_HOSTS.has(host) || /^127\.\d+\.\d+\.\d+$/.test(host);
}

export function urlHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

export function headerPairs(req: IncomingMessage): HeaderPair[] {
  const pairs: HeaderPair[] = [];
  for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
    pairs.push([req.rawHeaders[i] ?? '', req.rawHeaders[i + 1] ?? '']);
  }
  return pairs;
}

export function queryOf(search: URLSearchParams): Record<string, string[]> {
  const query = Object.create(null) as Record<string, string[]>;
  for (const [name, value] of search) {
    (query[name] ??= []).push(value);
  }
  return query;
}

/** Path and query with sensitive query values masked; `redactUrl` wants an absolute URL. */
export function maskedUrl(pathAndQuery: string): string {
  const origin = 'http://mock.invalid/';
  const masked = redactUrl(`${origin}${pathAndQuery.startsWith('/') ? pathAndQuery.slice(1) : pathAndQuery}`);
  return masked.startsWith(origin) ? masked.slice(origin.length - 1) : masked;
}

export function cut(text: string): { body: string; truncated: boolean } {
  const bytes = Buffer.from(text, 'utf8');
  return bytes.byteLength <= MOCK_EVENT_BODY_BYTES
    ? { body: text, truncated: false }
    : { body: bytes.subarray(0, MOCK_EVENT_BODY_BYTES).toString('utf8'), truncated: true };
}

/** Writes `reply`, grouping repeated header names; a string body is sent as UTF-8. */
export function write(
  res: ServerResponse,
  reply: Omit<MockReply, 'body'> & { readonly body: string | Uint8Array },
): void {
  const grouped = new Map<string, { name: string; values: string[] }>();
  for (const [name, value] of reply.headers) {
    const key = name.toLowerCase();
    const entry = grouped.get(key) ?? { name, values: [] };
    entry.values.push(value);
    grouped.set(key, entry);
  }
  for (const { name, values } of grouped.values()) {
    res.setHeader(name, values.length === 1 ? (values[0] as string) : values);
  }
  const body = typeof reply.body === 'string' ? Buffer.from(reply.body, 'utf8') : reply.body;
  res.setHeader('Content-Length', String(body.byteLength));
  res.writeHead(reply.status);
  res.end(body);
}

export function plain(status: number, text: string): MockReply {
  return { status, headers: [['Content-Type', 'text/plain; charset=utf-8']], body: `${text}\n` };
}

/** Reads the body, or `undefined` once it passes the cap. */
export function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (chunk: Buffer) => {
      if (over) return;
      size += chunk.byteLength;
      if (size > MOCK_REQUEST_BODY_BYTES) {
        over = true;
        chunks.length = 0;
        resolve(undefined);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!over) resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

export interface Listening {
  readonly port: number;
  /** Stops listening and destroys every open connection. */
  close(): Promise<void>;
}

/**
 * Listens on `host:port`, tracking connections so `close` can end keep-alive ones too.
 *
 * @param what names the listener in the error message ("mock", "recorder")
 * @throws WirebenchError `mock-port-in-use`, `mock-listen-failed`
 */
export async function listen(server: Server, host: string, port: number, what: string): Promise<Listening> {
  const sockets = new Set<Socket>();
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  const bound = await new Promise<number>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      reject(
        error.code === 'EADDRINUSE'
          ? new WirebenchError('mock-port-in-use', `Port ${String(port)} is already in use`, { details: { port } })
          : new WirebenchError('mock-listen-failed', `The ${what} could not listen on ${host}: ${error.message}`, {
              details: { host, reason: error.code ?? error.message },
            }),
      );
    };
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      const address = server.address();
      resolve(typeof address === 'object' && address !== null ? address.port : 0);
    });
  });
  let closing: Promise<void> | undefined;
  return {
    port: bound,
    close: () => {
      closing ??= new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
      });
      return closing;
    },
  };
}
