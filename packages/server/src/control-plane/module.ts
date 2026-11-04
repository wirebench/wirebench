/**
 * The `control-plane` module (hosted edition spec §22, ADR-0039): the tenants' lifecycle and billing. It is
 * registered in every mode for its migration (`0023`, spec §22.3), and serves nothing outside hosted mode. In hosted
 * mode it takes the control role's pool as its factory's argument, which `serve.ts` passes through
 * {@link withControlPool}, and refuses to register without it: the pool is never on the shared `ServerContext`. It
 * serves nothing yet: the signup, the webhook and the sweeps come in later tasks.
 */
import { fileURLToPath } from 'node:url';
import { WirebenchError } from '@wirebench/engine';
import type { ServerContext, ServerModule } from '../context.js';
import type { ControlDb } from './control-db.js';

/** Migration `0023`: the tenants' new columns, the control tables and the three scoped ones. */
export const CONTROL_PLANE_MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/control-plane/', import.meta.url));

const NAME = 'control-plane';

export interface ControlPlaneOptions {
  /** The control role's pool, hosted mode only: `serve.ts` opens it. */
  readonly control?: ControlDb;
}

/**
 * The control pool in hosted mode, or `undefined` on a self-hosted server.
 *
 * @throws WirebenchError `control-plane-control-db-missing` in hosted mode without one
 */
function controlOf(ctx: ServerContext, control: ControlDb | undefined): ControlDb | undefined {
  if (ctx.config.mode !== 'hosted') return undefined;
  if (control === undefined) {
    throw new WirebenchError(
      'control-plane-control-db-missing',
      "hosted mode needs the control role's pool (WIREBENCH_SERVER_CONTROL_DATABASE_URL), which serve opens",
    );
  }
  return control;
}

export function controlPlaneModule(options: ControlPlaneOptions = {}): ServerModule {
  return {
    name: NAME,
    migrationsDir: CONTROL_PLANE_MIGRATIONS_DIR,
    register: (_app, ctx) => {
      // Nothing outside hosted mode; in hosted mode, nothing yet beyond the check that the pool was handed over.
      void controlOf(ctx, options.control);
      return Promise.resolve();
    },
  };
}

/**
 * `modules` with the control-plane entry built on `control` (spec §22.2): how `serve.ts` hands the pool over, to
 * this one module. Every other entry is returned as it was; without a pool (self-hosted mode) the list is unchanged.
 */
export function withControlPool(modules: readonly ServerModule[], control: ControlDb | undefined): ServerModule[] {
  if (control === undefined) return [...modules];
  return modules.map((module) => (module.name === NAME ? controlPlaneModule({ control }) : module));
}
