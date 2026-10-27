// @vitest-environment node
import { mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { asCaller } from './helpers/ipc-table.js';
import type { RemoteEntry, SftpSession } from '@wirebench/ssh';
import { describe, expect, it, vi } from 'vitest';
import { keepBothName, safeLocalName } from '../src/main/safe-name.js';
import { TransferQueue } from '../src/main/transfers.js';
import { events } from '@wirebench/wire/ipc';
import type { SftpTransferEvent } from '@wirebench/wire/sftp-wire';

const refused = (name: string): unknown => {
  try {
    safeLocalName(name);
  } catch (error) {
    return error;
  }
  return undefined;
};

describe('safeLocalName', () => {
  it('refuses a name that could leave the target folder or is not a name at all', () => {
    for (const name of ['../x', 'a/b', 'a\\b', '.', '..', '', 'a\0b']) {
      expect(refused(name)).toMatchObject({ code: 'sftp-failed', details: { reason: 'unsafe-name' } });
    }
  });

  it('keeps an ordinary name as it is', () => {
    for (const name of ['.hidden', 'a b', 'ünï', 'a..b']) expect(safeLocalName(name)).toBe(name);
  });
});

describe('keepBothName', () => {
  const takenOf =
    (...taken: string[]) =>
    (candidate: string) =>
      Promise.resolve(taken.includes(candidate));

  it('numbers the name before its extension', async () => {
    expect(await keepBothName('a.txt', takenOf())).toBe('a (1).txt');
    expect(await keepBothName('a.txt', takenOf('a (1).txt'))).toBe('a (2).txt');
  });

  it('keeps a double extension together and numbers a dot file at its end', async () => {
    expect(await keepBothName('archive.tar.gz', takenOf())).toBe('archive (1).tar.gz');
    expect(await keepBothName('.env', takenOf())).toBe('.env (1)');
    expect(await keepBothName('README', takenOf())).toBe('README (1)');
  });
});

describe('a download from a hostile server', () => {
  it('refuses a remote entry named ../evil and writes nothing outside the chosen folder', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-safe-'));
    const target = join(root, 'downloads');
    mkdirSync(target);
    const file = (name: string): RemoteEntry => ({ name, type: 'file', size: 4, mtime: 0, mode: 0o644 });
    const session = {
      id: 'r1',
      stat: (path: string) => Promise.resolve({ name: 'd', type: 'dir', size: 0, mtime: 0, mode: 0o755, path }),
      list: () => Promise.resolve([file('../evil'), file('ok.txt')]),
      readStream: () => Readable.from([Buffer.from('data')]),
    } as unknown as SftpSession;
    const emit = vi.fn();
    const queue = new TransferQueue({
      sftp: { session: () => session, onSessionClosed: () => () => undefined },
      emit,
    });
    const sender = asCaller({ id: 1, isDestroyed: () => false, once: vi.fn() });
    const { transferIds } = await queue.copy(sender, {
      batchId: 'b',
      from: { place: { kind: 'remote', sessionId: 'r1' }, paths: ['/d'] },
      to: { place: { kind: 'local' }, dir: target },
    });
    const last = (id: string) =>
      emit.mock.calls
        .filter(([, event]) => event === events.sftp.transfer)
        .map(([, , payload]) => payload as SftpTransferEvent)
        .filter((payload) => payload.transferId === id)
        .at(-1);
    await vi.waitFor(() => {
      expect(transferIds.map((id) => last(id)?.state)).toEqual(['failed', 'done']);
    });
    expect(last(transferIds[0] as string)?.error).toMatchObject({
      code: 'sftp-failed',
      details: { reason: 'unsafe-name' },
    });
    expect(readdirSync(root)).toEqual(['downloads']);
    expect(readdirSync(join(target, 'd'))).toEqual(['ok.txt']);
    expect(readFileSync(join(target, 'd', 'ok.txt'), 'utf8')).toBe('data');
  });
});
