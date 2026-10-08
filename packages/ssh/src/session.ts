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

function connectHop(hop: HopCredentials, index: number, options: OpenSessionOptions, sock?: Duplex): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let rejectedKey: KnownHostEntry | undefined;
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
            rejectedKey = entry;
            verify(false);
          },
        );
      },
    };
    client.once('ready', () => resolve(client));
    client.once('error', (error: Error & { level?: string }) => {
      const host = hostOf(hop);
      if (rejectedKey) {
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
    });
    client.connect(config);
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
      const client = await connectHop(hop, index, options, sock);
      clients.push(client);
      const next = options.hops[index + 1];
      if (next) sock = await forwardOut(client, next, index + 1);
    }
    const target = clients[clients.length - 1];
    if (!target) throw new SshConnectError('ssh-connect-failed', 'no hops to connect through', { host: '', hop: 0 });
    const channel = await new Promise<ClientChannel>((resolve, reject) =>
      target.shell({ term: 'xterm-256color', cols: options.cols, rows: options.rows }, (error, ch) =>
        error ? reject(error) : resolve(ch),
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
  const exit = (code: number | null, signal?: string): void => {
    if (exited) return;
    exited = true;
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
  return {
    id: randomUUID(),
    write: (data) => {
      channel.write(Buffer.from(data));
    },
    resize: (cols, rows) => {
      channel.setWindow(rows, cols, 0, 0);
    },
    close: () => {
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
