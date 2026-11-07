import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  manageTeam,
  readTeamDeepLink,
  takeTeamDeepLink,
  teamPageUrl,
  teamSettingsSearch,
  withoutTeamSettings,
} from '../../src/renderer/features/team/team-link.js';
import { useAccountStore } from '../../src/renderer/state/account.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import { useWorkspaceStore } from '../../src/renderer/state/workspace.js';
import type { AccountWire, WorkspaceWire } from '@wirebench/wire/wire-base';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

const account = (url: string, signedOut = false): AccountWire => ({
  url,
  userId: 'u',
  email: `a@${new URL(url).host}`,
  displayName: 'A',
  deviceName: 'd',
  signedOut,
  addedAt: '2026-09-24T12:00:00.000Z',
});
const meta = (capabilities: string[]) => ({
  ok: true,
  value: {
    url: 'https://wb.test',
    meta: {
      name: 'wirebench-server',
      version: '7.0.0',
      apiVersion: 1,
      publicUrl: 'https://wb.test',
      auth: { local: true, oidc: false },
      capabilities,
    },
  },
});
const sharedWorkspace = (url: string, workspaceId: string) =>
  ({
    share: { kind: 'server', managed: true, server: { url, workspaceId, recording: false } },
  }) as unknown as WorkspaceWire;

/** Sets `env.host` on the installed API: the browser bootstrap's `'browser'`, the preload's `'electron'`. */
function setHost(host: 'browser' | 'electron'): void {
  const api = window.wirebench as unknown as { env?: Record<string, unknown> };
  Object.defineProperty(window, 'wirebench', {
    configurable: true,
    value: { ...api, env: { ...(api.env ?? {}), host } },
  });
}

