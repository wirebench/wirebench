import type { Duplex } from 'node:stream';
import { Client } from 'ssh2';
import type { ConnectConfig } from 'ssh2';
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

export interface DialOptions {
  /** Outermost first, target last. */
  readonly hops: readonly HopCredentials[];
  /**
   * ssh2 calls this on every key exchange, including server rekeys mid-session, so it must answer from a
   * store (no interactive waiting: `readyTimeout` counts time spent inside it). A throw fails the connect
   * with ssh-connect-failed. It is told where the hop is, never its credentials, so the caller's verifier
   * holds none.
   */
  readonly verifyHostKey: (
    hop: { readonly address: string; readonly port: number },
    key: KnownHostEntry,
  ) => Promise<'accept' | 'reject'>;
  /**
   * The local agent's socket, handed to the target's client only so a shell opened on it can forward the
   * agent ({@link openSession}). The target authenticates as it would without it; jump hosts never see it.
   */
  readonly forwardAgent?: string;
}

export interface DialledChain {
  /** The client connected to the last hop. */
  readonly client: Client;
  /** Ends every hop's client; idempotent. */
  endAll(): void;
  /** Fires once when any hop's connection errors, ends or closes after `ready` (then every hop is ended). */
  onLost(listener: () => void): () => void;
  /** Whether that has happened: `openSession` reads it to tell `reason: 'lost'` from `'exit'`. */
  readonly lost: boolean;
}

/** ssh-host-key-new {host,keyType,fingerprint} · ssh-auth-failed {host,method} · ssh-connect-failed {host,hop} */
export class SshConnectError extends SshModelError {}

export const hostOf = (hop: HopCredentials): string => `${hop.address}:${hop.port}`;

function connectHop(
  hop: HopCredentials,
  index: number,
  options: DialOptions,
  sock: Duplex | undefined,
  onLost: () => void,
): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let rejectedKey: KnownHostEntry | undefined;
    let verifierFailed = false;
    const where = { address: hop.address, port: hop.port };
    const forward = index === options.hops.length - 1 ? options.forwardAgent : undefined;
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
      // An agent given only to forward is never offered for auth: the hop keeps to its own method.
      ...(forward !== undefined && hop.auth.kind !== 'agent'
        ? { agent: forward, authHandler: ['none', hop.auth.kind === 'password' ? 'password' : 'publickey'] }
        : {}),
      ...(sock ? { sock } : {}),
      hostVerifier: (key: Buffer, verify: (valid: boolean) => void) => {
        const entry: KnownHostEntry = {
          host: hostOf(hop),
          keyType: keyTypeOf(key),
          fingerprint: fingerprintOf(key),
        };
        options.verifyHostKey(where, entry).then(
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
      // Any later error (reset, rekey failure, keep-alive timeout), or the connection going away, ends the
      // whole chain; a session on it then ends via its channel.
      client.on('error', onLost);
      client.on('end', onLost);
      client.on('close', onLost);
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

/** Connects every hop in turn, each through a forwarded channel on the one before it. */
export async function dialChain(options: DialOptions): Promise<DialledChain> {
  const clients: Client[] = [];
  const lostListeners = new Set<() => void>();
  // `endAll` from this side is not a lost connection: the end and close events it causes are ignored.
  let ending = false;
  let lost = false;
  const endAll = (): void => {
    ending = true;
    for (const client of clients) client.end();
  };
  // ssh2 emits a hop's connection error, end and close before the socket's close tears a channel down, so a
  // channel's close can read `lost` to tell a lost connection from a channel the server closed.
  const onLost = (): void => {
    if (ending || lost) return;
    lost = true;
    endAll();
    for (const listener of lostListeners) listener();
  };
  try {
    let sock: Duplex | undefined;
    for (const [index, hop] of options.hops.entries()) {
      const client = await connectHop(hop, index, options, sock, onLost);
      clients.push(client);
      const next = options.hops[index + 1];
      if (next) sock = await forwardOut(client, next, index + 1);
    }
    const target = clients[clients.length - 1];
    if (!target) throw new SshConnectError('ssh-connect-failed', 'no hops to connect through', { host: '', hop: 0 });
    return {
      client: target,
      endAll,
      onLost: (listener) => {
        lostListeners.add(listener);
        return () => {
          lostListeners.delete(listener);
        };
      },
      get lost() {
        return lost;
      },
    };
  } catch (error) {
    endAll();
    throw error;
  }
}
