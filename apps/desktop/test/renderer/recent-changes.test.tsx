import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RecentChanges, byDay } from '../../src/renderer/features/rest-api/recent-changes.js';
import { useSyncStore } from '../../src/renderer/state/sync.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import type { SyncApiHistoryWire, SyncLogEntryWire, SyncStatusWire } from '../../src/shared/wire-base.js';
import type { WirebenchApi } from '../../src/preload/build-api.js';

function entry(id: string, at: string, subject = `Commit ${id}`): SyncLogEntryWire {
  return { id, subject, author: 'Alice <alice@example.com>', at };
}

const STATUS: SyncStatusWire = {
  kind: 'git',
  gitAvailable: true,
  state: 'clean',
  ahead: 0,
  behind: 0,
  uncommitted: 0,
};

type ApiHistory = WirebenchApi['sync']['apiHistory'];
let apiHistory: ReturnType<typeof vi.fn<ApiHistory>>;

function answer(value: SyncApiHistoryWire): void {
  apiHistory.mockResolvedValue({ ok: true, value });
}

beforeEach(() => {
  apiHistory = vi.fn<ApiHistory>();
  installWirebenchApi({ sync: { apiHistory } });
  useSyncStore.setState({ status: STATUS });
});

afterEach(() => {
  cleanup();
});

describe('byDay', () => {
  it('groups commits by local day, keeping their order', () => {
    const days = byDay([
      entry('c', new Date(2026, 9, 24, 18, 4).toISOString()),
      entry('b', new Date(2026, 9, 24, 9, 0).toISOString()),
      entry('a', new Date(2026, 7, 28, 12, 8).toISOString()),
    ]);
    expect(days.map((day) => day.entries.map((one) => one.id))).toEqual([['c', 'b'], ['a']]);
    expect(days[0]?.day).toBe(new Date(2026, 9, 24).toLocaleDateString(undefined, { dateStyle: 'long' }));
  });

  it('splits at local midnight, not at UTC midnight', () => {
    const days = byDay([
      entry('late', new Date(2026, 9, 24, 0, 5).toISOString()),
      entry('early', new Date(2026, 9, 23, 23, 55).toISOString()),
    ]);
    expect(days).toHaveLength(2);
  });
});

describe('RecentChanges', () => {
  it('lists this API’s commits with time, author and subject', async () => {
    answer({ status: 'ok', entries: [entry('c1', '2026-10-24T16:04:00Z', 'Cards: issue a card')] });
    render(<RecentChanges apiId="api-1" />);

    const row = await screen.findByTestId('recent-changes-row');
    expect(row.textContent).toContain('Cards: issue a card');
    expect(row.textContent).toContain('Alice');
    expect(row.textContent).not.toContain('alice@example.com');
    expect(apiHistory).toHaveBeenCalledWith({ apiId: 'api-1', limit: 20 });
  });

  it('says why there is no history', async () => {
    answer({ status: 'unavailable', reason: 'no-history' });
    render(<RecentChanges apiId="api-1" />);
    expect((await screen.findByTestId('recent-changes-unavailable')).textContent).toBe(
      'No history: this project is not under version control.',
    );
    cleanup();

    answer({ status: 'unavailable', reason: 'outside-tree' });
    render(<RecentChanges apiId="api-1" />);
    expect((await screen.findByTestId('recent-changes-unavailable')).textContent).toBe(
      'No history: this project is outside the synced folder.',
    );
  });

  it('offers Show more when the first page is full, and asks for up to 100', async () => {
    answer({
      status: 'ok',
      entries: Array.from({ length: 20 }, (_, index) => entry(`c${String(index)}`, '2026-10-24T10:00:00Z')),
    });
    render(<RecentChanges apiId="api-1" />);

    fireEvent.click(await screen.findByTestId('recent-changes-more'));
    await waitFor(() => expect(apiHistory).toHaveBeenLastCalledWith({ apiId: 'api-1', limit: 100 }));
  });

  it('reads again when the sync status settles on a new state, not while it runs', async () => {
    answer({ status: 'ok', entries: [] });
    render(<RecentChanges apiId="api-1" />);
    await waitFor(() => expect(apiHistory).toHaveBeenCalledTimes(1));

    act(() => {
      useSyncStore.setState({ status: { ...STATUS, state: 'syncing' } });
    });
    expect(apiHistory).toHaveBeenCalledTimes(1);

    act(() => {
      useSyncStore.setState({ status: { ...STATUS, ahead: 1 } });
    });
    await waitFor(() => expect(apiHistory).toHaveBeenCalledTimes(2));
  });

  it('folds away', async () => {
    answer({ status: 'ok', entries: [entry('c1', '2026-10-24T10:00:00Z')] });
    render(<RecentChanges apiId="api-1" />);
    await screen.findByTestId('recent-changes-row');

    fireEvent.click(screen.getByRole('button', { name: 'Recent changes' }));
    expect(screen.queryByTestId('recent-changes-row')).toBeNull();
  });
});
