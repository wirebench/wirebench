import { enabledAreaIds } from '../shared/area-module.js';
import type { AreaId } from '../shared/area-module.js';
import { registerSshChannels } from './areas/ssh.js';

/** `WIREBENCH_AREAS="ssh=off,wss=off"`. Anything that is not `<id>=on|off` is ignored. */
export function parseAreaSwitches(env: string | undefined): Record<string, boolean> {
  const switches: Record<string, boolean> = {};
  for (const pair of (env ?? '').split(',')) {
    const [id, state] = pair.split('=').map((part) => part.trim().toLowerCase());
    if (!id || (state !== 'on' && state !== 'off')) continue;
    switches[id] = state === 'on';
  }
  return switches;
}

export function enabledAreasFromEnv(env: NodeJS.ProcessEnv = process.env): readonly AreaId[] {
  return enabledAreaIds(parseAreaSwitches(env['WIREBENCH_AREAS']));
}

/** Registers the IPC channels of the areas that are switched on; an off area answers nothing. */
export function registerEnabledAreaChannels(
  enabled: readonly AreaId[],
  deps: Parameters<typeof registerSshChannels>[0],
): void {
  if (enabled.includes('ssh')) registerSshChannels(deps);
}
