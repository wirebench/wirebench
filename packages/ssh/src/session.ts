import { randomUUID } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { Client } from 'ssh2';
import type { ClientChannel, ConnectConfig } from 'ssh2';
import { SshModelError } from './errors.js';
import { fingerprintOf, keyTypeOf } from './known-hosts.js';
import type { KnownHostEntry } from './known-hosts.js';

export interface HopCredentials {
  readonly address: string;
  readonly port: number;
  readonly user: string;
  readonly auth:
    | { kind: 'password'; password: string }
    | { kind: 'key'; privateKey: string; passphrase?: string }
    | { kind: 'agent'; socket: string };
  /** Seconds; 0 turns keep-alive off. */
  readonly keepAlive: number;
  /** Seconds. */
  readonly connectTimeout: number;
}

export interface OpenSessionOptions {
  /** Outermost first, target last. */
  readonly hops: readonly HopCredentials[];
  readonly cols: number;
  readonly rows: number;
  /**
   * ssh2 calls this on every key exchange, including server rekeys mid-session, so it must answer from a
   * store (no interactive waiting: `readyTimeout` counts time spent inside it). A throw fails the connect
   * with ssh-connect-failed. After `close()`, `onExit` still fires once with `{ code: null }`.
   */
  readonly verifyHostKey: (hop: HopCredentials, key: KnownHostEntry) => Promise<'accept' | 'reject'>;
}

export interface SshSession {
  readonly id: string;
  write(data: Uint8Array): void;
  resize(cols: number, rows: number): void;
  close(): void;
  onData(listener: (data: Uint8Array) => void): () => void;
  onExit(listener: (exit: { code: number | null; signal?: string }) => void): () => void;
}

/** ssh-host-key-new {host,keyType,fingerprint} · ssh-auth-failed {host,method} · ssh-connect-failed {host,hop} */
export class SshConnectError extends SshModelError {}

const hostOf = (hop: HopCredentials): string => `${hop.address}:${hop.port}`;

function connectHop(
  hop: HopCredentials,
  index: number,
  options: OpenSessionOptions,
  sock: Duplex | undefined,
  onLost: () => void,
): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let rejectedKey: KnownHostEntry | undefined;
    let verifierFailed = false;
    const config: ConnectConfig = {
      host: hop.address,
      port: hop.port,
      username: hop.user,
      readyTimeout: hop.connectTimeout * 1000,
      keepaliveInterval: hop.keepAlive > 0 ? hop.keepAlive * 1000 : 0,
      ...(hop.auth.kind === 'password' ? { password: hop.auth.password } : {}),
      ...(hop.auth.kind === 'key'
        ? { privateKey: hop.auth.privateKey, ...(hop.auth.passphrase ? { passphrase: hop.auth.passphrase } : {}) }
        : {}),
      ...(hop.auth.kind === 'agent' ? { agent: hop.auth.socket } : {}),
      ...(sock ? { sock } : {}),
      hostVerifier: (key: Buffer, verify: (valid: boolean) => void) => {
        const entry: KnownHostEntry = {
          host: hostOf(hop),
          keyType: keyTypeOf(key),
          fingerprint: fingerprintOf(key),
        };
        options.verifyHostKey(hop, entry).then(
          (decision) => {
            if (decision === 'reject') rejectedKey = entry;
            verify(decision === 'accept');
          },
          () => {
            verifierFailed = true;
            verify(false);
          },
        );
      },
    };
    const onConnectError = (error: Error & { level?: string }): void => {
      const host = hostOf(hop);
      if (rejectedKey && !verifierFailed) {
        reject(new SshConnectError('ssh-host-key-new', `${host} presented an untrusted key`, { ...rejectedKey }));
      } else if (error.level === 'client-authentication') {
        reject(
          new SshConnectError('ssh-auth-failed', `${host} refused ${hop.auth.kind} authentication for ${hop.user}`, {
            host,
            method: hop.auth.kind,
          }),
        );
      } else {
        reject(new SshConnectError('ssh-connect-failed', `${host}: ${error.message}`, { host, hop: index }));
      }
    };
    client.once('ready', () => {
      client.removeListener('error', onConnectError);
      // Any later error (reset, rekey failure) ends the whole chain; the session then exits via its channel.
      client.on('error', onLost);
      resolve(client);
    });
    client.once('error', onConnectError);
    try {
      client.connect(config);
    } catch {
      // The library message can describe the key material, so it is never forwarded.
      const host = hostOf(hop);
      reject(
        hop.auth.kind === 'key'
          ? new SshConnectError('ssh-auth-failed', `${host} could not use the private key`, { host, method: 'key' })
          : new SshConnectError('ssh-connect-failed', `${host}: invalid connection settings`, { host, hop: index }),
      );
    }
  });
}

