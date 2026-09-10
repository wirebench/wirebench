import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useHistoryStore } from '../../src/renderer/state/history.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import type { HistoryEntryWire } from '../../src/shared/wire-types.js';

function makeEntry(overrides: Partial<HistoryEntryWire> = {}): HistoryEntryWire {
  return {
    id: 'h-1',
    at: '2026-01-01T00:00:00.000Z',
    projectId: 'proj-1',
    requestName: 'Add',
    interfaceName: 'Calc',
    operationName: 'Add',
    endpoint: 'http://dev.test/soap',
    soapVersion: '1.1',
    durationMs: 5,
    ok: true,
    status: 200,
    request: { envelopeXml: '<Envelope/>', headers: [] },
    sizeBytes: 10,
    ...overrides,
  };
}

describe('useHistoryStore', () => {
  beforeEach(() => {
    useHistoryStore.setState({ entries: [], total: 0, query: '', loading: false });
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('load populates entries and total from history.list', async () => {
    const entries = [makeEntry({ id: 'a' }), makeEntry({ id: 'b' })];
    installWirebenchApi({
      history: { list: vi.fn().mockResolvedValue({ ok: true, value: { entries, total: 2 } }) },
    });

    await useHistoryStore.getState().load();

    expect(useHistoryStore.getState().entries).toEqual(entries);
    expect(useHistoryStore.getState().total).toBe(2);
  });

  it('search sets the query immediately and reloads after the debounce', async () => {
    vi.useFakeTimers();
    const list = vi.fn().mockResolvedValue({ ok: true, value: { entries: [], total: 0 } });
    installWirebenchApi({ history: { list } });

    useHistoryStore.getState().search('weather');
    expect(useHistoryStore.getState().query).toBe('weather');
    expect(list).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(200);
    expect(list).toHaveBeenCalledWith({ query: 'weather' });
  });

  it('clear empties the store on success', async () => {
    useHistoryStore.setState({ entries: [makeEntry()], total: 1 });
    installWirebenchApi({ history: { clear: vi.fn().mockResolvedValue({ ok: true, value: { cleared: 1 } }) } });

    await useHistoryStore.getState().clear();

    expect(useHistoryStore.getState().entries).toEqual([]);
    expect(useHistoryStore.getState().total).toBe(0);
  });

  it('onAppended prepends an entry that matches the current query', () => {
    useHistoryStore.setState({ entries: [makeEntry({ id: 'old' })], total: 1, query: 'add' });

    useHistoryStore.getState().onAppended(makeEntry({ id: 'new', requestName: 'Add again' }));

    const { entries, total } = useHistoryStore.getState();
    expect(entries.map((e) => e.id)).toEqual(['new', 'old']);
    expect(total).toBe(2);
  });

  it('onAppended ignores an entry that does not match the current query', () => {
    useHistoryStore.setState({ entries: [], total: 0, query: 'weather' });

    useHistoryStore.getState().onAppended(makeEntry({ id: 'new', requestName: 'Add' }));

    expect(useHistoryStore.getState().entries).toEqual([]);
  });
});
