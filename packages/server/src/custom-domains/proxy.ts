/**
 * The proxy listener (hosted edition spec §23.4): a second, internal Fastify instance that tells Traefik's HTTP
 * provider which custom names to route, and so to get certificates for. It serves `GET /proxy/traefik` and
 * `/healthz`, nothing else, and every request must carry `authorization: Bearer <token>`, the token read from
 * `WIREBENCH_SERVER_PROXY_TOKEN_FILE`; otherwise `401`. It listens in hosted mode only, when
 * `WIREBENCH_SERVER_PROXY_LISTEN` is set, and never on the public port.
 *
 * The payload is Traefik's dynamic configuration as JSON: one router per held name (`verified`, `active` or
 * `failing`), each read in its own tenant's unit through the job loop (§19.8 guard 6), so no read here crosses a
 * tenant and none needs a role past the app's. A tenant that cannot be read makes the answer `503`: Traefik keeps the
 * routers it has on an error, where a partial answer would drop that tenant's names.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { parseHostPort, type ServerConfig } from '../config.js';
import type { Tenancy } from '../tenancy/tenancy.js';
import { heldHosts } from './repo.js';

/** The one route Traefik polls (spec §23.4). */
export const PROXY_ROUTE = '/proxy/traefik';
/** The job's name in the loop's log lines. */
export const PROXY_JOB = 'custom-domains-proxy';
/** How long one read of every tenant answers polls: Traefik polls every 10 seconds, from one or more instances. */
export const PROXY_CACHE_MS = 2_000;

/** One router of the payload. */
export interface TraefikRouter {
  readonly rule: string;
  readonly entryPoints: readonly string[];
  readonly service: string;
  readonly middlewares: readonly string[];
  readonly tls: { readonly certResolver: string };
}

/** Traefik's dynamic configuration, the part this listener answers. */
export interface TraefikPayload {
  readonly http: { readonly routers: Record<string, TraefikRouter> };
}

/** A router's name: `custom-` and a hash of the host, so a name's characters never become a Traefik identifier. */
export function routerName(host: string): string {
  return `custom-${createHash('sha256').update(host).digest('hex').slice(0, 16)}`;
}

/**
 * The payload for `hosts`. With none it is still `{ http: { routers: {} } }`: Traefik applies an empty map and drops
 * the last router, where a configuration with no maps at all it would skip, keeping the old routers.
 */
export function traefikPayload(hosts: readonly string[]): TraefikPayload {
  const routers: Record<string, TraefikRouter> = {};
  for (const host of hosts) {
    routers[routerName(host)] = {
      rule: `Host(\`${host}\`)`,
      entryPoints: ['websecure'],
      service: 'wirebench@file',
      middlewares: ['hsts@file'],
      tls: { certResolver: 'le-http' },
    };
  }
  return { http: { routers } };
}

/** What the listener needs of `ctx.tenancy`. */
export type ProxyTenancy = Pick<Tenancy, 'forEachTenant' | 'reachable'>;

export interface ProxyServerOptions {
  readonly tenancy: ProxyTenancy;
  readonly token: string;
  /** The app's logger; the listener logs under it as `listener: proxy`, and never logs a request. */
  readonly log: FastifyBaseLogger;
  /** How long one read answers polls; {@link PROXY_CACHE_MS} by default, 0 for none. */
  readonly cacheMs?: number;
  readonly now?: () => number;
}

class TenantsUnread extends Error {}

/** Every tenant's held names, each read in its own unit; throws when any tenant failed. */
async function allHeldHosts(tenancy: ProxyTenancy, log: FastifyBaseLogger): Promise<readonly string[]> {
  const hosts: string[] = [];
  const pass = await tenancy.forEachTenant(
    PROXY_JOB,
    async (tx) => {
      hosts.push(...(await heldHosts(tx)));
    },
    log,
  );
  if (pass.failed.length > 0) throw new TenantsUnread(`${String(pass.failed.length)} tenant(s) could not be read`);
  return hosts.sort();
}

const digest = (text: string): Buffer => createHash('sha256').update(text, 'utf8').digest();

