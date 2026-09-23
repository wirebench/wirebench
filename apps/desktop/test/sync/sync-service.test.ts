// @vitest-environment node
/**
 * `SyncService` against a scripted in-memory backend and vitest fake timers: no git, no disk.
 * Every backend method records its call, counts how many run at once (the queue must keep that
 * at one), and answers from a small script the test sets up.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitShareSettings, TreeChange } from '@wirebench/engine';
import { commitMessage, DEFAULT_GIT_SHARE_SETTINGS, isWirebenchError, WirebenchError } from '@wirebench/engine';
import type { SyncBackend } from '../../src/main/sync/backend.js';
import { SyncService } from '../../src/main/sync/sync-service.js';
import type { SyncServiceDeps } from '../../src/main/sync/sync-service.js';
import type { SyncConflictWire, SyncLogEntryWire, SyncStatusWire } from '../../src/main/sync/types.js';

const REMOTE = 'https://example.test/team.git';

function status(overrides: Partial<SyncStatusWire> = {}): SyncStatusWire {
  return {
    kind: 'git',
    gitAvailable: true,
    state: 'clean',
    ahead: 0,
    behind: 0,
    uncommitted: 0,
    remote: REMOTE,
    branch: 'main',
    ...overrides,
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const offline = (): WirebenchError => new WirebenchError('git-offline', 'The remote could not be reached.');

class ScriptedBackend implements SyncBackend {
  readonly kind = 'git' as const;
  readonly calls: string[] = [];
  readonly commits: string[] = [];
  active = 0;
  maxActive = 0;
  current: SyncStatusWire = status();
  identityValue: { name: string; email: string } | undefined = { name: 'Ada', email: 'ada@example.test' };
  changes: TreeChange[] = [];
  /** Consumed one per call; when empty the call succeeds with `current`. */
  fetchScript: (() => Promise<void>)[] = [];
  pushScript: (() => Promise<void>)[] = [];
  mergeResult: { conflicts: SyncConflictWire[]; changedPaths: string[] } = { conflicts: [], changedPaths: [] };
  conflictList: SyncConflictWire[] = [];
  /** What `finishMerge()` reports the merge commit brought in. */
  mergeChanged: string[] = [];

  private async track<T>(name: string, body: () => Promise<T> | T): Promise<T> {
    this.calls.push(name);
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      await Promise.resolve();
      return await body();
    } finally {
      this.active -= 1;
    }
  }

  probe(): Promise<SyncStatusWire> {
    return this.track('probe', () => this.current);
  }

  fetch(): Promise<SyncStatusWire> {
    return this.track('fetch', async () => {
      await this.fetchScript.shift()?.();
      return this.current;
    });
  }

  merge(): Promise<{ conflicts: SyncConflictWire[]; changedPaths: string[] }> {
    return this.track('merge', () => {
      if (this.mergeResult.conflicts.length > 0) {
        this.conflictList = [...this.mergeResult.conflicts];
        this.current = { ...this.current, state: 'conflict' };
      }
      return this.mergeResult;
    });
  }

  commit(message: string): Promise<{ committed: boolean }> {
    return this.track('commit', () => {
      this.commits.push(message);
      const committed = this.changes.length > 0;
      this.changes = [];
      this.current = { ...this.current, uncommitted: 0, ahead: this.current.ahead + (committed ? 1 : 0) };
      return { committed };
    });
  }

  push(): Promise<SyncStatusWire> {
    return this.track('push', async () => {
      await this.pushScript.shift()?.();
      this.current = { ...this.current, ahead: 0 };
      return this.current;
    });
  }

  conflicts(): Promise<SyncConflictWire[]> {
    return this.track('conflicts', () => [...this.conflictList]);
  }

  resolve(path: string): Promise<void> {
    return this.track('resolve', () => {
      this.conflictList = this.conflictList.filter((conflict) => conflict.path !== path);
    });
  }

  finishMerge(): Promise<{ changedPaths: string[] }> {
    return this.track('finishMerge', () => {
      // Like git: only the merge is committed; saves left uncommitted stay in `changes`.
      this.current = { ...this.current, state: 'clean', uncommitted: this.changes.length };
      return { changedPaths: [...this.mergeChanged] };
    });
  }

  abortMerge(): Promise<void> {
    return this.track('abortMerge', () => {
      this.conflictList = [];
      this.current = { ...this.current, state: 'clean' };
    });
  }

  log(): Promise<SyncLogEntryWire[]> {
    return this.track('log', () => []);
  }

  changedPaths(): Promise<TreeChange[]> {
    return this.track('changedPaths', () => [...this.changes]);
  }

  identity(): Promise<{ name: string; email: string } | undefined> {
    return this.track('identity', () => this.identityValue);
  }

  setIdentity(name: string, email: string): Promise<void> {
    return this.track('setIdentity', () => {
      this.identityValue = { name, email };
    });
  }

  subscribeRemote(): () => void {
    return () => {};
  }
}

interface Harness {
  backend: ScriptedBackend;
  service: SyncService;
  settings: GitShareSettings;
  statuses: SyncStatusWire[];
  pulled: string[][];
  conflicts: SyncConflictWire[][];
  identityNeeded: number;
}

