import { randomUUID } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { HopProgress } from './connect-progress.js';
import { dialTcp, hostOf } from './dial.js';
import type { DialOptions, HopCredentials, TcpTarget } from './dial.js';
import type { SessionEndReason, SessionExit, SshSession } from './session.js';

/** Telnet commands (RFC 854). */
const IAC = 255;
const DONT = 254;
const DO = 253;
const WONT = 252;
const WILL = 251;
const SB = 250;
const SE = 240;
const CR = 13;
const LF = 10;
const NUL = 0;

/** The options Wirebench negotiates; every other one is refused. */
export const TELNET_OPTION = { binary: 0, echo: 1, sga: 3, ttype: 24, naws: 31 } as const;
const TTYPE_IS = 0;
const TTYPE_SEND = 1;

/** What the server may do (its WILL is answered DO): echo, suppress go-ahead, send binary. */
const SERVER_MAY: ReadonlySet<number> = new Set([TELNET_OPTION.echo, TELNET_OPTION.sga, TELNET_OPTION.binary]);
/** What Wirebench does when asked (DO is answered WILL): terminal type, window size, suppress go-ahead, binary. */
const CLIENT_WILL: ReadonlySet<number> = new Set([
  TELNET_OPTION.ttype,
  TELNET_OPTION.naws,
  TELNET_OPTION.sga,
  TELNET_OPTION.binary,
]);

/** One side of one option: off, on, or asked for and not answered yet (RFC 1143, simplified). */
type OptionState = 'no' | 'yes' | 'asked';

type ParseState = 'data' | 'iac' | 'verb' | 'sb' | 'sb-iac';

/** What one read off the wire gives: the terminal's bytes, and what to send back at once. */
export interface TelnetReceived {
  readonly data: Uint8Array;
  readonly reply: Uint8Array;
}

/**
 * Telnet option negotiation and framing, with no I/O: bytes from the server go in, the terminal's bytes and
 * the answers come out; the terminal's input goes in, the bytes to send come out. Each side of each option is
 * tracked so an answer is never answered again.
 */
export class TelnetCodec {
  private readonly us = new Map<number, OptionState>();
  private readonly him = new Map<number, OptionState>();
  private state: ParseState = 'data';
  private verb = 0;
  private sub: number[] = [];
  private afterCr = false;
  private size: { cols: number; rows: number };

  constructor(
    private readonly terminalType: string,
    size: { readonly cols: number; readonly rows: number },
  ) {
    this.size = { cols: size.cols, rows: size.rows };
  }

  /** The offers sent as the connection opens: WILL TTYPE, WILL NAWS, DO SGA. */
  start(): Uint8Array {
    this.us.set(TELNET_OPTION.ttype, 'asked');
    this.us.set(TELNET_OPTION.naws, 'asked');
    this.him.set(TELNET_OPTION.sga, 'asked');
    return Uint8Array.from([IAC, WILL, TELNET_OPTION.ttype, IAC, WILL, TELNET_OPTION.naws, IAC, DO, TELNET_OPTION.sga]);
  }

  /** Whether the server agreed to `option` on its side (`WILL` answered or acknowledged). */
  serverDoes(option: number): boolean {
    return this.him.get(option) === 'yes';
  }

  /** Whether this side agreed to `option`. */
  clientDoes(option: number): boolean {
    return this.us.get(option) === 'yes';
  }

  receive(chunk: Uint8Array): TelnetReceived {
    const data: number[] = [];
    const reply: number[] = [];
    for (const byte of chunk) {
      switch (this.state) {
        case 'data':
          if (byte === IAC) {
            this.state = 'iac';
          } else if (this.afterCr && byte === NUL) {
            // CR NUL is a bare carriage return.
            this.afterCr = false;
          } else {
            this.afterCr = byte === CR;
            data.push(byte);
          }
          break;
        case 'iac':
          if (byte === IAC) {
            data.push(IAC);
            this.afterCr = false;
            this.state = 'data';
          } else if (byte === WILL || byte === WONT || byte === DO || byte === DONT) {
            this.verb = byte;
            this.state = 'verb';
          } else if (byte === SB) {
            this.sub = [];
            this.state = 'sb';
          } else {
            // NOP, GA, DM, BRK and the rest carry nothing for a terminal.
            this.state = 'data';
          }
          break;
        case 'verb':
          reply.push(...this.negotiate(this.verb, byte));
          this.state = 'data';
          break;
        case 'sb':
          if (byte === IAC) this.state = 'sb-iac';
          else this.sub.push(byte);
          break;
        case 'sb-iac':
          if (byte === IAC) {
            this.sub.push(IAC);
            this.state = 'sb';
          } else {
            // IAC SE ends it; anything else after IAC is malformed, and ends it too.
            if (byte === SE) reply.push(...this.subnegotiate(this.sub));
            this.sub = [];
            this.state = 'data';
          }
          break;
      }
    }
    return { data: Uint8Array.from(data), reply: Uint8Array.from(reply) };
  }

