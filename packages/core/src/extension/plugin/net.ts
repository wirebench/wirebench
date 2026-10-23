/**
 * The brokered network a plugin importer gets (phase 7 spec §8, ADR-0031).
 *
 * A request leaves only when its origin is one the manifest lists, exactly, and the address its host
 * resolves to is not loopback, private, link-local, CGNAT, unique-local or multicast, unless the listed
 * origin is itself that literal address. The address checked is the one connected to: the dispatcher's
 * `lookup` is pinned to it. Redirects are followed here, at most five, each hop checked the same way;
 * an HTTPS upgrade the transport makes on its own must land on a listed origin too, or the answer is
 * withheld. Proxy and TLS settings come from the host, no credential, cookie or secret is attached,
 * and each exchange is recorded redacted, without bodies.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { z } from 'zod';
import { WirebenchError } from '../../errors.js';
import { createDispatcher, sendHttp } from '../../http/client.js';
import type { HttpRequest, ProxyOptions, TlsOptions } from '../../http/types.js';
import { redactHeaders, redactUrl } from '../../redact/index.js';
import type { PluginFetch } from './sandbox/execute.js';

export const PLUGIN_NET_LIMITS = {
  requestsPerCall: 32,
  responseBytes: 16 * 1024 * 1024,
  requestBytes: 16 * 1024 * 1024,
  redirects: 5,
  timeoutMs: 30_000,
} as const;

/** One brokered exchange, as history keeps it: no bodies, headers and URL redacted. */
export interface PluginNetRecord {
  readonly plugin: string;
  readonly at: string;
  readonly method: string;
  readonly url: string;
  readonly status?: number;
  readonly error?: string;
  readonly requestHeaders: Readonly<Record<string, string>>;
  readonly responseHeaders?: Readonly<Record<string, string>>;
  readonly requestBytes: number;
  readonly responseBytes?: number;
  readonly durationMs: number;
}

export interface PluginNetOptions {
  readonly plugin: string;
  /** The manifest's `capabilities.network`. */
  readonly origins: readonly string[];
  /** The host's proxy and TLS settings for a URL: the desktop's preferences, the CLI's environment. */
  readonly network?: (url: string) => Promise<{ readonly tls?: TlsOptions; readonly proxy?: ProxyOptions }>;
  readonly record?: (entry: PluginNetRecord) => void;
  /** Name resolution; tests substitute one. */
  readonly resolve?: (hostname: string) => Promise<readonly { address: string; family: number }[]>;
  readonly now?: () => Date;
}

const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS', 'PATCH'] as const;
const HEADER_VALUE = /^[^\r\n\0]*$/;

const requestSchema = z.strictObject({
  method: z.enum(METHODS).optional(),
  url: z.string().max(8192),
  headers: z.record(z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/), z.string().regex(HEADER_VALUE)).optional(),
  body: z.string().optional(),
});

/** Ranges a plugin may not reach unless it listed the literal address. */
const BLOCKED = (() => {
  const list = new BlockList();
  for (const [net, prefix] of [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ] as const) {
    list.addSubnet(net, prefix, 'ipv4');
  }
  for (const [net, prefix] of [
    ['::', 128],
    ['::1', 128],
    ['fc00::', 7],
    ['fe80::', 10],
    ['ff00::', 8],
  ] as const) {
    list.addSubnet(net, prefix, 'ipv6');
  }
  return list;
})();

/** The IPv4 address an IPv4-mapped (`::ffff:a.b.c.d`) or NAT64 (`64:ff9b::a.b.c.d`) address carries. */
function embeddedV4(address: string): string | undefined {
  const match = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (match?.[1] !== undefined) return match[1];
  const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
  if (hex?.[1] === undefined || hex[2] === undefined) return undefined;
  const high = Number.parseInt(hex[1], 16);
  const low = Number.parseInt(hex[2], 16);
  return [high >> 8, high & 255, low >> 8, low & 255].join('.');
}

