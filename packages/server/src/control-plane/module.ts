/**
 * The `control-plane` module (hosted edition spec §22, ADR-0039): the tenants' lifecycle and billing. It is
 * registered in every mode for its migration (`0023`, spec §22.3), and serves nothing yet.
 */
import { fileURLToPath } from 'node:url';
import type { ServerModule } from '../context.js';

/** Migration `0023`: the tenants' new columns, the control tables and the three scoped ones. */
export const CONTROL_PLANE_MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/control-plane/', import.meta.url));

export function controlPlaneModule(): ServerModule {
  return {
    name: 'control-plane',
    migrationsDir: CONTROL_PLANE_MIGRATIONS_DIR,
    register: () => Promise.resolve(),
  };
}