function harness(settings: Partial<GitShareSettings> = {}, deps: Partial<SyncServiceDeps> = {}): Harness {
  const backend = new ScriptedBackend();
  const h: Harness = {
    backend,
    service: undefined as unknown as SyncService,
    settings: { ...DEFAULT_GIT_SHARE_SETTINGS, ...settings },
    statuses: [],
    pulled: [],
    conflicts: [],
    identityNeeded: 0,
  };
  h.service = new SyncService({
    backend,
    settings: () => h.settings,
    onStatus: (next) => h.statuses.push(next),
    onPulled: (paths) => {
      h.pulled.push([...paths]);
      return Promise.resolve();
    },
    onConflict: (list) => h.conflicts.push([...list]),
    onIdentityNeeded: () => {
      h.identityNeeded += 1;
    },
    ...deps,
  });
  return h;
}

const requestChange: TreeChange = {
  path: 'projects/calc/interfaces/Calc/operations/Add/Request-1.request.yaml',
  status: 'modified',
};

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('SyncService — queue', () => {
  it('runs backend operations one at a time, in call order', async () => {
    const { backend, service } = harness({ autoFetchSeconds: 0 });
    const gate = deferred();
    backend.fetchScript.push(() => gate.promise);

    const order: string[] = [];
    const fetched = service.fetch().then(() => order.push('fetch'));
    const pushed = service.push().then(() => order.push('push'));
    const logged = service.log(5).then(() => order.push('log'));

    await vi.advanceTimersByTimeAsync(0);
    expect(backend.calls).toEqual(['fetch']);
    expect(service.status().state).toBe('syncing');

    gate.resolve();
    await Promise.all([fetched, pushed, logged]);
    expect(order).toEqual(['fetch', 'push', 'log']);
    expect(backend.calls.indexOf('push')).toBeGreaterThan(backend.calls.indexOf('fetch'));
    expect(backend.calls.at(-1)).toBe('log');
    expect(backend.maxActive).toBe(1);
    expect(service.status().state).not.toBe('syncing');
  });

  it('starts no queued operation after stop(); the one already running finishes', async () => {
    const { backend, service, statuses } = harness({ autoFetchSeconds: 0 });
    const gate = deferred();
    backend.fetchScript.push(() => gate.promise);

    const first = service.fetch();
    // Rejection handlers attached up front, so the queued rejections are never unhandled.
    const second = rejectionOf(service.push());
    const third = rejectionOf(service.log(1));
    await vi.advanceTimersByTimeAsync(0);
    expect(backend.calls).toEqual(['fetch']);

    service.stop();
    const emittedBeforeRelease = statuses.length;
    gate.resolve();

    await expect(first).resolves.toMatchObject({ state: 'clean' });
    for (const error of [await second, await third]) {
      expect(isWirebenchError(error) && error.code).toBe('sync-stopped');
    }
    expect(backend.calls).toEqual(['fetch']);
    // Only the running fetch's closing status; nothing for the two that never started.
    expect(statuses.length).toBe(emittedBeforeRelease + 1);
  });

  it('returns the post-op status and emits it', async () => {
    const { backend, service, statuses } = harness({ autoFetchSeconds: 0 });
    backend.current = status({ behind: 2, state: 'behind' });
    const result = await service.fetch();
    expect(result).toMatchObject({ state: 'behind', behind: 2 });
    expect(statuses.at(-1)).toEqual(result);
    expect(statuses.some((emitted) => emitted.state === 'syncing')).toBe(true);
  });

  it('records a failure in the status and rethrows it; the next op still runs', async () => {
    const { backend, service, statuses } = harness({ autoFetchSeconds: 0 });
    backend.fetchScript.push(() =>
      Promise.reject(new WirebenchError('git-auth-failed', 'The remote refused your credentials.')),
    );
    const error = await rejectionOf(service.fetch());
    expect(isWirebenchError(error) && error.code).toBe('git-auth-failed');
    expect(statuses.at(-1)).toMatchObject({ state: 'error', error: { code: 'git-auth-failed' } });

    const next = await service.fetch();
    expect(next.state).toBe('clean');
    expect(next.error).toBeUndefined();
  });
});

