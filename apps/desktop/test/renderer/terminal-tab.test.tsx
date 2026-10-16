import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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
    disposed = false;
    focused = 0;
    keyHandler: ((event: KeyboardEvent) => boolean) | undefined;
    constructor(options: Record<string, unknown>) {
      this.options = options;
      FakeTerminal.instances.push(this);
    }
    loadAddon(addon: { activate?: (term: FakeTerminal) => void }): void {
      addon.activate?.(this);
    }
    open(): void {}
    focus(): void {
      this.focused += 1;
    }
    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void {
      this.keyHandler = handler;
    }
    write(data: Uint8Array): void {
      this.written.push(data);
    }
    paste(text: string): void {
      this.pasted.push(text);
    }
    getSelection(): string {
      return this.selection;
    }
    hasSelection(): boolean {
      return this.selection !== '';
    }
    selectedAll = 0;
    selectAll(): void {
      this.selectedAll += 1;
    }
    cleared = 0;
    clear(): void {
      this.cleared += 1;
    }
    onSelectionChange(listener: () => void) {
      this.selectionListeners.push(listener);
      return { dispose: () => undefined };
    }
    dataListeners: ((data: string) => void)[] = [];
    parsedListeners: (() => void)[] = [];
    /** The cursor's row as the shell has written it; the cursor sits at its end. */
    row = '';
    buffer = {
      active: {
        type: 'normal' as 'normal' | 'alternate',
        cursorX: 0,
        cursorY: 0,
        baseY: 0,
        getLine: () => ({
          translateToString: (_trim: boolean, start = 0, end?: number) => this.row.slice(start, end),
        }),
      },
    };
    modes = { bracketedPasteMode: false };
    decorations: { options: Record<string, unknown>; element: HTMLElement; disposed: boolean }[] = [];
    onData(listener: (data: string) => void) {
      this.dataListeners.push(listener);
      return {
        dispose: () => {
          this.dataListeners = this.dataListeners.filter((l) => l !== listener);
        },
      };
    }
    /** What a keystroke does: xterm's onData, before the shell's echo. */
    type(data: string): void {
      for (const listener of this.dataListeners) listener(data);
    }
    /** The shell echoes what was typed: the cursor moves on and xterm reports the write parsed. */
    echo(text: string): void {
      this.row += text;
      this.buffer.active.cursorX += text.length;
      for (const listener of this.parsedListeners) listener();
    }
    onWriteParsed(listener: () => void) {
      this.parsedListeners.push(listener);
      return { dispose: () => undefined };
    }
    registerMarker() {
      return { line: 0, dispose: () => undefined };
    }
    registerDecoration(options: Record<string, unknown>) {
      const element = document.createElement('div');
      document.body.appendChild(element);
      const entry = { options, element, disposed: false };
      this.decorations.push(entry);
      const onDispose: (() => void)[] = [];
      return {
        element,
        onRender: (listener: (el: HTMLElement) => void) => {
          listener(element);
          return { dispose: () => undefined };
        },
        onDispose: (listener: () => void) => {
          onDispose.push(listener);
          return { dispose: () => undefined };
        },
        dispose: () => {
          entry.disposed = true;
          element.remove();
          for (const listener of onDispose) listener();
        },
      };
    }
    onBinary() {
      return { dispose: () => undefined };
    }
    dispose(): void {
      this.disposed = true;
    }
  }
  /** Records the searches; `fire` reports results the way the addon's event does. */
  class FakeSearchAddon {
    static instances: FakeSearchAddon[] = [];
    calls: { direction: string; term: string; options: Record<string, unknown> }[] = [];
    cleared = 0;
    listeners: ((r: { resultIndex: number; resultCount: number }) => void)[] = [];
    constructor() {
      FakeSearchAddon.instances.push(this);
    }
    findNext(term: string, options: Record<string, unknown>): boolean {
      this.calls.push({ direction: 'next', term, options });
      return true;
    }
    findPrevious(term: string, options: Record<string, unknown>): boolean {
      this.calls.push({ direction: 'previous', term, options });
      return true;
    }
    clearDecorations(): void {
      this.cleared += 1;
    }
    onDidChangeResults(listener: (r: { resultIndex: number; resultCount: number }) => void) {
      this.listeners.push(listener);
      return { dispose: () => undefined };
    }
    fire(resultIndex: number, resultCount: number): void {
      for (const listener of this.listeners) listener({ resultIndex, resultCount });
    }
  }
  return { FakeTerminal, FakeSearchAddon };
});
vi.mock('@xterm/xterm', () => ({ Terminal: xterm.FakeTerminal }));
// The output highlights read real buffer cells; they have their own tests and an e2e.
vi.mock('../../src/renderer/features/ssh/output-highlights.js', () => ({
  attachOutputHighlights: () => ({ refresh: () => undefined, dispose: () => undefined }),
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit(): void {}
  },
}));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }));
vi.mock('@xterm/addon-search', () => ({ SearchAddon: xterm.FakeSearchAddon }));
// ⌘W's command comes with the editor commands, which load Monaco.
vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));

import type { ResolvedHostWire } from '../../src/shared/ssh-wire.js';
import { registerEditorCommands } from '../../src/renderer/commands/register-editor-commands.js';
import { registerSshCommands } from '../../src/renderer/commands/register-ssh-commands.js';
import { openLayout } from '../../src/renderer/features/ssh/panes/open-layout.js';
import { useLayoutsStore } from '../../src/renderer/features/ssh/panes/layouts-store.js';
import type { LayoutWire } from '../../src/shared/layout-wire.js';
import { openTerminalFor } from '../../src/renderer/features/ssh/connect.js';
import { usePanesStore } from '../../src/renderer/features/ssh/panes/pane-actions.js';
import { leaves, type PaneNode } from '../../src/renderer/features/ssh/panes/pane-tree.js';
import { resetCommands, runCommand } from '../../src/renderer/lib/commands.js';
import { useHostsStore } from '../../src/renderer/features/ssh/hosts-store.js';
import { reconnectNow } from '../../src/renderer/features/ssh/reconnect.js';
import { __dispatchForTest as dispatch, bytesToBase64 } from '../../src/renderer/features/ssh/terminal-session.js';
import { EditorArea } from '../../src/renderer/shell/editor-area.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { usePreferencesStore } from '../../src/renderer/state/preferences.js';
import { DEFAULT_PREFERENCES_WIRE } from '../../src/renderer/state/preferences-defaults.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { useBroadcastStore } from '../../src/renderer/features/ssh/panes/broadcast.js';
import { SnippetRunDialog } from '../../src/renderer/features/ssh/snippets/run-dialog.js';
import { useSnippetsStore } from '../../src/renderer/features/ssh/snippets/snippets-store.js';
import type { SnippetListItemWire } from '../../src/shared/snippets-wire.js';

const connect = vi.fn();
const write = vi.fn();
const resize = vi.fn();
const close = vi.fn();
const OPEN = (sessionId: string) => ({ ok: true, value: { sessionId } });
const NEW_KEY = {
  ok: false,
  error: {
    code: 'ssh-host-key-new',
    message: 'untrusted',
    details: { host: 'h:22', keyType: 'ssh-ed25519', fingerprint: 'SHA256:k' },
  },
};

const runSnippet = vi.fn();
const listSnippets = vi.fn();
// The run dialog previews after a debounce; a preview that lands after a test ends must not throw.
const previewSnippet = vi.fn(() => Promise.resolve({ ok: true as const, value: { text: '', revision: '' } }));
const preferencesUpdate = vi.fn();
const writeText = vi.fn();

// The editor area loads the terminal and Files tabs lazily. Loading them here keeps that cold import, slow on
// a busy Windows runner, out of the first test's waits.
beforeAll(async () => {
  await Promise.all([
    import('../../src/renderer/features/ssh/terminal-tab.js'),
    import('../../src/renderer/features/ssh/files/files-tab.js'),
  ]);
});

