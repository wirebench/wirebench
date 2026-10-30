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
 */
import { WirebenchError } from '@wirebench/engine';
import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from 'fastify';
import type { ServerConfig } from '../config.js';
import type { TenantDirectory } from './directory.js';
import type { TenantScope } from './scope.js';
import { appDomainOf } from './urls.js';

/** The routes that take no tenant: health reads no tenant row (spec §19.5). */
const UNSCOPED_ROUTES = new Set(['/healthz']);

/** How often the hosted map is read again; slice 5 replaces the poll with a notification. */
export const RELOAD_MS = 60_000;

/** `Host` as the map keys it: lower-cased, without a port, and without a trailing dot. */
export function hostKey(hostname: string): string {
  let host = hostname.trim().toLowerCase();
  // `request.hostname` has dropped the port already; a bracketed IPv6 literal never names a tenant anyway.
  if (!host.startsWith('[')) host = host.replace(/:\d*$/, '');
  return host.endsWith('.') ? host.slice(0, -1) : host;
}

export interface ResolverOptions {
  readonly appDomain: string;
  readonly directory: Pick<TenantDirectory, 'resolvable' | 'onChange'>;
  readonly log: Pick<FastifyBaseLogger, 'warn'>;
  readonly reloadMs?: number;
  readonly setInterval?: (fn: () => void, ms: number) => { unref?(): void };
  readonly clearInterval?: (timer: unknown) => void;
}

/**
 * The hosted map of host names to scopes. It is keyed by full host name, so a custom name (slice 8) is one
 * more entry. It is loaded before the server listens, reloaded after any write through the directory in this
 * process, and every {@link RELOAD_MS}. A failed reload keeps the map it had.
 */
export class TenantResolver {
  private hosts = new Map<string, TenantScope>();
  private loading: Promise<void> | undefined;
  private again = false;
  private stopTimers: (() => void) | undefined;

  constructor(private readonly options: ResolverOptions) {}

  /** The scope `hostname` names, or `undefined`. */
  resolve(hostname: string): TenantScope | undefined {
    return this.hosts.get(hostKey(hostname));
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
          const scopes = await this.options.directory.resolvable();
          this.hosts = new Map(scopes.map((scope) => [`${scope.slug}.${domain}`, scope]));
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
  config: Pick<ServerConfig, 'mode' | 'appDomain'>,
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
  const resolver = new TenantResolver({ appDomain: appDomainOf(config), directory, log: app.log });
  await resolver.invalidate();
  resolver.start();
  app.addHook('onClose', () => {
    resolver.stop();
  });
  app.addHook('onRequest', async (request, reply) => {
    if (request.routeOptions.url !== undefined && UNSCOPED_ROUTES.has(request.routeOptions.url)) return;
    const scope = resolver.resolve(request.hostname);
    if (scope === undefined) {
      void reply.code(404).header('cache-control', 'no-store').send();
      return reply;
    }
    resolved.set(request, scope);
    return undefined;
  });
  return resolver;
}
