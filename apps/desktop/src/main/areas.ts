import type { HandlerTable } from './ipc/register.js';
import { resolveFeatures, type FeatureState } from '@wirebench/engine';
import { enabledAreaIds, toAreaIds } from '@wirebench/wire/area-module';
import type { AreaId } from '@wirebench/wire/area-module';
import {
  AREA_SWITCH_DESCRIPTORS,
  LOCAL_TERMINAL_SWITCH,
  SERIAL_SWITCH,
  TELNET_SWITCH,
} from '@wirebench/wire/area-switches';
import { registerLocalTerminalChannels } from './areas/local-terminal-channels.js';
import { registerSshChannels } from './areas/ssh.js';

export { LOCAL_TERMINAL_SWITCH, SERIAL_SWITCH, TELNET_SWITCH };

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

/** This run's area switches resolved (operator area switches spec §3). */
export interface AreasRun {
  /** The areas that are on, in rail order. */
  readonly enabled: readonly AreaId[];
  /** Whether the local terminal tab (#410) is on: with the SSH area, unless switched off on its own. */
  readonly localTerminal: boolean;
  /** Whether Telnet hosts (#425) connect: with the SSH area, unless switched off on its own. */
  readonly telnet: boolean;
  /** Whether serial consoles (#426) connect: with the SSH area, unless switched off on its own. */
  readonly serial: boolean;
  /** One row per area switch, in `AREA_SWITCH_DESCRIPTORS` order, for Settings → Features → Areas. */
  readonly states: readonly FeatureState[];
}

/**
 * Resolves the area switches the way the engine resolves feature switches: the managed policy
 * (`policy.yaml` `areas`, #360), when it names an id, wins and the area is off; else `WIREBENCH_AREAS`,
 * when it names it; else the default (on). Then `requires` applies, so `ssh=off` takes the local
 * terminal, Telnet and serial with it. The policy can only switch off: `ssh=on` in the environment
 * under a policy that locks `ssh` off changes nothing.
 */
export function resolveAreas(input: {
  /** The ids the managed policy switches off (`Policy.areasOff`). */
  readonly policy?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
}): AreasRun {
  const { states } = resolveFeatures(AREA_SWITCH_DESCRIPTORS, {
    policy: input.policy ?? [],
    preference: parseAreaSwitches((input.env ?? process.env)['WIREBENCH_AREAS']),
  });
  const on = (id: string): boolean => states.find((state) => state.id === id)?.enabled === true;
  return {
    enabled: toAreaIds(states.filter((state) => state.enabled).map((state) => state.id)),
    localTerminal: on(LOCAL_TERMINAL_SWITCH),
    telnet: on(TELNET_SWITCH),
    serial: on(SERIAL_SWITCH),
    states,
  };
}

/**
 * The areas `WIREBENCH_AREAS` leaves on, with no managed policy. Kept as the shared filter's parity
 * check: `enabledAreaIds` (ADR-0021, a local copy of the engine's rules) and {@link resolveAreas} must
 * agree, which the areas test pins.
 */
export function enabledAreasFromEnv(env: NodeJS.ProcessEnv = process.env): readonly AreaId[] {
  return enabledAreaIds(parseAreaSwitches(env['WIREBENCH_AREAS']));
}

/** Whether the local terminal tab is on with no managed policy; see {@link resolveAreas}. */
export function localTerminalFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveAreas({ env }).localTerminal;
}

/** Whether Telnet hosts connect with no managed policy; see {@link resolveAreas}. */
export function telnetFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveAreas({ env }).telnet;
}

/** Whether serial hosts connect with no managed policy; see {@link resolveAreas}. */
export function serialFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveAreas({ env }).serial;
}

/** Registers the IPC channels of the areas that are switched on; an off area answers nothing. */
export function registerEnabledAreaChannels(
  table: HandlerTable,
  enabled: readonly AreaId[],
  deps: Parameters<typeof registerSshChannels>[1] & {
    /** The local terminal's shells; `undefined` while {@link localTerminalFromEnv} has it off. */
    readonly localTerminal?: Parameters<typeof registerLocalTerminalChannels>[1] | undefined;
  },
): void {
  if (!enabled.includes('ssh')) return;
  registerSshChannels(table, deps);
  if (deps.localTerminal !== undefined) registerLocalTerminalChannels(table, deps.localTerminal);
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
