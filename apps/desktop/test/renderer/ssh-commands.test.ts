import { beforeEach, describe, expect, it, vi } from 'vitest';

const connect = vi.fn();
vi.mock('../../src/renderer/state/ipc-client.js', () => ({ ipc: () => ({ ssh: { connect } }) }));
import { registerSshCommands } from '../../src/renderer/commands/register-ssh-commands.js';
import { useHostsStore } from '../../src/renderer/features/ssh/hosts-store.js';
import { resetCommands, runCommand } from '../../src/renderer/lib/commands.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { useUiStore } from '../../src/renderer/state/ui.js';

describe('ssh commands', () => {
  beforeEach(() => {
    resetCommands();
    registerSshCommands();
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
  it('ssh.connect with a host id opens its terminal tab', async () => {
    useEditorsStore.getState().reset();
    useHostsStore.setState({ file: { version: 1, groups: [], hosts: [] }, resolved: [] });
    await runCommand('ssh.connect', {} as never, 'a');
    expect(useEditorsStore.getState().tabs).toEqual([{ id: 'ssh:a', kind: 'ssh-terminal', title: 'a', hostId: 'a' }]);
    expect(connect).not.toHaveBeenCalled();
  });
});
