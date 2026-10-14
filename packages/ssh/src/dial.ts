import net from 'node:net';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { Client } from 'ssh2';
import type { AuthHandlerMiddleware, AuthenticationType, ConnectConfig } from 'ssh2';
import { certificateAuth } from './cert-auth.js';
import type { CertificateAuth } from './cert-auth.js';
import { HopProgress, connectFailureOf } from './connect-progress.js';
import type { ConnectFailure, ConnectProgress } from './connect-progress.js';
import { SshModelError } from './errors.js';
import { fingerprintOf, keyTypeOf } from './known-hosts.js';
import type { KnownHostEntry } from './known-hosts.js';

export interface HopCredentials {
  readonly address: string;
  readonly port: number;
  readonly user: string;
  readonly auth:
    | { kind: 'password'; password: string }
    | {
        kind: 'key';
        privateKey: string;
        passphrase?: string;
        /** An OpenSSH user certificate for the key: offered first, then the key alone. */
        certificate?: string;
        /** The key's name as the user knows it (its secret's name), for progress and errors; never the key. */
        label?: string;
      }
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
  /** Told each hop's stages and log lines as they happen (#528); none of them holds a credential. */
  readonly onProgress?: (event: ConnectProgress) => void;
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

/**
 * ssh-host-key-new {host,keyType,fingerprint,hop} · ssh-auth-failed {host,method,hop,tried,allowed,key?} ·
 * ssh-connect-failed {host,hop,reason,phase?,timeout?} · ssh-cert-expired {host,validity,validAfter,validBefore,window} · ssh-cert-invalid · ssh-cert-mismatch {host}
 */
export class SshConnectError extends SshModelError {}

export const hostOf = (hop: HopCredentials): string => `${hop.address}:${hop.port}`;

/** The words a log line and a step use for an auth method. */
function methodLabel(type: string, hop: HopCredentials): string {
  if (type === 'password') return 'password';
  if (type === 'publickey') {
    const label = hop.auth.kind === 'key' ? hop.auth.label : undefined;
    return label === undefined ? 'public key' : `key ${label}`;
  }
  if (type === 'agent') return 'agent keys';
  return type;
}

/** The server's software from its identification line, as plain text of a sane length. */
function serverSoftware(client: Client): string | undefined {
  const raw = (client as unknown as { _remoteVer?: unknown })._remoteVer;
  if (typeof raw !== 'string') return undefined;
  const clean = raw.replace(/[^\x20-\x7e]/g, '').slice(0, 80);
  return clean === '' ? undefined : clean;
}

/** What one hop's auth came to: the methods tried, in order, and what the server said it allows. */
interface AuthRecord {
  readonly tried: string[];
  allowed: string[] | undefined;
  /** The method in flight. */
  pending: string | undefined;
}

type AuthChoice = AuthenticationType | { readonly type: AuthenticationType } | false;
type AuthStep = (
  left: AuthenticationType[] | null,
  partial: boolean | null,
  next: (choice: AuthChoice) => void,
) => AuthChoice | undefined;

/**
 * Wraps the hop's auth order (ssh2's own default, a method list or a certificate's handler) so each
 * attempt, each refusal and the methods the server allows are reported. The choice itself is untouched.
 */
function trackAuth(config: ConnectConfig, hop: HopCredentials, progress: HopProgress, record: AuthRecord): void {
  const base = config.authHandler;
  let inner: AuthStep;
  if (typeof base === 'function') {
    inner = base as unknown as AuthStep;
  } else {
    // ssh2's default order when no handler is given.
    const defaults: AuthenticationType[] = ['none'];
    if (config.password !== undefined) defaults.push('password');
    if (config.privateKey !== undefined) defaults.push('publickey');
    if (config.agent !== undefined) defaults.push('agent');
    const list = (base ?? defaults) as AuthChoice[];
    let index = 0;
    inner = () => list[index++] ?? false;
  }
  const step: AuthStep = (left, partial, next) => {
    if (progress.current !== 'auth') progress.start('auth');
    const previous = record.pending;
    record.pending = undefined;
    if (previous !== undefined && previous !== 'none') {
      if (partial === true) progress.log(`${methodLabel(previous, hop)} accepted, the server asks for more`);
      else progress.fail(`${methodLabel(previous, hop)} refused`);
    }
    if (left !== null) {
      record.allowed = [...left];
      progress.log(`Server allows: ${left.length === 0 ? 'nothing' : left.join(', ')}`);
    }
    let noted = false;
    const note = (choice: AuthChoice): void => {
      if (noted) return;
      noted = true;
      if (choice === false) {
        progress.log('No sign-in method left to try');
        return;
      }
      const type = typeof choice === 'string' ? choice : choice.type;
      record.pending = type;
      if (type === 'none') {
        progress.log(`Asking ${progress.host} which sign-in methods it allows for ${hop.user}`);
        return;
      }
      record.tried.push(type);
      progress.start('auth', methodLabel(type, hop));
      progress.log(`Trying ${methodLabel(type, hop)} for ${hop.user}`);
    };
    const chosen = inner(left, partial, (choice) => {
      note(choice);
      next(choice);
    });
    if (chosen !== undefined) note(chosen);
    return chosen;
  };
  config.authHandler = step as unknown as AuthHandlerMiddleware;
}

/**
 * The first hop's TCP connection, opened here rather than by ssh2 so the name lookup and the connect are
 * timed and told apart: a name that does not resolve, a port nothing listens on, a host that never answers.
 */
function openSocket(hop: HopCredentials, index: number, progress: HopProgress): Promise<Socket> {
  const host = hostOf(hop);
  return new Promise((resolve, reject) => {
    const literal = net.isIP(hop.address) !== 0;
    progress.start('resolve', hop.address);
    let resolved = false;
    const noteResolved = (address: string): void => {
      if (resolved) return;
      resolved = true;
      progress.done('resolve', address);
      progress.start('tcp', `${address}:${String(hop.port)}`);
    };
    if (literal) {
      progress.log(`${hop.address} is an IP address: nothing to resolve`);
      noteResolved(hop.address);
    } else {
      progress.log(`Resolving ${hop.address}`);
    }
    const socket = net.connect({ host: hop.address, port: hop.port });
    const fail = (error: unknown): void => {
      clearTimeout(timer);
      socket.destroy();
      const reason: ConnectFailure = connectFailureOf(error);
      const phase = resolved ? 'tcp' : 'resolve';
      progress.fail(
        reason === 'timeout'
          ? `No answer from ${host} after ${String(hop.connectTimeout)} s`
          : `${phase === 'resolve' ? `Could not resolve ${hop.address}` : `Could not connect to ${host}`} (${failureWords(reason)})`,
      );
      const message =
        reason === 'timeout' ? `no answer after ${String(hop.connectTimeout)} s` : (error as Error).message;
      reject(
        new SshConnectError('ssh-connect-failed', `${host}: ${message}`, {
          host,
          hop: index,
          reason,
          phase,
          ...(reason === 'timeout' ? { timeout: hop.connectTimeout } : {}),
        }),
      );
    };
    const timer = setTimeout(() => {
      fail(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }));
    }, hop.connectTimeout * 1000);
    socket.on('lookup', (error: Error | null, address: string | undefined) => {
      if (error !== null || typeof address !== 'string') return;
      progress.log(`Resolved ${hop.address} to ${address}`);
      noteResolved(address);
    });
    socket.on('connectionAttempt', (ip: string, port: number) => {
      progress.log(`Connecting to ${ip} port ${String(port)}`);
    });
    socket.on('connectionAttemptFailed', (ip: string, port: number, _family: number, error: unknown) => {
      progress.log(`${ip} port ${String(port)}: ${failureWords(connectFailureOf(error))}`);
    });
    socket.once('error', fail);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.removeListener('error', fail);
      // ssh2 takes the socket over and handles its errors; this keeps one in between from going unheard.
      socket.on('error', () => undefined);
      const address = socket.remoteAddress ?? hop.address;
      noteResolved(address);
      progress.log(`TCP connection to ${address} port ${String(hop.port)} open`);
      progress.done('tcp', `${address}:${String(hop.port)}`);
      resolve(socket);
    });
  });
}