describe('SyncService — start', () => {
  it('commits pre-existing changes with a generated message, then fetches', async () => {
    const { backend, service } = harness({ autoFetchSeconds: 0 });
    backend.current = status({ uncommitted: 1 });
    backend.changes = [requestChange];

    await service.start();

    expect(backend.commits).toEqual([commitMessage([requestChange])]);
    expect(backend.commits[0]).toMatch(/^Update request Request-1 in calc/);
    expect(backend.calls).toContain('fetch');
    expect(backend.calls.indexOf('fetch')).toBeGreaterThan(backend.calls.indexOf('commit'));
  });

  it('pushes the catch-up commit after fetching when pushOnSave is on', async () => {
    const { backend, service } = harness({ autoFetchSeconds: 0 });
    backend.current = status({ uncommitted: 1 });
    backend.changes = [requestChange];

    await service.start();

    expect(backend.calls.indexOf('push')).toBeGreaterThan(backend.calls.indexOf('fetch'));
    expect(service.status()).toMatchObject({ ahead: 0, uncommitted: 0 });
  });

  it('pushes commits an earlier session left unpushed', async () => {
    const { backend, service } = harness({ autoFetchSeconds: 0 });
    backend.current = status({ state: 'ahead', ahead: 2 });

    await service.start();

    expect(backend.calls).toContain('push');
    expect(backend.calls).not.toContain('commit');
    expect(service.status().ahead).toBe(0);
  });

  it('does not push on start when pushOnSave is off', async () => {
    const { backend, service } = harness({ autoFetchSeconds: 0, pushOnSave: false });
    backend.current = status({ uncommitted: 1 });
    backend.changes = [requestChange];

    await service.start();

    expect(backend.calls).toContain('commit');
    expect(backend.calls).not.toContain('push');
    expect(service.status().ahead).toBe(1);
  });

  it('neither pushes nor merges on start when the remote moved on too', async () => {
    const { backend, service } = harness({ autoFetchSeconds: 0 });
    backend.current = status({ uncommitted: 1 });
    backend.changes = [requestChange];
    backend.fetchScript.push(() => {
      backend.current = { ...backend.current, state: 'diverged', behind: 1 };
      return Promise.resolve();
    });

    await service.start();

    expect(backend.calls).not.toContain('push');
    expect(backend.calls).not.toContain('merge');
    expect(service.status()).toMatchObject({ ahead: 1, behind: 1 });
  });

  it('a push rejected on start keeps the commit ahead, without merging or an error', async () => {
    const { backend, service } = harness({ autoFetchSeconds: 0 });
    backend.current = status({ state: 'ahead', ahead: 1 });
    backend.pushScript.push(() =>
      Promise.reject(
        new WirebenchError('git-failed', 'git push failed.', {
          details: { stderr: ' ! [rejected]        HEAD -> main (fetch first)' },
        }),
      ),
    );

    await service.start();

    expect(backend.calls).not.toContain('merge');
    expect(service.status().ahead).toBe(1);
    expect(service.status().state).not.toBe('error');
  });

  it('does not commit on start when commitOnSave is off, and skips fetch without a remote', async () => {
    const { backend, service } = harness({ autoFetchSeconds: 0, commitOnSave: false });
    backend.current = status({ uncommitted: 1, remote: undefined });
    backend.changes = [requestChange];

    await service.start();

    expect(backend.calls).not.toContain('commit');
    expect(backend.calls).not.toContain('fetch');
  });

  it('never throws: a failing probe becomes an error status', async () => {
    const { backend, service } = harness({ autoFetchSeconds: 0 });
    backend.probe = () => Promise.reject(new WirebenchError('git-failed', 'git status failed.'));

    await expect(service.start()).resolves.toBeUndefined();
    expect(service.status()).toMatchObject({ state: 'error', error: { code: 'git-failed' } });
  });

  it('leaves changes uncommitted and asks for an identity when none is configured', async () => {
    const h = harness({ autoFetchSeconds: 0 });
    h.backend.current = status({ uncommitted: 1 });
    h.backend.changes = [requestChange];
    h.backend.identityValue = undefined;

    await expect(h.service.start()).resolves.toBeUndefined();
    expect(h.identityNeeded).toBe(1);
    expect(h.backend.calls).not.toContain('commit');
    expect(h.service.status().uncommitted).toBe(1);
  });

  it('reports an interrupted merge found on start through onConflict', async () => {
    const h = harness({ autoFetchSeconds: 0 });
    h.backend.current = status({ state: 'conflict', uncommitted: 1 });
    h.backend.conflictList = [{ path: 'environments/dev.yaml' }];

    await h.service.start();

    expect(h.conflicts).toEqual([[{ path: 'environments/dev.yaml' }]]);
    expect(h.backend.calls).not.toContain('commit');
  });
});

describe('SyncService — auto-fetch timer', () => {
  it('fetches every autoFetchSeconds, backs off to 300 s while offline, recovers, and stops', async () => {
    const { backend, service } = harness({ autoFetchSeconds: 60 });
    await service.start();
    const fetches = (): number => backend.calls.filter((call) => call === 'fetch').length;
    expect(fetches()).toBe(1);

    await vi.advanceTimersByTimeAsync(59_999);
    expect(fetches()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetches()).toBe(2);

    backend.fetchScript.push(() => Promise.reject(offline()));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetches()).toBe(3);
    expect(service.status().state).toBe('offline');

    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetches()).toBe(3);
    await vi.advanceTimersByTimeAsync(239_999);
    expect(fetches()).toBe(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetches()).toBe(4);
    expect(service.status().state).toBe('clean');

    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetches()).toBe(5);

    service.stop();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fetches()).toBe(5);
  });

  it('does not arm with autoFetchSeconds 0, and applySettings re-arms it', async () => {
    const h = harness({ autoFetchSeconds: 0 });
    await h.service.start();
    const fetches = (): number => h.backend.calls.filter((call) => call === 'fetch').length;
    expect(fetches()).toBe(1);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fetches()).toBe(1);

    h.settings = { ...h.settings, autoFetchSeconds: 30 };
    h.service.applySettings();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetches()).toBe(2);
    h.service.stop();
  });

  it('uses the injected timer functions', async () => {
    const setTimer = vi.fn(setTimeout) as unknown as typeof setTimeout;
    const clearTimer = vi.fn(clearTimeout) as unknown as typeof clearTimeout;
    const h = harness({ autoFetchSeconds: 60 }, { setTimer, clearTimer });
    await h.service.start();
    expect(setTimer).toHaveBeenCalledWith(expect.any(Function), 60_000);
    h.service.stop();
    expect(clearTimer).toHaveBeenCalled();
  });
});

