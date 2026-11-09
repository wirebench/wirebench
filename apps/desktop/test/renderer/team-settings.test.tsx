import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { TeamSettings } from '../../src/renderer/features/team/settings/team-settings.js';
import { useAccountStore } from '../../src/renderer/state/account.js';
import { useActiveTeamStore } from '../../src/renderer/state/active-team.js';
import { useTeamStore } from '../../src/renderer/state/team.js';
import { useUiStore, type TeamSettingsTarget } from '../../src/renderer/state/ui.js';
import { useSettingsPlaceStore } from '../../src/renderer/features/address/settings-place.js';
import type { AccountWire, TeamMemberWire, TeamWire, TeamWorkspaceWire } from '@wirebench/wire/wire-base';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

const URL_ = 'https://wb.test';
const account: AccountWire = {
  url: URL_,
  userId: 'me',
  email: 'me@wb.test',
  displayName: 'Me',
  deviceName: 'd',
  signedOut: false,
  addedAt: '2026-09-24T12:00:00.000Z',
};
const team = (myRole: 'member' | 'admin', id: string, name: string): TeamWire => ({
  id,
  name,
  myRole,
  createdAt: '2026-09-25T10:00:00.000Z',
});
const member = (userId: string, role: 'member' | 'admin'): TeamMemberWire => ({
  userId,
  email: `${userId}@wb.test`,
  displayName: userId,
  role,
  disabled: false,
  addedAt: '2026-09-25T10:00:00.000Z',
});
const workspace = (id: string, teamId: string): TeamWorkspaceWire => ({
  id,
  name: id,
  teamId,
  teamName: teamId,
  defaultRole: 'viewer',
  myRole: 'viewer',
  source: 'default',
  createdAt: '2026-09-25T10:00:00.000Z',
  recordDesktopActivity: false,
});
const ok = <T,>(value: T) => vi.fn().mockResolvedValue({ ok: true, value });

function install(
  teams: TeamWire[],
  { serverAdmin = false, extra = {} }: { serverAdmin?: boolean; extra?: Record<string, unknown> } = {},
) {
  return installWirebenchApi({
    team: {
      list: ok({ teams, serverAdmin }),
      listWorkspaces: ok({ workspaces: [workspace('W2', 'T2')] }),
      members: ok({ members: [member('me', 'admin')] }),
      invitations: ok({ invitations: [] }),
      ...extra,
    },
    audit: { query: ok({ events: [] }), export: ok({ saved: false }) },
  });
}

const TEAMS = [team('admin', 'T1', 'Payments QA'), team('member', 'T2', 'Support')];

function show(target: TeamSettingsTarget = {}) {
  useUiStore.getState().openTeamSettings(target);
  return render(<TeamSettings target={target} />);
}

const current = () => screen.getByTestId('team-settings').querySelector('nav [aria-current="page"]')?.textContent;

