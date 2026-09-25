import type { ServerModule } from './context.js';
import { identityModule } from './identity/module.js';
import { teamsModule } from './teams/module.js';

/** The modules a production process runs, in registration order. Tests pass their own list. */
export const BUILTIN_MODULES: readonly ServerModule[] = [identityModule(), teamsModule()];
