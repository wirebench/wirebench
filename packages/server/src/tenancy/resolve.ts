/**
 * Tenant resolution (hosted edition spec §19.5): `request.tenant` on every request but `/healthz`.
 *
 * - **Self-hosted.** The scope is always the default tenant, and no hook runs: `Host` is never read, so an
 *   installation reached by any name, or by several, keeps working. `request.tenant` is a getter, so a route
 *   that never asks for it never needs the directory.
 * - **Hosted.** A root `onRequest` hook, ahead of every module, takes `request.hostname` (which honours
 *   `trustProxy`), lower-cased and without its port. It must be one label followed by `.<appDomain>`, naming an
 *   active tenant other than the default one. Anything else answers `404` with an empty body and
 *   `cache-control: no-store`, so the answer names nothing. WebSocket upgrades pass through the same hook.
 * - **Retired slugs** (spec §22.8). An old slug's host whose redirect lives answers `308` to the same path and query
 *   on the new slug's host, `cache-control: no-store`; after `redirect_until` it is `404` like any unknown name.
 * - **The apex and the entry** (spec §21.3). In hosted mode `<appDomain>` itself redirects to the entry, and
 *   `app.<appDomain>` serves only the routes marked {@link ENTRY_ROUTE}, with no tenant: a module route that reached
 *   for one there throws rather than serving the default tenant.
 */
import { WirebenchError } from '@wirebench/engine';
import type { IncomingMessage } from 'node:http';
import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from 'fastify';
import type { ServerConfig } from '../config.js';
import type { TenantDirectory } from './directory.js';
import type { TenantScope } from './scope.js';
import { appDomainOf } from './urls.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** `true` on an entry route (spec §21.4): the one kind of route `app.<appDomain>` serves. */
    wirebenchEntry?: boolean;
  }
}

/** What the router stores per constraint value: the handler type `addConstraintStrategy`'s storage holds. */
type EntryHandler = Parameters<
  ReturnType<Parameters<FastifyInstance['addConstraintStrategy']>[0]['storage']>['set']
>[1];

const ENTRY_CONSTRAINT = 'wirebenchEntry';
const ENTRY_VALUE = 'entry';

/**
 * The host a request names, as `request.hostname` reads it with a boolean `trustProxy` (Fastify 5's `request.host`):
 * the last `X-Forwarded-Host` entry behind a trusted proxy, else `Host`. For the route constraint, which runs before
 * Fastify has built the request.
 */
export function rawHostOf(req: IncomingMessage, trustProxy: boolean): string {
  const forwarded = trustProxy ? req.headers['x-forwarded-host'] : undefined;
  if (typeof forwarded === 'string' && forwarded !== '') {
    const last = forwarded.lastIndexOf(',');
    return hostKey(last === -1 ? forwarded : forwarded.slice(last + 1));
  }
  const authority = req.headers[':authority'];
  return hostKey(req.headers.host ?? (typeof authority === 'string' ? authority : ''));
}

/** The routes that take no tenant: health and readiness read no tenant row (spec §19.5, §20.9). */
const UNSCOPED_ROUTES = new Set(['/healthz', '/readyz']);

/**
 * What an entry route is registered with (spec §21.4): a constraint that only a request for `app.<appDomain>` meets,
 * so on a tenant host the same path is the tenant's, and the config the root hook lets through on the entry host.
 * Fastify's own host constraint is not used: it compares the raw `Host` header, port and case included, and never
 * reads `X-Forwarded-Host`. Spread it whole and add to it (`{ ...ENTRY_ROUTE, bodyLimit }`); a route that replaced
 * `config` would lose the mark and answer 404 everywhere.
 */
export const ENTRY_ROUTE = Object.freeze({
  constraints: Object.freeze({ [ENTRY_CONSTRAINT]: ENTRY_VALUE }),
  config: Object.freeze({ wirebenchEntry: true }),
});

