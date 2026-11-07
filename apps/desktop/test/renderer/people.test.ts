import { describe, expect, it } from 'vitest';
import { filterPeople, peopleCounts, peopleRows } from '../../src/renderer/features/team/settings/people.js';
import type { TeamInvitationWire, TeamMemberWire } from '@wirebench/wire/wire-base';

const member = (userId: string, displayName: string, email = `${userId}@wb.test`): TeamMemberWire => ({
  userId,
  email,
  displayName,
  role: 'member',
  disabled: false,
  addedAt: '2026-09-25T10:00:00.000Z',
});
const invitation = (id: string, email: string, expiresAt = '2026-11-10T12:00:00.000Z'): TeamInvitationWire => ({
  id,
  email,
  role: 'member',
  createdBy: null,
  createdAt: '2026-11-01T12:00:00.000Z',
  expiresAt,
});
const NOW = new Date('2026-11-07T12:00:00.000Z');
const ids = (rows: ReturnType<typeof peopleRows>) =>
  rows.map((row) => (row.kind === 'member' ? row.member.userId : row.invitation.id));

describe('People (settings split spec §3.3)', () => {
  const members = [member('u2', 'zoe'), member('u1', 'Adam'), member('u3', 'Bea', 'bea@corp.example')];
  const invitations = [invitation('i2', 'zed@wb.test'), invitation('i1', 'amy@wb.test')];

  it('lists members by name, then invitations by email', () => {
    expect(ids(peopleRows(members, invitations, undefined, NOW))).toEqual(['u1', 'u3', 'u2', 'i1', 'i2']);
  });

  it('marks your row', () => {
    const rows = peopleRows(members, [], 'u3', NOW);
    expect(rows.map((row) => row.kind === 'member' && row.you)).toEqual([false, true, false]);
  });

  it('filters joined and waiting, and counts each', () => {
    const rows = peopleRows(members, invitations, undefined, NOW);
    expect(ids(filterPeople(rows, 'joined', ''))).toEqual(['u1', 'u3', 'u2']);
    expect(ids(filterPeople(rows, 'waiting', ''))).toEqual(['i1', 'i2']);
    expect(filterPeople(rows, 'all', '')).toHaveLength(5);
    expect(peopleCounts(rows)).toEqual({ all: 5, joined: 3, waiting: 2 });
  });

  it('the search matches name and email, ignoring case', () => {
    const rows = peopleRows(members, invitations, undefined, NOW);
    expect(ids(filterPeople(rows, 'all', '  ADA '))).toEqual(['u1']);
    expect(ids(filterPeople(rows, 'all', 'CORP.example'))).toEqual(['u3']);
    expect(ids(filterPeople(rows, 'all', 'z'))).toEqual(['u2', 'i2']);
    expect(ids(filterPeople(rows, 'waiting', 'amy'))).toEqual(['i1']);
  });

  it('days left round up and never go below 0', () => {
    const rows = peopleRows(
      [],
      [
        invitation('a', 'a@x', '2026-11-10T12:00:00.000Z'),
        invitation('b', 'b@x', '2026-11-08T13:00:00.000Z'),
        invitation('c', 'c@x', '2026-11-01T00:00:00.000Z'),
      ],
      undefined,
      NOW,
    );
    expect(rows.map((row) => (row.kind === 'invitation' ? row.expiresInDays : -1))).toEqual([3, 2, 0]);
  });
});
