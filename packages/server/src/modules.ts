import type { ServerModule } from './context.js';
import { auditLogModule } from './audit-log/module.js';
import { ciTokensModule } from './ci-tokens/module.js';
import { hooksModule } from './hooks/module.js';
import { identityModule } from './identity/module.js';
import { licensingModule } from './licensing/module.js';
import { liveModule } from './live/module.js';
import { syncModule } from './sync/module.js';
import { teamsModule } from './teams/module.js';

/**
 * The modules a production process runs, in registration order. Tests pass their own list.
 * licensing comes right after identity: its routes need identity's guard, and identity's seat checks
 * read `ctx.license` at request time.
 * server-sync comes after teams-access: its routes are guarded by teams-access's role rule.
 * webhook-capture comes next: its routes use the same guard, and the hub listens to its
 * announcements (webhook-capture §3.1).
 * ci-tokens comes after webhook-capture: a CI token may call only that module's capture reads.
 * live-updates comes last. It resolves roles through teams-access, and `@fastify/websocket` wraps
 * only the routes registered after it in the shared scope.
 * audit-log comes last: its routes sit behind identity's guard and read `ctx.license`; its hook is found at
 * call time, so fire sites in earlier modules reach it.
 */
export const BUILTIN_MODULES: readonly ServerModule[] = [
  identityModule(),
  licensingModule(),
  teamsModule(),
  syncModule(),
  hooksModule(),
  ciTokensModule(),
  liveModule(),
  auditLogModule(),
];
