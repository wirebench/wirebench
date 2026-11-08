import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));

import { registerShellCommands } from '../../src/renderer/commands/register-shell-commands.js';
import type { CommandContext } from '../../src/renderer/lib/commands.js';
import { getCommand } from '../../src/renderer/lib/commands.js';
import { useAccountStore } from '../../src/renderer/state/account.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import type { AccountWire } from '@wirebench/wire/wire-base';
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

// `account.*` commands never read the context (their gate is the account store), so a minimal
// stub is enough to satisfy `Command.run`/`when`'s signature.
const context: CommandContext = {
  platform: 'mac',
  ui: {
    sidebar: { visible: true, view: 'explorer', size: 20, lastSize: 20 },
    console: { visible: false, activeTab: 'http-log', size: 25, lastSize: 25, openOnFirstSend: false },
    slideOver: { open: false, width: 420, codeShell: 'posix', codeLanguage: 'curl', codeSettings: {} },
    theme: 'dark',
    palette: 'default',
    editorLineNumbers: true,
    editorLayout: { orientation: 'side-by-side', mode: 'split' },
  },
  selection: undefined,
};

describe('account.* commands', () => {
  beforeEach(() => {
    installWirebenchApi();
    registerShellCommands(() => undefined);
    useAccountStore.setState({ servers: [], active: null, loaded: true });
    useUiStore.setState({
      signInDialog: { open: false, url: undefined },
      teamDialog: { open: false, url: undefined },
      preferences: { open: false, area: 'app', section: undefined },
    });
  });

  it('account.signIn is always available and opens the dialog blank', () => {
    const command = getCommand('account.signIn')!;
    expect(command.when?.(context)).not.toBe(false);
    void command.run(context);
    expect(useUiStore.getState().signInDialog).toEqual({ open: true, url: undefined });
  });

  it('account.signOut is gated on a signed-in account and signs the active one out', async () => {
    const signOut = vi.fn().mockResolvedValue({ ok: true, value: { servers: [] } });
    installWirebenchApi({ account: { signOut } });
    const command = getCommand('account.signOut')!;
    expect(command.when?.(context)).toBe(false);
    useAccountStore.setState({ servers: [account('https://one.test', true)] });
    expect(command.when?.(context)).toBe(false);
    useAccountStore.setState({ servers: [account('https://one.test')] });
    expect(command.when?.(context)).toBe(true);
    void command.run(context);
    await vi.waitFor(() => expect(signOut).toHaveBeenCalledWith({ account: { url: 'https://one.test', userId: 'u' } }));
  });

  it('with two accounts signed in, sign out signs out the active one only', async () => {
    const signOut = vi.fn().mockResolvedValue({ ok: true, value: { servers: [] } });
    installWirebenchApi({ account: { signOut } });
    useAccountStore.setState({
      servers: [account('https://one.test'), account('https://two.test')],
      active: { url: 'https://two.test', userId: 'u' },
    });
    void getCommand('account.signOut')!.run(context);
    await vi.waitFor(() => expect(signOut).toHaveBeenCalledWith({ account: { url: 'https://two.test', userId: 'u' } }));
  });

  it('Account settings opens User settings', () => {
    const command = getCommand('account.settings')!;
    expect(command.label).toBe('Account: Account settings');
    expect(command.category).toBe('Account');
    void command.run(context);
    expect(useUiStore.getState().preferences).toEqual({ open: true, area: 'user', section: undefined });
  });

  it('team.manage is gated on a signed-in server and, for a server without the browser client, opens the dialog', async () => {
    const command = getCommand('team.manage')!;
    expect(command.label).toBe('Account: Manage team…');
    expect(command.when?.(context)).toBe(false);
    useAccountStore.setState({ servers: [account('https://wb.test')] });
    expect(command.when?.(context)).toBe(true);
    void command.run(context);
    // The stub's account.probe fails: the dialog opens in the window (team management in the browser, ruling 4).
    await vi.waitFor(() => expect(useUiStore.getState().teamDialog).toEqual({ open: true, url: 'https://wb.test' }));
  });

  it('workspace.openTeamWorkspace is gated on a signed-in server and opens its dialog', () => {
    useUiStore.setState({ teamWorkspaceDialogOpen: false });
    const command = getCommand('workspace.openTeamWorkspace')!;
    expect(command.label).toBe('Open Team Workspace…');
    expect(command.category).toBe('Workspace');
    expect(command.when?.(context)).toBe(false);
    useAccountStore.setState({ servers: [account('https://wb.test', true)] });
    expect(command.when?.(context)).toBe(false);
    useAccountStore.setState({ servers: [account('https://wb.test')] });
    expect(command.when?.(context)).toBe(true);
    void command.run(context);
    expect(useUiStore.getState().teamWorkspaceDialogOpen).toBe(true);
  });
});
