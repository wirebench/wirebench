import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

describe('Team settings › Overview (settings split spec §3.2)', () => {
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

  it('counts members and workspaces and shows the created date', async () => {
    await open('member');
    expect(screen.getByTestId('team-overview-members').textContent).toBe('3 members');
    expect(screen.getByTestId('team-overview-workspaces').textContent).toBe('2 workspaces');
    expect(screen.getByTestId('team-overview-created').textContent).toContain(
      new Date('2026-09-25T10:00:00.000Z').toLocaleDateString(),
    );
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