describe('SyncService — afterSave', () => {
  it('coalesces saves within 500 ms into one commit, then one push', async () => {
    const { backend, service } = harness({ autoFetchSeconds: 0 });
    backend.changes = [requestChange];
    backend.current = status({ uncommitted: 1 });

    service.afterSave('manual');
    await vi.advanceTimersByTimeAsync(300);
    service.afterSave('manual');
    await vi.advanceTimersByTimeAsync(499);
    expect(backend.calls).not.toContain('commit');
    await vi.advanceTimersByTimeAsync(1);
    await service.log(1);

    expect(backend.calls.filter((call) => call === 'commit')).toHaveLength(1);
    expect(backend.calls.filter((call) => call === 'push')).toHaveLength(1);
    expect(backend.commits).toEqual([commitMessage([requestChange])]);
  });

  it('marks the commit as autosave only when every coalesced save was an autosave', async () => {
    const h = harness({ autoFetchSeconds: 0 });
    h.backend.changes = [requestChange];
    h.service.afterSave('autosave');
    h.service.afterSave('autosave');
    await vi.advanceTimersByTimeAsync(500);
    await h.service.log(1);
    expect(h.backend.commits).toEqual([commitMessage([requestChange], { autosave: true })]);

    h.backend.changes = [requestChange];
    h.service.afterSave('autosave');
    h.service.afterSave('workspace');
    await vi.advanceTimersByTimeAsync(500);
    await h.service.log(1);
    expect(h.backend.commits.at(-1)).toBe(commitMessage([requestChange]));
  });

  it('does not push without a remote, or when pushOnSave is off', async () => {
    const noRemote = harness({ autoFetchSeconds: 0 });
    noRemote.backend.current = status({ remote: undefined });
    noRemote.backend.changes = [requestChange];
    noRemote.service.afterSave('manual');
    await vi.advanceTimersByTimeAsync(500);
    await noRemote.service.log(1);
    expect(noRemote.backend.calls).toContain('commit');
    expect(noRemote.backend.calls).not.toContain('push');

    const noPush = harness({ autoFetchSeconds: 0, pushOnSave: false });
    noPush.backend.changes = [requestChange];
    noPush.service.afterSave('manual');
    await vi.advanceTimersByTimeAsync(500);
    await noPush.service.log(1);
    expect(noPush.backend.calls).toContain('commit');
    expect(noPush.backend.calls).not.toContain('push');
  });

  it('does nothing when commitOnSave is off', async () => {
    const { backend, service } = harness({ autoFetchSeconds: 0, commitOnSave: false });
    backend.changes = [requestChange];
    service.afterSave('manual');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(backend.calls).toEqual([]);
  });

  it('is cancelled by stop()', async () => {
    const { backend, service } = harness({ autoFetchSeconds: 0 });
    backend.changes = [requestChange];
    service.afterSave('manual');
    service.stop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(backend.calls).toEqual([]);
  });
});

describe('SyncService — errors during an open merge', () => {
  it('an offline fetch, manual or automatic, and any other failure keep an open merge in conflict', async () => {
    const h = harness({ autoFetchSeconds: 60 });
    h.backend.current = status({ state: 'conflict' });
    await h.service.start();
    expect(h.service.status().state).toBe('conflict');

    h.backend.fetchScript.push(() => Promise.reject(offline()));
    await rejectionOf(h.service.fetch());
    expect(h.service.status()).toMatchObject({ state: 'conflict', error: { code: 'git-offline' } });

    const fetchesBefore = h.backend.calls.filter((call) => call === 'fetch').length;
    h.backend.fetchScript.push(() => Promise.reject(offline()));
    await vi.advanceTimersByTimeAsync(300_000);
    await h.service.log(1);
    expect(h.backend.calls.filter((call) => call === 'fetch').length).toBeGreaterThan(fetchesBefore);
    expect(h.service.status().state).toBe('conflict');

    h.backend.fetchScript.push(() => Promise.reject(new WirebenchError('git-failed', 'git fetch failed.')));
    await rejectionOf(h.service.fetch());
    expect(h.service.status()).toMatchObject({ state: 'conflict', error: { code: 'git-failed' } });
    h.service.stop();
  });
});

