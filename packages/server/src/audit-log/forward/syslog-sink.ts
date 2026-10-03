/**
 * Forwards audit events as RFC 5424 syslog over TCP or TLS (issue #209). One message per event,
 * framed by RFC 6587 octet counting, over one persistent connection that is opened on the first send
 * and opened again after an error or the peer closing it.
 *
 * Every step is bounded, since the forwarder holds its claimed queue rows locked during a send: the
 * connect (and TLS handshake) by `connectTimeoutMs`, and the batch's write by `writeTimeoutMs`. A batch
 * counts as accepted once every byte has been handed to the socket without an error. Error messages
 * name the host and port and the cause, never an event.
 */
import { connect as netConnect, type Socket } from 'node:net';
import { hostname as osHostname } from 'node:os';
import { connect as tlsConnect, type ConnectionOptions } from 'node:tls';
import type { AuditEvent } from '@wirebench/engine';
import { FORWARD_TIMEOUT_MS, type ForwardSink } from './forwarder.js';
import { reason, trustAnchors } from './trust.js';

/** Facility 13 (log audit) × 8 + severity 6 (informational). */
const PRI = 13 * 8 + 6;
const APP_NAME = 'wirebench-server';

/**
 * One event as an RFC 5424 message: `<110>1 <at> <hostname> wirebench-server - <action> - <event JSON>`
 * (no PROCID, the action as MSGID, no structured data). An empty hostname is the nil value `-`.
 */
export function syslogMessage(event: AuditEvent, hostname: string): string {
  const host = hostname === '' ? '-' : hostname;
  return `<${PRI}>1 ${event.at} ${host} ${APP_NAME} - ${event.action} - ${JSON.stringify(event)}`;
}

/** RFC 6587 octet counting: the message's length in UTF-8 bytes, a space, then the message. */
export function frame(message: string): Buffer {
  const body = Buffer.from(message, 'utf8');
  return Buffer.concat([Buffer.from(`${body.length} `, 'ascii'), body]);
}

export interface SyslogSinkOptions {
  readonly host: string;
  readonly port: number;
  /** TLS, verified against the system roots plus `ca` (a PEM bundle) when given. */
  readonly tls?: { readonly ca?: string };
  readonly connectTimeoutMs: number;
  /** How long a batch may take to flush; defaults to {@link FORWARD_TIMEOUT_MS}. */
  readonly writeTimeoutMs?: number;
  /** The HOSTNAME field; defaults to `os.hostname()`. */
  readonly hostname?: string;
}

export class SyslogSink implements ForwardSink {
  private readonly options: SyslogSinkOptions;
  private readonly hostname: string;
  private readonly writeTimeoutMs: number;
  private readonly ca: string[] | undefined;
  private socket: Socket | undefined;
  private closed = false;
  /** Sends run one at a time, so two batches never race to open a connection or interleave. */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(options: SyslogSinkOptions) {
    this.options = options;
    this.hostname = options.hostname ?? osHostname();
    this.writeTimeoutMs = options.writeTimeoutMs ?? FORWARD_TIMEOUT_MS;
    this.ca = trustAnchors(options.tls?.ca);
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
      }, this.writeTimeoutMs);
      socket.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.end();
    });
  }

  private async sendNow(events: AuditEvent[]): Promise<void> {
    if (this.closed) throw new Error('the syslog audit sink is closed');
    if (events.length === 0) return;
    const payload = Buffer.concat(events.map((event) => frame(syslogMessage(event, this.hostname))));
    const socket = this.socket ?? (await this.connect());
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        this.drop(socket);
        reject(
          new Error(`audit forward to syslog at ${this.where()} timed out after ${this.writeTimeoutMs} ms writing`),
        );
      }, this.writeTimeoutMs);
      socket.write(payload, (error) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        if (error === undefined || error === null) return resolve();
        this.drop(socket);
        reject(this.failure(error));
      });
    });
  }

  private connect(): Promise<Socket> {
    const { host, port, connectTimeoutMs } = this.options;
    const secure = this.options.tls !== undefined;
    return new Promise((resolve, reject) => {
      const tlsOptions: ConnectionOptions = { host, port, ...(this.ca !== undefined ? { ca: this.ca } : {}) };
      const socket = secure ? tlsConnect(tlsOptions) : netConnect({ host, port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(
          new Error(`audit forward to syslog at ${this.where()} timed out after ${connectTimeoutMs} ms connecting`),
        );
      }, connectTimeoutMs);
      const onError = (error: Error) => {
        clearTimeout(timer);
        socket.destroy();
        reject(this.failure(error));
      };
      socket.once('error', onError);
      socket.once(secure ? 'secureConnect' : 'connect', () => {
        clearTimeout(timer);
        socket.off('error', onError);
        this.adopt(socket);
        resolve(socket);
      });
    });
  }

  /** Keeps `socket` as the connection until it errors or closes; whatever the collector sends is discarded. */
  private adopt(socket: Socket): void {
    this.socket = socket;
    socket.on('error', () => this.drop(socket));
    socket.on('close', () => this.drop(socket));
    socket.on('end', () => this.drop(socket));
    socket.resume();
  }

  private drop(socket: Socket): void {
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
