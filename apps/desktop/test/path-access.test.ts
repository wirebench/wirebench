// @vitest-environment node
/**
 * Companion files: a picked file vouches for the exact names beside it, and for nothing else —
 * no symbolic link, nothing outside its folder.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The real `realpath`, wrapped so one test can make a folder vanish between the `lstat` and it.
const realpathSpy = vi.hoisted(() => ({ fail: false }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    realpath: (...args: Parameters<typeof actual.realpath>) => {
      if (realpathSpy.fail) {
        realpathSpy.fail = false;
        return Promise.reject(Object.assign(new Error('ENOENT: gone'), { code: 'ENOENT' }));
      }
      return actual.realpath(...args);
    },
  };
});
import { checkedCompanionPaths } from '../src/main/path-access.js';

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('checkedCompanionPaths', () => {
  const tmp = () => {
    const dir = mkdtempSync(join(tmpdir(), 'wirebench-companions-'));
    made.push(dir);
    return dir;
  };
  const write = (dir: string, name: string, text = '') => writeFileSync(join(dir, name), text);

  it('allows the named siblings of a picked file', async () => {
    const dir = tmp();
    write(dir, 'api.http');
    write(dir, 'http-client.env.json');
    const picks = { hasRead: (p: string) => p === join(dir, 'api.http') };
    expect(await checkedCompanionPaths([], picks, join(dir, 'api.http'), ['http-client.env.json'])).toEqual([
      join(dir, 'http-client.env.json'),
    ]);
  });

  it('allows the siblings of a file inside a project folder, with nothing picked', async () => {
    const dir = tmp();
    write(dir, 'api.http');
    write(dir, 'http-client.env.json');
    expect(await checkedCompanionPaths([dir], undefined, join(dir, 'api.http'), ['http-client.env.json'])).toEqual([
      join(dir, 'http-client.env.json'),
    ]);
  });

  it('refuses when the anchor file itself was not picked', async () => {
    const dir = tmp();
    write(dir, 'api.http');
    await expect(
      checkedCompanionPaths([], { hasRead: () => false }, join(dir, 'api.http'), ['x']),
    ).rejects.toMatchObject({ code: 'import-path-refused' });
  });

  it('refuses a path that leaves the folder, or a symbolic link', async () => {
    const dir = tmp();
    write(dir, 'api.http');
    symlinkSync(join(dir, 'api.http'), join(dir, 'link.json'));
    const picks = { hasRead: () => true };
    await expect(checkedCompanionPaths([], picks, join(dir, 'api.http'), ['../x'])).rejects.toMatchObject({
      code: 'import-path-refused',
    });
    await expect(checkedCompanionPaths([], picks, join(dir, 'api.http'), ['link.json'])).rejects.toMatchObject({
      code: 'import-path-refused',
    });
  });

  it('refuses an absolute name, and the folder itself', async () => {
    const dir = tmp();
    write(dir, 'api.http');
    const picks = { hasRead: () => true };
    await expect(
      checkedCompanionPaths([], picks, join(dir, 'api.http'), [join(tmp(), 'x.json')]),
    ).rejects.toMatchObject({ code: 'import-path-refused' });
    await expect(checkedCompanionPaths([], picks, join(dir, 'api.http'), ['.'])).rejects.toMatchObject({
      code: 'import-path-refused',
    });
  });

  it('refuses a name reached through a linked folder', async () => {
    const dir = tmp();
    const elsewhere = tmp();
    write(dir, 'api.http');
    write(elsewhere, 'secret.json', '{}');
    symlinkSync(elsewhere, join(dir, 'sub'));
    await expect(
      checkedCompanionPaths([], { hasRead: () => true }, join(dir, 'api.http'), ['sub/secret.json']),
    ).rejects.toMatchObject({ code: 'import-path-refused' });
  });

  it('drops a missing companion, and one that is a folder', async () => {
    const dir = tmp();
    write(dir, 'api.http');
    mkdirSync(join(dir, 'http-client.private.env.json'));
    expect(
      await checkedCompanionPaths([], { hasRead: () => true }, join(dir, 'api.http'), [
        'http-client.env.json',
        'http-client.private.env.json',
      ]),
    ).toEqual([]);
  });

  it('drops a companion whose folder vanishes mid-check, rather than letting the fs error escape', async () => {
    const dir = tmp();
    write(dir, 'api.http');
    write(dir, 'http-client.env.json');
    realpathSpy.fail = true;
    expect(
      await checkedCompanionPaths([], { hasRead: () => true }, join(dir, 'api.http'), ['http-client.env.json']),
    ).toEqual([]);
  });
});
