import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TeamWire, TeamWorkspaceWire, WorkspaceSummaryWire } from '@wirebench/wire/wire-base';
import { switchTeam, TitleTeamSwitcher } from '../../src/renderer/features/team/team-switcher.js';
import { WorkspacePicker } from '../../src/renderer/features/workspace/picker-screen.js';
import { inOtherTeam, useActiveTeamStore } from '../../src/renderer/state/active-team.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import { useWorkspaceStore } from '../../src/renderer/state/workspace.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

const URL_A = 'https://wb.example.com';
const USER = 'u1';

function team(id: string, name: string): TeamWire {
  return { id, name, myRole: 'admin', createdAt: '2026-11-01T00:00:00.000Z' };
}

function teamWorkspace(id: string, name: string, teamId: string, teamName: string): TeamWorkspaceWire {
  return {
    id,
    name,
    teamId,
    teamName,
    myRole: 'admin',
    defaultRole: 'viewer',
    createdAt: '2026-11-01T00:00:00.000Z',
  } as TeamWorkspaceWire;
}

function serverRow(id: string, name: string, workspaceId: string): WorkspaceSummaryWire {
  return {
    id,
    name,
    dir: `/data/${id}`,
    projectCount: 1,
    internalProjectCount: 1,
    createdAt: '2026-11-01T00:00:00.000Z',
    share: { kind: 'server', managed: true, server: { url: URL_A, workspaceId, recording: false } },
  };
}

const TEAMS = [team('t1', 'Platform'), team('t2', 'CaaS')];
const SPACES = [teamWorkspace('s1', 'wtest1', 't1', 'Platform'), teamWorkspace('s2', 'billing', 't2', 'CaaS')];

