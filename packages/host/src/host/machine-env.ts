/** The environment a host reads overrides from (`WIREBENCH_AREAS`, `WIREBENCH_E2E_*` and the like). */
import type { HostPlatform } from './platform.js';

/**
 * The process environment, or nothing on a host without machine values (a server host): its
 * process's variables are the operator's, not the user's, and must never steer what the host does.
 */
export function machineEnv(platform: Pick<HostPlatform, 'machineValues'>): NodeJS.ProcessEnv {
  return platform.machineValues === false ? {} : process.env;
}