describe('Team settings (settings split spec §3, §5)', () => {
  let push: MockInstance<History['pushState']>;
  beforeEach(() => {
    useTeamStore.getState().reset();
    useAccountStore.setState({ servers: [account], active: null, loaded: true });
    window.history.replaceState(null, '', '/');
    push = vi.spyOn(window.history, 'pushState');
  });
  afterEach(() => {
    cleanup();
    push.mockRestore();
    useUiStore.getState().setPreferencesOpen(false);
    window.history.replaceState(null, '', '/');
  });

  it('opens on Overview for the team in the address', async () => {
    install(TEAMS);
    show({ teamId: 'T2' });
    await waitFor(() => expect(screen.getByTestId('team-switcher').textContent).toContain('Support'));
    await waitFor(() => expect(current()).toBe('Overview'));
    expect(screen.getByTestId('team-overview')).toBeTruthy();
    expect(useSettingsPlaceStore.getState()).toMatchObject({ team: 'T2', page: 'overview' });
  });

  it('opens on the active account’s server when no server is asked for (switch accounts spec §4)', async () => {
    const { team: calls } = install(TEAMS) as unknown as { team: { list: ReturnType<typeof vi.fn> } };
    useAccountStore.setState({
      servers: [account, { ...account, url: 'https://second.test', userId: 'u-second' }],
      active: { url: 'https://second.test', userId: 'u-second' },
    });
    show();
    await waitFor(() => expect(calls.list).toHaveBeenCalledWith({ url: 'https://second.test' }));
  });

  it('an unknown team falls back to the first', async () => {
    install(TEAMS);
    show({ teamId: 'NOPE' });
    await waitFor(() => expect(screen.getByTestId('team-switcher').textContent).toContain('Payments QA'));
    await waitFor(() => expect(useSettingsPlaceStore.getState()).toMatchObject({ team: 'T1', page: 'overview' }));
  });

  it('an unknown page falls back to Overview', async () => {
    install(TEAMS);
    // `license` is a server admin's; this caller is not one.
    show({ teamId: 'T1', page: 'license' });
    await waitFor(() => expect(current()).toBe('Overview'));
    expect(screen.queryByTestId('license-tab')).toBeNull();
  });

  it('a workspace link opens Overview on that workspace’s team', async () => {
    install(TEAMS);
    show({ workspaceId: 'W2' });
    await waitFor(() => expect(screen.getByTestId('team-switcher').textContent).toContain('Support'));
    await waitFor(() => expect(useSettingsPlaceStore.getState()).toMatchObject({ team: 'T2', page: 'overview' }));
  });

  it('switching team lands on its Overview and reports the team', async () => {
    install([team('admin', 'T1', 'Payments QA'), team('admin', 'T2', 'Support')]);
    show({ teamId: 'T1', page: 'workspaces' });
    await waitFor(() => expect(current()).toBe('Workspaces'));
    fireEvent.pointerDown(screen.getByTestId('team-switcher'), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByTestId('team-switcher-T2'));
    await waitFor(() => expect(useSettingsPlaceStore.getState()).toMatchObject({ team: 'T2', page: 'overview' }));
    expect(current()).toBe('Overview');
    expect(push).not.toHaveBeenCalled();
  });

  it('a team picked here becomes the title bar’s team too on the same server', async () => {
    install([team('admin', 'T1', 'Payments QA'), team('admin', 'T2', 'Support')]);
    await useActiveTeamStore.getState().load({ url: URL_, userId: 'me' });
    expect(useActiveTeamStore.getState().teamId).toBe('T1');
    show({ teamId: 'T1' });
    await waitFor(() => expect(current()).toBe('Overview'));
    fireEvent.pointerDown(screen.getByTestId('team-switcher'), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByTestId('team-switcher-T2'));
    await waitFor(() => expect(useActiveTeamStore.getState().teamId).toBe('T2'));
    useActiveTeamStore.setState({ url: undefined, userId: undefined, teams: [], workspaces: [], teamId: undefined });
  });

  it('a page change reports the page', async () => {
    install(TEAMS);
    window.history.replaceState(null, '', '/?keep=1');
    show({ teamId: 'T1' });
    await waitFor(() => expect(current()).toBe('Overview'));
    fireEvent.click(screen.getByTestId('team-settings-nav-workspaces'));
    await waitFor(() => expect(useSettingsPlaceStore.getState()).toMatchObject({ team: 'T1', page: 'workspaces' }));
    expect(push).not.toHaveBeenCalled();
  });

  it('Back to workspace closes', async () => {
    install(TEAMS);
    window.history.replaceState(null, '', '/?keep=1&panel=team&team=T1&page=people');
    show({ teamId: 'T1', page: 'people' });
    await waitFor(() => expect(current()).toBe('People'));
    fireEvent.click(screen.getByTestId('settings-back'));
    expect(useUiStore.getState().preferences.open).toBe(false);
  });

  it('New team… creates the team and lands on its Overview with the setup list', async () => {
    const created = team('admin', 'T3', 'New');
    const list = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, value: { teams: TEAMS, serverAdmin: true } })
      .mockResolvedValue({ ok: true, value: { teams: [...TEAMS, created], serverAdmin: true } });
    const create = ok({ team: created });
    install(TEAMS, { serverAdmin: true, extra: { list, create } });
    show({ teamId: 'T1', page: 'workspaces' });
    await waitFor(() => expect(current()).toBe('Workspaces'));
    fireEvent.pointerDown(screen.getByTestId('team-switcher'), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByTestId('team-switcher-new'));
    const dialog = await screen.findByTestId('team-new-dialog');
    fireEvent.change(within(dialog).getByTestId('team-new-name'), { target: { value: 'New' } });
    fireEvent.click(within(dialog).getByTestId('team-new-submit'));
    await vi.waitFor(() => expect(create).toHaveBeenCalledWith({ url: URL_, name: 'New' }));
    await waitFor(() => expect(screen.getByTestId('team-switcher').textContent).toContain('New'));
    await waitFor(() => expect(current()).toBe('Overview'));
    await waitFor(() => expect(useSettingsPlaceStore.getState()).toMatchObject({ team: 'T3', page: 'overview' }));
    expect(await screen.findByTestId('team-overview-setup')).toBeTruthy();
    expect(screen.queryByTestId('team-new-dialog')).toBeNull();
  });

  it('a member with no team sees the not-on-a-team text; a server admin sees Create your first team and the Server group', async () => {
    install([]);
    show();
    const empty = await screen.findByTestId('team-settings-empty');
    expect(empty.textContent).toContain('You’re not on a team on this server yet. A server admin can add you.');
    expect(screen.queryByTestId('team-settings-nav-license')).toBeNull();
    cleanup();
    useTeamStore.getState().reset();

    install([], { serverAdmin: true });
    show();
    await waitFor(() => expect(screen.getByTestId('team-settings-nav-license')).toBeTruthy());
    const nav = screen.getByTestId('team-settings').querySelector('nav');
    expect(nav?.textContent).toContain('Server');
    expect(nav?.textContent).not.toContain('This team');
    const adminEmpty = screen.getByTestId('team-settings-empty');
    expect(adminEmpty.textContent).toContain('Create your first team');
    fireEvent.click(within(adminEmpty).getByRole('button', { name: 'New team…' }));
    expect(await screen.findByTestId('team-new-dialog')).toBeTruthy();
  });

  it('a server admin with no team still opens a Server page the address names', async () => {
    install([], { serverAdmin: true });
    show({ page: 'license' });
    await waitFor(() => expect(current()).toBe('License and seats'));
    expect(screen.queryByTestId('team-settings-empty')).toBeNull();
  });

  it('switching to a team the caller does not admin leaves Audit log for its Overview', async () => {
    install(TEAMS);
    show({ teamId: 'T1', page: 'audit' });
    await waitFor(() => expect(current()).toBe('Audit log'));
    fireEvent.pointerDown(screen.getByTestId('team-switcher'), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByTestId('team-switcher-T2'));
    await waitFor(() => expect(current()).toBe('Overview'));
    expect(screen.queryByTestId('team-settings-nav-audit')).toBeNull();
    await waitFor(() => expect(useSettingsPlaceStore.getState()).toMatchObject({ team: 'T2', page: 'overview' }));
  });

  it('a signed-out server offers Sign in again', async () => {
    const no = vi.fn().mockResolvedValue({ ok: false, error: { code: 'identity-unauthenticated', message: 'x' } });
    installWirebenchApi({ team: { list: no, listWorkspaces: no } });
    show();
    fireEvent.click(await screen.findByTestId('team-sign-in-again'));
    expect(useUiStore.getState().signInDialog).toEqual({ open: true, url: URL_ });
    expect(useUiStore.getState().preferences.open).toBe(false);
  });
});