/** The internal listener's Fastify instance, not yet listening. */
export function buildProxyServer(options: ProxyServerOptions): FastifyInstance {
  const log = options.log.child({ listener: 'proxy' });
  // A request line here would carry nothing useful every 10 seconds; nor is the header ever logged.
  const app = Fastify({ loggerInstance: log, disableRequestLogging: true, trustProxy: false });
  // Compared as digests, so neither the length nor any prefix of the token shows in the timing.
  const expected = digest(`Bearer ${options.token}`);
  app.addHook('onRequest', async (request, reply) => {
    const given = request.headers.authorization ?? '';
    if (!timingSafeEqual(digest(given), expected)) {
      return reply.code(401).header('cache-control', 'no-store').send({ code: 'proxy-unauthorized' });
    }
  });

  const cacheMs = options.cacheMs ?? PROXY_CACHE_MS;
  const now = options.now ?? Date.now;
  let cached: { readonly at: number; readonly hosts: Promise<readonly string[]> } | undefined;
  const hosts = (): Promise<readonly string[]> => {
    const at = now();
    if (cached === undefined || at - cached.at >= cacheMs) {
      const read = allHeldHosts(options.tenancy, log);
      cached = { at, hosts: read };
      // A failed read is not kept: the next poll reads again.
      read.catch(() => {
        if (cached?.hosts === read) cached = undefined;
      });
    }
    return cached.hosts;
  };

  app.get(PROXY_ROUTE, async (_request, reply) => {
    void reply.header('cache-control', 'no-store');
    try {
      return reply.send(traefikPayload(await hosts()));
    } catch (error) {
      log.warn({ err: error }, 'custom domains: the proxy payload could not be read; Traefik keeps its routers');
      return reply.code(503).send({ code: 'proxy-unavailable' });
    }
  });
  app.get('/healthz', async (_request, reply) => {
    const ok = await options.tenancy.reachable().then(
      () => true,
      () => false,
    );
    return reply.code(ok ? 200 : 503).send({ status: ok ? 'ok' : 'failed' });
  });
  app.setNotFoundHandler((_request, reply) => {
    void reply.code(404).send({ code: 'not-found' });
  });
  return app;
}

/** Where the listener listens, and its token file: hosted mode with `WIREBENCH_SERVER_PROXY_LISTEN` set only. */
export function proxyListenerOf(
  config: Pick<ServerConfig, 'mode' | 'proxyListen' | 'proxyTokenFile'>,
): { readonly host: string; readonly port: number; readonly tokenFile: string } | undefined {
  if (config.mode !== 'hosted' || config.proxyListen === undefined || config.proxyTokenFile === undefined) {
    return undefined;
  }
  const address = parseHostPort(config.proxyListen);
  return address === undefined ? undefined : { ...address, tokenFile: config.proxyTokenFile };
}

/** The token in `path`, without surrounding white space. The error never carries the file's content. */
export async function readProxyToken(path: string): Promise<string> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    const code = (error as { readonly code?: unknown }).code;
    throw new Error(`WIREBENCH_SERVER_PROXY_TOKEN_FILE cannot be read${typeof code === 'string' ? ` (${code})` : ''}`);
  }
  const token = text.trim();
  if (token.length === 0) throw new Error('WIREBENCH_SERVER_PROXY_TOKEN_FILE is empty');
  return token;
}

/** A running proxy listener. */
export interface ProxyListener {
  readonly port: number;
  close(): Promise<void>;
}

/**
 * Starts the listener when `config` asks for one (hosted mode, `WIREBENCH_SERVER_PROXY_LISTEN` set), else answers
 * undefined. `serve.ts` calls it beside the main listener and closes it with the server.
 *
 * @throws Error when the token file cannot be read or is empty, or the address cannot be listened on.
 */
export async function startProxyListener(
  config: Pick<ServerConfig, 'mode' | 'proxyListen' | 'proxyTokenFile'>,
  tenancy: ProxyTenancy,
  log: FastifyBaseLogger,
  options: Pick<ProxyServerOptions, 'cacheMs' | 'now'> = {},
): Promise<ProxyListener | undefined> {
  const where = proxyListenerOf(config);
  if (where === undefined) return undefined;
  const token = await readProxyToken(where.tokenFile);
  const app = buildProxyServer({ tenancy, token, log, ...options });
  try {
    await app.listen({ host: where.host, port: where.port });
  } catch (error) {
    await app.close();
    const code = (error as { readonly code?: unknown }).code;
    throw new Error(
      `the proxy listener cannot listen on ${where.host}:${String(where.port)}${typeof code === 'string' ? ` (${code})` : ''}`,
    );
  }
  const address = app.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : where.port;
  log.info({ listener: 'proxy', port }, 'the proxy listener is listening');
  return { port, close: () => app.close() };
}
