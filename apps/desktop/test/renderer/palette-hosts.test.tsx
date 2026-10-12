import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const connect = vi.fn();
vi.mock('../../src/renderer/state/ipc-client.js', () => ({ ipc: () => ({ ssh: { connect } }) }));
import { registerSshCommands } from '../../src/renderer/commands/register-ssh-commands.js';
import type { PaletteMode } from '../../src/renderer/shell/command-palette.js';
import { CommandPalette } from '../../src/renderer/shell/command-palette.js';
import type { CommandContext } from '../../src/renderer/lib/commands.js';
import { resetCommands } from '../../src/renderer/lib/commands.js';
import { useHostsStore } from '../../src/renderer/features/ssh/hosts-store.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import { writeRecent } from '../../src/renderer/features/ssh/recent-connections.js';
import { useWorkspaceStore } from '../../src/renderer/state/workspace.js';
import type { WorkspaceWire } from '../../src/shared/wire-base.js';
import { DEFAULT_UI_STATE } from '../../src/renderer/state/ui-state.js';

const context: CommandContext = {
  platform: 'mac',
  ui: {
    sidebar: DEFAULT_UI_STATE.sidebar,
    console: DEFAULT_UI_STATE.console,
    slideOver: DEFAULT_UI_STATE.slideOver,
    theme: DEFAULT_UI_STATE.theme,
    editorLineNumbers: DEFAULT_UI_STATE.editorLineNumbers,
    editorLayout: DEFAULT_UI_STATE.editorLayout,
  },
  selection: undefined,
};

const HOST = {
  id: 'a',
  name: 'api-1',
  address: '10.0.1.5',
  tags: ['prod'],
  path: ['prod', 'eu'],
  protected: { value: false, from: 'default' as const },
  ssh: {} as never,
  forwards: [],
};

/** What the app shell does with the palette: holds open and mode, and hands commands a way to reopen it. */
function Shell() {
  const [open, setOpen] = useState(true);
  const [mode, setMode] = useState<PaletteMode>('commands');
  resetCommands();
  registerSshCommands((next = 'commands') => {
    setMode(next);
    setOpen(true);
  });
  return <CommandPalette open={open} onOpenChange={setOpen} context={context} mode={mode} />;
}

describe('hosts in the palette', () => {
  beforeEach(() => {
    resetCommands();
    useEditorsStore.getState().reset();
    useHostsStore.setState({ resolved: [HOST], panes: {}, file: { version: 1, groups: [], hosts: [] } });
    useUiStore.setState({ enabledAreas: ['explorer', 'ssh'] } as never);
  });
  afterEach(() => {
    cleanup();
    resetCommands();
  });

  it('quick-open lists the resolved hosts under a Hosts heading', () => {
    render(<CommandPalette open onOpenChange={() => undefined} context={context} mode="quick-open" />);
    expect(screen.getByText('Hosts')).toBeDefined();
    expect(screen.getByText('api-1')).toBeDefined();
    // Once under Hosts and once under Files.
    expect(screen.getAllByText('10.0.1.5 · prod/eu')).toHaveLength(2);
  });

  it('recent hosts come first, under their own heading; a deleted one is not listed', () => {
    localStorage.clear();
    useWorkspaceStore.setState({ workspace: { id: 'w1' } as WorkspaceWire });
    useHostsStore.setState({ resolved: [HOST, { ...HOST, id: 'b', name: 'db-1', path: [] }] });
    writeRecent('w1', [
      { hostId: 'b', at: 2, outcome: 'connected' },
      { hostId: 'deleted', at: 1, outcome: 'connected' },
    ]);
    render(<CommandPalette open onOpenChange={() => undefined} context={context} mode="hosts" />);
    expect(screen.getByText('Recent')).toBeDefined();
    const rows = screen.getAllByTestId('quick-open-host').map((row) => row.textContent);
    expect(rows).toEqual(['db-110.0.1.5', 'api-110.0.1.5 · prod/eu']);
    useWorkspaceStore.setState({ workspace: null });
  });

  it('quick-open omits the hosts when the ssh area is switched off', () => {
    useUiStore.setState({ enabledAreas: ['explorer'] } as never);
    render(<CommandPalette open onOpenChange={() => undefined} context={context} mode="quick-open" />);
    expect(screen.queryByText('api-1')).toBeNull();
    expect(screen.queryByText('Hosts')).toBeNull();
  });

  it('the hosts mode lists only hosts and Enter opens the terminal tab', () => {
    const close = vi.fn();
    render(<CommandPalette open onOpenChange={close} context={context} mode="hosts" />);
    expect(screen.getByPlaceholderText('Connect to host')).toBeDefined();
    fireEvent.click(screen.getByText('api-1'));
    expect(close).toHaveBeenCalledWith(false);
    expect(useEditorsStore.getState().tabs).toMatchObject([
      { kind: 'ssh-terminal', title: 'api-1', panes: { kind: 'pane', hostId: 'a' } },
    ]);
  });

  it('quick-open also lists each host under Files, which opens its Files tab', () => {
    const close = vi.fn();
    render(<CommandPalette open onOpenChange={close} context={context} mode="quick-open" />);
    expect(screen.getByText('Files')).toBeDefined();
    fireEvent.click(screen.getByText('api-1 · Files'));
    expect(close).toHaveBeenCalledWith(false);
    expect(useEditorsStore.getState().tabs).toEqual([
      { id: 'ssh-files:a', kind: 'ssh-files', title: 'api-1 · Files', hostId: 'a' },
    ]);
  });

  it('the files-hosts mode lists the hosts and opens the Files tab of the one picked', () => {
    render(<CommandPalette open onOpenChange={() => undefined} context={context} mode="files-hosts" />);
    expect(screen.getByPlaceholderText('Open files on host')).toBeDefined();
    fireEvent.click(screen.getByText('api-1 · Files'));
    expect(useEditorsStore.getState().tabs.map((t) => t.kind)).toEqual(['ssh-files']);
  });

  it('⌘K lists Open Files on Host…, which switches to the Files picker', () => {
    render(<Shell />);
    fireEvent.click(screen.getByText('Open Files on Host…'));
    expect(screen.getByPlaceholderText('Open files on host')).toBeDefined();
    expect(screen.getByText('api-1 · Files')).toBeDefined();
  });

  it('the hosts mode shows no host when the ssh area is switched off', () => {
    useUiStore.setState({ enabledAreas: ['explorer'] } as never);
    render(<CommandPalette open onOpenChange={() => undefined} context={context} mode="hosts" />);
    expect(screen.queryByText('api-1')).toBeNull();
  });

  it('a host that is not in resolved is not listed', () => {
    useHostsStore.setState({
      resolved: [],
      file: { version: 1, groups: [], hosts: [{ id: 'z', name: 'broken', address: 'z.example', tags: [], ssh: {} }] },
    });
    render(<CommandPalette open onOpenChange={() => undefined} context={context} mode="quick-open" />);
    expect(screen.queryByText('broken')).toBeNull();
  });

  it('switching from the command list to the host picker clears the typed search', () => {
    render(<Shell />);
    const input = screen.getByTestId<HTMLInputElement>('command-palette-input');
    fireEvent.change(input, { target: { value: 'connect' } });
    expect(input.value).toBe('connect');
    fireEvent.click(screen.getByText('Connect to Host…'));

    const picker = screen.getByTestId<HTMLInputElement>('quick-open-input');
    expect(picker.value).toBe('');
    expect(screen.getByText('api-1')).toBeDefined();
    expect(screen.queryByText('No matching host.')).toBeNull();
  });
});
