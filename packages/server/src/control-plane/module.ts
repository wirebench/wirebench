/**
 * The `control-plane` module (hosted edition spec §22, ADR-0039): the tenants' lifecycle and billing. It is
 * registered in every mode for its migration (`0023`, spec §22.3), and serves nothing outside hosted mode. In hosted
 * mode it takes the control role's pool from `ctx.control`, which `serve.ts` sets, and refuses to register without
 * it. It serves nothing yet: the signup, the webhook and the sweeps come in later tasks.
 */
import { fileURLToPath } from 'node:url';
import { WirebenchError } from '@wirebench/engine';
import type { ServerContext, ServerModule } from '../context.js';
import { controlDbOf, type ControlDb } from './control-db.js';

/** Migration `0023`: the tenants' new columns, the control tables and the three scoped ones. */
export const CONTROL_PLANE_MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/control-plane/', import.meta.url));

/**
 * The control pool in hosted mode, or `undefined` on a self-hosted server.
 *
 * @throws WirebenchError `control-plane-control-db-missing` in hosted mode without one
 */
function controlOf(ctx: ServerContext): ControlDb | undefined {
  if (ctx.config.mode !== 'hosted') return undefined;
  if (ctx.control === undefined) {
    throw new WirebenchError(
      'control-plane-control-db-missing',
      "hosted mode needs the control role's pool (WIREBENCH_SERVER_CONTROL_DATABASE_URL), which serve opens",
    );
  }
  return controlDbOf(ctx.control);
}

export function controlPlaneModule(): ServerModule {
  return {
    name: 'control-plane',
    migrationsDir: CONTROL_PLANE_MIGRATIONS_DIR,
    register: (_app, ctx) => {
      // Nothing outside hosted mode; in hosted mode, nothing yet beyond the check that the pool was handed over.
      void controlOf(ctx);
      return Promise.resolve();
    },
  };
}