/** The neutral entry's host name, `app.<appDomain>`, lower-cased. */
export function entryHostOf(config: Pick<ServerConfig, 'appDomain'>): string {
  return `app.${appDomainOf(config)}`;
}

function isEntryRoute(request: FastifyRequest): boolean {
  return request.routeOptions.config.wirebenchEntry === true;
}

/** How often the hosted map is read again: a backstop, since the bus's `tenantsChanged` reloads it (spec §20.3). */
export const RELOAD_MS = 600_000;

/** `Host` as the map keys it: lower-cased, without a port, and without a trailing dot. */
export function hostKey(hostname: string): string {
  let host = hostname.trim().toLowerCase();
  // `request.hostname` has dropped the port already; a bracketed IPv6 literal never names a tenant anyway.
  if (!host.startsWith('[')) host = host.replace(/:\d*$/, '');
  return host.endsWith('.') ? host.slice(0, -1) : host;
}

export interface ResolverOptions {
  readonly appDomain: string;
  /** `redirects` is optional for a test's directory: without it no host redirects. */
  readonly directory: Pick<TenantDirectory, 'resolvable' | 'onChange'> & Partial<Pick<TenantDirectory, 'redirects'>>;
  /** The clock a redirect's end is read against; the real one by default. */
  readonly now?: () => number;
  readonly log: Pick<FastifyBaseLogger, 'warn'>;
  readonly reloadMs?: number;
  readonly setInterval?: (fn: () => void, ms: number) => { unref?(): void };
  readonly clearInterval?: (timer: unknown) => void;
}

/**
 * What a host name names in the hosted map: a tenant. Whatever is the tenant's own (its scope; its status in a later
 * part) lives here, in the value, so a second name for the same tenant (slice 8's custom names) is one more key on
 * an equal value, and nothing is read from the host string itself.
 */
export interface TenantEntry {
  readonly scope: TenantScope;
}

/** An old slug's host (spec §22.8): the new host it redirects to, until when (ms since the epoch). */
interface RedirectEntry {
  readonly to: string;
  readonly until: number;
}

/**
 * The hosted map of host names to tenants, and the retired slugs' redirects beside it. It is keyed by full host
 * name, so a custom name (slice 8) is one more entry. It is loaded before the server listens, reloaded after any write through the directory in this
 * process, and every {@link RELOAD_MS}. A failed reload keeps the map it had.
 */
export class TenantResolver {
  private hosts = new Map<string, TenantEntry>();
  private redirects = new Map<string, RedirectEntry>();
  private loading: Promise<void> | undefined;
  private again = false;
  private stopTimers: (() => void) | undefined;

  constructor(private readonly options: ResolverOptions) {}

  /** The scope `hostname` names, or `undefined`. */
  resolve(hostname: string): TenantScope | undefined {
    return this.hosts.get(hostKey(hostname))?.scope;
  }

  /** The host `hostname` redirects to while its retired slug's redirect lives, or `undefined`. */
  redirectOf(hostname: string): string | undefined {
    const redirect = this.redirects.get(hostKey(hostname));
    if (redirect === undefined) return undefined;
    return redirect.until > (this.options.now ?? Date.now)() ? redirect.to : undefined;
  }

  /** Reads the map now. Calls during a read run one more read after it, so none misses a write. */
  invalidate(): Promise<void> {
    if (this.loading !== undefined) {
      this.again = true;
      return this.loading;
    }
    this.loading = (async () => {
      try {
        do {
          this.again = false;
          const domain = this.options.appDomain.toLowerCase();
          const [scopes, redirects] = await Promise.all([
            this.options.directory.resolvable(),
            this.options.directory.redirects?.() ?? Promise.resolve([]),
          ]);
          this.hosts = new Map(scopes.map((scope) => [`${scope.slug}.${domain}`, { scope }]));
          this.redirects = new Map(
            redirects.map((redirect) => [
              `${redirect.slug}.${domain}`,
              { to: `${redirect.to}.${domain}`, until: redirect.until.getTime() },
            ]),
          );
        } while (this.again);
      } finally {
        this.loading = undefined;
      }
    })();
    return this.loading;
  }

