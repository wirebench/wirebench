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
import type { FidoTransport } from './fido/authenticator.js';
import { fingerprintOf, keyTypeOf } from './known-hosts.js';
import type { KnownHostEntry } from './known-hosts.js';
import { agentSkSigners, skAuth, storedSkSigner } from './sk-auth.js';
import type { SkAuth, SkSigner } from './sk-auth.js';
import { isSkPrivateKey, parseSkPrivateKey } from './sk-key.js';
import { ProxyError, openProxyTunnel, proxyTargetOf } from './proxy.js';
import type { ProxyCredentials } from './proxy.js';

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
        /** A security key's PIN (#420), asked for on the spot and never stored; only an sk key uses it. */
        pin?: string;
      }
    | { kind: 'agent'; socket: string };
  /** Seconds; 0 turns keep-alive off. */
  readonly keepAlive: number;
  /** Seconds. */
  readonly connectTimeout: number;
  /**
   * Dial this hop through a SOCKS5 or HTTP CONNECT proxy (#417). Read on the first hop only: the hops after
   * it are reached through the one before.
   */
  readonly proxy?: ProxyCredentials;
}

/**
 * Where a session that is not SSH connects (#425): its address and port, how long to wait, and the proxy to
 * dial it through when it is the first network hop.
 */
export type TcpTarget = Pick<HopCredentials, 'address' | 'port' | 'connectTimeout' | 'proxy'>;

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
  /** Where security keys are found (#420); node-hid unless a test injects a software authenticator. */
  readonly fido?: FidoTransport;
}

/**
 * Extra seconds a hop that signs with a security key gets on top of its connect timeout: the person has to
 * find the key and touch it (an authenticator gives up on its own after about 30 s).
 */
export const SK_TOUCH_SECONDS = 60;

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
 * ssh-connect-failed {host,hop,reason,phase?,timeout?,proxy?,proxyType?,proxyReason?,proxyDetail?} · ssh-cert-expired {host,validity,validAfter,validBefore,window} · ssh-cert-invalid · ssh-cert-mismatch {host} ·
 * ssh-sk-pin {host,hop,reason,retries?} · ssh-sk-no-device · ssh-sk-not-touched · ssh-sk-unavailable · ssh-sk-failed {host,hop}
 */
export class SshConnectError extends SshModelError {}

export const hostOf = (hop: { readonly address: string; readonly port: number }): string =>
  `${hop.address}:${hop.port}`;

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
 * With a proxy, the connection goes to the proxy, which is then asked for a tunnel to the hop; the proxy
 * resolves the hop's name.
 */
