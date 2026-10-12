import { beforeEach, describe, expect, it } from 'vitest';
import type { WorkspaceWire } from '../../src/shared/wire-base.js';
import {
  RECENT_KEY,
  RECENT_LIMIT,
  addRecent,
  lastConnectedOf,
  readRecent,
  recentHostIds,
  useRecentStore,
  writeRecent,
} from '../../src/renderer/features/ssh/recent-connections.js';
import type { RecentConnection } from '../../src/renderer/features/ssh/recent-connections.js';
import { useWorkspaceStore } from '../../src/renderer/state/workspace.js';

describe('addRecent', () => {
  it('puts the newest first and keeps one entry per host', () => {
    const one = addRecent([], { hostId: 'a', at: 1, outcome: 'connected' });
    const two = addRecent(one, { hostId: 'b', at: 2, outcome: 'failed' });
    const three = addRecent(two, { hostId: 'a', at: 3, outcome: 'failed' });
    expect(three).toEqual([
      { hostId: 'a', at: 3, outcome: 'failed' },
      { hostId: 'b', at: 2, outcome: 'failed' },
    ]);
  });

  it('drops the oldest past the limit', () => {
    let entries: readonly RecentConnection[] = [];
    for (let i = 0; i < RECENT_LIMIT + 3; i++) {
      entries = addRecent(entries, { hostId: `h${String(i)}`, at: i, outcome: 'connected' });
    }
    expect(entries).toHaveLength(RECENT_LIMIT);
    expect(entries[0]?.hostId).toBe(`h${String(RECENT_LIMIT + 2)}`);
  });
});

describe('storage', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('round-trips per workspace', () => {
    writeRecent('w1', [{ hostId: 'a', at: 5, outcome: 'connected' }]);
    writeRecent('w2', [{ hostId: 'b', at: 6, outcome: 'failed' }]);
    expect(readRecent('w1')).toEqual([{ hostId: 'a', at: 5, outcome: 'connected' }]);
    expect(readRecent('w2')).toEqual([{ hostId: 'b', at: 6, outcome: 'failed' }]);
  });

  it('skips malformed entries and survives garbage', () => {
    localStorage.setItem(
      RECENT_KEY,
      JSON.stringify({ w1: [{ hostId: 'a', at: 1, outcome: 'connected' }, { hostId: 2 }, 'x', { hostId: 'b' }] }),
    );
    expect(readRecent('w1')).toEqual([{ hostId: 'a', at: 1, outcome: 'connected' }]);
    localStorage.setItem(RECENT_KEY, '{nope');
    expect(readRecent('w1')).toEqual([]);
  });

  it('stores only the host id, the time and the outcome', () => {
    writeRecent('w1', [{ hostId: 'a', at: 1, outcome: 'connected', extra: 'secret' } as RecentConnection]);
    expect(localStorage.getItem(RECENT_KEY)).toBe('{"w1":[{"hostId":"a","at":1,"outcome":"connected"}]}');
  });
});

describe('derived', () => {
  const entries: readonly RecentConnection[] = [
    { hostId: 'gone', at: 4, outcome: 'connected' },
    { hostId: 'b', at: 3, outcome: 'failed' },
    { hostId: 'a', at: 2, outcome: 'connected' },
  ];

  it('recentHostIds lists known hosts newest first, deleted ones dropped', () => {
    expect(recentHostIds(entries, new Set(['a', 'b']))).toEqual(['b', 'a']);
  });

  it('lastConnectedOf maps each host to its last attempt time', () => {
    expect(lastConnectedOf(entries).get('a')).toBe(2);
    expect(lastConnectedOf(entries).get('c')).toBeUndefined();
  });
});

describe('useRecentStore', () => {
  beforeEach(() => {
    localStorage.clear();
    useRecentStore.setState({ version: 0 });
    useWorkspaceStore.setState({ workspace: { id: 'w1' } as WorkspaceWire });
  });

  it('records into the open workspace and clears it', () => {
    useRecentStore.getState().record('a', 'connected', 10);
    expect(readRecent('w1')).toEqual([{ hostId: 'a', at: 10, outcome: 'connected' }]);
    expect(useRecentStore.getState().version).toBe(1);
    useRecentStore.getState().clear();
    expect(readRecent('w1')).toEqual([]);
    expect(useRecentStore.getState().version).toBe(2);
  });

  it('adds to the stored list of whichever workspace is open', () => {
    writeRecent('w2', [{ hostId: 'z', at: 1, outcome: 'connected' }]);
    useRecentStore.getState().record('a', 'connected', 10);
    useWorkspaceStore.setState({ workspace: { id: 'w2' } as WorkspaceWire });
    useRecentStore.getState().record('b', 'failed', 11);
    expect(readRecent('w2').map((e) => e.hostId)).toEqual(['b', 'z']);
    expect(readRecent('w1').map((e) => e.hostId)).toEqual(['a']);
  });

  it('records nothing with no workspace open', () => {
    useWorkspaceStore.setState({ workspace: null });
    useRecentStore.getState().record('a', 'connected', 10);
    expect(localStorage.getItem(RECENT_KEY)).toBeNull();
  });
});
