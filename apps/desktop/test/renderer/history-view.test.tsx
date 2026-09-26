import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HistoryView } from '../../src/renderer/features/history/history-view.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { useExchangesStore } from '../../src/renderer/state/exchanges.js';
import { useHistoryStore } from '../../src/renderer/state/history.js';
import { useWorkspaceStore } from '../../src/renderer/state/workspace.js';
import { workspaceWire } from '../helpers/workspace-wire.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { makeRestExchange } from '../mocks/wire-fixtures.js';
import type { HistoryEntryWire } from '../../src/shared/wire-types.js';

const { showToast } = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock('../../src/renderer/components/toast.js', () => ({ showToast, ToastViewport: () => null }));

function makeEntry(overrides: Partial<HistoryEntryWire> = {}): HistoryEntryWire {
  return {
    id: 'h-1',
    at: '2026-01-01T10:00:00.000Z',
    projectId: 'proj-1',
    requestName: 'Add',
    interfaceName: 'Calc',
    operationName: 'Add',
    endpoint: 'https://calc.test/soap',
    soapVersion: '1.1',
    durationMs: 5,
    ok: true,
    status: 200,
    request: { envelopeXml: '<Envelope>req</Envelope>', headers: [] },
    response: { envelopeXml: '<Envelope>res</Envelope>', rawHeaders: [], status: 200, statusText: 'OK' },
    sizeBytes: 10,
    ...overrides,
  };
}

describe('HistoryView', () => {
  beforeEach(() => {
    useHistoryStore.setState({ entries: [], total: 0, query: '', loading: false, projectId: undefined });
    useEditorsStore.setState({ tabs: [], activeId: undefined });
    installWirebenchApi();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    useWorkspaceStore.setState({ workspace: null });
  });

  it('declares its two columns on the grid and on every cell', () => {
    useHistoryStore.setState({ entries: [makeEntry()] });
    render(<HistoryView />);

    const grid = screen.getByRole('grid', { name: 'History' });
    expect(grid.getAttribute('aria-colcount')).toBe('2');
    expect(grid.getAttribute('aria-rowcount')).toBe('1');
    const cells = screen.getAllByRole('gridcell');
    expect(cells.map((cell) => cell.getAttribute('aria-colindex'))).toEqual(['1', '2']);
    // No selection model: rows are opened, re-sent or compared, never selected.
    expect(screen.getAllByRole('row').some((row) => row.hasAttribute('aria-selected'))).toBe(false);
  });

  it('invites a first send when there is no history', () => {
    render(<HistoryView />);
    expect(screen.getByText(/Sent requests appear here/)).toBeDefined();
  });

  it('renders one row per entry', () => {
    useHistoryStore.setState({
      entries: [makeEntry({ id: 'a' }), makeEntry({ id: 'b', requestName: 'Subtract' })],
      total: 2,
    });
    render(<HistoryView />);

    expect(screen.getAllByTestId('history-row')).toHaveLength(2);
    expect(screen.getByText('Subtract')).toBeDefined();
    expect(screen.getAllByText('200')).toHaveLength(2);
  });

  it('search filters via the store, debounced', async () => {
    vi.useFakeTimers();
    const list = vi.fn().mockResolvedValue({ ok: true, value: { entries: [], total: 0 } });
    installWirebenchApi({ history: { list } });
    render(<HistoryView />);

    const input = screen.getByLabelText('Search history');
    fireEvent.change(input, { target: { value: 'weather' } });
    expect(list).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(200);
    expect(list).toHaveBeenCalledWith({ query: 'weather' });
  });

  it('Open opens a history tab', async () => {
    useHistoryStore.setState({ entries: [makeEntry({ id: 'a' })], total: 1 });
    render(<HistoryView />);

    await userEvent.click(screen.getByRole('button', { name: 'Open Add' }));

    const { tabs, activeId } = useEditorsStore.getState();
    expect(tabs).toEqual([{ id: 'history:a', kind: 'history', title: 'Add', historyId: 'a' }]);
    expect(activeId).toBe('history:a');
  });

  it('Compare mode arms on the first row and opens a diff tab on the second', async () => {
    useHistoryStore.setState({
      entries: [makeEntry({ id: 'a', requestName: 'First' }), makeEntry({ id: 'b', requestName: 'Second' })],
      total: 2,
    });
    render(<HistoryView />);

    const compareButtons = screen.getAllByTitle('Compare…');
    await userEvent.click(compareButtons[0]!);
    expect(compareButtons[0]?.getAttribute('aria-pressed')).toBe('true');

    await userEvent.click(compareButtons[1]!);

    const { tabs, activeId } = useEditorsStore.getState();
    expect(tabs).toHaveLength(1);
    expect(tabs[0]?.kind).toBe('diff');
    expect(tabs[0]?.diff?.leftLabel).toContain('First');
    expect(tabs[0]?.diff?.rightLabel).toContain('Second');
    expect(activeId).toBe('diff');
  });

  describe('with several projects open', () => {
    beforeEach(() => {
      useWorkspaceStore.setState({
        workspace: workspaceWire({
          projects: [
            { id: 'proj-1', name: 'Calc Project', slug: 'calc', source: 'internal', dir: '/x', status: 'ready' },
            { id: 'proj-2', name: 'Weather Project', slug: 'weather', source: 'internal', dir: '/y', status: 'ready' },
          ],
        }),
      });
    });

    it('offers "All projects" plus one entry per open project, in workspace order', () => {
      render(<HistoryView />);

      const select = screen.getByTestId<HTMLSelectElement>('history-project-filter');
      expect(Array.from(select.options).map((option) => option.textContent)).toEqual([
        'All projects',
        'Calc Project',
        'Weather Project',
      ]);
    });

    it('shows entries merged newest-first across every open project, each tagged with its project', () => {
      useHistoryStore.setState({
        entries: [
          makeEntry({ id: 'a', projectId: 'proj-2', requestName: 'Forecast', at: '2026-01-01T10:00:02.000Z' }),
          makeEntry({ id: 'b', projectId: 'proj-1', requestName: 'Add', at: '2026-01-01T10:00:01.000Z' }),
        ],
        total: 2,
      });
      render(<HistoryView />);

      const rows = screen.getAllByTestId('history-row');
      expect(rows).toHaveLength(2);
      expect(rows[0]?.textContent).toContain('Forecast');
      expect(rows[0]?.textContent).toContain('Weather Project');
      expect(rows[1]?.textContent).toContain('Add');
      expect(rows[1]?.textContent).toContain('Calc Project');
    });

    it('calls history.list with the chosen project id when the filter changes', async () => {
      const list = vi.fn().mockResolvedValue({ ok: true, value: { entries: [], total: 0 } });
      installWirebenchApi({ history: { list } });
      render(<HistoryView />);

      fireEvent.change(screen.getByTestId('history-project-filter'), { target: { value: 'proj-2' } });
      await waitFor(() => expect(list).toHaveBeenCalledWith({ projectId: 'proj-2' }));

      fireEvent.change(screen.getByTestId('history-project-filter'), { target: { value: '' } });
      await waitFor(() => expect(list).toHaveBeenLastCalledWith({}));
    });

    it('re-send and compare keep working across projects', async () => {
      const resend = vi.fn().mockResolvedValue({ ok: true, value: {} });
      installWirebenchApi({ history: { resend } });
      useHistoryStore.setState({
        entries: [
          makeEntry({ id: 'a', projectId: 'proj-1', requestName: 'Add' }),
          makeEntry({ id: 'b', projectId: 'proj-2', requestName: 'Forecast' }),
        ],
        total: 2,
      });
      render(<HistoryView />);

      await userEvent.click(screen.getByRole('button', { name: 'Re-send Add' }));
      expect(resend).toHaveBeenCalledWith({ id: 'a' });

      const compareButtons = screen.getAllByTitle('Compare…');
      await userEvent.click(compareButtons[0]!);
      await userEvent.click(compareButtons[1]!);

      const { tabs } = useEditorsStore.getState();
      expect(tabs[0]?.kind).toBe('diff');
      expect(tabs[0]?.diff?.leftLabel).toContain('Add');
      expect(tabs[0]?.diff?.rightLabel).toContain('Forecast');
    });
  });
});

