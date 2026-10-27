/**
 * Whether a host's sessions are logged (#414), free of zod: the renderer imports it eagerly to show the
 * switch, and main asks the same question when a session opens.
 */

/** A host's or a group's own switch, keyed `host:<id>` or `group:<id>`. */
export type LogSwitches = Readonly<Record<string, boolean>>;

export interface LogSwitchTarget {
  readonly kind: 'host' | 'group';
  readonly id: string;
}

export const logSwitchKey = (target: LogSwitchTarget): string => `${target.kind}:${target.id}`;

export interface ResolvedLogSwitch {
  readonly on: boolean;
  /** Where the answer comes from: the host's own switch, the nearest group that has one, or the default (off). */
  readonly from: 'host' | { readonly group: string } | 'default';
}

/** The nearest switch wins: the host's own, then its groups from the nearest up (`path` is root first). */
export function resolveLogSwitch(switches: LogSwitches, hostId: string, path: readonly string[]): ResolvedLogSwitch {
  const own = switches[logSwitchKey({ kind: 'host', id: hostId })];
  if (own !== undefined) return { on: own, from: 'host' };
  for (let i = path.length - 1; i >= 0; i -= 1) {
    const group = path[i] as string;
    const set = switches[logSwitchKey({ kind: 'group', id: group })];
    if (set !== undefined) return { on: set, from: { group } };
  }
  return { on: false, from: 'default' };
}
