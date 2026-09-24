import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { moveDir, renameWithRetry } from '../src/main/rename-dir.js';

function fsError(code: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(`${code}: operation not permitted, rename`);
  error.code = code;
  return error;
}

describe('renameWithRetry', () => {
  it('renames on the first attempt when nothing holds the directory', async () => {
    const rename = vi.fn().mockResolvedValue(undefined);

    await renameWithRetry('/a', '/b', { rename, delay: async () => {} });

    expect(rename).toHaveBeenCalledTimes(1);
    expect(rename).toHaveBeenCalledWith('/a', '/b');
  });

  it.each(['EPERM', 'EBUSY', 'EACCES'])('retries past a transient %s and succeeds', async (code) => {
    const rename = vi.fn().mockRejectedValueOnce(fsError(code)).mockResolvedValueOnce(undefined);
    const delay = vi.fn().mockResolvedValue(undefined);

    await renameWithRetry('/a', '/b', { rename, delay });

    expect(rename).toHaveBeenCalledTimes(2);
    expect(delay).toHaveBeenCalledTimes(1);
  });

  it('rethrows an error that retrying cannot fix, without waiting', async () => {
    const rename = vi.fn().mockRejectedValue(fsError('ENOENT'));
    const delay = vi.fn().mockResolvedValue(undefined);

    await expect(renameWithRetry('/a', '/b', { rename, delay })).rejects.toThrow('ENOENT');
    expect(rename).toHaveBeenCalledTimes(1);
    expect(delay).not.toHaveBeenCalled();
  });

  it('gives up and rethrows once the budget is spent', async () => {
    const rename = vi.fn().mockRejectedValue(fsError('EPERM'));
    const delay = vi.fn().mockResolvedValue(undefined);

    await expect(renameWithRetry('/a', '/b', { rename, delay, totalWaitMs: 30, retryDelayMs: 10 })).rejects.toThrow(
      'EPERM',
    );
    expect(rename).toHaveBeenCalledTimes(3);
  });

  it('waits for real between attempts when no delay is injected', async () => {
    const rename = vi.fn().mockRejectedValueOnce(fsError('EBUSY')).mockResolvedValueOnce(undefined);

    await renameWithRetry('/a', '/b', { rename, retryDelayMs: 1 });

    expect(rename).toHaveBeenCalledTimes(2);
  });
});

describe('moveDir', () => {
  it('renames when both paths are on one filesystem', async () => {
    const rename = vi.fn().mockResolvedValue(undefined);

    await moveDir('/a', '/b', { rename, delay: async () => {} });

    expect(rename).toHaveBeenCalledWith('/a', '/b');
  });

  it('copies and then removes the source across filesystems (EXDEV)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wirebench-move-'));
    try {
      const from = join(root, 'staging', 'definition');
      const to = join(root, 'project', 'definition');
      await mkdir(join(from, 'xsd'), { recursive: true });
      await writeFile(join(from, 'xsd', 'types.xsd'), '<schema/>', 'utf8');
      await mkdir(join(root, 'project'));
      const rename = vi.fn().mockRejectedValue(fsError('EXDEV'));

      await moveDir(from, to, { rename, delay: async () => {} });

      expect(rename).toHaveBeenCalledTimes(1);
      expect(await readFile(join(to, 'xsd', 'types.xsd'), 'utf8')).toBe('<schema/>');
      expect(existsSync(from)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rethrows any other rename failure without copying', async () => {
    const rename = vi.fn().mockRejectedValue(fsError('ENOTEMPTY'));

    await expect(moveDir('/nowhere/a', '/nowhere/b', { rename, delay: async () => {} })).rejects.toThrow('ENOTEMPTY');
  });
});
