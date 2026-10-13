import { beforeEach, describe, expect, it, vi } from 'vitest';

const connect = vi.fn();
vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));
vi.mock('../../src/renderer/state/ipc-client.js', () => ({ ipc: () => ({ ssh: { connect } }) }));
import { registerShellCommands } from '../../src/renderer/commands/register-shell-commands.js';
import { registerSshCommands } from '../../src/renderer/commands/register-ssh-commands.js';
import { openTerminalFor } from '../../src/renderer/features/ssh/connect.js';
import { useHostsStore } from '../../src/renderer/features/ssh/hosts-store.js';
import { getCommand, resetCommands, runCommand } from '../../src/renderer/lib/commands.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { useUiStore } from '../../src/renderer/state/ui.js';

describe('ssh commands', () => {
  beforeEach(() => {
    resetCommands();
    registerSshCommands(vi.fn());
    useHostsStore.setState({ dialog: null });
    useUiStore.setState({ enabledAreas: ['explorer', 'ssh'] } as never);
    useUiStore.getState().setSidebarView('explorer');
  });
  it('ssh.newHost shows the Hosts view and opens the dialog', async () => {
    await runCommand('ssh.newHost', {} as never);
    expect(useUiStore.getState().sidebar.view).toBe('ssh');
    expect(useUiStore.getState().sidebar.visible).toBe(true);
    expect(useHostsStore.getState().dialog).toEqual({ mode: 'new-host' });
  });
  it('ssh.editHost with an id opens the edit dialog and does not collapse an already-visible Hosts view', async () => {
    await runCommand('ssh.newGroup', {} as never);
    await runCommand('ssh.editHost', {} as never, 'a');
    expect(useUiStore.getState().sidebar.visible).toBe(true);
    expect(useHostsStore.getState().dialog).toEqual({ mode: 'edit-host', id: 'a' });
  });
  it('ssh.importConfig shows the Hosts view and opens the import dialog', async () => {
    useHostsStore.setState({ importOpen: false });
    await runCommand('ssh.importConfig', {} as never);
    expect(useUiStore.getState().sidebar.view).toBe('ssh');
    expect(useHostsStore.getState().importOpen).toBe(true);
  });
  it('ssh.connect with a host id opens its terminal tab', async () => {
    useEditorsStore.getState().reset();
    useHostsStore.setState({ file: { version: 1, groups: [], hosts: [] }, resolved: [] });
    await runCommand('ssh.connect', {} as never, 'a');
    expect(useEditorsStore.getState().tabs).toMatchObject([
      { kind: 'ssh-terminal', title: 'a', panes: { kind: 'pane', hostId: 'a' } },
    ]);
    expect(connect).not.toHaveBeenCalled();
  });
});

describe('ssh.connectPalette', () => {
  it('opens the palette in hosts mode', async () => {
    const openPalette = vi.fn();
    resetCommands();
    registerSshCommands(openPalette);
    await runCommand('ssh.connectPalette', {} as never);
    expect(openPalette).toHaveBeenCalledWith('hosts');
  });

  it('ssh.connect with no host id asks which host, like ssh.connectPalette', async () => {
    const openPalette = vi.fn();
    resetCommands();
    registerSshCommands(openPalette);
    await runCommand('ssh.connect', {} as never);
    expect(openPalette).toHaveBeenCalledWith('hosts');
  });

  it('is registered through the area only, so it disappears when ssh is off', () => {
    useUiStore.setState({ enabledAreas: ['explorer', 'ssh'] } as never);
    registerShellCommands(vi.fn());
    expect(getCommand('ssh.connectPalette')).toBeDefined();
    expect(getCommand('ssh.openFiles')).toBeDefined();
    useUiStore.setState({ enabledAreas: ['explorer'] } as never);
    registerShellCommands(vi.fn());
    expect(getCommand('ssh.connectPalette')).toBeUndefined();
    expect(getCommand('ssh.openFiles')).toBeUndefined();
  });

  it('ssh.openFiles with no host id asks which host, in the Files picker', async () => {
    const openPalette = vi.fn();
    resetCommands();
    registerSshCommands(openPalette);
    await runCommand('ssh.openFiles', {} as never);
    expect(openPalette).toHaveBeenCalledWith('files-hosts');
  });

  it('ssh.openFiles with a host id opens its Files tab', async () => {
    resetCommands();
    registerSshCommands(vi.fn());
    useEditorsStore.getState().reset();
    useHostsStore.setState({ file: { version: 1, groups: [], hosts: [] }, resolved: [] });
    await runCommand('ssh.openFiles', {} as never, 'a');
    expect(useEditorsStore.getState().tabs).toEqual([
      { id: 'ssh-files:a', kind: 'ssh-files', title: 'a · Files', hostId: 'a' },
    ]);
  });

  it('ssh.openInNewTab with no host id asks which host, in the new-tab picker', async () => {
    const openPalette = vi.fn();
    resetCommands();
    registerSshCommands(openPalette);
    await runCommand('ssh.openInNewTab', {} as never);
    expect(openPalette).toHaveBeenCalledWith('new-tab-hosts');
  });

  it('the pane commands are live only while a terminal tab is in front', () => {
    resetCommands();
    registerSshCommands(vi.fn());
    useEditorsStore.getState().reset();
    expect(getCommand('ssh.splitRight')?.when?.({} as never)).toBe(false);
    useHostsStore.setState({ file: { version: 1, groups: [], hosts: [] }, resolved: [] });
    openTerminalFor('a');
    for (const id of ['ssh.splitRight', 'ssh.splitDown', 'ssh.focusPaneLeft', 'ssh.closePane'] as const) {
      expect(getCommand(id)?.when?.({} as never)).toBe(true);
    }
  });
});