function openSocket(hop: TcpTarget, index: number, progress: HopProgress): Promise<Socket> {
  const host = hostOf(hop);
  const proxy = hop.proxy;
  const proxyName = proxy === undefined ? undefined : `${proxyKind(proxy)} ${proxyTargetOf(proxy.host, proxy.port)}`;
  // What the TCP connection is opened to: the proxy, or the hop itself.
  const dial =
    proxy === undefined ? { address: hop.address, port: hop.port } : { address: proxy.host, port: proxy.port };
  const dialHost = proxyTargetOf(dial.address, dial.port);
  const proxyDetails = (): Record<string, unknown> =>
    proxy === undefined ? {} : { proxy: proxyTargetOf(proxy.host, proxy.port), proxyType: proxy.type };
  return new Promise((resolve, reject) => {
    const literal = net.isIP(dial.address) !== 0;
    if (proxyName !== undefined) progress.log(`Connecting through the ${proxyName}`);
    progress.start('resolve', dial.address);
    let resolved = false;
    let tunnelling = false;
    const noteResolved = (address: string): void => {
      if (resolved) return;
      resolved = true;
      progress.done('resolve', address);
      progress.start('tcp', proxyName === undefined ? `${address}:${String(dial.port)}` : `through the ${proxyName}`);
    };
    if (literal) {
      progress.log(`${dial.address} is an IP address: nothing to resolve`);
      noteResolved(dial.address);
    } else {
      progress.log(`Resolving ${dial.address}`);
    }
    const socket = net.connect({ host: dial.address, port: dial.port });
    let settled = false;
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (proxy !== undefined && error instanceof ProxyError) {
        // "the proxy refused the user and password" → a line of its own.
        progress.fail(`${error.message.charAt(0).toUpperCase()}${error.message.slice(1)}`);
        reject(
          new SshConnectError('ssh-connect-failed', `${host}: ${error.message}`, {
            host,
            hop: index,
            reason: 'proxy',
            phase: 'tcp',
            ...proxyDetails(),
            proxyReason: error.kind,
            ...(error.detail === undefined ? {} : { proxyDetail: error.detail }),
          }),
        );
        return;
      }
      const reason: ConnectFailure = connectFailureOf(error);
      const phase = resolved ? 'tcp' : 'resolve';
      const what = proxy === undefined ? '' : 'the proxy ';
      progress.fail(
        reason === 'timeout'
          ? `No answer from ${tunnelling ? `${host} through the proxy` : `${what}${dialHost}`} after ${String(hop.connectTimeout)} s`
          : `${phase === 'resolve' ? `Could not resolve ${what}${dial.address}` : `Could not connect to ${what}${dialHost}`} (${failureWords(reason)})`,
      );
      const message =
        reason === 'timeout' ? `no answer after ${String(hop.connectTimeout)} s` : (error as Error).message;
      reject(
        new SshConnectError(
          'ssh-connect-failed',
          `${host}: ${proxy === undefined ? '' : `proxy ${dialHost}: `}${message}`,
          proxy === undefined
            ? {
                host,
                hop: index,
                reason,
                phase,
                ...(reason === 'timeout' ? { timeout: hop.connectTimeout } : {}),
              }
            : {
                host,
                hop: index,
                reason: 'proxy',
                phase,
                ...proxyDetails(),
                proxyReason: reason,
                ...(reason === 'timeout' ? { timeout: hop.connectTimeout } : {}),
              },
        ),
      );
    };
    const timer = setTimeout(() => {
      fail(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }));
    }, hop.connectTimeout * 1000);
    socket.on('lookup', (error: Error | null, address: string | undefined) => {
      if (error !== null || typeof address !== 'string') return;
      progress.log(`Resolved ${dial.address} to ${address}`);
      noteResolved(address);
    });
    socket.on('connectionAttempt', (ip: string, port: number) => {
      progress.log(`Connecting to ${ip} port ${String(port)}`);
    });
    socket.on('connectionAttemptFailed', (ip: string, port: number, _family: number, error: unknown) => {
      progress.log(`${ip} port ${String(port)}: ${failureWords(connectFailureOf(error))}`);
    });
    socket.once('error', fail);
    const open = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeListener('error', fail);
      // ssh2 takes the socket over and handles its errors; this keeps one in between from going unheard.
      socket.on('error', () => undefined);
      resolve(socket);
    };
    socket.once('connect', () => {
      const address = socket.remoteAddress ?? dial.address;
      noteResolved(address);
      progress.log(
        `TCP connection to ${proxy === undefined ? '' : 'the proxy at '}${address} port ${String(dial.port)} open`,
      );
      if (proxy === undefined) {
        progress.done('tcp', `${address}:${String(hop.port)}`);
        open();
        return;
      }
      tunnelling = true;
      const login = proxy.user === undefined ? '' : ` as ${proxy.user}`;
      progress.log(`Asking the proxy${login} for a tunnel to ${host}`);
      openProxyTunnel(socket, proxy, hop.address, hop.port).then(() => {
        if (settled) return;
        progress.log(`The proxy opened a tunnel to ${host}`);
        progress.done('tcp', `through the ${proxyName ?? 'proxy'}`);
        open();
      }, fail);
    });
  });
}

/** How the log names a proxy's kind. */
function proxyKind(proxy: ProxyCredentials): string {
  return proxy.type === 'socks5' ? 'SOCKS5 proxy' : 'HTTP proxy';
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
    case 'proxy':
      return 'the proxy would not open the tunnel';
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
  const sk = await securityKeyAuth(hop, index, options, progress);
  const socket = sock ?? (await openSocket(hop, index, progress));
  return handshake(hop, index, options, socket, onLost, progress, certAuth, sk);
}

/**
 * The hop's security key attempts (#420): a stored sk key, or the sk keys its agent holds (ssh2 drops
 * those). Undefined when there are none. A stored key is read here, before any network.
 */
async function securityKeyAuth(
  hop: HopCredentials,
  index: number,
  options: DialOptions,
  progress: HopProgress,
): Promise<SkAuth | undefined> {
  const host = hostOf(hop);
  let signers: SkSigner[];
  if (hop.auth.kind === 'key' && isSkPrivateKey(hop.auth.privateKey)) {
    const { auth } = hop;
    const refuse = (error: unknown): never => {
      const { code, message, details } = error as SshModelError;
      throw new SshConnectError(code, `${host}: ${message}`, { ...details, host, hop: index });
    };
    if (auth.certificate !== undefined) {
      refuse(new SshModelError('ssh-cert-invalid', 'A certificate for a security key cannot be used yet'));
    }
    let key;
    try {
      key = parseSkPrivateKey(auth.privateKey, auth.passphrase || undefined);
    } catch (error) {
      return refuse(error);
    }
    if (key === undefined) return undefined;
    signers = [
      storedSkSigner(key, auth.label === undefined ? 'the security key' : `security key ${auth.label}`, {
        ...(auth.pin ? { pin: auth.pin } : {}),
        ...(options.fido ? { transport: options.fido } : {}),
        onTouch: () => {
          progress.start('auth', 'touch your security key');
          progress.log('Waiting for you to touch the security key');
        },
      }),
    ];
  } else if (hop.auth.kind === 'agent') {
    signers = await agentSkSigners(hop.auth.socket);
    if (signers.length === 0) return undefined;
    progress.log(`The agent holds ${String(signers.length)} security key${signers.length === 1 ? '' : 's'}`);
  } else {
    return undefined;
  }
  return skAuth(hop.user, signers, (signer) => {
    progress.log(
      signer.via === 'agent'
        ? `Signing with ${signer.label}: touch it if it blinks`
        : `Signing with ${signer.label}${hop.auth.kind === 'key' && hop.auth.pin ? ' and its PIN' : ''}`,
    );
  });
}

