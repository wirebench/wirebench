import type { FeatureDescriptor } from '@wirebench/engine';
import { AREAS } from './area-module.js';

/** The `WIREBENCH_AREAS` (and `policy.yaml` `areas`) key that switches the local terminal tab (#410) off while leaving SSH on. */
export const LOCAL_TERMINAL_SWITCH = 'local-terminal';
/** The key that switches Telnet hosts (#425) off while leaving SSH on. */
export const TELNET_SWITCH = 'telnet';
/** The key that switches serial consoles (#426) off while leaving SSH on. */
export const SERIAL_SWITCH = 'serial';

/** The three switches that ride with the SSH area: off with it, and off on their own. */
export const AREA_SUB_SWITCHES: readonly FeatureDescriptor[] = [
  { id: LOCAL_TERMINAL_SWITCH, title: 'Local terminal', default: true, stage: 'stable', requires: ['ssh'] },
  { id: TELNET_SWITCH, title: 'Telnet hosts', default: true, stage: 'stable', requires: ['ssh'] },
  { id: SERIAL_SWITCH, title: 'Serial consoles', default: true, stage: 'stable', requires: ['ssh'] },
];

/**
 * Every area switch (operator area switches spec §2): each area's descriptor in rail order, then the
 * sub-switches. What `WIREBENCH_AREAS` and the managed `areas` section may name, and what Settings →
 * Features → Areas lists. Process-neutral (type-only engine import), so main's policy reader and the
 * renderer may both read it.
 */
export const AREA_SWITCH_DESCRIPTORS: readonly FeatureDescriptor[] = [
  ...AREAS.map((area) => area.feature),
  ...AREA_SUB_SWITCHES,
];

/** Whether `id` names an area switch. */
export function isAreaSwitchId(id: string): boolean {
  return AREA_SWITCH_DESCRIPTORS.some((descriptor) => descriptor.id === id);
}
