import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const runSnippet = vi.fn();
const listSnippets = vi.fn();
vi.mock('../../src/renderer/state/ipc-client.js', () => ({
  ipc: () => ({ ssh: { runSnippet, listSnippets } }),
}));
import { registerSshCommands } from '../../src/renderer/commands/register-ssh-commands.js';
import type { PaletteMode } from '../../src/renderer/shell/command-palette.js';
import { CommandPalette } from '../../src/renderer/shell/command-palette.js';
import type { CommandContext } from '../../src/renderer/lib/commands.js';
import { resetCommands } from '../../src/renderer/lib/commands.js';
import { useHostsStore } from '../../src/renderer/features/ssh/hosts-store.js';
import { usePanesStore } from '../../src/renderer/features/ssh/panes/pane-actions.js';
import { useRunDialogStore } from '../../src/renderer/features/ssh/snippets/run.js';
import { useSnippetsStore } from '../../src/renderer/features/ssh/snippets/snippets-store.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import { useWorkspaceStore } from '../../src/renderer/state/workspace.js';
import { DEFAULT_UI_STATE } from '../../src/renderer/state/ui-state.js';
import type { SnippetListItemWire } from '../../src/shared/snippets-wire.js';

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

const item = (over: Partial<SnippetListItemWire> = {}): SnippetListItemWire => ({
  id: 'tail',
  name: 'Tail logs',
  tags: ['logs'],
  firstLine: 'tail -f /var/log/syslog',
  literalStart: 'tail -f /var/log/syslog',
  variables: [],
  secrets: [],
  enter: true,
  confirm: false,
  lineCount: 1,
  revision: 'rev-1',
  ...over,
});

const TAIL = item();
const DISK = item({
  id: 'disk',
  name: 'Disk usage',
  tags: ['ops'],
  packageId: 'p',
  packageName: 'Maintenance',
  firstLine: 'df -h',
  literalStart: 'df -h',
});

const TERMINAL_TAB = {
  id: 'ssh-terminal:t1',
  kind: 'ssh-terminal',
  title: 'web',
  panes: { kind: 'pane', paneId: 'p1', hostId: 'web' },
};

/** A terminal tab in front, its one pane connected. */
function terminalInFront(): void {
  useEditorsStore.setState({ tabs: [TERMINAL_TAB] as never, activeId: TERMINAL_TAB.id });
  useHostsStore.setState({ panes: { p1: { hostId: 'web', sessionId: 's-web', state: 'open' } } });
}

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

/** The snippet rows shown, by name. */
const rows = (): string[] => screen.queryAllByTestId('palette-snippet').map((row) => row.dataset['name'] ?? '');

