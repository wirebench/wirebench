import type { ModuleConfig } from '../config.js';
import type { ServerContext } from '../context.js';
import type { TenantScope } from '../tenancy/scope.js';
import { primaryUrl, type ScopeSource } from '../tenancy/urls.js';
import { methodDisabled, oidcFailed } from './errors.js';
import type { OidcProvider } from './oidc.js';
import type { TenantRateLimiter } from './rate-limit.js';

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
 * `oidc` is the environment's provider, self-hosted only. Hosted mode never uses it (spec §22.1 refuses the
 * variables there): the operator's one provider would sign people into any tenant with a matching email. Each
 * tenant's own comes from its settings instead (`tenant-oidc.ts`).
 */
export function identitySettings(config: ModuleConfig): IdentitySettings {
  return {
    local: config.localAuth,
    oidc:
      config.mode === 'hosted' || config.oidcIssuer === undefined
        ? undefined
        : { issuer: config.oidcIssuer, displayName: config.oidcDisplayName },
    tokenIdleMs: config.tokenIdleDays * DAY_MS,
    tokenMaxMs: config.tokenMaxDays * DAY_MS,
    invitationMs: config.invitationDays * DAY_MS,
    redirectUri: (of) => `${primaryUrl(config, of)}/api/v1/auth/oidc/callback`,
    browserRedirectUri: (of) => `${primaryUrl(config, of)}/api/v1/auth/oidc/browser-callback`,
  };
}

/** Everything a route file needs; built once by `module.ts` and passed to each route group. */
export interface IdentityEnv {
  readonly ctx: ServerContext;
  readonly settings: IdentitySettings;
  readonly now: () => Date;
  readonly limiter: TenantRateLimiter;
  /**
   * The OIDC client of `scope`'s tenant: the environment's self-hosted, the tenant's own in hosted mode. `undefined`
   * answers as a server without OIDC (`identity-method-disabled`).
   */
  readonly providerFor: (scope: TenantScope) => Promise<OidcProvider | undefined>;
}

/** What the invitation functions need: the CLI builds one without a Fastify app or a provider. */
export interface InvitationEnv {
  readonly ctx: Pick<ServerContext, 'tenancy' | 'config' | 'hooks' | 'license'>;
  readonly settings: Pick<IdentitySettings, 'invitationMs' | 'local' | 'oidc'>;
  readonly now: () => Date;
  /** Whether `scope`'s tenant offers OIDC, when that is a tenant's setting (hosted); `settings.oidc` otherwise. */
  readonly oidcOffered?: (scope: TenantScope) => Promise<boolean>;
}

/**
 * The OIDC client for `request`'s tenant, or `identity-method-disabled` when it has none. A discovery that fails (the
 * tenant's IdP down, or refused by the egress rule) is `identity-oidc-failed`, logged with the tenant only.
 */
/** `error`'s code when it has a string one, else its class's name. */
function errorClass(error: unknown): string {
  const code = (error as { code?: unknown } | undefined)?.code;
  if (typeof code === 'string') return code;
  return error instanceof Error ? error.name : 'error';
}

export async function requireProvider(
  env: Pick<IdentityEnv, 'providerFor'>,
  request: { readonly tenant: TenantScope; readonly log: { warn(details: object, message: string): void } },
): Promise<OidcProvider> {
  let provider: OidcProvider | undefined;
  try {
    provider = await env.providerFor(request.tenant);
  } catch (error) {
    request.log.warn(
      // The error's class or code only: an IdP's answer, or a resolver's message, can carry what it was sent.
      { tenantId: request.tenant.tenantId, reason: errorClass(error) },
      'oidc discovery failed',
    );
    throw oidcFailed();
  }
  if (provider === undefined) throw methodDisabled();
  return provider;
}
