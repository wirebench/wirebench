/**
 * People (settings split spec §3.3): a team's members and open invitations as one list. Pure, so the order, the
 * filters and the counts are tested without a page.
 */
import type { TeamInvitationWire, TeamMemberWire } from '@shared/wire-base.js';

export type PersonRow =
  | { readonly kind: 'member'; readonly member: TeamMemberWire; readonly you: boolean }
  | { readonly kind: 'invitation'; readonly invitation: TeamInvitationWire; readonly expiresInDays: number };

export type PeopleFilter = 'all' | 'joined' | 'waiting';

const DAY_MS = 86_400_000;
const byText = (a: string, b: string): number => a.localeCompare(b, undefined, { sensitivity: 'base' });

/** Members by name, then invitations by email. */
export function peopleRows(
  members: readonly TeamMemberWire[],
  invitations: readonly TeamInvitationWire[],
  youId: string | undefined,
  now: Date,
): readonly PersonRow[] {
  const joined = [...members]
    .sort((a, b) => byText(a.displayName, b.displayName) || byText(a.email, b.email))
    .map((member): PersonRow => ({ kind: 'member', member, you: youId !== undefined && member.userId === youId }));
  const waiting = [...invitations]
    .sort((a, b) => byText(a.email, b.email))
    .map((invitation): PersonRow => ({
      kind: 'invitation',
      invitation,
      expiresInDays: Math.max(0, Math.ceil((Date.parse(invitation.expiresAt) - now.getTime()) / DAY_MS)),
    }));
  return [...joined, ...waiting];
}

function matches(row: PersonRow, query: string): boolean {
  if (query === '') return true;
  const words = row.kind === 'member' ? [row.member.displayName, row.member.email] : [row.invitation.email];
  return words.some((word) => word.toLowerCase().includes(query));
}

export function filterPeople(rows: readonly PersonRow[], filter: PeopleFilter, query: string): readonly PersonRow[] {
  const wanted = query.trim().toLowerCase();
  return rows.filter(
    (row) =>
      (filter === 'all' || (filter === 'joined' ? row.kind === 'member' : row.kind === 'invitation')) &&
      matches(row, wanted),
  );
}

export function peopleCounts(rows: readonly PersonRow[]): Readonly<Record<PeopleFilter, number>> {
  const joined = rows.filter((row) => row.kind === 'member').length;
  return { all: rows.length, joined, waiting: rows.length - joined };
}
