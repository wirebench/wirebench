/**
 * A WebSocket session in History: the row says WS, and the entry shows the same status line the
 * editor does and a read-only timeline, with a banner when the transcript was capped.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { HistoryEntryView } from '../../src/renderer/features/history/history-entry-view.js';
import { HistoryView } from '../../src/renderer/features/history/history-view.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { useHistoryStore } from '../../src/renderer/state/history.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import type { HistoryEntryWire } from '../../src/shared/wire-types.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { wsRequestWire } from '../helpers/wire-defaults.js';

vi.mock('@monaco-editor/react', async () => await import('../mocks/monaco-editor-react.js'));
vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));

function wsEntry(ws: Partial<NonNullable<HistoryEntryWire['ws']>> = {}): HistoryEntryWire {
  return {
    id: 'h-ws',
    kind: 'websocket',
    at: '2026-09-19T10:00:00.000Z',
    projectId: 'p1',
    requestId: 'ws-1',
    requestName: 'Lobby',
    interfaceName: '',
    operationName: '',
    endpoint: 'wss://chat.test/lobby',
    soapVersion: 'none',
    durationMs: 42_000,
    ok: true,
    status: 101,
    request: { envelopeXml: '', headers: [] },
    sizeBytes: 4198,
    ws: {
      url: 'wss://chat.test/lobby',
      status: 101,
      protocol: 'chat.v2',
      closeCode: 1000,
      closeReason: '',
      closedBy: 'client',
      counts: { sent: 3, received: 17, bytesSent: 98, bytesReceived: 4100 },
      frames: [
        { index: 0, direction: 'sent', opcode: 'text', at: 5, size: 5, text: 'hello' },
        { index: 1, direction: 'received', opcode: 'text', at: 9, size: 7, text: 'welcome' },
      ],
      ...ws,
    },
  };
}

beforeEach(() => {
  installWirebenchApi();
  useEditorsStore.setState({ tabs: [], activeId: undefined });
  useProjectStore.setState({ wsRequests: { 'ws-1': wsRequestWire() } });
});

afterEach(() => {
  cleanup();
});

describe('a WebSocket entry in History', () => {
  it('marks its row WS', () => {
    useHistoryStore.setState({ entries: [wsEntry()], total: 1 });
    render(<HistoryView />);
    expect(screen.getByTestId('history-ws-badge').textContent).toBe('WS');
    // No ↻: a session is not replayed from History.
    expect(screen.queryByRole('button', { name: 'Re-send Lobby' })).toBeNull();
  });

  it('shows the status line and a read-only timeline, without a composer or Re-send', () => {
    useHistoryStore.setState({ entries: [wsEntry()], total: 1 });
    render(<HistoryEntryView historyId="h-ws" />);

    expect(screen.getByTestId('ws-response-status').textContent).toBe('101 · chat.v2 · 00:42 · ↑3 ↓17 · 4.1 KB');
    expect(screen.getAllByTestId('ws-frame-row')).toHaveLength(2);
    expect(screen.queryByTestId('ws-composer')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Re-send' })).toBeNull();
    expect(screen.queryByTestId('ws-history-truncated')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Go to request' }));
    expect(useEditorsStore.getState().activeId).toBe('ws:ws-1');
  });

  it('says how much of a capped transcript was left out', () => {
    useHistoryStore.setState({ entries: [wsEntry({ truncated: true, omittedFrames: 1234 })], total: 1 });
    render(<HistoryEntryView historyId="h-ws" />);
    expect(screen.getByTestId('ws-history-truncated').textContent).toBe(
      '1234 frames from the middle of the session were not kept.',
    );
  });

  it('mentions trimmed payloads, alone or beside omitted frames', () => {
    const trimmed = {
      index: 2,
      direction: 'received' as const,
      opcode: 'text' as const,
      at: 20,
      size: 9e6,
      payloadTruncated: true,
    };
    useHistoryStore.setState({
      entries: [wsEntry({ truncated: true, omittedFrames: 0, frames: [trimmed] })],
      total: 1,
    });
    render(<HistoryEntryView historyId="h-ws" />);
    expect(screen.getByTestId('ws-history-truncated').textContent).toBe(
      'Some payloads were not kept either; their frames show their size.',
    );
  });
});

describe('re-send in History is SOAP only', () => {
  it('offers ↻ on a SOAP row (or one with no kind) and not on REST, gRPC or WebSocket rows', () => {
    const base = wsEntry();
    const soap = { ...base, id: 's', kind: 'soap' as const, requestName: 'Soap', ws: undefined };
    const legacy = { ...base, id: 'l', kind: undefined, requestName: 'Legacy', ws: undefined };
    const rest = { ...base, id: 'r', kind: 'rest' as const, requestName: 'Rest', ws: undefined };
    const grpc = { ...base, id: 'g', kind: 'grpc' as const, requestName: 'Grpc', ws: undefined };
    useHistoryStore.setState({ entries: [soap, legacy, rest, grpc, base], total: 5 });
    render(<HistoryView />);
    expect(screen.getByRole('button', { name: 'Re-send Soap' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Re-send Legacy' })).toBeTruthy();
    for (const name of ['Rest', 'Grpc', 'Lobby']) {
      expect(screen.queryByRole('button', { name: `Re-send ${name}` })).toBeNull();
    }
  });

  it('offers Re-send in a SOAP entry’s tab and not in a REST one’s', () => {
    const base = wsEntry();
    useHistoryStore.setState({
      entries: [
        { ...base, id: 's', kind: 'soap', ws: undefined },
        { ...base, id: 'r', kind: 'rest', ws: undefined },
      ],
      total: 2,
    });
    const { unmount } = render(<HistoryEntryView historyId="s" />);
    expect(screen.getByRole('button', { name: 'Re-send' })).toBeTruthy();
    unmount();
    render(<HistoryEntryView historyId="r" />);
    expect(screen.queryByRole('button', { name: 'Re-send' })).toBeNull();
  });
});