/** A failure reason in a few words, for the log. */
function failureWords(reason: ConnectFailure): string {
  switch (reason) {
    case 'dns':
      return 'name not found';
    case 'refused':
      return 'connection refused';
    case 'timeout':
      return 'timed out';
    case 'unreachable':
      return 'no route to the host';
    case 'reset':
      return 'connection reset';
    case 'jump':
      return 'the jump host would not open the channel';
    case 'other':
      return 'connection failed';
  }
}

async function connectHop(
  hop: HopCredentials,
  index: number,
  options: DialOptions,
  sock: Duplex | undefined,
  onLost: () => void,
  progress: HopProgress,
): Promise<Client> {
  const host = hostOf(hop);
  let certAuth: CertificateAuth | undefined;
  if (hop.auth.kind === 'key' && hop.auth.certificate !== undefined) {
    try {
      certAuth = certificateAuth({
        username: hop.user,
        privateKey: hop.auth.privateKey,
        certificate: hop.auth.certificate,
        ...(hop.auth.passphrase ? { passphrase: hop.auth.passphrase } : {}),
      });
    } catch (error) {
      const { code, message, details } = error as SshModelError;
      throw new SshConnectError(code, `${host}: ${message}`, { ...details, host, hop: index });
    }
  }
  const socket = sock ?? (await openSocket(hop, index, progress));
  return handshake(hop, index, options, socket, onLost, progress, certAuth);
}

