/**
 * An event-stream REST send in History: the entry shows the recorded rows read-only under a summary
 * line, and a banner worded from the record itself when the transcript was cut.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HistoryEntryView } from '../../src/renderer/features/history/history-entry-view.js';
import { useHistoryStore } from '../../src/renderer/state/history.js';
import type { HistoryEntryWire } from '../../src/shared/wire-types.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

const { showToast } = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock('../../src/renderer/components/toast.js', () => ({ showToast, ToastViewport: () => null }));

vi.mock('@monaco-editor/react', async () => await import('../mocks/monaco-editor-react.js'));
vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));

type Sse = NonNullable<HistoryEntryWire['sse']>;

function sseEntry(sse: Partial<Sse> = {}): HistoryEntryWire {
  return {
    id: 'h-sse',
    kind: 'rest',
    method: 'GET',
    at: '2026-09-21T10:00:00.000Z',
    projectId: 'p1',
    requestName: 'Ticks',
    interfaceName: '',
    operationName: '',
    endpoint: 'https://api.test/ticks',
    soapVersion: 'none',
    durationMs: 5_000,
    ok: true,
    status: 200,
    request: { envelopeXml: '', headers: [] },
    sizeBytes: 100,
    sse: {
      rows: [
        { kind: 'event', index: 0, at: 5, size: 5, event: 'tick', data: '1', id: '1', lastEventId: '1' },
        { kind: 'comment', index: 1, at: 9, size: 2, text: 'ka' },
      ],
      counts: { events: 1, comments: 1, retries: 0, bytes: 7 },
      lastEventId: '1',
      endedBy: 'client',
      ...sse,
    },
  };
}

beforeEach(() => {
  installWirebenchApi();
});

afterEach(() => {
  cleanup();
});

describe('an event-stream entry in History', () => {
  it('shows a summary line and the rows, read-only, with no banner when nothing was cut', () => {
    useHistoryStore.setState({ entries: [sseEntry()], total: 1 });
    render(<HistoryEntryView historyId="h-sse" />);
    const line = screen.getByTestId('sse-history-status').textContent ?? '';
    expect(line).toContain('1 event');
    expect(line).toContain('last id 1');
    expect(line).toContain('stopped');
    expect(screen.getAllByTestId('sse-row')).toHaveLength(2);
    expect(screen.queryByTestId('sse-history-truncated')).toBeNull();
    expect(screen.queryByLabelText('History response body')).toBeNull();
  });

  it('says the stream ended on an error, in the summary line', () => {
    useHistoryStore.setState({ entries: [sseEntry({ endedBy: 'error', error: 'socket hang up' })], total: 1 });
    render(<HistoryEntryView historyId="h-sse" />);
    const line = screen.getByTestId('sse-history-status').textContent ?? '';
    expect(line).toContain('ended: socket hang up');
    expect(line).not.toContain('stopped');
  });

  it('says how many rows from the middle were not kept, from the record', () => {
    useHistoryStore.setState({ entries: [sseEntry({ truncated: true, omittedRows: 1234 })], total: 1 });
    render(<HistoryEntryView historyId="h-sse" />);
    expect(screen.getByTestId('sse-history-truncated').textContent).toBe(
      '1234 events from the middle of the stream were not kept.',
    );
    // The total counts the rows left out, not only the kept ones.
    expect(screen.getByTestId('sse-count').textContent).toBe('1236 rows');
  });

  it('mentions trimmed payloads', () => {
    useHistoryStore.setState({
      entries: [
        sseEntry({
          truncated: true,
          rows: [
            {
              kind: 'event',
              index: 0,
              at: 1,
              size: 9e6,
              event: 'big',
              data: '',
              lastEventId: '',
              payloadTruncated: true,
            },
          ],
        }),
      ],
      total: 1,
    });
    render(<HistoryEntryView historyId="h-sse" />);
    expect(screen.getByTestId('sse-history-truncated').textContent).toBe(
      'Some payloads were not kept either; their events show their size.',
    );
  });
});

describe('re-sending a gRPC entry from its tab', () => {
  function grpcEntry(): HistoryEntryWire {
    return { ...sseEntry(), id: 'h-grpc', kind: 'grpc', method: undefined, sse: undefined, requestName: 'SayHello' };
  }

  it('replays it through history.resendGrpc with its id', async () => {
    const resendGrpc = vi.fn().mockResolvedValue({ ok: true, value: {} });
    installWirebenchApi({ history: { resendGrpc } });
    useHistoryStore.setState({ entries: [grpcEntry()], total: 1 });
    render(<HistoryEntryView historyId="h-grpc" />);

    await userEvent.click(screen.getByRole('button', { name: 'Re-send' }));
    expect(resendGrpc).toHaveBeenCalledWith({ id: 'h-grpc' });
  });

  it('toasts the error message when the re-send fails', async () => {
    showToast.mockClear();
    const message = "The request this call was sent from no longer exists, so it can't be re-sent.";
    const resendGrpc = vi.fn().mockResolvedValue({ ok: false, error: { code: 'history-resend-orphan', message } });
    installWirebenchApi({ history: { resendGrpc } });
    useHistoryStore.setState({ entries: [grpcEntry()], total: 1 });
    render(<HistoryEntryView historyId="h-grpc" />);

    await userEvent.click(screen.getByRole('button', { name: 'Re-send' }));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(message));
  });

  it('toasts the error code when the failure has no message', async () => {
    showToast.mockClear();
    const resendGrpc = vi.fn().mockResolvedValue({ ok: false, error: { code: 'history-resend-orphan', message: '' } });
    installWirebenchApi({ history: { resendGrpc } });
    useHistoryStore.setState({ entries: [grpcEntry()], total: 1 });
    render(<HistoryEntryView historyId="h-grpc" />);

    await userEvent.click(screen.getByRole('button', { name: 'Re-send' }));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('history-resend-orphan'));
  });
});

describe('re-sending a REST entry from its tab', () => {
  function restEntry(): HistoryEntryWire {
    return { ...sseEntry(), id: 'h-rest', sse: undefined, requestName: 'Echo' };
  }

  it('replays it through history.resendRest with its id', async () => {
    const resendRest = vi.fn().mockResolvedValue({ ok: true, value: {} });
    installWirebenchApi({ history: { resendRest } });
    useHistoryStore.setState({ entries: [restEntry()], total: 1 });
    render(<HistoryEntryView historyId="h-rest" />);

    await userEvent.click(screen.getByRole('button', { name: 'Re-send' }));
    expect(resendRest).toHaveBeenCalledWith({ id: 'h-rest' });
  });

  it('toasts the error message when the re-send fails', async () => {
    showToast.mockClear();
    const message =
      'This entry was sent to another host (a redirect or another environment); re-send it from the request.';
    const resendRest = vi.fn().mockResolvedValue({ ok: false, error: { code: 'history-resend-origin', message } });
    installWirebenchApi({ history: { resendRest } });
    useHistoryStore.setState({ entries: [restEntry()], total: 1 });
    render(<HistoryEntryView historyId="h-rest" />);

    await userEvent.click(screen.getByRole('button', { name: 'Re-send' }));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(message));
    expect(showToast).not.toHaveBeenCalledWith('history-resend-origin');
  });

  it('offers no Re-send on an event-stream entry', () => {
    useHistoryStore.setState({ entries: [sseEntry()], total: 1 });
    render(<HistoryEntryView historyId="h-sse" />);
    expect(screen.queryByRole('button', { name: 'Re-send' })).toBeNull();
  });
});
