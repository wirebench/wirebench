import { enabledAreaIds } from '../shared/area-module.js';
import type { AreaId } from '../shared/area-module.js';
import { registerLocalTerminalChannels } from './areas/local-terminal-channels.js';
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

/** The `WIREBENCH_AREAS` key that switches the local terminal tab (#410) off while leaving SSH on. */
export const LOCAL_TERMINAL_SWITCH = 'local-terminal';

/**
 * Whether the local terminal tab is on: it rides with the SSH area (`ssh=off` removes it too), and an enterprise
 * build can switch it off on its own with `local-terminal=off`.
 */
export function localTerminalFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const switches = parseAreaSwitches(env['WIREBENCH_AREAS']);
  return enabledAreaIds(switches).includes('ssh') && switches[LOCAL_TERMINAL_SWITCH] !== false;
}

/** The `WIREBENCH_AREAS` key that switches Telnet hosts (#425) off while leaving SSH on. */
export const TELNET_SWITCH = 'telnet';

/** Whether Telnet hosts connect: they ride with the SSH area, and an enterprise build can switch them off. */
export function telnetFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const switches = parseAreaSwitches(env['WIREBENCH_AREAS']);
  return enabledAreaIds(switches).includes('ssh') && switches[TELNET_SWITCH] !== false;
}

/** The `WIREBENCH_AREAS` key that switches serial consoles (#426) off while leaving SSH on. */
export const SERIAL_SWITCH = 'serial';

/** Whether serial hosts connect: they ride with the SSH area, and an enterprise build can switch them off. */
export function serialFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const switches = parseAreaSwitches(env['WIREBENCH_AREAS']);
  return enabledAreaIds(switches).includes('ssh') && switches[SERIAL_SWITCH] !== false;
}

/** Registers the IPC channels of the areas that are switched on; an off area answers nothing. */
export function registerEnabledAreaChannels(
  enabled: readonly AreaId[],
  deps: Parameters<typeof registerSshChannels>[0] & {
    /** The local terminal's shells; `undefined` while {@link localTerminalFromEnv} has it off. */
    readonly localTerminal?: Parameters<typeof registerLocalTerminalChannels>[0] | undefined;
  },
): void {
  if (!enabled.includes('ssh')) return;
  registerSshChannels(deps);
  if (deps.localTerminal !== undefined) registerLocalTerminalChannels(deps.localTerminal);
}

/**
 * A workspace change: the cached `hosts.yaml` (or `snippets.yaml`) belongs to the workspace left, so it is dropped; when the ssh
 * area is on, the renderer is told to read the new workspace's file (its store was reset on the switch).
 */
export function hostsOnWorkspaceChange(
  enabled: readonly AreaId[],
  hosts: { invalidate: () => void },
  notify: () => void,
): void {
  hosts.invalidate();
  if (enabled.includes('ssh')) notify();
}

/**
 * `hosts.yaml` (or `snippets.yaml`) changed on disk (an outside edit, or this app's own save): the cache is dropped, and the
 * renderer is told to re-read only when the ssh area is on, as on a workspace change.
 */
export function hostsOnFileChange(
  enabled: readonly AreaId[],
  hosts: { invalidate: () => void },
  notify: () => void,
): void {
  hosts.invalidate();
  if (enabled.includes('ssh')) notify();
}
