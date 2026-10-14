import net from 'node:net';
import type { Socket } from 'node:net';
import type { SshProxy } from './model.js';

/** A proxy with its password read from the secret store: what the dial needs, never what is written down. */
export interface ProxyCredentials {
  readonly type: 'socks5' | 'http';
  readonly host: string;
  readonly port: number;
  readonly user?: string;
  readonly password?: string;
}

/** A hop's proxy setting with its password read through `secret` (a `${secret:NAME}` token to its value). */
export async function proxyCredentialsOf(
  proxy: SshProxy,
  secret: (token: string) => Promise<string>,
): Promise<ProxyCredentials> {
  return {
    type: proxy.type,
    host: proxy.host,
    port: proxy.port,
    ...(proxy.user === undefined ? {} : { user: proxy.user }),
    ...(proxy.password === undefined ? {} : { password: await secret(proxy.password) }),
  };
}

/**
 * Why a proxy would not open the tunnel: `auth` it refused the user and password (or wants some),
 * `refused` it would not reach the target (with the proxy's own words in `detail`), `protocol` it did not
 * answer as a SOCKS5 or HTTP proxy does, `closed` it hung up mid-handshake.
 */
export class ProxyError extends Error {
  constructor(
    readonly kind: 'auth' | 'refused' | 'protocol' | 'closed',
    message: string,
    readonly detail?: string,
  ) {
    super(message);
  }
}

/** `host:port`, an IPv6 address in brackets. */
export const proxyTargetOf = (host: string, port: number): string =>
  `${net.isIPv6(host) ? `[${host}]` : host}:${String(port)}`;

/** The HTTP answer's head, at most this long; a proxy sending more is not one. */
const MAX_HEAD = 16 * 1024;

const SOCKS_REPLIES: Record<number, string> = {
  1: 'general failure',
  2: 'not allowed by its rules',
  3: 'network unreachable',
  4: 'host unreachable',
  5: 'connection refused',
  6: 'TTL expired',
  7: 'command not supported',
  8: 'address type not supported',
};

/** Reads exact byte counts from a socket that is already connected. */
class Reader {
  private buffer = Buffer.alloc(0);
  private waiting: { test: () => boolean; resolve: () => void; reject: (error: Error) => void } | undefined;
  private failure: Error | undefined;
  private readonly onData = (chunk: Buffer): void => {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.wake();
  };
  private readonly onEnd = (): void => {
    this.fail(new ProxyError('closed', 'the proxy closed the connection during the handshake'));
  };
  private readonly onError = (error: Error): void => {
    this.fail(error);
  };

  constructor(private readonly socket: Socket) {
    socket.on('data', this.onData);
    socket.on('end', this.onEnd);
    socket.on('close', this.onEnd);
    socket.on('error', this.onError);
  }

  async take(count: number): Promise<Buffer> {
    await this.until(() => this.buffer.length >= count);
    const out = this.buffer.subarray(0, count);
    this.buffer = this.buffer.subarray(count);
    return out;
  }

  /** Up to the blank line that ends an HTTP head, which is read too. */
  async head(): Promise<string> {
    await this.until(() => this.buffer.includes('\r\n\r\n') || this.buffer.length > MAX_HEAD);
    const end = this.buffer.indexOf('\r\n\r\n');
    if (end === -1) throw new ProxyError('protocol', 'the proxy answered with an over-long HTTP head');
    const out = this.buffer.subarray(0, end).toString('latin1');
    this.buffer = this.buffer.subarray(end + 4);
    return out;
  }

  /** Stops reading; bytes already past the handshake (the server's banner) go back for ssh2 to read. */
  release(): void {
    this.socket.removeListener('data', this.onData);
    this.socket.removeListener('end', this.onEnd);
    this.socket.removeListener('close', this.onEnd);
    this.socket.removeListener('error', this.onError);
    this.socket.pause();
    if (this.buffer.length > 0) this.socket.unshift(this.buffer);
    this.buffer = Buffer.alloc(0);
  }

  private until(test: () => boolean): Promise<void> {
    if (test()) return Promise.resolve();
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      this.waiting = { test, resolve, reject };
    });
  }

  private wake(): void {
    const waiting = this.waiting;
    if (waiting?.test()) {
      this.waiting = undefined;
      waiting.resolve();
    }
  }

  private fail(error: Error): void {
    this.failure ??= error;
    const waiting = this.waiting;
    this.waiting = undefined;
    waiting?.reject(this.failure);
  }
}

function ipv6Bytes(host: string): Buffer {
  const [head = '', tail] = host.split('::');
  const groups = (part: string): number[] => (part === '' ? [] : part.split(':').map((g) => parseInt(g, 16)));
  const left = groups(head);
  const right = tail === undefined ? [] : groups(tail);
  const all = [...left, ...new Array<number>(8 - left.length - right.length).fill(0), ...right];
  const out = Buffer.alloc(16);
  all.forEach((g, i) => out.writeUInt16BE(g, i * 2));
  return out;
}

