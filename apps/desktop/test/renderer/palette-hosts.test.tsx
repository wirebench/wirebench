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

const HOST = { id: 'a', name: 'api-1', address: '10.0.1.5', tags: ['prod'], path: ['prod', 'eu'], ssh: {} as never };

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
    useHostsStore.setState({ resolved: [HOST], sessions: {}, file: { version: 1, groups: [], hosts: [] } });
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
    expect(screen.getByText('10.0.1.5 · prod/eu')).toBeDefined();
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
    expect(useEditorsStore.getState().tabs).toEqual([
      { id: 'ssh:a', kind: 'ssh-terminal', title: 'api-1', hostId: 'a' },
    ]);
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