function handshake(
  hop: HopCredentials,
  index: number,
  options: DialOptions,
  sock: Duplex,
  onLost: () => void,
  progress: HopProgress,
  certAuth: CertificateAuth | undefined,
): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let rejectedKey: KnownHostEntry | undefined;
    let verifierFailed = false;
    let ready = false;
    const auth: AuthRecord = { tried: [], allowed: undefined, pending: undefined };
    const where = { address: hop.address, port: hop.port };
    const forward = index === options.hops.length - 1 ? options.forwardAgent : undefined;
    const config: ConnectConfig = {
      host: hop.address,
      port: hop.port,
      username: hop.user,
      readyTimeout: hop.connectTimeout * 1000,
      keepaliveInterval: hop.keepAlive > 0 ? hop.keepAlive * 1000 : 0,
      ...(hop.auth.kind === 'password' ? { password: hop.auth.password } : {}),
      ...(certAuth ? { authHandler: certAuth.authHandler } : {}),
      ...(hop.auth.kind === 'key' && !certAuth
        ? { privateKey: hop.auth.privateKey, ...(hop.auth.passphrase ? { passphrase: hop.auth.passphrase } : {}) }
        : {}),
      ...(hop.auth.kind === 'agent' ? { agent: hop.auth.socket } : {}),
      // An agent given only to forward is never offered for auth: the hop keeps to its own method.
      ...(forward !== undefined && hop.auth.kind !== 'agent'
        ? { agent: forward, authHandler: ['none', hop.auth.kind === 'password' ? 'password' : 'publickey'] }
        : {}),
      sock,
      hostVerifier: (key: Buffer, verify: (valid: boolean) => void) => {
        const entry: KnownHostEntry = {
          host: hostOf(hop),
          keyType: keyTypeOf(key),
          fingerprint: fingerprintOf(key),
        };
        // ssh2 asks again on every rekey; only the first answer is part of the connect.
        const reporting = !ready && progress.current === 'banner';
        if (reporting) {
          const software = serverSoftware(client);
          if (software !== undefined) progress.log(`Server software: ${software}`);
          progress.done('banner', software);
          progress.start('host-key', `${entry.keyType} ${entry.fingerprint}`);
          progress.log(`Server host key: ${entry.keyType} ${entry.fingerprint}`);
        }
        options.verifyHostKey(where, entry).then(
          (decision) => {
            if (decision === 'reject') rejectedKey = entry;
            if (reporting) {
              if (decision === 'accept') {
                progress.log('Host key matches known_hosts');
                progress.done('host-key', 'trusted');
              } else {
                progress.log('Host key is not in known_hosts yet, or differs from the one there');
              }
            }
            verify(decision === 'accept');
          },
          () => {
            verifierFailed = true;
            if (reporting) progress.fail('The host key could not be checked');
            verify(false);
          },
        );
      },
    };
    trackAuth(config, hop, progress, auth);
    const onConnectError = (error: Error & { level?: string }): void => {
      // ssh2 can report the same end twice (a timeout, then the socket it closed): the second is not news.
      client.on('error', () => undefined);
      const host = hostOf(hop);
      const phase = progress.current;
      if (rejectedKey && !verifierFailed) {
        reject(
          new SshConnectError('ssh-host-key-new', `${host} presented an untrusted key`, { ...rejectedKey, hop: index }),
        );
      } else if (error.level === 'client-authentication') {
        // With a certificate, both it and the key alone were refused.
        const method = certAuth ? 'certificate' : hop.auth.kind;
        const tried = [...new Set(auth.tried)];
        const label = hop.auth.kind === 'key' ? hop.auth.label : undefined;
        const last = auth.pending;
        if (last !== undefined && last !== 'none') progress.fail(`${methodLabel(last, hop)} refused`);
        progress.fail(`Signing in as ${hop.user} failed: no method left`);
        reject(
          new SshConnectError('ssh-auth-failed', `${host} refused ${method} authentication for ${hop.user}`, {
            host,
            method,
            hop: index,
            tried,
            allowed: auth.allowed ?? [],
            user: hop.user,
            ...(label === undefined ? {} : { key: label }),
          }),
        );
      } else {
        const reason = connectFailureOf(error);
        progress.fail(
          reason === 'timeout'
            ? `No answer from ${host} after ${String(hop.connectTimeout)} s`
            : `${host}: ${failureWords(reason)}`,
        );
        reject(
          new SshConnectError('ssh-connect-failed', `${host}: ${error.message}`, {
            host,
            hop: index,
            reason,
            ...(phase === undefined ? {} : { phase }),
            ...(reason === 'timeout' ? { timeout: hop.connectTimeout } : {}),
          }),
        );
      }
    };
    client.once('ready', () => {
      ready = true;
      client.removeListener('error', onConnectError);
      const method = auth.pending === undefined ? undefined : methodLabel(auth.pending, hop);
      progress.log(method === undefined ? `Signed in as ${hop.user}` : `Signed in as ${hop.user} with ${method}`);
      progress.done('auth', method);
      // Any later error (reset, rekey failure, keep-alive timeout), or the connection going away, ends the
      // whole chain; a session on it then ends via its channel.
      client.on('error', onLost);
      client.on('end', onLost);
      client.on('close', onLost);
      resolve(client);
    });
    client.once('error', onConnectError);
    progress.start('banner');
    progress.log('Waiting for the server to identify itself');
    try {
      client.connect(config);
      certAuth?.attach(client);
    } catch {
      // ssh2 never took the socket over, so nothing else will close it.
      sock.destroy();
      // The library message can describe the key material, so it is never forwarded.
      const host = hostOf(hop);
      reject(
        hop.auth.kind === 'key'
          ? new SshConnectError('ssh-auth-failed', `${host} could not use the private key`, {
              host,
              method: 'key',
              hop: index,
              tried: [],
              allowed: [],
              user: hop.user,
              unusableKey: true,
            })
          : new SshConnectError('ssh-connect-failed', `${host}: invalid connection settings`, {
              host,
              hop: index,
              reason: 'other',
            }),
      );
    }
  });
}

