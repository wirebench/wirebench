import { describe, expect, it } from 'vitest';
import {
  accessEntrySchema,
  MAX_TEAMS_NAME_LENGTH,
  memberAddRequestSchema,
  TEAMS_ID_PATTERN,
  teamInvitationCreatedSchema,
  teamSchema,
  teamsIdSchema,
  teamWorkspaceCreateRequestSchema,
  teamWorkspaceSchema,
  teamWorkspaceUpdateRequestSchema,
} from '../../../src/index.js';

const ID = '01J8ZC5Q0V7R3T9XK2M4N6P8QA';

describe('server-api teams schemas', () => {
  it('ids are upper-case 26-character ULIDs and nothing else', () => {
    expect(TEAMS_ID_PATTERN.test(ID)).toBe(true);
    for (const bad of [ID.toLowerCase(), `${ID}X`, '../etc', '', 'I'.repeat(26), 'U'.repeat(26)]) {
      expect(teamsIdSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('names are 1 to MAX_TEAMS_NAME_LENGTH characters', () => {
    expect(MAX_TEAMS_NAME_LENGTH).toBe(80);
    expect(teamWorkspaceCreateRequestSchema.safeParse({ name: '' }).success).toBe(false);
    expect(teamWorkspaceCreateRequestSchema.safeParse({ name: 'x'.repeat(81) }).success).toBe(false);
    expect(teamWorkspaceCreateRequestSchema.parse({ name: 'Integration' })).toEqual({ name: 'Integration' });
  });

  it('workspace creation takes an optional ULID and an optional default role, never admin', () => {
    expect(teamWorkspaceCreateRequestSchema.parse({ id: ID, name: 'A', defaultRole: 'none' }).defaultRole).toBe('none');
    expect(teamWorkspaceCreateRequestSchema.safeParse({ name: 'A', defaultRole: 'admin' }).success).toBe(false);
    expect(teamWorkspaceCreateRequestSchema.safeParse({ id: 'nope', name: 'A' }).success).toBe(false);
    expect(teamWorkspaceUpdateRequestSchema.parse({})).toEqual({});
  });

  it('parse the documented response examples', () => {
    expect(
      teamSchema.parse({ id: ID, name: 'Payments QA', myRole: 'admin', createdAt: '2026-09-25T10:00:00.000Z' }).myRole,
    ).toBe('admin');
    expect(
      teamWorkspaceSchema.parse({
        id: ID,
        name: 'Integration',
        teamId: ID,
        teamName: 'Payments QA',
        defaultRole: 'viewer',
        myRole: 'editor',
        source: 'grant',
        createdAt: '2026-09-25T10:00:00.000Z',
      }).source,
    ).toBe('grant');
    expect(
      accessEntrySchema.parse({
        userId: ID,
        email: 'bob@example.com',
        displayName: 'Bob',
        teamRole: 'member',
        disabled: false,
        effectiveRole: 'none',
      }).effectiveRole,
    ).toBe('none');
    expect(
      teamInvitationCreatedSchema.safeParse({
        id: ID,
        email: 'b@x.co',
        role: 'member',
        url: 'not a url',
        expiresAt: 'x',
      }).success,
    ).toBe(false);
  });

  it('a member is added by email with a closed role list', () => {
    expect(memberAddRequestSchema.safeParse({ email: 'bob@example.com', role: 'owner' }).success).toBe(false);
    expect(memberAddRequestSchema.parse({ email: 'bob@example.com', role: 'member' }).role).toBe('member');
  });
});
