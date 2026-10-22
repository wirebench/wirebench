/**
 * Proxy resolution: turns the user's stored {@link ProxyConfig} into the per-request
 * {@link ProxyOptions} the transport hands to undici's `ProxyAgent`, or `undefined` when the
 * request must go direct.
 *
 * Three things live here and nowhere else: the exclude-list matcher (hostname globs, CIDR
 * blocks and the `localhost` shorthand), the parser for the PAC-style string Chromium's
 * `session.resolveProxy` answers with, and the precedence between the two. Everything is pure
 * — no Electron, no DNS, no sockets — so the whole table is unit-testable, and the desktop's
 * main process only has to inject `resolveSystem` and the resolved password.
 */

import { WirebenchError } from '../errors.js';
import type { ProxyOptions } from './types.js';

/**
 * How the user configured the proxy. `passwordRef` is an opaque handle into the OS keychain:
 * the password itself never appears here, and never crosses IPC — main resolves it and passes
 * it to {@link resolveProxyFor} separately.
 */
export type ProxyConfig =
  | { readonly mode: 'none' }
  | {
      readonly mode: 'system';
      /** Hosts that go direct even when the system says to proxy them. */
      readonly excludes?: readonly string[];
    }
  | {
      readonly mode: 'manual';
      readonly host: string;
      readonly port: number;
      readonly username?: string;
      /** Opaque reference into the OS-keychain-backed secret store. Never a password. */
      readonly passwordRef?: string;
      /** Hostname globs (`*.corp.test`), CIDR blocks (`10.0.0.0/8`) or `localhost`. */
      readonly excludes: readonly string[];
    };

/** Everything {@link resolveProxyFor} needs that the stored config cannot carry itself. */
export interface ResolveProxyOptions {
  /**
   * Answers Chromium's PAC-style proxy string for a URL (`DIRECT`, `PROXY host:port`, …).
   * Supplied by the desktop main process as a wrapper around `session.resolveProxy`; without
   * it, `mode: 'system'` resolves to no proxy rather than guessing.
   */
  readonly resolveSystem?: (url: string) => string | undefined;
  /** The password behind `passwordRef`, already decrypted by main. */
  readonly password?: string;
}

/** True when `text` is an IPv4 dotted quad. */
function isIpv4(text: string): boolean {
  const parts = text.split('.');
  return (
    parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255)
  );
}

/** An IPv4 dotted quad as a 32-bit unsigned integer. */
function ipv4ToInt(text: string): number {
  return text.split('.').reduce((accumulated, part) => accumulated * 256 + Number(part), 0);
}

/** Whether `host` (an IPv4 literal) falls inside the `a.b.c.d/bits` block `cidr`. */
function matchesCidr(host: string, cidr: string): boolean {
  const slash = cidr.indexOf('/');
  if (slash === -1) return false;
  const network = cidr.slice(0, slash);
  const bits = Number(cidr.slice(slash + 1));
  if (!isIpv4(network) || !isIpv4(host) || !Number.isInteger(bits) || bits < 0 || bits > 32) {
    return false;
  }
  if (bits === 0) return true;
  // `>>> 0` keeps the shift unsigned; JS bitwise operators work on signed 32-bit ints.
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4ToInt(host) & mask) >>> 0 === (ipv4ToInt(network) & mask) >>> 0;
}

/** The loopback spellings the `localhost` shorthand stands for in a proxy exclude list. */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Turns a hostname glob (`*.corp.test`) into an anchored, case-insensitive regular expression. */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

/**
 * Whether `hostname` is covered by one entry of an exclude list.
 *
 * An entry matches when it is the host verbatim, a glob the host matches, a CIDR block the
 * host's IPv4 literal falls in, or the `localhost` shorthand and the host is any loopback
 * spelling. A leading `.` (`.corp.test`) is read as "this domain and its subdomains", which
 * is how `no_proxy` and the usual proxy exclude lists spell it.
 *
 * @param hostname the host being connected to, without port or brackets
 * @param excludes the configured exclude entries
 */
export function isExcluded(hostname: string, excludes: readonly string[]): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  for (const raw of excludes) {
    const entry = raw.trim().toLowerCase();
    if (entry.length === 0) continue;
    if (entry === '*') return true;
    if (entry === 'localhost' && LOOPBACK.has(host)) return true;
    if (entry === host) return true;
    if (entry.startsWith('.') && (host === entry.slice(1) || host.endsWith(entry))) return true;
    if (entry.includes('/') && matchesCidr(host, entry)) return true;
    if (entry.includes('*') && globToRegExp(entry).test(host)) return true;
  }
  return false;
}

