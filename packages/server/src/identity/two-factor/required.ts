import type { ServerContext } from '../../context.js';
import type { TenantScope } from '../../tenancy/scope.js';

/**
 * Whether `scope`'s password sign-in needs a second factor (two-step sign-in spec §6): a hosted team's own
 * `twoFactor` setting, or a self-hosted server's `WIREBENCH_SERVER_REQUIRE_TWO_FACTOR` (plan ruling 10).
 */
export async function twoFactorRequired(ctx: Pick<ServerContext, 'settings'>, scope: TenantScope): Promise<boolean> {
  return (await ctx.settings.of(scope, 'twoFactor'))?.required === true;
}