beforeEach(() => {
  xterm.FakeTerminal.instances = [];
  xterm.FakeSearchAddon.instances = [];
  usePreferencesStore.setState({ preferences: DEFAULT_PREFERENCES_WIRE });
  // Main answers with the document after the patch, which the store then adopts.
  preferencesUpdate.mockReset().mockImplementation((request: { patch: { terminal?: object } }) =>
    Promise.resolve({
      ok: true,
      value: {
        preferences: {
          ...usePreferencesStore.getState().preferences,
          terminal: { ...usePreferencesStore.getState().preferences.terminal, ...request.patch.terminal },
        },
      },
    }),
  );
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  for (const fn of [connect, write, resize, close, runSnippet, listSnippets]) fn.mockReset();
  close.mockResolvedValue({ ok: true, value: {} });
  runSnippet.mockResolvedValue({ ok: true, value: {} });
  listSnippets.mockResolvedValue({
    ok: true,
    value: { file: { version: 1, packages: [], snippets: [] }, snippets: [], problems: [] },
  });
  installWirebenchApi({
    ssh: { connect, write, resize, close, runSnippet, listSnippets, previewSnippet },
    preferences: { update: preferencesUpdate },
  });
  useSnippetsStore.getState().reset();
  useEditorsStore.getState().reset();
  useHostsStore.setState({
    file: { version: 1, groups: [], hosts: [{ id: 'a', name: 'alpha', address: 'a.example', tags: [], ssh: {} }] },
    panes: {},
    trustPrompt: null,
    connectFailed: {},
  });
});

afterEach(() => {
  cleanup();
  useEditorsStore.getState().reset();
});

/** The pane on a host, as its session was keyed by host before tabs held panes. */
const paneIdOn = (hostId: string): string | undefined => {
  const { panes } = useHostsStore.getState();
  return Object.keys(panes).find((id) => panes[id]?.hostId === hostId);
};
const sessionOn = (hostId: string) => {
  const id = paneIdOn(hostId);
  const pane = id === undefined ? undefined : useHostsStore.getState().panes[id];
  return pane === undefined ? undefined : { sessionId: pane.sessionId, state: pane.state };
};

/** The terminal tab's id (`ssh-terminal:<uuid>`). */
const terminalTab = (): string => useEditorsStore.getState().tabs.find((t) => t.kind === 'ssh-terminal')?.id ?? '';

/** The terminal the tab created most recently. */
const lastTerminal = () => xterm.FakeTerminal.instances.at(-1);

