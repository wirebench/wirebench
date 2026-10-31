import type { ServerConfig } from '../config.js';
import type { ServerContext } from '../context.js';
import { tenantUrl, type ScopeSource } from '../tenancy/urls.js';
import type { OidcProvider } from './oidc.js';
import type { RateLimiter } from './rate-limit.js';

/** The §4.1 knobs the routes read, derived once from the configuration. */
export interface IdentitySettings {
  readonly local: boolean;
  readonly oidc: { readonly issuer: string; readonly displayName: string } | undefined;
  readonly tokenIdleMs: number;
  readonly tokenMaxMs: number;
  readonly invitationMs: number;
  /** The OIDC callback of the tenant `of` names (spec §19.5): computed per request, never at registration. */
  readonly redirectUri: (of: ScopeSource) => string;
  /** The browser client's OIDC callback (hosted spec §17.2), a second redirect URI at the IdP. */
  readonly browserRedirectUri: (of: ScopeSource) => string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Hosted mode has no OIDC (spec §19.1): the configured provider is the operator's one, which until slice 7
 * gives each tenant its own would sign people into any tenant with a matching email. So the OIDC routes answer
 * `404`, as they do on a server without OIDC, and nothing reports it.
 */
export function identitySettings(config: ServerConfig): IdentitySettings {
  return {
    local: config.localAuth,
    oidc:
      config.mode === 'hosted' || config.oidcIssuer === undefined
        ? undefined
        : { issuer: config.oidcIssuer, displayName: config.oidcDisplayName },
    tokenIdleMs: config.tokenIdleDays * DAY_MS,
    tokenMaxMs: config.tokenMaxDays * DAY_MS,
    invitationMs: config.invitationDays * DAY_MS,
    redirectUri: (of) => `${tenantUrl(config, of)}/api/v1/auth/oidc/callback`,
    browserRedirectUri: (of) => `${tenantUrl(config, of)}/api/v1/auth/oidc/browser-callback`,
  };
}

/** Everything a route file needs; built once by `module.ts` and passed to each route group. */
export interface IdentityEnv {
  readonly ctx: ServerContext;
  readonly settings: IdentitySettings;
  readonly now: () => Date;
  readonly limiter: RateLimiter;
  readonly provider: OidcProvider | undefined;
}

/** What the invitation functions need: the CLI builds one without a Fastify app or a provider. */
export interface InvitationEnv {
  readonly ctx: Pick<ServerContext, 'db' | 'tenancy' | 'config' | 'hooks' | 'license'>;
  readonly settings: Pick<IdentitySettings, 'invitationMs' | 'local' | 'oidc'>;
  readonly now: () => Date;
}
