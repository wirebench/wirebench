import { z } from 'zod';
import { SshModelError } from './errors.js';

const ID = /^[a-z0-9][a-z0-9-]*$/;

/** One rule of a group: a host and a rule that host resolves to (its own, or one of its groups'). */
export interface ForwardGroupMember {
  readonly host: string;
  readonly rule: string;
}

/**
 * A forwarding group (#583): a named set of rules, from any hosts, started and stopped together. A rule is in
 * at most one group. A member whose host or rule has since gone stays listed, so renaming or removing a rule
 * never stops `hosts.yaml` from loading; the app shows it as removed.
 */
export interface ForwardGroupEntry {
  readonly id: string;
  readonly name: string;
  readonly rules: readonly ForwardGroupMember[];
}

const memberSchema = z.strictObject({ host: z.string().regex(ID), rule: z.string().regex(ID) });

export const forwardGroupSchema: z.ZodType<ForwardGroupEntry> = z.strictObject({
  id: z.string().regex(ID),
  name: z.string().min(1),
  rules: z.array(memberSchema).default([]),
});

/** The first `hosts.yaml` version that may hold `forwardGroups`. */
export const FORWARD_GROUPS_VERSION = 2;

export const memberKey = (member: ForwardGroupMember): string => `${member.host}/${member.rule}`;

/**
 * Group ids are their own namespace and unique; a rule (host and rule id) sits in one group, once.
 * @throws SshModelError `ssh-forward-group-duplicate-id` | `ssh-forward-group-member-twice`
 */
export function checkForwardGroups(groups: readonly ForwardGroupEntry[]): void {
  const ids = new Set<string>();
  const owner = new Map<string, string>();
  for (const group of groups) {
    if (ids.has(group.id)) {
      throw new SshModelError('ssh-forward-group-duplicate-id', `forwarding group id "${group.id}" is used twice`, {
        id: group.id,
      });
    }
    ids.add(group.id);
    for (const member of group.rules) {
      const key = memberKey(member);
      const previous = owner.get(key);
      if (previous !== undefined) {
        const where = previous === group.id ? `twice in "${group.id}"` : `in both "${previous}" and "${group.id}"`;
        throw new SshModelError(
          'ssh-forward-group-member-twice',
          `forward "${member.rule}" of host "${member.host}" is listed ${where}; a rule belongs to one group`,
          { host: member.host, rule: member.rule, groups: [previous, group.id] },
        );
      }
      owner.set(key, group.id);
    }
  }
}

/** The YAML form, keys in order. */
export function serializeForwardGroup(group: ForwardGroupEntry): Record<string, unknown> {
  return {
    id: group.id,
    name: group.name,
    rules: group.rules.map((member) => ({ host: member.host, rule: member.rule })),
  };
}