describe('the terminal tab', () => {
  it('Files opens the host’s Files tab beside the terminal', async () => {
    connect.mockResolvedValueOnce(OPEN('s1'));
    act(() => {
      openTerminalFor('a');
    });
    render(<EditorArea />);
    await waitFor(() => {
      expect(connect).toHaveBeenCalled();
    });
    fireEvent.click(screen.getByRole('button', { name: /^Files$/ }));
    expect(useEditorsStore.getState().activeId).toBe('ssh-files:a');
    expect(useEditorsStore.getState().tabs.map((t) => t.kind)).toEqual(['ssh-terminal', 'ssh-files']);
  });

  it('survives switching tabs; only closing the tab closes the session', async () => {
    connect.mockResolvedValueOnce(OPEN('s1'));
    act(() => {
      openTerminalFor('a');
    });
    render(<EditorArea />);
    await waitFor(() => {
      expect(sessionOn('a')).toEqual({ sessionId: 's1', state: 'open' });
    });
    expect(connect).toHaveBeenCalledWith({ hostId: 'a', cols: 80, rows: 24, attemptId: expect.any(String) as unknown });

    act(() => {
      useEditorsStore.getState().showStart();
    });
    expect(screen.getByTestId('ssh-terminal').closest('[hidden]')).not.toBeNull();
    act(() => {
      useEditorsStore.getState().activate(terminalTab());
    });
    expect(screen.getByTestId('ssh-terminal').closest('[hidden]')).toBeNull();
    expect(close).not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(xterm.FakeTerminal.instances).toHaveLength(1);

    act(() => {
      useEditorsStore.getState().close(terminalTab());
    });
    expect(close).toHaveBeenCalledWith({ sessionId: 's1' });
    expect(sessionOn('a')).toBeUndefined();
    expect(lastTerminal()?.disposed).toBe(true);
  });

  it('attaches to a session the trust prompt opened after the connect returned nothing', async () => {
    connect.mockResolvedValueOnce(NEW_KEY);
    act(() => {
      openTerminalFor('a');
    });
    render(<EditorArea />);
    await waitFor(() => {
      expect(useHostsStore.getState().trustPrompt).not.toBeNull();
    });
    // What confirmTrust does once the user clicks Trust; output can arrive before the tab attaches.
    dispatch('ssh.data', { sessionId: 's2', data: bytesToBase64(new Uint8Array([104, 105])) });
    act(() => {
      const { paneId = '' } = useHostsStore.getState().trustPrompt ?? {};
      useHostsStore.getState().setPane(paneId, { hostId: 'a', sessionId: 's2', state: 'open' });
    });
    await waitFor(() => {
      expect(lastTerminal()?.written).toEqual([new Uint8Array([104, 105])]);
    });
    dispatch('ssh.data', { sessionId: 's2', data: bytesToBase64(new Uint8Array([33])) });
    expect(lastTerminal()?.written.at(-1)).toEqual(new Uint8Array([33]));
  });

  it('shows the exit in place and Reconnect opens a fresh session', async () => {
    connect.mockResolvedValueOnce(OPEN('s1'));
    act(() => {
      openTerminalFor('a');
    });
    render(<EditorArea />);
    await waitFor(() => {
      expect(sessionOn('a')?.sessionId).toBe('s1');
    });
    act(() => {
      dispatch('ssh.exit', { sessionId: 's1', code: 0 });
      useHostsStore.getState().noteSessionState('s1', 'closed');
    });
    expect(await screen.findByText('Session ended (code 0)')).toBeDefined();
    expect(useEditorsStore.getState().tabs).toHaveLength(1);

    connect.mockResolvedValueOnce(OPEN('s3'));
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
    await waitFor(() => {
      expect(sessionOn('a')).toEqual({ sessionId: 's3', state: 'open' });
    });
    expect(close).toHaveBeenCalledWith({ sessionId: 's1' });
    expect(connect).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/Session ended/)).toBeNull();
  });

  it('a refused connect shows why on the connection screen, and Retry connects again', async () => {
    connect.mockResolvedValueOnce({
      ok: false,
      error: { code: 'ssh-auth-failed', message: 'nope', details: { host: 'a:22', tried: ['password'], allowed: [] } },
    });
    act(() => {
      openTerminalFor('a');
    });
    render(<EditorArea />);
    expect((await screen.findByTestId('connect-error')).textContent).toBe(
      "a:22 refused the password. Check the host's sign-in settings.",
    );
    expect(screen.getByTestId('connect-step-auth').dataset['state']).toBe('failed');
    // The log opens on its own when a connect fails, its summary pinned on top in red saying what failed.
    expect(screen.getByTestId('connect-log-summary').textContent).toContain('a:22 refused the password');
    expect(screen.queryByText('nope')).toBeNull();

    connect.mockResolvedValueOnce(OPEN('s1'));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => {
      expect(sessionOn('a')).toEqual({ sessionId: 's1', state: 'open' });
    });
    expect(connect).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('connect-error')).toBeNull();
    expect(await screen.findByText(/^Connected in /)).toBeDefined();
    // The screen fades into the terminal.
    await waitFor(
      () => {
        expect(screen.queryByTestId('connect-screen')).toBeNull();
      },
      { timeout: 3000 },
    );
  });

  it('keys typed while connecting are kept and sent once the shell opens (#361)', async () => {
    let answer: (value: unknown) => void = () => undefined;
    connect.mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    act(() => {
      openTerminalFor('a');
    });
    render(<EditorArea />);
    await screen.findByTestId('connect-screen');
    act(() => {
      lastTerminal()?.type('ls -l');
      lastTerminal()?.type('\r');
    });
    expect(write).not.toHaveBeenCalled();
    expect(screen.getByTestId('connect-typed-ahead').textContent).toBe('What you typed is sent when the shell opens.');
    await act(async () => {
      answer(OPEN('s1'));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(write).toHaveBeenCalledWith({ sessionId: 's1', data: bytesToBase64(new TextEncoder().encode('ls -l\r')) });
    });
    expect(write).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('connect-typed-ahead')).toBeNull();
    // From now on keys go straight to the shell.
    act(() => {
      lastTerminal()?.type('x');
    });
    expect(write).toHaveBeenLastCalledWith({ sessionId: 's1', data: bytesToBase64(new TextEncoder().encode('x')) });
  });

  it('a failed connect drops what was typed for it, and keys typed after the failure go nowhere (#361)', async () => {
    let answer: (value: unknown) => void = () => undefined;
    connect.mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    act(() => {
      openTerminalFor('a');
    });
    render(<EditorArea />);
    await screen.findByTestId('connect-screen');
    act(() => {
      lastTerminal()?.type('rm -rf build\r');
    });
    await act(async () => {
      answer({
        ok: false,
        error: {
          code: 'ssh-auth-failed',
          message: 'nope',
          details: { host: 'a:22', tried: ['password'], allowed: [] },
        },
      });
      await Promise.resolve();
    });
    await screen.findByTestId('connect-error');
    expect(screen.queryByTestId('connect-typed-ahead')).toBeNull();
    act(() => {
      lastTerminal()?.type('late');
    });
    connect.mockResolvedValueOnce(OPEN('s1'));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => {
      expect(sessionOn('a')).toEqual({ sessionId: 's1', state: 'open' });
    });
    expect(write).not.toHaveBeenCalled();
  });

  it('the host-key step waits on the trust prompt', async () => {
    connect.mockResolvedValueOnce(NEW_KEY);
    act(() => {
      openTerminalFor('a');
    });
    render(<EditorArea />);
    await waitFor(() => {
      expect(screen.getByTestId('connect-step-host-key').dataset['state']).toBe('waiting');
    });
    expect(screen.getByTestId('connect-step-connect').dataset['state']).toBe('done');
    expect(screen.queryByTestId('connect-log')).toBeNull();
  });

  it('Edit host opens the host for editing, and Close closes the pane', async () => {
    connect.mockResolvedValueOnce({ ok: false, error: { code: 'ssh-connect-failed', message: 'x' } });
    act(() => {
      openTerminalFor('a');
    });
    render(<EditorArea />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit host' }));
    expect(useHostsStore.getState().dialog).toEqual({ mode: 'edit-host', id: 'a' });
    act(() => {
      useEditorsStore.getState().activate(terminalTab());
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Close' }));
    expect(useEditorsStore.getState().tabs.some((t) => t.kind === 'ssh-terminal')).toBe(false);
  });

  it('a dismissed trust prompt offers Reconnect', async () => {
    connect.mockResolvedValueOnce(NEW_KEY);
    act(() => {
      openTerminalFor('a');
    });
    render(<EditorArea />);
    await waitFor(() => {
      expect(useHostsStore.getState().trustPrompt).not.toBeNull();
    });
    expect(screen.queryByTestId('connect-error')).toBeNull();
    act(() => {
      useHostsStore.getState().cancelTrust();
    });
    expect((await screen.findByTestId('connect-error')).textContent).toMatch(/^You did not trust the key/);
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDefined();
  });

  it('connecting again from the tree retries in the open tab', async () => {
    connect.mockResolvedValueOnce({ ok: false, error: { code: 'ssh-auth-failed', message: 'nope' } });
    act(() => {
      openTerminalFor('a');
    });
    render(<EditorArea />);
    await screen.findByTestId('connect-error');

    connect.mockResolvedValueOnce(OPEN('s1'));
    act(() => {
      openTerminalFor('a');
    });
    await waitFor(() => {
      expect(sessionOn('a')).toEqual({ sessionId: 's1', state: 'open' });
    });
    expect(connect).toHaveBeenCalledTimes(2);
    expect(useEditorsStore.getState().tabs).toHaveLength(1);
  });

  it('a session that opens after its tab closed is closed too', async () => {
    let resolve: (value: unknown) => void = () => undefined;
    connect.mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      }),
    );
    act(() => {
      openTerminalFor('a');
    });
    render(<EditorArea />);
    await waitFor(() => {
      expect(connect).toHaveBeenCalledTimes(1);
    });
    act(() => {
      useEditorsStore.getState().close(terminalTab());
    });
    expect(close).not.toHaveBeenCalled();
    resolve(OPEN('s9'));
    await waitFor(() => {
      expect(close).toHaveBeenCalledWith({ sessionId: 's9' });
    });
    expect(sessionOn('a')).toBeUndefined();
  });

  it('the tab strip shows the session state as a dot', async () => {
    connect.mockResolvedValueOnce(OPEN('s1'));
    act(() => {
      openTerminalFor('a');
    });
    render(<EditorArea />);
    const tab = screen.getByRole('tab', { name: /alpha/ });
    await waitFor(() => {
      expect(tab.querySelector('[aria-label="connected"]')).not.toBeNull();
    });
  });

  describe('paste guard', () => {
    /** Mounts an open session and fires a paste of `text` on the terminal's holder. */
    async function pasteInto(text: string): Promise<Event> {
      connect.mockResolvedValueOnce(OPEN('s1'));
      act(() => {
        openTerminalFor('a');
      });
      render(<EditorArea />);
      await waitFor(() => {
        expect(sessionOn('a')?.state).toBe('open');
      });
      return firePaste(text);
    }
    /** Called when a paste reaches the textarea itself, the way xterm's own listener would be. */
    const reachedTextarea = vi.fn();
    function firePaste(text: string): Event {
      const event = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', { value: { getData: () => text } });
      // xterm listens on its hidden textarea, which sits inside the holder.
      const target = document.createElement('textarea');
      target.addEventListener('paste', reachedTextarea);
      screen.getByTestId('ssh-terminal').appendChild(target);
      act(() => {
        target.dispatchEvent(event);
      });
      return event;
    }

    beforeEach(() => {
      reachedTextarea.mockReset();
    });

    it('leaves a single-line paste to the terminal', async () => {
      const event = await pasteInto('ls -la');
      expect(event.defaultPrevented).toBe(false);
      expect(reachedTextarea).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(lastTerminal()?.pasted).toEqual([]);
    });

    it('holds a multi-line paste behind the dialog and sends it through term.paste on Paste', async () => {
      const event = await pasteInto('ls\nrm -rf /tmp/x\n');
      expect(event.defaultPrevented).toBe(true);
      // Stopped in the capture phase: the terminal's own listener never sees a held paste.
      expect(reachedTextarea).not.toHaveBeenCalled();
      expect(await screen.findByRole('dialog')).toBeDefined();
      expect(lastTerminal()?.pasted).toEqual([]);
      expect(write).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('button', { name: 'Paste' }));
      expect(lastTerminal()?.pasted).toEqual(['ls\nrm -rf /tmp/x\n']);
      expect(write).not.toHaveBeenCalled();
      await waitFor(() => {
        expect(screen.queryByRole('dialog')).toBeNull();
      });
      expect(preferencesUpdate).not.toHaveBeenCalled();
    });

    it('Cancel sends nothing', async () => {
      await pasteInto('a\nb');
      fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
      expect(lastTerminal()?.pasted).toEqual([]);
      await waitFor(() => {
        expect(screen.queryByRole('dialog')).toBeNull();
      });
    });

    it("Don't ask again writes the preference, and the next paste does not ask", async () => {
      await pasteInto('a\nb');
      fireEvent.click(await screen.findByRole('checkbox', { name: "Don't ask again" }));
      fireEvent.click(screen.getByRole('button', { name: 'Paste' }));
      expect(lastTerminal()?.pasted).toEqual(['a\nb']);
      expect(preferencesUpdate).toHaveBeenCalledWith({ patch: { terminal: { confirmMultilinePaste: false } } });
      await waitFor(() => {
        expect(screen.queryByRole('dialog')).toBeNull();
      });

      const second = firePaste('c\nd');
      expect(second.defaultPrevented).toBe(false);
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('reads the preference live: switched off before the paste, it never asks', async () => {
      usePreferencesStore.setState({
        preferences: {
          ...DEFAULT_PREFERENCES_WIRE,
          terminal: { ...DEFAULT_PREFERENCES_WIRE.terminal, confirmMultilinePaste: false },
        },
      });
      const event = await pasteInto('a\nb');
      expect(event.defaultPrevented).toBe(false);
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  describe('copy on select', () => {
    async function mount(): Promise<void> {
      connect.mockResolvedValueOnce(OPEN('s1'));
      act(() => {
        openTerminalFor('a');
      });
      render(<EditorArea />);
      await waitFor(() => {
        expect(sessionOn('a')?.state).toBe('open');
      });
    }
    const select = (text: string) => {
      const term = lastTerminal();
      if (term === undefined) throw new Error('no terminal');
      term.selection = text;
      for (const listener of term.selectionListeners) listener();
    };

    afterEach(() => {
      vi.useRealTimers();
    });

    it('does nothing by default', async () => {
      await mount();
      vi.useFakeTimers();
      select('hello');
      vi.advanceTimersByTime(1000);
      expect(writeText).not.toHaveBeenCalled();
    });

    it('copies a non-empty selection once the preference is on, read live', async () => {
      await mount();
      vi.useFakeTimers();
      usePreferencesStore.setState({
        preferences: {
          ...DEFAULT_PREFERENCES_WIRE,
          terminal: { ...DEFAULT_PREFERENCES_WIRE.terminal, copyOnSelect: true },
        },
      });
      select('hello');
      vi.advanceTimersByTime(200);
      expect(writeText).toHaveBeenCalledWith('hello');
      select('');
      vi.advanceTimersByTime(200);
      expect(writeText).toHaveBeenCalledTimes(1);
    });

    it('writes once for a drag that changes the selection many times', async () => {
      await mount();
      vi.useFakeTimers();
      usePreferencesStore.setState({
        preferences: {
          ...DEFAULT_PREFERENCES_WIRE,
          terminal: { ...DEFAULT_PREFERENCES_WIRE.terminal, copyOnSelect: true },
        },
      });
      for (const text of ['h', 'he', 'hel', 'hell', 'hello']) {
        select(text);
        vi.advanceTimersByTime(20);
      }
      expect(writeText).not.toHaveBeenCalled();
      vi.advanceTimersByTime(200);
      expect(writeText).toHaveBeenCalledTimes(1);
      expect(writeText).toHaveBeenCalledWith('hello');
    });
  });

  describe('reconnecting a dropped session', () => {
    const UNREACHABLE = {
      ok: false,
      error: {
        code: 'ssh-connect-failed',
        message: 'a.example:22: connect ETIMEDOUT',
        details: { host: 'a.example:22', hop: 0, hops: 1, reason: 'timeout', phase: 'tcp', timeout: 10 },
      },
    };
    const decoder = new TextDecoder();
    const notice = () => screen.queryByTestId('ssh-terminal-notice')?.textContent ?? null;
    const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
    const terminalPrefs = (terminal: Partial<typeof DEFAULT_PREFERENCES_WIRE.terminal>) => {
      usePreferencesStore.setState({
        preferences: { ...DEFAULT_PREFERENCES_WIRE, terminal: { ...DEFAULT_PREFERENCES_WIRE.terminal, ...terminal } },
      });
    };

    /** Opens the tab on session s1, then ends it the way main reports `reason`. */
    async function dropped(reason: 'lost' | 'exit', code: number | null = null): Promise<void> {
      connect.mockResolvedValueOnce(OPEN('s1'));
      act(() => {
        openTerminalFor('a');
      });
      render(<EditorArea />);
      await waitFor(() => {
        expect(sessionOn('a')?.sessionId).toBe('s1');
      });
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
      vi.setSystemTime(0);
      act(() => {
        dispatch('ssh.exit', { sessionId: 's1', code, reason });
        useHostsStore.getState().noteSessionState('s1', 'closed');
      });
    }

    afterEach(() => {
      vi.useRealTimers();
    });

    it('reconnects into the same terminal after the first wait, keeping the scrollback', async () => {
      await dropped('lost');
      expect(notice()).toContain('Connection lost · Reconnecting… attempt 1 of 10 in 1s');
      connect.mockResolvedValueOnce(OPEN('s2'));
      await advance(1000);
      expect(sessionOn('a')).toEqual({ sessionId: 's2', state: 'open' });
      expect(connect).toHaveBeenLastCalledWith({
        hostId: 'a',
        cols: 80,
        rows: 24,
        attemptId: expect.any(String) as unknown,
      });
      expect(xterm.FakeTerminal.instances).toHaveLength(1);
      expect(lastTerminal()?.disposed).toBe(false);
      expect(
        lastTerminal()
          ?.written.map((b) => decoder.decode(b))
          .join(''),
      ).toContain('reconnected');
      expect(notice()).toBeNull();
      dispatch('ssh.data', { sessionId: 's2', data: bytesToBase64(new Uint8Array([33])) });
      expect(lastTerminal()?.written.at(-1)).toEqual(new Uint8Array([33]));
    });

    it('keeps the terminal in view, dimmed, with the bar as the only control while it reconnects (#590)', async () => {
      await dropped('lost');
      connect.mockResolvedValue(UNREACHABLE);
      await advance(1000);
      // Attempt 1 failed and attempt 2 waits: no connection screen, no second Retry or Edit host.
      expect(notice()).toContain('attempt 2 of 10 in 2s');
      expect(screen.queryByTestId('connect-screen')).toBeNull();
      expect(screen.getByTestId('ssh-terminal').dataset['reconnecting']).toBe('true');
      expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Edit host' })).toBeNull();
      expect(screen.getByRole('button', { name: 'Reconnect now' })).toBeDefined();
      expect(screen.getByRole('button', { name: 'Stop' })).toBeDefined();
      // Show log opens the last attempt's log, its summary pinned on top.
      expect(screen.queryByTestId('connect-log')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Show log' }));
      expect(screen.getByTestId('connect-log-summary').textContent).toMatch(/^No answer from a\.example:22/);
      // The attempt that opens a session goes straight back to the terminal, with no screen fading over it.
      connect.mockResolvedValueOnce(OPEN('s2'));
      fireEvent.click(screen.getByRole('button', { name: 'Reconnect now' }));
      await advance(0);
      expect(sessionOn('a')).toEqual({ sessionId: 's2', state: 'open' });
      expect(screen.queryByTestId('connect-screen')).toBeNull();
      expect(screen.getByTestId('ssh-terminal').dataset['reconnecting']).toBeUndefined();
      expect(notice()).toBeNull();
    });

    it('a shell that exited never reconnects', async () => {
      await dropped('exit', 0);
      expect(notice()).toContain('Session ended (code 0)');
      await advance(120_000);
      expect(connect).toHaveBeenCalledTimes(1);
    });

    it('counts down, backs off on an unreachable host and gives up at the limit with Reconnect', async () => {
      terminalPrefs({ reconnectAttempts: 2 });
      await dropped('lost');
      connect.mockResolvedValue(UNREACHABLE);
      expect(notice()).toContain('attempt 1 of 2 in 1s');
      await advance(1000);
      expect(notice()).toContain('attempt 2 of 2 in 2s');
      await advance(1000);
      expect(notice()).toContain('attempt 2 of 2 in 1s');
      await advance(1000);
      expect(connect).toHaveBeenCalledTimes(3);
      expect(notice()).toContain('Connection lost · gave up after 2 attempts');
      // The raw reason is not shown; the last attempt's screen says it plainly.
      expect(notice()).not.toContain('ETIMEDOUT');
      expect(screen.getByTestId('connect-error').textContent).toMatch(/^No answer from a\.example:22 after 10 s\./);
      expect(screen.getByRole('button', { name: 'Retry' })).toBeDefined();
      // Once it gives up the connection screen shows, its log folded (#590).
      expect(screen.getByTestId('connect-screen')).toBeDefined();
      expect(screen.queryByTestId('connect-log')).toBeNull();
      expect(screen.getByRole('button', { name: 'Show log' })).toBeDefined();
      expect(screen.getByTestId('ssh-terminal').dataset['reconnecting']).toBeUndefined();
      await advance(120_000);
      expect(connect).toHaveBeenCalledTimes(3);
    });

    it('a sign-in failure stops at once and shows the existing reason', async () => {
      await dropped('lost');
      connect.mockResolvedValue({ ok: false, error: { code: 'ssh-auth-failed', message: 'refused' } });
      await advance(1000);
      expect(screen.getByTestId('connect-step-auth').dataset['state']).toBe('failed');
      expect(notice()).toBeNull();
      await advance(120_000);
      expect(connect).toHaveBeenCalledTimes(2);
    });

    it('a changed host key stops at once and shows the trust prompt, never trusting it', async () => {
      await dropped('lost');
      connect.mockResolvedValue({
        ok: false,
        error: {
          ...NEW_KEY.error,
          code: 'ssh-host-key-changed',
          details: { ...NEW_KEY.error.details, previous: 'SHA256:o' },
        },
      });
      await advance(1000);
      expect(useHostsStore.getState().trustPrompt).toMatchObject({ hostId: 'a', previous: 'SHA256:o' });
      expect(notice()).toBeNull();
      await advance(120_000);
      expect(connect).toHaveBeenCalledTimes(2);
    });

    it('Cancel stops the attempts and leaves Reconnect', async () => {
      await dropped('lost');
      fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
      expect(notice()).toContain('Session ended');
      expect(screen.getByRole('button', { name: 'Reconnect' })).toBeDefined();
      await advance(120_000);
      expect(connect).toHaveBeenCalledTimes(1);
    });

    it('Retry now, waking from sleep and the network coming back all skip the wait', async () => {
      await dropped('lost');
      connect.mockResolvedValue(UNREACHABLE);
      fireEvent.click(screen.getByRole('button', { name: 'Reconnect now' }));
      await advance(0);
      expect(connect).toHaveBeenCalledTimes(2);
      expect(notice()).toContain('attempt 2 of 10 in 2s');
      act(() => {
        reconnectNow();
      });
      await advance(0);
      expect(connect).toHaveBeenCalledTimes(3);
      expect(notice()).toContain('attempt 3 of 10 in 4s');
    });

    it('does nothing when Preferences → Terminal turns it off', async () => {
      terminalPrefs({ autoReconnect: false });
      await dropped('lost');
      expect(notice()).toContain('Session ended');
      await advance(120_000);
      expect(connect).toHaveBeenCalledTimes(1);
    });

    it('closing the tab mid-wait stops the attempts', async () => {
      await dropped('lost');
      act(() => {
        useEditorsStore.getState().close(terminalTab());
      });
      await advance(120_000);
      expect(connect).toHaveBeenCalledTimes(1);
    });
  });

  describe('find in the scrollback', () => {
    async function mount(): Promise<void> {
      connect.mockResolvedValueOnce(OPEN('s1'));
      act(() => {
        openTerminalFor('a');
      });
      render(<EditorArea />);
      await waitFor(() => {
        expect(sessionOn('a')?.state).toBe('open');
      });
    }
    /** A keydown as the focused terminal's xterm sees it; returns whether xterm may handle it. */
    function terminalKey(init: KeyboardEventInit): { passed: boolean; event: KeyboardEvent } {
      const event = new KeyboardEvent('keydown', { cancelable: true, ...init });
      let passed = true;
      act(() => {
        passed = lastTerminal()?.keyHandler?.(event) ?? true;
      });
      return { passed, event };
    }
    // jsdom's user agent is not a Mac's, so the chord here is Ctrl+F.
    const CHORD = { key: 'f', ctrlKey: true };
    const findBar = () => screen.getByTestId('terminal-find');
    const search = () => xterm.FakeSearchAddon.instances.at(-1);

    it('the chord in the focused terminal opens the bar and never reaches the shell', async () => {
      await mount();
      expect(findBar().hidden).toBe(true);
      const { passed, event } = terminalKey(CHORD);
      expect(passed).toBe(false);
      expect(event.defaultPrevented).toBe(true);
      expect(findBar().hidden).toBe(false);
      expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Find' }));
      // The keyup of the same chord is swallowed too.
      const up = new KeyboardEvent('keyup', CHORD);
      expect(lastTerminal()?.keyHandler?.(up)).toBe(false);
      expect(write).not.toHaveBeenCalled();
    });

    it('other keys still go to the shell', async () => {
      await mount();
      expect(terminalKey({ key: 'f' }).passed).toBe(true);
      expect(terminalKey({ key: 'g', ctrlKey: true }).passed).toBe(true);
      expect(findBar().hidden).toBe(true);
    });

    it('does not take the chord from anywhere but the focused terminal', async () => {
      await mount();
      const event = new KeyboardEvent('keydown', { ...CHORD, bubbles: true, cancelable: true });
      act(() => {
        document.body.dispatchEvent(event);
      });
      expect(event.defaultPrevented).toBe(false);
      expect(findBar().hidden).toBe(true);
    });

    it('searches the scrollback with highlights and shows the count', async () => {
      await mount();
      terminalKey(CHORD);
      fireEvent.change(screen.getByRole('textbox', { name: 'Find' }), { target: { value: 'needle' } });
      const last = search()?.calls.at(-1);
      expect(last).toMatchObject({
        direction: 'next',
        term: 'needle',
        options: { caseSensitive: false, wholeWord: false, regex: false, incremental: true },
      });
      expect(last?.options['decorations']).toBeDefined();
      // Real xterm refuses decorations (and so the count) unless the terminal allows proposed API.
      expect(lastTerminal()?.options['allowProposedApi']).toBe(true);
      act(() => {
        search()?.fire(0, 2);
      });
      expect(screen.getByTestId('terminal-find-count').textContent).toBe('1 of 2');
    });

    it('Escape closes the bar, clears the highlights and focuses the terminal', async () => {
      await mount();
      terminalKey(CHORD);
      const focusedBefore = lastTerminal()?.focused ?? 0;
      const cleared = search()?.cleared ?? 0;
      fireEvent.keyDown(screen.getByRole('textbox', { name: 'Find' }), { key: 'Escape' });
      expect(findBar().hidden).toBe(true);
      expect(lastTerminal()?.focused).toBe(focusedBefore + 1);
      expect(search()?.cleared).toBeGreaterThan(cleared);
    });

    it('is a strip above the terminal, outside the area the connection screen covers (#534)', async () => {
      await mount();
      terminalKey(CHORD);
      const holder = screen.getByTestId('ssh-terminal');
      expect(findBar().compareDocumentPosition(holder) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(findBar().parentElement?.contains(holder)).toBe(true);
      expect(findBar().className).not.toMatch(/absolute/);
      expect(holder.parentElement?.contains(findBar())).toBe(false);
    });

    it('closes when its pane loses the session (#534)', async () => {
      await mount();
      terminalKey(CHORD);
      expect(findBar().hidden).toBe(false);
      act(() => {
        dispatch('ssh.exit', { sessionId: 's1', code: 0 });
        useHostsStore.getState().noteSessionState('s1', 'closed');
      });
      expect(findBar().hidden).toBe(true);
    });
  });

  describe('the right-click menu (#534)', () => {
    async function mount(reply = OPEN('s1')): Promise<void> {
      connect.mockResolvedValueOnce(reply);
      act(() => {
        openTerminalFor('a');
      });
      render(<EditorArea />);
      await waitFor(() => {
        expect(sessionOn('a')?.state).toBe('open');
      });
    }
    async function pick(name: string): Promise<void> {
      fireEvent.contextMenu(screen.getByTestId('ssh-terminal'));
      fireEvent.click(await screen.findByRole('menuitem', { name }));
    }
    const readText = vi.fn<() => Promise<string>>();
    beforeEach(() => {
      readText.mockReset();
      Object.defineProperty(navigator, 'clipboard', { value: { writeText, readText }, configurable: true });
    });

    it('Find… opens the pane’s find bar with the query focused', async () => {
      await mount();
      expect(screen.getByTestId('terminal-find').hidden).toBe(true);
      await pick('Find…');
      expect(screen.getByTestId('terminal-find').hidden).toBe(false);
      await waitFor(() => {
        expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Find' }));
      });
    });

    it('Copy copies the selection; Select all and Clear act on the terminal', async () => {
      await mount();
      const term = lastTerminal();
      if (term === undefined) throw new Error('no terminal');
      term.selection = 'picked';
      await pick('Copy');
      expect(writeText).toHaveBeenCalledWith('picked');
      await pick('Select all');
      expect(term.selectedAll).toBe(1);
      await pick('Clear');
      expect(term.cleared).toBe(1);
    });

    it('Paste goes through the paste guard: one line goes in, several lines ask first', async () => {
      await mount();
      readText.mockResolvedValueOnce('uptime');
      await pick('Paste');
      await waitFor(() => {
        expect(lastTerminal()?.pasted).toEqual(['uptime']);
      });
      readText.mockResolvedValueOnce('rm -rf a\nrm -rf b\n');
      await pick('Paste');
      expect(await screen.findByRole('dialog')).toBeTruthy();
      expect(lastTerminal()?.pasted).toEqual(['uptime']);
    });

    it('Ctrl+Shift+C and Ctrl+Shift+V copy and paste off a Mac, and never reach the shell', async () => {
      await mount();
      const term = lastTerminal();
      if (term === undefined) throw new Error('no terminal');
      term.selection = 'out';
      const copy = new KeyboardEvent('keydown', { key: 'C', ctrlKey: true, shiftKey: true, cancelable: true });
      expect(term.keyHandler?.(copy)).toBe(false);
      expect(copy.defaultPrevented).toBe(true);
      expect(writeText).toHaveBeenCalledWith('out');
      readText.mockResolvedValueOnce('ls');
      act(() => {
        term.keyHandler?.(new KeyboardEvent('keydown', { key: 'V', ctrlKey: true, shiftKey: true }));
      });
      await waitFor(() => {
        expect(term.pasted).toEqual(['ls']);
      });
      expect(write).not.toHaveBeenCalled();
    });

    it('Reconnect opens a fresh session in the pane', async () => {
      await mount();
      connect.mockResolvedValueOnce(OPEN('s2'));
      await pick('Reconnect');
      await waitFor(() => {
        expect(sessionOn('a')?.sessionId).toBe('s2');
      });
      expect(close).toHaveBeenCalledWith({ sessionId: 's1' });
    });
  });

  it('draws the recording dot on the tab while the session is logged (#534)', async () => {
    connect.mockResolvedValueOnce({ ok: true, value: { sessionId: 's1', recording: true } });
    act(() => {
      openTerminalFor('a');
    });
    render(<EditorArea />);
    expect(await screen.findByTestId('recording-mark')).toBeTruthy();
    act(() => {
      useHostsStore.getState().noteSessionState('s1', 'closed');
    });
    expect(screen.queryByTestId('recording-mark')).toBeNull();
  });
});

describe('split panes', () => {
  const resolvedHost = (id: string, name: string) =>
    ({
      id,
      name,
      address: `${id}.example`,
      path: [],
      tags: [],
      protected: { value: false },
      ssh: {
        user: {},
        port: { value: 22 },
        auth: {},
        jump: {},
        keepAlive: { value: 0 },
        connectTimeout: { value: 10 },
      },
      forwards: [],
    }) as unknown as ResolvedHostWire;

  beforeEach(() => {
    // Panes a test mounts beyond the ones it names connect too.
    connect.mockResolvedValue(OPEN('s-more'));
    usePanesStore.setState({ focused: {}, picker: undefined });
    useHostsStore.setState({ resolved: [resolvedHost('a', 'alpha'), resolvedHost('b', 'beta')] });
    resetCommands();
    registerSshCommands(vi.fn());
    registerEditorCommands();
  });

  const tree = (): PaneNode => {
    const panes = useEditorsStore.getState().tabs.find((t) => t.kind === 'ssh-terminal')?.panes;
    if (panes === undefined) throw new Error('no terminal tab');
    return panes;
  };

  async function mount(): Promise<void> {
    connect.mockResolvedValueOnce(OPEN('s1'));
    act(() => {
      openTerminalFor('a');
    });
    // The Files tab's buttons need the shell's TooltipProvider, which tests render outside.
    render(
      <TooltipPrimitive.Provider>
        <EditorArea />
      </TooltipPrimitive.Provider>,
    );
    await waitFor(() => {
      expect(sessionOn('a')?.state).toBe('open');
    });
  }

  /** Splits right through the toolbar and picks the host the picker starts on. */
  async function splitOnSameHost(): Promise<void> {
    connect.mockResolvedValueOnce(OPEN('s2'));
    fireEvent.click(screen.getByRole('button', { name: /Split right/ }));
    const input = await screen.findByTestId('ssh-pane-host-input');
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => {
      expect(Object.values(useHostsStore.getState().panes).filter((p) => p.state === 'open')).toHaveLength(2);
    });
  }

  it('Split right opens the picker on the pane’s host, and Enter connects a second pane there', async () => {
    await mount();
    fireEvent.click(screen.getByRole('button', { name: /Split right/ }));
    await screen.findByTestId('ssh-pane-host-input');
    const selected = screen.getAllByTestId('ssh-pane-host').find((row) => row.dataset['selected'] === 'true');
    expect(selected?.textContent).toContain('alpha');
    connect.mockResolvedValueOnce(OPEN('s2'));
    fireEvent.keyDown(screen.getByTestId('ssh-pane-host-input'), { key: 'Enter' });
    await waitFor(() => {
      expect(connect).toHaveBeenCalledTimes(2);
    });
    expect(connect).toHaveBeenLastCalledWith(expect.objectContaining({ hostId: 'a' }));
    expect(leaves(tree()).map((leaf) => leaf.hostId)).toEqual(['a', 'a']);
    expect(screen.getAllByTestId('ssh-pane-header')).toHaveLength(2);
    expect(screen.queryByTestId('ssh-pane-host-input')).toBeNull();
  });

  it('the picker lists the same host first with its status, then the others, and says what it is for', async () => {
    await mount();
    fireEvent.click(screen.getByRole('button', { name: /Split right/ }));
    const input = await screen.findByTestId('ssh-pane-host-input');
    expect(input.getAttribute('placeholder')).toBe('Pick a host for the new pane…');
    const rows = screen.getAllByTestId('ssh-pane-host');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('alpha');
    expect(rows[1]?.textContent).toContain('beta');
    expect(within(rows[0]!).getByRole('img').getAttribute('aria-label')).toBe('connected');
    expect(within(rows[1]!).getByRole('img').getAttribute('aria-label')).toBe('not connected');
    expect(screen.getByText('Same host')).toBeDefined();
    expect(screen.getByText('Other hosts')).toBeDefined();
    fireEvent.keyDown(input, { key: 'Escape' });
  });

  it('Escape cancels the split', async () => {
    await mount();
    fireEvent.click(screen.getByRole('button', { name: /Split down/ }));
    const input = await screen.findByTestId('ssh-pane-host-input');
    fireEvent.keyDown(input, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByTestId('ssh-pane-host-input')).toBeNull();
    });
    expect(tree().kind).toBe('pane');
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('dragging the divider sets the ratio, and a double-click evens it out', async () => {
    await mount();
    await splitOnSameHost();
    const divider = screen.getByTestId('ssh-pane-divider');
    const split = divider.parentElement;
    if (split === null) throw new Error('no split');
    split.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 100 }) as DOMRect;
    fireEvent.pointerDown(divider, { button: 0, clientX: 100 });
    fireEvent.pointerMove(window, { clientX: 60 });
    fireEvent.pointerUp(window);
    expect(tree()).toMatchObject({ kind: 'split', ratio: 0.3 });
    fireEvent.pointerMove(window, { clientX: 150 });
    expect(tree()).toMatchObject({ ratio: 0.3 });
    fireEvent.doubleClick(divider);
    expect(tree()).toMatchObject({ ratio: 0.5 });
  });

  it('a pane chord is the app’s: the terminal never sends it to the shell', async () => {
    await mount();
    // jsdom's user agent is not a Mac's, so ⌘D here is Ctrl+D.
    const event = new KeyboardEvent('keydown', { key: 'd', ctrlKey: true, cancelable: true });
    expect(lastTerminal()?.keyHandler?.(event)).toBe(false);
    expect(lastTerminal()?.keyHandler?.(new KeyboardEvent('keydown', { key: 'd' }))).toBe(true);
  });

  /** Preferences → Terminal with `terminal` patched in. */
  const terminalPrefs = (terminal: Partial<typeof DEFAULT_PREFERENCES_WIRE.terminal>): void => {
    usePreferencesStore.setState({
      preferences: { ...DEFAULT_PREFERENCES_WIRE, terminal: { ...DEFAULT_PREFERENCES_WIRE.terminal, ...terminal } },
    });
  };
  const withTerminal = (host: ResolvedHostWire, scheme?: string, fontSize?: number): ResolvedHostWire => ({
    ...host,
    terminal: {
      scheme: scheme === undefined ? { value: undefined, from: 'default' } : { value: scheme, from: { group: 'prod' } },
      fontSize: fontSize === undefined ? { value: undefined, from: 'default' } : { value: fontSize, from: 'host' },
    },
  });
  const optionsOf = (term: InstanceType<typeof xterm.FakeTerminal> | undefined) =>
    term?.options as { fontFamily?: string; fontSize?: number; lineHeight?: number; theme?: { background?: string } };

  it('draws with Preferences → Terminal, and the host’s scheme and size over them', async () => {
    terminalPrefs({ fontFamily: 'Fira Code', fontSize: 15, lineHeight: 1.2, colorScheme: 'nord' });
    useHostsStore.setState({ resolved: [withTerminal(resolvedHost('a', 'alpha'), 'red', 18)] });
    await mount();
    const options = optionsOf(lastTerminal());
    expect(options.fontFamily).toMatch(/^"Fira Code", /);
    expect(options.fontSize).toBe(18);
    expect(options.lineHeight).toBe(1.2);
    expect(options.theme?.background).toBe('#2b1215');
  });

  it('restyles an open terminal when the preferences or the host change', async () => {
    await mount();
    const term = lastTerminal();
    expect(optionsOf(term).fontSize).toBe(13);
    act(() => {
      terminalPrefs({ fontSize: 16, colorScheme: 'dracula' });
    });
    expect(optionsOf(term).fontSize).toBe(16);
    expect(optionsOf(term).theme?.background).toBe('#282a36');
    act(() => {
      useHostsStore.setState({
        resolved: [withTerminal(resolvedHost('a', 'alpha'), 'green'), resolvedHost('b', 'beta')],
      });
    });
    expect(optionsOf(term).theme?.background).toBe('#10241a');
    expect(optionsOf(term).fontSize).toBe(16);
    expect(lastTerminal()).toBe(term);
  });

  it('⌘+ / ⌘− / ⌘0 zoom the focused terminal only, and the shell never sees them', async () => {
    await mount();
    await splitOnSameHost();
    const [left, right] = xterm.FakeTerminal.instances;
    // jsdom's user agent is not a Mac's, so ⌘ here is Ctrl.
    const press = (key: string): KeyboardEvent => {
      const event = new KeyboardEvent('keydown', { key, ctrlKey: true, cancelable: true });
      act(() => {
        expect(right?.keyHandler?.(event)).toBe(false);
      });
      return event;
    };
    expect(press('=').defaultPrevented).toBe(true);
    expect(optionsOf(right).fontSize).toBe(14);
    expect(optionsOf(left).fontSize).toBe(13);
    press('-');
    press('-');
    expect(optionsOf(right).fontSize).toBe(12);
    press('0');
    expect(optionsOf(right).fontSize).toBe(13);
    expect(write).not.toHaveBeenCalled();
  });

  it('focus moves between panes, and Files acts on the focused one', async () => {
    await mount();
    await splitOnSameHost();
    const [left, right] = xterm.FakeTerminal.instances;
    const panes = screen.getAllByTestId('ssh-pane');
    expect(panes[1]?.dataset['focused']).toBe('true');
    const before = left?.focused ?? 0;
    await act(async () => {
      await runCommand('ssh.focusPaneLeft', {} as never);
    });
    expect(screen.getAllByTestId('ssh-pane')[0]?.dataset['focused']).toBe('true');
    expect(left?.focused).toBeGreaterThan(before);
    expect(right).toBeDefined();

    // A pane on another host, focused by a click, is the one Files opens.
    act(() => {
      useEditorsStore.setState({
        tabs: useEditorsStore
          .getState()
          .tabs.map((t) =>
            t.panes?.kind === 'split'
              ? { ...t, panes: { ...t.panes, b: { ...t.panes.b, hostId: 'b' } as PaneNode } }
              : t,
          ),
      });
    });
    await waitFor(() => {
      expect(screen.getAllByTestId('ssh-pane')).toHaveLength(2);
    });
    fireEvent.pointerDown(screen.getAllByTestId('ssh-pane')[1] as HTMLElement);
    fireEvent.click(screen.getByRole('button', { name: /^Files$/ }));
    expect(useEditorsStore.getState().activeId).toBe('ssh-files:b');
  });

  it('⌘W closes only the focused pane’s session; the sibling fills the tab, and the last pane closes it', async () => {
    await mount();
    await splitOnSameHost();
    await act(async () => {
      await runCommand('editor.closeTab', {} as never);
    });
    expect(close).toHaveBeenCalledWith({ sessionId: 's2' });
    expect(close).not.toHaveBeenCalledWith({ sessionId: 's1' });
    expect(tree().kind).toBe('pane');
    expect(screen.queryByTestId('ssh-pane-header')).toBeNull();
    await act(async () => {
      await runCommand('editor.closeTab', {} as never);
    });
    expect(useEditorsStore.getState().tabs).toEqual([]);
    expect(close).toHaveBeenCalledWith({ sessionId: 's1' });
  });

  it('a layout pane whose host left hosts.yaml says so, never connects, and Remove pane drops it', async () => {
    useHostsStore.setState({ loaded: true });
    connect.mockResolvedValueOnce(OPEN('s1'));
    const layout: LayoutWire = {
      id: 'L1',
      name: 'Prod',
      root: {
        kind: 'split',
        dir: 'row',
        ratio: 0.5,
        a: { kind: 'pane', host: 'a' },
        b: { kind: 'pane', host: 'gone' },
      },
    };
    useLayoutsStore.setState({ layouts: [layout], loaded: true });
    act(() => {
      openLayout(layout);
    });
    render(
      <TooltipPrimitive.Provider>
        <EditorArea />
      </TooltipPrimitive.Provider>,
    );
    await waitFor(() => {
      expect(sessionOn('a')?.state).toBe('open');
    });
    expect(screen.getByTestId('ssh-pane-missing').textContent).toContain('Host gone is no longer in hosts.yaml');
    expect(connect).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Prod')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Remove pane' }));
    expect(leaves(tree()).map((leaf) => leaf.hostId)).toEqual(['a']);
    expect(screen.queryByTestId('ssh-pane-missing')).toBeNull();
  });

  it('deleting the host of a connected pane keeps its terminal', async () => {
    useHostsStore.setState({ loaded: true });
    await mount();
    act(() => {
      useHostsStore.setState({ resolved: [resolvedHost('b', 'beta')] });
    });
    expect(screen.queryByTestId('ssh-pane-missing')).toBeNull();
    expect(screen.getByTestId('ssh-terminal')).toBeDefined();
  });

  it('Open in new tab opens a second tab for the same host', async () => {
    await mount();
    await act(async () => {
      await runCommand('ssh.openInNewTab', {} as never, 'a');
    });
    expect(useEditorsStore.getState().tabs.filter((t) => t.kind === 'ssh-terminal')).toHaveLength(2);
  });
});

