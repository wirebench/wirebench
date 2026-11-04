/**
 * `/api/v1/tenant/settings` (hosted edition spec §22.12): a tenant's server admins read every section, and write or
 * clear one. A secret is never answered, only whether one is set. `budgets` is the operator's, refused to a tenant
 * with `settings-operator-only`; a self-hosted server's settings are its environment, read-only, and a write is
 * refused with `settings-environment`.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { auditSource, type ServerContext } from '../context.js';
import { requireServerAdmin } from '../identity/guard.js';
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

export const settingsRoutes =
  (ctx: ServerContext, deps: Omit<SaveDeps, 'settings' | 'hooks'>) =>
  (app: FastifyInstance): void => {
    const save: SaveDeps = { ...deps, settings: ctx.settings, hooks: ctx.hooks };
    const answer = async (request: FastifyRequest) => ({
      source: ctx.settings.source,
      sections: await ctx.settings.view(request.tenant),
    });

    app.get('/tenant/settings', { preHandler: requireServerAdmin }, (request) => answer(request));

    app.put('/tenant/settings/:section', { preHandler: requireServerAdmin }, async (request) => {
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
