/**
 * The `webhook-capture` ServerModule (spec §3.1). It is registered after server-sync and before
 * live-updates in the shared `/api/v1` scope: its management routes need teams-access's role guard,
 * and the live hub subscribes to its announcements. Its public route is served at the root, outside
 * `/api/v1`, through `registerPublic` (Task 5).
 */
import { fileURLToPath } from 'node:url';
import type { ServerModule } from '../context.js';

/** Beside `dist/`, like every module's migrations (`ServerModule.migrationsDir`). */
export const HOOKS_MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/webhook-capture/', import.meta.url));

export function hooksModule(): ServerModule {
  return {
    name: 'webhook-capture',
    migrationsDir: HOOKS_MIGRATIONS_DIR,
    async register(): Promise<void> {
      await Promise.resolve();
    },
  };
}
