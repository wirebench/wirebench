import type { ServerConfig } from '../config.js';
import type { ServerContext } from '../context.js';
import type { OidcProvider } from './oidc.js';
import type { RateLimiter } from './rate-limit.js';

/** The §4.1 knobs the routes read, derived once from the configuration. */
export interface IdentitySettings {
  readonly local: boolean;
  readonly oidc: { readonly issuer: string; readonly displayName: string } | undefined;
  readonly tokenIdleMs: number;
  readonly tokenMaxMs: number;
  readonly invitationMs: number;
  readonly redirectUri: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function identitySettings(config: ServerConfig): IdentitySettings {
  return {
    local: config.localAuth,
    oidc:
      config.oidcIssuer === undefined ? undefined : { issuer: config.oidcIssuer, displayName: config.oidcDisplayName },
    tokenIdleMs: config.tokenIdleDays * DAY_MS,
    tokenMaxMs: config.tokenMaxDays * DAY_MS,
    invitationMs: config.invitationDays * DAY_MS,
    redirectUri: `${config.publicUrl}/api/v1/auth/oidc/callback`,
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
  readonly ctx: Pick<ServerContext, 'db' | 'config' | 'hooks'>;
  readonly settings: Pick<IdentitySettings, 'invitationMs' | 'local' | 'oidc'>;
  readonly now: () => Date;
}
