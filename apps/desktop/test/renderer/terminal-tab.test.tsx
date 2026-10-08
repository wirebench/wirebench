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

beforeEach(() => {
  xterm.FakeTerminal.instances = [];
  for (const fn of [connect, write, resize, close]) fn.mockReset();
  close.mockResolvedValue({ ok: true, value: {} });
  installWirebenchApi({ ssh: { connect, write, resize, close } });
  useEditorsStore.getState().reset();
  useHostsStore.setState({
    file: { version: 1, groups: [], hosts: [{ id: 'a', name: 'alpha', address: 'a.example', tags: [], ssh: {} }] },
    sessions: {},
    trustPrompt: null,
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
});
