/**
 * The tenant's own URL (hosted edition spec §19.5), and with a custom name its two (§23.5). Every place that compares
 * with or prints the public URL for a tenant reads it from here: the `Origin` checks, the cookies' `Secure` choice, redirects, the OIDC and
 * SAML URLs, the SCIM base, invitation and alert links, catch URLs, the pairing origin and the host's
 * in-process transport. Outside this folder and `config.ts`, `check:tenant-scope` refuses any read of
 * `config.publicUrl`, so a module cannot keep a copy made at registration.
 */
import { WirebenchError } from '@wirebench/engine';
import type { ModuleConfig, ServerConfig } from '../config.js';
import type { TenantScope } from './scope.js';

/**
 * The part of the configuration a tenant's URL is made from. Typed without `publicUrl`, as modules see the
 * configuration (`ModuleConfig`); the object is always the loaded `ServerConfig`, and only this file reads the field.
 */
export type UrlConfig = Pick<ModuleConfig, 'mode' | 'appDomain'>;

/** The configured URL behind a module's view of the configuration: what `loadConfig` loaded. */
function configuredUrl(config: UrlConfig): string {
  const url = (config as Partial<Pick<ServerConfig, 'publicUrl'>>).publicUrl;
  if (url === undefined) {
    throw new WirebenchError('tenancy-no-public-url', 'this configuration was not loaded: it has no public URL');
  }
  return url;
}

/**
 * A request (`request.tenant`, and the `hostname` it came on) or a scope a job or the admin command line holds. A
 * request without its `hostname` reads as its scope.
 */
export type ScopeSource = TenantScope | { readonly tenant: TenantScope; readonly hostname?: string };

const scopeIn = (of: ScopeSource): TenantScope => ('tenantId' in of ? of : of.tenant);

/** A `Host` as the resolver keys it: lower-cased, without a port or a trailing dot (`resolve.ts` `hostKey`). */
function hostOf(hostname: string): string {
  const host = hostname.trim().toLowerCase().replace(/:\d*$/, '');
  return host.endsWith('.') ? host.slice(0, -1) : host;
}

/**
 * The tenant's primary URL (spec §23.5): `https://<custom name>` while one is live, else `https://<slug>.<appDomain>`;
 * `WIREBENCH_SERVER_PUBLIC_URL` self-hosted. Everything sent to someone not looking at a page reads this: invitation,
 * alert and reset links, mail, catch URLs, the OIDC redirect URI, the SAML entity ID and ACS URL, the SCIM base.
 */
export function primaryUrl(config: UrlConfig, of: ScopeSource): string {
  if (config.mode !== 'hosted') return configuredUrl(config);
  const scope = scopeIn(of);
  return scope.customHost !== undefined
    ? `https://${scope.customHost}`
    : `https://${scope.slug}.${appDomainOf(config)}`;
}

/**
 * For a request, the URL of the host it came on (spec §23.5): the custom name when it came on that, else the slug's.
 * Every check that compares with what the browser shows reads this: `Origin`, the cookies, the browser client's base,
 * the host's transport and the pairing origin. For a scope, or a request without its host, the {@link primaryUrl}.
 * `WIREBENCH_SERVER_PUBLIC_URL` self-hosted, where neither the request nor its scope is read.
 */
export function tenantUrl(config: UrlConfig, of: ScopeSource): string {
  if (config.mode !== 'hosted') return configuredUrl(config);
  const scope = scopeIn(of);
  if ('tenantId' in of || of.hostname === undefined) return primaryUrl(config, scope);
  const custom = scope.customHost;
  // Only the two names the resolver maps to this tenant: any other host reads as the slug's, never as itself.
  if (custom !== undefined && hostOf(of.hostname) === custom) return `https://${custom}`;
  return `https://${scope.slug}.${appDomainOf(config)}`;
}

/**
 * The URL where nothing gives a scope yet: the server-wide SAML provider, which is the default tenant's until
 * slice 7. The public URL in self-hosted mode, where every tenant's URL is that one; `undefined` in hosted mode,
 * where a URL needs a tenant.
 */
export function urlWithoutScope(config: UrlConfig): string | undefined {
  return config.mode === 'hosted' ? undefined : configuredUrl(config);
}

/**
 * The configured URL, for the operator's own output: the start-up line in `serve.ts` and `config check` in
 * `main.ts`, the two files `check:tenant-scope` lets call it.
 */
export function operatorPublicUrl(config: Pick<ServerConfig, 'publicUrl'>): string {
  return config.publicUrl;
}

/** The hosted domain, lower-cased; hosted mode without one is a test that forgot it. */
export function appDomainOf(config: Pick<ServerConfig, 'appDomain'>): string {
  if (config.appDomain === undefined || config.appDomain === '') {
    throw new WirebenchError('tenancy-no-app-domain', 'hosted mode needs an app domain');
  }
  return config.appDomain.toLowerCase();
}