/**
 * What the system (PAC) answer amounts to, once read most-preferred-entry-first.
 *
 * `unsupported` exists because undici's `ProxyAgent` cannot speak SOCKS: a SOCKS-only answer is
 * neither a proxy we can dial nor a licence to connect directly (the direct route is usually
 * exactly what the firewall drops), so it is reported and the send fails with a message naming
 * the scheme rather than hanging or timing out for no visible reason.
 */
export type SystemProxyResolution =
  | { readonly kind: 'direct' }
  | { readonly kind: 'proxy'; readonly url: string }
  | { readonly kind: 'unsupported'; readonly scheme: string };

/** The PAC keywords that name a SOCKS proxy, lower-cased as {@link SystemProxyResolution.scheme}. */
const SOCKS_KEYWORDS = new Set(['socks', 'socks4', 'socks5']);

/**
 * Parses the PAC-style string `session.resolveProxy` answers with — a `;`-separated list of
 * `DIRECT`, `PROXY host:port`, `HTTPS host:port` or `SOCKS…` entries, most-preferred first —
 * into what the transport should do.
 *
 * Only the first usable HTTP(S) entry is taken: the transport has one connection to make and
 * no way to fail over. A SOCKS entry is skipped in favour of anything usable after it (and of a
 * `DIRECT` the user's own PAC file offered as a fallback); a SOCKS-only answer yields
 * `unsupported`, which the caller turns into a `proxy-unsupported` failure.
 *
 * @param pacResult the raw string from `session.resolveProxy`
 * @returns `direct`, the `http(s)://host:port` proxy to dial, or the unsupported scheme
 */
export function parseSystemProxy(pacResult: string | undefined): SystemProxyResolution {
  if (pacResult === undefined) return { kind: 'direct' };
  let socksScheme: string | undefined;
  for (const raw of pacResult.split(';')) {
    const entry = raw.trim();
    if (entry.length === 0) continue;
    const match = /^([A-Za-z][A-Za-z0-9]*)(?:\s+(\S+))?$/.exec(entry);
    if (match === null) continue;
    const keyword = (match[1] ?? '').toUpperCase();
    const authority = match[2];
    if (keyword === 'DIRECT') return { kind: 'direct' };
    if (SOCKS_KEYWORDS.has(keyword.toLowerCase())) {
      socksScheme ??= keyword.toLowerCase();
      continue;
    }
    if (keyword !== 'PROXY' && keyword !== 'HTTP' && keyword !== 'HTTPS') continue;
    if (authority === undefined || authority.length === 0) continue;
    return { kind: 'proxy', url: `${keyword === 'HTTPS' ? 'https' : 'http'}://${authority}` };
  }
  return socksScheme === undefined ? { kind: 'direct' } : { kind: 'unsupported', scheme: socksScheme };
}

/** The `ProxyOptions` for a proxy URL plus optional credentials, dropping an empty username. */
function withAuth(url: string, username: string | undefined, password: string | undefined): ProxyOptions {
  if (username === undefined || username.length === 0) {
    return { url };
  }
  return { url, auth: { username, password: password ?? '' } };
}

/**
 * The proxy a request to `url` must go through, or `undefined` for a direct connection.
 *
 * Excludes are honoured for both `manual` and `system`: a host the user listed goes direct
 * even when the OS would proxy it, which is the only way to reach a machine on the local
 * network from behind a corporate PAC file. `system` needs `options.resolveSystem` — without
 * it there is nothing to ask, and guessing from environment variables would silently disagree
 * with what the rest of the app (and Electron's own network stack) does.
 *
 * @param url the absolute request URL
 * @param config the user's stored proxy configuration
 * @param options the system resolver and the password behind `passwordRef`
 * @returns the proxy to dial, or `undefined` to connect directly
 * @throws WirebenchError `proxy-unsupported` when the system answers with a SOCKS-only proxy
 */
export function resolveProxyFor(
  url: string,
  config: ProxyConfig,
  options?: ResolveProxyOptions,
): ProxyOptions | undefined {
  if (config.mode === 'none') return undefined;

  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return undefined;
  }

  const excludes = config.excludes ?? [];
  if (isExcluded(hostname, excludes)) return undefined;

  if (config.mode === 'system') {
    const resolved = parseSystemProxy(options?.resolveSystem?.(url));
    if (resolved.kind === 'unsupported') {
      throw new WirebenchError(
        'proxy-unsupported',
        `Your system proxy is ${resolved.scheme.toUpperCase()}, which Wirebench cannot use`,
        { details: { scheme: resolved.scheme } },
      );
    }
    return resolved.kind === 'direct' ? undefined : { url: resolved.url };
  }

  if (config.host.trim().length === 0 || !Number.isInteger(config.port) || config.port <= 0) {
    return undefined;
  }
  const host = config.host.trim();
  const authority = host.includes('://') ? host : `http://${host}`;
  const base = `${authority.replace(/\/+$/, '')}:${config.port}`;
  return withAuth(base, config.username, options?.password);
}
