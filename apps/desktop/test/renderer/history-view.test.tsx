import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HistoryView } from '../../src/renderer/features/history/history-view.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { useHistoryStore } from '../../src/renderer/state/history.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import type { HistoryEntryWire } from '../../src/shared/wire-types.js';

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
    useHistoryStore.setState({ entries: [], total: 0, query: '', loading: false });
    useEditorsStore.setState({ tabs: [], activeId: undefined });
    installWirebenchApi();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
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
});
