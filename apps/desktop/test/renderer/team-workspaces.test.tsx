import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { WorkspacesTab } from '../../src/renderer/features/team/workspaces-tab.js';
import { useTeamStore } from '../../src/renderer/state/team.js';
import type { AccessEntryWire, TeamWire, TeamWorkspaceWire } from '../../src/shared/wire-types.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

const URL_ = 'https://wb.test';
const team: TeamWire = { id: 'T1', name: 'Payments QA', myRole: 'member', createdAt: '2026-09-25T10:00:00.000Z' };
const workspace = (overrides: Partial<TeamWorkspaceWire> = {}): TeamWorkspaceWire => ({
  id: 'W1',
  name: 'Integration',
  teamId: 'T1',
  teamName: 'Payments QA',
  defaultRole: 'viewer',
  myRole: 'viewer',
  source: 'default',
  createdAt: '2026-09-25T10:00:00.000Z',
  ...overrides,
});
const entry = (userId: string, overrides: Partial<AccessEntryWire> = {}): AccessEntryWire => ({
  userId,
  email: `${userId}@wb.test`,
  displayName: userId,
  teamRole: 'member',
  disabled: false,
  effectiveRole: 'viewer',
  source: 'default',
  ...overrides,
});
const ok = <T,>(value: T) => vi.fn().mockResolvedValue({ ok: true, value });

async function openWith(spaces: TeamWorkspaceWire[], extra: Record<string, unknown> = {}) {
  const api = installWirebenchApi({
    team: {
      list: ok({ teams: [team], serverAdmin: false }),
      listWorkspaces: ok({ workspaces: spaces }),
      members: ok({ members: [] }),
      ...extra,
    },
  });
  await useTeamStore.getState().open(URL_);
  useTeamStore.getState().setTab('workspaces');
  render(<WorkspacesTab />);
  return api;
}

describe('WorkspacesTab (teams-access §3.5)', () => {
  beforeEach(() => {
    useTeamStore.getState().reset();
  });
  afterEach(() => {
    cleanup();
  });

  it('a viewer sees their role and its source, and nothing to change, but can still create a workspace', async () => {
    await openWith([workspace()]);
    expect(screen.getByTestId('workspace-role-W1').textContent).toBe('Viewer (workspace default)');
    expect(screen.getByTestId<HTMLInputElement>('workspace-name-W1').readOnly).toBe(true);
    expect(screen.queryByTestId('workspace-default-W1')).toBeNull();
    expect(screen.queryByTestId('workspace-access-W1')).toBeNull();
    expect(screen.queryByTestId('workspace-delete-W1')).toBeNull();
    expect(screen.getByTestId('workspace-new')).toBeTruthy();
  });

  it('a member creates a workspace with a chosen default role', async () => {
    const createWorkspace = ok({ workspace: workspace({ id: 'W2', name: 'Staging' }) });
    await openWith([], { createWorkspace });
    fireEvent.click(screen.getByTestId('workspace-new'));
    fireEvent.change(screen.getByTestId('workspace-new-name'), { target: { value: 'Staging' } });
    fireEvent.change(screen.getByTestId('workspace-new-default'), { target: { value: 'none' } });
    fireEvent.click(screen.getByTestId('workspace-new-submit'));
    await vi.waitFor(() =>
      expect(createWorkspace).toHaveBeenCalledWith({ url: URL_, teamId: 'T1', name: 'Staging', defaultRole: 'none' }),
    );
  });

  it('a workspace admin changes the default role and deletes after confirming', async () => {
    const updateWorkspace = ok({ workspace: workspace({ myRole: 'admin', source: 'grant', defaultRole: 'none' }) });
    const deleteWorkspace = ok({ done: true });
    await openWith([workspace({ myRole: 'admin', source: 'grant' })], { updateWorkspace, deleteWorkspace });
    expect(screen.getByTestId('workspace-role-W1').textContent).toBe('Admin (granted)');
    fireEvent.change(screen.getByTestId('workspace-default-W1'), { target: { value: 'none' } });
    await vi.waitFor(() =>
      expect(updateWorkspace).toHaveBeenCalledWith({ url: URL_, workspaceId: 'W1', defaultRole: 'none' }),
    );
    fireEvent.click(screen.getByTestId('workspace-delete-W1'));
    fireEvent.click(await screen.findByTestId('workspace-delete-confirm-ok'));
    await vi.waitFor(() => expect(deleteWorkspace).toHaveBeenCalledWith({ url: URL_, workspaceId: 'W1' }));
  });

  it('the access panel shows effective roles; grants set and clear, admins are fixed', async () => {
    const access = ok({
      entries: [
        entry('ann', { teamRole: 'admin', effectiveRole: 'admin', source: 'team-admin' }),
        entry('bob'),
        entry('cy', { effectiveRole: 'editor', source: 'grant', grant: 'editor' }),
      ],
    });
    const setAccess = ok({ done: true });
    const clearAccess = ok({ done: true });
    await openWith([workspace({ myRole: 'admin', source: 'grant' })], { access, setAccess, clearAccess });
    fireEvent.click(screen.getByTestId('workspace-access-W1'));
    await screen.findByTestId('access-row-bob');
    expect(screen.getByTestId('access-effective-ann').textContent).toBe('Admin (team admin)');
    expect(screen.getByTestId<HTMLSelectElement>('access-grant-ann').disabled).toBe(true);
    expect(screen.getByTestId<HTMLSelectElement>('access-grant-bob').value).toBe('');
    expect(screen.getByTestId<HTMLSelectElement>('access-grant-cy').value).toBe('editor');

    fireEvent.change(screen.getByTestId('access-grant-bob'), { target: { value: 'editor' } });
    await vi.waitFor(() =>
      expect(setAccess).toHaveBeenCalledWith({ url: URL_, workspaceId: 'W1', userId: 'bob', role: 'editor' }),
    );
    fireEvent.change(screen.getByTestId('access-grant-cy'), { target: { value: '' } });
    await vi.waitFor(() => expect(clearAccess).toHaveBeenCalledWith({ url: URL_, workspaceId: 'W1', userId: 'cy' }));

    fireEvent.click(screen.getByTestId('access-back'));
    expect(screen.queryByTestId('access-panel')).toBeNull();
  });

  it('a member with no access shows as No access', async () => {
    const access = ok({ entries: [entry('dee', { effectiveRole: 'none', source: undefined })] });
    await openWith([workspace({ myRole: 'admin', source: 'team-admin', defaultRole: 'none' })], { access });
    fireEvent.click(screen.getByTestId('workspace-access-W1'));
    expect((await screen.findByTestId('access-effective-dee')).textContent).toBe('No access');
  });
});
