/**
 * Certificate expiry: how long a certificate has left, the certificates a PEM text holds, and a
 * bare TLS handshake that reads the chain an endpoint presents without sending it a request.
 *
 * The desktop app runs these across every open project to warn before an endpoint's chain, a
 * keystore or the CA bundle expires; nothing here reads a file or decides what to check.
 */

import { X509Certificate } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import type { Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { captureSslInfo, splitPemBundle } from './tls.js';
import type { SslInfo, TlsSocketLike } from './tls.js';
import type { ProxyOptions } from './types.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Where a certificate stands against the warning window. `unknown` when its date does not parse. */
export type CertificateExpiryStatus = 'ok' | 'expiring' | 'expired' | 'unknown';

/** {@link certificateExpiry}'s answer. */
export interface CertificateExpiry {
  readonly status: CertificateExpiryStatus;
  /**
   * Whole days left, rounded up so a certificate with hours to go reads 1 rather than 0; `0` or
   * less once it has expired. Absent for `unknown`.
   */
  readonly daysLeft?: number;
}

/**
 * Where a certificate ending at `validTo` stands at `now`.
 *
 * @param validTo the certificate's end of validity, as ISO 8601 (or any text `Date` parses)
 * @param warnDays how many days ahead of expiry count as `expiring`
 * @param now the moment to judge at, in epoch milliseconds; the current time when absent
 * @returns `expired` at or after `validTo`, `expiring` within `warnDays` of it, else `ok`
 */
export function certificateExpiry(validTo: string, warnDays: number, now: number = Date.now()): CertificateExpiry {
  const end = new Date(validTo).getTime();
  if (Number.isNaN(end)) {
    return { status: 'unknown' };
  }
  const remaining = end - now;
  const daysLeft = Math.ceil(remaining / DAY_MS);
  if (remaining <= 0) {
    return { status: 'expired', daysLeft };
  }
  return { status: remaining <= warnDays * DAY_MS ? 'expiring' : 'ok', daysLeft };
}

/** One certificate read out of PEM text: just what an expiry warning names. */
export interface PemCertificateSummary {
  /** Distinguished name, rendered `CN=…, O=…`. */
  readonly subject: string;
  readonly issuer: string;
  /** ISO 8601. */
  readonly validTo: string;
  /** SHA-256 fingerprint as 64 lower-case hex characters. */
  readonly fingerprint256: string;
}

/** Node prints a DN one attribute per line; the rest of the app shows `CN=…, O=…`. */
function oneLineDn(dn: string): string {
  return dn
    .split('\n')
    .filter((part) => part.length > 0)
    .join(', ');
}

/**
 * Every certificate in a PEM text, in file order. A block that does not parse is skipped: this
 * feeds a warning, and a certificate nothing can read is not one anything can expire.
 *
 * @param pem one or more `BEGIN CERTIFICATE` blocks, with anything else around them ignored
 * @returns a summary per readable certificate
 */
export function pemCertificates(pem: string): PemCertificateSummary[] {
  const summaries: PemCertificateSummary[] = [];
  for (const block of splitPemBundle(pem)) {
    try {
      const cert = new X509Certificate(block);
      summaries.push({
        subject: oneLineDn(cert.subject),
        issuer: oneLineDn(cert.issuer),
        validTo: new Date(cert.validTo).toISOString(),
        fingerprint256: cert.fingerprint256.replace(/:/g, '').toLowerCase(),
      });
    } catch {
      // Not a certificate Node can read; see the doc comment.
    }
  }
  return summaries;
}

/** Where a TLS handshake goes. */
export interface TlsProbeTarget {
  /** A DNS name (also sent as SNI) or an IP literal, without IPv6 brackets. */
  readonly host: string;
  readonly port: number;
}

/** The schemes that speak TLS, with their default ports. */
const TLS_SCHEMES: Readonly<Record<string, number>> = { 'https:': 443, 'wss:': 443, 'grpcs:': 443 };

/**
 * The TLS endpoint behind a URL, or `undefined` when the URL does not speak TLS (or is not a URL).
 *
 * @param url an `https:`, `wss:` or `grpcs:` URL
 * @returns the host and port, the scheme's default port when the URL names none
 */
export function tlsProbeTarget(url: string): TlsProbeTarget | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const defaultPort = TLS_SCHEMES[parsed.protocol];
  if (defaultPort === undefined || parsed.hostname.length === 0) {
    return undefined;
  }
  const host = parsed.hostname.startsWith('[') ? parsed.hostname.slice(1, -1) : parsed.hostname;
  return { host, port: parsed.port.length > 0 ? Number(parsed.port) : defaultPort };
}

/** Options for {@link probeTlsChain}. */
export interface ProbeTlsChainOptions {
  /** The proxy a send to this endpoint would go through; the handshake tunnels through `CONNECT`. */
  readonly proxy?: ProxyOptions;
  /** Trust anchors to verify the chain against, as a send would; Node's defaults when absent. */
  readonly ca?: readonly string[];
  /** Gives up after this long. Default 10 s. */
  readonly timeoutMs?: number;
}

