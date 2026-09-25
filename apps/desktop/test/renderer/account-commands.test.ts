import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));

import { registerShellCommands } from '../../src/renderer/commands/register-shell-commands.js';
import type { CommandContext } from '../../src/renderer/lib/commands.js';
import { getCommand } from '../../src/renderer/lib/commands.js';
import { useAccountStore } from '../../src/renderer/state/account.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import type { AccountWire } from '../../src/shared/wire-types.js';
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
    console: { visible: false, activeTab: 'http-log', size: 25, lastSize: 25 },
    slideOver: { open: false, width: 420, codeShell: 'posix' },
    theme: 'dark',
    editorLineNumbers: true,
    editorLayout: { orientation: 'side-by-side', mode: 'split' },
  },
  selection: undefined,
};

describe('account.* commands', () => {
  beforeEach(() => {
    installWirebenchApi();
    registerShellCommands(() => undefined);
    useAccountStore.setState({ servers: [], loaded: true });
    useUiStore.setState({
      signInDialog: { open: false, url: undefined },
      teamDialog: { open: false, url: undefined },
      preferences: { open: false, section: undefined },
    });
  });

  it('account.signIn is always available and opens the dialog blank', () => {
    const command = getCommand('account.signIn')!;
    expect(command.when?.(context)).not.toBe(false);
    void command.run(context);
    expect(useUiStore.getState().signInDialog).toEqual({ open: true, url: undefined });
  });

  it('account.signOut is gated on a signed-in server; one server signs out, several open Accounts', async () => {
    const signOut = vi.fn().mockResolvedValue({ ok: true, value: { servers: [] } });
    installWirebenchApi({ account: { signOut } });
    const command = getCommand('account.signOut')!;
    expect(command.when?.(context)).toBe(false);
    useAccountStore.setState({ servers: [account('https://one.test', true)] });
    expect(command.when?.(context)).toBe(false);
    useAccountStore.setState({ servers: [account('https://one.test')] });
    expect(command.when?.(context)).toBe(true);
    void command.run(context);
    await vi.waitFor(() => expect(signOut).toHaveBeenCalledWith({ url: 'https://one.test' }));
    useAccountStore.setState({ servers: [account('https://one.test'), account('https://two.test')] });
    void command.run(context);
    expect(useUiStore.getState().preferences).toEqual({ open: true, section: 'accounts' });
  });

  it('team.manage is gated on a signed-in server and opens the teams dialog', () => {
    const command = getCommand('team.manage')!;
    expect(command.when?.(context)).toBe(false);
    useAccountStore.setState({ servers: [account('https://wb.test')] });
    expect(command.when?.(context)).toBe(true);
    void command.run(context);
    expect(useUiStore.getState().teamDialog).toEqual({ open: true, url: undefined });
  });

  it('workspace.openTeamWorkspace is gated on a signed-in server and opens its dialog', () => {
    useUiStore.setState({ teamWorkspaceDialogOpen: false });
    const command = getCommand('workspace.openTeamWorkspace')!;
    expect(command.label).toBe('Workspace: Open a team workspace…');
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
