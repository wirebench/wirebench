/**
 * The tenant's own URL (hosted edition spec §19.5). Every place that compares with or prints the public URL
 * for a tenant reads it from here: the `Origin` checks, the cookies' `Secure` choice, redirects, the OIDC and
 * SAML URLs, the SCIM base, invitation and alert links, catch URLs, the pairing origin and the host's
 * in-process transport. Outside this folder and `config.ts`, `check:tenant-scope` refuses any read of
 * `config.publicUrl`, so a module cannot keep a copy made at registration.
 */
import { WirebenchError } from '@wirebench/engine';
import type { ServerConfig } from '../config.js';
import type { TenantScope } from './scope.js';

/** The part of the configuration a tenant's URL is made from. */
export type UrlConfig = Pick<ServerConfig, 'mode' | 'publicUrl' | 'appDomain'>;

/** A request (`request.tenant`) or a scope a job or the admin command line holds. */
export type ScopeSource = TenantScope | { readonly tenant: TenantScope };

/**
 * `WIREBENCH_SERVER_PUBLIC_URL` in self-hosted mode, `https://<slug>.<appDomain>` in hosted mode. A request
 * may be passed for its scope: self-hosted mode reads neither, so a self-hosted request never resolves one.
 */
export function tenantUrl(config: UrlConfig, of: ScopeSource): string {
  if (config.mode !== 'hosted') return config.publicUrl;
  const scope = 'tenantId' in of ? of : of.tenant;
  return `https://${scope.slug}.${appDomainOf(config)}`;
}

/**
 * The URL where nothing gives a scope yet: the server-wide SAML provider, which is the default tenant's until
 * slice 7. The public URL in self-hosted mode, where every tenant's URL is that one; `undefined` in hosted mode,
 * where a URL needs a tenant.
 */
export function urlWithoutScope(config: UrlConfig): string | undefined {
  return config.mode === 'hosted' ? undefined : config.publicUrl;
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