describe('snippets in the palette', () => {
  beforeEach(() => {
    localStorage.clear();
    resetCommands();
    runSnippet.mockReset().mockResolvedValue({ ok: true, value: {} });
    listSnippets.mockReset().mockResolvedValue({
      ok: true,
      value: { file: { version: 1, packages: [], snippets: [] }, snippets: [TAIL, DISK], problems: [] },
    });
    useWorkspaceStore.setState({ workspace: { id: 'w1' } as never });
    useEditorsStore.getState().reset();
    useHostsStore.setState({ resolved: [], panes: {}, file: { version: 1, groups: [], hosts: [] } });
    useSnippetsStore.setState({ snippets: [TAIL, DISK], loaded: true });
    useRunDialogStore.setState({ request: null });
    useUiStore.setState({ enabledAreas: ['explorer', 'ssh'] } as never);
  });
  afterEach(() => {
    cleanup();
    resetCommands();
    useEditorsStore.setState({ tabs: [], activeId: undefined });
    usePanesStore.setState({ focused: {} });
    useHostsStore.setState({ panes: {} });
    useSnippetsStore.getState().reset();
  });

  it('⌘K lists Run Snippet…, which switches to the snippets mode with an empty search', () => {
    render(<Shell />);
    const input = screen.getByTestId<HTMLInputElement>('command-palette-input');
    fireEvent.change(input, { target: { value: 'run snip' } });
    fireEvent.click(screen.getByText('Snippets: Run Snippet…'));
    const picker = screen.getByTestId<HTMLInputElement>('quick-open-input');
    expect(picker.value).toBe('');
    expect(picker.placeholder).toBe('Run snippet');
    expect(rows()).toEqual(['Tail logs', 'Disk usage']);
  });

  it('the snippets mode matches on name, package, tags and first line', () => {
    render(<CommandPalette open onOpenChange={() => undefined} context={context} mode="snippets" />);
    const input = screen.getByTestId('quick-open-input');
    for (const [search, expected] of [
      ['disk', ['Disk usage']],
      ['maintenance', ['Disk usage']],
      ['logs', ['Tail logs']],
      ['syslog', ['Tail logs']],
      ['ops', ['Disk usage']],
    ] as const) {
      fireEvent.change(input, { target: { value: search } });
      expect(rows()).toEqual(expected);
    }
  });

  it('Enter with a terminal tab in front runs into it', async () => {
    terminalInFront();
    const close = vi.fn();
    render(<CommandPalette open onOpenChange={close} context={context} mode="snippets" />);
    fireEvent.click(screen.getByText('Tail logs'));
    expect(close).toHaveBeenCalledWith(false);
    await waitFor(() => {
      expect(runSnippet).toHaveBeenCalled();
    });
    expect(runSnippet.mock.calls[0]?.[0]).toMatchObject({ sessionId: 's-web', snippetId: 'tail', revision: 'rev-1' });
    expect(useRunDialogStore.getState().request).toBeNull();
  });

  it('Enter with a terminal in front opens the dialog when the run must ask', () => {
    const careful = item({ id: 'careful', name: 'Careful', confirm: true });
    useSnippetsStore.setState({ snippets: [careful] });
    terminalInFront();
    render(<CommandPalette open onOpenChange={() => undefined} context={context} mode="snippets" />);
    fireEvent.click(screen.getByText('Careful'));
    expect(runSnippet).not.toHaveBeenCalled();
    expect(useRunDialogStore.getState().request).toMatchObject({
      snippetId: 'careful',
      mode: 'dialog',
      tabId: TERMINAL_TAB.id,
    });
  });

  it('Enter with no terminal in front opens the run dialog', () => {
    render(<CommandPalette open onOpenChange={() => undefined} context={context} mode="snippets" />);
    fireEvent.click(screen.getByText('Disk usage'));
    expect(runSnippet).not.toHaveBeenCalled();
    expect(useRunDialogStore.getState().request).toEqual({ snippetId: 'disk', mode: 'dialog' });
  });

  it('reads the snippets when they are not loaded yet', async () => {
    useSnippetsStore.getState().reset();
    render(<CommandPalette open onOpenChange={() => undefined} context={context} mode="snippets" />);
    await waitFor(() => {
      expect(rows()).toEqual(['Tail logs', 'Disk usage']);
    });
    expect(listSnippets).toHaveBeenCalledTimes(1);
  });

  it('⌘P lists the snippets under a Snippets heading; Enter does as the snippets mode', () => {
    render(<CommandPalette open onOpenChange={() => undefined} context={context} mode="quick-open" />);
    expect(screen.getByText('Snippets')).toBeDefined();
    fireEvent.click(screen.getByText('Disk usage'));
    expect(useRunDialogStore.getState().request).toEqual({ snippetId: 'disk', mode: 'dialog' });
  });

  it('with the ssh area off, neither ⌘P nor the snippets mode lists a snippet', () => {
    useUiStore.setState({ enabledAreas: ['explorer'] } as never);
    const { unmount } = render(
      <CommandPalette open onOpenChange={() => undefined} context={context} mode="quick-open" />,
    );
    expect(screen.queryByText('Snippets')).toBeNull();
    expect(screen.queryByText('Tail logs')).toBeNull();
    unmount();
    render(<CommandPalette open onOpenChange={() => undefined} context={context} mode="snippets" />);
    expect(screen.queryByText('Tail logs')).toBeNull();
    expect(listSnippets).not.toHaveBeenCalled();
  });
});
