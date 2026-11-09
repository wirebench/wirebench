import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { OverviewPage } from '../../src/renderer/features/team/settings/overview-page.js';
import { useTeamStore } from '../../src/renderer/state/team.js';
import type { TeamMemberWire, TeamWire, TeamWorkspaceWire } from '@wirebench/wire/wire-base';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

const URL_ = 'https://wb.test';
const team = (myRole: 'member' | 'admin', id = 'T1', name = 'Payments QA'): TeamWire => ({
  id,
  name,
  myRole,
  createdAt: '2026-09-25T10:00:00.000Z',
});
const member = (userId: string): TeamMemberWire => ({
  userId,
  email: `${userId}@wb.test`,
  displayName: userId,
  role: 'member',
  disabled: false,
  addedAt: '2026-09-25T10:00:00.000Z',
});
const workspace = (id: string, teamId: string): TeamWorkspaceWire => ({
  id,
  name: id,
  teamId,
  teamName: teamId,
  defaultRole: 'viewer',
  myRole: 'admin',
  source: 'team-admin',
  createdAt: '2026-09-25T10:00:00.000Z',
  recordDesktopActivity: false,
});
const ok = <T,>(value: T) => vi.fn().mockResolvedValue({ ok: true, value });

async function open(myRole: 'member' | 'admin', serverAdmin = false, overrides: Record<string, unknown> = {}) {
  const api = installWirebenchApi({
    team: {
      list: ok({ teams: [team(myRole)], serverAdmin }),
      listWorkspaces: ok({ workspaces: [workspace('W1', 'T1'), workspace('W2', 'T1'), workspace('W3', 'T9')] }),
      members: ok({ members: [member('me'), member('bob'), member('cy')] }),
      invitations: ok({ invitations: [] }),
      ...overrides,
    },
  });
  await useTeamStore.getState().open(URL_);
  render(<OverviewPage />);
  return api;
}

describe('Team settings › Overview (settings split spec §3.2, team overview landing)', () => {
  beforeEach(() => {
    useTeamStore.getState().reset();
  });
  afterEach(() => {
    cleanup();
  });

  it('a team admin renames on blur', async () => {
    const api = await open('admin', false, { rename: ok({ team: team('admin', 'T1', 'Payments') }) });
    const name = screen.getByTestId<HTMLInputElement>('team-name');
    expect(name.readOnly).toBe(false);
    fireEvent.change(name, { target: { value: ' Payments ' } });
    fireEvent.blur(name);
    await waitFor(() => expect(api.team.rename).toHaveBeenCalledWith({ url: URL_, teamId: 'T1', name: 'Payments' }));
  });

  it('a member sees the name read-only', async () => {
    const api = await open('member');
    const name = screen.getByTestId<HTMLInputElement>('team-name');
    expect(name.readOnly).toBe(true);
    fireEvent.change(name, { target: { value: 'Other' } });
    fireEvent.keyDown(name, { key: 'Enter' });
    expect(api.team.rename).not.toHaveBeenCalled();
  });

  it('counts people and workspaces, says your role and when the team was made, and lists the workspaces', async () => {
    await open('member');
    expect(screen.getByTestId('team-overview-members').textContent).toContain('3');
    expect(screen.getByTestId('team-overview-members').textContent).toContain('3 joined');
    expect(screen.getByTestId('team-overview-workspaces').textContent).toContain('2');
    expect(screen.getByTestId('team-overview-role').textContent).toContain('You’re a member · created ');
    expect(screen.getAllByTestId('team-overview-workspace').map((row) => row.textContent)).toEqual([
      'W1Admin',
      'W2Admin',
    ]);
    // A member gets no admin actions, setup list or seats.
    expect(screen.queryByTestId('team-overview-add-people')).toBeNull();
    expect(screen.queryByTestId('team-overview-setup')).toBeNull();
    expect(screen.queryByTestId('team-overview-seats')).toBeNull();
  });

  it('a tile opens its page', async () => {
    await open('member');
    fireEvent.click(screen.getByTestId('team-overview-workspaces'));
    expect(useTeamStore.getState().page).toBe('workspaces');
    fireEvent.click(screen.getByTestId('team-overview-members'));
    expect(useTeamStore.getState().page).toBe('people');
  });

  it('a team admin of a new team gets the setup list, whose steps act', async () => {
    const api = await open('admin', false, {
      members: ok({ members: [member('me')] }),
      listWorkspaces: ok({ workspaces: [] }),
    });
    const setup = screen.getByTestId('team-overview-setup');
    expect(setup.textContent).toContain('Get Payments QA ready · 1 of 3 done');
    expect(screen.getByTestId('team-overview-step-name').dataset.done).toBe('true');
    expect(screen.getByTestId('team-overview-step-people').dataset.done).toBe('false');
    expect(screen.getByTestId('team-overview-no-workspaces').textContent).toBe('No workspaces yet.');

    fireEvent.click(screen.getByTestId('team-overview-step-add-people'));
    expect(await screen.findByTestId('add-people-email')).toBeTruthy();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });

    fireEvent.click(screen.getByTestId('team-overview-step-new-workspace'));
    fireEvent.change(screen.getByTestId('workspace-new-name'), { target: { value: 'Billing' } });
    fireEvent.click(screen.getByTestId('workspace-new-submit'));
    await waitFor(() =>
      expect(api.team.createWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({ url: URL_, teamId: 'T1', name: 'Billing' }),
      ),
    );
  });

  it('a team admin sees invitations waiting, with New link; the setup list goes once the team is set up', async () => {
    const api = await open('admin', false, {
      invitations: ok({
        invitations: [
          {
            id: 'I1',
            email: 'dana@wb.test',
            role: 'member',
            createdBy: null,
            createdAt: '2026-09-25T10:00:00.000Z',
            expiresAt: new Date(Date.now() + 5 * 86_400_000 - 60_000).toISOString(),
          },
        ],
      }),
      renewInvitation: ok({ invitation: { id: 'I2' }, url: 'https://wb.test/join/x' }),
    });
    expect(screen.queryByTestId('team-overview-setup')).toBeNull();
    expect(screen.getByTestId('team-overview-members').textContent).toContain('3 joined · 1 waiting');
    const row = screen.getByTestId('team-overview-invitation');
    expect(row.textContent).toContain('dana@wb.test · invited as Member · link expires in 5 days');
    fireEvent.click(within(row).getByTestId('team-overview-invitation-renew'));
    await waitFor(() => expect(api.team.renewInvitation).toHaveBeenCalled());
  });

  it('a server admin deletes the team after confirming; a team admin has no danger zone', async () => {
    const api = await open('admin', true, { delete: ok({ done: true }) });
    fireEvent.click(screen.getByTestId('team-delete'));
    expect(api.team.delete).not.toHaveBeenCalled();
    expect(await screen.findByText('Delete Payments QA?')).toBeTruthy();
    fireEvent.click(screen.getByTestId('team-delete-confirm-ok'));
    await waitFor(() => expect(api.team.delete).toHaveBeenCalledWith({ url: URL_, teamId: 'T1' }));
    cleanup();
    useTeamStore.getState().reset();
    await open('admin', false);
    expect(screen.queryByTestId('team-delete')).toBeNull();
  });
});