/**
 * The protocol column. A row has to say which kind of send it was: two requests may share a name,
 * and "Re-send" means something different for each.
 */
describe('HistoryView with REST entries', () => {
  beforeEach(() => {
    useHistoryStore.setState({ entries: [], total: 0, query: '', loading: false, projectId: undefined });
    useEditorsStore.setState({ tabs: [], activeId: undefined });
    installWirebenchApi();
  });

  afterEach(() => {
    cleanup();
  });

  it('badges a REST row with its method and a SOAP row with its version', () => {
    useHistoryStore.setState({
      entries: [
        makeEntry({ id: 'h-rest', kind: 'rest', method: 'POST', soapVersion: 'none', requestName: 'Create pet' }),
        makeEntry({ id: 'h-soap' }),
      ],
      total: 2,
    });
    render(<HistoryView />);

    expect(screen.getByTestId('method-badge').getAttribute('data-method')).toBe('POST');
    expect(screen.getByTestId('history-soap-version').textContent).toBe('SOAP 1.1');
  });

  it('reads an entry with no kind as SOAP, as entries recorded before REST existed are', () => {
    useHistoryStore.setState({ entries: [makeEntry()], total: 1 });
    render(<HistoryView />);

    expect(screen.queryByTestId('method-badge')).toBeNull();
    expect(screen.getByTestId('history-soap-version')).toBeTruthy();
  });

  describe('re-sending a gRPC row', () => {
    it('replays it through history.resendGrpc with its id', async () => {
      const resend = vi.fn();
      const resendGrpc = vi.fn().mockResolvedValue({ ok: true, value: {} });
      installWirebenchApi({ history: { resend, resendGrpc } });
      useHistoryStore.setState({ entries: [makeEntry({ id: 'g', kind: 'grpc', requestName: 'SayHello' })], total: 1 });
      render(<HistoryView />);

      await userEvent.click(screen.getByRole('button', { name: 'Re-send SayHello' }));
      expect(resendGrpc).toHaveBeenCalledWith({ id: 'g' });
      expect(resend).not.toHaveBeenCalled();
    });

    it('toasts the error code when the re-send fails', async () => {
      showToast.mockClear();
      const resendGrpc = vi
        .fn()
        .mockResolvedValue({ ok: false, error: { code: 'GRPC_REQUEST_GONE', message: 'gone' } });
      installWirebenchApi({ history: { resendGrpc } });
      useHistoryStore.setState({ entries: [makeEntry({ id: 'g', kind: 'grpc', requestName: 'SayHello' })], total: 1 });
      render(<HistoryView />);

      await userEvent.click(screen.getByRole('button', { name: 'Re-send SayHello' }));
      await waitFor(() => expect(showToast).toHaveBeenCalledWith('GRPC_REQUEST_GONE'));
    });
  });
});

