import type { ForwardStateWire } from '../../../../shared/forward-wire.js';
import type { ForwardGroupWire, HostsFileWire, ResolvedHostWire } from '../../../../shared/ssh-wire.js';
import { useHostsStore } from '../hosts-store.js';
import { forwardKey } from './forward-format.js';
import { startForward, stopForward } from './forward-actions.js';
import { isLive, useForwardsStore, type ForwardStartError } from './forwards-store.js';

/**
 * Forwarding groups (#583): named sets of rules of any hosts, kept in `hosts.yaml` beside the rules and
 * started or stopped together. A rule (host and rule id) is in one group at most. These helpers edit the
 * listed file; the hosts store saves it, and main writes the version the file then needs.
 */

const groupsOf = (file: HostsFileWire): readonly ForwardGroupWire[] => file.forwardGroups ?? [];

/** The group a rule of a host is in, if any. */
export function groupOfRule(file: HostsFileWire, hostId: string, ruleId: string): ForwardGroupWire | undefined {
  return groupsOf(file).find((group) => group.rules.some((m) => m.host === hostId && m.rule === ruleId));
}

/** An id for a new group, from its name: lower-case words joined by dashes, numbered when taken. */
export function freeGroupId(file: HostsFileWire, name: string): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'group';
  const taken = new Set(groupsOf(file).map((group) => group.id));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${String(n)}`)) return `${base}-${String(n)}`;
}

const withGroups = (file: HostsFileWire, forwardGroups: ForwardGroupWire[]): HostsFileWire => ({
  ...file,
  forwardGroups,
});

/** Takes a rule out of whatever group holds it. */
function without(groups: readonly ForwardGroupWire[], hostId: string, ruleId: string): ForwardGroupWire[] {
  return groups.map((group) => ({
    ...group,
    rules: group.rules.filter((m) => !(m.host === hostId && m.rule === ruleId)),
  }));
}

/** Adds a group, holding `rule` when given (taken out of its old group first). */
export function createGroup(
  file: HostsFileWire,
  name: string,
  rule?: { readonly hostId: string; readonly ruleId: string },
): { file: HostsFileWire; id: string } {
  const id = freeGroupId(file, name);
  const groups = rule === undefined ? [...groupsOf(file)] : without(groupsOf(file), rule.hostId, rule.ruleId);
  const rules = rule === undefined ? [] : [{ host: rule.hostId, rule: rule.ruleId }];
  return { file: withGroups(file, [...groups, { id, name, rules }]), id };
}

export function renameGroup(file: HostsFileWire, id: string, name: string): HostsFileWire {
  return withGroups(
    file,
    groupsOf(file).map((group) => (group.id === id ? { ...group, name } : group)),
  );
}

/** Removes a group; its rules stay in `hosts.yaml` and show under Ungrouped. */
export function deleteGroup(file: HostsFileWire, id: string): HostsFileWire {
  return withGroups(
    file,
    groupsOf(file).filter((group) => group.id !== id),
  );
}

/** Moves a rule into a group (last), or out of every group with `undefined`. */
export function moveRule(
  file: HostsFileWire,
  hostId: string,
  ruleId: string,
  toGroupId: string | undefined,
): HostsFileWire {
  const groups = without(groupsOf(file), hostId, ruleId).map((group) =>
    group.id === toGroupId ? { ...group, rules: [...group.rules, { host: hostId, rule: ruleId }] } : group,
  );
  return withGroups(file, groups);
}

/** Saves an edit of the groups; answers the problem to show, or `undefined` once saved. */
export async function saveGroups(next: HostsFileWire): Promise<string | undefined> {
  const { save } = useHostsStore.getState();
  if (await save(next)) return undefined;
  return useHostsStore.getState().problems[0]?.message ?? 'The forwarding groups could not be saved';
}

/** A member's rule as `hosts.yaml` now resolves it: absent when its host or rule has gone. */
function resolvedRule(resolved: readonly ResolvedHostWire[], hostId: string, ruleId: string) {
  return resolved.find((h) => h.id === hostId)?.forwards.find((f) => f.rule.id === ruleId);
}

/** What a group's rules are doing in this window. `total` counts the rules that can run (present and on). */
export interface GroupStatus {
  readonly total: number;
  readonly running: number;
  readonly failed: number;
}

export function groupStatus(
  group: ForwardGroupWire,
  resolved: readonly ResolvedHostWire[],
  byKey: Readonly<Record<string, ForwardStateWire>>,
  startErrors: Readonly<Record<string, ForwardStartError>>,
): GroupStatus {
  let total = 0;
  let running = 0;
  let failed = 0;
  for (const member of group.rules) {
    const key = forwardKey(member.host, member.rule);
    const state = byKey[key];
    if (resolvedRule(resolved, member.host, member.rule)?.enabled === true) total++;
    if (isLive(state)) running++;
    else if (state?.status.state === 'failed' || startErrors[key] !== undefined) failed++;
  }
  return { total, running, failed };
}

/** "2 of 3 running · 1 failed". */
export function groupStatusText({ total, running, failed }: GroupStatus): string {
  const base = `${String(running)} of ${String(total)} running`;
  return failed > 0 ? `${base} · ${String(failed)} failed` : base;
}

/**
 * Starts every rule of a group that is present, on and not already live, all at once: each connects to its
 * host as needed, and one that fails (its error shown on its row) does not hold up or stop the others.
 */
export async function startGroup(id: string): Promise<void> {
  const { file, resolved } = useHostsStore.getState();
  const group = groupsOf(file).find((g) => g.id === id);
  if (group === undefined) return;
  const { byKey } = useForwardsStore.getState();
  const startable = group.rules.filter(
    (m) => resolvedRule(resolved, m.host, m.rule)?.enabled === true && !isLive(byKey[forwardKey(m.host, m.rule)]),
  );
  await Promise.allSettled(startable.map((m) => startForward(m.host, m.rule)));
}

/** Stops every rule of a group this window runs, and clears the failed ones and refused starts. */
export async function stopGroup(id: string): Promise<void> {
  const group = groupsOf(useHostsStore.getState().file).find((g) => g.id === id);
  if (group === undefined) return;
  const { byKey, setStartError } = useForwardsStore.getState();
  for (const m of group.rules) setStartError(forwardKey(m.host, m.rule), undefined);
  const held = group.rules.filter((m) => byKey[forwardKey(m.host, m.rule)] !== undefined);
  await Promise.allSettled(held.map((m) => stopForward(m.host, m.rule)));
}