const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

/** `host:port`, bracketing an IPv6 literal, as a `CONNECT` line and a `Host` header want it. */
function authority(target: TlsProbeTarget): string {
  return `${isIP(target.host) === 6 ? `[${target.host}]` : target.host}:${String(target.port)}`;
}

/** Opens a `CONNECT` tunnel to `target` through `proxy`. */
function tunnel(proxy: ProxyOptions, target: TlsProbeTarget, signal: AbortSignal): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const proxyUrl = new URL(proxy.url);
    const secure = proxyUrl.protocol === 'https:';
    const request = (secure ? httpsRequest : httpRequest)({
      host: proxyUrl.hostname.startsWith('[') ? proxyUrl.hostname.slice(1, -1) : proxyUrl.hostname,
      port: proxyUrl.port.length > 0 ? Number(proxyUrl.port) : secure ? 443 : 80,
      method: 'CONNECT',
      path: authority(target),
      headers: {
        host: authority(target),
        ...(proxy.auth !== undefined
          ? {
              'proxy-authorization': `Basic ${Buffer.from(`${proxy.auth.username}:${proxy.auth.password}`).toString('base64')}`,
            }
          : {}),
      },
      signal,
    });
    request.once('connect', (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`The proxy refused the tunnel to ${authority(target)}: HTTP ${String(response.statusCode)}.`));
        return;
      }
      resolve(socket);
    });
    request.once('error', reject);
    request.end();
  });
}

/**
 * True for the error a TLS handshake fails with when the peer's chain does not verify: expired,
 * not yet valid, issued by nothing the trust anchors know, or not issued for the host. Its `code`
 * is OpenSSL's reason (`CERT_HAS_EXPIRED`, `SELF_SIGNED_CERT_IN_CHAIN`, …) or Node's
 * `ERR_TLS_CERT_ALTNAME_INVALID`.
 */
export function isCertificateVerifyError(error: unknown): error is Error & { readonly code: string } {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  return (
    typeof code === 'string' &&
    (/^(CERT_|UNABLE_TO_(GET|VERIFY|DECRYPT|DECODE)_|DEPTH_ZERO_SELF_SIGNED_CERT$|SELF_SIGNED_CERT_IN_CHAIN$|INVALID_CA$|PATH_LENGTH_EXCEEDED$|HOSTNAME_MISMATCH$)/.test(
      code,
    ) ||
      code === 'ERR_TLS_CERT_ALTNAME_INVALID')
  );
}

/**
 * Reads the certificate chain `target` presents, from a TLS handshake alone: nothing is sent once
 * it completes, and the connection is closed straight away.
 *
 * The chain is verified exactly as a send verifies it, against `ca` (Node's roots when absent) and
 * the host name. One that does not verify fails the handshake — Node keeps nothing of a chain it
 * rejected — with an error {@link isCertificateVerifyError} recognises, whose `code` says why: an
 * expired certificate is `CERT_HAS_EXPIRED`. No client certificate is offered, so a server that
 * insists on one may refuse the handshake; that surfaces as an ordinary error.
 *
 * @param target the host and port to reach
 * @param options the proxy to tunnel through, trust anchors, and a timeout
 * @returns the connection snapshot, `peerChain` leaf first
 * @throws Error when the endpoint (or the proxy) cannot be reached, the chain does not verify, or
 * the handshake fails
 */
export async function probeTlsChain(target: TlsProbeTarget, options: ProbeTlsChainOptions = {}): Promise<SslInfo> {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const timeout = new Error(`No TLS handshake with ${authority(target)} within ${String(timeoutMs)} ms.`);
  const timer = setTimeout(() => {
    controller.abort(timeout);
  }, timeoutMs);
  try {
    const socket = options.proxy !== undefined ? await tunnel(options.proxy, target, controller.signal) : undefined;
    return await new Promise<SslInfo>((resolve, reject) => {
      const tls = tlsConnect({
        ...(socket !== undefined ? { socket } : { host: target.host, port: target.port }),
        // An IP literal is not a valid SNI name; Node warns about one and OpenSSL drops it anyway.
        ...(isIP(target.host) === 0 ? { servername: target.host } : {}),
        ...(options.ca !== undefined ? { ca: [...options.ca] } : {}),
      });
      const abort = (): void => {
        tls.destroy();
        reject(timeout);
      };
      controller.signal.addEventListener('abort', abort, { once: true });
      tls.once('secureConnect', () => {
        controller.signal.removeEventListener('abort', abort);
        const info = captureSslInfo(tls as TlsSocketLike);
        tls.destroy();
        resolve(info);
      });
      tls.once('error', (error: Error) => {
        controller.signal.removeEventListener('abort', abort);
        tls.destroy();
        reject(error);
      });
    });
  } catch (error) {
    throw controller.signal.aborted ? timeout : error;
  } finally {
    clearTimeout(timer);
  }
}
