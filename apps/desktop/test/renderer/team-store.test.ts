import { beforeEach, describe, expect, it, vi } from 'vitest';
import { teamWorkspaces, useTeamStore } from '../../src/renderer/state/team.js';
import type { TeamMemberWire, TeamWire, TeamWorkspaceWire } from '../../src/shared/wire-types.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

const URL_ = 'https://wb.test';
const team = (id: string, myRole: 'member' | 'admin' = 'admin'): TeamWire => ({
  id,
  name: `Team ${id}`,
  myRole,
  createdAt: '2026-09-25T10:00:00.000Z',
});
const member = (userId: string, role: 'member' | 'admin' = 'member'): TeamMemberWire => ({
  userId,
  email: `${userId}@wb.test`,
  displayName: userId,
  role,
  disabled: false,
  addedAt: '2026-09-25T10:00:00.000Z',
});
const workspace = (id: string, teamId: string): TeamWorkspaceWire => ({
  id,
  name: `W ${id}`,
  teamId,
  teamName: `Team ${teamId}`,
  defaultRole: 'viewer',
  myRole: 'admin',
  source: 'team-admin',
  createdAt: '2026-09-25T10:00:00.000Z',
});
const ok = <T>(value: T) => vi.fn().mockResolvedValue({ ok: true, value });
const err = (code: string, message = 'nope') => vi.fn().mockResolvedValue({ ok: false, error: { code, message } });

describe('useTeamStore (teams-access §3.5)', () => {
  beforeEach(() => {
    useTeamStore.getState().reset();
  });

  it('open loads the teams, selects the first, and loads its members and invitations', async () => {
    const api = installWirebenchApi({
      team: {
        list: ok({ teams: [team('A'), team('B', 'member')], serverAdmin: false }),
        listWorkspaces: ok({ workspaces: [workspace('w1', 'A'), workspace('w2', 'B')] }),
        members: ok({ members: [member('u1', 'admin')] }),
        invitations: ok({ invitations: [] }),
      },
    });
    await useTeamStore.getState().open(URL_);
    const state = useTeamStore.getState();
    expect(state.teamId).toBe('A');
    expect(state.members.map((m) => m.userId)).toEqual(['u1']);
    expect(teamWorkspaces(state).map((w) => w.id)).toEqual(['w1']);
    expect(api.team.members).toHaveBeenCalledWith({ url: URL_, teamId: 'A' });
    expect(api.team.invitations).toHaveBeenCalledWith({ url: URL_, teamId: 'A' });
  });

  it('a plain member never asks for invitations', async () => {
    const api = installWirebenchApi({
      team: {
        list: ok({ teams: [team('B', 'member')], serverAdmin: false }),
        listWorkspaces: ok({ workspaces: [] }),
        members: ok({ members: [] }),
      },
    });
    await useTeamStore.getState().open(URL_);
    expect(api.team.invitations).not.toHaveBeenCalled();
    expect(useTeamStore.getState().invitations).toEqual([]);
  });

  it('a signed-out answer flips signedOut instead of toasting', async () => {
    installWirebenchApi({
      team: { list: err('account-signed-out'), listWorkspaces: err('account-signed-out') },
    });
    await useTeamStore.getState().open(URL_);
    expect(useTeamStore.getState().signedOut).toBe(true);
  });

  it('a failed write reports false; a good one refreshes', async () => {
    const api = installWirebenchApi({
      team: {
        list: ok({ teams: [team('A')], serverAdmin: false }),
        listWorkspaces: ok({ workspaces: [] }),
        members: ok({ members: [member('u1', 'admin')] }),
        invitations: ok({ invitations: [] }),
        setMemberRole: err('teams-last-admin', 'A team needs at least one admin.'),
        addMember: ok({ member: member('u2') }),
      },
    });
    await useTeamStore.getState().open(URL_);
    expect(await useTeamStore.getState().setMemberRole('u1', 'member')).toBe(false);
    expect(api.team.members).toHaveBeenCalledTimes(1);
    expect(await useTeamStore.getState().addMember('u2@wb.test', 'member')).toBe(true);
    expect(api.team.addMember).toHaveBeenCalledWith({ url: URL_, teamId: 'A', email: 'u2@wb.test', role: 'member' });
    expect(api.team.members).toHaveBeenCalledTimes(2);
  });

  it('invite keeps the created link for the dialog to show once', async () => {
    const created = {
      id: 'i1',
      email: 'new@wb.test',
      role: 'member' as const,
      url: 'https://wb.test/invite/secret',
      expiresAt: '2026-10-02T10:00:00.000Z',
    };
    installWirebenchApi({
      team: {
        list: ok({ teams: [team('A')], serverAdmin: false }),
        listWorkspaces: ok({ workspaces: [] }),
        members: ok({ members: [] }),
        invitations: ok({ invitations: [] }),
        invite: ok({ invitation: created }),
      },
    });
    await useTeamStore.getState().open(URL_);
    expect(await useTeamStore.getState().invite('new@wb.test', 'member')).toBe(true);
    expect(useTeamStore.getState().lastInvite).toEqual(created);
    useTeamStore.getState().clearLastInvite();
    expect(useTeamStore.getState().lastInvite).toBeUndefined();
  });

  it('drops an answer for a team that is no longer selected', async () => {
    let release: (value: { ok: true; value: { members: TeamMemberWire[] } }) => void = () => undefined;
    const slow = vi.fn(
      () =>
        new Promise<{ ok: true; value: { members: TeamMemberWire[] } }>((resolve) => {
          release = resolve;
        }),
    );
    installWirebenchApi({
      team: {
        list: ok({ teams: [team('A'), team('B')], serverAdmin: false }),
        listWorkspaces: ok({ workspaces: [] }),
        members: slow,
        invitations: ok({ invitations: [] }),
      },
    });
    const opening = useTeamStore.getState().open(URL_);
    await vi.waitFor(() => expect(slow).toHaveBeenCalled());
    useTeamStore.setState({ teamId: 'B' });
    release({ ok: true, value: { members: [member('stale')] } });
    await opening;
    expect(useTeamStore.getState().members).toEqual([]);
  });
});
