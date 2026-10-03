/**
 * Forwards audit events to an HTTPS endpoint as JSON batches (issue #209): one `POST` per batch with
 * the body `{ "events": [ … ] }` and, when configured, `Authorization: Bearer <token>`. Any 2xx accepts
 * the batch; any other status, a network error or the timeout is a failure. Redirects are never
 * followed (the token must not travel to another origin). Plain `http:` is the same sink, for a
 * loopback collector; config refuses it anywhere else.
 *
 * The whole request, response body included, is bounded by `timeoutMs`, since the forwarder holds its
 * claimed queue rows locked during a send. A collector may reset an idle keep-alive connection just as
 * it is reused; that one case (`ECONNRESET` on a reused socket) is retried once, within the same
 * deadline. Error messages carry the status and the host, never the
 * token or a response body.
 */
import { Agent as HttpAgent, request as httpRequest, type IncomingMessage } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import type { AuditEvent } from '@wirebench/engine';
import { isLoopback } from '../../config.js';
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
    if (this.url.protocol !== 'https:' && this.url.protocol !== 'http:')
      throw new Error('an audit forward URL for this sink must be https://');
    if (this.url.protocol === 'http:' && !isLoopback(this.url.hostname))
      throw new Error('an audit forward to http:// is accepted only for a loopback host; use https://');
    this.token = options.token;
    this.timeoutMs = options.timeoutMs;
    const ca = trustAnchors(options.ca);
    this.agent =
      this.url.protocol === 'https:'
        ? new HttpsAgent({ keepAlive: true, ...(ca !== undefined ? { ca } : {}) })
        : new HttpAgent({ keepAlive: true });
  }

  async send(events: AuditEvent[]): Promise<void> {
    if (this.closed) throw new Error('the HTTPS audit sink is closed');
    if (events.length === 0) return;
    const body = JSON.stringify({ events });
    const deadline = Date.now() + this.timeoutMs;
    const first = await this.attempt(body, this.timeoutMs);
    if (first === undefined) return;
    if (!first.retryable) throw first.error;
    const second = await this.attempt(body, Math.max(1, deadline - Date.now()));
    if (second !== undefined) throw second.error;
  }

  /** One request: `undefined` when the batch was accepted, else why not and whether a retry may help. */
  private attempt(body: string, timeoutMs: number): Promise<{ error: Error; retryable: boolean } | undefined> {
    const host = this.url.host;
    return new Promise((resolve) => {
      let settled = false;
      const settle = (outcome?: { error: Error; retryable: boolean }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(outcome);
      };
      const fail = (message: string, retryable = false) => settle({ error: new Error(message), retryable });
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
            fail(`audit forward to ${host} answered ${status}${redirect}`);
            req.destroy();
            return;
          }
          res.on('end', () => settle());
          res.resume();
        },
      );
      const timer = setTimeout(() => {
        fail(`audit forward to ${host} did not answer within the ${this.timeoutMs} ms deadline`);
        req.destroy();
      }, timeoutMs);
      req.on('error', (error: NodeJS.ErrnoException) => {
        fail(`audit forward to ${host} failed: ${reason(error)}`, error.code === 'ECONNRESET' && req.reusedSocket);
      });
      req.end(body);
    });
  }

  close(): Promise<void> {
    this.closed = true;
    this.agent.destroy();
    return Promise.resolve();
  }
}
