import type { ServerModule } from './context.js';
import { identityModule } from './identity/module.js';
import { syncModule } from './sync/module.js';
import { teamsModule } from './teams/module.js';

/**
 * The modules a production process runs, in registration order. Tests pass their own list.
 * server-sync comes after teams-access: its routes are guarded by teams-access's role rule.
 */
export const BUILTIN_MODULES: readonly ServerModule[] = [identityModule(), teamsModule(), syncModule()];
