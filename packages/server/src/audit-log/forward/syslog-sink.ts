/**
 * Forwards audit events as RFC 5424 syslog over TCP or TLS (issue #209). One message per event,
 * framed by RFC 6587 octet counting, over one persistent connection that is opened on the first send
 * and opened again after an error or the peer closing it.
 *
 * Each send has one deadline, `timeoutMs`, covering the connect (TLS handshake included) and the
 * batch's write, since the forwarder holds its claimed queue rows locked during a send; on expiry the
 * connection is destroyed. A batch counts as accepted once every byte has been handed to the socket
 * without an error. Error messages name the host and port and the cause, never an event.
 */
import { connect as netConnect, Socket } from 'node:net';
import { hostname as osHostname } from 'node:os';
import type { Duplex } from 'node:stream';
import { connect as tlsConnect, TLSSocket } from 'node:tls';
import type { AuditEvent } from '@wirebench/engine';
import { FORWARD_TIMEOUT_MS, type ForwardSink } from './forwarder.js';
import { reason, trustAnchors } from './trust.js';

/** Facility 13 (log audit) × 8 + severity 6 (informational). */
const PRI = 13 * 8 + 6;
const APP_NAME = 'wirebench-server';
/** RFC 5424 §6: `MSGID = NILVALUE / 1*32PRINTUSASCII`, `HOSTNAME = NILVALUE / 1*255PRINTUSASCII`. */
const MSGID_MAX = 32;
const HOSTNAME_MAX = 255;

/** Keeps PRINTUSASCII (33–126) only, at most `max` characters; the nil value `-` when nothing is left. */
function printable(value: string, max: number): string {
  const kept = [...value].filter((c) => c.charCodeAt(0) >= 33 && c.charCodeAt(0) <= 126).join('');
  return kept === '' ? '-' : kept.slice(0, max);
}

/**
 * One event as an RFC 5424 message: `<110>1 <at> <hostname> wirebench-server - <action> - <event JSON>`
 * (no PROCID, the action as MSGID, no structured data). The hostname keeps printable US-ASCII only,
 * at most 255 characters, or is `-`; the MSGID is the action's first 32 characters, and the JSON
 * carries it whole.
 */
export function syslogMessage(event: AuditEvent, hostname: string): string {
  const host = printable(hostname, HOSTNAME_MAX);
  const msgid = printable(event.action, MSGID_MAX);
  return `<${PRI}>1 ${event.at} ${host} ${APP_NAME} - ${msgid} - ${JSON.stringify(event)}`;
}

/** RFC 6587 octet counting: the message's length in UTF-8 bytes, a space, then the message. */
export function frame(message: string): Buffer {
  const body = Buffer.from(message, 'utf8');
  return Buffer.concat([Buffer.from(`${body.length} `, 'ascii'), body]);
}

/** What a connection is opened with; `ca` is the system roots plus the configured bundle. */
export interface SyslogConnectOptions {
  readonly host: string;
  readonly port: number;
  readonly tls: boolean;
  readonly ca?: string[];
}

export interface SyslogSinkOptions {
  readonly host: string;
  readonly port: number;
  /** TLS, verified against the system roots plus `ca` (a PEM bundle) when given. */
  readonly tls?: { readonly ca?: string };
  /** One send's deadline, connect and write together; defaults to {@link FORWARD_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /** The HOSTNAME field; defaults to `os.hostname()`. */
  readonly hostname?: string;
  /**
   * Opens the connection; defaults to `net.connect` or `tls.connect`. A `TLSSocket` is ready on
   * `secureConnect`, a `Socket` on `connect`, and any other stream at once. For tests.
   */
  readonly connect?: (options: SyslogConnectOptions) => Duplex;
}

function defaultConnect(options: SyslogConnectOptions): Duplex {
  const { host, port } = options;
  if (!options.tls) return netConnect({ host, port });
  return tlsConnect({ host, port, ...(options.ca !== undefined ? { ca: options.ca } : {}) });
}

/** The event that says `stream` is ready to write, or `undefined` when it already is. */
function readyEvent(stream: Duplex): string | undefined {
  if (stream instanceof TLSSocket) return 'secureConnect';
  if (stream instanceof Socket) return 'connect';
  return undefined;
}

export class SyslogSink implements ForwardSink {
  private readonly options: SyslogSinkOptions;
  private readonly hostname: string;
  private readonly timeoutMs: number;
  private readonly ca: string[] | undefined;
  private readonly open: (options: SyslogConnectOptions) => Duplex;
  private socket: Duplex | undefined;
  private closed = false;
  /** Sends run one at a time, so two batches never race to open a connection or interleave. */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(options: SyslogSinkOptions) {
    this.options = options;
    this.hostname = options.hostname ?? osHostname();
    this.timeoutMs = options.timeoutMs ?? FORWARD_TIMEOUT_MS;
    this.ca = trustAnchors(options.tls?.ca);
    this.open = options.connect ?? defaultConnect;
  }

  /** Whether a connection is open; it is opened again by the next send. */
  get connected(): boolean {
    return this.socket !== undefined;
  }

  send(events: AuditEvent[]): Promise<void> {
    const run = this.tail.then(() => this.sendNow(events));
    this.tail = run.catch(() => undefined);
    return run;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.tail;
    const socket = this.socket;
    this.socket = undefined;
    if (socket === undefined || socket.destroyed) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        socket.destroy();
        resolve();
      }, this.timeoutMs);
      socket.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.end();
    });
  }

  private sendNow(events: AuditEvent[]): Promise<void> {
    if (this.closed) return Promise.reject(new Error('the syslog audit sink is closed'));
    if (events.length === 0) return Promise.resolve();
    const payload = Buffer.concat(events.map((event) => frame(syslogMessage(event, this.hostname))));
    return new Promise<void>((resolve, reject) => {
      let socket = this.socket;
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error === undefined) return resolve();
        if (socket !== undefined) this.drop(socket);
        reject(error);
      };
      const timer = setTimeout(() => {
        finish(new Error(`audit forward to syslog at ${this.where()} timed out after ${this.timeoutMs} ms`));
      }, this.timeoutMs);
      const write = (stream: Duplex) => {
        stream.write(payload, (error) => finish(error ? this.failure(error) : undefined));
      };
      if (socket !== undefined) return write(socket);

      const { host, port } = this.options;
      const opened = this.open({
        host,
        port,
        tls: this.options.tls !== undefined,
        ...(this.ca !== undefined ? { ca: this.ca } : {}),
      });
      socket = opened;
      const onError = (error: Error) => finish(this.failure(error));
      opened.once('error', onError);
      const ready = () => {
        opened.off('error', onError);
        if (settled) return;
        this.adopt(opened);
        write(opened);
      };
      const event = readyEvent(opened);
      if (event === undefined) ready();
      else opened.once(event, ready);
    });
  }

  /** Keeps `socket` as the connection until it errors or closes; whatever the collector sends is discarded. */
  private adopt(socket: Duplex): void {
    this.socket = socket;
    socket.on('error', () => this.drop(socket));
    socket.on('close', () => this.drop(socket));
    socket.on('end', () => this.drop(socket));
    socket.resume();
  }

  private drop(socket: Duplex): void {
    if (this.socket === socket) this.socket = undefined;
    socket.destroy();
  }

  private where(): string {
    const { host, port } = this.options;
    return host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
  }

  private failure(error: unknown): Error {
    return new Error(`audit forward to syslog at ${this.where()} failed: ${reason(error)}`);
  }
}