describe('SyncService — commit and identity', () => {
  it('an explicit message wins over the generated one', async () => {
    const { backend, service } = harness({ autoFetchSeconds: 0 });
    backend.changes = [requestChange];
    await service.commit('Tidy the calculator');
    expect(backend.commits).toEqual(['Tidy the calculator']);
  });

  it('asks for an identity, throws git-identity-needed, and setIdentity retries the commit', async () => {
    const h = harness({ autoFetchSeconds: 0 });
    h.backend.changes = [requestChange];
    h.backend.identityValue = undefined;

    const error = await rejectionOf(h.service.commit());
    expect(isWirebenchError(error) && error.code).toBe('git-identity-needed');
    expect(h.identityNeeded).toBe(1);
    expect(h.backend.calls).not.toContain('commit');

    await h.service.setIdentity('Ada', 'ada@example.test');
    expect(h.backend.commits).toEqual([commitMessage([requestChange])]);
  });

  it('an afterSave commit blocked on identity also pushes once setIdentity retries it', async () => {
    const h = harness({ autoFetchSeconds: 0 });
    h.backend.changes = [requestChange];
    h.backend.identityValue = undefined;
    h.service.afterSave('manual');
    await vi.advanceTimersByTimeAsync(500);
    await h.service.log(1);
    expect(h.identityNeeded).toBe(1);
    expect(h.backend.calls).not.toContain('push');

    await h.service.setIdentity('Ada', 'ada@example.test');
    expect(h.backend.calls.filter((call) => call === 'commit')).toHaveLength(1);
    expect(h.backend.calls.filter((call) => call === 'push')).toHaveLength(1);
  });

  it('start() leaves the commit pending on a missing identity for setIdentity to retry', async () => {
    const h = harness({ autoFetchSeconds: 0 });
    h.backend.current = status({ uncommitted: 1 });
    h.backend.changes = [requestChange];
    h.backend.identityValue = undefined;
    await h.service.start();
    expect(h.identityNeeded).toBe(1);

    await h.service.setIdentity('Ada', 'ada@example.test');
    expect(h.backend.commits).toEqual([commitMessage([requestChange])]);
  });

  it('the first commit blocked on identity keeps its message through start() and asks once', async () => {
    const h = harness({ autoFetchSeconds: 0 });
    h.backend.current = status({ uncommitted: 1 });
    h.backend.changes = [requestChange];
    h.backend.identityValue = undefined;

    const error = await rejectionOf(h.service.commit('Share workspace Workspace 1'));
    expect(isWirebenchError(error) && error.code).toBe('git-identity-needed');
    await h.service.start();
    expect(h.identityNeeded).toBe(1);

    await h.service.setIdentity('Ada', 'ada@example.test');
    expect(h.backend.commits).toEqual(['Share workspace Workspace 1']);
  });
});

