import { describe, expect, it } from 'vitest';
import {
  crumbsOf,
  formatModified,
  formatModifiedShort,
  formatSize,
  joinPath,
  modeString,
  parentOf,
  resolveTyped,
  sortEntries,
  visibleEntries,
} from '../../src/renderer/features/ssh/files/format.js';
import type { SftpEntryWire } from '../../src/shared/sftp-wire.js';

const entry = (name: string, type: SftpEntryWire['type'], extra: Partial<SftpEntryWire> = {}): SftpEntryWire => ({
  name,
  type,
  size: 0,
  mtime: 0,
  mode: 0o644,
  ...extra,
});

describe('format', () => {
  it('draws permission bits as ls does', () => {
    expect(modeString(0o750)).toBe('rwxr-x---');
    expect(modeString(0o644)).toBe('rw-r--r--');
    expect(modeString(0o4755)).toBe('rwsr-xr-x');
    expect(modeString(0o1777)).toBe('rwxrwxrwt');
    expect(modeString(0o2640)).toBe('rw-r-S---');
  });

  it('sizes a byte count', () => {
    expect(formatSize(0)).toBe('0 B');
    expect(formatSize(1023)).toBe('1023 B');
    expect(formatSize(1024)).toBe('1.0 KB');
    expect(formatSize(12 * 1024 * 1024)).toBe('12 MB');
    expect(formatSize(1.5 * 1024 ** 3)).toBe('1.5 GB');
  });

  it('joins, parents and crumbs remote paths', () => {
    expect(joinPath('/var', 'log')).toBe('/var/log');
    expect(joinPath('/', 'etc')).toBe('/etc');
    expect(parentOf('/var/log/app')).toBe('/var/log');
    expect(parentOf('/var')).toBe('/');
    expect(parentOf('/')).toBe('/');
    expect(crumbsOf('/var/log/app')).toEqual([
      { label: '/', path: '/' },
      { label: 'var', path: '/var' },
      { label: 'log', path: '/var/log' },
      { label: 'app', path: '/var/log/app' },
    ]);
  });

  it('joins, parents and crumbs a Windows path of this machine with backslashes', () => {
    expect(joinPath('C:\\Users', 'me')).toBe('C:\\Users\\me');
    expect(joinPath('C:\\', 'Users')).toBe('C:\\Users');
    expect(parentOf('C:\\Users\\me')).toBe('C:\\Users');
    expect(parentOf('C:\\Users')).toBe('C:\\');
    expect(parentOf('C:\\')).toBe('C:\\');
    expect(crumbsOf('C:\\Users\\me')).toEqual([
      { label: 'C:', path: 'C:\\' },
      { label: 'Users', path: 'C:\\Users' },
      { label: 'me', path: 'C:\\Users\\me' },
    ]);
    expect(resolveTyped('D:\\data', 'C:\\Users\\me', 'C:\\')).toBe('D:\\data');
    expect(resolveTyped('~\\src', 'C:\\Users\\me', 'C:\\')).toBe('C:\\Users\\me\\src');
    expect(resolveTyped('tmp', 'C:\\Users\\me', 'C:\\Users')).toBe('C:\\Users\\tmp');
  });

  it('reads a typed path against home and the current folder', () => {
    expect(resolveTyped('~', '/home/me', '/etc')).toBe('/home/me');
    expect(resolveTyped('~/src', '/home/me', '/etc')).toBe('/home/me/src');
    expect(resolveTyped('/tmp ', '/home/me', '/etc')).toBe('/tmp');
    expect(resolveTyped('nginx', '/home/me', '/etc')).toBe('/etc/nginx');
    expect(resolveTyped('  ', '/home/me', '/etc')).toBe('/etc');
  });

  it('puts folders and links to folders first, then sorts by the column', () => {
    const entries = [
      entry('b.txt', 'file', { size: 5 }),
      entry('z-dir', 'dir'),
      entry('a.txt', 'file', { size: 50 }),
      entry('link', 'symlink', { targetType: 'dir' }),
      entry('file10', 'file', { size: 1 }),
      entry('file9', 'file', { size: 1 }),
    ];
    expect(sortEntries(entries, { column: 'name', descending: false }).map((e) => e.name)).toEqual([
      'link',
      'z-dir',
      'a.txt',
      'b.txt',
      'file9',
      'file10',
    ]);
    // Folders stay first when the order is reversed; ties reverse by name too.
    expect(sortEntries(entries, { column: 'size', descending: true }).map((e) => e.name)).toEqual([
      'z-dir',
      'link',
      'a.txt',
      'b.txt',
      'file10',
      'file9',
    ]);
  });

  it('hides names starting with a dot unless asked', () => {
    const entries = [entry('.env', 'file'), entry('app', 'dir')];
    const sort = { column: 'name', descending: false } as const;
    expect(visibleEntries(entries, false, sort).map((e) => e.name)).toEqual(['app']);
    expect(visibleEntries(entries, true, sort).map((e) => e.name)).toEqual(['app', '.env']);
  });
});

describe('formatModifiedShort', () => {
  const at = (y: number, m: number, d: number): number => new Date(y, m, d, 21, 21).getTime();
  it('is the time today, the day earlier this year and the date before it, so it fits the 7rem column (S66)', () => {
    const now = at(2026, 9, 16);
    const today = formatModifiedShort(at(2026, 9, 16), now);
    const thisYear = formatModifiedShort(at(2026, 9, 15), now);
    const lastYear = formatModifiedShort(at(2024, 9, 15), now);
    expect(today).toMatch(/21/);
    expect(today).not.toMatch(/2026|16/);
    expect(thisYear).not.toContain('2026');
    expect(thisYear).toMatch(/15/);
    expect(thisYear).not.toMatch(/21/);
    expect(lastYear).toContain('2024');
    for (const text of [today, thisYear, lastYear]) {
      expect(text.length).toBeLessThan(formatModified(at(2026, 9, 15)).length);
    }
  });
});