function handshake(
  hop: HopCredentials,
  index: number,
  options: DialOptions,
  sock: Duplex,
  onLost: () => void,
  progress: HopProgress,
  certAuth: CertificateAuth | undefined,
  sk: SkAuth | undefined,
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
      readyTimeout: (hop.connectTimeout + (sk ? SK_TOUCH_SECONDS : 0)) * 1000,
      keepaliveInterval: hop.keepAlive > 0 ? hop.keepAlive * 1000 : 0,
      ...(hop.auth.kind === 'password' ? { password: hop.auth.password } : {}),
      ...(certAuth ? { authHandler: certAuth.authHandler } : {}),
      // ssh2 cannot read an sk key: it is offered only through the sk attempts.
      ...(sk && hop.auth.kind === 'key' ? { authHandler: sk.handler(['none']) } : {}),
      ...(sk && hop.auth.kind === 'agent' ? { authHandler: sk.handler(['none', 'agent']) } : {}),
      ...(hop.auth.kind === 'key' && !certAuth && !sk
        ? { privateKey: hop.auth.privateKey, ...(hop.auth.passphrase ? { passphrase: hop.auth.passphrase } : {}) }
        : {}),
      ...(hop.auth.kind === 'agent' ? { agent: hop.auth.socket } : {}),
      // An agent given only to forward is never offered for auth: the hop keeps to its own method.
      ...(forward !== undefined && hop.auth.kind !== 'agent'
        ? {
            agent: forward,
            authHandler: sk ? sk.handler(['none']) : ['none', hop.auth.kind === 'password' ? 'password' : 'publickey'],
          }
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
      const skFailure = sk?.failure as SshModelError | undefined;
      if (skFailure instanceof SshModelError) {
        progress.fail(skFailure.message);
        reject(
          new SshConnectError(skFailure.code, `${host}: ${skFailure.message}`, {
            ...skFailure.details,
            host,
            hop: index,
          }),
        );
      } else if (rejectedKey && !verifierFailed) {
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
      sk?.attach(client);
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
  next: TcpTarget,
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
  return dialHops(options, options.hops.length);
}

/**
 * A TCP connection to `target` for a session that is not SSH (#425): straight, through its proxy, or, with
 * `hops`, a channel from the last SSH jump host. The connection screen shows the target as one hop more.
 * `chain` is the jump chain, when there is one: ending the session ends it.
 *
 * @throws SshConnectError `ssh-connect-failed` (with `reason`), and every refusal of the jump chain's dial
 */
export async function dialTcp(
  options: Omit<DialOptions, 'forwardAgent'> & { readonly target: TcpTarget },
): Promise<{ readonly socket: Duplex; readonly chain?: DialledChain }> {
  const total = options.hops.length + 1;
  const index = options.hops.length;
  const progress = new HopProgress(options.onProgress, index, total, hostOf(options.target));
  const counted = (error: unknown): unknown =>
    error instanceof SshModelError
      ? new SshConnectError(error.code, error.message, { ...error.details, hops: total })
      : error;
  if (options.hops.length === 0) {
    try {
      return { socket: await openSocket(options.target, index, progress) };
    } catch (error) {
      throw counted(error);
    }
  }
  const chain = await dialHops(options, total);
  try {
    const via = options.hops[index - 1] as HopCredentials;
    return { socket: await forwardOut(chain.client, via, options.target, index, progress), chain };
  } catch (error) {
    chain.endAll();
    throw counted(error);
  }
}

/** {@link dialChain}, telling the connection screen there are `shown` hops in all. */
async function dialHops(options: DialOptions, shown: number): Promise<DialledChain> {
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
    const progress = options.hops.map((hop, index) => new HopProgress(options.onProgress, index, shown, hostOf(hop)));
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
      throw new SshConnectError(error.code, error.message, { ...error.details, hops: shown });
    throw error;
  }
}