describe('SyncService — pull, push, conflicts', () => {
  it('pull merges and hands changed paths to onPulled before resolving', async () => {
    const h = harness({ autoFetchSeconds: 0 });
    h.backend.mergeResult = { conflicts: [], changedPaths: ['environments/dev.yaml'] };
    let appliedBeforeReturn = false;
    const pulled = h.service.pull().then(() => {
      appliedBeforeReturn = h.pulled.length === 1;
    });
    await pulled;
    expect(appliedBeforeReturn).toBe(true);
    expect(h.pulled).toEqual([['environments/dev.yaml']]);
    expect(h.backend.calls.slice(0, 2)).toEqual(['fetch', 'merge']);
  });

  it('pull without changes does not call onPulled', async () => {
    const h = harness({ autoFetchSeconds: 0 });
    await h.service.pull();
    expect(h.pulled).toEqual([]);
  });

  it('pull commits local changes first when commitOnSave is on', async () => {
    const h = harness({ autoFetchSeconds: 0 });
    h.backend.current = status({ uncommitted: 1 });
    h.backend.changes = [requestChange];
    await h.service.pull();
    expect(h.backend.calls.indexOf('commit')).toBeGreaterThan(h.backend.calls.indexOf('fetch'));
    expect(h.backend.calls.indexOf('merge')).toBeGreaterThan(h.backend.calls.indexOf('commit'));
  });

  it('pull throws sync-uncommitted on a dirty tree when commitOnSave is off', async () => {
    const h = harness({ autoFetchSeconds: 0, commitOnSave: false });
    h.backend.current = status({ uncommitted: 2 });
    const error = await rejectionOf(h.service.pull());
    expect(isWirebenchError(error) && error.code).toBe('sync-uncommitted');
    expect(h.backend.calls).not.toContain('merge');
  });

  it('pull with conflicts emits onConflict and stays in conflict', async () => {
    const h = harness({ autoFetchSeconds: 0 });
    const conflict = { path: 'environments/dev.yaml', entity: { kind: 'environment', name: 'dev' } };
    h.backend.mergeResult = { conflicts: [conflict], changedPaths: [] };

    const result = await h.service.pull();

    expect(result.state).toBe('conflict');
    expect(h.conflicts).toEqual([[conflict]]);
    expect(h.pulled).toEqual([]);
  });

  it('an afterSave during a conflict does not commit, and runs once the conflict is aborted', async () => {
    const h = harness({ autoFetchSeconds: 0 });
    h.backend.mergeResult = { conflicts: [{ path: 'environments/dev.yaml' }], changedPaths: [] };
    await h.service.pull();

    h.backend.changes = [requestChange];
    h.service.afterSave('manual');
    await vi.advanceTimersByTimeAsync(500);
    await h.service.log(1);
    expect(h.backend.calls).not.toContain('commit');

    h.backend.mergeResult = { conflicts: [], changedPaths: [] };
    await h.service.abortMerge();
    await vi.advanceTimersByTimeAsync(500);
    await h.service.log(1);
    expect(h.backend.calls).toContain('commit');
  });

  it('resolving the last conflict finishes the merge and emits onPulled with the merge’s changes', async () => {
    const h = harness({ autoFetchSeconds: 0 });
    h.backend.mergeResult = {
      conflicts: [{ path: 'environments/dev.yaml' }, { path: 'workspace.yaml' }],
      changedPaths: [],
    };
    await h.service.pull();

    h.backend.mergeChanged = ['environments/dev.yaml', 'projects/calc/wirebench.yaml'];
    const first = await h.service.resolve('environments/dev.yaml', 'theirs');
    expect(first.state).toBe('conflict');
    expect(h.backend.calls).not.toContain('finishMerge');
    expect(h.pulled).toEqual([]);

    const done = await h.service.resolve('workspace.yaml', 'mine');
    expect(h.backend.calls).toContain('finishMerge');
    expect(done.state).toBe('clean');
    expect(h.pulled).toEqual([['environments/dev.yaml', 'projects/calc/wirebench.yaml']]);
  });

  it('a save left uncommitted during the conflict does not reach onPulled when the merge finishes', async () => {
    const h = harness({ autoFetchSeconds: 0 });
    h.backend.mergeResult = { conflicts: [{ path: 'environments/dev.yaml' }], changedPaths: [] };
    await h.service.pull();

    const saved: TreeChange = { path: 'projects/calc/wirebench.yaml', status: 'modified' };
    h.backend.changes = [saved];
    h.service.afterSave('manual');
    await vi.advanceTimersByTimeAsync(500);
    await h.service.log(1);
    expect(h.backend.calls).not.toContain('commit');

    h.backend.mergeChanged = ['environments/dev.yaml'];
    await h.service.resolve('environments/dev.yaml', 'theirs');

    expect(h.pulled).toEqual([['environments/dev.yaml']]);
  });

  it('abortMerge aborts and re-probes', async () => {
    const h = harness({ autoFetchSeconds: 0 });
    h.backend.mergeResult = { conflicts: [{ path: 'environments/dev.yaml' }], changedPaths: [] };
    await h.service.pull();
    const result = await h.service.abortMerge();
    expect(result.state).toBe('clean');
    expect(h.backend.calls.slice(-2)).toEqual(['abortMerge', 'probe']);
  });

  it('a rejected push pulls, then pushes exactly once more', async () => {
    const h = harness({ autoFetchSeconds: 0 });
    h.backend.pushScript.push(() =>
      Promise.reject(
        new WirebenchError('git-failed', 'git push failed.', {
          details: { stderr: ' ! [rejected]        HEAD -> main (fetch first)' },
        }),
      ),
    );
    await h.service.push();
    const relevant = h.backend.calls.filter((call) => ['push', 'fetch', 'merge'].includes(call));
    expect(relevant).toEqual(['push', 'fetch', 'merge', 'push']);
  });

  it('a push failing for another reason is not retried', async () => {
    const h = harness({ autoFetchSeconds: 0 });
    h.backend.pushScript.push(() =>
      Promise.reject(new WirebenchError('git-failed', 'git push failed.', { details: { stderr: 'fatal: boom' } })),
    );
    await expect(h.service.push()).rejects.toThrow('git push failed.');
    expect(h.backend.calls.filter((call) => call === 'push')).toHaveLength(1);
    expect(h.backend.calls).not.toContain('merge');
  });

  it('conflicts() goes through the queue', async () => {
    const h = harness({ autoFetchSeconds: 0 });
    h.backend.conflictList = [{ path: 'workspace.yaml' }];
    await expect(h.service.conflicts()).resolves.toEqual([{ path: 'workspace.yaml' }]);
  });
});

/**
 * A stand-in for the open projects' secret scans: how many unreviewed findings there are, whether
 * a project has edits not yet written, and the change notification a Keep or Move sends.
 */
class FakeScans {
  findings = 0;
  unsaved = false;
  readonly listeners = new Set<() => void>();

  deps(): Partial<SyncServiceDeps> {
    return {
      scanFindings: () => this.findings,
      unsaved: () => this.unsaved,
      onScanChange: (listener) => {
        this.listeners.add(listener);
        return () => {
          this.listeners.delete(listener);
        };
      },
    };
  }