async function socks5(
  reader: Reader,
  socket: Socket,
  proxy: ProxyCredentials,
  host: string,
  port: number,
): Promise<void> {
  const login = proxy.user !== undefined;
  socket.write(login ? Uint8Array.of(5, 2, 0x00, 0x02) : Uint8Array.of(5, 1, 0x00));
  const [version, method] = await reader.take(2);
  if (version !== 5) throw new ProxyError('protocol', 'the proxy did not answer as a SOCKS5 proxy');
  if (method === 0xff) {
    throw new ProxyError(
      'auth',
      login ? 'the proxy accepts none of the offered sign-in methods' : 'the proxy wants a user and password',
    );
  }
  if (method === 0x02) {
    if (!login) throw new ProxyError('protocol', 'the proxy chose a sign-in method that was not offered');
    const user = Buffer.from(proxy.user ?? '', 'utf8');
    const password = Buffer.from(proxy.password ?? '', 'utf8');
    if (user.length > 255 || password.length > 255) {
      throw new ProxyError('auth', 'the proxy user or password is longer than SOCKS5 allows (255 bytes)');
    }
    socket.write(Buffer.concat([Uint8Array.of(1, user.length), user, Uint8Array.of(password.length), password]));
    const [, status] = await reader.take(2);
    if (status !== 0) throw new ProxyError('auth', 'the proxy refused the user and password');
  } else if (method !== 0x00) {
    throw new ProxyError('protocol', 'the proxy chose a sign-in method that was not offered');
  }

  let address: Buffer;
  if (net.isIPv4(host)) address = Buffer.concat([Uint8Array.of(0x01), Uint8Array.from(host.split('.').map(Number))]);
  else if (net.isIPv6(host)) address = Buffer.concat([Uint8Array.of(0x04), ipv6Bytes(host)]);
  else {
    // The proxy resolves the name: the target may be one only the proxy's side of the network knows.
    const name = Buffer.from(host, 'utf8');
    if (name.length > 255)
      throw new ProxyError('refused', 'the host name is longer than SOCKS5 allows', 'host name too long');
    address = Buffer.concat([Uint8Array.of(0x03, name.length), name]);
  }
  socket.write(Buffer.concat([Uint8Array.of(5, 0x01, 0x00), address, Uint8Array.of(port >> 8, port & 0xff)]));
  const [replyVersion, reply, , type] = await reader.take(4);
  if (replyVersion !== 5) throw new ProxyError('protocol', 'the proxy did not answer as a SOCKS5 proxy');
  if (reply !== 0) {
    const words = SOCKS_REPLIES[reply as number] ?? `reply ${String(reply)}`;
    throw new ProxyError('refused', `the proxy could not reach ${proxyTargetOf(host, port)}: ${words}`, words);
  }
  // The bound address the proxy reports; nothing here needs it.
  if (type === 0x01) await reader.take(4 + 2);
  else if (type === 0x04) await reader.take(16 + 2);
  else if (type === 0x03) await reader.take(((await reader.take(1))[0] as number) + 2);
  else throw new ProxyError('protocol', 'the proxy answered with an unknown address type');
}

async function httpConnect(
  reader: Reader,
  socket: Socket,
  proxy: ProxyCredentials,
  host: string,
  port: number,
): Promise<void> {
  const target = proxyTargetOf(host, port);
  const lines = [`CONNECT ${target} HTTP/1.1`, `Host: ${target}`];
  if (proxy.user !== undefined) {
    const basic = Buffer.from(`${proxy.user}:${proxy.password ?? ''}`, 'utf8').toString('base64');
    lines.push(`Proxy-Authorization: Basic ${basic}`);
  }
  socket.write(`${lines.join('\r\n')}\r\n\r\n`);
  const head = await reader.head();
  const status = /^HTTP\/1\.[01] (\d{3})(?: (.*))?$/.exec(head.split('\r\n')[0] ?? '');
  if (!status) throw new ProxyError('protocol', 'the proxy did not answer as an HTTP proxy');
  const code = Number(status[1]);
  // The proxy's reason phrase, printable and short: it goes in the log and the error.
  const reason = (status[2] ?? '').replace(/[^\x20-\x7e]/g, '').slice(0, 60);
  const words = reason === '' ? String(code) : `${String(code)} ${reason}`;
  if (code === 407) {
    throw new ProxyError(
      'auth',
      proxy.user === undefined ? 'the proxy wants a user and password' : 'the proxy refused the user and password',
      words,
    );
  }
  if (code < 200 || code > 299) {
    throw new ProxyError('refused', `the proxy would not open a tunnel to ${target} (${words})`, words);
  }
}

/**
 * Asks the proxy `socket` is connected to for a tunnel to `host:port`; once this resolves the socket
 * carries the tunnel, with any bytes that came early (the server's banner) put back to be read.
 *
 * @throws ProxyError when the proxy refuses or does not speak its protocol; the socket's own error when
 *   the connection fails meanwhile.
 */
export async function openProxyTunnel(
  socket: Socket,
  proxy: ProxyCredentials,
  host: string,
  port: number,
): Promise<void> {
  const reader = new Reader(socket);
  try {
    if (proxy.type === 'socks5') await socks5(reader, socket, proxy, host, port);
    else await httpConnect(reader, socket, proxy, host, port);
  } finally {
    reader.release();
  }
}