  /**
   * The terminal's input as Telnet bytes: IAC doubled, and Enter (CR) sent as CR LF, the Telnet newline, unless
   * both directions are binary.
   */
  encode(input: Uint8Array): Uint8Array {
    const binary = this.clientDoes(TELNET_OPTION.binary) && this.serverDoes(TELNET_OPTION.binary);
    const out: number[] = [];
    for (let i = 0; i < input.length; i += 1) {
      const byte = input[i] as number;
      if (byte === IAC) out.push(IAC, IAC);
      else if (byte === CR && !binary) {
        out.push(CR, LF);
        // A pasted CR LF is one newline, not two.
        if (input[i + 1] === LF) i += 1;
      } else out.push(byte);
    }
    return Uint8Array.from(out);
  }

  /** The window size to send now; empty while NAWS is not agreed. */
  resize(cols: number, rows: number): Uint8Array {
    this.size = { cols, rows };
    return this.clientDoes(TELNET_OPTION.naws) ? Uint8Array.from(this.naws()) : new Uint8Array(0);
  }

  private negotiate(verb: number, option: number): number[] {
    if (verb === WILL || verb === WONT) {
      const state = this.him.get(option) ?? 'no';
      if (verb === WILL) {
        if (state === 'yes') return [];
        if (!SERVER_MAY.has(option)) return state === 'no' ? [IAC, DONT, option] : [];
        this.him.set(option, 'yes');
        return state === 'asked' ? [] : [IAC, DO, option];
      }
      if (state === 'no') return [];
      this.him.set(option, 'no');
      return state === 'yes' ? [IAC, DONT, option] : [];
    }
    const state = this.us.get(option) ?? 'no';
    if (verb === DO) {
      if (state === 'yes') return [];
      if (!CLIENT_WILL.has(option)) return state === 'no' ? [IAC, WONT, option] : [];
      this.us.set(option, 'yes');
      const answer = state === 'asked' ? [] : [IAC, WILL, option];
      return option === TELNET_OPTION.naws ? [...answer, ...this.naws()] : answer;
    }
    if (state === 'no') return [];
    this.us.set(option, 'no');
    return state === 'yes' ? [IAC, WONT, option] : [];
  }

  private subnegotiate(sub: readonly number[]): number[] {
    if (
      sub[0] === TELNET_OPTION.ttype &&
      sub[1] === TTYPE_SEND &&
      (this.us.get(TELNET_OPTION.ttype) ?? 'no') !== 'no'
    ) {
      return [IAC, SB, TELNET_OPTION.ttype, TTYPE_IS, ...Buffer.from(this.terminalType, 'ascii'), IAC, SE];
    }
    return [];
  }

  private naws(): number[] {
    const { cols, rows } = this.size;
    const bytes = [(cols >> 8) & 0xff, cols & 0xff, (rows >> 8) & 0xff, rows & 0xff].flatMap((b) =>
      b === IAC ? [IAC, IAC] : [b],
    );
    return [IAC, SB, TELNET_OPTION.naws, ...bytes, IAC, SE];
  }
}

/** Colours, cursor moves and window titles: a prompt is matched on the text a person reads. */
const ESCAPES = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-_]/g;
const USER_PROMPT = /(?:login|user ?name|user)\s*:$/i;
const PASSWORD_PROMPT = /password\s*:$/i;
/** How long after the connection opens a prompt is still answered. */
export const TELNET_SIGN_IN_MS = 30_000;

/**
 * Types the host's user and password at the device's prompts, once each (#425): the login prompt gets the
 * user, the password prompt the password. A prompt with nothing to answer, the person typing, or 30 seconds
 * passing ends it; from then on the session is theirs.
 */
export class TelnetSignIn {
  private tail = '';
  private sentUser = false;
  private finished: boolean;
  private readonly started: number;

  constructor(
    private readonly login: { readonly user?: string | undefined; readonly password?: string | undefined },
    private readonly now: () => number = Date.now,
  ) {
    this.started = now();
    this.finished = login.user === undefined && login.password === undefined;
  }

  get done(): boolean {
    return this.finished;
  }

  /** The person typed: the session is theirs. */
  stop(): void {
    this.finished = true;
  }