/** A REST entry of request `r-1`: a GET that got a JSON 200. */
function restEntry(overrides: Partial<HistoryEntryWire> = {}): HistoryEntryWire {
  return makeEntry({
    kind: 'rest',
    method: 'GET',
    soapVersion: 'none',
    requestId: 'r-1',
    requestName: 'Pet',
    endpoint: 'https://api.test/pet/1',
    request: { envelopeXml: '', headers: [] },
    response: {
      envelopeXml: '{"id":1}',
      rawHeaders: [['content-type', 'application/json']],
      status: 200,
      statusText: 'OK',
    },
    ...overrides,
  });
}

describe('HistoryView re-sending and comparing REST rows', () => {
  beforeEach(() => {
    useHistoryStore.setState({ entries: [], total: 0, query: '', loading: false, projectId: undefined });
    useEditorsStore.setState({ tabs: [], activeId: undefined });
    installWirebenchApi();
  });

  afterEach(() => {
    cleanup();
    useExchangesStore.setState({ restByRequest: {}, byRequest: {} });
  });

  it('re-sends a REST row through history.resendRest, and offers no ↻ on a streamed one', async () => {
    const resend = vi.fn();
    const resendRest = vi.fn().mockResolvedValue({ ok: true, value: {} });
    installWirebenchApi({ history: { resend, resendRest } });
    const streamed = restEntry({
      id: 's',
      requestName: 'Ticks',
      sse: { rows: [], counts: { events: 0, comments: 0, retries: 0, bytes: 0 }, lastEventId: '', endedBy: 'server' },
    });
    useHistoryStore.setState({ entries: [restEntry({ id: 'r' }), streamed], total: 2 });
    render(<HistoryView />);

    await userEvent.click(screen.getByRole('button', { name: 'Re-send Pet' }));
    expect(resendRest).toHaveBeenCalledWith({ id: 'r' });
    expect(resend).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Re-send Ticks' })).toBeNull();
  });

  it('opens Response and Request texts for two REST rows, and one body diff for a mixed pair', async () => {
    useHistoryStore.setState({
      entries: [restEntry({ id: 'a' }), restEntry({ id: 'b', status: 404 }), makeEntry({ id: 'c' })],
      total: 3,
    });
    render(<HistoryView />);
    const compareButtons = screen.getAllByTitle('Compare…');

    await userEvent.click(compareButtons[0]!);
    await userEvent.click(compareButtons[1]!);
    const rest = useEditorsStore.getState().tabs[0]?.diff?.rest;
    expect(rest?.response.left.split('\n')[0]).toBe('200 OK');
    expect(rest?.request.left.split('\n')[0]).toBe('GET https://api.test/pet/1');

    await userEvent.click(compareButtons[0]!);
    await userEvent.click(compareButtons[2]!);
    const mixed = useEditorsStore.getState().tabs[0]?.diff;
    expect(mixed?.rest).toBeUndefined();
    expect(mixed?.leftXml).toBe('{"id":1}');
    expect(mixed?.rightXml).toBe('<Envelope>res</Envelope>');
  });

  it('compares a REST row with its request’s latest exchange', async () => {
    useExchangesStore.setState({
      restByRequest: { 'r-1': { status: 'done', sendId: 'send-1', exchange: makeRestExchange() } },
    });
    useHistoryStore.setState({ entries: [restEntry({ id: 'a' })], total: 1 });
    render(<HistoryView />);

    await userEvent.click(screen.getByRole('button', { name: 'Compare Pet with current' }));

    const diff = useEditorsStore.getState().tabs[0]?.diff;
    expect(diff?.rightLabel).toBe('Current');
    expect(diff?.rest?.request.right.split('\n')[0]).toBe('GET https://api.test/pet/1');
    expect(diff?.rest?.response.right.split('\n')[0]).toBe('200 OK');
  });
});
