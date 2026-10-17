import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerSshCommands } from '../../src/renderer/commands/register-ssh-commands.js';
import { resetCommands } from '../../src/renderer/lib/commands.js';
import { setKeybindingOverrides } from '../../src/renderer/lib/keybindings.js';
import {
  clipboardChord,
  TerminalContextMenu,
  terminalMenuGroups,
  type TerminalMenuActions,
} from '../../src/renderer/features/ssh/terminal-menu.js';
import { useHostsStore } from '../../src/renderer/features/ssh/hosts-store.js';
import { PaneHeader } from '../../src/renderer/features/ssh/panes/pane-header.js';
import { recordingOf } from '../../src/renderer/features/ssh/recording-mark.js';

type Spy = ReturnType<typeof vi.fn<() => void>>;

function actions(): Record<keyof TerminalMenuActions, Spy> {
  return {
    copy: vi.fn<() => void>(),
    paste: vi.fn<() => void>(),
    selectAll: vi.fn<() => void>(),
    find: vi.fn<() => void>(),
    clear: vi.fn<() => void>(),
    splitRight: vi.fn<() => void>(),
    splitDown: vi.fn<() => void>(),
    runSnippet: vi.fn<() => void>(),
    openFiles: vi.fn<() => void>(),
    reconnect: vi.fn<() => void>(),
    share: vi.fn<() => void>(),
  };
}

const CONNECTED = { hasSelection: true, connected: true };

beforeEach(() => {
  resetCommands();
  registerSshCommands(() => undefined);
});

afterEach(() => {
  cleanup();
  setKeybindingOverrides({});
  resetCommands();
});

describe('terminalMenuGroups', () => {
  it('offers Share session only where sharing is available, and Stop sharing while shared (#429)', () => {
    const last = (state: Parameters<typeof terminalMenuGroups>[1]) =>
      terminalMenuGroups('mac', state, actions())
        .at(-1)!
        .map((item) => [item.label, item.disabled]);
    expect(last(CONNECTED)).not.toContainEqual(['Share session', false]);
    expect(last({ ...CONNECTED, share: 'available' })).toEqual([['Share session', false]]);
    expect(last({ hasSelection: false, connected: false, share: 'available' })).toEqual([['Share session', true]]);
    expect(last({ ...CONNECTED, share: 'sharing' })).toEqual([['Stop sharing', false]]);
  });

  it('lists the items in order, each with its shortcut, on a Mac', () => {
    const groups = terminalMenuGroups('mac', CONNECTED, actions());
    expect(groups.map((group) => group.map((item) => [item.label, item.shortcut]))).toEqual([
      [
        ['Copy', '⌘C'],
        ['Paste', '⌘V'],
        ['Select all', '⌘A'],
      ],
      [
        ['Find…', '⌘F'],
        ['Clear', undefined],
      ],
      [
        ['Split right', '⌘D'],
        ['Split down', '⌘⇧D'],
      ],
      [
        ['Run snippet…', '⌘;'],
        ['Open files', undefined],
        ['Reconnect', undefined],
      ],
    ]);
  });

  it('gives the clipboard chords Shift off a Mac, where Ctrl+C is the shell’s', () => {
    const [clipboard = [], find = []] = terminalMenuGroups('linux', CONNECTED, actions());
    expect(clipboard.map((item) => item.shortcut)).toEqual(['Ctrl+Shift+C', 'Ctrl+Shift+V', 'Ctrl+Shift+A']);
    expect(find[0]?.shortcut).toBe('Ctrl+F');
  });

  it('shows a rebound command’s chord, and none for an unbound one', () => {
    setKeybindingOverrides({ 'ssh.splitRight': 'Mod+Alt+R', 'ssh.snippetPicker': '' });
    const items = terminalMenuGroups('mac', CONNECTED, actions()).flat();
    expect(items.find((item) => item.key === 'splitRight')?.shortcut).toBe('⌘⌥R');
    expect(items.find((item) => item.key === 'runSnippet')?.shortcut).toBeUndefined();
  });

  it('turns Copy off with nothing selected, and Paste and Run snippet off with no session', () => {
    const disabled = (state: { hasSelection: boolean; connected: boolean }) =>
      terminalMenuGroups('mac', state, actions())
        .flat()
        .filter((item) => item.disabled)
        .map((item) => item.key);
    expect(disabled(CONNECTED)).toEqual([]);
    expect(disabled({ hasSelection: false, connected: true })).toEqual(['copy']);
    expect(disabled({ hasSelection: true, connected: false })).toEqual(['paste', 'runSnippet']);
  });

  it('runs the action each item names', () => {
    const run = actions();
    for (const item of terminalMenuGroups('mac', CONNECTED, run).flat()) {
      item.run();
      expect(run[item.key]).toHaveBeenCalledTimes(1);
    }
  });
});

