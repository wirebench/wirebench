import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendHistory } from '@wirebench/engine';
import type { HistoryEntry } from '@wirebench/engine';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HistoryService, historyFilePath } from '../src/main/history-service.js';
import type { HistoryWatch } from '../src/main/history-service.js';

function fakeWatch(): { watch: HistoryWatch; fire: (file: string) => void; closed: string[] } {
  const listeners = new Map<string, () => void>();
  const closed: string[] = [];
  const watch: HistoryWatch = (file, onChange) => {
    listeners.set(file, onChange);
    return { close: () => closed.push(file) };
  };
  return { watch, fire: (file) => listeners.get(file)?.(), closed };
}

function externalEntry(id: string): HistoryEntry {
  return {
    id,
    kind: 'rest',
    at: '2026-09-29T10:00:00.000Z',
    projectId: 'proj-1',
    requestName: 'List pets',
    interfaceName: 'Pets',
    operationName: '',
    endpoint: 'http://127.0.0.1:9/pets',
    method: 'GET',
    soapVersion: 'none',
    status: 200,
    durationMs: 4,
    ok: true,
    request: { envelopeXml: '', headers: [] },
    sizeBytes: 2,
    tags: ['mcp'],
  };
}

describe('HistoryService watching its files', () => {
  let userDataDir: string;

  beforeEach(async () => {
    userDataDir = await mkdtemp(join(tmpdir(), 'wirebench-history-watch-'));
  });

  afterEach(async () => {
    await rm(userDataDir, { recursive: true, force: true });
  });

  it('reloads and notifies when another process appends', async () => {
    const fake = fakeWatch();
    const onChanged = vi.fn();
    const history = new HistoryService(userDataDir, undefined, { watch: fake.watch, onChanged });
    await history.open('proj-1');
    const file = historyFilePath(userDataDir, 'proj-1');

    await appendHistory(file, externalEntry('01K00000000000000000000001'));
    fake.fire(file);
    await history.whenReloaded();

    expect(onChanged).toHaveBeenCalledWith('proj-1');
    expect(history.list().entries.map((entry) => entry.id)).toEqual(['01K00000000000000000000001']);
  });

  it('does not notify for its own writes', async () => {
    const fake = fakeWatch();
    const onChanged = vi.fn();
    const history = new HistoryService(userDataDir, undefined, { watch: fake.watch, onChanged });
    await history.open('proj-1');

    await history.recordRestSend('proj-1', {
      requestId: 'req-1',
      requestName: 'List pets',
      apiName: 'Pets',
      folderPath: '',
      method: 'GET',
      url: 'http://127.0.0.1:9/pets',
      requestHeaders: {},
      requestBody: '',
      durationMs: 4,
      error: { code: 'http-connect-failed', message: 'connection refused' },
    });
    fake.fire(historyFilePath(userDataDir, 'proj-1'));
    await history.whenReloaded();

    expect(onChanged).not.toHaveBeenCalled();
  });

  it('stops watching a project when it closes', async () => {
    const fake = fakeWatch();
    const history = new HistoryService(userDataDir, undefined, { watch: fake.watch });
    await history.open('proj-1');
    await history.open('proj-2');

    history.close('proj-1');
    expect(fake.closed).toEqual([historyFilePath(userDataDir, 'proj-1')]);
    history.closeAll();
    expect(fake.closed).toEqual([historyFilePath(userDataDir, 'proj-1'), historyFilePath(userDataDir, 'proj-2')]);
  });
});