describe('the active team', () => {
  beforeEach(() => {
    window.localStorage.clear();
    installWirebenchApi({
      team: {
        list: vi.fn().mockResolvedValue({ ok: true, value: { teams: TEAMS, serverAdmin: false } }),
        listWorkspaces: vi.fn().mockResolvedValue({ ok: true, value: { workspaces: SPACES } }),
      },
    });
    useActiveTeamStore.setState({ url: undefined, userId: undefined, teams: [], workspaces: [], teamId: undefined });
  });
  afterEach(() => {
    cleanup();
    useWorkspaceStore.setState({ workspace: null, workspaces: [] });
  });

  it('loads the account’s teams, starts on the first, and remembers a switch for that account', async () => {
    await useActiveTeamStore.getState().load({ url: URL_A, userId: USER });
    expect(useActiveTeamStore.getState().teamId).toBe('t1');

    useActiveTeamStore.getState().setTeam('t2');
    useActiveTeamStore.setState({ url: undefined, userId: undefined, teams: [], workspaces: [], teamId: undefined });
    await useActiveTeamStore.getState().load({ url: URL_A, userId: USER });

    expect(useActiveTeamStore.getState().teamId).toBe('t2');
  });

  it('follows a team workspace that opens, and leaves another team’s workspaces out', async () => {
    await useActiveTeamStore.getState().load({ url: URL_A, userId: USER });
    const state = (): ReturnType<typeof useActiveTeamStore.getState> => useActiveTeamStore.getState();

    expect(inOtherTeam(state(), URL_A, 's2')).toBe(true);
    expect(inOtherTeam(state(), URL_A, 's1')).toBe(false);
    expect(inOtherTeam(state(), 'https://other.example.com', 's2')).toBe(false);

    state().follow(URL_A, 's2');

    expect(state().teamId).toBe('t2');
    expect(inOtherTeam(state(), URL_A, 's1')).toBe(true);
  });

  it('shows the active team in the title bar and switches from its menu', async () => {
    await useActiveTeamStore.getState().load({ url: URL_A, userId: USER });
    render(<TitleTeamSwitcher />);

    const trigger = screen.getByTestId('title-team-switcher');
    expect(trigger.textContent).toContain('Platform');

    await userEvent.click(trigger);
    const items = await screen.findAllByTestId('title-team-switcher-item');
    expect(items.map((item) => item.textContent)).toEqual(['Platform', 'CaaS']);
    await userEvent.click(items[1]!);

    expect(useActiveTeamStore.getState().teamId).toBe('t2');
    expect(screen.getByTestId('title-team-switcher').textContent).toContain('CaaS');
    // The desktop only switches: Team settings is the browser client's.
    expect(useUiStore.getState().preferences.open).toBe(false);
  });

  it('switching team moves off another team’s workspace: to the new team’s latest, else to the list', async () => {
    await useActiveTeamStore.getState().load({ url: URL_A, userId: USER });
    const open = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    const wtest1 = serverRow('w1', 'wtest1', 's1');
    useWorkspaceStore.setState({
      workspace: { ...wtest1, projects: [], environments: [] } as never,
      workspaces: [wtest1, serverRow('w2', 'billing', 's2')],
      open,
      close,
    });

    await switchTeam('t2');
    expect(open).toHaveBeenCalledWith('w2');
    expect(close).not.toHaveBeenCalled();

    useWorkspaceStore.setState({ workspaces: [wtest1] });
    await switchTeam('t1');
    await switchTeam('t2');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('lists only the active team’s workspaces on the start screen, with local ones always', async () => {
    await useActiveTeamStore.getState().load({ url: URL_A, userId: USER });
    const local: WorkspaceSummaryWire = {
      id: 'l1',
      name: 'Mine',
      dir: '/tmp/l1',
      projectCount: 0,
      internalProjectCount: 0,
      createdAt: '2026-11-01T00:00:00.000Z',
    };
    useWorkspaceStore.setState({
      workspace: null,
      workspaces: [serverRow('w1', 'wtest1', 's1'), serverRow('w2', 'billing', 's2'), local],
      list: vi.fn().mockResolvedValue(undefined),
    });
    render(<WorkspacePicker />);

    const ids = (await screen.findAllByTestId('workspace-picker-row')).map((row) =>
      row.getAttribute('data-workspace-id'),
    );
    expect(ids).toEqual(['w1', 'l1']);
  });
});

describe('the start screen in a browser tab (#898)', () => {
  beforeEach(() => {
    const api = installWirebenchApi({
      team: {
        list: vi.fn().mockResolvedValue({ ok: true, value: { teams: TEAMS, serverAdmin: false } }),
        listWorkspaces: vi.fn().mockResolvedValue({ ok: true, value: { workspaces: SPACES } }),
      },
    });
    Object.defineProperty(api, 'env', {
      configurable: true,
      value: { e2e: false, osTheme: 'dark', host: 'browser', capabilities: ['send:public'] },
    });
    useActiveTeamStore.setState({ url: undefined, userId: undefined, teams: [], workspaces: [], teamId: undefined });
  });
  afterEach(() => {
    cleanup();
    useWorkspaceStore.setState({ workspace: null, workspaces: [] });
  });

  it('picking a team in the title bar switches to it and opens its Overview', async () => {
    await useActiveTeamStore.getState().load({ url: URL_A, userId: USER });
    render(<TitleTeamSwitcher />);
    await userEvent.click(screen.getByTestId('title-team-switcher'));
    const items = await screen.findAllByTestId('title-team-switcher-item');
    await userEvent.click(items[1]!);
    await vi.waitFor(() => expect(useUiStore.getState().preferences.open).toBe(true));
    expect(useActiveTeamStore.getState().teamId).toBe('t2');
    expect(useUiStore.getState().preferences).toMatchObject({
      area: 'team',
      team: { teamId: 't2', page: 'overview' },
    });
    useUiStore.getState().setPreferencesOpen(false);
  });

  it('says how many of the active team’s workspaces can be opened, and where, when none is open here', async () => {
    await useActiveTeamStore.getState().load({ url: URL_A, userId: USER });
    useActiveTeamStore.getState().setTeam('t2');
    useWorkspaceStore.setState({
      workspace: null,
      workspaces: [serverRow('w1', 'wtest1', 's1')],
      list: vi.fn().mockResolvedValue(undefined),
    });
    render(<WorkspacePicker />);

    expect((await screen.findByTestId('workspace-picker-empty')).textContent).toBe(
      'CaaS has 1 workspace you can open. Open it with Open a team workspace… above.',
    );
  });

  it('says so when the active team has none', async () => {
    useActiveTeamStore.setState({ url: URL_A, userId: USER, teams: TEAMS, workspaces: [], teamId: 't2' });
    useWorkspaceStore.setState({ workspace: null, workspaces: [], list: vi.fn().mockResolvedValue(undefined) });
    render(<WorkspacePicker />);

    expect((await screen.findByTestId('workspace-picker-empty')).textContent).toBe('CaaS has no workspaces yet.');
  });
});
