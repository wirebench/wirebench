import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// jsdom has no canvas or layout, so the terminal is a recording stand-in.
const xterm = vi.hoisted(() => {
  class FakeTerminal {
    static instances: FakeTerminal[] = [];
    cols = 80;
    rows = 24;
    options: Record<string, unknown>;
    written: Uint8Array[] = [];
    pasted: string[] = [];
    selection = '';
    selectionListeners: (() => void)[] = [];
    dataListeners: ((data: string) => void)[] = [];
    disposed = false;
    constructor(options: Record<string, unknown>) {
      this.options = options;
      FakeTerminal.instances.push(this);
    }
    loadAddon(): void {}
    open(): void {}
    focus(): void {}
    attachCustomKeyEventHandler(): void {}
    write(data: Uint8Array): void {
      this.written.push(data);
    }
    paste(text: string): void {
      this.pasted.push(text);
    }
    getSelection(): string {
      return this.selection;
    }
    onSelectionChange(listener: () => void) {
      this.selectionListeners.push(listener);
      return { dispose: () => undefined };
    }
    onData(listener: (data: string) => void) {
      this.dataListeners.push(listener);
      return { dispose: () => undefined };
    }
    type(data: string): void {
      for (const listener of this.dataListeners) listener(data);
    }
    onBinary() {
      return { dispose: () => undefined };
    }
    dispose(): void {
      this.disposed = true;
    }
  }
  class FakeSearchAddon {
    onDidChangeResults() {
      return { dispose: () => undefined };
    }
  }
  return { FakeTerminal, FakeSearchAddon };
});
vi.mock('@xterm/xterm', () => ({ Terminal: xterm.FakeTerminal }));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit(): void {}
  },
}));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }));
vi.mock('@xterm/addon-search', () => ({ SearchAddon: xterm.FakeSearchAddon }));

import { registerSshCommands } from '../../src/renderer/commands/register-ssh-commands.js';
import { useLocalTerminalsStore } from '../../src/renderer/features/ssh/local-terminal.js';
import { HostsView } from '../../src/renderer/features/ssh/hosts-view.js';
import { __dispatchForTest as dispatch, bytesToBase64 } from '../../src/renderer/features/ssh/terminal-session.js';
import { getCommand, resetCommands, runCommand } from '../../src/renderer/lib/commands.js';
import { EditorArea } from '../../src/renderer/shell/editor-area.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { usePreferencesStore } from '../../src/renderer/state/preferences.js';
import { DEFAULT_PREFERENCES_WIRE } from '../../src/renderer/state/preferences-defaults.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

const open = vi.fn();
const write = vi.fn();
const resize = vi.fn();
const close = vi.fn();
const writeText = vi.fn();
const OPENED = (sessionId: string, shell = 'zsh') => ({ ok: true, value: { sessionId, shell } });
const text = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes);

beforeEach(() => {
  xterm.FakeTerminal.instances = [];
  for (const fn of [open, write, resize, close, writeText]) fn.mockReset();
  close.mockResolvedValue({ ok: true, value: {} });
  write.mockResolvedValue({ ok: true, value: {} });
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  usePreferencesStore.setState({ preferences: DEFAULT_PREFERENCES_WIRE });
  installWirebenchApi({
    localTerminal: { open, write, resize, close },
    ssh: {
      listHosts: vi.fn().mockResolvedValue({ ok: false, error: { code: 'x', message: 'x' } }),
      secretNames: vi.fn().mockResolvedValue({ ok: true, value: { names: [] } }),
      knownHosts: vi.fn().mockResolvedValue({ ok: true, value: { entries: [] } }),
    },
  });
  useEditorsStore.getState().reset();
  useUiStore.setState({ localTerminalEnabled: true });
  resetCommands();
  registerSshCommands(() => undefined);
});

afterEach(() => {
  cleanup();
  useEditorsStore.getState().reset();
});

const localTab = () => useEditorsStore.getState().tabs.find((t) => t.kind === 'local-terminal');
const lastTerminal = () => xterm.FakeTerminal.instances.at(-1);

/** Opens a local terminal through its command and waits for the shell main started. */
async function openShell(sessionId = 'l1'): Promise<void> {
  open.mockResolvedValueOnce(OPENED(sessionId));
  await act(async () => {
    await runCommand('ssh.newLocalTerminal', {} as never);
  });
  render(<EditorArea />);
  await waitFor(() => {
    expect(useLocalTerminalsStore.getState().sessions[localTab()?.id ?? '']?.state).toBe('open');
  });
}

