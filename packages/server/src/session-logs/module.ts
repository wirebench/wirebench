/**
 * The `session-logs` ServerModule (team session logs spec A1, #430). Registered after the audit log: its
 * routes use teams-access's role guard and `ctx.license`, and it records audit events. A desktop streams
 * the masked text log of every SSH session on a recording workspace's hosts; members read it.
 */
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { ServerContext, ServerModule } from '../context.js';

export const SESSION_LOGS_MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/session-logs/', import.meta.url));
export const SESSION_LOGS_CAPABILITY = 'session-logs';

export function sessionLogsModule(): ServerModule {
  return {
    name: 'session-logs',
    migrationsDir: SESSION_LOGS_MIGRATIONS_DIR,
    register(_app: FastifyInstance, ctx: ServerContext): Promise<void> {
      // The workspace `recordSessionLogs` switch and these routes; a server without it hides both in the desktop.
      ctx.meta.addCapability(SESSION_LOGS_CAPABILITY);
      return Promise.resolve();
    },
  };
}
