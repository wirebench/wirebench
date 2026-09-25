// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WirebenchError } from '@wirebench/engine';

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  },
}));

const { registerTeamChannels } = await import('../src/main/ipc/team.js');
const { channels } = await import('../src/shared/ipc.js');

type Envelope =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: { code: string; message: string } };
const invoke = (channel: string, payload: unknown): Promise<Envelope> =>
  handlers.get(channel)!({ sender: {} }, payload) as Promise<Envelope>;

const TOKEN = `wbs_${'A'.repeat(43)}`;
const TEAM_ID = '01J8ZC5Q0V7R3T9XK2M4N6P8QA';
const USER_ID = '01J8ZC5Q0V7R3T9XK2M4N6P8QB';
const WS_ID = '01J8ZC5Q0V7R3T9XK2M4N6P8QC';
const TEAM = { id: TEAM_ID, name: 'Payments QA', myRole: 'admin', createdAt: '2026-09-25T10:00:00.000Z' };
const WORKSPACE = {
  id: WS_ID,
  name: 'Integration',
  teamId: TEAM_ID,
  teamName: 'Payments QA',
  defaultRole: 'viewer',
  myRole: 'admin',
  source: 'grant',
  createdAt: '2026-09-25T10:00:00.000Z',
};

// A default parameter also fires on an explicit `undefined` argument, so `fakes(undefined)`
// below (simulating a signed-out account) would otherwise silently fall back to TOKEN; rest
// args distinguish "call omitted the argument" from "call passed undefined".
function fakes(...args: [] | [string | undefined]) {
  const token = args.length === 0 ? TOKEN : args[0];
  const client = {
    me: vi.fn().mockResolvedValue({ user: { id: USER_ID, email: 'a@b.co', displayName: 'A', serverAdmin: true } }),
    listTeams: vi.fn().mockResolvedValue([TEAM]),
    createTeam: vi.fn().mockResolvedValue(TEAM),
    renameTeam: vi.fn().mockResolvedValue(TEAM),
    deleteTeam: vi.fn().mockResolvedValue(undefined),
    listMembers: vi.fn().mockResolvedValue([]),
    addMember: vi.fn(),
    setMemberRole: vi.fn(),
    removeMember: vi.fn().mockResolvedValue(undefined),
    listTeamInvitations: vi.fn().mockResolvedValue([]),
    inviteToTeam: vi.fn(),
    revokeTeamInvitation: vi.fn().mockResolvedValue(undefined),
    listWorkspaces: vi.fn().mockResolvedValue([WORKSPACE]),
    createWorkspace: vi.fn().mockResolvedValue(WORKSPACE),
    updateWorkspace: vi.fn().mockResolvedValue(WORKSPACE),
    deleteWorkspace: vi.fn().mockResolvedValue(undefined),
    workspaceAccess: vi.fn().mockResolvedValue([]),
    setAccess: vi.fn().mockResolvedValue(undefined),
    clearAccess: vi.fn().mockResolvedValue(undefined),
  };
  const accounts = { tokenFor: vi.fn().mockResolvedValue(token), markSignedOut: vi.fn() };
  return { client, accounts };
}

describe('team.* channels (teams-access §3.5, §5.2)', () => {
  beforeEach(() => {
    handlers.clear();
  });

  it('registers every channel the contract declares', () => {
    registerTeamChannels(fakes());
    expect([...handlers.keys()].sort()).toEqual(
      Object.values(channels.team)
        .map((c) => c.name)
        .sort(),
    );
  });

  it('team.list answers the teams and whether the caller is a server admin, with the account token', async () => {
    const f = fakes();
    registerTeamChannels(f);
    expect(await invoke('team.list', { url: 'https://WB.test/some/path' })).toEqual({
      ok: true,
      value: { teams: [TEAM], serverAdmin: true },
    });
    expect(f.accounts.tokenFor).toHaveBeenCalledWith('https://wb.test');
    expect(f.client.listTeams).toHaveBeenCalledWith('https://wb.test', TOKEN);
  });

  it('with no token it answers account-signed-out and never calls the server', async () => {
    const f = fakes(undefined);
    registerTeamChannels(f);
    const res = await invoke('team.listWorkspaces', { url: 'https://wb.test' });
    expect(res).toMatchObject({ ok: false, error: { code: 'account-signed-out' } });
    expect(f.client.listWorkspaces).not.toHaveBeenCalled();
  });

  it('a rejected token marks the account signed out; other problems pass through untouched', async () => {
    const f = fakes();
    f.client.listTeams.mockRejectedValueOnce(new WirebenchError('identity-unauthenticated', 'Sign in to continue.'));
    f.client.setMemberRole.mockRejectedValueOnce(
      new WirebenchError('teams-last-admin', 'A team needs at least one admin.'),
    );
    registerTeamChannels(f);
    expect(await invoke('team.list', { url: 'https://wb.test' })).toMatchObject({
      ok: false,
      error: { code: 'identity-unauthenticated' },
    });
    expect(f.accounts.markSignedOut).toHaveBeenCalledWith('https://wb.test');
    expect(
      await invoke('team.setMemberRole', { url: 'https://wb.test', teamId: TEAM_ID, userId: USER_ID, role: 'member' }),
    ).toMatchObject({ ok: false, error: { code: 'teams-last-admin', message: 'A team needs at least one admin.' } });
    expect(f.accounts.markSignedOut).toHaveBeenCalledTimes(1);
  });

  it('passes bodies without undefined fields and wraps answers', async () => {
    const f = fakes();
    registerTeamChannels(f);
    expect(
      await invoke('team.createWorkspace', { url: 'https://wb.test', teamId: TEAM_ID, name: 'Integration' }),
    ).toEqual({
      ok: true,
      value: { workspace: WORKSPACE },
    });
    expect(f.client.createWorkspace).toHaveBeenCalledWith('https://wb.test', TOKEN, TEAM_ID, { name: 'Integration' });
    await invoke('team.updateWorkspace', { url: 'https://wb.test', workspaceId: WS_ID, defaultRole: 'none' });
    expect(f.client.updateWorkspace).toHaveBeenCalledWith('https://wb.test', TOKEN, WS_ID, { defaultRole: 'none' });
    expect(
      await invoke('team.setAccess', { url: 'https://wb.test', workspaceId: WS_ID, userId: USER_ID, role: 'editor' }),
    ).toEqual({ ok: true, value: { done: true } });
    expect(f.client.setAccess).toHaveBeenCalledWith('https://wb.test', TOKEN, WS_ID, USER_ID, 'editor');
  });
});