describe('snippet suggestions', () => {
  const snippet = (over: Partial<SnippetListItemWire>): SnippetListItemWire => ({
    id: 'x',
    name: 'X',
    tags: [],
    firstLine: 'x',
    literalStart: 'x',
    variables: [],
    secrets: [],
    enter: true,
    confirm: false,
    lineCount: 1,
    revision: 'rev',
    ...over,
  });
  const TAIL = snippet({
    id: 'tail',
    name: 'Tail a service',
    firstLine: 'journalctl -u ${service} -n ${lines} -f',
    literalStart: 'journalctl -u ',
    variables: [{ name: 'service' }, { name: 'lines', default: '50' }],
  });
  const DISK = snippet({ id: 'disk', name: 'Disk', firstLine: 'df -h /', literalStart: 'df -h /' });

  /** An open session on host a, with the run dialog mounted as the shell mounts it. */
  async function mount(items: SnippetListItemWire[] = [TAIL, DISK]) {
    useSnippetsStore.setState({ snippets: items, loaded: true });
    connect.mockResolvedValueOnce(OPEN('s1'));
    act(() => {
      openTerminalFor('a');
    });
    render(
      <>
        <EditorArea />
        <SnippetRunDialog />
      </>,
    );
    await waitFor(() => {
      expect(sessionOn('a')?.state).toBe('open');
    });
    const term = lastTerminal();
    if (term === undefined) throw new Error('no terminal');
    return term;
  }
  /** Types and echoes, the way a shell with echo on answers keystrokes. */
  const typeIn = (term: InstanceType<typeof xterm.FakeTerminal>, text: string): void => {
    act(() => {
      term.type(text);
      term.echo(text);
    });
  };
  const ghost = () => screen.queryByTestId('snippet-ghost');
  const tab = () => new KeyboardEvent('keydown', { key: 'Tab', cancelable: true });

  it('shows the rest of the first line and the name after the cursor; the next key moves or removes it', async () => {
    const term = await mount();
    typeIn(term, 'jou');
    expect(ghost()?.textContent).toContain('rnalctl -u ${service} -n ${lines} -f');
    expect(ghost()?.textContent).toContain('Tail a service');
    expect(term.decorations.at(-1)?.options['x']).toBe(3);

    act(() => {
      term.type('r');
    });
    expect(ghost()).toBeNull();
    act(() => {
      term.echo('r');
    });
    expect(ghost()?.textContent).toContain('nalctl -u ${service}');
    expect(term.decorations.at(-1)?.options['x']).toBe(4);

    typeIn(term, 'x');
    expect(ghost()).toBeNull();
  });

  it('waits for the echo of the last key: an earlier echo does not place it early (#594)', async () => {
    const term = await mount();
    act(() => {
      term.type('j');
      term.type('o');
      term.type('u');
    });
    // The shell has echoed only the first two keys: the ghost would cover the third.
    act(() => {
      term.echo('jo');
    });
    expect(ghost()).toBeNull();
    act(() => {
      term.echo('u');
    });
    expect(ghost()?.textContent).toContain('rnalctl');
    expect(term.decorations.at(-1)?.options['x']).toBe(3);
    // Output that moves the cursor away hides it.
    act(() => {
      term.echo('\u0007 other output');
    });
    expect(ghost()).toBeNull();
  });

  it('Tab with a ghost opens the variables form, then types the rest without Enter', async () => {
    const term = await mount();
    typeIn(term, 'jou');
    const event = tab();
    let passed = true;
    act(() => {
      passed = term.keyHandler?.(event) ?? true;
    });
    // The shell never sees the Tab.
    expect(passed).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    expect(ghost()).toBeNull();

    fireEvent.change(screen.getByLabelText('service'), { target: { value: 'api' } });
    fireEvent.click(screen.getByRole('button', { name: 'Insert' }));
    await waitFor(() => {
      expect(runSnippet).toHaveBeenCalledTimes(1);
    });
    expect(runSnippet.mock.calls[0]?.[0]).toMatchObject({
      sessionId: 's1',
      snippetId: 'tail',
      values: { service: 'api', lines: '50' },
      enter: false,
      skip: 3,
    });
  });

  it('Tab on a snippet with nothing to ask types it at once', async () => {
    const term = await mount();
    typeIn(term, 'df ');
    act(() => {
      term.keyHandler?.(tab());
    });
    await waitFor(() => {
      expect(runSnippet).toHaveBeenCalledTimes(1);
    });
    expect(runSnippet.mock.calls[0]?.[0]).toMatchObject({ snippetId: 'disk', enter: false, skip: 3 });
    expect(screen.queryByTestId('snippet-run-dialog')).toBeNull();
  });

  it('Tab without a ghost goes to the shell', async () => {
    const term = await mount();
    typeIn(term, 'zz');
    expect(term.keyHandler?.(tab())).toBe(true);
    expect(runSnippet).not.toHaveBeenCalled();
  });

  it('confirm: true asks in the dialog first', async () => {
    const term = await mount([{ ...DISK, confirm: true }]);
    typeIn(term, 'df ');
    act(() => {
      term.keyHandler?.(tab());
    });
    expect(screen.getByTestId('snippet-run-dialog')).toBeTruthy();
    expect(runSnippet).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Insert' }));
    await waitFor(() => {
      expect(runSnippet).toHaveBeenCalledTimes(1);
    });
    expect(runSnippet.mock.calls[0]?.[0]).toMatchObject({ snippetId: 'disk', enter: false, skip: 3 });
  });

  it('a protected host asks in the dialog first', async () => {
    useHostsStore.setState({
      resolved: [
        {
          id: 'a',
          name: 'alpha',
          address: 'a.example',
          path: [],
          tags: [],
          protected: { value: true },
          ssh: { user: {}, port: { value: 22 }, auth: {}, jump: {} },
        } as unknown as ResolvedHostWire,
      ],
    });
    const term = await mount();
    typeIn(term, 'df ');
    act(() => {
      term.keyHandler?.(tab());
    });
    expect(screen.getByTestId('snippet-run-protected')).toBeTruthy();
    expect(runSnippet).not.toHaveBeenCalled();
  });

  it('a ghost drawn before an editor took the screen leaves Tab to the shell', async () => {
    const term = await mount();
    typeIn(term, 'jou');
    expect(ghost()).not.toBeNull();
    term.buffer.active.type = 'alternate';
    expect(term.keyHandler?.(tab())).toBe(true);
    expect(ghost()).toBeNull();
    expect(runSnippet).not.toHaveBeenCalled();
  });

  it('offers nothing on the alternate screen', async () => {
    const term = await mount();
    term.buffer.active.type = 'alternate';
    typeIn(term, 'jou');
    expect(ghost()).toBeNull();
    expect(term.keyHandler?.(tab())).toBe(true);
  });

  it('offers nothing while disconnected', () => {
    useSnippetsStore.setState({ snippets: [TAIL], loaded: true });
    connect.mockReturnValueOnce(new Promise(() => undefined));
    act(() => {
      openTerminalFor('a');
    });
    render(<EditorArea />);
    const term = lastTerminal();
    if (term === undefined) throw new Error('no terminal');
    typeIn(term, 'jou');
    expect(ghost()).toBeNull();
  });

  it('offers nothing while the pane broadcasts', async () => {
    const writeMany = vi.fn().mockResolvedValue({ ok: true, value: { skipped: [] } });
    installWirebenchApi({
      ssh: { connect, write, writeMany, resize, close, runSnippet, listSnippets, previewSnippet },
    });
    const term = await mount();
    act(() => {
      useBroadcastStore.setState({
        tabs: { [terminalTab()]: { on: true, ticked: new Set([paneIdOn('a') ?? '']), missed: 0 } },
      });
    });
    typeIn(term, 'jou');
    expect(ghost()).toBeNull();
    expect(writeMany).toHaveBeenCalled();
    act(() => {
      useBroadcastStore.setState({ tabs: {} });
    });
  });

  it('offers nothing with the preference off', async () => {
    usePreferencesStore.setState({
      preferences: {
        ...DEFAULT_PREFERENCES_WIRE,
        terminal: { ...DEFAULT_PREFERENCES_WIRE.terminal, snippetSuggestions: false },
      },
    });
    const term = await mount();
    typeIn(term, 'jou');
    expect(ghost()).toBeNull();
  });

  it('a paste makes the line unknown until Enter', async () => {
    const term = await mount();
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { getData: () => 'jou' } });
    act(() => {
      screen.getByTestId('ssh-terminal').dispatchEvent(event);
      // xterm's own paste listener turns it into data at once.
      term.type('jou');
      term.echo('jou');
    });
    expect(ghost()).toBeNull();
    typeIn(term, '\r');
    typeIn(term, 'jou');
    expect(ghost()).not.toBeNull();
  });

  it('⌘; opens the snippet picker over the terminal, the shell never sees it, and Escape gives the focus back', async () => {
    const term = await mount();
    resetCommands();
    registerSshCommands(vi.fn());
    // jsdom's user agent is not a Mac's, so ⌘; here is Ctrl+;.
    const chord = new KeyboardEvent('keydown', { key: ';', ctrlKey: true, cancelable: true });
    expect(term.keyHandler?.(chord)).toBe(false);
    expect(term.keyHandler?.(new KeyboardEvent('keydown', { key: ';' }))).toBe(true);
    await act(async () => {
      await runCommand('ssh.snippetPicker', {} as never);
    });
    const input = screen.getByTestId('snippet-picker-input');
    expect(screen.getByTestId('ssh-pane').contains(input)).toBe(true);
    const before = term.focused;
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByTestId('snippet-picker-input')).toBeNull();
    expect(term.focused).toBeGreaterThan(before);
  });
});
