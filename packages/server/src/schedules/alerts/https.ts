/**
 * Delivers a Slack, Teams or webhook alert (scheduled-runs spec §3.4): one JSON `POST` to an `https:`
 * URL whose host is on the allow-list, with a deadline over the whole exchange, response included.
 * Redirects are never followed. A webhook with a secret is signed with
 * `X-Wirebench-Signature: sha256=<hex HMAC-SHA256 of the body>`. Any 2xx delivers; anything else
 * throws an error naming the host and the status, never the URL (it is itself a credential) or a body.
 */
import { createHmac } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { checkEgress, checkedLookup, type EgressPolicy } from '@wirebench/engine';
import { reason, trustAnchors } from '../../audit-log/forward/trust.js';
import { alertHostAllowed } from '../settings.js';

/** Each alert request must finish within this. */
export const ALERT_DEADLINE_MS = 10_000;

export interface HttpsAlert {
  readonly url: string;
  readonly body: unknown;
  /** Signs the body when set (webhook targets). */
  readonly secret?: string;
}

export interface HttpsDeliveryOptions {
  /** Hosts alerts may go to; absent, any https host. */
  readonly alertHosts?: readonly string[];
  /** A PEM bundle added to the system roots. */
  readonly ca?: string;
  readonly timeoutMs?: number;
  /**
   * The egress rule (hosted edition spec §17.5): the connection resolves through the checked lookup, and
   * a literal address in the URL is checked first, since it never reaches a lookup. Absent, unchecked.
   */
  readonly egress?: EgressPolicy;
}

/** The `X-Wirebench-Signature` value for `body` under `secret`. */
export function alertSignature(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
}

export function postAlert(alert: HttpsAlert, options: HttpsDeliveryOptions = {}): Promise<void> {
  const url = new URL(alert.url);
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:') return Promise.reject(new Error(`the alert URL for ${host} is not https://`));
  if (!alertHostAllowed(options, host))
    return Promise.reject(new Error(`alerts may not be sent to ${host} on this server`));
  const body = JSON.stringify(alert.body);
  const timeoutMs = options.timeoutMs ?? ALERT_DEADLINE_MS;
  const ca = trustAnchors(options.ca);
  const literal = host.startsWith('[') ? host.slice(1, -1) : host;
  if (options.egress !== undefined && isIP(literal) !== 0) {
    try {
      checkEgress(host, literal, options.egress);
    } catch (error) {
      return Promise.reject(new Error(`the alert to ${host} failed: ${reason(error)}`));
    }
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error === undefined) resolve();
      else reject(error);
    };
    const req = request(
      url,
      {
        method: 'POST',
        agent: false,
        ...(options.egress !== undefined ? { lookup: checkedLookup(options.egress) } : {}),

        ...(ca !== undefined ? { ca } : {}),
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          ...(alert.secret !== undefined ? { 'x-wirebench-signature': alertSignature(alert.secret, body) } : {}),
        },
      },
      (res: IncomingMessage) => {
        const status = res.statusCode ?? 0;
        res.on('error', () => undefined);
        if (status < 200 || status > 299) {
          const redirect = status >= 300 && status <= 399 ? '; redirects are not followed' : '';
          settle(new Error(`the alert to ${host} was answered ${status}${redirect}`));
          req.destroy();
          return;
        }
        res.on('end', () => settle());
        res.resume();
      },
    );
    const timer = setTimeout(() => {
      settle(new Error(`the alert to ${host} did not finish within ${timeoutMs} ms`));
      req.destroy();
    }, timeoutMs);
    req.on('error', (error) => settle(new Error(`the alert to ${host} failed: ${reason(error)}`)));
    req.end(body);
  });
}