  /** Subscribes to the directory and starts the poll; idempotent. */
  start(): void {
    if (this.stopTimers !== undefined) return;
    const reload = (): void => {
      this.invalidate().catch((error: unknown) => {
        this.options.log.warn({ err: error }, 'the tenant map could not be reloaded; keeping the last one');
      });
    };
    const unsubscribe = this.options.directory.onChange(reload);
    const timer = (this.options.setInterval ?? setInterval)(reload, this.options.reloadMs ?? RELOAD_MS);
    timer.unref?.();
    this.stopTimers = () => {
      unsubscribe();
      (this.options.clearInterval ?? ((t) => clearInterval(t as NodeJS.Timeout)))(timer);
    };
  }

  stop(): void {
    this.stopTimers?.();
    this.stopTimers = undefined;
  }
}

/**
 * Registers resolution on the root instance, before every route and module. Returns the hosted resolver, or
 * `undefined` in self-hosted mode, where there is none.
 */
export async function registerTenantResolution(
  app: FastifyInstance,
  config: Pick<ServerConfig, 'mode' | 'appDomain' | 'trustProxy'>,
  directory: TenantDirectory,
): Promise<TenantResolver | undefined> {
  if (config.mode !== 'hosted') {
    app.decorateRequest('tenant', {
      getter(): TenantScope {
        return directory.defaultScope();
      },
    });
    return undefined;
  }
  const resolved = new WeakMap<FastifyRequest, TenantScope>();
  app.decorateRequest('tenant', {
    getter(this: FastifyRequest): TenantScope {
      const scope = resolved.get(this);
      if (scope === undefined) throw new WirebenchError('tenancy-unresolved', 'this request has no tenant');
      return scope;
    },
  });
  const appDomain = appDomainOf(config);
  const entryHost = entryHostOf(config);
  const resolver = new TenantResolver({ appDomain, directory, log: app.log });
  const handlers = new Map<unknown, EntryHandler>();
  app.addConstraintStrategy({
    name: ENTRY_CONSTRAINT,
    storage: () => ({
      get: (value) => handlers.get(value) ?? null,
      set: (value, handler) => {
        handlers.set(value, handler);
      },
    }),
    deriveConstraint: (req: IncomingMessage) =>
      rawHostOf(req, config.trustProxy) === entryHost ? ENTRY_VALUE : undefined,
    mustMatchWhenDerived: false,
  });
  await resolver.invalidate();
  resolver.start();
  app.addHook('onClose', () => {
    resolver.stop();
  });
  app.addHook('onRequest', async (request, reply) => {
    if (request.routeOptions.url !== undefined && UNSCOPED_ROUTES.has(request.routeOptions.url)) return;
    const host = hostKey(request.hostname);
    if (host === appDomain) {
      void reply.code(308).header('location', `https://${entryHost}/`).header('cache-control', 'no-store').send();
      return reply;
    }
    if (host === entryHost) {
      if (isEntryRoute(request)) return undefined;
      void reply.code(404).header('cache-control', 'no-store').send();
      return reply;
    }
    // Belt and braces: the constraint already keeps an entry route off every other host.
    if (isEntryRoute(request)) {
      void reply.code(404).header('cache-control', 'no-store').send();
      return reply;
    }
    const scope = resolver.resolve(host);
    if (scope === undefined) {
      // A renamed tenant's old host (spec §22.8): the same path and query on the new one, while the redirect lives.
      const to = resolver.redirectOf(host);
      if (to !== undefined) {
        const path = request.url.startsWith('/') ? request.url : '/';
        void reply.code(308).header('location', `https://${to}${path}`).header('cache-control', 'no-store').send();
        return reply;
      }
      void reply.code(404).header('cache-control', 'no-store').send();
      return reply;
    }
    resolved.set(request, scope);
    return undefined;
  });
  return resolver;
}
