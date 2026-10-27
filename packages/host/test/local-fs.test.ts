// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const watch = vi.hoisted(() => ({ readdirs: 0, lstatsInFlight: 0, maxLstatsInFlight: 0 }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readdir: (...args: Parameters<typeof actual.readdir>) => {
      watch.readdirs += 1;
      return actual.readdir(...args);
    },
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      watch.lstatsInFlight += 1;
      watch.maxLstatsInFlight = Math.max(watch.maxLstatsInFlight, watch.lstatsInFlight);
      try {
        return await actual.lstat(...args);
      } finally {
        watch.lstatsInFlight -= 1;
      }
    },
  };
});

const { localHome, localList, localMkdir, localRemove, localRename, localStat } = await import('../src/local-fs.js');

const temp = () => mkdtempSync(join(tmpdir(), 'wb-local-fs-'));

describe('local-fs', () => {
  it('lists hidden files too (hiding is the renderer’s job), with the resolved path', async () => {
    const dir = temp();
    writeFileSync(join(dir, '.env'), 'x');
    writeFileSync(join(dir, 'a.txt'), 'abc');
    mkdirSync(join(dir, 'sub'));
    const listed = await localList(join(dir, 'sub', '..'));
    expect(listed.path).toBe(dir);
    const byName = Object.fromEntries(listed.entries.map((e) => [e.name, e]));
    expect(Object.keys(byName).sort()).toEqual(['.env', 'a.txt', 'sub']);
    expect(byName['a.txt']).toMatchObject({ type: 'file', size: 3 });
    expect(byName['sub']).toMatchObject({ type: 'dir' });
    expect(byName['a.txt']).not.toHaveProperty('mode');
  });

  it('a symlink to a folder has targetType dir; a dangling one other', async () => {
    const dir = temp();
    mkdirSync(join(dir, 'real'));
    symlinkSync(join(dir, 'real'), join(dir, 'link'));
    symlinkSync(join(dir, 'nowhere'), join(dir, 'dangling'));
    const byName = Object.fromEntries((await localList(dir)).entries.map((e) => [e.name, e]));
    expect(byName['link']).toMatchObject({ type: 'symlink', targetType: 'dir' });
    expect(byName['dangling']).toMatchObject({ type: 'symlink', targetType: 'other' });
    expect(await localStat(join(dir, 'link'))).toMatchObject({ name: 'link', type: 'symlink', targetType: 'dir' });
  });

  it('rename onto an existing name is refused and both stay as they were', async () => {
    const dir = temp();
    writeFileSync(join(dir, 'a'), 'A');
    writeFileSync(join(dir, 'b'), 'B');
    await expect(localRename(join(dir, 'a'), join(dir, 'b'))).rejects.toMatchObject({
      code: 'sftp-exists',
      details: { path: join(dir, 'b') },
    });
    expect(readFileSync(join(dir, 'b'), 'utf8')).toBe('B');
    await localRename(join(dir, 'a'), join(dir, 'c'));
    expect(readFileSync(join(dir, 'c'), 'utf8')).toBe('A');
  });

  it('mkdir refuses an existing path', async () => {
    const dir = temp();
    await localMkdir(join(dir, 'new'));
    await expect(localMkdir(join(dir, 'new'))).rejects.toMatchObject({ code: 'sftp-exists' });
  });

  it('remove: a folder that is not empty needs recursive', async () => {
    const dir = temp();
    mkdirSync(join(dir, 'tree', 'deep'), { recursive: true });
    writeFileSync(join(dir, 'tree', 'deep', 'f'), 'x');
    await expect(localRemove(join(dir, 'tree'), { recursive: false })).rejects.toMatchObject({
      code: 'local-fs-failed',
      details: { errno: 'ENOTEMPTY' },
    });
    await localRemove(join(dir, 'tree'), { recursive: true });
    expect(existsSync(join(dir, 'tree'))).toBe(false);
    mkdirSync(join(dir, 'empty'));
    await localRemove(join(dir, 'empty'), { recursive: false });
    expect(existsSync(join(dir, 'empty'))).toBe(false);
  });

  it('remove of a symlink to a folder removes the link, never what it points at', async () => {
    const dir = temp();
    mkdirSync(join(dir, 'real'));
    writeFileSync(join(dir, 'real', 'keep'), 'x');
    symlinkSync(join(dir, 'real'), join(dir, 'link'));
    await localRemove(join(dir, 'link'), { recursive: true });
    expect(existsSync(join(dir, 'link'))).toBe(false);
    expect(existsSync(join(dir, 'real', 'keep'))).toBe(true);
  });

  it('a missing path is local-fs-failed with errno ENOENT and the path', async () => {
    const missing = join(temp(), 'missing');
    await expect(localList(missing)).rejects.toMatchObject({
      name: 'WirebenchError',
      code: 'local-fs-failed',
      details: { path: missing, errno: 'ENOENT' },
    });
    await expect(localRemove(missing, { recursive: true })).rejects.toMatchObject({
      code: 'local-fs-failed',
      details: { errno: 'ENOENT' },
    });
  });

  it('2 000 entries list through one readdir and a bounded number of lstats at once', async () => {
    const dir = temp();
    for (let i = 0; i < 2000; i += 1) writeFileSync(join(dir, `f${String(i)}`), '');
    watch.readdirs = 0;
    watch.maxLstatsInFlight = 0;
    const listed = await localList(dir);
    expect(listed.entries).toHaveLength(2000);
    expect(watch.readdirs).toBe(1);
    expect(watch.maxLstatsInFlight).toBeGreaterThan(1);
    expect(watch.maxLstatsInFlight).toBeLessThanOrEqual(32);
  });

  it('localHome is the home folder and its Downloads', () => {
    const { home, downloads } = localHome();
    expect(downloads).toBe(join(home, 'Downloads'));
  });
});
