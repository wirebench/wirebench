/**
 * The WebSocket composer, the connect strip and the session pane around them.
 *
 * What a user would notice going wrong: Send enabled on a closed session, a binary payload that
 * goes out when it is not hex or base64 (or a refusal that does not say why), a failed send that
 * throws the text away, `Mod+Enter` in the composer that also fires the editor's own shortcut, a
 * Disconnect that sends an illegal close code or an over-long reason, a status line that shows
 * parts the session did not have, or a clock that stops while the session is open.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WsComposer } from '../../src/renderer/features/ws-editor/composer.js';
import { WsConnectBar, wsStateLabel } from '../../src/renderer/features/ws-editor/connect-bar.js';
import {
  WsHandshakeView,
  WsResponsePane,
  WsStatusLine,
  wsStatusText,
} from '../../src/renderer/features/ws-editor/response-pane.js';
import type { WsExchangeState } from '../../src/renderer/state/exchanges.js';
import type { WsHandshakeWire } from '../../src/shared/wire-types.js';

vi.mock('@monaco-editor/react', async () => await import('../mocks/monaco-editor-react.js'));
vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function handshake(overrides: Partial<WsHandshakeWire> = {}): WsHandshakeWire {
  return {
    url: 'wss://chat.test/lobby',
    requestHeaders: { authorization: '••••••' },
    requestedSubprotocols: ['chat.v2'],
    status: 101,
    statusText: 'Switching Protocols',
    responseHeaders: { upgrade: 'websocket' },
    protocol: 'chat.v2',
    extensions: 'permessage-deflate',
    startedAt: '2026-09-19T08:30:00.000Z',
    durationMs: 12,
    ...overrides,
  };
}

function textbox(): HTMLTextAreaElement {
  return screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message to send' });
}

function sendButton(): HTMLButtonElement {
  return screen.getByTestId<HTMLButtonElement>('ws-composer-send');
}

describe('WsComposer', () => {
  it('disables Send unless the session is open', () => {
    const onSend = vi.fn();
    const { rerender } = render(<WsComposer open={false} onSend={onSend} />);
    fireEvent.change(textbox(), { target: { value: 'hello' } });
    expect(sendButton().disabled).toBe(true);
    rerender(<WsComposer open onSend={onSend} />);
    expect(sendButton().disabled).toBe(false);
  });

  it('sends text with property expansion on by default, and clears after a send', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(<WsComposer open onSend={onSend} />);
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: 'Expand properties' }).checked).toBe(true);
    fireEvent.change(textbox(), { target: { value: 'hi ${user}' } });
    fireEvent.click(sendButton());
    await waitFor(() => {
      expect(textbox().value).toBe('');
    });
    expect(onSend).toHaveBeenCalledWith({ format: 'text', content: 'hi ${user}', expand: true });
  });

  it('reads binary as hex or base64 and refuses anything else, saying why', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(<WsComposer open onSend={onSend} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Binary' }));

    fireEvent.change(textbox(), { target: { value: 'zz top' } });
    expect(sendButton().disabled).toBe(true);
    expect(screen.getByRole('alert').textContent).toBe('Not hex or base64.');

    fireEvent.change(textbox(), { target: { value: '0a ff' } });
    expect(sendButton().disabled).toBe(false);
    fireEvent.click(sendButton());
    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith({ format: 'binary', content: btoa('\x0a\xff'), expand: false });
    });
  });

  it('shows a failed send’s error inline and keeps the text', async () => {
    const onSend = vi.fn().mockResolvedValue('ws-session-closed: the connection is closed');
    render(<WsComposer open onSend={onSend} />);
    fireEvent.change(textbox(), { target: { value: 'keep me' } });
    fireEvent.click(sendButton());
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('the connection is closed');
    expect(textbox().value).toBe('keep me');
  });

  it('sends on Mod+Enter and stops the key there', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    const outer = vi.fn();
    render(
      <div onKeyDown={outer}>
        <WsComposer open onSend={onSend} />
      </div>,
    );
    fireEvent.change(textbox(), { target: { value: 'quick' } });
    fireEvent.keyDown(textbox(), { key: 'Enter', ctrlKey: true });
    await waitFor(() => {
      expect(onSend).toHaveBeenCalledTimes(1);
    });
    expect(outer).not.toHaveBeenCalled();
  });
});

describe('WsConnectBar', () => {
  const handlers = { onConnect: vi.fn(), onCancel: vi.fn(), onDisconnect: vi.fn() };

  it('shows the resolved URL with where it came from', () => {
    render(<WsConnectBar {...handlers} status="idle" url="wss://chat.test/lobby" urlSource="environment" />);
    expect(screen.getByTestId('ws-url').textContent).toBe('wss://chat.test/lobby');
    expect(screen.getByTestId('ws-url-source').textContent).toBe('environment');
  });

  it('offers Connect, Cancel or Disconnect by state, with the state chip', () => {
    const { rerender } = render(<WsConnectBar {...handlers} status="idle" />);
    expect(screen.getByTestId('ws-connect').textContent).toContain('Connect');
    expect(screen.queryByTestId('ws-state')).toBeNull();
    fireEvent.click(screen.getByTestId('ws-connect'));
    expect(handlers.onConnect).toHaveBeenCalled();

    rerender(<WsConnectBar {...handlers} status="connecting" />);
    expect(screen.getByTestId('ws-connect').textContent).toContain('Cancel');
    expect(screen.getByTestId('ws-state').textContent).toBe('connecting');
    fireEvent.click(screen.getByTestId('ws-connect'));
    expect(handlers.onCancel).toHaveBeenCalled();

    rerender(<WsConnectBar {...handlers} status="open" />);
    expect(screen.getByTestId('ws-connect').textContent).toContain('Disconnect');
    fireEvent.click(screen.getByTestId('ws-connect'));
    expect(handlers.onDisconnect).toHaveBeenCalledWith(1000, '');

    rerender(<WsConnectBar {...handlers} status="closed" closeCode={1000} />);
    expect(screen.getByTestId('ws-state').textContent).toBe('closed 1000');
    expect(screen.getByTestId('ws-connect').textContent).toContain('Connect');
    expect(wsStateLabel('error')).toBe('failed');
    expect(wsStateLabel('closing')).toBe('closing');
  });

  it('checks the close code and counts the reason in bytes', () => {
    const onDisconnect = vi.fn();
    render(<WsConnectBar {...handlers} onDisconnect={onDisconnect} status="open" />);
    fireEvent.click(screen.getByRole('button', { name: 'Close code and reason' }));
    const code = screen.getByRole<HTMLInputElement>('spinbutton', { name: 'Code' });
    expect(code.value).toBe('1000');

    fireEvent.change(code, { target: { value: '1001' } });
    expect(screen.getByText('1000, or 3000–4999')).toBeTruthy();
    expect(screen.getByTestId<HTMLButtonElement>('ws-connect').disabled).toBe(true);

    fireEvent.change(code, { target: { value: '4001' } });
    // 62 two-byte characters: 124 bytes, one past the limit, though only 62 characters.
    fireEvent.change(screen.getByRole('textbox', { name: 'Reason' }), { target: { value: 'é'.repeat(62) } });
    expect(screen.getByText('124 of 123 bytes')).toBeTruthy();
    expect(screen.getByTestId<HTMLButtonElement>('ws-connect').disabled).toBe(true);

    fireEvent.change(screen.getByRole('textbox', { name: 'Reason' }), { target: { value: 'bye' } });
    fireEvent.click(screen.getByTestId('ws-connect'));
    expect(onDisconnect).toHaveBeenCalledWith(4001, 'bye');
  });
});

describe('the status line', () => {
  it('reads every part, and leaves out the ones the session did not have', () => {
    expect(
      wsStatusText({
        status: 101,
        extensions: 'permessage-deflate',
        protocol: 'chat.v2',
        elapsedMs: 42_000,
        sent: 3,
        received: 17,
        bytes: 4198,
      }),
    ).toBe('101 · permessage-deflate · chat.v2 · 00:42 · ↑3 ↓17 · 4.1 KB');
    expect(wsStatusText({ status: 101, sent: 0, received: 0, bytes: 0 })).toBe('101 · ↑0 ↓0');
  });

  it('ticks the clock while the session is open', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-19T08:30:10.000Z'));
    const state: WsExchangeState = {
      status: 'open',
      sendId: 's1',
      live: {
        open: true,
        handshake: handshake(),
        counts: { sent: 1, received: 0, bytes: 5 },
        frames: [
          { index: 0, direction: 'sent', opcode: 'text', at: 1, size: 5, text: 'hello' },
          { index: 1, direction: 'received', opcode: 'ping', at: 2, size: 0 },
        ],
      },
    };
    render(<WsStatusLine state={state} />);
    expect(screen.getByTestId('ws-response-status').textContent).toBe(
      '101 · permessage-deflate · chat.v2 · 00:10 · ↑1 ↓0 · 5 B',
    );
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByTestId('ws-response-status').textContent).toContain('00:12');
    // The ticking line is not a live region: it would be re-announced every second.
    expect(screen.getByTestId('ws-response-status').getAttribute('role')).toBeNull();
  });

  it('announces connecting and failure, which change rarely', () => {
    const { rerender } = render(<WsStatusLine state={{ status: 'connecting', sendId: 's1' }} />);
    expect(screen.getByRole('status').textContent).toBe('Connecting…');
    rerender(
      <WsStatusLine state={{ status: 'error', sendId: 's1', error: { code: 'ws-handshake', message: 'refused' } }} />,
    );
    expect(screen.getByRole('status').textContent).toContain('refused');
  });
});

describe('the session pane', () => {
  it('shows the handshake head, or the asked-for headers with a note when there is no raw head', () => {
    const { rerender } = render(<WsHandshakeView handshake={handshake({ rawRequestHead: 'GET /lobby HTTP/1.1' })} />);
    expect(screen.getByTestId('ws-handshake').textContent).toContain('GET /lobby HTTP/1.1');
    rerender(<WsHandshakeView handshake={handshake()} />);
    expect(screen.getByTestId('ws-handshake').textContent).toContain('sec-websocket-*');
    expect(screen.getByRole('table', { name: 'Request headers' }).textContent).toContain('••••••');
    expect(screen.getByTestId('ws-handshake').textContent).toContain('101 Switching Protocols');
  });

  it('opens a selected frame under the timeline and offers the composer while open', () => {
    const state: WsExchangeState = {
      status: 'open',
      sendId: 's1',
      live: {
        open: true,
        handshake: handshake(),
        frames: [{ index: 0, direction: 'received', opcode: 'text', at: 1, size: 7, text: '{"a":1}' }],
      },
    };
    render(<WsResponsePane state={state} onSend={vi.fn()} />);
    expect(screen.getByTestId('ws-composer')).toBeTruthy();
    fireEvent.click(screen.getByTestId('ws-frame-row'));
    expect(screen.getByLabelText<HTMLTextAreaElement>('Frame payload').value).toBe('{\n  "a": 1\n}');
    fireEvent.click(screen.getByRole('tab', { name: 'TLS' }));
    expect(screen.getByText(/No TLS/)).toBeTruthy();
  });
});
