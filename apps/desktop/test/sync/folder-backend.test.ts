// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { isWirebenchError } from '@wirebench/engine';
import { FolderBackend } from '../../src/main/sync/folder-backend.js';

describe('FolderBackend', () => {
  it('probes as an always-clean folder share', async () => {
    const backend = new FolderBackend();
    await expect(backend.probe()).resolves.toEqual({
      kind: 'folder',
      gitAvailable: false,
      state: 'clean',
      ahead: 0,
      behind: 0,
      uncommitted: 0,
    });
  });

  it('can stand in for another share kind, reporting that kind and an error', async () => {
    await expect(new FolderBackend({ statusKind: 'server' }).probe()).resolves.toMatchObject({
      kind: 'server',
      state: 'clean',
    });
    const standIn = new FolderBackend({ statusKind: 'git', error: { code: 'git-not-found', message: 'No git.' } });
    expect(standIn.kind).toBe('folder');
    await expect(standIn.probe()).resolves.toEqual({
      kind: 'git',
      gitAvailable: false,
      state: 'error',
      ahead: 0,
      behind: 0,
      uncommitted: 0,
      error: { code: 'git-not-found', message: 'No git.' },
    });
  });

  it('reports no history and no changes without support', async () => {
    const backend = new FolderBackend();
    await expect(backend.log(10)).resolves.toEqual([]);
    await expect(backend.changedPaths()).resolves.toEqual([]);
    expect(() => {
      const unsubscribe = backend.subscribeRemote(() => {});
      unsubscribe();
    }).not.toThrow();
  });

  it('rejects every other operation with sync-not-supported', async () => {
    const backend = new FolderBackend();
    const operations: Array<() => Promise<unknown>> = [
      () => backend.fetch(),
      () => backend.merge(),
      () => backend.commit('message'),
      () => backend.push(),
      () => backend.conflicts(),
      () => backend.resolve('path', 'mine'),
      () => backend.finishMerge(),
      () => backend.abortMerge(),
      () => backend.identity(),
      () => backend.setIdentity('name', 'email@example.com'),
    ];
    for (const operation of operations) {
      await expect(operation()).rejects.toSatisfy(
        (error: unknown) => isWirebenchError(error) && error.code === 'sync-not-supported',
      );
    }
  });
});
