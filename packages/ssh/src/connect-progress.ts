/**
 * What a connect reports while it runs (#528): each hop's stages with their start and end, and a log of
 * what happened on the wire. Every line is built here from addresses, method names and key names; no
 * password, passphrase, private key or server-sent text other than its version string ever goes in one.
 */

/** One hop's stages, in the order they run. `shell` is the last hop's shell or SFTP channel. */
export type ConnectPhase = 'resolve' | 'tcp' | 'banner' | 'host-key' | 'auth' | 'shell';

export type ConnectProgress =
  | {
      readonly kind: 'phase';
      readonly phase: ConnectPhase;
      readonly state: 'start' | 'done';
      /** 0-based; the target is `hops - 1`. */
      readonly hop: number;
      readonly hops: number;
      /** The hop's `address:port`. */
      readonly host: string;
      /** Milliseconds since the epoch. */
      readonly at: number;
      /** What the stage found or is doing: an address, a server version, a fingerprint, a method. */
      readonly detail?: string;
    }
  | {
      readonly kind: 'log';
      readonly hop: number;
      readonly hops: number;
      readonly host: string;
      readonly at: number;
      readonly line: string;
      /** The line says what failed: the screen draws it in red. */
      readonly error?: true;
    };

/**
 * Why a hop could not be reached, in `ssh-connect-failed` details as `reason`: `dns` the name did not
 * resolve, `refused` nothing listens on the port, `timeout` no answer in time, `unreachable` no route,
 * `reset` the server dropped the connection, `jump` a jump host would not open the channel onwards,
 * `other` anything else.
 */
export type ConnectFailure = 'dns' | 'refused' | 'timeout' | 'unreachable' | 'reset' | 'jump' | 'other';

const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'EAI_NODATA', 'EAI_NONAME']);
const UNREACHABLE_CODES = new Set(['EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL', 'EHOSTDOWN', 'ENETDOWN']);

/** Sorts a socket or ssh2 error into a {@link ConnectFailure}. */
export function connectFailureOf(error: unknown): ConnectFailure {
  const shaped = error as { code?: unknown; level?: unknown; message?: unknown; errors?: unknown } | null;
  // A name with several addresses fails with every attempt's error gathered up; the first says why.
  const first = Array.isArray(shaped?.errors) ? (shaped.errors[0] as { code?: unknown } | undefined) : undefined;
  const code = typeof shaped?.code === 'string' ? shaped.code : first?.code;
  if (typeof code === 'string') {
    if (DNS_CODES.has(code)) return 'dns';
    if (code === 'ECONNREFUSED') return 'refused';
    if (code === 'ETIMEDOUT') return 'timeout';
    if (UNREACHABLE_CODES.has(code)) return 'unreachable';
    if (code === 'ECONNRESET' || code === 'EPIPE') return 'reset';
  }
  if (shaped?.level === 'client-timeout') return 'timeout';
  if (typeof shaped?.message === 'string' && /timed out/i.test(shaped.message)) return 'timeout';
  return 'other';
}

/** Reports one hop's progress; a listener that throws never breaks the connect. */
export class HopProgress {
  /** The stage running now: a failure is laid at its door. */
  current: ConnectPhase | undefined;

  constructor(
    private readonly listener: ((event: ConnectProgress) => void) | undefined,
    private readonly hop: number,
    private readonly hops: number,
    readonly host: string,
  ) {}

  start(phase: ConnectPhase, detail?: string): void {
    this.current = phase;
    this.send({ kind: 'phase', phase, state: 'start', ...this.where(), ...(detail === undefined ? {} : { detail }) });
  }

  done(phase: ConnectPhase, detail?: string): void {
    if (this.current === phase) this.current = undefined;
    this.send({ kind: 'phase', phase, state: 'done', ...this.where(), ...(detail === undefined ? {} : { detail }) });
  }

  log(line: string): void {
    this.send({ kind: 'log', ...this.where(), line });
  }

  /** A log line that says what failed. */
  fail(line: string): void {
    this.send({ kind: 'log', ...this.where(), line, error: true });
  }

  private where(): { hop: number; hops: number; host: string; at: number } {
    return { hop: this.hop, hops: this.hops, host: this.host, at: Date.now() };
  }

  private send(event: ConnectProgress): void {
    try {
      this.listener?.(event);
    } catch {
      // Progress is for the eye only.
    }
  }
}