describe('the local terminal tab', () => {
  it('New Local Terminal opens a tab in the SSH set that starts a shell of the terminal’s size', async () => {
    await openShell();
    expect(localTab()?.id).toMatch(/^local-terminal:/);
    expect(useEditorsStore.getState().displayedSet).toBe('ssh');
    expect(open).toHaveBeenCalledWith({ cols: 80, rows: 24 });
    expect(screen.getByRole('tab', { name: /Local · zsh/ })).toBeDefined();
  });

  it('shows what the shell prints and sends what is typed', async () => {
    await openShell();
    act(() => {
      dispatch('localTerminal.data', { sessionId: 'l1', data: bytesToBase64(new TextEncoder().encode('$ ')) });
    });
    expect(text(lastTerminal()?.written.at(-1))).toBe('$ ');
    lastTerminal()?.type('ls\r');
    expect(write).toHaveBeenCalledWith({ sessionId: 'l1', data: bytesToBase64(new TextEncoder().encode('ls\r')) });
  });

  it('shows the ended state with the exit code, and Restart starts a new shell', async () => {
    await openShell();
    act(() => {
      dispatch('localTerminal.exit', { sessionId: 'l1', code: 3 });
    });
    expect(screen.getByTestId('local-terminal-notice').textContent).toContain('Shell ended (code 3)');
    open.mockResolvedValueOnce(OPENED('l2'));
    fireEvent.click(screen.getByRole('button', { name: 'Restart' }));
    await waitFor(() => {
      expect(useLocalTerminalsStore.getState().sessions[localTab()?.id ?? '']?.sessionId).toBe('l2');
    });
    expect(screen.queryByTestId('local-terminal-notice')).toBeNull();
  });

  it('says why when the shell cannot start', async () => {
    open.mockResolvedValueOnce({
      ok: false,
      error: { code: 'local-terminal-unavailable', message: 'The local terminal is not available on this machine' },
    });
    await act(async () => {
      await runCommand('ssh.newLocalTerminal', {} as never);
    });
    render(<EditorArea />);
    expect((await screen.findByTestId('local-terminal-notice')).textContent).toContain(
      'Could not start the shell · The local terminal is not available on this machine',
    );
  });

  it('closing the tab ends the shell', async () => {
    await openShell();
    const id = localTab()?.id ?? '';
    act(() => {
      useEditorsStore.getState().close(id);
    });
    await waitFor(() => {
      expect(close).toHaveBeenCalledWith({ sessionId: 'l1' });
    });
    expect(lastTerminal()?.disposed).toBe(true);
    expect(useLocalTerminalsStore.getState().sessions[id]).toBeUndefined();
  });

  it('holds a multi-line paste behind the paste guard', async () => {
    await openShell();
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { getData: () => 'ls\nrm -rf /tmp/x\n' } });
    const target = document.createElement('textarea');
    screen.getByTestId('local-terminal').appendChild(target);
    act(() => {
      target.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    fireEvent.click(await screen.findByRole('button', { name: 'Paste' }));
    expect(lastTerminal()?.pasted).toEqual(['ls\nrm -rf /tmp/x\n']);
  });

  it('copies the selection when copy on select is on', async () => {
    await openShell();
    vi.useFakeTimers();
    try {
      usePreferencesStore.setState({
        preferences: {
          ...DEFAULT_PREFERENCES_WIRE,
          terminal: { ...DEFAULT_PREFERENCES_WIRE.terminal, copyOnSelect: true },
        },
      });
      const term = lastTerminal();
      if (term === undefined) throw new Error('no terminal');
      term.selection = 'hello';
      for (const listener of term.selectionListeners) listener();
      vi.advanceTimersByTime(200);
      expect(writeText).toHaveBeenCalledWith('hello');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the local terminal switch', () => {
  it('the SSH sidebar offers New local terminal while it is on', () => {
    render(<HostsView />);
    fireEvent.click(screen.getByTestId('ssh-new-local-terminal'));
    expect(localTab()).toBeDefined();
  });

  it('switched off, there is no command and no sidebar entry', () => {
    useUiStore.setState({ localTerminalEnabled: false });
    resetCommands();
    registerSshCommands(() => undefined);
    expect(getCommand('ssh.newLocalTerminal')).toBeUndefined();
    render(<HostsView />);
    expect(screen.queryByTestId('ssh-new-local-terminal')).toBeNull();
  });
});
