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
    disposed = false;
    constructor(options: Record<string, unknown>) {
      this.options = options;
      FakeTerminal.instances.push(this);
    }
    loadAddon(): void {}
    open(): void {}
    focus(): void {}
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
    onData() {
      return { dispose: () => undefined };
    }
    onBinary() {
      return { dispose: () => undefined };
    }
    dispose(): void {
      this.disposed = true;
    }
  }
  return { FakeTerminal };
});
vi.mock('@xterm/xterm', () => ({ Terminal: xterm.FakeTerminal }));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit(): void {}
  },
}));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }));

import { openTerminalFor } from '../../src/renderer/features/ssh/connect.js';
import { useHostsStore } from '../../src/renderer/features/ssh/hosts-store.js';
import { __dispatchForTest as dispatch, bytesToBase64 } from '../../src/renderer/features/ssh/terminal-session.js';
import { EditorArea } from '../../src/renderer/shell/editor-area.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { usePreferencesStore } from '../../src/renderer/state/preferences.js';
import { DEFAULT_PREFERENCES_WIRE } from '../../src/renderer/state/preferences-defaults.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

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

const preferencesUpdate = vi.fn();
const writeText = vi.fn();

beforeEach(() => {
  xterm.FakeTerminal.instances = [];
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
  for (const fn of [connect, write, resize, close]) fn.mockReset();
  close.mockResolvedValue({ ok: true, value: {} });
  installWirebenchApi({ ssh: { connect, write, resize, close }, preferences: { update: preferencesUpdate } });
  useEditorsStore.getState().reset();
  useHostsStore.setState({
    file: { version: 1, groups: [], hosts: [{ id: 'a', name: 'alpha', address: 'a.example', tags: [], ssh: {} }] },
    sessions: {},
    trustPrompt: null,
    connectFailed: {},
  });
});

afterEach(() => {
  cleanup();
  useEditorsStore.getState().reset();
});

/** The terminal the tab created most recently. */
const lastTerminal = () => xterm.FakeTerminal.instances.at(-1);

describe('the terminal tab', () => {
  it('survives switching tabs; only closing the tab closes the session', async () => {
    connect.mockResolvedValueOnce(OPEN('s1'));
    act(() => {
      openTerminalFor('a');
    });
    render(<EditorArea />);
    await waitFor(() => {
      expect(useHostsStore.getState().sessions['a']).toEqual({ sessionId: 's1', state: 'open' });
    });
    expect(connect).toHaveBeenCalledWith({ hostId: 'a', cols: 80, rows: 24 });

    act(() => {
      useEditorsStore.getState().showStart();
    });
    expect(screen.getByTestId('ssh-terminal').closest('[hidden]')).not.toBeNull();
    act(() => {
      useEditorsStore.getState().activate('ssh:a');
    });
    expect(screen.getByTestId('ssh-terminal').closest('[hidden]')).toBeNull();
    expect(close).not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(xterm.FakeTerminal.instances).toHaveLength(1);

    act(() => {
      useEditorsStore.getState().close('ssh:a');
    });
    expect(close).toHaveBeenCalledWith({ sessionId: 's1' });
    expect(useHostsStore.getState().sessions['a']).toBeUndefined();
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
      useHostsStore.getState().setSession('a', { sessionId: 's2', state: 'open' });
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
      expect(useHostsStore.getState().sessions['a']?.sessionId).toBe('s1');
    });
    act(() => {
      dispatch('ssh.exit', { sessionId: 's1', code: 0 });
      useHostsStore.getState().noteSessionState('s1', 'closed');
    });
    expect(await screen.findByText('Session ended (code 0)')).toBeDefined();
    expect(useEditorsStore.getState().tabs.map((t) => t.id)).toEqual(['ssh:a']);

    connect.mockResolvedValueOnce(OPEN('s3'));
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
    await waitFor(() => {
      expect(useHostsStore.getState().sessions['a']).toEqual({ sessionId: 's3', state: 'open' });
    });
    expect(close).toHaveBeenCalledWith({ sessionId: 's1' });
    expect(connect).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/Session ended/)).toBeNull();
  });

  it('a refused connect offers Reconnect, which connects again', async () => {
    connect.mockResolvedValueOnce({ ok: false, error: { code: 'ssh-auth-failed', message: 'nope' } });
    act(() => {
      openTerminalFor('a');
    });
    render(<EditorArea />);
    expect(await screen.findByText('Could not connect · see Problems')).toBeDefined();

    connect.mockResolvedValueOnce(OPEN('s1'));
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
    await waitFor(() => {
      expect(useHostsStore.getState().sessions['a']).toEqual({ sessionId: 's1', state: 'open' });
    });
    expect(connect).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/Could not connect/)).toBeNull();
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
    expect(screen.queryByText(/Could not connect/)).toBeNull();
    act(() => {
      useHostsStore.getState().cancelTrust();
    });
    expect(await screen.findByRole('button', { name: 'Reconnect' })).toBeDefined();
  });

  it('connecting again from the tree retries in the open tab', async () => {
    connect.mockResolvedValueOnce({ ok: false, error: { code: 'ssh-auth-failed', message: 'nope' } });
    act(() => {
      openTerminalFor('a');
    });
    render(<EditorArea />);
    await screen.findByText('Could not connect · see Problems');

    connect.mockResolvedValueOnce(OPEN('s1'));
    act(() => {
      openTerminalFor('a');
    });
    await waitFor(() => {
      expect(useHostsStore.getState().sessions['a']).toEqual({ sessionId: 's1', state: 'open' });
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
      useEditorsStore.getState().close('ssh:a');
    });
    expect(close).not.toHaveBeenCalled();
    resolve(OPEN('s9'));
    await waitFor(() => {
      expect(close).toHaveBeenCalledWith({ sessionId: 's9' });
    });
    expect(useHostsStore.getState().sessions['a']).toBeUndefined();
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
        expect(useHostsStore.getState().sessions['a']?.state).toBe('open');
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
        expect(useHostsStore.getState().sessions['a']?.state).toBe('open');
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
});