  /** The server's text; answers with what to type, or undefined. */
  feed(text: string): { readonly answer: string; readonly field: 'user' | 'password' } | undefined {
    if (this.finished) return undefined;
    if (this.now() - this.started > TELNET_SIGN_IN_MS) {
      this.finished = true;
      return undefined;
    }
    this.tail = (this.tail + text).replace(ESCAPES, '').slice(-256);
    const shown = this.tail.trimEnd();
    if (PASSWORD_PROMPT.test(shown)) {
      this.finished = true;
      return this.login.password === undefined ? undefined : { answer: `${this.login.password}\r`, field: 'password' };
    }
    if (!this.sentUser && USER_PROMPT.test(shown)) {
      if (this.login.user === undefined) {
        this.finished = true;
        return undefined;
      }
      this.sentUser = true;
      this.tail = '';
      // Without a password nothing is left to type.
      if (this.login.password === undefined) this.finished = true;
      return { answer: `${this.login.user}\r`, field: 'user' };
    }
    return undefined;
  }
}

export interface OpenTelnetOptions extends Omit<DialOptions, 'hops' | 'forwardAgent'> {
  /** The SSH jump hosts, outermost first; empty connects directly (through `target.proxy` when set). */
  readonly hops: readonly HopCredentials[];
  readonly target: TcpTarget;
  readonly cols: number;
  readonly rows: number;
  /** Typed at the login and password prompts; neither set leaves the sign-in to the person. */
  readonly login?: { readonly user?: string; readonly password?: string };
  /** `xterm-256color` unless set. */
  readonly terminalType?: string;
}

/**
 * Opens a Telnet session (#425): a TCP connection to the target, straight, through a proxy, or as a channel
 * from the last SSH jump host, then option negotiation and the sign-in. The answer is an {@link SshSession},
 * so the terminal tab, the masker, logs and reconnect treat it as any other.
 *
 * @throws SshConnectError `ssh-connect-failed` and every refusal of the jump chain's SSH dial
 */
export async function openTelnetSession(options: OpenTelnetOptions): Promise<SshSession> {
  const { socket, chain } = await dialTcp(options);
  const index = options.hops.length;
  const progress = new HopProgress(options.onProgress, index, index + 1, hostOf(options.target));
  const terminalType = options.terminalType ?? 'xterm-256color';
  progress.start('shell', 'telnet');
  progress.log(
    `Negotiating Telnet options (terminal ${terminalType}, ${String(options.cols)}×${String(options.rows)})`,
  );
  progress.log(
    index === 0
      ? 'Telnet is not encrypted: everything typed and shown travels in plain text'
      : `Telnet is not encrypted after the jump host: the leg to ${hostOf(options.target)} is plain text`,
  );
  const codec = new TelnetCodec(terminalType, { cols: options.cols, rows: options.rows });
  const signIn = new TelnetSignIn(options.login ?? {});
  if (!signIn.done) progress.log('Wirebench types the sign-in at the login and password prompts');
  progress.done('shell', 'telnet');
  return wrapTelnet(socket, codec, signIn, chain, progress);
}

function wrapTelnet(
  socket: Duplex,
  codec: TelnetCodec,
  signIn: TelnetSignIn,
  chain: { readonly lost: boolean; endAll(): void } | undefined,
  progress: HopProgress,
): SshSession {
  const dataListeners = new Set<(data: Uint8Array) => void>();
  const exitListeners = new Set<(exit: SessionExit) => void>();
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let exited = false;
  let failed = false;
  const send = (bytes: Uint8Array): void => {
    if (bytes.length > 0 && !exited) socket.write(bytes);
  };
  const exit = (reason: SessionEndReason): void => {
    if (exited) return;
    exited = true;
    for (const listener of exitListeners) listener({ code: null, reason });
    socket.destroy();
    chain?.endAll();
  };
  socket.on('data', (chunk: Buffer) => {
    const { data, reply } = codec.receive(chunk);
    send(reply);
    if (data.length === 0) return;
    for (const listener of dataListeners) listener(data);
    if (signIn.done) return;
    const typed = signIn.feed(decoder.decode(data, { stream: true }));
    if (typed !== undefined) {
      progress.log(typed.field === 'user' ? 'Typed the user at the login prompt' : 'Typed the password');
      send(codec.encode(Buffer.from(typed.answer, 'utf8')));
    }
  });
  socket.on('error', () => {
    failed = true;
  });
  socket.on('close', () => {
    // A reset or a jump host's connection going is a lost link; the server hanging up is the session's end.
    exit(failed || chain?.lost === true ? 'lost' : 'exit');
  });
  send(codec.start());
  // A proxy's handshake leaves the socket paused, with what the server sent first put back.
  socket.resume();
  return {
    id: randomUUID(),
    agentForwarding: 'off',
    write: (data) => {
      // Keys typed hand the sign-in over; an empty write or the terminal's own reply (ESC …) does not.
      if (data.length > 0 && data[0] !== 0x1b) signIn.stop();
      send(codec.encode(data));
    },
    resize: (cols, rows) => {
      send(codec.resize(cols, rows));
    },
    close: () => {
      exit('closed');
    },
    // Telnet has no channel to run a command on beside the terminal.
    exec: () => Promise.resolve(''),
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
