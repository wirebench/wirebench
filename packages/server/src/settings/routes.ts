/**
 * `/api/v1/tenant/settings` (hosted edition spec §22.12): a tenant's server admins read every section, and write or
 * clear one. A secret is never answered, only whether one is set. `budgets` is the operator's, refused to a tenant
 * with `settings-operator-only`; a self-hosted server's settings are its environment, read-only, and a write is
 * refused with `settings-environment`.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { auditSource, type ServerContext } from '../context.js';
import { requireServerAdmin } from '../identity/guard.js';
import { rateLimit, TenantRateLimiter } from '../identity/rate-limit.js';
import { problem } from '../problem.js';
import { isSettingsSection, type SettingsSection } from './sections.js';
import { clearSection, saveSection, type SaveDeps } from './save.js';

const unknownSection = (name: string) =>
  problem('settings-unknown-section', `There is no settings section named "${name.slice(0, 40)}".`, 404);

function sectionOf(request: FastifyRequest): SettingsSection {
  const { section } = request.params as { readonly section: string };
  if (!isSettingsSection(section)) throw unknownSection(section);
  return section;
}

/** A tenant's saves a minute, refilled continuously: far above a person at a screen, low enough to bound discovery. */
export const SETTINGS_SAVES_PER_MINUTE = 20;

const SAVES_LIMITED = {
  code: 'settings-rate-limited',
  message: 'Too many settings changes. Try again shortly.',
} as const;

export const settingsRoutes =
  (ctx: ServerContext, deps: Omit<SaveDeps, 'settings' | 'hooks'> & { readonly now?: () => number }) =>
  (app: FastifyInstance): void => {
    const { now, ...saveDeps } = deps;
    const save: SaveDeps = { ...saveDeps, settings: ctx.settings, hooks: ctx.hooks };
    // One bucket per tenant, shared by every instance: each save may ask an issuer for its discovery document or
    // resolve a host, so a script cannot make the server do that without bound.
    const limiter = new TenantRateLimiter({
      name: 'tenant-settings',
      capacity: SETTINGS_SAVES_PER_MINUTE,
      refillPerMs: SETTINGS_SAVES_PER_MINUTE / 60_000,
      db: ctx.tenancy.db,
      ...(now !== undefined ? { now } : {}),
    });
    const limited = rateLimit({ limiter }, (request) => [`${request.tenant.tenantId}:saves`], SAVES_LIMITED);
    const answer = async (request: FastifyRequest) => ({
      source: ctx.settings.source,
      sections: await ctx.settings.view(request.tenant),
    });

    app.get('/tenant/settings', { preHandler: requireServerAdmin }, (request) => answer(request));

    app.put('/tenant/settings/:section', { preHandler: [requireServerAdmin, limited] }, async (request) => {
      const section = sectionOf(request);
      await saveSection(save, request.tenant, section, request.body ?? {}, {
        by: request.caller!.id,
        source: auditSource(request),
      });
      return answer(request);
    });

    app.delete('/tenant/settings/:section', { preHandler: requireServerAdmin }, async (request) => {
      const section = sectionOf(request);
      await clearSection(save, request.tenant, section, { by: request.caller!.id, source: auditSource(request) });
      return answer(request);
    });
  };