function forwardOut(
  client: Client,
  via: HopCredentials,
  next: HopCredentials,
  index: number,
  progress: HopProgress,
): Promise<Duplex> {
  progress.start('resolve', next.address);
  progress.log(`${hostOf(via)} resolves ${next.address}`);
  progress.done('resolve', 'by the jump host');
  progress.start('tcp', `through ${hostOf(via)}`);
  progress.log(`Asking ${hostOf(via)} to open a channel to ${hostOf(next)}`);
  return new Promise((resolve, reject) =>
    client.forwardOut('127.0.0.1', 0, next.address, next.port, (error, stream) => {
      if (error) {
        progress.fail(`${hostOf(via)} would not open a channel to ${hostOf(next)}`);
        reject(
          new SshConnectError('ssh-connect-failed', `jump to ${hostOf(next)} failed: ${error.message}`, {
            host: hostOf(next),
            hop: index,
            reason: 'jump',
            phase: 'tcp',
            via: hostOf(via),
          }),
        );
        return;
      }
      progress.log(`Channel to ${hostOf(next)} open through ${hostOf(via)}`);
      progress.done('tcp', `through ${hostOf(via)}`);
      resolve(stream);
    }),
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
    const count = options.hops.length;
    const progress = options.hops.map((hop, index) => new HopProgress(options.onProgress, index, count, hostOf(hop)));
    for (const [index, hop] of options.hops.entries()) {
      const client = await connectHop(hop, index, options, sock, onLost, progress[index] as HopProgress);
      clients.push(client);
      const next = options.hops[index + 1];
      if (next) sock = await forwardOut(client, hop, next, index + 1, progress[index + 1] as HopProgress);
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
    // Which hop failed means more with how many there are: the screen tells a jump host from the target.
    if (error instanceof SshModelError)
      throw new SshConnectError(error.code, error.message, { ...error.details, hops: options.hops.length });
    throw error;
  }
}
