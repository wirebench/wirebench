import type { ServerModule } from './context.js';
import { identityModule } from './identity/module.js';
import { liveModule } from './live/module.js';
import { syncModule } from './sync/module.js';
import { teamsModule } from './teams/module.js';

/**
 * The modules a production process runs, in registration order. Tests pass their own list.
 * server-sync comes after teams-access: its routes are guarded by teams-access's role rule.
 * live-updates comes last. It resolves roles through teams-access, and `@fastify/websocket` wraps
 * only the routes registered after it in the shared scope.
 */
export const BUILTIN_MODULES: readonly ServerModule[] = [identityModule(), teamsModule(), syncModule(), liveModule()];