function forwardOut(client: Client, next: HopCredentials, index: number): Promise<Duplex> {
  return new Promise((resolve, reject) =>
    client.forwardOut('127.0.0.1', 0, next.address, next.port, (error, stream) =>
      error
        ? reject(
            new SshConnectError('ssh-connect-failed', `jump to ${hostOf(next)} failed: ${error.message}`, {
              host: hostOf(next),
              hop: index,
            }),
          )
        : resolve(stream),
    ),
  );
}

export async function openSession(options: OpenSessionOptions): Promise<SshSession> {
  const clients: Client[] = [];
  const endAll = (): void => {
    for (const client of clients) client.end();
  };
  try {
    let sock: Duplex | undefined;
    for (const [index, hop] of options.hops.entries()) {
      const client = await connectHop(hop, index, options, sock, endAll);
      clients.push(client);
      const next = options.hops[index + 1];
      if (next) sock = await forwardOut(client, next, index + 1);
    }
    const target = clients[clients.length - 1];
    if (!target) throw new SshConnectError('ssh-connect-failed', 'no hops to connect through', { host: '', hop: 0 });
    const lastHop = options.hops[options.hops.length - 1] as HopCredentials;
    const channel = await new Promise<ClientChannel>((resolve, reject) =>
      target.shell({ term: 'xterm-256color', cols: options.cols, rows: options.rows }, (error, ch) =>
        error
          ? reject(
              new SshConnectError('ssh-connect-failed', `${hostOf(lastHop)}: ${error.message}`, {
                host: hostOf(lastHop),
                hop: options.hops.length - 1,
              }),
            )
          : resolve(ch),
      ),
    );
    return wrap(channel, endAll);
  } catch (error) {
    endAll();
    throw error;
  }
}

function wrap(channel: ClientChannel, endAll: () => void): SshSession {
  const dataListeners = new Set<(data: Uint8Array) => void>();
  const exitListeners = new Set<(exit: { code: number | null; signal?: string }) => void>();
  let exited = false;
  let closed = false;
  const exit = (code: number | null, signal?: string): void => {
    if (exited) return;
    exited = true;
    closed = true;
    for (const listener of exitListeners) listener({ code, ...(signal ? { signal } : {}) });
    endAll();
  };
  channel.on('data', (data: Buffer) => {
    for (const listener of dataListeners) listener(data);
  });
  channel.stderr.on('data', (data: Buffer) => {
    for (const listener of dataListeners) listener(data);
  });
  channel.on('exit', (code: number | null, signal?: string) => exit(code, signal));
  channel.on('close', () => exit(null));
  channel.on('error', () => exit(null));
  return {
    id: randomUUID(),
    write: (data) => {
      if (!closed) channel.write(Buffer.from(data));
    },
    resize: (cols, rows) => {
      if (!closed) channel.setWindow(rows, cols, 0, 0);
    },
    close: () => {
      closed = true;
      channel.end();
      endAll();
    },
    onData: (listener) => {
      dataListeners.add(listener);
      return () => {
        dataListeners.delete(listener);
      };
    },
    onExit: (listener) => {
      exitListeners.add(listener);
      return () => {
        exitListeners.delete(listener);
      };
    },
  };
}