  change(): void {
    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}

describe('SyncService — commits held for secrets', () => {
  const commitsOf = (backend: ScriptedBackend): number => backend.calls.filter((call) => call === 'commit').length;

  it('holds a save commit while a finding exists: no commit, and the status says how many', async () => {
    const scans = new FakeScans();
    scans.findings = 2;
    const h = harness({ autoFetchSeconds: 0 }, scans.deps());
    h.backend.changes = [requestChange];
    h.backend.current = status({ uncommitted: 1 });

    h.service.afterSave('manual');
    await vi.advanceTimersByTimeAsync(500);
    await h.service.log(1);

    expect(commitsOf(h.backend)).toBe(0);
    expect(h.backend.calls).not.toContain('push');
    expect(h.service.status().held).toEqual({ findings: 2 });
    expect(h.statuses.at(-1)?.held).toEqual({ findings: 2 });
  });

  it('releases once the findings are kept or moved, and runs the held commit exactly once', async () => {
    const scans = new FakeScans();
    scans.findings = 1;
    const h = harness({ autoFetchSeconds: 0 }, scans.deps());
    h.backend.changes = [requestChange];
    h.backend.current = status({ uncommitted: 1 });
    h.service.afterSave('autosave');
    await vi.advanceTimersByTimeAsync(500);
    await h.service.log(1);
    expect(h.service.status().held).toEqual({ findings: 1 });

    scans.findings = 0;
    scans.change();
    scans.change();
    await h.service.log(1);

    expect(commitsOf(h.backend)).toBe(1);
    expect(h.backend.commits).toEqual([commitMessage([requestChange], { autosave: true })]);
    expect(h.backend.calls.filter((call) => call === 'push')).toHaveLength(1);
    expect(h.service.status().held).toBeUndefined();
    expect(h.statuses.at(-1)?.held).toBeUndefined();

    scans.change();
    await h.service.log(1);
    expect(commitsOf(h.backend)).toBe(1);
  });

  it('updates the count while some findings remain, without committing', async () => {
    const scans = new FakeScans();
    scans.findings = 3;
    const h = harness({ autoFetchSeconds: 0 }, scans.deps());
    h.backend.changes = [requestChange];
    h.service.afterSave('manual');
    await vi.advanceTimersByTimeAsync(500);
    await h.service.log(1);

    scans.findings = 1;
    scans.change();
    await h.service.log(1);

    expect(commitsOf(h.backend)).toBe(0);
    expect(h.service.status().held).toEqual({ findings: 1 });
  });

  it('a release while a project is unsaved waits for the save that writes the review, then commits once', async () => {
    const scans = new FakeScans();
    scans.findings = 1;
    const h = harness({ autoFetchSeconds: 0 }, scans.deps());
    h.backend.changes = [requestChange];
    h.service.afterSave('manual');
    await vi.advanceTimersByTimeAsync(500);
    await h.service.log(1);

    // A Move rewrote the model; the file on disk still holds the value until it is saved.
    scans.findings = 0;
    scans.unsaved = true;
    scans.change();
    await h.service.log(1);
    expect(commitsOf(h.backend)).toBe(0);
    expect(h.service.status().held).toBeUndefined();

    scans.unsaved = false;
    h.service.afterSave('manual');
    await vi.advanceTimersByTimeAsync(500);
    await h.service.log(1);
    expect(commitsOf(h.backend)).toBe(1);
  });

  it('repeated saves while held do not commit; a save that removes the finding releases it', async () => {
    const scans = new FakeScans();
    scans.findings = 1;
    const h = harness({ autoFetchSeconds: 0 }, scans.deps());
    h.backend.changes = [requestChange];
    for (let i = 0; i < 3; i += 1) {
      h.service.afterSave('manual');
      await vi.advanceTimersByTimeAsync(500);
      await h.service.log(1);
    }
    expect(commitsOf(h.backend)).toBe(0);
    expect(h.service.status().held).toEqual({ findings: 1 });

    // The value was edited out by hand and saved: no Keep or Move, only the save.
    scans.findings = 0;
    h.service.afterSave('manual');
    await vi.advanceTimersByTimeAsync(500);
    await h.service.log(1);
    expect(commitsOf(h.backend)).toBe(1);
    expect(h.service.status().held).toBeUndefined();
  });

  it('holds the startup catch-up commit too, and still fetches', async () => {
    const scans = new FakeScans();
    scans.findings = 1;
    const h = harness({ autoFetchSeconds: 0 }, scans.deps());
    h.backend.current = status({ uncommitted: 1 });
    h.backend.changes = [requestChange];

    await h.service.start();

    expect(commitsOf(h.backend)).toBe(0);
    expect(h.backend.calls).toContain('fetch');
    expect(h.service.status().held).toEqual({ findings: 1 });

    scans.findings = 0;
    scans.change();
    await h.service.log(1);
    expect(h.backend.commits).toEqual([commitMessage([requestChange])]);
  });

  it('does not hold when there is nothing to commit', async () => {
    const scans = new FakeScans();
    scans.findings = 1;
    const h = harness({ autoFetchSeconds: 0 }, scans.deps());
    h.service.afterSave('manual');
    await vi.advanceTimersByTimeAsync(500);
    await h.service.log(1);

    expect(h.service.status().held).toBeUndefined();
  });

  it('a manual commit while held commits with the findings, releases the hold and pushes as the held commit would', async () => {
    const scans = new FakeScans();
    scans.findings = 1;
    const h = harness({ autoFetchSeconds: 0 }, scans.deps());
    h.backend.changes = [requestChange];
    h.backend.current = status({ uncommitted: 1 });
    h.service.afterSave('manual');
    await vi.advanceTimersByTimeAsync(500);
    await h.service.log(1);

    const after = await h.service.commit();

    expect(commitsOf(h.backend)).toBe(1);
    expect(h.backend.calls).toContain('push');
    expect(after.held).toBeUndefined();
    expect(h.service.status().held).toBeUndefined();

    // The findings are still there; a later change to them has nothing held to release.
    scans.change();
    await h.service.log(1);
    expect(commitsOf(h.backend)).toBe(1);
  });

  it('a manual commit with nothing held neither pushes nor holds', async () => {
    const scans = new FakeScans();
    scans.findings = 1;
    const h = harness({ autoFetchSeconds: 0 }, scans.deps());
    h.backend.changes = [requestChange];

    await h.service.commit();

    expect(commitsOf(h.backend)).toBe(1);
    expect(h.backend.calls).not.toContain('push');
    expect(h.service.status().held).toBeUndefined();
  });

  it('keeps the hold across status refreshes (fetch, probe)', async () => {
    const scans = new FakeScans();
    scans.findings = 1;
    const h = harness({ autoFetchSeconds: 0 }, scans.deps());
    h.backend.changes = [requestChange];
    h.service.afterSave('manual');
    await vi.advanceTimersByTimeAsync(500);
    await h.service.log(1);

    await expect(h.service.fetch()).resolves.toMatchObject({ held: { findings: 1 } });
  });

  it('a pull while held refuses to commit the held changes, and neither merges nor releases the hold', async () => {
    const scans = new FakeScans();
    scans.findings = 1;
    const h = harness({ autoFetchSeconds: 0 }, scans.deps());
    h.backend.changes = [requestChange];
    h.backend.current = status({ uncommitted: 1 });

    const error = await rejectionOf(h.service.pull());

    expect(isWirebenchError(error) && error.code).toBe('sync-uncommitted');
    expect(isWirebenchError(error) && error.message).toBe(
      'Review the possible secrets in the Sync panel before pulling.',
    );
    expect(commitsOf(h.backend)).toBe(0);
    expect(h.backend.calls).not.toContain('merge');
    expect(h.service.status().held).toEqual({ findings: 1 });
  });

  it('a push rejected while held does not commit the held changes to pull', async () => {
    const scans = new FakeScans();
    scans.findings = 1;
    const h = harness({ autoFetchSeconds: 0 }, scans.deps());
    h.backend.changes = [requestChange];
    h.backend.current = status({ uncommitted: 1, ahead: 1 });
    h.backend.pushScript.push(() =>
      Promise.reject(
        new WirebenchError('git-failed', 'git push failed.', {
          details: { stderr: ' ! [rejected]        HEAD -> main (fetch first)' },
        }),
      ),
    );

    const error = await rejectionOf(h.service.push());

    expect(isWirebenchError(error) && error.code).toBe('sync-uncommitted');
    expect(commitsOf(h.backend)).toBe(0);
    expect(h.backend.calls.filter((call) => call === 'push')).toHaveLength(1);
    expect(h.backend.calls).not.toContain('merge');
  });

  it('setIdentity holds the automatic commit it retries while findings exist, then commits it on release', async () => {
    const scans = new FakeScans();
    const h = harness({ autoFetchSeconds: 0 }, scans.deps());
    h.backend.changes = [requestChange];
    h.backend.current = status({ uncommitted: 1 });
    h.backend.identityValue = undefined;
    h.service.afterSave('manual');
    await vi.advanceTimersByTimeAsync(500);
    await h.service.log(1);
    expect(h.identityNeeded).toBe(1);

    // A secret was pasted and saved while the identity dialog was open.
    scans.findings = 1;
    await h.service.setIdentity('Ada', 'ada@example.test');

    expect(commitsOf(h.backend)).toBe(0);
    expect(h.backend.calls).not.toContain('push');
    expect(h.service.status().held).toEqual({ findings: 1 });

    scans.findings = 0;
    scans.change();
    await h.service.log(1);
    expect(commitsOf(h.backend)).toBe(1);
    expect(h.backend.calls.filter((call) => call === 'push')).toHaveLength(1);
  });

  it('setIdentity still retries a manual commit with its own message while findings exist', async () => {
    const scans = new FakeScans();
    const h = harness({ autoFetchSeconds: 0 }, scans.deps());
    h.backend.changes = [requestChange];
    h.backend.identityValue = undefined;
    await rejectionOf(h.service.commit('Tidy the calculator'));

    scans.findings = 1;
    await h.service.setIdentity('Ada', 'ada@example.test');

    expect(h.backend.commits).toEqual(['Tidy the calculator']);
  });

  it('stop() unsubscribes from scan changes', async () => {
    const scans = new FakeScans();
    const h = harness({ autoFetchSeconds: 0 }, scans.deps());
    expect(scans.listeners.size).toBe(1);
    h.service.stop();
    expect(scans.listeners.size).toBe(0);
    await Promise.resolve();
  });
});
