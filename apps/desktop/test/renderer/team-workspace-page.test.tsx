import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { TeamWire, TeamWorkspaceWire } from '@wirebench/wire/wire-base';
import { WorkspacePage } from '../../src/renderer/features/team/settings/workspace-page.js';
import { WorkspacesPage } from '../../src/renderer/features/team/settings/workspaces-page.js';
import { useActiveTeamStore } from '../../src/renderer/state/active-team.js';
import { useTeamStore } from '../../src/renderer/state/team.js';
import { useWorkspaceStore } from '../../src/renderer/state/workspace.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

const URL_ = 'https://wb.test';
const TEAM: TeamWire = { id: 'T1', name: 'Platform', myRole: 'admin', createdAt: '2026-11-01T10:00:00.000Z' };
const workspace = (id: string, overrides: Partial<TeamWorkspaceWire> = {}): TeamWorkspaceWire => ({
  id,
  name: id,
  teamId: 'T1',
  teamName: 'Platform',
  defaultRole: 'viewer',
  myRole: 'admin',
  source: 'team-admin',
  createdAt: '2026-11-01T10:00:00.000Z',
  createdBy: 'u1',
  createdByName: 'Dana',
  grantCount: 1,
  recordDesktopActivity: false,
  ...overrides,
});
const ok = <T,>(value: T) => vi.fn().mockResolvedValue({ ok: true, value });

function install(extra: Record<string, unknown> = {}) {
  return installWirebenchApi({
    team: {
      list: ok({ teams: [TEAM], serverAdmin: false }),
      listWorkspaces: ok({ workspaces: [workspace('W1'), workspace('W2', { myRole: 'viewer', source: 'default' })] }),
      members: ok({ members: [] }),
      invitations: ok({ invitations: [] }),
      access: ok({
        entries: [
          {
            userId: 'u1',
            email: 'dana@wb.test',
            displayName: 'Dana',
            disabled: false,
            teamRole: 'admin',
            effectiveRole: 'admin',
            source: 'team-admin',
          },
        ],
      }),
      ...extra,
    },
  });
}

describe('Team settings › a workspace’s overview and the Workspaces rows', () => {
  beforeEach(() => {
    useTeamStore.getState().reset();
    useActiveTeamStore.setState({ url: undefined, userId: undefined, teams: [], workspaces: [], teamId: undefined });
  });
  afterEach(() => {
    cleanup();
  });

  it('Workspaces lists rows that open each workspace’s overview', async () => {
    install();
    await useTeamStore.getState().open(URL_);
    render(<WorkspacesPage />);
    const rows = screen.getAllByTestId('team-workspace-row');
    expect(rows).toHaveLength(2);
    fireEvent.click(rows[0]!);
    expect(useTeamStore.getState()).toMatchObject({ page: 'workspace', workspaceId: 'W1' });
  });

  it('shows the card, when and by whom it was made, and who can open it; the breadcrumb goes back', async () => {
    const api = install();
    await useTeamStore.getState().open(URL_, { page: 'workspace', workspaceId: 'W1' });
    expect(useTeamStore.getState().workspaceId).toBe('W1');
    render(<WorkspacePage />);
    expect(screen.getByTestId('workspace-row-W1')).toBeTruthy();
    expect(screen.getByTestId('workspace-page-facts').textContent).toContain(
      'by Dana · Viewer by default · 1 with a grant',
    );
    await waitFor(() => expect(api.team.access).toHaveBeenCalledWith({ url: URL_, workspaceId: 'W1' }));
    expect(await screen.findByTestId('access-row-u1')).toBeTruthy();
    expect(screen.queryByTestId('access-back')).toBeNull();
    fireEvent.click(screen.getByTestId('workspace-page-back'));
    expect(useTeamStore.getState()).toMatchObject({ page: 'workspaces', workspaceId: undefined });
  });

  it('a viewer sees no access list; a workspace that is gone says so', async () => {
    const api = install();
    await useTeamStore.getState().open(URL_);
    useTeamStore.getState().openWorkspacePage('W2');
    render(<WorkspacePage />);
    expect(screen.queryByTestId('access-panel')).toBeNull();
    expect(api.team.access).not.toHaveBeenCalled();
    cleanup();
    useTeamStore.getState().openWorkspacePage('GONE');
    render(<WorkspacePage />);
    expect(screen.getByTestId('workspace-page-missing')).toBeTruthy();
  });

  it('Delete confirms, then lands on Workspaces', async () => {
    const api = install({ deleteWorkspace: ok({ done: true }) });
    await useTeamStore.getState().open(URL_);
    useTeamStore.getState().openWorkspacePage('W1');
    render(<WorkspacePage />);
    fireEvent.click(screen.getByTestId('workspace-delete-W1'));
    fireEvent.click(await screen.findByTestId('workspace-delete-confirm-ok'));
    await waitFor(() => expect(api.team.deleteWorkspace).toHaveBeenCalledWith({ url: URL_, workspaceId: 'W1' }));
    await waitFor(() => expect(useTeamStore.getState().page).toBe('workspaces'));
  });

  it('a change in Team settings reloads the title bar’s teams and the workspace list on the same server', async () => {
    const api = install({ updateWorkspace: ok({ workspace: workspace('W1', { name: 'Renamed' }) }) });
    useActiveTeamStore.setState({ url: URL_, userId: 'u1', teams: [TEAM], workspaces: [], teamId: 'T1' });
    const list = vi.fn().mockResolvedValue(undefined);
    useWorkspaceStore.setState({ list });
    await useTeamStore.getState().open(URL_);
    const calls = (): number => (api.team.list as ReturnType<typeof vi.fn>).mock.calls.length;
    const before = calls();
    await useTeamStore.getState().updateWorkspace('W1', { name: 'Renamed' });
    expect(list).toHaveBeenCalled();
    // Once for this store's refresh, once for the title bar's.
    expect(calls()).toBe(before + 2);
  });
});
