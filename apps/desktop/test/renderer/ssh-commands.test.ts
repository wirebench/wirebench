import { beforeEach, describe, expect, it, vi } from 'vitest';

const connect = vi.fn();
vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));
const listSnippets = vi.fn();
vi.mock('../../src/renderer/state/ipc-client.js', () => ({ ipc: () => ({ ssh: { connect, listSnippets } }) }));
import { registerShellCommands } from '../../src/renderer/commands/register-shell-commands.js';
import { registerSshCommands } from '../../src/renderer/commands/register-ssh-commands.js';
import { openTerminalFor } from '../../src/renderer/features/ssh/connect.js';
import { useHostsStore } from '../../src/renderer/features/ssh/hosts-store.js';
import { useRunDialogStore } from '../../src/renderer/features/ssh/snippets/run.js';
import { useSnippetsStore } from '../../src/renderer/features/ssh/snippets/snippets-store.js';
import type { SnippetListItemWire } from '../../src/shared/snippets-wire.js';
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
  it('ssh.importKnownHosts shows the Known hosts view and opens its import dialog', async () => {
    useHostsStore.setState({ knownHostsImportOpen: false, homeView: 'hosts' });
    await runCommand('ssh.importKnownHosts', {} as never);
    expect(useUiStore.getState().sidebar.view).toBe('ssh');
    expect(useHostsStore.getState().homeView).toBe('known-hosts');
    expect(useHostsStore.getState().knownHostsImportOpen).toBe(true);
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

describe('snippet commands', () => {
  const TAIL: SnippetListItemWire = {
    id: 'tail',
    name: 'Tail',
    tags: [],
    firstLine: 'tail -f x',
    literalStart: 'tail -f x',
    variables: [],
    secrets: [],
    enter: true,
    confirm: false,
    lineCount: 1,
    revision: 'r',
  };
  const openPalette = vi.fn();
  beforeEach(() => {
    openPalette.mockReset();
    resetCommands();
    registerSshCommands(openPalette);
    useEditorsStore.getState().reset();
    useUiStore.setState({ enabledAreas: ['explorer', 'ssh'] } as never);
    useUiStore.getState().setSidebarView('explorer');
    useHostsStore.setState({ homeView: 'hosts' });
    useSnippetsStore.getState().reset();
    useSnippetsStore.setState({ snippets: [TAIL], loaded: true });
    useRunDialogStore.setState({ request: null });
  });

  it('view.showSnippets shows the Snippets view in the SSH area', async () => {
    await runCommand('view.showSnippets', {} as never);
    expect(useUiStore.getState().sidebar.view).toBe('ssh');
    expect(useHostsStore.getState().homeView).toBe('snippets');
    expect(useEditorsStore.getState().displayedSet).toBe('ssh');
  });

  it('ssh.newSnippet opens the editor on a new snippet', async () => {
    await runCommand('ssh.newSnippet', {} as never);
    expect(useHostsStore.getState().homeView).toBe('snippets');
    expect(useSnippetsStore.getState().editor).toEqual({ mode: 'new' });
  });

  it('ssh.editSnippet with an id opens the editor on it; without one it shows the view', async () => {
    await runCommand('ssh.editSnippet', {} as never, 'tail');
    expect(useSnippetsStore.getState().editor).toEqual({ mode: 'edit', id: 'tail' });
    useSnippetsStore.getState().closeEditor();
    useHostsStore.setState({ homeView: 'hosts' });
    await runCommand('ssh.editSnippet', {} as never);
    expect(useHostsStore.getState().homeView).toBe('snippets');
    expect(useSnippetsStore.getState().editor).toBeNull();
  });

  it('ssh.runSnippet with an id runs it (here: no terminal in front, so the dialog)', async () => {
    await runCommand('ssh.runSnippet', {} as never, 'tail');
    expect(useRunDialogStore.getState().request).toEqual({ snippetId: 'tail', mode: 'dialog' });
  });

  it('ssh.runSnippet reads the list first when it is not loaded', async () => {
    useSnippetsStore.getState().reset();
    listSnippets.mockResolvedValueOnce({
      ok: true,
      value: { file: { version: 1, packages: [], snippets: [] }, snippets: [TAIL], problems: [] },
    });
    await runCommand('ssh.runSnippet', {} as never, 'tail');
    expect(useRunDialogStore.getState().request).toEqual({ snippetId: 'tail', mode: 'dialog' });
  });

  it('ssh.runSnippet with an unknown id does nothing', async () => {
    await runCommand('ssh.runSnippet', {} as never, 'gone');
    expect(useRunDialogStore.getState().request).toBeNull();
    expect(openPalette).not.toHaveBeenCalled();
  });

  it('ssh.runSnippet with no id and ssh.runSnippetPalette ask which snippet', async () => {
    await runCommand('ssh.runSnippet', {} as never);
    await runCommand('ssh.runSnippetPalette', {} as never);
    expect(openPalette.mock.calls).toEqual([['snippets'], ['snippets']]);
  });

  it('ssh.snippetPicker is live only while a terminal tab is in front', () => {
    expect(getCommand('ssh.snippetPicker')?.when?.({} as never)).toBe(false);
    useHostsStore.setState({ file: { version: 1, groups: [], hosts: [] }, resolved: [] });
    openTerminalFor('a');
    expect(getCommand('ssh.snippetPicker')?.when?.({} as never)).toBe(true);
  });
});