describe('clipboardChord', () => {
  const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init);

  it('is Ctrl+Shift+C / V / A off a Mac', () => {
    expect(clipboardChord(key({ key: 'C', ctrlKey: true, shiftKey: true }), 'linux')).toBe('copy');
    expect(clipboardChord(key({ key: 'V', ctrlKey: true, shiftKey: true }), 'win')).toBe('paste');
    expect(clipboardChord(key({ key: 'A', ctrlKey: true, shiftKey: true }), 'linux')).toBe('selectAll');
  });

  it('leaves Ctrl+C, other keys and every Mac chord to the terminal', () => {
    expect(clipboardChord(key({ key: 'c', ctrlKey: true }), 'linux')).toBeUndefined();
    expect(clipboardChord(key({ key: 'X', ctrlKey: true, shiftKey: true }), 'linux')).toBeUndefined();
    expect(clipboardChord(key({ key: 'C', ctrlKey: true, shiftKey: true, altKey: true }), 'linux')).toBeUndefined();
    expect(clipboardChord(key({ key: 'c', metaKey: true }), 'mac')).toBeUndefined();
    expect(clipboardChord(key({ key: 'C', ctrlKey: true, shiftKey: true }), 'mac')).toBeUndefined();
  });
});

describe('TerminalContextMenu', () => {
  it('opens on right-click with the pane’s state read then, and runs the picked item', async () => {
    const run = actions();
    const state = vi.fn(() => ({ hasSelection: false, connected: true }));
    render(
      <TerminalContextMenu platform="linux" state={state} actions={run}>
        <div data-testid="target" />
      </TerminalContextMenu>,
    );
    expect(state).not.toHaveBeenCalled();
    fireEvent.contextMenu(screen.getByTestId('target'));
    const items = await screen.findAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual([
      'CopyCtrl+Shift+C',
      'PasteCtrl+Shift+V',
      'Select allCtrl+Shift+A',
      'Find…Ctrl+F',
      'Clear',
      'Split rightCtrl+D',
      'Split downCtrl+Shift+D',
      'Run snippet…Ctrl+;',
      'Open files',
      'Reconnect',
    ]);
    expect(state).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('menuitem', { name: 'Copy' }).getAttribute('data-disabled')).not.toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Find…' }));
    expect(run.find).toHaveBeenCalledTimes(1);
  });
});

describe('the recording mark', () => {
  it('counts only open sessions that are logged', () => {
    const panes = {
      p1: { hostId: 'a', sessionId: 's1', state: 'open' as const },
      p2: { hostId: 'a', sessionId: 's2', state: 'open' as const, recording: true as const },
      p3: { hostId: 'a', sessionId: 's3', state: 'closed' as const, recording: true as const },
    };
    expect(recordingOf(panes, ['p1'])).toBe(false);
    expect(recordingOf(panes, ['p1', 'p2'])).toBe(true);
    expect(recordingOf(panes, ['p3'])).toBe(false);
  });

  it('shows on a pane header while its session is logged', () => {
    useHostsStore.setState({
      panes: { p1: { hostId: 'a', sessionId: 's1', state: 'open', recording: true } },
    });
    const { rerender } = render(<PaneHeader tabId="t" pane={{ paneId: 'p1', hostId: 'a' }} focused />);
    expect(screen.getByTestId('recording-mark').getAttribute('aria-label')).toMatch(/^Recording/);
    useHostsStore.setState({ panes: { p1: { hostId: 'a', sessionId: 's1', state: 'closed' } } });
    rerender(<PaneHeader tabId="t" pane={{ paneId: 'p1', hostId: 'a' }} focused />);
    expect(screen.queryByTestId('recording-mark')).toBeNull();
  });
});
