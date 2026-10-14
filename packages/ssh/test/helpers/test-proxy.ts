import net from 'node:net';
import type { AddressInfo, Socket } from 'node:net';

/** What a client asked the proxy for. */
export interface ProxyRequest {
  readonly host: string;
  readonly port: number;
  /** The user and password the client signed in with, if any. */
  readonly login?: { readonly user: string; readonly password: string };
}

export interface TestProxy {
  readonly port: number;
  readonly requests: ProxyRequest[];
  close(): Promise<void>;
}

export interface TestProxyOptions {
  readonly type: 'socks5' | 'http';
  /** Wanted from the client; anything else is refused. */
  readonly login?: { readonly user: string; readonly password: string };
  /** Refuse every tunnel: SOCKS5 reply 5 (connection refused), HTTP 403. */
  readonly refuse?: boolean;
  /** HTTP only: hold the 200 back until the target's first bytes, then send both in one write. */
  readonly coalesce?: boolean;
}

/** A name only the proxy's side of the network resolves (to 127.0.0.1). */
export const PROXY_ONLY_NAME = 'only-the-proxy-knows';

/** Reads from a socket by exact byte counts or up to a blank line. */
function readerOf(socket: Socket) {
  let buffer = Buffer.alloc(0);
  let wake: (() => void) | undefined;
  socket.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    wake?.();
  });
  const until = async (test: () => boolean): Promise<void> => {
    while (!test()) await new Promise<void>((resolve) => (wake = resolve));
  };
  return {
    async take(count: number): Promise<Buffer> {
      await until(() => buffer.length >= count);
      const out = buffer.subarray(0, count);
      buffer = buffer.subarray(count);
      return out;
    },
    async head(): Promise<string> {
      await until(() => buffer.includes('\r\n\r\n'));
      const end = buffer.indexOf('\r\n\r\n');
      const out = buffer.subarray(0, end).toString('latin1');
      buffer = buffer.subarray(end + 4);
      return out;
    },
    /** Stops reading; returns what was read past the handshake. */
    rest(): Buffer {
      // Paused, so what the client sends before the upstream connects waits for the pipe instead of being lost.
      socket.pause();
      socket.removeAllListeners('data');
      return buffer;
    },
  };
}

const targetOf = (host: string): string => (host === PROXY_ONLY_NAME ? '127.0.0.1' : host);

function pipe(client: Socket, rest: Buffer, host: string, port: number, first?: (target: Socket) => void): void {
  const target = net.connect({ host: targetOf(host), port });
  target.on('error', () => client.destroy());
  client.on('error', () => target.destroy());
  client.on('close', () => target.destroy());
  target.once('connect', () => {
    if (rest.length > 0) target.write(rest);
    if (first) first(target);
    else target.pipe(client);
    client.pipe(target);
  });
}

async function socks5(socket: Socket, options: TestProxyOptions, requests: ProxyRequest[]): Promise<void> {
  const read = readerOf(socket);
  const [, count] = await read.take(2);
  const methods = [...(await read.take(count as number))];
  let login: ProxyRequest['login'];
  if (options.login) {
    if (!methods.includes(0x02)) return void socket.end(Uint8Array.of(5, 0xff));
    socket.write(Uint8Array.of(5, 0x02));
    const [, userLength] = await read.take(2);
    const user = (await read.take(userLength as number)).toString('utf8');
    const [passwordLength] = await read.take(1);
    const password = (await read.take(passwordLength as number)).toString('utf8');
    login = { user, password };
    const ok = user === options.login.user && password === options.login.password;
    socket.write(Uint8Array.of(1, ok ? 0 : 1));
    if (!ok) return void socket.end();
  } else {
    socket.write(Uint8Array.of(5, 0x00));
  }
  const [, , , type] = await read.take(4);
  let host: string;
  if (type === 0x01) host = [...(await read.take(4))].join('.');
  else if (type === 0x03) host = (await read.take((await read.take(1))[0] as number)).toString('utf8');
  else host = (await read.take(16)).toString('hex');
  const portBytes = await read.take(2);
  const port = ((portBytes[0] as number) << 8) | (portBytes[1] as number);
  requests.push({ host, port, ...(login ? { login } : {}) });
  if (options.refuse) return void socket.end(Uint8Array.of(5, 5, 0, 1, 0, 0, 0, 0, 0, 0));
  socket.write(Uint8Array.of(5, 0, 0, 1, 127, 0, 0, 1, 0, 0));
  pipe(socket, read.rest(), host, port);
}

async function http(socket: Socket, options: TestProxyOptions, requests: ProxyRequest[]): Promise<void> {
  const read = readerOf(socket);
  const head = await read.head();
  const [line = '', ...headers] = head.split('\r\n');
  const match = /^CONNECT (.+):(\d+) HTTP\/1\.1$/.exec(line);
  if (!match) return void socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  const host = (match[1] as string).replace(/^\[|\]$/g, '');
  const port = Number(match[2]);
  const prefix = 'proxy-authorization: basic ';
  const auth = headers.find((h) => h.toLowerCase().startsWith(prefix));
  let login: ProxyRequest['login'];
  if (auth) {
    const [user = '', password = ''] = Buffer.from(auth.slice(prefix.length), 'base64').toString('utf8').split(':');
    login = { user, password };
  }
  requests.push({ host, port, ...(login ? { login } : {}) });
  if (options.login && (login?.user !== options.login.user || login.password !== options.login.password)) {
    return void socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic\r\n\r\n');
  }
  if (options.refuse) return void socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
  const ok = 'HTTP/1.1 200 Connection established\r\n\r\n';
  if (!options.coalesce) {
    socket.write(ok);
    pipe(socket, read.rest(), host, port);
    return;
  }
  pipe(socket, read.rest(), host, port, (upstream) => {
    upstream.once('data', (first: Buffer) => {
      socket.write(Buffer.concat([Buffer.from(ok, 'latin1'), first]));
      upstream.pipe(socket);
    });
  });
}

/** A SOCKS5 or HTTP CONNECT proxy on 127.0.0.1 that tunnels to the asked-for target and records the ask. */
export async function startTestProxy(options: TestProxyOptions): Promise<TestProxy> {
  const requests: ProxyRequest[] = [];
  const sockets = new Set<Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    (options.type === 'socks5' ? socks5 : http)(socket, options, requests).catch(() => socket.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    requests,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