describe('team links (team management in the browser §2)', () => {
  let open: MockInstance<Window['open']>;
  beforeEach(() => {
    useUiStore.setState({ teamDialog: { open: false, url: undefined } });
    useAccountStore.setState({ servers: [account('https://wb.test')], loaded: true });
    useWorkspaceStore.setState({ workspace: null });
    open = vi.spyOn(window, 'open').mockReturnValue(null);
  });
  afterEach(() => {
    open.mockRestore();
    window.history.replaceState(null, '', '/');
  });

  it('builds the team page URL on the server root, with the team or workspace', () => {
    expect(teamPageUrl('https://wb.test/')).toBe('https://wb.test/?panel=team');
    expect(teamPageUrl('https://acme.app.test', { workspaceId: 'W1' })).toBe(
      'https://acme.app.test/?panel=team&workspace=W1',
    );
    expect(teamPageUrl('https://wb.test', { teamId: 'T1' })).toBe('https://wb.test/?panel=team&team=T1');
  });

  it('reads the deep link, ignoring other pages and ids that are not ids', () => {
    expect(readTeamDeepLink('')).toBeUndefined();
    expect(readTeamDeepLink('?panel=other&team=T1')).toBeUndefined();
    expect(readTeamDeepLink('?panel=team')).toEqual({});
    expect(readTeamDeepLink('?panel=team&team=01JABC&workspace=W_1-2')).toEqual({
      teamId: '01JABC',
      workspaceId: 'W_1-2',
    });
    expect(readTeamDeepLink('?panel=team&team=%3Cscript%3E&workspace=')).toEqual({});
    expect(readTeamDeepLink(`?panel=team&team=${'a'.repeat(65)}`)).toEqual({});
  });

  it('reads team, workspace and page', () => {
    expect(readTeamDeepLink('?panel=team&team=T1&workspace=W1&page=sign-in')).toEqual({
      teamId: 'T1',
      workspaceId: 'W1',
      page: 'sign-in',
    });
    expect(readTeamDeepLink('?page=people&panel=team')).toEqual({ page: 'people' });
  });

  it('drops a malformed id and page', () => {
    expect(readTeamDeepLink('?panel=team&team=a%20b&page=People')).toEqual({});
    expect(readTeamDeepLink(`?panel=team&page=${'a'.repeat(33)}`)).toEqual({});
    expect(readTeamDeepLink('?panel=team&team=T1&page=..%2Fx')).toEqual({ teamId: 'T1' });
  });

  it('teamSettingsSearch keeps other parameters and writes panel, team, page in order', () => {
    expect(teamSettingsSearch('', { teamId: 'T1', page: 'people' })).toBe('?panel=team&team=T1&page=people');
    expect(
      teamSettingsSearch('?page=roles&keep=1&workspace=W1&panel=team&team=T0', { teamId: 'T2', page: 'license' }),
    ).toBe('?keep=1&panel=team&team=T2&page=license');
    expect(teamSettingsSearch('?keep=1', { teamId: undefined, page: 'license' })).toBe(
      '?keep=1&panel=team&page=license',
    );
  });

  it('withoutTeamSettings strips only its own parameters', () => {
    expect(withoutTeamSettings('?panel=team&team=T1&workspace=W1&page=people')).toBe('');
    expect(withoutTeamSettings('?a=1&panel=team&team=T1&b=2&page=people')).toBe('?a=1&b=2');
    expect(withoutTeamSettings('?a=1')).toBe('?a=1');
  });

  it('teamPageUrl writes page when given', () => {
    expect(teamPageUrl('https://wb.test', { teamId: 'T1', page: 'people' })).toBe(
      'https://wb.test/?panel=team&team=T1&page=people',
    );
    expect(teamPageUrl('https://wb.test', { page: 'close-account' })).toBe(
      'https://wb.test/?panel=team&page=close-account',
    );
  });

  it('takes the deep link once: opens the dialog on it and leaves the rest of the address alone', () => {
    window.history.replaceState(null, '', '/workspaces/x?panel=team&workspace=W1&keep=1#h');
    expect(takeTeamDeepLink()).toBe(true);
    expect(useUiStore.getState().teamDialog).toEqual({ open: true, url: undefined, target: { workspaceId: 'W1' } });
    expect(`${window.location.pathname}${window.location.search}${window.location.hash}`).toBe(
      '/workspaces/x?keep=1#h',
    );
    useUiStore.setState({ teamDialog: { open: false, url: undefined } });
    expect(takeTeamDeepLink()).toBe(false);
    expect(useUiStore.getState().teamDialog.open).toBe(false);
  });

  it('in a browser tab, opens the dialog in place and asks nothing', async () => {
    const api = installWirebenchApi();
    setHost('browser');
    await manageTeam('https://wb.test');
    expect(useUiStore.getState().teamDialog).toEqual({ open: true, url: 'https://wb.test' });
    expect(api.account.probe).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it('in the desktop, opens the team page in the browser when the server serves the browser client', async () => {
    const probe = vi.fn().mockResolvedValue(meta(['identity', 'browser-client']));
    installWirebenchApi({ account: { probe } });
    setHost('electron');
    await manageTeam();
    expect(probe).toHaveBeenCalledWith({ url: 'https://wb.test' });
    expect(open).toHaveBeenCalledWith('https://wb.test/?panel=team', '_blank', 'noopener');
    expect(useUiStore.getState().teamDialog.open).toBe(false);
  });

  it('carries the open workspace when it is shared to that server, and picks that server first', async () => {
    const probe = vi.fn().mockResolvedValue(meta(['browser-client']));
    installWirebenchApi({ account: { probe } });
    useAccountStore.setState({ servers: [account('https://one.test'), account('https://two.test')] });
    useWorkspaceStore.setState({ workspace: sharedWorkspace('https://two.test', 'W2') });
    await manageTeam();
    expect(probe).toHaveBeenCalledWith({ url: 'https://two.test' });
    expect(open).toHaveBeenCalledWith('https://two.test/?panel=team&workspace=W2', '_blank', 'noopener');
    // Asked about the other server, the workspace is not that server's: no workspace in the link.
    await manageTeam('https://one.test');
    expect(open).toHaveBeenLastCalledWith('https://one.test/?panel=team', '_blank', 'noopener');
  });

  it('keeps the in-window dialog for a server without the browser client, or one it cannot ask', async () => {
    const probe = vi
      .fn()
      .mockResolvedValueOnce(meta(['identity']))
      .mockResolvedValueOnce({
        ok: false,
        error: { code: 'account-unreachable', message: 'offline' },
      });
    installWirebenchApi({ account: { probe } });
    useWorkspaceStore.setState({ workspace: sharedWorkspace('https://wb.test', 'W1') });
    await manageTeam();
    expect(useUiStore.getState().teamDialog).toEqual({
      open: true,
      url: 'https://wb.test',
      target: { workspaceId: 'W1' },
    });
    useUiStore.setState({ teamDialog: { open: false, url: undefined } });
    await manageTeam('https://wb.test');
    expect(useUiStore.getState().teamDialog.open).toBe(true);
    expect(open).not.toHaveBeenCalled();
  });
});
