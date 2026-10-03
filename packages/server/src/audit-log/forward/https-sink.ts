/**
 * Forwards audit events to an HTTPS endpoint as JSON batches (issue #209): one `POST` per batch with
 * the body `{ "events": [ … ] }` and, when configured, `Authorization: Bearer <token>`. Any 2xx accepts
 * the batch; any other status, a network error or the timeout is a failure. Redirects are never
 * followed (the token must not travel to another origin). Plain `http:` is the same sink, for a
 * loopback collector; config refuses it anywhere else.
 *
 * The whole request, response body included, is bounded by `timeoutMs`, since the forwarder holds its
 * claimed queue rows locked during a send. Error messages carry the status and the host, never the
 * token or a response body.
 */
import { Agent as HttpAgent, request as httpRequest, type IncomingMessage } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import type { AuditEvent } from '@wirebench/engine';
import type { ForwardSink } from './forwarder.js';
import { reason, trustAnchors } from './trust.js';

export interface HttpsSinkOptions {
  readonly url: string;
  readonly token?: string;
  /** A PEM bundle added to the system roots. */
  readonly ca?: string;
  readonly timeoutMs: number;
}

export class HttpsSink implements ForwardSink {
  private readonly url: URL;
  private readonly token: string | undefined;
  private readonly timeoutMs: number;
  private readonly agent: HttpAgent;
  private closed = false;

  constructor(options: HttpsSinkOptions) {
    this.url = new URL(options.url);
    this.token = options.token;
    this.timeoutMs = options.timeoutMs;
    const ca = trustAnchors(options.ca);
    this.agent =
      this.url.protocol === 'https:'
        ? new HttpsAgent({ keepAlive: true, ...(ca !== undefined ? { ca } : {}) })
        : new HttpAgent({ keepAlive: true });
  }

  send(events: AuditEvent[]): Promise<void> {
    if (this.closed) return Promise.reject(new Error('the HTTPS audit sink is closed'));
    if (events.length === 0) return Promise.resolve();
    const body = JSON.stringify({ events });
    const host = this.url.host;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error === undefined) resolve();
        else reject(error);
      };
      const request = this.url.protocol === 'https:' ? httpsRequest : httpRequest;
      const req = request(
        this.url,
        {
          method: 'POST',
          agent: this.agent,
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
            ...(this.token !== undefined ? { authorization: `Bearer ${this.token}` } : {}),
          },
        },
        (res: IncomingMessage) => {
          const status = res.statusCode ?? 0;
          res.on('error', () => undefined);
          if (status < 200 || status > 299) {
            const redirect = status >= 300 && status <= 399 ? '; redirects are not followed' : '';
            settle(new Error(`audit forward to ${host} answered ${status}${redirect}`));
            req.destroy();
            return;
          }
          res.on('end', () => settle());
          res.resume();
        },
      );
      const timer = setTimeout(() => {
        settle(new Error(`audit forward to ${host} timed out after ${this.timeoutMs} ms`));
        req.destroy();
      }, this.timeoutMs);
      req.on('error', (error) => settle(new Error(`audit forward to ${host} failed: ${reason(error)}`)));
      req.end(body);
    });
  }

  close(): Promise<void> {
    this.closed = true;
    this.agent.destroy();
    return Promise.resolve();
  }
}