/** Whether a plugin may not reach `address` without listing it. */
export function isBlockedAddress(address: string): boolean {
  const v4 = embeddedV4(address);
  if (v4 !== undefined) return BLOCKED.check(v4, 'ipv4');
  const family = isIP(address);
  if (family === 4) return BLOCKED.check(address, 'ipv4');
  if (family === 6) return BLOCKED.check(address, 'ipv6');
  return true;
}

const unbracket = (hostname: string): string => hostname.replace(/^\[|\]$/g, '');

function denied(message: string, details: Record<string, unknown>): WirebenchError {
  return new WirebenchError('plugin-network-denied', message, { details });
}

/** A lookup that answers `address` for every name: the connect goes where the check looked. */
function pinned(address: string, family: number): LookupFunction {
  return (_hostname, options, callback) => {
    if (typeof options === 'object' && options.all === true) {
      (callback as unknown as (error: null, addresses: { address: string; family: number }[]) => void)(null, [
        { address, family },
      ]);
      return;
    }
    callback(null, address, family);
  };
}

/**
 * The broker for one plugin. Each call of {@link PluginNetBroker.forCall} gives the fetch one plugin
 * call uses, with its own request budget.
 */
export interface PluginNetBroker {
  forCall(): PluginFetch;
}

export function createPluginNet(options: PluginNetOptions): PluginNetBroker {
  const allowed = new Set(options.origins);
  const resolve = options.resolve ?? (async (hostname: string) => dnsLookup(hostname, { all: true, verbatim: true }));
  const now = options.now ?? (() => new Date());

  /** The address to connect to for `url`, checked; undefined when a proxy does the resolving. */
  const checkTarget = async (url: URL, proxied: boolean): Promise<{ address: string; family: number } | undefined> => {
    if (!allowed.has(url.origin)) {
      throw denied(`${options.plugin} may not reach ${url.origin}: its manifest does not list it`, {
        plugin: options.plugin,
        origin: url.origin,
      });
    }
    const host = unbracket(url.hostname);
    const literal = isIP(host) !== 0;
    const addresses = literal ? [{ address: host, family: isIP(host) }] : await resolve(host);
    if (addresses.length === 0) throw denied(`${host} does not resolve`, { plugin: options.plugin, host });
    // A literal address the manifest lists is the person's own choice; a name must not lead to one.
    if (!literal && addresses.some((entry) => isBlockedAddress(entry.address))) {
      throw denied(`${options.plugin} may not reach ${host}: it resolves to a private or local address`, {
        plugin: options.plugin,
        host,
      });
    }
    return proxied ? undefined : addresses[0];
  };

  const sendOne = async (
    request: { method: (typeof METHODS)[number]; url: string; headers: Record<string, string>; body?: string },
    budget: { left: number },
  ): Promise<{ status: number; headers: Record<string, string>; body: string }> => {
    let current = request;
    for (let hop = 0; ; hop += 1) {
      if (budget.left <= 0) {
        throw denied(
          `${options.plugin} made more than ${String(PLUGIN_NET_LIMITS.requestsPerCall)} requests in one call`,
          {
            plugin: options.plugin,
          },
        );
      }
      budget.left -= 1;
      const url = new URL(current.url);
      const settings = (await options.network?.(url.href)) ?? {};
      const target = await checkTarget(url, settings.proxy !== undefined);
      const dispatcher = createDispatcher({
        ...(settings.tls !== undefined ? { tls: settings.tls } : {}),
        ...(settings.proxy !== undefined ? { proxy: settings.proxy } : {}),
        ...(target !== undefined ? { lookup: pinned(target.address, target.family) } : {}),
        keepAlive: false,
      });
      const body = current.body !== undefined ? Buffer.from(current.body, 'utf8') : undefined;
      const started = Date.now();
      const http: HttpRequest = {
        url: url.href,
        method: current.method,
        headers: current.headers,
        ...(body !== undefined ? { body } : {}),
        timeoutMs: PLUGIN_NET_LIMITS.timeoutMs,
        followRedirects: false,
        maxSizeBytes: PLUGIN_NET_LIMITS.responseBytes,
        ...(settings.tls !== undefined ? { tls: settings.tls } : {}),
        ...(settings.proxy !== undefined ? { proxy: settings.proxy } : {}),
      };
      const base = {
        plugin: options.plugin,
        at: now().toISOString(),
        method: current.method,
        url: redactUrl(url.href),
        requestHeaders: redactHeaders(current.headers),
        requestBytes: body?.length ?? 0,
      };
      let exchange;
      try {
        exchange = await sendHttp(http, { dispatcher });
      } catch (error) {
        options.record?.({
          ...base,
          error: error instanceof Error ? error.message : String(error),
          durationMs: Date.now() - started,
        });
        throw error;
      } finally {
        void dispatcher.close?.().catch(() => undefined);
      }
      options.record?.({
        ...base,
        status: exchange.status,
        responseHeaders: redactHeaders(exchange.headers),
        responseBytes: exchange.body.length,
        durationMs: Date.now() - started,
      });
      // The transport follows a same-host HTTPS upgrade by itself; its last hop must be listed too.
      const landed = exchange.redirects.at(-1);
      if (landed !== undefined && !allowed.has(new URL(landed.url).origin)) {
        throw denied(
          `${options.plugin} was upgraded to ${new URL(landed.url).origin}, which its manifest does not list`,
          {
            plugin: options.plugin,
          },
        );
      }
      if (exchange.truncated) {
        throw denied(`The answer from ${url.origin} is larger than 16 MiB`, { plugin: options.plugin });
      }
      const location = exchange.headers['location'];
      if (exchange.status >= 300 && exchange.status < 400 && location !== undefined) {
        if (hop >= PLUGIN_NET_LIMITS.redirects) {
          throw denied(`${url.origin} redirected more than ${String(PLUGIN_NET_LIMITS.redirects)} times`, {
            plugin: options.plugin,
          });
        }
        const next = new URL(location, url).href;
        const keep = exchange.status === 307 || exchange.status === 308;
        current = {
          method: keep ? current.method : current.method === 'HEAD' ? 'HEAD' : 'GET',
          url: next,
          // A hop to another origin carries none of the headers the plugin set for the first one.
          headers: new URL(next).origin === url.origin ? current.headers : {},
          ...(keep && current.body !== undefined ? { body: current.body } : {}),
        };
        continue;
      }
      return {
        status: exchange.status,
        headers: { ...exchange.headers },
        body: Buffer.from(exchange.body).toString('utf8'),
      };
    }
  };

  return {
    forCall() {
      const budget = { left: PLUGIN_NET_LIMITS.requestsPerCall };
      return async (text) => {
        try {
          const parsed = requestSchema.safeParse(JSON.parse(text));
          if (!parsed.success)
            return { ok: false, text: `net.fetch: ${parsed.error.issues[0]?.message ?? 'bad request'}` };
          const { method = 'GET', url, headers = {}, body } = parsed.data;
          if (body !== undefined && Buffer.byteLength(body, 'utf8') > PLUGIN_NET_LIMITS.requestBytes) {
            return { ok: false, text: 'net.fetch: the body is larger than 16 MiB' };
          }
          let parsedUrl: URL;
          try {
            parsedUrl = new URL(url);
          } catch {
            return { ok: false, text: `net.fetch: "${url}" is not a URL` };
          }
          const response = await sendOne(
            { method, url: parsedUrl.href, headers, ...(body !== undefined ? { body } : {}) },
            budget,
          );
          return { ok: true, text: JSON.stringify(response) };
        } catch (error) {
          return { ok: false, text: error instanceof Error ? error.message : String(error) };
        }
      };
    },
  };
}
